//! Cross-canister call helpers for the dpay payment canister.
//!
//! Self-contained `async` wrappers around `Call::bounded_wait` that talk to external ICRC
//! ledgers and ck-minters. None of these touch `thread_local!` state — they take `Principal`
//! args and return decoded results. Extracted from `lib.rs` along the calls seam.

use candid::{Nat, Principal};
use ic_cdk::api::{canister_self, time};
use ic_cdk::call::Call;
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::{TransferArg, TransferError};
use icrc_ledger_types::icrc2::approve::{ApproveArgs, ApproveError};
use icrc_ledger_types::icrc3::blocks::GetBlocksRequest;
use icrc_ledger_types::icrc3::transactions::{GetTransactionsResponse, Transaction};

use crate::types::*;
use dpay_core::PUBKEY_LEN;

/// Cross-canister `icrc1_balance_of`. Returns the live (authoritative) ledger balance in minor units.
pub(crate) async fn ledger_balance_of(ledger: Principal, a: &Account) -> Result<u64, String> {
    let response = Call::bounded_wait(ledger, "icrc1_balance_of")
        .with_arg(a.clone())
        .await
        .map_err(|e| format!("icrc1_balance_of rejected: {e:?}"))?;
    let balance: Nat = response
        .candid()
        .map_err(|e| format!("icrc1_balance_of decode: {e:?}"))?;
    nat_to_u64(&balance).map_err(|_| "ledger balance overflows u64".to_string())
}

/// Cross-canister `icrc1_fee`. Each ck ledger sets its own fee, so it is read per payment rather
/// than cached — a ckBTC payment must carry ckBTC's fee, not zero.
pub(crate) async fn ledger_fee(ledger: Principal) -> Result<u64, String> {
    let response = Call::bounded_wait(ledger, "icrc1_fee")
        .await
        .map_err(|e| format!("icrc1_fee rejected: {e:?}"))?;
    let fee: Nat = response.candid().map_err(|e| format!("icrc1_fee decode: {e:?}"))?;
    nat_to_u64(&fee)
}

/// Cross-canister `icrc1_transfer`. The canister (as `from.owner`) is authorized by the ledger's
/// single-owner rule; the offline Ed25519 gate is enforced by `pay` before this is reached.
pub(crate) async fn ledger_transfer(ledger: Principal, arg: TransferArg) -> Result<Nat, TransferError> {
    let response = match Call::bounded_wait(ledger, "icrc1_transfer")
        .with_arg(arg)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Err(TransferError::GenericError {
                error_code: Nat::from(503u64),
                message: format!("icrc1_transfer rejected: {e:?}"),
            });
        }
    };
    response.candid::<Result<Nat, TransferError>>().map_err(|e| {
        TransferError::GenericError {
            error_code: Nat::from(502u64),
            message: format!("icrc1_transfer decode: {e:?}"),
        }
    })?
}

// --- ck-minter cross-canister proxies ---------------------------------------------------------
// Mirror the `ledger_*` helpers: `Call::bounded_wait(minter, "<method>").with_args(&arg).await` then
// `response.candid::<T>()`. Minter methods are permissionless (GeneralAvailability on mainnet), so
// these carry no caller gate; the facade passes `owner = Some(canister_self())`,
// `subaccount = Some(pubkey)` — so the mint lands on the currency's ledger at exactly the account
// `pay`/`balance_of` use. No new dependency surfaces: the facade stays non-custodial (it never holds
// the deposited BTC; the minter does the chain-key work and credits the ledger directly).

/// Minter `get_btc_address(record { owner, subaccount }) -> text` — the user's native deposit
/// address. The real ckBTC minter takes ONE record argument; the 1-tuple `(MinterAccount{..},)`
/// encodes exactly one argument (a record), which decodes to `{ owner, subaccount }`.
pub(crate) async fn minter_call_btc_address(minter: Principal, sub: Vec<u8>) -> Result<String, String> {
    let arg = (MinterAccount { owner: Some(canister_self()), subaccount: Some(sub) },);
    let response = Call::bounded_wait(minter, "get_btc_address")
        .with_args(&arg)
        .await
        .map_err(|e| format!("get_btc_address rejected: {e:?}"))?;
    response.candid::<String>().map_err(|e| format!("get_btc_address decode: {e:?}"))
}

