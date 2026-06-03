// Visible internet-infrastructure overlay for street-zoom: cable landings,
// IXPs (Internet Exchange Points), and PeeringDB-listed facilities. Renders
// what the routing layer already loads (`hubs.local.geojson` / `hubs.geojson`)
// as discrete points so the deep-zoom view is a *network* map (where your
// flows actually transit) instead of a road map.

import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { getTopology, loadTopology } from './topology';

type Role = 'landing' | 'ixp' | 'fac' | 'pop';
interface Node {
  position: [number, number];
  role: Role;
  name: string;
  country: string;
}

let nodes: Node[] = [];
let ready = false;

export function infraReady(): boolean {
  return ready;
}

export async function loadInfra(): Promise<void> {
  if (ready) return;
  // Optional user-supplied per-country POPs / trunk lines (see topology.ts).
  // Loads in parallel with PeeringDB so we render whatever is configured even
  // if PeeringDB is unreachable.
  const topoP = loadTopology();
  // Prefer local PeeringDB-enriched file when present (operator-only); fall
  // back to the public landings+IXP set bundled with the app.
  let acc: Node[] = [];
  for (const url of ['/data/hubs.local.geojson', '/data/hubs.geojson']) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const gj = await r.json();
      for (const f of gj.features ?? []) {
        const c = f.geometry?.coordinates;
        if (!Array.isArray(c) || c.length < 2) continue;
        const role = (f.properties?.role || 'fac') as Role;
        acc.push({
          position: [c[0], c[1]],
          role,
          name: f.properties?.name || '',
          country: f.properties?.country || '',
        });
      }
      if (acc.length > 0) break;
    } catch {
      /* try next */
    }
  }
  await topoP;
  const topoPops: Node[] = getTopology().pops.map((p) => ({
    position: p.position,
    role: 'pop' as const,
    name: p.name,
    country: p.country ?? '',
  }));
  nodes = [...acc, ...topoPops];
  ready = nodes.length > 0;
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

  // Resolve trunk links (loaded from /data/topology.json) to actual coordinate
  // pairs; drop any pair whose endpoint names don't resolve to a known POP.
  const byName = new Map(nodes.map((n) => [n.name, n.position] as const));
  const trunks =
    zoom >= TRUNK_MIN_ZOOM
      ? getTopology().trunks.flatMap(([a, b]) => {
          const pa = byName.get(a);
          const pb = byName.get(b);
          return pa && pb ? [{ from: a, to: b, path: [pa, pb] as [number, number][] }] : [];
        })
      : [];

  const out: Layer[] = [];

  // ── Backbone trunk lines (drawn first / under everything else). Thin cyan
  // strokes that sketch the regional domestic backbone configured in
  // /data/topology.json. Real flows still ride on top.
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
