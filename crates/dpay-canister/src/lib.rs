//! dpay demo ledger canister.
//!
//! Holds two pre-funded accounts, verifies an offline-signed [`SignedAuthorization`], enforces
//! nonce/expiry/cap/balance via `dpay-core`, and moves funds atomically. The canister is
//! single-threaded, so the read-check-write in [`pay`] is genuinely atomic.
//!
//! Money-critical logic lives in `dpay-core` (shared with the relay, app, and tests) — the
//! canister is just state + candid glue.

use candid::CandidType;
use ic_cdk::{init, query, update};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use dpay_core::{validate, SignedAuthorization, NONCE_LEN, PUBKEY_LEN};

#[derive(Default)]
struct Ledger {
    balances: HashMap<[u8; PUBKEY_LEN], u64>,
    spent: HashSet<[u8; NONCE_LEN]>,
    per_tx_cap: u64,
}

thread_local! {
    static LEDGER: RefCell<Ledger> = RefCell::new(Ledger::default());
}

/// Init argument: two demo accounts (32-byte Ed25519 pubkeys as `blob`), their opening balances,
/// and a per-transaction spending cap (minor units).
#[derive(CandidType, Deserialize)]
struct InitArg {
    account_a: Vec<u8>,
    balance_a: u64,
    account_b: Vec<u8>,
    balance_b: u64,
    per_tx_cap: u64,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
}

fn to_pubkey(v: &[u8]) -> Result<[u8; PUBKEY_LEN], String> {
    v.try_into().map_err(|_| "bad pubkey length".to_string())
}

#[init]
fn init(arg: InitArg) {
    let a = to_pubkey(&arg.account_a).expect("account_a must be 32 bytes");
    let b = to_pubkey(&arg.account_b).expect("account_b must be 32 bytes");
    LEDGER.with(|l| {
        let mut l = l.borrow_mut();
        l.balances.insert(a, arg.balance_a);
        l.balances.insert(b, arg.balance_b);
        l.per_tx_cap = arg.per_tx_cap;
    });
}

/// Settle an offline-signed authorization. `signed` is the 192-byte wire form.
#[update]
fn pay(signed: Vec<u8>) -> Result<PayReceipt, String> {
    let sa = SignedAuthorization::from_wire(&signed).map_err(|e| format!("decode: {e:?}"))?;
    let sig_ok = sa.verify();
    // dpay-core works in unix seconds; IC time is nanoseconds.
    let now_secs = ic_cdk::api::time() / 1_000_000_000;

    LEDGER.with(|l| {
        let mut l = l.borrow_mut();
        let from = sa.auth.from;
        let balance = *l.balances.get(&from).unwrap_or(&0);
        let nonce_seen = l.spent.contains(&sa.auth.nonce);
        let cap = l.per_tx_cap;

        validate(&sa.auth, now_secs, cap, balance, nonce_seen, sig_ok)
            .map_err(|e| format!("{e:?}"))?;

        // Commit atomically (single-threaded canister).
        let new_from = balance - sa.auth.amount;
        l.balances.insert(from, new_from);
        *l.balances.entry(sa.auth.to).or_insert(0) += sa.auth.amount;
        l.spent.insert(sa.auth.nonce);

        Ok(PayReceipt {
            from: from.to_vec(),
            to: sa.auth.to.to_vec(),
            amount: sa.auth.amount,
            nonce: sa.auth.nonce.to_vec(),
            new_from_balance: new_from,
        })
    })
}

#[query]
fn balance_of(pubkey: Vec<u8>) -> u64 {
    match to_pubkey(&pubkey) {
        Ok(pk) => LEDGER.with(|l| *l.borrow().balances.get(&pk).unwrap_or(&0)),
        Err(_) => 0,
    }
}

#[query]
fn per_tx_cap() -> u64 {
    LEDGER.with(|l| l.borrow().per_tx_cap)
}

/// Demo faucet: credit `to` with `amount` (minor units) and return the new balance. Lets a phone
/// fund a freshly-generated on-device account. Unauthenticated on purpose — this is the demo's
/// stand-in for a real fiat/ckUSDC on-ramp, which is out of scope; a production ledger would gate
/// minting behind the issuer.
#[update]
fn mint(to: Vec<u8>, amount: u64) -> u64 {
    let pk = to_pubkey(&to).expect("account must be 32 bytes");
    LEDGER.with(|l| {
        let mut l = l.borrow_mut();
        let bal = l.balances.entry(pk).or_insert(0);
        *bal = bal.saturating_add(amount);
        *bal
    })
}

ic_cdk::export_candid!();
