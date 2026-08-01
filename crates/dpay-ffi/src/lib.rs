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
    CodecError, Currency, DEMO_USD, MEMO_LEN, NAME_LEN, PayError, PaymentRequest, ReceiptClaim,
    SignedAuthorization, WithdrawAuth, NONCE_LEN, PUBKEY_LEN, REQUEST_LEN, SIG_LEN, SIGNING_LEN,
    WIRE_LEN,
};
use ed25519_dalek::SigningKey;

/// Encode a display-name / memo `&str` into the fixed-width wire field: UTF-8 bytes, truncated to
/// `NAME_LEN` (== `MEMO_LEN` == 32), trailing-NUL (0x00) padded. This is the defined builder
/// behavior (see `wire-names-memo.md` §"No silent errors"): the 32 B cap is enforced here, not in
/// the core. A Rust `String` is always valid UTF-8, so no decode error is possible. Mirrors the
/// web shim's `padName32` (`e2e/web/dpay-core.ts`) byte-for-byte — the two signing paths stay
/// feature-equivalent (both carry names; neither signs a nameless payment).
fn name_field(s: &str) -> [u8; NAME_LEN] {
    let mut b = [0u8; NAME_LEN];
    let bytes = s.as_bytes();
    let n = bytes.len().min(NAME_LEN);
    b[..n].copy_from_slice(&bytes[..n]);
    b
}

