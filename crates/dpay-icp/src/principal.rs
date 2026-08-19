//! Principal derivation and the base32/crc32 textual form.
//!
//! Principal = opaque ≤29-byte blob (ic-principal semantics). Self-authenticating =
//! `SHA224(DER SPKI of ed25519 key) ‖ 0x02`; text = base32(crc32 BE ‖ blob), RFC4648 no-pad,
//! lowercased, `-` every 5 chars.

use crate::IcpError;
use sha2::{Digest, Sha224};

/// RFC8410 SubjectPublicKeyInfo DER prefix for an ed25519 pubkey (12 bytes; the other 32 of
/// the 44-byte DER are the raw key). Hard-coded identically in ic-agent for node-key checks.
pub const DER_PREFIX: [u8; 12] = [48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0];

/// IC principals are at most 29 bytes.
pub const MAX_PRINCIPAL_LEN: usize = 29;

/// An IC principal (canister id, user id, opaque blob ≤29 bytes).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Principal(Vec<u8>);

impl Principal {
    /// Self-authenticating principal from a DER SPKI public key (any length; for ed25519 the
    /// 44-byte `302a300506032b6570032100‖raw32`).
    pub fn self_authenticating_der(der: &[u8]) -> Principal {
        // SHA224(der)[0..28] ‖ 0x02
        let h = Sha224::digest(der);
        let mut b = Vec::with_capacity(29);
        b.extend_from_slice(&h);
        b.push(0x02);
        Principal(b)
    }

    /// Self-authenticating principal from a raw 32-byte ed25519 pubkey (builds the 44-byte
    /// DER internally).
    pub fn self_authenticating_ed25519(raw_pubkey: &[u8; 32]) -> Principal {
        let mut der = DER_PREFIX.to_vec();
        der.extend_from_slice(raw_pubkey);
        Principal::self_authenticating_der(&der)
    }

    /// The anonymous principal — single byte `0x04`, text `2vxsx-fae`.
    pub fn anonymous() -> Principal {
        Principal(vec![0x04])
    }

    /// The management canister — empty blob, text `aaaaa-aa`.
    pub fn management_canister() -> Principal {
        Principal(Vec::new())
    }

    /// The raw principal bytes.
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    /// From raw principal bytes (>29 bytes rejected). Added beyond the frozen API —
    /// every consumer (tests, dpay-icp-tests) needs a byte constructor.
    pub fn from_bytes(b: &[u8]) -> Result<Principal, IcpError> {
        if b.len() > MAX_PRINCIPAL_LEN {
            Err(IcpError::PrincipalTooLong(b.len()))
        } else {
            Ok(Principal(b.to_vec()))
        }
    }

    /// Textual form: `base32(crc32(blob) BE ‖ blob)`, RFC4648 `A-Z2-7` no padding,
    /// lowercased, `-` inserted every 5 chars.
    pub fn to_text(&self) -> String {
        let mut payload = crc32_ieee(&self.0).to_be_bytes().to_vec();
        payload.extend_from_slice(&self.0);
        let enc = base32_encode(&payload).to_ascii_lowercase();
        let mut s = String::with_capacity(enc.len() + enc.len() / 5 + 8);
        for (i, c) in enc.chars().enumerate() {
            if i > 0 && i % 5 == 0 {
                s.push('-');
            }
            s.push(c);
        }
        s
    }

    /// Parse the textual form (case-insensitive, `-`-stripped); rejects wrong CRC and
    /// non-canonical grouping via round-trip compare (ic-principal semantics).
    pub fn from_text(s: &str) -> Result<Principal, IcpError> {
        let mut upper = s.to_ascii_uppercase();
        upper.retain(|c| c != '-');
        let decoded = base32_decode(&upper)
            .ok_or_else(|| IcpError::PrincipalText("not base32 (RFC4648 A-Z2-7)".into()))?;
        if decoded.len() < 4 {
            return Err(IcpError::PrincipalText("too short for CRC + payload".into()));
        }
        let (crc, blob) = decoded.split_at(4);
        if blob.len() > MAX_PRINCIPAL_LEN {
            return Err(IcpError::PrincipalTooLong(blob.len()));
        }
        if crc32_ieee(blob).to_be_bytes() != crc {
            return Err(IcpError::PrincipalText("CRC32 mismatch".into()));
        }
        let p = Principal(blob.to_vec());
        if s.to_ascii_lowercase() != p.to_text() {
            return Err(IcpError::PrincipalText("non-canonical grouping".into()));
        }
        Ok(p)
    }
}

