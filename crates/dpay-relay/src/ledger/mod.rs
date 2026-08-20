//! The ledger seam. The relay orchestrates (idempotency, retries, HTTP); *settlement* — the
//! read-check-write of money — lives behind this trait.
//!
//! Two impls today:
//! - [`FakeLedger`]: an in-memory ledger that mirrors the canister's `pay` semantics EXACTLY
//!   (same `dpay_core::validate` rules, same atomic transfer, unix-seconds time). This is what
//!   the fast offline inner loop runs against.
//!   error, to exercise the relay's retry path.
//!
//! A real ICP-agent impl (talking to the canister) is out of scope here — it slots in behind the
//! same trait.

use dpay_core::{MEMO_LEN, NAME_LEN};

// Compile-time invariant: the name/memo field widths are identical so `display_field_to_string`
// (in [`types`]) covers both `from_name`/`to_name` and `memo` with one helper.
const _: () = assert!(NAME_LEN == MEMO_LEN);

pub mod api;
pub mod ckerc20;
pub mod clock;
pub mod fake;
pub mod types;

// ---------------------------------------------------------------------------
// Re-exports: the entire public API surface so `crate::ledger::Foo` paths still
// resolve for all consumers (lib.rs re-exports, app.rs, agent_ledger.rs).
// ---------------------------------------------------------------------------

pub use api::Ledger;
pub use ckerc20::{CkErc20OnrampParams, ckerc20_onramp_from_descriptor};
pub use clock::{Clock, FixedClock, SystemClock};
pub use fake::FakeLedger;
pub use types::{
    CurrencyDescriptor, DepositInfo, LedgerError, MinterFamily, RampCapability, TxnRecord,
    U64String,
};

