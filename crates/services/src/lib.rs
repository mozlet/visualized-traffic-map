//! Port→service-name lookup, compiled at build time from `services.txt`
//! (nmap-services derived). Approach adapted from sniffnet (MIT/Apache-2.0):
//! https://github.com/GyulyVGC/sniffnet — the `services.txt` data and the
//! phf-codegen build step are borrowed; key encoding differs (single u32).

include!(concat!(env!("OUT_DIR"), "/services.rs"));

/// IANA protocol numbers covered by `services.txt`.
pub const TCP: u8 = 6;
pub const UDP: u8 = 17;

#[inline]
fn key(port: u16, proto: u8) -> u32 {
    (u32::from(port) << 8) | u32::from(proto)
}

/// Well-known service name for a `(port, protocol)` pair, if any.
/// `proto` is the IANA protocol number (6 = TCP, 17 = UDP); other protocols
/// always return `None` since `services.txt` only covers TCP/UDP.
pub fn service_name(port: u16, proto: u8) -> Option<&'static str> {
    SERVICES.get(&key(port, proto)).copied()
}

/// Resolve the service for a flow, preferring the destination port (the server
/// side in a client→server flow) and falling back to the source port.
pub fn flow_service(
    src_port: Option<u16>,
    dst_port: Option<u16>,
    proto: Option<u8>,
) -> Option<&'static str> {
    let proto = proto?;
    dst_port
        .and_then(|p| service_name(p, proto))
        .or_else(|| src_port.and_then(|p| service_name(p, proto)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_services() {
        assert_eq!(service_name(443, TCP), Some("https"));
        assert_eq!(service_name(80, TCP), Some("http"));
        assert_eq!(service_name(53, UDP), Some("domain"));
        assert_eq!(service_name(22, TCP), Some("ssh"));
        assert_eq!(service_name(123, UDP), Some("ntp"));
    }

    #[test]
    fn unknown_and_non_tcp_udp() {
        assert_eq!(service_name(1, 1), None); // ICMP proto, not in table
        assert_eq!(service_name(0, TCP), None);
    }

    #[test]
    fn flow_prefers_dst_then_src() {
        assert_eq!(
            flow_service(Some(54321), Some(443), Some(TCP)),
            Some("https")
        );
        assert_eq!(
            flow_service(Some(443), Some(54321), Some(TCP)),
            Some("https")
        );
        assert_eq!(flow_service(Some(54321), Some(54322), Some(TCP)), None);
        assert_eq!(flow_service(Some(443), Some(443), None), None);
    }
}
