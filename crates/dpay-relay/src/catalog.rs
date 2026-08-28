//! The relay's compiled-in currency catalog — the SOLE catalog authority (founder decision
//! 2026-08-28). The facade canister's registry is REMOVED; every mode (offline test-helpers /
//! fake AND `agent` / prod) serves THIS module: `/api/v1/currencies` answers the Catalog v2
//! network-first envelope built here, the `/balances` fan-out and history's currency→ledger
//! resolution enumerate [`ic_rows`], and the test-helpers fake-IC gateway keys its ledgers off
//! the same rows. No code path queries the facade for the catalog anymore. Authority = relay
//! code + git review + the founder's `just up` deploy — adding an asset is a code change here,
//! reviewed like any other, and lands on the next deploy (no canister step).
//!
//! The IC rows are the REAL mainnet/testnet chain-key catalog, transplanted VERBATIM from the
//! live prod `/api/v1/currencies` response fetched 2026-08-28 (every field, null vs value —
//! currency ids are user-visible durable state, so this compiled catalog equals what prod
//! serves today PLUS the already-locked rows 7/8). They replaced the inner-loop FAKE universe
//! the rows were first promoted from (management-canister / anonymous / invented `…aac`
//! stand-in texts) — serving those would have regressed prod catastrophically (DEMO balances →
//! the management canister; ckBTC → the anonymous principal). All principal texts below are
//! REAL IC canister ids; the drift alarm pins every one against `dfx/catalog_truth.json`.
//!
//! Drift alarm: both sides stay pinned to `dfx/catalog_truth.json` — this module's
//! `catalog_truth_tests` (principals/decimals/order/locked shape) is the RELAY half; the app's
//! jest half (`app/__tests__/catalog.test.ts`, reading the same truth file) is unchanged.

use dpay_core::DEMO_USD;
use serde::Serialize;

use crate::ledger::ckerc20::{
    CKBTC_MINTER_PRINCIPAL, CKETH_LEDGER_PRINCIPAL, CKETH_MINTER_PRINCIPAL,
    CKUSDC_ERC20_ADDRESS, CKUSDC_LEDGER_PRINCIPAL,
};
use crate::ledger::types::{CurrencyDescriptor, MinterFamily, RampCapability, U64String};

/// The DEMO LEDGER principal (mainnet) — `td2nx-oaaaa-aaaab-qhdnq-cai`, the owned DUSD ICRC-1
/// ledger (currency 0, the `∂` faucet asset; 2 decimals). This is the REAL ledger the prod
/// catalog has always named — the earlier compiled row carried the management-canister
/// stand-in text from the offline fake universe, which would have routed real DEMO reads/writes
/// at the management canister. Cross-checked against `dfx/catalog_truth.json`
/// (`principals.demo_ledger`) by the `catalog_truth_tests` module below.
pub(crate) const DEMO_LEDGER_PRINCIPAL: &str = "td2nx-oaaaa-aaaab-qhdnq-cai";

/// The ckBTC LEDGER principal (mainnet) — `mxzaz-hqaaa-aaaar-qaada-cai`, the live chain-key
/// Bitcoin ICRC-1 ledger (currency 1; 8 decimals). Replaces the fake-universe anonymous
/// stand-in the promoted row carried. Cross-checked against
/// `dfx/catalog_truth.json` (`principals.ckbtc_ledger`).
pub(crate) const CKBTC_LEDGER_PRINCIPAL: &str = "mxzaz-hqaaa-aaaar-qaada-cai";

/// The ckTESTBTC LEDGER principal (ic testnet) — `mc6ru-gyaaa-aaaar-qaaaq-cai`, the live
/// testnet chain-key Bitcoin ledger (currency 3; 8 decimals). Cross-checked against
/// `dfx/catalog_truth.json` (`principals.testnet_ckbtc_ledger`).
pub(crate) const TESTNET_CKBTC_LEDGER_PRINCIPAL: &str = "mc6ru-gyaaa-aaaar-qaaaq-cai";

/// The ckTESTBTC MINTER principal (ic testnet) — `ml52i-qqaaa-aaaar-qaaba-cai`, the live
/// testnet chain-key Bitcoin minter (currency 3's minter; distinct from the mainnet ckBTC
/// minter). Cross-checked against `dfx/catalog_truth.json`
/// (`principals.testnet_ckbtc_minter`).
pub(crate) const TESTNET_CKBTC_MINTER_PRINCIPAL: &str = "ml52i-qqaaa-aaaar-qaaba-cai";

/// The ckSepoliaUSDC LEDGER principal (ic testnet) — `yfumr-cyaaa-aaaar-qaela-cai`, the live
/// testnet ckUSDC ICRC-1 ledger (currency 4; 6 decimals, Sepolia). Cross-checked against
/// `dfx/catalog_truth.json` (`principals.testnet_ckusdc_ledger`).
pub(crate) const TESTNET_CKUSDC_LEDGER_PRINCIPAL: &str = "yfumr-cyaaa-aaaar-qaela-cai";

/// The ckSepoliaETH LEDGER principal (ic testnet) — `apia6-jaaaa-aaaar-qabma-cai`, the live
/// testnet ckETH ICRC-1 ledger (currency 5; 18 decimals, Sepolia). The testnet ckETH-minter
/// burns gas + amounts from this ledger on the testnet cash-out legs. Cross-checked against
/// `dfx/catalog_truth.json` (`principals.testnet_cketh_ledger`).
pub(crate) const TESTNET_CKETH_LEDGER_PRINCIPAL: &str = "apia6-jaaaa-aaaar-qabma-cai";

/// The testnet ckETH MINTER principal — `jzenf-aiaaa-aaaar-qaa7q-cai`, the live Sepolia ckETH
/// minter handling native testnet ETH AND the Sepolia ckERC20 tokens (currencies 4 + 5;
/// distinct from the mainnet ckETH minter `sv3dd-…`). Cross-checked against
/// `dfx/catalog_truth.json` (`principals.testnet_cketh_minter`).
pub(crate) const TESTNET_CKETH_MINTER_PRINCIPAL: &str = "jzenf-aiaaa-aaaar-qaa7q-cai";

