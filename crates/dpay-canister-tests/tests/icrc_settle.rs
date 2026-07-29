//! PocketIC proof that the dpay **facade** canister settles on real external ICRC ledgers
//! (offline, deterministic, seconds).
//!
//! Builds one wasm (see `just test-canister`):
//!   DPAY_CANISTER_WASM = dpay-canister   (the facade: verifies the offline sig, routes to a ledger)
//!
//! The ledgers are the REAL DFINITY `ic-icrc1-ledger` (built from dfinity/ic source, cached in
//! `third_party/ic-icrc1-ledger/`). The facade holds NO balances: every `pay()` does a cross-canister
//! `icrc1_transfer` on the real ICRC-1/3 ledger named by the payment's currency, and `balance_of`
//! reads a display-only cache that is refreshed after every settle.
//!
//! TWO ledgers are installed, proving the multi-currency design:
//!   - DUSD (currency 0, `mintable`): minting account owned by the facade — dpay mints/burns.
//!   - CKX  (currency 1, NOT mintable): a stand-in for a real ckBTC/ckETH ledger. The payer is
//!     pre-funded via the ledger's `initial_balances` (simulating an external deposit); dpay can
//!     move those funds but cannot mint them.
//!
//! Proves: offline-sign settles on the right ledger (read balances DIRECTLY off the ledger via
//! `icrc1_balance_of`); replay/expiry/over-cap/insufficient rejected; currencies cannot cross (a
//! DUSD balance cannot settle a CKX payment); demo currency mints/burns; non-mintable currency
//! cannot be minted; the cache-backed `balance_of` query reflects settles; and SPENT nonces +
//! ACCOUNT_TXNS history survive a facade upgrade.

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use dpay_core::{
    generate_keypair, verify_receipt, Authorization, Currency, ReceiptClaim, SignedAuthorization,
    DEMO_USD, PUBKEY_LEN, SIG_LEN,
};
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

/// Mirror of the canister's `FAUCET_AMOUNT` ($100.00). The faucet always mints exactly this; the
/// test asserts the fixed amount so a drift in either direction is caught.
const FAUCET_AMOUNT: u64 = 10_000;

/// A second currency standing in for a real ck token (ckBTC/ckETH/ckUSDT). Registered with the
/// facade as NOT mintable, and pre-funded via the ledger's own `initial_balances`.
const CKX: Currency = 1;

// --- real ic-icrc1-ledger init payload (mirrors third_party/ic-icrc1-ledger/ledger.did) --------

#[allow(dead_code)] // arms exist only so the candid variant type matches the ledger's MetadataValue
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

// Single-arm variant: a valid candid subtype of the ledger's
// `variant { Init: InitArgs; Upgrade: opt UpgradeArgs }`.
#[derive(CandidType, serde::Serialize)]
enum LedgerArg {
    Init(LedgerInitArgs),
}

// --- facade init payload -----------------------------------------------------------------------

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

#[derive(CandidType, Deserialize, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
    block_index: u64,
    settle_ts: u64,
    receipt_sig: Vec<u8>,
    pubkey: Vec<u8>,
}

/// Mirror of the canister's `ReceiptView` (the `receipt(nonce)` query return).
#[derive(CandidType, Deserialize, Debug, PartialEq)]
struct ReceiptView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    block_index: u64,
    settle_ts: u64,
    receipt_sig: Vec<u8>,
    pubkey: Vec<u8>,
}

#[derive(CandidType, Deserialize, Debug, PartialEq)]
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
    // crates/dpay-canister-tests -> workspace root
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The REAL DFINITY ic-icrc1-ledger wasm, cached offline in third_party/. Override via env.
fn ledger_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_ICRC_LEDGER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm")
        });
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read ledger wasm at {}: {e}", path.display()))
}

/// The FACADE canister wasm (dpay-canister). Override via DPAY_CANISTER_WASM (set by the justfile).
fn dpay_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_CANISTER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("target/wasm32-unknown-unknown/release/dpay_canister.wasm")
        });
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read facade wasm at {}: {e}", path.display()))
}

