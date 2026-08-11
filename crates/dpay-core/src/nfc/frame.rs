//! Splitting a payload into ordered, self-describing frames and reassembling them with full
//! validation. Every inconsistency is a typed error — a receiver never guesses.

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
