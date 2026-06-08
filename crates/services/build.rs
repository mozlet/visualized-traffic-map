// Compile-time port→service phf map generated from `services.txt`.
// Approach adapted from sniffnet (MIT/Apache-2.0): https://github.com/GyulyVGC/sniffnet
// `services.txt` is nmap-services derived. Key encoding differs from sniffnet
// (a single u32 = port<<8 | iana_proto, instead of its ServiceQuery type).

use std::collections::HashSet;
use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;

const SERVICES_TXT: &str = "services.txt";
const EXPECTED_ENTRIES: usize = 12093;

fn main() {
    println!("cargo:rerun-if-changed={SERVICES_TXT}");
    let out_path = Path::new(&env::var("OUT_DIR").unwrap()).join("services.rs");
    let mut out = BufWriter::new(File::create(out_path).unwrap());

    let mut map = phf_codegen::Map::new();
    let mut seen = HashSet::new();
    let input = BufReader::new(File::open(SERVICES_TXT).unwrap());
    let mut n = 0usize;
    for line in input.lines() {
        let line = line.unwrap();
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let mut parts = t.split('\t');
        let name = parts.next().expect("service name").trim();
        let port_proto = parts.next().expect("port/proto").trim();
        assert!(parts.next().is_none(), "unexpected extra column: {line}");

        // Format validation (sniffnet's debug-only profanity filter is dropped).
        assert!(
            !name.is_empty() && name.is_ascii() && !name.contains(' ') && !name.contains('?'),
            "invalid service name: {name:?}"
        );

        let mut pp = port_proto.split('/');
        let port: u16 = pp.next().unwrap().parse().expect("port u16");
        let proto: u8 = match pp.next().expect("proto") {
            "tcp" => 6,
            "udp" => 17,
            other => panic!("invalid protocol: {other}"),
        };
        assert!(pp.next().is_none(), "bad port/proto: {port_proto}");

        let key = (u32::from(port) << 8) | u32::from(proto);
        assert!(seen.insert(key), "duplicate (port,proto): {port_proto}");
        // {:?} emits a correctly-escaped Rust &str literal.
        map.entry(key, &format!("{name:?}"));
        n += 1;
    }
    assert_eq!(
        n, EXPECTED_ENTRIES,
        "expected {EXPECTED_ENTRIES} entries, got {n}"
    );

    writeln!(
        &mut out,
        "static SERVICES: phf::Map<u32, &'static str> = {};",
        map.build()
    )
    .unwrap();
}
