//! Passive TLS SNI extraction from a pcap byte stream.
//!
//! Stock OPNsense `tcpdump` captures client→server TLS handshake packets and
//! streams them as pcap over ssh; this parses Ethernet→IP→TCP→TLS ClientHello
//! and pulls the `server_name` (SNI). Works for TLS 1.2 and 1.3 (the ClientHello
//! is cleartext either way) — the reason we abandoned Suricata's netmap eve-log,
//! which never associated SNI with its tls records on this box.
//!
//! All parsing is bounds-checked and returns `None` on anything malformed or
//! unsupported (IPv6 extension headers, fragmented ClientHellos, etc.).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// suffix → (app, category, confidence). Loaded from the `app_rules` table.
pub type RuleMap = HashMap<String, (String, Option<String>, f32)>;

/// Longest-suffix domain match on label boundaries — the most specific rule
/// wins (weixin.qq.com beats qq.com). Pure data lookup, no if-else cascade.
/// Returns (app, category, confidence, matched_suffix).
pub fn classify<'r, 's>(
    sni: &'s str,
    rules: &'r RuleMap,
) -> Option<(&'r str, Option<&'r str>, f32, &'s str)> {
    let sni = sni.trim_end_matches('.');
    let mut start = 0;
    loop {
        let cand = &sni[start..];
        if let Some((app, cat, conf)) = rules.get(cand) {
            return Some((app.as_str(), cat.as_deref(), *conf, cand));
        }
        match sni[start..].find('.') {
            Some(i) => start += i + 1, // drop the leftmost label, try shorter suffix
            None => return None,
        }
    }
}

pub const LINKTYPE_ETHERNET: u32 = 1;
pub const LINKTYPE_RAW: u32 = 101; // raw IP (some BPF/tun captures)
pub const LINKTYPE_NULL: u32 = 0; // BSD loopback: 4-byte AF header

#[inline]
pub fn read_u16(b: &[u8], le: bool) -> u16 {
    if le {
        u16::from_le_bytes([b[0], b[1]])
    } else {
        u16::from_be_bytes([b[0], b[1]])
    }
}

#[inline]
pub fn read_u32(b: &[u8], le: bool) -> u32 {
    if le {
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    } else {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    }
}

/// The connection 5-tuple plus the TCP payload of a captured packet.
pub struct Conn<'a> {
    pub src: IpAddr,
    pub src_port: u16,
    pub dst: IpAddr,
    pub dst_port: u16,
    pub tcp_payload: &'a [u8],
}

/// Strip link + IP + TCP headers, returning the 5-tuple and TCP payload.
pub fn parse_packet(linktype: u32, data: &[u8]) -> Option<Conn<'_>> {
    let l3 = match linktype {
        LINKTYPE_ETHERNET => strip_ethernet(data)?,
        LINKTYPE_RAW => Some(data)?,
        LINKTYPE_NULL => data.get(4..)?, // 4-byte address-family header
        _ => return None,
    };
    parse_ip_tcp(l3)
}

/// Returns the L3 payload (IP packet) after an Ethernet header, following one
/// optional 802.1Q VLAN tag. Only IPv4/IPv6 ethertypes pass through.
fn strip_ethernet(data: &[u8]) -> Option<&[u8]> {
    let mut off = 14;
    let mut ethertype = read_u16(data.get(12..14)?, false);
    if ethertype == 0x8100 {
        // VLAN: 2 bytes TCI + 2 bytes inner ethertype
        ethertype = read_u16(data.get(16..18)?, false);
        off = 18;
    }
    match ethertype {
        0x0800 | 0x86DD => data.get(off..),
        _ => None,
    }
}

fn parse_ip_tcp(ip: &[u8]) -> Option<Conn<'_>> {
    let version = ip.first()? >> 4;
    let (src, dst, l4) = match version {
        4 => {
            let ihl = (ip[0] & 0x0f) as usize * 4;
            if ihl < 20 || ip.get(9).copied()? != 6 {
                return None; // not TCP
            }
            let src = IpAddr::V4(Ipv4Addr::new(ip[12], ip[13], ip[14], ip[15]));
            let dst = IpAddr::V4(Ipv4Addr::new(ip[16], ip[17], ip[18], ip[19]));
            (src, dst, ip.get(ihl..)?)
        }
        6 => {
            if ip.len() < 40 || ip[6] != 6 {
                return None; // TCP only; skip extension-header chains
            }
            let s: [u8; 16] = ip[8..24].try_into().ok()?;
            let d: [u8; 16] = ip[24..40].try_into().ok()?;
            (
                IpAddr::V6(Ipv6Addr::from(s)),
                IpAddr::V6(Ipv6Addr::from(d)),
                ip.get(40..)?,
            )
        }
        _ => return None,
    };

    let src_port = read_u16(l4.get(0..2)?, false);
    let dst_port = read_u16(l4.get(2..4)?, false);
    let data_off = (l4.get(12).copied()? >> 4) as usize * 4;
    let tcp_payload = l4.get(data_off..)?;
    Some(Conn {
        src,
        src_port,
        dst,
        dst_port,
        tcp_payload,
    })
}

