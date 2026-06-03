import { useCallback, useEffect, useRef, useState } from 'react';
import { flowPath, loadCables } from './cables';
import { loadHubs } from './hubs';
import { loadLandmass, landmassReady, onLand } from './landmass';
import type { Flow, HomeConfig, LiveFlow, ProtoKey, ServiceKey } from './types';

const MAX_FLOWS = 4000;
const DDOS_WINDOW_MS = 60_000;
const DDOS_SRC_THRESHOLD = 30; // distinct sources to one dst within the window

// Visual density ∝ bytes: one comet per ~PARTICLE_BYTES so a heavy flow becomes a
// sustained stream and a trivial flow a single dot — the map then reflects real
// throughput, not flow count. Comets stream over the flow's active span (bounded)
// so a sustained download reads as a continuous river from its source.
const PARTICLE_BYTES = 4_000_000;
const PARTICLE_MAX = 64;
const STREAM_MIN_MS = 1500;
const STREAM_MAX_MS = 24_000;

// Rolling distinct-source count per destination — a volumetric/DDoS indicator.
const dstSources = new Map<string, Map<string, number>>();
function ddosScore(dst: string, src: string, now: number): boolean {
  let m = dstSources.get(dst);
  if (!m) dstSources.set(dst, (m = new Map()));
  m.set(src, now);
  for (const [s, t] of m) if (now - t > DDOS_WINDOW_MS) m.delete(s);
  return m.size > DDOS_SRC_THRESHOLD;
}

// Home coordinate (set from /api/config). LAN hosts all geolocate here, so we
// fan them out deterministically by IP to make internal traffic visible.
// Overwritten from /api/config (HOME_LAT/HOME_LON). 0,0 until then.
let HOME_REF: [number, number] = [0, 0];

function hashOffset(ip: string): [number, number] {
  let h = 0;
  for (let i = 0; i < ip.length; i++) h = (h * 31 + ip.charCodeAt(i)) >>> 0;
  const r = 0.02 + ((h >> 9) % 100) / 100 * 0.07; // 0.02..0.09 deg ≈ 2..10 km, city-scale
  const base = h % 360;
  // LAN/loopback hosts all geolocate to the operator's real home site (wherever
  // that is in the world). Scatter them only a few km — within the home CITY — so
  // multiple internal hosts stay distinguishable yet sit at their true location,
  // not 20–80 km out in the countryside or sea. A coastal home would still drop a
  // few dots in the water, so rotate the angle deterministically (golden step) to
  // the first on-land position. Falls back to the raw ring before landmass loads.
  if (landmassReady()) {
    for (let k = 0; k < 24; k++) {
      const ang = (((base + k * 137.5) % 360) * Math.PI) / 180;
      const p: [number, number] = [HOME_REF[0] + Math.cos(ang) * r, HOME_REF[1] + Math.sin(ang) * r];
      if (onLand(p)) return [Math.cos(ang) * r, Math.sin(ang) * r];
    }
  }
  const ang = (base * Math.PI) / 180;
  return [Math.cos(ang) * r, Math.sin(ang) * r];
}

export function protoKey(p?: number | null): ProtoKey {
  switch (p) {
    case 6:
      return 'tcp';
    case 17:
      return 'udp';
    case 1:
      return 'icmp';
    case 58:
      return 'icmp6';
    case 2:
      return 'igmp';
    case 47:
      return 'gre';
    case 50: // ESP
    case 51: // AH (both IPsec)
      return 'esp';
    case 132:
      return 'sctp';
    case 89:
      return 'ospf';
    default:
      return 'other';
  }
}

// Coarse application/service from the well-known port on either end.
export function serviceKey(sport?: number | null, dport?: number | null, proto?: number | null): ServiceKey {
  const has = (n: number) => sport === n || dport === n;
  if (has(443)) return proto === 17 ? 'quic' : 'https';
  if (has(80) || has(8080)) return 'http';
  if (has(53)) return 'dns';
  if (has(22)) return 'ssh';
  return 'svc';
}

function toLive(flow: Flow, born: number): LiveFlow | null {
  const s = flow.src_geo;
  const d = flow.dst_geo;
  if (!s || !d || s.lat == null || d.lat == null) return null;
  // Fan LAN hosts out around home so internal (LAN↔LAN) traffic is visible.
  const src: [number, number] = s.is_home
    ? [HOME_REF[0] + hashOffset(flow.src_addr)[0], HOME_REF[1] + hashOffset(flow.src_addr)[1]]
    : [s.lon, s.lat];
  const dst: [number, number] = d.is_home
    ? [HOME_REF[0] + hashOffset(flow.dst_addr)[0], HOME_REF[1] + hashOffset(flow.dst_addr)[1]]
    : [d.lon, d.lat];
  if (src[0] === dst[0] && src[1] === dst[1]) return null; // truly degenerate
  const octets = flow.octets ?? 0;

  // ALL flow paths go through the data-driven segmentPath (continent + cable
  // graph). mtr's measured hop polyline must NOT be used as flow geometry —
  // mtr hop coords are MaxMind AS-default PoPs (a transit/cloud ASN's HQ city,
  // not the actual edge serving you) plus trailing private-IP hops, so
  // painting them as a literal polyline draws bogus jumps (an SJC-bound flow
  // truncated at the AS's HQ city, a Bristol flow detouring through Florida).
  // routes.ts still computes routeMap for the optional /routes overlay — it
  // doesn't drive a flow's path here.
  const r = flowPath(src, dst);
  const path = r.path;
  const snapped = r.snapped;
  const real = false;

  const ddos = ddosScore(flow.dst_addr, flow.src_addr, born);

  return {
    flow,
    born,
    src,
    dst,
    path,
    snapped,
    real,
    ddos,
    proto: protoKey(flow.protocol),
    svc: serviceKey(flow.src_port, flow.dst_port, flow.protocol),
    // Bandwidth-weighted: big flows are visibly thicker.
    width: Math.max(0.6, Math.min(9, Math.log10(octets + 1) * 1.3 - 0.2)),
  };
}

