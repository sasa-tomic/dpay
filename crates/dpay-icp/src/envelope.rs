//! The signed request envelope: content-map `request_id`, `\x0Aic-request` ed25519
//! signature, and the serde_cbor 0.11 emission shape `D9D9F7 {content, sender_pubkey,
//! sender_sig}` that is POSTed to `/api/v2/canister/<PRINCIPAL-TEXTUAL>/call|query|read_state`.

use crate::cbor;
use crate::principal::{Principal, DER_PREFIX};
use crate::request_id::{request_id, signable, RidValue};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use sha2::Digest;

/// A canister call to sign: update (`call`), query, or the shared shape of both.
#[derive(Clone, Debug)]
pub struct CallRequest {
    pub canister: Principal,
    pub method_name: String,
    pub arg: Vec<u8>,
    pub ingress_expiry_ns: u64,
    /// Optional ingress nonce; `None` matches the ic-agent default (field omitted).
    pub nonce: Option<u64>,
}

/// Sender identity derived from the signing key: `principal = SHA224(DER)‖0x02`,
/// `der = 302a300506032b6570032100 ‖ raw32`.
fn sender_identity(sk: &SigningKey) -> (Principal, Vec<u8>) {
    let vk = VerifyingKey::from(sk);
    let mut der = DER_PREFIX.to_vec();
    der.extend_from_slice(&vk.to_bytes());
    let principal = Principal::self_authenticating_der(&der);
    (principal, der)
}

/// Ingress expiry in ns since unix epoch: `now + ahead_s`, untruncated — the raw
/// nanosecond stamp (sub-second part included) goes on the wire; both live ingress
/// stacks (replica validator and mainnet) accept it as-is.
pub fn ingress_expiry(now_ns: u64, ahead_s: u64) -> u64 {
    now_ns + ahead_s * 1_000_000_000
}

fn call_content(request_type: &str, r: &CallRequest, sender: &Principal) -> Vec<(String, RidValue)> {
    // request_id field order is irrelevant (sorted by name hash); listed in spec order.
    // nonce hashes as its wire form: 8 LE bytes (ic-agent models it as Option<Vec<u8>>).
    let mut f: Vec<(String, RidValue)> = vec![
        ("request_type".into(), RidValue::Str(request_type.into())),
        ("ingress_expiry".into(), RidValue::U64(r.ingress_expiry_ns)),
        ("sender".into(), RidValue::Bytes(sender.as_slice().to_vec())),
        ("canister_id".into(), RidValue::Bytes(r.canister.as_slice().to_vec())),
        ("method_name".into(), RidValue::Str(r.method_name.clone())),
        ("arg".into(), RidValue::Bytes(r.arg.clone())),
    ];
    if let Some(n) = r.nonce {
        f.push(("nonce".into(), RidValue::Bytes(n.to_le_bytes().to_vec())));
    }
    f
}

/// Call content map: `request_type, nonce?, ingress_expiry, sender, canister_id,
/// method_name, arg` — serde struct order of the ic-transport-types Call variant.
fn write_call_content(out: &mut Vec<u8>, r: &CallRequest, sender: &Principal) {
    cbor::map(out, if r.nonce.is_some() { 7 } else { 6 });
    cbor::text(out, "request_type");
    cbor::text(out, "call");
    if let Some(n) = r.nonce {
        cbor::text(out, "nonce");
        cbor::bytes(out, &n.to_le_bytes());
    }
    cbor::text(out, "ingress_expiry");
    cbor::uint(out, r.ingress_expiry_ns);
    cbor::text(out, "sender");
    cbor::bytes(out, sender.as_slice());
    cbor::text(out, "canister_id");
    cbor::bytes(out, r.canister.as_slice());
    cbor::text(out, "method_name");
    cbor::text(out, &r.method_name);
    cbor::text(out, "arg");
    cbor::bytes(out, &r.arg);
}

