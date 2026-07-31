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

use async_trait::async_trait;

use dpay_core::{Authorization, Currency, SignedAuthorization, DEMO_USD};
use dpay_relay::{
    app, AppState, DepositInfo, DepositRefresh, FakeLedger, FixedClock, FlakyLedger, Ledger,
    LedgerError, Receipt, TxnRecord,
};
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
        // No display names / memo on the legacy test auths (empty buffers == empty strings in history).
        from_name: [0u8; 32],
        to_name: [0u8; 32],
        memo: [0u8; 32],
    };
    SignedAuthorization::new(sk, auth)
}

/// Like [`signed`] but also sets the payer's `from_name`, the payee's `to_name`, and the `memo` on
/// the authorization (NUL-padded to 32 bytes, mirroring what the app builder does before signing).
/// Used to prove the names ride inside the signed wire through the relay into history (N6/H3).
fn signed_named(
    sk: &SigningKey,
    to: [u8; 32],
    amount: u64,
    nonce: [u8; 16],
    expiry: u64,
    from_name: &str,
    to_name: &str,
    memo: &str,
) -> SignedAuthorization {
    let mut fn_buf = [0u8; 32];
    let n = from_name.len().min(32);
    fn_buf[..n].copy_from_slice(&from_name.as_bytes()[..n]);
    let mut tn_buf = [0u8; 32];
    let n = to_name.len().min(32);
    tn_buf[..n].copy_from_slice(&to_name.as_bytes()[..n]);
    let mut m_buf = [0u8; 32];
    let n = memo.len().min(32);
    m_buf[..n].copy_from_slice(&memo.as_bytes()[..n]);
    let auth = Authorization {
        from: pubkey(sk),
        to,
        amount,
        nonce,
        expiry,
        currency: DEMO_USD,
        from_name: fn_buf,
        to_name: tn_buf,
        memo: m_buf,
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

/// R2: a settled pay returns a CANISTER/LEDGER-SIGNED receipt (FakeLedger signs with its stable test
/// key) whose Ed25519 signature verifies under the receipt's embedded `pubkey` (== the ledger's
/// `receipt_pubkey`). The app does exactly this before showing "Paid ✓". Tampering the amount breaks
/// verification. Proves the receipt-verification wiring through the real axum router.
#[tokio::test]
async fn pay_returns_signed_receipt_that_verifies() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let sa = signed(&payer, pubkey(&merchant), 250, [3u8; 16], FUTURE);
    let (status, body) = call(&state, pay_json(&sa.encode())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let r = &body["receipt"];
    assert_eq!(r["amount"], 250);

    // The receipt carries the hex sig + pubkey + the claim fields (block_index/settle_ts/currency).
    let sig_hex = r["receipt_sig"].as_str().expect("receipt_sig present");
    let pub_hex = r["pubkey"].as_str().expect("pubkey present");
    let sig = hex::decode(sig_hex).unwrap();
    let pk = hex::decode(pub_hex).unwrap();
    assert_eq!(sig.len(), 64, "64-byte Ed25519 sig");
    assert_eq!(pk.len(), 32, "32-byte pubkey");

    // The ledger's receipt_pubkey matches the pubkey embedded in the receipt (cross-check).
    let ledger_pk = led.receipt_pubkey().await.unwrap();
    assert_eq!(ledger_pk, pk);

    // Verify the signature over the canonical ReceiptClaim built from the receipt's fields.
    let mut pkb = [0u8; 32];
    pkb.copy_from_slice(&pk);
    let mut sgb = [0u8; 64];
    sgb.copy_from_slice(&sig);
    let claim = dpay_core::ReceiptClaim {
        nonce: [3u8; 16],
        from: pubkey(&payer),
        to: pubkey(&merchant),
        amount: 250,
        currency: DEMO_USD,
        block_index: r["block_index"].as_u64().unwrap(),
        settle_ts: r["settle_ts"].as_u64().unwrap(),
    };
    assert!(
        dpay_core::verify_receipt(&pkb, &claim, &sgb),
        "FakeLedger receipt signature must verify under its pubkey"
    );

    // Tampering the amount (a lying merchant) breaks verification.
    let mut tampered = claim;
    tampered.amount = 251;
    assert!(!dpay_core::verify_receipt(&pkb, &tampered, &sgb), "tampered amount must fail verify");
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

    // Build a valid signed auth, then corrupt bytes in the wire form. The 292-byte wire is
    // `signing(196) | sig(64) | from_pub(32)`; byte[100] falls inside the signing region (the
    // from_name field), so flipping it breaks the signature the verifier recomputes.
    let sa = signed(&payer, pubkey(&merchant), 100, [3u8; 16], FUTURE);
    let mut wire = sa.to_wire();
    wire[100] ^= 0xFF; // flip a byte inside the signing region (breaks the recomputed signature)

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

/// `GET /api/v1/version` reports the relay's name + pkg version + the git commit baked by `build.rs`.
/// The commit is the deploy-fidelity primitive (verify-relay-version.sh compares it to HEAD); this
/// test pins the route's shape + that the commit is present (non-empty), so a future change that
/// drops the build.rs wiring surfaces here.
#[tokio::test]
async fn version_route_reports_baked_commit() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let (status, body) = call(&state, get_req("/api/v1/version")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "dpay-relay");
    // The pkg version is a non-empty string (CARGO_PKG_VERSION); don't pin the exact number so a
    // bump doesn't break this test, just assert it's present.
    assert!(body["version"].as_str().unwrap_or("").len() > 0, "version present: {body}");
    let commit = body["commit"].as_str().expect("commit present");
    // The baked commit is either a 40-char SHA (a git checkout) or the "unknown" fallback (no git).
    // In the test build (run from the repo) it MUST be a real SHA — proves build.rs wired through.
    assert!(
        commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit()),
        "commit must be a 40-char SHA when built in a git checkout, got {commit:?}"
    );
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

// --- transaction history ---------------------------------------------------

/// `GET /api/v1/transactions/{hex}` returns the wallet's durable transaction list, sourced from the
/// ledger (not an ephemeral UI state). Settled payments appear newest-first with enough fields to
/// derive direction (compare the queried account to `from`). Rejected payments don't appear.
#[tokio::test]
async fn transactions_endpoint_returns_history_newest_first() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // Two payer -> merchant payments, in sequence.
    let sa1 = signed(&payer, pubkey(&merchant), 250, [1u8; 16], FUTURE);
    let (s1, _b1) = call(&state, pay_json(&sa1.encode())).await;
    assert_eq!(s1, StatusCode::OK);
    let sa2 = signed(&payer, pubkey(&merchant), 100, [2u8; 16], FUTURE);
    let (s2, _b2) = call(&state, pay_json(&sa2.encode())).await;
    assert_eq!(s2, StatusCode::OK);

    let payer_hex = hex::encode(pubkey(&payer));
    let merch_hex = hex::encode(pubkey(&merchant));

    // Payer's history: newest-first => the $1.00 outgoing, then the $2.50 outgoing. `from == payer`
    // for both (outgoing); direction is derivable from the from/to fields.
    let (status, body) = call(&state, get_req(&format!("/api/v1/transactions/{payer_hex}"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = body["transactions"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "both payments recorded: {body}");
    assert_eq!(rows[0]["amount"], 100, "newest first: {body}");
    assert_eq!(rows[0]["from"], payer_hex);
    assert_eq!(rows[0]["to"], merch_hex);
    assert_eq!(rows[0]["nonce"], hex::encode([2u8; 16]));
    assert_eq!(rows[0]["currency"], 0); // DEMO_USD
    assert_eq!(rows[1]["amount"], 250);
    assert_eq!(rows[1]["nonce"], hex::encode([1u8; 16]));

    // Merchant sees the same two as incoming (from == payer).
    let (m_status, m_body) = call(&state, get_req(&format!("/api/v1/transactions/{merch_hex}"))).await;
    assert_eq!(m_status, StatusCode::OK, "{m_body}");
    let m_rows = m_body["transactions"].as_array().unwrap();
    assert_eq!(m_rows.len(), 2);
    assert_eq!(m_rows[0]["from"], payer_hex, "incoming: from == payer");
    assert_eq!(m_rows[0]["to"], merch_hex);

    // limit is honored.
    let (l_status, l_body) =
        call(&state, get_req(&format!("/api/v1/transactions/{payer_hex}?limit=1"))).await;
    assert_eq!(l_status, StatusCode::OK, "{l_body}");
    assert_eq!(l_body["transactions"].as_array().unwrap().len(), 1);

    // A bad pubkey (not 32 bytes hex) is a clean 400, not a 500.
    let (bad_status, _bad_body) = call(&state, get_req("/api/v1/transactions/deadbeef")).await;
    assert_eq!(bad_status, StatusCode::BAD_REQUEST);
}

/// N6/H3: display names + memo ride inside the SIGNED wire into the relay's history, so the wallet
/// renders friendly counterparties instead of raw pubkeys. Pays "Alice" → "Bob" with memo "coffee"
/// through the real `/api/v1/pay` route, then asserts `/api/v1/transactions/{hex}` carries the
/// decoded `from_name`/`to_name`/`memo` strings on BOTH sides (payer's outgoing + payee's incoming).
/// Also proves a names-less legacy auth (`signed`) yields empty strings (no crash, no leaked bytes).
#[tokio::test]
async fn names_and_memo_flow_from_signed_wire_into_history() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // A named payment: Alice pays Bob with memo "coffee".
    let sa_named = signed_named(
        &payer,
        pubkey(&merchant),
        250,
        [42u8; 16],
        FUTURE,
        "Alice",
        "Bob",
        "coffee",
    );
    let (status, body) = call(&state, pay_json(&sa_named.encode())).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A legacy (names-less) payment right after, so the same history has a mixed row to disambiguate.
    let sa_plain = signed(&payer, pubkey(&merchant), 100, [43u8; 16], FUTURE);
    let (status, body) = call(&state, pay_json(&sa_plain.encode())).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let payer_hex = hex::encode(pubkey(&payer));
    let merch_hex = hex::encode(pubkey(&merchant));

    // Payer's outgoing history: newest-first => the names-less $1.00 row, then the named $2.50 row.
    let (s, body) = call(&state, get_req(&format!("/api/v1/transactions/{payer_hex}"))).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let rows = body["transactions"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{body}");

    // Newest (names-less): empty strings, never null / never leaked buffer bytes.
    assert_eq!(rows[0]["amount"], 100);
    assert_eq!(rows[0]["from_name"], "");
    assert_eq!(rows[0]["to_name"], "");
    assert_eq!(rows[0]["memo"], "");

    // Oldest (named): the signed names + memo decoded cleanly.
    assert_eq!(rows[1]["amount"], 250);
    assert_eq!(rows[1]["from_name"], "Alice", "payer's own from_name: {body}");
    assert_eq!(rows[1]["to_name"], "Bob", "payer's counterparty to_name: {body}");
    assert_eq!(rows[1]["memo"], "coffee", "memo: {body}");

    // Payee's incoming history: the payer's name is the friendly counterparty (closes N6/H3 — the
    // payee no longer sees a raw hex `from`).
    let (s, body) = call(&state, get_req(&format!("/api/v1/transactions/{merch_hex}"))).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let rows = body["transactions"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{body}");
    let named = rows.iter().find(|r| r["amount"] == 250).expect("named row present");
    assert_eq!(
        named["from_name"], "Alice",
        "payee sees payer's name, not a raw pubkey: {body}"
    );
    assert_eq!(named["to_name"], "Bob");
    assert_eq!(named["memo"], "coffee");
}

// --- deposit surface (ckBTC-style top-up) ----------------------------------
//
// Covers the three new ledger methods + REST routes (deposit-integration plan §3).
// The deposit endpoints map *any* `LedgerError` → 503 (no 422 — deposit plan §0).

/// `deposit_address` is deterministic (same pubkey → same address, every call) and distinct per
/// pubkey. The offline FakeLedger derives a recognizable `bc1qdpay` + first-8-pubkey-bytes address.
#[tokio::test]
async fn fake_deposit_address_is_deterministic_and_distinct_per_pubkey() {
    let a = pubkey(&keypair());
    let b = pubkey(&keypair());
    let led = ledger(a, b);

    // Deterministic: same pubkey → same address, every call.
    let addr_a1 = led.deposit_address(a, DEMO_USD).await.unwrap();
    let addr_a2 = led.deposit_address(a, DEMO_USD).await.unwrap();
    assert_eq!(addr_a1, addr_a2, "must be stable across calls");
    // Recognizable fake prefix + the first 8 pubkey bytes (hex) of `a`.
    assert_eq!(addr_a1, format!("bc1qdpay{}", hex::encode(&a[..8])));

    // Distinct per pubkey.
    let addr_b = led.deposit_address(b, DEMO_USD).await.unwrap();
    assert_ne!(addr_a1, addr_b, "different pubkeys get different addresses");
}

/// `deposit_status` drains a seeded pending deposit and credits the balance (mirroring the ck
/// minter's mint-after-confirmation); a second call finds nothing pending → minted_total = 0 and no
/// further credit. This is the offline proof of deposit → mint → balance.
#[tokio::test]
async fn deposit_status_credits_balance_and_drains_pending() {
    let a = pubkey(&keypair());
    let b = pubkey(&keypair());
    let led = ledger(a, b);

    // Seed a pending deposit of 5000 minor units for account `b`.
    led.register_deposit(b, DEMO_USD, 5000);
    assert_eq!(led.balance_of(&b, DEMO_USD), BAL_B, "no credit before refresh");

    // First refresh: mints the pending deposit, credits the balance.
    let r1 = led.deposit_status(b, DEMO_USD).await.unwrap();
    assert_eq!(r1.minted_total, 5000);
    assert_eq!(r1.minted.len(), 1);
    assert_eq!(r1.minted[0].amount, 5000);
    assert_eq!(r1.minted[0].block_index, "0");
    assert!(r1.pending.is_empty(), "nothing pending after a full drain");
    assert_eq!(r1.required_confirmations, 1);
    assert_eq!(led.balance_of(&b, DEMO_USD), BAL_B + 5000, "credited after refresh");

    // Second refresh: pending is drained → minted_total = 0, no double-credit.
    let r2 = led.deposit_status(b, DEMO_USD).await.unwrap();
    assert_eq!(r2.minted_total, 0, "pending drained: nothing more to mint");
    assert!(r2.minted.is_empty());
    assert_eq!(led.balance_of(&b, DEMO_USD), BAL_B + 5000, "no double-credit on re-refresh");
}

/// The three deposit REST routes return the correct JSON shapes via the axum router (driven with
/// `tower::ServiceExt::oneshot`, matching the rest of this file). Mirrors how the wallet's "Add
/// money" sheet will consume them.
#[tokio::test]
async fn deposit_routes_return_correct_shapes() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    let merch_hex = hex::encode(pubkey(&merchant));

    // GET /deposit/address/{hex} → {"address": "bc1qdpay..."}.
    let (s_addr, b_addr) =
        call(&state, get_req(&format!("/api/v1/deposit/address/{merch_hex}"))).await;
    assert_eq!(s_addr, StatusCode::OK, "{b_addr}");
    let expected_addr = format!("bc1qdpay{}", hex::encode(&pubkey(&merchant)[..8]));
    assert_eq!(b_addr["address"], expected_addr);

    // Seed a deposit so refresh has something to mint.
    led.register_deposit(pubkey(&merchant), DEMO_USD, 1234);

    // POST /deposit/refresh/{hex} → {minted_total, minted[], pending[], required_confirmations}.
    let refresh_req = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/deposit/refresh/{merch_hex}"))
        .body(Body::empty())
        .unwrap();
    let (s_r, b_r) = call(&state, refresh_req).await;
    assert_eq!(s_r, StatusCode::OK, "{b_r}");
    assert_eq!(b_r["minted_total"], 1234);
    assert_eq!(b_r["minted"][0]["amount"], 1234);
    assert_eq!(b_r["minted"][0]["block_index"], "0");
    assert!(b_r["pending"].as_array().unwrap().is_empty());
    assert_eq!(b_r["required_confirmations"], 1);
    // The balance actually moved on the ledger.
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B + 1234);

    // GET /deposit/info?currency=0 → static instructions.
    let (s_i, b_i) = call(&state, get_req("/api/v1/deposit/info")).await;
    assert_eq!(s_i, StatusCode::OK, "{b_i}");
    assert_eq!(b_i["min_confirmations"], 1);
    assert_eq!(b_i["deposit_fee"], 0);
    assert_eq!(b_i["deposit_min_amount"], 0);

    // A bad pubkey (not 32 bytes hex) on the address route is a clean 400, never a 500.
    let (bad_status, _bad_body) = call(&state, get_req("/api/v1/deposit/address/deadbeef")).await;
    assert_eq!(bad_status, StatusCode::BAD_REQUEST);
    // And on the refresh route.
    let bad_refresh = Request::builder()
        .method("POST")
        .uri("/api/v1/deposit/refresh/deadbeef")
        .body(Body::empty())
        .unwrap();
    let (bad_refresh_status, _) = call(&state, bad_refresh).await;
    assert_eq!(bad_refresh_status, StatusCode::BAD_REQUEST);
}

/// A ledger stub whose deposit methods always fail transiently. Proves the deposit routes map ANY
/// `LedgerError` → 503 (deposit plan §0: there is no permanent-policy failure on the deposit
/// surface, so no 422 path). Non-deposit methods delegate to an inner FakeLedger so the stub is a
/// drop-in for `AppState`.
struct DepositFailingLedger {
    inner: Arc<FakeLedger>,
}

#[async_trait]
impl Ledger for DepositFailingLedger {
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError> {
        self.inner.pay(wire).await
    }
    async fn balance(&self, pk: [u8; 32], c: Currency) -> Result<u64, LedgerError> {
        self.inner.balance(pk, c).await
    }
    async fn faucet(&self, to: [u8; 32], c: Currency, a: u64) -> Result<u64, LedgerError> {
        self.inner.faucet(to, c, a).await
    }
    async fn transactions_of(
        &self,
        pk: [u8; 32],
        c: Currency,
        l: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        self.inner.transactions_of(pk, c, l).await
    }
    async fn healthy(&self) -> bool {
        true
    }
    async fn deposit_address(&self, _pk: [u8; 32], _c: Currency) -> Result<String, LedgerError> {
        Err(LedgerError::Transient("injected deposit failure".into()))
    }
    async fn deposit_status(
        &self,
        _pk: [u8; 32],
        _c: Currency,
    ) -> Result<DepositRefresh, LedgerError> {
        Err(LedgerError::Transient("injected deposit failure".into()))
    }
    async fn deposit_info(&self, _c: Currency) -> Result<DepositInfo, LedgerError> {
        Err(LedgerError::Transient("injected deposit failure".into()))
    }
    async fn currencies(
        &self,
    ) -> Result<Vec<dpay_relay::CurrencyDescriptor>, LedgerError> {
        self.inner.currencies().await
    }
    async fn ckerc20_onramp_params(
        &self,
        currency: u32,
    ) -> Result<dpay_relay::CkErc20OnrampParams, LedgerError> {
        self.inner.ckerc20_onramp_params(currency).await
    }
    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError> {
        self.inner.receipt_pubkey().await
    }
}

/// All three deposit routes surface a ledger `Transient` as `503` (never `422`), and crucially the
/// failing path never credits a balance — the deposit endpoints are value-creating only on success.
#[tokio::test]
async fn deposit_routes_map_ledger_transient_to_503() {
    let a = pubkey(&keypair());
    let b = pubkey(&keypair());
    let inner = Arc::new(ledger(a, b));
    let state = AppState::new(Arc::new(DepositFailingLedger { inner: inner.clone() }));
    let hex_b = hex::encode(b);

    // GET /deposit/address/{hex} → 503.
    let (s1, body1) = call(&state, get_req(&format!("/api/v1/deposit/address/{hex_b}"))).await;
    assert_eq!(s1, StatusCode::SERVICE_UNAVAILABLE, "{body1}");

    // POST /deposit/refresh/{hex} → 503.
    let refresh_req = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/deposit/refresh/{hex_b}"))
        .body(Body::empty())
        .unwrap();
    let (s2, body2) = call(&state, refresh_req).await;
    assert_eq!(s2, StatusCode::SERVICE_UNAVAILABLE, "{body2}");

    // GET /deposit/info → 503.
    let (s3, body3) = call(&state, get_req("/api/v1/deposit/info")).await;
    assert_eq!(s3, StatusCode::SERVICE_UNAVAILABLE, "{body3}");

    // No deposit was credited — a failing refresh mints nothing.
    assert_eq!(inner.balance_of(&b, DEMO_USD), BAL_B, "transient refresh must not mint");
}

// --- currency catalog (M0) ---------------------------------------------------
//
// Covers GET /api/v1/currencies — the wallet's runtime asset catalog (closes issue #7). The
// FakeLedger reports a demo deployment: DEMO_USD (currency 0, $, mintable, no ramp) + a ckBTC-shaped
// currency (1, ₿, CkBtcUtxo ramp) + ckUSDC (2, ckUSDC, CkEthErc20 onramp). The wallet reads this once
// on load instead of hardcoding DEPOSIT_CURRENCY.

/// `GET /api/v1/currencies` returns `200 {"currencies": [...]}` with every registered currency's
/// ledger/minter/display metadata. Mirrors how the wallet consumes the catalog on load.
#[tokio::test]
async fn currencies_route_returns_demo_catalog() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let (status, body) = call(&state, get_req("/api/v1/currencies")).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let rows = body["currencies"].as_array().expect("currencies array");
    assert_eq!(rows.len(), 3, "demo catalog = DEMO_USD + ckBTC + ckUSDC: {body}");

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
    assert!(!dusd["ledger"].as_str().unwrap().is_empty(), "ledger principal text present");

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
    assert!(!ckbtc["minter"].as_str().unwrap().is_empty(), "ramp minter principal text present");

    // ckUSDC (currency 2): the ckERC-20 onramp asset — CkEthErc20 family, ckUSDC, 6 decimals.
    let ckusdc = rows
        .iter()
        .find(|r| r["currency"] == 2)
        .expect("ckUSDC currency present");
    assert_eq!(ckusdc["mintable"], false);
    assert_eq!(ckusdc["symbol"], "ckUSDC");
    assert_eq!(ckusdc["decimals"], 6);
    assert_eq!(ckusdc["minter_family"], "CkEthErc20");
    assert!(!ckusdc["minter"].as_str().unwrap().is_empty(), "ramp minter principal text present");
}

// --- ckERC-20 onramp surface (ckUSDC; M2) -------------------------------------
//
// Covers GET /api/v1/onramp/ckerc20 — surfaces the runtime parameters (helper contract, ERC-20
// address, facade principal) the app needs to build the user's two Ethereum transactions for a
// ckERC-20 onramp. ckUSDC is a ckERC-20 token handled by the ckETH minter; it has NO per-principal IC
// address and NO user-callable mint (the user signs both ETH txs in their own wallet). Only the
// CkEthErc20-family currencies have an onramp; a non-ckERC-20 currency → 503.

/// `GET /api/v1/onramp/ckerc20?currency=2` (ckUSDC) → `200` with the verified mainnet onramp
/// constants. `?currency=0` (DEMO_USD, not a ckERC-20 currency) → `503` (no onramp configured).
#[tokio::test]
async fn ckerc20_onramp_returns_params_for_ckusdc() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // currency 2 (ckUSDC) → 200 with the verified mainnet onramp constants.
    let (status, body) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=2")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["helper_address"], "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68");
    assert_eq!(body["erc20_address"], "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    assert!(
        !body["facade_principal"].as_str().unwrap().is_empty(),
        "facade principal present: {body}"
    );

    // currency 0 (DEMO_USD) → 503: DEMO_USD has no ckERC-20 onramp configured.
    let (status0, _body0) = call(&state, get_req("/api/v1/onramp/ckerc20?currency=0")).await;
    assert_eq!(status0, StatusCode::SERVICE_UNAVAILABLE);
}

// --- withdrawal surface (ckBTC → native BTC out; W2) -----------------------------------------
//
// Covers the new Ledger::withdraw trait method + the POST /api/v1/withdraw route. The FakeLedger
// simulates the burn as a direct debit (mirrors the canister's net ledger effect), and its
// accept/reject matches the canister's `withdraw` gate (sig / expiry / min / funds / nonce).

use dpay_core::WithdrawAuth;
use dpay_relay::WithdrawRequest;

/// A second currency standing in for ckBTC (the withdraw asset). Matches the canister test's CKX/CKBTC
/// tag — distinct from DEMO_USD so the withdraw debit lands on a separate (account, currency) key.
const CKBTC: Currency = 1;
/// Mirrors the live minter's `retrieve_btc_min_amount` + the relay/canister `RETRIEVE_BTC_MIN_AMOUNT`.
const MIN_WITHDRAW: u64 = 50_000;

/// Build a signed WithdrawRequest (hex fields) from a signing key. The signature is over the canonical
/// `WithdrawAuth::signing_bytes()` (single source of truth in dpay-core), so the FakeLedger's verify
/// accepts it exactly like the canister.
fn withdraw_req(
    sk: &SigningKey,
    destination: &str,
    amount: u64,
    nonce: [u8; 16],
    expiry: u64,
    currency: Currency,
) -> WithdrawRequest {
    let from = pubkey(sk);
    let auth = WithdrawAuth {
        from_pubkey: from,
        destination: destination.to_string(),
        amount,
        nonce,
        expiry,
        currency,
    };
    let sig = dpay_core::sign_withdraw(sk, &auth).to_bytes();
    WithdrawRequest {
        from: hex::encode(from),
        destination: destination.to_string(),
        amount,
        nonce: hex::encode(nonce),
        expiry,
        currency,
        sig: hex::encode(sig),
    }
}

/// POST /api/v1/withdraw with a JSON body.
fn withdraw_json(req: &WithdrawRequest) -> Request<Body> {
    let body = serde_json::json!({
        "from": req.from,
        "destination": req.destination,
        "amount": req.amount,
        "nonce": req.nonce,
        "expiry": req.expiry,
        "currency": req.currency,
        "sig": req.sig,
    });
    Request::builder()
        .method("POST")
        .uri("/api/v1/withdraw")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// Pre-fund an account with ckBTC directly on the FakeLedger (the deposit path's net effect), so a
/// withdraw test starts with a known balance. Uses the public `register_deposit`+`deposit_status`
/// path to credit through the real seam.
async fn fund_ckbtc(state: &AppState, led: &FakeLedger, pk: [u8; 32], amount: u64) {
    led.register_deposit(pk, CKBTC, amount);
    let _ = state.ledger.deposit_status(pk, CKBTC).await.expect("deposit_status credits");
    assert_eq!(led.balance_of(&pk, CKBTC), amount, "pre-fund credited");
}

/// A verified withdrawal debits ckBTC from the user's subaccount and returns the burn block index.
#[tokio::test]
async fn withdraw_debits_ckbtc_from_subaccount() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    const FUND: u64 = 100_000;
    fund_ckbtc(&state, &led, pubkey(&payer), FUND).await;

    let req = withdraw_req(&payer, "bc1qdestination", MIN_WITHDRAW, [1u8; 16], FUTURE, CKBTC);
    let r = state.ledger.withdraw(req).await.expect("withdraw ok");
    assert_eq!(r.amount, MIN_WITHDRAW);
    assert_eq!(r.destination, "bc1qdestination");
    assert_eq!(r.currency, CKBTC);
    // Debited by the withdrawn amount.
    assert_eq!(led.balance_of(&pubkey(&payer), CKBTC), FUND - MIN_WITHDRAW);
}

/// The POST /api/v1/withdraw route returns 200 + the receipt JSON on success.
#[tokio::test]
async fn withdraw_route_returns_receipt_on_success() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    fund_ckbtc(&state, &led, pubkey(&payer), 100_000).await;

    let req = withdraw_req(&payer, "bc1qroute", MIN_WITHDRAW, [2u8; 16], FUTURE, CKBTC);
    let (status, body) = call(&state, withdraw_json(&req)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["receipt"]["amount"], MIN_WITHDRAW);
    assert_eq!(body["receipt"]["destination"], "bc1qroute");
    assert_eq!(led.balance_of(&pubkey(&payer), CKBTC), 100_000 - MIN_WITHDRAW);
}

