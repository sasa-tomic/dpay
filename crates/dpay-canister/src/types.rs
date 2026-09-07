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

// --- DEMO-ledger registry ----------------------------------------------------------------------
// With the governed registry removed (founder decision 2026-08-28), this map holds EXACTLY ONE
// row: the DEMO currency (0) → its environment-specific ICRC ledger. Every other currency the
// facade serves resolves from the compile-time `FIXED_ASSETS` table below.

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

/// Optional governance controller for admin ops (`mint`/`burn`/`reconcile`/`set_controller`).
/// Encoded as a 1-byte present flag + up to 29 principal bytes. `None` = open (demo). Production MUST
/// set a governed controller — an open admin surface lets anyone mint unbounded demo currency.
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

// --- fixed chain-key currency table ------------------------------------------------------------
// Founder decision 2026-08-28: the public, mutable, governed currency registry is REMOVED from this
// canister — the relay is the sole catalog authority. The fixed ck currencies the facade serves
// (deposit/withdraw proxy + pay routing) resolve from this COMPILE-TIME table; the DEMO currency's
// ledger stays an init arg because it is environment-specific (fresh canister locally, `td2nx-…`
// on mainnet). The registry can be re-added at a future governance handoff if that ever changes.

/// The proxy family a fixed ck currency's minter belongs to — drives per-family ramp dispatch in
/// `proxy.rs` (`withdraw`) and the deposit family gate. Internal-only since the registry removal:
/// it keys the `FIXED_ASSETS` rows and never crosses the wire.
#[derive(CandidType, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinterFamily {
    /// ckBTC: `get_btc_address` + `update_balance` + `retrieve_btc_with_approval` (single-ledger).
    CkBtcUtxo,
    /// ckETH/ckUSDC: helper-contract deposit (no IC mint trigger) + `withdraw_eth`/`withdraw_erc20`
    /// (dual-ledger for ckERC20, ckETH gas).
    CkEthErc20,
    /// ckSOL: `get_deposit_address` + `process_deposit` + threshold-Ed25519 `withdraw`. No FIXED
    /// row uses this family yet (the SOL rail is app-side) — kept so the table's vocabulary is
    /// exhaustive over the minter call-mirrors `calls.rs` speaks.
    CkSol,
}

/// One FIXED chain-key currency resolved by the canister. Principals are mainnet TEXT from
/// `docs/CANISTERS.md`; `dfx/catalog_truth.json` cross-checks them (see the
/// `fixed_assets_match_catalog_truth` drift alarm at the bottom of this file). Parsed at call time —
/// the table is tiny, same pattern as `ADMIN_CALLERS` in lib.rs.
#[derive(Clone, Copy)]
pub(crate) struct FixedAsset {
    pub(crate) currency: Currency,
    /// The currency's ICRC ledger principal.
    pub(crate) ledger: &'static str,
    /// The chain-key minter principal.
    pub(crate) minter: &'static str,
    /// The minter proxy family (dispatch key for deposit/withdraw).
    pub(crate) family: MinterFamily,
    /// ERC-20 contract address for a ckERC20 (`Some`) — routes `withdraw` to the dual-ledger
    /// `withdraw_erc20` path; `None` = native asset (ckBTC, ckETH).
    pub(crate) token_contract: Option<&'static str>,
    /// The ckETH gas-ledger principal a ckERC20's dual-ledger withdraw burns (ckUSDC only).
    pub(crate) gas_ledger: Option<&'static str>,
    /// Per-tx cap in raw smallest units. 100_000 mirrors the registry-era placeholder policy (cap
    /// == per_tx_cap); tighten per currency when policy is set.
    pub(crate) cap: u64,
}

/// The ONLY currencies the facade resolves besides DEMO (0): ckBTC (1), ckUSDC (2), ckETH (6).
/// VCHF (7) / ICP (8) are app-signed direct-ICRC assets with NO facade support — they must NOT
/// appear here (or anywhere in this canister).
pub(crate) const FIXED_ASSETS: &[FixedAsset] = &[
    FixedAsset {
        currency: 1, // ckBTC
        ledger: "mxzaz-hqaaa-aaaar-qaada-cai",
        minter: "mqygn-kiaaa-aaaar-qaadq-cai",
        family: MinterFamily::CkBtcUtxo,
        token_contract: None,
        gas_ledger: None,
        cap: 100_000,
    },
    FixedAsset {
        currency: 2, // ckUSDC (ckERC20; ckETH minter serves all ckERC20s)
        ledger: "xevnm-gaaaa-aaaar-qafnq-cai",
        minter: "sv3dd-oaaaa-aaaar-qacoa-cai",
        family: MinterFamily::CkEthErc20,
        token_contract: Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        gas_ledger: Some("ss2fx-dyaaa-aaaar-qacoq-cai"), // ckETH ledger = the gas source
        cap: 100_000,
    },
    FixedAsset {
        currency: 6, // ckETH (native)
        ledger: "ss2fx-dyaaa-aaaar-qacoq-cai",
        minter: "sv3dd-oaaaa-aaaar-qacoa-cai",
        family: MinterFamily::CkEthErc20,
        token_contract: None,
        gas_ledger: None,
        cap: 100_000,
    },
];

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
        // SAFETY (the 2 `.try_into().unwrap()` calls below): `Storable::from_bytes` returns `Self`
        // (not `Result`) by the ic-stable-structures API contract, so a corrupt entry traps. The bytes
        // are fixed-layout (CACHED_BALANCE_LEN = 16), written by this canister's own `to_bytes`, so
        // the two 8-byte slice→array conversions are infallible for any canister-written entry.
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
        // SAFETY (the 3 `.try_into().unwrap()` calls below): `Storable::from_bytes` returns `Self`
        // (not `Result`) by the ic-stable-structures API contract, so a corrupt entry traps. The bytes
        // are fixed-layout (TXN_RECORD_LEN = 196), written by this canister's own `to_bytes`, so the
        // amount(8)/currency(4)/timestamp(8) slice→array conversions are infallible.
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

