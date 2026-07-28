//! End-to-end relay tests — the fast, in-memory inner loop. No socket is bound: we drive the
//! axum `Router` directly with `tower::ServiceExt::oneshot`, and pin the clock so expiry is
//! deterministic.
//!
//! Covered:
//! - valid pay → 200, receipt correct, balances moved;
//! - duplicate nonce → 200, identical receipt, merchant credited only once;
//! - bad signature / expired / over-cap / insufficient funds → 422 each, no state change;
//! - health → 200;
//! - transient-then-success (FlakyLedger) → eventually 200.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt; // oneshot

use dpay_core::{Authorization, SignedAuthorization, DEMO_USD};
use dpay_relay::{app, AppState, FakeLedger, FixedClock, FlakyLedger};
use ed25519_dalek::SigningKey;

// A fixed "now" and an expiry comfortably ahead of it, so valid auths don't expire.
const NOW: u64 = 1_700_000_000;
const FUTURE: u64 = NOW + 120;

const CAP: u64 = 1_000; // per-transaction cap (minor units)
const BAL_A: u64 = 5_000; // payer opening balance
const BAL_B: u64 = 0; // merchant opening balance

// --- helpers -------------------------------------------------------------

fn keypair() -> SigningKey {
    dpay_core::generate_keypair()
}

fn pubkey(sk: &SigningKey) -> [u8; 32] {
    sk.verifying_key().to_bytes()
}

/// A FakeLedger pinned to NOW, funding `a`→BAL_A and `b`→BAL_B, cap = CAP.
fn ledger(a: [u8; 32], b: [u8; 32]) -> FakeLedger {
    FakeLedger::with_clock(a, BAL_A, b, BAL_B, CAP, Box::new(FixedClock(NOW)))
}

fn state_from(ledger: FakeLedger) -> (AppState, Arc<FakeLedger>) {
    let arc = Arc::new(ledger);
    (AppState::new(arc.clone()), arc)
}

fn signed(sk: &SigningKey, to: [u8; 32], amount: u64, nonce: [u8; 16], expiry: u64) -> SignedAuthorization {
    let auth = Authorization {
        from: pubkey(sk),
        to,
        amount,
        nonce,
        expiry,
        currency: DEMO_USD,
    };
    SignedAuthorization::new(sk, auth)
}

/// POST /api/v1/pay with a JSON `{"qr": ...}` body.
fn pay_json(qr: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/v1/pay")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!("{{\"qr\":\"{qr}\"}}")))
        .unwrap()
}

/// POST /api/v1/pay with a raw wire-bytes body.
fn pay_wire(wire: &[u8]) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/v1/pay")
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(wire.to_vec()))
        .unwrap()
}

/// POST /api/v1/faucet — the demo on-ramp, which mints. Gated by `AppState::set_faucet_enabled`.
fn faucet_json(account_hex: &str, amount: u64) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/v1/faucet")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(
            "{{\"account\":\"{account_hex}\",\"amount\":{amount}}}"
        )))
        .unwrap()
}

/// GET /api/v1/receipt/{nonce_hex} — the idempotent reconciliation lookup the merchant app falls
/// back to when a /api/v1/pay response is lost, so a settled payment is never reported as failed.
fn get_receipt(nonce: [u8; 16]) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(format!("/api/v1/receipt/{}", hex::encode(nonce)))
        .body(Body::empty())
        .unwrap()
}

async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

/// A bare GET request — for the non-JSON pages (landing, merchant, APK).
fn get_req(uri: &str) -> Request<Body> {
    Request::builder().method("GET").uri(uri).body(Body::empty()).unwrap()
}

/// Like `call`, but returns the raw status/headers/bytes (the pages aren't JSON).
async fn call_raw(state: &AppState, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let resp = app(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, bytes)
}

// --- tests ---------------------------------------------------------------

