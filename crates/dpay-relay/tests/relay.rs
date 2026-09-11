//! End-to-end relay tests — the fast, in-memory inner loop. No socket is bound: we drive the
//! axum `Router` directly with `tower::ServiceExt::oneshot`.
//!
//! 2026-08-19 IC-rail cutover: the relay's settlement surface (/pay, /withdraw, /receipt,
//! /deposit/address, /deposit/refresh) is GONE — value moves on the IC rail, with the app
//! signing /api/v2 envelopes locally and submitting them to the boundary nodes (icp-api.io in
//! prod; this relay's fake-IC gateway under `test-helpers` in tests). What the relay still
//! serves, covered here:
//! - read surfaces: /balances (batch), /transactions (history), /currencies, /deposit/info,
//!   /onramp/ckerc20, /health, /capabilities, /version;
//! - test-only value fixtures against the fake-IC gateway: POST /faucet + GET /balance
//!   (principal-keyed, exactly where a signed icrc1_transfer moves funds);
//! - the fake-IC /api/v2 boundary itself: mounting, garbage-envelope rejection, and a REAL
//!   signed icrc1_transfer executed by the gateway (verify → dedup → execute → history);
//! - the public root: landing page, privacy, /wallet (the real app), APK download, screenshots,
//!   /dpay-core.wasm.
//!
//! `test-helpers` IS ALWAYS ON IN THIS FILE — do not re-derive it, and do not write a `cfg` that
//! tests for it. `Cargo.toml`'s `[dev-dependencies]` names this very package back at itself,
//! `dpay-relay = { path = ".", features = ["test-helpers"] }`, so cargo compiles the integration
//! test target with `--cfg feature="test-helpers"` in every build, `agent` or not (verified
//! 2026-09-08 by reading the rustc invocation out of `cargo test -p dpay-relay --test relay
//! --no-run -v`). A `cfg(all(feature = "test-helpers", not(feature = "agent")))` therefore says
//! only `not(agent)` while LOOKING like a two-feature condition, and this suite has already been
//! bitten once by an expectation copied from the implementation's own `cfg`. The ONE axis that
//! actually varies here is `agent`: off ⇒ the fake-IC gateway serves the value path, on ⇒ a live
//! replica does. Gate on that and nothing else.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use sha2::Digest;
use tower::ServiceExt; // oneshot

use dpay_core::{
    sign_till_open, validate_till_open, Currency, TillOpen, DEMO_USD, NONCE_LEN, SIG_LEN,
    TILL_OPEN_MAX_SKEW_SECS,
};
use dpay_icp::envelope::{
    ingress_expiry, sign_read_state, sign_update, verify_envelope, CallRequest,
};
use dpay_icp::icrc::{
    approve_arg, decode_approve_result, decode_legacy_transfer_result, decode_swap_result,
    deposit_and_swap_arg, legacy_transfer_arg, transfer_arg, ApproveResult, LegacyTransferError,
    LegacyTransferResult, PoolSwapError,
};
use dpay_icp::principal::{Account, AccountIdentifier, Principal};
use dpay_icp::reply::{decode_read_state_tree, request_status, RequestStatus};
use dpay_relay::till::{iso8601_utc, QUOTE_TTL_SECS};
use dpay_relay::{app, ic_gateway::FakeIc, ledger::FAKE_FACADE_MODULE_HASH, AppState, FakeLedger};
use ed25519_dalek::SigningKey;

/// The compiled catalog's DEMO_USD ledger principal (currency 0 — `crate::catalog`'s
/// `DEMO_LEDGER_PRINCIPAL`, `pub(crate)` so not importable from an integration test; the
/// catalog_truth drift test pins the pair). The fake-IC gateway keys the DEMO fake ledger at
/// this text, so signed DEMO transfers target it.
const DEMO_LEDGER: &str = "td2nx-oaaaa-aaaab-qhdnq-cai";

/// The compiled catalog's native-ICP row (currency 8): the canonical mainnet ledger and its fee,
/// both pinned by the catalog_truth drift test. This is the ONLY ledger with the legacy `transfer`
/// method — the one that can pay a 64-hex account identifier.
const ICP_LEDGER: &str = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const ICP: Currency = 8;
const ICP_FEE_E8S: u64 = 10_000;

// --- helpers -------------------------------------------------------------

fn keypair() -> SigningKey {
    dpay_core::generate_keypair()
}

fn pubkey(sk: &SigningKey) -> [u8; 32] {
    sk.verifying_key().to_bytes()
}

/// The IC account owner a device pubkey maps to — the self-authenticating principal the
/// fake-IC gateway keys balances/txns by (the same account a signed icrc1_transfer moves).
fn user_principal(pk: &[u8; 32]) -> Principal {
    Principal::self_authenticating_ed25519(pk)
}

/// A bare FakeLedger (read-surface catalog only — balances live on the fake-IC gateway at
/// user principals, so there is nothing to pre-fund here).
fn ledger() -> FakeLedger {
    FakeLedger::new()
}

fn state_from(ledger: FakeLedger) -> (AppState, Arc<FakeLedger>) {
    let arc = Arc::new(ledger);
    (AppState::new(arc.clone()), arc)
}

/// A state with the fake-IC gateway attached (test-helpers): `/api/v2/canister/*` is served and
/// the faucet fixture + the balances/transactions routes read the gateway's principal-keyed
/// ledgers. The faucet is declared available because in THIS build the attached gateway is
/// exactly what its route credits — the shape `main` builds for the e2e image, and the shape the
/// funding used across this file needs. (Under `agent` the route is the production one instead,
/// which a `FakeLedger` cannot serve; the tests that fund through it are compiled out there.)
async fn state_with_fake(ledger: FakeLedger) -> (AppState, Arc<FakeLedger>, Arc<FakeIc>) {
    let arc = Arc::new(ledger);
    let fake = FakeIc::from_catalog();
    let state = AppState::new(arc.clone())
        .with_fake_ic(fake.clone())
        .with_faucet(true);
    (state, arc, fake)
}

