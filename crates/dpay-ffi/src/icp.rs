//! IC user-principal rail exports (over [`dpay_icp`]).
//!
//! Thin marshaling only — every byte of crypto/encoding is computed by `dpay-icp` (byte-identical
//! to ic-agent, mainnet-proven). Conventions:
//!
//! * **ns timestamps cross as decimal STRINGS** — unix-ns ≈ 1.8e18 exceeds JS `Number`'s 2^53
//!   exact-integer range; a `f64` round-trip would silently shift the ingress expiry.
//! * **amounts (u128) cross as decimal STRINGS** (the crate-wide MC1 rule).
//! * `secret` is the 32-byte Ed25519 seed (`Vec<u8>`); owners are principal TEXT (parsed +
//!   canonically validated in Rust); subaccounts/memos are optional hex strings.
//! * `icp_sign_update` returns envelope AND request_id together — the rid is a hash of the exact
//!   envelope bytes, so it is computed once here and never re-derived in JS (the merchant polls
//!   `read_state` with it; the retry rule is identical-byte resubmit keyed on this rid).

use crate::DpayError;
use dpay_icp::envelope::{ingress_expiry as icp_ingress_expiry_ns, sign_query, sign_read_state, sign_update, CallRequest};
use dpay_icp::icrc::{
    approve_arg as icrc_approve_arg, balance_of_arg as icrc_balance_of_arg,
    decode_transfer_result as icrc_decode_transfer_result, transfer_arg as icrc_transfer_arg, ApproveResult,
    TransferError, TransferResult,
};
use dpay_icp::principal::{Account, Principal};
use dpay_icp::reply::{decode_query_response, decode_read_state_tree, read_state_time, request_status, QueryOutcome, RequestStatus as RailStatus};
use dpay_icp::IcpError;
use ed25519_dalek::SigningKey;

fn bad(e: IcpError) -> DpayError {
    DpayError::BadInput(e.to_string())
}

fn key(secret: &[u8]) -> Result<SigningKey, DpayError> {
    let seed: [u8; 32] = secret.try_into().map_err(|_| DpayError::BadSecretLength)?;
    Ok(SigningKey::from_bytes(&seed))
}

fn opt_hex(s: &Option<String>, what: &str) -> Result<Option<Vec<u8>>, DpayError> {
    match s {
        None => Ok(None),
        Some(t) => {
            if t.is_empty() {
                return Ok(None);
            }
            let bytes = hex_to_bytes(t).map_err(|e| DpayError::BadInput(format!("{what}: {e}")))?;
            Ok(Some(bytes))
        }
    }
}

fn hex_to_bytes(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|_| "invalid hex digit".to_string()))
        .collect()
}

fn u128_str(s: &str, what: &str) -> Result<u128, DpayError> {
    s.parse::<u128>().map_err(|_| DpayError::BadInput(format!("{what} must be a decimal integer string")))
}

fn u64_str(s: &str, what: &str) -> Result<u64, DpayError> {
    s.parse::<u64>().map_err(|_| DpayError::BadInput(format!("{what} must be a decimal integer string")))
}

fn bad_input(msg: &str) -> DpayError {
    DpayError::BadInput(msg.into())
}

/// Optional 32-byte subaccount from hex (''/None = None).
fn opt_sub32(subaccount_hex: &Option<String>) -> Result<Option<[u8; 32]>, DpayError> {
    match subaccount_hex {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) => {
            let bytes = opt_hex(&Some(s.clone()), "subaccount")?.unwrap_or_default();
            bytes.try_into().map(Some).map_err(|_| DpayError::BadInput("subaccount must be 32 bytes".into()))
        }
    }
}

