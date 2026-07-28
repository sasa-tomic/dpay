//! dpay-canister-icrc — the dpay ledger **with balances delegated to separate ICRC ledgers**.
//!
//! This is the same offline-pay flow as `dpay-canister`, minus one thing: it holds **no balances**.
//! Instead, every user pubkey maps to an ICRC-1 `Account { owner: <this canister>, subaccount:
//! <pubkey> }` on a separate ICRC ledger canister, and settlement is a cross-canister
//! `icrc1_transfer`. The money-critical gate — Ed25519 signature, nonce, expiry, per-tx cap —
//! stays right here, unchanged, using `dpay-core`.
//!
//! ## Multi-currency: one ledger per currency
//! The wire carries a `currency: u32`. This canister keeps a registry `currency -> {ledger
//! principal, mintable}` and resolves the ledger from the payment's currency before settling. The
//! same pubkey maps to a subaccount on **each** ledger independently, so funds in currency X
//! physically cannot be drawn by a payment naming currency Y — segregation is across *canisters*,
//! which is a stronger no-swap guarantee than the shipping canister's per-currency map key.
//!
//! Two kinds of currency:
//! - **Demo currency** (`mintable = true`): the ledger's `minting_account.owner` is THIS canister,
//!   so `mint()`/`burn()` work (transfer from / to the minting account). Play money, fenced for
//!   production exactly like the shipping `mint()` faucet.
//! - **Real ck currency** (`mintable = false`, e.g. ckBTC/ckETH/ckUSDT): dpay cannot mint or burn;
//!   funds arrive via the token's native minting/deposit path. `pay()`/`balance_of()` still work
//!   once a subaccount is funded — dpay only ever *moves* pre-funded balances.
//!
//! ## Why this shape preserves the offline-payer property
//! The payer still signs `{from, to, amount, nonce, expiry, currency}` fully offline with their
//! Ed25519 key; nothing about that path changes. The ICRC ledger is *not* asked to authorize
//! anything — its single rule ("only `from.owner` may transfer") is satisfied because the dpay
//! canister is the owner of every user subaccount, and the dpay canister only moves funds on a
//! valid offline signature. ICRC-2 `approve`/`transfer_from` (which would require the payer to be
//! online) is deliberately NOT used.
//!
//! ## Atomicity & replay safety
//! `pay()` spans cross-canister calls (`icrc1_balance_of`, `icrc1_fee`, `icrc1_transfer`), and the
//! IC **interleaves** messages at `await` points — so two concurrent `pay()` calls can run at once.
//! The replay/single-use defense is therefore the SPENT-nonce set, and the nonce is **reserved as
//! `Pending` synchronously before any transfer** (no `await` in the reserve), so a concurrent `pay`
//! with the same nonce observes it as already used and is rejected. Only after the ledger confirms
//! the transfer is the entry flipped to `Settled`. Outcomes:
//! - ledger `Ok` (or `Duplicate`, which per ICRC means "this already settled") → `Settled`, history
//!   recorded, receipt returned;
//! - genuinely transient failure (`InsufficientFunds`/`TemporarilyUnavailable`, or any pre-transfer
//!   read/validation failure — funds provably did not move) → reservation **released**, so the
//!   payer may retry the *same* nonce;
//! - any other `TransferError` → nonce stays `Settled`, so the dead authorization can never replay.
//!
//! ## Residual window & retry safety (honest)
//! Two things must hold for a retry of the same authorization to be safe:
//! 1. **Concurrent** double-spend (two `pay`s interleaved at an await) is prevented outright by
//!    the synchronous `Pending` reservation above — *proven* by `concurrent_pay_same_nonce_settles_once`.
//! 2. **Sequential retry** (relay resubmits after a reject) has a residual window: if the canister
//!    *traps* between the ledger committing `Ok` and `settle_nonce` completing, the IC rolls back
//!    this canister's message — *including the `Pending` reservation* — while the ledger's debit
//!    does NOT roll back (separate canister). A blind retry would then reserve the (now-absent)
//!    nonce and transfer again → double-spend.
//!
//! Defense-in-depth for case 2: the transfer's `created_at_time` is a **coarse quantization** of the
//! wall clock (see `dedup_created_at_time`), so retries within the same bucket share it and the
//! ledger returns `Duplicate` → the success branch → no second debit. (`memo` = nonce is unique per
//! authorization, so two *different* authorizations never falsely collide on the ledger's dedup key.)
//! This covers the common relay-retry-storm case. The **airtight** close is a reconcile that scans
//! `icrc3_get_blocks` on restart and reconciles `SPENT` against ground truth — a production item
//! (see ICRC3_INTEGRATION.md), not yet implemented. Until then the trap window is mitigated, not
//! eliminated; the dominant realistic trap source is stable-memory exhaustion in `record_txn`.
//!
//! ## What is unchanged vs. `dpay-canister`
//! The wire format, the `Ledger` trait, the relay, the app, NFC, QR — nothing above this canister's
//! candid interface changes. `pay(signed: blob) -> receipt` is the same signature. The relay posts
//! the same 196-byte wire. This file is the entire integration.

