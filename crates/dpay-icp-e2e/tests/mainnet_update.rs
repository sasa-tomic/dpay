//! OPT-IN mainnet UPDATE proof for the user-principal IC rail (proof C — state-changing, network).
//!
//! Gates: `DPAY_IC_MAINNET=1` AND `DPAY_IC_MAINNET_UPDATE=1` (set only by
//! `scripts/icp-mainnet-update-probe.sh` / `just ic-mainnet-update-probe`). NEVER wired into
//! `just check`/`just verify`.
//!
//! This converts the last inferred hop into observation: **a user principal's signed UPDATE
//! (POST /api/v2/canister/<id>/call) had never been submitted to mainnet** — queries were proven
//! (tests/mainnet.rs) and the update envelope shares the signing machinery, but that was inference.
//! Here it is observed, against OUR OWN canisters ONLY:
//!
//! * facade `ssqti-wiaaa-aaaab-qhdia-cai` — `faucet` (the documented public on-ramp; play money,
//!   fixed 10_000 DUSD cents, 1h per-account cooldown) and `init_receipt_key` (self-service,
//!   idempotent, moves no value) — the bronze proof.
//! * DUSD ledger `td2nx-oaaaa-aaaab-qhdnq-cai` (play money, fee 0, decimals 2) — a user-principal
//!   `icrc1_transfer` and `icrc2_approve` POST /call with full read_state lifecycle.
//! * NEVER any DFINITY-operated canister (ckBTC/ckUSDC/ckETH ledgers or minters): the ids below
//!   are hard constants with no env override, so this file cannot be pointed elsewhere.
//!
//! Funding ladder outcome (documented, with evidence — read before "just" adding a funding rung):
//! NEITHER `just mint` (rung 1) NOR relay-faucet+pay (rung 2) can fund `Account{owner: P1}`,
//! because every facade funding path lands on a FACADE-OWNED subaccount, not a user principal:
//! `crates/dpay-canister/src/calls.rs:290` `account_of(pk) = Account{owner: canister_self(),
//! subaccount: pk}`; used by `mint` (lib.rs:767-774), `faucet` (lib.rs:834-841), and `pay`'s
//! destination (lib.rs:474 `to_acct = account_of(&to)`). The DUSD minting account owner is the
//! facade (docs/CANISTERS.md) and the facade exposes no public transfer to an arbitrary owner
//! account — so a funded P1→P2 transfer would require a facade code change, which this probe
//! deliberately does not make. Instead, the gold-shaped lifecycle is observed as:
//! (a) the faucet update (real ledger state change at a facade account, replay-deduped),
//! (b) the P1→P2 transfer attempt (ingress-accepted; the ledger's own clean InsufficientFunds
//!     reply is the decoded candid outcome), and
//! (c) the P1 approve (a REAL user-principal `Ok(block_index)` on the ledger if the ledger
//!     accepts a zero-balance approve at fee 0 — observed live, whatever it replies).
//!
//! Without the env gates every test prints `skipped` and passes (offline `check` unaffected).

use dpay_icp::envelope::envelope_request_id;
use dpay_icp::icrc::{
    approve_arg, balance_of_arg, decode_approve_result, decode_int, decode_transfer_result, transfer_arg,
    ApproveResult, TransferError, TransferResult,
};
use dpay_icp::{ingress_expiry, sign_query, sign_update, Account, CallRequest, Principal};
use dpay_icp_e2e::{
    corrupt_sender_sig, decode_query_response, dev_key, IcHttp, QueryOutcome, RequestStatus, Result,
};
use std::time::{SystemTime, UNIX_EPOCH};

const MAINNET_URL: &str = "https://icp-api.io";
/// dpay facade (OURS — updates allowed). Hard constant: no env override, never a DFINITY canister.
const FACADE: &str = "ssqti-wiaaa-aaaab-qhdia-cai";
/// dpay DUSD ICRC-3 ledger (OURS — play money, updates allowed). Hard constant, same rule.
const DUSD_LEDGER: &str = "td2nx-oaaaa-aaaab-qhdnq-cai";
/// Candid encoding of ZERO method arguments: `DIDL` magic + empty type table + no values.
const NO_ARGS: &[u8] = b"DIDL\x00\x00";
/// The facade faucet's fixed mint (FAUCET_AMOUNT in crates/dpay-canister/src/types.rs), DUSD cents.
const FAUCET_CENTS: u64 = 10_000;