/// Query content map: `request_type, ingress_expiry, sender, canister_id, method_name,
/// arg, nonce?` — the Query variant declares nonce AFTER arg (unlike Call).
fn write_query_content(out: &mut Vec<u8>, r: &CallRequest, sender: &Principal) {
    cbor::map(out, if r.nonce.is_some() { 7 } else { 6 });
    cbor::text(out, "request_type");
    cbor::text(out, "query");
    cbor::text(out, "ingress_expiry");
    cbor::uint(out, r.ingress_expiry_ns);
    cbor::text(out, "sender");
    cbor::bytes(out, sender.as_slice());
    cbor::text(out, "canister_id");
    cbor::bytes(out, r.canister.as_slice());
    cbor::text(out, "method_name");
    cbor::text(out, &r.method_name);
    cbor::text(out, "arg");
    cbor::bytes(out, &r.arg);
    if let Some(n) = r.nonce {
        cbor::text(out, "nonce");
        cbor::bytes(out, &n.to_le_bytes());
    }
}

fn finish_envelope(out: &mut Vec<u8>, content: &[u8], der: &[u8], sig: &[u8]) {
    cbor::self_describe(out);
    cbor::map(out, 3);
    cbor::text(out, "content");
    out.extend_from_slice(content);
    cbor::text(out, "sender_pubkey");
    cbor::bytes(out, der);
    cbor::text(out, "sender_sig");
    cbor::bytes(out, sig);
}

fn sign_call(sk: &SigningKey, r: &CallRequest, request_type: &str) -> Vec<u8> {
    let (sender, der) = sender_identity(sk);
    let fields = call_content(request_type, r, &sender);
    let rid = request_id(
        &fields
            .iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect::<Vec<_>>(),
    );
    let sig = sk.sign(&signable(&rid));
    let mut content = Vec::with_capacity(128 + r.arg.len());
    if request_type == "call" {
        write_call_content(&mut content, r, &sender);
    } else {
        write_query_content(&mut content, r, &sender);
    }
    let mut out = Vec::with_capacity(content.len() + 160);
    finish_envelope(&mut out, &content, &der, &sig.to_bytes());
    out
}

/// Full signed `call` (update) envelope — the POST body for `.../call`.
pub fn sign_update(sk: &SigningKey, r: &CallRequest) -> Vec<u8> {
    sign_call(sk, r, "call")
}

/// Full signed `query` envelope — the POST body for `.../query`. Identical content
/// shape with `request_type = "query"`; the `nonce` field lands AFTER `arg` per the
/// ic-transport-types Query variant declaration order.
pub fn sign_query(sk: &SigningKey, r: &CallRequest) -> Vec<u8> {
    sign_call(sk, r, "query")
}

/// Full signed `read_state` envelope — the POST body for `.../read_state`.
/// `paths` entries are label sequences, e.g. `[b"request_status", &request_id_32]`.
/// (The reference `ReadState` content map carries no canister_id field — the
/// request is scoped by sender + paths alone.)
pub fn sign_read_state(
    sk: &SigningKey,
    paths: &[&[&[u8]]],
    ingress_expiry_ns: u64,
) -> Vec<u8> {
    let (sender, der) = sender_identity(sk);
    let path_values: Vec<RidValue> = paths
        .iter()
        .map(|p| RidValue::Array(p.iter().map(|l| RidValue::Bytes((*l).to_vec())).collect()))
        .collect();
    let rid = request_id(&[
        ("request_type", RidValue::Str("read_state".into())),
        ("ingress_expiry", RidValue::U64(ingress_expiry_ns)),
        ("sender", RidValue::Bytes(sender.as_slice().to_vec())),
        ("paths", RidValue::Array(path_values.clone())),
    ]);
    let sig = sk.sign(&signable(&rid));

    // CBOR: map(4){request_type, ingress_expiry, sender, paths} in declaration order.
    let mut content = Vec::with_capacity(96 + paths.len() * 48);
    cbor::map(&mut content, 4);
    cbor::text(&mut content, "request_type");
    cbor::text(&mut content, "read_state");
    cbor::text(&mut content, "ingress_expiry");
    cbor::uint(&mut content, ingress_expiry_ns);
    cbor::text(&mut content, "sender");
    cbor::bytes(&mut content, sender.as_slice());
    cbor::text(&mut content, "paths");
    cbor::array(&mut content, paths.len());
    for p in paths {
        cbor::array(&mut content, p.len());
        for label in *p {
            cbor::bytes(&mut content, label);
        }
    }

    let mut out = Vec::with_capacity(content.len() + 160);
    finish_envelope(&mut out, &content, &der, &sig.to_bytes());
    out
}

