//! End-to-end relay tests — the fast, in-memory inner loop. No socket is bound: we drive the
//! axum `Router` directly with `tower::ServiceExt::oneshot`.
//!
//! 2026-08-19 IC-rail cutover: the relay's settlement surface (/pay, /withdraw, /receipt,
//! /deposit/address, /deposit/refresh) is GONE — value moves on the IC rail, with the app
//! signing /api/v2 envelopes locally and submitting them to the boundary nodes (icp-api.io in
//! prod; this relay's fake-IC gateway under `test-helpers` in tests). What the relay still
//! serves, covered here:
//! - read surfaces: /balances (batch), /transactions (history), /currencies, /deposit/info,
//!   /onramp/ckerc20, /health, /version;
//! - test-only value fixtures against the fake-IC gateway: POST /faucet + GET /balance
//!   (principal-keyed, exactly where a signed icrc1_transfer moves funds);
//! - the fake-IC /api/v2 boundary itself: mounting, garbage-envelope rejection, and a REAL
//!   signed icrc1_transfer executed by the gateway (verify → dedup → execute → history);
//! - the public root: landing page, privacy, /wallet (the real app), APK download, screenshots,
//!   /dpay-core.wasm.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use sha2::Digest;
use tower::ServiceExt; // oneshot

use dpay_core::DEMO_USD;
use dpay_icp::envelope::{ingress_expiry, sign_update, CallRequest};
use dpay_icp::icrc::transfer_arg;
use dpay_icp::principal::{Account, Principal};
use dpay_relay::{app, ic_gateway::FakeIc, AppState, FakeLedger};
use ed25519_dalek::SigningKey;


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
/// the faucet/balance/transactions fixtures read the gateway's principal-keyed ledgers.
async fn state_with_fake(ledger: FakeLedger) -> (AppState, Arc<FakeLedger>, Arc<FakeIc>) {
    let arc = Arc::new(ledger);
    let fake = FakeIc::from_catalog(&*arc).await;
    let state = AppState::new(arc.clone()).with_fake_ic(fake.clone());
    (state, arc, fake)
}

/// POST /api/v1/faucet — the demo on-ramp (test-helpers). `amount_json` is a pre-rendered JSON
/// value for the amount (quoted decimal string OR raw number — the deserializer takes both);
/// `None` omits the field (the faucet's default top-up).
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

async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
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

/// `GET /api/v1/version` reports the relay's name + pkg version + the git commit baked by `build.rs`.
/// The commit is the deploy-fidelity primitive (verify-relay-version.sh compares it to HEAD); this
/// test pins the route's shape + that the commit is present (non-empty), so a future change that
/// drops the build.rs wiring surfaces here.
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
    // The baked commit is either a 40-char SHA (a git checkout) or the "unknown" fallback (no git).
    // In the test build (run from the repo) it MUST be a real SHA — proves build.rs wired through.
    assert!(
        commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit()),
        "commit must be a 40-char SHA when built in a git checkout, got {commit:?}"
    );
}

// --- faucet + balance (test-helpers fixtures over the fake-IC gateway) ------
//
// These pin the FAKE-IC /faucet branch, which serves the route only when `agent` is NOT compiled
// in (the offline e2e/test-relay build). With both features on — the live-test config — the
// PRODUCTION agent branch owns POST /faucet (relay-side cooldown + authenticated canister mint,
// covered by live.rs `live_faucet_mints_at_user_principal_with_relay_side_cooldown`), so these
// fake-gateway assertions don't apply there and are compiled out.

/// The faucet still MINTS, so on any real ledger the relay disables it. Disabled means the route
/// is *gone* (404) and, crucially, no money is created at the user's principal on the gateway.
#[cfg(not(feature = "agent"))]
#[tokio::test]
async fn faucet_disabled_mints_nothing() {
    let merchant = keypair();
    let (state, _led, fake) = state_with_fake(ledger()).await;
    state.set_faucet_enabled(false);
    let merch_owner = user_principal(&pubkey(&merchant));

    let (status, body) = call(
        &state,
        faucet_json(&hex::encode(pubkey(&merchant)), Some("999")),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        fake.balance_for(DEMO_USD, &merch_owner),
        0,
        "a disabled faucet must not create funds"
    );
}