/// DEDICATED throwaway seeds for the update probe — deliberately NOT the shared dev keys
/// (`P1_SEED` [0x01;32] is the replica/sim key whose facade subaccount already holds live
/// mainnet balance from prior operator use, which would blur the faucet assertions). A fresh
/// seed's facade subaccount is virgin, so balance assertions are exact.
const U1_SEED: [u8; 32] = [0x2c; 32];
const U2_SEED: [u8; 32] = [0x2d; 32];

fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64
}
/// Expiry 5 minutes out — inside mainnet's accepted ingress window.
fn expiry() -> u64 {
    ingress_expiry(now_ns(), 300)
}

fn gated() -> bool {
    let base = std::env::var("DPAY_IC_MAINNET").map(|v| v == "1").unwrap_or(false);
    let on = base && std::env::var("DPAY_IC_MAINNET_UPDATE").map(|v| v == "1").unwrap_or(false);
    if !on {
        eprintln!(
            "skipped: DPAY_IC_MAINNET/DPAY_IC_MAINNET_UPDATE != 1 (opt-in; run via just ic-mainnet-update-probe)"
        );
    }
    on
}

fn p1() -> Principal {
    Principal::self_authenticating_ed25519(&dev_key(&U1_SEED).verifying_key().to_bytes())
}

fn p2() -> Principal {
    Principal::self_authenticating_ed25519(&dev_key(&U2_SEED).verifying_key().to_bytes())
}

/// `faucet(blob, nat32)` argument bytes: hand-rolled DIDL — `vec nat8` (blob) + `nat32`.
/// Type table: T0 = vec(nat8) (`6d 7b`, same pair as ACCOUNT_PREFIX in dpay-icp/src/icrc.rs).
fn faucet_arg(account_blob: &[u8; 32], currency: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(47);
    out.extend_from_slice(b"DIDL");
    out.push(0x01); // 1 type table entry
    out.push(0x6d); // vec
    out.push(0x7b); //   nat8
    out.push(0x02); // 2 args
    out.push(0x00); // arg0 type: ref T0 (blob)
    out.push(0x79); // arg1 type: prim nat32 (sleb -7)
    out.push(account_blob.len() as u8); // blob length (32 < 128 → single uleb byte)
    out.extend_from_slice(account_blob);
    out.extend_from_slice(&currency.to_le_bytes());
    out
}

/// Signed query helper: assert HTTP 200 + replied → return the candid arg bytes.
fn query_ok(http: &IcHttp, canister: &Principal, method: &str, arg: Vec<u8>) -> Result<Vec<u8>> {
    let key = dev_key(&U1_SEED);
    let envelope = sign_query(
        &key,
        &CallRequest {
            canister: canister.clone(),
            method_name: method.to_string(),
            arg,
            ingress_expiry_ns: expiry(),
            nonce: None,
        },
    );
    let response = http.submit(&canister.to_text(), "query", &envelope)?;
    assert_eq!(response.status, 200, "query {method}: status {}, body {}", response.status, response.body_preview(200));
    match decode_query_response(&response.body)? {
        QueryOutcome::Replied(arg) => Ok(arg),
        QueryOutcome::Rejected { reject_code, reject_message, error_code } => {
            Err(format!("query {method} rejected: {reject_code} {reject_message} {error_code:?}").into())
        }
    }
}

/// DUSD balance of an arbitrary ICRC account, via a signed query from P1.
fn dusd_balance(http: &IcHttp, account: &Account) -> Result<u64> {
    let reply = query_ok(http, &Principal::from_text(DUSD_LEDGER)?, "icrc1_balance_of", balance_of_arg(account))?;
    Ok(u64::try_from(decode_int(&reply)?)?)
}

