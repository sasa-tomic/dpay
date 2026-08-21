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
    DEMO_USD, MEMO_LEN, NAME_LEN, PUBKEY_LEN, SIG_LEN,
};
use ed25519_dalek::SigningKey;
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::{TransferArg, TransferError};
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

/// Mirror of the canister's `ReconcileReport` (the `reconcile(currency)` return).
#[derive(CandidType, Deserialize, Debug, PartialEq)]
struct ReconcileReport {
    currency: u32,
    blocks_scanned: u64,
    orphans_repaired: u64,
}

#[derive(CandidType, Deserialize, Debug, PartialEq)]
struct TxnView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    timestamp: u64,
    /// Payer's display name (UTF-8 string; empty when unset, e.g. mint/burn/reconcile/withdraw rows).
    from_name: String,
    /// Payee's display name (UTF-8 string; empty when unset).
    to_name: String,
    /// Optional merchant-set memo (UTF-8 string; empty when unset).
    memo: String,
}

/// Local mirror of the canister's `RampCapability` (candid wire type) — needed to encode
/// `register_currency_meta`/`register_currency` calls and decode `currencies()` replies.
#[derive(CandidType, serde::Serialize, Deserialize, Debug, PartialEq, Eq, Clone)]
enum RampCapability {
    Direct,
    Partner,
    Unavailable,
}

/// Local mirror of the canister's `MinterFamily` (candid wire type) — the `None` variant is all the
/// cap-only registrations need.
#[derive(CandidType, serde::Serialize, Deserialize, Debug, PartialEq, Eq, Clone)]
enum MinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
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

    // MC2 U1: `pay` reads the per-currency cap (fail-closed — a cap-less currency rejects every
    // non-zero pay). Register a cap for BOTH currencies the shared setup's pay tests exercise so they
    // keep settling; use the global CAP value to preserve pre-MC2 behavior. (over_cap_is_rejected
    // pays CAP+1 against DEMO_USD → still rejected since CAP+1 > CAP.) Skipped in open mode
    // (controller=None): register_currency_meta is admin-gated and the only setup_with(None) caller
    // (open_mode_denies_admin_but_faucet_and_lockdown_work) does not exercise pay.
    if let Some(admin) = controller {
        register_currency_meta_cap(&pic, dpay, admin, DEMO_USD, CAP);
        register_currency_meta_cap(&pic, dpay, admin, CKX, CAP);
    }

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
    // Default display names + memo to all-zero (empty) — the legacy callers don't assert names, so
    // they keep working unchanged. The new `signed_named` helper covers the names round-trip test.
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

/// Pad an ASCII name/memo into a fixed NUL-padded buffer (mirrors what the app builder does before
/// signing). Truncates to the field width.
fn pad_name(s: &[u8]) -> [u8; NAME_LEN] {
    let mut b = [0u8; NAME_LEN];
    let n = s.len().min(NAME_LEN);
    b[..n].copy_from_slice(&s[..n]);
    b
}

