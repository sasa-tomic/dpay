//! The read-only catalog seam — the `Ledger` trait. USER-PRINCIPAL RAIL (2026-08-19 cutover):
//! value movement (pay/withdraw/receipts) left the relay entirely — the app signs /api/v2
//! envelopes locally and submits them to boundary nodes. What remains behind this trait is the
//! relay's READ surface: the currency catalog, per-ledger balances at the user principal,
//! history, and static deposit/onramp info. `async_trait` keeps it dyn-compatible.

use async_trait::async_trait;

use dpay_core::{Currency, PUBKEY_LEN};

use super::ckerc20::CkErc20OnrampParams;
use super::types::{CurrencyDescriptor, DepositInfo, LedgerError, TxnRecord};

/// The settlement seam. `async_trait` keeps it dyn-compatible so `Arc<dyn Ledger>` works.
#[async_trait]
pub trait Ledger: Send + Sync {
    /// Read a balance by querying the ICRC-1 ledger `icrc1_balance_of` DIRECTLY on `ledger`.
    /// USER-PRINCIPAL RAIL (2026-08-19 cutover): the account is
    /// `Account{owner: self_authenticating(DER(pubkey)), subaccount: None}` — the user's own
    /// principal on the external ledger. `ledger` is the currency's ledger Principal as canonical
    /// TEXT (the catalog carries it as text so the trait does not depend on the `agent` feature).
    /// The batch `/balances` handler fans this out per catalog currency.
    async fn balance_on_ledger(
        &self,
        ledger: &str,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
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