/// Poll read_state for the request's terminal status — the shared harness tail
/// (`dpay_icp_e2e::poll_request_status`, also used by the ckBTC deposit-address probe).
fn poll_request_status(http: &IcHttp, canister: &Principal, rid: &[u8; 32]) -> Result<RequestStatus> {
    dpay_icp_e2e::poll_request_status(http, &dev_key(&U1_SEED), canister, rid)
}

/// Signed update → assert 202 → return (request_id, envelope bytes).
fn submit_update(http: &IcHttp, canister: &Principal, method: &str, arg: Vec<u8>) -> Result<([u8; 32], Vec<u8>)> {
    let key = dev_key(&U1_SEED);
    let envelope = sign_update(
        &key,
        &CallRequest {
            canister: canister.clone(),
            method_name: method.to_string(),
            arg,
            ingress_expiry_ns: expiry(),
            nonce: None,
        },
    );
    let response = http.submit(&canister.to_text(), "call", &envelope)?;
    assert_eq!(response.status, 202, "update {method}: status {}, body {}", response.status, response.body_preview(200));
    let rid = envelope_request_id(&envelope)?;
    Ok((rid, envelope))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// --- mini DIDL decoder for the facade's `Result<nat64, text>` update replies ---------------------
// The shared rail decoders (dpay-icp/src/icrc.rs) cover the ICRC-1/2 shapes only; the facade's
// `faucet` returns a plain `Result<nat64, text>` candid variant. Observed live on mainnet:
// `DIDL 01 6b 02 <lblOk=bc8a01> 78 <lblErr=c5fed2> 71 01 00 00 <nat64-le>` — one variant type
// (sleb -21), fields sorted by idl_hash (Ok=17724 < Err=3456837), payloads nat64(-8)/text(-15).

#[derive(Debug, PartialEq, Eq)]
enum FacadeResult {
    Ok(u64),
    Err(String),
}

fn uleb(d: &[u8], i: &mut usize) -> Result<u64> {
    let mut v: u64 = 0;
    let mut shift = 0u32;
    loop {
        let b = *d.get(*i).ok_or("truncated uleb")? as u64;
        *i += 1;
        v |= (b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok(v);
        }
        shift += 7;
        if shift >= 64 {
            return Err("uleb overflow".into());
        }
    }
}

/// Single-byte sleb128 (every opcode this reply shape emits fits one byte).
fn sleb8(d: &[u8], i: &mut usize) -> Result<i64> {
    let b = *d.get(*i).ok_or("truncated sleb")?;
    *i += 1;
    if b & 0x80 != 0 {
        return Err("multi-byte sleb in facade reply".into());
    }
    Ok(if b & 0x40 != 0 { i64::from(b) - 0x80 } else { i64::from(b) })
}

/// idl_hash of a field label (same algorithm as dpay-icp/src/icrc.rs — private there).
fn idl_hash(name: &str) -> u32 {
    let mut h: u32 = 0;
    for b in name.as_bytes() {
        h = h.wrapping_mul(223).wrapping_add(u32::from(*b));
    }
    h
}

/// Decode `variant { Ok: nat64|nat; Err: text }` — the facade Result reply shape.
fn decode_result_u64_text(d: &[u8]) -> Result<FacadeResult> {
    const OP_OPT: i64 = -18;
    const OP_VEC: i64 = -19;
    const OP_REC: i64 = -20;
    const OP_VAR: i64 = -21;
    if d.get(..4) != Some(b"DIDL") {
        return Err("missing DIDL magic".into());
    }
    let mut i = 4usize; // past the DIDL magic
    let ntypes = uleb(d, &mut i)?;
    if ntypes > 8 {
        return Err("type table too large".into());
    }
    // Walk the table; record the Ok/Err payload types when the variant shows up. opt/vec carry
    // one child type; rec/variant carry nfields × (label, child); prims carry none.
    let mut ok_ty: Option<i64> = None;
    let mut err_ty: Option<i64> = None;
    for _ in 0..ntypes {
        let op = sleb8(d, &mut i)?;
        let nfields = match op {
            OP_OPT | OP_VEC => 1,
            OP_REC | OP_VAR => {
                let n = uleb(d, &mut i)? as usize;
                if n > 16 {
                    return Err("type table field count out of range".into());
                }
                n
            }
            -24..=-1 => 0,
            _ => return Err("unexpected type-table opcode".into()),
        };
        for _ in 0..nfields {
            // opt/vec carry one child type with no label; rec/variant carry (label, child).
            let l = if matches!(op, OP_REC | OP_VAR) { uleb(d, &mut i)? as u32 } else { 0 };
            let child = sleb8(d, &mut i)?;
            if op == OP_VAR && matches!(l, l if l == idl_hash("Ok") || l == idl_hash("Err")) {
                let slot = if l == idl_hash("Ok") { &mut ok_ty } else { &mut err_ty };
                *slot = Some(child);
            }
        }
    }
    let (Some(ok_ty), Some(err_ty)) = (ok_ty, err_ty) else {
        return Err("reply carries no Ok/Err variant".into());
    };
    let nargs = uleb(d, &mut i)?;
    if nargs != 1 {
        return Err("expected 1 reply arg".into());
    }
    if sleb8(d, &mut i)? != 0 {
        return Err("arg0 must ref the variant at T0".into());
    }
    let idx = uleb(d, &mut i)?;
    let out = match idx {
        0 => {
            let v = match ok_ty {
                -8 => {
                    let s = d.get(i..i + 8).ok_or("truncated nat64")?;
                    i += 8;
                    u64::from_le_bytes(s.try_into().unwrap())
                }
                -3 => uleb(d, &mut i)?,
                t => return Err(format!("unexpected Ok payload type {t}").into()),
            };
            FacadeResult::Ok(v)
        }
        1 => {
            if err_ty != -15 {
                return Err("unexpected Err payload type".into());
            }
            let n = usize::try_from(uleb(d, &mut i)?).map_err(|_| "text length out of range")?;
            let end = i.checked_add(n).ok_or("truncated text")?;
            let s = d.get(i..end).ok_or("truncated text")?;
            i = end;
            FacadeResult::Err(String::from_utf8(s.to_vec())?)
        }
        other => return Err(format!("variant index {other} out of range").into()),
    };
    if i != d.len() {
        return Err("trailing bytes after reply value".into());
    }
    Ok(out)
}

// Captured-golden unit tests (always run, no env/network): the two REAL mainnet facade.faucet
// reply bodies observed 2026-08-18, pinned so both decoder branches stay green offline.
//   mint Ok:      DIDL 01 var{Ok:nat64,Err:text} 01 T0 idx=0 10000_le  (run 1 — the faucet minted)
//   cooldown Err: ... idx=1 "faucet cooldown: try again in ~55 min"   (run 2 — rate-limited)
#[cfg(test)]
mod golden_tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        s.as_bytes()
            .chunks(2)
            .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn decodes_captured_mainnet_faucet_ok_mint_reply() {
        let reply = h("4449444c016b02bc8a0178c5fed201710100001027000000000000");
        assert_eq!(decode_result_u64_text(&reply).unwrap(), FacadeResult::Ok(10_000));
    }

    #[test]
    fn decodes_captured_mainnet_faucet_cooldown_err_reply() {
        let reply = h("4449444c016b02bc8a0178c5fed201710100012566617563657420636f6f6c646f776e3a2074727920616761696e20696e207e3535206d696e");
        assert_eq!(
            decode_result_u64_text(&reply).unwrap(),
            FacadeResult::Err("faucet cooldown: try again in ~55 min".to_string())
        );
    }

    #[test]
    fn hostile_huge_text_length_is_err_not_panic() {
        // Verifier reproducer: the Err branch's text length is the uleb ff×9 + 7f —
        // ~2^70, far past usize. Pre-fix `uleb as usize` + `i + n` add-overflowed
        // (debug-profile panic at `i + n`); with checked bounds the reply must decode
        // to an Err("truncated text")-style rejection, never panic.
        let mut reply = h("4449444c016b02bc8a0178c5fed20171010001");
        reply.extend([0xff; 9]);
        reply.push(0x7f);
        assert!(decode_result_u64_text(&reply).is_err());
    }
}

