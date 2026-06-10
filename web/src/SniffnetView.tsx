// Full-screen "Sniffnet mode" — a complete network-analyzer dashboard overlaid
// on the map, toggled from the top-left brand bar. Replicates sniffnet's three
// pages (Overview / Inspect / Notifications) entirely from the data the API
// already serves: /api/stats (live), /api/apps (apps), and the live flow buffer
// (flowsRef). Zero new deps — charts are inline SVG.
//
// Tribute & attribution: the layout, page structure, and the bundled country
// flags are an homage to Sniffnet by Giuliano Bellini (@GyulyVGC) —
// https://github.com/GyulyVGC/sniffnet (GPL-3.0). This is an independent
// React/TypeScript reimplementation of the idea, not a port of its Rust/Iced
// code. Heartfelt thanks to the Sniffnet author for the inspiration. 📡
import { useEffect, useRef, useState } from 'react';
import { PROTO_COLOR, CATEGORY_COLOR, hex } from './colors';
import type { LiveFlow, ProtoKey } from './types';
import type { Lang } from './i18n';

interface LiveStats {
  bps: number;
  bps_in?: number;
  bps_out?: number;
  top_dst: { ip: string; country: string | null; bytes: number }[];
  top_countries: { country: string; bytes: number }[];
  top_src?: { ip: string; bytes: number }[];
  top_services?: { service: string; bytes: number }[];
}
interface AppStat {
  app: string;
  category: string | null;
  bytes: number;
  flows: number;
}

type Tab = 'overview' | 'inspect' | 'notifications';

// Sniffnet-specific UI labels. en + zh authored; everything else falls back to
// English (the rest of the app's 12-language table is untouched).
const L: Record<string, Record<string, string>> = {
  overview: { en: 'Overview', zh: '总览', 'zh-Hant': '總覽', ja: '概要', ko: '개요', ru: 'Обзор', es: 'Resumen', fr: 'Aperçu', de: 'Übersicht', pt: 'Visão', it: 'Panoramica', ar: 'نظرة عامة' },
  inspect: { en: 'Inspect', zh: '连接', 'zh-Hant': '連接', ja: '検査', ko: '검사', ru: 'Соединения', es: 'Inspeccionar', fr: 'Inspecter', de: 'Prüfen', pt: 'Inspecionar', it: 'Ispeziona', ar: 'فحص' },
  notifications: { en: 'Alerts', zh: '告警', 'zh-Hant': '告警', ja: '通知', ko: '알림', ru: 'Оповещения', es: 'Alertas', fr: 'Alertes', de: 'Warnungen', pt: 'Alertas', it: 'Avvisi', ar: 'تنبيهات' },
  throughput: { en: 'Throughput', zh: '吞吐量', 'zh-Hant': '吞吐量' },
  download: { en: 'Download', zh: '下行', 'zh-Hant': '下行' },
  upload: { en: 'Upload', zh: '上行', 'zh-Hant': '上行' },
  protocols: { en: 'Protocols', zh: '协议', 'zh-Hant': '協議' },
  apps: { en: 'Applications', zh: '应用', 'zh-Hant': '應用' },
  topHosts: { en: 'Top hosts', zh: 'Top 主机', 'zh-Hant': 'Top 主機' },
  topCountries: { en: 'Top countries', zh: 'Top 国家', 'zh-Hant': 'Top 國家' },
  connections: { en: 'Connections', zh: '连接数', 'zh-Hant': '連接數' },
  activeConns: { en: 'Active connections', zh: '活动连接', 'zh-Hant': '活動連接' },
  filter: { en: 'Filter src / dst / app / port…', zh: '筛选 源/目的/应用/端口…', 'zh-Hant': '篩選 源/目的/應用/端口…' },
  src: { en: 'Source', zh: '源', 'zh-Hant': '源' },
  dst: { en: 'Destination', zh: '目的', 'zh-Hant': '目的' },
  proto: { en: 'Proto', zh: '协议', 'zh-Hant': '協議' },
  app: { en: 'App / Service', zh: '应用/服务', 'zh-Hant': '應用/服務' },
  country: { en: 'Country', zh: '国家', 'zh-Hant': '國家' },
  bytes: { en: 'Bytes', zh: '字节', 'zh-Hant': '位元組' },
  packets: { en: 'Packets', zh: '包', 'zh-Hant': '封包' },
  age: { en: 'Age', zh: '时间', 'zh-Hant': '時間' },
  noConns: { en: 'No connections in the live buffer.', zh: '实时缓冲区暂无连接。', 'zh-Hant': '即時緩衝區暫無連接。' },
  noAlerts: { en: 'No alerts. Live traffic looks nominal.', zh: '无告警，实时流量正常。', 'zh-Hant': '無告警，即時流量正常。' },
  ddosAlert: { en: 'DDoS — many sources flooding', zh: 'DDoS — 多源涌入', 'zh-Hant': 'DDoS — 多源湧入' },
  bigFlow: { en: 'Large transfer', zh: '大流量传输', 'zh-Hant': '大流量傳輸' },
  allProto: { en: 'All', zh: '全部', 'zh-Hant': '全部' },
  close: { en: 'Back to map', zh: '返回地图', 'zh-Hant': '返回地圖' },
  in: { en: 'in', zh: '入', 'zh-Hant': '入' },
  out: { en: 'out', zh: '出', 'zh-Hant': '出' },
  local: { en: 'internal', zh: '内网', 'zh-Hant': '內網' },
};
const tr = (k: string, lang: Lang) => L[k]?.[lang] ?? L[k]?.en ?? k;