/// Install one real ICRC ledger with the given minting account, symbol, transfer fee, and optional
/// pre-funded balances. Returns the new ledger principal.
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
            // Cost-minimizing for a demo/pilot: archives only spawn after 10M settled blocks.
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

/// Two real ledgers + the facade wired to both:
///   - ledger_dusd (currency 0, mintable): minting account owned by the facade.
///   - ledger_ckx  (currency 1, NOT mintable): minting account owned by a separate reserved
///     principal; the payer is pre-funded via initial_balances to simulate an external deposit.
fn setup_with(
    controller: Option<Principal>,
) -> (PocketIc, Principal, Principal, Principal, SigningKey, [u8; 32], [u8; 32]) {
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));

    let payer_sk = generate_keypair();
    let payer_pk = payer_sk.verifying_key().to_bytes();
    let merch_pk = generate_keypair().verifying_key().to_bytes();

    // 1. Reserve the facade canister id first — ledgers need it as the minting account owner and as
    //    the owner of pre-funded subaccounts.
    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);

    // 2. DUSD ledger: minting account owned by the facade (so it can mint/burn). No pre-fund.
    let ledger_dusd = install_ledger(
        &pic,
        Account { owner: dpay, subaccount: None },
        "DUSD",
        0,
        vec![],
    );

    // 3. CKX ledger: minting account owned by a SEPARATE reserved principal, and the payer
    //    pre-funded via initial_balances — i.e. ckX arrived externally, the facade did not mint it.
    let ckx_minter = pic.create_canister(); // reserved, never installed
    let payer_ckx_acct = Account { owner: dpay, subaccount: Some(payer_pk) };
    let ledger_ckx = install_ledger(
        &pic,
        Account { owner: ckx_minter, subaccount: None },
        "CKX",
        0,
        vec![(payer_ckx_acct, Nat::from(INIT_A))],
    );

    // 4. Install the facade wired to both ledgers: DUSD mintable, CKX not.
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
    // Seed a controller (the stable management-canister principal) so the controller-only `mint`
    // helper below can fund accounts. The default demo deployment ships with controller=null, but
    // the settlement tests need precise balances via the privileged mint, so they run locked. The
    // open-mode behavior (mint/register denied, faucet works) is covered by dedicated tests below.
    setup_with(Some(pic_admin()))
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

/// The facade's cached balance via its `balance_of` QUERY (display-only; refreshed post-settle).
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

/// Balance read DIRECTLY from an ICRC ledger — proves the funds really live there, under the
/// facade's principal with the pubkey as the subaccount.
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

/// Fund a user on a MINTABLE currency through the facade (transfers from the ledger's minting
/// account, which it owns). Returns the facade's `mint` return value — which per the `Ledger` trait
/// contract is the NEW BALANCE (not the ledger block index). Called as the seeded controller
/// (`pic_admin`): the privileged `mint` is controller-only (R1), so a test funds accounts by acting
/// as the controller, exactly as an operator would in production.
fn mint(pic: &PocketIc, dpay: Principal, to: [u8; 32], currency: Currency, amount: u64) -> u64 {
    let reply = pic
        .update_call(
            dpay,
            pic_admin(),
            "mint",
            encode_args((to.to_vec(), currency, amount)).unwrap(),
        )
        .expect("mint update rejected");
    decode_one::<Result<u64, String>>(&reply).unwrap().expect("mint ok")
}

/// Like `mint` but expects the facade to REFUSE (currency not mintable / unauthorized). Returns err.
fn mint_err(pic: &PocketIc, dpay: Principal, to: [u8; 32], currency: Currency, amount: u64) -> String {
    let reply = pic
        .update_call(
            dpay,
            pic_admin(),
            "mint",
            encode_args((to.to_vec(), currency, amount)).unwrap(),
        )
        .expect("mint update rejected");
    decode_one::<Result<u64, String>>(&reply)
        .unwrap()
        .expect_err("mint should be refused")
}