// Phase-1 control (the runner script executes this FIRST, alone — cheapest possible abort): a
// corrupted-signature UPDATE envelope must be rejected 4xx by the real ingress BEFORE any valid
// update is submitted anywhere. Flips one byte of `sender_sig`; every other field identical.
#[test]
fn bad_signature_update_is_4xx() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = IcHttp::new(MAINNET_URL)?;
    let facade = Principal::from_text(FACADE)?;
    let key = dev_key(&U1_SEED);
    let request = CallRequest {
        canister: facade.clone(),
        method_name: "faucet".to_string(),
        arg: faucet_arg(&dev_key(&U1_SEED).verifying_key().to_bytes(), 0),
        ingress_expiry_ns: expiry(),
        nonce: None,
    };
    let tampered = corrupt_sender_sig(&sign_update(&key, &request))?;
    let response = http.submit(&facade.to_text(), "call", &tampered)?;
    assert!(
        (400..500).contains(&response.status),
        "bad-signature mainnet UPDATE must be 4xx, got {} : {}",
        response.status,
        response.body_preview(200)
    );
    println!("PASS: bad-signature UPDATE control rejected with {} (body: {:?})", response.status, response.body_preview(120));
    Ok(())
}

// THE lifecycle proof on the facade: P1 signs an update calling the PUBLIC `faucet` (the
// documented demo on-ramp — fixed 10_000 DUSD cents, rate-limited, play money), then REPLAYS the
// identical envelope bytes and observes executed-once semantics on MAINNET (the PocketIC dedup
// observation, now against the real ingress). The mint lands at
// `Account{owner: facade, subaccount: P1-pubkey}` — a facade-owned subaccount, cross-checked on
// the DUSD ledger by a signed query (see the funding-ladder note in the module docs for why
// `Account{owner: P1}` itself cannot be funded through any existing operator hook).
#[test]
fn facade_faucet_update_full_lifecycle_and_replay() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = IcHttp::new(MAINNET_URL)?;
    let facade = Principal::from_text(FACADE)?;
    let p1_pk = dev_key(&U1_SEED).verifying_key().to_bytes();
    let target = Account { owner: facade.clone(), subaccount: p1_pk };

    let before = dusd_balance(&http, &target)?;
    println!("   facade-subaccount(P1) DUSD balance before: {before} cents");
    assert!(before == 0 || before == FAUCET_CENTS, "fresh throwaway subaccount: expected 0 or a prior probe's {FAUCET_CENTS}, got {before}");

    // Signed UPDATE → 202.
    let (rid, envelope) = submit_update(&http, &facade, "faucet", faucet_arg(&p1_pk, 0))?;
    println!("   POST /call facade.faucet -> 202, request_id {}", hex(&rid));

    // read_state poll → terminal (replied on the first-ever run; a clean CANISTER-LEVEL rejection
    // with "faucet cooldown" on a re-run within the hour — BOTH prove the ingress accepted the
    // user-principal envelope; only the terminal variant differs).
    let first = poll_request_status(&http, &facade, &rid)?;
    let first_outcome = match &first {
        RequestStatus::Replied(arg) => {
            println!("   request_status: replied, reply hex {}", hex(arg));
            match decode_result_u64_text(arg)? {
                FacadeResult::Ok(balance) => {
                    println!("   faucet reply (new balance): {balance} cents");
                    assert_eq!(balance, FAUCET_CENTS, "faucet must report exactly {FAUCET_CENTS}");
                    format!("replied:{balance}")
                }
                FacadeResult::Err(msg) => {
                    println!("   faucet reply: Err(\"{msg}\")");
                    assert!(msg.contains("faucet cooldown"), "unexpected faucet error: {msg}");
                    format!("rejected:{msg}")
                }
            }
        }
        other => panic!("facade.faucet: expected replied/rejected, got {other:?}"),
    };

    let after = dusd_balance(&http, &target)?;
    println!("   facade-subaccount(P1) DUSD balance after: {after} cents");
    // Executed-once steady state: the cooldown makes 10_000 the only reachable terminal balance.
    assert_eq!(after, FAUCET_CENTS, "faucet must leave exactly {FAUCET_CENTS} cents at the target");
    if first_outcome.starts_with("replied:") {
        assert_eq!(before, 0, "a fresh Ok mint implies a zero starting balance");
    }

    // REPLAY the IDENTICAL envelope bytes → the ingress must dedup (same request_id → same
    // request_status record, NOT a second execution).
    let response = http.submit(&facade.to_text(), "call", &envelope)?;
    assert_eq!(response.status, 202, "replay POST must also be 202, got {} : {}", response.status, response.body_preview(200));
    let replay = poll_request_status(&http, &facade, &rid)?;
    let replay_outcome = match &replay {
        RequestStatus::Replied(arg) => match decode_result_u64_text(arg)? {
            FacadeResult::Ok(balance) => format!("replied:{balance}"),
            FacadeResult::Err(msg) => {
                assert!(msg.contains("faucet cooldown"), "unexpected replay error: {msg}");
                format!("rejected:{msg}")
            }
        },
        other => panic!("replay: expected replied, got {other:?}"),
    };
    println!("   replay outcome: {replay_outcome} (first: {first_outcome})");
    assert_eq!(replay, first, "replay must return the SAME request_status record (executed once)");
    let after_replay = dusd_balance(&http, &target)?;
    assert_eq!(after_replay, after, "replay must not change balances (executed once)");
    println!("PASS: user-principal UPDATE lifecycle on mainnet facade — 202, {first_outcome}, replay deduped (balance unchanged at {after_replay})");
    Ok(())
}