/// Minter `update_balance` — the value-creating call that mints confirmed UTXOs. The real ckBTC
/// minter takes ONE record argument; the 1-tuple `(MinterAccount{..},)` encodes exactly one argument.
/// Reply is `Result<Vec<UtxoStatus>, UpdateBalanceError>`: `Ok` carries the statuses of UTXOs
/// processed this call; `Err(NoNewUtxos{..})` is the normal "nothing new, here is what is still
/// pending" response.
pub(crate) async fn minter_call_update_balance(
    minter: Principal,
    sub: Vec<u8>,
) -> Result<Result<Vec<UtxoStatus>, UpdateBalanceError>, String> {
    let arg = (MinterAccount { owner: Some(canister_self()), subaccount: Some(sub) },);
    let response = Call::bounded_wait(minter, "update_balance")
        .with_args(&arg)
        .await
        .map_err(|e| format!("update_balance rejected: {e:?}"))?;
    response
        .candid::<Result<Vec<UtxoStatus>, UpdateBalanceError>>()
        .map_err(|e| format!("update_balance decode: {e:?}"))
}

/// Minter `get_minter_info() -> MinterInfo`.
pub(crate) async fn minter_call_minter_info(minter: Principal) -> Result<MinterInfo, String> {
    let response = Call::bounded_wait(minter, "get_minter_info")
        .await
        .map_err(|e| format!("get_minter_info rejected: {e:?}"))?;
    response.candid::<MinterInfo>().map_err(|e| format!("get_minter_info decode: {e:?}"))
}

/// Minter `get_deposit_fee() -> nat64` — the per-mint fee in sats.
pub(crate) async fn minter_call_deposit_fee(minter: Principal) -> Result<u64, String> {
    let response = Call::bounded_wait(minter, "get_deposit_fee")
        .await
        .map_err(|e| format!("get_deposit_fee rejected: {e:?}"))?;
    response.candid::<u64>().map_err(|e| format!("get_deposit_fee decode: {e:?}"))
}

/// Minter `retrieve_btc_with_approval(RetrieveBtcWithApprovalArgs) -> Result<RetrieveBtcOk,
/// RetrieveBtcWithApprovalError>` — the value-creating call that burns ckBTC and sends native BTC to
/// `address`. The real ckBTC minter takes ONE record argument (verified via `dfx canister metadata
/// … candid:service --network ic`); encoded here as a 1-tuple `(args,)` so `with_args` emits exactly
/// one argument (the record). The facade passes `from_subaccount = Some(pubkey)`, so the minter pulls
/// `amount` ckBTC from `Account{owner: canister_self(), subaccount: pubkey}` via `icrc2_transfer_from`
/// (consuming the allowance the facade just set via [`icrc2_approve`]).
pub(crate) async fn minter_call_retrieve_btc(
    minter: Principal,
    args: RetrieveBtcWithApprovalArgs,
) -> Result<Result<RetrieveBtcOk, RetrieveBtcWithApprovalError>, String> {
    let arg = (args,);
    let response = Call::bounded_wait(minter, "retrieve_btc_with_approval")
        .with_args(&arg)
        .await
        .map_err(|e| format!("retrieve_btc_with_approval rejected: {e:?}"))?;
    response
        .candid::<Result<RetrieveBtcOk, RetrieveBtcWithApprovalError>>()
        .map_err(|e| format!("retrieve_btc_with_approval decode: {e:?}"))
}

/// ckETH minter `eip_1559_transaction_price(opt Eip1559TransactionPriceArg) -> Eip1559TransactionPrice`
/// (query) — the gas-fee estimate for an ETH withdrawal. Pass `opt None` (ETH, not ckERC20): the arg
/// is a 1-tuple `(Option::<Eip1559TransactionPriceArg>::None,)`. The returned `max_transaction_fee`
/// is the precomputed Wei cap the facade approves ON TOP of `amount` so the minter's later
/// gas-fee `icrc2_transfer_from` succeeds.
pub(crate) async fn minter_call_eip1559_price(minter: Principal) -> Result<Eip1559TransactionPrice, String> {
    let arg = (Option::<Eip1559TransactionPriceArg>::None,);
    let response = Call::bounded_wait(minter, "eip_1559_transaction_price")
        .with_args(&arg)
        .await
        .map_err(|e| format!("eip_1559_transaction_price rejected: {e:?}"))?;
    response
        .candid::<Eip1559TransactionPrice>()
        .map_err(|e| format!("eip_1559_transaction_price decode: {e:?}"))
}

