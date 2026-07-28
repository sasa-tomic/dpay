//! LIVE integration test for the real settlement path (feature `agent`).
//!
//! Unlike `relay.rs` (fast, in-memory, offline inner loop), this stands up a **real local IC**
//! via PocketIC's HTTP gateway, installs the actual dpay canister wasm, and drives a real payment
//! end to end through the relay's axum app + `AgentLedger` + `ic-agent`. It proves the code that
//! ships is the code we test: same wire format, same candid surface, same canister logic.
//!
//! Asserts:
//!   1. a valid `POST /api/v1/pay` settles → 200, and balances actually move (read back via a REAL
//!      `balance_of` agent query, not any in-memory shortcut);
//!   2. relay idempotency — a 2nd identical HTTP submit returns the byte-identical receipt and
//!      does NOT double-settle;
//!   3. a *reused nonce with a fresh signature* is rejected by the canister (no double-spend).
//!
//! Prereqs (the justfile's `test-live` recipe wires these):
//!   - build the wasm first:
//!       CARGO_TARGET_DIR=.dev/target-relay cargo build -p dpay-canister \
//!           --target wasm32-unknown-unknown --release
//!   - `DPAY_CANISTER_WASM` → that wasm; `POCKET_IC_BIN` → the vendored pocket-ic server.
//!
//! Run: `cargo nextest run -p dpay-relay --features agent`.
//!
//! Runtime note: PocketIC's blocking handle drives its own tokio runtime, so all `pic.*` calls
//! happen on the test thread OUTSIDE any async context; the agent/axum work runs inside a
//! dedicated `Runtime::block_on`. PocketIC auto-progresses on its own thread, so the replica keeps
//! ticking (and tracking real wall-clock time) throughout — hence expiries are set relative to
//! real `now`, not a pinned instant.

#![cfg(feature = "agent")]

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt; // oneshot

use candid::{encode_one, CandidType, Principal};
use pocket_ic::PocketIc;
use serde::Deserialize;

use dpay_core::{generate_keypair, Authorization, SignedAuthorization, DEMO_USD};
use dpay_relay::{app, AgentLedger, AppState, Ledger}; // Ledger: for AgentLedger::pay in scope
use ed25519_dalek::SigningKey;

const CAP: u64 = 100_000; // per-tx cap: $1,000.00
const INIT_A: u64 = 10_000; // payer opens with $100.00
const INIT_B: u64 = 0; // merchant opens empty

