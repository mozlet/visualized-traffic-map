//! Debug helper: resolve one or more IPs against the configured GeoLite2 db.
//!
//! Usage: GEOIP_DB_PATH=/path/City.mmdb geoip-lookup 1.2.3.4 [5.6.7.8 ...]

use std::net::IpAddr;
use std::path::Path;

use geoip::GeoResolver;

fn main() {
    let db = std::env::var("GEOIP_DB_PATH").unwrap_or_default();
    let home_lat = std::env::var("HOME_LAT").ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let home_lon = std::env::var("HOME_LON").ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let resolver = GeoResolver::new(
        if db.is_empty() { None } else { Some(Path::new(&db)) },
        home_lat,
        home_lon,
    );

    let mut args = std::env::args().skip(1).peekable();
    if args.peek().is_none() {
        eprintln!("usage: geoip-lookup <ip> [ip ...]   (set GEOIP_DB_PATH)");
        std::process::exit(2);
    }
    for arg in args {
        match arg.parse::<IpAddr>() {
            Ok(ip) => match resolver.lookup(ip) {
                Some(g) => println!(
                    "{ip}\t{:.4},{:.4}\tcountry={}\tcity={}\thome={}",
                    g.lat,
                    g.lon,
                    g.country.as_deref().unwrap_or("-"),
                    g.city.as_deref().unwrap_or("-"),
                    g.is_home
                ),
                None => println!("{ip}\t(no geo)"),
            },
            Err(_) => eprintln!("{arg}\t(not an IP)"),
        }
    }
}
