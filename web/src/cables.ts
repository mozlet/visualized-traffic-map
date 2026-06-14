// One link drawn along REAL infrastructure — two rules, no thresholds:
//  (1) same connected landmass + a real land bridge → terrestrial hub backbone
//  (2) otherwise → shortest path through the real submarine-cable network graph
// The cable network is built once from cables.geojson: cluster endpoints into
// landing nodes, each cable is an edge weighted by its real length. A flow that
// must cross water runs Dijkstra over this graph, so e.g. Rio→China naturally
// hops Atlantic→Europe→Asia (the only continuous cable path), not a single
// trans-Pacific straight cable. No distance penalties or special cases.

import { densifyGreatCircle, densifyPath, haversineKm } from './geo';
import { hubsReady, landBackbone, landRoute } from './hubs';
import { continentGroup, landmassReady } from './landmass';

type LngLat = [number, number];

// One segment of a cable polyline (already stitched across ±180 if applicable).
let branches: LngLat[][] = [];
// Cable graph: node = a landing (nearby cable endpoints clustered); edge = a
// real cable between two landings. A multi-segment cable system (e.g. AAG with
// 5 landings) interconnects ALL its landings — segments share the same physical
// cable in reality even when split into multiple MultiLineString members.
interface CableEdge {
  to: number;
  branchIdx: number; // segment whose polyline draws this edge; -1 = synthetic intra-system chord
  reversed: boolean;
  weight: number;
}
let nodeCoord: LngLat[] = [];
let graph: CableEdge[][] = [];
// Membership in the cable network's largest connected component. Isolated
// island cables (e.g. a stand-alone Bohai-Sea landing pair) cannot reach the
// global cable network, so they're excluded from landing selection — using one
// would route a flow to a dead-end.
let inMain: Uint8Array = new Uint8Array(0);
let ready = false;
const cache = new Map<string, { path: LngLat[]; snapped: boolean }>();

// Merge cable endpoints within this distance into one landing node — clusters
// Hong Kong, Shanghai, Marseille etc. so all cables sharing a landing are
// genuinely interconnected in the graph.
const CLUSTER_KM = 60;

function pathLengthKm(line: LngLat[]): number {
  let n = 0;
  for (let i = 1; i < line.length; i++) n += haversineKm(line[i - 1], line[i]);
  return n;
}

// A cable SEGMENT touching the high-Arctic transit band: the Arctic Ocean that
// real intercontinental traffic never crosses. These ARE real cables in the
// dataset (Polar Express trans-Siberian/Bering, Quintillion, Petropavlovsk-Anadyr,
// Svalbard, Alaska AKORN...) but they connect Arctic communities, not continents;
// leaving them in lets shortest-path Dijkstra teleport a flow over the pole
// instead of riding a real trans-Pacific / trans-Atlantic + overland route (the
// CLAUDE.md standard: Kansas/NY -> Home must be trans-Pacific, never Arctic).
// Legit submarine cables stay below 60N everywhere EXCEPT the North-Atlantic
// Nordic sector (Iceland/Greenland/Norway, lon -60..30, up to ~68N), so the rule
// keeps those and drops the rest. Purely geometric: no cable names, no penalty.
function arcticTransit(c: LngLat): boolean {
  const lon = ((c[0] + 540) % 360) - 180; // normalise stitched coords past ±180
  if (c[1] > 69) return true; // Svalbard, Polar Express Arctic apex, Quintillion
  return c[1] > 60 && !(lon >= -60 && lon <= 30); // Bering + Russian-Arctic coast + Alaska
}
function crossesArctic(seg: LngLat[]): boolean {
  for (const c of seg) if (arcticTransit(c)) return true;
  return false;
}

