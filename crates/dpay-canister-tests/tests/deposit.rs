//! PocketIC proof that the dpay **facade** canister's ckBTC-style deposit proxy mints onto a REAL
//! external ICRC ledger (offline, deterministic, seconds).
//!
//! Builds three wasms (see `just test-canister`):
//!   DPAY_CANISTER_WASM      = dpay-canister       (the facade: proxies a chain-key minter)
//!   DPAY_MOCK_MINTER_WASM   = dpay-mock-minter    (test-only ckBTC minter; never shipped to mainnet)
//!   DPAY_ICRC_LEDGER_WASM   = ic-icrc1-ledger     (the REAL DFINITY ledger the mint lands on)
//!
//! The mock minter OWNS the ckBTC ledger's minting account (the test installs the ledger with
//! `minting_account.owner = mock`), so its `update_balance` mints by calling `icrc1_transfer` from
//! the minting account's default subaccount to `Account{owner, subaccount}`. The facade always calls
//! the minter with `owner = Some(canister_self())` and `subaccount = Some(pubkey)`, so the mint lands
//! at `Account{owner: facade, subaccount: pubkey}` — the SAME account `pay`/`icrc1_balance_of` already
//! operate on. This is the load-bearing property: once a deposit confirms, the existing
//! balance/payment paths reflect it with ZERO facade change.
//!
//! Proves: `deposit_address`/`deposit_info`/`refresh_deposit` proxy the minter correctly; a seeded
//! pending deposit mints exactly `amount` onto the ckBTC ledger at the facade's subaccount (read
//! DIRECTLY via `icrc1_balance_of`); a second refresh is a no-op (no double mint); and the minted
//! ckBTC is immediately spendable through the UNCHANGED `pay` path (deposit -> spend closed loop).

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use dpay_core::{generate_keypair, Authorization, Currency, SignedAuthorization, MEMO_LEN, NAME_LEN};
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

/// The single record argument the REAL ckBTC minter takes for `get_btc_address` / `update_balance` —
/// `(record { owner: opt principal; subaccount: opt blob })`. Used by the honesty-guard test below to
/// drive the mock minter directly with the real-minter's argument shape.
#[derive(CandidType, serde::Serialize)]
struct MinterAccountArg {
    owner: Option<Principal>,
    subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Deserialize, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
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

/// Local mirror of the canister's `RampCapability` (candid wire type) — needed to encode
/// `register_currency_meta` calls from this test.
#[allow(dead_code)] // mirror type; only some variants are constructed in this file
#[derive(CandidType, serde::Serialize)]
enum RampCapability {
    Direct,
    Partner,
    Unavailable,
}

/// Local mirror of the canister's `MinterFamily` (candid wire type) — the `None` variant is all the
/// cap-only registration needs.
#[allow(dead_code)] // mirror type; only some variants are constructed in this file
#[derive(CandidType, serde::Serialize)]
enum MinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
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

fn signed(
    sk: &SigningKey,
    from: [u8; 32],
    to: [u8; 32],
    amount: u64,
    nonce: [u8; 16],
    expiry: u64,
    currency: Currency,
) -> Vec<u8> {
    let auth = Authorization {
        from,
        to,
        amount,
        nonce,
        expiry,
        currency,
        from_name: [0u8; NAME_LEN],
        to_name: [0u8; NAME_LEN],
        memo: [0u8; MEMO_LEN],
    };
    SignedAuthorization::new(sk, auth).to_wire().to_vec()
}

fn pay(pic: &PocketIc, dpay: Principal, wire: Vec<u8>) -> Result<PayReceipt, String> {
    let reply = pic
        .update_call(dpay, Principal::anonymous(), "pay", encode_one(&wire).unwrap())
        .expect("pay update_call rejected at IC level");
    decode_one::<Result<PayReceipt, String>>(&reply).unwrap()
}

fn deposit_address(pic: &PocketIc, dpay: Principal, pk: [u8; 32]) -> Result<String, String> {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "deposit_address",
            encode_args((pk.to_vec(), CKBTC)).unwrap(),
        )
        .expect("deposit_address update_call rejected");
    decode_one::<Result<String, String>>(&reply).unwrap()
}