/// Extract the SNI host_name from a TLS ClientHello carried in `payload`.
/// Returns `None` if it is not a single-segment ClientHello with a server_name.
pub fn parse_client_hello_sni(payload: &[u8]) -> Option<String> {
    // TLS record: type(0x16 handshake), version(2), length(2)
    if *payload.first()? != 0x16 {
        return None;
    }
    let mut c = Cursor::new(payload.get(5..)?); // handshake message
                                                // Handshake header: type(0x01 ClientHello), length(3)
    if c.u8()? != 0x01 {
        return None;
    }
    let _hs_len = c.u24()?;
    c.skip(2)?; // client_version
    c.skip(32)?; // random
    let sid_len = c.u8()? as usize;
    c.skip(sid_len)?; // session_id
    let cs_len = c.u16()? as usize;
    c.skip(cs_len)?; // cipher_suites
    let comp_len = c.u8()? as usize;
    c.skip(comp_len)?; // compression_methods
    let _ext_total = c.u16()?; // extensions length

    // Walk extensions; server_name is type 0x0000.
    while let Some(ext_type) = c.u16() {
        let ext_len = c.u16()? as usize;
        let ext = c.take(ext_len)?;
        if ext_type == 0x0000 {
            return parse_server_name(ext);
        }
    }
    None
}

/// server_name extension: list_len(2), then entries of name_type(1)+name_len(2)+name.
/// We return the first host_name (name_type 0).
fn parse_server_name(ext: &[u8]) -> Option<String> {
    let mut c = Cursor::new(ext);
    let _list_len = c.u16()?;
    while let Some(name_type) = c.u8() {
        let name_len = c.u16()? as usize;
        let name = c.take(name_len)?;
        if name_type == 0 {
            let s = std::str::from_utf8(name).ok()?;
            // sanity: a hostname, not binary garbage
            if !s.is_empty() && s.len() <= 253 && s.bytes().all(|b| b.is_ascii_graphic()) {
                return Some(s.to_ascii_lowercase());
            }
        }
    }
    None
}

/// Minimal bounds-checked big-endian byte cursor (TLS is network byte order).
struct Cursor<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.pos..self.pos + n)?;
        self.pos += n;
        Some(s)
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        self.take(n).map(|_| ())
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|s| s[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|s| read_u16(s, false))
    }
    fn u24(&mut self) -> Option<u32> {
        self.take(3)
            .map(|s| u32::from_be_bytes([0, s[0], s[1], s[2]]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real-ish ClientHello with SNI = "example.com".
    fn client_hello(sni: &str) -> Vec<u8> {
        let host = sni.as_bytes();
        let mut sn_ext = Vec::new(); // server_name extension body
        let entry_len = 1 + 2 + host.len();
        sn_ext.extend_from_slice(&(entry_len as u16).to_be_bytes()); // server_name_list len
        sn_ext.push(0); // name_type host_name
        sn_ext.extend_from_slice(&(host.len() as u16).to_be_bytes());
        sn_ext.extend_from_slice(host);

        let mut exts = Vec::new();
        exts.extend_from_slice(&0x0000u16.to_be_bytes()); // ext type server_name
        exts.extend_from_slice(&(sn_ext.len() as u16).to_be_bytes());
        exts.extend_from_slice(&sn_ext);

        let mut body = Vec::new();
        body.extend_from_slice(&[0x03, 0x03]); // client_version TLS1.2
        body.extend_from_slice(&[0u8; 32]); // random
        body.push(0); // session_id len
        body.extend_from_slice(&2u16.to_be_bytes()); // cipher_suites len
        body.extend_from_slice(&[0x13, 0x01]); // one cipher
        body.push(1); // compression methods len
        body.push(0); // null compression
        body.extend_from_slice(&(exts.len() as u16).to_be_bytes());
        body.extend_from_slice(&exts);

        let mut hs = Vec::new();
        hs.push(0x01); // ClientHello
        let l = body.len();
        hs.extend_from_slice(&[(l >> 16) as u8, (l >> 8) as u8, l as u8]);
        hs.extend_from_slice(&body);

        let mut rec = Vec::new();
        rec.push(0x16); // handshake
        rec.extend_from_slice(&[0x03, 0x01]); // record version
        rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
        rec.extend_from_slice(&hs);
        rec
    }

    #[test]
    fn extracts_sni() {
        let ch = client_hello("Example.COM");
        assert_eq!(parse_client_hello_sni(&ch).as_deref(), Some("example.com"));
    }

    #[test]
    fn rejects_non_handshake() {
        assert_eq!(parse_client_hello_sni(&[0x17, 0x03, 0x03, 0, 0]), None);
    }

    #[test]
    fn truncated_is_none() {
        let ch = client_hello("example.com");
        assert_eq!(parse_client_hello_sni(&ch[..20]), None);
    }

    #[test]
    fn classify_longest_suffix_wins() {
        let mut r = RuleMap::new();
        r.insert(
            "qq.com".into(),
            ("Tencent".into(), Some("social".into()), 0.9),
        );
        r.insert(
            "weixin.qq.com".into(),
            ("WeChat".into(), Some("chat".into()), 0.9),
        );
        r.insert(
            "meituan.com".into(),
            ("Meituan".into(), Some("food".into()), 0.9),
        );
        assert_eq!(
            classify("szminorshort.weixin.qq.com", &r).map(|x| x.0),
            Some("WeChat")
        );
        assert_eq!(classify("api.qq.com", &r).map(|x| x.0), Some("Tencent"));
        assert_eq!(
            classify("apimobile.meituan.com", &r).map(|x| x.0),
            Some("Meituan")
        );
        assert_eq!(classify("unknown.example.org", &r), None);
    }
}
