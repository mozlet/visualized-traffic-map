// Visible internet-infrastructure overlay for street-zoom: cable landings,
// IXPs (Internet Exchange Points), and PeeringDB-listed facilities. Renders
// what the routing layer already loads (`hubs.local.geojson` / `hubs.geojson`)
// as discrete points so the deep-zoom view is a *network* map (where your
// flows actually transit) instead of a road map.

import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

type Role = 'landing' | 'ixp' | 'fac' | 'gfw';
interface Node {
  position: [number, number];
  role: Role;
  name: string;
  country: string;
}

// PeeringDB lists ~10 IXPs globally and **0** in China, so CN-bound BGP egress
// hand-coded here. These are the four "国际出口" through which essentially all
// of mainland China's international IP traffic transits (China Telecom CN2 /
// China Unicom / China Mobile peer with foreign carriers at these gateways,
// and the GFW deep-packet inspection sits in-line at the same locations).
// Adding them gives the network-map view the actual choke points that flow
// arcs converge on at the border between domestic and foreign traffic.
const GFW_GATEWAYS: Node[] = [
  { position: [116.4074, 39.9042], role: 'gfw', name: '北京国际出口 (BJIX)', country: 'China' },
  { position: [121.4737, 31.2304], role: 'gfw', name: '上海国际出口 (SHIX)', country: 'China' },
  { position: [113.2644, 23.1291], role: 'gfw', name: '广州国际出口 (GZIX)', country: 'China' },
  { position: [106.5516, 29.5630], role: 'gfw', name: '重庆国际出口', country: 'China' },
];

let nodes: Node[] = [];
let ready = false;

export function infraReady(): boolean {
  return ready;
}

export async function loadInfra(): Promise<void> {
  if (ready) return;
  // Prefer local PeeringDB-enriched file when present (operator-only); fall back
  // to the public landings+IXP set bundled with the app.
  for (const url of ['/data/hubs.local.geojson', '/data/hubs.geojson']) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const gj = await r.json();
      const out: Node[] = [];
      for (const f of gj.features ?? []) {
        const c = f.geometry?.coordinates;
        if (!Array.isArray(c) || c.length < 2) continue;
        const role = (f.properties?.role || 'fac') as Role;
        out.push({
          position: [c[0], c[1]],
          role,
          name: f.properties?.name || '',
          country: f.properties?.country || '',
        });
      }
      nodes = [...out, ...GFW_GATEWAYS];
      ready = nodes.length > 0;
      if (ready) return;
    } catch {
      /* try next */
    }
  }
}

// Magenta diamonds for IXPs (where ASes peer); cyan rings for cable landings
// (where the planet's submarine fibre touches land); dim white dots for the
// rest of the PeeringDB facility set (datacentres / interconnect rooms). All
// gated by zoom so the world view stays uncluttered.
const IXP_MIN_ZOOM = 4;
const LANDING_MIN_ZOOM = 5;
const FAC_MIN_ZOOM = 8;
const IXP_LABEL_MIN_ZOOM = 6;
const LANDING_LABEL_MIN_ZOOM = 8;