// Trans-oceanic cables are split at ±180 into two LineStrings in GeoJSON. Rejoin
// each pair (matched by dateline latitude) into one continuous polyline so the
// graph carries the whole ocean leg.
function stitchAntimeridian(brs: LngLat[][]): LngLat[][] {
  const EPS = 179.5;
  const LAT_TOL = 2;
  interface End { bi: number; head: boolean; lat: number }
  const pos: End[] = [];
  const neg: End[] = [];
  brs.forEach((br, bi) => {
    for (const head of [true, false]) {
      const c = head ? br[0] : br[br.length - 1];
      if (c[0] >= EPS) pos.push({ bi, head, lat: c[1] });
      else if (c[0] <= -EPS) neg.push({ bi, head, lat: c[1] });
    }
  });
  const consumed = new Set<number>();
  const merged: LngLat[][] = [];
  for (const p of pos) {
    if (consumed.has(p.bi)) continue;
    let best: End | null = null;
    let bd = LAT_TOL;
    for (const n of neg) {
      if (consumed.has(n.bi) || n.bi === p.bi) continue;
      const d = Math.abs(n.lat - p.lat);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    if (!best) continue;
    const a = brs[p.bi].map((c) => [c[0], c[1]] as LngLat);
    if (p.head) a.reverse();
    const b = brs[best.bi].map((c) => [c[0] + 360, c[1]] as LngLat);
    if (!best.head) b.reverse();
    merged.push([...a, ...b.slice(1)]);
    consumed.add(p.bi);
    consumed.add(best.bi);
  }
  return brs.filter((_, i) => !consumed.has(i)).concat(merged);
}

// Build the cable network graph from one cable system at a time. Each system's
// segments produce per-segment edges; additionally, ALL of a system's landings
// are interconnected (a multi-branch cable in reality serves any pair of its
// landings, even when GeoJSON splits the trunk into separate MultiLineString
// members). Inter-landing synthetic edges (branchIdx=-1) are drawn as a
// great-circle when reconstructing the route.
function buildCableGraph(systems: LngLat[][][]): void {
  nodeCoord = [];
  graph = [];
  branches = [];
  const grid = new Map<string, number[]>();
  const normLon = (x: number) => ((x + 540) % 360) - 180; // stitched coords can exceed +180
  const cellKey = (lon: number, lat: number) => `${Math.floor(normLon(lon))},${Math.floor(lat)}`;
  const findOrAdd = (p: LngLat): number => {
    const lon = normLon(p[0]);
    const cx = Math.floor(lon);
    const cy = Math.floor(p[1]);
    let best = -1;
    let bd = CLUSTER_KM;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const ids = grid.get(`${cx + dx},${cy + dy}`);
        if (!ids) continue;
        for (const id of ids) {
          const d = haversineKm(nodeCoord[id], [lon, p[1]]);
          if (d < bd) {
            bd = d;
            best = id;
          }
        }
      }
    }
    if (best >= 0) return best;
    const id = nodeCoord.length;
    nodeCoord.push([lon, p[1]]);
    graph.push([]);
    const k = cellKey(lon, p[1]);
    let arr = grid.get(k);
    if (!arr) {
      arr = [];
      grid.set(k, arr);
    }
    arr.push(id);
    return id;
  };
  const addEdge = (a: number, b: number, w: number, branchIdx: number) => {
    if (a === b || w <= 0) return;
    graph[a].push({ to: b, branchIdx, reversed: false, weight: w });
    graph[b].push({ to: a, branchIdx, reversed: true, weight: w });
  };
  // Union-find over this build, to detect which of a system's landings are
  // already connected through its real segments.
  const parent: number[] = [];
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const ensureNode = (id: number) => {
    while (parent.length <= id) parent.push(parent.length);
  };
  for (const segs of systems) {
    const landings: number[] = [];
    for (const seg of segs) {
      if (seg.length < 2) continue;
      if (crossesArctic(seg)) continue; // drop Arctic-Ocean crossings (Bering, Siberian coast)
      const ia = findOrAdd(seg[0]);
      const ib = findOrAdd(seg[seg.length - 1]);
      ensureNode(ia);
      ensureNode(ib);
      landings.push(ia, ib);
      const bi = branches.length;
      branches.push(seg);
      addEdge(ia, ib, pathLengthKm(seg), bi); // REAL cable segment, follows its polyline
      union(ia, ib);
    }
    // A cable system whose segments are split into disjoint branches (no shared
    // clustered landing) still physically connects them. Bridge ONLY across those
    // disjoint groups — nearest pair per still-separate group — instead of an
    // all-pairs clique. The clique let Dijkstra "teleport" cheaply between far
    // landings and produced trans-ocean zigzags; bridging only disconnected
    // groups keeps the real segment chain primary.
    const uniq = [...new Set(landings)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = uniq[i];
        const b = uniq[j];
        if (find(a) === find(b)) continue; // already connected via real segments
        addEdge(a, b, haversineKm(nodeCoord[a], nodeCoord[b]), -1);
        union(a, b);
      }
    }
  }
  // Largest connected component = the globally-routable cable network.
  inMain = new Uint8Array(nodeCoord.length);
  const compOf = new Int32Array(nodeCoord.length).fill(-1);
  const compSize: number[] = [];
  for (let s = 0; s < nodeCoord.length; s++) {
    if (compOf[s] >= 0) continue;
    const id = compSize.length;
    let n = 0;
    const stack = [s];
    while (stack.length) {
      const u = stack.pop()!;
      if (compOf[u] >= 0) continue;
      compOf[u] = id;
      n++;
      for (const e of graph[u]) if (compOf[e.to] < 0) stack.push(e.to);
    }
    compSize.push(n);
  }
  let main = 0;
  for (let i = 1; i < compSize.length; i++) if (compSize[i] > compSize[main]) main = i;
  // Bridge every smaller component into the main one via its single nearest
  // node-pair (real coastal cables physically connect these landings; the dataset
  // just files some as standalone systems). This lets a flow enter the cable
  // network at the GEOGRAPHICALLY nearest landing — a NE-Asian home boards near the
  // local Bohai/Yellow-Sea landings and reaches Korea/Japan directly, instead of
  // being forced ~560 km south to the next regional hub and detouring south.
  for (let comp = 0; comp < compSize.length; comp++) {
    if (comp === main) continue;
    const members: number[] = [];
    for (let i = 0; i < nodeCoord.length; i++) if (compOf[i] === comp) members.push(i);
    let bestA = -1;
    let bestB = -1;
    let bestD = Infinity;
    for (const m of members) {
      for (let i = 0; i < nodeCoord.length; i++) {
        if (compOf[i] !== main) continue;
        const d = haversineKm(nodeCoord[m], nodeCoord[i]);
        if (d < bestD) {
          bestD = d;
          bestA = m;
          bestB = i;
        }
      }
    }
    if (bestA >= 0) {
      addEdge(bestA, bestB, bestD, -1);
      compOf[comp] = main; // fold this component's id into main for subsequent checks
      for (const m of members) compOf[m] = main;
    }
  }
  for (let i = 0; i < nodeCoord.length; i++) inMain[i] = 1; // all nodes now reachable
}

