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

use candid::{Nat, Principal};
use ed25519_dalek::SigningKey;
use ic_cdk::api::{canister_self, msg_caller, time};
use ic_cdk::call::Call;
use ic_cdk::management_canister::{
    create_canister_with_extra_cycles, raw_rand, CanisterIdRecord, CanisterSettings, CreateCanisterArgs,
};
use ic_cdk::{init, query, update};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell};
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::{TransferArg, TransferError};
use std::cell::RefCell;

use dpay_core::{
    validate, Currency, ReceiptClaim, SignedAuthorization, MEMO_LEN, NAME_LEN, NONCE_LEN,
    PUBKEY_LEN,
};

mod calls;
mod proxy;
mod types;
use calls::*;
use types::*;

/// Fail-loud canister log line — the repo's WARN surface. `ic_cdk::print` is deprecated in
/// ic-cdk 0.19 but is deliberately kept, NOT swapped for `debug_print`: debug output is
/// suppressed on non-debug (prod mainnet) canisters, which would silence exactly the fail-loud
/// WARN logging at every call site below (post-settle cache misses, Nat overflows, nonce-state
/// repairs). The deprecation is acknowledged once, here at the wrapper — the calls stay
/// prod-visible and the build stays warning-clean.
#[allow(deprecated)]
pub(crate) fn print_log(msg: impl AsRef<str>) {
    ic_cdk::print(msg);
}

// --- spent-nonce set: nonce -> () -------------------------------------------------------------
// A nonce in the map means "reserved or settled" — either way, a concurrent/replay `pay` with the
// same nonce is rejected (`contains_key`). `reserve` inserts (synchronous, before any await);
// `release` removes (on a transient failure, so the payer may retry); `settle` is a no-op (the
// entry is already present). See the module docs for why this is a set, not the ICRC demo's
// Pending/Settled enum (upgrade-layout compatibility).

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

// --- withdraw-nonce set: nonce -> () -----------------------------------------------------------
// A SEPARATE spent-nonce map for the WITHDRAWAL path (`retrieve_btc`). Kept distinct from `SPENT`
// (pay nonces) so a withdraw idempotency key can never collide with / block a pay nonce (both are
// random 128-bit, so collisions are negligible in practice — the separation is for cleanliness and
// independent auditability). Same reserve/release/settle semantics as `SPENT`: reserve
// synchronously (no await) before any cross-canister call; release on a transient/pre-transfer
// failure so the same authorization may retry; settle (no-op, the entry is already present) once the
// burn commits so the dead/settled authorization can never replay.

/// Reserve `nonce` for a withdrawal. Returns `false` if already present (replay or concurrent
/// withdraw reserved it first). Synchronous — no `await` — so two concurrent withdraws cannot both
/// succeed (the concurrency barrier, identical to [`reserve_nonce`]).
pub(crate) fn reserve_withdraw_nonce(nonce: &Nonce) -> bool {
    WITHDRAW_NONCES.with(|s| {
        let mut s = s.borrow_mut();
        if s.contains_key(nonce) {
            false
        } else {
            s.insert(nonce.clone(), ());
            true
        }
    })
}

/// Mark `nonce` as settled (the burn committed). No-op with set semantics (mirrors [`settle_nonce`]).
pub(crate) fn settle_withdraw_nonce(nonce: &Nonce) {
    WITHDRAW_NONCES.with(|s| {
        s.borrow_mut().insert(nonce.clone(), ());
    });
}

/// Release a withdraw reservation so the same authorization may retry (transient/pre-burn failure).
pub(crate) fn release_withdraw_nonce(nonce: &Nonce) {
    WITHDRAW_NONCES.with(|s| {
        s.borrow_mut().remove(nonce);
    });
}

/// Returns `Ok(())` if the caller may perform **value-moving / config** governance admin ops
/// (`mint`/`burn`/`register_ledger`/`register_minter`/`reconcile`). With **no controller set** the
/// call is REJECTED — the open-admin default is closed, so a deployment that forgets to seed a
/// governed controller cannot have its currency repointed or its demo currency printed by any
/// caller. With a controller set, only that principal is admitted.
///
/// This is the money-safety flip: the demo's self-service on-ramp is the separate [`faucet`]
/// method (fixed amount, rate-limited, no admin gate); the privileged `mint`/`burn`/`register_*`
/// path is closed until an operator seeds a governed controller at init (see `InitArg::controller`
/// and `set_controller`). `set_controller` is intentionally NOT gated here — it has its own
/// bootstrap+rotation semantics (see [`require_controller_rotation`]).
fn require_admin() -> Result<(), String> {
    let admin = CONTROLLER.with(|c| c.borrow().get().0);
    match admin {
        None => Err("admin ops disabled: no controller set (seed one at init or via set_controller)"
            .to_string()),
        Some(a) if msg_caller() == a => Ok(()),
        Some(_) => Err("unauthorized: admin ops require the controller principal".to_string()),
    }
}

