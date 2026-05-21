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
let ready = false;
let placesRaw: RawFeature[] = [];
let countriesRaw: RawFeature[] = [];
let curField = '';

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

export function labelLayers(zoom: number, visible: boolean, active: Set<string>): Layer[] {
  if (!ready || !visible || zoom < HIDE_BELOW) return [];
  const zoomedIn = zoom >= 4.2;
  const placeData = places.filter(
    (p) => p.mz <= zoom + 1.2 && (zoomedIn || cellNear(active, p.position)),
  );
  const countryData = countries.filter((c) => zoomedIn || cellNear(active, c.position));
  const common = {
    fontFamily: '"Noto Sans CJK SC", ui-sans-serif, system-ui, sans-serif',
    getTextAnchor: 'middle' as const,
    getAlignmentBaseline: 'center' as const,
    background: true,
    backgroundPadding: [3, 1] as [number, number],
    characterSet: 'auto' as const,
    sizeUnits: 'pixels' as const,
  };
  return [
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
