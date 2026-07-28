//! PocketIC proof of the dpay <-> ICRC-ledger integration (offline, deterministic, seconds).
//!
//! Builds one wasm (see `just icrc-demo`):
//!   DPAY_CANISTER_ICRC_WASM = dpay-canister-icrc   (verifies the offline sig, settles on the ledger)
//!
//! The ledger is the REAL DFINITY `ic-icrc1-ledger` (built from dfinity/ic source, cached in
//! `third_party/ic-icrc1-ledger/`). dpay holds NO balances: every `pay()` does a cross-canister
//! `icrc1_transfer` on the real ICRC-1/3 ledger named by the payment's currency.
//!
//! TWO ledgers are installed, proving the multi-currency design:
//!   - DUSD (currency 0, `mintable`): minting account owned by the dpay canister — dpay mints/burns.
//!   - CKX  (currency 1, NOT mintable): a stand-in for a real ckBTC/ckETH ledger. The payer is
//!     pre-funded via the ledger's `initial_balances` (simulating an external deposit); dpay can
//!     move those funds but cannot mint them.
//!
//! Proves: offline-sign settles on the right ledger; replay/expiry/over-cap/insufficient rejected;
//! currencies cannot cross (a DUSD balance cannot settle a CKX payment); demo currency mints/burns;
//! non-mintable currency cannot be minted.

use candid::{decode_one, encode_args, encode_one, Nat, Principal};
use dpay_core::{generate_keypair, Authorization, Currency, SignedAuthorization, DEMO_USD};
use ed25519_dalek::SigningKey;
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc3::blocks::{GetBlocksRequest, GetBlocksResult};
use pocket_ic::{PocketIc, Time};
use serde::Deserialize;
use std::time::Duration;

const T0_SECS: u64 = 1_800_000_000;
const T0_NANOS: u64 = T0_SECS * 1_000_000_000;
const CAP: u64 = 100_000; // per-tx cap: $1,000.00
const INIT_A: u64 = 10_000; // payer opens with $100.00

/// A second currency standing in for a real ck token (ckBTC/ckETH/ckUSDT). Registered with the dpay
/// canister as NOT mintable, and pre-funded via the ledger's own `initial_balances`.
const CKX: Currency = 1;

// --- real ic-icrc1-ledger init payload (mirrors third_party/ic-icrc1-ledger/ledger.did) --------
// Field types must match the ledger's InitArgs exactly so the ledger's `candid::decode` accepts
// the init bytes (candid checks structural subtyping against the canister's own types).

#[allow(dead_code)] // arms exist only so the candid variant type matches the ledger's MetadataValue
#[derive(candid::CandidType, serde::Serialize)]
enum MetadataValue {
    Nat(Nat),
    Int(candid::Int),
    Text(String),
    Blob(Vec<u8>),
}

#[derive(candid::CandidType, serde::Serialize)]
struct FeatureFlags {
    icrc2: bool,
    icrc152: bool,
}

#[derive(candid::CandidType, serde::Serialize)]
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

#[derive(candid::CandidType, serde::Serialize)]
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

// Single-arm variant: `variant { Init: LedgerInitArgs }` is a valid candid subtype of the ledger's
// `variant { Init: InitArgs; Upgrade: opt UpgradeArgs }` (a source variant is a subtype when every
// one of its arms exists in the target), so the ledger decodes the Init payload correctly.
#[derive(candid::CandidType, serde::Serialize)]
enum LedgerArg {
    Init(LedgerInitArgs),
}

#[derive(candid::CandidType, serde::Serialize)]
struct LedgerConfig {
    currency: Currency,
    principal: Principal,
    mintable: bool,
}

#[derive(candid::CandidType, serde::Serialize)]
struct DpayInitArg {
    ledgers: Vec<LedgerConfig>,
    per_tx_cap: u64,
    controller: Option<Principal>,
}

#[derive(candid::CandidType, Deserialize, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
}

#[derive(candid::CandidType, Deserialize, Debug, PartialEq)]
struct TxnView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    timestamp: u64,
}

