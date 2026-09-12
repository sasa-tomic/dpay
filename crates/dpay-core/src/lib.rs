//! dpay-core — pure money/protocol logic shared by the canister, relay, phone app, and tests.
//!
//! Compiles natively and to `wasm32-unknown-unknown`. Keypair generation (the only part that
//! needs an OS CSPRNG) is behind the optional `rng` feature, which is **off by default** and
//! never enabled on the canister/wasm build — so `getrandom` never enters the wasm tree.
//!
//! Time convention: `expiry` and the `now` passed to [`validate`] are **unix seconds**.
//! The nonce is the merchant-issued `request_id` (see the two-scan flow): it binds a signature
//! to one specific sale and is the ledger's single-use idempotency key.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

/// NFC (ISO 7816-4 / ISO-DEP) transport framing — an alternative carrier for the *same* bytes the
/// QR path moves (the request and the signed wire). Pure, panic-free, and headless-testable; the
/// Android HCE service / reader are thin loops over [`nfc::CardSession`] / [`nfc::ReaderConductor`].
pub mod nfc;

pub const PUBKEY_LEN: usize = 32;
pub const SIG_LEN: usize = 64;
pub const NONCE_LEN: usize = 16;
/// Fixed width of each display-name / memo field: UTF-8, trailing-NUL (0x00) padded, truncated to
/// 32 bytes by the BUILDER (the app). The core just stores / signs / verifies the raw 32 bytes — it
/// does no encoding or trimming. Single-sourced here so every layer agrees on the field width.
pub const NAME_LEN: usize = 32;
pub const MEMO_LEN: usize = 32;
/// `from(32) | to(32) | amount_le(8) | nonce(16) | expiry_le(8) | currency_le(4) |
/// from_name(32) | to_name(32) | memo(32)` = 196 bytes. FROZEN layout — single-sourced here; the
/// canister, relay, app, and the JS shim all read this exact order.
pub const SIGNING_LEN: usize =
    PUBKEY_LEN + PUBKEY_LEN + 8 + NONCE_LEN + 8 + 4 + NAME_LEN + NAME_LEN + MEMO_LEN;
/// signing_bytes(196) + sig(64) + from_pub(32) = 292.
pub const WIRE_LEN: usize = SIGNING_LEN + SIG_LEN + PUBKEY_LEN;

/// Currency tag. The merchant's request names the settlement asset; the payer copies it
/// into their authorization. `DEMO_USD` is play money mintable via the faucet (open on
/// mainnet for the demo). Future currencies (ckUSDC, ckBTC, …) get their own tag.
pub type Currency = u32;
pub const DEMO_USD: Currency = 0;

/// An offline-built payment authorization. Amounts are integer minor units (cents); the UI
/// only ever renders `$`. `from_name`/`to_name`/`memo` are raw 32-byte buffers (UTF-8,
/// trailing-NUL padded, truncated to 32 bytes by the builder) that ride inside the signed bytes so
/// transaction history is self-describing on both sides (the payee sees the payer's name, not a raw
/// pubkey).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Authorization {
    pub from: [u8; PUBKEY_LEN],
    pub to: [u8; PUBKEY_LEN],
    pub amount: u64,
    pub nonce: [u8; NONCE_LEN],
    pub expiry: u64,
    pub currency: Currency,
    /// The payer's own display name (bound by the signature).
    pub from_name: [u8; NAME_LEN],
    /// The payee's display name (was the unauthenticated `|name` QR suffix; now signed).
    pub to_name: [u8; NAME_LEN],
    /// An optional merchant-set memo (bound by the signature).
    pub memo: [u8; MEMO_LEN],
}

impl Authorization {
    /// Canonical, deterministic signed message: fixed 196-byte little-endian concat. Field order is
    /// frozen forever:
    /// `from | to | amount_le | nonce | expiry_le | currency_le | from_name | to_name | memo`.
    /// The first six fields are little-endian integers / raw byte arrays as before; the three new
    /// 32-byte fields are raw copies (the app NUL-pads/truncates them before signing).
    pub fn signing_bytes(&self) -> [u8; SIGNING_LEN] {
        let mut b = [0u8; SIGNING_LEN];
        b[0..32].copy_from_slice(&self.from);
        b[32..64].copy_from_slice(&self.to);
        b[64..72].copy_from_slice(&self.amount.to_le_bytes());
        b[72..88].copy_from_slice(&self.nonce);
        b[88..96].copy_from_slice(&self.expiry.to_le_bytes());
        b[96..100].copy_from_slice(&self.currency.to_le_bytes());
        b[100..132].copy_from_slice(&self.from_name);
        b[132..164].copy_from_slice(&self.to_name);
        b[164..196].copy_from_slice(&self.memo);
        b
    }
}

/// Sign an authorization (works offline; deterministic, no RNG).
pub fn sign(key: &SigningKey, auth: &Authorization) -> Signature {
    key.sign(&auth.signing_bytes())
}

/// Verify `sig` over `auth` under raw 32-byte public key `from_pub`. `false` on any bad input.
/// Uses `verify_strict` (rejects weak / small-order keys).
pub fn verify(from_pub: &[u8; PUBKEY_LEN], auth: &Authorization, sig: &Signature) -> bool {
    match VerifyingKey::from_bytes(from_pub) {
        Ok(vk) => vk.verify_strict(&auth.signing_bytes(), sig).is_ok(),
        Err(_) => false,
    }
}

// --- canister-signed receipt (outcome attestation) --------------------------------------------
// The payer's `Authorization` signature binds the TERMS (from/to/amount/nonce/currency). The
// receipt signature binds the OUTCOME: the canister attests that this authorization settled on its
// ledger at `block_index` at `settle_ts`. A merchant/relay cannot forge it (only the canister holds
// the receipt Ed25519 secret), so the payer's "Paid ✓" rests on a canister-authenticated outcome,
// not merchant/relay honesty. See CODEBASE_ANALYSIS risk 3.

/// A canister-signed attestation of a SETTLED payment's outcome.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ReceiptClaim {
    pub nonce: [u8; NONCE_LEN],
    pub from: [u8; PUBKEY_LEN],
    pub to: [u8; PUBKEY_LEN],
    pub amount: u64,
    pub currency: Currency,
    /// The ICRC ledger block index where the transfer landed (outcome proof).
    pub block_index: u64,
    /// Unix seconds the canister recorded the settle.
    pub settle_ts: u64,
}

/// Canonical receipt signing length: `nonce(16) | from(32) | to(32) | amount_le(8) | currency_le(4)
/// | block_index_le(8) | settle_ts_le(8)` = 108 bytes. FROZEN layout — single-sourced here; the
/// canister and the relay's FakeLedger both call [`ReceiptClaim::signing_bytes`], and the app
/// mirrors this exact layout (the `receipt` section of `dfx/wire_layout.json`).
pub const RECEIPT_CLAIM_LEN: usize = NONCE_LEN + PUBKEY_LEN + PUBKEY_LEN + 8 + 4 + 8 + 8;

impl ReceiptClaim {
    /// Canonical, deterministic 108-byte little-endian encoding of the outcome claim.
    /// Field order is frozen: `nonce | from | to | amount_le | currency_le | block_index_le |
    /// settle_ts_le`.
    pub fn signing_bytes(&self) -> [u8; RECEIPT_CLAIM_LEN] {
        let mut b = [0u8; RECEIPT_CLAIM_LEN];
        let mut o = 0;
        b[o..o + NONCE_LEN].copy_from_slice(&self.nonce);
        o += NONCE_LEN;
        b[o..o + PUBKEY_LEN].copy_from_slice(&self.from);
        o += PUBKEY_LEN;
        b[o..o + PUBKEY_LEN].copy_from_slice(&self.to);
        o += PUBKEY_LEN;
        b[o..o + 8].copy_from_slice(&self.amount.to_le_bytes());
        o += 8;
        b[o..o + 4].copy_from_slice(&self.currency.to_le_bytes());
        o += 4;
        b[o..o + 8].copy_from_slice(&self.block_index.to_le_bytes());
        o += 8;
        b[o..o + 8].copy_from_slice(&self.settle_ts.to_le_bytes());
        b
    }
}

/// Sign a receipt claim with a canister receipt `SigningKey` (the canister holds the secret half;
/// the FakeLedger test boundary holds a stable test key). Returns the raw 64-byte signature.
pub fn sign_receipt(key: &SigningKey, claim: &ReceiptClaim) -> Signature {
    key.sign(&claim.signing_bytes())
}

/// Verify a canister receipt `sig` (raw 64 bytes) over `claim` under the canister's 32-byte receipt
/// public key. `false` on any bad input (bad key/sig shape, or signature mismatch). Uses
/// `verify_strict` (rejects weak / small-order keys), matching `verify`.
pub fn verify_receipt(pubkey: &[u8; PUBKEY_LEN], claim: &ReceiptClaim, sig: &[u8; SIG_LEN]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(pubkey) else { return false };
    let Ok(s) = Signature::from_slice(sig) else { return false };
    vk.verify_strict(&claim.signing_bytes(), &s).is_ok()
}

// --- withdrawal authorization (ckBTC → native BTC out) ----------------------------------------
// The mirror of [`Authorization`] for the WITHDRAWAL direction: the user authorizes the facade to
// move a ck currency OUT of their subaccount to a native BTC address. Same non-custodial discipline
// as `pay` — the facade moves NOTHING without a verified user Ed25519 signature over these exact
// bytes. The signature binds destination address + amount + nonce + expiry + currency, so a replay
// is impossible (the nonce is single-use, tracked in the facade's `WITHDRAW_NONCES`) and the
// destination/amount can't be swapped after signing. `from_pubkey` is both the verify key AND the
// ICRC `subaccount` the ckBTC is debited from (the facade owns `Account{owner: facade,
// subaccount: from_pubkey}`), so a signature under any other key moves no funds.

/// A user-signed authorization to withdraw `amount` of `currency` (a ck currency) to `destination`.
/// `amount` is integer satoshis (the ckBTC ledger's native unit); `expiry`/`now` are unix seconds.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WithdrawAuth {
    /// The signer's Ed25519 public key — also the ICRC subaccount the ckBTC is debited from.
    pub from_pubkey: [u8; PUBKEY_LEN],
    /// The native destination address (e.g. a BTC `bc1q…`). Bound by the signature.
    pub destination: String,
    /// Satoshis to withdraw.
    pub amount: u64,
    /// Single-use idempotency key (the facade tracks these per-withdraw in `WITHDRAW_NONCES`).
    pub nonce: [u8; NONCE_LEN],
    /// Unix seconds after which the authorization is stale.
    pub expiry: u64,
    /// Which ck currency to withdraw (resolves to a ledger + minter on the facade).
    pub currency: Currency,
}

