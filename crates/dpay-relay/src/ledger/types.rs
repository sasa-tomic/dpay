//! Ledger data types: the serde structs/enums that cross the JSON boundary, plus the
//! `U64String` marshalling wrapper (decimal-string `u64` transport).

use dpay_core::Currency;
use serde::Serialize;
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

/// One transaction row, as the wallet's history list shows it. `from`/`to` are PRINCIPAL TEXTS
/// (each side's self-authenticating principal; the empty string for mint/burn sentinel rows —
/// the app renders those with its "Demo funds" label instead of a counterparty). `nonce` is hex,
/// empty on IC-rail rows (which carry no nonce — the app dedups via a composite key).
/// `from_name`/`to_name`/`memo` are display strings, always present and empty when unset (never
/// null); `memo` carries hex-encoded bytes when a memo rode the transfer. `timestamp` is unix
/// seconds. Direction (in/out) is derived by the caller comparing the queried account's principal
/// to `from`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TxnRecord {
    pub from: String,
    pub to: String,
    pub amount: U64String,
    pub nonce: String,
    pub currency: Currency,
    /// Unix seconds. Bounded ≪ 2^53 → crosses JSON as a RAW number by design (MONEY `u64` fields
    /// cross as [`U64String`] decimal strings so the full range round-trips above 2^53).
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
// Catalog surface (M0 → relay-owned 2026-08-28). These serde structs are the
// JSON shape of [`crate::catalog`]'s rows — the relay's compiled-in catalog
// (sole authority; the canister-era `currencies()` query is gone). The
// byte-shape is FROZEN: the wallet + e2e depend on it (principals are TEXT,
// and `MinterFamily` is the plain PascalCase variant tag the wallet reads).
// ---------------------------------------------------------------------------

/// The proxy family a ck currency's minter belongs to — drives per-family ramp dispatch in the
/// wallet. Serialized as the plain variant name (e.g. `"CkBtcUtxo"`), matching the JSON string
/// the wallet reads (the label the canister-era candid variant also used).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum MinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

/// Per-direction ramp capability for a currency (MC1 unit 5). Serialized as the plain variant
/// name (e.g. `"Direct"`), matching the wallet's JSON contract (the label the canister-era
/// candid variant also used). `Unavailable` ⇒ the wallet renders NO button for that direction
/// (no-swap honesty; ckUSDC offramp is `Unavailable` per Fork-C/O3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum RampCapability {
    Direct,
    Partner,
    Unavailable,
}

/// One currency the wallet can hold/fund — the runtime catalog entry (canister-era wire shape,
/// relay-owned since 2026-08-28 — see [`crate::catalog`]). `minter` is `Some` only for ck
/// currencies with a registered ramp; `minter_family`/`symbol`/`decimals` are `None` when
/// unregistered (the wallet falls back). `onramp`/`offramp` are NON-optional
/// `RampCapability` (an unregistered currency fails closed to `Unavailable` for both). The
/// per-currency metadata fields (`wrapper_name`/`backing_symbol`/`network`/`display_decimals`/
/// `fee`/`cap`/`chain_id`/`token_contract`/`gas_ledger`) are the authoritative single source of
/// truth; the relay is a pass-through.
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

/// Ledger call outcome. `Rejected` is a permanent failure (unknown currency, no onramp
/// configured for the family, malformed request) — surfaced as `422` on the route that carries
/// it. `Transient` is an infrastructure hiccup (the canister/ledger briefly unreachable) —
/// surfaced as `503`, or the entry is silently omitted from the batch balances fan-out.
#[derive(Clone, Debug, Error)]
pub enum LedgerError {
    #[error("rejected: {0}")]
    Rejected(String),
    #[error("transient: {0}")]
    Transient(String),
}
