//! PocketIC integration tests for the dpay canister — offline, deterministic, in seconds.
//!
//! Prereq: build the wasm first, then point `DPAY_CANISTER_WASM` at it (the justfile does this):
//!   cargo build -p dpay-canister --target wasm32-unknown-unknown --release
//! and have `POCKET_IC_BIN` set to the vendored server binary (third_party/bin/pocket-ic).

use candid::{decode_one, encode_one, CandidType, Principal};
use dpay_core::{generate_keypair, Authorization, SignedAuthorization};
use ed25519_dalek::SigningKey;
use pocket_ic::{PocketIc, Time};
use serde::Deserialize;
use std::time::Duration;

const T0_SECS: u64 = 1_800_000_000;
const T0_NANOS: u64 = T0_SECS * 1_000_000_000;
const CAP: u64 = 100_000; // per-tx cap: $1,000.00 in cents
const INIT_A: u64 = 10_000; // payer opens with $100.00

#[derive(CandidType, Deserialize)]
struct InitArg {
    account_a: Vec<u8>,
    balance_a: u64,
    account_b: Vec<u8>,
    balance_b: u64,
    per_tx_cap: u64,
}

#[derive(CandidType, Deserialize, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
}

fn wasm_bytes() -> Vec<u8> {
    let path = std::env::var("DPAY_CANISTER_WASM")
        .unwrap_or_else(|_| "target/wasm32-unknown-unknown/release/dpay_canister.wasm".into());
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read canister wasm at {path}: {e}"))
}

fn setup() -> (PocketIc, Principal, SigningKey, [u8; 32], [u8; 32]) {
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));

    let payer_sk = generate_keypair();
    let payer_pk = payer_sk.verifying_key().to_bytes();
    let merch_pk = generate_keypair().verifying_key().to_bytes();

    let can = pic.create_canister();
    pic.add_cycles(can, 2_000_000_000_000);
    let init = InitArg {
        account_a: payer_pk.to_vec(),
        balance_a: INIT_A,
        account_b: merch_pk.to_vec(),
        balance_b: 0,
        per_tx_cap: CAP,
    };
    pic.install_canister(can, wasm_bytes(), encode_one(&init).unwrap(), None);
    (pic, can, payer_sk, payer_pk, merch_pk)
}

fn signed(
    sk: &SigningKey,
    from: [u8; 32],
    to: [u8; 32],
    amount: u64,
    nonce: [u8; 16],
    expiry: u64,
) -> Vec<u8> {
    let auth = Authorization { from, to, amount, nonce, expiry };
    SignedAuthorization::new(sk, auth).to_wire().to_vec()
}

fn pay(pic: &PocketIc, can: Principal, wire: Vec<u8>) -> Result<PayReceipt, String> {
    let reply = pic
        .update_call(can, Principal::anonymous(), "pay", encode_one(&wire).unwrap())
        .expect("pay update_call rejected at IC level");
    decode_one::<Result<PayReceipt, String>>(&reply).unwrap()
}

fn balance(pic: &PocketIc, can: Principal, pk: [u8; 32]) -> u64 {
    let reply = pic
        .query_call(can, Principal::anonymous(), "balance_of", encode_one(&pk.to_vec()).unwrap())
        .expect("balance_of query rejected");
    decode_one::<u64>(&reply).unwrap()
}

#[test]
fn happy_path_moves_funds() {
    let (pic, can, sk, payer, merch) = setup();
    let expiry = T0_SECS + 120;
    let r = pay(&pic, can, signed(&sk, payer, merch, 2_500, [1u8; 16], expiry))
        .expect("pay should succeed");
    assert_eq!(r.amount, 2_500);
    assert_eq!(r.new_from_balance, 7_500);
    assert_eq!(balance(&pic, can, payer), 7_500);
    assert_eq!(balance(&pic, can, merch), 2_500);
}

#[test]
fn nonce_reuse_is_rejected() {
    let (pic, can, sk, payer, merch) = setup();
    let expiry = T0_SECS + 120;
    let nonce = [7u8; 16];
    assert!(pay(&pic, can, signed(&sk, payer, merch, 1_000, nonce, expiry)).is_ok());
    let dup = pay(&pic, can, signed(&sk, payer, merch, 1_000, nonce, expiry));
    assert!(dup.is_err(), "nonce reuse must be rejected: {dup:?}");
    assert_eq!(balance(&pic, can, payer), 9_000);
    assert_eq!(balance(&pic, can, merch), 1_000);
}

#[test]
fn expired_auth_is_rejected() {
    let (pic, can, sk, payer, merch) = setup();
    let expiry = T0_SECS + 30;
    let wire = signed(&sk, payer, merch, 1_000, [9u8; 16], expiry);
    pic.advance_time(Duration::from_secs(31));
    pic.tick();
    let res = pay(&pic, can, wire);
    assert!(res.is_err(), "expired auth must be rejected: {res:?}");
    assert_eq!(balance(&pic, can, payer), 10_000);
}

#[test]
fn over_cap_is_rejected() {
    let (pic, can, sk, payer, merch) = setup();
    let expiry = T0_SECS + 120;
    let res = pay(&pic, can, signed(&sk, payer, merch, CAP + 1, [3u8; 16], expiry));
    assert!(res.is_err(), "over-cap must be rejected: {res:?}");
    assert_eq!(balance(&pic, can, payer), 10_000);
}

#[test]
fn insufficient_balance_is_rejected() {
    let (pic, can, sk, payer, merch) = setup();
    let expiry = T0_SECS + 120;
    // Under the cap, but more than the $100.00 the payer holds.
    let res = pay(&pic, can, signed(&sk, payer, merch, INIT_A + 1, [4u8; 16], expiry));
    assert!(res.is_err(), "insufficient balance must be rejected: {res:?}");
    assert_eq!(balance(&pic, can, payer), 10_000);
    assert_eq!(balance(&pic, can, merch), 0);
}