// The exact gold-spec hop, observed honestly: P1 (user principal, UNFUNDED — see module docs)
// signs `icrc1_transfer` P1→P2 and POSTs /call to the DUSD LEDGER ITSELF on mainnet. The ingress
// accepts the envelope (202) and the ledger replies — with its own clean InsufficientFunds
// variant, decoded by the rail decoder. Balances asserted unmoved via signed queries.
#[test]
fn ledger_transfer_from_unfunded_user_principal() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = IcHttp::new(MAINNET_URL)?;
    let ledger = Principal::from_text(DUSD_LEDGER)?;

    let p1_before = dusd_balance(&http, &Account::new(p1()))?;
    let p2_before = dusd_balance(&http, &Account::new(p2()))?;
    println!("   balances before: P1={p1_before}, P2={p2_before} cents");

    // Live fee first (gold spec): expect 0 for DUSD.
    let fee = u64::try_from(decode_int(&query_ok(&http, &ledger, "icrc1_fee", NO_ARGS.to_vec())?)?)?;
    println!("   live icrc1_fee: {fee}");
    assert_eq!(fee, 0, "DUSD is a zero-fee play-money ledger");

    let (rid, _envelope) = submit_update(
        &http,
        &ledger,
        "icrc1_transfer",
        transfer_arg(&Account::new(p2()), None, 100, None, None, None),
    )?;
    println!("   POST /call td2nx.icrc1_transfer(100 cents P1->P2) -> 202, request_id {}", hex(&rid));

    match poll_request_status(&http, &ledger, &rid)? {
        RequestStatus::Replied(arg) => {
            println!("   request_status: replied, reply hex {}", hex(&arg));
            match decode_transfer_result(&arg)? {
                TransferResult::Err(TransferError::InsufficientFunds { balance }) => {
                    assert_eq!(balance, p1_before as u128, "InsufficientFunds must echo the real balance");
                    println!("   decoded: Err(InsufficientFunds {{ balance: {balance} }}) — the ledger's own clean refusal (P1 is unfunded by design; no operator hook can fund a user principal — see module docs)");
                }
                TransferResult::Ok(tx) => {
                    // Only reachable if some external rung ever funds Account{owner: P1}. Handle
                    // honestly: assert the exact movement instead of failing blind.
                    println!("   decoded: Ok({tx}) — P1 WAS funded; asserting exact movement");
                    let p1_after = dusd_balance(&http, &Account::new(p1()))?;
                    let p2_after = dusd_balance(&http, &Account::new(p2()))?;
                    assert_eq!(p1_after, p1_before - 100 - fee);
                    assert_eq!(p2_after, p2_before + 100);
                }
                other => panic!("unexpected transfer result: {other:?}"),
            }
        }
        other => panic!("icrc1_transfer: expected replied, got {other:?}"),
    }

    let p1_after = dusd_balance(&http, &Account::new(p1()))?;
    let p2_after = dusd_balance(&http, &Account::new(p2()))?;
    assert_eq!((p1_after, p2_after), (p1_before, p2_before), "unfunded transfer must move nothing");
    println!("PASS: user-principal icrc1_transfer POST /call accepted by mainnet DUSD ledger ingress (202 + replied + decoded); balances unmoved ({p1_after}/{p2_after})");
    Ok(())
}