/// Like [`signed`], but carries display names + a memo. Proves names ride inside the signed bytes and
/// survive the full settle → history round-trip through stable memory.
fn signed_named(
    sk: &SigningKey,
    from: [u8; 32],
    to: [u8; 32],
    amount: u64,
    nonce: [u8; 16],
    expiry: u64,
    currency: Currency,
    from_name: &[u8],
    to_name: &[u8],
    memo: &[u8],
) -> Vec<u8> {
    let auth = Authorization {
        from,
        to,
        amount,
        nonce,
        expiry,
        currency,
        from_name: pad_name(from_name),
        to_name: pad_name(to_name),
        memo: {
            let mut b = [0u8; MEMO_LEN];
            let n = memo.len().min(MEMO_LEN);
            b[..n].copy_from_slice(&memo[..n]);
            b
        },
    };
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

/// RFC 8410 DER prefix for an Ed25519 SubjectPublicKeyInfo — byte-identical to the canister's
/// `calls::ED25519_DER_PREFIX` and `dpay_icp::principal::DER_PREFIX` (kept inline here because this
/// crate deliberately does not depend on dpay-icp).
const ED25519_DER_PREFIX: [u8; 12] = [48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0];

/// The USER-principal ICRC account for a pubkey — `owner = Principal::self_authenticating(DER(pk))`
/// (the user's own principal), `subaccount = None`. This is the rail's addressing shape since the
/// 2026-08-19 user-principal cutover and, since the 2026-08-20 faucet re-target, the account the
/// facade's `mint` credits (mirrors `calls::user_account_of` in the canister).
fn user_account(pk: [u8; 32]) -> Account {
    let mut der = [0u8; 44];
    der[..12].copy_from_slice(&ED25519_DER_PREFIX);
    der[12..].copy_from_slice(&pk);
    Account { owner: Principal::self_authenticating(&der), subaccount: None }
}

/// Balance read DIRECTLY from an ICRC ledger at the USER-principal account — the shape the app
/// reads (`icpSelfPrincipal()`, default subaccount) and the shape `mint` credits post-2026-08-20.
fn user_ledger_balance(pic: &PocketIc, ledger: Principal, pk: [u8; 32]) -> u64 {
    let acct = user_account(pk);
    let reply = pic
        .query_call(
            ledger,
            Principal::anonymous(),
            "icrc1_balance_of",
            encode_one(&acct).unwrap(),
        )
        .expect("icrc1_balance_of (user principal) query rejected");
    let nat: Nat = decode_one(&reply).unwrap();
    nat_to_u64(&nat)
}

/// Fund a user's FACADE-CUSTODY account (`{owner: dpay, subaccount: pk}`) with a RAW
/// `icrc1_transfer` from the ledger's minting account, sent AS the facade principal (which owns
/// the minting account). Since the 2026-08-20 mint re-target, `mint` credits the USER principal —
/// so pay/burn-flow tests (which spend from the custody shape) fund via THIS helper instead of the
/// facade's `mint`. One call = one ledger block (fee-free: transfers from the minting account are
/// mints, and ICRC-1 does not fee mints). The block carries no nonce memo and debits the minting
/// account's DEFAULT subaccount, so `reconcile`'s orphan filter (from-subaccount + memo-as-nonce)
/// skips it.
fn fund_custody(pic: &PocketIc, ledger: Principal, dpay: Principal, pk: [u8; 32], amount: u64) {
    let reply = pic
        .update_call(
            ledger,
            dpay, // sender = the facade = the minting-account owner
            "icrc1_transfer",
            encode_one(&TransferArg {
                from_subaccount: None,
                to: Account { owner: dpay, subaccount: Some(pk) },
                amount: Nat::from(amount),
                fee: None,
                memo: None,
                created_at_time: None,
            })
            .unwrap(),
        )
        .expect("custody-funding icrc1_transfer rejected at IC level");
    decode_one::<Result<Nat, TransferError>>(&reply)
        .unwrap()
        .expect("custody-funding transfer ok");
}

fn ledger_chain_len(pic: &PocketIc, ledger: Principal) -> u64 {    let reply = pic
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

/// Controller `mint` through the facade (transfers from the ledger's minting account, which it
/// owns). Since the 2026-08-20 faucet re-target this credits the USER-principal account
/// (`user_account(pk)`), NOT the facade-custody subaccount — so pay/burn-flow tests (which spend
/// from the custody shape) fund via [`fund_custody`] instead; this helper is for mint-semantics
/// tests. Returns the facade's `mint` return value — which per the `Ledger` trait contract is the
/// NEW BALANCE at the user principal (not the ledger block index). Called as the seeded controller
/// (`pic_admin`): the privileged `mint` is controller-only (R1), exactly as the relay's production
/// faucet drives it with an authenticated controller identity.
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

/// Register currency metadata with ONLY a per-tx `cap` (MC2 U1). All other fields are `None` /
/// `Unavailable` — this is the minimal registration that makes `pay` work under fail-closed
/// per-currency caps. Called as the seeded controller (`caller`); `register_currency_meta` replaces
/// the record in place, so calling it again with a tighter cap overrides a prior value.
fn register_currency_meta_cap(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    currency: Currency,
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

/// Admin-gated reconcile (controller-only), called by `caller`. Returns the facade's report.
fn reconcile(pic: &PocketIc, dpay: Principal, currency: Currency, caller: Principal) -> Result<ReconcileReport, String> {
    let reply = pic
        .update_call(dpay, caller, "reconcile", encode_args((currency,)).unwrap())
        .expect("reconcile update rejected");
    decode_one::<Result<ReconcileReport, String>>(&reply).unwrap()
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

/// `receipt_pubkey()` query — the canister's receipt Ed25519 public key (32 bytes), or `None` if the
/// key has not been generated yet (no successful `pay` and no `init_receipt_key`).
fn receipt_pubkey(pic: &PocketIc, dpay: Principal) -> Option<Vec<u8>> {
    let reply = pic
        .query_call(dpay, Principal::anonymous(), "receipt_pubkey", encode_args(()).unwrap())
        .expect("receipt_pubkey query rejected");
    decode_one::<Option<Vec<u8>>>(&reply).unwrap()
}

/// `receipt(blob nonce)` query — the canister-signed stored receipt for a settled nonce, or `None`.
fn receipt(pic: &PocketIc, dpay: Principal, nonce: [u8; 16]) -> Option<ReceiptView> {
    let reply = pic
        .query_call(
            dpay,
            Principal::anonymous(),
            "receipt",
            encode_args((nonce.to_vec(),)).unwrap(),
        )
        .expect("receipt query rejected");
    decode_one::<Option<ReceiptView>>(&reply).unwrap()
}

/// A stable principal to use as the governed controller in admin-gating tests. The management
/// canister is a fixed, non-anonymous principal always available offline.
fn pic_admin() -> Principal {
    Principal::management_canister()
}

#[test]
fn offline_sign_settles_on_demo_currency() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();

    // Fund the payer's FACADE-CUSTODY account with a raw minting-account transfer (the 2026-08-20
    // mint re-target moved facade `mint` to the user principal, so custody funding is raw).
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);

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
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
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
    assert_eq!(ledger_chain_len(&pic, ledger_dusd), 2); // custody fund + 1 transfer
}

/// R2 (CRITICAL): a successful `pay` yields a CANISTER-SIGNED receipt whose Ed25519 signature
/// verifies under `receipt_pubkey()` (and the receipt's embedded `pubkey`); tampering any claim
/// field (amount / nonce / block_index / settle_ts) breaks verification; a replay of the same nonce
/// is rejected AND the stored receipt is returnable verbatim via `receipt(nonce)`. This is the
/// outcome-attestation property: a merchant/relay cannot forge a "Paid ✓" — only the canister holds
/// the receipt secret.
#[test]
fn pay_yields_canister_signed_verifiable_receipt() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
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
    assert_eq!(r.block_index, 1, "block index of the transfer (custody fund was block 0)");

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

/// MC4 U1: the receipt signing key MUST be generated BEFORE the ledger commit. Today `pay()`
/// generates it POST-commit (`ensure_receipt_key().await?` after `ledger_transfer`), so on the very
/// first pay to a fresh canister a `raw_rand` trap leaves a SETTLED payment (ledger debited) with NO
/// stored receipt — the highest-risk pay. The fix moves key-gen before the commit.
///
/// We prove the pre-commit placement via a side effect: on a fresh canister (no key), a pay that is
/// REJECTED at the balance gate (which runs after the awaits, before any commit) STILL generates the
/// receipt key — because key-gen now runs before the balance await. On the old post-commit code a
/// rejected pay never reached key-gen, so `receipt_pubkey()` stayed `None`. We then prove the
/// happy-path corollary: the first successful pay's receipt verifies under that exact pre-commit key
/// and the key is unchanged (never rotated) by the successful pay.
#[test]
fn receipt_key_generated_before_ledger_commit() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    // NO custody funding (payer balance = 0) and NO init_receipt_key — the receipt key does not
    // exist yet.
    assert!(receipt_pubkey(&pic, dpay).is_none(), "no receipt key before any pay");

    // A pay that fails for insufficient balance. The reject happens after the balance await, before
    // any commit. (Valid sig; amount under CAP; fresh nonce — the ONLY reject reason is balance.)
    let expiry = T0_SECS + 120;
    let err = pay(&pic, dpay, signed(&sk, payer, merch, 1_000, [0x11; 16], expiry, DEMO_USD))
        .expect_err("insufficient-balance pay must be rejected");
    assert!(
        err.contains("InsufficientFunds"),
        "reject reason must be balance, got: {err}"
    );

    // MC4 U1 INVARIANT: the receipt key was generated BEFORE the reject (key-gen now runs before
    // the balance await, i.e. pre-commit). On the old post-commit code this stayed None — the first
    // successful pay would have been the highest-risk pay (raw_rand post-commit).
    let pk_after_reject = receipt_pubkey(&pic, dpay)
        .expect("receipt key generated pre-commit even on a rejected pay");

    // Happy-path corollary: the first SUCCESSFUL pay's receipt verifies under that exact pre-commit
    // key, and the key is unchanged by the successful pay (generated once, never rotated).
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
    let nonce = [0x22; 16];
    let r = pay(&pic, dpay, signed(&sk, payer, merch, 2_500, nonce, expiry, DEMO_USD))
        .expect("pay should succeed now");
    assert_eq!(
        receipt_pubkey(&pic, dpay).unwrap(),
        pk_after_reject,
        "receipt key unchanged by a successful pay (never rotated)"
    );
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&pk_after_reject);
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
        "first successful pay's receipt verifies under the pre-commit key"
    );
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
    fund_custody(&pic, ledger_dusd, dpay, sender, INIT_A);
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

    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
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
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
    let expiry = T0_SECS + 120;
    let res = pay(&pic, dpay, signed(&sk, payer, merch, CAP + 1, [3u8; 16], expiry, DEMO_USD));
    assert!(res.is_err(), "over-cap must be rejected: {res:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 0);
}

