//! nfc — NFC (ISO 7816-4 / ISO-DEP) transport framing for dpay.
//!
//! This module is a **pure, panic-free byte codec**. It carries the *exact same bytes* the QR path
//! already moves — the 132-byte [`PaymentRequest`](crate::PaymentRequest) and the 292-byte signed
//! wire ([`SignedAuthorization::to_wire`](crate::SignedAuthorization::to_wire)) — over the APDU
//! exchange an Android **HCE** card (the offline payer) and an NFC **reader** (the online merchant)
//! use. No crypto or policy lives here: the payer still signs with [`crate::sign`] and the merchant
//! still verifies with [`crate::verify`]; NFC only replaces the *transport*, so every byte that
//! survives this module is re-checked by the same core the canister runs.
//!
//! ## Why a state machine and not I/O
//!
//! The radio hop (antenna coupling, `IsoDep.transceive`, `HostApduService.processCommandApdu`) is
//! inherently physical and can only be exercised on two real phones. Everything *around* it — how a
//! payload is split into APDUs, how frames are validated and reassembled, how the card and reader
//! agree on state across a re-tap — is deterministic and is the part that hides bugs. So that logic
//! lives here, fully headless-testable, and the platform glue becomes a thin loop:
//!
//! ```text
//! // Kotlin HCE card:   override fun processCommandApdu(cmd, _) = session.process(cmd)
//! // Kotlin NFC reader: while (val cmd = conductor.nextCommand()) {
//! //                        when (conductor.handleResponse(isoDep.transceive(cmd))) { ... } }
//! ```
//!
//! ## Wire layout (frozen)
//!
//! Payloads larger than one APDU are split into **frames** with a 4-byte header
//! `seq(1) | flags(1) | total_len(2, big-endian)`. The request fits in a single frame; the signed
//! wire now spans **two** frames (292 B > `DEFAULT_MAX_CHUNK` of 240), so the chunking path is
//! exercised on every live wire — which is why it was built and tested up front (Android's `IsoDep`
//! max-transceive length can be as low as ~253 bytes on some stacks).
//!
//! ## No collision with Google Wallet
//!
//! [`AID`] is a proprietary (`0xF0`-prefixed) application id and the Android HCE service that owns it
//! is registered under `android:category="other"`, **not** `"payment"`. Google Wallet registers the
//! EMV payment AIDs under the payment category and owns the tap-to-pay default; dpay claims neither,
//! so the OS never routes a POS tap to dpay nor a dpay tap to Wallet. Routing is by AID, and this one
//! is dpay's alone.

use crate::{PaymentRequest, Receipt, SignedAuthorization, RECEIPT_LEN, REQUEST_LEN, WIRE_LEN};
use apdu::CommandApdu;
use frame::FrameError;

pub mod apdu;
pub mod card;
pub mod frame;
pub mod reader;

// Re-export the public session/conductor types so the flat `dpay_core::nfc::Foo` paths are stable.
pub use card::CardSession;
pub use reader::{ReaderConductor, ReaderStep};

// ===========================================================================
// Shared constants
// ===========================================================================

/// dpay's proprietary application id: `0xF0` (proprietary/unregistered per ISO/IEC 7816-5) + the
/// ASCII bytes of "dpay" (`64 70 61 79`) + a version byte. The reader SELECTs this to route to
/// dpay's HCE service; nothing else registers it, so there is no collision with Google Wallet or any
/// EMV payment app. Frozen: changing it is a breaking protocol change.
pub const AID: [u8; 6] = [0xF0, 0x64, 0x70, 0x61, 0x79, 0x01];

/// Protocol version echoed in the SELECT greeting, so the reader can refuse an incompatible card.
pub const PROTO_VERSION: u8 = 1;

/// Default max dpay-payload bytes per frame (excludes the 4-byte frame header and APDU overhead).
/// Chosen conservatively so a frame + header + APDU framing stays under Android's smallest realistic
/// `IsoDep` max-transceive length. The 132 B request fits in one frame; the 292 B signed wire spans
/// two frames (240 + 52).
pub const DEFAULT_MAX_CHUNK: usize = 240;

/// Hard ceiling on a reassembled payload — the `total_len` header is a `u16`, and this also bounds
/// the buffer a hostile peer can make us allocate.
pub const MAX_PAYLOAD: usize = u16::MAX as usize;

/// A payload may span at most this many frames (`seq` is a single byte).
pub const MAX_FRAMES: usize = 256;

// ===========================================================================
// Protocol layer (dpay HCE ↔ reader)
// ===========================================================================

// Instruction bytes. SELECT is the standard ISO instruction (CLA 0x00); the two dpay-specific
// commands use the proprietary class 0x80.
const CLA_ISO: u8 = 0x00;
const CLA_PROP: u8 = 0x80;
const INS_SELECT: u8 = 0xA4;
const INS_PUT_REQUEST: u8 = 0xC2; // reader → card: one request frame
const INS_GET_WIRE: u8 = 0xC4; // reader → card: pull one wire frame
const INS_PUT_RECEIPT: u8 = 0xC6; // reader → card: the settlement outcome (after the merchant settles)

// SELECT-by-name parameters (P1=0x04 "select by DF name", P2=0x00 "first or only occurrence").
const P1_SELECT_BY_NAME: u8 = 0x04;
const P2_FIRST: u8 = 0x00;

/// The card's phase, reported in the SELECT greeting so the reader knows what to do next even after
/// a re-tap or a card-process restart. Frozen on the wire.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CardPhase {
    /// No (complete) request yet — the reader must push one.
    Collecting = 0,
    /// The request is held and awaiting the payer's decision — the reader should poll / re-tap.
    HasRequest = 1,
    /// A signed wire is ready — the reader should pull it.
    Serving = 2,
}

