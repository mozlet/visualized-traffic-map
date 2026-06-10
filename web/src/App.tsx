import { useEffect, useMemo, useRef, useState } from 'react';
import { FlyToInterpolator } from '@deck.gl/core';
import { useFlows } from './flowStream';
import { borderLayer, stateLayer, osmBaseLayer, PROTO_COLOR } from './layers';
import { MapCanvas } from './MapCanvas';
import { fetchRoutes, type RoutePath } from './routes';
import { loadLabels, labelLayers, searchPlaces } from './labels';
import { loadInfra, infraLayers } from './infra';
import { getTopology } from './topology';

type MapTier = 'off' | 'local' | 'country';
import { terminatorLayers } from './terminator';
import { Timeline } from './Timeline';
import { DraggablePanel } from './DraggablePanel';
import { SniffnetView } from './SniffnetView';
import { Icon } from './icons';
import type { LiveFlow, ProtoKey, ServiceKey } from './types';
import { STR, PLACE_LANG, PMT_LANG, LANG_NAMES, initialLang, saveLang, type Lang } from './i18n';
import './App.css';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
// `null` label = use the translated "Other" string at render time; the rest are
// universal protocol/service names that don't get translated.
const PROTOS: [ProtoKey, string | null][] = [
  ['tcp', 'TCP'],
  ['udp', 'UDP'],
  ['icmp', 'ICMP'],
  ['icmp6', 'ICMPv6'],
  ['igmp', 'IGMP'],
  ['gre', 'GRE'],
  ['esp', 'ESP/IPsec'],
  ['sctp', 'SCTP'],
  ['ospf', 'OSPF'],
  ['other', null],
];
// Service dimension (by well-known port). Filters independently of protocol.
const SERVICES: [ServiceKey, string | null][] = [
  ['https', 'HTTPS'],
  ['quic', 'QUIC'],
  ['http', 'HTTP'],
  ['dns', 'DNS'],
  ['ssh', 'SSH'],
  ['svc', null],
];
const DIRS: [Dir, keyof typeof STR.en][] = [
  ['all', 'dirAll'],
  ['out', 'dirOut'],
  ['in', 'dirIn'],
  ['internal', 'dirInternal'],
];
type Dir = 'all' | 'out' | 'in' | 'internal' | 'transit';
const BYTES = [0, 1000, 100000, 1000000];

interface LiveStats {
  bps: number;
  bps_in?: number; // download (remote → home)
  bps_out?: number; // upload (home → remote)
  top_dst: { ip: string; country: string | null; bytes: number; bytes_in?: number; bytes_out?: number }[];
  top_countries: { country: string; bytes: number; bytes_in?: number; bytes_out?: number }[];
  top_src?: { ip: string; bytes: number; bytes_in?: number; bytes_out?: number }[];
  top_services?: { service: string; bytes: number; bytes_in?: number; bytes_out?: number }[];
  top_hosts?: { label: string; asn?: string; country?: string | null; bytes: number; bytes_in?: number; bytes_out?: number }[];
}

// Compact label for a stats window in seconds: 5→"5s", 60→"1m", 600→"10m".
const fmtWin = (s: number) => (s % 60 === 0 ? `${s / 60}m` : `${s}s`);

interface AppStat {
  app: string;
  category: string | null;
  bytes: number;
  flows: number;
}
function fmtBps(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' Gbps';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' Mbps';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' Kbps';
  return b + ' bps';
}
// Byte unit family, switched by the Units setting (SI 1000 / IEC 1024).
const UNIT = { base: 1000, suf: ['B', 'K', 'M', 'G'] };
function fmtBytes(b: number): string {
  const { base, suf } = UNIT;
  if (b >= base ** 3) return (b / base ** 3).toFixed(1) + suf[3];
  if (b >= base ** 2) return (b / base ** 2).toFixed(1) + suf[2];
  if (b >= base) return (b / base).toFixed(0) + suf[1];
  return b + suf[0];
}
// Country flag icon (local SVG under /flags, zero-CDN). Hidden if no asset for
// the ISO alpha-2 code (e.g. "ZZ" unknown). Flags adapted from sniffnet.
const Flag = ({ cc }: { cc?: string | null }) =>
  cc ? (
    <img
      className="flag"
      src={`/flags/${cc.toLowerCase()}.svg`}
      alt=""
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden';
      }}
    />
  ) : null;

// Hover tooltip for a flow (deck.gl getTooltip).
function flowTip(f: LiveFlow): string {
  const fl = f.flow;
  return [
    `${fl.src_addr}:${fl.src_port ?? ''} → ${fl.dst_addr}:${fl.dst_port ?? ''}`,
    fl.app ? `app: ${fl.app}${fl.category ? ` (${fl.category})` : ''}` : '',
    `${f.proto.toUpperCase()}${fl.service ? ' · ' + fl.service : ''} · ${fmtBytes(fl.octets ?? 0)}${fl.dst_geo?.country ? ' · ' + fl.dst_geo.country : ''}`,
    f.ddos ? '⚠ DDoS' : '',
  ]
    .filter(Boolean)
    .join('<br>');
}

