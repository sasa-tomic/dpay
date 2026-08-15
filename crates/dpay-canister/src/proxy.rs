//! Deposit / withdraw **proxy surface** for the dpay payment canister.
//!
//! Extracted from `lib.rs` along the family-gate seam (M7, paired with M6's `resolve_minter_family`
//! helper). Houses the four entry points that proxy a chain-key minter — the BTC-style deposit ramp
//! (`deposit_address` / `refresh_deposit` / `deposit_info`) and the family-dispatched withdraw ramp
//! (`withdraw`). Each carries its `#[update]` annotation; the canister macros register them into the
//! global method inventory at expansion time, so the public candid interface is byte-for-byte
//! unchanged by this module split (verified by the green test suite + a `.did` diff).
//!
//! What stays in `lib.rs` (borrowed via `crate::`): the `thread_local!` stable maps, the nonce
//! `reserve`/`release`/`settle` primitives, `ledger_for`/`minter_for`, `record_txn`, `write_cache`.
//! What lives here only: the three family-gate helpers (`resolve_minter_family` / `currency_family`
//! / `currency_gas_ledger`) that are used by EXACTLY these four entry points and nothing else.
//!
//! See `lib.rs` for the money-safety / atomicity / replay-safety invariants; this module changes
//! none of them — it is a pure source-layout refactor.

use candid::{Nat, Principal};
use ed25519_dalek::Signature;
use ic_cdk::api::time;
use ic_cdk::update;
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::TransferError;

use dpay_core::{Currency, WithdrawAuth, MEMO_LEN, NAME_LEN, NONCE_LEN, SIG_LEN};

use crate::calls::*;
use crate::types::*;
use crate::{
    ledger_for, minter_for, record_txn, release_withdraw_nonce, reserve_withdraw_nonce,
    settle_withdraw_nonce, write_cache,
};

// --- family-gate helpers (M6) ------------------------------------------------------------------
// The deposit/withdraw proxy methods all share the same family-gate preamble: resolve the currency's
// minter family (defaulting a minter-only registration to CkBtcUtxo for legacy backward compat, and
// failing closed when NEITHER a minter NOR a family is registered). These three helpers are used by
// EXACTLY the four entry points below and nothing else in the crate, so they live here next to their
// callers (M7 seam).

/// The minter family registered for a currency (M0 ramp-dispatch key). Read from `CURRENCY_META`.
/// `withdraw` reads this to dispatch to the family-specific minter method: `CkBtcUtxo` →
/// `retrieve_btc_with_approval`; `CkEthErc20` + `token_contract = None` → `withdraw_eth` (native ETH);
/// `CkEthErc20` + `token_contract = Some` → fail-closed (ckERC20 needs a separate ckETH-for-fees
/// path). `None` (no family meta registered) defaults to `CkBtcUtxo` at the single call site in
/// `withdraw` ONLY when a minter IS registered (legacy backward compat for pre-family-dispatch ckBTC
/// deployments); when NEITHER minter NOR family is registered the call site fails closed.
fn currency_family(currency: Currency) -> Option<MinterFamily> {
    crate::CURRENCY_META.with(|m| m.borrow().get(&currency).and_then(|meta| meta.minter_family))
}

/// Resolve a currency's minter family with the shared family-gate semantics. A currency with a
/// registered minter but no family meta defaults to `CkBtcUtxo` (legacy backward compat for
/// pre-family-dispatch ckBTC deployments); a currency with NEITHER minter NOR family fails closed
/// with `"currency {currency} has no minter family and no minter — {action}"`. `action` is the
/// caller-supplied tail of that error (e.g. "cannot resolve deposit_address", "cannot withdraw") so
/// the byte-identical per-call-site strings survive the dedup. Used by the deposit proxies and
/// `withdraw` so the family-gate preamble lives in exactly one place.
fn resolve_minter_family(currency: Currency, action: &str) -> Result<MinterFamily, String> {
    let has_minter = minter_for(currency).is_ok();
    match currency_family(currency) {
        Some(f) => Ok(f),
        None if has_minter => Ok(MinterFamily::CkBtcUtxo),
        None => Err(format!(
            "currency {currency} has no minter family and no minter — {action}"
        )),
    }
}