fn deposit_info(pic: &PocketIc, dpay: Principal) -> Result<DepositInfo, String> {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "deposit_info",
            encode_args((CKBTC,)).unwrap(),
        )
        .expect("deposit_info update_call rejected");
    decode_one::<Result<DepositInfo, String>>(&reply).unwrap()
}

fn refresh_deposit(pic: &PocketIc, dpay: Principal, pk: [u8; 32]) -> Result<DepositRefresh, String> {
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

fn register_deposit(pic: &PocketIc, mock: Principal, facade: Principal, pk: [u8; 32], amount: u64) {
    pic.update_call(
        mock,
        Principal::anonymous(),
        "register_deposit",
        encode_args((facade, pk.to_vec(), amount)).unwrap(),
    )
    .expect("register_deposit update_call rejected");
}

/// Register currency metadata with ONLY a per-tx `cap` (MC2 U1). `pay` is fail-closed on a cap-less
/// currency, so the deposit→pay closed-loop test needs a registered cap on CKBTC to settle. Called
/// as the seeded controller (the management-canister principal); `register_currency_meta` replaces
/// the record in place.
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

fn setup_deposit() -> (PocketIc, Principal, Principal, Principal, SigningKey, [u8; 32]) {
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));

    let payer_sk = generate_keypair();
    let payer = payer_sk.verifying_key().to_bytes();

    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);
    let mock = pic.create_canister();
    pic.add_cycles(mock, 2_000_000_000_000);

    let ckbtc = install_ledger(
        &pic,
        Account { owner: mock, subaccount: None },
        "ckBTC",
        0,
        vec![],
    );

    pic.install_canister(
        mock,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { amount_ledger: ckbtc, gas_ledger: None }).unwrap(),
        None,
    );

    // Seed a controller at init: `register_minter` is a privileged admin op (controller-only since
    // R1), so the facade must be locked with a controller for the test to register the mock minter.
    // The stable management-canister principal stands in for the governed operator.
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

    // MC2 U1: `pay` reads the per-currency cap (fail-closed). Register a cap for CKBTC so the
    // deposit→pay closed-loop test (deposited_funds_are_spendable_via_pay) can settle.
    register_currency_meta_cap(&pic, dpay, admin, CKBTC, CAP);

    (pic, ckbtc, dpay, mock, payer_sk, payer)
}

#[test]
fn deposit_flow_mints_to_facade_subaccount() {
    let (pic, ckbtc, dpay, mock, _sk, payer) = setup_deposit();
    const DEPOSIT_AMOUNT: u64 = 50_000;

    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), 0);

    let addr = deposit_address(&pic, dpay, payer).expect("deposit_address ok");
    assert!(
        addr.starts_with("bc1qmock"),
        "deposit address must be the mock's bc1qmock form: {addr}",
    );

    let info = deposit_info(&pic, dpay).expect("deposit_info ok");
    assert_eq!(info.min_confirmations, 1);
    assert_eq!(info.deposit_fee, 0);
    assert_eq!(info.deposit_min_amount, Some(0));

    let pre = refresh_deposit(&pic, dpay, payer).expect("refresh before deposit ok");
    assert_eq!(pre.minted_total, 0);
    assert!(pre.minted.is_empty());
    assert!(pre.pending.is_empty());

    register_deposit(&pic, mock, dpay, payer, DEPOSIT_AMOUNT);

    let post = refresh_deposit(&pic, dpay, payer).expect("refresh after deposit ok");
    assert_eq!(post.minted_total, DEPOSIT_AMOUNT);
    assert_eq!(post.minted.len(), 1);
    assert_eq!(post.minted[0].amount, DEPOSIT_AMOUNT);
    assert_eq!(post.required_confirmations, 0);
    assert!(post.pending.is_empty());

    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), DEPOSIT_AMOUNT);
    // Facade cache (the display path the app/relay read) MUST reflect the mint too — not only the
    // authoritative ledger balance. Pins the `Ok(statuses)` mint-branch cache refresh.
    assert_eq!(dpay_balance(&pic, dpay, payer, CKBTC), DEPOSIT_AMOUNT);

    let second = refresh_deposit(&pic, dpay, payer).expect("second refresh ok");
    assert_eq!(second.minted_total, 0);
    assert!(second.minted.is_empty());
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), DEPOSIT_AMOUNT);
    assert_eq!(dpay_balance(&pic, dpay, payer, CKBTC), DEPOSIT_AMOUNT);
}

