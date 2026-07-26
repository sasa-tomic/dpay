//! dpay demo ledger canister.
//!
//! Holds two pre-funded accounts, verifies an offline-signed [`SignedAuthorization`], enforces
//! nonce/expiry/cap/balance via `dpay-core`, and moves funds atomically.
//!
//! State lives in **stable structures** ([`StableBTreeMap`] / [`StableCell`]) backed by stable
//! memory, so it survives canister upgrades automatically — no `pre_upgrade`/`post_upgrade`
//! serialization, and the ledger can grow past the heap. The canister is single-threaded and no
//! message awaits, so the read-check-write in [`pay`] runs atomically.
//!
//! Money-critical logic lives in `dpay-core` (shared with the relay, app, and tests) — the canister
//! is state + candid glue.

use candid::CandidType;
use ic_cdk::{init, query, update};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;

use dpay_core::{validate, SignedAuthorization, NONCE_LEN, PUBKEY_LEN};

type Memory = VirtualMemory<DefaultMemoryImpl>;

/// Stable-map key for a 32-byte account pubkey. Fixed size, and its byte order equals the derived
/// `Ord`, so map iteration order is well-defined.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct PubKey([u8; PUBKEY_LEN]);

impl Storable for PubKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut a = [0u8; PUBKEY_LEN];
        a.copy_from_slice(&bytes);
        PubKey(a)
    }
    const BOUND: Bound = Bound::Bounded { max_size: PUBKEY_LEN as u32, is_fixed_size: true };
}

/// Stable-map key for a 16-byte nonce.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Nonce([u8; NONCE_LEN]);

impl Storable for Nonce {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut a = [0u8; NONCE_LEN];
        a.copy_from_slice(&bytes);
        Nonce(a)
    }
    const BOUND: Bound = Bound::Bounded { max_size: NONCE_LEN as u32, is_fixed_size: true };
}

thread_local! {
    static MEMORY: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    /// account pubkey -> balance (minor units).
    static BALANCES: RefCell<StableBTreeMap<PubKey, u64, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(0)))));

    /// spent nonces (single-use). Value is `()` — the map is used as a set.
    static SPENT: RefCell<StableBTreeMap<Nonce, (), Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(1)))));

    /// per-transaction spending cap (minor units).
    static CAP: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(2))), 0).expect("init cap cell"),
    );
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
    BALANCES.with(|m| {
        let mut m = m.borrow_mut();
        m.insert(PubKey(a), arg.balance_a);
        m.insert(PubKey(b), arg.balance_b);
    });
    CAP.with(|c| c.borrow_mut().set(arg.per_tx_cap).expect("set cap"));
}

/// Settle an offline-signed authorization. `signed` is the 192-byte wire form. Reads, validates, and
/// commits within one (non-awaiting) message → atomic on the single-threaded canister.
#[update]
fn pay(signed: Vec<u8>) -> Result<PayReceipt, String> {
    let sa = SignedAuthorization::from_wire(&signed).map_err(|e| format!("decode: {e:?}"))?;
    let sig_ok = sa.verify();
    // dpay-core works in unix seconds; IC time is nanoseconds.
    let now_secs = ic_cdk::api::time() / 1_000_000_000;

    let from = PubKey(sa.auth.from);
    let nonce = Nonce(sa.auth.nonce);

    let balance = BALANCES.with(|b| b.borrow().get(&from).unwrap_or(0));
    let nonce_seen = SPENT.with(|s| s.borrow().contains_key(&nonce));
    let cap = CAP.with(|c| *c.borrow().get());

    validate(&sa.auth, now_secs, cap, balance, nonce_seen, sig_ok).map_err(|e| format!("{e:?}"))?;

    let new_from = balance - sa.auth.amount;
    BALANCES.with(|b| {
        let mut b = b.borrow_mut();
        b.insert(from, new_from);
        let to = PubKey(sa.auth.to);
        let to_bal = b.get(&to).unwrap_or(0) + sa.auth.amount;
        b.insert(to, to_bal);
    });
    SPENT.with(|s| {
        s.borrow_mut().insert(nonce, ());
    });

    Ok(PayReceipt {
        from: sa.auth.from.to_vec(),
        to: sa.auth.to.to_vec(),
        amount: sa.auth.amount,
        nonce: sa.auth.nonce.to_vec(),
        new_from_balance: new_from,
    })
}

#[query]
fn balance_of(pubkey: Vec<u8>) -> u64 {
    match to_pubkey(&pubkey) {
        Ok(pk) => BALANCES.with(|b| b.borrow().get(&PubKey(pk)).unwrap_or(0)),
        Err(_) => 0,
    }
}

#[query]
fn per_tx_cap() -> u64 {
    CAP.with(|c| *c.borrow().get())
}

/// Credit `to` with `amount` (minor units) and return the new balance — the demo's stand-in for a
/// real fiat/ckUSDC on-ramp. **Controller-only**: any non-controller caller (including the anonymous
/// principal the relay uses) is rejected. Gating on `is_controller` grants no new power — a
/// controller can already upgrade the canister to do anything — while closing the "anyone can mint"
/// hole. When funding moves to on-chain top-ups, this becomes issuer-gated (see FUNDING.md).
#[update]
fn mint(to: Vec<u8>, amount: u64) -> u64 {
    let caller = ic_cdk::api::msg_caller();
    if !ic_cdk::api::is_controller(&caller) {
        ic_cdk::trap(format!(
            "unauthorized: only a canister controller may mint (caller {caller})"
        ));
    }
    let pk = PubKey(to_pubkey(&to).expect("account must be 32 bytes"));
    BALANCES.with(|b| {
        let mut b = b.borrow_mut();
        let new = b.get(&pk).unwrap_or(0).saturating_add(amount);
        b.insert(pk, new);
        new
    })
}

ic_cdk::export_candid!();
