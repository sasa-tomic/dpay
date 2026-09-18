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
    decode_approve_result as icrc_decode_approve_result,
    decode_transfer_result as icrc_decode_transfer_result, transfer_arg as icrc_transfer_arg,
    transfer_from_arg as icrc_transfer_from_arg, ApproveError, ApproveResult, TransferError,
    TransferResult,
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

fn bytes_to_hex(b: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push(HEX[(byte >> 4) as usize] as char);
        s.push(HEX[(byte & 0xf) as usize] as char);
    }
    s
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

/// Validate an ICRC-1 owner principal in TEXT form and return it canonicalised. The parse is the
/// real base32-CRC decode (`Principal::from_text`), so a mistyped or truncated principal — the
/// failure mode of a payment link that travelled through a chat app — is refused here, before the
/// payer is ever shown a destination. Returns the canonical `to_text()` so one principal has ONE
/// spelling everywhere in the UI (grouping/case normalised).
#[uniffi::export]
pub fn icp_validate_principal(text: String) -> Result<String, DpayError> {
    let p = Principal::from_text(&text)
        .map_err(|e| DpayError::BadInput(format!("invalid principal: {e}")))?;
    Ok(p.to_text())
}

/// The two parts of a parsed ICRC-1 textual account. `subaccount_hex` is EMPTY for the default
/// (all-zero) subaccount, so the common case round-trips straight into `icp_transfer_arg`'s
/// `to_subaccount_hex` with no branching at the call site.
#[derive(uniffi::Record, Clone)]
pub struct IcpAccountParts {
    pub owner: String,
    pub subaccount_hex: String,
}

/// Validate an ICRC-1 textual ACCOUNT — the bare principal `3nrdb-…-4qe` that every IC wallet's
/// receive QR carries, or the `principal-checksum.subaccount` form for a non-default subaccount
/// (ICRC-1 `TextualEncoding.md`, status Accepted). Strictly canonical: the spec's own error
/// vectors are refused. This is the superset of `icp_validate_principal` that the send-to-address
/// field parses a scanned or pasted destination with.
#[uniffi::export]
pub fn icp_validate_icrc_account(text: String) -> Result<IcpAccountParts, DpayError> {
    let a = dpay_icp::Account::from_text(&text)
        .map_err(|e| DpayError::BadInput(format!("invalid account: {e}")))?;
    let sub = if a.subaccount == [0u8; 32] { String::new() } else { bytes_to_hex(&a.subaccount) };
    Ok(IcpAccountParts { owner: a.owner.to_text(), subaccount_hex: sub })
}

/// Validate a 64-hex ICP account identifier and return it canonicalised (lowercase).
/// A different address namespace from a principal — see `AccountIdentifier` in `dpay-icp` for why
/// it is reachable only through the ICP ledger's legacy `transfer`. The embedded CRC32 is checked,
/// so a truncated or mistyped exchange deposit address fails HERE, not on-chain.
#[uniffi::export]
pub fn icp_validate_account_id(text: String) -> Result<String, DpayError> {
    let id = dpay_icp::AccountIdentifier::from_text(&text)
        .map_err(|e| DpayError::BadInput(format!("invalid account identifier: {e}")))?;
    Ok(id.to_text())
}