/// Pins the `NoNewUtxos` branch's inline cache refresh in `refresh_deposit` (lib.rs ~2530). The plain
/// happy-path test above cannot catch a regression that deletes ONLY the NoNewUtxos cache refresh:
/// the preceding mint branch already wrote `DEPOSIT_AMOUNT` into the cache, so the subsequent
/// NoNewUtxos refresh could be a no-op and `dpay_balance` would still read correctly.
///
/// This test isolates the NoNewUtxos branch: it credits the payer's facade subaccount with a DIRECT
/// ICRC transfer (bypassing the facade entirely, so `BAL_CACHE` stays stale at 0), then calls
/// `refresh_deposit`. With no UTXO registered the mock minter returns `NoNewUtxos` (no mint), so the
/// ONLY thing that can surface the credit via `balance_of` is the NoNewUtxos branch's cache re-read.
/// If that branch is deleted, `dpay_balance` stays 0 and this test fails.
#[test]
fn refresh_deposit_nonewutxos_branch_refreshes_cache_after_direct_credit() {
    let (pic, ckbtc, dpay, mock, _sk, payer) = setup_deposit();
    const CREDIT: u64 = 25_000;

    // External credit that bypasses the facade (direct ICRC mint to the payer's subaccount). The
    // facade is NEVER invoked, so BAL_CACHE has no entry for `payer` → `balance_of` returns 0.
    direct_credit(&pic, ckbtc, mock, dpay, payer, CREDIT);

    // Sanity: the credit landed on the authoritative ledger, but the facade cache is stale (0).
    // This double-check proves the credit bypassed the facade (so only a NoNewUtxos refresh can
    // surface it — the mint branch never ran).
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), CREDIT);
    assert_eq!(
        dpay_balance(&pic, dpay, payer, CKBTC),
        0,
        "cache must be stale (direct credit bypassed the facade) before refresh_deposit",
    );

    // No UTXO registered → the mock minter returns NoNewUtxos (minted_total 0, no mint). The cache
    // refresh in THIS branch is the only thing that can update the facade cache.
    let res = refresh_deposit(&pic, dpay, payer).expect("NoNewUtxos refresh ok");
    assert_eq!(res.minted_total, 0, "no UTXO registered → NoNewUtxos, nothing minted");
    assert!(res.minted.is_empty());

    // THE regression assertion: the NoNewUtxos branch re-read the ledger and refreshed the cache, so
    // the direct credit is now visible via the facade display path. FAILS if the NoNewUtxos cache
    // refresh (lib.rs `if let Ok(bal) ... write_cache`) is deleted.
    assert_eq!(
        dpay_balance(&pic, dpay, payer, CKBTC),
        CREDIT,
        "NoNewUtxos branch must refresh the facade cache so a bypassing credit is visible",
    );
}