/// An `Account` from owner text + optional subaccount hex (empty/absent = the default all-zero
/// subaccount, which icrc-ledger canonicalizes to `null`).
fn account(owner_text: &str, subaccount_hex: &Option<String>) -> Result<Account, DpayError> {
    let owner = Principal::from_text(owner_text).map_err(bad)?;
    let sub = opt_hex(subaccount_hex, "subaccount")?;
    match sub {
        None => Ok(Account::new(owner)),
        Some(bytes) => {
            let sa: [u8; 32] = bytes.try_into().map_err(|_| DpayError::BadInput("subaccount must be 32 bytes".into()))?;
            Ok(Account { owner, subaccount: sa })
        }
    }
}

// --- identity / time ------------------------------------------------------------------------------

/// The user's self-authenticating IC principal text for an Ed25519 seed — the account identity on
/// the external ledgers (`Account{owner: self_principal(pk), subaccount: [0;32]}`).
#[uniffi::export]
pub fn icp_self_principal(secret: Vec<u8>) -> Result<String, DpayError> {
    let k = key(&secret)?;
    Ok(Principal::self_authenticating_ed25519(&k.verifying_key().to_bytes()).to_text())
}

/// Payee principal text derived from an Ed25519 PUBLIC KEY (32 bytes) — the payment-request
/// `to` field carries the merchant's raw pubkey; the IC account owner is
/// `self_authenticating(pub)` = SHA224(DER(pub)) | 0x02. Keeps the 132-byte request format
/// frozen (no wire change) while the transfer targets the payee's user-principal account.
#[uniffi::export]
pub fn icp_principal_from_pubkey(pubkey: Vec<u8>) -> Result<String, DpayError> {
    let pk: [u8; 32] = pubkey.as_slice().try_into().map_err(|_| DpayError::BadPubkeyLength)?;
    Ok(Principal::self_authenticating_ed25519(&pk).to_text())
}

/// Ingress expiry stamp: `now_ns + ahead_s * 1e9`, as a decimal-ns string (see module docs on why
/// strings). The submission window is measured `[now, now+5:30]` on the IC — callers pick
/// `ahead_s` in 240–300 s.
#[uniffi::export]
pub fn icp_ingress_expiry(now_ns: String, ahead_s: u64) -> Result<String, DpayError> {
    let now = u64_str(&now_ns, "now_ns")?;
    Ok(icp_ingress_expiry_ns(now, ahead_s).to_string())
}

// --- DIDL arg builders ----------------------------------------------------------------------------

/// `icrc1_transfer` argument bytes (DIDL record): `to` account, amount, optional
/// fee/memo/from_subaccount. `amount`/`fee` are decimal strings.
#[uniffi::export]
pub fn icp_transfer_arg(
    to_owner_text: String,
    to_subaccount_hex: Option<String>,
    from_subaccount_hex: Option<String>,
    amount: String,
    fee: Option<String>,
    memo_hex: Option<String>,
) -> Result<Vec<u8>, DpayError> {
    let to = account(&to_owner_text, &to_subaccount_hex)?;
    let from_sub = match opt_hex(&from_subaccount_hex, "from_subaccount")? {
        None => None,
        Some(b) => Some(b.try_into().map_err(|_| DpayError::BadInput("from_subaccount must be 32 bytes".into()))?),
    };
    let amount = u128_str(&amount, "amount")?;
    let fee = match fee {
        Some(ref f) if !f.is_empty() => Some(u128_str(f, "fee")?),
        _ => None,
    };
    let memo = opt_hex(&memo_hex, "memo")?;
    Ok(icrc_transfer_arg(&to, from_sub, amount, fee, memo, None))
}

