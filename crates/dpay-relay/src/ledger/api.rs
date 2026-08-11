//! The settlement seam — the `Ledger` trait. The relay orchestrates (idempotency, retries,
//! HTTP); *settlement* — the read-check-write of money — lives behind this trait.
//! `async_trait` keeps it dyn-compatible so `Arc<dyn Ledger>` works.

use async_trait::async_trait;

use dpay_core::{Currency, NONCE_LEN, PUBKEY_LEN};

use super::ckerc20::CkErc20OnrampParams;
use super::types::{
    CurrencyDescriptor, DepositInfo, DepositRefresh, LedgerError, Receipt, TxnRecord,
    WithdrawReceipt, WithdrawRequest,
};

/// The settlement seam. `async_trait` keeps it dyn-compatible so `Arc<dyn Ledger>` works.
#[async_trait]
pub trait Ledger: Send + Sync {
    /// Settle a 292-byte signed authorization (the payer's QR, decoded to wire bytes). The
    /// settlement currency is read out of the wire — the payer copied the merchant's request
    /// currency into their authorization — so `pay` itself takes no currency argument.
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError>;

    /// Read an account's balance (minor units) of `currency`. Lets a wallet show its live balance
    /// for the asset it actually holds when online.
    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError>;

    /// Read a balance by querying the ICRC-1 ledger `icrc1_balance_of` DIRECTLY on `ledger` — free,
    /// always-live, and one hop fewer than the facade's cached `balance_of` (no consensus, no
    /// `BAL_CACHE`). The account is `Account{owner: <facade>, subaccount: pubkey}` (the SAME
    /// subaccount the facade mints into — see the canister's `account_of`); `ledger` is the currency's
    /// ledger Principal as canonical TEXT (the catalog carries it as text so the candid-free trait
    /// does not depend on the `agent` feature).
    ///
    /// Default: ignore `ledger` and delegate to [`balance`](Self::balance) — so test stubs
    /// ([`crate::FakeLedger`], the flaky wrapper) and any future non-IC impl keep working unchanged.
    /// [`AgentLedger`](crate::AgentLedger) overrides this with the real direct query, which the batch
    /// `/balances` handler now fans out per catalog currency (replacing the facade-cached path + the
    /// background `refresh_balances` update — the relay no longer moves through the facade to read
    /// balances, eliminating that hop and its cost entirely).
    async fn balance_on_ledger(
        &self,
        _ledger: &str,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<u64, LedgerError> {
        self.balance(pubkey, currency).await
    }

    /// Self-service demo faucet: credit `to` with `amount` of `currency`, returning the new balance.
    /// Funds a freshly-generated on-device account (the demo on-ramp).
    ///
    /// **Two faithful models.** [`crate::FakeLedger`] (the offline demo ledger) credits the REQUESTED
    /// `amount` and applies no cooldown — it is play money, and the e2e flow exercises a repeatable
    /// top-up. [`AgentLedger`](crate::AgentLedger) (the real canister) IGNORES `amount` and calls the
    /// canister's `faucet(account, currency)`, which mints a FIXED constants-sourced amount and is
    /// rate-limited per (account, currency) — a client cannot print unbounded funds or pick an
    /// amount. The relay's `/faucet` route passes `amount` through; the canister overrides it. The
    /// canister's rate-limiting + fixed-amount are proven on PocketIC (see `dpay-canister-tests`).
    async fn faucet(
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

    /// The full currency catalog — the wallet's runtime source of truth for which assets exist and
    /// how to display/fund them (closes the hardcoded-`DEPOSIT_CURRENCY` coupling). Joins the
    /// canister's LEDGERS + MINTERS + CURRENCY_META. Unauthenticated (catalog only — no balances).
    /// Impl errors are `Transient` (an unreachable canister); there is no permanent-policy failure.
    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError>;

    /// ckERC-20 onramp parameters (helper contract, ERC-20 address, facade principal) for the given
    /// currency. Only meaningful for CkEthErc20-family currencies. Returns Transient(503) if the
    /// currency has no ckERC-20 onramp configured.
    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError>;

    /// Withdraw ckBTC to a native BTC address on a VERIFIED user signature. The request carries the
    /// [`WithdrawAuth`] fields + the Ed25519 signature (hex); the ledger verifies the signature under
    /// `from` (== the debit subaccount) before moving any funds. On success the ckBTC is debited from
    /// `Account{facade, subaccount: from}` and the burn block index is returned.
    ///
    /// Error mapping mirrors the deposit surface's §0 rule for *transient* failures (a transport /
    /// minter-unavailable hiccup → `Transient` → HTTP 503), but a **permanent policy failure** (bad
    /// signature, expired, below min, insufficient funds, nonce reused) is `Rejected` → HTTP 422 — the
    /// relay must not signal "retry" for a rejection that will never succeed.
    ///
    /// The default returns a permanent `Rejected` so ledgers that don't support withdrawal (e.g.
    /// narrow test stubs) refuse cleanly rather than silently no-op. [`crate::FakeLedger`] and
    /// [`AgentLedger`](crate::AgentLedger) override it.
    async fn withdraw(&self, _req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        Err(LedgerError::Rejected("withdraw not supported on this ledger".into()))
    }

    /// The receipt-signing public key (32 bytes) of the ledger/canister, so a payer can verify a
    /// `Receipt`'s `receipt_sig` over its canonical `ReceiptClaim`. `FakeLedger` returns a stable
    /// test key; `AgentLedger` queries the canister's `receipt_pubkey`. (A receipt also carries its
    /// own `pubkey` field, so this is an optional cross-check / pre-fetch.)
    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError>;

    /// Durable receipt lookup by nonce — the canister's source of truth for "did this payment
    /// settle, and what was the outcome?". Returns `Some(signed receipt)` if that nonce settled,
    /// `None` if it never did (or settled before this ledger version recorded signed receipts).
    ///
    /// This is the **durable recovery seam** the relay uses when its own process-local idempotency
    /// cache can't answer (after a restart, or when a settle reply was lost): `GET /receipt/{nonce}`
    /// and the `/pay` Transient-exhausted branch both fall back to it so a settled payment is never
    /// misreported as a 404/503 false-negative. The canister enforces a single-use nonce, so two
    /// authorizations can never both settle under one nonce — the recovered receipt is authoritative.
    ///
    /// The default returns `Ok(None)` so ledgers that don't record receipts (e.g. narrow test stubs)
    /// refuse cleanly rather than fabricate one. [`crate::FakeLedger`] and
    /// [`AgentLedger`](crate::AgentLedger) override it for real.
    async fn receipt(&self, _nonce: [u8; NONCE_LEN]) -> Result<Option<Receipt>, LedgerError> {
        Ok(None)
    }

    /// Seed a pending deposit for `pubkey`/`currency` (the test-helpers hook a browser e2e harness
    /// uses to simulate a confirmed ckBTC deposit landing). Mirrors `FakeLedger::register_deposit`:
    /// the next `deposit_status` drains it and credits the balance.
    ///
    /// **Test-only.** Feature-gated behind `test-helpers` so the method — and the HTTP route that
    /// calls it (`POST /api/v1/test/deposit/seed`) — do not compile into the prod image. Only
    /// [`crate::FakeLedger`] implements this for real; the default returns a permanent `Rejected` so any
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