#[test]
fn deposited_funds_are_spendable_via_pay() {
    let (pic, ckbtc, dpay, mock, payer_sk, payer) = setup_deposit();
    let merch_sk = generate_keypair();
    let merch = merch_sk.verifying_key().to_bytes();
    const DEPOSIT_AMOUNT: u64 = 30_000;
    const PAY_AMOUNT: u64 = 12_000;

    register_deposit(&pic, mock, dpay, payer, DEPOSIT_AMOUNT);
    let refreshed = refresh_deposit(&pic, dpay, payer).expect("refresh mints the deposit");
    assert_eq!(refreshed.minted_total, DEPOSIT_AMOUNT);

    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), DEPOSIT_AMOUNT);

    let wire = signed(&payer_sk, payer, merch, PAY_AMOUNT, [1u8; 16], T0_SECS + 120, CKBTC);
    let receipt = pay(&pic, dpay, wire).expect("pay should settle");
    assert_eq!(receipt.amount, PAY_AMOUNT);

    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), DEPOSIT_AMOUNT - PAY_AMOUNT);
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, merch), PAY_AMOUNT);
}

/// HONESTY GUARD — pins the mock minter's candid surface to the REAL ckBTC minter's contract.
///
/// The live bug this guards against: the facade once encoded the minter call as a candid 2-tuple
/// `(opt principal, opt blob)` = TWO positional args, while the real ckBTC minter
/// (`mqygn-kiaaa-aaaar-qaadq-cai`, verified via `dfx canister metadata … candid:service --network ic`)
/// takes exactly ONE record argument `(record { owner: opt principal; subaccount: opt blob })`. The
/// real minter (and now this mock) reject the two-positional-arg shape with
/// `IC0503 ... Fail to decode argument 0 ... Subtyping error: Type mismatch`. That shipped green
/// only because the OLD mock agreed with the broken facade on the wrong contract.
///
/// This test drives the mock DIRECTLY with both shapes: the single-record shape (the real minter's)
/// succeeds, and the two-positional-arg shape (the divergent one) is rejected. Combined with
/// `deposit_flow_mints_to_facade_subaccount` (which drives the facade THROUGH this mock), this is the
/// regression net: if the facade OR the mock ever revert to the 2-tuple encoding, one of these two
/// tests fails — exactly mirroring the live trap.
#[test]
fn mock_minter_enforces_real_minter_single_record_arg_contract() {
    let pic = PocketIc::new();
    let mock = pic.create_canister();
    pic.add_cycles(mock, 2_000_000_000_000);
    let ledger = install_ledger(
        &pic,
        Account { owner: mock, subaccount: None },
        "ckBTC",
        0,
        vec![],
    );
    pic.install_canister(
        mock,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { amount_ledger: ledger, gas_ledger: None }).unwrap(),
        None,
    );

    let sub = vec![1u8; 32];

    // (1) ONE record argument — the REAL minter shape — succeeds and returns the mock address.
    let reply = pic
        .update_call(
            mock,
            Principal::anonymous(),
            "get_btc_address",
            encode_args((MinterAccountArg { owner: None, subaccount: Some(sub.clone()) },)).unwrap(),
        )
        .expect("single-record-arg get_btc_address should succeed against the honest mock");
    let addr: String = decode_one(&reply).unwrap();
    assert!(
        addr.starts_with("bc1qmock"),
        "single-record-arg call must return the mock's bc1qmock address: {addr}",
    );

    // (2) TWO positional args — the DIVERGENT shape that shipped the live IC0503 trap — is rejected.
    //     The mock tries to decode arg0 (an opt principal) as the whole record {owner, subaccount}
    //     and traps.
    let divergent = pic.update_call(
        mock,
        Principal::anonymous(),
        "get_btc_address",
        encode_args((Some(Principal::anonymous()), Some(sub))).unwrap(),
    );
    assert!(
        divergent.is_err(),
        "a two-positional-arg call must be REJECTED by the honest mock (mirror of the live trap)",
    );
    let err = divergent.unwrap_err().to_string();
    assert!(
        err.contains("decode argument 0")
            || err.contains("Type mismatch")
            || err.contains("Subtyping"),
        "expected the real-minter decode trap, got: {err}",
    );
}

