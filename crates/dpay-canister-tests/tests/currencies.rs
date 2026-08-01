//! PocketIC proof that the `currencies()` catalog joins LEDGERS + MINTERS + CURRENCY_META correctly,
//! and that `register_currency_meta` is admin-gated like the other `register_*` ops. This is the
//! wallet's runtime source of truth (closes issue #7): the app reads currency ids from here instead
//! of hardcoding `DEPOSIT_CURRENCY`. No real ledger wasm is needed — `currencies()` is a pure
//! in-memory registry join (a `#[query]` cannot call out).

use candid::{decode_one, encode_args, encode_one, CandidType, Principal};
use dpay_core::{Currency, DEMO_USD};
use pocket_ic::PocketIc;
use serde::{Deserialize, Serialize};

/// A second currency standing in for a real ck token (ckBTC/ckETH/ckUSDC).
const CKX: Currency = 1;

#[derive(CandidType, Serialize)]
struct LedgerConfig {
    currency: Currency,
    principal: Principal,
    mintable: bool,
}

#[derive(CandidType, Serialize)]
struct DpayInitArg {
    ledgers: Vec<LedgerConfig>,
    per_tx_cap: u64,
    controller: Option<Principal>,
}

/// Local mirror of the canister's `MinterFamily` (decoded off the candid wire).
#[derive(CandidType, Deserialize, Serialize, Debug, PartialEq, Eq, Clone)]
enum MinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

/// Local mirror of the canister's `RampCapability` (MC1 unit 5, decoded off the candid wire).
#[derive(CandidType, Deserialize, Serialize, Debug, PartialEq, Eq, Clone)]
enum RampCapability {
    Direct,
    Partner,
    Unavailable,
}

/// Local mirror of the canister's `CurrencyDescriptor` (the `currencies()` return element). Mirrors
/// the full MC1 unit 5 field set.
#[derive(CandidType, Deserialize, Debug, PartialEq, Eq)]
struct CurrencyDescriptor {
    currency: Currency,
    ledger: Principal,
    mintable: bool,
    minter: Option<Principal>,
    minter_family: Option<MinterFamily>,
    symbol: Option<String>,
    decimals: Option<u8>,
    wrapper_name: Option<String>,
    backing_symbol: Option<String>,
    network: Option<String>,
    display_decimals: Option<u8>,
    fee: Option<u64>,
    cap: Option<u64>,
    chain_id: Option<u32>,
    token_contract: Option<String>,
    onramp: RampCapability,
    offramp: RampCapability,
}

fn workspace_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn dpay_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_CANISTER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("target/wasm32-unknown-unknown/release/dpay_canister.wasm")
        });
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read facade wasm at {}: {e}", path.display()))
}

/// A stable principal to use as the governed controller in admin-gating tests. The management
/// canister is a fixed, non-anonymous principal always available offline.
fn pic_admin() -> Principal {
    Principal::management_canister()
}

/// A valid, arbitrary principal built from raw bytes (no CRC text validation) — used as a distinct
/// ledger/minter fixture in the immutability tests. `b` selects which fixture, so several distinct
/// ones can be built. `from_slice` accepts any ≤29-byte slice (no checksum), so the value is always
/// wire-valid over candid regardless of the chosen byte.
fn dummy_principal(b: u8) -> Principal {
    Principal::from_slice(&[b; 29])
}

fn install_facade(
    pic: &PocketIc,
    controller: Option<Principal>,
    ledgers: Vec<LedgerConfig>,
) -> Principal {
    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);
    let init = DpayInitArg { ledgers, per_tx_cap: 100_000, controller };
    pic.install_canister(dpay, dpay_wasm(), encode_one(&init).unwrap(), None);
    dpay
}

fn currencies(pic: &PocketIc, dpay: Principal) -> Vec<CurrencyDescriptor> {
    let reply = pic
        .query_call(dpay, Principal::anonymous(), "currencies", encode_args(()).unwrap())
        .expect("currencies query rejected at IC level");
    decode_one(&reply).unwrap()
}

