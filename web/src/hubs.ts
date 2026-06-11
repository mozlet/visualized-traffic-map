// Real internet-infrastructure anchors (cable landings + IXP/facility hubs) used
// to route flow paths through actual infrastructure instead of straight great
// circles. Built by `cargo run -p fetch-hubs` into /data/hubs[.local].geojson:
//   role=landing  — submarine-cable landing points (coastal entry/exit, global)
//   role=fac/ixp  — inland interconnect hubs (datacentres / exchanges)
// hubs.local.geojson (PeeringDB-enriched, operator-only) is preferred when present.

import { haversineKm } from './geo';
import { continentGroup, countryRings, landFraction, makeZone, zonesBlock, type Zone } from './landmass';
import { getTopology, loadTopology } from './topology';

type LngLat = [number, number];

let landings: LngLat[] = [];
let hubs: LngLat[] = []; // inland interconnect points
// Index of the first user-supplied "corridor" hub appended after the PeeringDB
// set. -1 = no corridor configured (default). When set, k-NN treats
// corridor↔corridor edges specially: it skips them so a forced chain (see
// corridorEdges in /data/topology.json) wins instead of any k-NN shortcut.
let corridorStart = -1;
let corridorEdges: [number, number][] = [];
// Configured backbone POPs (topology.json pops/trunks) participate in routing:
// they're appended as ordinary hubs (k-NN applies) and their trunk segments are
// hard-wired edges — the user-declared REAL national backbone.
let trunkEdges: [number, number][] = [];
let grid = new Map<string, LngLat[]>(); // 1° spatial index over `hubs`
let ready = false;

// Land backbone graph: every interconnect hub linked to its k nearest hubs ON THE
// SAME landmass. Overland routing is then Dijkstra over real hubs — a home in NE
// Asia threads via Korea/Japan for Tokyo, via the SE-Asia mainland for Singapore,
// via Siberia for Moscow — instead of a straight line over open sea. Same-continent
// restriction (real continent polygons) keeps it off the oceans; islands bridge
// to the mainland only at their nearest hub (a real narrow-strait crossing).
const LAND_K = 6;
let landAdj: { to: number; w: number }[][] = [];
let landBuilt = false;

const cell = (p: LngLat) => `${Math.floor(p[0])},${Math.floor(p[1])}`;

export function hubsReady(): boolean {
  return ready;
}

export async function loadHubs(): Promise<void> {
  if (ready) return;
  for (const url of ['/data/hubs.local.geojson', '/data/hubs.geojson']) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const gj = await r.json();
      for (const f of gj.features ?? []) {
        const c = f.geometry?.coordinates;
        if (!Array.isArray(c) || c.length < 2) continue;
        const p: LngLat = [c[0], c[1]];
        if (f.properties?.role === 'landing') landings.push(p);
        else hubs.push(p);
      }
      // Optional corridor: densify a stretch where the PeeringDB facility set
      // is too sparse to give Dijkstra real stepping-stones, so it would
      // otherwise chord across an intervening body of water. The user
      // configures these in /data/topology.json (corridorHubs +
      // corridorEdges). If absent the graph stays exactly the PeeringDB k-NN.
      await loadTopology();
      const topo = getTopology();
      if (topo.corridorHubs.length > 0) {
        corridorStart = hubs.length;
        corridorEdges = topo.corridorEdges;
        for (const p of topo.corridorHubs) hubs.push([p[0], p[1]]);
      }
      if (topo.pops.length > 0) {
        const popStart = hubs.length;
        const idx = new Map(topo.pops.map((p, i) => [p.name, popStart + i]));
        for (const p of topo.pops) hubs.push([p.position[0], p.position[1]]);
        trunkEdges = [];
        for (const [na, nb] of topo.trunks) {
          const ia = idx.get(na);
          const ib = idx.get(nb);
          if (ia != null && ib != null) trunkEdges.push([ia, ib]);
        }
      }
      for (const p of hubs) {
        const k = cell(p);
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
      }
      ready = landings.length > 0;
      if (ready) return;
    } catch {
      /* try next */
    }
  }
}

// Nearest cable landing to a point (coastal entry/exit), or null if none loaded.
export function nearestLanding(p: LngLat): LngLat | null {
  let best: LngLat | null = null;
  let bd = Infinity;
  for (const l of landings) {
    const d = haversineKm(l, p);
    if (d < bd) {
      bd = d;
      best = l;
    }
  }
  return best;
}

