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
/// 32 (from) + 32 (to) + 8 (amount) + 16 (nonce) + 8 (expiry) + 4 (currency)
pub const SIGNING_LEN: usize = 100;
/// signing_bytes(100) + sig(64) + from_pub(32)
pub const WIRE_LEN: usize = SIGNING_LEN + SIG_LEN + PUBKEY_LEN;

/// Currency tag. The merchant's request names the settlement asset; the payer copies it
/// into their authorization. `DEMO_USD` is play money mintable via the faucet (open on
/// mainnet for the demo). Future currencies (ckUSDC, ckBTC, …) get their own tag.
pub type Currency = u32;
pub const DEMO_USD: Currency = 0;

/// An offline-built payment authorization. Amounts are integer minor units (cents); the UI
/// only ever renders `$`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Authorization {
    pub from: [u8; PUBKEY_LEN],
    pub to: [u8; PUBKEY_LEN],
    pub amount: u64,
    pub nonce: [u8; NONCE_LEN],
    pub expiry: u64,
    pub currency: Currency,
}

impl Authorization {
    /// Canonical, deterministic signed message: fixed 100-byte little-endian concat.
    /// Field order is frozen forever: `from | to | amount_le | nonce | expiry_le | currency_le`.
    pub fn signing_bytes(&self) -> [u8; SIGNING_LEN] {
        let mut b = [0u8; SIGNING_LEN];
        b[0..32].copy_from_slice(&self.from);
        b[32..64].copy_from_slice(&self.to);
        b[64..72].copy_from_slice(&self.amount.to_le_bytes());
        b[72..88].copy_from_slice(&self.nonce);
        b[88..96].copy_from_slice(&self.expiry.to_le_bytes());
        b[96..100].copy_from_slice(&self.currency.to_le_bytes());
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

    /// Raw 196-byte wire form: `signing_bytes(100) | sig(64) | from_pub(32)`.
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
        };
        let sig: [u8; SIG_LEN] = raw[100..164].try_into().unwrap();
        let from_pub: [u8; PUBKEY_LEN] = raw[164..196].try_into().unwrap();
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

/// 32 (to) + 8 (amount) + 16 (nonce) + 8 (expiry) + 4 (currency).
pub const REQUEST_LEN: usize = PUBKEY_LEN + 8 + NONCE_LEN + 8 + 4;

/// The **request** the merchant shows the payer, carried by the merchant's QR. Unsigned: it names
/// who to pay (`to`), how much (`amount`), a single-use `nonce` (the merchant's `request_id`, which
/// becomes the ledger nonce), an `expiry`, and the settlement `currency`. The payer scans this,
/// reviews it, and signs an [`Authorization`] that copies these fields verbatim — so the amount,
/// payee, and currency are chosen by the merchant and then *bound* by the payer's signature. There
/// is no `from` (the payer supplies their own) and no signature here.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PaymentRequest {
    pub to: [u8; PUBKEY_LEN],
    pub amount: u64,
    pub nonce: [u8; NONCE_LEN],
    pub expiry: u64,
    pub currency: Currency,
}

impl PaymentRequest {
    /// Raw 68-byte form: `to(32) | amount_le(8) | nonce(16) | expiry_le(8) | currency_le(4)`. Frozen.
    pub fn to_bytes(&self) -> [u8; REQUEST_LEN] {
        let mut b = [0u8; REQUEST_LEN];
        b[0..32].copy_from_slice(&self.to);
        b[32..40].copy_from_slice(&self.amount.to_le_bytes());
        b[40..56].copy_from_slice(&self.nonce);
        b[56..64].copy_from_slice(&self.expiry.to_le_bytes());
        b[64..68].copy_from_slice(&self.currency.to_le_bytes());
        b
    }

    /// Parse the raw 68-byte form. Rejects a wrong length.
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

    /// Turn a scanned request into the payer's [`Authorization`] — the payer supplies `from`, every
    /// other field is copied from the merchant's request (so consent is bound to exactly what was
    /// requested).
    pub fn to_authorization(&self, from: [u8; PUBKEY_LEN]) -> Authorization {
        Authorization { from, to: self.to, amount: self.amount, nonce: self.nonce, expiry: self.expiry, currency: self.currency }
    }
}

/// nonce(16) | status(1).
pub const RECEIPT_LEN: usize = NONCE_LEN + 1;
/// The ledger settled the payment.
pub const RECEIPT_SETTLED: u8 = 0;
/// The ledger refused the payment (insufficient funds, expired, over cap, nonce reused, bad sig).
pub const RECEIPT_REJECTED: u8 = 1;
/// The merchant could not reach the ledger (network/timeout) — outcome unknown, not settled.
pub const RECEIPT_UNREACHABLE: u8 = 2;