fn nat_to_u64(n: &Nat) -> u64 {
    num_traits::ToPrimitive::to_u64(&n.0).expect("nat fits in u64")
}

fn workspace_root() -> std::path::PathBuf {
    // crates/dpay-icrc-tests -> workspace root
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The REAL DFINITY ic-icrc1-ledger wasm, cached offline in third_party/ (built once from
/// dfinity/ic source; see ICRC3_INTEGRATION.md). Override via DPAY_ICRC_LEDGER_WASM.
fn ledger_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_ICRC_LEDGER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm")
        });
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read ledger wasm at {}: {e}", path.display()))
}

fn dpay_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_CANISTER_ICRC_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("target/wasm32-unknown-unknown/release/dpay_canister_icrc.wasm")
        });
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read dpay-icrc wasm at {}: {e}", path.display()))
}

/// Install one real ICRC ledger with the given minting account, symbol, transfer fee, and
/// (optional) pre-funded balances. Returns the new ledger principal.
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
            trigger_threshold: 20_000,
            max_message_size_bytes: None,
            cycles_for_archive_creation: None,
            node_max_memory_size_bytes: None,
            // The archive controller is the dpay canister in this demo; production would be a
            // governed archive canister. controller_id is required by the ledger init.
            controller_id: minting_account.owner,
            more_controller_ids: None,
        },
        index_principal: None,
    });
    pic.install_canister(ledger, ledger_wasm(), encode_one(&init).unwrap(), None);
    ledger
}

/// Two real ledgers + a dpay canister wired to both:
///   - ledger_dusd (currency 0, mintable): minting account owned by dpay.
///   - ledger_ckx  (currency 1, NOT mintable): minting account owned by a separate reserved
///     principal (the "ckX minter"); the payer is pre-funded via initial_balances to simulate an
///     external deposit (dpay cannot mint ckX).
/// The payer key is generated here (offline); its pubkey becomes the ICRC `subaccount` the dpay
/// canister controls on each ledger.
fn setup_with(
    controller: Option<Principal>,
) -> (PocketIc, Principal, Principal, Principal, SigningKey, [u8; 32], [u8; 32]) {
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));

    let payer_sk = generate_keypair();
    let payer_pk = payer_sk.verifying_key().to_bytes();
    let merch_pk = generate_keypair().verifying_key().to_bytes();

    // 1. Reserve the dpay canister id first — ledgers need it as the minting account owner and as
    //    the owner of pre-funded subaccounts.
    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);

    // 2. DUSD ledger: minting account owned by dpay (so dpay can mint/burn). No pre-fund.
    let ledger_dusd = install_ledger(
        &pic,
        Account { owner: dpay, subaccount: None },
        "DUSD",
        0,
        vec![],
    );

    // 3. CKX ledger: minting account owned by a SEPARATE reserved principal (the "ckX minter"), and
    //    the payer pre-funded via initial_balances — i.e. ckX arrived externally, dpay did not mint
    //    it. dpay can still MOVE it (it owns the subaccount), just not create it.
    let ckx_minter = pic.create_canister(); // reserved, never installed
    let payer_ckx_acct = Account { owner: dpay, subaccount: Some(payer_pk) };
    let ledger_ckx = install_ledger(
        &pic,
        Account { owner: ckx_minter, subaccount: None },
        "CKX",
        0,
        vec![(payer_ckx_acct, Nat::from(INIT_A))],
    );

    // 4. Install dpay wired to both ledgers: DUSD mintable, CKX not.
    let dpay_init = DpayInitArg {
        ledgers: vec![
            LedgerConfig { currency: DEMO_USD, principal: ledger_dusd, mintable: true },
            LedgerConfig { currency: CKX, principal: ledger_ckx, mintable: false },
        ],
        per_tx_cap: CAP,
        controller,
    };
    pic.install_canister(dpay, dpay_wasm(), encode_one(&dpay_init).unwrap(), None);

    (pic, ledger_dusd, ledger_ckx, dpay, payer_sk, payer_pk, merch_pk)
}