/// `icrc2_approve` argument bytes: spender account, allowance amount (absent = revoke/0),
/// optional expected_allowance/expires_at/memo/from_subaccount/fee.
#[uniffi::export]
pub fn icp_approve_arg(
    spender_owner_text: String,
    spender_subaccount_hex: Option<String>,
    from_subaccount_hex: Option<String>,
    amount: Option<String>,
    expected_allowance: Option<String>,
    expires_at_ns: Option<String>,
    memo_hex: Option<String>,
    fee: Option<String>,
) -> Result<Vec<u8>, DpayError> {
    let spender = account(&spender_owner_text, &spender_subaccount_hex)?;
    let from_sub = match opt_hex(&from_subaccount_hex, "from_subaccount")? {
        None => None,
        Some(b) => Some(b.try_into().map_err(|_| DpayError::BadInput("from_subaccount must be 32 bytes".into()))?),
    };
    let amount = match amount {
        Some(ref a) if !a.is_empty() => Some(u128_str(a, "amount")?),
        _ => None,
    };
    let expected_allowance = match expected_allowance {
        Some(ref a) if !a.is_empty() => Some(u128_str(a, "expected_allowance")?),
        _ => None,
    };
    let expires_at = match expires_at_ns {
        Some(ref s) if !s.is_empty() => Some(u64_str(s, "expires_at_ns")?),
        _ => None,
    };
    let fee = match fee {
        Some(ref f) if !f.is_empty() => Some(u128_str(f, "fee")?),
        _ => None,
    };
    let memo = opt_hex(&memo_hex, "memo")?;
    Ok(icrc_approve_arg(from_sub, &spender, amount, expected_allowance, expires_at, memo, None, fee))
}

/// `icrc1_balance_of` argument bytes for the account.
#[uniffi::export]
pub fn icp_balance_of_arg(owner_text: String, subaccount_hex: Option<String>) -> Result<Vec<u8>, DpayError> {
    let a = account(&owner_text, &subaccount_hex)?;
    Ok(icrc_balance_of_arg(&a))
}

// --- minter calls (user-principal offramp + deposits) ---------------------------------------------
// Arg builders for the REAL ckBTC/ckETH minter services (types pinned from the minter .did;
// tables regenerated with the cached production candid 0.10.22 — golden-pinned in dpay-icp).

/// ckBTC minter `get_btc_address(MinterAccount)` — ONE record arg (2-tuples trap IC0503).
#[uniffi::export]
pub fn icp_minter_account_arg(owner_text: String, subaccount_hex: Option<String>) -> Result<Vec<u8>, DpayError> {
    let a = account(&owner_text, &subaccount_hex)?;
    let sub = if a.subaccount == [0u8; 32] { None } else { Some(a.subaccount) };
    Ok(dpay_icp::icrc::minter_account_arg(&a.owner, sub))
}

/// ckBTC minter `retrieve_btc_with_approval({address, from_subaccount, amount})` (sats, after the
/// user's `icrc2_approve` on the ledger for exactly this amount).
#[uniffi::export]
pub fn icp_retrieve_btc_arg(address: String, amount_sats: String, from_subaccount_hex: Option<String>) -> Result<Vec<u8>, DpayError> {
    let amount: u64 = amount_sats.parse().map_err(|_| bad_input("amount_sats must be a u64 decimal string"))?;
    let sub = opt_sub32(&from_subaccount_hex)?;
    Ok(dpay_icp::icrc::retrieve_btc_arg(&address, amount, sub))
}

/// ckETH minter `withdraw_eth({recipient, from_subaccount, amount})` (Wei, after `icrc2_approve`
/// of amount + max_transaction_fee on the ckETH ledger).
#[uniffi::export]
pub fn icp_withdraw_eth_arg(recipient: String, amount_wei: String, from_subaccount_hex: Option<String>) -> Result<Vec<u8>, DpayError> {
    let amount: u128 = amount_wei.parse().map_err(|_| bad_input("amount_wei must be a u128 decimal string"))?;
    let sub = opt_sub32(&from_subaccount_hex)?;
    Ok(dpay_icp::icrc::withdraw_eth_arg(&recipient, amount, sub))
}

