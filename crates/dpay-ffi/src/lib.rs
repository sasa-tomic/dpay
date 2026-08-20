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
    generate_keypair as core_generate_keypair, CodecError, Currency, NAME_LEN,
    PaymentRequest, AmountError, NONCE_LEN, PUBKEY_LEN,
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

pub mod icp;

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
    /// A decimal amount string was rejected by `parse_amount`. Carries a debuggable code matching
    /// `dpay_core::AmountError` (`empty`/`not_a_number`/`negative`/`too_many_decimals`/`overflow`)
    /// so the app reacts without string-sniffing. MC1 unit 1.
    #[error("amount: {0}")]
    Amount(String),
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

/// Map `dpay_core::AmountError` → `DpayError::Amount(code)`. The code strings mirror the TS BigInt
/// mirror's `err` strings exactly (`app/lib/amount.ts`) — one acceptance/rejection policy, both
/// sides. MC1 unit 1.
impl From<AmountError> for DpayError {
    fn from(e: AmountError) -> Self {
        DpayError::Amount(amount_error_code(e))
    }
}

/// Debuggable code for an `AmountError` (mirrors the TS mirror's `err` strings).
fn amount_error_code(e: AmountError) -> String {
    match e {
        AmountError::Empty => "empty",
        AmountError::NotANumber => "not_a_number",
        AmountError::Negative => "negative",
        AmountError::TooManyDecimals => "too_many_decimals",
        AmountError::Overflow => "overflow",
    }
    .to_string()
}

// (pay_error_str retired with `validate` — the ledger's own typed transfer errors are the
// rejection surface now.)

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

/// Derive the Ed25519 keypair from an existing 32-byte seed (the recovery seed Backup reveals).
/// Called at onboarding when the user restores a wallet. Reuses [`signing_key_from_seed`]; rejects
/// a wrong-length seed as `DpayError::BadSecretLength`. The seed recovers BOTH the IC rail (this
/// Ed25519 key) AND the Solana rail (SLIP-10 derivation in `app/solana/identity.ts`).
#[uniffi::export]
pub fn keypair_from_secret(secret: Vec<u8>) -> Result<KeyPair, DpayError> {
    let sk = signing_key_from_seed(&secret)?;
    Ok(KeyPair {
        secret: sk.to_bytes().to_vec(),
        public: sk.verifying_key().to_bytes().to_vec(),
    })
}

// (IC-rail cutover 2026-08-19: wire_len/signing_len/request_len retired — the facade wire left
// the value path; payments sign IC envelopes via the `icp` module.)

/// Parse a human decimal string (e.g. `"8.4"`) into raw `u64` units at `decimals` precision — the
/// single source of truth for the human↔u64 amount boundary (MC1 unit 1). Exact (no float
/// intermediate; `u128` checked arithmetic); `decimals` bounded ≤ 18. Rejects empty/non-numeric/
/// negative/too-many-decimals/overflow as `DpayError::Amount(<code>)` (debuggable codes matching the
/// TS mirror's `err` strings). Retires the old app path that rounded `u64` through `number`/`Double`.
#[uniffi::export]
pub fn parse_amount(human: String, decimals: u8) -> Result<u64, DpayError> {
    Ok(dpay_core::parse_decimal_to_units(&human, decimals)?)
}

/// Format raw `u64` units as a human decimal string at `decimals` precision (e.g.
/// `8_400_000_000_000_000_000` at 18 → `"8.4"`). Trims trailing fractional zeros (a whole number
/// renders without a decimal point); the exact inverse of [`parse_amount`] for every `u64` and
/// `decimals ≤ 18`. MC1 unit 1.
#[uniffi::export]
pub fn format_amount(raw: u64, decimals: u8) -> String {
    dpay_core::format_units_to_decimal(raw, decimals)
}

// (sign_authorization retired with the facade wire — the payer signs an icrc1_transfer /call
// envelope via `icp_sign_update`; see src/icp.rs.)

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

// (encode_qr / decode_qr / verify_wire retired with the 292-byte facade wire — the offline
// handoff QR carries the base64url /call envelope itself; see services/rail.ts envelopeToQrPayload.)

// (sign_withdrawal retired — the offramp signs user-principal icrc2_approve + minter-call
// envelopes; see icp_approve_arg / icp_retrieve_btc_arg / icp_withdraw_eth_arg / icp_withdraw_erc20_arg.)

// (verify_receipt_sig retired with the canister-signed receipt — outcomes ride read_state
// request_status (+ block index); W6 upgrades to on-device BLS cert-chain verification.)

// (validate retired with the canister settlement gate — the ledger itself rejects bad transfers
// and the app decodes the typed error; see services/rail.ts transferRejectionMessage.)

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
    /// The card answered NOT_READY at SELECT: a dpay card is routed but no payer session is armed
    /// (the payer isn't in Pay mode). Keep polling / re-SELECT via `next_command`, or surface an
    /// actionable message and stop.
    WaitingForPayer,
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

    /// Approve: supply the offline-signed payload to serve — an opaque signed-payload handoff
    /// (IC envelope post-cutover). Errors (`NfcWrongState`) unless a request is held and no
    /// decision has been made; the payload is validated as it is framed.
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
            ReaderStep::WaitingForPayer => Ok(NfcStep::WaitingForPayer),
            ReaderStep::Done(w) => {
                *lock(&self.wire) = Some(w);
                Ok(NfcStep::Done)
            }
        }
    }

    /// The reassembled payload once the exchange reached `Done`, else `None` — an opaque
    /// signed-payload handoff (IC envelope post-cutover).
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

// =============================================================================================
// Tests — the surviving FFI surface: request QR names (QR + NFC), plus the icp rail round-trip.
// =============================================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use dpay_core::REQUEST_LEN;

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
    /// `padName32` so the two request-encoding paths produce identical name bytes.
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
}
