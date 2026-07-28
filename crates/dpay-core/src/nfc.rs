//! nfc — NFC (ISO 7816-4 / ISO-DEP) transport framing for dpay.
//!
//! This module is a **pure, panic-free byte codec**. It carries the *exact same bytes* the QR path
//! already moves — the 68-byte [`PaymentRequest`](crate::PaymentRequest) and the 196-byte signed
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
//! `seq(1) | flags(1) | total_len(2, big-endian)`. Today's two payloads each fit in a single frame,
//! but the chunking path is built and tested now because retrofitting it later is where corruption
//! creeps in (Android's `IsoDep` max-transceive length can be as low as ~253 bytes on some stacks).
//!
//! ## No collision with Google Wallet
//!
//! [`AID`] is a proprietary (`0xF0`-prefixed) application id and the Android HCE service that owns it
//! is registered under `android:category="other"`, **not** `"payment"`. Google Wallet registers the
//! EMV payment AIDs under the payment category and owns the tap-to-pay default; dpay claims neither,
//! so the OS never routes a POS tap to dpay nor a dpay tap to Wallet. Routing is by AID, and this one
//! is dpay's alone.

use crate::{PaymentRequest, Receipt, SignedAuthorization, RECEIPT_LEN, REQUEST_LEN, WIRE_LEN};

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
/// `IsoDep` max-transceive length. Both live payloads (68 B request, 196 B wire) fit in one frame.
pub const DEFAULT_MAX_CHUNK: usize = 240;

/// Hard ceiling on a reassembled payload — the `total_len` header is a `u16`, and this also bounds
/// the buffer a hostile peer can make us allocate.
pub const MAX_PAYLOAD: usize = u16::MAX as usize;

/// A payload may span at most this many frames (`seq` is a single byte).
pub const MAX_FRAMES: usize = 256;

// ===========================================================================
// APDU layer (ISO 7816-4)
// ===========================================================================

