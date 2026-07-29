//! dpay payment canister — a pure **facade** over external ICRC ledgers.
//!
//! This canister holds **no balances**. It has exactly three jobs plus the offline-payer
//! authorization gate:
//!
//! 1. **index** — a registry `currency(u32) -> {ledger principal, mintable}` (`LEDGERS`), populated
//!    at init and extendable at runtime via `register_ledger`.
//! 2. **routing** — `pay()` resolves the wire's `currency` to its ledger and settles there.
//! 3. **cache** — a fast display-only read path (`BAL_CACHE`) backs the `balance_of` *query*.
//!
//! PLUS the **authorization gate** (Ed25519 sig verify + nonce replay protection + expiry/cap),
//! which stays *here* — that is the offline-payer value-add, not ledger logic. The real ICRC
//! ledgers (one per currency) are the source of truth; the facade routes every payment through the
//! one uniform ICRC interface (`icrc1_transfer` / `icrc1_balance_of` / `icrc1_fee`).
//!
//! ## Money-safety rule
//! `pay()` ALWAYS reads the AUTHORITATIVE ledger balance (`icrc1_balance_of`) before transferring.
//! The cache is DISPLAY-ONLY — a stale cache (someone transferred directly on the ledger) can only
//! make a shown number wrong, never cause a bad settlement. The cache is refreshed (re-read from the
//! ledger) after every successful `pay` / `mint` / `burn`.
//!
//! ## Atomicity & replay safety (cross-canister `await`s)
//! `pay()` spans cross-canister calls, and the IC interleaves messages at `await` points — so two
//! concurrent `pay()` calls can run at once. The replay/single-use defense is the SPENT-nonce set,
//! and the nonce is **reserved synchronously before any transfer** (no `await` in the reserve), so a
//! concurrent `pay` with the same nonce observes it as already used and is rejected. Outcomes after
//! the reservation:
//! - ledger `Ok` (or `Duplicate`, which per ICRC means "already settled") → nonce stays spent,
//!   history recorded, receipt returned;
//! - genuinely transient failure (`InsufficientFunds`/`TemporarilyUnavailable`, or any pre-transfer
//!   read/validation failure — funds provably did not move) → reservation **released**, so the payer
//!   may retry the *same* nonce;
//! - any other `TransferError` → nonce stays spent, so the dead authorization can never replay.
//!
//! Defense-in-depth for the sequential-retry path: the transfer's `created_at_time` is a coarse
//! quantization of the wall clock (see `dedup_created_at_time`), so retries within the same bucket
//! share it and the ledger returns `Duplicate` → the success branch → no second debit.
//!
//! ## Stable-memory layout (upgrade compatibility)
//! State lives in stable structures so it survives upgrades automatically. The layout preserves the
//! pre-facade shipping canister's `SPENT` (MemoryId 1), `CAP` (2), `TXN_SEQ` (3), and `ACCOUNT_TXNS`
//! (4) at the *same* MemoryIds and types, so the upgrade of an existing deployment keeps nonces +
//! history. The legacy internal `BALANCES` (MemoryId 0) is abandoned — its entries were orphaned
//! play money. New facade state uses fresh MemoryIds: `LEDGERS` (5), `CONTROLLER` (6), `BAL_CACHE`
//! (7). NB: `SPENT` keeps the legacy value type `()` (a set) rather than the ICRC demo's 1-byte
//! `NonceState`; the Pending/Settled distinction was informational only (`contains_key` is the sole
//! read), and reusing the same MemoryId with a different value size would corrupt the B-tree on
//! upgrade. The full reserve/release/settle *safety* is preserved with set semantics.
//!
//! Money-critical logic (sig verify, validation) lives in `dpay-core` (shared with the relay, app,
//! and tests); this file is state + candid glue + cross-canister settlement.

