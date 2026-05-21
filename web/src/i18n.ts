// UI string table. Default language is English; a header toggle switches to
// Chinese. Place-name labels on the map follow the same selection via PLACE_LANG.

export type Lang = 'en' | 'zh';

export interface Strings {
  brand: string;
  fullscreen: string;
  play: string;
  pause: string;
  speed: string;
  timeRange: string;
  autoRefresh: string;
  live: string;
  last5m: string;
  last30m: string;
  last1h: string;
  last12h: string;
  last1d: string;
  last30d: string;
  last1y: string;
  refreshOff: string;
  features: string;
  settings: string;
  protocol: string;
  service: string;
  anomaly: string;
  other: string;
  otherSvc: string;
  direction: string;
  dirAll: string;
  dirOut: string;
  dirIn: string;
  dirInternal: string;
  minBytes: string;
  all: string;
  cables: string;
  routes: string;
  placeLabels: string;
  colorByApp: string;
  dayNight: string;
  rate: string;
  showing: string;
  cableRouted: string;
  total: string;
  bandwidth: string;
  dstCountries: string;
  appsPanel: string;
  topDst: string;
  topSrc: string;
  topPort: string;
  unmatchedPanel: string;
  timeline: string;
  statsPanel: string;
}

export const STR: Record<Lang, Strings> = {
  en: {
    brand: 'OPNsense Traffic Map',
    fullscreen: 'Fullscreen',
    play: 'Play',
    pause: 'Pause',
    speed: 'Speed',
    timeRange: 'Time range',
    autoRefresh: 'Auto refresh',
    live: '● Live',
    last5m: 'Last 5 min',
    last30m: 'Last 30 min',
    last1h: 'Last 1 hour',
    last12h: 'Last 12 h',
    last1d: 'Last 1 day',
    last30d: 'Last 30 days',
    last1y: 'Last 1 year',
    refreshOff: 'Refresh off',
    features: 'Traffic',
    settings: 'Settings',
    protocol: 'Protocol',
    service: 'Service (port)',
    anomaly: 'Anomaly',
    other: 'Other',
    otherSvc: 'Other svc',
    direction: 'Direction',
    dirAll: 'All',
    dirOut: 'Out',
    dirIn: 'In',
    dirInternal: 'LAN',
    minBytes: 'Min bytes',
    all: 'All',
    cables: 'Submarine cables',
    routes: 'Real path (mtr)',
    placeLabels: 'Place labels',
    colorByApp: 'Color by app (SNI)',
    dayNight: 'Day/night line',
    rate: 'Rate',
    showing: 'Showing',
    cableRouted: 'Cable-routed',
    total: 'Total',
    bandwidth: 'Throughput · last',
    dstCountries: 'Dst countries (5 min)',
    appsPanel: 'Apps (SNI · 5 min)',
    topDst: 'Top destinations',
    topSrc: 'Top sources (LAN)',
    topPort: 'Top ports',
    unmatchedPanel: 'Unclassified SNI (add rules)',
    timeline: 'Throughput · drag to replay a window',
    statsPanel: 'Stats',
  },
  zh: {
    brand: 'OPNsense 流量地图',
    fullscreen: '全屏',
    play: '播放',
    pause: '暂停',
    speed: '速度',
    timeRange: '时间范围',
    autoRefresh: '自动刷新',
    live: '● 实时',
    last5m: '最近 5 分钟',
    last30m: '最近 30 分钟',
    last1h: '最近 1 小时',
    last12h: '最近 12 小时',
    last1d: '最近 1 天',
    last30d: '最近 30 天',
    last1y: '最近 1 年',
    refreshOff: '刷新 关',
    features: '流量特征',
    settings: '设置',
    protocol: '协议',
    service: '服务 (端口)',
    anomaly: '异常',
    other: '其他',
    otherSvc: '其他服务',
    direction: '方向',
    dirAll: '全部',
    dirOut: '出站',
    dirIn: '入站',
    dirInternal: '内网',
    minBytes: '最小流量',
    all: '全部',
    cables: '海底光缆',
    routes: '真实路径 (mtr)',
    placeLabels: '地名标注',
    colorByApp: '按应用着色 (SNI)',
    dayNight: '昼夜晨昏线',
    rate: '速率',
    showing: '显示中',
    cableRouted: '光缆路由',
    total: '累计',
    bandwidth: '实时吞吐 · 近',
    dstCountries: '目的国 (5分钟)',
    appsPanel: '应用 (SNI · 5分钟)',
    topDst: 'Top 目的地',
    topSrc: 'Top 源主机 (内网)',
    topPort: 'Top 端口',
    unmatchedPanel: '待补规则 · 未分类 SNI',
    timeline: '吞吐时间轴 · 拖拽回放某段',
    statsPanel: '流量统计',
  },
};

// GeoJSON name-field per language for map place labels.
export const PLACE_LANG: Record<Lang, string> = { en: 'n_en', zh: 'n_zh' };

const KEY = 'opnmap.lang';

export function initialLang(): Lang {
  const saved = localStorage.getItem(KEY);
  return saved === 'zh' || saved === 'en' ? saved : 'en'; // default English
}

export function saveLang(l: Lang): void {
  localStorage.setItem(KEY, l);
}
