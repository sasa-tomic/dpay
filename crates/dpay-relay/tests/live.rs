//! LIVE integration test for the post-cutover READ surface (feature `agent`).
//!
//! 2026-08-19 IC user-principal-rail cutover: value movement LEFT the relay entirely — the app
//! signs /api/v2 envelopes locally (dpay-icp) and POSTs them to boundary nodes. What the relay
//! still owns in prod is the READ surface, and this test proves exactly that surface against a
//! REAL local IC: PocketIC's HTTP gateway + the REAL DFINITY ic-icrc1-ledger + the dpay facade
//! canister (which now only contributes the CATALOG — currencies/deposit metadata; it is no
//! longer in the value path, so nothing here settles through it).
//!
//! The money-critical assertion is the ACCOUNT SHAPE: funds are minted directly on the ledger at
//! `Account{owner: self_authenticating_ed25519(payer pubkey), subaccount: None}` — the exact
//! account the app's signed icrc1_transfer envelopes move — and `GET /api/v1/balances/{hex}` must
//! read them back there (`AgentLedger::balance_on_ledger` derives the SAME owner via dpay-icp's
//! golden-proven derivation). If the relay and the app ever disagreed on the account shape,
//! balances would read 0 while funds sit "lost" at a different principal; this test is the live
//! tripwire for exactly that regression class.
//!
//! Asserts, all THROUGH THE HTTP ROUTES (oneshot on the real axum app + `AgentLedger` + ic-agent;
//! no direct trait calls — the prod wire surface is the thing under test):
//!   1. `GET /api/v1/health` → 200 `{"status":"ok"}` (real replica `status` round-trip);
//!   2. `GET /api/v1/currencies` → 200, the DUSD row present (currency code + ledger principal
//!      TEXT matching the real ledger canister's canonical id — proves the catalog fan-out target);
//!   3. `GET /api/v1/balances/{hex}` → the minted amount as a decimal STRING for DUSD; a SECOND
//!      user principal minted a different amount reads independently; an UNFUNDED principal reads
//!      "0" (batch map = exactly the catalog's one entry);
//!   4. `GET /api/v1/transactions/{hex}?currency=N` → 200 with a well-formed rows array (shape
//!      only — the facade's history records facade-settled ops, not rail transfers, so it is
//!      honestly EMPTY here; asserted as JSON shape, not content).
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

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt; // oneshot

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use pocket_ic::PocketIc;

use dpay_core::{generate_keypair, DEMO_USD};
use dpay_relay::{app, AgentLedger, AppState};
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::{TransferArg, TransferError};

const CAP: u64 = 100_000; // per-tx cap: $1,000.00 (registered into CURRENCY_META below)
const INIT_A: u64 = 10_000; // first user opens with $100.00 minted AT their principal
const INIT_B: u64 = 3_333; // second user gets a DIFFERENT amount (balance-independence proof)

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

/// Local candid mirrors of the canister's `MinterFamily` / `RampCapability` variants, for the
/// `register_currency_meta` cap-registration args. Post-cutover this registration is catalog
/// parity, not a pay gate (there is no pay): the prod register flow (`scripts/dfx-deploy-ic.sh`)
/// seeds CURRENCY_META for every currency, so the live catalog proof mirrors prod by registering
/// the DEMO cap too. Variant LABELS match the canister's `.did` exactly — candid serde hashes the
/// label, so declaration order is irrelevant.
// Complete candid mirrors of the canister's variants — every label must exist so the record
// encodes against the real `.did`, but this test only ever constructs `Unavailable`, so the
// unconstructed variants are `allow(dead_code)` by design (a partial mirror would silently
// change the candid label hashing and corrupt the registration args).
#[allow(dead_code)]
#[derive(CandidType, serde::Serialize)]
enum TestMinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

#[allow(dead_code)]
#[derive(CandidType, serde::Serialize)]
enum TestRampCapability {
    Direct,
    Partner,
    Unavailable,
}

/// Register a per-tx `cap` for `currency`. Mirrors the canister test's `register_currency_meta_cap`
/// — all other fields `None`/`Unavailable`. Called as the controller (this live test seeds
/// `management_canister` as the controller so this admin op is permitted).
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

/// A plain GET request for `uri` (every assertion here is a read — the value-path routes are gone).
fn get(uri: &str) -> Request<Body> {
    Request::builder().method("GET").uri(uri).body(Body::empty()).unwrap()
}

async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

/// RAII ownership wrapper ensuring `stop_live()` runs on EVERY exit path. The historical failure
/// mode was FAIL+LEAK: an assert panicked mid-test, the trailing `pic.stop_live()` never ran, and
/// the PocketIC gateway process outlived the test. `Drop` runs during unwinding too, so the
/// gateway always comes down — success, assert failure, or runtime error alike.
struct LivePocketIc(PocketIc);

impl Drop for LivePocketIc {
    fn drop(&mut self) {
        self.0.stop_live();
    }
}

