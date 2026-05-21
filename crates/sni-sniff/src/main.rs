//! Reads a pcap byte stream on stdin (from `ssh opnsense tcpdump -U -w -`),
//! extracts TLS ClientHello SNI per connection, classifies it against the
//! data-driven `app_rules` table, and persists to PostgreSQL (`sni_log`) while
//! publishing live to Redis `sni:live`. Composes like the flowd pipeline:
//! stock tcpdump captures on OPNsense, this parses + classifies on u0.
//!
//! Without DATABASE_URL it runs as a stdout debug filter (prints JSON lines).

use std::time::Duration;

use anyhow::{bail, Context};
use redis::AsyncCommands;
use sni_sniff::{classify, parse_client_hello_sni, parse_packet, read_u32, RuleMap};
use tokio::io::{AsyncReadExt, BufReader};

const LIVE_CHANNEL: &str = "sni:live";

// Aggregate recent sni_log into the canonical ip_app table (most-common app per
// dst IP). distinct_app>1 means a shared CDN IP, which lowers confidence. Every
// new/changed classification is audited; manual rows are never overwritten.
const IP_APP_SQL: &str = r#"
WITH agg AS (
    SELECT dst_addr AS ip,
           mode() WITHIN GROUP (ORDER BY app) FILTER (WHERE app IS NOT NULL) AS app,
           mode() WITHIN GROUP (ORDER BY category) FILTER (WHERE category IS NOT NULL) AS category,
           mode() WITHIN GROUP (ORDER BY sni) AS sni,
           count(*) AS obs_count,
           count(DISTINCT sni)::int AS distinct_sni,
           GREATEST(count(DISTINCT app) FILTER (WHERE app IS NOT NULL), 1) AS distinct_app,
           min(ts) AS first_seen, max(ts) AS last_seen
    FROM sni_log
    WHERE ts > now() - interval '24 hours'
    GROUP BY dst_addr
),
computed AS (
    SELECT ip, app, category, sni, obs_count, distinct_sni, first_seen, last_seen,
           (LEAST(0.95, 1 - 1.0 / (1 + obs_count)) / distinct_app)::real AS confidence
    FROM agg
),
prev AS (SELECT ip, app FROM ip_app),
ins_dec AS (
    INSERT INTO app_decisions (ip, sni, app, category, confidence, reason, notes)
    SELECT c.ip, c.sni, c.app, c.category, c.confidence,
           CASE WHEN p.ip IS NULL THEN 'new' ELSE 'changed' END,
           'obs=' || c.obs_count || ' distinct_sni=' || c.distinct_sni
    FROM computed c LEFT JOIN prev p ON p.ip = c.ip
    WHERE c.app IS NOT NULL AND p.app IS DISTINCT FROM c.app
    RETURNING 1
)
INSERT INTO ip_app (ip, app, category, sni, obs_count, distinct_sni, confidence, source, first_seen, last_seen, updated_at)
SELECT ip, app, category, sni, obs_count, distinct_sni, confidence, 'sni', first_seen, last_seen, now()
FROM computed
ON CONFLICT (ip) DO UPDATE SET
    app = EXCLUDED.app, category = EXCLUDED.category, sni = EXCLUDED.sni,
    obs_count = EXCLUDED.obs_count, distinct_sni = EXCLUDED.distinct_sni,
    confidence = EXCLUDED.confidence, last_seen = EXCLUDED.last_seen, updated_at = now()
