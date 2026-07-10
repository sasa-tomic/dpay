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
    CodecError, PayError, PaymentRequest, SignedAuthorization, NONCE_LEN, PUBKEY_LEN,
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
    // --- NFC transport (see `dpay_core::nfc`) ---
    #[error("nfc: a command/call was issued in a state that doesn't allow it")]
    NfcWrongState,
    #[error("nfc: the tapped card is not a dpay card")]
    NfcNotDpay,
    #[error("nfc: framing or protocol violation (malformed/oversized/out-of-sequence)")]
    NfcProtocol,
}

impl From<dpay_core::nfc::NfcError> for DpayError {
    fn from(e: dpay_core::nfc::NfcError) -> Self {
        use dpay_core::nfc::NfcError as N;
        match e {
            N::WrongState => DpayError::NfcWrongState,
            N::NotDpay => DpayError::NfcNotDpay,
            // Every framing / APDU / status / version fault is a protocol violation from the app's
            // point of view: abort this tap and (for the merchant) re-tap or fall back to QR.
            N::Apdu(_)
            | N::Frame(_)
            | N::UnsupportedVersion(_)
            | N::UnexpectedStatus(_)
            | N::ShortGreeting => DpayError::NfcProtocol,
        }
    }
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

/// The merchant's request, as scanned by the payer. Mirrors [`dpay_core::PaymentRequest`]: who to
/// pay, how much (minor units), the single-use `nonce` (the merchant's request_id → ledger nonce),
/// and an `expiry` (unix seconds).
#[derive(uniffi::Record, Clone)]
pub struct PaymentRequestData {
    pub to: Vec<u8>,
    pub amount: u64,
    pub nonce: Vec<u8>,
    pub expiry: u64,
}

/// Merchant side: encode the request the payer will scan. `nonce` is the merchant's single-use
/// request_id (it becomes the ledger nonce, so the payment can't be replayed or double-charged).
#[uniffi::export]
pub fn encode_request(
    to: &[u8],
    amount: u64,
    nonce: &[u8],
    expiry: u64,
) -> Result<String, DpayError> {
    let to = fixed_pubkey(to)?;
    let nonce = fixed_nonce(nonce)?;
    Ok(PaymentRequest { to, amount, nonce, expiry }.encode())
}

/// Payer side: decode a scanned merchant request QR into its fields, so the app can show
/// "Pay $X to <merchant>" for the payer to approve before signing.
#[uniffi::export]
pub fn decode_request(qr: String) -> Result<PaymentRequestData, DpayError> {
    let req = PaymentRequest::decode(&qr)?;
    Ok(PaymentRequestData {
        to: req.to.to_vec(),
        amount: req.amount,
        nonce: req.nonce.to_vec(),
        expiry: req.expiry,
    })
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

// =============================================================================================
// NFC transport (ISO 7816-4 / HCE) — stateful wrappers over `dpay_core::nfc`.
//
// These expose the *exact* compiled framing state machines to the app's languages, so the Android
// HCE service (payer) and NFC reader (merchant) are thin loops over the same code Claude tests. The
// core is pure and single-threaded per session; UniFFI requires exported objects be `Send + Sync`,
// so each wraps its session in a `Mutex`. The core never panics, so the lock is never poisoned —
// but we recover from poison anyway rather than propagate a panic across the FFI.
// =============================================================================================

use dpay_core::nfc::{self, CardSession, ReaderConductor, ReaderStep};
use std::sync::{Arc, Mutex, MutexGuard};

/// What the merchant reader should do after feeding a card response — a flat enum (no associated
/// data) so it maps cleanly to every target language. When `Done`, pull the wire via
/// [`FfiReaderConductor::wire`].
#[derive(Clone, Copy, PartialEq, Eq, Debug, uniffi::Enum)]
pub enum NfcStep {
    /// Send the next command from `next_command`.
    Continue,
    /// The payer is still deciding — keep polling / re-tap (`next_command` re-SELECTs).
    Pending,
    /// The signed wire is ready; fetch it with `wire()`, then verify + submit.
    Done,
    /// The payer declined; abandon the sale.
    Declined,
}

/// Lock helper that tolerates a poisoned mutex (can only happen if a panic ever unwound while the
/// lock was held; the pure core never does, so this is belt-and-suspenders).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The **payer** side (Android HCE `HostApduService`). Hold one per tap; feed it each command APDU
/// and return the bytes it produces. Then read [`request`](Self::request), show "Pay $X to …", and
/// call [`provide_wire`](Self::provide_wire) (approve) or [`decline`](Self::decline).
#[derive(uniffi::Object)]
pub struct FfiCardSession {
    inner: Mutex<CardSession>,
}

#[uniffi::export]
impl FfiCardSession {
    /// `max_chunk` is the max dpay-payload bytes per APDU frame; pass
    /// [`nfc_default_max_chunk`]'s value in production.
    #[uniffi::constructor]
    pub fn new(max_chunk: u32) -> Arc<Self> {
        Arc::new(FfiCardSession { inner: Mutex::new(CardSession::new(max_chunk as usize)) })
    }

    /// Process one command APDU; returns the response APDU bytes. Total function — never throws.
    pub fn process(&self, command: Vec<u8>) -> Vec<u8> {
        lock(&self.inner).process(&command)
    }

    /// The full received request bytes, once collected (decode with [`decode_request`] shifted — see
    /// [`nfc_decode_request`]), or `None` while still collecting.
    pub fn request(&self) -> Option<Vec<u8>> {
        lock(&self.inner).request().map(|r| r.to_vec())
    }

    /// True exactly when the app must approve or decline (a request is held, no decision yet).
    pub fn awaiting_decision(&self) -> bool {
        lock(&self.inner).awaiting_decision()
    }

    /// Approve: supply the offline-signed 192-byte wire to serve. Errors (`NfcWrongState`) unless a
    /// request is held and no decision has been made; the wire is validated as it is framed.
    pub fn provide_wire(&self, wire: Vec<u8>) -> Result<(), DpayError> {
        Ok(lock(&self.inner).provide_wire(&wire)?)
    }

    /// Decline: the payer rejected the payment. Every subsequent pull returns DECLINED.
    pub fn decline(&self) -> Result<(), DpayError> {
        Ok(lock(&self.inner).decline()?)
    }
}

/// The **merchant** side (NFC reader). Loop: `while let Some(cmd) = c.next_command() { step =
/// c.handle_response(transceive(cmd)); ... }`; on `Done`, read [`wire`](Self::wire), verify, submit.
#[derive(uniffi::Object)]
pub struct FfiReaderConductor {
    inner: Mutex<ReaderConductor>,
    wire: Mutex<Option<Vec<u8>>>,
}

#[uniffi::export]
impl FfiReaderConductor {
    /// `request` is the merchant's 64-byte [`PaymentRequest`] wire (see [`nfc_request_bytes`]).
    /// Errors (`NfcProtocol`) if the request can't be framed.
    #[uniffi::constructor]
    pub fn new(request: Vec<u8>, max_chunk: u32) -> Result<Arc<Self>, DpayError> {
        let inner = ReaderConductor::new(&request, max_chunk as usize)?;
        Ok(Arc::new(FfiReaderConductor { inner: Mutex::new(inner), wire: Mutex::new(None) }))
    }

    /// The next command APDU to transceive, or `None` once the exchange is terminal.
    pub fn next_command(&self) -> Option<Vec<u8>> {
        lock(&self.inner).next_command()
    }

    /// Feed the response to the last command; advance the state machine. On `Done` the wire is
    /// captured (fetch via [`wire`](Self::wire)). Errors on a malformed/unexpected response.
    pub fn handle_response(&self, response: Vec<u8>) -> Result<NfcStep, DpayError> {
        match lock(&self.inner).handle_response(&response)? {
            ReaderStep::Continue => Ok(NfcStep::Continue),
            ReaderStep::Pending => Ok(NfcStep::Pending),
            ReaderStep::Declined => Ok(NfcStep::Declined),
            ReaderStep::Done(w) => {
                *lock(&self.wire) = Some(w);
                Ok(NfcStep::Done)
            }
        }
    }

    /// The reassembled 192-byte wire once the exchange reached `Done`, else `None`.
    pub fn wire(&self) -> Option<Vec<u8>> {
        lock(&self.wire).clone()
    }
}

/// The recommended per-frame max payload (bytes) — pass to the session/conductor constructors.
#[uniffi::export]
pub fn nfc_default_max_chunk() -> u32 {
    nfc::DEFAULT_MAX_CHUNK as u32
}

/// Merchant side: the raw 64-byte request wire the reader will push over NFC (the same bytes the
/// request QR base64-encodes). Mirrors [`encode_request`] but returns the bytes NFC transports.
#[uniffi::export]
pub fn nfc_request_bytes(
    to: &[u8],
    amount: u64,
    nonce: &[u8],
    expiry: u64,
) -> Result<Vec<u8>, DpayError> {
    let to = fixed_pubkey(to)?;
    let nonce = fixed_nonce(nonce)?;
    Ok(PaymentRequest { to, amount, nonce, expiry }.to_bytes().to_vec())
}

/// Payer side: decode the request bytes the card reassembled back into its fields, to show
/// "Pay $X to <merchant>" before approving. Length-guarded (`NfcProtocol` on a bad length).
#[uniffi::export]
pub fn nfc_decode_request(bytes: &[u8]) -> Result<PaymentRequestData, DpayError> {
    let req = nfc::request_from_transport(bytes)?;
    Ok(PaymentRequestData {
        to: req.to.to_vec(),
        amount: req.amount,
        nonce: req.nonce.to_vec(),
        expiry: req.expiry,
    })
}