/// ISO 7816-4 command/response APDU (de)serialization. Only the short-form cases dpay emits are
/// supported; extended-length is explicitly rejected rather than silently mis-parsed.
pub mod apdu {
    /// Anything malformed at the APDU byte level. Never panics; callers turn this into an error
    /// status word on the card side or a hard failure on the reader side.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum ApduError {
        /// Fewer bytes than the minimum (4 for a command header, 2 for a response trailer).
        Short,
        /// `Lc` disagrees with the number of data bytes actually present.
        BadLc,
        /// Extended-length (`Lc`/`Le` == 0 with more bytes) — dpay never emits it; refuse it.
        Unsupported,
    }

    /// A 2-byte ISO status word. Compared by value; the named constants cover every SW dpay uses.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub struct Sw(pub u16);

    impl Sw {
        /// Normal completion.
        pub const OK: Sw = Sw(0x9000);
        /// Command out of sequence / no request context yet, and (payer side) approval still pending.
        /// The reader treats this as "back off and poll / re-tap", not a hard error.
        pub const NOT_READY: Sw = Sw(0x6210);
        /// The payer declined the payment. Terminal.
        pub const DECLINED: Sw = Sw(0x6985);
        /// A length was wrong (bad APDU, or a frame that didn't fit its own header).
        pub const WRONG_LENGTH: Sw = Sw(0x6700);
        /// SELECT named an AID this card does not serve (i.e. not dpay).
        pub const NOT_FOUND: Sw = Sw(0x6A82);
        /// The command data field was structurally invalid (a malformed / out-of-order frame).
        pub const BAD_DATA: Sw = Sw(0x6A80);
        /// Unknown instruction byte.
        pub const INS_NOT_SUPPORTED: Sw = Sw(0x6D00);
        /// Unknown class byte.
        pub const CLA_NOT_SUPPORTED: Sw = Sw(0x6E00);

        /// `61 XX` — "more data available", `XX` a hint at bytes remaining (0 when unknown). Signals
        /// the reader to keep pulling. The frame's own LAST flag remains authoritative for framing.
        pub fn more(remaining_hint: u8) -> Sw {
            Sw(0x6100 | remaining_hint as u16)
        }

        pub fn hi(self) -> u8 {
            (self.0 >> 8) as u8
        }
        pub fn lo(self) -> u8 {
            (self.0 & 0xff) as u8
        }
        pub fn is_ok(self) -> bool {
            self == Sw::OK
        }
        /// True for the `61 XX` family (more data available).
        pub fn is_more(self) -> bool {
            self.0 & 0xff00 == 0x6100
        }
    }

    /// A parsed command APDU. `data` is the command data field (may be empty); `le` is the expected
    /// response length when present (`Some(256)` encodes the `0x00` "up to 256" short form).
    #[derive(Clone, PartialEq, Eq, Debug)]
    pub struct CommandApdu {
        pub cla: u8,
        pub ins: u8,
        pub p1: u8,
        pub p2: u8,
        pub data: Vec<u8>,
        pub le: Option<u16>,
    }

    impl CommandApdu {
        /// Build a command carrying `data` (case 3) or `data` + an expected response length (case 4).
        pub fn with_data(cla: u8, ins: u8, p1: u8, p2: u8, data: Vec<u8>, le: Option<u16>) -> Self {
            CommandApdu { cla, ins, p1, p2, data, le }
        }

        /// Build a command with no data field but an expected response length (case 2) — used to
        /// pull a response (e.g. GET WIRE).
        pub fn expecting(cla: u8, ins: u8, p1: u8, p2: u8, le: u16) -> Self {
            CommandApdu { cla, ins, p1, p2, data: Vec::new(), le: Some(le) }
        }

        /// Serialize to short-form APDU bytes. Panics only on a caller bug (data > 255 bytes); dpay's
        /// frames are always ≤ `DEFAULT_MAX_CHUNK + 4`, well under the limit, and this is asserted.
        pub fn encode(&self) -> Vec<u8> {
            debug_assert!(self.data.len() <= 255, "short-form APDU data must be <= 255 bytes");
            let mut out = Vec::with_capacity(4 + 1 + self.data.len() + 1);
            out.extend_from_slice(&[self.cla, self.ins, self.p1, self.p2]);
            if !self.data.is_empty() {
                out.push(self.data.len() as u8); // Lc
                out.extend_from_slice(&self.data);
            }
            if let Some(le) = self.le {
                // 256 encodes as 0x00 in short form; any other value is a single byte.
                out.push(if le == 256 { 0x00 } else { le as u8 });
            }
            out
        }

        /// Parse short-form APDU bytes (ISO cases 1–4). Extended-length is rejected as `Unsupported`.
        pub fn parse(b: &[u8]) -> Result<CommandApdu, ApduError> {
            if b.len() < 4 {
                return Err(ApduError::Short);
            }
            let (cla, ins, p1, p2) = (b[0], b[1], b[2], b[3]);
            let rest = &b[4..];
            let mk = |data: Vec<u8>, le: Option<u16>| {
                Ok(CommandApdu { cla, ins, p1, p2, data, le })
            };
            match rest.len() {
                // Case 1: header only.
                0 => mk(Vec::new(), None),
                // Case 2: header + Le.
                1 => mk(Vec::new(), Some(expand_short(rest[0]))),
                _ => {
                    let lc = rest[0] as usize;
                    if lc == 0 {
                        return Err(ApduError::Unsupported); // extended-length marker
                    }
                    let body = &rest[1..];
                    if body.len() == lc {
                        // Case 3: header + Lc + data.
                        mk(body.to_vec(), None)
                    } else if body.len() == lc + 1 {
                        // Case 4: header + Lc + data + Le.
                        mk(body[..lc].to_vec(), Some(expand_short(body[lc])))
                    } else {
                        Err(ApduError::BadLc)
                    }
                }
            }
        }
    }

    /// A parsed response APDU: data field (may be empty) followed by a 2-byte status word.
    #[derive(Clone, PartialEq, Eq, Debug)]
    pub struct ResponseApdu {
        pub data: Vec<u8>,
        pub sw: Sw,
    }

    impl ResponseApdu {
        pub fn new(data: Vec<u8>, sw: Sw) -> Self {
            ResponseApdu { data, sw }
        }
        /// A status-only response (empty data field).
        pub fn status(sw: Sw) -> Self {
            ResponseApdu { data: Vec::new(), sw }
        }
        pub fn encode(&self) -> Vec<u8> {
            let mut out = Vec::with_capacity(self.data.len() + 2);
            out.extend_from_slice(&self.data);
            out.push(self.sw.hi());
            out.push(self.sw.lo());
            out
        }
        pub fn parse(b: &[u8]) -> Result<ResponseApdu, ApduError> {
            if b.len() < 2 {
                return Err(ApduError::Short);
            }
            let split = b.len() - 2;
            let sw = Sw(((b[split] as u16) << 8) | b[split + 1] as u16);
            Ok(ResponseApdu { data: b[..split].to_vec(), sw })
        }
    }

    /// Short-form length byte semantics: `0x00` means "256"; anything else is its own value.
    fn expand_short(byte: u8) -> u16 {
        if byte == 0 {
            256
        } else {
            byte as u16
        }
    }
}

// ===========================================================================
// Frame layer (chunking + reassembly)
// ===========================================================================

/// Splitting a payload into ordered, self-describing frames and reassembling them with full
/// validation. Every inconsistency is a typed error — a receiver never guesses.
pub mod frame {
    use super::{MAX_FRAMES, MAX_PAYLOAD};

    /// Frame header length: `seq(1) | flags(1) | total_len(2, big-endian)`.
    pub const HEADER_LEN: usize = 4;
    /// `flags` bit 0: this is the final frame of the payload.
    pub const FLAG_LAST: u8 = 0x01;

