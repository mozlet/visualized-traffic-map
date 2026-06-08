//! In-memory rolling-window traffic aggregator (multi-axis + in/out direction).
//!
//! Design borrowed from sniffnet (MIT/Apache-2.0): one flow is folded into
//! several parallel keyed views, each value an in/out `DataInfo`. Here it feeds
//! the live `/api/stats` panels from memory instead of per-request SQL; history
//! and replay still come from Postgres.
//!
//! Each flow is attributed from the HOME network's perspective:
//!
//! - outgoing (home -> remote): bytes are OUT, the remote peer is the dst.
//! - incoming (remote -> home): bytes are IN, the remote peer is the src.
//!
//! Keying the remote-peer panels by the *remote* end and splitting up/down means
//! a download (whose dst is the LAN host) is no longer dropped the way the old
//! `GROUP BY dst_addr` + exclude-private SQL dropped it.

use serde_json::{json, Value};
use std::collections::HashMap;

const BUCKETS: usize = 600; // one per second => up to a 10-minute window
const DST_CAP: usize = 4000; // per-second soft cap on distinct remote IPs

#[derive(Clone, Copy, Default)]
pub struct DataInfo {
    pub in_bytes: u64,
    pub out_bytes: u64,
    pub in_pkts: u64,
    pub out_pkts: u64,
}

impl DataInfo {
    fn add(&mut self, bytes: u64, pkts: u64, incoming: bool) {
        if incoming {
            self.in_bytes += bytes;
            self.in_pkts += pkts;
        } else {
            self.out_bytes += bytes;
            self.out_pkts += pkts;
        }
    }
    fn merge(&mut self, o: &DataInfo) {
        self.in_bytes += o.in_bytes;
        self.out_bytes += o.out_bytes;
        self.in_pkts += o.in_pkts;
        self.out_pkts += o.out_pkts;
    }
    fn total(&self) -> u64 {
        self.in_bytes + self.out_bytes
    }
}

type HostKey = (String, String, String); // (label, asn, country)

#[derive(Default)]
struct Bucket {
    total: DataInfo,
    dst: HashMap<String, (DataInfo, Option<String>)>, // remote ip -> (data, country)
    country: HashMap<String, DataInfo>,
    src: HashMap<String, DataInfo>, // LAN host ip
    service: HashMap<String, DataInfo>,
    host: HashMap<HostKey, DataInfo>,
}

pub struct Aggregator {
    buckets: Vec<Bucket>,
    cur: usize,
}

impl Default for Aggregator {
    fn default() -> Self {
        Self::new()
    }
}

impl Aggregator {
    pub fn new() -> Self {
        let mut buckets = Vec::with_capacity(BUCKETS);
        buckets.resize_with(BUCKETS, Bucket::default);
        Self { buckets, cur: 0 }
    }

    /// Advance to the next per-second bucket, clearing the slot we roll onto.
    pub fn tick(&mut self) {
        self.cur = (self.cur + 1) % BUCKETS;
        self.buckets[self.cur] = Bucket::default();
    }

