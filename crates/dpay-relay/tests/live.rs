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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt; // oneshot

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use pocket_ic::PocketIc;

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

/// A minimal `icrc1_transfer` argument shape for simulating an EXTERNAL credit that BYPASSES the
/// facade (mirrors the canister test's `direct_credit` helper). `fee`/`memo` are only ever `None`
/// here, so the exact wrapper types do not matter — `None` serializes as `null`, candid-compatible
/// with any `opt T`. Field labels match the ICRC-1 TransferArg record names exactly.
#[derive(CandidType, serde::Serialize)]
struct DirectTransferArg {
    from_subaccount: Option<Vec<u8>>,
    to: Account,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<Vec<u8>>,
    created_at_time: Option<u64>,
}

/// Local candid mirrors of the canister's `MinterFamily` / `RampCapability` variants, for the
/// `register_currency_meta` cap-registration args (MC2 U1: `pay` is fail-closed on the per-currency
/// cap, so the live `pay` test must register a cap for DEMO_USD). Variant LABELS match the canister's
/// `.did` exactly — candid serde hashes the label, so declaration order is irrelevant.
#[derive(CandidType, serde::Serialize)]
enum TestMinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

#[derive(CandidType, serde::Serialize)]
enum TestRampCapability {
    Direct,
    Partner,
    Unavailable,
}

/// Register a per-tx `cap` for `currency` (MC2 U1). Mirrors the canister test's
/// `register_currency_meta_cap` — all other fields `None`/`Unavailable`. Called as the controller
/// (the live test seeds `management_canister` as the controller so this admin op is permitted).
fn register_currency_meta_cap(
    pic: &PocketIc,
    dpay: Principal,
    controller: Principal,
    currency: u32,
    cap: u64,
) {
    let reply = pic
        .update_call(
            dpay,
            controller,
            "register_currency_meta",
            encode_args((
                currency,
                None::<String>,              // symbol
                None::<u8>,                  // decimals
                None::<TestMinterFamily>,    // minter_family
                None::<String>,              // wrapper_name
                None::<String>,              // backing_symbol
                None::<String>,              // network
                None::<u8>,                  // display_decimals
                None::<u64>,                 // fee
                Some(cap),                   // cap
                None::<u32>,                 // chain_id
                None::<String>,              // token_contract
                TestRampCapability::Unavailable, // onramp
                TestRampCapability::Unavailable, // offramp
                None::<Principal>,               // gas_ledger
            ))
            .unwrap(),
        )
        .expect("register_currency_meta update_call rejected");
    decode_one::<Result<(), String>>(&reply)
        .unwrap()
        .expect("register_currency_meta should succeed for the controller");
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

    // Install the facade wired to the ledger (DUSD, mintable, seeded controller).
    //
    // MC2 U1 fallout: `pay` now reads the per-currency cap from `CURRENCY_META` (fail-closed — a
    // cap-less currency rejects every non-zero pay). This live test exercises `pay`, so it must
    // seed a controller (the management-canister principal) and register a DEMO cap. Pre-MC2 this
    // test ran in open mode (controller=None); the cap registration restores the pre-MC2 settle
    // behavior against the governed-cap gate.
    let admin = Principal::management_canister();
    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig { currency: DEMO_USD, principal: ledger, mintable: true }],
        per_tx_cap: CAP,
        controller: Some(admin),
    };
    pic.install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);
    register_currency_meta_cap(&pic, dpay, admin, DEMO_USD, CAP);
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
        // U64String (exact-amount transport): amounts cross the wire as JSON strings.
        assert_eq!(r["amount"], "2500");
        assert_eq!(r["from"], hex::encode(payer_pk));
        assert_eq!(r["to"], hex::encode(merch_pk));
        assert_eq!(r["nonce"], hex::encode(nonce));
        assert_eq!(r["new_from_balance"], (INIT_A - 2_500).to_string());

        // Read back through REAL balance_of queries — the cache was refreshed post-settle.
        assert_eq!(ledger.balance_of(&payer_pk, DEMO_USD).await.unwrap(), INIT_A - 2_500);
        assert_eq!(ledger.balance_of(&merch_pk, DEMO_USD).await.unwrap(), 2_500);

        // ---- MC4 U3: AgentLedger::receipt(nonce) recovers the signed receipt from the canister ----
        // The canister stores a signed receipt per nonce (MC4 U1+U2); the relay's durable-recovery
        // seam queries it via `receipt(blob) -> opt ReceiptView`. Round-trip the just-settled nonce
        // and assert the recovered receipt matches the settle receipt on every outcome-attestation
        // field (the ReceiptView carries no new_from_balance — that surfaces as 0 on recovery).
        let recovered = ledger
            .receipt(nonce)
            .await
            .expect("AgentLedger::receipt query")
            .expect("receipt(nonce) must be Some for a settled nonce");
        assert_eq!(recovered.from, hex::encode(payer_pk));
        assert_eq!(recovered.to, hex::encode(merch_pk));
        assert_eq!(recovered.amount, dpay_relay::U64String(2_500));
        assert_eq!(recovered.nonce, hex::encode(nonce));
        assert_eq!(recovered.currency, DEMO_USD);
        assert_eq!(recovered.new_from_balance, dpay_relay::U64String(0)); // not in ReceiptView
        assert!(!recovered.receipt_sig.is_empty(), "canister-signed sig present");
        assert!(!recovered.pubkey.is_empty(), "canister receipt pubkey present");
        // An unsettled nonce is a clean None (never a false Some).
        let miss = ledger
            .receipt([0xAAu8; 16])
            .await
            .expect("AgentLedger::receipt query for unsettled nonce");
        assert!(miss.is_none(), "an unsettled nonce must return None");

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

