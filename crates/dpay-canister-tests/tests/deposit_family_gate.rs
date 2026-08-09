//! RED-first TDD for the deposit **family gate** (MC0 follow-up to the withdraw family dispatch).
//!
//! The three `#[update]` deposit proxies (`deposit_address` / `deposit_info` / `refresh_deposit`)
//! were once family-blind: they unconditionally called the BTC-minter-only methods
//! (`get_btc_address` / `get_minter_info` + `get_deposit_fee` / `update_balance`). On prod this 503'd
//! every CkEthErc20-family currency (ckETH mainnet = id 6, ckUSDC = id 2): the ckETH minter has NO
//! `get_btc_address` method (`IC0536 Canister has no update method 'get_btc_address'`) and returns a
//! DIFFERENT `MinterInfo` shape (`CandidDecodeFailed`). The wallet NEVER calls these for ETH-family
//! (it routes to the helper-contract onramp / `ckerc20OnrampParams`), so this is a prod API-correctness
//! + log-hygiene fix — but the family-blind methods are landmines.
//!
//! This file pins the gate that mirrors `withdraw`'s family dispatch: the BTC deposit path is only
//! reachable when the resolved family is `CkBtcUtxo` (incl. the legacy "has minter, no family" default);
//! any other family OR a currency with neither minter nor family fails closed with a clean typed Err.
//!
//! KEY PROOF: the second currency (CKETH=7) points at the SAME BTC-shaped mock minter as CKBTC. Against
//! the UNFIXED code the mock happily responds to the BTC methods and the calls return Ok — so the
//! `assert!(...is_err())` FAILS (RED). The gate must fire on FAMILY, not on minter behaviour.

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use dpay_core::{generate_keypair, Currency};
use ed25519_dalek::SigningKey;
use icrc_ledger_types::icrc1::account::Account;
use pocket_ic::{PocketIc, Time};
use serde::Deserialize;

const T0_SECS: u64 = 1_800_000_000;
const T0_NANOS: u64 = T0_SECS * 1_000_000_000;
const CAP: u64 = 100_000;

const CKBTC: Currency = 1;
/// A second currency registered as `CkEthErc20` family but pointing at the SAME BTC-shaped mock
/// minter as CKBTC. The family gate must short-circuit BEFORE any minter call.
const CKETH: Currency = 7;

#[allow(dead_code)]
#[derive(CandidType, serde::Serialize)]
enum MetadataValue {
    Nat(Nat),
    Int(candid::Int),
    Text(String),
    Blob(Vec<u8>),
}

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
    metadata: Vec<(String, MetadataValue)>,
    initial_balances: Vec<(Account, Nat)>,
    feature_flags: Option<FeatureFlags>,
    archive_options: ArchiveOptions,
    index_principal: Option<Principal>,
}

#[derive(CandidType, serde::Serialize)]
enum LedgerArg {
    Init(LedgerInitArgs),
}

#[derive(CandidType, serde::Serialize)]
struct LedgerConfig {
    currency: Currency,
    principal: Principal,
    mintable: bool,
}

#[derive(CandidType, serde::Serialize)]
struct DpayInitArg {
    ledgers: Vec<LedgerConfig>,
    per_tx_cap: u64,
    controller: Option<Principal>,
}

#[derive(CandidType, serde::Serialize)]
struct MockMinterInit {
    amount_ledger: Principal,
    gas_ledger: Option<Principal>,
}

/// Local mirror of the canister's `MinterFamily` (candid wire type). Variant ORDER must match
/// `types::MinterFamily` (CkBtcUtxo=0, CkEthErc20=1, CkSol=2) — candid encodes enum variants by
/// index, so reordering here would silently re-target the family being registered.
#[allow(dead_code)] // mirror type; only some variants are constructed in this file
#[derive(CandidType, serde::Serialize)]
enum MinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

