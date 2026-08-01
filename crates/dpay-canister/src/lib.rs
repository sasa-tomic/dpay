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

use candid::{CandidType, Nat, Principal, Reserved};
use ed25519_dalek::{Signature, SigningKey};
use ic_cdk::api::{canister_self, msg_caller, time};
use ic_cdk::call::Call;
use ic_cdk::management_canister::{
    create_canister_with_extra_cycles, raw_rand, CanisterIdRecord, CanisterSettings, CreateCanisterArgs,
};
use ic_cdk::{init, query, update};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::{TransferArg, TransferError};
use icrc_ledger_types::icrc2::approve::{ApproveArgs, ApproveError};
use icrc_ledger_types::icrc3::blocks::GetBlocksRequest;
use icrc_ledger_types::icrc3::transactions::{GetTransactionsResponse, Transaction};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;

use dpay_core::{
    validate, Currency, ReceiptClaim, SignedAuthorization, WithdrawAuth, MEMO_LEN, NAME_LEN,
    NONCE_LEN, PUBKEY_LEN, RECEIPT_CLAIM_LEN, SIG_LEN,
};

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
fn reserve_withdraw_nonce(nonce: &Nonce) -> bool {
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
fn settle_withdraw_nonce(nonce: &Nonce) {
    WITHDRAW_NONCES.with(|s| {
        s.borrow_mut().insert(nonce.clone(), ());
    });
}

/// Release a withdraw reservation so the same authorization may retry (transient/pre-burn failure).
fn release_withdraw_nonce(nonce: &Nonce) {
    WITHDRAW_NONCES.with(|s| {
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

/// A bare principal value: up to 29 principal bytes. Value type of `MINTERS` — a SEPARATE map from
/// `LEDGERS`, so the existing `LedgerEntry` encoding (MemoryId 5) is untouched (no upgrade-layout
/// churn). Mirrors `ControllerStorable`'s principal encoding but without a present-flag byte: the
/// minter map's absence is expressed by map membership, not an in-row flag.
#[derive(Clone, Copy, Debug)]
struct PrincipalStorable(Principal);
impl Storable for PrincipalStorable {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(self.0.as_slice().to_vec())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        PrincipalStorable(Principal::from_slice(&bytes))
    }
    const BOUND: Bound = Bound::Bounded { max_size: 29, is_fixed_size: false };
}

// --- currency catalog: family + display metadata ----------------------------------------------
// The wallet's runtime source of truth for which assets exist and how to display/fund them. A
// `currencies()` query joins LEDGERS + MINTERS + CURRENCY_META so the app never hardcodes a currency
// id (closes issue #7). Because `#[query]` cannot make cross-canister calls, display metadata
// (symbol/decimals) is STORED here (registered via `register_currency_meta`) rather than fetched
// live from each ledger on every call.

/// The proxy family a ck currency's minter belongs to — drives per-family ramp dispatch in the
/// relay/app. Stored as a single byte in `CURRENCY_META`. `None` for non-ck currencies (DEMO_USD).
#[derive(CandidType, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinterFamily {
    /// ckBTC/ckDOGE: `get_btc_address` + `update_balance` + `retrieve_btc_with_approval` (single-ledger).
    CkBtcUtxo = 0,
    /// ckETH/ckUSDC: helper-contract deposit (no IC mint trigger) + `withdraw_erc20` (dual-ledger, ckETH gas).
    CkEthErc20 = 1,
    /// ckSOL: `get_deposit_address` + `process_deposit` + threshold-Ed25519 `withdraw`.
    CkSol = 2,
}

impl MinterFamily {
    fn from_byte(b: u8) -> Option<Self> {
        match b {
            0 => Some(MinterFamily::CkBtcUtxo),
            1 => Some(MinterFamily::CkEthErc20),
            2 => Some(MinterFamily::CkSol),
            _ => None,
        }
    }
}

/// Per-direction ramp capability for a currency (MC1 unit 5). Honesty contract: the wallet renders
/// NO fund/cash-out button for a direction marked `Unavailable` (per CLAUDE.md dpay never swaps and
/// never advertises a ramp it cannot honour — OPEN_ISSUES O3 keeps ckUSDC offramp `Unavailable`).
/// `Direct` = a native chain-key path the facade/wallet drives directly (ckBTC Bitcoin ramp, the
/// DEMO faucet, the ckETH helper-contract onramp); `Partner` = a licensed third-party handoff (dpay
/// is a screen); `Unavailable` = not offered (the fail-closed default for any unregistered currency).
#[derive(CandidType, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum RampCapability {
    /// A native chain-key path the facade/wallet drives directly (ckBTC Bitcoin ramp, DEMO faucet,
    /// the ckETH helper-contract onramp already built client-side).
    Direct = 0,
    /// A licensed third-party handoff: dpay shows an address + status, the user authorizes the
    /// third party directly (dpay never holds keys/creds — preserves no-swap/no-custody).
    Partner = 1,
    /// Not offered. The wallet MUST render no button for this direction.
    Unavailable = 2,
}

impl RampCapability {
    fn from_byte(b: u8) -> Option<Self> {
        match b {
            0 => Some(RampCapability::Direct),
            1 => Some(RampCapability::Partner),
            2 => Some(RampCapability::Unavailable),
            _ => None,
        }
    }
}

/// One entry of the `currencies()` catalog. The wallet reads currency ids + authoritative
/// per-currency metadata from here at runtime instead of hardcoding `DEPOSIT_CURRENCY` (issue #7)
/// or family-level token assumptions (MC1 unit 5: every CkEthErc20 used to inherit USDC's facts). The
/// metadata fields are the single source of truth the relay passes through and the app caches.
///
/// `onramp`/`offramp` are NON-optional (`RampCapability`): an unregistered currency defaults to
/// `Unavailable` for both directions in `currencies()` — fail-closed, so the wallet never shows a
/// fund/cash-out button for a ramp it cannot honour. All other new fields are `Option<...>` so a
/// registration that predates MC1 unit 5 (or only sets what it knows) stays valid.

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CurrencyDescriptor {
    pub currency: Currency,
    pub ledger: Principal,
    /// `true` for the demo currency whose ledger this canister mints/burns.
    pub mintable: bool,
    /// The ck-minter principal — `Some` only when a deposit/withdraw ramp exists for this currency.
    pub minter: Option<Principal>,
    /// The minter's proxy family — present when a family was registered (typically with the minter).
    pub minter_family: Option<MinterFamily>,
    /// Display symbol, e.g. "$"/"₿"/"Ξ". Registered via `register_currency_meta`; `None` = unknown.
    pub symbol: Option<String>,
    /// Smallest-unit decimal count (USD=2, BTC=8, ETH=18, USDC=6). `None` = app guesses.
    pub decimals: Option<u8>,
    /// The IC wrapper token NAME, e.g. "ckBTC"/"ckUSDC" — the chain-key token's own name (distinct
    /// from the backing native chain asset `backing_symbol`). `None` = unknown wrapper.
    pub wrapper_name: Option<String>,
    /// The BACKING native-chain asset symbol, e.g. "BTC"/"USDC"/"ETH" — drives `displayName`/
    /// `currencySymbol` instead of family-level assumptions so each ckERC20 renders as itself.
    pub backing_symbol: Option<String>,
    /// The native settlement network name for display, e.g. "Bitcoin"/"Ethereum". `None` = unknown.
    pub network: Option<String>,
    /// UI display precision; **default = `decimals`** (full precision) when unset. Must be ≤
    /// `decimals` when set (a smaller display precision for readable balances).
    pub display_decimals: Option<u8>,
    /// ICRC ledger fee in RAW smallest units, registered statically (MC2 adds live validation).
    pub fee: Option<u64>,
    /// Per-currency transaction cap in RAW smallest units, registered (MC2 governs). Authoritative
    /// per-currency replacement for the single global `per_tx_cap` for display/policy.
    pub cap: Option<u64>,
    /// EVM chain id for ckERC20 (1=Ethereum mainnet). `None` for non-EVM families.
    pub chain_id: Option<u32>,
    /// The ERC-20 contract address (0x…) for a ckERC20 token — PER-TOKEN, replacing the relay's old
    /// hardcoded currency-2 params. `None` for non-ERC20 families.
    pub token_contract: Option<String>,
    /// Funding (on-ramp) capability. `Unavailable` ⇒ the wallet shows NO "Add money" button.
    pub onramp: RampCapability,
    /// Cash-out (off-ramp) capability. `Unavailable` ⇒ the wallet shows NO "Cash out" button
    /// (ckUSDC offramp is `Unavailable` per Fork-C — OPEN_ISSUES O3).
    pub offramp: RampCapability,
}

/// Atomic currency-activation argument for [`register_currency`] (MC2 unit 4). A single candid
/// RECORD carrying the identity fields (`currency`/`ledger`/`mintable`/`minter`) AND the full display
/// metadata field set (mirroring [`register_currency_meta`]'s arg list EXACTLY, so the meta inserted
/// is identical). `decimals`/`fee`/`wrapper_name` are NON-optional: they are the strict cross-canister
/// validation inputs checked against the live ledger's `icrc1_decimals`/`icrc1_fee`/`icrc1_symbol`
/// (F3 — no exemptions, including the DEMO currency; its `wrapper_name` MUST be the ledger's symbol,
/// e.g. "DUSD"). The remaining meta fields stay `Option`/`RampCapability` exactly as in
/// `register_currency_meta`.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct CurrencyRegistration {
    pub currency: Currency,
    pub ledger: Principal,
    pub mintable: bool,
    /// Optional ck-minter principal (only ck currencies have one). Inserted into MINTERS atomically.
    pub minter: Option<Principal>,
    pub symbol: Option<String>,
    /// REQUIRED — strictly validated against the ledger's `icrc1_decimals`.
    pub decimals: u8,
    pub minter_family: Option<MinterFamily>,
    /// REQUIRED — strictly validated against the ledger's `icrc1_symbol` (the wrapper token name).
    pub wrapper_name: String,
    pub backing_symbol: Option<String>,
    pub network: Option<String>,
    pub display_decimals: Option<u8>,
    /// REQUIRED — strictly validated against the ledger's `icrc1_fee`.
    pub fee: u64,
    pub cap: Option<u64>,
    pub chain_id: Option<u32>,
    pub token_contract: Option<String>,
    pub onramp: RampCapability,
    pub offramp: RampCapability,
}

