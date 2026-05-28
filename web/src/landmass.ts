// Real land/sea test from Natural-Earth country polygons (world.geojson), used to
// decide how a cross-border flow is drawn: a path whose great circle is mostly
// over LAND rides the terrestrial backbone (intra-Eurasia — Asia↔Europe overland,
// not around the Indian Ocean); a path mostly over OCEAN boards a submarine cable
// (Asia↔Americas). Data-driven — we sample the great circle and measure the land
// fraction — rather than a lon/lat continent guess.

type LngLat = [number, number];
type Poly = { xmin: number; xmax: number; ymin: number; ymax: number; ring: LngLat[]; group: string };

// Connected-landmass groups from Natural-Earth CONTINENT. Europe+Asia are ONE
// landmass (overland routable); the Americas / Africa / Oceania are separated by
// ocean from Eurasia and can only be reached by submarine cable — a geographic
// fact, not something a great-circle land-fraction can infer (an Americas↔Asia
// great circle skims the Arctic and reads as "land" though no cable-less route
// exists). So same group → maybe overland; different groups → always cable.
const GROUP: Record<string, string> = {
  Asia: 'EURASIA',
  Europe: 'EURASIA',
  'North America': 'AMERICAS',
  'South America': 'AMERICAS',
  Africa: 'AFRICA',
  Oceania: 'OCEANIA',
  Antarctica: 'ANTARCTICA',
};

let polys: Poly[] = [];
let ready = false;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function landmassReady(): boolean {
  return ready;
}

export async function loadLandmass(): Promise<void> {
  if (ready) return;
  try {
    const gj = await (await fetch('/data/world.geojson')).json();
    for (const f of gj.features ?? []) {
      const g = f.geometry;
      if (!g) continue;
      const group = GROUP[f.properties?.CONTINENT as string] ?? 'OTHER';
      const mp = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
      for (const poly of mp) {
        const ring = poly?.[0]; // outer ring; holes ignored (land/sea test only)
        if (!ring || ring.length < 4) continue;
        let xmin = 180,
          xmax = -180,
          ymin = 90,
          ymax = -90;
        for (const c of ring) {
          if (c[0] < xmin) xmin = c[0];
          if (c[0] > xmax) xmax = c[0];
          if (c[1] < ymin) ymin = c[1];
          if (c[1] > ymax) ymax = c[1];
        }
        polys.push({ xmin, xmax, ymin, ymax, ring: ring as LngLat[], group });
      }
    }
    ready = polys.length > 0;
  } catch (e) {
    console.warn('landmass load failed', e);
  }
}

// Ray-casting point-in-polygon on the outer ring.
function pip(x: number, y: number, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1],
      xj = ring[j][0],
      yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function onLand(p: LngLat): boolean {
  // Wrap into [-180,180]: great-circle sampling can carry longitudes past ±180.
  const x = ((p[0] + 180) % 360 + 360) % 360 - 180;
  const y = p[1];
  for (const pl of polys) {
    if (x < pl.xmin || x > pl.xmax || y < pl.ymin || y > pl.ymax) continue;
    if (pip(x, y, pl.ring)) return true;
  }
  return false;
}

// Connected-landmass group of the country containing p (EURASIA / AMERICAS / …),
// or null if p is over open ocean. Two points share a group iff a continuous
// land route between them exists — the real basis for "overland vs cable".
export function continentGroup(p: LngLat): string | null {
  const x = ((p[0] + 180) % 360 + 360) % 360 - 180;
  const y = p[1];
  for (const pl of polys) {
    if (x < pl.xmin || x > pl.xmax || y < pl.ymin || y > pl.ymax) continue;
    if (pip(x, y, pl.ring)) return pl.group;
  }
  return null;
}

// Fraction (0..1) of the great circle a→b lying over land. Sampled via slerp in
// XYZ (no antimeridian unwrap, so longitudes stay in [-180,180] for the test).
export function landFraction(a: LngLat, b: LngLat, steps = 40): number {
  const toXYZ = ([lon, lat]: LngLat): [number, number, number] => {
    const la = lat * D2R,
      lo = lon * D2R;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const pa = toXYZ(a);
  const pb = toXYZ(b);
  const dot = Math.max(-1, Math.min(1, pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2]));
  const om = Math.acos(dot);
  if (om < 1e-6) return onLand(a) ? 1 : 0;
  const sin = Math.sin(om);
  let n = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s1 = Math.sin((1 - t) * om) / sin;
    const s2 = Math.sin(t * om) / sin;
    const x = pa[0] * s1 + pb[0] * s2,
      y = pa[1] * s1 + pb[1] * s2,
      z = pa[2] * s1 + pb[2] * s2;
    const hyp = Math.hypot(x, y);
    if (onLand([Math.atan2(y, x) * R2D, Math.atan2(z, hyp) * R2D])) n++;
  }
  return n / (steps + 1);
}
