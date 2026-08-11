//! FlakyLedger — test-only retry harness. Wraps any ledger and returns
//! [`LedgerError::Transient`] for the first `fail_first` calls to `pay`, then delegates.

use std::sync::Mutex;

use async_trait::async_trait;

use dpay_core::{Currency, NONCE_LEN, PUBKEY_LEN};

use super::api::Ledger;
use super::ckerc20::CkErc20OnrampParams;
use super::types::{
    CurrencyDescriptor, DepositInfo, DepositRefresh, LedgerError, Receipt, TxnRecord,
    WithdrawReceipt, WithdrawRequest,
};

/// Wraps a ledger and returns [`LedgerError::Transient`] for the first `fail_first` calls to
/// `pay`, then delegates. Used to prove the relay's retry loop eventually succeeds. Test-only:
/// gated so it does NOT compile into the shipping prod binary (`just image` never enables
/// `test-helpers`); unit tests (`cfg(test)`) and the feature-gated integration tests reach it.
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
            let mut n = self.fail_first.lock().unwrap_or_else(|p| p.into_inner());
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

    async fn faucet(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        self.inner.faucet(to, currency, amount).await
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

    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the catalog surface delegates unchanged, mirroring deposit/balance delegation.
        self.inner.currencies().await
    }

    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the ckERC-20 onramp surface delegates unchanged, mirroring catalog/deposit delegation.
        self.inner.ckerc20_onramp_params(currency).await
    }

    async fn withdraw(&self, req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the withdrawal surface delegates unchanged, mirroring balance/faucet/deposit.
        self.inner.withdraw(req).await
    }

    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError> {
        self.inner.receipt_pubkey().await
    }

    async fn receipt(&self, nonce: [u8; NONCE_LEN]) -> Result<Option<Receipt>, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the durable receipt lookup delegates unchanged, mirroring receipt_pubkey.
        self.inner.receipt(nonce).await
    }
}