/// Local mirror of the canister's `RampCapability` (candid wire type) — needed to encode
/// `register_currency_meta`.
#[allow(dead_code)] // mirror type; only some variants are constructed in this file
#[derive(CandidType, serde::Serialize)]
enum RampCapability {
    Direct,
    Partner,
    Unavailable,
}

#[derive(CandidType, Deserialize, Debug)]
struct DepositInfo {
    min_confirmations: u32,
    deposit_fee: u64,
    deposit_min_amount: Option<u64>,
}

#[derive(CandidType, Deserialize, Debug)]
struct MintedUtxo {
    block_index: Nat,
    amount: u64,
}

#[derive(CandidType, Deserialize, Debug)]
struct PendingUtxo {
    value: u64,
    confirmations: u64,
}

#[derive(CandidType, Deserialize, Debug)]
struct DepositRefresh {
    minted: Vec<MintedUtxo>,
    minted_total: u64,
    pending: Vec<PendingUtxo>,
    required_confirmations: u32,
}

fn workspace_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
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

fn dpay_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_CANISTER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("target/wasm32-unknown-unknown/release/dpay_canister.wasm")
        });
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read facade wasm at {}: {e}", path.display()))
}

fn mock_minter_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_MOCK_MINTER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("target/wasm32-unknown-unknown/release/dpay_mock_minter.wasm")
        });
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read mock-minter wasm at {}: {e}", path.display()))
}

fn install_ledger(
    pic: &PocketIc,
    minting_account: Account,
    symbol: &str,
    transfer_fee: u64,
    initial_balances: Vec<(Account, Nat)>,
) -> Principal {
    let ledger = pic.create_canister();
    pic.add_cycles(ledger, 10_000_000_000_000);
    let init = LedgerArg::Init(LedgerInitArgs {
        minting_account,
        fee_collector_account: None,
        transfer_fee: Nat::from(transfer_fee),
        decimals: Some(2),
        max_memo_length: None,
        token_symbol: symbol.into(),
        token_name: format!("Demo {symbol}"),
        metadata: vec![],
        initial_balances,
        feature_flags: Some(FeatureFlags { icrc2: true, icrc152: false }),
        archive_options: ArchiveOptions {
            num_blocks_to_archive: 10_000,
            max_transactions_per_response: None,
            trigger_threshold: 10_000_000,
            max_message_size_bytes: None,
            cycles_for_archive_creation: None,
            node_max_memory_size_bytes: None,
            controller_id: minting_account.owner,
            more_controller_ids: None,
        },
        index_principal: None,
    });
    pic.install_canister(ledger, ledger_wasm(), encode_one(&init).unwrap(), None);
    ledger
}

// --- deposit proxies, parameterized by currency (the deposit.rs helpers are CKBTC-hardcoded) -----

fn deposit_address(
    pic: &PocketIc,
    dpay: Principal,
    pk: [u8; 32],
    currency: Currency,
) -> Result<String, String> {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "deposit_address",
            encode_args((pk.to_vec(), currency)).unwrap(),
        )
        .expect("deposit_address update_call rejected");
    decode_one::<Result<String, String>>(&reply).unwrap()
}

fn deposit_info(pic: &PocketIc, dpay: Principal, currency: Currency) -> Result<DepositInfo, String> {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "deposit_info",
            encode_args((currency,)).unwrap(),
        )
        .expect("deposit_info update_call rejected");
    decode_one::<Result<DepositInfo, String>>(&reply).unwrap()
}

fn refresh_deposit(
    pic: &PocketIc,
    dpay: Principal,
    pk: [u8; 32],
    currency: Currency,
) -> Result<DepositRefresh, String> {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "refresh_deposit",
            encode_args((pk.to_vec(), currency)).unwrap(),
        )
        .expect("refresh_deposit update_call rejected");
    decode_one::<Result<DepositRefresh, String>>(&reply).unwrap()
}

