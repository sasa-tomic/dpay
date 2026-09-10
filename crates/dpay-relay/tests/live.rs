//! LIVE integration test for the post-cutover READ surface (feature `agent`).
//!
//! 2026-08-19 IC user-principal-rail cutover: value movement LEFT the relay entirely — the app
//! signs /api/v2 envelopes locally (dpay-icp) and POSTs them to boundary nodes. What the relay
//! still owns in prod is the READ surface, and this test proves exactly that surface against a
//! REAL local IC: PocketIC's HTTP gateway + the REAL DFINITY ic-icrc1-ledger. The dpay facade
//! canister still appears in the fixtures, but only for the roles it kept after its catalog
//! registry was deleted (founder decision 2026-08-28): owning the ledger's minting account (the
//! `mint_at_user_principal` rail shape) and, in the faucet/deposit tests, its controller-gated
//! mint and deposit-info consensus reads. The CATALOG is compiled into the relay
//! (`crate::catalog`) — no code path queries the facade for it anymore.
//!
//! The money-critical assertion is the ACCOUNT SHAPE: funds are minted directly on the ledger at
//! `Account{owner: self_authenticating_ed25519(payer pubkey), subaccount: None}` — the exact
//! account the app's signed icrc1_transfer envelopes move — and `GET /api/v1/balances/{hex}` must
//! read them back there (`AgentLedger::balance_on_ledger` derives the SAME owner via dpay-icp's
//! golden-proven derivation). If the relay and the app ever disagreed on the account shape,
//! balances would read 0 while funds sit "lost" at a different principal; this test is the live
//! tripwire for exactly that regression class.
//!
//! The fixture ledger is installed AT the compiled catalog's VCHF principal
//! (`ly36x-wiaaa-aaaai-aqj7q-cai`, currency 7): the routes resolve ledger principals from the
//! compiled catalog now, so pinning the real wasm there is what makes the fan-out actually
//! REACH it — the strongest live proof that catalog and rail agree.
//!
//! Asserts, all THROUGH THE HTTP ROUTES (oneshot on the real axum app + `AgentLedger` + ic-agent;
//! no direct trait calls — the prod wire surface is the thing under test):
//!   1. `GET /api/v1/health` → 200 `{"status":"ok"}` (real replica `status` round-trip);
//!   2. `GET /api/v1/currencies` → 200, the COMPILED catalog verbatim (v2 network-first envelope:
//!      icp mainnet 6 rows incl. VCHF 7 naming the pinned fixture ledger, icp testnet trio
//!      ckTESTBTC/ckSepoliaUSDC/ckSepoliaETH, solana mainnet);
//!   3. `GET /api/v1/balances/{hex}` → the minted amount as a decimal STRING for VCHF (currency
//!      7 — the pinned fixture ledger, the only catalog ledger that exists on this PocketIC; the
//!      other 8 are absent and best-effort omitted); a SECOND user principal minted a different
//!      amount reads independently; an UNFUNDED principal reads "0";
//!   4. `GET /api/v1/transactions/{hex}?currency=7` → 200 with a well-formed rows array (see
//!      `live_icrc3_history_walks_the_real_ledger_log` below for the CONTENT assertions — this
//!      one only proves the shape for an account with no rows).
//!   5. `GET /api/v1/onramp/ckerc20?currency=2` → the CkDeposit `helper_address` read at RUNTIME
//!      from the currency's minter (`get_minter_info` — the fixture installs a mock AT the
//!      catalog's pinned ckETH-minter principal), with the verified compile-time constant served
//!      only on logged fallback (see
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

use candid::{decode_one, encode_one, CandidType, Nat, Principal};
use pocket_ic::PocketIc;

use dpay_core::generate_keypair;
use dpay_relay::{app, AgentLedger, AppState};
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::{TransferArg, TransferError};

const CAP: u64 = 100_000; // per-tx cap: $1,000.00 (registered into CURRENCY_META below)
const INIT_A: u64 = 10_000; // first user opens with $100.00 minted AT their principal
const INIT_B: u64 = 3_333; // second user gets a DIFFERENT amount (balance-independence proof)

// --- facade init payload -----------------------------------------------------------------------

/// The post-registry-removal facade init payload (founder decision 2026-08-28): the governed
/// `ledgers` registry is GONE from the canister — init now takes just the controller, the ONE
/// environment-specific DEMO ledger, and the DEMO per-tx cap. Every other currency the facade
/// serves resolves from its compile-time `FIXED_ASSETS` table.
#[derive(CandidType, serde::Serialize)]
struct DpayInitArg {
    controller: Option<Principal>,
    demo_ledger: Principal,
    per_tx_cap: u64,
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

/// The compiled catalog's VCHF row (`crate::catalog`, currency 7). The read-surface fixtures
/// install the real ic-icrc1-ledger wasm AT this row's pinned principal — the ledger the
/// /balances and /transactions routes must resolve from the compiled catalog and actually reach.
const CATALOG_VCHF: u32 = 7;

/// The compiled catalog's ckUSDC row (currency 2): CkEthErc20 family, mainnet chain_id, ERC-20
/// token contract, minter `sv3dd-oaaaa-aaaar-qacoa-cai` — the onramp test installs its mock
/// minter AT that principal so the runtime helper read has a live target.
const CATALOG_CKUSDC: u32 = 2;

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
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read ledger wasm at {}: {e}", path.display()))
}

/// A plain GET request for `uri` (every assertion here is a read — the value-path routes are gone).
fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
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
        to: Account {
            owner: Principal::from_slice(owner.as_slice()),
            subaccount: None,
        },
        fee: None,             // transfer_fee is 0; mints carry no fee
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
        to: Account {
            owner: Principal::from_slice(to_owner.as_slice()),
            subaccount: None,
        },
        fee: None,
        created_at_time: None,
        memo: Some(icrc_ledger_types::icrc1::transfer::Memo::from(
            memo.to_vec(),
        )),
        amount: Nat::from(amount),
    };
    let reply = pic
        .update_call(
            ledger,
            Principal::from_slice(sender.as_slice()),
            "icrc1_transfer",
            encode_one(&arg).unwrap(),
        )
        .expect("icrc1_transfer update_call rejected");
    match decode_one::<Result<Nat, TransferError>>(&reply).unwrap() {
        Ok(_) => {}
        Err(e) => panic!("rail transfer failed: {e:?}"),
    }
}