#[allow(clippy::too_many_arguments)]
fn register_currency_meta(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    currency: Currency,
    symbol: Option<String>,
    decimals: Option<u8>,
    family: Option<MinterFamily>,
    wrapper_name: Option<String>,
    backing_symbol: Option<String>,
    network: Option<String>,
    display_decimals: Option<u8>,
    fee: Option<u64>,
    cap: Option<u64>,
    chain_id: Option<u32>,
    token_contract: Option<String>,
    onramp: RampCapability,
    offramp: RampCapability,
) -> Result<(), String> {
    let reply = pic
        .update_call(
            dpay,
            caller,
            "register_currency_meta",
            encode_args((
                currency, symbol, decimals, family, wrapper_name, backing_symbol, network,
                display_decimals, fee, cap, chain_id, token_contract, onramp, offramp,
            ))
            .unwrap(),
        )
        .expect("register_currency_meta update_call rejected at IC level");
    decode_one(&reply).unwrap()
}

fn register_minter(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    currency: Currency,
    minter: Principal,
) -> Result<(), String> {
    let reply = pic
        .update_call(
            dpay,
            caller,
            "register_minter",
            encode_args((currency, minter)).unwrap(),
        )
        .expect("register_minter update_call rejected at IC level");
    decode_one(&reply).unwrap()
}

fn register_ledger(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    currency: Currency,
    principal: Principal,
    mintable: bool,
) -> Result<(), String> {
    let reply = pic
        .update_call(
            dpay,
            caller,
            "register_ledger",
            encode_args((currency, principal, mintable)).unwrap(),
        )
        .expect("register_ledger update_call rejected at IC level");
    decode_one(&reply).unwrap()
}

#[test]
fn currencies_joins_all_three_registries() {
    let pic = PocketIc::new();
    let dusd_ledger = Principal::from_text("aaaaa-aa").unwrap(); // dummy; query never calls it
    let ckx_ledger = Principal::anonymous();
    let ckx_minter = Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![
            LedgerConfig { currency: DEMO_USD, principal: dusd_ledger, mintable: true },
            LedgerConfig { currency: CKX, principal: ckx_ledger, mintable: false },
        ],
    );

    // No minter / no meta yet — catalog still lists both ledgers, ramp/display fields None.
    let cat = currencies(&pic, dpay);
    assert_eq!(cat.len(), 2, "both seeded ledgers appear");
    assert_eq!(cat[0].currency, DEMO_USD, "sorted by currency id");
    assert_eq!(cat[0].ledger, dusd_ledger);
    assert!(cat[0].mintable);
    assert_eq!(cat[0].minter, None);
    assert_eq!(cat[0].minter_family, None);
    assert_eq!(cat[0].symbol, None);
    assert_eq!(cat[1].currency, CKX);
    assert!(!cat[1].mintable);
    assert_eq!(cat[1].minter, None);

    // Register the ck minter + display/family meta for currency 1 (the ckBTC-shaped path).
    register_minter(&pic, dpay, pic_admin(), CKX, ckx_minter).expect("register_minter ok");
    register_currency_meta(
        &pic, dpay, pic_admin(), CKX, Some("₿".into()), Some(8), Some(MinterFamily::CkBtcUtxo),
        None, None, None, None, None, None, None, None,
        RampCapability::Unavailable, RampCapability::Unavailable,
    )
    .expect("register_currency_meta ok");

    let cat = currencies(&pic, dpay);
    let ckx = cat.iter().find(|d| d.currency == CKX).unwrap();
    assert_eq!(ckx.minter, Some(ckx_minter));
    assert_eq!(ckx.minter_family, Some(MinterFamily::CkBtcUtxo));
    assert_eq!(ckx.symbol.as_deref(), Some("₿"));
    assert_eq!(ckx.decimals, Some(8));
    assert!(!ckx.mintable);

    // The demo currency keeps its no-ramp shape (no minter, no family) — the join does not leak.
    let dusd = cat.iter().find(|d| d.currency == DEMO_USD).unwrap();
    assert_eq!(dusd.minter, None);
    assert_eq!(dusd.minter_family, None);
}

#[test]
fn currencies_is_sorted_by_id() {
    // Register ledgers out of numeric order; the catalog must still come back sorted.
    let pic = PocketIc::new();
    let high = 7u32;
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![
            LedgerConfig { currency: high, principal: Principal::anonymous(), mintable: false },
            LedgerConfig { currency: DEMO_USD, principal: Principal::anonymous(), mintable: true },
            LedgerConfig { currency: CKX, principal: Principal::anonymous(), mintable: false },
        ],
    );
    let cat = currencies(&pic, dpay);
    let ids: Vec<u32> = cat.into_iter().map(|d| d.currency).collect();
    assert_eq!(ids, vec![DEMO_USD, CKX, high], "catalog is sorted by currency id");
}