#[derive(CandidType, Deserialize)]
pub(crate) struct InitArg {
    /// The DEMO/DUSD (currency 0) ICRC ledger principal — the ONE environment-specific ledger
    /// (fresh canister on PocketIC/local, `td2nx-…` on mainnet). The only ledger registered at
    /// init; every other currency resolves via the compile-time `FIXED_ASSETS` table.
    pub(crate) demo_ledger: Principal,
    /// Per-tx cap (raw smallest units) for the DEMO currency; also the legacy `per_tx_cap` readout
    /// the deploy script checks.
    pub(crate) per_tx_cap: u64,
    /// Governance principal permitted to call `mint`/`burn`/`reconcile`/`set_controller`.
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

/// One entry of a `refresh_balances` result: the currency id + its freshly-read authoritative
/// balance (minor units). Returned by the unified refresh endpoint that reads the REQUESTED
/// currencies' balances in a SINGLE update call (one consensus round) — pass `[currency]` for one,
/// every registered id for all. A per-currency ledger hiccup keeps the last-known cached value
/// (settlement always reads the ledger directly; the cache is display-only).
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

// --- in-flight pay-intent markers (lazy stale sweep) --------------------------------------------
// A marker records that a `pay` has reserved its nonce and entered the cross-canister settle
// sequence (the ledger awaits). It exists so the CHEAP lazy stale sweep (lib.rs
// `sweep_stale_intents` — rate-limited to 1/hour on update ingress, NO heartbeat) can
// notice an intent that has been open far longer than any legitimate settle (`bounded_wait` caps
// every await at 300s), without ever walking the ledger. Written by `reserve_nonce` (before the
// first ledger await in `pay`), cleared by `settle_nonce`/`release_nonce` — the marker's lifecycle
// IS the nonce reservation's lifecycle, by construction. Flag-only: the sweep never moves
// funds and never auto-runs reconcile (the operator does — see docs/OPS.md).

/// One in-flight pay intent: when `pay` reserved the nonce (unix seconds) and whether the
/// sweep has already flagged it stale (the flag makes the WARN log fire once per episode, not
/// every sweep). Fixed 9 bytes: `reserved_at_secs_le(8) | flagged(1)`. Keyed by `Nonce` (MemoryId 15).
pub(crate) const IN_FLIGHT_LEN: usize = 8 + 1;
#[derive(Clone, Copy, Debug)]
pub(crate) struct InFlightIntent {
    pub(crate) reserved_at_secs: u64,
    pub(crate) flagged: bool,
}
impl Storable for InFlightIntent {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut b = [0u8; IN_FLIGHT_LEN];
        b[..8].copy_from_slice(&self.reserved_at_secs.to_le_bytes());
        b[8] = self.flagged as u8;
        Cow::Owned(b.to_vec())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let b = &bytes[..];
        // SAFETY (the 1 `.try_into().unwrap()` call below): fixed-layout (IN_FLIGHT_LEN = 9)
        // written by this canister's own `to_bytes`; the 8-byte slice→array conversion is
        // infallible for any canister-written entry.
        InFlightIntent {
            reserved_at_secs: u64::from_le_bytes(b[..8].try_into().unwrap()),
            flagged: b.get(8).copied().unwrap_or(0) != 0,
        }
    }
    const BOUND: Bound = Bound::Bounded { max_size: IN_FLIGHT_LEN as u32, is_fixed_size: true };
}

/// One row of the `inflight_intents` query — the operator-facing flag surface the sweep
/// feeds. `stale` is computed live (age > `INFLIGHT_STALE_SECS`); `flagged` records that the
/// sweep already WARN-logged this episode.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct InFlightView {
    pub(crate) nonce: Vec<u8>,
    pub(crate) reserved_at_secs: u64,
    pub(crate) age_secs: u64,
    pub(crate) stale: bool,
    pub(crate) flagged: bool,
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