#[tokio::test]
async fn valid_pay_moves_funds() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let sa = signed(&payer, pubkey(&merchant), 250, [1u8; 16], FUTURE);
    let (status, body) = call(&state, pay_json(&sa.encode())).await;

    assert_eq!(status, StatusCode::OK, "body={body}");
    let r = &body["receipt"];
    assert_eq!(r["amount"], 250);
    assert_eq!(r["from"], hex::encode(pubkey(&payer)));
    assert_eq!(r["to"], hex::encode(pubkey(&merchant)));
    assert_eq!(r["nonce"], hex::encode([1u8; 16]));
    assert_eq!(r["new_from_balance"], BAL_A - 250);

    // Balances actually moved on the ledger.
    assert_eq!(led.balance_of(&pubkey(&payer), DEMO_USD), BAL_A - 250);
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B + 250);
}

#[tokio::test]
async fn raw_wire_body_also_works() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let sa = signed(&payer, pubkey(&merchant), 100, [2u8; 16], FUTURE);
    let (status, body) = call(&state, pay_wire(&sa.to_wire())).await;

    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["receipt"]["amount"], 100);
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), 100);
}

#[tokio::test]
async fn duplicate_nonce_is_idempotent_and_credits_once() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let sa = signed(&payer, pubkey(&merchant), 400, [7u8; 16], FUTURE);

    // First submission settles.
    let (s1, b1) = call(&state, pay_json(&sa.encode())).await;
    assert_eq!(s1, StatusCode::OK);

    // Second submission of the SAME nonce: 200, identical receipt, flagged as a replay, no re-settle.
    let (s2, b2) = call(&state, pay_json(&sa.encode())).await;
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(b1["receipt"], b2["receipt"], "duplicate must return identical receipt");
    assert_eq!(b1["replayed"], serde_json::json!(false), "first settle is not a replay");
    assert_eq!(b2["replayed"], serde_json::json!(true), "duplicate is flagged as a replay");

    // Merchant credited exactly once; payer debited exactly once.
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), 400, "credited once only");
    assert_eq!(led.balance_of(&pubkey(&payer), DEMO_USD), BAL_A - 400, "debited once only");
}

/// Reconciliation contract the merchant app depends on: once a payment settles, its nonce is
/// retrievable via GET /api/v1/receipt/{nonce} with the identical receipt — so a merchant whose
/// /api/v1/pay response was lost (network drop after commit) can confirm it settled instead of reporting a
/// false failure. Also proves an unsettled nonce is a clean 404 (not settled), never a false 200.
#[tokio::test]
async fn settled_receipt_is_retrievable_by_nonce_for_reconciliation() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    let nonce = [42u8; 16];

    // Before settlement: the merchant's reconciliation lookup must say "not settled" (404), so an
    // in-flight-but-not-yet-committed payment is never mistaken for a completed one.
    let (pre, _b) = call(&state, get_receipt(nonce)).await;
    assert_eq!(pre, StatusCode::NOT_FOUND);

    // Settle.
    let sa = signed(&payer, pubkey(&merchant), 250, nonce, FUTURE);
    let (s1, b1) = call(&state, pay_json(&sa.encode())).await;
    assert_eq!(s1, StatusCode::OK);

    // Now the same nonce reconciles to the identical receipt, flagged as a replay (already settled).
    let (s2, b2) = call(&state, get_receipt(nonce)).await;
    assert_eq!(s2, StatusCode::OK, "settled nonce must be retrievable: {b2}");
    assert_eq!(b2["receipt"], b1["receipt"], "reconciled receipt is identical to the settle receipt");
    assert_eq!(b2["replayed"], serde_json::json!(true));
}

#[tokio::test]
async fn bad_signature_rejected_422_no_state_change() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // Build a valid signed auth, then corrupt the signature bytes in the wire form. The 196-byte
    // wire is `signing(100) | sig(64) | from_pub(32)`, so byte[100] is the first signature byte.
    let sa = signed(&payer, pubkey(&merchant), 100, [3u8; 16], FUTURE);
    let mut wire = sa.to_wire();
    wire[100] ^= 0xFF; // flip a byte inside the 64-byte signature

    let (status, body) = call(&state, pay_wire(&wire)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["error"].as_str().unwrap().contains("BadSignature"),
        "error={body}"
    );

    // Nothing moved.
    assert_eq!(led.balance_of(&pubkey(&payer), DEMO_USD), BAL_A);
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B);
}

