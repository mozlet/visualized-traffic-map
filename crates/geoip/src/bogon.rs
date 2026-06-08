//! Bogon / reserved IP range classification.
//!
//! Ported from sniffnet (MIT/Apache-2.0): https://github.com/GyulyVGC/sniffnet
//! (src/networking/types/bogon.rs). Returns a human-readable class for a
//! reserved / special-use address. `is_local()` already decides *whether* an
//! address is non-public; this adds *which* reserved class it is, so geo-doctor
//! can tell an ordinary "private-use" host apart from a "carrier-grade NAT" or
//! "documentation" address that should never be a real flow endpoint.

use ipnet::IpNet;
use std::net::IpAddr;
use std::sync::LazyLock;

// (CIDR, description). The ranges are disjoint, so iteration order is irrelevant.
static BOGONS: LazyLock<Vec<(IpNet, &'static str)>> = LazyLock::new(|| {
    [
        // IPv4
        ("0.0.0.0/8", "\"this\" network"),
        ("10.0.0.0/8", "private-use"),
        ("172.16.0.0/12", "private-use"),
        ("192.168.0.0/16", "private-use"),
        ("100.64.0.0/10", "carrier-grade NAT"),
        ("127.0.0.0/8", "loopback"),
        ("169.254.0.0/16", "link-local"),
        ("192.0.0.0/24", "IETF protocol assignments"),
        ("192.0.2.0/24", "TEST-NET-1"),
        ("198.18.0.0/15", "benchmark testing"),
        ("198.51.100.0/24", "TEST-NET-2"),
        ("203.0.113.0/24", "TEST-NET-3"),
        ("224.0.0.0/4", "multicast"),
        ("240.0.0.0/4", "future use"),
        // IPv6
        ("::/128", "node-scope unspecified"),
        ("::1/128", "node-scope loopback"),
        ("::ffff:0.0.0.0/96", "IPv4-mapped"),
        ("::/96", "IPv4-compatible"),
        ("100::/64", "remotely triggered black hole"),
        ("2001:10::/28", "ORCHID"),
        ("2001:db8::/32", "documentation prefix"),
        ("3fff::/20", "documentation prefix"),
        ("fc00::/7", "ULA"),
        ("fe80::/10", "link-local unicast"),
        ("fec0::/10", "site-local unicast"),
        ("ff00::/8", "multicast v6"),
    ]
    .iter()
    .map(|(cidr, desc)| (cidr.parse().expect("static bogon CIDR"), *desc))
    .collect()
});

/// Classify a reserved / special-use ("bogon") address, returning its
/// description (e.g. "private-use", "carrier-grade NAT"). `None` for ordinary
/// public addresses.
pub fn bogon_class(address: &IpAddr) -> Option<&'static str> {
    BOGONS
        .iter()
        .find(|(net, _)| net.contains(address))
        .map(|(_, desc)| *desc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn b(s: &str) -> Option<&'static str> {
        bogon_class(&IpAddr::from_str(s).unwrap())
    }

    #[test]
    fn public_is_none() {
        assert_eq!(b("8.8.8.8"), None);
        assert_eq!(b("2606:4700:4700::1111"), None);
    }

    #[test]
    fn classifies_reserved_ranges() {
        // also forces the LazyLock to parse every CIDR (would panic on a typo)
        assert_eq!(b("10.1.2.3"), Some("private-use"));
        assert_eq!(b("172.22.2.3"), Some("private-use"));
        assert_eq!(b("100.99.2.1"), Some("carrier-grade NAT"));
        assert_eq!(b("192.0.2.5"), Some("TEST-NET-1"));
        assert_eq!(b("224.0.0.1"), Some("multicast"));
        assert_eq!(b("fdff::"), Some("ULA"));
        assert_eq!(b("2001:db8::1"), Some("documentation prefix"));
    }
}
