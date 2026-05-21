// Real measured paths from /api/routes (mtr). Each route's geolocated hops are
// joined into a polyline; long inter-hop ocean segments reuse the cable snap so
// real paths also follow submarine cables.

import { segmentPath } from './cables';
import { densifyPath } from './geo';

type LngLat = [number, number];

interface RouteHop {
  idx: number;
  ip: string;
  lat: number | null;
  lon: number | null;
  country: string | null;
  rtt_ms: number | null;
}

export interface RoutePath {
  dst: string;
  points: LngLat[];
}

// dst IP -> real measured polyline, for flows to use as their path.
export const routeMap = new Map<string, LngLat[]>();

export async function fetchRoutes(): Promise<RoutePath[]> {
  let data: { routes?: { dst: string; hops: RouteHop[] }[] };
  try {
    data = await (await fetch('/api/routes?n=300')).json();
  } catch {
    return [];
  }
  const out: RoutePath[] = [];
  for (const route of data.routes ?? []) {
    const pts: LngLat[] = [];
    for (const h of route.hops ?? []) {
      if (h.lat == null || h.lon == null) continue;
      const p: LngLat = [h.lon, h.lat];
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
    if (pts.length < 2) continue;
    const full: LngLat[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const seg = segmentPath(pts[i - 1], pts[i]).path;
      full.push(...seg.slice(1));
    }
    // Per-hop segments are unwrapped independently; one final great-circle
    // densify + global unwrap stitches them continuously (no across-map seam).
    const fixed = densifyPath(full);
    out.push({ dst: route.dst, points: fixed });
    routeMap.set(route.dst, fixed);
  }
  return out;
}
