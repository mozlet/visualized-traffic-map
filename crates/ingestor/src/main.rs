//! Reads flowd binary records from stdin (the output of
//! `ssh opnsense cat /var/log/flowd.log`), fans each flow out to:
//!   * Redis  — hot tier: XADD to stream `flows:raw` (approx-trimmed) and
//!              PUBLISH to `flows:live` for WebSocket fanout.
//!   * Postgres — cold tier: batched INSERT into the `flows` hypertable.
//!
//! Parsing is CPU-bound and synchronous, so it runs on a dedicated blocking
//! thread feeding an async drain loop over an mpsc channel.

use std::io::{BufRead, BufReader, Read};
use std::net::IpAddr;
use std::time::Duration;

use anyhow::Context;
use chrono::{DateTime, Utc};
use flowd_parse::{FlowIter, FlowRecord};
use geoip::{GeoPoint, GeoResolver};
use ipnetwork::{IpNetwork, Ipv4Network, Ipv6Network};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, QueryBuilder};
use tokio::sync::mpsc;

const STREAM_KEY: &str = "flows:raw";
const STREAM_MAXLEN: usize = 200_000;
const PUBSUB_CHANNEL: &str = "flows:live";
const WATERMARK_KEY: &str = "flow:watermark";
const BATCH_MAX_ROWS: usize = 1_000;
const FLUSH_INTERVAL: Duration = Duration::from_millis(2_000);

struct FlowRow {
    json: String,
    recv_time: DateTime<Utc>,
    src_addr: IpNetwork,
    dst_addr: IpNetwork,
    src_port: Option<i32>,
    dst_port: Option<i32>,
    protocol: Option<i16>,
    tcp_flags: Option<i16>,
    tos: Option<i16>,
    packets: Option<i64>,
    octets: Option<i64>,
    if_index_in: Option<i32>,
    if_index_out: Option<i32>,
    gateway_addr: Option<IpNetwork>,
    agent_addr: Option<IpNetwork>,
    src_as: Option<i64>,
    dst_as: Option<i64>,
    netflow_ver: Option<i16>,
    flow_start: Option<DateTime<Utc>>,
    flow_end: Option<DateTime<Utc>>,
    src_lat: Option<f64>,
    src_lon: Option<f64>,
    dst_lat: Option<f64>,
    dst_lon: Option<f64>,
    src_country: Option<String>,
    dst_country: Option<String>,
}

fn to_net(ip: IpAddr) -> IpNetwork {
    match ip {
        IpAddr::V4(a) => IpNetwork::V4(Ipv4Network::new(a, 32).expect("v4 /32")),
        IpAddr::V6(a) => IpNetwork::V6(Ipv6Network::new(a, 128).expect("v6 /128")),
    }
}

fn recv_time(rec: &FlowRecord) -> Option<DateTime<Utc>> {
    let sec = rec.recv_sec? as i64;
    let nanos = rec.recv_usec.unwrap_or(0).saturating_mul(1000);
    DateTime::from_timestamp(sec, nanos)
}

/// NetFlow flow_start/flow_finish are switch-uptime-relative milliseconds.
/// Convert to wall clock using recv_sec and sys_uptime_ms (see flowparser.py).
fn wall_clock_times(rec: &FlowRecord) -> (Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
    let (Some(recv), Some(uptime), Some(start), Some(finish)) = (
        rec.recv_sec,
        rec.sys_uptime_ms,
        rec.flow_start,
        rec.flow_finish,
    ) else {
        return (None, None);
    };
    let recv = recv as f64;
    let end_wall = recv - (uptime as f64 - finish as f64) / 1000.0;
    let start_wall = end_wall - (finish as f64 - start as f64) / 1000.0;
    (secs_f64_to_dt(start_wall), secs_f64_to_dt(end_wall))
}

fn secs_f64_to_dt(secs: f64) -> Option<DateTime<Utc>> {
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    let whole = secs.trunc() as i64;
    let nanos = ((secs.fract()) * 1e9).round() as u32;
    DateTime::from_timestamp(whole, nanos)
}

