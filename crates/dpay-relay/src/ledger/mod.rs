//! The ledger read seam. Post-cutover (2026-08-19) the relay orchestrates nothing value-bearing:
//! the app signs /api/v2 envelopes locally and submits them to boundary nodes. What lives behind
//! this trait is the relay's READ surface — balances/history at the user's principal, and static
//! deposit/onramp metadata. The currency CATALOG lives in [`crate::catalog`] (compiled in — the
//! sole authority since the founder's 2026-08-28 decision), not behind this trait.
//!
//! Two impls:
//! - [`FakeLedger`]: the in-memory demo ledger the offline inner loop runs against (balances
//!   read 0 — value only exists on the IC rail or the test-helpers fake-IC gateway).
//! - `AgentLedger` (feature `agent`): the real ic-agent path against the ICRC ledgers directly.

pub mod api;
pub mod ckerc20;
pub mod fake;
pub mod types;

// ---------------------------------------------------------------------------
// Re-exports: the public API surface so `crate::ledger::Foo` paths resolve for
// all consumers (lib.rs re-exports, app.rs, agent_ledger.rs).
// ---------------------------------------------------------------------------

pub use api::Ledger;
pub use ckerc20::{CkErc20OnrampParams, ckerc20_onramp_from_descriptor};
pub use fake::FakeLedger;
pub use types::{
    CurrencyDescriptor, DepositInfo, LedgerError, MinterFamily, RampCapability, TxnRecord,
    U64String,
};
