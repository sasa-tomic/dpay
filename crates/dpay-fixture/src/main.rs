//! Emit deterministic dfx candid argument files for the real dfx-deploy smoke test.
//!
//! This never reimplements money logic: it builds a real [`SignedAuthorization`] with the shared
//! `dpay-core` and serialises it as candid text, so `dfx canister call pay` submits the *exact*
//! 196-byte wire the phone would sign. Deterministic seeds make the deploy reproducible run-to-run,
//! and a far-future `expiry` keeps the fixture valid regardless of the replica's wall clock.

use dpay_core::{Authorization, DEMO_USD, SignedAuthorization, PUBKEY_LEN};
use ed25519_dalek::SigningKey;
use std::fs;
use std::path::Path;

/// A candid `blob "..."` literal with every byte hex-escaped (`\hh`) — unambiguous for any bytes.
fn blob(bytes: &[u8]) -> String {
    let mut s = String::from("blob \"");
    for b in bytes {
        s.push_str(&format!("\\{b:02x}"));
    }
    s.push('"');
    s
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Deterministic Ed25519 key from a single-byte seed pattern (demo only; any 32 bytes is a seed).
fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn main() {
    // --- demo accounts (deterministic; the phone's real key would come from generate_keypair) ---
    let payer = key(1);
    let merchant = key(2);
    let payer_pk: [u8; PUBKEY_LEN] = payer.verifying_key().to_bytes();
    let merchant_pk: [u8; PUBKEY_LEN] = merchant.verifying_key().to_bytes();

    // --- ledger opening state ---
    const BAL_A: u64 = 10_000; // payer opens with $100.00
    const BAL_B: u64 = 0; // merchant opens empty
    const CAP: u64 = 100_000; // $1,000.00 per-tx cap

    // --- the offline-signed payment: payer -> merchant, $25.00 ---
    const AMOUNT: u64 = 2_500;
    let nonce = [42u8; 16];
    const EXPIRY: u64 = 4_102_444_800; // 2100-01-01Z — far future so a wall-clock deploy never expires it

    let auth = Authorization { from: payer_pk, to: merchant_pk, amount: AMOUNT, nonce, expiry: EXPIRY, currency: DEMO_USD };
    let wire = SignedAuthorization::new(&payer, auth).to_wire();

    let out = Path::new("dfx/args");
    fs::create_dir_all(out).expect("mkdir dfx/args");

    // Candid record field order mirrors the canister's InitArg for readability (candid matches by name).
    let init = format!(
        "(record {{ account_a = {}; balance_a = {BAL_A} : nat64; account_b = {}; balance_b = {BAL_B} : nat64; per_tx_cap = {CAP} : nat64 }})\n",
        blob(&payer_pk),
        blob(&merchant_pk),
    );
    fs::write(out.join("init.arg"), init).unwrap();
    fs::write(out.join("pay.arg"), format!("({})\n", blob(&wire))).unwrap();
    // `balance_of : (blob, nat32) -> (nat64) query` — the second arg is the currency (DEMO_USD = 0).
    fs::write(out.join("payer.arg"), format!("({}, {DEMO_USD} : nat32)\n", blob(&payer_pk))).unwrap();
    fs::write(out.join("merchant.arg"), format!("({}, {DEMO_USD} : nat32)\n", blob(&merchant_pk))).unwrap();

    // Post-conditions the deploy script asserts against (avoids recomputing money in bash).
    let expect = format!(
        "AMOUNT={AMOUNT}\nPAYER_AFTER={}\nMERCHANT_AFTER={}\n",
        BAL_A - AMOUNT,
        BAL_B + AMOUNT,
    );
    fs::write(out.join("expect.env"), expect).unwrap();

    eprintln!("wrote dfx/args/{{init,pay,payer,merchant}}.arg (+ expect.env)");
    eprintln!("  payer    {}  ${}.{:02}", hex(&payer_pk), BAL_A / 100, BAL_A % 100);
    eprintln!("  merchant {}  ${}.{:02}", hex(&merchant_pk), BAL_B / 100, BAL_B % 100);
    eprintln!(
        "  payment  ${}.{:02}  nonce={}  wire={} bytes",
        AMOUNT / 100,
        AMOUNT % 100,
        hex(&nonce),
        wire.len()
    );
}
