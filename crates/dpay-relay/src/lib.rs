//! dpay-relay — the read-and-host surface around the dpay rails.
//!
//! Since the 2026-08-19 user-principal IC-rail cutover, VALUE never touches this crate: the app
//! signs `/api/v2` envelopes locally (dpay-icp) and submits them straight to boundary nodes.
//! What the relay still owns:
//! - [`catalog`] — the compiled-in currency catalog, the SOLE catalog authority (founder
//!   decision 2026-08-28: relay code + git review + `just up` deploy; the facade canister's
//!   registry was removed). Drift-alarmed against `dfx/catalog_truth.json`.
//! - [`ledger`] — the read-only [`Ledger`] trait: balances and history at the user's principal
//!   (real ICRC ledgers via `AgentLedger` under the `agent` feature), plus the in-memory
//!   [`FakeLedger`] demo ledger.
//! - [`app`] — the axum HTTP surface: `/api/v1` read routes (`balances`, `transactions`,
//!   `deposit/info`, `currencies`, `onramp/ckerc20`, `health`, `version`), the ckERC-20 onramp
//!   metadata, the production faucet (`POST /faucet` — test-helpers: fake-IC credit; agent:
//!   relay-side [`faucet`] cooldown + authenticated controller-driven canister mint), and static
//!   hosting (landing page, `/wallet` web app, APK + screenshots, `/dpay-core.wasm`).
//! - Under `test-helpers`: a fake-IC `/api/v2` gateway — the offline e2e stand-in for icp-api.io
//!   (never compiled into the prod image).
//!
//! Money-critical logic is NOT here — it stays in `dpay-core` (shared with the canister & app).

pub mod app;
pub mod catalog;
pub mod ledger;
pub mod till;

/// The agent-build faucet's relay-side cooldown — the resurrection of the old canister faucet's
/// rate limit (window, granularity and verbatim error text). Compiled whenever the PRODUCTION
/// faucet route exists (agent — including with test-helpers co-enabled, the live-test config;
/// the test-helpers-only e2e build's faucet serves the fake-IC gateway instead). Pure logic +
/// its own unit tests.
#[cfg(feature = "agent")]
pub mod faucet;

/// The real ic-agent read path (talks to a live IC — the ICRC ledgers directly; the currency
/// catalog is compiled into [`catalog`], not read from the canister). Behind the `agent`
/// feature so the fast in-memory inner loop stays offline; slots in behind the same
/// [`Ledger`] trait, so the axum app is unchanged.
#[cfg(feature = "agent")]
pub mod agent_ledger;

/// Fake-IC `/api/v2` gateway (test-helpers only) — the offline e2e stand-in for icp-api.io.
#[cfg(feature = "test-helpers")]
pub mod ic_gateway;

pub use app::{app, AppState};
pub use ledger::{
    ckerc20_onramp_from_descriptor, CkErc20OnrampParams, CurrencyDescriptor, DepositInfo,
    FakeLedger, Ledger, LedgerError, MinterFamily, RampCapability, TxnRecord, U64String,
};

#[cfg(feature = "agent")]
pub use agent_ledger::AgentLedger;
