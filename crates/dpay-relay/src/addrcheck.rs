//! The rail-scoped refund/settle address well-formedness gate — shared by BOTH cefi venue
//! adapters (`crate::sideshift`, `crate::trocador`) because both trade the SAME two rails
//! and an address that cannot receive must be refused before an order exists, by ONE
//! validator that cannot drift between venues. This is PROD code (the fund-loss guard:
//! without a well-formed refund address the venue keeps the user's funds on a failed
//! deposit; without a well-formed settle address the payout dead-ends and the order sits
//! `settling` until it is refunded — the 2026-09-20 principal-text incident), so it lives
//! in its own auditable module rather than a copy per venue.
//!
//! Structural only — the venue still owns reachability/ownership; this refuses the orders
//! that could never be paid out or refunded before they exist.
//! `icp`: an IC principal (CRC-checked), a full ICRC-1 account text, or the 32-byte account
//! identifier as 64-hex — all via the shared `dpay-icp` codec (the exact parser the ledgers
//! speak; the 64-hex form's embedded CRC32 is checked, so a decode to exactly 32 bytes is
//! by construction). The identifier is the form the venue payout layer REQUIRES: SideShift's
//! ICP payouts cannot be addressed to principal-format texts (their engineering, confirmed
//! in writing 2026-09-21; the first EURC→ICP return shift refunded 2026-09-20 for exactly
//! this), so the device EMITS the hex identifier everywhere it names an IC payout target,
//! and principal/account texts stay accepted here until SideShift ships principal support.
//! `solana`: base58 that decodes to exactly 32 bytes (the same check the transaction
//! builder applies).
//! `ethereum` (2026-09-27, the EVM-native settle widening): `0x` + exactly 40 hex chars,
//! any case — an EVM address is case-insensitive in content (the EIP-55 mixed-case form
//! is an integrity CHECKSUM, not identity; structural well-formedness accepts all-lower,
//! all-upper and mixed). The venue owns reachability/ownership, as for every rail.

/// Is this a well-formed address on the given venue NETWORK code (the rail an address must
/// live on — the DEPOSIT rail for a refund, the SETTLE rail for a payout)? The venue's own
/// network vocabulary maps onto the rails this integration serves (`icp`, `solana`,
/// `ethereum`).
pub(crate) fn address_wellformed(network: &str, s: &str) -> bool {
    match network {
        "icp" => {
            use dpay_icp::principal::{Account, AccountIdentifier, Principal};
            Principal::from_text(s).is_ok()
                || Account::from_text(s).is_ok()
                // The 32-byte account identifier as 64-hex — the exchange-style address
                // SideShift's ICP payout layer speaks (it cannot send to principal text:
                // the 2026-09-20 refund incident). `from_text` verifies the embedded
                // CRC32, so the 32-byte length is by construction.
                || AccountIdentifier::from_text(s).is_ok()
        }
        "solana" => bs58_decode(s).is_some_and(|b| b.len() == 32),
        "ethereum" => {
            let body = s.strip_prefix("0x").unwrap_or(s);
            body.len() == 40 && body.bytes().all(|b| b.is_ascii_hexdigit())
        }
        // A network code this integration does not serve cannot be paid/refunded-to: refuse.
        _ => false,
    }
}

