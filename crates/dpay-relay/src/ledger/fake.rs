//! FakeLedger — the offline demo ledger. USER-PRINCIPAL RAIL (2026-08-19 cutover): value
//! movement left the relay entirely, so what remains is the READ surface the offline relay still
//! serves — the currency catalog, static deposit info, and honest zero balances. The fake-IC
//! /api/v2 gateway (test-helpers) is the settlement substrate for tests now.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;

use dpay_core::{Currency, DEMO_USD, PUBKEY_LEN};

use super::api::Ledger;
use super::ckerc20::{
    CKBTC_MINTER_PRINCIPAL, CkErc20OnrampParams, CKETH_LEDGER_PRINCIPAL, CKETH_MINTER_PRINCIPAL,
    CKUSDC_ERC20_ADDRESS, CKUSDC_LEDGER_PRINCIPAL, ckerc20_onramp_from_descriptor,
};
use super::types::{
    CurrencyDescriptor, DepositInfo, LedgerError, MinterFamily, RampCapability, TxnRecord,
    U64String,
};

/// The VCHF LEDGER principal (mainnet) — `ly36x-wiaaa-aaaai-aqj7q-cai`, the live VNX Swiss Franc
/// ICRC-1 ledger (8 decimals, fee 10_000 raw). Currency 7 in BOTH fallbacks (fake_catalog here +
/// the app's BUNDLED_NETWORKS): the first complete NO-MINTER direct-ICRC asset — no ramp, no
/// minter, payment is an app-signed `icrc1_transfer` straight to this ledger (spec
/// docs/specs/2026-08-28-vchf-icp-support-spec.md U5). Single-sourced here so the fake_catalog
/// row can't drift from the registered value; the same literal is cross-checked against
/// `dfx/catalog_truth.json` (`principals.vchf_ledger`) by the `catalog_truth_tests` module below.
pub(crate) const VCHF_LEDGER_PRINCIPAL: &str = "ly36x-wiaaa-aaaai-aqj7q-cai";

