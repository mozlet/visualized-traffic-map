// Localized place labels (country / state-capital / city / town) rendered as
// deck.gl TextLayers, progressively by zoom — like a basemap, but from bundled
// Natural Earth GeoJSON (no external tiles). Name field follows browser language.

import { TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

interface Place {
  position: [number, number];
  text: string;
  mz: number; // min zoom to show
  cap: boolean; // capital (bigger)
}

interface RawFeature {
  properties: Record<string, unknown>;
  geometry: { coordinates: [number, number] };
}

let places: Place[] = [];
let countries: Place[] = [];
let towns: Place[] = []; // denser global gazetteer (GeoNames), single name, by population
let ready = false;
let placesRaw: RawFeature[] = [];
let countriesRaw: RawFeature[] = [];
let curField = '';
// Pre-baked character set spanning every label text we'll ever ask deck.gl to
// render. With characterSet:'auto' the atlas only contains the chars present in
// the FIRST frame's data, and panning to a new viewport that introduces new CJK
// characters then triggers per-char "Missing character" warnings while the
// atlas asynchronously rebuilds — and those characters render blank on the
// first frame they appear. Baking the full set up front avoids both.
let charSet = '';

// Re-derive label text for a given GeoJSON name field (e.g. n_en / n_zh).
function derive(field: string): void {
  const text = (ft: RawFeature) =>
    (ft.properties[field] as string) || (ft.properties.name as string) || '';
  places = placesRaw
    .map((ft) => ({
      position: ft.geometry.coordinates,
      text: text(ft),
      mz: (ft.properties.mz as number) ?? 7,
      cap: String(ft.properties.fc || '').includes('capital'),
    }))
    .filter((p) => p.text);
  countries = countriesRaw
    .map((ft) => ({ position: ft.geometry.coordinates, text: text(ft), mz: 0, cap: false }))
    .filter((p) => p.text);
  curField = field;
  const chars = new Set<string>();
  for (const p of places) for (const ch of p.text) chars.add(ch);
  for (const c of countries) for (const ch of c.text) chars.add(ch);
  for (const t of towns) for (const ch of t.text) chars.add(ch);
  charSet = [...chars].join('');
  ready = true;
}

// Fetch the bundled GeoJSON once; switching language only re-derives text.
export async function loadLabels(field: string): Promise<void> {
  if (placesRaw.length === 0) {
    try {
      const pj = await (await fetch('/data/places.geojson')).json();
      placesRaw = pj.features ?? [];
      const cj = await (await fetch('/data/country-labels.geojson')).json();
      countriesRaw = cj.features ?? [];
      // Denser global town tier (GeoNames). Single `n` name (gazetteer has no
      // curated 12-lang set at this density); min-zoom derived from population so
      // bigger towns surface first as the user zooms in. Shown only deep-zoomed and
      // viewport-culled (see labelLayers), so the rendered count stays small.
      const tj = await (await fetch('/data/towns.geojson')).json();
      towns = (tj.features ?? [])
        .map((ft: { properties: { n: string; p: number }; geometry: { coordinates: [number, number] } }) => {
          const p = ft.properties.p || 0;
          const mz = p >= 5e5 ? 7 : p >= 1.5e5 ? 8 : p >= 5e4 ? 9 : 10;
          return { position: ft.geometry.coordinates, text: ft.properties.n, mz, cap: false };
        })
        .filter((t: Place) => t.text);
    } catch (e) {
      console.warn('labels load failed', e);
      return;
    }
  }
  if (field !== curField) derive(field);
}

// `active` is a set of "gx,gy" 3°-grid cells covering recent flow endpoints.
// Zoomed out we only label regions traffic actually touches (declutter); zoomed
// in we show the full country/place set so the focused area is readable.
const GRID = 3;
const cellNear = (active: Set<string>, pos: [number, number]): boolean => {
  const cx = Math.round(pos[0] / GRID);
  const cy = Math.round(pos[1] / GRID);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) if (active.has(`${cx + dx},${cy + dy}`)) return true;
  return false;
};

// Zoomed all the way out (global view) we hide every country/place label so the
// traffic itself is unobstructed; labels fade in as the user zooms into a region.
const HIDE_BELOW = 2.4;

// Name search over loaded places/countries (current language) → fly-to targets.
export function searchPlaces(q: string, limit = 8): { text: string; position: [number, number] }[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const out: { text: string; position: [number, number] }[] = [];
  for (const c of countries) if (c.text.toLowerCase().includes(s)) out.push({ text: c.text, position: c.position });
  for (const p of places) {
    if (out.length >= limit) break;
    if (p.text.toLowerCase().includes(s)) out.push({ text: p.text, position: p.position });
  }
  return out.slice(0, limit);
}