// Inland hubs within `pad`° of the bbox of a→b (longitudes UNWRAPPED relative to
// `refLon`, so legs crossing the ±180 antimeridian don't scan the whole globe).
function hubsNear(loMin: number, loMax: number, laMin: number, laMax: number): LngLat[] {
  const out: LngLat[] = [];
  for (let x = Math.floor(loMin); x <= Math.floor(loMax); x++) {
    const wrapped = (((x % 360) + 360) % 360); // 0..359
    const cl = Math.floor(wrapped >= 180 ? wrapped - 360 : wrapped); // back to [-180,180)
    for (let y = Math.floor(laMin); y <= Math.floor(laMax); y++) out.push(...(grid.get(`${cl},${y}`) ?? []));
  }
  return out;
}

const LEG_MIN_KM = 150; // shorter legs aren't worth bending
const PERP_MAX_KM = 160; // a hub must sit within this of the straight leg
const MAX_BENDS = 3;
const PAD = 2;

// Overland WAYPOINTS a→b ([a, ...hubs, b]) threading through real interconnect
// hubs sitting near the straight line, so a country's internal path follows its
// backbone cities, not a chord. The caller densifies. Returns [a, b] when the leg
// is short or no hubs are near (sparse data → graceful degrade to a straight leg).
// All longitude math is unwrapped relative to `a` so trans-antimeridian legs work.
export function inlandWaypoints(a: LngLat, b: LngLat): LngLat[] {
  if (!ready || haversineKm(a, b) < LEG_MIN_KM) return [a, b];
  const ref = a[0];
  const uw = (lon: number) => (lon - ref > 180 ? lon - 360 : lon - ref < -180 ? lon + 360 : lon);
  const bU = uw(b[0]);
  const mlat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const kx = Math.cos(mlat);
  const ax = ref * kx,
    ay = a[1],
    bx = bU * kx,
    by = b[1];
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  type Cand = { p: LngLat; t: number; perp: number };
  const cands: Cand[] = [];
  const near = hubsNear(Math.min(ref, bU) - PAD, Math.max(ref, bU) + PAD, Math.min(a[1], b[1]) - PAD, Math.max(a[1], b[1]) + PAD);
  for (const h of near) {
    const hx = uw(h[0]) * kx;
    const t = ((hx - ax) * dx + (h[1] - ay) * dy) / len2; // projection 0..1 along a→b
    if (t <= 0.06 || t >= 0.94) continue;
    const px = ax + t * dx,
      py = ay + t * dy;
    const perp = Math.hypot(hx - px, h[1] - py) * 111; // planar km (lon already kx-scaled)
    if (perp < PERP_MAX_KM) cands.push({ p: h, t, perp });
  }
  if (!cands.length) return [a, b];
  cands.sort((u, v) => u.t - v.t);
  // pick well-spaced, closest-to-line hubs (≤ MAX_BENDS), keeping a min t-gap
  const picked: Cand[] = [];
  let lastT = -1;
  for (const c of cands) {
    if (c.t - lastT < 0.9 / MAX_BENDS) {
      if (picked.length && c.perp < picked[picked.length - 1].perp) picked[picked.length - 1] = c;
      continue;
    }
    if (picked.length >= MAX_BENDS) break;
    picked.push(c);
    lastT = c.t;
  }
  return [a, ...picked.map((c) => c.p), b];
}