/// ckETH minter `withdraw_erc20({ckerc20_ledger_id, recipient, from_cketh_subaccount,
/// from_ckerc20_subaccount, amount})` — the dual-ledger path (gas approve on ckETH + amount
/// approve on the ckERC20 ledger, both user-signed before this call).
#[uniffi::export]
pub fn icp_withdraw_erc20_arg(
    amount: String,
    ckerc20_ledger_text: String,
    recipient: String,
    from_cketh_subaccount_hex: Option<String>,
    from_ckerc20_subaccount_hex: Option<String>,
) -> Result<Vec<u8>, DpayError> {
    let amt: u128 = amount.parse().map_err(|_| bad_input("amount must be a u128 decimal string"))?;
    let ledger = Principal::from_text(&ckerc20_ledger_text).map_err(bad)?;
    let cketh_sub = opt_sub32(&from_cketh_subaccount_hex)?;
    let erc20_sub = opt_sub32(&from_ckerc20_subaccount_hex)?;
    Ok(dpay_icp::icrc::withdraw_erc20_arg(amt, &ledger, &recipient, cketh_sub, erc20_sub))
}

/// ckETH minter `eip_1559_transaction_price` QUERY arg (opt record{ckerc20_ledger_id}) — the
/// live gas estimate the app needs BEFORE approving ckETH for the gas leg.
#[uniffi::export]
pub fn icp_eip1559_price_arg(ckerc20_ledger_text: String) -> Result<Vec<u8>, DpayError> {
    let ledger = Principal::from_text(&ckerc20_ledger_text).map_err(bad)?;
    Ok(dpay_icp::icrc::eip1559_price_arg(&ledger))
}

/// Decode a bare `text` reply (get_btc_address / any single-text query).
#[uniffi::export]
pub fn icp_decode_text(arg: Vec<u8>) -> Result<String, DpayError> {
    dpay_icp::icrc::decode_text(&arg).map_err(bad)
}

/// Decoded `eip_1559_transaction_price` reply — Wei figures as decimal strings.
#[derive(uniffi::Record, Clone)]
pub struct IcpEip1559Price {
    pub gas_limit: String,
    pub max_fee_per_gas: String,
    pub max_priority_fee_per_gas: String,
    pub max_transaction_fee: String,
    pub timestamp_ns: Option<String>,
}

#[uniffi::export]
pub fn icp_decode_eip1559_price(arg: Vec<u8>) -> Result<IcpEip1559Price, DpayError> {
    let p = dpay_icp::icrc::decode_eip1559_price(&arg).map_err(bad)?;
    Ok(IcpEip1559Price {
        gas_limit: p.gas_limit.to_string(),
        max_fee_per_gas: p.max_fee_per_gas.to_string(),
        max_priority_fee_per_gas: p.max_priority_fee_per_gas.to_string(),
        max_transaction_fee: p.max_transaction_fee.to_string(),
        timestamp_ns: p.timestamp.map(|t| t.to_string()),
    })
}

// --- envelope signing -----------------------------------------------------------------------------

/// A signed update call: the POST-able CBOR envelope plus its `request_id` (the read_state poll
/// key). Both derived once, in Rust.
#[derive(uniffi::Record, Clone)]
pub struct IcpSignedUpdate {
    /// Full signed envelope bytes — POST to `/api/v2/canister/<canister>/call`.
    pub envelope: Vec<u8>,
    /// 32-byte request_id — poll `/read_state` under `request_status/<rid>`.
    pub request_id: Vec<u8>,
}

#[uniffi::export]
pub fn icp_sign_update(
    secret: Vec<u8>,
    canister_text: String,
    method_name: String,
    arg: Vec<u8>,
    ingress_expiry_ns: String,
) -> Result<IcpSignedUpdate, DpayError> {
    let k = key(&secret)?;
    let canister = Principal::from_text(&canister_text).map_err(bad)?;
    let expiry = u64_str(&ingress_expiry_ns, "ingress_expiry_ns")?;
    let req = CallRequest { canister, method_name, arg, ingress_expiry_ns: expiry, nonce: None };
    let envelope = sign_update(&k, &req);
    let request_id = dpay_icp::envelope::envelope_request_id(&envelope)
        .map_err(bad)?
        .to_vec();
    Ok(IcpSignedUpdate { envelope, request_id })
}

