//! Minimal CBOR writer emitting exactly the serde_cbor 0.11.2 subset the IC envelope uses
//! (major types 0-5 + the 55799 self-describe tag), plus a small definite-length reader
//! used by tests and future response handling. This is NOT a general CBOR codec.

/// Emit the self-describe tag header `D9 D9 F7` (tag 55799) — ic-agent always prefixes
/// envelopes with it.
pub fn self_describe(out: &mut Vec<u8>) {
    out.extend_from_slice(&[0xd9, 0xd9, 0xf7]);
}

fn head(out: &mut Vec<u8>, major: u8, len: usize) {
    let m = major << 5;
    let n = len as u64; // lengths here are always < 2^53 in practice
    if n < 24 {
        out.push(m | n as u8);
    } else if n <= 0xff {
        out.push(m | 24);
        out.push(n as u8);
    } else if n <= 0xffff {
        out.push(m | 25);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else if n <= 0xffff_ffff {
        out.push(m | 26);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&n.to_be_bytes());
    }
}

/// Unsigned integer (major 0), minimal length — ingress_expiry ≈ 1.7e18 → `1B` + 8B BE.
pub fn uint(out: &mut Vec<u8>, v: u64) {
    head(out, 0, v as usize);
}

/// Byte string (major 2), definite length.
pub fn bytes(out: &mut Vec<u8>, b: &[u8]) {
    head(out, 2, b.len());
    out.extend_from_slice(b);
}

/// Text string (major 3), utf-8, definite length.
pub fn text(out: &mut Vec<u8>, s: &str) {
    head(out, 3, s.len());
    out.extend_from_slice(s.as_bytes());
}

/// Map header (major 5) for `n` pairs; pairs are then written in caller order
/// (serde struct order — NOT sorted).
pub fn map(out: &mut Vec<u8>, n: usize) {
    head(out, 5, n);
}

/// Array header (major 4) for `n` items.
pub fn array(out: &mut Vec<u8>, n: usize) {
    head(out, 4, n);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn minimal_integer_lengths() {
        let mut v = vec![];
        uint(&mut v, 0);
        uint(&mut v, 23);
        uint(&mut v, 24);
        uint(&mut v, 255);
        uint(&mut v, 256);
        uint(&mut v, 1_685_570_400_000_000_000);
        assert_eq!(
            hex(&v),
            // 0, 23, 24, 255, 256, expiry (1B head + 8B BE; expiry LSB is 0x00)
            "0017181818ff1901001b1764595927e9c000"
        );
    }

    #[test]
    fn bytes_and_text_headers() {
        let mut v = vec![];
        bytes(&mut v, &[0u8; 23]); // header 0x57: major 2, len inline
        bytes(&mut v, &[0u8; 24]); // header 0x58 0x18
        bytes(&mut v, &[0u8; 44]); // header 0x58 0x2c (the DER pubkey)
        assert_eq!(&v[0..1], &[0x57]);
        assert_eq!(&v[24..26], &[0x58, 0x18]);
        assert_eq!(&v[50..52], &[0x58, 0x2c]);

        let mut t = vec![];
        text(&mut t, "content"); // 7 chars → 0x67
        text(&mut t, "sender_pubkey"); // 13 chars → 0x6d
        assert_eq!(&t[0..8], &[0x67, b'c', b'o', b'n', b't', b'e', b'n', b't']);
        assert_eq!(t[8], 0x6d);
    }

    #[test]
    fn map_and_array_headers() {
        let mut v = vec![];
        map(&mut v, 3);
        array(&mut v, 1);
        self_describe(&mut v);
        assert_eq!(hex(&v), "a381d9d9f7");
    }
}