#[tokio::test]
async fn expired_rejected_422() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // expiry == NOW → `now >= expiry` → Expired.
    let sa = signed(&payer, pubkey(&merchant), 100, [4u8; 16], NOW);
    let (status, body) = call(&state, pay_json(&sa.encode())).await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["error"].as_str().unwrap().contains("Expired"), "error={body}");
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B);
}

#[tokio::test]
async fn over_cap_rejected_422() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // amount > CAP but <= balance → OverCap (validate checks cap before balance).
    let sa = signed(&payer, pubkey(&merchant), CAP + 1, [5u8; 16], FUTURE);
    let (status, body) = call(&state, pay_json(&sa.encode())).await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["error"].as_str().unwrap().contains("OverCap"), "error={body}");
    assert_eq!(led.balance_of(&pubkey(&payer), DEMO_USD), BAL_A);
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B);
}

#[tokio::test]
async fn insufficient_funds_rejected_422() {
    let payer = keypair();
    let merchant = keypair();
    // Give the payer a balance BELOW the cap so an amount can exceed balance without hitting cap.
    let led = FakeLedger::with_clock(
        pubkey(&payer),
        200, // balance
        pubkey(&merchant),
        0,
        CAP, // cap 1000
        Box::new(FixedClock(NOW)),
    );
    let (state, ledarc) = state_from(led);

    // 500: <= cap(1000) but > balance(200) → InsufficientFunds.
    let sa = signed(&payer, pubkey(&merchant), 500, [6u8; 16], FUTURE);
    let (status, body) = call(&state, pay_json(&sa.encode())).await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["error"].as_str().unwrap().contains("InsufficientFunds"),
        "error={body}"
    );
    assert_eq!(ledarc.balance_of(&pubkey(&payer), DEMO_USD), 200);
    assert_eq!(ledarc.balance_of(&pubkey(&merchant), DEMO_USD), 0);
}

#[tokio::test]
async fn health_ok() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let req = Request::builder()
        .method("GET")
        .uri("/api/v1/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

/// The faucet MINTS, and the canister's `mint` is unauthenticated — so on any real ledger the relay
/// disables it. Disabled means the route is *gone* (404) and, crucially, no money is created.
#[tokio::test]
async fn faucet_disabled_mints_nothing() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    state.set_faucet_enabled(false);

    let (status, body) = call(&state, faucet_json(&hex::encode(pubkey(&merchant)), 999)).await;

    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        led.balance_of(&pubkey(&merchant), DEMO_USD),
        BAL_B,
        "a disabled faucet must not create funds"
    );
}

/// …and enabled (the demo default) it still works, so the demo on-ramp is unaffected.
#[tokio::test]
async fn faucet_enabled_mints() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let (status, body) = call(&state, faucet_json(&hex::encode(pubkey(&merchant)), 999)).await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["balance"], BAL_B + 999);
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B + 999);
}

#[tokio::test]
async fn transient_then_success_retries_to_200() {
    let payer = keypair();
    let merchant = keypair();

    // Fail the first 2 pay() calls transiently; the relay's 3-attempt retry means attempt #3
    // (the delegate) succeeds.
    let base = ledger(pubkey(&payer), pubkey(&merchant));
    let flaky = FlakyLedger::new(base, 2);
    let state = AppState::new(Arc::new(flaky));

    let sa = signed(&payer, pubkey(&merchant), 300, [8u8; 16], FUTURE);
    let (status, body) = call(&state, pay_json(&sa.encode())).await;

    assert_eq!(status, StatusCode::OK, "should have retried through transients: {body}");
    assert_eq!(body["receipt"]["amount"], 300);
    assert_eq!(body["receipt"]["new_from_balance"], BAL_A - 300);
}

#[tokio::test]
async fn transient_exhausted_returns_503() {
    let payer = keypair();
    let merchant = keypair();

    // Fail more times than we retry → never settles → 503, and no state change.
    let base = ledger(pubkey(&payer), pubkey(&merchant));
    let flaky = Arc::new(FlakyLedger::new(base, 10));
    let state = AppState::new(flaky);

    let sa = signed(&payer, pubkey(&merchant), 300, [9u8; 16], FUTURE);
    let (status, _body) = call(&state, pay_json(&sa.encode())).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn malformed_qr_rejected_422() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let (status, body) = call(&state, pay_json("not-valid-base64url!!!")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["error"].as_str().unwrap().contains("qr"), "error={body}");
}

