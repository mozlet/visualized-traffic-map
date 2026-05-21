//! Self-correcting geolocation pass. Aggregates observed flow geo per public IP
//! into the canonical `ip_geo` table and records every change in `geo_decisions`.
//! The correction is statistical (most-observed coordinate + shared-coordinate
//! AS-default detection + observation-count confidence) — no if-else heuristics.
//! `source='manual'` rows are never overwritten.
//!
//! Run once (default) or as a periodic daemon with GEO_DOCTOR_INTERVAL_SECS set.
//! TODO: mtr-measured hop paths + asn_pop PoP replacement (predecessor's tier 3).

use std::time::Duration;

use anyhow::Context;
use sqlx::postgres::PgPoolOptions;

// One-statement pass: all CTEs see the pre-statement snapshot, so `changed`
// compares against the old ip_geo while the final upsert writes the new state.
const PASS_SQL: &str = r#"
WITH obs AS (
    SELECT src_addr AS ip, src_lat AS lat, src_lon AS lon, src_country AS country, recv_time
    FROM flows WHERE src_lat IS NOT NULL
    UNION ALL
    SELECT dst_addr, dst_lat, dst_lon, dst_country, recv_time
    FROM flows WHERE dst_lat IS NOT NULL
),
pub AS (
    SELECT * FROM obs WHERE NOT (
        ip <<= '10.0.0.0/8' OR ip <<= '172.16.0.0/12' OR ip <<= '192.168.0.0/16'
        OR ip <<= '127.0.0.0/8' OR ip <<= '169.254.0.0/16' OR ip <<= '100.64.0.0/10'
        OR ip <<= '224.0.0.0/4' OR ip <<= '255.255.255.255/32'
        OR ip <<= 'fc00::/7' OR ip <<= 'fe80::/10' OR ip <<= 'ff00::/8' OR ip = '::1'
    )
),
per_ip AS (
    SELECT ip,
           mode() WITHIN GROUP (ORDER BY lat) AS lat,
           mode() WITHIN GROUP (ORDER BY lon) AS lon,
           mode() WITHIN GROUP (ORDER BY country) AS country,
           count(*) AS obs_count,
           min(recv_time) AS first_seen,
           max(recv_time) AS last_seen
    FROM pub GROUP BY ip
),
shared AS (
    SELECT lat, lon, count(*) AS ip_share FROM per_ip GROUP BY lat, lon
),
computed AS (
    SELECT p.ip, p.lat, p.lon, p.country, p.obs_count, p.first_seen, p.last_seen,
           (s.ip_share >= 8) AS dirty,
           LEAST(0.99, 1 - 1.0 / (1 + p.obs_count))::real
             * (CASE WHEN s.ip_share >= 8 THEN 0.4 ELSE 1 END) AS confidence
    FROM per_ip p JOIN shared s ON s.lat = p.lat AND s.lon = p.lon
),
changed AS (
    SELECT c.*, g.lat AS old_lat, g.lon AS old_lon, g.source AS old_source
    FROM computed c LEFT JOIN ip_geo g ON g.ip = c.ip
    WHERE (g.ip IS NULL
           OR g.lat IS DISTINCT FROM c.lat
           OR g.lon IS DISTINCT FROM c.lon
           OR g.dirty IS DISTINCT FROM c.dirty)
      AND (g.source IS NULL OR g.source <> 'manual')
),
ins_dec AS (
    INSERT INTO geo_decisions
        (ip, reason, old_lat, old_lon, old_source, new_lat, new_lon, new_source, obs_count, confidence, notes)
    SELECT ip,
           CASE WHEN old_lat IS NULL THEN 'new'
                WHEN dirty THEN 'flag-dirty(shared-coord)'
                ELSE 'update' END,
           old_lat, old_lon, old_source, lat, lon, 'observed', obs_count, confidence,
           'obs=' || obs_count
    FROM changed
    RETURNING 1
)
INSERT INTO ip_geo
    (ip, lat, lon, country, source, obs_count, confidence, dirty, first_seen, last_seen, updated_at)
SELECT ip, lat, lon, country, 'observed', obs_count, confidence, dirty, first_seen, last_seen, now()
FROM computed
ON CONFLICT (ip) DO UPDATE SET
    lat = EXCLUDED.lat, lon = EXCLUDED.lon, country = EXCLUDED.country,
    obs_count = EXCLUDED.obs_count, confidence = EXCLUDED.confidence,
    dirty = EXCLUDED.dirty, last_seen = EXCLUDED.last_seen, updated_at = now()
WHERE ip_geo.source <> 'manual';
"#;

