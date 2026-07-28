//! PocketIC integration tests for the dpay canister — offline, deterministic, in seconds.
//!
//! Prereq: build the wasm first, then point `DPAY_CANISTER_WASM` at it (the justfile does this):
//!   cargo build -p dpay-canister --target wasm32-unknown-unknown --release
//! and have `POCKET_IC_BIN` set to the vendored server binary (third_party/bin/pocket-ic).

use candid::{decode_one, encode_args, encode_one, CandidType, Principal};
use dpay_core::{generate_keypair, Authorization, SignedAuthorization, Currency, DEMO_USD};
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
    let auth = Authorization { from, to, amount, nonce, expiry, currency: DEMO_USD };
    SignedAuthorization::new(sk, auth).to_wire().to_vec()
}

fn pay(pic: &PocketIc, can: Principal, wire: Vec<u8>) -> Result<PayReceipt, String> {
    let reply = pic
        .update_call(can, Principal::anonymous(), "pay", encode_one(&wire).unwrap())
        .expect("pay update_call rejected at IC level");
    decode_one::<Result<PayReceipt, String>>(&reply).unwrap()
}

fn balance(pic: &PocketIc, can: Principal, pk: [u8; 32]) -> u64 {
    balance_cur(pic, can, pk, DEMO_USD)
}

/// Balance of `pk` in an arbitrary `currency` — used to prove per-currency segregation.
fn balance_cur(pic: &PocketIc, can: Principal, pk: [u8; 32], currency: Currency) -> u64 {
    let reply = pic
        .query_call(
            can,
            Principal::anonymous(),
            "balance_of",
            encode_args((pk.to_vec(), currency)).unwrap(),
        )
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

/// The headline property of the multi-currency ledger: funds in one currency can never be spent,
/// debited, or credited as another. A balance in currency X is invisible to a payment in currency Y,
/// and vice versa. This is the only test that exercises a non-DEMO_USD currency end-to-end.
#[test]
fn balances_are_isolated_per_currency() {
    let (pic, can, sk, payer, merch) = setup();
    let other: Currency = 1; // a non-DEMO currency

    // Payer opens with INIT_A in DEMO_USD; both accounts are empty in `other`.
    assert_eq!(balance_cur(&pic, can, payer, other), 0);
    assert_eq!(balance_cur(&pic, can, merch, other), 0);

    // Faucet-mint `other` to the payer. The DEMO_USD column must not move.
    assert_eq!(
        mint_cur(&pic, can, Principal::anonymous(), payer, other, 4_000).expect("mint other ok"),
        4_000
    );
    assert_eq!(balance_cur(&pic, can, payer, other), 4_000);
    assert_eq!(balance(&pic, can, payer), INIT_A);

    // A payment *signed in `other`* draws only from the `other` column. Currency stays bound to
    // what the payer signed — the canister never crosses the wires.
    let expiry = T0_SECS + 120;
    let auth = Authorization {
        from: payer,
        to: merch,
        amount: 1_500,
        nonce: [5u8; 16],
        expiry,
        currency: other,
    };
    let wire = SignedAuthorization::new(&sk, auth).to_wire().to_vec();
    let r = pay(&pic, can, wire).expect("cross-currency-isolation pay should succeed");
    assert_eq!(r.amount, 1_500);

    // `other` moved 4000 -> 2500 (payer) / 1500 (merchant); DEMO_USD is untouched on both sides.
    assert_eq!(balance_cur(&pic, can, payer, other), 2_500);
    assert_eq!(balance_cur(&pic, can, merch, other), 1_500);
    assert_eq!(balance(&pic, can, payer), INIT_A);
    assert_eq!(balance(&pic, can, merch), 0);

    // Conversely, the payer cannot spend DEMO_USD they don't have *in DEMO_USD*, even though they
    // hold plenty of `other`. The cap check passed in DEMO_USD is on the DEMO_USD column only.
    let res = pay(&pic, can, signed(&sk, payer, merch, INIT_A + 1, [6u8; 16], expiry));
    assert!(res.is_err(), "must not draw from another currency's balance: {res:?}");
    assert_eq!(balance(&pic, can, payer), INIT_A);
    assert_eq!(balance_cur(&pic, can, payer, other), 2_500);
}

#[test]
fn upgrade_preserves_balances_and_nonces() {
    let (pic, can, sk, payer, merch) = setup();
    let expiry = T0_SECS + 120;
    let nonce = [11u8; 16];
    // Move funds and consume a nonce.
    pay(&pic, can, signed(&sk, payer, merch, 3_000, nonce, expiry)).expect("pay should succeed");
    assert_eq!(balance(&pic, can, payer), 7_000);
    assert_eq!(balance(&pic, can, merch), 3_000);

    // Upgrade with the same wasm (post_upgrade takes no args). PocketIC always performs the upgrade,
    // so pre_upgrade/post_upgrade actually run.
    pic.upgrade_canister(can, wasm_bytes(), encode_one(&()).unwrap(), None)
        .expect("upgrade should succeed");

    // Stable memory carried the state across: balances are intact (a no-stable-memory canister would
    // read back 0 here), and the spent nonce is still spent → a post-upgrade replay is refused.
    assert_eq!(balance(&pic, can, payer), 7_000);
    assert_eq!(balance(&pic, can, merch), 3_000);
    let replay = pay(&pic, can, signed(&sk, payer, merch, 3_000, nonce, expiry));
    assert!(replay.is_err(), "nonce must stay spent across upgrade: {replay:?}");
    assert_eq!(balance(&pic, can, payer), 7_000);
}

/// Set up a fresh canister with two zero-balance accounts (no pre-funding) for faucet tests.
fn setup_faucet() -> (PocketIc, Principal, [u8; 32]) {
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));
    let acct = generate_keypair().verifying_key().to_bytes();
    let other = generate_keypair().verifying_key().to_bytes();
    let can = pic.create_canister();
    pic.add_cycles(can, 2_000_000_000_000);
    let init = InitArg {
        account_a: acct.to_vec(),
        balance_a: 0,
        account_b: other.to_vec(),
        balance_b: 0,
        per_tx_cap: CAP,
    };
    pic.install_canister(can, wasm_bytes(), encode_one(&init).unwrap(), None);
    (pic, can, acct)
}

