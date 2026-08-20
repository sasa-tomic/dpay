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
//!   4. `GET /api/v1/transactions/{hex}?currency=N` → 200 with a well-formed rows array (the
//!      facade-history era is over; see `live_icrc3_history_walks_the_real_ledger_log` below for
//!      the CONTENT assertions — this one only proves the shape for an account with no rows).
//!   5. `GET /api/v1/onramp/ckerc20?currency=N` → the CkDeposit `helper_address` read at RUNTIME
//!      from the currency's registered minter (`get_minter_info`), with the verified compile-time
//!      constant served only on logged fallback (see
//!      `live_ckerc20_onramp_helper_read_at_runtime_with_constant_fallback` below).
//!
//! Prereqs (the justfile's `test-live` recipe wires these):
//!   - build the wasm first:
//!       CARGO_TARGET_DIR=.dev/target-relay cargo build -p dpay-canister \
//!           --target wasm32-unknown-unknown --release
//!       CARGO_TARGET_DIR=.dev/target-relay cargo build -p dpay-mock-minter \
//!           --target wasm32-unknown-unknown --release
//!   - `DPAY_CANISTER_WASM` → that wasm; `DPAY_MOCK_MINTER_WASM` → the mock-minter wasm;
//!     `POCKET_IC_BIN` → the vendored pocket-ic server;
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

/// A user→user `icrc1_transfer` on the real ledger, sent BY the payer's own principal (the
/// rail-side move the app's signed envelopes make). Distinct memos make the transfers
/// ledger-distinct (the ICRC ledger dedups identical `(from_subaccount, to, amount, fee,
/// created_at_time, memo)` tuples within its dedup window).
fn rail_transfer(
    pic: &PocketIc,
    ledger: Principal,
    sender_pk: &[u8; 32],
    to_pk: &[u8; 32],
    amount: u64,
    memo: &[u8],
) {
    let sender = dpay_icp::principal::Principal::self_authenticating_ed25519(sender_pk);
    let to_owner = dpay_icp::principal::Principal::self_authenticating_ed25519(to_pk);
    let arg = TransferArg {
        from_subaccount: None,
        to: Account { owner: Principal::from_slice(to_owner.as_slice()), subaccount: None },
        fee: None,
        created_at_time: None,
        memo: Some(icrc_ledger_types::icrc1::transfer::Memo::from(memo.to_vec())),
        amount: Nat::from(amount),
    };
    let reply = pic
        .update_call(ledger, Principal::from_slice(sender.as_slice()), "icrc1_transfer", encode_one(&arg).unwrap())
        .expect("icrc1_transfer update_call rejected");
    match decode_one::<Result<Nat, TransferError>>(&reply).unwrap() {
        Ok(_) => {}
        Err(e) => panic!("rail transfer failed: {e:?}"),
    }
}

/// Stand up the live IC + real ICRC ledger + facade catalog — the shared fixture of both tests
/// below. Returns the RAII-guarded PocketIC (keep it alive for the test's duration), the ledger
/// canister, and the facade canister. The ledger's minting account is owned by the FACADE, so
/// `mint_at_user_principal` (sent as the facade) is the ICRC-1 mint path.
fn stand_up() -> (LivePocketIc, Principal, Principal, String) {
    // PocketIC's server child must not inherit this test binary's stdio pipes (see the teardown
    // comment at the bottom for the full why); the env var is read at server spawn, i.e. it MUST
    // be set before the first PocketIc::new().
    std::env::set_var("POCKET_IC_MUTE_SERVER", "1");

    let mut pic = PocketIc::new();
    let gateway_url = pic.make_live(None).to_string();
    let pic = LivePocketIc(pic); // from here, teardown is guaranteed on every exit path

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
    // facade's job here is the CATALOG: `currencies()` joins its LEDGERS registration with
    // CURRENCY_META — that catalog row is what the balances batch fans out against, what the
    // transactions handler resolves the ledger principal from, and what the wallet renders. It is
    // deliberately NOT used to move value anywhere in these tests.
    let admin = Principal::management_canister();
    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig { currency: DEMO_USD, principal: ledger, mintable: true }],
        per_tx_cap: CAP,
        controller: Some(admin),
    };
    pic.0.install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);
    // Prod register parity: seed the DEMO cap into CURRENCY_META exactly as dfx-deploy-ic does,
    // so the catalog row these tests assert on mirrors the prod-registered shape.
    register_currency_meta_cap(&pic.0, dpay, admin, DEMO_USD, CAP);

    (pic, ledger, dpay, gateway_url)
}