#[test]
fn register_currency_meta_is_admin_gated() {
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: DEMO_USD, principal: Principal::anonymous(), mintable: true }],
    );
    // A non-controller caller is rejected (a fake symbol must not poison the wallet's catalog).
    let r = register_currency_meta(
        &pic, dpay, Principal::anonymous(), DEMO_USD, Some("$".into()), Some(2), None,
        None, None, None, None, None, None, None, None,
        RampCapability::Unavailable, RampCapability::Unavailable,
    );
    assert!(r.is_err(), "anonymous must not register meta when a controller is set");
    // The controller succeeds.
    register_currency_meta(
        &pic, dpay, pic_admin(), DEMO_USD, Some("$".into()), Some(2), None,
        None, None, None, None, None, None, None, None,
        RampCapability::Unavailable, RampCapability::Unavailable,
    )
    .expect("controller registers meta");
}

#[test]
fn register_currency_meta_rejected_when_no_controller() {
    // Open demo mode (controller=null): require_admin() rejects, mirroring register_ledger/minter.
    // The catalog therefore returns None display fields until an operator seeds a controller; the
    // wallet falls back to its bundled defaults. This keeps the open-admin default closed.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        None,
        vec![LedgerConfig { currency: DEMO_USD, principal: Principal::anonymous(), mintable: true }],
    );
    let r = register_currency_meta(
        &pic, dpay, Principal::anonymous(), DEMO_USD, Some("$".into()), Some(2), None,
        None, None, None, None, None, None, None, None,
        RampCapability::Unavailable, RampCapability::Unavailable,
    );
    assert!(r.is_err(), "register_currency_meta must be closed in open-demo mode");
}

#[test]
fn register_currency_meta_replaces_in_place() {
    // Re-registering replaces (not appends) — the join must reflect the latest value, and the map
    // size must not grow.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: CKX, principal: Principal::anonymous(), mintable: false }],
    );
    register_currency_meta(
        &pic, dpay, pic_admin(), CKX, Some("X".into()), Some(6), None,
        None, None, None, None, None, None, None, None,
        RampCapability::Unavailable, RampCapability::Unavailable,
    )
    .expect("first register");
    register_currency_meta(
        &pic, dpay, pic_admin(), CKX, Some("◎".into()), Some(9), Some(MinterFamily::CkSol),
        None, None, None, None, None, None, None, None,
        RampCapability::Unavailable, RampCapability::Unavailable,
    )
    .expect("second register replaces");

    let cat = currencies(&pic, dpay);
    assert_eq!(cat.len(), 1, "no duplicate entries");
    let ckx = &cat[0];
    assert_eq!(ckx.symbol.as_deref(), Some("◎"), "latest symbol wins");
    assert_eq!(ckx.decimals, Some(9));
    assert_eq!(ckx.minter_family, Some(MinterFamily::CkSol));
}

// --- MC1 unit 5: authoritative per-currency asset metadata ------------------------------------
// RED-first proof that `register_currency_meta` stores + `currencies()` returns the full new field
// set (ramp capability, backing symbol, fee/cap, chain id, token contract) — the authoritative
// single source of truth the relay passes through and the app caches. Closes "every CkEthErc20
// inherits USDC assumptions" + "the relay hardcodes currency 2 for ckERC20 params".