/// The VCHF LEDGER principal (mainnet) — `ly36x-wiaaa-aaaai-aqj7q-cai`, the live VNX Swiss Franc
/// ICRC-1 ledger (8 decimals, fee 10_000 raw). Currency 7 in BOTH compiled catalogs (this module
/// + the app's BUNDLED_NETWORKS): the first complete NO-MINTER direct-ICRC asset — no ramp, no
/// minter, payment is an app-signed `icrc1_transfer` straight to this ledger (spec
/// docs/specs/2026-08-28-vchf-icp-support-spec.md U5). Single-sourced here so the catalog row
/// can't drift from the registered value; the same literal is cross-checked against
/// `dfx/catalog_truth.json` (`principals.vchf_ledger`) by the `catalog_truth_tests` module below.
pub(crate) const VCHF_LEDGER_PRINCIPAL: &str = "ly36x-wiaaa-aaaai-aqj7q-cai";

/// The ICP LEDGER principal (mainnet) — `ryjl3-tyaaa-aaaaa-aaaba-cai`, the CANONICAL native ICP
/// ledger (8 decimals, fee 10_000 raw). Currency 8 in BOTH compiled catalogs; like VCHF a
/// complete no-minter direct-ICRC asset (no ramp capability in either direction). Note this is
/// the LEDGER pin only — the official ICP index canister (`qhbym-qaaaa-aaaaa-aaafq-cai`,
/// catalog_truth `principals.icp_index`) is a HISTORY-adapter pin in `agent_ledger.rs`,
/// deliberately NOT a catalog field. Cross-checked against `dfx/catalog_truth.json`
/// (`principals.icp_ledger`).
pub(crate) const ICP_LEDGER_PRINCIPAL: &str = "ryjl3-tyaaa-aaaaa-aaaba-cai";

