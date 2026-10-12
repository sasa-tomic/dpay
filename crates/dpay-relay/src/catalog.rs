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

/// A conversion venue's kind. Extensible by construction: a later Solana venue kind is a new
/// variant (or a string on the wire), never a schema break — `cefi` (SideShift, 2026-09-15:
/// founder decision 3's relay-held partner-key pattern, `crate::sideshift`) is deliberately
/// NOT an IC-pool shape (the `Ledger` trait takes no CeFi method).
/// `solana_amm` (2026-09-15, Jupiter —
/// multi-venue readiness V11) is likewise NOT an IC-pool shape: its quote and swap round-trip
/// through the relay's Jupiter proxy since 2026-09-16 (never the relay's `/api/v1/swap_quote`,
/// never an IC update), its `endpoint` is an https origin kept as the venue's IDENTITY and
/// attribution (no longer a device dial target), and its `pair_ledgers` are
/// Solana MINTS. `venue_of_endpoint` — the IC quote allowlist — stays `IcAmm`-only: a
/// solana_amm or cefi row must never resolve as a pool there, and the fake-IC seeding skips
/// them both.
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VenueKind {
    /// An on-chain IC AMM pool the user's device signs against (ICPSwap today).
    IcAmm,
    /// A centralized exchange integration. The FIRST cefi row (SideShift,
    /// 2026-09-15) runs through the relay-held partner-key pattern
    /// (`crate::sideshift`): quotes and order creation are proxied by the relay —
    /// which attaches the partner credentials the device never sees — while the
    /// venue's own keyless surfaces (shift status) stay device-direct. `endpoint`
    /// is an https API base, `pair_ledgers` are RAIL-CANONIAL ids (IC principal,
    /// Solana mint), and `fixture` is None (non-ic_amm rule).
    Cefi,
    /// A Solana on-chain aggregator (Jupiter today): since 2026-09-16 the quote and the
    /// unsigned-transaction build are proxied by the relay (`crate::jupiter`, byte-faithful,
    /// short-TTL quote cache); the returned unsigned transaction is still verified (fee
    /// payer = the user) and signed on-device, then submitted through the same Solana
    /// JSON-RPC proxy path SOL payments use. `fixture` is None for this kind — the offline
    /// stand-in is the relay's own test stub upstream (DPAY_JUPITER_API_BASE), not in the
    /// fake-IC gateway.
    #[allow(dead_code)]
    SolanaAmm,
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
        VenueEntry {
            // The pair-scoped ICPSwap ICP/ckUSDC 0.3% pool (registered 2026-09-15). Same venue
            // family and counterparty-contract family as the PoC row — its own pool canister,
            // its own pair. MEASURED off the live pool's own `metadata` 2026-09-15: token0 =
            // ICP, token1 = ckUSDC, fee 3000 (the pool's order is a live fact; the fixture
            // seed below merely pins the offline fake to the measured order).
            venue_id: "icpswap-ckusdc",
            display_name: "ICPSwap",
            kind: VenueKind::IcAmm,
            endpoint: "mohjv-bqaaa-aaaag-qjyia-cai",
            pair_ledgers: [ICP_LEDGER_PRINCIPAL, CKUSDC_LEDGER_PRINCIPAL],
            testnet: false,
            disclosure_key: "icpswap",
            test_helpers_served: false,
            fixture: Some(FixtureSeed {
                token0_ledger: ICP_LEDGER_PRINCIPAL,
                token1_ledger: CKUSDC_LEDGER_PRINCIPAL,
                fee_millionths: 3000,
                // Live-measured getTokenAmountState raws 2026-09-15 (raw ledger units per each
                // token's OWN decimals — "e8s" is the field name, not a claim): ~9.2k ICP /
                // ~392k ckUSDC. Deep enough that probe-size swaps barely move the fake curve.
                reserve0_e8s: 9_236_229_557_363,
                reserve1_e8s: 392_104_897_975,
            }),
        },
        VenueEntry {
            // The pair-scoped ICPSwap ICP/ckETH 0.3% pool (registered 2026-09-15). MEASURED off
            // the live pool's own `metadata` 2026-09-15: token0 = ICP, token1 = ckETH, fee 3000.
            venue_id: "icpswap-cketh",
            display_name: "ICPSwap",
            kind: VenueKind::IcAmm,
            endpoint: "angxa-baaaa-aaaag-qcvnq-cai",
            pair_ledgers: [ICP_LEDGER_PRINCIPAL, CKETH_LEDGER_PRINCIPAL],
            testnet: false,
            disclosure_key: "icpswap",
            test_helpers_served: false,
            fixture: Some(FixtureSeed {
                token0_ledger: ICP_LEDGER_PRINCIPAL,
                token1_ledger: CKETH_LEDGER_PRINCIPAL,
                fee_millionths: 3000,
                // Live-measured getTokenAmountState raws 2026-09-15, in each token's own
                // units: ~11.3k ICP / ~5.16e18 raw ckETH (≈5.16 ckETH at 18 decimals).
                reserve0_e8s: 1_131_191_262_612,
                reserve1_e8s: 5_162_709_386_182_754_830,
            }),
        },
        VenueEntry {
            // The pair-scoped ICPSwap ckBTC/ICP 0.3% pool (registered 2026-09-16, coverage
            // expansion — docs/specs/2026-09-16-convert-coverage-expansion.md §1; the
            // 2026-09-14 "thin, stay out" verdict is superseded by measured depth — the
            // deepest ckBTC pool in the factory, the doc's own re-registration condition).
            // MEASURED off the live pool's own `metadata` 2026-09-16: token0 = ckBTC,
            // token1 = ICP, fee 3000.
            venue_id: "icpswap-ckbtc",
            display_name: "ICPSwap",
            kind: VenueKind::IcAmm,
            endpoint: "xmiu5-jqaaa-aaaag-qbz7q-cai",
            pair_ledgers: [CKBTC_LEDGER_PRINCIPAL, ICP_LEDGER_PRINCIPAL],
            testnet: false,
            disclosure_key: "icpswap",
            test_helpers_served: false,
            fixture: Some(FixtureSeed {
                token0_ledger: CKBTC_LEDGER_PRINCIPAL,
                token1_ledger: ICP_LEDGER_PRINCIPAL,
                fee_millionths: 3000,
                // Curve approximation from the measured reserves 2026-09-16, in each token's
                // own units: 1.11 ckBTC / 50,980 ICP — deep enough that probe-size swaps
                // barely move the fake curve.
                reserve0_e8s: 111_000_000,
                reserve1_e8s: 5_098_000_000_000,
            }),
        },
        VenueEntry {
            // The pair-scoped ICPSwap ckBTC/ckETH 0.3% pool (registered 2026-09-16, coverage
            // expansion §1). MEASURED off the live pool's own `metadata` 2026-09-16: token0 =
            // ckBTC, token1 = ckETH, fee 3000 — real depth, market-aligned price.
            venue_id: "icpswap-ckbtc-cketh",
            display_name: "ICPSwap",
            kind: VenueKind::IcAmm,
            endpoint: "akhru-myaaa-aaaag-qcvna-cai",
            pair_ledgers: [CKBTC_LEDGER_PRINCIPAL, CKETH_LEDGER_PRINCIPAL],
            testnet: false,
            disclosure_key: "icpswap",
            test_helpers_served: false,
            fixture: Some(FixtureSeed {
                token0_ledger: CKBTC_LEDGER_PRINCIPAL,
                token1_ledger: CKETH_LEDGER_PRINCIPAL,
                fee_millionths: 3000,
                // Curve approximation from the measured reserves 2026-09-16, in each token's
                // own units: 1.15 ckBTC / 24.63 ckETH.
                reserve0_e8s: 115_000_000,
                reserve1_e8s: 24_630_000_000_000_000_000,
            }),
        },
        VenueEntry {
            // The pair-scoped ICPSwap VCHF/ckUSDC 0.3% pool (registered 2026-09-16, coverage
            // expansion §1) — the CHF→USD direct pair. Thin but real: the quote is verbatim,
            // so a thin market discloses itself in its own numbers. MEASURED off the live
            // pool's own `metadata` 2026-09-16: token0 = VCHF, token1 = ckUSDC, fee 3000.
            venue_id: "icpswap-vchf-ckusdc",
            display_name: "ICPSwap",
            kind: VenueKind::IcAmm,
            endpoint: "hx7nb-diaaa-aaaar-qbxsa-cai",
            pair_ledgers: [VCHF_LEDGER_PRINCIPAL, CKUSDC_LEDGER_PRINCIPAL],
            testnet: false,
            disclosure_key: "icpswap",
            test_helpers_served: false,
            fixture: Some(FixtureSeed {
                token0_ledger: VCHF_LEDGER_PRINCIPAL,
                token1_ledger: CKUSDC_LEDGER_PRINCIPAL,
                fee_millionths: 3000,
                // Curve approximation from the measured reserves 2026-09-16, in each token's
                // own units: 1,430.93 VCHF / 505.32 ckUSDC.
                reserve0_e8s: 143_093_000_000,
                reserve1_e8s: 505_320_000,
            }),
        },
        VenueEntry {
            // The FIRST Solana venue (registered 2026-09-15, multi-venue readiness V11): Jupiter,
            // the on-chain aggregator. Since 2026-09-16 the quote and the swap-tx build are
            // PROXIED by the relay (`crate::jupiter`: a byte-faithful pipe with a short-TTL
            // canonical-params cache on quotes, never caching the swap POST), while the swap is
            // still Jupiter's serialized UNSIGNED transaction, verified (fee payer = the user)
            // and signed on-device, then submitted through the same Solana JSON-RPC proxy
            // path SOL payments use. The relay's role beyond the proxy is REGISTRY ONLY: it
            // serves the row in `/api/v1/venues` (kind solana_amm). `endpoint` is an https
            // ORIGIN kept as the venue's identity/attribution (it renders in the pool line),
            // not a dial target since the proxy; `pair_ledgers` are Solana MINTS (wrapped
            // SOL + USDC — identifier semantics documented in dfx/catalog_truth.json
            // venues[] _doc). `fixture` is None: fixtures are the ic_amm offline-fake-IC
            // seeding and are ic_amm-only by rule; the offline Jupiter stand-in is the
            // relay's own test stub upstream (DPAY_JUPITER_API_BASE).
            venue_id: "jupiter",
            display_name: "Jupiter",
            kind: VenueKind::SolanaAmm,
            endpoint: "https://lite-api.jup.ag",
            pair_ledgers: [WRAPPED_SOL_MINT, SOLANA_USDC_MINT],
            testnet: false,
            disclosure_key: "jupiter",
            test_helpers_served: false,
            fixture: None,
        },
        VenueEntry {
            // The SECOND Solana venue (registered 2026-09-16, coverage expansion §1): the same
            // Jupiter aggregator family, on the rail-local pair SOL ↔ EURC. Everything the
            // jupiter row comment above says holds verbatim (relay-proxied dials, https
            // origin endpoint as identity, mints in base58, fixture None).
            // Measured live 2026-09-16: SOL→EURC healthy both directions (~110 ms,
            // platformFee null); the USDC↔EURC pair probed 2026-09-16 was SKIPPED on a
            // then-apparent ~13% spread (an artifact of 1:1 USD/EUR parity) and REGISTERED
            // 2026-09-19 as jupiter-usdc-eurc once re-measured against the real rate.
            venue_id: "jupiter-eurc",
            display_name: "Jupiter",
            kind: VenueKind::SolanaAmm,
            endpoint: "https://lite-api.jup.ag",
            pair_ledgers: [WRAPPED_SOL_MINT, SOLANA_EURC_MINT],
            testnet: false,
            disclosure_key: "jupiter",
            test_helpers_served: false,
            fixture: None,
        },
        VenueEntry {
            // The THIRD Solana venue (registered 2026-09-19, EUR↔USD completion — founder
            // mandate): the same Jupiter aggregator family, on the rail-local pair
            // USDC ↔ EURC. Everything the jupiter row comment above says holds verbatim
            // (relay-proxied dials, https origin endpoint as identity, mints in base58 and
            // UNORDERED, fixture None). Measured live 2026-09-19: 10 USDC → 8.698735 EURC
            // (DefiTuna, priceImpactPct 0.000002) and 8.6 EURC → 9.885319 USDC (Whirlpool),
            // keyless, platformFee null — both directions within ~2-3% of fair at EUR/USD
            // ~1.17; the 2026-09-16 skip verdict had compared against 1:1 parity.
            venue_id: "jupiter-usdc-eurc",
            display_name: "Jupiter",
            kind: VenueKind::SolanaAmm,
            endpoint: "https://lite-api.jup.ag",
            pair_ledgers: [SOLANA_USDC_MINT, SOLANA_EURC_MINT],
            testnet: false,
            disclosure_key: "jupiter",
            test_helpers_served: false,
            fixture: None,
        },
        VenueEntry {
            // The FIRST CeFi venue (registered 2026-09-15, founder decision 3 — the
            // relay-held partner-key pattern, `docs/specs/2026-09-14-swap-venue-feasibility.md`
            // §Partner-key infrastructure): SideShift, an automated instant-exchange
            // service, on the cross-rail pair ICP ↔ SOL. IDENTIFIER SEMANTICS for a
            // cefi row: `pair_ledgers` are RAIL-CANONICAL ids — the IC side by ledger
            // principal, the Solana side by mint (native SOL = the wrapped-SOL mint,
            // the jupiter row's own precedent) — while the VENUE's own coin/network
            // codes live with the venue integration (`crate::sideshift`). `endpoint`
            // is the venue's https API BASE. Unlike every other row, this venue needs
            // a partner credential: quote + order creation run through the relay's
            // sideshift proxy (the account secret attaches there — the device never
            // sees it), while shift STATUS reads are the venue's own keyless GET the
            // device polls directly (app/convertResume.ts provider path). `fixture`
            // is None like every non-ic_amm row: the offline stand-ins are the relay's
            // test-stub upstream + the e2e page fetch stub on this origin.
            venue_id: "sideshift",
            display_name: "SideShift",
            kind: VenueKind::Cefi,
            endpoint: "https://sideshift.ai/api/v2",
            pair_ledgers: [ICP_LEDGER_PRINCIPAL, WRAPPED_SOL_MINT],
            testnet: false,
            disclosure_key: "sideshift",
            test_helpers_served: false,
            fixture: None,
        },
        VenueEntry {
            // The SECOND CeFi venue (registered 2026-09-16, coverage expansion §1): the same
            // SideShift venue family, on the cross-rail pair ICP ↔ USDC(Solana) — the first
            // pair with two registered routes from one screen (this beside the CCTP multihop
            // Route B out of the ckUSDC leg). Everything the sideshift row comment above says
            // holds verbatim (relay-held partner key, status reads device-direct, fixture
            // None). The keyless 503-until-founder-key tripwire applies to this row exactly
            // as to its sibling; the USDC(Solana) coin/network mapping in `crate::sideshift`
            // is best-effort and unverified until that key exists.
            venue_id: "sideshift-usdc",
            display_name: "SideShift",
            kind: VenueKind::Cefi,
            endpoint: "https://sideshift.ai/api/v2",
            pair_ledgers: [ICP_LEDGER_PRINCIPAL, SOLANA_USDC_MINT],
            testnet: false,
            disclosure_key: "sideshift",
            test_helpers_served: false,
            fixture: None,
        },
        VenueEntry {
            // The THIRD CeFi venue (registered 2026-09-19, the EUR→IC bridge): the same
            // SideShift venue family, on the cross-rail pair ICP ↔ EURC(Solana) — the pair
            // that completes dpay's EUR rail: EURC (the user deposits on Solana) ⇄ ICP
            // (settles on the Internet Computer), the only registered route between the
            // two. Everything the sideshift row comment above says holds verbatim
            // (relay-held partner key, status reads device-direct keyless, fixture None).
            // PAIR VERIFIED keyless 2026-09-19: GET /pair/eurc-solana/icp AND
            // /pair/icp/eurc-solana both answer live (the reverse direction min
            // 3.50126051, rate 2.437…), confirming the venue's own coin/network codes the
            // sideshift integration maps this row's rail ids to (`eurc`/`solana`/`ICP`/
            // `icp`). The keyless 503-until-creds tripwire applies to QUOTING exactly as
            // to its siblings; the founder's partner key now EXISTS (sops-encrypted,
            // secrets/sideshift.sops.json — prod deployment of it stays founder-run).
            venue_id: "sideshift-eurc",
            display_name: "SideShift",
            kind: VenueKind::Cefi,
            endpoint: "https://sideshift.ai/api/v2",
            pair_ledgers: [ICP_LEDGER_PRINCIPAL, SOLANA_EURC_MINT],
            testnet: false,
            disclosure_key: "sideshift",
            test_helpers_served: false,
            fixture: None,
        },
        VenueEntry {
            // The FOURTH CeFi venue and FIRST aggregator venue (registered 2026-09-20):
            // Trocador, an exchange AGGREGATOR fronting 20+ backends with automatic failover
            // (the research verdict that replaces SideShift as the primary CeFi rail once the
            // key arrives). The venue's own product is choosing the provider, so ONE quote
            // attributed to Trocador is ONE venue fact — the same standing as Jupiter for the
            // solana AMM rail; dpay never ranks beneath the aggregate. Cross-rail pair ICP ↔
            // SOL: the SIDE-SHIFT-FIRST precedent (which further pairs — USDC/EURC — deserve
            // rows is measured once the key exists, the sideshift-usdc/-eurc coverage-expansion
            // pattern). Identifier semantics for a cefi row hold verbatim: `pair_ledgers` are
            // RAIL-CANONICAL ids, the VENUE's own ticker/network codes live with the
            // integration (`crate::trocador`), `endpoint` is the venue's https API base
            // (api.trocador.app — verified live 2026-09-20 answering the venue's own
            // {"error":"Missing API key"}; the docs also name the equivalent
            // trocador.app/api/ prefix host). UNLIKE SideShift there is NO keyless surface:
            // every Trocador method is key-gated (header `API-Key`), so the relay proxies
            // rate, trade creation AND trade status. The key does NOT exist yet (requested
            // from commercial@trocador.app by the founder): all routes 503 naming
            // DPAY_TROCADOR_API_KEY until it lands — the 503-until-key tripwire, unchanged.
            // Founder pins, relay-side constants never read from a request: markup "0"
            // (dpay is paid nothing a nonzero markup would raise the USER'S price for),
            // min_kycrating "A" (non-KYC backends only), fixed "True" (the venue's documented
            // fixed-rate trade — the TRADE is the rate lock and the consent point, the
            // SideShift order doctrine). `fixture` None like every non-ic_amm row; the
            // offline stand-in is the relay's test stub upstream (DPAY_TROCADOR_API_BASE).
            venue_id: "trocador",
            display_name: "Trocador",
            kind: VenueKind::Cefi,
            endpoint: "https://api.trocador.app",
            pair_ledgers: [ICP_LEDGER_PRINCIPAL, WRAPPED_SOL_MINT],
            testnet: false,
            disclosure_key: "trocador",
            test_helpers_served: false,
            fixture: None,
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

// ---------------------------------------------------------------------------
// Venue settlement health (founder escalation 2026-09-20: the first live EURC→ICP SideShift
// shift sat in `settling` 6+ hours — deposit swept, payout pending — while the venue was
// advertised as healthy the whole time). The MEASUREMENT lives in `dfx/venue_health.json`,
// written by the opt-in settlement probe (`just swap-venue-probe`,
// `sideshift_settlement_sla` in tests/swap_venue_mainnet.rs) and committed like any other
// measured fact. The relay compiles the file in; `GET /api/v1/venues` derives each row's
// verdict AT SERVE TIME via [`settlement_verdict`] and demotes degraded venues to the TAIL
// of the served list (the app never ranks — V5 — so relay order IS the demotion) until a
// passing probe run rewrites the file. A health flag + an order, nothing more: not a routing
// engine, not a price signal.
// ---------------------------------------------------------------------------

/// The settlement SLA a cefi venue must meet: payout within 30 minutes of the order.
/// Pinned to the literal in tests/swap_venue_mainnet.rs (update both together).
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
pub(crate) const SETTLEMENT_SLA_SECONDS: u64 = 30 * 60;

/// The gate over one raw settlement measurement: degraded = the payout did not settle, or
/// settled slower than [`SETTLEMENT_SLA_SECONDS`]. A settled-fast measurement clears it.
/// Applied at SERVE time (never stored), so the probe is a pure instrument and this reader
/// is the only place the threshold lives.
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
pub(crate) fn settlement_verdict(settled: bool, settle_seconds: Option<u64>) -> &'static str {
    match (settled, settle_seconds) {
        (true, Some(s)) if s <= SETTLEMENT_SLA_SECONDS => "ok",
        _ => "degraded",
    }
}

/// One venue's settlement verdict as served on the wire (`health` on a VenueBody).
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
pub(crate) struct VenueHealth {
    /// `"ok" | "degraded"` — derived from the raw measurement by [`settlement_verdict`].
    pub status: &'static str,
    /// Measured order→settle latency in seconds; `None` = observed without a settle.
    pub settle_seconds: Option<u64>,
    /// When the probe measured (unix seconds).
    pub measured_at: u64,
}

/// The venue's last measured settlement health — `None` when the probe never measured it.
/// Absence is served as NO health object: never-measured is healthy-by-default, never invented.
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
pub(crate) fn venue_health(venue_id: &str) -> Option<VenueHealth> {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    static ROWS: OnceLock<HashMap<String, (bool, Option<u64>, u64)>> = OnceLock::new();
    let rows = ROWS.get_or_init(|| {
        let raw: serde_json::Value = serde_json::from_str(include_str!(
            "../../../dfx/venue_health.json"
        ))
        .expect(
            "dfx/venue_health.json must be valid JSON (probe-written; the venue_truth_tests \
             alarm parses it in every test run, so a malformed file cannot reach here)",
        );
        raw["venues"]
            .as_object()
            .expect("venue_health.venues is an object")
            .clone()
            .into_iter()
            .map(|(id, row)| {
                let settled = row["settled"]
                    .as_bool()
                    .unwrap_or_else(|| panic!("venue_health[{id}].settled must be a bool"));
                let settle_seconds = if row["settle_seconds"].is_null() {
                    None
                } else {
                    Some(row["settle_seconds"].as_u64().unwrap_or_else(|| {
                        panic!("venue_health[{id}].settle_seconds must be a number or null")
                    }))
                };
                let measured_at = row["measured_at"].as_u64().unwrap_or_else(|| {
                    panic!("venue_health[{id}].measured_at must be a unix-seconds number")
                });
                (id, (settled, settle_seconds, measured_at))
            })
            .collect()
    });
    rows.get(venue_id).map(|(settled, settle_seconds, measured_at)| VenueHealth {
        status: settlement_verdict(*settled, *settle_seconds),
        settle_seconds: *settle_seconds,
        measured_at: *measured_at,
    })
}

/// Stable demotion: rows whose `degraded` predicate holds move to the TAIL, each group
/// keeping its relative order. This is the WHOLE demotion — a flag and an order, never a
/// ranking (the app renders relay order verbatim and never sorts — V5 red line).
#[cfg_attr(not(any(feature = "agent", feature = "test-helpers")), allow(dead_code))]
pub(crate) fn degraded_last<T>(rows: Vec<T>, degraded: impl Fn(&T) -> bool) -> Vec<T> {
    let mut rows = rows;
    rows.sort_by_key(|r| degraded(r)); // stable sort: healthy first in order, degraded follow in order
    rows
}

/// The IC section rows of the catalog — the wallet's runtime source of truth for which assets
/// exist and how to display/fund them. REAL prod rows, fetched live from the prod relay's
/// `/api/v1/currencies` on 2026-08-28 and transplanted VERBATIM (every field, null vs value):
/// mainnet DEMO_USD (0, mintable, the faucet asset at the DUSD ledger) + ckBTC (1, CkBtcUtxo
/// ramp) + ckUSDC (2, CkEthErc20 onramp) + ckETH (6, native-ETH within CkEthErc20,
/// `token_contract` null) + the locked VCHF (7) / ICP (8) direct-ICRC rows; testnet ckTESTBTC
/// (3) + ckSepoliaUSDC (4) + ckSepoliaETH (5). The wallet reads
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
/// toggle) are Direct both ways on the TESTNET rail (free testnet funds).
///
/// Dropped 2026-09-19: the VEUR (9) row (EUR dual-rail Stage 1, 2026-09-06 — the only
/// `offramp = Partner` row, DFX). VNX is winding VEUR down (measured 2026-09-19: zero swap
/// liquidity on EVERY chain, Jupiter flags the Solana mint TOKEN_NOT_TRADABLE, no CEX market,
/// vnx.io delisted it) — founder call: drop it fully. Currency id 9 is RETIRED, never reused
/// for a different asset (ids are money-defining).
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
            // The MEASURED live ledger fee (2026-09-18, anonymous read-only query:
            // `dfx canister call mxzaz-… icrc1_fee '(record {})' --network ic` → `(10 : nat)`
            // = 10 sats at 8 decimals). The fake-IC gateway (ic_gateway.rs from_catalog) seeds
            // this as the icrc1_fee it ENFORCES, so the offline fake ckBTC ledger now behaves
            // like the real one. Corroborated by the testnet ckBTC row below (same 10).
            fee: Some(U64String(10)),
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
/// only — see [`SOLANA_EURC_MINT`]). It doubles as one side of the FIRST venue pair whose
/// `pair_ledgers` are mints (the Jupiter row — see [`WRAPPED_SOL_MINT`]).
pub(crate) const SOLANA_USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/// The wrapped-SOL mint (`So111…12`, Mantle/SPL token account of native SOL) — the identifier a
/// SOLANA venue row carries for the NATIVE side of a pair: Jupiter routes native SOL through its
/// wrapped form, and a registry row needs a stable string id for each side, so the wrapped mint
/// IS "SOL" in venue `pair_ledgers` (mirrors `WRAPPED_SOL_MINT_ADDRESS`, app/solana/tokens.ts;
/// pinned against `dfx/catalog_truth.json` venues[].pair_ledgers by `venue_truth_tests`).
pub(crate) const WRAPPED_SOL_MINT: &str = "So11111111111111111111111111111111111111112";

/// The mainnet EURC mint — `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` (Circle's native
/// EURC on solana mainnet, 6 decimals). THE EUR asset since the 2026-09-19 VEUR
/// removal (the IC half of the old dual-rail is gone; VNX wound the token down).
/// Cross-checked against `dfx/catalog_truth.json` (`principals.eurc_mint`) by the
/// `catalog_truth_tests` module below. `pub(crate)` because the sideshift integration's
/// rail-id → coin-code table (`SIDESHIFT_ASSETS`) names it: the `sideshift-eurc`
/// venue row's Solana-side rail id IS this mint.
pub(crate) const SOLANA_EURC_MINT: &str = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";

// --- The EVM rail's chain + token constants (spec 2026-09-26, D2; USDC rows R1 step 0,
// --- 2026-10-12) -----------------------------------------------------------------
// The device-key ERC-20 rail: one relay-level catalog section per settlement chain, carried in
// [`NetworkAssets::Evm`] rows ([`EvmAsset`]) — never a `CurrencyDescriptor` (the rail never
// touches the IC; the SolanaAsset precedent). All literals are cross-checked against
// `dfx/catalog_truth.json` (`erc20_contracts.zchf_*` / `erc20_contracts.usdc_*`,
// `decimals.zchf` / `decimals.usdc`, `chains`) by the
// `catalog_truth_tests` module below; the addresses' EIP-55 checksums are additionally
// self-verified by the jest half of the drift alarm (app/__tests__/catalog.test.ts).

/// ZCHF on Arbitrum One — the Frankencoin ERC-20 contract, EIP-55 checksummed. Arbitrum One is
/// the RECOMMENDED event rail (sub-cent gas), which is why its section comes FIRST in the served
/// catalog (section order = wallet row order).
pub(crate) const ZCHF_ARBITRUM_ADDRESS: &str = "0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553";

/// ZCHF on Ethereum mainnet — the same token's L1 deployment, EIP-55 checksummed.
pub(crate) const ZCHF_ETHEREUM_ADDRESS: &str = "0xB58E61C3098d85632Df34EecfB899A1Ed80921cB";

/// ZCHF decimals — 18 (the ERC-20 standard's own precision; NOT the IC VCHF row's 8).
pub(crate) const ZCHF_DECIMALS: u8 = 18;

/// USDC (Circle) on Arbitrum One — the canonical native USDC contract, EIP-55 checksummed.
/// Verified against Circle's canonical deployment AND api.mtpelerin.com/currencies/tokens
/// (`arbitrum_mainnet`, 2026-10-12, R1 step 0 of the WalletConnect/Mt Pelerin plan).
pub(crate) const USDC_ARBITRUM_ADDRESS: &str = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

/// USDC (Circle) on Ethereum mainnet — the canonical native USDC contract, EIP-55 checksummed.
/// Verified against Circle's canonical deployment AND api.mtpelerin.com/currencies/tokens
/// (`mainnet`, 2026-10-12, R1 step 0 of the WalletConnect/Mt Pelerin plan).
pub(crate) const USDC_ETHEREUM_ADDRESS: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/// USDC decimals — 6, on both wired chains (Circle's own deployment parameter).
pub(crate) const USDC_DECIMALS: u8 = 6;

/// EVM chain id — Ethereum mainnet. THE default chain of the JSON-RPC pipe (the bare
/// `/api/v1/evm/rpc` route serves exactly this chain).
pub(crate) const CHAIN_ID_ETHEREUM: u64 = 1;

/// EVM chain id — Arbitrum One.
pub(crate) const CHAIN_ID_ARBITRUM_ONE: u64 = 42161;

/// EVM chain id — Arbitrum Sepolia (dev/e2e only; its section is env-gated, see
/// [`dev_evm_sections`]).
pub(crate) const CHAIN_ID_ARBITRUM_SEPOLIA: u64 = 421614;

/// EVM chain id — the local anvil dev/e2e chain (section env-gated, see [`dev_evm_sections`]).
pub(crate) const CHAIN_ID_ANVIL: u64 = 31337;

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
                // EURC — the EUR asset (Circle's native solana EURC; sole EUR rail since
                // the 2026-09-19 VEUR removal). No fiat ramp through dpay — the honest
                // Unavailable — and `min_fraction_digits: 2` matches the unit-denominated
                // policy (EURC reads '1.50' like USDC/VCHF).
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

/// One EVM network section — an env-provided mock-token address on a dev chain. There is no
/// real ZCHF on Arbitrum Sepolia and nothing at all on a fresh anvil, so these rows exist ONLY
/// when the operator hands the relay the deployed mock token's address (spec 2026-09-26, D3):
///
/// - `DPAY_EVM_SEPOLIA_TOKEN=<0x…>` → an `{evm, "Arbitrum Sepolia", testnet}` section (chain
///   421614) carrying ZCHF at that address.
/// - `DPAY_EVM_ANVIL_TOKEN=<0x…>` → an `{evm, "Anvil", testnet}` section (chain 31337), same.
///
/// Unset — every prod, lean and test build — the sections are ABSENT (fail-closed absence) and
/// the served wire bytes are unchanged: the same trick [`demo_ledger_text`] plays for
/// `DPAY_DEMO_LEDGER`. Read once via `OnceLock` (the catalog is rebuilt per request and must
/// not re-parse the env each call); the address SHAPE (`0x` + 40 hex) is validated at relay
/// startup in `main.rs` where a malformed value refuses to boot instead of serving a dead row.
/// Testnet-ness is the SECTION's `environment` field — the app stamps `testnet` from it and the
/// existing testnet toggle hides these rows by default. Never compiled mock addresses.
fn dev_evm_sections(sepolia_token: Option<&str>, anvil_token: Option<&str>) -> Vec<NetworkBody> {
    let mut sections = Vec::new();
    if let Some(address) = sepolia_token {
        sections.push(NetworkBody {
            protocol: "evm",
            name: "Arbitrum Sepolia",
            environment: "testnet",
            assets: NetworkAssets::Evm(vec![EvmAsset {
                token: "ZCHF",
                symbol: "ZCHF",
                decimals: ZCHF_DECIMALS,
                min_fraction_digits: Some(2),
                chain_id: CHAIN_ID_ARBITRUM_SEPOLIA,
                address: address.to_string(),
                onramp: RampCapability::Unavailable,
                offramp: RampCapability::Unavailable,
                liquidity: None,
            }]),
        });
    }
    if let Some(address) = anvil_token {
        sections.push(NetworkBody {
            protocol: "evm",
            name: "Anvil",
            environment: "testnet",
            assets: NetworkAssets::Evm(vec![EvmAsset {
                token: "ZCHF",
                symbol: "ZCHF",
                decimals: ZCHF_DECIMALS,
                min_fraction_digits: Some(2),
                chain_id: CHAIN_ID_ANVIL,
                address: address.to_string(),
                onramp: RampCapability::Unavailable,
                offramp: RampCapability::Unavailable,
                liquidity: None,
            }]),
        });
    }
    sections
}

/// The two dev-token env values, read ONCE (the [`demo_ledger_text`] OnceLock discipline):
/// `(DPAY_EVM_SEPOLIA_TOKEN, DPAY_EVM_ANVIL_TOKEN)`, trimmed, empty-means-unset. Exposed as a
/// fn (not inlined into [`evm_network_sections`]) so the wire tests can pin that the SERVED body
/// is exactly [`dev_evm_sections`] applied to THESE values — whatever they are — without
/// process-env mutation.
fn env_evm_dev_tokens() -> (Option<String>, Option<String>) {
    use std::sync::OnceLock;

    fn once(name: &'static str) -> Option<String> {
        static SEPOLIA: OnceLock<Option<String>> = OnceLock::new();
        static ANVIL: OnceLock<Option<String>> = OnceLock::new();
        let lock = match name {
            "DPAY_EVM_SEPOLIA_TOKEN" => &SEPOLIA,
            _ => &ANVIL,
        };
        lock.get_or_init(|| {
            std::env::var(name)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .clone()
    }
    (
        once("DPAY_EVM_SEPOLIA_TOKEN"),
        once("DPAY_EVM_ANVIL_TOKEN"),
    )
}

/// The EVM sections for a given pair of dev-token addresses — THE env-dependent builder, kept
/// env-free so the tests pin the full shape without process-env mutation (D3). Prod calls it
/// through [`evm_network_sections`] with the OnceLock-resolved env. Arbitrum One FIRST (the
/// recommended event rail: sub-cent gas), then Ethereum, then the dev sections. The section
/// order IS the wallet row order (`buildSelectableAssets` preserves section order app-side).
fn evm_sections_with(sepolia_token: Option<&str>, anvil_token: Option<&str>) -> Vec<NetworkBody> {
    let mut sections = vec![
        NetworkBody {
            protocol: "evm",
            name: "Arbitrum One",
            environment: "mainnet",
            assets: NetworkAssets::Evm(vec![EvmAsset {
                token: "ZCHF",
                symbol: "ZCHF",
                decimals: ZCHF_DECIMALS,
                min_fraction_digits: Some(2), // unit-denominated — the VCHF/USDC display policy
                chain_id: CHAIN_ID_ARBITRUM_ONE,
                address: ZCHF_ARBITRUM_ADDRESS.to_string(),
                // No fiat ramp through dpay on this device-key rail — the honest
                // Unavailable (the solana rows' corrected semantics). Transfer-in still
                // works: send-to-address is the deposit mechanism.
                onramp: RampCapability::Unavailable,
                offramp: RampCapability::Unavailable,
                // No measured venue tier for ZCHF on either chain — do not invent one.
                liquidity: None,
            },
            // USDC AFTER the ZCHF row: section order IS the wallet row order and the wire
            // byte-shape pins index rows[0] = ZCHF, rows[1] = USDC per section. Both ramps
            // name the Mt Pelerin fiat rail: the onramp since R1 step 0, the offramp flipped
            // R2 step 1, 2026-10-12. Canonical Circle deployment, verified against
            // api.mtpelerin.com/currencies/tokens 2026-10-12.
            EvmAsset {
                token: "USDC",
                symbol: "USDC",
                decimals: USDC_DECIMALS,
                min_fraction_digits: Some(2), // unit-denominated — the VCHF/USDC display policy
                chain_id: CHAIN_ID_ARBITRUM_ONE,
                address: USDC_ARBITRUM_ADDRESS.to_string(),
                onramp: RampCapability::Partner,
                offramp: RampCapability::Partner,
                // No measured venue tier for USDC on either chain — do not invent one.
                liquidity: None,
            }]),
        },
        NetworkBody {
            protocol: "evm",
            name: "Ethereum",
            environment: "mainnet",
            assets: NetworkAssets::Evm(vec![EvmAsset {
                token: "ZCHF",
                symbol: "ZCHF",
                decimals: ZCHF_DECIMALS,
                min_fraction_digits: Some(2),
                chain_id: CHAIN_ID_ETHEREUM,
                address: ZCHF_ETHEREUM_ADDRESS.to_string(),
                // Cash-out flipped R2 step 1, 2026-10-12: Mt Pelerin lists ZCHF cash-out on
                // Ethereum (the Arbitrum row above stays Unavailable both ways). The onramp
                // stays Unavailable; buy-in rides the Partner USDC row.
                onramp: RampCapability::Unavailable,
                offramp: RampCapability::Partner,
                liquidity: None,
            },
            // rows[1] = USDC, mirroring the Arbitrum section (see the comment there): Partner
            // both ways since R2 step 1, 2026-10-12. Ethereum ERC-20 delivery costs the
            // partner's $1 flat fee — disclosed in the buy copy, R1 step 3, not modeled here.
            EvmAsset {
                token: "USDC",
                symbol: "USDC",
                decimals: USDC_DECIMALS,
                min_fraction_digits: Some(2),
                chain_id: CHAIN_ID_ETHEREUM,
                address: USDC_ETHEREUM_ADDRESS.to_string(),
                onramp: RampCapability::Partner,
                offramp: RampCapability::Partner,
                liquidity: None,
            }]),
        },
    ];
    sections.extend(dev_evm_sections(sepolia_token, anvil_token));
    sections
}

/// The EVM mainnet sections — Arbitrum One FIRST, then Ethereum, followed by any env-gated dev
/// sections ([`dev_evm_sections`]). Relay-level constants like the solana section (the rail
/// never touches the IC — no `CurrencyDescriptor`, no ledger principal, no minter).
fn evm_network_sections() -> Vec<NetworkBody> {
    let (sepolia, anvil) = env_evm_dev_tokens();
    evm_sections_with(sepolia.as_deref(), anvil.as_deref())
}

/// The complete `GET /api/v1/currencies` response body: exactly five sections in order
/// (icp mainnet, icp testnet, solana mainnet, evm "Arbitrum One" mainnet, evm "Ethereum"
/// mainnet; plus the env-gated dev evm sections appended last, D3), partitioned server-side
/// ([`is_testnet_row`]). The empty testnet section is still emitted — clients shouldn't infer
/// from absence. IC rows serialize in the UNCHANGED `CurrencyDescriptor` shape (field
/// set/casing frozen — the app + e2e depend on the byte-shape).
pub(crate) fn currencies_body() -> CurrenciesBody {
    // Partition preserves each side's catalog order; mainnet keeps DEMO (network None).
    let (mainnet, testnet): (Vec<_>, Vec<_>) =
        ic_rows().into_iter().partition(|d| !is_testnet_row(d));
    let mut networks = vec![
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
    ];
    networks.extend(evm_network_sections());
    CurrenciesBody { networks }
}

/// `GET /api/v1/currencies` response body — the network-first asset catalog (v2). Exactly five
/// sections in order: icp mainnet, icp testnet (possibly empty), solana mainnet, evm Arbitrum
/// One mainnet, evm Ethereum mainnet (plus the env-gated dev evm sections, D3).
#[derive(Serialize)]
pub(crate) struct CurrenciesBody {
    networks: Vec<NetworkBody>,
}

/// One `networks[]` section. `assets` is untagged so IC sections carry `CurrencyDescriptor` rows,
/// the solana section carries [`SolanaAsset`] rows and the evm sections carry [`EvmAsset`]
/// rows — all serialize as plain JSON arrays.
#[derive(Serialize)]
pub(crate) struct NetworkBody {
    protocol: &'static str,
    name: &'static str,
    environment: &'static str,
    assets: NetworkAssets,
}

/// The `assets` array of a network section — IC rows (`CurrencyDescriptor`, field set/casing
/// UNCHANGED from the pre-v2 flat catalog), the relay-constant Solana rows, or the
/// relay-constant EVM rows.
#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum NetworkAssets {
    Ic(Vec<CurrencyDescriptor>),
    Solana(Vec<SolanaAsset>),
    Evm(Vec<EvmAsset>),
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

/// One EVM asset row — a relay-level constant (the device-key rail never touches the IC, so
/// deliberately NOT a `CurrencyDescriptor` — the [`SolanaAsset`] precedent, same module).
/// `token` is the link/registry literal ('ZCHF'; exact-case matching app-side keeps it distinct
/// from the IC VCHF row), `symbol` the display form (the split exists for a native-ETH row
/// later). `chain_id` names THE chain the money settles on — NEW semantics vs the IC rows'
/// chain_id (which names the BACKING chain, e.g. ckUSDC's 1 = Ethereum); written down in
/// `dfx/catalog_truth.json` `chains._doc`. `address` is the EIP-55 checksummed ERC-20 contract
/// (`String` only because the dev rows' addresses arrive via env, D3 — prod rows are the
/// `ZCHF_*_ADDRESS` consts). Ramps are the honest fiat Unavailable; `liquidity` stays unset
/// until a venue tier is measured.
#[derive(Serialize)]
pub(crate) struct EvmAsset {
    token: &'static str,
    symbol: &'static str,
    decimals: u8,
    min_fraction_digits: Option<u8>,
    chain_id: u64,
    address: String,
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
        // were mis-filed testnet-side and hidden behind the wallet's testnet toggle.
        let vchf = CurrencyDescriptor {
            currency: 7,
            ..row_with_network(Some("Internet Computer"))
        };
        let icp = CurrencyDescriptor {
            currency: 8,
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
        // The solana EURC mint (the sole EUR rail since the 2026-09-19 VEUR removal).
        assert_eq!(SOLANA_EURC_MINT, p["eurc_mint"].as_str().unwrap());
        assert_eq!(
            CKUSDC_ERC20_ADDRESS,
            t["erc20_contracts"]["ckusdc"].as_str().unwrap()
        );
        // The EVM rail's ZCHF consts ARE the truth file's values (spec 2026-09-26, D5): the two
        // ERC-20 contracts, the 18-dec decimals, and every chain id. A const edit without a JSON
        // update (or vice versa) goes RED here.
        assert_eq!(
            ZCHF_ARBITRUM_ADDRESS,
            t["erc20_contracts"]["zchf_arbitrum"].as_str().unwrap()
        );
        assert_eq!(
            ZCHF_ETHEREUM_ADDRESS,
            t["erc20_contracts"]["zchf_ethereum"].as_str().unwrap()
        );
        assert_eq!(
            u64::from(ZCHF_DECIMALS),
            t["decimals"]["zchf"].as_u64().unwrap()
        );
        let chains = &t["chains"];
        assert_eq!(CHAIN_ID_ETHEREUM, chains["ethereum"].as_u64().unwrap());
        assert_eq!(
            CHAIN_ID_ARBITRUM_ONE,
            chains["arbitrum_one"].as_u64().unwrap()
        );
        assert_eq!(
            CHAIN_ID_ARBITRUM_SEPOLIA,
            chains["arbitrum_sepolia"].as_u64().unwrap()
        );
        assert_eq!(CHAIN_ID_ANVIL, chains["anvil"].as_u64().unwrap());
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
        // testnet-real + 7,8 locked; 9 retired with VEUR, 2026-09-19), the source order is
        // stable, and the SERVED sections come out in the documented order (mainnet
        // 0,1,2,6,7,8 / testnet 3,4,5).
        let t = truth();
        let p = &t["principals"];
        let cat = ic_rows();

        // Source order + ids.
        assert_eq!(
            cat.len(),
            9,
            "9 IC rows: 4 real mainnet + 3 real testnet + VCHF + ICP"
        );
        assert_eq!(
            cat.iter().map(|d| d.currency).collect::<Vec<_>>(),
            vec![0, 1, 2, 6, 3, 4, 5, 7, 8],
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
                NetworkAssets::Solana(_) | NetworkAssets::Evm(_) => {
                    panic!("section {sec} must be an IC section")
                }
            }
        };
        assert_eq!(
            section_ids(0),
            vec![0, 1, 2, 6, 7, 8],
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
        assert_eq!(ckbtc.fee, Some(U64String(10)), "the MEASURED live ckBTC ledger fee (2026-09-18 icrc1_fee query → 10 nat = 10 sats)");
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
            9,
            "4 real mainnet + 3 real testnet + VCHF + ICP"
        );
        assert_eq!(
            cat[7].symbol.as_deref(),
            Some("VCHF"),
            "id 7 IS the VCHF row"
        );
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

    /// The solana section's EUR row — the sole EUR rail since the 2026-09-19 VEUR removal.
    /// Truth-file mint/decimals pins + locked shape.
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

    /// The EVM sections' truth-file pins + locked shape (spec 2026-09-26, D5; USDC rows R1
    /// step 0 of the WalletConnect/Mt Pelerin plan, 2026-10-12). Built from the
    /// env-free prod inputs (`None, None`) so the test is hermetic — the env-gated dev rows are
    /// covered by `evm_dev_sections_are_env_gated` below. Pins: exactly two prod sections in
    /// order (Arbitrum One, Ethereum), one ZCHF + one USDC row each, every field matched against
    /// `dfx/catalog_truth.json`, and the served body carries them right after the solana
    /// section.
    #[test]
    fn evm_rows_match_truth_and_locked_shape() {
        let t = truth();
        let sections = evm_sections_with(None, None);
        assert_eq!(sections.len(), 2, "prod shape: Arbitrum One + Ethereum only");
        assert_eq!(
            sections
                .iter()
                .map(|s| (s.protocol, s.name, s.environment))
                .collect::<Vec<_>>(),
            vec![
                ("evm", "Arbitrum One", "mainnet"),
                ("evm", "Ethereum", "mainnet"),
            ],
            "section order IS the wallet row order: Arbitrum One first"
        );

        let NetworkAssets::Evm(arb_rows) = &sections[0].assets else {
            panic!("an evm section must carry EvmAsset rows");
        };
        let NetworkAssets::Evm(eth_rows) = &sections[1].assets else {
            panic!("an evm section must carry EvmAsset rows");
        };
        assert_eq!(arb_rows.len(), 2, "one ZCHF + one USDC row per evm section");
        assert_eq!(eth_rows.len(), 2, "one ZCHF + one USDC row per evm section");
        let arb_zchf = &arb_rows[0];
        let eth_zchf = &eth_rows[0];
        // The ZCHF rows: every field against the truth file. The offramp flipped R2 step 1,
        // 2026-10-12, Ethereum ONLY (Mt Pelerin lists no ZCHF cash-out on Arbitrum), so the
        // loop carries the per-row expected offramp instead of a shared Unavailable pin.
        for (row, address_key, chain_key, chain_id, expected_offramp) in [
            (
                arb_zchf,
                "zchf_arbitrum",
                "arbitrum_one",
                CHAIN_ID_ARBITRUM_ONE,
                RampCapability::Unavailable,
            ),
            (
                eth_zchf,
                "zchf_ethereum",
                "ethereum",
                CHAIN_ID_ETHEREUM,
                RampCapability::Partner,
            ),
        ] {
            assert_eq!(row.token, "ZCHF");
            assert_eq!(row.symbol, "ZCHF");
            assert_eq!(
                row.address,
                t["erc20_contracts"][address_key].as_str().unwrap(),
                "row address == catalog_truth erc20_contracts.{address_key}"
            );
            assert_eq!(
                u64::from(row.decimals),
                t["decimals"]["zchf"].as_u64().unwrap(),
                "row decimals == catalog_truth decimals.zchf"
            );
            assert_eq!(row.chain_id, chain_id);
            assert_eq!(
                chain_id,
                t["chains"][chain_key].as_u64().unwrap(),
                "row chain_id == catalog_truth chains.{chain_key}"
            );
            assert_eq!(
                row.min_fraction_digits,
                Some(2),
                "unit-denominated — the VCHF/USDC display policy"
            );
            assert_eq!(row.onramp, RampCapability::Unavailable, "no fiat onramp");
            assert_eq!(
                row.offramp, expected_offramp,
                "R2 step 1 flipped the Ethereum ZCHF offramp only"
            );
            assert_eq!(row.liquidity, None, "no measured venue tier — do not invent one");
        }
        // The USDC rows (rows[1]): canonical Circle deployments against the truth file. Both
        // ramps are the Mt Pelerin Partner rail — the onramp since R1 step 0, the offramp
        // flipped R2 step 1 (2026-10-12, same flip commit pattern as ZCHF-Ethereum).
        for (row, address_key, chain_key, chain_id) in [
            (&arb_rows[1], "usdc_arbitrum", "arbitrum_one", CHAIN_ID_ARBITRUM_ONE),
            (&eth_rows[1], "usdc_ethereum", "ethereum", CHAIN_ID_ETHEREUM),
        ] {
            assert_eq!(row.token, "USDC");
            assert_eq!(row.symbol, "USDC");
            assert_eq!(
                row.address,
                t["erc20_contracts"][address_key].as_str().unwrap(),
                "row address == catalog_truth erc20_contracts.{address_key}"
            );
            assert_eq!(
                u64::from(row.decimals),
                t["decimals"]["usdc"].as_u64().unwrap(),
                "row decimals == catalog_truth decimals.usdc"
            );
            assert_eq!(row.chain_id, chain_id);
            assert_eq!(
                chain_id,
                t["chains"][chain_key].as_u64().unwrap(),
                "row chain_id == catalog_truth chains.{chain_key}"
            );
            assert_eq!(
                row.min_fraction_digits,
                Some(2),
                "unit-denominated — the VCHF/USDC display policy"
            );
            assert_eq!(row.onramp, RampCapability::Partner, "the Mt Pelerin fiat onramp");
            assert_eq!(row.offramp, RampCapability::Partner, "the Mt Pelerin fiat offramp (R2 step 1)");
            assert_eq!(row.liquidity, None, "no measured venue tier — do not invent one");
        }
        // The token literal must stay distinct from the IC VCHF row (exact-case tokenEq
        // app-side; no case-folding trick may merge the two).
        assert_ne!("ZCHF".to_lowercase(), "VCHF".to_lowercase());

        // The SERVED body carries exactly these sections, immediately after the solana one
        // (in the env-unset shape this test process runs in).
        if dev_len() == 0 {
            let body = currencies_body();
            assert!(matches!(body.networks[2].assets, NetworkAssets::Solana(_)));
            let expected = serde_json::to_string(&sections).unwrap();
            assert_eq!(
                serde_json::to_string(&body.networks[3..5]).unwrap(),
                expected,
                "the served evm sections are the prod sections, in order"
            );
            assert_eq!(body.networks.len(), 5, "prod wire shape: five sections");
        }
    }

    /// How many dev evm sections THIS test process's env implies (the same OnceLock-resolved
    /// values [`evm_network_sections`] reads). Zero in every prod/lean/test run — asserted
    /// where it matters.
    fn dev_len() -> usize {
        let (sep, anv) = env_evm_dev_tokens();
        usize::from(sep.is_some()) + usize::from(anv.is_some())
    }

    /// D3's env gating: dev tokens set → the dev sections appear (Arbitrum Sepolia then Anvil,
    /// both `testnet`, carrying the env-provided address); unset → absent. Built from the
    /// env-free builder — no process-env mutation anywhere.
    #[test]
    fn evm_dev_sections_are_env_gated() {
        assert_eq!(
            evm_sections_with(None, None).len(),
            2,
            "env unset: the dev sections are ABSENT (fail-closed absence)"
        );
        let sep = "0x1111111111111111111111111111111111111111";
        let anv = "0x2222222222222222222222222222222222222222";
        let both = evm_sections_with(Some(sep), Some(anv));
        assert_eq!(both.len(), 4, "prod two + dev two");
        assert_eq!(
            both.iter()
                .map(|s| (s.protocol, s.name, s.environment))
                .collect::<Vec<_>>(),
            vec![
                ("evm", "Arbitrum One", "mainnet"),
                ("evm", "Ethereum", "mainnet"),
                ("evm", "Arbitrum Sepolia", "testnet"),
                ("evm", "Anvil", "testnet"),
            ],
            "dev sections append LAST, Sepolia then Anvil"
        );
        let NetworkAssets::Evm(sep_rows) = &both[2].assets else {
            panic!("a dev evm section must carry EvmAsset rows");
        };
        assert_eq!(sep_rows[0].chain_id, CHAIN_ID_ARBITRUM_SEPOLIA);
        assert_eq!(sep_rows[0].address, sep, "the env-provided mock token address");
        let NetworkAssets::Evm(anv_rows) = &both[3].assets else {
            panic!("a dev evm section must carry EvmAsset rows");
        };
        assert_eq!(anv_rows[0].chain_id, CHAIN_ID_ANVIL);
        assert_eq!(anv_rows[0].address, anv);

        // Each dev env gates ITS OWN section: one set → exactly one dev section.
        let only_sep = evm_sections_with(Some(sep), None);
        assert_eq!(
            only_sep.iter().map(|s| s.name).collect::<Vec<_>>(),
            vec!["Arbitrum One", "Ethereum", "Arbitrum Sepolia"]
        );
        let only_anv = evm_sections_with(None, Some(anv));
        assert_eq!(
            only_anv.iter().map(|s| s.name).collect::<Vec<_>>(),
            vec!["Arbitrum One", "Ethereum", "Anvil"]
        );
    }

    /// The SERVED body is exactly [`dev_evm_sections`] applied to the OnceLock-resolved env
    /// values — whatever they are — so the env→wire wiring is pinned without process-env
    /// mutation (the DPAY_DEMO_LEDGER pattern's testability clause).
    #[test]
    fn served_body_dev_sections_match_the_resolved_env() {
        let (sep, anv) = env_evm_dev_tokens();
        let expected = evm_sections_with(sep.as_deref(), anv.as_deref());
        let body = currencies_body();
        assert_eq!(
            body.networks.len(),
            3 + expected.len(),
            "3 non-evm sections + the evm sections for THIS process's env"
        );
        assert_eq!(
            serde_json::to_string(&body.networks[3..]).unwrap(),
            serde_json::to_string(&expected).unwrap(),
        );
        if sep.is_none() && anv.is_none() {
            assert_eq!(
                body.networks.len(),
                5,
                "the DEFAULT (env-unset) build serves exactly five sections — prod wire bytes \
                 unchanged by the dev-row machinery"
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
            "{\"currency\":1,\"ledger\":\"mxzaz-hqaaa-aaaar-qaada-cai\",\"mintable\":false,\"minter\":\"mqygn-kiaaa-aaaar-qaadq-cai\",\"minter_family\":\"CkBtcUtxo\",\"symbol\":\"₿\",\"decimals\":8,\"wrapper_name\":\"ckBTC\",\"backing_symbol\":\"BTC\",\"network\":\"Bitcoin\",\"display_decimals\":8,\"min_fraction_digits\":null,\"fee\":\"10\",\"cap\":\"100000\",\"chain_id\":null,\"token_contract\":null,\"gas_ledger\":null,\"onramp\":\"Direct\",\"offramp\":\"Direct\"}"
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

    /// The EVM ZCHF rows' exact wire bytes (spec 2026-09-26, D5): key order, casing, the
    /// checksummed addresses, `min_fraction_digits` as a plain number, NO `liquidity` key.
    /// Any serializer regression (key order, an accidental liquidity key, a re-cased address)
    /// goes RED here before it reaches a route test. EXTENDED (R1 step 0, 2026-10-12) with the
    /// rows[1] USDC wire-byte literal per section. All eligible offramps flipped R2 step 1,
    /// 2026-10-12: ZCHF-Ethereum and both USDC rows read Partner; ZCHF-Arbitrum and every
    /// testnet row stay Unavailable.
    #[test]
    fn zchf_rows_wire_byte_shape() {
        let NetworkAssets::Evm(rows) = evm_sections_with(None, None).remove(0).assets else {
            panic!("the Arbitrum One section must carry EvmAsset rows");
        };
        assert_eq!(
            serde_json::to_string(&rows[0]).unwrap(),
            "{\"token\":\"ZCHF\",\"symbol\":\"ZCHF\",\"decimals\":18,\"min_fraction_digits\":2,\"chain_id\":42161,\"address\":\"0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553\",\"onramp\":\"Unavailable\",\"offramp\":\"Unavailable\"}"
        );
        assert_eq!(
            serde_json::to_string(&rows[1]).unwrap(),
            "{\"token\":\"USDC\",\"symbol\":\"USDC\",\"decimals\":6,\"min_fraction_digits\":2,\"chain_id\":42161,\"address\":\"0xaf88d065e77c8cC2239327C5EDb3A432268e5831\",\"onramp\":\"Partner\",\"offramp\":\"Partner\"}"
        );
        let NetworkAssets::Evm(rows) = evm_sections_with(None, None).remove(1).assets else {
            panic!("the Ethereum section must carry EvmAsset rows");
        };
        assert_eq!(
            serde_json::to_string(&rows[0]).unwrap(),
            "{\"token\":\"ZCHF\",\"symbol\":\"ZCHF\",\"decimals\":18,\"min_fraction_digits\":2,\"chain_id\":1,\"address\":\"0xB58E61C3098d85632Df34EecfB899A1Ed80921cB\",\"onramp\":\"Unavailable\",\"offramp\":\"Partner\"}"
        );
        assert_eq!(
            serde_json::to_string(&rows[1]).unwrap(),
            "{\"token\":\"USDC\",\"symbol\":\"USDC\",\"decimals\":6,\"min_fraction_digits\":2,\"chain_id\":1,\"address\":\"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\",\"onramp\":\"Partner\",\"offramp\":\"Partner\"}"
        );
    }

    /// A DEV row's wire bytes: the env-provided mock address lands in the `address` slot with
    /// every other field identical to the prod rows, and the section rides `environment:
    /// "testnet"` (the app's testnet toggle reads the SECTION, D3).
    #[test]
    fn dev_evm_rows_wire_byte_shape() {
        let token = "0x9999999999999999999999999999999999999999";
        let sections = evm_sections_with(Some(token), Some(token));
        assert_eq!(
            serde_json::to_string(&sections[2]).unwrap(),
            "{\"protocol\":\"evm\",\"name\":\"Arbitrum Sepolia\",\"environment\":\"testnet\",\"assets\":[{\"token\":\"ZCHF\",\"symbol\":\"ZCHF\",\"decimals\":18,\"min_fraction_digits\":2,\"chain_id\":421614,\"address\":\"0x9999999999999999999999999999999999999999\",\"onramp\":\"Unavailable\",\"offramp\":\"Unavailable\"}]}"
        );
        assert_eq!(
            serde_json::to_string(&sections[3]).unwrap(),
            "{\"protocol\":\"evm\",\"name\":\"Anvil\",\"environment\":\"testnet\",\"assets\":[{\"token\":\"ZCHF\",\"symbol\":\"ZCHF\",\"decimals\":18,\"min_fraction_digits\":2,\"chain_id\":31337,\"address\":\"0x9999999999999999999999999999999999999999\",\"onramp\":\"Unavailable\",\"offramp\":\"Unavailable\"}]}"
        );
    }

    /// D3's prod-bytes pin: with BOTH dev envs unset the served body is EXACTLY the five
    /// prod sections — the dev-row machinery is invisible on the wire. (The OnceLock-resolved
    /// values are read the same way the route reads them, so the test stays honest about what
    /// environment it is actually running in; the env-unset branch is the one every prod, lean
    /// and test run takes.)
    #[test]
    fn served_wire_unchanged_when_dev_env_unset() {
        let (sep, anv) = env_evm_dev_tokens();
        if sep.is_some() || anv.is_some() {
            return; // a dev-env process: the exact-shape pin above already covers prod shape
        }
        let body = serde_json::to_string(&currencies_body()).unwrap();
        assert_eq!(body.matches("\"protocol\":\"evm\"").count(), 2);
        assert!(body.contains("\"name\":\"Arbitrum One\""));
        assert!(body.contains("\"name\":\"Ethereum\""));
        assert!(!body.contains("\"name\":\"Arbitrum Sepolia\""));
        assert!(!body.contains("\"name\":\"Anvil\""));
        assert_eq!(body.matches("\"protocol\":\"icp\"").count(), 2);
        assert_eq!(body.matches("\"protocol\":\"solana\"").count(), 1);
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
                "solana_amm" => VenueKind::SolanaAmm,
                other => panic!("unknown venue kind in the truth file: {other}"),
            };
            assert_eq!(v.kind, expected_kind);
            // A solana_amm row carries MINTS in pair_ledgers (base58 — the eurc_mint precedent)
            // and MUST NOT carry a fixture: fixtures are the ic_amm offline-fake-IC seeding.
            // Pinned here so a future solana row cannot smuggle an IC fixture in by accident.
            if v.kind == VenueKind::SolanaAmm {
                assert!(
                    v.fixture.is_none(),
                    "{}: a solana_amm venue is ic-fixture-free by rule (fixture is ic_amm-only)",
                    v.venue_id
                );
                assert!(
                    v.endpoint.starts_with("https://"),
                    "{}: a solana_amm endpoint is an https origin (venue identity — dial \
                     targets are the relay proxy)",
                    v.venue_id
                );
            }
            // A cefi row follows the same two invariants: no IC fixture (its offline
            // stand-in is the relay's sideshift test-stub upstream + the e2e page fetch
            // stub), and an https API base as endpoint (the partner-key proxy surface —
            // never a canister principal).
            if v.kind == VenueKind::Cefi {
                assert!(
                    v.fixture.is_none(),
                    "{}: a cefi venue is ic-fixture-free by rule (fixture is ic_amm-only)",
                    v.venue_id
                );
                assert!(
                    v.endpoint.starts_with("https://"),
                    "{}: a cefi endpoint is an https API base (the partner-key proxy surface)",
                    v.venue_id
                );
            }
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
    fn settlement_gate_flags_slow_or_unsettled_and_clears_on_a_passing_probe() {
        // A fast settle is ok; the boundary is pinned exactly (30:00 passes, 30:01 does not).
        assert_eq!(settlement_verdict(true, Some(0)), "ok");
        assert_eq!(settlement_verdict(true, Some(60)), "ok");
        assert_eq!(settlement_verdict(true, Some(SETTLEMENT_SLA_SECONDS)), "ok");
        assert_eq!(
            settlement_verdict(true, Some(SETTLEMENT_SLA_SECONDS + 1)),
            "degraded"
        );
        // No settle observed — stuck in `settling` (the 2026-09-20 live incident), refunded,
        // expired — is degraded at ANY age, never charitably "still probably fine".
        assert_eq!(settlement_verdict(false, None), "degraded");
        assert_eq!(settlement_verdict(false, Some(10)), "degraded");
        // A settled verdict without a measurable latency cannot be certified ok either.
        assert_eq!(settlement_verdict(true, None), "degraded");
        // The probe (tests/swap_venue_mainnet.rs) hardcodes the same 30-minute threshold when
        // it decides a still-pending order is old enough to prove slowness — keep them equal.
        assert_eq!(SETTLEMENT_SLA_SECONDS, 1800);
    }

    #[test]
    fn degraded_venues_demote_to_the_tail_stably() {
        assert_eq!(
            degraded_last(vec!["a-ok", "b-bad", "c-ok", "d-bad"], |r| r.ends_with("-bad")),
            vec!["a-ok", "c-ok", "b-bad", "d-bad"],
            "degraded rows move to the tail; BOTH groups keep their registry order"
        );
        // Uniform registries are byte-identical under demotion — no reordering side effect.
        assert_eq!(degraded_last(vec!["a", "b"], |_| false), vec!["a", "b"]);
        assert_eq!(degraded_last(vec!["a", "b"], |_| true), vec!["a", "b"]);
    }

    #[test]
    fn venue_health_rows_are_real_venues_and_the_reader_derives_the_served_verdict() {
        let raw: Value = serde_json::from_str(include_str!("../../../dfx/venue_health.json"))
            .expect("dfx/venue_health.json must be valid JSON");
        let rows = raw["venues"]
            .as_object()
            .expect("venue_health.venues is an object");
        let registry: Vec<&str> = venues().iter().map(|v| v.venue_id).collect();
        for (id, row) in rows {
            assert!(
                registry.contains(&id.as_str()),
                "venue_health row {id} must name a compiled registry venue — a renamed venue's \
                 stale row is deleted, never tolerated"
            );
            assert!(row["settled"].is_boolean(), "venue_health[{id}].settled must be a bool");
            assert!(
                row["settle_seconds"].is_null() || row["settle_seconds"].is_u64(),
                "venue_health[{id}].settle_seconds must be a number or null"
            );
            assert!(
                row["measured_at"].is_u64(),
                "venue_health[{id}].measured_at must be unix seconds"
            );
            // The serving reader derives the verdict from the raw measurement — assert the
            // round-trip so a reader/parse change cannot silently diverge from the file.
            let settled = row["settled"].as_bool().unwrap();
            let seconds = row["settle_seconds"].as_u64();
            let served = venue_health(id).expect("the row above exists, so the reader must see it");
            assert_eq!(served.status, settlement_verdict(settled, seconds));
            assert_eq!(served.settle_seconds, seconds);
            assert_eq!(served.measured_at, row["measured_at"].as_u64().unwrap());
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
        // The pair-scoped ICPSwap pools resolve for quote attribution too — one allowlisted
        // endpoint per REAL pool, and each resolves to its OWN venue id (never the PoC's).
        for (pool, want_id) in [
            ("mohjv-bqaaa-aaaag-qjyia-cai", "icpswap-ckusdc"),
            ("angxa-baaaa-aaaag-qcvnq-cai", "icpswap-cketh"),
            ("xmiu5-jqaaa-aaaag-qbz7q-cai", "icpswap-ckbtc"),
            ("akhru-myaaa-aaaag-qcvna-cai", "icpswap-ckbtc-cketh"),
            ("hx7nb-diaaa-aaaar-qbxsa-cai", "icpswap-vchf-ckusdc"),
        ] {
            assert_eq!(
                venue_of_endpoint(pool)
                    .expect("the pair-scoped ICPSwap pool resolves")
                    .venue_id,
                want_id
            );
        }
        assert!(venue_of_endpoint(ICP_LEDGER_PRINCIPAL).is_none());
        // The invented principal must PARSE — the fake gateway and the relay tests key pools by
        // principal text, and a typo'd fixture id would fail far from its cause.
        dpay_icp::principal::Principal::from_text("6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7")
            .expect("the fixture-only venue's invented principal parses");
        // A SOLANA venue is never an IC quote target: `venue_of_endpoint` — the allowlist — is
        // ic_amm-only, so Jupiter's https origin (and its mints) resolve to NOTHING here even
        // though the row is registry-served. This is the load-bearing half of the kind guard:
        // `/api/v1/swap_quote` consults exactly this function, so a solana_amm row can never be
        // quoted through the IC rail by mistake (and its mints could never collide with a
        // principal anyway — but the guard is asserted, not assumed).
        assert!(venue_of_endpoint("https://lite-api.jup.ag").is_none());
        assert!(venue_of_endpoint(WRAPPED_SOL_MINT).is_none());
        assert!(venue_of_endpoint(SOLANA_USDC_MINT).is_none());
        // A CEFI venue is never an IC quote target either — same load-bearing guard: the
        // allowlist is ic_amm-only, so SideShift's https API base (and BOTH rail ids of
        // its cross-rail pair, one of which IS a real IC principal that IC pools also
        // trade) resolves to NOTHING. The principal half is the sharp edge this pins:
        // icpswap's rows carry ICP_LEDGER_PRINCIPAL in their own pairs, but an endpoint
        // match is what venue_of_endpoint requires, and a pair member is not an endpoint.
        assert!(venue_of_endpoint("https://sideshift.ai/api/v2").is_none());
        assert!(venue_of_endpoint(ICP_LEDGER_PRINCIPAL).is_none());
        assert!(venue_of_endpoint(WRAPPED_SOL_MINT).is_none());
        // SERVED-by-default (the knob un-armed — the agent build's permanent state, and every
        // build's state before a test opts in): never a fixture venue. Jupiter IS served — it is
        // a real venue (kind solana_amm), just not an IC-servable one: the count includes it and
        // the IC-quote allowlist above excludes it, by design. So are SideShift and Trocador
        // (kind cefi).
        let served: Vec<_> = venues()
            .into_iter()
            .filter(|v| venue_servable(v, false))
            .collect();
        assert_eq!(
            served.len(),
            13,
            "exactly thirteen real venues are served today (six IC pools + three Jupiter + \
             three SideShift + one Trocador aggregator, one row per pair)"
        );
        assert_eq!(
            served
                .iter()
                .map(|v| v.venue_id)
                .collect::<Vec<_>>(),
            vec![
                "icpswap",
                "icpswap-ckusdc",
                "icpswap-cketh",
                "icpswap-ckbtc",
                "icpswap-ckbtc-cketh",
                "icpswap-vchf-ckusdc",
                "jupiter",
                "jupiter-eurc",
                "jupiter-usdc-eurc",
                "sideshift",
                "sideshift-usdc",
                "sideshift-eurc",
                "trocador",
            ],
            "registry order is the stable wire order"
        );
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
