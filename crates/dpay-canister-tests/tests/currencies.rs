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
#[derive(CandidType, Deserialize, Debug, PartialEq, Eq, Clone)]
enum MinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

/// Local mirror of the canister's `CurrencyDescriptor` (the `currencies()` return element).
#[derive(CandidType, Deserialize, Debug, PartialEq, Eq)]
struct CurrencyDescriptor {
    currency: Currency,
    ledger: Principal,
    mintable: bool,
    minter: Option<Principal>,
    minter_family: Option<MinterFamily>,
    symbol: Option<String>,
    decimals: Option<u8>,
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

fn register_currency_meta(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    currency: Currency,
    symbol: Option<String>,
    decimals: Option<u8>,
    family: Option<MinterFamily>,
) -> Result<(), String> {
    let reply = pic
        .update_call(
            dpay,
            caller,
            "register_currency_meta",
            encode_args((currency, symbol, decimals, family)).unwrap(),
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
    );
    assert!(r.is_err(), "anonymous must not register meta when a controller is set");
    // The controller succeeds.
    register_currency_meta(&pic, dpay, pic_admin(), DEMO_USD, Some("$".into()), Some(2), None)
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
    register_currency_meta(&pic, dpay, pic_admin(), CKX, Some("X".into()), Some(6), None)
        .expect("first register");
    register_currency_meta(&pic, dpay, pic_admin(), CKX, Some("◎".into()), Some(9), Some(MinterFamily::CkSol))
        .expect("second register replaces");

    let cat = currencies(&pic, dpay);
    assert_eq!(cat.len(), 1, "no duplicate entries");
    let ckx = &cat[0];
    assert_eq!(ckx.symbol.as_deref(), Some("◎"), "latest symbol wins");
    assert_eq!(ckx.decimals, Some(9));
    assert_eq!(ckx.minter_family, Some(MinterFamily::CkSol));
}