fn setup() -> (PocketIc, Principal, Principal, Principal, SigningKey, [u8; 32], [u8; 32]) {
    setup_with(None)
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
    let auth = Authorization { from, to, amount, nonce, expiry, currency };
    SignedAuthorization::new(sk, auth).to_wire().to_vec()
}

fn pay(pic: &PocketIc, dpay: Principal, wire: Vec<u8>) -> Result<PayReceipt, String> {
    let reply = pic
        .update_call(dpay, Principal::anonymous(), "pay", encode_one(&wire).unwrap())
        .expect("pay update_call rejected at IC level");
    decode_one::<Result<PayReceipt, String>>(&reply).unwrap()
}

/// Balance as the dpay canister reports it (proxies to the ledger; an update call).
fn dpay_balance(pic: &PocketIc, dpay: Principal, pk: [u8; 32], currency: Currency) -> u64 {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "balance_of",
            encode_args((pk.to_vec(), currency)).unwrap(),
        )
        .expect("balance_of update rejected");
    decode_one::<u64>(&reply).unwrap()
}

/// Balance read DIRECTLY from an ICRC ledger — proves the funds really live there, under the dpay
/// canister's principal with the pubkey as the subaccount.
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

fn ledger_chain_len(pic: &PocketIc, ledger: Principal) -> u64 {
    let reply = pic
        .query_call(
            ledger,
            Principal::anonymous(),
            "icrc3_get_blocks",
            encode_one(&vec![GetBlocksRequest { start: Nat::from(0u64), length: Nat::from(1u64) }])
                .unwrap(),
        )
        .expect("icrc3_get_blocks query rejected");
    let res: GetBlocksResult = decode_one(&reply).unwrap();
    nat_to_u64(&res.log_length)
}

/// Fund a user on a MINTABLE currency through the dpay canister (it transfers from the ledger's
/// minting account, which it owns). Asserts the mint succeeded; the balance is verified separately.
fn mint(pic: &PocketIc, dpay: Principal, to: [u8; 32], currency: Currency, amount: u64) {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "mint",
            encode_args((to.to_vec(), currency, amount)).unwrap(),
        )
        .expect("mint update rejected");
    decode_one::<Result<u64, String>>(&reply).unwrap().expect("mint ok");
}

/// Like `mint` but expects the canister to REFUSE (currency is not mintable). Returns the error.
fn mint_err(pic: &PocketIc, dpay: Principal, to: [u8; 32], currency: Currency, amount: u64) -> String {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "mint",
            encode_args((to.to_vec(), currency, amount)).unwrap(),
        )
        .expect("mint update rejected");
    decode_one::<Result<u64, String>>(&reply).unwrap().expect_err("mint should be refused")
}

fn burn(pic: &PocketIc, dpay: Principal, from: [u8; 32], currency: Currency, amount: u64) {
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "burn",
            encode_args((from.to_vec(), currency, amount)).unwrap(),
        )
        .expect("burn update rejected");
    decode_one::<Result<u64, String>>(&reply).unwrap().expect("burn ok");
}

#[test]
fn offline_sign_settles_on_demo_currency() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();

    // Fund the payer through the dpay canister -> DUSD ledger mint.
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);

    // The funds really live on the DUSD ledger under {owner: dpay, subaccount: payer}.
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 0);

    // Offline-signed authorization, settled by the dpay canister on the DUSD ledger.
    let expiry = T0_SECS + 120;
    let r = pay(&pic, dpay, signed(&sk, payer, merch, 2_500, [1u8; 16], expiry, DEMO_USD))
        .expect("pay should succeed");
    assert_eq!(r.amount, 2_500);
    assert_eq!(r.new_from_balance, 7_500);

    // The DUSD ledger reflects the move — read directly, not through dpay.
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 7_500);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 2_500);
    // And the dpay canister's proxied view agrees.
    assert_eq!(dpay_balance(&pic, dpay, payer, DEMO_USD), 7_500);
    assert_eq!(dpay_balance(&pic, dpay, merch, DEMO_USD), 2_500);

    // The ICRC-3 block log grew: one mint + one transfer.
    assert_eq!(ledger_chain_len(&pic, ledger_dusd), 2);
}