/// Stand up the live IC + the real ICRC ledger pinned AT the compiled catalog's VCHF principal —
/// the shared fixture of the read-surface tests below. Returns the RAII-guarded PocketIC (keep it
/// alive for the test's duration), the pinned ledger canister, and the facade canister. The
/// ledger's minting account is owned by the FACADE, so `mint_at_user_principal` (sent as the
/// facade) is the ICRC-1 mint path.
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

    // The ledger sits AT the compiled catalog's VCHF principal (row 7): the routes resolve ledger
    // principals from crate::catalog now, so pinning the real wasm at the row's principal is what
    // makes /balances and /transactions actually reach THIS ledger. Literal kept in sync with
    // `catalog::VCHF_LEDGER_PRINCIPAL` (pub(crate), not importable from an integration test);
    // the catalog_truth drift test pins it against dfx/catalog_truth.json.
    let ledger = Principal::from_text("ly36x-wiaaa-aaaai-aqj7q-cai")
        .expect("the compiled catalog's VCHF ledger id parses");
    pic.0
        .create_canister_with_id(None, None, ledger)
        .expect("reserve the pinned VCHF ledger principal on PocketIC");
    pic.0.add_cycles(ledger, 10_000_000_000_000);
    let ledger_init = LedgerArg::Init(LedgerInitArgs {
        minting_account: Account {
            owner: dpay,
            subaccount: None,
        },
        fee_collector_account: None,
        transfer_fee: Nat::from(0u64),
        decimals: Some(8),
        max_memo_length: None,
        token_symbol: "VCHF".into(),
        token_name: "dpay live-test VCHF".into(),
        metadata: vec![],
        initial_balances: vec![],
        feature_flags: Some(FeatureFlags {
            icrc2: true,
            icrc152: false,
        }),
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
    pic.0.install_canister(
        ledger,
        ledger_wasm(),
        encode_one(&ledger_init).unwrap(),
        None,
    );

    // The facade's remaining role in the READ tests: owning the ledger's minting account (the
    // rail mint path above) — the read routes never consult it (the catalog is compiled into the
    // relay). The pinned VCHF ledger doubles as the facade's `demo_ledger` (init shape only; the
    // DEMO currency is never queried on this read-surface fixture).
    let admin = Principal::management_canister();
    let dpay_init = DpayInitArg {
        controller: Some(admin),
        demo_ledger: ledger,
        per_tx_cap: CAP,
    };
    pic.0
        .install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);

    (pic, ledger, dpay, gateway_url)
}