/// The settlement outcome the (online) merchant hands back to the (offline) payer so the payer's
/// phone learns whether the payment actually went through — carried over the same NFC tap (or, one
/// day, a receipt QR). It names the `nonce` it answers (so the payer can match it to the exact
/// payment they signed) and a `status`.
///
/// **PoC trust model:** the receipt is *unsigned*. The payer's signature already binds the amount,
/// payee, and single-use nonce, so a merchant can neither overcharge nor double-charge; the only
/// thing an unsigned receipt can't stop is a merchant lying about the outcome, and the incentives
/// don't favour that (claiming "paid" when it wasn't only costs the merchant). A canister-signed
/// receipt (the payer verifying the ledger's key) is the production hardening.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Receipt {
    pub nonce: [u8; NONCE_LEN],
    pub status: u8,
}

impl Receipt {
    /// Raw form: `nonce(16) | status(1)`. Field order frozen.
    pub fn to_bytes(&self) -> [u8; RECEIPT_LEN] {
        let mut b = [0u8; RECEIPT_LEN];
        b[0..NONCE_LEN].copy_from_slice(&self.nonce);
        b[NONCE_LEN] = self.status;
        b
    }

    /// Parse the raw form. Rejects a wrong length.
    pub fn from_bytes(raw: &[u8]) -> Result<Self, CodecError> {
        if raw.len() != RECEIPT_LEN {
            return Err(CodecError::Length);
        }
        Ok(Receipt { nonce: raw[0..NONCE_LEN].try_into().unwrap(), status: raw[NONCE_LEN] })
    }

    /// True when the ledger settled the payment.
    pub fn settled(&self) -> bool {
        self.status == RECEIPT_SETTLED
    }
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
        )
            .prop_map(|(from, to, amount, nonce, expiry, currency)| Authorization {
                from,
                to,
                amount,
                nonce,
                expiry,
                currency: currency as u32,
            })
    }

    proptest! {
        #[test]
        fn sign_verify_and_codec_roundtrip(amount in 1u64.., expiry in 1u64.., nonce in any::<[u8;16]>()) {
            let sk = generate_keypair();
            let from = sk.verifying_key().to_bytes();
            let auth = Authorization { from, to: [7u8; 32], amount, nonce, expiry, currency: DEMO_USD };
            let sig = sign(&sk, &auth);
            prop_assert!(verify(&from, &auth, &sig));

            let se = SignedAuthorization::new(&sk, auth);
            let wire = se.encode();
            prop_assert_eq!(wire.len(), 262); // 196 bytes -> 262 base64url chars (no pad)
            let back = SignedAuthorization::decode(&wire).unwrap();
            prop_assert_eq!(back, se);
            prop_assert!(back.verify());
        }

        #[test]
        fn request_codec_roundtrip_and_binds(
            amount in 1u64.., expiry in 1u64.., nonce in any::<[u8;16]>(),
            to in any::<[u8;32]>(), from in any::<[u8;32]>(),
        ) {
            let req = PaymentRequest { to, amount, nonce, expiry, currency: DEMO_USD };
            let s = req.encode();
            prop_assert_eq!(s.len(), 91); // 68 bytes -> 91 base64url chars (no pad)
            prop_assert_eq!(PaymentRequest::decode(&s).unwrap(), req);
            // What the payer signs copies the merchant's request verbatim (only `from` is the payer's).
            let auth = req.to_authorization(from);
            prop_assert_eq!(auth.to, to);
            prop_assert_eq!(auth.amount, amount);
            prop_assert_eq!(auth.nonce, nonce);
            prop_assert_eq!(auth.expiry, expiry);
            prop_assert_eq!(auth.from, from);
            prop_assert_eq!(auth.currency, DEMO_USD);
        }

        #[test]
        fn tamper_breaks_verify(idx in 0usize..SIGNING_LEN, xor in 1u8..=255) {
            let sk = generate_keypair();
            let from = sk.verifying_key().to_bytes();
            let auth = Authorization { from, to: [1u8; 32], amount: 100, nonce: [9u8; 16], expiry: 9999, currency: DEMO_USD };
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
            let a = Authorization { from: [0;32], to: [0;32], amount, nonce: [0;16], expiry, currency: DEMO_USD };
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
                let auth = Authorization { from, to, amount, nonce, expiry: u64::MAX, currency: DEMO_USD };
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
}