#[test]
fn replay_is_rejected_and_ledger_unchanged() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    let expiry = T0_SECS + 120;
    let nonce = [7u8; 16];

    assert!(pay(&pic, dpay, signed(&sk, payer, merch, 1_000, nonce, expiry, DEMO_USD)).is_ok());
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 9_000);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 1_000);

    // Same nonce again -> rejected, ledger untouched.
    let dup = pay(&pic, dpay, signed(&sk, payer, merch, 1_000, nonce, expiry, DEMO_USD));
    assert!(dup.is_err(), "nonce reuse must be rejected: {dup:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 9_000);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 1_000);
    // Only one transfer block ever landed on the ledger.
    assert_eq!(ledger_chain_len(&pic, ledger_dusd), 2); // mint + 1 transfer
}

#[test]
fn non_mintable_currency_settles_and_cannot_be_minted() {
    let (pic, _ledger_dusd, ledger_ckx, dpay, sk, payer, merch) = setup();

    // ckX arrived externally (pre-funded via initial_balances), NOT via dpay mint.
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, payer), INIT_A);

    // dpay must refuse to mint ckX — it's a real ck currency, not play money.
    let err = mint_err(&pic, dpay, merch, CKX, 5_000);
    assert!(err.contains("not mintable"), "wrong mint error: {err}");
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, merch), 0); // nothing created

    // But dpay CAN move the externally-funded ckX by settling an offline-signed payment.
    let expiry = T0_SECS + 120;
    pay(&pic, dpay, signed(&sk, payer, merch, 3_000, [2u8; 16], expiry, CKX))
        .expect("ckX pay should settle");
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, payer), 7_000);
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, merch), 3_000);
}

#[test]
fn currencies_cannot_cross() {
    let (pic, ledger_dusd, ledger_ckx, dpay, _sk, _payer, merch) = setup();

    // A fresh sender that holds DUSD but NO ckX (setup only pre-funds the original payer on ckX).
    let sender_sk = generate_keypair();
    let sender = sender_sk.verifying_key().to_bytes();
    mint(&pic, dpay, sender, DEMO_USD, INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, sender), INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, sender), 0);

    // A CKX payment from `sender` must fail — the ckX balance is 0, and the DUSD balance (on a
    // different ledger/canister) cannot cover it. This is the protocol-level no-swap guarantee.
    let expiry = T0_SECS + 120;
    let res = pay(&pic, dpay, signed(&sender_sk, sender, merch, 1_000, [5u8; 16], expiry, CKX));
    assert!(res.is_err(), "cross-currency pay must be rejected: {res:?}");

    // Neither ledger moved.
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, sender), INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, sender), 0);
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, merch), 0);
}

#[test]
fn burn_destroys_demo_currency() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, payer, _merch) = setup();

    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);

    // Burn half back to the minting account (ICRC convention: transfer to minting account = burn).
    burn(&pic, dpay, payer, DEMO_USD, 5_000);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 5_000);

    // Burning more than remains is refused.
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "burn",
            encode_args((payer.to_vec(), DEMO_USD, 10_000u64)).unwrap(),
        )
        .expect("burn update rejected");
    let res: Result<u64, String> = decode_one(&reply).unwrap();
    assert!(res.is_err(), "over-burn must be refused");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 5_000);
}

#[test]
fn over_cap_is_rejected() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    let expiry = T0_SECS + 120;
    let res = pay(&pic, dpay, signed(&sk, payer, merch, CAP + 1, [3u8; 16], expiry, DEMO_USD));
    assert!(res.is_err(), "over-cap must be rejected: {res:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 0);
}

#[test]
fn insufficient_balance_is_rejected() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    let expiry = T0_SECS + 120;
    let res = pay(&pic, dpay, signed(&sk, payer, merch, INIT_A + 1, [4u8; 16], expiry, DEMO_USD));
    assert!(res.is_err(), "insufficient balance must be rejected: {res:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 0);
}

