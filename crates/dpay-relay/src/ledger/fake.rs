//! FakeLedger — in-memory, canister-faithful. Mirrors the canister's `pay` semantics EXACTLY
//! (same `dpay_core::validate` rules, same atomic transfer, unix-seconds time). This is what
//! the fast offline inner loop runs against.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use async_trait::async_trait;
use ed25519_dalek::{Signature, SigningKey};

use dpay_core::{
    sign_receipt, validate, CodecError, Currency, PayError, ReceiptClaim, SignedAuthorization,
    WithdrawAuth, DEMO_USD, NONCE_LEN, PUBKEY_LEN,
};

use super::api::Ledger;
use super::ckerc20::{
    CKBTC_MINTER_PRINCIPAL, CkErc20OnrampParams, CKETH_LEDGER_PRINCIPAL, CKETH_MINTER_PRINCIPAL,
    CKUSDC_ERC20_ADDRESS, CKUSDC_LEDGER_PRINCIPAL, ckerc20_onramp_from_descriptor,
};
use super::clock::{Clock, SystemClock};
use super::types::{
    CurrencyDescriptor, DepositInfo, DepositRefresh, LedgerError, MintedUtxo,
    MinterFamily, RampCapability, Receipt, RETRIEVE_BTC_MIN_AMOUNT, TxnRecord, U64String,
    WithdrawReceipt, WithdrawRequest, decode_hex_array, display_field_to_string,
};
use super::MINT_ACCOUNT;

struct FakeState {
    /// Composite key `(pubkey, currency)` → balance in minor units. A single account may hold
    /// multiple currencies independently — they're different assets, not one pool.
    balances: HashMap<([u8; PUBKEY_LEN], Currency), u64>,
    spent: HashSet<[u8; NONCE_LEN]>,
    /// Single-use withdrawal idempotency keys (mirror of the canister's `WITHDRAW_NONCES`, kept
    /// SEPARATE from `spent` so a withdraw nonce can't collide with/block a pay nonce). A signed
    /// [`WithdrawAuth`] may be submitted at most once; a replay is `Rejected` (NonceReused).
    withdraw_nonces: HashSet<[u8; NONCE_LEN]>,
    /// Settled transactions, oldest-first (the order they were pushed). `transactions_of` reverses
    /// to newest-first and filters by (currency, account). Mirrors the canister's ACCOUNT_TXNS so
    /// the relay's inner loop is canister-faithful on history too.
    txns: Vec<TxnRecord>,
    /// Test/demo seeding for the deposit path: a pending (unconfirmed) inbound UTXO per
    /// `(pubkey, currency)`. `deposit_status` drains this and credits `balances`, mirroring the
    /// minter's `update_balance` mint-after-confirmation. Lets the offline inner loop prove the
    /// deposit→mint→balance flow without a real ckBTC minter.
    pending_deposits: HashMap<([u8; PUBKEY_LEN], Currency), u64>,
    /// Monotonic stand-in for the ICRC ledger block index (the FakeLedger has no real ledger), so
    /// each settled pay gets a distinct `block_index` for its receipt claim — matching the real
    /// canister's outcome-attestation shape.
    next_block: u64,
    /// Durable per-nonce receipt store — mirrors the canister's `RECEIPTS` stable map (MC4 U3).
    /// Populated atomically inside `pay`'s critical section so a `receipt(nonce)` lookup returns the
    /// signed outcome even after the relay's process-local idempotency cache is gone (restart). This
    /// is the durable recovery source the relay falls back to; the process cache is only an
    /// optimization. Keyed by the single-use nonce (the canister enforces one settle per nonce).
    receipts: HashMap<[u8; NONCE_LEN], Receipt>,
}

