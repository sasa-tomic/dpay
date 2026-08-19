//! reply — decoding the IC `/api/v2` RESPONSES (queries + read_state certificates).
//!
//! The inverse of [`crate::envelope`]: everything the boundary node sends BACK after a signed
//! request is submitted. This is the lenient CBOR reader (the IC emits ints, bytes, text, arrays,
//! maps — with indefinite lengths on the dfx replica) plus the `/query` response shape and the
//! `/read_state` certificate hashtree with `request_status/<rid>` extraction.
//!
//! Pure, alloc-only, no deps — shared by the app (via UniFFI/wasm) and the e2e harness, so every
//! surface decodes responses with the SAME code. Trust note (W6 follow-up): the certificate tree
//! is DECODED here, not BLS-verified — callers treat `request_status` answers as
//! boundary-node-sourced until the on-device cert-chain check lands.

use crate::IcpError;
use std::fmt::Write as _;

/// Everything here fails with a textual CBOR/shape error (decoded-from-the-wire input).
fn err<T>(msg: impl Into<String>) -> Result<T, IcpError> {
    Err(IcpError::CborDecode(msg.into()))
}

// --- minimal CBOR ------------------------------------------------------------------------------
// The IC /api/v2 emits ints, bytes, text, arrays, maps. Tag headers (incl. the 0xd9d9f7
// self-describe prefix) are skipped; indefinite lengths (info 31 on strings/arrays/maps) are
// accepted — the dfx replica's read_state responses use them.

/// A parsed CBOR value — exactly the subset the IC API emits.
#[derive(Debug, Clone, PartialEq)]
pub enum Cbor {
    Uint(u64),
    NInt(i64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Cbor>),
    Map(Vec<(Cbor, Cbor)>),
}

impl Cbor {
    /// Map lookup by text key.
    pub fn get(&self, key: &str) -> Option<&Cbor> {
        if let Cbor::Map(pairs) = self {
            pairs.iter().find(|(k, _)| matches!(k, Cbor::Text(t) if t == key)).map(|(_, v)| v)
        } else {
            None
        }
    }

    /// Mutable map lookup by text key (for mutating one field of a decoded envelope).
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Cbor> {
        if let Cbor::Map(pairs) = self {
            pairs.iter_mut().find(|(k, _)| matches!(k, Cbor::Text(t) if t == key)).map(|(_, v)| v)
        } else {
            None
        }
    }

    pub fn as_bytes(&self) -> Option<&[u8]> {
        if let Cbor::Bytes(b) = self { Some(b) } else { None }
    }

    pub fn as_text(&self) -> Option<&str> {
        if let Cbor::Text(t) = self { Some(t) } else { None }
    }

    pub fn as_u64(&self) -> Option<u64> {
        if let Cbor::Uint(n) = self { Some(*n) } else { None }
    }
}

/// Parse exactly one CBOR value; trailing bytes are an error (each response is a single value).
pub fn cbor_parse(data: &[u8]) -> Result<Cbor, IcpError> {
    let (value, rest) = cbor_read(data)?;
    if !rest.is_empty() {
        return err(format!("{} trailing bytes after CBOR value", rest.len()));
    }
    Ok(value)
}

