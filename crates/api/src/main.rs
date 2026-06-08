//! HTTP + WebSocket API for the traffic map.
//!
//! * `GET /ws`           — WebSocket; streams live enriched flows. A single
//!                         Redis `SUBSCRIBE flows:live` task fans out to all
//!                         clients via a broadcast channel.
//! * `GET /api/recent`   — most recent N flows from the Redis stream (initial fill).
//! * `GET /api/config`   — frontend bootstrap (home coordinate).
//! * `/*`                — static files from the frontend directory.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;

use anyhow::Context;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use redis::aio::MultiplexedConnection;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

const LIVE_CHANNEL: &str = "flows:live";
const STREAM_KEY: &str = "flows:raw";

// geo-doctor's tier-3 corrections (corr_*), keyed by IP string. The map is the
// canonical truth applied at serve time so the immutable `flows` table stays raw.
type Overrides = HashMap<String, (f64, f64, Option<String>)>;
// ip_app classification (app, category) keyed by IP string.
mod aggregator;
use aggregator::Aggregator;

type AppMap = HashMap<String, (String, Option<String>)>;

#[derive(Clone)]
struct AppState {
    redis: MultiplexedConnection,
    pg: Option<sqlx::PgPool>,
    live_tx: broadcast::Sender<String>,
    overrides: Arc<RwLock<Overrides>>,
    apps: Arc<RwLock<AppMap>>,
    agg: Arc<std::sync::Mutex<Aggregator>>,
    home_lat: f64,
    home_lon: f64,
}

/// Rewrite a flow's src/dst geo with any geo-doctor correction for that IP.
fn apply_overrides(flow: &mut Value, ov: &Overrides) {
    for (addr_key, geo_key) in [("src_addr", "src_geo"), ("dst_addr", "dst_geo")] {
        let Some(ip) = flow.get(addr_key).and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((lat, lon, country)) = ov.get(ip) else {
            continue;
        };
        if let Some(g) = flow.get_mut(geo_key) {
            g["lat"] = json!(lat);
            g["lon"] = json!(lon);
            if let Some(c) = country {
                g["country"] = json!(c);
            }
            g["corrected"] = json!(true);
        }
    }
}

async fn load_overrides(pg: &sqlx::PgPool) -> Overrides {
    let rows: Vec<(String, f64, f64, Option<String>)> = sqlx::query_as(
        "SELECT host(ip)::text, corr_lat, corr_lon, corr_country FROM ip_geo WHERE corr_lat IS NOT NULL",
    )
    .fetch_all(pg)
    .await
    .unwrap_or_default();
    rows.into_iter()
        .map(|(ip, lat, lon, c)| (ip, (lat, lon, c)))
        .collect()
}

/// Stamp a flow with the SNI-derived application for its dst (and src) IP.
fn apply_apps(flow: &mut Value, apps: &AppMap) {
    for key in ["dst_addr", "src_addr"] {
        let Some(ip) = flow.get(key).and_then(|v| v.as_str()) else {
            continue;
        };
        if let Some((app, category)) = apps.get(ip) {
            // dst wins; only fill from src if dst gave nothing.
            if flow.get("app").and_then(|v| v.as_str()).is_some() {
                continue;
            }
            flow["app"] = json!(app);
            flow["category"] = json!(category);
        }
    }
}

