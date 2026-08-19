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
//!
//! Without the env gate every test prints `skipped` and passes (offline `check` unaffected).

use dpay_icp::icrc::decode_int;
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
/// Candid encoding of ZERO method arguments: `DIDL` magic + empty type table + no values.
const NO_ARGS: &[u8] = b"DIDL\x00\x00";

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