/// The faucet variant: same topology as [`stand_up`] but the controller is the SELF-AUTHENTICATING
/// principal of a known Ed25519 seed (not the management canister) — exactly prod's shape, where
/// the founder's `DPAY_DFX_IDENTITY` key is the controller and the relay borrows the same seed via
/// `DPAY_CONTROLLER_SEED` to sign the faucet's `mint`. Returns the seed too, so the test can
/// construct the relay-side agent with that identity.
fn stand_up_with_controller_seed() -> (LivePocketIc, Principal, Principal, String, [u8; 32]) {
    std::env::set_var("POCKET_IC_MUTE_SERVER", "1");

    // Fixed test seed — NOT secret; any 32 bytes work for Ed25519.
    let seed: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(3));
    // The canister-side controller principal. CAREFUL: self_authenticating_ed25519 takes the
    // PUBLIC key — the seed is private. The relay agent (BasicIdentity::from_raw_key(seed)) derives
    // its sender from the seed's verifying key, so the fixture must derive the same public key here
    // (ed25519-dalek, the same curve library the identity path uses) or the agent authenticates as
    // a NON-controller and mint is refused. Note dpay_icp::Principal (29-byte) vs candid Principal
    // — convert via as_slice/from_slice like the rest of this file.
    let verifying = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key();
    let controller = Principal::from_slice(
        dpay_icp::principal::Principal::self_authenticating_ed25519(&verifying.to_bytes())
            .as_slice(),
    );

    let mut pic = PocketIc::new();
    let gateway_url = pic.make_live(None).to_string();
    let pic = LivePocketIc(pic);

    let dpay = pic.0.create_canister();
    pic.0.add_cycles(dpay, 2_000_000_000_000);
    let ledger = pic.0.create_canister();
    pic.0.add_cycles(ledger, 10_000_000_000_000);
    let ledger_init = LedgerArg::Init(LedgerInitArgs {
        minting_account: Account {
            owner: dpay,
            subaccount: None,
        },
        fee_collector_account: None,
        transfer_fee: Nat::from(0u64),
        decimals: Some(2),
        max_memo_length: None,
        token_symbol: "DUSD".into(),
        token_name: "dpay demo USD".into(),
        metadata: vec![],
        initial_balances: vec![],
        feature_flags: Some(FeatureFlags {
            icrc2: true,
            icrc152: false,
        }),
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
    pic.0.install_canister(
        ledger,
        ledger_wasm(),
        encode_one(&ledger_init).unwrap(),
        None,
    );

    let dpay_init = DpayInitArg {
        controller: Some(controller),
        demo_ledger: ledger,
        per_tx_cap: CAP,
    };
    pic.0
        .install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);

    (pic, ledger, dpay, gateway_url, seed)
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
        let key = CATALOG_VCHF.to_string(); // the batch map's JSON key: currency index as a string

        // ---- (1) health: the real replica `status` round-trip ----
        let (hs, hb) = call(&state, get("/api/v1/health")).await;
        assert_eq!(hs, StatusCode::OK, "health body={hb}");
        assert_eq!(hb["status"], "ok");

        // ---- (2) currencies: the COMPILED catalog, served without touching the facade ----
        // v2 network-first envelope: icp mainnet (7 rows: DEMO 0, ckBTC 1, ckUSDC 2, ckETH 6,
        // VCHF 7, ICP 8, VEUR 9 — the EUR Stage-1 row), icp testnet (the real trio ckTESTBTC 3 /
        // ckSepoliaUSDC 4 / ckSepoliaETH 5), solana mainnet (SOL + USDC + EURC). The VCHF row must
        // name THIS fixture's pinned principal — the fan-out target the balances/transactions
        // routes resolve against.
        let (cs, cb) = call(&state, get("/api/v1/currencies")).await;
        assert_eq!(cs, StatusCode::OK, "currencies body={cb}");
        let networks = cb["networks"]
            .as_array()
            .unwrap_or_else(|| panic!("networks must be an array: {cb}"));
        assert_eq!(
            networks.len(),
            3,
            "icp mainnet + icp testnet + solana mainnet: {cb}"
        );
        let mainnet = &networks[0];
        assert_eq!(mainnet["protocol"], "icp");
        assert_eq!(mainnet["environment"], "mainnet");
        assert_eq!(
            mainnet["assets"].as_array().map(Vec::len),
            Some(7),
            "the compiled mainnet section carries all 7 rows incl. VCHF 7 + ICP 8 + VEUR 9: {cb}"
        );
        assert_eq!(
            networks[1]["environment"], "testnet",
            "the testnet section holds the compiled testnet trio: {cb}"
        );
        assert_eq!(
            networks[1]["assets"].as_array().map(Vec::len),
            Some(3),
            "exactly ckTESTBTC (3) + ckSepoliaUSDC (4) + ckSepoliaETH (5) on the testnet side: {cb}"
        );
        assert_eq!(
            networks[2]["protocol"], "solana",
            "the solana section is present: {cb}"
        );
        let rows = mainnet["assets"]
            .as_array()
            .unwrap_or_else(|| panic!("icp mainnet assets must be an array: {cb}"));
        let vchf = rows
            .iter()
            .find(|d| d["currency"].as_u64() == Some(u64::from(CATALOG_VCHF)))
            .unwrap_or_else(|| {
                panic!("compiled catalog must contain the VCHF (currency {CATALOG_VCHF}) row: {cb}")
            });
        assert_eq!(
            vchf["ledger"].as_str(),
            Some(ledger_text.as_str()),
            "VCHF row must name the pinned fixture ledger's canonical principal text (row={vchf})"
        );

        // ---- (3) balances: the USER-PRINCIPAL account shape against the real ledger ----
        // The mints in §2 landed at Account{owner: self_auth(pk), subaccount: None}; the batch
        // route fans `balance_on_ledger` out per catalog currency with the SAME derivation. An
        // account-shape regression on either side reads 0 here — that is the tripwire.
        let (ps, pb) = call(
            &state,
            get(&format!("/api/v1/balances/{}", hex::encode(payer_pk))),
        )
        .await;
        assert_eq!(ps, StatusCode::OK, "payer balances body={pb}");
        assert_eq!(
            pb[key.as_str()],
            INIT_A.to_string(),
            "payer VCHF must read the minted amount (body={pb})"
        );
        // The compiled catalog carries 10 currencies (9 IC + EURC on solana), but only the PINNED
        // fixture ledger exists on this PocketIC — every other fan-out target is an absent canister,
        // and the batch omits those best-effort (exactly prod's behavior for unreachable ledgers).
        // So the map is the one entry that answered: VCHF.
        assert_eq!(
            pb.as_object().map(|m| m.len()),
            Some(1),
            "only the fixture ledger answers; absent catalog ledgers are omitted (body={pb})"
        );

        // Second user: independent balance (different amount, different principal).
        let (ss, sb) = call(
            &state,
            get(&format!("/api/v1/balances/{}", hex::encode(second_pk))),
        )
        .await;
        assert_eq!(ss, StatusCode::OK, "second-user balances body={sb}");
        assert_eq!(
            sb[key.as_str()],
            INIT_B.to_string(),
            "second user must read their OWN mint (body={sb})"
        );

        // Independence cross-check: the second mint must not have touched the first user.
        let (rs, rb) = call(
            &state,
            get(&format!("/api/v1/balances/{}", hex::encode(payer_pk))),
        )
        .await;
        assert_eq!(rs, StatusCode::OK, "payer re-read body={rb}");
        assert_eq!(
            rb[key.as_str()],
            INIT_A.to_string(),
            "payer balance must be unchanged by the second mint (body={rb})"
        );

        // An UNFUNDED principal reads a clean "0" — not an error, not a missing key.
        let unfunded_pk = generate_keypair().verifying_key().to_bytes();
        let (us, ub) = call(
            &state,
            get(&format!("/api/v1/balances/{}", hex::encode(unfunded_pk))),
        )
        .await;
        assert_eq!(us, StatusCode::OK, "unfunded balances body={ub}");
        assert_eq!(
            ub[key.as_str()],
            "0",
            "an unfunded principal must read \"0\" (body={ub})"
        );

        // ---- (4) transactions: shape for an account with no VCHF rows ----
        // The payer HAS history rows now (the mints above — see the icrc3 test below for the
        // content assertions); this read uses the currency whose log exists but has no rows for
        // this user… except VCHF is the only live currency here, and the mints DID touch the
        // payer. So the honest shape-only read here is the UNFUNDED principal: rows exist on the
        // ledger, just none concerning this account — the response must be 200 with an EMPTY
        // array.
        let (us, ub) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=10",
                hex::encode(unfunded_pk),
                CATALOG_VCHF
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
    let settlement_memo = b"0123456789abcdef";
    rail_transfer(
        &pic.0,
        ledger,
        &payer_pk,
        &merchant_pk,
        250,
        settlement_memo,
    );
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

    let state = rt.block_on(async move {
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
                CATALOG_VCHF
            )),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "transactions body={b}");
        let rows = b["transactions"]
            .as_array()
            .unwrap_or_else(|| panic!("transactions must be an array: {b}"));
        assert_eq!(
            rows.len(),
            3,
            "mint + out-transfer + in-transfer (body={b})"
        );

        // Newest-first: the in-transfer (100) landed last.
        let r0 = &rows[0];
        assert_eq!(
            r0["amount"].as_str(),
            Some("100"),
            "newest row is the 100 in-transfer"
        );
        assert_eq!(r0["from"].as_str(), Some(merchant_owner.to_text().as_str()));
        assert_eq!(r0["to"].as_str(), Some(payer_owner.to_text().as_str()));
        assert_eq!(
            r0["memo"].as_str(),
            Some(hex::encode("change").as_str()),
            "memo renders as hex bytes"
        );
        assert_eq!(r0["currency"].as_u64(), Some(u64::from(CATALOG_VCHF)));
        // Magnitude pin, not just type: ICRC-3 blocks carry NANOSECOND timestamps and the rows
        // contract is unix SECONDS — a raw-ns leak here renders as "undefined NaN, NaN" in the
        // app's history rows (2026-08-21 field bug). Pin the seconds range so the ns→s division
        // can never silently regress.
        let ts0 = r0["timestamp"].as_u64().expect("timestamp is a number");
        assert!(
            ts0 > 1_500_000_000 && ts0 < 3_000_000_000,
            "timestamp {ts0} must be unix SECONDS (got ns?)"
        );

        // Middle: the out-transfer (250) — from = payer.
        let r1 = &rows[1];
        assert_eq!(r1["amount"].as_str(), Some("250"));
        assert_eq!(r1["from"].as_str(), Some(payer_owner.to_text().as_str()));
        assert_eq!(r1["to"].as_str(), Some(merchant_owner.to_text().as_str()));
        assert_eq!(
            r1["memo"].as_str(),
            Some(hex::encode(settlement_memo).as_str())
        );

        // Oldest: the mint (10_000) — `from` is the empty mint sentinel, `to` = payer.
        let r2 = &rows[2];
        assert_eq!(r2["amount"].as_str(), Some("10000"));
        assert_eq!(
            r2["from"].as_str(),
            Some(""),
            "mint renders the empty-from sentinel"
        );
        assert_eq!(r2["to"].as_str(), Some(payer_owner.to_text().as_str()));

        // ---- (2) limit clamp: ?limit=1 keeps exactly the NEWEST row ----
        let (ls, lb) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=1",
                hex::encode(payer_pk),
                CATALOG_VCHF
            )),
        )
        .await;
        assert_eq!(ls, StatusCode::OK, "limit body={lb}");
        let lrows = lb["transactions"].as_array().unwrap();
        assert_eq!(lrows.len(), 1, "limit=1 clamps to one row");
        assert_eq!(
            lrows[0]["amount"].as_str(),
            Some("100"),
            "the kept row is the NEWEST"
        );

        // ---- (3) exact settlement memo: production AgentLedger filters DURING its ICRC-3 walk,
        // before limit, so the older 250 row survives limit=1 despite a newer 100 row. ----
        let memo_hex = hex::encode(settlement_memo);
        let (ms, mb) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=1&memo={memo_hex}",
                hex::encode(payer_pk),
                CATALOG_VCHF
            )),
        )
        .await;
        assert_eq!(ms, StatusCode::OK, "exact memo body={mb}");
        let mrows = mb["transactions"].as_array().unwrap();
        assert_eq!(mrows.len(), 1, "exact memo returns one row: {mb}");
        assert_eq!(mrows[0]["amount"].as_str(), Some("250"));
        assert_eq!(mrows[0]["memo"].as_str(), Some(memo_hex.as_str()));

        // ---- (4) no-match account: 200 + empty array (not 404, not an error) ----
        let stranger_pk = generate_keypair().verifying_key().to_bytes();
        let (ss, sb) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=30",
                hex::encode(stranger_pk),
                CATALOG_VCHF
            )),
        )
        .await;
        assert_eq!(ss, StatusCode::OK, "stranger body={sb}");
        assert_eq!(
            sb["transactions"].as_array().map(Vec::len),
            Some(0),
            "no ledger rows for this account ⇒ empty array (body={sb})"
        );

        state
    });

    // ---- (4) DRIFT: a transfer seeded AFTER the first call must appear on a subsequent call. ----
    // The walk anchors on each response's OWN log_length snapshot; blocks committed between
    // requests extend the log and the NEXT request simply sees them — the descending-anchor
    // rewrite (2026-08-20) must not cache or clamp to a stale length. The seed runs OUTSIDE the
    // tokio runtime (pocket-ic update_call block_ons internally and panics if nested).
    let late_pk = generate_keypair().verifying_key().to_bytes();
    let late_owner = Principal::from_slice(
        dpay_icp::principal::Principal::self_authenticating_ed25519(&late_pk).as_slice(),
    );
    rt.block_on(async {
        let (s, b) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=30",
                hex::encode(late_pk),
                CATALOG_VCHF
            )),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "late-user pre-seed body={b}");
        assert_eq!(
            b["transactions"].as_array().map(Vec::len),
            Some(0),
            "late user must start with an EMPTY history (body={b})"
        );
    });
    rail_transfer(&pic.0, ledger, &payer_pk, &late_pk, 777, b"late-drift");
    rt.block_on(async {
        let (s, b) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=30",
                hex::encode(late_pk),
                CATALOG_VCHF
            )),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "late-user post-seed body={b}");
        let rows = b["transactions"].as_array().unwrap();
        assert_eq!(
            rows.len(),
            1,
            "the post-call transfer must be visible (body={b})"
        );
        assert_eq!(rows[0]["amount"].as_str(), Some("777"));
        assert_eq!(
            rows[0]["from"].as_str(),
            Some(payer_owner.to_text().as_str())
        );
        assert_eq!(rows[0]["to"].as_str(), Some(late_owner.to_text().as_str()));
        assert_eq!(
            rows[0]["memo"].as_str(),
            Some(hex::encode("late-drift").as_str())
        );
    });

    // And the ORIGINAL account's re-read must now show 4 rows with the late transfer newest.
    rt.block_on(async {
        let (s, b) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={}&limit=30",
                hex::encode(payer_pk),
                CATALOG_VCHF
            )),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "payer re-read body={b}");
        let rows = b["transactions"].as_array().unwrap();
        assert_eq!(
            rows.len(),
            4,
            "3 original rows + the late out-transfer (body={b})"
        );
        assert_eq!(
            rows[0]["amount"].as_str(),
            Some("777"),
            "late transfer is the NEWEST row"
        );
        assert_eq!(rows[0]["to"].as_str(), Some(late_owner.to_text().as_str()));
    });
}