#[test]
fn register_currency_meta_stores_full_authoritative_field_set() {
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![
            LedgerConfig { currency: DEMO_USD, principal: Principal::anonymous(), mintable: true },
            LedgerConfig { currency: 1, principal: Principal::anonymous(), mintable: false },
            LedgerConfig { currency: 2, principal: Principal::anonymous(), mintable: false },
        ],
    );

    // DEMO (0): onramp=Direct (faucet), offramp=Unavailable (play money, no cash-out).
    register_currency_meta(
        &pic, dpay, pic_admin(), DEMO_USD, Some("$".into()), Some(2), None,
        None, None, None, None, None, None, None, None,
        RampCapability::Direct, RampCapability::Unavailable,
    )
    .expect("register DEMO meta");

    // ckBTC (1): onramp=Direct, offramp=Direct, backing BTC.
    register_currency_meta(
        &pic, dpay, pic_admin(), 1, Some("₿".into()), Some(8), Some(MinterFamily::CkBtcUtxo),
        Some("ckBTC".into()), Some("BTC".into()), Some("Bitcoin".into()), Some(8),
        None, None, None, None,
        RampCapability::Direct, RampCapability::Direct,
    )
    .expect("register ckBTC meta");

    // ckUSDC (2): onramp=Direct, offramp=Unavailable (Fork-C/O3 — NO cash-out), ERC-20 params.
    register_currency_meta(
        &pic, dpay, pic_admin(), 2, Some("ckUSDC".into()), Some(6), Some(MinterFamily::CkEthErc20),
        Some("ckUSDC".into()), Some("USDC".into()), Some("Ethereum".into()), Some(6),
        Some(10_000), None, Some(1),
        Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".into()),
        RampCapability::Direct, RampCapability::Unavailable,
    )
    .expect("register ckUSDC meta");

    let cat = currencies(&pic, dpay);
    assert_eq!(cat.len(), 3, "all three seeded ledgers appear");

    // ckBTC: authoritative per-currency metadata populated.
    let ckbtc = cat.iter().find(|d| d.currency == 1).unwrap();
    assert_eq!(ckbtc.wrapper_name.as_deref(), Some("ckBTC"));
    assert_eq!(ckbtc.backing_symbol.as_deref(), Some("BTC"));
    assert_eq!(ckbtc.network.as_deref(), Some("Bitcoin"));
    assert_eq!(ckbtc.display_decimals, Some(8));
    assert_eq!(ckbtc.onramp, RampCapability::Direct);
    assert_eq!(ckbtc.offramp, RampCapability::Direct);

    // ckUSDC: per-token ckERC20 facts replace the old hardcoded currency-2 params (O6). CRITICAL
    // honesty assertion: offramp is Unavailable so the wallet shows NO cash-out button (Fork-C).
    let ckusdc = cat.iter().find(|d| d.currency == 2).unwrap();
    assert_eq!(ckusdc.wrapper_name.as_deref(), Some("ckUSDC"));
    assert_eq!(ckusdc.backing_symbol.as_deref(), Some("USDC"));
    assert_eq!(ckusdc.network.as_deref(), Some("Ethereum"));
    assert_eq!(ckusdc.fee, Some(10_000), "ckUSDC icrc1_fee (O6) = 10000 raw");
    assert_eq!(ckusdc.chain_id, Some(1), "Ethereum mainnet");
    assert_eq!(
        ckusdc.token_contract.as_deref(),
        Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
    );
    assert_eq!(ckusdc.onramp, RampCapability::Direct, "ckETH helper onramp");
    assert_eq!(ckusdc.offramp, RampCapability::Unavailable, "NO cash-out (Fork-C/O3)");

    // DEMO: onramp=Direct (faucet), offramp=Unavailable.
    let demo = cat.iter().find(|d| d.currency == DEMO_USD).unwrap();
    assert_eq!(demo.onramp, RampCapability::Direct);
    assert_eq!(demo.offramp, RampCapability::Unavailable);
}

#[test]
fn currencies_defaults_ramps_to_unavailable_when_no_meta_registered() {
    // Fail-closed: a currency with NO meta registered (the pre-MC1-unit-5 state) must surface
    // Unavailable for BOTH ramp directions — the wallet renders NO fund/cash-out button for it.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: 7, principal: Principal::anonymous(), mintable: false }],
    );
    let cat = currencies(&pic, dpay);
    let lone = &cat[0];
    assert_eq!(lone.currency, 7);
    assert_eq!(lone.onramp, RampCapability::Unavailable, "no meta ⇒ no onramp advertised");
    assert_eq!(lone.offramp, RampCapability::Unavailable, "no meta ⇒ no offramp advertised");
    assert_eq!(lone.wrapper_name, None);
    assert_eq!(lone.backing_symbol, None);
    assert_eq!(lone.token_contract, None);
}

// --- MC2 unit 2: immutable currency identity (insert-only ledger + minter) --------------------
// RED-first proof that a currency's ledger + minter principal is INSERT-ONLY once registered:
// re-registering with a DIFFERENT principal (or mintable flag) is REJECTED, while re-registering
// with the SAME value is a no-op idempotent Ok (keeps deploy scripts re-runnable). Display metadata
// (`register_currency_meta`) deliberately stays UPDATABLE — see `register_currency_meta_replaces_in_place`.

