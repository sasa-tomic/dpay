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

/// One settled transaction, as the wallet's history list shows it. Byte fields are hex (matches
/// [`Receipt`]). `timestamp` is unix seconds. Direction (in/out) is derived by the caller comparing
/// the queried account's pubkey to `from`. Mirrors the canister's `TxnView`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TxnRecord {
    pub from: String,
    pub to: String,
    pub amount: u64,
    pub nonce: String,
    pub currency: Currency,
    pub timestamp: u64,
}

// ---------------------------------------------------------------------------
// Deposit surface (ckBTC-style top-up). These mirror the canister's deposit
// types (§3.1 of the deposit-integration plan) but live here as serde structs
// so the relay's HTTP layer speaks plain JSON. The agent impl (feature
// `agent`) translates between these and the candid `Nat`-bearing mirrors.
// ---------------------------------------------------------------------------

/// One UTXO the minter has *already* minted in this refresh call. `block_index` is the ckBTC
/// ledger's block index — a candid `nat` on the wire, so it is carried as a `String` (a `Nat` /
/// `u128` doesn't round-trip cleanly in JSON). Mirrors the canister's `MintedUtxo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MintedUtxo {
    pub block_index: String,
    pub amount: u64,
}

/// One UTXO seen on-chain but not yet confirmed enough to mint. Mirrors the canister's `PendingUtxo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingUtxo {
    pub value: u64,
    pub confirmations: u64,
}

/// Result of a deposit refresh — what the wallet's "Add money" sheet polls. `minted_total > 0`
/// means real ck-asset was just credited to the user's subaccount; the wallet then re-reads its
/// balance. Mirrors the canister's `DepositRefresh`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DepositRefresh {
    pub minted: Vec<MintedUtxo>,
    pub minted_total: u64,
    pub pending: Vec<PendingUtxo>,
    pub required_confirmations: u32,
}

