//! Test-only mock of the ckBTC minter — for offline PocketIC deposit proofs.
//!
//! This is a **build/test artifact, never shipped to mainnet** (the real ckBTC minter is used there).
//! It implements the ckBTC minter's deposit surface so the canister-tests can prove the full
//! deposit → mint → balance flow end-to-end on a real `ic-icrc1-ledger`, with no network.
//!
//! The mock OWNS the ledger's minting account: the test installs the ICRC ledger with
//! `minting_account.owner = mock_minter`, so the mock mints by calling `icrc1_transfer` with
//! `from_subaccount: None` (the minting account's default subaccount). The mint lands at
//! `Account{owner, subaccount}` — exactly where the facade's `pay`/`icrc1_balance_of` already
//! operate, so the proof needs no facade change.
//!
//! The candid field LABELS here match the real ckBTC minter; the facade decodes the replies with
//! `candid::Reserved` for sub-records it does not surface, so variant/field NAMES are load-bearing.
//!
//! Methods:
//! - `get_btc_address` → deterministic fake `bc1qmock…` text derived from `hash(owner || subaccount)`.
//! - `register_deposit` → test-only hook that seeds a pending deposit.
//! - `update_balance` → drains the pending deposit: mints via `icrc1_transfer`, returns
//!   `[Minted{block_index, minted_amount}]`, clears the entry. No pending → `Err(NoNewUtxos{…})`.
//! - `get_minter_info` → `MinterInfo{min_confirmations:1, deposit_btc_min_amount:Some(0), …}`.
//! - `get_deposit_fee` → `0`. `get_known_utxos` → `[]`.

use candid::{CandidType, Nat, Principal};
use ic_cdk::api::{canister_self, msg_caller, time};
use ic_cdk::call::Call;
use ic_cdk::{init, query, update};
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::{TransferArg, TransferError};
use icrc_ledger_types::icrc2::transfer_from::{TransferFromArgs, TransferFromError};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::BTreeMap;

// --- candid types (field labels mirror the real ckBTC minter; the facade decodes these) --------
// `utxo`/`suspended_utxos` are concrete here (we are the PRODUCER); the facade decodes them as
// `candid::Reserved`, so their internal fields are never validated across the wire.

#[derive(CandidType, Deserialize)]
struct Utxo {
    outpoint: OutPoint,
    value: Nat,
    confirmations: Option<Nat>,
}
#[derive(CandidType, Deserialize)]
struct OutPoint {
    txid: Vec<u8>,
    vout: u32,
}

#[derive(CandidType, Deserialize)]
enum UtxoStatus {
    Minted { block_index: Nat, minted_amount: Nat, utxo: Utxo },
    Checked(Utxo),
    ValueTooSmall(Utxo),
    Tainted(Utxo),
}

#[derive(CandidType, Deserialize)]
struct PendingUtxo {
    outpoint: OutPoint,
    value: Nat,
    confirmations: Option<Nat>,
}

#[derive(CandidType, Deserialize)]
enum UpdateBalanceError {
    NoNewUtxos {
        current_confirmations: Option<u64>,
        required_confirmations: u32,
        pending_utxos: Option<Vec<PendingUtxo>>,
        suspended_utxos: Option<Vec<PendingUtxo>>,
    },
    AlreadyProcessing,
    TemporarilyUnavailable(String),
    GenericError { error_code: Option<Nat>, error_message: String },
}

#[derive(CandidType, Deserialize)]
struct MinterInfo {
    min_confirmations: u32,
    retrieve_btc_min_amount: u64,
    kyt_fee: u64,
    deposit_btc_min_amount: Option<u64>,
    /// The ckETH-family CkDeposit helper-contract address (`opt text` on the REAL ckETH minter's
    /// `MinterInfo`, verified against the live `sv3dd-oaaaa-aaaar-qacoa-cai` candid:service). The
    /// real ckBTC minter's `MinterInfo` has NO such field, and the facade's BTC-shaped decode
    /// DROPS unknown fields (candid record subtyping), so adding it here is wire-compatible with
    /// every existing consumer. `None` by default (the BTC-shaped default); the
    /// `set_deposit_helper_address` test hook sets it so the relay's live
    /// runtime-helper-read test (`dpay-relay/tests/live.rs`) has a sentinel to observe.
    deposit_with_subaccount_helper_contract_address: Option<String>,
}

/// `RetrieveBtcWithApprovalArgs` — the EXACT argument record the REAL ckBTC minter's
/// `retrieve_btc_with_approval` takes, verified against `dfx canister metadata
/// mqygn-kiaaa-aaaar-qaadq-cai candid:service --network ic`:
///   `record { address : text; amount : nat64; from_subaccount : opt blob }`.
/// The mock's candid surface MUST match the real minter's exactly (single record arg, NOT positional
/// args) so a facade that diverges is caught by the PocketIC withdraw test — the test that this mock
/// makes honest (the mirror-the-real-counterparty lesson; see CODEBASE_ANALYSIS).
#[derive(CandidType, Deserialize)]
struct RetrieveBtcWithApprovalArgs {
    address: String,
    amount: u64,
    from_subaccount: Option<Vec<u8>>,
}

/// `RetrieveBtcOk` — the real minter's success record: `record { block_index : nat64 }` (the burn
/// transaction index on the ckBTC ledger). The facade surfaces this to the app as the withdrawal's
/// outcome proof.
#[derive(CandidType, Deserialize)]
struct RetrieveBtcOk {
    block_index: Nat,
}