/// A replay with the SAME nonce is rejected (422) — no double-burn. Mirrors the canister.
#[tokio::test]
async fn withdraw_double_withdraw_same_nonce_rejected() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    fund_ckbtc(&state, &led, pubkey(&payer), 200_000).await;

    let req = withdraw_req(&payer, "bc1qfirst", MIN_WITHDRAW, [3u8; 16], FUTURE, CKBTC);
    let (s1, _b1) = call(&state, withdraw_json(&req)).await;
    assert_eq!(s1, StatusCode::OK);
    assert_eq!(led.balance_of(&pubkey(&payer), CKBTC), 200_000 - MIN_WITHDRAW);

    // Same nonce again → 422, no second debit.
    let (s2, b2) = call(&state, withdraw_json(&req)).await;
    assert_eq!(s2, StatusCode::UNPROCESSABLE_ENTITY, "{b2}");
    assert!(b2["error"].as_str().unwrap().contains("nonce"), "error={b2}");
    assert_eq!(led.balance_of(&pubkey(&payer), CKBTC), 200_000 - MIN_WITHDRAW);
}

/// A wrong signature is rejected (422) and moves no funds.
#[tokio::test]
async fn withdraw_wrong_sig_rejected_no_funds_move() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    fund_ckbtc(&state, &led, pubkey(&payer), 100_000).await;

    // Sign with a DIFFERENT key but present from = payer — verify under payer fails.
    let other = keypair();
    let auth = WithdrawAuth {
        from_pubkey: pubkey(&payer),
        destination: "bc1qattacker".to_string(),
        amount: MIN_WITHDRAW,
        nonce: [4u8; 16],
        expiry: FUTURE,
        currency: CKBTC,
    };
    let wrong_sig = dpay_core::sign_withdraw(&other, &auth).to_bytes();
    let req = WithdrawRequest {
        from: hex::encode(pubkey(&payer)),
        destination: "bc1qattacker".to_string(),
        amount: MIN_WITHDRAW,
        nonce: hex::encode([4u8; 16]),
        expiry: FUTURE,
        currency: CKBTC,
        sig: hex::encode(wrong_sig),
    };
    let (status, body) = call(&state, withdraw_json(&req)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["error"].as_str().unwrap().contains("signature"), "error={body}");
    assert_eq!(led.balance_of(&pubkey(&payer), CKBTC), 100_000, "no debit on a bad sig");
}