/// The ICP LEDGER principal (mainnet) — `ryjl3-tyaaa-aaaaa-aaaba-cai`, the CANONICAL native ICP
/// ledger (8 decimals, fee 10_000 raw). Currency 8 in BOTH fallbacks; like VCHF a complete
/// no-minter direct-ICRC asset (no ramp capability in either direction). Note this is the LEDGER
/// pin only — the official ICP index canister (`qhbym-qaaaa-aaaaa-aaafq-cai`, catalog_truth
/// `principals.icp_index`) is a HISTORY-adapter pin in `agent_ledger.rs`, deliberately NOT a
/// catalog field. Cross-checked against `dfx/catalog_truth.json` (`principals.icp_ledger`).
pub(crate) const ICP_LEDGER_PRINCIPAL: &str = "ryjl3-tyaaa-aaaaa-aaaba-cai";

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
        }
    }

    /// Read a balance (test/demo introspection; not part of the trait). Permanently zero in the
    /// post-cutover relay — funds live at user principals on the IC ledgers (fake-IC gateway in
    /// tests), never in this map.
    pub fn balance_of(&self, pubkey: &[u8; PUBKEY_LEN], currency: Currency) -> u64 {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        *s.balances.get(&(*pubkey, currency)).unwrap_or(&0)
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
/// and the ledger module ships in the lean offline build.
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
            // Distinct fake ledger canister (fake-IC gateway keys ledgers by this text — currencies
            // must NOT share a canister the way prod-demo stand-ins once did, or the gateway's
            // per-currency routing collapses).
            ledger: "hb4h4-edrae-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aac".to_string(),
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
            // Distinct fake ledger canister (see currency 3's note — no shared canister texts).
            ledger: "t6xbe-w3sai-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aac".to_string(),
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
            // Native ckETH IS the gas ledger — its own canister (rows 2/3/4 point here as gas_ledger).
            // Distinct canister per currency is REQUIRED: the fake-IC gateway keys per-currency
            // ledgers by this text.
            ledger: CKETH_LEDGER_PRINCIPAL.to_string(),
            mintable: false,
            minter: Some(CKETH_MINTER_PRINCIPAL.to_string()), // ckETH minter (handles native ETH + all ckERC20)
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("Ξ".to_string()),
            decimals: Some(18),
            wrapper_name: Some("ckETH".into()),
            backing_symbol: Some("ETH".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(6), // matches prod ckETH (display_decimals=6 ≠ decimals=18) — exercises the truncation codepath
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
            // Distinct fake ledger canister (the gateway needs one canister text per currency;
            // sharing '2vxsx-fae' with ckBTC collapsed its routing). Same minter as ckBTC — the
            // minter-side mapping is minter→ledger and is per-minter, not per-ledger.
            ledger: "7uodm-yttam-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aac".to_string(),
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
        CurrencyDescriptor {
            // VCHF — the first complete NO-MINTER direct-ICRC asset (currency 7, appended
            // 2026-08-28 — docs/specs/2026-08-28-vchf-icp-support-spec.md U5). `minter`/
            // `minter_family` are null by design: payment capability no longer depends on a ramp
            // family (the app's isPayableAsset accepts a complete trusted descriptor), and
            // inventing a fake family just to pass the old gate was explicitly rejected.
            // Ramp honesty: BOTH ramps `Unavailable` — no Add money / Cash out actions, but the
            // asset stays visible with Pay/Receive enabled. All values are the LOCKED spec row
            // (8 decimals, fee 10_000 raw = 0.0001 VCHF, initial cap 10_000 VCHF raw); the
            // ledger principal is single-sourced in [`VCHF_LEDGER_PRINCIPAL`] and cross-checked
            // against dfx/catalog_truth.json. `backing_symbol` is intentionally VCHF, not CHF —
            // the payment unit is the issuer token itself, never a claim on bank francs.
            currency: 7, // VCHF (VNX Swiss Franc, direct ICRC-1 ledger)
            ledger: VCHF_LEDGER_PRINCIPAL.to_string(),
            mintable: false,
            minter: None,
            minter_family: None,
            symbol: Some("VCHF".into()),
            decimals: Some(8),
            wrapper_name: Some("VCHF".into()),
            backing_symbol: Some("VCHF".into()),
            network: Some("Internet Computer".into()), // mainnet label — U3 classification
            display_decimals: Some(8),
            fee: Some(U64String(10_000)), // 0.0001 VCHF
            cap: Some(U64String(1_000_000_000_000)), // initial payment-policy cap: 10,000 VCHF
            chain_id: None,       // not EVM
            token_contract: None, // not an ERC-20
            gas_ledger: None,     // no gas ledger — direct ICRC transfer pays its own fee
            onramp: RampCapability::Unavailable, // no compliant fiat rail yet — honest absence
            offramp: RampCapability::Unavailable,
        },
        CurrencyDescriptor {
            // ICP — native Internet Computer as a direct-ICRC asset (currency 8, appended
            // 2026-08-28 — same spec U5). Same complete no-minter shape as VCHF: no minter, no
            // ramp, payment is an app-signed `icrc1_transfer` to the canonical ledger. History
            // for THIS ledger is served by the official ICP index adapter (agent_ledger.rs) —
            // the ledger exposes no `get_transactions`; that dispatch is keyed on this exact
            // principal, so a typo here would also break history routing. Values are the LOCKED
            // spec row (8 decimals, fee 10_000 raw = 0.0001 ICP, initial cap 1_000 ICP raw);
            // single-sourced in [`ICP_LEDGER_PRINCIPAL`], cross-checked against
            // dfx/catalog_truth.json.
            currency: 8, // native ICP (canonical ledger, direct ICRC-1)
            ledger: ICP_LEDGER_PRINCIPAL.to_string(),
            mintable: false,
            minter: None,
            minter_family: None,
            symbol: Some("ICP".into()),
            decimals: Some(8),
            wrapper_name: Some("ICP".into()),
            backing_symbol: Some("ICP".into()),
            network: Some("Internet Computer".into()), // mainnet label — U3 classification
            display_decimals: Some(8),
            fee: Some(U64String(10_000)), // 0.0001 ICP
            cap: Some(U64String(100_000_000_000)), // initial payment-policy cap: 1,000 ICP
            chain_id: None,       // not EVM
            token_contract: None, // not an ERC-20
            gas_ledger: None,     // no gas ledger — direct ICRC transfer pays its own fee
            onramp: RampCapability::Unavailable, // no compliant fiat rail yet — honest absence
            offramp: RampCapability::Unavailable,
        },
    ]
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
        // In-memory ledger is healthy iff its mutex isn't poisoned.
        self.state.lock().is_ok()
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
        // The deposit `principal` arg is the USER's own IC principal (derived in-app) — the relay
        // serves no principal here.
        let catalog = self.currencies().await?;
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
        // VCHF/ICP (2026-08-28 spec U5): the two complete no-minter direct-ICRC ledger pins.
        assert_eq!(VCHF_LEDGER_PRINCIPAL, p["vchf_ledger"].as_str().unwrap());
        assert_eq!(ICP_LEDGER_PRINCIPAL, p["icp_ledger"].as_str().unwrap());
        // The official ICP index is NOT a catalog field (no index_canister abstraction until a
        // second ledger needs one) — the CODE pin lives in agent_ledger.rs's history adapter.
        // This literal check keeps the JSON's icp_index entry honest against the spec-locked
        // value so the agent-side pin can't be fed a typo'd principal from the truth file.
        assert_eq!(p["icp_index"].as_str().unwrap(), "qhbym-qaaaa-aaaaa-aaafq-cai");
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

    #[test]
    fn fake_catalog_vchf_icp_rows_match_truth_and_locked_shape() {
        // U5 drift alarm (2026-08-28 spec): the VCHF (7) and ICP (8) rows cannot diverge from
        // dfx/catalog_truth.json (principal, decimals) nor from the LOCKED spec record (fee, cap,
        // units, network, no-minter shape, no-ramp capabilities, order). These two rows are the
        // first complete no-minter direct-ICRC assets — a drifted field here breaks either the
        // cold-start fallback the wallet renders offline or the exact-ledger transfer target.
        let t = truth();
        let cat = fake_catalog();

        // --- ORDER + currency ID: VCHF is id 7, ICP is id 8, appended after ckTESTBTC (6) and
        // last, VCHF before ICP. The fake fixture's ids match the BUNDLED ids for this pair
        // (unlike ckETH, which is 5 here / 6 bundled) — the spec locks 7/8 in BOTH fallbacks.
        assert_eq!(cat.len(), 9, "7 pre-existing rows + VCHF + ICP");
        assert_eq!(
            cat.iter().map(|d| d.currency).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
            "fixture ids stay contiguous 0..=8, VCHF=7 then ICP=8 at the tail"
        );
        assert_eq!(cat[7].symbol.as_deref(), Some("VCHF"), "id 7 IS the VCHF row");
        assert_eq!(cat[8].symbol.as_deref(), Some("ICP"), "id 8 IS the ICP row");

        // --- VCHF (currency 7): every locked facet.
        let vchf = catalog_currency(&cat, 7);
        assert_eq!(
            vchf.ledger.as_str(),
            t["principals"]["vchf_ledger"].as_str().unwrap(),
            "VCHF ledger principal == catalog_truth vchf_ledger"
        );
        assert_eq!(vchf.ledger.as_str(), VCHF_LEDGER_PRINCIPAL);
        assert_eq!(
            vchf.decimals.unwrap(),
            t["decimals"]["vchf"].as_u64().unwrap() as u8,
            "VCHF decimals == catalog_truth decimals.vchf"
        );
        assert_eq!(
            vchf.display_decimals.unwrap(),
            t["decimals"]["vchf"].as_u64().unwrap() as u8
        );
        assert_eq!(vchf.fee, Some(U64String(10_000)), "locked: 0.0001 VCHF raw fee");
        assert_eq!(
            vchf.cap,
            Some(U64String(1_000_000_000_000)),
            "locked: 10,000 VCHF initial cap"
        );
        assert_eq!(vchf.wrapper_name.as_deref(), Some("VCHF"));
        assert_eq!(
            vchf.backing_symbol.as_deref(),
            Some("VCHF"),
            "payment unit is VCHF (the issuer token), deliberately NOT CHF"
        );
        assert_eq!(vchf.symbol.as_deref(), Some("VCHF"));
        assert_eq!(
            vchf.network.as_deref(),
            Some("Internet Computer"),
            "the U3 mainnet label — anything else mis-files the row testnet-side"
        );
        // No-minter shape (mintable=false, no minter, no family) — a fake family here would
        // resurrect the rejected "invent a family to pass the payability gate" shortcut.
        assert!(!vchf.mintable);
        assert_eq!(vchf.minter, None);
        assert_eq!(vchf.minter_family, None);
        // No-ramp capabilities: honest absence — the asset renders, Pay/Receive work, no
        // Add money / Cash out actions.
        assert_eq!(vchf.onramp, RampCapability::Unavailable);
        assert_eq!(vchf.offramp, RampCapability::Unavailable);
        // Not an EVM asset: all three chain fields null.
        assert_eq!(vchf.chain_id, None);
        assert_eq!(vchf.token_contract, None);
        assert_eq!(vchf.gas_ledger, None);

        // --- ICP (currency 8): every locked facet.
        let icp = catalog_currency(&cat, 8);
        assert_eq!(
            icp.ledger.as_str(),
            t["principals"]["icp_ledger"].as_str().unwrap(),
            "ICP ledger principal == catalog_truth icp_ledger"
        );
        assert_eq!(icp.ledger.as_str(), ICP_LEDGER_PRINCIPAL);
        assert_eq!(
            icp.decimals.unwrap(),
            t["decimals"]["icp"].as_u64().unwrap() as u8,
            "ICP decimals == catalog_truth decimals.icp"
        );
        assert_eq!(
            icp.display_decimals.unwrap(),
            t["decimals"]["icp"].as_u64().unwrap() as u8
        );
        assert_eq!(icp.fee, Some(U64String(10_000)), "locked: 0.0001 ICP raw fee");
        assert_eq!(
            icp.cap,
            Some(U64String(100_000_000_000)),
            "locked: 1,000 ICP initial cap"
        );
        assert_eq!(icp.wrapper_name.as_deref(), Some("ICP"));
        assert_eq!(icp.backing_symbol.as_deref(), Some("ICP"));
        assert_eq!(icp.symbol.as_deref(), Some("ICP"));
        assert_eq!(
            icp.network.as_deref(),
            Some("Internet Computer"),
            "the U3 mainnet label — anything else mis-files the row testnet-side"
        );
        assert!(!icp.mintable);
        assert_eq!(icp.minter, None);
        assert_eq!(icp.minter_family, None);
        assert_eq!(icp.onramp, RampCapability::Unavailable);
        assert_eq!(icp.offramp, RampCapability::Unavailable);
        assert_eq!(icp.chain_id, None);
        assert_eq!(icp.token_contract, None);
        assert_eq!(icp.gas_ledger, None);
    }
}
