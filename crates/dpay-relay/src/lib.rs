//! dpay-relay — the merchant's submit-and-confirm service, and the PoC's only online dependency.
//!
//! Shape:
//! - [`ledger`] — the settlement seam ([`Ledger`] trait) and the in-memory [`FakeLedger`] the
//!   offline inner loop runs against (canister-faithful: same `dpay_core::validate` rules, atomic
//!   transfer, unix-seconds time).
//! - [`app`] — the axum HTTP surface: `POST /pay` (idempotent by nonce, retries transient ledger
//!   errors) and `GET /health`.
//!
//! Money-critical logic is NOT here — it stays in `dpay-core` (shared with the canister & app).
//! The relay only orchestrates: decode the QR, enforce idempotency, retry, speak HTTP.

pub mod app;
pub mod ledger;

/// The real ic-agent settlement path (talks to a live local IC replica). Behind the `agent`
/// feature so the fast in-memory inner loop stays offline; slots in behind the same [`Ledger`]
/// trait, so the axum app is unchanged.
#[cfg(feature = "agent")]
pub mod agent_ledger;

/// Fake-IC `/api/v2` gateway (test-helpers only) — the offline e2e stand-in for icp-api.io.
#[cfg(feature = "test-helpers")]
pub mod ic_gateway;

pub use app::{app, AppState};
pub use ledger::{
    ckerc20_onramp_from_descriptor, Clock, CkErc20OnrampParams, CurrencyDescriptor, DepositInfo,
    DepositRefresh, FakeLedger, FixedClock, Ledger, LedgerError, MinterFamily,
    MintedUtxo, PendingUtxo, RampCapability, Receipt, SystemClock, TxnRecord, U64String,
    WithdrawReceipt, WithdrawRequest,
};

// FlakyLedger is a test-only retry harness (gated in `ledger`); re-export only under the same gate.
#[cfg(any(test, feature = "test-helpers"))]
pub use ledger::FlakyLedger;

#[cfg(feature = "agent")]
pub use agent_ledger::AgentLedger;