/// Static instructions for a currency's deposit path (min confirmations, fee, min amount). Lets the
/// wallet render "Send BTC here · ~N confirmations · min X sats" before showing the address. Mirrors
/// the canister's `DepositInfo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DepositInfo {
    pub min_confirmations: u32,
    pub deposit_fee: u64,
    pub deposit_min_amount: Option<u64>,
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

    /// List this account's settled transactions in `currency`, newest-first, up to `limit`. Lets a
    /// wallet render a durable history sourced from the ledger (the in-memory UI list is gone on
    /// restart; this is the source of truth).
    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError>;

    /// ckBTC-style deposit address for `pubkey`/`currency` — the native-chain address the user
    /// sends to (the minter derives it per-principal via threshold signatures). Revealing it only
    /// lets someone send *to* the user, so the facade proxy needs no payer auth. The relay just
    /// hands it back.
    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<String, LedgerError>;

    /// Refresh the deposit for `pubkey`/`currency`: asks the facade (→ ck minter `update_balance`)
    /// to mint any now-confirmed UTXOs. Value-creating but idempotent (a no-op when nothing is
    /// confirmed). Returns what was minted + what's still pending. Per the deposit plan's §0 error
    /// rule, the proxy endpoints have **no permanent-policy failure**, so impls surface only
    /// [`LedgerError::Transient`].
    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError>;

    /// Static deposit instructions for `currency` (min confirmations, fee, min amount).
    async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError>;

    /// Seed a pending deposit for `pubkey`/`currency` (the test-helpers hook a browser e2e harness
    /// uses to simulate a confirmed ckBTC deposit landing). Mirrors `FakeLedger::register_deposit`:
    /// the next `deposit_status` drains it and credits the balance.
    ///
    /// **Test-only.** Feature-gated behind `test-helpers` so the method — and the HTTP route that
    /// calls it (`POST /api/v1/test/deposit/seed`) — do not compile into the prod image. Only
    /// [`FakeLedger`] implements this for real; the default returns a permanent `Rejected` so any
    /// other ledger (e.g. the real `AgentLedger`) refuses rather than silently no-ops. The route is
    /// only ever wired against a `FakeLedger` in the local e2e harness.
    #[cfg(feature = "test-helpers")]
    async fn seed_deposit(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<(), LedgerError> {
        // Deliberately consume the args so unused-variable lints stay clean on impls that take the
        // default (every real impl overrides this).
        let _ = (pubkey, currency, amount);
        Err(LedgerError::Rejected("seed_deposit not supported on this ledger".into()))
    }

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
    /// Settled transactions, oldest-first (the order they were pushed). `transactions_of` reverses
    /// to newest-first and filters by (currency, account). Mirrors the canister's ACCOUNT_TXNS so
    /// the relay's inner loop is canister-faithful on history too.
    txns: Vec<TxnRecord>,
    /// Test/demo seeding for the deposit path: a pending (unconfirmed) inbound UTXO per
    /// `(pubkey, currency)`. `deposit_status` drains this and credits `balances`, mirroring the
    /// minter's `update_balance` mint-after-confirmation. Lets the offline inner loop prove the
    /// deposit→mint→balance flow without a real ckBTC minter.
    pending_deposits: HashMap<([u8; PUBKEY_LEN], Currency), u64>,
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
                txns: Vec::new(),
                pending_deposits: HashMap::new(),
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

    /// Seed a pending deposit for `pubkey`/`currency` (test/demo hook). The next `deposit_status`
    /// call drains it and credits the balance, mirroring the ck minter minting after confirmations.
    /// Multiple seeds for the same `(pubkey, currency)` accumulate.
    pub fn register_deposit(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency, amount: u64) {
        let mut s = self.state.lock().unwrap();
        *s.pending_deposits.entry((pubkey, currency)).or_insert(0) += amount;
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
        // Record the settled payment so the wallet's history list is sourced from the ledger (not an
        // ephemeral UI state). Matches the canister's per-(account,currency) index; FakeLedger keeps
        // one flat list and filters on read.
        s.txns.push(TxnRecord {
            from: hex::encode(from),
            to: hex::encode(sa.auth.to),
            amount: sa.auth.amount,
            nonce: hex::encode(sa.auth.nonce),
            currency,
            timestamp: now,
        });

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

    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        let s = self.state.lock().unwrap();
        let pk_hex = hex::encode(pubkey);
        // FakeState pushes oldest-first; filter to this (currency, account) and reverse to newest.
        let mut rows: Vec<TxnRecord> = s
            .txns
            .iter()
            .filter(|t| t.currency == currency && (t.from == pk_hex || t.to == pk_hex))
            .cloned()
            .collect();
        rows.reverse();
        Ok(rows.into_iter().take(limit.max(1) as usize).collect())
    }

    async fn healthy(&self) -> bool {
        // In-memory ledger is healthy iff its mutex isn't poisoned.
        self.state.lock().is_ok()
    }

    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        _currency: Currency,
    ) -> Result<String, LedgerError> {
        // Deterministic fake address: a recognizable `bc1qdpay` prefix + the first 8 pubkey bytes
        // (hex). Distinct per pubkey, stable across calls — enough to drive the wallet's "show my
        // deposit address" UI offline. Mirrors how a real minter derives per-principal addresses.
        Ok(format!("bc1qdpay{}", hex::encode(&pubkey[..8])))
    }

    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError> {
        // Drain the pending deposit for this (pubkey, currency) and credit the balance — the
        // offline analogue of the minter's `update_balance` minting confirmed UTXOs. A second call
        // finds nothing pending and reports minted_total = 0.
        let mut s = self.state.lock().unwrap();
        if let Some(amount) = s.pending_deposits.remove(&(pubkey, currency)) {
            let bal = s.balances.entry((pubkey, currency)).or_insert(0);
            *bal = bal.saturating_add(amount);
            Ok(DepositRefresh {
                minted: vec![MintedUtxo { block_index: "0".to_string(), amount }],
                minted_total: amount,
                pending: vec![],
                required_confirmations: 1,
            })
        } else {
            Ok(DepositRefresh {
                minted: vec![],
                minted_total: 0,
                pending: vec![],
                required_confirmations: 1,
            })
        }
    }

    async fn deposit_info(&self, _currency: Currency) -> Result<DepositInfo, LedgerError> {
        // Fake deposit params: 1 confirmation, no fee, no minimum — the most permissive config, so
        // the offline loop's "Add money" sheet always renders instructions.
        Ok(DepositInfo {
            min_confirmations: 1,
            deposit_fee: 0,
            deposit_min_amount: Some(0),
        })
    }

    /// Test-only deposit seed (feature-gated; see [`Ledger::seed_deposit`]). Delegates to the
    /// existing `register_deposit` hook so the e2e harness's `POST /api/v1/test/deposit/seed`
    /// exercises the *exact* pending→credited path a real refresh would, through the real router.
    #[cfg(feature = "test-helpers")]
    async fn seed_deposit(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<(), LedgerError> {
        self.register_deposit(pubkey, currency, amount);
        Ok(())
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

    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        self.inner.transactions_of(pubkey, currency, limit).await
    }

    async fn healthy(&self) -> bool {
        self.inner.healthy().await
    }

    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<String, LedgerError> {
        // FlakyLedger only injects transients into `pay` (the retry path under test); the deposit
        // surface is a clean passthrough, mirroring how balance/mint delegate.
        self.inner.deposit_address(pubkey, currency).await
    }

    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError> {
        self.inner.deposit_status(pubkey, currency).await
    }

    async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError> {
        self.inner.deposit_info(currency).await
    }
}
