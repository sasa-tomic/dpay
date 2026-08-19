//! `request_id` — the IC representation-independent hash of a request's content map
//! (`SHA256( sorted-by-name-hash concat of H(name)‖H(value) )`), plus the
//! `\x0Aic-request` domain-separated signable form.

use sha2::{Digest, Sha256};

/// The ed25519 signing domain separator: `b"\x0Aic-request"` (11 bytes).
pub const IC_REQUEST_DOMAIN_SEPARATOR: &[u8; 11] = b"\x0Aic-request";

/// A leaf value in the content map. Mirrors exactly what the ic-transport-types serde
/// serializer can produce: strings hash raw utf-8, bytes hash raw, u64 hashes unsigned
/// LEB128, arrays hash the concatenation of their elements' hashes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RidValue {
    Str(String),
    Bytes(Vec<u8>),
    U64(u64),
    Array(Vec<RidValue>),
}

fn uleb(mut n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        out.push((n & 0x7f) as u8);
        n >>= 7;
        if n == 0 {
            return out;
        }
        if let Some(last) = out.last_mut() {
            *last |= 0x80;
        }
    }
}

fn hash_leaf(v: &RidValue) -> [u8; 32] {
    match v {
        RidValue::Str(s) => Sha256::digest(s.as_bytes()).into(),
        RidValue::Bytes(b) => Sha256::digest(b).into(),
        RidValue::U64(n) => Sha256::digest(&uleb(*n)).into(),
        RidValue::Array(items) => {
            let mut h = Sha256::new();
            for item in items {
                h.update(hash_leaf(item));
            }
            h.finalize().into()
        }
    }
}

/// Hash the request's content map. Field order is irrelevant (pairs are sorted by name
/// hash); duplicate names are a caller bug and hash deterministically but meaninglessly.
pub fn request_id(fields: &[(&str, RidValue)]) -> [u8; 32] {
    let mut pairs: Vec<([u8; 32], [u8; 32])> = fields
        .iter()
        .map(|(name, value)| {
            let k: [u8; 32] = Sha256::digest(name.as_bytes()).into();
            let v = hash_leaf(value);
            // sort by key hash (whole 64-byte pair; keys are unique in practice)
            (k, v)
        })
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let mut h = Sha256::new();
    for (k, v) in &pairs {
        h.update(k);
        h.update(v);
    }
    h.finalize().into()
}