    /// Anything wrong with a frame or the reassembled stream. All variants are `Copy`.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum FrameError {
        /// Fewer bytes than a header, or (on `fragment`) a zero-length max chunk.
        Short,
        /// A frame with no payload bytes (we never emit empty chunks).
        EmptyChunk,
        /// `max_chunk` was 0 — cannot make progress.
        BadChunkSize,
        /// The payload to send/receive is empty (both dpay payloads are fixed non-zero).
        Empty,
        /// Declared/derived payload exceeds [`MAX_PAYLOAD`].
        TooLarge,
        /// The payload would need more than [`MAX_FRAMES`] frames.
        TooManyFrames,
        /// A frame arrived with an unexpected `seq` (out of order, duplicated, or gapped).
        BadSequence,
        /// A later frame's `total_len` disagreed with the first frame's.
        InconsistentTotal,
        /// Accumulated bytes would exceed the declared total.
        Overflow,
        /// The LAST frame arrived but fewer bytes were accumulated than declared.
        ShortPayload,
        /// All declared bytes arrived but the frame carrying the last of them wasn't flagged LAST.
        MissingLast,
        /// A frame arrived after the payload was already complete.
        AlreadyComplete,
    }

    /// A borrowed view over one parsed frame.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub struct Frame<'a> {
        pub seq: u8,
        pub last: bool,
        pub total_len: u16,
        pub chunk: &'a [u8],
    }

    impl<'a> Frame<'a> {
        /// Parse a frame from an APDU data field. Rejects a truncated header or an empty chunk.
        pub fn parse(b: &'a [u8]) -> Result<Frame<'a>, FrameError> {
            if b.len() < HEADER_LEN {
                return Err(FrameError::Short);
            }
            let chunk = &b[HEADER_LEN..];
            if chunk.is_empty() {
                return Err(FrameError::EmptyChunk);
            }
            Ok(Frame {
                seq: b[0],
                last: b[1] & FLAG_LAST != 0,
                total_len: u16::from_be_bytes([b[2], b[3]]),
                chunk,
            })
        }
    }

    /// Serialize one frame (header + chunk).
    pub fn encode(seq: u8, last: bool, total_len: u16, chunk: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + chunk.len());
        out.push(seq);
        out.push(if last { FLAG_LAST } else { 0 });
        out.extend_from_slice(&total_len.to_be_bytes());
        out.extend_from_slice(chunk);
        out
    }

    /// Split `payload` into ordered frames of at most `max_chunk` payload bytes each. The last frame
    /// is flagged LAST. Errors on an empty payload, a zero chunk size, an over-large payload, or one
    /// that would need more than [`MAX_FRAMES`] frames.
    pub fn fragment(payload: &[u8], max_chunk: usize) -> Result<Vec<Vec<u8>>, FrameError> {
        if max_chunk == 0 {
            return Err(FrameError::BadChunkSize);
        }
        if payload.is_empty() {
            return Err(FrameError::Empty);
        }
        if payload.len() > MAX_PAYLOAD {
            return Err(FrameError::TooLarge);
        }
        let total_len = payload.len() as u16;
        let n = payload.len().div_ceil(max_chunk);
        if n > MAX_FRAMES {
            return Err(FrameError::TooManyFrames);
        }
        let mut frames = Vec::with_capacity(n);
        for (i, chunk) in payload.chunks(max_chunk).enumerate() {
            let last = i + 1 == n;
            frames.push(encode(i as u8, last, total_len, chunk));
        }
        Ok(frames)
    }

    /// Accumulates in-order frames into a payload, validating every step. One instance reassembles
    /// exactly one payload; after it returns the payload, further frames are an error.
    #[derive(Clone, Debug, Default)]
    pub struct Reassembler {
        total: Option<u16>,
        next_seq: u8,
        count: usize,
        buf: Vec<u8>,
        done: bool,
    }

    impl Reassembler {
        pub fn new() -> Self {
            Reassembler::default()
        }

        /// True once the payload has been fully received (and returned once).
        pub fn is_done(&self) -> bool {
            self.done
        }

        /// Feed the next frame. Returns `Ok(Some(payload))` when the payload is complete,
        /// `Ok(None)` when more frames are expected, or a typed error on any inconsistency.
        pub fn accept(&mut self, frame: &Frame) -> Result<Option<Vec<u8>>, FrameError> {
            if self.done {
                return Err(FrameError::AlreadyComplete);
            }
            if frame.seq != self.next_seq {
                return Err(FrameError::BadSequence);
            }
            if self.count >= MAX_FRAMES {
                return Err(FrameError::TooManyFrames);
            }

            // First frame fixes the total length (and bounds the buffer we'll allocate).
            let total = match self.total {
                None => {
                    let t = frame.total_len as usize;
                    if t == 0 {
                        return Err(FrameError::Empty);
                    }
                    if t > MAX_PAYLOAD {
                        return Err(FrameError::TooLarge);
                    }
                    self.total = Some(frame.total_len);
                    self.buf.reserve(t);
                    t
                }
                Some(t) => {
                    if t != frame.total_len {
                        return Err(FrameError::InconsistentTotal);
                    }
                    t as usize
                }
            };

            let running_after = self.buf.len() + frame.chunk.len();
            if running_after > total {
                return Err(FrameError::Overflow);
            }
            if frame.last {
                if running_after != total {
                    return Err(FrameError::ShortPayload);
                }
            } else if running_after == total {
                // Every declared byte arrived but the sender didn't flag the final frame.
                return Err(FrameError::MissingLast);
            }

            self.buf.extend_from_slice(frame.chunk);
            self.count += 1;
            self.next_seq = self.next_seq.wrapping_add(1);

            if frame.last {
                self.done = true;
                Ok(Some(std::mem::take(&mut self.buf)))
            } else {
                Ok(None)
            }
        }
    }
}