use candid::{CandidType, Nat, Principal};
use ic_cdk::call::Call;
use ic_cdk::{init, query, update};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::{TransferArg, TransferError};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;

use dpay_core::{validate, Currency, SignedAuthorization, NONCE_LEN, PUBKEY_LEN};

type Memory = VirtualMemory<DefaultMemoryImpl>;

// --- spent-nonce set: nonce -> lifecycle state --------------------------------
// A nonce moves Pending -> Settled. `Pending` means an in-flight `pay()` has reserved it (blocking
// any concurrent `pay` with the same nonce); `Settled` means the transfer committed.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
enum NonceState {
    Pending = 1,
    Settled = 2,
}
impl Storable for NonceState {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(vec![*self as u8])
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        match bytes.first().copied() {
            Some(2) => NonceState::Settled,
            _ => NonceState::Pending,
        }
    }
    const BOUND: Bound = Bound::Bounded { max_size: 1, is_fixed_size: true };
}

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

/// Reserve `nonce` as `Pending`, atomically. Returns `false` if it is already present (replay, or a
/// concurrent `pay` reserved it first). Synchronous — no `await` — so two concurrent calls cannot
/// both succeed.
fn reserve_nonce(nonce: &Nonce) -> bool {
    SPENT.with(|s| {
        let mut s = s.borrow_mut();
        if s.contains_key(nonce) {
            false
        } else {
            s.insert(nonce.clone(), NonceState::Pending);
            true
        }
    })
}

fn settle_nonce(nonce: &Nonce) {
    SPENT.with(|s| {
        s.borrow_mut().insert(nonce.clone(), NonceState::Settled);
    });
}

fn release_nonce(nonce: &Nonce) {
    SPENT.with(|s| {
        s.borrow_mut().remove(nonce);
    });
}

// --- per-currency ledger registry ------------------------------------------
// A currency resolves to the ICRC ledger that holds its balances, plus whether this canister is
// allowed to mint/burn it (demo currency only).

/// 1 mintable flag + up to 29 principal bytes.
const LEDGER_ENTRY_MAX: usize = 1 + 29;

#[derive(Clone, Copy, Debug)]
struct LedgerEntry {
    principal: Principal,
    mintable: bool,
}
impl Storable for LedgerEntry {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut v = Vec::with_capacity(1 + self.principal.as_slice().len());
        v.push(self.mintable as u8);
        v.extend_from_slice(self.principal.as_slice());
        Cow::Owned(v)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mintable = bytes.first().copied().unwrap_or(0) != 0;
        let principal = Principal::from_slice(&bytes[1..]);
        LedgerEntry { principal, mintable }
    }
    const BOUND: Bound = Bound::Bounded { max_size: LEDGER_ENTRY_MAX as u32, is_fixed_size: false };
}

