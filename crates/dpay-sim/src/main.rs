//! dpay-sim — the "demo without glass".
//!
//! Runs the whole two-scan flow against the *real* canister on PocketIC (offline, deterministic):
//! merchant requests, payer signs while offline, merchant submits, ledger settles with finality.
//! Then it shows idempotency (a double-submit charges once) and rejects a stale authorization.
//! It asserts every balance, so `just sim` doubles as an end-to-end test.
//!
//! The facade holds NO balances: every `pay` does a cross-canister `icrc1_transfer` on the REAL
//! DFINITY `ic-icrc1-ledger` registered for the payment's currency, and `balance_of` reads a
//! display-only cache refreshed after every settle. The payer is funded through the facade's
//! controller-gated `mint` on the mintable DEMO_USD ledger (the minting account is owned by the
//! facade). This mirrors `crates/dpay-canister-tests/tests/icrc_settle.rs::setup` +
//! `offline_sign_settles_on_demo_currency` exactly — see that file for the canonical pattern.

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use dpay_core::{generate_keypair, Authorization, DEMO_USD, MEMO_LEN, NAME_LEN, SignedAuthorization};
use icrc_ledger_types::icrc1::account::Account;
use pocket_ic::{PocketIc, Time};
use serde::Deserialize;
use std::time::Duration;

const T0_SECS: u64 = 1_800_000_000;
const T0_NANOS: u64 = T0_SECS * 1_000_000_000;
const CAP: u64 = 100_000; // $1,000.00 per-tx cap
const INIT_A: u64 = 10_000; // payer opens with $100.00

fn dim(s: &str) -> String { format!("\x1b[2m{s}\x1b[0m") }
fn bold(s: &str) -> String { format!("\x1b[1m{s}\x1b[0m") }
fn green(s: &str) -> String { format!("\x1b[32m{s}\x1b[0m") }
fn cyan(s: &str) -> String { format!("\x1b[36m{s}\x1b[0m") }
fn red(s: &str) -> String { format!("\x1b[31m{s}\x1b[0m") }
fn usd(cents: u64) -> String { format!("${}.{:02}", cents / 100, cents % 100) }
fn rule() { println!("  {}", dim("────────────────────────────────────────────────")); }

/// The governed controller used to gate the privileged `mint`/`burn`/`reconcile` calls. The
/// management-canister principal is a fixed, non-anonymous principal always available offline — the
/// same stand-in the canister test suite uses (`icrc_settle.rs::pic_admin`).
fn pic_admin() -> Principal { Principal::management_canister() }

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
struct FeatureFlags { icrc2: bool, icrc152: bool }

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
enum LedgerArg { Init(LedgerInitArgs) }

// --- facade init payload -----------------------------------------------------------------------

#[derive(CandidType, serde::Serialize)]
struct DpayInitArg {
    /// The ONE environment-specific ledger: DEMO currency 0's DUSD ledger. Every other currency
    /// the facade serves resolves from its compile-time FIXED_ASSETS table (registry removed,
    /// founder decision 2026-08-28).
    demo_ledger: Principal,
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
}

fn workspace_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn wasm_bytes() -> Vec<u8> {
    let p = std::env::var("DPAY_CANISTER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("target/wasm32-unknown-unknown/release/dpay_canister.wasm")
        });
    std::fs::read(&p).unwrap_or_else(|e| panic!("cannot read facade wasm at {}: {e}", p.display()))
}

fn ledger_wasm() -> Vec<u8> {
    let p = std::env::var("DPAY_ICRC_LEDGER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| workspace_root().join("third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("cannot read ledger wasm at {}: {e}", p.display()))
}

/// Install one real ICRC ledger with the given minting account, symbol, transfer fee, and optional
/// pre-funded balances. Returns the new ledger principal. Mirrors `icrc_settle.rs::install_ledger`.
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

/// Fund a user on a MINTABLE currency through the facade (transfers from the ledger's minting
/// account, which the facade owns). Controller-only; called as the seeded controller. Mirrors
/// `icrc_settle.rs::mint`.
/// Fund a pubkey through the facade `faucet` — the self-service on-ramp that credits the
/// facade-custody subaccount `pay` debits, in the fixed `FAUCET_AMOUNT` ($100.00 == `INIT_A`).
///
/// NOT the controller-gated `mint`: since the 2026-08-20 faucet re-target, `mint` credits the
/// USER principal (`user_account_of`), which the custody-debiting `pay` path cannot see — funding
/// via `mint` left the demo unable to settle (pre-existing at the 2026-08-28 registry removal;
/// the faucet is the intended custody-credit path).
fn faucet(pic: &PocketIc, dpay: Principal, to: [u8; 32], currency: dpay_core::Currency) {
    let reply = pic
        .update_call(dpay, Principal::anonymous(), "faucet", encode_args((to.to_vec(), currency)).unwrap())
        .expect("faucet update rejected");
    let funded = decode_one::<Result<u64, String>>(&reply).unwrap().expect("faucet ok");
    assert_eq!(funded, INIT_A, "faucet credits exactly $100.00 (== INIT_A)");
}

fn submit(pic: &PocketIc, can: Principal, wire: Vec<u8>) -> Result<PayReceipt, String> {
    let reply = pic
        .update_call(can, Principal::anonymous(), "pay", encode_one(&wire).unwrap())
        .expect("pay rejected at IC level");
    decode_one::<Result<PayReceipt, String>>(&reply).unwrap()
}

fn balance(pic: &PocketIc, can: Principal, pk: [u8; 32]) -> u64 {
    let reply = pic
        .query_call(can, Principal::anonymous(), "balance_of", encode_args((pk.to_vec(), DEMO_USD)).unwrap())
        .expect("balance_of rejected");
    decode_one::<u64>(&reply).unwrap()
}