/// POST /api/v1/faucet — the demo on-ramp. `amount_json` is a pre-rendered JSON value for the
/// amount (quoted decimal string OR raw number — the deserializer takes both); `None` omits the
/// field (the faucet's default top-up). Offline fixture build only — under `agent` the route is
/// the production faucet, which a `FakeLedger` cannot serve, so every caller here is compiled out.
#[cfg(not(feature = "agent"))]
fn faucet_json(account_hex: &str, amount_json: Option<&str>) -> Request<Body> {
    let body = match amount_json {
        Some(a) => format!("{{\"account\":\"{account_hex}\",\"amount\":{a}}}"),
        None => format!("{{\"account\":\"{account_hex}\"}}"),
    };
    Request::builder()
        .method("POST")
        .uri("/api/v1/faucet")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

fn now_ns() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

/// The same instant in whole seconds — what a merchant's `issued_at` is measured in, and what the
/// till compares it against.
fn unix_secs() -> u64 {
    now_ns() / 1_000_000_000
}

async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

/// `call` for method-probe responses (404/405 carry an EMPTY body — nothing to parse).
async fn call_status(state: &AppState, req: Request<Body>) -> StatusCode {
    app(state.clone()).oneshot(req).await.unwrap().status()
}

/// A bare GET request — for the non-JSON pages (landing, privacy, wallet, APK).
fn get_req(uri: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

/// Like `call`, but returns the raw status/headers/bytes (the pages and /api/v2 aren't JSON).
async fn call_raw(
    state: &AppState,
    req: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let resp = app(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}

// --- health / version ------------------------------------------------------

#[tokio::test]
async fn health_ok() {
    let (state, _led) = state_from(ledger());

    let req = Request::builder()
        .method("GET")
        .uri("/api/v1/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

/// A bare relay — no till, and no backend its faucet could credit (no fake-IC gateway attached,
/// and a `FakeLedger` that cannot mint) — advertises neither surface.
#[tokio::test]
async fn capabilities_report_default_state() {
    let (state, _led) = state_from(ledger());

    let (status, body) = call(&state, get_req("/api/v1/capabilities")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        serde_json::json!({"till": false, "demo_faucet": false})
    );
}

/// The reported till capability reads the same immutable state flag that registers its routes.
#[tokio::test]
async fn capabilities_report_enabled_till() {
    let (state, _led) = state_from(ledger());
    let state = state.with_till(true);

    let (status, body) = call(&state, get_req("/api/v1/capabilities")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        serde_json::json!({"till": true, "demo_faucet": false})
    );
}

/// Drive `POST /api/v1/faucet` on the SAME router the capability is read from, and report whether
/// the account actually gained funds. Deliberately amount-pinned to the canonical top-up
/// (`crate::faucet::FAUCET_AMOUNT` = 10_000, what the app's TOP_UP_CENTS sends) so BOTH builds'
/// handlers judge AVAILABILITY here and never the denomination — the production branch refuses
/// any other amount before it looks at anything else.
#[cfg(not(feature = "agent"))]
async fn faucet_route_credits(state: &AppState, pk: &[u8; 32]) -> (bool, StatusCode, Value) {
    let (status, body) = call(state, faucet_json(&hex::encode(pk), Some("10000"))).await;
    (status.is_success(), status, body)
}

/// The advertised `demo_faucet` capability is MEASURED against the router, never re-derived from
/// the same `cfg!` expression the implementation uses — a tautological expectation stays green
/// while the implementation lies, which is exactly how production came to advertise no faucet
/// while minting through one. Two states whose faucet BACKING genuinely differs, one assertion:
/// what the route does is what the capability says.
///
/// Scoped to the offline fixture build, because that is where a faucet backed by the attached
/// gateway can actually credit. The production build's half of this pairing — an agent that holds
/// the controller identity versus an anonymous one, against a REAL canister — is
/// `live_capability_demo_faucet_equals_what_the_faucet_route_does` in `tests/live.rs`.
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn capability_demo_faucet_equals_what_the_faucet_route_does() {
    // (1) The gateway-backed relay — the shape the e2e image runs.
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let pk = pubkey(&keypair());
    let owner = user_principal(&pk);
    let before = fake.balance_for(DEMO_USD, &owner);

    let (credited, fs, fb) = faucet_route_credits(&state, &pk).await;
    assert_eq!(
        credited,
        fake.balance_for(DEMO_USD, &owner) > before,
        "a faucet answer that succeeded must have moved funds, and one that refused must not \
         (faucet answered {fs}: {fb})",
    );
    let (cs, cb) = call(&state, get_req("/api/v1/capabilities")).await;
    assert_eq!(cs, StatusCode::OK, "{cb}");
    assert_eq!(
        cb["demo_faucet"], credited,
        "advertised demo_faucet must equal what POST /api/v1/faucet did — gateway attached, \
         faucet answered {fs}: {fb}",
    );

    // (2) The SAME build with nothing behind the faucet: no gateway for the fixture branch to
    // credit, and a ledger that cannot mint for the production branch to call.
    let (bare, _led2) = state_from(ledger());
    let (bare_credited, bfs, bfb) = faucet_route_credits(&bare, &pubkey(&keypair())).await;
    assert!(
        !bare_credited,
        "nothing backs this relay's faucet, so it cannot credit (answered {bfs}: {bfb})",
    );
    let (bs, bb) = call(&bare, get_req("/api/v1/capabilities")).await;
    assert_eq!(bs, StatusCode::OK, "{bb}");
    assert_eq!(
        bb["demo_faucet"], false,
        "a relay whose faucet cannot credit must not advertise one",
    );
}

/// The three shapes `build.rs` can bake into the commit field, in ONE place because two routes
/// mirror the same value: a 40-char SHA (clean checkout), that SHA plus `-dirty` (a build from an
/// uncommitted tree — `deploy/build.sh` compiles the working tree, so uncommitted code really does
/// ship and the image corresponds to no commit), or `unknown` (no git at all, e.g. a release
/// tarball). Asserting the bare SHA alone is what let a dirty image report a clean identity.
fn is_baked_commit(commit: &str) -> bool {
    let sha = commit.strip_suffix("-dirty").unwrap_or(commit);
    commit == "unknown" || (sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()))
}

/// `GET /api/v1/version` reports the relay's name + pkg version + the git commit and its
/// committer date baked by `build.rs`. The commit is the deploy-fidelity primitive
/// (verify-relay-version.sh compares it to HEAD); this test pins the route's shape + that both
/// baked fields are present (non-empty), so a future change that drops the build.rs wiring
/// surfaces here.
#[tokio::test]
async fn version_route_reports_baked_commit() {
    let (state, _led) = state_from(ledger());

    let (status, body) = call(&state, get_req("/api/v1/version")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "dpay-relay");
    // The pkg version is a non-empty string (CARGO_PKG_VERSION); don't pin the exact number so a
    // bump doesn't break this test, just assert it's present.
    assert!(
        body["version"].as_str().unwrap_or("").len() > 0,
        "version present: {body}"
    );
    let commit = body["commit"].as_str().expect("commit present");
    // In the test build (run from the repo) the commit MUST be a real baked identity — proves
    // build.rs wired through. A dirty checkout is the normal state while working, so the shape
    // includes the `-dirty` marker; `unknown` is refused here because we ARE in a git checkout.
    assert!(
        is_baked_commit(commit) && commit != "unknown",
        "commit must be a baked git identity when built in a checkout, got {commit:?}"
    );
    // The date is the commit's ISO-8601 committer date (`git show -s --format=%cI`), e.g.
    // "2026-08-27T09:41:00+02:00" — starts with the 4-digit year. "unknown" only outside git.
    let date = body["commit_date"].as_str().expect("commit_date present");
    assert!(
        date.starts_with("20") || date == "unknown",
        "commit_date must be an ISO date (git checkout) or \"unknown\", got {date:?}"
    );
}

// --- integrity (facade module-hash pinning; GOVERNANCE row 7) -----------------------------
//
// The route's two halves: the LIVE hash through the Ledger seam (FakeLedger here — its default
// answers the deterministic all-ff hash, and its knobs bend live/unreachable), and the PIN baked
// by build.rs. Test-helpers builds bake the SAME deterministic hash as the pin
// (build.rs `TEST_HELPERS_PIN`, which cannot import this crate), so the default state reads
// MATCH without depending on the real, upgrade-chasing `deploy/facade-module-hash.txt`.
// `integrity_route_reports_the_baked_pin` pins that the two constants never drift.

/// The PURE classifier's full matrix — all four states, including the precedence call (both
/// halves missing → UNPINNED: without a reference there is no integrity surface at all).
#[test]
fn integrity_classifier_covers_all_four_states() {
    use dpay_relay::app::classify_integrity as classify;
    assert_eq!(classify(Some("a"), Some("a")), "MATCH");
    assert_eq!(classify(Some("a"), Some("b")), "MISMATCH");
    assert_eq!(classify(None, Some("b")), "UNREACHABLE");
    assert_eq!(classify(Some("a"), None), "UNPINNED");
    // Both halves missing: no pin is the operator's first problem — say that, not "unreachable".
    assert_eq!(classify(None, None), "UNPINNED");
}

/// The pin baked for this (test-helpers) build is the FakeLedger's deterministic hash — the
/// duplication build.rs cannot avoid (a build script cannot import the crate it builds) is
/// pinned here, so the MATCH state below can never silently rot into MISMATCH.
#[test]
fn integrity_baked_pin_matches_the_fake_ledgers_hash() {
    assert_eq!(env!("DPAY_PINNED_FACADE_HASH"), FAKE_FACADE_MODULE_HASH);
}

/// `GET /api/v1/integrity` with a named facade and the FakeLedger's default answer: MATCH, both
/// hashes present and equal, the canister named, and the relay commit riding along (the same
/// baked SHA /version reports — the two halves of an upgrade in one response).
#[tokio::test]
async fn integrity_route_reports_match_by_default() {
    let (state, _led) = state_from(ledger());
    let state = state.with_facade_canister("ssqti-wiaaa-aaaab-qhdia-cai".to_string());

    let (status, body) = call(&state, get_req("/api/v1/integrity")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "MATCH", "{body}");
    assert_eq!(body["facade_canister"], "ssqti-wiaaa-aaaab-qhdia-cai");
    assert_eq!(body["live_module_hash"], FAKE_FACADE_MODULE_HASH);
    assert_eq!(body["pinned_module_hash"], FAKE_FACADE_MODULE_HASH);
    let commit = body["relay_commit"].as_str().expect("relay_commit present");
    assert!(
        is_baked_commit(commit),
        "relay_commit mirrors /version: {body}"
    );
}

/// A live hash that differs from the pin (an unrecorded upgrade, or any drift between the two
/// halves) is a MISMATCH — never an error: the route reports, it does not fail.
#[tokio::test]
async fn integrity_route_reports_mismatch_when_live_drifts() {
    let (state, led) = state_from(ledger());
    let state = state.with_facade_canister("ssqti-wiaaa-aaaab-qhdia-cai".to_string());
    led.set_facade_hash(Some(
        "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
    ));

    let (status, body) = call(&state, get_req("/api/v1/integrity")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "MISMATCH", "{body}");
    assert_eq!(
        body["live_module_hash"],
        "0000000000000000000000000000000000000000000000000000000000000000"
    );
    assert_eq!(body["pinned_module_hash"], FAKE_FACADE_MODULE_HASH);
}

/// An unreachable IC (the ledger seam erroring) degrades to a 200 UNREACHABLE with a null live
/// hash — the documented contract: a report, never a 5xx.
#[tokio::test]
async fn integrity_route_degrades_to_unreachable_not_5xx() {
    let (state, led) = state_from(ledger());
    let state = state.with_facade_canister("ssqti-wiaaa-aaaab-qhdia-cai".to_string());
    led.set_facade_unreachable();

    let (status, body) = call(&state, get_req("/api/v1/integrity")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "UNREACHABLE", "{body}");
    assert!(
        body["live_module_hash"].is_null(),
        "no live hash when the IC is unreachable: {body}"
    );
    assert_eq!(body["pinned_module_hash"], FAKE_FACADE_MODULE_HASH);
}

/// A relay with NO facade named (the memory-ledger demo build) is honest about having no live
/// half to compare: UNREACHABLE with a null canister, pin still reported.
#[tokio::test]
async fn integrity_route_without_a_facade_reports_no_live_hash() {
    let (state, _led) = state_from(ledger());

    let (status, body) = call(&state, get_req("/api/v1/integrity")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "UNREACHABLE", "{body}");
    assert!(body["facade_canister"].is_null(), "{body}");
    assert!(body["live_module_hash"].is_null(), "{body}");
}

// --- faucet + balance (test-helpers fixtures over the fake-IC gateway) ------
//
// These pin the FAKE-IC /faucet branch, which serves the route only when `agent` is NOT compiled
// in (the offline e2e/test-relay build). With both features on — the live-test config — the
// PRODUCTION agent branch owns POST /faucet (relay-side cooldown + authenticated canister mint,
// covered by live.rs `live_faucet_mints_at_user_principal_with_relay_side_cooldown`), so these
// fake-gateway assertions don't apply there and are compiled out.

/// The operator's `DPAY_ENABLE_FAUCET` switch, off: the route refuses with a reason that NAMES the
/// missing knob (not a bare "disabled"), no money is created at the user's principal on the
/// gateway, and — the pairing that matters — the relay stops advertising the capability.
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn faucet_disabled_mints_nothing() {
    let merchant = keypair();
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let state = state.with_faucet(false);
    let merch_owner = user_principal(&pubkey(&merchant));

    let (status, body) = call(
        &state,
        faucet_json(&hex::encode(pubkey(&merchant)), Some("999")),
    )
    .await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    let reason = body["error"].as_str().unwrap_or_default();
    assert!(
        reason.contains("DPAY_ENABLE_FAUCET"),
        "the refusal must name what is missing, got {reason:?}"
    );
    assert_eq!(
        fake.balance_for(DEMO_USD, &merch_owner),
        0,
        "a disabled faucet must not create funds"
    );

    let (cs, cb) = call(&state, get_req("/api/v1/capabilities")).await;
    assert_eq!(cs, StatusCode::OK, "{cb}");
    assert_eq!(
        cb["demo_faucet"], false,
        "a refused faucet is not advertised: {cb}"
    );
}

/// …and enabled (the demo default) it credits the USER PRINCIPAL on the fake-IC gateway — exactly
/// where a signed icrc1_transfer spends from. The response balance and the batch balances route
/// agree, and the amount is the requested one; an omitted amount is the demo's default 10_000
/// ($100.00 in minor units).
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn faucet_enabled_mints() {
    let merchant = keypair();
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let merch_hex = hex::encode(pubkey(&merchant));
    let merch_owner = user_principal(&pubkey(&merchant));

    let (status, body) = call(&state, faucet_json(&merch_hex, Some("999"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["balance"], "999", "{body}");
    assert_eq!(fake.balance_for(DEMO_USD, &merch_owner), 999);

    // The batch balances route agrees (same principal mapping), currency key included.
    let (bs, bb) = call(&state, get_req(&format!("/api/v1/balances/{merch_hex}"))).await;
    assert_eq!(bs, StatusCode::OK, "{bb}");
    assert_eq!(bb["0"], "999", "{bb}");

    // An omitted amount is the demo's default top-up: +10_000 on the same principal.
    let (ds, db) = call(&state, faucet_json(&merch_hex, None)).await;
    assert_eq!(ds, StatusCode::OK, "{db}");
    assert_eq!(db["balance"], (999 + 10_000).to_string(), "{db}");
    assert_eq!(fake.balance_for(DEMO_USD, &merch_owner), 999 + 10_000);
}

/// MC1 units 2-4: protocol `u64` amounts cross the JSON boundary as DECIMAL STRINGS (never raw JSON
/// numbers), so the full u64 range round-trips without precision loss above 2^53 (the IEEE-754 loss
/// zone the old `number`/`Double` path collapsed). A faucet credit of 2^53+1 — the canonical probe,
/// `Number(9007199254740993) === 9007199254740992` is lossy via `number` — must return as the EXACT
/// decimal string, and the (string-OR-number-accepting) deserializer must parse a quoted amount.
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn amounts_serialize_as_decimal_string_above_2p53() {
    let merchant = keypair();
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let merch_hex = hex::encode(pubkey(&merchant));
    let merch_owner = user_principal(&pubkey(&merchant));
    const BIG: u64 = 9_007_199_254_740_993; // 2^53 + 1 — lossy through JS `number`, exact as a string

    // POST a QUOTED decimal amount — the canonical wire shape. The deserializer accepts both
    // shapes, but the canonical form is a string; this asserts it parses + the response balance is
    // the EXACT string back.
    let (status, body) = call(&state, faucet_json(&merch_hex, Some(&format!("\"{BIG}\"")))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The balance serializes as a QUOTED decimal string (not a JSON number) — the MC1 units 2-4
    // shape.
    assert!(
        body["balance"].is_string(),
        "balance must be a JSON string: {body}"
    );
    assert_eq!(body["balance"], BIG.to_string().as_str());
    // The exact value round-trips on the gateway (the faucet honors the requested amount).
    assert_eq!(fake.balance_for(DEMO_USD, &merch_owner), BIG);

    // The deserializer ALSO accepts a raw JSON number (smooth cutover for older callers). The
    // response shape is unchanged (always a string).
    let (status2, body2) = call(&state, faucet_json(&merch_hex, Some("2500"))).await;
    assert_eq!(status2, StatusCode::OK, "{body2}");
    assert_eq!(body2["balance"], (BIG + 2500).to_string().as_str());
    assert_eq!(fake.balance_for(DEMO_USD, &merch_owner), BIG + 2500);
}

// --- fake-IC /api/v2 gateway (test-helpers) ---------------------------------

/// The /api/v2 boundary is MOUNTED (it is the offline stand-in for icp-api.io): status answers
/// healthy CBOR, a garbage envelope on `call` is a clean 400 (signature verification failed), and
/// without the gateway attached the whole namespace is a 404 — as is each test-only fixture route
/// that needs it (faucet → 503 "not attached" contract instead, since the route exists).
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn api_v2_gateway_mounting_pinned() {
    let merchant = keypair();
    let (state, _led, _fake) = state_with_fake(ledger()).await;

    // Status: 200, CBOR, non-empty (the app's gateway pre-flight).
    let (status, headers, bytes) = call_raw(&state, get_req("/api/v2/status")).await;
    assert_eq!(status, StatusCode::OK, "/api/v2/status must serve");
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "application/cbor"
    );
    assert!(!bytes.is_empty(), "status carries a CBOR body");

    // A garbage envelope on call: 400 (verify_envelope fails) — never a 500, never executed.
    let garbage = Request::builder()
        .method("POST")
        .uri(format!("/api/v2/canister/{DEMO_LEDGER}/call"))
        .body(Body::from("definitely not a signed envelope"))
        .unwrap();
    let (status, _headers, _bytes) = call_raw(&state, garbage).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "garbage envelope must 400");

    // Without the gateway attached the /api/v2 namespace is gone (404)…
    let (bare_state, _led2) = state_from(ledger());
    let garbage_bare = Request::builder()
        .method("POST")
        .uri(format!("/api/v2/canister/{DEMO_LEDGER}/call"))
        .body(Body::from("definitely not a signed envelope"))
        .unwrap();
    let (status, _h, _b) = call_raw(&bare_state, garbage_bare).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "no gateway → 404");

    // …and the faucet (which needs the gateway's ledgers) reports 503 not-attached, not a crash.
    let (fs, fb) = call(
        &bare_state,
        faucet_json(&hex::encode(pubkey(&merchant)), Some("999")),
    )
    .await;
    assert_eq!(fs, StatusCode::SERVICE_UNAVAILABLE, "{fb}");
}

/// A REAL signed icrc1_transfer through POST /api/v2/canister/{ledger}/call — the rail the app
/// actually moves money on post-cutover. Proves the whole gateway path end-to-end: envelope
/// verification (the sender principal is the self-authenticating principal of the signing key),
/// request_id dedup (an identical resubmit is 202 again but executes ONCE), execution (funds move
/// principal→principal), and the memo riding the signed arg into /api/v1/transactions history.
#[tokio::test]
async fn signed_transfer_through_api_v2_moves_funds_and_lands_in_history() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let payer_owner = user_principal(&pubkey(&payer));
    let merch_owner = user_principal(&pubkey(&merchant));

    // Fund the payer's principal (the faucet fixture credits exactly where the transfer spends).
    fake.faucet_credit(DEMO_USD, &payer_owner, 10_000);

    let now_ns = now_ns();
    let settlement_memo = b"0123456789abcdef";
    let arg = transfer_arg(
        &Account::new(merch_owner.clone()),
        None,
        250,
        None,
        Some(settlement_memo.to_vec()),
        None,
    );
    let req = CallRequest {
        // The DEMO_USD catalog ledger — the REAL DUSD principal (`td2nx-…`), where the fake-IC
        // gateway's DEMO ledger (and prod's real one) lives.
        canister: Principal::from_text(DEMO_LEDGER).expect("DEMO ledger principal parses"),
        method_name: "icrc1_transfer".to_string(),
        arg,
        ingress_expiry_ns: ingress_expiry(now_ns, 300),
        nonce: None,
    };
    let envelope = sign_update(&payer, &req);
    let post = || {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v2/canister/{DEMO_LEDGER}/call"))
            .body(Body::from(envelope.clone()))
            .unwrap()
    };

    // First submission: 202 (accepted, executed — outcome rides read_state on the real rail).
    let (s1, _h1, b1) = call_raw(&state, post()).await;
    assert_eq!(s1, StatusCode::ACCEPTED, "signed transfer must be accepted");
    assert!(b1.is_empty(), "call replies with an empty 202 body");

    // Funds moved principal → principal.
    assert_eq!(fake.balance_for(DEMO_USD, &merch_owner), 250);
    assert_eq!(fake.balance_for(DEMO_USD, &payer_owner), 10_000 - 250);

    // Identical resubmit (same request_id): 202 again, but executed ONCE — no double credit.
    let (s2, _h2, _b2) = call_raw(&state, post()).await;
    assert_eq!(s2, StatusCode::ACCEPTED, "dedup resubmit is also 202");
    assert_eq!(
        fake.balance_for(DEMO_USD, &merch_owner),
        250,
        "credited once"
    );

    // History carries the transfer with the memo (hex of the signed arg's memo bytes) + the mint
    // that funded it, newest-first, on BOTH sides of the payment.
    let payer_hex = hex::encode(pubkey(&payer));
    let merch_hex = hex::encode(pubkey(&merchant));
    let (ps, pb) = call(
        &state,
        get_req(&format!("/api/v1/transactions/{payer_hex}")),
    )
    .await;
    assert_eq!(ps, StatusCode::OK, "{pb}");
    let rows = pb["transactions"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "mint + transfer: {pb}");
    // Newest first: the outgoing transfer, then the funding mint.
    assert_eq!(rows[0]["amount"], "250", "{pb}");
    assert_eq!(rows[0]["from"], payer_owner.to_text(), "{pb}");
    assert_eq!(rows[0]["to"], merch_owner.to_text(), "{pb}");
    assert_eq!(
        rows[0]["memo"],
        hex::encode(settlement_memo),
        "memo rides the signed arg: {pb}"
    );
    assert_eq!(rows[0]["currency"], 0); // DEMO_USD
                                        // Display names don't exist on the IC rail — the fields stay stable empty strings (never
                                        // null, never leaked bytes).
    assert_eq!(rows[0]["from_name"], "");
    assert_eq!(rows[0]["to_name"], "");
    assert_eq!(rows[1]["amount"], "10000", "the funding mint: {pb}");
    assert_eq!(rows[1]["from"], "", "mint rows carry no sender");

    // The payee sees the same transfer as incoming (from == the payer's principal).
    let (ms, mb) = call(
        &state,
        get_req(&format!("/api/v1/transactions/{merch_hex}")),
    )
    .await;
    assert_eq!(ms, StatusCode::OK, "{mb}");
    let m_rows = mb["transactions"].as_array().unwrap();
    assert_eq!(m_rows.len(), 1, "{mb}");
    assert_eq!(m_rows[0]["from"], payer_owner.to_text(), "{mb}");
    assert_eq!(m_rows[0]["to"], merch_owner.to_text(), "{mb}");
    assert_eq!(m_rows[0]["memo"], hex::encode(settlement_memo), "{mb}");

    // Busy-account regression: 31 newer rows push the payment beyond a normal limit=30 response,
    // but an exact memo query filters the full log BEFORE limiting and still finds it.
    for _ in 0..31 {
        fake.faucet_credit(DEMO_USD, &merch_owner, 1);
    }
    let (recent_s, recent_b) = call(
        &state,
        get_req(&format!("/api/v1/transactions/{merch_hex}?limit=30")),
    )
    .await;
    assert_eq!(recent_s, StatusCode::OK, "{recent_b}");
    assert!(
        recent_b["transactions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["memo"] != hex::encode(settlement_memo)),
        "target must genuinely be outside the newest-30 window: {recent_b}",
    );
    let memo_hex = hex::encode(settlement_memo);
    let (memo_s, memo_b) = call(
        &state,
        get_req(&format!(
            "/api/v1/transactions/{merch_hex}?limit=1&memo={memo_hex}"
        )),
    )
    .await;
    assert_eq!(memo_s, StatusCode::OK, "{memo_b}");
    let memo_rows = memo_b["transactions"].as_array().unwrap();
    assert_eq!(memo_rows.len(), 1, "{memo_b}");
    assert_eq!(memo_rows[0]["memo"], memo_hex, "{memo_b}");

    let (bad_s, _) = call(
        &state,
        get_req(&format!("/api/v1/transactions/{merch_hex}?memo=abcd")),
    )
    .await;
    assert_eq!(
        bad_s,
        StatusCode::BAD_REQUEST,
        "short memo filters must fail closed"
    );
}

/// Sign + POST a legacy `transfer` (the ICP ledger's own method), then read the outcome back the
/// way the app does — read_state → certificate → `request_status` — so the assertions below check
/// the ledger's OWN reply bytes, not merely the balance side effects.
async fn legacy_transfer_outcome(
    state: &AppState,
    sk: &SigningKey,
    canister: &str,
    arg: Vec<u8>,
) -> RequestStatus {
    let req = CallRequest {
        canister: Principal::from_text(canister).expect("ledger principal parses"),
        method_name: "transfer".to_string(),
        arg,
        ingress_expiry_ns: ingress_expiry(now_ns(), 300),
        nonce: None,
    };
    let envelope = sign_update(sk, &req);
    let rid = verify_envelope(&envelope)
        .expect("our own envelope verifies")
        .request_id;
    let post = Request::builder()
        .method("POST")
        .uri(format!("/api/v2/canister/{canister}/call"))
        .body(Body::from(envelope))
        .unwrap();
    let (status, _h, body) = call_raw(state, post).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "a signed call is 202; the outcome rides read_state"
    );
    assert!(body.is_empty(), "call replies with an empty 202 body");

    let path: &[&[u8]] = &[b"request_status", &rid];
    let read = sign_read_state(sk, &[path], ingress_expiry(now_ns(), 300));
    let req = Request::builder()
        .method("POST")
        .uri(format!("/api/v2/canister/{canister}/read_state"))
        .body(Body::from(read))
        .unwrap();
    let (status, _h, body) = call_raw(state, req).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "read_state must serve a certificate"
    );
    let tree = decode_read_state_tree(&body).expect("certificate decodes");
    request_status(&tree, &rid).expect("request_status decodes")
}

/// The legacy `TransferResult` carried by a replied outcome.
fn legacy_result(outcome: RequestStatus) -> LegacyTransferResult {
    match outcome {
        RequestStatus::Replied(arg) => {
            decode_legacy_transfer_result(&arg).expect("legacy transfer reply decodes")
        }
        other => panic!("expected a replied outcome, got {other:?}"),
    }
}

/// The ICP ledger's LEGACY `transfer` through POST /api/v2/{ledger}/call — the ONLY method that can
/// pay a 64-hex ACCOUNT IDENTIFIER (what an exchange hands out), which `icrc1_transfer` cannot
/// address at all. Covers both payee cases: an identifier that derives back to an account the
/// gateway knows (funds land on that principal) and one that does not (the funds leave the sender
/// for an external account, and the sender's history says exactly that).
#[tokio::test]
async fn signed_legacy_transfer_pays_an_account_identifier() {
    let payer = keypair();
    let merchant = keypair();
    let outsider = keypair();
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let payer_owner = user_principal(&pubkey(&payer));
    let merch_owner = user_principal(&pubkey(&merchant));
    let outside_owner = user_principal(&pubkey(&outsider));

    fake.faucet_credit(ICP, &payer_owner, 100_000_000);
    // The payee already exists on the gateway — that is what makes its identifier RESOLVABLE (the
    // hash is one-way, so the payee is matched by re-deriving known accounts' identifiers).
    fake.faucet_credit(ICP, &merch_owner, 1);

    let to = AccountIdentifier::from_principal(&merch_owner, &[0u8; 32]);
    let outcome = legacy_transfer_outcome(
        &state,
        &payer,
        ICP_LEDGER,
        legacy_transfer_arg(to.as_bytes(), None, 250, ICP_FEE_E8S, 0, None),
    )
    .await;
    // Block 2: the two faucet credits above took blocks 0 and 1 — a mint IS a block on a real
    // ledger, and the gateway numbers them like one so a minted row and a transferred row can
    // never claim the same identity. The index rides the ledger's own Ok encoding.
    assert_eq!(legacy_result(outcome), LegacyTransferResult::Ok(2));
    assert_eq!(
        fake.balance_for(ICP, &merch_owner),
        1 + 250,
        "payee credited"
    );
    assert_eq!(
        fake.balance_for(ICP, &payer_owner),
        100_000_000 - 250 - ICP_FEE_E8S,
        "sender pays the amount AND the mandatory fee"
    );

    // An identifier the gateway cannot resolve (nobody has ever held a balance at that principal —
    // the shape of a real exchange address): the money still leaves the sender.
    let external = AccountIdentifier::from_principal(&outside_owner, &[0u8; 32]);
    let outcome = legacy_transfer_outcome(
        &state,
        &payer,
        ICP_LEDGER,
        legacy_transfer_arg(
            external.as_bytes(),
            None,
            400,
            ICP_FEE_E8S,
            0xdeadbeef,
            None,
        ),
    )
    .await;
    assert_eq!(legacy_result(outcome), LegacyTransferResult::Ok(3));
    assert_eq!(
        fake.balance_for(ICP, &payer_owner),
        100_000_000 - 250 - 400 - 2 * ICP_FEE_E8S,
    );
    assert_eq!(
        fake.balance_for(ICP, &outside_owner),
        0,
        "an unknown identifier is NOT credited to its (unknown) owner principal"
    );

    // History: both sends, newest first, on the sender's side — the unresolved payee shows as the
    // external account identifier, and the legacy nat64 memo renders as 16 hex chars (never the
    // 32-char settlement-memo shape the reconciliation filter matches).
    let payer_hex = hex::encode(pubkey(&payer));
    let (s, b) = call(
        &state,
        get_req(&format!("/api/v1/transactions/{payer_hex}?currency={ICP}")),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let rows = b["transactions"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "mint + two sends: {b}");
    assert_eq!(rows[0]["amount"], "400", "{b}");
    assert_eq!(rows[0]["from"], payer_owner.to_text(), "{b}");
    assert_eq!(
        rows[0]["to"],
        format!("icp-account-id:{}", external.to_text()),
        "an unresolved payee is recorded as the external account identifier: {b}"
    );
    assert_eq!(rows[0]["memo"], "00000000deadbeef", "{b}");
    assert_eq!(rows[0]["currency"], ICP, "{b}");
    assert_eq!(rows[1]["amount"], "250", "{b}");
    assert_eq!(rows[1]["to"], merch_owner.to_text(), "{b}");
    assert_eq!(rows[1]["memo"], "", "memo 0 is the ledger's 'no memo': {b}");
}

/// Every legacy refusal is the ICP ledger's OWN encoding (or the replica's own reject), and NOTHING
/// moves on any of them — the fee is exact-or-refuse, the balance check precedes the debit, the
/// method does not exist on an ICRC-1-only ledger, and a malformed arg is rejected rather than
/// guessed at.
#[tokio::test]
async fn legacy_transfer_refusals_move_no_funds() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let payer_owner = user_principal(&pubkey(&payer));
    let merch_owner = user_principal(&pubkey(&merchant));
    fake.faucet_credit(ICP, &payer_owner, 1_000);
    fake.faucet_credit(DEMO_USD, &payer_owner, 1_000);
    let to = AccountIdentifier::from_principal(&merch_owner, &[0u8; 32]);
    let unchanged = |what: &str| {
        assert_eq!(
            fake.balance_for(ICP, &payer_owner),
            1_000,
            "{what}: sender untouched"
        );
        assert_eq!(
            fake.balance_for(ICP, &merch_owner),
            0,
            "{what}: payee untouched"
        );
    };

    // Fee below the ledger's exact fee → BadFee carrying the fee it wants.
    let outcome = legacy_transfer_outcome(
        &state,
        &payer,
        ICP_LEDGER,
        legacy_transfer_arg(to.as_bytes(), None, 100, ICP_FEE_E8S - 1, 0, None),
    )
    .await;
    assert_eq!(
        legacy_result(outcome),
        LegacyTransferResult::Err(LegacyTransferError::BadFee {
            expected_fee: ICP_FEE_E8S
        }),
    );
    unchanged("bad fee");

    // Amount + fee over the balance → InsufficientFunds carrying the real balance.
    let outcome = legacy_transfer_outcome(
        &state,
        &payer,
        ICP_LEDGER,
        legacy_transfer_arg(to.as_bytes(), None, 1_000, ICP_FEE_E8S, 0, None),
    )
    .await;
    assert_eq!(
        legacy_result(outcome),
        LegacyTransferResult::Err(LegacyTransferError::InsufficientFunds { balance: 1_000 }),
    );
    unchanged("insufficient funds");

    // A malformed arg is REJECTED, never decoded into a plausible-looking payment.
    let outcome = legacy_transfer_outcome(&state, &payer, ICP_LEDGER, vec![0u8; 8]).await;
    match outcome {
        RequestStatus::Rejected {
            reject_code,
            reject_message,
            ..
        } => {
            assert_eq!(reject_code, 5, "{reject_message}");
            assert!(
                reject_message.contains("malformed transfer arg"),
                "{reject_message}"
            );
        }
        other => panic!("expected a rejection, got {other:?}"),
    }
    unchanged("malformed arg");

    // `transfer` exists ONLY on the ICP ledger: on an ICRC-1 ledger the replica rejects the method.
    let outcome = legacy_transfer_outcome(
        &state,
        &payer,
        DEMO_LEDGER,
        legacy_transfer_arg(to.as_bytes(), None, 100, 0, 0, None),
    )
    .await;
    match outcome {
        RequestStatus::Rejected {
            reject_code,
            reject_message,
            ..
        } => {
            assert_eq!(reject_code, 3, "{reject_message}");
            assert!(
                reject_message.contains("no update method 'transfer'"),
                "{reject_message}"
            );
        }
        other => panic!("expected a rejection, got {other:?}"),
    }
    assert_eq!(
        fake.balance_for(DEMO_USD, &payer_owner),
        1_000,
        "DEMO untouched"
    );
    unchanged("wrong ledger");
}

// --- transaction history ------------------------------------------------------

/// `GET /api/v1/transactions/{hex}` returns the wallet's durable history from the fake-IC gateway's
/// txn log (the same records signed transfers append), newest-first with enough fields to derive
/// direction. Seeded directly through the gateway's faucet fixture.
#[tokio::test]
async fn transactions_endpoint_returns_history_newest_first() {
    let payer = keypair();
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let payer_owner = user_principal(&pubkey(&payer));

    // Two credits at the payer's principal, in sequence.
    fake.faucet_credit(DEMO_USD, &payer_owner, 250);
    fake.faucet_credit(DEMO_USD, &payer_owner, 100);

    let payer_hex = hex::encode(pubkey(&payer));

    // Newest-first => the 100 credit, then the 250. Mint rows: to == the owner, from == "".
    let (status, body) = call(
        &state,
        get_req(&format!("/api/v1/transactions/{payer_hex}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = body["transactions"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "both credits recorded: {body}");
    assert_eq!(rows[0]["amount"], "100", "newest first: {body}");
    assert_eq!(rows[0]["to"], payer_owner.to_text(), "{body}");
    assert_eq!(rows[0]["from"], "", "mint rows carry no sender: {body}");
    assert_eq!(rows[0]["currency"], 0); // DEMO_USD
    assert_eq!(rows[1]["amount"], "250");

    // limit is honored.
    let (l_status, l_body) = call(
        &state,
        get_req(&format!("/api/v1/transactions/{payer_hex}?limit=1")),
    )
    .await;
    assert_eq!(l_status, StatusCode::OK, "{l_body}");
    assert_eq!(l_body["transactions"].as_array().unwrap().len(), 1);

    // A bad pubkey (not 32 bytes hex) is a clean 400, not a 500.
    let (bad_status, _bad_body) = call(&state, get_req("/api/v1/transactions/deadbeef")).await;
    assert_eq!(bad_status, StatusCode::BAD_REQUEST);
}

// --- landing page + APK download (the public root) -----------------------

/// Every static page this relay serves is painted from the SAME palette, and that palette comes
/// from `app/config/palette.ts` — not from four hand-typed copies, which is what shipped a website
/// on palette v4 while the app ran v5 (and left till.html/till-code.html on values that matched
/// neither). The pages carry a `{{PALETTE}}` token; `with_palette` substitutes the generated
/// `assets/palette.css` into it at serve time.
///
/// This test owns the SERVING half: that the substitution actually happens on all four routes, so a
/// page whose token was mistyped fails here rather than rendering unstyled in front of a user. The
/// GENERATING half — that the artifact still matches the palette it claims to come from — is
/// `app/__tests__/relay-palette.test.ts`, which is where a Node-side byte comparison belongs.
#[tokio::test]
async fn every_served_page_is_painted_from_the_one_palette() {
    let (till, _fake) = till_state();
    let (plain, _led) = state_from(ledger());

    for (state, path) in [
        (&plain, "/"),
        (&plain, "/privacy"),
        (&till, "/pl/?lightning=LNURL1TEST"),
        (&till, "/till/pl_0011223344556677"),
    ] {
        let (status, _headers, bytes) = call_raw(state, get_req(path)).await;
        assert_eq!(status, StatusCode::OK, "{path} must serve");
        let html = String::from_utf8(bytes.to_vec()).expect("utf-8 page");
        assert!(
            !html.contains("{{PALETTE}}"),
            "{path} served the placeholder instead of the palette"
        );
        // The tangerine's FILL step and its channel form: proof the whole generated block landed,
        // not merely that a `{` survived. Values come from the palette, so this pins the mechanism
        // rather than a colour (which would just be a fifth copy).
        assert!(
            html.contains("--brand: ") && html.contains("--brandRGB: "),
            "{path} is missing the shared palette's brand tokens"
        );
        // Both theme hooks ride in the one block, which is what let the two mechanisms already in
        // use (a pre-paint script on landing/privacy, plain prefers-color-scheme on the till pages)
        // stay exactly as they were.
        assert!(
            html.contains("html.scheme-auto") && html.contains("html[data-theme-mode=\"dark\"]"),
            "{path} is missing one of the two theme hooks the shared block serves"
        );
    }
}

/// With no APK configured (the default), `GET /` serves the landing page with the placeholder
/// resolved to the disabled "coming soon" chip — never the literal `{{DOWNLOAD}}` token, and no
/// download link that would 404.
#[tokio::test]
async fn landing_page_without_apk_shows_coming_soon() {
    let (state, _led) = state_from(ledger());

    let (status, headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    let html = String::from_utf8(bytes).unwrap();
    // The exact injected disabled chip (the `.btn-disabled` CSS class always exists in the sheet,
    // so match on the injected copy, which is unique to the None branch).
    assert!(
        html.contains("<span class=\"btn btn-disabled\">Android build coming soon</span>"),
        "disabled CTA missing"
    );
    assert!(
        !html.contains("{{DOWNLOAD}}"),
        "placeholder must be substituted"
    );
    assert!(
        !html.contains("href=\"/download/dpay.apk\""),
        "no live download link without an APK"
    );
    assert!(
        html.contains("href=\"/privacy\""),
        "privacy policy link missing"
    );
}

/// Google Play needs a clearly labeled policy at a public HTML URL. Pin the route, content type,
/// app/developer identification, contact, retention disclosure, and distributed-ledger limitation.
#[tokio::test]
async fn privacy_policy_is_served_with_required_disclosures() {
    let (state, _led) = state_from(ledger());

    let (status, headers, bytes) = call_raw(&state, get_req("/privacy")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    let html = String::from_utf8(bytes).unwrap();
    for required in [
        "<title>Privacy Policy | Different Pay</title>",
        "org.kalaj.dpay",
        "sato.dpay@kalaj.org",
        "Retention and deletion",
        "cannot be changed or deleted by us",
        "We do not sell personal or sensitive information",
    ] {
        assert!(
            html.contains(required),
            "privacy policy must contain {required:?}"
        );
    }
}

/// With an APK configured, `GET /` swaps the placeholder for a live download button carrying the
/// build's rounded size, and drops the disabled chip. A tiny build still reads "1 MB" (min floor).
#[tokio::test]
async fn landing_page_with_apk_shows_download_button() {
    let (state, _led) = state_from(ledger());
    let state = state.with_apk(Some(vec![0u8; 100])); // <0.5 MB → rounds to the 1 MB floor

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();
    assert!(
        html.contains("href=\"/download/dpay.apk?v="),
        "download link missing"
    );
    assert!(
        html.contains("APK · 1 MB"),
        "rounded size (min 1 MB) missing"
    );
    assert!(
        !html.contains("Android build coming soon"),
        "must not show the disabled chip"
    );
    assert!(
        !html.contains("{{DOWNLOAD}}"),
        "placeholder must be substituted"
    );
}

/// The landing page embeds the three real app screenshots (served from `/shots/…`), so a QR-bearing
/// screen appears where the old faux barcode used to be.
#[tokio::test]
async fn landing_page_embeds_app_screenshots() {
    let (state, _led) = state_from(ledger());

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();
    for shot in ["/shots/request.png", "/shots/paying.png", "/shots/paid.png"] {
        assert!(html.contains(shot), "landing page must reference {shot}");
    }
}

/// Each known screenshot name serves a real PNG; an unknown name is a clean 404, never a 200 with
/// an empty body.
#[tokio::test]
async fn screenshots_served_as_png_and_unknown_is_404() {
    let (state, _led) = state_from(ledger());

    let names = [
        "request.png",
        "paying.png",
        "paid.png",
        "nfc-listen.png",
        "nfc-exchange.png",
        "nfc-paid.png",
        "scanned.png",
    ];
    for name in names {
        let (status, headers, bytes) = call_raw(&state, get_req(&format!("/shots/{name}"))).await;
        assert_eq!(status, StatusCode::OK, "{name} must serve");
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "image/png");
        assert!(
            bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "{name} must be a PNG"
        );
        // The CDN contract: bounded freshness + a validator keyed to the build, so a redeployed
        // image revalidates at the edge instead of pinning stale shots (the Jul-26 era bug).
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=300"
        );
        let etag = headers.get(header::ETAG).unwrap().to_str().unwrap();
        assert!(
            etag.starts_with("\"shots-"),
            "etag must be versioned: {etag}"
        );
    }

    let (status, _h, _b) = call_raw(&state, get_req("/shots/nope.png")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "unknown screenshot must 404");
}

/// 2026-08-16 merge: the hand-rolled merchant terminal is gone — `/merchant` is a permanent
/// redirect to `/wallet` (the REAL app; its Receive tab is the merchant terminal), and the root
/// stays the landing page.
#[tokio::test]
async fn merchant_redirects_to_wallet() {
    let (state, _led) = state_from(ledger());

    let (ms, mh, _mbytes) = call_raw(&state, get_req("/merchant")).await;
    assert_eq!(ms, StatusCode::PERMANENT_REDIRECT);
    assert_eq!(mh.get(header::LOCATION).unwrap(), "/wallet");

    // The root is the landing page, not a wallet/terminal page.
    let (_rs, _rh, rbytes) = call_raw(&state, get_req("/")).await;
    let root = String::from_utf8(rbytes).unwrap();
    assert!(
        !root.contains("id=\"merchId\""),
        "root must not be the merchant terminal"
    );
}

/// 2026-08-16 merge follow-up (U-F6): with no separate merchant product, the landing page itself
/// must answer "how do I become a merchant?" — the Receive tab is the terminal, on any phone or
/// in the browser, with no signup/terminal/fees, and the section links to the one web surface.
#[tokio::test]
async fn landing_page_answers_the_merchant_path() {
    let (state, _led) = state_from(ledger());

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();
    for required in [
        "id=\"merchants\"",
        "For merchants",
        "choose Receive, and show your QR",
        "No signup",
        "No terminal",
        "No fees",
    ] {
        assert!(
            html.contains(required),
            "landing page must contain {required:?}"
        );
    }
    assert!(
        html.contains("<a class=\"ghost\" href=\"/wallet\">Open the web wallet</a>"),
        "merchant section must link the web wallet"
    );
    // the 3-step "Take payments in minutes" path (2026-08-16): the section must not just point at
    // the wallet — it must walk the whole become-a-merchant path in three named steps.
    for required in [
        "Take payments in minutes",
        "Open the web wallet",
        "Create your wallet",
        "backup words",
        "Receive is your terminal",
        "share the link",
    ] {
        assert!(
            html.contains(required),
            "merchant 3-step path must contain {required:?}"
        );
    }
}

/// Non-custodial honesty (2026-08-22, from a friend report that the site read as custodial): the
/// landing must say the word "non-custodial" where people who know the term look (hero trust row,
/// footer), AND carry the concrete consequences for everyone else in an on-demand fold — no dpay
/// account, key only on the phone, cannot move/freeze/recover. The fold is a <details> so nothing
/// is forced on skimmers.
#[tokio::test]
async fn landing_page_states_non_custodial_honestly() {
    let (state, _led) = state_from(ledger());

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();
    // The explicit term, in the two high-signal spots (hero trust row + footer line).
    assert!(
        html.contains("Non-custodial. We can't move your money"),
        "hero trust row must carry the explicit non-custodial claim"
    );
    assert!(
        html.contains("Non-custodial. Your key stays on your phone"),
        "footer must carry the explicit non-custodial claim"
    );
    // The on-demand fold: concrete implications, not jargon.
    for required in [
        "<details class=\"custody\">",
        "What does \"non-custodial\" mean?",
        "There is no dpay account",
        "We can't move, freeze, or recover your money",
        "That's what owning it means",
    ] {
        assert!(
            html.contains(required),
            "custody fold must contain {required:?}"
        );
    }
}

/// Trip Ready Wave 2E (2026-08-22 spec): the landing tells the offline-payment story. The
/// hero carries the single-source pointer comment to the app's campaign line
/// (app/i18n/domains/en/wallet.ts `M.education.campaignLine` — the literal line lives only
/// there since the founder's 2026-08-24 wording pass 27a258e; the pointer keeps the two
/// homes honest), the hero states the asymmetry plainly (payer offline, merchant online,
/// the shop's connection settles it), and the "Paying offline" rail renders the four beats:
/// pay → show your code → shop scans → settled. Honesty pins: the banned-claims sweep — no
/// "conversion" family, no "anywhere", no "works with any currency", no "nobody needs
/// internet" — and proof motion must keep the reduced-motion kill switch.
#[tokio::test]
async fn landing_page_tells_the_offline_payment_story() {
    let (state, _led) = state_from(ledger());

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();
    // The campaign-line single-source pointer comment (the literal line lives only in
    // app/i18n/domains/en/wallet.ts `M.education.campaignLine`; the founder's 2026-08-24
    // wording pass 27a258e removed the byte-identical copy from this page — the pointer
    // comment keeps the two homes honest).
    assert!(
        html.contains(
            "<!-- single source: app/i18n/domains/en/wallet.ts M.education.campaignLine -->"
        ),
        "the hero must carry the single-source pointer comment"
    );
    // The QR-only reverse scan keeps the payer offline while the shop submits online.
    for required in [
        "Paying offline",
        "One press. Your phone signs it.",
        "The shop scans your screen.",
        "The shop submits online. <b>You stay offline.</b>",
    ] {
        assert!(
            html.contains(required),
            "the offline story must contain {required:?}"
        );
    }
    // Banned claims (spec exclusions). "onvert" covers convert/converts/conversion;
    // "nywhere" covers anywhere/Anywhere — payments work where the shop is online, not
    // "anywhere"; the merchant's connectivity is never hand-waved away.
    for banned in [
        "onvert",
        "nywhere",
        "works with any currency",
        "nobody needs internet",
    ] {
        assert!(
            !html.contains(banned),
            "landing must not carry the banned claim {banned:?}"
        );
    }
    // The extra scan is a folded QR-only step; NFC carries the signed bundle in one tap.
    assert!(
        html.contains("<details class=\"pw-offline\" aria-label=\"Paying offline\">"),
        "the offline flow must be a fold, named for assistive tech"
    );
    assert!(
        !html.contains("<details class=\"pw-offline\" aria-label=\"Paying offline\" open"),
        "the offline fold must start closed"
    );
    assert!(
        html.contains("See how"),
        "the closed fold must say in TEXT what opening it gives you"
    );
    // The shared request → sign → settle rail is the canonical flow. NFC and QR explain only
    // their handoff difference; the only other storyboard is the QR-only offline expansion.
    for required in [
        "Choose how the phones meet",
        "Bring the phones together.",
        "Point at the shop's code.",
        "<b>Online</b> or <b>Offline</b> - it takes one tap",
        "<b>Online</b> takes one scan",
        "Offline requires one extra scan",
    ] {
        assert!(
            html.contains(required),
            "the compact transport comparison must contain {required:?}"
        );
    }
    assert_eq!(
        html.matches("class=\"rail\"").count(),
        2,
        "landing must have one shared flow plus the QR-only offline expansion"
    );
    // Proof-strip motion must have a reduced-motion answer (the global kill switch).
    assert!(
        html.contains("prefers-reduced-motion"),
        "proof motion must respect prefers-reduced-motion"
    );
}

/// In-page navigation must not dangle: every `href="#…"` has to resolve to an element carrying
/// that id. Regression guard for a silent class of rot — the 2026-08-23 wording pass (c899c9a)
/// dropped the `id="proof"` strip but left `<a href="#proof">` in the nav, so "The proof" was a
/// no-op link on the live site until 2026-08-25. A broken anchor throws nothing and logs nothing.
#[tokio::test]
async fn landing_page_in_page_links_all_resolve() {
    let (state, _led) = state_from(ledger());

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();

    let mut checked = 0usize;
    for (at, _) in html.match_indices("href=\"#") {
        let rest = &html[at + "href=\"#".len()..];
        let end = rest.find('"').expect("unterminated href attribute");
        let frag = &rest[..end];
        assert!(
            !frag.is_empty(),
            "empty in-page link href=\"#\" is not a target"
        );
        assert!(
            html.contains(&format!("id=\"{frag}\"")),
            "in-page link #{frag} points at no element with that id"
        );
        checked += 1;
    }
    // The nav's four section links + the two brandmark #top links; a drop below that means the
    // in-page navigation itself vanished, which the per-link assertions above cannot notice.
    assert!(
        checked >= 6,
        "expected the page's in-page links, found {checked}"
    );
}

/// The `#proof` section — the nav's "The proof" destination and the page's answer to "how does
/// this actually work". Its two toys are pure CSS state machines: the route switch flips
/// `data-route` between the two couriers, the slip card flips `data-tamper`. Both attributes and
/// BOTH route variants must be in the markup or a toy renders permanently stuck in one state.
///
/// Honesty pins (verified 2026-08-25 against `app/services/icp.ts` `IC_GATEWAY_DEFAULT` and this
/// crate's own router): the app posts signed IC envelopes straight to the boundary node, and the
/// settlement surface left this relay entirely — so the page must say the server is off the
/// payment path, and must not dress the tamper toy up as a live cryptographic check.
#[tokio::test]
async fn landing_page_proof_section_explains_the_signature() {
    let (state, _led) = state_from(ledger());

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();

    // Both toys, in their clean starting state, with the script's handles present.
    for required in [
        "id=\"proof\"",
        "id=\"routecard\" data-route=\"on\"",
        "id=\"routeswitch\"",
        "role=\"switch\"",
        "id=\"tampercard\" data-tamper=\"none\"",
        "data-t=\"amount\"",
        "data-t=\"payee\"",
        "data-t=\"none\"",
    ] {
        assert!(
            html.contains(required),
            "the proof section must contain {required:?}"
        );
    }
    // Both courier variants ship in the markup — the switch only changes which one displays.
    assert!(
        html.contains("class=\"r-on\">Your connection")
            && html.contains("class=\"r-off\">The shop's phone"),
        "both route variants must be present for the switch to have two states"
    );
    // The verdict stamp ships both faces too, in a row of its own that is always present — a
    // stamp floated over the slip covered the seal value at phone widths. Announced politely so
    // the state change reaches a screen reader, not just an eye.
    assert!(
        html.contains("class=\"srow verdict\" aria-live=\"polite\"")
            && html.contains("class=\"s-ok\">Seal holds")
            && html.contains("class=\"s-bad\">Seal broken"),
        "the verdict row must be announced and carry both stamp faces"
    );
    // The two verdicts must not read as the same colour: holds is a green outline, broken is a
    // solid red fill (differing in fill as well as hue, so it survives colour-blindness).
    //
    // BOTH are now shared palette tokens, which is also what retired the rule that used to sit
    // here: a `html.dark [data-tamper="none"] .stamp{--st:#34C48E}` override existed only because
    // the light green was a literal, and being state-scoped was the fix for the specificity bug
    // that override caused (unscoped, `html.dark .stamp` is (0,2,1) and outranked the (0,2,0)
    // tamper rule, rendering a green border around the red fill — the 2026-08-25 defect). `--ok`
    // carries its own dark value, so there is no second rule left to rank against the first.
    assert!(
        html.contains("--st:var(--ok);"),
        "the holding stamp must take the shared ok token, so its dark value needs no second rule"
    );
    assert!(
        html.contains("--st:var(--bad);background:var(--bad);color:var(--brandInk);"),
        "the broken stamp must be a solid red fill, not just a recoloured outline"
    );
    // The claims the section exists to make.
    for required in [
        "not on the path",
        "Payments don't go through it at all",
        "It is never uploaded",
        "the network settles it exactly once",
    ] {
        assert!(
            html.contains(required),
            "the proof section must claim {required:?}"
        );
    }
    // The tamper card is a drawing of a real rule, and says so rather than implying a live check.
    assert!(
        html.contains("An illustration of a check that really runs"),
        "the tamper toy must label itself an illustration"
    );
    // Five folded answers, each a native <details> so nothing is forced on a skimmer.
    assert_eq!(
        html.matches("<details class=\"fold\">").count(),
        5,
        "the proof section carries five folded answers"
    );
}

/// Without a configured APK the download route is a clean 404 — not an empty 200.
#[tokio::test]
async fn apk_download_absent_is_404() {
    let (state, _led) = state_from(ledger());

    let (status, _headers, bytes) = call_raw(&state, get_req("/download/dpay.apk")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(String::from_utf8(bytes).unwrap(), "no build available");
}

/// With an APK configured the route serves the exact bytes as an APK attachment.
#[tokio::test]
async fn apk_download_serves_configured_bytes() {
    let (state, _led) = state_from(ledger());
    let apk = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02];
    let state = state.with_apk(Some(apk.clone()));

    let (status, headers, bytes) = call_raw(&state, get_req("/download/dpay.apk")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "application/vnd.android.package-archive"
    );
    assert_eq!(
        headers.get(header::CONTENT_DISPOSITION).unwrap(),
        "attachment; filename=\"dpay.apk\""
    );
    // Revalidation semantics, not the old year-long immutable: short max-age + a strong ETag so
    // the CDN revalidates with cheap 304s and a fresh build reaches users within minutes.
    assert_eq!(
        headers.get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=300"
    );
    let expected_etag = format!("\"{}\"", hex::encode(sha2::Sha256::digest(&apk)));
    assert_eq!(
        headers.get(header::ETAG).unwrap(),
        expected_etag.as_str(),
        "strong etag must be the quoted sha256 of the served bytes"
    );
    assert_eq!(
        bytes, apk,
        "served bytes must match the configured build verbatim"
    );
}

/// A matching `If-None-Match` must short-circuit to a bodyless 304 (the cheap CDN
/// revalidation); a non-matching etag must return the full body.
#[tokio::test]
async fn apk_download_revalidates_with_304_on_if_none_match() {
    let (state, _led) = state_from(ledger());
    let apk = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02];
    let state = state.with_apk(Some(apk.clone()));

    let (_, headers, _) = call_raw(&state, get_req("/download/dpay.apk")).await;
    let etag = headers
        .get(header::ETAG)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        etag.starts_with('"') && etag.ends_with('"'),
        "etag must be quoted (strong): {etag}"
    );

    let match_req = Request::builder()
        .method("GET")
        .uri("/download/dpay.apk")
        .header(header::IF_NONE_MATCH, &etag)
        .body(Body::empty())
        .unwrap();
    let (status, headers, bytes) = call_raw(&state, match_req).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(bytes.is_empty(), "304 must not carry a body");
    assert_eq!(
        headers.get(header::ETAG).unwrap(),
        etag.as_str(),
        "304 repeats the etag"
    );
    assert_eq!(
        headers.get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=300",
        "304 repeats the cache policy so the CDN re-arms its TTL"
    );

    let stale_req = Request::builder()
        .method("GET")
        .uri("/download/dpay.apk")
        .header(header::IF_NONE_MATCH, "\"deadbeef\"")
        .body(Body::empty())
        .unwrap();
    let (status, _, bytes) = call_raw(&state, stale_req).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a non-matching etag returns the full body"
    );
    assert_eq!(bytes, apk);
}

// --- currency catalog (M0 + v2 network-first envelope) ------------------------
//
// Covers GET /api/v1/currencies — the wallet's runtime asset catalog (closes issue #7), served
// network-first (v2): {networks:[{protocol,name,environment,assets}]} with exactly 3 sections in
// order — icp mainnet, icp testnet, solana mainnet. The relay serves its compiled-in catalog
// (crate::catalog — sole authority since 2026-08-28, founder decision; the facade registry is
// gone, the route is infallible). Since the 2026-08-28 REAL-rows transplant the IC rows are the
// VERBATIM live-prod rows: mainnet DEMO_USD (0, $, mintable, faucet) + ckBTC (1, ₿, CkBtcUtxo
// ramp) + ckUSDC (2, CkEthErc20 onramp) + native ckETH (6, token_contract null) + VCHF (7) +
// ICP (8) — the two complete no-minter direct-ICRC assets, network "Internet Computer";
// testnet ckTESTBTC (3, "Bitcoin Testnet") + ckSepoliaUSDC (4) + ckSepoliaETH (5, "Sepolia").
// The wallet reads this once on load instead of hardcoding DEPOSIT_CURRENCY.

/// `GET /api/v1/currencies` returns `200 {"networks":[...]}` — the v2 network-first envelope with
/// exactly 3 sections in order (icp mainnet, icp testnet, solana mainnet) and NO legacy top-level
/// `currencies`/`testnet` arrays. IC mainnet rows carry every registered mainnet currency's
/// ledger/minter/display metadata in the UNCHANGED row shape; the testnet section holds exactly
/// the rows the relay's server-authoritative partition classifies as testnet; the solana section
/// mirrors app/solana.ts constants verbatim.
#[tokio::test]
async fn currencies_route_returns_demo_catalog() {
    let (state, _led) = state_from(ledger());

    let (status, body) = call(&state, get_req("/api/v1/currencies")).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The v2 envelope carries ONLY `networks` (no deployed APKs → no back-compat arrays).
    let networks = body["networks"].as_array().expect("networks array");
    assert_eq!(
        body.as_object().expect("object body").len(),
        1,
        "envelope carries only `networks`: {body}"
    );
    assert_eq!(
        networks.len(),
        3,
        "exactly icp mainnet + icp testnet + solana mainnet: {body}"
    );

    let mainnet = &networks[0];
    assert_eq!(mainnet["protocol"], "icp");
    assert_eq!(mainnet["name"], "Internet Computer");
    assert_eq!(mainnet["environment"], "mainnet");
    let testnet = &networks[1];
    assert_eq!(testnet["protocol"], "icp");
    assert_eq!(testnet["name"], "Internet Computer");
    assert_eq!(testnet["environment"], "testnet");
    let solana = &networks[2];
    assert_eq!(solana["protocol"], "solana");
    assert_eq!(solana["name"], "Solana");
    assert_eq!(solana["environment"], "mainnet");

    // IC mainnet section: the REAL prod rows (DEMO's network None is mainnet-side). VCHF
    // (currency 7), ICP (currency 8) and VEUR (currency 9) carry network "Internet Computer"
    // — the U3 pin: the relay's server-authoritative partition must file them MAINNET-side,
    // not testnet-side.
    let rows = mainnet["assets"]
        .as_array()
        .expect("icp mainnet assets array");
    assert_eq!(
        rows.len(),
        7,
        "icp mainnet = DEMO_USD + ckBTC + ckUSDC + ckETH + VCHF + ICP + VEUR (the three Sepolia/testnet-BTC rows are testnet-side): {body}"
    );
    // Served order is the prod order: 0, 1, 2, 6, then the appended 7, 8, 9.
    let mainnet_ids: Vec<u64> = rows
        .iter()
        .map(|r| r["currency"].as_u64().unwrap())
        .collect();
    assert_eq!(
        mainnet_ids,
        vec![0, 1, 2, 6, 7, 8, 9],
        "mainnet section order: {body}"
    );

    // DEMO_USD (currency 0): the mintable $ faucet asset at the REAL DUSD ledger, no ramp.
    let dusd = rows
        .iter()
        .find(|r| r["currency"] == 0)
        .expect("DEMO_USD present");
    assert_eq!(dusd["mintable"], true);
    assert_eq!(dusd["symbol"], "$");
    assert_eq!(dusd["decimals"], 2);
    assert_eq!(dusd["minter"], serde_json::Value::Null);
    assert_eq!(dusd["minter_family"], serde_json::Value::Null);
    assert_eq!(dusd["ledger"], "td2nx-oaaaa-aaaab-qhdnq-cai"); // the REAL DUSD ledger (catalog_truth demo_ledger)
    assert_eq!(dusd["wrapper_name"], serde_json::Value::Null);
    assert_eq!(dusd["backing_symbol"], serde_json::Value::Null);
    assert_eq!(dusd["network"], serde_json::Value::Null);
    assert_eq!(dusd["display_decimals"], serde_json::Value::Null);
    assert_eq!(dusd["fee"], serde_json::Value::Null);
    assert_eq!(dusd["cap"], "100000"); // $1,000.00 per-tx cap
                                       // MC1 unit 5: DEMO ramp honesty — onramp=Direct (faucet), offramp=Unavailable (no cash-out).
    assert_eq!(dusd["onramp"], "Direct");
    assert_eq!(dusd["offramp"], "Unavailable");

    // ckBTC (currency 1): the deposit/withdraw ramp asset — CkBtcUtxo family, ₿, 8 decimals, the
    // REAL ckBTC ledger + minter principals.
    let ckbtc = rows
        .iter()
        .find(|r| r["currency"] == 1)
        .expect("ckBTC currency present");
    assert_eq!(ckbtc["mintable"], false);
    assert_eq!(ckbtc["symbol"], "₿");
    assert_eq!(ckbtc["decimals"], 8);
    // The variant serializes as the plain PascalCase tag (matches the candid label + wallet contract).
    assert_eq!(ckbtc["minter_family"], "CkBtcUtxo");
    assert_eq!(ckbtc["ledger"], "mxzaz-hqaaa-aaaar-qaada-cai"); // catalog_truth ckbtc_ledger
    assert_eq!(ckbtc["minter"], "mqygn-kiaaa-aaaar-qaadq-cai"); // catalog_truth ckbtc_minter
                                                                // MC1 unit 5: authoritative per-currency metadata (no family-level assumption).
    assert_eq!(ckbtc["wrapper_name"], "ckBTC");
    assert_eq!(ckbtc["backing_symbol"], "BTC");
    assert_eq!(ckbtc["network"], "Bitcoin");
    assert_eq!(ckbtc["display_decimals"], 8);
    assert_eq!(ckbtc["fee"], serde_json::Value::Null); // read live at runtime
    assert_eq!(ckbtc["cap"], "100000");
    assert_eq!(ckbtc["onramp"], "Direct"); // chain-key Bitcoin ramp
    assert_eq!(ckbtc["offramp"], "Direct"); // retrieve_btc_with_approval

    // ckUSDC (currency 2): the ckERC-20 onramp asset — CkEthErc20 family, ckUSDC, 6 decimals.
    let ckusdc = rows
        .iter()
        .find(|r| r["currency"] == 2)
        .expect("ckUSDC currency present");
    assert_eq!(ckusdc["mintable"], false);
    assert_eq!(ckusdc["symbol"], "ckUSDC");
    assert_eq!(ckusdc["decimals"], 6);
    assert_eq!(ckusdc["minter_family"], "CkEthErc20");
    assert_eq!(ckusdc["ledger"], "xevnm-gaaaa-aaaar-qafnq-cai"); // catalog_truth ckusdc_ledger
    assert_eq!(ckusdc["minter"], "sv3dd-oaaaa-aaaar-qacoa-cai"); // catalog_truth cketh_minter
                                                                 // MC1 unit 5: per-token ckERC20 facts (O6) replace the old hardcoded currency-2 params.
    assert_eq!(ckusdc["wrapper_name"], "ckUSDC");
    assert_eq!(ckusdc["backing_symbol"], "USDC");
    assert_eq!(ckusdc["network"], "Ethereum");
    assert_eq!(ckusdc["display_decimals"], 6);
    assert_eq!(ckusdc["fee"], "10000"); // ckUSDC icrc1_fee (O6): 0.01 USDC = 10000 raw
    assert_eq!(ckusdc["cap"], "100000");
    assert_eq!(ckusdc["chain_id"], 1); // Ethereum mainnet
    assert_eq!(
        ckusdc["token_contract"],
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    );
    assert_eq!(ckusdc["onramp"], "Direct"); // ckETH helper-contract onramp (client-side)
                                            // ckUSDC cash-out is now `Direct` (the dual-ledger `withdraw_erc20` path): the gas_ledger field
                                            // carries the ckETH gas ledger so the facade can burn ckETH gas + the USDC amount. The app gates
                                            // the Cash-out button on `offramp !== Unavailable` + a known CkEthErc20 family (no-swap honesty
                                            // still holds — dpay never converts ckUSDC→ckETH; the user must hold ckETH for gas).
    assert_eq!(ckusdc["offramp"], "Direct"); // dual-ledger withdraw_erc20 cash-out
    assert_eq!(
        ckusdc["gas_ledger"], "ss2fx-dyaaa-aaaar-qacoq-cai",
        "ckUSDC carries the ckETH gas ledger principal (withdraw_erc20 dual-ledger path)"
    );

    // Native ckETH (currency 6): a CkEthErc20-family currency with `token_contract == None`, the
    // discriminator that selects the native-ETH deposit/withdraw path (depositEth / withdraw_eth)
    // instead of the ERC-20 path. This is the catalog entry the native-ETH withdraw e2e (flow 44)
    // drives. The REAL mainnet row: the live ckETH ledger + minter principals, the live
    // icrc1_fee (0.000002 ETH), display_decimals 6 ≠ decimals 18 (the truncation path).
    // Ramp honesty: onramp=Direct (single payable depositEth tx), offramp=Direct (withdraw_eth —
    // the Cash-out button renders).
    let cketh = rows
        .iter()
        .find(|r| r["currency"] == 6)
        .expect("native ckETH currency present");
    assert_eq!(cketh["mintable"], false);
    assert_eq!(cketh["symbol"], "Ξ");
    assert_eq!(cketh["decimals"], 18);
    assert_eq!(cketh["display_decimals"], 6); // matches prod ckETH (truncation path, commit c74988b)
    assert_eq!(cketh["minter_family"], "CkEthErc20");
    assert_eq!(cketh["ledger"], "ss2fx-dyaaa-aaaar-qacoq-cai"); // catalog_truth cketh_ledger
    assert_eq!(cketh["minter"], "sv3dd-oaaaa-aaaar-qacoa-cai"); // catalog_truth cketh_minter
    assert_eq!(cketh["wrapper_name"], "ckETH");
    assert_eq!(cketh["backing_symbol"], "ETH");
    assert_eq!(cketh["network"], "Ethereum");
    assert_eq!(cketh["chain_id"], 1); // Ethereum mainnet
    assert_eq!(cketh["fee"], "2000000000000"); // the live ckETH ledger icrc1_fee (0.000002 ETH)
    assert_eq!(cketh["cap"], "100000");
    // THE KEY FIELD: token_contract must be null so the app treats this as native ETH (not ERC-20).
    assert_eq!(cketh["token_contract"], serde_json::Value::Null);
    // Native ckETH carries NO separate gas_ledger: the withdraw_eth single-ledger path approves
    // amount+fee on ckETH's OWN ledger, so the field is null (distinct from a ckERC20 whose gas
    // ledger IS the ckETH ledger). This null also keeps native ETH out of the dual-ledger path.
    assert_eq!(cketh["gas_ledger"], serde_json::Value::Null);
    assert_eq!(cketh["onramp"], "Direct"); // ckETH helper depositEth (single payable tx)
    assert_eq!(cketh["offramp"], "Direct"); // withdraw_eth — Cash-out button renders

    // VCHF (currency 7, 2026-08-28 spec U3+U5): the first complete NO-MINTER direct-ICRC asset.
    // The whole point of this row on THIS route: network "Internet Computer" must land the row
    // in the ICP MAINNET section (pre-U3 it was mis-filed testnet-side and hidden by default).
    // No minter/family, no ramps (honest absence — no Add/Cash actions, but Pay/Receive work),
    // exact locked ledger principal + 8 decimals + raw fee/cap as U64String decimal strings.
    let vchf = rows
        .iter()
        .find(|r| r["currency"] == 7)
        .expect("VCHF currency present");
    assert_eq!(vchf["mintable"], false);
    assert_eq!(vchf["symbol"], "VCHF");
    assert_eq!(vchf["decimals"], 8);
    assert_eq!(vchf["display_decimals"], 8);
    assert_eq!(vchf["wrapper_name"], "VCHF");
    assert_eq!(
        vchf["backing_symbol"], "VCHF",
        "payment unit is the issuer token VCHF, deliberately NOT CHF"
    );
    assert_eq!(vchf["network"], "Internet Computer"); // the U3 mainnet label
    assert_eq!(vchf["ledger"], "ly36x-wiaaa-aaaai-aqj7q-cai"); // catalog_truth vchf_ledger
    assert_eq!(vchf["fee"], "10000"); // 0.0001 VCHF raw
    assert_eq!(vchf["cap"], "1000000000000"); // 10,000 VCHF initial cap
                                              // No-minter shape: null minter + null family (no fake family to pass any gate).
    assert_eq!(vchf["minter"], serde_json::Value::Null);
    assert_eq!(vchf["minter_family"], serde_json::Value::Null);
    // Not EVM: all three chain fields null.
    assert_eq!(vchf["chain_id"], serde_json::Value::Null);
    assert_eq!(vchf["token_contract"], serde_json::Value::Null);
    assert_eq!(vchf["gas_ledger"], serde_json::Value::Null);
    // Ramp honesty: both Unavailable — the row is visible/payable with NO ramp actions.
    assert_eq!(vchf["onramp"], "Unavailable");
    assert_eq!(vchf["offramp"], "Unavailable");

    // ICP (currency 8): native ICP as a direct-ICRC asset — same complete no-minter shape, the
    // CANONICAL ledger principal (the same pin agent_ledger.rs's index-history dispatch keys
    // on), 8 decimals, 0.0001 ICP raw fee, 1,000 ICP initial cap.
    let icp = rows
        .iter()
        .find(|r| r["currency"] == 8)
        .expect("ICP currency present");
    assert_eq!(icp["mintable"], false);
    assert_eq!(icp["symbol"], "ICP");
    assert_eq!(icp["decimals"], 8);
    assert_eq!(icp["display_decimals"], 8);
    assert_eq!(icp["wrapper_name"], "ICP");
    assert_eq!(icp["backing_symbol"], "ICP");
    assert_eq!(icp["network"], "Internet Computer"); // the U3 mainnet label
    assert_eq!(icp["ledger"], "ryjl3-tyaaa-aaaaa-aaaba-cai"); // catalog_truth icp_ledger
    assert_eq!(icp["fee"], "10000"); // 0.0001 ICP raw
    assert_eq!(icp["cap"], "100000000000"); // 1,000 ICP initial cap
    assert_eq!(icp["minter"], serde_json::Value::Null);
    assert_eq!(icp["minter_family"], serde_json::Value::Null);
    assert_eq!(icp["chain_id"], serde_json::Value::Null);
    assert_eq!(icp["token_contract"], serde_json::Value::Null);
    assert_eq!(icp["gas_ledger"], serde_json::Value::Null);
    assert_eq!(icp["onramp"], "Unavailable");
    assert_eq!(icp["offramp"], "Unavailable");

    // VEUR (currency 9): the EUR dual-rail Stage 1 row (2026-09-06) — a complete no-minter
    // direct-ICRC mainnet asset in the VCHF/ICP shape, with the FIRST Partner off-ramp
    // (DFX, named via ramp_partner) and the first liquidity tier on an IC row. The optional
    // fields serialize ONLY when set — the ICP block above (no liquidity asserts reading
    // Null) doubles as the old-row absence pin for this route.
    let veur = rows
        .iter()
        .find(|r| r["currency"] == 9)
        .expect("VEUR currency present");
    assert_eq!(veur["mintable"], false);
    assert_eq!(veur["symbol"], "VEUR");
    assert_eq!(veur["decimals"], 8);
    assert_eq!(veur["display_decimals"], 8);
    assert_eq!(veur["min_fraction_digits"], 2);
    assert_eq!(veur["wrapper_name"], "VEUR");
    assert_eq!(veur["backing_symbol"], "VEUR"); // the issuer token — NEVER "EUR"
    assert_eq!(veur["network"], "Internet Computer"); // files mainnet-side (U3 label)
    assert_eq!(veur["ledger"], "wu6g4-6qaaa-aaaan-qmrza-cai"); // catalog_truth veur_ledger
    assert_eq!(veur["fee"], "10000"); // 0.0001 VEUR raw
    assert_eq!(veur["cap"], "1000000000000"); // 10,000 VEUR initial cap (mirrors VCHF — founder to confirm)
    assert_eq!(veur["minter"], serde_json::Value::Null);
    assert_eq!(veur["minter_family"], serde_json::Value::Null);
    assert_eq!(veur["chain_id"], serde_json::Value::Null);
    assert_eq!(veur["token_contract"], serde_json::Value::Null);
    assert_eq!(veur["gas_ledger"], serde_json::Value::Null);
    assert_eq!(veur["onramp"], "Unavailable"); // no compliant fiat on-ramp
    assert_eq!(veur["offramp"], "Partner"); // DFX fiat off-ramp — the first Partner row
    assert_eq!(veur["liquidity"], "thin");
    assert_eq!(veur["ramp_partner"], "DFX");
    // The pre-EUR rows on THIS served body: the optional keys are ABSENT (indexing an absent
    // key in a serde_json Value yields Null) — the route-level half of the byte-identity pin.
    assert_eq!(icp["liquidity"], serde_json::Value::Null);
    assert_eq!(icp["ramp_partner"], serde_json::Value::Null);
    assert_eq!(dusd["liquidity"], serde_json::Value::Null);
    assert_eq!(ckbtc["ramp_partner"], serde_json::Value::Null);

    // IC testnet section: exactly the rows the partition rule (network Some AND not in
    // {"Bitcoin","Ethereum","Internet Computer"}) classifies as testnet — the REAL testnet trio
    // (ckTESTBTC 3, ckSepoliaUSDC 4, ckSepoliaETH 5); VCHF/ICP's "Internet Computer" is
    // mainnet-side since U3.
    let trows = testnet["assets"]
        .as_array()
        .expect("icp testnet assets array");
    assert_eq!(
        trows.len(),
        3,
        "exactly the real testnet trio is testnet-side (ckTESTBTC/ckSepoliaUSDC/ckSepoliaETH; VCHF/ICP are mainnet): {body}"
    );
    let testnet_ids: Vec<u64> = trows
        .iter()
        .map(|r| r["currency"].as_u64().unwrap())
        .collect();
    assert_eq!(testnet_ids, vec![3, 4, 5], "testnet section order: {body}");

    // ckTESTBTC (currency 3): the REAL testnet chain-key Bitcoin row — its OWN testnet ledger +
    // minter (distinct from the mainnet ones), CkBtcUtxo family, testnet ramps both Direct.
    let cktestbtc = &trows[0];
    assert_eq!(cktestbtc["currency"], 3);
    assert_eq!(cktestbtc["mintable"], false);
    assert_eq!(cktestbtc["symbol"], "₿");
    assert_eq!(cktestbtc["wrapper_name"], "ckTESTBTC");
    assert_eq!(cktestbtc["backing_symbol"], "BTC");
    assert_eq!(cktestbtc["network"], "Bitcoin Testnet");
    assert_eq!(cktestbtc["minter_family"], "CkBtcUtxo");
    assert_eq!(cktestbtc["ledger"], "mc6ru-gyaaa-aaaar-qaaaq-cai"); // catalog_truth testnet_ckbtc_ledger
    assert_eq!(cktestbtc["minter"], "ml52i-qqaaa-aaaar-qaaba-cai"); // catalog_truth testnet_ckbtc_minter
    assert_eq!(cktestbtc["decimals"], 8);
    assert_eq!(cktestbtc["display_decimals"], serde_json::Value::Null);
    assert_eq!(cktestbtc["fee"], "10");
    assert_eq!(cktestbtc["cap"], "100000");
    assert_eq!(cktestbtc["onramp"], "Direct"); // free testnet rail
    assert_eq!(cktestbtc["offramp"], "Direct");

    // ckSepoliaUSDC (currency 4): the REAL testnet ckERC20 — Sepolia chain_id (11155111) selects
    // the Sepolia CkDeposit helper, its own testnet USDC contract, the Sepolia ckETH minter.
    // Ramp honesty: cash-out not wired on testnet USDC — offramp=Unavailable.
    let sep_usdc = &trows[1];
    assert_eq!(sep_usdc["currency"], 4);
    assert_eq!(sep_usdc["mintable"], false);
    assert_eq!(sep_usdc["symbol"], "ckSepoliaUSDC");
    assert_eq!(sep_usdc["wrapper_name"], "ckSepoliaUSDC");
    assert_eq!(sep_usdc["backing_symbol"], "USDC");
    assert_eq!(sep_usdc["network"], "Sepolia");
    assert_eq!(sep_usdc["minter_family"], "CkEthErc20");
    assert_eq!(sep_usdc["ledger"], "yfumr-cyaaa-aaaar-qaela-cai"); // catalog_truth testnet_ckusdc_ledger
    assert_eq!(sep_usdc["minter"], "jzenf-aiaaa-aaaar-qaa7q-cai"); // catalog_truth testnet_cketh_minter
    assert_eq!(sep_usdc["decimals"], 6);
    assert_eq!(sep_usdc["display_decimals"], serde_json::Value::Null);
    assert_eq!(sep_usdc["fee"], "4000");
    assert_eq!(sep_usdc["cap"], "100000");
    assert_eq!(sep_usdc["chain_id"], 11155111); // Sepolia
    assert_eq!(
        sep_usdc["token_contract"], "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        "the TESTNET USDC contract — NOT the mainnet address"
    );
    assert_eq!(sep_usdc["gas_ledger"], serde_json::Value::Null);
    assert_eq!(sep_usdc["onramp"], "Direct");
    assert_eq!(sep_usdc["offramp"], "Unavailable"); // testnet ckUSDC cash-out not wired

    // ckSepoliaETH (currency 5): the REAL testnet native-ETH row — token_contract null (the same
    // native discriminator as mainnet ckETH), 18 decimals, Sepolia chain_id, the Sepolia minter.
    let sep_eth = &trows[2];
    assert_eq!(sep_eth["currency"], 5);
    assert_eq!(sep_eth["mintable"], false);
    assert_eq!(sep_eth["symbol"], "Ξ");
    assert_eq!(sep_eth["wrapper_name"], "ckSepoliaETH");
    assert_eq!(sep_eth["backing_symbol"], "ETH");
    assert_eq!(sep_eth["network"], "Sepolia");
    assert_eq!(sep_eth["minter_family"], "CkEthErc20");
    assert_eq!(sep_eth["ledger"], "apia6-jaaaa-aaaar-qabma-cai"); // catalog_truth testnet_cketh_ledger
    assert_eq!(sep_eth["minter"], "jzenf-aiaaa-aaaar-qaa7q-cai"); // catalog_truth testnet_cketh_minter
    assert_eq!(sep_eth["decimals"], 18);
    assert_eq!(sep_eth["display_decimals"], 6);
    assert_eq!(sep_eth["fee"], "10000000000");
    assert_eq!(sep_eth["cap"], "100000");
    assert_eq!(sep_eth["chain_id"], 11155111); // Sepolia
    assert_eq!(sep_eth["token_contract"], serde_json::Value::Null); // None ⇒ native ETH
    assert_eq!(sep_eth["gas_ledger"], serde_json::Value::Null);
    assert_eq!(sep_eth["onramp"], "Direct");
    assert_eq!(sep_eth["offramp"], "Direct");

    // Solana mainnet section — relay-level constants mirroring app/solana.ts EXACTLY: SOL 9
    // decimals (SOL_DECIMALS, mint null — native), USDC 6 decimals (USDC_DECIMALS) + the mainnet
    // USDC mint (USDC_MINT_ADDRESS), and (2026-09-06, EUR dual-rail Stage 1) EURC 6 decimals +
    // its mainnet mint with liquidity "deep". Fiat-ramp semantics (corrected 2026-09-06): the
    // onramp/offramp fields declare FIAT ramps now — SOL/USDC honestly read Unavailable (the
    // old Direct meant structural self-custody, a tautology on the device-key rail); no
    // RPC/keys served.
    let srows = solana["assets"].as_array().expect("solana assets array");
    assert_eq!(srows.len(), 3, "solana mainnet = SOL + USDC + EURC: {body}");
    let sol = &srows[0];
    assert_eq!(sol["token"], "SOL");
    assert_eq!(sol["symbol"], "SOL");
    assert_eq!(sol["decimals"], 9);
    assert_eq!(
        sol["mint"],
        serde_json::Value::Null,
        "native SOL carries no SPL mint"
    );
    assert_eq!(sol["onramp"], "Unavailable"); // fiat-ramp semantics (was Direct)
    assert_eq!(sol["offramp"], "Unavailable"); // fiat-ramp semantics (was Direct)
    assert_eq!(
        sol["liquidity"],
        serde_json::Value::Null,
        "pre-EUR row: no tier key"
    );
    let usdc = &srows[1];
    assert_eq!(usdc["token"], "USDC");
    assert_eq!(usdc["symbol"], "USDC");
    assert_eq!(usdc["decimals"], 6);
    assert_eq!(
        usdc["mint"], "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "the app's USDC_MINT_ADDRESS verbatim (app/solana/spl.ts)"
    );
    assert_eq!(usdc["onramp"], "Unavailable"); // fiat-ramp semantics (was Direct)
    assert_eq!(usdc["offramp"], "Unavailable"); // fiat-ramp semantics (was Direct)
    assert_eq!(
        usdc["liquidity"],
        serde_json::Value::Null,
        "pre-EUR row: no tier key"
    );
    // EURC: the solana half of the EUR dual-rail — deep liquidity, no fiat ramp through dpay.
    let eurc = &srows[2];
    assert_eq!(eurc["token"], "EURC");
    assert_eq!(eurc["symbol"], "EURC");
    assert_eq!(eurc["decimals"], 6);
    assert_eq!(eurc["min_fraction_digits"], 2); // unit-denominated: '1.50'
    assert_eq!(
        eurc["mint"], "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
        "catalog_truth eurc_mint (Circle's native solana EURC)"
    );
    assert_eq!(eurc["onramp"], "Unavailable");
    assert_eq!(eurc["offramp"], "Unavailable");
    assert_eq!(eurc["liquidity"], "deep");
}

// --- batch balances (the N+1→1 poll fix) --------------------------------------
//
// Covers GET /api/v1/balances/{hex} (PLURAL) — the single-fetch batch endpoint that returns EVERY
// currency's balance in one response, replacing the wallet's old N+1 per-poll loop (1 primary fetch
// + 1 per-asset fetch, each a relay→IC round trip). With the 10-currency demo catalog this is 1 HTTP
// request instead of 10. Response shape: a flat map `{<currency>: <minor-units-string>}`, currency
// index as a decimal-string key, balance as a U64String (decimal string). Mirrors how the wallet
// consumes it.

/// `GET /api/v1/balances/{hex}` returns `200` with a flat map of EVERY catalog currency's balance in
/// ONE response. The payer is funded BAL_A in DEMO_USD (currency 0); every other catalog currency is
/// unfunded → "0". Asserts: all 10 catalog currencies present (incl. VCHF 7 + ICP 8 + VEUR 9 —
/// zero-balance no-minter rows still enumerate), the funded primary reads BAL_A, the unfunded assets
/// read "0", and the values are DECIMAL STRINGS (the MC1 units 2-4 shape — raw u64 across the JSON
/// boundary as a string, never a number).
#[tokio::test]
async fn balances_route_returns_all_currencies_in_one_response() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger());

    let (status, body) = call(
        &state,
        get_req(&format!("/api/v1/balances/{}", hex::encode(pubkey(&payer)))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A flat map (not wrapped under a key) — every catalog currency is a top-level entry.
    assert!(
        body.is_object(),
        "balances response is a JSON object: {body}"
    );
    assert_eq!(
        body.as_object().unwrap().len(),
        10,
        "demo catalog = 10 currencies (7 pre-existing + VCHF + ICP + VEUR), all present in one batch: {body}"
    );

    // Every catalog currency is present and unfunded → "0" (nothing pre-funds the
    // FakeLedger anymore — balances live at user principals on the fake-IC gateway).
    for c in 0..=9u32 {
        assert_eq!(
            body[c.to_string()],
            "0",
            "currency {c} present + unfunded (FakeLedger default 0): {body}"
        );
    }

    // A SECOND account (the merchant, also unfunded in DEMO_USD per the test ledger) reads all-zero
    // across the batch — proves the map is account-specific, not a constant.
    let (status_m, body_m) = call(
        &state,
        get_req(&format!(
            "/api/v1/balances/{}",
            hex::encode(pubkey(&merchant))
        )),
    )
    .await;
    assert_eq!(status_m, StatusCode::OK, "{body_m}");
    assert_eq!(body_m["0"], "0", "merchant primary unfunded: {body_m}");
}

/// The settlement-era routes stay DEAD (2026-08-19 cutover): everything value-bearing left the
/// relay for the app's own signed /api/v2 envelopes. This pins the tombstone — a reintroduced
/// route here would silently put the relay back in the value path. The test-helpers-only
/// single-currency balance fixture joined them (deleted 2026-09-06 — the e2e harness migrated to
/// the always-on batch route). Note /api/v1/faucet legitimately exists under test-helpers
/// (fixture route, separately tested); everything below must 404 in EVERY build.
#[tokio::test]
async fn settlement_era_routes_stay_404() {
    let (state, _led) = state_from(ledger());
    let gone = [
        "/api/v1/pay",
        "/api/v1/withdraw",
        "/api/v1/receipt/00",
        "/api/v1/receipt_pubkey",
        "/api/v1/deposit/address/00",
        "/api/v1/deposit/refresh/00",
        "/api/v1/test/deposit/seed",
        "/api/v1/balance/00",
    ];
    for path in gone {
        // call_raw, not call: a 404 carries no JSON body to parse.
        let (status, _h, _b) = call_raw(&state, get_req(path)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path} must stay 404");
    }
}

/// A bad account (not 32 bytes hex) is a clean `400` — the shared pubkey hex-decode contract.
#[tokio::test]
async fn balances_route_rejects_bad_pubkey() {
    let (state, _led) = state_from(ledger());

    let (status, body) = call(&state, get_req("/api/v1/balances/deadbeef")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

// --- ckERC-20 onramp surface (ckUSDC; M2) -------------------------------------
//
// Covers GET /api/v1/onramp/ckerc20 — surfaces the runtime parameters (helper contract, ERC-20
// address) the app needs to build the user's two Ethereum transactions for a ckERC-20 onramp. The
// deposit `principal` arg is the user's OWN IC principal (derived in-app; ICRC-1 default subaccount),
// so the relay serves no principal field. ckUSDC is a ckERC-20 token handled by the ckETH minter; it
// has NO per-principal IC address and NO user-callable mint (the user signs both ETH txs in their own
// wallet). Only the CkEthErc20-family currencies have an onramp; a non-ckERC-20 currency → 503.

/// `GET /api/v1/onramp/ckerc20?currency=2` (ckUSDC) → `200` with the verified mainnet onramp
/// constants. `?currency=0` (DEMO_USD, not a ckERC-20 currency) → `503` (no onramp configured).
#[tokio::test]
async fn ckerc20_onramp_returns_params_for_ckusdc() {
    let (state, _led) = state_from(ledger());

    // currency 2 (ckUSDC) → 200 with the verified mainnet onramp constants.
    let (status, body) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=2")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["helper_address"],
        "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68"
    );
    assert_eq!(
        body["erc20_address"],
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    );
    // No principal is served — the deposit `principal` arg is the user's own IC principal, derived
    // in-app. (Regression-pins the field removal: the facade-era `facade_principal` minted at the
    // FACADE principal, invisible to user-principal balance reads.)
    assert!(
        body.get("facade_principal").is_none(),
        "facade_principal must be gone from the onramp body: {body}"
    );

    // currency 0 (DEMO_USD) → 503: DEMO_USD has no ckERC-20 onramp configured.
    let (status0, _body0) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=0")).await;
    assert_eq!(status0, StatusCode::SERVICE_UNAVAILABLE);
}

/// MC8 U2 — the ckERC-20 onramp is CATALOG/TOKEN-SPECIFIC, not hardcoded to currency 2 / USDC.
///
/// Before U2 the impl was `if currency == 2 { erc20_address = CKUSDC_ERC20_ADDRESS } else { Err }` —
/// every future ckERC20 (a second token, ckETH, …) inherited ckUSDC's address or got a 503. U2
/// resolves the currency descriptor from the catalog and reads the per-token `token_contract`
/// instead, so with the REAL catalog:
///   - ckUSDC (currency 2) → the USDC ERC-20 address + the MAINNET CkDeposit helper (NO regression).
///   - ckSepoliaUSDC (currency 4) → the Sepolia USDC address + the SEPOLIA helper (NOT USDC's
///     address, NOT the mainnet helper — proves both token-specificity AND chain-scoping through
///     the served route).
///   - ckTESTBTC (3) / ckBTC (1) / DEMO (0) → 503 (not a CkEthErc20 family currency).
///
/// The `helper_address` is chain-scoped (the mainnet/Sepolia CkDeposit constants) and comes from
/// the same descriptor's `chain_id`; only the `erc20_address` source moved to the catalog.
#[tokio::test]
async fn ckerc20_onramp_is_token_specific() {
    let (state, _led) = state_from(ledger());

    // ckUSDC (currency 2) → 200 with the USDC ERC-20 address (NO regression — same as the golden above).
    let (s_usdc, body_usdc) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=2")).await;
    assert_eq!(s_usdc, StatusCode::OK, "{body_usdc}");
    assert_eq!(
        body_usdc["helper_address"],
        "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68"
    );
    assert_eq!(
        body_usdc["erc20_address"],
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    );

    // ckSepoliaUSDC (currency 4) → 200 with the SEPOLIA USDC address + the SEPOLIA helper — NOT
    // the mainnet pair. This is the token-specificity proof through the served route: a second
    // ckERC20 reads ITS OWN `token_contract` from the catalog, and its `chain_id` selects its own
    // CkDeposit helper (the two txs must target contracts on the SAME chain).
    let (s_sep, body_sep) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=4")).await;
    assert_eq!(s_sep, StatusCode::OK, "{body_sep}");
    assert_eq!(
        body_sep["helper_address"], "0x2D39863d30716aaf2B7fFFd85Dd03Dda2BFC2E38",
        "chain_id 11155111 selects the Sepolia CkDeposit helper"
    );
    assert_eq!(
        body_sep["erc20_address"],
        "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
    );
    assert_ne!(
        body_sep["erc20_address"], body_usdc["erc20_address"],
        "ckSepoliaUSDC must NOT inherit ckUSDC's ERC-20 address",
    );
    assert_ne!(
        body_sep["helper_address"], body_usdc["helper_address"],
        "the Sepolia row must NOT surface the mainnet helper",
    );

    // ckBTC (currency 1) → 503: CkBtcUtxo family, not CkEthErc20 — no ckERC-20 onramp.
    let (s_btc, _body_btc) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=1")).await;
    assert_eq!(s_btc, StatusCode::SERVICE_UNAVAILABLE);

    // ckTESTBTC (currency 3) → 503: CkBtcUtxo family (testnet) — same fail-closed family gate.
    let (s_tb, _body_tb) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=3")).await;
    assert_eq!(s_tb, StatusCode::SERVICE_UNAVAILABLE);

    // Native ckETH (currency 6) → 200 with kind "native_eth": same CkEthErc20 family, but its
    // `token_contract` is null — the resolver discriminates the one-tx `depositEth` shape
    // (erc20_address null) instead of failing. Served-route companion to the unit test below.
    let (s_eth, body_eth) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=6")).await;
    assert_eq!(s_eth, StatusCode::OK, "{body_eth}");
    assert_eq!(body_eth["kind"], "native_eth");
    assert!(body_eth["erc20_address"].is_null());
    assert_eq!(
        body_eth["helper_address"],
        "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68"
    );

    // DEMO (currency 0) → 503: no minter family — no ckERC-20 onramp.
    let (s_demo, _body_demo) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=0")).await;
    assert_eq!(s_demo, StatusCode::SERVICE_UNAVAILABLE);

    // An unknown currency id (999, not in the catalog) → 503 (fail-closed — never falls back).
    let (s_unk, _body_unk) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=999")).await;
    assert_eq!(s_unk, StatusCode::SERVICE_UNAVAILABLE);
}

/// MC8 U2 + native-ETH — within the CkEthErc20 family, `token_contract` discriminates the deposit
/// shape: `None` ⇒ native ETH (one payable `depositEth` tx, `kind="native_eth"`, `erc20_address`
/// null); `Some` ⇒ an ERC-20 token (`kind="erc20"`). The fail-closed invariant is now at the FAMILY
/// level: a non-CkEthErc20 descriptor (e.g. CkBtcUtxo) or a missing descriptor MUST surface a
/// `Transient` (HTTP 503), never a silent default address. Pinned directly against the pure resolver
/// the FakeLedger + AgentLedger impls share, so the gate is single-sourced and testable in isolation.
#[tokio::test]
async fn ckerc20_onramp_native_eth_without_token_contract() {
    // A CkEthErc20-family descriptor with NO token_contract — native ETH (ckSepoliaETH shape).
    let native = dpay_relay::CurrencyDescriptor {
        currency: 7,
        ledger: "xevnm-gaaaa-aaaar-qafnq-cai".to_string(),
        mintable: false,
        minter: Some("sv3dd-oaaaa-aaaar-qacoa-cai".to_string()),
        minter_family: Some(dpay_relay::MinterFamily::CkEthErc20),
        symbol: Some("ckETH".into()),
        decimals: Some(18),
        wrapper_name: Some("ckETH".into()),
        backing_symbol: Some("ETH".into()),
        network: Some("Ethereum".into()),
        display_decimals: Some(18),
        min_fraction_digits: None,
        fee: None,
        cap: None,
        chain_id: Some(1),
        token_contract: None, // ← native ETH (not a partial ERC-20 registration)
        gas_ledger: None,
        onramp: dpay_relay::RampCapability::Direct,
        offramp: dpay_relay::RampCapability::Direct,
        liquidity: None,
        ramp_partner: None,
    };
    let r = dpay_relay::ckerc20_onramp_from_descriptor(Some(&native))
        .expect("a CkEthErc20 with no token_contract must resolve a NATIVE-ETH onramp");
    assert_eq!(
        r.kind, "native_eth",
        "token_contract=None discriminates native ETH",
    );
    assert!(
        r.erc20_address.is_none(),
        "native ETH carries no ERC-20 address",
    );
    assert_eq!(
        r.helper_address, "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68",
        "mainnet chain_id selects the mainnet CkDeposit helper (shared by depositEth + depositErc20)",
    );
    // Also: a non-CkEthErc20 descriptor (e.g. CkBtcUtxo) and a missing descriptor both fail closed.
    let ckbtc = dpay_relay::CurrencyDescriptor {
        currency: 1,
        ledger: "mxzaz-hqaaa-aaaar-qaada-cai".to_string(),
        mintable: false,
        minter: Some("mqygn-kiaaa-aaaar-qaadq-cai".to_string()),
        minter_family: Some(dpay_relay::MinterFamily::CkBtcUtxo),
        symbol: Some("₿".into()),
        decimals: Some(8),
        wrapper_name: Some("ckBTC".into()),
        backing_symbol: Some("BTC".into()),
        network: Some("Bitcoin".into()),
        display_decimals: Some(8),
        min_fraction_digits: None,
        fee: None,
        cap: None,
        chain_id: None,
        token_contract: None,
        gas_ledger: None,
        onramp: dpay_relay::RampCapability::Direct,
        offramp: dpay_relay::RampCapability::Direct,
        liquidity: None,
        ramp_partner: None,
    };
    assert!(dpay_relay::ckerc20_onramp_from_descriptor(Some(&ckbtc)).is_err());
    assert!(dpay_relay::ckerc20_onramp_from_descriptor(None).is_err());
}

/// OPEN_ISSUES #1/#2 — the `helper_address` is NETWORK-scoped, not a single mainnet constant. The
/// ckETH minter deploys its own CkDeposit helper on each chain it bridges: Ethereum mainnet (chain_id
/// 1) and Sepolia testnet (chain_id 11155111). A testnet ckERC20 (e.g. ckSepoliaUSDC) MUST surface
/// the Sepolia helper, not the mainnet one — otherwise the user's approve+depositErc20 txs would
/// target a contract on the wrong chain and never credit (non-custodial-trust violation: the deposit
/// silently fails). This pins the chain-id gate in the pure resolver both paths (FakeLedger +
/// AgentLedger) share, so the two can't drift.
#[tokio::test]
async fn ckerc20_onramp_helper_is_chain_scoped() {
    // A CkEthErc20 descriptor on Sepolia (chain_id 11155111) — the testnet wiring shape.
    let sepolia = dpay_relay::CurrencyDescriptor {
        currency: 4,
        ledger: "yfumr-cyaaa-aaaar-qaela-cai".to_string(),
        mintable: false,
        minter: Some("jzenf-aiaaa-aaaar-qaa7q-cai".to_string()),
        minter_family: Some(dpay_relay::MinterFamily::CkEthErc20),
        symbol: Some("ckSepoliaUSDC".into()),
        decimals: Some(6),
        wrapper_name: Some("ckSepoliaUSDC".into()),
        backing_symbol: Some("USDC".into()),
        network: Some("Sepolia".into()),
        display_decimals: Some(6),
        min_fraction_digits: None,
        fee: None,
        cap: None,
        chain_id: Some(11155111), // Sepolia
        token_contract: Some("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".into()),
        gas_ledger: None,
        onramp: dpay_relay::RampCapability::Direct,
        offramp: dpay_relay::RampCapability::Unavailable,
        liquidity: None,
        ramp_partner: None,
    };
    let r_sep = dpay_relay::ckerc20_onramp_from_descriptor(Some(&sepolia))
        .expect("Sepolia ckERC20 must resolve an onramp");
    assert_eq!(
        r_sep.helper_address, "0x2D39863d30716aaf2B7fFFd85Dd03Dda2BFC2E38",
        "Sepolia chain_id must select the Sepolia CkDeposit helper",
    );
    assert_eq!(
        r_sep.erc20_address,
        Some("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".to_string()),
        "the per-token ERC-20 address is unchanged (read from the descriptor's token_contract)",
    );
    assert_eq!(
        r_sep.kind, "erc20",
        "a token_contract=Some discriminates erc20"
    );

    // Same family + token on MAINNET (chain_id 1) → mainnet helper.
    let mut mainnet = sepolia.clone();
    mainnet.chain_id = Some(1);
    let r_main = dpay_relay::ckerc20_onramp_from_descriptor(Some(&mainnet))
        .expect("mainnet ckERC20 must resolve an onramp");
    assert_eq!(
        r_main.helper_address, "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68",
        "mainnet chain_id must select the mainnet CkDeposit helper",
    );
    assert_eq!(
        r_main.erc20_address, r_sep.erc20_address,
        "the per-token ERC-20 address is identical across chains (same token_contract)",
    );
    assert_eq!(
        r_main.kind, "erc20",
        "mainnet ERC-20 still discriminates erc20"
    );

    // A CkEthErc20 with chain_id=None (a non-EVM-family metadata gap) → falls through to mainnet
    // (the safe default — the existing verified value, never a silent None/panic).
    let mut no_chain = sepolia.clone();
    no_chain.chain_id = None;
    let r_none = dpay_relay::ckerc20_onramp_from_descriptor(Some(&no_chain))
        .expect("a chain_id-less ckERC20 must still resolve an onramp (mainnet default)");
    assert_eq!(
        r_none.helper_address, "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68",
        "chain_id=None falls through to the mainnet helper (safe default)",
    );
}

// --- Web wallet (GET /wallet + /assets/* — the embedded prod build of the REAL app) ------------
//
// /wallet is no longer a hand-written page: build.rs embeds `e2e/dist-prod` (the REAL app/App.tsx
// built via react-native-web + the wasm DpayCore — `just web` produces it). The money-critical
// parity of that build is proven elsewhere (wasm-core guard + the 74-flow e2e suite drives this
// exact DpayCore surface); these route tests pin the SERVING surface: the page, its hashed assets,
// the cache policy, and the removed legacy routes.

/// `GET /wallet` serves the real-app dist HTML: the React root, a reference to the content-hashed
/// entry asset, and the CSP that lets the page compile the wasm core. A missing/renamed hashed
/// asset reference = the page loads broken despite 200, so the referenced asset is fetched too.
#[tokio::test]
async fn wallet_page_serves_embedded_real_app_dist() {
    let (state, _led) = state_from(ledger());

    let (status, headers, bytes) = call_raw(&state, get_req("/wallet")).await;
    assert_eq!(status, StatusCode::OK, "/wallet must serve");
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    assert_eq!(
        headers.get(header::CACHE_CONTROL).map(|v| v.to_str().unwrap()),
        Some("no-cache"),
        "/wallet HTML must be no-cache (it pins the hashed assets; a stale HTML is the APK-cache bug)"
    );
    let html = String::from_utf8(bytes).unwrap();
    assert!(
        html.contains("id=\"root\""),
        "/wallet must carry the React root"
    );
    assert!(
        html.contains("assets/wallet-"),
        "/wallet must reference the content-hashed entry bundle"
    );
    assert!(
        html.contains("wasm-unsafe-eval"),
        "/wallet CSP must allow compiling the wasm core (a stripped directive bricks the app in prod)"
    );
    // The hand-written page is gone — none of its markers may survive.
    for stale in ["wallet-wire-v2", "noble-hashes", "wordlist", "/ed25519.js"] {
        assert!(
            !html.contains(stale),
            "/wallet must not contain stale marker {stale}"
        );
    }

    // The referenced entry asset serves as JavaScript with the immutable cache policy. The src is
    // an absolute path (/assets/wallet-<hash>.js) — use it verbatim as the request path.
    let start = html.find("assets/wallet-").expect("hashed entry reference") - "/".len();
    let end = html[start..].find('"').expect("closing quote") + start;
    let entry = &html[start..end];
    let (status, headers, bytes) = call_raw(&state, get_req(entry)).await;
    assert_eq!(status, StatusCode::OK, "{entry} must serve");
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(
        headers
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap()),
        Some("public, max-age=31536000, immutable"),
        "hashed assets must be immutable (the hash IS the version)"
    );
    assert!(!bytes.is_empty(), "the entry bundle must have a body");
}

/// A shared PAYMENT LINK (`/wallet/pay/<recipient>?asset=…&network=…&amount=…`) serves the SAME
/// wallet page, byte-for-byte: the link's fields live in the URL and the app reads them off its own
/// location. A nested path is NOT the route (404) — the recipient is one path segment, so a
/// mangled link fails visibly at the door instead of rendering a wallet with a truncated address.
#[tokio::test]
async fn wallet_pay_link_serves_the_wallet_page() {
    let (state, _led) = state_from(ledger());

    let (plain_status, _h, plain) = call_raw(&state, get_req("/wallet")).await;
    assert_eq!(plain_status, StatusCode::OK);

    let link =
        "/wallet/pay/ryjl3-tyaaa-aaaaa-aaaba-cai?asset=VCHF&network=internet-computer&amount=12.50";
    let (status, headers, bytes) = call_raw(&state, get_req(link)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a payment link must serve the wallet"
    );
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    assert_eq!(
        headers
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap()),
        Some("no-cache"),
        "the payment-link page pins hashed assets exactly like /wallet — it must not be cached"
    );
    assert_eq!(
        headers
            .get(header::CONTENT_SECURITY_POLICY)
            .map(|v| v.to_str().unwrap()),
        Some("frame-ancestors 'none'"),
        "a payment link must carry the same no-framing guarantee as /wallet (clickjacking a \
         pre-filled payment review is the worst place to lose it)"
    );
    assert_eq!(
        bytes, plain,
        "the payment link must serve the identical page — the link is read client-side, never \
         interpreted by the relay"
    );

    // The recipient is exactly one segment: anything deeper is not a payment link.
    let (nested, _h, _b) = call_raw(
        &state,
        get_req("/wallet/pay/ryjl3-tyaaa-aaaaa-aaaba-cai/extra?asset=VCHF&network=internet-computer&amount=1"),
    )
    .await;
    assert_eq!(nested, StatusCode::NOT_FOUND, "a nested pay path must 404");
}

/// `GET /.well-known/assetlinks.json` — the Android App Links association that makes a shared
/// payment link open the installed app. It must be valid JSON, name the Play application id, and
/// carry ALL FOUR project certificate fingerprints (the three Google-held Play App Signing keys +
/// the founder-held upload key that signs sideloaded `just apk` builds). A missing fingerprint
/// silently downgrades those installs to "link opens a browser tab", which no test would catch.
#[tokio::test]
async fn assetlinks_json_declares_every_signing_certificate() {
    let (state, _led) = state_from(ledger());

    let (status, headers, bytes) = call_raw(&state, get_req("/.well-known/assetlinks.json")).await;
    assert_eq!(status, StatusCode::OK, "assetlinks.json must serve");
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    assert_eq!(
        headers
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap()),
        Some("no-cache"),
        "Android re-verifies on install/update — a cached copy would outlive a cert rotation"
    );

    let v: Value = serde_json::from_slice(&bytes).expect("assetlinks.json must be valid JSON");
    let entry = v.get(0).expect("one statement");
    assert_eq!(
        entry["relation"][0], "delegate_permission/common.handle_all_urls",
        "the statement must delegate URL handling"
    );
    assert_eq!(entry["target"]["namespace"], "android_app");
    assert_eq!(
        entry["target"]["package_name"], "org.kalaj.dpay",
        "must name the Play application id (NOT the com.dpay source namespace)"
    );
    let fps = entry["target"]["sha256_cert_fingerprints"]
        .as_array()
        .expect("fingerprint array");
    // The exact certificates documented in app/android/app/play-signing/README.md.
    for fp in [
        "1C:5E:E4:87:52:6D:63:FC:53:DD:FD:21:93:F5:3A:FC:AB:9C:0B:31:7C:43:1F:AC:D6:19:34:63:CC:D7:27:A8", // Play deployment
        "97:FD:D0:85:8A:17:39:C4:70:4D:94:A3:AF:D8:48:AD:88:F4:15:52:D1:13:26:5E:51:D7:0D:EC:9B:80:EC:53", // hybrid classical
        "9E:F9:18:3B:37:9B:C0:7E:E0:B1:5D:70:F5:60:C0:F2:1C:39:D2:44:0A:DE:56:A9:09:6A:63:43:66:C5:D1:BE", // hybrid PQC
        "1E:5C:F5:10:04:51:87:9C:BD:08:1C:C0:A1:3A:15:63:43:18:AD:32:A0:E7:6A:E8:07:A9:91:18:0E:FC:89:D1", // upload (sideloaded APKs)
    ] {
        assert!(
            fps.iter().any(|f| f == fp),
            "missing signing certificate fingerprint {fp}"
        );
    }
    assert_eq!(fps.len(), 4, "exactly the four project certificates");
}

