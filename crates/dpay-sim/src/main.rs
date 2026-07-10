//! dpay-sim — the "demo without glass".
//!
//! Runs the whole two-scan flow against the *real* canister on PocketIC (offline, deterministic):
//! merchant requests, payer signs while offline, merchant submits, ledger settles with finality.
//! Then it shows idempotency (a double-submit charges once) and rejects a stale authorization.
//! It asserts every balance, so `just sim` doubles as an end-to-end test.

use candid::{decode_one, encode_one, CandidType, Principal};
use dpay_core::{generate_keypair, Authorization, SignedAuthorization};
use pocket_ic::{PocketIc, Time};
use serde::Deserialize;
use std::time::Duration;

const T0_SECS: u64 = 1_800_000_000;
const T0_NANOS: u64 = T0_SECS * 1_000_000_000;
const CAP: u64 = 100_000; // $1,000.00 per-tx cap

fn dim(s: &str) -> String { format!("\x1b[2m{s}\x1b[0m") }
fn bold(s: &str) -> String { format!("\x1b[1m{s}\x1b[0m") }
fn green(s: &str) -> String { format!("\x1b[32m{s}\x1b[0m") }
fn cyan(s: &str) -> String { format!("\x1b[36m{s}\x1b[0m") }
fn red(s: &str) -> String { format!("\x1b[31m{s}\x1b[0m") }
fn usd(cents: u64) -> String { format!("${}.{:02}", cents / 100, cents % 100) }
fn rule() { println!("  {}", dim("────────────────────────────────────────────────")); }

#[derive(CandidType, Deserialize)]
struct InitArg {
    account_a: Vec<u8>,
    balance_a: u64,
    account_b: Vec<u8>,
    balance_b: u64,
    per_tx_cap: u64,
}

#[derive(CandidType, Deserialize, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
}

fn wasm_bytes() -> Vec<u8> {
    let p = std::env::var("DPAY_CANISTER_WASM")
        .unwrap_or_else(|_| "target/wasm32-unknown-unknown/release/dpay_canister.wasm".into());
    std::fs::read(&p).unwrap_or_else(|e| panic!("cannot read canister wasm at {p}: {e}"))
}

fn submit(pic: &PocketIc, can: Principal, wire: Vec<u8>) -> Result<PayReceipt, String> {
    let reply = pic
        .update_call(can, Principal::anonymous(), "pay", encode_one(&wire).unwrap())
        .expect("pay rejected at IC level");
    decode_one::<Result<PayReceipt, String>>(&reply).unwrap()
}

fn balance(pic: &PocketIc, can: Principal, pk: [u8; 32]) -> u64 {
    let reply = pic
        .query_call(can, Principal::anonymous(), "balance_of", encode_one(&pk.to_vec()).unwrap())
        .expect("balance_of rejected");
    decode_one::<u64>(&reply).unwrap()
}

fn main() {
    println!();
    println!("  {}", bold("dpay — pay offline, confirm online (demo without glass)"));
    rule();

    // --- Ledger on ICP (PocketIC): two pre-funded demo accounts ---
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));
    let payer_sk = generate_keypair();
    let payer = payer_sk.verifying_key().to_bytes();
    let merchant = generate_keypair().verifying_key().to_bytes();
    let can = pic.create_canister();
    pic.add_cycles(can, 2_000_000_000_000);
    let init = InitArg {
        account_a: payer.to_vec(),
        balance_a: 10_000,
        account_b: merchant.to_vec(),
        balance_b: 0,
        per_tx_cap: CAP,
    };
    pic.install_canister(can, wasm_bytes(), encode_one(&init).unwrap(), None);
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
    let sa = SignedAuthorization::new(&payer_sk, Authorization { from: payer, to: merchant, amount, nonce: request_id, expiry });
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
    let stale = SignedAuthorization::new(&payer_sk, Authorization { from: payer, to: merchant, amount, nonce: [0x22u8; 16], expiry: T0_SECS + 30 });
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