/// Encode a value back to definite-length CBOR (ints, bytes, text, arrays, maps). Used to
/// re-encode a decoded envelope after mutating one field (the bad-signature negative control:
/// flip a byte of `sender_sig`, keep everything else, re-submit — the ingress must 4xx it).
pub fn cbor_encode(v: &Cbor, out: &mut Vec<u8>) {
    /// head(major, len) — definite length, shortest int encoding.
    fn head(out: &mut Vec<u8>, major: u8, len: usize) {
        let m = major << 5;
        match u64::try_from(len) {
            Ok(n) if n < 24 => out.push(m | n as u8),
            Ok(n) if n <= 0xff => {
                out.push(m | 24);
                out.push(n as u8);
            }
            Ok(n) if n <= 0xffff => {
                out.push(m | 25);
                out.extend_from_slice(&(n as u16).to_be_bytes());
            }
            Ok(n) if n <= 0xffff_ffff => {
                out.push(m | 26);
                out.extend_from_slice(&(n as u32).to_be_bytes());
            }
            Ok(n) => {
                out.push(m | 27);
                out.extend_from_slice(&n.to_be_bytes());
            }
            Err(_) => unreachable!("usize fits u64"),
        }
    }
    match v {
        Cbor::Uint(n) if *n < 24 => out.push(*n as u8),
        Cbor::Uint(n) => head(out, 0, *n as usize),
        Cbor::NInt(n) => {
            let n = -1 - *n;
            if n >= 0 && n < 24 {
                out.push(0x20 | n as u8);
            } else {
                head(out, 1, u64::try_from(n).unwrap() as usize)
            }
        }
        Cbor::Bytes(b) => {
            head(out, 2, b.len());
            out.extend_from_slice(b);
        }
        Cbor::Text(t) => {
            head(out, 3, t.len());
            out.extend_from_slice(t.as_bytes());
        }
        Cbor::Array(items) => {
            head(out, 4, items.len());
            for item in items {
                cbor_encode(item, out);
            }
        }
        Cbor::Map(pairs) => {
            head(out, 5, pairs.len());
            for (k, val) in pairs {
                cbor_encode(k, out);
                cbor_encode(val, out);
            }
        }
    }
}

fn cbor_read(data: &[u8]) -> Result<(Cbor, &[u8]), IcpError> {
    let (&head, rest) = match data.split_first() {
        Some(x) => x,
        None => return err("empty CBOR input"),
    };
    let major = head >> 5;
    let info = head & 0x1f;
    // Indefinite lengths (info 31): chunks/pairs until the 0xff break marker. The dfx replica's
    // read_state responses use them; ic-agent's serde stack accepts them too.
    if info == 31 {
        let mut rest = rest;
        return Ok(match major {
            2 | 3 => {
                let mut buf = Vec::new();
                loop {
                    let Some(&next) = rest.first() else { return err("unterminated indefinite-length string") };
                    if next == 0xff {
                        rest = &rest[1..];
                        break;
                    }
                    let (chunk, r) = cbor_read(rest)?;
                    match (major, chunk) {
                        (2, Cbor::Bytes(b)) => buf.extend_from_slice(&b),
                        (3, Cbor::Text(t)) => buf.extend_from_slice(t.as_bytes()),
                        _ => return err("indefinite-length string chunk is not a string"),
                    }
                    rest = r;
                }
                if major == 2 {
                    (Cbor::Bytes(buf), rest)
                } else {
                    match String::from_utf8(buf) {
                        Ok(text) => (Cbor::Text(text), rest),
                        Err(e) => return err(format!("invalid CBOR text: {e}")),
                    }
                }
            }
            4 => {
                let mut items = Vec::new();
                loop {
                    let Some(&next) = rest.first() else { return err("unterminated indefinite-length array") };
                    if next == 0xff {
                        rest = &rest[1..];
                        break;
                    }
                    let (v, r) = cbor_read(rest)?;
                    items.push(v);
                    rest = r;
                }
                (Cbor::Array(items), rest)
            }
            5 => {
                let mut pairs = Vec::new();
                loop {
                    let Some(&next) = rest.first() else { return err("unterminated indefinite-length map") };
                    if next == 0xff {
                        rest = &rest[1..];
                        break;
                    }
                    let (k, r) = cbor_read(rest)?;
                    let (v, r) = cbor_read(r)?;
                    pairs.push((k, v));
                    rest = r;
                }
                (Cbor::Map(pairs), rest)
            }
            _ => return err(format!("indefinite length on unsupported major type {major}")),
        });
    }
    let (arg, rest) = read_arg(info, rest)?;
    Ok(match major {
        0 => (Cbor::Uint(arg), rest),
        1 => {
            let n = i64::try_from(arg).map_err(|_| IcpError::CborDecode("CBOR negative int out of i64 range".into()))?;
            (Cbor::NInt(-1 - n), rest)
        }
        2 => {
            let (payload, tail) = take(arg, rest)?;
            (Cbor::Bytes(payload.to_vec()), tail)
        }
        3 => {
            let (payload, tail) = take(arg, rest)?;
            let text = match String::from_utf8(payload.to_vec()) {
                Ok(t) => t,
                Err(e) => return err(format!("invalid CBOR text: {e}")),
            };
            (Cbor::Text(text), tail)
        }
        4 => {
            let (items, tail) = read_seq(rest, arg, "array")?;
            (Cbor::Array(items), tail)
        }
        5 => {
            let n = usize::try_from(arg).map_err(|_| IcpError::CborDecode("CBOR map length exceeds usize".into()))?;
            let mut pairs = Vec::with_capacity(n.min(1024));
            let mut rest = rest;
            for i in 0..n {
                let (k, r) = cbor_read(rest).map_err(|e| map_ctx(e, format!("map key {i}")))?;
                let (v, r) = cbor_read(r).map_err(|e| map_ctx(e, format!("map value {i}")))?;
                pairs.push((k, v));
                rest = r;
            }
            (Cbor::Map(pairs), rest)
        }
        6 => cbor_read(rest)?, // tag header — skip, keep the tagged value
        _ => return err("floats/simple values are not emitted by the IC API"),
    })
}

