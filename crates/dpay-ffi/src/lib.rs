//! dpay-ffi — UniFFI wrapper over [`dpay_core`].
//!
//! This crate exposes the **exact** money/protocol logic that the canister, relay, and
//! headless sim link (`dpay-core`) to the phone app's languages. UniFFI generates:
//!   * **Kotlin** — consumed by the React Native Android app (via a Turbo Module, device-gated).
//!   * **Python** — the sandbox's verifiable gate: the roundtrip below runs Python calling the
//!     compiled Rust core, proving "the code Claude tests is the code that signs on the phone."
//!
//! The FFI surface is intentionally thin: no policy or crypto lives here, it only marshals
//! bytes across the boundary and forwards to `dpay_core`. Amounts are integer minor units
//! (cents); the UI only ever renders `$`. `expiry`/`now` are unix seconds.

use dpay_core::{
    generate_keypair as core_generate_keypair, sign, validate as core_validate, Authorization,
    CodecError, PayError, SignedAuthorization, NONCE_LEN, PUBKEY_LEN,
};
use ed25519_dalek::SigningKey;

uniffi::setup_scaffolding!();

/// A signing key + its public key, as raw bytes.
///
/// PoC choice: the 32-byte Ed25519 seed is returned to the caller so the app can persist it in
/// on-device storage and reconstruct the key to sign offline. A production build would keep the
/// secret inside Rust behind an opaque handle backed by the platform keystore / secure element.
#[derive(uniffi::Record, Clone)]
pub struct KeyPair {
    /// 32-byte Ed25519 signing seed (secret). Keep on device only.
    pub secret: Vec<u8>,
    /// 32-byte Ed25519 public key — this is the account's `from`/`to` identity on the ledger.
    pub public: Vec<u8>,
}

/// Errors crossing the FFI boundary. Each maps 1:1 to a `dpay_core` failure so the app can react
/// (bad key length, malformed QR, a rejected authorization) without string-sniffing.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum DpayError {
    #[error("secret key must be exactly {PUBKEY_LEN} bytes")]
    BadSecretLength,
    #[error("public key must be exactly {PUBKEY_LEN} bytes")]
    BadPubkeyLength,
    #[error("nonce must be exactly {NONCE_LEN} bytes")]
    BadNonceLength,
    #[error("base64 QR payload was malformed")]
    BadBase64,
    #[error("wire blob had the wrong length")]
    BadWireLength,
    #[error("the authorization's `from` disagrees with the carried public key")]
    PubkeyMismatch,
}

impl From<CodecError> for DpayError {
    fn from(e: CodecError) -> Self {
        match e {
            CodecError::Base64 => DpayError::BadBase64,
            CodecError::Length => DpayError::BadWireLength,
            CodecError::PubkeyMismatch => DpayError::PubkeyMismatch,
        }
    }
}

/// Human-facing reason a payment was rejected. Mirrors [`dpay_core::PayError`]; returned as a
/// string by [`validate`] so `None` == accepted reads naturally in every target language.
fn pay_error_str(e: PayError) -> String {
    match e {
        PayError::BadSignature => "bad_signature",
        PayError::ZeroAmount => "zero_amount",
        PayError::Expired => "expired",
        PayError::OverCap => "over_cap",
        PayError::InsufficientFunds => "insufficient_funds",
        PayError::NonceReused => "nonce_reused",
    }
    .to_string()
}

fn fixed_pubkey(bytes: &[u8]) -> Result<[u8; PUBKEY_LEN], DpayError> {
    bytes.try_into().map_err(|_| DpayError::BadPubkeyLength)
}

fn fixed_nonce(bytes: &[u8]) -> Result<[u8; NONCE_LEN], DpayError> {
    bytes.try_into().map_err(|_| DpayError::BadNonceLength)
}

fn signing_key_from_seed(secret: &[u8]) -> Result<SigningKey, DpayError> {
    let seed: [u8; 32] = secret.try_into().map_err(|_| DpayError::BadSecretLength)?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Generate a fresh Ed25519 keypair (native OS CSPRNG). Called once per device at onboarding.
#[uniffi::export]
pub fn generate_keypair() -> KeyPair {
    let sk = core_generate_keypair();
    KeyPair {
        secret: sk.to_bytes().to_vec(),
        public: sk.verifying_key().to_bytes().to_vec(),
    }
}

/// Payer side: build `Authorization {from, to, amount, nonce, expiry}` and sign it **offline**,
/// returning the 192-byte wire blob (`signing_bytes | sig | from_pub`) — exactly what the relay
/// hands the canister. `from` is derived from the secret; a mismatched `from` arg is ignored in
/// favour of the key's own public bytes (consent is bound to the real signer).
#[uniffi::export]
pub fn sign_authorization(
    secret: &[u8],
    to: &[u8],
    amount: u64,
    nonce: &[u8],
    expiry: u64,
) -> Result<Vec<u8>, DpayError> {
    let sk = signing_key_from_seed(secret)?;
    let from = sk.verifying_key().to_bytes();
    let to = fixed_pubkey(to)?;
    let nonce = fixed_nonce(nonce)?;
    let auth = Authorization { from, to, amount, nonce, expiry };
    // Build + sign via the core type so we exercise the identical signing path.
    let signed = SignedAuthorization::new(&sk, auth);
    debug_assert_eq!(sign(&sk, &auth).to_bytes(), signed.sig);
    Ok(signed.to_wire().to_vec())
}

/// Encode a wire blob to the compact base64url string carried by the payer's QR.
#[uniffi::export]
pub fn encode_qr(wire: &[u8]) -> Result<String, DpayError> {
    // Round-trips through the core parser so encoding is always over a valid wire object.
    let signed = SignedAuthorization::from_wire(wire)?;
    Ok(signed.encode())
}

/// Decode a scanned QR string back to the 192-byte wire blob.
#[uniffi::export]
pub fn decode_qr(payload: String) -> Result<Vec<u8>, DpayError> {
    let signed = SignedAuthorization::decode(&payload)?;
    Ok(signed.to_wire().to_vec())
}

/// Verify the signature carried in a wire blob (merchant/relay side). Wrong length or a
/// pubkey/`from` mismatch is a hard error; a well-formed blob with a bad signature returns `false`.
#[uniffi::export]
pub fn verify_wire(wire: &[u8]) -> Result<bool, DpayError> {
    let signed = SignedAuthorization::from_wire(wire)?;
    Ok(signed.verify())
}

/// Pure policy check, mirroring the canister's settlement gate. Returns `None` when the payment
/// is acceptable, or `Some(reason)` (e.g. `"expired"`, `"over_cap"`) when it must be rejected.
///
/// `sig_ok` is computed separately (see [`verify_wire`]) and passed in, exactly as the core API.
/// `expiry` is carried explicitly (unix seconds) so callers can exercise the expiry rule; the
/// rejection order matches [`dpay_core::validate`] (bad_sig > zero > expired > cap > funds > nonce).
#[uniffi::export]
pub fn validate(
    amount: u64,
    now: u64,
    expiry: u64,
    cap: u64,
    balance: u64,
    nonce_seen: bool,
    sig_ok: bool,
) -> Option<String> {
    // `validate` only reads `auth.amount` and `auth.expiry`; the identity fields are irrelevant.
    let auth = Authorization {
        from: [0u8; PUBKEY_LEN],
        to: [0u8; PUBKEY_LEN],
        amount,
        nonce: [0u8; NONCE_LEN],
        expiry,
    };
    match core_validate(&auth, now, cap, balance, nonce_seen, sig_ok) {
        Ok(()) => None,
        Err(e) => Some(pay_error_str(e)),
    }
}
