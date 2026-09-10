//! FakeLedger — the offline demo ledger. USER-PRINCIPAL RAIL (2026-08-19 cutover): value
//! movement left the relay entirely, so what remains is the READ surface the offline relay still
//! serves — static deposit info, honest zero balances, and the in-memory history log. The fake-IC
//! /api/v2 gateway (test-helpers) is the settlement substrate for tests now. The CURRENCY
//! CATALOG is not here — it was promoted to the relay-wide compiled catalog
//! ([`crate::catalog`], the sole authority since the founder's 2026-08-28 decision) and this
//! impl reads it from there like every other consumer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;

use dpay_core::{Currency, PUBKEY_LEN};

use super::api::Ledger;
use super::ckerc20::{ckerc20_onramp_from_descriptor, CkErc20OnrampParams};
use super::types::{DepositInfo, LedgerError, TxnRecord, U64String};

/// The facade module hash [`FakeLedger`] reports — a fixed sha256-shaped literal, chosen so it
/// can never collide with a real wasm hash (all `ff`). The SAME literal is baked as the PIN for
/// test-helpers builds (`build.rs` `bake_pinned_facade_hash`), so the integrity route's MATCH
/// state is exercisable offline; the knobs below bend live/pin apart for MISMATCH and
/// UNREACHABLE. The value mirrors `fake.rs`'s const by duplication (build.rs cannot import the
/// crate) — `relay.rs`'s integrity tests assert the two never drift.
pub const FAKE_FACADE_MODULE_HASH: &str =
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

struct FakeState {
    /// Composite key `(pubkey, currency)` → balance in minor units. A single account may hold
    /// multiple currencies independently — they're different assets, not one pool.
    balances: HashMap<([u8; PUBKEY_LEN], Currency), u64>,
    /// Settled transactions, oldest-first (the order they were pushed). `transactions_on_ledger` reverses
    /// to newest-first and filters by (currency, account). Mirrors the canister's ACCOUNT_TXNS so
    /// the relay's inner loop is canister-faithful on history too.
    txns: Vec<TxnRecord>,
}

/// In-memory demo ledger behind one `Mutex` (the real canister is single-threaded, giving the
/// same atomicity guarantee for free).
pub struct FakeLedger {
    state: Mutex<FakeState>,
    /// Integrity-route seam: override for [`Ledger::facade_module_hash`]. `None` (the default)
    /// serves the deterministic [`FAKE_FACADE_MODULE_HASH`] — which the test-helpers build bakes
    /// as the pin, so the route reads MATCH; `Some(text)` serves `text` instead (MISMATCH).
    facade_hash: Mutex<Option<String>>,
    /// Integrity-route seam: when set, [`Ledger::facade_module_hash`] answers `Err` — the
    /// route's UNREACHABLE leg. Takes precedence over the override above.
    facade_unreachable: AtomicBool,
}

impl FakeLedger {
    /// A fresh demo ledger. Post-cutover there is nothing to pre-fund — value never moves through
    /// this map anymore (the fake-IC gateway owns test balances at user principals; prod reads
    /// real ledgers) — so the balance map starts empty and the constructor takes no accounts.
    pub fn new() -> Self {
        FakeLedger {
            state: Mutex::new(FakeState {
                balances: HashMap::new(),
                txns: Vec::new(),
            }),
            facade_hash: Mutex::new(None),
            facade_unreachable: AtomicBool::new(false),
        }
    }

    /// Test seam for `GET /api/v1/integrity`: serve THIS text as the live facade module hash
    /// (e.g. a value that differs from the baked pin → MISMATCH). `None` restores the
    /// deterministic default — the MATCH state.
    pub fn set_facade_hash(&self, hash: Option<String>) {
        *self.facade_hash.lock().unwrap_or_else(|p| p.into_inner()) = hash;
    }