/// Recompute the request_id of a signed envelope (for response-side matching without
/// re-deriving the content). Parses the content map back out of the CBOR — only used by
/// tests and submitter tooling. Added beyond the frozen API.
pub fn envelope_request_id(envelope: &[u8]) -> Result<[u8; 32], crate::IcpError> {
    let content = parse_content_map(envelope)?;
    let fields: Vec<(&str, RidValue)> = content
        .iter()
        .map(|(k, v)| (k.as_str(), v.clone()))
        .collect();
    Ok(request_id(&fields))
}

// --- minimal definite-length CBOR reader (envelope-side only) ------------------------------------

/// A decoded CBOR value — the subset the envelope writer emits.
#[derive(Clone, Debug, PartialEq)]
pub enum CborValue {
    Uint(u64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<CborValue>),
    Map(Vec<(String, CborValue)>),
}

fn read_value(d: &[u8], i: &mut usize) -> Result<CborValue, crate::IcpError> {
    let err = |m: &str| crate::IcpError::CborDecode(m.to_string());
    if *i >= d.len() {
        return Err(err("truncated"));
    }
    let head = d[*i];
    *i += 1;
    let major = head >> 5;
    let info = head & 0x1f;
    let arg = match info {
        0..=23 => u64::from(info),
        24 => {
            let v = u64::from(d.get(*i).copied().ok_or_else(|| err("truncated u8"))?);
            *i += 1;
            v
        }
        25 | 26 | 27 => {
            let n = match info {
                25 => 2,
                26 => 4,
                _ => 8,
            };
            let s = d.get(*i..*i + n).ok_or_else(|| err("truncated int"))?;
            *i += n;
            let mut v = 0u64;
            for &b in s {
                v = (v << 8) | u64::from(b);
            }
            v
        }
        _ => return Err(err("indefinite lengths not emitted by this writer")),
    };
    Ok(match major {
        0 => CborValue::Uint(arg),
        2 | 3 => {
            let n = arg as usize;
            let s = d.get(*i..*i + n).ok_or_else(|| err("truncated bytes"))?;
            *i += n;
            if major == 2 {
                CborValue::Bytes(s.to_vec())
            } else {
                CborValue::Text(String::from_utf8(s.to_vec()).map_err(|_| err("bad utf8"))?)
            }
        }
        4 => {
            let mut items = Vec::new();
            for _ in 0..arg {
                items.push(read_value(d, i)?);
            }
            CborValue::Array(items)
        }
        5 => {
            let mut pairs = Vec::new();
            for _ in 0..arg {
                let k = read_value(d, i)?;
                let CborValue::Text(k) = k else {
                    return Err(err("map key must be text"));
                };
                let v = read_value(d, i)?;
                pairs.push((k, v));
            }
            CborValue::Map(pairs)
        }
        6 => read_value(d, i)?, // tag head + tag number already consumed; body follows
        _ => return Err(err("majors 1/7 not emitted by this writer")),
    })
}

fn read_tagged(d: &[u8], i: &mut usize) -> Result<CborValue, crate::IcpError> {
    if d.get(*i..*i + 3) == Some(&[0xd9, 0xd9, 0xf7][..]) {
        *i += 3;
    }
    read_value(d, i)
}