/// A currency id that is NOT seeded in any init ledgers below, so the first `register_ledger` call
/// is always a fresh insert.
const FRESH: Currency = 9;

#[test]
fn register_ledger_fresh_currency_inserts_and_shows_in_catalog() {
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: DEMO_USD, principal: Principal::anonymous(), mintable: true }],
    );
    let ledger_a = dummy_principal(1);
    let ledger_b = dummy_principal(2);
    assert_ne!(ledger_a, ledger_b, "test fixtures must be distinct");

    // Fresh insert: Ok.
    register_ledger(&pic, dpay, pic_admin(), FRESH, ledger_a, true).expect("fresh register_ledger ok");

    let cat = currencies(&pic, dpay);
    let fresh = cat.iter().find(|d| d.currency == FRESH).expect("fresh currency appears in catalog");
    assert_eq!(fresh.ledger, ledger_a, "catalog reflects the inserted ledger principal");
    assert!(fresh.mintable, "catalog reflects the inserted mintable flag");
}

#[test]
fn register_ledger_rejects_reassignment_and_leaves_original_unchanged() {
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: DEMO_USD, principal: Principal::anonymous(), mintable: true }],
    );
    let ledger_a = dummy_principal(1);
    let ledger_b = dummy_principal(2);
    assert_ne!(ledger_a, ledger_b);

    register_ledger(&pic, dpay, pic_admin(), FRESH, ledger_a, true).expect("seed register ok");

    // Re-register with a DIFFERENT principal → REJECTED with a debuggable, currency-named message.
    let err = register_ledger(&pic, dpay, pic_admin(), FRESH, ledger_b, true)
        .expect_err("reassigning the ledger principal must be rejected");
    assert!(
        err.contains("immutable"),
        "error must call out immutability, got: {err}"
    );
    assert!(
        err.contains(&format!("currency {}", FRESH)),
        "error must name the offending currency id, got: {err}"
    );

    // Re-register with the SAME principal but a DIFFERENT mintable flag → also REJECTED (mintable is
    // part of the immutable identity — a demo↔real flip must not silently re-target a currency).
    let err_mintable = register_ledger(&pic, dpay, pic_admin(), FRESH, ledger_a, false)
        .expect_err("flipping the mintable flag must be rejected");
    assert!(err_mintable.contains("immutable"), "mintable-flip error: {err_mintable}");

    // The original ledger is UNCHANGED.
    let cat = currencies(&pic, dpay);
    let fresh = cat.iter().find(|d| d.currency == FRESH).unwrap();
    assert_eq!(fresh.ledger, ledger_a, "ledger principal must be unchanged after a rejected reassign");
    assert!(fresh.mintable, "mintable flag must be unchanged after a rejected reassign");
}

#[test]
fn register_ledger_same_value_is_idempotent() {
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: DEMO_USD, principal: Principal::anonymous(), mintable: true }],
    );
    let ledger_a = dummy_principal(1);

    register_ledger(&pic, dpay, pic_admin(), FRESH, ledger_a, true).expect("seed register ok");
    // Re-register with the SAME principal + SAME mintable → Ok (no-op idempotent). Deploy scripts are
    // re-runnable: a replay does not blow up on an already-registered currency.
    register_ledger(&pic, dpay, pic_admin(), FRESH, ledger_a, true)
        .expect("idempotent re-register must succeed");

    let cat = currencies(&pic, dpay);
    assert_eq!(
        cat.iter().filter(|d| d.currency == FRESH).count(),
        1,
        "no duplicate entries after idempotent re-register"
    );
    let fresh = cat.iter().find(|d| d.currency == FRESH).unwrap();
    assert_eq!(fresh.ledger, ledger_a);
    assert!(fresh.mintable);
}

