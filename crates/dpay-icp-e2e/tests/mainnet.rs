//! OPT-IN mainnet proof for the user-principal IC rail (proof B — read-only, needs network).
//!
//! Gate: `DPAY_IC_MAINNET=1` (set only by `scripts/icp-mainnet-probe.sh` / `just ic-mainnet-probe`).
//! NEVER wired into `just check`/`just verify`. Signed QUERY calls only — no cycles, no state
//! change — from a throwaway fixed-seed key against https://icp-api.io:
//!
//! * DUSD ledger (ours): icrc1_fee < 10^6 base units, icrc1_decimals == 2 (live-measured —
//!   the deployed ledger runs decimals=2, NOT the 8 the task sketch assumed).
//! * ckBTC ledger (DFINITY-operated): icrc1_decimals == 8 — proves the envelope is accepted by
//!   ledgers we do not operate, not just our own.
//! * bad-signature control: 4xx (ingress rejects before execution).
//! * ckETH minter eip_1559_transaction_price arg behaviour: `None` (native-ETH path) vs
//!   `Some(ckERC20 ledger)` vs `Some(ckETH AMOUNT ledger)` — measures whether the live minter
//!   accepts the arg the app's native-ETH withdrawal path sends (WithdrawSheet passes the ckETH
//!   amount ledger; the facade-era kernel passed `None`). Read-only query, throwaway key.
//!
//! Without the env gate every test prints `skipped` and passes (offline `check` unaffected).

use candid::{Encode, Principal as CandidPrincipal};
use dpay_icp::icrc::{decode_eip1559_price, decode_int};
use dpay_icp::{ingress_expiry, sign_query, CallRequest, Principal};
use dpay_icp_e2e::{corrupt_sender_sig, decode_query_response, dev_key, QueryOutcome, Result};
use std::time::{SystemTime, UNIX_EPOCH};

const MAINNET_URL: &str = "https://icp-api.io";
/// dpay's DUSD ICRC-3 ledger (docs/CANISTERS.md).
const DUSD_LEDGER: &str = "td2nx-oaaaa-aaaab-qhdnq-cai";
/// Mainnet ckBTC ledger (DFINITY-operated — the second, independent target).
/// NOTE: the shorter form `mxzaz-hqaa-aaaar-qaada-cai` (22 chars) that docs/CANISTERS.md carried
/// is structurally-invalid base32 (valid ≡ mod 8 ∈ {0,2,4,5,7}); this form is canonical.
const CKBTC_LEDGER: &str = "mxzaz-hqaaa-aaaar-qaada-cai";
/// Mainnet ckETH minter (DFINITY-operated) — eip_1559_transaction_price target (docs/CANISTERS.md).
const CKETH_MINTER: &str = "sv3dd-oaaaa-aaaar-qacoa-cai";
/// Mainnet ckETH AMOUNT ledger (what the app's native-ETH withdrawal path passes today as the
/// eip_1559_transaction_price arg — the question this probe answers).
const CKETH_LEDGER: &str = "ss2fx-dyaaa-aaaar-qacoq-cai";
/// Mainnet ckUSDC ledger — a REGISTERED ckERC20 (the control for the Some-arg ERC-20 path).
const CKUSDC_LEDGER: &str = "xevnm-gaaaa-aaaar-qafnq-cai";
/// Candid encoding of ZERO method arguments: `DIDL` magic + empty type table + no values.
const NO_ARGS: &[u8] = b"DIDL\x00\x00";

/// `Eip1559TransactionPriceArg` — record { ckerc20_ledger_id : principal } (minter .did).
/// `Deserialize` not needed: the probe only ENCODES this type (reference DIDL via candid).
#[derive(candid::CandidType)]
struct Eip1559Arg {
    ckerc20_ledger_id: candid::Principal,
}

fn expiry() -> u64 {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64;
    ingress_expiry(now, 300)
}

fn gated() -> bool {
    let on = std::env::var("DPAY_IC_MAINNET").map(|v| v == "1").unwrap_or(false);
    if !on {
        eprintln!("skipped: DPAY_IC_MAINNET != 1 (opt-in; run via just ic-mainnet-probe)");
    }
    on
}

