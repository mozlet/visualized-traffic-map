// Route baseline tracer (CLAUDE.md mandated): mock fetch over deployed data,
// import the REAL routing modules, dump per-route metrics + path samples.
// Run:  npx tsx tools/route-trace.ts > /tmp/route-baseline.txt
import { readFile } from 'node:fs/promises';

const DATA = process.env.DATA_DIR ?? '/opt/opn-flowmap/web/data';
(globalThis as any).fetch = async (url: string) => {
  const f = `${DATA}/${url.replace(/^\/data\//, '')}`;
  try {
    const buf = await readFile(f, 'utf8');
    return { ok: true, json: async () => JSON.parse(buf) } as any;
  } catch {
    return { ok: false, json: async () => ({}) } as any;
  }
};

const { loadCables, segmentPath } = await import('../src/cables');
const { loadHubs } = await import('../src/hubs');
const { loadLandmass } = await import('../src/landmass');
const { haversineKm } = await import('../src/geo');

await Promise.all([loadCables(), loadHubs(), loadLandmass()]);

// HOME = your site coordinate; set HOME_LAT/HOME_LON env (defaults to 0,0 so no
// real location is committed).
const HOME: [number, number] = [Number(process.env.HOME_LON) || 0, Number(process.env.HOME_LAT) || 0];
const CITIES: Record<string, [number, number]> = {
  LA: [-118.2437, 34.0522],
  SF: [-122.4194, 37.7749],
  Sacramento: [-121.4944, 38.5816],
  Kansas: [-94.5786, 39.0997],
  NY: [-74.006, 40.7128],
  Rio: [-43.1729, -22.9068],
  Sydney: [151.2093, -33.8688],
  CapeTown: [18.4241, -33.9249],
  Frankfurt: [8.6821, 50.1109],
  Dublin: [-6.2603, 53.3498],
  Moscow: [37.6173, 55.7558],
  Mumbai: [72.8777, 19.076],
  Istanbul: [28.9784, 41.0082],
  Seoul: [126.978, 37.5665],
  Incheon: [126.7052, 37.4563],
  Busan: [129.0756, 35.1796],
  Tokyo: [139.6917, 35.6895],
  Singapore: [103.8198, 1.3521],
  Shanghai: [121.4737, 31.2304],
  Beijing: [116.4074, 39.9042],
};

for (const [name, p] of Object.entries(CITIES)) {
  const { path, snapped } = segmentPath(p, HOME);
  let maxHop = 0;
  let minLat = 90;
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    if (path[i][1] < minLat) minLat = path[i][1];
    if (i > 0) {
      const d = haversineKm(path[i - 1], path[i]);
      total += d;
      if (d > maxHop) maxHop = d;
    }
  }
  const sample = path
    .filter((_, i) => i % Math.max(1, Math.floor(path.length / 14)) === 0 || i === path.length - 1)
    .map((c) => `${c[0].toFixed(1)},${c[1].toFixed(1)}`)
    .join(' ');
  console.log(
    `${name.padEnd(11)} snapped=${snapped ? 1 : 0} pts=${String(path.length).padStart(4)} maxHop=${maxHop.toFixed(0).padStart(5)}km total=${total.toFixed(0).padStart(6)}km minLat=${minLat.toFixed(1).padStart(6)}\n  ${sample}`,
  );
}
