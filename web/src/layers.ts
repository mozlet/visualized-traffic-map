import { GeoJsonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Layer } from '@deck.gl/core';
import type { LiveFlow, ProtoKey } from './types';
import type { RoutePath } from './routes';

export const PROTO_COLOR: Record<ProtoKey, [number, number, number]> = {
  tcp: [34, 211, 238], // cyan
  udp: [245, 158, 11], // amber
  icmp: [232, 121, 249], // magenta
  icmp6: [244, 114, 182], // rose
  igmp: [74, 222, 128], // green (multicast)
  gre: [45, 212, 191], // teal (tunnel)
  esp: [248, 113, 113], // red (IPsec VPN)
  sctp: [129, 140, 248], // indigo
  ospf: [217, 119, 6], // orange-brown (routing)
  other: [148, 163, 184], // slate
};

// SNI-derived application categories → colour. Used when "color by app" is on.
export const CATEGORY_COLOR: Record<string, [number, number, number]> = {
  chat: [34, 197, 94],
  social: [16, 185, 129],
  video: [239, 68, 68],
  shopping: [249, 115, 22],
  search: [59, 130, 246],
  browser: [14, 165, 233],
  cloud: [148, 163, 184],
  cdn: [100, 116, 139],
  dns: [168, 85, 247],
  os: [234, 179, 8],
  'os-update': [202, 138, 4],
  finance: [20, 184, 166],
  news: [236, 72, 153],
  media: [217, 70, 239],
  dev: [161, 161, 170],
};
const APP_OTHER: [number, number, number] = [203, 213, 225]; // classified but uncategorised
const DDOS_RED: [number, number, number] = [239, 68, 68];

const flowRGB = (f: LiveFlow, byCat: boolean): [number, number, number] => {
  if (f.ddos) return DDOS_RED;
  if (byCat && f.flow.app) return CATEGORY_COLOR[f.flow.category ?? ''] ?? APP_OTHER;
  return PROTO_COLOR[f.proto];
};

// Country borders from the bundled Natural Earth dataset — no external tiles.
export function borderLayer(): Layer {
  return new GeoJsonLayer({
    id: 'borders',
    data: '/data/world.geojson',
    stroked: true,
    filled: true,
    getFillColor: [17, 24, 39, 255],
    getLineColor: [71, 85, 105, 110],
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

// TeleGeography submarine cables — bundled locally, the "real routing" texture.
export function cableLayer(visible: boolean): Layer {
  return new GeoJsonLayer({
    id: 'cables',
    data: '/data/cables.geojson',
    visible,
    stroked: true,
    filled: false,
    getLineColor: [56, 189, 248, 70],
    lineWidthMinPixels: 0.6,
    pickable: false,
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
): Layer {
  const data = flows.filter((f) => enabled[f.proto] && now - f.born < lifetimeMs);
  return new ScatterplotLayer<LiveFlow>({
    id: 'endpoints',
    data,
    getPosition: (f) => f.dst,
    getRadius: (f) => 1.6 + Math.min(3, f.width),
    radiusUnits: 'pixels',
    getFillColor: (f) => {
      const c = flowRGB(f, byCat);
      const a = Math.max(0, 1 - (now - f.born) / lifetimeMs);
      return [c[0], c[1], c[2], a * 200];
    },
    updateTriggers: { getFillColor: [now, byCat], getRadius: now },
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
    getColor: (f) => flowRGB(f, byCat),
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
      getColor: byCat,
    },
  });
}