/// `RetrieveBtcWithApprovalError` — the real minter's error variant for `retrieve_btc_with_approval`.
/// Field labels + variant names mirror the real minter's candid exactly (verified via `dfx canister
/// metadata … candid:service --network ic`), so the facade's decode is wire-compatible with mainnet.
#[derive(CandidType, Deserialize)]
enum RetrieveBtcWithApprovalError {
    MalformedAddress(String),
    AlreadyProcessing,
    AmountTooLow(u64),
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    TemporarilyUnavailable(String),
    GenericError { error_message: String, error_code: Nat },
}

/// The single record argument the REAL ckBTC minter takes for `get_btc_address` / `update_balance` /
/// `get_known_utxos` — verified against `dfx canister metadata mqygn-kiaaa-aaaar-qaadq-cai
/// candid:service --network ic`:
///   `(record { owner: opt principal; subaccount : opt blob })`.
/// This mock's candid surface MUST match the real minter's exactly (single record arg, NOT two
/// positional args) so a facade that diverges is caught by the PocketIC deposit test — the test that
/// this mock makes honest.
#[derive(CandidType, Deserialize)]
struct AccountArg {
    owner: Option<Principal>,
    subaccount: Option<Vec<u8>>,
}

// --- init ---------------------------------------------------------------------------------------

#[derive(CandidType, Deserialize)]
struct InitArg {
    /// The ledger this mock operates on. For the ckBTC/ckETH surfaces this is the SINGLE ledger the
    /// mock burns from (`retrieve_btc_with_approval` / `withdraw_eth`). For the ckERC20 surface
    /// (`withdraw_erc20`) this is the **amount ledger** (e.g. ckUSDC) — the gas ledger is `gas_ledger`.
    /// Renamed from `ledger` for clarity; the legacy single-ledger tests pass `gas_ledger: None`.
    amount_ledger: Principal,
    /// The ckETH gas ledger a `withdraw_erc20` burns gas fees from. `None` for the single-ledger
    /// surfaces (ckBTC/ckETH native) → `withdraw_erc20` returns `TokenNotSupported` (no dual-ledger
    /// path is configured). `Some(cketh)` for a ckERC20 minter.
    gas_ledger: Option<Principal>,
}

thread_local! {
    /// The ICRC ledger this mock mints/burns onto (the amount ledger for ckERC20). The test installs
    /// the ledger with `minting_account.owner = mock_minter`, so the mock is authorized to mint from
    /// that account's default subaccount. Sentinel `management_canister` until overwritten by `init`.
    static LEDGER: RefCell<Principal> = RefCell::new(Principal::management_canister());

    /// The ckETH gas ledger a `withdraw_erc20` burns gas fees from. Sentinel `management_canister`
    /// when `None` was passed at init → `withdraw_erc20` returns `TokenNotSupported`.
    static GAS_LEDGER: RefCell<Principal> = RefCell::new(Principal::management_canister());

    /// Pending deposits keyed by `(owner, subaccount)`. `register_deposit` seeds an entry;
    /// `update_balance` drains it (one mint) and removes it. `subaccount` is the 32-byte pubkey blob
    /// the facade passes.
    static PENDING: RefCell<BTreeMap<(Principal, Vec<u8>), u64>> = RefCell::new(BTreeMap::new());

    /// Test-only hook: when set, the NEXT `withdraw_erc20` burns the ckETH gas fee (succeeds) then
    /// returns `CkErc20LedgerError` (partial failure → minter schedules reimbursement). Cleared after
    /// one call. Models the real minter's "gas burned, amount burn failed" terminal state.
    static FORCE_NEXT_ERC20_PARTIAL: RefCell<bool> = RefCell::new(false);

    /// Test-only hook: the `deposit_with_subaccount_helper_contract_address` served by
    /// `get_minter_info` (None by default). Set via `set_deposit_helper_address` — mirrors the
    /// real ckETH minter, whose live `get_minter_info` carries the CURRENT CkDeposit helper
    /// address (it changes on minter/helper upgrades). Lets the relay's live test prove the
    /// runtime read with a sentinel that exists nowhere in the relay's compiled constants.
    static DEPOSIT_HELPER_ADDRESS: RefCell<Option<String>> = RefCell::new(None);
}

#[init]
fn init(arg: InitArg) {
    LEDGER.with(|l| *l.borrow_mut() = arg.amount_ledger);
    if let Some(g) = arg.gas_ledger {
        GAS_LEDGER.with(|gl| *gl.borrow_mut() = g);
    }
}

/// Minter `get_btc_address(record { owner: opt principal; subaccount: opt blob }) -> text`. The real
/// ckBTC minter takes ONE record argument (verified via `dfx canister metadata … candid:service`);
/// this mock mirrors that surface exactly. Returns a deterministic fake address derived from
/// `owner || subaccount` — clearly fake (`bc1qmock` prefix) but stable and distinct per distinct
/// `(owner, subaccount)`. `owner` defaults to the caller; the facade passes `Some(facade)`.
#[update]
fn get_btc_address(arg: AccountArg) -> String {
    let owner = arg.owner.unwrap_or_else(msg_caller);
    let sub = arg.subaccount.unwrap_or_default();
    derive_btc_address(owner, &sub)
}

