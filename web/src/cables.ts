// Snap long trans-oceanic flows onto submarine cables so paths follow real
// physical routes. "Ferry" model: a long src→dst hop boards the cable whose two
// landing points best bridge the gap, crosses the ocean along that cable, then
// lands and continues overland. Endpoints needn't sit on a cable (most IPs are
// inland) — the cable carries the ocean leg and flows converge on real landings.
//
// Multi-cable relay (Dijkstra over a cable graph) and per-hop snapping of
// mtr-measured routes are future work.

import { haversineKm, densifyGreatCircle, densifyPath } from './geo';

type LngLat = [number, number];

let branches: LngLat[][] = [];
let ready = false;
const cache = new Map<string, LngLat[] | null>();

const SNAP_MIN_CHORD = 1800; // km — only ferry genuinely long hauls
const MIN_SPAN_FRAC = 0.35; // cable must span >= this fraction of the chord
const MAX_LAND_FRAC = 0.7; // combined overland legs must be < this * chord

// China's international traffic egresses via coastal cable landing stations
// (Shanghai is the primary one), not straight from inland. Trans-oceanic legs
// to/from inland China are routed through this gateway so they land at the
// coast and travel overland inland — instead of cutting across the sea to an
// interior site. Configurable per site.
const GATEWAY: LngLat = [121.47, 31.23]; // Shanghai
const GATEWAY_MIN_CHORD = 2500;

// Crude: mainland-China interior, away from the coastal gateway.
function isInlandCN(p: LngLat): boolean {
  return (
    p[0] > 95 && p[0] < 122 && p[1] > 24 && p[1] < 50 && haversineKm(p, GATEWAY) > 250
  );
}

// East-China coastal land corridor (NE → Shanghai). A straight NE-inland→Shanghai
// line sits at ~121°E and cuts straight down the Bohai Bay, Bohai Strait and
// Yellow Sea (open water). These coastal/inland waypoints bend the overland leg
// west around the seas so it follows land like real terrestrial fibre.
const CN_COAST_CORRIDOR: LngLat[] = [
  [119.6, 40.0], // Qinhuangdao — NW Bohai coast
  [117.2, 39.1], // Tianjin
  [117.0, 36.6], // Jinan — inland Shandong
  [119.0, 33.5], // inland Jiangsu
];
function inNeCoastal(p: LngLat): boolean {
  return p[0] >= 114 && p[0] <= 124 && p[1] >= 37 && p[1] <= 44;
}

// Overland leg inland → Shanghai gateway. NE-coastal origins route via the
// corridor waypoints south of the origin (no backtracking); elsewhere a plain
// great circle over land is fine.
function overlandToGateway(inland: LngLat): LngLat[] {
  const via = inNeCoastal(inland) ? CN_COAST_CORRIDOR.filter((w) => w[1] < inland[1]) : [];
  return densifyPath([inland, ...via, GATEWAY]);
}

// Trans-Pacific cables are split at the antimeridian (GeoJSON convention) into
// two LineStrings meeting at lon ±180. Re-join each pair (matched by latitude at
// the dateline) into one continuous cable so the ferry model crosses the whole
// ocean and lands on the far coast — instead of riding to mid-Pacific and then
// cutting straight to an inland endpoint (the "no landing port" bug).
function stitchAntimeridian(brs: LngLat[][]): LngLat[][] {
  const EPS = 179.5;
  const LAT_TOL = 2;
  type End = { bi: number; head: boolean; lat: number };
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
    if (p.head) a.reverse(); // dateline endpoint last
    const b = brs[best.bi].map((c) => [c[0] + 360, c[1]] as LngLat); // -180 → +180, continuous east
    if (!best.head) b.reverse(); // dateline endpoint (now ~180) first
    merged.push([...a, ...b.slice(1)]);
    consumed.add(p.bi);
    consumed.add(best.bi);
  }
  return brs.filter((_, i) => !consumed.has(i)).concat(merged);
}

export async function loadCables(): Promise<void> {
  if (ready) return;
  try {
    const gj = await (await fetch('/data/cables.geojson')).json();
    const raw: LngLat[][] = [];
    for (const f of gj.features ?? []) {
      const g = f.geometry;
      if (!g) continue;
      const groups = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
      for (const line of groups) {
        if (Array.isArray(line) && line.length >= 2) raw.push(line as LngLat[]);
      }
    }
    branches = stitchAntimeridian(raw);
    ready = true;
  } catch (e) {
    console.warn('cables load failed', e);
  }
}

// Cable-following path src→dst, or null to use a great circle.
export function snapPath(src: LngLat, dst: LngLat): LngLat[] | null {
  if (!ready) return null;
  const chord = haversineKm(src, dst);
  if (chord < SNAP_MIN_CHORD) return null;

  const key = `${src[0].toFixed(1)},${src[1].toFixed(1)}>${dst[0].toFixed(1)},${dst[1].toFixed(1)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let bestBi = -1;
  let bestReversed = false;
  let bestCost = Infinity;
  for (let bi = 0; bi < branches.length; bi++) {
    const br = branches[bi];
    const e0 = br[0];
    const e1 = br[br.length - 1];
    if (haversineKm(e0, e1) < chord * MIN_SPAN_FRAC) continue; // cable too short
    const costA = haversineKm(src, e0) + haversineKm(dst, e1);
    const costB = haversineKm(src, e1) + haversineKm(dst, e0);
    const cost = Math.min(costA, costB);
    if (cost < bestCost) {
      bestCost = cost;
      bestBi = bi;
      bestReversed = costB < costA;
    }
  }

  let result: LngLat[] | null = null;
  if (bestBi >= 0 && bestCost < chord * MAX_LAND_FRAC) {
    const slice = branches[bestBi].map((v) => [v[0], v[1]] as LngLat);
    if (bestReversed) slice.reverse();
    // Densify the whole chain along great circles with one global unwrap — coarse
    // cable chords would otherwise draw as flat horizontal / across-map streaks.
    result = densifyPath([src, ...slice, dst]);
  }
  cache.set(key, result);
  return result;
}

// Path for one link: gateway-routed when it's a trans-oceanic leg to/from
// inland China, else cable-snapped, else great circle.
export function segmentPath(a: LngLat, b: LngLat): { path: LngLat[]; snapped: boolean } {
  if (haversineKm(a, b) > GATEWAY_MIN_CHORD && isInlandCN(a) !== isInlandCN(b)) {
    const inlandFirst = isInlandCN(a);
    const inland = inlandFirst ? a : b;
    const oversea = inlandFirst ? b : a;
    const overland = overlandToGateway(inland);
    const ocean = snapPath(GATEWAY, oversea) ?? densifyGreatCircle(GATEWAY, oversea);
    let path = [...overland, ...ocean.slice(1)];
    if (!inlandFirst) path = path.reverse(); // orient a -> b
    return { path, snapped: true };
  }
  const snap = snapPath(a, b);
  return snap ? { path: snap, snapped: true } : { path: densifyGreatCircle(a, b), snapped: false };
}

export function flowPath(src: LngLat, dst: LngLat): { path: LngLat[]; snapped: boolean } {
  return segmentPath(src, dst);
}
