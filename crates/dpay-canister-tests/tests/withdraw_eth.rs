//! PocketIC proof that the dpay **facade** canister's `withdraw` dispatches a NATIVE ckETH
//! withdrawal (CkEthErc20 family, `token_contract = None`) to the ckETH minter's `withdraw_eth` —
//! NOT to the ckBTC minter's `retrieve_btc_with_approval` (offline, deterministic, seconds).
//!
//! This is the headline native-asset OUT feature: getting native ETH out of the wallet. The facade
//! reads the currency's `minter_family` (CkEthErc20) + `token_contract` (None) from `CURRENCY_META`
//! and routes to `withdraw_eth`; the BTC floor (retrieve_btc_min_amount = 50_000 sats) does NOT apply
//! to ETH (the ckETH minter enforces its own Wei minimum).
//!
//! Builds three wasms (see `just test-canister`):
//!   DPAY_CANISTER_WASM      = dpay-canister       (the facade: family-dispatches withdraw)
//!   DPAY_MOCK_MINTER_WASM   = dpay-mock-minter    (test-only minter; serves BOTH BTC + ETH surfaces)
//!   DPAY_ICRC_LEDGER_WASM   = ic-icrc1-ledger     (the REAL DFINITY ledger the ckETH burn lands on)
//!
//! Proves: a CkEthErc20 withdraw reaches `withdraw_eth` (asserted via amount-below-BTC-min succeeding
//! — the BTC branch would reject < 50_000 locally); the ckETH ledger is debited by `amount` + total
//! supply drops (the burn); a same-nonce replay is rejected; a wrong sig + an expired auth are
//! rejected; a below-mock-Wei-min withdraw returns the minter's AmountTooLow (permanent → dead auth).

use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use dpay_core::{generate_keypair, sign_withdraw, Currency, WithdrawAuth};
use ed25519_dalek::SigningKey;
use icrc_ledger_types::icrc1::account::Account;
use pocket_ic::{PocketIc, Time};
use serde::Deserialize;

const T0_SECS: u64 = 1_800_000_000;
const T0_NANOS: u64 = T0_SECS * 1_000_000_000;
const CAP: u64 = 100_000;

/// The ckETH test currency id (DEMO=0, ckBTC=1, ckUSDC=2; 5 is a fresh id for this proof).
const CKETH: Currency = 5;

/// 1 ETH in Wei (18 decimals). A comfortable test fund well above every floor.
const ONE_ETH: u64 = 1_000_000_000_000_000_000;

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
struct LedgerConfig {
    currency: Currency,
    principal: Principal,
    mintable: bool,
}

#[derive(CandidType, serde::Serialize)]
struct DpayInitArg {
    ledgers: Vec<LedgerConfig>,
    per_tx_cap: u64,
    controller: Option<Principal>,
}