/// `DOMAIN_SEPARATOR ‖ request_id` — the bytes the sender's ed25519 key signs.
pub fn signable(request_id: &[u8; 32]) -> Vec<u8> {
    let mut v = Vec::with_capacity(11 + 32);
    v.extend_from_slice(IC_REQUEST_DOMAIN_SEPARATOR);
    v.extend_from_slice(request_id);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Principal;

    fn rid_hex(fields: &[(&str, RidValue)]) -> String {
        hex(&request_id(fields))
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn b(v: &[u8]) -> RidValue {
        RidValue::Bytes(v.to_vec())
    }
    fn s(v: &str) -> RidValue {
        RidValue::Str(v.to_string())
    }

    // The 14 vectors from ic-transport-types 0.48.1 request_id.rs tests (brief A §7.1).

    #[test]
    fn vec_spec_call_current() {
        let rid = rid_hex(&[
            ("request_type", s("call")),
            ("sender", b(&[0x04])),
            ("ingress_expiry", RidValue::U64(1_685_570_400_000_000_000)),
            ("canister_id", b(&[0, 0, 0, 0, 0, 0, 0x04, 0xD2])),
            ("method_name", s("hello")),
            ("arg", b(b"DIDL\x00\xFD*")),
        ]);
        assert_eq!(rid, "1d1091364d6bb8a6c16b203ee75467d59ead468f523eb058880ae8ec80e2b101");
    }

    #[test]
    fn vec_spec_call_fields_omitted() {
        let rid = rid_hex(&[
            ("request_type", s("call")),
            ("canister_id", b(&[0, 0, 0, 0, 0, 0, 0x04, 0xD2])),
            ("method_name", s("hello")),
            ("arg", b(b"DIDL\x00\xFD*")),
        ]);
        assert_eq!(rid, "8781291c347db32a9d8c10eb62b710fce5a93be676474c42babc74c51858f94b");
    }

    #[test]
    fn vec_query_variant() {
        let rid = rid_hex(&[
            ("request_type", s("query")),
            ("sender", b(&[0x04])),
            ("ingress_expiry", RidValue::U64(1_685_570_400_000_000_000)),
            ("canister_id", b(&[0, 0, 0, 0, 0, 0, 0x04, 0xD2])),
            ("method_name", s("hello")),
            ("arg", b(b"DIDL\x00\xFD*")),
        ]);
        assert_eq!(rid, "74aff80b32e98aafb7f1b6cbedc29d2f7de9227d60a55169342600099f0e4147");
    }

    #[test]
    fn vec_read_state_request_status() {
        let inner = request_id(&[
            ("request_type", s("call")),
            ("sender", b(&[0x04])),
            ("ingress_expiry", RidValue::U64(1_685_570_400_000_000_000)),
            ("canister_id", b(&[0, 0, 0, 0, 0, 0, 0x04, 0xD2])),
            ("method_name", s("hello")),
            ("arg", b(b"DIDL\x00\xFD*")),
        ]);
        let rid = rid_hex(&[
            ("request_type", s("read_state")),
            ("sender", b(&[0x04])),
            ("ingress_expiry", RidValue::U64(1_685_570_400_000_000_000)),
            ("paths", RidValue::Array(vec![RidValue::Array(vec![
                s("request_status"),
                b(&inner),
            ])])),
        ]);
        assert_eq!(rid, "3cde0f14a953c3afbe1335f22e861bb62389f1449beca02707ab197e6829c2a3");
    }

    #[test]
    fn vec_nested_arrays() {
        let rid = rid_hex(&[
            ("sender", b(&[0, 0, 0, 0, 0, 0, 0x04, 0xD2])),
            ("paths", RidValue::Array(vec![
                RidValue::Array(vec![]),
                RidValue::Array(vec![b(b"")]),
                RidValue::Array(vec![b(b"hello"), b(b"world")]),
            ])),
        ]);
        assert_eq!(rid, "97d6f297aea699aec85d3377c7643ea66db810aba5c4372fbc2082c999f452dc");
    }

    #[test]
    fn vec_empty_paths() {
        assert_eq!(
            rid_hex(&[("paths", RidValue::Array(vec![]))]),
            "99daa8c80a61e87ac1fdf9dd49e39963bfe4dafb2a45095ebf4cad72d916d5be"
        );
    }

    #[test]
    fn vec_paths_with_empty_array() {
        assert_eq!(
            rid_hex(&[("paths", RidValue::Array(vec![RidValue::Array(vec![])]))]),
            "ea01a9c3d3830db108e0a87995ea0d4183dc9c6e51324e9818fced5c57aa64f5"
        );
    }

    #[test]
    fn vec_nested_map() {
        // {foo: {baz: "hello", quux: 3}, bar: b"world"} — nested maps aren't in the public
        // API's RidValue; approximated as pre-hashed? No — the vector needs a nested map.
        // The ic-transport-types serializer hashes nested structs as maps. Our API only
        // exposes flat content maps + arrays, so this vector is reproduced by hand-composing
        // the inner map hash via the public fn: not expressible → assert the outer pair only
        // via direct hash_leaf usage (unit-level proof of the map rule).
        let inner = request_id(&[("baz", s("hello")), ("quux", RidValue::U64(3))]);
        let mut h = Sha256::new();
        h.update(Sha256::digest(b"foo"));
        h.update(inner);
        h.update(Sha256::digest(b"bar"));
        h.update(Sha256::digest(b"world"));
        assert_eq!(hex(&h.finalize()), "3d447339cc0c2b894ee215c8141770bf4b86c72b6c37d9873213a786ec7f9f31");
    }

    #[test]
    fn vec_foo_73_inexpressible_u64_is_unsigned() {
        // The ic-transport-types vector {foo: 73i32} → 7b3d3270… hashes ints via
        // serialize_i64 = SIGNED leb128 (request_id.rs:142-145: sleb(73) = c9 00).
        // The frozen RidValue API has no signed-int variant — envelope fields only
        // ever carry u64 (serialize_u64, UNSIGNED leb, request_id.rs:159) — so that
        // one vector is inexpressible here. U64 semantics are proven directly:
        assert_eq!(uleb(73), &[0x49]);
        assert_eq!(uleb(300), &[0xac, 0x02]);
        let mut h = Sha256::new();
        h.update(Sha256::digest(b"foo"));
        h.update(Sha256::digest(uleb(73)));
        assert_eq!(hex(&h.finalize()), "1f8ebbd62265480cbeeeb6462eb58a1edf3b9bee8c38369d1f34c9597b09da38");
    }

    #[test]
    fn vec_seq_equiv_tuple() {
        assert_eq!(
            hex(&hash_leaf(&RidValue::Array(vec![
                RidValue::U64(1),
                RidValue::U64(2),
                RidValue::U64(3),
            ]))),
            "2628a7cbda257cd0dc45779e43080e0a93037468fe270faae515f7c7941069e3"
        );
    }

    #[test]
    fn vec_option_some_transparent_none_omitted() {
        assert_eq!(
            rid_hex(&[("x", RidValue::U64(3)), ("y", s("hello"))]),
            "f9532efd31fe55f5013d84fa4e1585b9a52e6cf82842adabe22fd3ac359c4143"
        );
        assert_eq!(
            rid_hex(&[("x", RidValue::U64(7_000_000))]),
            "fe4c9222ee2bffbc3ff7f25510d5b258adfa38a16740050a112ccc98eb886de5"
        );
    }

    #[test]
    fn vec_newtype_variant() {
        assert_eq!(
            rid_hex(&[("newtype", RidValue::U64(673))]),
            "87371cb37e4a28512e898a691ccbd8cd33efb902a5ac9ecf3a73e5e97f9c23f8"
        );
    }

    #[test]
    fn vec_tuple_variant() {
        assert_eq!(
            rid_hex(&[("tuple", RidValue::Array(vec![
                s("four"),
                RidValue::Array(vec![RidValue::U64(5), RidValue::U64(6)]),
            ]))]),
            "729d2b57c442203f83b347ec644c8b38277076b5a9ebb3c2873ac64ddd793304"
        );
    }

    #[test]
    fn vec_struct_variant() {
        // struct variant ≡ one-field struct: {struct: {field: b"\x0Aic-request"}} ≡
        // {struct: <map hash>} — with flat RidValue we hash the inner one-field map directly.
        let inner = request_id(&[("field", b(b"\x0Aic-request"))]);
        let mut h = Sha256::new();
        h.update(Sha256::digest(b"struct"));
        h.update(inner);
        assert_eq!(hex(&h.finalize()), "c2b325a8f7633df8054e9bd538ac8d26dc85cba4ad542cdbfca7109e1a60cf0c");
    }

    #[test]
    fn u64_hashes_minimal_uleb128() {
        // SHA256(b"\x00") vs SHA256(b"\x80\x00"): minimal-length, no padding
        assert_ne!(hash_leaf(&RidValue::U64(0)), hash_leaf(&RidValue::U64(128)));
        // SHA256(uleb128(u64::MAX)) is exactly 10 bytes of input
        let mut ten = vec![0xffu8; 9];
        ten.push(0x01);
        let h1 = hash_leaf(&RidValue::U64(u64::MAX));
        let h2: [u8; 32] = Sha256::digest(&ten).into();
        assert_eq!(h1, h2);
    }

    #[test]
    fn principal_as_sender_hashes_raw_bytes() {
        // A 1-byte anonymous sender contributes SHA256(raw bytes) — same rule as any bytes.
        let p = Principal::anonymous();
        let expect: [u8; 32] = Sha256::digest([0x04u8]).into();
        assert_eq!(hash_leaf(&RidValue::Bytes(p.as_slice().to_vec())), expect);
    }

    #[test]
    fn signable_prepends_domain_separator() {
        let rid = [7u8; 32];
        let sb = signable(&rid);
        assert_eq!(sb.len(), 43);
        assert_eq!(&sb[..11], b"\x0Aic-request");
        assert_eq!(&sb[11..], &rid);
    }
}