// Build the land backbone graph: k nearest same-continent neighbours per hub,
// then bridge disjoint pieces (islands → mainland) so every hub is reachable.
function buildLandGraph(): void {
  const N = hubs.length;
  landAdj = Array.from({ length: N }, () => []);
  const topo = getTopology();
  const corridorEnd = corridorStart < 0 ? -1 : corridorStart + topo.corridorHubs.length;
  const inCorridor = (i: number) => corridorStart >= 0 && i >= corridorStart && i < corridorEnd;
  // No-transit barriers: real country borders (Natural Earth, by name) plus
  // configured water-body polygons. No land edge may cross one — e.g. nothing
  // routes overland through North Korea, nothing chords across Bohai Bay.
  const zones: Zone[] = [
    ...countryRings(topo.noTransitCountries).map(makeZone),
    ...topo.noTransitZones.filter((r) => Array.isArray(r) && r.length >= 4).map((r) => makeZone(r as LngLat[])),
  ];
  const cellIdx = new Map<string, number[]>();
  const key = (lon: number, lat: number) => `${Math.floor(lon)},${Math.floor(lat)}`;
  for (let i = 0; i < N; i++) {
    const k = key(hubs[i][0], hubs[i][1]);
    (cellIdx.get(k) ?? cellIdx.set(k, []).get(k)!).push(i);
  }
  const grp = hubs.map((h) => continentGroup(h)); // real landmass per hub
  const seen = new Set<number>();
  const addUndir = (a: number, b: number) => {
    const w = haversineKm(hubs[a], hubs[b]);
    landAdj[a].push({ to: b, w });
    landAdj[b].push({ to: a, w });
  };
  for (let i = 0; i < N; i++) {
    // Expand the cell ring until we have enough candidates, then keep k nearest
    // on the same landmass (so the backbone never hops across an ocean).
    const cands: number[] = [];
    for (let r = 1; r <= 8 && cands.length < LAND_K * 4; r++) {
      cands.length = 0;
      const cx = Math.floor(hubs[i][0]);
      const cy = Math.floor(hubs[i][1]);
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const ids = cellIdx.get(`${cx + dx},${cy + dy}`);
          if (ids) for (const id of ids) if (id !== i) cands.push(id);
        }
      }
    }
    cands.sort((a, b) => haversineKm(hubs[i], hubs[a]) - haversineKm(hubs[i], hubs[b]));
    let added = 0;
    for (const j of cands) {
      if (added >= LAND_K) break;
      if (grp[i] != null && grp[j] != null && grp[i] !== grp[j]) continue; // no cross-ocean land hop
      // Corridor-bypass guard: when both endpoints are user-configured corridor
      // hubs, skip the k-NN edge — they're already chained via corridorEdges
      // below, and letting k-NN re-add a long-chord edge between two corridor
      // entries would let Dijkstra shortcut across whatever water/empty zone
      // the corridor was specifically configured to bridge.
      if (inCorridor(i) && inCorridor(j)) continue;
      // Real geography: even for mixed pairs, don't let k-NN add an inland
      // edge whose great-circle is mostly over open ocean. landFraction
      // catches segments straddling open sea between sub-continents.
      if (landFraction(hubs[i], hubs[j]) < 0.85) continue;
      // …and a no-transit barrier vetoes the edge outright; the fraction test
      // alone dilutes a short bay crossing inside a long edge.
      if (zonesBlock(hubs[i], hubs[j], zones)) continue;
      const e = i < j ? i * N + j : j * N + i;
      if (seen.has(e)) continue;
      seen.add(e);
      addUndir(i, j);
      added++;
    }
  }
  // Forced corridor edges from /data/topology.json. The k-NN above keeps
  // stealing corridor hubs' neighbour slots for closer dense-facility regions,
  // so the configured chain doesn't form naturally and Dijkstra could fall
  // back to a chord across whatever the corridor was meant to bridge. These
  // edges hard-wire the chain so the same Dijkstra finds a real overland path.
  if (corridorStart >= 0) {
    for (const [a, b] of corridorEdges) {
      const ia = corridorStart + a;
      const ib = corridorStart + b;
      if (ia < N && ib < N) addUndir(ia, ib);
    }
  }
  // Configured national-backbone trunks (topology.json pops/trunks): real
  // long-haul fibre segments, wired verbatim.
  for (const [ia, ib] of trunkEdges) if (ia < N && ib < N) addUndir(ia, ib);
  // Union-find: bridge separate pieces to the nearest hub in the main piece —
  // but ONLY where the two pieces are effectively contiguous at the dataset's
  // own resolution (a strait narrower than the node-cluster scale: Singapore↔
  // Johor, Tsugaru, Dover) — or where the piece has no submarine-cable landing
  // at all, so a land bridge is its only possible link. A piece WITH landings
  // (Korea, Japan, Britain…) reaches other landmasses the way real traffic
  // does: over the cable graph (segmentPath falls back to cableRoute when
  // landRoute reports no land connectivity). Bridges may not cross a
  // no-transit barrier either.
  const BRIDGE_CONTIGUITY_KM = 60;
  const parent = Array.from({ length: N }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let i = 0; i < N; i++) for (const e of landAdj[i]) parent[find(i)] = find(e.to);
  const comp = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    (comp.get(r) ?? comp.set(r, []).get(r)!).push(i);
  }
  const groups = [...comp.values()].sort((a, b) => b.length - a.length);
  const cableServed = (members: number[]): boolean => {
    for (const m of members) {
      for (const l of landings) if (haversineKm(hubs[m], l) <= BRIDGE_CONTIGUITY_KM) return true;
    }
    return false;
  };
  // Repeat until a fixpoint: a piece may only become mergeable after its real
  // neighbour merged first (Singapore joins via Johor, which joins via
  // Thailand), so a single ordered pass is order-dependent.
  const merged = new Uint8Array(groups.length);
  for (let changed = true; changed; ) {
    changed = false;
    for (let gi = 1; gi < groups.length; gi++) {
      if (merged[gi]) continue;
      let bestA = -1, bestB = -1, bestD = Infinity;
      for (const a of groups[gi]) {
        for (const b of groups[0]) {
          const d = haversineKm(hubs[a], hubs[b]);
          if (d < bestD && !zonesBlock(hubs[a], hubs[b], zones)) { bestD = d; bestA = a; bestB = b; }
        }
      }
      // Merge when: the gap is narrower than the dataset's own cluster scale
      // (Singapore↔Johor, Dover); or the joining edge is itself overland (a
      // data-sparsity split inside one real landmass, e.g. Europe↔Russia); or
      // the piece has no cable landing so a land bridge is its only link.
      if (
        bestA >= 0 &&
        (bestD <= BRIDGE_CONTIGUITY_KM ||
          landFraction(hubs[bestA], hubs[bestB]) >= 0.85 ||
          !cableServed(groups[gi]))
      ) {
        addUndir(bestA, bestB);
        parent[find(bestA)] = find(bestB);
        groups[0].push(...groups[gi]);
        merged[gi] = 1;
        changed = true;
      }
    }
  }
  compRoot = new Int32Array(N);
  for (let i = 0; i < N; i++) compRoot[i] = find(i);
  landBuilt = true;
}

