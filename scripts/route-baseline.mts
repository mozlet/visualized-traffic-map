// Route baseline/diff harness (read-only). Loads the REAL routing modules + REAL
// geojson and prints a deterministic per-line summary for the representative line
// set in CLAUDE.md, so a routing change can be diffed for regressions.
//   Run:  cd web && npx tsx ../scripts/route-baseline.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = resolve(ROOT, 'web/public');
globalThis.fetch = (async (url: string) => {
  const p = resolve(DATA, String(url).replace(/^\//, ''));
  try {
    const text = readFileSync(p, 'utf8');
    return { ok: true, json: async () => JSON.parse(text), text: async () => text } as Response;
  } catch {
    return { ok: false, json: async () => ({}), text: async () => '' } as Response;
  }
}) as typeof fetch;

const { loadCables, segmentPath } = await import(resolve(ROOT, 'web/src/cables.ts'));
const { loadHubs } = await import(resolve(ROOT, 'web/src/hubs.ts'));
const { loadLandmass } = await import(resolve(ROOT, 'web/src/landmass.ts'));
const { haversineKm } = await import(resolve(ROOT, 'web/src/geo.ts'));

await Promise.all([loadCables(), loadHubs(), loadLandmass()]);

type LngLat = [number, number];
const P: Record<string, LngLat> = {
  Home: [0, 0],
  LA: [-118.24, 34.05], SF: [-122.42, 37.77], Sacramento: [-121.49, 38.58],
  KansasCity: [-94.578, 39.10], NY: [-74.01, 40.71], Rio: [-43.20, -22.91],
  Sydney: [151.21, -33.87], CapeTown: [18.42, -33.93],
  Frankfurt: [8.68, 50.11], Dublin: [-6.26, 53.35], Moscow: [37.62, 55.75],
  Mumbai: [72.88, 19.08], Istanbul: [28.98, 41.01],
  Seoul: [126.98, 37.57], Tokyo: [139.69, 35.69], Singapore: [103.82, 1.35],
  Shanghai: [121.47, 31.23], Beijing: [116.41, 39.90],
  Fukuoka: [130.40, 33.59], Naha: [127.68, 26.21], Sapporo: [141.35, 43.06],
};

const norm = (x: number) => ((x + 540) % 360) - 180;

function row(an: string, bn: string) {
  const a = P[an]; const b = P[bn];
  const { path, snapped } = segmentPath(a, b);
  let maxHop = 0, minLat = 90, maxLat = -90, total = 0;
  for (let i = 0; i < path.length; i++) {
    minLat = Math.min(minLat, path[i][1]);
    maxLat = Math.max(maxLat, path[i][1]);
    if (i > 0) { const h = haversineKm(path[i - 1], path[i]); maxHop = Math.max(maxHop, h); total += h; }
  }
  const straight = haversineKm(a, b) || 1;
  const n = path.length;
  const samp: string[] = [];
  const step = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n; i += step) samp.push(`${norm(path[i][0]).toFixed(0)},${path[i][1].toFixed(0)}`);
  const lbl = `${an}->${bn}`.padEnd(24);
  console.log(`${lbl} snapped=${snapped ? 1 : 0} pts=${String(n).padStart(3)} maxHop=${String(Math.round(maxHop)).padStart(4)} len=${String(Math.round(total)).padStart(5)} det=${(total / straight).toFixed(2)} lat=[${minLat.toFixed(0)},${maxLat.toFixed(0)}] | ${samp.join(' ')}`);
}

console.log('# cross-ocean -> Home (must be cable, no Arctic)');
for (const c of ['LA', 'SF', 'Sacramento', 'KansasCity', 'NY', 'Rio', 'Sydney', 'CapeTown']) row(c, 'Home');
console.log('# intra-Eurasia land -> Home');
for (const c of ['Frankfurt', 'Dublin', 'Moscow', 'Mumbai', 'Istanbul']) row(c, 'Home');
console.log('# Eurasia short-sea -> Home');
for (const c of ['Seoul', 'Tokyo', 'Singapore']) row(c, 'Home');
console.log('# within China');
for (const c of ['Shanghai', 'Beijing']) row(c, 'Home');
console.log('# Japan inter-island (reported anomaly)');
row('Fukuoka', 'Sapporo'); row('Naha', 'Sapporo'); row('Fukuoka', 'Tokyo'); row('Naha', 'Tokyo');
