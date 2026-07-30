//! Emit deterministic dfx candid argument files for the real dfx-deploy smoke test.
//!
//! This never reimplements money logic: it builds a real [`SignedAuthorization`] with the shared
//! `dpay-core` and serialises it as candid text, so `dfx canister call pay` submits the *exact*
//! 196-byte wire the phone would sign. Deterministic seeds make the deploy reproducible run-to-run,
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
    Authorization, PaymentRequest, SignedAuthorization, WithdrawAuth, DEMO_USD, NONCE_LEN,
    PUBKEY_LEN, REQUEST_LEN, SIG_LEN, SIGNING_LEN, WIRE_LEN,
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

// ===========================================================================
// wire-layout emitter — single source of truth for the JS signing shim.
// ===========================================================================
//
// Every offset/length below is computed from the `dpay_core` consts by name (no hardcoded
// 100/196/68) so a layout change in the core propagates here. A unit test (`wire_layout_tests`)
// reconstructs the golden `Authorization` from these offsets and asserts it round-trips, guarding
// against drift between this emitter and `Authorization::signing_bytes()`.

/// Field offset within the 100-byte signing buffer, computed from the frozen layout in
/// `dpay_core::Authorization::signing_bytes` (`from | to | amount_le | nonce | expiry_le |
/// currency_le`). Expressed in terms of the core consts so a const rename surfaces here too.
const FROM_OFF: usize = 0;
const TO_OFF: usize = PUBKEY_LEN;
const AMOUNT_OFF: usize = 2 * PUBKEY_LEN;
const NONCE_OFF: usize = 2 * PUBKEY_LEN + 8;
const EXPIRY_OFF: usize = 2 * PUBKEY_LEN + 8 + NONCE_LEN;
const CURRENCY_OFF: usize = 2 * PUBKEY_LEN + 16 + NONCE_LEN;
const AMOUNT_LEN: usize = 8;
const EXPIRY_LEN: usize = 8;
const CURRENCY_LEN: usize = 4;

/// Offsets within the 196-byte wire form (`signing_bytes | sig | from_pub`).
const WIRE_SIGNING_OFF: usize = 0;
const WIRE_SIG_OFF: usize = SIGNING_LEN;
const WIRE_FROM_PUB_OFF: usize = SIGNING_LEN + SIG_LEN;

// ===========================================================================
// withdrawal-layout offsets — single source of truth for the JS signing shim.
// ===========================================================================
//
// `WithdrawAuth::signing_bytes` is variable-length (the btc_address is last), so it does NOT share
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
    btc_address: String,
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
}

/// The golden signed bytes. Every `*_hex` is derived from the real `dpay_core` types (never
/// hardcoded) so the JS cross-validation is a true Rust↔JS byte comparison.
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
}

#[derive(Serialize)]
struct WireLayout {
    signing_len: usize,
    wire_len: usize,
    request_len: usize,
    sig_len: usize,
    pubkey_len: usize,
    nonce_len: usize,
    fields: Fields,
    wire_fields: WireFields,
    golden: Golden,
    /// The withdrawal (ckBTC→BTC) signing layout + golden signed bytes. Variable-length (the
    /// btc_address is last), so it has its own section distinct from the fixed `fields`/`golden`.
    withdraw: WithdrawLayout,
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

    let auth = Authorization { from: public, to, amount: AMOUNT, nonce, expiry: EXPIRY, currency };
    // The signing buffer, signature, and full wire all come from the real core types.
    let signing = auth.signing_bytes();
    let sa = SignedAuthorization::new(&secret, auth);
    let sig = sa.sig;
    let wire = sa.to_wire();

    // The request bytes for the same to/amount/nonce/expiry/currency (the merchant's QR), also
    // from the real core type.
    let request = PaymentRequest { to, amount: AMOUNT, nonce, expiry: EXPIRY, currency }.to_bytes();

    WireLayout {
        signing_len: SIGNING_LEN,
        wire_len: WIRE_LEN,
        request_len: REQUEST_LEN,
        sig_len: SIG_LEN,
        pubkey_len: PUBKEY_LEN,
        nonce_len: NONCE_LEN,
        fields: Fields {
            from: FieldSpec { offset: FROM_OFF, len: PUBKEY_LEN, endian: None },
            to: FieldSpec { offset: TO_OFF, len: PUBKEY_LEN, endian: None },
            amount: FieldSpec { offset: AMOUNT_OFF, len: AMOUNT_LEN, endian: Some("le") },
            nonce: FieldSpec { offset: NONCE_OFF, len: NONCE_LEN, endian: None },
            expiry: FieldSpec { offset: EXPIRY_OFF, len: EXPIRY_LEN, endian: Some("le") },
            currency: FieldSpec { offset: CURRENCY_OFF, len: CURRENCY_LEN, endian: Some("le") },
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
        },
        withdraw: withdraw_layout(),
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
    let btc_address = "bc1qdpaygoldenwithdrawaladdress".to_string();
    const W_AMOUNT: u64 = 50_000; // exactly retrieve_btc_min_amount
    let w_nonce = [42u8; NONCE_LEN];
    const W_EXPIRY: u64 = 4_102_444_800;
    let w_currency = DEMO_USD;

    let auth = WithdrawAuth {
        from_pubkey: public,
        btc_address: btc_address.clone(),
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
            btc_address,
            amount: W_AMOUNT,
            nonce_hex: hex(&w_nonce),
            expiry: W_EXPIRY,
            currency: w_currency,
            signing_hex: hex(&signing),
            sig_hex: hex(&sig),
        },
    }
}

