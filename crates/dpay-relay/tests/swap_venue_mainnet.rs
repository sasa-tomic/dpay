//! OPT-IN mainnet read-only tripwire for the delegated-conversion VENUES — NOT part of
//! check/verify. Network required (https://icp-api.io). Read-only: one anonymous `metadata`
//! QUERY per REAL venue pool — no cycles, no state change, no funds, no identity. Run via
//! `just swap-venue-probe` (the sibling of `ic-index-probe` / `ocp-ledger-probe`; without
//! `DPAY_IC_MAINNET=1` the test prints "skipped" and returns, so the offline hot path never
//! touches the network).
//!
//! WHY THIS EXISTS AND WHY IT CANNOT BE A `test-live` CASE. `just test-live` runs against
//! PocketIC, which has no ICPSwap pool in it — it is structurally incapable of observing a fact
//! about a venue on mainnet. On 2026-09-07 the relay pinned the pool's token pair as a compiled
//! constant AND seeded the offline fake from that same pin. The two agreed with each other and
//! neither agreed with the venue: `token0` is VCHF and `token1` is ICP, the exact reverse of the
//! pin. Live production therefore answered every ICP→VCHF quote with the VCHF→ICP rate —
//! 0.41194138 where the truth was 2.41297899, wrong by ~5.9x AGAINST THE USER — behind a fully
//! green suite. Production no longer pins the pair (it reads the pool's own `metadata` on every
//! quote, `AgentLedger::swap_pool_metadata`); this probe is what notices if a VENUE itself
//! changes underneath the measured `dfx/catalog_truth.json` `venues[].fixture` block that the
//! offline fake is seeded from.
//!
//! MULTI-VENUE (2026-09-10 Wave 1, updated Wave 2): the probe walks EVERY registry entry —
//! but only the REAL ones. A `test_helpers_served` venue is pinned fixture-truth with an
//! explicit NOT-A-REAL-VENUE marker precisely so this loop can skip it: an invented principal
//! must never be probed on mainnet (and the agent-build allowlist would refuse it anyway).
//!
//! What it asserts, per real venue, all against the pool's OWN reply:
//!   1. the venue still answers `metadata` at all, through the production decoder;
//!   2. `token0` / `token1` / `fee` are still exactly the `venues[].fixture` block in
//!      `dfx/catalog_truth.json`;
//!   3. the pool's own `key` (`<token0>_<token1>_<fee>`) agrees with those three — the venue's
//!      internal cross-check, so a pool that renamed its pair without changing the fields is
//!      caught too;
//!   4. **the live rate comes out the right way up.** The REAL `/api/v1/swap_quote` route is
//!      driven (the production axum handler over an `AgentLedger` pointed at mainnet) in BOTH
//!      directions, each reply carries its `venue_id` attribution, and each quoted amount is
//!      checked against the price the pool itself publishes in the SAME reply
//!      (`sqrtPriceX96`). That comparison is market-independent — it uses the venue's own
//!      current price, not a number anyone pinned — and an inverted direction misses it by the
//!      square of the price (the 2026-09-07 build was off by ~5.9x).

#![cfg(feature = "agent")]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use candid::{decode_one, encode_args, CandidType, Nat, Principal};
use http_body_util::BodyExt;
use num_traits::ToPrimitive;
use serde::Deserialize;
use serde_json::Value;
use tower::ServiceExt; // oneshot

use dpay_relay::agent_ledger::{AgentLedger, IcpPoolMetadataResult};
use dpay_relay::{app, AppState, Ledger};

const MAINNET_URL: &str = "https://icp-api.io";

const CATALOG_TRUTH: &str = include_str!("../../../dfx/catalog_truth.json");

/// 2^96, the fixed-point scale of the pool's `sqrtPriceX96`.
const Q96: f64 = 79_228_162_514_264_337_593_543_950_336.0;