/// Display + family + authoritative per-currency metadata, stored in `CURRENCY_META` (MemoryId 13).
///
/// Encoding (MC1 unit 5 — additive, fail-closed on truncation): a sequence of self-delimiting
/// fields, each an `Option` encoded as a 1-byte present-flag (0=absent, 1=present) followed by its
/// payload when present:
///   1. symbol          : flag + [len(1) + ≤16 bytes]
///   2. decimals        : flag + [byte(1)]
///   3. minter_family   : flag + [byte(1)]
///   4. wrapper_name    : flag + [len(1) + ≤32 bytes]
///   5. backing_symbol  : flag + [len(1) + ≤16 bytes]
///   6. network         : flag + [len(1) + ≤32 bytes]
///   7. display_decimals: flag + [byte(1)]
///   8. fee             : flag + [u64 LE 8]
///   9. cap             : flag + [u64 LE 8]
///  10. chain_id        : flag + [u32 LE 4]
///  11. token_contract  : flag + [len(1) + ≤64 bytes]
///  12. onramp          : flag + [byte(1)]   (Option<RampCapability>; None→Unavailable default)
///  13. offramp         : flag + [byte(1)]   (Option<RampCapability>; None→Unavailable default)
///
/// `from_bytes` reads each field in order and treats the record as truncated at the first missing
/// byte (the remainder default to `None`) — so a record written by an older canister version (which
/// ends earlier) decodes with the new fields as `None`, and `currencies()` surfaces `Unavailable`
/// ramps for it. Compact; the only repeated registration surface is `register_currency_meta`.
const CURRENCY_META_MAX: usize = (1 + (1 + 16)) + (1 + 1) + (1 + 1) + (1 + (1 + 32)) + (1 + (1 + 16))
    + (1 + (1 + 32)) + (1 + 1) + (1 + 8) + (1 + 8) + (1 + 4) + (1 + (1 + 64)) + (1 + 1) + (1 + 1);

#[derive(Clone, Debug, PartialEq, Eq)]
struct CurrencyMetaStorable {
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
    /// `None` in storage ⇒ `Unavailable` in the returned descriptor (fail-closed ramp default).
    onramp: Option<RampCapability>,
    /// `None` in storage ⇒ `Unavailable` in the returned descriptor (fail-closed ramp default).
    offramp: Option<RampCapability>,
}

/// Push a present-flagged optional string, truncating to `max` bytes (lossy but bounded).
fn push_opt_str(v: &mut Vec<u8>, s: &Option<String>, max: usize) {
    match s {
        Some(s) => {
            let bytes = s.as_bytes();
            let n = bytes.len().min(max) as u8;
            v.push(1u8);
            v.push(n);
            v.extend_from_slice(&bytes[..n as usize]);
        }
        None => v.push(0u8),
    }
}

/// Push a present-flagged optional single byte.
fn push_opt_u8(v: &mut Vec<u8>, x: Option<u8>) {
    match x {
        Some(b) => {
            v.push(1u8);
            v.push(b);
        }
        None => v.push(0u8),
    }
}

/// Push a present-flagged optional little-endian u64.
fn push_opt_u64(v: &mut Vec<u8>, x: Option<u64>) {
    match x {
        Some(n) => {
            v.push(1u8);
            v.extend_from_slice(&n.to_le_bytes());
        }
        None => v.push(0u8),
    }
}

/// Push a present-flagged optional little-endian u32.
fn push_opt_u32(v: &mut Vec<u8>, x: Option<u32>) {
    match x {
        Some(n) => {
            v.push(1u8);
            v.extend_from_slice(&n.to_le_bytes());
        }
        None => v.push(0u8),
    }
}

/// Read a present-flagged optional string of ≤`max` bytes from `b` at `pos`, returning the value and
/// advancing `pos` past it. A flag byte of 0 (or running out of bytes) yields `None`.
fn read_opt_str(b: &[u8], pos: &mut usize, max: usize) -> Option<String> {
    if *pos >= b.len() {
        return None;
    }
    if b[*pos] == 0 {
        *pos += 1;
        return None;
    }
    *pos += 1; // consume flag
    let n = b.get(*pos).copied().unwrap_or(0) as usize;
    *pos += 1;
    let n = n.min(max).min(b.len().saturating_sub(*pos));
    let s = String::from_utf8_lossy(&b[*pos..*pos + n]).to_string();
    *pos += n;
    Some(s)
}

/// Read a present-flagged optional single byte from `b` at `pos`.
fn read_opt_u8(b: &[u8], pos: &mut usize) -> Option<u8> {
    if *pos >= b.len() || b[*pos] == 0 {
        *pos = (*pos + 1).min(b.len());
        return None;
    }
    *pos += 1;
    let v = b.get(*pos).copied();
    *pos += 1;
    v
}

/// Read a present-flagged optional little-endian u64 from `b` at `pos`.
fn read_opt_u64(b: &[u8], pos: &mut usize) -> Option<u64> {
    if *pos >= b.len() || b[*pos] == 0 {
        *pos = (*pos + 1).min(b.len());
        return None;
    }
    *pos += 1;
    if *pos + 8 > b.len() {
        *pos = b.len();
        return None;
    }
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&b[*pos..*pos + 8]);
    *pos += 8;
    Some(u64::from_le_bytes(buf))
}

/// Read a present-flagged optional little-endian u32 from `b` at `pos`.
fn read_opt_u32(b: &[u8], pos: &mut usize) -> Option<u32> {
    if *pos >= b.len() || b[*pos] == 0 {
        *pos = (*pos + 1).min(b.len());
        return None;
    }
    *pos += 1;
    if *pos + 4 > b.len() {
        *pos = b.len();
        return None;
    }
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&b[*pos..*pos + 4]);
    *pos += 4;
    Some(u32::from_le_bytes(buf))
}