// --- MC3 U1: authoritative refresh_balances + refresh_deposit cache refresh -------------------
//
// The reported bug: `refresh_deposit` mints ckBTC onto the ledger (the authoritative read passes)
// but never refreshes `BAL_CACHE`, so the facade's `balance_of` query — the display path the app +
// relay read — returns a stale 0 after a deposit. External credits (direct ICRC transfers, async
// ckERC20 heartbeat mints) bypass the facade entirely, so the cache can stay stale indefinitely
// even though the funds are spendable. U1 closes this with (a) an authoritative on-demand
// `refresh_balances` (single + batch via the same call) and (b) an inline cache refresh inside
// `refresh_deposit`.

/// The facade's cached balance via its `balance_of` QUERY (display-only). Mirrors the helper in
/// `icrc_settle.rs` — this is the path the app/relay actually read, so the tests MUST assert it,
/// not only the direct ledger balance.
fn dpay_balance(pic: &PocketIc, dpay: Principal, pk: [u8; 32], currency: Currency) -> u64 {
    let reply = pic
        .query_call(
            dpay,
            Principal::anonymous(),
            "balance_of",
            encode_args((pk.to_vec(), currency)).unwrap(),
        )
        .expect("balance_of query rejected");
    decode_one::<u64>(&reply).unwrap()
}

/// Mirror of the canister's `BalanceEntry` (one entry of the `refresh_balances` result).
#[derive(CandidType, Deserialize, Debug, PartialEq, Eq)]
struct BalanceEntry {
    currency: Currency,
    amount: u64,
}

/// The unified authoritative `refresh_balances` facade method (MC3 U1): pass `[currency]` for one,
/// every registered id for all. Re-reads the ledger for each REQUESTED currency and refreshes
/// `BAL_CACHE`. Returns the list of `BalanceEntry { currency, amount }` (only for the currencies
/// that resolved to a live ledger).
fn refresh_balances(
    pic: &PocketIc,
    dpay: Principal,
    pk: [u8; 32],
    currencies: &[Currency],
) -> Result<Vec<BalanceEntry>, String> {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "refresh_balances",
            encode_args((pk.to_vec(), currencies.to_vec())).unwrap(),
        )
        .expect("refresh_balances update_call rejected");
    decode_one::<Result<Vec<BalanceEntry>, String>>(&reply).unwrap()
}

/// A minimal `icrc1_transfer` argument shape. `fee`/`memo` are only ever `None` here, so the exact
/// wrapper types (Subaccount / Memo records) do not matter — `None` serializes as `null`, which is
/// candid-compatible with any `opt T`. Fields match the ICRC-1 TransferArg record names exactly.
#[derive(CandidType, serde::Serialize)]
struct DirectTransferArg {
    from_subaccount: Option<Vec<u8>>,
    to: Account,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<Vec<u8>>,
    created_at_time: Option<u64>,
}

/// Simulate an EXTERNAL credit that BYPASSES the facade — a direct `icrc1_transfer` on the ledger
/// from the minting account (owned by the `mock` canister per `setup_deposit`) to
/// `Account{owner: facade, subaccount: payer}`. This is the exact shape of a direct ICRC transfer
/// or an asynchronous ckERC20 heartbeat mint: funds land on the ledger at the user's facade
/// subaccount with the facade NEVER invoked, so `BAL_CACHE` stays stale (the bug being fixed).
/// PocketIC lets the caller principal be spoofed, so we call AS the mock (the minting-account
/// owner) — `from_subaccount: None` debits the minting account, which ICRC treats as a MINT.
fn direct_credit(
    pic: &PocketIc,
    ledger: Principal,
    mock: Principal,
    facade: Principal,
    pk: [u8; 32],
    amount: u64,
) {
    let arg = DirectTransferArg {
        from_subaccount: None, // minting account's default subaccount
        to: Account { owner: facade, subaccount: Some(pk) },
        amount: Nat::from(amount),
        fee: None, // mints carry no fee (the ledger's transfer_fee is 0 here anyway)
        memo: None,
        created_at_time: Some(T0_NANOS),
    };
    let reply = pic
        .update_call(ledger, mock, "icrc1_transfer", encode_one(&arg).unwrap())
        .expect("direct icrc1_transfer update_call rejected");
    decode_one::<Result<Nat, candid::Reserved>>(&reply)
        .expect("direct icrc1_transfer reply decode")
        .expect("direct credit transfer should succeed (minting account debited)");
}