/// Fixed-width prefix of a withdrawal signing buffer: `from_pubkey(32) | amount_le(8) |
/// nonce(16) | expiry_le(8) | currency_le(4)` = 68 bytes. The variable-length `destination`
/// follows as a u32-LE length prefix + the raw UTF-8 bytes, so the layout is unambiguous to decode
/// without a frozen total length. All widths reference the core consts by name.
pub(crate) const WITHDRAW_FIXED_LEN: usize = PUBKEY_LEN + 8 + NONCE_LEN + 8 + 4;
/// Width of the address length prefix (u32 LE) appended after the fixed prefix.
pub(crate) const WITHDRAW_ADDR_LEN_BYTES: usize = 4;

impl WithdrawAuth {
    /// Canonical, deterministic signing message. FROZEN field order:
    /// `from_pubkey | amount_le | nonce | expiry_le | currency_le | addr_len_le(4) | addr_utf8`.
    /// Fixed-width fields are placed first (stable offsets, mirroring [`Authorization`] and
    /// [`ReceiptClaim`]); the variable-length `destination` is last, prefixed by its u32 LE byte
    /// length so decoding is unambiguous. Returns a `Vec` (the address is variable length, so unlike
    /// `Authorization::signing_bytes` there is no single fixed-size array).
    pub fn signing_bytes(&self) -> Vec<u8> {
        let addr = self.destination.as_bytes();
        let mut b = Vec::with_capacity(WITHDRAW_FIXED_LEN + WITHDRAW_ADDR_LEN_BYTES + addr.len());
        b.extend_from_slice(&self.from_pubkey);
        b.extend_from_slice(&self.amount.to_le_bytes());
        b.extend_from_slice(&self.nonce);
        b.extend_from_slice(&self.expiry.to_le_bytes());
        b.extend_from_slice(&self.currency.to_le_bytes());
        // Length-prefix the address (u32 LE) so the layout is self-delimiting; bounds the address at
        // 4 GiB (a BTC address is ≤90 chars), far beyond any real input.
        let len = u32::try_from(addr.len()).expect("destination length fits u32");
        b.extend_from_slice(&len.to_le_bytes());
        b.extend_from_slice(addr);
        b
    }

    /// Verify a withdrawal `sig` under `from_pubkey` over this authorization. `false` on any bad
    /// input (weak/small-order key, or signature mismatch). Uses `verify_strict`, matching [`verify`]
    /// and [`verify_receipt`].
    pub fn verify(&self, from_pubkey: &[u8; PUBKEY_LEN], sig: &Signature) -> bool {
        if from_pubkey != &self.from_pubkey {
            return false;
        }
        match VerifyingKey::from_bytes(from_pubkey) {
            Ok(vk) => vk.verify_strict(&self.signing_bytes(), sig).is_ok(),
            Err(_) => false,
        }
    }
}

/// Sign a withdrawal authorization (works offline; deterministic, no RNG). Single source of truth
/// for the signing input — the app calls this via the FFI, the canister/relay rebuild the same
/// `signing_bytes()` to verify.
pub fn sign_withdraw(key: &SigningKey, auth: &WithdrawAuth) -> Signature {
    key.sign(&auth.signing_bytes())
}

// --- till-open authorization (a merchant proves the account they name is their own) ------------
//
// dpay's OpenCryptoPay till (`crates/dpay-relay/src/till.rs`) takes a 32-byte Ed25519 public key and
// DERIVES the account every payer is then instructed to send money to. Without a signature that
// derivation is an assertion, not a proof: anyone who can reach `POST /api/v1/till` can ring up a
// charge naming a key they do not hold — which is what a probe did on 2026-09-03 with
// `deadbeef…deadbeef`, opening a live production charge for a key nobody owns. This is the proof:
// the merchant signs the ring-up with the very key whose account will receive the money, so a
// charge exists only if someone who can SPEND from that account asked for one.
//
// WHAT IS SIGNED, AND WHY EACH FIELD EARNS ITS PLACE
//   * `merchant_pubkey` — the claim itself, and also the verify key. There is deliberately no
//     separate "who signed" input: [`validate_till_open`] checks the signature under the key the
//     payload NAMES, so a signature by any other key cannot open a charge for this one, and a caller
//     cannot accidentally verify against a key other than the one that will be paid.
//   * `cents` — the price. Left unsigned, a captured request could be re-opened at another amount
//     against the same merchant, and their own till would show a sale they never rang up.
//   * `merchant_name` — CLAIMED, and shown to every paying wallet as `displayName`. Signing the
//     WHOLE request rather than most of it is the point: an unsigned field inside a signed request
//     is a field the relay cannot attribute to anybody, and this is the one a payer reads.
//   * `nonce` — makes the signature single-use. The verifier records it on success and refuses a
//     repeat, so a replayed byte-identical request opens nothing.
//   * `issued_at` — the reason the seen-nonce set is FINITE, and why the shape carries a fourth
//     field beyond `{pubkey, cents, nonce}`. Without a time, "have I seen this nonce?" must be
//     answered against every nonce ever seen, forever; bound that set by memory instead and an
//     evicted nonce silently becomes replayable. With the ±[`TILL_OPEN_MAX_SKEW_SECS`] window the
//     verifier only has to remember the nonces inside that window, and "this cannot be replayed"
//     becomes an argument rather than a hope. An `issued_at` is used instead of the `expiry` the
//     payment types carry because the signer here has no interest in bounding validity — the
//     VERIFIER does; a signer-chosen expiry would have to be re-bounded by the verifier anyway
//     (`expiry <= now + window`), which is the same check with an extra way to get it wrong.
//
// DOMAIN SEPARATION. This same device key also signs payment authorizations ([`Authorization`]),
// withdrawals ([`WithdrawAuth`]), NFC settlement results (`nfc::NfcResult`) and IC ingress envelopes
// (`dpay-icp`). The signing buffer therefore OPENS with [`TILL_OPEN_DOMAIN`], so every buffer
// verified here begins with those exact bytes, and a signature made elsewhere cannot land here:
//   * `Authorization` / `WithdrawAuth` buffers begin with a 32-byte Ed25519 public key — colliding
//     would need the signer's own key to start with the ASCII tag (136 bits of grinding, over a
//     value the attacker does not choose);
//   * `nfc::NfcResult` begins with `dpay-nfc-result-v2` — a different tag, diverging at byte 5;
//   * an IC ingress envelope signs `\x0Aic-request ‖ request_id` — byte 0 is 0x0A, not `d`.
// The reverse direction is closed by the same fact: a till-open buffer starts with the tag, so
// reading it as an `Authorization` would put the tag where `from` belongs and the signature (made by
// the merchant's real key) does not verify under that. The version rides IN the tag rather than in a
// separate version byte — one statement of "which format is this", not two that can disagree. A
// request carrying a `note` (the sale's purpose, v2) signs under `dpay-till-open-v2`; a note-less
// request signs under `dpay-till-open-v1`. Two tags, not one tag plus an optional field, so the
// two encodings cannot be confused for each other by any verifier that reads the tag it verifies.

/// Domain-separation tag, and the first bytes of every note-less (v1) till-open signing buffer.
/// FROZEN: changing it invalidates every signature ever made, which is exactly what a version bump
/// should mean. Requests carrying a `note` sign under [`TILL_OPEN_DOMAIN_V2`] instead — the version
/// rides in the tag, so a v1 signature can never be re-read as v2 bytes or the other way round.
pub const TILL_OPEN_DOMAIN: &[u8; 17] = b"dpay-till-open-v1";

/// Domain-separation tag for till-open requests that carry a `note` (the sale's purpose, shown to
/// the payer on review). A SEPARATE tag rather than an appended field under the old one: the tag is
/// the one statement of "which format is this", and a v1 verifier (a relay not yet upgraded) must
/// refuse v2 bytes as a bad signature rather than accept them as a different spelling of the same
/// request — which is exactly what a different tag makes it do.
pub const TILL_OPEN_DOMAIN_V2: &[u8; 17] = b"dpay-till-open-v2";

/// How far a merchant's `issued_at` may sit from the verifier's clock, in EITHER direction.
///
/// Two minutes: the signer is by definition online (it is POSTing to the relay), so its clock is
/// network-synced, while the window still survives a phone that never corrected its clock over a
/// short flight. It is the ONE number that bounds replay: a verifier that refuses outside this
/// window only has to remember accepted nonces for `2 × TILL_OPEN_MAX_SKEW_SECS`.
pub const TILL_OPEN_MAX_SKEW_SECS: u64 = 120;

/// Fixed-width prefix of a note-less (v1) till-open signing buffer:
/// `domain(17) | merchant_pubkey(32) | cents_le(8) | nonce(16) | issued_at_le(8)` = 81 bytes. The
/// variable-length `merchant_name` follows, prefixed by its own u32-LE byte length.
pub const TILL_OPEN_FIXED_LEN: usize =
    TILL_OPEN_DOMAIN.len() + PUBKEY_LEN + 8 + NONCE_LEN + 8;
/// Fixed-width prefix of a v2 (note-bearing) till-open signing buffer — same fields, one byte
/// longer, because the v2 domain tag is.
pub const TILL_OPEN_FIXED_LEN_V2: usize =
    TILL_OPEN_DOMAIN_V2.len() + PUBKEY_LEN + 8 + NONCE_LEN + 8;
/// Width of the merchant-name length prefix (u32 LE) appended after the fixed prefix.
pub const TILL_OPEN_NAME_LEN_BYTES: usize = 4;
/// Width of the note length prefix (u32 LE), appended after the name in v2 buffers only.
pub const TILL_OPEN_NOTE_LEN_BYTES: usize = 4;

