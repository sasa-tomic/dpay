//! The read-only ledger seam — the `Ledger` trait. USER-PRINCIPAL RAIL (2026-08-19 cutover):
//! value movement (pay/withdraw/receipts) left the relay entirely — the app signs /api/v2
//! envelopes locally and submits them to boundary nodes. What remains behind this trait is the
//! relay's READ surface: per-ledger balances at the user principal, history, and static
//! deposit/onramp info. The currency CATALOG is deliberately NOT here — since the founder's
//! 2026-08-28 decision it is compiled into [`crate::catalog`] (the sole authority) and shared by
//! every impl. `async_trait` keeps it dyn-compatible.

use async_trait::async_trait;

use dpay_core::{Currency, PUBKEY_LEN};

use super::ckerc20::CkErc20OnrampParams;
use super::types::{DepositInfo, LedgerError, TxnRecord};

/// What a swap venue says about ITSELF — the subset of the ICPSwap pool's own `PoolMetadata`
/// (`third_party/oisy-wallet/src/declarations/icp_swap_pool/icp_swap_pool.did`) that decides how
/// `/api/v1/swap_quote` may be answered. Read from the pool, never pinned: `token0_ledger` /
/// `token1_ledger` are the pool's OWN pair order (the meaning of `zeroForOne` in every arg the
/// relay and the user's device build), and `fee_millionths` is the venue's own fee tier, echoed
/// to the app so no copy of it exists anywhere else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapPoolMetadata {
    /// `metadata().token0.address` — the ICRC ledger principal, canonical text.
    pub token0_ledger: String,
    /// `metadata().token1.address` — the ICRC ledger principal, canonical text.
    pub token1_ledger: String,
    /// `metadata().fee` — the pool's fee tier in millionths of the input (3000 = 0.30%).
    pub fee_millionths: u128,
}

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
    /// `AgentLedger` implements the real icrc3 walk;
    /// [`FakeLedger`](super::FakeLedger) serves its in-memory log and ignores `ledger`.
    async fn transactions_on_ledger(
        &self,
        ledger: &str,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
        memo: Option<&str>,
    ) -> Result<Vec<TxnRecord>, LedgerError>;

    /// Static deposit instructions for `currency` (min confirmations, fee, min amount).
    async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError>;

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
    /// `AgentLedger` overrides it with the real call. A
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

    /// The facade canister's LIVE module hash — the sha256 of the wasm the IC currently reports
    /// as installed, read off the PUBLIC state tree (`canister/<id>/module_hash`; no signature,
    /// no cycles — the same path `dfx canister info` prints). Lowercase hex (32 bytes). The
    /// integrity surface (`GET /api/v1/integrity`) compares this against the PIN baked at build
    /// time (`deploy/facade-module-hash.txt` via build.rs) so an operator can detect an
    /// unrecorded upgrade with one curl (GOVERNANCE row 7). The default impl is "not supported" —
    /// [`FakeLedger`](super::FakeLedger) and test fakes inherit it (and FakeLedger overrides it
    /// with a deterministic hash the test-helpers build bakes as the pin, so the MATCH state is
    /// exercisable offline); `AgentLedger` overrides it with
    /// the real `read_state` call. Failures are `Transient` — the caller degrades to
    /// `status:"UNREACHABLE"`, never a 5xx.
    async fn facade_module_hash(&self) -> Result<String, LedgerError> {
        Err(LedgerError::Transient(
            "facade module hash unavailable: this ledger cannot read the IC state tree".to_string(),
        ))
    }

    /// The venue's OWN pair order and fee tier (spec 2026-09-07 §1: *"Token0/token1 order and
    /// `zeroForToken0` come from the pool's own metadata — read them, never assume"*): query
    /// `pool`'s `metadata` and return the decoded [`SwapPoolMetadata`]. This is what makes
    /// `zero_for_one` derivable rather than assumable, so it is a READ on every quote — cached
    /// with a TTL by `AgentLedger` exactly like
    /// `deposit_info`, never a compiled constant. A pool `#err` comes back as `Rejected(text)`;
    /// transport failures as `Transient`. The default impl is "not supported" — the test-helpers
    /// route serves the fake-IC gateway's stub pool instead.
    async fn swap_pool_metadata(&self, pool: &str) -> Result<SwapPoolMetadata, LedgerError> {
        let _ = pool;
        Err(LedgerError::Transient(
            "swap pool metadata unavailable: this ledger cannot query swap pools".to_string(),
        ))
    }

    /// The delegated-conversion quote read (spec 2026-09-07-delegated-conversion-spec.md §2):
    /// query `pool`'s OWN ICPSwap `quote` and return its `ok(amountOut)` VERBATIM — the relay
    /// NEVER computes or blends a rate, it is a read proxy exactly like `balance_on_ledger`.
    /// `pool` is the pool principal as canonical TEXT (the route validated it against
    /// [`crate::catalog::is_known_swap_pool`]); `zero_for_one` names the direction (true =
    /// token0 in, token1 out) and is DERIVED from [`Ledger::swap_pool_metadata`], never assumed;
    /// the returned amount is GROSS of the output ledger's transfer fee (the app computes net).
    /// A pool `#err` comes back as `Rejected(text)` with the variant name verbatim; transport
    /// failures as `Transient`. The default impl is "not supported" — the test-helpers route
    /// serves the fake-IC gateway's pool instead; `AgentLedger`
    /// overrides it with the real query.
    async fn swap_pool_quote(
        &self,
        pool: &str,
        zero_for_one: bool,
        amount_in_e8s: u128,
    ) -> Result<u128, LedgerError> {
        let _ = (pool, zero_for_one, amount_in_e8s);
        Err(LedgerError::Transient(
            "swap quote unavailable: this ledger cannot query swap pools".to_string(),
        ))
    }
}