use candid::{CandidType, Nat, Principal};
use ic_cdk::api::{canister_self, msg_caller, time};
use ic_cdk::call::Call;
use ic_cdk::management_canister::{
    create_canister_with_extra_cycles, CanisterIdRecord, CanisterSettings, CreateCanisterArgs,
};
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

// --- spent-nonce set: nonce -> () -------------------------------------------------------------
// A nonce in the map means "reserved or settled" — either way, a concurrent/replay `pay` with the
// same nonce is rejected (`contains_key`). `reserve` inserts (synchronous, before any await);
// `release` removes (on a transient failure, so the payer may retry); `settle` is a no-op (the
// entry is already present). See the module docs for why this is a set, not the ICRC demo's
// Pending/Settled enum (upgrade-layout compatibility).

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

/// Reserve `nonce`, atomically. Returns `false` if it is already present (replay, or a concurrent
/// `pay` reserved it first). Synchronous — no `await` — so two concurrent calls cannot both succeed.
fn reserve_nonce(nonce: &Nonce) -> bool {
    SPENT.with(|s| {
        let mut s = s.borrow_mut();
        if s.contains_key(nonce) {
            false
        } else {
            s.insert(nonce.clone(), ());
            true
        }
    })
}

/// Mark `nonce` as settled. With set semantics this is a no-op (the reservation already inserted
/// it); kept as a named call site so the settle/release intent reads clearly at each `pay` branch.
fn settle_nonce(nonce: &Nonce) {
    SPENT.with(|s| {
        s.borrow_mut().insert(nonce.clone(), ());
    });
}

/// Release a reservation so the payer may retry the SAME nonce. Used only when funds provably did
/// not move (transient/pre-transfer failures).
fn release_nonce(nonce: &Nonce) {
    SPENT.with(|s| {
        s.borrow_mut().remove(nonce);
    });
}

// --- per-currency ledger registry -------------------------------------------------------------
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

/// Optional governance controller for admin ops (`mint`/`burn`/`register_ledger`/`set_controller`).
/// Encoded as a 1-byte present flag + up to 29 principal bytes. `None` = open (demo). Production MUST
/// set a governed controller — an open admin surface lets anyone repoint a currency at a fake ledger
/// or mint unbounded demo currency.
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

/// Returns `Ok(())` if the caller may perform governance admin ops (mint/burn/register_ledger/
/// set_controller). With no controller set (the demo default) every caller is allowed; with a
/// controller set, only that principal is.
fn require_admin() -> Result<(), String> {
    let admin = CONTROLLER.with(|c| c.borrow().get().0);
    match admin {
        None => Ok(()),
        Some(a) if msg_caller() == a => Ok(()),
        Some(_) => Err("unauthorized: admin ops require the controller principal".to_string()),
    }
}

/// Principals permitted to spend THIS canister's cycles to provision new canisters (the
/// `provision_ledger_canister` op). This is the dpay deploy identity (which holds no cycles wallet
/// of its own, so the only cycles available live inside this canister). Rotate to an SNS/governance
/// principal before any production use beyond one-off ledger provisioning. Parsed from text at call
/// time — the list is tiny. Distinct from the governance `require_admin` controller: provisioning is
/// an ops/cycles function, kept on a fixed operator allowlist so the operator can always provision
/// regardless of the governance controller.
const ADMIN_CALLERS: &[&str] = &[
    "hhwti-hb7f7-4ojco-uvazw-vcwr7-fqd6o-3oljb-aezpo-iheay-3gxmx-rqe", // dfx identity `dpay`
    "fa3em-tedlx-wlrze-3q7nk-lx4l5-vomns-qdkcm-i6r5f-3pttd-xxwfu-jae", // historical deploy controller
];

fn require_operator() -> Result<(), String> {
    let caller = msg_caller();
    let ok = ADMIN_CALLERS
        .iter()
        .any(|t| Principal::from_text(t).map(|p| p == caller).unwrap_or(false));
    if ok {
        Ok(())
    } else {
        Err(format!("unauthorized operator caller: {caller}"))
    }
}