/// Minimal bs58 DECODE (alphabet table + big-number base conversion, leading-'1' zeros).
/// Hand-rolled because the relay tree has no bs58 dependency — the same shape as the
/// test-helpers stub's decoder in `app.rs`, but this one is PROD code: it is the refund
/// address's well-formedness gate.
pub(crate) fn bs58_decode(s: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::new(); // big-endian base-256 accumulator
    for ch in s.bytes() {
        let val = u32::try_from(ALPHABET.iter().position(|&a| a == ch)?).ok()?;
        let mut carry = val;
        for byte in digits.iter_mut().rev() {
            let acc = u32::from(*byte) * 58 + carry;
            *byte = (acc & 0xff) as u8;
            carry = acc >> 8;
        }
        while carry > 0 {
            digits.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&b| b == b'1').count();
    let mut out = vec![0u8; zeros];
    out.extend(digits);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_wellformedness_is_rail_scoped() {
        use dpay_icp::principal::{Account, AccountIdentifier, Principal};
        // IC rail: a valid principal passes…
        let principal = Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap();
        assert!(address_wellformed("icp", &principal.to_text()));
        // …and so does the full ICRC-1 account text (owner + 7-char checksum + subaccount).
        let mut subaccount = [0u8; 32];
        subaccount[31] = 0xa0;
        let account_text = Account { owner: principal.clone(), subaccount }.text();
        assert_eq!(
            account_text,
            Account::from_text(&account_text).unwrap().text(),
            "the fixture is the codec's own canonical text"
        );
        assert!(address_wellformed("icp", &account_text));
        // …and so does the 32-byte ACCOUNT IDENTIFIER as 64-hex — the exchange-style
        // address SideShift's ICP payout layer pays to. Pinned by the derivation vector
        // (the principal's default subaccount; the same value `scripts/agent-key.mjs
        // balance` prints as `account`), re-derived here through the shared codec.
        let vector = AccountIdentifier::from_principal(
            &Principal::from_text("vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae")
                .unwrap(),
            &[0u8; 32],
        )
        .to_text();
        assert_eq!(
            vector,
            "9fac39d1ffbd746a5a6e18ad812d053ef2fbebeacd28a4e236d3cca052692279",
            "the SideShift payout vector is the real derivation"
        );
        assert!(address_wellformed("icp", &vector));
        // Malformed 64-hex is refused: a flipped character breaks the embedded CRC32…
        let mut bad_crc = vector.clone();
        let flipped = if bad_crc.ends_with('0') { "1" } else { "0" };
        bad_crc.replace_range(63..64, flipped);
        assert!(!address_wellformed("icp", &bad_crc));
        // …and a wrong length or non-hex text never decodes at all.
        assert!(!address_wellformed("icp", &vector[..62]));
        assert!(!address_wellformed("icp", &"g".repeat(64)));
        // …and the CRC/alphabet check refuses a malformed principal outright.
        assert!(!address_wellformed("icp", "not-a-principal"));
        assert!(!address_wellformed("icp", ""));
        // Solana rail: base58 that decodes to exactly 32 bytes (a real mainnet address).
        assert!(address_wellformed(
            "solana",
            "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
        ));
        // Not 32 bytes / not base58 at all.
        assert!(!address_wellformed("solana", "111"));
        assert!(!address_wellformed(
            "solana",
            "0OIl-not-base58-safe"
        ));
        // An unknown network code is refused structurally (cannot be paid/refunded-to).
        assert!(!address_wellformed("ethereum-other", "0xabc"));
        // Ethereum rail (2026-09-27): 0x + exactly 40 hex, any case (the EIP-55 mixed
        // case is a checksum, not identity); the empty/garbage forms stay refused.
        assert!(address_wellformed(
            "ethereum",
            "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"
        ));
        assert!(address_wellformed(
            "ethereum",
            "0x71c7656ec7ab88b098defb751b7401b5f6d8976f"
        ));
        assert!(!address_wellformed("ethereum", "0xabc"));
        assert!(!address_wellformed("ethereum", "71c7656ec7ab88b098defb751b7401b5f6d8976"));
        assert!(!address_wellformed(
            "ethereum",
            "0x71c7656ec7ab88b098defb751b7401b5f6d8976f0"
        ));
        assert!(!address_wellformed(
            "ethereum",
            "0x71c7656ec7ab88b098defb751b7401b5f6d897g"
        ));
        assert!(!address_wellformed("ethereum", ""));
    }

    #[test]
    fn bs58_decode_roundtrips_and_counts_leading_ones() {
        // The system program's address is 32 zero bytes: all-'1' text, zeros only.
        assert_eq!(
            bs58_decode("11111111111111111111111111111111").unwrap(),
            vec![0u8; 32]
        );
        // A real 32-byte pubkey decodes to exactly 32 bytes.
        assert_eq!(
            bs58_decode("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
                .unwrap()
                .len(),
            32
        );
        // Off-alphabet characters are rejected.
        assert!(bs58_decode("0OIl").is_none());
        assert!(bs58_decode("").unwrap().is_empty());
    }
}