/// Prefix a context note onto an existing CborDecode error (map/array item positions).
fn map_ctx(e: IcpError, ctx: String) -> IcpError {
    match e {
        IcpError::CborDecode(m) => IcpError::CborDecode(format!("{ctx}: {m}")),
        other => other,
    }
}

fn read_arg(info: u8, data: &[u8]) -> Result<(u64, &[u8]), IcpError> {
    Ok(match info {
        0..=23 => (u64::from(info), data),
        24 => {
            let (b, r) = match data.split_first() {
                Some(x) => x,
                None => return err("truncated CBOR u8 length"),
            };
            (u64::from(*b), r)
        }
        25 => {
            let (head, tail) = take(2, data)?;
            (u64::from(u16::from_be_bytes(head.try_into().unwrap())), tail)
        }
        26 => {
            let (head, tail) = take(4, data)?;
            (u64::from(u32::from_be_bytes(head.try_into().unwrap())), tail)
        }
        27 => {
            let (head, tail) = take(8, data)?;
            (u64::from_be_bytes(head.try_into().unwrap()), tail)
        }
        _ => return err("reserved CBOR info bits 28-30"),
    })
}

/// Split `len` payload bytes off the front, bounds-checked.
fn take(len: u64, data: &[u8]) -> Result<(&[u8], &[u8]), IcpError> {
    let len = usize::try_from(len).map_err(|_| IcpError::CborDecode("CBOR length exceeds usize".into()))?;
    if data.len() < len {
        return err(format!("truncated CBOR payload: want {len} bytes, have {}", data.len()));
    }
    Ok((&data[..len], &data[len..]))
}

fn read_seq<'a>(data: &'a [u8], n: u64, what: &str) -> Result<(Vec<Cbor>, &'a [u8]), IcpError> {
    let n = usize::try_from(n).map_err(|_| IcpError::CborDecode(format!("{what} length exceeds usize")))?;
    let mut items = Vec::with_capacity(n.min(1024));
    let mut rest = data;
    for i in 0..n {
        let (v, r) = cbor_read(rest).map_err(|e| map_ctx(e, format!("{what} item {i}")))?;
        items.push(v);
        rest = r;
    }
    Ok((items, rest))
}

// --- /query response ----------------------------------------------------------------------------

/// A decoded `/api/v2/.../query` response body.
#[derive(Debug, Clone, PartialEq)]
pub enum QueryOutcome {
    /// `status=replied` — the candid reply arg bytes (`reply.arg`).
    Replied(Vec<u8>),
    /// `status=rejected`.
    Rejected { reject_code: u64, reject_message: String, error_code: Option<String> },
}

