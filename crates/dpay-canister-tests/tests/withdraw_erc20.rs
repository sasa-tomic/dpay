//! PocketIC proof that the dpay **facade** canister's `withdraw` dispatches a ckERC20 (e.g. ckUSDC)
//! withdrawal (CkEthErc20 family, `token_contract = Some`) to the ckETH minter's `withdraw_erc20`
//! — the DUAL-ledger path that burns ckETH gas fees + the ckERC20 amount (offline, deterministic,
//! seconds).
//!
//! This is the last native-asset OUT path: getting native ERC-20 (USDC) out of the wallet. The facade
//! reads the currency's `minter_family` (CkEthErc20) + `token_contract` (Some) + `gas_ledger` (the
//! ckETH ledger) from the compile-time FIXED_ASSETS table and routes to `withdraw_erc20` (NOT
//! `withdraw_eth`); the BTC floor (retrieve_btc_min_amount = 50_000 sats) does NOT apply to ckERC20.
//!
//! Builds three wasms (see `just test-canister`):
//!   DPAY_CANISTER_WASM      = dpay-canister       (the facade: family-dispatches withdraw)
//!   DPAY_MOCK_MINTER_WASM   = dpay-mock-minter    (test-only minter; serves BTC + ETH + ERC20 surfaces)
//!   DPAY_ICRC_LEDGER_WASM   = ic-icrc1-ledger     (the REAL DFINITY ledger the burns land on)
//!
//! Proves: a CkEthErc20 + token_contract Some withdraw reaches `withdraw_erc20` (asserted via the
//! dual-ledger debit — the SEPARATE ckETH gas ledger is debited by the gas fee, which only the ERC20
//! branch does); the ckUSDC amount ledger is debited by `amount` and total supply drops (the burn);
//! the ckETH gas ledger is debited by the gas fee; a same-nonce replay is rejected; a wrong sig + an
//! expired auth are rejected; and a PARTIAL failure (gas burned, amount burn failed) SETTLES the
//! nonce (terminal — funds moved) so the dead auth can never replay.

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use dpay_core::{generate_keypair, sign_withdraw, Currency, WithdrawAuth};
use ed25519_dalek::SigningKey;
use icrc_ledger_types::icrc1::account::Account;
use pocket_ic::{PocketIc, Time};
use serde::Deserialize;

const T0_SECS: u64 = 1_800_000_000;
const T0_NANOS: u64 = T0_SECS * 1_000_000_000;
const CAP: u64 = 100_000;

/// The ckUSDC test currency id — currency 2 is the REAL ckUSDC row in the facade's FIXED_ASSETS
/// table (CkEthErc20 family, token_contract Some → dual-ledger dispatch, ledger xevnm…, minter
/// sv3dd…, gas_ledger ss2fx…).
const CKUSDC: Currency = 2;

/// The facade FIXED_ASSETS ckUSDC / ckETH principals — post-registry (2026-08-28) currency 2
/// resolves from the compile-time table, so this file's stand-ins must live at EXACTLY those ids.
const CKUSDC_LEDGER: &str = "xevnm-gaaaa-aaaar-qafnq-cai";
const CKETH_GAS_LEDGER: &str = "ss2fx-dyaaa-aaaar-qacoq-cai";
const CKETH_MINTER: &str = "sv3dd-oaaaa-aaaar-qacoa-cai";

/// 1 ckUSDC (6 decimals) = 1_000_000 raw. A comfortable test fund well above the gas fee in ckETH.
const ONE_USDC: u64 = 1_000_000;

/// 1 ckETH in Wei (18 decimals). The gas-fee ledger fund — the user MUST hold ckETH for gas (Fork-C:
/// dpay never converts ckUSDC→ckETH). Well above the mock's gas fee (6e14 Wei).
const ONE_ETH: u64 = 1_000_000_000_000_000_000;

/// The gas fee the mock's `withdraw_erc20` burns from the ckETH gas ledger: 60_000 gas × 10 gwei
/// (the `max_transaction_fee` returned by `eip_1559_transaction_price(Some(...))`). Single-sourced
/// here so the test's debit assertion and the mock can't drift.
const GAS_FEE: u64 = 60_000u64 * 10_000_000_000u64;

#[allow(dead_code)]
#[derive(CandidType, serde::Serialize)]
enum MetadataValue {
    Nat(Nat),
    Int(candid::Int),
    Text(String),
    Blob(Vec<u8>),
}

#[derive(CandidType, serde::Serialize)]
struct FeatureFlags {
    icrc2: bool,
    icrc152: bool,
}