const fmtBytes = (b: number): string => {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + 'G';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + 'M';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + 'K';
  return b + 'B';
};
const fmtBps = (b: number): string => {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' Gbps';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' Mbps';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' Kbps';
  return b + ' bps';
};
const fmtAgo = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + (s % 60) + 's';
};

const Flag = ({ cc }: { cc?: string | null }) =>
  cc ? (
    <img className="flag" src={`/flags/${cc.toLowerCase()}.svg`} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
  ) : null;

type Dir = 'in' | 'out' | 'internal' | 'transit';
const dirOf = (f: LiveFlow): Dir => {
  const sh = f.flow.src_geo?.is_home;
  const dh = f.flow.dst_geo?.is_home;
  if (sh && dh) return 'internal';
  if (sh && !dh) return 'out';
  if (!sh && dh) return 'in';
  return 'transit';
};
const DIR_ARROW: Record<Dir, string> = { in: '↓', out: '↑', internal: '↔', transit: '⇢' };

interface Props {
  live: LiveStats;
  apps: AppStat[];
  flowsRef: React.RefObject<LiveFlow[]>;
  stats: { rate: number; total: number };
  statWin: number;
  lang: Lang;
  onClose: () => void;
}

// Rolling throughput history for the area chart, kept across renders.
interface Sample { t: number; in: number; out: number }

export function SniffnetView({ live, apps, flowsRef, stats, statWin, lang, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [, force] = useState(0);
  const histRef = useRef<Sample[]>([]);

  // Sample throughput whenever the polled stats change (drives the area chart).
  useEffect(() => {
    const h = histRef.current;
    h.push({ t: Date.now(), in: live.bps_in ?? 0, out: live.bps_out ?? live.bps });
    if (h.length > 60) h.shift();
  }, [live]);

  // Recompute flow-derived views (donut, table, alerts) ~1s, since flowsRef is a
  // mutable buffer outside React's reactivity.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const flows = flowsRef.current ?? [];

  // Protocol distribution (bytes) for the donut.
  const protoBytes = new Map<ProtoKey, number>();
  for (const f of flows) protoBytes.set(f.proto, (protoBytes.get(f.proto) ?? 0) + (f.flow.octets ?? 0));
  const protoSegs = [...protoBytes.entries()].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]);
  const protoTotal = protoSegs.reduce((s, [, b]) => s + b, 0) || 1;

  return (
    <div className="sn-root">
      <div className="sn-bar">
        <span className="sn-logo">📡 Sniffnet</span>
        <div className="sn-tabs">
          {(['overview', 'inspect', 'notifications'] as Tab[]).map((tb) => (
            <button key={tb} className={`sn-tab ${tab === tb ? 'active' : ''}`} onClick={() => setTab(tb)}>
              {tr(tb, lang)}
            </button>
          ))}
        </div>
        <button className="sn-close" onClick={onClose} title={tr('close', lang)}>🗺 {tr('close', lang)}</button>
      </div>

      {tab === 'overview' && (
        <Overview live={live} apps={apps} flows={flows} stats={stats} statWin={statWin} lang={lang} hist={histRef.current} protoSegs={protoSegs} protoTotal={protoTotal} />
      )}
      {tab === 'inspect' && <Inspect flows={flows} lang={lang} />}
      {tab === 'notifications' && <Notifications flows={flows} live={live} lang={lang} />}
    </div>
  );
}