fn mint(
    pic: &PocketIc,
    can: Principal,
    sender: Principal,
    to: [u8; 32],
    amount: u64,
) -> Result<u64, String> {
    mint_cur(pic, can, sender, to, DEMO_USD, amount)
}

/// Mint in an arbitrary `currency` — used to prove per-currency segregation.
fn mint_cur(
    pic: &PocketIc,
    can: Principal,
    sender: Principal,
    to: [u8; 32],
    currency: Currency,
    amount: u64,
) -> Result<u64, String> {
    match pic.update_call(
        can,
        sender,
        "mint",
        encode_args((to.to_vec(), currency, amount)).unwrap(),
    ) {
        Ok(reply) => Ok(decode_one::<u64>(&reply).unwrap()),
        Err(e) => Err(format!("{e:?}")),
    }
}

#[test]
fn mint_open_to_anyone() {
    let (pic, can, acct) = setup_faucet();

    // The anonymous principal (what the relay uses) can mint — the faucet is open.
    assert_eq!(
        mint(&pic, can, Principal::anonymous(), acct, 5_000).expect("anonymous mint ok"),
        5_000
    );
    assert_eq!(balance(&pic, can, acct), 5_000);

    // Any other principal can mint too. The demo currency is worthless play money; this is the PoC
    // stand-in for a real on-ramp (issuer-gated minting comes when funding moves on-chain, see
    // FUNDING.md). Mints accumulate.
    let stranger = Principal::from_slice(&[8u8; 29]);
    assert_eq!(
        mint(&pic, can, stranger, acct, 1_000).expect("stranger mint ok"),
        6_000
    );
    assert_eq!(balance(&pic, can, acct), 6_000);
}

