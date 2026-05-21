-- SNI-based application classification. Domain → app mapping lives in a
-- data-driven rules table (longest-suffix match, no if-else cascade); raw
-- observations land in sni_log. Coverage grows by adding rules informed by the
-- top unmatched SNIs (SELECT sni, count(*) FROM sni_log WHERE app IS NULL ...).

CREATE TABLE IF NOT EXISTS app_rules (
    suffix      text PRIMARY KEY,                 -- domain suffix, matched on label boundary
    app         text NOT NULL,
    category    text,
    confidence  real        NOT NULL DEFAULT 0.9,
    source      text        NOT NULL DEFAULT 'seed', -- seed | observed | manual
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Raw per-connection SNI observations, classified at capture time.
CREATE TABLE IF NOT EXISTS sni_log (
    ts        timestamptz NOT NULL DEFAULT now(),
    src_addr  inet        NOT NULL,
    src_port  integer,
    dst_addr  inet        NOT NULL,
    dst_port  integer,
    sni       text        NOT NULL,
    app       text,
    category  text
);
SELECT create_hypertable('sni_log', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '6 hours');
CREATE INDEX IF NOT EXISTS sni_log_dst_idx ON sni_log (dst_addr, ts DESC);
CREATE INDEX IF NOT EXISTS sni_log_app_idx ON sni_log (app, ts DESC);

-- Seed rules. More-specific suffixes win (longest match), so weixin.qq.com
-- classifies as WeChat even though qq.com → Tencent also matches.
INSERT INTO app_rules (suffix, app, category) VALUES
    ('weixin.qq.com',   'WeChat',     'chat'),
    ('wx.qq.com',       'WeChat',     'chat'),
    ('qq.com',          'Tencent',    'social'),
    ('qpic.cn',         'Tencent',    'social'),
    ('gtimg.com',       'Tencent',    'social'),
    ('tencent.com',     'Tencent',    'social'),
    ('meituan.com',     'Meituan',    'food'),
    ('meituan.net',     'Meituan',    'food'),
    ('dianping.com',    'Meituan',    'food'),
    ('taobao.com',      'Taobao',     'shopping'),
    ('tmall.com',       'Taobao',     'shopping'),
    ('alicdn.com',      'Alibaba',    'cdn'),
    ('alipay.com',      'Alipay',     'finance'),
    ('alipayobjects.com','Alipay',    'finance'),
    ('aliyuncs.com',    'Alibaba',    'cloud'),
    ('alibaba.com',     'Alibaba',    'cloud'),
    ('alidns.com',      'AliDNS',     'dns'),
    ('ucweb.com',       'UCBrowser',  'browser'),
    ('uc.cn',           'UCBrowser',  'browser'),
    ('douyin.com',      'Douyin',     'video'),
    ('bytedance.com',   'ByteDance',  'video'),
    ('byteimg.com',     'ByteDance',  'video'),
    ('snssdk.com',      'ByteDance',  'video'),
    ('toutiao.com',     'Toutiao',    'news'),
    ('bilibili.com',    'Bilibili',   'video'),
    ('hdslb.com',       'Bilibili',   'video'),
    ('baidu.com',       'Baidu',      'search'),
    ('bdstatic.com',    'Baidu',      'search'),
    ('jd.com',          'JD',         'shopping'),
    ('163.com',         'NetEase',    'media'),
    ('126.net',         'NetEase',    'media'),
    ('xiaomi.com',      'Xiaomi',     'iot'),
    ('mi.com',          'Xiaomi',     'iot'),
    ('miui.com',        'Xiaomi',     'iot'),
    ('huawei.com',      'Huawei',     'os'),
    ('dbankcdn.com',    'Huawei',     'os'),
    ('googlevideo.com', 'YouTube',    'video'),
    ('youtube.com',     'YouTube',    'video'),
    ('googleapis.com',  'Google',     'cloud'),
    ('gvt2.com',        'Google',     'os-update'),
    ('gvt1.com',        'Google',     'os-update'),
    ('gstatic.com',     'Google',     'cdn'),
    ('ggpht.com',       'Google',     'cdn'),
    ('google.com',      'Google',     'search'),
    ('apple.com',       'Apple',      'os'),
    ('icloud.com',      'Apple',      'os'),
    ('mzstatic.com',    'Apple',      'os'),
    ('cdn-apple.com',   'Apple',      'os'),
    ('windowsupdate.com','Microsoft', 'os-update'),
    ('microsoft.com',   'Microsoft',  'os'),
    ('live.com',        'Microsoft',  'os'),
    ('msftncsi.com',    'Microsoft',  'os'),
    ('amazonaws.com',   'AWS',        'cloud'),
    ('cloudflare.com',  'Cloudflare', 'cdn'),
    ('akamaized.net',   'Akamai',     'cdn'),
    ('akamai.net',      'Akamai',     'cdn'),
    ('facebook.com',    'Facebook',   'social'),
    ('fbcdn.net',       'Facebook',   'social'),
    ('github.com',      'GitHub',     'dev'),
    ('githubusercontent.com','GitHub','dev')
ON CONFLICT (suffix) DO NOTHING;