/// Mint `amount` minor units directly ON the real ledger, AT the user's self-authenticating
/// principal — the rail-side funding shape post-cutover (NO facade custody hop, no faucet). The
/// sender is the FACADE canister principal, which owns the ledger's minting account (a transfer
/// out of the minting account IS the ICRC-1 mint path — the same move the facade's own
/// controller-gated `mint` makes). The destination account is derived exactly the way the app's
/// signer and `AgentLedger::balance_on_ledger` both derive it:
/// `owner = self_authenticating_ed25519(pubkey), subaccount = None` — so whatever this mints MUST
/// show up in the relay's balance batch, or the read path's account shape has regressed.
fn mint_at_user_principal(
    pic: &PocketIc,
    ledger: Principal,
    facade: Principal,
    pubkey: &[u8; 32],
    amount: u64,
) {
    let owner = dpay_icp::principal::Principal::self_authenticating_ed25519(pubkey);
    let arg = TransferArg {
        from_subaccount: None, // the minting account's default subaccount
        to: Account { owner: Principal::from_slice(owner.as_slice()), subaccount: None },
        fee: None, // transfer_fee is 0; mints carry no fee
        created_at_time: None, // no dedup window wanted between distinct test mints
        memo: None,
        amount: Nat::from(amount),
    };
    let reply = pic
        .update_call(ledger, facade, "icrc1_transfer", encode_one(&arg).unwrap())
        .expect("icrc1_transfer update_call rejected");
    match decode_one::<Result<Nat, TransferError>>(&reply).unwrap() {
        Ok(_) => {}
        Err(e) => panic!("ledger mint at user principal failed: {e:?}"),
    }
}