#[derive(CandidType, serde::Serialize)]
struct MockMinterInit {
    ledger: Principal,
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

/// Local mirror of the canister's `MinterFamily` (candid wire type) for `register_currency_meta`.
#[derive(CandidType, serde::Serialize)]
enum MinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

/// Local mirror of the canister's `RampCapability` (candid wire type).
#[derive(CandidType, serde::Serialize)]
enum RampCapability {
    Direct,
    Partner,
    Unavailable,
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

/// Install an 18-decimals ckETH ledger with icrc2 enabled (the withdraw path uses `icrc2_approve` +
/// `icrc2_transfer_from`). The mock owns the minting account.
fn install_ledger(pic: &PocketIc, minting_account: Account) -> Principal {
    let ledger = pic.create_canister();
    pic.add_cycles(ledger, 10_000_000_000_000);
    let init = LedgerArg::Init(LedgerInitArgs {
        minting_account,
        fee_collector_account: None,
        transfer_fee: Nat::from(0u64),
        decimals: Some(18),
        max_memo_length: None,
        token_symbol: "ckETH".into(),
        token_name: "Demo ckETH".into(),
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
    ledger
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
/// the minting account (owned by `mock`) to `Account{owner: facade, subaccount: payer}`. Debating the
/// minting account's default subaccount is an ICRC MINT, so the user's facade subaccount is credited
/// without the facade ever being invoked.
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

/// Register currency metadata for CKETH: `minter_family = CkEthErc20`, `token_contract = None`
/// (native ETH — the dispatch key that routes `withdraw` to `withdraw_eth`). Called as the seeded
/// controller (the management-canister principal).
fn register_currency_meta_eth(pic: &PocketIc, dpay: Principal, caller: Principal, currency: Currency) {
    let reply = pic
        .update_call(
            dpay,
            caller,
            "register_currency_meta",
            encode_args((
                currency,
                None::<String>,                      // symbol
                None::<u8>,                          // decimals
                Some(MinterFamily::CkEthErc20),      // minter_family — THE dispatch key
                None::<String>,                      // wrapper_name
                None::<String>,                      // backing_symbol
                None::<String>,                      // network
                None::<u8>,                          // display_decimals
                None::<u64>,                         // fee
                None::<u64>,                         // cap (withdraw does not consult cap)
                None::<u32>,                         // chain_id
                None::<String>,                      // token_contract = None → native ETH
                RampCapability::Unavailable,         // onramp
                RampCapability::Direct,              // offramp (cash-out is the direct ckETH→ETH path)
            ))
            .unwrap(),
        )
        .expect("register_currency_meta update_call rejected");
    decode_one::<Result<(), String>>(&reply)
        .unwrap()
        .expect("register_currency_meta should succeed for the controller");
}

/// Install the facade + a ckETH ledger (minting account owned by the mock) + the mock minter, and
/// register the mock as CKETH's minter + the CkEthErc20/no-token-contract family meta. Returns the
/// handles a withdraw_eth test needs.
fn setup_eth() -> (PocketIc, Principal, Principal, Principal, SigningKey, [u8; 32]) {
    let pic = PocketIc::new();
    pic.set_time(Time::from_nanos_since_unix_epoch(T0_NANOS));

    let payer_sk = generate_keypair();
    let payer = payer_sk.verifying_key().to_bytes();

    let dpay = pic.create_canister();
    pic.add_cycles(dpay, 2_000_000_000_000);
    let mock = pic.create_canister();
    pic.add_cycles(mock, 2_000_000_000_000);

    let cketh = install_ledger(&pic, Account { owner: mock, subaccount: None });

    pic.install_canister(
        mock,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { ledger: cketh }).unwrap(),
        None,
    );

    // Seed a controller at init so `register_minter` + `register_currency_meta` (controller-only
    // since R1) succeed. The stable management-canister principal stands in for the governed operator.
    let admin = Principal::management_canister();
    let dpay_init = DpayInitArg {
        ledgers: vec![LedgerConfig { currency: CKETH, principal: cketh, mintable: false }],
        per_tx_cap: CAP,
        controller: Some(admin),
    };
    pic.install_canister(dpay, dpay_wasm(), encode_one(&dpay_init).unwrap(), None);

    let reply = pic
        .update_call(dpay, admin, "register_minter", encode_args((CKETH, mock)).unwrap())
        .expect("register_minter update_call rejected");
    decode_one::<Result<(), String>>(&reply)
        .unwrap()
        .expect("register_minter should succeed for the controller");

    register_currency_meta_eth(&pic, dpay, admin, CKETH);

    (pic, cketh, dpay, mock, payer_sk, payer)
}

// --- tests --------------------------------------------------------------------------------------

/// THE HEADLINE: a CkEthErc20 (token_contract None) withdraw dispatches to `withdraw_eth`, NOT to
/// `retrieve_btc_with_approval`. Proof by contradiction: the withdrawn amount (2_000 Wei) is BELOW
/// the BTC floor (`retrieve_btc_min_amount` = 50_000). If the facade wrongly dispatched to the BTC
/// branch, the BTC-local floor check would reject the withdraw with "amount below
/// retrieve_btc_min_amount". The withdraw SUCCEEDS → the facade took the ETH branch (which has no
/// BTC floor and the mock's withdraw_eth accepts 2_000 ≥ the ETH min of 1_000).
#[test]
fn withdraw_eth_dispatches_withdraw_eth_not_retrieve_btc() {
    let (pic, cketh, dpay, _mock, payer_sk, payer) = setup_eth();
    const WITHDRAW: u64 = 2_000; // Wei; below BTC's 50_000 floor, above ETH's 1_000 mock floor

    direct_credit(&pic, cketh, _mock, dpay, payer, ONE_ETH);
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH);

    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xRecipientEthDestination",
        WITHDRAW,
        [1u8; 16],
        T0_SECS + 120,
        CKETH,
    );
    let receipt = withdraw(&pic, dpay, req).expect("ETH withdraw should succeed");
    assert_eq!(receipt.amount, WITHDRAW);
    assert_eq!(receipt.currency, CKETH);
    assert_eq!(receipt.destination, "0xRecipientEthDestination");
    assert!(receipt.block_index > 0, "withdraw_eth must return a burn block_index");

    // Debited by exactly WITHDRAW (the mock consumes `amount`; the fee approval is leftover allowance).
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH - WITHDRAW);
    println!(
        "[withdraw_eth] ✓ dispatched to withdraw_eth (amount {WITHDRAW} < BTC floor 50_000 succeeded); block_index = {}",
        receipt.block_index
    );
}

/// The ckETH was DEBITED from the user's subaccount AND burned (the mock's transfer_from lands in the
/// minting account → total supply drops). Mirrors the BTC withdraw's burn assertion.
#[test]
fn withdraw_eth_debits_cketh_from_subaccount_and_burns_supply() {
    let (pic, cketh, dpay, mock, payer_sk, payer) = setup_eth();
    const WITHDRAW: u64 = 5_000; // Wei; above both floors

    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);
    assert_eq!(total_supply(&pic, cketh), ONE_ETH);

    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xBurnProof",
        WITHDRAW,
        [2u8; 16],
        T0_SECS + 120,
        CKETH,
    );
    let receipt = withdraw(&pic, dpay, req).expect("withdraw should succeed");
    assert_eq!(receipt.amount, WITHDRAW);

    // Debited from the user's facade subaccount (read DIRECTLY off the ledger).
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH - WITHDRAW);
    // BURNED: total supply drops by exactly WITHDRAW (faithful to the real minter, which is the
    // ledger's minting-account owner — a transfer to its default account removes from supply).
    assert_eq!(
        total_supply(&pic, cketh),
        ONE_ETH - WITHDRAW,
        "the withdrawal must burn ckETH (reduce total supply by the withdrawn amount)"
    );
    println!("[withdraw_eth] ✓ debited {WITHDRAW} Wei + burned (supply {ONE_ETH} → {})", ONE_ETH - WITHDRAW);
}