/// Gate for `set_controller` — the ONE admin op that must remain callable to establish the first
/// controller. Semantics:
/// - **No controller set (open/demo):** any caller may set the first controller — the one-time
///   lockdown path for a deployment that did not seed one at init. (Open mode is demo-only; against
///   an adversary, seed a governed controller at `init` instead — see CODEBASE_ANALYSIS.)
/// - **Controller set (locked):** only the current controller may rotate to a new principal
///   (two-step rotation; a locked canister can only be rotated by its controller).
fn require_controller_rotation() -> Result<(), String> {
    let cur = CONTROLLER.with(|c| c.borrow().get().0);
    match cur {
        None => Ok(()), // open mode: allow the one-time lockdown
        Some(c) if msg_caller() == c => Ok(()), // locked: two-step rotation by the controller
        Some(_) => Err("unauthorized: set_controller requires the current controller".to_string()),
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

pub(crate) fn write_cache(pubkey: [u8; PUBKEY_LEN], currency: Currency, amount: u64) {
    BAL_CACHE.with(|c| {
        c.borrow_mut().insert(
            CacheKey::new(pubkey, currency),
            CachedBalance { amount, fetched_at_secs: time() / 1_000_000_000 },
        );
    });
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
            // SAFETY: one-time stable-cell init; a trap means corrupt stable storage (canister can't boot).
            .expect("init cap cell"),
    );

    /// Monotonic counter assigning each settled transaction a global sequence number. MemoryId 3.
    static TXN_SEQ: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(3))), 0)
            // SAFETY: one-time stable-cell init; a trap means corrupt stable storage (canister can't boot).
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
            // SAFETY: one-time stable-cell init; a trap means corrupt stable storage (canister can't boot).
            .expect("init controller cell"),
    );

    /// display-only balance cache: (currency, pubkey) -> CachedBalance. MemoryId 7 (new facade
    /// state). Backs the `balance_of` query; refreshed after every settle.
    static BAL_CACHE: RefCell<StableBTreeMap<CacheKey, CachedBalance, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(7)))));

    /// currency -> its ck-minter principal. MemoryId 8 (new facade state). A currency has a minter
    /// only if it is a ck currency (ckBTC/ckETH/...); absence => the facade exposes no deposit path.
    static MINTERS: RefCell<StableBTreeMap<Currency, PrincipalStorable, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(8)))));

    /// `(currency, pubkey)` -> last-faucet unix-secs. MemoryId 9 (new facade state). Backs the
    /// self-service [`faucet`] rate-limit: one mint per account per currency per cooldown window.
    /// Reuses [`CacheKey`] (`currency_le(4) | pubkey(32)`); the value is the wall-clock seconds of
    /// the last successful faucet mint for that (account, currency).
    static FAUCET_COOLDOWN: RefCell<StableBTreeMap<CacheKey, u64, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(9)))));

    /// The canister's receipt Ed25519 secret key (32 bytes), lazily generated on first use.
    /// MemoryId 10 (new facade state). `None` until the first successful `pay` (or an explicit
    /// `init_receipt_key`); once generated it is NEVER rotated (rotating would invalidate prior
    /// receipts). The public half is derived and exposed via `receipt_pubkey`.
    static RECEIPT_SECRET: RefCell<StableCell<ReceiptSecretStorable, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(10))), ReceiptSecretStorable(None))
            // SAFETY: one-time stable-cell init; a trap means corrupt stable storage (canister can't boot).
            .expect("init receipt secret cell"),
    );

    /// nonce -> the canister-signed receipt for that settled payment. MemoryId 11 (new facade
    /// state). Lets `receipt(nonce)` return the canonical claim bytes + sig for replay/
    /// reconciliation, so the payer can verify the outcome even if the original `pay` response was
    /// lost. Keyed by [`Nonce`] (the same single-use idempotency key `pay` reserves).
    static RECEIPTS: RefCell<StableBTreeMap<Nonce, StoredReceipt, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(11)))));

    /// Withdrawal-nonce set. MemoryId 12 (new facade state). A SEPARATE map from `SPENT` (pay
    /// nonces): tracks single-use withdrawal idempotency keys so a signed [`WithdrawAuth`] can be
    /// submitted at most once (a replay would otherwise burn ckBTC twice). Same set semantics as
    /// `SPENT`: reserve before any cross-canister call, release on transient failure, settle on
    /// commit. See [`reserve_withdraw_nonce`].
    static WITHDRAW_NONCES: RefCell<StableBTreeMap<Nonce, (), Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(12)))));

    /// currency -> display/family metadata (symbol, decimals, minter_family). MemoryId 13 (new
    /// facade state). Backs the `currencies()` catalog; registered via `register_currency_meta`.
    /// Separate from `MINTERS` (minter principal) and `LEDGERS` (ledger principal) so existing
    /// encodings are untouched (no upgrade-layout churn).
    pub(crate) static CURRENCY_META: RefCell<StableBTreeMap<Currency, CurrencyMetaStorable, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(13)))));

    /// currency -> `()`. MemoryId 14 (new facade state). The RETIRED set: an append-only marker that a
    /// currency id is IRREVERSIBLY dead. Retire is one-way — there is no un-retire method, and the id
    /// can NEVER be reused or re-registered (a retired id is rejected by `register_ledger`/
    /// `register_minter` BEFORE their insert-only logic). A retired currency leaves the wallet catalog
    /// (`currencies()` skips it) and is rejected by `ledger_for`/`minter_for` (so `pay`/`withdraw`/
    /// `mint`/`faucet` reject it), but its LEDGERS/MINTERS/CURRENCY_META/ACCOUNT_TXNS rows are NOT
    /// deleted — history is preserved for the audit trail. "Retire + create a new id" is the only
    /// replacement. Same set semantics as `SPENT`/`WITHDRAW_NONCES` (value `()`, membership is the
    /// signal); `Currency` (`u32`) is already `Storable` (it keys LEDGERS/MINTERS/CURRENCY_META).
    static RETIRED: RefCell<StableBTreeMap<Currency, (), Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(14)))));
}