#[derive(CandidType, serde::Serialize)]
struct ArchiveOptions {
    num_blocks_to_archive: u64,
    max_transactions_per_response: Option<u64>,
    trigger_threshold: u64,
    max_message_size_bytes: Option<u64>,
    cycles_for_archive_creation: Option<u64>,
    node_max_memory_size_bytes: Option<u64>,
    controller_id: Principal,
    more_controller_ids: Option<Vec<Principal>>,
}

#[derive(CandidType, serde::Serialize)]
struct LedgerInitArgs {
    minting_account: Account,
    fee_collector_account: Option<Account>,
    transfer_fee: Nat,
    decimals: Option<u8>,
    max_memo_length: Option<u16>,
    token_symbol: String,
    token_name: String,
    metadata: Vec<(String, MetadataValue)>,
    initial_balances: Vec<(Account, Nat)>,
    feature_flags: Option<FeatureFlags>,
    archive_options: ArchiveOptions,
    index_principal: Option<Principal>,
}

#[derive(CandidType, serde::Serialize)]
enum LedgerArg {
    Init(LedgerInitArgs),
}

#[derive(CandidType, serde::Serialize)]
struct DpayInitArg {
    /// Satisfies the required init arg; currency 0 is never exercised in this file.
    demo_ledger: Principal,
    per_tx_cap: u64,
    controller: Option<Principal>,
}

/// The mock minter's `InitArg` — `amount_ledger` is the ckERC20 amount ledger, `gas_ledger` is the
/// ckETH ledger the dual-ledger `withdraw_erc20` burns gas fees from. Mirrors the mock's candid
/// surface (which mirrors the real ckETH minter's contract).
#[derive(CandidType, serde::Serialize)]
struct MockMinterInit {
    amount_ledger: Principal,
    gas_ledger: Option<Principal>,
}

#[derive(CandidType, serde::Serialize)]
struct WithdrawRequest {
    from_pubkey: Vec<u8>,
    destination: String,
    amount: u64,
    nonce: Vec<u8>,
    expiry: u64,
    currency: Currency,
    sig: Vec<u8>,
}

#[derive(CandidType, Deserialize, Debug)]
struct WithdrawReceipt {
    from: Vec<u8>,
    destination: String,
    amount: u64,
    nonce: Vec<u8>,
    currency: Currency,
    block_index: u64,
}

/// A minimal `icrc1_transfer` argument shape for a direct credit (mint from the minting account).
#[derive(CandidType, serde::Serialize)]
struct DirectTransferArg {
    from_subaccount: Option<Vec<u8>>,
    to: Account,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<Vec<u8>>,
    created_at_time: Option<u64>,
}

fn nat_to_u64(n: &Nat) -> u64 {
    num_traits::ToPrimitive::to_u64(&n.0).expect("nat fits in u64")
}

fn workspace_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn ledger_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_ICRC_LEDGER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm")
        });
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read ledger wasm at {}: {e}", path.display()))
}

fn dpay_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_CANISTER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("target/wasm32-unknown-unknown/release/dpay_canister.wasm")
        });
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read facade wasm at {}: {e}", path.display()))
}

fn mock_minter_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_MOCK_MINTER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("target/wasm32-unknown-unknown/release/dpay_mock_minter.wasm")
        });
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read mock-minter wasm at {}: {e}", path.display()))
}

/// Install an ICRC ledger with icrc2 enabled (the withdraw path uses `icrc2_approve` +
/// `icrc2_transfer_from` on BOTH the gas + amount ledgers). The mock owns the minting account.
/// `decimals` + `symbol` are parameterized so the same helper installs the 18-dec ckETH gas ledger
/// AND the 6-dec ckUSDC amount ledger.
fn install_ledger_with(
    pic: &PocketIc,
    minting_account: Account,
    decimals: u8,
    symbol: &str,
) -> Principal {
    let ledger = pic.create_canister();
    install_ledger_with_code(pic, ledger, minting_account, decimals, symbol);
    ledger
}

/// [`install_ledger_with`] at an EXACT principal (the FIXED_ASSETS ckUSDC / ckETH ledger ids).
fn install_ledger_with_at(
    pic: &PocketIc,
    ledger: Principal,
    minting_account: Account,
    decimals: u8,
    symbol: &str,
) {
    pic.create_canister_with_id(Some(Principal::anonymous()), None, ledger)
        .unwrap_or_else(|e| panic!("create_canister_with_id({ledger}): {e}"));
    install_ledger_with_code(pic, ledger, minting_account, decimals, symbol);
}