/// Minter `update_balance(record { owner: opt principal; subaccount: opt blob })` — the
/// value-creating call. The real ckBTC minter takes ONE record argument; this mock mirrors that
/// surface exactly. For the pending deposit keyed by `(owner, subaccount)`, mints `amount` onto the
/// ledger at `Account{owner, subaccount}` via `icrc1_transfer` from the minting account, returns
/// `[Minted{…}]`, and clears the entry. No pending deposit → `Err(NoNewUtxos{…})`. `owner` defaults
/// to the caller; the facade passes `Some(facade)`.
#[update]
async fn update_balance(arg: AccountArg) -> Result<Vec<UtxoStatus>, UpdateBalanceError> {
    let owner = arg.owner.unwrap_or_else(msg_caller);
    let sub = arg.subaccount.unwrap_or_default();
    // Read + copy out synchronously so no RefCell borrow is held across the `await` below.
    let amount = match PENDING.with(|p| p.borrow().get(&(owner, sub.clone())).copied()) {
        None => {
            return Err(UpdateBalanceError::NoNewUtxos {
                current_confirmations: Some(0),
                required_confirmations: 1,
                pending_utxos: None,
                suspended_utxos: None,
            });
        }
        Some(a) => a,
    };

    let ledger = LEDGER.with(|l| *l.borrow());
    // An ICRC subaccount is exactly 32 bytes; the facade always passes the 32-byte pubkey. The
    // minter's candid surface is `(opt blob)`, so convert here rather than at the signature.
    let sub_arr: [u8; 32] = sub.as_slice().try_into().map_err(|_| UpdateBalanceError::GenericError {
        error_code: Some(Nat::from(400u64)),
        error_message: "subaccount is not a valid 32-byte ICRC subaccount".to_string(),
    })?;
    let arg = TransferArg {
        from_subaccount: None, // the mock owns the ledger's minting account (default subaccount)
        to: Account { owner, subaccount: Some(sub_arr) },
        amount: Nat::from(amount),
        fee: None, // mints carry no fee
        created_at_time: Some(time()),
        memo: None,
    };
    let response = match Call::bounded_wait(ledger, "icrc1_transfer").with_arg(arg).await {
        Ok(r) => r,
        Err(e) => {
            return Err(UpdateBalanceError::GenericError {
                error_code: Some(Nat::from(503u64)),
                error_message: format!("icrc1_transfer rejected: {e:?}"),
            });
        }
    };
    match response.candid::<Result<Nat, TransferError>>() {
        Ok(Ok(block_index)) => {
            // Deposit settled: drop the pending entry so a second `update_balance` is a no-op.
            PENDING.with(|p| {
                p.borrow_mut().remove(&(owner, sub.clone()));
            });
            let utxo = Utxo {
                outpoint: OutPoint { txid: vec![0u8; 32], vout: 0 },
                value: Nat::from(amount),
                confirmations: Some(Nat::from(1u64)),
            };
            Ok(vec![UtxoStatus::Minted {
                block_index,
                minted_amount: Nat::from(amount),
                utxo,
            }])
        }
        Ok(Err(te)) => Err(UpdateBalanceError::GenericError {
            error_code: Some(Nat::from(502u64)),
            error_message: format!("icrc1_transfer error: {te:?}"),
        }),
        Err(e) => Err(UpdateBalanceError::GenericError {
            error_code: Some(Nat::from(502u64)),
            error_message: format!("icrc1_transfer decode: {e:?}"),
        }),
    }
}

/// Test-only hook: seed a pending deposit for `(owner, subaccount)` so the next `update_balance`
/// mints `amount` onto the ledger.
#[update]
fn register_deposit(owner: Principal, subaccount: Vec<u8>, amount: u64) {
    PENDING.with(|p| {
        p.borrow_mut().insert((owner, subaccount), amount);
    });
}

/// Minter `get_minter_info() -> MinterInfo`. Mirrors the LIVE ckBTC minter's `MinterInfo`
/// (`get_minter_info` on `mqygn-kiaaa-aaaar-qaadq-cai` returns `min_confirmations`, `kyt_fee`,
/// `deposit_btc_min_amount`, AND `retrieve_btc_min_amount = 50000`). The mock keeps `retrieve_btc_min_amount`
/// at the SAME 50_000 sats so the withdraw path is faithful: a below-min withdrawal is rejected by the
/// minter with `AmountTooLow` exactly as on mainnet (and the facade mirrors the same floor locally).
#[query]
fn get_minter_info() -> MinterInfo {
    MinterInfo {
        min_confirmations: 1,
        retrieve_btc_min_amount: 50_000,
        kyt_fee: 0,
        deposit_btc_min_amount: Some(0),
        deposit_with_subaccount_helper_contract_address: DEPOSIT_HELPER_ADDRESS
            .with(|h| h.borrow().clone()),
    }
}

/// Test-only hook: set the `deposit_with_subaccount_helper_contract_address` served by
/// `get_minter_info`. The relay's agent-path ckERC20 onramp reads this field at RUNTIME from the
/// currency's registered minter; this hook gives the PocketIC live test a sentinel value that
/// provably arrives from the wire (it matches no compiled-in constant).
#[update]
fn set_deposit_helper_address(address: String) {
    DEPOSIT_HELPER_ADDRESS.with(|h| *h.borrow_mut() = Some(address));
}

/// The minimal withdrawal amount this mock will honor, in sats. Mirrors the LIVE ckBTC minter's
/// `retrieve_btc_min_amount` (50_000), so the mock's `AmountTooLow` behavior matches mainnet exactly.
/// Single-sourced here so the facade's local pre-check + the mock's enforcement can't drift.
const RETRIEVE_BTC_MIN_AMOUNT: u64 = 50_000;