/// …and enabled (the demo default) it credits the USER PRINCIPAL on the fake-IC gateway — exactly
/// where a signed icrc1_transfer spends from. The response balance and GET /api/v1/balance/{hex}
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

    // The test-only read-back route agrees (same principal mapping), explicit currency included.
    let (bs, bb) = call(&state, get_req(&format!("/api/v1/balance/{merch_hex}?currency=0"))).await;
    assert_eq!(bs, StatusCode::OK, "{bb}");
    assert_eq!(bb["balance"], "999", "{bb}");

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
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "application/cbor");
    assert!(!bytes.is_empty(), "status carries a CBOR body");

    // A garbage envelope on call: 400 (verify_envelope fails) — never a 500, never executed.
    let garbage = Request::builder()
        .method("POST")
        .uri("/api/v2/canister/aaaaa-aa/call")
        .body(Body::from("definitely not a signed envelope"))
        .unwrap();
    let (status, _headers, _bytes) = call_raw(&state, garbage).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "garbage envelope must 400");

    // Without the gateway attached the /api/v2 namespace is gone (404)…
    let (bare_state, _led2) = state_from(ledger());
    let garbage_bare = Request::builder()
        .method("POST")
        .uri("/api/v2/canister/aaaaa-aa/call")
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

    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
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
        canister: Principal::management_canister(), // the DEMO_USD catalog ledger ("aaaaa-aa")
        method_name: "icrc1_transfer".to_string(),
        arg,
        ingress_expiry_ns: ingress_expiry(now_ns, 300),
        nonce: None,
    };
    let envelope = sign_update(&payer, &req);
    let post = || {
        Request::builder()
            .method("POST")
            .uri("/api/v2/canister/aaaaa-aa/call")
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
    assert_eq!(fake.balance_for(DEMO_USD, &merch_owner), 250, "credited once");

    // History carries the transfer with the memo (hex of the signed arg's memo bytes) + the mint
    // that funded it, newest-first, on BOTH sides of the payment.
    let payer_hex = hex::encode(pubkey(&payer));
    let merch_hex = hex::encode(pubkey(&merchant));
    let (ps, pb) = call(&state, get_req(&format!("/api/v1/transactions/{payer_hex}"))).await;
    assert_eq!(ps, StatusCode::OK, "{pb}");
    let rows = pb["transactions"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "mint + transfer: {pb}");
    // Newest first: the outgoing transfer, then the funding mint.
    assert_eq!(rows[0]["amount"], "250", "{pb}");
    assert_eq!(rows[0]["from"], payer_owner.to_text(), "{pb}");
    assert_eq!(rows[0]["to"], merch_owner.to_text(), "{pb}");
    assert_eq!(rows[0]["memo"], hex::encode(settlement_memo), "memo rides the signed arg: {pb}");
    assert_eq!(rows[0]["currency"], 0); // DEMO_USD
    // Display names don't exist on the IC rail — the fields stay stable empty strings (never
    // null, never leaked bytes).
    assert_eq!(rows[0]["from_name"], "");
    assert_eq!(rows[0]["to_name"], "");
    assert_eq!(rows[1]["amount"], "10000", "the funding mint: {pb}");
    assert_eq!(rows[1]["from"], "", "mint rows carry no sender");

    // The payee sees the same transfer as incoming (from == the payer's principal).
    let (ms, mb) = call(&state, get_req(&format!("/api/v1/transactions/{merch_hex}"))).await;
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
        recent_b["transactions"].as_array().unwrap().iter().all(|r| r["memo"] != hex::encode(settlement_memo)),
        "target must genuinely be outside the newest-30 window: {recent_b}",
    );
    let memo_hex = hex::encode(settlement_memo);
    let (memo_s, memo_b) = call(
        &state,
        get_req(&format!("/api/v1/transactions/{merch_hex}?limit=1&memo={memo_hex}")),
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
    assert_eq!(bad_s, StatusCode::BAD_REQUEST, "short memo filters must fail closed");
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
    for shot in [
        "/shots/request.png",
        "/shots/paying.png",
        "/shots/paid.png",
    ] {
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
        assert!(etag.starts_with("\"shots-"), "etag must be versioned: {etag}");
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
/// (app/config/education.ts CAMPAIGN_LINE — the literal line lives only there since the
/// founder's 2026-08-24 wording pass 27a258e; the pointer keeps the two homes honest), the
/// hero states the asymmetry plainly (payer offline, merchant online, the shop's connection
/// settles it), and the "Paying offline" rail renders the four beats: pay → show your code →
/// shop scans → settled. Honesty pins: the banned-claims sweep — no "conversion" family, no
/// "anywhere", no "works with any currency", no "nobody needs internet" — and proof motion
/// must keep the reduced-motion kill switch.
#[tokio::test]
async fn landing_page_tells_the_offline_payment_story() {
    let (state, _led) = state_from(ledger());

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();
    // The campaign-line single-source pointer comment (the literal line lives only in
    // app/config/education.ts CAMPAIGN_LINE; the founder's 2026-08-24 wording pass 27a258e
    // removed the byte-identical copy from this page — the pointer comment keeps the two
    // homes honest).
    assert!(
        html.contains("<!-- single source: app/config/education.ts CAMPAIGN_LINE -->"),
        "the hero must carry the single-source pointer comment"
    );
    // The asymmetry, said plainly: the payer may be offline, the shop is online, and the
    // shop's connection settles it. (2026-08-23: the founder's wording pass c899c9a replaced
    // the old four-beat `id="proof"` strip with the "Paying offline" rail — the test follows
    // the founder's copy; these pins are its stable markers. 2026-08-24: one-press flow —
    // "Approve as always" became "Pay as always".)
    for required in [
        "Paying offline",
        "Pay as always",
        "The shop scans it with <b>their</b> phone",
        "The shop sends it for you",
        "The shop has internet. So you don't need any.",
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
    // 2026-08-25: the offline flow lives inside the QR card (the extra scan is a QR-only step —
    // an NFC tap carries the signed bundle in one gesture) and is FOLDED by default, since having
    // a signal is the common case. A fold nobody opens is a fold nobody reads, so the summary
    // must keep advertising itself in words — the animated cue is decoration that a
    // reduced-motion visitor never sees.
    assert!(
        html.contains("<details class=\"pw-offline\" aria-label=\"Paying offline\">"),
        "the offline flow must be a fold, named for assistive tech"
    );
    assert!(
        !html.contains("<details class=\"pw-offline\" aria-label=\"Paying offline\" open"),
        "the offline fold must start closed"
    );
    assert!(
        html.contains("See how you pay with no signal"),
        "the closed fold must say in TEXT what opening it gives you"
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
        assert!(!frag.is_empty(), "empty in-page link href=\"#\" is not a target");
        assert!(
            html.contains(&format!("id=\"{frag}\"")),
            "in-page link #{frag} points at no element with that id"
        );
        checked += 1;
    }
    // The nav's four section links + the two brandmark #top links; a drop below that means the
    // in-page navigation itself vanished, which the per-link assertions above cannot notice.
    assert!(checked >= 6, "expected the page's in-page links, found {checked}");
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
        assert!(html.contains(required), "the proof section must contain {required:?}");
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
    // solid red fill (differing in fill as well as hue, so it survives colour-blindness). The
    // dark-mode green MUST stay scoped to the holds state — unscoped, `html.dark .stamp` is
    // (0,2,1) and outranks the (0,2,0) tamper rule, which rendered a green border around the red
    // fill in dark mode until 2026-08-25.
    assert!(
        html.contains("html.dark [data-tamper=\"none\"] .stamp{--st:#34C48E}"),
        "the dark holds-green must stay state-scoped or it outranks the broken-red rule"
    );
    assert!(
        html.contains("--st:var(--badDeep);background:var(--badDeep);color:#FCF7F2;"),
        "the broken stamp must be a solid red fill, not just a recoloured outline"
    );
    // The claims the section exists to make.
    for required in [
        "not on the path",
        "Payments don't go through it at all",
        "It is never uploaded",
        "the network settles it exactly once",
    ] {
        assert!(html.contains(required), "the proof section must claim {required:?}");
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
    let etag = headers.get(header::ETAG).unwrap().to_str().unwrap().to_owned();
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
        status, StatusCode::OK,
        "a non-matching etag returns the full body"
    );
    assert_eq!(bytes, apk);
}

// --- currency catalog (M0) ---------------------------------------------------
//
// Covers GET /api/v1/currencies — the wallet's runtime asset catalog (closes issue #7). The
// FakeLedger reports a demo deployment: DEMO_USD (currency 0, $, mintable, no ramp) + a ckBTC-shaped
// currency (1, ₿, CkBtcUtxo ramp) + ckUSDC (2, ckUSDC, CkEthErc20 onramp) + ckUSDT (3, a second
// CkEthErc20 proving the onramp is per-token — MC8 U2) + ckDAI (4, an 18-dec CkEthErc20 — the
// precision-extreme fixture for OPEN_ISSUES #3). The wallet reads this once on load instead of
// hardcoding DEPOSIT_CURRENCY.

/// `GET /api/v1/currencies` returns `200 {"currencies": [...]}` with every registered currency's
/// ledger/minter/display metadata. Mirrors how the wallet consumes the catalog on load.
#[tokio::test]
async fn currencies_route_returns_demo_catalog() {
    let (state, _led) = state_from(ledger());

    let (status, body) = call(&state, get_req("/api/v1/currencies")).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let rows = body["currencies"].as_array().expect("currencies array");
    assert_eq!(
        rows.len(),
        7,
        "demo catalog = DEMO_USD + ckBTC + ckUSDC + ckUSDT + ckDAI + native-ETH + ckTESTBTC: {body}"
    );

    // DEMO_USD (currency 0): the mintable $ faucet asset, no ramp.
    let dusd = rows
        .iter()
        .find(|r| r["currency"] == 0)
        .expect("DEMO_USD present");
    assert_eq!(dusd["mintable"], true);
    assert_eq!(dusd["symbol"], "$");
    assert_eq!(dusd["decimals"], 2);
    assert_eq!(dusd["minter"], serde_json::Value::Null);
    assert_eq!(dusd["minter_family"], serde_json::Value::Null);
    assert!(
        !dusd["ledger"].as_str().unwrap().is_empty(),
        "ledger principal text present"
    );
    // MC1 unit 5: DEMO ramp honesty — onramp=Direct (faucet), offramp=Unavailable (no cash-out).
    assert_eq!(dusd["onramp"], "Direct");
    assert_eq!(dusd["offramp"], "Unavailable");

    // ckBTC-shaped (currency 1): the deposit/withdraw ramp asset — CkBtcUtxo family, ₿, 8 decimals.
    let ckbtc = rows
        .iter()
        .find(|r| r["currency"] == 1)
        .expect("ckBTC-shaped currency present");
    assert_eq!(ckbtc["mintable"], false);
    assert_eq!(ckbtc["symbol"], "₿");
    assert_eq!(ckbtc["decimals"], 8);
    // The variant serializes as the plain PascalCase tag (matches the candid label + wallet contract).
    assert_eq!(ckbtc["minter_family"], "CkBtcUtxo");
    assert!(
        !ckbtc["minter"].as_str().unwrap().is_empty(),
        "ramp minter principal text present"
    );
    // MC1 unit 5: authoritative per-currency metadata (no family-level assumption).
    assert_eq!(ckbtc["wrapper_name"], "ckBTC");
    assert_eq!(ckbtc["backing_symbol"], "BTC");
    assert_eq!(ckbtc["network"], "Bitcoin");
    assert_eq!(ckbtc["display_decimals"], 8);
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
    assert!(
        !ckusdc["minter"].as_str().unwrap().is_empty(),
        "ramp minter principal text present"
    );
    // MC1 unit 5: per-token ckERC20 facts (O6) replace the old hardcoded currency-2 params.
    assert_eq!(ckusdc["wrapper_name"], "ckUSDC");
    assert_eq!(ckusdc["backing_symbol"], "USDC");
    assert_eq!(ckusdc["network"], "Ethereum");
    assert_eq!(ckusdc["display_decimals"], 6);
    assert_eq!(ckusdc["fee"], "10000"); // ckUSDC icrc1_fee (O6): 0.01 USDC = 10000 raw
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
        ckusdc["gas_ledger"],
        "ss2fx-dyaaa-aaaar-qacoq-cai",
        "ckUSDC carries the ckETH gas ledger principal (withdraw_erc20 dual-ledger path)"
    );

    // MC8 U2 — ckUSDT (currency 3): a SECOND CkEthErc20 token proving the onramp is per-token.
    // Carries its OWN ERC-20 contract (real mainnet USDT, NOT USDC's address); same minter family +
    // chain. Ramp honesty mirrors ckUSDC: onramp=Direct, offramp=Unavailable (Fork-C — NO cash-out).
    let ckusdt = rows
        .iter()
        .find(|r| r["currency"] == 3)
        .expect("ckUSDT currency present");
    assert_eq!(ckusdt["mintable"], false);
    assert_eq!(ckusdt["symbol"], "ckUSDT");
    assert_eq!(ckusdt["decimals"], 6);
    assert_eq!(ckusdt["minter_family"], "CkEthErc20");
    assert_eq!(ckusdt["wrapper_name"], "ckUSDT");
    assert_eq!(ckusdt["backing_symbol"], "USDT");
    assert_eq!(ckusdt["network"], "Ethereum");
    assert_eq!(ckusdt["display_decimals"], 6);
    assert_eq!(ckusdt["chain_id"], 1); // Ethereum mainnet
    assert_eq!(
        ckusdt["token_contract"],
        "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    ); // real USDT
    assert_eq!(ckusdt["onramp"], "Direct");
    assert_eq!(ckusdt["offramp"], "Unavailable"); // cash-out not yet wired (only ckUSDC) — Fork-C gate
    assert_eq!(
        ckusdt["gas_ledger"],
        "ss2fx-dyaaa-aaaar-qacoq-cai",
        "ckUSDT carries the shared ckETH gas ledger (one gas ledger serves every ckERC20)"
    );

    // OPEN_ISSUES #3 — ckDAI (currency 4): an 18-dec CkEthErc20, the precision-extreme fixture. Same
    // minter family + chain as ckUSDC/ckUSDT; only `decimals`/`display_decimals`/`token_contract`/
    // display metadata differ (18 dec mirrors native DAI). Ramp honesty mirrors the other ckERC20s:
    // onramp=Direct, offramp=Unavailable (Fork-C — NO cash-out).
    let ckdai = rows
        .iter()
        .find(|r| r["currency"] == 4)
        .expect("ckDAI currency present");
    assert_eq!(ckdai["mintable"], false);
    assert_eq!(ckdai["symbol"], "ckDAI");
    assert_eq!(ckdai["decimals"], 18);
    assert_eq!(ckdai["display_decimals"], 18);
    assert_eq!(ckdai["minter_family"], "CkEthErc20");
    assert_eq!(ckdai["wrapper_name"], "ckDAI");
    assert_eq!(ckdai["backing_symbol"], "DAI");
    assert_eq!(ckdai["network"], "Ethereum");
    assert_eq!(ckdai["chain_id"], 1); // Ethereum mainnet
    assert_eq!(ckdai["fee"], "10000000000000000"); // 0.01 DAI at 18 dec = 1e16 raw
    assert_eq!(
        ckdai["token_contract"],
        "0x6B175474E89094C44Da98b954EedeAC495271d0F"
    ); // real DAI ERC-20
    assert_eq!(ckdai["onramp"], "Direct");
    assert_eq!(ckdai["offramp"], "Unavailable"); // cash-out not yet wired (only ckUSDC) — Fork-C gate
    assert_eq!(
        ckdai["gas_ledger"],
        "ss2fx-dyaaa-aaaar-qacoq-cai",
        "ckDAI carries the shared ckETH gas ledger (one gas ledger serves every ckERC20)"
    );

    // Native ckETH (currency 5): a CkEthErc20-family currency with `token_contract == None`, the
    // discriminator that selects the native-ETH deposit/withdraw path (depositEth / withdraw_eth)
    // instead of the ERC-20 path. This is the catalog entry the native-ETH withdraw e2e (flow 44)
    // drives. Ramp honesty: onramp=Direct (single payable depositEth tx), offramp=Direct
    // (withdraw_eth — the Cash-out button renders; the no-swap Unavailable gate stays closed for the
    // ERC-20 tokens above). 18-dec Wei, same ckETH minter + chain as the ckERC20 entries.
    let cketh = rows
        .iter()
        .find(|r| r["currency"] == 5)
        .expect("native ckETH currency present");
    assert_eq!(cketh["mintable"], false);
    assert_eq!(cketh["symbol"], "Ξ");
    assert_eq!(cketh["decimals"], 18);
    assert_eq!(cketh["display_decimals"], 6); // matches prod ckETH (truncation path, commit c74988b)
    assert_eq!(cketh["minter_family"], "CkEthErc20");
    assert_eq!(cketh["wrapper_name"], "ckETH");
    assert_eq!(cketh["backing_symbol"], "ETH");
    assert_eq!(cketh["network"], "Ethereum");
    assert_eq!(cketh["chain_id"], 1); // Ethereum mainnet
    assert_eq!(cketh["fee"], "10000000000000000"); // 0.01 ETH at 18 dec = 1e16 raw
    assert_eq!(cketh["cap"], "100000");
    // THE KEY FIELD: token_contract must be null so the app treats this as native ETH (not ERC-20).
    assert_eq!(cketh["token_contract"], serde_json::Value::Null);
    // Native ckETH carries NO separate gas_ledger: the withdraw_eth single-ledger path approves
    // amount+fee on ckETH's OWN ledger, so the field is null (distinct from a ckERC20 whose gas
    // ledger IS the ckETH ledger). This null also keeps native ETH out of the dual-ledger path.
    assert_eq!(cketh["gas_ledger"], serde_json::Value::Null);
    assert_eq!(cketh["onramp"], "Direct"); // ckETH helper depositEth (single payable tx)
    assert_eq!(cketh["offramp"], "Direct"); // withdraw_eth — Cash-out button renders
}

// --- batch balances (the N+1→1 poll fix) --------------------------------------
//
// Covers GET /api/v1/balances/{hex} (PLURAL) — the single-fetch batch endpoint that returns EVERY
// currency's balance in one response, replacing the wallet's old N+1 per-poll loop (1 primary fetch
// + 1 per-asset fetch, each a relay→IC round trip). With the 6-currency demo catalog this is 1 HTTP request
// instead of 6. Response shape: a flat map `{<currency>: <minor-units-string>}`, currency index as a
// decimal-string key, balance as a U64String (decimal string). Mirrors how the wallet consumes it.

/// `GET /api/v1/balances/{hex}` returns `200` with a flat map of EVERY catalog currency's balance in
/// ONE response. The payer is funded BAL_A in DEMO_USD (currency 0); every other catalog currency is
/// unfunded → "0". Asserts: all 6 catalog currencies present, the funded primary reads BAL_A, the
/// unfunded assets read "0", and the values are DECIMAL STRINGS (the MC1 units 2-4 shape — raw u64
/// across the JSON boundary as a string, never a number).
#[tokio::test]
async fn balances_route_returns_all_currencies_in_one_response() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger());

    let (status, body) =
        call(&state, get_req(&format!("/api/v1/balances/{}", hex::encode(pubkey(&payer))))).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A flat map (not wrapped under a key) — every catalog currency is a top-level entry.
    assert!(body.is_object(), "balances response is a JSON object: {body}");
    assert_eq!(
        body.as_object().unwrap().len(),
        7,
        "demo catalog = 7 currencies, all present in one batch: {body}"
    );

    // Every catalog currency is present and unfunded → "0" (nothing pre-funds the
    // FakeLedger anymore — balances live at user principals on the fake-IC gateway).
    for c in 0..=6u32 {
        assert_eq!(
            body[c.to_string()], "0",
            "currency {c} present + unfunded (FakeLedger default 0): {body}"
        );
    }

    // A SECOND account (the merchant, also unfunded in DEMO_USD per the test ledger) reads all-zero
    // across the batch — proves the map is account-specific, not a constant.
    let (status_m, body_m) = call(
        &state,
        get_req(&format!("/api/v1/balances/{}", hex::encode(pubkey(&merchant)))),
    )
    .await;
    assert_eq!(status_m, StatusCode::OK, "{body_m}");
    assert_eq!(body_m["0"], "0", "merchant primary unfunded: {body_m}");
}

/// The settlement-era routes stay DEAD (2026-08-19 cutover): everything value-bearing left the
/// relay for the app's own signed /api/v2 envelopes. This pins the tombstone — a reintroduced
/// route here would silently put the relay back in the value path. Note /api/v1/faucet and
/// /api/v1/balance/{hex} legitimately exist under test-helpers (fixture routes, separately
/// tested); everything below must 404 in EVERY build.
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
    ];
    for path in gone {
        // call_raw, not call: a 404 carries no JSON body to parse.
        let (status, _h, _b) = call_raw(&state, get_req(path)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path} must stay 404");
    }
}