/// A merchant's authenticated request to ring up one charge on dpay's own OpenCryptoPay till.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TillOpen {
    /// The merchant's Ed25519 public key — the account the charge will be paid to is derived from
    /// it, and it is also the key this request's signature must verify under.
    pub merchant_pubkey: [u8; PUBKEY_LEN],
    /// The price in CHF cents (the till's own unit).
    pub cents: u64,
    /// Single-use idempotency key: the verifier records it on acceptance and refuses a repeat.
    pub nonce: [u8; NONCE_LEN],
    /// Unix seconds the merchant device built this request. Bounded by [`TILL_OPEN_MAX_SKEW_SECS`].
    pub issued_at: u64,
    /// What the merchant calls themselves — CLAIMED, shown to payers, and bound by the signature.
    pub merchant_name: String,
    /// What the charge is FOR — "2× Kafi", table 4 — CLAIMED like the name, shown to the payer on
    /// review, and bound by the signature for the same reason: an unsigned field inside a signed
    /// request is a field the relay cannot attribute to anybody. `None` signs the v1 buffer (the
    /// frozen encoding every deployed relay already verifies); `Some` signs the v2 buffer under
    /// [`TILL_OPEN_DOMAIN_V2`]. `Some("")` is a v2 buffer with an empty note, NOT a v1 buffer —
    /// the presence of the field is itself information the tag states.
    pub note: Option<String>,
}

impl TillOpen {
    /// Canonical, deterministic signing message. Which buffer a request signs is stated by its own
    /// first bytes — the version rides IN the tag:
    ///
    /// * `note: None` (v1, FROZEN field order):
    ///   `dpay-till-open-v1 | merchant_pubkey | cents_le | nonce | issued_at_le | name_len_le(4) |
    ///   name_utf8`
    /// * `note: Some` (v2):
    ///   `dpay-till-open-v2 | merchant_pubkey | cents_le | nonce | issued_at_le | name_len_le(4) |
    ///   name_utf8 | note_len_le(4) | note_utf8`
    ///
    /// The domain tag is FIRST (see the module note above — that placement is what makes a signature
    /// from any other dpay payload unusable here). Both strings are LAST and length-prefixed, so the
    /// encoding is self-delimiting and unambiguous: no two different `{cents, nonce, issued_at,
    /// name, note}` tuples can produce the same bytes.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let name = self.merchant_name.as_bytes();
        match self.note.as_deref() {
            // v1: the frozen buffer, byte for byte, so an upgraded relay still verifies the ring-ups
            // of every already-deployed signer (and the frozen `w_till_open_sig` wasm export keeps
            // its documented semantics).
            None => {
                let mut b = Vec::with_capacity(
                    TILL_OPEN_FIXED_LEN + TILL_OPEN_NAME_LEN_BYTES + name.len(),
                );
                b.extend_from_slice(TILL_OPEN_DOMAIN);
                b.extend_from_slice(&self.merchant_pubkey);
                b.extend_from_slice(&self.cents.to_le_bytes());
                b.extend_from_slice(&self.nonce);
                b.extend_from_slice(&self.issued_at.to_le_bytes());
                let len = u32::try_from(name.len()).expect("merchant name length fits u32");
                b.extend_from_slice(&len.to_le_bytes());
                b.extend_from_slice(name);
                b
            }
            // v2: the note rides its own tag and its own length prefix, after the name.
            Some(note) => {
                let note = note.as_bytes();
                let mut b = Vec::with_capacity(
                    TILL_OPEN_FIXED_LEN_V2
                        + TILL_OPEN_NAME_LEN_BYTES
                        + name.len()
                        + TILL_OPEN_NOTE_LEN_BYTES
                        + note.len(),
                );
                b.extend_from_slice(TILL_OPEN_DOMAIN_V2);
                b.extend_from_slice(&self.merchant_pubkey);
                b.extend_from_slice(&self.cents.to_le_bytes());
                b.extend_from_slice(&self.nonce);
                b.extend_from_slice(&self.issued_at.to_le_bytes());
                let len = u32::try_from(name.len()).expect("merchant name length fits u32");
                b.extend_from_slice(&len.to_le_bytes());
                b.extend_from_slice(name);
                let len = u32::try_from(note.len()).expect("note length fits u32");
                b.extend_from_slice(&len.to_le_bytes());
                b.extend_from_slice(note);
                b
            }
        }
    }
}

/// Why a till-open request was refused. Typed so the caller can tell the merchant what to DO —
/// re-sync the clock, fix the key, re-sign, or stop retrying a request that already opened a charge.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TillOpenError {
    /// `issued_at` is further than [`TILL_OPEN_MAX_SKEW_SECS`] from the verifier's clock, in either
    /// direction. Either the request is a replay of an old capture, or the device clock is wrong.
    Stale,
    /// `merchant_pubkey` does not decode as an Ed25519 point at all, so no signature could ever
    /// verify under it and nobody can prove they hold it. Its own diagnosis because it is what a
    /// pasted-garbage key looks like — `deadbeef…deadbeef`, the 2026-09-03 probe, lands here.
    MalformedKey,
    /// The signature does not verify under the payload's own `merchant_pubkey` — the caller does not
    /// hold the key they are claiming, a field was altered after signing, or the key is weak /
    /// small-order (`verify_strict` refuses those even though they decode).
    BadSignature,
    /// This `nonce` was already accepted inside the live window. The charge it opened exists; a
    /// retry must reuse that charge, not sign the same nonce again.
    NonceReused,
}

/// Sign a till-open request (deterministic, no RNG). Single source of truth for the signing input —
/// the merchant's app calls this through the FFI / wasm export, the relay rebuilds the same
/// `signing_bytes()` to verify.
pub fn sign_till_open(key: &SigningKey, open: &TillOpen) -> Signature {
    key.sign(&open.signing_bytes())
}

/// The WHOLE acceptance rule for a till-open request, in one place so the signer and the verifier
/// cannot hold two versions of it. Pure: `now_secs` and `nonce_already_seen` are supplied by the
/// caller (mirroring [`validate`], which takes `balance`/`nonce_already_seen` the same way), so this
/// stays allocation-light and has no clock or storage of its own.
///
/// Order is deliberate. The clock window is an integer comparison and is checked FIRST, so a flood
/// of unauthenticated requests is refused without doing public-key maths. The nonce is checked LAST,
/// after the signature has proven the request came from the key it names — a caller must record a
/// nonce only on `Ok(())`, so nothing an unauthenticated stranger sends can grow that set.
pub fn validate_till_open(
    open: &TillOpen,
    sig: &[u8; SIG_LEN],
    now_secs: u64,
    nonce_already_seen: bool,
) -> Result<(), TillOpenError> {
    if now_secs.abs_diff(open.issued_at) > TILL_OPEN_MAX_SKEW_SECS {
        return Err(TillOpenError::Stale);
    }
    let vk = match VerifyingKey::from_bytes(&open.merchant_pubkey) {
        Ok(vk) => vk,
        Err(_) => return Err(TillOpenError::MalformedKey),
    };
    // `verify_strict` rejects weak / small-order keys, matching `verify` / `verify_receipt`.
    if vk
        .verify_strict(&open.signing_bytes(), &Signature::from_bytes(sig))
        .is_err()
    {
        return Err(TillOpenError::BadSignature);
    }
    if nonce_already_seen {
        return Err(TillOpenError::NonceReused);
    }
    Ok(())
}

/// Generate a fresh signing key. **Native only** (needs an OS CSPRNG).
#[cfg(feature = "rng")]
pub fn generate_keypair() -> SigningKey {
    SigningKey::generate(&mut rand_core::OsRng)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayError {
    BadSignature,
    ZeroAmount,
    Expired,
    OverCap,
    InsufficientFunds,
    NonceReused,
}

/// Pure policy check. Signature validity is computed separately (see [`verify`]) and passed in as
/// `sig_ok`, so this stays allocation-free and callable from the canister hot path.
/// `now` and `auth.expiry` are unix seconds.
pub fn validate(
    auth: &Authorization,
    now: u64,
    cap: u64,
    balance: u64,
    nonce_already_seen: bool,
    sig_ok: bool,
) -> Result<(), PayError> {
    if !sig_ok {
        return Err(PayError::BadSignature);
    }
    if auth.amount == 0 {
        return Err(PayError::ZeroAmount);
    }
    if now >= auth.expiry {
        return Err(PayError::Expired);
    }
    if auth.amount > cap {
        return Err(PayError::OverCap);
    }
    if auth.amount > balance {
        return Err(PayError::InsufficientFunds);
    }
    if nonce_already_seen {
        return Err(PayError::NonceReused);
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CodecError {
    Base64,
    Length,
    PubkeyMismatch,
}

/// The wire object the payer's QR carries: an authorization plus its signature and the payer's
/// public key (carried explicitly so the merchant/relay verify without a directory lookup).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SignedAuthorization {
    pub auth: Authorization,
    pub sig: [u8; SIG_LEN],
    pub from_pub: [u8; PUBKEY_LEN],
}

impl SignedAuthorization {
    /// Build + sign in one step (payer side).
    pub fn new(key: &SigningKey, auth: Authorization) -> Self {
        let sig = sign(key, &auth).to_bytes();
        SignedAuthorization { auth, sig, from_pub: auth.from }
    }

    /// Raw 292-byte wire form: `signing_bytes(196) | sig(64) | from_pub(32)`.
    /// This is what the relay hands the canister (a candid `blob`); the QR carries its base64url.
    pub fn to_wire(&self) -> [u8; WIRE_LEN] {
        let mut raw = [0u8; WIRE_LEN];
        raw[0..SIGNING_LEN].copy_from_slice(&self.auth.signing_bytes());
        raw[SIGNING_LEN..SIGNING_LEN + SIG_LEN].copy_from_slice(&self.sig);
        raw[SIGNING_LEN + SIG_LEN..].copy_from_slice(&self.from_pub);
        raw
    }

    /// Parse the raw wire form. Rejects wrong length or a pubkey that disagrees with the
    /// authorization's `from` field.
    pub fn from_wire(raw: &[u8]) -> Result<Self, CodecError> {
        if raw.len() != WIRE_LEN {
            return Err(CodecError::Length);
        }
        let auth = Authorization {
            from: raw[0..32].try_into().unwrap(),
            to: raw[32..64].try_into().unwrap(),
            amount: u64::from_le_bytes(raw[64..72].try_into().unwrap()),
            nonce: raw[72..88].try_into().unwrap(),
            expiry: u64::from_le_bytes(raw[88..96].try_into().unwrap()),
            currency: u32::from_le_bytes(raw[96..100].try_into().unwrap()),
            from_name: raw[100..132].try_into().unwrap(),
            to_name: raw[132..164].try_into().unwrap(),
            memo: raw[164..196].try_into().unwrap(),
        };
        let sig: [u8; SIG_LEN] = raw[196..260].try_into().unwrap();
        let from_pub: [u8; PUBKEY_LEN] = raw[260..292].try_into().unwrap();
        if auth.from != from_pub {
            return Err(CodecError::PubkeyMismatch);
        }
        Ok(SignedAuthorization { auth, sig, from_pub })
    }

    /// Encode to a compact base64url string for the QR payload.
    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.to_wire())
    }

    /// Decode from the QR payload string.
    pub fn decode(s: &str) -> Result<Self, CodecError> {
        let raw = URL_SAFE_NO_PAD.decode(s.as_bytes()).map_err(|_| CodecError::Base64)?;
        Self::from_wire(&raw)
    }

    /// Verify the carried signature over the carried authorization.
    pub fn verify(&self) -> bool {
        let sig = Signature::from_bytes(&self.sig);
        verify(&self.from_pub, &self.auth, &sig)
    }
}

