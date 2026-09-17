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
pub mod jupiter;
pub mod ledger;
pub mod sideshift;
pub mod solana;
pub mod till;

/// Unix seconds now — the ONE clock reading in this crate, and it stops rather than guesses.
///
/// Only a host whose clock is set before 1970 can fail here, and substituting `0` (what the till
/// and the faucet each used to do) is worse than stopping, in a different way per caller: the till
/// would time every charge an epoch stale and quietly refuse every sale, while the faucet's
/// cooldown would record every top-up "at the epoch" and — since the clock never advances past it —
/// tell every account to "try again in ~1 h" forever after their first. Both are silent, both are
/// wrong, and neither leaves a caller anything to act on. So it says what happened.
pub(crate) fn now_secs() -> u64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs(),
        Err(e) => panic!(
            "dpay-relay: the system clock is before the unix epoch ({e}) — this relay cannot time \
             a charge, a quote or a faucet cooldown"
        ),
    }
}

/// The same single clock as [`now_secs`], read at millisecond grain — its only reader is the
/// solana read cache's expiry math, whose test seams use sub-second TTLs (second granularity
/// would make a 60ms test window expire "never" and a real 2s TTL untestable offline). Same
/// stop-rather-than-guess failure mode as [`now_secs`].
pub(crate) fn now_millis() -> u64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64,
        Err(e) => panic!(
            "dpay-relay: the system clock is before the unix epoch ({e}) — this relay cannot time \
             a charge, a quote, a faucet cooldown or a cache entry"
        ),
    }
}

/// The faucet's relay-side cooldown — the resurrection of the old canister faucet's rate limit
/// (window, granularity and verbatim error text). Compiled whenever ANY faucet route exists, which
/// since 2026-09-08 means both builds: the offline fixture used to serve an unlimited faucet while
/// production served one top-up an hour, and the e2e suite had calibrated itself to the fixture.
/// Pure logic + its own unit tests. Compiled with the cooldown map on `AppState` and with nothing
/// else — a build that serves no faucet route needs neither, and gating them apart is what made
/// `cargo check` with default features fail on 2026-09-08.
#[cfg(any(feature = "agent", feature = "test-helpers"))]
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