/// `register_currency_meta` for a currency WITH a minter family (the deposit.rs helper hardcodes
/// `None`). Field ORDER must match the canister signature exactly (positional candid tuple).
fn register_currency_meta_family(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    currency: Currency,
    family: MinterFamily,
    cap: u64,
) {
    let reply = pic
        .update_call(
            dpay,
            caller,
            "register_currency_meta",
            encode_args((
                currency,
                None::<String>,               // symbol
                None::<u8>,                   // decimals
                Some(family),                 // minter_family
                None::<String>,               // wrapper_name
                None::<String>,               // backing_symbol
                None::<String>,               // network
                None::<u8>,                   // display_decimals
                None::<u64>,                  // fee
                Some(cap),                    // cap
                None::<u32>,                  // chain_id
                None::<String>,               // token_contract
                RampCapability::Unavailable,  // onramp
                RampCapability::Unavailable,  // offramp
                None::<Principal>,            // gas_ledger
            ))
            .unwrap(),
        )
        .expect("register_currency_meta update_call rejected");
    decode_one::<Result<(), String>>(&reply)
        .unwrap()
        .expect("register_currency_meta should succeed for the controller");
}

/// Two-family setup: CKBTC=1 (no family meta → legacy `CkBtcUtxo` default) and CKETH=7
/// (`CkEthErc20` family), BOTH pointing at the SAME BTC-shaped mock minter. The mock is initialized
/// against the CKBTC ledger and responds to the BTC minter methods regardless of which currency the
/// facade resolved — which is exactly the trap: against the unfixed code the ETH-family calls return
/// Ok because the mock is BTC-shaped, proving the gate must fire on FAMILY, not minter behaviour.
fn setup_two_families() -> (PocketIc, Principal, Principal, SigningKey, [u8; 32]) {
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));

    let payer_sk = generate_keypair();
    let payer = payer_sk.verifying_key().to_bytes();

    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);
    let mock = pic.create_canister();
    pic.add_cycles(mock, 2_000_000_000_000);

    // Two ledgers, both with the mock as the minting-account owner. The mock is wired to the CKBTC
    // ledger only — it never gets called for CKETH once the gate fires, and even on the UNFIXED code
    // the ETH-family calls hit the BTC-shaped minter methods (not the ledger) before any ledger work.
    let ckbtc = install_ledger(
        &pic,
        Account { owner: mock, subaccount: None },
        "ckBTC",
        0,
        vec![],
    );
    let cketh = install_ledger(
        &pic,
        Account { owner: mock, subaccount: None },
        "ckETH",
        0,
        vec![],
    );

    pic.install_canister(
        mock,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { amount_ledger: ckbtc, gas_ledger: None }).unwrap(),
        None,
    );

    // Seed a controller at init: `register_minter`/`register_currency_meta` are controller-only.
    let admin = Principal::management_canister();
    let dpay_init = DpayInitArg {
        ledgers: vec![
            LedgerConfig { currency: CKBTC, principal: ckbtc, mintable: false },
            LedgerConfig { currency: CKETH, principal: cketh, mintable: false },
        ],
        per_tx_cap: CAP,
        controller: Some(admin),
    };
    pic.install_canister(dpay, dpay_wasm(), encode_one(&dpay_init).unwrap(), None);

    // Bind the SAME BTC-shaped mock minter to both currencies.
    for cur in [CKBTC, CKETH] {
        let reply = pic
            .update_call(dpay, admin, "register_minter", encode_args((cur, mock)).unwrap())
            .expect("register_minter update_call rejected");
        decode_one::<Result<(), String>>(&reply)
            .unwrap()
            .expect("register_minter should succeed for the controller");
    }

    // CKBTC: cap only, NO family meta → resolves to the legacy `CkBtcUtxo` default (has minter).
    // CKETH: cap + `CkEthErc20` family meta → the gate must reject it.
    register_currency_meta_cap(&pic, dpay, admin, CKBTC, CAP);
    register_currency_meta_family(&pic, dpay, admin, CKETH, MinterFamily::CkEthErc20, CAP);

    (pic, dpay, mock, payer_sk, payer)
}