/// A replay with the SAME nonce is rejected — no double-burn. Mirrors the BTC test.
#[test]
fn withdraw_eth_double_withdraw_rejected() {
    let (pic, cketh, dpay, mock, payer_sk, payer) = setup_eth();
    const WITHDRAW: u64 = 3_000;
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);

    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xFirst",
        WITHDRAW,
        [3u8; 16],
        T0_SECS + 120,
        CKETH,
    );
    let first = withdraw(&pic, dpay, req).expect("first withdraw should succeed");
    assert_eq!(first.amount, WITHDRAW);
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH - WITHDRAW);

    // Replay the SAME signed authorization (same nonce): rejected — no second burn.
    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xFirst",
        WITHDRAW,
        [3u8; 16], // same nonce
        T0_SECS + 120,
        CKETH,
    );
    let second = withdraw(&pic, dpay, req);
    assert!(second.is_err(), "a replay with the same nonce must be rejected");
    let err = second.unwrap_err();
    assert!(err.contains("nonce"), "replay error must mention the nonce, got: {err}");

    // No double-burn: balance unchanged after the rejected replay.
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH - WITHDRAW);
    println!("[withdraw_eth] ✓ same-nonce replay rejected ({err})");
}

/// A wrong-signature withdrawal is rejected; no funds move. Mirrors the BTC test.
#[test]
fn withdraw_eth_wrong_sig_rejected_no_funds_move() {
    let (pic, cketh, dpay, mock, _payer_sk, payer) = setup_eth();
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);

    // Sign the WithdrawAuth with a DIFFERENT key, but present `from_pubkey = payer`.
    let other_sk = generate_keypair();
    let auth = WithdrawAuth {
        from_pubkey: payer,
        destination: "0xAttacker".to_string(),
        amount: 5_000,
        nonce: [4u8; 16],
        expiry: T0_SECS + 120,
        currency: CKETH,
    };
    let wrong_sig = sign_withdraw(&other_sk, &auth).to_bytes();
    let req = WithdrawRequest {
        from_pubkey: payer.to_vec(),
        destination: "0xAttacker".to_string(),
        amount: 5_000,
        nonce: vec![4u8; 16],
        expiry: T0_SECS + 120,
        currency: CKETH,
        sig: wrong_sig.to_vec(),
    };
    let res = withdraw(&pic, dpay, req);
    assert!(res.is_err(), "a wrong-signature withdrawal must be rejected");
    let err = res.unwrap_err();
    assert!(err.contains("signature"), "wrong-sig error must mention signature, got: {err}");

    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH, "no debit on a bad sig");
    println!("[withdraw_eth] ✓ wrong-sig rejected ({err})");
}