/// A bad account (not 32 bytes hex) is a clean `400` — matches the single `/balance` endpoint's
/// parsing contract (the batch route shares the same hex-decode path).
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
/// every future ckERC20 (ckUSDT, ckETH, …) inherited ckUSDC's address or got a 503. U2 resolves the
/// currency descriptor from the catalog and reads the per-token `token_contract` instead, so:
///   - ckUSDC (currency 2) → the USDC ERC-20 address (NO regression).
///   - ckUSDT (currency 3) → the USDT ERC-20 address (NOT USDC — proves token-specificity).
///   - ckBTC (1) / DEMO (0) → 503 (not a CkEthErc20 family currency).
///
/// The `helper_address` is minter-scoped (ONE verified mainnet constant for ALL ckERC20 tokens) and
/// stays unchanged; only the `erc20_address` source moves to the catalog.
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

    // ckUSDT (currency 3) → 200 with the USDT ERC-20 address — NOT the USDC address. This is the
    // token-specificity proof: a second ckERC20 reads ITS OWN `token_contract` from the catalog.
    let (s_usdt, body_usdt) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=3")).await;
    assert_eq!(s_usdt, StatusCode::OK, "{body_usdt}");
    assert_eq!(
        body_usdt["helper_address"],
        "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68"
    );
    assert_eq!(
        body_usdt["erc20_address"],
        "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    );
    assert_ne!(
        body_usdt["erc20_address"], body_usdc["erc20_address"],
        "ckUSDT must NOT inherit ckUSDC's ERC-20 address",
    );

    // ckBTC (currency 1) → 503: CkBtcUtxo family, not CkEthErc20 — no ckERC-20 onramp.
    let (s_btc, _body_btc) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=1")).await;
    assert_eq!(s_btc, StatusCode::SERVICE_UNAVAILABLE);

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
        fee: None,
        cap: None,
        chain_id: Some(1),
        token_contract: None, // ← native ETH (not a partial ERC-20 registration)
        gas_ledger: None,
        onramp: dpay_relay::RampCapability::Direct,
        offramp: dpay_relay::RampCapability::Direct,
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
        ledger: "2vxsx-fae".to_string(),
        mintable: false,
        minter: Some("mqygn-kiaaa-aaaar-qaadq-cai".to_string()),
        minter_family: Some(dpay_relay::MinterFamily::CkBtcUtxo),
        symbol: Some("₿".into()),
        decimals: Some(8),
        wrapper_name: Some("ckBTC".into()),
        backing_symbol: Some("BTC".into()),
        network: Some("Bitcoin".into()),
        display_decimals: Some(8),
        fee: None,
        cap: None,
        chain_id: None,
        token_contract: None,
        gas_ledger: None,
        onramp: dpay_relay::RampCapability::Direct,
        offramp: dpay_relay::RampCapability::Direct,
    };
    assert!(
        dpay_relay::ckerc20_onramp_from_descriptor(Some(&ckbtc)).is_err()
    );
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
        fee: None,
        cap: None,
        chain_id: Some(11155111), // Sepolia
        token_contract: Some("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".into()),
        gas_ledger: None,
        onramp: dpay_relay::RampCapability::Direct,
        offramp: dpay_relay::RampCapability::Unavailable,
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
    assert_eq!(r_sep.kind, "erc20", "a token_contract=Some discriminates erc20");

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
    assert_eq!(r_main.kind, "erc20", "mainnet ERC-20 still discriminates erc20");

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
    assert!(html.contains("id=\"root\""), "/wallet must carry the React root");
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
        assert!(!html.contains(stale), "/wallet must not contain stale marker {stale}");
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
        headers.get(header::CACHE_CONTROL).map(|v| v.to_str().unwrap()),
        Some("public, max-age=31536000, immutable"),
        "hashed assets must be immutable (the hash IS the version)"
    );
    assert!(!bytes.is_empty(), "the entry bundle must have a body");
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
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "application/wasm");
    assert!(bytes.len() > 4, "the wasm body must not be empty");
    assert_eq!(&bytes[..4], b"\0asm", "must start with the wasm magic bytes");

    // No catch-all: a near-miss asset path is a clean 404.
    let (status, _h, _b) = call_raw(&state, get_req("/dpay-core.wasi")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "unknown wasm-ish path must 404");
}