// --- transaction history ----------------------------------------------------

#[derive(CandidType, Deserialize, Debug)]
struct TxnView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    timestamp: u64,
}

/// `transactions_of(blob, nat32, nat32)` query — the canister's per-(account,currency) history,
/// newest-first. Returns the decoded view rows.
fn txns_of(pic: &PocketIc, can: Principal, pk: [u8; 32], limit: u32) -> Vec<TxnView> {
    let reply = pic
        .query_call(
            can,
            Principal::anonymous(),
            "transactions_of",
            encode_args((pk.to_vec(), DEMO_USD, limit)).unwrap(),
        )
        .expect("transactions_of query rejected");
    decode_one::<Vec<TxnView>>(&reply).unwrap()
}

/// Each settled payment is recorded in stable memory for BOTH sides (so either account's history is
/// one contiguous key range), newest-first, and survives upgrades. A rejected payment is NOT
/// recorded. This is the durable transaction list the wallet renders (the ephemeral in-memory list
/// is gone on restart; the canister is the source of truth).
#[test]
fn transactions_are_recorded_and_queryable_newest_first() {
    let (pic, can, sk, payer, merch) = setup();
    let expiry = T0_SECS + 120;
    // Two payer -> merchant payments in sequence. Using only the payer's key avoids the harness's
    // merchant-has-no-secret problem while still proving both the `from` and `to` sides are indexed.
    assert!(pay(&pic, can, signed(&sk, payer, merch, 2_500, [1u8; 16], expiry)).is_ok());
    assert!(pay(&pic, can, signed(&sk, payer, merch, 1_000, [2u8; 16], expiry)).is_ok());

    // Payer's history: newest-first => the $10.00 outgoing, then the $25.00 outgoing.
    let payer_txns = txns_of(&pic, can, payer, 10);
    assert_eq!(payer_txns.len(), 2);
    assert_eq!(payer_txns[0].amount, 1_000); // newest
    assert_eq!(payer_txns[0].from, payer.to_vec()); // outgoing: from == payer
    assert_eq!(payer_txns[0].to, merch.to_vec());
    assert_eq!(payer_txns[1].amount, 2_500); // older
    assert_eq!(payer_txns[1].from, payer.to_vec());
    assert_eq!(payer_txns[1].to, merch.to_vec());
    // Timestamps are present (the T0 second, since pay uses ic time / 1e9).
    assert!(payer_txns[0].timestamp >= T0_SECS);

    // Merchant sees the same two payments as incoming (from == payer, to == merch), newest-first.
    let merch_txns = txns_of(&pic, can, merch, 10);
    assert_eq!(merch_txns.len(), 2);
    assert_eq!(merch_txns[0].amount, 1_000);
    assert_eq!(merch_txns[0].from, payer.to_vec()); // incoming: from == payer
    assert_eq!(merch_txns[0].to, merch.to_vec());

    // limit is honored: limit=1 returns only the newest.
    assert_eq!(txns_of(&pic, can, payer, 1).len(), 1);

    // A payment that is REJECTED (e.g. over cap) is NOT recorded.
    let before = txns_of(&pic, can, payer, 10).len();
    assert!(pay(&pic, can, signed(&sk, payer, merch, CAP + 1, [9u8; 16], expiry)).is_err());
    assert_eq!(txns_of(&pic, can, payer, 10).len(), before);

    // An unknown pubkey returns an empty list (no panic).
    assert!(txns_of(&pic, can, [0u8; 32], 10).is_empty());

    // Upgrade preserves history (stable memory) — the whole point of durable-on-restart.
    pic.upgrade_canister(can, wasm_bytes(), encode_one(&()).unwrap(), None).unwrap();
    assert_eq!(txns_of(&pic, can, payer, 10).len(), 2);
    assert_eq!(txns_of(&pic, can, merch, 10).len(), 2);
}
