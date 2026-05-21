-- Self-correcting geo: canonical per-IP geolocation that improves with use,
-- plus an audit trail for every automated decision (no if-else heuristics —
-- corrections are derived from observed-flow statistics).

CREATE TABLE IF NOT EXISTS ip_geo (
    ip          inet PRIMARY KEY,
    lat         double precision,
    lon         double precision,
    country     text,
    source      text        NOT NULL DEFAULT 'observed', -- observed|asn-pop|manual
    obs_count   bigint       NOT NULL DEFAULT 0,
    confidence  real         NOT NULL DEFAULT 0,
    dirty       boolean      NOT NULL DEFAULT false,
    first_seen  timestamptz,
    last_seen   timestamptz,
    updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- Append-only audit: answers "why was this IP's geo set to X?".
CREATE TABLE IF NOT EXISTS geo_decisions (
    id          bigserial PRIMARY KEY,
    ip          inet        NOT NULL,
    ts          timestamptz NOT NULL DEFAULT now(),
    reason      text        NOT NULL,
    old_lat     double precision,
    old_lon     double precision,
    old_source  text,
    new_lat     double precision,
    new_lon     double precision,
    new_source  text,
    obs_count   bigint,
    confidence  real,
    notes       text
);
CREATE INDEX IF NOT EXISTS geo_decisions_ip_idx ON geo_decisions (ip, ts DESC);

-- 'manual' overrides are never touched by the doctor (protection tier).
