//! PocketIC proof that the dpay **facade** canister's ckBTC withdrawal proxy burns ckBTC OUT of a
//! user subaccount to a native BTC address on a VERIFIED user signature (offline, deterministic,
//! seconds).
//!
//! Builds three wasms (see `just test-canister`):
//!   DPAY_CANISTER_WASM      = dpay-canister       (the facade: proxies a chain-key minter)
//!   DPAY_MOCK_MINTER_WASM   = dpay-mock-minter    (test-only ckBTC minter; never shipped to mainnet)
//!   DPAY_ICRC_LEDGER_WASM   = ic-icrc1-ledger     (the REAL DFINITY ledger the burn lands on)
//!
//! The facade is the OWNER of the ckBTC held at `Account{owner: facade, subaccount: pubkey}`. On a
//! verified Ed25519 signature over the canonical `WithdrawAuth` bytes, it (1) `icrc2_approve`s the
//! minter to pull `amount`, then (2) calls the minter's `retrieve_btc_with_approval`, which consumes
//! the allowance via `icrc2_transfer_from` and returns the burn block index. The mock mirrors the
//! REAL ckBTC minter's `retrieve_btc_with_approval` candid EXACTLY (verified via `dfx canister
//! metadata mqygn-kiaaa-aaaar-qaadq-cai candid:service --network ic`).
//!
//! Proves: a verified withdrawal debits ckBTC from the subaccount (read DIRECTLY via
//! `icrc1_balance_of`); a replay with the SAME nonce is rejected (no double-burn); a wrong signature
//! is rejected (no funds move); a below-`retrieve_btc_min_amount` withdrawal is rejected. The
//! deposit→withdraw closed loop is also proven: ckBTC minted via the deposit path is immediately
//! withdrawable (the SAME subaccount both paths operate on).

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use dpay_core::{generate_keypair, sign_withdraw, Currency, WithdrawAuth};
use ed25519_dalek::SigningKey;
use icrc_ledger_types::icrc1::account::Account;
use pocket_ic::{PocketIc, Time};
use serde::Deserialize;

const T0_SECS: u64 = 1_800_000_000;
const T0_NANOS: u64 = T0_SECS * 1_000_000_000;
const CAP: u64 = 100_000;

const CKBTC: Currency = 1;

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

/// The facade `withdraw` request: the WithdrawAuth fields + the Ed25519 signature. Mirrors the
/// canister's `WithdrawRequest` candid struct.
#[derive(CandidType, serde::Serialize)]
struct WithdrawRequest {
    from_pubkey: Vec<u8>,
    destination: String,
    amount: u64,
    nonce: Vec<u8>,
    expiry: u64,
    currency: Currency,
    sig: Vec<u8>,
}

#[derive(CandidType, Deserialize, Debug)]
struct WithdrawReceipt {
    from: Vec<u8>,
    destination: String,
    amount: u64,
    nonce: Vec<u8>,
    currency: Currency,
    block_index: u64,
}

#[derive(CandidType, serde::Serialize, Deserialize)]
struct DepositRefresh {
    minted_total: u64,
}

fn nat_to_u64(n: &Nat) -> u64 {
    num_traits::ToPrimitive::to_u64(&n.0).expect("nat fits in u64")
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

fn install_ledger(pic: &PocketIc, minting_account: Account) -> Principal {
    let ledger = pic.create_canister();
    pic.add_cycles(ledger, 10_000_000_000_000);
    // icrc2 MUST be enabled: the withdrawal path uses `icrc2_approve` (facade) + `icrc2_transfer_from`
    // (mock minter consuming the allowance). The real ckBTC ledger has icrc2 on; mirror it.
    let init = LedgerArg::Init(LedgerInitArgs {
        minting_account,
        fee_collector_account: None,
        transfer_fee: Nat::from(0u64),
        decimals: Some(8),
        max_memo_length: None,
        token_symbol: "ckBTC".into(),
        token_name: "Demo ckBTC".into(),
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
            controller_id: minting_account.owner,
            more_controller_ids: None,
        },
        index_principal: None,
    });
    pic.install_canister(ledger, ledger_wasm(), encode_one(&init).unwrap(), None);
    ledger
}

fn ledger_balance(pic: &PocketIc, ledger: Principal, dpay: Principal, pk: [u8; 32]) -> u64 {
    let acct = Account { owner: dpay, subaccount: Some(pk) };
    let reply = pic
        .query_call(
            ledger,
            Principal::anonymous(),
            "icrc1_balance_of",
            encode_one(&acct).unwrap(),
        )
        .expect("icrc1_balance_of query rejected");
    let nat: Nat = decode_one(&reply).unwrap();
    nat_to_u64(&nat)
}

