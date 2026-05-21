-- Real measured paths (mtr traceroute). One row per destination, hops as JSONB:
--   [{ "idx":1, "ip":"...", "lat":.., "lon":.., "country":"..", "rtt_ms":.. }, ...]
CREATE TABLE IF NOT EXISTS routes (
    dst_ip     inet PRIMARY KEY,
    traced_at  timestamptz NOT NULL DEFAULT now(),
    hop_count  int         NOT NULL DEFAULT 0,
    hops       jsonb       NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS routes_traced_idx ON routes (traced_at DESC);