// ===========================================================================
// Protocol layer (dpay HCE ↔ reader)
// ===========================================================================

use apdu::{CommandApdu, ResponseApdu, Sw};
use frame::{FrameError, Reassembler};

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
// Card side (the offline payer's HCE service)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CardState {
    /// Waiting for the initial SELECT.
    AwaitingSelect,
    /// SELECTed; receiving request frames.
    Collecting,
    /// The full request is held; waiting for the app to approve (`provide_wire`) or `decline`.
    RequestReady,
    /// A signed wire is fragmented and being served frame by frame.
    Serving,
    /// The payer declined; every pull returns `DECLINED`.
    Declined,
    /// The wire was fully served; the merchant is settling online (payer awaits the receipt).
    Done,
    /// The merchant's settlement receipt arrived — the payer knows the outcome.
    Confirmed,
}

/// The payer-side (HCE card) half of the exchange. Drop-in for Android's
/// `HostApduService.processCommandApdu`: hand it each command APDU's bytes, send back the bytes it
/// returns. It never panics and never ignores a bad input — every malformed or out-of-sequence
/// command yields a defined error status word, and the app-facing calls return typed errors.
///
/// Lifecycle: `process` a SELECT, then `process` the reader's request frames until [`request`]
/// returns the bytes; show the payer "Pay $X to <merchant>"; then either [`provide_wire`] (approve)
/// or [`decline`]. Re-tapping (a fresh SELECT) is handled without losing an approved wire.
#[derive(Clone, Debug)]
pub struct CardSession {
    state: CardState,
    max_chunk: usize,
    reasm: Reassembler,
    request: Vec<u8>,
    wire_frames: Vec<Vec<u8>>,
    send_idx: usize,
    receipt_reasm: Reassembler,
    receipt: Vec<u8>,
}

impl CardSession {
    /// Create a session that will fragment its outgoing wire into `max_chunk`-byte frames. Pass
    /// [`DEFAULT_MAX_CHUNK`] in production; tests use small values to force multi-frame paths.
    pub fn new(max_chunk: usize) -> Self {
        CardSession {
            state: CardState::AwaitingSelect,
            max_chunk: max_chunk.max(1),
            reasm: Reassembler::new(),
            request: Vec::new(),
            wire_frames: Vec::new(),
            send_idx: 0,
            receipt_reasm: Reassembler::new(),
            receipt: Vec::new(),
        }
    }

    /// The received payment request, once fully collected (and until the session is reset by a
    /// SELECT that restarts collection). This is what the app decodes to show the payer.
    pub fn request(&self) -> Option<&[u8]> {
        match self.state {
            CardState::RequestReady | CardState::Serving | CardState::Done | CardState::Confirmed => {
                Some(&self.request)
            }
            _ => None,
        }
    }

    /// True exactly when the app must make a decision: a request is held and no wire is provided yet.
    pub fn awaiting_decision(&self) -> bool {
        self.state == CardState::RequestReady
    }

    /// Lifecycle phase for the payer-side UI status indicator.
    pub fn phase(&self) -> SessionPhase {
        match self.state {
            CardState::AwaitingSelect => SessionPhase::Idle,
            CardState::Collecting => SessionPhase::Linking,
            CardState::RequestReady => SessionPhase::AwaitingApproval,
            CardState::Serving => SessionPhase::Exchanging,
            CardState::Done => SessionPhase::Settling,
            CardState::Confirmed => SessionPhase::Complete,
            CardState::Declined => SessionPhase::Declined,
        }
    }

    /// True once the merchant has pulled the entire signed wire (the wire left the phone). The final
    /// outcome is not known until [`receipt`](Self::receipt) arrives.
    pub fn is_complete(&self) -> bool {
        matches!(self.state, CardState::Done | CardState::Confirmed)
    }

    /// The merchant's settlement receipt bytes, once it has arrived (decode with
    /// [`crate::Receipt::from_bytes`]). `None` until then. This is how the *offline* payer learns
    /// whether the payment settled.
    pub fn receipt(&self) -> Option<&[u8]> {
        if self.state == CardState::Confirmed { Some(&self.receipt) } else { None }
    }