#[test]
fn register_minter_fresh_currency_inserts_and_shows_in_catalog() {
    let pic = PocketIc::new();
    // Seed a ledger for FRESH so it appears in the catalog join (currencies() only lists currencies
    // WITH a ledger); the minter is registered separately afterward.
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: FRESH, principal: Principal::anonymous(), mintable: false }],
    );
    let minter_a = dummy_principal(3);
    let minter_b = dummy_principal(4);
    assert_ne!(minter_a, minter_b, "test fixtures must be distinct");

    // Fresh insert: Ok.
    register_minter(&pic, dpay, pic_admin(), FRESH, minter_a).expect("fresh register_minter ok");

    let cat = currencies(&pic, dpay);
    let fresh = cat.iter().find(|d| d.currency == FRESH).expect("fresh currency appears in catalog");
    assert_eq!(fresh.minter, Some(minter_a), "catalog reflects the inserted minter principal");
}

#[test]
fn register_minter_rejects_reassignment_and_leaves_original_unchanged() {
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: FRESH, principal: Principal::anonymous(), mintable: false }],
    );
    let minter_a = dummy_principal(3);
    let minter_b = dummy_principal(4);
    assert_ne!(minter_a, minter_b);

    register_minter(&pic, dpay, pic_admin(), FRESH, minter_a).expect("seed register ok");

    // Re-register with a DIFFERENT minter → REJECTED with a debuggable, currency-named message.
    let err = register_minter(&pic, dpay, pic_admin(), FRESH, minter_b)
        .expect_err("reassigning the minter principal must be rejected");
    assert!(err.contains("immutable"), "error must call out immutability, got: {err}");
    assert!(
        err.contains(&format!("currency {}", FRESH)),
        "error must name the offending currency id, got: {err}"
    );

    // The original minter is UNCHANGED.
    let cat = currencies(&pic, dpay);
    let fresh = cat.iter().find(|d| d.currency == FRESH).unwrap();
    assert_eq!(fresh.minter, Some(minter_a), "minter principal must be unchanged after a rejected reassign");
}

#[test]
fn register_minter_same_value_is_idempotent() {
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: FRESH, principal: Principal::anonymous(), mintable: false }],
    );
    let minter_a = dummy_principal(3);

    register_minter(&pic, dpay, pic_admin(), FRESH, minter_a).expect("seed register ok");
    // Re-register with the SAME minter → Ok (no-op idempotent). Deploy scripts are re-runnable.
    register_minter(&pic, dpay, pic_admin(), FRESH, minter_a)
        .expect("idempotent re-register must succeed");

    let cat = currencies(&pic, dpay);
    let fresh = cat.iter().find(|d| d.currency == FRESH).unwrap();
    assert_eq!(fresh.minter, Some(minter_a));
}

// --- MC2 unit 3: irreversible retire + append-only RETIRED set ---------------------------------
// RED-first proof that `retire_currency` is an IRREVERSIBLE operation: a retired currency id leaves
// the wallet catalog (`currencies()` skips it), can never be re-registered (`register_ledger`/
// `register_minter` reject a retired id), is admin-gated, and is idempotent. The id is dead forever;
// "retire + create a new id" is the only replacement. History is preserved (see icrc_settle.rs).

/// `retire_currency(nat32) -> Result<(), text>` — admin-gated, irreversible, idempotent. Marks a
/// currency id as RETIRED (it leaves the catalog; pay/withdraw/mint reject it); the id can never be
/// reused or un-retired.
fn retire_currency(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    currency: Currency,
) -> Result<(), String> {
    let reply = pic
        .update_call(
            dpay,
            caller,
            "retire_currency",
            encode_args((currency,)).unwrap(),
        )
        .expect("retire_currency update_call rejected at IC level");
    decode_one(&reply).unwrap()
}

#[test]
fn retire_currency_removes_currency_from_catalog() {
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![
            LedgerConfig { currency: DEMO_USD, principal: Principal::anonymous(), mintable: true },
            LedgerConfig { currency: CKX, principal: Principal::anonymous(), mintable: false },
        ],
    );

    // Both currencies appear before retire.
    let cat = currencies(&pic, dpay);
    assert_eq!(cat.len(), 2, "both seeded ledgers appear pre-retire");

    // Retire CKX → Ok; it must leave the catalog entirely.
    retire_currency(&pic, dpay, pic_admin(), CKX).expect("controller retires CKX");

    let cat = currencies(&pic, dpay);
    assert_eq!(cat.len(), 1, "retired currency leaves the catalog");
    assert!(cat.iter().all(|d| d.currency != CKX), "CKX must not appear after retire");
    assert_eq!(cat[0].currency, DEMO_USD, "the non-retired currency stays");
}

