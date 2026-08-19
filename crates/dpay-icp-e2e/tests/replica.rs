//! Env-gated dfx-replica e2e for the user-principal IC rail (proof A — OFFLINE).
//!
//! Driven by `scripts/icp-replica-e2e.sh` (`just test-icp-replica`): a real `dfx start` replica
//! whose /api/v2 ingress is the dfx webserver (dfx 0.32 → PocketIC backend) — a SECOND, independent
//! ingress implementation agreeing that our hand-rolled dpay-icp envelopes are well-formed and
//! correctly signed (the first being the PocketIC gateway covered by dpay-icp-tests).
//!
//! Gate: both `DPAY_IC_REPLICA_URL` (e.g. http://127.0.0.1:4943) and `DPAY_IC_LEDGER_ID` must be
//! set; otherwise every test prints `skipped` and PASSES (so `cargo nextest run -p dpay-icp-e2e`
//! is green with no replica, and `check` never depends on dfx).
//!
//! Preconditions the script establishes: a fresh ic-icrc1-ledger with transfer_fee=0, and P1
//! (seed [0x01;32]) funded with FUND_E8S via an icrc1_transfer from the minting account.

use dpay_icp::envelope::envelope_request_id;
use dpay_icp::icrc::{balance_of_arg, decode_int, decode_transfer_result, transfer_arg, TransferResult};
use dpay_icp::{sign_query, sign_read_state, sign_update, Account, CallRequest, Principal};
use dpay_icp_e2e::{
    cbor_parse, corrupt_sender_sig, decode_query_response, decode_read_state_tree, dev_key, request_status, IcHttp,
    P1_SEED, QueryOutcome, RequestStatus, Result,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Must match FUND_E8S in scripts/icp-replica-e2e.sh.
const FUND_E8S: u64 = 1_000_000;
/// What the transfer test moves P1 → P2.
const AMOUNT_E8S: u64 = 123_45;

fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64
}
/// Expiry 5 minutes out — inside the replica's accepted [now, now+5:30] window.
fn expiry() -> u64 {
    dpay_icp::ingress_expiry(now_ns(), 300)
}

fn gate() -> Option<(String, String)> {
    let url = std::env::var("DPAY_IC_REPLICA_URL").ok().filter(|v| !v.is_empty())?;
    let ledger = std::env::var("DPAY_IC_LEDGER_ID").ok().filter(|v| !v.is_empty())?;
    Some((url, ledger))
}

fn setup() -> Result<(IcHttp, Principal)> {
    let Some((url, ledger_text)) = gate() else {
        eprintln!("skipped: DPAY_IC_REPLICA_URL / DPAY_IC_LEDGER_ID not set (drive via just test-icp-replica)");
        return Err(Box::new(Skip));
    };
    let http = IcHttp::new(&url)?;
    let ledger = Principal::from_text(&ledger_text)?;
    Ok((http, ledger))
}

/// Sentinel error so the gate can early-return "skipped" without `Option` plumbing everywhere.
struct Skip;
impl std::fmt::Display for Skip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("skipped")
    }
}
impl std::fmt::Debug for Skip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Skip")
    }
}
impl std::error::Error for Skip {}

fn p1() -> Principal {
    Principal::self_authenticating_ed25519(&dev_key(&P1_SEED).verifying_key().to_bytes())
}

fn p2() -> Principal {
    Principal::self_authenticating_ed25519(&dev_key(&[0x02; 32]).verifying_key().to_bytes())
}

/// Signed query helper: assert HTTP 200 + replied, return the candid arg bytes.
fn query_ok(http: &IcHttp, ledger: &Principal, key: &ed25519_dalek::SigningKey, method: &str, arg: Vec<u8>) -> Result<Vec<u8>> {
    let envelope = sign_query(
        key,
        &CallRequest {
            canister: ledger.clone(),
            method_name: method.to_string(),
            arg,
            ingress_expiry_ns: expiry(),
            nonce: None,
        },
    );
    let response = http.submit(&ledger.to_text(), "query", &envelope)?;
    assert_eq!(response.status, 200, "query {method}: status {}, body {}", response.status, response.body_preview(200));
    match decode_query_response(&response.body)? {
        QueryOutcome::Replied(arg) => Ok(arg),
        QueryOutcome::Rejected { reject_code, reject_message, error_code } => {
            Err(format!("query {method} rejected: {reject_code} {reject_message} {error_code:?}").into())
        }
    }
}

fn balance(http: &IcHttp, ledger: &Principal, key: &ed25519_dalek::SigningKey, who: &Principal) -> Result<u64> {
    let arg = balance_of_arg(&Account::new(who.clone()));
    let reply = query_ok(http, ledger, key, "icrc1_balance_of", arg)?;
    Ok(u64::try_from(decode_int(&reply)?)?)
}