    /// True once the receipt has arrived (the tap is fully complete).
    pub fn is_confirmed(&self) -> bool {
        self.state == CardState::Confirmed
    }

    /// Approve: supply the offline-signed wire to serve to the reader. Must be called in the
    /// `RequestReady` state (there is a held request and no decision yet); otherwise `WrongState`.
    /// The wire is validated by fragmenting it — an empty or over-large wire is a typed error.
    pub fn provide_wire(&mut self, wire: &[u8]) -> Result<(), NfcError> {
        if self.state != CardState::RequestReady {
            return Err(NfcError::WrongState);
        }
        self.wire_frames = frame::fragment(wire, self.max_chunk)?;
        self.send_idx = 0;
        self.state = CardState::Serving;
        Ok(())
    }

    /// Decline: the payer rejected the payment. Every subsequent pull returns `DECLINED`. Valid from
    /// `Collecting`/`RequestReady`; a no-op-safe `WrongState` otherwise.
    pub fn decline(&mut self) -> Result<(), NfcError> {
        match self.state {
            CardState::Collecting | CardState::RequestReady => {
                self.state = CardState::Declined;
                Ok(())
            }
            _ => Err(NfcError::WrongState),
        }
    }

    /// The on-the-wire phase byte reported in the SELECT greeting (distinct from the UI-facing
    /// [`SessionPhase`] returned by [`phase`](Self::phase)).
    fn wire_phase(&self) -> CardPhase {
        match self.state {
            CardState::RequestReady => CardPhase::HasRequest,
            CardState::Serving | CardState::Done => CardPhase::Serving,
            _ => CardPhase::Collecting,
        }
    }

    /// Process one command APDU and return the response APDU bytes. Total function: any error maps to
    /// a status word, never a panic.
    pub fn process(&mut self, command: &[u8]) -> Vec<u8> {
        let cmd = match CommandApdu::parse(command) {
            Ok(c) => c,
            // A frame that doesn't even parse as an APDU: report a length error and hold state.
            Err(_) => return ResponseApdu::status(Sw::WRONG_LENGTH).encode(),
        };
        let resp = match (cmd.cla, cmd.ins) {
            (CLA_ISO, INS_SELECT) => self.on_select(&cmd),
            (CLA_PROP, INS_PUT_REQUEST) => self.on_put_request(&cmd),
            (CLA_PROP, INS_GET_WIRE) => self.on_get_wire(),
            (CLA_PROP, INS_PUT_RECEIPT) => self.on_put_receipt(&cmd),
            (CLA_PROP, _) => ResponseApdu::status(Sw::INS_NOT_SUPPORTED),
            _ => ResponseApdu::status(Sw::CLA_NOT_SUPPORTED),
        };
        resp.encode()
    }

    fn on_select(&mut self, cmd: &CommandApdu) -> ResponseApdu {
        if cmd.p1 != P1_SELECT_BY_NAME || cmd.data != AID {
            return ResponseApdu::status(Sw::NOT_FOUND);
        }
        // A SELECT (re)starts the channel. Preserve an approved wire or a held request across a
        // re-tap; a decline is sticky (the merchant must learn it even if it re-taps before pulling);
        // otherwise (fresh, or fully served) begin collection anew.
        match self.state {
            // Sticky decline: refuse selection so a re-tapping reader gets the DECLINED verdict
            // instead of silently restarting collection.
            CardState::Declined => return ResponseApdu::status(Sw::DECLINED),
            CardState::Serving | CardState::Done | CardState::Confirmed => {
                self.send_idx = 0;
                self.state = CardState::Serving;
            }
            CardState::RequestReady => { /* keep the held request; still awaiting a decision */ }
            _ => {
                self.reasm = Reassembler::new();
                self.request.clear();
                self.state = CardState::Collecting;
            }
        }
        ResponseApdu::new(vec![PROTO_VERSION, self.wire_phase().byte()], Sw::OK)
    }

    fn on_put_request(&mut self, cmd: &CommandApdu) -> ResponseApdu {
        if self.state != CardState::Collecting {
            // Request pushed before SELECT, or after we already have one: out of sequence.
            return ResponseApdu::status(Sw::NOT_READY);
        }
        let frame = match frame::Frame::parse(&cmd.data) {
            Ok(f) => f,
            Err(_) => {
                self.reset_collection();
                return ResponseApdu::status(Sw::BAD_DATA);
            }
        };
        match self.reasm.accept(&frame) {
            Ok(Some(payload)) => {
                self.request = payload;
                self.state = CardState::RequestReady;
                ResponseApdu::status(Sw::OK)
            }
            Ok(None) => ResponseApdu::status(Sw::OK),
            Err(_) => {
                // A framing violation mid-transfer aborts this attempt; the reader must re-SELECT
                // and start over (which is exactly what it does on seeing a non-OK status here).
                self.reset_collection();
                ResponseApdu::status(Sw::BAD_DATA)
            }
        }
    }