function Overview({ live, apps, flows, stats, statWin, lang, hist, protoSegs, protoTotal }: {
  live: LiveStats; apps: AppStat[]; flows: LiveFlow[]; stats: { rate: number; total: number };
  statWin: number; lang: Lang; hist: Sample[]; protoSegs: [ProtoKey, number][]; protoTotal: number;
}) {
  return (
    <div className="sn-body">
      <div className="sn-kpis">
        <div className="sn-kpi"><span className="sn-k">{fmtBps(live.bps)}</span><span className="sn-l">{tr('throughput', lang)}</span></div>
        <div className="sn-kpi dl"><span className="sn-k">↓ {fmtBps(live.bps_in ?? 0)}</span><span className="sn-l">{tr('download', lang)}</span></div>
        <div className="sn-kpi ul"><span className="sn-k">↑ {fmtBps(live.bps_out ?? 0)}</span><span className="sn-l">{tr('upload', lang)}</span></div>
        <div className="sn-kpi"><span className="sn-k">{flows.length}</span><span className="sn-l">{tr('activeConns', lang)}</span></div>
        <div className="sn-kpi"><span className="sn-k">{stats.rate}/s</span><span className="sn-l">{tr('connections', lang)}</span></div>
      </div>

      <div className="sn-grid">
        <div className="sn-card sn-wide">
          <h3>{tr('throughput', lang)} · {statWin >= 60 ? statWin / 60 + 'm' : statWin + 's'}</h3>
          <AreaChart hist={hist} />
        </div>

        <div className="sn-card">
          <h3>{tr('protocols', lang)}</h3>
          <div className="sn-donut-wrap">
            <Donut segs={protoSegs.map(([k, b]) => ({ color: hex(PROTO_COLOR[k]), value: b }))} total={protoTotal} />
            <div className="sn-legend">
              {protoSegs.slice(0, 8).map(([k, b]) => (
                <div className="sn-leg" key={k}>
                  <span className="sn-sw" style={{ background: hex(PROTO_COLOR[k]) }} />
                  <span className="sn-leg-k">{k.toUpperCase()}</span>
                  <span className="sn-leg-v">{((b / protoTotal) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="sn-card">
          <h3>{tr('apps', lang)}</h3>
          <BarList rows={apps.slice(0, 8).map((a) => ({ label: a.app, value: a.bytes, color: a.category ? hex(CATEGORY_COLOR[a.category] ?? [148, 163, 184]) : undefined, sub: a.category ?? undefined }))} />
        </div>

        <div className="sn-card">
          <h3>{tr('topCountries', lang)}</h3>
          <BarList rows={live.top_countries.slice(0, 8).map((c) => ({ label: c.country, value: c.bytes, flag: c.country }))} />
        </div>

        <div className="sn-card sn-wide">
          <h3>{tr('topHosts', lang)}</h3>
          <BarList rows={live.top_dst.slice(0, 10).map((d) => ({ label: d.ip, value: d.bytes, flag: d.country }))} />
        </div>
      </div>
    </div>
  );
}

function Inspect({ flows, lang }: { flows: LiveFlow[]; lang: Lang }) {
  const [q, setQ] = useState('');
  const [pf, setPf] = useState<ProtoKey | 'all'>('all');
  const protos = [...new Set(flows.map((f) => f.proto))];

  const ql = q.trim().toLowerCase();
  const rows = flows
    .filter((f) => pf === 'all' || f.proto === pf)
    .filter((f) => {
      if (!ql) return true;
      const fl = f.flow;
      return (
        fl.src_addr.includes(ql) || fl.dst_addr.includes(ql) ||
        String(fl.src_port ?? '').includes(ql) || String(fl.dst_port ?? '').includes(ql) ||
        (fl.app ?? '').toLowerCase().includes(ql) || (fl.service ?? '').toLowerCase().includes(ql) ||
        (fl.dst_geo?.country ?? '').toLowerCase().includes(ql)
      );
    })
    .sort((a, b) => (b.flow.octets ?? 0) - (a.flow.octets ?? 0))
    .slice(0, 300);

  const now = performance.now();
  return (
    <div className="sn-body sn-inspect">
      <div className="sn-toolbar">
        <input className="sn-search" placeholder={tr('filter', lang)} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="sn-chips">
          <button className={`sn-chip ${pf === 'all' ? 'active' : ''}`} onClick={() => setPf('all')}>{tr('allProto', lang)}</button>
          {protos.map((p) => (
            <button key={p} className={`sn-chip ${pf === p ? 'active' : ''}`} onClick={() => setPf(p)} style={pf === p ? { background: hex(PROTO_COLOR[p]), color: '#06121f' } : undefined}>
              {p.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="sn-count">{rows.length}</span>
      </div>
      <div className="sn-table-wrap">
        <table className="sn-table">
          <thead>
            <tr>
              <th></th>
              <th>{tr('src', lang)}</th>
              <th>{tr('dst', lang)}</th>
              <th>{tr('proto', lang)}</th>
              <th>{tr('app', lang)}</th>
              <th>{tr('country', lang)}</th>
              <th className="num">{tr('bytes', lang)}</th>
              <th className="num">{tr('packets', lang)}</th>
              <th className="num">{tr('age', lang)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => {
              const fl = f.flow;
              const d = dirOf(f);
              return (
                <tr key={i} className={f.ddos ? 'ddos' : ''}>
                  <td className={`sn-dir ${d}`}>{DIR_ARROW[d]}</td>
                  <td className="mono">{fl.src_addr}<span className="port">:{fl.src_port ?? '-'}</span></td>
                  <td className="mono">{fl.dst_addr}<span className="port">:{fl.dst_port ?? '-'}</span></td>
                  <td><span className="sn-pdot" style={{ background: hex(PROTO_COLOR[f.proto]) }} />{f.proto.toUpperCase()}</td>
                  <td>{fl.app ?? fl.service ?? '—'}</td>
                  <td><Flag cc={fl.dst_geo?.country} />{fl.dst_geo?.country ?? '-'}</td>
                  <td className="num">{fmtBytes(fl.octets ?? 0)}</td>
                  <td className="num">{fl.packets ?? '-'}</td>
                  <td className="num">{fmtAgo(now - f.born)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="sn-empty">{tr('noConns', lang)}</div>}
      </div>
    </div>
  );
}

interface Alert { kind: 'ddos' | 'big'; flow: LiveFlow; born: number }
function Notifications({ flows, lang }: { flows: LiveFlow[]; live: LiveStats; lang: Lang }) {
  // Derive alerts from the live buffer: DDoS-flagged flows and unusually large
  // single transfers (data-driven, no static thresholds beyond a size floor).
  const BIG = 5_000_000; // 5 MB single-flow transfer
  const alerts: Alert[] = [];
  for (const f of flows) {
    if (f.ddos) alerts.push({ kind: 'ddos', flow: f, born: f.born });
    else if ((f.flow.octets ?? 0) >= BIG) alerts.push({ kind: 'big', flow: f, born: f.born });
  }
  alerts.sort((a, b) => b.born - a.born);
  const now = performance.now();

  return (
    <div className="sn-body sn-notif">
      {alerts.length === 0 && <div className="sn-empty">{tr('noAlerts', lang)}</div>}
      {alerts.slice(0, 100).map((a, i) => {
        const fl = a.flow.flow;
        return (
          <div className={`sn-alert ${a.kind}`} key={i}>
            <span className="sn-al-ico">{a.kind === 'ddos' ? '⚠' : '⬆'}</span>
            <span className="sn-al-title">{a.kind === 'ddos' ? tr('ddosAlert', lang) : tr('bigFlow', lang)}</span>
            <span className="sn-al-body mono">{fl.src_addr} → {fl.dst_addr}:{fl.dst_port ?? '-'}</span>
            <span className="sn-al-meta"><Flag cc={fl.dst_geo?.country} />{fl.dst_geo?.country ?? ''} · {fmtBytes(fl.octets ?? 0)}</span>
            <span className="sn-al-age">{fmtAgo(now - a.born)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---- inline SVG primitives (zero-dep) ----

function AreaChart({ hist }: { hist: Sample[] }) {
  const W = 600, H = 130, pad = 4;
  if (hist.length < 2) return <div className="sn-chart-empty" style={{ height: H }} />;
  const max = Math.max(1, ...hist.map((s) => Math.max(s.in, s.out)));
  const n = hist.length;
  const x = (i: number) => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  const path = (key: 'in' | 'out') => {
    const line = hist.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
    const area = `${line} L${x(n - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
    return { line, area };
  };
  const din = path('in'), dout = path('out');
  return (
    <svg className="sn-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={din.area} fill="rgba(34,211,238,0.18)" />
      <path d={din.line} fill="none" stroke="#22d3ee" strokeWidth="1.5" />
      <path d={dout.area} fill="rgba(245,158,11,0.15)" />
      <path d={dout.line} fill="none" stroke="#f59e0b" strokeWidth="1.5" />
    </svg>
  );
}

function Donut({ segs, total }: { segs: { color: string; value: number }[]; total: number }) {
  const R = 46, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <svg className="sn-donut" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth="14" />
      {segs.map((s, i) => {
        const frac = s.value / total;
        const dash = frac * C;
        const el = (
          <circle key={i} cx="60" cy="60" r={R} fill="none" stroke={s.color} strokeWidth="14"
            strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-off} transform="rotate(-90 60 60)" />
        );
        off += dash;
        return el;
      })}
    </svg>
  );
}

function BarList({ rows }: { rows: { label: string; value: number; color?: string; flag?: string | null; sub?: string }[] }) {
  const max = rows[0]?.value || 1;
  return (
    <div className="sn-bars">
      {rows.map((r, i) => (
        <div className="sn-barrow" key={i}>
          <span className="sn-bl" title={r.sub}>{r.flag ? <Flag cc={r.flag} /> : null}{r.label}</span>
          <span className="sn-bt"><span className="sn-bf" style={{ width: `${(r.value / max) * 100}%`, background: r.color }} /></span>
          <span className="sn-bv">{fmtBytes(r.value)}</span>
        </div>
      ))}
      {rows.length === 0 && <div className="sn-empty sm">—</div>}
    </div>
  );
}