/// A below-min withdrawal is rejected (422) and moves no funds. Mirrors the canister's local floor.
#[tokio::test]
async fn withdraw_below_min_rejected() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    fund_ckbtc(&state, &led, pubkey(&payer), 100_000).await;

    let req = withdraw_req(&payer, "bc1qtoosmall", MIN_WITHDRAW - 1, [5u8; 16], FUTURE, CKBTC);
    let (status, body) = call(&state, withdraw_json(&req)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["error"].as_str().unwrap().contains("retrieve_btc_min_amount"), "error={body}");
    assert_eq!(led.balance_of(&pubkey(&payer), CKBTC), 100_000, "no debit on a below-min withdraw");
}

/// Insufficient funds is rejected (422) and the nonce is RELEASED (a later deposit + same-auth retry
/// can succeed within the expiry window — mirrors the canister's release-on-pre-burn-failure).
#[tokio::test]
async fn withdraw_insufficient_funds_releases_nonce_for_retry() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    fund_ckbtc(&state, &led, pubkey(&payer), 30_000).await; // < MIN_WITHDRAW (50_000)

    let req = withdraw_req(&payer, "bc1qnotenough", MIN_WITHDRAW, [6u8; 16], FUTURE, CKBTC);
    let (status, body) = call(&state, withdraw_json(&req)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["error"].as_str().unwrap().contains("InsufficientFunds"), "error={body}");
    assert_eq!(led.balance_of(&pubkey(&payer), CKBTC), 30_000, "no debit");

    // Now top up to 100_000 and retry the SAME nonce — it must succeed (nonce was released, not
    // burned). register_deposit + deposit_status credit through the real seam.
    led.register_deposit(pubkey(&payer), CKBTC, 70_000);
    let _ = state.ledger.deposit_status(pubkey(&payer), CKBTC).await.expect("deposit_status credits");
    assert_eq!(led.balance_of(&pubkey(&payer), CKBTC), 100_000, "topped up to 100_000");

    let (status2, body2) = call(&state, withdraw_json(&req)).await;
    assert_eq!(status2, StatusCode::OK, "same-nonce retry must succeed after funding: {body2}");
    assert_eq!(led.balance_of(&pubkey(&payer), CKBTC), 100_000 - MIN_WITHDRAW);
}

