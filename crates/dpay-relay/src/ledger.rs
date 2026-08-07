//! The ledger seam. The relay orchestrates (idempotency, retries, HTTP); *settlement* — the
//! read-check-write of money — lives behind this trait.
//!
//! Two impls today:
//! - [`FakeLedger`]: an in-memory ledger that mirrors the canister's `pay` semantics EXACTLY
//!   (same `dpay_core::validate` rules, same atomic transfer, unix-seconds time). This is what
//!   the fast offline inner loop runs against.
//! - [`FlakyLedger`] (test-only): wraps any ledger and fails the first N calls with a transient
//!   error, to exercise the relay's retry path.
//!
//! A real ICP-agent impl (talking to the canister) is out of scope here — it slots in behind the
//! same trait.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use async_trait::async_trait;
use ed25519_dalek::{Signature, SigningKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A `u64` carried across the JSON boundary as a DECIMAL STRING (never a raw JSON number), so the
/// full u64 range round-trips without precision loss above 2^53 (MC1 units 2-4 — exact amount
/// transport). Serializes as a quoted decimal string (e.g. `"10000"`); deserializes accepting EITHER
/// a quoted decimal string OR a raw JSON number, for a smooth cutover from any caller (including the
/// relay's own fixtures and an older client) that still sends a number.
///
/// This is purely a marshalling concern — the FROZEN wire bytes carry `amount` as a fixed-offset
/// little-endian u64 (unchanged); only the JSON/TS boundary representation moves from `number` to
/// `string`. Internal Rust (the `Ledger` trait, the FakeLedger state) keeps using native `u64`; the
/// `.0` extraction happens at the (de)serialization seam.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U64String(pub u64);

impl serde::Serialize for U64String {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

impl<'de> serde::Deserialize<'de> for U64String {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct U64StringVisitor;
        impl<'de> serde::de::Visitor<'de> for U64StringVisitor {
            type Value = U64String;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a decimal-string u64 or a non-negative JSON number")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<U64String, E> {
                v.trim()
                    .parse::<u64>()
                    .map(U64String)
                    .map_err(|_| E::custom(format!("u64 decimal string expected, got {v:?}")))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<U64String, E> {
                Ok(U64String(v))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<U64String, E> {
                if v >= 0 {
                    Ok(U64String(v as u64))
                } else {
                    Err(E::custom(format!("u64 must be non-negative, got {v}")))
                }
            }
        }
        deserializer.deserialize_any(U64StringVisitor)
    }
}

use dpay_core::{
    sign_receipt, validate, CodecError, Currency, MEMO_LEN, NAME_LEN, PayError, ReceiptClaim,
    SignedAuthorization, WithdrawAuth, DEMO_USD, NONCE_LEN, PUBKEY_LEN,
};

/// The minimal withdrawal amount the facade honors, in sats. Mirrors the LIVE ckBTC minter's
/// `retrieve_btc_min_amount` (= 50_000, returned by `get_minter_info` on `mqygn-kiaaa-aaaar-qaadq-cai`
/// and confirmed in OPEN_ISSUES.md) and the canister's `RETRIEVE_BTC_MIN_AMOUNT`. Single-sourced here
/// so the relay's local pre-check + the FakeLedger simulation can't drift from the real floor.
const RETRIEVE_BTC_MIN_AMOUNT: u64 = 50_000;

/// Sentinel "account" the canister reserves for mint/burn history rows (`[0xFF; 32]`). A real
/// Ed25519 pubkey is a valid curve point, so this all-ones value can never be a user's pubkey
/// (`verify_strict` rejects it). The canister rejects a `pay` that names it as the payee; the
/// FakeLedger mirrors that reject so the two can't diverge (W3 audit).
const MINT_ACCOUNT: [u8; PUBKEY_LEN] = [0xFF; PUBKEY_LEN];

/// Decode a fixed-width NUL-padded UTF-8 name/memo field (32 bytes on the wire, single-sourced as
/// [`NAME_LEN`]/[`MEMO_LEN`] in core) into the display `String` the relay's JSON history carries.
/// Trims trailing NULs (the builder's padding) and decodes lossily, so a malformed buffer is never a
/// silent error or panic — the core stores/signs/verifies raw bytes; the relay only renders them.
/// `NAME_LEN == MEMO_LEN`, so the same helper covers `from_name`/`to_name` and `memo`.
const _: () = assert!(NAME_LEN == MEMO_LEN);
fn display_field_to_string(buf: &[u8; NAME_LEN]) -> String {
    // Trim trailing NULs (the builder's padding): take through the last non-zero byte. `[u8]` has no
    // `trim_end_matches` (that's a `str` method), so find the boundary by hand, then decode lossily.
    let end = buf.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// Verified constants for the ckUSDC onramp (ckERC-20 family). ckUSDC has NO per-principal IC deposit
/// address and NO user-callable mint — the user performs two Ethereum transactions from their own
/// wallet (approve + depositErc20); the relay only surfaces these so the app can build the calldata
/// (see OPEN_ISSUES.md O6 + `app/cketh.ts`). In production these are read at runtime from the ckETH
/// minter's `get_minter_info`; the constants below are the authoritative values
/// (verified 2026-07-31 — do not re-derive). Single-sourced here so the FakeLedger + AgentLedger
/// impls can't drift from the verified addresses.
///
/// The `helper_address` is NETWORK-scoped, not minter-scoped: Ethereum mainnet and Sepolia testnet
/// each deploy their own CkDeposit helper contract under the same ckETH minter. The chain-id gate in
/// [`ckerc20_onramp_from_descriptor`] selects the right one from the descriptor's `chain_id`. The
/// drift-free source for either value is the minter's
/// `get_minter_info.deposit_with_subaccount_helper_contract_address` (OPEN_ISSUES #1/#2 testnet
/// wiring). `CKUSDC_ERC20_ADDRESS` is the token contract (USDC), NOT the helper — kept separate so a
/// per-token descriptor's `token_contract` stays the source of truth for the ERC-20 address.
pub(crate) const CKERC20_HELPER_ADDRESS_MAINNET: &str =
    "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68";
pub(crate) const CKERC20_HELPER_ADDRESS_SEPOLIA: &str =
    "0x2D39863d30716aaf2B7fFFd85Dd03Dda2BFC2E38";
pub(crate) const CKUSDC_ERC20_ADDRESS: &str =
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/// The ckETH LEDGER principal (mainnet) — the gas ledger a ckERC20 `withdraw_erc20` burns ckETH gas
/// fees from (the amount comes from the ckERC20 amount ledger). Verified against the IC mainnet
/// ckETH ledger `ss2fx-dyaaa-aaaar-qacoq-cai` (2026-08-06). Single-sourced here so the FakeLedger
/// catalog's per-ckERC20 `gas_ledger` field can't drift from the real value the AgentLedger reads at
/// runtime from the facade's `currencies()` query. `None` for non-ckERC20 families (BTC / native ETH /
/// DEMO): native ckETH's gas ledger IS its own `ledger` (the `withdraw_eth` path), so it carries no
/// separate `gas_ledger`.
pub(crate) const CKETH_LEDGER_PRINCIPAL: &str = "ss2fx-dyaaa-aaaar-qacoq-cai";

/// What the merchant sees on success. Byte fields are hex so the JSON is a plain string map.
/// Mirrors the canister's `PayReceipt` (which returns the same fields as candid `blob`s).
///
/// `receipt_sig` + `pubkey` (R2) carry the canister's Ed25519 signature over the canonical
/// `ReceiptClaim` and the canister's public key — the payer verifies `receipt_sig` over the claim
/// built from `{nonce, from, to, amount, currency, block_index, settle_ts}` under `pubkey` before
/// trusting the outcome. `block_index`/`settle_ts`/`currency` are the remaining claim fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Receipt {
    pub from: String,
    pub to: String,
    pub amount: U64String,
    pub nonce: String,
    pub new_from_balance: U64String,
    pub currency: Currency,
    pub block_index: U64String,
    /// Unix-seconds settlement time. NOTE the principled JSON-boundary split (applies here + to the
    /// other bounded non-money `u64` fields below — `TxnRecord.timestamp`, `PendingUtxo.confirmations`,
    /// `WithdrawRequest.expiry`): MONEY `u64` fields cross JSON as [`U64String`] (a decimal string) so
    /// the full u64 range round-trips without precision loss above 2^53; these NON-MONEY fields (a
    /// unix-seconds time, a block-confirmation count) are bounded ≪ 2^53 by construction and so cross
    /// as a RAW JSON number by design — `serde_json`'s default `u64` → bare number. This is
    /// intentional, not an oversight; do NOT change the types (a wire change). Money stays `U64String`.
    pub settle_ts: u64,
    /// Hex-encoded 64-byte Ed25519 signature over the canonical ReceiptClaim.
    pub receipt_sig: String,
    /// Hex-encoded 32-byte receipt public key (the signer's). Verify the sig under this.
    pub pubkey: String,
}

/// One settled transaction, as the wallet's history list shows it. `from`/`to`/`nonce` are hex
/// (matches [`Receipt`]); `from_name`/`to_name`/`memo` are the UTF-8 display strings decoded
/// (NUL-trimmed, lossy) from the signed authorization's 32-byte name/memo fields — so history is
/// self-describing on both sides (the payee sees the payer's name, not a raw pubkey; closes N6/H3).
/// `timestamp` is unix seconds. Direction (in/out) is derived by the caller comparing the queried
/// account's pubkey to `from`. Mirrors the canister's `TxnView`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TxnRecord {
    pub from: String,
    pub to: String,
    pub amount: U64String,
    pub nonce: String,
    pub currency: Currency,
    /// Unix seconds. Bounded ≪ 2^53 → raw JSON number by design (see `Receipt.settle_ts`).
    pub timestamp: u64,
    /// The payer's display name (decoded from the signed 32-byte `from_name` field). Empty string
    /// for synthesized mint/burn sentinel rows (the app special-cases those).
    pub from_name: String,
    /// The payee's display name (decoded from the signed 32-byte `to_name` field). Empty string for
    /// synthesized mint/burn sentinel rows.
    pub to_name: String,
    /// The merchant-set memo (decoded from the signed 32-byte `memo` field). Empty string when unset.
    pub memo: String,
}

// ---------------------------------------------------------------------------
// Deposit surface (ckBTC-style top-up). These mirror the canister's deposit
// types (§3.1 of the deposit-integration plan) but live here as serde structs
// so the relay's HTTP layer speaks plain JSON. The agent impl (feature
// `agent`) translates between these and the candid `Nat`-bearing mirrors.
// ---------------------------------------------------------------------------

/// One UTXO the minter has *already* minted in this refresh call. `block_index` is the ckBTC
/// ledger's block index — a candid `nat` on the wire, so it is carried as a `String` (a `Nat` /
/// `u128` doesn't round-trip cleanly in JSON). Mirrors the canister's `MintedUtxo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MintedUtxo {
    pub block_index: String,
    pub amount: U64String,
}