/// The IC section rows of the catalog — the wallet's runtime source of truth for which assets
/// exist and how to display/fund them. REAL prod rows, fetched live from the prod relay's
/// `/api/v1/currencies` on 2026-08-28 and transplanted VERBATIM (every field, null vs value):
/// mainnet DEMO_USD (0, mintable, the faucet asset at the DUSD ledger) + ckBTC (1, CkBtcUtxo
/// ramp) + ckUSDC (2, CkEthErc20 onramp) + ckETH (6, native-ETH within CkEthErc20,
/// `token_contract` null) + the locked VCHF (7) / ICP (8) direct-ICRC rows; testnet ckTESTBTC
/// (3) + ckSepoliaUSDC (4) + ckSepoliaETH (5). The wallet reads `currency`/`symbol`/`decimals`/
/// `minter_family` + the per-currency metadata for display. Principals are TEXT consts (not
/// built via `candid::Principal`) because `candid` is feature-gated to `agent` and this module
/// ships in the lean offline build; every one is a REAL IC canister id pinned in
/// `dfx/catalog_truth.json`.
///
/// Ramp honesty (no-swap non-negotiable + OPEN_ISSUES O3): DEMO onramp=`Direct` (faucet),
/// offramp=`Unavailable`; ckBTC onramp=`Direct` (Bitcoin ramp), offramp=`Direct`;
/// ckUSDC onramp=`Direct` (ckETH helper built client-side), offramp=`Direct` (the dual-ledger
/// `withdraw_erc20` cash-out, gated on the user holding ckETH for gas); ckETH
/// onramp=`Direct` (`depositEth`), offramp=`Direct` (`withdraw_eth`); the Sepolia ckUSDC keeps
/// offramp=`Unavailable` (its cash-out is not wired); ckTESTBTC / ckSepoliaETH are Direct both
/// ways on the TESTNET rail (free testnet funds — the row only renders under the testnet
/// toggle).
pub(crate) fn ic_rows() -> Vec<CurrencyDescriptor> {
    vec![
        CurrencyDescriptor {
            currency: DEMO_USD,
            // The REAL DUSD ledger (owned, `td2nx-…` — docs/CANISTERS.md). The offline fake-IC
            // gateway keys its fake ledger at this same text, so the offline loop and prod agree
            // on where a DEMO transfer lands.
            ledger: DEMO_LEDGER_PRINCIPAL.to_string(),
            mintable: true,
            minter: None,
            minter_family: None,
            symbol: Some("$".into()),
            decimals: Some(2),
            wrapper_name: None,
            backing_symbol: None,
            network: None,
            display_decimals: None,
            fee: None, // DEMO fee is not part of the served row (faucet asset; fake accepts any)
            cap: Some(U64String(100_000)), // $1,000.00 — the same per-tx cap the facade registers
            chain_id: None,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Direct, // self-service faucet (fixed amount, rate-limited)
            offramp: RampCapability::Unavailable, // play money — no cash-out
        },
        CurrencyDescriptor {
            currency: 1, // ckBTC — chain-key Bitcoin deposit/withdraw ramp asset
            ledger: CKBTC_LEDGER_PRINCIPAL.to_string(), // the live ckBTC ledger (mxzaz-…)
            mintable: false,
            minter: Some(CKBTC_MINTER_PRINCIPAL.to_string()),
            minter_family: Some(MinterFamily::CkBtcUtxo),
            symbol: Some("₿".into()),
            decimals: Some(8),
            wrapper_name: Some("ckBTC".into()),
            backing_symbol: Some("BTC".into()),
            network: Some("Bitcoin".into()),
            display_decimals: Some(8),
            fee: None, // ckBTC ledger fee read live at runtime (MC2 validates)
            cap: Some(U64String(100_000)),
            chain_id: None,   // not EVM
            token_contract: None,
            gas_ledger: None, // BTC family — no ckETH gas ledger
            onramp: RampCapability::Direct,  // chain-key Bitcoin ramp
            offramp: RampCapability::Direct, // retrieve_btc_with_approval
        },
        CurrencyDescriptor {
            currency: 2, // ckUSDC (ckERC-20 onramp + cash-out currency)
            ledger: CKUSDC_LEDGER_PRINCIPAL.to_string(), // ckUSDC ledger principal text (O6)
            mintable: false,
            minter: Some(CKETH_MINTER_PRINCIPAL.to_string()), // ckETH minter
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("ckUSDC".into()),
            decimals: Some(6),
            wrapper_name: Some("ckUSDC".into()),
            backing_symbol: Some("USDC".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(6),
            fee: Some(U64String(10_000)), // ckUSDC ledger icrc1_fee (O6): 0.01 USDC = 10000 raw
            cap: Some(U64String(100_000)),
            chain_id: Some(1), // Ethereum mainnet
            token_contract: Some(CKUSDC_ERC20_ADDRESS.to_string()), // ckUSDC ERC-20 (O6) — single-sourced constant
            // The dual-ledger `withdraw_erc20` cash-out burns ckETH gas fees from THIS ledger (the
            // verified mainnet ckETH ledger) + the USDC amount from `ledger` above. The user MUST
            // hold ckETH for gas (Fork-C — dpay never converts ckUSDC→ckETH, no-swap); the app
            // surfaces an honest "You need ckETH for gas" note.
            gas_ledger: Some(CKETH_LEDGER_PRINCIPAL.to_string()),
            onramp: RampCapability::Direct,  // ckETH helper-contract onramp (client-side)
            offramp: RampCapability::Direct, // dual-ledger withdraw_erc20 cash-out (ckETH gas + USDC amount)
        },
        CurrencyDescriptor {
            // Native ETH within the CkEthErc20 family — discriminated by `token_contract == None`
            // (the app's `familyDisplay` branches CkEthErc20 on this: None ⇒ FD_CKETH_NATIVE ⇒ the
            // Cash-out button renders + the withdraw sheet uses 18-dec Wei). This is the catalog entry
            // the e2e drives through the native-ETH withdraw path (the facade's `withdraw` family
            // dispatch burns ckETH → sends native ETH). Same ckETH minter + chain as ckUSDC; only
            // `token_contract` (None) + the 18-dec/ETH display metadata differ.
            // Ramp honesty: onramp=Direct (single payable `depositEth` tx), offramp=Direct
            // (withdraw_eth). `gas_ledger` is None: native ckETH's gas ledger IS its own `ledger`
            // (the `withdraw_eth` path approves amount+fee on the single ckETH ledger).
            currency: 6, // native ckETH (CkEthErc20 + token_contract None)
            ledger: CKETH_LEDGER_PRINCIPAL.to_string(), // the live mainnet ckETH ledger (ss2fx-…)
            mintable: false,
            minter: Some(CKETH_MINTER_PRINCIPAL.to_string()), // ckETH minter (handles native ETH + all ckERC20)
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("Ξ".to_string()),
            decimals: Some(18),
            wrapper_name: Some("ckETH".into()),
            backing_symbol: Some("ETH".into()),
            network: Some("Ethereum".into()),
            display_decimals: Some(6), // prod ckETH (display_decimals=6 ≠ decimals=18) — exercises the truncation codepath
            fee: Some(U64String(2_000_000_000_000)), // the live ckETH ledger icrc1_fee (0.000002 ETH)
            cap: Some(U64String(100_000)),
            chain_id: Some(1),       // Ethereum mainnet
            token_contract: None,    // None ⇒ native ETH (NOT an ERC-20) — the family discriminator
            gas_ledger: None,        // native ETH — its own ledger IS the gas ledger (withdraw_eth single-ledger path)
            onramp: RampCapability::Direct,  // ckETH helper `depositEth` (client-side, single payable tx)
            offramp: RampCapability::Direct, // withdraw_eth: burn ckETH → send native ETH
        },
        CurrencyDescriptor {
            // ckTESTBTC — the REAL testnet chain-key Bitcoin row (network "Bitcoin Testnet" is NOT
            // in the mainnet set → is_testnet_row = true, so the wallet hides it by default +
            // reveals it via the testnet toggle). Mirrors the ckBTC shape (CkBtcUtxo family, 8 dec)
            // with its OWN testnet ledger + minter. Testnet ramps are Direct — the testnet rail is
            // free funds by design.
            currency: 3,
            ledger: TESTNET_CKBTC_LEDGER_PRINCIPAL.to_string(),
            mintable: false,
            minter: Some(TESTNET_CKBTC_MINTER_PRINCIPAL.to_string()),
            minter_family: Some(MinterFamily::CkBtcUtxo),
            symbol: Some("₿".into()),
            decimals: Some(8),
            wrapper_name: Some("ckTESTBTC".into()),
            backing_symbol: Some("BTC".into()),
            network: Some("Bitcoin Testnet".into()),
            display_decimals: None,
            fee: Some(U64String(10)), // the live testnet ckBTC ledger fee
            cap: Some(U64String(100_000)),
            chain_id: None,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Direct,
            offramp: RampCapability::Direct,
        },
        CurrencyDescriptor {
            // ckSepoliaUSDC — the REAL testnet ckERC20 row (Sepolia): per-token ERC-20 contract,
            // Sepolia chain_id, the TESTNET ckETH minter. Proves the onramp is per-token +
            // network-scoped on the testnet side too (the resolver surfaces the Sepolia CkDeposit
            // helper for chain_id 11155111). Ramp honesty: cash-out not wired on testnet USDC —
            // offramp=`Unavailable`.
            currency: 4,
            ledger: TESTNET_CKUSDC_LEDGER_PRINCIPAL.to_string(),
            mintable: false,
            minter: Some(TESTNET_CKETH_MINTER_PRINCIPAL.to_string()),
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("ckSepoliaUSDC".into()),
            decimals: Some(6),
            wrapper_name: Some("ckSepoliaUSDC".into()),
            backing_symbol: Some("USDC".into()),
            network: Some("Sepolia".into()),
            display_decimals: None,
            fee: Some(U64String(4_000)), // the live testnet ckUSDC ledger fee
            cap: Some(U64String(100_000)),
            chain_id: Some(11155111), // Sepolia
            token_contract: Some("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".into()), // testnet USDC ERC-20
            gas_ledger: None,
            onramp: RampCapability::Direct,   // Sepolia CkDeposit helper (chain_id-scoped)
            offramp: RampCapability::Unavailable, // testnet ckUSDC cash-out not wired
        },
        CurrencyDescriptor {
            // ckSepoliaETH — the REAL testnet native-ETH row: CkEthErc20 family +
            // `token_contract == None` (the same native-ETH discriminator as mainnet ckETH),
            // 18 decimals, Sepolia chain_id, the testnet ckETH minter. `gas_ledger` is None for
            // the same reason as mainnet ckETH: the native-ETH withdraw burns from its OWN ledger.
            currency: 5,
            ledger: TESTNET_CKETH_LEDGER_PRINCIPAL.to_string(),
            mintable: false,
            minter: Some(TESTNET_CKETH_MINTER_PRINCIPAL.to_string()),
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("Ξ".to_string()),
            decimals: Some(18),
            wrapper_name: Some("ckSepoliaETH".into()),
            backing_symbol: Some("ETH".into()),
            network: Some("Sepolia".into()),
            display_decimals: Some(6),
            fee: Some(U64String(10_000_000_000)), // the live testnet ckETH ledger fee
            cap: Some(U64String(100_000)),
            chain_id: Some(11155111), // Sepolia
            token_contract: None,     // None ⇒ native ETH — the family discriminator
            gas_ledger: None,
            onramp: RampCapability::Direct,  // Sepolia CkDeposit `depositEth`
            offramp: RampCapability::Direct, // testnet withdraw_eth
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

/// The v2 environment partition rule (server-authoritative — the app reads the section's
/// `environment` and never re-derives this): an IC row is testnet iff `network` is `Some` AND not
/// one of the mainnet network labels {`None` (DEMO $, the facade-native play asset, `mintable`),
/// "Bitcoin", "Ethereum", "Internet Computer"}. "Internet Computer" joined the mainnet set
/// 2026-08-28 for the two complete no-minter direct-ICRC assets (VCHF currency 7, native ICP
/// currency 8 — docs/specs/2026-08-28-vchf-icp-support-spec.md U3); before it, every
/// `network = "Internet Computer"` row was mis-filed into the testnet section and hidden behind
/// the wallet's testnet toggle.
///
/// SCHEMA DEBT: inferring the environment from the `network` DISPLAY string is temporary. The
/// catalog should carry an explicit `environment` field and this allowlist should collapse to a
/// pass-through; that migration is deliberately out of scope here (see docs/VCHF_ICP_ANALYSIS.md
/// gap 2 — the smallest safe change is extending the explicit set). Note the labels are no
/// longer hypothetical: the REAL rows 3/4/5 carry exactly "Bitcoin Testnet"/"Sepolia" and land
/// testnet-side through this rule.
fn is_testnet_row(d: &CurrencyDescriptor) -> bool {
    !matches!(
        d.network.as_deref(),
        None | Some("Bitcoin") | Some("Ethereum") | Some("Internet Computer")
    )
}

/// The mainnet USDC mint — mirrors `USDC_MINT_ADDRESS` (app/solana/spl.ts) verbatim; the only
/// on-chain address the solana section carries.
const SOLANA_USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/// The solana mainnet section — a relay-level constant provider (NOT a `Ledger` thing: the rail
/// is device-key + direct RPC and never touches the IC, so it is absent from the trait and
/// `fake.rs`). Values mirror app/solana.ts exactly: SOL 9 decimals (`SOL_DECIMALS`), USDC 6
/// decimals + [`SOLANA_USDC_MINT`]. No RPC endpoints or API keys here — the Helius URL stays
/// APK-side.
fn solana_network_section() -> NetworkBody {
    NetworkBody {
        protocol: "solana",
        name: "Solana",
        environment: "mainnet",
        assets: NetworkAssets::Solana(vec![
            SolanaAsset {
                token: "SOL",
                symbol: "SOL",
                decimals: 9, // SOL_DECIMALS (app/solana/identity.ts)
                mint: None,  // native L1 asset — no SPL mint
                onramp: RampCapability::Direct,
                offramp: RampCapability::Direct,
            },
            SolanaAsset {
                token: "USDC",
                symbol: "USDC",
                decimals: 6, // USDC_DECIMALS (app/solana/spl.ts)
                mint: Some(SOLANA_USDC_MINT),
                onramp: RampCapability::Direct,
                offramp: RampCapability::Direct,
            },
        ]),
    }
}

/// The complete `GET /api/v1/currencies` response body: exactly three sections in order
/// (icp mainnet, icp testnet, solana mainnet), partitioned server-side ([`is_testnet_row`]).
/// The empty testnet section is still emitted — clients shouldn't infer from absence. IC rows
/// serialize in the UNCHANGED `CurrencyDescriptor` shape (field set/casing frozen — the app +
/// e2e depend on the byte-shape).
pub(crate) fn currencies_body() -> CurrenciesBody {
    // Partition preserves each side's catalog order; mainnet keeps DEMO (network None).
    let (mainnet, testnet): (Vec<_>, Vec<_>) = ic_rows().into_iter().partition(|d| !is_testnet_row(d));
    CurrenciesBody {
        networks: vec![
            NetworkBody {
                protocol: "icp",
                name: "Internet Computer",
                environment: "mainnet",
                assets: NetworkAssets::Ic(mainnet),
            },
            NetworkBody {
                protocol: "icp",
                name: "Internet Computer",
                environment: "testnet",
                assets: NetworkAssets::Ic(testnet),
            },
            solana_network_section(),
        ],
    }
}

/// `GET /api/v1/currencies` response body — the network-first asset catalog (v2). Exactly three
/// sections in order: icp mainnet, icp testnet (possibly empty), solana mainnet.
#[derive(Serialize)]
pub(crate) struct CurrenciesBody {
    networks: Vec<NetworkBody>,
}

/// One `networks[]` section. `assets` is untagged so IC sections carry `CurrencyDescriptor` rows
/// and the solana section carries [`SolanaAsset`] rows — both serialize as plain JSON arrays.
#[derive(Serialize)]
pub(crate) struct NetworkBody {
    protocol: &'static str,
    name: &'static str,
    environment: &'static str,
    assets: NetworkAssets,
}

/// The `assets` array of a network section — IC rows (`CurrencyDescriptor`, field set/casing
/// UNCHANGED from the pre-v2 flat catalog) or the relay-constant Solana rows.
#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum NetworkAssets {
    Ic(Vec<CurrencyDescriptor>),
    Solana(Vec<SolanaAsset>),
}

/// One Solana asset row — a relay-level constant (the device-key rail never touches the IC,
/// so this is deliberately NOT a `CurrencyDescriptor`). `mint` is null for native SOL.
/// Ramp vocabulary is shared with the IC rows (`Direct`/`Partner`/`Unavailable`).
#[derive(Serialize)]
pub(crate) struct SolanaAsset {
    token: &'static str,
    symbol: &'static str,
    decimals: u8,
    mint: Option<&'static str>,
    onramp: RampCapability,
    offramp: RampCapability,
}

#[cfg(test)]
mod environment_partition_tests {
    //! U3 pins (docs/specs/2026-08-28-vchf-icp-support-spec.md): the Catalog v2 mainnet/testnet
    //! classification is SERVER-authoritative (`is_testnet_row`), and the app must keep trusting
    //! the section's `environment` field — no app-side inference duplication exists by design.
    //! These unit tests pin the classification rule directly, incl. network labels beyond the
    //! compiled catalog's own (unknown ones), so a regression here goes RED before any route test.

    use super::*;

    /// A minimal descriptor with the given `network` — the ONLY field [`is_testnet_row`] reads.
    fn row_with_network(network: Option<&str>) -> CurrencyDescriptor {
        CurrencyDescriptor {
            currency: 99,
            ledger: String::new(),
            mintable: false,
            minter: None,
            minter_family: None,
            symbol: None,
            decimals: None,
            wrapper_name: None,
            backing_symbol: None,
            network: network.map(Into::into),
            display_decimals: None,
            fee: None,
            cap: None,
            chain_id: None,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Unavailable,
            offramp: RampCapability::Unavailable,
        }
    }

    #[test]
    fn internet_computer_rows_are_mainnet() {
        // VCHF (currency 7) and native ICP (currency 8) carry network "Internet Computer" —
        // the 2026-08-28 fix: before "Internet Computer" joined the mainnet set, both rows
        // were mis-filed testnet-side and hidden behind the wallet's testnet toggle.
        let vchf = CurrencyDescriptor { currency: 7, ..row_with_network(Some("Internet Computer")) };
        let icp = CurrencyDescriptor { currency: 8, ..row_with_network(Some("Internet Computer")) };
        assert!(!is_testnet_row(&vchf), "VCHF (network \"Internet Computer\") is ICP MAINNET");
        assert!(!is_testnet_row(&icp), "ICP (network \"Internet Computer\") is ICP MAINNET");
    }

    #[test]
    fn network_none_demo_is_mainnet() {
        // DEMO $ (network = None, the facade-native play asset) stays mainnet-side.
        assert!(!is_testnet_row(&row_with_network(None)));
    }

    #[test]
    fn bitcoin_and_ethereum_rows_stay_mainnet() {
        // The pre-existing mainnet backing networks must not regress.
        assert!(!is_testnet_row(&row_with_network(Some("Bitcoin"))));
        assert!(!is_testnet_row(&row_with_network(Some("Ethereum"))));
    }

    #[test]
    fn bitcoin_testnet_and_sepolia_rows_stay_testnet() {
        // The REAL testnet rows' labels (ckTESTBTC row 3, Sepolia rows 4/5) — the wallet hides
        // these by default.
        assert!(is_testnet_row(&row_with_network(Some("Bitcoin Testnet"))));
        assert!(is_testnet_row(&row_with_network(Some("Sepolia"))));
    }

    #[test]
    fn unknown_networks_fail_closed_testnet() {
        // Any unrecognized network label is testnet (fail-closed: a typo'd/unknown label must
        // never leak a row into the mainnet section).
        assert!(is_testnet_row(&row_with_network(Some("Internet Computor"))));
        assert!(is_testnet_row(&row_with_network(Some(""))));
    }
}

// ---------------------------------------------------------------------------
// Catalog single-source drift alarm (item 2, 2026-08-08; authority moved to the relay
// 2026-08-28; extended to pin EVERY IC row 2026-08-28).
// ---------------------------------------------------------------------------
// `dfx/catalog_truth.json` is the single source of truth for the drift-prone currency literals
// shared across this module's [`ic_rows`] (the relay's RUNTIME catalog — sole authority since
// the facade registry's removal, founder decision 2026-08-28) and the app's `BUNDLED_CATALOG`
// (`app/config/catalog.ts`, the wallet's cold-load fallback). The two MUST stay byte-aligned on
// the mainnet principals/ERC-20/decimals, or a cold-load render shows the wrong decimals / the
// relay serves the wrong transfer target. This module is the RELAY half of the drift alarm; the
// APP half is `app/__tests__/catalog.test.ts` (unchanged — it reads the same truth file). A
// literal/const change here without a JSON update (or vice-versa) goes RED.
//
// Since the 2026-08-28 REAL-rows transplant this catalog is money-defining config (every
// principal below moves real funds), so the alarm pins EVERY row's ledger/minter principal,
// currency id, source order, served section order, and locked shape — not just the old
// shared-with-the-app subset.
//
// The JSON is embedded at compile time via `include_str!` so the test fails to BUILD if the file
// moves (no runtime path fragility). Path is relative to this source file
// (`crates/dpay-relay/src/catalog.rs`) → repo-root `dfx/catalog_truth.json`.
#[cfg(test)]
mod catalog_truth_tests {
    //! The catalog drift alarm — see the module doc up top for the full contract.

    use serde_json::Value;

    use dpay_core::Currency;

    use super::*;

    const CATALOG_TRUTH: &str = include_str!("../../../dfx/catalog_truth.json");

    fn truth() -> Value {
        serde_json::from_str(CATALOG_TRUTH).expect("dfx/catalog_truth.json must be valid JSON")
    }

    fn catalog_currency(cat: &[CurrencyDescriptor], currency: Currency) -> &CurrencyDescriptor {
        cat.iter()
            .find(|d| d.currency == currency)
            .unwrap_or_else(|| panic!("ic_rows() missing currency {currency}"))
    }

    #[test]
    fn named_consts_are_the_catalog_truth_values() {
        // Belt-and-suspenders: the named principal/contract consts ARE the JSON's values. A const
        // edit without a JSON update (or vice-versa) goes RED here, before the catalog-level check.
        let t = truth();
        let p = &t["principals"];
        assert_eq!(DEMO_LEDGER_PRINCIPAL, p["demo_ledger"].as_str().unwrap());
        assert_eq!(CKBTC_MINTER_PRINCIPAL, p["ckbtc_minter"].as_str().unwrap());
        assert_eq!(CKBTC_LEDGER_PRINCIPAL, p["ckbtc_ledger"].as_str().unwrap());
        assert_eq!(CKETH_MINTER_PRINCIPAL, p["cketh_minter"].as_str().unwrap());
        assert_eq!(CKUSDC_LEDGER_PRINCIPAL, p["ckusdc_ledger"].as_str().unwrap());
        // The ckETH ledger IS the ckERC20 gas ledger — one canister, two truth-file names.
        assert_eq!(CKETH_LEDGER_PRINCIPAL, p["cketh_ledger"].as_str().unwrap());
        assert_eq!(CKETH_LEDGER_PRINCIPAL, p["cketh_gas_ledger"].as_str().unwrap());
        assert_eq!(
            TESTNET_CKBTC_LEDGER_PRINCIPAL,
            p["testnet_ckbtc_ledger"].as_str().unwrap()
        );
        assert_eq!(
            TESTNET_CKBTC_MINTER_PRINCIPAL,
            p["testnet_ckbtc_minter"].as_str().unwrap()
        );
        assert_eq!(
            TESTNET_CKUSDC_LEDGER_PRINCIPAL,
            p["testnet_ckusdc_ledger"].as_str().unwrap()
        );
        assert_eq!(
            TESTNET_CKETH_LEDGER_PRINCIPAL,
            p["testnet_cketh_ledger"].as_str().unwrap()
        );
        assert_eq!(
            TESTNET_CKETH_MINTER_PRINCIPAL,
            p["testnet_cketh_minter"].as_str().unwrap()
        );
        assert_eq!(VCHF_LEDGER_PRINCIPAL, p["vchf_ledger"].as_str().unwrap());
        assert_eq!(ICP_LEDGER_PRINCIPAL, p["icp_ledger"].as_str().unwrap());
        assert_eq!(
            CKUSDC_ERC20_ADDRESS,
            t["erc20_contracts"]["ckusdc"].as_str().unwrap()
        );
        // The official ICP index is NOT a catalog field (no index_canister abstraction until a
        // second ledger needs one) — the CODE pin lives in agent_ledger.rs's history adapter.
        // This literal check keeps the JSON's icp_index entry honest against the spec-locked
        // value so the agent-side pin can't be fed a typo'd principal from the truth file.
        assert_eq!(p["icp_index"].as_str().unwrap(), "qhbym-qaaaa-aaaaa-aaafq-cai");
    }

    #[test]
    fn ic_rows_pin_every_rows_principals_ids_and_order() {
        // The REAL-catalog pin: every IC row's ledger/minter principal matches the truth file,
        // the currency ids are exactly the durable set (0,1,2,6 mainnet-real + 3,4,5
        // testnet-real + 7,8 locked), the source order is stable, and the SERVED sections come
        // out in the documented order (mainnet 0,1,2,6,7,8 / testnet 3,4,5).
        let t = truth();
        let p = &t["principals"];
        let cat = ic_rows();

        // Source order + ids.
        assert_eq!(cat.len(), 9, "9 IC rows: 4 real mainnet + 3 real testnet + VCHF + ICP");
        assert_eq!(
            cat.iter().map(|d| d.currency).collect::<Vec<_>>(),
            vec![0, 1, 2, 6, 3, 4, 5, 7, 8],
            "ids stay the durable set; source order = mainnet-real, testnet-real, locked 7/8"
        );

        // Every row's ledger + minter against the truth file (None ⇒ the row is genuinely
        // minter-less: DEMO, VCHF, ICP).
        let pins: &[(Currency, &str, Option<&str>)] = &[
            (DEMO_USD, "demo_ledger", None),
            (1, "ckbtc_ledger", Some("ckbtc_minter")),
            (2, "ckusdc_ledger", Some("cketh_minter")),
            (6, "cketh_ledger", Some("cketh_minter")),
            (3, "testnet_ckbtc_ledger", Some("testnet_ckbtc_minter")),
            (4, "testnet_ckusdc_ledger", Some("testnet_cketh_minter")),
            (5, "testnet_cketh_ledger", Some("testnet_cketh_minter")),
            (7, "vchf_ledger", None),
            (8, "icp_ledger", None),
        ];
        for (cid, ledger_key, minter_key) in pins {
            let row = catalog_currency(&cat, *cid);
            assert_eq!(
                row.ledger.as_str(),
                p[*ledger_key].as_str().unwrap(),
                "currency {cid} ledger must equal truth-file {ledger_key}"
            );
            match minter_key {
                Some(key) => assert_eq!(
                    row.minter.as_deref().unwrap(),
                    p[*key].as_str().unwrap(),
                    "currency {cid} minter must equal truth-file {key}"
                ),
                None => assert_eq!(row.minter, None, "currency {cid} must carry NO minter"),
            }
        }

        // The SERVED partition order (what /api/v1/currencies actually emits).
        let body = currencies_body();
        let section_ids = |sec: usize| -> Vec<Currency> {
            match &body.networks[sec].assets {
                NetworkAssets::Ic(rows) => rows.iter().map(|d| d.currency).collect(),
                NetworkAssets::Solana(_) => panic!("section {sec} must be an IC section"),
            }
        };
        assert_eq!(section_ids(0), vec![0, 1, 2, 6, 7, 8], "icp MAINNET section order");
        assert_eq!(section_ids(1), vec![3, 4, 5], "icp TESTNET section order");
        assert!(matches!(body.networks[2].assets, NetworkAssets::Solana(_)));
    }

    #[test]
    fn ic_rows_real_rows_locked_shape() {
        // The REAL rows' locked shape — byte-exact facets of the live-prod transplant (2026-08-28):
        // decimals, display_decimals, fee, cap, family, chain_id, token_contract, gas_ledger,
        // ramps. A silent edit to any of these changes what prod serves AND where the offline
        // fake gateway routes value; this pins each facet.
        let cat = ic_rows();

        // --- DEMO (currency 0) ---
        let demo = catalog_currency(&cat, DEMO_USD);
        assert_eq!(demo.decimals.unwrap(), t_demo_decimals());
        assert!(demo.mintable, "DEMO stays the one mintable faucet asset");
        assert_eq!(demo.symbol.as_deref(), Some("$"));
        assert_eq!(demo.minter_family, None);
        assert_eq!(demo.wrapper_name, None);
        assert_eq!(demo.backing_symbol, None);
        assert_eq!(demo.network, None);
        assert_eq!(demo.display_decimals, None);
        assert_eq!(demo.fee, None);
        assert_eq!(demo.cap, Some(U64String(100_000)), "the $1,000.00 per-tx cap");
        assert_eq!(demo.chain_id, None);
        assert_eq!(demo.token_contract, None);
        assert_eq!(demo.gas_ledger, None);
        assert_eq!(demo.onramp, RampCapability::Direct);
        assert_eq!(demo.offramp, RampCapability::Unavailable);

        // --- ckBTC (currency 1) ---
        let ckbtc = catalog_currency(&cat, 1);
        assert_eq!(ckbtc.decimals.unwrap(), 8);
        assert!(!ckbtc.mintable);
        assert_eq!(ckbtc.minter_family, Some(MinterFamily::CkBtcUtxo));
        assert_eq!(ckbtc.symbol.as_deref(), Some("₿"));
        assert_eq!(ckbtc.wrapper_name.as_deref(), Some("ckBTC"));
        assert_eq!(ckbtc.backing_symbol.as_deref(), Some("BTC"));
        assert_eq!(ckbtc.network.as_deref(), Some("Bitcoin"));
        assert_eq!(ckbtc.display_decimals.unwrap(), 8);
        assert_eq!(ckbtc.fee, None, "ckBTC fee read live at runtime");
        assert_eq!(ckbtc.cap, Some(U64String(100_000)));
        assert_eq!(ckbtc.chain_id, None);
        assert_eq!(ckbtc.token_contract, None);
        assert_eq!(ckbtc.gas_ledger, None);
        assert_eq!(ckbtc.onramp, RampCapability::Direct);
        assert_eq!(ckbtc.offramp, RampCapability::Direct);

        // --- ckUSDC (currency 2) ---
        let ckusdc = catalog_currency(&cat, 2);
        assert_eq!(ckusdc.decimals.unwrap(), 6);
        assert!(!ckusdc.mintable);
        assert_eq!(ckusdc.minter_family, Some(MinterFamily::CkEthErc20));
        assert_eq!(ckusdc.symbol.as_deref(), Some("ckUSDC"));
        assert_eq!(ckusdc.wrapper_name.as_deref(), Some("ckUSDC"));
        assert_eq!(ckusdc.backing_symbol.as_deref(), Some("USDC"));
        assert_eq!(ckusdc.network.as_deref(), Some("Ethereum"));
        assert_eq!(ckusdc.display_decimals.unwrap(), 6);
        assert_eq!(ckusdc.fee, Some(U64String(10_000)), "0.01 USDC = 10000 raw");
        assert_eq!(ckusdc.cap, Some(U64String(100_000)));
        assert_eq!(ckusdc.chain_id, Some(1));
        assert_eq!(
            ckusdc.token_contract.as_deref().unwrap(),
            CKUSDC_ERC20_ADDRESS
        );
        assert_eq!(
            ckusdc.gas_ledger.as_deref().unwrap(),
            CKETH_LEDGER_PRINCIPAL,
            "the dual-ledger withdraw_erc20 gas leg"
        );
        assert_eq!(ckusdc.onramp, RampCapability::Direct);
        assert_eq!(ckusdc.offramp, RampCapability::Direct);

        // --- native ckETH (currency 6) ---
        let cketh = catalog_currency(&cat, 6);
        assert_eq!(cketh.decimals.unwrap(), 18, "the 18-dec precision extreme");
        assert!(!cketh.mintable);
        assert_eq!(cketh.minter_family, Some(MinterFamily::CkEthErc20));
        assert_eq!(cketh.symbol.as_deref(), Some("Ξ"));
        assert_eq!(cketh.wrapper_name.as_deref(), Some("ckETH"));
        assert_eq!(cketh.backing_symbol.as_deref(), Some("ETH"));
        assert_eq!(cketh.network.as_deref(), Some("Ethereum"));
        assert_eq!(cketh.display_decimals.unwrap(), 6, "prod ckETH: display 6 ≠ decimals 18");
        assert_eq!(
            cketh.fee,
            Some(U64String(2_000_000_000_000)),
            "the live ckETH ledger icrc1_fee (0.000002 ETH)"
        );
        assert_eq!(cketh.cap, Some(U64String(100_000)));
        assert_eq!(cketh.chain_id, Some(1));
        assert_eq!(cketh.token_contract, None, "None ⇒ native ETH — the family discriminator");
        assert_eq!(cketh.gas_ledger, None, "withdraw_eth approves on ckETH's OWN ledger");
        assert_eq!(cketh.onramp, RampCapability::Direct);
        assert_eq!(cketh.offramp, RampCapability::Direct);

        // --- ckTESTBTC (currency 3, testnet) ---
        let cktb = catalog_currency(&cat, 3);
        assert_eq!(cktb.decimals.unwrap(), 8);
        assert!(!cktb.mintable);
        assert_eq!(cktb.minter_family, Some(MinterFamily::CkBtcUtxo));
        assert_eq!(cktb.symbol.as_deref(), Some("₿"));
        assert_eq!(cktb.wrapper_name.as_deref(), Some("ckTESTBTC"));
        assert_eq!(cktb.backing_symbol.as_deref(), Some("BTC"));
        assert_eq!(cktb.network.as_deref(), Some("Bitcoin Testnet"));
        assert_eq!(cktb.display_decimals, None);
        assert_eq!(cktb.fee, Some(U64String(10)));
        assert_eq!(cktb.cap, Some(U64String(100_000)));
        assert_eq!(cktb.chain_id, None);
        assert_eq!(cktb.token_contract, None);
        assert_eq!(cktb.gas_ledger, None);
        assert_eq!(cktb.onramp, RampCapability::Direct);
        assert_eq!(cktb.offramp, RampCapability::Direct);

        // --- ckSepoliaUSDC (currency 4, testnet) ---
        let sep_usdc = catalog_currency(&cat, 4);
        assert_eq!(sep_usdc.decimals.unwrap(), 6);
        assert!(!sep_usdc.mintable);
        assert_eq!(sep_usdc.minter_family, Some(MinterFamily::CkEthErc20));
        assert_eq!(sep_usdc.symbol.as_deref(), Some("ckSepoliaUSDC"));
        assert_eq!(sep_usdc.wrapper_name.as_deref(), Some("ckSepoliaUSDC"));
        assert_eq!(sep_usdc.backing_symbol.as_deref(), Some("USDC"));
        assert_eq!(sep_usdc.network.as_deref(), Some("Sepolia"));
        assert_eq!(sep_usdc.display_decimals, None);
        assert_eq!(sep_usdc.fee, Some(U64String(4_000)));
        assert_eq!(sep_usdc.cap, Some(U64String(100_000)));
        assert_eq!(sep_usdc.chain_id, Some(11155111), "Sepolia — selects the Sepolia CkDeposit helper");
        assert_eq!(
            sep_usdc.token_contract.as_deref().unwrap(),
            "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            "the testnet USDC ERC-20 (NOT the mainnet USDC address)"
        );
        assert_eq!(sep_usdc.gas_ledger, None);
        assert_eq!(sep_usdc.onramp, RampCapability::Direct);
        assert_eq!(sep_usdc.offramp, RampCapability::Unavailable, "testnet USDC cash-out not wired");

        // --- ckSepoliaETH (currency 5, testnet) ---
        let sep_eth = catalog_currency(&cat, 5);
        assert_eq!(sep_eth.decimals.unwrap(), 18);
        assert!(!sep_eth.mintable);
        assert_eq!(sep_eth.minter_family, Some(MinterFamily::CkEthErc20));
        assert_eq!(sep_eth.symbol.as_deref(), Some("Ξ"));
        assert_eq!(sep_eth.wrapper_name.as_deref(), Some("ckSepoliaETH"));
        assert_eq!(sep_eth.backing_symbol.as_deref(), Some("ETH"));
        assert_eq!(sep_eth.network.as_deref(), Some("Sepolia"));
        assert_eq!(sep_eth.display_decimals.unwrap(), 6);
        assert_eq!(sep_eth.fee, Some(U64String(10_000_000_000)));
        assert_eq!(sep_eth.cap, Some(U64String(100_000)));
        assert_eq!(sep_eth.chain_id, Some(11155111));
        assert_eq!(sep_eth.token_contract, None, "None ⇒ native ETH on Sepolia too");
        assert_eq!(sep_eth.gas_ledger, None);
        assert_eq!(sep_eth.onramp, RampCapability::Direct);
        assert_eq!(sep_eth.offramp, RampCapability::Direct);
    }

    /// DEMO's decimals, read from the truth file (the jest side pins the same key).
    fn t_demo_decimals() -> u8 {
        truth()["decimals"]["demo"].as_u64().unwrap() as u8
    }

    #[test]
    fn ic_rows_vchf_icp_rows_match_truth_and_locked_shape() {
        // U5 drift alarm (2026-08-28 spec): the VCHF (7) and ICP (8) rows cannot diverge from
        // dfx/catalog_truth.json (principal, decimals) nor from the LOCKED spec record (fee,
        // cap, units, network, no-minter shape, no-ramp capabilities, order). These two rows are
        // the first complete no-minter direct-ICRC assets — a drifted field here breaks either
        // the cold-start fallback the wallet renders offline or the exact-ledger transfer target.
        let t = truth();
        let cat = ic_rows();

        // --- ORDER + currency ID: VCHF is id 7, ICP is id 8, appended LAST (after the real
        // mainnet 0,1,2,6 and real testnet 3,4,5), VCHF before ICP. The spec locks 7/8 in BOTH
        // compiled catalogs (this module + the app's BUNDLED_NETWORKS).
        assert_eq!(cat.len(), 9, "4 real mainnet + 3 real testnet + VCHF + ICP");
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