#[init]
fn init(arg: InitArg) {
    // SAFETY: init-only write to an already-initialized stable cell; runs once at canister install.
    CAP.with(|c| c.borrow_mut().set(arg.per_tx_cap).expect("set cap"));
    // SAFETY: init-only write to an already-initialized stable cell; runs once at canister install.
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
/// Honors RETIRED: a retired currency id is dead forever and resolves to an error (so `pay`/`mint`/
/// `burn`/`faucet`/`reconcile` all reject it) — its LEDGERS row is preserved for history but is no
/// longer reachable through the live settlement path.
pub(crate) fn ledger_for(currency: Currency) -> Result<(Principal, bool), String> {
    if is_retired(currency) {
        return Err(format!("currency {currency} is retired"));
    }
    LEDGERS.with(|m| m.borrow().get(&currency))
        .map(|e| (e.principal, e.mintable))
        .ok_or_else(|| format!("unknown currency {currency}"))
}

/// Resolve a currency to its ck-minter principal (only ck currencies have one). Absent -> Err.
/// Honors RETIRED (same as `ledger_for`): a retired currency's minter is unreachable.
pub(crate) fn minter_for(currency: Currency) -> Result<Principal, String> {
    if is_retired(currency) {
        return Err(format!("currency {currency} is retired"));
    }
    MINTERS
        .with(|m| m.borrow().get(&currency).map(|s| s.0))
        .ok_or_else(|| format!("currency {currency} has no ck minter"))
}

/// Whether a currency id has been IRREVERSIBLY retired (membership in the append-only RETIRED set).
/// Retire is one-way: the id is dead forever and can never be reused or re-registered.
fn is_retired(currency: Currency) -> bool {
    RETIRED.with(|r| r.borrow().contains_key(&currency))
}

/// The governed per-currency transaction cap (MC2 U1). Read from `CURRENCY_META` — the authoritative
/// per-currency replacement for the single global `CAP`. `None` (no metadata registered, or the
/// `cap` field unset) maps to a **fail-closed** `0` at the single call site in `pay`, so EVERY
/// non-zero pay on a cap-less currency is rejected (`amount > 0` → OverCap). This forces an
/// explicit per-currency cap to be registered before that currency is payable — matching the
/// project's fail-closed discipline (same posture as MC1's unknown-family → null ramp). The legacy
/// global `CAP` cell + `per_tx_cap()` query are retained as a deploy-script readout only; `pay` no
/// longer consults them.
fn currency_cap(currency: Currency) -> Option<u64> {
    CURRENCY_META.with(|m| m.borrow().get(&currency).and_then(|meta| meta.cap))
}

// The family-gate helpers (`currency_family` / `resolve_minter_family` / `currency_gas_ledger`)
// lived here before the M7 proxy split. They are used by EXACTLY the four deposit/withdraw proxy
// entry points and nothing else in the crate, so they moved to `proxy.rs` next to their callers —
// see that module for the family-gate semantics and the byte-identical error strings.

/// Ensure the canister's receipt Ed25519 keypair exists, lazily generating it from
/// `management_canister::raw_rand` on first call. MUST run in an update context (raw_rand is an
/// update call). Idempotent: subsequent calls return the existing key. The secret is stored in
/// stable memory (MemoryId 10) and NEVER rotated — rotating would invalidate every prior receipt.
/// Strong entropy comes from the consensus-provided `raw_rand` (not a PRNG seed). Returns the
/// `SigningKey` so the caller can sign a receipt claim.
async fn ensure_receipt_key() -> Result<SigningKey, String> {
    let existing = RECEIPT_SECRET.with(|c| c.borrow().get().0);
    if let Some(sk) = existing {
        return Ok(SigningKey::from_bytes(&sk));
    }
    let rand = raw_rand().await.map_err(|e| format!("raw_rand rejected: {e:?}"))?;
    let sk: [u8; 32] = rand
        .as_slice()
        .try_into()
        .map_err(|_| format!("raw_rand returned {} bytes (need 32)", rand.len()))?;
    RECEIPT_SECRET
        .with(|c| -> Result<(), String> {
            c.borrow_mut().set(ReceiptSecretStorable(Some(sk))).map_err(|e| format!("set receipt secret: {e:?}"))?;
            Ok(())
        })?;
    Ok(SigningKey::from_bytes(&sk))
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
    // MC2 U1: the per-currency cap (governed, fail-closed). `None` ⇒ 0 ⇒ every non-zero pay on a
    // cap-less currency is rejected (OverCap). The SAME `cap` flows into both the early `amount >
    // cap` check and `validate(...)` — one source. The legacy global `CAP` cell is no longer read
    // here (kept only as the `per_tx_cap()` legacy readout).
    let cap = currency_cap(currency).unwrap_or(0);
    if amount > cap {
        return Err("over cap".to_string());
    }

    let (ledger, _mintable) = ledger_for(currency)?;
    let from_acct = account_of(&from);
    let to_acct = account_of(&to);

    // MC4 U1: ensure the receipt signing key exists BEFORE the ledger commit. On the very first pay
    // to a fresh canister this calls `raw_rand` to generate the key; if that traps, the payment has
    // NOT yet settled (no ledger debit) — eliminating the first-pay trap where a POST-commit
    // key-gen failure left a settled payment (ledger debited) with NO stored receipt. Placed AFTER
    // the cheap local rejects (bad sig / zero / self / mint-sentinel / expiry / cap / unknown or
    // retired currency) so a garbage payload triggers no key-gen side effect, and BEFORE
    // `reserve_nonce` so a key-gen failure also does not burn a nonce. The bound `SigningKey` is
    // held across the awaits below and signs the receipt post-commit (the key never rotates, so
    // holding it across awaits is correct).
    let receipt_sk = ensure_receipt_key().await?;

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
    // Capture the ledger block index (the outcome proof) from the success OR Duplicate branch —
    // Duplicate means "already settled at this block", which is still a settled outcome the receipt
    // must attest. (`ledger_transfer` returns the block index as a candid `Nat`.)
    let block_index_nat = match ledger_transfer(ledger, transfer_arg).await {
        Ok(idx) => idx,
        // Duplicate = "already settled at block `duplicate_of`" — still a settled outcome the
        // receipt must attest. Use that block index.
        Err(TransferError::Duplicate { duplicate_of, .. }) => duplicate_of,
        // Genuinely transient — funds provably did not move, or the ledger is unsure. Release so the
        // payer may retry the SAME nonce. Carry the variant identity + InsufficientFunds.balance so
        // the payer/operator can distinguish "broke" from "ledger down" (distinct retry guidance).
        Err(TransferError::InsufficientFunds { balance }) => {
            release_nonce(&nonce);
            return Err(format!("transient: insufficient_funds balance={balance}"));
        }
        Err(TransferError::TemporarilyUnavailable) => {
            release_nonce(&nonce);
            return Err("transient: temporarily_unavailable".to_string());
        }
        // Any other ledger error is not safe to retry blindly — burn the nonce so the dead auth can
        // never replay. The payer must obtain a fresh authorization.
        Err(e) => {
            settle_nonce(&nonce);
            return Err(format!("ledger transfer: {e:?}"));
        }
    };

    // --- committed: the ledger debited (or had already, on Duplicate). Commit the nonce, record
    //     history, refresh the display cache, then sign + store the canister receipt. ---
    settle_nonce(&nonce);
    // Record the SETTLE time, not the call-start `now_secs` captured before the cross-canister
    // awaits (balance/fee/transfer). `TxnRecord.timestamp` is documented as "unix seconds the
    // ledger settled it". One `time()` read — cheap.
    let settle_secs = time() / 1_000_000_000;
    record_txn(
        from,
        to,
        amount,
        sa.auth.nonce,
        currency,
        settle_secs,
        sa.auth.from_name,
        sa.auth.to_name,
        sa.auth.memo,
    )?;
    let new_from_balance = ledger_balance_of(ledger, &from_acct).await.unwrap_or_else(|e| {
        print_log(format!("WARN pay: post-settle from_balance re-read failed ({e}) — receipt uses computed estimate"));
        balance.saturating_sub(amount).saturating_sub(fee)
    });
    // Refresh the display cache for both sides (best-effort; never blocks settlement).
    write_cache(from, currency, new_from_balance);
    if let Ok(to_bal) = ledger_balance_of(ledger, &to_acct).await {
        write_cache(to, currency, to_bal);
    } else {
        print_log("WARN pay: post-settle payee cache refresh failed (display-only)");
    }

    // Sign the outcome receipt. The block index caps at u64 (the demo's ledgers never exceed it;
    // a Nat overflow surfaces as block_index=0, which still verifies under the same key — the
    // amount/nonce/from/to/currency/ts bind the claim, and the sig is canister-authored). The
    // receipt key was bound BEFORE the ledger commit (MC4 U1), so this is now a pure Ed25519 sign
    // with NO await — a post-commit key-gen failure can no longer orphan a settled payment.
    let block_index = nat_to_u64(&block_index_nat).unwrap_or_else(|e| {
        print_log(format!("WARN pay: block_index Nat overflow ({e}) — receipt block_index coerced to 0"));
        0
    });
    let pubkey = receipt_sk.verifying_key().to_bytes();
    let claim = ReceiptClaim {
        nonce: sa.auth.nonce,
        from,
        to,
        amount,
        currency,
        block_index,
        settle_ts: settle_secs,
    };
    let sig = dpay_core::sign_receipt(&receipt_sk, &claim).to_bytes();
    // Store the signed receipt keyed by nonce so `receipt(nonce)` can return it for replay/
    // reconciliation (a merchant whose /pay response was lost re-confirms via the canister).
    RECEIPTS.with(|m| {
        m.borrow_mut().insert(
            nonce.clone(),
            StoredReceipt { claim_bytes: claim.signing_bytes(), sig },
        );
    });
    Ok(PayReceipt {
        from: from.to_vec(),
        to: to.to_vec(),
        amount,
        nonce: sa.auth.nonce.to_vec(),
        new_from_balance,
        block_index,
        settle_ts: settle_secs,
        receipt_sig: sig.to_vec(),
        pubkey: pubkey.to_vec(),
    })
}

pub(crate) fn record_txn(
    from: [u8; PUBKEY_LEN],
    to: [u8; PUBKEY_LEN],
    amount: u64,
    nonce: [u8; NONCE_LEN],
    currency: Currency,
    timestamp: u64,
    from_name: [u8; NAME_LEN],
    to_name: [u8; NAME_LEN],
    memo: [u8; MEMO_LEN],
) -> Result<(), String> {
    let seq = TXN_SEQ.with(|c| -> Result<u64, String> {
        let v = *c.borrow().get();
        // StableCell::set failures are rare (stable-memory exhaustion). Returning Err here (vs the
        // prior `expect`) avoids a trap that would also roll back the nonce reservation — the
        // orphan state `reconcile` repairs is narrowed to "ledger debited, history missing", with
        // the nonce still reserved (no double-spend vector).
        c.borrow_mut().set(v + 1).map_err(|e| format!("advance txn seq: {e:?}"))?;
        Ok(v)
    })?;
    let rec = TxnRecord { from, to, amount, nonce, currency, timestamp, from_name, to_name, memo };
    ACCOUNT_TXNS.with(|m| {
        let mut m = m.borrow_mut();
        m.insert(AccountTxnKey::new(from, currency, seq), rec);
        m.insert(AccountTxnKey::new(to, currency, seq), rec);
    });
    Ok(())
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

/// `(blob pubkey, vec nat32 currencies) -> Result<vec record { currency: nat32, amount: nat64 },
/// text>` — the UNIFIED authoritative on-demand balance refresh (single + batch via the SAME call;
/// pass `[currency]` for one, every registered id for all). Reads the live ledger balance via
/// `icrc1_balance_of` for `Account{owner: canister_self(), subaccount: pubkey}` for each REQUESTED
/// currency, writes each to `BAL_CACHE` (so the fast `balance_of` query reflects it on subsequent
/// reads), and returns the list of `BalanceEntry { currency, amount }`.
///
/// Replaces the relay's N separate per-currency update calls (each its own 2-5s consensus round)
/// with ONE call that does N inter-canister `icrc1_balance_of` reads sequentially inside a single
/// update (one consensus round). Inter-canister calls are sequential (a `for` loop with `.await`) —
/// parallelizing them would require `futures` in the canister; not worth it, since same-subnet
/// `icrc1_balance_of` calls are fast (~50-100ms each), so N sequential ≈ 300-600ms inside ONE
/// consensus round vs N × 2-5s rounds for the per-currency path.
///
/// Best-effort per currency, two layers:
/// - An UNKNOWN or RETIRED id (one `ledger_for` fails to resolve to a live ledger) is SKIPPED
///   (logged via `ic_cdk::print`, never silent) and the batch continues — the caller asked for it,
///   but it resolves to no live ledger; the returned entries cover only the currencies that resolved.
/// - A `ledger_balance_of` read failure on ONE currency keeps its last-known cached value
///   (display-only; settlement always reads the ledger directly — the money-safety invariant is
///   unchanged), is logged via `ic_cdk::print` (never silent), and the batch continues — one bad
///   ledger cannot fail the whole batch.
///
/// **No auth gate** — consistent with the unauthenticated `balance_of`/`deposit_address` surface:
/// this is a read + cache writes that move NO value; it only ever credits the named pubkey's true
/// balance. Use this to surface credits that bypass the facade: asynchronous ckERC20 heartbeat
/// mints and direct ICRC transfers land on the ledger WITHOUT invoking the facade, so `BAL_CACHE`
/// stays stale until this is called. Settlement (`pay`) NEVER reads this — it reads the ledger
/// directly (the money-safety invariant is unchanged). The ONLY hard error is a malformed `pubkey`
/// (via `to_pubkey`); everything else is best-effort. Modeled on the post-mint authoritative read
/// in `mint` (re-read + `write_cache`).
#[update]
async fn refresh_balances(
    pubkey: Vec<u8>,
    currencies: Vec<Currency>,
) -> Result<Vec<BalanceEntry>, String> {
    let pk = to_pubkey(&pubkey)?;
    let mut results = Vec::with_capacity(currencies.len());
    for currency in currencies {
        // Resolve the ledger for this REQUESTED currency. An unknown/retired id resolves to no live
        // ledger — skip it (logged, never silent) and continue the batch; the caller asked for it,
        // but it cannot be refreshed. The returned entries cover only the resolved currencies.
        let ledger = match ledger_for(currency) {
            Ok((l, _)) => l,
            Err(e) => {
                print_log(format!(
                    "WARN refresh_balances: currency {currency} skipped ({e}) — no live ledger"
                ));
                continue;
            }
        };
        match ledger_balance_of(ledger, &account_of(&pk)).await {
            Ok(bal) => {
                write_cache(pk, currency, bal);
                results.push(BalanceEntry { currency, amount: bal });
            }
            Err(e) => {
                // Best-effort: a ledger hiccup on ONE currency must not fail the batch. Keep the
                // last-known cached value (display-only; settlement always reads the ledger
                // directly — the money-safety invariant is unchanged) and log the error so it is
                // observable, never silently swallowed.
                print_log(format!(
                    "WARN refresh_balances: currency {currency} read failed ({e}) — kept cached value"
                ));
                let cached = BAL_CACHE
                    .with(|c| c.borrow().get(&CacheKey::new(pk, currency)).map(|b| b.amount).unwrap_or(0));
                results.push(BalanceEntry { currency, amount: cached });
            }
        }
    }
    Ok(results)
}

/// `mint(blob, nat32, nat64) -> Result<nat64, text>` — fund a user on a MINTABLE (demo) currency by
/// transferring from the ledger's minting account (which this canister owns). Real ck currencies are
/// not mintable. Refreshes the display cache from the authoritative ledger post-settle. Gated to the
/// controller in production (open only when `controller` is unset, i.e. the demo).
///
/// Settlement target (2026-08-20 faucet re-target): the USER's own principal —
/// [`calls::user_account_of`] (`self_authenticating(DER(pubkey))`, no subaccount), the account the
/// app reads. Before the re-target `mint` credited the facade-custody `account_of` subaccount,
/// which the app cannot see — that made even a controller-run mint invisible post-cutover. The
/// production faucet is the RELAY (founder-approved 2026-08-20): it rate-limits locally and drives
/// THIS admin-gated `mint` with an authenticated controller identity.
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
        to: user_account_of(&pk),
        amount: Nat::from(amount),
        fee: None, // mints carry no fee
        created_at_time: Some(time()),
        memo: None,
    };
    let _block_index = ledger_transfer(ledger, arg).await.map_err(|e| format!("mint transfer: {e:?}"))?;
    let now_secs = time() / 1_000_000_000;
    record_txn(
        MINT_ACCOUNT,
        pk,
        amount,
        [0u8; NONCE_LEN],
        currency,
        now_secs,
        [0u8; NAME_LEN],
        [0u8; NAME_LEN],
        [0u8; MEMO_LEN],
    )?;
    // Re-read the authoritative post-mint balance: refresh the display cache AND return it. The
    // `Ledger` trait contract is that `mint` returns the NEW BALANCE (FakeLedger honors this; the
    // relay faucet surfaces the return directly as `{balance}`), NOT the ledger's block index.
    let new_balance = ledger_balance_of(ledger, &user_account_of(&pk))
        .await
        .map_err(|e| format!("mint settled but post-mint balance read failed: {e}"))?;
    write_cache(pk, currency, new_balance);
    Ok(new_balance)
}