#[test]
fn live_read_surface_at_user_principal() {
    // --- 1. Stand up a real local IC with an HTTP gateway (blocking; own runtime). ---
    let (pic, ledger, dpay, gateway_url) = stand_up();

    // --- 2. Fund TWO users at their own principals, directly on the rail. ---
    let payer_pk = generate_keypair().verifying_key().to_bytes();
    let second_pk = generate_keypair().verifying_key().to_bytes();
    mint_at_user_principal(&pic.0, ledger, dpay, &payer_pk, INIT_A);
    mint_at_user_principal(&pic.0, ledger, dpay, &second_pk, INIT_B);

    let ledger_text = ledger.to_text();
    let canister_id = dpay;

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

        // ---- (4) transactions: shape for an account with no DUSD rows ----
        // The payer HAS history rows now (the mints above — see the icrc3 test below for the
        // content assertions); this read uses a currency whose log exists but has no rows for
        // this user… except DUSD is the only currency, and the mints DID touch the payer. So the
        // honest shape-only read here is the UNFUNDED principal: rows exist on the ledger, just
        // none concerning this account — the response must be 200 with an EMPTY array.
        let (us, ub) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=10",
                hex::encode(unfunded_pk),
                DEMO_USD
            )),
        )
        .await;
        assert_eq!(us, StatusCode::OK, "unfunded transactions body={ub}");
        assert_eq!(
            ub["transactions"].as_array().map(Vec::len),
            Some(0),
            "an account with no ledger rows must read an EMPTY array, not an error (body={ub})"
        );
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
    // each test sets it before spawning its own instance and no pocket-ic threads exist yet at
    // that point. LivePocketIc::drop → stop_live() + instance DELETE still runs on every exit
    // path (incl. panic) — that frees the instance's server-side state; only the server PROCESS
    // lingers.
}

/// WAVE 3 — the real icrc3 history walk. `GET /api/v1/transactions/{hex}` must serve the LEDGER's
/// own transaction log (walked via `get_transactions`), not a facade index: seeding a mint, two
/// user→user transfers, and a burn-free mix on the REAL ic-icrc1-ledger, the relay must return
/// the payer's rows newest-first with correct direction, amount, principal-text counterparties,
/// memo hex, a clamped limit, and an empty array for a no-match account.
#[test]
fn live_icrc3_history_walks_the_real_ledger_log() {
    let (pic, ledger, dpay, gateway_url) = stand_up();

    // Payer: mint (in) → transfer OUT to merchant → transfer IN back. Distinct memos keep the
    // two transfers ledger-distinct inside the dedup window.
    let payer_pk = generate_keypair().verifying_key().to_bytes();
    let merchant_pk = generate_keypair().verifying_key().to_bytes();
    mint_at_user_principal(&pic.0, ledger, dpay, &payer_pk, 10_000);
    rail_transfer(&pic.0, ledger, &payer_pk, &merchant_pk, 250, b"coffee");
    rail_transfer(&pic.0, ledger, &merchant_pk, &payer_pk, 100, b"change");

    let payer_owner = Principal::from_slice(
        dpay_icp::principal::Principal::self_authenticating_ed25519(&payer_pk).as_slice(),
    );
    let merchant_owner = Principal::from_slice(
        dpay_icp::principal::Principal::self_authenticating_ed25519(&merchant_pk).as_slice(),
    );
    let canister_id = dpay;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        let agent = AgentLedger::connect(&gateway_url, canister_id)
            .await
            .expect("AgentLedger must connect to the live gateway");
        let state = AppState::new(Arc::new(agent));

        // ---- (1) the payer's history: 3 rows, newest-first, direction+amount+counterparty ----
        let (s, b) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=30",
                hex::encode(payer_pk),
                DEMO_USD
            )),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "transactions body={b}");
        let rows = b["transactions"]
            .as_array()
            .unwrap_or_else(|| panic!("transactions must be an array: {b}"));
        assert_eq!(rows.len(), 3, "mint + out-transfer + in-transfer (body={b})");

        // Newest-first: the in-transfer (100) landed last.
        let r0 = &rows[0];
        assert_eq!(r0["amount"].as_str(), Some("100"), "newest row is the 100 in-transfer");
        assert_eq!(r0["from"].as_str(), Some(merchant_owner.to_text().as_str()));
        assert_eq!(r0["to"].as_str(), Some(payer_owner.to_text().as_str()));
        assert_eq!(
            r0["memo"].as_str(),
            Some(hex::encode("change").as_str()),
            "memo renders as hex bytes"
        );
        assert_eq!(r0["currency"].as_u64(), Some(u64::from(DEMO_USD)));
        assert!(r0["timestamp"].as_u64().is_some(), "timestamp is a unix-seconds number");

        // Middle: the out-transfer (250) — from = payer.
        let r1 = &rows[1];
        assert_eq!(r1["amount"].as_str(), Some("250"));
        assert_eq!(r1["from"].as_str(), Some(payer_owner.to_text().as_str()));
        assert_eq!(r1["to"].as_str(), Some(merchant_owner.to_text().as_str()));

        // Oldest: the mint (10_000) — `from` is the empty mint sentinel, `to` = payer.
        let r2 = &rows[2];
        assert_eq!(r2["amount"].as_str(), Some("10000"));
        assert_eq!(r2["from"].as_str(), Some(""), "mint renders the empty-from sentinel");
        assert_eq!(r2["to"].as_str(), Some(payer_owner.to_text().as_str()));

        // ---- (2) limit clamp: ?limit=1 keeps exactly the NEWEST row ----
        let (ls, lb) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=1",
                hex::encode(payer_pk),
                DEMO_USD
            )),
        )
        .await;
        assert_eq!(ls, StatusCode::OK, "limit body={lb}");
        let lrows = lb["transactions"].as_array().unwrap();
        assert_eq!(lrows.len(), 1, "limit=1 clamps to one row");
        assert_eq!(lrows[0]["amount"].as_str(), Some("100"), "the kept row is the NEWEST");

        // ---- (3) no-match account: 200 + empty array (not 404, not an error) ----
        let stranger_pk = generate_keypair().verifying_key().to_bytes();
        let (ss, sb) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=30",
                hex::encode(stranger_pk),
                DEMO_USD
            )),
        )
        .await;
        assert_eq!(ss, StatusCode::OK, "stranger body={sb}");
        assert_eq!(
            sb["transactions"].as_array().map(Vec::len),
            Some(0),
            "no ledger rows for this account ⇒ empty array (body={sb})"
        );
    });
}