fn main() {
    println!();
    println!("  {}", bold("dpay — pay offline, confirm online (demo without glass)"));
    rule();

    // --- Ledger on ICP (PocketIC): real ic-icrc1-ledger + facade -----------------------------
    // The facade delegates `balance_of`/`pay` to the registered ICRC ledger. The DEMO_USD ledger is
    // mintable (minting account owned by the facade), so the self-service `faucet` funds the payer.
    // The merchant starts at $0.00. (Mirrors icrc_settle.rs::setup + offline_sign_settles_on_demo.)
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));
    let payer_sk = generate_keypair();
    let payer = payer_sk.verifying_key().to_bytes();
    let merchant = generate_keypair().verifying_key().to_bytes();

    // 1. Reserve the facade canister id first — the ledger needs it as the minting account owner.
    let can = pic.create_canister();
    pic.add_cycles(can, 2_000_000_000_000);

    // 2. DUSD ledger: minting account owned by the facade (so it can mint/burn). No pre-fund.
    let ledger_dusd = install_ledger(
        &pic,
        Account { owner: can, subaccount: None },
        "DUSD",
        0,
        vec![],
    );

    // 3. Install the facade wired to the DUSD ledger (mintable; the ONE environment-specific
    //    ledger, passed as the `demo_ledger` init arg — every other currency resolves from the
    //    facade's compile-time FIXED_ASSETS table), governed by a controller (mint/burn/reconcile
    //    admin gate, mirroring prod). `per_tx_cap` IS the DEMO currency's per-tx cap (MC2 U1) —
    //    the registry-era post-install cap registration is gone with the registry.
    let init = DpayInitArg {
        demo_ledger: ledger_dusd,
        per_tx_cap: CAP,
        controller: Some(pic_admin()),
    };
    pic.install_canister(can, wasm_bytes(), encode_one(&init).unwrap(), None);

    // 4. Fund the payer $100.00 through the facade faucet (self-service custody credit — see
    //    [`faucet`] for why not the controller-gated `mint`). Merchant stays at $0.00.
    faucet(&pic, can, payer, DEMO_USD);

    println!(
        "  ledger live on a decentralized chain.  payer {}   merchant {}",
        bold(&usd(balance(&pic, can, payer))),
        bold(&usd(balance(&pic, can, merchant)))
    );
    rule();

    let amount = 500; // $5.00
    let request_id = [0x11u8; 16]; // merchant-issued; doubles as the ledger nonce
    let expiry = T0_SECS + 120;

    println!("  {} merchant enters {} and shows a request QR", cyan("1."), bold(&usd(amount)));
    println!("  {} {} payer scans it, sees \"Pay {} to Café Demo\", approves", cyan("2."), bold("[airplane mode]"), usd(amount));
    let sa = SignedAuthorization::new(&payer_sk, Authorization { from: payer, to: merchant, amount, nonce: request_id, expiry, currency: DEMO_USD, from_name: [0u8; NAME_LEN], to_name: [0u8; NAME_LEN], memo: [0u8; MEMO_LEN] });
    let qr = sa.encode();
    println!("     {}", dim(&format!("signed offline -> authorization QR ({} chars): {}…", qr.len(), &qr[..28])));
    println!("  {} merchant scans the signed QR and submits to the ledger", cyan("3."));

    let r = submit(&pic, can, sa.to_wire().to_vec()).expect("payment should settle");
    println!(
        "     {} {}  —  payer {} , merchant {}",
        green("Paid \u{2713}"),
        bold(&usd(r.amount)),
        usd(balance(&pic, can, payer)),
        usd(balance(&pic, can, merchant))
    );
    assert_eq!(balance(&pic, can, payer), 9_500);
    assert_eq!(balance(&pic, can, merchant), 500);
    rule();

    // Double-spend guard: the ledger itself refuses a reused nonce (the merchant request_id).
    // (Receipt-level idempotency — returning the same receipt over HTTP — lives in the relay.)
    println!("  {} merchant re-submits the same QR (double scan / retry)", cyan("\u{21bb}"));
    match submit(&pic, can, sa.to_wire().to_vec()) {
        Err(e) => println!(
            "     {} the ledger refuses the reuse ({}) — charged once, payer still {}",
            green("\u{2713} no double-spend"),
            red(&e),
            usd(balance(&pic, can, payer))
        ),
        Ok(_) => panic!("a reused nonce must never settle twice"),
    }
    assert_eq!(balance(&pic, can, payer), 9_500);
    assert_eq!(balance(&pic, can, merchant), 500);
    rule();

    // A stale authorization is refused.
    println!("  {} a stale (expired) authorization is presented", cyan("\u{23f1}"));
    let stale = SignedAuthorization::new(&payer_sk, Authorization { from: payer, to: merchant, amount, nonce: [0x22u8; 16], expiry: T0_SECS + 30, currency: DEMO_USD, from_name: [0u8; NAME_LEN], to_name: [0u8; NAME_LEN], memo: [0u8; MEMO_LEN] });
    pic.advance_time(Duration::from_secs(31));
    pic.tick();
    match submit(&pic, can, stale.to_wire().to_vec()) {
        Err(e) => println!("     {} refused: {} — balances untouched", green("\u{2713}"), red(&e)),
        Ok(_) => panic!("expired authorization must not settle"),
    }
    assert_eq!(balance(&pic, can, payer), 9_500);
    rule();

    println!("  {}", bold(&green("that phone never touched the internet — and the payment is final on-chain in ~1s")));
    println!();
}