/// Signed query → assert HTTP 200 + replied → return the candid arg bytes.
fn query(http: &dpay_icp_e2e::IcHttp, ledger: &Principal, method: &str, arg: &[u8]) -> Result<Vec<u8>> {
    let key = dev_key(&dpay_icp_e2e::PROBE_SEED);
    let envelope = sign_query(
        &key,
        &CallRequest {
            canister: ledger.clone(),
            method_name: method.to_string(),
            arg: arg.to_vec(),
            ingress_expiry_ns: expiry(),
            nonce: None,
        },
    );
    let response = http.submit(&ledger.to_text(), "query", &envelope)?;
    assert_eq!(response.status, 200, "{method}: status {}, body {}", response.status, response.body_preview(200));
    match decode_query_response(&response.body)? {
        QueryOutcome::Replied(arg) => Ok(arg),
        QueryOutcome::Rejected { reject_code, reject_message, error_code } => {
            Err(format!("{method} rejected: {reject_code} {reject_message} {error_code:?}").into())
        }
    }
}

#[test]
fn mainnet_dusd_fee_and_decimals() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = dpay_icp_e2e::IcHttp::new(MAINNET_URL)?;
    let dusd = Principal::from_text(DUSD_LEDGER)?;

    // fee replies as a bare `nat` (`DIDL 00 01 7d …`), decimals as a bare `nat8`
    // (`DIDL 00 01 7b …`) — the rail's integer-family decoder handles both.
    let fee = u64::try_from(decode_int(&query(&http, &dusd, "icrc1_fee", NO_ARGS)?)?)?;
    assert!(fee < 1_000_000, "DUSD fee sanity: {fee} >= 10^6 base units");
    let decimals = u64::try_from(decode_int(&query(&http, &dusd, "icrc1_decimals", NO_ARGS)?)?)?;
    assert_eq!(decimals, 2, "DUSD decimals (live-measured: the deployed ledger runs 2)");
    println!("PASS: mainnet DUSD ledger icp-api.io — fee = {fee}, decimals = {decimals}");
    Ok(())
}

#[test]
fn mainnet_ckbtc_decimals() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = dpay_icp_e2e::IcHttp::new(MAINNET_URL)?;
    let ckbtc = Principal::from_text(CKBTC_LEDGER)?;
    let decimals = u64::try_from(decode_int(&query(&http, &ckbtc, "icrc1_decimals", NO_ARGS)?)?)?;
    assert_eq!(decimals, 8, "ckBTC decimals");
    println!("PASS: mainnet ckBTC ledger (DFINITY-operated) icrc1_decimals = {decimals}");
    Ok(())
}

#[test]
fn mainnet_bad_signature_is_4xx() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = dpay_icp_e2e::IcHttp::new(MAINNET_URL)?;
    let dusd = Principal::from_text(DUSD_LEDGER)?;
    let key = dev_key(&dpay_icp_e2e::PROBE_SEED);
    let request = CallRequest {
        canister: dusd.clone(),
        method_name: "icrc1_symbol".to_string(),
        arg: NO_ARGS.to_vec(),
        ingress_expiry_ns: expiry(),
        nonce: None,
    };
    let tampered = corrupt_sender_sig(&sign_query(&key, &request))?;
    let response = http.submit(&dusd.to_text(), "query", &tampered)?;
    assert!(
        (400..500).contains(&response.status),
        "bad-signature mainnet query must be 4xx, got {} : {}",
        response.status,
        response.body_preview(200)
    );
    println!("PASS: mainnet bad-signature control rejected with {}", response.status);
    Ok(())
}

// A distinct key must ALSO work (proves the throwaway-key path generalizes, not just one seed):
// same read-only query signed by an unreferenced-elsewhere key still gets 200 + threshold reply.
#[test]
fn mainnet_second_throwaway_key_also_works() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = dpay_icp_e2e::IcHttp::new(MAINNET_URL)?;
    let dusd = Principal::from_text(DUSD_LEDGER)?;
    let key = dev_key(&[0x5a; 32]); // a different throwaway — never funded, queries need no balance
    let request = CallRequest {
        canister: dusd.clone(),
        method_name: "icrc1_name".to_string(),
        arg: NO_ARGS.to_vec(),
        ingress_expiry_ns: expiry(),
        nonce: None,
    };
    let envelope = sign_query(&key, &request);
    let response = http.submit(&dusd.to_text(), "query", &envelope)?;
    assert_eq!(response.status, 200, "second-key query: status {}", response.status);
    match decode_query_response(&response.body)? {
        QueryOutcome::Replied(arg) => println!("PASS: second throwaway key accepted ({} reply bytes)", arg.len()),
        QueryOutcome::Rejected { reject_code, reject_message, error_code } => {
            panic!("second-key query rejected: {reject_code} {reject_message} {error_code:?}")
        }
    }
    Ok(())
}

