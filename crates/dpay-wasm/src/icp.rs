//! IC user-principal rail exports (dpay-icp): envelope signing + /api/v2 response decoding,
//! wasm32-safe, additive to the frozen ABI v1 table. Conventions mirror the Kotlin/UniFFI
//! surface (`crates/dpay-ffi/src/icp.rs`) so the JS shim is a thin marshal:
//!
//! - ns timestamps + u128 amounts cross as decimal STRINGS (JS 2^53 safety);
//! - principal owners cross as base32-CRC TEXT (validated in Rust), subaccounts/memos as hex
//!   bytes (empty = None);
//! - structured results are compact JSON (like `w_decode_request`), returned by
//!   length; `0` = cap too small or bad input — no traps, no stderr. Decode FAILURES
//!   return the typed status codes (`BAD_UTF8`), never a misleading JSON: the
//!   2026-08-20 correctness fix to `w_icp_decode_read_state` (a malformed-cert leaf
//!   used to decode as `unknown`/null-time, making a dead poll look alive — the JS
//!   shim throws on these codes, so the web wallet surfaces the poll error).
//!   Signatures and success-path bytes are unchanged (ABI v1 stays additive-only).
//!
//! The decoders trust-decode the certificate (BLS chain verification is the W6 follow-up).

use dpay_icp::envelope::{
    ingress_expiry as icp_ingress_expiry, sign_query, sign_read_state, sign_update, CallRequest,
};
use dpay_icp::icrc::{
    approve_arg as icrc_approve_arg, balance_of_arg as icrc_balance_of_arg,
    decode_legacy_transfer_result as icrc_decode_legacy_transfer_result,
    decode_minter_ok as icrc_decode_minter_ok,
    decode_transfer_result as icrc_decode_transfer_result,
    legacy_transfer_arg as icrc_legacy_transfer_arg, transfer_arg as icrc_transfer_arg,
    LegacyTransferError, LegacyTransferResult, TransferError, TransferResult,
};
use dpay_icp::principal::{Account, AccountIdentifier, Principal};
use dpay_icp::reply::{
    decode_query_response, decode_read_state_tree, read_state_time, request_status,
    QueryOutcome, RequestStatus as RailStatus,
};

use crate::{in_bounds, slice_at, write_at, write_str_out, BAD_LEN, BAD_UTF8, OK};

const MAX_JSON: u32 = 4096;

fn key_at(seed_ptr: u32) -> Result<ed25519_dalek::SigningKey, u32> {
    if !in_bounds(seed_ptr, 32) {
        return Err(BAD_LEN);
    }
    Ok(ed25519_dalek::SigningKey::from_bytes(unsafe { slice_at(seed_ptr, 32) }.try_into().unwrap()))
}

/// Read a NUL-free decimal u64 string from `[ptr, ptr+len)`.
fn u64_str_at(ptr: u32, len: u32) -> Result<u64, u32> {
    if !in_bounds(ptr, len) || len > 20 {
        return Err(BAD_LEN);
    }
    let s = core::str::from_utf8(unsafe { slice_at(ptr, len) }).map_err(|_| BAD_UTF8)?;
    s.parse::<u64>().map_err(|_| BAD_UTF8)
}

/// Read a decimal u128 string from `[ptr, ptr+len)` (`""` allowed for Option::None semantics).
fn u128_opt_at(ptr: u32, len: u32) -> Result<Option<u128>, u32> {
    if !in_bounds(ptr, len) || len > 40 {
        return Err(BAD_LEN);
    }
    if len == 0 {
        return Ok(None);
    }
    let s = core::str::from_utf8(unsafe { slice_at(ptr, len) }).map_err(|_| BAD_UTF8)?;
    s.parse::<u128>().map(Some).map_err(|_| BAD_UTF8)
}

/// Read a NUL-free UTF-8 string (principal text / method name).
fn text_at(ptr: u32, len: u32) -> Result<String, u32> {
    if !in_bounds(ptr, len) || len > 512 {
        return Err(BAD_LEN);
    }
    core::str::from_utf8(unsafe { slice_at(ptr, len) })
        .map(|s| s.to_string())
        .map_err(|_| BAD_UTF8)
}

/// Optional 32-byte subaccount (len 0 = None, 32 = Some; anything else = BAD_LEN).
fn sub32_at(ptr: u32, len: u32) -> Result<Option<[u8; 32]>, u32> {
    if len == 0 {
        return Ok(None);
    }
    if !in_bounds(ptr, len) || len != 32 {
        return Err(BAD_LEN);
    }
    let bytes = unsafe { slice_at(ptr, len) };
    bytes.try_into().map(Some).map_err(|_| BAD_LEN)
}

/// Read hex bytes ("" = empty).
fn hex_at(ptr: u32, len: u32) -> Result<Vec<u8>, u32> {
    if !in_bounds(ptr, len) || len > 1024 || len % 2 != 0 {
        return Err(BAD_LEN);
    }
    let s = core::str::from_utf8(unsafe { slice_at(ptr, len) }).map_err(|_| BAD_UTF8)?;
    let mut out = Vec::with_capacity(s.len() / 2);
    let b = s.as_bytes();
    for pair in b.chunks(2) {
        let hi = (pair[0] as char).to_digit(16).ok_or(BAD_UTF8)?;
        let lo = (pair[1] as char).to_digit(16).ok_or(BAD_UTF8)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

fn push_hex(bytes: &[u8], out: &mut String) {
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((b & 0xf) as u32, 16).unwrap());
    }
}

