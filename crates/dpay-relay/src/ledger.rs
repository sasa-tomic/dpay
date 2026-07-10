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
use serde::Serialize;
use thiserror::Error;

use dpay_core::{validate, PayError, SignedAuthorization, CodecError, NONCE_LEN, PUBKEY_LEN};

/// What the merchant sees on success. Byte fields are hex so the JSON is a plain string map.
/// Mirrors the canister's `PayReceipt` (which returns the same fields as candid `blob`s).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Receipt {
    pub from: String,
    pub to: String,
    pub amount: u64,
    pub nonce: String,
    pub new_from_balance: u64,
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
    /// Settle a 192-byte signed authorization (the payer's QR, decoded to wire bytes).
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError>;

    /// Liveness for the merchant's pre-flight green dot.
    async fn healthy(&self) -> bool;
}

// ---------------------------------------------------------------------------
// FakeLedger — in-memory, canister-faithful.
// ---------------------------------------------------------------------------

struct FakeState {
    balances: HashMap<[u8; PUBKEY_LEN], u64>,
    spent: HashSet<[u8; NONCE_LEN]>,
}

/// In-memory ledger. Balances + spent-nonces behind one `Mutex` so the read-check-write is
/// atomic (the real canister is single-threaded, giving the same guarantee for free).
pub struct FakeLedger {
    state: Mutex<FakeState>,
    per_tx_cap: u64,
    clock: Box<dyn Clock>,
}

impl FakeLedger {
    /// Pre-fund the two demo accounts and set the per-transaction cap. Uses the wall clock.
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
        let mut balances = HashMap::new();
        balances.insert(account_a, balance_a);
        balances.insert(account_b, balance_b);
        FakeLedger {
            state: Mutex::new(FakeState {
                balances,
                spent: HashSet::new(),
            }),
            per_tx_cap,
            clock,
        }
    }

    /// Read a balance (test/demo introspection; not part of the trait).
    pub fn balance_of(&self, pubkey: &[u8; PUBKEY_LEN]) -> u64 {
        let s = self.state.lock().unwrap();
        *s.balances.get(pubkey).unwrap_or(&0)
    }
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

        // Single critical section: read balance/nonce, validate, commit atomically — exactly the
        // canister's `pay` body.
        let mut s = self.state.lock().unwrap();
        let from = sa.auth.from;
        let balance = *s.balances.get(&from).unwrap_or(&0);
        let nonce_seen = s.spent.contains(&sa.auth.nonce);

        validate(&sa.auth, now, self.per_tx_cap, balance, nonce_seen, sig_ok).map_err(rejected)?;

        let new_from = balance - sa.auth.amount;
        s.balances.insert(from, new_from);
        *s.balances.entry(sa.auth.to).or_insert(0) += sa.auth.amount;
        s.spent.insert(sa.auth.nonce);

        Ok(Receipt {
            from: hex::encode(from),
            to: hex::encode(sa.auth.to),
            amount: sa.auth.amount,
            nonce: hex::encode(sa.auth.nonce),
            new_from_balance: new_from,
        })
    }

    async fn healthy(&self) -> bool {
        // In-memory ledger is healthy iff its mutex isn't poisoned.
        self.state.lock().is_ok()
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
            let mut n = self.fail_first.lock().unwrap();
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

    async fn healthy(&self) -> bool {
        self.inner.healthy().await
    }
}
