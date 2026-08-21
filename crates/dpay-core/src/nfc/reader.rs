//! Reader side (the online merchant).

use super::apdu::{CommandApdu, ResponseApdu, Sw};
use super::frame::{self, Reassembler};
use super::{
    build_select, CardPhase, NfcError, NfcResult, SessionPhase, CLA_PROP, INS_GET_WIRE,
    INS_PUT_REQUEST, INS_PUT_RESULT, PROTO_VERSION,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ReaderState {
    NeedSelect,
    PushingRequest,
    PullingWire,
    AwaitingResult,
    NeedAwaitingResultSelect,
    NeedResultSelect,
    PushingResult,
    Confirmed,
    Declined,
}

/// What the merchant should do after a response.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReaderStep {
    Continue,
    Pending,
    /// The full DPN2 bundle. Submit its update and poll with its read_state envelope.
    Done(Vec<u8>),
    /// A re-tapped card already received its bundle and is waiting only for the result.
    AwaitingResult,
    /// The signed result reached the payer and was verified there.
    Confirmed,
    Declined,
    WaitingForPayer,
}

/// Merchant-side conductor: request in, DPN2 bundle out, signed result back in.
#[derive(Clone, Debug)]
pub struct ReaderConductor {
    state: ReaderState,
    max_chunk: usize,
    request_frames: Vec<Vec<u8>>,
    request_idx: usize,
    wire_reasm: Reassembler,
    result_frames: Vec<Vec<u8>>,
    result_idx: usize,
}

impl ReaderConductor {
    pub fn new(request: &[u8], max_chunk: usize) -> Result<Self, NfcError> {
        Ok(ReaderConductor {
            state: ReaderState::NeedSelect,
            max_chunk: max_chunk.max(1),
            request_frames: frame::fragment(request, max_chunk)?,
            request_idx: 0,
            wire_reasm: Reassembler::new(),
            result_frames: Vec::new(),
            result_idx: 0,
        })
    }

    pub fn phase(&self) -> SessionPhase {
        match self.state {
            ReaderState::NeedSelect
            | ReaderState::NeedAwaitingResultSelect
            | ReaderState::NeedResultSelect => SessionPhase::Linking,
            ReaderState::PushingRequest | ReaderState::PullingWire | ReaderState::PushingResult => {
                SessionPhase::Exchanging
            }
            ReaderState::AwaitingResult => SessionPhase::Settling,
            ReaderState::Confirmed => SessionPhase::Complete,
            ReaderState::Declined => SessionPhase::Declined,
        }
    }

    pub fn next_command(&self) -> Option<Vec<u8>> {
        match self.state {
            ReaderState::NeedSelect
            | ReaderState::NeedAwaitingResultSelect
            | ReaderState::NeedResultSelect => Some(build_select()),
            ReaderState::PushingRequest => self.request_frames.get(self.request_idx).map(|frame| {
                CommandApdu::with_data(CLA_PROP, INS_PUT_REQUEST, 0, 0, frame.clone(), None)
                    .encode()
            }),
            ReaderState::PullingWire => {
                Some(CommandApdu::expecting(CLA_PROP, INS_GET_WIRE, 0, 0, 256).encode())
            }
            ReaderState::PushingResult => self.result_frames.get(self.result_idx).map(|frame| {
                CommandApdu::with_data(CLA_PROP, INS_PUT_RESULT, 0, 0, frame.clone(), None).encode()
            }),
            ReaderState::AwaitingResult | ReaderState::Confirmed | ReaderState::Declined => None,
        }
    }

    pub fn handle_response(&mut self, response: &[u8]) -> Result<ReaderStep, NfcError> {
        let response = ResponseApdu::parse(response)?;
        match self.state {
            ReaderState::NeedSelect => self.after_initial_select(&response),
            ReaderState::PushingRequest => self.after_request_frame(&response),
            ReaderState::PullingWire => self.after_wire_frame(&response),
            ReaderState::NeedAwaitingResultSelect => {
                self.after_awaiting_result_select(&response)
            }
            ReaderState::NeedResultSelect => self.after_result_select(&response),
            ReaderState::PushingResult => self.after_result_frame(&response),
            ReaderState::AwaitingResult | ReaderState::Confirmed | ReaderState::Declined => {
                Err(NfcError::WrongState)
            }
        }
    }

    /// Tell the conductor that the RF link was lost and the next command will run on a fresh link.
    ///
    /// Every non-terminal exchange restarts with SELECT. Request/result frames are retained but
    /// restart at frame zero, and a partial bundle reassembly is discarded because SELECT also
    /// makes the card restart bundle serving at frame zero. A completed bundle remains available to
    /// the caller while an outstanding merchant result is preserved. Terminal states stay terminal.
    pub fn reset_link(&mut self) {
        match self.state {
            ReaderState::NeedSelect
            | ReaderState::PushingRequest
            | ReaderState::PullingWire => {
                self.request_idx = 0;
                self.wire_reasm = Reassembler::new();
                self.state = ReaderState::NeedSelect;
            }
            ReaderState::AwaitingResult | ReaderState::NeedAwaitingResultSelect => {
                self.state = ReaderState::NeedAwaitingResultSelect;
            }
            ReaderState::NeedResultSelect | ReaderState::PushingResult => {
                self.result_idx = 0;
                self.state = ReaderState::NeedResultSelect;
            }
            ReaderState::Confirmed | ReaderState::Declined => {}
        }
    }