/// The ckETH gas-ledger principal registered for a ckERC20 currency (the dual-ledger `withdraw_erc20`
/// path burns ckETH gas fees from this ledger). Read from `CURRENCY_META`. `None` for non-ckERC20
/// families (BTC / native ETH / DEMO) and for a ckERC20 currency whose gas ledger is unregistered —
/// the facade fail-closes a ckERC20 withdraw with no gas ledger (cannot fall through to the native-
/// ETH `withdraw_eth` path, which would mis-burn the amount as ckETH).
fn currency_gas_ledger(currency: Currency) -> Option<Principal> {
    crate::CURRENCY_META.with(|m| m.borrow().get(&currency).and_then(|meta| meta.gas_ledger))
}

// --- ck-minter deposit proxy (ckBTC model) ----------------------------------------------------

/// `(blob pubkey, nat32 currency) -> Result<text, text>`. Proxies the minter's `get_btc_address` —
/// the user's native deposit address for the currency. No auth: a deposit address is not secret
/// (revealing it only lets someone send *to* the user), and minter methods are permissionless. Bad
/// pubkey length is rejected up front via `to_pubkey`.
#[update]
async fn deposit_address(pubkey: Vec<u8>, currency: Currency) -> Result<String, String> {
    let _pk = to_pubkey(&pubkey)?; // validate length; the minter takes the subaccount as a blob
    // FAMILY GATE: the BTC deposit proxy (`get_btc_address`) is only valid for CkBtcUtxo-family
    // minters. A CkEthErc20 minter has NO `get_btc_address` method (ckETH/ckUSDC deposits use the
    // helper-contract onramp / ckerc20 endpoint, not an IC mint trigger), so calling it would trap
    // at the minter (prod: IC0536 "Canister has no update method 'get_btc_address'"). A currency
    // with a registered minter but no family meta defaults to CkBtcUtxo (legacy backward compat);
    // one with NEITHER minter NOR family fails closed here. Mirrors the family dispatch in `withdraw`.
    let family = resolve_minter_family(currency, "cannot resolve deposit_address")?;
    if family != MinterFamily::CkBtcUtxo {
        return Err(format!(
            "deposit_address is only available for CkBtcUtxo-family currencies; {:?} deposits use the onramp/ckerc20 endpoint",
            family
        ));
    }
    let minter = minter_for(currency)?;
    minter_call_btc_address(minter, pubkey).await
}