    fn reset_collection(&mut self) {
        self.reasm = Reassembler::new();
        self.request.clear();
        self.state = CardState::Collecting;
    }

    fn on_get_wire(&mut self) -> ResponseApdu {
        match self.state {
            CardState::Declined => ResponseApdu::status(Sw::DECLINED),
            // Awaiting a decision, or no request context at all: not ready to serve yet.
            CardState::RequestReady | CardState::AwaitingSelect | CardState::Collecting => {
                ResponseApdu::status(Sw::NOT_READY)
            }
            CardState::Serving => {
                let frame = self.wire_frames[self.send_idx].clone();
                self.send_idx += 1;
                if self.send_idx == self.wire_frames.len() {
                    self.state = CardState::Done;
                    ResponseApdu::new(frame, Sw::OK)
                } else {
                    let remaining = (self.wire_frames.len() - self.send_idx).min(0xff) as u8;
                    ResponseApdu::new(frame, Sw::more(remaining))
                }
            }
            // Fully served already; a stray pull after completion is benign — nothing more to send.
            CardState::Done | CardState::Confirmed => ResponseApdu::status(Sw::OK),
        }
    }

    /// Accept the merchant's settlement receipt (sent after it settles online, over the same tap).
    /// Valid only once the wire has been fully served (state `Done`); otherwise it's out of sequence.
    fn on_put_receipt(&mut self, cmd: &CommandApdu) -> ResponseApdu {
        if self.state != CardState::Done {
            return ResponseApdu::status(Sw::NOT_READY);
        }
        let frame = match frame::Frame::parse(&cmd.data) {
            Ok(f) => f,
            Err(_) => return ResponseApdu::status(Sw::BAD_DATA),
        };
        match self.receipt_reasm.accept(&frame) {
            Ok(Some(payload)) => {
                self.receipt = payload;
                self.state = CardState::Confirmed;
                ResponseApdu::status(Sw::OK)
            }
            Ok(None) => ResponseApdu::status(Sw::OK),
            Err(_) => ResponseApdu::status(Sw::BAD_DATA),
        }
    }
}

// ---------------------------------------------------------------------------
// Reader side (the online merchant)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ReaderState {
    /// Need to (re)send SELECT.
    NeedSelect,
    /// Pushing request frames; `push_idx` is the next to send.
    Pushing,
    /// Pulling wire frames.
    Pulling,
    /// The wire is in hand; the merchant settles online, then calls `provide_receipt`.
    Done,
    /// Pushing the settlement receipt back to the payer.
    PushingReceipt,
    /// The receipt was delivered — the payer has been told the outcome.
    Confirmed,
    /// The payer declined.
    Declined,
}

/// What the reader should do after a response is fed in.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReaderStep {
    /// Send the next command from [`ReaderConductor::next_command`].
    Continue,
    /// The card is holding the request but the payer hasn't decided yet. The caller should keep
    /// polling (a held field) or wait and re-tap; `next_command` re-SELECTs so a re-tap resumes.
    Pending,
    /// The full signed wire — verify it and submit to the relay/canister. The merchant then settles
    /// online and calls [`ReaderConductor::provide_receipt`] to hand the outcome back to the payer.
    Done(Vec<u8>),
    /// The settlement receipt was delivered to the payer — the tap is fully complete.
    Confirmed,
    /// The payer declined; abandon the sale.
    Declined,
}

/// The merchant-side (NFC reader) half. Owns the request to push and reassembles the returned wire.
/// The platform loop is: `while let Some(cmd) = c.next_command() { step = c.handle_response(transceive(cmd))?; ... }`.
#[derive(Clone, Debug)]
pub struct ReaderConductor {
    state: ReaderState,
    req_frames: Vec<Vec<u8>>,
    push_idx: usize,
    reasm: Reassembler,
    max_chunk: usize,
    receipt_frames: Vec<Vec<u8>>,
    receipt_idx: usize,
}

impl ReaderConductor {
    /// Prepare to push `request` (the merchant's [`PaymentRequest`] bytes) and pull the payer's wire,
    /// fragmenting outgoing/incoming payloads at `max_chunk`. Errors if the request can't be framed.
    pub fn new(request: &[u8], max_chunk: usize) -> Result<Self, NfcError> {
        let req_frames = frame::fragment(request, max_chunk)?;
        Ok(ReaderConductor {
            state: ReaderState::NeedSelect,
            req_frames,
            push_idx: 0,
            reasm: Reassembler::new(),
            max_chunk: max_chunk.max(1),
            receipt_frames: Vec::new(),
            receipt_idx: 0,
        })
    }