// --- landing page + APK download (the public root) -----------------------

/// With no APK configured (the default), `GET /` serves the landing page with the placeholder
/// resolved to the disabled "coming soon" chip — never the literal `{{DOWNLOAD}}` token, and no
/// download link that would 404.
#[tokio::test]
async fn landing_page_without_apk_shows_coming_soon() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let (status, headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "text/html; charset=utf-8");
    let html = String::from_utf8(bytes).unwrap();
    // The exact injected disabled chip (the `.btn-disabled` CSS class always exists in the sheet,
    // so match on the injected copy, which is unique to the None branch).
    assert!(
        html.contains("<span class=\"btn btn-disabled\">Android build coming soon</span>"),
        "disabled CTA missing"
    );
    assert!(!html.contains("{{DOWNLOAD}}"), "placeholder must be substituted");
    assert!(!html.contains("href=\"/download/dpay.apk\""), "no live download link without an APK");
}

/// With an APK configured, `GET /` swaps the placeholder for a live download button carrying the
/// build's rounded size, and drops the disabled chip. A tiny build still reads "1 MB" (min floor).
#[tokio::test]
async fn landing_page_with_apk_shows_download_button() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    let state = state.with_apk(Some(vec![0u8; 100])); // <0.5 MB → rounds to the 1 MB floor

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();
    assert!(html.contains("href=\"/download/dpay.apk?v="), "download link missing");
    assert!(html.contains("APK · 1 MB"), "rounded size (min 1 MB) missing");
    assert!(!html.contains("Android build coming soon"), "must not show the disabled chip");
    assert!(!html.contains("{{DOWNLOAD}}"), "placeholder must be substituted");
}

/// The landing page embeds the three real app screenshots (served from `/shots/…`), so a QR-bearing
/// screen appears where the old faux barcode used to be.
#[tokio::test]
async fn landing_page_embeds_app_screenshots() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let (status, _headers, bytes) = call_raw(&state, get_req("/")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(bytes).unwrap();
    for shot in ["/shots/request.png", "/shots/approve.png", "/shots/paid.png"] {
        assert!(html.contains(shot), "landing page must reference {shot}");
    }
}

/// Each known screenshot name serves a real PNG; an unknown name is a clean 404, never a 200 with
/// an empty body.
#[tokio::test]
async fn screenshots_served_as_png_and_unknown_is_404() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let names = [
        "request.png",
        "approve.png",
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
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "{name} must be a PNG");
    }

    let (status, _h, _b) = call_raw(&state, get_req("/shots/nope.png")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "unknown screenshot must 404");
}

/// The merchant terminal moved off `/` to `/merchant`; `/` is now the landing page.
#[tokio::test]
async fn merchant_terminal_served_at_merchant_not_root() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let (ms, mh, mbytes) = call_raw(&state, get_req("/merchant")).await;
    assert_eq!(ms, StatusCode::OK);
    assert_eq!(mh.get(header::CONTENT_TYPE).unwrap(), "text/html; charset=utf-8");
    let merch = String::from_utf8(mbytes).unwrap();
    // `id="merchId"` is unique to the merchant terminal (the landing page shares the words
    // "Merchant terminal" in its nav link, so match on the terminal-only element instead).
    assert!(merch.contains("id=\"merchId\""), "/merchant must serve the terminal");

    // The root is the landing page, not the terminal.
    let (_rs, _rh, rbytes) = call_raw(&state, get_req("/")).await;
    let root = String::from_utf8(rbytes).unwrap();
    assert!(!root.contains("id=\"merchId\""), "root must not be the merchant terminal");
}

/// Without a configured APK the download route is a clean 404 — not an empty 200.
#[tokio::test]
async fn apk_download_absent_is_404() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let (status, _headers, bytes) = call_raw(&state, get_req("/download/dpay.apk")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(String::from_utf8(bytes).unwrap(), "no build available");
}

/// With an APK configured the route serves the exact bytes as an APK attachment.
#[tokio::test]
async fn apk_download_serves_configured_bytes() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
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
    assert_eq!(bytes, apk, "served bytes must match the configured build verbatim");
}