/// PRIMARY REPORTED BUG — `refresh_deposit` mints onto the ledger but the facade CACHE query
/// (`balance_of`, the display path the app/relay read) returns 0. MC3 verbatim requirement: "Tests
/// must assert facade/relay balance, not only direct ledger balance." RED today (cache not
/// refreshed after mint); GREEN after the inline cache refresh lands inside `refresh_deposit`.
#[test]
fn refresh_deposit_makes_minted_balance_visible_via_balance_of() {
    let (pic, ckbtc, dpay, mock, _sk, payer) = setup_deposit();
    const DEPOSIT_AMOUNT: u64 = 30_000;

    // Seed a confirmed deposit, then refresh → the mock minter mints onto the ckBTC ledger.
    register_deposit(&pic, mock, dpay, payer, DEPOSIT_AMOUNT);
    let post = refresh_deposit(&pic, dpay, payer).expect("refresh mints the deposit");
    assert_eq!(post.minted_total, DEPOSIT_AMOUNT);

    // AUTHORITATIVE ledger balance grew (this already passes today — the mint lands correctly).
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), DEPOSIT_AMOUNT);

    // The facade CACHE query MUST also reflect the minted amount so the wallet shows the
    // freshly-deposited funds WITHOUT an extra refresh call. FAILS today (returns 0); the fix is
    // the inline cache refresh inside `refresh_deposit`.
    assert_eq!(
        dpay_balance(&pic, dpay, payer, CKBTC),
        DEPOSIT_AMOUNT,
        "balance_of (facade cache) must reflect the minted deposit after refresh_deposit",
    );
}

/// Covers the unified authoritative `refresh_balances` (single-currency call) against a credit
/// that bypassed the facade (direct ICRC transfer / async ckERC20 heartbeat mint). Before the fix
/// the cache is stale (`balance_of` returns 0) and there is no way to refresh it short of a
/// pay/faucet/mint; `refresh_balances(&[currency])` re-reads the ledger and refreshes the cache.
#[test]
fn refresh_balances_reflects_a_cache_bypassing_credit() {
    let (pic, ckbtc, dpay, mock, _sk, payer) = setup_deposit();
    const CREDIT: u64 = 25_000;

    // External credit that bypasses the facade (direct ICRC mint to the payer's subaccount).
    direct_credit(&pic, ckbtc, mock, dpay, payer, CREDIT);

    // AUTHORITATIVE ledger balance grew (the funds really live on the ledger).
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), CREDIT);

    // The facade cache is STALE — `balance_of` returns 0 because the facade was never invoked.
    assert_eq!(
        dpay_balance(&pic, dpay, payer, CKBTC),
        0,
        "cache must be stale before refresh_balances (the bypass-credit bug)",
    );

    // Call the unified refresh with a SINGLE currency → it re-reads the ledger and refreshes the
    // cache. The returned entry for CKBTC must carry the authoritative ledger amount.
    let entries = refresh_balances(&pic, dpay, payer, &[CKBTC]).expect("refresh_balances ok");
    let ckbtc_entry = entries
        .iter()
        .find(|e| e.currency == CKBTC)
        .expect("refresh_balances result must include the requested CKBTC currency");
    assert_eq!(
        ckbtc_entry.amount, CREDIT,
        "refresh_balances entry for CKBTC must carry the authoritative ledger amount",
    );

    // A subsequent `balance_of` now reflects the credit (the cache was refreshed).
    assert_eq!(
        dpay_balance(&pic, dpay, payer, CKBTC),
        CREDIT,
        "balance_of (facade cache) must reflect the credit after refresh_balances",
    );
}