/// `(blob account, nat32 currency) -> Result<nat64, text>` — the self-service demo on-ramp. Mints
/// a FIXED [`FAUCET_AMOUNT`] ($100.00) of a mintable currency to `account`, rate-limited per
/// (account, currency) via [`FAUCET_COOLDOWN`] (one mint per [`FAUCET_COOLDOWN_SECS`] window). No
/// admin gate. Refreshes the display cache from the authoritative ledger post-mint and returns the
/// new balance (matching the `Ledger::faucet` contract the relay surfaces as `{balance}`).
///
/// SUPERSEDED (2026-08-20): the production faucet is the RELAY (founder-approved design) — it
/// owns the cooldown and drives the controller-gated [`mint`] with an authenticated identity, so
/// the on-ramp credits the USER principal (see [`calls::user_account_of`]). This endpoint remains
/// as the direct-canister self-service surface (open mode / no relay); note it still credits the
/// facade-custody [`calls::account_of`] shape, which the post-cutover app does not read.
#[update]
async fn faucet(account: Vec<u8>, currency: Currency) -> Result<u64, String> {
    let pk = to_pubkey(&account)?;
    let (ledger, mintable) = ledger_for(currency)?;
    if !mintable {
        return Err(format!("currency {currency} is not mintable (faucet is demo-only)"));
    }
    // Rate-limit: one faucet per (account, currency) per cooldown window. Synchronous read+write
    // under the stable map (no await in the check) so two concurrent faucet calls for the same
    // account cannot both pass — the second observes the first's just-written timestamp.
    let key = CacheKey::new(pk, currency);
    let now_secs = time() / 1_000_000_000;
    FAUCET_COOLDOWN.with(|m| {
        let mut m = m.borrow_mut();
        if let Some(last) = m.get(&key) {
            let ready_at = last.saturating_add(FAUCET_COOLDOWN_SECS);
            if now_secs < ready_at {
                let secs = ready_at - now_secs;
                let unit = if secs >= 3600 { "h" } else if secs >= 60 { "min" } else { "s" };
                let v = if secs >= 3600 { secs / 3600 } else if secs >= 60 { secs / 60 } else { secs };
                return Err(format!("faucet cooldown: try again in ~{v} {unit}"));
            }
        }
        m.insert(key, now_secs);
        Ok(())
    })?;
    // Mint the fixed amount from the ledger's minting account (which this canister owns), identical
    // to `mint`'s transfer but with the fixed amount and no caller gate.
    let arg = TransferArg {
        from_subaccount: None, // the minting account's default subaccount
        to: account_of(&pk),
        amount: Nat::from(FAUCET_AMOUNT),
        fee: None, // mints carry no fee
        created_at_time: Some(time()),
        memo: None,
    };
    ledger_transfer(ledger, arg)
        .await
        .map_err(|e| format!("faucet transfer: {e:?}"))?;
    record_txn(
        MINT_ACCOUNT,
        pk,
        FAUCET_AMOUNT,
        [0u8; NONCE_LEN],
        currency,
        now_secs,
        [0u8; NAME_LEN],
        [0u8; NAME_LEN],
        [0u8; MEMO_LEN],
    )?;
    // Re-read the authoritative post-faucet balance: refresh the display cache AND return it (the
    // `Ledger::faucet` contract returns the NEW BALANCE, surfaced by the relay as `{balance}`).
    let new_balance = ledger_balance_of(ledger, &account_of(&pk))
        .await
        .map_err(|e| format!("faucet settled but post-mint balance read failed: {e}"))?;
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
    record_txn(
        pk,
        MINT_ACCOUNT,
        amount,
        [0u8; NONCE_LEN],
        currency,
        now_secs,
        [0u8; NAME_LEN],
        [0u8; NAME_LEN],
        [0u8; MEMO_LEN],
    )?;
    // Refresh the display cache from the authoritative ledger.
    if let Ok(bal) = ledger_balance_of(ledger, &from_acct).await {
        write_cache(pk, currency, bal);
    } else {
        print_log("WARN burn: post-burn cache refresh failed (display-only)");
    }
    Ok(nat_to_u64(&block_index)?)
}