/// MC3 U2 — the relay's BATCH `refresh_balances` path is AUTHORITATIVE after a cache-bypassing
/// credit. Covers credits the facade cache cannot see on its own: direct ICRC transfers + async
/// ckERC20 heartbeat mints (which land on the ledger WITHOUT invoking the facade, so `BAL_CACHE`
/// stays stale). Proves the FULL contract under the batch-refresh architecture:
///
/// 1. `balance()` is a PURE fast cached query — it returns the cached `balance_of` value and does
///    NOT auto-refresh (the per-currency refresh was REMOVED from `balance()`; the authoritative
///    refresh moved to `refresh_all_if_stale`, called ONCE by the `/balances` handler).
/// 2. A direct `icrc1_transfer` to `Account{owner: facade, subaccount: payer}` (the exact shape of
///    a direct ICRC transfer / async ckERC20 heartbeat mint) leaves the cached `balance_of` query
///    STALE — and `balance()` returns that stale value (proving `balance()` does not refresh).
/// 3. `refresh_all_if_stale()` on a cold AgentLedger fires ONE batch `refresh_balances` UPDATE
///    in the background (fire-and-forget); once it lands, `balance()` reflects the authoritative
///    amount — collapsing the old N per-currency refreshes into a single consensus round.
/// 4. Within the TTL window, a second `refresh_all_if_stale()` is a NO-OP (the TTL gate prevents a
///    redundant refresh) — `balance()` returns the stale cached value, proving the gate.
#[test]
fn balance_and_batch_refresh_are_authoritative_after_cache_bypass_credit() {
    let mut pic = PocketIc::new();
    let gateway_url = pic.make_live(None).to_string();

    // The facade owns the ledger's minting account, so a direct `icrc1_transfer` AS the facade
    // with `from_subaccount: None` debits the minting account — ICRC treats that as a MINT. This is
    // exactly how a direct ICRC transfer / async ckERC20 heartbeat mint lands funds at the user's
    // facade subaccount with the facade NEVER invoked.
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

    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig { currency: DEMO_USD, principal: ledger, mintable: true }],
        per_tx_cap: CAP,
        controller: None,
    };
    pic.install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);
    let canister_id: Principal = dpay;

    // Fund the payer through the self-service faucet (the demo on-ramp). This populates the cache
    // AND — once the relay reads it — sets `last_refresh` for this (pubkey, currency).
    let payer_sk = generate_keypair();
    let payer_pk = payer_sk.verifying_key().to_bytes();
    let mint_reply = pic
        .update_call(dpay, Principal::anonymous(), "faucet", encode_args((payer_pk.to_vec(), DEMO_USD)).unwrap())
        .expect("faucet update rejected");
    let minted = decode_one::<Result<u64, String>>(&mint_reply).unwrap().expect("faucet must succeed");
    assert_eq!(minted, INIT_A);

    const CREDIT: u64 = 7_300; // the cache-bypassing external credit (e.g. direct ICRC transfer)

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    // ---- Phase 1 (async): connect + cold-start balance() is a PURE fast query. ----
    // The faucet pre-warmed the facade cache to INIT_A, so `balance()` (now a pure cached query,
    // no auto-refresh) returns INIT_A immediately. Proves `balance()` returns the cached value.
    let agent_ledger = rt
        .block_on(async {
            let l = AgentLedger::connect(&gateway_url, canister_id)
                .await
                .expect("AgentLedger must connect to the live gateway");
            let bal0 = l.balance(payer_pk, DEMO_USD).await.expect("cold-start balance");
            assert_eq!(
                bal0, INIT_A,
                "cold-start balance() returns the cached value (faucet pre-warmed the cache)",
            );
            l
        });

    // ---- Phase 2 (sync): the cache-bypassing credit. ----
    // A direct `icrc1_transfer` ON the ledger, AS the facade (minting-account owner),
    // `from_subaccount: None` (mint), to the payer's subaccount. The facade is NEVER invoked, so
    // its `BAL_CACHE` stays stale. (Done OUTSIDE the tokio runtime to avoid a runtime-in-runtime.)
    let credit_reply = pic
        .update_call(
            ledger,
            dpay, // caller = the facade = the minting-account owner
            "icrc1_transfer",
            encode_one(&DirectTransferArg {
                from_subaccount: None,
                to: Account { owner: dpay, subaccount: Some(payer_pk) },
                amount: Nat::from(CREDIT),
                fee: None,
                memo: None,
                created_at_time: Some(now_secs().saturating_mul(1_000_000_000)),
            })
            .unwrap(),
        )
        .expect("direct icrc1_transfer (cache-bypassing credit) rejected");
    decode_one::<Result<Nat, candid::Reserved>>(&credit_reply)
        .expect("direct icrc1_transfer reply decode")
        .expect("direct credit transfer should succeed (minting account debited)");

    // ---- Phase 3 (async): balance() returns the STALE cached value (pure query, no refresh). ----
    // This is the KEY behavior change: `balance()` no longer auto-refreshes. The cache is stale at
    // INIT_A (the credit bypassed the facade), and `balance()` returns that stale value — proving
    // the per-currency refresh was removed from `balance()`. The authoritative refresh now lives in
    // `refresh_all_if_stale` (Phase 4).
    //
    // Each `block_on` borrows `agent_ledger` by shared reference (taken outside the async block so
    // `async move` copies the reference, not the ledger — `AgentLedger` is not `Clone`, and Phases
    // 4+5 must share its `last_refresh` so the TTL gate is observable).
    {
        let l = &agent_ledger;
        rt.block_on(async move {
            // The cached `balance_of` query is STALE — the credit bypassed the facade.
            let stale = l.balance_of(&payer_pk, DEMO_USD).await.expect("balance_of query");
            assert_eq!(
                stale, INIT_A,
                "cached balance_of must be STALE after a facade-bypassing credit",
            );

            // balance() is a PURE fast query → returns the SAME stale cached value (NO auto-refresh).
            let bal = l.balance(payer_pk, DEMO_USD).await.expect("balance()");
            assert_eq!(
                bal, INIT_A,
                "balance() must return the stale cached value — it no longer auto-refreshes \
                 (the per-currency refresh moved to refresh_all_if_stale)",
            );
        });
    }

    // ---- Phase 4 (async): refresh_all_if_stale fires the batch → cache refreshed. ----
    // A cold AgentLedger has NO `last_refresh` entries → `any_stale_for` is true →
    // `refresh_all_if_stale` spawns ONE `refresh_balances` update (fire-and-forget). Once it
    // lands, the canister's BAL_CACHE is refreshed for ALL currencies, so `balance()` reflects the
    // authoritative amount. The poll loop drives the runtime (yields via sleep) so the spawned task
    // makes progress on its IC update call.
    {
        let l = &agent_ledger;
        rt.block_on(async move {
            // Fire-and-forget: spawns the batch task and returns immediately.
            l.refresh_all_if_stale(payer_pk).await;

            // Poll until the background batch refresh lands (writes BAL_CACHE on the canister).
            let mut landed = false;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            while tokio::time::Instant::now() < deadline {
                // Yield to the runtime so the spawned task (IC update call) can make progress.
                tokio::time::sleep(Duration::from_millis(200)).await;
                let bal = l.balance(payer_pk, DEMO_USD).await.expect("balance() poll");
                if bal == INIT_A + CREDIT {
                    landed = true;
                    break;
                }
            }
            assert!(
                landed,
                "refresh_all_if_stale spawn must land within 30s and refresh the cache to the \
                 authoritative amount",
            );

            // Give the spawned task a moment to finish marking `last_refresh` fresh (it does so
            // right after the canister cache write — a tiny window) before Phase 5 checks the gate.
            tokio::time::sleep(Duration::from_millis(500)).await;

            // balance() now returns the AUTHORITATIVE amount (cache was refreshed by the batch).
            let bal = l.balance(payer_pk, DEMO_USD).await.expect("post-refresh balance()");
            assert_eq!(
                bal, INIT_A + CREDIT,
                "balance() must reflect the authoritative amount after the batch refresh landed",
            );
        });
    }

    // ---- Phase 5: within-TTL refresh_all_if_stale is a NO-OP (TTL gate). ----
    // Phase 4's spawn marked (payer, DEMO_USD) fresh in `last_refresh`. A second
    // `refresh_all_if_stale` within the TTL window must NOT spawn (the TTL gate returns false). To
    // prove the no-op, we make the cache STALE again (a second credit) and verify the cache does NOT
    // refresh over a window long enough that a spawn (if the gate broke and fired one) would have
    // landed. On the local PocketIC gateway an update lands in ~1-2s, so a 8s window is generous.
    const CREDIT_2: u64 = 9_100; // second cache-bypassing credit
    let baseline = INIT_A + CREDIT; // cache + ledger agree here (Phase 4 left them in sync)

    // (a) Second direct credit. Ledger += CREDIT_2; facade cache stays at `baseline`.
    let credit2_reply = pic
        .update_call(
            ledger,
            dpay, // caller = facade = minting-account owner → debits the mint account (a MINT)
            "icrc1_transfer",
            encode_one(&DirectTransferArg {
                from_subaccount: None,
                to: Account { owner: dpay, subaccount: Some(payer_pk) },
                amount: Nat::from(CREDIT_2),
                fee: None,
                memo: None,
                created_at_time: Some(now_secs().saturating_mul(1_000_000_000)),
            })
            .unwrap(),
        )
        .expect("second direct icrc1_transfer (cache-bypassing credit_2) rejected");
    decode_one::<Result<Nat, candid::Reserved>>(&credit2_reply)
        .expect("second credit reply decode")
        .expect("credit_2 transfer should succeed (minting account debited)");

    // (b) refresh_all_if_stale again — entries are FRESH (Phase 4 marked them < TTL ago) → no spawn.
    //     Poll for 8s; the cache must STAY stale at `baseline` (no spawn fired). A broken
    //     always-spawn gate would land a refresh within ~2s and the cache would jump to
    //     `baseline + CREDIT_2` → the assertion below would catch it.
    {
        let l = &agent_ledger;
        rt.block_on(async move {
            // The TTL gate sees the fresh entry → no spawn.
            l.refresh_all_if_stale(payer_pk).await;

            // Observe over a window long enough for a hypothetical spawn to land.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
            while tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let bal = l.balance(payer_pk, DEMO_USD).await.expect("balance() poll");
                assert_eq!(
                    bal, baseline,
                    "within-TTL refresh_all_if_stale must be a no-op (TTL gate holds) — cache must \
                     stay stale at baseline; if it refreshed, the TTL gate is broken (always spawns)",
                );
            }
        });
    }

    pic.stop_live();
}