// --- WAVE 5: runtime ckERC20-helper read ---------------------------------------------------------
//
// The ckERC20/native-ETH onramp's CkDeposit `helper_address` is deploy state the ckETH-minter
// operator can MOVE (a helper/minter upgrade deploys a new contract). Serving the compile-time
// constants unconditionally would silently strand deposits after such an upgrade; the agent path
// therefore reads the CURRENT address from the currency's registered minter at request time
// (`get_minter_info.deposit_with_subaccount_helper_contract_address`, a query) and falls back to
// the verified constants only when that read fails or the minter leaves the field unset (logged).
// This test proves BOTH halves live through the HTTP route:
//   - a minter configured with a sentinel address that exists nowhere in the relay's compiled
//     constants must be surfaced VERBATIM (the runtime read wins, and a second call after the
//     minter changes its address must reflect the change — not a cache);
//   - a same-family currency whose minter leaves the field unset must serve the chain_id-scoped
//     verified constant (the fallback path).
//
// Fixture: TWO instances of the test-only mock-minter canister (`dpay-mock-minter`, never
// shipped to mainnet). The mock's `MinterInfo` extends the real ckBTC shape with the ckETH
// minter's `deposit_with_subaccount_helper_contract_address: opt text` field (candid record
// subtyping keeps the facade's BTC-shaped decode working) plus a `set_deposit_helper_address`
// test hook. Minter A gets the sentinel set (and later changed); minter B stays at the None
// default.

/// The mock-minter canister's init payload (mirrors `dpay-mock-minter`'s `InitArg`).
#[derive(CandidType, serde::Serialize)]
struct MockMinterInit {
    amount_ledger: Principal,
    gas_ledger: Option<Principal>,
}

/// Env-var-driven wasm path for the mock minter (mirrors `DPAY_CANISTER_WASM`'s pattern).
fn mock_minter_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_MOCK_MINTER_WASM").unwrap_or_else(|_| {
        ".dev/target-relay/wasm32-unknown-unknown/release/dpay_mock_minter.wasm".into()
    });
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read mock-minter wasm at {path}: {e}"))
}