// --- display-only balance cache ---------------------------------------------------------------
// Backs the fast `balance_of` *query*. Refreshed (re-read from the authoritative ledger) after every
// successful pay/mint/burn. A stale entry can only make a *displayed* number wrong — settlement
// always reads the ledger directly, never this cache.

const CURRENCY_LEN: usize = core::mem::size_of::<Currency>();
const CACHE_KEY_LEN: usize = CURRENCY_LEN + PUBKEY_LEN; // 4 + 32

/// Cache key: `currency_le(4) | pubkey(32)`. currency-major ordering is fine (no range query needed).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct CacheKey([u8; CACHE_KEY_LEN]);
impl CacheKey {
    fn new(pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Self {
        let mut b = [0u8; CACHE_KEY_LEN];
        b[..CURRENCY_LEN].copy_from_slice(&currency.to_le_bytes());
        b[CURRENCY_LEN..].copy_from_slice(&pubkey);
        CacheKey(b)
    }
}
impl Storable for CacheKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut a = [0u8; CACHE_KEY_LEN];
        a.copy_from_slice(&bytes);
        CacheKey(a)
    }
    const BOUND: Bound = Bound::Bounded { max_size: CACHE_KEY_LEN as u32, is_fixed_size: true };
}

/// A cached balance: the amount (minor units) and when it was fetched (unix seconds). `fetched_at`
/// is recorded for staleness introspection; `balance_of` returns the amount regardless of age (a
/// stale value is still the last known truth and never blocks settlement).
const CACHED_BALANCE_LEN: usize = 8 + 8;
#[derive(Clone, Copy, Debug)]
struct CachedBalance {
    amount: u64,
    fetched_at_secs: u64,
}
impl Storable for CachedBalance {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut b = [0u8; CACHED_BALANCE_LEN];
        b[..8].copy_from_slice(&self.amount.to_le_bytes());
        b[8..].copy_from_slice(&self.fetched_at_secs.to_le_bytes());
        Cow::Owned(b.to_vec())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let b = &bytes[..];
        let amount = u64::from_le_bytes(b[..8].try_into().unwrap());
        let fetched_at_secs = u64::from_le_bytes(b[8..].try_into().unwrap());
        CachedBalance { amount, fetched_at_secs }
    }
    const BOUND: Bound =
        Bound::Bounded { max_size: CACHED_BALANCE_LEN as u32, is_fixed_size: true };
}

fn write_cache(pubkey: [u8; PUBKEY_LEN], currency: Currency, amount: u64) {
    BAL_CACHE.with(|c| {
        c.borrow_mut().insert(
            CacheKey::new(pubkey, currency),
            CachedBalance { amount, fetched_at_secs: time() / 1_000_000_000 },
        );
    });
}

// --- local history index (so `transactions_of` is a fast local query; the ICRC-3 block log on the
//     ledger is the durable source of truth and could replace this) ----------------------------

const SEQ_LEN: usize = 8;
const TXN_KEY_LEN: usize = PUBKEY_LEN + CURRENCY_LEN + SEQ_LEN;

/// Sentinel "account" used as the counterparty in mint/burn history rows. A real Ed25519 pubkey is
/// a valid curve point, so this all-ones value can never be a user's pubkey — `verify_strict`
/// rejects it. Lets mint/burn appear in `transactions_of` without changing `TxnRecord`'s shape.
const MINT_ACCOUNT: [u8; PUBKEY_LEN] = [0xFF; PUBKEY_LEN];

/// Index key for a settled transaction: `pubkey(32) | currency_le(4) | seq_be(8)` = 44 bytes.
/// pubkey-major ordering keeps every (account, currency) block contiguous; `seq` is big-endian so a
/// forward range walks oldest→newest (and reversing yields newest-first). One record is inserted
/// under `from` AND under `to`, so an account's full history is a single contiguous key range.
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