fn burn(pic: &PocketIc, dpay: Principal, from: [u8; 32], currency: Currency, amount: u64) {
    let reply = pic
        .update_call(
            dpay,
            pic_admin(),
            "burn",
            encode_args((from.to_vec(), currency, amount)).unwrap(),
        )
        .expect("burn update rejected");
    decode_one::<Result<u64, String>>(&reply).unwrap().expect("burn ok");
}

/// Self-service faucet: mints the FIXED `FAUCET_AMOUNT` ($100.00) to `to` on `currency`, called by
/// `caller` (default anonymous — the faucet has no admin gate). Returns the facade's reported
/// post-faucet balance.
fn faucet(
    pic: &PocketIc,
    dpay: Principal,
    to: [u8; 32],
    currency: Currency,
    caller: Principal,
) -> Result<u64, String> {
    let reply = pic
        .update_call(
            dpay,
            caller,
            "faucet",
            encode_args((to.to_vec(), currency)).unwrap(),
        )
        .expect("faucet update rejected");
    decode_one::<Result<u64, String>>(&reply).unwrap()
}

fn transactions_of(
    pic: &PocketIc,
    dpay: Principal,
    pk: [u8; 32],
    currency: Currency,
    limit: u32,
) -> Vec<TxnView> {
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

/// A stable principal to use as the governed controller in admin-gating tests. The management
/// canister is a fixed, non-anonymous principal always available offline.
fn pic_admin() -> Principal {
    Principal::management_canister()
}

#[test]
fn offline_sign_settles_on_demo_currency() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();

    // Fund the payer through the facade -> DUSD ledger mint. The facade's `mint` returns the NEW
    // BALANCE per the `Ledger` trait contract (not the ledger block index) — a fresh account minted
    // INIT_A therefore reports INIT_A.
    let minted = mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    assert_eq!(minted, INIT_A, "facade mint must return the post-mint balance");

    // The funds really live on the DUSD ledger under {owner: dpay, subaccount: payer}.
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 0);

    // Offline-signed authorization, settled by the facade on the DUSD ledger.
    let expiry = T0_SECS + 120;
    let r = pay(&pic, dpay, signed(&sk, payer, merch, 2_500, [1u8; 16], expiry, DEMO_USD))
        .expect("pay should succeed");
    assert_eq!(r.amount, 2_500);
    assert_eq!(r.new_from_balance, 7_500);

    // The DUSD ledger reflects the move — read directly, not through the facade.
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 7_500);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 2_500);
    // And the facade's cached view agrees (cache refreshed post-settle).
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