impl CardPhase {
    fn byte(self) -> u8 {
        self as u8
    }
    fn from_byte(b: u8) -> Option<CardPhase> {
        match b {
            0 => Some(CardPhase::Collecting),
            1 => Some(CardPhase::HasRequest),
            2 => Some(CardPhase::Serving),
            _ => None,
        }
    }
}

/// A failure surfaced by the session/conductor APIs (as opposed to a card responding with an error
/// status word, which is normal traffic). All variants are `Copy`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NfcError {
    /// The peer's bytes weren't a valid APDU.
    Apdu(apdu::ApduError),
    /// A frame or the reassembled stream was invalid.
    Frame(FrameError),
    /// An API was called in a state that doesn't allow it (e.g. `provide_wire` before a request).
    WrongState,
    /// A SELECT response said this isn't a dpay card, or the card reported an unknown phase.
    NotDpay,
    /// The card speaks a protocol version this reader doesn't support.
    UnsupportedVersion(u8),
    /// The card returned a status word that isn't valid for the current step.
    UnexpectedStatus(u16),
    /// The card's greeting was too short to contain `[version, phase]`.
    ShortGreeting,
}

impl From<apdu::ApduError> for NfcError {
    fn from(e: apdu::ApduError) -> Self {
        NfcError::Apdu(e)
    }
}
impl From<FrameError> for NfcError {
    fn from(e: FrameError) -> Self {
        NfcError::Frame(e)
    }
}

/// The lifecycle phase of one tap, for a live UI status indicator. Both roles report it (see
/// [`CardSession::phase`] / [`ReaderConductor::phase`]); the app renders a spinner while
/// `Linking`/`Exchanging`, a review prompt on `AwaitingApproval`, and a terminal ✓ / declined mark
/// on `Complete` / `Declined`.
///
/// This is the *lifecycle* only. Failures are **not** a phase here — they surface as typed errors
/// from the session APIs (protocol) or as a platform `TagLostException` (radio) — and the app maps
/// those to its own error state. Keeping errors out of the phase means this enum can never
/// misreport a failed tap as a benign state.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SessionPhase {
    /// No exchange in progress yet (waiting for a tap).
    Idle,
    /// SELECT handshake — the two phones are establishing the dpay channel.
    Linking,
    /// Transferring frames (the request in, or the signed wire out).
    Exchanging,
    /// The payer is holding the request, deciding whether to approve.
    AwaitingApproval,
    /// The signed wire was transferred; the merchant is settling online and the payer awaits the
    /// receipt (both sides are here between the wire leaving and the outcome coming back).
    Settling,
    /// The exchange finished — the payer has the merchant's receipt (settled or not).
    Complete,
    /// The payer declined.
    Declined,
}

/// Build the SELECT-by-AID command the reader sends first.
pub fn build_select() -> Vec<u8> {
    CommandApdu::with_data(CLA_ISO, INS_SELECT, P1_SELECT_BY_NAME, P2_FIRST, AID.to_vec(), Some(256))
        .encode()
}

// ---------------------------------------------------------------------------
// Typed decoders over the transported payloads
// ---------------------------------------------------------------------------

/// Decode the bytes the reader reassembled from the card back into a [`SignedAuthorization`], with a
/// length guard so a truncated/oversized transfer is caught before the core parser. The signature is
/// **not** trusted here — the caller still calls [`SignedAuthorization::verify`] / [`crate::verify`].
pub fn wire_from_transport(bytes: &[u8]) -> Result<SignedAuthorization, NfcError> {
    if bytes.len() != WIRE_LEN {
        return Err(NfcError::Frame(FrameError::ShortPayload));
    }
    SignedAuthorization::from_wire(bytes).map_err(|_| NfcError::Frame(FrameError::ShortPayload))
}

/// Decode the request bytes the card reassembled back into a [`PaymentRequest`], with a length guard.
pub fn request_from_transport(bytes: &[u8]) -> Result<PaymentRequest, NfcError> {
    if bytes.len() != REQUEST_LEN {
        return Err(NfcError::Frame(FrameError::ShortPayload));
    }
    PaymentRequest::from_bytes(bytes).map_err(|_| NfcError::Frame(FrameError::ShortPayload))
}

/// Decode the settlement receipt bytes the payer's card received back into a [`Receipt`], with a
/// length guard, so the (offline) payer can show the outcome and match the nonce.
pub fn receipt_from_transport(bytes: &[u8]) -> Result<Receipt, NfcError> {
    if bytes.len() != RECEIPT_LEN {
        return Err(NfcError::Frame(FrameError::ShortPayload));
    }
    Receipt::from_bytes(bytes).map_err(|_| NfcError::Frame(FrameError::ShortPayload))
}