/// Cycles + code install at an ALREADY-CREATED canister id (shared by the two entry points above —
/// `create_canister_with_id` must never be handed a PocketIC-allocated id).
fn install_ledger_with_code(
    pic: &PocketIc,
    ledger: Principal,
    minting_account: Account,
    decimals: u8,
    symbol: &str,
) {
    pic.add_cycles(ledger, 10_000_000_000_000);
    let init = LedgerArg::Init(LedgerInitArgs {
        minting_account,
        fee_collector_account: None,
        transfer_fee: Nat::from(0u64),
        decimals: Some(decimals),
        max_memo_length: None,
        token_symbol: symbol.into(),
        token_name: format!("Demo {symbol}"),
        metadata: vec![],
        initial_balances: vec![],
        feature_flags: Some(FeatureFlags { icrc2: true, icrc152: false }),
        archive_options: ArchiveOptions {
            num_blocks_to_archive: 10_000,
            max_transactions_per_response: None,
            trigger_threshold: 10_000_000,
            max_message_size_bytes: None,
            cycles_for_archive_creation: None,
            node_max_memory_size_bytes: None,
            controller_id: minting_account.owner,
            more_controller_ids: None,
        },
        index_principal: None,
    });
    pic.install_canister(ledger, ledger_wasm(), encode_one(&init).unwrap(), None);
}

fn ledger_balance(pic: &PocketIc, ledger: Principal, dpay: Principal, pk: [u8; 32]) -> u64 {
    let acct = Account { owner: dpay, subaccount: Some(pk) };
    let reply = pic
        .query_call(
            ledger,
            Principal::anonymous(),
            "icrc1_balance_of",
            encode_one(&acct).unwrap(),
        )
        .expect("icrc1_balance_of query rejected");
    let nat: Nat = decode_one(&reply).unwrap();
    nat_to_u64(&nat)
}

fn total_supply(pic: &PocketIc, ledger: Principal) -> u64 {
    let r = pic
        .query_call(ledger, Principal::anonymous(), "icrc1_total_supply", encode_args(()).unwrap())
        .expect("icrc1_total_supply query rejected");
    let n: Nat = decode_one(&r).unwrap();
    nat_to_u64(&n)
}

/// Build a signed WithdrawRequest from a signing key + the withdrawal parameters. The signature is
/// over the canonical `WithdrawAuth::signing_bytes()` (single source of truth in dpay-core).
fn withdraw_request(
    sk: &SigningKey,
    from: [u8; 32],
    destination: &str,
    amount: u64,
    nonce: [u8; 16],
    expiry: u64,
    currency: Currency,
) -> WithdrawRequest {
    let auth = WithdrawAuth {
        from_pubkey: from,
        destination: destination.to_string(),
        amount,
        nonce,
        expiry,
        currency,
    };
    let sig = sign_withdraw(sk, &auth).to_bytes();
    WithdrawRequest {
        from_pubkey: from.to_vec(),
        destination: destination.to_string(),
        amount,
        nonce: nonce.to_vec(),
        expiry,
        currency,
        sig: sig.to_vec(),
    }
}

fn withdraw(pic: &PocketIc, dpay: Principal, req: WithdrawRequest) -> Result<WithdrawReceipt, String> {
    let reply = pic
        .update_call(dpay, Principal::anonymous(), "withdraw", encode_one(&req).unwrap())
        .expect("withdraw update_call rejected at IC level");
    decode_one::<Result<WithdrawReceipt, String>>(&reply).unwrap()
}

/// Simulate an EXTERNAL credit that BYPASSES the facade: a direct `icrc1_transfer` on the ledger from
/// the minting account (owned by `mock`) to `Account{owner: facade, subaccount: payer}`. Debiting the
/// minting account's default subaccount is an ICRC MINT, so the user's facade subaccount is credited
/// without the facade ever being invoked. Used to fund BOTH the ckUSDC amount ledger + the ckETH gas
/// ledger.
fn direct_credit(
    pic: &PocketIc,
    ledger: Principal,
    mock: Principal,
    facade: Principal,
    pk: [u8; 32],
    amount: u64,
) {
    let arg = DirectTransferArg {
        from_subaccount: None,
        to: Account { owner: facade, subaccount: Some(pk) },
        amount: Nat::from(amount),
        fee: None,
        memo: None,
        created_at_time: Some(T0_NANOS),
    };
    let reply = pic
        .update_call(ledger, mock, "icrc1_transfer", encode_one(&arg).unwrap())
        .expect("direct icrc1_transfer update_call rejected");
    decode_one::<Result<Nat, candid::Reserved>>(&reply)
        .expect("direct icrc1_transfer reply decode")
        .expect("direct credit transfer should succeed (minting account debited)");
}

