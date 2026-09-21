//! The rail-scoped refund/settle address well-formedness gate — shared by BOTH cefi venue
//! adapters (`crate::sideshift`, `crate::trocador`) because both trade the SAME two rails
//! and a refund address that cannot receive must be refused before an order exists, by ONE
//! validator that cannot drift between venues. This is PROD code (the fund-loss guard:
//! without a well-formed refund address the venue keeps the user's funds on a failed
//! deposit), so it lives in its own auditable module rather than a copy per venue.
//!
//! Structural only — the venue still owns reachability/ownership; this refuses the orders
//! that could never be refunded to the stated address before they exist.
//! `icp`: an IC principal (CRC-checked), a full ICRC-1 account text, or the 64-hex account
//! identifier — all three via the shared `dpay-icp` codec (the exact parser the ledgers
//! speak). The account identifier is the form the venue payout layer REQUIRES: SideShift's
//! ICP payouts cannot be addressed to principal-format texts (their engineering, confirmed
//! 2026-09-21; the first EURC→ICP return shift refunded 2026-09-20 for exactly this), so
//! the device now EMITS the hex identifier everywhere it names an IC payout target, and
//! principal/account texts stay accepted here until SideShift ships principal support.
//! `solana`: base58 that decodes to exactly 32 bytes (the same check the transaction
//! builder applies).

/// Is this a well-formed address on the given venue NETWORK code (the deposit rail of the
/// order)? The venue's own network vocabulary maps onto the two rails both integrations
/// serve (`icp`, `solana`).
pub(crate) fn refund_address_wellformed(network: &str, s: &str) -> bool {
    match network {
        "icp" => {
            use dpay_icp::principal::{Account, AccountIdentifier, Principal};
            Principal::from_text(s).is_ok()
                || Account::from_text(s).is_ok()
                || AccountIdentifier::from_text(s).is_ok()
        }
        "solana" => bs58_decode(s).is_some_and(|b| b.len() == 32),
        // A network code this integration does not serve cannot be refunded-to: refuse.
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
    fn refund_address_wellformedness_is_rail_scoped() {
        use dpay_icp::principal::{Account, AccountIdentifier, Principal};
        // IC rail: a valid principal passes…
        let principal = Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap();
        assert!(refund_address_wellformed("icp", &principal.to_text()));
        // …and so does the full ICRC-1 account text (owner + 7-char checksum + subaccount).
        let mut subaccount = [0u8; 32];
        subaccount[31] = 0xa0;
        let account_text = Account { owner: principal.clone(), subaccount }.text();
        assert_eq!(
            account_text,
            Account::from_text(&account_text).unwrap().text(),
            "the fixture is the codec's own canonical text"
        );
        assert!(refund_address_wellformed("icp", &account_text));
        // …and so does the 64-hex account identifier — the form SideShift's ICP payout
        // layer requires (its engineering cannot pay principals; 2026-09-21). The CRC
        // embedded in the hex is what refuses a typo'd venue payout address.
        let acct_id = AccountIdentifier::from_principal(&principal, &[0u8; 32]);
        assert!(refund_address_wellformed("icp", &acct_id.to_text()));
        let mut corrupted = acct_id.to_text();
        let last = corrupted.pop().unwrap();
        corrupted.push(if last == '0' { '1' } else { '0' });
        assert!(
            !refund_address_wellformed("icp", &corrupted),
            "a one-digit hex flip breaks the embedded CRC — refused"
        );
        // …and the CRC/alphabet check refuses a malformed principal outright.
        assert!(!refund_address_wellformed("icp", "not-a-principal"));
        assert!(!refund_address_wellformed("icp", ""));
        // Solana rail: base58 that decodes to exactly 32 bytes (a real mainnet address).
        assert!(refund_address_wellformed(
            "solana",
            "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
        ));
        // Not 32 bytes / not base58 at all.
        assert!(!refund_address_wellformed("solana", "111"));
        assert!(!refund_address_wellformed(
            "solana",
            "0OIl-not-base58-safe"
        ));
        // An unknown network code is refused structurally (cannot be refunded-to).
        assert!(!refund_address_wellformed("ethereum", "0xabc"));
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