    /// Supply the merchant-signed fixed result after `Done`, or after a fresh conductor discovers an
    /// `AwaitingResult` card. Structural validation happens here; the card verifies signature and
    /// request binding.
    pub fn provide_result(&mut self, result: &[u8]) -> Result<(), NfcError> {
        if !matches!(
            self.state,
            ReaderState::AwaitingResult | ReaderState::NeedAwaitingResultSelect
        ) {
            return Err(NfcError::WrongState);
        }
        NfcResult::from_bytes(result)?;
        self.result_frames = frame::fragment(result, self.max_chunk)?;
        self.result_idx = 0;
        self.state = ReaderState::NeedResultSelect;
        Ok(())
    }

    fn status_before_select(response: &ResponseApdu) -> Result<Option<ReaderStep>, NfcError> {
        if response.sw == Sw::NOT_FOUND {
            return Err(NfcError::NotDpay);
        }
        if response.sw == Sw::DECLINED {
            return Ok(Some(ReaderStep::Declined));
        }
        if response.sw == Sw::NOT_READY {
            return Ok(Some(ReaderStep::WaitingForPayer));
        }
        if !response.sw.is_ok() {
            return Err(NfcError::UnexpectedStatus(response.sw.0));
        }
        Ok(None)
    }

    fn selected_phase(response: &ResponseApdu) -> Result<CardPhase, NfcError> {
        if response.data.len() < 2 {
            return Err(NfcError::ShortGreeting);
        }
        if response.data[0] != PROTO_VERSION {
            return Err(NfcError::UnsupportedVersion(response.data[0]));
        }
        CardPhase::from_byte(response.data[1]).ok_or(NfcError::NotDpay)
    }

    fn after_initial_select(&mut self, response: &ResponseApdu) -> Result<ReaderStep, NfcError> {
        if let Some(step) = Self::status_before_select(response)? {
            if step == ReaderStep::Declined {
                self.state = ReaderState::Declined;
            }
            return Ok(step);
        }
        match Self::selected_phase(response)? {
            CardPhase::Collecting => {
                self.request_idx = 0;
                self.wire_reasm = Reassembler::new();
                self.state = ReaderState::PushingRequest;
            }
            CardPhase::HasRequest | CardPhase::Serving => {
                self.wire_reasm = Reassembler::new();
                self.state = ReaderState::PullingWire;
            }
            CardPhase::AwaitingResult => {
                self.state = ReaderState::AwaitingResult;
                return Ok(ReaderStep::AwaitingResult);
            }
        }
        Ok(ReaderStep::Continue)
    }

    fn after_result_select(&mut self, response: &ResponseApdu) -> Result<ReaderStep, NfcError> {
        if let Some(step) = Self::status_before_select(response)? {
            if step == ReaderStep::Declined {
                self.state = ReaderState::Declined;
            }
            return Ok(step);
        }
        if Self::selected_phase(response)? != CardPhase::AwaitingResult {
            return Err(NfcError::WrongState);
        }
        self.result_idx = 0;
        self.state = ReaderState::PushingResult;
        Ok(ReaderStep::Continue)
    }

    fn after_awaiting_result_select(
        &mut self,
        response: &ResponseApdu,
    ) -> Result<ReaderStep, NfcError> {
        if let Some(step) = Self::status_before_select(response)? {
            if step == ReaderStep::Declined {
                self.state = ReaderState::Declined;
            }
            return Ok(step);
        }
        if Self::selected_phase(response)? != CardPhase::AwaitingResult {
            return Err(NfcError::WrongState);
        }
        self.state = ReaderState::AwaitingResult;
        Ok(ReaderStep::AwaitingResult)
    }

    fn after_request_frame(&mut self, response: &ResponseApdu) -> Result<ReaderStep, NfcError> {
        if !response.sw.is_ok() {
            self.state = ReaderState::NeedSelect;
            return Err(NfcError::UnexpectedStatus(response.sw.0));
        }
        self.request_idx += 1;
        if self.request_idx == self.request_frames.len() {
            self.state = ReaderState::PullingWire;
        }
        Ok(ReaderStep::Continue)
    }

    fn after_wire_frame(&mut self, response: &ResponseApdu) -> Result<ReaderStep, NfcError> {
        if response.sw == Sw::NOT_READY {
            self.state = ReaderState::NeedSelect;
            return Ok(ReaderStep::Pending);
        }
        if response.sw == Sw::DECLINED {
            self.state = ReaderState::Declined;
            return Ok(ReaderStep::Declined);
        }
        let last_expected = response.sw.is_ok();
        if !last_expected && !response.sw.is_more() {
            return Err(NfcError::UnexpectedStatus(response.sw.0));
        }
        let frame = frame::Frame::parse(&response.data)?;
        if frame.last != last_expected {
            return Err(NfcError::UnexpectedStatus(response.sw.0));
        }
        match self.wire_reasm.accept(&frame)? {
            Some(wire) => {
                self.state = ReaderState::AwaitingResult;
                Ok(ReaderStep::Done(wire))
            }
            None => Ok(ReaderStep::Continue),
        }
    }

    fn after_result_frame(&mut self, response: &ResponseApdu) -> Result<ReaderStep, NfcError> {
        if !response.sw.is_ok() {
            self.state = ReaderState::NeedResultSelect;
            return Err(NfcError::UnexpectedStatus(response.sw.0));
        }
        self.result_idx += 1;
        if self.result_idx == self.result_frames.len() {
            self.state = ReaderState::Confirmed;
            Ok(ReaderStep::Confirmed)
        } else {
            Ok(ReaderStep::Continue)
        }
    }
}