/// Unknown asset names and the REMOVED legacy routes (the hand-written wallet's vendored scripts,
/// and — since the 2026-08-16 merge — the hand-rolled merchant terminal's decoder/QR deps) are a
/// clean 404 — never a 200 with an empty body.
#[tokio::test]
async fn wallet_assets_404_cleanly_and_legacy_routes_are_gone() {
    let (state, _led) = state_from(ledger());

    // No catch-all: near-miss/unknown asset paths 404.
    for path in [
        "/assets/does-not-exist-JsFkQ0.js",
        "/assets/",
        "/wallet.html.extra",
        "/noble-hashes.js", // removed with the hand-written wallet
        "/wordlist.js",     // removed with the hand-written wallet
        "/ed25519.js",      // never coming back — the wasm core signs
        "/jsqr.js",         // removed with the hand-rolled merchant terminal (2026-08-16 merge)
        "/qrcode.js",       // removed with the hand-rolled merchant terminal (2026-08-16 merge)
    ] {
        let (status, _h, _b) = call_raw(&state, get_req(path)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path} must 404");
    }
}

// --- Offline shell + precompression (OPEN_ISSUES X10 / X12) -------------------------------------
//
// X12 measured every asset leaving this relay with `encodedBodySize == decodedBodySize`: 2.0 MB of
// wallet with no compression on the wire at all. The web build now brotli-compresses every
// compressible output at max quality and build.rs refuses a dist where one is missing, so these
// tests pin the SERVING half: the negotiation, and the two containers that must never be encoded
// twice.