fn parse_content_map(envelope: &[u8]) -> Result<Vec<(String, RidValue)>, crate::IcpError> {
    let mut i = 0;
    let root = read_tagged(envelope, &mut i)?;
    let CborValue::Map(pairs) = root else {
        return Err(crate::IcpError::CborDecode("envelope root must be a map".into()));
    };
    let content = pairs
        .iter()
        .find(|(k, _)| k == "content")
        .map(|(_, v)| v)
        .ok_or_else(|| crate::IcpError::CborDecode("envelope missing content".into()))?;
    let CborValue::Map(fields) = content else {
        return Err(crate::IcpError::CborDecode("content must be a map".into()));
    };
    Ok(fields
        .iter()
        .filter_map(|(k, v)| Some((k.clone(), cbor_to_rid(v)?)))
        .collect())
}

/// Recursive CborValue → RidValue conversion. Critical for read_state envelopes whose
/// `paths` value is a NESTED array (Array of Arrays of Bytes): a shallow conversion
/// silently drops nested arrays, producing a different request_id than the signer used.
fn cbor_to_rid(v: &CborValue) -> Option<RidValue> {
    match v {
        CborValue::Text(s) => Some(RidValue::Str(s.clone())),
        CborValue::Bytes(b) => Some(RidValue::Bytes(b.clone())),
        CborValue::Uint(n) => Some(RidValue::U64(*n)),
        CborValue::Array(items) => Some(RidValue::Array(
            items.iter().map(cbor_to_rid).collect::<Option<Vec<_>>>()?,
        )),
        CborValue::Map(_) => None,
    }
}

// --- envelope verification (gateway-side) --------------------------------------------------------

/// A fully verified /call or /query envelope: the signature checked out under the embedded
/// sender pubkey, and the content map is exposed for the receiver to dispatch on.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedEnvelope {
    pub request_id: [u8; 32],
    /// The self-authenticating principal derived from `sender_pubkey`.
    pub sender: crate::principal::Principal,
    /// `None` for read_state (its content map carries no canister_id — see `sign_read_state`).
    pub canister: Option<crate::principal::Principal>,
    /// `None` for read_state.
    pub method_name: Option<String>,
    /// `None` for read_state.
    pub arg: Option<Vec<u8>>,
    pub ingress_expiry_ns: u64,
}

/// The fixed DER prefix the ic-transport-types serializer emits for an Ed25519 public key
/// (SubjectPublicKeyInfo): `302a300506032b6570032100` + the raw 32 bytes.
const ED25519_DER_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/// Verify a submitted envelope exactly as the IC boundary node does: recompute the
/// `request_id` from the content map, then check the Ed25519 signature over
/// `IC_REQUEST_DOMAIN_SEPARATOR ‖ request_id` under the embedded `sender_pubkey` (DER-wrapped).
/// Returns the parsed content on success. Used by offline test gateways; the real IC does
/// this at the boundary node.
pub fn verify_envelope(envelope: &[u8]) -> Result<VerifiedEnvelope, crate::IcpError> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let err = |m: &str| crate::IcpError::CborDecode(m.to_string());
    let mut i = 0;
    let root = read_tagged(envelope, &mut i)?;
    let CborValue::Map(pairs) = root else {
        return Err(err("envelope root must be a map"));
    };
    let field = |name: &str| -> Option<&CborValue> {
        pairs.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    };
    let content = field("content").ok_or_else(|| err("envelope missing content"))?;
    let sender_pub = field("sender_pubkey")
        .ok_or_else(|| err("envelope missing sender_pubkey"))?;
    let sender_sig = field("sender_sig").ok_or_else(|| err("envelope missing sender_sig"))?;
    let (CborValue::Bytes(sig), CborValue::Bytes(der)) = (sender_sig, sender_pub) else {
        return Err(err("sender_pubkey/sender_sig must be byte strings"));
    };
    if der.len() != 44 || der[..12] != ED25519_DER_PREFIX {
        return Err(err("sender_pubkey must be a DER-wrapped Ed25519 key"));
    }
    let raw_pk: [u8; 32] = der[12..].try_into().expect("checked length");
    let vk = VerifyingKey::from_bytes(&raw_pk)
        .map_err(|_| err("invalid sender_pubkey"))?;

    // request_id from the content map (same path envelope_request_id uses).
    let rid = envelope_request_id(envelope)?;

    let mut msg = Vec::with_capacity(11 + 32);
    msg.extend_from_slice(crate::request_id::IC_REQUEST_DOMAIN_SEPARATOR);
    msg.extend_from_slice(&rid);
    vk.verify(&msg, &Signature::from_slice(sig).map_err(|_| err("bad sender_sig length"))?)
        .map_err(|_| err("signature verification failed"))?;

    // Dispatch fields out of the (now trusted) content map.
    let CborValue::Map(fields) = content else {
        return Err(err("content must be a map"));
    };
    let cfield = |name: &str| -> Option<&CborValue> {
        fields.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    };
    let expiry = match cfield("ingress_expiry") {
        Some(CborValue::Uint(n)) => *n,
        _ => return Err(err("content missing ingress_expiry")),
    };
    let sender = match cfield("sender") {
        Some(CborValue::Bytes(b)) => {
            let p = crate::principal::Principal::from_bytes(b)?;
            // The sender MUST be the self-authenticating principal of the signing key.
            if p != crate::principal::Principal::self_authenticating_ed25519(&raw_pk) {
                return Err(err("sender does not match sender_pubkey"));
            }
            p
        }
        _ => return Err(err("content missing sender")),
    };
    // canister_id/method_name/arg are present on call+query but NOT read_state — optional.
    let canister = match cfield("canister_id") {
        Some(CborValue::Bytes(b)) => Some(crate::principal::Principal::from_bytes(b)?),
        Some(_) => return Err(err("content canister_id must be bytes")),
        None => None,
    };
    let method_name = match cfield("method_name") {
        Some(CborValue::Text(t)) => Some(t.clone()),
        Some(_) => return Err(err("content method_name must be text")),
        None => None,
    };
    let arg = match cfield("arg") {
        Some(CborValue::Bytes(b)) => Some(b.clone()),
        Some(_) => return Err(err("content arg must be bytes")),
        None => None,
    };
    Ok(VerifiedEnvelope {
        request_id: rid,
        sender,
        canister,
        method_name,
        arg,
        ingress_expiry_ns: expiry,
    })
}