// --- WAVE 6: the production faucet through the HTTP route -----------------------------------------
//
// The founder-approved faucet design (2026-08-20): the relay owns the cooldown and drives the
// facade's CONTROLLER-GATED `mint` with an authenticated agent identity, crediting the USER
// principal — the same Account{owner: self_authenticating(pk), subaccount: None} the app reads.
// This test proves the whole chain live: a facade whose controller is a known Ed25519 seed, a
// relay agent constructed with that seed, and the route's contract —
//   - first call: 200 {balance} and the credit is visible via icrc1_balance_of at the USER
//     principal (NOT any facade-owned subaccount);
//   - second immediate call: the relay-side cooldown's verbatim old-canon text;
//   - after a test-shrunk window: allowed again;
//   - the amounts are pinned (the app sends TOP_UP_CENTS = 10_000; anything else is refused).
#[test]
fn live_faucet_mints_at_user_principal_with_relay_side_cooldown() {
    let (pic, ledger, dpay, gateway_url, seed) = stand_up_with_controller_seed();
    let user_pk = generate_keypair().verifying_key().to_bytes();
    let user_owner = Principal::from_slice(
        dpay_icp::principal::Principal::self_authenticating_ed25519(&user_pk).as_slice(),
    );
    let canister_id = dpay;

    // Direct rail read for ground truth (query; safe outside the runtime).
    let user_balance = |pic: &PocketIc, ledger: &Principal| -> u64 {
        let res = pic
            .query_call(
                *ledger,
                Principal::anonymous(),
                "icrc1_balance_of",
                encode_one(Account {
                    owner: user_owner,
                    subaccount: None,
                })
                .unwrap(),
            )
            .expect("icrc1_balance_of query must succeed");
        decode_one::<Nat>(&res)
            .expect("balance decodes as Nat")
            .0
            .try_into()
            .expect("test balance fits u64")
    };

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    // The relay-side agent WITH the controller identity (the DPAY_CONTROLLER_SEED path),
    // constructed once and shared across the block_on segments below.
    let state = rt.block_on(async {
        let agent = AgentLedger::connect_with_identity(&gateway_url, canister_id, true, seed)
            .await
            .expect("AgentLedger must connect with the controller identity");
        // Wired the way `main` wires a relay that was given DPAY_CONTROLLER_SEED: the faucet is
        // available, which is both what `/api/v1/capabilities` reports and what the route obeys.
        let state = AppState::new(Arc::new(agent)).with_faucet(true);
        // Test seam: shrink the 1h production window to 2s so the rollover is observable.
        state.set_faucet_cooldown_window(2);
        state
    });

    let faucet_req = |account: &str, amount: &str| {
        let body = serde_json::json!({ "account": account, "amount": amount });
        axum::http::Request::builder()
            .method("POST")
            .uri("/api/v1/faucet")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap()
    };

    // ---- (1) first call: 200 {balance} + the credit at the USER principal ----
    let hex_pk = hex::encode(user_pk);
    rt.block_on(async {
        let (s, b) = call(&state, faucet_req(&hex_pk, "10000")).await;
        assert_eq!(
            s,
            StatusCode::OK,
            "faucet body={b}"
        );
        assert_eq!(
            b["balance"].as_str(),
            Some("10000"),
            "the canister's mint return (new USER-principal balance) surfaces as {{balance}} (body={b})"
        );
    });

    // Ground truth OUTSIDE the runtime: the ledger itself credits the USER principal (NOT the
    // retired facade-custody subaccount).
    assert_eq!(
        user_balance(&pic.0, &ledger),
        10_000u64,
        "the faucet mint must land at Account{{owner: self_authenticating(pk), subaccount: None}}"
    );

    // ---- (2) immediate second call: the relay-side cooldown's verbatim old-canon text ----
    rt.block_on(async {
        let (s, b) = call(&state, faucet_req(&hex_pk, "10000")).await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "cooldown body={b}");
        let reason = b["error"]
            .as_str()
            .unwrap_or_else(|| panic!("cooldown error must be a string (body={b})"));
        assert!(
            reason.starts_with("faucet cooldown: try again in ~") && reason.ends_with(" s"),
            "verbatim old-canon cooldown text, not {reason:?}"
        );
    });

    // ---- (3) a DIFFERENT account is NOT blocked (per-account independence) ----
    let other_pk = generate_keypair().verifying_key().to_bytes();
    let other_hex = hex::encode(other_pk);
    rt.block_on(async {
        let (s, b) = call(&state, faucet_req(&other_hex, "10000")).await;
        assert_eq!(s, StatusCode::OK, "other-account faucet body={b}");
        assert_eq!(b["balance"].as_str(), Some("10000"));
    });

    // ---- (4) wrong amount is refused BEFORE any mint (fixed-denomination policy) ----
    rt.block_on(async {
        let (s, b) = call(&state, faucet_req(&hex_pk, "500")).await;
        assert_eq!(
            s,
            StatusCode::UNPROCESSABLE_ENTITY,
            "amount-pinning body={b}"
        );
        let reason = b["error"]
            .as_str()
            .unwrap_or_else(|| panic!("error must be a string (body={b})"));
        assert!(reason.contains("faucet amount is fixed"), "got {reason:?}");
    });

    // ---- (5) after the test-shrunk window: the original account may top up again ----
    std::thread::sleep(std::time::Duration::from_secs(3));
    rt.block_on(async {
        let (s, b) = call(&state, faucet_req(&hex_pk, "10000")).await;
        assert_eq!(s, StatusCode::OK, "post-window faucet body={b}");
        assert_eq!(
            b["balance"].as_str(),
            Some("20000"),
            "second top-up stacks (body={b})"
        );
    });
    assert_eq!(user_balance(&pic.0, &ledger), 20_000u64);
}