/// One UTXO seen on-chain but not yet confirmed enough to mint. Mirrors the canister's `PendingUtxo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingUtxo {
    pub value: U64String,
    /// Block-confirmation count. Bounded ≪ 2^53 → raw JSON number by design (see `Receipt.settle_ts`).
    pub confirmations: u64,
}

/// Result of a deposit refresh — what the wallet's "Add money" sheet polls. `minted_total > 0`
/// means real ck-asset was just credited to the user's subaccount; the wallet then re-reads its
/// balance. Mirrors the canister's `DepositRefresh`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DepositRefresh {
    pub minted: Vec<MintedUtxo>,
    pub minted_total: U64String,
    pub pending: Vec<PendingUtxo>,
    pub required_confirmations: u32,
}

/// Static instructions for a currency's deposit path (min confirmations, fee, min amount). Lets the
/// wallet render "Send BTC here · ~N confirmations · min X sats" before showing the address. Mirrors
/// the canister's `DepositInfo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DepositInfo {
    pub min_confirmations: u32,
    pub deposit_fee: U64String,
    pub deposit_min_amount: Option<U64String>,
}

// ---------------------------------------------------------------------------
// Withdrawal surface (ckBTC → native BTC out). These mirror the canister's
// `WithdrawRequest` / `WithdrawReceipt` (§W2) but live here as serde structs so the relay's HTTP
// layer speaks plain JSON (byte fields are hex, matching [`Receipt`]). The agent impl (feature
// `agent`) translates these to/from the canister's candid `blob` fields.
// ---------------------------------------------------------------------------

/// Request body for `POST /api/v1/withdraw`: the user's signed withdrawal authorization. `from` is
/// the hex Ed25519 pubkey (the debit subaccount), `nonce`/`sig` are hex (16/64 bytes), `amount` is
/// satoshis. The facade verifies `sig` over the canonical [`WithdrawAuth`] signing bytes under
/// `from` before moving any funds (non-custodial).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WithdrawRequest {
    pub from: String,
    pub destination: String,
    pub amount: U64String,
    pub nonce: String,
    /// Unix-seconds expiry. Bounded ≪ 2^53 → raw JSON number by design (see `Receipt.settle_ts`).
    pub expiry: u64,
    pub currency: Currency,
    pub sig: String,
}

/// Settlement receipt for a successful withdrawal: echoes the authorization + the ckBTC ledger's burn
/// block index. Mirrors the canister's `WithdrawReceipt`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WithdrawReceipt {
    pub from: String,
    pub destination: String,
    pub amount: U64String,
    pub nonce: String,
    pub currency: Currency,
    pub block_index: U64String,
}

// ---------------------------------------------------------------------------
// Catalog surface (M0). The canister now exposes `currencies() -> vec
// CurrencyDescriptor` (query) — the wallet's runtime source of truth for which
// assets exist and how to display/fund them, closing the hardcoded-
// `DEPOSIT_CURRENCY` coupling (issue #7). These serde structs are the relay's
// JSON shape: principals are TEXT (the candid `principal` is round-tripped
// through `.to_text()` by the agent impl so the HTTP layer stays plain JSON),
// and `MinterFamily` is the plain PascalCase variant tag (matches the candid
// variant label and the JSON string the wallet reads). The agent impl (feature
// `agent`) translates between these and its candid mirrors.
// ---------------------------------------------------------------------------

/// The proxy family a ck currency's minter belongs to — drives per-family ramp dispatch in the
/// wallet. Mirrors the canister's `MinterFamily` candid variant; serialized as the plain variant
/// name (e.g. `"CkBtcUtxo"`), matching both the candid label and the wallet's JSON contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum MinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

/// Per-direction ramp capability for a currency (MC1 unit 5). Mirrors the canister's
/// `RampCapability` candid variant; serialized as the plain variant name (e.g. `"Direct"`),
/// matching the candid label and the wallet's JSON contract. `Unavailable` ⇒ the wallet renders NO
/// button for that direction (no-swap honesty; ckUSDC offramp is `Unavailable` per Fork-C/O3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum RampCapability {
    Direct,
    Partner,
    Unavailable,
}