/// Register the ledger for a currency at runtime (INSERT-ONLY, MC2 unit 2). Gated to the controller
/// in production (open only when `controller` is unset, i.e. the demo). Once a currency key exists its
/// ledger principal + `mintable` flag are IMMUTABLE — a re-register with the SAME value is a no-op
/// `Ok` (keeps deploy scripts idempotent / re-runnable), but a DIFFERENT principal or `mintable` flag
/// is REJECTED with a currency-named message. This prevents re-targeting an already-reviewed currency
/// at a fake ledger (or silently flipping a real currency to mintable demo money) under an existing
/// authorization/history. To repoint a currency, retire it and register a new id. Display metadata
/// (`register_currency_meta`) is deliberately NOT frozen here — symbol/decimals/cap are policy/display,
/// not identity, and remain updatable.
#[update]
fn register_ledger(currency: Currency, principal: Principal, mintable: bool) -> Result<(), String> {
    require_admin()?;
    // RETIRED guard (checked BEFORE the insert-only immutability logic): a retired id is dead forever
    // and can NEVER be re-registered — the only replacement is retire + create a new id.
    if is_retired(currency) {
        return Err(format!("currency {currency} is retired; id not reusable"));
    }
    LEDGERS.with(|m| {
        let mut map = m.borrow_mut();
        if let Some(existing) = map.get(&currency) {
            // INSERT-ONLY identity: principal + mintable are part of the immutable identity. Same-value
            // re-register is a no-op Ok (deploy scripts stay re-runnable).
            if existing.principal == principal && existing.mintable == mintable {
                Ok(())
            } else {
                Err(format!(
                    "currency {} ledger is immutable; use retire_currency + a new id to repoint",
                    currency
                ))
            }
        } else {
            map.insert(currency, LedgerEntry { principal, mintable });
            Ok(())
        }
    })
}

/// Register the ck-minter principal for a currency at runtime (INSERT-ONLY, MC2 unit 2). Gated to the
/// controller in production (open only when `controller` is unset, i.e. the demo). A currency need not
/// have a minter (only ck currencies do); absence means the facade exposes no deposit path for it.
/// Once set, the minter principal is IMMUTABLE — a re-register with the SAME principal is a no-op `Ok`
/// (deploy scripts stay re-runnable), but a DIFFERENT principal is REJECTED with a currency-named
/// message. To repoint a currency's minter, retire it and register a new id. (Mirrors `register_ledger`
/// — both are identity, not display/policy.)
#[update]
fn register_minter(currency: Currency, minter: Principal) -> Result<(), String> {
    require_admin()?;
    // RETIRED guard (checked BEFORE the insert-only immutability logic): mirrors `register_ledger` —
    // a retired id's minter can never be re-registered either.
    if is_retired(currency) {
        return Err(format!("currency {currency} is retired; id not reusable"));
    }
    MINTERS.with(|m| {
        let mut map = m.borrow_mut();
        if let Some(existing) = map.get(&currency) {
            if existing.0 == minter {
                Ok(())
            } else {
                Err(format!(
                    "currency {} minter is immutable; use retire_currency + a new id to repoint",
                    currency
                ))
            }
        } else {
            map.insert(currency, PrincipalStorable(minter));
            Ok(())
        }
    })
}

/// Register or replace display/family/authoritative metadata for a currency. Gated to the
/// controller in production. Each `Option` field is registered independently — register only what
/// you know; `None` fields keep the wallet in a best-effort fallback. `onramp`/`offramp` are
/// required (`RampCapability`, non-optional) and stored verbatim — pass `Unavailable` to withdraw a
/// ramp direction honestly. This is what `currencies()` joins in, so the wallet renders asset cards
/// + ramp buttons from a single source of truth (no hardcoded currency ids/symbols, no
/// family-level token assumptions — closes issue #7 + MC1 unit 5).
///
/// RETIRED is intentionally NOT re-checked here (unlike `register_ledger`/`register_minter`/`
/// `register_currency`, which gate on it first): this surface only mutates display/policy metadata,
/// which is INERT on a retired id — `currencies()` filters RETIRED ids out of the catalog, and no
/// money-moving path (`pay`/`mint`/`withdraw`/`refresh_deposit`) ever reads `CURRENCY_META` without
/// first resolving the currency through `ledger_for`/`minter_for`, both of which reject RETIRED. So
/// editing meta on a retired id can change no value flow; it is a cosmetic edit only. (The other
/// three registration paths must reject RETIRED because they rebind the ledger/minter identity a
/// money-moving path dereferences — re-targeting a retired id WOULD reinterpret history.)
#[update]
#[allow(clippy::too_many_arguments)] // flat positional candid args match register_ledger/register_minter
fn register_currency_meta(
    currency: Currency,
    symbol: Option<String>,
    decimals: Option<u8>,
    minter_family: Option<MinterFamily>,
    wrapper_name: Option<String>,
    backing_symbol: Option<String>,
    network: Option<String>,
    display_decimals: Option<u8>,
    fee: Option<u64>,
    cap: Option<u64>,
    chain_id: Option<u32>,
    token_contract: Option<String>,
    onramp: RampCapability,
    offramp: RampCapability,
    gas_ledger: Option<Principal>,
) -> Result<(), String> {
    require_admin()?;
    CURRENCY_META.with(|m| {
        m.borrow_mut().insert(
            currency,
            CurrencyMetaStorable {
                symbol,
                decimals,
                minter_family,
                wrapper_name,
                backing_symbol,
                network,
                display_decimals,
                fee,
                cap,
                chain_id,
                token_contract,
                onramp: Some(onramp),
                offramp: Some(offramp),
                gas_ledger,
            },
        );
    });
    Ok(())
}