/// R2 (CRITICAL): a successful `pay` yields a CANISTER-SIGNED receipt whose Ed25519 signature
/// verifies under `receipt_pubkey()` (and the receipt's embedded `pubkey`); tampering any claim
/// field (amount / nonce / block_index / settle_ts) breaks verification; a replay of the same nonce
/// is rejected AND the stored receipt is returnable verbatim via `receipt(nonce)`. This is the
/// outcome-attestation property: a merchant/relay cannot forge a "Paid ✓" — only the canister holds
/// the receipt secret.
#[test]
fn pay_yields_canister_signed_verifiable_receipt() {
    let (pic, _ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    let expiry = T0_SECS + 120;
    let nonce = [0x2a; 16];

    // Before any pay, the receipt pubkey is not yet generated (lazy on first pay). `receipt` for an
    // unsettled nonce returns null (never a fake signed receipt).
    let reply = pic
        .query_call(dpay, Principal::anonymous(), "receipt_pubkey", encode_args(()).unwrap())
        .expect("receipt_pubkey query rejected");
    assert_eq!(decode_one::<Option<Vec<u8>>>(&reply).unwrap(), None, "no pubkey before first pay");
    let reply = pic
        .query_call(
            dpay,
            Principal::anonymous(),
            "receipt",
            encode_args((nonce.to_vec(),)).unwrap(),
        )
        .expect("receipt query rejected");
    assert!(decode_one::<Option<ReceiptView>>(&reply).unwrap().is_none(), "unsettled nonce => null");

    // Settle: the receipt carries the canister signature + pubkey.
    let r = pay(&pic, dpay, signed(&sk, payer, merch, 2_500, nonce, expiry, DEMO_USD))
        .expect("pay should succeed");
    assert_eq!(r.receipt_sig.len(), SIG_LEN, "64-byte Ed25519 sig");
    assert_eq!(r.pubkey.len(), PUBKEY_LEN, "32-byte pubkey");
    assert_eq!(r.block_index, 1, "block index of the transfer (mint was block 0)");

    // The canister's receipt_pubkey query now returns the same key the receipt carries.
    let reply = pic
        .query_call(dpay, Principal::anonymous(), "receipt_pubkey", encode_args(()).unwrap())
        .expect("receipt_pubkey query rejected");
    let qpk = decode_one::<Option<Vec<u8>>>(&reply).unwrap().expect("pubkey after first pay");
    assert_eq!(qpk, r.pubkey, "receipt pubkey matches receipt_pubkey query");

    // The signature verifies over the canonical claim under the canister's pubkey.
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&r.pubkey);
    let mut sg = [0u8; SIG_LEN];
    sg.copy_from_slice(&r.receipt_sig);
    let claim = ReceiptClaim {
        nonce,
        from: payer,
        to: merch,
        amount: 2_500,
        currency: DEMO_USD,
        block_index: r.block_index,
        settle_ts: r.settle_ts,
    };
    assert!(
        verify_receipt(&pk, &claim, &sg),
        "canister receipt signature must verify under receipt_pubkey"
    );

    // Tampering ANY outcome field breaks verification (a lying merchant cannot alter the receipt).
    let mut tampered = claim;
    tampered.amount = 2_501;
    assert!(!verify_receipt(&pk, &tampered, &sg), "tampered amount must fail verify");
    let mut t2 = claim;
    t2.nonce[0] ^= 0xFF;
    assert!(!verify_receipt(&pk, &t2, &sg), "tampered nonce must fail verify");
    let mut t3 = claim;
    t3.block_index = 999;
    assert!(!verify_receipt(&pk, &t3, &sg), "tampered block_index must fail verify");

    // A DIFFERENT key (not the canister's) does not verify the receipt.
    let other = generate_keypair().verifying_key().to_bytes();
    assert!(!verify_receipt(&other, &claim, &sg), "wrong key must fail verify");

    // Replay of the same nonce is rejected (idempotency intact) ...
    let dup = pay(&pic, dpay, signed(&sk, payer, merch, 2_500, nonce, expiry, DEMO_USD));
    assert!(dup.is_err(), "nonce reuse must be rejected: {dup:?}");

    // ... but the stored receipt is returnable verbatim via `receipt(nonce)` (reconciliation), and
    // it carries the SAME signature + claim — proving the canister attests the settled outcome
    // durably, not just in the original response.
    let reply = pic
        .query_call(
            dpay,
            Principal::anonymous(),
            "receipt",
            encode_args((nonce.to_vec(),)).unwrap(),
        )
        .expect("receipt query rejected");
    let view = decode_one::<Option<ReceiptView>>(&reply)
        .unwrap()
        .expect("settled nonce => stored receipt");
    assert_eq!(view.amount, 2_500);
    assert_eq!(view.block_index, r.block_index);
    assert_eq!(view.settle_ts, r.settle_ts);
    assert_eq!(view.receipt_sig, r.receipt_sig, "stored receipt sig == pay-response sig");
    assert_eq!(view.pubkey, r.pubkey);
    // And the stored receipt verifies identically.
    let mut sg2 = [0u8; SIG_LEN];
    sg2.copy_from_slice(&view.receipt_sig);
    assert!(verify_receipt(&pk, &claim, &sg2), "stored receipt verifies");
}