// The REFUSAL side of the faucet's money-safety gate — the exact prod failure class reported
// 2026-08-20 ("Faucet top up fails: unauthorized: admin ops require the controller principal"),
// in the two shapes it comes in, each answered by the half of the gate that can actually know:
//   - ANONYMOUS — DPAY_CONTROLLER_SEED unset (the relay's default without deploy-side wiring).
//     The RELAY knows this about itself, so it refuses without a canister round trip and names
//     the variable to set. `main` never declares such a relay's faucet available, and the route
//     obeys the same flag `/api/v1/capabilities` reports.
//   - WRONG SEED — a set-but-different key (an operator pasting the wrong half / wrong identity).
//     The relay CANNOT know an installed identity is the wrong one, so this is the canister's
//     call: `require_admin` refuses and the relay surfaces that text 1:1 as the 422 the app
//     shows. If the canister's wording or the relay's verbatim mapping ever drifts, this catches it.
#[test]
fn live_faucet_refuses_non_controller_identities() {
    let (_pic, _ledger, dpay, gateway_url, _seed) = stand_up_with_controller_seed();
    let hex_pk = hex::encode(generate_keypair().verifying_key().to_bytes());

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    let faucet_req = || {
        let body = serde_json::json!({ "account": hex_pk, "amount": "10000" });
        Request::builder()
            .method("POST")
            .uri("/api/v1/faucet")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };

    // (a) anonymous agent — exactly `AgentLedger::connect` with no DPAY_CONTROLLER_SEED, and the
    // faucet left unavailable exactly as `main` leaves it without that seed.
    let anonymous = AppState::new(Arc::new(
        rt.block_on(AgentLedger::connect(&gateway_url, dpay))
            .expect("anonymous agent connects"),
    ));
    rt.block_on(async {
        let (s, b) = call(&anonymous, faucet_req()).await;
        assert_eq!(
            s,
            StatusCode::SERVICE_UNAVAILABLE,
            "anonymous: faucet body={b}"
        );
        let reason = b["error"]
            .as_str()
            .unwrap_or_else(|| panic!("error must be a string (body={b})"));
        assert!(
            reason.contains("DPAY_CONTROLLER_SEED"),
            "the refusal must name the knob an operator has to set, got {reason:?}"
        );
    });

    // (b) an agent holding a DIFFERENT seed — it self-authenticates as a non-controller principal,
    // so `main` WOULD declare the faucet available (a seed is installed) and only the canister can
    // say otherwise.
    let wrong_seed = AppState::new(Arc::new(
        rt.block_on(AgentLedger::connect_with_identity(
            &gateway_url,
            dpay,
            true,
            [9u8; 32],
        ))
        .expect("wrong-seed agent connects"),
    ))
    .with_faucet(true);
    rt.block_on(async {
        let (s, b) = call(&wrong_seed, faucet_req()).await;
        assert_eq!(
            s,
            StatusCode::UNPROCESSABLE_ENTITY,
            "wrong seed: faucet body={b}"
        );
        assert_eq!(
            b["error"].as_str(),
            Some("unauthorized: admin ops require the controller principal"),
            "the canister's verbatim refusal must surface 1:1 (body={b})"
        );
    });
}