/// ckETH minter `withdraw_eth(WithdrawalArg) -> variant { Ok : RetrieveEthRequest; Err :
/// WithdrawalError }` — the value-creating call that burns `amount` ckETH (immediately) and queues a
/// native ETH send to `recipient`. The real ckETH minter takes ONE record argument; encoded here as a
/// 1-tuple `(arg,)` so `with_args` emits exactly one argument. The variant reply decodes as a Rust
/// `Result` (candid `Ok`/`Err` variant names). The facade passes `from_subaccount = Some(pubkey)`, so
/// the minter pulls `amount` ckETH from `Account{owner: canister_self(), subaccount: pubkey}` via
/// `icrc2_transfer_from` (consuming part of the allowance the facade set via [`icrc2_approve`]); the
/// gas fee is burned in a SEPARATE later `transfer_from` against the SAME allowance.
pub(crate) async fn minter_call_withdraw_eth(
    minter: Principal,
    arg: WithdrawalArg,
) -> Result<Result<RetrieveEthRequest, WithdrawalError>, String> {
    let args = (arg,);
    let response = Call::bounded_wait(minter, "withdraw_eth")
        .with_args(&args)
        .await
        .map_err(|e| format!("withdraw_eth rejected: {e:?}"))?;
    response
        .candid::<Result<RetrieveEthRequest, WithdrawalError>>()
        .map_err(|e| format!("withdraw_eth decode: {e:?}"))
}

/// ckETH minter `eip_1559_transaction_price(opt Eip1559TransactionPriceArg) -> Eip1559TransactionPrice`
/// (query) — the gas-fee estimate for a ckERC20 withdrawal. Pass `Some(Eip1559TransactionPriceArg{
/// ckerc20_ledger_id })` (ckERC20, NOT native ETH which passes None). The returned
/// `max_transaction_fee` is the Wei cap the facade approves on the ckETH GAS ledger.
pub(crate) async fn minter_call_eip1559_price_erc20(
    minter: Principal,
    ckerc20_ledger_id: Principal,
) -> Result<Eip1559TransactionPrice, String> {
    let arg = (Some(Eip1559TransactionPriceArg { ckerc20_ledger_id }),);
    let response = Call::bounded_wait(minter, "eip_1559_transaction_price")
        .with_args(&arg)
        .await
        .map_err(|e| format!("eip_1559_transaction_price rejected: {e:?}"))?;
    response
        .candid::<Eip1559TransactionPrice>()
        .map_err(|e| format!("eip_1559_transaction_price decode: {e:?}"))
}

/// ckETH minter `withdraw_erc20(WithdrawErc20Arg) -> variant { Ok : RetrieveErc20Request; Err :
/// WithdrawErc20Error }` — the dual-ledger value-creating call that burns ckETH (gas) + ckERC20
/// (amount) and (on mainnet) sends native ERC-20 to `recipient`. Encoded as a 1-tuple `(arg,)` so
/// `with_args` emits exactly one argument (mirrors `withdraw_eth`'s 1-tuple invariant).
pub(crate) async fn minter_call_withdraw_erc20(
    minter: Principal,
    arg: WithdrawErc20Arg,
) -> Result<Result<RetrieveErc20Request, WithdrawErc20Error>, String> {
    let args = (arg,);
    let response = Call::bounded_wait(minter, "withdraw_erc20")
        .with_args(&args)
        .await
        .map_err(|e| format!("withdraw_erc20 rejected: {e:?}"))?;
    response
        .candid::<Result<RetrieveErc20Request, WithdrawErc20Error>>()
        .map_err(|e| format!("withdraw_erc20 decode: {e:?}"))
}

/// Cross-canister `icrc2_approve` — grants `spender` an allowance of `amount` from
/// `from_subaccount` on the ck ledger. The facade is the owner of `Account{owner: canister_self(),
/// subaccount: pubkey}`, so it may approve the minter to pull (via `transfer_from`) the withdrawal
/// amount. This is the ckBTC/ckETH withdrawal primitive: approve the minter, then call the minter's
/// retrieve/withdraw method which consumes the allowance. The BTC path approves EXACTLY `amount`
/// (single-use, bounded blast radius — see the front-running note on `withdraw`). The ETH path
/// approves `amount + max_transaction_fee` (Wei): the ckETH minter burns `amount` immediately and the
/// gas fee in a SEPARATE later `transfer_from`, so a single running-balance allowance covers both.
/// `amount` is a candid `Nat` (not u64) so the ETH `amount + fee` sum cannot overflow.
pub(crate) async fn icrc2_approve(
    ledger: Principal,
    from_subaccount: [u8; PUBKEY_LEN],
    spender: Account,
    amount: Nat,
) -> Result<Nat, ApproveError> {
    let arg = ApproveArgs {
        from_subaccount: Some(from_subaccount),
        spender,
        amount,
        expected_allowance: None,
        expires_at: None,
        fee: None,
        memo: None,
        created_at_time: Some(time()),
    };
    let response = match Call::bounded_wait(ledger, "icrc2_approve")
        .with_arg(arg)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Err(ApproveError::GenericError {
                error_code: Nat::from(503u64),
                message: format!("icrc2_approve rejected: {e:?}"),
            });
        }
    };
    response.candid::<Result<Nat, ApproveError>>().map_err(|e| ApproveError::GenericError {
        error_code: Nat::from(502u64),
        message: format!("icrc2_approve decode: {e:?}"),
    })?
}