/// Install the facade + a ckUSDC amount ledger (6-dec) + a ckETH gas ledger (18-dec, icrc2-enabled
/// BOTH) + the mock minter (init'd with BOTH ledgers), all wired through the FIXED_ASSETS const ids
/// (post-registry there is no registration: currency 2 resolves ledger/minter/family/token_contract/
/// gas_ledger from the compile-time table, so the stand-ins sit at the exact mainnet principals —
/// including the SHARED ckETH minter sv3dd… serving ckUSDC, exactly as on mainnet). Returns the
/// handles a withdraw_erc20 test needs: (pic, cketh_gas_ledger, ckusdc_amount_ledger, dpay, mock,
/// payer_sk, payer).
fn setup_erc20() -> (PocketIc, Principal, Principal, Principal, Principal, SigningKey, [u8; 32]) {
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));

    let payer_sk = generate_keypair();
    let payer = payer_sk.verifying_key().to_bytes();

    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);

    let cketh = Principal::from_text(CKETH_GAS_LEDGER).unwrap();
    let ckusdc = Principal::from_text(CKUSDC_LEDGER).unwrap();
    let mock = Principal::from_text(CKETH_MINTER).unwrap();
    // Reserve ONLY the mock here — the two `install_ledger_with_at` calls below do their own
    // exact-id creation for the ledgers (a second `create_canister_with_id` on an already-created
    // id is rejected).
    pic.create_canister_with_id(Some(Principal::anonymous()), None, mock)
        .unwrap_or_else(|e| panic!("reserve {mock}: {e}"));
    pic.add_cycles(mock, 2_000_000_000_000);

    // TWO ledgers, both icrc2-enabled, both owned by the mock (so the mock can mint + burn on each).
    install_ledger_with_at(&pic, cketh, Account { owner: mock, subaccount: None }, 18, "ckETH");
    install_ledger_with_at(&pic, ckusdc, Account { owner: mock, subaccount: None }, 6, "ckUSDC");

    // The mock is the ckETH minter for the dual-ledger withdraw_erc20: amount_ledger = ckUSDC,
    // gas_ledger = ckETH.
    pic.install_canister(
        mock,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { amount_ledger: ckusdc, gas_ledger: Some(cketh) }).unwrap(),
        None,
    );

    let dpay_init = DpayInitArg {
        demo_ledger: Principal::anonymous(),
        per_tx_cap: CAP,
        controller: None,
    };
    pic.install_canister(dpay, dpay_wasm(), encode_one(&dpay_init).unwrap(), None);

    (pic, cketh, ckusdc, dpay, mock, payer_sk, payer)
}

// --- tests --------------------------------------------------------------------------------------

/// THE HEADLINE: a CkEthErc20 + token_contract Some withdraw dispatches to `withdraw_erc20`, NOT to
/// `retrieve_btc_with_approval` or `withdraw_eth`. Proof: the withdrawn USDC amount (1_000 raw) is
/// BELOW the BTC floor (`retrieve_btc_min_amount` = 50_000). If the facade wrongly dispatched to the
/// BTC branch, the BTC-local floor check would reject with "amount below retrieve_btc_min_amount".
/// The withdraw SUCCEEDS → the facade took the ERC20 branch. The dual-ledger debit (the SEPARATE
/// ckETH gas ledger drops by exactly GAS_FEE) confirms the ERC20 branch specifically (native-eth has
/// no separate gas ledger).
#[test]
fn withdraw_erc20_dispatches_withdraw_erc20_not_retrieve_btc() {
    let (pic, cketh, ckusdc, dpay, mock, payer_sk, payer) = setup_erc20();
    const WITHDRAW: u64 = 1_000; // raw USDC; below BTC's 50_000 floor

    // Fund BOTH ledgers: the ckUSDC amount + the ckETH gas fee the dual-ledger burn needs.
    direct_credit(&pic, ckusdc, mock, dpay, payer, ONE_USDC);
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);
    assert_eq!(ledger_balance(&pic, ckusdc, dpay, payer), ONE_USDC);
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH);

    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xRecipientErc20",
        WITHDRAW,
        [1u8; 16],
        T0_SECS + 120,
        CKUSDC,
    );
    let receipt = withdraw(&pic, dpay, req).expect("ERC20 withdraw should succeed");
    assert_eq!(receipt.amount, WITHDRAW);
    assert_eq!(receipt.currency, CKUSDC);
    assert_eq!(receipt.destination, "0xRecipientErc20");
    assert!(receipt.block_index > 0, "withdraw_erc20 must return a burn block_index");

    // DUAL-LEDGER debit: ckUSDC amount ledger drops by WITHDRAW (the amount burn); ckETH gas ledger
    // drops by GAS_FEE (the gas-fee burn). Both are the ERC20 branch's signature — native-eth would
    // debit ONLY the currency's own ledger (ckUSDC) for amount+fee, never a separate ckETH ledger.
    assert_eq!(ledger_balance(&pic, ckusdc, dpay, payer), ONE_USDC - WITHDRAW);
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH - GAS_FEE);
    println!(
        "[withdraw_erc20] ✓ dispatched to withdraw_erc20 (amount {WITHDRAW} < BTC floor 50_000 succeeded); ckUSDC debited {WITHDRAW}, ckETH gas debited {GAS_FEE}; block_index = {}",
        receipt.block_index
    );
}

