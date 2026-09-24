//! Emit deterministic dfx candid argument files for the real dfx-deploy smoke test.
//!
//! This never reimplements money logic: it builds a real [`SignedAuthorization`] with the shared
//! `dpay-core` and serialises it as candid text, so `dfx canister call pay` submits the *exact*
//! 292-byte wire the phone would sign. Deterministic seeds make the deploy reproducible run-to-run,
//! and a far-future `expiry` keeps the fixture valid regardless of the replica's wall clock.
//!
//! ## Subcommands
//!
//! - `(none)` / anything else → emit the dfx candid args under `dfx/args/` (the deploy smoke test).
//! - `wire-layout [OUT.json]` → emit a JSON describing the **frozen** wire layout (field offsets +
//!   lengths) plus a set of golden signed bytes, all derived from the REAL `dpay_core` types. The
//!   JS ed25519 signing shim in the e2e harness reads this file so it never hand-transcribes the
//!   layout and produces byte-identical signatures. The golden key is a FIXED deterministic seed
//!   (not random) so the golden bytes are stable run-to-run and the cross-validation is
//!   reproducible. Idempotent: overwrites `OUT.json` (default `dfx/wire_layout.json`).

use dpay_core::{
    Authorization, PaymentRequest, ReceiptClaim, SignedAuthorization, CheckoutOpen, WithdrawAuth,
    DEMO_USD, MEMO_LEN, NAME_LEN, NONCE_LEN, PUBKEY_LEN, RECEIPT_CLAIM_LEN, REQUEST_LEN, SIG_LEN,
    SIGNING_LEN, CHECKOUT_OPEN_DOMAIN, CHECKOUT_OPEN_DOMAIN_V2, CHECKOUT_OPEN_FIXED_LEN, CHECKOUT_OPEN_FIXED_LEN_V2,
    CHECKOUT_OPEN_MAX_SKEW_SECS, CHECKOUT_OPEN_NAME_LEN_BYTES, CHECKOUT_OPEN_NOTE_LEN_BYTES, WIRE_LEN,
};
use ed25519_dalek::SigningKey;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// A candid `blob "..."` literal with every byte hex-escaped (`\hh`) — unambiguous for any bytes.
fn blob(bytes: &[u8]) -> String {
    let mut s = String::from("blob \"");
    for b in bytes {
        s.push_str(&format!("\\{b:02x}"));
    }
    s.push('"');
    s
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Deterministic Ed25519 key from a single-byte seed pattern (demo only; any 32 bytes is a seed).
fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

/// Pad ASCII to a fixed 32-byte NUL-padded buffer (UTF-8, trailing-0x00, truncate to 32). Mirrors
/// what the app builder does before constructing an `Authorization` / `PaymentRequest`; the core
/// just stores / signs / verifies these raw 32 bytes.
fn pad32(s: &[u8]) -> [u8; NAME_LEN] {
    let mut b = [0u8; NAME_LEN];
    let n = s.len().min(NAME_LEN);
    b[..n].copy_from_slice(&s[..n]);
    b
}

// ===========================================================================
// wire-layout emitter — single source of truth for the JS signing shim.
// ===========================================================================
//
// Every offset/length below is computed from the `dpay_core` consts by name (no hardcoded
// 100/196/68) so a layout change in the core propagates here. A unit test (`wire_layout_tests`)
// reconstructs the golden `Authorization` from these offsets and asserts it round-trips, guarding
// against drift between this emitter and `Authorization::signing_bytes()`.

/// Field offset within the 196-byte signing buffer, computed from the frozen layout in
/// `dpay_core::Authorization::signing_bytes` (`from | to | amount_le | nonce | expiry_le |
/// currency_le | from_name | to_name | memo`). Expressed in terms of the core consts so a layout
/// change in the core propagates here.
const FROM_OFF: usize = 0;
const TO_OFF: usize = PUBKEY_LEN;
const AMOUNT_OFF: usize = 2 * PUBKEY_LEN;
const NONCE_OFF: usize = 2 * PUBKEY_LEN + 8;
const EXPIRY_OFF: usize = 2 * PUBKEY_LEN + 8 + NONCE_LEN;
const CURRENCY_OFF: usize = 2 * PUBKEY_LEN + 16 + NONCE_LEN;
const AMOUNT_LEN: usize = 8;
const EXPIRY_LEN: usize = 8;
const CURRENCY_LEN: usize = 4;
// The three new 32-byte fields, expressed as the previous field's offset + its width (single source
// of truth = the core consts by name).
const FROM_NAME_OFF: usize = CURRENCY_OFF + CURRENCY_LEN;
const TO_NAME_OFF: usize = FROM_NAME_OFF + NAME_LEN;
const MEMO_OFF: usize = TO_NAME_OFF + NAME_LEN;

/// Offsets within the 292-byte wire form (`signing_bytes | sig | from_pub`).
const WIRE_SIGNING_OFF: usize = 0;
const WIRE_SIG_OFF: usize = SIGNING_LEN;
const WIRE_FROM_PUB_OFF: usize = SIGNING_LEN + SIG_LEN;

// ===========================================================================
// request-layout offsets — single source of truth for the JS request shim.
// ===========================================================================
//
// `PaymentRequest::to_bytes` is the FIXED 132-byte layout
//   `to(32) | amount_le(8) | nonce(16) | expiry_le(8) | currency_le(4) | to_name(32) | memo(32)`.
// Every offset below is computed from the core consts by name so a layout change in the core
// propagates here; the total length is `REQUEST_LEN` (imported from the core). The round-trip test
// binds these offsets to `PaymentRequest::to_bytes()` so they cannot drift.

/// `to` offset within the request byte buffer.
const REQ_TO_OFF: usize = 0;
const REQ_AMOUNT_OFF: usize = PUBKEY_LEN;
const REQ_NONCE_OFF: usize = PUBKEY_LEN + 8;
const REQ_EXPIRY_OFF: usize = PUBKEY_LEN + 8 + NONCE_LEN;
const REQ_CURRENCY_OFF: usize = PUBKEY_LEN + 16 + NONCE_LEN;
const REQ_TO_NAME_OFF: usize = PUBKEY_LEN + 16 + NONCE_LEN + 4;
const REQ_MEMO_OFF: usize = PUBKEY_LEN + 16 + NONCE_LEN + 4 + NAME_LEN;

// ===========================================================================
// withdrawal-layout offsets — single source of truth for the JS signing shim.
// ===========================================================================
//
// `WithdrawAuth::signing_bytes` is variable-length (the destination is last), so it does NOT share
// the frozen fixed-size layout of `Authorization`. Its FIXED prefix is
//   `from_pubkey(32) | amount_le(8) | nonce(16) | expiry_le(8) | currency_le(4)` = 68 bytes,
// followed by `addr_len_le(4) | addr_utf8`. Offsets below are computed from the core consts.

/// `from_pubkey` offset within the withdraw signing buffer.
const W_FROM_OFF: usize = 0;
const W_AMOUNT_OFF: usize = PUBKEY_LEN;
const W_NONCE_OFF: usize = PUBKEY_LEN + 8;
const W_EXPIRY_OFF: usize = PUBKEY_LEN + 8 + NONCE_LEN;
const W_CURRENCY_OFF: usize = PUBKEY_LEN + 16 + NONCE_LEN;
const W_ADDR_LEN_OFF: usize = PUBKEY_LEN + 8 + NONCE_LEN + 8 + 4;
/// Fixed-prefix length of the withdraw signing buffer (before the variable address suffix).
const W_FIXED_LEN: usize = PUBKEY_LEN + 8 + NONCE_LEN + 8 + 4;
/// Width of the address-length prefix (u32 LE) appended after the fixed prefix.
const W_ADDR_LEN_BYTES: usize = 4;

// ===========================================================================
// receipt-layout offsets — single source of truth for the JS verify shim.
// ===========================================================================
//
// `ReceiptClaim::signing_bytes` is FIXED-length (unlike `WithdrawAuth`): the canonical 108-byte LE
// concat `nonce(16) | from(32) | to(32) | amount_le(8) | currency_le(4) | block_index_le(8) |
// settle_ts_le(8)`. Every offset below is computed from the core consts by name so a layout change
// in the core propagates here; the total length is `RECEIPT_CLAIM_LEN` (imported from the core, the
// single source of truth). The round-trip test binds these offsets to
// `ReceiptClaim::signing_bytes()` so they cannot drift.

/// `nonce` offset within the receipt signing buffer.
const R_NONCE_OFF: usize = 0;
const R_FROM_OFF: usize = NONCE_LEN;
const R_TO_OFF: usize = NONCE_LEN + PUBKEY_LEN;
const R_AMOUNT_OFF: usize = NONCE_LEN + 2 * PUBKEY_LEN;
const R_CURRENCY_OFF: usize = NONCE_LEN + 2 * PUBKEY_LEN + 8;
const R_BLOCK_INDEX_OFF: usize = NONCE_LEN + 2 * PUBKEY_LEN + 8 + 4;
const R_SETTLE_TS_OFF: usize = NONCE_LEN + 2 * PUBKEY_LEN + 8 + 4 + 8;

/// One withdraw-signing-buffer field (offset + len + endian), mirroring [`FieldSpec`].
#[derive(Serialize)]
struct WithdrawFieldSpec {
    offset: usize,
    len: usize,
    endian: Option<&'static str>,
}

#[derive(Serialize)]
struct WithdrawFields {
    from_pubkey: WithdrawFieldSpec,
    amount: WithdrawFieldSpec,
    nonce: WithdrawFieldSpec,
    expiry: WithdrawFieldSpec,
    currency: WithdrawFieldSpec,
    address_len: WithdrawFieldSpec,
}

/// The golden signed withdrawal bytes. Every `*_hex` is derived from the real `dpay_core`
/// `WithdrawAuth` (never hardcoded) so the JS cross-validation is a true Rust↔JS byte comparison.
#[derive(Serialize)]
struct GoldenWithdraw {
    secret_hex: String,
    public_hex: String,
    destination: String,
    amount: u64,
    nonce_hex: String,
    expiry: u64,
    currency: u32,
    signing_hex: String,
    sig_hex: String,
}

#[derive(Serialize)]
struct WithdrawLayout {
    fixed_len: usize,
    addr_len_bytes: usize,
    fields: WithdrawFields,
    golden: GoldenWithdraw,
}

// ---------------------------------------------------------------------------
// receipt-layout types (FIXED-length 108-byte claim; no variable address).
// ---------------------------------------------------------------------------

/// One receipt-signing-buffer field (offset + len + endian), mirroring [`WithdrawFieldSpec`].
#[derive(Serialize)]
struct ReceiptFieldSpec {
    offset: usize,
    len: usize,
    endian: Option<&'static str>,
}

#[derive(Serialize)]
struct ReceiptFields {
    nonce: ReceiptFieldSpec,
    from: ReceiptFieldSpec,
    to: ReceiptFieldSpec,
    amount: ReceiptFieldSpec,
    currency: ReceiptFieldSpec,
    block_index: ReceiptFieldSpec,
    settle_ts: ReceiptFieldSpec,
}

/// The golden signed receipt bytes. Every `*_hex` is derived from the real `dpay_core` types
/// (never hardcoded) so the JS cross-validation is a true Rust↔JS byte comparison. The receipt is
/// signed by a CANISTER key (`secret_hex`/`public_hex`); `from`/`to` are the payment's two pubkeys.
#[derive(Serialize)]
struct GoldenReceipt {
    secret_hex: String,
    public_hex: String,
    from_hex: String,
    to_hex: String,
    amount: u64,
    nonce_hex: String,
    currency: u32,
    block_index: u64,
    settle_ts: u64,
    signing_hex: String,
    sig_hex: String,
}

#[derive(Serialize)]
struct ReceiptLayout {
    fixed_len: usize,
    fields: ReceiptFields,
    golden: GoldenReceipt,
}

/// One signing-buffer field. `endian` is `null` for raw byte arrays (from/to/nonce) and `"le"` for
/// the little-endian integer fields (amount/expiry/currency).
#[derive(Serialize)]
struct FieldSpec {
    offset: usize,
    len: usize,
    endian: Option<&'static str>,
}

/// One wire-form segment (always raw bytes; no endianness).
#[derive(Serialize)]
struct WireFieldSpec {
    offset: usize,
    len: usize,
}

#[derive(Serialize)]
struct WireFields {
    signing: WireFieldSpec,
    sig: WireFieldSpec,
    from_pub: WireFieldSpec,
}

#[derive(Serialize)]
struct Fields {
    from: FieldSpec,
    to: FieldSpec,
    amount: FieldSpec,
    nonce: FieldSpec,
    expiry: FieldSpec,
    currency: FieldSpec,
    from_name: FieldSpec,
    to_name: FieldSpec,
    memo: FieldSpec,
}

/// The request byte-buffer field layout (`PaymentRequest::to_bytes`). Mirrors [`Fields`] but for
/// the 132-byte request (which carries `to_name` + `memo`, not `from`/`from_name`).
#[derive(Serialize)]
struct RequestFields {
    to: FieldSpec,
    amount: FieldSpec,
    nonce: FieldSpec,
    expiry: FieldSpec,
    currency: FieldSpec,
    to_name: FieldSpec,
    memo: FieldSpec,
}

/// The golden signed bytes. Every `*_hex` is derived from the real `dpay_core` types (never
/// hardcoded) so the JS cross-validation is a true Rust↔JS byte comparison. The `from_name_hex` /
/// `to_name_hex` / `memo_hex` are the pay (signing) golden names; `request_to_name_hex` /
/// `request_memo_hex` are the merchant request's `to_name` / `memo` (the request memo differs from
/// the pay memo by design, so both are carried explicitly).
#[derive(Serialize)]
struct Golden {
    secret_hex: String,
    public_hex: String,
    to_hex: String,
    amount: u64,
    nonce_hex: String,
    expiry: u64,
    currency: u32,
    signing_hex: String,
    sig_hex: String,
    wire_hex: String,
    request_hex: String,
    /// Pay (signing) display names + memo — 32-byte NUL-padded UTF-8.
    from_name_hex: String,
    to_name_hex: String,
    memo_hex: String,
    /// Merchant request's display name + memo — 32-byte NUL-padded UTF-8.
    request_to_name_hex: String,
    request_memo_hex: String,
}

#[derive(Serialize)]
struct WireLayout {
    signing_len: usize,
    wire_len: usize,
    request_len: usize,
    sig_len: usize,
    pubkey_len: usize,
    nonce_len: usize,
    name_len: usize,
    memo_len: usize,
    fields: Fields,
    request_fields: RequestFields,
    wire_fields: WireFields,
    golden: Golden,
    /// The withdrawal (ckBTC→BTC) signing layout + golden signed bytes. Variable-length (the
    /// destination is last), so it has its own section distinct from the fixed `fields`/`golden`.
    withdraw: WithdrawLayout,
    /// The canister-signed receipt (`ReceiptClaim`) signing layout + golden signed bytes.
    /// FIXED-length (108 bytes = `RECEIPT_CLAIM_LEN`), so — unlike `withdraw` — there is no
    /// address-length prefix; the app's verify_receipt shim reads this section.
    receipt: ReceiptLayout,
}

/// Build the wire-layout description. Pure (no I/O) so the unit test can call it directly and
/// assert the golden bytes round-trip through the documented offsets.
fn wire_layout() -> WireLayout {
    // FIXED deterministic seeds — golden bytes must be stable run-to-run so the JS shim's
    // cross-validation is reproducible. `key(3)` is the golden signing key (distinct from the
    // dfx-args payer=1 / merchant=2); `key(4)` is the golden payee.
    let secret = key(3);
    let public: [u8; PUBKEY_LEN] = secret.verifying_key().to_bytes();
    let to: [u8; PUBKEY_LEN] = key(4).verifying_key().to_bytes();

    // Golden payment values — amount/expiry/currency match the dfx-args fixture where sensible so
    // the two emitters describe the same notion of a "demo payment".
    const AMOUNT: u64 = 2_500;
    let nonce = [42u8; NONCE_LEN];
    const EXPIRY: u64 = 4_102_444_800; // 2100-01-01Z — far future, stable across runs
    let currency = DEMO_USD;

    // Golden display names + memo (deterministic ASCII, NUL-padded to 32 bytes by pad32). These are
    // the pay (signing) golden values: payer "Alice", payee "Bob", memo "dinner".
    let from_name = pad32(b"Alice");
    let to_name = pad32(b"Bob");
    let memo = pad32(b"dinner");
    // The merchant request carries the payee's own name + its own memo. to_name is the same "Bob"
    // as the pay golden; the request memo is the distinct "coffee" (chosen different from the pay
    // memo "dinner" so cross-validation can distinguish the two objects).
    let req_to_name = pad32(b"Bob");
    let req_memo = pad32(b"coffee");

    let auth = Authorization { from: public, to, amount: AMOUNT, nonce, expiry: EXPIRY, currency, from_name, to_name, memo };
    // The signing buffer, signature, and full wire all come from the real core types.
    let signing = auth.signing_bytes();
    let sa = SignedAuthorization::new(&secret, auth);
    let sig = sa.sig;
    let wire = sa.to_wire();

    // The request bytes for the same to/amount/nonce/expiry/currency (the merchant's QR) plus the
    // merchant's to_name + memo, also from the real core type.
    let request = PaymentRequest { to, amount: AMOUNT, nonce, expiry: EXPIRY, currency, to_name: req_to_name, memo: req_memo }.to_bytes();

    WireLayout {
        signing_len: SIGNING_LEN,
        wire_len: WIRE_LEN,
        request_len: REQUEST_LEN,
        sig_len: SIG_LEN,
        pubkey_len: PUBKEY_LEN,
        nonce_len: NONCE_LEN,
        name_len: NAME_LEN,
        memo_len: MEMO_LEN,
        fields: Fields {
            from: FieldSpec { offset: FROM_OFF, len: PUBKEY_LEN, endian: None },
            to: FieldSpec { offset: TO_OFF, len: PUBKEY_LEN, endian: None },
            amount: FieldSpec { offset: AMOUNT_OFF, len: AMOUNT_LEN, endian: Some("le") },
            nonce: FieldSpec { offset: NONCE_OFF, len: NONCE_LEN, endian: None },
            expiry: FieldSpec { offset: EXPIRY_OFF, len: EXPIRY_LEN, endian: Some("le") },
            currency: FieldSpec { offset: CURRENCY_OFF, len: CURRENCY_LEN, endian: Some("le") },
            from_name: FieldSpec { offset: FROM_NAME_OFF, len: NAME_LEN, endian: None },
            to_name: FieldSpec { offset: TO_NAME_OFF, len: NAME_LEN, endian: None },
            memo: FieldSpec { offset: MEMO_OFF, len: MEMO_LEN, endian: None },
        },
        request_fields: RequestFields {
            to: FieldSpec { offset: REQ_TO_OFF, len: PUBKEY_LEN, endian: None },
            amount: FieldSpec { offset: REQ_AMOUNT_OFF, len: AMOUNT_LEN, endian: Some("le") },
            nonce: FieldSpec { offset: REQ_NONCE_OFF, len: NONCE_LEN, endian: None },
            expiry: FieldSpec { offset: REQ_EXPIRY_OFF, len: EXPIRY_LEN, endian: Some("le") },
            currency: FieldSpec { offset: REQ_CURRENCY_OFF, len: CURRENCY_LEN, endian: Some("le") },
            to_name: FieldSpec { offset: REQ_TO_NAME_OFF, len: NAME_LEN, endian: None },
            memo: FieldSpec { offset: REQ_MEMO_OFF, len: MEMO_LEN, endian: None },
        },
        wire_fields: WireFields {
            signing: WireFieldSpec { offset: WIRE_SIGNING_OFF, len: SIGNING_LEN },
            sig: WireFieldSpec { offset: WIRE_SIG_OFF, len: SIG_LEN },
            from_pub: WireFieldSpec { offset: WIRE_FROM_PUB_OFF, len: PUBKEY_LEN },
        },
        golden: Golden {
            secret_hex: hex(&secret.to_bytes()),
            public_hex: hex(&public),
            to_hex: hex(&to),
            amount: AMOUNT,
            nonce_hex: hex(&nonce),
            expiry: EXPIRY,
            currency,
            signing_hex: hex(&signing),
            sig_hex: hex(&sig),
            wire_hex: hex(&wire),
            request_hex: hex(&request),
            from_name_hex: hex(&from_name),
            to_name_hex: hex(&to_name),
            memo_hex: hex(&memo),
            request_to_name_hex: hex(&req_to_name),
            request_memo_hex: hex(&req_memo),
        },
        withdraw: withdraw_layout(),
        receipt: receipt_layout(),
    }
}

/// Build the withdrawal-layout description + golden signed bytes. Pure (no I/O) so the unit test can
/// assert the golden withdraw bytes round-trip through the documented offsets. Uses the SAME golden
/// signing key (`key(3)`) as the pay golden so the cross-validation keys match.
fn withdraw_layout() -> WithdrawLayout {
    let secret = key(3);
    let public: [u8; PUBKEY_LEN] = secret.verifying_key().to_bytes();
    // A realistic-shaped BTC address (the bytes are what's signed; the value just needs to be stable
    // + non-trivial so the length-prefix + UTF-8 handling is exercised).
    let destination = "bc1qdpaygoldenwithdrawaladdress".to_string();
    const W_AMOUNT: u64 = 50_000; // exactly retrieve_btc_min_amount
    let w_nonce = [42u8; NONCE_LEN];
    const W_EXPIRY: u64 = 4_102_444_800;
    let w_currency = DEMO_USD;

    let auth = WithdrawAuth {
        from_pubkey: public,
        destination: destination.clone(),
        amount: W_AMOUNT,
        nonce: w_nonce,
        expiry: W_EXPIRY,
        currency: w_currency,
    };
    let signing = auth.signing_bytes();
    let sig = dpay_core::sign_withdraw(&secret, &auth).to_bytes();

    WithdrawLayout {
        fixed_len: W_FIXED_LEN,
        addr_len_bytes: W_ADDR_LEN_BYTES,
        fields: WithdrawFields {
            from_pubkey: WithdrawFieldSpec { offset: W_FROM_OFF, len: PUBKEY_LEN, endian: None },
            amount: WithdrawFieldSpec { offset: W_AMOUNT_OFF, len: 8, endian: Some("le") },
            nonce: WithdrawFieldSpec { offset: W_NONCE_OFF, len: NONCE_LEN, endian: None },
            expiry: WithdrawFieldSpec { offset: W_EXPIRY_OFF, len: 8, endian: Some("le") },
            currency: WithdrawFieldSpec { offset: W_CURRENCY_OFF, len: 4, endian: Some("le") },
            address_len: WithdrawFieldSpec { offset: W_ADDR_LEN_OFF, len: W_ADDR_LEN_BYTES, endian: Some("le") },
        },
        golden: GoldenWithdraw {
            secret_hex: hex(&secret.to_bytes()),
            public_hex: hex(&public),
            destination,
            amount: W_AMOUNT,
            nonce_hex: hex(&w_nonce),
            expiry: W_EXPIRY,
            currency: w_currency,
            signing_hex: hex(&signing),
            sig_hex: hex(&sig),
        },
    }
}

/// Build the receipt-layout description + golden signed bytes. Pure (no I/O) so the unit test can
/// assert the golden receipt bytes round-trip through the documented offsets. Uses the SAME golden
/// signing key (`key(3)`) as the pay/withdraw goldens so the cross-validation keys align. The receipt
/// is signed by the (canister) receipt key; `from`/`to` are the payment's two pubkeys — chosen here
/// as `key(3).public`/`key(4).public` to reuse the pay golden's pubkey values for cross-reference.
fn receipt_layout() -> ReceiptLayout {
    // FIXED deterministic seeds — golden bytes must be stable run-to-run so the JS verify shim's
    // cross-validation is reproducible. `key(3)` is the golden receipt signing key (the canister's
    // receipt key stand-in), distinct from the dfx-args payer=1 / merchant=2.
    let secret = key(3);
    let public: [u8; PUBKEY_LEN] = secret.verifying_key().to_bytes();
    // `from`/`to` reuse the pay golden's two pubkeys (key(3).public / key(4).public) so a reader can
    // cross-reference the receipt against the payment it attests; the values are otherwise arbitrary.
    let from: [u8; PUBKEY_LEN] = public;
    let to: [u8; PUBKEY_LEN] = key(4).verifying_key().to_bytes();

    // Golden receiptClaim values. `amount` = 1_234 cents = $12.34 (DEMO_USD is 2-decimal); the nonce
    // mirrors the pay/withdraw golden ([42u8;16]); `block_index`/`settle_ts` are deterministic.
    const R_AMOUNT: u64 = 1_234; // $12.34
    let nonce = [42u8; NONCE_LEN];
    let currency = DEMO_USD;
    const R_BLOCK_INDEX: u64 = 7;
    const R_SETTLE_TS: u64 = 1_700_000_000; // 2023-11-14T22:13:20Z — a stable, non-round timestamp

    let claim = ReceiptClaim {
        nonce,
        from,
        to,
        amount: R_AMOUNT,
        currency,
        block_index: R_BLOCK_INDEX,
        settle_ts: R_SETTLE_TS,
    };
    // The signing buffer + signature both come from the real core types.
    let signing = claim.signing_bytes();
    let sig = dpay_core::sign_receipt(&secret, &claim).to_bytes();

    ReceiptLayout {
        fixed_len: RECEIPT_CLAIM_LEN,
        fields: ReceiptFields {
            nonce: ReceiptFieldSpec { offset: R_NONCE_OFF, len: NONCE_LEN, endian: None },
            from: ReceiptFieldSpec { offset: R_FROM_OFF, len: PUBKEY_LEN, endian: None },
            to: ReceiptFieldSpec { offset: R_TO_OFF, len: PUBKEY_LEN, endian: None },
            amount: ReceiptFieldSpec { offset: R_AMOUNT_OFF, len: 8, endian: Some("le") },
            currency: ReceiptFieldSpec { offset: R_CURRENCY_OFF, len: 4, endian: Some("le") },
            block_index: ReceiptFieldSpec { offset: R_BLOCK_INDEX_OFF, len: 8, endian: Some("le") },
            settle_ts: ReceiptFieldSpec { offset: R_SETTLE_TS_OFF, len: 8, endian: Some("le") },
        },
        golden: GoldenReceipt {
            secret_hex: hex(&secret.to_bytes()),
            public_hex: hex(&public),
            from_hex: hex(&from),
            to_hex: hex(&to),
            amount: R_AMOUNT,
            nonce_hex: hex(&nonce),
            currency,
            block_index: R_BLOCK_INDEX,
            settle_ts: R_SETTLE_TS,
            signing_hex: hex(&signing),
            sig_hex: hex(&sig),
        },
    }
}

// ===========================================================================
// checkout-open golden — the merchant's proof that the checkout account they name is theirs.
// ===========================================================================
//
// `CheckoutOpen::signing_bytes` is variable-length (the claimed merchant name is last), so like
// `WithdrawAuth` it gets its own document rather than a slot in the fixed layout. Every offset below
// is expressed in terms of the core consts by name, and the unit test rebuilds the golden struct
// purely from these offsets — so a change to the core encoding cannot pass unnoticed.
//
// The golden name is deliberately MULTI-BYTE UTF-8: it is the only cheap way to prove the length
// prefix counts bytes rather than characters on both sides of the language boundary.

/// `domain` offset within the checkout-open signing buffer (identical in v1 and v2 — the tag is first).
const T_DOMAIN_OFF: usize = 0;
const T_PUBKEY_OFF: usize = CHECKOUT_OPEN_DOMAIN_V2.len();
const T_CENTS_OFF: usize = T_PUBKEY_OFF + PUBKEY_LEN;
const T_NONCE_OFF: usize = T_CENTS_OFF + 8;
const T_ISSUED_AT_OFF: usize = T_NONCE_OFF + NONCE_LEN;
const T_NAME_LEN_OFF: usize = CHECKOUT_OPEN_FIXED_LEN_V2;

/// One checkout-open signing-buffer field (offset + len + endian), mirroring [`WithdrawFieldSpec`].
#[derive(Serialize)]
struct CheckoutOpenFieldSpec {
    offset: usize,
    len: usize,
    endian: Option<&'static str>,
}

#[derive(Serialize)]
struct CheckoutOpenFields {
    domain: CheckoutOpenFieldSpec,
    merchant_pubkey: CheckoutOpenFieldSpec,
    cents: CheckoutOpenFieldSpec,
    nonce: CheckoutOpenFieldSpec,
    issued_at: CheckoutOpenFieldSpec,
    name_len: CheckoutOpenFieldSpec,
    note_len: CheckoutOpenFieldSpec,
}

/// The golden signed checkout-open bytes, every `*_hex` derived from the real `dpay_core::CheckoutOpen`.
/// The GOLDEN is the v2 (note-bearing) buffer this encoding now exists for; `legacy_v1` below pins
/// the frozen note-less buffer the committed wasm export `w_checkout_open_sig` must keep producing.
#[derive(Serialize)]
struct GoldenCheckoutOpen {
    secret_hex: String,
    merchant_pubkey_hex: String,
    cents: u64,
    nonce_hex: String,
    issued_at: u64,
    merchant_name: String,
    note: String,
    signing_hex: String,
    sig_hex: String,
}

/// The frozen v1 (note-less) spelling of the same request, kept so the wasm guard can check the
/// additive-only export against the bytes it has always produced.
#[derive(Serialize)]
struct LegacyCheckoutOpenV1 {
    domain: &'static str,
    domain_hex: String,
    fixed_len: usize,
    signing_hex: String,
    sig_hex: String,
}

#[derive(Serialize)]
struct CheckoutOpenDoc {
    #[serde(rename = "_doc")]
    doc: &'static str,
    domain: &'static str,
    domain_hex: String,
    max_skew_secs: u64,
    fixed_len: usize,
    name_len_bytes: usize,
    note_len_bytes: usize,
    sig_len: usize,
    fields: CheckoutOpenFields,
    golden: GoldenCheckoutOpen,
    legacy_v1: LegacyCheckoutOpenV1,
}

/// Build the checkout-open golden. Pure (no I/O) so the unit test can compare it against the committed
/// file. Reuses `key(3)` — the same golden signing key as the pay/withdraw/receipt goldens, so a
/// reader can cross-reference the merchant's key across every document this emitter writes.
fn checkout_open_doc() -> CheckoutOpenDoc {
    let secret = key(3);
    let merchant_pubkey: [u8; PUBKEY_LEN] = secret.verifying_key().to_bytes();

    // CHF 10.00 — the same price `dfx/checkout_wire.json` records for its golden charge, so the two
    // documents describe the same imagined sale. Multi-byte name AND note on purpose (see the note
    // above): each length prefix must count bytes rather than characters.
    const T_CENTS: u64 = 1_000;
    let nonce = [42u8; NONCE_LEN];
    const T_ISSUED_AT: u64 = 1_786_815_398; // stable, non-round unix seconds
    let merchant_name = "Café Bahnhof ☕".to_string();
    let note = "2× Kafi, Tisch 4 ☕".to_string();

    let open = CheckoutOpen {
        merchant_pubkey,
        cents: T_CENTS,
        nonce,
        issued_at: T_ISSUED_AT,
        merchant_name: merchant_name.clone(),
        note: Some(note.clone()),
    };
    let signing = open.signing_bytes();
    let sig = dpay_core::sign_checkout_open(&secret, &open).to_bytes();
    let note_len_offset = CHECKOUT_OPEN_FIXED_LEN_V2 + CHECKOUT_OPEN_NAME_LEN_BYTES + merchant_name.len();

    // The same request without a note — the v1 buffer every deployed verifier already checks.
    let legacy = CheckoutOpen { note: None, ..open.clone() };
    let legacy_signing = legacy.signing_bytes();
    let legacy_sig = dpay_core::sign_checkout_open(&secret, &legacy).to_bytes();

    CheckoutOpenDoc {
        doc: "The canonical bytes a merchant signs to open a charge on dpay's own OpenCryptoPay checkout, and the ONE statement of that encoding outside dpay_core::CheckoutOpen. Two spellings live here: `golden` is the v2 buffer (domain dpay-checkout-open-v2) a request carrying a sale's `note` signs — the note rides its own u32-LE length prefix after the name — and `legacy_v1` is the frozen note-less buffer (domain dpay-checkout-open-v1) the wasm export w_checkout_open_sig must keep producing under the additive-only ABI policy. Emitted from the real core by `just wire-layout`; read back by crates/dpay-fixture (which rebuilds the golden struct from these offsets alone) and by scripts/check-wasm-core.mjs (which reproduces both buffers field-by-field in JS and checks the committed wasm's w_checkout_open_sig against legacy_v1.sig_hex and w_checkout_open_sig_note against golden.sig_hex). The relay verifies with dpay_core::validate_checkout_open, so it shares the encoding rather than a copy of it. Same convention as dfx/wire_layout.json — regenerated when the encoding deliberately changes, never hand-edited to make a test pass.",
        domain: "dpay-checkout-open-v2",
        domain_hex: hex(CHECKOUT_OPEN_DOMAIN_V2),
        max_skew_secs: CHECKOUT_OPEN_MAX_SKEW_SECS,
        fixed_len: CHECKOUT_OPEN_FIXED_LEN_V2,
        name_len_bytes: CHECKOUT_OPEN_NAME_LEN_BYTES,
        note_len_bytes: CHECKOUT_OPEN_NOTE_LEN_BYTES,
        sig_len: SIG_LEN,
        fields: CheckoutOpenFields {
            domain: CheckoutOpenFieldSpec { offset: T_DOMAIN_OFF, len: CHECKOUT_OPEN_DOMAIN_V2.len(), endian: None },
            merchant_pubkey: CheckoutOpenFieldSpec { offset: T_PUBKEY_OFF, len: PUBKEY_LEN, endian: None },
            cents: CheckoutOpenFieldSpec { offset: T_CENTS_OFF, len: 8, endian: Some("le") },
            nonce: CheckoutOpenFieldSpec { offset: T_NONCE_OFF, len: NONCE_LEN, endian: None },
            issued_at: CheckoutOpenFieldSpec { offset: T_ISSUED_AT_OFF, len: 8, endian: Some("le") },
            name_len: CheckoutOpenFieldSpec { offset: T_NAME_LEN_OFF, len: CHECKOUT_OPEN_NAME_LEN_BYTES, endian: Some("le") },
            note_len: CheckoutOpenFieldSpec { offset: note_len_offset, len: CHECKOUT_OPEN_NOTE_LEN_BYTES, endian: Some("le") },
        },
        golden: GoldenCheckoutOpen {
            secret_hex: hex(&secret.to_bytes()),
            merchant_pubkey_hex: hex(&merchant_pubkey),
            cents: T_CENTS,
            nonce_hex: hex(&nonce),
            issued_at: T_ISSUED_AT,
            merchant_name,
            note,
            signing_hex: hex(&signing),
            sig_hex: hex(&sig),
        },
        legacy_v1: LegacyCheckoutOpenV1 {
            domain: "dpay-checkout-open-v1",
            domain_hex: hex(CHECKOUT_OPEN_DOMAIN),
            fixed_len: CHECKOUT_OPEN_FIXED_LEN,
            signing_hex: hex(&legacy_signing),
            sig_hex: hex(&legacy_sig),
        },
    }
}

/// Render the checkout-open golden as pretty JSON (the exact text the committed file holds). Shared by
/// the emitter and the drift test, so "what we would write" and "what we compare" are one function.
fn checkout_open_json() -> String {
    serde_json::to_string_pretty(&checkout_open_doc())
        .unwrap_or_else(|e| panic!("checkout-open JSON serialization failed: {e}"))
}

/// Write a golden document to `out`, creating its directory first (idempotent: overwrites). Shared
/// by every emitter here so "where the goldens go and how they fail" is stated once. A path with no
/// parent (`x.json`) or an empty one needs no mkdir — anything else that cannot be created panics
/// with the path, because a golden that silently failed to write is worse than no golden.
fn write_golden(out: &Path, contents: &str) {
    match out.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => fs::create_dir_all(parent)
            .unwrap_or_else(|e| panic!("mkdir {}: {e}", parent.display())),
        _ => {}
    }
    fs::write(out, contents).unwrap_or_else(|e| panic!("write {}: {e}", out.display()));
}