/// Minter `retrieve_btc_with_approval(RetrieveBtcWithApprovalArgs) -> Result<RetrieveBtcOk,
/// RetrieveBtcWithApprovalError>` — the value-creating call that burns ckBTC and (on mainnet) sends
/// native BTC to `address`. The real ckBTC minter takes exactly ONE record argument (verified via
/// `dfx canister metadata … candid:service --network ic`); this mock mirrors that surface exactly.
///
/// Settlement: the caller (the facade) has already called `icrc2_approve` granting THIS minter an
/// allowance over `Account{owner: caller, subaccount: from_subaccount}`. The mock consumes it via
/// `icrc2_transfer_from`, pulling `amount` ckBTC from that subaccount to the mock's own default
/// account (the burn sink — on mainnet the minter then burns it; the net ledger effect, a debit of
/// `amount` + fee from the user's subaccount, is identical). This is the SAME mechanism the real
/// minter uses, so the facade's approve→retrieve wiring is proven end-to-end offline.
///
/// Errors mirror the real minter's `RetrieveBtcWithApprovalError` variants: `MalformedAddress` (empty
/// address — a stand-in for the real minter's full BTC-address parse), `AmountTooLow`
/// (`amount < RETRIEVE_BTC_MIN_AMOUNT`), `InsufficientAllowance`/`InsufficientFunds` (mapped from the
/// ledger's `transfer_from` errors), and `GenericError` for transport/decode failures.
#[update]
async fn retrieve_btc_with_approval(
    args: RetrieveBtcWithApprovalArgs,
) -> Result<RetrieveBtcOk, RetrieveBtcWithApprovalError> {
    // Minimal address validation: the real minter parses a full BTC address; the mock only rejects
    // the clearly-invalid empty case (enough to exercise the MalformedAddress path offline).
    if args.address.trim().is_empty() {
        return Err(RetrieveBtcWithApprovalError::MalformedAddress(
            "address is empty".to_string(),
        ));
    }
    if args.amount < RETRIEVE_BTC_MIN_AMOUNT {
        return Err(RetrieveBtcWithApprovalError::AmountTooLow(RETRIEVE_BTC_MIN_AMOUNT));
    }
    // The facade always passes a 32-byte subaccount (the user pubkey). Coerce to a fixed ICRC
    // subaccount; a wrong length is a generic (permanent) error.
    let sub_vec = args.from_subaccount.unwrap_or_default();
    let sub_arr: [u8; 32] = sub_vec.as_slice().try_into().map_err(|_| {
        RetrieveBtcWithApprovalError::GenericError {
            error_message: "from_subaccount is not a valid 32-byte ICRC subaccount".to_string(),
            error_code: Nat::from(400u64),
        }
    })?;
    let caller = msg_caller();
    let ledger = LEDGER.with(|l| *l.borrow());
    // The minter pulls ckBTC from the user's subaccount (via the allowance the facade set) and BURNS
    // it — the faithful ckBTC retrieve semantics. On mainnet the ckBTC minter IS the ckBTC ledger's
    // minting-account owner, so a transfer to its default account burns (removes from supply); the
    // mock is installed the same way (`minting_account.owner = mock`). The net ledger effect — a
    // debit of `amount` from `Account{facade, subaccount}` and a matching reduction in total supply —
    // is identical to mainnet, which is what the facade's wiring proof needs.
    let self_id = canister_self();
    let arg = TransferFromArgs {
        spender_subaccount: None, // the mock is the spender (its default subaccount)
        from: Account { owner: caller, subaccount: Some(sub_arr) },
        to: Account { owner: self_id, subaccount: None }, // minting account → burn
        amount: Nat::from(args.amount),
        fee: None,
        memo: None,
        created_at_time: Some(time()),
    };
    let response = match Call::bounded_wait(ledger, "icrc2_transfer_from")
        .with_arg(arg)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Err(RetrieveBtcWithApprovalError::GenericError {
                error_message: format!("icrc2_transfer_from rejected: {e:?}"),
                error_code: Nat::from(503u64),
            });
        }
    };
    match response.candid::<Result<Nat, TransferFromError>>() {
        Ok(Ok(block_index)) => Ok(RetrieveBtcOk { block_index }),
        Ok(Err(TransferFromError::InsufficientAllowance { allowance })) => {
            Err(RetrieveBtcWithApprovalError::InsufficientAllowance { allowance })
        }
        Ok(Err(TransferFromError::InsufficientFunds { balance })) => {
            Err(RetrieveBtcWithApprovalError::InsufficientFunds { balance })
        }
        Ok(Err(TransferFromError::TemporarilyUnavailable)) => {
            Err(RetrieveBtcWithApprovalError::TemporarilyUnavailable(
                "ledger temporarily unavailable".to_string(),
            ))
        }
        Ok(Err(e)) => Err(RetrieveBtcWithApprovalError::GenericError {
            error_message: format!("icrc2_transfer_from error: {e}"),
            error_code: Nat::from(502u64),
        }),
        Err(e) => Err(RetrieveBtcWithApprovalError::GenericError {
            error_message: format!("icrc2_transfer_from decode: {e:?}"),
            error_code: Nat::from(502u64),
        }),
    }
}

/// Minter `get_deposit_fee() -> nat64`. Zero — the mock charges no mint fee.
#[query]
fn get_deposit_fee() -> u64 {
    0
}