/// MC2 U1 (TDD RED→GREEN) — `pay` reads the per-currency cap from CURRENCY_META, NOT the legacy
/// global CAP. A currency whose registered per-currency cap is BELOW the global CAP must reject an
/// amount that is ABOVE the per-currency cap but BELOW the global cap. Today (pre-fix) `pay` uses
/// the global CAP → this pay settles → RED. After the fix → OverCap → GREEN.
#[test]
fn per_currency_cap_rejects_amount_above_registered_cap() {
    const PER_CUR_CAP: u64 = 2_000; // BELOW the global CAP (100_000)
    const PAY_AMOUNT: u64 = 3_000; // strictly between PER_CUR_CAP and the global CAP
    let (pic, _ledger_dusd, ledger_ckx, dpay, sk, payer, merch) = setup();
    // CKX (currency 1) is pre-funded with INIT_A on its ledger by setup. Override its cap (setup
    // registered the global CAP) with a tighter per-currency cap.
    register_currency_meta_cap(&pic, dpay, pic_admin(), CKX, PER_CUR_CAP);
    let expiry = T0_SECS + 120;
    let res = pay(&pic, dpay, signed(&sk, payer, merch, PAY_AMOUNT, [21u8; 16], expiry, CKX));
    assert!(
        res.is_err(),
        "amount {PAY_AMOUNT} > per-currency cap {PER_CUR_CAP} must be rejected (global cap is {CAP}): {res:?}",
    );
    // No debit landed on the CKX ledger.
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, payer), INIT_A);
}

/// MC2 U1 — a pay strictly UNDER the per-currency cap still settles (GREEN before AND after the fix).
#[test]
fn per_currency_cap_allows_amount_under_registered_cap() {
    const PER_CUR_CAP: u64 = 5_000;
    const PAY_AMOUNT: u64 = 2_000; // < PER_CUR_CAP
    let (pic, _ledger_dusd, ledger_ckx, dpay, sk, payer, merch) = setup();
    register_currency_meta_cap(&pic, dpay, pic_admin(), CKX, PER_CUR_CAP);
    let expiry = T0_SECS + 120;
    let receipt = pay(&pic, dpay, signed(&sk, payer, merch, PAY_AMOUNT, [22u8; 16], expiry, CKX))
        .expect("amount under the per-currency cap must settle");
    assert_eq!(receipt.amount, PAY_AMOUNT);
    assert_eq!(ledger_balance(&pic, ledger_ckx, dpay, payer), INIT_A - PAY_AMOUNT);
}

/// MC2 U1 (fail-closed) — a currency with NO cap registered rejects every non-zero pay. The cap
/// fallback is 0, so any amount > 0 is over-cap. Proven on a throwaway currency id (with its own
/// ledger but deliberately NO currency_meta). Today (pre-fix) this pays against the global CAP and
/// settles → RED. After the fix → OverCap → GREEN.
#[test]
fn fail_closed_currency_with_no_cap_rejects_every_pay() {
    const FRESH: Currency = 7;
    const FUND: u64 = 10_000;
    const PAY_AMOUNT: u64 = 1_000;
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));
    let payer_sk = generate_keypair();
    let payer = payer_sk.verifying_key().to_bytes();
    let merch = generate_keypair().verifying_key().to_bytes();
    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);
    // A mintable ledger for the fresh currency; minting account owned by the facade.
    let ledger = install_ledger(
        &pic,
        Account { owner: dpay, subaccount: None },
        "FRESH",
        0,
        vec![],
    );
    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig { currency: FRESH, principal: ledger, mintable: true }],
        per_tx_cap: CAP,
        controller: Some(pic_admin()),
    };
    pic.install_canister(dpay, dpay_wasm(), encode_one(&dpay_init).unwrap(), None);
    // Deliberately NO register_currency_meta for FRESH → no cap → fail-closed. Fund the payer's
    // custody account raw (from the minting account the facade owns).
    fund_custody(&pic, ledger, dpay, payer, FUND);
    assert_eq!(ledger_balance(&pic, ledger, dpay, payer), FUND);
    let expiry = T0_SECS + 120;
    let res = pay(&pic, dpay, signed(&payer_sk, payer, merch, PAY_AMOUNT, [23u8; 16], expiry, FRESH));
    assert!(
        res.is_err(),
        "a cap-less currency must reject every non-zero pay (fail-closed): {res:?}",
    );
    assert_eq!(ledger_balance(&pic, ledger, dpay, payer), FUND);
}

#[test]
fn insufficient_balance_is_rejected() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
    let expiry = T0_SECS + 120;
    let res = pay(&pic, dpay, signed(&sk, payer, merch, INIT_A + 1, [4u8; 16], expiry, DEMO_USD));
    assert!(res.is_err(), "insufficient balance must be rejected: {res:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 0);
}

#[test]
fn expired_auth_is_rejected() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
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
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);

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
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);

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
    // Exactly one transfer block landed (plus the custody fund).
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

    // MC2 U1: register a per-currency cap for FEE_CUR so its pays settle (fail-closed otherwise).
    register_currency_meta_cap(&pic, dpay, pic_admin(), FEE_CUR, CAP);

    // Fund the payer's custody account raw (minting-account transfer: fee-free even on this
    // fee-charging ledger, and the custody credit is a MINT-shaped transfer so no fee applies).
    fund_custody(&pic, ledger, dpay, payer, INIT_A);
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