/// Mirror flowparser.py's skip rule: a flow is only useful with src+dst
/// addresses, byte/packet counts and a receive time.
fn to_row(rec: &FlowRecord, geo: &GeoResolver) -> Option<FlowRow> {
    let recv_time = recv_time(rec)?;
    let src = rec.src_addr?;
    let dst = rec.dst_addr?;
    rec.packets?;
    rec.octets?;
    let (flow_start, flow_end) = wall_clock_times(rec);

    let src_geo = geo.lookup(src);
    let dst_geo = geo.lookup(dst);
    let json = enriched_json(rec, src_geo.as_ref(), dst_geo.as_ref())?;

    Some(FlowRow {
        json,
        recv_time,
        src_addr: to_net(src),
        dst_addr: to_net(dst),
        src_port: rec.src_port.map(i32::from),
        dst_port: rec.dst_port.map(i32::from),
        protocol: rec.protocol.map(i16::from),
        tcp_flags: rec.tcp_flags.map(i16::from),
        tos: rec.tos.map(i16::from),
        packets: rec.packets.map(|v| v as i64),
        octets: rec.octets.map(|v| v as i64),
        if_index_in: rec.if_index_in.map(|v| v as i32),
        if_index_out: rec.if_index_out.map(|v| v as i32),
        gateway_addr: rec.gateway_addr.map(to_net),
        agent_addr: rec.agent_addr.map(to_net),
        src_as: rec.src_as.map(i64::from),
        dst_as: rec.dst_as.map(i64::from),
        netflow_ver: rec.netflow_version.map(|v| v as i16),
        flow_start,
        flow_end,
        src_lat: src_geo.as_ref().map(|g| g.lat),
        src_lon: src_geo.as_ref().map(|g| g.lon),
        dst_lat: dst_geo.as_ref().map(|g| g.lat),
        dst_lon: dst_geo.as_ref().map(|g| g.lon),
        src_country: src_geo.as_ref().and_then(|g| g.country.clone()),
        dst_country: dst_geo.as_ref().and_then(|g| g.country.clone()),
    })
}

/// Serialize the flow record with `src_geo` / `dst_geo` embedded, so the
/// frontend receives coordinates directly off the Redis pub/sub channel.
fn enriched_json(
    rec: &FlowRecord,
    src_geo: Option<&GeoPoint>,
    dst_geo: Option<&GeoPoint>,
) -> Option<String> {
    let mut value = serde_json::to_value(rec).ok()?;
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("src_geo".into(), serde_json::to_value(src_geo).ok()?);
        map.insert("dst_geo".into(), serde_json::to_value(dst_geo).ok()?);
        // Well-known service from the port/proto (nmap table). Fills the gap
        // SNI can't see (SNI is 443-only); null when not a known TCP/UDP port.
        let service = services::flow_service(rec.src_port, rec.dst_port, rec.protocol);
        map.insert("service".into(), serde_json::to_value(service).ok()?);
    }
    serde_json::to_string(&value).ok()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let database_url =
        std::env::var("DATABASE_URL").context("DATABASE_URL not set (see .env.example)")?;
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());

    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .context("connect postgres")?;

    let redis_client = redis::Client::open(redis_url).context("open redis")?;
    let mut redis_con = redis_client
        .get_multiplexed_async_connection()
        .await
        .context("connect redis")?;

    let geo = {
        let db_path = std::env::var("GEOIP_DB_PATH").ok();
        let home_lat = std::env::var("HOME_LAT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        let home_lon = std::env::var("HOME_LON")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        let resolver = GeoResolver::new(
            db_path.as_deref().map(std::path::Path::new),
            home_lat,
            home_lon,
        );
        eprintln!(
            "ingestor: geoip db={} home=({home_lat},{home_lon})",
            if resolver.has_database() {
                "loaded"
            } else {
                "absent (public IPs = no geo)"
            }
        );
        resolver
    };

    // Resume watermark: skip flows we've already ingested (lets run-live re-read
    // the whole flowd.log on restart without duplicating rows in PG).
    let start_watermark: u32 = redis::cmd("GET")
        .arg(WATERMARK_KEY)
        .query_async::<Option<u32>>(&mut redis_con)
        .await
        .ok()
        .flatten()
        .unwrap_or(0);
    let mut max_recv = start_watermark;
    eprintln!("ingestor: resume watermark recv_sec >= {start_watermark}");

    // Blocking parser thread → async channel.
    // INGEST_SOURCE=telegraf reads telegraf netflow JSON lines; default is the
    // flowd binary stream.
    let source = std::env::var("INGEST_SOURCE").unwrap_or_else(|_| "flowd".into());
    eprintln!("ingestor: source={source}");
    let (tx, mut rx) = mpsc::channel::<FlowRecord>(10_000);
    std::thread::spawn(move || {
        let reader = BufReader::new(std::io::stdin().lock());
        if source == "telegraf" {
            run_telegraf_parser(reader, tx);
        } else {
            run_parser(reader, tx);
        }
    });

    let mut batch: Vec<FlowRow> = Vec::with_capacity(BATCH_MAX_ROWS);
    let mut flush_timer = tokio::time::interval(FLUSH_INTERVAL);
    flush_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut total_inserted: u64 = 0;
    let mut total_skipped: u64 = 0;

    loop {
        tokio::select! {
            maybe_rec = rx.recv() => {
                match maybe_rec {
                    Some(rec) => {
                        if let Some(rs) = rec.recv_sec {
                            if rs < start_watermark {
                                total_skipped += 1;
                                continue;
                            }
                            if rs > max_recv {
                                max_recv = rs;
                            }
                        }
                        match to_row(&rec, &geo) {
                            Some(row) => {
                                batch.push(row);
                                if batch.len() >= BATCH_MAX_ROWS {
                                    total_inserted +=
                                        flush(&pool, &mut redis_con, &mut batch, max_recv).await?;
                                }
                            }
                            None => total_skipped += 1,
                        }
                    }
                    None => {
                        // Parser thread finished (EOF). Final flush and exit.
                        total_inserted += flush(&pool, &mut redis_con, &mut batch, max_recv).await?;
                        break;
                    }
                }
            }
            _ = flush_timer.tick() => {
                total_inserted += flush(&pool, &mut redis_con, &mut batch, max_recv).await?;
            }
            _ = tokio::signal::ctrl_c() => {
                eprintln!("ingestor: shutdown signal, flushing {} buffered", batch.len());
                total_inserted += flush(&pool, &mut redis_con, &mut batch, max_recv).await?;
                break;
            }
        }
    }

    eprintln!("ingestor: done. inserted={total_inserted} skipped={total_skipped}");
    Ok(())
}