/// A hashed asset is served as the build's brotli when the client asks for it, as the identity
/// bytes when it does not, and `Vary` is on BOTH so a shared cache cannot cross the two.
#[tokio::test]
async fn hashed_assets_are_served_brotli_only_when_the_client_asks() {
    let (state, _led) = state_from(ledger());

    // Find the entry bundle's hashed name off the page that references it (no hardcoded hash).
    let (_s, _h, html) = call_raw(&state, get_req("/wallet")).await;
    let html = String::from_utf8(html).unwrap();
    let start = html
        .find("/assets/wallet-")
        .expect("entry bundle referenced");
    let end = start + html[start..].find(".js").expect("entry bundle is .js") + 3;
    let bundle = &html[start..end];

    let (status, headers, identity) = call_raw(&state, get_req(bundle)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers.get(header::CONTENT_ENCODING).is_none(),
        "no Accept-Encoding must yield the identity body, not a brotli one the client cannot read"
    );
    assert_eq!(
        headers.get(header::VARY).map(|v| v.to_str().unwrap()),
        Some("accept-encoding"),
        "Vary must be present on the identity response too, or a cache will serve it to a br client"
    );

    let req = Request::builder()
        .method("GET")
        .uri(bundle)
        .header(header::ACCEPT_ENCODING, "gzip, deflate, br, zstd")
        .body(Body::empty())
        .unwrap();
    let (status, headers, compressed) = call_raw(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_ENCODING)
            .map(|v| v.to_str().unwrap()),
        Some("br")
    );
    assert_eq!(
        headers
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap()),
        Some("public, max-age=31536000, immutable"),
        "the encoding must not change the caching contract — the filename is still the version"
    );
    assert!(
        compressed.len() * 2 < identity.len(),
        "the app bundle must compress by more than 2× (measured 4.2×), got {} from {}",
        compressed.len(),
        identity.len()
    );

    // `br;q=0` is an explicit REFUSAL of brotli, not a request for it.
    let req = Request::builder()
        .method("GET")
        .uri(bundle)
        .header(header::ACCEPT_ENCODING, "br;q=0, gzip")
        .body(Body::empty())
        .unwrap();
    let (_status, headers, body) = call_raw(&state, req).await;
    assert!(
        headers.get(header::CONTENT_ENCODING).is_none(),
        "br;q=0 refuses brotli"
    );
    assert_eq!(
        body.len(),
        identity.len(),
        "a refusal gets the identity body"
    );
}