#[test]
fn non_mintable_currency_settles_and_cannot_be_minted() {
    let (pic, _ledger_dusd, ledger_ckx, dpay, sk, payer, merch) = setup();

    // ckX arrived externally (pre-funded via initial_balances), NOT via facade mint.
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, payer), INIT_A);

    // The facade must refuse to mint ckX — it's a real ck currency, not play money.
    let err = mint_err(&pic, dpay, merch, CKX, 5_000);
    assert!(err.contains("not mintable"), "wrong mint error: {err}");
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, merch), 0); // nothing created

    // But the facade CAN move the externally-funded ckX by settling an offline-signed payment.
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
    // Cache refreshed post-burn.
    assert_eq!(dpay_balance(&pic, dpay, payer, DEMO_USD), 5_000);

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

/// LOW (I2): a payer cannot sign funds to the reserved mint/burn sentinel (`[0xFF;32]`). That
/// subaccount is reserved for history rows and is not a valid Ed25519 pubkey. `pay` rejects it at
/// the cheap pre-check, before any cross-canister call — so funds can't be pushed into the sentinel
/// subaccount the history index uses as the mint/burn counterparty.
#[test]
fn pay_to_mint_sentinel_is_rejected() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, _merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);

    let expiry = T0_SECS + 120;
    let res = pay(&pic, dpay, signed(&sk, payer, [0xFFu8; 32], 1_000, [13u8; 16], expiry, DEMO_USD));
    assert!(res.is_err(), "pay to the mint sentinel must be rejected: {res:?}");
    // The sender was not debited (no transfer landed).
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);
}

/// CRITICAL regression: two `pay()` calls sharing the same nonce but naming different payees must
/// NOT both settle. The IC interleaves messages at `await` points; the synchronous nonce-reserve
/// (before any await) makes the second concurrent `pay` observe the nonce as used. We force
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

    // Submit both BEFORE ticking, so they are both in-flight when execution runs.
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
/// sender and deliver `amount` to the recipient (the demo DUSD ledger has fee=0).
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
        // Seed a controller so the privileged `mint` helper (called as pic_admin) can fund the payer.
        controller: Some(pic_admin()),
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
    let admin = pic_admin();
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, payer, _merch) = setup_with(Some(admin));

    // Anonymous caller must be refused.
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

/// MED: mint, pay, and burn all appear in `transactions_of`. Newest-first; O(limit) read.
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

/// R1 (CRITICAL): with NO controller set (the demo default), the privileged admin ops
/// `mint`/`register_ledger`/`register_minter` are REJECTED for every caller — the open-admin default
/// is closed. The self-service `faucet` still works (mints the fixed amount). Open mode still allows
/// the one-time lockdown (`set_controller`), after which the controller can `mint`. This is the
/// money-safety flip: an unconfigured deployment cannot have its currency repointed or its demo
/// currency printed by any caller; the demo on-ramp is the rate-limited `faucet`.
#[test]
fn open_mode_denies_admin_but_faucet_and_lockdown_work() {
    let admin = pic_admin();
    // controller = None (open/demo mode).
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, payer, _merch) = setup_with(None);

    // Privileged mint is DENIED for an anonymous caller (and for every caller — there is no
    // controller to be). Nothing is created.
    let err = mint_err(&pic, dpay, payer, DEMO_USD, INIT_A);
    assert!(
        err.contains("no controller set") || err.contains("admin ops disabled"),
        "open-mode mint must be denied: {err}"
    );
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 0);

    // register_ledger / register_minter are likewise denied (no anonymous repoint of a currency).
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "register_ledger",
            encode_args((2u32, ledger_dusd, true)).unwrap(),
        )
        .expect("register_ledger update rejected");
    assert!(
        decode_one::<Result<(), String>>(&reply).unwrap().is_err(),
        "open-mode register_ledger must be denied"
    );
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "register_minter",
            encode_args((2u32, admin)).unwrap(),
        )
        .expect("register_minter update rejected");
    assert!(
        decode_one::<Result<(), String>>(&reply).unwrap().is_err(),
        "open-mode register_minter must be denied"
    );

    // But the self-service FAUCET works for anyone — the demo on-ramp — minting the fixed amount.
    let bal = faucet(&pic, dpay, payer, DEMO_USD, Principal::anonymous())
        .expect("faucet must work in open mode");
    assert_eq!(bal, FAUCET_AMOUNT, "faucet mints exactly FAUCET_AMOUNT");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), FAUCET_AMOUNT);

    // Open mode still allows the one-time lockdown: set_controller seeds the first controller.
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "set_controller",
            encode_args((Some(admin),)).unwrap(),
        )
        .expect("set_controller update rejected");
    assert!(
        decode_one::<Result<(), String>>(&reply).unwrap().is_ok(),
        "open mode: one-time lockdown (set_controller) must succeed"
    );

    // Now locked: the controller can mint again (privileged path), anon still cannot.
    assert_eq!(
        mint(&pic, dpay, payer, DEMO_USD, 1u64),
        FAUCET_AMOUNT + 1,
        "controller mint ok after lockdown"
    );
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "mint",
            encode_args((payer.to_vec(), DEMO_USD, 1u64)).unwrap(),
        )
        .expect("mint update rejected");
    assert!(
        decode_one::<Result<u64, String>>(&reply).unwrap().is_err(),
        "locked: anon mint refused"
    );
}