WHERE ip_app.source <> 'manual';
"#;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let pg = match std::env::var("DATABASE_URL") {
        Ok(url) => Some(
            sqlx::postgres::PgPoolOptions::new()
                .max_connections(2)
                .connect(&url)
                .await
                .context("connect postgres")?,
        ),
        Err(_) => {
            eprintln!("sni-sniff: no DATABASE_URL — debug mode (stdout JSON only)");
            None
        }
    };

    // Live publish only matters in DB mode; tolerate Redis being unavailable.
    let mut redis = if pg.is_some() {
        let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());
        match redis::Client::open(url) {
            Ok(c) => c.get_multiplexed_async_connection().await.ok(),
            Err(e) => {
                eprintln!("sni-sniff: redis open failed ({e}); no live publish");
                None
            }
        }
    } else {
        None
    };

    // Load classification rules; refresh periodically so edits take effect live.
    let rules = std::sync::Arc::new(tokio::sync::RwLock::new(RuleMap::new()));
    if let Some(pg) = &pg {
        *rules.write().await = load_rules(pg).await;
        eprintln!("sni-sniff: loaded {} app rules", rules.read().await.len());
        spawn_rule_refresh(pg.clone(), rules.clone());
        spawn_ip_app_pass(pg.clone());
    }

    let mut r = BufReader::with_capacity(1 << 16, tokio::io::stdin());

    let mut gh = [0u8; 24];
    r.read_exact(&mut gh)
        .await
        .context("read pcap global header")?;
    let le = match gh[0..4] {
        [0xd4, 0xc3, 0xb2, 0xa1] | [0x4d, 0x3c, 0xb2, 0xa1] => true,
        [0xa1, 0xb2, 0xc3, 0xd4] | [0xa1, 0xb2, 0x3c, 0x4d] => false,
        _ => bail!("stdin is not a pcap stream (bad magic)"),
    };
    let linktype = read_u32(&gh[20..24], le);
    eprintln!("sni-sniff: pcap stream ok (linktype={linktype}, le={le})");

    let mut hdr = [0u8; 16];
    let mut pkt = vec![0u8; 65536];
    let mut count: u64 = 0;
    loop {
        match r.read_exact(&mut hdr).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e).context("read record header"),
        }
        let incl = read_u32(&hdr[8..12], le) as usize;
        if incl > pkt.len() {
            pkt.resize(incl, 0);
        }
        r.read_exact(&mut pkt[..incl])
            .await
            .context("read packet body")?;

        let Some(conn) = parse_packet(linktype, &pkt[..incl]) else {
            continue;
        };
        let Some(sni) = parse_client_hello_sni(conn.tcp_payload) else {
            continue;
        };
        let ts = read_u32(&hdr[0..4], le) as f64 + read_u32(&hdr[4..8], le) as f64 / 1e6;

        let (app, category) = {
            let g = rules.read().await;
            classify(&sni, &g)
                .map(|(a, c, _, _)| (Some(a.to_string()), c.map(|s| s.to_string())))
                .unwrap_or((None, None))
        };

        let payload = serde_json::json!({
            "ts": ts, "src": conn.src.to_string(), "sport": conn.src_port,
            "dst": conn.dst.to_string(), "dport": conn.dst_port,
            "sni": sni, "app": app, "category": category,
        });

        match &pg {
            None => println!("{payload}"),
            Some(pool) => {
                if let Err(e) = sqlx::query(
                    "INSERT INTO sni_log (ts, src_addr, src_port, dst_addr, dst_port, sni, app, category)
                     VALUES (to_timestamp($1), $2::inet, $3, $4::inet, $5, $6, $7, $8)",
                )
                .bind(ts)
                .bind(conn.src.to_string())
                .bind(conn.src_port as i32)
                .bind(conn.dst.to_string())
                .bind(conn.dst_port as i32)
                .bind(&sni)
                .bind(&app)
                .bind(&category)
                .execute(pool)
                .await
                {
                    eprintln!("sni-sniff: insert error: {e}");
                }
                if let Some(con) = redis.as_mut() {
                    let _: Result<(), _> = con.publish(LIVE_CHANNEL, payload.to_string()).await;
                }
            }
        }
        count += 1;
        if count % 200 == 0 {
            eprintln!("sni-sniff: {count} SNIs processed");
        }
    }
    eprintln!("sni-sniff: stream ended, {count} SNIs total");
    Ok(())
}

async fn load_rules(pg: &sqlx::PgPool) -> RuleMap {
    let rows: Vec<(String, String, Option<String>, f32)> =
        sqlx::query_as("SELECT suffix, app, category, confidence FROM app_rules")
            .fetch_all(pg)
            .await
            .unwrap_or_default();
    rows.into_iter()
        .map(|(s, a, c, conf)| (s, (a, c, conf)))
        .collect()
}

fn spawn_rule_refresh(pg: sqlx::PgPool, rules: std::sync::Arc<tokio::sync::RwLock<RuleMap>>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(300));
        tick.tick().await; // skip immediate
        loop {
            tick.tick().await;
            *rules.write().await = load_rules(&pg).await;
        }
    });
}

/// Periodically roll sni_log up into the canonical ip_app table.
fn spawn_ip_app_pass(pg: sqlx::PgPool) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(120));
        loop {
            tick.tick().await;
            if let Err(e) = sqlx::query(IP_APP_SQL).execute(&pg).await {
                eprintln!("sni-sniff: ip_app pass error: {e}");
            }
        }
    });
}
