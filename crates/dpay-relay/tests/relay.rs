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

use dpay_core::{Authorization, SignedAuthorization};
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
    };
    SignedAuthorization::new(sk, auth)
}

/// POST /pay with a JSON `{"qr": ...}` body.
fn pay_json(qr: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/pay")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!("{{\"qr\":\"{qr}\"}}")))
        .unwrap()
}

/// POST /pay with a raw wire-bytes body.
fn pay_wire(wire: &[u8]) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/pay")
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(wire.to_vec()))
        .unwrap()
}

async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
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
    assert_eq!(led.balance_of(&pubkey(&payer)), BAL_A - 250);
    assert_eq!(led.balance_of(&pubkey(&merchant)), BAL_B + 250);
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
    assert_eq!(led.balance_of(&pubkey(&merchant)), 100);
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

    // Second submission of the SAME nonce: 200, byte-identical receipt, no double settle.
    let (s2, b2) = call(&state, pay_json(&sa.encode())).await;
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(b1, b2, "duplicate must return identical receipt");

    // Merchant credited exactly once; payer debited exactly once.
    assert_eq!(led.balance_of(&pubkey(&merchant)), 400, "credited once only");
    assert_eq!(led.balance_of(&pubkey(&payer)), BAL_A - 400, "debited once only");
}

#[tokio::test]
async fn bad_signature_rejected_422_no_state_change() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // Build a valid signed auth, then corrupt the signature bytes in the wire form.
    let sa = signed(&payer, pubkey(&merchant), 100, [3u8; 16], FUTURE);
    let mut wire = sa.to_wire();
    wire[96] ^= 0xFF; // flip a byte inside the 64-byte signature

    let (status, body) = call(&state, pay_wire(&wire)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["error"].as_str().unwrap().contains("BadSignature"),
        "error={body}"
    );

    // Nothing moved.
    assert_eq!(led.balance_of(&pubkey(&payer)), BAL_A);
    assert_eq!(led.balance_of(&pubkey(&merchant)), BAL_B);
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
    assert_eq!(led.balance_of(&pubkey(&merchant)), BAL_B);
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
    assert_eq!(led.balance_of(&pubkey(&payer)), BAL_A);
    assert_eq!(led.balance_of(&pubkey(&merchant)), BAL_B);
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
    assert_eq!(ledarc.balance_of(&pubkey(&payer)), 200);
    assert_eq!(ledarc.balance_of(&pubkey(&merchant)), 0);
}

#[tokio::test]
async fn health_ok() {
    let payer = keypair();
    let merchant = keypair();
    let (state, _led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    let req = Request::builder()
        .method("GET")
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
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