/// R1: a controller seeded at init enables the privileged admin ops for that principal only, and
/// rotation is two-step (only the current controller rotates). This is the production model: seed a
/// governed principal at `init`, then rotate via the controller.
#[test]
fn controller_rotation_is_two_step() {
    let admin = pic_admin();
    let next_gov = Principal::self_authenticating(&[7u8; 29]);
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, payer, _merch) = setup_with(Some(admin));

    // Seeded controller can mint; anon cannot.
    assert_eq!(mint(&pic, dpay, payer, DEMO_USD, INIT_A), INIT_A);
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "mint",
            encode_args((payer.to_vec(), DEMO_USD, 1u64)).unwrap(),
        )
        .expect("mint update rejected");
    assert!(
        decode_one::<Result<u64, String>>(&reply).unwrap().is_err(),
        "non-controller mint refused"
    );

    // Non-controller cannot rotate; the controller can rotate to a new principal.
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "set_controller",
            encode_args((Some(next_gov),)).unwrap(),
        )
        .expect("set_controller update rejected");
    assert!(
        decode_one::<Result<(), String>>(&reply).unwrap().is_err(),
        "non-controller rotation refused"
    );
    let reply = pic
        .update_call(dpay, admin, "set_controller", encode_args((Some(next_gov),)).unwrap())
        .expect("set_controller update rejected");
    assert!(
        decode_one::<Result<(), String>>(&reply).unwrap().is_ok(),
        "controller rotation succeeds"
    );

    let mint_ok = |caller: Principal| -> bool {
        let reply = pic
            .update_call(dpay, caller, "mint", encode_args((payer.to_vec(), DEMO_USD, 1u64)).unwrap())
            .expect("mint update rejected");
        decode_one::<Result<u64, String>>(&reply).unwrap().is_ok()
    };
    assert!(!mint_ok(admin), "old controller now refused");
    assert!(mint_ok(next_gov), "new controller mint ok");
    // Ledger reflects only the successful controller mints: the initial INIT_A fund + the single
    // post-rotation mint_ok(next_gov) of 1 (the anon + old-controller mint_ok calls were refused).
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A + 1);
}