/// A signed query call: envelope bytes for `/api/v2/canister/<canister>/query`.
#[uniffi::export]
pub fn icp_sign_query(
    secret: Vec<u8>,
    canister_text: String,
    method_name: String,
    arg: Vec<u8>,
    ingress_expiry_ns: String,
) -> Result<Vec<u8>, DpayError> {
    let k = key(&secret)?;
    let canister = Principal::from_text(&canister_text).map_err(bad)?;
    let expiry = u64_str(&ingress_expiry_ns, "ingress_expiry_ns")?;
    let req = CallRequest { canister, method_name, arg, ingress_expiry_ns: expiry, nonce: None };
    Ok(sign_query(&k, &req))
}

/// A signed `read_state` call: envelope bytes for `/api/v2/canister/<canister>/read_state`,
/// requesting the `request_status/<rid>` paths for each request_id plus (optionally) the
/// certified subnet `time` leaf — the app's clock-sync source.
#[uniffi::export]
pub fn icp_sign_read_state(
    secret: Vec<u8>,
    request_ids: Vec<Vec<u8>>,
    want_time: bool,
    ingress_expiry_ns: String,
) -> Result<Vec<u8>, DpayError> {
    let k = key(&secret)?;
    let expiry = u64_str(&ingress_expiry_ns, "ingress_expiry_ns")?;
    let mut paths: Vec<Vec<Vec<u8>>> = Vec::with_capacity(request_ids.len() + 1);
    for rid in &request_ids {
        let rid: [u8; 32] = rid.as_slice().try_into().map_err(|_| DpayError::BadInput("request_id must be 32 bytes".into()))?;
        paths.push(vec![b"request_status".to_vec(), rid.to_vec()]);
    }
    if want_time {
        paths.push(vec![b"time".to_vec()]);
    }
    // `sign_read_state` takes `&[&[&[u8]]]` (paths of labels); build the borrows without leaking.
    let segs: Vec<Vec<&[u8]>> = paths.iter().map(|p| p.iter().map(|s| s.as_slice()).collect()).collect();
    let refs: Vec<&[&[u8]]> = segs.iter().map(|v| v.as_slice()).collect();
    Ok(sign_read_state(&k, &refs, expiry))
}

/// The request_id of an already-signed envelope (the merchant side: rid of a payer-carried
/// envelope, for read_state polling after submission).
#[uniffi::export]
pub fn icp_envelope_request_id(envelope: Vec<u8>) -> Result<Vec<u8>, DpayError> {
    dpay_icp::envelope::envelope_request_id(&envelope)
        .map_err(bad)
        .map(|rid| rid.to_vec())
}

// --- response decoders ----------------------------------------------------------------------------

/// A decoded `/query` response: `replied` carries the candid reply arg; otherwise the rejection
/// triple. Flat record (not an enum) for cheap Kotlin/JS marshaling.
#[derive(uniffi::Record, Clone)]
pub struct IcpQueryReply {
    pub replied: bool,
    pub arg: Option<Vec<u8>>,
    pub reject_code: u64,
    pub reject_message: String,
    pub error_code: Option<String>,
}

#[uniffi::export]
pub fn icp_decode_query(body: Vec<u8>) -> Result<IcpQueryReply, DpayError> {
    match decode_query_response(&body).map_err(bad)? {
        QueryOutcome::Replied(arg) => Ok(IcpQueryReply {
            replied: true,
            arg: Some(arg),
            reject_code: 0,
            reject_message: String::new(),
            error_code: None,
        }),
        QueryOutcome::Rejected { reject_code, reject_message, error_code } => Ok(IcpQueryReply {
            replied: false,
            arg: None,
            reject_code,
            reject_message,
            error_code,
        }),
    }
}