#[test]
fn live_read_surface_at_user_principal() {
    // PocketIC's server child must not inherit this test binary's stdio pipes (see the teardown
    // comment at the bottom for the full why); the env var is read at server spawn, i.e. it MUST
    // be set before the first PocketIc::new() — hence here, at the very top of the test.
    std::env::set_var("POCKET_IC_MUTE_SERVER", "1");

    // --- 1. Stand up a real local IC with an HTTP gateway (blocking; own runtime). ---
    let mut pic = PocketIc::new();
    let gateway_url = pic.make_live(None).to_string();
    let pic = LivePocketIc(pic); // from here, teardown is guaranteed on every exit path

    // --- 2. Install a real ICRC ledger + the facade (catalog) wired to it. ---
    let payer_pk = generate_keypair().verifying_key().to_bytes();
    let second_pk = generate_keypair().verifying_key().to_bytes();

    // Reserve the facade id first — the ledger's minting account owner must be the facade.
    let dpay = pic.0.create_canister();
    pic.0.add_cycles(dpay, 2_000_000_000_000);

    let ledger = pic.0.create_canister();
    pic.0.add_cycles(ledger, 10_000_000_000_000);
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
    pic.0.install_canister(ledger, ledger_wasm(), encode_one(&ledger_init).unwrap(), None);

    // Install the facade wired to the ledger (DUSD, mintable, seeded controller). Post-cutover the
    // facade's job in this test is the CATALOG: `currencies()` joins its LEDGERS registration with
    // CURRENCY_META — that catalog row is what the balances batch fans out against and what the
    // wallet renders. It is deliberately NOT used to move value anywhere in this test.
    let admin = Principal::management_canister();
    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig { currency: DEMO_USD, principal: ledger, mintable: true }],
        per_tx_cap: CAP,
        controller: Some(admin),
    };
    pic.0.install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);
    // Prod register parity: seed the DEMO cap into CURRENCY_META exactly as dfx-deploy-ic does,
    // so the catalog row this test asserts on mirrors the prod-registered shape.
    register_currency_meta_cap(&pic.0, dpay, admin, DEMO_USD, CAP);
    let ledger_text = ledger.to_text();
    let canister_id = dpay;

    // Fund TWO users at their own principals, directly on the rail. Different amounts so a
    // balance cross-read between the two accounts cannot pass by accident.
    mint_at_user_principal(&pic.0, ledger, dpay, &payer_pk, INIT_A);
    mint_at_user_principal(&pic.0, ledger, dpay, &second_pk, INIT_B);

    // --- 3. Everything from here is async: AgentLedger (ic-agent) + the relay's axum app. ---
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        // Point the real ledger at the live gateway + facade. `connect` fetches the root key
        // (required off mainnet) — if the gateway weren't truly live this would fail.
        let agent = AgentLedger::connect(&gateway_url, canister_id)
            .await
            .expect("AgentLedger must connect to the live gateway");
        let state = AppState::new(Arc::new(agent));
        let key = DEMO_USD.to_string(); // the batch map's JSON key: currency index as a string

        // ---- (1) health: the real replica `status` round-trip ----
        let (hs, hb) = call(&state, get("/api/v1/health")).await;
        assert_eq!(hs, StatusCode::OK, "health body={hb}");
        assert_eq!(hb["status"], "ok");

        // ---- (2) currencies: the DUSD row with the REAL ledger's canonical principal text ----
        let (cs, cb) = call(&state, get("/api/v1/currencies")).await;
        assert_eq!(cs, StatusCode::OK, "currencies body={cb}");
        let rows = cb["currencies"]
            .as_array()
            .unwrap_or_else(|| panic!("currencies must be an array: {cb}"));
        let dusd = rows
            .iter()
            .find(|d| d["currency"].as_u64() == Some(u64::from(DEMO_USD)))
            .unwrap_or_else(|| panic!("catalog must contain the DUSD (currency {DEMO_USD}) row: {cb}"));
        assert_eq!(
            dusd["ledger"].as_str(),
            Some(ledger_text.as_str()),
            "DUSD row must name the real ledger's canonical principal text (row={dusd})"
        );

        // ---- (3) balances: the USER-PRINCIPAL account shape against the real ledger ----
        // The mints in §2 landed at Account{owner: self_auth(pk), subaccount: None}; the batch
        // route fans `balance_on_ledger` out per catalog currency with the SAME derivation. An
        // account-shape regression on either side reads 0 here — that is the tripwire.
        let (ps, pb) = call(&state, get(&format!("/api/v1/balances/{}", hex::encode(payer_pk)))).await;
        assert_eq!(ps, StatusCode::OK, "payer balances body={pb}");
        assert_eq!(pb[key.as_str()], INIT_A.to_string(), "payer DUSD must read the minted amount (body={pb})");
        // The catalog has exactly one currency (DUSD), so the fan-out map has exactly one entry —
        // no phantom rows, no dropped rows.
        assert_eq!(
            pb.as_object().map(|m| m.len()),
            Some(1),
            "the batch map must carry exactly the catalog's one entry (body={pb})"
        );

        // Second user: independent balance (different amount, different principal).
        let (ss, sb) = call(&state, get(&format!("/api/v1/balances/{}", hex::encode(second_pk)))).await;
        assert_eq!(ss, StatusCode::OK, "second-user balances body={sb}");
        assert_eq!(sb[key.as_str()], INIT_B.to_string(), "second user must read their OWN mint (body={sb})");

        // Independence cross-check: the second mint must not have touched the first user.
        let (rs, rb) = call(&state, get(&format!("/api/v1/balances/{}", hex::encode(payer_pk)))).await;
        assert_eq!(rs, StatusCode::OK, "payer re-read body={rb}");
        assert_eq!(rb[key.as_str()], INIT_A.to_string(), "payer balance must be unchanged by the second mint (body={rb})");

        // An UNFUNDED principal reads a clean "0" — not an error, not a missing key.
        let unfunded_pk = generate_keypair().verifying_key().to_bytes();
        let (us, ub) = call(&state, get(&format!("/api/v1/balances/{}", hex::encode(unfunded_pk)))).await;
        assert_eq!(us, StatusCode::OK, "unfunded balances body={ub}");
        assert_eq!(ub[key.as_str()], "0", "an unfunded principal must read \"0\" (body={ub})");

        // ---- (4) transactions: JSON shape only (honestly) ----
        // The facade's `transactions_of` reads its ACCOUNT_TXNS history, which only facade-settled
        // ops (pay/mint/faucet) ever wrote — rail transfers like the mints above do NOT flow into
        // it, and there were no facade-settled ops in this test. So the honest assertion is the
        // wire SHAPE (a rows array the wallet can render), not the content.
        let (ts, tb) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=10",
                hex::encode(payer_pk),
                DEMO_USD
            )),
        )
        .await;
        assert_eq!(ts, StatusCode::OK, "transactions body={tb}");
        assert!(tb["transactions"].is_array(), "transactions must carry a rows array (body={tb})");
    });

    // --- 4. Leak-proof teardown ---
    // pocket-ic spawns `pocket-ic-server` as a child process in its own process group and NEVER
    // kills or reaps it client-side (upstream TODO SDK-1936): `stop_live()` + Drop's instance
    // DELETE tear down OUR instance, but the server process itself deliberately outlives it
    // (TTL-based lifetime, shared-server design). A child that inherits the test process's
    // stdout/stderr keeps those pipes open after the test binary exits — nextest's leak detector
    // waits for pipe EOF and flags exactly that (we reproduced it: PASS under --no-capture,
    // LEAK under capture, identical code). The client library's own escape hatch is
    // POCKET_IC_MUTE_SERVER (checked at server spawn): it redirects the child's stdio to null so
    // the pipes close at test exit. Set BEFORE the first PocketIc::new() above; safe here because
    // this binary runs a single test and no pocket-ic threads exist yet at that point.
    // LivePocketIc::drop → stop_live() + instance DELETE still runs on every exit path (incl.
    // panic) — that frees the instance's server-side state; only the server PROCESS lingers.
}