#[test]
fn register_ledger_on_retired_id_is_rejected() {
    // A retired id is dead forever — it can never be re-registered (no reuse, no un-retire). The guard
    // fires BEFORE the insert-only immutability logic.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: FRESH, principal: dummy_principal(1), mintable: false }],
    );

    retire_currency(&pic, dpay, pic_admin(), FRESH).expect("retire FRESH");

    // Re-registering the ledger for the retired id → REJECTED with a retired/id-not-reusable message.
    let err = register_ledger(&pic, dpay, pic_admin(), FRESH, dummy_principal(2), false)
        .expect_err("registering a retired id must be rejected");
    assert!(err.contains("retired"), "error must say retired, got: {err}");
    assert!(
        err.contains(&format!("currency {}", FRESH)),
        "error must name the offending currency id, got: {err}"
    );
}

#[test]
fn register_minter_on_retired_id_is_rejected() {
    // Mirrors register_ledger: a retired id's minter can never be re-registered either.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: FRESH, principal: Principal::anonymous(), mintable: false }],
    );

    retire_currency(&pic, dpay, pic_admin(), FRESH).expect("retire FRESH");

    let err = register_minter(&pic, dpay, pic_admin(), FRESH, dummy_principal(3))
        .expect_err("registering a minter for a retired id must be rejected");
    assert!(err.contains("retired"), "error must say retired, got: {err}");
}

#[test]
fn retire_currency_is_admin_gated() {
    // A non-controller caller cannot retire a currency (require_admin gate, like the other privileged
    // ops). An anonymous caller is rejected.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: FRESH, principal: Principal::anonymous(), mintable: false }],
    );

    let err = retire_currency(&pic, dpay, Principal::anonymous(), FRESH)
        .expect_err("anonymous must not retire a currency when a controller is set");
    assert!(
        err.contains("unauthorized") || err.contains("admin"),
        "error must be an admin-gate rejection, got: {err}"
    );

    // The currency is STILL in the catalog (the rejected retire changed nothing).
    let cat = currencies(&pic, dpay);
    assert!(cat.iter().any(|d| d.currency == FRESH), "rejected retire leaves catalog unchanged");
}

#[test]
fn retire_currency_is_idempotent() {
    // Retiring an already-retired currency → Ok (idempotent). The RETIRED set is append-only.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: FRESH, principal: Principal::anonymous(), mintable: false }],
    );

    retire_currency(&pic, dpay, pic_admin(), FRESH).expect("first retire ok");
    // Retiring again is a no-op Ok, not an error.
    retire_currency(&pic, dpay, pic_admin(), FRESH).expect("idempotent second retire ok");

    let cat = currencies(&pic, dpay);
    assert!(cat.iter().all(|d| d.currency != FRESH), "still retired after idempotent re-retire");
}

// --- MC2 unit 4: atomic register_currency (admin gate + immutability + retired) -----------------
// RED-first proof that `register_currency` — the single atomic activation path — is admin-gated,
// refuses an already-existing currency id (immutability, reusing U2's intent), and refuses a retired
// id (reusing U3's intent). The cross-canister strict-validation + atomicity + happy-path proofs
// live in `icrc_settle.rs` (they need a real ic-icrc1-ledger); these three tests exercise only the
// gates that fire BEFORE any cross-canister call, so no real ledger is needed here.

/// Local mirror of the canister's `CurrencyRegistration` candid RECORD arg (MC2 U4). The field set
/// mirrors `register_currency_meta`'s arg list EXACTLY (so the meta it inserts is identical), plus
/// the activation fields `currency`/`ledger`/`mintable`/`minter`. `decimals`/`fee`/`wrapper_name` are
/// non-optional (they are the strict-validation inputs checked against the live ledger); the
/// remaining meta fields stay optional. Used to ENCODE the `register_currency` call args.
#[derive(CandidType, Serialize)]
struct CurrencyRegistration {
    currency: Currency,
    ledger: Principal,
    mintable: bool,
    minter: Option<Principal>,
    symbol: Option<String>,
    decimals: u8,
    minter_family: Option<MinterFamily>,
    wrapper_name: String,
    backing_symbol: Option<String>,
    network: Option<String>,
    display_decimals: Option<u8>,
    fee: u64,
    cap: Option<u64>,
    chain_id: Option<u32>,
    token_contract: Option<String>,
    onramp: RampCapability,
    offramp: RampCapability,
}