/// One settled payment, recorded under each side's pubkey. 100 bytes fixed. Mirrors the wire fields
/// the payer already signed (no fee, no new surfaces — read-only-after-settle).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct TxnRecord {
    from: [u8; PUBKEY_LEN],
    to: [u8; PUBKEY_LEN],
    amount: u64,
    nonce: [u8; NONCE_LEN],
    currency: Currency,
    timestamp: u64, // unix seconds the ledger settled it (`ic time / 1e9`)
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

    /// MemoryId 0: legacy internal BALANCES — ABANDONED (orphaned play money; unread by the facade).

    /// spent nonces (single-use). MemoryId 1 — SAME type/layout as the pre-facade shipping canister,
    /// so an upgrade preserves the replay set. Value is `()` (a set).
    static SPENT: RefCell<StableBTreeMap<Nonce, (), Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(1)))));

    /// per-transaction spending cap (minor units). MemoryId 2.
    static CAP: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(2))), 0)
            .expect("init cap cell"),
    );

    /// Monotonic counter assigning each settled transaction a global sequence number. MemoryId 3.
    static TXN_SEQ: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(3))), 0)
            .expect("init txn seq cell"),
    );

    /// (account pubkey, currency, seq) -> [`TxnRecord`]. MemoryId 4 — SAME type/layout as the
    /// pre-facade shipping canister, so an upgrade preserves history. Each settled payment is
    /// inserted twice (under `from` and `to`).
    static ACCOUNT_TXNS: RefCell<StableBTreeMap<AccountTxnKey, TxnRecord, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(4)))));

    /// currency -> {ledger principal, mintable}. MemoryId 5 (new facade state).
    static LEDGERS: RefCell<StableBTreeMap<Currency, LedgerEntry, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(5)))));

    /// optional governance controller for admin ops. MemoryId 6 (new facade state).
    static CONTROLLER: RefCell<StableCell<ControllerStorable, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(6))), ControllerStorable(None))
            .expect("init controller cell"),
    );

    /// display-only balance cache: (currency, pubkey) -> CachedBalance. MemoryId 7 (new facade
    /// state). Backs the `balance_of` query; refreshed after every settle.
    static BAL_CACHE: RefCell<StableBTreeMap<CacheKey, CachedBalance, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(7)))));
}

/// Configuration for one currency, supplied at init (and via `register_ledger`).
#[derive(CandidType, Deserialize)]
struct LedgerConfig {
    currency: Currency,
    principal: Principal,
    /// `true` for the demo currency whose ledger `minting_account.owner` is this canister (so
    /// `mint`/`burn` are allowed). `false` for real ck currencies — dpay only moves funds.
    mintable: bool,
}

