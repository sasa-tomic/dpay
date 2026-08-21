//! Card side (the offline payer's HCE service).

use crate::PaymentRequest;

use super::apdu::{CommandApdu, ResponseApdu, Sw};
use super::frame::{self, Reassembler};
use super::{
    request_from_transport, CardPhase, NfcBundle, NfcError, NfcResult, SessionPhase, AID, CLA_ISO,
    CLA_PROP, INS_GET_WIRE, INS_PUT_REQUEST, INS_PUT_RESULT, INS_SELECT, P1_SELECT_BY_NAME,
    PROTO_VERSION,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CardState {
    AwaitingSelect,
    Collecting,
    RequestReady,
    Serving,
    AwaitingResult,
    Complete,
    Declined,
}

/// Payer-side HCE state machine. It receives a request, serves one validated DPN2 bundle, then
/// accepts exactly one merchant-signed result bound to that request. Completed sessions never replay
/// the bundle.
#[derive(Clone, Debug)]
pub struct CardSession {
    state: CardState,
    max_chunk: usize,
    request_reasm: Reassembler,
    result_reasm: Reassembler,
    request: Vec<u8>,
    parsed_request: Option<PaymentRequest>,
    request_id: Option<[u8; 32]>,
    wire_frames: Vec<Vec<u8>>,
    send_idx: usize,
    result: Option<NfcResult>,
}

impl CardSession {
    pub fn new(max_chunk: usize) -> Self {
        CardSession {
            state: CardState::AwaitingSelect,
            max_chunk: max_chunk.max(1),
            request_reasm: Reassembler::new(),
            result_reasm: Reassembler::new(),
            request: Vec::new(),
            parsed_request: None,
            request_id: None,
            wire_frames: Vec::new(),
            send_idx: 0,
            result: None,
        }
    }

    pub fn request(&self) -> Option<&[u8]> {
        match self.state {
            CardState::RequestReady
            | CardState::Serving
            | CardState::AwaitingResult
            | CardState::Complete => Some(&self.request),
            _ => None,
        }
    }

    pub fn awaiting_decision(&self) -> bool {
        self.state == CardState::RequestReady
    }

    pub fn phase(&self) -> SessionPhase {
        match self.state {
            CardState::AwaitingSelect => SessionPhase::Idle,
            CardState::Collecting => SessionPhase::Linking,
            CardState::RequestReady => SessionPhase::AwaitingApproval,
            CardState::Serving => SessionPhase::Exchanging,
            CardState::AwaitingResult => SessionPhase::Settling,
            CardState::Complete => SessionPhase::Complete,
            CardState::Declined => SessionPhase::Declined,
        }
    }

    /// True after the final bundle frame left the payer, including after the result completes.
    pub fn wire_delivered(&self) -> bool {
        matches!(self.state, CardState::AwaitingResult | CardState::Complete)
    }

    /// True only after a valid merchant result was received and verified.
    pub fn is_complete(&self) -> bool {
        self.state == CardState::Complete
    }

    pub fn result(&self) -> Option<&NfcResult> {
        self.result.as_ref()
    }

    /// Approve with a DPN2 bundle. The envelope payloads remain opaque, but the bundle framing is
    /// validated and its request id is retained to bind the later merchant result.
    pub fn provide_wire(&mut self, wire: &[u8]) -> Result<(), NfcError> {
        if self.state != CardState::RequestReady {
            return Err(NfcError::WrongState);
        }
        let request = request_from_transport(&self.request)?;
        let bundle = NfcBundle::decode(wire)?;
        let frames = frame::fragment(wire, self.max_chunk)?;

        self.parsed_request = Some(request);
        self.request_id = Some(bundle.request_id);
        self.wire_frames = frames;
        self.send_idx = 0;
        self.state = CardState::Serving;
        Ok(())
    }

    pub fn decline(&mut self) -> Result<(), NfcError> {
        match self.state {
            CardState::Collecting | CardState::RequestReady => {
                self.state = CardState::Declined;
                Ok(())
            }
            _ => Err(NfcError::WrongState),
        }
    }

    fn wire_phase(&self) -> CardPhase {
        match self.state {
            CardState::RequestReady => CardPhase::HasRequest,
            CardState::Serving => CardPhase::Serving,
            CardState::AwaitingResult => CardPhase::AwaitingResult,
            _ => CardPhase::Collecting,
        }
    }

    /// Total function over arbitrary command bytes: malformed/out-of-state commands become status
    /// words and never panic.
    pub fn process(&mut self, command: &[u8]) -> Vec<u8> {
        let cmd = match CommandApdu::parse(command) {
            Ok(c) => c,
            Err(_) => return ResponseApdu::status(Sw::WRONG_LENGTH).encode(),
        };
        let resp = match (cmd.cla, cmd.ins) {
            (CLA_ISO, INS_SELECT) => self.on_select(&cmd),
            (CLA_PROP, INS_PUT_REQUEST) => self.on_put_request(&cmd),
            (CLA_PROP, INS_GET_WIRE) => self.on_get_wire(),
            (CLA_PROP, INS_PUT_RESULT) => self.on_put_result(&cmd),
            (CLA_PROP, _) => ResponseApdu::status(Sw::INS_NOT_SUPPORTED),
            _ => ResponseApdu::status(Sw::CLA_NOT_SUPPORTED),
        };
        resp.encode()
    }

    fn on_select(&mut self, cmd: &CommandApdu) -> ResponseApdu {
        if cmd.p1 != P1_SELECT_BY_NAME || cmd.data != AID {
            return ResponseApdu::status(Sw::NOT_FOUND);
        }
        match self.state {
            CardState::Declined => return ResponseApdu::status(Sw::DECLINED),
            CardState::Serving => self.send_idx = 0,
            CardState::AwaitingResult => self.result_reasm = Reassembler::new(),
            CardState::Complete => return ResponseApdu::status(Sw::NOT_READY),
            CardState::RequestReady => {}
            CardState::AwaitingSelect | CardState::Collecting => self.reset_collection(),
        }
        ResponseApdu::new(vec![PROTO_VERSION, self.wire_phase().byte()], Sw::OK)
    }

    fn on_put_request(&mut self, cmd: &CommandApdu) -> ResponseApdu {
        if self.state != CardState::Collecting {
            return ResponseApdu::status(Sw::NOT_READY);
        }
        let frame = match frame::Frame::parse(&cmd.data) {
            Ok(frame) => frame,
            Err(_) => {
                self.reset_collection();
                return ResponseApdu::status(Sw::BAD_DATA);
            }
        };
        match self.request_reasm.accept(&frame) {
            Ok(Some(payload)) => {
                self.request = payload;
                self.state = CardState::RequestReady;
                ResponseApdu::status(Sw::OK)
            }
            Ok(None) => ResponseApdu::status(Sw::OK),
            Err(_) => {
                self.reset_collection();
                ResponseApdu::status(Sw::BAD_DATA)
            }
        }
    }

    fn reset_collection(&mut self) {
        self.request_reasm = Reassembler::new();
        self.request.clear();
        self.parsed_request = None;
        self.request_id = None;
        self.wire_frames.clear();
        self.send_idx = 0;
        self.result_reasm = Reassembler::new();
        self.result = None;
        self.state = CardState::Collecting;
    }

    fn on_get_wire(&mut self) -> ResponseApdu {
        match self.state {
            CardState::Declined => ResponseApdu::status(Sw::DECLINED),
            CardState::RequestReady | CardState::AwaitingSelect | CardState::Collecting => {
                ResponseApdu::status(Sw::NOT_READY)
            }
            CardState::Serving => {
                let Some(frame) = self.wire_frames.get(self.send_idx).cloned() else {
                    return ResponseApdu::status(Sw::BAD_DATA);
                };
                self.send_idx += 1;
                if self.send_idx == self.wire_frames.len() {
                    self.state = CardState::AwaitingResult;
                    ResponseApdu::new(frame, Sw::OK)
                } else {
                    let remaining = (self.wire_frames.len() - self.send_idx).min(0xff) as u8;
                    ResponseApdu::new(frame, Sw::more(remaining))
                }
            }
            CardState::AwaitingResult | CardState::Complete => ResponseApdu::status(Sw::NOT_READY),
        }
    }

    fn on_put_result(&mut self, cmd: &CommandApdu) -> ResponseApdu {
        if self.state != CardState::AwaitingResult {
            return ResponseApdu::status(Sw::NOT_READY);
        }
        let frame = match frame::Frame::parse(&cmd.data) {
            Ok(frame) => frame,
            Err(_) => {
                self.result_reasm = Reassembler::new();
                return ResponseApdu::status(Sw::BAD_DATA);
            }
        };
        match self.result_reasm.accept(&frame) {
            Ok(Some(bytes)) => {
                let verified = self
                    .parsed_request
                    .as_ref()
                    .zip(self.request_id.as_ref())
                    .ok_or(NfcError::BadMessage)
                    .and_then(|(request, request_id)| {
                        NfcResult::parse_and_verify(&bytes, &request.to, &request.nonce, request_id)
                    });
                match verified {
                    Ok(result) => {
                        self.result = Some(result);
                        self.state = CardState::Complete;
                        ResponseApdu::status(Sw::OK)
                    }
                    Err(_) => {
                        self.result_reasm = Reassembler::new();
                        ResponseApdu::status(Sw::BAD_DATA)
                    }
                }
            }
            Ok(None) => ResponseApdu::status(Sw::OK),
            Err(_) => {
                self.result_reasm = Reassembler::new();
                ResponseApdu::status(Sw::BAD_DATA)
            }
        }
    }
}