#[test]
fn expired_auth_is_rejected() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    let expiry = T0_SECS + 30;
    let wire = signed(&sk, payer, merch, 1_000, [9u8; 16], expiry, DEMO_USD);
    pic.advance_time(Duration::from_secs(31));
    pic.tick();
    let res = pay(&pic, dpay, wire);
    assert!(res.is_err(), "expired auth must be rejected: {res:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);
}

// --- regression tests for the adversarial review findings --------------------------------------

/// CRITICAL regression: two `pay()` calls sharing the same nonce but naming different payees must
/// NOT both settle. The IC interleaves messages at `await` points; before the nonce-reserve fix,
/// both observed the nonce as unused and both transferred (a proven double-spend). The fix reserves
/// the nonce synchronously before any `await`, so the second concurrent `pay` is rejected. We force
/// interleaving by submitting BOTH calls (non-blocking) then `tick()` to run a round.
#[test]
fn concurrent_pay_same_nonce_settles_once() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);

    let expiry = T0_SECS + 120;
    let nonce = [42u8; 16];
    // Two auths with the SAME nonce but different payees.
    let merch2 = generate_keypair().verifying_key().to_bytes();
    let wire_a = signed(&sk, payer, merch, 2_500, nonce, expiry, DEMO_USD);
    let wire_b = signed(&sk, payer, merch2, 2_500, nonce, expiry, DEMO_USD);

    // Submit both BEFORE ticking, so they are both in-flight when execution runs — this is what
    // forces the await-point interleaving the real IC (and PocketIC) exhibit.
    let id_a = pic
        .submit_call(dpay, Principal::anonymous(), "pay", encode_one(&wire_a).unwrap())
        .expect("submit pay A");
    let id_b = pic
        .submit_call(dpay, Principal::anonymous(), "pay", encode_one(&wire_b).unwrap())
        .expect("submit pay B");
    pic.tick();

    let res_a = decode_one::<Result<PayReceipt, String>>(
        &pic.await_call(id_a).expect("await pay A should complete"),
    )
    .unwrap();
    let res_b = decode_one::<Result<PayReceipt, String>>(
        &pic.await_call(id_b).expect("await pay B should complete"),
    )
    .unwrap();

    // Exactly one settles. (Which one is scheduler-dependent; assert the counts, not the identity.)
    let oks = [res_a.is_ok(), res_b.is_ok()].iter().filter(|&&x| x).count();
    assert_eq!(oks, 1, "exactly one of the same-nonce pays must settle; got A={res_a:?} B={res_b:?}");

    // The payer is debited exactly once: INIT_A - 2_500 (fee is 0 on DUSD). No double-spend.
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A - 2_500);
    // Exactly one transfer block landed (plus the mint).
    assert_eq!(ledger_chain_len(&pic, ledger_dusd), 2);
}

/// HIGH: the fee branch. A ledger with a non-zero transfer_fee must deduct amount+fee from the
/// sender and deliver `amount` to the recipient (the demo DUSD ledger has fee=0, so this path was
/// previously untested). The receipt's `new_from_balance` must reflect amount+fee.
#[test]
fn non_zero_fee_settles_with_fee_deducted() {
    const FEE_CUR: Currency = 2;
    const FEE: u64 = 1_000;

    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));

    let payer_sk = generate_keypair();
    let payer = payer_sk.verifying_key().to_bytes();
    let merch = generate_keypair().verifying_key().to_bytes();

    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);
    // A mintable ledger that charges a transfer fee (like a real ckBTC ledger).
    let ledger = install_ledger(
        &pic,
        Account { owner: dpay, subaccount: None },
        "FEE",
        FEE,
        vec![],
    );
    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig { currency: FEE_CUR, principal: ledger, mintable: true }],
        per_tx_cap: CAP,
        controller: None,
    };
    pic.install_canister(dpay, dpay_wasm(), encode_one(&dpay_init).unwrap(), None);

    // Fund the payer (minting is fee-free).
    mint(&pic, dpay, payer, FEE_CUR, INIT_A);
    assert_eq!(ledger_balance(&pic, ledger, dpay, payer), INIT_A);

    // Pay 2_500: sender loses amount+fee, recipient gains amount.
    let expiry = T0_SECS + 120;
    let r = pay(&pic, dpay, signed(&payer_sk, payer, merch, 2_500, [3u8; 16], expiry, FEE_CUR))
        .expect("fee'd pay should settle");
    assert_eq!(r.new_from_balance, INIT_A - 2_500 - FEE, "receipt must reflect fee");
    assert_eq!(ledger_balance(&pic, ledger, dpay, payer), INIT_A - 2_500 - FEE);
    assert_eq!(ledger_balance(&pic, ledger, dpay, merch), 2_500);

    // Insufficient to cover amount+fee (exactly amount is not enough) is rejected.
    let barely = INIT_A - 2_500 - FEE; // remaining balance
    let res = pay(&pic, dpay, signed(&payer_sk, payer, merch, barely, [4u8; 16], expiry, FEE_CUR));
    assert!(res.is_err(), "balance covering amount but not amount+fee must be rejected: {res:?}");
    assert_eq!(ledger_balance(&pic, ledger, dpay, payer), barely);
}