/// Build a signed WithdrawRequest from a signing key + the withdrawal parameters. The signature is
/// over the canonical `WithdrawAuth::signing_bytes()` (single source of truth in dpay-core), so the
/// canister's verify accepts it.
fn withdraw_request(
    sk: &SigningKey,
    from: [u8; 32],
    destination: &str,
    amount: u64,
    nonce: [u8; 16],
    expiry: u64,
    currency: Currency,
) -> WithdrawRequest {
    let auth = WithdrawAuth {
        from_pubkey: from,
        destination: destination.to_string(),
        amount,
        nonce,
        expiry,
        currency,
    };
    let sig = sign_withdraw(sk, &auth).to_bytes();
    WithdrawRequest {
        from_pubkey: from.to_vec(),
        destination: destination.to_string(),
        amount,
        nonce: nonce.to_vec(),
        expiry,
        currency,
        sig: sig.to_vec(),
    }
}

fn withdraw(pic: &PocketIc, dpay: Principal, req: WithdrawRequest) -> Result<WithdrawReceipt, String> {
    let reply = pic
        .update_call(dpay, Principal::anonymous(), "withdraw", encode_one(&req).unwrap())
        .expect("withdraw update_call rejected at IC level");
    decode_one::<Result<WithdrawReceipt, String>>(&reply).unwrap()
}

fn register_deposit(pic: &PocketIc, mock: Principal, facade: Principal, pk: [u8; 32], amount: u64) {
    pic.update_call(
        mock,
        Principal::anonymous(),
        "register_deposit",
        encode_args((facade, pk.to_vec(), amount)).unwrap(),
    )
    .expect("register_deposit update_call rejected");
}

fn refresh_deposit(pic: &PocketIc, dpay: Principal, pk: [u8; 32]) -> Result<DepositRefresh, String> {
    // The facade's refresh_deposit returns a richer record; we only need minted_total here. Decode the
    // full reply into a serde_json::Value-ish candid value and pull `minted_total` out via a minimal
    // mirror that subtype-decodes (extra fields are tolerated).
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "refresh_deposit",
            encode_args((pk.to_vec(), CKBTC)).unwrap(),
        )
        .expect("refresh_deposit update_call rejected");
    decode_one::<Result<DepositRefresh, String>>(&reply).unwrap()
}

/// Install the facade + a ckBTC ledger (minting account owned by the mock) + the mock minter, and
/// register the minter for ckBTC. Returns the handles a withdraw test needs.
fn setup() -> (PocketIc, Principal, Principal, Principal, SigningKey, [u8; 32]) {
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));

    let payer_sk = generate_keypair();
    let payer = payer_sk.verifying_key().to_bytes();

    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);
    let mock = pic.create_canister();
    pic.add_cycles(mock, 2_000_000_000_000);

    let ckbtc = install_ledger(&pic, Account { owner: mock, subaccount: None });

    pic.install_canister(
        mock,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { amount_ledger: ckbtc, gas_ledger: None }).unwrap(),
        None,
    );

    // Seed a controller at init so `register_minter` (controller-only since R1) succeeds.
    let admin = Principal::management_canister();
    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig { currency: CKBTC, principal: ckbtc, mintable: false }],
        per_tx_cap: CAP,
        controller: Some(admin),
    };
    pic.install_canister(dpay, dpay_wasm(), encode_one(&dpay_init).unwrap(), None);

    let reply = pic
        .update_call(dpay, admin, "register_minter", encode_args((CKBTC, mock)).unwrap())
        .expect("register_minter update_call rejected");
    decode_one::<Result<(), String>>(&reply)
        .unwrap()
        .expect("register_minter should succeed for the controller");

    (pic, ckbtc, dpay, mock, payer_sk, payer)
}

/// Pre-fund the user's subaccount with ckBTC via the deposit path (register_deposit → refresh),
/// proving the deposited funds are immediately withdrawable. Returns nothing; asserts the credit.
fn fund_via_deposit(pic: &PocketIc, ckbtc: Principal, dpay: Principal, mock: Principal, pk: [u8; 32], amount: u64) {
    register_deposit(pic, mock, dpay, pk, amount);
    let refresh = refresh_deposit(pic, dpay, pk).expect("refresh mints the deposit");
    assert_eq!(refresh.minted_total, amount, "deposit should mint exactly `amount`");
    assert_eq!(ledger_balance(pic, ckbtc, dpay, pk), amount, "credited at the facade subaccount");
}

