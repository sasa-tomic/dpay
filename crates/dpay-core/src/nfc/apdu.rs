//! ISO 7816-4 command/response APDU (de)serialization. Only the short-form cases dpay emits are
//! supported; extended-length is explicitly rejected rather than silently mis-parsed.

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
