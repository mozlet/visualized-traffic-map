import { GeoJsonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Layer } from '@deck.gl/core';
import type { LiveFlow, ProtoKey } from './types';
import type { RoutePath } from './routes';
import { flowColor, parseHex } from './colors';

// Re-exported so the legend/swatches keep importing palette from one place.
export { PROTO_COLOR, CATEGORY_COLOR, ANOMALY } from './colors';

// Country borders from the bundled Natural Earth dataset — no external tiles.
export function borderLayer(theme: 'dark' | 'light' = 'dark'): Layer {
  const light = theme === 'light';
  return new GeoJsonLayer({
    id: `borders-${theme}`,
    data: '/data/world.geojson',
    stroked: true,
    filled: true,
    getFillColor: light ? [226, 232, 240, 255] : [17, 24, 39, 255],
    getLineColor: light ? [148, 163, 184, 170] : [71, 85, 105, 110],
    lineWidthMinPixels: 0.5,
    pickable: false,
  });
}

// Real measured mtr paths (faint static polylines under the live comets).
export function routesLayer(routes: RoutePath[], visible: boolean): Layer {
  return new PathLayer<RoutePath>({
    id: 'routes',
    data: routes,
    visible,
    getPath: (r) => r.points,
    getColor: [125, 185, 232, 38], // dim, subtle texture (was a bright near-white clutter)
    getWidth: 1,
    widthUnits: 'pixels',
    widthMinPixels: 0.5,
    capRounded: true,
    jointRounded: true,
  });
}

// TeleGeography submarine cables — the "real routing" backdrop the flows run over.
// `colorful=false` (default): single uniform sky-400 (#38bdf8) texture. `colorful
// =true`: each cable in its OWN real dataset colour, like submarinecablemap.com.
// Hover identifies a cable by name in both modes.
const CABLE_FALLBACK: [number, number, number] = [56, 189, 248];
export function cableLayer(visible: boolean, colorful = false): Layer {
  return new GeoJsonLayer({
    id: `cables-${colorful ? 'c' : 's'}`, // distinct id so the layer rebuilds on toggle
    data: '/data/cables.geojson',
    visible,
    stroked: true,
    filled: false,
    getLineColor: colorful
      ? (f: { properties?: { color?: string } }) => {
          const c = parseHex(f.properties?.color) ?? CABLE_FALLBACK;
          return [c[0], c[1], c[2], 150];
        }
      : [56, 189, 248, 70],
    lineWidthMinPixels: colorful ? 0.8 : 0.6,
    pickable: true,
    autoHighlight: true,
    highlightColor: [125, 211, 252, 230],
  });
}

// Pulsing glow at the OPNsense site (home).
export function homeLayers(home: [number, number], pulse: number): Layer[] {
  const data = [{ position: home }];
  return [
    new ScatterplotLayer({
      id: 'home-halo',
      data,
      getPosition: (d: { position: [number, number] }) => d.position,
      getRadius: 13 + 9 * pulse,
      radiusUnits: 'pixels',
      getFillColor: [255, 255, 255, 28],
      stroked: false,
      pickable: false,
      updateTriggers: { getRadius: pulse },
    }),
    new ScatterplotLayer({
      id: 'home-core',
      data,
      getPosition: (d: { position: [number, number] }) => d.position,
      getRadius: 3.5,
      radiusUnits: 'pixels',
      getFillColor: [255, 255, 255, 235],
      stroked: false,
      pickable: false,
    }),
  ];
}

// Fading dot at each flow's destination.
export function endpointLayer(
  flows: LiveFlow[],
  now: number,
  lifetimeMs: number,
  enabled: Record<ProtoKey, boolean>,
  byCat: boolean,
  light = false,
): Layer {
  const data = flows.filter((f) => enabled[f.proto] && now - f.born < lifetimeMs);
  return new ScatterplotLayer<LiveFlow>({
    id: 'endpoints',
    data,
    getPosition: (f) => f.dst,
    getRadius: (f) => 1.6 + Math.min(3, f.width),
    radiusUnits: 'pixels',
    getFillColor: (f) => {
      const c = flowColor(f, byCat, light);
      const a = Math.max(0, 1 - (now - f.born) / lifetimeMs);
      return [c[0], c[1], c[2], a * 200];
    },
    // Fade needn't update every frame — quantize to ~10fps; radius is constant.
    updateTriggers: { getFillColor: [Math.floor(now / 100), byCat, light] },
    stroked: false,
    pickable: true,
  });
}

// Animated comet trails. Each flow is a one-shot trip (no looping → no
// antimeridian/modulo boundary glitch). currentTime and timestamps share the
// epoch-relative clock. Sphere-densified path keeps trans-Pacific arcs correct.
export function tripsLayer(
  flows: LiveFlow[],
  currentTime: number,
  epoch: number,
  travelMs: number,
  trailMs: number,
  enabled: Record<ProtoKey, boolean>,
  byCat: boolean,
  light = false,
): Layer {
  const data = flows.filter((f) => {
    if (!enabled[f.proto]) return false;
    const start = f.born - epoch;
    return currentTime >= start && currentTime < start + travelMs + trailMs;
  });
  return new TripsLayer<LiveFlow>({
    id: 'flows',
    data,
    getPath: (f) => f.path,
    getTimestamps: (f) => {
      const start = f.born - epoch;
      const n = f.path.length - 1;
      return f.path.map((_, i) => start + (i / n) * travelMs);
    },
    getColor: (f) => flowColor(f, byCat, light),
    getWidth: (f) => (f.ddos ? f.width * 1.5 : f.width),
    widthUnits: 'pixels',
    widthMinPixels: 1.2,
    capRounded: true,
    jointRounded: true,
    fadeTrail: true,
    trailLength: trailMs,
    currentTime,
    pickable: true,
    updateTriggers: {
      getTimestamps: [epoch, travelMs],
      getColor: [byCat, light],
    },
  });
}
