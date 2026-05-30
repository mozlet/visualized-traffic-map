// UI string table. Default English; the header dropdown switches language
// (12 languages, matching zoom.earth's coverage). Map place-name labels follow
// the same selection via PLACE_LANG (bundled GeoJSON name fields).

export type Lang = 'en' | 'zh' | 'zh-Hant' | 'ja' | 'ko' | 'ru' | 'es' | 'fr' | 'de' | 'ar' | 'pt' | 'it';

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
  cableColor: string;
  routes: string;
  placeLabels: string;
  colorByApp: string;
  dayNight: string;
  theme: string;
  time: string;
  units: string;
  local: string;
  slow: string;
  normal: string;
  fast: string;
  resetLayout: string;
  search: string;
  about: string;
  legend: string;
  screenshot: string;
  shareLink: string;
  zoomIn: string;
  zoomOut: string;
  goHome: string;
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
    brand: 'OPNsense Traffic Map', fullscreen: 'Fullscreen', play: 'Play', pause: 'Pause', speed: 'Speed',
    timeRange: 'Time range', autoRefresh: 'Auto refresh', live: '● Live', last5m: 'Last 5 min', last30m: 'Last 30 min',
    last1h: 'Last 1 hour', last12h: 'Last 12 h', last1d: 'Last 1 day', last30d: 'Last 30 days', last1y: 'Last 1 year',
    refreshOff: 'Refresh off', features: 'Traffic', settings: 'Settings', protocol: 'Protocol', service: 'Service (port)',
    anomaly: 'Anomaly', other: 'Other', otherSvc: 'Other svc', direction: 'Direction', dirAll: 'All', dirOut: 'Out',
    dirIn: 'In', dirInternal: 'LAN', minBytes: 'Min bytes', all: 'All', cables: 'Submarine cables', cableColor: 'Cable colours (real)', routes: 'Real path (mtr)',
    placeLabels: 'Place labels', colorByApp: 'Color by app (SNI)', dayNight: 'Day/night line', theme: 'Theme', time: 'Time',
    units: 'Units', local: 'Local', slow: 'Slow', normal: 'Normal', fast: 'Fast', resetLayout: 'Reset layout', search: 'Search',
    about: 'About & legend', legend: 'Legend', screenshot: 'Screenshot', shareLink: 'Copy link', zoomIn: 'Zoom in',
    zoomOut: 'Zoom out', goHome: 'Go to home', rate: 'Rate', showing: 'Showing', cableRouted: 'Cable-routed', total: 'Total',
    bandwidth: 'Throughput · last', dstCountries: 'Dst countries', appsPanel: 'Apps (SNI)',
    topDst: 'Top destinations', topSrc: 'Top sources (LAN)', topPort: 'Top ports', unmatchedPanel: 'Unclassified SNI (add rules)',
    timeline: 'Throughput · click or drag to replay', statsPanel: 'Stats',
  },
  zh: {
    brand: 'OPNsense 流量地图', fullscreen: '全屏', play: '播放', pause: '暂停', speed: '速度', timeRange: '时间范围',
    autoRefresh: '自动刷新', live: '● 实时', last5m: '最近 5 分钟', last30m: '最近 30 分钟', last1h: '最近 1 小时',
    last12h: '最近 12 小时', last1d: '最近 1 天', last30d: '最近 30 天', last1y: '最近 1 年', refreshOff: '刷新 关',
    features: '流量特征', settings: '设置', protocol: '协议', service: '服务 (端口)', anomaly: '异常', other: '其他',
    otherSvc: '其他服务', direction: '方向', dirAll: '全部', dirOut: '出站', dirIn: '入站', dirInternal: '内网',
    minBytes: '最小流量', all: '全部', cables: '海底光缆', cableColor: '电缆配色 (真实)', routes: '真实路径 (mtr)', placeLabels: '地名标注',
    colorByApp: '按应用着色 (SNI)', dayNight: '昼夜晨昏线', theme: '主题', time: '时间', units: '单位', local: '本地',
    slow: '慢', normal: '正常', fast: '快', resetLayout: '复位布局', search: '搜索', about: '关于 & 图例', legend: '图例',
    screenshot: '截图', shareLink: '复制链接', zoomIn: '放大', zoomOut: '缩小', goHome: '回到 home', rate: '速率',
    showing: '显示中', cableRouted: '光缆路由', total: '累计', bandwidth: '实时吞吐 · 近', dstCountries: '目的国',
    appsPanel: '应用 (SNI)', topDst: 'Top 目的地', topSrc: 'Top 源主机 (内网)', topPort: 'Top 端口',
    unmatchedPanel: '待补规则 · 未分类 SNI', timeline: '吞吐时间轴 · 单击/拖拽回放', statsPanel: '流量统计',
  },
  'zh-Hant': {
    brand: 'OPNsense 流量地圖', fullscreen: '全螢幕', play: '播放', pause: '暫停', speed: '速度', timeRange: '時間範圍',
    autoRefresh: '自動重新整理', live: '● 即時', last5m: '最近 5 分鐘', last30m: '最近 30 分鐘', last1h: '最近 1 小時',
    last12h: '最近 12 小時', last1d: '最近 1 天', last30d: '最近 30 天', last1y: '最近 1 年', refreshOff: '關閉重新整理',
    features: '流量特徵', settings: '設定', protocol: '協定', service: '服務 (連接埠)', anomaly: '異常', other: '其他',
    otherSvc: '其他服務', direction: '方向', dirAll: '全部', dirOut: '出站', dirIn: '入站', dirInternal: '內網',
    minBytes: '最小流量', all: '全部', cables: '海底電纜', cableColor: '電纜配色 (真實)', routes: '真實路徑 (mtr)', placeLabels: '地名標註',
    colorByApp: '依應用著色 (SNI)', dayNight: '晝夜晨昏線', theme: '主題', time: '時間', units: '單位', local: '本地',
    slow: '慢', normal: '正常', fast: '快', resetLayout: '重設版面', search: '搜尋', about: '關於 & 圖例', legend: '圖例',
    screenshot: '截圖', shareLink: '複製連結', zoomIn: '放大', zoomOut: '縮小', goHome: '回到 home', rate: '速率',
    showing: '顯示中', cableRouted: '電纜路由', total: '累計', bandwidth: '即時吞吐 · 近', dstCountries: '目的國',
    appsPanel: '應用 (SNI)', topDst: 'Top 目的地', topSrc: 'Top 來源主機 (內網)', topPort: 'Top 連接埠',
    unmatchedPanel: '待補規則 · 未分類 SNI', timeline: '吞吐時間軸 · 單擊/拖曳重播', statsPanel: '流量統計',
  },
  ja: {
    brand: 'OPNsense トラフィックマップ', fullscreen: '全画面', play: '再生', pause: '一時停止', speed: '速度',
    timeRange: '期間', autoRefresh: '自動更新', live: '● ライブ', last5m: '直近5分', last30m: '直近30分', last1h: '直近1時間',
    last12h: '直近12時間', last1d: '直近1日', last30d: '直近30日', last1y: '直近1年', refreshOff: '更新オフ',
    features: 'トラフィック', settings: '設定', protocol: 'プロトコル', service: 'サービス (ポート)', anomaly: '異常',
    other: 'その他', otherSvc: 'その他', direction: '方向', dirAll: '全て', dirOut: '送信', dirIn: '受信', dirInternal: 'LAN',
    minBytes: '最小バイト', all: '全て', cables: '海底ケーブル', cableColor: 'ケーブル色 (実色)', routes: '実経路 (mtr)', placeLabels: '地名ラベル',
    colorByApp: 'アプリ別色分け (SNI)', dayNight: '昼夜境界線', theme: 'テーマ', time: '時刻', units: '単位', local: 'ローカル',
    slow: '遅い', normal: '標準', fast: '速い', resetLayout: 'レイアウト初期化', search: '検索', about: '情報と凡例',
    legend: '凡例', screenshot: 'スクリーンショット', shareLink: 'リンクをコピー', zoomIn: '拡大', zoomOut: '縮小',
    goHome: 'ホームへ', rate: 'レート', showing: '表示中', cableRouted: 'ケーブル経由', total: '累計',
    bandwidth: 'スループット · 直近', dstCountries: '宛先国', appsPanel: 'アプリ (SNI)', topDst: '上位宛先',
    topSrc: '上位送信元 (LAN)', topPort: '上位ポート', unmatchedPanel: '未分類SNI (ルール追加)',
    timeline: 'スループット · ドラッグで再生', statsPanel: '統計',
  },
  ko: {
    brand: 'OPNsense 트래픽 맵', fullscreen: '전체화면', play: '재생', pause: '일시정지', speed: '속도', timeRange: '시간 범위',
    autoRefresh: '자동 새로고침', live: '● 실시간', last5m: '최근 5분', last30m: '최근 30분', last1h: '최근 1시간',
    last12h: '최근 12시간', last1d: '최근 1일', last30d: '최근 30일', last1y: '최근 1년', refreshOff: '새로고침 끔',
    features: '트래픽', settings: '설정', protocol: '프로토콜', service: '서비스 (포트)', anomaly: '이상', other: '기타',
    otherSvc: '기타', direction: '방향', dirAll: '전체', dirOut: '아웃', dirIn: '인', dirInternal: 'LAN', minBytes: '최소 바이트',
    all: '전체', cables: '해저 케이블', cableColor: '케이블 색상 (실제)', routes: '실제 경로 (mtr)', placeLabels: '지명 라벨', colorByApp: '앱별 색상 (SNI)',
    dayNight: '주야 경계선', theme: '테마', time: '시간', units: '단위', local: '로컬', slow: '느리게', normal: '보통',
    fast: '빠르게', resetLayout: '레이아웃 초기화', search: '검색', about: '정보 및 범례', legend: '범례', screenshot: '스크린샷',
    shareLink: '링크 복사', zoomIn: '확대', zoomOut: '축소', goHome: '홈으로', rate: '속도', showing: '표시 중',
    cableRouted: '케이블 경유', total: '누적', bandwidth: '처리량 · 최근', dstCountries: '목적지 국가',
    appsPanel: '앱 (SNI)', topDst: '상위 목적지', topSrc: '상위 출발지 (LAN)', topPort: '상위 포트',
    unmatchedPanel: '미분류 SNI (규칙 추가)', timeline: '처리량 · 드래그하여 재생', statsPanel: '통계',
  },
  ru: {
    brand: 'OPNsense Карта трафика', fullscreen: 'Полный экран', play: 'Воспроизвести', pause: 'Пауза', speed: 'Скорость',
    timeRange: 'Период', autoRefresh: 'Автообновление', live: '● Онлайн', last5m: 'За 5 минут', last30m: 'За 30 минут',
    last1h: 'За 1 час', last12h: 'За 12 часов', last1d: 'За 1 день', last30d: 'За 30 дней', last1y: 'За 1 год',
    refreshOff: 'Обновление выкл', features: 'Трафик', settings: 'Настройки', protocol: 'Протокол', service: 'Служба (порт)',
    anomaly: 'Аномалия', other: 'Другое', otherSvc: 'Другое', direction: 'Направление', dirAll: 'Все', dirOut: 'Исх',
    dirIn: 'Вх', dirInternal: 'LAN', minBytes: 'Мин. байт', all: 'Все', cables: 'Подводные кабели', cableColor: 'Цвета кабелей (реальные)', routes: 'Реальный путь (mtr)',
    placeLabels: 'Подписи мест', colorByApp: 'Цвет по прил. (SNI)', dayNight: 'Линия дня/ночи', theme: 'Тема', time: 'Время',
    units: 'Единицы', local: 'Местное', slow: 'Медленно', normal: 'Обычно', fast: 'Быстро', resetLayout: 'Сбросить макет',
    search: 'Поиск', about: 'О программе и легенда', legend: 'Легенда', screenshot: 'Снимок', shareLink: 'Копировать ссылку',
    zoomIn: 'Приблизить', zoomOut: 'Отдалить', goHome: 'Домой', rate: 'Частота', showing: 'Показано', cableRouted: 'Через кабель',
    total: 'Всего', bandwidth: 'Пропускная · за', dstCountries: 'Страны назн.', appsPanel: 'Прил. (SNI)',
    topDst: 'Топ назначений', topSrc: 'Топ источников (LAN)', topPort: 'Топ портов', unmatchedPanel: 'Неклассиф. SNI (правила)',
    timeline: 'Пропускная · тяните для повтора', statsPanel: 'Статистика',
  },
  es: {
    brand: 'OPNsense Mapa de tráfico', fullscreen: 'Pantalla completa', play: 'Reproducir', pause: 'Pausa', speed: 'Velocidad',
    timeRange: 'Periodo', autoRefresh: 'Auto actualizar', live: '● En vivo', last5m: 'Últimos 5 min', last30m: 'Últimos 30 min',
    last1h: 'Última 1 h', last12h: 'Últimas 12 h', last1d: 'Último 1 día', last30d: 'Últimos 30 días', last1y: 'Último 1 año',
    refreshOff: 'Sin actualizar', features: 'Tráfico', settings: 'Ajustes', protocol: 'Protocolo', service: 'Servicio (puerto)',
    anomaly: 'Anomalía', other: 'Otro', otherSvc: 'Otro', direction: 'Dirección', dirAll: 'Todo', dirOut: 'Salida',
    dirIn: 'Entrada', dirInternal: 'LAN', minBytes: 'Bytes mín', all: 'Todo', cables: 'Cables submarinos', cableColor: 'Colores de cable (real)', routes: 'Ruta real (mtr)',
    placeLabels: 'Etiquetas de lugares', colorByApp: 'Color por app (SNI)', dayNight: 'Línea día/noche', theme: 'Tema', time: 'Hora',
    units: 'Unidades', local: 'Local', slow: 'Lento', normal: 'Normal', fast: 'Rápido', resetLayout: 'Restablecer diseño',
    search: 'Buscar', about: 'Acerca de y leyenda', legend: 'Leyenda', screenshot: 'Captura', shareLink: 'Copiar enlace',
    zoomIn: 'Acercar', zoomOut: 'Alejar', goHome: 'Ir a inicio', rate: 'Tasa', showing: 'Mostrando', cableRouted: 'Por cable',
    total: 'Total', bandwidth: 'Rendimiento · últ', dstCountries: 'Países destino', appsPanel: 'Apps (SNI)',
    topDst: 'Top destinos', topSrc: 'Top orígenes (LAN)', topPort: 'Top puertos', unmatchedPanel: 'SNI sin clasificar (reglas)',
    timeline: 'Rendimiento · arrastra para repetir', statsPanel: 'Estadísticas',
  },
  fr: {
    brand: 'OPNsense Carte du trafic', fullscreen: 'Plein écran', play: 'Lecture', pause: 'Pause', speed: 'Vitesse',
    timeRange: 'Période', autoRefresh: 'Actualisation auto', live: '● Direct', last5m: '5 dern. min', last30m: '30 dern. min',
    last1h: 'Dern. 1 h', last12h: 'Dern. 12 h', last1d: 'Dern. 1 jour', last30d: 'Dern. 30 jours', last1y: 'Dern. 1 an',
    refreshOff: 'Actu. désactivée', features: 'Trafic', settings: 'Paramètres', protocol: 'Protocole', service: 'Service (port)',
    anomaly: 'Anomalie', other: 'Autre', otherSvc: 'Autre', direction: 'Direction', dirAll: 'Tout', dirOut: 'Sortant',
    dirIn: 'Entrant', dirInternal: 'LAN', minBytes: 'Octets min', all: 'Tout', cables: 'Câbles sous-marins', cableColor: 'Couleurs câbles (réel)',
    routes: 'Chemin réel (mtr)', placeLabels: 'Étiquettes de lieux', colorByApp: 'Couleur par app (SNI)', dayNight: 'Ligne jour/nuit',
    theme: 'Thème', time: 'Heure', units: 'Unités', local: 'Locale', slow: 'Lent', normal: 'Normal', fast: 'Rapide',
    resetLayout: 'Réinit. disposition', search: 'Rechercher', about: 'À propos et légende', legend: 'Légende', screenshot: 'Capture',
    shareLink: 'Copier le lien', zoomIn: 'Zoom avant', zoomOut: 'Zoom arrière', goHome: 'Accueil', rate: 'Débit',
    showing: 'Affichage', cableRouted: 'Via câble', total: 'Total', bandwidth: 'Débit · dern', dstCountries: 'Pays dest.',
    appsPanel: 'Apps (SNI)', topDst: 'Top destinations', topSrc: 'Top sources (LAN)', topPort: 'Top ports',
    unmatchedPanel: 'SNI non classés (règles)', timeline: 'Débit · glisser pour rejouer', statsPanel: 'Statistiques',
  },
  de: {
    brand: 'OPNsense Verkehrskarte', fullscreen: 'Vollbild', play: 'Wiedergabe', pause: 'Pause', speed: 'Geschw.',
    timeRange: 'Zeitraum', autoRefresh: 'Auto-Aktual.', live: '● Live', last5m: 'Letzte 5 Min', last30m: 'Letzte 30 Min',
    last1h: 'Letzte 1 Std', last12h: 'Letzte 12 Std', last1d: 'Letzter 1 Tag', last30d: 'Letzte 30 Tage', last1y: 'Letztes 1 Jahr',
    refreshOff: 'Aktual. aus', features: 'Verkehr', settings: 'Einstellungen', protocol: 'Protokoll', service: 'Dienst (Port)',
    anomaly: 'Anomalie', other: 'Andere', otherSvc: 'Andere', direction: 'Richtung', dirAll: 'Alle', dirOut: 'Aus', dirIn: 'Ein',
    dirInternal: 'LAN', minBytes: 'Min. Bytes', all: 'Alle', cables: 'Seekabel', cableColor: 'Kabelfarben (echt)', routes: 'Echter Pfad (mtr)',
    placeLabels: 'Ortsbezeichnungen', colorByApp: 'Farbe nach App (SNI)', dayNight: 'Tag/Nacht-Linie', theme: 'Design',
    time: 'Zeit', units: 'Einheiten', local: 'Lokal', slow: 'Langsam', normal: 'Normal', fast: 'Schnell',
    resetLayout: 'Layout zurücksetzen', search: 'Suche', about: 'Info & Legende', legend: 'Legende', screenshot: 'Screenshot',
    shareLink: 'Link kopieren', zoomIn: 'Vergrößern', zoomOut: 'Verkleinern', goHome: 'Zum Standort', rate: 'Rate',
    showing: 'Angezeigt', cableRouted: 'Über Kabel', total: 'Gesamt', bandwidth: 'Durchsatz · letzte',
    dstCountries: 'Ziel-Länder', appsPanel: 'Apps (SNI)', topDst: 'Top Ziele', topSrc: 'Top Quellen (LAN)',
    topPort: 'Top Ports', unmatchedPanel: 'Unklass. SNI (Regeln)', timeline: 'Durchsatz · ziehen zum Abspielen',
    statsPanel: 'Statistik',
  },
  ar: {
    brand: 'OPNsense خريطة حركة المرور', fullscreen: 'ملء الشاشة', play: 'تشغيل', pause: 'إيقاف مؤقت', speed: 'السرعة',
    timeRange: 'النطاق الزمني', autoRefresh: 'تحديث تلقائي', live: '● مباشر', last5m: 'آخر 5 دقائق', last30m: 'آخر 30 دقيقة',
    last1h: 'آخر ساعة', last12h: 'آخر 12 ساعة', last1d: 'آخر يوم', last30d: 'آخر 30 يومًا', last1y: 'آخر سنة',
    refreshOff: 'إيقاف التحديث', features: 'حركة المرور', settings: 'الإعدادات', protocol: 'البروتوكول', service: 'الخدمة (المنفذ)',
    anomaly: 'شذوذ', other: 'أخرى', otherSvc: 'أخرى', direction: 'الاتجاه', dirAll: 'الكل', dirOut: 'صادر', dirIn: 'وارد',
    dirInternal: 'LAN', minBytes: 'أدنى بايت', all: 'الكل', cables: 'كابلات بحرية', cableColor: 'ألوان الكابلات (حقيقية)', routes: 'المسار الفعلي (mtr)',
    placeLabels: 'تسميات الأماكن', colorByApp: 'تلوين حسب التطبيق (SNI)', dayNight: 'خط الليل/النهار', theme: 'السمة',
    time: 'الوقت', units: 'الوحدات', local: 'محلي', slow: 'بطيء', normal: 'عادي', fast: 'سريع', resetLayout: 'إعادة ضبط التخطيط',
    search: 'بحث', about: 'حول والمفتاح', legend: 'المفتاح', screenshot: 'لقطة شاشة', shareLink: 'نسخ الرابط', zoomIn: 'تكبير',
    zoomOut: 'تصغير', goHome: 'إلى الموطن', rate: 'المعدل', showing: 'يعرض', cableRouted: 'عبر الكابل', total: 'الإجمالي',
    bandwidth: 'الإنتاجية · آخر', dstCountries: 'دول الوجهة', appsPanel: 'التطبيقات (SNI)', topDst: 'أهم الوجهات',
    topSrc: 'أهم المصادر (LAN)', topPort: 'أهم المنافذ', unmatchedPanel: 'SNI غير مصنف (قواعد)',
    timeline: 'الإنتاجية · اسحب لإعادة التشغيل', statsPanel: 'إحصائيات',
  },
  pt: {
    brand: 'OPNsense Mapa de tráfego', fullscreen: 'Tela cheia', play: 'Reproduzir', pause: 'Pausar', speed: 'Velocidade',
    timeRange: 'Período', autoRefresh: 'Atualização auto', live: '● Ao vivo', last5m: 'Últimos 5 min', last30m: 'Últimos 30 min',
    last1h: 'Última 1 h', last12h: 'Últimas 12 h', last1d: 'Último 1 dia', last30d: 'Últimos 30 dias', last1y: 'Último 1 ano',
    refreshOff: 'Atualização desl', features: 'Tráfego', settings: 'Configurações', protocol: 'Protocolo', service: 'Serviço (porta)',
    anomaly: 'Anomalia', other: 'Outro', otherSvc: 'Outro', direction: 'Direção', dirAll: 'Tudo', dirOut: 'Saída',
    dirIn: 'Entrada', dirInternal: 'LAN', minBytes: 'Bytes mín', all: 'Tudo', cables: 'Cabos submarinos', cableColor: 'Cores dos cabos (real)', routes: 'Rota real (mtr)',
    placeLabels: 'Rótulos de locais', colorByApp: 'Cor por app (SNI)', dayNight: 'Linha dia/noite', theme: 'Tema', time: 'Hora',
    units: 'Unidades', local: 'Local', slow: 'Lento', normal: 'Normal', fast: 'Rápido', resetLayout: 'Redefinir layout',
    search: 'Pesquisar', about: 'Sobre e legenda', legend: 'Legenda', screenshot: 'Captura', shareLink: 'Copiar link',
    zoomIn: 'Aproximar', zoomOut: 'Afastar', goHome: 'Ir para início', rate: 'Taxa', showing: 'Exibindo', cableRouted: 'Via cabo',
    total: 'Total', bandwidth: 'Vazão · últ', dstCountries: 'Países destino', appsPanel: 'Apps (SNI)',
    topDst: 'Top destinos', topSrc: 'Top origens (LAN)', topPort: 'Top portas', unmatchedPanel: 'SNI não classificado (regras)',
    timeline: 'Vazão · arraste para reproduzir', statsPanel: 'Estatísticas',
  },
  it: {
    brand: 'OPNsense Mappa del traffico', fullscreen: 'Schermo intero', play: 'Riproduci', pause: 'Pausa', speed: 'Velocità',
    timeRange: 'Periodo', autoRefresh: 'Aggiorn. auto', live: '● Live', last5m: 'Ultimi 5 min', last30m: 'Ultimi 30 min',
    last1h: 'Ultima 1 h', last12h: 'Ultime 12 h', last1d: 'Ultimo 1 giorno', last30d: 'Ultimi 30 giorni', last1y: 'Ultimo 1 anno',
    refreshOff: 'Aggiorn. off', features: 'Traffico', settings: 'Impostazioni', protocol: 'Protocollo', service: 'Servizio (porta)',
    anomaly: 'Anomalia', other: 'Altro', otherSvc: 'Altro', direction: 'Direzione', dirAll: 'Tutto', dirOut: 'Uscita',
    dirIn: 'Entrata', dirInternal: 'LAN', minBytes: 'Byte min', all: 'Tutto', cables: 'Cavi sottomarini', cableColor: 'Colori cavi (reale)',
    routes: 'Percorso reale (mtr)', placeLabels: 'Etichette luoghi', colorByApp: 'Colore per app (SNI)',
    dayNight: 'Linea giorno/notte', theme: 'Tema', time: 'Ora', units: 'Unità', local: 'Locale', slow: 'Lento', normal: 'Normale',
    fast: 'Veloce', resetLayout: 'Reimposta layout', search: 'Cerca', about: 'Info e legenda', legend: 'Legenda',
    screenshot: 'Screenshot', shareLink: 'Copia link', zoomIn: 'Ingrandisci', zoomOut: 'Riduci', goHome: 'Vai a casa',
    rate: 'Frequenza', showing: 'Visualizzati', cableRouted: 'Via cavo', total: 'Totale', bandwidth: 'Throughput · ultimi',
    dstCountries: 'Paesi dest.', appsPanel: 'App (SNI)', topDst: 'Top destinazioni', topSrc: 'Top sorgenti (LAN)',
    topPort: 'Top porte', unmatchedPanel: 'SNI non classificato (regole)', timeline: 'Throughput · trascina per riprodurre',
    statsPanel: 'Statistiche',
  },
};