/// CRITICAL: with a controller set, admin ops (mint/burn/register_ledger) must refuse any caller
/// that is neither the controller nor an [`ADMIN_CALLERS`] operator. With no controller (the demo
/// default) they remain open. Since the 2026-08-20 faucet re-target, a controller `mint` credits
/// the USER-principal account (`self_authenticating(DER(pk))`, no subaccount) — the account the
/// app reads — NOT the facade-custody subaccount; this is the shape the production relay faucet
/// relies on when it drives `mint` with an authenticated controller identity.
///
/// The 2026-08-20 secp256k1 discovery reshaped the prod wiring: dfx identities are secp256k1 but
/// the relay's agent signs Ed25519, so the CONTROLLER cell holds the relay's DEDICATED Ed25519 key
/// while the dfx deploy identity (an IC-level controller + ADMIN_CALLERS operator) keeps dfx-side
/// ops working. This test pins BOTH admission classes and the exact refusal wording the relay
/// surfaces verbatim as the app's 422.
#[test]
fn admin_ops_are_gated_by_controller() {
    let admin = pic_admin();
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, payer, _merch) = setup_with(Some(admin));

    // Readback (the `just faucet-verify` leg-3 probe): admin_controller returns the live cell.
    let reply = pic
        .query_call(dpay, Principal::anonymous(), "admin_controller", encode_args(()).unwrap())
        .expect("admin_controller query rejected");
    let controller: Option<Principal> = decode_one(&reply).unwrap();
    assert_eq!(controller, Some(admin), "admin_controller readback must mirror the cell");

    // Anonymous caller must be refused — with the exact wording the relay maps to the app's 422.
    let reply = pic
        .update_call(
            dpay,
            Principal::anonymous(),
            "mint",
            encode_args((payer.to_vec(), DEMO_USD, INIT_A)).unwrap(),
        )
        .expect("mint update rejected");
    let res: Result<u64, String> = decode_one(&reply).unwrap();
    assert_eq!(
        res,
        Err("unauthorized: admin ops require the controller principal".to_string()),
        "anonymous mint must be refused with the verbatim gate text"
    );
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 0);
    assert_eq!(user_ledger_balance(&pic, ledger_dusd, payer), 0, "no user-principal credit either");

    // An arbitrary non-controller principal must be refused identically (the wrong-seed shape).
    let nobody = Principal::from_slice(&[9u8; 29]);
    let reply = pic
        .update_call(
            dpay,
            nobody,
            "mint",
            encode_args((payer.to_vec(), DEMO_USD, INIT_A)).unwrap(),
        )
        .expect("mint update rejected");
    let res: Result<u64, String> = decode_one(&reply).unwrap();
    assert_eq!(
        res,
        Err("unauthorized: admin ops require the controller principal".to_string()),
        "non-controller mint must be refused with the verbatim gate text"
    );

    // The controller principal mints successfully — at the USER principal (read directly off the
    // ledger via icrc1_balance_of on Account{self_authenticating(DER(payer)), None}).
    let reply = pic
        .update_call(
            dpay,
            admin,
            "mint",
            encode_args((payer.to_vec(), DEMO_USD, INIT_A)).unwrap(),
        )
        .expect("mint update rejected");
    let res: Result<u64, String> = decode_one(&reply).unwrap();
    let new_balance = res.expect("controller mint must succeed");
    assert_eq!(new_balance, INIT_A, "mint returns the post-mint balance at the user principal");
    assert_eq!(user_ledger_balance(&pic, ledger_dusd, payer), INIT_A, "credit landed at the user principal");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 0, "custody subaccount untouched");
}

/// The 2026-08-20 prod wiring: the CONTROLLER cell holds the relay's Ed25519 key while the dfx
/// deploy identity (an ADMIN_CALLERS operator that also holds IC-level canister control) stays
/// able to run admin ops — deploy-time `register_currency_meta`, the `just mint` operator hook.
/// An operator that is NOT the controller must pass `require_admin` and mint at the user
/// principal, exactly like the controller does.
#[test]
fn admin_ops_admit_operators_alongside_the_controller() {
    let admin = pic_admin();
    let (pic, ledger_dusd, _ledger_ckx, dpay, _sk, payer, _merch) = setup_with(Some(admin));
    let operator =
        Principal::from_text("hhwti-hb7f7-4ojco-uvazw-vcwr7-fqd6o-3oljb-aezpo-iheay-3gxmx-rqe")
            .expect("dfx identity `dpay` principal is valid");

    let reply = pic
        .update_call(
            dpay,
            operator,
            "mint",
            encode_args((payer.to_vec(), DEMO_USD, INIT_A)).unwrap(),
        )
        .expect("mint update rejected");
    let res: Result<u64, String> = decode_one(&reply).unwrap();
    let new_balance = res.expect("ADMIN_CALLERS operator mint must pass require_admin");
    assert_eq!(new_balance, INIT_A);
    assert_eq!(user_ledger_balance(&pic, ledger_dusd, payer), INIT_A, "operator mint credits the user principal");
}

/// MED: mint, pay, and burn all appear in `transactions_of`. Newest-first; O(limit) read.
#[test]
fn transactions_of_records_mint_pay_burn() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    // The facade mint writes the mint HISTORY row (and credits the user principal); the pay/burn
    // below spend from the CUSTODY shape, so fund that raw too.
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);

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

/// N6/H3 (wire-format v2): display names + memo ride inside the SIGNED authorization, settle through
/// the facade, and round-trip through stable memory into `transactions_of` as `String` — so the
/// payee sees the payer's name, not a raw hex pubkey. Proves names are bound by the signature (a
/// tamper would be rejected at `verify`) and persist in history on BOTH sides. Mint/burn rows (which
/// use the MINT_ACCOUNT sentinel) carry empty names, so this also asserts the app's empty-string
/// decoding for zero-padded fields.
#[test]
fn names_and_memo_round_trip_through_history() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    // The facade mint writes the mint HISTORY row (asserted below); the named pay spends from the
    // CUSTODY shape, so fund that raw too.
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);

    let expiry = T0_SECS + 120;
    let nonce = [0x4eu8; 16];
    // Alice pays Bob 3_000 with memo "dinner" — all three names ride inside the signed bytes.
    pay(
        &pic,
        dpay,
        signed_named(
            &sk,
            payer,
            merch,
            3_000,
            nonce,
            expiry,
            DEMO_USD,
            b"Alice",
            b"Bob",
            b"dinner",
        ),
    )
    .expect("named pay should settle");

    // The payer's history row carries the names verbatim (decoded from the NUL-padded signed field).
    let payer_txns = transactions_of(&pic, dpay, payer, DEMO_USD, 10);
    let pay_row = payer_txns
        .iter()
        .find(|t| t.nonce == nonce.to_vec())
        .expect("named pay recorded on payer side");
    assert_eq!(pay_row.from_name, "Alice", "from_name round-trips on the payer side");
    assert_eq!(pay_row.to_name, "Bob", "to_name round-trips on the payer side");
    assert_eq!(pay_row.memo, "dinner", "memo round-trips on the payer side");

    // The merchant sees the SAME names (proves N6/H3 closure: no raw hex counterparty).
    let merch_txns = transactions_of(&pic, dpay, merch, DEMO_USD, 10);
    let merch_pay_row = merch_txns
        .iter()
        .find(|t| t.nonce == nonce.to_vec())
        .expect("named pay recorded on merchant side");
    assert_eq!(merch_pay_row.from_name, "Alice", "merchant sees the payer's name");
    assert_eq!(merch_pay_row.to_name, "Bob");
    assert_eq!(merch_pay_row.memo, "dinner");

    // The mint row (counterparty = MINT_ACCOUNT sentinel) has EMPTY names — the sentinel has no
    // display name, and the all-zero field decodes lossily to an empty string (never a panic).
    let mint_row = payer_txns.iter().find(|t| t.from == [0xFFu8; 32]).expect("mint row present");
    assert_eq!(mint_row.from_name, "", "mint row from_name is empty");
    assert_eq!(mint_row.to_name, "", "mint row to_name is empty");
    assert_eq!(mint_row.memo, "", "mint row memo is empty");

    // Tampering a name byte in the signed authorization breaks the canister's signature check — the
    // names are bound by the signature, not just carried. (Mirrors core's `tampering_a_name_byte`
    // proptest at the settlement boundary.)
    let mut tampered = signed_named(
        &sk,
        payer,
        merch,
        3_000,
        [0x4fu8; 16],
        expiry,
        DEMO_USD,
        b"Alice",
        b"Bob",
        b"dinner",
    );
    // Flip one byte in the to_name region of the signing bytes ([132..164) within the 196-byte
    // signing prefix; the wire is signing(196) | sig(64) | from_pub(32)).
    tampered[140] ^= 0xFF;
    let res = pay(&pic, dpay, tampered);
    assert!(res.is_err(), "a tampered name byte must fail signature verification: {res:?}");
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
    assert_eq!(user_ledger_balance(&pic, ledger_dusd, payer), 0, "no user-principal credit either");

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

    // Now locked: the controller can mint again (privileged path — credits the USER principal
    // since the 2026-08-20 re-target), anon still cannot.
    assert_eq!(
        mint(&pic, dpay, payer, DEMO_USD, 1u64),
        1,
        "controller mint ok after lockdown (returns the post-mint USER-principal balance)"
    );
    assert_eq!(user_ledger_balance(&pic, ledger_dusd, payer), 1, "credit at the user principal");
    assert_eq!(
        ledger_balance(&pic, ledger_dusd, dpay, payer),
        FAUCET_AMOUNT,
        "faucet credit (custody shape) untouched by the controller mint"
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

    // Seeded controller can mint (credits the USER principal — return = post-mint balance there);
    // anon cannot.
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
    // The ledger reflects only the successful controller mints — at the USER principal since the
    // 2026-08-20 re-target: the initial INIT_A fund + the single post-rotation mint_ok(next_gov)
    // of 1 (the anon + old-controller mint_ok calls were refused). The custody subaccount was
    // never touched.
    assert_eq!(user_ledger_balance(&pic, ledger_dusd, payer), INIT_A + 1);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), 0);
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
    // The facade mint writes the mint HISTORY row (asserted below); the pay spends from the CUSTODY
    // shape, so fund that raw too (the 2026-08-20 mint re-target moved facade mint to the user
    // principal; the display-cache + history assertions below are unaffected).
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
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

