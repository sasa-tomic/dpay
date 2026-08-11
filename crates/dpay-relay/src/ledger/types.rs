//! Ledger data types: the serde structs/enums that cross the JSON boundary, plus the
//! marshalling helpers (`U64String`, `display_field_to_string`, `decode_hex_array`).

use dpay_core::{Currency, NAME_LEN};
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

/// The minimal withdrawal amount the facade honors, in sats. Mirrors the LIVE ckBTC minter's
/// `retrieve_btc_min_amount` (= 50_000, returned by `get_minter_info` on `mqygn-kiaaa-aaaar-qaadq-cai`
/// and confirmed in OPEN_ISSUES.md) and the canister's `RETRIEVE_BTC_MIN_AMOUNT`. Single-sourced here
/// so the relay's local pre-check + the FakeLedger simulation can't drift from the real floor.
pub(crate) const RETRIEVE_BTC_MIN_AMOUNT: u64 = 50_000;

/// Decode a fixed-width NUL-padded UTF-8 name/memo field (32 bytes on the wire, single-sourced as
/// [`NAME_LEN`]/[`MEMO_LEN`] in core) into the display `String` the relay's JSON history carries.
/// Trims trailing NULs (the builder's padding) and decodes lossily, so a malformed buffer is never a
/// silent error or panic — the core stores/signs/verifies raw bytes; the relay only renders them.
/// `NAME_LEN == MEMO_LEN`, so the same helper covers `from_name`/`to_name` and `memo`.
pub(crate) fn display_field_to_string(buf: &[u8; NAME_LEN]) -> String {
    // Trim trailing NULs (the builder's padding): take through the last non-zero byte. `[u8]` has no
    // `trim_end_matches` (that's a `str` method), so find the boundary by hand, then decode lossily.
    let end = buf.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// Decode a hex string into a fixed-size byte array, surfacing a `Rejected` (→ HTTP 422) on any
/// decode or length failure. Mirrors [`parse_hex_array`](crate::app) on the app side but for
/// ledger-trait callers (the FakeLedger withdrawal path) whose error type is [`LedgerError`] not an
/// HTTP [`Response`](axum::response::Response). `field` labels the bytes in the message so the
/// client can tell `from` from `nonce` from `sig` apart. Byte-identical to the prior inline blocks
/// (two distinct messages per field: `bad {field} hex: {e}` for a hex-decode failure, `{field} must
/// be {N} bytes` for a length mismatch — both surfaced as `Rejected`).
pub(crate) fn decode_hex_array<const N: usize>(s: &str, field: &str) -> Result<[u8; N], LedgerError> {
    let bytes = hex::decode(s)
        .map_err(|e| LedgerError::Rejected(format!("bad {field} hex: {e}")))?;
    <[u8; N]>::try_from(bytes)
        .map_err(|_| LedgerError::Rejected(format!("{field} must be {N} bytes")))
}

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
