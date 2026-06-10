import { GeoJsonLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { TileLayer, TripsLayer } from '@deck.gl/geo-layers';
import { MVTLoader } from '@loaders.gl/mvt';
import type { Layer } from '@deck.gl/core';
import { PMTiles } from 'pmtiles';
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

// State / province (Natural Earth admin-1) borders — a finer basemap tier that
// fades in only when zoomed into a region, so the global view stays clean. Data
// is lazily fetched the first time this layer is created (zoomed-in). Borders
// only (no fill); thinner & dimmer than country borders so the hierarchy reads.
export function stateLayer(theme: 'dark' | 'light', zoom: number): Layer[] {
  if (zoom < 3.6) return []; // only when zoomed into a region
  const light = theme === 'light';
  // Fade the borders in across zoom 3.6→5 so they appear gently, then hold.
  const a = Math.round(Math.max(0, Math.min(1, (zoom - 3.6) / 1.4)) * (light ? 170 : 150));
  return [
    new GeoJsonLayer({
      id: 'states',
      data: '/data/states.geojson',
      stroked: true,
      filled: false,
      getLineColor: light ? [100, 116, 139, a] : [130, 150, 185, a],
      lineWidthMinPixels: 0.7,
      lineWidthUnits: 'pixels',
      getLineWidth: 0.7,
      pickable: false,
      parameters: { depthTest: false },
    }),
  ];
}

// Real measured mtr paths (faint static polylines under the live comets).
export function routesLayer(routes: RoutePath[], visible: boolean): Layer {
  // mtr-measured paths: the *actual* hops from each LAN flow's `mtr` trace.
  // With the network-map view replacing the road basemap, these become the
  // single most useful overlay (they're the ground truth for "where do my
  // packets really go"), so they get a brighter + thicker stroke. Still
  // opt-in via the showRoutes toggle so users can dim them on demand.
  return new PathLayer<RoutePath>({
    id: 'routes',
    data: routes,
    visible,
    getPath: (r) => r.points,
    getColor: [165, 243, 252, 175], // cyan-200, ~70% alpha
    getWidth: 2,
    widthUnits: 'pixels',
    widthMinPixels: 1.2,
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

// OSM street-level basemap (Protomaps PMTiles, vector). One .pmtiles file
// served as a single static asset (HTTP Range Requests stream tiles on demand),
// no tile-server process. Local/LAN only — no external CDN. URL is picked at
// runtime from the settings panel ("Map Detail" = Off / Local / Country) and
// resolved through /data/topology.json's `pmtiles` map. Gated to higher zoom
// so the existing low-zoom basemap (countries/states/cables) stays clean.
const pmtilesCache = new Map<string, PMTiles>();
function getPMT(url: string): PMTiles {
  let inst = pmtilesCache.get(url);
  if (!inst) {
    inst = new PMTiles(url);
    pmtilesCache.set(url, inst);
  }
  return inst;
}
const OSM_MIN_ZOOM = 9; // below this, the global GeoJSON basemap is enough
// Label-density gate: at z<OSM_DENSE_ZOOM the viewport is wide enough that the
// raw OSM CN villages flood the screen, so we restrict place/street labels to
// fine-cells with active flow. At z≥OSM_DENSE_ZOOM the viewport is tight and the
// label count naturally falls, so we render everything (so the user can read the
// area they zoomed all the way in to).
const OSM_DENSE_ZOOM = 12;
const OSM_LABEL_GRID = 0.1; // ~11 km cells; pairs with App.tsx activeFineRef
export function osmBaseLayer(
  visible: boolean,
  zoom: number,
  langField = 'name:en',
  active?: Set<string>,
  pmtilesUrl?: string,
): Layer[] {
  if (!visible || zoom < OSM_MIN_ZOOM || !pmtilesUrl) return [];
  const labelGate = !!active && active.size > 0 && zoom < OSM_DENSE_ZOOM;
  // Exact-cell match only (≈ 22 km square). The previous 3x3 halo (~60 km) let
  // every CN village within ~30km of home through, which at the user's home view
  // (z=10, viewport ≈ 30 km wide) included basically the whole screen — i.e.
  // no filter at all. Single-cell match keeps the screen readable: only the
  // 0.2° tile that *contains* an endpoint shows its labels.
  const nearActive = (pos: [number, number]): boolean => {
    if (!labelGate) return true;
    const cx = Math.round(pos[0] / OSM_LABEL_GRID);
    const cy = Math.round(pos[1] / OSM_LABEL_GRID);
    return active!.has(`${cx},${cy}`);
  };
  // Place-class density tiers — CN OSM tags every settlement down to single-
  // farmhouse hamlets, which at z=9–11 fire hundreds of overlapping labels.
  // At mid-zoom show only city-class anchors (regional / provincial centers);
  // town/village/hamlet/etc. fade in at z≥OSM_DENSE_ZOOM (street zoom,
  // viewport small enough that they no longer pile up).
  const placeClassesAtZoom = (z: number): Set<string> =>
    z >= OSM_DENSE_ZOOM
      ? new Set(['country', 'state', 'province', 'city', 'town', 'village',
                 'hamlet', 'suburb', 'neighbourhood', 'locality'])
      : new Set(['country', 'state', 'province', 'city']);
  const allowedPlaceClasses = placeClassesAtZoom(zoom);
  return [
    new TileLayer({
      id: `osm-pmtiles:${pmtilesUrl}`, // distinct id per URL so a tier swap re-inits
      minZoom: OSM_MIN_ZOOM,
      maxZoom: 14, // tilemaker source's maxzoom; deck.gl over-zooms beyond
      tileSize: 256,
      getTileData: async ({ index }: { index: { x: number; y: number; z: number } }) => {
        const t = await getPMT(pmtilesUrl).getZxy(index.z, index.x, index.y);
        if (!t) return null;
        // MVT bytes → GeoJSON Feature array in wgs84 (one shot per tile).
        // `shape: 'geojson'` is required in loaders.gl v4+; without it the loader
        // throws "undefined shape" before parsing any geometry.
        return await MVTLoader.parse(t.data, {
          mvt: {
            shape: 'geojson',
            coordinates: 'wgs84',
            tileIndex: { x: index.x, y: index.y, z: index.z },
          },
        });
      },
      renderSubLayers: (props: { id: string; data: unknown }) => {
        // MVTLoader (geojson shape) doesn't propagate the source-layer name.
        // What DOES survive on every feature: `properties.class` (OpenMapTiles
        // taxonomy — motorway/village/lake/…) and whichever name fields tilemaker
        // included. This tileset has only `name:latin` (no `name`, no
        // `name:zh-Hans`, no `render_height`, no `housenumber`), so `nameOf()`
        // falls through to `name:latin`; `isBuilding` / `isHousenumber` simply
        // produce empty layers here and would activate against a richer preset.
        type Feat = {
          properties: Record<string, string | number | undefined>;
          geometry: { type: string; coordinates: unknown };
        };
        const raw = props.data as { features?: Feat[] } | Feat[] | null;
        const feats: Feat[] = !raw
          ? []
          : Array.isArray(raw)
            ? raw
            : (raw.features ?? []);

        // Zoom-aware: at street-zoom (≥OSM_DENSE_ZOOM) include village/hamlet/
        // suburb/neighbourhood/locality; at lower zoom only city/town survive.
        const PLACE_CLS = allowedPlaceClasses;
        const ROAD_CLS = new Set([
          'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
          'minor', 'service', 'residential', 'track', 'path', 'pedestrian', 'rail',
        ]);
        const WATER_CLS = new Set(['ocean', 'lake', 'river', 'pond', 'dock', 'swimming_pool']);

        const cls = (f: Feat) => f.properties.class as string | undefined;
        const isPlace = (f: Feat) => PLACE_CLS.has(cls(f) || '');
        const isRoad = (f: Feat) =>
          ROAD_CLS.has(cls(f) || '') &&
          (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString');
        const isWater = (f: Feat) =>
          WATER_CLS.has(cls(f) || '') &&
          (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
        // (isBuilding / isHousenumber predicates removed with their layers —
        // resurrect alongside the rendering if a street-detail toggle returns.)

        // Tile attribute fallback per requested UI language (OpenMapTiles spec):
        //   1) the exact `name:<lang>` field if present
        //   2) for Latin-UI users: `name:latin` next (transliterated), so a CN
        //      village without `name:en` reads "Hongmiaozi Cun" not "红庙子村"
        //   3) Chinese-UI users keep falling through to native `name` first,
        //      since that's already the local script they want
        //   4) raw `name` and `name:latin` are last-resort safety nets
        const isZhUI = langField === 'name:zh' || langField === 'name:zh-Hans';
        const nameOf = (f: Feat): string => {
          const lang = f.properties[langField] as string | undefined;
          if (lang) return lang;
          const name = f.properties.name as string | undefined;
          const latin = f.properties['name:latin'] as string | undefined;
          return (isZhUI ? name || latin : latin || name) || '';
        };
        // MVTLoader with shape:'geojson' flattens source layers, so filter by
        // feature predicate (properties.class / render_height / …), not by layer name.
        const by = (sel: (f: Feat) => boolean) => feats.filter(sel);
        const named = (sel: (f: Feat) => boolean) =>
          feats.filter((f) => sel(f) && nameOf(f));

        // Pick a Point for label placement: Points use coords as-is; LineStrings
        // use their midpoint; Polygons use the first ring's midpoint.
        const labelPos = (f: Feat): [number, number] => {
          const g = f.geometry;
          if (g.type === 'Point') return g.coordinates as [number, number];
          if (g.type === 'LineString') {
            const c = g.coordinates as [number, number][];
            return c[Math.floor(c.length / 2)];
          }
          if (g.type === 'Polygon') {
            const r = (g.coordinates as [number, number][][])[0];
            return r[Math.floor(r.length / 2)];
          }
          return [0, 0];
        };

        // Road colour/width by OpenMapTiles transportation `class`.
        const roadColor = (f: Feat): [number, number, number, number] => {
          switch (f.properties.class) {
            case 'motorway':
              return [253, 224, 71, 230];
            case 'trunk':
            case 'primary':
              return [251, 146, 60, 210];
            case 'secondary':
              return [203, 213, 225, 200];
            case 'rail':
              return [125, 211, 252, 170];
            case 'tertiary':
              return [186, 200, 220, 180];
            default:
              return [148, 163, 184, 160];
          }
        };
        const roadWidth = (f: Feat): number => {
          switch (f.properties.class) {
            case 'motorway':
              return 2.5;
            case 'trunk':
            case 'primary':
              return 1.8;
            case 'secondary':
              return 1.3;
            case 'tertiary':
              return 1.0;
            default:
              return 0.5;
          }
        };

        // OSM road/building rendering was removed intentionally: at deep zoom
        // the screen should show NETWORK topology (cables / IXPs / facilities
        // / mtr paths), not motorways and buildings. Water polygons stay as a
        // basemap reference (rivers / lakes / coastline still useful for
        // orientation), but the transportation + building layers — and their
        // roadColor/roadWidth ramps — are deliberately unused now and kept
        // around only so a future "OSM road layer" toggle can flip them back
        // on without re-deriving the OpenMapTiles class taxonomy.
        void roadColor;
        void roadWidth;
        return [
          // Water (rivers, lakes, ocean polygons from OSM)
          new GeoJsonLayer({
            ...props,
            id: `${props.id}-water`,
            data: by(isWater) as unknown as GeoJSON.FeatureCollection,
            stroked: false,
            filled: true,
            getFillColor: [30, 58, 80, 180],
            pickable: false,
          }),
          // Place name labels (cities, neighbourhoods) — gated to active-flow
          // cells at medium zoom (see nearActive). Roads/water/buildings stay
          // unfiltered: they're the basemap, dropping them would leave gaps.
          new TextLayer({
            ...props,
            id: `${props.id}-place-labels`,
            data: named(isPlace).filter((f) => nearActive(labelPos(f))) as unknown[],
            getPosition: labelPos as unknown as (f: unknown) => [number, number],
            getText: nameOf as unknown as (f: unknown) => string,
            getSize: 11,
            getColor: [240, 245, 250, 220],
            background: true,
            backgroundPadding: [2, 1],
            getBackgroundColor: [10, 14, 22, 150],
            fontFamily: '"Noto Sans CJK SC", system-ui, sans-serif',
            // Per-tile labels can contain any CJK char (or Cyrillic / Arabic / …).
            // Atlas is built on demand from the strings the layer actually sees.
            characterSet: 'auto',
            sizeUnits: 'pixels',
            pickable: false,
          }),
          // Street names (from transportation_name LineStrings — midpoint)
          new TextLayer({
            ...props,
            id: `${props.id}-street-labels`,
            data: named(isRoad).filter((f) => nearActive(labelPos(f))) as unknown[],
            getPosition: labelPos as unknown as (f: unknown) => [number, number],
            getText: nameOf as unknown as (f: unknown) => string,
            getSize: 9,
            getColor: [180, 200, 225, 210],
            background: true,
            backgroundPadding: [2, 0],
            getBackgroundColor: [10, 14, 22, 120],
            fontFamily: '"Noto Sans CJK SC", system-ui, sans-serif',
            characterSet: 'auto',
            sizeUnits: 'pixels',
            pickable: false,
          }),
          // House numbers were rendered here previously; dropped for the network-
          // topology view. Re-enable from git history if a future "street detail"
          // toggle wants them back.
        ];
      },
    }),
  ];
}