// --- refresh_balances: ONE update call refreshes the REQUESTED currencies --------------------
//
// The unified method collapses the relay's N per-currency update calls (each its own 2-5s consensus
// round) into ONE. Pass `[currency]` for one, every registered id for all. It must: (a) return an
// entry per REQUESTED currency that resolved to a live ledger, with the authoritative balance,
// (b) write each to BAL_CACHE so `balance_of` reflects it, and (c) surface a facade-bypassing
// credit (direct ICRC transfer) the same way for one or many currencies.

/// Minimal candid mirror to read just the `currency` id out of a `currencies()` reply (candid
/// ignores the other record fields on decode). Returns every registered currency id ascending —
/// the list a caller passes to `refresh_balances` to refresh ALL currencies.
fn all_currency_ids(pic: &PocketIc, dpay: Principal) -> Vec<Currency> {
    #[derive(CandidType, Deserialize)]
    struct CurrencyIdOnly {
        currency: Currency,
    }
    let reply = pic
        .query_call(dpay, Principal::anonymous(), "currencies", encode_args(()).unwrap())
        .expect("currencies query rejected");
    let mut ids: Vec<Currency> = decode_one::<Vec<CurrencyIdOnly>>(&reply)
        .expect("decode currencies")
        .into_iter()
        .map(|d| d.currency)
        .collect();
    ids.sort();
    ids
}

/// When passed EVERY registered currency id, the unified refresh returns an entry for each and
/// writes each to `BAL_CACHE`, so a facade-bypassing credit (direct ICRC transfer) is surfaced for
/// ALL currencies in ONE call.
#[test]
fn refresh_balances_refreshes_every_currency_when_passed_all() {
    let (pic, ckbtc, dpay, mock, _sk, payer) = setup_deposit();
    const CREDIT: u64 = 42_000;

    // External credit that bypasses the facade (direct ICRC mint to the payer's subaccount).
    direct_credit(&pic, ckbtc, mock, dpay, payer, CREDIT);

    // AUTHORITATIVE ledger balance grew.
    assert_eq!(ledger_balance(&pic, ckbtc, dpay, payer), CREDIT);

    // The facade cache is STALE before the refresh.
    assert_eq!(dpay_balance(&pic, dpay, payer, CKBTC), 0, "cache must be stale before the refresh");

    // ONE unified refresh call with EVERY registered id → returns an entry for each.
    let all_ids = all_currency_ids(&pic, dpay);
    assert!(all_ids.contains(&CKBTC), "currencies() must list the registered CKBTC id");
    let entries = refresh_balances(&pic, dpay, payer, &all_ids).expect("refresh_balances ok");
    assert!(
        !entries.is_empty(),
        "refresh_balances must return at least one entry (the registered currency)",
    );
    // The registered currency (CKBTC) must be present with the authoritative credited amount.
    let ckbtc_entry = entries
        .iter()
        .find(|e| e.currency == CKBTC)
        .expect("refresh_balances result must include the registered CKBTC currency");
    assert_eq!(
        ckbtc_entry.amount, CREDIT,
        "refresh_balances entry for CKBTC must carry the authoritative credited amount",
    );

    // The cache was written by the refresh, so the fast `balance_of` query now reflects the credit.
    assert_eq!(
        dpay_balance(&pic, dpay, payer, CKBTC),
        CREDIT,
        "balance_of (facade cache) must reflect the credit after refresh_balances",
    );
}

/// `refresh_balances` is idempotent + re-readable: a second call returns the same authoritative
/// balances without side effects (the canister-level read is a pure ledger query + cache write).
#[test]
fn refresh_balances_is_idempotent() {
    let (pic, _ckbtc, dpay, _mock, _sk, payer) = setup_deposit();

    let first = refresh_balances(&pic, dpay, payer, &[CKBTC]).expect("first refresh_balances ok");
    let second = refresh_balances(&pic, dpay, payer, &[CKBTC]).expect("second refresh_balances ok");

    // Same currencies, same amounts — the refresh is a pure read + cache write.
    assert_eq!(
        first, second,
        "refresh_balances must be idempotent (same authoritative balances on re-read)",
    );
}