export async function loadCables(): Promise<void> {
  if (ready) return;
  try {
    const gj = await (await fetch('/data/cables.geojson')).json();
    // Group every cable's segments together: each GeoJSON feature is one cable
    // system (id/slug) whose MultiLineString members are its segments.
    const systems: LngLat[][][] = [];
    for (const f of gj.features ?? []) {
      const g = f.geometry;
      if (!g) continue;
      const lines = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
      const segs: LngLat[][] = [];
      for (const line of lines) {
        if (Array.isArray(line) && line.length >= 2) segs.push(line as LngLat[]);
      }
      if (segs.length) systems.push(stitchAntimeridian(segs));
    }
    buildCableGraph(systems);
    ready = true;
  } catch (e) {
    console.warn('cables load failed', e);
  }
}

// Closest globally-routable cable-graph node to p. Restricted to the main
// connected component so we don't dead-end on an isolated island cable.
function nearestNode(p: LngLat): number {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < nodeCoord.length; i++) {
    if (!inMain[i]) continue;
    const d = haversineKm(nodeCoord[i], p);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// Within this distance, both endpoints can pick any landing as their entry/exit
// (not just the geographically nearest). Dijkstra then factors the access-leg
// distance into the routing decision, so e.g. San Diego (which has only south-
// Pacific cables landing on its doorstep) can still route via Hermosa Beach
// /Manhattan Beach ~200 km north, paying a 200 km land hop to reach a trans-
// Pacific cable instead of riding a 15,000 km detour via Australia. 800 km
// covers Phoenix → LA / Las Vegas → LA / Denver → SF, which are the realistic
// "you reach a major cable hub overland and step onto Trans-Pacific" cases.
const ENDPOINT_SNAP_KM = 800;

// Shortest path through the real submarine cable network from a to b. Returns
// the concatenated cable polyline (entry landing first, exit landing last), or
// null when the cable graph doesn't connect them.
function cableRoute(a: LngLat, b: LngLat): LngLat[] | null {
  if (nodeCoord.length === 0) return null;
  const V = nodeCoord.length;
  const dist = new Float64Array(V);
  for (let i = 0; i < V; i++) dist[i] = Infinity;
  const prevFrom = new Int32Array(V);
  const prevBranch = new Int32Array(V);
  const prevRev = new Uint8Array(V);
  for (let i = 0; i < V; i++) prevFrom[i] = -1;
  const visited = new Uint8Array(V);

  // Seed every routable landing within ENDPOINT_SNAP_KM of `a` with its own
  // access-leg cost. Dijkstra then proceeds as a multi-source search: the path
  // it ultimately picks is the one whose (a-access + cable + b-access) total
  // is minimal.
  let seeded = 0;
  for (let i = 0; i < V; i++) {
    if (!inMain[i]) continue;
    const d = haversineKm(nodeCoord[i], a);
    if (d <= ENDPOINT_SNAP_KM) {
      dist[i] = d;
      seeded++;
    }
  }
  if (seeded === 0) {
    const ia = nearestNode(a);
    if (ia < 0) return null;
    dist[ia] = haversineKm(nodeCoord[ia], a);
  }

  // Naive O(V^2) Dijkstra — node count is small (~1.4k) and results are cached.
  // We run it to completion (no early stop on a single `ib`) since we don't
  // know the best b-side landing until all candidates have been relaxed.
  for (;;) {
    let u = -1;
    let ud = Infinity;
    for (let i = 0; i < V; i++) {
      if (!visited[i] && dist[i] < ud) {
        ud = dist[i];
        u = i;
      }
    }
    if (u < 0) break;
    visited[u] = 1;
    for (const e of graph[u]) {
      if (visited[e.to]) continue;
      const nd = dist[u] + e.weight;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prevFrom[e.to] = u;
        prevBranch[e.to] = e.branchIdx;
        prevRev[e.to] = e.reversed ? 1 : 0;
      }
    }
  }

  // Choose the b-side landing that minimises (cable dist + access leg to b).
  let bestEnd = -1;
  let bestEndCost = Infinity;
  for (let i = 0; i < V; i++) {
    if (!inMain[i]) continue;
    if (!isFinite(dist[i])) continue;
    const d = haversineKm(nodeCoord[i], b);
    if (d > ENDPOINT_SNAP_KM) continue;
    const total = dist[i] + d;
    if (total < bestEndCost) {
      bestEndCost = total;
      bestEnd = i;
    }
  }
  // Fallback: nothing within snap radius (genuinely remote island) — fall back
  // to the nearest cable node and let the access leg be whatever it is.
  if (bestEnd < 0) {
    const ib = nearestNode(b);
    if (ib < 0 || !isFinite(dist[ib])) return null;
    bestEnd = ib;
  }

  // Reconstruct: walk from bestEnd backward, stopping at the seeded a-side
  // node (prevFrom[u] === -1 only for seeds with finite dist).
  const segs: LngLat[][] = [];
  let cur = bestEnd;
  while (prevFrom[cur] >= 0) {
    const bi = prevBranch[cur];
    const from = prevFrom[cur];
    let seg: LngLat[];
    if (bi >= 0) {
      seg = branches[bi].map((c) => [c[0], c[1]] as LngLat);
      if (prevRev[cur]) seg.reverse();
    } else {
      // Synthetic inter-landing edge within one cable system: no segment
      // polyline available, fall back to a great-circle between the landings.
      seg = densifyGreatCircle(nodeCoord[from], nodeCoord[cur]);
    }
    segs.unshift(seg);
    cur = from;
  }
  // Empty path = a and b snap to the same landing.
  if (segs.length === 0) return [nodeCoord[cur]];
  const out: LngLat[] = [];
  for (const s of segs) {
    if (out.length === 0) out.push(...s);
    else out.push(...s.slice(1));
  }
  return out;
}