// Native-script names for the language dropdown.
export const LANG_NAMES: Record<Lang, string> = {
  en: 'English', zh: '简体中文', 'zh-Hant': '繁體中文', ja: '日本語', ko: '한국어', ru: 'Русский',
  es: 'Español', fr: 'Français', de: 'Deutsch', ar: 'العربية', pt: 'Português', it: 'Italiano',
};

// GeoJSON name-field per language for map place labels (zh-Hant reuses n_zh).
export const PLACE_LANG: Record<Lang, string> = {
  en: 'n_en', zh: 'n_zh', 'zh-Hant': 'n_zh', ja: 'n_ja', ko: 'n_ko', ru: 'n_ru',
  es: 'n_es', fr: 'n_fr', de: 'n_de', ar: 'n_ar', pt: 'n_pt', it: 'n_it',
};

// OpenMapTiles `name:<lang>` per app language for the PMTiles street layer
// (zh-Hant maps to the same simplified-Chinese tag tilemaker emits). Fallback
// chain when the tile lacks the field: name → name:latin (transliterated).
export const PMT_LANG: Record<Lang, string> = {
  en: 'name:en', zh: 'name:zh', 'zh-Hant': 'name:zh', ja: 'name:ja',
  ko: 'name:ko', ru: 'name:ru', es: 'name:es', fr: 'name:fr',
  de: 'name:de', ar: 'name:ar', pt: 'name:pt', it: 'name:it',
};

const KEY = 'opnmap.lang';
const LANGS = Object.keys(LANG_NAMES) as Lang[];

export function initialLang(): Lang {
  const saved = localStorage.getItem(KEY) as Lang | null;
  return saved && LANGS.includes(saved) ? saved : 'en'; // default English
}

export function saveLang(l: Lang): void {
  localStorage.setItem(KEY, l);
}