/// `to(32) | amount_le(8) | nonce(16) | expiry_le(8) | currency_le(4) | to_name(32) | memo(32)` = 132.
pub const REQUEST_LEN: usize = PUBKEY_LEN + 8 + NONCE_LEN + 8 + 4 + NAME_LEN + MEMO_LEN;

/// The **request** the merchant shows the payer, carried by the merchant's QR. Unsigned: it names
/// who to pay (`to`), how much (`amount`), a single-use `nonce` (the merchant's `request_id`), an
/// `expiry`, the settlement `currency`, the payee's display name (`to_name`), and an optional
/// `memo`. The payer scans this, reviews it, and signs an
/// [`Authorization`] that copies these fields verbatim — so the amount, payee, currency, payee name,
/// and memo are chosen by the merchant and then *bound* by the payer's signature. There is no `from`
/// (the payer supplies their own) and no `from_name` (the payer supplies their own) and no signature
/// here.
///
/// WHAT THE `nonce` DOES, PER RAIL — the ONE place this is written down, because a statement that
/// was true of the facade was inherited by a rail where it is false. It is `NONCE_LEN` bytes the
/// merchant mints once per request, and it is single-use in the sense that the merchant never
/// reissues it. What ENFORCES that differs:
///
///  * FACADE rail (DEMO, the canister's `pay`): the nonce really is the ledger nonce. The canister
///    reserves it in its `SPENT` set synchronously before any transfer, so a second `pay` carrying
///    it is refused. Real, and still what `dpay-sim` and `scripts/dfx-deploy.sh` demonstrate.
///  * SHIPPED app-signed rail (ckBTC/ckUSDC/ckETH/VCHF/ICP): there is no facade and no ledger
///    nonce. This value rides along as the ICRC-1 `memo`, which the ledger does not key on at all
///    (see `icp_transfer_arg` in dpay-ffi). It is a RECONCILIATION handle — it lets the payee match
///    an arriving transfer to the request that asked for it — and nothing more.
///
/// At-most-once on the shipped rail comes from the IC itself, not from this field: the payer signs
/// ONE envelope, its request id is the hash of that envelope's content, and the interface spec
/// makes `E.content ∉ dom(S.requests)` a precondition of admitting a submitted request — so the
/// identical bytes, handed over any number of times, execute once (proven in-repo by
/// `signed_transfer_through_api_v2_moves_funds_and_lands_in_history`). That holds only while the
/// envelope's own `ingress_expiry` has not passed, after which nothing executes at all.
///
/// THE SHARP EDGE: it is the BYTES that are single-use, not the nonce. Re-signing the same
/// authorization yields a different request id and pays a second time, which is why the rail
/// resubmits verbatim and never re-signs (`app/services/rail.ts`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PaymentRequest {
    pub to: [u8; PUBKEY_LEN],
    pub amount: u64,
    pub nonce: [u8; NONCE_LEN],
    pub expiry: u64,
    pub currency: Currency,
    /// The payee's display name (the merchant's own name). Copied verbatim into the authorization.
    pub to_name: [u8; NAME_LEN],
    /// An optional merchant-set memo. Copied verbatim into the authorization.
    pub memo: [u8; MEMO_LEN],
}

impl PaymentRequest {
    /// Raw 132-byte form: `to(32) | amount_le(8) | nonce(16) | expiry_le(8) | currency_le(4) |
    /// to_name(32) | memo(32)`. Frozen.
    pub fn to_bytes(&self) -> [u8; REQUEST_LEN] {
        let mut b = [0u8; REQUEST_LEN];
        b[0..32].copy_from_slice(&self.to);
        b[32..40].copy_from_slice(&self.amount.to_le_bytes());
        b[40..56].copy_from_slice(&self.nonce);
        b[56..64].copy_from_slice(&self.expiry.to_le_bytes());
        b[64..68].copy_from_slice(&self.currency.to_le_bytes());
        b[68..100].copy_from_slice(&self.to_name);
        b[100..132].copy_from_slice(&self.memo);
        b
    }

    /// Parse the raw 132-byte form. Rejects a wrong length.
    pub fn from_bytes(raw: &[u8]) -> Result<Self, CodecError> {
        if raw.len() != REQUEST_LEN {
            return Err(CodecError::Length);
        }
        Ok(PaymentRequest {
            to: raw[0..32].try_into().unwrap(),
            amount: u64::from_le_bytes(raw[32..40].try_into().unwrap()),
            nonce: raw[40..56].try_into().unwrap(),
            expiry: u64::from_le_bytes(raw[56..64].try_into().unwrap()),
            currency: u32::from_le_bytes(raw[64..68].try_into().unwrap()),
            to_name: raw[68..100].try_into().unwrap(),
            memo: raw[100..132].try_into().unwrap(),
        })
    }

    /// Encode to the compact base64url string the merchant's QR carries.
    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.to_bytes())
    }

    /// Decode from the scanned merchant QR string.
    pub fn decode(s: &str) -> Result<Self, CodecError> {
        let raw = URL_SAFE_NO_PAD.decode(s.as_bytes()).map_err(|_| CodecError::Base64)?;
        Self::from_bytes(&raw)
    }

    /// Turn a scanned request into the payer's [`Authorization`] — the payer supplies `from` and
    /// `from_name` (their own pubkey + display name); every other field, including `to_name` and
    /// `memo`, is copied from the merchant's request (so consent is bound to exactly what was
    /// requested, names and memo included).
    pub fn to_authorization(
        &self,
        from: [u8; PUBKEY_LEN],
        from_name: [u8; NAME_LEN],
    ) -> Authorization {
        Authorization {
            from,
            to: self.to,
            amount: self.amount,
            nonce: self.nonce,
            expiry: self.expiry,
            currency: self.currency,
            from_name,
            to_name: self.to_name,
            memo: self.memo,
        }
    }
}

// --- exact decimal <-> u64 amount parser (MC1 unit 1) ----------------------------------------
//
// The single source of truth for converting a human decimal string ("8.4") to/from the raw integer
// `u64` units every protocol type already carries (`Authorization.amount`, `PaymentRequest.amount`,
// `WithdrawAuth.amount`, `ReceiptClaim.amount`). Exact — no float intermediate, no silent rounding.
// The FFI exposes it to the app (`parse_amount` / `format_amount`); the TS BigInt mirror
// (`app/lib/amount.ts`) is parity-pinned by the e2e cross-val + jest. The OLD app path rounded u64
// through JS `number` / Kotlin `Double` (lossy above 2^53); this parser + the string-typed TS mirror
// retire that loss surface for amount I/O. The FROZEN wire itself is untouched — `amount` is already
// an exact `u64` in every wire struct; this only governs the human<->u64 boundary.

/// Maximum decimal precision supported. A `u64` (≤ 1.8e19) holds 18 decimals for any whole unit
/// ≥ 1; 19 decimals would overflow for whole units ≥ 2, so the parser bounds precision here. A
/// `decimals` argument above this is rejected by [`parse_decimal_to_units`] as [`AmountError::Overflow`]
/// (the precision is unsupported in the u64 value space); [`format_units_to_decimal`] clamps it.
pub const MAX_DECIMALS: u8 = 18;

/// Why a decimal amount string was rejected. Typed (never a silent rounding); the FFI maps each
/// variant to a debuggable `DpayError::Amount(code)` so the app reacts without string-sniffing.
/// The codes mirror the TS mirror's `err` strings exactly (`empty`/`not_a_number`/`negative`/
/// `too_many_decimals`/`overflow`) — single acceptance/rejection policy on both sides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmountError {
    /// The input (after whitespace trim) was empty.
    Empty,
    /// Not a valid decimal: non-digit chars, multiple dots, or a bare `.` with no digits. A
    /// leading-`.` (`.5` → 0.5) and trailing-`.` (`5.` → 5.0) ARE accepted (calculator-style).
    NotANumber,
    /// A leading `-`. Amounts are always non-negative, so any `-` (regardless of magnitude) is an
    /// error — checked before the rest of the shape so `-abc` is `Negative`, not `NotANumber`.
    Negative,
    /// More fractional digits than `decimals` allows (e.g. `"1.5"` at `decimals == 0`).
    TooManyDecimals,
    /// The scaled value does not fit in a `u64`, OR `decimals > MAX_DECIMALS`.
    Overflow,
}

/// Parse a human decimal string (e.g. `"8.4"`) into raw `u64` units at `decimals` precision.
///
/// Exact: the whole and fractional parts are scaled by `10^decimals` via a `u128` checked-arithmetic
/// intermediate — no `f64` ever touches the value. Acceptance (precedence in order):
///   1. Surrounding ASCII whitespace is trimmed.
///   2. Empty (after trim) → [`AmountError::Empty`].
///   3. A leading `-` → [`AmountError::Negative`] (regardless of what follows).
    ///   4. Must match `^(\d+\.?\d*|\.\d+)$` (a `.`-only or multi-dot input is
    ///      [`AmountError::NotANumber`]); a leading `.` (`.5`) and trailing `.` (`5.`) ARE accepted
    ///      (calculator-style); a leading `+` is NOT accepted.
