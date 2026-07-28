//! Deterministic signing fixture for the ICRC-ledger dfx deploy (`scripts/dfx-deploy-icrc.sh`).
//!
//! Prints shell-evaluable `KEY=value` lines: the payer/merchant Ed25519 pubkeys (hex) and the
//! exact 196-byte offline-signed wire the phone would produce. Deterministic seeds (matching
//! `dpay-fixture`) keep the deploy reproducible run-to-run; a far-future expiry keeps the wire
//! valid regardless of the replica's wall clock. Money logic is dpay-core's, never reimplemented.
//!
//! The canister ids are NOT emitted here — they are only known after `dfx canister create`, so the
//! deploy script builds the candid init args inline from this fixture's keys/wire + those ids.

use dpay_core::{Authorization, SignedAuthorization, DEMO_USD, PUBKEY_LEN};
use ed25519_dalek::SigningKey;

/// Deterministic Ed25519 key from a single-byte seed pattern (matches dpay-fixture; demo only).
fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let payer = key(1);
    let merchant = key(2);
    let payer_pk: [u8; PUBKEY_LEN] = payer.verifying_key().to_bytes();
    let merchant_pk: [u8; PUBKEY_LEN] = merchant.verifying_key().to_bytes();

    const INIT_A: u64 = 10_000; // payer opens with $100.00 (cents)
    const AMOUNT: u64 = 2_500; // pays $25.00
    const CAP: u64 = 100_000; // $1,000.00 per-tx cap
    const EXPIRY: u64 = 4_102_444_800; // 2100-01-01Z — far future so a wall-clock deploy never expires it
    let nonce = [42u8; 16];

    let auth = Authorization {
        from: payer_pk,
        to: merchant_pk,
        amount: AMOUNT,
        nonce,
        expiry: EXPIRY,
        currency: DEMO_USD,
    };
    let wire = SignedAuthorization::new(&payer, auth).to_wire();

    println!("PAYER_PK={}", hex(&payer_pk));
    println!("MERCHANT_PK={}", hex(&merchant_pk));
    println!("WIRE={}", hex(&wire));
    println!("INIT_A={INIT_A}");
    println!("AMOUNT={AMOUNT}");
    println!("CAP={CAP}");
    println!("EXPIRY={EXPIRY}");
}
