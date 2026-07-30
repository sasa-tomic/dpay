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
    ledger: Principal,
}

thread_local! {
    /// The ICRC ledger this mock mints onto. The test installs the ledger with
    /// `minting_account.owner = mock_minter`, so the mock is authorized to mint from that account's
    /// default subaccount. Sentinel `management_canister` until overwritten by `init`.
    static LEDGER: RefCell<Principal> = RefCell::new(Principal::management_canister());

    /// Pending deposits keyed by `(owner, subaccount)`. `register_deposit` seeds an entry;
    /// `update_balance` drains it (one mint) and removes it. `subaccount` is the 32-byte pubkey blob
    /// the facade passes.
    static PENDING: RefCell<BTreeMap<(Principal, Vec<u8>), u64>> = RefCell::new(BTreeMap::new());
}

#[init]
fn init(arg: InitArg) {
    LEDGER.with(|l| *l.borrow_mut() = arg.ledger);
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
    }
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

/// Minter `get_known_utxos(record { owner: opt principal; subaccount: opt blob }) -> vec Utxo`. The
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
