-- Canonical per-dst-IP application, aggregated from sni_log (mirrors ip_geo).
-- A shared CDN IP serves many SNIs/apps → distinct_app>1 lowers confidence.
-- app_decisions audits every new/changed classification. manual is protected.

CREATE TABLE IF NOT EXISTS ip_app (
    ip           inet PRIMARY KEY,
    app          text,
    category     text,
    sni          text,                              -- most-common SNI for this IP
    obs_count    bigint      NOT NULL DEFAULT 0,
    distinct_sni int         NOT NULL DEFAULT 0,
    confidence   real        NOT NULL DEFAULT 0,
    source       text        NOT NULL DEFAULT 'sni', -- sni | manual
    first_seen   timestamptz,
    last_seen    timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ip_app_app_idx ON ip_app (app) WHERE app IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_decisions (
    id          bigserial PRIMARY KEY,
    ts          timestamptz NOT NULL DEFAULT now(),
    ip          inet,
    sni         text,
    app         text,
    category    text,
    confidence  real,
    reason      text        NOT NULL,  -- new | changed
    notes       text
);
CREATE INDEX IF NOT EXISTS app_decisions_ip_idx ON app_decisions (ip, ts DESC);