// A REAL user-principal `Ok(block_index)` on the mainnet DUSD ledger, self-contained (no funding
// needed): ICRC-2 `icrc2_approve` from P1 — per ICRC-2 an approve needs only balance >= approve
// fee, NOT the allowance amount — so at fee 0 an unfunded P1 can land a genuine state-changing
// update (a 1-cent allowance for P2, both throwaway keys, play money). Whatever the ledger
// replies, the reply is decoded by the rail decoder and reported.
#[test]
fn ledger_approve_from_user_principal() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = IcHttp::new(MAINNET_URL)?;
    let ledger = Principal::from_text(DUSD_LEDGER)?;

    let (rid, _envelope) = submit_update(
        &http,
        &ledger,
        "icrc2_approve",
        approve_arg(None, &Account::new(p2()), Some(1), None, None, None, None, None),
    )?;
    println!("   POST /call td2nx.icrc2_approve(1 cent P1->P2) -> 202, request_id {}", hex(&rid));

    match poll_request_status(&http, &ledger, &rid)? {
        RequestStatus::Replied(arg) => {
            println!("   request_status: replied, reply hex {}", hex(&arg));
            match decode_approve_result(&arg)? {
                ApproveResult::Ok(tx) => {
                    println!("   decoded: Ok({tx}) — REAL user-principal state-changing update on the mainnet DUSD ledger");
                }
                ApproveResult::Err(e) => {
                    println!("   decoded: Err({e:?}) — documented observation (approve fee/gate differs from transfer fee)");
                }
            }
        }
        other => panic!("icrc2_approve: expected replied, got {other:?}"),
    }
    println!("PASS: user-principal icrc2_approve POST /call accepted by mainnet DUSD ledger ingress (202 + replied + decoded)");
    Ok(())
}