// ===========================================================================
// Tests — all headless, offline, deterministic. Run via `just test-core`
// (`cargo nextest run -p dpay-core --features rng`). The `rng`-gated tests build a real
// Ed25519-signed wire and prove it survives the NFC framing and still verifies.
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::apdu::{ApduError, CommandApdu, ResponseApdu, Sw};
    use super::frame::{self, Frame, FrameError, Reassembler, FLAG_LAST};
    use super::*;
    use crate::{RECEIPT_REJECTED, RECEIPT_SETTLED, RECEIPT_UNREACHABLE};
    use proptest::prelude::*;

    // ---- APDU layer -------------------------------------------------------

    #[test]
    fn apdu_roundtrip_all_cases() {
        // Case 1: header only.
        let c1 = CommandApdu::with_data(0x80, 0x10, 1, 2, vec![], None);
        assert_eq!(CommandApdu::parse(&c1.encode()).unwrap(), c1);
        // Case 2: header + Le (256 -> 0x00).
        let c2 = CommandApdu::expecting(0x80, 0xC4, 0, 0, 256);
        let enc2 = c2.encode();
        assert_eq!(*enc2.last().unwrap(), 0x00);
        assert_eq!(CommandApdu::parse(&enc2).unwrap(), c2);
        // Case 3: header + data.
        let c3 = CommandApdu::with_data(0x80, 0xC2, 0, 0, vec![1, 2, 3, 4], None);
        assert_eq!(CommandApdu::parse(&c3.encode()).unwrap(), c3);
        // Case 4: header + data + Le.
        let c4 = CommandApdu::with_data(0x00, 0xA4, 4, 0, AID.to_vec(), Some(256));
        assert_eq!(CommandApdu::parse(&c4.encode()).unwrap(), c4);
    }

    #[test]
    fn apdu_parse_rejects_malformed() {
        assert_eq!(CommandApdu::parse(&[0x00, 0xA4, 0x04]), Err(ApduError::Short));
        // Lc says 5 data bytes but only 2 present.
        assert_eq!(CommandApdu::parse(&[0x80, 0xC2, 0, 0, 5, 1, 2]), Err(ApduError::BadLc));
        // Lc == 0 with a trailing body is the extended-length marker: refused, not mis-parsed.
        assert_eq!(CommandApdu::parse(&[0x80, 0xC2, 0, 0, 0, 1, 2, 3]), Err(ApduError::Unsupported));
        // Response trailer must be at least the 2 status bytes.
        assert_eq!(ResponseApdu::parse(&[0x90]), Err(ApduError::Short));
    }

    #[test]
    fn response_roundtrip_and_status_words() {
        let r = ResponseApdu::new(vec![1, 2, 3], Sw::OK);
        assert_eq!(ResponseApdu::parse(&r.encode()).unwrap(), r);
        assert!(Sw::OK.is_ok());
        assert!(Sw::more(7).is_more() && !Sw::more(7).is_ok());
        assert_eq!(Sw::more(0x2a).0, 0x612a);
        let s = ResponseApdu::status(Sw::DECLINED).encode();
        assert_eq!(s, vec![0x69, 0x85]);
    }

    // The card is a total function: any bytes in any state produce a well-formed response and
    // never panic. This is the "no ignored errors / no crash" guarantee for `processCommandApdu`.
    proptest! {
        #[test]
        fn card_never_panics_on_arbitrary_input(
            cmds in prop::collection::vec(prop::collection::vec(any::<u8>(), 0..40), 1..12),
            max_chunk in 1usize..=64,
        ) {
            let mut card = CardSession::new(max_chunk);
            for c in cmds {
                let resp = card.process(&c);
                // Every response is a parseable APDU with a status word.
                prop_assert!(resp.len() >= 2);
                prop_assert!(ResponseApdu::parse(&resp).is_ok());
            }
        }
    }

    // ---- Frame layer ------------------------------------------------------

    #[test]
    fn fragment_reassemble_roundtrip_small_chunks() {
        let payload: Vec<u8> = (0..200u32).map(|i| i as u8).collect();
        for chunk in [1usize, 7, 63, 199, 200, 240] {
            let frames = frame::fragment(&payload, chunk).unwrap();
            let mut r = Reassembler::new();
            let mut got = None;
            for f in &frames {
                got = r.accept(&Frame::parse(f).unwrap()).unwrap();
            }
            assert_eq!(got.unwrap(), payload, "chunk={chunk}");
        }
    }

    #[test]
    fn fragment_input_guards() {
        assert_eq!(frame::fragment(&[], 4), Err(FrameError::Empty));
        assert_eq!(frame::fragment(&[1, 2], 0), Err(FrameError::BadChunkSize));
        // A payload needing more than MAX_FRAMES frames is refused.
        let big = vec![0u8; MAX_FRAMES + 1];
        assert_eq!(frame::fragment(&big, 1), Err(FrameError::TooManyFrames));
        // Exactly MAX_FRAMES is fine.
        assert!(frame::fragment(&vec![0u8; MAX_FRAMES], 1).is_ok());
    }

    #[test]
    fn frame_parse_guards() {
        assert_eq!(Frame::parse(&[0, 0, 0]), Err(FrameError::Short)); // header truncated
        assert_eq!(Frame::parse(&[0, FLAG_LAST, 0, 5]), Err(FrameError::EmptyChunk)); // no chunk
    }

    /// Parse `frame::encode(..)` bytes into a `Frame`, keeping the backing bytes alive in the caller.
    fn enc(seq: u8, last: bool, total: u16, chunk: &[u8]) -> Vec<u8> {
        frame::encode(seq, last, total, chunk)
    }

    #[test]
    fn reassembler_rejects_every_inconsistency() {
        // Out-of-order sequence.
        let (a, b) = (enc(0, false, 4, &[1, 2]), enc(2, true, 4, &[3, 4]));
        let mut r = Reassembler::new();
        r.accept(&Frame::parse(&a).unwrap()).unwrap();
        assert_eq!(r.accept(&Frame::parse(&b).unwrap()), Err(FrameError::BadSequence));

        // Inconsistent total across frames.
        let (a, b) = (enc(0, false, 4, &[1, 2]), enc(1, true, 9, &[3, 4]));
        let mut r = Reassembler::new();
        r.accept(&Frame::parse(&a).unwrap()).unwrap();
        assert_eq!(r.accept(&Frame::parse(&b).unwrap()), Err(FrameError::InconsistentTotal));

        // Overflow: more bytes than declared.
        let a = enc(0, true, 2, &[1, 2, 3]);
        assert_eq!(Reassembler::new().accept(&Frame::parse(&a).unwrap()), Err(FrameError::Overflow));

        // LAST flag but short of the declared total.
        let a = enc(0, true, 8, &[1, 2]);
        assert_eq!(Reassembler::new().accept(&Frame::parse(&a).unwrap()), Err(FrameError::ShortPayload));

        // All bytes arrived but the final frame wasn't flagged LAST.
        let a = enc(0, false, 2, &[1, 2]);
        assert_eq!(Reassembler::new().accept(&Frame::parse(&a).unwrap()), Err(FrameError::MissingLast));

        // total_len == 0 (declared empty) is rejected up front as Empty.
        let a = enc(0, true, 0, &[1]);
        assert_eq!(Reassembler::new().accept(&Frame::parse(&a).unwrap()), Err(FrameError::Empty));

        // A frame after completion.
        let (a, b) = (enc(0, true, 2, &[1, 2]), enc(1, true, 2, &[3, 4]));
        let mut r = Reassembler::new();
        assert_eq!(r.accept(&Frame::parse(&a).unwrap()).unwrap(), Some(vec![1, 2]));
        assert_eq!(r.accept(&Frame::parse(&b).unwrap()), Err(FrameError::AlreadyComplete));
    }

    // fragment() → Reassembler is a lossless roundtrip for any non-empty payload / chunk size.
    proptest! {
        #[test]
        fn frame_roundtrip_prop(payload in prop::collection::vec(any::<u8>(), 1..=256), chunk in 1usize..=256) {
            let frames = frame::fragment(&payload, chunk).unwrap();
            let mut r = Reassembler::new();
            let mut out = None;
            for f in &frames {
                out = r.accept(&Frame::parse(f).unwrap()).unwrap();
            }
            prop_assert_eq!(out.unwrap(), payload);
        }
    }

    // ---- Full card ⇆ reader simulation -----------------------------------

    #[derive(Clone, Copy)]
    enum Decision {
        Approve,
        Decline,
    }

    struct Driven {
        step: ReaderStep,
        card_request: Option<Vec<u8>>,
        pending_seen: usize,
        waiting_seen: usize,
    }

    /// Runs the whole exchange in memory: the reader's command → the card → the card's response →
    /// the reader, looped. `decision` is applied when the card first holds the request, but only
    /// after `approve_after_pending` poll cycles (exercising the awaiting-approval / re-tap path).
    /// Bounded so a stuck state machine fails the test instead of hanging.
    fn drive(
        request: &[u8],
        wire: &[u8],
        max_chunk: usize,
        decision: Decision,
        approve_after_pending: usize,
    ) -> Result<Driven, NfcError> {
        let mut card = CardSession::new(max_chunk);
        let mut reader = ReaderConductor::new(request, max_chunk)?;
        let mut pending_seen = 0usize;
        let mut waiting_seen = 0usize;
        let mut card_request = None;
        let mut decided = false;

        for _ in 0..(MAX_FRAMES * 8 + 128) {
            let Some(cmd) = reader.next_command() else {
                return Err(NfcError::WrongState); // terminal without a Done/Declined step
            };
            let resp = card.process(&cmd);

            if card.awaiting_decision() && !decided && pending_seen >= approve_after_pending {
                card_request = card.request().map(|r| r.to_vec());
                match decision {
                    Decision::Approve => card.provide_wire(wire)?,
                    Decision::Decline => card.decline()?,
                }
                decided = true;
            }

            match reader.handle_response(&resp)? {
                ReaderStep::Continue => {}
                ReaderStep::Pending => pending_seen += 1,
                ReaderStep::WaitingForPayer => waiting_seen += 1,
                step @ (ReaderStep::Done(_) | ReaderStep::Declined | ReaderStep::Confirmed) => {
                    return Ok(Driven { step, card_request, pending_seen, waiting_seen });
                }
            }
        }
        Err(NfcError::WrongState) // exceeded the loop bound → would-be hang, surfaced as a failure
    }

    /// The full tap including the receipt-return: run to `Done`, hand the reader a receipt (as the
    /// merchant would after settling online), then pump the loop until the payer's card is
    /// `Confirmed`. Returns the wire the merchant reassembled and the receipt the card received.
    fn drive_full(request: &[u8], wire: &[u8], receipt: &[u8], max_chunk: usize) -> (Vec<u8>, Vec<u8>) {
        let mut card = CardSession::new(max_chunk);
        let mut reader = ReaderConductor::new(request, max_chunk).unwrap();
        let mut approved = false;
        let mut delivered: Option<Vec<u8>> = None;
        let mut receipted = false;

        for _ in 0..(MAX_FRAMES * 16 + 256) {
            let Some(cmd) = reader.next_command() else {
                // The reader is at `Done` waiting for the merchant to settle + provide the receipt.
                assert!(delivered.is_some() && !receipted, "unexpected terminal");
                reader.provide_receipt(receipt).unwrap();
                receipted = true;
                continue;
            };
            let resp = card.process(&cmd);
            if card.awaiting_decision() && !approved {
                card.provide_wire(wire).unwrap();
                approved = true;
            }
            match reader.handle_response(&resp).unwrap() {
                ReaderStep::Done(w) => delivered = Some(w),
                ReaderStep::Confirmed => {
                    assert!(card.is_confirmed(), "card must be confirmed once the reader is");
                    return (delivered.unwrap(), card.receipt().unwrap().to_vec());
                }
                _ => {}
            }
        }
        panic!("full exchange did not terminate");
    }

    fn sample_request() -> Vec<u8> {
        PaymentRequest { to: [7u8; 32], amount: 4200, nonce: [9u8; 16], expiry: 4102444800, currency: crate::DEMO_USD, to_name: [0u8; crate::NAME_LEN], memo: [0u8; crate::MEMO_LEN] }
            .to_bytes()
            .to_vec()
    }

    #[test]
    fn happy_path_single_frame() {
        let req = sample_request();
        let wire = vec![0xABu8; WIRE_LEN];
        let d = drive(&req, &wire, DEFAULT_MAX_CHUNK, Decision::Approve, 0).unwrap();
        assert_eq!(d.pending_seen, 0, "single tap: no polling expected");
        assert_eq!(d.card_request.unwrap(), req, "request round-trips to the card");
        match d.step {
            ReaderStep::Done(w) => assert_eq!(w, wire),
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[test]
    fn approval_after_polling_resumes_on_retap() {
        let req = sample_request();
        let wire = vec![0x5Au8; WIRE_LEN];
        // Force three NOT_READY poll cycles before the payer approves.
        let d = drive(&req, &wire, DEFAULT_MAX_CHUNK, Decision::Approve, 3).unwrap();
        assert!(d.pending_seen >= 3, "should have polled while awaiting approval");
        match d.step {
            ReaderStep::Done(w) => assert_eq!(w, wire),
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[test]
    fn decline_immediate_and_after_polling() {
        let req = sample_request();
        let wire = vec![0u8; WIRE_LEN];
        for after in [0usize, 2] {
            let d = drive(&req, &wire, DEFAULT_MAX_CHUNK, Decision::Decline, after).unwrap();
            assert!(matches!(d.step, ReaderStep::Declined), "after={after}");
        }
    }

    #[test]
    fn unarmed_card_at_select_reports_waiting_for_payer() {
        // A dpay card is ROUTED (the OS answered our AID) but no payer session is armed — the
        // platform HCE layer answers NOT_READY at SELECT (see DpayNfc.onCardApdu). The reader must
        // treat this as "waiting for the payer", NOT a protocol violation, and a subsequent armed
        // SELECT must still complete the exchange.
        let req = sample_request();
        let wire = vec![0x5Au8; WIRE_LEN];
        let mut reader = ReaderConductor::new(&req, DEFAULT_MAX_CHUNK).unwrap();
        let mut unarmed = CardSession::new(DEFAULT_MAX_CHUNK); // never SELECTed → wrong for direct use

        // Simulate the platform layer: SELECT answered with bare NOT_READY (the unarmed response).
        let select = reader.next_command().unwrap();
        let plat_resp = ResponseApdu::status(Sw::NOT_READY).encode();
        match reader.handle_response(&plat_resp).unwrap() {
            ReaderStep::WaitingForPayer => {}
            other => panic!("expected WaitingForPayer, got {other:?}"),
        }
        // The reader stays in NeedSelect: next_command re-SELECTs.
        let select2 = reader.next_command().unwrap();
        assert_eq!(select2, select, "re-SELECT must be byte-identical");

        // Now a real armed card answers the re-SELECT and the full exchange completes.
        let mut card = CardSession::new(DEFAULT_MAX_CHUNK);
        let mut approved = false;
        let mut delivered = None;
        for _ in 0..(MAX_FRAMES * 8 + 128) {
            let Some(cmd) = reader.next_command() else { break };
            let resp = card.process(&cmd);
            if card.awaiting_decision() && !approved {
                card.provide_wire(&wire).unwrap();
                approved = true;
            }
            match reader.handle_response(&resp).unwrap() {
                ReaderStep::Done(w) => delivered = Some(w),
                ReaderStep::Confirmed => break,
                _ => {}
            }
        }
        assert_eq!(delivered, Some(wire));
        drop(unarmed);
    }

    proptest! {
        // The framing delivers arbitrary payloads byte-exactly, at any chunk size, single- or
        // multi-frame, whether or not the payer polls first.
        #[test]
        fn end_to_end_prop(
            wire in prop::collection::vec(any::<u8>(), 1..=256),
            max_chunk in 1usize..=256,
            approve_after in 0usize..3,
        ) {
            let req = sample_request();
            let d = drive(&req, &wire, max_chunk, Decision::Approve, approve_after)
                .expect("exchange completes without protocol error");
            prop_assert_eq!(d.card_request.unwrap(), req);
            match d.step {
                ReaderStep::Done(w) => prop_assert_eq!(w, wire),
                other => prop_assert!(false, "expected Done, got {:?}", other),
            }
        }
    }

    // ---- Protocol-level failure paths ------------------------------------

    #[test]
    fn wrong_aid_is_not_dpay() {
        let mut card = CardSession::new(DEFAULT_MAX_CHUNK);
        // SELECT a different AID.
        let bad = CommandApdu::with_data(0x00, 0xA4, 0x04, 0, vec![0xA0, 0x00, 0x01], Some(256));
        let resp = ResponseApdu::parse(&card.process(&bad.encode())).unwrap();
        assert_eq!(resp.sw, Sw::NOT_FOUND);

        // A reader driving against a non-dpay card surfaces NotDpay, not a silent stall.
        let mut reader = ReaderConductor::new(&sample_request(), DEFAULT_MAX_CHUNK).unwrap();
        let _ = reader.next_command().unwrap();
        assert_eq!(reader.handle_response(&resp.encode()), Err(NfcError::NotDpay));
    }

    #[test]
    fn premature_get_wire_is_not_ready() {
        let mut card = CardSession::new(DEFAULT_MAX_CHUNK);
        // GET WIRE before any SELECT/request.
        let get = CommandApdu::expecting(0x80, 0xC4, 0, 0, 256).encode();
        assert_eq!(ResponseApdu::parse(&card.process(&get)).unwrap().sw, Sw::NOT_READY);
    }

    #[test]
    fn unknown_cla_and_ins_are_reported() {
        let mut card = CardSession::new(DEFAULT_MAX_CHUNK);
        let bad_cla = CommandApdu::with_data(0x11, 0x22, 0, 0, vec![], None).encode();
        assert_eq!(ResponseApdu::parse(&card.process(&bad_cla)).unwrap().sw, Sw::CLA_NOT_SUPPORTED);
        let bad_ins = CommandApdu::with_data(0x80, 0x99, 0, 0, vec![], None).encode();
        assert_eq!(ResponseApdu::parse(&card.process(&bad_ins)).unwrap().sw, Sw::INS_NOT_SUPPORTED);
        // Non-APDU garbage → a length error, never a panic.
        assert_eq!(ResponseApdu::parse(&card.process(&[0x00])).unwrap().sw, Sw::WRONG_LENGTH);
    }

    #[test]
    fn provide_wire_wrong_state_is_typed_error() {
        let mut card = CardSession::new(DEFAULT_MAX_CHUNK);
        // No request held yet.
        assert_eq!(card.provide_wire(&[0u8; WIRE_LEN]), Err(NfcError::WrongState));
        assert_eq!(card.decline(), Err(NfcError::WrongState));
    }

    #[test]
    fn reselect_midserve_restarts_pull_from_zero() {
        // Drive the card by hand to Serving with a 3-frame wire, pull one frame, then re-SELECT and
        // confirm it serves from frame 0 again (a re-tap must not deliver a truncated wire).
        let mut card = CardSession::new(2); // 5-byte wire -> 3 frames
        let wire = vec![10, 20, 30, 40, 50];
        card.process(&build_select());
        // push a 1-frame request (5 bytes at chunk 2 would be 3 frames; keep request tiny -> 1 frame)
        let reqf = frame::fragment(&[1, 2], 2).unwrap();
        card.process(&CommandApdu::with_data(0x80, 0xC2, 0, 0, reqf[0].clone(), None).encode());
        assert!(card.awaiting_decision());
        card.provide_wire(&wire).unwrap();

        let get = CommandApdu::expecting(0x80, 0xC4, 0, 0, 256).encode();
        let f0 = ResponseApdu::parse(&card.process(&get)).unwrap();
        assert!(f0.sw.is_more());
        // Re-tap: SELECT again mid-serve.
        let greet = ResponseApdu::parse(&card.process(&build_select())).unwrap();
        assert_eq!(greet.sw, Sw::OK);
        assert_eq!(greet.data[1], CardPhase::Serving.byte());
        // Now pulling should start again at frame 0.
        let again = ResponseApdu::parse(&card.process(&get)).unwrap();
        assert_eq!(again.data, f0.data, "re-tap must resume from the first frame");
    }

    #[test]
    fn phase_tracks_the_exchange() {
        let req = sample_request();
        let wire = vec![0xABu8; WIRE_LEN];
        let mut card = CardSession::new(DEFAULT_MAX_CHUNK);
        let mut reader = ReaderConductor::new(&req, DEFAULT_MAX_CHUNK).unwrap();

        // Nothing has happened yet.
        assert_eq!(card.phase(), SessionPhase::Idle);
        assert_eq!(reader.phase(), SessionPhase::Linking);

        // SELECT handshake.
        let greet = card.process(&reader.next_command().unwrap());
        assert_eq!(card.phase(), SessionPhase::Linking);
        reader.handle_response(&greet).unwrap();
        assert_eq!(reader.phase(), SessionPhase::Exchanging);

        // Push the request → the card now holds it and awaits the payer's decision.
        let ack = card.process(&reader.next_command().unwrap());
        assert_eq!(card.phase(), SessionPhase::AwaitingApproval);
        assert!(!card.is_complete());
        reader.handle_response(&ack).unwrap();
        assert_eq!(reader.phase(), SessionPhase::Exchanging);

        // Approve → the card is serving the signed wire.
        card.provide_wire(&wire).unwrap();
        assert_eq!(card.phase(), SessionPhase::Exchanging);

        // Pull the wire (292 B at DEFAULT_MAX_CHUNK spans 2 frames). The card stays Serving
        // (Exchanging) until the final frame leaves; only then does it flip to Done (Settling).
        let mut delivered = None;
        for _ in 0..WIRE_LEN.div_ceil(DEFAULT_MAX_CHUNK) {
            assert_eq!(card.phase(), SessionPhase::Exchanging, "still serving wire frames");
            let resp = card.process(&reader.next_command().unwrap());
            match reader.handle_response(&resp).unwrap() {
                ReaderStep::Continue => {}          // an intermediate frame
                ReaderStep::Done(w) => delivered = Some(w), // the final frame
                other => panic!("unexpected step {other:?}"),
            }
        }
        // The last frame has left the payer → the wire is out, outcome unknown (Settling).
        assert_eq!(card.phase(), SessionPhase::Settling);
        assert!(card.is_complete()); // the wire is out…
        assert!(!card.is_confirmed()); // …but not yet confirmed
        let _delivered = delivered.expect("wire delivered");
        assert_eq!(reader.phase(), SessionPhase::Settling);
        assert!(reader.next_command().is_none(), "reader waits for the merchant to settle online");

        // Merchant settles online, then hands the receipt back over the same tap.
        let receipt = Receipt { nonce: [9u8; 16], status: RECEIPT_SETTLED }.to_bytes();
        reader.provide_receipt(&receipt).unwrap();
        let rframe = card.process(&reader.next_command().unwrap());
        assert_eq!(card.phase(), SessionPhase::Complete);
        assert!(card.is_confirmed());
        assert_eq!(card.receipt().unwrap(), receipt);
        assert!(matches!(reader.handle_response(&rframe).unwrap(), ReaderStep::Confirmed));
        assert_eq!(reader.phase(), SessionPhase::Complete);

        // The payer decodes the outcome.
        let decoded = receipt_from_transport(card.receipt().unwrap()).unwrap();
        assert!(decoded.settled());
        assert_eq!(decoded.nonce, [9u8; 16]);
    }

    #[test]
    fn receipt_returns_to_the_payer() {
        let req = sample_request(); // nonce = [9; 16]
        let wire = vec![0xABu8; WIRE_LEN];
        for status in [RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE] {
            let receipt = Receipt { nonce: [9u8; 16], status }.to_bytes().to_vec();
            // Single-frame and byte-fragmented (tiny chunk splits even the 17-byte receipt).
            for mc in [DEFAULT_MAX_CHUNK, 3] {
                let (delivered, got) = drive_full(&req, &wire, &receipt, mc);
                assert_eq!(delivered, wire, "status={status} chunk={mc}");
                assert_eq!(got, receipt, "status={status} chunk={mc}");
                let r = receipt_from_transport(&got).unwrap();
                assert_eq!(r.status, status);
                assert_eq!(r.settled(), status == RECEIPT_SETTLED);
            }
        }
    }

    #[test]
    fn provide_receipt_wrong_state_is_typed_error() {
        // Before the wire is served, there's nothing to receipt.
        let mut reader = ReaderConductor::new(&sample_request(), DEFAULT_MAX_CHUNK).unwrap();
        let receipt = Receipt { nonce: [9u8; 16], status: RECEIPT_SETTLED }.to_bytes();
        assert_eq!(reader.provide_receipt(&receipt), Err(NfcError::WrongState));
        // On the card, a receipt before the wire is served is out of sequence (NOT_READY).
        let mut card = CardSession::new(DEFAULT_MAX_CHUNK);
        card.process(&build_select());
        let frame = frame::fragment(&receipt, DEFAULT_MAX_CHUNK).unwrap();
        let resp = ResponseApdu::parse(
            &card.process(&CommandApdu::with_data(0x80, 0xC6, 0, 0, frame[0].clone(), None).encode()),
        )
        .unwrap();
        assert_eq!(resp.sw, Sw::NOT_READY);
        assert!(card.receipt().is_none());
    }

    #[test]
    fn phase_reports_decline() {
        let mut card = CardSession::new(DEFAULT_MAX_CHUNK);
        card.process(&build_select());
        let reqf = frame::fragment(&sample_request(), DEFAULT_MAX_CHUNK).unwrap();
        card.process(&CommandApdu::with_data(0x80, 0xC2, 0, 0, reqf[0].clone(), None).encode());
        assert_eq!(card.phase(), SessionPhase::AwaitingApproval);
        card.decline().unwrap();
        assert_eq!(card.phase(), SessionPhase::Declined);
    }

    /// A malformed request frame mid-push is rejected (BAD_DATA), not silently accepted.
    #[test]
    fn corrupt_request_frame_rejected() {
        let mut card = CardSession::new(DEFAULT_MAX_CHUNK);
        card.process(&build_select());
        // A "frame" whose LAST is set but whose length is shorter than its own total_len header.
        let bad = frame::encode(0, true, 99, &[1, 2, 3]);
        let resp = ResponseApdu::parse(
            &card.process(&CommandApdu::with_data(0x80, 0xC2, 0, 0, bad, None).encode()),
        )
        .unwrap();
        assert_eq!(resp.sw, Sw::BAD_DATA);
        assert!(card.request().is_none(), "a rejected frame must not yield a request");
    }
}

// ---- rng-gated: a real Ed25519-signed wire survives the transport and still verifies ----
#[cfg(all(test, feature = "rng"))]
mod signed_tests {
    use super::*;
    use crate::{generate_keypair, Authorization, SignedAuthorization};

    fn real_signed_wire() -> (Vec<u8>, SignedAuthorization) {
        let sk = generate_keypair();
        let from = sk.verifying_key().to_bytes();
        let auth = Authorization { from, to: [7u8; 32], amount: 4200, nonce: [1u8; 16], expiry: 4102444800, currency: crate::DEMO_USD, from_name: [0u8; crate::NAME_LEN], to_name: [0u8; crate::NAME_LEN], memo: [0u8; crate::MEMO_LEN] };
        let se = SignedAuthorization::new(&sk, auth);
        (se.to_wire().to_vec(), se)
    }

    /// The money shot: the offline-signed wire moves card→reader over NFC framing (single frame and
    /// heavily fragmented), and what the reader reassembles verifies as the identical authorization.
    #[test]
    fn signed_wire_survives_nfc_and_verifies() {
        let (wire, se) = real_signed_wire();
        let req = PaymentRequest { to: se.auth.to, amount: se.auth.amount, nonce: se.auth.nonce, expiry: se.auth.expiry, currency: se.auth.currency, to_name: se.auth.to_name, memo: se.auth.memo }
            .to_bytes()
            .to_vec();

        // The NFC frame `seq` is one byte, so a payload is capped at MAX_FRAMES (256) frames. The
        // 292-byte wire at chunk=1 needs 292 frames (> 256) — an unrepresentable configuration the
        // transport must refuse with a typed error rather than silently truncate. Pin that boundary
        // against the real wire length (not just the generic `fragment_input_guards` MAX_FRAMES+1
        // case), so a future wire resize or seq widening surfaces here explicitly.
        assert_eq!(WIRE_LEN.div_ceil(1), 292);
        assert!(
            WIRE_LEN.div_ceil(1) > super::MAX_FRAMES,
            "292-byte wire at chunk=1 must exceed the frame ceiling"
        );
        assert_eq!(
            super::frame::fragment(&wire, 1),
            Err(super::frame::FrameError::TooManyFrames),
            "chunk=1 on the 292-byte wire is unrepresentable (u8 seq) -> typed rejection"
        );

        // Smallest representable chunk is 2 (146 frames, ≤ MAX_FRAMES) — still heavily fragmented.
        for max_chunk in [super::DEFAULT_MAX_CHUNK, 240, 64, 7, 2] {
            let mut card = CardSession::new(max_chunk);
            let mut reader = ReaderConductor::new(&req, max_chunk).unwrap();
            let mut approved = false;
            let mut delivered = None;
            for _ in 0..4000 {
                let cmd = reader.next_command().expect("reader has a command");
                let resp = card.process(&cmd);
                if card.awaiting_decision() && !approved {
                    // The payer decodes the request, sees the amount, and approves.
                    let seen = request_from_transport(card.request().unwrap()).unwrap();
                    assert_eq!(seen.amount, se.auth.amount);
                    card.provide_wire(&wire).unwrap();
                    approved = true;
                }
                match reader.handle_response(&resp).unwrap() {
                    ReaderStep::Done(w) => {
                        delivered = Some(w);
                        break;
                    }
                    ReaderStep::Declined => panic!("unexpected decline"),
                    _ => {}
                }
            }
            let delivered = delivered.expect("wire delivered");
            assert_eq!(delivered, wire, "chunk={max_chunk}: byte-identical");
            let recovered = wire_from_transport(&delivered).unwrap();
            assert!(recovered.verify(), "chunk={max_chunk}: signature verifies after transport");
            assert_eq!(recovered, se);
        }
    }

    /// If a single byte is corrupted in transit, the signature check catches it — framing integrity
    /// is backstopped by the same crypto the canister enforces. The flipped byte (offset 100) is now
    /// the first byte of the `from_name` field, so this also proves names are integrity-protected.
    #[test]
    fn one_byte_corruption_fails_verification() {
        let (mut wire, _se) = real_signed_wire();
        wire[100] ^= 0x01; // flip a bit in from_name[0] (inside the signed region [0..196))
        match wire_from_transport(&wire) {
            // Either it no longer parses as a consistent wire, or it parses but fails verify.
            Ok(bad) => assert!(!bad.verify(), "corrupted wire must not verify"),
            Err(_) => {}
        }
    }

    /// The signed wire is the first live payload that does NOT fit in a single APDU-sized frame:
    /// `WIRE_LEN` (292) > `DEFAULT_MAX_CHUNK` (240), so it fragments into exactly 2 frames (240 +
    /// 52). Prove the chunking path round-trips the real 292-byte wire byte-identical, both at the
    /// raw frame layer (fragment → reassemble) and through the full card⇆reader conductor.
    #[test]
    fn signed_wire_spans_two_frames_and_round_trips() {
        let (wire, se) = real_signed_wire();

        // Sanity: the wire really is 292 bytes and really needs 2 frames at the production chunk.
        assert_eq!(wire.len(), WIRE_LEN);
        assert!(WIRE_LEN > super::DEFAULT_MAX_CHUNK, "wire must exceed one frame");
        let nframes = WIRE_LEN.div_ceil(super::DEFAULT_MAX_CHUNK);
        assert_eq!(nframes, 2, "292 B / 240 B-per-frame = 2 frames");

        // Frame layer: fragment → reassemble is byte-identical (covers the multi-frame chunking path
        // with the exact production wire length, which the 1..=256 proptest range cannot reach).
        let frames = super::frame::fragment(&wire, super::DEFAULT_MAX_CHUNK).unwrap();
        assert_eq!(frames.len(), 2, "fragment emits exactly 2 frames");
        let mut r = super::frame::Reassembler::new();
        let mut reassembled = None;
        for f in &frames {
            reassembled = r.accept(&super::frame::Frame::parse(f).unwrap()).unwrap();
        }
        assert_eq!(reassembled.unwrap(), wire, "reassembled wire is byte-identical");

        // Full conductor: the 2-frame wire moves card → reader at the production chunk size and what
        // the reader reassembles verifies as the identical authorization.
        let req = PaymentRequest {
            to: se.auth.to, amount: se.auth.amount, nonce: se.auth.nonce,
            expiry: se.auth.expiry, currency: se.auth.currency,
            to_name: se.auth.to_name, memo: se.auth.memo,
        }
        .to_bytes()
        .to_vec();
        let mut card = CardSession::new(super::DEFAULT_MAX_CHUNK);
        let mut reader = ReaderConductor::new(&req, super::DEFAULT_MAX_CHUNK).unwrap();
        let mut approved = false;
        let mut delivered = None;
        for _ in 0..4000 {
            let cmd = reader.next_command().expect("reader has a command");
            let resp = card.process(&cmd);
            if card.awaiting_decision() && !approved {
                card.provide_wire(&wire).unwrap();
                approved = true;
            }
            match reader.handle_response(&resp).unwrap() {
                ReaderStep::Done(w) => {
                    delivered = Some(w);
                    break;
                }
                ReaderStep::Declined => panic!("unexpected decline"),
                _ => {}
            }
        }
        let delivered = delivered.expect("2-frame wire delivered");
        assert_eq!(delivered, wire, "byte-identical through the conductor");
        let recovered = wire_from_transport(&delivered).unwrap();
        assert!(recovered.verify(), "signature verifies after the 2-frame transport");
        assert_eq!(recovered, se);
    }

    /// A truncated transfer (wrong length) is rejected before the core parser saw it.
    #[test]
    fn short_transport_is_rejected() {
        assert_eq!(
            wire_from_transport(&[0u8; WIRE_LEN - 1]),
            Err(NfcError::Frame(super::frame::FrameError::ShortPayload))
        );
    }
}
