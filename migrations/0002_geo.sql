-- Geo enrichment columns (filled by ingestor via crates/geoip).

ALTER TABLE flows
    ADD COLUMN IF NOT EXISTS src_lat     double precision,
    ADD COLUMN IF NOT EXISTS src_lon     double precision,
    ADD COLUMN IF NOT EXISTS dst_lat     double precision,
    ADD COLUMN IF NOT EXISTS dst_lon     double precision,
    ADD COLUMN IF NOT EXISTS src_country text,
    ADD COLUMN IF NOT EXISTS dst_country text;