impl Storable for CurrencyMetaStorable {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut v = Vec::with_capacity(CURRENCY_META_MAX);
        push_opt_str(&mut v, &self.symbol, 16);
        push_opt_u8(&mut v, self.decimals);
        match self.minter_family {
            Some(f) => {
                v.push(1u8);
                v.push(f as u8);
            }
            None => v.push(0u8),
        }
        push_opt_str(&mut v, &self.wrapper_name, 32);
        push_opt_str(&mut v, &self.backing_symbol, 16);
        push_opt_str(&mut v, &self.network, 32);
        push_opt_u8(&mut v, self.display_decimals);
        push_opt_u64(&mut v, self.fee);
        push_opt_u64(&mut v, self.cap);
        push_opt_u32(&mut v, self.chain_id);
        push_opt_str(&mut v, &self.token_contract, 64);
        match self.onramp {
            Some(r) => {
                v.push(1u8);
                v.push(r as u8);
            }
            None => v.push(0u8),
        }
        match self.offramp {
            Some(r) => {
                v.push(1u8);
                v.push(r as u8);
            }
            None => v.push(0u8),
        }
        Cow::Owned(v)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let b = bytes.as_ref();
        let mut pos = 0usize;
        let symbol = read_opt_str(b, &mut pos, 16);
        let decimals = read_opt_u8(b, &mut pos);
        let minter_family = match read_opt_u8(b, &mut pos) {
            Some(x) => MinterFamily::from_byte(x),
            None => None,
        };
        let wrapper_name = read_opt_str(b, &mut pos, 32);
        let backing_symbol = read_opt_str(b, &mut pos, 16);
        let network = read_opt_str(b, &mut pos, 32);
        let display_decimals = read_opt_u8(b, &mut pos);
        let fee = read_opt_u64(b, &mut pos);
        let cap = read_opt_u64(b, &mut pos);
        let chain_id = read_opt_u32(b, &mut pos);
        let token_contract = read_opt_str(b, &mut pos, 64);
        let onramp = match read_opt_u8(b, &mut pos) {
            Some(x) => RampCapability::from_byte(x),
            None => None,
        };
        let offramp = match read_opt_u8(b, &mut pos) {
            Some(x) => RampCapability::from_byte(x),
            None => None,
        };
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
            onramp,
            offramp,
        }
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: CURRENCY_META_MAX as u32,
        is_fixed_size: false,
    };
}

// --- canister-signed receipt key + stored signed receipts -------------------------------------
// The canister materializes ONE Ed25519 keypair (secret in stable memory, public exposed via
// `receipt_pubkey`) and signs each settled payment's outcome. A merchant/relay cannot forge the
// signature (only the canister holds the secret), so the payer's "Paid ✓" rests on a
// canister-authenticated outcome. See CODEBASE_ANALYSIS risk 3 and dpay_core::ReceiptClaim.

/// The canister's receipt Ed25519 secret key (32 bytes) or `None` before first lazy generation.
/// Encoded as a 1-byte present flag + 32 secret bytes. Stored in a `StableCell` (MemoryId 10) so it
/// survives upgrades — the key is stable across the canister's lifetime (rotating it would
/// invalidate every prior receipt, so it is generated once and never changed).
#[derive(Clone, Copy, Debug)]
struct ReceiptSecretStorable(Option<[u8; 32]>);
impl Storable for ReceiptSecretStorable {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        match self.0 {
            None => Cow::Owned(vec![0u8]),
            Some(sk) => {
                let mut v = Vec::with_capacity(1 + 32);
                v.push(1u8);
                v.extend_from_slice(&sk);
                Cow::Owned(v)
            }
        }
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        match bytes.first().copied() {
            Some(1) if bytes.len() >= 1 + 32 => {
                let mut sk = [0u8; 32];
                sk.copy_from_slice(&bytes[1..1 + 32]);
                ReceiptSecretStorable(Some(sk))
            }
            _ => ReceiptSecretStorable(None),
        }
    }
    const BOUND: Bound = Bound::Bounded { max_size: 1 + 32, is_fixed_size: false };
}

/// The signed receipt stored per nonce (MemoryId 11): the outcome claim's canonical bytes
/// (108, == `RECEIPT_CLAIM_LEN`) followed by the 64-byte Ed25519 signature. Self-describing and
/// deterministic — `receipt(nonce)` decodes it back into the claim fields + sig. Keyed by `Nonce`.
const STORED_RECEIPT_LEN: usize = RECEIPT_CLAIM_LEN + SIG_LEN; // 108 + 64 = 172
#[derive(Clone, Copy, Debug)]
struct StoredReceipt {
    claim_bytes: [u8; RECEIPT_CLAIM_LEN],
    sig: [u8; SIG_LEN],
}
impl Storable for StoredReceipt {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut b = [0u8; STORED_RECEIPT_LEN];
        b[..RECEIPT_CLAIM_LEN].copy_from_slice(&self.claim_bytes);
        b[RECEIPT_CLAIM_LEN..].copy_from_slice(&self.sig);
        Cow::Owned(b.to_vec())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let b = &bytes[..];
        let mut claim_bytes = [0u8; RECEIPT_CLAIM_LEN];
        claim_bytes.copy_from_slice(&b[..RECEIPT_CLAIM_LEN]);
        let mut sig = [0u8; SIG_LEN];
        sig.copy_from_slice(&b[RECEIPT_CLAIM_LEN..RECEIPT_CLAIM_LEN + SIG_LEN]);
        StoredReceipt { claim_bytes, sig }
    }
    const BOUND: Bound =
        Bound::Bounded { max_size: STORED_RECEIPT_LEN as u32, is_fixed_size: true };
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

/// One settled payment, recorded under each side's pubkey. Fixed 196 bytes. Mirrors the wire fields
/// the payer already signed (no fee, no new surfaces — read-only-after-settle). The `from_name` /
/// `to_name` / `memo` fields were added on 2026-07-31 (wire-format v2): display names + an optional
/// memo now ride inside the signed authorization, so the payee sees the payer's name (not a raw
/// pubkey) in history. This is a GREENFIELD wire break — the pre-2026-07-31 100-byte layout is gone,
/// there is no backward-compat path, and the previous "SAME type/layout as the pre-facade shipping
/// canister" claim is stale. Layout (single-sourced from `dpay-core` consts by name):
/// `from(32) | to(32) | amount_le(8) | nonce(16) | currency_le(4) | timestamp_le(8) | from_name(32)
/// | to_name(32) | memo(32)`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct TxnRecord {
    from: [u8; PUBKEY_LEN],
    to: [u8; PUBKEY_LEN],
    amount: u64,
    nonce: [u8; NONCE_LEN],
    currency: Currency,
    timestamp: u64, // unix seconds the ledger settled it (`ic time / 1e9`)
    /// Payer's display name (UTF-8, trailing-NUL padded). From the signed authorization.
    from_name: [u8; NAME_LEN],
    /// Payee's display name (UTF-8, trailing-NUL padded). From the signed authorization.
    to_name: [u8; NAME_LEN],
    /// Optional merchant-set memo (UTF-8, trailing-NUL padded). From the signed authorization.
    memo: [u8; MEMO_LEN],
}
/// `from(32) | to(32) | amount_le(8) | nonce(16) | currency_le(4) | timestamp_le(8) | from_name(32)
/// | to_name(32) | memo(32)` = 196 bytes. Expressed as a sum of the core-sourced widths by name so a
/// future width change propagates without magic numbers.
const TXN_RECORD_LEN: usize =
    PUBKEY_LEN + PUBKEY_LEN + 8 + NONCE_LEN + 4 + 8 + NAME_LEN + NAME_LEN + MEMO_LEN; // 196