/// The ckUSDC was DEBITED from the user's subaccount AND burned (the mock's transfer_from lands in the
/// minting account → total supply drops); the ckETH gas ledger is debited by GAS_FEE and its supply
/// drops too. Mirrors the ETH withdraw's burn assertion, extended to BOTH ledgers.
#[test]
fn withdraw_erc20_debits_both_ledgers_and_burns_supply() {
    let (pic, cketh, ckusdc, dpay, mock, payer_sk, payer) = setup_erc20();
    const WITHDRAW: u64 = 500_000; // 0.5 USDC

    direct_credit(&pic, ckusdc, mock, dpay, payer, ONE_USDC);
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);
    assert_eq!(total_supply(&pic, ckusdc), ONE_USDC);
    assert_eq!(total_supply(&pic, cketh), ONE_ETH);

    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xBurnProof",
        WITHDRAW,
        [2u8; 16],
        T0_SECS + 120,
        CKUSDC,
    );
    let receipt = withdraw(&pic, dpay, req).expect("withdraw should succeed");
    assert_eq!(receipt.amount, WITHDRAW);

    // ckUSDC: debited by WITHDRAW + burned (supply drops).
    assert_eq!(ledger_balance(&pic, ckusdc, dpay, payer), ONE_USDC - WITHDRAW);
    assert_eq!(
        total_supply(&pic, ckusdc),
        ONE_USDC - WITHDRAW,
        "the amount burn must reduce ckUSDC total supply by the withdrawn amount"
    );
    // ckETH: debited by GAS_FEE + burned (supply drops by the gas fee).
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH - GAS_FEE);
    assert_eq!(
        total_supply(&pic, cketh),
        ONE_ETH - GAS_FEE,
        "the gas-fee burn must reduce ckETH total supply by the gas fee"
    );
    println!(
        "[withdraw_erc20] ✓ debited {WITHDRAW} ckUSDC + {GAS_FEE} ckETH gas; both supplies burned"
    );
}

/// A replay with the SAME nonce is rejected — no double-burn. Mirrors the BTC/ETH tests.
#[test]
fn withdraw_erc20_double_withdraw_rejected() {
    let (pic, cketh, ckusdc, dpay, mock, payer_sk, payer) = setup_erc20();
    const WITHDRAW: u64 = 300_000;
    direct_credit(&pic, ckusdc, mock, dpay, payer, ONE_USDC);
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);

    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xFirst",
        WITHDRAW,
        [3u8; 16],
        T0_SECS + 120,
        CKUSDC,
    );
    let first = withdraw(&pic, dpay, req).expect("first withdraw should succeed");
    assert_eq!(first.amount, WITHDRAW);
    assert_eq!(ledger_balance(&pic, ckusdc, dpay, payer), ONE_USDC - WITHDRAW);

    // Replay the SAME signed authorization (same nonce): rejected — no second burn.
    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xFirst",
        WITHDRAW,
        [3u8; 16], // same nonce
        T0_SECS + 120,
        CKUSDC,
    );
    let second = withdraw(&pic, dpay, req);
    assert!(second.is_err(), "a replay with the same nonce must be rejected");
    let err = second.unwrap_err();
    assert!(err.contains("nonce"), "replay error must mention the nonce, got: {err}");

    // No double-burn: both ledger balances unchanged after the rejected replay.
    assert_eq!(ledger_balance(&pic, ckusdc, dpay, payer), ONE_USDC - WITHDRAW);
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH - GAS_FEE);
    println!("[withdraw_erc20] ✓ same-nonce replay rejected ({err})");
}