/// Optional governance controller for admin ops (`mint`/`burn`/`register_ledger`). Encoded as a
/// 1-byte present flag + up to 29 principal bytes. `None` = open (demo). Production MUST set a
/// governed controller — an open admin surface lets anyone repoint a currency at a fake ledger or
/// mint unbounded demo currency (same risk class as the shipping `mint()` faucet).
#[derive(Clone, Copy, Debug)]
struct ControllerStorable(Option<Principal>);
impl Storable for ControllerStorable {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        match self.0 {
            None => Cow::Owned(vec![0u8]),
            Some(p) => {
                let mut v = Vec::with_capacity(1 + p.as_slice().len());
                v.push(1u8);
                v.extend_from_slice(p.as_slice());
                Cow::Owned(v)
            }
        }
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        match bytes.first().copied() {
            Some(1) if bytes.len() > 1 => ControllerStorable(Some(Principal::from_slice(&bytes[1..]))),
            _ => ControllerStorable(None),
        }
    }
    const BOUND: Bound = Bound::Bounded { max_size: 30, is_fixed_size: false };
}

/// Returns `Ok(())` if the caller may perform admin ops. With no controller set (the demo default)
/// every caller is allowed; with a controller set, only that principal is.
fn require_admin() -> Result<(), String> {
    let admin = CONTROLLER.with(|c| c.borrow().get().0);
    match admin {
        None => Ok(()),
        Some(a) if ic_cdk::api::msg_caller() == a => Ok(()),
        Some(_) => Err("unauthorized: admin ops require the controller principal".to_string()),
    }
}

// --- local history index (so `transactions_of` is a fast local query; the ICRC-3
//     block log is the durable source of truth and could replace this) -------

const SEQ_LEN: usize = 8;
const CURRENCY_LEN: usize = core::mem::size_of::<Currency>();
const TXN_KEY_LEN: usize = PUBKEY_LEN + CURRENCY_LEN + SEQ_LEN;

/// Sentinel "account" used as the counterparty in mint/burn history rows. A real Ed25519 pubkey is
/// a valid curve point, so this all-ones value can never be a user's pubkey — `verify_strict`
/// rejects it. Lets mint/burn appear in `transactions_of` without changing `TxnRecord`'s shape.
const MINT_ACCOUNT: [u8; PUBKEY_LEN] = [0xFF; PUBKEY_LEN];

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct AccountTxnKey([u8; TXN_KEY_LEN]);
impl AccountTxnKey {
    fn new(pubkey: [u8; PUBKEY_LEN], currency: Currency, seq: u64) -> Self {
        let mut b = [0u8; TXN_KEY_LEN];
        b[..PUBKEY_LEN].copy_from_slice(&pubkey);
        b[PUBKEY_LEN..PUBKEY_LEN + CURRENCY_LEN].copy_from_slice(&currency.to_le_bytes());
        b[PUBKEY_LEN + CURRENCY_LEN..].copy_from_slice(&seq.to_be_bytes());
        AccountTxnKey(b)
    }
}
impl Storable for AccountTxnKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut a = [0u8; TXN_KEY_LEN];
        a.copy_from_slice(&bytes);
        AccountTxnKey(a)
    }
    const BOUND: Bound = Bound::Bounded { max_size: TXN_KEY_LEN as u32, is_fixed_size: true };
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct TxnRecord {
    from: [u8; PUBKEY_LEN],
    to: [u8; PUBKEY_LEN],
    amount: u64,
    nonce: [u8; NONCE_LEN],
    currency: Currency,
    timestamp: u64,
}
const TXN_RECORD_LEN: usize = PUBKEY_LEN + PUBKEY_LEN + 8 + NONCE_LEN + 4 + 8; // 100
impl Storable for TxnRecord {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut b = [0u8; TXN_RECORD_LEN];
        b[..PUBKEY_LEN].copy_from_slice(&self.from);
        b[PUBKEY_LEN..2 * PUBKEY_LEN].copy_from_slice(&self.to);
        b[2 * PUBKEY_LEN..2 * PUBKEY_LEN + 8].copy_from_slice(&self.amount.to_le_bytes());
        b[2 * PUBKEY_LEN + 8..2 * PUBKEY_LEN + 8 + NONCE_LEN].copy_from_slice(&self.nonce);
        b[2 * PUBKEY_LEN + 8 + NONCE_LEN..2 * PUBKEY_LEN + 8 + NONCE_LEN + 4]
            .copy_from_slice(&self.currency.to_le_bytes());
        b[2 * PUBKEY_LEN + 8 + NONCE_LEN + 4..].copy_from_slice(&self.timestamp.to_le_bytes());
        Cow::Owned(b.to_vec())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let b = &bytes[..];
        let mut from = [0u8; PUBKEY_LEN];
        from.copy_from_slice(&b[..PUBKEY_LEN]);
        let mut to = [0u8; PUBKEY_LEN];
        to.copy_from_slice(&b[PUBKEY_LEN..2 * PUBKEY_LEN]);
        let amount = u64::from_le_bytes(b[2 * PUBKEY_LEN..2 * PUBKEY_LEN + 8].try_into().unwrap());
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&b[2 * PUBKEY_LEN + 8..2 * PUBKEY_LEN + 8 + NONCE_LEN]);
        let currency = u32::from_le_bytes(
            b[2 * PUBKEY_LEN + 8 + NONCE_LEN..2 * PUBKEY_LEN + 8 + NONCE_LEN + 4]
                .try_into()
                .unwrap(),
        );
        let timestamp = u64::from_le_bytes(
            b[2 * PUBKEY_LEN + 8 + NONCE_LEN + 4..].try_into().unwrap(),
        );
        TxnRecord { from, to, amount, nonce, currency, timestamp }
    }
    const BOUND: Bound = Bound::Bounded { max_size: TXN_RECORD_LEN as u32, is_fixed_size: true };
}