#[cfg(test)]
mod catalog_truth_tests {
    use super::*;
    use serde_json::Value;

    const CATALOG_TRUTH: &str = include_str!("../../../dfx/catalog_truth.json");

    fn wire_consts() -> Value {
        let t: Value =
            serde_json::from_str(CATALOG_TRUTH).expect("dfx/catalog_truth.json must be valid JSON");
        t.get("wire_consts")
            .cloned()
            .expect("dfx/catalog_truth.json must define a wire_consts object")
    }

    fn decode_hex_const(s: &str) -> Vec<u8> {
        let s = s.strip_prefix("0x").unwrap_or(s);
        (0..s.len())
            .step_by(2)
            .map(|i| {
                u8::from_str_radix(&s[i..i + 2], 16)
                    .unwrap_or_else(|_| panic!("wire_consts hex byte invalid at offset {i}"))
            })
            .collect()
    }

    #[test]
    fn retrieve_btc_min_amount_matches_catalog_truth() {
        let wc = wire_consts();
        let want = wc["retrieve_btc_min_amount"]
            .as_u64()
            .expect("wire_consts.retrieve_btc_min_amount must be a u64");
        assert_eq!(RETRIEVE_BTC_MIN_AMOUNT, want);
    }

    #[test]
    fn mint_account_matches_catalog_truth() {
        let wc = wire_consts();
        let hex = wc["mint_account"]
            .as_str()
            .expect("wire_consts.mint_account must be a hex string");
        let want = decode_hex_const(hex);
        assert_eq!(
            want.len(),
            PUBKEY_LEN,
            "wire_consts.mint_account must decode to exactly PUBKEY_LEN bytes"
        );
        assert_eq!(want.as_slice(), MINT_ACCOUNT);
    }

    /// The FIXED_ASSETS const table replaced the governed registry (2026-08-28). The principals the
    /// relay's catalog also pins live in catalog_truth.json `principals`/`erc20_contracts` — a drift
    /// in either direction goes RED here, exactly like the wire_consts alarms above. The ckBTC
    /// LEDGER principal is not in catalog_truth.json (the relay catalog has no reason to pin it), so
    /// it is asserted against the docs/CANISTERS.md value directly.
    #[test]
    fn fixed_assets_match_catalog_truth() {
        let t: Value =
            serde_json::from_str(CATALOG_TRUTH).expect("dfx/catalog_truth.json must be valid JSON");
        let principals = t
            .get("principals")
            .expect("dfx/catalog_truth.json must define a principals object");
        let principal_str = |key: &str| {
            principals[key]
                .as_str()
                .unwrap_or_else(|| panic!("catalog_truth principals.{key} must be a string"))
        };
        let find = |c: Currency| {
            FIXED_ASSETS
                .iter()
                .find(|a| a.currency == c)
                .unwrap_or_else(|| panic!("FIXED_ASSETS must contain currency {c}"))
        };

        let ckbtc = find(1);
        assert_eq!(ckbtc.ledger, "mxzaz-hqaaa-aaaar-qaada-cai"); // docs/CANISTERS.md
        assert_eq!(ckbtc.minter, principal_str("ckbtc_minter"));
        assert_eq!(ckbtc.token_contract, None);
        assert_eq!(ckbtc.gas_ledger, None);

        let ckusdc = find(2);
        assert_eq!(ckusdc.ledger, principal_str("ckusdc_ledger"));
        assert_eq!(ckusdc.minter, principal_str("cketh_minter")); // ckETH minter serves all ckERC20s
        assert_eq!(ckusdc.gas_ledger, Some(principal_str("cketh_gas_ledger")));
        assert_eq!(
            ckusdc.token_contract,
            Some(t["erc20_contracts"]["ckusdc"].as_str().expect("erc20_contracts.ckusdc"))
        );

        let cketh = find(6);
        assert_eq!(cketh.ledger, principal_str("cketh_ledger"));
        assert_eq!(cketh.minter, principal_str("cketh_minter"));
        assert_eq!(cketh.token_contract, None);
        assert_eq!(cketh.gas_ledger, None);

        // VCHF (7) / ICP (8) are app-signed direct-ICRC assets — NO facade row, ever.
        assert!(
            FIXED_ASSETS.iter().all(|a| a.currency != 7 && a.currency != 8),
            "VCHF/ICP must not appear in FIXED_ASSETS (no facade support)"
        );

        // A typo'd const principal would otherwise trap at first use — prove the table parses.
        for a in FIXED_ASSETS {
            Principal::from_text(a.ledger).expect("FIXED_ASSETS ledger principal must parse");
            Principal::from_text(a.minter).expect("FIXED_ASSETS minter principal must parse");
            if let Some(g) = a.gas_ledger {
                Principal::from_text(g).expect("FIXED_ASSETS gas_ledger principal must parse");
            }
        }
    }
}