// --- ckETH-minter withdraw surface (native ckETH → ETH out) -----------------------------------
// Mirror types + the two methods the REAL ckETH minter exposes for native-ETH withdrawal, verified
// against `dfx canister metadata sv3dd-oaaaa-aaaar-qacoa-cai candid:service --network ic` (the .did
// is cached at /tmp/opencode/cketh-minter.did):
//   `eip_1559_transaction_price : (opt Eip1559TransactionPriceArg) -> (Eip1559TransactionPrice) query`
//   `withdraw_eth : (WithdrawalArg) -> (variant { Ok : RetrieveEthRequest; Err : WithdrawalError })`
// Field/variant labels mirror the real minter exactly so a facade that diverges is caught by the
// PocketIC withdraw_eth test. The mock reuses the SAME ledger it was init'd with (the test points it
// at the ckETH ledger), so it serves both the BTC and ETH withdraw surfaces depending on the ledger.

/// `WithdrawalArg` — the EXACT argument record the REAL ckETH minter's `withdraw_eth` takes:
///   `record { recipient : text; amount : nat; from_subaccount : opt blob }`.
#[derive(CandidType, Deserialize)]
struct WithdrawalArg {
    recipient: String,
    amount: Nat,
    from_subaccount: Option<Vec<u8>>,
}

/// `RetrieveEthRequest` — the real minter's success record: `record { block_index : nat }` (the burn
/// transaction index on the ckETH ledger).
#[derive(CandidType, Deserialize)]
struct RetrieveEthRequest {
    block_index: Nat,
}

/// `WithdrawalError` — the real ckETH minter's error variant for `withdraw_eth`. Variant + field
/// labels mirror the real minter's candid exactly so the facade's decode is wire-compatible.
#[derive(CandidType, Deserialize, Debug)]
enum WithdrawalError {
    AmountTooLow { min_withdrawal_amount: Nat },
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    RecipientAddressBlocked { address: String },
    TemporarilyUnavailable(String),
}

/// `Eip1559TransactionPriceArg` — when `Some`, the real minter looks up the price for a ckERC20
/// withdrawal; `None` (passed by the facade for ETH) means native-ETH withdrawal.
#[derive(CandidType, Deserialize)]
struct Eip1559TransactionPriceArg {
    ckerc20_ledger_id: Principal,
}

/// `Eip1559TransactionPrice` — the real minter's gas-fee estimate record. `max_transaction_fee` is
/// the precomputed Wei cap the facade approves on top of `amount`.
#[derive(CandidType, Deserialize)]
struct Eip1559TransactionPrice {
    gas_limit: Nat,
    max_fee_per_gas: Nat,
    max_priority_fee_per_gas: Nat,
    max_transaction_fee: Nat,
    timestamp: Option<u64>,
}

/// The minimal ckETH withdrawal amount this mock honors, in Wei. Mirrors the real ckETH minter's
/// `minimum_withdrawal_amount` (an `InitArg` field on mainnet) so the mock's `AmountTooLow` behavior
/// matches mainnet exactly. Small (1_000 Wei) so the wiring proof stays readable; the facade relies
/// on the minter to enforce the ETH floor (no local Wei constant that could drift).
const MIN_WITHDRAWAL_ETH_AMOUNT: u64 = 1_000;

/// Minter `eip_1559_transaction_price(opt Eip1559TransactionPriceArg) -> Eip1559TransactionPrice`
/// (query). Returns a fixed small fee. When `arg` is `None` (native ETH) the gas limit is 21_000 (a
/// plain ETH transfer); when `arg` is `Some(ckerc20_ledger_id)` (a ckERC20 withdrawal) the gas limit
/// is 60_000 (an ERC-20 transfer costs more — the real minter returns a higher estimate here). Both
/// at 10 gwei. The real minter queries live mainnet gas; the mock returns a constant — enough to
/// prove the facade's dual-approve wiring. Honoring the `Some` arg lets the PocketIC honesty test
/// assert the facade passes `Some(ckerc20_ledger_id)` for ckERC20 (NOT `None`, which would hit the
/// native-ETH price path).
#[query]
fn eip_1559_transaction_price(arg: Option<Eip1559TransactionPriceArg>) -> Eip1559TransactionPrice {
    // ckERC20 transfer ≈ 60k gas; native ETH send = 21k. The arg's presence is the dispatch signal.
    let gas_limit: u64 = if arg.is_some() { 60_000 } else { 21_000 };
    Eip1559TransactionPrice {
        gas_limit: Nat::from(gas_limit),
        max_fee_per_gas: Nat::from(10_000_000_000u64),
        max_priority_fee_per_gas: Nat::from(1_000_000_000u64),
        max_transaction_fee: Nat::from(gas_limit * 10_000_000_000u64),
        timestamp: None,
    }
}