/// `(blob pubkey, nat32 currency) -> Result<DepositRefresh, text>`. Proxies the minter's
/// `update_balance` — the value-creating call that mints confirmed UTXOs onto the currency's ledger
/// at `Account{owner: canister_self(), subaccount: pubkey}`. No auth: idempotent and safe to call by
/// anyone (a no-op when no confirmed UTXOs exist). `Ok(statuses)` -> minted list + total, empty
/// pending; `Err(NoNewUtxos{..})` -> empty minted + pending mapped from the error; the remaining
/// minter errors surface as `Err(String)`.
///
/// After a successful minter call (both the `Ok(statuses)` and the `NoNewUtxos` branches), the
/// display cache is refreshed from the authoritative ledger so a freshly-minted deposit is
/// immediately visible via `balance_of` WITHOUT an extra `refresh_balances` call (MC3 U1). The
/// `NoNewUtxos` branch is hit every 10s poll and catches coincident direct transfers / async mints
/// for free (the ~1 extra `icrc1_balance_of` per 10s-poll-per-user is negligible). The cache refresh
/// is deliberately NOT added to the AlreadyProcessing / TemporarilyUnavailable / GenericError
/// branches — the minter call FAILED there and the cache state is unknown, so we do not paper over
/// it with a speculative read.
#[update]
async fn refresh_deposit(pubkey: Vec<u8>, currency: Currency) -> Result<DepositRefresh, String> {
    let pk = to_pubkey(&pubkey)?;
    // FAMILY GATE: the BTC deposit proxy (`update_balance`) is a UTXO-confirmation model that only
    // applies to CkBtcUtxo-family minters. A CkEthErc20 minter has NO `update_balance` method
    // (ckETH/ckUSDC deposits are EVM-log-sourced by the minter's heartbeat, not pulled by the
    // facade), so calling it would trap at the minter. A currency with a registered minter but no
    // family meta defaults to CkBtcUtxo (legacy backward compat); one with NEITHER minter NOR family
    // fails closed here. Mirrors the family dispatch in `withdraw`.
    let family = resolve_minter_family(currency, "cannot resolve refresh_deposit")?;
    if family != MinterFamily::CkBtcUtxo {
        return Err(format!(
            "refresh_deposit is only available for CkBtcUtxo-family currencies; {:?} deposits use the onramp/ckerc20 endpoint",
            family
        ));
    }
    let minter = minter_for(currency)?;
    let (ledger, _) = ledger_for(currency)?;
    match minter_call_update_balance(minter, pubkey).await? {
        Ok(statuses) => {
            let mut minted = Vec::with_capacity(statuses.len());
            let mut minted_total: u64 = 0;
            for st in statuses {
                if let UtxoStatus::Minted { block_index, minted_amount, .. } = st {
                    let amount = nat_to_u64(&minted_amount)?;
                    minted_total = minted_total.checked_add(amount).ok_or("minted_total overflow")?;
                    minted.push(MintedUtxo { block_index, amount });
                }
                // Checked / ValueTooSmall / Tainted carry no mint this call; skip silently — the
                // UTXO is reported again by a subsequent `update_balance` (or never, if tainted).
            }
            // Inline cache refresh: a freshly-minted ckBTC deposit must be immediately visible via
            // `balance_of` WITHOUT an extra refresh_balances call (MC3 U1). NOT modeled on `mint`'s
            // post-mint read: `mint` hard-fails (`?`) if the re-read errors (the mint already
            // settled, so the error surfaces a now-unobservable balance); this refresh is
            // BEST-EFFORT (`if let Ok`) — a read failure leaves the cache stale but does NOT undo
            // the mint or error the call. The staleness is bounded: the NoNewUtxos branch below
            // re-reads on every 10s poll, and the relay's `BALANCE_TTL_SECS` freshness contract
            // (see dpay-relay AgentLedger) forces an authoritative `refresh_balances` within one
            // TTL window, which re-reads and overwrites the cache.
            if let Ok(bal) = ledger_balance_of(ledger, &account_of(&pk)).await {
                write_cache(pk, currency, bal);
            } else {
                crate::print_log("WARN refresh_deposit: post-mint cache refresh failed (display-only)");
            }
            Ok(DepositRefresh {
                minted,
                minted_total,
                pending: Vec::new(),
                required_confirmations: 0,
            })
        }
        Err(UpdateBalanceError::NoNewUtxos { required_confirmations, pending_utxos, .. }) => {
            let pending = pending_utxos
                .unwrap_or_default()
                .into_iter()
                .map(|p| -> Result<PendingUtxo, String> {
                    let value = nat_to_u64(&p.value)?;
                    Ok(PendingUtxo { value, confirmations: p.confirmations.unwrap_or(0) })
                })
                .collect::<Result<Vec<_>, _>>()?;
            // Inline cache refresh in the NoNewUtxos branch too: this branch is hit every 10s poll
            // and catches coincident direct transfers / async mints for free. Consistent contract:
            // "after refresh_deposit returns, the cache reflects the ledger" (MC3 U1).
            if let Ok(bal) = ledger_balance_of(ledger, &account_of(&pk)).await {
                write_cache(pk, currency, bal);
            } else {
                crate::print_log("WARN refresh_deposit: post-confirm cache refresh failed (display-only)");
            }
            Ok(DepositRefresh {
                minted: Vec::new(),
                minted_total: 0,
                pending,
                required_confirmations,
            })
        }
        Err(UpdateBalanceError::AlreadyProcessing) => {
            Err("update_balance already processing".to_string())
        }
        Err(UpdateBalanceError::TemporarilyUnavailable(m)) => {
            Err(format!("update_balance temporarily unavailable: {m}"))
        }
        Err(UpdateBalanceError::GenericError { error_code, error_message }) => Err(format!(
            "update_balance generic error{}: {error_message}",
            error_code.map(|c| format!(" (code {c})")).unwrap_or_default()
        )),
    }
}

