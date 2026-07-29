//! Feature-gated tests for the `test-helpers` deposit-seed route. This file is `#![cfg]`-gated so
//! it compiles to NOTHING when the feature is off — the route + trait method it exercises are
//! `#[cfg(feature = "test-helpers")]` too, so they are absent from the prod image (`just image`
//! never enables the feature).
//!
//! Proves the full local-e2e deposit path: POST /api/v1/test/deposit/seed → then a REAL
//! /api/v1/deposit/refresh through the REAL axum router credits the balance (mirrors what a
//! browser harness will do).

#![cfg(feature = "test-helpers")]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt; // oneshot

use dpay_core::{Currency, DEMO_USD};
use dpay_relay::{app, AppState, FakeLedger, FixedClock, Ledger};
use ed25519_dalek::SigningKey;

// Mirror the test scaffolding in tests/relay.rs: a fixed clock + two seeded demo accounts.
const NOW: u64 = 1_700_000_000;
const CAP: u64 = 1_000;
const BAL_A: u64 = 5_000;
const BAL_B: u64 = 0;

fn keypair() -> SigningKey {
    dpay_core::generate_keypair()
}

fn pubkey(sk: &SigningKey) -> [u8; 32] {
    sk.verifying_key().to_bytes()
}

fn ledger(a: [u8; 32], b: [u8; 32]) -> FakeLedger {
    FakeLedger::with_clock(a, BAL_A, b, BAL_B, CAP, Box::new(FixedClock(NOW)))
}

fn state_from(ledger: FakeLedger) -> (AppState, Arc<FakeLedger>) {
    let arc = Arc::new(ledger);
    (AppState::new(arc.clone()), arc)
}

async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

/// POST /api/v1/test/deposit/seed with a JSON body.
fn seed_json(account_hex: &str, currency: Option<Currency>, amount: u64) -> Request<Body> {
    let cur = match currency {
        Some(c) => format!(",\"currency\":{c}"),
        None => String::new(),
    };
    Request::builder()
        .method("POST")
        .uri("/api/v1/test/deposit/seed")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(
            "{{\"account\":\"{account_hex}\"{cur},\"amount\":{amount}}}"
        )))
        .unwrap()
}

#[tokio::test]
async fn seed_then_refresh_credits_balance_through_real_router() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));
    let merch_hex = hex::encode(pubkey(&merchant));

    // Pre-condition: no deposit pending, merchant balance is the opening balance.
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B);

    // Seed a pending deposit of 5000 minor units for the merchant via the test route.
    let (s_seed, b_seed) = call(&state, seed_json(&merch_hex, Some(DEMO_USD), 5000)).await;
    assert_eq!(s_seed, StatusCode::OK, "seed must return 200: {b_seed}");
    assert_eq!(b_seed["seeded"], true);

    // The balance is NOT credited yet — a real mint lands only after a refresh drains the pending
    // deposit (mirrors the ck minter minting after confirmations). This is the honesty property: no
    // false "Deposited ✓" before a refresh.
    assert_eq!(
        led.balance_of(&pubkey(&merchant), DEMO_USD),
        BAL_B,
        "seed must not credit the balance directly"
    );

    // Now drive the REAL refresh route — the path the wallet's "Add money" sheet polls.
    let refresh_req = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/deposit/refresh/{merch_hex}"))
        .body(Body::empty())
        .unwrap();
    let (s_r, b_r) = call(&state, refresh_req).await;
    assert_eq!(s_r, StatusCode::OK, "refresh must return 200: {b_r}");
    assert_eq!(b_r["minted_total"], 5000);
    assert_eq!(b_r["minted"][0]["amount"], 5000);
    assert!(b_r["pending"].as_array().unwrap().is_empty());

    // The balance actually moved on the ledger — the credited path is proven end-to-end.
    assert_eq!(
        led.balance_of(&pubkey(&merchant), DEMO_USD),
        BAL_B + 5000,
        "refresh must credit the seeded deposit"
    );

    // A second refresh finds nothing pending (drained, no double-credit).
    let refresh_req2 = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/deposit/refresh/{merch_hex}"))
        .body(Body::empty())
        .unwrap();
    let (s_r2, b_r2) = call(&state, refresh_req2).await;
    assert_eq!(s_r2, StatusCode::OK);
    assert_eq!(b_r2["minted_total"], 0, "pending drained: nothing more to mint");
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B + 5000);
}

/// The seed route mirrors `balance`/`faucet`: a bad account (not 32 bytes hex) is a clean `400`,
/// never a `500`. Currency defaults to `DEMO_USD` when omitted.
#[tokio::test]
async fn seed_route_validates_account_and_defaults_currency() {
    let payer = keypair();
    let merchant = keypair();
    let (state, led) = state_from(ledger(pubkey(&payer), pubkey(&merchant)));

    // Bad account (4 bytes, not 32) → 400.
    let (s_bad, b_bad) = call(&state, seed_json("deadbeef", None, 1000)).await;
    assert_eq!(s_bad, StatusCode::BAD_REQUEST, "{b_bad}");

    // Currency omitted → defaults to DEMO_USD (0); seeds for that currency and credits on refresh.
    let merch_hex = hex::encode(pubkey(&merchant));
    let (s_ok, _b_ok) = call(&state, seed_json(&merch_hex, None, 1234)).await;
    assert_eq!(s_ok, StatusCode::OK);
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B, "not credited before refresh");
    // The seed landed on DEMO_USD (the default) — a refresh in DEMO_USD credits it.
    led.deposit_status(pubkey(&merchant), DEMO_USD).await.unwrap();
    assert_eq!(led.balance_of(&pubkey(&merchant), DEMO_USD), BAL_B + 1234);
}
