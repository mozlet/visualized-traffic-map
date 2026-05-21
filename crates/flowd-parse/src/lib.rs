//! Parser for the flowd binary log format (store v1).
//!
//! flowd is a NetFlow collector by Damien Miller. OPNsense's Insight feature
//! ships flowd 0.9.1 and writes `/var/log/flowd.log`. The on-disk format is
//! defined in `flowd/store.h`:
//!
//! ```text
//! struct store_flow {            // 8-byte record header, network byte order
//!     u_int8_t  version;         //   STORE_MKVER(3,0) = 0x60 for v1
//!     u_int8_t  len_words;       //   payload length in 4-byte words
//!     u_int16_t reserved;
//!     u_int32_t fields;          //   STORE_FIELD_* bitmask
//! };
//! ```
//!
//! The header is followed by `len_words * 4` bytes of payload. Optional
//! sub-records appear in the order of their STORE_FIELD_* bit index. All
//! multi-byte integers are big-endian on disk.
//!
//! References: store.h from `flowd-0.9.1`, OPNsense's
//! `/usr/local/opnsense/scripts/netflow/lib/flowparser.py`.

use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::Serialize;
use thiserror::Error;

const FIELD_TAG: u32 = 1 << 0;
const FIELD_RECV_TIME: u32 = 1 << 1;
const FIELD_PROTO_FLAGS_TOS: u32 = 1 << 2;
const FIELD_AGENT_ADDR4: u32 = 1 << 3;
const FIELD_AGENT_ADDR6: u32 = 1 << 4;
const FIELD_SRC_ADDR4: u32 = 1 << 5;
const FIELD_SRC_ADDR6: u32 = 1 << 6;
const FIELD_DST_ADDR4: u32 = 1 << 7;
const FIELD_DST_ADDR6: u32 = 1 << 8;
const FIELD_GATEWAY_ADDR4: u32 = 1 << 9;
const FIELD_GATEWAY_ADDR6: u32 = 1 << 10;
const FIELD_SRCDST_PORT: u32 = 1 << 11;
const FIELD_PACKETS: u32 = 1 << 12;
const FIELD_OCTETS: u32 = 1 << 13;
const FIELD_IF_INDICES: u32 = 1 << 14;
const FIELD_AGENT_INFO: u32 = 1 << 15;
const FIELD_FLOW_TIMES: u32 = 1 << 16;
const FIELD_AS_INFO: u32 = 1 << 17;
const FIELD_FLOW_ENGINE_INFO: u32 = 1 << 18;
const FIELD_CRC32: u32 = 1 << 30;

/// Expected version byte for store v1 (`STORE_MKVER(3, 0)`).
pub const STORE_V1_VERSION: u8 = 0x60;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("unexpected end of file inside record")]
    TruncatedRecord,
    #[error("payload length {payload} does not match consumed bytes {consumed} (fields=0x{fields:08x})")]
    PayloadMismatch {
        payload: usize,
        consumed: usize,
        fields: u32,
    },
    #[error("unsupported store version 0x{0:02x}")]
    UnsupportedVersion(u8),
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct FlowRecord {
    pub tag: Option<u32>,
    pub recv_sec: Option<u32>,
    pub recv_usec: Option<u32>,
    pub tcp_flags: Option<u8>,
    pub protocol: Option<u8>,
    pub tos: Option<u8>,
    pub agent_addr: Option<IpAddr>,
    pub src_addr: Option<IpAddr>,
    pub dst_addr: Option<IpAddr>,
    pub gateway_addr: Option<IpAddr>,
    pub src_port: Option<u16>,
    pub dst_port: Option<u16>,
    pub packets: Option<u64>,
    pub octets: Option<u64>,
    pub if_index_in: Option<u32>,
    pub if_index_out: Option<u32>,
    pub sys_uptime_ms: Option<u32>,
    pub agent_time_sec: Option<u32>,
    pub agent_time_nanosec: Option<u32>,
    pub netflow_version: Option<u16>,
    pub flow_start: Option<u32>,
    pub flow_finish: Option<u32>,
    pub src_as: Option<u32>,
    pub dst_as: Option<u32>,
    pub src_mask: Option<u8>,
    pub dst_mask: Option<u8>,
    pub engine_type: Option<u16>,
    pub engine_id: Option<u16>,
    pub flow_sequence: Option<u32>,
    pub source_id: Option<u32>,
    pub crc32: Option<u32>,
}