/// Minter `withdraw_eth(WithdrawalArg) -> Result<RetrieveEthRequest, WithdrawalError>` — the
/// value-creating call that burns ckETH and (on mainnet) sends native ETH to `recipient`. Mirrors the
/// mock's `retrieve_btc_with_approval` exactly: validate recipient + min, then `icrc2_transfer_from`
/// of `amount` from the caller's subaccount. The mock IGNORES the gas fee for the wiring proof — it
/// consumes only `amount` (the fee approval lands as leftover allowance, which is correct: ICRC-2
/// allowance is a running balance). Settlement mechanics identical to `retrieve_btc_with_approval`
/// (the mock is the ledger's minting-account owner, so a transfer to its default account burns).
#[update]
async fn withdraw_eth(arg: WithdrawalArg) -> Result<RetrieveEthRequest, WithdrawalError> {
    if arg.recipient.trim().is_empty() {
        return Err(WithdrawalError::TemporarilyUnavailable("recipient is empty".to_string()));
    }
    let min = Nat::from(MIN_WITHDRAWAL_ETH_AMOUNT);
    if arg.amount < min {
        return Err(WithdrawalError::AmountTooLow { min_withdrawal_amount: min });
    }
    let sub_vec = arg.from_subaccount.unwrap_or_default();
    let sub_arr: [u8; 32] = sub_vec.as_slice().try_into().map_err(|_| {
        WithdrawalError::TemporarilyUnavailable(
            "from_subaccount is not a valid 32-byte ICRC subaccount".to_string(),
        )
    })?;
    let caller = msg_caller();
    let ledger = LEDGER.with(|l| *l.borrow());
    let self_id = canister_self();
    let tf_arg = TransferFromArgs {
        spender_subaccount: None,
        from: Account { owner: caller, subaccount: Some(sub_arr) },
        to: Account { owner: self_id, subaccount: None }, // minting account → burn
        amount: arg.amount,
        fee: None,
        memo: None,
        created_at_time: Some(time()),
    };
    let response = match Call::bounded_wait(ledger, "icrc2_transfer_from")
        .with_arg(tf_arg)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Err(WithdrawalError::TemporarilyUnavailable(format!(
                "icrc2_transfer_from rejected: {e:?}"
            )));
        }
    };
    match response.candid::<Result<Nat, TransferFromError>>() {
        Ok(Ok(block_index)) => Ok(RetrieveEthRequest { block_index }),
        Ok(Err(TransferFromError::InsufficientAllowance { allowance })) => {
            Err(WithdrawalError::InsufficientAllowance { allowance })
        }
        Ok(Err(TransferFromError::InsufficientFunds { balance })) => {
            Err(WithdrawalError::InsufficientFunds { balance })
        }
        Ok(Err(TransferFromError::TemporarilyUnavailable)) => {
            Err(WithdrawalError::TemporarilyUnavailable(
                "ledger temporarily unavailable".to_string(),
            ))
        }
        Ok(Err(e)) => Err(WithdrawalError::TemporarilyUnavailable(format!(
            "icrc2_transfer_from error: {e}"
        ))),
        Err(e) => Err(WithdrawalError::TemporarilyUnavailable(format!(
            "icrc2_transfer_from decode: {e:?}"
        ))),
    }
}

// --- ckETH-minter withdraw_erc20 surface (ckERC20 → ERC20 out) --------------------------------
// Mirror types for the REAL ckETH minter's `withdraw_erc20` candid, verified against `dfx canister
// metadata sv3dd-oaaaa-aaaar-qacoa-cai candid:service --network ic` (cached .did):
//   `withdraw_erc20 : (WithdrawErc20Arg) -> (variant { Ok : RetrieveErc20Request; Err : WithdrawErc20Error })`
// Field/variant labels mirror the real minter EXACTLY (incl. `ckerc20_ledger_id : principal`, NOT
// nat — encoding it as nat traps IC0503 on mainnet). This mock's candid surface MUST match the real
// minter's so a facade that diverges (wrong arg shape, nat-vs-principal, wrong error variant) is
// caught by the PocketIC withdraw_erc20 honesty test — the mirror-the-real-counterparty lesson that
// caught the live withdraw_eth 1-tuple trap.

/// `WithdrawErc20Arg` — the EXACT argument record the REAL ckETH minter's `withdraw_erc20` takes:
///   `record { amount : nat; ckerc20_ledger_id : principal; recipient : text;
///             from_cketh_subaccount : opt blob; from_ckerc20_subaccount : opt blob }`.
/// `ckerc20_ledger_id` is a `principal` (NOT nat) — verified in the cached .did. The facade passes
/// `ckerc20_ledger_id = ledger` (the ckERC20 amount ledger), `from_cketh_subaccount = Some(pubkey)`,
/// `from_ckerc20_subaccount = Some(pubkey)` (the SAME subaccount on both ledgers — the facade owns the
/// user's account on every ledger).
#[derive(CandidType, Deserialize)]
struct WithdrawErc20Arg {
    amount: Nat,
    ckerc20_ledger_id: Principal,
    recipient: String,
    from_cketh_subaccount: Option<Vec<u8>>,
    from_ckerc20_subaccount: Option<Vec<u8>>,
}

/// `RetrieveErc20Request` — the real minter's success record: the burn block indices on BOTH ledgers
/// (`cketh_block_index` for the gas-fee burn, `ckerc20_block_index` for the amount burn).
#[derive(CandidType, Deserialize)]
struct RetrieveErc20Request {
    cketh_block_index: Nat,
    ckerc20_block_index: Nat,
}

/// `LedgerError` — the inner error the minter wraps in `CkEthLedgerError` / `CkErc20LedgerError`.
/// Variant + field labels mirror the real minter's candid exactly (verified in the cached .did).
#[derive(CandidType, Deserialize, Debug)]
enum LedgerError {
    InsufficientFunds { balance: Nat, failed_burn_amount: Nat, token_symbol: String, ledger_id: Principal },
    InsufficientAllowance { allowance: Nat, failed_burn_amount: Nat, token_symbol: String, ledger_id: Principal },
    AmountTooLow { minimum_burn_amount: Nat, failed_burn_amount: Nat, token_symbol: String, ledger_id: Principal },
    TemporarilyUnavailable(String),
}

/// `CkErc20Token` — the record the real minter returns inside `TokenNotSupported.supported_tokens`.
#[derive(CandidType, Deserialize, Debug)]
struct CkErc20Token {
    ckerc20_token_symbol: String,
    erc20_contract_address: String,
    ledger_canister_id: Principal,
}