/// CRITICAL: with a controller set, admin ops (mint/burn/register_ledger) must refuse any other
/// caller. With no controller (the demo default) they remain open.
#[test]
fn admin_ops_are_gated_by_controller() {
    // The governed controller principal (a fixed, non-anonymous identity standing in for a
    // governed caller). With it set at init, every other principal is refused on admin ops.
    let admin = pic_admin();
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, payer, _merch) = setup_with(Some(admin));

    // Anonymous caller (the default in `mint`) must be refused.
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "mint",
            encode_args((payer.to_vec(), DEMO_USD, INIT_A)).unwrap(),
        )
        .expect("mint update rejected");
    let res: Result<u64, String> = decode_one(&reply).unwrap();
    assert!(res.is_err(), "anonymous mint must be refused when a controller is set: {res:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 0);

    // The controller principal mints successfully.
    let reply = pic
        .update_call(
            dpay,
            admin,
            "mint",
            encode_args((payer.to_vec(), DEMO_USD, INIT_A)).unwrap(),
        )
        .expect("mint update rejected");
    let res: Result<u64, String> = decode_one(&reply).unwrap();
    assert!(res.is_ok(), "controller mint must succeed: {res:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);
}

/// MED: mint, pay, and burn all appear in `transactions_of`. Previously mint/burn were absent
/// (they never called record_txn).
#[test]
fn transactions_of_records_mint_pay_burn() {
    let (pic, _ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);

    let expiry = T0_SECS + 120;
    pay(&pic, dpay, signed(&sk, payer, merch, 2_500, [1u8; 16], expiry, DEMO_USD)).unwrap();
    burn(&pic, dpay, payer, DEMO_USD, 1_000);

    // The payer's history (newest-first) must contain: burn, pay, mint.
    let txns = transactions_of(&pic, dpay, payer, DEMO_USD, 10);
    assert_eq!(txns.len(), 3, "mint + pay + burn all recorded");
    // Newest first: burn (to mint account), then pay (to merch), then mint (from mint account).
    assert_eq!(txns[0].amount, 1_000); // burn
    assert_eq!(txns[0].to, [0xFFu8; 32]); // burn target is the mint sentinel
    assert_eq!(txns[1].amount, 2_500); // pay
    assert_eq!(txns[1].to, merch.to_vec());
    assert_eq!(txns[2].amount, INIT_A); // mint
    assert_eq!(txns[2].from, [0xFFu8; 32]); // mint source is the mint sentinel

    // limit is honored (O(limit), not O(total)).
    assert_eq!(transactions_of(&pic, dpay, payer, DEMO_USD, 1).len(), 1);
    assert_eq!(transactions_of(&pic, dpay, payer, DEMO_USD, 0).len(), 0);

    // The merchant sees the single payment they received.
    let merch_txns = transactions_of(&pic, dpay, merch, DEMO_USD, 10);
    assert_eq!(merch_txns.len(), 1);
    assert_eq!(merch_txns[0].amount, 2_500);
}

/// MED: a controller set at init can be rotated via set_controller (governed), and locking the
/// canister down (open -> governed) is possible. Once locked, only the controller may rotate.
#[test]
fn controller_rotation_locks_down_open_mode() {
    let admin = pic_admin();
    // A second governed principal that the controller rotates to.
    let next_gov = Principal::self_authenticating(&[7u8; 29]);

    // Open mode (no controller): admin ops are open to anyone.
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, payer, _merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A); // open mode: anonymous mint succeeds

    // Lock the canister down by setting a controller (open mode lets any caller do this once).
    let reply = pic
        .update_call(dpay, Principal::anonymous(), "set_controller", encode_args((Some(admin),)).unwrap())
        .expect("set_controller update rejected");
    assert!(decode_one::<Result<(), String>>(&reply).unwrap().is_ok(), "open mode: lock-down succeeds");

    // Locked: an anonymous admin op is now refused (this is the attack-prevention property).
    let mint_ok = |caller: Principal| -> bool {
        let reply = pic
            .update_call(dpay, caller, "mint", encode_args((payer.to_vec(), DEMO_USD, 1u64)).unwrap())
            .expect("mint update rejected");
        decode_one::<Result<u64, String>>(&reply).unwrap().is_ok()
    };
    assert!(!mint_ok(Principal::anonymous()), "locked: anon mint refused");
    assert!(mint_ok(admin), "controller mint ok");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A + 1);

    // Non-controller cannot rotate; the controller can rotate to a new principal.
    let reply = pic
        .update_call(dpay, Principal::anonymous(), "set_controller", encode_args((Some(next_gov),)).unwrap())
        .expect("set_controller update rejected");
    assert!(decode_one::<Result<(), String>>(&reply).unwrap().is_err(), "non-controller rotation refused");
    let reply = pic
        .update_call(dpay, admin, "set_controller", encode_args((Some(next_gov),)).unwrap())
        .expect("set_controller update rejected");
    assert!(decode_one::<Result<(), String>>(&reply).unwrap().is_ok(), "controller rotation succeeds");

    // After rotation, the old controller loses access and the new one gains it.
    assert!(!mint_ok(admin), "old controller now refused");
    assert!(mint_ok(next_gov), "new controller mint ok");
}