/// One currency the wallet can hold/fund — the runtime catalog entry. Mirrors the canister's
/// `CurrencyDescriptor`. `minter` is `Some` only for ck currencies with a registered ramp;
/// `minter_family`/`symbol`/`decimals` are `None` when unregistered (the wallet falls back).
/// `onramp`/`offramp` are NON-optional `RampCapability` (the canister defaults an unregistered
/// currency to `Unavailable` for both — fail-closed). The new per-currency metadata fields
/// (`wrapper_name`/`backing_symbol`/`network`/`display_decimals`/`fee`/`cap`/`chain_id`/
/// `token_contract`/`gas_ledger`) are the authoritative single source of truth; the relay is a
/// pass-through.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CurrencyDescriptor {
    pub currency: Currency,
    /// Principal of the currency's ICRC ledger, as canonical TEXT (hex/canonical) — keeps the
    /// relay's JSON clean and matches how the app consumes it.
    pub ledger: String,
    pub mintable: bool,
    /// Ramp (ck minter) principal as text, when a minter is registered for this currency.
    pub minter: Option<String>,
    pub minter_family: Option<MinterFamily>,
    pub symbol: Option<String>,
    pub decimals: Option<u8>,
    /// The IC wrapper token NAME, e.g. "ckBTC"/"ckUSDC" (distinct from the backing native asset).
    pub wrapper_name: Option<String>,
    /// The backing native-chain asset symbol, e.g. "BTC"/"USDC"/"ETH" — drives app display.
    pub backing_symbol: Option<String>,
    /// The native settlement network name for display, e.g. "Bitcoin"/"Ethereum".
    pub network: Option<String>,
    /// UI display precision; default = `decimals` (full precision) when unset. ≤ `decimals`.
    pub display_decimals: Option<u8>,
    /// ICRC ledger fee in RAW smallest units (registered statically; MC2 adds live validation).
    pub fee: Option<U64String>,
    /// Per-currency tx cap in RAW smallest units (registered; MC2 governs).
    pub cap: Option<U64String>,
    /// EVM chain id for ckERC20 (1=Ethereum mainnet). `None` for non-EVM families.
    pub chain_id: Option<u32>,
    /// ERC-20 contract address (0x…) for a ckERC20 token — per-token, replacing the old hardcoded
    /// currency-2 params. `None` for non-ERC20 families.
    pub token_contract: Option<String>,
    /// The ckETH gas-ledger principal (text) for a ckERC20 currency — the `withdraw_erc20` dual-ledger
    /// path burns ckETH gas fees from this ledger + the amount from `ledger`. `None` for non-ckERC20
    /// families (BTC / native ETH / DEMO) and for a ckERC20 whose gas ledger is unregistered (the
    /// facade fail-closes such a withdraw). Mirrors the canister's appended-last `gas_ledger` field.
    pub gas_ledger: Option<String>,
    /// Funding (on-ramp) capability. `Unavailable` ⇒ wallet shows NO "Add money" button.
    pub onramp: RampCapability,
    /// Cash-out (off-ramp) capability. `Unavailable` ⇒ wallet shows NO "Cash out" button.
    pub offramp: RampCapability,
}

/// Onramp parameters for a CkEthErc20-family currency (ckUSDC etc. OR native ckETH). The app builds
/// the user's Ethereum transaction(s) from these; the user signs in their own wallet (non-custodial).
/// `facade_principal` is the canister id encoded as the deposit `principal` arg; the user's pubkey is
/// the subaccount. In production these come from the ckETH minter's `get_minter_info`; the offline
/// FakeLedger returns the verified mainnet constants.
///
/// `kind` discriminates the two deposit shapes sharing the CkEthErc20 family + the SAME helper:
///  - `"erc20"`: two txs (approve the ERC-20, then `depositErc20`) — `erc20_address` is `Some`.
///  - `"native_eth"`: ONE payable tx (`depositEth`) carrying the ETH `value` — `erc20_address` is
///    `None` (the descriptor's `token_contract` is null). The discriminator within the family is the
///    descriptor's `token_contract`, surfaced here so the app need not re-derive it.
#[derive(Serialize)]
pub struct CkErc20OnrampParams {
    pub helper_address: String,             // the CkDeposit helper contract (0x…) — shared by both kinds
    pub erc20_address: Option<String>,      // Some(addr) for erc20; None for native_eth
    pub facade_principal: String,           // the facade canister principal (text) — the deposit `principal` arg
    pub kind: String,                       // "erc20" | "native_eth"
}

/// Resolve ckERC-20 / native-ETH onramp params from a catalog descriptor (MC8 U2). PURE +
/// single-sourced — both the FakeLedger and AgentLedger `ckerc20_onramp_params` impls delegate here so
/// the fail-closed gate is identical across the offline demo + the live canister paths.
///
/// **Gate (fail-closed — non-custodial / no-swap honesty):** returns `Err(Transient)` (→ HTTP 503)
/// unless ALL of:
/// 1. `desc` is `Some` (the currency exists in the catalog), AND
/// 2. `desc.minter_family == Some(CkEthErc20)` (it is a CkEthErc20-family currency).
///
/// Within the family, `token_contract` discriminates the two deposit shapes:
///  - `Some(addr)` ⇒ `"erc20"`: a known ERC-20 token (ckUSDC). Two txs (approve + depositErc20). The
///    `erc20_address` is the descriptor's token (fail-closed would NEVER fall back to ckUSDC's address
///    for a different token — but `Some` already carries the right per-token address).
///  - `None` ⇒ `"native_eth"`: native ETH. ONE payable `depositEth` tx; `erc20_address` is `None`.
///
/// A non-CkEthErc20 family (e.g. CkBtcUtxo, CkSol) or a missing descriptor MUST surface a 503 — it
/// must NEVER fall back to a default address.
///
/// The `helper_address` is NETWORK-scoped (Ethereum mainnet vs Sepolia testnet each deploy their own
/// CkDeposit helper under the same ckETH minter); the descriptor's `chain_id` selects which verified
/// constant to surface (Sepolia = 11155111; anything else, including `None`, = mainnet — the safe
/// default for a non-EVM-family metadata gap). The SAME helper serves both `depositEth` and
/// `depositErc20` (see DFINITY `DepositHelperWithSubaccount.sol` `CkDeposit`). `facade_principal` is
/// passed in (the FakeLedger uses a demo stand-in; the AgentLedger uses the live canister id it is
/// pointed at).
pub fn ckerc20_onramp_from_descriptor(
    desc: Option<&CurrencyDescriptor>,
    facade_principal: String,
) -> Result<CkErc20OnrampParams, LedgerError> {
    let d = desc.ok_or_else(|| LedgerError::Transient("no ckERC-20 onramp for currency".into()))?;
    if d.minter_family != Some(MinterFamily::CkEthErc20) {
        return Err(LedgerError::Transient("no ckERC-20 onramp for currency".into()));
    }
    // Network-scoped helper: Sepolia (chain_id 11155111) gets the Sepolia CkDeposit helper;
    // anything else (mainnet chain_id 1, or a None chain_id on a non-EVM-family metadata gap) falls
    // through to the mainnet value. The chain-id gate is the minimal testnet fix (OPEN_ISSUES #1/#2).
    // The SAME helper contract serves native ETH (depositEth) and ERC-20 (depositErc20).
    let helper_address = match d.chain_id {
        Some(11155111) => CKERC20_HELPER_ADDRESS_SEPOLIA,
        _ => CKERC20_HELPER_ADDRESS_MAINNET,
    };
    // Discriminate within the family by token_contract: Some = ERC-20 token; None = native ETH.
    let (erc20_address, kind) = match &d.token_contract {
        Some(addr) => (Some(addr.clone()), "erc20"),
        None => (None, "native_eth"),
    };
    Ok(CkErc20OnrampParams {
        helper_address: helper_address.to_string(),
        erc20_address,
        facade_principal,
        kind: kind.to_string(),
    })
}

/// Settlement outcome. `Rejected` is a permanent policy failure (bad sig, expired, over cap,
/// insufficient funds, reused nonce, malformed wire) — the relay must NOT retry it and surfaces
/// it as `422`. `Transient` is an infrastructure hiccup (e.g. the agent/canister was briefly
/// unreachable) — the relay retries it a bounded number of times.
#[derive(Clone, Debug, Error)]
pub enum LedgerError {
    #[error("rejected: {0}")]
    Rejected(String),
    #[error("transient: {0}")]
    Transient(String),
}

/// A clock returning unix seconds. Injectable so tests can pin `now` (matching the canister,
/// which divides `ic_cdk::api::time()` ns down to seconds).
pub trait Clock: Send + Sync {
    fn now_secs(&self) -> u64;
}

/// Real wall clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// A clock pinned to a fixed instant (tests / deterministic demos).
pub struct FixedClock(pub u64);

impl Clock for FixedClock {
    fn now_secs(&self) -> u64 {
        self.0
    }
}

/// The settlement seam. `async_trait` keeps it dyn-compatible so `Arc<dyn Ledger>` works.
#[async_trait]
pub trait Ledger: Send + Sync {
    /// Settle a 292-byte signed authorization (the payer's QR, decoded to wire bytes). The
    /// settlement currency is read out of the wire — the payer copied the merchant's request
    /// currency into their authorization — so `pay` itself takes no currency argument.
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError>;