/// Decode a query response body: `{status: replied, reply: {arg: bstr}}` or
/// `{status: rejected, reject_code, reject_message, error_code?}` (unknown fields ignored).
pub fn decode_query_response(body: &[u8]) -> Result<QueryOutcome, IcpError> {
    let v = cbor_parse(body).map_err(|e| ctx(e, format!("query body (hex head: {})", hex_head(body))))?;
    let status = match v.get("status").and_then(Cbor::as_text) {
        Some(s) => s,
        None => return err("query response missing status"),
    };
    match status {
        "replied" => {
            let arg = match v.get("reply").and_then(|r| r.get("arg")).and_then(Cbor::as_bytes) {
                Some(b) => b.to_vec(),
                None => return err("replied query response missing reply.arg"),
            };
            Ok(QueryOutcome::Replied(arg))
        }
        "rejected" => Ok(QueryOutcome::Rejected {
            reject_code: match v.get("reject_code").and_then(Cbor::as_u64) {
                Some(c) => c,
                None => return err("rejected query response missing reject_code"),
            },
            reject_message: match v.get("reject_message").and_then(Cbor::as_text) {
                Some(m) => m.to_string(),
                None => return err("rejected query response missing reject_message"),
            },
            error_code: v.get("error_code").and_then(Cbor::as_text).map(str::to_string),
        }),
        other => err(format!("unexpected query status {other:?}")),
    }
}

// --- /read_state response: certificate + hashtree ------------------------------------------------
// Certificate CBOR: `{tree: <HashTree>, signature: bstr, delegation?}`. HashTree (per the public
// spec CDDL): empty=[0] | fork=[1, tree, tree] | labeled=[2, bstr, tree] | leaf=[3, bstr] |
// pruned=[4, bstr32]. request_status lives under labeled path request_status/<rid>/<field>.

/// A certificate hashtree node.
#[derive(Debug, Clone, PartialEq)]
pub enum Tree {
    Empty,
    Fork(Box<Tree>, Box<Tree>),
    Labeled(Vec<u8>, Box<Tree>),
    Leaf(Vec<u8>),
    Pruned([u8; 32]),
}

/// Decode a `/read_state` response body (`{certificate: bstr}`) into its certificate hashtree.
pub fn decode_read_state_tree(body: &[u8]) -> Result<Tree, IcpError> {
    let v = cbor_parse(body).map_err(|e| ctx(e, format!("read_state body (hex head: {})", hex_head(body))))?;
    let cert = match v.get("certificate").and_then(Cbor::as_bytes) {
        Some(b) => b,
        None => return err("read_state response missing certificate"),
    };
    let cert = cbor_parse(cert).map_err(|e| ctx(e, format!("certificate (hex head: {})", hex_head(cert))))?;
    match cert.get("tree") {
        Some(t) => tree_from_cbor(t),
        None => err("certificate missing tree"),
    }
}