/// `(nat32 currency) -> Result<DepositInfo, text>`. Combines the minter's `get_minter_info` and
/// `get_deposit_fee` into the normalized deposit parameters the app renders as instructions.
#[update]
async fn deposit_info(currency: Currency) -> Result<DepositInfo, String> {
    // FAMILY GATE: `get_minter_info` + `get_deposit_fee` decode against the BTC minter's `MinterInfo`
    // struct (min_confirmations / deposit_btc_min_amount). A CkEthErc20 minter returns a DIFFERENT
    // `MinterInfo` shape, so decoding would fail (prod: CandidDecodeFailed). ckETH/ckUSDC deposits
    // use the helper-contract onramp / ckerc20 endpoint, not this BTC-shaped info. A currency with a
    // registered minter but no family meta defaults to CkBtcUtxo (legacy backward compat); one with
    // NEITHER minter NOR family fails closed here. Mirrors the family dispatch in `withdraw`.
    let family = resolve_minter_family(currency, "cannot resolve deposit_info")?;
    if family != MinterFamily::CkBtcUtxo {
        return Err(format!(
            "deposit_info is only available for CkBtcUtxo-family currencies; {:?} deposits use the onramp/ckerc20 endpoint",
            family
        ));
    }
    let minter = minter_for(currency)?;
    let info = minter_call_minter_info(minter).await?;
    let deposit_fee = minter_call_deposit_fee(minter).await?;
    Ok(DepositInfo {
        min_confirmations: info.min_confirmations,
        deposit_fee,
        deposit_min_amount: info.deposit_btc_min_amount,
    })
}

// --- ck-minter withdrawal proxy (ckBTC → BTC / ckETH → ETH out) --------------------------------
// The mirror of the deposit proxy: where `refresh_deposit` mints IN confirmed BTC/ETH, `withdraw`
// burns OUT the chain-key asset to a native address. The facade is the OWNER of the ck asset held at
// `Account{owner: canister_self(), subaccount: pubkey}`, so on a VERIFIED USER SIGNATURE it
// `icrc2_approve`s the minter to pull from that subaccount, then calls the family-specific minter
// method which consumes the allowance via `icrc2_transfer_from` and sends the native asset to the
// user's address. Non-custodial: the facade moves nothing without a verified Ed25519 signature over
// the canonical [`WithdrawAuth`] bytes (single source of truth in `dpay-core`).
//
// FAMILY DISPATCH (M0): the currency's registered `minter_family` selects the minter method:
//   - CkBtcUtxo → `retrieve_btc_with_approval` (approve EXACTLY `amount`; minter burns it single-use).
//   - CkEthErc20 + token_contract None → `withdraw_eth` (approve `amount + max_transaction_fee`; the
//     minter burns `amount` immediately and the gas fee in a SEPARATE later transfer_from — ICRC-2
//     allowance is a running balance, so one approve covers both).
//   - CkEthErc20 + token_contract Some → fail-closed (ckERC20 withdraw needs a separate
//     ckETH-for-fees path; a USDC withdraw must NOT hit native-eth withdraw_eth).
// A currency with a minter but no family meta defaults to CkBtcUtxo (legacy backward compat); one
// with NEITHER minter NOR family fails closed (no withdraw ramp — e.g. DEMO play money).
//
// FRONT-RUNNING NOTE (documented residual risk, same as every retrieve_btc_with_approval /
// withdraw_eth caller): the approve + retrieve/withdraw are two cross-canister calls with an `await`
// between them. In principle a separate caller could invoke the minter with the same subaccount + an
// attacker address between the facade's approve and retrieve, consuming the allowance. The blast
// radius is bounded to the EXACT authorized `amount` (the approval is for that amount), so only one
// withdrawal's worth could be misdirected — never the user's whole balance. This is inherent to the
// ckBTC/ckETH withdrawal design (the minters have no signature-binding-the-destination path); the
// reference NNS minter clients accept the same residual. See CODEBASE_ANALYSIS risk 8.