/// `GET /api/v1/capabilities`'s `demo_faucet` and what `POST /api/v1/faucet` actually did, read
/// off the SAME router: `(advertised, credited, status, body)`.
async fn faucet_capability_and_route(
    state: &AppState,
    account_hex: &str,
) -> (bool, bool, StatusCode, Value) {
    let (cs, cb) = call(
        state,
        Request::builder()
            .method("GET")
            .uri("/api/v1/capabilities")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(cs, StatusCode::OK, "capabilities body={cb}");
    let advertised = cb["demo_faucet"]
        .as_bool()
        .unwrap_or_else(|| panic!("demo_faucet must be a bool (body={cb})"));
    // The canonical top-up (`FAUCET_AMOUNT` = 10_000, what the app's TOP_UP_CENTS sends), so the
    // handler judges AVAILABILITY and never the denomination.
    let body = serde_json::json!({ "account": account_hex, "amount": "10000" });
    let (fs, fb) = call(
        state,
        Request::builder()
            .method("POST")
            .uri("/api/v1/faucet")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await;
    (advertised, fs.is_success(), fs, fb)
}

// The PRODUCTION-build mirror of `capability_demo_faucet_equals_what_the_faucet_route_does`
// (tests/relay.rs), and the live pin on the defect it exists for: prod served
// `{"till":false,"demo_faucet":false}` while `POST /api/v1/faucet` minted happily, so the app hid
// the top-up button and onboarded unfunded wallets against a perfectly healthy relay. The
// expectation is MEASURED against the router on both sides of the gate — an agent that holds the
// facade's controller identity and an anonymous one — never re-derived from the `cfg!` the
// implementation uses (that tautology is what let the lie ship).
#[test]
fn live_capability_demo_faucet_equals_what_the_faucet_route_does() {
    let (pic, ledger, dpay, gateway_url, seed) = stand_up_with_controller_seed();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    // Ground truth straight off the rail (query; safe outside the runtime).
    let balance_at = |pic: &PocketIc, owner: Principal| -> u64 {
        let res = pic
            .query_call(
                ledger,
                Principal::anonymous(),
                "icrc1_balance_of",
                encode_one(Account {
                    owner,
                    subaccount: None,
                })
                .unwrap(),
            )
            .expect("icrc1_balance_of query must succeed");
        decode_one::<Nat>(&res)
            .expect("balance decodes as Nat")
            .0
            .try_into()
            .expect("test balance fits u64")
    };
    let owner_of = |pk: &[u8; 32]| -> Principal {
        Principal::from_slice(
            dpay_icp::principal::Principal::self_authenticating_ed25519(pk).as_slice(),
        )
    };

    // (a) the shape production runs: an agent holding the controller identity (DPAY_CONTROLLER_SEED).
    let funded_pk = generate_keypair().verifying_key().to_bytes();
    let controller = rt.block_on(async {
        AppState::new(Arc::new(
            AgentLedger::connect_with_identity(&gateway_url, dpay, true, seed)
                .await
                .expect("controller-identity agent connects"),
        ))
        // What `main` declares when DPAY_CONTROLLER_SEED is set — the wiring under test is that
        // the route and the capability then agree, whichever way the flag went.
        .with_faucet(true)
    });
    let (adv, credited, s, b) = rt.block_on(faucet_capability_and_route(
        &controller,
        &hex::encode(funded_pk),
    ));
    assert!(
        credited,
        "a controller-identity relay must actually mint (answered {s}: {b})"
    );
    assert_eq!(
        adv, credited,
        "advertised demo_faucet must equal what POST /api/v1/faucet did (answered {s}: {b})"
    );
    assert_eq!(
        balance_at(&pic.0, owner_of(&funded_pk)),
        10_000u64,
        "the measurement is a real mint at the USER principal, not a 200 with no money"
    );

    // (b) the same canister, an ANONYMOUS relay: the canister's `require_admin` means this relay
    // cannot credit anything, and it must not claim otherwise.
    let unfunded_pk = generate_keypair().verifying_key().to_bytes();
    let anonymous = rt.block_on(async {
        AppState::new(Arc::new(
            AgentLedger::connect(&gateway_url, dpay)
                .await
                .expect("anonymous agent connects"),
        ))
    });
    let (adv2, credited2, s2, b2) = rt.block_on(faucet_capability_and_route(
        &anonymous,
        &hex::encode(unfunded_pk),
    ));
    assert!(
        !credited2,
        "an anonymous relay cannot mint (answered {s2}: {b2})"
    );
    assert_eq!(
        adv2, credited2,
        "an anonymous relay must not advertise a faucet (answered {s2}: {b2})"
    );
    assert_eq!(
        balance_at(&pic.0, owner_of(&unfunded_pk)),
        0u64,
        "a refused faucet creates nothing"
    );
}

// --- WAVE 5: runtime ckERC20-helper read ---------------------------------------------------------
//
// The ckERC20/native-ETH onramp's CkDeposit `helper_address` is deploy state the ckETH-minter
// operator can MOVE (a helper/minter upgrade deploys a new contract). Serving the compile-time
// constants unconditionally would silently strand deposits after such an upgrade; the agent path
// therefore reads the CURRENT address from the currency's minter (the principal named by the
// compiled catalog) at request time
// (`get_minter_info.deposit_with_subaccount_helper_contract_address`, a query) and falls back to
// the verified constants only when that read fails or the minter leaves the field unset (logged).
// This test proves BOTH halves live through the HTTP route:
//   - a minter configured with a sentinel address that exists nowhere in the relay's compiled
//     constants must be surfaced VERBATIM (the runtime read wins, and a second call after the
//     minter changes its address must reflect the change — not a cache);
//   - when the minter read FAILS (the fixture uninstalls the mock mid-test — the same degradation
//     prod sees when a minter is down), the chain_id-scoped verified constant must be served (the
//     logged fallback path).
//
// Fixture: ONE instance of the test-only mock-minter canister (`dpay-mock-minter`, never shipped
// to mainnet), installed AT the compiled catalog's pinned ckETH-minter principal — the onramp
// resolves minter principals from `crate::catalog`, so pinning is what routes the runtime query
// to the mock. The mock's `MinterInfo` extends the real ckBTC shape with the ckETH minter's
// `deposit_with_subaccount_helper_contract_address: opt text` field plus a
// `set_deposit_helper_address` test hook: the sentinel is set (and later changed) through it.

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

/// The ckETH-minter fixture proved live: the onramp's `helper_address` is the address the
/// currency's minter serves — the compiled catalog names the minter principal
/// (`sv3dd-oaaaa-aaaar-qacoa-cai` for the CkEthErc20 rows) and the runtime `get_minter_info`
/// query reads the CURRENT address from the canister pinned there. A minter-side change is
/// reflected on the very next request (no caching), and an unreachable (uninstalled) minter
/// degrades to the logged chain-scoped constant fallback. Proves the whole WAVE-5 agent-path
/// contract through the HTTP route.
#[test]
fn live_ckerc20_onramp_helper_read_at_runtime_with_constant_fallback() {
    std::env::set_var("POCKET_IC_MUTE_SERVER", "1");
    let mut pic = PocketIc::new();
    let gateway_url = pic.make_live(None).to_string();
    let pic = LivePocketIc(pic);

    // ONE mock minter, pinned AT the compiled catalog's ckETH-minter principal (row 2's minter
    // — `pub(crate)` in the relay, so the literal is duplicated here exactly like the fallback
    // constant above; the catalog_truth drift test pins it). The onramp route resolves the minter
    // FROM the compiled catalog and queries THIS canister — the facade is never consulted on this
    // path, so an empty canister id is all `AgentLedger::connect` needs.
    let dpay = pic.0.create_canister();
    pic.0.add_cycles(dpay, 2_000_000_000_000);
    let cketh_minter = Principal::from_text("sv3dd-oaaaa-aaaar-qacoa-cai")
        .expect("the compiled catalog's ckETH minter id parses");
    pic.0
        .create_canister_with_id(None, None, cketh_minter)
        .expect("reserve the pinned ckETH-minter principal on PocketIC");
    pic.0.add_cycles(cketh_minter, 2_000_000_000_000);
    pic.0.install_canister(
        cketh_minter,
        mock_minter_wasm(),
        encode_one(&MockMinterInit {
            amount_ledger: dpay,
            gas_ledger: None,
        })
        .unwrap(),
        None,
    );
    pic.0
        .update_call(
            cketh_minter,
            Principal::anonymous(),
            "set_deposit_helper_address",
            encode_one(RUNTIME_HELPER_SENTINEL_A).unwrap(),
        )
        .expect("set_deposit_helper_address update_call rejected");

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

    // ---- (1) runtime read wins: the pinned minter's sentinel (≠ every compiled constant) ----
    let (s, b) = rt.block_on(call(
        &state,
        get(&format!("/api/v1/onramp/ckerc20?currency={CATALOG_CKUSDC}")),
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
        "ERC-20 address stays the compiled ckUSDC row's token contract (body={b})"
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
            cketh_minter,
            Principal::anonymous(),
            "set_deposit_helper_address",
            encode_one(RUNTIME_HELPER_SENTINEL_B).unwrap(),
        )
        .expect("set_deposit_helper_address (B) update_call rejected");
    let (s, b) = rt.block_on(call(
        &state,
        get(&format!("/api/v1/onramp/ckerc20?currency={CATALOG_CKUSDC}")),
    ));
    assert_eq!(s, StatusCode::OK, "onramp sentinel-B body={b}");
    assert_eq!(
        b["helper_address"].as_str(),
        Some(RUNTIME_HELPER_SENTINEL_B),
        "a helper address the minter changed BETWEEN requests must be surfaced on the very \
          next request — the runtime read must not be cached (body={b})"
    );

    // ---- (3) fallback: the minter read FAILS (mock uninstalled) ⇒ verified mainnet constant ----
    // (an uninstall failure would leave the sentinel live and fail the assert below loudly)
    let _ = pic.0.uninstall_canister(cketh_minter, None);
    let (s, b) = rt.block_on(call(
        &state,
        get(&format!("/api/v1/onramp/ckerc20?currency={CATALOG_CKUSDC}")),
    ));
    assert_eq!(s, StatusCode::OK, "onramp fallback body={b}");
    assert_eq!(
        b["helper_address"].as_str(),
        Some(EXPECTED_FALLBACK_HELPER_MAINNET),
        "unreachable minter ⇒ logged fallback to the verified constant (body={b})"
    );
}

/// Currency id for the deposit_info cache test — ckBTC (1), the ONLY CkBtcUtxo-family currency
/// (the family gate `deposit_info` serves); the facade resolves its minter from its compile-time
/// `FIXED_ASSETS` table, so the fixture pins the mock minter AT that principal.
const DEPOSIT_CACHE_CURRENCY: u32 = 1;

/// The ckBTC minter principal the facade's compile-time `FIXED_ASSETS` table names for currency 1
/// (`crate::ledger::ckerc20::CKBTC_MINTER_PRINCIPAL` in the relay — `pub(crate)`, not importable
/// from an integration test; the catalog-truth drift test pins the pair).
const CKBTC_MINTER_PINNED: &str = "mqygn-kiaaa-aaaar-qaadq-cai";

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
    // `demo_ledger` shape only — `deposit_info` never touches the ledger (it calls the minter),
    // so an empty canister id suffices; installing the full ICRC wasm would prove nothing here.
    let ledger = pic.0.create_canister();
    pic.0.add_cycles(ledger, 1_000_000_000_000);

    let dpay_init = DpayInitArg {
        controller: Some(admin),
        demo_ledger: ledger,
        per_tx_cap: CAP,
    };
    pic.0
        .install_canister(dpay, facade_wasm(), encode_one(&dpay_init).unwrap(), None);

    // The mock ckBTC-shaped minter, pinned AT the principal the facade's compile-time table names
    // for currency 1 (the registry-era `register_minter` call is gone with the registry — pinning
    // the mock where the facade already looks is the post-cutover wiring). Its
    // `get_minter_info`/`get_deposit_fee` are what the facade update proxies. (This also proves
    // the mock's WAVE-5 MinterInfo extension — the added
    // `deposit_with_subaccount_helper_contract_address` field — stays wire-compatible with the
    // facade's BTC-shaped decode via candid record subtyping.)
    let minter = Principal::from_text(CKBTC_MINTER_PINNED).expect("pinned ckBTC minter principal");
    pic.0
        .create_canister_with_id(None, None, minter)
        .expect("reserve the pinned ckBTC minter id");
    pic.0.add_cycles(minter, 2_000_000_000_000);
    pic.0.install_canister(
        minter,
        mock_minter_wasm(),
        encode_one(&MockMinterInit {
            amount_ledger: ledger,
            gas_ledger: None,
        })
        .unwrap(),
        None,
    );

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
        get(&format!(
            "/api/v1/deposit/info?currency={DEPOSIT_CACHE_CURRENCY}"
        )),
    ));
    assert_eq!(s, StatusCode::OK, "first deposit_info call body={b}");
    assert_eq!(
        b["min_confirmations"], 1,
        "mock minter min_confirmations=1 (body={b})"
    );
    assert_eq!(
        b["deposit_fee"], "0",
        "mock get_deposit_fee=0, U64String-rendered (body={b})"
    );
    assert_eq!(
        b["deposit_min_amount"], "0",
        "mock deposit_btc_min_amount=Some(0) (body={b})"
    );

    // ---- (2) cache HIT: minter UNINSTALLED — only the relay's TTL cache can still answer ----
    pic.0
        .uninstall_canister(minter, None)
        .expect("uninstall_canister rejected");
    let (s2, b2) = rt.block_on(call(
        &state,
        get(&format!(
            "/api/v1/deposit/info?currency={DEPOSIT_CACHE_CURRENCY}"
        )),
    ));
    assert_eq!(
        s2,
        StatusCode::OK,
        "second call within the TTL must be served from the relay cache — the minter is GONE, \
         a fresh facade update would fail 503 (body={b2})"
    );
    assert_eq!(b2, b, "cached body must be byte-identical to the fresh one");
}