/// An expired authorization is rejected; no funds move.
#[test]
fn withdraw_eth_expired_rejected_no_funds_move() {
    let (pic, cketh, dpay, mock, payer_sk, payer) = setup_eth();
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);

    // expiry in the past relative to T0 (the canister's clock is fixed at T0_SECS via set_time).
    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xExpired",
        5_000,
        [5u8; 16],
        T0_SECS - 1, // already expired
        CKETH,
    );
    let res = withdraw(&pic, dpay, req);
    assert!(res.is_err(), "an expired withdrawal must be rejected");
    let err = res.unwrap_err();
    assert!(err.contains("expired"), "expired error must mention expiry, got: {err}");

    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH, "no debit on an expired auth");
    println!("[withdraw_eth] ✓ expired rejected ({err})");
}

/// A below-mock-Wei-min withdrawal returns the minter's `AmountTooLow` (a PERMANENT error → the
/// facade SETTLES the nonce: the dead auth can never replay). Pins both the ETH floor path AND the
/// settle-on-permanent classification.
#[test]
fn withdraw_eth_below_min_rejected_and_nonce_settled() {
    let (pic, cketh, dpay, mock, payer_sk, payer) = setup_eth();
    direct_credit(&pic, cketh, mock, dpay, payer, ONE_ETH);

    // 500 Wei < the mock's MIN_WITHDRAWAL_ETH_AMOUNT (1_000). The minter returns AmountTooLow.
    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xTooSmall",
        500,
        [6u8; 16],
        T0_SECS + 120,
        CKETH,
    );
    let res = withdraw(&pic, dpay, req);
    assert!(res.is_err(), "a below-min withdrawal must be rejected");
    let err = res.unwrap_err();
    assert!(
        err.contains("withdraw_eth amount too low"),
        "below-min error must reference withdraw_eth amount too low, got: {err}"
    );

    // Nothing moved.
    assert_eq!(ledger_balance(&pic, cketh, dpay, payer), ONE_ETH, "no debit on a below-min withdraw");

    // PERMANENT error → the nonce is SETTLED (dead auth). A replay of the SAME authorization must be
    // rejected with "nonce already used" (NOT retried): AmountTooLow means the auth is permanently
    // invalid, so settling prevents a same-auth retry from ever re-attempting the burn.
    let req = withdraw_request(
        &payer_sk,
        payer,
        "0xTooSmall",
        500,
        [6u8; 16], // same nonce
        T0_SECS + 120,
        CKETH,
    );
    let replay = withdraw(&pic, dpay, req);
    assert!(replay.is_err(), "a replay of a settled (AmountTooLow) nonce must be rejected");
    let err = replay.unwrap_err();
    assert!(
        err.contains("nonce"),
        "replay after AmountTooLow-settle must mention the nonce, got: {err}"
    );
    println!("[withdraw_eth] ✓ below-min rejected + nonce settled (dead auth) ({err})");
}