    /// Read an account's balance (minor units) of `currency`. Lets a wallet show its live balance
    /// for the asset it actually holds when online.
    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError>;

    /// Self-service demo faucet: credit `to` with `amount` of `currency`, returning the new balance.
    /// Funds a freshly-generated on-device account (the demo on-ramp).
    ///
    /// **Two faithful models.** [`FakeLedger`] (the offline demo ledger) credits the REQUESTED
    /// `amount` and applies no cooldown — it is play money, and the e2e flow exercises a repeatable
    /// top-up. [`AgentLedger`](crate::AgentLedger) (the real canister) IGNORES `amount` and calls the
    /// canister's `faucet(account, currency)`, which mints a FIXED constants-sourced amount and is
    /// rate-limited per (account, currency) — a client cannot print unbounded funds or pick an
    /// amount. The relay's `/faucet` route passes `amount` through; the canister overrides it. The
    /// canister's rate-limiting + fixed-amount are proven on PocketIC (see `dpay-canister-tests`).
    async fn faucet(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError>;

    /// List this account's settled transactions in `currency`, newest-first, up to `limit`. Lets a
    /// wallet render a durable history sourced from the ledger (the in-memory UI list is gone on
    /// restart; this is the source of truth).
    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError>;

    /// ckBTC-style deposit address for `pubkey`/`currency` — the native-chain address the user
    /// sends to (the minter derives it per-principal via threshold signatures). Revealing it only
    /// lets someone send *to* the user, so the facade proxy needs no payer auth. The relay just
    /// hands it back.
    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<String, LedgerError>;

    /// Refresh the deposit for `pubkey`/`currency`: asks the facade (→ ck minter `update_balance`)
    /// to mint any now-confirmed UTXOs. Value-creating but idempotent (a no-op when nothing is
    /// confirmed). Returns what was minted + what's still pending. Per the deposit plan's §0 error
    /// rule, the proxy endpoints have **no permanent-policy failure**, so impls surface only
    /// [`LedgerError::Transient`].
    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError>;

    /// Static deposit instructions for `currency` (min confirmations, fee, min amount).
    async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError>;

    /// The full currency catalog — the wallet's runtime source of truth for which assets exist and
    /// how to display/fund them (closes the hardcoded-`DEPOSIT_CURRENCY` coupling). Joins the
    /// canister's LEDGERS + MINTERS + CURRENCY_META. Unauthenticated (catalog only — no balances).
    /// Impl errors are `Transient` (an unreachable canister); there is no permanent-policy failure.
    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError>;

    /// ckERC-20 onramp parameters (helper contract, ERC-20 address, facade principal) for the given
    /// currency. Only meaningful for CkEthErc20-family currencies. Returns Transient(503) if the
    /// currency has no ckERC-20 onramp configured.
    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError>;

    /// Withdraw ckBTC to a native BTC address on a VERIFIED user signature. The request carries the
    /// [`WithdrawAuth`] fields + the Ed25519 signature (hex); the ledger verifies the signature under
    /// `from` (== the debit subaccount) before moving any funds. On success the ckBTC is debited from
    /// `Account{facade, subaccount: from}` and the burn block index is returned.
    ///
    /// Error mapping mirrors the deposit surface's §0 rule for *transient* failures (a transport /
    /// minter-unavailable hiccup → `Transient` → HTTP 503), but a **permanent policy failure** (bad
    /// signature, expired, below min, insufficient funds, nonce reused) is `Rejected` → HTTP 422 — the
    /// relay must not signal "retry" for a rejection that will never succeed.
    ///
    /// The default returns a permanent `Rejected` so ledgers that don't support withdrawal (e.g.
    /// narrow test stubs) refuse cleanly rather than silently no-op. [`FakeLedger`] and
    /// [`AgentLedger`](crate::AgentLedger) override it.
    async fn withdraw(&self, _req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        Err(LedgerError::Rejected("withdraw not supported on this ledger".into()))
    }

    /// The receipt-signing public key (32 bytes) of the ledger/canister, so a payer can verify a
    /// `Receipt`'s `receipt_sig` over its canonical `ReceiptClaim`. `FakeLedger` returns a stable
    /// test key; `AgentLedger` queries the canister's `receipt_pubkey`. (A receipt also carries its
    /// own `pubkey` field, so this is an optional cross-check / pre-fetch.)
    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError>;

    /// Durable receipt lookup by nonce — the canister's source of truth for "did this payment
    /// settle, and what was the outcome?". Returns `Some(signed receipt)` if that nonce settled,
    /// `None` if it never did (or settled before this ledger version recorded signed receipts).
    ///
    /// This is the **durable recovery seam** the relay uses when its own process-local idempotency
    /// cache can't answer (after a restart, or when a settle reply was lost): `GET /receipt/{nonce}`
    /// and the `/pay` Transient-exhausted branch both fall back to it so a settled payment is never
    /// misreported as a 404/503 false-negative. The canister enforces a single-use nonce, so two
    /// authorizations can never both settle under one nonce — the recovered receipt is authoritative.
    ///
    /// The default returns `Ok(None)` so ledgers that don't record receipts (e.g. narrow test stubs)
    /// refuse cleanly rather than fabricate one. [`FakeLedger`] and
    /// [`AgentLedger`](crate::AgentLedger) override it for real.
    async fn receipt(&self, _nonce: [u8; NONCE_LEN]) -> Result<Option<Receipt>, LedgerError> {
        Ok(None)
    }

    /// Seed a pending deposit for `pubkey`/`currency` (the test-helpers hook a browser e2e harness
    /// uses to simulate a confirmed ckBTC deposit landing). Mirrors `FakeLedger::register_deposit`:
    /// the next `deposit_status` drains it and credits the balance.
    ///
    /// **Test-only.** Feature-gated behind `test-helpers` so the method — and the HTTP route that
    /// calls it (`POST /api/v1/test/deposit/seed`) — do not compile into the prod image. Only
    /// [`FakeLedger`] implements this for real; the default returns a permanent `Rejected` so any
    /// other ledger (e.g. the real `AgentLedger`) refuses rather than silently no-ops. The route is
    /// only ever wired against a `FakeLedger` in the local e2e harness.
    #[cfg(feature = "test-helpers")]
    async fn seed_deposit(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<(), LedgerError> {
        // Deliberately consume the args so unused-variable lints stay clean on impls that take the
        // default (every real impl overrides this).
        let _ = (pubkey, currency, amount);
        Err(LedgerError::Rejected("seed_deposit not supported on this ledger".into()))
    }

    /// Liveness for the merchant's pre-flight green dot.
    async fn healthy(&self) -> bool;
}

// ---------------------------------------------------------------------------
// FakeLedger — in-memory, canister-faithful.
// ---------------------------------------------------------------------------

struct FakeState {
    /// Composite key `(pubkey, currency)` → balance in minor units. A single account may hold
    /// multiple currencies independently — they're different assets, not one pool.
    balances: HashMap<([u8; PUBKEY_LEN], Currency), u64>,
    spent: HashSet<[u8; NONCE_LEN]>,
    /// Single-use withdrawal idempotency keys (mirror of the canister's `WITHDRAW_NONCES`, kept
    /// SEPARATE from `spent` so a withdraw nonce can't collide with/block a pay nonce). A signed
    /// [`WithdrawAuth`] may be submitted at most once; a replay is `Rejected` (NonceReused).
    withdraw_nonces: HashSet<[u8; NONCE_LEN]>,
    /// Settled transactions, oldest-first (the order they were pushed). `transactions_of` reverses
    /// to newest-first and filters by (currency, account). Mirrors the canister's ACCOUNT_TXNS so
    /// the relay's inner loop is canister-faithful on history too.
    txns: Vec<TxnRecord>,
    /// Test/demo seeding for the deposit path: a pending (unconfirmed) inbound UTXO per
    /// `(pubkey, currency)`. `deposit_status` drains this and credits `balances`, mirroring the
    /// minter's `update_balance` mint-after-confirmation. Lets the offline inner loop prove the
    /// deposit→mint→balance flow without a real ckBTC minter.
    pending_deposits: HashMap<([u8; PUBKEY_LEN], Currency), u64>,
    /// Monotonic stand-in for the ICRC ledger block index (the FakeLedger has no real ledger), so
    /// each settled pay gets a distinct `block_index` for its receipt claim — matching the real
    /// canister's outcome-attestation shape.
    next_block: u64,
    /// Durable per-nonce receipt store — mirrors the canister's `RECEIPTS` stable map (MC4 U3).
    /// Populated atomically inside `pay`'s critical section so a `receipt(nonce)` lookup returns the
    /// signed outcome even after the relay's process-local idempotency cache is gone (restart). This
    /// is the durable recovery source the relay falls back to; the process cache is only an
    /// optimization. Keyed by the single-use nonce (the canister enforces one settle per nonce).
    receipts: HashMap<[u8; NONCE_LEN], Receipt>,
}

/// In-memory ledger. Balances + spent-nonces behind one `Mutex` so the read-check-write is
/// atomic (the real canister is single-threaded, giving the same guarantee for free).
pub struct FakeLedger {
    state: Mutex<FakeState>,
    per_tx_cap: u64,
    clock: Box<dyn Clock>,
    /// Stable TEST-ONLY Ed25519 key the FakeLedger signs receipts with (the real canister generates
    /// its own via `raw_rand`). A fixed seed keeps it deterministic across runs; its public half is
    /// exposed via [`Ledger::receipt_pubkey`] and embedded in each receipt. Test code only — never
    /// in the prod canister/relay image (FakeLedger itself is the offline demo ledger).
    receipt_sk: SigningKey,
}

impl FakeLedger {
    /// Pre-fund the two demo accounts in `DEMO_USD` and set the per-transaction cap. Uses the wall
    /// clock.
    pub fn new(
        account_a: [u8; PUBKEY_LEN],
        balance_a: u64,
        account_b: [u8; PUBKEY_LEN],
        balance_b: u64,
        per_tx_cap: u64,
    ) -> Self {
        Self::with_clock(
            account_a,
            balance_a,
            account_b,
            balance_b,
            per_tx_cap,
            Box::new(SystemClock),
        )
    }

    /// Same, with an injected clock (deterministic tests / demos).
    pub fn with_clock(
        account_a: [u8; PUBKEY_LEN],
        balance_a: u64,
        account_b: [u8; PUBKEY_LEN],
        balance_b: u64,
        per_tx_cap: u64,
        clock: Box<dyn Clock>,
    ) -> Self {
        // Pre-funding is in DEMO_USD — the demo ledger's only asset. A real ledger's init would
        // carry the currency alongside each balance; here there's just one.
        let mut balances = HashMap::new();
        if balance_a > 0 {
            balances.insert((account_a, DEMO_USD), balance_a);
        }
        if balance_b > 0 {
            balances.insert((account_b, DEMO_USD), balance_b);
        }
        FakeLedger {
            state: Mutex::new(FakeState {
                balances,
                spent: HashSet::new(),
                withdraw_nonces: HashSet::new(),
                txns: Vec::new(),
                pending_deposits: HashMap::new(),
                next_block: 0,
                receipts: HashMap::new(),
            }),
            per_tx_cap,
            clock,
            // Fixed test seed (documented test-only). The real canister's receipt key comes from
            // `raw_rand`; this stable key lets the offline e2e verify a real signature end-to-end.
            receipt_sk: SigningKey::from_bytes(&[0xf5; 32]),
        }
    }

    /// Read a balance (test/demo introspection; not part of the trait).
    pub fn balance_of(&self, pubkey: &[u8; PUBKEY_LEN], currency: Currency) -> u64 {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        *s.balances.get(&(*pubkey, currency)).unwrap_or(&0)
    }

    /// Seed a pending deposit for `pubkey`/`currency` (test/demo hook). The next `deposit_status`
    /// call drains it and credits the balance, mirroring the ck minter minting after confirmations.
    /// Multiple seeds for the same `(pubkey, currency)` accumulate.
    pub fn register_deposit(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency, amount: u64) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        *s.pending_deposits.entry((pubkey, currency)).or_insert(0) += amount;
    }
}

/// The catalog the offline FakeLedger reports — mirrors a demo deployment: DEMO_USD (currency 0,
/// mintable, the `∂` faucet asset) + ckBTC (currency 1, the CkBtcUtxo deposit/withdraw ramp asset) +
/// ckUSDC (currency 2, the CkEthErc20 onramp asset) + ckUSDT (currency 3, a SECOND CkEthErc20
/// proving the onramp is per-token, not hardcoded to currency 2 / USDC — MC8 U2). The principal text
/// values are the canonical management/anon/minter stand-ins the demo uses (`aaaaa-aa` = the mgmt
/// canister, `2vxsx-fae` = the anonymous principal, `mqygn-kiaaa-aaaar-qaadq-cai` = the live ckBTC
/// minter, `sv3dd-…` = the live ckETH minter, `xevnm-…` = the live ckUSDC ledger); the wallet reads
/// `currency`/`symbol`/`decimals`/`minter_family` + the MC1 unit 5 per-currency metadata for display.
/// Hardcoded as TEXT (not built via `candid::Principal`) because `candid` is feature-gated to `agent`
/// and `ledger.rs` ships in the lean offline build.
///
/// Ramp honesty (MC1 unit 5, no-swap non-negotiable + OPEN_ISSUES O3): DEMO onramp=`Direct` (faucet),
/// offramp=`Unavailable`; ckBTC onramp=`Direct` (Bitcoin ramp), offramp=`Direct`; ckUSDC
/// onramp=`Direct` (ckETH helper built client-side), offramp=`Direct` (the dual-ledger `withdraw_erc20`
/// cash-out, gated on the user holding ckETH for gas); ckUSDT/ckDAI onramp=`Direct`, offramp=
/// `Unavailable` (their cash-out is not yet wired — only ckUSDC is the e2e proof).
fn fake_catalog() -> Vec<CurrencyDescriptor> {
    vec![
        CurrencyDescriptor {
            currency: DEMO_USD,
            ledger: "aaaaa-aa".to_string(), // management canister text
            mintable: true,
            minter: None,
            minter_family: None,
            symbol: Some("$".into()),
            decimals: Some(2),
            wrapper_name: None,
            backing_symbol: None,
            network: None,
            display_decimals: None,
            fee: None,
            cap: None,
            chain_id: None,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Direct, // self-service faucet (fixed amount, rate-limited)
            offramp: RampCapability::Unavailable, // play money — no cash-out
        },
        CurrencyDescriptor {
            currency: 1, // ckBTC-shaped deposit currency
            ledger: "2vxsx-fae".to_string(), // anonymous principal text
            mintable: false,
            minter: Some("mqygn-kiaaa-aaaar-qaadq-cai".to_string()),
            minter_family: Some(MinterFamily::CkBtcUtxo),
            symbol: Some("₿".into()),
            decimals: Some(8),
            wrapper_name: Some("ckBTC".into()),
            backing_symbol: Some("BTC".into()),
            network: Some("Bitcoin".into()),
            display_decimals: Some(8),
            fee: None,        // ckBTC ledger fee read live at runtime (MC2 validates)
            cap: None,
            chain_id: None,   // not EVM
            token_contract: None,
            gas_ledger: None, // BTC family — no ckETH gas ledger
            onramp: RampCapability::Direct, // chain-key Bitcoin ramp
            offramp: RampCapability::Direct, // retrieve_btc_with_approval
        },
        CurrencyDescriptor {
            currency: 2, // ckUSDC (ckERC-20 onramp + cash-out currency)
            ledger: "xevnm-gaaaa-aaaar-qafnq-cai".to_string(), // ckUSDC ledger principal text (O6)
            mintable: false,
            minter: Some("sv3dd-oaaaa-aaaar-qacoa-cai".to_string()), // ckETH minter
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("ckUSDC".to_string()),
            decimals: Some(6),
            wrapper_name: Some("ckUSDC".into()),
            backing_symbol: Some("USDC".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(6),
            fee: Some(U64String(10_000)), // ckUSDC ledger icrc1_fee (O6): 0.01 USDC = 10000 raw
            cap: None,
            chain_id: Some(1), // Ethereum mainnet
            token_contract: Some(CKUSDC_ERC20_ADDRESS.to_string()), // ckUSDC ERC-20 (O6) — single-sourced constant
            // The dual-ledger `withdraw_erc20` cash-out burns ckETH gas fees from THIS ledger (the
            // verified mainnet ckETH ledger) + the USDC amount from `ledger` above. The user MUST
            // hold ckETH for gas (Fork-C — dpay never converts ckUSDC→ckETH, no-swap); the app
            // surfaces an honest "You need ckETH for gas" note.
            gas_ledger: Some(CKETH_LEDGER_PRINCIPAL.to_string()),
            onramp: RampCapability::Direct, // ckETH helper-contract onramp (client-side)
            offramp: RampCapability::Direct, // dual-ledger withdraw_erc20 cash-out (ckETH gas + USDC amount)
        },
        CurrencyDescriptor {
            // MC8 U2 — a SECOND ckERC20 token proving the onramp is CATALOG/TOKEN-SPECIFIC, not
            // hardcoded to currency 2 / USDC. ckUSDT carries its OWN ERC-20 contract (real mainnet
            // USDT), so the onramp must surface the USDT address — never USDC's. Same minter
            // (ckETH minter handles all ckERC20), same helper address, same chain; only the
            // `token_contract` + display metadata differ. The `gas_ledger` is the SAME ckETH ledger
            // (one gas ledger serves every ckERC20 cash-out). Ramp honesty: ckUSDT cash-out is not
            // yet wired (offramp=`Unavailable`) — only ckUSDC is the e2e proof; ckUSDT keeps the
            // no-swap fail-closed gate until its offramp is enabled.
            currency: 3, // ckUSDT (a second ckERC-20 onramp currency)
            ledger: "xevnm-gaaaa-aaaar-qafnq-cai".to_string(), // ckUSDT ledger principal text (demo stand-in)
            mintable: false,
            minter: Some("sv3dd-oaaaa-aaaar-qacoa-cai".to_string()), // ckETH minter (handles all ckERC20)
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("ckUSDT".to_string()),
            decimals: Some(6),
            wrapper_name: Some("ckUSDT".into()),
            backing_symbol: Some("USDT".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(6),
            fee: Some(U64String(10_000)), // demo stand-in (mirrors ckUSDC's 6-decimal fee unit)
            cap: None,
            chain_id: Some(1), // Ethereum mainnet
            token_contract: Some("0xdAC17F958D2ee523a2206206994597C13D831ec7".into()), // real USDT ERC-20
            gas_ledger: Some(CKETH_LEDGER_PRINCIPAL.to_string()), // ckETH gas ledger (shared by all ckERC20)
            onramp: RampCapability::Direct, // ckETH helper-contract onramp (client-side, per-token)
            offramp: RampCapability::Unavailable, // cash-out not yet wired (only ckUSDC) — Fork-C gate
        },
        CurrencyDescriptor {
            // OPEN_ISSUES #3 — an 18-decimal ckERC20 to close the decimal-edges coverage gap.
            // ckDAI mirrors its native 18-dec precision (DAI on Ethereum mainnet is 18 dec), giving
            // the format path a fixture at the precision extreme where Number's 2^53 mantissa would
            // drop low digits. Same ckETH minter + helper + chain as the other ckERC20 entries; only
            // `decimals`/`display_decimals`/`token_contract`/display metadata differ. The `gas_ledger`
            // is the SAME ckETH ledger (one gas ledger serves every ckERC20 cash-out). Ramp honesty:
            // ckDAI cash-out is not yet wired (offramp=`Unavailable`) — only ckUSDC is the e2e proof.
            currency: 4, // ckDAI (18-dec ckERC-20 — the precision-extreme fixture)
            ledger: "xevnm-gaaaa-aaaar-qafnq-cai".to_string(), // ckDAI ledger principal text (demo stand-in)
            mintable: false,
            minter: Some("sv3dd-oaaaa-aaaar-qacoa-cai".to_string()), // ckETH minter (handles all ckERC20)
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("ckDAI".to_string()),
            decimals: Some(18),
            wrapper_name: Some("ckDAI".into()),
            backing_symbol: Some("DAI".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(18),
            fee: Some(U64String(10_000_000_000_000_000)), // demo stand-in — 0.01 DAI at 18 dec = 1e16 raw
            cap: None,
            chain_id: Some(1), // Ethereum mainnet
            token_contract: Some("0x6B175474E89094C44Da98b954EedeAC495271d0F".into()), // real DAI ERC-20
            gas_ledger: Some(CKETH_LEDGER_PRINCIPAL.to_string()), // ckETH gas ledger (shared by all ckERC20)
            onramp: RampCapability::Direct, // ckETH helper-contract onramp (client-side, per-token)
            offramp: RampCapability::Unavailable, // cash-out not yet wired (only ckUSDC) — Fork-C gate
        },
        CurrencyDescriptor {
            // Native ETH within the CkEthErc20 family — discriminated by `token_contract == None`
            // (the app's `familyDisplay` branches CkEthErc20 on this: None ⇒ FD_CKETH_NATIVE ⇒ the
            // Cash-out button renders + the withdraw sheet uses 18-dec Wei). This is the catalog entry
            // the e2e drives through the native-ETH withdraw path (the facade's `withdraw` family
            // dispatch burns ckETH → sends native ETH). Same ckETH minter + chain as the other
            // ckERC20 entries; only `token_contract` (None) + the 18-dec/ETH display metadata differ.
            // Ramp honesty: onramp=Direct (single payable `depositEth` tx), offramp=Direct (withdraw_eth).
            // `gas_ledger` is None: native ckETH's gas ledger IS its own `ledger` (the `withdraw_eth`
            // path approves amount+fee on the single ckETH ledger), so it carries no separate gas ledger.
            currency: 5, // native ckETH (CkEthErc20 + token_contract None)
            ledger: "xevnm-gaaaa-aaaar-qafnq-cai".to_string(), // ckETH ledger principal text (demo stand-in)
            mintable: false,
            minter: Some("sv3dd-oaaaa-aaaar-qacoa-cai".to_string()), // ckETH minter (handles native ETH + all ckERC20)
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("Ξ".to_string()),
            decimals: Some(18),
            wrapper_name: Some("ckETH".into()),
            backing_symbol: Some("ETH".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(18),
            fee: Some(U64String(10_000_000_000_000_000)), // demo stand-in — 0.01 ETH at 18 dec = 1e16 raw
            cap: Some(U64String(100_000)),
            chain_id: Some(1), // Ethereum mainnet
            token_contract: None, // None ⇒ native ETH (NOT an ERC-20) — the family discriminator
            gas_ledger: None, // native ETH — its own ledger IS the gas ledger (withdraw_eth single-ledger path)
            onramp: RampCapability::Direct, // ckETH helper `depositEth` (client-side, single payable tx)
            offramp: RampCapability::Direct, // withdraw_eth: burn ckETH → send native ETH
        },
    ]
}

/// Map a `dpay_core::PayError` (or codec failure) to the relay's rejection string. All of these
/// are permanent — none should be retried.
fn rejected(e: PayError) -> LedgerError {
    LedgerError::Rejected(format!("{e:?}"))
}

#[async_trait]
impl Ledger for FakeLedger {
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError> {
        // Decode + verify are pure; do them outside the lock.
        let sa = SignedAuthorization::from_wire(&wire)
            .map_err(|e: CodecError| LedgerError::Rejected(format!("decode: {e:?}")))?;
        let sig_ok = sa.verify();
        let now = self.clock.now_secs();
        let currency = sa.auth.currency;

        // Cheap local rejects that mirror the canister's `pay` body EXACTLY (W3 audit: the FakeLedger
        // must not accept a payment the real canister rejects). The canister rejects a self-transfer
        // (`from == to`) and a payment to the mint sentinel (`to == [0xFF;32]`) before reserving the
        // nonce; the FakeLedger does the same so the two can't diverge.
        if sa.auth.from == sa.auth.to {
            return Err(LedgerError::Rejected("self transfer".to_string()));
        }
        if sa.auth.to == MINT_ACCOUNT {
            return Err(LedgerError::Rejected("pay to mint sentinel".to_string()));
        }

        // Single critical section: read balance/nonce, validate, commit atomically — exactly the
        // canister's `pay` body. Lookups are keyed by (pubkey, currency) — debiting/crediting the
        // asset the authorization actually names.
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let from = sa.auth.from;
        let balance = *s.balances.get(&(from, currency)).unwrap_or(&0);
        let nonce_seen = s.spent.contains(&sa.auth.nonce);

        validate(&sa.auth, now, self.per_tx_cap, balance, nonce_seen, sig_ok).map_err(rejected)?;

        let new_from = balance - sa.auth.amount;
        s.balances.insert((from, currency), new_from);
        *s.balances.entry((sa.auth.to, currency)).or_insert(0) += sa.auth.amount;
        s.spent.insert(sa.auth.nonce);
        // Record the settled payment so the wallet's history list is sourced from the ledger (not an
        // ephemeral UI state). Matches the canister's per-(account,currency) index; FakeLedger keeps
        // one flat list and filters on read.
        s.txns.push(TxnRecord {
            from: hex::encode(from),
            to: hex::encode(sa.auth.to),
            amount: U64String(sa.auth.amount),
            nonce: hex::encode(sa.auth.nonce),
            currency,
            timestamp: now,
            // Names + memo flow from the signed wire into history (N6/H3): the payee sees the
            // payer's name, not a raw pubkey.
            from_name: display_field_to_string(&sa.auth.from_name),
            to_name: display_field_to_string(&sa.auth.to_name),
            memo: display_field_to_string(&sa.auth.memo),
        });
        // Assign a monotonic block index (stand-in for the ICRC ledger block) and sign the receipt
        // claim with the FakeLedger's stable test key — the offline analogue of the canister's
        // canister-signed outcome receipt. The app verifies `receipt_sig` under `pubkey` before
        // showing "Paid ✓".
        let block_index = s.next_block;
        s.next_block += 1;
        let claim = ReceiptClaim {
            nonce: sa.auth.nonce,
            from,
            to: sa.auth.to,
            amount: sa.auth.amount,
            currency,
            block_index,
            settle_ts: now,
        };
        let sig = sign_receipt(&self.receipt_sk, &claim).to_bytes();
        let pubkey = self.receipt_sk.verifying_key().to_bytes();

        let receipt = Receipt {
            from: hex::encode(from),
            to: hex::encode(sa.auth.to),
            amount: U64String(sa.auth.amount),
            nonce: hex::encode(sa.auth.nonce),
            new_from_balance: U64String(new_from),
            currency,
            block_index: U64String(block_index),
            settle_ts: now,
            receipt_sig: hex::encode(sig),
            pubkey: hex::encode(pubkey),
        };
        // Durable store: mirror the canister's per-nonce `RECEIPTS` map so `receipt(nonce)` recovers
        // the signed outcome after a relay restart (when the process-local idempotency cache is gone).
        // Inserted inside the same critical section as the balance commit, so the receipt is observable
        // iff the settle is (atomic, like the canister's post-commit store).
        s.receipts.insert(sa.auth.nonce, receipt.clone());
        Ok(receipt)
    }

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        Ok(self.balance_of(&pubkey, currency))
    }

    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError> {
        Ok(self.receipt_sk.verifying_key().to_bytes().to_vec())
    }

    /// Durable per-nonce receipt lookup — mirrors the canister's `receipt(nonce)` query. Returns the
    /// signed outcome for a settled nonce, or `None` if it never settled (the process-local
    /// idempotency cache is an optimization; this is the source of truth the relay falls back to
    /// after a restart).
    async fn receipt(&self, nonce: [u8; NONCE_LEN]) -> Result<Option<Receipt>, LedgerError> {
        Ok(self.state.lock().unwrap_or_else(|p| p.into_inner()).receipts.get(&nonce).cloned())
    }

    async fn faucet(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        // FakeLedger is the permissive DEMO model: credit the requested amount, no cooldown (play
        // money; the e2e flow exercises a repeatable top-up). The real canister's faucet mints a
        // FIXED amount and rate-limits — proven on PocketIC, not modeled here.
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let bal = s.balances.entry((to, currency)).or_insert(0);
        *bal = bal.saturating_add(amount);
        Ok(*bal)
    }

    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let pk_hex = hex::encode(pubkey);
        // FakeState pushes oldest-first; filter to this (currency, account) and reverse to newest.
        let mut rows: Vec<TxnRecord> = s
            .txns
            .iter()
            .filter(|t| t.currency == currency && (t.from == pk_hex || t.to == pk_hex))
            .cloned()
            .collect();
        rows.reverse();
        Ok(rows.into_iter().take(limit.max(1) as usize).collect())
    }

    async fn healthy(&self) -> bool {
        // In-memory ledger is healthy iff its mutex isn't poisoned.
        self.state.lock().is_ok()
    }

    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        _currency: Currency,
    ) -> Result<String, LedgerError> {
        // Deterministic fake address: a recognizable `bc1qdpay` prefix + the first 8 pubkey bytes
        // (hex). Distinct per pubkey, stable across calls — enough to drive the wallet's "show my
        // deposit address" UI offline. Mirrors how a real minter derives per-principal addresses.
        Ok(format!("bc1qdpay{}", hex::encode(&pubkey[..8])))
    }

    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError> {
        // Drain the pending deposit for this (pubkey, currency) and credit the balance — the
        // offline analogue of the minter's `update_balance` minting confirmed UTXOs. A second call
        // finds nothing pending and reports minted_total = 0.
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(amount) = s.pending_deposits.remove(&(pubkey, currency)) {
            let bal = s.balances.entry((pubkey, currency)).or_insert(0);
            *bal = bal.saturating_add(amount);
            Ok(DepositRefresh {
                minted: vec![MintedUtxo { block_index: "0".to_string(), amount: U64String(amount) }],
                minted_total: U64String(amount),
                pending: vec![],
                required_confirmations: 1,
            })
        } else {
            Ok(DepositRefresh {
                minted: vec![],
                minted_total: U64String(0),
                pending: vec![],
                required_confirmations: 1,
            })
        }
    }

    async fn deposit_info(&self, _currency: Currency) -> Result<DepositInfo, LedgerError> {
        // Fake deposit params: 1 confirmation, no fee, no minimum — the most permissive config, so
        // the offline loop's "Add money" sheet always renders instructions.
        Ok(DepositInfo {
            min_confirmations: 1,
            deposit_fee: U64String(0),
            deposit_min_amount: Some(U64String(0)),
        })
    }

    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError> {
        Ok(fake_catalog())
    }

    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError> {
        // MC8 U2: resolve the onramp from the CATALOG descriptor, not a hardcoded `currency == 2`
        // guard. Reads `self.currencies()` (the same `fake_catalog()` the wallet sees) so the
        // descriptor is the single source of truth, then delegates to the shared pure resolver.
        // `facade_principal` is the demo stand-in (offline mode never broadcasts — the calldata
        // encoding is shape-correct regardless; in production this is the facade canister id).
        let catalog = self.currencies().await?;
        let desc = catalog.iter().find(|d| d.currency == currency);
        ckerc20_onramp_from_descriptor(desc, "aaaaa-aa".to_string())
    }

    /// Withdraw ckBTC to a native BTC address. Mirrors the canister's `withdraw` settlement EXACTLY
    /// (W3 audit: the FakeLedger's accept/reject must match the real canister). Single critical
    /// section under the `FakeState` mutex (the canister is single-threaded; same guarantee). There
    /// is no real minter here, so the "burn" is modeled as a direct debit of `amount` from the user's
    /// subaccount (the net ledger effect of retrieve_btc_with_approval). The signed WithdrawAuth is
    /// verified under `from` (== the debit subaccount) before any state change — non-custodial.
    async fn withdraw(&self, req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        // Extract the u64 once at the JSON boundary (amount crosses the wire as a decimal string;
        // internal Rust arithmetic uses the native u64).
        let amount = req.amount.0;
        // Decode hex fields outside the lock (pure; a bad shape is a permanent reject).
        let from = hex::decode(&req.from)
            .map_err(|e| LedgerError::Rejected(format!("bad from hex: {e}")))
            .and_then(|b| {
                <[u8; PUBKEY_LEN]>::try_from(b.as_slice())
                    .map_err(|_| LedgerError::Rejected("from must be 32 bytes".into()))
            })?;
        let nonce = hex::decode(&req.nonce)
            .map_err(|e| LedgerError::Rejected(format!("bad nonce hex: {e}")))
            .and_then(|b| {
                <[u8; NONCE_LEN]>::try_from(b.as_slice())
                    .map_err(|_| LedgerError::Rejected("nonce must be 16 bytes".into()))
            })?;
        let sig_arr = hex::decode(&req.sig)
            .map_err(|e| LedgerError::Rejected(format!("bad sig hex: {e}")))
            .and_then(|b| {
                <[u8; 64]>::try_from(b.as_slice())
                    .map_err(|_| LedgerError::Rejected("sig must be 64 bytes".into()))
            })?;
        let sig = Signature::from_bytes(&sig_arr);

        // NON-CUSTODIAL GATE: rebuild the WithdrawAuth + verify the signature under `from` BEFORE
        // reserving the nonce or touching the balance. `from` is both the verify key AND the debit
        // subaccount, so a signature under any other key moves no funds. (Mirrors the canister, which
        // checks the sig before the nonce reserve.)
        let auth = WithdrawAuth {
            from_pubkey: from,
            destination: req.destination.clone(),
            nonce,
            expiry: req.expiry,
            currency: req.currency,
            amount,
        };
        if !auth.verify(&from, &sig) {
            return Err(LedgerError::Rejected("bad signature".to_string()));
        }

        let now = self.clock.now_secs();
        // Cheap local rejects (mirror the canister's pre-burn checks).
        if amount == 0 {
            return Err(LedgerError::Rejected("zero amount".to_string()));
        }
        if req.expiry < now {
            return Err(LedgerError::Rejected("expired".to_string()));
        }
        // The retrieve_btc_min_amount floor is BTC-FAMILY-SPECIFIC: the canister's family dispatch
        // applies it only inside the CkBtcUtxo branch (retrieve_btc_with_approval). The ckETH minter
        // enforces its OWN governed minimum_withdrawal_amount for native ETH, so a CkEthErc20 withdraw
        // must NOT be rejected against the BTC sat floor here (else the native-ETH cash-out path is
        // unreachable). Resolve the family from the same catalog the wallet sees.
        let family = fake_catalog()
            .into_iter()
            .find(|d| d.currency == req.currency)
            .and_then(|d| d.minter_family);
        if family == Some(MinterFamily::CkBtcUtxo)
            && amount < RETRIEVE_BTC_MIN_AMOUNT
        {
            return Err(LedgerError::Rejected(format!(
                "amount below retrieve_btc_min_amount ({RETRIEVE_BTC_MIN_AMOUNT})"
            )));
        }

        // Single critical section: reserve the withdraw nonce, check funds, commit the burn atomically.
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !s.withdraw_nonces.insert(nonce) {
            return Err(LedgerError::Rejected("nonce already used".to_string()));
        }
        let balance = *s.balances.get(&(from, req.currency)).unwrap_or(&0);
        if amount > balance {
            // Insufficient funds: the canister RELEASES the nonce (retryable pre-burn failure); mirror
            // that here so a later deposit + same-auth retry can succeed within the expiry window.
            s.withdraw_nonces.remove(&nonce);
            return Err(LedgerError::Rejected(format!("InsufficientFunds: balance {balance}")));
        }
        // Commit the burn: debit the user's subaccount. (No fee model — the FakeLedger is the fee-less
        // demo ledger; the real canister + ledger enforce the ckBTC transfer fee authoritatively.)
        let new_balance = balance - amount;
        s.balances.insert((from, req.currency), new_balance);
        // Record the withdrawal as a history row (counterparty = MINT_ACCOUNT sentinel, like `burn`).
        let block_index = s.next_block;
        s.next_block += 1;
        s.txns.push(TxnRecord {
            from: hex::encode(from),
            to: hex::encode(MINT_ACCOUNT),
            amount: U64String(amount),
            nonce: hex::encode(nonce),
            currency: req.currency,
            timestamp: now,
            // A synthesized burn row (counterparty = MINT_ACCOUNT sentinel): no signed names/memo
            // apply, so the app's "mint/burn" special-case reads empty strings.
            from_name: String::new(),
            to_name: String::new(),
            memo: String::new(),
        });
        Ok(WithdrawReceipt {
            from: hex::encode(from),
            destination: req.destination,
            amount: U64String(amount),
            nonce: hex::encode(nonce),
            currency: req.currency,
            block_index: U64String(block_index),
        })
    }

    /// Test-only deposit seed (feature-gated; see [`Ledger::seed_deposit`]). Delegates to the
    /// existing `register_deposit` hook so the e2e harness's `POST /api/v1/test/deposit/seed`
    /// exercises the *exact* pending→credited path a real refresh would, through the real router.
    #[cfg(feature = "test-helpers")]
    async fn seed_deposit(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<(), LedgerError> {
        self.register_deposit(pubkey, currency, amount);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// FlakyLedger — test-only retry harness.
// ---------------------------------------------------------------------------

/// Wraps a ledger and returns [`LedgerError::Transient`] for the first `fail_first` calls to
/// `pay`, then delegates. Used to prove the relay's retry loop eventually succeeds. Not compiled
/// into the shipping binary in spirit, but kept in the lib so integration tests can reach it.
pub struct FlakyLedger<L: Ledger> {
    inner: L,
    fail_first: Mutex<u32>,
}

impl<L: Ledger> FlakyLedger<L> {
    pub fn new(inner: L, fail_first: u32) -> Self {
        FlakyLedger {
            inner,
            fail_first: Mutex::new(fail_first),
        }
    }
}

#[async_trait]
impl<L: Ledger> Ledger for FlakyLedger<L> {
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError> {
        // Decrement-and-check under the lock, then release before awaiting inner.
        let should_fail = {
            let mut n = self.fail_first.lock().unwrap_or_else(|p| p.into_inner());
            if *n > 0 {
                *n -= 1;
                true
            } else {
                false
            }
        };
        if should_fail {
            return Err(LedgerError::Transient("flaky: injected transient".into()));
        }
        self.inner.pay(wire).await
    }

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        self.inner.balance(pubkey, currency).await
    }

    async fn faucet(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        self.inner.faucet(to, currency, amount).await
    }

    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        self.inner.transactions_of(pubkey, currency, limit).await
    }

    async fn healthy(&self) -> bool {
        self.inner.healthy().await
    }

    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<String, LedgerError> {
        // FlakyLedger only injects transients into `pay` (the retry path under test); the deposit
        // surface is a clean passthrough, mirroring how balance/mint delegate.
        self.inner.deposit_address(pubkey, currency).await
    }

    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError> {
        self.inner.deposit_status(pubkey, currency).await
    }

    async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError> {
        self.inner.deposit_info(currency).await
    }

    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the catalog surface delegates unchanged, mirroring deposit/balance delegation.
        self.inner.currencies().await
    }

    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the ckERC-20 onramp surface delegates unchanged, mirroring catalog/deposit delegation.
        self.inner.ckerc20_onramp_params(currency).await
    }

    async fn withdraw(&self, req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the withdrawal surface delegates unchanged, mirroring balance/faucet/deposit.
        self.inner.withdraw(req).await
    }

    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError> {
        self.inner.receipt_pubkey().await
    }

    async fn receipt(&self, nonce: [u8; NONCE_LEN]) -> Result<Option<Receipt>, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the durable receipt lookup delegates unchanged, mirroring receipt_pubkey.
        self.inner.receipt(nonce).await
    }
}