    /// Test seam for `GET /api/v1/integrity`: make `facade_module_hash` answer an error — the
    /// UNREACHABLE state (the IC read failing degrades the route, never 5xxes it).
    pub fn set_facade_unreachable(&self) {
        self.facade_unreachable.store(true, Ordering::Relaxed);
    }

    /// Read a balance (test/demo introspection; not part of the trait). Permanently zero in the
    /// post-cutover relay — funds live at user principals on the IC ledgers (fake-IC gateway in
    /// tests), never in this map.
    pub fn balance_of(&self, pubkey: &[u8; PUBKEY_LEN], currency: Currency) -> u64 {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        *s.balances.get(&(*pubkey, currency)).unwrap_or(&0)
    }
}

#[async_trait]
impl Ledger for FakeLedger {
    async fn transactions_on_ledger(
        &self,
        _ledger: &str,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
        memo: Option<&str>,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let pk_hex = hex::encode(pubkey);
        // FakeState pushes oldest-first; filter to this (currency, account) and reverse to newest.
        // `_ledger` is ignored — the fake has one log, not per-ledger logs (the test-helpers
        // gateway path serves the gateway's principal-keyed rows instead; see app.rs).
        let mut rows: Vec<TxnRecord> = s
            .txns
            .iter()
            .filter(|t| t.currency == currency && (t.from == pk_hex || t.to == pk_hex))
            .filter(|t| memo.is_none_or(|m| t.memo.eq_ignore_ascii_case(m)))
            .cloned()
            .collect();
        rows.reverse();
        Ok(rows.into_iter().take(limit.max(1) as usize).collect())
    }

    async fn healthy(&self) -> bool {
        // In-memory ledger is healthy iff its mutex isn't poisoned. `/health` answers a two-word
        // verdict, so — exactly as in `AgentLedger::healthy` — the log is the only place the cause
        // can live, and a poisoned lock (some earlier handler panicked while holding it) is the one
        // thing that could ever put this build's health red.
        match self.state.lock() {
            Ok(_) => true,
            Err(e) => {
                eprintln!("dpay-relay: health: the fixture ledger's state lock is poisoned ({e}) — an earlier handler panicked while holding it");
                false
            }
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

    async fn ckerc20_onramp_params(
        &self,
        currency: Currency,
    ) -> Result<CkErc20OnrampParams, LedgerError> {
        // MC8 U2: resolve the onramp from the CATALOG descriptor, not a hardcoded `currency == 2`
        // guard. Reads [`crate::catalog::ic_rows`] (the same compiled catalog the wallet sees) so
        // the descriptor is the single source of truth, then delegates to the shared pure resolver.
        // The deposit `principal` arg is the USER's own IC principal (derived in-app) — the relay
        // serves no principal here.
        let catalog = crate::catalog::ic_rows();
        let desc = catalog.iter().find(|d| d.currency == currency);
        ckerc20_onramp_from_descriptor(desc)
    }

    /// Direct balance read for the batch `/balances` handler. The in-memory map is permanently
    /// zero in the post-cutover prod image (no value movement runs through `FakeLedger` anymore —
    /// the faucet is a test-helpers fixture that credits the fake-IC gateway instead), so this is
    /// an honest read of "nothing has ever moved".
    async fn balance_on_ledger(
        &self,
        _ledger: &str,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<u64, LedgerError> {
        Ok(self.balance_of(&pubkey, currency))
    }

    async fn facade_module_hash(&self) -> Result<String, LedgerError> {
        // The integrity route's OFFLINE stand-in: never a network read. Unreachable knob first
        // (it wins over any override), else the override or the deterministic default.
        if self.facade_unreachable.load(Ordering::Relaxed) {
            return Err(LedgerError::Transient(
                "fake-IC state tree is unreachable (test knob)".to_string(),
            ));
        }
        Ok(self
            .facade_hash
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .unwrap_or_else(|| FAKE_FACADE_MODULE_HASH.to_string()))
    }
}