/// `WithdrawErc20Error` — the real ckETH minter's error variant for `withdraw_erc20`. Variant + field
/// labels mirror the cached .did EXACTLY so the facade's decode is wire-compatible with mainnet. The
/// load-bearing variant for the partial-failure path is `CkErc20LedgerError { cketh_block_index,
/// error }`: the gas fee burned successfully but the amount burn failed → the minter schedules a
/// reimbursement. This is a TERMINAL state (funds moved), distinct from `CkEthLedgerError` (gas burn
/// itself failed → nothing moved).
#[derive(CandidType, Deserialize, Debug)]
enum WithdrawErc20Error {
    TokenNotSupported { supported_tokens: Vec<CkErc20Token> },
    RecipientAddressBlocked { address: String },
    CkEthLedgerError { error: LedgerError },
    CkErc20LedgerError { cketh_block_index: Nat, error: LedgerError },
    TemporarilyUnavailable(String),
}

/// Test-only hook: force the NEXT `withdraw_erc20` to burn the ckETH gas fee (succeed) then return
/// `CkErc20LedgerError` — the partial-failure terminal state. Cleared after one call. Lets the
/// PocketIC test prove the facade SETTLES the nonce on a partial failure (gas burned → funds moved →
/// no replay) rather than releasing it.
#[update]
fn force_next_withdraw_erc20_partial() {
    FORCE_NEXT_ERC20_PARTIAL.with(|f| *f.borrow_mut() = true);
}

/// The gas-fee cap the mock burns from the ckETH gas ledger in `withdraw_erc20`. Mirrors the
/// `max_transaction_fee` returned by `eip_1559_transaction_price(Some(...))` (60_000 gas × 10 gwei)
/// so the facade's approve-then-burn wiring reconciles. Single-sourced so the price query + the burn
/// can't drift.
fn gas_price_max_fee() -> u64 {
    60_000u64 * 10_000_000_000u64
}

/// Helper: burn `amount` from `from_subaccount` on `ledger` via `icrc2_transfer_from` (the minter is
/// the spender, consuming the allowance the facade set). Returns the burn's block index or a
/// `LedgerError` mirror of the ledger's `TransferFromError`. Shared by the gas-ledger + amount-ledger
/// burns in `withdraw_erc20` so both branches classify errors identically.
async fn burn_from_subaccount(
    ledger: Principal,
    caller: Principal,
    from_subaccount: [u8; 32],
    amount: Nat,
    token_symbol: &str,
) -> Result<Nat, LedgerError> {
    let self_id = canister_self();
    let arg = TransferFromArgs {
        spender_subaccount: None,
        from: Account { owner: caller, subaccount: Some(from_subaccount) },
        to: Account { owner: self_id, subaccount: None }, // minting account → burn
        amount,
        fee: None,
        memo: None,
        created_at_time: Some(time()),
    };
    let response = match Call::bounded_wait(ledger, "icrc2_transfer_from").with_arg(arg).await {
        Ok(r) => r,
        Err(_) => {
            return Err(LedgerError::TemporarilyUnavailable(
                "icrc2_transfer_from rejected".to_string(),
            ));
        }
    };
    match response.candid::<Result<Nat, TransferFromError>>() {
        Ok(Ok(block_index)) => Ok(block_index),
        Ok(Err(TransferFromError::InsufficientFunds { balance })) => Err(LedgerError::InsufficientFunds {
            balance,
            failed_burn_amount: Nat::from(0u64),
            token_symbol: token_symbol.to_string(),
            ledger_id: ledger,
        }),
        Ok(Err(TransferFromError::InsufficientAllowance { allowance })) => {
            Err(LedgerError::InsufficientAllowance {
                allowance,
                failed_burn_amount: Nat::from(0u64),
                token_symbol: token_symbol.to_string(),
                ledger_id: ledger,
            })
        }
        Ok(Err(TransferFromError::TemporarilyUnavailable)) => {
            Err(LedgerError::TemporarilyUnavailable("ledger temporarily unavailable".to_string()))
        }
        Ok(Err(_)) => Err(LedgerError::TemporarilyUnavailable("icrc2_transfer_from error".to_string())),
        Err(_) => Err(LedgerError::TemporarilyUnavailable("icrc2_transfer_from decode".to_string())),
    }
}