/// JSON-escape a str (no control chars expected in these fields; escape anyway).
fn push_json_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn opt_json_str(v: &Option<String>, out: &mut String) {
    match v {
        Some(s) => push_json_str(s, out),
        None => out.push_str("null"),
    }
}

/// Account{owner: text, subaccount: hex-or-default}.
fn account_at(owner_ptr: u32, owner_len: u32, sub_ptr: u32, sub_len: u32) -> Result<Account, u32> {
    let owner_text = text_at(owner_ptr, owner_len)?;
    let owner = Principal::from_text(&owner_text).map_err(|_| BAD_UTF8)?;
    let sub = hex_at(sub_ptr, sub_len)?;
    let subaccount: [u8; 32] = match sub.len() {
        0 => [0u8; 32],
        32 => sub.as_slice().try_into().unwrap(),
        _ => return Err(BAD_LEN),
    };
    Ok(Account { owner, subaccount })
}

// --- identity / clock ---------------------------------------------------------------------------

/// `icp_self_principal`: write the self-authenticating principal TEXT of the seed key
/// (SHA224(DER(pub)) | 0x02, base32-CRC) to `out_ptr` — same contract as the UniFFI surface.
#[no_mangle]
pub extern "C" fn w_icp_self_principal(seed_ptr: u32, out_ptr: u32, cap: u32) -> u32 {
    let sk = match key_at(seed_ptr) {
        Ok(k) => k,
        Err(e) => return e,
    };
    let p = Principal::self_authenticating_ed25519(&sk.verifying_key().to_bytes());
    let text = p.to_text();
    write_str_out(text.as_bytes(), out_ptr, cap)
}

/// `icp_principal_from_pubkey`: payee principal text for a 32-byte Ed25519 public key (the
/// payment-request `to` field) — `self_authenticating(pub)`. Keeps the request format frozen.
#[no_mangle]
pub extern "C" fn w_icp_principal_from_pubkey(ptr: u32, len: u32, out_ptr: u32, cap: u32) -> u32 {
    if !in_bounds(ptr, len) || len != 32 {
        return BAD_LEN;
    }
    let pk: [u8; 32] = match unsafe { slice_at(ptr, len) }.try_into() {
        Ok(p) => p,
        Err(_) => return BAD_LEN,
    };
    let text = Principal::self_authenticating_ed25519(&pk).to_text();
    write_str_out(text.as_bytes(), out_ptr, cap)
}

/// `icp_validate_principal`: base32-CRC parse of an ICRC-1 owner principal TEXT, writing the
/// CANONICAL text to `out_ptr`. Twin of the UniFFI `icp_validate_principal` — the web wallet
/// validates a payment link's destination through the same core parser the phone uses, so a
/// mistyped/truncated principal is refused before the payer sees a destination.
#[no_mangle]
pub extern "C" fn w_icp_validate_principal(ptr: u32, len: u32, out_ptr: u32, cap: u32) -> u32 {
    let text = match text_at(ptr, len) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let p = match Principal::from_text(&text) {
        Ok(p) => p,
        Err(_) => return BAD_UTF8,
    };
    write_str_out(p.to_text().as_bytes(), out_ptr, cap)
}

/// `icp_validate_icrc_account`: parse an ICRC-1 textual ACCOUNT (bare principal, or
/// `principal-checksum.subaccount`) and write `{"owner":…,"subaccountHex":…}` to `out_ptr`.
/// `subaccountHex` is EMPTY for the default subaccount. Twin of the UniFFI
/// `icp_validate_icrc_account` — the web wallet parses a scanned/pasted send destination through
/// the SAME core parser the phone uses, so an address that is refused on one is refused on both.
#[no_mangle]
pub extern "C" fn w_icp_validate_icrc_account(ptr: u32, len: u32, out_ptr: u32, cap: u32) -> u32 {
    let text = match text_at(ptr, len) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let a = match Account::from_text(&text) {
        Ok(a) => a,
        Err(_) => return BAD_UTF8,
    };
    let sub = if a.subaccount == [0u8; 32] { String::new() } else { hex_str(&a.subaccount) };
    let mut json = String::with_capacity(128);
    json.push_str("{\"owner\":");
    push_json_str(&a.owner.to_text(), &mut json);
    json.push_str(",\"subaccountHex\":");
    push_json_str(&sub, &mut json);
    json.push('}');
    write_str_out(json.as_bytes(), out_ptr, cap)
}

/// `icp_validate_account_id`: CRC-checked parse of a 64-hex ICP account identifier,
/// writing the canonical lowercase text. Twin of the UniFFI `icp_validate_account_id`.
#[no_mangle]
pub extern "C" fn w_icp_validate_account_id(ptr: u32, len: u32, out_ptr: u32, cap: u32) -> u32 {
    let text = match text_at(ptr, len) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let id = match AccountIdentifier::from_text(&text) {
        Ok(i) => i,
        Err(_) => return BAD_UTF8,
    };
    write_str_out(id.to_text().as_bytes(), out_ptr, cap)
}

/// `icp_account_id_from_principal`: derive the account identifier for an owner+subaccount.
/// Twin of the UniFFI export; used for the send screen's self-send guard.
#[no_mangle]
pub extern "C" fn w_icp_account_id_from_principal(
    owner_ptr: u32, owner_len: u32, sub_ptr: u32, sub_len: u32, out_ptr: u32, cap: u32,
) -> u32 {
    let a = match account_at(owner_ptr, owner_len, sub_ptr, sub_len) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let id = AccountIdentifier::from_principal(&a.owner, &a.subaccount);
    write_str_out(id.to_text().as_bytes(), out_ptr, cap)
}