impl Storable for TxnRecord {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut b = [0u8; TXN_RECORD_LEN];
        b[..PUBKEY_LEN].copy_from_slice(&self.from);
        b[PUBKEY_LEN..2 * PUBKEY_LEN].copy_from_slice(&self.to);
        b[2 * PUBKEY_LEN..2 * PUBKEY_LEN + 8].copy_from_slice(&self.amount.to_le_bytes());
        b[2 * PUBKEY_LEN + 8..2 * PUBKEY_LEN + 8 + NONCE_LEN].copy_from_slice(&self.nonce);
        b[2 * PUBKEY_LEN + 8 + NONCE_LEN..2 * PUBKEY_LEN + 8 + NONCE_LEN + 4]
            .copy_from_slice(&self.currency.to_le_bytes());
        b[2 * PUBKEY_LEN + 8 + NONCE_LEN + 4..2 * PUBKEY_LEN + 8 + NONCE_LEN + 4 + 8]
            .copy_from_slice(&self.timestamp.to_le_bytes());
        // The three name/memo fields: raw 32-byte copies at the END (after timestamp). They are
        // already NUL-padded fixed arrays (the app NUL-pads/truncates before signing), so a plain
        // copy is the canonical, little-endian-independent encoding.
        let off = 2 * PUBKEY_LEN + 8 + NONCE_LEN + 4 + 8;
        b[off..off + NAME_LEN].copy_from_slice(&self.from_name);
        b[off + NAME_LEN..off + 2 * NAME_LEN].copy_from_slice(&self.to_name);
        b[off + 2 * NAME_LEN..off + 2 * NAME_LEN + MEMO_LEN].copy_from_slice(&self.memo);
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
            b[2 * PUBKEY_LEN + 8 + NONCE_LEN + 4..2 * PUBKEY_LEN + 8 + NONCE_LEN + 4 + 8]
                .try_into()
                .unwrap(),
        );
        let off = 2 * PUBKEY_LEN + 8 + NONCE_LEN + 4 + 8;
        let mut from_name = [0u8; NAME_LEN];
        from_name.copy_from_slice(&b[off..off + NAME_LEN]);
        let mut to_name = [0u8; NAME_LEN];
        to_name.copy_from_slice(&b[off + NAME_LEN..off + 2 * NAME_LEN]);
        let mut memo = [0u8; MEMO_LEN];
        memo.copy_from_slice(&b[off + 2 * NAME_LEN..off + 2 * NAME_LEN + MEMO_LEN]);
        TxnRecord { from, to, amount, nonce, currency, timestamp, from_name, to_name, memo }
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
    static CURRENCY_META: RefCell<StableBTreeMap<Currency, CurrencyMetaStorable, Memory>> =
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
    /// The ICRC ledger block index where the transfer landed (outcome proof; part of the signed
    /// receipt claim). Additive field (R2) — these R2 outcome-attestation fields are outside the
    /// payer's signed authorization (wire-format v2: the authorization INPUT is now 196 bytes and now
    /// carries `from_name`/`to_name`/`memo`, added 2026-07-31; the R2 receipt fields remain a
    /// canister-authored OUTCOME layer on top, untouched by the wire-format change).
    block_index: u64,
    /// Unix seconds the canister recorded the settle (part of the signed claim). Additive (R2).
    settle_ts: u64,
    /// The canister's Ed25519 signature over the canonical [`ReceiptClaim`] (108 bytes). Verify with
    /// `receipt_pubkey` (or the `pubkey` field) before trusting the outcome. Additive (R2).
    receipt_sig: Vec<u8>,
    /// The canister's receipt public key (32 bytes), included so a payer can verify in one round
    /// trip without a separate `receipt_pubkey` query. Additive (R2).
    pubkey: Vec<u8>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct TxnView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    timestamp: u64,
    /// Payer's display name (decoded from the signed 32-byte NUL-padded field; empty if unset).
    from_name: String,
    /// Payee's display name (decoded from the signed 32-byte NUL-padded field; empty if unset).
    to_name: String,
    /// Optional merchant-set memo (decoded from the signed 32-byte NUL-padded field; empty if unset).
    memo: String,
}

/// Decode a fixed 32-byte NUL-padded UTF-8 field (a display name or memo) into a Rust `String`,
/// trimming trailing NULs. Never panics: arbitrary non-UTF8 bytes decode lossily (the builder is
/// responsible for padding valid UTF-8, but history must never trap on a corrupt/foreign field).
/// Empty (all-zero) → empty string. Generic over the array width so it serves both `NAME_LEN` and
/// `MEMO_LEN` (both are 32 today).
fn name_field_to_string<const N: usize>(b: &[u8; N]) -> String {
    let bytes: Vec<u8> = b.iter().take_while(|&&c| c != 0).copied().collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The canister-signed receipt for a settled payment, returned by `receipt(nonce)`. Carries the
/// outcome claim fields + the Ed25519 signature + the canister's public key, so a payer verifies
/// the outcome without a separate `receipt_pubkey` round trip.
#[derive(CandidType, Deserialize, Clone, Debug)]
struct ReceiptView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    block_index: u64,
    settle_ts: u64,
    receipt_sig: Vec<u8>,
    pubkey: Vec<u8>,
}

// --- ck-minter deposit proxy (ckBTC model) ----------------------------------------------------
// The facade proxies a chain-key minter (ckBTC today; ckETH shares the seam). The minter mints onto
// the currency's ICRC ledger at `Account{owner: canister_self(), subaccount: pubkey}` — exactly the
// account `pay`/`icrc1_balance_of`/`transactions_of` already operate on — so this surface is purely
// informational + orchestration: it changes NOTHING about settlement, balance, or history.

/// Normalized deposit parameters for a currency (minter `get_minter_info` + `get_deposit_fee`), which
/// the app renders as the deposit instructions.
#[derive(CandidType, Deserialize, Clone, Debug)]
struct DepositInfo {
    min_confirmations: u32,
    deposit_fee: u64,                 // sats; from `get_deposit_fee`
    deposit_min_amount: Option<u64>,  // from `get_minter_info`
}

/// One UTXO the minter minted in THIS `update_balance` call. `block_index` is the ICRC ledger block
/// of the mint; `amount` is in sats.
#[derive(CandidType, Deserialize, Clone, Debug)]
struct MintedUtxo {
    block_index: Nat,
    amount: u64,
}

/// A UTXO the minter has seen but is still awaiting confirmations on (from `NoNewUtxos`).
#[derive(CandidType, Deserialize, Clone, Debug)]
struct PendingUtxo {
    value: u64,
    confirmations: u64,
}

/// Normalized result of a `refresh_deposit` (minter `update_balance`): what minted this call, what is
/// still pending, and the confirmation threshold still required.
#[derive(CandidType, Deserialize, Clone, Debug)]
struct DepositRefresh {
    minted: Vec<MintedUtxo>,
    minted_total: u64,
    pending: Vec<PendingUtxo>,
    required_confirmations: u32,
}

// Mirror types for decoding the REAL ckBTC minter's candid replies. Internal only —
// `export_candid!()` emits just types referenced by `#[update]`/`#[query]` signatures, so these stay
// out of the public surface (like `LedgerEntry`/`CacheKey` already do). `candid::Reserved` absorbs
// sub-records we don't surface (`utxo`, suspended lists); subtype decode tolerates any extra fields
// the real minter may add, so a mainnet field-name divergence is a local edit here, not a break.
#[derive(CandidType, Deserialize)]
enum UtxoStatus {
    Minted { block_index: Nat, minted_amount: Nat, utxo: Reserved },
    Checked(Reserved),
    ValueTooSmall(Reserved),
    Tainted(Reserved),
}

#[derive(CandidType, Deserialize)]
enum UpdateBalanceError {
    NoNewUtxos {
        current_confirmations: Option<u64>,
        required_confirmations: u32,
        pending_utxos: Option<Vec<PendingUtxoMirror>>,
        suspended_utxos: Option<Reserved>,
    },
    AlreadyProcessing,
    TemporarilyUnavailable(String),
    GenericError { error_code: Option<Nat>, error_message: String },
}

#[derive(CandidType, Deserialize)]
struct PendingUtxoMirror {
    outpoint: Reserved,
    value: Nat,
    confirmations: Option<u64>,
}

#[derive(CandidType, Deserialize)]
struct MinterInfo {
    min_confirmations: u32,
    retrieve_btc_min_amount: u64,
    kyt_fee: u64,
    deposit_btc_min_amount: Option<u64>,
}

/// The single record argument the REAL ckBTC minter takes for `get_btc_address` / `update_balance` —
/// verified against `dfx canister metadata mqygn-kiaaa-aaaar-qaadq-cai candid:service --network ic`:
///   `(record { owner: opt principal; subaccount : opt blob })`.
/// Each method takes exactly ONE record argument (NOT two positional args). Encoding it as a candid
/// 2-tuple `(Option<Principal>, Option<Vec<u8>>)` via `with_args` sends TWO positional args, which the
/// real minter rejects with `IC0503 ... Fail to decode argument 0 ... Subtyping error: Type mismatch`.
/// A 1-tuple `(MinterAccount{..},)` is a single argument (one record), which decodes correctly.
#[derive(CandidType, Deserialize)]
struct MinterAccount {
    owner: Option<Principal>,
    subaccount: Option<Vec<u8>>,
}

// --- ck-minter retrieve proxy (ckBTC → BTC withdrawal) ----------------------------------------
// Mirror types for decoding the REAL ckBTC minter's `retrieve_btc_with_approval` candid reply,
// verified against `dfx canister metadata mqygn-kiaaa-aaaar-qaadq-cai candid:service --network ic`:
//   `retrieve_btc_with_approval : (RetrieveBtcWithApprovalArgs) ->
//       (variant { Ok : RetrieveBtcOk; Err : RetrieveBtcWithApprovalError })`
// where `RetrieveBtcWithApprovalArgs = record { address : text; amount : nat64; from_subaccount :
// opt blob }` and `RetrieveBtcOk = record { block_index : nat64 }`. Field/variant labels mirror the
// real minter exactly so the decode is wire-compatible with mainnet. Internal only — kept out of the
// public candid surface (like `LedgerEntry`/`CacheKey`).