/// First 32 bytes of `data` as hex, for parse-failure diagnostics.
fn hex_head(data: &[u8]) -> String {
    let mut s = String::new();
    for b in data.iter().take(32) {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Prefix a context note onto an existing CborDecode error.
fn ctx(e: IcpError, note: String) -> IcpError {
    map_ctx(e, note)
}

fn tree_from_cbor(v: &Cbor) -> Result<Tree, IcpError> {
    let Cbor::Array(items) = v else {
        return err("hashtree node must be a CBOR array");
    };
    let tag = match items.first().and_then(Cbor::as_u64) {
        Some(t) => t,
        None => return err("hashtree node missing tag"),
    };
    Ok(match (tag, items.len()) {
        (0, 1) => Tree::Empty,
        (1, 3) => Tree::Fork(Box::new(tree_from_cbor(&items[1])?), Box::new(tree_from_cbor(&items[2])?)),
        (2, 3) => {
            let label = match items[1].as_bytes() {
                Some(b) => b.to_vec(),
                None => return err("hashtree fork label must be bytes"),
            };
            Tree::Labeled(label, Box::new(tree_from_cbor(&items[2])?))
        }
        (3, 2) => Tree::Leaf(match items[1].as_bytes() {
            Some(b) => b.to_vec(),
            None => return err("hashtree leaf must be bytes"),
        }),
        (4, 2) => {
            let digest: [u8; 32] = match items[1].as_bytes().and_then(|b| b.try_into().ok()) {
                Some(d) => d,
                None => return err("hashtree pruned digest must be 32 bytes"),
            };
            Tree::Pruned(digest)
        }
        _ => return err(format!("malformed hashtree node: tag {tag}, {len} items", len = items.len())),
    })
}

/// Result of a hashtree path lookup (IC certification semantics).
#[derive(Debug, Clone, PartialEq)]
pub enum Lookup {
    Found(Vec<u8>),
    Absent,
    Unknown,
}

/// Look up `path` in the hashtree. Forks descend BOTH sides (the replica returns the full tree
/// for the requested paths, so label-order tricks are unnecessary); a `Pruned` node on a needed
/// path yields `Unknown`.
/// Find the immediate `Labeled(label, _)` child of `node`, descending forks on BOTH sides —
/// a Pruned sibling must not block the descent (ic-agent `lookup_path` semantics: at a fork it
/// checks each child for a matching label; the real replica's certs routinely carry
/// `Fork(Pruned, Fork(…, Labeled(request_status, …)))`).
fn find_labeled<'a>(node: &'a Tree, label: &[u8]) -> Option<&'a Tree> {
    match node {
        Tree::Labeled(l, sub) if l.as_slice() == label => Some(sub),
        Tree::Fork(l, r) => find_labeled(l, label).or_else(|| find_labeled(r, label)),
        _ => None,
    }
}

pub fn tree_lookup(tree: &Tree, path: &[&[u8]]) -> Lookup {
    let mut current = tree;
    for label in path {
        current = match find_labeled(current, label) {
            Some(sub) => sub,
            // Not under any reachable branch. (ic-agent further splits Absent vs Unknown via
            // hash-reachability through Pruned nodes; for the poll loop both mean "keep
            // polling", and the leaf-level Pruned case below still reports Unknown.)
            None => return Lookup::Absent,
        };
    }
    match current {
        Tree::Leaf(v) => Lookup::Found(v.clone()),
        // Pruned (or a subtree) at the path's end: the path exists but its value is hidden.
        _ => Lookup::Unknown,
    }
}

/// unsigned LEB128 (how `nat` leaf values — e.g. `reject_code`, `time` — are encoded in certificates).
pub fn uleb(b: &[u8]) -> Result<u64, IcpError> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    for &byte in b {
        if shift >= 64 {
            return err("uleb overflow");
        }
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
    }
    err("truncated uleb")
}

/// A request's status read from a read_state certificate (`request_status/<rid>/…`).
#[derive(Debug, Clone, PartialEq)]
pub enum RequestStatus {
    Unknown,
    Received,
    Processing,
    /// `replied` — the reply arg bytes.
    Replied(Vec<u8>),
    Rejected { reject_code: u64, reject_message: String, error_code: Option<String> },
    Done,
}