// ——— Joint land+cable graph ———
// Real traffic that must cross water is land + cable + land: it rides the
// terrestrial backbone to a landing station, crosses on submarine cables, and
// rides the destination backbone inland. The joint graph is the union of the
// hub backbone (hubs.ts) and the cable graph, plus one backhaul link per cable
// node to its nearest hub (a landing station's tie into the local network).
// One Dijkstra over it decides WHERE to land and HOW far to ride overland —
// cost and geometry are the same real kilometres, no thresholds or special
// cases.
interface JointEdge {
  to: number;
  w: number;
  branchIdx: number; // >=0: draw this cable polyline; -1: straight hop between node coords
  reversed: boolean;
}
let jointAdj: JointEdge[][] | null = null;
let jointCoord: LngLat[] = [];
let hubCount = 0;

function buildJointGraph(): boolean {
  if (jointAdj) return true;
  const lb = landBackbone();
  if (!lb || nodeCoord.length === 0) return false;
  hubCount = lb.hubs.length;
  jointCoord = [...lb.hubs, ...nodeCoord];
  jointAdj = Array.from({ length: hubCount + nodeCoord.length }, () => []);
  for (let i = 0; i < hubCount; i++) {
    for (const e of lb.adj[i]) jointAdj[i].push({ to: e.to, w: e.w, branchIdx: -1, reversed: false });
  }
  for (let j = 0; j < nodeCoord.length; j++) {
    for (const e of graph[j]) {
      jointAdj[hubCount + j].push({ to: hubCount + e.to, w: e.weight, branchIdx: e.branchIdx, reversed: e.reversed });
    }
    // Backhaul: the landing station's tie into the terrestrial backbone.
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < hubCount; i++) {
      const d = haversineKm(lb.hubs[i], nodeCoord[j]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      jointAdj[hubCount + j].push({ to: best, w: bd, branchIdx: -1, reversed: false });
      jointAdj[best].push({ to: hubCount + j, w: bd, branchIdx: -1, reversed: false });
    }
  }
  return true;
}