impl std::fmt::Debug for Principal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Principal({})", self.to_text())
    }
}

/// An ICRC-1 account: owner principal + 32-byte subaccount. `subaccount == [0;32]` ≡ the
/// default subaccount (`None` in icrc-ledger-types; the ledger normalizes).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Account {
    pub owner: Principal,
    pub subaccount: [u8; 32],
}

impl Account {
    /// Account on the owner's DEFAULT subaccount (all-zero).
    pub fn new(owner: Principal) -> Self {
        Account { owner, subaccount: [0u8; 32] }
    }

    /// ICRC-1 textual account form, byte-exact with `icrc-ledger-types` `Display`:
    /// default subaccount → owner text only; else `owner-checksum.hexsub` where checksum =
    /// lowercase base32(crc32(owner‖subaccount) BE) (7 chars) and hexsub is the subaccount
    /// hex with leading zeros trimmed.
    pub fn text(&self) -> String {
        format!("{self}")
    }
}

/// The subset of hex encoding needed for account text (no external hex crate).
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

/// ICRC-1 textual account form, byte-exact with `icrc-ledger-types` `Display`.
impl std::fmt::Display for Account {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.subaccount == [0u8; 32] {
            return write!(f, "{}", self.owner.to_text());
        }
        let mut crc_input = self.owner.as_slice().to_vec();
        crc_input.extend_from_slice(&self.subaccount);
        let checksum = base32_encode(&crc32_ieee(&crc_input).to_be_bytes()).to_lowercase();
        let hex_sub = hex_encode(&self.subaccount);
        let hex_sub = hex_sub.trim_start_matches('0');
        write!(f, "{}-{}.{}", self.owner.to_text(), checksum, hex_sub)
    }
}