export function infraLayers(zoom: number, visible: boolean): Layer[] {
  if (!ready || !visible) return [];

  const ixps = zoom >= IXP_MIN_ZOOM ? nodes.filter((n) => n.role === 'ixp') : [];
  const landings = zoom >= LANDING_MIN_ZOOM ? nodes.filter((n) => n.role === 'landing') : [];
  const facs = zoom >= FAC_MIN_ZOOM ? nodes.filter((n) => n.role === 'fac') : [];
  // GFW egress markers always render (4 dots, no clutter cost) — they're the
  // single most important context for a "network" view of CN traffic.
  const gfws = nodes.filter((n) => n.role === 'gfw');

  const out: Layer[] = [];

  // Facility dots first (under) — most numerous, dimmest. PeeringDB facilities
  // are interconnect rooms / datacentres; their density is the actual shape of
  // the global internet, so showing them is the point even without labels.
  if (zoom >= FAC_MIN_ZOOM) {
    out.push(
      new ScatterplotLayer<Node>({
        id: 'infra-fac',
        data: facs,
        getPosition: (d) => d.position,
        getRadius: 1.6,
        radiusUnits: 'pixels',
        getFillColor: [180, 200, 220, 140],
        stroked: false,
        pickable: false,
      }),
    );
  }

  // Cable landings — cyan ring with center dot. Coastal points where submarine
  // fibres come ashore.
  if (zoom >= LANDING_MIN_ZOOM) {
    out.push(
      new ScatterplotLayer<Node>({
        id: 'infra-landing',
        data: landings,
        getPosition: (d) => d.position,
        getRadius: 5,
        radiusUnits: 'pixels',
        getFillColor: [125, 211, 252, 90],
        stroked: true,
        getLineColor: [125, 211, 252, 245], // sky-300
        lineWidthMinPixels: 1.4,
        pickable: false,
      }),
    );
  }
  if (zoom >= LANDING_LABEL_MIN_ZOOM) {
    out.push(
      new TextLayer<Node>({
        id: 'infra-landing-labels',
        data: landings,
        getPosition: (d) => d.position,
        getText: (d) => d.name,
        getSize: 9,
        getColor: [125, 211, 252, 220],
        getPixelOffset: [0, -10],
        fontFamily: '"Noto Sans CJK SC", system-ui, sans-serif',
        characterSet: 'auto',
        background: true,
        backgroundPadding: [2, 0],
        getBackgroundColor: [10, 14, 22, 160],
        sizeUnits: 'pixels',
        pickable: false,
      }),
    );
  }

  // IXPs — magenta dots (always visible from z≥IXP_MIN_ZOOM). These are where
  // actual BGP peering happens; for a network-map view they're the single most
  // important points to surface, so they get the biggest, brightest marker.
  out.push(
    new ScatterplotLayer<Node>({
      id: 'infra-ixp',
      data: ixps,
      getPosition: (d) => d.position,
      getRadius: 6,
      radiusUnits: 'pixels',
      getFillColor: [232, 121, 249, 240], // fuchsia-400
      stroked: true,
      getLineColor: [255, 255, 255, 230],
      lineWidthMinPixels: 1.2,
      pickable: false,
    }),
  );
  if (zoom >= IXP_LABEL_MIN_ZOOM) {
    out.push(
      new TextLayer<Node>({
        id: 'infra-ixp-labels',
        data: ixps,
        getPosition: (d) => d.position,
        getText: (d) => d.name,
        getSize: 10,
        getColor: [240, 200, 255, 240],
        getPixelOffset: [0, -12],
        fontFamily: '"Noto Sans CJK SC", system-ui, sans-serif',
        characterSet: 'auto',
        background: true,
        backgroundPadding: [2, 0],
        getBackgroundColor: [10, 14, 22, 170],
        fontWeight: 600,
        sizeUnits: 'pixels',
        pickable: false,
      }),
    );
  }

  // GFW / international-gateway markers. Bigger, hotter, always labelled —
  // these are the choke points where mainland CN traffic crosses into and out
  // of the global internet, and they're the answer to "where are my packets
  // actually leaving China?". Two rings (orange outer halo + red dot) so
  // they're impossible to miss against the cable spaghetti.
  if (gfws.length > 0) {
    out.push(
      new ScatterplotLayer<Node>({
        id: 'infra-gfw-halo',
        data: gfws,
        getPosition: (d) => d.position,
        getRadius: 12,
        radiusUnits: 'pixels',
        getFillColor: [0, 0, 0, 0],
        stroked: true,
        getLineColor: [251, 146, 60, 220], // orange-400
        lineWidthMinPixels: 1.4,
        pickable: false,
      }),
      new ScatterplotLayer<Node>({
        id: 'infra-gfw',
        data: gfws,
        getPosition: (d) => d.position,
        getRadius: 5,
        radiusUnits: 'pixels',
        getFillColor: [239, 68, 68, 245], // red-500
        stroked: true,
        getLineColor: [255, 255, 255, 240],
        lineWidthMinPixels: 1.2,
        pickable: false,
      }),
      new TextLayer<Node>({
        id: 'infra-gfw-labels',
        data: gfws,
        getPosition: (d) => d.position,
        getText: (d) => d.name,
        getSize: 11,
        getColor: [254, 215, 170, 245], // orange-200
        getPixelOffset: [0, -18],
        fontFamily: '"Noto Sans CJK SC", system-ui, sans-serif',
        characterSet: 'auto',
        background: true,
        backgroundPadding: [3, 1],
        getBackgroundColor: [10, 14, 22, 200],
        fontWeight: 700,
        sizeUnits: 'pixels',
        pickable: false,
      }),
    );
  }

  return out;
}