    /// Lifecycle phase for the merchant-side UI status indicator. Note the reader cannot itself see
    /// `AwaitingApproval` as a *state* (after a NOT_READY it re-selects); the app derives that from
    /// a [`ReaderStep::Pending`] return instead. The other phases map directly.
    pub fn phase(&self) -> SessionPhase {
        match self.state {
            ReaderState::NeedSelect => SessionPhase::Linking,
            ReaderState::Pushing | ReaderState::Pulling => SessionPhase::Exchanging,
            ReaderState::Done | ReaderState::PushingReceipt => SessionPhase::Settling,
            ReaderState::Confirmed => SessionPhase::Complete,
            ReaderState::Declined => SessionPhase::Declined,
        }
    }

    /// After a [`ReaderStep::Done`], the merchant settles online and then calls this with the
    /// settlement `receipt` bytes ([`crate::Receipt::to_bytes`]) to hand the outcome back to the
    /// payer over the same tap. Resume the transceive loop afterwards. Valid only in the `Done`
    /// state; errors if the receipt can't be framed.
    pub fn provide_receipt(&mut self, receipt: &[u8]) -> Result<(), NfcError> {
        if self.state != ReaderState::Done {
            return Err(NfcError::WrongState);
        }
        self.receipt_frames = frame::fragment(receipt, self.max_chunk)?;
        self.receipt_idx = 0;
        self.state = ReaderState::PushingReceipt;
        Ok(())
    }

    /// The next command APDU to transceive, or `None` when the caller must act: at `Done` (settle
    /// online, then [`provide_receipt`](Self::provide_receipt)) or when the exchange is terminal
    /// (`Confirmed`/`Declined`).
    pub fn next_command(&self) -> Option<Vec<u8>> {
        match self.state {
            ReaderState::NeedSelect => Some(build_select()),
            ReaderState::Pushing => Some(
                CommandApdu::with_data(
                    CLA_PROP,
                    INS_PUT_REQUEST,
                    0,
                    0,
                    self.req_frames[self.push_idx].clone(),
                    None,
                )
                .encode(),
            ),
            ReaderState::Pulling => {
                Some(CommandApdu::expecting(CLA_PROP, INS_GET_WIRE, 0, 0, 256).encode())
            }
            ReaderState::PushingReceipt => Some(
                CommandApdu::with_data(
                    CLA_PROP,
                    INS_PUT_RECEIPT,
                    0,
                    0,
                    self.receipt_frames[self.receipt_idx].clone(),
                    None,
                )
                .encode(),
            ),
            ReaderState::Done | ReaderState::Confirmed | ReaderState::Declined => None,
        }
    }

    /// Feed the response to the command `next_command` returned. Advances the state machine and
    /// says what to do next. Errors on a malformed response or a status word invalid for this step.
    pub fn handle_response(&mut self, response: &[u8]) -> Result<ReaderStep, NfcError> {
        let resp = ResponseApdu::parse(response)?;
        match self.state {
            ReaderState::NeedSelect => self.after_select(&resp),
            ReaderState::Pushing => self.after_push(&resp),
            ReaderState::Pulling => self.after_pull(&resp),
            ReaderState::PushingReceipt => self.after_receipt_push(&resp),
            // Terminal, or waiting for the app to settle + provide_receipt: no response expected.
            ReaderState::Done | ReaderState::Confirmed | ReaderState::Declined => {
                Err(NfcError::WrongState)
            }
        }
    }

    fn after_receipt_push(&mut self, resp: &ResponseApdu) -> Result<ReaderStep, NfcError> {
        if !resp.sw.is_ok() {
            return Err(NfcError::UnexpectedStatus(resp.sw.0));
        }
        self.receipt_idx += 1;
        if self.receipt_idx == self.receipt_frames.len() {
            self.state = ReaderState::Confirmed;
            Ok(ReaderStep::Confirmed)
        } else {
            Ok(ReaderStep::Continue)
        }
    }

    fn after_select(&mut self, resp: &ResponseApdu) -> Result<ReaderStep, NfcError> {
        if resp.sw == Sw::NOT_FOUND {
            return Err(NfcError::NotDpay);
        }
        // A sticky decline can surface on (re-)SELECT if the payer rejected during the poll window.
        if resp.sw == Sw::DECLINED {
            self.state = ReaderState::Declined;
            return Ok(ReaderStep::Declined);
        }
        if !resp.sw.is_ok() {
            return Err(NfcError::UnexpectedStatus(resp.sw.0));
        }
        if resp.data.len() < 2 {
            return Err(NfcError::ShortGreeting);
        }
        let version = resp.data[0];
        if version != PROTO_VERSION {
            return Err(NfcError::UnsupportedVersion(version));
        }
        let phase = CardPhase::from_byte(resp.data[1]).ok_or(NfcError::NotDpay)?;
        match phase {
            // The card has no request — push ours from the start (re-fragment idempotently).
            CardPhase::Collecting => {
                self.push_idx = 0;
                self.reasm = Reassembler::new();
                self.state = ReaderState::Pushing;
            }
            // The card already holds our request (re-tap after a push) — skip straight to pulling.
            CardPhase::HasRequest | CardPhase::Serving => {
                self.reasm = Reassembler::new();
                self.state = ReaderState::Pulling;
            }
        }
        Ok(ReaderStep::Continue)
    }