///   5. Fractional digits beyond `decimals` → [`AmountError::TooManyDecimals`].
///   6. `decimals > MAX_DECIMALS`, or the scaled whole+fraction does not fit in `u64` →
///      [`AmountError::Overflow`].
///
/// `decimals == 0` rejects any fractional part as `TooManyDecimals`. This is the exact inverse of
/// [`format_units_to_decimal`] for every `u64` and every `decimals ≤ 18` (pinned by a proptest).
pub fn parse_decimal_to_units(human: &str, decimals: u8) -> Result<u64, AmountError> {
    let s = human.trim();
    if s.is_empty() {
        return Err(AmountError::Empty);
    }
    // A leading `-` is always Negative (checked before shape so "-abc" is Negative, not NotANumber).
    if s.starts_with('-') {
        return Err(AmountError::Negative);
    }
    // Split on the FIRST '.'; a second '.' lands inside the fractional part and is rejected below.
    let (whole_str, frac_opt) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    // Whole part: if non-empty, must be all ASCII digits (empty whole is OK — `.5` → 0).
    if !whole_str.is_empty() && !whole_str.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AmountError::NotANumber);
    }
    // Fractional part (if present): if non-empty, must be all ASCII digits (empty frac is OK — `5.` → 5).
    if let Some(frac) = frac_opt {
        if !frac.is_empty() && !frac.bytes().all(|b| b.is_ascii_digit()) {
            return Err(AmountError::NotANumber);
        }
    }
    // Require at least one digit somewhere (rejects a bare `.` with no whole and no fraction).
    if whole_str.is_empty() && frac_opt.map_or(true, |f| f.is_empty()) {
        return Err(AmountError::NotANumber);
    }
    // Bound precision: u64 holds ≤ 18 decimals for any meaningful whole unit.
    if decimals > MAX_DECIMALS {
        return Err(AmountError::Overflow);
    }
    // Fractional digit count beyond the asset's precision.
    if let Some(frac) = frac_opt {
        if frac.len() > decimals as usize {
            return Err(AmountError::TooManyDecimals);
        }
    }
    // Scale with u128 checked arithmetic (10^18 ≈ 1e18 ≪ u128::MAX ≈ 3.4e38).
    let scale = 10u128
        .checked_pow(decimals as u32)
        .ok_or(AmountError::Overflow)?;
    let whole = parse_decimal_digits_u128(whole_str)?;
    let frac = match frac_opt {
        Some(frac) => {
            let fval = parse_decimal_digits_u128(frac)?;
            let pad = decimals
                .checked_sub(frac.len() as u8)
                .expect("frac.len() ≤ decimals (checked above)") as u32;
            let pad_scale = 10u128.checked_pow(pad).ok_or(AmountError::Overflow)?;
            fval.checked_mul(pad_scale).ok_or(AmountError::Overflow)?
        }
        None => 0,
    };
    let whole_scaled = whole.checked_mul(scale).ok_or(AmountError::Overflow)?;
    let total = whole_scaled.checked_add(frac).ok_or(AmountError::Overflow)?;
    if total > u64::MAX as u128 {
        return Err(AmountError::Overflow);
    }
    Ok(total as u64)
}

/// Format raw `u64` units as a human decimal string at `decimals` precision. Trims trailing
/// fractional zeros (so `8400000000000000000` at 18 → `"8.4"`, and a whole number renders without a
/// decimal point — `8400` at 2 → `"84"`); the integer part is never touched. `decimals` is bounded at
/// [`MAX_DECIMALS`] (a larger value is clamped, matching the parser's ≤ 18 contract, so the `u128`
/// power never overflows).
///
/// This is the exact inverse of [`parse_decimal_to_units`]: for every `u64` and every
/// `decimals ≤ 18`, `parse_decimal_to_units(&format_units_to_decimal(raw, d), d) == Ok(raw)` (pinned
/// by a proptest). Trimming (not padding to `decimals`) is chosen deliberately so high-precision
/// assets render readably (`"8.4 BTC"` not `"8.400000000000000000 BTC"`); display-padding to a fixed
/// width remains a UI concern (the app's `fmtAsset`), separate from this primitive.
pub fn format_units_to_decimal(raw: u64, decimals: u8) -> String {
    let d = (decimals.min(MAX_DECIMALS)) as u32;
    let scale = 10u128.pow(d);
    let val = raw as u128;
    let whole = val / scale;
    let frac = val % scale;
    if d == 0 || frac == 0 {
        return whole.to_string();
    }
    // Fraction as a zero-padded (width = d) string, then trim trailing zeros.
    let mut frac_str = format!("{:0width$}", frac, width = d as usize);
    while frac_str.ends_with('0') {
        frac_str.pop();
    }
    format!("{}.{}", whole, frac_str)
}

/// Checked decimal-digit accumulation into `u128`. Returns [`AmountError::Overflow`] if the digit
/// string represents a value too large for `u128` (e.g. a 40-digit whole part) rather than panicking
/// or silently wrapping — the parser's job is to surface a typed error, never to round.
fn parse_decimal_digits_u128(s: &str) -> Result<u128, AmountError> {
    let mut acc: u128 = 0;
    for b in s.bytes() {
        // Caller has already validated all bytes are ASCII digits; this is belt-and-suspenders.
        let digit = (b - b'0') as u128;
        acc = acc
            .checked_mul(10)
            .and_then(|v| v.checked_add(digit))
            .ok_or(AmountError::Overflow)?;
    }
    Ok(acc)
}