/// Emit the wire-layout JSON to `out` (idempotent: overwrites). Pretty-printed so a diff is
/// reviewable. Returns the rendered JSON so `main` can log a short summary.
fn emit_wire_layout(out: &Path) -> String {
    let layout = wire_layout();
    let json = serde_json::to_string_pretty(&layout).unwrap_or_else(|e| {
        panic!("wire-layout JSON serialization failed: {e}");
    });
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .unwrap_or_else(|e| panic!("mkdir {}: {e}", parent.display()));
        }
    }
    fs::write(out, &json)
        .unwrap_or_else(|e| panic!("write {}: {e}", out.display()));
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

    let auth = Authorization { from: payer_pk, to: merchant_pk, amount: AMOUNT, nonce, expiry: EXPIRY, currency: DEMO_USD };
    let wire = SignedAuthorization::new(&payer, auth).to_wire();

    let out = Path::new("dfx/args");
    fs::create_dir_all(out).expect("mkdir dfx/args");

    // Facade InitArg: no ledgers registered at init (the operator registers each ledger at runtime
    // via `register_ledger`, since a ledger id is only known after it is created). cap + open
    // controller (the demo default; production sets a governed controller). On an UPGRADE this arg is
    // type-checked against the .did but ignored at runtime (no post_upgrade) — stable structures
    // carry SPENT/ACCOUNT_TXNS/CAP across by MemoryId. Candid matches record fields by name.
    let init = format!(
        "(record {{ ledgers = vec {{}}; per_tx_cap = {CAP} : nat64; controller = null }})\n",
    );
    fs::write(out.join("init.arg"), init).unwrap();
    fs::write(out.join("pay.arg"), format!("({})\n", blob(&wire))).unwrap();
    // `balance_of : (blob, nat32) -> (nat64) query` — the second arg is the currency (DEMO_USD = 0).
    fs::write(out.join("payer.arg"), format!("({}, {DEMO_USD} : nat32)\n", blob(&payer_pk))).unwrap();
    fs::write(out.join("merchant.arg"), format!("({}, {DEMO_USD} : nat32)\n", blob(&merchant_pk))).unwrap();

    // Post-conditions the deploy script asserts against (avoids recomputing money in bash).
    let expect = format!(
        "AMOUNT={AMOUNT}\nPAYER_AFTER={}\nMERCHANT_AFTER={}\n",
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

        // The reconstructed auth matches the golden scalars.
        let pub_bytes = hex::decode(&g.public_hex).unwrap();
        let to_bytes = hex::decode(&g.to_hex).unwrap();
        let nonce_bytes = hex::decode(&g.nonce_hex).unwrap();
        let pub_arr: [u8; PUBKEY_LEN] = pub_bytes[..].try_into().unwrap();
        let to_arr: [u8; PUBKEY_LEN] = to_bytes[..].try_into().unwrap();
        let nonce_arr: [u8; NONCE_LEN] = nonce_bytes[..].try_into().unwrap();
        assert_eq!(from, pub_arr);
        assert_eq!(to, to_arr);
        assert_eq!(amount, g.amount);
        assert_eq!(nonce, nonce_arr);
        assert_eq!(expiry, g.expiry);
        assert_eq!(currency, g.currency);

        // And re-serializing it reproduces the exact same signing buffer (proves the offsets are
        // faithful to `Authorization::signing_bytes()`).
        let auth = Authorization { from, to, amount, nonce, expiry, currency };
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

        // Wire-field offsets are internally consistent with the segment lengths.
        assert_eq!(layout.wire_fields.signing.offset, WIRE_SIGNING_OFF);
        assert_eq!(layout.wire_fields.sig.offset, WIRE_SIG_OFF);
        assert_eq!(layout.wire_fields.from_pub.offset, WIRE_FROM_PUB_OFF);
        assert_eq!(layout.wire_fields.signing.len + layout.wire_fields.sig.len + layout.wire_fields.from_pub.len, WIRE_LEN);
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
        let addr_bytes = g.btc_address.as_bytes();
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
        let btc_address = std::str::from_utf8(&signing[addr_start..addr_start + addr_len])
            .unwrap()
            .to_string();

        assert_eq!(from, hex::decode(&g.public_hex).unwrap()[..]);
        assert_eq!(amount, g.amount);
        assert_eq!(nonce, hex::decode(&g.nonce_hex).unwrap()[..]);
        assert_eq!(expiry, g.expiry);
        assert_eq!(currency, g.currency);
        assert_eq!(btc_address, g.btc_address);

        let auth = WithdrawAuth { from_pubkey: from, btc_address: btc_address.clone(), amount, nonce, expiry, currency };
        assert_eq!(auth.signing_bytes(), signing[..], "emitted offsets must reproduce signing_bytes()");

        // The golden sig verifies over the reconstructed bytes under the golden key.
        let sig_bytes = hex::decode(&g.sig_hex).unwrap();
        assert_eq!(sig_bytes.len(), SIG_LEN);
        let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes[..].try_into().unwrap());
        assert!(auth.verify(&from, &sig), "golden withdraw signature must verify");
    }
}
