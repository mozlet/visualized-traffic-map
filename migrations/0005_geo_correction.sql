-- Tier-3 self-correction: when a flow's MaxMind coordinate is provably wrong
-- (real mtr RTT proves it is physically too far), geo-doctor relocates the IP
-- onto the deepest RTT-plausible hop of its measured path. The override lives in
-- corr_* columns so the observed (raw MaxMind) coordinate stays untouched as the
-- statistical base; consumers read COALESCE(corr_lat, lat).

ALTER TABLE ip_geo
    ADD COLUMN IF NOT EXISTS corr_lat       double precision,
    ADD COLUMN IF NOT EXISTS corr_lon       double precision,
    ADD COLUMN IF NOT EXISTS corr_country   text,
    ADD COLUMN IF NOT EXISTS corr_source    text,              -- e.g. 'mtr-rtt'
    ADD COLUMN IF NOT EXISTS corr_conf       real,
    ADD COLUMN IF NOT EXISTS corr_rtt_ms     double precision, -- measured RTT that justified the move
    ADD COLUMN IF NOT EXISTS corr_anchor_ip  inet,             -- on-path hop we anchored to
    ADD COLUMN IF NOT EXISTS corr_at         timestamptz;

CREATE INDEX IF NOT EXISTS ip_geo_corr_idx ON ip_geo (ip) WHERE corr_lat IS NOT NULL;

-- Great-circle distance in km. Used to test the speed-of-light bound: a hop
-- reachable in `rtt` ms cannot be farther than ~rtt*100 km from the trace origin
-- (fiber ~200 km/ms one-way, halved for round-trip; real paths are longer than
-- straight-line, so the bound is conservative and over-flags nothing).
CREATE OR REPLACE FUNCTION geo_haversine_km(
    lat1 double precision, lon1 double precision,
    lat2 double precision, lon2 double precision
) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT 2 * 6371 * asin(sqrt(
        power(sin(radians(lat2 - lat1) / 2), 2)
        + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
    ));
$$;