/// Extract the request status of `request_id` from a read_state certificate tree.
pub fn request_status(tree: &Tree, request_id: &[u8; 32]) -> Result<RequestStatus, IcpError> {
    let rid: &[u8] = request_id;
    let status = match tree_lookup(tree, &[b"request_status", rid, b"status"]) {
        // Absent OR Pruned (Unknown) both mean "no terminal answer in THIS certificate" —
        // ic-agent keeps polling in both cases; the poll loop re-submits read_state.
        Lookup::Absent | Lookup::Unknown => return Ok(RequestStatus::Unknown),
        Lookup::Found(b) => match String::from_utf8(b) {
            Ok(s) => s,
            Err(e) => return err(format!("request status leaf is not utf8: {e}")),
        },
    };
    match status.as_str() {
        "done" => Ok(RequestStatus::Done),
        "received" => Ok(RequestStatus::Received),
        "processing" => Ok(RequestStatus::Processing),
        "replied" => match tree_lookup(tree, &[b"request_status", rid, b"reply"]) {
            // The leaf is a CBOR-encoded reply record `{arg: bstr}` (per the IC spec / ic-agent);
            // unwrap it, falling back to the raw leaf if a non-conforming tree shows up.
            Lookup::Found(raw) => {
                let arg = cbor_parse(&raw)
                    .ok()
                    .and_then(|r| r.get("arg").and_then(Cbor::as_bytes).map(|b| b.to_vec()))
                    .unwrap_or(raw);
                Ok(RequestStatus::Replied(arg))
            }
            _ => err("status=replied but reply path missing"),
        },
        "rejected" => {
            let reject_code = match tree_lookup(tree, &[b"request_status", rid, b"reject_code"]) {
                Lookup::Found(b) => uleb(&b)?,
                _ => return err("status=rejected but reject_code path missing"),
            };
            let reject_message = match tree_lookup(tree, &[b"request_status", rid, b"reject_message"]) {
                Lookup::Found(b) => match String::from_utf8(b) {
                    Ok(s) => s,
                    Err(e) => return err(format!("reject_message leaf is not utf8: {e}")),
                },
                _ => return err("status=rejected but reject_message path missing"),
            };
            let error_code = match tree_lookup(tree, &[b"request_status", rid, b"error_code"]) {
                Lookup::Found(b) => match String::from_utf8(b) {
                    Ok(s) => Some(s),
                    Err(_) => return err("error_code leaf is not utf8"),
                },
                // Absent = field omitted; Pruned (Unknown) = inconclusive — same "no answer yet"
                // semantics as the status lookup: keep polling rather than guess.
                Lookup::Absent | Lookup::Unknown => None,
            };
            Ok(RequestStatus::Rejected { reject_code, reject_message, error_code })
        }
        other => err(format!("unknown request status {other:?}")),
    }
}