// Shortest land+cable path a→b over the joint graph (entered/left at each
// endpoint's nearest hub), or null when the graph isn't available/connected.
function jointRoute(a: LngLat, b: LngLat): LngLat[] | null {
  if (!buildJointGraph() || !jointAdj) return null;
  const N = jointCoord.length;
  let ia = -1;
  let ib = -1;
  let da = Infinity;
  let db = Infinity;
  for (let i = 0; i < N; i++) {
    const dA = haversineKm(jointCoord[i], a);
    if (dA < da) {
      da = dA;
      ia = i;
    }
    const dB = haversineKm(jointCoord[i], b);
    if (dB < db) {
      db = dB;
      ib = i;
    }
  }
  if (ia < 0 || ib < 0) return null;
  const dist = new Float64Array(N).fill(Infinity);
  const prevFrom = new Int32Array(N).fill(-1);
  const prevBranch = new Int32Array(N);
  const prevRev = new Uint8Array(N);
  const done = new Uint8Array(N);
  dist[ia] = 0;
  const heap: number[][] = [[0, ia]];
  const push = (d: number, n: number) => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): number[] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = 2 * i + 2;
        let s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === ib) break;
    for (const e of jointAdj[u]) {
      if (done[e.to]) continue;
      const nd = d + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prevFrom[e.to] = u;
        prevBranch[e.to] = e.branchIdx;
        prevRev[e.to] = e.reversed ? 1 : 0;
        push(nd, e.to);
      }
    }
  }
  if (!isFinite(dist[ib])) return null;
  // Walk ib→ia backwards; cable edges contribute their real polyline, land and
  // backhaul edges a straight hop between the two node coordinates.
  const out: LngLat[] = [jointCoord[ib]];
  for (let cur = ib; prevFrom[cur] >= 0; cur = prevFrom[cur]) {
    const from = prevFrom[cur];
    if (prevBranch[cur] >= 0) {
      const seg = branches[prevBranch[cur]].map((c) => [c[0], c[1]] as LngLat);
      if (prevRev[cur]) seg.reverse();
      out.unshift(...seg.slice(0, -1)); // seg ends at `cur`, already in out
    } else {
      out.unshift(jointCoord[from]);
    }
  }
  return [a, ...out, b];
}