/// Emit the checkout-open golden to `out`.
fn emit_checkout_open(out: &Path) {
    write_golden(out, &format!("{}\n", checkout_open_json()));
}

/// Emit the wire-layout JSON to `out`. Pretty-printed so a diff is reviewable. Returns the rendered
/// JSON so `main` can log a short summary.
fn emit_wire_layout(out: &Path) -> String {
    let layout = wire_layout();
    let json = serde_json::to_string_pretty(&layout).unwrap_or_else(|e| {
        panic!("wire-layout JSON serialization failed: {e}");
    });
    write_golden(out, &json);
    json
}

// ===========================================================================
// dfx candid args emitter (the original behavior).
// ===========================================================================

fn emit_dfx_args() {
    // --- demo accounts (deterministic; the phone's real key would come from generate_keypair) ---
    let payer = key(1);
    let merchant = key(2);
    let payer_pk: [u8; PUBKEY_LEN] = payer.verifying_key().to_bytes();
    let merchant_pk: [u8; PUBKEY_LEN] = merchant.verifying_key().to_bytes();

    // --- ledger opening state ---
    const BAL_A: u64 = 10_000; // payer opens with $100.00
    const BAL_B: u64 = 0; // merchant opens empty
    const CAP: u64 = 100_000; // $1,000.00 per-tx cap

    // --- the offline-signed payment: payer -> merchant, $25.00 ---
    const AMOUNT: u64 = 2_500;
    let nonce = [42u8; 16];
    const EXPIRY: u64 = 4_102_444_800; // 2100-01-01Z — far future so a wall-clock deploy never expires it

    let auth = Authorization { from: payer_pk, to: merchant_pk, amount: AMOUNT, nonce, expiry: EXPIRY, currency: DEMO_USD, from_name: [0u8; NAME_LEN], to_name: [0u8; NAME_LEN], memo: [0u8; MEMO_LEN] };
    let wire = SignedAuthorization::new(&payer, auth).to_wire();

    let out = Path::new("dfx/args");
    fs::create_dir_all(out).expect("mkdir dfx/args");

    // Facade InitArg: `demo_ledger` is the ONE environment-specific ledger (the DEMO/DUSD play
    // currency) — the mainnet DUSD ICRC-3 ledger, aka canister_ids.json's `icrc_ledger.ic`. Every
    // other asset the facade serves is a compile-time FIXED_ASSETS const; there is no runtime
    // registration. cap + open controller (the demo default; production arms the internal
    // controller cell post-deploy). On an UPGRADE this arg is type-checked against the .did but
    // ignored at runtime (no post_upgrade) — stable structures carry SPENT/ACCOUNT_TXNS/CAP across
    // by MemoryId. Candid matches record fields by name. scripts/dfx-deploy.sh (local replica) does
    // NOT use this file: a fresh replica's ledger id only exists at deploy time, so it substitutes
    // its own demo_ledger inline.
    const DEMO_LEDGER_MAINNET: &str = "td2nx-oaaaa-aaaab-qhdnq-cai";
    let init = format!(
        "(record {{ demo_ledger = principal \"{DEMO_LEDGER_MAINNET}\"; per_tx_cap = {CAP} : nat64; controller = null }})\n",
    );
    fs::write(out.join("init.arg"), init).unwrap();
    fs::write(out.join("pay.arg"), format!("({})\n", blob(&wire))).unwrap();
    // `balance_of : (blob, nat32) -> (nat64) query` — the second arg is the currency (DEMO_USD = 0).
    fs::write(out.join("payer.arg"), format!("({}, {DEMO_USD} : nat32)\n", blob(&payer_pk))).unwrap();
    fs::write(out.join("merchant.arg"), format!("({}, {DEMO_USD} : nat32)\n", blob(&merchant_pk))).unwrap();

    // Post-conditions the deploy script asserts against (avoids recomputing money in bash). CAP is
    // here too: scripts/dfx-deploy.sh builds its local init arg inline and takes the cap from this
    // single source instead of hardcoding it.
    let expect = format!(
        "AMOUNT={AMOUNT}\nCAP={CAP}\nPAYER_AFTER={}\nMERCHANT_AFTER={}\n",
        BAL_A - AMOUNT,
        BAL_B + AMOUNT,
    );
    fs::write(out.join("expect.env"), expect).unwrap();

    eprintln!("wrote dfx/args/{{init,pay,payer,merchant}}.arg (+ expect.env)");
    eprintln!("  payer    {}  ${}.{:02}", hex(&payer_pk), BAL_A / 100, BAL_A % 100);
    eprintln!("  merchant {}  ${}.{:02}", hex(&merchant_pk), BAL_B / 100, BAL_B % 100);
    eprintln!(
        "  payment  ${}.{:02}  nonce={}  wire={} bytes",
        AMOUNT / 100,
        AMOUNT % 100,
        hex(&nonce),
        wire.len()
    );
}

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("wire-layout") => {
            // Optional output path; default to `dfx/wire_layout.json` (idempotent overwrite).
            let out = args.next().map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::path::PathBuf::from("dfx/wire_layout.json"));
            emit_wire_layout(&out);
            // Re-read-independent summary: the golden bytes are derived above; log the key sizes so
            // a human running the emitter can eyeball that nothing is empty/truncated.
            let l = wire_layout();
            eprintln!(
                "wrote {} (signing={}B wire={}B request={}B sig={}B)",
                out.display(),
                l.signing_len,
                l.wire_len,
                l.request_len,
                l.sig_len
            );
            eprintln!(
                "  golden signing_hex={}… sig_hex={}…",
                &l.golden.signing_hex.get(..16).unwrap_or(&l.golden.signing_hex),
                &l.golden.sig_hex.get(..16).unwrap_or(&l.golden.sig_hex),
            );
        }
        Some("checkout-open") => {
            // Optional output path; default to `dfx/checkout_open_signing.json` (idempotent overwrite).
            let out = args
                .next()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::path::PathBuf::from("dfx/checkout_open_signing.json"));
            emit_checkout_open(&out);
            let d = checkout_open_doc();
            eprintln!(
                "wrote {} (domain={} fixed={}B skew=±{}s signing={}B)",
                out.display(),
                d.domain,
                d.fixed_len,
                d.max_skew_secs,
                d.golden.signing_hex.len() / 2,
            );
        }
        _ => emit_dfx_args(),
    }
}

