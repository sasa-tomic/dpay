//! The user-principal OFFRAMP rail: the device key ITSELF signs `icrc2_approve` on the REAL
//! ic-icrc1-ledger and `retrieve_btc_with_approval` on the mock ckBTC minter — both submitted as
//! envelopes through `/api/v2` — proving the approve→transfer_from burn bookkeeping end-to-end
//! with envelope-only auth (offline, deterministic, seconds). The env wires the ledger the mainnet
//! ckBTC way (`minting_account.owner = minter`), so the minter's default account is the burn sink.

use candid::{decode_one, encode_one};
use dpay_icp_tests::{
    wire, Env, RequestStatus, RetrieveBtcOk, RetrieveBtcWithApprovalArgs, RetrieveBtcWithApprovalError,
};
use ed25519_dalek::SigningKey;
use icrc_ledger_types::icrc2::allowance::Allowance;

const MINT: u64 = 1_000_000;
/// Above the mock minter's `retrieve_btc_min_amount` (50_000 sats — mirrors the LIVE ckBTC minter).
const RETRIEVE: u64 = 60_000;

#[test]
fn user_offramp_approve_retrieve() {
    let e = Env::offramp();
    let minter = e.minter.clone().expect("offramp env installs the mock minter");
    let p1 = SigningKey::from([3u8; 32]);
    let p1p = wire::principal_of(&p1);
    e.fund_default(&p1p, MINT);

    // RAIL leg 1 — the user's own icrc2_approve granting the minter an allowance over the user's
    // default subaccount.
    let spender = wire::account(&minter);
    let approve = wire::approve_arg(&spender, RETRIEVE, wire::LEDGER_FEE);
    let (envelope, rid) =
        wire::sign_update_envelope(&p1, &e.ledger, "icrc2_approve", &approve, wire::expiry_ahead(240));
    e.call_ok(&e.ledger, &envelope);
    match e.wait_terminal(&p1, &e.ledger, &rid) {
        RequestStatus::Replied { arg } => {
            let idx =
                wire::decode_approve(&arg).unwrap_or_else(|e| panic!("approve result is Ok: {e}"));
            assert_eq!(idx, 1, "approve = block 1 (block 0 = seed mint)");
        }
        RequestStatus::Rejected { reject_code, reject_message } => {
            panic!("signed approve rejected: {reject_code} {reject_message}")
        }
    }

    // The allowance is visible on-ledger via a signed query before it is consumed.
    let al = e
        .query(&p1, &e.ledger, "icrc2_allowance", &wire::allowance_arg(&wire::account(&p1p), &spender))
        .expect("allowance query");
    let al: Allowance = decode_one(&al).expect("allowance decode");
    assert_eq!(dpay_icp_tests::nat_u64_of(&al.allowance), RETRIEVE);

    // RAIL leg 2 — the user's own retrieve_btc_with_approval call on the MINTER canister. The mock
    // mirrors the real ckBTC minter's single-record candid exactly; the default subaccount must be
    // passed explicitly here as a 32-byte blob (a None would decode as an empty, invalid subaccount).
    let retrieve = encode_one(&RetrieveBtcWithApprovalArgs {
        address: "bc1qmockrail00000000000000000000000000000".into(), // mock only rejects empty
        amount: RETRIEVE,
        from_subaccount: Some([0u8; 32].to_vec()),
    })
    .unwrap();
    let (envelope, rid) =
        wire::sign_update_envelope(&p1, &minter, "retrieve_btc_with_approval", &retrieve, wire::expiry_ahead(240));
    e.call_ok(&minter, &envelope);
    let burn_block = match e.wait_terminal(&p1, &minter, &rid) {
        RequestStatus::Replied { arg } => match decode_one::<Result<RetrieveBtcOk, RetrieveBtcWithApprovalError>>(&arg)
            .expect("retrieve result decode")
        {
            Ok(ok) => dpay_icp_tests::nat_u64_of(&ok.block_index),
            Err(err) => panic!("retrieve_btc_with_approval failed: {err:?}"),
        },
        RequestStatus::Rejected { reject_code, reject_message } => {
            panic!("signed retrieve rejected: {reject_code} {reject_message}")
        }
    };
    assert_eq!(burn_block, 2, "burn transfer_from lands on ledger block 2 (0=seed, 1=approve)");

    // Ledger bookkeeping, read through the rail. Measured on the REAL ic-icrc1-ledger: the
    // approve costs its fee, but the burn leg (the minter's exact mainnet candid, `fee: null`)
    // debits amount-only — transfers into the minting account are fee-exempt — and the minting
    // account is never credited: the 60_000 ckBTC left circulation entirely (supply burned).
    assert_eq!(e.rail_balance(&p1, &p1p), MINT - RETRIEVE - wire::LEDGER_FEE);
    assert_eq!(e.pic_balance(&minter), 0, "burn sink: minting account is not credited");
    // The allowance was fully consumed.
    let al = e
        .query(&p1, &e.ledger, "icrc2_allowance", &wire::allowance_arg(&wire::account(&p1p), &spender))
        .expect("allowance query after retrieve");
    let al: Allowance = decode_one(&al).expect("allowance decode");
    assert_eq!(dpay_icp_tests::nat_u64_of(&al.allowance), 0);
}