/// `(CurrencyRegistration) -> Result<(), text>` — the SINGLE ATOMIC currency-activation path (MC2
/// unit 4). Activates a NEW currency id by inserting LEDGERS + (optionally) MINTERS + CURRENCY_META
/// in ONE update message (all-or-nothing), AFTER strictly validating the identity metadata against
/// the live ledger. Closes the MC2 "atomic validated activation" gap: the piecemeal
/// `register_ledger`/`register_minter`/`register_currency_meta` path is three separate mutable writes
/// with no validation, so an already-reviewed authorization/history could be reinterpreted under a
/// re-targeted ledger or inconsistent metadata.
///
/// Steps (all in one update, so an `Err` at any step rolls back EVERY stable write in this message —
/// nothing is partially inserted):
/// (a) `require_admin` — controller-only in production (open only when `controller` is unset).
/// (b) Immutability + retire guards (reuse U2/U3 intent, checked BEFORE any cross-canister call): a
///     currency already in LEDGERS → Err (register_currency activates a NEW id; use retire + a new id
///     to replace); a RETIRED id → Err ("id not reusable").
/// (c) CROSS-CANISTER STRICT VALIDATION (F3 — no exemptions, including the DEMO currency): call the
///     standard ICRC-1 nullary queries on `reg.ledger` and REJECT on any mismatch:
///       - `icrc1_decimals() -> nat8` must equal `reg.decimals`
///       - `icrc1_fee() -> nat` must equal `reg.fee`
///       - `icrc1_symbol() -> text` must equal `reg.wrapper_name` (the DEMO currency's wrapper_name
///         is the ledger's symbol, e.g. "DUSD")
/// (d) ATOMIC INSERT: LEDGERS + (if `reg.minter` is `Some`) MINTERS + CURRENCY_META, all in the same
///     update message.
///
/// The piecemeal `register_ledger`/`register_minter`/`register_currency_meta` methods REMAIN
/// (deprecated for fresh activation, still useful for incremental display-meta corrections) and still
/// enforce U2 immutability + U3 retire. Deploy scripts SHOULD use `register_currency` for the
/// currencies they register (F5) — see `scripts/dfx-deploy*.sh`.
#[update]
async fn register_currency(reg: CurrencyRegistration) -> Result<(), String> {
    // (a) Admin gate.
    require_admin()?;
    // (b) Immutability + retire guards (BEFORE any cross-canister call — cheap local rejects).
    if is_retired(reg.currency) {
        return Err(format!("currency {} is retired; id not reusable", reg.currency));
    }
    let already_exists = LEDGERS.with(|m| m.borrow().contains_key(&reg.currency));
    if already_exists {
        return Err(format!(
            "currency {} already exists; use retire_currency + a new id to replace",
            reg.currency
        ));
    }
    // (c) Cross-canister strict validation. These are query calls on the target ledger but are legal
    //     from an #[update] (which this is). Mirrors the `ledger_fee` helper's Call::bounded_wait
    //     pattern. Any mismatch → Err and NOTHING is inserted (the IC's per-message transactional
    //     model rolls back all stable writes in this message on a non-Ok return).
    let ledger = reg.ledger;
    let ledger_decimals: u8 = match Call::bounded_wait(ledger, "icrc1_decimals").await {
        Ok(r) => match r.candid() {
            Ok(v) => v,
            Err(e) => return Err(format!("icrc1_decimals decode: {e:?}")),
        },
        Err(e) => return Err(format!("icrc1_decimals rejected: {e:?}")),
    };
    if ledger_decimals != reg.decimals {
        return Err(format!(
            "metadata mismatch: decimals: registration={} ledger={}",
            reg.decimals, ledger_decimals
        ));
    }
    let ledger_fee: u64 = match Call::bounded_wait(ledger, "icrc1_fee").await {
        Ok(r) => match r.candid::<Nat>() {
            Ok(n) => match nat_to_u64(&n) {
                Ok(v) => v,
                Err(e) => return Err(e),
            },
            Err(e) => return Err(format!("icrc1_fee decode: {e:?}")),
        },
        Err(e) => return Err(format!("icrc1_fee rejected: {e:?}")),
    };
    if ledger_fee != reg.fee {
        return Err(format!(
            "metadata mismatch: fee: registration={} ledger={}",
            reg.fee, ledger_fee
        ));
    }
    let ledger_symbol: String = match Call::bounded_wait(ledger, "icrc1_symbol").await {
        Ok(r) => match r.candid() {
            Ok(v) => v,
            Err(e) => return Err(format!("icrc1_symbol decode: {e:?}")),
        },
        Err(e) => return Err(format!("icrc1_symbol rejected: {e:?}")),
    };
    if ledger_symbol != reg.wrapper_name {
        return Err(format!(
            "metadata mismatch: wrapper_name: registration=\"{}\" ledger=\"{}\"",
            reg.wrapper_name, ledger_symbol
        ));
    }
    // (d) Atomic insert — all three registries in the same update message. On the success path the
    //     whole message commits together; there is no partial insert.
    LEDGERS.with(|m| {
        m.borrow_mut()
            .insert(reg.currency, LedgerEntry { principal: reg.ledger, mintable: reg.mintable });
    });
    if let Some(minter) = reg.minter {
        MINTERS.with(|m| {
            m.borrow_mut().insert(reg.currency, PrincipalStorable(minter));
        });
    }
    CURRENCY_META.with(|m| {
        m.borrow_mut().insert(
            reg.currency,
            CurrencyMetaStorable {
                symbol: reg.symbol,
                decimals: Some(reg.decimals),
                minter_family: reg.minter_family,
                wrapper_name: Some(reg.wrapper_name),
                backing_symbol: reg.backing_symbol,
                network: reg.network,
                display_decimals: reg.display_decimals,
                fee: Some(reg.fee),
                cap: reg.cap,
                chain_id: reg.chain_id,
                token_contract: reg.token_contract,
                onramp: Some(reg.onramp),
                offramp: Some(reg.offramp),
                gas_ledger: reg.gas_ledger,
            },
        );
    });
    Ok(())
}

/// `(nat32 currency) -> Result<(), text>` — IRREVERSIBLY retire a currency id (MC2 unit 3). Gated to
/// the controller in production (open only when `controller` is unset, i.e. the demo). A retired id is
/// dead FOREVER: it leaves the wallet catalog (`currencies()` skips it), is rejected by `ledger_for`/
/// `minter_for` (so `pay`/`withdraw`/`mint`/`faucet` reject it), and can NEVER be reused or
/// re-registered (`register_ledger`/`register_minter` reject a retired id before their insert-only
/// logic). Its LEDGERS/MINTERS/CURRENCY_META/ACCOUNT_TXNS rows are NOT deleted — history is preserved
/// for the audit trail (`transactions_of` still returns prior rows). There is NO un-retire method.
/// "Retire + create a new id" is the only replacement — the strongest identity guarantee. Idempotent:
/// retiring an already-retired currency is a no-op `Ok` (the RETIRED set is append-only).
#[update]
fn retire_currency(currency: Currency) -> Result<(), String> {
    require_admin()?;
    RETIRED.with(|r| {
        r.borrow_mut().insert(currency, ());
    });
    Ok(())
}