// --- mock honesty guard ------------------------------------------------------------------------
// The mock minter's `withdraw_eth` + `eip_1559_transaction_price` candid surfaces mirror the REAL
// ckETH minter's contract. Drives the mock DIRECTLY to assert the variant shapes match mainnet:
// `eip_1559_transaction_price` returns the expected fee record, and `withdraw_eth` returns the
// real-minter-shaped `AmountTooLow { min_withdrawal_amount }` variant for a below-min amount. This is
// the regression net for the mock-mirrors-real-counterparty lesson (the bug class this crate catches).

#[derive(CandidType, serde::Serialize)]
struct WithdrawalArgWire {
    recipient: String,
    amount: Nat,
    from_subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Deserialize, Debug)]
struct RetrieveEthRequestMirror {
    block_index: Nat,
}

#[derive(CandidType, Deserialize, Debug)]
enum WithdrawalErrorMirror {
    AmountTooLow { min_withdrawal_amount: Nat },
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    RecipientAddressBlocked { address: String },
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
fn mock_minter_withdraw_eth_mirrors_real_cketh_minter_contract() {
    let pic = PocketIc::new();
    let mock = pic.create_canister();
    pic.add_cycles(mock, 2_000_000_000_000);
    let cketh = install_ledger(&pic, Account { owner: mock, subaccount: None });
    pic.install_canister(
        mock,
        mock_minter_wasm(),
        encode_one(&MockMinterInit { ledger: cketh }).unwrap(),
        None,
    );

    // eip_1559_transaction_price(null) returns the fee record with the expected Wei cap.
    let reply = pic
        .query_call(
            mock,
            Principal::anonymous(),
            "eip_1559_transaction_price",
            encode_args((Option::<Principal>::None,)).unwrap(),
        )
        .expect("eip_1559_transaction_price query rejected");
    let price: Eip1559TransactionPriceMirror = decode_one(&reply).unwrap();
    assert_eq!(nat_to_u64(&price.gas_limit), 21_000);
    assert_eq!(nat_to_u64(&price.max_transaction_fee), 21_000u64 * 10_000_000_000u64);
    println!("[withdraw_eth] ✓ eip_1559_transaction_price returns the fee record");

    // Below-min: the mock enforces MIN_WITHDRAWAL_ETH_AMOUNT (1_000 Wei), returning the real-minter
    // AmountTooLow { min_withdrawal_amount } variant.
    let facade = Principal::anonymous();
    let sub = vec![7u8; 32];
    let reply = pic
        .update_call(
            mock,
            facade,
            "withdraw_eth",
            encode_one(&WithdrawalArgWire {
                recipient: "0xAnything".to_string(),
                amount: Nat::from(500u64),
                from_subaccount: Some(sub.clone()),
            })
            .unwrap(),
        )
        .expect("withdraw_eth (below-min) update_call rejected");
    let decoded: Result<RetrieveEthRequestMirror, WithdrawalErrorMirror> = decode_one(&reply).unwrap();
    assert!(
        matches!(
            &decoded,
            Err(WithdrawalErrorMirror::AmountTooLow { min_withdrawal_amount })
                if nat_to_u64(min_withdrawal_amount) == 1_000
        ),
        "below-min must return AmountTooLow{{min=1000}} mirroring the real minter, got: {:?}",
        decoded
    );

    // Empty recipient → TemporarilyUnavailable (the mock requires a non-empty recipient).
    let reply = pic
        .update_call(
            mock,
            facade,
            "withdraw_eth",
            encode_one(&WithdrawalArgWire {
                recipient: "  ".to_string(),
                amount: Nat::from(2_000u64),
                from_subaccount: Some(sub),
            })
            .unwrap(),
        )
        .expect("withdraw_eth (empty recipient) update_call rejected");
    let decoded: Result<RetrieveEthRequestMirror, WithdrawalErrorMirror> = decode_one(&reply).unwrap();
    assert!(
        matches!(decoded, Err(WithdrawalErrorMirror::TemporarilyUnavailable(_))),
        "empty recipient must return TemporarilyUnavailable mirroring a minter reject, got: {:?}",
        decoded
    );

    println!("[withdraw_eth] ✓ mock minter's withdraw_eth mirrors the real ckETH minter's variants");
}