/// Minimal withdrawal amount the facade rejects locally, in sats. Mirrors the LIVE ckBTC minter's
/// `retrieve_btc_min_amount` (= 50_000, returned by `get_minter_info` on `mqygn-kiaaa-aaaar-qaadq-cai`
// and confirmed in OPEN_ISSUES.md). The minter enforces it too (returns `AmountTooLow`); the facade
// rejects early to save cycles and give a clean error. Single-sourced here so the canister's local
// floor and the docs can't drift.
const RETRIEVE_BTC_MIN_AMOUNT: u64 = 50_000;

#[derive(CandidType, Deserialize)]
struct RetrieveBtcWithApprovalArgs {
    address: String,
    amount: u64,
    from_subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Deserialize)]
struct RetrieveBtcOk {
    block_index: Nat,
}

#[derive(CandidType, Deserialize, Debug)]
enum RetrieveBtcWithApprovalError {
    MalformedAddress(String),
    AlreadyProcessing,
    AmountTooLow(u64),
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    TemporarilyUnavailable(String),
    GenericError { error_message: String, error_code: Nat },
}

/// The candid argument the facade's `withdraw` takes: the user's signed authorization fields +
/// the Ed25519 signature over the canonical [`dpay_core::WithdrawAuth`] signing bytes. The facade
/// rebuilds the [`dpay_core::WithdrawAuth`] from these fields, recomputes the signing bytes (single
/// source of truth in `dpay-core`), and verifies the signature under `from_pubkey` BEFORE moving any
/// funds — the non-custodial gate.
#[derive(CandidType, Deserialize)]
struct WithdrawRequest {
    from_pubkey: Vec<u8>,
    destination: String,
    amount: u64,
    nonce: Vec<u8>,
    expiry: u64,
    currency: Currency,
    sig: Vec<u8>,
}