/// In-memory ledger. Balances + spent-nonces behind one `Mutex` so the read-check-write is
/// atomic (the real canister is single-threaded, giving the same guarantee for free).
pub struct FakeLedger {
    state: Mutex<FakeState>,
    per_tx_cap: u64,
    clock: Box<dyn Clock>,
    /// Stable TEST-ONLY Ed25519 key the FakeLedger signs receipts with (the real canister generates
    /// its own via `raw_rand`). A fixed seed keeps it deterministic across runs; its public half is
    /// exposed via [`Ledger::receipt_pubkey`] and embedded in each receipt. Test code only — never
    /// in the prod canister/relay image (FakeLedger itself is the offline demo ledger).
    receipt_sk: SigningKey,
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
                withdraw_nonces: HashSet::new(),
                txns: Vec::new(),
                pending_deposits: HashMap::new(),
                next_block: 0,
                receipts: HashMap::new(),
            }),
            per_tx_cap,
            clock,
            // Fixed test seed (documented test-only). The real canister's receipt key comes from
            // `raw_rand`; this stable key lets the offline e2e verify a real signature end-to-end.
            receipt_sk: SigningKey::from_bytes(&[0xf5; 32]),
        }
    }

    /// Read a balance (test/demo introspection; not part of the trait).
    pub fn balance_of(&self, pubkey: &[u8; PUBKEY_LEN], currency: Currency) -> u64 {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        *s.balances.get(&(*pubkey, currency)).unwrap_or(&0)
    }

    /// Seed a pending deposit for `pubkey`/`currency` (test/demo hook). The next `deposit_status`
    /// call drains it and credits the balance, mirroring the ck minter minting after confirmations.
    /// Multiple seeds for the same `(pubkey, currency)` accumulate.
    pub fn register_deposit(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency, amount: u64) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        *s.pending_deposits.entry((pubkey, currency)).or_insert(0) += amount;
    }
}