async fn load_apps(pg: &sqlx::PgPool) -> AppMap {
    let rows: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT host(ip)::text, app, category FROM ip_app WHERE app IS NOT NULL")
            .fetch_all(pg)
            .await
            .unwrap_or_default();
    rows.into_iter()
        .map(|(ip, app, cat)| (ip, (app, cat)))
        .collect()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());
    let bind: SocketAddr = std::env::var("API_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8088".into())
        .parse()
        .context("parse API_BIND")?;
    let frontend_dir = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "frontend".into());
    let home_lat = env_f64("HOME_LAT", 0.0);
    let home_lon = env_f64("HOME_LON", 0.0);

    let client = redis::Client::open(redis_url).context("open redis")?;
    let redis = client
        .get_multiplexed_async_connection()
        .await
        .context("redis multiplexed connection")?;

    let (live_tx, _) = broadcast::channel::<String>(4096);

    // Optional PG (for /api/routes); the map works without it.
    let pg = match std::env::var("DATABASE_URL") {
        Ok(url) => match sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
        {
            Ok(p) => Some(p),
            Err(e) => {
                eprintln!("api: postgres unavailable ({e}); /api/routes will be empty");
                None
            }
        },
        Err(_) => None,
    };

    // geo-doctor corrections, reloaded periodically from ip_geo.
    let overrides = Arc::new(RwLock::new(Overrides::new()));
    if let Some(pg) = &pg {
        *overrides.write().await = load_overrides(pg).await;
        eprintln!(
            "api: loaded {} geo corrections",
            overrides.read().await.len()
        );
        spawn_override_refresh(pg.clone(), overrides.clone());
    }

    // SNI-derived application classifications, reloaded periodically from ip_app.
    let apps = Arc::new(RwLock::new(AppMap::new()));
    if let Some(pg) = &pg {
        *apps.write().await = load_apps(pg).await;
        eprintln!(
            "api: loaded {} app classifications",
            apps.read().await.len()
        );
        spawn_apps_refresh(pg.clone(), apps.clone());
    }

    // In-memory rolling-window stats aggregator, fed by the same live stream.
    let agg = Arc::new(std::sync::Mutex::new(Aggregator::new()));
    spawn_agg_tick(agg.clone());
    spawn_redis_bridge(
        client,
        live_tx.clone(),
        overrides.clone(),
        apps.clone(),
        agg.clone(),
    );

    let state = Arc::new(AppState {
        redis,
        pg,
        live_tx,
        overrides,
        apps,
        agg,
        home_lat,
        home_lon,
    });

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/recent", get(recent_handler))
        .route("/api/routes", get(routes_handler))
        .route("/api/stats", get(stats_handler))
        .route("/api/history", get(history_handler))
        .route("/api/timeline", get(timeline_handler))
        .route("/api/apps", get(apps_handler))
        .route("/api/unmatched", get(unmatched_handler))
        .route("/api/config", get(config_handler))
        .fallback_service(ServeDir::new(&frontend_dir))
        .layer(middleware::from_fn(cache_control))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind).await.context("bind")?;
    eprintln!("api: listening on http://{bind}  (frontend dir: {frontend_dir})");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .context("serve")?;
    Ok(())
}

// Cache policy for static assets: hashed bundles (/assets/*) are immutable and
// cached for a year; index.html must always be revalidated so a redeploy is
// picked up without a hard refresh. /api and /ws are left untouched.
async fn cache_control(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    let value = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else if path == "/" || path.ends_with(".html") {
        "no-cache"
    } else {
        return res;
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    res
}

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

/// Reload geo-doctor corrections into the shared map every 2 minutes.
fn spawn_override_refresh(pg: sqlx::PgPool, overrides: Arc<RwLock<Overrides>>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(120));
        tick.tick().await; // skip immediate first tick (already loaded at startup)
        loop {
            tick.tick().await;
            let fresh = load_overrides(&pg).await;
            *overrides.write().await = fresh;
        }
    });
}

/// Reload SNI app classifications into the shared map every 2 minutes.
fn spawn_apps_refresh(pg: sqlx::PgPool, apps: Arc<RwLock<AppMap>>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(120));
        tick.tick().await;
        loop {
            tick.tick().await;
            *apps.write().await = load_apps(&pg).await;
        }
    });
}

/// One Redis subscriber forwards every `flows:live` message into the broadcast,
/// applying geo corrections + app labels once before fan-out to all clients.
/// Roll the aggregator's per-second ring forward once a second.
fn spawn_agg_tick(agg: Arc<std::sync::Mutex<Aggregator>>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.tick().await; // consume the immediate first tick
        loop {
            tick.tick().await;
            if let Ok(mut a) = agg.lock() {
                a.tick();
            }
        }
    });
}