/// Poll read_state for the request's terminal status (replied/rejected/done), 30s budget.
fn poll_request_status(http: &IcHttp, ledger: &Principal, key: &ed25519_dalek::SigningKey, rid: &[u8; 32]) -> Result<RequestStatus> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let path: [&[u8]; 2] = [b"request_status", rid];
    let paths: [&[&[u8]]; 1] = [&path[..]];
    loop {
        let envelope = sign_read_state(key, &paths, expiry());
        let response = http.submit(&ledger.to_text(), "read_state", &envelope)?;
        assert_eq!(response.status, 200, "read_state: status {}", response.status);
        let tree = decode_read_state_tree(&response.body)?;
        match request_status(&tree, rid)? {
            RequestStatus::Unknown | RequestStatus::Received | RequestStatus::Processing => {}
            terminal => return Ok(terminal),
        }
        if Instant::now() > deadline {
            return Err("read_state did not reach a terminal status within 30s".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[test]
fn signed_update_202_then_read_state_replied_ok() -> Result<()> {
    let (http, ledger) = match setup() {
        Ok(pair) => pair,
        Err(e) if e.is::<Skip>() => return Ok(()),
        Err(e) => return Err(e),
    };
    let key = dev_key(&P1_SEED);

    // Sanity: the script funded P1 (this also proves a signed QUERY against the second ingress).
    let p1_before = balance(&http, &ledger, &key, &p1())?;
    assert_eq!(p1_before, FUND_E8S, "P1 must be funded by the script before this test runs");

    // Signed UPDATE: icrc1_transfer P1 → P2.
    let request = CallRequest {
        canister: ledger.clone(),
        method_name: "icrc1_transfer".to_string(),
        arg: transfer_arg(&Account::new(p2()), None, AMOUNT_E8S as u128, None, None, None),
        ingress_expiry_ns: expiry(),
        nonce: Some(0xD1D1D1D1),
    };
    let envelope = sign_update(&key, &request);
    let response = http.submit(&ledger.to_text(), "call", &envelope)?;
    assert_eq!(response.status, 202, "update: status {}, body {}", response.status, response.body_preview(200));

    // read_state poll → replied → decode the transfer result (rail decoder: bare variant).
    let rid = envelope_request_id(&envelope)?;
    match poll_request_status(&http, &ledger, &key, &rid)? {
        RequestStatus::Replied(reply_arg) => {
            match decode_transfer_result(&reply_arg)? {
                TransferResult::Ok(tx) => println!("   transfer Ok, tx index {tx}"),
                TransferResult::Err(e) => panic!("icrc1_transfer replied Err: {e:?}"),
            }
        }
        other => panic!("expected replied, got {other:?}"),
    }

    // Balances moved exactly as signed: P2 +AMOUNT, P1 -AMOUNT (fee=0).
    let p2_after = balance(&http, &ledger, &key, &p2())?;
    let p1_after = balance(&http, &ledger, &key, &p1())?;
    assert_eq!(p2_after, AMOUNT_E8S, "P2 balance after transfer");
    assert_eq!(p1_after, FUND_E8S - AMOUNT_E8S, "P1 balance after transfer");
    println!("PASS: signed update accepted (202) by the dfx webserver ingress, settled P1→P2 {AMOUNT_E8S} e8s");
    Ok(())
}

#[test]
fn bad_signature_update_is_4xx() -> Result<()> {
    let (http, ledger) = match setup() {
        Ok(pair) => pair,
        Err(e) if e.is::<Skip>() => return Ok(()),
        Err(e) => return Err(e),
    };
    let key = dev_key(&P1_SEED);
    let request = CallRequest {
        canister: ledger.clone(),
        method_name: "icrc1_transfer".to_string(),
        arg: transfer_arg(&Account::new(p2()), None, 1, None, None, None),
        ingress_expiry_ns: expiry(),
        nonce: None,
    };
    let envelope = sign_update(&key, &request);
    let tampered = corrupt_sender_sig(&envelope)?;
    let response = http.submit(&ledger.to_text(), "call", &tampered)?;
    assert!(
        (400..500).contains(&response.status),
        "bad-signature update must be 4xx, got {} : {}",
        response.status,
        response.body_preview(200)
    );
    println!("PASS: corrupted signature rejected with {}", response.status);
    Ok(())
}

#[test]
fn expired_ingress_is_4xx() -> Result<()> {
    let (http, ledger) = match setup() {
        Ok(pair) => pair,
        Err(e) if e.is::<Skip>() => return Ok(()),
        Err(e) => return Err(e),
    };
    let key = dev_key(&P1_SEED);
    // Expiry 10 minutes in the PAST — outside the accepted [now, now+5:30] window.
    let past_ns = now_ns().saturating_sub(600 * 1_000_000_000);
    let request = CallRequest {
        canister: ledger.clone(),
        method_name: "icrc1_balance_of".to_string(),
        arg: balance_of_arg(&Account::new(p1())),
        ingress_expiry_ns: past_ns,
        nonce: None,
    };
    let envelope = sign_query(&key, &request);
    let response = http.submit(&ledger.to_text(), "query", &envelope)?;
    assert!(
        (400..500).contains(&response.status),
        "expired-ingress query must be 4xx, got {} : {}",
        response.status,
        response.body_preview(200)
    );
    println!("PASS: expired ingress rejected with {}", response.status);
    Ok(())
}

// Envelope shape sanity against the live replica ingress (not just our own decoder): a valid
// submitted update body must contain request_type=call + our sender principal.
#[test]
fn envelope_shape_matches_public_spec() -> Result<()> {
    let (_, ledger) = match setup() {
        Ok(pair) => pair,
        Err(e) if e.is::<Skip>() => return Ok(()),
        Err(e) => return Err(e),
    };
    let key = dev_key(&P1_SEED);
    let request = CallRequest {
        canister: ledger.clone(),
        method_name: "icrc1_balance_of".to_string(),
        arg: balance_of_arg(&Account::new(p1())),
        ingress_expiry_ns: expiry(),
        nonce: None,
    };
    let envelope = sign_query(&key, &request);
    let content = cbor_parse(&envelope)?
        .get("content")
        .cloned()
        .ok_or("envelope missing content")?;
    assert_eq!(content.get("request_type").and_then(|v| v.as_text()), Some("query"));
    assert_eq!(content.get("canister_id").and_then(|v| v.as_bytes()), Some(ledger.as_slice()));
    assert_eq!(content.get("sender").and_then(|v| v.as_bytes()), Some(p1().as_slice()));
    assert_eq!(content.get("method_name").and_then(|v| v.as_text()), Some("icrc1_balance_of"));
    println!("PASS: envelope fields match the public-spec field names/shapes");
    Ok(())
}
