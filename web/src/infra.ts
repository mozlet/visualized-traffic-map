// Visible internet-infrastructure overlay for street-zoom: cable landings,
// IXPs (Internet Exchange Points), and PeeringDB-listed facilities. Renders
// what the routing layer already loads (`hubs.local.geojson` / `hubs.geojson`)
// as discrete points so the deep-zoom view is a *network* map (where your
// flows actually transit) instead of a road map.

import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

type Role = 'landing' | 'ixp' | 'fac' | 'pop';
interface Node {
  position: [number, number];
  role: Role;
  name: string;
  country: string;
}

// Major CN backbone POPs (China Telecom ChinaNet / China Unicom / China Mobile
// regional NAPs that aggregate provincial traffic). PeeringDB doesn't list
// these, but they're the de-facto domestic peering / transit anchors that show
// up as transit hops in mtr traces from most CN flows. Hand-curated; not
// authoritative, but covers the dominant trunk. The four MIIT-designated
// 国际通信出入口局 (Beijing/Shanghai/Guangzhou/Chongqing) are folded in as
// regular POPs — earlier rendering pulled them out as a separate "GFW" tier
// with red halos but the user asked to drop that distinction.
const CN_POPS: Node[] = [
  { position: [116.4074, 39.9042], role: 'pop', name: '北京 POP', country: 'China' },
  { position: [121.4737, 31.2304], role: 'pop', name: '上海 POP', country: 'China' },
  { position: [113.2644, 23.1291], role: 'pop', name: '广州 POP', country: 'China' },
  { position: [106.5516, 29.5630], role: 'pop', name: '重庆 POP', country: 'China' },
  { position: [117.2010, 39.0842], role: 'pop', name: '天津 POP', country: 'China' },
  { position: [123.4290, 41.7968], role: 'pop', name: '沈阳 POP', country: 'China' },
  { position: [113.6253, 34.7466], role: 'pop', name: '郑州 POP', country: 'China' },
  { position: [114.3055, 30.5928], role: 'pop', name: '武汉 POP', country: 'China' },
  { position: [108.9398, 34.3416], role: 'pop', name: '西安 POP', country: 'China' },
  { position: [104.0668, 30.5728], role: 'pop', name: '成都 POP', country: 'China' },
  { position: [102.7123, 25.0407], role: 'pop', name: '昆明 POP', country: 'China' },
  { position: [ 87.6168, 43.8256], role: 'pop', name: '乌鲁木齐 POP', country: 'China' },
  { position: [118.7969, 32.0603], role: 'pop', name: '南京 POP', country: 'China' },
  { position: [120.1551, 30.2741], role: 'pop', name: '杭州 POP', country: 'China' },
  { position: [120.3826, 36.0671], role: 'pop', name: '青岛 POP', country: 'China' },
  { position: [114.1694, 22.3193], role: 'pop', name: '香港 POP', country: 'Hong Kong' },
];

// Hand-curated ChinaNet trunk segments. Drawn as semi-transparent thin paths
// so the bones of the network are visible without competing with the live-flow
// arcs. Each pair (a, b) refs city names from CN_POPS, resolved at render.
const TRUNK_LINKS: [string, string][] = [
  ['北京 POP', '天津 POP'],
  ['北京 POP', '沈阳 POP'],
  ['北京 POP', '青岛 POP'],
  ['北京 POP', '郑州 POP'],
  ['北京 POP', '西安 POP'],
  ['郑州 POP', '武汉 POP'],
  ['武汉 POP', '广州 POP'],
  ['武汉 POP', '上海 POP'],
  ['西安 POP', '成都 POP'],
  ['西安 POP', '乌鲁木齐 POP'],
  ['成都 POP', '重庆 POP'],
  ['成都 POP', '昆明 POP'],
  ['重庆 POP', '武汉 POP'],
  ['上海 POP', '南京 POP'],
  ['上海 POP', '杭州 POP'],
  ['上海 POP', '广州 POP'],
  ['广州 POP', '香港 POP'],
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
      nodes = [...out, ...CN_POPS];
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
const POP_MIN_ZOOM = 3;
const POP_LABEL_MIN_ZOOM = 5;
const TRUNK_MIN_ZOOM = 3;

export function infraLayers(zoom: number, visible: boolean): Layer[] {
  if (!ready || !visible) return [];

  const ixps = zoom >= IXP_MIN_ZOOM ? nodes.filter((n) => n.role === 'ixp') : [];
  const landings = zoom >= LANDING_MIN_ZOOM ? nodes.filter((n) => n.role === 'landing') : [];
  const facs = zoom >= FAC_MIN_ZOOM ? nodes.filter((n) => n.role === 'fac') : [];
  const pops = zoom >= POP_MIN_ZOOM ? nodes.filter((n) => n.role === 'pop') : [];

  // Resolve trunk links to actual coordinate pairs (skip if either end is
  // missing — defensive, the hard-coded set should never miss a name).
  const byName = new Map(nodes.map((n) => [n.name, n.position] as const));
  const trunks =
    zoom >= TRUNK_MIN_ZOOM
      ? TRUNK_LINKS.flatMap(([a, b]) => {
          const pa = byName.get(a);
          const pb = byName.get(b);
          return pa && pb ? [{ from: a, to: b, path: [pa, pb] as [number, number][] }] : [];
        })
      : [];

  const out: Layer[] = [];

  // ── Backbone trunk lines (drawn first / under everything else). Thin cyan
  // strokes that sketch the ChinaNet domestic backbone: 国际出口 ↔ regional POP
  // ↔ neighbour POP / 国际出口. Real flows still ride on top.
  if (trunks.length > 0) {
    out.push(
      new PathLayer<(typeof trunks)[number]>({
        id: 'infra-trunk',
        data: trunks,
        getPath: (d) => d.path,
        getColor: [56, 189, 248, 110], // sky-400 dim
        getWidth: 1.2,
        widthUnits: 'pixels',
        widthMinPixels: 0.8,
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
    );
  }

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

  // ── CN backbone POPs (electric-cyan dots). Sub-international, regional
  // aggregation centers; smaller than GFW egress so the hierarchy reads.
  if (pops.length > 0) {
    out.push(
      new ScatterplotLayer<Node>({
        id: 'infra-pop',
        data: pops,
        getPosition: (d) => d.position,
        getRadius: 4,
        radiusUnits: 'pixels',
        getFillColor: [56, 189, 248, 235], // sky-400
        stroked: true,
        getLineColor: [255, 255, 255, 220],
        lineWidthMinPixels: 1,
        pickable: false,
      }),
    );
  }
  if (zoom >= POP_LABEL_MIN_ZOOM) {
    out.push(
      new TextLayer<Node>({
        id: 'infra-pop-labels',
        data: pops,
        getPosition: (d) => d.position,
        getText: (d) => d.name,
        getSize: 9,
        getColor: [191, 219, 254, 230], // blue-200
        getPixelOffset: [0, 11],
        fontFamily: '"Noto Sans CJK SC", system-ui, sans-serif',
        characterSet: 'auto',
        background: true,
        backgroundPadding: [2, 0],
        getBackgroundColor: [10, 14, 22, 170],
        fontWeight: 500,
        sizeUnits: 'pixels',
        pickable: false,
      }),
    );
  }

  return out;
}