thread_local! {
    static MEMORY: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static SPENT: RefCell<StableBTreeMap<Nonce, NonceState, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(0)))));

    static CAP: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(1))), 0)
            .expect("init cap cell"),
    );

    static TXN_SEQ: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(2))), 0)
            .expect("init txn seq cell"),
    );

    static ACCOUNT_TXNS: RefCell<StableBTreeMap<AccountTxnKey, TxnRecord, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(3)))));

    // currency -> {ledger principal, mintable}. MemoryId 4 (was the single-ledger cell).
    static LEDGERS: RefCell<StableBTreeMap<Currency, LedgerEntry, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(4)))));

    // optional governance controller for admin ops. MemoryId 5.
    static CONTROLLER: RefCell<StableCell<ControllerStorable, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(5))), ControllerStorable(None))
            .expect("init controller cell"),
    );
}

/// Configuration for one currency, supplied at init (and via `register_ledger`).
#[derive(CandidType, Deserialize)]
struct LedgerConfig {
    currency: Currency,
    principal: Principal,
    /// `true` for the demo currency whose ledger `minting_account.owner` is this canister
    /// (so `mint`/`burn` are allowed). `false` for real ck currencies — dpay only moves funds.
    mintable: bool,
}

#[derive(CandidType, Deserialize)]
struct InitArg {
    ledgers: Vec<LedgerConfig>,
    per_tx_cap: u64,
    /// Governance principal permitted to call `mint`/`burn`/`register_ledger`. `null` = open (the
    /// demo default). Production MUST set a governed controller.
    controller: Option<Principal>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct TxnView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    timestamp: u64,
}

#[init]
fn init(arg: InitArg) {
    CAP.with(|c| c.borrow_mut().set(arg.per_tx_cap).expect("set cap"));
    CONTROLLER
        .with(|c| c.borrow_mut().set(ControllerStorable(arg.controller)).expect("set controller"));
    LEDGERS.with(|m| {
        let mut m = m.borrow_mut();
        for c in arg.ledgers {
            m.insert(c.currency, LedgerEntry { principal: c.principal, mintable: c.mintable });
        }
    });
}

/// Resolve a currency to its ledger principal + mintability. Unknown currency -> hard reject.
fn ledger_for(currency: Currency) -> Result<(Principal, bool), String> {
    LEDGERS.with(|m| m.borrow().get(&currency))
        .map(|e| (e.principal, e.mintable))
        .ok_or_else(|| format!("unknown currency {currency}"))
}