// ===========================================================================
// Tests — guards against wire-layout drift.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use dpay_core::CodecError;

    /// Reconstruct the golden `Authorization` purely from the offsets/lengths/endian emitted in the
    /// JSON, then assert it matches the original and round-trips through the real codec. Catches any
    /// drift between this emitter's documented layout and `Authorization::signing_bytes()` /
    /// `SignedAuthorization::to_wire()` / `PaymentRequest::to_bytes()`.
    #[test]
    fn golden_layout_round_trips_through_real_codecs() {
        let layout = wire_layout();
        let g = &layout.golden;

        // The signing buffer the core actually produced.
        let signing = hex::decode(&g.signing_hex).expect("signing_hex decodes");
        assert_eq!(signing.len(), SIGNING_LEN, "signing_hex length matches SIGNING_LEN");

        // Re-slice the signing buffer at the EMITTED offsets/lengths to recover each field, applying
        // the documented endianness. If the emitted offsets disagree with signing_bytes(), this
        // reconstructs a different Authorization and the round-trip below fails.
        let from: [u8; PUBKEY_LEN] = signing[layout.fields.from.offset..][..PUBKEY_LEN]
            .try_into().unwrap();
        let to: [u8; PUBKEY_LEN] = signing[layout.fields.to.offset..][..PUBKEY_LEN]
            .try_into().unwrap();
        let amount = u64::from_le_bytes(
            signing[layout.fields.amount.offset..][..AMOUNT_LEN].try_into().unwrap(),
        );
        let nonce: [u8; NONCE_LEN] = signing[layout.fields.nonce.offset..][..NONCE_LEN]
            .try_into().unwrap();
        let expiry = u64::from_le_bytes(
            signing[layout.fields.expiry.offset..][..EXPIRY_LEN].try_into().unwrap(),
        );
        let currency = u32::from_le_bytes(
            signing[layout.fields.currency.offset..][..CURRENCY_LEN].try_into().unwrap(),
        );
        let from_name: [u8; NAME_LEN] = signing[layout.fields.from_name.offset..][..NAME_LEN]
            .try_into().unwrap();
        let to_name: [u8; NAME_LEN] = signing[layout.fields.to_name.offset..][..NAME_LEN]
            .try_into().unwrap();
        let memo: [u8; MEMO_LEN] = signing[layout.fields.memo.offset..][..MEMO_LEN]
            .try_into().unwrap();

        // The reconstructed auth matches the golden scalars.
        let pub_bytes = hex::decode(&g.public_hex).unwrap();
        let to_bytes = hex::decode(&g.to_hex).unwrap();
        let nonce_bytes = hex::decode(&g.nonce_hex).unwrap();
        let pub_arr: [u8; PUBKEY_LEN] = pub_bytes[..].try_into().unwrap();
        let to_arr: [u8; PUBKEY_LEN] = to_bytes[..].try_into().unwrap();
        let nonce_arr: [u8; NONCE_LEN] = nonce_bytes[..].try_into().unwrap();
        let from_name_bytes = hex::decode(&g.from_name_hex).unwrap();
        let to_name_bytes = hex::decode(&g.to_name_hex).unwrap();
        let memo_bytes = hex::decode(&g.memo_hex).unwrap();
        assert_eq!(from, pub_arr);
        assert_eq!(to, to_arr);
        assert_eq!(amount, g.amount);
        assert_eq!(nonce, nonce_arr);
        assert_eq!(expiry, g.expiry);
        assert_eq!(currency, g.currency);
        assert_eq!(from_name[..], from_name_bytes[..], "from_name matches golden hex");
        assert_eq!(to_name[..], to_name_bytes[..], "to_name matches golden hex");
        assert_eq!(memo[..], memo_bytes[..], "memo matches golden hex");

        // And re-serializing it reproduces the exact same signing buffer (proves the offsets are
        // faithful to `Authorization::signing_bytes()`).
        let auth = Authorization { from, to, amount, nonce, expiry, currency, from_name, to_name, memo };
        assert_eq!(auth.signing_bytes(), signing[..]);

        // The golden sig actually verifies over the reconstructed signing bytes under the golden
        // public key (proves the sig + pubkey + signing buffer are mutually consistent).
        let sig_bytes = hex::decode(&g.sig_hex).unwrap();
        assert_eq!(sig_bytes.len(), SIG_LEN, "sig_hex length matches SIG_LEN");
        let sa = SignedAuthorization {
            auth,
            sig: sig_bytes[..].try_into().unwrap(),
            from_pub: from,
        };
        assert!(sa.verify(), "golden signature must verify");

        // The wire bytes parse back to the same signed auth (proves wire_fields offsets are faithful
        // to `SignedAuthorization::from_wire()`).
        let wire_bytes = hex::decode(&g.wire_hex).unwrap();
        assert_eq!(wire_bytes.len(), WIRE_LEN, "wire_hex length matches WIRE_LEN");
        let from_wire: SignedAuthorization =
            SignedAuthorization::from_wire(&wire_bytes).expect("wire round-trips");
        assert_eq!(from_wire, sa);

        // The request bytes parse back to the expected PaymentRequest (proves request_len + the
        // request field layout are faithful to `PaymentRequest::from_bytes()`).
        let req_bytes = hex::decode(&g.request_hex).unwrap();
        assert_eq!(req_bytes.len(), REQUEST_LEN, "request_hex length matches REQUEST_LEN");
        let req: PaymentRequest =
            PaymentRequest::from_bytes(&req_bytes).map_err(|e: CodecError| e).unwrap();
        assert_eq!(req.to, to);
        assert_eq!(req.amount, amount);
        assert_eq!(req.nonce, nonce);
        assert_eq!(req.expiry, expiry);
        assert_eq!(req.currency, currency);
        // The merchant request's to_name + memo are carried at the request offsets and match the
        // request golden hexes (the request memo "coffee" differs from the pay memo "dinner").
        let req_to_name_bytes = hex::decode(&g.request_to_name_hex).unwrap();
        let req_memo_bytes = hex::decode(&g.request_memo_hex).unwrap();
        assert_eq!(req.to_name[..], req_to_name_bytes[..], "request to_name matches golden hex");
        assert_eq!(req.memo[..], req_memo_bytes[..], "request memo matches golden hex");
        // Re-slice the request buffer at the EMITTED request offsets to recover to_name/memo, proving
        // the request_fields offsets are faithful to `PaymentRequest::to_bytes()`.
        assert_eq!(
            req_bytes[layout.request_fields.to_name.offset..][..NAME_LEN],
            req_to_name_bytes[..],
            "request to_name offset is faithful",
        );
        assert_eq!(
            req_bytes[layout.request_fields.memo.offset..][..MEMO_LEN],
            req_memo_bytes[..],
            "request memo offset is faithful",
        );
        assert_eq!(layout.request_fields.to_name.offset, REQ_TO_NAME_OFF);
        assert_eq!(layout.request_fields.memo.offset, REQ_MEMO_OFF);

        // Wire-field offsets are internally consistent with the segment lengths.
        assert_eq!(layout.wire_fields.signing.offset, WIRE_SIGNING_OFF);
        assert_eq!(layout.wire_fields.sig.offset, WIRE_SIG_OFF);
        assert_eq!(layout.wire_fields.from_pub.offset, WIRE_FROM_PUB_OFF);
        assert_eq!(layout.wire_fields.signing.len + layout.wire_fields.sig.len + layout.wire_fields.from_pub.len, WIRE_LEN);

        // Pay (signing) name offsets are internally consistent with the field widths.
        assert_eq!(layout.fields.from_name.offset, FROM_NAME_OFF);
        assert_eq!(layout.fields.to_name.offset, TO_NAME_OFF);
        assert_eq!(layout.fields.memo.offset, MEMO_OFF);
        assert_eq!(layout.name_len, NAME_LEN);
        assert_eq!(layout.memo_len, MEMO_LEN);
    }

    /// The golden withdrawal signing bytes must round-trip through the EMITTED withdraw offsets, and
    /// the golden signature must verify under the golden key. Catches drift between this emitter's
    /// documented withdraw layout and `WithdrawAuth::signing_bytes()` (which the JS shim mirrors).
    #[test]
    fn golden_withdraw_layout_round_trips_through_real_signing_bytes() {
        let layout = wire_layout();
        let w = &layout.withdraw;
        let g = &w.golden;

        let signing = hex::decode(&g.signing_hex).expect("withdraw signing_hex decodes");
        // Length = fixed prefix + 4-byte addr len + the address bytes.
        let addr_bytes = g.destination.as_bytes();
        assert_eq!(
            signing.len(),
            w.fixed_len + w.addr_len_bytes + addr_bytes.len(),
            "withdraw signing_hex length = fixed prefix + addr_len bytes + address"
        );
        assert_eq!(w.fixed_len, W_FIXED_LEN);
        assert_eq!(w.addr_len_bytes, W_ADDR_LEN_BYTES);

        // Reconstruct the WithdrawAuth purely from the EMITTED offsets and assert it reproduces the
        // exact signing bytes (proves the offsets are faithful to WithdrawAuth::signing_bytes()).
        let from: [u8; PUBKEY_LEN] = signing[w.fields.from_pubkey.offset..][..PUBKEY_LEN].try_into().unwrap();
        let amount = u64::from_le_bytes(signing[w.fields.amount.offset..][..8].try_into().unwrap());
        let nonce: [u8; NONCE_LEN] = signing[w.fields.nonce.offset..][..NONCE_LEN].try_into().unwrap();
        let expiry = u64::from_le_bytes(signing[w.fields.expiry.offset..][..8].try_into().unwrap());
        let currency = u32::from_le_bytes(signing[w.fields.currency.offset..][..4].try_into().unwrap());
        let addr_len = u32::from_le_bytes(
            signing[w.fields.address_len.offset..][..W_ADDR_LEN_BYTES].try_into().unwrap(),
        ) as usize;
        let addr_start = w.fields.address_len.offset + W_ADDR_LEN_BYTES;
        let destination = std::str::from_utf8(&signing[addr_start..addr_start + addr_len])
            .unwrap()
            .to_string();

        assert_eq!(from, hex::decode(&g.public_hex).unwrap()[..]);
        assert_eq!(amount, g.amount);
        assert_eq!(nonce, hex::decode(&g.nonce_hex).unwrap()[..]);
        assert_eq!(expiry, g.expiry);
        assert_eq!(currency, g.currency);
        assert_eq!(destination, g.destination);

        let auth = WithdrawAuth { from_pubkey: from, destination: destination.clone(), amount, nonce, expiry, currency };
        assert_eq!(auth.signing_bytes(), signing[..], "emitted offsets must reproduce signing_bytes()");

        // The golden sig verifies over the reconstructed bytes under the golden key.
        let sig_bytes = hex::decode(&g.sig_hex).unwrap();
        assert_eq!(sig_bytes.len(), SIG_LEN);
        let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes[..].try_into().unwrap());
        assert!(auth.verify(&from, &sig), "golden withdraw signature must verify");
    }

    /// The golden receipt signing bytes must round-trip through the EMITTED receipt offsets, and the
    /// golden signature must verify under the golden receipt key. Catches drift between this emitter's
    /// documented receipt layout and `ReceiptClaim::signing_bytes()` (which the JS verify_receipt shim
    /// mirrors). The receipt layout is FIXED-length (108 bytes = `RECEIPT_CLAIM_LEN`).
    #[test]
    fn golden_receipt_layout_round_trips_through_real_signing_bytes() {
        let layout = wire_layout();
        let r = &layout.receipt;
        let g = &r.golden;

        let signing = hex::decode(&g.signing_hex).expect("receipt signing_hex decodes");
        assert_eq!(signing.len(), RECEIPT_CLAIM_LEN, "receipt signing_hex length == RECEIPT_CLAIM_LEN");
        assert_eq!(
            r.fixed_len, RECEIPT_CLAIM_LEN,
            "receipt.fixed_len == RECEIPT_CLAIM_LEN (single source of truth, imported from the core)"
        );

        // Reconstruct the ReceiptClaim purely from the EMITTED offsets and assert it reproduces the
        // exact signing bytes (proves the offsets are faithful to ReceiptClaim::signing_bytes()).
        let nonce: [u8; NONCE_LEN] = signing[r.fields.nonce.offset..][..NONCE_LEN].try_into().unwrap();
        let from: [u8; PUBKEY_LEN] = signing[r.fields.from.offset..][..PUBKEY_LEN].try_into().unwrap();
        let to: [u8; PUBKEY_LEN] = signing[r.fields.to.offset..][..PUBKEY_LEN].try_into().unwrap();
        let amount = u64::from_le_bytes(signing[r.fields.amount.offset..][..8].try_into().unwrap());
        let currency = u32::from_le_bytes(signing[r.fields.currency.offset..][..4].try_into().unwrap());
        let block_index =
            u64::from_le_bytes(signing[r.fields.block_index.offset..][..8].try_into().unwrap());
        let settle_ts =
            u64::from_le_bytes(signing[r.fields.settle_ts.offset..][..8].try_into().unwrap());

        assert_eq!(nonce, hex::decode(&g.nonce_hex).unwrap()[..]);
        assert_eq!(from, hex::decode(&g.from_hex).unwrap()[..]);
        assert_eq!(to, hex::decode(&g.to_hex).unwrap()[..]);
        assert_eq!(amount, g.amount);
        assert_eq!(currency, g.currency);
        assert_eq!(block_index, g.block_index);
        assert_eq!(settle_ts, g.settle_ts);

        let claim = ReceiptClaim { nonce, from, to, amount, currency, block_index, settle_ts };
        assert_eq!(claim.signing_bytes(), signing[..], "emitted offsets must reproduce signing_bytes()");

        // The golden sig verifies over the reconstructed bytes under the golden receipt public key
        // (proves sig + pubkey + signing buffer are mutually consistent — `verify_receipt` uses
        // `verify_strict`, matching the canister/app verify path).
        let sig_bytes = hex::decode(&g.sig_hex).unwrap();
        assert_eq!(sig_bytes.len(), SIG_LEN, "receipt sig_hex length == SIG_LEN");
        let public: [u8; PUBKEY_LEN] = hex::decode(&g.public_hex).unwrap()[..].try_into().unwrap();
        let sig_arr: [u8; SIG_LEN] = sig_bytes[..].try_into().unwrap();
        assert!(
            dpay_core::verify_receipt(&public, &claim, &sig_arr),
            "golden receipt signature must verify under verify_receipt"
        );
    }

    /// Path to the committed checkout-open golden, resolved from the crate rather than the cwd.
    const CHECKOUT_OPEN_GOLDEN: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../dfx/checkout_open_signing.json");

    /// The COMMITTED `dfx/checkout_open_signing.json` is byte-identical to what this emitter produces
    /// from today's core. This is the drift alarm: change `CheckoutOpen::signing_bytes`, the domain tag,
    /// or the skew window without regenerating (`just wire-layout`) and the checkout's proof silently
    /// stops matching the one the app signs — so it fails here instead.
    #[test]
    fn committed_checkout_open_golden_matches_the_core_this_build_links() {
        let committed = fs::read_to_string(CHECKOUT_OPEN_GOLDEN)
            .unwrap_or_else(|e| panic!("read {CHECKOUT_OPEN_GOLDEN}: {e} — run `just wire-layout`"));
        assert_eq!(
            committed,
            format!("{}\n", checkout_open_json()),
            "dfx/checkout_open_signing.json is stale — regenerate with `just wire-layout`"
        );
    }

    /// Rebuild the golden `CheckoutOpen` purely from the EMITTED offsets/lengths/endian, then assert the
    /// core reproduces the same signing buffer and that the golden signature validates. Catches drift
    /// between this document's documented layout and `CheckoutOpen::signing_bytes()` — the same guard the
    /// pay/withdraw/receipt goldens carry, and the reason `check-wasm-core.mjs` may trust the file.
    #[test]
    fn golden_checkout_open_layout_round_trips_through_real_signing_bytes() {
        let doc = checkout_open_doc();
        let g = &doc.golden;
        let signing = hex::decode(&g.signing_hex).expect("signing_hex decodes");
        assert_eq!(
            signing.len(),
            doc.fixed_len + doc.name_len_bytes + g.merchant_name.len()
                + doc.note_len_bytes + g.note.len(),
            "signing buffer = fixed prefix + 4-byte name length + the name's BYTES + 4-byte note length + the note's BYTES"
        );

        // The domain tag sits at its emitted offset — the placement that keeps a signature made for
        // any other dpay payload out of this verifier.
        assert_eq!(
            &signing[doc.fields.domain.offset..][..doc.fields.domain.len],
            hex::decode(&doc.domain_hex).expect("domain_hex decodes").as_slice()
        );

        // Re-slice every field at the EMITTED offsets; a disagreement rebuilds a different CheckoutOpen.
        let merchant_pubkey: [u8; PUBKEY_LEN] = signing[doc.fields.merchant_pubkey.offset..]
            [..PUBKEY_LEN]
            .try_into()
            .unwrap();
        let cents =
            u64::from_le_bytes(signing[doc.fields.cents.offset..][..8].try_into().unwrap());
        let nonce: [u8; NONCE_LEN] =
            signing[doc.fields.nonce.offset..][..NONCE_LEN].try_into().unwrap();
        let issued_at =
            u64::from_le_bytes(signing[doc.fields.issued_at.offset..][..8].try_into().unwrap());
        let name_len = u32::from_le_bytes(
            signing[doc.fields.name_len.offset..][..doc.fields.name_len.len].try_into().unwrap(),
        ) as usize;
        let name_off = doc.fields.name_len.offset + doc.fields.name_len.len;
        let merchant_name = String::from_utf8(signing[name_off..][..name_len].to_vec())
            .expect("the name field is UTF-8");
        let note_len = u32::from_le_bytes(
            signing[doc.fields.note_len.offset..][..doc.fields.note_len.len].try_into().unwrap(),
        ) as usize;
        let note_off = doc.fields.note_len.offset + doc.fields.note_len.len;
        let note = String::from_utf8(signing[note_off..][..note_len].to_vec())
            .expect("the note field is UTF-8");

        let rebuilt = CheckoutOpen {
            merchant_pubkey,
            cents,
            nonce,
            issued_at,
            merchant_name,
            note: Some(note),
        };
        assert_eq!(
            hex(&rebuilt.signing_bytes()),
            g.signing_hex,
            "the emitted offsets must describe CheckoutOpen::signing_bytes()"
        );
        assert_eq!(hex(&rebuilt.merchant_pubkey), g.merchant_pubkey_hex);
        assert_eq!(rebuilt.cents, g.cents);
        assert_eq!(rebuilt.issued_at, g.issued_at);
        assert_eq!(rebuilt.merchant_name, g.merchant_name);
        assert_eq!(rebuilt.note.as_deref(), Some(g.note.as_str()));

        // The legacy section is the SAME request without a note: the frozen v1 buffer, verifiable
        // by every already-deployed relay, and distinct from the v2 bytes.
        let legacy_signing = hex::decode(&doc.legacy_v1.signing_hex).expect("decodes");
        assert_eq!(
            &legacy_signing[..CHECKOUT_OPEN_DOMAIN.len()],
            CHECKOUT_OPEN_DOMAIN.as_slice()
        );
        assert_eq!(
            legacy_signing.len(),
            doc.legacy_v1.fixed_len + doc.name_len_bytes + g.merchant_name.len()
        );
        let legacy = CheckoutOpen { note: None, ..rebuilt.clone() };
        assert_eq!(hex(&legacy.signing_bytes()), doc.legacy_v1.signing_hex);
        let legacy_sig: [u8; SIG_LEN] =
            hex::decode(&doc.legacy_v1.sig_hex).expect("decodes").try_into().expect("64 bytes");
        assert_eq!(
            dpay_core::validate_checkout_open(&legacy, &legacy_sig, legacy.issued_at, false),
            Ok(())
        );
        assert_ne!(doc.legacy_v1.signing_hex, g.signing_hex, "v1 and v2 bytes differ at the tag");

        // The golden signature satisfies the acceptance rule the relay runs, at the golden instant.
        let sig: [u8; SIG_LEN] =
            hex::decode(&g.sig_hex).expect("sig_hex decodes").try_into().expect("64-byte signature");
        assert_eq!(dpay_core::validate_checkout_open(&rebuilt, &sig, rebuilt.issued_at, false), Ok(()));
        // …and is refused one second past the emitted window — the document's own skew number.
        assert_eq!(
            dpay_core::validate_checkout_open(
                &rebuilt,
                &sig,
                rebuilt.issued_at + doc.max_skew_secs + 1,
                false,
            ),
            Err(dpay_core::CheckoutOpenError::Stale)
        );
    }
}