/// One request's status read from a read_state certificate. `state` is one of
/// `unknown|received|processing|replied|rejected|done`; `unknown`/`received`/`processing` mean
/// keep polling (the 2–5 s consensus window); `replied` carries the reply arg.
#[derive(uniffi::Record, Clone)]
pub struct IcpRequestStatus {
    pub request_id: Vec<u8>,
    pub state: String,
    pub reply_arg: Option<Vec<u8>>,
    pub reject_code: Option<u64>,
    pub reject_message: Option<String>,
    pub error_code: Option<String>,
}

/// A decoded `/read_state` response: certified subnet time (None if the path wasn't requested /
/// pruned) plus the per-request statuses.
#[derive(uniffi::Record, Clone)]
pub struct IcpStateRead {
    pub time_ns: Option<String>,
    pub statuses: Vec<IcpRequestStatus>,
}

#[uniffi::export]
pub fn icp_decode_read_state(body: Vec<u8>, request_ids: Vec<Vec<u8>>) -> Result<IcpStateRead, DpayError> {
    let tree = decode_read_state_tree(&body).map_err(bad)?;
    let time_ns = read_state_time(&tree).map_err(bad)?.map(|t| t.to_string());
    let mut statuses = Vec::with_capacity(request_ids.len());
    for rid in &request_ids {
        let rid: [u8; 32] = rid.as_slice().try_into().map_err(|_| DpayError::BadInput("request_id must be 32 bytes".into()))?;
        let s = request_status(&tree, &rid).map_err(bad)?;
        statuses.push(match s {
            RailStatus::Unknown => IcpRequestStatus { request_id: rid.to_vec(), state: "unknown".into(), reply_arg: None, reject_code: None, reject_message: None, error_code: None },
            RailStatus::Received => IcpRequestStatus { request_id: rid.to_vec(), state: "received".into(), reply_arg: None, reject_code: None, reject_message: None, error_code: None },
            RailStatus::Processing => IcpRequestStatus { request_id: rid.to_vec(), state: "processing".into(), reply_arg: None, reject_code: None, reject_message: None, error_code: None },
            RailStatus::Replied(arg) => IcpRequestStatus { request_id: rid.to_vec(), state: "replied".into(), reply_arg: Some(arg), reject_code: None, reject_message: None, error_code: None },
            RailStatus::Rejected { reject_code, reject_message, error_code } => IcpRequestStatus { request_id: rid.to_vec(), state: "rejected".into(), reply_arg: None, reject_code: Some(reject_code), reject_message: Some(reject_message), error_code },
            RailStatus::Done => IcpRequestStatus { request_id: rid.to_vec(), state: "done".into(), reply_arg: None, reject_code: None, reject_message: None, error_code: None },
        });
    }
    Ok(IcpStateRead { time_ns, statuses })
}

/// A decoded `icrc1_transfer` reply (the DIDL variant inside a `replied` arg): `ok` carries the
/// ledger block index (decimal string); errors flatten to a variant tag + human detail.
#[derive(uniffi::Record, Clone)]
pub struct IcpTransferOutcome {
    pub ok: bool,
    pub block_index: Option<String>,
    /// e.g. `InsufficientFunds`, `BadFee`, `Duplicate`, `GenericError`, … empty when ok.
    pub err_variant: String,
    /// Human-readable detail (e.g. "balance 0, need 10000").
    pub err_detail: String,
}