fn run_parser<R: Read>(reader: R, tx: mpsc::Sender<FlowRecord>) {
    for item in FlowIter::new(reader) {
        match item {
            Ok(rec) => {
                if tx.blocking_send(rec).is_err() {
                    break; // receiver gone
                }
            }
            Err(e) => {
                eprintln!("ingestor: parse error: {e}");
                break;
            }
        }
    }
}

/// Read telegraf `inputs.netflow` JSON metrics (one object or batch array per
/// line, from `outputs.file files=["stdout"]`) and map them to FlowRecord.
fn run_telegraf_parser<R: BufRead>(reader: R, tx: mpsc::Sender<FlowRecord>) {
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("ingestor: telegraf json error: {e}");
                continue;
            }
        };
        let items: Vec<&serde_json::Value> = match v.as_array() {
            Some(arr) => arr.iter().collect(),
            None => vec![&v],
        };
        for item in items {
            if let Some(rec) = flowrecord_from_telegraf(item) {
                if tx.blocking_send(rec).is_err() {
                    return;
                }
            }
        }
    }
}

fn proto_num(s: &str) -> Option<u8> {
    Some(match s.to_ascii_lowercase().as_str() {
        "icmp" => 1,
        "igmp" => 2,
        "tcp" => 6,
        "udp" => 17,
        "gre" => 47,
        "esp" => 50,
        "ah" => 51,
        "ipv6-icmp" | "icmp6" | "ipv6_icmp" => 58,
        other => other.parse().ok()?,
    })
}