/// Sentinel helper addresses that exist NOWHERE in the relay's compiled constants — if either
/// shows up in a response, it can only have arrived via the runtime minter read over the wire.
const RUNTIME_HELPER_SENTINEL_A: &str = "0x5E71A00000000000000000000000000000000A71A";
const RUNTIME_HELPER_SENTINEL_B: &str = "0x5E71B00000000000000000000000000000000B71B";

/// The verified mainnet constant, duplicated here ONLY to assert the fallback outcome — the
/// assertion documents WHAT the fallback serves (kept in sync with
/// `ledger::ckerc20::CKERC20_HELPER_ADDRESS_MAINNET`, `pub(crate)` so not importable).
const EXPECTED_FALLBACK_HELPER_MAINNET: &str = "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68";

/// Currency ids used only by this test: `register_ledger`/`register_minter`/
/// `register_currency_meta` are controller-gated with arbitrary ids allowed, and no value path
/// touches these rows (the onramp route only reads catalog metadata + the minter query).
const ONRAMP_SENTINEL_CURRENCY: u32 = 4; // CkEthErc20, mainnet chain_id, minter A (sentinel)
const ONRAMP_FALLBACK_CURRENCY: u32 = 2; // CkEthErc20, mainnet chain_id, minter B (field unset)

/// The ckETH-minter fixture proved live: the onramp's `helper_address` is the address the
/// currency's registered MINTER serves (runtime `get_minter_info` read — minter B proves the
/// logged-constant fallback), and a minter-side change is reflected on the very next request
/// (no caching). Proves the whole WAVE-5 agent-path contract through the HTTP route.
#[test]
fn live_ckerc20_onramp_helper_read_at_runtime_with_constant_fallback() {
    std::env::set_var("POCKET_IC_MUTE_SERVER", "1");
    let mut pic = PocketIc::new();
    let gateway_url = pic.make_live(None).to_string();
    let pic = LivePocketIc(pic);

    // Controller + facade + a real ICRC ledger for the two descriptors. The ledger principal is
    // catalog metadata here — no balances move — but registering the real wasm keeps the rows
    // honest and reuses `stand_up`'s proven init shape.
    let admin = Principal::management_canister();
    let dpay = pic.0.create_canister();
    pic.0.add_cycles(dpay, 2_000_000_000_000);
    let ledger = pic.0.create_canister();
    pic.0.add_cycles(ledger, 10_000_000_000_000);
    let ledger_init = LedgerArg::Init(LedgerInitArgs {
        minting_account: Account { owner: dpay, subaccount: None },
        fee_collector_account: None,
        transfer_fee: Nat::from(0u64),
        decimals: Some(6),
        max_memo_length: None,
        token_symbol: "CKE".into(),
        token_name: "ckE test".into(),
        metadata: vec![],
        initial_balances: vec![],
        feature_flags: Some(FeatureFlags { icrc2: false, icrc152: false }),
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

    let dpay_init = DpayInitArg {
        ledgers: vec![
            LedgerConfig { currency: ONRAMP_SENTINEL_CURRENCY, principal: ledger, mintable: false },
            LedgerConfig { currency: ONRAMP_FALLBACK_CURRENCY, principal: ledger, mintable: false },
        ],
        per_tx_cap: CAP,
        controller: Some(admin),
    };
    pic.0.install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);

    // Minter A (sentinel set post-install, the way an upgraded minter carries its own
    // configured helper) + minter B (field never set → `None` on the wire → fallback).
    let install_minter = |pic: &LivePocketIc| -> Principal {
        let m = pic.0.create_canister();
        pic.0.add_cycles(m, 2_000_000_000_000);
        pic.0.install_canister(
            m,
            mock_minter_wasm(),
            encode_one(&MockMinterInit { amount_ledger: ledger, gas_ledger: None }).unwrap(),
            None,
        );
        m
    };
    let minter_a = install_minter(&pic);
    let minter_b = install_minter(&pic);
    pic.0
        .update_call(
            minter_a,
            Principal::anonymous(),
            "set_deposit_helper_address",
            encode_one(RUNTIME_HELPER_SENTINEL_A).unwrap(),
        )
        .expect("set_deposit_helper_address update_call rejected");

    // Wire the catalog: ledger + minter + CkEthErc20 metadata per currency. Both carry mainnet
    // chain_id so the ONE differentiator is minter state (sentinel vs unset), not chain scoping
    // (the chain-id gate is covered exhaustively by the unit tests on the pure resolver).
    for (currency, minter) in [
        (ONRAMP_SENTINEL_CURRENCY, minter_a),
        (ONRAMP_FALLBACK_CURRENCY, minter_b),
    ] {
        let reg = |method: &str, args: Vec<u8>| {
            let reply = pic.0.update_call(dpay, admin, method, args).unwrap_or_else(|e| {
                panic!("{method} update_call rejected for currency {currency}: {e:?}")
            });
            decode_one::<Result<(), String>>(&reply)
                .unwrap()
                .unwrap_or_else(|e| panic!("{method} must succeed for the controller: {e}"));
        };
        reg("register_minter", encode_args((currency, minter)).unwrap());
        reg(
            "register_currency_meta",
            encode_args((
                currency,
                None::<String>,                     // symbol
                None::<u8>,                         // decimals
                Some(TestMinterFamily::CkEthErc20), // minter_family
                None::<String>,                     // wrapper_name
                None::<String>,                     // backing_symbol
                None::<String>,                     // network
                None::<u8>,                         // display_decimals
                None::<u64>,                        // fee
                None::<u64>,                        // cap
                Some(1u32),                         // chain_id (mainnet)
                Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string()), // token (USDC)
                TestRampCapability::Direct,         // onramp
                TestRampCapability::Direct,         // offramp
                None::<Principal>,                  // gas_ledger
            ))
            .unwrap(),
        );
    }

    let canister_id = dpay;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    let state = rt.block_on(async move {
        let agent = AgentLedger::connect(&gateway_url, canister_id)
            .await
            .expect("AgentLedger must connect to the live gateway");
        AppState::new(Arc::new(agent))
    });

    // ---- (1) runtime read wins: minter A's sentinel (≠ every compiled constant) ----
    let (s, b) = rt
        .block_on(call(
            &state,
            get(&format!("/api/v1/onramp/ckerc20?currency={ONRAMP_SENTINEL_CURRENCY}")),
        ));
    assert_eq!(s, StatusCode::OK, "onramp sentinel body={b}");
    assert_eq!(
        b["helper_address"].as_str(),
        Some(RUNTIME_HELPER_SENTINEL_A),
        "helper MUST be the minter's CURRENT address (runtime get_minter_info read), \
         not any compiled constant (body={b})"
    );
    assert_eq!(
        b["erc20_address"].as_str(),
        Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        "ERC-20 address stays the descriptor's per-token contract (body={b})"
    );
    assert_eq!(
        b["kind"].as_str(),
        Some("erc20"),
        "token_contract present ⇒ erc20 kind (body={b})"
    );

    // ---- (2) minter-side change reflected on the NEXT request (no caching) ----
    // (fixture mutation happens on the PocketIC client thread, BETWEEN tokio block_ons —
    // pocket-ic's update_call internally block_ons and panics if nested inside our runtime)
    pic.0
        .update_call(
            minter_a,
            Principal::anonymous(),
            "set_deposit_helper_address",
            encode_one(RUNTIME_HELPER_SENTINEL_B).unwrap(),
        )
        .expect("set_deposit_helper_address (B) update_call rejected");
    let (s, b) = rt
        .block_on(call(
            &state,
            get(&format!("/api/v1/onramp/ckerc20?currency={ONRAMP_SENTINEL_CURRENCY}")),
        ));
    assert_eq!(s, StatusCode::OK, "onramp sentinel-B body={b}");
    assert_eq!(
        b["helper_address"].as_str(),
        Some(RUNTIME_HELPER_SENTINEL_B),
        "a helper address the minter changed BETWEEN requests must be surfaced on the very \
         next request — the runtime read must not be cached (body={b})"
    );

    // ---- (3) fallback: minter B leaves the field unset ⇒ verified mainnet constant ----
    let (s, b) = rt
        .block_on(call(
            &state,
            get(&format!("/api/v1/onramp/ckerc20?currency={ONRAMP_FALLBACK_CURRENCY}")),
        ));
    assert_eq!(s, StatusCode::OK, "onramp fallback body={b}");
    assert_eq!(
        b["helper_address"].as_str(),
        Some(EXPECTED_FALLBACK_HELPER_MAINNET),
        "minter with the field unset ⇒ logged fallback to the verified constant (body={b})"
    );
}