/// A wrong-signature withdrawal is rejected; no funds move on EITHER ledger. Mirrors the BTC/ETH tests.
#[test]
fn withdraw_erc20_wrong_sig_rejected_no_funds_move() {
    let (pic, cketh, ckusdc, dpay, mock, _payer_sk, payer) = setup_erc20();
    direct_credit(&pic, ckusdc, mock, dpay, payer, ONE_USDC);
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);

    // Sign the WithdrawAuth with a DIFFERENT key, but present `from_pubkey = payer`.
    let other_sk = generate_keypair();
    let auth = WithdrawAuth {
        from_pubkey: payer,
        destination: "0xAttacker".to_string(),
        amount: 500_000,
        nonce: [4u8; 16],
        expiry: T0_SECS + 120,
        currency: CKUSDC,
    };
    let wrong_sig = sign_withdraw(&other_sk, &auth).to_bytes();
    let req = WithdrawRequest {
        from_pubkey: payer.to_vec(),
        destination: "0xAttacker".to_string(),
        amount: 500_000,
        nonce: vec![4u8; 16],
        expiry: T0_SECS + 120,
        currency: CKUSDC,
        sig: wrong_sig.to_vec(),
    };
    let res = withdraw(&pic, dpay, req);
    assert!(res.is_err(), "a wrong-signature withdrawal must be rejected");
    let err = res.unwrap_err();
    assert!(err.contains("signature"), "wrong-sig error must mention signature, got: {err}");

    // No funds move on EITHER ledger (the sig gate fired before any approve/burn).
    assert_eq!(ledger_balance(&pic, ckusdc, dpay, payer), ONE_USDC, "no ckUSDC debit on a bad sig");
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH, "no ckETH debit on a bad sig");
    println!("[withdraw_erc20] ✓ wrong-sig rejected ({err})");
}

/// An expired authorization is rejected; no funds move on EITHER ledger.
#[test]
fn withdraw_erc20_expired_rejected_no_funds_move() {
    let (pic, cketh, ckusdc, dpay, mock, payer_sk, payer) = setup_erc20();
    direct_credit(&pic, ckusdc, mock, dpay, payer, ONE_USDC);
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);

    // expiry in the past relative to T0 (the canister's clock is fixed at T0_SECS via set_time).
    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xExpired",
        500_000,
        [5u8; 16],
        T0_SECS - 1, // already expired
        CKUSDC,
    );
    let res = withdraw(&pic, dpay, req);
    assert!(res.is_err(), "an expired withdrawal must be rejected");
    let err = res.unwrap_err();
    assert!(err.contains("expired"), "expired error must mention expiry, got: {err}");

    assert_eq!(ledger_balance(&pic, ckusdc, dpay, payer), ONE_USDC, "no ckUSDC debit on expired");
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH, "no ckETH debit on expired");
    println!("[withdraw_erc20] ✓ expired rejected ({err})");
}