// --- R3: icrc3 reconcile (closes the cross-canister trap window) ------------------------------
//
// If `pay` traps between the ledger committing `Ok` and `settle_nonce` completing, the IC rolls
// back THIS canister's message — including the SPENT nonce reservation — while the ledger's debit
// does NOT roll back (separate canister). The post-trap state is: the ledger debited, but SPENT has
// NO entry for the nonce → a blind retry would transfer AGAIN.
//
// We simulate that EXACT state with `reinstall_canister`: reinstalling the facade wipes its stable
// state (SPENT empty) while the ledger (a separate canister) keeps its debit blocks. This faithfully
// models the trap rollback (stable writes are transactional per-message, so a trap reverts them).

/// R3 motivation: after the simulated trap (reinstall wiping SPENT), a blind retry of the SAME
/// authorization debits AGAIN — the open trap window. This is the bug `reconcile` exists to close.
#[test]
fn trap_window_lets_a_retry_double_debit_without_reconcile() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    // Fund the payer's CUSTODY account raw (mint re-target: facade mint credits the user principal
    // now; the pay below spends from custody).
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
    let expiry = T0_SECS + 120;
    let nonce = [0x31; 16];
    const AMOUNT: u64 = 2_500;

    // 1. A normal pay debits once.
    pay(&pic, dpay, signed(&sk, payer, merch, AMOUNT, nonce, expiry, DEMO_USD)).expect("first pay ok");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A - AMOUNT);
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), AMOUNT);
    assert_eq!(ledger_chain_len(&pic, ledger_dusd), 2); // custody fund + 1 transfer

    // 2. Simulate the trap: reinstall the facade, wiping its SPENT set (the IC would have rolled
    //    back the reservation). The ledger keeps the debit. Re-attach the SAME ledgers + controller.
    let dpay_init = DpayInitArg {
        ledgers: vec![
            LedgerConfig { currency: DEMO_USD, principal: ledger_dusd, mintable: true },
            LedgerConfig { currency: CKX, principal: _ledger_ckx, mintable: false },
        ],
        per_tx_cap: CAP,
        controller: Some(pic_admin()),
    };
    pic.reinstall_canister(dpay, dpay_wasm(), encode_one(&dpay_init).unwrap(), None)
        .expect("reinstall (simulate trap)");
    // MC2 U1: reinstall wipes ALL stable state (a harsher simulation than a real trap, which only
    // rolls back the in-flight message's writes). CURRENCY_META was written by a PRIOR committed
    // register_currency_meta call, so it survives a real trap — re-register the DEMO cap here to
    // faithfully model the post-trap state (cap intact, only SPENT wiped).
    register_currency_meta_cap(&pic, dpay, pic_admin(), DEMO_USD, CAP);

    // 3. THE BUG: a blind retry of the same authorization debits AGAIN. The existing quantized
    //    `created_at_time` dedup catches a SAME-bucket retry (the documented mitigation), so to show
    //    the residual window we advance past the 60s dedup bucket (but stay inside the auth's
    //    expiry): the retry now uses a fresh bucket → the ledger does not dedup it → double debit.
    //    (SPENT is empty after the reinstall, so nothing else blocks the retry.)
    pic.advance_time(Duration::from_secs(61));
    pic.tick();
    let dup = pay(&pic, dpay, signed(&sk, payer, merch, AMOUNT, nonce, expiry, DEMO_USD));
    assert!(dup.is_ok(), "post-trap cross-bucket retry must (wrongly) succeed without reconcile: {dup:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A - 2 * AMOUNT, "double debit");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), 2 * AMOUNT, "double credit");
    assert_eq!(ledger_chain_len(&pic, ledger_dusd), 3, "a second transfer block landed");
}