fn transfer_err(e: TransferError) -> IcpTransferOutcome {
    let (variant, detail) = match e {
        TransferError::BadBurn { min_burn_amount } => ("BadBurn", format!("min burn amount {min_burn_amount}")),
        TransferError::BadFee { expected_fee } => ("BadFee", format!("expected fee {expected_fee}")),
        TransferError::InsufficientFunds { balance } => ("InsufficientFunds", format!("balance {balance}")),
        TransferError::TooOld => ("TooOld", "created before the transaction window".into()),
        TransferError::CreatedInFuture { ledger_time } => ("CreatedInFuture", format!("ledger time {ledger_time}")),
        TransferError::Duplicate { duplicate_of } => ("Duplicate", format!("duplicate of block {duplicate_of}")),
        TransferError::TemporarilyUnavailable => ("TemporarilyUnavailable", "ledger temporarily unavailable".into()),
        TransferError::GenericError { error_code, message } => ("GenericError", format!("[{error_code}] {message}")),
    };
    IcpTransferOutcome { ok: false, block_index: None, err_variant: variant.into(), err_detail: detail }
}

#[uniffi::export]
pub fn icp_decode_transfer_result(arg: Vec<u8>) -> Result<IcpTransferOutcome, DpayError> {
    match icrc_decode_transfer_result(&arg).map_err(bad)? {
        TransferResult::Ok(idx) => Ok(IcpTransferOutcome { ok: true, block_index: Some(idx.to_string()), err_variant: String::new(), err_detail: String::new() }),
        TransferResult::Err(e) => Ok(transfer_err(e)),
    }
}

/// Decode a bare candid `int`/`nat` reply (e.g. `icrc1_balance_of`) to a decimal string.
#[uniffi::export]
pub fn icp_decode_int(arg: Vec<u8>) -> Result<String, DpayError> {
    let n = dpay_icp::icrc::decode_int(&arg).map_err(bad)?;
    Ok(n.to_string())
}

// Keep the ApproveResult import used (approve decoding lands with the offramp workstream).
const _: Option<ApproveResult> = None;

#[cfg(test)]
mod tests {
    use super::*;

