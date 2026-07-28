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

use dpay_core::{
    validate, CodecError, Currency, PayError, SignedAuthorization, DEMO_USD, NONCE_LEN, PUBKEY_LEN,
};

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
    /// Settle a 196-byte signed authorization (the payer's QR, decoded to wire bytes). The
    /// settlement currency is read out of the wire — the payer copied the merchant's request
    /// currency into their authorization — so `pay` itself takes no currency argument.
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError>;

    /// Read an account's balance (minor units) of `currency`. Lets a wallet show its live balance
    /// for the asset it actually holds when online.
    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError>;

    /// Demo faucet: credit `to` with `amount` of `currency`, returning the new balance. Funds a
    /// freshly-generated on-device account (stand-in for a real on-ramp).
    async fn mint(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError>;

    /// Liveness for the merchant's pre-flight green dot.
    async fn healthy(&self) -> bool;
}

// ---------------------------------------------------------------------------
// FakeLedger — in-memory, canister-faithful.
// ---------------------------------------------------------------------------

struct FakeState {
    /// Composite key `(pubkey, currency)` → balance in minor units. A single account may hold
    /// multiple currencies independently — they're different assets, not one pool.
    balances: HashMap<([u8; PUBKEY_LEN], Currency), u64>,
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
    /// Pre-fund the two demo accounts in `DEMO_USD` and set the per-transaction cap. Uses the wall
    /// clock.
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
        // Pre-funding is in DEMO_USD — the demo ledger's only asset. A real ledger's init would
        // carry the currency alongside each balance; here there's just one.
        let mut balances = HashMap::new();
        if balance_a > 0 {
            balances.insert((account_a, DEMO_USD), balance_a);
        }
        if balance_b > 0 {
            balances.insert((account_b, DEMO_USD), balance_b);
        }
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
    pub fn balance_of(&self, pubkey: &[u8; PUBKEY_LEN], currency: Currency) -> u64 {
        let s = self.state.lock().unwrap();
        *s.balances.get(&(*pubkey, currency)).unwrap_or(&0)
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
        let currency = sa.auth.currency;

        // Single critical section: read balance/nonce, validate, commit atomically — exactly the
        // canister's `pay` body. Lookups are keyed by (pubkey, currency) — debiting/crediting the
        // asset the authorization actually names.
        let mut s = self.state.lock().unwrap();
        let from = sa.auth.from;
        let balance = *s.balances.get(&(from, currency)).unwrap_or(&0);
        let nonce_seen = s.spent.contains(&sa.auth.nonce);

        validate(&sa.auth, now, self.per_tx_cap, balance, nonce_seen, sig_ok).map_err(rejected)?;

        let new_from = balance - sa.auth.amount;
        s.balances.insert((from, currency), new_from);
        *s.balances.entry((sa.auth.to, currency)).or_insert(0) += sa.auth.amount;
        s.spent.insert(sa.auth.nonce);

        Ok(Receipt {
            from: hex::encode(from),
            to: hex::encode(sa.auth.to),
            amount: sa.auth.amount,
            nonce: hex::encode(sa.auth.nonce),
            new_from_balance: new_from,
        })
    }

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        Ok(self.balance_of(&pubkey, currency))
    }

    async fn mint(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        let mut s = self.state.lock().unwrap();
        let bal = s.balances.entry((to, currency)).or_insert(0);
        *bal = bal.saturating_add(amount);
        Ok(*bal)
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

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        self.inner.balance(pubkey, currency).await
    }

    async fn mint(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        self.inner.mint(to, currency, amount).await
    }

    async fn healthy(&self) -> bool {
        self.inner.healthy().await
    }
}