/// The facade's withdrawal receipt, returned on a successful burn. Mirrors the relay's
/// [`crate::WithdrawReceipt`] surface. `block_index` is the ckBTC ledger's burn transaction index
/// (from the minter's `RetrieveBtcOk`); `amount`/`destination` echo the authorization so the app can
/// render "Withdrew X BTC to bc1…". (No canister-signed receipt for withdraw — the pay receipt (R2)
/// is the outcome-attestation surface; the withdraw outcome is the on-ledger burn + the minter's BTC
// send, reconciled via the ckBTC ledger / `retrieve_btc_status`, not a facade signature.)
#[derive(CandidType, Deserialize, Clone, Debug)]
struct WithdrawReceipt {
    from: Vec<u8>,
    destination: String,
    amount: u64,
    nonce: Vec<u8>,
    currency: Currency,
    block_index: u64,
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
/// Honors RETIRED: a retired currency id is dead forever and resolves to an error (so `pay`/`mint`/
/// `burn`/`faucet`/`reconcile` all reject it) — its LEDGERS row is preserved for history but is no
/// longer reachable through the live settlement path.
fn ledger_for(currency: Currency) -> Result<(Principal, bool), String> {
    if is_retired(currency) {
        return Err(format!("currency {currency} is retired"));
    }
    LEDGERS.with(|m| m.borrow().get(&currency))
        .map(|e| (e.principal, e.mintable))
        .ok_or_else(|| format!("unknown currency {currency}"))
}

/// Resolve a currency to its ck-minter principal (only ck currencies have one). Absent -> Err.
/// Honors RETIRED (same as `ledger_for`): a retired currency's minter is unreachable.
fn minter_for(currency: Currency) -> Result<Principal, String> {
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

// --- ck-minter cross-canister proxies ---------------------------------------------------------
// Mirror the `ledger_*` helpers: `Call::bounded_wait(minter, "<method>").with_args(&arg).await` then
// `response.candid::<T>()`. Minter methods are permissionless (GeneralAvailability on mainnet), so
// these carry no caller gate; the facade passes `owner = Some(canister_self())`,
// `subaccount = Some(pubkey)` — so the mint lands on the currency's ledger at exactly the account
// `pay`/`balance_of` use. No new dependency surfaces: the facade stays non-custodial (it never holds
// the deposited BTC; the minter does the chain-key work and credits the ledger directly).

/// Minter `get_btc_address(record { owner, subaccount }) -> text` — the user's native deposit
/// address. The real ckBTC minter takes ONE record argument; the 1-tuple `(MinterAccount{..},)`
/// encodes exactly one argument (a record), which decodes to `{ owner, subaccount }`.
async fn minter_call_btc_address(minter: Principal, sub: Vec<u8>) -> Result<String, String> {
    let arg = (MinterAccount { owner: Some(canister_self()), subaccount: Some(sub) },);
    let response = Call::bounded_wait(minter, "get_btc_address")
        .with_args(&arg)
        .await
        .map_err(|e| format!("get_btc_address rejected: {e:?}"))?;
    response.candid::<String>().map_err(|e| format!("get_btc_address decode: {e:?}"))
}

/// Minter `update_balance` — the value-creating call that mints confirmed UTXOs. The real ckBTC
/// minter takes ONE record argument; the 1-tuple `(MinterAccount{..},)` encodes exactly one argument.
/// Reply is `Result<Vec<UtxoStatus>, UpdateBalanceError>`: `Ok` carries the statuses of UTXOs
/// processed this call; `Err(NoNewUtxos{..})` is the normal "nothing new, here is what is still
/// pending" response.
async fn minter_call_update_balance(
    minter: Principal,
    sub: Vec<u8>,
) -> Result<Result<Vec<UtxoStatus>, UpdateBalanceError>, String> {
    let arg = (MinterAccount { owner: Some(canister_self()), subaccount: Some(sub) },);
    let response = Call::bounded_wait(minter, "update_balance")
        .with_args(&arg)
        .await
        .map_err(|e| format!("update_balance rejected: {e:?}"))?;
    response
        .candid::<Result<Vec<UtxoStatus>, UpdateBalanceError>>()
        .map_err(|e| format!("update_balance decode: {e:?}"))
}

/// Minter `get_minter_info() -> MinterInfo`.
async fn minter_call_minter_info(minter: Principal) -> Result<MinterInfo, String> {
    let response = Call::bounded_wait(minter, "get_minter_info")
        .await
        .map_err(|e| format!("get_minter_info rejected: {e:?}"))?;
    response.candid::<MinterInfo>().map_err(|e| format!("get_minter_info decode: {e:?}"))
}

/// Minter `get_deposit_fee() -> nat64` — the per-mint fee in sats.
async fn minter_call_deposit_fee(minter: Principal) -> Result<u64, String> {
    let response = Call::bounded_wait(minter, "get_deposit_fee")
        .await
        .map_err(|e| format!("get_deposit_fee rejected: {e:?}"))?;
    response.candid::<u64>().map_err(|e| format!("get_deposit_fee decode: {e:?}"))
}

/// Minter `retrieve_btc_with_approval(RetrieveBtcWithApprovalArgs) -> Result<RetrieveBtcOk,
/// RetrieveBtcWithApprovalError>` — the value-creating call that burns ckBTC and sends native BTC to
/// `address`. The real ckBTC minter takes ONE record argument (verified via `dfx canister metadata
/// … candid:service --network ic`); encoded here as a 1-tuple `(args,)` so `with_args` emits exactly
/// one argument (the record). The facade passes `from_subaccount = Some(pubkey)`, so the minter pulls
/// `amount` ckBTC from `Account{owner: canister_self(), subaccount: pubkey}` via `icrc2_transfer_from`
/// (consuming the allowance the facade just set via [`icrc2_approve`]).
async fn minter_call_retrieve_btc(
    minter: Principal,
    args: RetrieveBtcWithApprovalArgs,
) -> Result<Result<RetrieveBtcOk, RetrieveBtcWithApprovalError>, String> {
    let arg = (args,);
    let response = Call::bounded_wait(minter, "retrieve_btc_with_approval")
        .with_args(&arg)
        .await
        .map_err(|e| format!("retrieve_btc_with_approval rejected: {e:?}"))?;
    response
        .candid::<Result<RetrieveBtcOk, RetrieveBtcWithApprovalError>>()
        .map_err(|e| format!("retrieve_btc_with_approval decode: {e:?}"))
}

/// Cross-canister `icrc2_approve` — grants `spender` an allowance of `amount` from
/// `from_subaccount` on the ckBTC ledger. The facade is the owner of `Account{owner: canister_self(),
/// subaccount: pubkey}`, so it may approve the minter to pull (via `transfer_from`) the withdrawal
/// amount. This is the ckBTC withdrawal primitive: approve the minter, then call
/// `retrieve_btc_with_approval` which consumes the allowance. The approval is for EXACTLY the
/// withdrawal amount (bounded blast radius — see the front-running note on `withdraw`).
async fn icrc2_approve(
    ledger: Principal,
    from_subaccount: [u8; PUBKEY_LEN],
    spender: Account,
    amount: u64,
) -> Result<Nat, ApproveError> {
    let arg = ApproveArgs {
        from_subaccount: Some(from_subaccount),
        spender,
        amount: Nat::from(amount),
        expected_allowance: None,
        expires_at: None,
        fee: None,
        memo: None,
        created_at_time: Some(time()),
    };
    let response = match Call::bounded_wait(ledger, "icrc2_approve")
        .with_arg(arg)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Err(ApproveError::GenericError {
                error_code: Nat::from(503u64),
                message: format!("icrc2_approve rejected: {e:?}"),
            });
        }
    };
    response.candid::<Result<Nat, ApproveError>>().map_err(|e| ApproveError::GenericError {
        error_code: Nat::from(502u64),
        message: format!("icrc2_approve decode: {e:?}"),
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
        .with(|c| c.borrow_mut().set(ReceiptSecretStorable(Some(sk))).expect("set receipt secret"));
    Ok(SigningKey::from_bytes(&sk))
}

// --- self-service demo faucet -----------------------------------------------------------------
// The faucet is the demo on-ramp: a freshly-onboarded account mints a FIXED amount of play money
// on a mintable currency, rate-limited per (account, currency). It is the ONLY way a non-controller
// creates demo currency — the privileged `mint`/`burn` are controller-only (see `require_admin`).
// Both constants are single-sourced here; the relay/app reference the faucet by method name, never
// by re-declaring the amount (a client cannot request a different amount — the faucet always mints
// `FAUCET_AMOUNT`).

/// Fixed amount the faucet mints per call, in minor units (cents) = **$100.00**. The self-service
/// surface cannot print more than this in one call regardless of what a client asks.
const FAUCET_AMOUNT: u64 = 10_000;

/// Per-(account, currency) faucet cooldown in seconds. One faucet mint per account per currency per
/// window — guards the self-service path against a single account draining the demo minting account
/// by repeated calls. Generous for a demo; make it a governed parameter before any pilot.
const FAUCET_COOLDOWN_SECS: u64 = 60 * 60; // 1 hour

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
        // payer may retry the SAME nonce.
        Err(TransferError::InsufficientFunds { .. }) | Err(TransferError::TemporarilyUnavailable) => {
            release_nonce(&nonce);
            return Err(format!("transient: {:?}", "ledger busy/insufficient"));
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
    );
    let new_from_balance = ledger_balance_of(ledger, &from_acct).await.unwrap_or_else(|_| {
        balance.saturating_sub(amount).saturating_sub(fee)
    });
    // Refresh the display cache for both sides (best-effort; never blocks settlement).
    write_cache(from, currency, new_from_balance);
    if let Ok(to_bal) = ledger_balance_of(ledger, &to_acct).await {
        write_cache(to, currency, to_bal);
    }

    // Sign the outcome receipt. The block index caps at u64 (the demo's ledgers never exceed it;
    // a Nat overflow surfaces as block_index=0, which still verifies under the same key — the
    // amount/nonce/from/to/currency/ts bind the claim, and the sig is canister-authored).
    let block_index = nat_to_u64(&block_index_nat).unwrap_or(0);
    let receipt_sk = ensure_receipt_key().await?;
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

fn record_txn(
    from: [u8; PUBKEY_LEN],
    to: [u8; PUBKEY_LEN],
    amount: u64,
    nonce: [u8; NONCE_LEN],
    currency: Currency,
    timestamp: u64,
    from_name: [u8; NAME_LEN],
    to_name: [u8; NAME_LEN],
    memo: [u8; MEMO_LEN],
) {
    let seq = TXN_SEQ.with(|c| {
        let v = *c.borrow().get();
        c.borrow_mut().set(v + 1).expect("advance txn seq");
        v
    });
    let rec = TxnRecord { from, to, amount, nonce, currency, timestamp, from_name, to_name, memo };
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

/// `(blob pubkey, nat32 currency) -> Result<nat64, text>` — the AUTHORITATIVE on-demand balance
/// refresh (MC3 U1). Reads the live ledger balance via `icrc1_balance_of` for
/// `Account{owner: canister_self(), subaccount: pubkey}`, writes it to `BAL_CACHE` (so the fast
/// `balance_of` query reflects it on subsequent reads), and returns it.
///
/// **No auth gate** — consistent with the unauthenticated `balance_of`/`deposit_address` surface:
/// this is a read + a cache write that moves NO value; it only ever credits the named pubkey's
/// true balance. Use this to surface credits that bypass the facade: asynchronous ckERC20 heartbeat
/// mints and direct ICRC transfers land on the ledger WITHOUT invoking the facade, so `BAL_CACHE`
/// stays stale until this is called. Settlement (`pay`) NEVER reads this — it reads the ledger
/// directly (the money-safety invariant is unchanged).
///
/// Modeled EXACTLY on the post-mint authoritative read in `mint` (re-read + `write_cache`).
#[update]
async fn refresh_balance(pubkey: Vec<u8>, currency: Currency) -> Result<u64, String> {
    let pk = to_pubkey(&pubkey)?;
    let (ledger, _) = ledger_for(currency)?;
    let bal = ledger_balance_of(ledger, &account_of(&pk))
        .await
        .map_err(|e| format!("refresh_balance ledger read: {e}"))?;
    write_cache(pk, currency, bal);
    Ok(bal)
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
    );
    // Re-read the authoritative post-mint balance: refresh the display cache AND return it. The
    // `Ledger` trait contract is that `mint` returns the NEW BALANCE (FakeLedger honors this; the
    // relay faucet surfaces the return directly as `{balance}`), NOT the ledger's block index.
    let new_balance = ledger_balance_of(ledger, &account_of(&pk))
        .await
        .map_err(|e| format!("mint settled but post-mint balance read failed: {e}"))?;
    write_cache(pk, currency, new_balance);
    Ok(new_balance)
}

/// `(blob account, nat32 currency) -> Result<nat64, text>` — the self-service demo on-ramp. Mints
/// a FIXED [`FAUCET_AMOUNT`] ($100.00) of a mintable currency to `account`, rate-limited per
/// (account, currency) via [`FAUCET_COOLDOWN`] (one mint per [`FAUCET_COOLDOWN_SECS`] window). No
/// admin gate — this is the path the relay's `/faucet` route calls so a freshly-onboarded wallet can
/// fund itself without the controller. The privileged [`mint`] (arbitrary amount) stays
/// controller-only; the faucet always mints the fixed constant, so a client cannot print unbounded
/// funds. Refreshes the display cache from the authoritative ledger post-mint and returns the new
/// balance (matching the `Ledger::faucet` contract the relay surfaces as `{balance}`).
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
    );
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
    );
    // Refresh the display cache from the authoritative ledger.
    if let Ok(bal) = ledger_balance_of(ledger, &from_acct).await {
        write_cache(pk, currency, bal);
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

#[derive(CandidType, Deserialize, Clone, Debug)]
struct ReconcileReport {
    currency: Currency,
    /// Ledger transactions examined (the recent window actually scanned).
    blocks_scanned: u64,
    /// Orphaned debits repaired (ledger moved funds, SPENT had no nonce → marked spent + recorded).
    orphans_repaired: u64,
}

/// Cross-canister `get_transactions` (the typed ICRC ledger endpoint) → `(log_length, transactions)`.
/// Uses the typed `Transaction` reply rather than hand-decoding generic ICRC-3 blocks: more robust
/// against block-layout drift, and the cached `ic-icrc1-ledger` exposes it. Only the in-canister
/// recent transactions are returned (archived ranges are not paged in this bounded version).
async fn ledger_get_transactions(
    ledger: Principal,
    start: u64,
    length: u64,
) -> Result<(u64, Vec<Transaction>), String> {
    let req = GetBlocksRequest { start: Nat::from(start), length: Nat::from(length) };
    let response = Call::bounded_wait(ledger, "get_transactions")
        .with_arg(req)
        .await
        .map_err(|e| format!("get_transactions rejected: {e:?}"))?;
    let res: GetTransactionsResponse = response
        .candid()
        .map_err(|e| format!("get_transactions decode: {e:?}"))?;
    let log_length = nat_to_u64(&res.log_length)?;
    Ok((log_length, res.transactions))
}

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

    let (log_length, txs) = ledger_get_transactions(ledger, 0, RECONCILE_MAX_BLOCKS).await?;
    // `get_transactions` returns up to `length` from `start`; if the log is longer than the cap, the
    // recent window is what we want (a trap's orphan is recent). Re-fetch the tail when the log
    // exceeds the cap so we scan the NEWEST blocks, not the oldest.
    let txs = if log_length > RECONCILE_MAX_BLOCKS {
        let start = log_length - RECONCILE_MAX_BLOCKS;
        ledger_get_transactions(ledger, start, RECONCILE_MAX_BLOCKS).await?.1
    } else {
        txs
    };

    let mut scanned: u64 = 0;
    let mut repaired: u64 = 0;
    for tx in txs {
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
        let amount = nat_to_u64(&t.amount).unwrap_or(0);
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
        );
        // Best-effort: refresh the display cache for both sides from the authoritative ledger.
        if let Ok(bal) = ledger_balance_of(ledger, &account_of(&from_pk)).await {
            write_cache(from_pk, currency, bal);
        }
        if let Ok(bal) = ledger_balance_of(ledger, &account_of(&to_pk)).await {
            write_cache(to_pk, currency, bal);
        }
        repaired += 1;
    }
    Ok(ReconcileReport { currency, blocks_scanned: scanned, orphans_repaired: repaired })
}