/// The ICRC account this canister controls for a user pubkey: the canister is the `owner`, the
/// 32-byte Ed25519 pubkey is the `subaccount`. The pubkey is already exactly 32 bytes (Ed25519), so
/// it slots in directly — no hashing/derivation needed. Identical on every ledger.
fn account_of(pk: &[u8; PUBKEY_LEN]) -> Account {
    Account { owner: ic_cdk::api::canister_self(), subaccount: Some(*pk) }
}

fn to_pubkey(v: &[u8]) -> Result<[u8; PUBKEY_LEN], String> {
    v.try_into().map_err(|_| "bad pubkey length".to_string())
}

fn nat_to_u64(n: &Nat) -> Result<u64, String> {
    num_traits::ToPrimitive::to_u64(&n.0).ok_or_else(|| "nat overflows u64".to_string())
}

/// Cross-canister `icrc1_balance_of` (query). Returns the live ledger balance in minor units.
async fn ledger_balance_of(ledger: Principal, a: &Account) -> Result<u64, String> {
    let response = Call::bounded_wait(ledger, "icrc1_balance_of")
        .with_arg(a.clone())
        .await
        .map_err(|e| format!("icrc1_balance_of rejected: {e:?}"))?;
    let balance: Nat = response
        .candid()
        .map_err(|e| format!("icrc1_balance_of decode: {e:?}"))?;
    nat_to_u64(&balance).map_err(|_| "ledger balance overflows u64".to_string())
}

/// Cross-canister `icrc1_fee` (query). Each ck ledger sets its own fee, so it is read per payment
/// rather than cached — a ckBTC payment must carry ckBTC's fee, not zero.
async fn ledger_fee(ledger: Principal) -> Result<u64, String> {
    let response = Call::bounded_wait(ledger, "icrc1_fee")
        .await
        .map_err(|e| format!("icrc1_fee rejected: {e:?}"))?;
    let fee: Nat = response.candid().map_err(|e| format!("icrc1_fee decode: {e:?}"))?;
    nat_to_u64(&fee)
}

/// Cross-canister `icrc1_transfer`. The canister (as `from.owner`) is authorized by the ledger's
/// single-owner rule; the offline Ed25519 gate is enforced by `pay` before this is reached.
async fn ledger_transfer(ledger: Principal, arg: TransferArg) -> Result<Nat, TransferError> {
    let response = match Call::bounded_wait(ledger, "icrc1_transfer")
        .with_arg(arg)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Err(TransferError::GenericError {
                error_code: Nat::from(503u64),
                message: format!("icrc1_transfer rejected: {e:?}"),
            });
        }
    };
    response.candid::<Result<Nat, TransferError>>().map_err(|e| {
        TransferError::GenericError {
            error_code: Nat::from(502u64),
            message: format!("icrc1_transfer decode: {e:?}"),
        }
    })?
}

/// `created_at_time` for a `pay` transfer, quantized to a coarse bucket. The ICRC ledger dedups
/// transfers whose `(from_subaccount, to, amount, fee, created_at_time, memo)` all match; `memo` is
/// the nonce (unique per authorization), so distinct authorizations never collide. Quantizing the
/// timestamp makes a *retry of the same authorization* (same nonce → same memo) within one bucket
/// share `created_at_time`, so the ledger returns `Duplicate` → our success branch → no second debit.
/// The bucket is small enough that the timestamp is never `TooOld` (always within ~`BUCKET` of now).
/// This is defense-in-depth for the relay-retry path; the airtight close is the icrc3 reconcile.
const DEDUP_BUCKET_SECS: u64 = 60;
fn dedup_created_at_time() -> u64 {
    let now_ns = ic_cdk::api::time();
    let bucket_ns = DEDUP_BUCKET_SECS * 1_000_000_000;
    (now_ns / bucket_ns) * bucket_ns
}