/// R3 (CRITICAL): `reconcile` closes the trap window. After the simulated trap (reinstall), running
/// `reconcile` walks the ledger's transaction log, finds the orphaned debit (memo = nonce, no SPENT
/// entry), marks the nonce spent + records the txn — so a retry of the same authorization is now
/// correctly treated as a DUPLICATE (rejected, no second debit). Idempotent on consistent state.
#[test]
fn reconcile_repairs_trap_orphan_and_blocks_double_debit() {
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    // Fund the payer's CUSTODY account raw (mint re-target — see trap_window test note).
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);
    let expiry = T0_SECS + 120;
    let nonce = [0x32; 16];
    const AMOUNT: u64 = 2_500;

    // 1. A normal pay debits once.
    pay(&pic, dpay, signed(&sk, payer, merch, AMOUNT, nonce, expiry, DEMO_USD)).expect("first pay ok");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), AMOUNT);
    let blocks_after_pay = ledger_chain_len(&pic, ledger_dusd);

    // 2. Simulate the trap: reinstall wipes SPENT. The ledger keeps the debit.
    let dpay_init = DpayInitArg {
        ledgers: vec![
            LedgerConfig { currency: DEMO_USD, principal: ledger_dusd, mintable: true },
            LedgerConfig { currency: CKX, principal: _ledger_ckx, mintable: false },
        ],
        per_tx_cap: CAP,
        controller: Some(pic_admin()),
    };
    pic.reinstall_canister(dpay, dpay_wasm(), encode_one(&dpay_init).unwrap(), None)
        .expect("reinstall (simulate trap)");
    // MC2 U1: re-register the DEMO cap after the reinstall (CURRENCY_META survives a real trap; the
    // reinstall is a harsher simulation). Ensures the post-reconcile retry is rejected as a DUPLICATE
    // (nonce spent), NOT as over-cap (fail-closed) — preserving the test's intent.
    register_currency_meta_cap(&pic, dpay, pic_admin(), DEMO_USD, CAP);

    // 3. Reconcile as the controller. It scans the ledger's recent transactions, finds the ONE
    //    orphaned debit (the pay's transfer, memo = nonce, not in SPENT), and repairs it.
    let report = reconcile(&pic, dpay, DEMO_USD, pic_admin()).expect("reconcile ok");
    assert_eq!(report.currency, DEMO_USD);
    assert!(report.blocks_scanned >= 1, "scanned the recent window: {report:?}");
    assert_eq!(report.orphans_repaired, 1, "exactly the one trap-orphan repaired: {report:?}");

    // The orphan is now recorded: the nonce is spent (history reflects it).
    let txns = transactions_of(&pic, dpay, payer, DEMO_USD, 10);
    assert_eq!(txns.len(), 1, "reconcile recorded the orphaned txn");
    assert_eq!(txns[0].amount, AMOUNT);
    assert_eq!(txns[0].nonce, nonce.to_vec());

    // 3b. MC4 U2: reconcile ALSO reconstructs + signs + stores a receipt for the trap-orphan, so
    //     `receipt(nonce)` returns a verifiable canister-signed attestation for EVERY settled
    //     payment (a durable recovery primitive requires this). The reinstall wiped the receipt key
    //     too, so the key seen here was regenerated BY reconcile; the reconstructed receipt must
    //     verify under the CURRENT receipt_pubkey.
    let rcp = receipt(&pic, dpay, nonce).expect("reconcile stored a receipt for the orphan");
    assert_eq!(rcp.amount, AMOUNT, "receipt amount matches the orphaned debit");
    assert_eq!(rcp.from, payer.to_vec(), "receipt from matches the orphaned debit");
    assert_eq!(rcp.to, merch.to_vec(), "receipt to matches the orphaned debit");
    assert_eq!(rcp.currency, DEMO_USD, "receipt currency matches");
    assert_eq!(rcp.block_index, 1, "block_index = start(0) + loop index(1) — custody fund=0, transfer=1");
    assert_eq!(rcp.receipt_sig.len(), SIG_LEN, "64-byte Ed25519 sig");
    // The signature verifies under the canister's receipt pubkey over the reconstructed claim.
    let qpk = receipt_pubkey(&pic, dpay).expect("receipt key regenerated by reconcile");
    assert_eq!(rcp.pubkey, qpk, "receipt pubkey matches receipt_pubkey query");
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&qpk);
    let mut sg = [0u8; SIG_LEN];
    sg.copy_from_slice(&rcp.receipt_sig);
    let claim = ReceiptClaim {
        nonce,
        from: payer,
        to: merch,
        amount: AMOUNT,
        currency: DEMO_USD,
        block_index: rcp.block_index,
        settle_ts: rcp.settle_ts,
    };
    assert!(
        verify_receipt(&pk, &claim, &sg),
        "reconcile-reconstructed receipt verifies under receipt_pubkey"
    );
    let sig_after_first_reconcile = rcp.receipt_sig.clone();

    // 4. A retry of the SAME authorization is now a DUPLICATE — rejected, no second debit. This is
    //    the airtight close: post-trap, after reconcile, the trap window is shut.
    let dup = pay(&pic, dpay, signed(&sk, payer, merch, AMOUNT, nonce, expiry, DEMO_USD));
    assert!(dup.is_err(), "post-reconcile retry must be rejected as a duplicate: {dup:?}");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, payer), INIT_A - AMOUNT, "no second debit");
    assert_eq!(ledger_balance(&pic, ledger_dusd, dpay, merch), AMOUNT, "no second credit");
    assert_eq!(ledger_chain_len(&pic, ledger_dusd), blocks_after_pay, "no new ledger block");

    // 5. Idempotent: re-running reconcile on now-consistent state repairs nothing.
    let again = reconcile(&pic, dpay, DEMO_USD, pic_admin()).expect("reconcile again ok");
    assert_eq!(again.orphans_repaired, 0, "idempotent — consistent state repairs nothing");
    // MC4 U2 idempotency: the stored receipt is UNCHANGED by a re-run (same sig; no double-write,
    // no error). The orphan is skipped on the second run (nonce already spent), and the receipt
    // insert is guarded against an existing entry regardless.
    let rcp_again = receipt(&pic, dpay, nonce).expect("receipt still present after re-run");
    assert_eq!(
        rcp_again.receipt_sig, sig_after_first_reconcile,
        "re-running reconcile leaves the same receipt (idempotent)"
    );

    // 6. Non-controller cannot run reconcile (admin-gated, like the other privileged ops).
    let refused = reconcile(&pic, dpay, DEMO_USD, Principal::anonymous());
    assert!(refused.is_err(), "non-controller reconcile must be refused: {refused:?}");
}

// --- MC2 unit 3: irreversible retire — pay rejection + history preservation -------------------
// RED-first proof that a retired currency id is rejected by the settlement path (`pay` calls
// `ledger_for` which honors RETIRED) AND that retire preserves durable history (LEDGERS/MINTERS/
// CURRENCY_META/ACCOUNT_TXNS rows are NOT deleted — only the id is marked RETIRED). These need the
// real-ledger + signed-wire setup, so they live here rather than in currencies.rs.

/// `retire_currency(nat32) -> Result<(), text>` — admin-gated, irreversible, idempotent.
fn retire_currency(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    currency: Currency,
) -> Result<(), String> {
    let reply = pic
        .update_call(dpay, caller, "retire_currency", encode_args((currency,)).unwrap())
        .expect("retire_currency update_call rejected at IC level");
    decode_one(&reply).unwrap()
}