#[derive(CandidType, Deserialize)]
struct InitArg {
    ledgers: Vec<LedgerConfig>,
    per_tx_cap: u64,
    /// Governance principal permitted to call `mint`/`burn`/`register_ledger`/`set_controller`.
    /// `null` = open (the demo default). Production MUST set a governed controller.
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
/// 32-byte Ed25519 pubkey is the `subaccount`. Identical on every ledger.
fn account_of(pk: &[u8; PUBKEY_LEN]) -> Account {
    Account { owner: canister_self(), subaccount: Some(*pk) }
}

fn to_pubkey(v: &[u8]) -> Result<[u8; PUBKEY_LEN], String> {
    v.try_into().map_err(|_| "bad pubkey length".to_string())
}

fn nat_to_u64(n: &Nat) -> Result<u64, String> {
    num_traits::ToPrimitive::to_u64(&n.0).ok_or_else(|| "nat overflows u64".to_string())
}

/// Cross-canister `icrc1_balance_of`. Returns the live (authoritative) ledger balance in minor units.
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

/// Cross-canister `icrc1_fee`. Each ck ledger sets its own fee, so it is read per payment rather
/// than cached — a ckBTC payment must carry ckBTC's fee, not zero.
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
/// timestamp makes a *retry of the same authorization* within one bucket share `created_at_time`, so
/// the ledger returns `Duplicate` → our success branch → no second debit. Defense-in-depth for the
/// relay-retry path.
const DEDUP_BUCKET_SECS: u64 = 60;
fn dedup_created_at_time() -> u64 {
    let now_ns = time();
    let bucket_ns = DEDUP_BUCKET_SECS * 1_000_000_000;
    (now_ns / bucket_ns) * bucket_ns
}

/// Settle an offline-signed authorization. Same candid signature as the pre-facade canister's `pay`;
/// balances are moved on the ICRC ledger named by the payment's currency, not here.
#[update]
async fn pay(signed: Vec<u8>) -> Result<PayReceipt, String> {
    let sa = SignedAuthorization::from_wire(&signed).map_err(|e| format!("decode: {e:?}"))?;
    let sig_ok = sa.verify();
    // Reject a bad signature BEFORE touching the nonce set, so an attacker cannot reserve (and
    // briefly block) a nonce they extracted from a garbled blob.
    if !sig_ok {
        return Err(format!("{:?}", dpay_core::PayError::BadSignature));
    }
    let now_secs = time() / 1_000_000_000;

    let currency = sa.auth.currency;
    let from = sa.auth.from;
    let to = sa.auth.to;
    let amount = sa.auth.amount;
    let nonce = Nonce(sa.auth.nonce);

    // Cheap local rejects — DoS hygiene before any cross-canister call (which costs cycles).
    if amount == 0 {
        return Err("zero amount".to_string());
    }
    if from == to {
        return Err("self transfer".to_string());
    }
    // The mint/burn sentinel ([0xFF;32]) is reserved for history rows and is not a valid Ed25519
    // pubkey (`verify_strict` rejects it). Reject a payment that names it as the payee so a payer
    // can't sign funds into the reserved sentinel subaccount.
    if to == MINT_ACCOUNT {
        return Err("pay to mint sentinel".to_string());
    }
    if sa.auth.expiry < now_secs {
        return Err("expired".to_string());
    }
    let cap = CAP.with(|c| *c.borrow().get());
    if amount > cap {
        return Err("over cap".to_string());
    }

    let (ledger, _mintable) = ledger_for(currency)?;
    let from_acct = account_of(&from);
    let to_acct = account_of(&to);

    // Reserve the nonce synchronously (no await) — this is the concurrency barrier. A concurrent
    // `pay` with the same nonce observes it as used and is rejected at this point.
    if !reserve_nonce(&nonce) {
        return Err("nonce already used".to_string());
    }

    // Everything below may `await`; on any pre-transfer failure we RELEASE the reservation so the
    // payer can retry the same nonce (funds provably did not move).
    // MONEY-SAFETY: read the AUTHORITATIVE ledger balance — never the display cache.
    let balance = match ledger_balance_of(ledger, &from_acct).await {
        Ok(b) => b,
        Err(e) => {
            release_nonce(&nonce);
            return Err(e);
        }
    };

    // dpay-core policy: expiry, per-tx cap, sufficient funds. nonce_already_seen=false (just
    // reserved fresh); sig_ok=true (checked above). Authoritative gate incl. balance sufficiency.
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

    // Move the funds on the ICRC ledger. `memo` = nonce (unique per authorization); `created_at_time`
    // quantized so a retry of THIS authorization within the dedup bucket hits `Duplicate` → success.
    let transfer_arg = TransferArg {
        from_subaccount: Some(from),
        to: to_acct,
        fee: Some(Nat::from(fee)),
        created_at_time: Some(dedup_created_at_time()),
        memo: Some(sa.auth.nonce.to_vec().into()),
        amount: Nat::from(amount),
    };
    match ledger_transfer(ledger, transfer_arg).await {
        // Success (or Duplicate = already settled at this block) → commit nonce, record history,
        // and refresh the display cache by RE-READING the ledger (the pre-transfer read is stale
        // under concurrent settlement). Funds provably moved (or had already moved).
        Ok(_) | Err(TransferError::Duplicate { .. }) => {
            settle_nonce(&nonce);
            // Record the SETTLE time, not the call-start `now_secs` captured before the
            // cross-canister awaits (balance/fee/transfer). `TxnRecord.timestamp` is documented as
            // "unix seconds the ledger settled it". One `time()` read — cheap.
            let settle_secs = time() / 1_000_000_000;
            record_txn(from, to, amount, sa.auth.nonce, currency, settle_secs);
            let new_from_balance = ledger_balance_of(ledger, &from_acct).await.unwrap_or_else(|_| {
                balance.saturating_sub(amount).saturating_sub(fee)
            });
            // Refresh the display cache for both sides (best-effort; never blocks settlement).
            write_cache(from, currency, new_from_balance);
            if let Ok(to_bal) = ledger_balance_of(ledger, &to_acct).await {
                write_cache(to, currency, to_bal);
            }
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

/// `balance_of(blob, nat32) -> nat64` — now a **query** returning the display-only cache. The cache
/// is refreshed after every settle; if stale (someone transferred directly on the ledger), callers
/// get the last known value. Settlement never reads this — it reads the ledger directly.
#[query]
fn balance_of(pubkey: Vec<u8>, currency: Currency) -> u64 {
    match to_pubkey(&pubkey) {
        Ok(pk) => BAL_CACHE
            .with(|c| c.borrow().get(&CacheKey::new(pk, currency)).map(|b| b.amount).unwrap_or(0)),
        Err(_) => 0,
    }
}

/// `mint(blob, nat32, nat64) -> Result<nat64, text>` — fund a user on a MINTABLE (demo) currency by
/// transferring from the ledger's minting account (which this canister owns). Real ck currencies are
/// not mintable. Refreshes the display cache from the authoritative ledger post-settle. Gated to the
/// controller in production (open only when `controller` is unset, i.e. the demo).
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
        created_at_time: Some(time()),
        memo: None,
    };
    let _block_index = ledger_transfer(ledger, arg).await.map_err(|e| format!("mint transfer: {e:?}"))?;
    let now_secs = time() / 1_000_000_000;
    record_txn(MINT_ACCOUNT, pk, amount, [0u8; NONCE_LEN], currency, now_secs);
    // Re-read the authoritative post-mint balance: refresh the display cache AND return it. The
    // `Ledger` trait contract is that `mint` returns the NEW BALANCE (FakeLedger honors this; the
    // relay faucet surfaces the return directly as `{balance}`), NOT the ledger's block index.
    let new_balance = ledger_balance_of(ledger, &account_of(&pk))
        .await
        .map_err(|e| format!("mint settled but post-mint balance read failed: {e}"))?;
    write_cache(pk, currency, new_balance);
    Ok(new_balance)
}

/// `burn(blob, nat32, nat64) -> Result<nat64, text>` — destroy a MINTABLE (demo) currency by
/// transferring it back to the ledger's minting account (the ICRC convention). Only demo currencies
/// can be burned. Refreshes the display cache post-settle. Same controller gating as `mint`. Returns
/// the ledger transfer's block index (unlike `mint`, which returns the new balance): `burn` is
/// facade-internal with no relay consumer, so no contract pins its return to a balance.
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
        to: Account { owner: canister_self(), subaccount: None }, // minting account
        amount: Nat::from(amount),
        fee: Some(Nat::from(fee)),
        created_at_time: Some(time()),
        memo: None,
    };
    let block_index = ledger_transfer(ledger, arg).await.map_err(|e| format!("burn transfer: {e:?}"))?;
    let now_secs = time() / 1_000_000_000;
    record_txn(pk, MINT_ACCOUNT, amount, [0u8; NONCE_LEN], currency, now_secs);
    // Refresh the display cache from the authoritative ledger.
    if let Ok(bal) = ledger_balance_of(ledger, &from_acct).await {
        write_cache(pk, currency, bal);
    }
    Ok(nat_to_u64(&block_index)?)
}