// One link's path. The two rules above decide land vs cable; both use REAL data
// (continent polygons, cable graph, hub graph). The legacy aForeign/bForeign
// args are ignored — the decision is fully data-driven now.
export function segmentPath(
  a: LngLat,
  b: LngLat,
  _aForeign = false,
  _bForeign = false,
): { path: LngLat[]; snapped: boolean } {
  const key = `${a[0].toFixed(1)},${a[1].toFixed(1)}>${b[0].toFixed(1)},${b[1].toFixed(1)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // Data still loading: return a PROVISIONAL straight line but do NOT cache it,
  // so the path is recomputed correctly once the real datasets are in.
  if (!ready || !hubsReady() || !landmassReady()) {
    return { path: densifyGreatCircle(a, b), snapped: false };
  }

  // Water crossing → one shortest path over the joint land+cable graph: ride
  // the terrestrial backbone to a landing station, cross on real cables, ride
  // the destination backbone inland. Falls back to the pure cable graph, then
  // to a straight line, if the joint graph is unavailable.
  const viaCable = (): { path: LngLat[]; snapped: boolean } => {
    const jr = jointRoute(a, b);
    if (jr && jr.length >= 3) return { path: densifyPath(jr), snapped: true };
    const route = cableRoute(a, b);
    if (route && route.length >= 2) return { path: densifyPath([a, ...route, b]), snapped: true };
    // The cable dataset doesn't connect these two — last-resort straight line.
    return { path: densifyGreatCircle(a, b), snapped: false };
  };

  const gA = continentGroup(a);
  const gB = continentGroup(b);
  const sameLandmass = gA != null && gB != null && gA === gB;
  let result: { path: LngLat[]; snapped: boolean };
  if (sameLandmass) {
    // Same landmass → overland through the real hub backbone (Dijkstra),
    // crossing water only at the real narrow straits the hub graph bridges.
    // When the hub graph says there IS no land connectivity (Korea↔China — no
    // transit through North Korea; an island with its own cable landings), the
    // link rides the real cable network instead, exactly like real traffic.
    const lr = landRoute(a, b);
    result = lr ? { path: densifyPath(lr), snapped: false } : viaCable();
  } else {
    // Different landmass → always the real submarine cable network.
    result = viaCable();
  }
  cache.set(key, result);
  return result;
}

export function flowPath(
  src: LngLat,
  dst: LngLat,
  srcForeign = false,
  dstForeign = false,
): { path: LngLat[]; snapped: boolean } {
  return segmentPath(src, dst, srcForeign, dstForeign);
}