/// R1: the self-service faucet mints the FIXED amount and is RATE-LIMITED per (account, currency).
/// A second immediate call is rejected; after the cooldown window elapses, it mints again. Proves
/// the faucet cannot be drained by repeated calls (the rate-limit is the bound on the self-service
/// surface, complementing the fixed-amount-per-call bound).
#[test]
fn faucet_mints_fixed_amount_and_rate_limits() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, payer, _merch) = setup();

    // First faucet: mints exactly FAUCET_AMOUNT.
    let bal = faucet(&pic, dpay, payer, DEMO_USD, Principal::anonymous())
        .expect("first faucet ok");
    assert_eq!(bal, FAUCET_AMOUNT);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), FAUCET_AMOUNT);

    // Second immediate faucet: rejected by the cooldown (no second debit).
    let err = faucet(&pic, dpay, payer, DEMO_USD, Principal::anonymous())
        .expect_err("second faucet must be rate-limited");
    assert!(err.contains("cooldown"), "expected cooldown error: {err}");
    assert_eq!(
        ledger_balance(&pic, ledger_dusd, dpay, payer),
        FAUCET_AMOUNT,
        "rate-limited faucet must not mint again"
    );

    // A DIFFERENT account is not rate-limited by the first account's faucet (per-account key).
    let other = generate_keypair().verifying_key().to_bytes();
    let bal2 = faucet(&pic, dpay, other, DEMO_USD, Principal::anonymous())
        .expect("faucet for a different account ok");
    assert_eq!(bal2, FAUCET_AMOUNT);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, other), FAUCET_AMOUNT);

    // Advance time past the cooldown window (1 hour); the same account can faucet again.
    pic.advance_time(Duration::from_secs(60 * 60 + 1));
    pic.tick();
    let bal3 = faucet(&pic, dpay, payer, DEMO_USD, Principal::anonymous())
        .expect("faucet ok after cooldown");
    assert_eq!(bal3, FAUCET_AMOUNT * 2);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), FAUCET_AMOUNT * 2);

    // The faucet refuses a non-mintable currency (it is demo-only).
    let err = faucet(&pic, dpay, payer, CKX, Principal::anonymous())
        .expect_err("faucet on a non-mintable currency must be refused");
    assert!(err.contains("not mintable"), "wrong faucet error: {err}");
}

/// LOW (L5): register_ledger is gated by the controller. An anonymous repoint must be refused when a
/// controller is set.
#[test]
fn register_ledger_is_gated_by_controller() {
    let admin = pic_admin();
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, _payer, _merch) = setup_with(Some(admin));

    // Anonymous repoint is refused.
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

/// NEW (upgrade safety): the facade upgrade preserves the SPENT nonce set + ACCOUNT_TXNS history in
/// stable memory (same MemoryIds/types). Balances live on the (separate, untouched) ledger, so they
/// are of course unchanged. After upgrade: a spent nonce is STILL spent (replay refused), and the
/// recorded history is intact (and the display cache survives too).
#[test]
fn upgrade_preserves_nonces_and_history() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    let expiry = T0_SECS + 120;
    let nonce = [11u8; 16];
    pay(&pic, dpay, signed(&sk, payer, merch, 3_000, nonce, expiry, DEMO_USD)).expect("pay ok");

    // Sanity: history recorded, nonce spent.
    assert_eq!(transactions_of(&pic, dpay, payer, DEMO_USD, 10).len(), 2); // mint + pay
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 7_000);

    // Upgrade the facade only (the ledger is untouched). post_upgrade is not defined, so stable
    // structures carry SPENT + ACCOUNT_TXNS across by MemoryId.
    pic.upgrade_canister(dpay, dpay_wasm(), encode_one(&()).unwrap(), None)
        .expect("upgrade should succeed");

    // History survived the upgrade.
    assert_eq!(transactions_of(&pic, dpay, payer, DEMO_USD, 10).len(), 2);
    // The nonce is STILL spent -> replay refused (this is the money-safety property).
    let replay = pay(&pic, dpay, signed(&sk, payer, merch, 3_000, nonce, expiry, DEMO_USD));
    assert!(replay.is_err(), "nonce must stay spent across upgrade: {replay:?}");
    // Ledger balances unchanged (the ledger wasn't upgraded).
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 7_000);
    // The display cache survived the upgrade too (stable), so balance_of still reflects the settle.
    assert_eq!(dpay_balance(&pic, dpay, payer, DEMO_USD), 7_000);
}