/// Register or replace the ledger for a currency at runtime. Gated to the controller in production
/// (open only when `controller` is unset, i.e. the demo).
#[update]
fn register_ledger(currency: Currency, principal: Principal, mintable: bool) -> Result<(), String> {
    require_admin()?;
    LEDGERS.with(|m| {
        m.borrow_mut().insert(currency, LedgerEntry { principal, mintable });
    });
    Ok(())
}

/// Rotate the governance principal for `mint`/`burn`/`register_ledger`/`set_controller`. Governed by
/// the current controller: in open-demo mode (no controller set) any caller may set one — which is
/// how a fresh deployment is locked down; once a controller is set, only it can rotate. (This gates
/// admin *methods* only. The IC-level canister controller — who can `install_code`/upgrade — is a
/// separate concern set via `dfx`/NNS/SNS.)
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

/// Provision a fresh canister that carries `cycles` of THIS canister's cycle balance, with
/// `controller` as its sole controller, and return its id. Gated to operator callers (the fixed
/// ADMIN_CALLERS allowlist). Used to spin up ICRC ledgers using cycles held inside this canister:
/// the deploy identity has no cycles wallet, so the only way to spend the canister's cycles is for
/// its own code to attach them to a management-canister call. This canister is NOT made a controller
/// of the new canister — it spends the cycles and is done — so the non-custodial posture is intact.
#[update]
async fn provision_ledger_canister(controller: Principal, cycles: u128) -> Result<Principal, String> {
    require_operator()?;
    let arg = CreateCanisterArgs {
        settings: Some(CanisterSettings {
            controllers: Some(vec![controller]),
            ..Default::default()
        }),
    };
    let result = create_canister_with_extra_cycles(&arg, cycles)
        .await
        .map_err(|e| format!("create_canister rejected: {e:?}"))?;
    Ok(result.canister_id)
}