/// WOFF2 is brotli inside the container: re-encoding it would grow the response and force a
/// pointless decode. It must go out unencoded and WITHOUT `Vary` — its body never varies.
#[tokio::test]
async fn fonts_are_never_encoded_twice() {
    let (state, _led) = state_from(ledger());

    let (_s, _h, html) = call_raw(&state, get_req("/wallet")).await;
    let html = String::from_utf8(html).unwrap();
    let start = html
        .find("/assets/plex_mono_500-")
        .expect("mono font referenced");
    let end = start + html[start..].find(".woff2").expect("font is .woff2") + 6;
    let font = &html[start..end];

    let req = Request::builder()
        .method("GET")
        .uri(font)
        .header(header::ACCEPT_ENCODING, "br")
        .body(Body::empty())
        .unwrap();
    let (status, headers, bytes) = call_raw(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap()),
        Some("font/woff2")
    );
    assert!(headers.get(header::CONTENT_ENCODING).is_none());
    assert!(headers.get(header::VARY).is_none());
    assert_eq!(
        &bytes[..4],
        b"wOF2",
        "the wOF2 signature must reach the browser intact"
    );
}

/// The offline shell (X10): the worker at the ROOT scope, `no-cache` so a deploy reaches it on the
/// next navigation; the manifest and the icon it names. The worker must arrive fully built — a
/// template placeholder shipping would mean a syntax error and no offline wallet at all.
#[tokio::test]
async fn service_worker_manifest_and_icon_are_served_from_the_root() {
    let (state, _led) = state_from(ledger());

    let (status, headers, bytes) = call_raw(&state, get_req("/sw.js")).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "/sw.js must serve from the root (its scope is /)"
    );
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap()),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(
        headers
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap()),
        Some("no-cache"),
        "a cached service worker pins an old bundle past a deploy — it must revalidate every time"
    );
    let sw = String::from_utf8(bytes).unwrap();
    assert!(
        !sw.contains("__DPAY_SW_"),
        "the build must substitute every sw.js placeholder; one shipping is a syntax error"
    );
    assert!(
        sw.contains("dpay-shell-") && sw.contains("\"/wallet\""),
        "the worker must carry its versioned cache name and precache the shell document"
    );

    let (status, headers, bytes) = call_raw(&state, get_req("/manifest.webmanifest")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap()),
        Some("application/manifest+json")
    );
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(manifest["start_url"], "/wallet");
    assert_eq!(manifest["icons"][0]["src"], "/icon-192.png");

    let (status, headers, bytes) = call_raw(&state, get_req("/icon-192.png")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap()),
        Some("image/png")
    );
    assert_eq!(
        &bytes[1..4],
        b"PNG",
        "the manifest's icon must be a real PNG"
    );
}

// --- Shared wasm core (GET /dpay-core.wasm) -----------------------------------------------------
//
// crates/dpay-wasm compiles the frozen Rust wire core to wasm32 so every web surface signs the
// SAME bytes as Android. The artifact is staged at assets/dpay-core.wasm (committed) and its
// byte-parity against the trusted JS oracle is enforced offline by scripts/check-wasm-core.mjs
// (`just wasm`); this route test pins only the serving surface.

/// `GET /dpay-core.wasm` serves the staged core as `application/wasm` starting with the wasm magic
/// bytes; a near-miss vendored path stays a clean 404 (no catch-all).
#[tokio::test]
async fn wasm_core_served_and_unknown_path_is_404() {
    let (state, _led) = state_from(ledger());

    let (status, headers, bytes) = call_raw(&state, get_req("/dpay-core.wasm")).await;
    assert_eq!(status, StatusCode::OK, "/dpay-core.wasm must serve");
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "application/wasm"
    );
    assert!(bytes.len() > 4, "the wasm body must not be empty");
    assert_eq!(
        &bytes[..4],
        b"\0asm",
        "must start with the wasm magic bytes"
    );

    // No catch-all: a near-miss asset path is a clean 404.
    let (status, _h, _b) = call_raw(&state, get_req("/dpay-core.wasi")).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "unknown wasm-ish path must 404"
    );
}

// --- the merchant till: dpay AS an OpenCryptoPay provider ---------------------------------------
// `crates/dpay-relay/src/till.rs` owns the rules and tests them as pure functions; what is asserted
// here is the HTTP surface a THIRD-PARTY wallet meets — the paths the standard dictates, the field
// names it parses, and the two behaviours that distinguish this provider from the measured one:
// settlement is observed on the ledger rather than announced by the payer, and reporting is safe to
// retry. The bodies themselves are pinned as a golden: `dfx/till_wire.json`.

/// A relay that SERVES the till, with the fake-IC gateway behind it (the merchant's incoming
/// history is what settles a charge). The `with_till` is explicit and load-bearing: without it the
/// eight routes are not registered at all — see `the_till_is_not_served_unless_the_relay_is_told_to`,
/// which is the reason the flag exists.
fn till_state() -> (AppState, Arc<FakeIc>) {
    let fake = FakeIc::from_catalog();
    let state = AppState::new(Arc::new(FakeLedger::new()))
        .with_fake_ic(fake.clone())
        .with_till(true);
    (state, fake)
}

/// A nonce no other request in this suite has used. A merchant's signature is single-use, so a
/// shared fixture nonce would make every second ring-up in a test a replay — a failure that would
/// look like a bug in the till rather than in the test.
fn fresh_nonce() -> [u8; NONCE_LEN] {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut nonce = [0u8; NONCE_LEN];
    nonce[..8].copy_from_slice(&n.to_le_bytes());
    nonce
}

/// A merchant's SIGNED till request as the wire carries it. The ONE builder for both merchant
/// routes and for every forgery below, so a test that means to send a bad SIGNATURE cannot
/// accidentally send a bad-shaped body and pass for the wrong reason.
fn till_body(
    key: &SigningKey,
    cents: u64,
    name: &str,
    nonce: [u8; NONCE_LEN],
    issued_at: u64,
) -> Value {
    let open = TillOpen {
        merchant_pubkey: key.verifying_key().to_bytes(),
        cents,
        nonce,
        issued_at,
        merchant_name: name.to_string(),
    };
    serde_json::json!({
        "merchant_pubkey": hex::encode(open.merchant_pubkey),
        "merchant_name": name,
        "cents": cents,
        "nonce": hex::encode(nonce),
        "issued_at": issued_at,
        "signature": hex::encode(sign_till_open(key, &open).to_bytes()),
    })
}

/// A POST to one of the two merchant routes carrying `body`. `host`/`proto` are the pair every
/// absolute URL in the answers is built from — the `Host` a wallet's request carries and the
/// `X-Forwarded-Proto` the tunnel in front of prod sets — so a caller can ask for the http origin a
/// local run has or the https one a payer meets.
fn till_post(uri: &str, body: &Value, host: &str, proto: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, host)
        .header("x-forwarded-proto", proto)
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// Ring up a charge, signed by the merchant's own key — the only way in since 2026-09-04.
async fn open_till(
    state: &AppState,
    key: &SigningKey,
    name: &str,
    cents: u64,
    host: &str,
    proto: &str,
) -> Value {
    let body = till_body(key, cents, name, fresh_nonce(), unix_secs());
    let (status, body) = call(state, till_post("/api/v1/till", &body, host, proto)).await;
    assert_eq!(status, StatusCode::OK, "ringing up a charge: {body}");
    body
}