fn spawn_redis_bridge(
    client: redis::Client,
    tx: broadcast::Sender<String>,
    overrides: Arc<RwLock<Overrides>>,
    apps: Arc<RwLock<AppMap>>,
    agg: Arc<std::sync::Mutex<Aggregator>>,
) {
    tokio::spawn(async move {
        loop {
            match client.get_async_pubsub().await {
                Ok(mut pubsub) => {
                    if let Err(e) = pubsub.subscribe(LIVE_CHANNEL).await {
                        eprintln!("api: subscribe failed: {e}; retrying");
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        continue;
                    }
                    eprintln!("api: subscribed to {LIVE_CHANNEL}");
                    let mut stream = pubsub.on_message();
                    while let Some(msg) = stream.next().await {
                        if let Ok(payload) = msg.get_payload::<String>() {
                            let out = match serde_json::from_str::<Value>(&payload) {
                                Ok(mut v) => {
                                    apply_overrides(&mut v, &*overrides.read().await);
                                    apply_apps(&mut v, &*apps.read().await);
                                    if let Ok(mut a) = agg.lock() {
                                        a.record(&v);
                                    }
                                    v.to_string()
                                }
                                Err(_) => payload,
                            };
                            let _ = tx.send(out); // ignore "no receivers"
                        }
                    }
                    eprintln!("api: pubsub stream ended; reconnecting");
                }
                Err(e) => {
                    eprintln!("api: redis pubsub connect failed: {e}; retrying");
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.live_tx.subscribe();

    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(payload) => {
                    if sender.send(Message::Text(payload)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Drain client messages until it disconnects.
    let mut recv_task = tokio::spawn(async move { while receiver.next().await.is_some() {} });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }
}

#[derive(Deserialize)]
struct RecentQuery {
    n: Option<usize>,
}

async fn recent_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RecentQuery>,
) -> impl IntoResponse {
    let count = q.n.unwrap_or(500).min(5000);
    let mut con = state.redis.clone();
    let reply: redis::RedisResult<Vec<(String, Vec<String>)>> = redis::cmd("XREVRANGE")
        .arg(STREAM_KEY)
        .arg("+")
        .arg("-")
        .arg("COUNT")
        .arg(count)
        .query_async(&mut con)
        .await;

    match reply {
        Ok(entries) => {
            let ov = state.overrides.read().await;
            let ap = state.apps.read().await;
            let flows: Vec<Value> = entries
                .into_iter()
                .filter_map(|(_, kv)| field_value(&kv, "j"))
                .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
                .map(|mut v| {
                    apply_overrides(&mut v, &ov);
                    apply_apps(&mut v, &ap);
                    v
                })
                .collect();
            Json(json!({ "flows": flows })).into_response()
        }
        Err(e) => {
            eprintln!("api: XREVRANGE error: {e}");
            Json(json!({ "flows": [], "error": e.to_string() })).into_response()
        }
    }
}

/// Stream fields come back flat: ["j", "<json>", ...]. Find value after key.
fn field_value(kv: &[String], key: &str) -> Option<String> {
    kv.chunks_exact(2)
        .find(|c| c[0] == key)
        .map(|c| c[1].clone())
}

// Recent measured routes (mtr): dst + hop array with coordinates.
async fn routes_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RecentQuery>,
) -> impl IntoResponse {
    let n = q.n.unwrap_or(400).min(4000) as i64;
    let Some(pg) = &state.pg else {
        return Json(json!({ "routes": [] })).into_response();
    };
    let rows: Result<Vec<(String, String)>, _> = sqlx::query_as(
        "SELECT host(dst_ip)::text, hops::text FROM routes ORDER BY traced_at DESC LIMIT $1",
    )
    .bind(n)
    .fetch_all(pg)
    .await;
    match rows {
        Ok(rs) => {
            let routes: Vec<Value> = rs
                .into_iter()
                .map(|(dst, hops)| {
                    let hops: Value = serde_json::from_str(&hops).unwrap_or(Value::Null);
                    json!({ "dst": dst, "hops": hops })
                })
                .collect();
            Json(json!({ "routes": routes })).into_response()
        }
        Err(e) => {
            eprintln!("api: routes query error: {e}");
            Json(json!({ "routes": [], "error": e.to_string() })).into_response()
        }
    }
}

// Traffic stats the predecessor (attacks-only) never had: live throughput,
// top destinations and countries by bytes — aggregated from the cold tier.
#[derive(Deserialize)]
struct StatsQuery {
    window: Option<f64>,
}

async fn stats_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<StatsQuery>,
) -> impl IntoResponse {
    // Live stats now come from the in-memory rolling-window aggregator (fed by
    // the same Redis live stream). History/replay still come from Postgres via
    // /api/history. The ring holds up to 10 minutes, so the window is clamped
    // there; each panel splits in/out (download vs upload) from the home POV.
    let window = q.window.unwrap_or(60.0).clamp(1.0, 600.0);
    let snap = state.agg.lock().unwrap().snapshot(window);
    Json(snap).into_response()
}

#[derive(Deserialize)]
struct HistQuery {
    since_s: Option<f64>,
    from_s: Option<f64>, // absolute epoch window start (brush selection)
    to_s: Option<f64>,   // absolute epoch window end
    limit: Option<i64>,
}

fn now_epoch() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

// Historical flows from the cold tier for a look-back window, in the same
// enriched shape as the live feed (so the frontend replays them identically).
type HistRow = (
    i64,            // recv_sec
    String,         // src
    String,         // dst
    Option<i32>,    // src_port
    Option<i32>,    // dst_port
    Option<i16>,    // protocol
    Option<i64>,    // octets
    Option<f64>,    // src_lat
    Option<f64>,    // src_lon
    Option<String>, // src_country
    bool,           // src_is_home
    Option<f64>,    // dst_lat
    Option<f64>,    // dst_lon
    Option<String>, // dst_country
    bool,           // dst_is_home
);

async fn history_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HistQuery>,
) -> impl IntoResponse {
    let Some(pg) = &state.pg else {
        return Json(json!({ "flows": [] })).into_response();
    };
    let since = q.since_s.unwrap_or(300.0).clamp(1.0, 366.0 * 24.0 * 3600.0);
    let limit = q.limit.unwrap_or(6000).clamp(1, 20000);
    // Absolute [from,to] window when the user brushed the timeline; else trailing.
    let now = now_epoch();
    let (from, to) = match (q.from_s, q.to_s) {
        (Some(f), Some(t)) if t > f => (f, t),
        _ => (now - since, now + 60.0),
    };
    let priv_pred = "(%C% <<= '10.0.0.0/8' OR %C% <<= '172.16.0.0/12' OR %C% <<= '192.168.0.0/16' \
         OR %C% <<= '127.0.0.0/8' OR %C% <<= '169.254.0.0/16' OR %C% <<= '100.64.0.0/10' \
         OR %C% <<= '224.0.0.0/4' OR %C% <<= 'fc00::/7' OR %C% <<= 'fe80::/10' OR %C% <<= 'ff00::/8')";
    let sql = format!(
        "SELECT extract(epoch FROM recv_time)::bigint, host(src_addr)::text, host(dst_addr)::text, \
         src_port, dst_port, protocol, octets, src_lat, src_lon, src_country, {src_home} AS sh, \
         dst_lat, dst_lon, dst_country, {dst_home} AS dh \
         FROM flows \
         WHERE recv_time > to_timestamp($1) AND recv_time <= to_timestamp($2) \
           AND src_lat IS NOT NULL AND dst_lat IS NOT NULL \
         ORDER BY recv_time DESC LIMIT $3",
        src_home = priv_pred.replace("%C%", "src_addr"),
        dst_home = priv_pred.replace("%C%", "dst_addr"),
    );
    let rows: Result<Vec<HistRow>, _> = sqlx::query_as(&sql)
        .bind(from)
        .bind(to)
        .bind(limit)
        .fetch_all(pg)
        .await;
    match rows {
        Ok(rs) => {
            let ov = state.overrides.read().await;
            let ap = state.apps.read().await;
            let flows: Vec<Value> = rs
                .into_iter()
                .map(|r| {
                    let mut v = json!({
                        "recv_sec": r.0, "src_addr": r.1, "dst_addr": r.2,
                        "src_port": r.3, "dst_port": r.4, "protocol": r.5, "octets": r.6,
                        "src_geo": { "lat": r.7, "lon": r.8, "country": r.9, "is_home": r.10, "city": null },
                        "dst_geo": { "lat": r.11, "lon": r.12, "country": r.13, "is_home": r.14, "city": null },
                    });
                    apply_overrides(&mut v, &ov);
                    apply_apps(&mut v, &ap);
                    v
                })
                .collect();
            Json(json!({ "flows": flows })).into_response()
        }
        Err(e) => {
            eprintln!("api: history error: {e}");
            Json(json!({ "flows": [], "error": e.to_string() })).into_response()
        }
    }
}

#[derive(Deserialize)]
struct TimelineQuery {
    since_s: Option<f64>,
    buckets: Option<i64>,
}

// Per-bucket throughput over a look-back window, for the scrubbable bottom
// timeline. Returns a dense series of {t (epoch), bps} oldest→newest.
async fn timeline_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TimelineQuery>,
) -> impl IntoResponse {
    let Some(pg) = &state.pg else {
        return Json(json!({ "points": [], "bucket_s": 0 })).into_response();
    };
    let since = q
        .since_s
        .unwrap_or(900.0)
        .clamp(60.0, 366.0 * 24.0 * 3600.0);
    let n = q.buckets.unwrap_or(120).clamp(10, 600);
    let bucket_s = since / n as f64;
    // bucket 0 = most recent; index = floor((now - recv)/bucket_s)
    let rows: Vec<(f64, i64)> = sqlx::query_as(
        "SELECT floor(extract(epoch FROM (now() - recv_time)) / $1) AS b,
                COALESCE(sum(octets), 0)::bigint
         FROM flows
         WHERE recv_time > now() - make_interval(secs => $2)
         GROUP BY 1",
    )
    .bind(bucket_s)
    .bind(since)
    .fetch_all(pg)
    .await
    .unwrap_or_default();
    let now = now_epoch();
    let mut bps = vec![0i64; n as usize];
    for (b, bytes) in rows {
        let i = b as usize;
        if i < bps.len() {
            bps[i] = (bytes as f64 * 8.0 / bucket_s) as i64;
        }
    }
    // emit oldest→newest: index n-1 is oldest
    let points: Vec<Value> = (0..n as usize)
        .rev()
        .map(|i| json!({ "t": now - i as f64 * bucket_s, "bps": bps[i] }))
        .collect();
    Json(json!({ "points": points, "bucket_s": bucket_s })).into_response()
}

// Top applications by traffic over the trailing `window` (same range as the rest
// of the panel), derived by joining cold-tier flows to the SNI-built ip_app
// classification on destination IP.
async fn apps_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<StatsQuery>,
) -> impl IntoResponse {
    let Some(pg) = &state.pg else {
        return Json(json!({ "apps": [] })).into_response();
    };
    let window = q.window.unwrap_or(60.0).clamp(1.0, 3600.0);
    let rows: Vec<(String, Option<String>, i64, i64)> = sqlx::query_as(
        "SELECT a.app, mode() WITHIN GROUP (ORDER BY a.category) AS category,
                COALESCE(sum(f.octets),0)::bigint, count(*)::bigint
         FROM flows f JOIN ip_app a ON a.ip = f.dst_addr
         WHERE f.recv_time > now() - make_interval(secs => $1) AND a.app IS NOT NULL
         GROUP BY a.app ORDER BY 3 DESC LIMIT 15",
    )
    .bind(window)
    .fetch_all(pg)
    .await
    .unwrap_or_default();
    Json(json!({
        "apps": rows.iter().map(|(app, cat, bytes, flows)| {
            json!({ "app": app, "category": cat, "bytes": bytes, "flows": flows })
        }).collect::<Vec<_>>(),
    }))
    .into_response()
}

// Top SNIs not yet covered by any app_rule (last 6h) — tells the operator which
// rules to add next so coverage grows — the "more accurate with use" loop.
async fn unmatched_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let Some(pg) = &state.pg else {
        return Json(json!({ "unmatched": [] })).into_response();
    };
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT sni, count(*)::bigint FROM sni_log
         WHERE app IS NULL AND ts > now() - interval '6 hours'
         GROUP BY sni ORDER BY 2 DESC LIMIT 15",
    )
    .fetch_all(pg)
    .await
    .unwrap_or_default();
    Json(json!({
        "unmatched": rows.iter().map(|(sni, n)| json!({ "sni": sni, "count": n })).collect::<Vec<_>>(),
    }))
    .into_response()
}

async fn config_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "home": { "lat": state.home_lat, "lon": state.home_lon }
    }))
}