#[test]
fn retired_currency_rejects_pay() {
    // After retire, `pay` on that currency is rejected — `ledger_for(currency)` honors RETIRED and
    // returns Err before any cross-canister transfer. The signed authorization is otherwise valid
    // (in-cap, in-expiry, good signature), so the ONLY thing that can reject it is the retire gate.
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    // Fund the payer's CUSTODY account raw (mint re-target) so balance is not the reject reason.
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);

    let expiry = T0_SECS + 120;
    // A pay on DEMO_USD succeeds BEFORE retire (sanity: the path works).
    pay(&pic, dpay, signed(&sk, payer, merch, 1_000, [1u8; 16], expiry, DEMO_USD))
        .expect("pre-retire pay settles");

    // Retire DEMO_USD — the id is now dead.
    retire_currency(&pic, dpay, pic_admin(), DEMO_USD).expect("retire DEMO_USD");

    // A subsequent pay on the retired currency is REJECTED with a retired message. A fresh nonce is
    // used so the only possible reject reason is the retire gate (not a nonce replay).
    let err = pay(&pic, dpay, signed(&sk, payer, merch, 1_000, [2u8; 16], expiry, DEMO_USD))
        .expect_err("pay on a retired currency must be rejected");
    assert!(err.contains("retired"), "error must say retired, got: {err}");
}

#[test]
fn retire_preserves_transaction_history() {
    // Retire is history-preserving by construction: it marks the id RETIRED but does NOT delete any
    // LEDGERS/MINTERS/CURRENCY_META/ACCOUNT_TXNS rows. A retired currency's prior transactions are
    // still returned by `transactions_of` (the audit trail survives).
    let (pic, ledger_dusd, _ledger_ckx, dpay, sk, payer, merch) = setup();
    // The facade mint writes the mint HISTORY row (asserted below); the pay spends from the CUSTODY
    // shape, so fund that raw too (2026-08-20 mint re-target).
    mint(&pic, dpay, payer, DEMO_USD, INIT_A);
    fund_custody(&pic, ledger_dusd, dpay, payer, INIT_A);

    let expiry = T0_SECS + 120;
    let nonce = [0x77u8; 16];
    pay(&pic, dpay, signed(&sk, payer, merch, 2_500, nonce, expiry, DEMO_USD))
        .expect("pay settles and records history");

    // Pre-retire: the payer's history has mint + pay (2 rows).
    let before = transactions_of(&pic, dpay, payer, DEMO_USD, 10);
    assert_eq!(before.len(), 2, "mint + pay recorded pre-retire");

    // Retire DEMO_USD.
    retire_currency(&pic, dpay, pic_admin(), DEMO_USD).expect("retire DEMO_USD");

    // Post-retire: the SAME rows are still there — retire preserved the audit trail (no deletion).
    let after = transactions_of(&pic, dpay, payer, DEMO_USD, 10);
    assert_eq!(after.len(), before.len(), "history survives retire (no rows deleted)");
    assert_eq!(after[0].amount, before[0].amount, "newest row intact");
    assert_eq!(after[1].amount, before[1].amount, "oldest row intact");
    // The specific pay row (identifiable by its nonce) is still present.
    assert!(
        after.iter().any(|t| t.nonce == nonce.to_vec()),
        "the pre-retire pay row is still in history after retire"
    );
}

// --- MC2 unit 4: atomic register_currency + cross-canister strict validation -------------------
// RED-first proof that `register_currency` — the single atomic activation path — STRICTLY validates
// `decimals`/`fee`/`wrapper_name` against the live ledger (F3, no exemptions incl. DEMO), rejects on
// mismatch with NOTHING inserted (atomicity — the whole update rolls back), and on a matching
// registration activates ledger+minter+meta in one shot. These tests need the REAL ic-icrc1-ledger
// (the validation calls its `icrc1_decimals`/`icrc1_fee`/`icrc1_symbol` queries), so they live here
// rather than in currencies.rs.

/// Local mirror of the canister's `CurrencyRegistration` candid RECORD arg (MC2 U4). Mirrors
/// `register_currency_meta`'s field set EXACTLY, plus `currency`/`ledger`/`mintable`/`minter`.
/// `decimals`/`fee`/`wrapper_name` are non-optional (the strict-validation inputs); the rest stay
/// optional. `CandidType + serde::Serialize` — used only to ENCODE the call args.
#[derive(CandidType, serde::Serialize)]
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
    gas_ledger: Option<Principal>,
}

/// `register_currency(CurrencyRegistration) -> Result<(), text>` — the atomic activation path.
fn register_currency(
    pic: &PocketIc,
    dpay: Principal,
    caller: Principal,
    reg: &CurrencyRegistration,
) -> Result<(), String> {
    let reply = pic
        .update_call(dpay, caller, "register_currency", encode_one(reg).unwrap())
        .expect("register_currency update_call rejected at IC level");
    decode_one(&reply).unwrap()
}

/// Local mirror of `CurrencyDescriptor` (the `currencies()` return element) — needed to assert the
/// happy-path registration populated all three registries in one shot.
#[derive(CandidType, Deserialize, Debug, PartialEq)]
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
    gas_ledger: Option<Principal>,
}

fn currencies_query(pic: &PocketIc, dpay: Principal) -> Vec<CurrencyDescriptor> {
    let reply = pic
        .query_call(dpay, Principal::anonymous(), "currencies", encode_args(()).unwrap())
        .expect("currencies query rejected at IC level");
    decode_one(&reply).unwrap()
}

/// Build a `CurrencyRegistration` whose validation fields match the given real ledger (installed via
/// `install_ledger`, which sets decimals=2 and the given symbol/transfer_fee). Override individual
/// fields to construct mismatch cases.
fn registration_matching(
    currency: Currency,
    ledger: Principal,
    symbol: &str,
    fee: u64,
) -> CurrencyRegistration {
    CurrencyRegistration {
        currency,
        ledger,
        mintable: false,
        minter: None,
        symbol: Some(symbol.into()),
        decimals: 2, // install_ledger hardcodes decimals = Some(2)
        minter_family: None,
        wrapper_name: symbol.into(),
        backing_symbol: None,
        network: None,
        display_decimals: None,
        fee,
        cap: None,
        chain_id: None,
        token_contract: None,
        onramp: RampCapability::Unavailable,
        offramp: RampCapability::Unavailable,
        gas_ledger: None,
    }
}

/// A fresh currency id used by the register_currency tests (distinct from setup's 0/1 so it never
/// collides with the seeded ledgers).
const U4: Currency = 9;

/// MC2 U4 (ATOMICITY): a mismatched `decimals` (vs the real ledger's `icrc1_decimals`) is REJECTED,
/// and NOTHING is inserted — LEDGERS/MINTERS/CURRENCY_META for that currency are all empty. The whole
/// update rolls back (an `Err` return from an `#[update]` reverts all stable writes in the message).
#[test]
fn register_currency_decimals_mismatch_rejects_and_inserts_nothing() {
    let (pic, _ledger_dusd, _ledger_ckx, dpay, _sk, _payer, _merch) = setup();
    // Install a real ledger with decimals=2 (install_ledger's hardcoded value), symbol="ATMC", fee=0.
    let ledger = install_ledger(
        &pic,
        Account { owner: dpay, subaccount: None },
        "ATMC",
        0,
        vec![],
    );
    // Register claiming decimals=8 (MISMATCH) → must be rejected.
    let mut reg = registration_matching(U4, ledger, "ATMC", 0);
    reg.decimals = 8; // the live ledger reports 2
    let err = register_currency(&pic, dpay, pic_admin(), &reg)
        .expect_err("decimals mismatch must be rejected");
    assert!(
        err.contains("metadata mismatch") && err.contains("decimals"),
        "error must report a decimals metadata mismatch, got: {err}"
    );
    // ATOMICITY: nothing was inserted. The currency does not appear in the catalog at all.
    let cat = currencies_query(&pic, dpay);
    assert!(
        cat.iter().all(|d| d.currency != U4),
        "atomicity: a rejected register_currency must insert NOTHING (LEDGERS empty)"
    );
}