/// `(WithdrawRequest) -> Result<WithdrawReceipt, text>` — withdraw a chain-key asset to a native
/// address on a verified user signature. The request carries the [`WithdrawAuth`] fields + the user's
/// Ed25519 signature over the canonical signing bytes; the facade verifies the signature under
/// `from_pubkey` (== the debit subaccount) before moving any funds.
///
/// Idempotency / replay safety mirrors `pay`: the withdraw nonce is reserved synchronously before any
/// cross-canister call (the concurrency barrier — two concurrent withdraws with the same nonce
/// cannot both succeed), released on a transient/pre-burn failure (the same auth may retry), and
/// settled once the burn commits (the auth can never replay → no double-burn). The family branch
/// owns its own settle/release classification of the minter's typed errors (permanent → settle the
/// dead auth; transient → release so the same auth retries).
#[update]
async fn withdraw(req: WithdrawRequest) -> Result<WithdrawReceipt, String> {
    // 1. Parse + length-validate the fields (cheap, before any signature/ledger work).
    let from = to_pubkey(&req.from_pubkey)?;
    let nonce_bytes: [u8; NONCE_LEN] = req
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| "bad nonce length".to_string())?;
    let sig_arr: [u8; SIG_LEN] = req
        .sig
        .as_slice()
        .try_into()
        .map_err(|_| "bad sig length".to_string())?;
    let sig = Signature::from_bytes(&sig_arr);

    // 2. NON-CUSTODIAL GATE: rebuild the WithdrawAuth + verify the signature BEFORE reserving the
    //    nonce or any cross-canister call. `from_pubkey` is both the verify key AND the debit
    //    subaccount, so a signature under any other key moves no funds. Checked before the nonce
    //    reserve so an attacker can't block a nonce by submitting a garbled blob.
    let auth = WithdrawAuth {
        from_pubkey: from,
        destination: req.destination.clone(),
        amount: req.amount,
        nonce: nonce_bytes,
        expiry: req.expiry,
        currency: req.currency,
    };
    if !auth.verify(&from, &sig) {
        return Err("bad signature".to_string());
    }

    let now_secs = time() / 1_000_000_000;
    // 3. Cheap local rejects (DoS hygiene before cross-canister calls cost cycles). The
    //    family-specific floor (BTC's retrieve_btc_min_amount) is applied in the family dispatch
    //    below — it does NOT apply to ETH (the ckETH minter enforces its own Wei minimum).
    if req.amount == 0 {
        return Err("zero amount".to_string());
    }
    if req.expiry < now_secs {
        return Err("expired".to_string());
    }

    // 3b. FAMILY DISPATCH: read the currency's minter family (+ token_contract / gas_ledger for
    //     ckERC20) and apply family-specific cheap rejects BEFORE reserving the nonce. A currency
    //     with a registered minter but no family meta defaults to CkBtcUtxo (legacy backward compat —
    //     the pre-family-dispatch ckBTC path). A currency with NEITHER minter NOR family (e.g. DEMO
    //     play money, offramp=Unavailable) has no withdraw ramp and MUST fail closed here — never
    //     silently route an unconfigured currency to the BTC retrieve path. ckERC20 (CkEthErc20 +
    //     token_contract Some) REQUIRES a registered ckETH gas ledger — without one the dual-ledger
    //     `withdraw_erc20` path cannot run, and the facade MUST fail closed rather than fall through
    //     to the native-ETH `withdraw_eth` (which would mis-burn the amount as ckETH).
    enum WithdrawPath {
        Btc,
        NativeEth,
        Erc20 { gas_ledger: Principal },
    }
    let family = resolve_minter_family(req.currency, "cannot withdraw")?;
    let path = match family {
        MinterFamily::CkBtcUtxo => {
            if req.amount < RETRIEVE_BTC_MIN_AMOUNT {
                return Err(format!(
                    "amount below retrieve_btc_min_amount ({RETRIEVE_BTC_MIN_AMOUNT})"
                ));
            }
            WithdrawPath::Btc
        }
        MinterFamily::CkEthErc20 => {
            let token_contract = crate::CURRENCY_META.with(|m| {
                m.borrow().get(&req.currency).and_then(|meta| meta.token_contract.clone())
            });
            if token_contract.is_some() {
                // ckERC20 (e.g. ckUSDC): dual-ledger `withdraw_erc20` path. Requires a registered
                // ckETH gas ledger (burned for Ethereum gas). No gas ledger → fail closed (the user
                // must register one before this currency is withdrawable); cannot fall through to the
                // native-ETH `withdraw_eth`.
                let gas_ledger = currency_gas_ledger(req.currency).ok_or_else(|| {
                    "withdraw_erc20 requires a ckETH gas ledger registered for this currency".to_string()
                })?;
                WithdrawPath::Erc20 { gas_ledger }
            } else {
                WithdrawPath::NativeEth
            }
        }
        MinterFamily::CkSol => {
            return Err("withdraw not supported for CkSol family".to_string());
        }
    };

    let (ledger, _mintable) = ledger_for(req.currency)?;
    let minter = minter_for(req.currency)?;
    let from_acct = account_of(&from);

    // 4. Reserve the withdraw nonce synchronously (no await) — the concurrency barrier.
    let wnonce = Nonce(nonce_bytes);
    if !reserve_withdraw_nonce(&wnonce) {
        return Err("nonce already used".to_string());
    }

    // Everything below may `await`; on any pre-burn failure we RELEASE the reservation so the user
    // may retry the SAME authorization (funds provably did not move).
    // MONEY-SAFETY: read the AUTHORITATIVE ledger balance — never the display cache.
    let balance = match ledger_balance_of(ledger, &from_acct).await {
        Ok(b) => b,
        Err(e) => {
            release_withdraw_nonce(&wnonce);
            return Err(e);
        }
    };
    if req.amount > balance {
        release_withdraw_nonce(&wnonce);
        return Err(format!(
            "{:?}",
            TransferError::InsufficientFunds { balance: Nat::from(balance) }
        ));
    }

    // 5-6. Family branch: approve → minter retrieve/withdraw. Each branch either early-returns Err
    //      (after the branch's settle/release classification of the nonce) or yields the burn's
    //      ledger block_index. Error classification mirrors `pay`'s reserve/release/settle:
    //        Ok → SETTLE the nonce (burn committed; the auth can never replay → no double-burn);
    //        transient (transport / InsufficientFunds / InsufficientAllowance / TemporarilyUnavailable
    //        / AlreadyProcessing) → RELEASE (retryable; funds did not move);
    //        permanent (MalformedAddress / AmountTooLow / RecipientAddressBlocked / GenericError /
    //        TokenNotSupported) → SETTLE (dead auth; the user must sign a fresh authorization).
    //      ckERC20 partial-failure (CkErc20LedgerError — gas burned, amount burn failed) → SETTLE
    //      (funds moved; the minter schedules a reimbursement; the auth must never replay).
    let block_index_nat = match path {
        WithdrawPath::NativeEth => {
            // NATIVE ETH: query the gas-fee estimate, approve `amount + max_transaction_fee` (a single
            // running-balance allowance covers the amount burn NOW + the gas-fee burn LATER), then call
            // `withdraw_eth`. Any pre-burn failure → RELEASE the nonce (retryable).
            let price = match minter_call_eip1559_price(minter).await {
                Ok(p) => p,
                Err(e) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(e);
                }
            };
            let spender = Account { owner: minter, subaccount: None };
            // Nat arithmetic: `amount + max_transaction_fee` cannot overflow (candid Nat is arbitrary
            // precision). The BTC path approves exactly `amount`; the ETH path adds the gas-fee cap.
            let approve_amount = Nat::from(req.amount) + price.max_transaction_fee;
            if let Err(e) = icrc2_approve(ledger, from, spender, approve_amount).await {
                release_withdraw_nonce(&wnonce);
                return Err(format!("icrc2_approve: {e}"));
            }
            let eth_arg = WithdrawalArg {
                recipient: req.destination.clone(),
                amount: Nat::from(req.amount),
                from_subaccount: Some(from.to_vec()),
            };
            match minter_call_withdraw_eth(minter, eth_arg).await {
                Ok(Ok(retrieve)) => {
                    settle_withdraw_nonce(&wnonce);
                    retrieve.block_index
                }
                Ok(Err(WithdrawalError::AmountTooLow { min_withdrawal_amount })) => {
                    // Permanent — the amount is below the minter's Wei floor. Settle the dead auth.
                    settle_withdraw_nonce(&wnonce);
                    return Err(format!(
                        "withdraw_eth amount too low (min {min_withdrawal_amount})"
                    ));
                }
                Ok(Err(WithdrawalError::InsufficientFunds { balance })) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(format!("withdraw_eth insufficient funds: balance {balance}"));
                }
                Ok(Err(WithdrawalError::InsufficientAllowance { allowance })) => {
                    // Should not happen given the approve; surfaces a fee spike between the price query
                    // and the burn. Release so the same auth retries with a fresh fee estimate.
                    release_withdraw_nonce(&wnonce);
                    return Err(format!("withdraw_eth insufficient allowance: {allowance}"));
                }
                Ok(Err(WithdrawalError::RecipientAddressBlocked { address })) => {
                    // Permanent — the recipient is blocked. Settle the dead auth.
                    settle_withdraw_nonce(&wnonce);
                    return Err(format!("withdraw_eth recipient blocked: {address}"));
                }
                Ok(Err(WithdrawalError::TemporarilyUnavailable(m))) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(format!("withdraw_eth temporarily unavailable: {m}"));
                }
                Err(transport) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(transport);
                }
            }
        }
        WithdrawPath::Erc20 { gas_ledger } => {
            // ckERC20 (e.g. ckUSDC): DUAL-ledger `withdraw_erc20` path. The minter burns ckETH gas
            // fees from `gas_ledger` + the amount from `ledger`. Approve BOTH ledgers (gas fee on the
            // ckETH ledger, amount on the ckERC20 ledger), then call `withdraw_erc20`. The amount-
            // ledger approve failure (after the gas-ledger approve succeeded) → RELEASE (retryable:
            // an approve is an allowance grant, not a burn — nothing moved). The partial-failure
            // (CkErc20LedgerError: gas burned, amount burn failed) → SETTLE (terminal; funds moved).
            let price = match minter_call_eip1559_price_erc20(minter, ledger).await {
                Ok(p) => p,
                Err(e) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(e);
                }
            };
            let spender = Account { owner: minter, subaccount: None };
            // Approve the GAS (ckETH) ledger for the gas fee.
            if let Err(e) =
                icrc2_approve(gas_ledger, from, spender, price.max_transaction_fee.clone()).await
            {
                release_withdraw_nonce(&wnonce);
                return Err(format!("icrc2_approve (gas): {e}"));
            }
            // Approve the AMOUNT (ckERC20) ledger for the withdrawal amount. A failure here → RELEASE
            // (nothing burned yet; the gas-ledger approve is just an allowance a retry overwrites).
            if let Err(e) =
                icrc2_approve(ledger, from, spender, Nat::from(req.amount)).await
            {
                release_withdraw_nonce(&wnonce);
                return Err(format!("icrc2_approve (amount): {e}"));
            }
            let erc20_arg = WithdrawErc20Arg {
                amount: Nat::from(req.amount),
                ckerc20_ledger_id: ledger,
                recipient: req.destination.clone(),
                from_cketh_subaccount: Some(from.to_vec()),
                from_ckerc20_subaccount: Some(from.to_vec()),
            };
            match minter_call_withdraw_erc20(minter, erc20_arg).await {
                Ok(Ok(retrieve)) => {
                    settle_withdraw_nonce(&wnonce);
                    // The amount-ledger burn index is the primary outcome proof for the withdrawn
                    // ckERC20 (mirrors how the ETH path returns the ckETH burn index).
                    retrieve.ckerc20_block_index
                }
                Ok(Err(WithdrawErc20Error::TokenNotSupported { .. })) => {
                    // Permanent — the ckERC20 ledger is not supported by this minter. Settle the dead auth.
                    settle_withdraw_nonce(&wnonce);
                    return Err("withdraw_erc20 token not supported by the minter".to_string());
                }
                Ok(Err(WithdrawErc20Error::RecipientAddressBlocked { address })) => {
                    // Permanent — the recipient is blocked. Settle the dead auth.
                    settle_withdraw_nonce(&wnonce);
                    return Err(format!("withdraw_erc20 recipient blocked: {address}"));
                }
                Ok(Err(WithdrawErc20Error::TemporarilyUnavailable(m))) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(format!("withdraw_erc20 temporarily unavailable: {m}"));
                }
                Ok(Err(WithdrawErc20Error::CkEthLedgerError { error })) => {
                    // The GAS burn failed → nothing moved. Classify by the inner LedgerError:
                    // transient (TemporarilyUnavailable / InsufficientFunds / InsufficientAllowance)
                    // → RELEASE (the user can fund ckETH / retry the SAME auth); permanent
                    // (AmountTooLow) → SETTLE the dead auth.
                    match error {
                        LedgerError::TemporarilyUnavailable(m) => {
                            release_withdraw_nonce(&wnonce);
                            return Err(format!(
                                "withdraw_erc20 cketh gas ledger temporarily unavailable: {m}"
                            ));
                        }
                        LedgerError::InsufficientFunds { .. } => {
                            release_withdraw_nonce(&wnonce);
                            return Err(
                                "withdraw_erc20 cketh insufficient funds: you need ckETH for gas"
                                    .to_string(),
                            );
                        }
                        LedgerError::InsufficientAllowance { .. } => {
                            release_withdraw_nonce(&wnonce);
                            return Err(
                                "withdraw_erc20 cketh insufficient allowance".to_string()
                            );
                        }
                        LedgerError::AmountTooLow { .. } => {
                            settle_withdraw_nonce(&wnonce);
                            return Err(
                                "withdraw_erc20 cketh gas amount too low".to_string()
                            );
                        }
                    }
                }
                Ok(Err(WithdrawErc20Error::CkErc20LedgerError { cketh_block_index, error })) => {
                    // PARTIAL FAILURE: the gas burn SUCCEEDED (cketh_block_index is real) but the
                    // amount burn FAILED → the minter schedules a reimbursement of the burned gas.
                    // Funds DID move (the ckETH gas debit) → TERMINAL → SETTLE the nonce so the dead
                    // auth can never replay (a retry would burn gas a second time). Surfaced as an Err
                    // (the withdrawal did not complete; the user did NOT receive their ERC-20).
                    settle_withdraw_nonce(&wnonce);
                    return Err(format!(
                        "withdraw_erc20 partial failure: ckETH gas burned (block_index {cketh_block_index}), ckERC20 amount burn failed ({error:?}); reimbursement scheduled"
                    ));
                }
                Err(transport) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(transport);
                }
            }
        }
        WithdrawPath::Btc => {
            // BTC: approve EXACTLY `amount`, then retrieve_btc_with_approval consumes it (single-use).
            let spender = Account { owner: minter, subaccount: None };
            if let Err(e) = icrc2_approve(ledger, from, spender, Nat::from(req.amount)).await {
                release_withdraw_nonce(&wnonce);
                return Err(format!("icrc2_approve: {e}"));
            }
            let retrieve_args = RetrieveBtcWithApprovalArgs {
                address: req.destination.clone(),
                amount: req.amount,
                from_subaccount: Some(from.to_vec()),
            };
            match minter_call_retrieve_btc(minter, retrieve_args).await {
                Ok(Ok(ok)) => {
                    settle_withdraw_nonce(&wnonce);
                    ok.block_index
                }
                Ok(Err(RetrieveBtcWithApprovalError::TemporarilyUnavailable(m))) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(format!("retrieve_btc transient: {m}"));
                }
                Ok(Err(RetrieveBtcWithApprovalError::AlreadyProcessing)) => {
                    release_withdraw_nonce(&wnonce);
                    return Err("retrieve_btc already processing".to_string());
                }
                Ok(Err(RetrieveBtcWithApprovalError::InsufficientFunds { balance })) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(format!("retrieve_btc insufficient funds: balance {balance}"));
                }
                Ok(Err(RetrieveBtcWithApprovalError::InsufficientAllowance { allowance })) => {
                    release_withdraw_nonce(&wnonce);
                    return Err(format!("retrieve_btc insufficient allowance: {allowance}"));
                }
                Ok(Err(e)) => {
                    // MalformedAddress / AmountTooLow / GenericError — permanent; settle the nonce so the
                    // dead auth can never replay. The user must sign a fresh authorization.
                    crate::print_log(format!("withdraw btc: retrieve_btc permanent error variant {e:?} — nonce settled"));
                    settle_withdraw_nonce(&wnonce);
                    return Err(format!("retrieve_btc: {e:?}"));
                }
                Err(transport) => {
                    // A transport/decode failure between approve and the minter's reply. Funds may or may
                    // not have moved — release is the retryable choice (matches `pay`'s transient
                    // handling); the single-use nonce keeps a successful-but-unreported burn from being
                    // driven twice by a DIFFERENT auth, and the same-auth retry reconciles via the ledger.
                    release_withdraw_nonce(&wnonce);
                    return Err(transport);
                }
            }
        }
    };

    // 7. Committed: the burn landed (or had already, via the minter). Record the withdraw in history
    //    (counterparty = the MINT_ACCOUNT sentinel, like `burn`) + refresh the display cache from the
    //    authoritative ledger.
    let settle_secs = time() / 1_000_000_000;
    record_txn(
        from,
        MINT_ACCOUNT,
        req.amount,
        nonce_bytes,
        req.currency,
        settle_secs,
        [0u8; NAME_LEN],
        [0u8; NAME_LEN],
        [0u8; MEMO_LEN],
    )?;
    if let Ok(bal) = ledger_balance_of(ledger, &from_acct).await {
        write_cache(from, req.currency, bal);
    } else {
        crate::print_log("WARN withdraw: post-burn cache refresh failed (display-only)");
    }
    Ok(WithdrawReceipt {
        from: from.to_vec(),
        destination: req.destination,
        amount: req.amount,
        nonce: nonce_bytes.to_vec(),
        currency: req.currency,
        block_index: nat_to_u64(&block_index_nat).unwrap_or_else(|e| {
            crate::print_log(format!("WARN withdraw: block_index Nat overflow ({e}) — receipt block_index coerced to 0"));
            0
        }),
    })
}