/// A PARTIAL failure (the gas burn SUCCEEDS but the amount burn FAILS → the minter schedules a gas
/// reimbursement) is a TERMINAL state: funds DID move (the ckETH gas debit), so the facade SETTLES the
/// nonce — the dead auth can never replay (a retry would burn gas a second time). Proves the
/// settle-on-partial classification (distinct from a CkEthLedgerError, where the gas burn itself
/// failed → nothing moved → release).
#[test]
fn withdraw_erc20_partial_failure_settles_nonce() {
    let (pic, cketh, ckusdc, dpay, mock, payer_sk, payer) = setup_erc20();
    direct_credit(&pic, ckusdc, mock, dpay, payer, ONE_USDC);
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);

    // Arm the mock's partial-failure hook: the NEXT withdraw_erc20 burns the ckETH gas fee (succeeds)
    // then returns CkErc20LedgerError (amount burn failed → reimbursement scheduled).
    let _ = pic
        .update_call(
            mock,
            Principal::anonymous(),
            "force_next_withdraw_erc20_partial",
            encode_args(()).unwrap(),
        )
        .expect("force_next_withdraw_erc20_partial update_call rejected");

    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xPartialFailure",
        500_000,
        [7u8; 16],
        T0_SECS + 120,
        CKUSDC,
    );
    let res = withdraw(&pic, dpay, req);
    assert!(res.is_err(), "a partial-failure withdraw must surface an error (no ERC-20 delivered)");
    let err = res.unwrap_err();
    assert!(
        err.contains("partial failure"),
        "partial-failure error must mention partial failure, got: {err}"
    );

    // The gas burn SUCCEEDED: ckETH gas ledger debited by GAS_FEE. The amount burn FAILED: ckUSDC
    // amount ledger UNCHANGED (the user did NOT receive their USDC; the minter schedules a gas
    // reimbursement). This is the partial state.
    assert_eq!(
        ledger_balance(&pic, cketh, dpay, payer),
        ONE_ETH - GAS_FEE,
        "partial failure: ckETH gas was burned (terminal — funds moved)"
    );
    assert_eq!(
        ledger_balance(&pic, ckusdc, dpay, payer),
        ONE_USDC,
        "partial failure: ckUSDC amount was NOT burned (amount burn failed)"
    );

    // TERMINAL → the nonce is SETTLED. A replay of the SAME authorization is rejected with "nonce"
    // (NOT retried): settling prevents a same-auth retry from burning gas a second time.
    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xPartialFailure",
        500_000,
        [7u8; 16], // same nonce
        T0_SECS + 120,
        CKUSDC,
    );
    let replay = withdraw(&pic, dpay, req);
    assert!(replay.is_err(), "a replay of a settled (partial-failure) nonce must be rejected");
    let err = replay.unwrap_err();
    assert!(
        err.contains("nonce"),
        "replay after partial-failure-settle must mention the nonce, got: {err}"
    );

    // No SECOND gas burn after the rejected replay.
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH - GAS_FEE);
    println!("[withdraw_erc20] ✓ partial failure settled the nonce (gas burned, no replay) ({err})");
}

// --- mock honesty guard ------------------------------------------------------------------------
// The mock minter's `withdraw_erc20` + `eip_1559_transaction_price` candid surfaces mirror the REAL
// ckETH minter's contract. Drives the mock DIRECTLY to assert the variant shapes match mainnet:
// `eip_1559_transaction_price(Some)` returns the ckERC20 gas estimate (60k gas) vs `None` (21k native),
// and `withdraw_erc20` returns the real-minter-shaped error variants. This is the regression net for
// the mock-mirrors-real-counterparty lesson (the bug class this crate catches).

#[derive(CandidType, serde::Serialize)]
struct Eip1559TransactionPriceArgWire {
    ckerc20_ledger_id: Principal,
}

#[derive(CandidType, serde::Serialize)]
struct WithdrawErc20ArgWire {
    amount: Nat,
    ckerc20_ledger_id: Principal,
    recipient: String,
    from_cketh_subaccount: Option<Vec<u8>>,
    from_ckerc20_subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Deserialize, Debug)]
struct RetrieveErc20RequestMirror {
    cketh_block_index: Nat,
    ckerc20_block_index: Nat,
}

#[derive(CandidType, Deserialize, Debug)]
struct CkErc20TokenMirror {
    ckerc20_token_symbol: String,
    erc20_contract_address: String,
    ledger_canister_id: Principal,
}

#[derive(CandidType, Deserialize, Debug)]
enum LedgerErrorMirror {
    InsufficientFunds { balance: Nat, failed_burn_amount: Nat, token_symbol: String, ledger_id: Principal },
    InsufficientAllowance { allowance: Nat, failed_burn_amount: Nat, token_symbol: String, ledger_id: Principal },
    AmountTooLow { minimum_burn_amount: Nat, failed_burn_amount: Nat, token_symbol: String, ledger_id: Principal },
    TemporarilyUnavailable(String),
}

#[derive(CandidType, Deserialize, Debug)]
enum WithdrawErc20ErrorMirror {
    TokenNotSupported { supported_tokens: Vec<CkErc20TokenMirror> },
    RecipientAddressBlocked { address: String },
    CkEthLedgerError { error: LedgerErrorMirror },
    CkErc20LedgerError { cketh_block_index: Nat, error: LedgerErrorMirror },
    TemporarilyUnavailable(String),
}

#[derive(CandidType, Deserialize, Debug)]
struct Eip1559TransactionPriceMirror {
    gas_limit: Nat,
    max_fee_per_gas: Nat,
    max_priority_fee_per_gas: Nat,
    max_transaction_fee: Nat,
    timestamp: Option<u64>,
}