    /// Fold one enriched flow JSON into the current bucket.
    pub fn record(&mut self, v: &Value) {
        let bytes = v.get("octets").and_then(Value::as_u64).unwrap_or(0);
        if bytes == 0 {
            return;
        }
        let pkts = v.get("packets").and_then(Value::as_u64).unwrap_or(0);
        let sh = v
            .pointer("/src_geo/is_home")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let dh = v
            .pointer("/dst_geo/is_home")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let incoming = dh && !sh;
        let outgoing = sh && !dh;

        let b = &mut self.buckets[self.cur];
        // Global total: each flow counted once (internal/transit fall to "out").
        b.total.add(bytes, pkts, incoming);

        // Service axis (independent of direction / peer).
        if let Some(svc) = v.get("service").and_then(Value::as_str) {
            b.service
                .entry(svc.to_string())
                .or_default()
                .add(bytes, pkts, incoming);
        }

        // LAN-host axis: the home end (src when outgoing/internal, dst when incoming).
        let lan = if sh {
            v.get("src_addr").and_then(Value::as_str)
        } else if dh {
            v.get("dst_addr").and_then(Value::as_str)
        } else {
            None
        };
        if let Some(ip) = lan {
            b.src
                .entry(ip.to_string())
                .or_default()
                .add(bytes, pkts, incoming);
        }

        // Remote-peer axes (dst / country / host): keyed by the non-home end.
        let (peer_ip_key, peer_country_ptr, peer_as_key) = if outgoing {
            ("dst_addr", "/dst_geo/country", "dst_as")
        } else if incoming {
            ("src_addr", "/src_geo/country", "src_as")
        } else if !sh && !dh {
            ("dst_addr", "/dst_geo/country", "dst_as") // transit
        } else {
            return; // internal: no remote peer
        };

        let Some(ip) = v
            .get(peer_ip_key)
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let country = v
            .pointer(peer_country_ptr)
            .and_then(Value::as_str)
            .map(str::to_string);

        // dst axis (soft-capped against runaway remote-IP cardinality).
        if b.dst.len() < DST_CAP || b.dst.contains_key(&ip) {
            let e = b
                .dst
                .entry(ip.clone())
                .or_insert_with(|| (DataInfo::default(), country.clone()));
            e.0.add(bytes, pkts, incoming);
            if e.1.is_none() {
                e.1 = country.clone();
            }
        }
        // country axis
        if let Some(c) = &country {
            b.country
                .entry(c.clone())
                .or_default()
                .add(bytes, pkts, incoming);
        }
        // host axis: (label, asn, country); label = SNI app if known else remote ip.
        let label = v
            .get("app")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| ip.clone());
        let asn = v
            .get(peer_as_key)
            .and_then(Value::as_i64)
            .filter(|n| *n > 0)
            .map(|n| n.to_string())
            .unwrap_or_default();
        let key: HostKey = (label, asn, country.unwrap_or_default());
        b.host.entry(key).or_default().add(bytes, pkts, incoming);
    }

    /// Sum the trailing `window` seconds and emit the `/api/stats` JSON.
    pub fn snapshot(&self, window: f64) -> Value {
        let w = (window.round() as usize).clamp(1, BUCKETS);
        let mut total = DataInfo::default();
        let mut dst: HashMap<&str, (DataInfo, Option<&str>)> = HashMap::new();
        let mut country: HashMap<&str, DataInfo> = HashMap::new();
        let mut src: HashMap<&str, DataInfo> = HashMap::new();
        let mut service: HashMap<&str, DataInfo> = HashMap::new();
        let mut host: HashMap<&HostKey, DataInfo> = HashMap::new();

        for i in 0..w {
            let idx = (self.cur + BUCKETS - i) % BUCKETS;
            let b = &self.buckets[idx];
            total.merge(&b.total);
            for (k, (d, c)) in &b.dst {
                let e = dst
                    .entry(k.as_str())
                    .or_insert((DataInfo::default(), c.as_deref()));
                e.0.merge(d);
                if e.1.is_none() {
                    e.1 = c.as_deref();
                }
            }
            for (k, d) in &b.country {
                country.entry(k.as_str()).or_default().merge(d);
            }
            for (k, d) in &b.src {
                src.entry(k.as_str()).or_default().merge(d);
            }
            for (k, d) in &b.service {
                service.entry(k.as_str()).or_default().merge(d);
            }
            for (k, d) in &b.host {
                host.entry(k).or_default().merge(d);
            }
        }

        let bps = |bytes: u64| (bytes as f64 * 8.0 / window).round() as i64;

        // Top-N by total bytes, descending.
        let mut dst_v: Vec<_> = dst.into_iter().collect();
        dst_v.sort_by(|a, b| b.1 .0.total().cmp(&a.1 .0.total()));
        let top_dst: Vec<Value> = dst_v
            .iter()
            .take(8)
            .map(|(ip, (d, c))| {
                json!({"ip": ip, "country": c, "bytes": d.total(), "bytes_in": d.in_bytes, "bytes_out": d.out_bytes})
            })
            .collect();

        let mut c_v: Vec<_> = country.into_iter().collect();
        c_v.sort_by(|a, b| b.1.total().cmp(&a.1.total()));
        let top_countries: Vec<Value> = c_v
            .iter()
            .take(6)
            .map(|(c, d)| json!({"country": c, "bytes": d.total(), "bytes_in": d.in_bytes, "bytes_out": d.out_bytes}))
            .collect();

        let mut s_v: Vec<_> = src.into_iter().collect();
        s_v.sort_by(|a, b| b.1.total().cmp(&a.1.total()));
        let top_src: Vec<Value> = s_v
            .iter()
            .take(6)
            .map(|(ip, d)| json!({"ip": ip, "bytes": d.total(), "bytes_in": d.in_bytes, "bytes_out": d.out_bytes}))
            .collect();

        let mut svc_v: Vec<_> = service.into_iter().collect();
        svc_v.sort_by(|a, b| b.1.total().cmp(&a.1.total()));
        let top_services: Vec<Value> = svc_v
            .iter()
            .take(8)
            .map(|(s, d)| json!({"service": s, "bytes": d.total(), "bytes_in": d.in_bytes, "bytes_out": d.out_bytes}))
            .collect();

        let mut h_v: Vec<_> = host.into_iter().collect();
        h_v.sort_by(|a, b| b.1.total().cmp(&a.1.total()));
        let top_hosts: Vec<Value> = h_v
            .iter()
            .take(6)
            .map(|((label, asn, c), d)| {
                json!({"label": label, "asn": asn, "country": c, "bytes": d.total(), "bytes_in": d.in_bytes, "bytes_out": d.out_bytes})
            })
            .collect();

        json!({
            "window": window,
            "bps": bps(total.total()),
            "bps_in": bps(total.in_bytes),
            "bps_out": bps(total.out_bytes),
            "top_dst": top_dst,
            "top_countries": top_countries,
            "top_src": top_src,
            "top_services": top_services,
            "top_hosts": top_hosts,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn flow(src: &str, dst: &str, sh: bool, dh: bool, bytes: u64, svc: &str) -> Value {
        json!({
            "src_addr": src, "dst_addr": dst, "octets": bytes, "packets": 1,
            "src_geo": {"is_home": sh, "country": "CN"},
            "dst_geo": {"is_home": dh, "country": "US"},
            "service": svc, "dst_as": 15169, "src_as": 4134,
        })
    }

    #[test]
    fn datainfo_direction_and_merge() {
        let mut a = DataInfo::default();
        a.add(100, 1, false); // out
        a.add(40, 1, true); // in
        assert_eq!(a.out_bytes, 100);
        assert_eq!(a.in_bytes, 40);
        assert_eq!(a.total(), 140);
        let mut b = DataInfo::default();
        b.add(10, 1, true);
        a.merge(&b);
        assert_eq!(a.in_bytes, 50);
    }

    #[test]
    fn outgoing_keys_remote_dst_as_out() {
        let mut agg = Aggregator::new();
        // home -> remote: 1000 bytes outbound to 8.8.8.8
        agg.record(&flow("192.0.2.10", "8.8.8.8", true, false, 1000, "https"));
        let s = agg.snapshot(60.0);
        let dst = &s["top_dst"][0];
        assert_eq!(dst["ip"], "8.8.8.8");
        assert_eq!(dst["bytes_out"], 1000);
        assert_eq!(dst["bytes_in"], 0);
        assert_eq!(s["top_services"][0]["service"], "https");
    }

    #[test]
    fn incoming_download_attributed_to_remote_src_as_in() {
        let mut agg = Aggregator::new();
        // remote -> home: a 5000-byte download FROM 1.1.1.1 to the LAN host
        agg.record(&flow("1.1.1.1", "192.0.2.10", false, true, 5000, "https"));
        let s = agg.snapshot(60.0);
        // The remote peer (the download source) is the dst-axis key, counted IN.
        let dst = &s["top_dst"][0];
        assert_eq!(dst["ip"], "1.1.1.1");
        assert_eq!(dst["bytes_in"], 5000);
        assert_eq!(dst["bytes_out"], 0);
        // The LAN host shows up under top_src.
        assert_eq!(s["top_src"][0]["ip"], "192.0.2.10");
        assert_eq!(s["bps_in"], (5000.0_f64 * 8.0 / 60.0).round() as i64); // 667
    }

    #[test]
    fn window_sum_and_tick_expiry() {
        let mut agg = Aggregator::new();
        agg.record(&flow("192.0.2.10", "8.8.8.8", true, false, 1000, "https"));
        // roll the ring fully; the old bucket must be cleared.
        for _ in 0..BUCKETS {
            agg.tick();
        }
        let s = agg.snapshot(600.0);
        assert!(s["top_dst"].as_array().unwrap().is_empty());
        assert_eq!(s["bps"], 0);
    }
}
