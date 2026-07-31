//! LIVE integration test for the real settlement path (feature `agent`).
//!
//! Unlike `relay.rs` (fast, in-memory, offline inner loop), this stands up a **real local IC**
//! via PocketIC's HTTP gateway, installs the REAL DFINITY ic-icrc1-ledger + the dpay FACADE
//! canister wired to it, funds a demo payer through the facade, and drives a real payment end to
//! end through the relay's axum app + `AgentLedger` + `ic-agent`. It proves the code that ships is
//! the code we test: same wire format, same candid surface, same facade logic — and that the
//! facade's cache-backed `balance_of` query reflects settles.
//!
//! Asserts:
//!   1. a valid `POST /api/v1/pay` settles → 200, and balances actually move on the ledger (read
//!      back through the facade's REAL `balance_of` query, which reads the display cache refreshed
//!      post-settle);
//!   2. relay idempotency — a 2nd identical HTTP submit returns the byte-identical receipt and
//!      does NOT double-settle;
//!   3. a *reused nonce with a fresh signature* is rejected by the facade (no double-spend).
//!
//! Prereqs (the justfile's `test-live` recipe wires these):
//!   - build the wasm first:
//!       CARGO_TARGET_DIR=.dev/target-relay cargo build -p dpay-canister \
//!           --target wasm32-unknown-unknown --release
//!   - `DPAY_CANISTER_WASM` → that wasm; `POCKET_IC_BIN` → the vendored pocket-ic server;
//!     `third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm` present (the real ledger wasm).
//!
//! Run: `cargo nextest run -p dpay-relay --features agent`.

#![cfg(feature = "agent")]

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt; // oneshot

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use pocket_ic::PocketIc;
use serde::Deserialize;

use dpay_core::{generate_keypair, Authorization, SignedAuthorization, DEMO_USD};
use dpay_relay::{app, AgentLedger, AppState, Ledger};
use ed25519_dalek::SigningKey;
use icrc_ledger_types::icrc1::account::Account;

const CAP: u64 = 100_000; // per-tx cap: $1,000.00
const INIT_A: u64 = 10_000; // payer opens with $100.00 (minted through the facade)

// --- facade init payload -----------------------------------------------------------------------

#[derive(CandidType, serde::Serialize)]
struct LedgerConfig {
    currency: u32,
    principal: Principal,
    mintable: bool,
}

#[derive(CandidType, serde::Serialize)]
struct DpayInitArg {
    ledgers: Vec<LedgerConfig>,
    per_tx_cap: u64,
    controller: Option<Principal>,
}

// --- real ic-icrc1-ledger init payload (mirrors third_party/ic-icrc1-ledger/ledger.did) --------

#[derive(CandidType, serde::Serialize)]
struct FeatureFlags {
    icrc2: bool,
    icrc152: bool,
}

#[derive(CandidType, serde::Serialize)]
struct ArchiveOptions {
    num_blocks_to_archive: u64,
    max_transactions_per_response: Option<u64>,
    trigger_threshold: u64,
    max_message_size_bytes: Option<u64>,
    cycles_for_archive_creation: Option<u64>,
    node_max_memory_size_bytes: Option<u64>,
    controller_id: Principal,
    more_controller_ids: Option<Vec<Principal>>,
}

#[derive(CandidType, serde::Serialize)]
struct LedgerInitArgs {
    minting_account: Account,
    fee_collector_account: Option<Account>,
    transfer_fee: Nat,
    decimals: Option<u8>,
    max_memo_length: Option<u16>,
    token_symbol: String,
    token_name: String,
    metadata: Vec<(String, Nat)>,
    initial_balances: Vec<(Account, Nat)>,
    feature_flags: Option<FeatureFlags>,
    archive_options: ArchiveOptions,
    index_principal: Option<Principal>,
}

#[derive(CandidType, serde::Serialize)]
enum LedgerArg {
    Init(LedgerInitArgs),
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn workspace_root() -> std::path::PathBuf {
    // crates/dpay-relay -> workspace root
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn facade_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_CANISTER_WASM").unwrap_or_else(|_| {
        ".dev/target-relay/wasm32-unknown-unknown/release/dpay_canister.wasm".into()
    });
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read facade wasm at {path}: {e}"))
}

fn ledger_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_ICRC_LEDGER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm")
        });
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read ledger wasm at {}: {e}", path.display()))
}

