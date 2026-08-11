//! Card side (the offline payer's HCE service).

use super::apdu::{CommandApdu, ResponseApdu, Sw};
use super::frame::{self, Reassembler};
use super::{
    AID, CardPhase, CLA_ISO, CLA_PROP, INS_GET_WIRE, INS_PUT_RECEIPT, INS_PUT_REQUEST,
    INS_SELECT, NfcError, P1_SELECT_BY_NAME, PROTO_VERSION, SessionPhase,
};

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
    /// [`DEFAULT_MAX_CHUNK`](super::DEFAULT_MAX_CHUNK) in production; tests use small values to force
    /// multi-frame paths.
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
    /// [`SessionPhase`](super::SessionPhase) returned by [`phase`](Self::phase)).
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