    fn after_push(&mut self, resp: &ResponseApdu) -> Result<ReaderStep, NfcError> {
        if !resp.sw.is_ok() {
            // The card rejected a frame (e.g. BAD_DATA). Restart cleanly with a fresh SELECT.
            self.state = ReaderState::NeedSelect;
            return Err(NfcError::UnexpectedStatus(resp.sw.0));
        }
        self.push_idx += 1;
        if self.push_idx == self.req_frames.len() {
            self.state = ReaderState::Pulling;
        }
        Ok(ReaderStep::Continue)
    }

    fn after_pull(&mut self, resp: &ResponseApdu) -> Result<ReaderStep, NfcError> {
        if resp.sw == Sw::NOT_READY {
            // Card holds the request but the payer hasn't decided. Re-SELECT on the next command so
            // a physical re-tap resumes exactly where we left off.
            self.state = ReaderState::NeedSelect;
            return Ok(ReaderStep::Pending);
        }
        if resp.sw == Sw::DECLINED {
            self.state = ReaderState::Declined;
            return Ok(ReaderStep::Declined);
        }
        let last_expected = resp.sw.is_ok();
        if !last_expected && !resp.sw.is_more() {
            return Err(NfcError::UnexpectedStatus(resp.sw.0));
        }
        let frame = frame::Frame::parse(&resp.data)?;
        // The status word and the frame's LAST flag must agree: OK ⇔ last, 61xx ⇔ more.
        if frame.last != last_expected {
            return Err(NfcError::UnexpectedStatus(resp.sw.0));
        }
        match self.reasm.accept(&frame)? {
            Some(wire) => {
                self.state = ReaderState::Done;
                Ok(ReaderStep::Done(wire))
            }
            None => Ok(ReaderStep::Continue),
        }
    }
}

// ---------------------------------------------------------------------------
// Typed decoders over the transported payloads
// ---------------------------------------------------------------------------

/// Fragment a merchant [`PaymentRequest`] for the reader to push. Convenience over
/// [`ReaderConductor::new`] when you want the frames directly.
pub fn request_to_frames(req: &PaymentRequest, max_chunk: usize) -> Result<Vec<Vec<u8>>, NfcError> {
    Ok(frame::fragment(&req.to_bytes(), max_chunk)?)
}

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
                step @ (ReaderStep::Done(_) | ReaderStep::Declined | ReaderStep::Confirmed) => {
                    return Ok(Driven { step, card_request, pending_seen });
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
        PaymentRequest { to: [7u8; 32], amount: 4200, nonce: [9u8; 16], expiry: 4102444800, currency: crate::DEMO_USD }
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

        // Pull the wire → the wire has left the payer, but the outcome isn't known yet (Settling).
        let framed = card.process(&reader.next_command().unwrap());
        assert_eq!(card.phase(), SessionPhase::Settling);
        assert!(card.is_complete()); // the wire is out…
        assert!(!card.is_confirmed()); // …but not yet confirmed
        assert!(matches!(reader.handle_response(&framed).unwrap(), ReaderStep::Done(_)));
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
        let auth = Authorization { from, to: [7u8; 32], amount: 4200, nonce: [1u8; 16], expiry: 4102444800, currency: crate::DEMO_USD };
        let se = SignedAuthorization::new(&sk, auth);
        (se.to_wire().to_vec(), se)
    }

    /// The money shot: the offline-signed wire moves card→reader over NFC framing (single frame and
    /// heavily fragmented), and what the reader reassembles verifies as the identical authorization.
    #[test]
    fn signed_wire_survives_nfc_and_verifies() {
        let (wire, se) = real_signed_wire();
        let req = PaymentRequest { to: se.auth.to, amount: se.auth.amount, nonce: se.auth.nonce, expiry: se.auth.expiry, currency: se.auth.currency }
            .to_bytes()
            .to_vec();

        for max_chunk in [super::DEFAULT_MAX_CHUNK, 240, 64, 7, 1] {
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
    /// is backstopped by the same crypto the canister enforces.
    #[test]
    fn one_byte_corruption_fails_verification() {
        let (mut wire, _se) = real_signed_wire();
        wire[100] ^= 0x01; // flip a bit somewhere in the signed region
        match wire_from_transport(&wire) {
            // Either it no longer parses as a consistent wire, or it parses but fails verify.
            Ok(bad) => assert!(!bad.verify(), "corrupted wire must not verify"),
            Err(_) => {}
        }
    }

    /// A truncated transfer (wrong length) is rejected before the core parser sees it.
    #[test]
    fn short_transport_is_rejected() {
        assert_eq!(
            wire_from_transport(&[0u8; WIRE_LEN - 1]),
            Err(NfcError::Frame(super::frame::FrameError::ShortPayload))
        );
    }
}