fn signed(
    sk: &SigningKey,
    from: [u8; 32],
    to: [u8; 32],
    amount: u64,
    nonce: [u8; 16],
    expiry: u64,
) -> SignedAuthorization {
    let auth = Authorization {
        from,
        to,
        amount,
        nonce,
        expiry,
        currency: DEMO_USD,
        from_name: [0u8; 32],
        to_name: [0u8; 32],
        memo: [0u8; 32],
    };
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
    let gateway_url = pic.make_live(None).to_string();

    // --- 2. Install a real ICRC ledger + the facade wired to it, then mint to the payer. ---
    let payer_sk = generate_keypair();
    let payer_pk = payer_sk.verifying_key().to_bytes();
    let merch_pk = generate_keypair().verifying_key().to_bytes();

    // Reserve the facade id first — the ledger's minting account owner must be the facade.
    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);

    let ledger = pic.create_canister();
    pic.add_cycles(ledger, 10_000_000_000_000);
    let ledger_init = LedgerArg::Init(LedgerInitArgs {
        minting_account: Account { owner: dpay, subaccount: None },
        fee_collector_account: None,
        transfer_fee: Nat::from(0u64),
        decimals: Some(2),
        max_memo_length: None,
        token_symbol: "DUSD".into(),
        token_name: "dpay demo USD".into(),
        metadata: vec![],
        initial_balances: vec![],
        feature_flags: Some(FeatureFlags { icrc2: true, icrc152: false }),
        archive_options: ArchiveOptions {
            num_blocks_to_archive: 10_000,
            max_transactions_per_response: None,
            trigger_threshold: 10_000_000,
            max_message_size_bytes: None,
            cycles_for_archive_creation: None,
            node_max_memory_size_bytes: None,
            controller_id: dpay,
            more_controller_ids: None,
        },
        index_principal: None,
    });
    pic.install_canister(ledger, ledger_wasm(), encode_one(&ledger_init).unwrap(), None);

    // Install the facade wired to the ledger (DUSD, mintable, open controller).
    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig { currency: DEMO_USD, principal: ledger, mintable: true }],
        per_tx_cap: CAP,
        controller: None,
    };
    pic.install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);
    let canister_id: Principal = dpay;

    // Fund the payer through the self-service FAUCET. Since R1 the privileged `mint` is
    // controller-only (denied with controller=null); the faucet is the demo on-ramp and mints a
    // FIXED amount (FAUCET_AMOUNT, == INIT_A here) — the relay's `/faucet` route calls it. The
    // facade settles the mint on the ledger and refreshes the display cache; it returns the NEW
    // BALANCE per the `Ledger::faucet` contract.
    let mint_reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "faucet",
            encode_args((payer_pk.to_vec(), DEMO_USD)).unwrap(),
        )
        .expect("faucet update rejected");
    let mint_ret = decode_one::<Result<u64, String>>(&mint_reply)
        .unwrap()
        .expect("faucet must succeed");
    assert_eq!(mint_ret, INIT_A, "facade faucet must return the post-mint balance");

    // --- 3. Everything from here is async: AgentLedger (ic-agent) + the relay's axum app. ---
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        // Point the real ledger at the live gateway + facade. `connect` fetches the root key
        // (required off mainnet) — if the gateway weren't truly live this would fail.
        let ledger = AgentLedger::connect(&gateway_url, canister_id)
            .await
            .expect("AgentLedger must connect to the live gateway");
        let ledger = Arc::new(ledger);
        let state = AppState::new(ledger.clone());

        // Sanity: opening balances read back through a REAL query (the cache, refreshed by the mint).
        assert_eq!(ledger.balance_of(&payer_pk, DEMO_USD).await.unwrap(), INIT_A);
        assert_eq!(ledger.balance_of(&merch_pk, DEMO_USD).await.unwrap(), 0);

        // AgentLedger::faucet proxies the canister's self-service faucet and returns the NEW BALANCE
        // (surfaced by the relay as `{balance}`). The canister mints its FIXED amount (== INIT_A) and
        // ignores the requested amount; a fresh account therefore reports INIT_A.
        let fresh_pk = generate_keypair().verifying_key().to_bytes();
        let mint_bal = ledger
            .faucet(fresh_pk, DEMO_USD, INIT_A)
            .await
            .expect("AgentLedger::faucet must succeed");
        assert_eq!(mint_bal, INIT_A, "AgentLedger::faucet must return the post-mint balance");
        assert_eq!(ledger.balance_of(&fresh_pk, DEMO_USD).await.unwrap(), INIT_A);

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

        // Read back through REAL balance_of queries — the cache was refreshed post-settle.
        assert_eq!(ledger.balance_of(&payer_pk, DEMO_USD).await.unwrap(), INIT_A - 2_500);
        assert_eq!(ledger.balance_of(&merch_pk, DEMO_USD).await.unwrap(), 2_500);

        // ---- (2) relay idempotency: same submission → identical receipt, no double-settle ----
        let (s2, b2) = call(&state, pay_wire(&sa.to_wire())).await;
        assert_eq!(s2, StatusCode::OK);
        assert_eq!(b1["receipt"], b2["receipt"], "duplicate submit must replay the identical cached receipt");
        assert_eq!(b1["replayed"], false, "first settle is a fresh charge, not a replay");
        assert_eq!(b2["replayed"], true, "second identical submit must be flagged as replayed");
        assert_eq!(ledger.balance_of(&payer_pk, DEMO_USD).await.unwrap(), INIT_A - 2_500);
        assert_eq!(ledger.balance_of(&merch_pk, DEMO_USD).await.unwrap(), 2_500);

        // ---- (3) reused nonce must be rejected by the FACADE (no double-spend at the ledger) ----
        // The relay's HTTP idempotency (proven in (2)) caches by nonce, so a 2nd submit never reaches
        // the ledger. To prove the facade's own spent-nonce guard — the real double-spend defense that
        // holds even if the relay's cache were bypassed/restarted — drive `AgentLedger::pay` directly
        // with a freshly-signed authorization reusing the same nonce for a DIFFERENT amount.
        let dup = signed(&payer_sk, payer_pk, merch_pk, 1_000, nonce, now_secs() + 120);
        let err = ledger
            .pay(dup.to_wire().to_vec())
            .await
            .expect_err("facade must reject a reused nonce");
        match err {
            dpay_relay::LedgerError::Rejected(msg) => {
                assert!(msg.contains("nonce"), "expected a nonce-reuse rejection, got: {msg}");
            }
            other => panic!("expected a Rejected(nonce reuse), got {other:?}"),
        }
        // Still exactly one settlement — no double-spend on the real ledger.
        assert_eq!(ledger.balance_of(&payer_pk, DEMO_USD).await.unwrap(), INIT_A - 2_500);
        assert_eq!(ledger.balance_of(&merch_pk, DEMO_USD).await.unwrap(), 2_500);
    });

    // Tear down the gateway + replica explicitly (also happens on drop).
    pic.stop_live();
}