/// Settle an offline-signed authorization. Same signature as `dpay-canister::pay`; balances are
/// moved on the ICRC ledger named by the payment's currency, not here.
#[update]
async fn pay(signed: Vec<u8>) -> Result<PayReceipt, String> {
    let sa = SignedAuthorization::from_wire(&signed).map_err(|e| format!("decode: {e:?}"))?;
    let sig_ok = sa.verify();
    // Reject a bad signature BEFORE touching the nonce set, so an attacker cannot reserve (and
    // briefly block) a nonce they extracted from a garbled blob.
    if !sig_ok {
        return Err(format!("{:?}", dpay_core::PayError::BadSignature));
    }
    let now_secs = ic_cdk::api::time() / 1_000_000_000;

    let currency = sa.auth.currency;
    let from = sa.auth.from;
    let to = sa.auth.to;
    let amount = sa.auth.amount;
    let nonce = Nonce(sa.auth.nonce);

    // Cheap local rejects — DoS hygiene before any cross-canister call (which costs the canister
    // cycles). `dpay-core::validate` is still the authoritative check after the balance read; this
    // just filters obviously-dead auths cheaply. An attacker CAN craft a passing auth (amount=1,
    // valid expiry) to force a balance read — the airtight fix is cycles-acceptance / per-caller
    // rate-limiting, a production item.
    if amount == 0 {
        return Err("zero amount".to_string());
    }
    if from == to {
        return Err("self transfer".to_string());
    }
    if sa.auth.expiry < now_secs {
        return Err("expired".to_string());
    }
    let cap = CAP.with(|c| *c.borrow().get());
    if amount > cap {
        return Err("over cap".to_string());
    }

    let (_ledger, _mintable) = ledger_for(currency)?;
    let ledger = _ledger;
    let from_acct = account_of(&from);
    let to_acct = account_of(&to);

    // Reserve the nonce synchronously (no await) — this is the concurrency barrier. A concurrent
    // `pay` with the same nonce observes it as used and is rejected at this point.
    if !reserve_nonce(&nonce) {
        return Err("nonce already used".to_string());
    }

    // Everything below may `await`; on any pre-transfer failure we RELEASE the reservation so the
    // payer can retry the same nonce (funds provably did not move).
    let balance = match ledger_balance_of(ledger, &from_acct).await {
        Ok(b) => b,
        Err(e) => {
            release_nonce(&nonce);
            return Err(e);
        }
    };

    // dpay-core policy: expiry, per-tx cap, sufficient funds. nonce_already_seen=false because we
    // just reserved it fresh; sig_ok=true (checked above). The cheap checks above already rejected
    // the common dead-auth cases; this is the authoritative gate (incl. balance sufficiency).
    if let Err(e) = validate(&sa.auth, now_secs, cap, balance, false, true) {
        release_nonce(&nonce);
        return Err(format!("{e:?}"));
    }

    let fee = match ledger_fee(ledger).await {
        Ok(f) => f,
        Err(e) => {
            release_nonce(&nonce);
            return Err(e);
        }
    };
    // Fee-aware sufficiency, overflow-safe. `validate` proved amount <= balance; this additionally
    // proves amount+fee <= balance. Best-effort pre-check — the ledger is the authority.
    let needed = match amount.checked_add(fee) {
        Some(n) => n,
        None => {
            release_nonce(&nonce);
            return Err("amount+fee overflow".to_string());
        }
    };
    if needed > balance {
        release_nonce(&nonce);
        return Err(format!("{:?}", TransferError::InsufficientFunds { balance: Nat::from(balance) }));
    }

    // Move the funds on the ICRC ledger. `memo` = nonce (unique per authorization); `fee` read
    // from the ledger; `created_at_time` quantized (see `dedup_created_at_time`) so a retry of THIS
    // authorization within the dedup bucket hits the ledger's `Duplicate` → success, not a 2nd debit.
    let transfer_arg = TransferArg {
        from_subaccount: Some(from),
        to: to_acct,
        fee: Some(Nat::from(fee)),
        created_at_time: Some(dedup_created_at_time()),
        memo: Some(sa.auth.nonce.to_vec().into()),
        amount: Nat::from(amount),
    };
    match ledger_transfer(ledger, transfer_arg).await {
        // Success (or Duplicate, which per ICRC means "already settled at this block") → commit the
        // nonce and record history. Funds provably moved (or had already moved).
        Ok(_) | Err(TransferError::Duplicate { .. }) => {
            settle_nonce(&nonce);
            record_txn(from, to, amount, sa.auth.nonce, currency, now_secs);
            // Re-read the ledger balance so the receipt reflects ground truth (the pre-transfer
            // read is stale under concurrent settlement).
            let new_from_balance =
                ledger_balance_of(ledger, &from_acct).await.unwrap_or_else(|_| {
                    balance.saturating_sub(amount).saturating_sub(fee)
                });
            Ok(PayReceipt {
                from: from.to_vec(),
                to: to.to_vec(),
                amount,
                nonce: sa.auth.nonce.to_vec(),
                new_from_balance,
            })
        }
        // Genuinely transient — funds provably did not move, or the ledger is unsure. Release so the
        // payer may retry the SAME nonce.
        Err(TransferError::InsufficientFunds { .. }) | Err(TransferError::TemporarilyUnavailable) => {
            release_nonce(&nonce);
            Err(format!("transient: {:?}", "ledger busy/insufficient"))
        }
        // Any other ledger error is not safe to retry blindly — burn the nonce so the dead auth can
        // never replay. The payer must obtain a fresh authorization.
        Err(e) => {
            settle_nonce(&nonce);
            Err(format!("ledger transfer: {e:?}"))
        }
    }
}