/// The facade sets `memo = nonce` (16 bytes) on every `pay` transfer. Extract it; anything else
/// (None, wrong length) is not a pay debit → not a reconcile target.
fn memo_to_nonce(memo: &Option<icrc_ledger_types::icrc1::transfer::Memo>) -> Option<[u8; NONCE_LEN]> {
    let m = memo.as_ref()?;
    let bytes = m.0.as_slice();
    if bytes.len() == NONCE_LEN {
        let mut n = [0u8; NONCE_LEN];
        n.copy_from_slice(bytes);
        Some(n)
    } else {
        None
    }
}

/// `(blob pubkey, nat32 currency) -> Result<text, text>`. Proxies the minter's `get_btc_address` —
/// the user's native deposit address for the currency. No auth: a deposit address is not secret
/// (revealing it only lets someone send *to* the user), and minter methods are permissionless. Bad
/// pubkey length is rejected up front via `to_pubkey`.
#[update]
async fn deposit_address(pubkey: Vec<u8>, currency: Currency) -> Result<String, String> {
    let _pk = to_pubkey(&pubkey)?; // validate length; the minter takes the subaccount as a blob
    let minter = minter_for(currency)?;
    minter_call_btc_address(minter, pubkey).await
}

/// `(blob pubkey, nat32 currency) -> Result<DepositRefresh, text>`. Proxies the minter's
/// `update_balance` — the value-creating call that mints confirmed UTXOs onto the currency's ledger
/// at `Account{owner: canister_self(), subaccount: pubkey}`. No auth: idempotent and safe to call by
/// anyone (a no-op when no confirmed UTXOs exist). `Ok(statuses)` -> minted list + total, empty
/// pending; `Err(NoNewUtxos{..})` -> empty minted + pending mapped from the error; the remaining
/// minter errors surface as `Err(String)`.
///
/// After a successful minter call (both the `Ok(statuses)` and the `NoNewUtxos` branches), the
/// display cache is refreshed from the authoritative ledger so a freshly-minted deposit is
/// immediately visible via `balance_of` WITHOUT an extra `refresh_balance` call (MC3 U1). The
/// `NoNewUtxos` branch is hit every 10s poll and catches coincident direct transfers / async mints
/// for free (the ~1 extra `icrc1_balance_of` per 10s-poll-per-user is negligible). The cache refresh
/// is deliberately NOT added to the AlreadyProcessing / TemporarilyUnavailable / GenericError
/// branches — the minter call FAILED there and the cache state is unknown, so we do not paper over
/// it with a speculative read.
#[update]
async fn refresh_deposit(pubkey: Vec<u8>, currency: Currency) -> Result<DepositRefresh, String> {
    let pk = to_pubkey(&pubkey)?;
    let minter = minter_for(currency)?;
    let (ledger, _) = ledger_for(currency)?;
    match minter_call_update_balance(minter, pubkey).await? {
        Ok(statuses) => {
            let mut minted = Vec::with_capacity(statuses.len());
            let mut minted_total: u64 = 0;
            for st in statuses {
                if let UtxoStatus::Minted { block_index, minted_amount, .. } = st {
                    let amount = nat_to_u64(&minted_amount)?;
                    minted_total = minted_total.checked_add(amount).ok_or("minted_total overflow")?;
                    minted.push(MintedUtxo { block_index, amount });
                }
                // Checked / ValueTooSmall / Tainted carry no mint this call; skip silently — the
                // UTXO is reported again by a subsequent `update_balance` (or never, if tainted).
            }
            // Inline cache refresh: a freshly-minted ckBTC deposit must be immediately visible via
            // `balance_of` WITHOUT an extra refresh_balance call (MC3 U1). Modeled on `mint`'s
            // post-mint authoritative re-read. Best-effort: a read failure does not undo the mint.
            if let Ok(bal) = ledger_balance_of(ledger, &account_of(&pk)).await {
                write_cache(pk, currency, bal);
            }
            Ok(DepositRefresh {
                minted,
                minted_total,
                pending: Vec::new(),
                required_confirmations: 0,
            })
        }
        Err(UpdateBalanceError::NoNewUtxos { required_confirmations, pending_utxos, .. }) => {
            let pending = pending_utxos
                .unwrap_or_default()
                .into_iter()
                .map(|p| -> Result<PendingUtxo, String> {
                    let value = nat_to_u64(&p.value)?;
                    Ok(PendingUtxo { value, confirmations: p.confirmations.unwrap_or(0) })
                })
                .collect::<Result<Vec<_>, _>>()?;
            // Inline cache refresh in the NoNewUtxos branch too: this branch is hit every 10s poll
            // and catches coincident direct transfers / async mints for free. Consistent contract:
            // "after refresh_deposit returns, the cache reflects the ledger" (MC3 U1).
            if let Ok(bal) = ledger_balance_of(ledger, &account_of(&pk)).await {
                write_cache(pk, currency, bal);
            }
            Ok(DepositRefresh {
                minted: Vec::new(),
                minted_total: 0,
                pending,
                required_confirmations,
            })
        }
        Err(UpdateBalanceError::AlreadyProcessing) => {
            Err("update_balance already processing".to_string())
        }
        Err(UpdateBalanceError::TemporarilyUnavailable(m)) => {
            Err(format!("update_balance temporarily unavailable: {m}"))
        }
        Err(UpdateBalanceError::GenericError { error_code, error_message }) => Err(format!(
            "update_balance generic error{}: {error_message}",
            error_code.map(|c| format!(" (code {c})")).unwrap_or_default()
        )),
    }
}

/// `(nat32 currency) -> Result<DepositInfo, text>`. Combines the minter's `get_minter_info` and
/// `get_deposit_fee` into the normalized deposit parameters the app renders as instructions.
#[update]
async fn deposit_info(currency: Currency) -> Result<DepositInfo, String> {
    let minter = minter_for(currency)?;
    let info = minter_call_minter_info(minter).await?;
    let deposit_fee = minter_call_deposit_fee(minter).await?;
    Ok(DepositInfo {
        min_confirmations: info.min_confirmations,
        deposit_fee,
        deposit_min_amount: info.deposit_btc_min_amount,
    })
}

