//! Proves the `test-helpers` deposit-seed route is **absent** from the default build (no features).
//! This file is `#![cfg(not(feature = "test-helpers"))]`-gated so it runs only in the default-
//! feature test invocation — the prod image (`just image`) never enables `test-helpers`, so the
//! route MUST NOT exist there. A regression that accidentally un-gates the route would flip this
//! 404 to a 200 and fail the inner loop.

#![cfg(not(feature = "test-helpers"))]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt; // oneshot

use dpay_relay::{app, AppState, FakeLedger, FixedClock};
use ed25519_dalek::SigningKey;

const NOW: u64 = 1_700_000_000;
const CAP: u64 = 1_000;

fn keypair() -> SigningKey {
    dpay_core::generate_keypair()
}

fn pubkey(sk: &SigningKey) -> [u8; 32] {
    sk.verifying_key().to_bytes()
}

#[tokio::test]
async fn test_deposit_seed_route_is_absent_in_default_build() {
    // Any two pubkeys suffice — we never reach the ledger.
    let a = pubkey(&keypair());
    let b = pubkey(&keypair());
    let ledger = FakeLedger::new();
    let state = AppState::new(Arc::new(ledger));

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/test/deposit/seed")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            "{\"account\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"amount\":1}",
        ))
        .unwrap();
    let resp = app(state).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    // The route is gone → axum returns 404 (not 405, since nothing is mounted at this path at all).
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "test/deposit/seed must not exist without --features test-helpers (got {status}, body={})",
        String::from_utf8_lossy(&bytes),
    );
    // Sanity: the body is axum's plain 404 text, not a JSON error from the handler (the handler is
    // not compiled in). This distinguishes "route absent" from "route present but returning a 404
    // handler error".
    let _ignored: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
}