#[test]
fn withdraw_debits_ckbtc_from_subaccount() {
    let (pic, ckbtc, dpay, mock, payer_sk, payer) = setup();
    const FUND: u64 = 100_000; // 0.001 BTC
    const WITHDRAW: u64 = 50_000; // exactly the min

    fund_via_deposit(&pic, ckbtc, dpay, mock, payer, FUND);
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), FUND);

    let req = withdraw_request(
        &payer_sk,
        payer,
        "bc1qwithdrawaldestination",
        WITHDRAW,
        [1u8; 16],
        T0_SECS + 120,
        CKBTC,
    );
    let receipt = withdraw(&pic, dpay, req).expect("withdraw should succeed");
    assert_eq!(receipt.amount, WITHDRAW);
    assert_eq!(receipt.destination, "bc1qwithdrawaldestination");
    assert_eq!(receipt.currency, CKBTC);

    // The ckBTC was debited from the user's subaccount (read DIRECTLY off the ledger).
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), FUND - WITHDRAW);
    // The ckBTC was BURNED (retrieved ckBTC is removed from supply — faithful to the real minter, which
    // is the ledger's minting-account owner): total_supply drops by exactly WITHDRAW.
    let total_supply_after = {
        let r = pic.query_call(ckbtc, Principal::anonymous(), "icrc1_total_supply", encode_args(()).unwrap()).unwrap();
        let n: Nat = decode_one(&r).unwrap(); nat_to_u64(&n)
    };
    assert_eq!(
        total_supply_after, FUND - WITHDRAW,
        "the withdrawal must burn ckBTC (reduce total supply by the withdrawn amount)"
    );
    println!("[withdraw] ✓ debited {WITHDRAW} sats + burned (supply {FUND} → {total_supply_after}); block_index = {}", receipt.block_index);
    println!("[withdraw] ✓ debited {WITHDRAW} sats; burn block_index = {}", receipt.block_index);
}

#[test]
fn double_withdraw_same_nonce_rejected() {
    let (pic, ckbtc, dpay, mock, payer_sk, payer) = setup();
    const FUND: u64 = 200_000;
    const WITHDRAW: u64 = 50_000;
    fund_via_deposit(&pic, ckbtc, dpay, mock, payer, FUND);

    // First withdraw with nonce N settles.
    let req = withdraw_request(
        &payer_sk,
        payer,
        "bc1qfirst",
        WITHDRAW,
        [2u8; 16],
        T0_SECS + 120,
        CKBTC,
    );
    let first = withdraw(&pic, dpay, req).expect("first withdraw should succeed");
    assert_eq!(first.amount, WITHDRAW);
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), FUND - WITHDRAW);

    // Replay the SAME signed authorization (same nonce): the facade rejects it — no second burn.
    let req = withdraw_request(
        &payer_sk,
        payer,
        "bc1qfirst",
        WITHDRAW,
        [2u8; 16], // same nonce
        T0_SECS + 120,
        CKBTC,
    );
    let second = withdraw(&pic, dpay, req);
    assert!(second.is_err(), "a replay with the same nonce must be rejected");
    let err = second.unwrap_err();
    assert!(err.contains("nonce"), "replay error must mention the nonce, got: {err}");

    // No double-burn: the balance is unchanged after the rejected replay.
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), FUND - WITHDRAW);
    println!("[withdraw] ✓ same-nonce replay rejected ({err})");
}

#[test]
fn wrong_sig_rejected_no_funds_move() {
    let (pic, ckbtc, dpay, mock, _payer_sk, payer) = setup();
    const FUND: u64 = 100_000;
    fund_via_deposit(&pic, ckbtc, dpay, mock, payer, FUND);

    // Sign the WithdrawAuth with a DIFFERENT key, but present `from_pubkey = payer` — the facade's
    // verify under `payer` fails (the sig is for a different signing input / key). No funds move.
    let other_sk = generate_keypair();
    let auth = WithdrawAuth {
        from_pubkey: payer,
        destination: "bc1qattacker".to_string(),
        amount: 50_000,
        nonce: [3u8; 16],
        expiry: T0_SECS + 120,
        currency: CKBTC,
    };
    let wrong_sig = sign_withdraw(&other_sk, &auth).to_bytes();
    let req = WithdrawRequest {
        from_pubkey: payer.to_vec(),
        destination: "bc1qattacker".to_string(),
        amount: 50_000,
        nonce: vec![3u8; 16],
        expiry: T0_SECS + 120,
        currency: CKBTC,
        sig: wrong_sig.to_vec(),
    };
    let res = withdraw(&pic, dpay, req);
    assert!(res.is_err(), "a wrong-signature withdrawal must be rejected");
    let err = res.unwrap_err();
    assert!(err.contains("signature"), "wrong-sig error must mention signature, got: {err}");

    // Nothing moved.
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), FUND, "no debit on a bad sig");
    println!("[withdraw] ✓ wrong-sig rejected ({err})");
}