fn flowrecord_from_telegraf(v: &serde_json::Value) -> Option<FlowRecord> {
    let f = v.get("fields")?;
    let mut r = FlowRecord::default();
    if let Some(ms) = v.get("timestamp").and_then(|x| x.as_i64()) {
        r.recv_sec = Some((ms / 1000) as u32);
        r.recv_usec = Some(((ms % 1000) * 1000) as u32);
    }
    let s = |k: &str| f.get(k).and_then(|x| x.as_str());
    let u = |k: &str| f.get(k).and_then(|x| x.as_u64());
    r.src_addr = s("src").and_then(|x| x.parse().ok());
    r.dst_addr = s("dst").and_then(|x| x.parse().ok());
    r.gateway_addr = s("next_hop").and_then(|x| x.parse().ok());
    r.src_port = u("src_port").map(|n| n as u16);
    r.dst_port = u("dst_port").map(|n| n as u16);
    r.protocol = s("protocol").and_then(proto_num);
    // NetFlow per-flow byte/packet counts: prefer in_*, fall back to out_*.
    r.octets = u("in_bytes").filter(|&n| n > 0).or_else(|| u("out_bytes"));
    r.packets = u("in_packets")
        .filter(|&n| n > 0)
        .or_else(|| u("out_packets"));
    r.src_as = u("bgp_src_as").map(|n| n as u32);
    r.dst_as = u("bgp_dst_as").map(|n| n as u32);
    r.src_mask = u("src_mask").map(|n| n as u8);
    r.dst_mask = u("dst_mask").map(|n| n as u8);
    r.if_index_in = u("in_snmp").map(|n| n as u32);
    r.if_index_out = u("out_snmp").map(|n| n as u32);
    r.netflow_version = Some(9);
    // first/last_switched are ms since device boot. Anchoring sys_uptime to
    // last_switched makes wall_clock_times yield flow_end ≈ recv and
    // flow_start = recv − (last − first), i.e. the real flow duration — needed
    // to spread a long flow's bytes over its lifetime instead of dumping them at
    // export time (which over-states instantaneous throughput).
    if let (Some(fs), Some(ls)) = (u("first_switched"), u("last_switched")) {
        r.flow_start = Some(fs as u32);
        r.flow_finish = Some(ls as u32);
        r.sys_uptime_ms = Some(ls as u32);
    }
    r.agent_addr = v
        .get("tags")
        .and_then(|t| t.get("source"))
        .and_then(|x| x.as_str())
        .and_then(|x| x.parse().ok());
    Some(r)
}

async fn flush(
    pool: &PgPool,
    redis_con: &mut redis::aio::MultiplexedConnection,
    batch: &mut Vec<FlowRow>,
    watermark: u32,
) -> anyhow::Result<u64> {
    if batch.is_empty() {
        return Ok(0);
    }

    // Redis hot tier (pipelined): stream + pub/sub.
    let mut pipe = redis::pipe();
    for row in batch.iter() {
        pipe.cmd("XADD")
            .arg(STREAM_KEY)
            .arg("MAXLEN")
            .arg("~")
            .arg(STREAM_MAXLEN)
            .arg("*")
            .arg("j")
            .arg(&row.json)
            .ignore();
        pipe.cmd("PUBLISH")
            .arg(PUBSUB_CHANNEL)
            .arg(&row.json)
            .ignore();
    }
    pipe.query_async::<()>(redis_con)
        .await
        .context("redis pipeline")?;

    // Postgres cold tier: one multi-row INSERT.
    let mut qb = QueryBuilder::new(
        "INSERT INTO flows (recv_time, src_addr, dst_addr, src_port, dst_port, \
         protocol, tcp_flags, tos, packets, octets, if_index_in, if_index_out, \
         gateway_addr, agent_addr, src_as, dst_as, netflow_ver, flow_start, flow_end, \
         src_lat, src_lon, dst_lat, dst_lon, src_country, dst_country) ",
    );
    qb.push_values(batch.iter(), |mut b, row| {
        b.push_bind(row.recv_time)
            .push_bind(row.src_addr)
            .push_bind(row.dst_addr)
            .push_bind(row.src_port)
            .push_bind(row.dst_port)
            .push_bind(row.protocol)
            .push_bind(row.tcp_flags)
            .push_bind(row.tos)
            .push_bind(row.packets)
            .push_bind(row.octets)
            .push_bind(row.if_index_in)
            .push_bind(row.if_index_out)
            .push_bind(row.gateway_addr)
            .push_bind(row.agent_addr)
            .push_bind(row.src_as)
            .push_bind(row.dst_as)
            .push_bind(row.netflow_ver)
            .push_bind(row.flow_start)
            .push_bind(row.flow_end)
            .push_bind(row.src_lat)
            .push_bind(row.src_lon)
            .push_bind(row.dst_lat)
            .push_bind(row.dst_lon)
            .push_bind(&row.src_country)
            .push_bind(&row.dst_country);
    });
    qb.build().execute(pool).await.context("pg insert")?;

    // Advance the resume watermark after a successful write.
    let _: Result<(), _> = redis::cmd("SET")
        .arg(WATERMARK_KEY)
        .arg(watermark)
        .query_async::<()>(redis_con)
        .await;

    let n = batch.len() as u64;
    batch.clear();
    Ok(n)
}