/// Minter `withdraw_erc20(WithdrawErc20Arg) -> Result<RetrieveErc20Request, WithdrawErc20Error>` —
/// the dual-ledger value-creating call that burns ckETH (gas) + ckERC20 (amount) and (on mainnet)
/// sends native ERC-20 to `recipient`. Mirrors the mock's single-ledger burns but across TWO
/// ledgers: the gas burn lands on `GAS_LEDGER` (ckETH), the amount burn on `LEDGER` (the ckERC20
/// amount ledger = `arg.ckerc20_ledger_id`). Settlement mechanics identical to
/// `retrieve_btc_with_approval` / `withdraw_eth` (the mock owns each ledger's minting account, so a
/// transfer to its default account burns).
///
/// Error classification (mirrors mainnet): a gas-burn failure → `CkEthLedgerError` (nothing moved);
/// an amount-burn failure AFTER a successful gas burn → `CkErc20LedgerError { cketh_block_index }`
/// (the partial-failure terminal state — the minter schedules a reimbursement of the burned gas). The
/// `force_next_withdraw_erc20_partial` test hook forces the amount burn to fail so the facade's
/// settle-on-partial classification is provable offline.
#[update]
async fn withdraw_erc20(arg: WithdrawErc20Arg) -> Result<RetrieveErc20Request, WithdrawErc20Error> {
    if arg.recipient.trim().is_empty() {
        return Err(WithdrawErc20Error::TemporarilyUnavailable("recipient is empty".to_string()));
    }
    let caller = msg_caller();
    let amount_ledger = LEDGER.with(|l| *l.borrow());
    // The minter only supports the ONE ckERC20 ledger it was init'd with. A different ledger id →
    // TokenNotSupported (mirrors the real minter's supported-tokens gate).
    if arg.ckerc20_ledger_id != amount_ledger {
        return Err(WithdrawErc20Error::TokenNotSupported {
            supported_tokens: vec![CkErc20Token {
                ckerc20_token_symbol: "ckERC20".to_string(),
                erc20_contract_address: "0xMOCK".to_string(),
                ledger_canister_id: amount_ledger,
            }],
        });
    }
    let gas_ledger = GAS_LEDGER.with(|gl| *gl.borrow());
    if gas_ledger == Principal::management_canister() {
        // No gas ledger configured (single-ledger mock) → dual-ledger withdraw is not supported.
        return Err(WithdrawErc20Error::TokenNotSupported {
            supported_tokens: vec![CkErc20Token {
                ckerc20_token_symbol: "ckERC20".to_string(),
                erc20_contract_address: "0xMOCK".to_string(),
                ledger_canister_id: amount_ledger,
            }],
        });
    }

    let gas_sub_vec = arg.from_cketh_subaccount.unwrap_or_default();
    let gas_sub: [u8; 32] = gas_sub_vec.as_slice().try_into().map_err(|_| {
        WithdrawErc20Error::TemporarilyUnavailable(
            "from_cketh_subaccount is not a valid 32-byte ICRC subaccount".to_string(),
        )
    })?;
    let amt_sub_vec = arg.from_ckerc20_subaccount.unwrap_or_default();
    let amt_sub: [u8; 32] = amt_sub_vec.as_slice().try_into().map_err(|_| {
        WithdrawErc20Error::TemporarilyUnavailable(
            "from_ckerc20_subaccount is not a valid 32-byte ICRC subaccount".to_string(),
        )
    })?;

    // 1. Burn the ckETH gas fee FIRST. A failure here → CkEthLedgerError (nothing moved; the facade
    //    RELEASES the nonce — retryable).
    let cketh_block_index = match burn_from_subaccount(
        gas_ledger, caller, gas_sub, Nat::from(gas_price_max_fee()), "ckETH",
    )
    .await
    {
        Ok(idx) => idx,
        Err(e) => return Err(WithdrawErc20Error::CkEthLedgerError { error: e }),
    };

    // 2. Test hook: force the amount burn to fail → CkErc20LedgerError (partial failure). The gas
    //    burn already succeeded (cketh_block_index is real), modeling the real minter's "gas burned,
    //    amount burn failed → reimbursement scheduled" terminal state.
    let force_partial = FORCE_NEXT_ERC20_PARTIAL.with(|f| {
        let v = *f.borrow();
        *f.borrow_mut() = false;
        v
    });
    if force_partial {
        return Err(WithdrawErc20Error::CkErc20LedgerError {
            cketh_block_index,
            error: LedgerError::TemporarilyUnavailable("forced partial failure (test hook)".to_string()),
        });
    }

    // 3. Burn the ckERC20 amount. A failure here → CkErc20LedgerError (partial; gas already burned).
    let ckerc20_block_index = match burn_from_subaccount(
        amount_ledger, caller, amt_sub, arg.amount, "ckERC20",
    )
    .await
    {
        Ok(idx) => idx,
        Err(e) => {
            return Err(WithdrawErc20Error::CkErc20LedgerError {
                cketh_block_index,
                error: e,
            });
        }
    };

    Ok(RetrieveErc20Request { cketh_block_index, ckerc20_block_index })
}

/// Minter `get_known_utxos(record { owner: opt principal; subaccount : opt blob }) -> vec Utxo`. The
/// real ckBTC minter takes ONE record argument; this mock mirrors that surface exactly. The mock
/// tracks no UTXO history, so this is always empty.
#[query]
fn get_known_utxos(_arg: AccountArg) -> Vec<Utxo> {
    Vec::new()
}

/// Deterministic fake Bitcoin deposit address derived from `owner || subaccount`. Clearly fake
/// (`bc1qmock` prefix) but stable and distinct per distinct `(owner, subaccount)` — everything the
/// deposit flow needs to prove offline. Uses std's fixed-key SipHash-1-3 (no external hashing dep);
/// two passes yield 128 bits of material, of which the first 10 bytes (20 hex chars) form the body.
fn derive_btc_address(owner: Principal, subaccount: &[u8]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut material = Vec::with_capacity(owner.as_slice().len() + subaccount.len());
    material.extend_from_slice(owner.as_slice());
    material.extend_from_slice(subaccount);

    let mut h1 = DefaultHasher::new();
    material.hash(&mut h1);
    let d1 = h1.finish();

    let mut h2 = DefaultHasher::new();
    d1.hash(&mut h2);
    material.hash(&mut h2);
    let d2 = h2.finish();

    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&d1.to_be_bytes());
    bytes[8..].copy_from_slice(&d2.to_be_bytes());
    format!("bc1qmock{}", to_hex(&bytes[..10]))
}

/// Lowercase hex of a byte slice, without an external dependency (the workspace does not depend on
/// the `hex` crate at the member level).
fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

ic_cdk::export_candid!();