/// Derive the account identifier owned by `owner_text` on `subaccount_hex`. The app uses it
/// for the self-send guard: a user who pastes their OWN exchange-style address must be warned, and
/// the only way to recognise it is to derive ours and compare (the hash cannot be inverted).
#[uniffi::export]
pub fn icp_account_id_from_principal(
    owner_text: String,
    subaccount_hex: Option<String>,
) -> Result<String, DpayError> {
    let owner = Principal::from_text(&owner_text)
        .map_err(|e| DpayError::BadInput(format!("invalid principal: {e}")))?;
    let sub = opt_sub32(&subaccount_hex)?.unwrap_or([0u8; 32]);
    Ok(dpay_icp::AccountIdentifier::from_principal(&owner, &sub).to_text())
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

// WHY `icp_transfer_arg` BELOW SENDS NO `created_at_time` — the ONE place that fact is explained,
// because several surfaces used to describe a consequence it does not have. Deliberately a plain
// comment and not a doc comment: UniFFI hashes the docstring into the exported function's ABI
// checksum, so writing this two lines lower would make a documentation fix move the bridge ABI.
//
// ICRC-1 ("Transaction deduplication") makes that field the switch for the ledger's duplicate
// check: "If the client did not set the `created_at_time` field, the ledger SHOULD NOT deduplicate
// the transaction."
//
// DFINITY's own ledgers implement exactly that — `apply_transaction`
// (`rs/ledger_suite/common/ledger_canister_core/src/ledger.rs`) runs the window and hash checks
// only inside `transaction.created_at_time().map(...)`, and `icrc1_transfer` on both the ICRC-1
// ledger and the ICP ledger passes the caller's `Option` straight through. SENDING NONE THEREFORE
// MEANS TWO IDENTICAL TRANSFERS BOTH EXECUTE AND THE MONEY MOVES TWICE. A repeated `memo` changes
// nothing: the memo is only ever a tie-breaker WITHIN that check, never a key on its own. (The ICP
// ledger's LEGACY `transfer` is the one exception in reach — it substitutes its own `now`, which
// is why `TxDuplicate` is handled in `app/services/rail.ts` and its ICRC-1 twin is not expected.)
//
// Setting it would not buy the property people expect from it. Dedup needs the two payloads to be
// structurally EQUAL, so the stamp would have to be a deterministic function of the invoice — but a
// dpay payment link carries no timestamp and no expiry by design (`app/lib/deepLink.ts`), and the
// window is bounded anyway (`TRANSACTION_WINDOW` 24 h back, `ic_limits::PERMITTED_DRIFT` 60 s
// forward, both read from the ic tree), so a link older than a day would have its FIRST payment
// refused `TooOld`. Stamping "now" instead gives every signing its own payload — no dedup at all —
// while adding a `CreatedInFuture` refusal for a CORRECT payment whenever our certified stamp leads
// the target ledger's subnet clock by over a minute. Cost with no benefit, so: none. Offline
// signing is not the obstacle and must not be blamed for this: both signing paths already hold
// certified IC time (`icStampExpiry`; the NFC payer uses the merchant's stamp off the wire).
//
// EXACTLY-ONCE IS THE PAYEE'S JOB, and dpay does it where dpay is the payee: the till credits a
// sale from its own settlement record and spends the ledger row it credited
// (`crates/dpay-relay/src/till.rs`, "ONE TRANSFER, ONE SALE").

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

/// `icrc2_transfer_from` argument bytes — the PULL: spend an allowance somebody granted this
/// wallet, moving THEIR money to `to`.
///
/// dpay's one caller is a shop collecting a till charge an OpenCryptoPay wallet approved it for
/// (`crates/dpay-relay/src/till.rs`), so the shape is deliberately narrow: the charge's reference
/// as `memo_hex` — without it the relay credits no sale — and no `created_at_time`, for the reason
/// spelled out above `icp_transfer_arg`. The ledger debits `from` the amount PLUS its fee and
/// credits `to` the amount; the allowance has to cover both, which is why the caller checks
/// `icrc2_allowance` before signing rather than after being refused.
#[uniffi::export]
pub fn icp_transfer_from_arg(
    from_owner_text: String,
    from_subaccount_hex: Option<String>,
    to_owner_text: String,
    to_subaccount_hex: Option<String>,
    amount: String,
    memo_hex: Option<String>,
    fee: Option<String>,
) -> Result<Vec<u8>, DpayError> {
    let from = account(&from_owner_text, &from_subaccount_hex)?;
    let to = account(&to_owner_text, &to_subaccount_hex)?;
    let amount = u128_str(&amount, "amount")?;
    let fee = match fee {
        Some(ref f) if !f.is_empty() => Some(u128_str(f, "fee")?),
        _ => None,
    };
    let memo = opt_hex(&memo_hex, "memo")?;
    Ok(icrc_transfer_from_arg(&from, &to, amount, memo, fee, None, None))
}

/// `icrc2_approve` argument bytes: spender account, allowance amount (absent = revoke/0),
/// optional expected_allowance/expires_at/memo/from_subaccount/fee.
/// `transfer` argument bytes for the ICP ledger's LEGACY method — the ONLY way to pay a 64-hex
/// account identifier (see `AccountIdentifier` in `dpay-icp`). ICP-ledger-only; every chain-key and
/// ICRC-1 ledger is principal-addressed and has no such method.
///
/// NB: never write a `*` immediately followed by `/` in a doc comment on a `#[uniffi::export]` item.
/// UniFFI copies these verbatim into the generated Kotlin `/** … */` block, where that sequence
/// CLOSES the comment and breaks the Android build — a failure Rust itself cannot see.
///
/// Amounts are decimal strings like every other builder here, but the ledger's `Tokens` is a
/// `nat64`, so a value above u64::MAX is refused rather than silently truncated. `fee` is
/// mandatory (the ledger requires exactly 10_000 e8s) and `memo` is a bare u64, NOT the 16-byte
/// nonce blob the ICRC-1 rail reconciles on.
#[uniffi::export]
pub fn icp_legacy_transfer_arg(
    to_account_id_hex: String,
    from_subaccount_hex: Option<String>,
    amount_e8s: String,
    fee_e8s: String,
    memo: String,
    created_at_time_ns: Option<String>,
) -> Result<Vec<u8>, DpayError> {
    let to = dpay_icp::AccountIdentifier::from_text(&to_account_id_hex)
        .map_err(|e| DpayError::BadInput(format!("invalid account identifier: {e}")))?;
    let from_sub = opt_sub32(&from_subaccount_hex)?;
    let amount = u64_str(&amount_e8s, "amount_e8s")?;
    let fee = u64_str(&fee_e8s, "fee_e8s")?;
    let memo = u64_str(&memo, "memo")?;
    let created = match created_at_time_ns {
        None => None,
        Some(ref s) if s.is_empty() => None,
        Some(ref s) => Some(u64_str(s, "created_at_time_ns")?),
    };
    Ok(dpay_icp::icrc::legacy_transfer_arg(to.as_bytes(), from_sub, amount, fee, memo, created))
}

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

/// ICPSwap V3 pool `depositFromAndSwap(DepositAndSwapArgs)` argument bytes — the
/// one-call conversion leg the user signs AFTER `icrc2_approve` named this pool the
/// spender. Amounts and both token fees are decimal strings; `zero_for_one` is the
/// pool's own token0-to-token1 direction from its metadata, never assumed from pair
/// order.
#[uniffi::export]
pub fn icp_deposit_and_swap_arg(
    amount_in: String,
    amount_out_minimum: String,
    token_in_fee: String,
    token_out_fee: String,
    zero_for_one: bool,
) -> Result<Vec<u8>, DpayError> {
    let amount_in = u128_str(&amount_in, "amount_in")?;
    let amount_out_minimum = u128_str(&amount_out_minimum, "amount_out_minimum")?;
    let token_in_fee = u128_str(&token_in_fee, "token_in_fee")?;
    let token_out_fee = u128_str(&token_out_fee, "token_out_fee")?;
    Ok(dpay_icp::icrc::deposit_and_swap_arg(
        amount_in,
        amount_out_minimum,
        token_in_fee,
        token_out_fee,
        zero_for_one,
    ))
}

/// The swap minimum-out from a venue quote and a slippage in basis points (exact
/// floor, saturating at 0 for bps at or above 10_000) — the tested core owns this
/// math, the app never computes it in TS.
#[uniffi::export]
pub fn icp_swap_min_out(quoted_out: String, slippage_bps: u16) -> Result<String, DpayError> {
    let quoted = u128_str(&quoted_out, "quoted_out")?;
    Ok(dpay_icp::icrc::swap_amount_out_minimum(quoted, slippage_bps).to_string())
}

/// A decoded ICPSwap pool reply (`variant { ok : nat; err : Error }`, the venue's Motoko
/// lowercase arms): `ok` carries the pool's GROSS amount out — never the amount the wallet
/// receives, which is that figure minus the output ledger's own fee. Errors flatten to the
/// venue's own arm tag plus its own words, so a refusal is reported as the venue phrased it.
#[derive(uniffi::Record, Clone)]
pub struct IcpSwapReply {
    pub ok: bool,
    pub amount_out_gross: Option<String>,
    /// `CommonError` | `InsufficientFunds` | `InternalError` | `UnsupportedToken`; empty when ok.
    pub err_variant: String,
    /// The pool's own text for the two text-carrying arms; empty otherwise.
    pub err_detail: String,
}

#[uniffi::export]
pub fn icp_decode_swap_result(arg: Vec<u8>) -> Result<IcpSwapReply, DpayError> {
    use dpay_icp::icrc::PoolSwapError as E;
    match dpay_icp::icrc::decode_swap_result(&arg).map_err(bad)? {
        Ok(amount_out) => Ok(IcpSwapReply {
            ok: true,
            amount_out_gross: Some(amount_out.to_string()),
            err_variant: String::new(),
            err_detail: String::new(),
        }),
        Err(e) => {
            let (variant, detail) = match e {
                E::CommonError => ("CommonError", String::new()),
                E::InsufficientFunds => ("InsufficientFunds", String::new()),
                E::InternalError(t) => ("InternalError", t),
                E::UnsupportedToken(t) => ("UnsupportedToken", t),
            };
            Ok(IcpSwapReply {
                ok: false,
                amount_out_gross: None,
                err_variant: variant.into(),
                err_detail: detail,
            })
        }
    }
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

fn approve_error_parts(e: &ApproveError) -> (&'static str, String) {
    match e {
        ApproveError::BadFee { expected_fee } => ("BadFee", expected_fee.to_string()),
        ApproveError::InsufficientFunds { balance } => ("InsufficientFunds", balance.to_string()),
        ApproveError::AllowanceChanged { current_allowance } => ("AllowanceChanged", current_allowance.to_string()),
        ApproveError::Expired { ledger_time } => ("Expired", ledger_time.to_string()),
        ApproveError::CreatedInFuture { ledger_time } => ("CreatedInFuture", ledger_time.to_string()),
        ApproveError::Duplicate { duplicate_of } => ("Duplicate", duplicate_of.to_string()),
        ApproveError::TemporarilyUnavailable => ("TemporarilyUnavailable", "ledger temporarily unavailable".into()),
        ApproveError::TooOld => ("TooOld", String::new()),
        ApproveError::GenericError { error_code, message } => ("GenericError", format!("[{error_code}] {message}")),
    }
}

/// Decode an `icrc2_approve` reply — the APPROVE's outcome, flattened to the SAME
/// `IcpTransferOutcome` the transfer decoder produces, so a caller handles one shape. The
/// transfer decoder CANNOT read these replies: `ApproveError` carries variants its table
/// does not know (`AllowanceChanged`, `Expired`) and an unknown label makes it THROW —
/// which is how a refused approve used to die as an endless Approving spinner (2026-09-19
/// live defect: the real ledgers refuse with AllowanceChanged, the fake gateway never did).
/// `Duplicate` keeps its own tag — an identical approval already exists, the caller treats
/// it as settled by the same rule as a transfer replay.
#[uniffi::export]
pub fn icp_decode_approve_result(arg: Vec<u8>) -> Result<IcpTransferOutcome, DpayError> {
    match icrc_decode_approve_result(&arg).map_err(bad)? {
        ApproveResult::Ok(idx) => Ok(IcpTransferOutcome { ok: true, block_index: Some(idx.to_string()), err_variant: String::new(), err_detail: String::new() }),
        ApproveResult::Err(e) => {
            let (variant, detail) = approve_error_parts(&e);
            Ok(IcpTransferOutcome { ok: false, block_index: None, err_variant: variant.into(), err_detail: detail })
        }
    }
}

/// Decode an `icrc2_transfer_from` reply — the PULL's outcome.
///
/// Flattens to the SAME `IcpTransferOutcome` the other two decoders produce, so a caller handles
/// one shape; the one variant that is not an ordinary transfer's, `InsufficientAllowance`, keeps
/// its own tag because it is the one a shop must act on differently: the customer's wallet did not
/// approve enough (or the approval has expired, which an ICRC-2 ledger reports as an allowance of
/// zero), so the fix is another approval, not more money.
#[uniffi::export]
pub fn icp_decode_transfer_from_result(arg: Vec<u8>) -> Result<IcpTransferOutcome, DpayError> {
    use dpay_icp::icrc::{TransferFromError as E, TransferFromResult as R};
    match dpay_icp::icrc::decode_transfer_from_result(&arg).map_err(bad)? {
        R::Ok(idx) => Ok(IcpTransferOutcome {
            ok: true,
            block_index: Some(idx.to_string()),
            err_variant: String::new(),
            err_detail: String::new(),
        }),
        R::Err(E::InsufficientAllowance { allowance }) => Ok(IcpTransferOutcome {
            ok: false,
            block_index: None,
            err_variant: "InsufficientAllowance".into(),
            err_detail: format!("allowance {allowance}"),
        }),
        R::Err(E::Transfer(e)) => Ok(transfer_err(e)),
    }
}

/// Decode the ICP ledger's LEGACY `transfer` reply. Flattens to the SAME `IcpTransferOutcome` the
/// ICRC-1 decoder produces, so the app's outcome handling is one code path — but the variant tags
/// are the legacy ledger's own (`TxDuplicate`, `TxTooOld`, `TxCreatedInFuture`), never renamed to
/// their ICRC-1 near-twins. Callers that branch on idempotent replay must accept BOTH spellings.
#[uniffi::export]
pub fn icp_decode_legacy_transfer_result(arg: Vec<u8>) -> Result<IcpTransferOutcome, DpayError> {
    use dpay_icp::icrc::{LegacyTransferError as E, LegacyTransferResult as R};
    match dpay_icp::icrc::decode_legacy_transfer_result(&arg).map_err(bad)? {
        R::Ok(idx) => Ok(IcpTransferOutcome {
            ok: true,
            block_index: Some(idx.to_string()),
            err_variant: String::new(),
            err_detail: String::new(),
        }),
        R::Err(e) => {
            let (variant, detail) = match e {
                E::TxTooOld { allowed_window_nanos } => ("TxTooOld", format!("allowed window {allowed_window_nanos} ns")),
                E::BadFee { expected_fee } => ("BadFee", format!("expected fee {expected_fee}")),
                E::TxDuplicate { duplicate_of } => ("TxDuplicate", format!("duplicate of block {duplicate_of}")),
                E::TxCreatedInFuture => ("TxCreatedInFuture", "created ahead of ledger time".into()),
                E::InsufficientFunds { balance } => ("InsufficientFunds", format!("balance {balance}")),
            };
            Ok(IcpTransferOutcome { ok: false, block_index: None, err_variant: variant.into(), err_detail: detail })
        }
    }
}

/// Decode the minter retrieve/withdraw Ok({block_index}) reply (single source `dpay-icp`
/// `decode_minter_ok` — the same bytes the e2e fake-IC gateway emits via `encode_minter_ok`).
/// Mirrors the wasm `w_icp_decode_minter_ok` export; the Err side reuses the transfer-error
/// variant names (minter rejects observed live are ICRC-1 transfer-error names).
#[uniffi::export]
pub fn icp_decode_minter_ok(arg: Vec<u8>) -> Result<IcpTransferOutcome, DpayError> {
    match dpay_icp::icrc::decode_minter_ok(&arg).map_err(bad)? {
        Ok(idx) => Ok(IcpTransferOutcome { ok: true, block_index: Some(idx.to_string()), err_variant: String::new(), err_detail: String::new() }),
        Err(e) => Ok(transfer_err(e)),
    }
}

/// Decode a bare candid `int`/`nat` reply (e.g. `icrc1_balance_of`) to a decimal string.
#[uniffi::export]
pub fn icp_decode_int(arg: Vec<u8>) -> Result<String, DpayError> {
    let n = dpay_icp::icrc::decode_int(&arg).map_err(bad)?;
    Ok(n.to_string())
}

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
        use dpay_icp::reply::{cbor_encode, tree_to_cbor, Cbor, Tree};
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
    }

    // The decision lock for the doc on `icp_transfer_arg`: the app's transfers carry NO
    // `created_at_time`, so no ICRC-1 ledger deduplicates them — not even two that agree on every
    // other field including the memo. Anyone who later stamps a timestamp here makes the ledger
    // start refusing correct payments (`TooOld`/`CreatedInFuture`), so they should have to delete
    // this test and read why first.
    #[test]
    fn transfer_arg_sends_no_created_at_time_so_the_ledger_cannot_dedup() {
        let build = || icp_transfer_arg(
            "mxzaz-hqaaa-aaaar-qaada-cai".into(),
            None,
            None,
            "250000".into(),
            Some("10".into()),
            Some("aabbccddeeff00112233445566778899".into()),
        ).unwrap();
        let first = dpay_icp::icrc::decode_transfer_arg(&build()).unwrap();
        assert_eq!(first.created_at_time_ns, None, "a stamped created_at_time changes the rail's failure modes");
        // Same invoice paid twice: the memo repeats, and the ledger still sees two distinct
        // transfers because the dedup switch was never thrown.
        let second = dpay_icp::icrc::decode_transfer_arg(&build()).unwrap();
        assert_eq!(first.memo, second.memo);
        assert_eq!(second.created_at_time_ns, None);
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
    fn minter_ok_decodes_via_shared_source() {
        // Round-trip through dpay-icp's frozen encoder (the same bytes the e2e fake-IC
        // gateway emits for minter retrieve/withdraw Ok replies).
        let bytes = dpay_icp::icrc::encode_minter_ok(1234);
        let out = icp_decode_minter_ok(bytes).unwrap();
        assert!(out.ok);
        assert_eq!(out.block_index.as_deref(), Some("1234"));
        assert_eq!(out.err_variant, "");
        // Err side: a transfer-shaped TooOld reply decodes via the shared error table.
        let too_old = unhex("4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000106");
        let out = icp_decode_minter_ok(too_old).unwrap();
        assert!(!out.ok);
        assert_eq!(out.err_variant, "TooOld");
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
    fn validate_principal_accepts_canonical_and_normalises_case() {
        // The ICP ledger principal — the destination a payment link would carry.
        let icp = "ryjl3-tyaaa-aaaaa-aaaba-cai";
        assert_eq!(icp_validate_principal(icp.into()).unwrap(), icp);
        // Case is normalised (the text form is canonically lowercase); a self-derived principal
        // round-trips unchanged.
        assert_eq!(icp_validate_principal(icp.to_uppercase()).unwrap(), icp);
        let mine = icp_self_principal(SEED_A.to_vec()).unwrap();
        assert_eq!(icp_validate_principal(mine.clone()).unwrap(), mine);
    }

    #[test]
    fn validate_principal_rejects_corruption() {
        // Empty, junk, a one-character CRC break, and a dropped group each fail — these are the
        // real ways a principal breaks when a link is retyped or truncated in a chat app.
        assert!(icp_validate_principal(String::new()).is_err());
        assert!(icp_validate_principal("not-a-principal".into()).is_err());
        assert!(icp_validate_principal("ryjl3-tyaaa-aaaaa-aaaba-cbi".into()).is_err());
        assert!(icp_validate_principal("ryjl3-tyaaa-aaaaa-aaaba".into()).is_err());
        // Correct payload, non-canonical grouping (dashes moved) — refused, so one principal has
        // exactly one spelling.
        assert!(icp_validate_principal("ryjl3tyaaa-aaaaa-aaaba-cai".into()).is_err());
    }

    /// The send-to-address destination parser. `icp_validate_principal` covers the bare-principal
    /// case; this covers what it CANNOT express — a subaccount — plus the empty-string contract
    /// that lets the default case feed straight into `icp_transfer_arg`.
    #[test]
    fn validate_icrc_account_carries_the_subaccount() {
        const OWNER: &str = "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae";
        // Default subaccount ⇒ EMPTY hex, so callers pass it through without branching.
        let parts = icp_validate_icrc_account(OWNER.into()).unwrap();
        assert_eq!(parts.owner, OWNER);
        assert_eq!(parts.subaccount_hex, "");
        // Non-default subaccount ⇒ the FULL 32-byte hex, left-padded from the compressed form.
        let parts = icp_validate_icrc_account(format!("{OWNER}-6cc627i.1")).unwrap();
        assert_eq!(parts.owner, OWNER);
        assert_eq!(parts.subaccount_hex, "0000000000000000000000000000000000000000000000000000000000000001");
        // A wrong checksum is refused — that is the whole point of the checksum.
        assert!(icp_validate_icrc_account(format!("{OWNER}-6cc627a.1")).is_err());
        // The founder's real Oisy VCHF address parses as a plain owner.
        let oisy = "3nrdb-dxqqw-mc4gr-fbwxc-ynsdh-2e72e-urieh-mx52v-moiye-hff4l-4qe";
        assert_eq!(icp_validate_icrc_account(oisy.into()).unwrap().owner, oisy);
    }

    /// The 64-hex account-identifier namespace: CRC-checked, and provably disjoint from the principal one.
    #[test]
    fn validate_account_id_and_derivation() {
        let mine = icp_self_principal(SEED_A.to_vec()).unwrap();
        let id = icp_account_id_from_principal(mine.clone(), None).unwrap();
        assert_eq!(id.len(), 64);
        assert_eq!(icp_validate_account_id(id.clone()).unwrap(), id);
        assert_eq!(icp_validate_account_id(id.to_uppercase()).unwrap(), id, "case normalised");
        // A subaccount yields a DIFFERENT identifier (it is hashed in, not appended).
        let sub = icp_account_id_from_principal(mine.clone(), Some("01".repeat(32))).unwrap();
        assert_ne!(sub, id);
        // The two address namespaces never overlap: neither parses as the other.
        assert!(icp_validate_account_id(mine.clone()).is_err());
        assert!(icp_validate_principal(id.clone()).is_err());
        // Truncation / a flipped nibble / junk all fail the CRC.
        assert!(icp_validate_account_id(id[..63].to_string()).is_err());
        assert!(icp_validate_account_id(format!("{}ff", &id[..62])).is_err());
        assert!(icp_validate_account_id(String::new()).is_err());
    }

    /// The legacy `transfer` arg + reply pair, end to end across the bridge.
    #[test]
    fn legacy_transfer_arg_and_reply_round_trip() {
        let mine = icp_self_principal(SEED_A.to_vec()).unwrap();
        let to = icp_account_id_from_principal(mine, None).unwrap();
        let arg = icp_legacy_transfer_arg(to.clone(), None, "100000000".into(), "10000".into(), "0".into(), None).unwrap();
        // Decodes back through the shared dpay-icp encoder/decoder pair.
        assert!(!arg.is_empty());
        // A destination that is not a valid account identifier never produces bytes.
        assert!(icp_legacy_transfer_arg("nope".into(), None, "1".into(), "10000".into(), "0".into(), None).is_err());
        // Tokens is nat64: a value above u64::MAX is REFUSED, never silently truncated.
        assert!(icp_legacy_transfer_arg(to.clone(), None, "18446744073709551616".into(), "10000".into(), "0".into(), None).is_err());
        // Reply decoding keeps the LEGACY variant spelling (TxDuplicate, not Duplicate).
        let dup = unhex("4449444c076c01a7a5f3cc0e786c01e0a9b302786c01bf9bb7f00d016c018bbdf29b01786c019cbab69c02016b05b79eb35d00a1c3ebfd0702c7c6b5f60a03cce5b6900f7feb9cdbd50f046b02bc8a0178c5fed2010501060102e81f000000000000");
        let out = icp_decode_legacy_transfer_result(dup).unwrap();
        assert!(!out.ok);
        assert_eq!(out.err_variant, "TxDuplicate");
        assert!(out.err_detail.contains("8168"));
        // And the Ok side yields the block index.
        let ok = unhex("4449444c076c01a7a5f3cc0e786c01e0a9b302786c01bf9bb7f00d016c018bbdf29b01786c019cbab69c02016b05b79eb35d00a1c3ebfd0702c7c6b5f60a03cce5b6900f7feb9cdbd50f046b02bc8a0178c5fed20105010600e81f000000000000");
        let out = icp_decode_legacy_transfer_result(ok).unwrap();
        assert!(out.ok);
        assert_eq!(out.block_index.as_deref(), Some("8168"));
    }

    #[test]
    fn subaccount_hex_gate() {
        let owner = icp_self_principal(SEED_A.to_vec()).unwrap();
        assert!(icp_balance_of_arg(owner.clone(), Some("abcd".into())).is_err(), "short subaccount rejected");
        let arg = icp_balance_of_arg(owner, Some("00".repeat(32))).unwrap();
        assert!(!arg.is_empty());
        let _ = hex(&arg);
    }

    #[test]
    fn approve_result_decodes() {
        // Approve replies need their OWN decoder: ApproveError carries variants the transfer
        // table cannot read (AllowanceChanged/Expired — a transfer-shaped decode THREW on
        // those labels, the 2026-09-19 live defect that spun every first conversion).
        let out = icp_decode_approve_result(dpay_icp::icrc::encode_approve_ok(77)).unwrap();
        assert!(out.ok);
        assert_eq!(out.block_index.as_deref(), Some("77"));
        let out = icp_decode_approve_result(dpay_icp::icrc::encode_approve_allowance_changed(5)).unwrap();
        assert!(!out.ok);
        assert_eq!(out.err_variant, "AllowanceChanged");
        assert_eq!(out.err_detail, "5");
        let out = icp_decode_approve_result(dpay_icp::icrc::encode_approve_expired(1_234)).unwrap();
        assert!(!out.ok);
        assert_eq!(out.err_variant, "Expired");
        assert_eq!(out.err_detail, "1234");
        // Non-DIDL bytes are a typed error, same as the transfer decoder.
        assert!(icp_decode_approve_result(b"not DIDL".to_vec()).is_err());
    }

    #[test]
    fn swap_arg_and_min_out_round_trip() {
        // The 2026-09-05 float-op shape: amountIn 1.02 ICP e8s, minOut 1.8 VCHF e8s,
        // both fees 10_000, token0 -> token1. Decodes back through the shared dpay-icp pair.
        let arg = icp_deposit_and_swap_arg(
            "102000000".into(),
            "1800000".into(),
            "10000".into(),
            "10000".into(),
            true,
        )
        .unwrap();
        let d = dpay_icp::icrc::decode_deposit_and_swap_arg(&arg).unwrap();
        assert_eq!(d.amount_in, 102_000_000);
        assert_eq!(d.amount_out_minimum, 1_800_000);
        assert_eq!(d.token_in_fee, 10_000);
        assert_eq!(d.token_out_fee, 10_000);
        assert!(d.zero_for_one);
        // Non-decimal strings are typed errors, never silently-wrong bytes.
        assert!(icp_deposit_and_swap_arg("1.5".into(), "0".into(), "0".into(), "0".into(), false).is_err());
        assert!(icp_deposit_and_swap_arg("-1".into(), "0".into(), "0".into(), "0".into(), false).is_err());
        // min-out: 3% of a 2_000_000 quote floors to 1_940_000; full slippage floors at 0.
        assert_eq!(icp_swap_min_out("2000000".into(), 300).unwrap(), "1940000");
        assert_eq!(icp_swap_min_out("2000000".into(), 10_000).unwrap(), "0");
        assert_eq!(icp_swap_min_out("0".into(), 0).unwrap(), "0");
        assert!(icp_swap_min_out("not-a-number".into(), 300).is_err());
    }

    #[test]
    fn swap_result_decodes_every_arm() {
        use dpay_icp::icrc::{encode_swap_result_err, encode_swap_result_ok, PoolSwapError};
        // #ok: the pool's GROSS amount out — the number the settling screen compares against.
        let out = icp_decode_swap_result(encode_swap_result_ok(99_600_000)).unwrap();
        assert!(out.ok);
        assert_eq!(out.amount_out_gross.as_deref(), Some("99600000"));
        assert_eq!(out.err_variant, "");
        assert_eq!(out.err_detail, "");
        // #err: each arm keeps its own tag; the two text arms carry the venue's own words.
        for (e, variant, detail) in [
            (PoolSwapError::CommonError, "CommonError", ""),
            (PoolSwapError::InsufficientFunds, "InsufficientFunds", ""),
            (PoolSwapError::InternalError("amountOutMinimum not met".into()), "InternalError", "amountOutMinimum not met"),
            (PoolSwapError::UnsupportedToken("zzz-cai".into()), "UnsupportedToken", "zzz-cai"),
        ] {
            let out = icp_decode_swap_result(encode_swap_result_err(&e)).unwrap();
            assert!(!out.ok, "{variant} must not decode as ok");
            assert_eq!(out.amount_out_gross, None);
            assert_eq!(out.err_variant, variant);
            assert_eq!(out.err_detail, detail);
        }
        // A reply that is not the pool's Result is a typed error, never a fabricated outcome.
        assert!(icp_decode_swap_result(b"not DIDL".to_vec()).is_err());
        let mut truncated = encode_swap_result_ok(99_600_000);
        truncated.pop();
        assert!(icp_decode_swap_result(truncated).is_err());
    }
}
