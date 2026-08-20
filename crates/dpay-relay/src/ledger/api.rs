//! The read-only catalog seam — the `Ledger` trait. USER-PRINCIPAL RAIL (2026-08-19 cutover):
//! value movement (pay/withdraw/receipts) left the relay entirely — the app signs /api/v2
//! envelopes locally and submits them to boundary nodes. What remains behind this trait is the
//! relay's READ surface: the currency catalog, per-ledger balances at the user principal,
//! history, and static deposit/onramp info. `async_trait` keeps it dyn-compatible.

use async_trait::async_trait;

use dpay_core::{Currency, PUBKEY_LEN};

use super::ckerc20::CkErc20OnrampParams;
use super::types::{CurrencyDescriptor, DepositInfo, LedgerError, TxnRecord};

/// The ledger read seam. `async_trait` keeps it dyn-compatible so `Arc<dyn Ledger>` works.
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

    /// List this account's transactions in `currency`, newest-first, up to `limit` — the wallet's
    /// durable history (the in-memory UI list is gone on restart; the ledger is the source of
    /// truth). History is read off the ICRC ledger named by `ledger` (the catalog's Principal
    /// text) — its OWN transaction log walked backwards, not a facade-maintained index.
    /// [`AgentLedger`](crate::agent_ledger::AgentLedger) implements the real icrc3 walk;
    /// [`FakeLedger`](super::FakeLedger) serves its in-memory log and ignores `ledger`.
    async fn transactions_on_ledger(
        &self,
        ledger: &str,
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

    /// ckERC-20 onramp parameters (helper contract, ERC-20 address) for the given currency — pure
    /// display/config metadata for the app's own two Ethereum transactions (the user deposits at
    /// their OWN principal). Only meaningful for CkEthErc20-family currencies. Returns
    /// Transient(503) if the currency has no ckERC-20 onramp configured.
    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError>;

    /// Liveness for `/health` (the wallet's connectivity pre-flight).
    async fn healthy(&self) -> bool;

    /// The faucet's settlement leg (2026-08-20 relay faucet): mint play money for `pubkey` on
    /// `currency`. This is the ONE non-read method — the founder-approved production faucet lives
    /// in the relay, which rate-limits locally and drives the facade canister's controller-gated
    /// `mint` through the agent build's authenticated identity (crediting the USER principal).
    /// The default impl is "not supported" — [`FakeLedger`](super::FakeLedger) and test fakes
    /// inherit it (the test-helpers faucet route serves the fake-IC gateway instead);
    /// [`AgentLedger`](crate::agent_ledger::AgentLedger) overrides it with the real call. A
    /// canister refusal comes back as `Rejected(text)` with the reason VERBATIM (the app surfaces
    /// it as-is); transport failures as `Transient`.
    async fn faucet_mint(
        &self,
        pubkey: &[u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        let _ = (pubkey, currency, amount);
        Err(LedgerError::Transient("faucet unavailable: this ledger cannot mint".to_string()))
    }
}
