// Geographic helpers. The midpoint MUST be computed on the 3D unit sphere,
// never by averaging lat/lon — naive averaging lands on the wrong side of the
// antimeridian (e.g. trans-Pacific routes drift into Africa). This bug sank the
// predecessor project; keep all path math here.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export type LngLat = [number, number];

function toXYZ([lon, lat]: LngLat): [number, number, number] {
  const la = lat * D2R;
  const lo = lon * D2R;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

function toLngLat([x, y, z]: [number, number, number]): LngLat {
  const hyp = Math.hypot(x, y);
  return [Math.atan2(y, x) * R2D, Math.atan2(z, hyp) * R2D];
}

// 3D unit-sphere centroid of points — antimeridian-safe.
export function sphericalCentroid(points: LngLat[]): LngLat {
  let x = 0,
    y = 0,
    z = 0;
  for (const p of points) {
    const [px, py, pz] = toXYZ(p);
    x += px;
    y += py;
    z += pz;
  }
  const n = points.length || 1;
  return toLngLat([x / n, y / n, z / n]);
}

// Densify a great-circle path via spherical interpolation (slerp), then unwrap
// longitudes so the polyline stays continuous across the antimeridian (no
// horizontal seam in 2D). Sphere math keeps trans-Pacific routes correct.
export function densifyGreatCircle(a: LngLat, b: LngLat, steps = 24): LngLat[] {
  const pa = toXYZ(a);
  const pb = toXYZ(b);
  const dot = Math.max(-1, Math.min(1, pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2]));
  const omega = Math.acos(dot);
  const out: LngLat[] = [];
  if (omega < 1e-6) {
    return [a, b];
  }
  const sinO = Math.sin(omega);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s1 = Math.sin((1 - t) * omega) / sinO;
    const s2 = Math.sin(t * omega) / sinO;
    out.push(toLngLat([pa[0] * s1 + pb[0] * s2, pa[1] * s1 + pb[1] * s2, pa[2] * s1 + pb[2] * s2]));
  }
  // Unwrap longitudes to avoid the ±180 seam.
  for (let i = 1; i < out.length; i++) {
    let d = out[i][0] - out[i - 1][0];
    if (d > 180) out[i][0] -= 360;
    else if (d < -180) out[i][0] += 360;
  }
  return out;
}

// Densify a multi-point polyline along great circles. Every segment is slerped
// in XYZ and projected back into [-180,180]; a SINGLE global unwrap at the end
// keeps the line continuous. Doing the unwrap once (not per segment) avoids the
// ±360 segment-vs-segment disagreements that produce across-map seam streaks.
export function densifyPath(pts: LngLat[], stepKm = 250): LngLat[] {
  if (pts.length < 2) return pts.slice();
  const out: LngLat[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = toXYZ(pts[i - 1]);
    const b = toXYZ(pts[i]);
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const omega = Math.acos(dot);
    const n =
      omega < 1e-6 ? 1 : Math.max(1, Math.min(48, Math.round(haversineKm(pts[i - 1], pts[i]) / stepKm)));
    const sinO = Math.sin(omega);
    for (let s = i === 1 ? 0 : 1; s <= n; s++) {
      if (omega < 1e-6) {
        out.push([pts[i][0], pts[i][1]]);
        continue;
      }
      const t = s / n;
      const s1 = Math.sin((1 - t) * omega) / sinO;
      const s2 = Math.sin(t * omega) / sinO;
      out.push(toLngLat([a[0] * s1 + b[0] * s2, a[1] * s1 + b[1] * s2, a[2] * s1 + b[2] * s2]));
    }
  }
  for (let i = 1; i < out.length; i++) {
    const d = out[i][0] - out[i - 1][0];
    if (d > 180) out[i][0] -= 360;
    else if (d < -180) out[i][0] += 360;
  }
  return out;
}

// Great-circle distance in km.
export function haversineKm(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLon = (b[0] - a[0]) * D2R;
  const la1 = a[1] * D2R;
  const la2 = b[1] * D2R;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
