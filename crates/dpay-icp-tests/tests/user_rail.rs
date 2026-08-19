//! The USER-PRINCIPAL rail against the REAL `/api/v2` ingress (PocketIC `make_live` gateway with
//! the production `ic_validator`: real Ed25519 signature + expiry checks) fronting the REAL
//! `ic-icrc1-ledger`: a raw-ed25519 device key whose self-authenticating principal holds funds
//! DIRECTLY on the ledger moves them via dpay-icp-signed envelopes over plain HTTP — offline,
//! deterministic, seconds. Funding is scaffolding (PocketIC admin API); the rail is envelope-only.

use dpay_icp_tests::{wire, RequestStatus};
use ed25519_dalek::SigningKey;

const MINT: u64 = 1_000_000;
const TRANSFER: u64 = 100_000;

fn p1() -> SigningKey {
    SigningKey::from([1u8; 32])
}

fn p2() -> SigningKey {
    SigningKey::from([2u8; 32])
}

/// Happy path: a signed `icrc1_transfer` update executes and the balances move by exactly
/// `amount + fee` / `amount` (both reads are signed queries through the same rail).
#[test]
fn user_transfer_via_signed_envelope() {
    let e = dpay_icp_tests::Env::ledger_only();
    let (p1, p2) = (p1(), p2());
    let (p1p, p2p) = (wire::principal_of(&p1), wire::principal_of(&p2));
    e.fund_default(&p1p, MINT);

    // The fee comes off the rail itself (signed icrc1_fee query), not a test constant.
    let fee = wire::decode_int_u64(&e.query(&p1, &e.ledger, "icrc1_fee", b"DIDL\x00\x00").expect("fee query"));
    assert_eq!(fee, wire::LEDGER_FEE);

    assert_eq!(e.rail_balance(&p1, &p1p), MINT);
    assert_eq!(e.rail_balance(&p1, &p2p), 0);

    // RAIL: sign the transfer as the device key, POST, poll the certified request_status.
    let arg = wire::transfer_arg(&wire::account(&p2p), TRANSFER, fee);
    let (envelope, rid) =
        wire::sign_update_envelope(&p1, &e.ledger, "icrc1_transfer", &arg, wire::expiry_ahead(240));
    e.call_ok(&e.ledger, &envelope);

    match e.wait_terminal(&p1, &e.ledger, &rid) {
        RequestStatus::Replied { arg } => assert_eq!(
            wire::decode_transfer_u64(&arg).expect("transfer result is Ok"),
            1,
            "block 1 = the user transfer (block 0 = the seed mint)"
        ),
        RequestStatus::Rejected { reject_code, reject_message } => {
            panic!("signed transfer rejected: {reject_code} {reject_message}")
        }
    }

    // Exact bookkeeping, read through signed queries as both principals.
    assert_eq!(e.rail_balance(&p1, &p1p), MINT - TRANSFER - fee);
    assert_eq!(e.rail_balance(&p2, &p2p), TRANSFER);
}

/// The production validator rejects a corrupted `sender_sig` at the gateway (4xx mentioning the
/// signature) and no funds move.
#[test]
fn bad_signature_rejected() {
    let e = dpay_icp_tests::Env::ledger_only();
    let (p1, p2) = (p1(), p2());
    let (p1p, p2p) = (wire::principal_of(&p1), wire::principal_of(&p2));
    e.fund_default(&p1p, MINT);

    let arg = wire::transfer_arg(&wire::account(&p2p), TRANSFER, wire::LEDGER_FEE);
    let (mut envelope, _rid) =
        wire::sign_update_envelope(&p1, &e.ledger, "icrc1_transfer", &arg, wire::expiry_ahead(240));

    // Flip one byte of sender_sig — the trailing 64-byte blob of the envelope, so the content
    // (and thus the request_id) is untouched and the signature is the only thing that changed.
    let last = envelope.len() - 1;
    envelope[last] ^= 0xFF;

    let (status, body) = e.call_raw(&e.ledger, &envelope);
    assert_eq!(status, 400, "bad signature must be a 4xx: {status} {body}");
    assert!(
        body.to_lowercase().contains("signature"),
        "gateway error must mention the signature: {body}"
    );
    assert_eq!(e.rail_balance(&p1, &p1p), MINT, "no funds may move on a rejected envelope");
}

/// An `ingress_expiry` in the past is outside the replica's acceptance window and is rejected at
/// the gateway with a 4xx naming the expiry.
#[test]
fn expired_envelope_rejected() {
    let e = dpay_icp_tests::Env::ledger_only();
    let (p1, p2) = (p1(), p2());
    let (p1p, p2p) = (wire::principal_of(&p1), wire::principal_of(&p2));
    e.fund_default(&p1p, MINT);

    let arg = wire::transfer_arg(&wire::account(&p2p), TRANSFER, wire::LEDGER_FEE);
    let past = wire::now_ns().saturating_sub(60 * 1_000_000_000);
    let (envelope, _rid) = wire::sign_update_envelope(&p1, &e.ledger, "icrc1_transfer", &arg, past);

    let (status, body) = e.call_raw(&e.ledger, &envelope);
    assert_eq!(status, 400, "expired envelope must be a 4xx: {status} {body}");
    assert!(
        body.to_lowercase().contains("expiry"),
        "gateway error must mention the expiry: {body}"
    );
    assert_eq!(e.rail_balance(&p1, &p1p), MINT);
}

/// Replay semantics within the expiry window: the IDENTICAL envelope bytes POSTed twice,
/// back-to-back. Observed behavior (pinned here): both POSTs are accepted with 202 and the request
/// executes EXACTLY ONCE — identical bytes hash to the same request_id, and the ingress dedups on
/// it rather than executing twice (no ledger-level `Duplicate` error either). The single ledger
/// block and the single credit to P2 are the proof.
#[test]
fn envelope_replay_within_window() {
    let e = dpay_icp_tests::Env::ledger_only();
    let (p1, p2) = (p1(), p2());
    let (p1p, p2p) = (wire::principal_of(&p1), wire::principal_of(&p2));
    e.fund_default(&p1p, MINT);

    let amount = 9_000u64;
    let arg = wire::transfer_arg(&wire::account(&p2p), amount, wire::LEDGER_FEE);
    let (envelope, rid) =
        wire::sign_update_envelope(&p1, &e.ledger, "icrc1_transfer", &arg, wire::expiry_ahead(240));

    let (s1, b1) = e.call_raw(&e.ledger, &envelope);
    let (s2, b2) = e.call_raw(&e.ledger, &envelope);
    assert_eq!((s1, s2), (202, 202), "both identical POSTs accepted: {b1} {b2}");

    // One shared request_id → one terminal state → one execution.
    match e.wait_terminal(&p1, &e.ledger, &rid) {
        RequestStatus::Replied { arg } => assert_eq!(
            wire::decode_transfer_u64(&arg).expect("replayed transfer result is Ok"),
            1,
            "executed exactly once (block 1; block 0 = the seed mint)"
        ),
        RequestStatus::Rejected { reject_code, reject_message } => {
            panic!("replayed transfer rejected: {reject_code} {reject_message}")
        }
    }

    assert_eq!(e.rail_balance(&p1, &p2p), amount, "P2 credited exactly once");
    assert_eq!(e.rail_balance(&p1, &p1p), MINT - amount - wire::LEDGER_FEE);
}