/// The t0-side probe for an 8/8-decimal pair, in raw units (1 whole token0). The VCHF/ICP pair
/// keeps exactly this historical probe; mixed-decimal pairs (ICP↔ckUSDC 8/6, ICP↔ckETH 8/18)
/// probe `PROBE_AMOUNT_MIXED` on the t0 side and a price-sized t0-equivalent on the t1 side —
/// see `probe_real_venue`, which sizes per venue from the truth file's `decimals`.
const PROBE_AMOUNT_8_8: u64 = 100_000_000;
/// ~2 ICP worth of raw (the task-sized probe for the pair-scoped ICP pools — large enough that
/// a quote is never dust, small enough to be price-impact-nothing on these depths).
const PROBE_AMOUNT_MIXED: u64 = 200_000_000;

/// The decimals a traded ledger carries, from the truth file's own `decimals` map (keyed by the
/// ledger's `principals` name — ckETH's 18 decimals live under `eth`). Panics on an unknown
/// ledger so a future venue on a new token FAILS the probe until its decimals are wired here —
/// the probe sizes its quotes from this, and a wrong size on an 18-decimal token is dust.
fn ledger_decimals(truth: &Value, ledger: &str) -> u64 {
    let (principals, decimals) = (&truth["principals"], &truth["decimals"]);
    for (ledger_key, dec_key) in [
        ("icp_ledger", "icp"),
        ("vchf_ledger", "vchf"),
        ("ckusdc_ledger", "ckusdc"),
        ("cketh_ledger", "eth"),
    ] {
        if principals[ledger_key].as_str() == Some(ledger) {
            return decimals[dec_key]
                .as_u64()
                .unwrap_or_else(|| panic!("truth decimals.{dec_key} must be a number"));
        }
    }
    panic!("no truth-file decimals for ledger {ledger} — extend ledger_decimals for the new pair");
}

/// The venue's `key` and `sqrtPriceX96` — the factory's identity for this pool and the price it
/// publishes. Neither is part of [`dpay_relay::agent_ledger::IcpPoolMetadata`] (the relay has no
/// use for them), so this probe declares its own wider mirror to cross-check the fields that ARE
/// used against the venue's own self-description.
#[derive(CandidType, Deserialize, Debug)]
struct WideMetadata {
    fee: Nat,
    key: String,
    #[serde(rename = "sqrtPriceX96")]
    sqrt_price_x96: Nat,
}

#[derive(CandidType, Deserialize, Debug)]
#[allow(non_camel_case_types)]
enum WideMetadataResult {
    ok(WideMetadata),
    err(dpay_relay::agent_ledger::IcpSwapError),
}

/// One real `GET /api/v1/swap_quote` through the PRODUCTION router.
async fn route_quote(
    state: &AppState,
    pool: &str,
    token_in: &str,
    token_out: &str,
    amount_in: u64,
) -> Value {
    let uri = format!(
        "/api/v1/swap_quote?pool={pool}&token_in={token_in}&token_out={token_out}\
         &amount_in={amount_in}"
    );
    let resp = app(state.clone())
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .expect("the route answers");
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).expect("the route answers JSON");
    assert_eq!(status, StatusCode::OK, "swap_quote must answer 200: {body}");
    body
}

fn venues_truth() -> Vec<Value> {
    serde_json::from_str::<Value>(CATALOG_TRUTH).expect("dfx/catalog_truth.json must be valid JSON")
        ["venues"]
        .as_array()
        .expect("truth venues is an array")
        .clone()
}