/// The catalog the offline FakeLedger reports — mirrors a demo deployment: DEMO_USD (currency 0,
/// mintable, the `∂` faucet asset) + ckBTC (currency 1, the CkBtcUtxo deposit/withdraw ramp asset) +
/// ckUSDC (currency 2, the CkEthErc20 onramp asset) + ckUSDT (currency 3, a SECOND CkEthErc20
/// proving the onramp is per-token, not hardcoded to currency 2 / USDC — MC8 U2). The principal text
/// values are the canonical management/anon/minter stand-ins the demo uses (`aaaaa-aa` = the mgmt
/// canister, `2vxsx-fae` = the anonymous principal, `mqygn-kiaaa-aaaar-qaadq-cai` = the live ckBTC
/// minter, `sv3dd-…` = the live ckETH minter, `xevnm-…` = the live ckUSDC ledger); the wallet reads
/// `currency`/`symbol`/`decimals`/`minter_family` + the MC1 unit 5 per-currency metadata for display.
/// Hardcoded as TEXT (not built via `candid::Principal`) because `candid` is feature-gated to `agent`
/// and `ledger.rs` ships in the lean offline build.
///
/// Ramp honesty (MC1 unit 5, no-swap non-negotiable + OPEN_ISSUES O3): DEMO onramp=`Direct` (faucet),
/// offramp=`Unavailable`; ckBTC onramp=`Direct` (Bitcoin ramp), offramp=`Direct`; ckUSDC
/// onramp=`Direct` (ckETH helper built client-side), offramp=`Direct` (the dual-ledger `withdraw_erc20`
/// cash-out, gated on the user holding ckETH for gas); ckUSDT/ckDAI onramp=`Direct`, offramp=
/// `Unavailable` (their cash-out is not yet wired — only ckUSDC is the e2e proof).
fn fake_catalog() -> Vec<CurrencyDescriptor> {
    vec![
        CurrencyDescriptor {
            currency: DEMO_USD,
            ledger: "aaaaa-aa".to_string(), // management canister text
            mintable: true,
            minter: None,
            minter_family: None,
            symbol: Some("$".into()),
            decimals: Some(2),
            wrapper_name: None,
            backing_symbol: None,
            network: None,
            display_decimals: None,
            fee: None,
            cap: None,
            chain_id: None,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Direct, // self-service faucet (fixed amount, rate-limited)
            offramp: RampCapability::Unavailable, // play money — no cash-out
        },
        CurrencyDescriptor {
            currency: 1, // ckBTC-shaped deposit currency
            ledger: "2vxsx-fae".to_string(), // anonymous principal text
            mintable: false,
            minter: Some(CKBTC_MINTER_PRINCIPAL.to_string()),
            minter_family: Some(MinterFamily::CkBtcUtxo),
            symbol: Some("₿".into()),
            decimals: Some(8),
            wrapper_name: Some("ckBTC".into()),
            backing_symbol: Some("BTC".into()),
            network: Some("Bitcoin".into()),
            display_decimals: Some(8),
            fee: None,        // ckBTC ledger fee read live at runtime (MC2 validates)
            cap: None,
            chain_id: None,   // not EVM
            token_contract: None,
            gas_ledger: None, // BTC family — no ckETH gas ledger
            onramp: RampCapability::Direct, // chain-key Bitcoin ramp
            offramp: RampCapability::Direct, // retrieve_btc_with_approval
        },
        CurrencyDescriptor {
            currency: 2, // ckUSDC (ckERC-20 onramp + cash-out currency)
            ledger: CKUSDC_LEDGER_PRINCIPAL.to_string(), // ckUSDC ledger principal text (O6)
            mintable: false,
            minter: Some(CKETH_MINTER_PRINCIPAL.to_string()), // ckETH minter
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("ckUSDC".to_string()),
            decimals: Some(6),
            wrapper_name: Some("ckUSDC".into()),
            backing_symbol: Some("USDC".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(6),
            fee: Some(U64String(10_000)), // ckUSDC ledger icrc1_fee (O6): 0.01 USDC = 10000 raw
            cap: None,
            chain_id: Some(1), // Ethereum mainnet
            token_contract: Some(CKUSDC_ERC20_ADDRESS.to_string()), // ckUSDC ERC-20 (O6) — single-sourced constant
            // The dual-ledger `withdraw_erc20` cash-out burns ckETH gas fees from THIS ledger (the
            // verified mainnet ckETH ledger) + the USDC amount from `ledger` above. The user MUST
            // hold ckETH for gas (Fork-C — dpay never converts ckUSDC→ckETH, no-swap); the app
            // surfaces an honest "You need ckETH for gas" note.
            gas_ledger: Some(CKETH_LEDGER_PRINCIPAL.to_string()),
            onramp: RampCapability::Direct, // ckETH helper-contract onramp (client-side)
            offramp: RampCapability::Direct, // dual-ledger withdraw_erc20 cash-out (ckETH gas + USDC amount)
        },
        CurrencyDescriptor {
            // MC8 U2 — a SECOND ckERC20 token proving the onramp is CATALOG/TOKEN-SPECIFIC, not
            // hardcoded to currency 2 / USDC. ckUSDT carries its OWN ERC-20 contract (real mainnet
            // USDT), so the onramp must surface the USDT address — never USDC's. Same minter
            // (ckETH minter handles all ckERC20), same helper address, same chain; only the
            // `token_contract` + display metadata differ. The `gas_ledger` is the SAME ckETH ledger
            // (one gas ledger serves every ckERC20 cash-out). Ramp honesty: ckUSDT cash-out is not
            // yet wired (offramp=`Unavailable`) — only ckUSDC is the e2e proof; ckUSDT keeps the
            // no-swap fail-closed gate until its offramp is enabled.
            currency: 3, // ckUSDT (a second ckERC-20 onramp currency)
            ledger: CKUSDC_LEDGER_PRINCIPAL.to_string(), // ckUSDT ledger principal text (demo stand-in)
            mintable: false,
            minter: Some(CKETH_MINTER_PRINCIPAL.to_string()), // ckETH minter (handles all ckERC20)
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("ckUSDT".to_string()),
            decimals: Some(6),
            wrapper_name: Some("ckUSDT".into()),
            backing_symbol: Some("USDT".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(6),
            fee: Some(U64String(10_000)), // demo stand-in (mirrors ckUSDC's 6-decimal fee unit)
            cap: None,
            chain_id: Some(1), // Ethereum mainnet
            token_contract: Some("0xdAC17F958D2ee523a2206206994597C13D831ec7".into()), // real USDT ERC-20
            gas_ledger: Some(CKETH_LEDGER_PRINCIPAL.to_string()), // ckETH gas ledger (shared by all ckERC20)
            onramp: RampCapability::Direct, // ckETH helper-contract onramp (client-side, per-token)
            offramp: RampCapability::Unavailable, // cash-out not yet wired (only ckUSDC) — Fork-C gate
        },
        CurrencyDescriptor {
            // OPEN_ISSUES #3 — an 18-decimal ckERC20 to close the decimal-edges coverage gap.
            // ckDAI mirrors its native 18-dec precision (DAI on Ethereum mainnet is 18 dec), giving
            // the format path a fixture at the precision extreme where Number's 2^53 mantissa would
            // drop low digits. Same ckETH minter + helper + chain as the other ckERC20 entries; only
            // `decimals`/`display_decimals`/`token_contract`/display metadata differ. The `gas_ledger`
            // is the SAME ckETH ledger (one gas ledger serves every ckERC20 cash-out). Ramp honesty:
            // ckDAI cash-out is not yet wired (offramp=`Unavailable`) — only ckUSDC is the e2e proof.
            currency: 4, // ckDAI (18-dec ckERC-20 — the precision-extreme fixture)
            ledger: CKUSDC_LEDGER_PRINCIPAL.to_string(), // ckDAI ledger principal text (demo stand-in)
            mintable: false,
            minter: Some(CKETH_MINTER_PRINCIPAL.to_string()), // ckETH minter (handles all ckERC20)
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("ckDAI".to_string()),
            decimals: Some(18),
            wrapper_name: Some("ckDAI".into()),
            backing_symbol: Some("DAI".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(18),
            fee: Some(U64String(10_000_000_000_000_000)), // demo stand-in — 0.01 DAI at 18 dec = 1e16 raw
            cap: None,
            chain_id: Some(1), // Ethereum mainnet
            token_contract: Some("0x6B175474E89094C44Da98b954EedeAC495271d0F".into()), // real DAI ERC-20
            gas_ledger: Some(CKETH_LEDGER_PRINCIPAL.to_string()), // ckETH gas ledger (shared by all ckERC20)
            onramp: RampCapability::Direct, // ckETH helper-contract onramp (client-side, per-token)
            offramp: RampCapability::Unavailable, // cash-out not yet wired (only ckUSDC) — Fork-C gate
        },
        CurrencyDescriptor {
            // Native ETH within the CkEthErc20 family — discriminated by `token_contract == None`
            // (the app's `familyDisplay` branches CkEthErc20 on this: None ⇒ FD_CKETH_NATIVE ⇒ the
            // Cash-out button renders + the withdraw sheet uses 18-dec Wei). This is the catalog entry
            // the e2e drives through the native-ETH withdraw path (the facade's `withdraw` family
            // dispatch burns ckETH → sends native ETH). Same ckETH minter + chain as the other
            // ckERC20 entries; only `token_contract` (None) + the 18-dec/ETH display metadata differ.
            // Ramp honesty: onramp=Direct (single payable `depositEth` tx), offramp=Direct (withdraw_eth).
            // `gas_ledger` is None: native ckETH's gas ledger IS its own `ledger` (the `withdraw_eth`
            // path approves amount+fee on the single ckETH ledger), so it carries no separate gas ledger.
            currency: 5, // native ckETH (CkEthErc20 + token_contract None)
            ledger: CKUSDC_LEDGER_PRINCIPAL.to_string(), // ckETH ledger principal text (demo stand-in)
            mintable: false,
            minter: Some(CKETH_MINTER_PRINCIPAL.to_string()), // ckETH minter (handles native ETH + all ckERC20)
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("Ξ".to_string()),
            decimals: Some(18),
            wrapper_name: Some("ckETH".into()),
            backing_symbol: Some("ETH".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(18),
            fee: Some(U64String(10_000_000_000_000_000)), // demo stand-in — 0.01 ETH at 18 dec = 1e16 raw
            cap: Some(U64String(100_000)),
            chain_id: Some(1), // Ethereum mainnet
            token_contract: None, // None ⇒ native ETH (NOT an ERC-20) — the family discriminator
            gas_ledger: None, // native ETH — its own ledger IS the gas ledger (withdraw_eth single-ledger path)
            onramp: RampCapability::Direct, // ckETH helper `depositEth` (client-side, single payable tx)
            offramp: RampCapability::Direct, // withdraw_eth: burn ckETH → send native ETH
        },
        CurrencyDescriptor {
            // ckTESTBTC — testnet fixture for catalog-driven testnet detection. network "Bitcoin
            // Testnet" is NOT in MAINNET_NETWORKS → isTestnetCurrency() = true, so the wallet hides
            // it by default + reveals it via the testnet toggle (the only way to exercise that path
            // in e2e; the rest of fake_catalog is mainnet-only). display-only: Unavailable ramps,
            // same anonymous ledger as ckBTC. Mirrors the ckBTC shape (CkBtcUtxo family, 8 dec).
            currency: 6,
            ledger: "2vxsx-fae".to_string(),
            mintable: false,
            minter: Some(CKBTC_MINTER_PRINCIPAL.to_string()),
            minter_family: Some(MinterFamily::CkBtcUtxo),
            symbol: Some("₿".into()),
            decimals: Some(8),
            wrapper_name: Some("ckTESTBTC".into()),
            backing_symbol: Some("BTC".into()),
            network: Some("Bitcoin Testnet".into()),
            display_decimals: Some(8),
            fee: None,
            cap: None,
            chain_id: None,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Unavailable,
            offramp: RampCapability::Unavailable,
        },
    ]
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

        // Cheap local rejects that mirror the canister's `pay` body EXACTLY (W3 audit: the FakeLedger
        // must not accept a payment the real canister rejects). The canister rejects a self-transfer
        // (`from == to`) and a payment to the mint sentinel (`to == [0xFF;32]`) before reserving the
        // nonce; the FakeLedger does the same so the two can't diverge.
        if sa.auth.from == sa.auth.to {
            return Err(LedgerError::Rejected("self transfer".to_string()));
        }
        if sa.auth.to == MINT_ACCOUNT {
            return Err(LedgerError::Rejected("pay to mint sentinel".to_string()));
        }

        // Single critical section: read balance/nonce, validate, commit atomically — exactly the
        // canister's `pay` body. Lookups are keyed by (pubkey, currency) — debiting/crediting the
        // asset the authorization actually names.
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
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
            amount: U64String(sa.auth.amount),
            nonce: hex::encode(sa.auth.nonce),
            currency,
            timestamp: now,
            // Names + memo flow from the signed wire into history (N6/H3): the payee sees the
            // payer's name, not a raw pubkey.
            from_name: display_field_to_string(&sa.auth.from_name),
            to_name: display_field_to_string(&sa.auth.to_name),
            memo: display_field_to_string(&sa.auth.memo),
        });
        // Assign a monotonic block index (stand-in for the ICRC ledger block) and sign the receipt
        // claim with the FakeLedger's stable test key — the offline analogue of the canister's
        // canister-signed outcome receipt. The app verifies `receipt_sig` under `pubkey` before
        // showing "Paid ✓".
        let block_index = s.next_block;
        s.next_block += 1;
        let claim = ReceiptClaim {
            nonce: sa.auth.nonce,
            from,
            to: sa.auth.to,
            amount: sa.auth.amount,
            currency,
            block_index,
            settle_ts: now,
        };
        let sig = sign_receipt(&self.receipt_sk, &claim).to_bytes();
        let pubkey = self.receipt_sk.verifying_key().to_bytes();

        let receipt = Receipt {
            from: hex::encode(from),
            to: hex::encode(sa.auth.to),
            amount: U64String(sa.auth.amount),
            nonce: hex::encode(sa.auth.nonce),
            new_from_balance: U64String(new_from),
            currency,
            block_index: U64String(block_index),
            settle_ts: now,
            receipt_sig: hex::encode(sig),
            pubkey: hex::encode(pubkey),
        };
        // Durable store: mirror the canister's per-nonce `RECEIPTS` map so `receipt(nonce)` recovers
        // the signed outcome after a relay restart (when the process-local idempotency cache is gone).
        // Inserted inside the same critical section as the balance commit, so the receipt is observable
        // iff the settle is (atomic, like the canister's post-commit store).
        s.receipts.insert(sa.auth.nonce, receipt.clone());
        Ok(receipt)
    }

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        Ok(self.balance_of(&pubkey, currency))
    }

    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError> {
        Ok(self.receipt_sk.verifying_key().to_bytes().to_vec())
    }

    /// Durable per-nonce receipt lookup — mirrors the canister's `receipt(nonce)` query. Returns the
    /// signed outcome for a settled nonce, or `None` if it never settled (the process-local
    /// idempotency cache is an optimization; this is the source of truth the relay falls back to
    /// after a restart).
    async fn receipt(&self, nonce: [u8; NONCE_LEN]) -> Result<Option<Receipt>, LedgerError> {
        Ok(self.state.lock().unwrap_or_else(|p| p.into_inner()).receipts.get(&nonce).cloned())
    }

    async fn faucet(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        // FakeLedger is the permissive DEMO model: credit the requested amount, no cooldown (play
        // money; the e2e flow exercises a repeatable top-up). The real canister's faucet mints a
        // FIXED amount and rate-limits — proven on PocketIC, not modeled here.
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
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
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
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
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(amount) = s.pending_deposits.remove(&(pubkey, currency)) {
            let bal = s.balances.entry((pubkey, currency)).or_insert(0);
            *bal = bal.saturating_add(amount);
            Ok(DepositRefresh {
                minted: vec![MintedUtxo { block_index: "0".to_string(), amount: U64String(amount) }],
                minted_total: U64String(amount),
                pending: vec![],
                required_confirmations: 1,
            })
        } else {
            Ok(DepositRefresh {
                minted: vec![],
                minted_total: U64String(0),
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
            deposit_fee: U64String(0),
            deposit_min_amount: Some(U64String(0)),
        })
    }

    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError> {
        Ok(fake_catalog())
    }

    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError> {
        // MC8 U2: resolve the onramp from the CATALOG descriptor, not a hardcoded `currency == 2`
        // guard. Reads `self.currencies()` (the same `fake_catalog()` the wallet sees) so the
        // descriptor is the single source of truth, then delegates to the shared pure resolver.
        // `facade_principal` is the demo stand-in (offline mode never broadcasts — the calldata
        // encoding is shape-correct regardless; in production this is the facade canister id).
        let catalog = self.currencies().await?;
        let desc = catalog.iter().find(|d| d.currency == currency);
        ckerc20_onramp_from_descriptor(desc, "aaaaa-aa".to_string())
    }

    /// Withdraw ckBTC to a native BTC address. Mirrors the canister's `withdraw` settlement EXACTLY
    /// (W3 audit: the FakeLedger's accept/reject must match the real canister). Single critical
    /// section under the `FakeState` mutex (the canister is single-threaded; same guarantee). There
    /// is no real minter here, so the "burn" is modeled as a direct debit of `amount` from the user's
    /// subaccount (the net ledger effect of retrieve_btc_with_approval). The signed WithdrawAuth is
    /// verified under `from` (== the debit subaccount) before any state change — non-custodial.
    async fn withdraw(&self, req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        // Extract the u64 once at the JSON boundary (amount crosses the wire as a decimal string;
        // internal Rust arithmetic uses the native u64).
        let amount = req.amount.0;
        // Decode hex fields outside the lock (pure; a bad shape is a permanent reject).
        let from = decode_hex_array(&req.from, "from")?;
        let nonce = decode_hex_array(&req.nonce, "nonce")?;
        let sig_arr = decode_hex_array(&req.sig, "sig")?;
        let sig = Signature::from_bytes(&sig_arr);

        // NON-CUSTODIAL GATE: rebuild the WithdrawAuth + verify the signature under `from` BEFORE
        // reserving the nonce or touching the balance. `from` is both the verify key AND the debit
        // subaccount, so a signature under any other key moves no funds. (Mirrors the canister, which
        // checks the sig before the nonce reserve.)
        let auth = WithdrawAuth {
            from_pubkey: from,
            destination: req.destination.clone(),
            nonce,
            expiry: req.expiry,
            currency: req.currency,
            amount,
        };
        if !auth.verify(&from, &sig) {
            return Err(LedgerError::Rejected("bad signature".to_string()));
        }

        let now = self.clock.now_secs();
        // Cheap local rejects (mirror the canister's pre-burn checks).
        if amount == 0 {
            return Err(LedgerError::Rejected("zero amount".to_string()));
        }
        if req.expiry < now {
            return Err(LedgerError::Rejected("expired".to_string()));
        }
        // The retrieve_btc_min_amount floor is BTC-FAMILY-SPECIFIC: the canister's family dispatch
        // applies it only inside the CkBtcUtxo branch (retrieve_btc_with_approval). The ckETH minter
        // enforces its OWN governed minimum_withdrawal_amount for native ETH, so a CkEthErc20 withdraw
        // must NOT be rejected against the BTC sat floor here (else the native-ETH cash-out path is
        // unreachable). Resolve the family from the same catalog the wallet sees.
        let family = fake_catalog()
            .into_iter()
            .find(|d| d.currency == req.currency)
            .and_then(|d| d.minter_family);
        if family == Some(MinterFamily::CkBtcUtxo)
            && amount < RETRIEVE_BTC_MIN_AMOUNT
        {
            return Err(LedgerError::Rejected(format!(
                "amount below retrieve_btc_min_amount ({RETRIEVE_BTC_MIN_AMOUNT})"
            )));
        }

        // Single critical section: reserve the withdraw nonce, check funds, commit the burn atomically.
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !s.withdraw_nonces.insert(nonce) {
            return Err(LedgerError::Rejected("nonce already used".to_string()));
        }
        let balance = *s.balances.get(&(from, req.currency)).unwrap_or(&0);
        if amount > balance {
            // Insufficient funds: the canister RELEASES the nonce (retryable pre-burn failure); mirror
            // that here so a later deposit + same-auth retry can succeed within the expiry window.
            s.withdraw_nonces.remove(&nonce);
            return Err(LedgerError::Rejected(format!("InsufficientFunds: balance {balance}")));
        }
        // Commit the burn: debit the user's subaccount. (No fee model — the FakeLedger is the fee-less
        // demo ledger; the real canister + ledger enforce the ckBTC transfer fee authoritatively.)
        let new_balance = balance - amount;
        s.balances.insert((from, req.currency), new_balance);
        // Record the withdrawal as a history row (counterparty = MINT_ACCOUNT sentinel, like `burn`).
        let block_index = s.next_block;
        s.next_block += 1;
        s.txns.push(TxnRecord {
            from: hex::encode(from),
            to: hex::encode(MINT_ACCOUNT),
            amount: U64String(amount),
            nonce: hex::encode(nonce),
            currency: req.currency,
            timestamp: now,
            // A synthesized burn row (counterparty = MINT_ACCOUNT sentinel): no signed names/memo
            // apply, so the app's "mint/burn" special-case reads empty strings.
            from_name: String::new(),
            to_name: String::new(),
            memo: String::new(),
        });
        Ok(WithdrawReceipt {
            from: hex::encode(from),
            destination: req.destination,
            amount: U64String(amount),
            nonce: hex::encode(nonce),
            currency: req.currency,
            block_index: U64String(block_index),
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
// Catalog single-source drift alarm (item 2, 2026-08-08).
// ---------------------------------------------------------------------------
// `dfx/catalog_truth.json` is the single source of truth for the drift-prone currency literals
// shared across this file's [`fake_catalog`] (the relay's cold-start fallback) and the app's
// `BUNDLED_CATALOG` (`app/config/catalog.ts`, the wallet's cold-load fallback). The two fallbacks
// MUST stay byte-aligned on the mainnet principals/ERC-20/decimals, or a cold-load render shows the
// wrong decimals / a deploy registers the wrong metadata. This module is the RELAY half of the
// drift alarm; the APP half is `app/__tests__/catalog.test.ts`. A literal/const change here without
// a JSON update (or vice-versa) goes RED. The relay's LIVE `/catalog` response (the canister's
// `currencies()`) remains the runtime source of truth; this file + `BUNDLED_CATALOG` are
// COLD-START FALLBACKS only — no second runtime source is introduced.
//
// The JSON is embedded at compile time via `include_str!` so the test fails to BUILD if the file
// moves (no runtime path fragility). Path is relative to this source file
// (`crates/dpay-relay/src/ledger/fake.rs`) → repo-root `dfx/catalog_truth.json`.
#[cfg(test)]
mod catalog_truth_tests {
    use super::*;
    use serde_json::Value;

    const CATALOG_TRUTH: &str = include_str!("../../../../dfx/catalog_truth.json");

    fn truth() -> Value {
        serde_json::from_str(CATALOG_TRUTH).expect("dfx/catalog_truth.json must be valid JSON")
    }

    fn catalog_currency(cat: &[CurrencyDescriptor], currency: Currency) -> &CurrencyDescriptor {
        cat.iter()
            .find(|d| d.currency == currency)
            .unwrap_or_else(|| panic!("fake_catalog() missing currency {currency}"))
    }

    #[test]
    fn named_consts_are_the_catalog_truth_values() {
        // Belt-and-suspenders: the named principal/contract consts ARE the JSON's values. A const
        // edit without a JSON update (or vice-versa) goes RED here, before the catalog-level check.
        let t = truth();
        let p = &t["principals"];
        assert_eq!(CKBTC_MINTER_PRINCIPAL, p["ckbtc_minter"].as_str().unwrap());
        assert_eq!(CKETH_MINTER_PRINCIPAL, p["cketh_minter"].as_str().unwrap());
        assert_eq!(CKUSDC_LEDGER_PRINCIPAL, p["ckusdc_ledger"].as_str().unwrap());
        assert_eq!(CKETH_LEDGER_PRINCIPAL, p["cketh_gas_ledger"].as_str().unwrap());
        assert_eq!(
            CKUSDC_ERC20_ADDRESS,
            t["erc20_contracts"]["ckusdc"].as_str().unwrap()
        );
    }

    #[test]
    fn fake_catalog_matches_catalog_truth_json() {
        // The drift alarm: fake_catalog()'s drift-prone fields for the SHARED currencies match the
        // JSON. DEMO(0)/ckBTC(1)/ckUSDC(2) are the currencies present in BOTH fake_catalog and the
        // app's BUNDLED_CATALOG; native-ckETH(5) lives only here (it pins the 18-dec precision
        // extreme). ckBTC's `ledger` is deliberately NOT asserted — the two fallbacks disagree by
        // design (BUNDLED_CATALOG leaves it empty; fake_catalog uses the anonymous principal) and
        // the relay resolves ledgers server-side from the currency id, so that field is not a
        // cross-side drift risk.
        let t = truth();
        let cat = fake_catalog();

        // DEMO (currency 0): decimals only (no minter/ledger in the shared truth).
        let demo = catalog_currency(&cat, DEMO_USD);
        assert_eq!(
            demo.decimals.unwrap(),
            t["decimals"]["demo"].as_u64().unwrap() as u8
        );

        // ckBTC (currency 1): decimals + the ckBTC minter principal.
        let ckbtc = catalog_currency(&cat, 1);
        assert_eq!(
            ckbtc.decimals.unwrap(),
            t["decimals"]["ckbtc"].as_u64().unwrap() as u8
        );
        assert_eq!(
            ckbtc.minter.as_deref().unwrap(),
            t["principals"]["ckbtc_minter"].as_str().unwrap()
        );

        // ckUSDC (currency 2): decimals + ledger + minter + ERC-20 contract + gas-ledger principal.
        let ckusdc = catalog_currency(&cat, 2);
        assert_eq!(
            ckusdc.decimals.unwrap(),
            t["decimals"]["ckusdc"].as_u64().unwrap() as u8
        );
        assert_eq!(
            ckusdc.ledger.as_str(),
            t["principals"]["ckusdc_ledger"].as_str().unwrap()
        );
        assert_eq!(
            ckusdc.minter.as_deref().unwrap(),
            t["principals"]["cketh_minter"].as_str().unwrap()
        );
        assert_eq!(
            ckusdc.token_contract.as_deref().unwrap(),
            t["erc20_contracts"]["ckusdc"].as_str().unwrap()
        );
        assert_eq!(
            ckusdc.gas_ledger.as_deref().unwrap(),
            t["principals"]["cketh_gas_ledger"].as_str().unwrap()
        );

        // native ckETH (currency 5): the 18-dec precision-extreme fixture (fake_catalog only — no
        // matching entry in BUNDLED_CATALOG, so the jest side does not assert it). Pinning it here
        // so a future edit can't silently change the precision at the Number 2^53 edge.
        let cketh = catalog_currency(&cat, 5);
        assert_eq!(
            cketh.decimals.unwrap(),
            t["decimals"]["eth"].as_u64().unwrap() as u8
        );
    }
}
