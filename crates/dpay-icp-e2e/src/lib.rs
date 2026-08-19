//! Env-gated e2e proofs for the user-principal rail (`dpay_icp`).
//!
//! Two INDEPENDENT proofs that the hand-rolled envelopes are accepted by real IC ingress code,
//! beyond the PocketIC gateway covered by `dpay-icp-tests`:
//!
//! * (A) **offline dfx replica** (`tests/replica.rs`) — `dfx start` fronts `/api/v2` on 4943 with
//!   the dfx webserver → PocketIC backend, a second ingress implementation. Driven by
//!   `scripts/icp-replica-e2e.sh` (`DPAY_IC_REPLICA_URL` + `DPAY_IC_LEDGER_ID`); without the env
//!   the tests print `skipped` and pass.
//! * (B) **opt-in mainnet** (`tests/mainnet.rs`) — signed read-only queries (no cycles, no state
//!   change) from a throwaway fixed-seed key against `https://icp-api.io` (`DPAY_IC_MAINNET=1`),
//!   driven by `scripts/icp-mainnet-probe.sh`. NEVER part of `check`/`verify`.
//!
//! This lib holds the harness halves that do not depend on `dpay_icp`: a reqwest transport and a
//! minimal definite-length CBOR + IC certificate/hashtree decoder. The env-gated tests in
//! `tests/` early-return "skipped" (and pass) unless their env gate is set, so
//! `cargo nextest run -p dpay-icp-e2e` is green with no replica and no network.

use std::error::Error;
use std::time::Duration;

/// Boxed-error alias: harness code fails for one-shot textual reasons, not typed conditions.
pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// `Content-Type` for every `/api/v2` body (envelopes in, CBOR responses out).
pub const CBOR_CONTENT_TYPE: &str = "application/cbor";

// --- fixed throwaway device keys ---------------------------------------------------------------
// Deterministic RFC 8032 test seeds — never real funds. The replica suite funds P1's principal
// (`scripts/icp-replica-e2e.sh` transfers from the ledger's minting account, i.e. the dfx
// identity); the mainnet probe key is read-only (queries only, no cycles, no state change).

/// Funded sender P1 on the local dfx replica.
pub const P1_SEED: [u8; 32] = [0x01; 32];
/// Throwaway read-only key for the opt-in mainnet probe.
pub const PROBE_SEED: [u8; 32] = [0x0e; 32];

/// Deterministic signing key from a fixed seed (no RNG — env-gated tests must be reproducible).
pub fn dev_key(seed: &[u8; 32]) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(seed)
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
pub fn cbor_parse(data: &[u8]) -> Result<Cbor> {
    let (value, rest) = cbor_read(data)?;
    if !rest.is_empty() {
        return Err(format!("{} trailing bytes after CBOR value", rest.len()).into());
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

fn cbor_read(data: &[u8]) -> Result<(Cbor, &[u8])> {
    let (&head, rest) = data.split_first().ok_or("empty CBOR input")?;
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
                    let Some(&next) = rest.first() else { return Err("unterminated indefinite-length string".into()) };
                    if next == 0xff {
                        rest = &rest[1..];
                        break;
                    }
                    let (chunk, r) = cbor_read(rest)?;
                    match (major, chunk) {
                        (2, Cbor::Bytes(b)) => buf.extend_from_slice(&b),
                        (3, Cbor::Text(t)) => buf.extend_from_slice(t.as_bytes()),
                        _ => return Err("indefinite-length string chunk is not a string".into()),
                    }
                    rest = r;
                }
                if major == 2 {
                    (Cbor::Bytes(buf), rest)
                } else {
                    let text = String::from_utf8(buf).map_err(|e| format!("invalid CBOR text: {e}"))?;
                    (Cbor::Text(text), rest)
                }
            }
            4 => {
                let mut items = Vec::new();
                loop {
                    let Some(&next) = rest.first() else { return Err("unterminated indefinite-length array".into()) };
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
                    let Some(&next) = rest.first() else { return Err("unterminated indefinite-length map".into()) };
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
            _ => return Err(format!("indefinite length on unsupported major type {major}").into()),
        });
    }
    let (arg, rest) = read_arg(info, rest)?;
    Ok(match major {
        0 => (Cbor::Uint(arg), rest),
        1 => {
            let n = i64::try_from(arg).map_err(|_| "CBOR negative int out of i64 range")?;
            (Cbor::NInt(-1 - n), rest)
        }
        2 => {
            let (payload, tail) = take(arg, rest)?;
            (Cbor::Bytes(payload.to_vec()), tail)
        }
        3 => {
            let (payload, tail) = take(arg, rest)?;
            let text = String::from_utf8(payload.to_vec()).map_err(|e| format!("invalid CBOR text: {e}"))?;
            (Cbor::Text(text), tail)
        }
        4 => {
            let (items, tail) = read_seq(rest, arg, "array")?;
            (Cbor::Array(items), tail)
        }
        5 => {
            let n = usize::try_from(arg).map_err(|_| "CBOR map length exceeds usize")?;
            let mut pairs = Vec::with_capacity(n.min(1024));
            let mut rest = rest;
            for i in 0..n {
                let (k, r) = cbor_read(rest).map_err(|e| format!("map key {i}: {e}"))?;
                let (v, r) = cbor_read(r).map_err(|e| format!("map value {i}: {e}"))?;
                pairs.push((k, v));
                rest = r;
            }
            (Cbor::Map(pairs), rest)
        }
        6 => cbor_read(rest)?, // tag header — skip, keep the tagged value
        _ => return Err("floats/simple values are not emitted by the IC API".into()),
    })
}

