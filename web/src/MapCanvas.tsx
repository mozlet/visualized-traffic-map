// The animated map surface, split out from the App shell. The ~30 fps animation
// tick lives HERE so only the canvas re-renders each frame — the panels/controls
// in App no longer reconcile 30×/s (the main render-pressure win). Static layers
// (borders, night, labels) are built in App and passed in; only the comet/endpoint
// layers rebuild per frame.

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { DeckGL } from '@deck.gl/react';
import { MapView, _GlobeView as GlobeView } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { cableLayer, endpointLayer, homeLayers, routesLayer, tripsLayer } from './layers';
import type { RoutePath } from './routes';
import type { LiveFlow, ProtoKey, ServiceKey } from './types';

const BASE_TRAVEL = 2200;
const TRAIL = 700;

type Dir = 'all' | 'out' | 'in' | 'internal' | 'transit';
type VS = { longitude: number; latitude: number; zoom: number; pitch: number; bearing: number };

function dirOf(f: LiveFlow): Dir {
  const sh = f.flow.src_geo?.is_home;
  const dh = f.flow.dst_geo?.is_home;
  if (sh && dh) return 'internal';
  if (sh && !dh) return 'out';
  if (!sh && dh) return 'in';
  return 'transit';
}

export interface MapCanvasProps {
  flowsRef: MutableRefObject<LiveFlow[]>;
  staticLayers: Layer[]; // borders + night + labels, memoized in App
  routes: RoutePath[];
  home: [number, number];
  view: '2d' | '3d';
  theme: 'dark' | 'light';
  viewState: VS;
  onViewStateChange: (vs: VS) => void;
  paused: boolean;
  speed: number;
  dir: Dir;
  minBytes: number;
  enabled: Record<ProtoKey, boolean>;
  enabledSvc: Record<ServiceKey, boolean>;
  showDdos: boolean;
  colorByApp: boolean;
  showCables: boolean;
  cableColorful: boolean;
  showRoutes: boolean;
  tooltip: (f: LiveFlow) => string;
}

export function MapCanvas(props: MapCanvasProps) {
  const {
    flowsRef, staticLayers, routes, home, view, theme, viewState, onViewStateChange,
    paused, speed, dir, minBytes, enabled, enabledSvc, showDdos, colorByApp,
    showCables, cableColorful, showRoutes, tooltip,
  } = props;

  const [, force] = useState(0);
  const lastRef = useRef(0);
  const epochRef = useRef(performance.now());

  // ~30 fps tick; pause freezes the frame. Only THIS component re-renders.
  useEffect(() => {
    if (paused) return;
    let raf = 0;
    const loop = (t: number) => {
      if (t - lastRef.current >= 33) {
        force((x) => x + 1);
        lastRef.current = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paused]);

  const deckView = useMemo(
    () =>
      view === '3d'
        ? new GlobeView({ controller: true })
        : new MapView({ controller: true, repeat: true }),
    [view],
  );

  // Static-per-frame layers: rebuild only when their inputs change, not 30×/s.
  const cables = useMemo(() => cableLayer(showCables, cableColorful), [showCables, cableColorful]);
  const routesL = useMemo(() => routesLayer(routes, showRoutes), [routes, showRoutes]);

  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 700);
  const homeLs = useMemo(() => homeLayers(home, pulse), [home, pulse]);

  const travelMs = BASE_TRAVEL / speed;
  const lifeMs = travelMs + TRAIL;
  const currentTime = now - epochRef.current;

  const visible = flowsRef.current.filter(
    (f) =>
      (dir === 'all' || dirOf(f) === dir) &&
      (f.flow.octets ?? 0) >= minBytes &&
      enabledSvc[f.svc] &&
      (showDdos || !f.ddos),
  );

  const light = theme === 'light';
  const layers = [
    ...staticLayers,
    cables,
    routesL,
    endpointLayer(visible, now, lifeMs, enabled, colorByApp, light),
    tripsLayer(visible, currentTime, epochRef.current, travelMs, TRAIL, enabled, colorByApp, light),
    ...homeLs,
  ];

  return (
    <DeckGL
      views={deckView}
      viewState={viewState}
      onViewStateChange={(p) => {
        (window as unknown as { __vs?: unknown }).__vs = p.viewState;
        onViewStateChange(p.viewState as VS);
      }}
      layers={layers}
      pickingRadius={5}
      getTooltip={({ object }) => {
        if (!object) return null;
        const style = {
          background: 'rgba(15,23,42,.95)',
          color: '#e2e8f0',
          fontSize: '11px',
          padding: '6px 8px',
          borderRadius: '6px',
          border: '1px solid rgba(148,163,184,.3)',
        };
        if ((object as LiveFlow).flow) return { html: tooltip(object as LiveFlow), style };
        // A submarine cable feature — identify it by name.
        const props = (object as { properties?: { name?: string } }).properties;
        if (props?.name) return { html: `🌊 ${props.name}`, style };
        return null;
      }}
      style={{
        background:
          theme === 'light'
            ? view === '3d'
              ? '#d3e2f2'
              : '#e8eef5'
            : view === '3d'
              ? '#05070f'
              : '#0b1120',
      }}
    />
  );
}