/// SHA-256 of anything (re-exported convenience for submitters hashing replies).
pub fn sha256(d: &[u8]) -> [u8; 32] {
    sha2::Sha256::digest(d).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sk() -> SigningKey {
        // RFC 8032 test vector 1
        SigningKey::from_bytes(&[
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
            0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
        ])
    }

    #[test]
    fn ingress_expiry_adds_seconds() {
        assert_eq!(ingress_expiry(1_000_000_000_123, 300), 1_300_000_000_123);
    }

    #[test]
    fn envelope_request_id_round_trips_update() {
        let r = CallRequest {
            canister: Principal::from_bytes(&[0, 0, 0, 0, 0, 0, 0x04, 0xd2]).unwrap(),
            method_name: "hello".into(),
            arg: b"DIDL\x00\xFD*".to_vec(),
            ingress_expiry_ns: 1_685_570_400_000_000_000,
            nonce: Some(7),
        };
        let env = sign_update(&sk(), &r);
        let rid = envelope_request_id(&env).unwrap();
        let expected = request_id(&[
            ("request_type", RidValue::Str("call".into())),
            ("nonce", RidValue::Bytes(7u64.to_le_bytes().to_vec())),
            ("ingress_expiry", RidValue::U64(1_685_570_400_000_000_000)),
            ("sender", RidValue::Bytes(Principal::self_authenticating_ed25519(&sk_pk()).as_slice().to_vec())),
            ("canister_id", RidValue::Bytes(vec![0, 0, 0, 0, 0, 0, 0x04, 0xd2])),
            ("method_name", RidValue::Str("hello".into())),
            ("arg", RidValue::Bytes(b"DIDL\x00\xFD*".to_vec())),
        ]);
        assert_eq!(rid, expected);
    }

    fn sk_pk() -> [u8; 32] {
        // d75a980182b10ab7… (RFC 8032 vector 1 public key)
        let mut pk = [0u8; 32];
        let hex = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
        for (j, pair) in hex.as_bytes().chunks(2).enumerate() {
            pk[j] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
        }
        pk
    }
}