/// Operator-gated `transfer_cycles` moves cycles from the facade's own balance to another canister
/// via the management canister's `deposit_cycles`. It is gated by `require_operator` (the fixed
/// `ADMIN_CALLERS` allowlist), the SAME gate `provision_ledger_canister` uses — NOT the governance
/// `require_admin` controller gate — because rebalancing cycles between this canister and the
/// canisters it provisions is an ops/owner cycles action. The amount is bounded by the facade's
/// current balance and the bounded value is returned. This is the production ops path for reclaiming
/// cycles from a retiring canister before a mainnet upgrade and for rebalancing onto provisioned
/// canisters.
#[test]
fn transfer_cycles_rebalances_between_canisters() {
    let (pic, _ledger_dusd, _ledger_ckx, dpay, _sk, _payer, _merch) = setup();

    // `require_operator` checks `msg_caller()` against the fixed ADMIN_CALLERS allowlist. PocketIC
    // does not sign calls, so any principal may be supplied as the sender — use the allowlisted dfx
    // `dpay` operator identity.
    let operator =
        Principal::from_text("hhwti-hb7f7-4ojco-uvazw-vcwr7-fqd6o-3oljb-aezpo-iheay-3gxmx-rqe")
            .expect("operator principal parses");

    // A fresh target canister to receive cycles (created with a default starting balance).
    let target = pic.create_canister();
    let dpay_before = pic.cycle_balance(dpay);
    let target_before = pic.cycle_balance(target);
    assert!(dpay_before > 0, "facade must hold cycles to send");

    // Send N cycles (well under the facade's balance, so `min` does not bind).
    const N: u128 = 500_000_000_000; // 500B
    let reply = pic
        .update_call(dpay, operator, "transfer_cycles", encode_args((target, N)).unwrap())
        .expect("transfer_cycles update_call rejected at IC level");
    let res: Result<u128, String> = decode_one(&reply).unwrap();
    let sent = res.expect("transfer_cycles should succeed for an operator caller");
    assert_eq!(sent, N, "facade had ample cycles; the bounded amount is the full N");

    let dpay_after = pic.cycle_balance(dpay);
    let target_after = pic.cycle_balance(target);

    // The target received the sent cycles (deposit_cycles delivers the attached amount).
    assert!(
        target_after >= target_before + sent,
        "target must gain at least the sent amount: before={target_before} after={target_after} sent={sent}",
    );
    // The facade paid at least the sent amount (plus a modest call overhead).
    assert!(
        dpay_after <= dpay_before - sent,
        "facade must have dropped by at least the sent amount: before={dpay_before} after={dpay_after} sent={sent}",
    );
    // Generous overhead tolerance (cross-canister calls burn a little) but bounded so a 2x/overflow
    // bug would still show.
    const OVERHEAD: u128 = 100_000_000_000; // 100B allowance for the deposit_cycles call
    assert!(
        dpay_before - dpay_after <= sent + OVERHEAD,
        "facade overhead within tolerance: before={dpay_before} after={dpay_after} sent={sent}",
    );

    // A non-operator (anonymous) caller is refused by require_operator, and transfers nothing.
    let reply = pic
        .update_call(dpay, Principal::anonymous(), "transfer_cycles", encode_args((target, N)).unwrap())
        .expect("transfer_cycles update_call rejected at IC level");
    let res: Result<u128, String> = decode_one(&reply).unwrap();
    assert!(res.is_err(), "non-operator transfer_cycles must be refused: {res:?}");
    // The refused call transferred nothing: the facade did not drop by another `sent`, and the
    // target gained nothing beyond what the successful call already delivered. (Executing the
    // rejected call still burns a tiny amount of cycles for message handling — expected, not a
    // transfer — so the facade is allowed to drift by a small execution cost, not by `sent`.)
    let dpay_after_refused = pic.cycle_balance(dpay);
    let target_after_refused = pic.cycle_balance(target);
    assert!(
        dpay_after - dpay_after_refused < sent,
        "refused call must not transfer another {sent} cycles: dpay_after={dpay_after} now={dpay_after_refused}",
    );
    assert_eq!(
        target_after_refused, target_after,
        "refused call moved no cycles to the target",
    );
}