// --- W3 audit: FakeLedger.pay must mirror the canister's hard rejects -------------------------
//
// The canister's `pay` rejects a self-transfer (`from == to`) and a payment to the mint sentinel
// (`to == [0xFF;32]`) before reserving the nonce. The FakeLedger MUST reject the same (the
// mock-mirrors-real-counterparty lesson: a divergence where the FakeLedger accepts what the canister
// rejects would let a bug ship green). These tests pin the FakeLedger to the canister's behavior.

#[tokio::test]
async fn w3_fakeledger_rejects_self_transfer_like_canister() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // from == to == payer. The canister rejects this ("self transfer"); the FakeLedger must too.
    let sa = signed(&payer, pubkey(&payer), 100, [7u8; 16], FUTURE);
    let (status, body) = call(&state, pay_json(&sa.encode())).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["error"].as_str().unwrap().contains("self transfer"), "error={body}");
    // Nothing moved + the nonce was NOT burned (no state change).
    assert_eq!(led.balance_of(&pubkey(&payer), DEMO_USD), BAL_A);
}

#[tokio::test]
async fn w3_fakeledger_rejects_pay_to_mint_sentinel_like_canister() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // to == [0xFF;32] (the mint sentinel). The canister rejects this; the FakeLedger must too.
    let sa = signed(&payer, [0xFF; 32], 100, [8u8; 16], FUTURE);
    let (status, body) = call(&state, pay_json(&sa.encode())).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["error"].as_str().unwrap().contains("mint sentinel"), "error={body}");
    assert_eq!(led.balance_of(&pubkey(&payer), DEMO_USD), BAL_A);
    // The sentinel subaccount was NOT credited (the canister would have rejected before any move).
    assert_eq!(led.balance_of(&[0xFF; 32], DEMO_USD), 0);
}