/// cap-only currency meta (mirrors `deposit.rs::register_currency_meta_cap` — no family registered).
fn register_currency_meta_cap(pic: &PocketIc, dpay: Principal, caller: Principal, currency: Currency, cap: u64) {
    let reply = pic
        .update_call(
            dpay,
            caller,
            "register_currency_meta",
            encode_args((
                currency,
                None::<String>,               // symbol
                None::<u8>,                   // decimals
                None::<MinterFamily>,         // minter_family
                None::<String>,               // wrapper_name
                None::<String>,               // backing_symbol
                None::<String>,               // network
                None::<u8>,                   // display_decimals
                None::<u64>,                  // fee
                Some(cap),                    // cap
                None::<u32>,                  // chain_id
                None::<String>,               // token_contract
                RampCapability::Unavailable,  // onramp
                RampCapability::Unavailable,  // offramp
                None::<Principal>,            // gas_ledger
            ))
            .unwrap(),
        )
        .expect("register_currency_meta update_call rejected");
    decode_one::<Result<(), String>>(&reply)
        .unwrap()
        .expect("register_currency_meta should succeed for the controller");
}

/// PRIMARY GATE TEST — all three deposit proxies MUST reject a CkEthErc20-family currency with a
/// clean typed Err mentioning `CkBtcUtxo` / `onramp` (so the relay maps it to a 503 with a now-clean
/// message, not a minter trap). Against the UNFIXED family-blind code the BTC-shaped mock responds Ok
/// to all three → this test FAILS (RED). After the gate lands each returns Err (GREEN).
#[test]
fn deposit_proxies_reject_cketherc20_family() {
    let (pic, dpay, _mock, _sk, payer) = setup_two_families();

    let info_err = deposit_info(&pic, dpay, CKETH)
        .expect_err("deposit_info MUST be Err for CkEthErc20 family (gate fires on family)");
    assert!(
        info_err.contains("CkBtcUtxo") || info_err.contains("onramp"),
        "deposit_info gate message must name CkBtcUtxo / onramp; got: {info_err}",
    );

    let addr_err = deposit_address(&pic, dpay, payer, CKETH)
        .expect_err("deposit_address MUST be Err for CkEthErc20 family (gate fires on family)");
    assert!(
        addr_err.contains("CkBtcUtxo") || addr_err.contains("onramp"),
        "deposit_address gate message must name CkBtcUtxo / onramp; got: {addr_err}",
    );

    let refresh_err = refresh_deposit(&pic, dpay, payer, CKETH)
        .expect_err("refresh_deposit MUST be Err for CkEthErc20 family (gate fires on family)");
    assert!(
        refresh_err.contains("CkBtcUtxo") || refresh_err.contains("onramp"),
        "refresh_deposit gate message must name CkBtcUtxo / onramp; got: {refresh_err}",
    );
}

/// REGRESSION GUARD — the BTC path (CkBtcUtxo, incl. the legacy "has minter, no family meta"
/// default) MUST still be served Ok by all three proxies after the gate lands. Pins that the gate
/// does not over-reach and break the existing ckBTC deposit flow.
#[test]
fn deposit_proxies_still_serve_ckbtc_legacy_default_family() {
    let (pic, dpay, _mock, _sk, payer) = setup_two_families();

    deposit_address(&pic, dpay, payer, CKBTC)
        .expect("deposit_address MUST stay Ok for CkBtcUtxo (legacy default family)");
    deposit_info(&pic, dpay, CKBTC)
        .expect("deposit_info MUST stay Ok for CkBtcUtxo (legacy default family)");
    refresh_deposit(&pic, dpay, payer, CKBTC)
        .expect("refresh_deposit MUST stay Ok for CkBtcUtxo (legacy default family)");
}
