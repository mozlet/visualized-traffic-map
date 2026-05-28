//! One-time bootstrap: build the internet-infrastructure hub set used to route
//! flow paths through real anchors (cable landings + IXPs/facilities) instead of
//! straight great circles. (Rust per the repo's Rust-only rule — no Python.)
//!
//! Sources & licensing:
//!   * Submarine cable LANDING POINTS — submarinecablemap.com public API (same
//!     source as cables.geojson). Global, named "City, Country". Committable.
//!   * IXPs from Wikidata (Q1433061, coord P625) — CC0. Committable but sparse.
//!   * (--full) PeeringDB facilities (`fac`, public read) — rich global inland
//!     hubs, but its AUP forbids redistribution, so this goes to hubs.local.geojson
//!     which is gitignored and only used on the operator's own deployment.
//!
//! Run from the repo root:
//!   cargo run -p fetch-hubs            # public set  -> web/public/data/hubs.geojson
//!   cargo run -p fetch-hubs -- --full  # + PeeringDB -> web/public/data/hubs.local.geojson

use anyhow::Result;
use serde_json::{json, Value};
use std::fs;

const UA: &str = "opn-visualized-traffic-map/1.0 (self-hosted; +https://github.com/mozlet/visualized-traffic-map)";
const OUT_DIR: &str = "web/public/data";
const LANDINGS_URL: &str =
    "https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json";
const WD_SPARQL: &str = "https://query.wikidata.org/sparql";

fn get_json(req: ureq::Request) -> Result<Value> {
    Ok(req.set("User-Agent", UA).call()?.into_json()?)
}

fn round4(x: f64) -> f64 {
    (x * 1e4).round() / 1e4
}

fn feat(lon: f64, lat: f64, name: &str, role: &str, country: Option<&str>) -> Value {
    let mut props = json!({ "name": name, "role": role });
    if let Some(c) = country.filter(|c| !c.is_empty()) {
        props["country"] = json!(c);
    }
    json!({
        "type": "Feature",
        "geometry": { "type": "Point", "coordinates": [round4(lon), round4(lat)] },
        "properties": props,
    })
}

fn landing_points() -> Result<Vec<Value>> {
    let gj = get_json(ureq::get(LANDINGS_URL))?;
    let mut out = vec![];
    for f in gj["features"].as_array().into_iter().flatten() {
        let c = &f["geometry"]["coordinates"];
        let (Some(lon), Some(lat)) = (c[0].as_f64(), c[1].as_f64()) else {
            continue;
        };
        let name = f["properties"]["name"]
            .as_str()
            .or_else(|| f["properties"]["id"].as_str())
            .unwrap_or("landing");
        let country = name.rsplit_once(',').map(|(_, c)| c.trim());
        out.push(feat(lon, lat, name, "landing", country));
    }
    Ok(out)
}

fn wikidata_ixps() -> Result<Vec<Value>> {
    let q = "SELECT ?l ?lat ?lon ?cc WHERE { ?i wdt:P31 wd:Q1433061 ; rdfs:label ?l . \
             FILTER(LANG(?l)=\"en\") ?i p:P625/psv:P625 ?cv . \
             ?cv wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon . \
             OPTIONAL { ?i wdt:P17/wdt:P297 ?cc } }";
    let data = get_json(
        ureq::get(WD_SPARQL)
            .query("query", q)
            .set("Accept", "application/sparql-results+json"),
    )?;
    let mut out = vec![];
    for b in data["results"]["bindings"].as_array().into_iter().flatten() {
        let lon = b["lon"]["value"].as_str().and_then(|s| s.parse().ok());
        let lat = b["lat"]["value"].as_str().and_then(|s| s.parse().ok());
        if let (Some(lon), Some(lat)) = (lon, lat) {
            let name = b["l"]["value"].as_str().unwrap_or("ixp");
            out.push(feat(lon, lat, name, "ixp", b["cc"]["value"].as_str()));
        }
    }
    Ok(out)
}

fn peeringdb_facilities() -> Result<Vec<Value>> {
    // Public read; lat/lon + country live on facility records.
    let data = get_json(ureq::get("https://www.peeringdb.com/api/fac?limit=0"))?;
    let mut out = vec![];
    for f in data["data"].as_array().into_iter().flatten() {
        if let (Some(lon), Some(lat)) = (f["longitude"].as_f64(), f["latitude"].as_f64()) {
            let name = f["name"].as_str().unwrap_or("facility");
            out.push(feat(lon, lat, name, "fac", f["country"].as_str()));
        }
    }
    Ok(out)
}

fn main() -> Result<()> {
    let full = std::env::args().any(|a| a == "--full");
    let mut feats = landing_points()?;
    let n_land = feats.len();
    match wikidata_ixps() {
        Ok(mut v) => feats.append(&mut v),
        Err(e) => eprintln!("wikidata fetch failed ({e}); continuing without IXPs"),
    }
    let n_ixp = feats.len() - n_land;
    let mut n_fac = 0;
    if full {
        match peeringdb_facilities() {
            Ok(mut v) => {
                n_fac = v.len();
                feats.append(&mut v);
            }
            Err(e) => eprintln!("peeringdb fetch failed ({e}); continuing without it"),
        }
    }
    let out = if full {
        format!("{OUT_DIR}/hubs.local.geojson")
    } else {
        format!("{OUT_DIR}/hubs.geojson")
    };
    let total = feats.len();
    fs::write(
        &out,
        serde_json::to_string(&json!({ "type": "FeatureCollection", "features": feats }))?,
    )?;
    println!("wrote {out}: {total} hubs (landings={n_land} ixp={n_ixp} fac={n_fac})");
    Ok(())
}