/// Inverse of [`name_field`]: NUL-trim + lossy-UTF-8 decode a 32-byte field back to a `String`.
/// Never throws (lossy → U+FFFD on a bad byte sequence), mirroring the web shim's `trimName32`. The
/// app shows this string in "Pay $X to <to_name>" and history rows.
fn decode_name_field(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

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
    #[error("{0}")]
    BadInput(String),
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

/// The frozen wire-format byte lengths, single-sourced from `dpay_core`. The app derives its self-check
/// expected hex length from [`wire_len`] so no magic literal can rot when the wire resizes. Exposed as
/// `u64` because UniFFI has no `usize`; values are tiny (292/196/132) and stay well under 2^53 in JS.
#[uniffi::export]
pub fn wire_len() -> u64 {
    WIRE_LEN as u64
}

/// The signed-region length (196 B): `from | to | amount | nonce | expiry | currency | names | memo`.
#[uniffi::export]
pub fn signing_len() -> u64 {
    SIGNING_LEN as u64
}

/// The merchant request length (132 B): `to | amount | nonce | expiry | currency | to_name | memo`.
#[uniffi::export]
pub fn request_len() -> u64 {
    REQUEST_LEN as u64
}

/// Payer side: build `Authorization {from, to, amount, nonce, expiry, currency, from_name,
/// to_name, memo}` and sign it **offline**, returning the 292-byte wire blob (`signing_bytes |
/// sig | from_pub`) — exactly what the relay hands the canister. `from` is derived from the secret;
/// a mismatched `from` arg is ignored in favour of the key's own public bytes (consent is bound to
/// the real signer). `currency` (`Currency` = `u32`) is the settlement asset the payer authorizes;
/// `DEMO_USD = 0`. The currency field is encoded as 4 little-endian bytes inside the signing region,
/// so it is covered by the Ed25519 signature.
///
/// `from_name` is the payer's own display name; `to_name` + `memo` are copied verbatim from the
/// scanned merchant request (merchant-defined). All three ride inside the signed bytes (positions
/// 100..196) so transaction history is self-describing on both sides — the payee sees the payer's
/// name, not a raw pubkey. Each is UTF-8, NUL-padded, and truncated to 32 bytes by [`name_field`].
/// The param order matches the web shim's `signAuthorization(secretHex, toHex, amount, nonceHex,
/// expiry, currency, fromName, toName, memo)` so the app's unified `DpayCoreApi` type is
/// interchangeable across the native and web signing paths.
#[uniffi::export]
pub fn sign_authorization(
    secret: &[u8],
    to: &[u8],
    amount: u64,
    nonce: &[u8],
    expiry: u64,
    currency: Currency,
    from_name: String,
    to_name: String,
    memo: String,
) -> Result<Vec<u8>, DpayError> {
    let sk = signing_key_from_seed(secret)?;
    let from = sk.verifying_key().to_bytes();
    let to = fixed_pubkey(to)?;
    let nonce = fixed_nonce(nonce)?;
    let auth = Authorization {
        from,
        to,
        amount,
        nonce,
        expiry,
        currency,
        from_name: name_field(&from_name),
        to_name: name_field(&to_name),
        memo: name_field(&memo),
    };
    // Build + sign via the core type so we exercise the identical signing path.
    let signed = SignedAuthorization::new(&sk, auth);
    debug_assert_eq!(sign(&sk, &auth).to_bytes(), signed.sig);
    Ok(signed.to_wire().to_vec())
}

/// The merchant's request, as scanned by the payer. Mirrors [`dpay_core::PaymentRequest`]: who to
/// pay, how much (minor units), the single-use `nonce` (the merchant's request_id → ledger nonce),
/// an `expiry`, the payee's display name (`to_name`), and an optional `memo` — both decoded back
/// from their 32-byte NUL-padded wire fields to `String` by [`decode_name_field`].
#[derive(uniffi::Record, Clone)]
pub struct PaymentRequestData {
    pub to: Vec<u8>,
    pub amount: u64,
    pub nonce: Vec<u8>,
    pub expiry: u64,
    pub currency: u32,
    /// The payee's display name (NUL-trimmed, lossy-decoded from the 32-byte wire field).
    pub to_name: String,
    /// The merchant-set memo (NUL-trimmed, lossy-decoded from the 32-byte wire field).
    pub memo: String,
}

/// Merchant side: encode the request the payer will scan. `nonce` is the merchant's single-use
/// request_id (it becomes the ledger nonce, so the payment can't be replayed or double-charged).
/// `to_name` is the merchant's own display name and `memo` is an optional merchant-set note; both
/// are UTF-8 NUL-padded into the 132-byte request by [`name_field`] and copied verbatim by the payer
/// into their authorization. Param order matches the web shim's `encodeRequest(toHex, amount,
/// nonceHex, expiry, currency, toName, memo)`.
#[uniffi::export]
pub fn encode_request(
    to: &[u8],
    amount: u64,
    nonce: &[u8],
    expiry: u64,
    currency: Currency,
    to_name: String,
    memo: String,
) -> Result<String, DpayError> {
    let to = fixed_pubkey(to)?;
    let nonce = fixed_nonce(nonce)?;
    Ok(PaymentRequest {
        to,
        amount,
        nonce,
        expiry,
        currency,
        to_name: name_field(&to_name),
        memo: name_field(&memo),
    }
    .encode())
}

/// Payer side: decode a scanned merchant request QR into its fields, so the app can show
/// "Pay $X to <to_name>" (with the memo) for the payer to approve before signing.
#[uniffi::export]
pub fn decode_request(qr: String) -> Result<PaymentRequestData, DpayError> {
    let req = PaymentRequest::decode(&qr)?;
    Ok(PaymentRequestData {
        to: req.to.to_vec(),
        amount: req.amount,
        nonce: req.nonce.to_vec(),
        expiry: req.expiry,
        currency: req.currency,
        to_name: decode_name_field(&req.to_name),
        memo: decode_name_field(&req.memo),
    })
}

/// Encode a wire blob to the compact base64url string carried by the payer's QR.
#[uniffi::export]
pub fn encode_qr(wire: &[u8]) -> Result<String, DpayError> {
    // Round-trips through the core parser so encoding is always over a valid wire object.
    let signed = SignedAuthorization::from_wire(wire)?;
    Ok(signed.encode())
}

/// Decode a scanned QR string back to the 292-byte wire blob.
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

/// Payer side: build a `WithdrawAuth {from_pubkey, destination, amount, nonce, expiry, currency}` and
/// sign it **offline**, returning the 64-byte Ed25519 signature. This is the non-custodial withdrawal
/// gate: the facade verifies this signature under `from_pubkey` (== the ckBTC debit subaccount)
/// before moving any funds. `from_pubkey` is derived from the secret; a mismatched arg is ignored in
/// favour of the key's own public bytes. The canonical signing bytes come from `dpay_core` (single
/// source of truth), so this is the exact signature the canister/relay verify.
#[uniffi::export]
pub fn sign_withdrawal(
    secret: &[u8],
    btc_address: String,
    amount: u64,
    nonce: &[u8],
    expiry: u64,
    currency: Currency,
) -> Result<Vec<u8>, DpayError> {
    let sk = signing_key_from_seed(secret)?;
    let from = sk.verifying_key().to_bytes();
    let nonce = fixed_nonce(nonce)?;
    let auth = WithdrawAuth { from_pubkey: from, destination: btc_address, amount, nonce, expiry, currency };
    Ok(dpay_core::sign_withdraw(&sk, &auth).to_bytes().to_vec())
}

/// Verify a canister/ledger-signed receipt signature (R2 outcome attestation). Returns `true` iff
/// `receipt_sig` (64 bytes) is a valid Ed25519 signature over the canonical `ReceiptClaim` built
/// from the claim fields, under the 32-byte receipt `pubkey`. The app calls this before showing
/// "Paid ✓" so the outcome rests on a canister/ledger-authenticated signature, not merchant/relay
/// honesty. Mirrors `dpay_core::verify_receipt` (strict verify, rejects weak keys).
#[uniffi::export]
pub fn verify_receipt_sig(
    nonce: &[u8],
    from: &[u8],
    to: &[u8],
    amount: u64,
    currency: u32,
    block_index: u64,
    settle_ts: u64,
    receipt_sig: &[u8],
    pubkey: &[u8],
) -> Result<bool, DpayError> {
    let n: [u8; NONCE_LEN] = nonce
        .as_ref()
        .try_into()
        .map_err(|_| DpayError::BadInput("nonce must be 16 bytes".into()))?;
    let f: [u8; PUBKEY_LEN] = from
        .as_ref()
        .try_into()
        .map_err(|_| DpayError::BadInput("from must be 32 bytes".into()))?;
    let t: [u8; PUBKEY_LEN] = to
        .as_ref()
        .try_into()
        .map_err(|_| DpayError::BadInput("to must be 32 bytes".into()))?;
    let pk: [u8; PUBKEY_LEN] = pubkey
        .as_ref()
        .try_into()
        .map_err(|_| DpayError::BadInput("pubkey must be 32 bytes".into()))?;
    let sg: [u8; SIG_LEN] = receipt_sig
        .as_ref()
        .try_into()
        .map_err(|_| DpayError::BadInput("receipt_sig must be 64 bytes".into()))?;
    let claim = ReceiptClaim { nonce: n, from: f, to: t, amount, currency, block_index, settle_ts };
    Ok(dpay_core::verify_receipt(&pk, &claim, &sg))
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
    // `validate` only reads `auth.amount` and `auth.expiry`; the identity and name fields are
    // irrelevant. (Currency is also unchecked — validate is currency-agnostic — but the struct needs
    // every field.) The name/memo fields are zeroed ([0u8; NAME_LEN] / [0u8; MEMO_LEN]) — they are
    // never serialized by `validate`, which reads `auth.amount`/`auth.expiry` by field, not by wire.
    let auth = Authorization {
        from: [0u8; PUBKEY_LEN],
        to: [0u8; PUBKEY_LEN],
        amount,
        nonce: [0u8; NONCE_LEN],
        expiry,
        currency: DEMO_USD,
        from_name: [0u8; NAME_LEN],
        to_name: [0u8; NAME_LEN],
        memo: [0u8; MEMO_LEN],
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

use dpay_core::nfc::{self, CardSession, ReaderConductor, ReaderStep, SessionPhase};
use std::sync::{Arc, Mutex, MutexGuard};

/// Lifecycle phase of a tap, for a live UI status indicator. Mirrors [`dpay_core::nfc::SessionPhase`]
/// (lifecycle only — failures surface as thrown `DpayError`s / a platform tag-loss, never as a
/// phase). The app renders a spinner on `Linking`/`Exchanging`, a review prompt on
/// `AwaitingApproval`, and a terminal mark on `Complete` / `Declined`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, uniffi::Enum)]
pub enum NfcPhase {
    Idle,
    Linking,
    Exchanging,
    AwaitingApproval,
    /// The wire was transferred; the merchant is settling online and the payer awaits the receipt.
    Settling,
    Complete,
    Declined,
}

impl From<SessionPhase> for NfcPhase {
    fn from(p: SessionPhase) -> Self {
        match p {
            SessionPhase::Idle => NfcPhase::Idle,
            SessionPhase::Linking => NfcPhase::Linking,
            SessionPhase::Exchanging => NfcPhase::Exchanging,
            SessionPhase::AwaitingApproval => NfcPhase::AwaitingApproval,
            SessionPhase::Settling => NfcPhase::Settling,
            SessionPhase::Complete => NfcPhase::Complete,
            SessionPhase::Declined => NfcPhase::Declined,
        }
    }
}

/// What the merchant reader should do after feeding a card response — a flat enum (no associated
/// data) so it maps cleanly to every target language. When `Done`, pull the wire via
/// [`FfiReaderConductor::wire`].
#[derive(Clone, Copy, PartialEq, Eq, Debug, uniffi::Enum)]
pub enum NfcStep {
    /// Send the next command from `next_command`.
    Continue,
    /// The payer is still deciding — keep polling / re-tap (`next_command` re-SELECTs).
    Pending,
    /// The signed wire is ready; fetch it with `wire()`, then verify + submit online. Afterwards
    /// call `provideReceipt` to hand the outcome back to the payer over the same tap.
    Done,
    /// The settlement receipt was delivered to the payer — the tap is fully complete.
    Confirmed,
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

    /// Lifecycle phase for the payer-side status UI.
    pub fn phase(&self) -> NfcPhase {
        lock(&self.inner).phase().into()
    }

    /// True once the merchant has pulled the entire signed wire (the wire has left the phone).
    pub fn is_complete(&self) -> bool {
        lock(&self.inner).is_complete()
    }

    /// The merchant's settlement receipt bytes once it arrives over the tap (decode with
    /// [`nfc_decode_receipt`]) — how the *offline* payer learns whether the payment settled. `None`
    /// until it arrives.
    pub fn receipt(&self) -> Option<Vec<u8>> {
        lock(&self.inner).receipt().map(|r| r.to_vec())
    }

    /// True once the receipt has arrived (the tap is fully complete).
    pub fn is_confirmed(&self) -> bool {
        lock(&self.inner).is_confirmed()
    }

    /// Approve: supply the offline-signed 292-byte wire to serve. Errors (`NfcWrongState`) unless a
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
    /// `request` is the merchant's 132-byte [`PaymentRequest`] wire (see [`nfc_request_bytes`]).
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

    /// Lifecycle phase for the merchant-side status UI. (`AwaitingApproval` is surfaced via a
    /// `Pending` step from `handle_response`, not this accessor — see `NfcStep`.)
    pub fn phase(&self) -> NfcPhase {
        lock(&self.inner).phase().into()
    }

    /// Feed the response to the last command; advance the state machine. On `Done` the wire is
    /// captured (fetch via [`wire`](Self::wire)). Errors on a malformed/unexpected response.
    pub fn handle_response(&self, response: Vec<u8>) -> Result<NfcStep, DpayError> {
        match lock(&self.inner).handle_response(&response)? {
            ReaderStep::Continue => Ok(NfcStep::Continue),
            ReaderStep::Pending => Ok(NfcStep::Pending),
            ReaderStep::Declined => Ok(NfcStep::Declined),
            ReaderStep::Confirmed => Ok(NfcStep::Confirmed),
            ReaderStep::Done(w) => {
                *lock(&self.wire) = Some(w);
                Ok(NfcStep::Done)
            }
        }
    }

    /// The reassembled 292-byte wire once the exchange reached `Done`, else `None`.
    pub fn wire(&self) -> Option<Vec<u8>> {
        lock(&self.wire).clone()
    }

    /// After `Done` and settling online, hand back the settlement receipt (build it with
    /// [`nfc_receipt_bytes`]) so the offline payer learns the outcome. Then resume the loop:
    /// `next_command` yields the receipt push, ending in a `Confirmed` step.
    pub fn provide_receipt(&self, receipt: Vec<u8>) -> Result<(), DpayError> {
        Ok(lock(&self.inner).provide_receipt(&receipt)?)
    }
}

/// The recommended per-frame max payload (bytes) — pass to the session/conductor constructors.
#[uniffi::export]
pub fn nfc_default_max_chunk() -> u32 {
    nfc::DEFAULT_MAX_CHUNK as u32
}

/// Merchant side: the raw 132-byte request wire the reader will push over NFC (the same bytes the
/// request QR base64-encodes). Mirrors [`encode_request`] but returns the bytes NFC transports.
/// `to_name` + `memo` are threaded into the request so the payer (reviewing "Pay $X to <to_name>")
/// and the signed authorization carry them — same param order as [`encode_request`] and the web shim.
#[uniffi::export]
pub fn nfc_request_bytes(
    to: &[u8],
    amount: u64,
    nonce: &[u8],
    expiry: u64,
    currency: Currency,
    to_name: String,
    memo: String,
) -> Result<Vec<u8>, DpayError> {
    let to = fixed_pubkey(to)?;
    let nonce = fixed_nonce(nonce)?;
    Ok(PaymentRequest {
        to,
        amount,
        nonce,
        expiry,
        currency,
        to_name: name_field(&to_name),
        memo: name_field(&memo),
    }
    .to_bytes()
    .to_vec())
}

/// Payer side: decode the request bytes the card reassembled back into its fields, to show
/// "Pay $X to <to_name>" (with the memo) before approving. Length-guarded (`NfcProtocol` on a bad
/// length). The names are NUL-trimmed + lossy-decoded by [`decode_name_field`].
#[uniffi::export]
pub fn nfc_decode_request(bytes: &[u8]) -> Result<PaymentRequestData, DpayError> {
    let req = nfc::request_from_transport(bytes)?;
    Ok(PaymentRequestData {
        to: req.to.to_vec(),
        amount: req.amount,
        nonce: req.nonce.to_vec(),
        expiry: req.expiry,
        currency: req.currency,
        to_name: decode_name_field(&req.to_name),
        memo: decode_name_field(&req.memo),
    })
}

/// A settlement receipt as fields. `status`: 0 = settled, 1 = the ledger rejected it, 2 = the
/// merchant couldn't reach the ledger (see [`nfc_receipt_codes`]); `settled` == (status == 0).
#[derive(uniffi::Record, Clone)]
pub struct ReceiptData {
    pub nonce: Vec<u8>,
    pub status: u8,
    pub settled: bool,
}

/// The receipt status codes from the core, so callers don't hard-code them.
#[derive(uniffi::Record, Clone)]
pub struct ReceiptCodes {
    pub settled: u8,
    pub rejected: u8,
    pub unreachable: u8,
}

#[uniffi::export]
pub fn nfc_receipt_codes() -> ReceiptCodes {
    ReceiptCodes {
        settled: dpay_core::RECEIPT_SETTLED,
        rejected: dpay_core::RECEIPT_REJECTED,
        unreachable: dpay_core::RECEIPT_UNREACHABLE,
    }
}

/// Merchant side: build the settlement receipt to hand back to the payer over the tap after settling
/// online. `nonce` is the payment's nonce (so the payer can match it); `status` per [`nfc_receipt_codes`].
#[uniffi::export]
pub fn nfc_receipt_bytes(nonce: &[u8], status: u8) -> Result<Vec<u8>, DpayError> {
    let nonce = fixed_nonce(nonce)?;
    Ok(dpay_core::Receipt { nonce, status }.to_bytes().to_vec())
}

/// Payer side: decode the receipt the card received, so the offline payer shows the outcome and can
/// confirm it matches the payment they signed (by nonce). Length-guarded.
#[uniffi::export]
pub fn nfc_decode_receipt(bytes: &[u8]) -> Result<ReceiptData, DpayError> {
    let r = nfc::receipt_from_transport(bytes)?;
    Ok(ReceiptData { nonce: r.nonce.to_vec(), status: r.status, settled: r.settled() })
}

// =============================================================================================
// Tests — prove the FFI signing path carries the display names + memo end-to-end and that the
// produced wire decodes via the core codec with names intact (the two signing paths — native FFI
// and web TS shim — must stay feature-equivalent; neither signs a nameless payment).
// =============================================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use dpay_core::{WIRE_LEN, REQUEST_LEN, SIGNING_LEN};

    /// The exported length accessors must agree with the core consts (single source of truth), and a
    /// signed authorization wire must be exactly `wire_len()` bytes. Guards the App.tsx self-check,
    /// which derives its expected hex length from `wireLen()` — a resize that isn't mirrored here breaks
    /// this test before it can rot the self-check.
    #[test]
    fn wire_len_accessors_match_core_and_signed_wire() {
        assert_eq!(wire_len(), WIRE_LEN as u64);
        assert_eq!(signing_len(), SIGNING_LEN as u64);
        assert_eq!(request_len(), REQUEST_LEN as u64);
        let sk = test_key();
        let wire = sign_authorization(
            &sk.to_bytes(),
            &test_to(),
            1499,
            &test_nonce(),
            2_000_000_000,
            0,
            "Alice".to_string(),
            "Bob".to_string(),
            "coffee".to_string(),
        )
        .expect("sign_authorization succeeds");
        assert_eq!(wire.len(), wire_len() as usize);
    }

    /// A deterministic signing key from a fixed seed (no RNG needed; stable golden).
    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[0x42; 32])
    }

    fn test_to() -> [u8; PUBKEY_LEN] {
        [0xab; PUBKEY_LEN]
    }

    fn test_nonce() -> [u8; NONCE_LEN] {
        let mut n = [0u8; NONCE_LEN];
        for (i, b) in n.iter_mut().enumerate() {
            *b = i as u8;
        }
        n
    }

    /// `name_field` NUL-pads short strings and truncates at NAME_LEN (32). Mirrors the web shim's
    /// `padName32` so the two signing paths produce identical name bytes.
    #[test]
    fn name_field_pads_and_truncates() {
        let short = name_field("Alice");
        assert_eq!(&short[0..5], b"Alice");
        assert_eq!(&short[5..], &[0u8; 27]); // trailing NUL-pad

        let empty = name_field("");
        assert_eq!(empty, [0u8; NAME_LEN]);

        // Exactly 32 bytes: no NUL padding, no truncation.
        let full = name_field(std::str::from_utf8(&[b'x'; 32]).unwrap());
        assert_eq!(full, [b'x'; NAME_LEN]);

        // Over 32 bytes: truncated to NAME_LEN (defined cap, not a silent error).
        let over = name_field(std::str::from_utf8(&[b'y'; 40]).unwrap());
        assert_eq!(over, [b'y'; NAME_LEN]);
    }

    /// `decode_name_field` is the inverse of `name_field` (NUL-trim + lossy UTF-8).
    #[test]
    fn decode_name_field_round_trips() {
        assert_eq!(decode_name_field(&name_field("Alice")), "Alice");
        assert_eq!(decode_name_field(&name_field("")), "");
        assert_eq!(decode_name_field(&name_field("coffee")), "coffee");
        // A field with no NUL terminator decodes in full.
        let no_nul = [b'z'; NAME_LEN];
        assert_eq!(decode_name_field(&no_nul), std::str::from_utf8(&[b'z'; NAME_LEN]).unwrap());
    }

    /// The FFI `sign_authorization` with real ASCII names produces a 292-byte wire whose signing
    /// region carries the names NUL-padded, and which the core `SignedAuthorization::from_wire`
    /// decodes with the names intact and a still-verifying signature. This is the native-path
    /// analogue of `e2e/tests/00-cross-val.mjs` for the web shim — proving the two paths agree.
    #[test]
    fn sign_authorization_carries_names_round_trip() {
        let sk = test_key();
        let from = sk.verifying_key().to_bytes();
        let wire = sign_authorization(
            &sk.to_bytes(),
            &test_to(),
            1499,
            &test_nonce(),
            2_000_000_000,
            0,
            "Alice".to_string(),
            "Bob".to_string(),
            "coffee".to_string(),
        )
        .expect("sign_authorization with names succeeds");

        // Wire length is the v2 292 bytes (single source of truth = core const).
        assert_eq!(wire.len(), WIRE_LEN);

        // The core codec decodes it — names intact, signature still valid.
        let signed = SignedAuthorization::from_wire(&wire).expect("core decodes the FFI wire");
        assert_eq!(signed.auth.from, from);
        assert_eq!(signed.auth.to, test_to());
        assert_eq!(signed.auth.amount, 1499);
        assert_eq!(signed.auth.nonce, test_nonce());
        assert_eq!(signed.from_pub, from); // sanity: the wire carries the payer's pubkey
        assert!(signed.verify(), "signature still verifies after round-trip");

        // Names ride inside the signed bytes, NUL-padded to 32.
        assert_eq!(decode_name_field(&signed.auth.from_name), "Alice");
        assert_eq!(decode_name_field(&signed.auth.to_name), "Bob");
        assert_eq!(decode_name_field(&signed.auth.memo), "coffee");
        // Raw bytes are NUL-padded (proof they are exactly 32 B, fixed-width).
        assert_eq!(&signed.auth.from_name[0..5], b"Alice");
        assert_eq!(signed.auth.from_name[5], 0);
    }

    /// Empty names are valid (all-zero name bytes) — the FFI never rejects a nameless payment, it
    /// just signs the zero field. This is the floor case; real flows pass real names.
    #[test]
    fn sign_authorization_empty_names_round_trip() {
        let sk = test_key();
        let wire = sign_authorization(
            &sk.to_bytes(),
            &test_to(),
            100,
            &test_nonce(),
            2_000_000_000,
            0,
            String::new(),
            String::new(),
            String::new(),
        )
        .expect("empty names sign OK");
        let signed = SignedAuthorization::from_wire(&wire).unwrap();
        assert_eq!(signed.auth.from_name, [0u8; NAME_LEN]);
        assert_eq!(signed.auth.to_name, [0u8; NAME_LEN]);
        assert_eq!(signed.auth.memo, [0u8; MEMO_LEN]);
        assert!(signed.verify());
    }

    /// A name-field tamper (flip a byte inside `from_name` at offset 100..132) MUST break the
    /// signature — the names are inside `signing_bytes`, so they are authenticated, not advisory.
    #[test]
    fn name_tamper_breaks_signature() {
        let sk = test_key();
        let wire = sign_authorization(
            &sk.to_bytes(),
            &test_to(),
            1499,
            &test_nonce(),
            2_000_000_000,
            0,
            "Alice".to_string(),
            "Bob".to_string(),
            "coffee".to_string(),
        )
        .unwrap();
        let mut tampered = wire.clone();
        tampered[100] ^= 0x01; // first byte of from_name (offset 100 in the wire == signing region)
        let signed = SignedAuthorization::from_wire(&tampered).unwrap();
        assert!(!signed.verify(), "tampering from_name must invalidate the signature");
    }

    /// `encode_request` + `decode_request` round-trip the merchant request with `to_name` + `memo`.
    /// The decoded `PaymentRequestData` carries the names back as `String`.
    #[test]
    fn encode_decode_request_carries_names() {
        let qr = encode_request(
            &test_to(),
            1499,
            &test_nonce(),
            2_000_000_000,
            0,
            "Bob".to_string(),
            "invoice-42".to_string(),
        )
        .expect("encode_request with names");
        let data = decode_request(qr).expect("decode_request round-trips");
        assert_eq!(data.to, test_to().to_vec());
        assert_eq!(data.amount, 1499);
        assert_eq!(data.nonce, test_nonce().to_vec());
        assert_eq!(data.to_name, "Bob");
        assert_eq!(data.memo, "invoice-42");
    }

    /// `nfc_request_bytes` produces the 132-byte request wire with names inside, and
    /// `nfc_decode_request` recovers them — the NFC path carries names just like the QR path.
    #[test]
    fn nfc_request_bytes_carries_names() {
        let bytes = nfc_request_bytes(
            &test_to(),
            1499,
            &test_nonce(),
            2_000_000_000,
            0,
            "Bob".to_string(),
            "tap-memo".to_string(),
        )
        .expect("nfc_request_bytes with names");
        assert_eq!(bytes.len(), REQUEST_LEN);
        let data = nfc_decode_request(&bytes).expect("nfc_decode_request round-trips");
        assert_eq!(data.amount, 1499);
        assert_eq!(data.to_name, "Bob");
        assert_eq!(data.memo, "tap-memo");
    }

    /// `validate` still works (its `Authorization` literal zero-fills the name fields, which
    /// `validate` never reads — it only consults `amount` + `expiry`).
    #[test]
    fn validate_works_with_zeroed_name_literal() {
        assert_eq!(
            validate(1499, 1_700_000_000, 1_700_000_120, 10_000, 50_000, false, true),
            None
        );
        assert_eq!(
            validate(1499, 1_700_000_000, 1_699_999_999, 10_000, 50_000, false, true),
            Some("expired".to_string())
        );
    }
}
