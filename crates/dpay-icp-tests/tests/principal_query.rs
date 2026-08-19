//! A FRESH self-authenticating principal is accepted by the real ledger's account derivation:
//! `icrc1_balance_of` for a never-funded device key returns 0 (not a rejection) via a signed query
//! the key itself sent — proving the DER→principal→account derivation the validator enforces is
//! exactly the one dpay-icp computes (offline, deterministic, seconds).

use dpay_icp_tests::wire;
use ed25519_dalek::SigningKey;

#[test]
fn principal_text_roundtrip_on_ledger() {
    let e = dpay_icp_tests::Env::ledger_only();
    let fresh = SigningKey::from([7u8; 32]);
    let p = wire::principal_of(&fresh);

    // Text form round-trips through dpay-icp's own codec (compared via text to avoid assuming
    // trait derives on Principal).
    let text = p.to_text();
    let rt = wire::Principal::from_text(&text).unwrap_or_else(|e| panic!("from_text: {e}"));
    assert_eq!(rt.to_text(), text);

    // The real ledger answers a balance query for the fresh account with a clean 0.
    assert_eq!(e.rail_balance(&fresh, &p), 0);
}