/// The subnet's certified `time` leaf from a read_state certificate (ns since epoch). `None` when
/// the path is absent/pruned in this certificate — callers re-poll. This is the app's clock-sync
/// source: the boundary's `/api/v2/status` on icp-api.io does NOT carry `ic:time` (measured:
/// map(2) {root_key, replica_health_status} only), so a signed read_state with `paths=[[time]]`
/// is the certified way to learn IC time before stamping an ingress expiry.
pub fn read_state_time(tree: &Tree) -> Result<Option<u64>, IcpError> {
    match tree_lookup(tree, &[b"time"]) {
        Lookup::Found(b) => Ok(Some(uleb(&b)?)),
        Lookup::Absent | Lookup::Unknown => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        s.as_bytes()
            .chunks(2)
            .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn cbor_parses_ints_bytes_text() {
        assert_eq!(cbor_parse(&h("01")).unwrap(), Cbor::Uint(1));
        assert_eq!(cbor_parse(&h("1B0000000100000000")).unwrap(), Cbor::Uint(0x1_0000_0000));
        assert_eq!(cbor_parse(&h("20")).unwrap(), Cbor::NInt(-1));
        assert_eq!(cbor_parse(&h("4568656c6c6f")).unwrap(), Cbor::Bytes(b"hello".to_vec()));
        assert_eq!(cbor_parse(&h("6568656c6c6f")).unwrap(), Cbor::Text("hello".into()));
        // self-describe tag is skipped
        assert_eq!(cbor_parse(&h("d9d9f701")).unwrap(), Cbor::Uint(1));
        // trailing bytes are rejected
        assert!(cbor_parse(&h("0100")).is_err());
        // truncation is rejected
        assert!(cbor_parse(&h("456865")).is_err());
    }

    #[test]
    fn cbor_parses_nested_maps_arrays_indefinite() {
        // map(1){"abc": 59395} — u16-length int values inside maps
        let v = cbor_parse(&h("a16361626319e803")).unwrap();
        assert_eq!(v.get("abc").and_then(Cbor::as_u64), Some(0xe803));
        assert_eq!(v.get("missing"), None);
        // {_{"k": [_ 1, 2]}}, and an indefinite byte string of two definite chunks —
        // the encoding style the dfx replica's read_state responses use.
        let v = cbor_parse(&h("bf616b9f0102ffff")).unwrap();
        assert_eq!(v.get("k"), Some(&Cbor::Array(vec![Cbor::Uint(1), Cbor::Uint(2)])));
        let v = cbor_parse(&h("5f4200aa4200bbff")).unwrap();
        assert_eq!(v.as_bytes(), Some(&[0x00, 0xaa, 0x00, 0xbb][..]));
        // unterminated — must error, not hang or panic
        assert!(cbor_parse(&h("9f01")).is_err());
        // definite re-encode of a decoded value round-trips
        let mut out = Vec::new();
        cbor_encode(&Cbor::Text("hi".into()), &mut out);
        assert_eq!(out, vec![0x62, b'h', b'i']);
    }

    #[test]
    fn cbor_encode_roundtrips_every_shape() {
        let cases = vec![
            Cbor::Uint(0),
            Cbor::Uint(23),
            Cbor::Uint(24),
            Cbor::Uint(300),
            Cbor::Uint(0x1_0000_0000),
            Cbor::NInt(-1),
            Cbor::NInt(-301),
            Cbor::Bytes(vec![1, 2, 3]),
            Cbor::Text("hello".into()),
            Cbor::Array(vec![Cbor::Uint(1), Cbor::Text("x".into())]),
            Cbor::Map(vec![(Cbor::Text("k".into()), Cbor::Bytes(vec![9u8; 40]))]),
        ];
        for v in cases {
            let mut buf = Vec::new();
            cbor_encode(&v, &mut buf);
            assert_eq!(cbor_parse(&buf).unwrap(), v, "roundtrip failed for {v:?}");
        }
    }

    fn enc(v: &Cbor) -> Vec<u8> {
        let mut out = Vec::new();
        cbor_encode(v, &mut out);
        out
    }

    fn t(s: &str) -> Cbor {
        Cbor::Text(s.into())
    }

    fn b(v: &[u8]) -> Cbor {
        Cbor::Bytes(v.to_vec())
    }

    #[test]
    fn decodes_query_replied_and_rejected() {
        // replied: {status: "replied", reply: {arg: bytes"DIDL"}}
        let body = enc(&Cbor::Map(vec![
            (t("status"), t("replied")),
            (t("reply"), Cbor::Map(vec![(t("arg"), b(b"DIDL"))])),
        ]));
        assert_eq!(decode_query_response(&body).unwrap(), QueryOutcome::Replied(b"DIDL".to_vec()));
        // rejected with all fields
        let body = enc(&Cbor::Map(vec![
            (t("status"), t("rejected")),
            (t("reject_code"), Cbor::Uint(5)),
            (t("reject_message"), t("nope")),
            (t("error_code"), t("IC0512")),
        ]));
        assert_eq!(
            decode_query_response(&body).unwrap(),
            QueryOutcome::Rejected { reject_code: 5, reject_message: "nope".into(), error_code: Some("IC0512".into()) }
        );
        // rejected missing reject_code → typed error
        let body = enc(&Cbor::Map(vec![(t("status"), t("rejected"))]));
        assert!(decode_query_response(&body).is_err());
    }

    #[test]
    fn decodes_read_state_certificate_tree() {
        // {certificate: bytes"{tree: leaf(0x68)}"} — the certificate is a bstr wrapping CBOR.
        let cert = enc(&Cbor::Map(vec![(t("tree"), Cbor::Array(vec![Cbor::Uint(3), b(&[0x68])]))]));
        let body = enc(&Cbor::Map(vec![(t("certificate"), Cbor::Bytes(cert))]));
        assert_eq!(decode_read_state_tree(&body).unwrap(), Tree::Leaf(vec![0x68]));
    }

    fn status_tree(rid: [u8; 32], status: &str) -> Tree {
        let reply_leaf = enc(&Cbor::Map(vec![(t("arg"), b(b"DIDL"))]));
        // fork(labeled("status", leaf(status)), labeled("reply", leaf(reply_leaf)))
        // under request_status/<rid>
        Tree::Labeled(
            b"request_status".to_vec(),
            Box::new(Tree::Labeled(
                rid.to_vec(),
                Box::new(Tree::Fork(
                    Box::new(Tree::Labeled(b"status".to_vec(), Box::new(Tree::Leaf(status.as_bytes().to_vec())))),
                    Box::new(Tree::Labeled(b"reply".to_vec(), Box::new(Tree::Leaf(reply_leaf)))),
                )),
            )),
        )
    }

    #[test]
    fn tree_lookup_walks_forks_and_reports_unknown_on_pruned() {
        let rid = [7u8; 32];
        let tree = status_tree(rid, "replied");
        assert_eq!(request_status(&tree, &rid).unwrap(), RequestStatus::Replied(b"DIDL".to_vec()));

        let pruned = Tree::Labeled(b"request_status".to_vec(), Box::new(Tree::Pruned([9u8; 32])));
        // Pruned (Unknown) mid-path = "no terminal answer in THIS certificate" — the poll
        // loop keeps re-submitting read_state (ic-agent semantics), it does not error.
        assert_eq!(request_status(&pruned, &rid).unwrap(), RequestStatus::Unknown);

        // The real dfx-replica cert shape: the request_status branch sits under a fork whose
        // LEFT side is Pruned — a Pruned sibling must not block the descent.
        let pruned_sibling = Tree::Fork(
            Box::new(Tree::Pruned([3u8; 32])),
            Box::new(Tree::Fork(
                Box::new(status_tree(rid, "replied")),
                Box::new(Tree::Pruned([4u8; 32])),
            )),
        );
        assert_eq!(request_status(&pruned_sibling, &rid).unwrap(), RequestStatus::Replied(b"DIDL".to_vec()));

        let other_rid = [8u8; 32];
        assert_eq!(request_status(&tree, &other_rid).unwrap(), RequestStatus::Unknown);
    }

    #[test]
    fn request_status_rejected_carries_code_message_error_code() {
        let rid = [7u8; 32];
        let tree = Tree::Labeled(
            b"request_status".to_vec(),
            Box::new(Tree::Labeled(
                rid.to_vec(),
                Box::new(Tree::Fork(
                    Box::new(Tree::Labeled(b"status".to_vec(), Box::new(Tree::Leaf(b"rejected".to_vec())))),
                    Box::new(Tree::Fork(
                        Box::new(Tree::Labeled(b"reject_code".to_vec(), Box::new(Tree::Leaf(vec![0xac, 0x02])))),
                        Box::new(Tree::Labeled(b"reject_message".to_vec(), Box::new(Tree::Leaf(b"bad".to_vec())))),
                    )),
                )),
            )),
        );
        assert_eq!(
            request_status(&tree, &rid).unwrap(),
            RequestStatus::Rejected { reject_code: 300, reject_message: "bad".into(), error_code: None }
        );
    }

    #[test]
    fn request_status_paths_and_time() {
        let rid: [u8; 32] = [7; 32];
        // time is a TOP-LEVEL tree label (sibling of request_status), uleb-encoded ns.
        let tree = Tree::Fork(
            Box::new(status_tree(rid, "replied")),
            Box::new(Tree::Labeled(b"time".to_vec(), Box::new(Tree::Leaf(vec![0xe7, 0x56, 0xe2])))),
        );
        assert_eq!(request_status(&tree, &rid).unwrap(), RequestStatus::Replied(b"DIDL".to_vec()));
        // uleb [0xe7,0x56,0xe2]: 0xe7 has the continuation bit, 0x56 stops it — the third
        // byte is never read. value = 0x67 + (0x56 << 7) = 11111.
        assert_eq!(read_state_time(&tree).unwrap(), Some(0x67 + (0x56u64 << 7)));
        // a different rid is Unknown
        assert_eq!(request_status(&tree, &[8; 32]).unwrap(), RequestStatus::Unknown);
        // time absent → None
        let bare = Tree::Labeled(b"request_status".to_vec(), Box::new(Tree::Empty));
        assert_eq!(read_state_time(&bare).unwrap(), None);
    }
}
