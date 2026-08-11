//! Reader side (the online merchant).

use super::apdu::{CommandApdu, ResponseApdu, Sw};
use super::frame::{self, Reassembler};
use super::{
    build_select, CardPhase, CLA_PROP, INS_GET_WIRE, INS_PUT_RECEIPT, INS_PUT_REQUEST, NfcError,
    PROTO_VERSION, SessionPhase,
};

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
    /// Prepare to push `request` (the merchant's [`PaymentRequest`](crate::PaymentRequest) bytes) and
    /// pull the payer's wire, fragmenting outgoing/incoming payloads at `max_chunk`. Errors if the
    /// request can't be framed.
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