export interface Stats {
  rate: number; // flows/sec
  total: number;
}

const REPLAY_MS = 15000; // spread a historical window over this playback time

// Maintains a live, age-pruned buffer of flows in a ref (no re-render per
// message). Supports historical replay (live WS gated off during playback).
export function useFlows() {
  const flowsRef = useRef<LiveFlow[]>([]);
  const totalRef = useRef(0);
  const rateWindow = useRef<number[]>([]);
  const liveRef = useRef(true);
  const replaySeq = useRef(0);
  const [home, setHome] = useState<HomeConfig>({ lat: 0, lon: 0 });
  const [stats, setStats] = useState<Stats>({ rate: 0, total: 0 });
  const [connected, setConnected] = useState(false);
  const lastMsgRef = useRef(performance.now());

  const push = useCallback((flow: Flow) => {
    const base = toLive(flow, performance.now());
    if (!base) return;
    const buf = flowsRef.current;
    // Spawn comets ∝ bytes, staggered across the flow's real active span so heavy
    // sources stream continuously. One toLive() call (DDoS scored once), then clones.
    const octets = flow.octets ?? 0;
    const n = Math.max(1, Math.min(PARTICLE_MAX, Math.round(octets / PARTICLE_BYTES)));
    const durMs =
      flow.flow_start != null && flow.flow_finish != null
        ? Math.abs(flow.flow_finish - flow.flow_start)
        : 0;
    const spread = n <= 1 ? 0 : Math.max(STREAM_MIN_MS, Math.min(STREAM_MAX_MS, durMs || n * 200));
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      buf.push(i === 0 ? base : { ...base, born: t0 + (i / n) * spread });
    }
    if (buf.length > MAX_FLOWS) buf.splice(0, buf.length - MAX_FLOWS);
    totalRef.current += 1;
    rateWindow.current.push(performance.now());
  }, []);

  // Replay a historical window: gate off live, stagger flows by recv_sec.
  const replay = useCallback(
    (flows: Flow[]) => {
      liveRef.current = false;
      flowsRef.current = [];
      const seq = ++replaySeq.current;
      if (!flows.length) return;
      const sorted = [...flows].sort((a, b) => (a.recv_sec ?? 0) - (b.recv_sec ?? 0));
      const min = sorted[0].recv_sec ?? 0;
      const max = sorted[sorted.length - 1].recv_sec ?? min + 1;
      const span = Math.max(1, max - min);
      for (const f of sorted) {
        const delay = (((f.recv_sec ?? min) - min) / span) * REPLAY_MS;
        setTimeout(() => {
          if (replaySeq.current === seq) push(f);
        }, delay);
      }
    },
    [push],
  );

  const goLive = useCallback(() => {
    replaySeq.current++; // cancel any pending replay
    liveRef.current = true;
    flowsRef.current = [];
    fetch('/api/recent?n=400')
      .then((r) => r.json())
      .then((r) => (r.flows ?? []).reverse().forEach((f: Flow) => push(f)))
      .catch(() => {});
  }, [push]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;

    (async () => {
      await Promise.all([loadCables(), loadHubs(), loadLandmass()]); // ready before we build any flow paths
      // Drop any flows goLive() pushed before the data was ready (their paths are
      // provisional straight lines); the recent fetch below refills them correctly.
      flowsRef.current = [];
      try {
        const cfg = await (await fetch('/api/config')).json();
        if (cfg.home) {
          setHome(cfg.home);
          HOME_REF = [cfg.home.lon, cfg.home.lat];
        }
      } catch (e) {
        console.warn('config', e);
      }
      try {
        const r = await (await fetch('/api/recent?n=400')).json();
        if (liveRef.current) (r.flows ?? []).reverse().forEach((f: Flow) => push(f));
      } catch (e) {
        console.warn('recent', e);
      }
      connect();
    })();

    function connect() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        lastMsgRef.current = performance.now();
        if (!liveRef.current) return; // paused for historical replay
        try {
          push(JSON.parse(ev.data));
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) setTimeout(connect, 2000);
      };
    }

    const statsTimer = setInterval(() => {
      const now = performance.now();
      const w = rateWindow.current;
      while (w.length && now - w[0] > 1000) w.shift();
      setStats({ rate: w.length, total: totalRef.current });
    }, 500);

    return () => {
      closed = true;
      clearInterval(statsTimer);
      ws?.close();
    };
  }, [push]);

  return { flowsRef, home, stats, replay, goLive, connected, lastMsgRef };
}