/// Lowercase hex of a byte slice (the wasm crate has no hex encoder of its own).
fn hex_str(b: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push(HEX[(byte >> 4) as usize] as char);
        s.push(HEX[(byte & 0xf) as usize] as char);
    }
    s
}

/// `icp_ingress_expiry`: `now_ns + ahead_s * 1e9` as a decimal string at `out_ptr`.
#[no_mangle]
pub extern "C" fn w_icp_ingress_expiry(now_ptr: u32, now_len: u32, ahead_s: u32, out_ptr: u32, cap: u32) -> u32 {
    let now = match u64_str_at(now_ptr, now_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let text = icp_ingress_expiry(now, ahead_s as u64).to_string();
    write_str_out(text.as_bytes(), out_ptr, cap)
}

// --- DIDL arg builders ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn w_icp_transfer_arg(
    to_owner_ptr: u32, to_owner_len: u32, to_sub_ptr: u32, to_sub_len: u32,
    from_sub_ptr: u32, from_sub_len: u32,
    amount_ptr: u32, amount_len: u32,
    fee_ptr: u32, fee_len: u32,
    memo_ptr: u32, memo_len: u32,
    out_ptr: u32, cap: u32,
) -> u32 {
    let to = match account_at(to_owner_ptr, to_owner_len, to_sub_ptr, to_sub_len) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let amount = match u128_opt_at(amount_ptr, amount_len) {
        Ok(Some(v)) => v,
        Ok(None) => return BAD_UTF8,
        Err(e) => return e,
    };
    let fee = match u128_opt_at(fee_ptr, fee_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let memo = match hex_at(memo_ptr, memo_len) {
        Ok(v) if v.is_empty() => None,
        Ok(v) => Some(v),
        Err(e) => return e,
    };
    let from_sub = match hex_at(from_sub_ptr, from_sub_len) {
        Ok(v) if v.is_empty() => None,
        Ok(v) => match <[u8; 32]>::try_from(v.as_slice()) {
            Ok(a) => Some(a),
            Err(_) => return BAD_LEN,
        },
        Err(e) => return e,
    };
    // The trailing `None` is `created_at_time`, and it is a decision — see `icp_transfer_arg` in
    // dpay-ffi.
    let arg = icrc_transfer_arg(&to, from_sub, amount, fee, memo, None);
    write_str_out(&arg, out_ptr, cap) // binary out via write_str_out's byte-copy semantics
}

#[no_mangle]
pub extern "C" fn w_icp_approve_arg(
    spender_owner_ptr: u32, spender_owner_len: u32, spender_sub_ptr: u32, spender_sub_len: u32,
    from_sub_ptr: u32, from_sub_len: u32,
    amount_ptr: u32, amount_len: u32,
    expected_ptr: u32, expected_len: u32,
    expires_ptr: u32, expires_len: u32,
    memo_ptr: u32, memo_len: u32,
    fee_ptr: u32, fee_len: u32,
    out_ptr: u32, cap: u32,
) -> u32 {
    let spender = match account_at(spender_owner_ptr, spender_owner_len, spender_sub_ptr, spender_sub_len) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let amount = match u128_opt_at(amount_ptr, amount_len) {
        Ok(v) => v, // None encodes revoke (0)
        Err(e) => return e,
    };
    let expected = match u128_opt_at(expected_ptr, expected_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let expires = match u128_opt_at(expires_ptr, expires_len) {
        Ok(None) => None,
        // Expiry is a u64 ns stamp; a u128 that doesn't fit must ERROR (the FFI counterpart
        // rejects it too) — the old `v as u64` wrapped mod 2^64 and silently built an
        // envelope the boundary node rejects at ingress.
        Ok(Some(v)) => match u64::try_from(v) {
            Ok(e) => Some(e),
            Err(_) => return BAD_UTF8,
        },
        Err(e) => return e,
    };
    let memo = match hex_at(memo_ptr, memo_len) {
        Ok(v) if v.is_empty() => None,
        Ok(v) => Some(v),
        Err(e) => return e,
    };
    let from_sub = match hex_at(from_sub_ptr, from_sub_len) {
        Ok(v) if v.is_empty() => None,
        Ok(v) => match <[u8; 32]>::try_from(v.as_slice()) {
            Ok(a) => Some(a),
            Err(_) => return BAD_LEN,
        },
        Err(e) => return e,
    };
    let fee = match u128_opt_at(fee_ptr, fee_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let arg = icrc_approve_arg(from_sub, &spender, amount, expected, expires, memo, None, fee);
    write_str_out(&arg, out_ptr, cap)
}

#[no_mangle]
pub extern "C" fn w_icp_balance_of_arg(
    owner_ptr: u32, owner_len: u32, sub_ptr: u32, sub_len: u32,
    out_ptr: u32, cap: u32,
) -> u32 {
    let account = match account_at(owner_ptr, owner_len, sub_ptr, sub_len) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let arg = icrc_balance_of_arg(&account);
    write_str_out(&arg, out_ptr, cap)
}

// --- minter calls (user-principal offramp + deposits) — golden-pinned builders ---------------------

/// ckBTC minter `get_btc_address(MinterAccount)` — ONE record arg (2-tuples trap IC0503).
#[no_mangle]
pub extern "C" fn w_icp_minter_account_arg(
    owner_ptr: u32, owner_len: u32, sub_ptr: u32, sub_len: u32,
    out_ptr: u32, cap: u32,
) -> u32 {
    let account = match account_at(owner_ptr, owner_len, sub_ptr, sub_len) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let sub = if account.subaccount == [0u8; 32] { None } else { Some(account.subaccount) };
    let arg = dpay_icp::icrc::minter_account_arg(&account.owner, sub);
    write_str_out(&arg, out_ptr, cap)
}

/// ckBTC minter `retrieve_btc_with_approval` (address text, sats decimal string, opt sub hex).
#[no_mangle]
pub extern "C" fn w_icp_retrieve_btc_arg(
    addr_ptr: u32, addr_len: u32, amount_ptr: u32, amount_len: u32,
    sub_ptr: u32, sub_len: u32, out_ptr: u32, cap: u32,
) -> u32 {
    let addr = match text_at(addr_ptr, addr_len) { Ok(t) => t, Err(e) => return e };
    let amount: u64 = match u64_str_at(amount_ptr, amount_len) { Ok(v) => v, Err(e) => return e };
    let sub = match sub32_at(sub_ptr, sub_len) { Ok(s) => s, Err(e) => return e };
    let arg = dpay_icp::icrc::retrieve_btc_arg(&addr, amount, sub);
    write_str_out(&arg, out_ptr, cap)
}

/// ckETH minter `withdraw_eth` (recipient text, Wei decimal string, opt sub hex).
#[no_mangle]
pub extern "C" fn w_icp_withdraw_eth_arg(
    recip_ptr: u32, recip_len: u32, amount_ptr: u32, amount_len: u32,
    sub_ptr: u32, sub_len: u32, out_ptr: u32, cap: u32,
) -> u32 {
    let recip = match text_at(recip_ptr, recip_len) { Ok(t) => t, Err(e) => return e };
    let amount: u128 = match u128_opt_at(amount_ptr, amount_len) {
        Ok(Some(v)) => v,
        Ok(None) => return BAD_UTF8, // empty amount is invalid here
        Err(e) => return e,
    };
    let sub = match sub32_at(sub_ptr, sub_len) { Ok(s) => s, Err(e) => return e };
    let arg = dpay_icp::icrc::withdraw_eth_arg(&recip, amount, sub);
    write_str_out(&arg, out_ptr, cap)
}

/// ckETH minter `withdraw_erc20` — dual-ledger (amount, ckerc20 ledger, recipient, 2 opt subs).
#[no_mangle]
pub extern "C" fn w_icp_withdraw_erc20_arg(
    amount_ptr: u32, amount_len: u32, ledger_ptr: u32, ledger_len: u32,
    recip_ptr: u32, recip_len: u32, sub1_ptr: u32, sub1_len: u32,
    sub2_ptr: u32, sub2_len: u32, out_ptr: u32, cap: u32,
) -> u32 {
    let amount: u128 = match u128_opt_at(amount_ptr, amount_len) {
        Ok(Some(v)) => v,
        Ok(None) => return BAD_UTF8,
        Err(e) => return e,
    };
    let ledger_text = match text_at(ledger_ptr, ledger_len) { Ok(t) => t, Err(e) => return e };
    let ledger = match Principal::from_text(&ledger_text) { Ok(p) => p, Err(_) => return BAD_UTF8 };
    let recip = match text_at(recip_ptr, recip_len) { Ok(t) => t, Err(e) => return e };
    let sub1 = match sub32_at(sub1_ptr, sub1_len) { Ok(s) => s, Err(e) => return e };
    let sub2 = match sub32_at(sub2_ptr, sub2_len) { Ok(s) => s, Err(e) => return e };
    let arg = dpay_icp::icrc::withdraw_erc20_arg(amount, &ledger, &recip, sub1, sub2);
    write_str_out(&arg, out_ptr, cap)
}

/// ckETH minter `eip_1559_transaction_price` QUERY arg (ckerc20 ledger principal text).
#[no_mangle]
pub extern "C" fn w_icp_eip1559_price_arg(
    ledger_ptr: u32, ledger_len: u32, out_ptr: u32, cap: u32,
) -> u32 {
    let ledger_text = match text_at(ledger_ptr, ledger_len) { Ok(t) => t, Err(e) => return e };
    let ledger = match Principal::from_text(&ledger_text) { Ok(p) => p, Err(_) => return BAD_UTF8 };
    let arg = dpay_icp::icrc::eip1559_price_arg(&ledger);
    write_str_out(&arg, out_ptr, cap)
}

/// Decode a bare `text` reply (get_btc_address / any single-text query) into JSON {"text": "..."}.
#[no_mangle]
pub extern "C" fn w_icp_decode_text(arg_ptr: u32, arg_len: u32, out_ptr: u32, cap: u32) -> u32 {
    if !in_bounds(arg_ptr, arg_len) || arg_len > 8192 {
        return BAD_LEN;
    }
    let bytes = unsafe { slice_at(arg_ptr, arg_len) };
    let text = match dpay_icp::icrc::decode_text(bytes) { Ok(t) => t, Err(_) => return BAD_UTF8 };
    let mut json = String::from("{\"text\":");
    push_json_str(&text, &mut json);
    json.push('}');
    write_str_out(json.as_bytes(), out_ptr, cap)
}

/// Decode an `eip_1559_transaction_price` reply into JSON (Wei decimal strings).
#[no_mangle]
pub extern "C" fn w_icp_decode_eip1559_price(arg_ptr: u32, arg_len: u32, out_ptr: u32, cap: u32) -> u32 {
    if !in_bounds(arg_ptr, arg_len) || arg_len > 8192 {
        return BAD_LEN;
    }
    let bytes = unsafe { slice_at(arg_ptr, arg_len) };
    let p = match dpay_icp::icrc::decode_eip1559_price(bytes) { Ok(p) => p, Err(_) => return BAD_UTF8 };
    let mut json = String::with_capacity(256);
    json.push_str("{\"gasLimit\":\"");
    json.push_str(&p.gas_limit.to_string());
    json.push_str("\",\"maxFeePerGas\":\"");
    json.push_str(&p.max_fee_per_gas.to_string());
    json.push_str("\",\"maxPriorityFeePerGas\":\"");
    json.push_str(&p.max_priority_fee_per_gas.to_string());
    json.push_str("\",\"maxTransactionFee\":\"");
    json.push_str(&p.max_transaction_fee.to_string());
    json.push_str("\",\"timestampNs\":");
    match p.timestamp {
        Some(t) => {
            json.push('"');
            json.push_str(&t.to_string());
            json.push('"');
        }
        None => json.push_str("null"),
    }
    json.push('}');
    write_str_out(json.as_bytes(), out_ptr, cap)
}

// --- envelope signing ----------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn w_icp_sign_update(
    seed_ptr: u32,
    canister_ptr: u32, canister_len: u32,
    method_ptr: u32, method_len: u32,
    arg_ptr: u32, arg_len: u32,
    expiry_ptr: u32, expiry_len: u32,
    out_ptr: u32, cap: u32,
) -> u32 {
    let sk = match key_at(seed_ptr) {
        Ok(k) => k,
        Err(e) => return e,
    };
    let canister_text = match text_at(canister_ptr, canister_len) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let canister = match Principal::from_text(&canister_text) {
        Ok(p) => p,
        Err(_) => return BAD_UTF8,
    };
    let method = match text_at(method_ptr, method_len) {
        Ok(t) => t,
        Err(e) => return e,
    };
    if !in_bounds(arg_ptr, arg_len) {
        return BAD_LEN;
    }
    let arg = unsafe { slice_at(arg_ptr, arg_len) }.to_vec();
    let expiry = match u64_str_at(expiry_ptr, expiry_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let req = CallRequest { canister, method_name: method, arg, ingress_expiry_ns: expiry, nonce: None };
    let envelope = sign_update(&sk, &req);
    write_str_out(&envelope, out_ptr, cap)
}

#[no_mangle]
pub extern "C" fn w_icp_sign_query(
    seed_ptr: u32,
    canister_ptr: u32, canister_len: u32,
    method_ptr: u32, method_len: u32,
    arg_ptr: u32, arg_len: u32,
    expiry_ptr: u32, expiry_len: u32,
    out_ptr: u32, cap: u32,
) -> u32 {
    let sk = match key_at(seed_ptr) {
        Ok(k) => k,
        Err(e) => return e,
    };
    let canister_text = match text_at(canister_ptr, canister_len) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let canister = match Principal::from_text(&canister_text) {
        Ok(p) => p,
        Err(_) => return BAD_UTF8,
    };
    let method = match text_at(method_ptr, method_len) {
        Ok(t) => t,
        Err(e) => return e,
    };
    if !in_bounds(arg_ptr, arg_len) {
        return BAD_LEN;
    }
    let arg = unsafe { slice_at(arg_ptr, arg_len) }.to_vec();
    let expiry = match u64_str_at(expiry_ptr, expiry_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let req = CallRequest { canister, method_name: method, arg, ingress_expiry_ns: expiry, nonce: None };
    let envelope = sign_query(&sk, &req);
    write_str_out(&envelope, out_ptr, cap)
}

/// Sign a read_state envelope polling up to 8 rids. `rids_ptr` = 8×32 bytes concatenated;
/// `n_rids` = how many are live (0 = time-only poll). want_time adds the certified `time` path.
#[no_mangle]
pub extern "C" fn w_icp_sign_read_state(
    seed_ptr: u32,
    rids_ptr: u32, n_rids: u32,
    want_time: u32,
    expiry_ptr: u32, expiry_len: u32,
    out_ptr: u32, cap: u32,
) -> u32 {
    let sk = match key_at(seed_ptr) {
        Ok(k) => k,
        Err(e) => return e,
    };
    if n_rids > 8 || !in_bounds(rids_ptr, n_rids * 32) {
        return BAD_LEN;
    }
    let raw = unsafe { slice_at(rids_ptr, n_rids * 32) };
    let rids: Vec<[u8; 32]> = raw.chunks_exact(32).map(|c| c.try_into().unwrap()).collect();
    let expiry = match u64_str_at(expiry_ptr, expiry_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let mut paths: Vec<Vec<Vec<u8>>> = rids
        .iter()
        .map(|rid| vec![b"request_status".to_vec(), rid.to_vec()])
        .collect();
    if want_time != 0 {
        paths.push(vec![b"time".to_vec()]);
    }
    let segs: Vec<Vec<&[u8]>> = paths.iter().map(|p| p.iter().map(|s| s.as_slice()).collect()).collect();
    let refs: Vec<&[&[u8]]> = segs.iter().map(|v| v.as_slice()).collect();
    let envelope = sign_read_state(&sk, &refs, expiry);
    write_str_out(&envelope, out_ptr, cap)
}

#[no_mangle]
pub extern "C" fn w_icp_envelope_request_id(env_ptr: u32, env_len: u32, out_ptr: u32) -> u32 {
    if !in_bounds(env_ptr, env_len) || env_len > 2048 {
        return BAD_LEN;
    }
    let env = unsafe { slice_at(env_ptr, env_len) };
    let rid = match dpay_icp::envelope::envelope_request_id(env) {
        Ok(r) => r,
        Err(_) => return BAD_UTF8,
    };
    if !in_bounds(out_ptr, 32) {
        return BAD_LEN;
    }
    unsafe { write_at(out_ptr, &rid) };
    OK
}

// --- /api/v2 response decoders ---------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn w_icp_decode_query(body_ptr: u32, body_len: u32, out_ptr: u32, cap: u32) -> u32 {
    if !in_bounds(body_ptr, body_len) || body_len > 8192 {
        return BAD_LEN;
    }
    let body = unsafe { slice_at(body_ptr, body_len) };
    let outcome = match decode_query_response(body) {
        Ok(o) => o,
        Err(_) => return BAD_UTF8,
    };
    let mut json = String::with_capacity(128);
    match outcome {
        QueryOutcome::Replied(arg) => {
            json.push_str("{\"replied\":true,\"argHex\":\"");
            push_hex(&arg, &mut json);
            json.push_str("\"}");
        }
        QueryOutcome::Rejected { reject_code, reject_message, error_code } => {
            json.push_str(&format!("{{\"replied\":false,\"rejectCode\":\"{reject_code}\",\"rejectMessage\":"));
            push_json_str(&reject_message, &mut json);
            json.push_str(",\"errorCode\":");
            opt_json_str(&error_code, &mut json);
            json.push('}');
        }
    }
    write_str_out(json.as_bytes(), out_ptr, cap)
}

#[no_mangle]
pub extern "C" fn w_icp_decode_read_state(
    body_ptr: u32, body_len: u32,
    rids_ptr: u32, n_rids: u32,
    out_ptr: u32, cap: u32,
) -> u32 {
    if !in_bounds(body_ptr, body_len) || body_len > 16384 {
        return BAD_LEN;
    }
    if n_rids > 8 || !in_bounds(rids_ptr, n_rids * 32) {
        return BAD_LEN;
    }
    let body = unsafe { slice_at(body_ptr, body_len) };
    let raw = unsafe { slice_at(rids_ptr, n_rids * 32) };
    let rids: Vec<[u8; 32]> = raw.chunks_exact(32).map(|c| c.try_into().unwrap()).collect();
    let tree = match decode_read_state_tree(body) {
        Ok(t) => t,
        Err(_) => return BAD_UTF8,
    };
    // Malformed cert leaves propagate as an error status (the shim throws, the poll loop
    // surfaces it) — matching dpay-ffi's icp_decode_read_state. A decoded `None` is the
    // honest "no time leaf in this certificate".
    let time_ns = match read_state_time(&tree) {
        Ok(t) => t,
        Err(_) => return BAD_UTF8,
    };
    let mut json = String::with_capacity(256);
    json.push_str("{\"timeNs\":");
    match time_ns {
        Some(t) => json.push_str(&format!("\"{t}\"")),
        None => json.push_str("null"),
    }
    json.push_str(",\"statuses\":[");
    for (i, rid) in rids.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        let st = match request_status(&tree, rid) {
            Ok(s) => s,
            // Malformed status leaf: error out — never fabricate `unknown` (that turns a
            // decode failure into an endless "keep polling").
            Err(_) => return BAD_UTF8,
        };
        json.push_str("{\"requestIdHex\":\"");
        push_hex(rid, &mut json);
        json.push_str("\",\"state\":");
        match st {
            RailStatus::Unknown => push_json_str("unknown", &mut json),
            RailStatus::Received => push_json_str("received", &mut json),
            RailStatus::Processing => push_json_str("processing", &mut json),
            RailStatus::Done => push_json_str("done", &mut json),
            RailStatus::Replied(arg) => {
                json.push_str("\"replied\",\"replyArgHex\":\"");
                push_hex(&arg, &mut json);
                json.push('"');
            }
            RailStatus::Rejected { reject_code, reject_message, error_code } => {
                json.push_str("\"rejected\",\"rejectCode\":\"");
                // u64 as decimal string (exact for JS)
                json.push_str(&reject_code.to_string());
                json.push_str("\",\"rejectMessage\":");
                push_json_str(&reject_message, &mut json);
                json.push_str(",\"errorCode\":");
                opt_json_str(&error_code, &mut json);
            }
        }
        json.push('}');
    }
    json.push_str("]}");
    if json.len() > MAX_JSON as usize {
        return 0;
    }
    write_str_out(json.as_bytes(), out_ptr, cap)
}

/// `icp_legacy_transfer_arg`: DIDL args for the ICP ledger's LEGACY `transfer` — the only method
/// that can pay a 64-hex account identifier. Amounts/fee/memo cross as decimal strings; the
/// ledger's `Tokens` is a nat64, so an out-of-range value is REFUSED (BAD_LEN), never truncated.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn w_icp_legacy_transfer_arg(
    to_ptr: u32, to_len: u32,
    from_sub_ptr: u32, from_sub_len: u32,
    amount_ptr: u32, amount_len: u32,
    fee_ptr: u32, fee_len: u32,
    memo_ptr: u32, memo_len: u32,
    out_ptr: u32, cap: u32,
) -> u32 {
    let to_text = match text_at(to_ptr, to_len) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let to = match AccountIdentifier::from_text(&to_text) {
        Ok(i) => i,
        Err(_) => return BAD_UTF8,
    };
    let from_sub = match hex_at(from_sub_ptr, from_sub_len) {
        Ok(s) => s,
        Err(e) => return e,
    };
    let from_subaccount: Option<[u8; 32]> = match from_sub.len() {
        0 => None,
        32 => Some(from_sub.as_slice().try_into().unwrap()),
        _ => return BAD_LEN,
    };
    let amount = match u64_str_at(amount_ptr, amount_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let fee = match u64_str_at(fee_ptr, fee_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let memo = match u64_str_at(memo_ptr, memo_len) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let bytes = icrc_legacy_transfer_arg(to.as_bytes(), from_subaccount, amount, fee, memo, None);
    write_str_out(&bytes, out_ptr, cap)
}

/// `icp_decode_legacy_transfer_result`: the legacy `transfer` reply as the same compact JSON
/// `w_icp_decode_transfer_result` emits, but carrying the LEGACY variant tags (`TxDuplicate`,
/// `TxTooOld`, `TxCreatedInFuture`) — never renamed to their ICRC-1 near-twins.
#[no_mangle]
pub extern "C" fn w_icp_decode_legacy_transfer_result(arg_ptr: u32, arg_len: u32, out_ptr: u32, cap: u32) -> u32 {
    if !in_bounds(arg_ptr, arg_len) || arg_len > 512 {
        return BAD_LEN;
    }
    let arg = unsafe { slice_at(arg_ptr, arg_len) };
    let result = match icrc_decode_legacy_transfer_result(arg) {
        Ok(r) => r,
        Err(_) => return BAD_UTF8,
    };
    let mut json = String::with_capacity(96);
    match result {
        LegacyTransferResult::Ok(idx) => {
            json.push_str(&format!("{{\"ok\":true,\"blockIndex\":\"{idx}\"}}"));
        }
        LegacyTransferResult::Err(e) => {
            let (variant, detail) = match e {
                LegacyTransferError::TxTooOld { allowed_window_nanos } => ("TxTooOld", format!("allowed window {allowed_window_nanos} ns")),
                LegacyTransferError::BadFee { expected_fee } => ("BadFee", format!("expected fee {expected_fee}")),
                LegacyTransferError::TxDuplicate { duplicate_of } => ("TxDuplicate", format!("duplicate of block {duplicate_of}")),
                LegacyTransferError::TxCreatedInFuture => ("TxCreatedInFuture", "created ahead of ledger time".to_string()),
                LegacyTransferError::InsufficientFunds { balance } => ("InsufficientFunds", format!("balance {balance}")),
            };
            json.push_str("{\"ok\":false,\"errVariant\":");
            push_json_str(variant, &mut json);
            json.push_str(",\"errDetail\":");
            push_json_str(&detail, &mut json);
            json.push('}');
        }
    }
    write_str_out(json.as_bytes(), out_ptr, cap)
}

#[no_mangle]
pub extern "C" fn w_icp_decode_transfer_result(arg_ptr: u32, arg_len: u32, out_ptr: u32, cap: u32) -> u32 {
    if !in_bounds(arg_ptr, arg_len) || arg_len > 512 {
        return BAD_LEN;
    }
    let arg = unsafe { slice_at(arg_ptr, arg_len) };
    let result = match icrc_decode_transfer_result(arg) {
        Ok(r) => r,
        Err(_) => return BAD_UTF8,
    };
    let mut json = String::with_capacity(96);
    match result {
        TransferResult::Ok(idx) => {
            json.push_str(&format!("{{\"ok\":true,\"blockIndex\":\"{idx}\"}}"));
        }
        TransferResult::Err(e) => {
            let (variant, detail) = transfer_error_parts(&e);
            json.push_str("{\"ok\":false,\"errVariant\":");
            push_json_str(variant, &mut json);
            json.push_str(",\"errDetail\":");
            push_json_str(&detail, &mut json);
            json.push('}');
        }
    }
    write_str_out(json.as_bytes(), out_ptr, cap)
}

fn transfer_error_parts(e: &TransferError) -> (&'static str, String) {
    match e {
        TransferError::BadFee { expected_fee } => ("BadFee", expected_fee.to_string()),
        TransferError::BadBurn { min_burn_amount } => ("BadBurn", min_burn_amount.to_string()),
        TransferError::InsufficientFunds { balance } => ("InsufficientFunds", balance.to_string()),
        TransferError::TooOld => ("TooOld", String::new()),
        TransferError::CreatedInFuture { ledger_time } => ("CreatedInFuture", ledger_time.to_string()),
        TransferError::TemporarilyUnavailable => ("TemporarilyUnavailable", String::new()),
        TransferError::Duplicate { duplicate_of } => ("Duplicate", duplicate_of.to_string()),
        TransferError::GenericError { error_code, message } => {
            ("GenericError", format!("{error_code}: {message}"))
        }
    }
}

/// Decode the minter retrieve/withdraw Ok({block_index}) reply (the shape `encode_minter_ok`
/// emits — single source `dpay-icp`). Same compact-JSON shape as `w_icp_decode_transfer_result`
/// so the JS shim marshals both identically; the Err side reuses the transfer-error variant
/// names (minter rejects observed live are ICRC-1 transfer-error names).
#[no_mangle]
pub extern "C" fn w_icp_decode_minter_ok(arg_ptr: u32, arg_len: u32, out_ptr: u32, cap: u32) -> u32 {
    if !in_bounds(arg_ptr, arg_len) || arg_len > 512 {
        return BAD_LEN;
    }
    let arg = unsafe { slice_at(arg_ptr, arg_len) };
    let result = match icrc_decode_minter_ok(arg) {
        Ok(r) => r,
        Err(_) => return BAD_UTF8,
    };
    let mut json = String::with_capacity(96);
    match result {
        Ok(idx) => {
            json.push_str(&format!("{{\"ok\":true,\"blockIndex\":\"{idx}\"}}"));
        }
        Err(e) => {
            let (variant, detail) = transfer_error_parts(&e);
            json.push_str("{\"ok\":false,\"errVariant\":");
            push_json_str(variant, &mut json);
            json.push_str(",\"errDetail\":");
            push_json_str(&detail, &mut json);
            json.push('}');
        }
    }
    write_str_out(json.as_bytes(), out_ptr, cap)
}

#[no_mangle]
pub extern "C" fn w_icp_decode_int(arg_ptr: u32, arg_len: u32, out_ptr: u32, cap: u32) -> u32 {
    if !in_bounds(arg_ptr, arg_len) || arg_len > 512 {
        return BAD_LEN;
    }
    let arg = unsafe { slice_at(arg_ptr, arg_len) };
    match dpay_icp::icrc::decode_int(arg) {
        Ok(v) => write_str_out(v.to_string().as_bytes(), out_ptr, cap),
        Err(_) => BAD_UTF8,
    }
}

#[cfg(test)]
mod goldens {
    //! Fixed-vector goldens for the wasm parity guard (`scripts/check-wasm-core.mjs` drives the
    //! SAME inputs through the real `w_icp_*` exports and pins the SAME hex). Bytes are produced
    //! by the Rust single source (dpay-icp builders + signer) — generated here, never hand-edited.
    use dpay_icp::envelope::{envelope_request_id, sign_update, CallRequest};
    use dpay_icp::icrc::{approve_arg, transfer_arg};
    use dpay_icp::principal::{Account, Principal};

    /// Real ckBTC ledger principal (CRC-valid, stable).
    const OWNER: &str = "mxzaz-hqaaa-aaaar-qaada-cai";
    const EXPIRY: u64 = 1_800_000_300_000_000_000;

    // Pins (regenerate by reverting these consts, running with --nocapture, re-pinning —
    // the hexes below ARE the current dpay-icp single-source output for the fixed inputs).
    const TRANSFER_ARG_HEX: &str = "4449444c066c06fbca0101c6fcb60204ba89e5c20402a2de94eb060282f3f3910c05d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e780100010a000000000230000601010120abababababababababababababababababababababababababababababababab01904e0104deadbeef0120cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00d295fcf1e49df8b9c3edbfc8ee31";
    const APPROVE_ARG_HEX: &str = "4449444c066c08c6fcb60201ba89e5c20402a2de94eb060282f3f3910c04d8a38ca80d7d919c9cbf0d01dea7f7da0d04cb96dcb40e056e7d6e036d7b6e786c02b3b0dac30368ad86ca8305020100010a000120cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00ffffffffffffffffffffffffffffffffffff03012a0100b8186dbce2fa18010a000000000230000601010120efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef";
    const SIGN_ENV_HEX: &str = "d9d9f7a367636f6e74656e74a66c726571756573745f747970656463616c6c6e696e67726573735f6578706972791b18fae2bc6d18b8006673656e646572581d8063a4d954534c765fe2ffc1a1eca87da3a49ecef29d774aef160a31026b63616e69737465725f69644a000000000230000601016b6d6574686f645f6e616d656e69637263315f7472616e736665726361726758a84449444c066c06fbca0101c6fcb60204ba89e5c20402a2de94eb060282f3f3910c05d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e780100010a000000000230000601010120abababababababababababababababababababababababababababababababab01904e0104deadbeef0120cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00d295fcf1e49df8b9c3edbfc8ee316d73656e6465725f7075626b6579582c302a300506032b6570032100248acbdbaf9e050196de704bea2d68770e519150d103b587dae2d9cad53dd9306a73656e6465725f73696758406b4449e37093d8d16926035cbdf2e6f0b2d47ed422684ae1274ebafb97ccfeb6bddead475e5a5939bf66164798a159da1b843950644f847f73f3e99e4c45930c";
    const SIGN_RID_HEX: &str = "3d83e7a3f67257803e762223224a95d6e3e15191876ebd29a37202a7c4f18ddb";

    fn acct(sub: [u8; 32]) -> Account {
        Account { owner: Principal::from_text(OWNER).unwrap(), subaccount: sub }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn icp_arg_and_sign_goldens() {
        // transfer: to = OWNER+'ab'×32, from_sub = 'cd'×32, u128-scale amount, fee, memo.
        let t = transfer_arg(
            &acct([0xab; 32]),
            Some([0xcd; 32]),
            123456789012345678901234567890,
            Some(10000),
            Some(vec![0xde, 0xad, 0xbe, 0xef]),
            None,
        );
        // approve: spender = OWNER+'ef'×32, amount = u128::MAX, expected 42, fixed expiry.
        let a = approve_arg(
            Some([0xcd; 32]),
            &acct([0xef; 32]),
            Some(u128::MAX),
            Some(42),
            Some(EXPIRY),
            None,
            None,
            Some(10),
        );
        let sk = ed25519_dalek::SigningKey::from_bytes(&[0xab; 32]);
        let req = CallRequest {
            canister: Principal::from_text(OWNER).unwrap(),
            method_name: "icrc1_transfer".into(),
            arg: t.clone(),
            ingress_expiry_ns: EXPIRY,
            nonce: None,
        };
        let env = sign_update(&sk, &req);
        let rid = envelope_request_id(&env).unwrap();
        assert_eq!(hex(&t), TRANSFER_ARG_HEX);
        assert_eq!(hex(&a), APPROVE_ARG_HEX);
        assert_eq!(hex(&env), SIGN_ENV_HEX);
        assert_eq!(hex(&rid), SIGN_RID_HEX);
    }
}