/// Every REAL venue, one at a time. `test_helpers_served` entries are pinned fixture-truth
/// with an explicit NOT-A-REAL-VENUE marker precisely so this loop can skip them: an invented
/// principal must never be probed on mainnet (and the agent-build allowlist would refuse it
/// anyway — the knob that serves it offline does not exist in this build).
#[test]
fn venues_mainnet_pair_and_fee_still_match_the_measured_truth() {
    if std::env::var("DPAY_IC_MAINNET").is_err() {
        eprintln!("skipped: set DPAY_IC_MAINNET=1 (opt-in mainnet probe, needs network)");
        return;
    }
    // The per-venue probe sizing needs each pair's decimals — read per venue off the truth
    // file inside `probe_real_venue` (`ledger_decimals`), which fails loud on a ledger it
    // does not know instead of assuming a symmetric 8/8 pair.
    let mut probed = 0;
    for venue in &venues_truth() {
        if venue
            .get("test_helpers_served")
            .is_some_and(|f| f.as_bool().unwrap())
        {
            continue;
        }
        probe_real_venue(venue);
        probed += 1;
    }
    assert!(probed > 0, "the registry must hold at least one real venue");
}

fn probe_real_venue(venue: &Value) {
    let venue_id = venue["venue_id"].as_str().expect("venue_id");
    let fixture = &venue["fixture"];
    let pool_text = venue["endpoint"].as_str().expect("venue.endpoint");
    let want0 = fixture["token0_ledger"]
        .as_str()
        .expect("fixture.token0_ledger");
    let want1 = fixture["token1_ledger"]
        .as_str()
        .expect("fixture.token1_ledger");
    let want_fee = fixture["fee_millionths"]
        .as_u64()
        .expect("fixture.fee_millionths");
    let pool = Principal::from_text(pool_text).expect("the pinned pool principal parses");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        // 1+2. Through the PRODUCTION read path — the same method `/api/v1/swap_quote` calls,
        //      so a decode regression fails here too, not just a venue change.
        //      `fetch_root_key = false`: mainnet, per connect_with's contract.
        let agent = AgentLedger::connect_with(MAINNET_URL, pool, false)
            .await
            .expect("AgentLedger connect to mainnet");
        let meta = agent
            .swap_pool_metadata(pool_text)
            .await
            .expect("the venue answers metadata through the production read path");
        eprintln!(
            "swap-venue mainnet probe [{venue_id}]: pool {pool_text} reports token0={} token1={} fee={}",
            meta.token0_ledger, meta.token1_ledger, meta.fee_millionths
        );
        assert_eq!(
            meta.token0_ledger, want0,
            "the LIVE venue's token0 no longer matches dfx/catalog_truth.json \
             venues[{venue_id}].fixture — the offline fake is seeded from that block, so \
             re-measure it (and check what else at this pool changed) before shipping another \
             quote"
        );
        assert_eq!(
            meta.token1_ledger, want1,
            "the LIVE venue's token1 drifted from the truth fixture block"
        );
        assert_eq!(
            meta.fee_millionths,
            u128::from(want_fee),
            "the LIVE venue's fee tier drifted from the truth fixture block (the app shows this number)"
        );

        // 3. The venue's OWN cross-check: `key` is `<token0>_<token1>_<fee>`.
        let raw = ic_agent::Agent::builder()
            .with_url(MAINNET_URL)
            .build()
            .expect("build mainnet agent")
            .query(&pool, "metadata")
            .with_arg(encode_args(()).expect("encode empty metadata arg"))
            .call()
            .await
            .expect("metadata query on the pinned pool");
        let WideMetadataResult::ok(k) =
            decode_one::<WideMetadataResult>(&raw).expect("metadata reply decodes")
        else {
            panic!("the venue answered metadata with #err");
        };
        assert_eq!(
            k.key,
            format!("{want0}_{want1}_{want_fee}"),
            "the pool's own key disagrees with its own token0/token1/fee"
        );
        assert_eq!(k.fee.0.to_u128(), Some(u128::from(want_fee)));

        // The decoded reply must ALSO round-trip through the production mirror type, so this
        // probe fails if the mirror stops matching the venue's shape.
        let mirrored = decode_one::<IcpPoolMetadataResult>(&raw)
            .expect("the production mirror decodes the LIVE reply");
        assert!(matches!(mirrored, IcpPoolMetadataResult::ok(_)));

        // 4. THE RATE, THE RIGHT WAY UP — driven through the PRODUCTION route.
        //
        // The pool publishes its own price in the same reply: token1-per-token0 (in RAW units,
        // each side in its own token's base) = (sqrtPriceX96 / 2^96)^2. That RAW ratio is
        // decimals-agnostic — `out_raw = in_raw × price_raw` holds whatever each side's
        // decimals are. Where decimals DO bite is probe SIZING: a t1 side with more decimals
        // than t0 needs its own raw amount or the reverse direction quotes dust (100_000_000
        // raw ckETH = 1e-10 ckETH), and fewer decimals (ckUSDC, 6) makes 1e8 raw = 100 USDC.
        // So: an 8/8 pair keeps its historical symmetric raw probe (the VCHF pair's behavior,
        // byte-for-byte); a mixed pair probes ~2 whole t0 units forward and the price-equivalent
        // t1 amount in reverse — each leg lands on the same economic size.
        let truth_all: Value = serde_json::from_str(CATALOG_TRUTH).expect("catalog_truth is JSON");
        let d0 = ledger_decimals(&truth_all, want0);
        let d1 = ledger_decimals(&truth_all, want1);
        eprintln!("swap-venue mainnet probe [{venue_id}]: pair decimals {d0}/{d1}");
        let sqrt = k.sqrt_price_x96.0.to_f64().expect("sqrtPriceX96 fits f64") / Q96;
        let price_t1_per_t0 = sqrt * sqrt;

        let state = AppState::new(Arc::new(
            AgentLedger::connect_with(MAINNET_URL, pool, false)
                .await
                .expect("AgentLedger connect to mainnet"),
        ));
        let (amt_t0, amt_t1) = if d0 == d1 {
            (PROBE_AMOUNT_8_8, PROBE_AMOUNT_8_8)
        } else {
            // The t0-equivalent in t1's raw units; clamped into u64 (a hostile price never
            // panics the probe — the ratio assert below does the real judging).
            let t1_equiv = (PROBE_AMOUNT_MIXED as f64 * price_t1_per_t0).round();
            (PROBE_AMOUNT_MIXED, t1_equiv.clamp(1.0, 9.0e18) as u64)
        };
        // Each direction, quoted by the real handler, against the venue's own price. A quote is
        // the price MINUS the fee tier and minus price impact, so it must land just under
        // parity — never above it, and nowhere near an inverted figure.
        for (label, token_in, token_out, amount_in, expected) in [
            ("token0→token1", want0, want1, amt_t0, amt_t0 as f64 * price_t1_per_t0),
            ("token1→token0", want1, want0, amt_t1, amt_t1 as f64 / price_t1_per_t0),
        ] {
            let body = route_quote(&state, pool_text, token_in, token_out, amount_in).await;
            assert_eq!(
                body["venue_id"], venue_id,
                "the route's reply must be attributable to this venue"
            );
            assert_eq!(
                body["zero_for_one"].as_bool(),
                Some(token_in == meta.token0_ledger),
                "the route's direction must be DERIVED from the pool's own token0, not pinned"
            );
            assert_eq!(body["fee_millionths"].as_u64(), Some(want_fee));
            let out: f64 = body["amount_out"]
                .as_str()
                .expect("amount_out is a decimal string")
                .parse()
                .expect("amount_out parses");
            let ratio = out / expected;
            eprintln!(
                "swap-venue mainnet probe: {label} {amount_in} → {out} \
                 (pool's own price implies {expected:.0}; ratio {ratio:.6})"
            );
            assert!(
                (0.95..=1.0).contains(&ratio),
                "{label}: the route quoted {out} where the pool's OWN published price implies \
                 {expected:.0} (ratio {ratio:.6}). A quote must sit just under the pool price \
                 (0.30% fee + impact); a ratio far off parity means the direction is inverted — \
                 exactly the 2026-09-07 defect."
            );
        }
    });
}