/// Catalog of every registered currency + its ledger/minter/display/ramp metadata — the wallet's
/// runtime source of truth. The app fetches this once (cached) instead of hardcoding
/// `DEPOSIT_CURRENCY` (issue #7) or family-level token facts (MC1 unit 5). Joins LEDGERS
/// (id + principal + mintable) with MINTERS (ramp principal) and CURRENCY_META (family + display +
/// ramp). A currency appears if it has a ledger; the rest are `None` when not registered. Ramp
/// directions default to `Unavailable` when not registered (fail-closed — the wallet shows NO
/// fund/cash-out button for an unknown ramp). RETIRED currency ids are SKIPPED (a retired id leaves
/// the catalog forever). Unauthenticated (catalog only — no balances); sorted by currency id.
#[query]
fn currencies() -> Vec<CurrencyDescriptor> {
    let entries: Vec<(Currency, LedgerEntry)> =
        LEDGERS.with(|m| m.borrow().iter().map(|(c, e)| (c, e)).collect());
    let mut out: Vec<CurrencyDescriptor> = entries
        .into_iter()
        .filter(|(currency, _)| !is_retired(*currency))
        .map(|(currency, entry)| {
            let minter = MINTERS.with(|m| m.borrow().get(&currency).map(|s| s.0));
            let meta = CURRENCY_META.with(|m| m.borrow().get(&currency));
            CurrencyDescriptor {
                currency,
                ledger: entry.principal,
                mintable: entry.mintable,
                minter,
                minter_family: meta.as_ref().and_then(|x| x.minter_family),
                symbol: meta.as_ref().and_then(|x| x.symbol.clone()),
                decimals: meta.as_ref().and_then(|x| x.decimals),
                wrapper_name: meta.as_ref().and_then(|x| x.wrapper_name.clone()),
                backing_symbol: meta.as_ref().and_then(|x| x.backing_symbol.clone()),
                network: meta.as_ref().and_then(|x| x.network.clone()),
                display_decimals: meta.as_ref().and_then(|x| x.display_decimals),
                fee: meta.as_ref().and_then(|x| x.fee),
                cap: meta.as_ref().and_then(|x| x.cap),
                chain_id: meta.as_ref().and_then(|x| x.chain_id),
                token_contract: meta.as_ref().and_then(|x| x.token_contract.clone()),
                // Fail-closed: a currency with no ramp metadata registered surfaces Unavailable for
                // BOTH directions — the wallet renders no fund/cash-out button for it.
                onramp: meta.as_ref().and_then(|x| x.onramp).unwrap_or(RampCapability::Unavailable),
                offramp: meta.as_ref().and_then(|x| x.offramp).unwrap_or(RampCapability::Unavailable),
                gas_ledger: meta.as_ref().and_then(|x| x.gas_ledger),
            }
        })
        .collect();
    out.sort_by_key(|d| d.currency);
    out
}

// --- icrc3 reconcile (closes the cross-canister trap window) ----------------------------------
// If `pay` traps between the ledger committing `Ok` and `settle_nonce` completing, the IC rolls
// back THIS canister's message — including the SPENT nonce reservation — while the ledger's debit
// does NOT roll back (separate canister). A blind retry could then transfer again. The quantized
// `created_at_time` dedup already mitigates this; `reconcile` is the airtight close: it walks the
// ledger's transaction log, matches each facade-account debit to a recorded SPENT nonce, and repairs
// the orphans (marks the nonce spent + records the txn) so a post-trap retry is correctly treated as
// a duplicate. Admin-gated (controller-only, like the other privileged ops).

/// Cap on how many recent ledger transactions a single `reconcile` scans (single-currency,
/// recent-blocks scope). A long-lived ledger may have archived older blocks; this bounded scan covers
/// the recent window where a trap could have left an orphan. Generalizing to a full archived-block
/// walk + a heartbeat trigger is a documented follow-up (see CODEBASE_ANALYSIS risk 4).
const RECONCILE_MAX_BLOCKS: u64 = 10_000;

/// `(nat32 currency) -> Result<ReconcileReport, text>` — walk the currency's recent ledger
/// transactions and repair any facade-account debit whose nonce is missing from SPENT (the post-trap
/// orphan state). Controller-only. Idempotent: re-running on already-consistent state repairs nothing.
///
/// Match rule: a `transfer` whose `from.owner == canister_self()`, `from.subaccount == Some(pk)`,
/// and whose `memo` is a 16-byte nonce — exactly the shape `pay` produces. Mint/burn use the minting
/// account (subaccount `None`) or carry no nonce memo, so they are not matched. Each repair inserts
/// the nonce into SPENT (so a retry is a duplicate) and records the txn (so history reflects it).
#[update]
async fn reconcile(currency: Currency) -> Result<ReconcileReport, String> {
    require_admin()?;
    let (ledger, _mintable) = ledger_for(currency)?;
    let self_id = canister_self();

    let (log_length, first_index_initial, txs_initial) =
        ledger_get_transactions(ledger, 0, RECONCILE_MAX_BLOCKS).await?;
    // `get_transactions` returns up to `length` from `start`; if the log is longer than the cap, the
    // recent window is what we want (a trap's orphan is recent). Re-fetch the tail when the log
    // exceeds the cap so we scan the NEWEST blocks, not the oldest. Capture the response's
    // `first_index` (the ACTUAL first block index of the returned range — NOT necessarily the
    // requested `start` once archived-range paging is in play) so the loop can derive each
    // transaction's ledger block index: the ICRC-3 `Transaction` itself carries no `block_index`
    // field, and the tx at loop position `i` is ledger block `first_index + i`.
    let (first_index, txs) = if log_length > RECONCILE_MAX_BLOCKS {
        let tail_start = log_length - RECONCILE_MAX_BLOCKS;
        let (_, first_index, txs) =
            ledger_get_transactions(ledger, tail_start, RECONCILE_MAX_BLOCKS).await?;
        (first_index, txs)
    } else {
        (first_index_initial, txs_initial)
    };

    let mut scanned: u64 = 0;
    let mut repaired: u64 = 0;
    for (i, tx) in txs.into_iter().enumerate() {
        scanned += 1;
        let Some(t) = tx.transfer else { continue };
        // Only debits from a user subaccount of THIS canister (a `pay`). Mints use subaccount None;
        // the mint sentinel is rejected as a payee, so a real pay's `to` always has a subaccount.
        if t.from.owner != self_id {
            continue;
        }
        let Some(from_pk) = t.from.subaccount else { continue };
        let Some(nonce) = memo_to_nonce(&t.memo) else { continue };
        let nonce_key = Nonce(nonce);
        let already_spent = SPENT.with(|s| s.borrow().contains_key(&nonce_key));
        if already_spent {
            continue;
        }
        // Orphaned debit (trap window): the ledger moved funds but the nonce reservation was rolled
        // back. Repair: mark the nonce spent (a retry is now a duplicate) + record the txn (history).
        let to_pk = t.to.subaccount.unwrap_or(MINT_ACCOUNT);
        let amount = nat_to_u64(&t.amount).unwrap_or_else(|e| {
            print_log(format!("WARN reconcile: orphaned-debit amount Nat overflow ({e}) — recorded as 0"));
            0
        });
        settle_nonce(&nonce_key);
        // The on-ledger transfer log carries only the ICRC memo (= nonce), NOT the authorization's
        // display names/memo — those live in the signed wire, which is gone post-trap. So a repaired
        // orphan is recorded with empty names (a rare repair path; the names were never persisted).
        record_txn(
            from_pk,
            to_pk,
            amount,
            nonce,
            currency,
            tx.timestamp,
            [0u8; NAME_LEN],
            [0u8; NAME_LEN],
            [0u8; MEMO_LEN],
        )?;
        // Best-effort: refresh the display cache for both sides from the authoritative ledger.
        if let Ok(bal) = ledger_balance_of(ledger, &account_of(&from_pk)).await {
            write_cache(from_pk, currency, bal);
        } else {
            print_log("WARN reconcile: from-side cache refresh failed (display-only)");
        }
        if let Ok(bal) = ledger_balance_of(ledger, &account_of(&to_pk)).await {
            write_cache(to_pk, currency, bal);
        } else {
            print_log("WARN reconcile: to-side cache refresh failed (display-only)");
        }
        // MC4 U2: reconstruct + sign + store a receipt for this orphan so `receipt(nonce)` returns a
        // verifiable canister-signed attestation for EVERY settled payment (a durable recovery
        // primitive requires a signed receipt even for a payment whose post-commit message trapped).
        // The claim mirrors `pay`'s exactly; `block_index = first_index + i` is the orphan's actual
        // ledger block (byte-identical to what a normal pay recorded for the same transfer); `settle_ts` is
        // the on-ledger timestamp (the canister settle time is gone post-trap — the ledger time is
        // the authoritative proxy). Idempotent: skip if a receipt is already stored for this nonce
        // (reconcile is re-runnable — re-running must not error or double-write). The key is ensured
        // here (regenerated on the first orphan after a wipe, since the receipt secret is also
        // stable state that a trap/reinstall can lose); on a normal canister it already exists.
        let already_stored = RECEIPTS.with(|m| m.borrow().contains_key(&nonce_key));
        if !already_stored {
            let receipt_sk = ensure_receipt_key().await?;
            let block_index = first_index + i as u64;
            let claim = ReceiptClaim {
                nonce,
                from: from_pk,
                to: to_pk,
                amount,
                currency,
                block_index,
                settle_ts: tx.timestamp,
            };
            let sig = dpay_core::sign_receipt(&receipt_sk, &claim).to_bytes();
            RECEIPTS.with(|m| {
                m.borrow_mut().insert(
                    nonce_key.clone(),
                    StoredReceipt { claim_bytes: claim.signing_bytes(), sig },
                );
            });
        }
        repaired += 1;
    }
    Ok(ReconcileReport { currency, blocks_scanned: scanned, orphans_repaired: repaired })
}

