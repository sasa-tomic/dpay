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
//! jest half (`app/__tests__/catalog.test.ts`, reading the same truth file) is extended in
//! lockstep for the EUR dual-rail (2026-09-06). `wire_byte_shape_tests` pins the served JSON
//! bytes: old rows byte-identical, the two new EUR rows carrying the optional fields.

use dpay_core::DEMO_USD;
use serde::Serialize;

use crate::ledger::ckerc20::{
    CKBTC_MINTER_PRINCIPAL, CKETH_LEDGER_PRINCIPAL, CKETH_MINTER_PRINCIPAL, CKUSDC_ERC20_ADDRESS,
    CKUSDC_LEDGER_PRINCIPAL,
};
use crate::ledger::types::{
    CurrencyDescriptor, LiquidityTier, MinterFamily, RampCapability, U64String,
};

/// The DEMO LEDGER principal (mainnet) — `td2nx-oaaaa-aaaab-qhdnq-cai`, the owned DUSD ICRC-1
/// ledger (currency 0, the `∂` faucet asset; 2 decimals). This is the REAL ledger the prod
/// catalog has always named — the earlier compiled row carried the management-canister
/// stand-in text from the offline fake universe, which would have routed real DEMO reads/writes
/// at the management canister. Cross-checked against `dfx/catalog_truth.json`
/// (`principals.demo_ledger`) by the `catalog_truth_tests` module below.
pub(crate) const DEMO_LEDGER_PRINCIPAL: &str = "td2nx-oaaaa-aaaab-qhdnq-cai";

