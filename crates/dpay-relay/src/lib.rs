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

pub use app::{app, AppState};
pub use ledger::{
    Clock, FakeLedger, FixedClock, FlakyLedger, Ledger, LedgerError, Receipt, SystemClock,
};

#[cfg(feature = "agent")]
pub use agent_ledger::AgentLedger;