/// Currency id for the deposit_info cache test — registered with a minter but NO family meta,
/// which the facade's family resolver defaults to CkBtcUtxo (legacy compat), the ONLY family
/// `deposit_info` serves.
const DEPOSIT_CACHE_CURRENCY: u32 = 5;

/// WAVE 5 item 2: `/api/v1/deposit/info` MUST stay a consensus UPDATE (the facade `await`s two
/// inter-canister minter calls), so the relay serves it from a ~60s TTL cache instead of paying
/// the round trip on every sheet open. Proves BOTH observable cache paths live through the HTTP
/// route: (1) cache MISS — the first call drives the real facade update against the mock minter
/// and returns its BTC-shaped info; (2) cache HIT — after the minter is UNINSTALLED (any fresh
/// facade call would now fail → 503), a second call within the TTL still answers 200 with the
/// byte-identical body, which is only possible if the relay served the cached entry without
/// touching the canister. (TTL expiry is the same `elapsed() < TTL` comparison as the miss path
/// with no entry; exercising it live would need a 60s sleep.)
#[test]
fn live_deposit_info_is_ttl_cached_not_recalled_per_request() {
    std::env::set_var("POCKET_IC_MUTE_SERVER", "1");
    let mut pic = PocketIc::new();
    let gateway_url = pic.make_live(None).to_string();
    let pic = LivePocketIc(pic);

    let admin = Principal::management_canister();
    let dpay = pic.0.create_canister();
    pic.0.add_cycles(dpay, 2_000_000_000_000);
    // Catalog ledger row only — `deposit_info` never touches the ledger (it calls the minter),
    // so an empty canister id suffices; installing the full ICRC wasm would prove nothing here.
    let ledger = pic.0.create_canister();
    pic.0.add_cycles(ledger, 1_000_000_000_000);

    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig {
            currency: DEPOSIT_CACHE_CURRENCY,
            principal: ledger,
            mintable: false,
        }],
        per_tx_cap: CAP,
        controller: Some(admin),
    };
    pic.0.install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);

    // The mock ckBTC-shaped minter — its `get_minter_info`/`get_deposit_fee` are what the facade
    // update proxies. (This also proves the mock's WAVE-5 MinterInfo extension — the added
    // `deposit_with_subaccount_helper_contract_address` field — stays wire-compatible with the
    // facade's BTC-shaped decode via candid record subtyping.)
    let minter = pic.0.create_canister();
    pic.0.add_cycles(minter, 2_000_000_000_000);
    pic.0.install_canister(
        minter,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { amount_ledger: ledger, gas_ledger: None }).unwrap(),
        None,
    );
    let reply = pic
        .0
        .update_call(dpay, admin, "register_minter", encode_args((DEPOSIT_CACHE_CURRENCY, minter)).unwrap())
        .expect("register_minter update_call rejected");
    decode_one::<Result<(), String>>(&reply)
        .unwrap()
        .unwrap_or_else(|e| panic!("register_minter must succeed for the controller: {e}"));

    let canister_id = dpay;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let state = rt.block_on(async {
        let agent = AgentLedger::connect(&gateway_url, canister_id)
            .await
            .expect("AgentLedger must connect to the live gateway");
        AppState::new(Arc::new(agent))
    });

    // ---- (1) cache MISS: real facade update through the minter → the mock's BTC-shaped info ----
    let (s, b) = rt.block_on(call(
        &state,
        get(&format!("/api/v1/deposit/info?currency={DEPOSIT_CACHE_CURRENCY}")),
    ));
    assert_eq!(s, StatusCode::OK, "first deposit_info call body={b}");
    assert_eq!(b["min_confirmations"], 1, "mock minter min_confirmations=1 (body={b})");
    assert_eq!(b["deposit_fee"], "0", "mock get_deposit_fee=0, U64String-rendered (body={b})");
    assert_eq!(b["deposit_min_amount"], "0", "mock deposit_btc_min_amount=Some(0) (body={b})");

    // ---- (2) cache HIT: minter UNINSTALLED — only the relay's TTL cache can still answer ----
    pic.0.uninstall_canister(minter, None).expect("uninstall_canister rejected");
    let (s2, b2) = rt.block_on(call(
        &state,
        get(&format!("/api/v1/deposit/info?currency={DEPOSIT_CACHE_CURRENCY}")),
    ));
    assert_eq!(
        s2,
        StatusCode::OK,
        "second call within the TTL must be served from the relay cache — the minter is GONE, \
         a fresh facade update would fail 503 (body={b2})"
    );
    assert_eq!(b2, b, "cached body must be byte-identical to the fresh one");
}