/// Transfer up to `amount` cycles from THIS canister's balance to `to` via the management canister's
/// `deposit_cycles`. Gated to operator callers — the SAME `require_operator` gate
/// (`ADMIN_CALLERS` allowlist) that `provision_ledger_canister` uses — NOT the governance
/// `require_admin` controller gate: rebalancing cycles between this canister and canisters it
/// provisions is an ops/owner cycles action. Used to reclaim cycles from a retiring canister (e.g.
/// before a mainnet upgrade) and to top up / rebalance cycles on canisters this one provisions.
///
/// The amount is bounded by the current balance (`amount.min(bal)`), so this never overdraws and
/// never traps. A request at/above the LIQUID cycle balance returns `Err` (the management canister is
/// the authority on liquid cycles — no CDK API exposes liquid balance) — retry with a smaller amount.
/// Returns the amount actually transferred so the caller can confirm.
#[update]
async fn transfer_cycles(to: Principal, amount: u128) -> Result<u128, String> {
    require_operator()?;
    let bal = ic_cdk::api::canister_cycle_balance();
    let send = amount.min(bal);
    if send == 0 {
        return Err("nothing to send: amount is 0 or canister has no cycles".to_string());
    }
    let rec = CanisterIdRecord { canister_id: to };
    let response = Call::bounded_wait(Principal::management_canister(), "deposit_cycles")
        .with_arg(&rec)
        .with_cycles(send)
        .await
        .map_err(|e| format!("deposit_cycles rejected: {e:?}"))?;
    response
        .candid::<()>()
        .map_err(|e| format!("deposit_cycles decode: {e:?}"))?;
    Ok(send)
}

ic_cdk::export_candid!();
