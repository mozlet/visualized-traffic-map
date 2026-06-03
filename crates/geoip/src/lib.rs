//! IP → geographic coordinate resolution.
//!
//! Public addresses are looked up in a MaxMind GeoLite2-City database.
//! Private / reserved / local addresses (RFC1918, loopback, CGNAT, link-local,
//! ULA, multicast) have no meaningful geo location, so they resolve to a
//! configurable "home" coordinate — typically the OPNsense site location.
//!
//! If no database is loaded, public lookups return `None` but private
//! addresses still resolve to home, so the ingestor degrades gracefully when
//! the GeoLite2 file is not yet present.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::Path;

use maxminddb::{geoip2, Reader};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct GeoPoint {
    pub lat: f64,
    pub lon: f64,
    pub country: Option<String>,
    pub city: Option<String>,
    /// True when this is the home coordinate (a local/private address).
    pub is_home: bool,
}

pub struct GeoResolver {
    reader: Option<Reader<Vec<u8>>>,
    home: GeoPoint,
}

impl GeoResolver {
    /// Build a resolver. `db_path` may be `None` or point at a missing file —
    /// in both cases public lookups simply return `None`.
    pub fn new(db_path: Option<&Path>, home_lat: f64, home_lon: f64) -> Self {
        let reader = match db_path {
            Some(p) if p.exists() => match Reader::open_readfile(p) {
                Ok(r) => Some(r),
                Err(e) => {
                    eprintln!("geoip: failed to open {}: {e}", p.display());
                    None
                }
            },
            Some(p) => {
                eprintln!(
                    "geoip: database {} not found; public IPs will have no geo",
                    p.display()
                );
                None
            }
            None => None,
        };
        Self {
            reader,
            home: GeoPoint {
                lat: home_lat,
                lon: home_lon,
                country: None,
                city: None,
                is_home: true,
            },
        }
    }

    pub fn has_database(&self) -> bool {
        self.reader.is_some()
    }

    pub fn lookup(&self, ip: IpAddr) -> Option<GeoPoint> {
        if is_local(ip) {
            return Some(self.home.clone());
        }
        let reader = self.reader.as_ref()?;
        let city: geoip2::City = reader.lookup(ip).ok()?;
        let loc = city.location?;
        let (lat, lon) = (loc.latitude?, loc.longitude?);
        let country = city
            .country
            .as_ref()
            .and_then(|c| c.iso_code)
            .map(|s| s.to_string());
        let city_name = city
            .city
            .as_ref()
            .and_then(|c| c.names.as_ref())
            .and_then(|n| n.get("en").or_else(|| n.values().next()))
            .map(|s| s.to_string());
        Some(GeoPoint {
            lat,
            lon,
            country,
            city: city_name,
            is_home: false,
        })
    }
}

/// Addresses that have no public geo location and should map to "home".
pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => is_local_v4(a),
        IpAddr::V6(a) => is_local_v6(a),
    }
}

fn is_local_v4(a: Ipv4Addr) -> bool {
    a.is_private()           // 10/8, 172.16/12, 192.168/16
        || a.is_loopback()   // 127/8
        || a.is_link_local() // 169.254/16
        || a.is_broadcast()  // 255.255.255.255
        || a.is_unspecified()// 0.0.0.0
        || a.is_multicast()  // 224/4
        || is_cgnat_v4(a)    // 100.64/10
        || a.octets()[0] == 0 // 0/8
}

fn is_cgnat_v4(a: Ipv4Addr) -> bool {
    let o = a.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}

fn is_local_v6(a: Ipv6Addr) -> bool {
    a.is_loopback()
        || a.is_unspecified()
        || a.is_multicast()
        || is_ula_v6(a)         // fc00::/7
        || is_link_local_v6(a) // fe80::/10
}

fn is_ula_v6(a: Ipv6Addr) -> bool {
    (a.octets()[0] & 0xfe) == 0xfc
}

fn is_link_local_v6(a: Ipv6Addr) -> bool {
    let s = a.segments()[0];
    (s & 0xffc0) == 0xfe80
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home_resolver() -> GeoResolver {
        GeoResolver::new(None, 37.77, -122.42)
    }

    #[test]
    fn private_v4_maps_to_home() {
        let r = home_resolver();
        let p = r.lookup("192.168.1.1".parse().unwrap()).unwrap();
        assert!(p.is_home);
        assert_eq!(p.lat, 37.77);
        assert_eq!(p.lon, -122.42);
    }

    #[test]
    fn public_v4_without_db_is_none() {
        let r = home_resolver();
        assert!(r.lookup("203.0.113.10".parse().unwrap()).is_none());
    }

    #[test]
    fn local_classification() {
        for ip in [
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "224.0.0.1",
            "0.0.0.0",
        ] {
            assert!(is_local(ip.parse().unwrap()), "{ip} should be local");
        }
        for ip in ["8.8.8.8", "203.0.113.10", "1.1.1.1"] {
            assert!(!is_local(ip.parse().unwrap()), "{ip} should be public");
        }
    }

    #[test]
    fn local_classification_v6() {
        for ip in ["::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1"] {
            assert!(is_local(ip.parse().unwrap()), "{ip} should be local");
        }
        assert!(!is_local("2606:4700:4700::1111".parse().unwrap()));
    }
}