// Below this zoom the dense town tier stays hidden; above it, towns near the
// current view fade in (the "more detail as you zoom" tier, global).
const TOWN_MIN_ZOOM = 6.5;
const TOWN_MAX = 700; // hard cap on rendered town labels (perf safety)

// Fine-grid cell-near (0.1° ≈ 11 km) for the zoomed-in active-flow gate. Pairs
// with App.tsx activeFineRef and layers.ts OSM_LABEL_GRID — same bucket size so
// the three label tiers (Natural Earth city, GeoNames town, PMTiles street) all
// reveal/hide on the same cells when traffic moves.
const FINE_GRID = 0.1;
const cellNearFine = (active: Set<string>, pos: [number, number]): boolean => {
  const cx = Math.round(pos[0] / FINE_GRID);
  const cy = Math.round(pos[1] / FINE_GRID);
  return active.has(`${cx},${cy}`);
};

export function labelLayers(
  zoom: number,
  visible: boolean,
  active: Set<string>,
  activeFine: Set<string>,
  center?: [number, number],
): Layer[] {
  if (!ready || !visible || zoom < HIDE_BELOW) return [];
  const zoomedIn = zoom >= 4.2;
  // Reveal progressively more (smaller) towns as the user zooms in. The reveal
  // budget widens with zoom (was a flat +1.2), so deep zoom shows the town tier
  // (mz up to 9 in the dataset) instead of stopping at regional cities.
  const reveal = zoom < 4 ? 1.2 : 1.2 + (zoom - 4) * 0.9;
  // City/country gate semantics:
  //   • zoomed out (z<4.2): coarse 3° cells (active) keep label set thinned to
  //     traffic-touched regions — the original declutter
  //   • zoomed in (z≥4.2): fine 11km cells (activeFine) gate the label, so a
  //     deep-zoom view only shows cities the LAN actually talks to. Without
  //     this, every Chinese provincial capital labelled itself just because the
  //     map happened to pan over it, even with zero flows there.
  const placeData = places.filter(
    (p) =>
      p.mz <= zoom + reveal &&
      (zoomedIn ? cellNearFine(activeFine, p.position) : cellNear(active, p.position)),
  );
  const countryData = countries.filter((c) =>
    zoomedIn ? cellNearFine(activeFine, c.position) : cellNear(active, c.position),
  );
  // Dense town tier: only deep-zoomed, only near the current view, only towns whose
  // population-min-zoom has been reached — then capped, biggest-first. Also gated
  // by the same fine-cell active set so towns without traffic don't surface.
  let townData: Place[] = [];
  if (zoom >= TOWN_MIN_ZOOM && center) {
    const span = (360 / 2 ** zoom) * 1.5; // ~visible half-width in degrees
    townData = towns
      .filter(
        (t) =>
          t.mz <= zoom + reveal &&
          Math.abs(t.position[0] - center[0]) < span &&
          Math.abs(t.position[1] - center[1]) < span &&
          cellNearFine(activeFine, t.position),
      )
      .sort((a, b) => a.mz - b.mz) // bigger towns (lower mz) first
      .slice(0, TOWN_MAX);
  }
  const common = {
    fontFamily: '"Noto Sans CJK SC", ui-sans-serif, system-ui, sans-serif',
    getTextAnchor: 'middle' as const,
    getAlignmentBaseline: 'center' as const,
    background: true,
    backgroundPadding: [3, 1] as [number, number],
    characterSet: charSet,
    sizeUnits: 'pixels' as const,
  };
  return [
    new TextLayer<Place>({
      id: 'town-labels', // under city/country labels (rendered first), dimmer & smaller
      data: townData,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: 10,
      getColor: [148, 163, 184, 175],
      getBackgroundColor: [10, 14, 22, 120],
      fontWeight: 400,
      ...common,
    }),
    new TextLayer<Place>({
      id: 'country-labels',
      data: countryData,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: zoom < 3 ? 14 : 12,
      getColor: [226, 232, 240, zoom < 4 ? 210 : 110],
      getBackgroundColor: [10, 14, 22, 130],
      fontWeight: 700,
      ...common,
    }),
    new TextLayer<Place>({
      id: 'place-labels',
      data: placeData,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: (d) => (d.cap ? 13 : 11),
      getColor: (d) => (d.cap ? [255, 255, 255, 235] : [203, 213, 225, 205]),
      getBackgroundColor: [10, 14, 22, 150],
      fontWeight: 500,
      ...common,
    }),
  ];
}