/// ckETH minter `eip_1559_transaction_price` arg behaviour (2026-08-20 launch check):
/// the app's WithdrawSheet passes the ckETH AMOUNT ledger for native-ETH withdrawals while the
/// facade-era kernel passed `None`. This probe MEASURES what the live minter does with each arg
/// (read-only query, throwaway key, never an update):
///
/// * `None` → the native-ETH price path (a plain ETH send, 21k gas) — MUST reply.
/// * `Some(ckUSDC ledger)` → a registered ckERC20 (60k-ish gas) — MUST reply; proves the arg
///   encoding is right and `Some` is the ERC-20 path.
/// * `Some(ckETH AMOUNT ledger)` → what the app sends for native today. Informational: printed,
///   not asserted — the minter either tolerates it (app path works, semantically impure) or
///   rejects it (app's native path is broken against prod → rail.ts must send the None arg).
#[test]
fn mainnet_cketh_minter_eip1559_price_args() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = dpay_icp_e2e::IcHttp::new(MAINNET_URL)?;
    let minter = Principal::from_text(CKETH_MINTER)?;
    let cketh_amount_ledger = CandidPrincipal::from_text(CKETH_LEDGER)?;
    let ckusdc_ledger = CandidPrincipal::from_text(CKUSDC_LEDGER)?;

    // Reference DIDL encodings straight from the candid crate (the .did shape the minter serves).
    let none_arg = Encode!(&Option::<Eip1559Arg>::None)?;
    let some_ckusdc = Encode!(&Some(Eip1559Arg { ckerc20_ledger_id: ckusdc_ledger }))?;
    let some_cketh = Encode!(&Some(Eip1559Arg { ckerc20_ledger_id: cketh_amount_ledger }))?;

    // 1. None — the native-ETH path (what the facade-era kernel sent; semantically correct for a
    //    plain ETH send: there IS no ckERC20 whose transfer needs gas).
    let none_price = decode_eip1559_price(&query(&http, &minter, "eip_1559_transaction_price", &none_arg)?)?;
    assert!(none_price.gas_limit >= 21_000, "None price gas_limit {} < 21k", none_price.gas_limit);
    println!(
        "PASS: ckETH minter eip_1559_transaction_price(None) → gas_limit {}, max_transaction_fee {}",
        none_price.gas_limit, none_price.max_transaction_fee
    );

    // 2. Some(registered ckERC20 ledger) — the ERC-20 path; gas_limit must be ≥ None's
    //    (an ERC-20 transfer costs more than a plain ETH send).
    let erc20_price = decode_eip1559_price(&query(&http, &minter, "eip_1559_transaction_price", &some_ckusdc)?)?;
    assert!(
        erc20_price.gas_limit >= none_price.gas_limit,
        "Some(ckUSDC) gas_limit {} < None gas_limit {} — arg dispatch inverted?",
        erc20_price.gas_limit, none_price.gas_limit
    );
    println!(
        "PASS: ckETH minter eip_1559_transaction_price(Some(ckUSDC)) → gas_limit {}, max_transaction_fee {}",
        erc20_price.gas_limit, erc20_price.max_transaction_fee
    );

    // 3. Some(ckETH AMOUNT ledger) — what the app's native path sends today. MEASURED, not
    //    asserted: either outcome is a stable minter behaviour; the app-side decision (send None
    //    for native) keys off this measurement, documented in OPEN_ISSUES.md.
    match query(&http, &minter, "eip_1559_transaction_price", &some_cketh) {
        Ok(reply) => {
            let price = decode_eip1559_price(&reply)?;
            println!(
                "MEASURED: ckETH minter TOLERATES Some(ckETH amount ledger) for native → gas_limit {}, max_transaction_fee {}",
                price.gas_limit, price.max_transaction_fee
            );
        }
        Err(e) => {
            println!("MEASURED: ckETH minter REJECTS Some(ckETH amount ledger) for native → {e}");
        }
    }
    Ok(())
}