fn read_arg(info: u8, data: &[u8]) -> Result<(u64, &[u8])> {
    Ok(match info {
        0..=23 => (u64::from(info), data),
        24 => {
            let (b, r) = data.split_first().ok_or("truncated CBOR u8 length")?;
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
        _ => return Err("reserved CBOR info bits 28-30".into()),
    })
}

/// Split `len` payload bytes off the front, bounds-checked.
fn take(len: u64, data: &[u8]) -> Result<(&[u8], &[u8])> {
    let len = usize::try_from(len).map_err(|_| "CBOR length exceeds usize")?;
    if data.len() < len {
        return Err(format!("truncated CBOR payload: want {len} bytes, have {}", data.len()).into());
    }
    Ok((&data[..len], &data[len..]))
}

fn read_seq<'a>(data: &'a [u8], n: u64, what: &str) -> Result<(Vec<Cbor>, &'a [u8])> {
    let n = usize::try_from(n).map_err(|_| format!("{what} length exceeds usize"))?;
    let mut items = Vec::with_capacity(n.min(1024));
    let mut rest = data;
    for i in 0..n {
        let (v, r) = cbor_read(rest).map_err(|e| format!("{what} item {i}: {e}"))?;
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
pub fn decode_query_response(body: &[u8]) -> Result<QueryOutcome> {
    let v = cbor_parse(body).map_err(|e| format!("query body: {e} (hex head: {})", hex_head(body)))?;
    let status = v.get("status").and_then(Cbor::as_text).ok_or("query response missing status")?;
    match status {
        "replied" => {
            let arg = v
                .get("reply")
                .and_then(|r| r.get("arg"))
                .and_then(Cbor::as_bytes)
                .ok_or("replied query response missing reply.arg")?
                .to_vec();
            Ok(QueryOutcome::Replied(arg))
        }
        "rejected" => Ok(QueryOutcome::Rejected {
            reject_code: v.get("reject_code").and_then(Cbor::as_u64).ok_or("rejected query response missing reject_code")?,
            reject_message: v
                .get("reject_message")
                .and_then(Cbor::as_text)
                .ok_or("rejected query response missing reject_message")?
                .to_string(),
            error_code: v.get("error_code").and_then(Cbor::as_text).map(str::to_string),
        }),
        other => Err(format!("unexpected query status {other:?}").into()),
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
pub fn decode_read_state_tree(body: &[u8]) -> Result<Tree> {
    let v = cbor_parse(body).map_err(|e| format!("read_state body: {e} (hex head: {})", hex_head(body)))?;
    let cert = v
        .get("certificate")
        .and_then(Cbor::as_bytes)
        .ok_or("read_state response missing certificate")?;
    let cert = cbor_parse(cert).map_err(|e| format!("certificate: {e} (hex head: {})", hex_head(cert)))?;
    tree_from_cbor(cert.get("tree").ok_or("certificate missing tree")?)
}

/// First 32 bytes of `data` as hex, for parse-failure diagnostics.
fn hex_head(data: &[u8]) -> String {
    data.iter().take(32).map(|b| format!("{b:02x}")).collect::<Vec<_>>().join("")
}

fn tree_from_cbor(v: &Cbor) -> Result<Tree> {
    let Cbor::Array(items) = v else {
        return Err("hashtree node must be a CBOR array".into());
    };
    let tag = items.first().and_then(Cbor::as_u64).ok_or("hashtree node missing tag")?;
    Ok(match (tag, items.len()) {
        (0, 1) => Tree::Empty,
        (1, 3) => Tree::Fork(Box::new(tree_from_cbor(&items[1])?), Box::new(tree_from_cbor(&items[2])?)),
        (2, 3) => {
            let label = items[1].as_bytes().ok_or("hashtree fork label must be bytes")?.to_vec();
            Tree::Labeled(label, Box::new(tree_from_cbor(&items[2])?))
        }
        (3, 2) => Tree::Leaf(items[1].as_bytes().ok_or("hashtree leaf must be bytes")?.to_vec()),
        (4, 2) => {
            let digest: [u8; 32] = items[1]
                .as_bytes()
                .and_then(|b| b.try_into().ok())
                .ok_or("hashtree pruned digest must be 32 bytes")?;
            Tree::Pruned(digest)
        }
        _ => return Err(format!("malformed hashtree node: tag {tag}, {len} items", len = items.len()).into()),
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

/// unsigned LEB128 (how `nat` leaf values — e.g. `reject_code` — are encoded in certificates).
fn uleb(b: &[u8]) -> Result<u64> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    for &byte in b {
        if shift >= 64 {
            return Err("reject_code uleb overflow".into());
        }
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
    }
    Err("truncated uleb".into())
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
pub fn request_status(tree: &Tree, request_id: &[u8; 32]) -> Result<RequestStatus> {
    let rid: &[u8] = request_id;
    let status = match tree_lookup(tree, &[b"request_status", rid, b"status"]) {
        // Absent OR Pruned (Unknown) both mean "no terminal answer in THIS certificate" —
        // ic-agent keeps polling in both cases; the poll loop re-submits read_state.
        Lookup::Absent | Lookup::Unknown => return Ok(RequestStatus::Unknown),
        Lookup::Found(b) => String::from_utf8(b)?,
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
            _ => Err("status=replied but reply path missing".into()),
        },
        "rejected" => {
            let reject_code = match tree_lookup(tree, &[b"request_status", rid, b"reject_code"]) {
                Lookup::Found(b) => uleb(&b)?,
                _ => return Err("status=rejected but reject_code path missing".into()),
            };
            let reject_message = match tree_lookup(tree, &[b"request_status", rid, b"reject_message"]) {
                Lookup::Found(b) => String::from_utf8(b)?,
                _ => return Err("status=rejected but reject_message path missing".into()),
            };
            let error_code = match tree_lookup(tree, &[b"request_status", rid, b"error_code"]) {
                Lookup::Found(b) => Some(String::from_utf8(b)?),
                // Absent = field omitted; Pruned (Unknown) = inconclusive — same "no answer yet"
                // semantics as the status lookup: keep polling rather than guess.
                Lookup::Absent | Lookup::Unknown => None,
            };
            Ok(RequestStatus::Rejected { reject_code, reject_message, error_code })
        }
        other => Err(format!("unknown request status {other:?}").into()),
    }
}


// --- transport -----------------------------------------------------------------------------------

/// Flip one byte of the envelope's top-level `sender_sig` byte string (bad-signature negative
/// control): every other field stays identical, so the ingress's failure can only be the
/// signature check. Per the public spec (and ic-transport-types `Envelope`), `sender_sig` is a
/// plain byte-string field beside `content`/`sender_pubkey` — NOT a nested record.
pub fn corrupt_sender_sig(envelope: &[u8]) -> Result<Vec<u8>> {
    let mut v = cbor_parse(envelope)?;
    let sig = v
        .get_mut("sender_sig")
        .and_then(|s| match s {
            Cbor::Bytes(b) => Some(b),
            _ => None,
        })
        .ok_or("envelope missing top-level sender_sig bytes")?;
    let Some(first) = sig.first_mut() else { return Err("sender_sig is empty".into()) };
    *first ^= 0xff;
    let mut out = Vec::with_capacity(envelope.len());
    cbor_encode(&v, &mut out);
    Ok(out)
}

/// A raw `/api/v2` HTTP response (status + body), so tests can assert on both.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// Best-effort body preview for failure messages (error bodies are text; reply bodies CBOR).
    /// Char-boundary-safe: never panics on multi-byte UTF-8 from the lossy conversion.
    pub fn body_preview(&self, max: usize) -> String {
        let text = String::from_utf8_lossy(&self.body);
        let text = text.trim();
        if text.len() <= max {
            return text.to_string();
        }
        let cut = text.char_indices().map(|(i, _)| i).find(|i| i > &max).unwrap_or(max);
        format!("{}…", &text[..cut.saturating_sub(1)])
    }
}

/// Minimal blocking `/api/v2` client. `base` is host root without trailing slash, e.g.
/// `http://127.0.0.1:4943` or `https://icp-api.io` (rustls — no native TLS).
#[derive(Debug, Clone)]
pub struct IcHttp {
    base: String,
    http: reqwest::blocking::Client,
}

impl IcHttp {
    pub fn new(base: impl Into<String>) -> Result<Self> {
        let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build()?;
        Ok(Self { base: base.into().trim_end_matches('/').to_string(), http })
    }

    /// POST a signed envelope to `/api/v2/canister/<canister>/<kind>` where kind is
    /// `query` | `call` | `read_state`. Returns the raw status + body.
    pub fn submit(&self, canister_text: &str, kind: &str, envelope: &[u8]) -> Result<HttpResponse> {
        let url = format!("{base}/api/v2/canister/{canister_text}/{kind}", base = self.base);
        let response = self
            .http
            .post(&url)
            .header("Content-Type", CBOR_CONTENT_TYPE)
            .body(envelope.to_vec())
            .send()?;
        let status = response.status().as_u16();
        let body = response.bytes()?.to_vec();
        Ok(HttpResponse { status, body })
    }
}

// --- decoder unit tests (always run; no env, no network) ------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        s.as_bytes()
            .chunks(2)
            .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
            .collect()
    }

    fn status_tree(rid: [u8; 32], status: &str) -> Tree {
        // The reply leaf is a CBOR-encoded {arg: bstr} record (per the IC spec) — build one.
        let mut reply_leaf = vec![0xa1, 0x63]; // map(1), text(3)
        reply_leaf.extend_from_slice(b"arg");
        reply_leaf.push(0x44); // bytes(4)
        reply_leaf.extend_from_slice(b"DIDL");
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
    fn cbor_parses_nested_maps() {
        let v = cbor_parse(&h("a16361626319e803")).unwrap();
        assert_eq!(v.get("abc").and_then(Cbor::as_u64), Some(0xe803));
        assert_eq!(v.get("missing"), None);
    }

    #[test]
    fn cbor_parses_indefinite_lengths() {
        // {_{"k": [_ 1, 2]}}, and an indefinite byte string of two definite chunks —
        // the encoding style the dfx replica's read_state responses use.
        let v = cbor_parse(&h("bf616b9f0102ffff")).unwrap();
        assert_eq!(v.get("k"), Some(&Cbor::Array(vec![Cbor::Uint(1), Cbor::Uint(2)])));
        let v = cbor_parse(&h("5f4200aa4200bbff")).unwrap();
        assert_eq!(v.as_bytes(), Some(&[0x00, 0xaa, 0x00, 0xbb][..]));
        // unterminated — must error, not hang or panic
        assert!(cbor_parse(&h("9f01")).is_err());
    }

    #[test]
    fn decodes_replied_query_response() {
        // {status: "replied", reply: {arg: h'68656c6c6f'}}
        let body = h("a266737461747573677265706c696564657265706c79a1636172674568656c6c6f");
        assert_eq!(decode_query_response(&body).unwrap(), QueryOutcome::Replied(b"hello".to_vec()));
    }

    #[test]
    fn decodes_rejected_query_response() {
        // {status: "rejected", reject_code: 3, reject_message: "nope", error_code: "CanisterReject"}
        let body = h(concat!(
            "a4", "667374617475736872656a6563746564",
            "6b72656a6563745f636f646503",
            "6e72656a6563745f6d657373616765646e6f7065",
            "6a6572726f725f636f64656e43616e697374657252656a656374",
        ));
        assert_eq!(
            decode_query_response(&body).unwrap(),
            QueryOutcome::Rejected {
                reject_code: 3,
                reject_message: "nope".into(),
                error_code: Some("CanisterReject".into()),
            }
        );
    }

    #[test]
    fn tree_lookup_walks_forks_and_reports_unknown_on_pruned() {
        let rid = [7u8; 32];
        let tree = status_tree(rid, "replied");
        assert_eq!(
            request_status(&tree, &rid).unwrap(),
            RequestStatus::Replied(b"DIDL".to_vec())
        );

        let pruned = Tree::Labeled(
            b"request_status".to_vec(),
            Box::new(Tree::Pruned([9u8; 32])),
        );
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
        assert_eq!(
            request_status(&pruned_sibling, &rid).unwrap(),
            RequestStatus::Replied(b"DIDL".to_vec())
        );

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
                    Box::new(Tree::Labeled(
                        b"status".to_vec(),
                        Box::new(Tree::Leaf(b"rejected".to_vec())),
                    )),
                    Box::new(Tree::Fork(
                        Box::new(Tree::Labeled(b"reject_code".to_vec(), Box::new(Tree::Leaf(vec![0xac, 0x02])))),
                        Box::new(Tree::Labeled(
                            b"reject_message".to_vec(),
                            Box::new(Tree::Leaf(b"bad".to_vec())),
                        )),
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

    #[test]
    fn corrupt_sender_sig_flips_only_the_signature() {
        // {content: 1, sender_sig: h'00aa55', sender_pubkey: h'42'} — spec envelope shape:
        // sender_sig is a TOP-LEVEL byte string.
        let env = Cbor::Map(vec![
            (Cbor::Text("content".into()), Cbor::Uint(1)),
            (Cbor::Text("sender_pubkey".into()), Cbor::Bytes(vec![0x42])),
            (Cbor::Text("sender_sig".into()), Cbor::Bytes(vec![0x00, 0xaa, 0x55])),
        ]);
        let mut buf = Vec::new();
        cbor_encode(&env, &mut buf);
        let corrupted = corrupt_sender_sig(&buf).unwrap();
        let back = cbor_parse(&corrupted).unwrap();
        assert_eq!(back.get("content").and_then(Cbor::as_u64), Some(1));
        assert_eq!(back.get("sender_pubkey").and_then(Cbor::as_bytes), Some(&[0x42][..]));
        assert_eq!(back.get("sender_sig").and_then(Cbor::as_bytes), Some(&[0xff, 0xaa, 0x55][..]));
    }

    #[test]
    fn decodes_read_state_certificate_tree() {
        // {certificate: <bytes of {tree: [3, h'68']}>} — map(1){text(11)"certificate": bytes(len)}
        let cert = h("a1647472656582034168"); // {tree: [3, h'68']} — leaf with payload 0x68
        let mut body = vec![0xa1, 0x6b]; // map(1), text(11)
        body.extend_from_slice(b"certificate");
        body.push((cert.len() as u8) | 0x40); // bytes(len) — cert is short (<24)
        body.extend_from_slice(&cert);
        assert_eq!(decode_read_state_tree(&body).unwrap(), Tree::Leaf(vec![0x68]));
    }

}