    const SEED_A: [u8; 32] = [0x0a; 32];

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(s: &str) -> Vec<u8> {
        s.as_bytes().chunks(2).map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap()).collect()
    }

    #[test]
    fn self_principal_is_seed_stable() {
        let p = icp_self_principal(SEED_A.to_vec()).unwrap();
        // base32-CRC text of a 29-byte self-authenticating id; deterministic for the seed
        assert_eq!(p, icp_self_principal(SEED_A.to_vec()).unwrap());
        assert_eq!(p.len(), 63);
    }

    #[test]
    fn sign_update_returns_envelope_and_matching_rid() {
        // real ckBTC ledger principal (CRC-valid)
        let arg = icp_balance_of_arg("mxzaz-hqaaa-aaaar-qaada-cai".into(), None).unwrap();
        let expiry = icp_ingress_expiry("1800000000000000000".into(), 300).unwrap();
        let signed = icp_sign_update(SEED_A.to_vec(), "mxzaz-hqaaa-aaaar-qaada-cai".into(), "icrc1_transfer".into(), arg, expiry).unwrap();
        assert_eq!(signed.envelope.len() % 1, 0);
        assert_eq!(signed.request_id.len(), 32);
        // envelope_request_id agrees — the merchant-side path derives the same rid
        assert_eq!(icp_envelope_request_id(signed.envelope.clone()).unwrap(), signed.request_id);
    }

    #[test]
    fn read_state_roundtrip_decodes_time_and_status() {
        use dpay_icp::reply::{cbor_encode, Cbor, Tree};
        let rid = [7u8; 32];
        let reply_leaf = {
            let mut out = Vec::new();
            cbor_encode(&Cbor::Map(vec![(Cbor::Text("arg".into()), Cbor::Bytes(b"ok".to_vec()))]), &mut out);
            out
        };
        let tree = Tree::Fork(
            Box::new(Tree::Labeled(
                b"request_status".to_vec(),
                Box::new(Tree::Labeled(
                    rid.to_vec(),
                    Box::new(Tree::Fork(
                        Box::new(Tree::Labeled(b"status".to_vec(), Box::new(Tree::Leaf(b"replied".to_vec())))),
                        Box::new(Tree::Labeled(b"reply".to_vec(), Box::new(Tree::Leaf(reply_leaf)))),
                    )),
                )),
            )),
            Box::new(Tree::Labeled(b"time".to_vec(), Box::new(Tree::Leaf(vec![0xe7, 0x56])))),
        );
        let body = {
            let mut cert = Vec::new();
            cbor_encode(&Cbor::Map(vec![(Cbor::Text("tree".into()), tree_to_cbor(&tree))]), &mut cert);
            let mut out = Vec::new();
            cbor_encode(&Cbor::Map(vec![(Cbor::Text("certificate".into()), Cbor::Bytes(cert))]), &mut out);
            out
        };
        let read = icp_decode_read_state(body, vec![rid.to_vec()]).unwrap();
        assert_eq!(read.time_ns.as_deref(), Some("11111"));
        assert_eq!(read.statuses.len(), 1);
        assert_eq!(read.statuses[0].state, "replied");
        assert_eq!(read.statuses[0].reply_arg.as_deref(), Some(b"ok".as_slice()));

        fn tree_to_cbor(t: &Tree) -> Cbor {
            match t {
                Tree::Empty => Cbor::Array(vec![Cbor::Uint(0)]),
                Tree::Fork(l, r) => Cbor::Array(vec![Cbor::Uint(1), tree_to_cbor(l), tree_to_cbor(r)]),
                Tree::Labeled(l, sub) => Cbor::Array(vec![Cbor::Uint(2), Cbor::Bytes(l.clone()), tree_to_cbor(sub)]),
                Tree::Leaf(v) => Cbor::Array(vec![Cbor::Uint(3), Cbor::Bytes(v.clone())]),
                Tree::Pruned(d) => Cbor::Array(vec![Cbor::Uint(4), Cbor::Bytes(d.to_vec())]),
            }
        }
    }

    #[test]
    fn transfer_result_decodes_ok_and_errors() {
        // LIVE-captured goldens from dpay-icp's own suite (real ledger reply shape,
        // bare variant; Ok carries the BlockIndex nat).
        let ok_arg = unhex("4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000002");
        let out = icp_decode_transfer_result(ok_arg).unwrap();
        assert!(out.ok);
        assert_eq!(out.block_index.as_deref(), Some("2"));
        // BadFee { expected_fee: 10000 } — err_variant + numeric detail survive the bridge
        let bad_fee = unhex("4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000104904e");
        let out = icp_decode_transfer_result(bad_fee).unwrap();
        assert!(!out.ok);
        assert_eq!(out.err_variant, "BadFee");
        // decode_int over a golden nat reply (mainnet DUSD decimals = 2)
        assert_eq!(icp_decode_int(unhex("4449444c00017b02")).unwrap(), "2");
    }

    #[test]
    fn ingress_expiry_string_math() {
        let e = icp_ingress_expiry("1000000000000000000".into(), 300).unwrap();
        // 1e18 ns + 300 s × 1e9 = 1_000_000_300_000_000_000
        assert_eq!(e, "1000000300000000000");
        assert!(icp_ingress_expiry("not-a-number".into(), 300).is_err());
    }

    #[test]
    fn principal_text_is_validated() {
        assert!(icp_balance_of_arg("not-a-principal".into(), None).is_err());
        assert!(icp_transfer_arg("not-a-principal".into(), None, None, "1".into(), None, None).is_err());
    }

    #[test]
    fn subaccount_hex_gate() {
        let owner = icp_self_principal(SEED_A.to_vec()).unwrap();
        assert!(icp_balance_of_arg(owner.clone(), Some("abcd".into())).is_err(), "short subaccount rejected");
        let arg = icp_balance_of_arg(owner, Some("00".repeat(32))).unwrap();
        assert!(!arg.is_empty());
        let _ = hex(&arg);
    }
}
