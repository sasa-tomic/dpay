//! Data types for the dpay payment canister.
//!
//! Pure data definitions extracted from `lib.rs` along the types seam: structs, enums,
//! `Storable` impls, stable-encoding helpers, and the candid API/mirror types. No
//! `thread_local!` state and no canister entry points live here — see `lib.rs` for the
//! architectural docs and `calls.rs` for the cross-canister helpers.

use candid::{CandidType, Nat, Principal, Reserved};
use ic_stable_structures::memory_manager::VirtualMemory;
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, Storable};
use serde::Deserialize;
use std::borrow::Cow;

use dpay_core::{Currency, MEMO_LEN, NAME_LEN, NONCE_LEN, PUBKEY_LEN, RECEIPT_CLAIM_LEN, SIG_LEN};

pub(crate) type Memory = VirtualMemory<DefaultMemoryImpl>;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Nonce(pub(crate) [u8; NONCE_LEN]);
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

// --- per-currency ledger registry -------------------------------------------------------------
// A currency resolves to the ICRC ledger that holds its balances, plus whether this canister is
// allowed to mint/burn it (demo currency only).

/// 1 mintable flag + up to 29 principal bytes.
pub(crate) const LEDGER_ENTRY_MAX: usize = 1 + 29;

#[derive(Clone, Copy, Debug)]
pub(crate) struct LedgerEntry {
    pub(crate) principal: Principal,
    pub(crate) mintable: bool,
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
pub(crate) struct ControllerStorable(pub(crate) Option<Principal>);
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
pub(crate) struct PrincipalStorable(pub(crate) Principal);
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
    pub(crate) fn from_byte(b: u8) -> Option<Self> {
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
    pub(crate) fn from_byte(b: u8) -> Option<Self> {
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
    /// The ckETH gas-ledger principal for a ckERC20 currency (the `withdraw_erc20` dual-ledger path
    /// burns ckETH gas fees from this ledger + the amount from `ledger`). `None` for non-ckERC20
    /// families (BTC / native ETH / DEMO) and for a ckERC20 currency whose gas ledger is unregistered
    /// (the facade fail-closes a ckERC20 withdraw with no gas ledger). Appended LAST for stable-
    /// encoding backward compat (an older `CURRENCY_META` row decodes with this as `None`).
    pub gas_ledger: Option<Principal>,
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
    /// The ckETH gas-ledger principal for a ckERC20 currency (the dual-ledger `withdraw_erc20` path).
    /// `None` for non-ckERC20 families. Stored verbatim into `CURRENCY_META.gas_ledger`.
    pub gas_ledger: Option<Principal>,
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
///   12. onramp          : flag + [byte(1)]   (Option<RampCapability>; None→Unavailable default)
///  13. offramp         : flag + [byte(1)]   (Option<RampCapability>; None→Unavailable default)
///  14. gas_ledger       : flag + [len(1) + ≤29 bytes]   (Option<Principal>; the ckETH gas ledger
///      for a ckERC20 currency's `withdraw_erc20` dual-ledger path. Appended LAST so an older
///      CURRENCY_META row — written before this field existed — decodes with gas_ledger = None.)
///
/// `from_bytes` reads each field in order and treats the record as truncated at the first missing
/// byte (the remainder default to `None`) — so a record written by an older canister version (which
/// ends earlier) decodes with the new fields as `None`, and `currencies()` surfaces `Unavailable`
/// ramps for it. Compact; the only repeated registration surface is `register_currency_meta`.
pub(crate) const CURRENCY_META_MAX: usize = (1 + (1 + 16)) + (1 + 1) + (1 + 1) + (1 + (1 + 32)) + (1 + (1 + 16))
    + (1 + (1 + 32)) + (1 + 1) + (1 + 8) + (1 + 8) + (1 + 4) + (1 + (1 + 64)) + (1 + 1) + (1 + 1)
    + (1 + (1 + 29));

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CurrencyMetaStorable {
    pub(crate) symbol: Option<String>,
    pub(crate) decimals: Option<u8>,
    pub(crate) minter_family: Option<MinterFamily>,
    pub(crate) wrapper_name: Option<String>,
    pub(crate) backing_symbol: Option<String>,
    pub(crate) network: Option<String>,
    pub(crate) display_decimals: Option<u8>,
    pub(crate) fee: Option<u64>,
    pub(crate) cap: Option<u64>,
    pub(crate) chain_id: Option<u32>,
    pub(crate) token_contract: Option<String>,
    /// `None` in storage ⇒ `Unavailable` in the returned descriptor (fail-closed ramp default).
    pub(crate) onramp: Option<RampCapability>,
    /// `None` in storage ⇒ `Unavailable` in the returned descriptor (fail-closed ramp default).
    pub(crate) offramp: Option<RampCapability>,
    /// The ckETH gas-ledger principal for a ckERC20 currency's dual-ledger `withdraw_erc20` path.
    /// `None` for non-ckERC20 families. `PrincipalStorable` semantics (raw ≤29 bytes); stored under a
    /// present-flag + length-prefixed payload for forward-compat.
    pub(crate) gas_ledger: Option<Principal>,
}

/// Push a present-flagged optional string, truncating to `max` bytes (lossy but bounded).
pub(crate) fn push_opt_str(v: &mut Vec<u8>, s: &Option<String>, max: usize) {
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
pub(crate) fn push_opt_u8(v: &mut Vec<u8>, x: Option<u8>) {
    match x {
        Some(b) => {
            v.push(1u8);
            v.push(b);
        }
        None => v.push(0u8),
    }
}

/// Push a present-flagged optional little-endian u64.
pub(crate) fn push_opt_u64(v: &mut Vec<u8>, x: Option<u64>) {
    match x {
        Some(n) => {
            v.push(1u8);
            v.extend_from_slice(&n.to_le_bytes());
        }
        None => v.push(0u8),
    }
}

/// Push a present-flagged optional little-endian u32.
pub(crate) fn push_opt_u32(v: &mut Vec<u8>, x: Option<u32>) {
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
pub(crate) fn read_opt_str(b: &[u8], pos: &mut usize, max: usize) -> Option<String> {
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
pub(crate) fn read_opt_u8(b: &[u8], pos: &mut usize) -> Option<u8> {
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
pub(crate) fn read_opt_u64(b: &[u8], pos: &mut usize) -> Option<u64> {
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
pub(crate) fn read_opt_u32(b: &[u8], pos: &mut usize) -> Option<u32> {
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

/// Push a present-flagged optional principal, length-prefixed (≤29 bytes; mirrors `push_opt_str`).
/// The length byte keeps the record forward-compat (a future field after gas_ledger can be read even
/// when gas_ledger is present).
pub(crate) fn push_opt_principal(v: &mut Vec<u8>, p: &Option<Principal>) {
    match p {
        Some(p) => {
            let bytes = p.as_slice();
            let n = bytes.len().min(29) as u8;
            v.push(1u8);
            v.push(n);
            v.extend_from_slice(&bytes[..n as usize]);
        }
        None => v.push(0u8),
    }
}

/// Read a present-flagged optional length-prefixed principal (≤29 bytes) from `b` at `pos`.
pub(crate) fn read_opt_principal(b: &[u8], pos: &mut usize) -> Option<Principal> {
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
    let n = n.min(29).min(b.len().saturating_sub(*pos));
    let p = Principal::from_slice(&b[*pos..*pos + n]);
    *pos += n;
    Some(p)
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
        push_opt_principal(&mut v, &self.gas_ledger);
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
        let gas_ledger = read_opt_principal(b, &mut pos);
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
            gas_ledger,
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
pub(crate) struct ReceiptSecretStorable(pub(crate) Option<[u8; 32]>);
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
pub(crate) const STORED_RECEIPT_LEN: usize = RECEIPT_CLAIM_LEN + SIG_LEN; // 108 + 64 = 172
#[derive(Clone, Copy, Debug)]
pub(crate) struct StoredReceipt {
    pub(crate) claim_bytes: [u8; RECEIPT_CLAIM_LEN],
    pub(crate) sig: [u8; SIG_LEN],
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

pub(crate) const CURRENCY_LEN: usize = core::mem::size_of::<Currency>();
pub(crate) const CACHE_KEY_LEN: usize = CURRENCY_LEN + PUBKEY_LEN; // 4 + 32

/// Cache key: `currency_le(4) | pubkey(32)`. currency-major ordering is fine (no range query needed).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct CacheKey(pub(crate) [u8; CACHE_KEY_LEN]);
impl CacheKey {
    pub(crate) fn new(pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Self {
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
pub(crate) const CACHED_BALANCE_LEN: usize = 8 + 8;
#[derive(Clone, Copy, Debug)]
pub(crate) struct CachedBalance {
    pub(crate) amount: u64,
    pub(crate) fetched_at_secs: u64,
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

// --- local history index (so `transactions_of` is a fast local query; the ICRC-3 block log on the
//     ledger is the durable source of truth and could replace this) ----------------------------

pub(crate) const SEQ_LEN: usize = 8;
pub(crate) const TXN_KEY_LEN: usize = PUBKEY_LEN + CURRENCY_LEN + SEQ_LEN;

/// Sentinel "account" used as the counterparty in mint/burn history rows. A real Ed25519 pubkey is
/// a valid curve point, so this all-ones value can never be a user's pubkey — `verify_strict`
/// rejects it. Lets mint/burn appear in `transactions_of` without changing `TxnRecord`'s shape.
pub(crate) const MINT_ACCOUNT: [u8; PUBKEY_LEN] = [0xFF; PUBKEY_LEN];

/// Index key for a settled transaction: `pubkey(32) | currency_le(4) | seq_be(8)` = 44 bytes.
/// pubkey-major ordering keeps every (account, currency) block contiguous; `seq` is big-endian so a
/// forward range walks oldest→newest (and reversing yields newest-first). One record is inserted
/// under `from` AND under `to`, so an account's full history is a single contiguous key range.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct AccountTxnKey(pub(crate) [u8; TXN_KEY_LEN]);
impl AccountTxnKey {
    pub(crate) fn new(pubkey: [u8; PUBKEY_LEN], currency: Currency, seq: u64) -> Self {
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
pub(crate) struct TxnRecord {
    pub(crate) from: [u8; PUBKEY_LEN],
    pub(crate) to: [u8; PUBKEY_LEN],
    pub(crate) amount: u64,
    pub(crate) nonce: [u8; NONCE_LEN],
    pub(crate) currency: Currency,
    pub(crate) timestamp: u64, // unix seconds the ledger settled it (`ic time / 1e9`)
    /// Payer's display name (UTF-8, trailing-NUL padded). From the signed authorization.
    pub(crate) from_name: [u8; NAME_LEN],
    /// Payee's display name (UTF-8, trailing-NUL padded). From the signed authorization.
    pub(crate) to_name: [u8; NAME_LEN],
    /// Optional merchant-set memo (UTF-8, trailing-NUL padded). From the signed authorization.
    pub(crate) memo: [u8; MEMO_LEN],
}
/// `from(32) | to(32) | amount_le(8) | nonce(16) | currency_le(4) | timestamp_le(8) | from_name(32)
/// | to_name(32) | memo(32)` = 196 bytes. Expressed as a sum of the core-sourced widths by name so a
/// future width change propagates without magic numbers.
pub(crate) const TXN_RECORD_LEN: usize =
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

/// Configuration for one currency, supplied at init (and via `register_ledger`).
#[derive(CandidType, Deserialize)]
pub(crate) struct LedgerConfig {
    pub(crate) currency: Currency,
    pub(crate) principal: Principal,
    /// `true` for the demo currency whose ledger `minting_account.owner` is this canister (so
    /// `mint`/`burn` are allowed). `false` for real ck currencies — dpay only moves funds.
    pub(crate) mintable: bool,
}

#[derive(CandidType, Deserialize)]
pub(crate) struct InitArg {
    pub(crate) ledgers: Vec<LedgerConfig>,
    pub(crate) per_tx_cap: u64,
    /// Governance principal permitted to call `mint`/`burn`/`register_ledger`/`set_controller`.
    /// `null` = open (the demo default). Production MUST set a governed controller.
    pub(crate) controller: Option<Principal>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub(crate) struct PayReceipt {
    pub(crate) from: Vec<u8>,
    pub(crate) to: Vec<u8>,
    pub(crate) amount: u64,
    pub(crate) nonce: Vec<u8>,
    pub(crate) new_from_balance: u64,
    /// The ICRC ledger block index where the transfer landed (outcome proof; part of the signed
    /// receipt claim). Additive field (R2) — these R2 outcome-attestation fields are outside the
    /// payer's signed authorization (wire-format v2: the authorization INPUT is now 196 bytes and now
    /// carries `from_name`/`to_name`/`memo`, added 2026-07-31; the R2 receipt fields remain a
    /// canister-authored OUTCOME layer on top, untouched by the wire-format change).
    pub(crate) block_index: u64,
    /// Unix seconds the canister recorded the settle (part of the signed claim). Additive (R2).
    pub(crate) settle_ts: u64,
    /// The canister's Ed25519 signature over the canonical [`ReceiptClaim`] (108 bytes). Verify with
    /// `receipt_pubkey` (or the `pubkey` field) before trusting the outcome. Additive (R2).
    pub(crate) receipt_sig: Vec<u8>,
    /// The canister's receipt public key (32 bytes), included so a payer can verify in one round
    /// trip without a separate `receipt_pubkey` query. Additive (R2).
    pub(crate) pubkey: Vec<u8>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub(crate) struct TxnView {
    pub(crate) from: Vec<u8>,
    pub(crate) to: Vec<u8>,
    pub(crate) amount: u64,
    pub(crate) nonce: Vec<u8>,
    pub(crate) currency: u32,
    pub(crate) timestamp: u64,
    /// Payer's display name (decoded from the signed 32-byte NUL-padded field; empty if unset).
    pub(crate) from_name: String,
    /// Payee's display name (decoded from the signed 32-byte NUL-padded field; empty if unset).
    pub(crate) to_name: String,
    /// Optional merchant-set memo (decoded from the signed 32-byte NUL-padded field; empty if unset).
    pub(crate) memo: String,
}

/// Decode a fixed 32-byte NUL-padded UTF-8 field (a display name or memo) into a Rust `String`,
/// trimming trailing NULs. Never panics: arbitrary non-UTF8 bytes decode lossily (the builder is
/// responsible for padding valid UTF-8, but history must never trap on a corrupt/foreign field).
/// Empty (all-zero) → empty string. Generic over the array width so it serves both `NAME_LEN` and
/// `MEMO_LEN` (both are 32 today).
pub(crate) fn name_field_to_string<const N: usize>(b: &[u8; N]) -> String {
    let bytes: Vec<u8> = b.iter().take_while(|&&c| c != 0).copied().collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// One entry of a `refresh_all_balances` batch result: the currency id + its freshly-read
/// authoritative balance (minor units). Returned by the batch refresh endpoint that reads ALL
/// registered currencies' balances in a SINGLE update call (one consensus round), replacing the
/// relay's N separate `refresh_balance` calls. A per-currency ledger hiccup keeps the last-known
/// cached value (settlement always reads the ledger directly; the cache is display-only).
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BalanceEntry {
    pub currency: Currency,
    pub amount: u64,
}

/// The canister-signed receipt for a settled payment, returned by `receipt(nonce)`. Carries the
/// outcome claim fields + the Ed25519 signature + the canister's public key, so a payer verifies
/// the outcome without a separate `receipt_pubkey` round trip.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub(crate) struct ReceiptView {
    pub(crate) from: Vec<u8>,
    pub(crate) to: Vec<u8>,
    pub(crate) amount: u64,
    pub(crate) nonce: Vec<u8>,
    pub(crate) currency: u32,
    pub(crate) block_index: u64,
    pub(crate) settle_ts: u64,
    pub(crate) receipt_sig: Vec<u8>,
    pub(crate) pubkey: Vec<u8>,
}

// --- ck-minter deposit proxy (ckBTC model) ----------------------------------------------------
// The facade proxies a chain-key minter (ckBTC today; ckETH shares the seam). The minter mints onto
// the currency's ICRC ledger at `Account{owner: canister_self(), subaccount: pubkey}` — exactly the
// account `pay`/`icrc1_balance_of`/`transactions_of` already operate on — so this surface is purely
// informational + orchestration: it changes NOTHING about settlement, balance, or history.

/// Normalized deposit parameters for a currency (minter `get_minter_info` + `get_deposit_fee`), which
/// the app renders as the deposit instructions.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub(crate) struct DepositInfo {
    pub(crate) min_confirmations: u32,
    pub(crate) deposit_fee: u64,                 // sats; from `get_deposit_fee`
    pub(crate) deposit_min_amount: Option<u64>,  // from `get_minter_info`
}

/// One UTXO the minter minted in THIS `update_balance` call. `block_index` is the ICRC ledger block
/// of the mint; `amount` is in sats.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub(crate) struct MintedUtxo {
    pub(crate) block_index: Nat,
    pub(crate) amount: u64,
}

/// A UTXO the minter has seen but is still awaiting confirmations on (from `NoNewUtxos`).
#[derive(CandidType, Deserialize, Clone, Debug)]
pub(crate) struct PendingUtxo {
    pub(crate) value: u64,
    pub(crate) confirmations: u64,
}

/// Normalized result of a `refresh_deposit` (minter `update_balance`): what minted this call, what is
/// still pending, and the confirmation threshold still required.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub(crate) struct DepositRefresh {
    pub(crate) minted: Vec<MintedUtxo>,
    pub(crate) minted_total: u64,
    pub(crate) pending: Vec<PendingUtxo>,
    pub(crate) required_confirmations: u32,
}

// Mirror types for decoding the REAL ckBTC minter's candid replies. Internal only —
// `export_candid!()` emits just types referenced by `#[update]`/`#[query]` signatures, so these stay
// out of the public surface (like `LedgerEntry`/`CacheKey` already do). `candid::Reserved` absorbs
// sub-records we don't surface (`utxo`, suspended lists); subtype decode tolerates any extra fields
// the real minter may add, so a mainnet field-name divergence is a local edit here, not a break.
#[derive(CandidType, Deserialize)]
pub(crate) enum UtxoStatus {
    Minted { block_index: Nat, minted_amount: Nat, utxo: Reserved },
    Checked(Reserved),
    ValueTooSmall(Reserved),
    Tainted(Reserved),
}

#[derive(CandidType, Deserialize)]
pub(crate) enum UpdateBalanceError {
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
pub(crate) struct PendingUtxoMirror {
    pub(crate) outpoint: Reserved,
    pub(crate) value: Nat,
    pub(crate) confirmations: Option<u64>,
}

#[derive(CandidType, Deserialize)]
pub(crate) struct MinterInfo {
    pub(crate) min_confirmations: u32,
    pub(crate) retrieve_btc_min_amount: u64,
    pub(crate) kyt_fee: u64,
    pub(crate) deposit_btc_min_amount: Option<u64>,
}

/// The single record argument the REAL ckBTC minter takes for `get_btc_address` / `update_balance` —
/// verified against `dfx canister metadata mqygn-kiaaa-aaaar-qaadq-cai candid:service --network ic`:
///   `(record { owner: opt principal; subaccount : opt blob })`.
/// Each method takes exactly ONE record argument (NOT two positional args). Encoding it as a candid
/// 2-tuple `(Option<Principal>, Option<Vec<u8>>)` via `with_args` sends TWO positional args, which the
/// real minter rejects with `IC0503 ... Fail to decode argument 0 ... Subtyping error: Type mismatch`.
/// A 1-tuple `(MinterAccount{..},)` is a single argument (one record), which decodes correctly.
#[derive(CandidType, Deserialize)]
pub(crate) struct MinterAccount {
    pub(crate) owner: Option<Principal>,
    pub(crate) subaccount: Option<Vec<u8>>,
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
pub(crate) const RETRIEVE_BTC_MIN_AMOUNT: u64 = 50_000;

#[derive(CandidType, Deserialize)]
pub(crate) struct RetrieveBtcWithApprovalArgs {
    pub(crate) address: String,
    pub(crate) amount: u64,
    pub(crate) from_subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Deserialize)]
pub(crate) struct RetrieveBtcOk {
    pub(crate) block_index: Nat,
}

#[derive(CandidType, Deserialize, Debug)]
pub(crate) enum RetrieveBtcWithApprovalError {
    MalformedAddress(String),
    AlreadyProcessing,
    AmountTooLow(u64),
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    TemporarilyUnavailable(String),
    GenericError { error_message: String, error_code: Nat },
}

// --- ckETH-minter withdraw proxy (native ckETH → ETH out) -------------------------------------
// Mirror types for decoding the REAL ckETH minter's `withdraw_eth` + `eip_1559_transaction_price`
// candid replies, verified against `dfx canister metadata sv3dd-oaaaa-aaaar-qacoa-cai
// candid:service --network ic` (the .did is cached at /tmp/opencode/cketh-minter.did):
//   `withdraw_eth : (WithdrawalArg) -> (variant { Ok : RetrieveEthRequest; Err : WithdrawalError })`
//   `eip_1559_transaction_price : (opt Eip1559TransactionPriceArg) -> (Eip1559TransactionPrice) query`
// Field/variant labels mirror the real minter exactly so the decode is wire-compatible with mainnet.
// Internal only — kept out of the public candid surface (like the BTC mirror types above). The ETH
// path's approve semantics DIFFER from ckBTC: `withdraw_eth` burns `amount` immediately and burns the
// gas fee in a SEPARATE `icrc2_transfer_from` later, so a SINGLE `icrc2_approve(amount +
// max_transaction_fee)` covers BOTH burns (ICRC-2 allowance is a running balance, not single-use).

#[derive(CandidType, Deserialize)]
pub(crate) struct WithdrawalArg {
    pub(crate) recipient: String,
    pub(crate) amount: Nat,
    pub(crate) from_subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Deserialize)]
pub(crate) struct RetrieveEthRequest {
    pub(crate) block_index: Nat,
}

#[derive(CandidType, Deserialize, Debug)]
pub(crate) enum WithdrawalError {
    AmountTooLow { min_withdrawal_amount: Nat },
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    RecipientAddressBlocked { address: String },
    TemporarilyUnavailable(String),
}

#[derive(CandidType, Deserialize)]
pub(crate) struct Eip1559TransactionPriceArg {
    pub(crate) ckerc20_ledger_id: Principal,
}

#[derive(CandidType, Deserialize)]
pub(crate) struct Eip1559TransactionPrice {
    pub(crate) gas_limit: Nat,
    pub(crate) max_fee_per_gas: Nat,
    pub(crate) max_priority_fee_per_gas: Nat,
    pub(crate) max_transaction_fee: Nat,
    pub(crate) timestamp: Option<u64>,
}

/// The candid argument the facade's `withdraw` takes: the user's signed authorization fields +
/// the Ed25519 signature over the canonical [`dpay_core::WithdrawAuth`] signing bytes. The facade
/// rebuilds the [`dpay_core::WithdrawAuth`] from these fields, recomputes the signing bytes (single
/// source of truth in `dpay-core`), and verifies the signature under `from_pubkey` BEFORE moving any
/// funds — the non-custodial gate.
#[derive(CandidType, Deserialize)]
pub(crate) struct WithdrawRequest {
    pub(crate) from_pubkey: Vec<u8>,
    pub(crate) destination: String,
    pub(crate) amount: u64,
    pub(crate) nonce: Vec<u8>,
    pub(crate) expiry: u64,
    pub(crate) currency: Currency,
    pub(crate) sig: Vec<u8>,
}

/// The facade's withdrawal receipt, returned on a successful burn. Mirrors the relay's
/// [`crate::WithdrawReceipt`] surface. `block_index` is the ckBTC ledger's burn transaction index
/// (from the minter's `RetrieveBtcOk`); `amount`/`destination` echo the authorization so the app can
/// render "Withdrew X BTC to bc1…". (No canister-signed receipt for withdraw — the pay receipt (R2)
/// is the outcome-attestation surface; the withdraw outcome is the on-ledger burn + the minter's BTC
// send, reconciled via the ckBTC ledger / `retrieve_btc_status`, not a facade signature.)
#[derive(CandidType, Deserialize, Clone, Debug)]
pub(crate) struct WithdrawReceipt {
    pub(crate) from: Vec<u8>,
    pub(crate) destination: String,
    pub(crate) amount: u64,
    pub(crate) nonce: Vec<u8>,
    pub(crate) currency: Currency,
    pub(crate) block_index: u64,
}

// --- ckETH-minter withdraw_erc20 proxy (ckERC20 → ERC20 out) -----------------------------------
// Mirror types for decoding the REAL ckETH minter's `withdraw_erc20` candid reply, verified against
// `dfx canister metadata sv3dd-oaaaa-aaaar-qacoa-cai candid:service --network ic` (cached .did):
//   `withdraw_erc20 : (WithdrawErc20Arg) -> (variant { Ok : RetrieveErc20Request; Err : WithdrawErc20Error })`
// Field/variant labels mirror the real minter EXACTLY (incl. `ckerc20_ledger_id : principal`, NOT
// nat — encoding it as nat traps IC0503 on mainnet). The dual-ledger path: the facade approves the
// minter on the ckETH gas ledger (gas fee) + the ckERC20 amount ledger (amount), then calls
// `withdraw_erc20` which burns BOTH.

/// `WithdrawErc20Arg` — the EXACT argument record the REAL ckETH minter's `withdraw_erc20` takes
/// (verified in the cached .did): `record { amount : nat; ckerc20_ledger_id : principal; recipient :
/// text; from_cketh_subaccount : opt blob; from_ckerc20_subaccount : opt blob }`. The facade passes
/// `ckerc20_ledger_id = <the ckERC20 amount ledger>`, both subaccounts = `Some(pubkey)`.
#[derive(CandidType, Deserialize)]
pub(crate) struct WithdrawErc20Arg {
    pub(crate) amount: Nat,
    pub(crate) ckerc20_ledger_id: Principal,
    pub(crate) recipient: String,
    pub(crate) from_cketh_subaccount: Option<Vec<u8>>,
    pub(crate) from_ckerc20_subaccount: Option<Vec<u8>>,
}

/// `RetrieveErc20Request` — the real minter's success record: burn block indices on BOTH ledgers.
#[derive(CandidType, Deserialize)]
pub(crate) struct RetrieveErc20Request {
    pub(crate) cketh_block_index: Nat,
    pub(crate) ckerc20_block_index: Nat,
}

/// `LedgerError` — the inner error wrapped by `CkEthLedgerError` / `CkErc20LedgerError`. Variant +
/// field labels mirror the cached .did exactly.
#[derive(CandidType, Deserialize, Debug)]
pub(crate) enum LedgerError {
    InsufficientFunds { balance: Nat, failed_burn_amount: Nat, token_symbol: String, ledger_id: Principal },
    InsufficientAllowance { allowance: Nat, failed_burn_amount: Nat, token_symbol: String, ledger_id: Principal },
    AmountTooLow { minimum_burn_amount: Nat, failed_burn_amount: Nat, token_symbol: String, ledger_id: Principal },
    TemporarilyUnavailable(String),
}

/// `WithdrawErc20Error` — the real ckETH minter's error variant for `withdraw_erc20`. The load-bearing
/// variant for the partial-failure path is `CkErc20LedgerError { cketh_block_index, error }`: the gas
/// fee burned successfully but the amount burn failed → the minter schedules a reimbursement. This is
/// a TERMINAL state (funds moved), so the facade SETTLES the nonce (vs `CkEthLedgerError` where the
/// gas burn itself failed → nothing moved → RELEASE).
#[derive(CandidType, Deserialize, Debug)]
pub(crate) enum WithdrawErc20Error {
    TokenNotSupported { supported_tokens: Vec<CkErc20Token> },
    RecipientAddressBlocked { address: String },
    CkEthLedgerError { error: LedgerError },
    CkErc20LedgerError { cketh_block_index: Nat, error: LedgerError },
    TemporarilyUnavailable(String),
}

/// `CkErc20Token` — the record the real minter returns inside `TokenNotSupported.supported_tokens`.
/// Defined here so `WithdrawErc20Error` decodes fully (the facade does not surface the inner record).
#[derive(CandidType, Deserialize, Debug)]
pub(crate) struct CkErc20Token {
    pub(crate) ckerc20_token_symbol: String,
    pub(crate) erc20_contract_address: String,
    pub(crate) ledger_canister_id: Principal,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub(crate) struct ReconcileReport {
    pub(crate) currency: Currency,
    /// Ledger transactions examined (the recent window actually scanned).
    pub(crate) blocks_scanned: u64,
    /// Orphaned debits repaired (ledger moved funds, SPENT had no nonce → marked spent + recorded).
    pub(crate) orphans_repaired: u64,
}

// --- self-service demo faucet -----------------------------------------------------------------

/// Fixed amount the faucet mints per call, in minor units (cents) = **$100.00**. The self-service
/// surface cannot print more than this in one call regardless of what a client asks.
pub(crate) const FAUCET_AMOUNT: u64 = 10_000;

/// Per-(account, currency) faucet cooldown in seconds. One faucet mint per account per currency per
/// window — guards the self-service path against a single account draining the demo minting account
/// by repeated calls. Generous for a demo; make it a governed parameter before any pilot.
pub(crate) const FAUCET_COOLDOWN_SECS: u64 = 60 * 60; // 1 hour

/// The facade sets `memo = nonce` (16 bytes) on every `pay` transfer. Extract it; anything else
/// (None, wrong length) is not a pay debit → not a reconcile target.
pub(crate) fn memo_to_nonce(memo: &Option<icrc_ledger_types::icrc1::transfer::Memo>) -> Option<[u8; NONCE_LEN]> {
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