/// Cross-canister `get_transactions` (the typed ICRC ledger endpoint) →
/// `(log_length, first_index, transactions)`. Uses the typed `Transaction` reply rather than
/// hand-decoding generic ICRC-3 blocks: more robust against block-layout drift, and the cached
/// `ic-icrc1-ledger` exposes it. Only the in-canister recent transactions are returned (archived
/// ranges are not paged in this bounded version).
///
/// `first_index` is the ACTUAL first block index of the returned range, captured from
/// `GetTransactionsResponse.first_index` rather than assuming it equals the requested `start`: the
/// response range may begin elsewhere once archived-range paging is in play. Callers that need to
/// derive a transaction's ledger block index MUST use `first_index + i`, never `start + i`. (Today
/// PocketIC has no archiving, so `first_index == start` always; this is the drift-safe read.)
pub(crate) async fn ledger_get_transactions(
    ledger: Principal,
    start: u64,
    length: u64,
) -> Result<(u64, u64, Vec<Transaction>), String> {
    let req = GetBlocksRequest { start: Nat::from(start), length: Nat::from(length) };
    let response = Call::bounded_wait(ledger, "get_transactions")
        .with_arg(req)
        .await
        .map_err(|e| format!("get_transactions rejected: {e:?}"))?;
    let res: GetTransactionsResponse = response
        .candid()
        .map_err(|e| format!("get_transactions decode: {e:?}"))?;
    let log_length = nat_to_u64(&res.log_length)?;
    let first_index = nat_to_u64(&res.first_index)?;
    Ok((log_length, first_index, res.transactions))
}

// --- pure helpers shared with lib.rs ----------------------------------------------------------

/// The ICRC account this canister controls for a user pubkey: the canister is the `owner`, the
/// 32-byte Ed25519 pubkey is the `subaccount`. Identical on every ledger.
pub(crate) fn account_of(pk: &[u8; PUBKEY_LEN]) -> Account {
    Account { owner: canister_self(), subaccount: Some(*pk) }
}

/// RFC 8410 DER prefix for an Ed25519 public key (SubjectPublicKeyInfo): 12 bytes, followed by
/// the 32-byte key = the 44-byte DER blob that `Principal::self_authenticating` hashes. Byte-
/// identical to `dpay_icp::principal::DER_PREFIX` — the golden-proven derivation shared with the
/// app's wasm signer and the relay's `AgentLedger::user_account` (kept inline here because the
/// canister deliberately does not depend on `dpay-icp`).
const ED25519_DER_PREFIX: [u8; 12] = [48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0];

/// The USER's own ICRC-1 account for a pubkey — the rail's addressing shape since the 2026-08-19
/// user-principal cutover (and, since the 2026-08-20 faucet re-target, the account `mint` credits):
/// `owner = self_authenticating(DER(pubkey))` (the user's principal), `subaccount = None`. This is
/// the account the app reads balances against; the facade-custody [`account_of`] shape remains
/// the `pay`/`burn` settlement surface. Derivation is byte-identical to the app's
/// `icpSelfPrincipal()` / the relay's `AgentLedger::user_account`.
pub(crate) fn user_account_of(pk: &[u8; PUBKEY_LEN]) -> Account {
    let mut der = [0u8; 44];
    der[..12].copy_from_slice(&ED25519_DER_PREFIX);
    der[12..].copy_from_slice(pk);
    Account { owner: Principal::self_authenticating(&der), subaccount: None }
}

pub(crate) fn to_pubkey(v: &[u8]) -> Result<[u8; PUBKEY_LEN], String> {
    v.try_into().map_err(|_| "bad pubkey length".to_string())
}

pub(crate) fn nat_to_u64(n: &Nat) -> Result<u64, String> {
    num_traits::ToPrimitive::to_u64(&n.0).ok_or_else(|| "nat overflows u64".to_string())
}

/// `created_at_time` for a `pay` transfer, quantized to a coarse bucket. The ICRC ledger dedups
/// transfers whose `(from_subaccount, to, amount, fee, created_at_time, memo)` all match; `memo` is
/// the nonce (unique per authorization), so distinct authorizations never collide. Quantizing the
/// timestamp makes a *retry of the same authorization* within one bucket share `created_at_time`, so
/// the ledger returns `Duplicate` → our success branch → no second debit. Defense-in-depth for the
/// relay-retry path.
pub(crate) const DEDUP_BUCKET_SECS: u64 = 60;
pub(crate) fn dedup_created_at_time() -> u64 {
    let now_ns = time();
    let bucket_ns = DEDUP_BUCKET_SECS * 1_000_000_000;
    (now_ns / bucket_ns) * bucket_ns
}