fn record_txn(
    from: [u8; PUBKEY_LEN],
    to: [u8; PUBKEY_LEN],
    amount: u64,
    nonce: [u8; NONCE_LEN],
    currency: Currency,
    timestamp: u64,
) {
    let seq = TXN_SEQ.with(|c| {
        let v = *c.borrow().get();
        c.borrow_mut().set(v + 1).expect("advance txn seq");
        v
    });
    let rec = TxnRecord { from, to, amount, nonce, currency, timestamp };
    ACCOUNT_TXNS.with(|m| {
        let mut m = m.borrow_mut();
        m.insert(AccountTxnKey::new(from, currency, seq), rec);
        m.insert(AccountTxnKey::new(to, currency, seq), rec);
    });
}

/// `balance_of(blob, nat32) -> nat64`. An **update** (not a query): it must call the ledger, and
/// ICRC queries cannot be issued from a canister `#[query]`. The currency selects which ledger.
#[update]
async fn balance_of(pubkey: Vec<u8>, currency: Currency) -> u64 {
    let pk = match to_pubkey(&pubkey) {
        Ok(p) => p,
        Err(_) => return 0,
    };
    let ledger = match ledger_for(currency) {
        Ok((l, _)) => l,
        Err(_) => return 0,
    };
    ledger_balance_of(ledger, &account_of(&pk)).await.unwrap_or(0)
}

/// `mint(blob, nat32, nat64) -> nat64` — fund a user on a DEMO currency by transferring from the
/// ledger's minting account. Requires the ledger's `minting_account.owner` to be THIS canister
/// (configured at ledger init) and the currency to be registered `mintable`. Real ck currencies
/// (ckBTC, …) are not mintable — they arrive via the token's native minting path, not here. Same
/// `(blob, nat32, nat64) -> nat64` shape as `dpay-canister::mint`. Gated to the controller in
/// production (open only when `controller` is unset, i.e. the demo).
#[update]
async fn mint(to: Vec<u8>, currency: Currency, amount: u64) -> Result<u64, String> {
    require_admin()?;
    let pk = to_pubkey(&to)?;
    let (ledger, mintable) = ledger_for(currency)?;
    if !mintable {
        return Err(format!("currency {currency} is not mintable"));
    }
    let arg = TransferArg {
        from_subaccount: None, // the minting account's default subaccount
        to: account_of(&pk),
        amount: Nat::from(amount),
        fee: None, // mints carry no fee
        created_at_time: Some(ic_cdk::api::time()),
        memo: None,
    };
    let block_index = ledger_transfer(ledger, arg).await.map_err(|e| format!("mint transfer: {e:?}"))?;
    let now_secs = ic_cdk::api::time() / 1_000_000_000;
    record_txn(MINT_ACCOUNT, pk, amount, [0u8; NONCE_LEN], currency, now_secs);
    Ok(nat_to_u64(&block_index)?)
}