/// Mirror of the canister's `InitArg` (candid-encoded at install).
#[derive(CandidType, Deserialize)]
struct InitArg {
    account_a: Vec<u8>,
    balance_a: u64,
    account_b: Vec<u8>,
    balance_b: u64,
    per_tx_cap: u64,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn wasm_bytes() -> Vec<u8> {
    let path = std::env::var("DPAY_CANISTER_WASM").unwrap_or_else(|_| {
        ".dev/target-relay/wasm32-unknown-unknown/release/dpay_canister.wasm".into()
    });
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read canister wasm at {path}: {e}"))
}

fn signed(
    sk: &SigningKey,
    from: [u8; 32],
    to: [u8; 32],
    amount: u64,
    nonce: [u8; 16],
    expiry: u64,
) -> SignedAuthorization {
    let auth = Authorization { from, to, amount, nonce, expiry, currency: DEMO_USD };
    SignedAuthorization::new(sk, auth)
}

/// POST /api/v1/pay with a raw wire-bytes body (the merchant's decoded signed-auth QR).
fn pay_wire(wire: &[u8]) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/v1/pay")
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

#[test]
fn live_settlement_end_to_end() {
    // --- 1. Stand up a real local IC with an HTTP gateway (blocking; own runtime). ---
    let mut pic = PocketIc::new();
    // `make_live` starts the HTTP gateway on 127.0.0.1:<port> and enables auto-progress. The URL
    // it returns is where ic-agent makes its `/api` calls — a genuine replica endpoint.
    let gateway_url = pic.make_live(None).to_string();

    // --- 2. Keys + pre-funded accounts, install the real canister wasm. ---
    let payer_sk = generate_keypair();
    let payer_pk = payer_sk.verifying_key().to_bytes();
    let merch_pk = generate_keypair().verifying_key().to_bytes();

    let can = pic.create_canister();
    pic.add_cycles(can, 2_000_000_000_000);
    let init = InitArg {
        account_a: payer_pk.to_vec(),
        balance_a: INIT_A,
        account_b: merch_pk.to_vec(),
        balance_b: INIT_B,
        per_tx_cap: CAP,
    };
    pic.install_canister(can, wasm_bytes(), encode_one(&init).unwrap(), None);
    // pocket-ic's `CanisterId` is `candid::Principal`; ic-agent takes the same type directly.
    let canister_id: Principal = can;

    // --- 3. Everything from here is async: AgentLedger (ic-agent) + the relay's axum app. ---
    //     Own runtime so we never nest inside PocketIC's blocking runtime.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        // Point the real ledger at the live gateway + canister. `connect` fetches the root key
        // (required off mainnet) — if the gateway weren't truly live this would fail.
        let ledger = AgentLedger::connect(&gateway_url, canister_id)
            .await
            .expect("AgentLedger must connect to the live gateway");
        let ledger = Arc::new(ledger);
        let state = AppState::new(ledger.clone());

        // Sanity: opening balances read back through a REAL query.
        assert_eq!(ledger.balance_of(&payer_pk, DEMO_USD).await.unwrap(), INIT_A);
        assert_eq!(ledger.balance_of(&merch_pk, DEMO_USD).await.unwrap(), INIT_B);

        // Health goes through the real replica `status`.
        let health = Request::builder()
            .method("GET")
            .uri("/api/v1/health")
            .body(Body::empty())
            .unwrap();
        let (hs, hb) = call(&state, health).await;
        assert_eq!(hs, StatusCode::OK, "health body={hb}");
        assert_eq!(hb["status"], "ok");

        // ---- (1) valid pay settles, balances move on the real ledger ----
        let expiry = now_secs() + 120;
        let nonce = [11u8; 16];
        let sa = signed(&payer_sk, payer_pk, merch_pk, 2_500, nonce, expiry);

        let (s1, b1) = call(&state, pay_wire(&sa.to_wire())).await;
        assert_eq!(s1, StatusCode::OK, "valid pay must settle: {b1}");
        let r = &b1["receipt"];
        assert_eq!(r["amount"], 2_500);
        assert_eq!(r["from"], hex::encode(payer_pk));
        assert_eq!(r["to"], hex::encode(merch_pk));
        assert_eq!(r["nonce"], hex::encode(nonce));
        assert_eq!(r["new_from_balance"], INIT_A - 2_500);

        // Read back through REAL balance_of queries — the funds actually moved on-chain.
        assert_eq!(ledger.balance_of(&payer_pk, DEMO_USD).await.unwrap(), INIT_A - 2_500);
        assert_eq!(ledger.balance_of(&merch_pk, DEMO_USD).await.unwrap(), INIT_B + 2_500);

        // ---- (2) relay idempotency: same submission → identical receipt, no double-settle ----
        let (s2, b2) = call(&state, pay_wire(&sa.to_wire())).await;
        assert_eq!(s2, StatusCode::OK);
        // The whole bodies legitimately differ: the first settle carries `replayed: false`, the
        // idempotent replay `replayed: true`. Idempotency is that the *receipt* is identical.
        assert_eq!(b1["receipt"], b2["receipt"], "duplicate submit must replay the identical cached receipt");
        assert_eq!(b1["replayed"], false, "first settle is a fresh charge, not a replay");
        assert_eq!(b2["replayed"], true, "second identical submit must be flagged as replayed");
        // Balances unchanged after the replay.
        assert_eq!(ledger.balance_of(&payer_pk, DEMO_USD).await.unwrap(), INIT_A - 2_500);
        assert_eq!(ledger.balance_of(&merch_pk, DEMO_USD).await.unwrap(), INIT_B + 2_500);

        // ---- (3) reused nonce must be rejected by the CANISTER (no double-spend at the ledger) ----
        // The relay's HTTP idempotency (proven in (2)) caches by nonce, so a 2nd submit never even
        // reaches the ledger. To prove the *canister's* own spent-nonce guard — the real
        // double-spend defense that holds even if the relay's cache were bypassed/restarted — drive
        // `AgentLedger::pay` directly with a freshly-signed authorization reusing the same nonce for
        // a DIFFERENT amount. The canister must reject it as NonceReused.
        let dup = signed(&payer_sk, payer_pk, merch_pk, 1_000, nonce, now_secs() + 120);
        let err = ledger
            .pay(dup.to_wire().to_vec())
            .await
            .expect_err("canister must reject a reused nonce");
        match err {
            dpay_relay::LedgerError::Rejected(msg) => {
                assert!(msg.contains("NonceReused"), "expected NonceReused, got: {msg}");
            }
            other => panic!("expected a Rejected(NonceReused), got {other:?}"),
        }
        // Still exactly one settlement — no double-spend on the real ledger.
        assert_eq!(ledger.balance_of(&payer_pk, DEMO_USD).await.unwrap(), INIT_A - 2_500);
        assert_eq!(ledger.balance_of(&merch_pk, DEMO_USD).await.unwrap(), INIT_B + 2_500);
    });

    // Tear down the gateway + replica explicitly (also happens on drop).
    pic.stop_live();
}