#[test]
fn mock_minter_withdraw_erc20_mirrors_real_cketh_minter_contract() {
    let pic = PocketIc::new();
    let mock = pic.create_canister();
    pic.add_cycles(mock, 2_000_000_000_000);
    let cketh = install_ledger_with(&pic, Account { owner: mock, subaccount: None }, 18, "ckETH");
    let ckusdc = install_ledger_with(&pic, Account { owner: mock, subaccount: None }, 6, "ckUSDC");
    pic.install_canister(
        mock,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { amount_ledger: ckusdc, gas_ledger: Some(cketh) }).unwrap(),
        None,
    );

    // eip_1559_transaction_price(Some(ckerc20_ledger_id)) returns the ckERC20 gas estimate (60k gas);
    // (None) returns the native-ETH estimate (21k gas). The arg's PRESENCE is the ckERC20 dispatch
    // signal — the facade MUST pass Some for ckERC20 (passing None would hit the native-ETH path).
    let reply = pic
        .query_call(
            mock,
            Principal::anonymous(),
            "eip_1559_transaction_price",
            encode_args((Some(Eip1559TransactionPriceArgWire { ckerc20_ledger_id: ckusdc }),)).unwrap(),
        )
        .expect("eip_1559_transaction_price (Some) query rejected");
    let price_erc20: Eip1559TransactionPriceMirror = decode_one(&reply).unwrap();
    assert_eq!(nat_to_u64(&price_erc20.gas_limit), 60_000, "ckERC20 gas estimate = 60k");
    assert_eq!(nat_to_u64(&price_erc20.max_transaction_fee), GAS_FEE);

    let reply = pic
        .query_call(
            mock,
            Principal::anonymous(),
            "eip_1559_transaction_price",
            encode_args((Option::<Eip1559TransactionPriceArgWire>::None,)).unwrap(),
        )
        .expect("eip_1559_transaction_price (None) query rejected");
    let price_eth: Eip1559TransactionPriceMirror = decode_one(&reply).unwrap();
    assert_eq!(nat_to_u64(&price_eth.gas_limit), 21_000, "native-ETH gas estimate = 21k");
    assert_ne!(
        nat_to_u64(&price_erc20.gas_limit),
        nat_to_u64(&price_eth.gas_limit),
        "ckERC20 vs native-ETH gas estimates must differ (the arg matters)"
    );
    println!("[withdraw_erc20] ✓ eip_1559_transaction_price honors the Some arg (ckERC20 60k vs ETH 21k)");

    // withdraw_erc20 with a WRONG ckerc20_ledger_id → TokenNotSupported (the real minter's
    // supported-tokens gate). Returns BEFORE any burn, so no approve is needed for this assertion.
    let wrong_ledger = Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap();
    let reply = pic
        .update_call(
            mock,
            Principal::anonymous(),
            "withdraw_erc20",
            encode_one(&WithdrawErc20ArgWire {
                amount: Nat::from(1_000_000u64),
                ckerc20_ledger_id: wrong_ledger,
                recipient: "0xAnything".to_string(),
                from_cketh_subaccount: Some(vec![7u8; 32]),
                from_ckerc20_subaccount: Some(vec![7u8; 32]),
            })
            .unwrap(),
        )
        .expect("withdraw_erc20 (wrong ledger) update_call rejected");
    let decoded: Result<RetrieveErc20RequestMirror, WithdrawErc20ErrorMirror> = decode_one(&reply).unwrap();
    assert!(
        matches!(&decoded, Err(WithdrawErc20ErrorMirror::TokenNotSupported { .. })),
        "wrong ckerc20_ledger_id must return TokenNotSupported mirroring the real minter, got: {:?}",
        decoded
    );

    // Empty recipient → TemporarilyUnavailable (the mock requires a non-empty recipient).
    let reply = pic
        .update_call(
            mock,
            Principal::anonymous(),
            "withdraw_erc20",
            encode_one(&WithdrawErc20ArgWire {
                amount: Nat::from(1_000_000u64),
                ckerc20_ledger_id: ckusdc,
                recipient: "  ".to_string(),
                from_cketh_subaccount: Some(vec![7u8; 32]),
                from_ckerc20_subaccount: Some(vec![7u8; 32]),
            })
            .unwrap(),
        )
        .expect("withdraw_erc20 (empty recipient) update_call rejected");
    let decoded: Result<RetrieveErc20RequestMirror, WithdrawErc20ErrorMirror> = decode_one(&reply).unwrap();
    assert!(
        matches!(decoded, Err(WithdrawErc20ErrorMirror::TemporarilyUnavailable(_))),
        "empty recipient must return TemporarilyUnavailable mirroring a minter reject, got: {:?}",
        decoded
    );

    println!("[withdraw_erc20] ✓ mock minter's withdraw_erc20 mirrors the real ckETH minter's variants");
}