/// VCHF's ledger and fee, as this relay's own compiled catalog states them — the SAME lookup the
/// till makes when it names a destination, so a test can never pay a ledger the provider does not
/// read or guess a fee the gateway would refuse.
async fn vchf_ledger(state: &AppState) -> (String, u64) {
    let (status, body) = call(state, get_req("/api/v1/currencies")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let row = body["networks"]
        .as_array()
        .expect("the catalog is a list of networks")
        .iter()
        .flat_map(|n| n["assets"].as_array().cloned().unwrap_or_default())
        .find(|a| a["currency"] == 7)
        .expect("the served catalog must carry VCHF as currency 7");
    let fee = row["fee"]
        .as_str()
        .expect("the VCHF row states a fee")
        .parse()
        .expect("a decimal fee");
    (
        row["ledger"]
            .as_str()
            .expect("the VCHF row names a ledger")
            .to_string(),
        fee,
    )
}

/// The `ref` this till minted for one charge, read off the RING-UP the merchant signed — the one
/// place this provider states it to the party that OWNS the charge, and 32 lowercase hex either
/// way. The payer learns the same value from the step-3 instruction, and
/// `till_serves_the_standard_and_settles_only_on_a_real_transfer` pins the two spellings against
/// each other; nothing else needs to walk a payer's two routes to recover it.
fn charge_reference(opened: &Value) -> String {
    let reference = opened["reference"]
        .as_str()
        .unwrap_or_else(|| panic!("a ring-up answer must name the charge's reference: {opened}"))
        .to_string();
    assert_eq!(reference.len(), 32, "{opened}");
    assert!(
        reference
            .chars()
            .all(|c| matches!(c, '0'..='9' | 'a'..='f')),
        "{opened}"
    );
    reference
}

/// Pay a charge the way a payer does: a REAL signed `icrc1_transfer` on the VCHF ledger to the
/// merchant's own account, carrying the charge's `ref` as the ICRC-1 memo. Returns the ledger block
/// it landed in — the identity a settlement names, so a caller can assert WHICH transfer credited.
///
/// Deliberately not a faucet credit (which is what these tests used before, and which logs a
/// memo-less mint row): what settles a charge is now the memo, so a fixture that could not carry
/// one would prove the opposite of what these tests are for.
async fn pay_till(
    state: &AppState,
    fake: &Arc<FakeIc>,
    merchant_pk: [u8; 32],
    raw: u64,
    reference: &str,
) -> u64 {
    let (ledger, fee) = vchf_ledger(state).await;
    let payer = keypair();
    let payer_owner = user_principal(&pubkey(&payer));
    let before = fake.balance_for(Currency::from(7u32), &user_principal(&merchant_pk));
    fake.faucet_credit(
        Currency::from(7u32),
        &payer_owner,
        u128::from(raw) + u128::from(fee),
    );
    let arg = transfer_arg(
        &Account::new(user_principal(&merchant_pk)),
        None,
        u128::from(raw),
        Some(u128::from(fee)),
        Some(hex::decode(reference).expect("a reference is hex")),
        None,
    );
    let req = CallRequest {
        canister: Principal::from_text(&ledger).expect("the VCHF ledger principal parses"),
        method_name: "icrc1_transfer".to_string(),
        arg,
        ingress_expiry_ns: ingress_expiry(now_ns(), 300),
        nonce: None,
    };
    let (status, _headers, body) = call_raw(
        state,
        Request::builder()
            .method("POST")
            .uri(format!("/api/v2/canister/{ledger}/call"))
            .body(Body::from(sign_update(&payer, &req)))
            .unwrap(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "the payer's signed transfer must be taken by the gateway: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(
        fake.balance_for(Currency::from(7u32), &user_principal(&merchant_pk)),
        before + raw,
        "the money really moved to the merchant before any charge is polled"
    );
    // The block this landed in, read back through the relay's own exact-memo history filter — the
    // same reconciliation the Receive tab uses, so the identity a caller asserts on is the one the
    // ledger states rather than one this helper counted.
    let merchant_hex = hex::encode(merchant_pk);
    let (status, rows) = call(
        state,
        get_req(&format!(
            "/api/v1/transactions/{merchant_hex}?currency=7&memo={reference}"
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rows}");
    let row = rows["transactions"]
        .as_array()
        .and_then(|r| r.first())
        .unwrap_or_else(|| panic!("the transfer carrying {reference} must be in history: {rows}"));
    row["block"]
        .as_u64()
        .unwrap_or_else(|| panic!("a history row names its block: {row}"))
}

/// A GET carrying the same origin pair, for the one provider route that builds absolute URLs.
fn till_get(uri: &str, host: &str, proto: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header(header::HOST, host)
        .header("x-forwarded-proto", proto)
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn till_serves_the_standard_and_settles_only_on_a_real_transfer() {
    let (state, fake) = till_state();

    // The merchant is a dpay wallet: their account is DERIVED from their key, so they cannot name
    // one they could not sign for, and this relay never holds it.
    let merchant = SigningKey::from_bytes(&[9u8; 32]);
    let merchant_pk: [u8; 32] = merchant.verifying_key().to_bytes();
    let merchant_account = Principal::self_authenticating_ed25519(&merchant_pk).to_text();

    let opened = open_till(
        &state,
        &merchant,
        "Test Shop",
        1_000,
        "till.example",
        "http",
    )
    .await;
    let id = opened["id"].as_str().unwrap().to_string();
    assert!(
        id.starts_with("pl_"),
        "the link id is the standard's shape: {id}"
    );
    // CHF 10 is ten francs of a franc-denominated token. No rate anywhere.
    assert_eq!(opened["amount"], "10.");
    assert_eq!(opened["asset"], "VCHF");
    assert_eq!(opened["merchant"], merchant_account);
    assert_eq!(opened["url"], format!("http://till.example/v1/lnurlp/{id}"));
    // THE CHARGE'S NAME ON THE LEDGER, served to the merchant who signed for it. Without it the
    // only party that could learn a charge's reference was a payer walking the OpenCryptoPay
    // routes, so a merchant collecting the money any other way had nothing to put in the memo.
    let served_reference = charge_reference(&opened);

    // --- step 2: the payment details, at the standard's own path ---------------------------------
    let (status, details) = call(&state, get_req(&format!("/v1/lnurlp/{id}?timeout=0"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(details["tag"], "payRequest");
    assert_eq!(details["displayName"], "Test Shop");
    assert_eq!(details["standard"], "OpenCryptoPay");
    // The callback MUST carry `/cb/`: a wallet derives the submission URL by swapping it for
    // `/tx/`, so this segment is protocol, not decoration.
    let callback = details["callback"].as_str().unwrap().to_string();
    assert!(
        callback.contains("/cb/"),
        "the callback must be swappable to /tx/: {callback}"
    );
    // The asymmetry the measured provider has and every parser must handle: the fiat ask is a JSON
    // NUMBER while the per-asset amount is a decimal STRING, trailing bare point and all.
    assert_eq!(details["requestedAmount"]["asset"], "CHF");
    assert_eq!(details["requestedAmount"]["amount"], 10.0);
    let offers = &details["transferAmounts"][0];
    assert_eq!(offers["method"], "InternetComputer");
    assert_eq!(offers["available"], true);
    assert_eq!(offers["assets"][0]["asset"], "VCHF");
    assert_eq!(offers["assets"][0]["amount"], "10.");
    let quote = details["quote"]["id"].as_str().unwrap().to_string();
    // One accepted expiry spelling — ISO-8601 UTC with the Z. A local-time spelling would be read
    // as device-local by a lenient wallet: up to 14 hours of skew on a 300-second quote.
    let expiry = details["quote"]["expiration"].as_str().unwrap();
    assert!(
        expiry.ends_with('Z') && expiry.contains('T'),
        "expiry spelling: {expiry}"
    );

    // --- step 3: where to send it ----------------------------------------------------------------
    let cb = format!("/v1/lnurlp/cb/{id}?quote={quote}&method=InternetComputer&asset=VCHF");
    let (status, transfer) = call(&state, get_req(&cb)).await;
    assert_eq!(status, StatusCode::OK);
    // The echo is the only integrity signal the answer carries, because the URI names no asset.
    assert_eq!(transfer["blockchain"], "InternetComputer");
    let uri = transfer["uri"].as_str().unwrap();
    // The LIVE URI shape, naming the ledger EXPLICITLY — which is exactly what the measured
    // provider fails to honour on its own verification side.
    assert!(uri.starts_with("icp:"), "{uri}");
    assert!(
        uri.contains(&format!("/transfer?to={merchant_account}&amount=10.")),
        "{uri}"
    );
    // …and this charge's own reference, which is what the payer echoes as the transfer's memo and
    // what the till matches on. 32 hex characters — the 16-byte width dpay's reconciliation memo
    // has everywhere else — and different from the charge's id, which is a read token and not a
    // claim on a ledger row.
    let reference = uri
        .rsplit_once("&ref=")
        .unwrap_or_else(|| panic!("{uri}"))
        .1
        .to_string();
    assert_eq!(reference.len(), 32, "{uri}");
    assert!(
        reference
            .chars()
            .all(|c| matches!(c, '0'..='9' | 'a'..='f')),
        "{uri}"
    );
    assert!(
        !id.contains(&reference),
        "the reference is not the charge id in another spelling"
    );
    // ONE reference per charge, whichever side of the counter asks for it. Two spellings would mean
    // the merchant's own payment and the customer's could not both be credited to the same sale.
    assert_eq!(
        reference, served_reference,
        "the reference the merchant was served must be the one the payer is instructed to carry"
    );

    // A pair this till does not serve is refused rather than quoted — quoting it would mean
    // holding an exchange rate, which v1 deliberately does not.
    let (status, body) = call(
        &state,
        get_req(&format!(
            "/v1/lnurlp/cb/{id}?quote={quote}&method=InternetComputer&asset=ICP"
        )),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["message"], "Invalid method or asset");

    // --- step 4: reporting, BEFORE the money exists ----------------------------------------------
    // The payer claims to have paid and has not. A provider that trusted the report would credit a
    // sale for nothing; this one reads the ledger and answers an honest, retryable PENDING.
    let tx =
        format!("/v1/lnurlp/tx/{id}?quote={quote}&method=InternetComputer&asset=VCHF&tx=999999");
    let (status, body) = call(&state, get_req(&tx)).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "a lying payer must not credit a sale: {body}"
    );
    assert_eq!(body["status"], "PENDING");
    let (_, status_body) = call(&state, get_req(&format!("/api/v1/till/{id}"))).await;
    assert!(
        status_body["paid"].is_null(),
        "nothing may be credited before a transfer exists"
    );
    // …and this route is UNAUTHENTICATED, so it says only what an id-holder may hear. The reference
    // reaches the merchant on the ring-up they SIGNED and is not repeated here — least authority,
    // the reasoning in full at `ChargeStatus`.
    assert!(
        status_body["reference"].is_null(),
        "the unauthenticated poll must not restate the charge's reference: {status_body}"
    );

    // --- the money actually arrives --------------------------------------------------------------
    // A real signed transfer to the merchant's principal on the VCHF ledger, carrying the step-3
    // `ref` as its memo — the exact thing a payer is instructed to send.
    let paying_block = pay_till(&state, &fake, merchant_pk, 1_000_000_000, &reference).await;

    // A same-amount transfer to the same merchant carrying somebody ELSE's reference is not this
    // sale. Sent second, so it is the NEWER row and the first one a newest-first walk meets:
    // matching on amount alone would take it, and this charge would be credited out of a payment
    // made for something else.
    let stray = pay_till(&state, &fake, merchant_pk, 1_000_000_000, &"9e".repeat(16)).await;
    assert_ne!(stray, paying_block, "two transfers are two ledger rows");

    // Waiting out the observation window, which is a real property and not a test convenience: a
    // charge is walked at most once every couple of seconds however hard it is polled, so a
    // just-arrived transfer is seen by the NEXT walk rather than instantly. The sleep therefore
    // also pins that the window CLOSES — a cache that never expired would be a till that never
    // sees the money.
    tokio::time::sleep(std::time::Duration::from_millis(2_100)).await;

    // The step-3 instruction is re-read after that wait, against the SAME quote. Its deadline must
    // not have moved: it is the quote's own death, not a fresh five minutes minted per call, so a
    // wallet that waited is never told a dead price is still good.
    let (status, transfer_again) = call(&state, get_req(&cb)).await;
    assert_eq!(status, StatusCode::OK, "{transfer_again}");
    assert_eq!(
        transfer_again["expiryDate"], expiry,
        "the transfer instruction dies with its quote, not {QUOTE_TTL_SECS} seconds after whenever \
         it was asked for"
    );

    // The payer reports again. Same call, same parameters — a RETRY, which the measured provider
    // makes fatal and this one makes free.
    let (status, body) = call(&state, get_req(&tx)).await;
    assert_eq!(status, StatusCode::OK, "the retry settles: {body}");
    assert_eq!(body["status"], "OK");
    assert_eq!(body["paid"]["amount_raw"], "1000000000");
    assert_eq!(
        body["paid"]["block"], paying_block,
        "the sale is credited out of the transfer that NAMED it, not the newer look-alike: {body}"
    );

    // …and it is idempotent: reporting a third time answers the same, and never re-credits.
    let (status, again) = call(&state, get_req(&tx)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["paid"], body["paid"]);

    // The merchant's own screen sees it too, re-derived from the ledger rather than from memory —
    // including WHICH ledger row credited them, which is the only thing that makes a settlement
    // checkable against the chain afterwards.
    let (_, merchant_view) = call(&state, get_req(&format!("/api/v1/till/{id}"))).await;
    assert_eq!(merchant_view["paid"]["amount_raw"], "1000000000");
    assert_eq!(merchant_view["amount"], "10.");
    assert_eq!(merchant_view["state"], "paid");
    assert!(
        merchant_view["paid"]["block"].is_u64(),
        "the merchant is told which block paid them: {merchant_view}"
    );

    // A settled charge is not quoted again: doing so invites a second payment for a sale that is
    // already credited, and nothing would ever credit that money.
    let (status, refused) = call(&state, get_req(&format!("/v1/lnurlp/{id}?timeout=0"))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert!(
        refused["message"]
            .as_str()
            .unwrap_or_default()
            .contains("already been paid"),
        "the refusal says what happened and what to do: {refused}"
    );
}

/// ONE TRANSFER, ONE SALE — the money bug, over the real HTTP surface.
///
/// Two charges for the same price at the same till and exactly one payment. Matching on amount
/// alone, both read as paid off that single transfer and the shop handed over the goods twice.
/// Now the payment NAMES the charge it is for, so the second one is not merely left open by the
/// order the two happened to be polled in — that transfer could never have credited it.
#[tokio::test]
async fn one_transfer_credits_exactly_one_sale() {
    let (state, fake) = till_state();
    let merchant = SigningKey::from_bytes(&[21u8; 32]);
    let merchant_pk: [u8; 32] = merchant.verifying_key().to_bytes();

    // Ring up CHF 4.50 and let a customer read its instruction, then ring up CHF 4.50 again — the
    // customer fumbled, the cashier re-rang. Reading the first charge's step 3 BEFORE the re-ring
    // is the sequence a real payer lives: a superseded charge is no longer quoted, which is exactly
    // why the payer standing there is still holding an instruction the till must honour.
    let first = open_till(&state, &merchant, "Test Shop", 450, "till.example", "http").await;
    let first_id = first["id"].as_str().unwrap().to_string();
    let first_ref = charge_reference(&first);
    let second = open_till(&state, &merchant, "Test Shop", 450, "till.example", "http").await;
    let second_id = second["id"].as_str().unwrap().to_string();
    let second_ref = charge_reference(&second);
    let (first_id, second_id) = (first_id.as_str(), second_id.as_str());
    assert_ne!(first_id, second_id, "two ring-ups are two charges, not one");
    // The two charges are handed DIFFERENT references, which is the whole mechanism: each customer
    // is told what to write on their payment, so the shop can tell two identical prices apart.
    assert_ne!(
        first_ref, second_ref,
        "each charge names itself, or none of this works"
    );

    // ONE payment of exactly CHF 4.50 lands at the merchant, carrying the FIRST charge's reference
    // — the code the customer was actually holding when they paid.
    pay_till(&state, &fake, merchant_pk, 450_000_000, &first_ref).await;

    let status_of = |id: &str| format!("/api/v1/till/{id}");
    let (_, a) = call(&state, get_req(&status_of(first_id))).await;
    let (_, b) = call(&state, get_req(&status_of(second_id))).await;
    let paid: Vec<&Value> = [&a, &b]
        .into_iter()
        .filter(|v| !v["paid"].is_null())
        .collect();
    assert_eq!(
        paid.len(),
        1,
        "one transfer may credit exactly one sale — first={a}, second={b}"
    );
    assert_eq!(paid[0]["paid"]["amount_raw"], "450000000");

    // Which one takes it is not the order they were polled in: the transfer named the first charge,
    // so the second is left honestly open however hard it is asked. A VOIDED charge is still
    // observed — that is deliberate, and it is why a payer holding the old code a heartbeat before
    // the cashier re-rang does not lose their money.
    assert_eq!(a["state"], "paid");
    assert_eq!(b["paid"], Value::Null);
    assert_eq!(b["state"], "open");

    // Polling again does not change any of that: a row that paid is spent, not re-offered.
    let (_, a2) = call(&state, get_req(&status_of(first_id))).await;
    let (_, b2) = call(&state, get_req(&status_of(second_id))).await;
    assert_eq!(
        (a2["paid"].clone(), b2["paid"].clone()),
        (a["paid"].clone(), b["paid"].clone())
    );

    // Nobody new may be sent to pay a settled charge, and the refusal names the next move.
    let (status, refused) =
        call(&state, get_req(&format!("/v1/lnurlp/{first_id}?timeout=0"))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert!(
        refused["message"]
            .as_str()
            .unwrap_or_default()
            .contains("already been paid"),
        "{refused}"
    );

    // …and a code the cashier has rung past is a DIFFERENT kind of dead, told apart out loud: the
    // third ring-up voids the second, which was never paid.
    let third = open_till(&state, &merchant, "Test Shop", 450, "till.example", "http").await;
    assert_ne!(third["id"], second["id"]);
    let (status, replaced) = call(
        &state,
        get_req(&format!("/v1/lnurlp/{second_id}?timeout=0")),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{replaced}");
    assert!(
        replaced["message"]
            .as_str()
            .unwrap_or_default()
            .contains("ask the cashier"),
        "a superseded code sends the payer to the counter for the current one: {replaced}"
    );
    let (_, second_view) = call(&state, get_req(&status_of(second_id))).await;
    assert_eq!(second_view["state"], "superseded");
}

/// A merchant's name is a STRANGER'S STRING pasted into a JSON document that lives inside a JSON
/// string. Built with `format!` (what this used to do), a name of `X"],["image/png;base64,…`
/// closed the entry and opened a second one — a syntactically valid LUD-06 document with an
/// injected image entry that wallets parse and render. Proven against this till on prod.
#[tokio::test]
async fn a_merchant_name_cannot_forge_a_second_metadata_entry() {
    let (state, _fake) = till_state();
    let merchant = SigningKey::from_bytes(&[23u8; 32]);
    // Short enough to fit the name cap, so what is being tested is the ESCAPING and not the clamp.
    let attack = r#"X"],["a"#;
    let opened = open_till(&state, &merchant, attack, 100, "till.example", "http").await;
    let id = opened["id"].as_str().unwrap();
    let (status, details) = call(&state, get_req(&format!("/v1/lnurlp/{id}?timeout=0"))).await;
    assert_eq!(status, StatusCode::OK, "{details}");

    let metadata = details["metadata"]
        .as_str()
        .expect("metadata is a JSON string");
    let parsed: Value = serde_json::from_str(metadata).expect("metadata is a JSON document");
    let entries = parsed
        .as_array()
        .expect("LUD-06 metadata is an array of entries");
    assert_eq!(
        entries.len(),
        1,
        "one entry, whatever the name tried to open: {metadata}"
    );
    assert_eq!(entries[0][0], "text/plain");
    assert_eq!(
        entries[0][1],
        format!("{attack} - CHF 1"),
        "the name survives INSIDE the entry, escaped — the till does not censor it, it contains it"
    );
    // And the human text is a human's spelling: `CHF 1`, never the wire's bare `CHF 1.`.
    assert!(
        !metadata.contains("CHF 1."),
        "the wire's trailing point must not leak into a receipt"
    );
}

#[tokio::test]
async fn till_refuses_what_it_cannot_serve_in_the_measured_provider_s_own_words() {
    let (state, _fake) = till_state();

    // An unknown link is the error envelope, not the payment-link payload — the two DIFFERENT 404s
    // a wallet must tell apart (one means "ask the cashier", this one means "this code is stale").
    let (status, body) = call(&state, get_req("/v1/lnurlp/pl_nope?timeout=0")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["message"], "Payment link not found");
    assert_eq!(body["statusCode"], 404);

    // A quote we never issued cannot buy a destination.
    let merchant = SigningKey::from_bytes(&[11u8; 32]);
    let opened = open_till(&state, &merchant, "Test Shop", 250, "till.example", "http").await;
    let id = opened["id"].as_str().unwrap();
    let (status, body) = call(
        &state,
        get_req(&format!(
            "/v1/lnurlp/cb/{id}?quote=plq_invented&method=InternetComputer&asset=VCHF"
        )),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["message"], "No actual quote with ID found");

    // A charge of nothing is not a charge — and the refusal names where a signed `cents = 0` DOES
    // belong, because that spelling is not a mistake anywhere: it is how the till is cleared.
    let nothing = till_body(&merchant, 0, "Test Shop", fresh_nonce(), unix_secs());
    let (status, body) = call(
        &state,
        till_post("/api/v1/till", &nothing, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("/api/v1/till/void"),
        "a charge of nothing points the cashier at the route that clears the till: {body}"
    );

    // CHF 2.50 keeps its cents on the wire.
    assert_eq!(opened["amount"], "2.5");
}

/// A ring-up is refused unless the caller can SIGN for the account the money would go to — and a
/// refused one changes nothing.
///
/// The hole this closes was live in production: `POST /api/v1/till` took any 32 bytes of hex as the
/// destination key, so a stranger could open a charge naming any merchant they liked and this relay
/// would serve a full payment page for it on dpay's own domain, under dpay's own certificate. The
/// second half — that a refusal leaves the merchant's real charge alone — is the other hole in the
/// same route: ringing up VOIDS that merchant's previous charge, so an anonymous caller who could
/// ring up could keep a cashier re-ringing all day.
///
/// The four refusals are told apart on the wire because they send a merchant to do four different
/// things: re-sync the clock, fix the key, sign again, or stop signing and go poll the charge that
/// already exists.
#[tokio::test]
async fn a_ring_up_is_refused_unless_the_merchant_signs_it() {
    let (state, _fake) = till_state();
    let merchant = SigningKey::from_bytes(&[31u8; 32]);
    let attacker = SigningKey::from_bytes(&[32u8; 32]);
    let now = unix_secs();

    // The merchant's own, honest ring-up: a live charge for the forgeries below to fail to disturb.
    let mine = open_till(
        &state,
        &merchant,
        "Bahnhof Kiosk",
        450,
        "till.example",
        "http",
    )
    .await;
    let id = mine["id"]
        .as_str()
        .expect("a rung-up charge carries an id")
        .to_string();

    // A body with no proof in it at all — the shape an integrator sends first. The refusal names
    // both the diagnosis and the shape a request must have, because "what do I send instead" is the
    // question a 400 has to answer.
    let bare = serde_json::json!({
        "merchant_pubkey": hex::encode(merchant.verifying_key().to_bytes()),
        "merchant_name": "Bahnhof Kiosk",
        "cents": 450,
    });
    let (status, body) = call(
        &state,
        till_post("/api/v1/till", &bare, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let message = body["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("nonce"),
        "the refusal names the field it choked on: {body}"
    );
    assert!(
        message.contains("signature"),
        "…and the shape a request must carry: {body}"
    );

    // Someone else's signature over the merchant's own key: the exact impersonation the signature
    // exists to refuse, and the one a stranger with the merchant's public key can attempt.
    let mut forged = till_body(&attacker, 450, "Bahnhof Kiosk", fresh_nonce(), now);
    forged["merchant_pubkey"] = Value::String(hex::encode(merchant.verifying_key().to_bytes()));
    let (status, body) = call(
        &state,
        till_post("/api/v1/till", &forged, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("does not verify"),
        "{body}"
    );

    // `deadbeef…deadbeef` — the key the 2026-09-03 production probe rang up with. It is not a point
    // on the curve, so it is told apart from a wrong signature: nobody can hold it, and no account
    // derives from it. A merchant who pasted a placeholder must hear about their KEY.
    let mut placeholder = till_body(&merchant, 450, "Bahnhof Kiosk", fresh_nonce(), now);
    placeholder["merchant_pubkey"] = Value::String("deadbeef".repeat(8));
    let (status, body) = call(
        &state,
        till_post("/api/v1/till", &placeholder, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("not an Ed25519 public key"),
        "a placeholder key is diagnosed as a key, not as a bad signature: {body}"
    );

    // A hex field of the wrong width is named, with both the byte count the wire means and the
    // character count the caller typed — "32-byte hex" reads wrong to someone holding 128 chars.
    let mut short = till_body(&merchant, 450, "Bahnhof Kiosk", fresh_nonce(), now);
    short["signature"] = Value::String("ab".repeat(63));
    let (status, body) = call(
        &state,
        till_post("/api/v1/till", &short, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("signature must be 64 bytes"),
        "{body}"
    );

    // A capture replayed a day later. The clock refuses it, and says by how much and against what —
    // the merchant cannot see this relay's clock, and the gap is the whole diagnosis.
    let stale = till_body(&merchant, 450, "Bahnhof Kiosk", fresh_nonce(), now - 86_400);
    let (status, body) = call(
        &state,
        till_post("/api/v1/till", &stale, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("issued_at is 86400 s"),
        "{body}"
    );

    // NONE of that touched the merchant's live charge. Before the signature, every one of those
    // requests would have opened a charge — and voided this one on the way past, forcing the
    // cashier to ring up again.
    let (_, still) = call(&state, get_req(&format!("/api/v1/till/{id}"))).await;
    assert_eq!(
        still["state"], "open",
        "a refused ring-up must not disturb a real one: {still}"
    );
    let (status, details) = call(&state, get_req(&format!("/v1/lnurlp/{id}?timeout=0"))).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "…and it is still payable: {details}"
    );

    // A signature is good exactly ONCE. The replay is refused as a duplicate rather than as a
    // forgery, and the answer sends the merchant to the charge it already opened instead of to
    // sign again — signing again with the same nonce would only land here a third time.
    let honest = till_body(&merchant, 900, "Bahnhof Kiosk", fresh_nonce(), now);
    let (status, first) = call(
        &state,
        till_post("/api/v1/till", &honest, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, replay) = call(
        &state,
        till_post("/api/v1/till", &honest, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{replay}");
    assert!(
        replay["message"]
            .as_str()
            .unwrap_or_default()
            .contains("GET /api/v1/till/{id}"),
        "a replay is pointed at the charge it already opened: {replay}"
    );
}

/// The mis-keyed total, over the real HTTP surface: CHF 100.00 rung up for a CHF 1.00 coffee.
///
/// Until this route existed the cashier had no way to kill the code — it stayed payable for an
/// hour, and the only escape was to ring up something else and leave THAT payable in front of the
/// customer instead.
#[tokio::test]
async fn a_cashier_can_cancel_a_mis_keyed_total() {
    let (state, fake) = till_state();
    let merchant = SigningKey::from_bytes(&[41u8; 32]);
    let merchant_pk: [u8; 32] = merchant.verifying_key().to_bytes();
    let now = unix_secs();

    let oops = open_till(
        &state,
        &merchant,
        "Bahnhof Kiosk",
        10_000,
        "till.example",
        "http",
    )
    .await;
    let id = oops["id"]
        .as_str()
        .expect("a rung-up charge carries an id")
        .to_string();

    // A ring-up signature aimed at the cancel route is refused before anything else happens: the
    // two actions are told apart by the SIGNED `cents`, which is what stops one being replayed as
    // the other. (The reverse is pinned by the `cents = 0` case in the refusals test.)
    let ring_up = till_body(&merchant, 10_000, "Bahnhof Kiosk", fresh_nonce(), now);
    let (status, body) = call(
        &state,
        till_post("/api/v1/till/void", &ring_up, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("cents = 0"),
        "{body}"
    );

    // The cancellation itself, signed by the same key as the ring-up.
    let clear = till_body(&merchant, 0, "Bahnhof Kiosk", fresh_nonce(), now);
    let (status, cleared) = call(
        &state,
        till_post("/api/v1/till/void", &clear, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(
        cleared["id"],
        id.as_str(),
        "the answer names the charge it cleared"
    );
    assert_eq!(cleared["state"], "cancelled");

    // What the payer standing at the counter is told. NOT the superseded message: that one says
    // "ask for the current code", which would send them to pay for something the cashier just
    // cancelled. This one says nothing is owed.
    let (status, refused) = call(&state, get_req(&format!("/v1/lnurlp/{id}?timeout=0"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{refused}");
    let message = refused["message"].as_str().unwrap_or_default();
    assert!(message.contains("cancelled"), "{refused}");
    assert!(message.contains("do not send anything"), "{refused}");

    // Cancelling an already-cleared till succeeds — a cashier pressing the button twice has not
    // failed at anything, and inventing an error for it would be noise at the counter. A FRESH
    // nonce, because a signature is single-use whatever it authorises.
    let again = till_body(&merchant, 0, "Bahnhof Kiosk", fresh_nonce(), now);
    let (status, twice) = call(
        &state,
        till_post("/api/v1/till/void", &again, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{twice}");
    assert_eq!(twice["state"], "cancelled");

    // A stranger cannot clear somebody else's till — the same proof gates both merchant routes.
    let stranger = SigningKey::from_bytes(&[42u8; 32]);
    let mut forged = till_body(&stranger, 0, "Bahnhof Kiosk", fresh_nonce(), now);
    forged["merchant_pubkey"] = Value::String(hex::encode(merchant_pk));
    let (status, body) = call(
        &state,
        till_post("/api/v1/till/void", &forged, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");

    // A till with nothing rung up on it has nothing to clear, and is told what to do instead of
    // being handed a success that describes no charge.
    let idle = SigningKey::from_bytes(&[43u8; 32]);
    let nothing = till_body(&idle, 0, "Kiosk", fresh_nonce(), now);
    let (status, body) = call(
        &state,
        till_post("/api/v1/till/void", &nothing, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("POST /api/v1/till"),
        "an idle till is pointed at the route that rings one up: {body}"
    );

    // A CREDITED charge is not cancellable, and the refusal names the block that paid. Telling a
    // merchant "cancelled" here would have them hand over goods they have already been paid for.
    let paid = open_till(
        &state,
        &merchant,
        "Bahnhof Kiosk",
        100,
        "till.example",
        "http",
    )
    .await;
    let paid_id = paid["id"]
        .as_str()
        .expect("a rung-up charge carries an id")
        .to_string();
    let paid_ref = charge_reference(&paid);
    pay_till(&state, &fake, merchant_pk, 100_000_000, &paid_ref).await;
    let (_, settled) = call(&state, get_req(&format!("/api/v1/till/{paid_id}"))).await;
    assert_eq!(settled["state"], "paid", "{settled}");
    let too_late = till_body(&merchant, 0, "Bahnhof Kiosk", fresh_nonce(), unix_secs());
    let (status, body) = call(
        &state,
        till_post("/api/v1/till/void", &too_late, "till.example", "http"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let message = body["message"].as_str().unwrap_or_default();
    assert!(message.contains("already paid"), "{body}");
    assert!(
        message.contains(&settled["paid"]["block"].to_string()),
        "the merchant is told WHICH block paid them, so they can check it on the ledger: {body}"
    );
    let (_, unchanged) = call(&state, get_req(&format!("/api/v1/till/{paid_id}"))).await;
    assert_eq!(
        unchanged["state"], "paid",
        "a credited sale is not cancelled away: {unchanged}"
    );
}

/// The till is served ONLY by a relay that was told to serve it, and "not served" means the eight
/// routes do not exist — the gate is at registration, so no till handler is reachable at all.
///
/// The two halves ride the SAME eight requests: a relay with the till on answers every one of them
/// (which is what makes the requests well-formed, the charge live and the quote real), and a
/// till-less relay — plain `AppState::new`, the shape an explicit `DPAY_ENABLE_TILL=false` builds
/// (`main` calls `with_till`; since the 2026-09-10 founder decision an UNSET env builds a
/// till-serving relay, so this is the opt-out's shape, not the default's) — refuses all eight.
/// The refusal is pinned as a BARE 404: an empty body is axum's own answer for a
/// path it has no route for, whereas every 404 this till can produce carries the provider's
/// `{statusCode, message, error}` envelope (the test above pins that). The empty body is therefore
/// the proof that no handler ran, rather than a handler politely declining.
#[tokio::test]
async fn the_till_is_not_served_unless_the_relay_is_told_to() {
    let merchant = SigningKey::from_bytes(&[13u8; 32]);

    // A serving relay, used to mint the exact URLs a wallet and a merchant screen would call.
    let (serving, _fake) = till_state();
    let opened = open_till(
        &serving,
        &merchant,
        "Test Shop",
        500,
        "till.example",
        "http",
    )
    .await;
    let id = opened["id"]
        .as_str()
        .expect("a rung-up charge carries an id")
        .to_string();
    let (status, details) = call(
        &serving,
        till_get(
            &format!("/v1/lnurlp/{id}?timeout=0"),
            "till.example",
            "http",
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "minting a quote to call the callback with: {details}"
    );
    let quote = details["quote"]["id"]
        .as_str()
        .expect("a quote carries an id")
        .to_string();

    // The whole till surface, as its callers reach it: the merchant's ring-up, cancel and poll,
    // the standard's three payer steps, the page a generic camera lands on, and the cashier's own
    // watch page. Rebuilt per call because a `Request` is consumed by the router, and each rebuild
    // signs afresh because a merchant's signature is single-use.
    //
    // The two POSTs name a DIFFERENT merchant than the charge the other six requests are about,
    // because ringing one up voids that merchant's previous charge — the other six would then be
    // asking about a superseded code and meet a handler's honest 404 instead of its answer, which
    // is not what this test is measuring. They also run in this order on the serving relay: the
    // cancel has a charge to clear because the ring-up above it just made one.
    let cashier = SigningKey::from_bytes(&[17u8; 32]);
    let surface = || {
        vec![
            (
                "POST /api/v1/till".to_string(),
                till_post(
                    "/api/v1/till",
                    &till_body(&cashier, 500, "Test Shop", fresh_nonce(), unix_secs()),
                    "till.example",
                    "http",
                ),
            ),
            (
                "POST /api/v1/till/void".to_string(),
                till_post(
                    "/api/v1/till/void",
                    &till_body(&cashier, 0, "Test Shop", fresh_nonce(), unix_secs()),
                    "till.example",
                    "http",
                ),
            ),
            (
                format!("GET /api/v1/till/{id}"),
                get_req(&format!("/api/v1/till/{id}")),
            ),
            (
                format!("GET /v1/lnurlp/{id}"),
                till_get(
                    &format!("/v1/lnurlp/{id}?timeout=0"),
                    "till.example",
                    "http",
                ),
            ),
            (
                format!("GET /v1/lnurlp/cb/{id}"),
                get_req(&format!(
                    "/v1/lnurlp/cb/{id}?quote={quote}&method=InternetComputer&asset=VCHF"
                )),
            ),
            (
                format!("GET /v1/lnurlp/tx/{id}"),
                get_req(&format!(
                    "/v1/lnurlp/tx/{id}?quote={quote}&method=InternetComputer&asset=VCHF&tx=9f1c"
                )),
            ),
            ("GET /pl/".to_string(), get_req("/pl/?lightning=LNURL1TEST")),
            (format!("GET /till/{id}"), get_req(&format!("/till/{id}"))),
        ]
    };

    // Served: each of the eight reaches its handler. WHAT each answers is pinned by the journey and
    // golden tests; all that matters here is that these exact requests are not 404s by construction.
    for (what, req) in surface() {
        let (status, _headers, body) = call_raw(&serving, req).await;
        assert_ne!(
            status,
            StatusCode::NOT_FOUND,
            "{what} must be served when the till is on"
        );
        assert!(
            !body.is_empty(),
            "{what}: a till handler always answers with a body"
        );
    }

    // Not served: the same eight against a relay that never asked for the till.
    let unserved = AppState::new(Arc::new(FakeLedger::new())).with_fake_ic(FakeIc::from_catalog());
    for (what, req) in surface() {
        let (status, _headers, body) = call_raw(&unserved, req).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "{what} must not exist unless the till is turned on"
        );
        assert!(
            body.is_empty(),
            "{what}: a BARE 404 is the router refusing — a body would mean a till handler ran"
        );
    }
}

/// `GET /till/{id}` — the cashier's watch page (the plan's "web page later", 2026-09-03). 200 +
/// HTML + `no-store` under the gate, and INDIFFERENT to the id's shape: the handler never looks
/// the charge up, because the page renders client-side from the poll — an unknown or even
/// nonsense id still gets the page, and its first fetch gets the poll's honest answer.
#[tokio::test]
async fn the_cashier_page_serves_under_the_gate_for_any_id() {
    let (serving, _fake) = till_state();

    for uri in ["/till/pl_0011223344556677", "/till/not-a-charge-id-at-all"] {
        let (status, headers, body) = call_raw(&serving, get_req(uri)).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
        let html = String::from_utf8(body).expect("the cashier page is utf-8");
        assert!(
            html.contains("settles in VCHF"),
            "names the settlement asset: {uri}"
        );
        assert!(
            html.contains("/api/v1/till/"),
            "polls the charge by id client-side: {uri}"
        );
    }
}

/// The cashier page is STATIC — the server interpolates NOTHING, not even the claimed merchant
/// name of a charge that exists on this very relay. That is the fence the page's design leans
/// on: untrusted CLAIMED text is written by the browser via textContent (never markup), so no
/// Rust string-building on this route ever handles it.
#[tokio::test]
async fn the_cashier_page_interpolates_nothing_serverside() {
    let (serving, _fake) = till_state();
    let merchant = SigningKey::from_bytes(&[19u8; 32]);
    let opened = open_till(
        &serving,
        &merchant,
        "Zuerich Shop 88",
        500,
        "till.example",
        "http",
    )
    .await;
    let id = opened["id"]
        .as_str()
        .expect("a rung-up charge carries an id")
        .to_string();

    let (status, _headers, body) = call_raw(&serving, get_req(&format!("/till/{id}"))).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(body).expect("the cashier page is utf-8");
    assert!(
        !html.contains("Zuerich Shop 88"),
        "the claimed merchant name must arrive via the JSON poll, never baked into the page"
    );
}

// --- the provider half of the wire golden --------------------------------------------------------
// What the golden is, why it exists and how each half reads it: `dfx/till_wire.json` (`_doc`).

/// The golden. `include_str!` fails the BUILD when it is missing — the loudest failure available.
const TILL_WIRE: &str = include_str!("../../../dfx/till_wire.json");

/// A value the provider mints fresh on every call, checked against the shape its pinned counterpart
/// STATES — same prefix through the `_`, same length, lowercase-hex tail — before the golden's own
/// is substituted for it below. A normalisation that asked nothing of what it replaced would pin
/// nothing at all: `pl_` could become any string on earth and still compare equal.
fn assert_minted_like(observed: &str, golden: &str, what: &str) {
    fn split<'a>(s: &'a str, what: &str, side: &str) -> (&'a str, &'a str) {
        match s.split_once('_') {
            Some(parts) => parts,
            None => panic!("{what}: the {side} id must be `<prefix>_<hex>`, got {s}"),
        }
    }
    let (observed_prefix, observed_tail) = split(observed, what, "observed");
    let (golden_prefix, golden_tail) = split(golden, what, "golden");
    assert_eq!(observed_prefix, golden_prefix, "{what}: prefix");
    assert_eq!(
        observed_tail.len(),
        golden_tail.len(),
        "{what}: length ({observed})"
    );
    assert!(
        observed_tail
            .chars()
            .all(|c| matches!(c, '0'..='9' | 'a'..='f')),
        "{what}: the tail must be lowercase hex, got {observed}"
    );
}

/// A deadline the provider states, checked against its own derivation rather than merely its shape:
/// it must be `iso8601_utc(t + QUOTE_TTL_SECS)` for one of the seconds `t` the request could have
/// been served in. That pins the VALUE without putting a clock seam in the provider. The golden's
/// own instant is held to the same spelling by its length here; the payer's strict reader owns the
/// rest of it (`app/__tests__/tillWire.test.ts`).
fn assert_deadline(observed: &str, golden: &str, from_secs: u64, to_secs: u64, what: &str) {
    let expected: Vec<String> = (from_secs..=to_secs)
        .map(|t| iso8601_utc(t + QUOTE_TTL_SECS))
        .collect();
    assert!(
        expected.iter().any(|e| e == observed),
        "{what}: {observed} must be one of {expected:?}"
    );
    assert_eq!(
        observed.len(),
        golden.len(),
        "{what}: the golden must spell an instant the till spells"
    );
}

/// The observed body with every freshly-minted value replaced by the golden's own, rendered
/// canonically for comparison. Substituted as TEXT because the payment-link id is embedded in the
/// `url` and `callback` strings as well as living in its own field, so a field-by-field swap would
/// leave a second spelling of it behind and the comparison would fail for the wrong reason.
fn pinned(observed: &Value, subs: &[(&str, &str)]) -> String {
    let mut text = observed.to_string();
    for (from, to) in subs {
        text = text.replace(from, to);
    }
    let value: Value =
        serde_json::from_str(&text).expect("substituting an id must leave valid JSON");
    serde_json::to_string_pretty(&value).expect("a JSON value renders")
}

/// The golden's own copy of a body, rendered the same way.
fn golden_body(golden: &Value, key: &str) -> String {
    serde_json::to_string_pretty(&golden[key]).expect("a JSON value renders")
}

#[tokio::test]
async fn till_wire_matches_the_golden_the_payer_parses() {
    let golden: Value =
        serde_json::from_str(TILL_WIRE).expect("dfx/till_wire.json must be valid JSON");
    let field = |path: &[&str]| -> String {
        let mut at = &golden;
        for key in path {
            at = &at[*key];
        }
        at.as_str()
            .unwrap_or_else(|| {
                panic!(
                    "dfx/till_wire.json must carry {} as a string",
                    path.join(".")
                )
            })
            .to_string()
    };
    let hex_field = |path: &[&str], len: usize| -> Vec<u8> {
        let raw =
            hex::decode(field(path)).unwrap_or_else(|e| panic!("{} is hex: {e}", path.join(".")));
        assert_eq!(raw.len(), len, "{} is {len} bytes", path.join("."));
        raw
    };
    let (host, proto) = (
        field(&["input", "host"]),
        field(&["input", "forwarded_proto"]),
    );
    let merchant_name = field(&["input", "merchant_name"]);
    let cents = golden["input"]["cents"]
        .as_u64()
        .expect("input.cents must be a number");
    let merchant = SigningKey::from_bytes(
        &<[u8; 32]>::try_from(hex_field(&["input", "merchant_secret"], 32).as_slice())
            .expect("32 bytes"),
    );
    let pk: [u8; 32] = merchant.verifying_key().to_bytes();
    // The recorded pubkey is DERIVED from the recorded secret, so the two cannot drift into
    // describing different merchants — and the recording only means anything if the key it names is
    // the key that signed it.
    assert_eq!(hex::encode(pk), field(&["input", "merchant_pubkey"]));

    // THE RECORDED RING-UP IS A REAL ONE. `input` is a complete signed request — the worked example
    // a merchant integrating against this till copies — so it is verified here with the same
    // function the route uses, at its own `issued_at`.
    let recorded = TillOpen {
        merchant_pubkey: pk,
        cents,
        nonce: <[u8; NONCE_LEN]>::try_from(hex_field(&["input", "nonce"], NONCE_LEN).as_slice())
            .expect("16 bytes"),
        issued_at: golden["input"]["issued_at"]
            .as_u64()
            .expect("input.issued_at is a number"),
        merchant_name: merchant_name.clone(),
    };
    let recorded_sig =
        <[u8; SIG_LEN]>::try_from(hex_field(&["input", "signature"], SIG_LEN).as_slice())
            .expect("64 bytes");
    assert_eq!(
        validate_till_open(&recorded, &recorded_sig, recorded.issued_at, false),
        Ok(()),
        "dfx/till_wire.json's recorded ring-up must be one this till would accept"
    );
    // It is NOT replayed to drive the routes below, and cannot be: a signature is single-use and
    // good for ±{TILL_OPEN_MAX_SKEW_SECS} seconds, so a committed one is stale by construction the
    // moment it is committed. The bodies are therefore recorded from a FRESH signature by the same
    // key — which is exactly how the file itself was produced.
    assert_eq!(
        validate_till_open(
            &recorded,
            &recorded_sig,
            recorded.issued_at + TILL_OPEN_MAX_SKEW_SECS + 1,
            false
        ),
        Err(dpay_core::TillOpenError::Stale),
    );

    let (state, fake) = till_state();

    // --- what the merchant's own screen gets, and the URL its QR carries --------------------------
    let rung_at = now_ns() / 1_000_000_000;
    let opened = open_till(&state, &merchant, &merchant_name, cents, &host, &proto).await;
    let rung_done = now_ns() / 1_000_000_000;
    let charge_id = opened["id"]
        .as_str()
        .expect("a rung-up charge carries an id")
        .to_string();
    let golden_charge = field(&["open", "id"]);
    assert_minted_like(&charge_id, &golden_charge, "the payment-link id");

    // The LNURL is not a substring of anything above it, so it cannot ride the id substitution: a
    // one-character change to the URL changes the whole bech32. Both sides are therefore checked
    // against the encoder itself — the observed code must encode the observed URL, and the golden's
    // must encode the golden's — which pins the recorded string as the till's own output rather
    // than as a value somebody typed. What the CROSS-LANGUAGE proof is remains the payer's half:
    // `app/__tests__/tillWire.test.ts` decodes this very string with the wallet's own bech32.
    let lnurl = opened["lnurl"]
        .as_str()
        .expect("a ring-up answer carries the bech32 code")
        .to_string();
    assert_eq!(
        lnurl,
        dpay_relay::till::lnurl_of(&field(&["open", "url"]).replace(&golden_charge, &charge_id))
    );
    assert_eq!(
        field(&["open", "lnurl"]),
        dpay_relay::till::lnurl_of(&field(&["open", "url"]))
    );
    // …and the QR string is that code inside the wrapper a generic camera can open, so pinning the
    // code pins the QR with it.
    assert!(
        opened["qr"]
            .as_str()
            .unwrap_or_default()
            .ends_with(&format!("?lightning={lnurl}")),
        "{opened}"
    );

    // The charge's clock: `created_secs` is when this request was served, and `expires_at` is the
    // ONE lifetime rule applied to it — asserted as a derivation, not as a shape, so the golden's
    // pair cannot drift from the store's own deadline.
    let created = opened["created_secs"]
        .as_u64()
        .expect("a ring-up answer states when it was rung up");
    assert!(
        (rung_at..=rung_done).contains(&created),
        "created_secs {created} ∉ [{rung_at}, {rung_done}]"
    );
    assert_eq!(
        opened["expires_at"],
        created + dpay_relay::till::CHARGE_TTL_SECS
    );
    let golden_created = golden["open"]["created_secs"]
        .as_u64()
        .expect("the golden states created_secs");
    assert_eq!(
        golden["open"]["expires_at"],
        golden_created + dpay_relay::till::CHARGE_TTL_SECS
    );

    // The fourth thing this provider mints fresh, and the one the MERCHANT is served: the charge's
    // reference. `charge_reference` holds the observed value to the shape its pinned counterpart
    // states before the golden's own is substituted, exactly as the two ids are — and the golden's
    // two copies of it must agree, so a hand-edit that gave the merchant and the payer different
    // references is caught here rather than at a counter.
    let reference = charge_reference(&opened);
    let golden_uri = field(&["callback", "uri"]);
    let golden_reference = golden_uri
        .rsplit_once("&ref=")
        .unwrap_or_else(|| {
            panic!("dfx/till_wire.json's callback URI must name a ref: {golden_uri}")
        })
        .1;
    assert_eq!(
        field(&["open", "reference"]),
        golden_reference,
        "the golden's ring-up and its step-3 URI must name ONE reference"
    );

    assert_eq!(
        pinned(
            &opened,
            &[
                (charge_id.as_str(), golden_charge.as_str()),
                (lnurl.as_str(), &field(&["open", "lnurl"])),
                (reference.as_str(), golden_reference),
                (
                    &format!("\"created_secs\":{created}"),
                    &format!("\"created_secs\":{golden_created}")
                ),
                (
                    &format!(
                        "\"expires_at\":{}",
                        created + dpay_relay::till::CHARGE_TTL_SECS
                    ),
                    &format!("\"expires_at\":{}", golden["open"]["expires_at"]),
                ),
            ],
        ),
        golden_body(&golden, "open"),
        "the merchant's ring-up answer drifted from dfx/till_wire.json"
    );

    // --- step 2: the payment details a wallet parses ----------------------------------------------
    let details_at = now_ns() / 1_000_000_000;
    let (status, details) = call(
        &state,
        till_get(&format!("/v1/lnurlp/{charge_id}?timeout=0"), &host, &proto),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "step 2: {details}");
    let served_at = now_ns() / 1_000_000_000;
    let quote_id = details["quote"]["id"]
        .as_str()
        .expect("a quote carries an id")
        .to_string();
    let expiration = details["quote"]["expiration"]
        .as_str()
        .expect("a quote carries an expiry")
        .to_string();
    let golden_quote = field(&["details", "quote", "id"]);
    assert_minted_like(&quote_id, &golden_quote, "the quote id");
    assert_deadline(
        &expiration,
        &field(&["details", "quote", "expiration"]),
        details_at,
        served_at,
        "the quote expiry",
    );
    assert_eq!(
        pinned(
            &details,
            &[
                (charge_id.as_str(), golden_charge.as_str()),
                (quote_id.as_str(), golden_quote.as_str()),
                (
                    expiration.as_str(),
                    &field(&["details", "quote", "expiration"])
                ),
            ],
        ),
        golden_body(&golden, "details"),
        "the step-2 body drifted from dfx/till_wire.json"
    );

    // --- step 3: where the money goes -------------------------------------------------------------
    let called_at = now_ns() / 1_000_000_000;
    let (status, transfer) = call(
        &state,
        get_req(&format!(
            "/v1/lnurlp/cb/{charge_id}?quote={quote_id}&method=InternetComputer&asset=VCHF"
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "step 3: {transfer}");
    let answered_at = now_ns() / 1_000_000_000;
    let expiry_date = transfer["expiryDate"]
        .as_str()
        .expect("a transfer instruction carries an expiry")
        .to_string();
    assert_deadline(
        &expiry_date,
        &field(&["callback", "expiryDate"]),
        called_at,
        answered_at,
        "the transfer expiry",
    );
    // The payer is instructed to carry the reference the MERCHANT was already served. One value,
    // two audiences — a second one here would mean a shop's own tap and its customer's scan could
    // not both credit the same sale.
    let uri = transfer["uri"]
        .as_str()
        .expect("a transfer instruction carries a uri")
        .to_string();
    let served = uri
        .rsplit_once("&ref=")
        .unwrap_or_else(|| panic!("step 3 must name a ref: {uri}"))
        .1;
    assert_eq!(
        served, reference,
        "the ring-up and step 3 must name ONE reference: {uri}"
    );
    assert_eq!(
        pinned(
            &transfer,
            &[
                (charge_id.as_str(), golden_charge.as_str()),
                (expiry_date.as_str(), &field(&["callback", "expiryDate"])),
                (reference.as_str(), golden_reference),
            ],
        ),
        golden_body(&golden, "callback"),
        "the step-3 body drifted from dfx/till_wire.json"
    );

    // --- step 4: the answer before the transfer has been seen --------------------------------------
    // Nothing minted here, so the body is compared as served.
    let submit = format!(
        "/v1/lnurlp/tx/{charge_id}?quote={quote_id}&method=InternetComputer&asset=VCHF&tx=9f1c"
    );
    let (status, pending) = call(&state, get_req(&submit)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "step 4: {pending}");
    assert_eq!(
        serde_json::to_string_pretty(&pending).expect("a JSON value renders"),
        golden_body(&golden, "submit_pending"),
        "the step-4 body drifted from dfx/till_wire.json"
    );

    // --- the one fact no body on this wire carries -------------------------------------------------
    // `amount_raw` is what the decimal MEANS: the raw VCHF units the payer's converter has to land
    // on. Pinned by paying EXACTLY that many to the merchant and watching a charge for the golden's
    // own price credit — so the number in the file is the till's own arithmetic rather than one
    // copied by hand.
    //
    // A FRESH charge, rung up before the money is sent, rather than the one above: that charge was
    // just walked, and a charge is walked at most once every couple of seconds however hard it is
    // polled (the amplification bound). Ringing up again is what a cashier does anyway, and it
    // keeps this test free of a sleep it would otherwise have to spend. The payment carries THAT
    // charge's own reference, because a transfer that names no charge credits none.
    let raw: u64 = field(&["amount_raw"])
        .parse()
        .expect("amount_raw is an integer");
    let reopened = open_till(&state, &merchant, &merchant_name, cents, &host, &proto).await;
    let reopened_id = reopened["id"]
        .as_str()
        .expect("a rung-up charge carries an id")
        .to_string();
    let reopened_ref = charge_reference(&reopened);
    pay_till(&state, &fake, pk, raw, &reopened_ref).await;
    let (status, paid) = call(
        &state,
        get_req(&format!(
            "/v1/lnurlp/tx/{reopened_id}?method=InternetComputer&asset=VCHF&tx=9f1c"
        )),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the golden's raw amount must be what credits this sale: {paid}"
    );
    assert_eq!(paid["paid"]["amount_raw"], field(&["amount_raw"]));
}

// --- delegated-conversion: /api/v1/swap_quote + /api/v1/venues + the fake-IC stub pools -----
//
// Spec 2026-09-07 §2/§6 (multi-venue readiness V3/V4/V7): the relay's quote route is a READ
// PROXY (the pool's own quote VERBATIM, attributed with its `venue_id`, + fetched_at, never a
// relay-computed rate) and the fake-IC gateway carries stub ICPSwap pools — PLURAL, keyed by
// principal, one per venue fixture seed (deterministic curve, icrc2-approved
// `depositFromAndSwap`, a pending_withdrawal knob each). These tests pin the route contracts,
// the venue refusals, the multi-pool seeding, and the full approve→swap happy path through
// the SAME signed /api/v2 rail the app uses.

/// The PoC venue's endpoint (the catalog venue registry's twin — pub(crate), pinned by
/// catalog_truth).
const SWAP_POOL: &str = "65mrh-fqaaa-aaaar-qapoa-cai";
/// The SECOND stub pool's invented principal (venue `icpswap-fixture-b` in the truth file,
/// `test_helpers_served: true`, `testnet: true`). NOT a real venue — it exists so the offline
/// loop can hold TWO venues on one pair with genuinely different curves/orders, served behind
/// the `POST /api/v1/test/venue` knob. Never probe it on mainnet; the agent build's allowlist
/// refuses it.
const FIXTURE_POOL: &str = "6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7";
const VCHF_LEDGER: &str = "ly36x-wiaaa-aaaai-aqj7q-cai";
const VCHF: Currency = 7;
/// A principal that is NOT a known venue (the ICPSwap factory — must be refused by name). BOTH
/// builds refuse it and both are tested: the offline route's own refusals in
/// [`swap_quote_refuses_unknown_pools_and_pairs`], and the shipped route's in
/// [`swap_quote_agent_refuses_an_unknown_pool_before_reaching_the_venue`]. It was briefly gated to
/// the offline build alone, which left the agent build's copy of the allowlist check — the one that
/// ships — covered by nothing at all.
const NOT_A_VENUE: &str = "4mmnk-kiaaa-aaaag-qbllq-cai";
/// `zeroForOne` for an ICP-in / VCHF-out trade at the PoC venue. FALSE, because the pool's own
/// `metadata` (MEASURED 2026-09-08, `dfx/catalog_truth.json` `venues[].fixture`) reports
/// `token0 = VCHF`, `token1 = ICP` — the REVERSE of what the 2026-09-07 build pinned. Every
/// signed-arg test below reads this rather than a bare `true`, and
/// [`approve_then_deposit_from_and_swap_pays_the_quoted_output`] asserts it against the stub's
/// own metadata so a reseed can never leave these literals behind.
const ICP_IN_ZERO_FOR_ONE: bool = false;

/// Sign + POST an arbitrary canister call, then read the outcome back the app's way
/// (read_state → certificate → request_status). The generic twin of
/// [`legacy_transfer_outcome`], which this PoC's pool calls reuse.
async fn signed_call_outcome(
    state: &AppState,
    sk: &SigningKey,
    canister: &str,
    method: &str,
    arg: Vec<u8>,
) -> RequestStatus {
    let req = CallRequest {
        canister: Principal::from_text(canister).expect("canister principal parses"),
        method_name: method.to_string(),
        arg,
        ingress_expiry_ns: ingress_expiry(now_ns(), 300),
        nonce: None,
    };
    let envelope = sign_update(sk, &req);
    let rid = verify_envelope(&envelope)
        .expect("our own envelope verifies")
        .request_id;
    let post = Request::builder()
        .method("POST")
        .uri(format!("/api/v2/canister/{canister}/call"))
        .body(Body::from(envelope))
        .unwrap();
    let (status, _h, body) = call_raw(state, post).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(body.is_empty(), "call replies with an empty 202 body");

    let path: &[&[u8]] = &[b"request_status", &rid];
    let read = sign_read_state(sk, &[path], ingress_expiry(now_ns(), 300));
    let req = Request::builder()
        .method("POST")
        .uri(format!("/api/v2/canister/{canister}/read_state"))
        .body(Body::from(read))
        .unwrap();
    let (status, _h, body) = call_raw(state, req).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "read_state must serve a certificate"
    );
    let tree = decode_read_state_tree(&body).expect("certificate decodes");
    request_status(&tree, &rid).expect("request_status decodes")
}

/// The swap Result carried by a replied depositFromAndSwap outcome.
fn swap_result(outcome: RequestStatus) -> dpay_icp::icrc::PoolSwapResult {
    match outcome {
        RequestStatus::Replied(arg) => decode_swap_result(&arg).expect("pool swap reply decodes"),
        other => panic!("expected a replied outcome, got {other:?}"),
    }
}

/// POST /api/v1/test/swap_pool — the knobs of ONE named stub pool (V3: the gateway hosts
/// many; a knob that didn't name its target could land on the wrong venue's curve).
async fn set_swap_pool_knobs(state: &AppState, pool: &str, knobs: serde_json::Value) {
    let mut body = serde_json::Map::new();
    body.insert("pool".to_string(), serde_json::json!(pool));
    if let serde_json::Value::Object(map) = knobs {
        for (k, v) in map {
            body.insert(k, v);
        }
    }
    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/test/swap_pool")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::Value::Object(body).to_string()))
        .unwrap();
    let (status, json) = call(state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["ok"], true);
}

fn swap_quote_uri(pool: &str, token_in: &str, token_out: &str, amount_in: u64) -> String {
    format!("/api/v1/swap_quote?pool={pool}&token_in={token_in}&token_out={token_out}&amount_in={amount_in}")
}

/// The route serves the pool's OWN quote verbatim and ATTRIBUTED (V4/V7): `venue_id` names the
/// venue the pool resolves to, `amount_out` equals the stub pool's curve (read directly through
/// the same `FakeIc` the gateway serves), `fee_millionths` is the venue's own tier echoed, and
/// the response carries the echo fields + a `fetched_at` stamp. Deterministic: identical inputs
/// ⇒ identical outputs.
/// (Offline-build only — under `agent` the route is the LIVE pool query, exactly like the
/// faucet tests.)
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn swap_quote_serves_the_pools_own_quote_verbatim() {
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let meta = fake
        .swap_pool_metadata(SWAP_POOL)
        .expect("the PoC venue's stub pool is seeded");

    let req = get_req(&swap_quote_uri(
        SWAP_POOL,
        ICP_LEDGER,
        VCHF_LEDGER,
        100_000_000,
    ));
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["venue_id"], "icpswap", "the quote is attributable to its venue");
    assert_eq!(body["pool"], SWAP_POOL);
    assert_eq!(body["token_in"], ICP_LEDGER);
    assert_eq!(body["token_out"], VCHF_LEDGER);
    assert_eq!(body["amount_in"], "100000000", "e8s as decimal string");
    assert_eq!(
        body["fee_millionths"].as_u64().map(u128::from),
        Some(meta.fee_millionths),
        "the venue's OWN fee tier, echoed — dpay claims no number here"
    );
    assert!(
        body["fetched_at"].as_u64().is_some_and(|t| t > 0),
        "fetched_at is wall-clock seconds"
    );
    // THE regression this whole change exists for: the direction is DERIVED from what the pool
    // says about itself, never from a pin. Asserting it against the metadata (rather than a
    // literal `true`) is what makes a reversed pair impossible to reintroduce silently — the
    // 2026-09-07 build's literal agreed with a backwards pin and shipped a ~5.9x-wrong rate.
    assert_eq!(
        body["zero_for_one"].as_bool(),
        Some(ICP_LEDGER == meta.token0_ledger),
        "zero_for_one == (token_in is the pool's own token0)"
    );
    // …and on the MEASURED live pair (token0 = VCHF, token1 = ICP) that means ICP in is
    // token1 in, i.e. FALSE — the exact bit production was serving inverted.
    assert_eq!(
        body["zero_for_one"], false,
        "ICP is the venue's token1, not its token0"
    );

    let amount_out = body["amount_out"].as_str().expect("amount_out is a string");
    let pool_quote = fake
        .swap_pool_quote(SWAP_POOL, false, 100_000_000)
        .expect("the PoC venue's stub pool is seeded");
    assert_eq!(
        amount_out,
        pool_quote.amount_out.to_string(),
        "the route's number IS the pool's number"
    );
    // The exact figure, pinned: the 2026-09-08 reseed moved token0/token1 into the venue's
    // measured order AND moved each reserve with its own token, so every quoted AMOUNT is
    // byte-identical to the pre-reseed suite and only the direction flag flipped. A future
    // reseed that changes what a user is quoted has to change this literal to land.
    assert_eq!(amount_out, "192420808", "1 ICP → VCHF on the stub curve");

    // Determinism: an identical quote is an identical number (no clock blending).
    let req = get_req(&swap_quote_uri(
        SWAP_POOL,
        ICP_LEDGER,
        VCHF_LEDGER,
        100_000_000,
    ));
    let (status, again) = call(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["amount_out"], body["amount_out"]);

    // The REVERSE direction quotes the other curve side (VCHF → ICP: VCHF IS token0 ⇒ true),
    // and the two directions are genuinely different numbers — a route that ignored direction
    // would return the same one twice.
    let req = get_req(&swap_quote_uri(
        SWAP_POOL,
        VCHF_LEDGER,
        ICP_LEDGER,
        100_000_000,
    ));
    let (status, rev) = call(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        rev["zero_for_one"].as_bool(),
        Some(VCHF_LEDGER == meta.token0_ledger),
    );
    assert_eq!(rev["zero_for_one"], true);
    assert_eq!(
        rev["amount_out"], "51658004",
        "1 VCHF → ICP on the stub curve"
    );
    assert_ne!(
        rev["amount_out"], body["amount_out"],
        "the same amount_in through opposite directions cannot quote the same amount_out"
    );
}

/// The route refuses unknown pools and non-pool pairs BY NAME, and refuses a venue whose pair
/// isn't the pool's own — fail-closed on anything the allowlist / the pool's own metadata
/// doesn't cover.
/// (Offline-build only — under `agent` the route is the LIVE pool query, exactly like the
/// faucet tests.)
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn swap_quote_refuses_unknown_pools_and_pairs() {
    let (state, _led, _fake) = state_with_fake(ledger()).await;

    let req = get_req(&swap_quote_uri(
        NOT_A_VENUE,
        ICP_LEDGER,
        VCHF_LEDGER,
        100_000_000,
    ));
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "unknown_pool", "the named refusal");

    let req = get_req(&swap_quote_uri(
        SWAP_POOL,
        ICP_LEDGER,
        ICP_LEDGER,
        100_000_000,
    ));
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "unsupported_pair");

    // A KNOWN venue but a pair the pool doesn't serve (DEMO is not in the ICP/VCHF pool).
    let req = get_req(&swap_quote_uri(
        SWAP_POOL,
        ICP_LEDGER,
        DEMO_LEDGER,
        100_000_000,
    ));
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "unsupported_pair");
}

/// The SAME name refusal, in the build that SHIPS. `swap_quote_agent` is a different function
/// with its own copy of the `venue_of_endpoint` allowlist check, and until now only the
/// offline twin's copy was ever exercised — the agent build compiled the test above out and
/// put nothing in its place.
///
/// The property is not cosmetic: `pool` is a caller-supplied canister id that the route turns into
/// a query, so a relay that skipped the allowlist would be an open query proxy for any canister on
/// the IC. It is checked BEFORE the venue is touched, and this state's `FakeLedger` inherits
/// `Ledger::swap_pool_metadata`'s "cannot query swap pools" default — so the 400 below is itself
/// the proof that nothing was asked of any venue, and the 503 after it is the control that says
/// the 400 came from the allowlist rather than from a parse failure refusing every pool alike.
///
/// The pair refusals stay offline-only: those are read off the pool's OWN metadata, which the fake
/// ledger has none of, and inventing one here would test this test rather than the route.
#[cfg(feature = "agent")]
#[tokio::test]
async fn swap_quote_agent_refuses_an_unknown_pool_before_reaching_the_venue() {
    let (state, _led, _fake) = state_with_fake(ledger()).await;

    let req = get_req(&swap_quote_uri(
        NOT_A_VENUE,
        ICP_LEDGER,
        VCHF_LEDGER,
        100_000_000,
    ));
    let (status, body) = call(&state, req).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the venue must never be asked: {body}"
    );
    assert_eq!(body["error"], "unknown_pool", "the named refusal");

    let req = get_req(&swap_quote_uri(
        SWAP_POOL,
        ICP_LEDGER,
        VCHF_LEDGER,
        100_000_000,
    ));
    let (status, body) = call(&state, req).await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "the ALLOWED venue gets past the name check and dies at the ledger this state cannot \
         query — which is what makes the 400 above an allowlist refusal: {body}"
    );
}

/// The full happy path through the SAME signed /api/v2 rail the app uses: icrc2_approve of the
/// POOL on the ICP ledger (exact amount + fee + expiry) → depositFromAndSwap pulls the input
/// (charging the input ledger's fee) and pays the QUOTED output to the caller's principal on
/// the VCHF ledger — the payout equals the route's earlier quote exactly (both evaluate the
/// curve against the same pre-swap reserves), and the reply is the pool's own ok(amountOut).
#[tokio::test]
async fn approve_then_deposit_from_and_swap_pays_the_quoted_output() {
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let payer = keypair();
    let owner = user_principal(&pubkey(&payer));
    fake.faucet_credit(ICP, &owner, 10_000_000_000); // 100 ICP

    // The expected payout, straight from the fake pool's own quote — the number the swap must
    // pay out verbatim. (The HTTP route's verbatim passthrough is pinned by the gated test
    // above; this oracle keeps the approve→swap path runnable under the `agent` build too,
    // where the route serves the live pool query by design.) The direction is read off the
    // stub's OWN metadata, exactly as the app reads it off the quote's `zero_for_one` echo.
    let meta = fake
        .swap_pool_metadata(SWAP_POOL)
        .expect("the PoC venue's stub pool is seeded");
    assert_eq!(
        (meta.token0_ledger.as_str(), meta.token1_ledger.as_str()),
        (VCHF_LEDGER, ICP_LEDGER),
        "the stub serves the MEASURED live pair order (token0 = VCHF, token1 = ICP)"
    );
    assert_eq!(
        ICP_IN_ZERO_FOR_ONE,
        ICP_LEDGER == meta.token0_ledger,
        "the signed-arg literal below must track the stub pool's OWN pair order"
    );
    let quoted = fake
        .swap_pool_quote(SWAP_POOL, ICP_IN_ZERO_FOR_ONE, 100_000_000)
        .expect("the PoC venue's stub pool is seeded")
        .amount_out;
    assert!(quoted > 0);

    // icrc2_approve: exact swap amount, approve fee, 5-min expiry — spec §3's bounds.
    let spender = Account {
        owner: Principal::from_text(SWAP_POOL).unwrap(),
        subaccount: [0; 32],
    };
    let approve = approve_arg(
        None,
        &spender,
        Some(100_000_000),
        None,
        Some(now_ns() + 300_000_000_000),
        None,
        None,
        Some(10_000),
    );
    let outcome = signed_call_outcome(&state, &payer, ICP_LEDGER, "icrc2_approve", approve).await;
    assert!(matches!(
        swap_result_or_approve(&outcome),
        ApproveCheck::Approved
    ));

    // depositFromAndSwap on the pool canister: 1 ICP in, no minimum, fees declared.
    let args = deposit_and_swap_arg(100_000_000, 0, 10_000, 10_000, ICP_IN_ZERO_FOR_ONE);
    let outcome = signed_call_outcome(&state, &payer, SWAP_POOL, "depositFromAndSwap", args).await;
    assert_eq!(
        swap_result(outcome),
        Ok(quoted),
        "the swap pays the quoted output, verbatim"
    );

    // Balances: ICP −(amount + approve fee + transfer_from fee); VCHF +quoted (gross).
    assert_eq!(
        fake.balance_for(ICP, &owner),
        10_000_000_000 - 100_000_000 - 10_000 - 10_000
    );
    assert_eq!(u128::from(fake.balance_for(VCHF, &owner)), quoted);

    // The approval was EXACT-amount: a second identical swap is refused by the pool (#err,
    // not a reject — the pool's own shape), and no balances move.
    let args = deposit_and_swap_arg(100_000_000, 0, 10_000, 10_000, ICP_IN_ZERO_FOR_ONE);
    let outcome = signed_call_outcome(&state, &payer, SWAP_POOL, "depositFromAndSwap", args).await;
    assert_eq!(swap_result(outcome), Err(PoolSwapError::InsufficientFunds));
    assert_eq!(
        fake.balance_for(ICP, &owner),
        10_000_000_000 - 100_000_000 - 20_000
    );
    assert_eq!(u128::from(fake.balance_for(VCHF, &owner)), quoted);
}

/// The approve-outcome shim: an icrc2_approve reply is an ApproveResult, not a swap Result.
enum ApproveCheck {
    Approved,
}
fn swap_result_or_approve(outcome: &RequestStatus) -> ApproveCheck {
    match outcome {
        RequestStatus::Replied(arg) => {
            match decode_approve_result(arg).expect("approve reply decodes") {
                ApproveResult::Ok(_) => ApproveCheck::Approved,
                ApproveResult::Err(e) => panic!("approve refused: {e:?}"),
            }
        }
        other => panic!("expected a replied outcome, got {other:?}"),
    }
}

/// The pending_withdrawal knob (spec §4): with `fail_withdrawal` armed, a successful swap
/// consumes the input and reserves but QUEUES the output — the reply is still ok(amountOut),
/// the VCHF balance does NOT move. `settle_pending` is the resolution: the queue drains and
/// the caller's VCHF lands.
#[tokio::test]
async fn fail_withdrawal_knob_queues_output_and_settle_resolves_it() {
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let payer = keypair();
    let owner = user_principal(&pubkey(&payer));
    fake.faucet_credit(ICP, &owner, 10_000_000_000);

    set_swap_pool_knobs(&state, SWAP_POOL, serde_json::json!({"fail_withdrawal": true})).await;

    let spender = Account {
        owner: Principal::from_text(SWAP_POOL).unwrap(),
        subaccount: [0; 32],
    };
    let approve = approve_arg(
        None,
        &spender,
        Some(100_000_000),
        None,
        Some(now_ns() + 300_000_000_000),
        None,
        None,
        Some(10_000),
    );
    let outcome = signed_call_outcome(&state, &payer, ICP_LEDGER, "icrc2_approve", approve).await;
    assert!(matches!(
        swap_result_or_approve(&outcome),
        ApproveCheck::Approved
    ));

    let args = deposit_and_swap_arg(100_000_000, 0, 10_000, 10_000, ICP_IN_ZERO_FOR_ONE);
    let outcome = signed_call_outcome(&state, &payer, SWAP_POOL, "depositFromAndSwap", args).await;
    let Ok(queued_out) = swap_result(outcome) else {
        panic!("the swap itself succeeds; only the withdrawal 'fails'")
    };
    // Input consumed, output NOT paid: the pool's unused-balance state (spec §4).
    assert_eq!(
        fake.balance_for(ICP, &owner),
        10_000_000_000 - 100_000_000 - 10_000 - 10_000
    );
    assert_eq!(
        fake.balance_for(VCHF, &owner),
        0,
        "pending_withdrawal: nothing on the output ledger yet"
    );

    // The resolution: the async withdrawal eventually lands.
    set_swap_pool_knobs(&state, SWAP_POOL, serde_json::json!({"settle_pending": true})).await;
    assert_eq!(u128::from(fake.balance_for(VCHF, &owner)), queued_out);
}

/// Allowances are EXPIRY-AWARE at every read (spec §3: expires_at is enforced, not recorded):
/// an approval whose expiry already passed reads as zero and the pool refuses the pull —
/// nothing moves.
#[tokio::test]
async fn expired_allowance_blocks_the_swap() {
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let payer = keypair();
    let owner = user_principal(&pubkey(&payer));
    fake.faucet_credit(ICP, &owner, 10_000_000_000);

    let spender = Account {
        owner: Principal::from_text(SWAP_POOL).unwrap(),
        subaccount: [0; 32],
    };
    let approve = approve_arg(
        None,
        &spender,
        Some(100_000_000),
        None,
        Some(now_ns() - 1_000_000_000), // already expired
        None,
        None,
        Some(10_000),
    );
    let outcome = signed_call_outcome(&state, &payer, ICP_LEDGER, "icrc2_approve", approve).await;
    assert!(matches!(
        swap_result_or_approve(&outcome),
        ApproveCheck::Approved
    ));

    let args = deposit_and_swap_arg(100_000_000, 0, 10_000, 10_000, ICP_IN_ZERO_FOR_ONE);
    let outcome = signed_call_outcome(&state, &payer, SWAP_POOL, "depositFromAndSwap", args).await;
    assert_eq!(swap_result(outcome), Err(PoolSwapError::InsufficientFunds));
    // Only the two approve fees ever left (approve itself, then nothing): balance untouched by
    // the refused swap — input, not even a partial leg, moved.
    assert_eq!(fake.balance_for(ICP, &owner), 10_000_000_000 - 10_000);
    assert_eq!(fake.balance_for(VCHF, &owner), 0);
}

/// The knobs shape the curve the pool itself serves: fee_millionths 0 quotes above the
/// default 3000 tier for the same input; impact_bps 10_000 floors the payout at 0.
/// (Offline-build only — under `agent` the route is the LIVE pool query, exactly like the
/// faucet tests.)
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn swap_pool_knobs_shape_the_quote_curve() {
    let (state, _led, _fake) = state_with_fake(ledger()).await;
    let uri = swap_quote_uri(SWAP_POOL, ICP_LEDGER, VCHF_LEDGER, 100_000_000);

    let (status, base) = call(&state, get_req(&uri)).await;
    assert_eq!(status, StatusCode::OK);
    let base: u128 = base["amount_out"].as_str().unwrap().parse().unwrap();

    set_swap_pool_knobs(&state, SWAP_POOL, serde_json::json!({"fee_millionths": 0})).await;
    let (status, zero_fee) = call(&state, get_req(&uri)).await;
    assert_eq!(status, StatusCode::OK);
    let zero_fee: u128 = zero_fee["amount_out"].as_str().unwrap().parse().unwrap();
    assert!(
        zero_fee > base,
        "no fee tier quotes strictly above the 0.30% tier"
    );

    set_swap_pool_knobs(&state, SWAP_POOL, serde_json::json!({"impact_bps": 10000})).await;
    let (status, floored) = call(&state, get_req(&uri)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        floored["amount_out"], "0",
        "a 100% impact haircut floors the quote"
    );
}

/// `GET /api/v1/venues` serves the compiled registry — the REAL venues only (V4): the
/// fixture-only entry is pinned into the truth file and seeded into the fake, but it must
/// never render in a served list; an invented venue id appearing here would put a phantom
/// counterparty in real wallets. The pair arrives as an UNORDERED pair (which side a pool
/// calls token0 is the venue's own fact, read live per quote) and carries NO fee tier — the
/// venue's quote echoes its own.
#[tokio::test]
async fn venues_route_serves_the_real_registry_and_no_fixture_entries() {
    let (state, _led, _fake) = state_with_fake(ledger()).await;
    let req = get_req("/api/v1/venues");
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::OK);

    let served = body["venues"].as_array().expect("venues is an array");
    assert_eq!(served.len(), 1, "exactly one real venue is served today");
    let v = &served[0];
    assert_eq!(v["venue_id"], "icpswap");
    assert_eq!(v["display_name"], "ICPSwap");
    assert_eq!(v["kind"], "ic_amm");
    assert_eq!(v["endpoint"], SWAP_POOL);
    assert_eq!(v["testnet"], false);
    assert_eq!(v["disclosure_key"], "icpswap");
    let mut pair: Vec<&str> = v["pair_ledgers"]
        .as_array()
        .expect("pair_ledgers is an array")
        .iter()
        .map(|p| p.as_str().expect("ledger principal"))
        .collect();
    pair.sort_unstable();
    let mut want = [VCHF_LEDGER, ICP_LEDGER];
    want.sort_unstable();
    assert_eq!(pair, want, "the pair as an unordered ledger set");
    assert!(
        v.get("fee_millionths").is_none(),
        "the fee tier is NOT registry data — the venue's own quote echoes it"
    );
    assert!(
        !body.to_string().contains(FIXTURE_POOL),
        "an invented fixture venue must never appear in a served list un-asked-for"
    );
}

/// `POST /api/v1/test/venue` — the multi-venue V5 knob: `/api/v1/venues` serves the fixture
/// venue ONLY while the knob is armed, and ONLY in this offline test build (the route this
/// test drives does not exist under `agent`). The default — and the state after a disarm — is
/// exactly the production experience: one venue, no invented principal in the list. The
/// agent-build half of the guarantee is pinned structurally in
/// `catalog::venue_truth_tests::fixture_venue_is_never_servable_in_the_agent_build_or_without_the_knob`.
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn venue_serve_knob_gates_the_fixture_venue_into_the_served_list() {
    let (state, _led, _fake) = state_with_fake(ledger()).await;

    // Default (nothing armed): exactly the one real venue.
    let (status, body) = call(&state, get_req("/api/v1/venues")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["venues"].as_array().map(Vec::len),
        Some(1),
        "the default experience is ONE venue per pair, like prod"
    );

    let post_venue = |served: bool, venue_id: &str| {
        Request::builder()
            .method("POST")
            .uri("/api/v1/test/venue")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({"venue_id": venue_id, "served": served}).to_string(),
            ))
            .unwrap()
    };

    // Arm: the fixture venue appears AFTER the real one — compiled registry order, the stable
    // quote-independent row order the app's chooser renders verbatim and never ranks.
    let (status, body) = call(&state, post_venue(true, "icpswap-fixture-b")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["served"], true);
    let (status, body) = call(&state, get_req("/api/v1/venues")).await;
    assert_eq!(status, StatusCode::OK);
    let venues = body["venues"].as_array().expect("venues is an array");
    assert_eq!(venues.len(), 2, "two venues on the pair with the knob armed");
    assert_eq!(venues[0]["venue_id"], "icpswap", "the real venue stays first");
    assert_eq!(venues[1]["venue_id"], "icpswap-fixture-b");
    assert_eq!(venues[1]["endpoint"], FIXTURE_POOL);
    assert_eq!(venues[1]["display_name"], "ICPSwap (offline fixture)");
    assert_eq!(
        venues[1]["testnet"], true,
        "the fixture venue is labelled the invented stand-in it is"
    );

    // Disarm: back to the one-venue default (teardown parity — e2e flows share one relay).
    let (status, body) = call(&state, post_venue(false, "icpswap-fixture-b")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["served"], false);
    let (status, body) = call(&state, get_req("/api/v1/venues")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["venues"].as_array().map(Vec::len), Some(1));
    assert!(!body.to_string().contains(FIXTURE_POOL));

    // The knob can neither gate a REAL venue nor invent an unknown one — routing is a
    // user/registry decision, never test state.
    let (status, body) = call(&state, post_venue(false, "icpswap")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "not_a_test_venue");
    let (status, body) = call(&state, post_venue(true, "no-such-venue")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "unknown_venue");
}

/// The SECOND stub pool (multi-venue readiness V3): two venues on ONE pair, offline — the
/// invented fixture venue quotes its OWN curve, order and fee through the same route. Its
/// seed order is deliberately REVERSED (token0 = ICP), so an ICP-in trade there derives the
/// OPPOSITE `zero_for_one` from the PoC pool's — a route or gateway that resolved direction
/// against any single pool's order (or any constant) cannot pass both this and the PoC test
/// above. Its fee tier (1000) and curve differ, so the two venues' numbers differ too.
/// (Offline-build only: the fixture pool exists nowhere else — the agent allowlist refuses it.)
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn second_fixture_pool_quotes_its_own_curve_on_the_same_pair() {
    let (state, _led, fake) = state_with_fake(ledger()).await;
    let meta_b = fake
        .swap_pool_metadata(FIXTURE_POOL)
        .expect("the fixture-B stub pool is seeded");
    assert_eq!(
        (meta_b.token0_ledger.as_str(), meta_b.token1_ledger.as_str()),
        (ICP_LEDGER, VCHF_LEDGER),
        "fixture B deliberately REVERSES the PoC pool's measured order"
    );

    let req = get_req(&swap_quote_uri(
        FIXTURE_POOL,
        ICP_LEDGER,
        VCHF_LEDGER,
        100_000_000,
    ));
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::OK, "the fixture pool quotes offline: {body}");
    assert_eq!(body["venue_id"], "icpswap-fixture-b");
    assert_eq!(body["pool"], FIXTURE_POOL);
    assert_eq!(
        body["zero_for_one"].as_bool(),
        Some(ICP_LEDGER == meta_b.token0_ledger),
        "direction derived from THIS pool's own token order"
    );
    assert_eq!(body["zero_for_one"], true, "ICP is fixture B's own token0");
    assert_eq!(
        body["fee_millionths"].as_u64(),
        Some(1000),
        "fixture B's own fee tier, echoed"
    );

    let amount_out = body["amount_out"].as_str().expect("amount_out is a string");
    let pool_b_quote = fake
        .swap_pool_quote(FIXTURE_POOL, true, 100_000_000)
        .expect("the fixture-B stub pool is seeded");
    assert_eq!(amount_out, pool_b_quote.amount_out.to_string());
    let poc_quote = fake
        .swap_pool_quote(SWAP_POOL, ICP_IN_ZERO_FOR_ONE, 100_000_000)
        .expect("the PoC venue's stub pool is seeded");
    assert!(
        pool_b_quote.amount_out > 0 && pool_b_quote.amount_out != poc_quote.amount_out,
        "two venues on one pair are two genuinely different curves ({} vs {})",
        pool_b_quote.amount_out,
        poc_quote.amount_out
    );

    // The payout path works on the fixture pool too — same signed rail, pool keyed by the
    // envelope's own canister, direction per that pool's order: fixture B's ICP-in is TRUE.
    let payer = keypair();
    let owner = user_principal(&pubkey(&payer));
    fake.faucet_credit(ICP, &owner, 10_000_000_000);
    let spender = Account {
        owner: Principal::from_text(FIXTURE_POOL).unwrap(),
        subaccount: [0; 32],
    };
    let approve = approve_arg(
        None,
        &spender,
        Some(100_000_000),
        None,
        Some(now_ns() + 300_000_000_000),
        None,
        None,
        Some(10_000),
    );
    let outcome = signed_call_outcome(&state, &payer, ICP_LEDGER, "icrc2_approve", approve).await;
    assert!(matches!(
        swap_result_or_approve(&outcome),
        ApproveCheck::Approved
    ));
    let args = deposit_and_swap_arg(100_000_000, 0, 10_000, 10_000, true);
    let outcome = signed_call_outcome(&state, &payer, FIXTURE_POOL, "depositFromAndSwap", args).await;
    assert_eq!(
        swap_result(outcome),
        Ok(pool_b_quote.amount_out),
        "the fixture pool pays its own quoted output"
    );
    assert_eq!(u128::from(fake.balance_for(VCHF, &owner)), pool_b_quote.amount_out);
}

/// The knobs are PER POOL (V3): a knob names its target and touches nothing else — a haircut
/// armed on fixture B must leave the PoC venue's quote alone, and a knob with no pool, or for
/// an unknown pool, is a NAMED refusal.
/// (Offline-build only — under `agent` the knob route is test-helpers-gated off with the
/// gateway itself.)
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn knobs_target_the_named_pool_only() {
    let (state, _led, _fake) = state_with_fake(ledger()).await;
    let poc_uri = swap_quote_uri(SWAP_POOL, ICP_LEDGER, VCHF_LEDGER, 100_000_000);
    let b_uri = swap_quote_uri(FIXTURE_POOL, ICP_LEDGER, VCHF_LEDGER, 100_000_000);

    let (status, base) = call(&state, get_req(&poc_uri)).await;
    assert_eq!(status, StatusCode::OK);
    let base = base["amount_out"].as_str().unwrap().to_string();

    // A 100% haircut on fixture B floors B's quote and leaves the PoC venue untouched.
    set_swap_pool_knobs(&state, FIXTURE_POOL, serde_json::json!({"impact_bps": 10000})).await;
    let (status, floored_b) = call(&state, get_req(&b_uri)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(floored_b["amount_out"], "0");
    let (status, unchanged) = call(&state, get_req(&poc_uri)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        unchanged["amount_out"], base,
        "a knob on one pool must not touch another venue's curve"
    );

    // No pool named: a named refusal (a knob must never default onto some pool).
    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/test/swap_pool")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"impact_bps": 5000}"#.to_string()))
        .unwrap();
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "pool is required");

    // An unknown pool: the same refusal the quote route makes.
    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/test/swap_pool")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::json!({"pool": NOT_A_VENUE, "impact_bps": 5000}).to_string(),
        ))
        .unwrap();
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "unknown_pool");
}

/// V9 INVARIANT 3: the relay's venue surface is QUERY-ONLY. Every /api/v1 route mentioning a
/// venue or a swap quote is a GET read; the only mutating routes on that surface are the
/// test-helpers-only /test/venue and /test/swap_pool knobs, and the knob route itself refuses
/// GET (POST-only). Axum answers a REGISTERED path with the wrong method as 405 — so these
/// assertions enumerate the route table's venue/swap surface: no POST/PUT/DELETE handler
/// exists on /venues or /swap_quote in any build.
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn venue_surface_is_query_only() {
    let (state, _led, _fake) = state_with_fake(ledger()).await;

    for (method, uri) in [
        ("POST", "/api/v1/venues"),
        ("PUT", "/api/v1/venues"),
        ("DELETE", "/api/v1/venues"),
        ("POST", "/api/v1/swap_quote"),
        ("DELETE", "/api/v1/swap_quote"),
        ("GET", "/api/v1/test/venue"),
    ] {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let status = call_status(&state, req).await;
        assert_eq!(
            status,
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} {uri} must not exist as a handler (query-only surface)"
        );
    }

    // Reads are idempotent and leave no trace: the served list is identical across reads, and
    // quoting EVERY registered pool changes nothing about what /venues serves.
    let (s1, v1) = call(&state, get_req("/api/v1/venues")).await;
    assert_eq!(s1, StatusCode::OK);
    let (s2, v2) = call(&state, get_req("/api/v1/venues")).await;
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(v1, v2, "GET /venues is a pure read");
    for pool in [SWAP_POOL, FIXTURE_POOL] {
        let (s, _) = call(&state, get_req(&swap_quote_uri(pool, ICP_LEDGER, VCHF_LEDGER, 100_000_000))).await;
        assert_eq!(s, StatusCode::OK, "{pool}: quotes offline");
    }
    let (s3, v3) = call(&state, get_req("/api/v1/venues")).await;
    assert_eq!(s3, StatusCode::OK);
    assert_eq!(v1, v3, "quoting both pools leaked nothing into the served venue list");
}

/// V9 INVARIANT 1 (route half): dpay-OWNED canister principals are refused by the quote route
/// as unknown pools — `catalog::venue_of_endpoint` IS the allowlist and no dpay canister
/// resolves through it. Pinned against the two owned principals in `canister_ids.json`
/// (`ssqti-…` dpay_canister/facade, `td2nx-…` icrc_ledger/DUSD); the catalog-level twin is
/// `dpay_owned_principals_never_resolve_as_venues`, the phone-side signing-boundary twin is
/// `app/config/venues.ts` DPAY_CANISTER_PRINCIPALS (checked by venueInvariants.test.ts).
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn swap_quote_refuses_dpay_owned_principals_as_pools() {
    let (state, _led, _fake) = state_with_fake(ledger()).await;
    for pool in ["ssqti-wiaaa-aaaab-qhdia-cai", "td2nx-oaaaa-aaaab-qhdnq-cai"] {
        let req = get_req(&swap_quote_uri(pool, ICP_LEDGER, VCHF_LEDGER, 100_000_000));
        let (status, body) = call(&state, req).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{pool}: a dpay canister is not a venue");
        assert_eq!(body["error"], "unknown_pool", "{pool}: the same named refusal as any unknown pool");
    }
}

/// V9 INVARIANT 4 (relay half): the served number is THE POOL'S OWN REPLY, byte-equal — for
/// EVERY registered pool (the real venue and the fixture venue alike) — and it moves
/// identically when the pool's own output is mutated through the existing knob. The render
/// halves live in `app/__tests__/venueInvariants.test.ts` (relay echo → ConvertQuote) and
/// `app/__tests__/convertMode.test.tsx` (ConvertQuote → rendered string, parametric per
/// venue); e2e flow 167 covers the full chain through the real relay + browser.
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn every_pool_quote_is_its_own_reply_verbatim_and_moves_with_the_knob() {
    let (state, _led, fake) = state_with_fake(ledger()).await;
    // (pool, zero_for_one for ICP→VCHF per THAT pool's own token order, a distinct knob fee)
    let cases: [(&str, bool, u64); 2] = [
        (SWAP_POOL, ICP_IN_ZERO_FOR_ONE, 777),
        (FIXTURE_POOL, true, 1234),
    ];
    let mut seen: Vec<String> = Vec::new();
    for (pool, zero_for_one, fee) in cases {
        let uri = swap_quote_uri(pool, ICP_LEDGER, VCHF_LEDGER, 100_000_000);
        let (status, base) = call(&state, get_req(&uri)).await;
        assert_eq!(status, StatusCode::OK, "{pool}: quotes before the knob");
        let base = base["amount_out"].as_str().unwrap().to_string();

        // Mutate THIS pool's own output (the fee tier shapes the curve): the served number
        // must move, and land byte-equal on the pool's own post-knob reply.
        set_swap_pool_knobs(&state, pool, serde_json::json!({"fee_millionths": fee})).await;
        let (status, body) = call(&state, get_req(&uri)).await;
        assert_eq!(status, StatusCode::OK, "{pool}: quotes after the knob");
        let amount_out = body["amount_out"].as_str().unwrap().to_string();
        let own = fake
            .swap_pool_quote(pool, zero_for_one, 100_000_000)
            .unwrap_or_else(|| panic!("{pool}: the stub pool is seeded"));
        assert_eq!(
            amount_out,
            own.amount_out.to_string(),
            "{pool}: byte-equal to the pool's own reply"
        );
        assert_ne!(amount_out, base, "{pool}: the knob really moved the pool's output");
        seen.push(amount_out);
    }
    assert_ne!(seen[0], seen[1], "the two pools remain two genuinely different curves");
}