/// `register_currency(CurrencyRegistration) -> Result<(), text>` — the atomic activation path.
/// Called by `caller`; returns the canister's typed Result.
#[allow(clippy::too_many_arguments)]
fn register_currency(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    reg: CurrencyRegistration,
) -> Result<(), String> {
    let reply = pic
        .update_call(dpay, caller, "register_currency", encode_one(&reg).unwrap())
        .expect("register_currency update_call rejected at IC level");
    decode_one(&reply).unwrap()
}

/// Build a minimal valid-looking `CurrencyRegistration` for a fresh currency id. The validation
/// fields are set to dummy values that would NOT pass strict validation against a real ledger — these
/// tests never reach the validation step (they are rejected at the admin/immutability/retired gate
/// first), so the dummy values are never checked.
fn fresh_registration(currency: Currency) -> CurrencyRegistration {
    CurrencyRegistration {
        currency,
        ledger: dummy_principal(7),
        mintable: false,
        minter: None,
        symbol: None,
        decimals: 2,
        minter_family: None,
        wrapper_name: "DUMMY".into(),
        backing_symbol: None,
        network: None,
        display_decimals: None,
        fee: 0,
        cap: None,
        chain_id: None,
        token_contract: None,
        onramp: RampCapability::Unavailable,
        offramp: RampCapability::Unavailable,
    }
}

#[test]
fn register_currency_is_admin_gated() {
    // A non-controller caller is rejected at `require_admin` BEFORE any cross-canister validation
    // call (so no real ledger is needed for this test). Mirrors the gate on register_ledger/minter.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: DEMO_USD, principal: Principal::anonymous(), mintable: true }],
    );

    let err = register_currency(&pic, dpay, Principal::anonymous(), fresh_registration(FRESH))
        .expect_err("anonymous must not register_currency when a controller is set");
    assert!(
        err.contains("unauthorized") || err.contains("admin"),
        "error must be an admin-gate rejection, got: {err}"
    );

    // The fresh currency was NOT inserted (the gate fired before any insert).
    let cat = currencies(&pic, dpay);
    assert!(cat.iter().all(|d| d.currency != FRESH), "rejected register_currency inserted nothing");
}

#[test]
fn register_currency_rejects_existing_id() {
    // register_currency activates a NEW currency — an id that already exists in LEDGERS is rejected
    // (immutability, reusing U2's intent). The check fires BEFORE cross-canister validation, so no
    // real ledger is needed. FRESH is seeded at init (it has a ledger row), so register_currency for
    // it is rejected without ever calling the ledger.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: FRESH, principal: dummy_principal(1), mintable: false }],
    );

    let err = register_currency(&pic, dpay, pic_admin(), fresh_registration(FRESH))
        .expect_err("register_currency for an existing id must be rejected");
    assert!(
        err.contains("already exists") || err.contains("immutable"),
        "error must call out the existing id, got: {err}"
    );
    assert!(
        err.contains(&format!("currency {}", FRESH)),
        "error must name the offending currency id, got: {err}"
    );

    // The original ledger row is UNCHANGED (the rejected call inserted nothing).
    let cat = currencies(&pic, dpay);
    let fresh = cat.iter().find(|d| d.currency == FRESH).unwrap();
    assert_eq!(fresh.ledger, dummy_principal(1), "original ledger unchanged");
}

#[test]
fn register_currency_rejects_retired_id() {
    // A retired id is dead forever and can NEVER be re-registered (reusing U3's intent). The RETIRED
    // guard fires BEFORE cross-canister validation, so no real ledger is needed. Retire FRESH (seeded
    // at init), then register_currency for it → rejected with a retired/id-not-reusable message.
    let pic = PocketIc::new();
    let dpay = install_facade(
        &pic,
        Some(pic_admin()),
        vec![LedgerConfig { currency: FRESH, principal: dummy_principal(1), mintable: false }],
    );

    retire_currency(&pic, dpay, pic_admin(), FRESH).expect("retire FRESH");

    let err = register_currency(&pic, dpay, pic_admin(), fresh_registration(FRESH))
        .expect_err("register_currency for a retired id must be rejected");
    assert!(err.contains("retired"), "error must say retired, got: {err}");
    assert!(
        err.contains(&format!("currency {}", FRESH)),
        "error must name the offending currency id, got: {err}"
    );
}