/// MC2 U4 (VALIDATION): a mismatched `fee` (vs the real ledger's `icrc1_fee`) is REJECTED.
#[test]
fn register_currency_fee_mismatch_is_rejected() {
    let (pic, _ledger_dusd, _ledger_ckx, dpay, _sk, _payer, _merch) = setup();
    // Real ledger with fee=0.
    let ledger = install_ledger(
        &pic,
        Account { owner: dpay, subaccount: None },
        "FEE0",
        0,
        vec![],
    );
    // Register claiming fee=1_000 (MISMATCH) → rejected.
    let mut reg = registration_matching(U4, ledger, "FEE0", 1_000);
    reg.fee = 1_000; // the live ledger reports 0
    let err = register_currency(&pic, dpay, pic_admin(), &reg)
        .expect_err("fee mismatch must be rejected");
    assert!(
        err.contains("metadata mismatch") && err.contains("fee"),
        "error must report a fee metadata mismatch, got: {err}"
    );
}

/// MC2 U4 (VALIDATION): a mismatched `wrapper_name` (vs the real ledger's `icrc1_symbol`) is
/// REJECTED. Per F3 the DEMO currency is NOT exempt — its `wrapper_name` must equal the ledger's
/// `icrc1_symbol`.
#[test]
fn register_currency_symbol_mismatch_is_rejected() {
    let (pic, _ledger_dusd, _ledger_ckx, dpay, _sk, _payer, _merch) = setup();
    // Real ledger with symbol="DUSD".
    let ledger = install_ledger(
        &pic,
        Account { owner: dpay, subaccount: None },
        "DUSD",
        0,
        vec![],
    );
    // Register claiming wrapper_name="WRONG" (MISMATCH) → rejected.
    let mut reg = registration_matching(U4, ledger, "WRONG", 0);
    reg.wrapper_name = "WRONG".into(); // the live ledger reports "DUSD"
    let err = register_currency(&pic, dpay, pic_admin(), &reg)
        .expect_err("symbol/wrapper_name mismatch must be rejected");
    assert!(
        err.contains("metadata mismatch") && err.contains("wrapper_name"),
        "error must report a wrapper_name metadata mismatch, got: {err}"
    );
}

/// MC2 U4 (HAPPY PATH): matching decimals/fee/symbol → Ok, and `currencies()` shows the currency
/// FULLY populated — ledger + minter + meta all activated in ONE atomic update. Per F3 the DEMO
/// currency's `wrapper_name` is the ledger's `icrc1_symbol` (e.g. "DUSD").
#[test]
fn register_currency_happy_path_activates_all_three_registries() {
    let (pic, _ledger_dusd, _ledger_ckx, dpay, _sk, _payer, _merch) = setup();
    // Real ledger with symbol="DUSD", decimals=2, fee=0 — a DEMO-shaped currency.
    let ledger = install_ledger(
        &pic,
        Account { owner: dpay, subaccount: None },
        "DUSD",
        0,
        vec![],
    );
    // A minter principal to register atomically with the ledger+meta.
    let atom_minter = Principal::self_authenticating(&[0x42; 29]);
    // Build a registration that MATCHES the live ledger's decimals(2)/fee(0)/symbol("DUSD"), with a
    // full meta payload (so the happy-path assertion can check every meta field round-trips).
    let mut reg = registration_matching(U4, ledger, "DUSD", 0);
    reg.mintable = true;
    reg.minter = Some(atom_minter);
    reg.symbol = Some("$".into());
    reg.minter_family = Some(MinterFamily::CkBtcUtxo);
    reg.backing_symbol = Some("USD".into());
    reg.network = Some("ICP".into());
    reg.display_decimals = Some(2);
    reg.cap = Some(100_000);
    reg.chain_id = None;
    reg.token_contract = None;
    reg.onramp = RampCapability::Direct;
    reg.offramp = RampCapability::Unavailable;

    register_currency(&pic, dpay, pic_admin(), &reg).expect("matching registration must succeed");

    // currencies() shows the currency FULLY populated — ledger + minter + meta in one shot.
    let cat = currencies_query(&pic, dpay);
    let u4 = cat
        .iter()
        .find(|d| d.currency == U4)
        .expect("the atomically-registered currency appears in the catalog");
    assert_eq!(u4.ledger, ledger, "ledger principal activated");
    assert!(u4.mintable, "mintable flag activated");
    assert_eq!(u4.minter, Some(atom_minter), "minter activated atomically");
    assert_eq!(u4.minter_family, Some(MinterFamily::CkBtcUtxo));
    assert_eq!(u4.symbol.as_deref(), Some("$"));
    assert_eq!(u4.decimals, Some(2), "decimals validated + stored");
    assert_eq!(u4.wrapper_name.as_deref(), Some("DUSD"), "wrapper_name validated + stored");
    assert_eq!(u4.backing_symbol.as_deref(), Some("USD"));
    assert_eq!(u4.network.as_deref(), Some("ICP"));
    assert_eq!(u4.display_decimals, Some(2));
    assert_eq!(u4.fee, Some(0), "fee validated + stored");
    assert_eq!(u4.cap, Some(100_000));
    assert_eq!(u4.onramp, RampCapability::Direct);
    assert_eq!(u4.offramp, RampCapability::Unavailable);
}

/// MC2 U4 (IMMUTABILITY): a second `register_currency` for an already-existing id → Err. The first
/// call (happy path) activates the currency; the second (even with identical args) is rejected
/// because the id now exists in LEDGERS — register_currency activates a NEW currency, it does not
/// re-register an existing one (unlike the piecemeal register_ledger which is same-value idempotent).
#[test]
fn register_currency_second_call_for_existing_id_is_rejected() {
    let (pic, _ledger_dusd, _ledger_ckx, dpay, _sk, _payer, _merch) = setup();
    let ledger = install_ledger(
        &pic,
        Account { owner: dpay, subaccount: None },
        "DUP",
        0,
        vec![],
    );
    let reg = registration_matching(U4, ledger, "DUP", 0);
    register_currency(&pic, dpay, pic_admin(), &reg).expect("first registration ok");
    let err = register_currency(&pic, dpay, pic_admin(), &reg)
        .expect_err("second registration for an existing id must be rejected");
    assert!(
        err.contains("already exists") || err.contains("immutable"),
        "error must reject the duplicate activation, got: {err}"
    );
}