/// The DEMO row's ledger text, with the local-replica demo override applied (F1, 2026-09-12).
///
/// `DPAY_DEMO_LEDGER=<principal>` — set ONLY by `scripts/demo.sh` — re-points the DEMO row at
/// the replica's freshly-created `icrc_ledger`, so the demo has ONE ledger end to end: the
/// relay's `/balances` reads, the faucet's `mint` (which transfers from the facade-owned
/// minting account on the ledger `demo_ledger` names in the facade's init arg), and the app's
/// signed `icrc1_transfer` envelopes all land on the same canister. Unset — every prod, lean
/// and test build — the mainnet DUSD principal stands and the served bytes are unchanged
/// (`catalog_truth_tests` + `wire_byte_shape_tests` pin exactly that). Read once via
/// `OnceLock`: the catalog is rebuilt per request and must not re-parse the env each call; the
/// principal's SHAPE is validated at relay startup (`main.rs`, agent build, where `candid`
/// exists). The fake-IC gateway keys its ledgers off the same rows, so the offline loop and
/// the demo agree on wherever this points.
fn demo_ledger_text() -> String {
    use std::sync::OnceLock;
    static OVERRIDE: OnceLock<Option<String>> = OnceLock::new();
    OVERRIDE
        .get_or_init(|| {
            std::env::var("DPAY_DEMO_LEDGER")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .as_deref()
        .unwrap_or(DEMO_LEDGER_PRINCIPAL)
        .to_string()
}

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

/// The VEUR LEDGER principal (mainnet) — `wu6g4-6qaaa-aaaan-qmrza-cai`, the live VNX Euro ICRC-1
/// ledger (8 decimals, fee 10_000 raw). Currency 9 in BOTH compiled catalogs (this module + the
/// app's BUNDLED_NETWORKS), appended 2026-09-06 as Stage 1 of the founder-approved EUR dual-rail:
/// a complete NO-MINTER direct-ICRC asset exactly like VCHF/ICP (payment is an app-signed
/// `icrc1_transfer` straight to this ledger), with the FIRST `offramp = Partner` row — the DFX
/// fiat off-ramp (`ramp_partner: "DFX"`). Single-sourced here so the catalog row can't drift;
/// cross-checked against `dfx/catalog_truth.json` (`principals.veur_ledger`) by the
/// `catalog_truth_tests` module below.
pub(crate) const VEUR_LEDGER_PRINCIPAL: &str = "wu6g4-6qaaa-aaaan-qmrza-cai";

/// A conversion venue's kind. Extensible by construction: a later Solana venue kind is a new
/// variant (or a string on the wire), never a schema break — `cefi` is already reserved and is
/// deliberately NOT an IC-pool shape (the `Ledger` trait takes no CeFi method; CeFi lives
/// device-side, `app/services/opencryptopay.ts` shape).
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VenueKind {
    /// An on-chain IC AMM pool the user's device signs against (ICPSwap today).
    IcAmm,
    /// A centralized exchange integration — device-side quote/deposit/submit, no relay hop.
    /// Reserved: no entry uses it yet, but the registry (and the served route's `kind` string)
    /// already speaks it so adding the first CeFi venue is data, not a schema change.
    #[allow(dead_code)]
    Cefi,
}

/// The offline stub seed for one ic_amm venue's fake-IC pool (`ic_gateway.rs`). The pair ORDER
/// and fee tier here are pinned against `dfx/catalog_truth.json` `venues[].fixture` — for real
/// venues MEASURED off the live pool (the 2026-09-08 lesson: an offline fixture standing in for
/// a remote system must be pinned by something that actually talks to that system —
/// `just swap-venue-probe`), for fixture-only venues declared as fixture-truth. Reserves are the
/// curve simulation (code's own choice, deliberately NOT truth-file facts).
///
/// Read only by the fake-IC seeding (`test-helpers`); every build compiles the registry
/// wholesale (see `venues()` — the plain-`#[cfg(test)]` drift alarm reads it under any
/// feature set), so the seed rides along unread in the others, which this cfg_attr says out
/// loud instead of letting the compiler warn per config.
#[cfg_attr(not(feature = "test-helpers"), allow(dead_code))]
pub(crate) struct FixtureSeed {
    pub token0_ledger: &'static str,
    pub token1_ledger: &'static str,
    pub fee_millionths: u128,
    /// Genesis reserve of the pool's OWN token0 (e8s) — follows the token, not the asset.
    pub reserve0_e8s: u128,
    /// Genesis reserve of the pool's OWN token1 (e8s).
    pub reserve1_e8s: u128,
}

/// One conversion venue (multi-venue readiness Wave 1, `docs/specs/2026-09-08-multi-venue-readiness.md`
/// V4). The endpoint principal is the ONLY venue fact held as a constant — dpay's own choice of
/// which contract to talk to. Everything the venue says about itself (pair ORDER, fee tier) is
/// read off the venue at request time (`AgentLedger::swap_pool_metadata`) and echoed on the
/// quote; `pair_ledgers` here is an UNORDERED set — pinning an order is exactly the 2026-09-07
/// defect that shipped each direction's rate under the other's label. Drift-alarmed against
/// `dfx/catalog_truth.json` `venues[]` (Rust half here, jest half `app/__tests__/catalog.test.ts`).
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
pub(crate) struct VenueEntry {
    /// Stable machine id (records, quote attribution, allowlist keys).
    pub venue_id: &'static str,
    /// Locale-invariant display name — the ONE home of "ICPSwap" (i18n takes it as an argument).
    pub display_name: &'static str,
    pub kind: VenueKind,
    /// The dpay-chosen contract principal (pool canister for ic_amm).
    pub endpoint: &'static str,
    /// The pair as an UNORDERED set of ledger principals.
    pub pair_ledgers: [&'static str; 2],
    pub testnet: bool,
    /// Key selecting the venue's disclosure copy family (app-side i18n).
    pub disclosure_key: &'static str,
    /// True = an invented offline-fixture venue (multi-venue readiness V5): it seeds a second
    /// fake-IC pool and may be SERVED by `/api/v1/venues` only in the offline test build
    /// (test-helpers without agent) and only behind the `POST /api/v1/test/venue` knob — see
    /// [`venue_servable`]. Never served by the agent (prod) build, never allowlisted there,
    /// never probed on mainnet.
    pub test_helpers_served: bool,
    /// The fake-IC stub seed (ic_amm venues only; `None` for cefi). Read only under
    /// `test-helpers` (the seeding); agent builds compile it unread — see `FixtureSeed`.
    #[cfg_attr(not(feature = "test-helpers"), allow(dead_code))]
    pub fixture: Option<FixtureSeed>,
}

/// The compiled venue registry (mirrors `dfx/catalog_truth.json` `venues[]`, drift-alarmed).
///
/// Compiled in EVERY build, not just the feature-carrying ones: the drift alarm in
/// `venue_truth_tests` is plain `#[cfg(test)]`, so it reads the registry under any feature
/// set (a bare no-features `cargo test -p dpay-relay` included) and the data it checks cannot
/// be feature-gated — gating it would compile the alarm to nothing. Pure data (no feature
/// pulls a dependency); the lean no-features build has no other reader, hence the cfg_attr —
/// the agent and test-helpers builds call it from the `/venues` route.
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
pub(crate) fn venues() -> Vec<VenueEntry> {
    vec![
        VenueEntry {
            venue_id: "icpswap",
            display_name: "ICPSwap",
            kind: VenueKind::IcAmm,
            // The PoC VCHF/ICP 0.3% pool (factory 4mmnk-kiaaa-aaaag-qbllq-cai), spec
            // docs/specs/2026-09-07-delegated-conversion-spec.md §1.
            endpoint: "65mrh-fqaaa-aaaar-qapoa-cai",
            // UNORDERED — which side the pool calls token0 is read live off its metadata.
            pair_ledgers: [VCHF_LEDGER_PRINCIPAL, ICP_LEDGER_PRINCIPAL],
            testnet: false,
            disclosure_key: "icpswap",
            test_helpers_served: false,
            fixture: Some(FixtureSeed {
                // MEASURED off the live pool 2026-09-08 (token0 = VCHF, token1 = ICP, 0.30%).
                token0_ledger: VCHF_LEDGER_PRINCIPAL,
                token1_ledger: ICP_LEDGER_PRINCIPAL,
                fee_millionths: 3000,
                // token0/token1-e8s: 1.93M VCHF / 1M ICP — deep enough that PoC-size swaps
                // barely move the price (deterministic, NOT a live-band match).
                reserve0_e8s: 193_000_000_000_000,
                reserve1_e8s: 100_000_000_000_000,
            }),
        },
        VenueEntry {
            // OFFLINE TEST FIXTURE — invented principal (no such canister on any network).
            // Same pair, REVERSED seed order (token0 = ICP — the direction logic must prove it
            // derives per pool, not once globally) and a different curve + fee (0.10%). Served
            // ONLY by the offline test relay behind the /test/venue knob (V5) so the chooser
            // can be driven with two venues on one pair; `testnet: true` labels it the invented
            // stand-in it is (multi-venue readiness V5, 2026-09-11).
            venue_id: "icpswap-fixture-b",
            display_name: "ICPSwap (offline fixture)",
            kind: VenueKind::IcAmm,
            endpoint: "6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7",
            pair_ledgers: [VCHF_LEDGER_PRINCIPAL, ICP_LEDGER_PRINCIPAL],
            testnet: true,
            disclosure_key: "icpswap",
            test_helpers_served: true,
            fixture: Some(FixtureSeed {
                token0_ledger: ICP_LEDGER_PRINCIPAL,
                token1_ledger: VCHF_LEDGER_PRINCIPAL,
                fee_millionths: 1000,
                // 0.8M ICP / 1.4M VCHF — a genuinely different curve from the PoC stub's.
                reserve0_e8s: 80_000_000_000_000,
                reserve1_e8s: 140_000_000_000_000,
            }),
        },
    ]
}

/// The venue a quote is attributable to, by endpoint principal — this IS the allowlist
/// (generalized: the principal must be a known ic_amm venue's ENDPOINT) and the
/// `/api/v1/swap_quote` `venue_id` echo. Test-fixture venues resolve ONLY where they exist —
/// the offline fake (test-helpers without agent); the agent/prod build allowlists real
/// contracts only, so an invented principal can never be asked of a live replica.
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
pub(crate) fn venue_of_endpoint(pool: &str) -> Option<VenueEntry> {
    venues()
        .into_iter()
        .find(|v| v.kind == VenueKind::IcAmm && v.endpoint == pool && (!v.test_helpers_served || cfg!(not(feature = "agent"))))
}

/// May `v` be served by `GET /api/v1/venues` in THIS build, with the test knob `knob_armed`?
/// (multi-venue readiness V5.) Real venues always. A [`VenueEntry::test_helpers_served`]
/// fixture venue only in the OFFLINE test build (test-helpers WITHOUT agent) and only while
/// its knob is armed — and the agent/prod build has NO knob at all (the `/test/venue` route,
/// the `FakeIc` state behind it, and the `test-helpers` branch here are all cfg'd away), so it
/// always computes this with `knob_armed == false`, which is `false` for every fixture venue.
/// That agent-build truth is exactly what the alarm in `venue_truth_tests` pins.
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
pub(crate) fn venue_servable(v: &VenueEntry, knob_armed: bool) -> bool {
    !v.test_helpers_served
        || (cfg!(all(feature = "test-helpers", not(feature = "agent"))) && knob_armed)
}

/// The IC section rows of the catalog — the wallet's runtime source of truth for which assets
/// exist and how to display/fund them. REAL prod rows, fetched live from the prod relay's
/// `/api/v1/currencies` on 2026-08-28 and transplanted VERBATIM (every field, null vs value):
/// mainnet DEMO_USD (0, mintable, the faucet asset at the DUSD ledger) + ckBTC (1, CkBtcUtxo
/// ramp) + ckUSDC (2, CkEthErc20 onramp) + ckETH (6, native-ETH within CkEthErc20,
/// `token_contract` null) + the locked VCHF (7) / ICP (8) direct-ICRC rows + the VEUR (9)
/// direct-ICRC row (EUR dual-rail Stage 1, 2026-09-06 — offramp=Partner via DFX, liquidity
/// `thin`); testnet ckTESTBTC (3) + ckSepoliaUSDC (4) + ckSepoliaETH (5). The wallet reads
/// `currency`/`symbol`/`decimals`/
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
/// toggle); VEUR onramp=`Unavailable` (no compliant fiat on-ramp), offramp=`Partner` (DFX) —
/// the first Partner row, carrying `ramp_partner: "DFX"`.
pub(crate) fn ic_rows() -> Vec<CurrencyDescriptor> {
    vec![
        CurrencyDescriptor {
            currency: DEMO_USD,
            // The REAL DUSD ledger (owned, `td2nx-…` — docs/CANISTERS.md) — unless the demo
            // override names the local replica's ledger (see `demo_ledger_text` above). The
            // offline fake-IC gateway keys its fake ledger at this same text, so the offline
            // loop and prod agree on where a DEMO transfer lands.
            ledger: demo_ledger_text(),
            mintable: true,
            minter: None,
            minter_family: None,
            symbol: Some("$".into()),
            decimals: Some(2),
            wrapper_name: None,
            backing_symbol: None,
            network: None,
            display_decimals: None,
            min_fraction_digits: None,
            fee: None, // DEMO fee is not part of the served row (faucet asset; fake accepts any)
            cap: Some(U64String(100_000)), // $1,000.00 — the same per-tx cap the facade registers
            chain_id: None,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Direct, // self-service faucet (fixed amount, rate-limited)
            offramp: RampCapability::Unavailable, // play money — no cash-out
            liquidity: None, // pre-EUR row — optional field unset, wire bytes unchanged
            ramp_partner: None, // no Partner off-ramp to name
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
            min_fraction_digits: None,
            fee: None, // ckBTC ledger fee read live at runtime (MC2 validates)
            cap: Some(U64String(100_000)),
            chain_id: None, // not EVM
            token_contract: None,
            gas_ledger: None,                // BTC family — no ckETH gas ledger
            onramp: RampCapability::Direct,  // chain-key Bitcoin ramp
            offramp: RampCapability::Direct, // retrieve_btc_with_approval
            liquidity: None,
            ramp_partner: None,
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
            min_fraction_digits: Some(2), // ckUSDC: unit-denominated — keep 2 decimals ('1.50', '0.00')
            fee: Some(U64String(10_000)), // ckUSDC ledger icrc1_fee (O6): 0.01 USDC = 10000 raw
            cap: Some(U64String(100_000)),
            chain_id: Some(1), // Ethereum mainnet
            token_contract: Some(CKUSDC_ERC20_ADDRESS.to_string()), // ckUSDC ERC-20 (O6) — single-sourced constant
            // The dual-ledger `withdraw_erc20` cash-out burns ckETH gas fees from THIS ledger (the
            // verified mainnet ckETH ledger) + the USDC amount from `ledger` above. The user MUST
            // hold ckETH for gas (Fork-C — dpay never converts ckUSDC→ckETH, no-swap); the app
            // surfaces an honest "You need ckETH for gas" note.
            gas_ledger: Some(CKETH_LEDGER_PRINCIPAL.to_string()),
            onramp: RampCapability::Direct, // ckETH helper-contract onramp (client-side)
            offramp: RampCapability::Direct, // dual-ledger withdraw_erc20 cash-out (ckETH gas + USDC amount)
            liquidity: None,
            ramp_partner: None,
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
            min_fraction_digits: None,
            fee: Some(U64String(2_000_000_000_000)), // the live ckETH ledger icrc1_fee (0.000002 ETH)
            cap: Some(U64String(100_000)),
            chain_id: Some(1),               // Ethereum mainnet
            token_contract: None, // None ⇒ native ETH (NOT an ERC-20) — the family discriminator
            gas_ledger: None, // native ETH — its own ledger IS the gas ledger (withdraw_eth single-ledger path)
            onramp: RampCapability::Direct, // ckETH helper `depositEth` (client-side, single payable tx)
            offramp: RampCapability::Direct, // withdraw_eth: burn ckETH → send native ETH
            liquidity: None,
            ramp_partner: None,
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
            min_fraction_digits: None,
            fee: Some(U64String(10)), // the live testnet ckBTC ledger fee
            cap: Some(U64String(100_000)),
            chain_id: None,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Direct,
            offramp: RampCapability::Direct,
            liquidity: None,
            ramp_partner: None,
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
            min_fraction_digits: Some(2), // ckSepoliaUSDC: unit-denominated — keep 2 decimals ('1.50', '0.00')
            fee: Some(U64String(4_000)),  // the live testnet ckUSDC ledger fee
            cap: Some(U64String(100_000)),
            chain_id: Some(11155111), // Sepolia
            token_contract: Some("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".into()), // testnet USDC ERC-20
            gas_ledger: None,
            onramp: RampCapability::Direct, // Sepolia CkDeposit helper (chain_id-scoped)
            offramp: RampCapability::Unavailable, // testnet ckUSDC cash-out not wired
            liquidity: None,
            ramp_partner: None,
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
            min_fraction_digits: None,
            fee: Some(U64String(10_000_000_000)), // the live testnet ckETH ledger fee
            cap: Some(U64String(100_000)),
            chain_id: Some(11155111), // Sepolia
            token_contract: None,     // None ⇒ native ETH — the family discriminator
            gas_ledger: None,
            onramp: RampCapability::Direct, // Sepolia CkDeposit `depositEth`
            offramp: RampCapability::Direct, // testnet withdraw_eth
            liquidity: None,
            ramp_partner: None,
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
            min_fraction_digits: Some(2), // VCHF: unit-denominated — keep 2 decimals ('1.50', '0.00')
            fee: Some(U64String(10_000)), // 0.0001 VCHF
            cap: Some(U64String(1_000_000_000_000)), // initial payment-policy cap: 10,000 VCHF
            chain_id: None,               // not EVM
            token_contract: None,         // not an ERC-20
            gas_ledger: None,             // no gas ledger — direct ICRC transfer pays its own fee
            onramp: RampCapability::Unavailable, // no compliant fiat rail yet — honest absence
            offramp: RampCapability::Unavailable,
            liquidity: None,
            ramp_partner: None,
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
            min_fraction_digits: None,
            fee: Some(U64String(10_000)),          // 0.0001 ICP
            cap: Some(U64String(100_000_000_000)), // initial payment-policy cap: 1,000 ICP
            chain_id: None,                        // not EVM
            token_contract: None,                  // not an ERC-20
            gas_ledger: None, // no gas ledger — direct ICRC transfer pays its own fee
            onramp: RampCapability::Unavailable, // no compliant fiat rail yet — honest absence
            offramp: RampCapability::Unavailable,
            liquidity: None,
            ramp_partner: None,
        },
        CurrencyDescriptor {
            // VEUR — VNX Euro as a complete NO-MINTER direct-ICRC asset (currency 9, appended
            // 2026-09-06 — Stage 1 of the founder-approved EUR dual-rail; the solana EURC row
            // below is the deep-liquidity half). Exactly the VCHF/ICP shape: `minter`/
            // `minter_family` null by design (NEVER a fake family — the app's isPayableAsset
            // accepts a complete trusted descriptor), payment is an app-signed `icrc1_transfer`
            // straight to the ledger. The FIRST `offramp = Partner` row: DFX runs the fiat
            // off-ramp (`ramp_partner: "DFX"`), while the on-ramp stays honestly Unavailable —
            // no compliant fiat rail in. `backing_symbol`/`symbol`/`wrapper_name` are all
            // "VEUR" (the payment unit is the ISSUER token, never "EUR" — same rule as
            // VCHF/CHF). Values are the LOCKED spec row (8 decimals, fee 10_000 raw =
            // 0.0001 VEUR, liquidity `thin`); the cap mirrors VCHF's shape at 10,000 VEUR raw
            // as the initial payment-policy value (flagged for founder confirmation).
            // Single-sourced in [`VEUR_LEDGER_PRINCIPAL`], cross-checked against
            // dfx/catalog_truth.json.
            currency: 9, // VEUR (VNX Euro, direct ICRC-1)
            ledger: VEUR_LEDGER_PRINCIPAL.to_string(),
            mintable: false,
            minter: None,
            minter_family: None,
            symbol: Some("VEUR".into()),
            decimals: Some(8),
            wrapper_name: Some("VEUR".into()),
            backing_symbol: Some("VEUR".into()), // the issuer token — NEVER "EUR"
            network: Some("Internet Computer".into()), // mainnet label — files mainnet-side via is_testnet_row
            display_decimals: Some(8),
            min_fraction_digits: Some(2), // unit-denominated — keep 2 decimals ('1.50', '0.00'), like VCHF
            fee: Some(U64String(10_000)), // 0.0001 VEUR
            cap: Some(U64String(1_000_000_000_000)), // initial payment-policy cap: 10,000 VEUR (mirrors VCHF's shape — founder to confirm)
            chain_id: None,                          // not EVM
            token_contract: None,                    // not an ERC-20
            gas_ledger: None, // no gas ledger — direct ICRC transfer pays its own fee
            onramp: RampCapability::Unavailable, // no compliant fiat on-ramp — honest absence
            offramp: RampCapability::Partner, // DFX fiat off-ramp — the first Partner row
            liquidity: Some(LiquidityTier::Thin),
            ramp_partner: Some("DFX"),
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

/// The mainnet USDC mint — mirrors `USDC_MINT_ADDRESS` (app/solana/spl.ts) verbatim; cross-checked
/// against `dfx/catalog_truth.json` is NOT done for this one (the truth file pins the EUR pair
/// only — see [`SOLANA_EURC_MINT`]).
const SOLANA_USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/// The mainnet EURC mint — `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` (Circle's native
/// EURC on solana mainnet, 6 decimals). The solana half of the EUR dual-rail (Stage 1,
/// 2026-09-06): the DEEP-liquidity EUR asset, complementing the IC-side VEUR row (thin).
/// Cross-checked against `dfx/catalog_truth.json` (`principals.eurc_mint`) by the
/// `catalog_truth_tests` module below.
const SOLANA_EURC_MINT: &str = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";

/// The solana mainnet section — a relay-level constant provider (NOT a `Ledger` thing: the rail
/// is device-key + direct RPC and never touches the IC, so it is absent from the trait and
/// `fake.rs`). Values mirror app/solana.ts exactly: SOL 9 decimals (`SOL_DECIMALS`), USDC 6
/// decimals + [`SOLANA_USDC_MINT`], and (2026-09-06, EUR dual-rail Stage 1) EURC 6 decimals +
/// [`SOLANA_EURC_MINT`] with liquidity `deep`. No RPC endpoints or API keys here — the Helius
/// URL stays APK-side.
///
/// FIAT-ramp semantics (corrected 2026-09-06 in the same change that introduced `liquidity`):
/// `onramp`/`offramp` on these rows declare FIAT ramps, not structural self-custody. The old
/// `Direct`/`Direct` values on SOL/USDC meant "you self-custody this asset on-device" — a
/// tautology for every solana row (the whole rail is device-key) that nothing reads app-side;
/// under fiat-ramp semantics the honest value for both rows is `Unavailable` (dpay wires no
/// solana fiat rail). This is the ONE deliberate wire change to a pre-existing row in the
/// 2026-09-06 catalog edit; the byte-pin tests pin the corrected bytes.
fn solana_network_section() -> NetworkBody {
    NetworkBody {
        protocol: "solana",
        name: "Solana",
        environment: "mainnet",
        assets: NetworkAssets::Solana(vec![
            SolanaAsset {
                token: "SOL",
                symbol: "SOL",
                decimals: 9,               // SOL_DECIMALS (app/solana/identity.ts)
                min_fraction_digits: None, // SOL is written trimmed ('1.5 SOL')
                mint: None,                // native L1 asset — no SPL mint
                // Fiat-ramp semantics (2026-09-06): was Direct/Direct, which described
                // structural self-custody (true of every row on this device-key rail) — no
                // solana fiat on/off-ramp is wired, so the honest FIAT answer is Unavailable.
                onramp: RampCapability::Unavailable,
                offramp: RampCapability::Unavailable,
                liquidity: None,
            },
            SolanaAsset {
                token: "USDC",
                symbol: "USDC",
                decimals: 6,                  // USDC_DECIMALS (app/solana/spl.ts)
                min_fraction_digits: Some(2), // unit-denominated, exactly like the IC ckUSDC row
                mint: Some(SOLANA_USDC_MINT),
                // Fiat-ramp semantics (2026-09-06): see the SOL row note above.
                onramp: RampCapability::Unavailable,
                offramp: RampCapability::Unavailable,
                liquidity: None,
            },
            SolanaAsset {
                // EURC — the solana half of the EUR dual-rail (Stage 1, 2026-09-06): the
                // DEEP-liquidity EUR asset (Circle's native solana EURC), complementing the
                // IC-side VEUR row. No fiat ramp through dpay — the honest Unavailable —
                // and `min_fraction_digits: 2` matches the unit-denominated policy (EURC
                // reads '1.50' like USDC/VCHF/VEUR).
                token: "EURC",
                symbol: "EURC",
                decimals: 6,
                min_fraction_digits: Some(2),
                mint: Some(SOLANA_EURC_MINT),
                onramp: RampCapability::Unavailable,
                offramp: RampCapability::Unavailable,
                liquidity: Some(LiquidityTier::Deep),
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
    let (mainnet, testnet): (Vec<_>, Vec<_>) =
        ic_rows().into_iter().partition(|d| !is_testnet_row(d));
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
/// Ramp vocabulary is shared with the IC rows (`Direct`/`Partner`/`Unavailable`) and — since
/// the 2026-09-06 fiat-ramp semantics correction — declares FIAT ramps (see
/// [`solana_network_section`]). `liquidity` is OPTIONAL on the wire (absent ⇒ no tier; the
/// pre-EUR rows serialize byte-identically modulo the documented ramp correction).
#[derive(Serialize)]
pub(crate) struct SolanaAsset {
    token: &'static str,
    symbol: &'static str,
    decimals: u8,
    /// Compact-display minimum fractional digits — the same display policy the IC rows carry
    /// (see `CurrencyDescriptor::min_fraction_digits`), so USDC reads `1.50` on BOTH rails.
    min_fraction_digits: Option<u8>,
    mint: Option<&'static str>,
    onramp: RampCapability,
    offramp: RampCapability,
    #[serde(skip_serializing_if = "Option::is_none")]
    liquidity: Option<LiquidityTier>,
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
            min_fraction_digits: None,
            fee: None,
            cap: None,
            chain_id: None,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Unavailable,
            offramp: RampCapability::Unavailable,
            liquidity: None,
            ramp_partner: None,
        }
    }

    #[test]
    fn internet_computer_rows_are_mainnet() {
        // VCHF (currency 7) and native ICP (currency 8) carry network "Internet Computer" —
        // the 2026-08-28 fix: before "Internet Computer" joined the mainnet set, both rows
        // were mis-filed testnet-side and hidden behind the wallet's testnet toggle. VEUR
        // (currency 9, EUR dual-rail Stage 1 2026-09-06) rides the same label.
        let vchf = CurrencyDescriptor {
            currency: 7,
            ..row_with_network(Some("Internet Computer"))
        };
        let icp = CurrencyDescriptor {
            currency: 8,
            ..row_with_network(Some("Internet Computer"))
        };
        let veur = CurrencyDescriptor {
            currency: 9,
            ..row_with_network(Some("Internet Computer"))
        };
        assert!(
            !is_testnet_row(&vchf),
            "VCHF (network \"Internet Computer\") is ICP MAINNET"
        );
        assert!(
            !is_testnet_row(&icp),
            "ICP (network \"Internet Computer\") is ICP MAINNET"
        );
        assert!(
            !is_testnet_row(&veur),
            "VEUR (network \"Internet Computer\") is ICP MAINNET"
        );
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
        assert_eq!(
            CKUSDC_LEDGER_PRINCIPAL,
            p["ckusdc_ledger"].as_str().unwrap()
        );
        // The ckETH ledger IS the ckERC20 gas ledger — one canister, two truth-file names.
        assert_eq!(CKETH_LEDGER_PRINCIPAL, p["cketh_ledger"].as_str().unwrap());
        assert_eq!(
            CKETH_LEDGER_PRINCIPAL,
            p["cketh_gas_ledger"].as_str().unwrap()
        );
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
        // The EUR dual-rail pair (Stage 1, 2026-09-06): IC-side VEUR ledger + solana-side
        // EURC mint — both money-defining, so both belt-and-suspenders pinned here too.
        assert_eq!(VEUR_LEDGER_PRINCIPAL, p["veur_ledger"].as_str().unwrap());
        assert_eq!(SOLANA_EURC_MINT, p["eurc_mint"].as_str().unwrap());
        assert_eq!(
            CKUSDC_ERC20_ADDRESS,
            t["erc20_contracts"]["ckusdc"].as_str().unwrap()
        );
        // The official ICP index is NOT a catalog field (no index_canister abstraction until a
        // second ledger needs one) — the CODE pin lives in agent_ledger.rs's history adapter.
        // This literal check keeps the JSON's icp_index entry honest against the spec-locked
        // value so the agent-side pin can't be fed a typo'd principal from the truth file.
        assert_eq!(
            p["icp_index"].as_str().unwrap(),
            "qhbym-qaaaa-aaaaa-aaafq-cai"
        );
    }

    #[test]
    fn ic_rows_pin_every_rows_principals_ids_and_order() {
        // The REAL-catalog pin: every IC row's ledger/minter principal matches the truth file,
        // the currency ids are exactly the durable set (0,1,2,6 mainnet-real + 3,4,5
        // testnet-real + 7,8 locked + 9 VEUR), the source order is stable, and the SERVED
        // sections come out in the documented order (mainnet 0,1,2,6,7,8,9 / testnet 3,4,5).
        let t = truth();
        let p = &t["principals"];
        let cat = ic_rows();

        // Source order + ids.
        assert_eq!(
            cat.len(),
            10,
            "10 IC rows: 4 real mainnet + 3 real testnet + VCHF + ICP + VEUR"
        );
        assert_eq!(
            cat.iter().map(|d| d.currency).collect::<Vec<_>>(),
            vec![0, 1, 2, 6, 3, 4, 5, 7, 8, 9],
            "ids stay the durable set; source order = mainnet-real, testnet-real, locked 7/8/9"
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
            (9, "veur_ledger", None),
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
        assert_eq!(
            section_ids(0),
            vec![0, 1, 2, 6, 7, 8, 9],
            "icp MAINNET section order"
        );
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
        assert_eq!(
            demo.cap,
            Some(U64String(100_000)),
            "the $1,000.00 per-tx cap"
        );
        assert_eq!(demo.chain_id, None);
        assert_eq!(demo.token_contract, None);
        assert_eq!(demo.gas_ledger, None);
        assert_eq!(demo.onramp, RampCapability::Direct);
        assert_eq!(demo.offramp, RampCapability::Unavailable);
        assert_eq!(
            demo.liquidity, None,
            "pre-EUR row — no tier (wire bytes pinned below)"
        );
        assert_eq!(demo.ramp_partner, None);

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
        assert_eq!(
            cketh.display_decimals.unwrap(),
            6,
            "prod ckETH: display 6 ≠ decimals 18"
        );
        assert_eq!(
            cketh.fee,
            Some(U64String(2_000_000_000_000)),
            "the live ckETH ledger icrc1_fee (0.000002 ETH)"
        );
        assert_eq!(cketh.cap, Some(U64String(100_000)));
        assert_eq!(cketh.chain_id, Some(1));
        assert_eq!(
            cketh.token_contract, None,
            "None ⇒ native ETH — the family discriminator"
        );
        assert_eq!(
            cketh.gas_ledger, None,
            "withdraw_eth approves on ckETH's OWN ledger"
        );
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
        assert_eq!(
            sep_usdc.chain_id,
            Some(11155111),
            "Sepolia — selects the Sepolia CkDeposit helper"
        );
        assert_eq!(
            sep_usdc.token_contract.as_deref().unwrap(),
            "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            "the testnet USDC ERC-20 (NOT the mainnet USDC address)"
        );
        assert_eq!(sep_usdc.gas_ledger, None);
        assert_eq!(sep_usdc.onramp, RampCapability::Direct);
        assert_eq!(
            sep_usdc.offramp,
            RampCapability::Unavailable,
            "testnet USDC cash-out not wired"
        );

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
        assert_eq!(
            sep_eth.token_contract, None,
            "None ⇒ native ETH on Sepolia too"
        );
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
        assert_eq!(
            cat.len(),
            10,
            "4 real mainnet + 3 real testnet + VCHF + ICP + VEUR"
        );
        assert_eq!(
            cat[7].symbol.as_deref(),
            Some("VCHF"),
            "id 7 IS the VCHF row"
        );
        assert_eq!(cat[8].symbol.as_deref(), Some("ICP"), "id 8 IS the ICP row");
        assert_eq!(
            cat[9].symbol.as_deref(),
            Some("VEUR"),
            "id 9 IS the VEUR row (full locked-shape test below)"
        );

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
        assert_eq!(
            vchf.fee,
            Some(U64String(10_000)),
            "locked: 0.0001 VCHF raw fee"
        );
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
        // Pre-EUR row: both EUR-dual-rail fields unset (byte-pinned in wire_byte_shape_tests).
        assert_eq!(vchf.liquidity, None);
        assert_eq!(vchf.ramp_partner, None);

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
        assert_eq!(
            icp.fee,
            Some(U64String(10_000)),
            "locked: 0.0001 ICP raw fee"
        );
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
        assert_eq!(icp.liquidity, None);
        assert_eq!(icp.ramp_partner, None);
    }

    #[test]
    fn ic_rows_veur_row_matches_truth_and_locked_shape() {
        // EUR dual-rail Stage 1 (2026-09-06): the VEUR (9) row cannot diverge from
        // dfx/catalog_truth.json (principal, decimals) nor from the LOCKED spec record (fee,
        // cap, units, network, no-minter shape, Partner off-ramp + named DFX partner, thin
        // liquidity). Same drift-alarm contract as the VCHF/ICP test above — a drifted field
        // breaks either the cold-start fallback the wallet renders offline or the exact-ledger
        // transfer target.
        let t = truth();
        let cat = ic_rows();

        // --- ORDER + currency ID: VEUR is id 9, appended LAST (after VCHF/ICP). The spec
        // locks 9 in BOTH compiled catalogs (this module + the app's BUNDLED_NETWORKS).
        assert_eq!(
            cat.len(),
            10,
            "4 real mainnet + 3 real testnet + VCHF + ICP + VEUR"
        );
        assert_eq!(
            cat[9].symbol.as_deref(),
            Some("VEUR"),
            "id 9 IS the VEUR row"
        );

        // --- VEUR (currency 9): every locked facet.
        let veur = catalog_currency(&cat, 9);
        assert_eq!(
            veur.ledger.as_str(),
            t["principals"]["veur_ledger"].as_str().unwrap(),
            "VEUR ledger principal == catalog_truth veur_ledger"
        );
        assert_eq!(veur.ledger.as_str(), VEUR_LEDGER_PRINCIPAL);
        assert_eq!(
            veur.decimals.unwrap(),
            t["decimals"]["veur"].as_u64().unwrap() as u8,
            "VEUR decimals == catalog_truth decimals.veur"
        );
        assert_eq!(
            veur.display_decimals.unwrap(),
            t["decimals"]["veur"].as_u64().unwrap() as u8
        );
        assert_eq!(
            veur.fee,
            Some(U64String(10_000)),
            "locked: 0.0001 VEUR raw fee"
        );
        assert_eq!(
            veur.cap,
            Some(U64String(1_000_000_000_000)),
            "locked: 10,000 VEUR initial cap (mirrors VCHF's shape — founder to confirm)"
        );
        assert_eq!(veur.wrapper_name.as_deref(), Some("VEUR"));
        assert_eq!(
            veur.backing_symbol.as_deref(),
            Some("VEUR"),
            "payment unit is VEUR (the issuer token), deliberately NOT EUR — same rule as VCHF/CHF"
        );
        assert_eq!(veur.symbol.as_deref(), Some("VEUR"));
        assert_eq!(
            veur.network.as_deref(),
            Some("Internet Computer"),
            "the mainnet label — anything else mis-files the row testnet-side"
        );
        // No-minter shape — NEVER a fake family (the rejected payability-gate shortcut).
        assert!(!veur.mintable);
        assert_eq!(veur.minter, None);
        assert_eq!(veur.minter_family, None);
        // The FIRST Partner row: no compliant fiat on-ramp (honest absence), DFX fiat
        // off-ramp — named, so "Partner" never renders as an anonymous claim.
        assert_eq!(veur.onramp, RampCapability::Unavailable);
        assert_eq!(veur.offramp, RampCapability::Partner);
        assert_eq!(veur.liquidity, Some(LiquidityTier::Thin));
        assert_eq!(veur.ramp_partner, Some("DFX"));
        assert_eq!(
            veur.min_fraction_digits,
            Some(2),
            "unit-denominated — keep 2 decimals ('1.50', '0.00'), like VCHF"
        );
        // Not an EVM asset: all three chain fields null.
        assert_eq!(veur.chain_id, None);
        assert_eq!(veur.token_contract, None);
        assert_eq!(veur.gas_ledger, None);
    }

    /// The compact-display floor, pinned per row. Exactly the unit-denominated tokens people
    /// count like money carry `Some(2)` (ckUSDC, ckSepoliaUSDC, VCHF → `1.50`, `0.00`); every
    /// other row is unset ⇒ 0, i.e. written trimmed (`1.5 ICP`, `0 BTC`). This is display policy
    /// and never touches a raw amount, but a silent flip changes every balance the wallet
    /// renders, so it is pinned like the rest of the row shape.
    #[test]
    fn ic_rows_min_fraction_digits_locked() {
        let cat = ic_rows();
        let got: Vec<(Currency, Option<u8>)> = cat
            .iter()
            .map(|d| (d.currency, d.min_fraction_digits))
            .collect();
        assert_eq!(
            got,
            vec![
                (DEMO_USD, None), // DEMO renders through the app's `usd()` ∂ formatter, not this
                (1, None),        // ckBTC
                (2, Some(2)),     // ckUSDC
                (6, None),        // ckETH
                (3, None),        // ckTESTBTC
                (4, Some(2)),     // ckSepoliaUSDC
                (5, None),        // ckSepoliaETH
                (7, Some(2)),     // VCHF
                (8, None),        // ICP
                (9, Some(2)),     // VEUR — unit-denominated, like VCHF
            ]
        );
        // A floor above the display cap would ask the formatter for digits it may not show.
        for d in &cat {
            let cap = d.display_decimals.or(d.decimals).unwrap_or(0);
            assert!(
                d.min_fraction_digits.unwrap_or(0) <= cap,
                "currency {}: min_fraction_digits must be ≤ the display cap",
                d.currency
            );
        }
    }

    /// The Solana rail carries the SAME display policy as the IC rows — USDC reads `1.50` on
    /// both rails, SOL trimmed. Pinned so the two rails cannot drift into rendering one asset
    /// two ways (CLAUDE.md: every currency goes through the same UI surfaces).
    #[test]
    fn solana_rows_min_fraction_digits_match_the_ic_policy() {
        let NetworkAssets::Solana(rows) = solana_network_section().assets else {
            panic!("the solana section must carry Solana rows");
        };
        let got: Vec<(&str, Option<u8>)> = rows
            .iter()
            .map(|r| (r.token, r.min_fraction_digits))
            .collect();
        assert_eq!(
            got,
            vec![("SOL", None), ("USDC", Some(2)), ("EURC", Some(2))]
        );
    }

    /// The solana section's EUR row (EUR dual-rail Stage 1, 2026-09-06) — the DEEP-liquidity
    /// half of the EUR pair, complementing the IC-side VEUR (thin). Truth-file mint/decimals
    /// pins + locked shape.
    #[test]
    fn solana_eurc_row_matches_truth_and_locked_shape() {
        let t = truth();
        let NetworkAssets::Solana(rows) = solana_network_section().assets else {
            panic!("the solana section must carry Solana rows");
        };
        assert_eq!(rows.len(), 3, "SOL + USDC + EURC");
        let eurc = rows.iter().find(|r| r.token == "EURC").unwrap();
        assert_eq!(
            eurc.mint.as_deref().unwrap(),
            t["principals"]["eurc_mint"].as_str().unwrap(),
            "EURC mint == catalog_truth eurc_mint"
        );
        assert_eq!(
            eurc.decimals,
            t["decimals"]["eurc"].as_u64().unwrap() as u8,
            "EURC decimals == catalog_truth decimals.eurc"
        );
        assert_eq!(eurc.symbol, "EURC");
        assert_eq!(
            eurc.min_fraction_digits,
            Some(2),
            "unit-denominated: '1.50'"
        );
        assert_eq!(eurc.liquidity, Some(LiquidityTier::Deep));
        assert_eq!(eurc.onramp, RampCapability::Unavailable);
        assert_eq!(eurc.offramp, RampCapability::Unavailable);
        // The pre-EUR rows carry no tier — the optional field stays unset for them.
        for r in rows.iter().filter(|r| r.token != "EURC") {
            assert_eq!(r.liquidity, None, "{} carries no liquidity tier", r.token);
        }
    }

    /// The 2026-09-06 fiat-ramp semantics correction: the solana `onramp`/`offramp` fields
    /// declare FIAT ramps now; SOL/USDC honestly read `Unavailable` (dpay wires no solana
    /// fiat rail — the old `Direct` described structural self-custody, a tautology on this
    /// device-key rail that nothing read app-side).
    #[test]
    fn solana_rows_declare_no_fiat_ramps() {
        let NetworkAssets::Solana(rows) = solana_network_section().assets else {
            panic!("the solana section must carry Solana rows");
        };
        for r in &rows {
            assert_eq!(r.onramp, RampCapability::Unavailable, "{} onramp", r.token);
            assert_eq!(
                r.offramp,
                RampCapability::Unavailable,
                "{} offramp",
                r.token
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Wire byte-shape pins (EUR dual-rail Stage 1, 2026-09-06). The new optional
// fields (`CurrencyDescriptor::liquidity`/`ramp_partner`, `SolanaAsset::liquidity`) are
// `Option` + `skip_serializing_if`, so every row that leaves them unset must serialize
// BYTE-IDENTICALLY to the pre-2026-09-06 wire — the wallet + e2e depend on the frozen
// shape. These tests pin the exact JSON bytes of representative old rows (unchanged) and
// the two new EUR rows (the new shape), so ANY serializer regression (field reorder, new
// key, casing) goes RED before it reaches a route test.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod wire_byte_shape_tests {
    use super::*;

    fn row_json(currency: u32) -> String {
        serde_json::to_string(ic_rows().iter().find(|d| d.currency == currency).unwrap()).unwrap()
    }

    #[test]
    fn pre_eur_ic_rows_serialize_byte_identically() {
        // ckBTC (1) and VCHF (7) — one minted ramp row, one direct-ICRC row: both end at
        // "offramp" with NO liquidity/ramp_partner keys. These literals are the pre-2026-09-06
        // wire bytes; the exact-string pins catch ANY shape drift, not just the new keys.
        let ckbtc = row_json(1);
        assert_eq!(
            ckbtc,
            "{\"currency\":1,\"ledger\":\"mxzaz-hqaaa-aaaar-qaada-cai\",\"mintable\":false,\"minter\":\"mqygn-kiaaa-aaaar-qaadq-cai\",\"minter_family\":\"CkBtcUtxo\",\"symbol\":\"₿\",\"decimals\":8,\"wrapper_name\":\"ckBTC\",\"backing_symbol\":\"BTC\",\"network\":\"Bitcoin\",\"display_decimals\":8,\"min_fraction_digits\":null,\"fee\":null,\"cap\":\"100000\",\"chain_id\":null,\"token_contract\":null,\"gas_ledger\":null,\"onramp\":\"Direct\",\"offramp\":\"Direct\"}"
        );
        let vchf = row_json(7);
        assert_eq!(
            vchf,
            "{\"currency\":7,\"ledger\":\"ly36x-wiaaa-aaaai-aqj7q-cai\",\"mintable\":false,\"minter\":null,\"minter_family\":null,\"symbol\":\"VCHF\",\"decimals\":8,\"wrapper_name\":\"VCHF\",\"backing_symbol\":\"VCHF\",\"network\":\"Internet Computer\",\"display_decimals\":8,\"min_fraction_digits\":2,\"fee\":\"10000\",\"cap\":\"1000000000000\",\"chain_id\":null,\"token_contract\":null,\"gas_ledger\":null,\"onramp\":\"Unavailable\",\"offramp\":\"Unavailable\"}"
        );
        // Belt-and-suspenders: EVERY pre-EUR IC row (0,1,2,6,3,4,5,7,8) omits both keys.
        for cid in [0, 1, 2, 6, 3, 4, 5, 7, 8] {
            let j = row_json(cid);
            assert!(
                !j.contains("\"liquidity\""),
                "currency {cid} must not carry liquidity"
            );
            assert!(
                !j.contains("\"ramp_partner\""),
                "currency {cid} must not carry ramp_partner"
            );
        }
    }

    #[test]
    fn veur_row_serializes_with_the_new_optional_fields() {
        // The LOCKED new-row wire shape: liquidity AFTER offramp (appended last), lowercase
        // tier, ramp_partner naming the Partner.
        let veur = row_json(9);
        assert_eq!(
            veur,
            "{\"currency\":9,\"ledger\":\"wu6g4-6qaaa-aaaan-qmrza-cai\",\"mintable\":false,\"minter\":null,\"minter_family\":null,\"symbol\":\"VEUR\",\"decimals\":8,\"wrapper_name\":\"VEUR\",\"backing_symbol\":\"VEUR\",\"network\":\"Internet Computer\",\"display_decimals\":8,\"min_fraction_digits\":2,\"fee\":\"10000\",\"cap\":\"1000000000000\",\"chain_id\":null,\"token_contract\":null,\"gas_ledger\":null,\"onramp\":\"Unavailable\",\"offramp\":\"Partner\",\"liquidity\":\"thin\",\"ramp_partner\":\"DFX\"}"
        );
    }

    #[test]
    fn solana_rows_wire_byte_shape() {
        // SOL/USDC: the ONE deliberate pre-EUR wire change — onramp/offramp went
        // Direct→Unavailable (fiat-ramp semantics, documented at solana_network_section) —
        // with NO liquidity key appended. EURC carries liquidity:"deep" as its last key.
        let NetworkAssets::Solana(rows) = solana_network_section().assets else {
            panic!("the solana section must carry Solana rows");
        };
        let sol = serde_json::to_string(&rows[0]).unwrap();
        assert_eq!(
            sol,
            "{\"token\":\"SOL\",\"symbol\":\"SOL\",\"decimals\":9,\"min_fraction_digits\":null,\"mint\":null,\"onramp\":\"Unavailable\",\"offramp\":\"Unavailable\"}"
        );
        let usdc = serde_json::to_string(&rows[1]).unwrap();
        assert_eq!(
            usdc,
            "{\"token\":\"USDC\",\"symbol\":\"USDC\",\"decimals\":6,\"min_fraction_digits\":2,\"mint\":\"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\",\"onramp\":\"Unavailable\",\"offramp\":\"Unavailable\"}"
        );
        let eurc = serde_json::to_string(&rows[2]).unwrap();
        assert_eq!(
            eurc,
            "{\"token\":\"EURC\",\"symbol\":\"EURC\",\"decimals\":6,\"min_fraction_digits\":2,\"mint\":\"HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr\",\"onramp\":\"Unavailable\",\"offramp\":\"Unavailable\",\"liquidity\":\"deep\"}"
        );
    }
}

// ---------------------------------------------------------------------------
// Venue-registry drift alarm (generalized 2026-09-10 from the 2026-09-08 single-pool alarm).
// The relay's venue registry (`venues()` above) is pinned field-for-field against
// `dfx/catalog_truth.json` `venues[]`, and every ic_amm fixture seed is pinned against what the
// offline fake-IC gateway is ACTUALLY seeded with — for the real venue the seed order was
// MEASURED off the live pool (2026-09-08; a guessed seed once agreed with the code while both
// disagreed with the venue, hiding a ~5.9×-wrong live rate behind a green suite). The live half
// is `just swap-venue-probe` (`crates/dpay-relay/tests/swap_venue_mainnet.rs`) — the only thing
// that can see a REAL venue change, since `just test-live` is PocketIC and has no ICPSwap pool
// in it. Fixture-only venues are pinned as fixture-truth and never probed.
//
// The compiled-vs-truth half is plain `#[cfg(test)]` (2026-09-11): it reads only the registry
// (compiled in every build — see `venues()`), so the alarm runs under every feature
// combination, a bare no-features `cargo test -p dpay-relay` included. It used to sit inside
// `cfg(all(test, feature = "test-helpers"))` alongside the seeding tests, tying its existence
// to a feature it never reads; nothing was skipped in practice only because the crate's self
// dev-dependency unifies `test-helpers` onto every test target — an accident of the dev-dep
// graph, not a guarantee. Only the genuinely FakeIc-dependent seeding half stays gated
// (`venue_fixture_seed_tests`).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod venue_truth_tests {
    use super::*;

    use serde_json::Value;

    const CATALOG_TRUTH: &str = include_str!("../../../dfx/catalog_truth.json");

    fn venues_truth() -> Vec<Value> {
        serde_json::from_str::<Value>(CATALOG_TRUTH)
            .expect("dfx/catalog_truth.json must be valid JSON")["venues"]
            .as_array()
            .expect("catalog_truth.venues is an array")
            .clone()
    }

    #[test]
    fn compiled_registry_matches_the_truth_file_field_for_field() {
        let truth = venues_truth();
        let compiled = venues();
        assert_eq!(
            compiled.len(),
            truth.len(),
            "the compiled venue registry and catalog_truth.venues carry the same venues"
        );
        for (v, t) in compiled.iter().zip(&truth) {
            assert_eq!(v.venue_id, t["venue_id"].as_str().unwrap());
            assert_eq!(v.display_name, t["display_name"].as_str().unwrap());
            assert_eq!(
                v.endpoint,
                t["endpoint"].as_str().unwrap(),
                "{} endpoint must equal the truth file",
                v.venue_id
            );
            assert_eq!(v.testnet, t["testnet"].as_bool().unwrap());
            assert_eq!(v.disclosure_key, t["disclosure_key"].as_str().unwrap());
            // kind: an extensible string enum on the wire — every value the relay knows parses,
            // and an unknown value would fail this parse (schema-break tripwire).
            let kind = t["kind"].as_str().unwrap();
            let expected_kind = match kind {
                "ic_amm" => VenueKind::IcAmm,
                "cefi" => VenueKind::Cefi,
                other => panic!("unknown venue kind in the truth file: {other}"),
            };
            assert_eq!(v.kind, expected_kind);
            // The pair is an UNORDERED set: sort both sides before comparing, so neither the
            // truth file nor the registry can smuggle an ORDER back in unnoticed.
            let mut truth_pair: Vec<&str> = t["pair_ledgers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap())
                .collect();
            truth_pair.sort_unstable();
            let mut compiled_pair = v.pair_ledgers.to_vec();
            compiled_pair.sort_unstable();
            assert_eq!(
                compiled_pair, truth_pair,
                "{} pair must equal the truth file as an unordered set",
                v.venue_id
            );
            assert_eq!(
                v.test_helpers_served,
                t.get("test_helpers_served").is_some_and(|f| f.as_bool().unwrap()),
                "{} test_helpers_served marker must match the truth file",
                v.venue_id
            );
            // Fixture seeds pin pair order + fee only (reserves are the curve simulation, a
            // code choice). For the REAL venue this is the MEASURED block; see
            // `venue_fixture_seed_tests` below for the fake-gateway half.
            if let Some(f) = &v.fixture {
                let tf = &t["fixture"];
                assert_eq!(f.token0_ledger, tf["token0_ledger"].as_str().unwrap());
                assert_eq!(f.token1_ledger, tf["token1_ledger"].as_str().unwrap());
                assert_eq!(
                    f.fee_millionths,
                    u128::from(tf["fee_millionths"].as_u64().unwrap())
                );
            }
        }
    }

    #[test]
    fn allowlist_generalizes_to_ic_amm_endpoints_and_gates_fixture_pools() {
        // The PoC venue resolves; a ledger principal and garbage resolve to nothing (the quote
        // route's "unknown_pool" refusal — `venue_of_endpoint` IS the allowlist).
        assert!(venue_of_endpoint("65mrh-fqaaa-aaaar-qapoa-cai").is_some());
        assert!(venue_of_endpoint(ICP_LEDGER_PRINCIPAL).is_none());
        assert!(venue_of_endpoint("").is_none());
        // Under test-helpers WITHOUT agent the fixture pool IS quotable — the offline loop is
        // its only reason to exist — and resolves for quote attribution. Under the AGENT
        // feature the production gate inside `venue_of_endpoint` correctly refuses it (fixture
        // venues must never resolve where a live replica could be asked of an invented
        // principal), so the assertion branches on the feature: Some in the offline build,
        // None under `just test-live`.
        if cfg!(feature = "agent") {
            assert!(venue_of_endpoint("6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7").is_none());
        } else {
            assert!(venue_of_endpoint("6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7").is_some());
            assert_eq!(
                venue_of_endpoint("6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7")
                    .expect("fixture venue resolves")
                    .venue_id,
                "icpswap-fixture-b"
            );
        }
        assert_eq!(
            venue_of_endpoint("65mrh-fqaaa-aaaar-qapoa-cai")
                .expect("the PoC venue resolves")
                .venue_id,
            "icpswap"
        );
        assert!(venue_of_endpoint(ICP_LEDGER_PRINCIPAL).is_none());
        // The invented principal must PARSE — the fake gateway and the relay tests key pools by
        // principal text, and a typo'd fixture id would fail far from its cause.
        dpay_icp::principal::Principal::from_text("6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7")
            .expect("the fixture-only venue's invented principal parses");
        // SERVED-by-default (the knob un-armed — the agent build's permanent state, and every
        // build's state before a test opts in): never a fixture venue.
        let served: Vec<_> = venues()
            .into_iter()
            .filter(|v| venue_servable(v, false))
            .collect();
        assert_eq!(served.len(), 1, "exactly one real venue is served today");
        assert_eq!(served[0].venue_id, "icpswap");
        assert!(served.iter().all(|v| !v.test_helpers_served));
    }

    /// THE AGENT-BUILD ALARM (multi-venue readiness V5): the invented fixture venue can never
    /// be served by the production image. The agent build compiles the `/test/venue` knob, the
    /// `FakeIc` behind it, and the `test-helpers` half of [`venue_servable`] OUT, so the value
    /// it always computes is `venue_servable(v, false)` — pinned here directly. The knob-armed
    /// half is asserted against THIS build's cfg so the test is honest under any feature set.
    #[test]
    fn fixture_venue_is_never_servable_in_the_agent_build_or_without_the_knob() {
        let fixture = venues()
            .into_iter()
            .find(|v| v.venue_id == "icpswap-fixture-b")
            .expect("the fixture venue is registered");
        let real = venues()
            .into_iter()
            .find(|v| v.venue_id == "icpswap")
            .expect("the PoC venue is registered");
        // The agent/prod build's permanent state (it has no knob to arm):
        assert!(
            !venue_servable(&fixture, false),
            "an invented venue is never served with the knob un-armed — the agent build's only state"
        );
        // Real venues never depend on the knob:
        assert!(venue_servable(&real, false));
        assert!(venue_servable(&real, true));
        // The knob only matters in the offline test build — under `agent` (incl. the
        // agent+test-helpers live-test config) even an armed knob must serve nothing, because
        // the route that consults it is compiled away there.
        assert_eq!(
            venue_servable(&fixture, true),
            cfg!(all(feature = "test-helpers", not(feature = "agent"))),
            "an armed knob serves the fixture venue ONLY in the offline test build"
        );
    }

    /// V9 INVARIANT 1 (catalog half, hostile-principal fixtures): a dpay-OWNED canister
    /// principal may never resolve as a conversion venue — neither through the allowlist
    /// ([`venue_of_endpoint`]) nor by sitting in the registry as some future venue's endpoint.
    /// The route-half twin is `swap_quote_refuses_dpay_owned_principals_as_pools`
    /// (tests/relay.rs); the phone-side signing-boundary twin is `app/config/venues.ts`
    /// `DPAY_CANISTER_PRINCIPALS` (checked by `app/__tests__/venueInvariants.test.ts`). All
    /// three lists mirror `canister_ids.json`.
    #[test]
    fn dpay_owned_principals_never_resolve_as_venues() {
        // `canister_ids.json` `dpay_canister.ic` — the facade (dormant for the value rail, but
        // dpay-owned all the same). Pinned as a literal so a redeployed facade id moves THIS
        // alarm, not a silent allowlist hole.
        const DPAY_FACADE_PRINCIPAL: &str = "ssqti-wiaaa-aaaab-qhdia-cai";
        let hostile: [&str; 2] = [DPAY_FACADE_PRINCIPAL, DEMO_LEDGER_PRINCIPAL];
        for p in hostile {
            assert!(
                venue_of_endpoint(p).is_none(),
                "a dpay-owned principal ({p}) must never resolve as a venue endpoint"
            );
        }
        for v in venues() {
            assert!(
                !hostile.contains(&v.endpoint),
                "{}: the registry itself must never name a dpay-owned principal as an endpoint",
                v.venue_id
            );
        }
    }
}

/// The fake-IC half of the venue-registry alarm: what the offline gateway is ACTUALLY seeded
/// with, vs the pins `venue_truth_tests` above checks against the truth file. This is the only
/// genuinely `test-helpers`-dependent half (it constructs `FakeIc`), so it alone stays
/// feature-gated — the compiled-vs-truth alarm must run under every feature combination.
#[cfg(all(test, feature = "test-helpers"))]
mod venue_fixture_seed_tests {
    use super::*;

    #[test]
    fn every_ic_amm_fixture_pool_is_seeded_exactly_as_pinned() {
        // The fake-IC gateway must hold a pool for EVERY ic_amm venue with a fixture seed, in
        // exactly the pinned pair order + fee tier — per pool, not globally: two venues on one
        // pair with different orders is the whole point of the second fixture pool.
        let fake = crate::ic_gateway::FakeIc::from_catalog();
        for v in venues().iter().filter(|v| v.kind == VenueKind::IcAmm) {
            let Some(seed) = &v.fixture else {
                continue;
            };
            let meta = fake
                .swap_pool_metadata(v.endpoint)
                .unwrap_or_else(|| panic!("{}: the fake gateway must seed its fixture pool", v.venue_id));
            assert_eq!(
                meta.token0_ledger, seed.token0_ledger,
                "{}: the offline stub's token0 must be the pinned seed order",
                v.venue_id
            );
            assert_eq!(
                meta.token1_ledger, seed.token1_ledger,
                "{}: the offline stub's token1 must be the pinned seed order",
                v.venue_id
            );
            assert_eq!(
                meta.fee_millionths, seed.fee_millionths,
                "{}: the offline stub's fee tier must be the pinned tier",
                v.venue_id
            );
        }
        // And the REAL venue's measured order, named in assets so the alarm says WHICH side
        // moved (token0 = VCHF, token1 = ICP — the reverse of the 2026-09-07 pin).
        let meta = fake
            .swap_pool_metadata("65mrh-fqaaa-aaaar-qapoa-cai")
            .expect("the PoC venue's stub pool is seeded");
        assert_eq!(meta.token0_ledger, VCHF_LEDGER_PRINCIPAL);
        assert_eq!(meta.token1_ledger, ICP_LEDGER_PRINCIPAL);
        // The fixture pool deliberately REVERSES it — one global pin could not satisfy both.
        let b = fake
            .swap_pool_metadata("6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7")
            .expect("the fixture-B stub pool is seeded");
        assert_eq!(b.token0_ledger, ICP_LEDGER_PRINCIPAL);
        assert_eq!(b.token1_ledger, VCHF_LEDGER_PRINCIPAL);
        assert_ne!(
            b.fee_millionths,
            meta.fee_millionths,
            "the second fixture pool must differ from the PoC stub (fee tier)"
        );
    }
}