// --- deposit / withdraw proxy surface ---------------------------------------------------------
// The four minter-proxy entry points (`deposit_address` / `refresh_deposit` / `deposit_info` /
// `withdraw`) + their family-gate helpers (`resolve_minter_family` / `currency_family` /
// `currency_gas_ledger`) live in `proxy.rs` (M7 split along the M6 family-gate seam). They reach
// back into this file via `pub(crate)` for the stable maps + the nonce primitives + `record_txn` /
// `write_cache` / `ledger_for` / `minter_for`. The `#[update]` annotations stay on the methods (the
// canister macros register them into the global method inventory at expansion time, so the public
// candid interface is byte-for-byte unchanged by the move — verified by the green test suite + a
// `.did` diff).

/// Rotate (or, from open/demo mode, set the first) governance principal for `mint`/`burn`/
/// `register_ledger`/`register_minter`/`reconcile`/`set_controller`. Governed by
/// [`require_controller_rotation`]: in open-demo mode (no controller set) any caller may set the
/// first controller — the one-time lockdown path; once a controller is set, only it can rotate
/// (two-step rotation). The PRODUCTION path is to seed a governed principal at `init`
/// (`InitArg::controller`) so the canister never runs in open mode against an adversary. (This gates
/// admin *methods* only. The IC-level canister controller — who can `install_code`/upgrade — is a
/// separate concern set via `dfx`/NNS/SNS; see docs/GOVERNANCE.md.)
#[update]
fn set_controller(new: Option<Principal>) -> Result<(), String> {
    require_controller_rotation()?;
    CONTROLLER
        // SAFETY: admin-only path, controller-gated by require_controller_rotation above; a trap here
        // rejects this admin call, not a money/settlement path.
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
                from_name: name_field_to_string(&r.from_name),
                to_name: name_field_to_string(&r.to_name),
                memo: name_field_to_string(&r.memo),
            })
            .collect()
    })
}

// --- canister-signed receipt (outcome attestation) — public surface ---------------------------
// The receipt key is generated lazily on the first successful `pay` (or eagerly via
// `init_receipt_key`). The public key is exposed so a payer/relay can verify a receipt signature
// before trusting the "Paid ✓" outcome; the signed receipt is stored per nonce and returnable via
// `receipt(nonce)` for replay/reconciliation.

/// `() -> opt blob` — the canister's receipt Ed25519 public key (32 bytes), or `null` if the key
/// has not been generated yet (no successful `pay` and no `init_receipt_key` call). A payer fetches
/// this once and verifies receipt signatures against it.
#[query]
fn receipt_pubkey() -> Option<Vec<u8>> {
    RECEIPT_SECRET.with(|c| {
        c.borrow().get().0.map(|sk| SigningKey::from_bytes(&sk).verifying_key().to_bytes().to_vec())
    })
}

/// `() -> Result<blob, text>` — eagerly generate the receipt keypair (idempotent) and return the
/// public key. Self-service: generating the canister's OWN signing identity moves no value, so any
/// caller may trigger it (an operator/relay calls it once post-deploy so the pubkey is available
/// before any `pay`). The key, once generated, is never rotated.
#[update]
async fn init_receipt_key() -> Result<Vec<u8>, String> {
    let sk = ensure_receipt_key().await?;
    Ok(sk.verifying_key().to_bytes().to_vec())
}

/// `(blob nonce) -> opt ReceiptView` — the canister-signed receipt for a settled payment, looked up
/// by its nonce. Returns `null` if that nonce never settled (or settled before this canister version
/// introduced signed receipts). The payer verifies `receipt_sig` over the canonical
/// `ReceiptClaim{nonce, from, to, amount, currency, block_index, settle_ts}` under `pubkey`
/// (== `receipt_pubkey`) before trusting the outcome — defeating a merchant/relay that lies about it.
#[query]
fn receipt(nonce: Vec<u8>) -> Option<ReceiptView> {
    let n: [u8; NONCE_LEN] = nonce.as_slice().try_into().ok()?;
    let stored = RECEIPTS.with(|m| m.borrow().get(&Nonce(n)))?;
    // Decode the canonical claim bytes back into fields (mirrors ReceiptClaim::signing_bytes).
    let cb = &stored.claim_bytes[..];
    let mut from = [0u8; PUBKEY_LEN];
    from.copy_from_slice(&cb[NONCE_LEN..NONCE_LEN + PUBKEY_LEN]);
    let mut to = [0u8; PUBKEY_LEN];
    to.copy_from_slice(&cb[NONCE_LEN + PUBKEY_LEN..NONCE_LEN + 2 * PUBKEY_LEN]);
    // SAFETY (the 4 `.try_into().unwrap()` calls below): `stored.claim_bytes` is a fixed
    // `[u8; RECEIPT_CLAIM_LEN]` array (= 108) authored by `ReceiptClaim::signing_bytes` (dpay-core).
    // The four slice ranges — amount(8) | currency(4) | block_index(8) | settle_ts(8), starting at
    // `NONCE_LEN + 2*PUBKEY_LEN` (= 80) — exactly consume the tail (80..108), so each conversion is
    // infallible. If `RECEIPT_CLAIM_LEN` or these offsets ever change they MUST change together; a
    // length guard here would guard against an impossible state.
    let amount = u64::from_le_bytes(
        cb[NONCE_LEN + 2 * PUBKEY_LEN..NONCE_LEN + 2 * PUBKEY_LEN + 8].try_into().unwrap(),
    );
    let currency = u32::from_le_bytes(
        cb[NONCE_LEN + 2 * PUBKEY_LEN + 8..NONCE_LEN + 2 * PUBKEY_LEN + 12].try_into().unwrap(),
    );
    let block_index = u64::from_le_bytes(
        cb[NONCE_LEN + 2 * PUBKEY_LEN + 12..NONCE_LEN + 2 * PUBKEY_LEN + 20].try_into().unwrap(),
    );
    let settle_ts = u64::from_le_bytes(
        cb[NONCE_LEN + 2 * PUBKEY_LEN + 20..NONCE_LEN + 2 * PUBKEY_LEN + 28].try_into().unwrap(),
    );
    let pubkey = RECEIPT_SECRET
        .with(|c| c.borrow().get().0.map(|sk| SigningKey::from_bytes(&sk).verifying_key().to_bytes()))
        .map(|p| p.to_vec())
        .unwrap_or_default();
    Some(ReceiptView {
        from: from.to_vec(),
        to: to.to_vec(),
        amount,
        nonce: n.to_vec(),
        currency,
        block_index,
        settle_ts,
        receipt_sig: stored.sig.to_vec(),
        pubkey,
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