/// Read one record from `r`. Returns `Ok(None)` on a clean EOF before the next
/// header begins. Returns `Err(TruncatedRecord)` on EOF mid-record.
pub fn read_record<R: Read>(r: &mut R) -> Result<Option<FlowRecord>, ParseError> {
    let mut header = [0u8; 8];
    match r.read_exact(&mut header) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let version = header[0];
    if version != STORE_V1_VERSION {
        return Err(ParseError::UnsupportedVersion(version));
    }
    let len_words = header[1] as usize;
    // header[2..4] = reserved (u16 BE), ignored.
    let fields = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);

    let payload_len = len_words * 4;
    let mut payload = vec![0u8; payload_len];
    r.read_exact(&mut payload)
        .map_err(|e| match e.kind() {
            io::ErrorKind::UnexpectedEof => ParseError::TruncatedRecord,
            _ => ParseError::Io(e),
        })?;

    decode_payload(fields, &payload).map(Some)
}

/// Iterator yielding records until EOF. Returns parse errors as items;
/// callers decide whether to abort or skip.
pub struct FlowIter<R: Read> {
    reader: R,
    done: bool,
}

impl<R: Read> FlowIter<R> {
    pub fn new(reader: R) -> Self {
        Self { reader, done: false }
    }
}

impl<R: Read> Iterator for FlowIter<R> {
    type Item = Result<FlowRecord, ParseError>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        match read_record(&mut self.reader) {
            Ok(Some(rec)) => Some(Ok(rec)),
            Ok(None) => {
                self.done = true;
                None
            }
            Err(e) => {
                self.done = true;
                Some(Err(e))
            }
        }
    }
}

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], ParseError> {
        if self.remaining() < n {
            return Err(ParseError::TruncatedRecord);
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, ParseError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, ParseError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32, ParseError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Result<u64, ParseError> {
        let b = self.take(8)?;
        Ok(u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
    fn v4(&mut self) -> Result<IpAddr, ParseError> {
        let b = self.take(4)?;
        Ok(IpAddr::V4(Ipv4Addr::new(b[0], b[1], b[2], b[3])))
    }
    fn v6(&mut self) -> Result<IpAddr, ParseError> {
        let b = self.take(16)?;
        let mut arr = [0u8; 16];
        arr.copy_from_slice(b);
        Ok(IpAddr::V6(Ipv6Addr::from(arr)))
    }
}

fn decode_payload(fields: u32, payload: &[u8]) -> Result<FlowRecord, ParseError> {
    let mut c = Cursor::new(payload);
    let mut r = FlowRecord::default();

    if fields & FIELD_TAG != 0 {
        r.tag = Some(c.u32()?);
    }
    if fields & FIELD_RECV_TIME != 0 {
        r.recv_sec = Some(c.u32()?);
        r.recv_usec = Some(c.u32()?);
    }
    if fields & FIELD_PROTO_FLAGS_TOS != 0 {
        r.tcp_flags = Some(c.u8()?);
        r.protocol = Some(c.u8()?);
        r.tos = Some(c.u8()?);
        let _pad = c.u8()?;
    }
    if fields & FIELD_AGENT_ADDR4 != 0 {
        r.agent_addr = Some(c.v4()?);
    }
    if fields & FIELD_AGENT_ADDR6 != 0 {
        r.agent_addr = Some(c.v6()?);
    }
    if fields & FIELD_SRC_ADDR4 != 0 {
        r.src_addr = Some(c.v4()?);
    }
    if fields & FIELD_SRC_ADDR6 != 0 {
        r.src_addr = Some(c.v6()?);
    }
    if fields & FIELD_DST_ADDR4 != 0 {
        r.dst_addr = Some(c.v4()?);
    }
    if fields & FIELD_DST_ADDR6 != 0 {
        r.dst_addr = Some(c.v6()?);
    }
    if fields & FIELD_GATEWAY_ADDR4 != 0 {
        r.gateway_addr = Some(c.v4()?);
    }
    if fields & FIELD_GATEWAY_ADDR6 != 0 {
        r.gateway_addr = Some(c.v6()?);
    }
    if fields & FIELD_SRCDST_PORT != 0 {
        r.src_port = Some(c.u16()?);
        r.dst_port = Some(c.u16()?);
    }
    if fields & FIELD_PACKETS != 0 {
        r.packets = Some(c.u64()?);
    }
    if fields & FIELD_OCTETS != 0 {
        r.octets = Some(c.u64()?);
    }
    if fields & FIELD_IF_INDICES != 0 {
        r.if_index_in = Some(c.u32()?);
        r.if_index_out = Some(c.u32()?);
    }
    if fields & FIELD_AGENT_INFO != 0 {
        r.sys_uptime_ms = Some(c.u32()?);
        r.agent_time_sec = Some(c.u32()?);
        r.agent_time_nanosec = Some(c.u32()?);
        r.netflow_version = Some(c.u16()?);
        let _pad = c.u16()?;
    }
    if fields & FIELD_FLOW_TIMES != 0 {
        r.flow_start = Some(c.u32()?);
        r.flow_finish = Some(c.u32()?);
    }
    if fields & FIELD_AS_INFO != 0 {
        r.src_as = Some(c.u32()?);
        r.dst_as = Some(c.u32()?);
        r.src_mask = Some(c.u8()?);
        r.dst_mask = Some(c.u8()?);
        let _pad = c.u16()?;
    }
    if fields & FIELD_FLOW_ENGINE_INFO != 0 {
        r.engine_type = Some(c.u16()?);
        r.engine_id = Some(c.u16()?);
        r.flow_sequence = Some(c.u32()?);
        r.source_id = Some(c.u32()?);
    }
    if fields & FIELD_CRC32 != 0 {
        r.crc32 = Some(c.u32()?);
    }

    if c.remaining() != 0 {
        return Err(ParseError::PayloadMismatch {
            payload: payload.len(),
            consumed: c.pos,
            fields,
        });
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// First record extracted from a real OPNsense flowd.log via hexdump.
    /// version=0x60 len_words=23 reserved=0 fields=0x0003FAAE, payload 92 bytes.
    /// flowd-reader -v reported:
    ///   recv_time 2026-05-19T11:43:24.871119 proto 6 tcpflags 10 tos 00
    ///   agent [127.0.0.1] src [203.0.113.10]:1883 dst [192.0.2.4]:56368
    ///   gateway [192.0.2.254] packets 1 octets 40 in_if 0 out_if 1
    ///   sys_uptime_ms 2d15h27m25s.000 netflow ver 9
    ///   src_AS 0 src_masklen 0 dst_AS 0 dst_masklen 24
    const SAMPLE_RECORD_HEX: &str = "\
60170000\
0003faae\
6a0caf4c000d4acf\
10060000\
7f000001\
cb00710a\
c0000204\
c00002fe\
075bdc30\
0000000000000001\
0000000000000028\
0000000000000001\
0d9dcb486a0caf4c\
000000000009\
0000\
0d9d75580d9d7558\
0000000000000000\
00180000\
";

    fn hex_to_bytes(s: &str) -> Vec<u8> {
        let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..cleaned.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&cleaned[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn parses_first_real_record() {
        let bytes = hex_to_bytes(SAMPLE_RECORD_HEX);
        let mut cur = &bytes[..];
        let rec = read_record(&mut cur).unwrap().expect("record");
        assert_eq!(rec.protocol, Some(6));
        assert_eq!(rec.tcp_flags, Some(0x10));
        assert_eq!(rec.tos, Some(0x00));
        assert_eq!(
            rec.agent_addr.unwrap().to_string(),
            "127.0.0.1"
        );
        assert_eq!(rec.src_addr.unwrap().to_string(), "203.0.113.10");
        assert_eq!(rec.dst_addr.unwrap().to_string(), "192.0.2.4");
        assert_eq!(rec.gateway_addr.unwrap().to_string(), "192.0.2.254");
        assert_eq!(rec.src_port, Some(1883));
        assert_eq!(rec.dst_port, Some(56368));
        assert_eq!(rec.packets, Some(1));
        assert_eq!(rec.octets, Some(40));
        assert_eq!(rec.if_index_in, Some(0));
        assert_eq!(rec.if_index_out, Some(1));
        assert_eq!(rec.netflow_version, Some(9));
        assert_eq!(rec.dst_mask, Some(24));
        // recv_time 2026-05-19T11:43:24 → 0x6A0CAF4C in BE
        assert_eq!(rec.recv_sec, Some(0x6A0CAF4C));
        assert_eq!(rec.recv_usec, Some(0x000D4ACF));
    }

    #[test]
    fn returns_none_on_clean_eof() {
        let bytes: &[u8] = &[];
        let mut cur = bytes;
        assert!(matches!(read_record(&mut cur), Ok(None)));
    }
}