// The bronze proof (run even though the gold-shaped lifecycle above succeeded): a benign PUBLIC
// facade update from a fresh user principal — `init_receipt_key()` is documented self-service,
// idempotent, and moves no value. 202 → read_state → replied proves the full ingress lifecycle
// on the facade canister itself with ZERO funds.
#[test]
fn facade_init_receipt_key_benign_update() -> Result<()> {
    if !gated() {
        return Ok(());
    }
    let http = IcHttp::new(MAINNET_URL)?;
    let facade = Principal::from_text(FACADE)?;

    let (rid, _envelope) = submit_update(&http, &facade, "init_receipt_key", NO_ARGS.to_vec())?;
    println!("   POST /call facade.init_receipt_key -> 202, request_id {}", hex(&rid));

    match poll_request_status(&http, &facade, &rid)? {
        RequestStatus::Replied(arg) => {
            println!("   request_status: replied, reply hex {}", hex(&arg));
        }
        RequestStatus::Rejected { reject_code, reject_message, error_code } => {
            // A CLEAN canister-level rejection still proves INGRESS accepted our envelope
            // (the request was executed and the canister answered) — document which.
            println!("   request_status: clean canister-level rejection {reject_code} {reject_message} {error_code:?} (ingress accepted + executed; the canister refused)");
        }
        other => panic!("init_receipt_key: expected replied/rejected, got {other:?}"),
    }
    println!("PASS: bronze — benign user-principal UPDATE on the mainnet facade, full 202 → read_state → terminal lifecycle");
    Ok(())
}