/// LOW (L5): register_ledger — the most consequential admin op — is gated by the controller.
/// An anonymous repoint (the attack scenario) must be refused when a controller is set.
#[test]
fn register_ledger_is_gated_by_controller() {
    let admin = pic_admin();
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, _payer, _merch) = setup_with(Some(admin));

    // Anonymous repoint of a (new) currency at the ledger is refused.
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "register_ledger",
            encode_args((2u32, ledger_dusd, true)).unwrap(),
        )
        .expect("register_ledger update rejected");
    assert!(decode_one::<Result<(), String>>(&reply).unwrap().is_err(), "anon repoint refused");

    // The controller can register a new currency.
    let reply = pic
        .update_call(dpay, admin, "register_ledger", encode_args((2u32, ledger_dusd, true)).unwrap())
        .expect("register_ledger update rejected");
    assert!(decode_one::<Result<(), String>>(&reply).unwrap().is_ok(), "controller register ok");
}

fn transactions_of(pic: &PocketIc, dpay: Principal, pk: [u8; 32], currency: Currency, limit: u32) -> Vec<TxnView> {
    let reply = pic
        .query_call(
            dpay,
            Principal::anonymous(),
            "transactions_of",
            encode_args((pk.to_vec(), currency, limit)).unwrap(),
        )
        .expect("transactions_of query rejected");
    decode_one(&reply).unwrap()
}

/// A stable principal to use as the governed controller in `admin_ops_are_gated_by_controller`.
/// `Principal::management_canister()` is a fixed, non-anonymous principal that is always available
/// offline — perfect for standing in for a governed caller in tests.
fn pic_admin() -> Principal {
    Principal::management_canister()
}