// --- ck-minter withdrawal proxy (ckBTC → native BTC out) --------------------------------------
// The mirror of the deposit proxy: where `refresh_deposit` mints IN confirmed BTC, `withdraw` burns
// OUT ckBTC to a native BTC address. The facade is the OWNER of the ckBTC held at
// `Account{owner: canister_self(), subaccount: pubkey}`, so on a VERIFIED USER SIGNATURE it (1)
// `icrc2_approve`s the minter to pull `amount` from that subaccount, then (2) calls the minter's
// `retrieve_btc_with_approval`, which consumes the allowance via `icrc2_transfer_from` and sends BTC
// to the user's address. Non-custodial: the facade moves nothing without a verified Ed25519
// signature over the canonical [`WithdrawAuth`] bytes (single source of truth in `dpay-core`).
//
// FRONT-RUNNING NOTE (documented residual risk, same as every `retrieve_btc_with_approval` caller):
// the approval + retrieve are two cross-canister calls with an `await` between them. In principle a
// separate caller could invoke the minter's `retrieve_btc_with_approval` with the same subaccount +
// an attacker address between the facade's approve and retrieve, consuming the allowance. The blast
// radius is bounded to the EXACT authorized `amount` (the approval is for that amount, single-use),
// so only one withdrawal's worth of ckBTC could be misdirected — never the user's whole balance. This
// is inherent to the ckBTC withdrawal design (the minter has no signature-binding-the-destination
// path); the reference NNS minter clients accept the same residual. See CODEBASE_ANALYSIS.

/// `(WithdrawRequest) -> Result<WithdrawReceipt, text>` — withdraw ckBTC to a native BTC address on a
/// verified user signature. The request carries the [`WithdrawAuth`] fields + the user's Ed25519
/// signature over the canonical signing bytes; the facade verifies the signature under `from_pubkey`
/// (== the debit subaccount) before moving any funds.
///
/// Idempotency / replay safety mirrors `pay`: the withdraw nonce is reserved synchronously before any
/// cross-canister call (the concurrency barrier — two concurrent withdraws with the same nonce
/// cannot both succeed), released on a transient/pre-burn failure (the same auth may retry), and
/// settled once the burn commits (the auth can never replay → no double-burn).
#[update]
async fn withdraw(req: WithdrawRequest) -> Result<WithdrawReceipt, String> {
    // 1. Parse + length-validate the fields (cheap, before any signature/ledger work).
    let from = to_pubkey(&req.from_pubkey)?;
    let nonce_bytes: [u8; NONCE_LEN] = req
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| "bad nonce length".to_string())?;
    let sig_arr: [u8; SIG_LEN] = req
        .sig
        .as_slice()
        .try_into()
        .map_err(|_| "bad sig length".to_string())?;
    let sig = Signature::from_bytes(&sig_arr);

    // 2. NON-CUSTODIAL GATE: rebuild the WithdrawAuth + verify the signature BEFORE reserving the
    //    nonce or any cross-canister call. `from_pubkey` is both the verify key AND the debit
    //    subaccount, so a signature under any other key moves no funds. Checked before the nonce
    //    reserve so an attacker can't block a nonce by submitting a garbled blob.
    let auth = WithdrawAuth {
        from_pubkey: from,
        destination: req.destination.clone(),
        amount: req.amount,
        nonce: nonce_bytes,
        expiry: req.expiry,
        currency: req.currency,
    };
    if !auth.verify(&from, &sig) {
        return Err("bad signature".to_string());
    }

    let now_secs = time() / 1_000_000_000;
    // 3. Cheap local rejects (DoS hygiene before cross-canister calls cost cycles).
    if req.amount == 0 {
        return Err("zero amount".to_string());
    }
    if req.expiry < now_secs {
        return Err("expired".to_string());
    }
    if req.amount < RETRIEVE_BTC_MIN_AMOUNT {
        return Err(format!(
            "amount below retrieve_btc_min_amount ({RETRIEVE_BTC_MIN_AMOUNT})"
        ));
    }

    let (ledger, _mintable) = ledger_for(req.currency)?;
    let minter = minter_for(req.currency)?;
    let from_acct = account_of(&from);

    // 4. Reserve the withdraw nonce synchronously (no await) — the concurrency barrier.
    let wnonce = Nonce(nonce_bytes);
    if !reserve_withdraw_nonce(&wnonce) {
        return Err("nonce already used".to_string());
    }

    // Everything below may `await`; on any pre-burn failure we RELEASE the reservation so the user
    // may retry the SAME authorization (funds provably did not move).
    // MONEY-SAFETY: read the AUTHORITATIVE ledger balance — never the display cache.
    let balance = match ledger_balance_of(ledger, &from_acct).await {
        Ok(b) => b,
        Err(e) => {
            release_withdraw_nonce(&wnonce);
            return Err(e);
        }
    };
    if req.amount > balance {
        release_withdraw_nonce(&wnonce);
        return Err(format!(
            "{:?}",
            TransferError::InsufficientFunds { balance: Nat::from(balance) }
        ));
    }

    // 5. icrc2_approve: grant the minter an allowance of EXACTLY `amount` over the user's subaccount.
    //    Any approve failure → release (no burn happened); the user may retry the same authorization.
    let spender = Account { owner: minter, subaccount: None };
    if let Err(e) = icrc2_approve(ledger, from, spender, req.amount).await {
        release_withdraw_nonce(&wnonce);
        return Err(format!("icrc2_approve: {e}"));
    }

    // 6. retrieve_btc_with_approval: the minter consumes the allowance (transfer_from) and sends BTC
    //    to `destination`. Error classification (mirrors `pay`'s reserve/release/settle):
    //      Ok → SETTLE the nonce (burn committed; the auth can never replay → no double-burn);
    //      transient (TemporarilyUnavailable / AlreadyProcessing / InsufficientFunds /
    //      InsufficientAllowance / a transport failure) → RELEASE (retryable; funds did not move);
    //      permanent (MalformedAddress / AmountTooLow / GenericError) → SETTLE (dead auth; the user
    //      must sign a fresh authorization).
    let retrieve_args = RetrieveBtcWithApprovalArgs {
        address: req.destination.clone(),
        amount: req.amount,
        from_subaccount: Some(from.to_vec()),
    };
    let block_index_nat = match minter_call_retrieve_btc(minter, retrieve_args).await {
        Ok(Ok(ok)) => {
            settle_withdraw_nonce(&wnonce);
            ok.block_index
        }
        Ok(Err(RetrieveBtcWithApprovalError::TemporarilyUnavailable(m))) => {
            release_withdraw_nonce(&wnonce);
            return Err(format!("retrieve_btc transient: {m}"));
        }
        Ok(Err(RetrieveBtcWithApprovalError::AlreadyProcessing)) => {
            release_withdraw_nonce(&wnonce);
            return Err("retrieve_btc already processing".to_string());
        }
        Ok(Err(RetrieveBtcWithApprovalError::InsufficientFunds { balance })) => {
            release_withdraw_nonce(&wnonce);
            return Err(format!("retrieve_btc insufficient funds: balance {balance}"));
        }
        Ok(Err(RetrieveBtcWithApprovalError::InsufficientAllowance { allowance })) => {
            release_withdraw_nonce(&wnonce);
            return Err(format!("retrieve_btc insufficient allowance: {allowance}"));
        }
        Ok(Err(e)) => {
            // MalformedAddress / AmountTooLow / GenericError — permanent; burn the nonce so the dead
            // auth can never replay. The user must sign a fresh authorization.
            settle_withdraw_nonce(&wnonce);
            return Err(format!("retrieve_btc: {e:?}"));
        }
        Err(transport) => {
            // A transport/decode failure between approve and the minter's reply. Funds may or may not
            // have moved — release is the retryable choice (matches `pay`'s transient handling); the
            // single-use nonce keeps a successful-but-unreported burn from being driven twice by a
            // DIFFERENT auth, and the user's same-auth retry reconciles via the ckBTC ledger.
            release_withdraw_nonce(&wnonce);
            return Err(transport);
        }
    };

    // 7. Committed: the burn landed (or had already, via the minter). Record the withdraw in history
    //    (counterparty = the MINT_ACCOUNT sentinel, like `burn`) + refresh the display cache from the
    //    authoritative ledger.
    let settle_secs = time() / 1_000_000_000;
    record_txn(
        from,
        MINT_ACCOUNT,
        req.amount,
        nonce_bytes,
        req.currency,
        settle_secs,
        [0u8; NAME_LEN],
        [0u8; NAME_LEN],
        [0u8; MEMO_LEN],
    );
    if let Ok(bal) = ledger_balance_of(ledger, &from_acct).await {
        write_cache(from, req.currency, bal);
    }
    Ok(WithdrawReceipt {
        from: from.to_vec(),
        destination: req.destination,
        amount: req.amount,
        nonce: nonce_bytes.to_vec(),
        currency: req.currency,
        block_index: nat_to_u64(&block_index_nat).unwrap_or(0),
    })
}

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