/// `burn(blob, nat32, nat64) -> nat64` — destroy DEMO currency by transferring it back to the
/// ledger's minting account (the ICRC convention: a transfer to the minting account is a burn).
/// Only demo (`mintable`) currencies can be burned; real ck currencies cannot. Symmetric to `mint`;
/// same controller gating applies.
#[update]
async fn burn(from: Vec<u8>, currency: Currency, amount: u64) -> Result<u64, String> {
    require_admin()?;
    let pk = to_pubkey(&from)?;
    let (ledger, mintable) = ledger_for(currency)?;
    if !mintable {
        return Err(format!("currency {currency} is not burnable"));
    }
    let from_acct = account_of(&pk);
    let balance = ledger_balance_of(ledger, &from_acct).await?;
    let fee = ledger_fee(ledger).await?;
    let needed = amount.checked_add(fee).ok_or("amount+fee overflow")?;
    if needed > balance {
        return Err("insufficient funds to burn".to_string());
    }
    let arg = TransferArg {
        from_subaccount: Some(pk),
        to: Account { owner: ic_cdk::api::canister_self(), subaccount: None }, // minting account
        amount: Nat::from(amount),
        fee: Some(Nat::from(fee)),
        created_at_time: Some(ic_cdk::api::time()),
        memo: None,
    };
    let block_index = ledger_transfer(ledger, arg).await.map_err(|e| format!("burn transfer: {e:?}"))?;
    let now_secs = ic_cdk::api::time() / 1_000_000_000;
    record_txn(pk, MINT_ACCOUNT, amount, [0u8; NONCE_LEN], currency, now_secs);
    Ok(nat_to_u64(&block_index)?)
}

/// Register or replace the ledger for a currency at runtime. Gated to the controller in production
/// (open only when `controller` is unset, i.e. the demo). A malicious caller repointing a currency
/// at a ledger it controls is the same risk class as the open `mint()` faucet — see
/// CODEBASE_ANALYSIS.md. Production must set a controller at init.
#[update]
fn register_ledger(currency: Currency, principal: Principal, mintable: bool) -> Result<(), String> {
    require_admin()?;
    LEDGERS.with(|m| {
        m.borrow_mut().insert(currency, LedgerEntry { principal, mintable });
    });
    Ok(())
}

/// Rotate the governance principal for `mint`/`burn`/`register_ledger`/`set_controller`. Governed by
/// the current controller: in the open-demo mode (no controller set) any caller may set one — which
/// is exactly how a fresh deployment is locked down; once a controller is set, only it can rotate.
/// (Note: this gates admin *methods* only. The IC-level canister controller — who can `install_code`
/// / upgrade — is a separate concern set via `dfx`/NNS/SNS, flagged in CODEBASE_ANALYSIS.md.)
#[update]
fn set_controller(new: Option<Principal>) -> Result<(), String> {
    require_admin()?;
    CONTROLLER
        .with(|c| c.borrow_mut().set(ControllerStorable(new)).expect("set controller"));
    Ok(())
}

#[query]
fn per_tx_cap() -> u64 {
    CAP.with(|c| *c.borrow().get())
}

/// Newest-first history for a (pubkey, currency) pair. O(limit): the underlying `range` iterator is
/// double-ended, so `.rev().take(limit)` walks from the newest end and stops early — it does NOT
/// materialize the whole history. `limit == 0` returns no rows.
#[query]
fn transactions_of(pubkey: Vec<u8>, currency: Currency, limit: u32) -> Vec<TxnView> {
    let pk = match to_pubkey(&pubkey) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let start = AccountTxnKey::new(pk, currency, 0u64);
    let end = AccountTxnKey::new(pk, currency, u64::MAX);
    ACCOUNT_TXNS.with(|m| {
        m.borrow()
            .range(start..=end)
            .rev()
            .take(limit as usize)
            .map(|(_, r)| TxnView {
                from: r.from.to_vec(),
                to: r.to.to_vec(),
                amount: r.amount,
                nonce: r.nonce.to_vec(),
                currency: r.currency,
                timestamp: r.timestamp,
            })
            .collect()
    })
}

ic_cdk::export_candid!();