// ---------------------------------------------------------------------------
// Tests (keygen needs `rng`): run with `cargo nextest run -p dpay-core --features rng`
// ---------------------------------------------------------------------------
#[cfg(all(test, feature = "rng"))]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::collections::{HashMap, HashSet};

    fn any_auth() -> impl Strategy<Value = Authorization> {
        (
            any::<[u8; 32]>(),
            any::<[u8; 32]>(),
            any::<u64>(),
            any::<[u8; 16]>(),
            any::<u64>(),
            any::<u8>(),
            any::<[u8; NAME_LEN]>(),
            any::<[u8; NAME_LEN]>(),
            any::<[u8; MEMO_LEN]>(),
        )
            .prop_map(|(from, to, amount, nonce, expiry, currency, from_name, to_name, memo)| {
                Authorization {
                    from,
                    to,
                    amount,
                    nonce,
                    expiry,
                    currency: currency as u32,
                    from_name,
                    to_name,
                    memo,
                }
            })
    }

    /// Pad an ASCII name/memo to a fixed 32-byte NUL-padded buffer (mirrors what the app builder
    /// does before constructing an `Authorization` / `PaymentRequest`).
    fn pad32(s: &[u8]) -> [u8; NAME_LEN] {
        let mut b = [0u8; NAME_LEN];
        let n = s.len().min(NAME_LEN);
        b[..n].copy_from_slice(&s[..n]);
        b
    }

    proptest! {
        #[test]
        fn sign_verify_and_codec_roundtrip(amount in 1u64.., expiry in 1u64.., nonce in any::<[u8;16]>()) {
            let sk = generate_keypair();
            let from = sk.verifying_key().to_bytes();
            let from_name = pad32(b"Alice");
            let to_name = pad32(b"Bob");
            let memo = pad32(b"dinner");
            let auth = Authorization { from, to: [7u8; 32], amount, nonce, expiry, currency: DEMO_USD, from_name, to_name, memo };
            let sig = sign(&sk, &auth);
            prop_assert!(verify(&from, &auth, &sig));

            let se = SignedAuthorization::new(&sk, auth);
            let wire = se.encode();
            // base64url no-pad of 292 bytes: 292 = 3*97 + 1 -> 97*4 + 2 = 390 chars.
            prop_assert_eq!(wire.len(), 390);
            let back = SignedAuthorization::decode(&wire).unwrap();
            prop_assert_eq!(back, se);
            prop_assert!(back.verify());
        }

        #[test]
        fn request_codec_roundtrip_and_binds(
            amount in 1u64.., expiry in 1u64.., nonce in any::<[u8;16]>(),
            to in any::<[u8;32]>(), from in any::<[u8;32]>(),
        ) {
            let to_name = pad32(b"Bob");
            let memo = pad32(b"coffee");
            let req = PaymentRequest { to, amount, nonce, expiry, currency: DEMO_USD, to_name, memo };
            let s = req.encode();
            // base64url no-pad of 132 bytes: 132 = 3*44 + 0 -> 44*4 = 176 chars.
            prop_assert_eq!(s.len(), 176);
            prop_assert_eq!(PaymentRequest::decode(&s).unwrap(), req);
            // What the payer signs copies the merchant's request verbatim (only `from` + `from_name`
            // are the payer's own).
            let from_name = pad32(b"Alice");
            let auth = req.to_authorization(from, from_name);
            prop_assert_eq!(auth.to, to);
            prop_assert_eq!(auth.amount, amount);
            prop_assert_eq!(auth.nonce, nonce);
            prop_assert_eq!(auth.expiry, expiry);
            prop_assert_eq!(auth.from, from);
            prop_assert_eq!(auth.currency, DEMO_USD);
            // The merchant's to_name + memo are copied verbatim; the payer's from_name is supplied.
            prop_assert_eq!(auth.to_name, to_name);
            prop_assert_eq!(auth.memo, memo);
            prop_assert_eq!(auth.from_name, from_name);
        }

        #[test]
        fn tamper_breaks_verify(idx in 0usize..SIGNING_LEN, xor in 1u8..=255) {
            let sk = generate_keypair();
            let from = sk.verifying_key().to_bytes();
            let auth = Authorization { from, to: [1u8; 32], amount: 100, nonce: [9u8; 16], expiry: 9999, currency: DEMO_USD, from_name: pad32(b"Alice"), to_name: pad32(b"Bob"), memo: pad32(b"dinner") };
            let sig = sign(&sk, &auth);
            let mut bytes = auth.signing_bytes();
            bytes[idx] ^= xor;
            let tampered = Authorization {
                from: bytes[0..32].try_into().unwrap(),
                to: bytes[32..64].try_into().unwrap(),
                amount: u64::from_le_bytes(bytes[64..72].try_into().unwrap()),
                nonce: bytes[72..88].try_into().unwrap(),
                expiry: u64::from_le_bytes(bytes[88..96].try_into().unwrap()),
                currency: u32::from_le_bytes(bytes[96..100].try_into().unwrap()),
                from_name: bytes[100..132].try_into().unwrap(),
                to_name: bytes[132..164].try_into().unwrap(),
                memo: bytes[164..196].try_into().unwrap(),
            };
            prop_assert!(!verify(&from, &tampered, &sig));
        }

        /// Names ride inside the signed region, so flipping any byte in the name fields [100..164)
        /// breaks verification (proves `from_name`/`to_name` are bound by the signature).
        #[test]
        fn tampering_a_name_byte_breaks_verify(idx in 100usize..164, xor in 1u8..=255) {
            let sk = generate_keypair();
            let from = sk.verifying_key().to_bytes();
            let auth = Authorization { from, to: [1u8; 32], amount: 100, nonce: [9u8; 16], expiry: 9999, currency: DEMO_USD, from_name: pad32(b"Alice"), to_name: pad32(b"Bob"), memo: pad32(b"dinner") };
            let sig = sign(&sk, &auth);
            let mut bytes = auth.signing_bytes();
            bytes[idx] ^= xor;
            let tampered = Authorization {
                from: bytes[0..32].try_into().unwrap(),
                to: bytes[32..64].try_into().unwrap(),
                amount: u64::from_le_bytes(bytes[64..72].try_into().unwrap()),
                nonce: bytes[72..88].try_into().unwrap(),
                expiry: u64::from_le_bytes(bytes[88..96].try_into().unwrap()),
                currency: u32::from_le_bytes(bytes[96..100].try_into().unwrap()),
                from_name: bytes[100..132].try_into().unwrap(),
                to_name: bytes[132..164].try_into().unwrap(),
                memo: bytes[164..196].try_into().unwrap(),
            };
            prop_assert!(!verify(&from, &tampered, &sig));
        }

        #[test]
        fn wrong_key_fails(a in any_auth()) {
            let sk = generate_keypair();
            let other = generate_keypair().verifying_key().to_bytes();
            let sig = sign(&sk, &a);
            prop_assert!(!verify(&other, &a, &sig));
        }

        #[test]
        fn validate_rules(amount in any::<u64>(), cap in any::<u64>(), balance in any::<u64>(),
                          now in any::<u64>(), expiry in any::<u64>()) {
            let a = Authorization { from: [0;32], to: [0;32], amount, nonce: [0;16], expiry, currency: DEMO_USD, from_name: [0;NAME_LEN], to_name: [0;NAME_LEN], memo: [0;MEMO_LEN] };
            match validate(&a, now, cap, balance, false, true) {
                Ok(()) => prop_assert!(amount > 0 && now < expiry && amount <= cap && amount <= balance),
                Err(PayError::ZeroAmount)        => prop_assert_eq!(amount, 0),
                Err(PayError::Expired)           => prop_assert!(now >= expiry),
                Err(PayError::OverCap)           => prop_assert!(amount > cap),
                Err(PayError::InsufficientFunds) => prop_assert!(amount > balance),
                Err(e) => prop_assert!(false, "unexpected {:?}", e),
            }
        }

        #[test]
        fn nonce_reuse_rejected(a in any_auth()) {
            prop_assert_eq!(validate(&a, 0, u64::MAX, u64::MAX, true, true), Err(PayError::NonceReused));
        }

        #[test]
        fn bad_sig_rejected(a in any_auth()) {
            prop_assert_eq!(validate(&a, 0, u64::MAX, u64::MAX, false, false), Err(PayError::BadSignature));
        }

        // Conservation of funds: over a random op sequence against a 2-account ledger,
        // the total never changes and no balance goes negative.
        #[test]
        fn conservation_of_funds(
            init_a in 0u64..1_000_000, init_b in 0u64..1_000_000,
            ops in prop::collection::vec((any::<bool>(), 0u64..2000, any::<[u8;16]>()), 0..64)
        ) {
            let ka = generate_keypair();
            let kb = generate_keypair();
            let pa = ka.verifying_key().to_bytes();
            let pb = kb.verifying_key().to_bytes();
            let mut bal: HashMap<[u8;32], u64> = HashMap::new();
            bal.insert(pa, init_a);
            bal.insert(pb, init_b);
            let mut seen: HashSet<[u8;16]> = HashSet::new();
            let total0 = init_a + init_b;

            for (dir, amount, nonce) in ops {
                let (sk, from, to) = if dir { (&ka, pa, pb) } else { (&kb, pb, pa) };
                let auth = Authorization { from, to, amount, nonce, expiry: u64::MAX, currency: DEMO_USD, from_name: [0;NAME_LEN], to_name: [0;NAME_LEN], memo: [0;MEMO_LEN] };
                let sig_ok = verify(&from, &auth, &sign(sk, &auth));
                let from_bal = bal[&from];
                let seen_nonce = seen.contains(&nonce);
                if validate(&auth, 0, u64::MAX, from_bal, seen_nonce, sig_ok).is_ok() {
                    *bal.get_mut(&from).unwrap() -= amount;
                    *bal.get_mut(&to).unwrap() += amount;
                    seen.insert(nonce);
                }
                prop_assert_eq!(bal[&pa] + bal[&pb], total0);
            }
        }
    }

    #[test]
    fn receipt_claim_sign_verify_and_tamper() {
        let sk = generate_keypair();
        let pk = sk.verifying_key().to_bytes();
        let claim = ReceiptClaim {
            nonce: [0x2a; 16],
            from: [0x11; 32],
            to: [0x22; 32],
            amount: 2_500,
            currency: DEMO_USD,
            block_index: 7,
            settle_ts: 1_800_000_120,
        };
        let sig = sign_receipt(&sk, &claim);
        let sig_bytes = sig.to_bytes();

        // Round-trip length + verifies under the right key.
        assert_eq!(claim.signing_bytes().len(), RECEIPT_CLAIM_LEN);
        assert_eq!(RECEIPT_CLAIM_LEN, 16 + 32 + 32 + 8 + 4 + 8 + 8);
        assert!(verify_receipt(&pk, &claim, &sig_bytes));

        // Wrong key fails.
        let other = generate_keypair().verifying_key().to_bytes();
        assert!(!verify_receipt(&other, &claim, &sig_bytes));

        // Tampering ANY field breaks verification (outcome integrity — a lying merchant can't alter
        // the amount/block/ts and keep a valid sig).
        let mut tampered = claim;
        tampered.amount = 2_501;
        assert!(!verify_receipt(&pk, &tampered, &sig_bytes), "tampered amount must fail");
        let mut t2 = claim;
        t2.nonce[0] ^= 0xFF;
        assert!(!verify_receipt(&pk, &t2, &sig_bytes), "tampered nonce must fail");
        let mut t3 = claim;
        t3.block_index = 999;
        assert!(!verify_receipt(&pk, &t3, &sig_bytes), "tampered block_index must fail");
        let mut t4 = claim;
        t4.settle_ts += 1;
        assert!(!verify_receipt(&pk, &t4, &sig_bytes), "tampered settle_ts must fail");

    // A bad sig shape (all-zero) is rejected, not panicked.
    assert!(!verify_receipt(&pk, &claim, &[0u8; SIG_LEN]));
    }

    #[test]
    fn withdraw_auth_sign_verify_and_tamper() {
        let sk = generate_keypair();
        let pk = sk.verifying_key().to_bytes();
        let auth = WithdrawAuth {
            from_pubkey: pk,
            destination: "bc1qexampledestinationaddress".to_string(),
            amount: 50_000,
            nonce: [0x2a; NONCE_LEN],
            expiry: 1_800_000_120,
            currency: DEMO_USD,
        };
        let sig = sign_withdraw(&sk, &auth);
        let sig_bytes = sig.to_bytes();

        // Verifies under the right key.
        assert!(auth.verify(&pk, &sig), "valid sig must verify");
        // signing_bytes has the documented fixed prefix + a length-prefixed address suffix.
        let sb = auth.signing_bytes();
        assert_eq!(
            sb.len(),
            WITHDRAW_FIXED_LEN + WITHDRAW_ADDR_LEN_BYTES + auth.destination.len(),
            "signing_bytes length = fixed prefix + 4-byte len + address"
        );
        assert_eq!(WITHDRAW_FIXED_LEN, PUBKEY_LEN + 8 + NONCE_LEN + 8 + 4);

        // Wrong key fails.
        let other = generate_keypair().verifying_key().to_bytes();
        assert!(!auth.verify(&other, &sig), "wrong key must fail");

        // A `from_pubkey` that disagrees with the auth's `from_pubkey` fails fast (no funds move).
        let mut mismatched = auth.clone();
        mismatched.from_pubkey = other;
        assert!(!mismatched.verify(&pk, &sig_bytes.into()), "from_pubkey mismatch must fail");

        // Tampering ANY field breaks verification (destination/amount/nonce/expiry/currency bound).
        let mut t_addr = auth.clone();
        t_addr.destination.push('x');
        assert!(!t_addr.verify(&pk, &sig), "tampered destination must fail");
        let mut t_amt = auth.clone();
        t_amt.amount = 50_001;
        assert!(!t_amt.verify(&pk, &sig), "tampered amount must fail");
        let mut t_nonce = auth.clone();
        t_nonce.nonce[0] ^= 0xFF;
        assert!(!t_nonce.verify(&pk, &sig), "tampered nonce must fail");
        let mut t_exp = auth.clone();
        t_exp.expiry += 1;
        assert!(!t_exp.verify(&pk, &sig), "tampered expiry must fail");
        let mut t_cur = auth.clone();
        t_cur.currency += 1;
        assert!(!t_cur.verify(&pk, &sig), "tampered currency must fail");

        // An empty address still has a valid (zero-length) length prefix — verifiable, not a panic.
        let empty = WithdrawAuth { destination: String::new(), ..auth.clone() };
        let empty_sig = sign_withdraw(&sk, &empty);
        assert!(empty.verify(&pk, &empty_sig), "empty address is a valid signing input");
        assert_eq!(empty.signing_bytes().len(), WITHDRAW_FIXED_LEN + WITHDRAW_ADDR_LEN_BYTES);

        // A bad sig shape (all-zero) is rejected, not panicked.
        assert!(!auth.verify(&pk, &Signature::from_bytes(&[0u8; SIG_LEN])), "zero sig must fail");
    }

    // --- till-open authorization (the merchant proves the account they name is theirs) ---------

    fn till_open(key: &SigningKey) -> TillOpen {
        TillOpen {
            merchant_pubkey: key.verifying_key().to_bytes(),
            cents: 1_000,
            nonce: [0x2a; NONCE_LEN],
            issued_at: 1_786_815_398,
            merchant_name: "Café Bahnhof ☕".to_string(),
            note: None,
        }
    }

    #[test]
    fn till_open_binds_the_key_and_every_field_it_carries() {
        let sk = generate_keypair();
        let open = till_open(&sk);
        let sig = sign_till_open(&sk, &open).to_bytes();
        let now = open.issued_at;

        assert_eq!(validate_till_open(&open, &sig, now, false), Ok(()));
        // The buffer is the documented fixed prefix + a length-prefixed name.
        assert_eq!(
            open.signing_bytes().len(),
            TILL_OPEN_FIXED_LEN + TILL_OPEN_NAME_LEN_BYTES + open.merchant_name.len(),
            "signing_bytes = domain+pubkey+cents+nonce+issued_at, then 4-byte len + name"
        );

        // A signature by ANOTHER key never opens a charge for this one — the whole point.
        let other = generate_keypair();
        let stolen = sign_till_open(&other, &open).to_bytes();
        assert_eq!(
            validate_till_open(&open, &stolen, now, false),
            Err(TillOpenError::BadSignature),
            "only the named key may ring up its own till"
        );
        // …and the same request re-pointed at another merchant's key does not verify either.
        let repointed = TillOpen { merchant_pubkey: other.verifying_key().to_bytes(), ..open.clone() };
        assert_eq!(
            validate_till_open(&repointed, &sig, now, false),
            Err(TillOpenError::BadSignature),
            "swapping the destination key must invalidate the signature"
        );

        // Tampering with ANY carried field breaks verification: price, nonce, time, claimed name.
        let t_cents = TillOpen { cents: open.cents + 1, ..open.clone() };
        assert_eq!(validate_till_open(&t_cents, &sig, now, false), Err(TillOpenError::BadSignature));
        let mut t_nonce = open.clone();
        t_nonce.nonce[0] ^= 0xFF;
        assert_eq!(validate_till_open(&t_nonce, &sig, now, false), Err(TillOpenError::BadSignature));
        let t_time = TillOpen { issued_at: open.issued_at + 1, ..open.clone() };
        assert_eq!(
            validate_till_open(&t_time, &sig, t_time.issued_at, false),
            Err(TillOpenError::BadSignature)
        );
        let t_name = TillOpen { merchant_name: "Migros".to_string(), ..open.clone() };
        assert_eq!(
            validate_till_open(&t_name, &sig, now, false),
            Err(TillOpenError::BadSignature),
            "the CLAIMED name is shown to payers, so it must be signed"
        );
    }

    #[test]
    fn till_open_note_rides_its_own_tag_length_prefix_and_signature() {
        let sk = generate_keypair();
        // Multi-byte note on purpose: the length prefix must count BYTES, not characters, exactly
        // like the name prefix beside it.
        let open = TillOpen {
            note: Some("2× Kafi, Tisch 4 ☕".to_string()),
            ..till_open(&sk)
        };
        let sig = sign_till_open(&sk, &open).to_bytes();
        let now = open.issued_at;
        let buf = open.signing_bytes();
        let note = open.note.as_deref().unwrap();

        assert_eq!(&buf[..TILL_OPEN_DOMAIN_V2.len()], TILL_OPEN_DOMAIN_V2.as_slice());
        assert_eq!(
            buf.len(),
            TILL_OPEN_FIXED_LEN_V2
                + TILL_OPEN_NAME_LEN_BYTES
                + open.merchant_name.len()
                + TILL_OPEN_NOTE_LEN_BYTES
                + note.len()
        );
        // The declared note length counts bytes, and the note lands after the name's bytes.
        let note_len_at = TILL_OPEN_FIXED_LEN_V2 + TILL_OPEN_NAME_LEN_BYTES + open.merchant_name.len();
        let declared = u32::from_le_bytes(
            buf[note_len_at..note_len_at + TILL_OPEN_NOTE_LEN_BYTES].try_into().unwrap(),
        );
        assert_eq!(declared as usize, note.len());
        assert!(declared as usize > note.chars().count(), "the golden note is multi-byte");
        assert_eq!(&buf[note_len_at + TILL_OPEN_NOTE_LEN_BYTES..], note.as_bytes());
        assert_eq!(validate_till_open(&open, &sig, now, false), Ok(()));

        // Tampering with the note breaks verification — it is payer-read text, same class as the
        // claimed name, so it must be attribution-bearing the same way.
        let t_note = TillOpen { note: Some("1× Kafi".to_string()), ..open.clone() };
        assert_eq!(validate_till_open(&t_note, &sig, now, false), Err(TillOpenError::BadSignature));

        // v1/v2 confusion is impossible by construction: the same fields with the note REMOVED sign
        // a different buffer (different tag), so a v2 signature never validates a v1 request and a
        // v1 signature never validates a v2 one — in either direction.
        let v1 = TillOpen { note: None, ..open.clone() };
        let v1_sig = sign_till_open(&sk, &v1).to_bytes();
        assert_ne!(v1.signing_bytes(), open.signing_bytes());
        assert_eq!(validate_till_open(&v1, &sig, now, false), Err(TillOpenError::BadSignature));
        assert_eq!(validate_till_open(&open, &v1_sig, now, false), Err(TillOpenError::BadSignature));

        // An EMPTY note is still v2 — the field's presence is information the tag states, and an
        // upgraded signer cannot silently fall back to the v1 buffer by clearing the note.
        let empty = TillOpen { note: Some(String::new()), ..open };
        let empty_sig = sign_till_open(&sk, &empty).to_bytes();
        assert_eq!(validate_till_open(&empty, &empty_sig, now, false), Ok(()));
        assert_eq!(
            validate_till_open(&empty, &v1_sig, now, false),
            Err(TillOpenError::BadSignature),
            "Some(\"\") and None sign different buffers"
        );
    }

    #[test]
    fn till_open_is_domain_separated_from_everything_else_this_key_signs() {
        let sk = generate_keypair();
        let open = till_open(&sk);
        let buf = open.signing_bytes();

        // The tag is FIRST — that placement is what makes every other dpay signing buffer (which
        // starts with a pubkey, a different tag, or 0x0A) unusable here.
        assert_eq!(&buf[..TILL_OPEN_DOMAIN.len()], TILL_OPEN_DOMAIN.as_slice());

        // Signing the SAME fields without the tag produces a signature this validator refuses, so
        // some future untagged `{pubkey, cents, nonce, issued_at, name}` message can never be
        // replayed into a till ring-up.
        let untagged = sk.sign(&buf[TILL_OPEN_DOMAIN.len()..]).to_bytes();
        assert_eq!(
            validate_till_open(&open, &untagged, open.issued_at, false),
            Err(TillOpenError::BadSignature)
        );

        // A real payment authorization signed by the SAME device key is not a till ring-up.
        let auth = Authorization {
            from: open.merchant_pubkey,
            to: [7u8; PUBKEY_LEN],
            amount: open.cents,
            nonce: open.nonce,
            expiry: open.issued_at + 60,
            currency: DEMO_USD,
            from_name: pad32(b"Cafe"),
            to_name: pad32(b"Bob"),
            memo: pad32(b"coffee"),
        };
        let pay_sig = sign(&sk, &auth).to_bytes();
        assert_eq!(
            validate_till_open(&open, &pay_sig, open.issued_at, false),
            Err(TillOpenError::BadSignature),
            "a payment signature must not double as permission to open a till"
        );
        // …and the converse: the till signature is not a valid payment authorization.
        let till_sig = sign_till_open(&sk, &open);
        assert!(!verify(&open.merchant_pubkey, &auth, &till_sig));
    }

    #[test]
    fn till_open_accepts_only_inside_a_symmetric_clock_window() {
        let sk = generate_keypair();
        let open = till_open(&sk);
        let sig = sign_till_open(&sk, &open).to_bytes();
        let t = open.issued_at;

        // Inclusive at both edges: a device exactly at the limit is still served, not refused.
        assert_eq!(validate_till_open(&open, &sig, t + TILL_OPEN_MAX_SKEW_SECS, false), Ok(()));
        assert_eq!(validate_till_open(&open, &sig, t - TILL_OPEN_MAX_SKEW_SECS, false), Ok(()));
        // One second past, in either direction, is Stale — this is the bound that keeps the
        // verifier's seen-nonce set finite.
        assert_eq!(
            validate_till_open(&open, &sig, t + TILL_OPEN_MAX_SKEW_SECS + 1, false),
            Err(TillOpenError::Stale)
        );
        assert_eq!(
            validate_till_open(&open, &sig, t - TILL_OPEN_MAX_SKEW_SECS - 1, false),
            Err(TillOpenError::Stale)
        );
        // Staleness is checked BEFORE the signature, so a flood of garbage costs no key maths.
        assert_eq!(
            validate_till_open(&open, &[0u8; SIG_LEN], t + 10_000, false),
            Err(TillOpenError::Stale)
        );
    }

    #[test]
    fn till_open_refuses_a_reused_nonce_a_garbage_signature_and_a_malformed_key() {
        let sk = generate_keypair();
        let open = till_open(&sk);
        let sig = sign_till_open(&sk, &open).to_bytes();
        let now = open.issued_at;

        // Replay of a byte-identical, still-fresh request: the first one already opened the charge.
        assert_eq!(validate_till_open(&open, &sig, now, true), Err(TillOpenError::NonceReused));
        // Garbage / truncated signatures are refused, never panicked over.
        assert_eq!(
            validate_till_open(&open, &[0u8; SIG_LEN], now, false),
            Err(TillOpenError::BadSignature)
        );
        let mut clipped = sig;
        clipped[SIG_LEN - 1] ^= 0xFF;
        assert_eq!(validate_till_open(&open, &clipped, now, false), Err(TillOpenError::BadSignature));
        // A key that is not a valid Ed25519 point is its own diagnosis: no signature could ever
        // verify under it, so the merchant is told THAT rather than "bad signature". The vector is
        // the literal `deadbeef…deadbeef` that opened a live production charge on 2026-09-03 —
        // it is not even a point on the curve, which is how completely unchecked that path was.
        let mut deadbeef = [0u8; PUBKEY_LEN];
        for chunk in deadbeef.chunks_exact_mut(4) {
            chunk.copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        }
        let bad_key = TillOpen { merchant_pubkey: deadbeef, ..open.clone() };
        assert_eq!(
            validate_till_open(&bad_key, &sig, now, false),
            Err(TillOpenError::MalformedKey)
        );
    }

    #[test]
    fn till_open_name_is_length_prefixed_so_the_encoding_is_unambiguous() {
        let sk = generate_keypair();
        // An empty claimed name is a valid signing input (the till's `merchant_name` defaults to "").
        let anon = TillOpen { merchant_name: String::new(), ..till_open(&sk) };
        let anon_sig = sign_till_open(&sk, &anon).to_bytes();
        assert_eq!(validate_till_open(&anon, &anon_sig, anon.issued_at, false), Ok(()));
        assert_eq!(anon.signing_bytes().len(), TILL_OPEN_FIXED_LEN + TILL_OPEN_NAME_LEN_BYTES);

        // The length prefix counts BYTES, not characters — a multi-byte name must not under-declare.
        let open = till_open(&sk);
        let name_len_at = TILL_OPEN_FIXED_LEN;
        let declared = u32::from_le_bytes(
            open.signing_bytes()[name_len_at..name_len_at + TILL_OPEN_NAME_LEN_BYTES]
                .try_into()
                .unwrap(),
        );
        assert_eq!(declared as usize, open.merchant_name.len());
        assert!(declared as usize > open.merchant_name.chars().count(), "the golden name is multi-byte");

        // Two DIFFERENT names cannot produce the same buffer even when one is a prefix of the other
        // — the property a bare concatenation would lose.
        let short = TillOpen { merchant_name: "ab".to_string(), ..till_open(&sk) };
        let long = TillOpen { merchant_name: "abc".to_string(), ..till_open(&sk) };
        assert_ne!(short.signing_bytes(), long.signing_bytes());
        let short_sig = sign_till_open(&sk, &short).to_bytes();
        assert_eq!(
            validate_till_open(&long, &short_sig, long.issued_at, false),
            Err(TillOpenError::BadSignature)
        );
    }

    proptest! {
        /// Flipping ANY byte of the signing buffer breaks verification — the same tamper property
        /// `tamper_breaks_verify` pins for payments, proven here over the reconstructed fields so it
        /// covers the domain tag and the length prefix as well as the values.
        #[test]
        fn till_open_tamper_breaks_verify(
            idx in 0usize..TILL_OPEN_FIXED_LEN, xor in 1u8..=255,
        ) {
            let sk = generate_keypair();
            let open = till_open(&sk);
            let sig = sign_till_open(&sk, &open).to_bytes();
            let mut bytes = open.signing_bytes();
            bytes[idx] ^= xor;
            // Rebuild the struct from the mutated buffer (the tag itself is not a struct field, so a
            // flip inside it is asserted directly against the constant instead).
            if idx < TILL_OPEN_DOMAIN.len() {
                prop_assert_ne!(&bytes[..TILL_OPEN_DOMAIN.len()], TILL_OPEN_DOMAIN.as_slice());
                return Ok(());
            }
            let o = TILL_OPEN_DOMAIN.len();
            let tampered = TillOpen {
                merchant_pubkey: bytes[o..o + PUBKEY_LEN].try_into().unwrap(),
                cents: u64::from_le_bytes(bytes[o + PUBKEY_LEN..o + PUBKEY_LEN + 8].try_into().unwrap()),
                nonce: bytes[o + PUBKEY_LEN + 8..o + PUBKEY_LEN + 8 + NONCE_LEN].try_into().unwrap(),
                issued_at: u64::from_le_bytes(
                    bytes[o + PUBKEY_LEN + 8 + NONCE_LEN..TILL_OPEN_FIXED_LEN].try_into().unwrap(),
                ),
                merchant_name: open.merchant_name.clone(),
                // The proptest walks the v1 buffer (the range stops at the v1 fixed prefix), so the
                // reconstruction is the v1 request: no note.
                note: None,
            };
            // `now` follows the tampered time so a flipped `issued_at` fails on the SIGNATURE (the
            // property under test) rather than trivially on staleness.
            prop_assert!(validate_till_open(&tampered, &sig, tampered.issued_at, false).is_err());
        }
    }

    // --- amount parser (MC1 unit 1) — exact decimal<->u64, no float intermediate --------------

    #[test]
    fn amount_parse_basic_vectors() {
        // decimals=2 (cents): "84.00" -> 8400, "0.84" -> 84, "8.4" -> 840.
        assert_eq!(parse_decimal_to_units("84.00", 2), Ok(8400));
        assert_eq!(parse_decimal_to_units("0.84", 2), Ok(84));
        assert_eq!(parse_decimal_to_units("8.4", 2), Ok(840));
        // decimals=0: integer only.
        assert_eq!(parse_decimal_to_units("42", 0), Ok(42));
        assert_eq!(parse_decimal_to_units("0", 0), Ok(0));
        // decimals=18: a value > 2^53 that would be WRONG via f64. 8.4 * 1e18 = 8400000000000000000.
        assert_eq!(parse_decimal_to_units("8.4", 18), Ok(8_400_000_000_000_000_000));
        // 0.009007199254740993 * 1e18 = 9007199254740993 (2^53 + 1 — the canonical f64-loss probe).
        assert_eq!(parse_decimal_to_units("0.009007199254740993", 18), Ok(9_007_199_254_740_993));
        // Surrounding ASCII whitespace is trimmed.
        assert_eq!(parse_decimal_to_units("  8.4  ", 18), Ok(8_400_000_000_000_000_000));
        // A whole number at high precision parses too.
        assert_eq!(parse_decimal_to_units("18", 18), Ok(18_000_000_000_000_000_000));
    }

    #[test]
    fn amount_parse_leading_and_trailing_dot() {
        // Leading-dot ".5" at 2 decimals -> 0.5 * 100 = 50.
        assert_eq!(parse_decimal_to_units(".5", 2), Ok(50));
        // Leading-dot ".5" at 6 decimals -> 500000.
        assert_eq!(parse_decimal_to_units(".5", 6), Ok(500_000));
        // Leading-dot ".1" at 18 decimals -> 1e17.
        assert_eq!(parse_decimal_to_units(".1", 18), Ok(100_000_000_000_000_000));
        // Leading-dot ".01" at 8 decimals -> 1000000.
        assert_eq!(parse_decimal_to_units(".01", 8), Ok(1_000_000));
        // Trailing-dot "5." at 2 decimals -> 5 * 100 = 500 (empty fraction is OK).
        assert_eq!(parse_decimal_to_units("5.", 2), Ok(500));
        // Trailing-dot at 0 decimals -> whole number, empty fraction.
        assert_eq!(parse_decimal_to_units("5.", 0), Ok(5));
        // Trailing-dot "0." at 6 decimals -> 0.
        assert_eq!(parse_decimal_to_units("0.", 6), Ok(0));
        // A bare "." with no digits anywhere is still NotANumber.
        assert_eq!(parse_decimal_to_units(".", 2), Err(AmountError::NotANumber));
    }

    #[test]
    fn amount_format_basic_vectors() {
        // Trim trailing fractional zeros; whole numbers render without a decimal point.
        assert_eq!(format_units_to_decimal(8400, 2), "84");
        assert_eq!(format_units_to_decimal(84, 2), "0.84");
        assert_eq!(format_units_to_decimal(840, 2), "8.4");
        assert_eq!(format_units_to_decimal(42, 0), "42");
        assert_eq!(format_units_to_decimal(0, 18), "0");
        // 8.4 at 18 decimals (the > 2^53 case): trims the 17 trailing zeros.
        assert_eq!(format_units_to_decimal(8_400_000_000_000_000_000, 18), "8.4");
        assert_eq!(format_units_to_decimal(9_007_199_254_740_993, 18), "0.009007199254740993");
        // u64::MAX at 18 decimals has no trailing zero to trim.
        assert_eq!(format_units_to_decimal(u64::MAX, 18), "18.446744073709551615");
    }

    #[test]
    fn amount_parse_rejections() {
        // Empty (also after whitespace trim).
        assert_eq!(parse_decimal_to_units("", 2), Err(AmountError::Empty));
        assert_eq!(parse_decimal_to_units("   ", 2), Err(AmountError::Empty));
        // Not a number.
        assert_eq!(parse_decimal_to_units("abc", 2), Err(AmountError::NotANumber));
        assert_eq!(parse_decimal_to_units("1.2.3", 2), Err(AmountError::NotANumber));
        assert_eq!(parse_decimal_to_units(".", 2), Err(AmountError::NotANumber));
        assert_eq!(parse_decimal_to_units("+5", 2), Err(AmountError::NotANumber));
        // Negative: any leading `-` is Negative (checked before shape), regardless of magnitude.
        assert_eq!(parse_decimal_to_units("-1", 2), Err(AmountError::Negative));
        assert_eq!(parse_decimal_to_units("-0.01", 2), Err(AmountError::Negative));
        assert_eq!(parse_decimal_to_units("-abc", 2), Err(AmountError::Negative));
        // Too many fractional digits.
        assert_eq!(parse_decimal_to_units("1.5", 0), Err(AmountError::TooManyDecimals));
        assert_eq!(
            parse_decimal_to_units("0.1234567890123456789", 18),
            Err(AmountError::TooManyDecimals),
            "19 fractional digits at decimals=18"
        );
        // Overflow: 29 nines ≈ 1e29 ≫ u64::MAX (≈ 1.8e19).
        assert_eq!(
            parse_decimal_to_units("99999999999999999999999999999", 0),
            Err(AmountError::Overflow)
        );
        // decimals beyond MAX_DECIMALS is unsupported in the u64 value space.
        assert_eq!(parse_decimal_to_units("1", 19), Err(AmountError::Overflow));
    }

    #[test]
    fn amount_format_clamps_decimals_above_max() {
        // format never panics on a too-large decimals (it clamps to MAX_DECIMALS, matching the
        // parser's ≤ 18 contract — a non-panicking fallback for malformed input).
        assert_eq!(format_units_to_decimal(8_400_000_000_000_000_000, 255), "8.4");
    }

    #[test]
    fn amount_u64_max_round_trips_at_max_decimals() {
        // The hardest round-trip: every u64 at every d ≤ 18 is covered by the proptest below, but
        // pin u64::MAX at 18 explicitly — it's the boundary that would catch an off-by-one in the
        // scale or the trim.
        let formatted = format_units_to_decimal(u64::MAX, 18);
        assert_eq!(formatted, "18.446744073709551615");
        assert_eq!(parse_decimal_to_units(&formatted, 18), Ok(u64::MAX));
    }

    proptest! {
        /// Round-trip invariant: for every u64 raw and every decimals in 0..=MAX_DECIMALS,
        /// parse(format(raw, d), d) == Ok(raw). This is the load-bearing correctness property of the
        /// parser pair — it must hold across the WHOLE u64 range and every supported precision.
        #[test]
        fn amount_format_parse_round_trip(raw in any::<u64>(), decimals in 0u8..=MAX_DECIMALS) {
            let formatted = format_units_to_decimal(raw, decimals);
            prop_assert_eq!(parse_decimal_to_units(&formatted, decimals), Ok(raw));
        }

        /// parse is left-inverse to format: scaling is exact (no float, no rounding) across the
        /// whole u64 range at every precision. Feeds the human string back through format for a
        /// double round-trip (format(parse(format(raw, d), d), d) == format(raw, d)).
        #[test]
        fn amount_double_round_trip_stable(raw in any::<u64>(), decimals in 0u8..=MAX_DECIMALS) {
            let once = format_units_to_decimal(raw, decimals);
            let back = parse_decimal_to_units(&once, decimals).unwrap();
            let twice = format_units_to_decimal(back, decimals);
            prop_assert_eq!(once, twice);
        }
    }
}