/// CRC-32/ISO-HDLC (the crc32fast algorithm): poly 0xEDB88320 reflected, init/final xor
/// 0xFFFFFFFF, bitwise — matches the crc32fast crate ic-principal uses.
fn crc32_ieee(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// RFC4648 base32 (A-Z2-7), no padding, uppercase output.
fn base32_encode(data: &[u8]) -> String {
    const ALPHA: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity(data.len().div_ceil(5) * 8);
    for chunk in data.chunks(5) {
        let mut buf = [0u8; 5];
        buf[..chunk.len()].copy_from_slice(chunk);
        let n = ((buf[0] as u64) << 32)
            | ((buf[1] as u64) << 24)
            | ((buf[2] as u64) << 16)
            | ((buf[3] as u64) << 8)
            | (buf[4] as u64);
        let chars = match chunk.len() {
            1 => 2,
            2 => 4,
            3 => 5,
            4 => 7,
            _ => 8,
        };
        for i in 0..chars {
            let idx = ((n >> (35 - i * 5)) & 0x1f) as usize;
            out.push(ALPHA[idx] as char);
        }
    }
    out
}

/// RFC4648 base32 decode, no padding accepted (returns None on any non-alphabet char or
/// impossible length; trailing bits must be zero).
fn base32_decode(s: &str) -> Option<Vec<u8>> {
    type U5 = u8;
    fn val(c: u8) -> Option<U5> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'2'..=b'7' => Some(c - b'2' + 26),
            _ => None,
        }
    }
    if s.len() % 8 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    for chunk in s.as_bytes().chunks(8) {
        let mut acc: u64 = 0;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= u64::from(val(c)?) << (35 - i * 5);
        }
        let bytes = match chunk.len() {
            2 => 1,
            4 => 2,
            5 => 3,
            7 => 4,
            8 => 5,
            _ => return None,
        };
        // The unused low bits must be zero (canonical encoding) — ic-principal uses
        // data_encoding whose decode also enforces this.
        if chunk.len() < 8 && (acc & ((1u64 << (40 - chunk.len() * 5)) - 1)) != 0 {
            return None;
        }
        let be = acc.to_be_bytes(); // 8 bytes; acc holds ≤40 bits at the top
        out.extend_from_slice(&be[3..3 + bytes]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // §7.2 of brief A: RFC 8032 test-vector key #1.
    const PK: [u8; 32] = [
        0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64,
        0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68,
        0xf7, 0x07, 0x51, 0x1a,
    ];

    fn h(s: &str) -> Vec<u8> {
        s.bytes()
            .collect::<Vec<_>>()
            .chunks(2)
            .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn self_auth_from_raw_matches_der_path() {
        let der = h("302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        assert_eq!(Principal::self_authenticating_der(&der).as_slice(), &h("3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d202")[..]);
        assert_eq!(Principal::self_authenticating_ed25519(&PK).to_text(), "e73il-iz5tp-nkgt7-idxyw-ngkah-47bpv-qdase-pzde6-g6vwc-a3eql-jae");
    }

    #[test]
    fn management_and_anonymous_round_trip() {
        assert_eq!(Principal::management_canister().as_slice(), b"");
        assert_eq!(Principal::management_canister().to_text(), "aaaaa-aa");
        assert_eq!(Principal::anonymous().as_slice(), &[0x04]);
        assert_eq!(Principal::anonymous().to_text(), "2vxsx-fae");
        assert_eq!(Principal::from_text("aaaaa-aa").unwrap(), Principal::management_canister());
        assert_eq!(Principal::from_text("2vxsx-fae").unwrap(), Principal::anonymous());
    }

    #[test]
    fn text_round_trip_various_lengths() {
        for len in [0usize, 1, 2, 5, 8, 20, 29] {
            let blob: Vec<u8> = (0..len).map(|i| (i * 37 + len) as u8).collect();
            let p = Principal(blob.clone());
            let text = p.to_text();
            assert_eq!(Principal::from_text(&text).unwrap().as_slice(), &blob[..], "len {len}");
        }
    }

    #[test]
    fn from_text_rejects_bad_crc_grouping_and_alphabet() {
        let p = Principal::self_authenticating_ed25519(&PK);
        let text = p.to_text();
        // corrupt one char
        let mut bad = text.clone();
        let idx = bad.find('-').map(|i| i + 1).unwrap_or(0);
        bad.replace_range(idx..idx + 1, if bad.as_bytes()[idx] == b'a' { "b" } else { "a" });
        assert!(Principal::from_text(&bad).is_err());
        // abnormal grouping (extra dash) — round-trip check rejects
        let regrouped = text.replace('-', "");
        let mut abnormal = String::new();
        for (i, c) in regrouped.chars().enumerate() {
            if i > 0 && i % 4 == 0 {
                abnormal.push('-');
            }
            abnormal.push(c);
        }
        assert!(Principal::from_text(&abnormal).is_err());
        // invalid alphabet char
        assert!(Principal::from_text("aaaaa-ab").is_err());
        assert!(Principal::from_text("aaaaa-a1").is_err());
        assert!(Principal::from_text("0189a").is_err());
        assert!(Principal::from_text("").is_err());
        // uppercase input accepted (case-insensitive parse, canonical lower round-trip)
        assert_eq!(Principal::from_text(&text.to_uppercase()).unwrap(), p);
    }

    #[test]
    fn account_display_matches_icrc_ledger_types() {
        // vectors from icrc-ledger-types account.rs tests
        let owner = Principal::from_text("k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae").unwrap();
        assert_eq!(Account::new(owner.clone()).text(), owner.to_text());
        let mut a = Account::new(owner.clone());
        a.subaccount = h("0000000000000000000000000000000000000000000000000000000000000001").try_into().unwrap();
        assert_eq!(a.text(), "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae-6cc627i.1");
        a.subaccount = h("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20").try_into().unwrap();
        assert_eq!(a.text(), "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae-dfxgiyy.102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
    }
}
