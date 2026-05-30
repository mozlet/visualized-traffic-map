//! Trace real network paths to the busiest recent destinations with `mtr`,
//! geolocate each hop, and store the route. `mtr-packet` carries cap_net_raw so
//! this runs unprivileged. Real measured paths beat any inferred topology.

use std::net::IpAddr;
use std::time::Duration;

use anyhow::Context;
use futures_util::future::join_all;
use geoip::GeoResolver;
use serde::Serialize;
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tokio::process::Command;

const MAX_HOPS: &str = "20";
const CYCLES: &str = "3";
// Throughput tuned up so the RTT-relocate loop covers active CDN/cloud IPs faster
// — most flows hit a CDN whose MaxMind coord is the operator HQ, and only a real
// measured RTT can pull the locally-served ones back to the edge. More per batch
// + a tighter interval ≈ doubles coverage without overloading a LAN gateway.
const CONCURRENCY: usize = 10;
const BATCH: i64 = 48;

#[derive(Serialize)]
struct Hop {
    idx: i64,
    ip: String,
    lat: Option<f64>,
    lon: Option<f64>,
    country: Option<String>,
    rtt_ms: Option<f64>,
}

// Recent public destinations not traced in the last 6 hours, prioritised so the
// RTT-relocate loop (geo-doctor) closes on the cases that need it most:
//   1) IPs geo-doctor flagged dirty but couldn't yet correct (corr_lat IS NULL) —
//      typically CDN/cloud anycast (Akamai/Cloudflare/Google) whose MaxMind coord
//      is the operator HQ, not the local edge actually serving us. A measured path
//      gives the RTT that lets geo-doctor relocate them to a plausible local hop.
//   2) then the busiest, so high-volume routes still get real geometry.
const CANDIDATES_SQL: &str = r#"
WITH recent AS (
  SELECT dst_addr, sum(octets) AS bytes
  FROM flows
  WHERE recv_time > now() - interval '30 minutes'
    AND NOT (dst_addr <<= '10.0.0.0/8' OR dst_addr <<= '172.16.0.0/12' OR dst_addr <<= '192.168.0.0/16'
             OR dst_addr <<= '127.0.0.0/8' OR dst_addr <<= '169.254.0.0/16' OR dst_addr <<= '100.64.0.0/10'
             OR dst_addr <<= '224.0.0.0/4' OR dst_addr <<= 'fc00::/7' OR dst_addr <<= 'fe80::/10'
             OR dst_addr <<= 'ff00::/8')
    AND dst_addr NOT IN (SELECT dst_ip FROM routes WHERE traced_at > now() - interval '6 hours')
  GROUP BY dst_addr
)
SELECT host(r.dst_addr) AS ip
FROM recent r
LEFT JOIN ip_geo g ON g.ip = r.dst_addr
ORDER BY (g.dirty IS TRUE AND g.corr_lat IS NULL) DESC, r.bytes DESC NULLS LAST
LIMIT $1
"#;

async fn trace(ip: &str, geo: &GeoResolver) -> Option<Vec<Hop>> {
    let out = tokio::time::timeout(
        Duration::from_secs(35),
        Command::new("mtr")
            .args(["--json", "-n", "-c", CYCLES, "-m", MAX_HOPS, ip])
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let hubs = v["report"]["hubs"].as_array()?;
    let mut hops = Vec::new();
    for h in hubs {
        let host = h["host"].as_str().unwrap_or("???");
        let parsed: Result<IpAddr, _> = host.parse();
        let Ok(ipaddr) = parsed else { continue }; // skip "???" / non-responding
        let g = geo.lookup(ipaddr);
        hops.push(Hop {
            idx: h["count"].as_i64().unwrap_or(0),
            ip: host.to_string(),
            lat: g.as_ref().map(|x| x.lat),
            lon: g.as_ref().map(|x| x.lon),
            country: g.as_ref().and_then(|x| x.country.clone()),
            rtt_ms: h["Avg"].as_f64(),
        });
    }
    if hops.is_empty() {
        None
    } else {
        Some(hops)
    }
}

async fn store(pool: &PgPool, dst: &str, hops: &[Hop]) -> anyhow::Result<()> {
    let payload = json!(hops).to_string();
    sqlx::query(
        "INSERT INTO routes (dst_ip, traced_at, hop_count, hops)
         VALUES ($1::inet, now(), $2, $3::jsonb)
         ON CONFLICT (dst_ip) DO UPDATE SET
            traced_at = now(), hop_count = EXCLUDED.hop_count, hops = EXCLUDED.hops",
    )
    .bind(dst)
    .bind(hops.len() as i32)
    .bind(payload)
    .execute(pool)
    .await
    .context("upsert route")?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL not set")?;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await?;

    let db_path = std::env::var("GEOIP_DB_PATH").ok();
    let home_lat = env_f64("HOME_LAT", 0.0);
    let home_lon = env_f64("HOME_LON", 0.0);
    let geo = GeoResolver::new(
        db_path.as_deref().map(std::path::Path::new),
        home_lat,
        home_lon,
    );

    let interval = env_u64("MTR_INTERVAL_SECS", 90);
    eprintln!("mtr-worker: every {interval}s, {CONCURRENCY} concurrent, top {BATCH} dst");

    loop {
        match run_batch(&pool, &geo).await {
            Ok(n) => eprintln!("mtr-worker: traced {n} destinations"),
            Err(e) => eprintln!("mtr-worker: batch error: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}

async fn run_batch(pool: &PgPool, geo: &GeoResolver) -> anyhow::Result<usize> {
    let ips: Vec<String> = sqlx::query_scalar(CANDIDATES_SQL)
        .bind(BATCH)
        .fetch_all(pool)
        .await
        .context("candidates")?;
    let mut traced = 0;
    for chunk in ips.chunks(CONCURRENCY) {
        let results = join_all(
            chunk
                .iter()
                .map(|ip| async move { (ip.clone(), trace(ip, geo).await) }),
        )
        .await;
        for (ip, hops) in results {
            if let Some(hops) = hops {
                if store(pool, &ip, &hops).await.is_ok() {
                    traced += 1;
                }
            }
        }
    }
    Ok(traced)
}

fn env_f64(k: &str, d: f64) -> f64 {
    std::env::var(k)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(d)
}
fn env_u64(k: &str, d: u64) -> u64 {
    std::env::var(k)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(d)
}
