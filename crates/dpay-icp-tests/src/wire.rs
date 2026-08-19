//! The ONLY file that touches dpay-icp — if the concurrent dpay-icp implementation reshapes,
//! it lands here, not in the tests. Everything the harness needs from the rail core:
//! principal derivation, envelope signing, ICRC arg codecs, and the rail's fee constant.

use candid::Principal as CandidPrincipal;
use dpay_icp::{self, Account, CallRequest, RidValue};
use ed25519_dalek::SigningKey;

/// Re-exported so tests/harness address rail principals through `wire` only.
pub use dpay_icp::Principal;
pub use dpay_icp::icrc::{ApproveResult, TransferError, TransferResult};

/// The ledger transfer fee installed by the harness env (see `Env::ledger_only`). Asserted
/// against the live ledger's own `icrc1_fee` in `user_transfer_via_signed_envelope`.
pub const LEDGER_FEE: u64 = 10_000;

pub fn now_ns() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64
}

/// `ingress_expiry` this many seconds out (the replica accepts [now, now+5m30s]; 240s stays
/// comfortably inside while leaving slack for slow test machines).
pub fn expiry_ahead(secs: u64) -> u64 {
    dpay_icp::ingress_expiry(now_ns(), secs)
}

/// The self-authenticating principal of a raw ed25519 device key (DER-wrapped per the IC spec).
pub fn principal_of(sk: &SigningKey) -> Principal {
    Principal::self_authenticating_ed25519(&sk.verifying_key().to_bytes())
}

/// dpay-icp principal → candid principal (the harness env talks PocketIC/candid; the rail
/// talks dpay-icp).
pub fn to_candid(p: &Principal) -> CandidPrincipal {
    CandidPrincipal::from_slice(p.as_slice())
}

/// An ICRC-1 account on `owner`'s default (all-zero) subaccount.
pub fn account(owner: &Principal) -> Account {
    Account::new(owner.clone())
}

// ---- envelope construction ------------------------------------------------------------------------

/// Sign an update call as `sk`; returns (envelope bytes, request_id).
pub fn sign_update_envelope(
    sk: &SigningKey,
    canister: &Principal,
    method: &str,
    arg: &[u8],
    expiry: u64,
) -> (Vec<u8>, [u8; 32]) {
    let req = CallRequest {
        canister: canister.clone(),
        method_name: method.into(),
        arg: arg.to_vec(),
        ingress_expiry_ns: expiry,
        nonce: None,
    };
    // Same field set dpay-icp hashes internally (envelope.rs call_content); order is irrelevant
    // (request_id sorts by name hash). Needed here because the gateway's IC-Request-Id response
    // header is empty, so the poll path is keyed on the locally computed id.
    let rid = dpay_icp::request_id(&[
        ("request_type", RidValue::Str("call".into())),
        ("ingress_expiry", RidValue::U64(req.ingress_expiry_ns)),
        ("sender", RidValue::Bytes(principal_of(sk).as_slice().to_vec())),
        ("canister_id", RidValue::Bytes(req.canister.as_slice().to_vec())),
        ("method_name", RidValue::Str(req.method_name.clone())),
        ("arg", RidValue::Bytes(req.arg.clone())),
    ]);
    (dpay_icp::sign_update(sk, &req), rid)
}

/// A signed read_state envelope for the request_status path of `rid`. The reference
/// `ReadState` content map carries no canister_id field — the request is scoped by
/// sender + paths alone.
pub fn read_state_envelope(sk: &SigningKey, rid: &[u8; 32]) -> Vec<u8> {
    dpay_icp::sign_read_state(
        sk,
        &[&[b"request_status".as_slice(), rid.as_slice()]],
        expiry_ahead(240),
    )
}

/// A signed query envelope for `method` on `canister`.
pub fn sign_query(sk: &SigningKey, canister: &Principal, method: &str, arg: &[u8], expiry: u64) -> Vec<u8> {
    dpay_icp::sign_query(
        sk,
        &CallRequest {
            canister: canister.clone(),
            method_name: method.into(),
            arg: arg.to_vec(),
            ingress_expiry_ns: expiry,
            nonce: None,
        },
    )
}

// ---- ICRC arg/result codecs (dpay-icp::icrc) ------------------------------------------------------

/// `icrc1_transfer` from the DEFAULT subaccount, explicit fee, no memo/timestamps.
pub fn transfer_arg(to: &Account, amount: u64, fee: u64) -> Vec<u8> {
    dpay_icp::icrc::transfer_arg(to, None, amount as u128, Some(fee as u128), None, None)
}

/// `icrc2_approve` from the DEFAULT subaccount, explicit fee.
pub fn approve_arg(spender: &Account, amount: u64, fee: u64) -> Vec<u8> {
    dpay_icp::icrc::approve_arg(None, spender, Some(amount as u128), None, None, None, None, Some(fee as u128))
}

pub fn balance_of_arg(owner: &Account) -> Vec<u8> {
    dpay_icp::icrc::balance_of_arg(owner)
}

pub fn allowance_arg(from: &Account, spender: &Account) -> Vec<u8> {
    dpay_icp::icrc::allowance_arg(from, spender)
}

// ---- ICRC reply decoders (dpay-icp::icrc — the RAIL decode path) ----------------------------------
// The rail decoders accept the REAL ledger reply shape (bare `variant{Ok;Err}`, Ok carrying
// the BlockIndex nat), pinned by live-captured fixtures in dpay-icp's own goldens. No
// candid fallback: candid remains in this crate for harness-side ARG BUILDING only.

/// `icrc1_transfer` reply → Ok(block index), decoded by the rail.
pub fn decode_transfer_u64(didl: &[u8]) -> Result<u64, String> {
    match dpay_icp::icrc::decode_transfer_result(didl) {
        Ok(TransferResult::Ok(idx)) => Ok(idx),
        Ok(TransferResult::Err(e)) => Err(format!("{e:?}")),
        Err(e) => Err(e.to_string()),
    }
}

/// `icrc2_approve` reply → Ok(block index) — `ApproveResult::Ok` carries the BlockIndex nat
/// (ledger.did:42) — decoded by the rail.
pub fn decode_approve(didl: &[u8]) -> Result<u64, String> {
    match dpay_icp::icrc::decode_approve_result(didl) {
        Ok(ApproveResult::Ok(idx)) => Ok(idx),
        Ok(ApproveResult::Err(e)) => Err(format!("{e:?}")),
        Err(e) => Err(e.to_string()),
    }
}

/// single-arg integer reply (balance / fee / decimals class, any integer prim) → u64,
/// decoded by the rail.
pub fn decode_int_u64(didl: &[u8]) -> u64 {
    let v = dpay_icp::icrc::decode_int(didl).unwrap_or_else(|e| panic!("integer reply decode: {e}"));
    u64::try_from(v).unwrap_or_else(|_| panic!("integer reply {v} exceeds u64"))
}
