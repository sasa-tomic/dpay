//! OPT-IN mainnet read-only tripwire for the delegated-conversion VENUE — NOT part of
//! check/verify. Network required (https://icp-api.io). Read-only: one anonymous `metadata`
//! QUERY on the PoC pool — no cycles, no state change, no funds, no identity. Run via
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
//! quote, `AgentLedger::swap_pool_metadata`); this probe is what notices if the VENUE itself
//! changes underneath the measured block in `dfx/catalog_truth.json` that the offline fake is
//! seeded from.
//!
//! What it asserts, all against the pool's OWN reply:
//!   1. the venue still answers `metadata` at all, through the production decoder;
//!   2. `token0` / `token1` / `fee` are still exactly `swap_venue` in `dfx/catalog_truth.json`;
//!   3. the pool's own `key` (`<token0>_<token1>_<fee>`) agrees with those three — the venue's
//!      internal cross-check, so a pool that renamed its pair without changing the fields is
//!      caught too;
//!   4. **the live rate comes out the right way up.** The REAL `/api/v1/swap_quote` route is
//!      driven (the production axum handler over an `AgentLedger` pointed at mainnet) in BOTH
//!      directions, and each quoted amount is checked against the price the pool itself
//!      publishes in the SAME reply (`sqrtPriceX96`). That comparison is market-independent —
//!      it uses the venue's own current price, not a number anyone pinned — and an inverted
//!      direction misses it by the square of the price (the 2026-09-07 build was off by ~5.9x).

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

/// The one trade this probe quotes, in raw units. Both sides of this pair are 8-decimal (pinned
/// from `decimals.vchf` / `decimals.icp` below), so a raw-unit rate IS a unit rate.
const PROBE_AMOUNT_IN: u64 = 100_000_000;

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
async fn route_quote(state: &AppState, pool: &str, token_in: &str, token_out: &str) -> Value {
    let uri = format!(
        "/api/v1/swap_quote?pool={pool}&token_in={token_in}&token_out={token_out}\
         &amount_in={PROBE_AMOUNT_IN}"
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

fn swap_venue_truth() -> Value {
    serde_json::from_str::<Value>(CATALOG_TRUTH)
        .expect("dfx/catalog_truth.json must be valid JSON")["swap_venue"]
        .clone()
}

#[test]
fn swap_venue_mainnet_pair_and_fee_still_match_the_measured_truth() {
    if std::env::var("DPAY_IC_MAINNET").is_err() {
        eprintln!("skipped: set DPAY_IC_MAINNET=1 (opt-in mainnet probe, needs network)");
        return;
    }
    let truth = swap_venue_truth();
    let pool_text = truth["pool"].as_str().expect("swap_venue.pool");
    let want0 = truth["token0_ledger"].as_str().expect("swap_venue.token0_ledger");
    let want1 = truth["token1_ledger"].as_str().expect("swap_venue.token1_ledger");
    let want_fee = truth["fee_millionths"].as_u64().expect("swap_venue.fee_millionths");
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
            "swap-venue mainnet probe: pool {pool_text} reports token0={} token1={} fee={}",
            meta.token0_ledger, meta.token1_ledger, meta.fee_millionths
        );
        assert_eq!(
            meta.token0_ledger, want0,
            "the LIVE venue's token0 no longer matches dfx/catalog_truth.json swap_venue — the \
             offline fake is seeded from that block, so re-measure it (and check what else at \
             this pool changed) before shipping another quote"
        );
        assert_eq!(meta.token1_ledger, want1, "the LIVE venue's token1 drifted from the truth block");
        assert_eq!(
            meta.fee_millionths,
            u128::from(want_fee),
            "the LIVE venue's fee tier drifted from the truth block (the app shows this number)"
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
        // The pool publishes its own price in the same reply: token1-per-token0 =
        // (sqrtPriceX96 / 2^96)^2. Both sides of this pair are 8-decimal, so that ratio is
        // directly a unit rate — assert that, rather than assume it.
        let truth_all: Value =
            serde_json::from_str(CATALOG_TRUTH).expect("catalog_truth is JSON");
        assert_eq!(truth_all["decimals"]["vchf"], truth_all["decimals"]["icp"]);
        let sqrt = k.sqrt_price_x96.0.to_f64().expect("sqrtPriceX96 fits f64") / Q96;
        let price_t1_per_t0 = sqrt * sqrt;

        let state = AppState::new(Arc::new(
            AgentLedger::connect_with(MAINNET_URL, pool, false)
                .await
                .expect("AgentLedger connect to mainnet"),
        ));
        let amount_in = PROBE_AMOUNT_IN as f64;
        // Each direction, quoted by the real handler, against the venue's own price. A quote is
        // the price MINUS the fee tier and minus price impact, so it must land just under
        // parity — never above it, and nowhere near an inverted figure.
        for (label, token_in, token_out, expected) in [
            ("token0→token1", want0, want1, amount_in * price_t1_per_t0),
            ("token1→token0", want1, want0, amount_in / price_t1_per_t0),
        ] {
            let body = route_quote(&state, pool_text, token_in, token_out).await;
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
                "swap-venue mainnet probe: {label} {PROBE_AMOUNT_IN} → {out} \
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