#[test]
fn below_min_amount_rejected() {
    let (pic, ckbtc, dpay, mock, payer_sk, payer) = setup();
    const FUND: u64 = 100_000;
    fund_via_deposit(&pic, ckbtc, dpay, mock, payer, FUND);

    // 49_999 < retrieve_btc_min_amount (50_000). The facade rejects locally before any burn.
    let req = withdraw_request(
        &payer_sk,
        payer,
        "bc1qtoosmall",
        49_999,
        [4u8; 16],
        T0_SECS + 120,
        CKBTC,
    );
    let res = withdraw(&pic, dpay, req);
    assert!(res.is_err(), "a below-min withdrawal must be rejected");
    let err = res.unwrap_err();
    assert!(
        err.contains("retrieve_btc_min_amount") || err.contains("below"),
        "below-min error must reference the floor, got: {err}"
    );

    // Nothing moved.
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), FUND, "no debit on a below-min withdraw");
    println!("[withdraw] ✓ below-min rejected ({err})");
}

/// HONESTY GUARD — the mock minter's `retrieve_btc_with_approval` candid surface mirrors the REAL
/// ckBTC minter's. Drives the mock DIRECTLY with the real-minter's single-record argument shape and
/// asserts the error variants match mainnet exactly: a below-min amount returns `AmountTooLow(50000)`
/// and an empty address returns `MalformedAddress`. This is the regression net for the
/// mock-mirrors-real-counterparty lesson (the bug class this test crate exists to catch).
#[derive(CandidType, serde::Serialize)]
struct RetrieveBtcWithApprovalArgs {
    address: String,
    amount: u64,
    from_subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Deserialize, Debug)]
struct RetrieveBtcOkMirror {
    block_index: Nat,
}

#[derive(CandidType, Deserialize, Debug)]
enum RetrieveBtcWithApprovalErrorMirror {
    MalformedAddress(String),
    AlreadyProcessing,
    AmountTooLow(u64),
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    TemporarilyUnavailable(String),
    GenericError { error_message: String, error_code: Nat },
}

#[test]
fn mock_minter_retrieve_btc_with_approval_mirrors_real_minter_contract() {
    let pic = PocketIc::new();
    let mock = pic.create_canister();
    pic.add_cycles(mock, 2_000_000_000_000);
    let ckbtc = install_ledger(&pic, Account { owner: mock, subaccount: None });
    pic.install_canister(
        mock,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { amount_ledger: ckbtc, gas_ledger: None }).unwrap(),
        None,
    );

    let facade = Principal::anonymous();
    let sub = vec![5u8; 32];

    // Below-min: the mock enforces retrieve_btc_min_amount (50_000) like the real minter, returning
    // the real-minter-shaped AmountTooLow(50000) variant.
    let reply = pic
        .update_call(
            mock,
            facade,
            "retrieve_btc_with_approval",
            encode_one(&RetrieveBtcWithApprovalArgs {
                address: "bc1qanything".to_string(),
                amount: 49_999,
                from_subaccount: Some(sub.clone()),
            })
            .unwrap(),
        )
        .expect("retrieve_btc_with_approval (below-min) update_call rejected");
    let decoded: Result<RetrieveBtcOkMirror, RetrieveBtcWithApprovalErrorMirror> =
        decode_one(&reply).unwrap();
    assert!(
        matches!(decoded, Err(RetrieveBtcWithApprovalErrorMirror::AmountTooLow(50_000))),
        "below-min must return AmountTooLow(50000) mirroring the real minter, got: {:?}",
        decoded
    );

    // Empty address → MalformedAddress (the real minter's variant name + shape).
    let reply = pic
        .update_call(
            mock,
            facade,
            "retrieve_btc_with_approval",
            encode_one(&RetrieveBtcWithApprovalArgs {
                address: "  ".to_string(),
                amount: 50_000,
                from_subaccount: Some(sub.clone()),
            })
            .unwrap(),
        )
        .expect("retrieve_btc_with_approval (empty addr) update_call rejected");
    let decoded: Result<RetrieveBtcOkMirror, RetrieveBtcWithApprovalErrorMirror> =
        decode_one(&reply).unwrap();
    assert!(
        matches!(decoded, Err(RetrieveBtcWithApprovalErrorMirror::MalformedAddress(_))),
        "empty address must return MalformedAddress mirroring the real minter, got: {:?}",
        decoded
    );

    println!("[withdraw] ✓ mock minter's retrieve_btc_with_approval mirrors the real minter's error variants");
}