// Tier-3: relocate dirty IPs whose MaxMind coordinate is provably wrong (real
// mtr RTT proves it is too far) onto the deepest RTT-plausible hop of their
// measured path. Physics-gated (speed-of-light bound), not heuristic; every
// move is audited and self-heals when the contradiction no longer holds.
// $1 = home lat, $2 = home lon (the mtr trace origin).
const RELOCATE_SQL: &str = r#"
WITH cand AS (
    SELECT g.ip, g.lat AS mm_lat, g.lon AS mm_lon, g.country AS mm_country, r.hops, r.hop_count
    FROM ip_geo g JOIN routes r ON r.dst_ip = g.ip
    WHERE g.dirty AND g.source <> 'manual'
),
hopd AS (
    SELECT c.ip, c.hop_count,
           (h->>'idx')::int AS idx, (h->>'lat')::float8 AS hlat, (h->>'lon')::float8 AS hlon,
           h->>'country' AS hcountry, h->>'ip' AS hip, (h->>'rtt_ms')::float8 AS rtt,
           geo_haversine_km($1, $2, (h->>'lat')::float8, (h->>'lon')::float8) AS hdist
    FROM cand c, jsonb_array_elements(c.hops) h
    WHERE (h->>'lat') IS NOT NULL AND (h->>'rtt_ms') IS NOT NULL
),
impossible AS (  -- MaxMind farther than the RTT*100km speed-of-light bound allows
    SELECT c.ip, c.mm_lat, c.mm_lon, c.mm_country,
           geo_haversine_km($1, $2, c.mm_lat, c.mm_lon) AS mm_dist,
           (SELECT max(rtt) FROM hopd h WHERE h.ip = c.ip) AS dst_rtt
    FROM cand c
),
imp AS (SELECT * FROM impossible WHERE dst_rtt IS NOT NULL AND mm_dist > dst_rtt * 100),
anchor AS (  -- deepest on-path hop that IS reachable within its own RTT bound
    SELECT DISTINCT ON (h.ip) h.ip, h.idx AS anchor_idx, h.hlat, h.hlon, h.hcountry, h.hip,
           h.hop_count, h.rtt AS anchor_rtt
    FROM hopd h JOIN imp i ON i.ip = h.ip
    WHERE h.hdist <= h.rtt * 100 + 50
    ORDER BY h.ip, h.idx DESC
),
relocate AS (
    SELECT i.ip, a.hlat, a.hlon, a.hcountry, a.hip, i.dst_rtt, a.anchor_idx, a.hop_count,
           i.mm_country, i.mm_dist,
           LEAST(0.85, 0.55 + 0.30 * (a.anchor_idx::float8 / GREATEST(a.hop_count, 1)))::real AS conf
    FROM imp i JOIN anchor a ON a.ip = i.ip
),
prev AS (SELECT ip, corr_lat, corr_lon, corr_source FROM ip_geo),
ins_dec AS (
    INSERT INTO geo_decisions
        (ip, reason, old_lat, old_lon, old_source, new_lat, new_lon, new_source, confidence, notes)
    SELECT r.ip, 'relocate(mtr-rtt)', p.corr_lat, p.corr_lon, COALESCE(p.corr_source, 'observed'),
           r.hlat, r.hlon, 'mtr-rtt', r.conf,
           format('mm=%s@%skm rtt=%sms bound=%skm -> anchor=%s hop %s/%s',
                  r.mm_country, round(r.mm_dist::numeric), round(r.dst_rtt::numeric, 1),
                  round((r.dst_rtt * 100)::numeric), r.hip, r.anchor_idx, r.hop_count)
    FROM relocate r LEFT JOIN prev p ON p.ip = r.ip
    WHERE p.corr_lat IS DISTINCT FROM r.hlat OR p.corr_lon IS DISTINCT FROM r.hlon
    RETURNING 1
),
do_update AS (
    UPDATE ip_geo g SET
        corr_lat = r.hlat, corr_lon = r.hlon, corr_country = r.hcountry,
        corr_source = 'mtr-rtt', corr_conf = r.conf, corr_rtt_ms = r.dst_rtt,
        corr_anchor_ip = r.hip::inet, corr_at = now()
    FROM relocate r WHERE g.ip = r.ip AND g.source <> 'manual'
    RETURNING g.ip
)
UPDATE ip_geo g SET  -- self-heal: drop corrections that no longer apply
    corr_lat = NULL, corr_lon = NULL, corr_country = NULL, corr_source = NULL,
    corr_conf = NULL, corr_rtt_ms = NULL, corr_anchor_ip = NULL, corr_at = NULL
WHERE g.corr_source = 'mtr-rtt' AND g.ip NOT IN (SELECT ip FROM relocate);
"#;

async fn run_pass(pool: &sqlx::PgPool, home_lat: f64, home_lon: f64) -> anyhow::Result<()> {
    let affected = sqlx::query(PASS_SQL)
        .execute(pool)
        .await
        .context("geo-doctor observed pass")?;
    sqlx::query(RELOCATE_SQL)
        .bind(home_lat)
        .bind(home_lon)
        .execute(pool)
        .await
        .context("geo-doctor relocate pass")?;
    let ips: i64 = sqlx::query_scalar("SELECT count(*) FROM ip_geo")
        .fetch_one(pool)
        .await?;
    let dirty: i64 = sqlx::query_scalar("SELECT count(*) FROM ip_geo WHERE dirty")
        .fetch_one(pool)
        .await?;
    let corrected: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ip_geo WHERE corr_source = 'mtr-rtt'")
            .fetch_one(pool)
            .await?;
    let decisions: i64 = sqlx::query_scalar("SELECT count(*) FROM geo_decisions")
        .fetch_one(pool)
        .await?;
    eprintln!(
        "geo-doctor: upserted rows={} | ip_geo total={ips} dirty={dirty} mtr-relocated={corrected} | decisions total={decisions}",
        affected.rows_affected()
    );
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL not set")?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await?;
    let home_lat = env_f64("HOME_LAT", 0.0);
    let home_lon = env_f64("HOME_LON", 0.0);

    match std::env::var("GEO_DOCTOR_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        Some(secs) => {
            eprintln!("geo-doctor: daemon mode, every {secs}s");
            let mut tick = tokio::time::interval(Duration::from_secs(secs));
            loop {
                tick.tick().await;
                if let Err(e) = run_pass(&pool, home_lat, home_lon).await {
                    eprintln!("geo-doctor: pass error: {e}");
                }
            }
        }
        None => run_pass(&pool, home_lat, home_lon).await,
    }
}

fn env_f64(k: &str, d: f64) -> f64 {
    std::env::var(k)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(d)
}