let compRoot = new Int32Array(0);

// Connected land component containing p (id of the component's union-find
// root), or -1 before data load. Two points share a component iff landRoute
// can join them; cableRoute uses this to board cables only from the endpoint's
// OWN landmass piece (Seoul enters at a Korean landing, never via a straight
// access leg across the Yellow Sea to Shandong).
export function landComponentOf(p: LngLat): number {
  if (!ready || hubs.length === 0) return -1;
  if (!landBuilt) buildLandGraph();
  const i = nearestHub(p);
  return i < 0 ? -1 : compRoot[i];
}

// The built terrestrial backbone, for the joint land+cable graph in cables.ts.
export function landBackbone(): { hubs: LngLat[]; adj: { to: number; w: number }[][] } | null {
  if (!ready || hubs.length === 0) return null;
  if (!landBuilt) buildLandGraph();
  return { hubs, adj: landAdj };
}

function nearestHub(p: LngLat): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < hubs.length; i++) {
    const d = haversineKm(hubs[i], p);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Overland route a→b through the real hub backbone (Dijkstra), or null if hubs
// aren't loaded. Endpoints get a short access leg to their nearest hub.
export function landRoute(a: LngLat, b: LngLat): LngLat[] | null {
  if (!ready || hubs.length === 0) return null;
  if (!landBuilt) buildLandGraph();
  const ia = nearestHub(a);
  const ib = nearestHub(b);
  if (ia < 0 || ib < 0) return null;
  if (ia === ib) return [a, hubs[ia], b];
  const N = hubs.length;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  dist[ia] = 0;
  // Binary min-heap of [dist, node].
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
        const l = 2 * i + 1, r = 2 * i + 2;
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
    for (const e of landAdj[u]) {
      if (done[e.to]) continue;
      const nd = d + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = u;
        push(nd, e.to);
      }
    }
  }
  if (!isFinite(dist[ib])) return null;
  const chain: LngLat[] = [];
  for (let cur = ib; cur >= 0; cur = prev[cur]) chain.unshift(hubs[cur]);
  return [a, ...chain, b];
}