function dirOf(f: LiveFlow): Dir {
  const sh = f.flow.src_geo?.is_home;
  const dh = f.flow.dst_geo?.is_home;
  if (sh && dh) return 'internal';
  if (sh && !dh) return 'out';
  if (!sh && dh) return 'in';
  return 'transit';
}

export default function App() {
  const { flowsRef, home, stats, replay, goLive, connected, lastMsgRef } = useFlows();
  const [speed, setSpeed] = useState(1);
  const [range, setRange] = useState('live'); // default real-time
  const [refresh, setRefresh] = useState('5'); // default auto-refresh 5s
  const [lang, setLang] = useState<Lang>(initialLang); // default English
  const t = STR[lang];
  const resetLayout = () => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('panel.'))
      .forEach((k) => localStorage.removeItem(k));
    location.reload();
  };
  const [showSearch, setShowSearch] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const searchResults = searchQ ? searchPlaces(searchQ) : [];
  // Export the current map as a PNG (preserveDrawingBuffer makes toDataURL work).
  const screenshot = () => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!c) return;
    const a = document.createElement('a');
    a.download = `traffic-map-${Date.now()}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
  };
  // Copy a link that re-opens the current view (?c=lon,lat&z=zoom).
  const shareLink = () => {
    const u = new URL(location.href);
    u.searchParams.set('c', `${viewState.longitude.toFixed(3)},${viewState.latitude.toFixed(3)}`);
    u.searchParams.set('z', viewState.zoom.toFixed(2));
    navigator.clipboard?.writeText(u.toString()).catch(() => {});
  };
  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState<'2d' | '3d'>(
    new URLSearchParams(location.search).get('view') === '3d' ? '3d' : '2d',
  );
  const [showCables, setShowCables] = useState(true);
  const [cableColorful, setCableColorful] = useState(
    () => localStorage.getItem('opnmap.cablecolor') === '1',
  ); // off = single sky-400; on = real per-cable TeleGeography colours
  useEffect(() => localStorage.setItem('opnmap.cablecolor', cableColorful ? '1' : '0'), [cableColorful]);
  const [showRoutes, setShowRoutes] = useState(false); // mtr paths off by default — opt-in overlay (avoids clutter)
  const [showLabels, setShowLabels] = useState(true);
  // Map detail tier — Off (countries + cables only) / Local (regional vector
  // basemap, ~tens of MB) / Country (large vector basemap, hundreds of MB to
  // a few GB). URLs come from /data/topology.json's pmtiles map; if a tier
  // has no URL configured the option is silently skipped at render time.
  const [mapTier, setMapTier] = useState<MapTier>(
    () => (localStorage.getItem('opnmap.mapTier') as MapTier | null) || 'off',
  );
  useEffect(() => localStorage.setItem('opnmap.mapTier', mapTier), [mapTier]);
  const [colorByApp, setColorByApp] = useState(false);
  const [showNight, setShowNight] = useState(false); // day/night terminator, off by default
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('opnmap.theme') === 'light' ? 'light' : 'dark'),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('opnmap.theme', theme);
  }, [theme]);
  const [timeLocal, setTimeLocal] = useState(() => localStorage.getItem('opnmap.tz') !== 'utc');
  const [hour12, setHour12] = useState(() => localStorage.getItem('opnmap.h12') === '1');
  const [unitIEC, setUnitIEC] = useState(() => localStorage.getItem('opnmap.iec') === '1');
  useEffect(() => localStorage.setItem('opnmap.tz', timeLocal ? 'local' : 'utc'), [timeLocal]);
  useEffect(() => localStorage.setItem('opnmap.h12', hour12 ? '1' : '0'), [hour12]);
  useEffect(() => {
    UNIT.base = unitIEC ? 1024 : 1000;
    UNIT.suf = unitIEC ? ['B', 'Ki', 'Mi', 'Gi'] : ['B', 'K', 'M', 'G'];
    localStorage.setItem('opnmap.iec', unitIEC ? '1' : '0');
  }, [unitIEC]);
  const [zoom, setZoom] = useState(1.6);
  const zoomRef = useRef(1.6);
  // Bucketed view center (0.2°) — drives viewport culling of the dense town tier
  // without rebuilding labels on every pixel of a pan.
  const [center, setCenter] = useState<[number, number]>([0, 0]);
  const centerRef = useRef<[number, number]>([0, 0]);
  const [routes, setRoutes] = useState<RoutePath[]>([]);
  const [live, setLive] = useState<LiveStats>({ bps: 0, top_dst: [], top_countries: [] });
  const [apps, setApps] = useState<AppStat[]>([]);
  const [unmatched, setUnmatched] = useState<{ sni: string; count: number }[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  // Sniffnet mode — full analyzer dashboard overlaid on the map (toggled from
  // the brand bar). Persisted so a reload keeps the operator's chosen view.
  const [sniffnet, setSniffnet] = useState(() => localStorage.getItem('opnmap.sniffnet') === '1');
  useEffect(() => localStorage.setItem('opnmap.sniffnet', sniffnet ? '1' : '0'), [sniffnet]);
  const [dir, setDir] = useState<Dir>('all');
  const [minBytes, setMinBytes] = useState(0);
  const [enabled, setEnabled] = useState<Record<ProtoKey, boolean>>(
    () => Object.fromEntries(PROTOS.map(([k]) => [k, true])) as Record<ProtoKey, boolean>,
  );
  const [enabledSvc, setEnabledSvc] = useState<Record<ServiceKey, boolean>>(
    () => Object.fromEntries(SERVICES.map(([k]) => [k, true])) as Record<ServiceKey, boolean>,
  );
  const [showDdos, setShowDdos] = useState(true); // DDoS-flagged flows (red); off = hide them
  const [clockStr, setClockStr] = useState('');
  const [counts, setCounts] = useState({ showing: 0, cableRouted: 0 });
  const [, force] = useState(0); // re-render on async label load / language change (not animation)

  // Stats-panel counts: recompute a couple times a second from the live buffer —
  // decoupled from the 30fps canvas tick (which now lives in <MapCanvas>).
  useEffect(() => {
    const id = setInterval(() => {
      const vis = flowsRef.current.filter(
        (f) =>
          (dir === 'all' || dirOf(f) === dir) &&
          (f.flow.octets ?? 0) >= minBytes &&
          enabledSvc[f.svc] &&
          (showDdos || !f.ddos),
      );
      setCounts({ showing: vis.length, cableRouted: vis.filter((f) => f.snapped).length });
    }, 500);
    return () => clearInterval(id);
  }, [dir, minBytes, enabledSvc, showDdos, flowsRef]);

  useEffect(() => {
    const fmt = () => {
      const s = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12,
        timeZone: timeLocal ? undefined : 'UTC',
      });
      setClockStr(timeLocal ? s : `${s} UTC`);
    };
    fmt();
    const id = setInterval(fmt, 1000);
    return () => clearInterval(id);
  }, [timeLocal, hour12]);

  // Map place-name labels follow the selected UI language.
  useEffect(() => {
    void loadLabels(PLACE_LANG[lang]).then(() => force((n) => n + 1));
  }, [lang]);

  // Network-infra overlay (IXPs + cable landings + PeeringDB facilities) —
  // these are the dots the deep-zoom view replaces roads with.
  useEffect(() => {
    void loadInfra().then(() => force((n) => n + 1));
  }, []);

  // Real measured routes (mtr) — refresh periodically.
  useEffect(() => {
    const load = () => fetchRoutes().then(setRoutes).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  // Time range: 'live' uses the WebSocket; a look-back window queries history
  // and replays it (re-queried on the refresh interval).
  useEffect(() => {
    if (range === 'live') {
      goLive();
      return;
    }
    const load = () =>
      fetch(`/api/history?since_s=${range}&limit=8000`)
        .then((r) => r.json())
        .then((d) => replay(d.flows ?? []))
        .catch(() => {});
    load();
    const sec = Number(refresh);
    if (sec > 0) {
      const id = setInterval(load, sec * 1000);
      return () => clearInterval(id);
    }
  }, [range, refresh, replay, goLive]);

  // The stats window == the selected refresh interval, so the whole panel reflects
  // the range the operator picked (5s … 10m); "off" defaults to 60s. NOTE: at
  // sub-minute windows the throughput gauge can read 0 or spike — NetFlow exports
  // long download flows in ~60s batches, so a short window may straddle a gap or a
  // batch. The top-talker tables are byte totals and stay meaningful at any window.
  const statWin = refresh === '0' ? 60 : Number(refresh);

  // Live traffic stats (throughput, top talkers) — the all-traffic advantage.
  useEffect(() => {
    const win = statWin;
    const pollMs = (refresh === '0' ? 5 : Number(refresh)) * 1000;
    const load = () => {
      fetch(`/api/stats?window=${win}`)
        .then((r) => r.json())
        .then(setLive)
        .catch(() => {});
      fetch(`/api/apps?window=${win}`)
        .then((r) => r.json())
        .then((d) => setApps(d.apps ?? []))
        .catch(() => {});
      fetch('/api/unmatched')
        .then((r) => r.json())
        .then((d) => setUnmatched(d.unmatched ?? []))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, pollMs);
    return () => clearInterval(id);
  }, [refresh, statWin]);

  // Two grids of recent flow-endpoint cells, both refreshed slowly so labels
  // don't churn every animation frame:
  //   • coarse 3°  → drives Natural Earth low-zoom country/state/city labels
  //     (declutter the globe to traffic-touched regions)
  //   • fine 0.1° (~11km) → drives PMTiles street-zoom label gating, so a
  //     deep-zoomed view doesn't try to render every village in OSM CN.
  //     Bucket size MUST match OSM_LABEL_GRID in layers.ts.
  const activeRef = useRef<Set<string>>(new Set());
  const activeFineRef = useRef<Set<string>>(new Set());
  const [activeVer, setActiveVer] = useState(0);
  useEffect(() => {
    const tick = () => {
      const g = new Set<string>();
      const gf = new Set<string>();
      const now = performance.now();
      for (const f of flowsRef.current) {
        if (now - f.born > 60000) continue;
        g.add(`${Math.round(f.dst[0] / 3)},${Math.round(f.dst[1] / 3)}`);
        g.add(`${Math.round(f.src[0] / 3)},${Math.round(f.src[1] / 3)}`);
        gf.add(`${Math.round(f.dst[0] / 0.1)},${Math.round(f.dst[1] / 0.1)}`);
        gf.add(`${Math.round(f.src[0] / 0.1)},${Math.round(f.src[1] / 0.1)}`);
      }
      activeRef.current = g;
      activeFineRef.current = gf;
      setActiveVer((v) => v + 1);
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, []);

  const border = useMemo(() => borderLayer(theme), [theme]);
  // State/province borders fade in when zoomed into a region (gated by 0.1-zoom
  // bucket so it doesn't rebuild every pixel of a zoom gesture).
  const zoomBucket = Math.round(zoom * 10) / 10;
  const states = useMemo(
    () => (showLabels ? stateLayer(theme, zoomBucket) : []),
    [theme, zoomBucket, showLabels],
  );
  // OSM street-level basemap (Protomaps PMTiles) fades in deep-zoomed. Street
  // labels follow the UI language via PMT_LANG (falls through to name:latin if
  // the tileset doesn't include that language).
  const pmtilesUrl = mapTier === 'off' ? undefined : getTopology().pmtiles[mapTier];
  const osm = useMemo(
    () => osmBaseLayer(showLabels, zoomBucket, PMT_LANG[lang], activeFineRef.current, pmtilesUrl),
    [showLabels, zoomBucket, lang, activeVer, pmtilesUrl],
  );
  // Labels rebuild only on zoom / toggle / active-traffic change — not per frame.
  const labels = useMemo(
    () => labelLayers(zoom, showLabels, activeRef.current, activeFineRef.current, center),
    [zoom, showLabels, activeVer, center],
  );
  // Day/night terminator recomputed once a minute (the sun moves slowly).
  const minuteTick = Math.floor(Date.now() / 60000);
  const night = useMemo(() => (showNight ? terminatorLayers(new Date()) : []), [minuteTick, showNight]);
  // Network-infrastructure dots (IXPs / cable landings / PeeringDB facilities).
  // Replaces the OSM road rendering at street zoom — the deep view is now a
  // network map: where your flows actually transit, not roads.
  const infra = useMemo(() => infraLayers(zoomBucket, showLabels), [zoomBucket, showLabels]);
  // Static layers (rebuilt only on their own inputs) handed to the canvas; the
  // animated comet/endpoint layers are built per-frame inside <MapCanvas>.
  const staticLayers = useMemo(
    () => [border, ...states, ...osm, ...night, ...labels, ...infra],
    [border, states, osm, night, labels, infra],
  );
  const homePos: [number, number] = [home.lon, home.lat];

  // MUST be stable across renders — a fresh object each frame makes deck.gl
  // reset the camera 30x/sec and the globe becomes undraggable.
  const initialViewState = useMemo(() => {
    const q = new URLSearchParams(location.search);
    const c = q.get('c')?.split(',').map(Number);
    const z = q.get('z');
    return {
      longitude: c?.[0] ?? home.lon ?? 0,
      latitude: c?.[1] ?? home.lat ?? 0,
      zoom: z ? Number(z) : mode === '3d' ? 0.6 : 1.6,
      pitch: 0,
      bearing: 0,
    };
  }, [mode, home.lon, home.lat]);

  // Controlled viewState (enables zoom buttons, go-home, search fly-to).
  type VS = { longitude: number; latitude: number; zoom: number; pitch: number; bearing: number };
  const [viewState, setViewState] = useState<VS>(initialViewState as VS);
  useEffect(() => setViewState(initialViewState as VS), [mode]); // re-center on 2D/3D switch
  useEffect(() => {
    // recenter once the gateway's location arrives from /api/config
    if (home.lat || home.lon) setViewState((v) => ({ ...v, longitude: home.lon, latitude: home.lat }));
  }, [home.lat, home.lon]);
  const flyTo = (lon: number, lat: number, zoom?: number) =>
    setViewState((v) => ({
      ...v,
      longitude: lon,
      latitude: lat,
      zoom: zoom ?? v.zoom,
      transitionDuration: 1300,
      transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }),
    }) as VS);
  const zoomBy = (d: number) =>
    setViewState((v) => ({ ...v, zoom: Math.max(0, Math.min(18, v.zoom + d)), transitionDuration: 250 }) as VS);
  const goHome = () => flyTo(home.lon, home.lat, Math.max(viewState.zoom, mode === '3d' ? 1.6 : 3));
  // Track zoom (for label level-of-detail) without re-rendering 30×/s.
  const handleViewState = (vs: VS) => {
    if (Math.abs(vs.zoom - zoomRef.current) > 0.15) {
      zoomRef.current = vs.zoom;
      setZoom(vs.zoom);
    }
    const cl = Math.round(vs.longitude * 5) / 5;
    const ca = Math.round(vs.latitude * 5) / 5;
    if (cl !== centerRef.current[0] || ca !== centerRef.current[1]) {
      centerRef.current = [cl, ca];
      setCenter([cl, ca]);
    }
    setViewState(vs);
  };

  // Timeline window follows the selected range (live → last hour). Brushing a
  // sub-window fetches that absolute slice and replays it.
  const tlWindow = range === 'live' ? 3600 : Number(range);
  const onBrush = (from: number, to: number) => {
    fetch(`/api/history?from_s=${from}&to_s=${to}&limit=8000`)
      .then((r) => r.json())
      .then((d) => replay(d.flows ?? []))
      .catch(() => {});
  };

  // Connection / freshness health for the brand dot.
  const idleS = Math.round((performance.now() - lastMsgRef.current) / 1000);
  const health =
    range !== 'live'
      ? { c: '#38bdf8', t: 'replay / 回放' }
      : !connected
        ? { c: '#ef4444', t: 'disconnected / 断开' }
        : idleS > 15
          ? { c: '#f59e0b', t: `stale ${idleS}s / ${idleS}秒无数据` }
          : { c: '#22c55e', t: 'live / 实时' };

  return (
    <div className="root">
      {sniffnet && (
        <SniffnetView
          live={live}
          apps={apps}
          flowsRef={flowsRef}
          stats={stats}
          statWin={statWin}
          lang={lang}
          onClose={() => setSniffnet(false)}
        />
      )}
      <MapCanvas
        flowsRef={flowsRef}
        staticLayers={staticLayers}
        routes={routes}
        home={homePos}
        view={mode}
        theme={theme}
        viewState={viewState}
        onViewStateChange={handleViewState}
        paused={paused}
        speed={speed}
        dir={dir}
        minBytes={minBytes}
        enabled={enabled}
        enabledSvc={enabledSvc}
        showDdos={showDdos}
        colorByApp={colorByApp}
        showCables={showCables}
        cableColorful={cableColorful}
        showRoutes={showRoutes}
        tooltip={flowTip}
      />

      <div className="panel brand">
        <span className="dot" style={{ background: health.c, boxShadow: `0 0 8px ${health.c}` }} title={health.t} />
        <h1>{t.brand}</h1>
        <span className="clock">{clockStr}</span>
        <button className={`btn ${mode === '3d' ? 'active' : ''}`} onClick={() => setMode(mode === '2d' ? '3d' : '2d')}>
          {mode === '2d' ? '2D' : '3D'}
        </button>
        <button className="btn" title={t.fullscreen} onClick={toggleFullscreen}>
          ⛶
        </button>
        <button
          className={`btn sniff ${sniffnet ? 'active' : ''}`}
          title="Sniffnet"
          onClick={() => setSniffnet((s) => !s)}
        >
          📡
        </button>
        <select
          className="btn lang"
          value={lang}
          title="Language / 语言"
          onChange={(e) => {
            const l = e.target.value as Lang;
            setLang(l);
            saveLang(l);
          }}
        >
          {(Object.keys(LANG_NAMES) as Lang[]).map((l) => (
            <option key={l} value={l}>
              {LANG_NAMES[l]}
            </option>
          ))}
        </select>
      </div>

      <div className="panel timectl">
        <select value={range} onChange={(e) => setRange(e.target.value)} title={t.timeRange}>
          <option value="live">{t.live}</option>
          <option value="300">{t.last5m}</option>
          <option value="1800">{t.last30m}</option>
          <option value="3600">{t.last1h}</option>
          <option value="43200">{t.last12h}</option>
          <option value="86400">{t.last1d}</option>
          <option value="2592000">{t.last30d}</option>
          <option value="31536000">{t.last1y}</option>
        </select>
        <select value={refresh} onChange={(e) => setRefresh(e.target.value)} title={t.autoRefresh}>
          <option value="0">{t.refreshOff}</option>
          <option value="5">5s</option>
          <option value="10">10s</option>
          <option value="30">30s</option>
          <option value="60">1m</option>
          <option value="300">5m</option>
          <option value="600">10m</option>
        </select>
      </div>

      <div className="panel speed">
        <button className="btn" onClick={() => setPaused((p) => !p)} title={paused ? t.play : t.pause}>
          {paused ? '▶' : '⏸'}
        </button>
        <span className="lbl">{t.speed}</span>
        {SPEEDS.map((s) => (
          <button key={s} className={`btn ${s === speed ? 'active' : ''}`} onClick={() => setSpeed(s)}>
            {s}x
          </button>
        ))}
      </div>

      <DraggablePanel
        id="controls"
        className="controls"
        title={t.features}
        maxBody="calc(100vh - 170px)"
        extra={
          <button className="pb-btn" onClick={() => setShowSettings((s) => !s)} title={t.settings}>
            ⚙
          </button>
        }
      >
        <div className="lbl2">{t.protocol}</div>
        {PROTOS.map(([k, label]) => (
          <div className="row" key={k}>
            <span className="proto">
              <span className="swatch" style={{ background: `rgb(${PROTO_COLOR[k].join(',')})` }} />
              {label ?? t.other}
            </span>
            <span
              className={`toggle ${enabled[k] ? 'on' : ''}`}
              onClick={() => setEnabled((e) => ({ ...e, [k]: !e[k] }))}
            />
          </div>
        ))}
        <div className="lbl2">{t.service}</div>
        {SERVICES.map(([k, label]) => (
          <div className="row" key={k}>
            <span className="proto">
              <span className="swatch" style={{ background: 'rgba(148,163,184,.5)' }} />
              {label ?? t.otherSvc}
            </span>
            <span
              className={`toggle ${enabledSvc[k] ? 'on' : ''}`}
              onClick={() => setEnabledSvc((e) => ({ ...e, [k]: !e[k] }))}
            />
          </div>
        ))}
        <div className="lbl2">{t.anomaly}</div>
        <div className="row">
          <span className="proto">
            <span className="swatch" style={{ background: 'rgb(239,68,68)' }} />
            DDoS
          </span>
          <span className={`toggle ${showDdos ? 'on' : ''}`} onClick={() => setShowDdos((v) => !v)} />
        </div>

        {showSettings && (
          <div className="settings">
            <div className="lbl2">{t.direction}</div>
            <div className="seg">
              {DIRS.map(([d, label]) => (
                <button key={d} className={`segbtn ${dir === d ? 'active' : ''}`} onClick={() => setDir(d)}>
                  {t[label]}
                </button>
              ))}
            </div>
            <div className="lbl2">{t.minBytes}</div>
            <div className="seg">
              {BYTES.map((b) => (
                <button key={b} className={`segbtn ${minBytes === b ? 'active' : ''}`} onClick={() => setMinBytes(b)}>
                  {b === 0 ? t.all : b >= 1e6 ? '1M' : b >= 1e3 ? `${b / 1000}K` : `${b}`}
                </button>
              ))}
            </div>
            <div className="lbl2">{t.placeLabels}</div>
            <div className="seg">
              {(['off', 'local', 'country'] as MapTier[])
                .filter((tier) => tier === 'off' || getTopology().pmtiles[tier])
                .map((tier) => (
                  <button key={tier} className={`segbtn ${mapTier === tier ? 'active' : ''}`} onClick={() => setMapTier(tier)}>
                    {tier === 'off' ? t.all : tier === 'local' ? 'Local' : 'Country'}
                  </button>
                ))}
            </div>
            <div className="row">
              <span className="proto">
                <span className="swatch" style={{ background: 'rgb(56,189,248)' }} />
                {t.cables}
              </span>
              <span className={`toggle ${showCables ? 'on' : ''}`} onClick={() => setShowCables((v) => !v)} />
            </div>
            <div className="row">
              <span className="proto">
                <span className="swatch" style={{ background: 'linear-gradient(90deg,#ed1b2c,#97b93c,#458bca)' }} />
                {t.cableColor}
              </span>
              <span className={`toggle ${cableColorful ? 'on' : ''}`} onClick={() => setCableColorful((v) => !v)} />
            </div>
            <div className="row">
              <span className="proto">
                <span className="swatch" style={{ background: 'rgb(125,185,232)' }} />
                {t.routes}
              </span>
              <span className={`toggle ${showRoutes ? 'on' : ''}`} onClick={() => setShowRoutes((v) => !v)} />
            </div>
            <div className="row">
              <span className="proto">
                <span className="swatch" style={{ background: 'rgb(226,232,240)' }} />
                {t.placeLabels}
              </span>
              <span className={`toggle ${showLabels ? 'on' : ''}`} onClick={() => setShowLabels((v) => !v)} />
            </div>
            <div className="row">
              <span className="proto">
                <span className="swatch" style={{ background: 'rgb(239,68,68)' }} />
                {t.colorByApp}
              </span>
              <span className={`toggle ${colorByApp ? 'on' : ''}`} onClick={() => setColorByApp((v) => !v)} />
            </div>
            <div className="row">
              <span className="proto">
                <span className="swatch" style={{ background: 'rgb(30,41,59)' }} />
                {t.dayNight}
              </span>
              <span className={`toggle ${showNight ? 'on' : ''}`} onClick={() => setShowNight((v) => !v)} />
            </div>
            <div className="row">
              <span className="proto">{t.theme}</span>
              <button
                className="segbtn"
                onClick={() => setTheme((v) => (v === 'dark' ? 'light' : 'dark'))}
              >
                {theme === 'light' ? '☀️ Light' : '🌙 Dark'}
              </button>
            </div>
            <div className="lbl2">{t.time}</div>
            <div className="seg">
              <button className={`segbtn ${timeLocal ? 'active' : ''}`} onClick={() => setTimeLocal(true)}>{t.local}</button>
              <button className={`segbtn ${!timeLocal ? 'active' : ''}`} onClick={() => setTimeLocal(false)}>UTC</button>
              <button className={`segbtn ${!hour12 ? 'active' : ''}`} onClick={() => setHour12(false)}>24h</button>
              <button className={`segbtn ${hour12 ? 'active' : ''}`} onClick={() => setHour12(true)}>12h</button>
            </div>
            <div className="lbl2">{t.units}</div>
            <div className="seg">
              <button className={`segbtn ${!unitIEC ? 'active' : ''}`} onClick={() => setUnitIEC(false)}>KB MB GB</button>
              <button className={`segbtn ${unitIEC ? 'active' : ''}`} onClick={() => setUnitIEC(true)}>KiB MiB GiB</button>
            </div>
            <div className="lbl2">{t.speed}</div>
            <div className="seg">
              <button className={`segbtn ${speed === 0.5 ? 'active' : ''}`} onClick={() => setSpeed(0.5)}>{t.slow}</button>
              <button className={`segbtn ${speed === 1 ? 'active' : ''}`} onClick={() => setSpeed(1)}>{t.normal}</button>
              <button className={`segbtn ${speed === 2 ? 'active' : ''}`} onClick={() => setSpeed(2)}>{t.fast}</button>
            </div>
            <div className="row">
              <span className="proto">{t.resetLayout}</span>
              <button className="segbtn" onClick={resetLayout} title={t.resetLayout}>↺</button>
            </div>
          </div>
        )}

        <div className="stats">
          <div>
            {t.rate} <b>{stats.rate}</b> flows/s
          </div>
          <div>
            {t.showing} <b>{counts.showing}</b>
          </div>
          <div>
            {t.cableRouted} <b>{counts.cableRouted}</b>
          </div>
          <div>
            {t.total} <b>{stats.total}</b>
          </div>
        </div>
      </DraggablePanel>

      <DraggablePanel id="livestats" className="livestats" title={t.statsPanel} maxBody="calc(100vh - 80px)">
        <div className="bw">{fmtBps(live.bps)}</div>
        <div className="bwlbl">{t.bandwidth} {fmtWin(statWin)}</div>
        {(live.bps_in != null || live.bps_out != null) && (
          <div className="bwio">↓ {fmtBps(live.bps_in ?? 0)} · ↑ {fmtBps(live.bps_out ?? 0)}</div>
        )}
        {live.top_countries.length > 0 && (
          <>
            <h3>{t.dstCountries} · {fmtWin(statWin)}</h3>
            {live.top_countries.map((c) => {
              const max = live.top_countries[0]?.bytes || 1;
              return (
                <div className="bar" key={c.country}>
                  <span className="bar-l"><Flag cc={c.country} />{c.country}</span>
                  <span className="bar-track">
                    <span className="bar-fill" style={{ width: `${(c.bytes / max) * 100}%` }} />
                  </span>
                  <span className="bar-v">{fmtBytes(c.bytes)}</span>
                </div>
              );
            })}
          </>
        )}
        {apps.length > 0 && (
          <>
            <h3>{t.appsPanel} · {fmtWin(statWin)}</h3>
            {apps.slice(0, 8).map((a) => {
              const max = apps[0]?.bytes || 1;
              return (
                <div className="bar" key={a.app}>
                  <span className="bar-l" title={a.category ?? ''}>{a.app}</span>
                  <span className="bar-track">
                    <span className={`bar-fill cat-${a.category ?? 'other'}`} style={{ width: `${(a.bytes / max) * 100}%` }} />
                  </span>
                  <span className="bar-v">{fmtBytes(a.bytes)}</span>
                </div>
              );
            })}
          </>
        )}
        {live.top_dst.length > 0 && (
          <>
            <h3>{t.topDst}</h3>
            {live.top_dst.slice(0, 6).map((d) => (
              <div className="talk" key={d.ip}>
                <span className="talk-ip">{d.ip}</span>
                <span className="talk-c"><Flag cc={d.country} />{d.country ?? '-'}</span>
                <span className="talk-b">{fmtBytes(d.bytes)}</span>
              </div>
            ))}
          </>
        )}
        {(live.top_src?.length ?? 0) > 0 && (
          <>
            <h3>{t.topSrc}</h3>
            {live.top_src!.slice(0, 5).map((s) => (
              <div className="talk" key={s.ip}>
                <span className="talk-ip">{s.ip}</span>
                <span className="talk-b">{fmtBytes(s.bytes)}</span>
              </div>
            ))}
          </>
        )}
        {(live.top_services?.length ?? 0) > 0 && (
          <>
            <h3>{t.topServices ?? 'Top services'}</h3>
            {live.top_services!.slice(0, 6).map((s) => (
              <div className="talk" key={s.service}>
                <span className="talk-ip">{s.service}</span>
                <span className="talk-b">{fmtBytes(s.bytes)}</span>
              </div>
            ))}
          </>
        )}
        {(live.top_hosts?.length ?? 0) > 0 && (
          <>
            <h3>{t.topHosts ?? 'Top hosts'}</h3>
            {live.top_hosts!.slice(0, 6).map((h) => (
              <div className="talk" key={`${h.label}|${h.asn ?? ''}|${h.country ?? ''}`}>
                <span className="talk-ip" title={h.asn ? `AS${h.asn}` : ''}>{h.label}</span>
                <span className="talk-c"><Flag cc={h.country} />{h.country ?? '-'}</span>
                <span className="talk-b">{fmtBytes(h.bytes)}</span>
              </div>
            ))}
          </>
        )}
        {unmatched.length > 0 && (
          <>
            <h3>{t.unmatchedPanel}</h3>
            {unmatched.slice(0, 6).map((u) => (
              <div className="talk" key={u.sni}>
                <span className="talk-ip" title={u.sni}>{u.sni}</span>
                <span className="talk-b">{u.count}</span>
              </div>
            ))}
          </>
        )}
      </DraggablePanel>

      {/* Right-side control rail (zoom.earth-style) */}
      <div className="rail">
        <button className="rbtn" onClick={() => zoomBy(1)} data-tip={t.zoomIn} aria-label={t.zoomIn}>
          <Icon name="zoomIn" />
        </button>
        <button className="rbtn" onClick={() => zoomBy(-1)} data-tip={t.zoomOut} aria-label={t.zoomOut}>
          <Icon name="zoomOut" />
        </button>
        <button className="rbtn" onClick={goHome} data-tip={t.goHome} aria-label={t.goHome}>
          <Icon name="home" />
        </button>
        <button className={`rbtn ${showSearch ? 'on' : ''}`} onClick={() => setShowSearch((s) => !s)} data-tip={t.search} aria-label={t.search}>
          <Icon name="search" />
        </button>
        <button className={`rbtn ${showSettings ? 'on' : ''}`} onClick={() => setShowSettings((s) => !s)} data-tip={t.settings} aria-label={t.settings}>
          <Icon name="settings" />
        </button>
        <button className={`rbtn ${showInfo ? 'on' : ''}`} onClick={() => setShowInfo((s) => !s)} data-tip={t.about} aria-label={t.about}>
          <Icon name="info" />
        </button>
        <button className="rbtn" onClick={screenshot} data-tip={t.screenshot} aria-label={t.screenshot}>
          <Icon name="camera" />
        </button>
        <button className="rbtn" onClick={shareLink} data-tip={t.shareLink} aria-label={t.shareLink}>
          <Icon name="share" />
        </button>
      </div>

      {showSearch && (
        <div className="panel searchbox">
          <input
            autoFocus
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder={`${t.search}…`}
          />
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((r, i) => (
                <div
                  key={i}
                  className="search-item"
                  onClick={() => {
                    flyTo(r.position[0], r.position[1], 4.5);
                    setShowSearch(false);
                    setSearchQ('');
                  }}
                >
                  {r.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showInfo && (
        <div className="panel infobox">
          <div className="ib-head">
            <b>{t.legend}</b>
            <button className="pb-btn" onClick={() => setShowInfo(false)}>✕</button>
          </div>
          <div className="ib-legend">
            {Object.entries(PROTO_COLOR).map(([k, c]) => (
              <span className="lg" key={k}>
                <i style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }} />
                {k.toUpperCase()}
              </span>
            ))}
            <span className="lg">
              <i style={{ background: 'rgb(239,68,68)' }} />
              DDoS
            </span>
            <span className="lg">
              <i style={{ background: 'rgb(56,189,248)' }} />
              {t.cables}
            </span>
            <span className="lg">
              <i style={{ background: '#fff', border: '1px solid #888' }} />
              home
            </span>
          </div>
          <div className="ib-about">
            Zero-CDN traffic map · Natural Earth · TeleGeography · MaxMind GeoLite2
          </div>
          <a href="https://github.com/mozlet/visualized-traffic-map" target="_blank" rel="noreferrer">
            github.com/mozlet/visualized-traffic-map
          </a>
        </div>
      )}

      <Timeline windowS={tlWindow} label={t.timeline} timeLocal={timeLocal} hour12={hour12} onBrush={onBrush} />
    </div>
  );
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}
