//! Hand-rolled ICRC-1/2 candid (DIDL) encode/decode for the ledger surface:
//! `icrc1_transfer`, `icrc2_approve`, `icrc1_balance_of`, `icrc2_allowance` args
//! (precomputed type tables, golden-pinned) and the `TransferResult` / `ApproveResult`
//! / `nat` reply decoders.

use crate::principal::Account;
use crate::IcpError;

// --- precomputed type tables (extracted from `candid` 0.10.22 encodings; see tests/goldens.rs) ---
// TransferArg: rec{to:Account, fee:opt nat, memo:opt vec nat8, from_subaccount:opt vec nat8,
//                created_at_time:opt nat64, amount:nat}
const TRANSFER_PREFIX: [u8; 64] = [
    0x44, 0x49, 0x44, 0x4c, 0x06, 0x6c, 0x06, 0xfb, 0xca, 0x01, 0x01, 0xc6,
    0xfc, 0xb6, 0x02, 0x04, 0xba, 0x89, 0xe5, 0xc2, 0x04, 0x02, 0xa2, 0xde,
    0x94, 0xeb, 0x06, 0x02, 0x82, 0xf3, 0xf3, 0x91, 0x0c, 0x05, 0xd8, 0xa3,
    0x8c, 0xa8, 0x0d, 0x7d, 0x6c, 0x02, 0xb3, 0xb0, 0xda, 0xc3, 0x03, 0x68,
    0xad, 0x86, 0xca, 0x83, 0x05, 0x02, 0x6e, 0x03, 0x6d, 0x7b, 0x6e, 0x7d,
    0x6e, 0x78, 0x01, 0x00,
];
// ApproveArgs: rec{fee:opt nat, memo:opt vec nat8, from_subaccount:opt vec nat8,
//                  created_at_time:opt nat64, amount:nat, expected_allowance:opt nat,
//                  expires_at:opt nat64, spender:Account}
const APPROVE_PREFIX: [u8; 78] = [
    0x44, 0x49, 0x44, 0x4c, 0x06, 0x6c, 0x08, 0xc6, 0xfc, 0xb6, 0x02, 0x01,
    0xba, 0x89, 0xe5, 0xc2, 0x04, 0x02, 0xa2, 0xde, 0x94, 0xeb, 0x06, 0x02,
    0x82, 0xf3, 0xf3, 0x91, 0x0c, 0x04, 0xd8, 0xa3, 0x8c, 0xa8, 0x0d, 0x7d,
    0x91, 0x9c, 0x9c, 0xbf, 0x0d, 0x01, 0xde, 0xa7, 0xf7, 0xda, 0x0d, 0x04,
    0xcb, 0x96, 0xdc, 0xb4, 0x0e, 0x05, 0x6e, 0x7d, 0x6e, 0x03, 0x6d, 0x7b,
    0x6e, 0x78, 0x6c, 0x02, 0xb3, 0xb0, 0xda, 0xc3, 0x03, 0x68, 0xad, 0x86,
    0xca, 0x83, 0x05, 0x02, 0x01, 0x00,
];
// Account: rec{owner:principal, subaccount:opt vec nat8}
const ACCOUNT_PREFIX: [u8; 25] = [
    0x44, 0x49, 0x44, 0x4c, 0x03, 0x6c, 0x02, 0xb3, 0xb0, 0xda, 0xc3, 0x03,
    0x68, 0xad, 0x86, 0xca, 0x83, 0x05, 0x01, 0x6e, 0x02, 0x6d, 0x7b, 0x01,
    0x00,
];
// AllowanceArgs: rec{account:Account, spender:Account}
const ALLOWANCE_PREFIX: [u8; 39] = [
    0x44, 0x49, 0x44, 0x4c, 0x04, 0x6c, 0x02, 0xad, 0xf9, 0xe7, 0x8a, 0x0a,
    0x01, 0xcb, 0x96, 0xdc, 0xb4, 0x0e, 0x01, 0x6c, 0x02, 0xb3, 0xb0, 0xda,
    0xc3, 0x03, 0x68, 0xad, 0x86, 0xca, 0x83, 0x05, 0x02, 0x6e, 0x03, 0x6d,
    0x7b, 0x01, 0x00,
];

// --- value writers (values follow the type table in label-hash order; no field tags on wire) ---

fn put_uleb(out: &mut Vec<u8>, mut v: u128) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// principal wire form: class byte 1 (opaque) + uleb len + bytes.
fn put_principal(out: &mut Vec<u8>, p: &crate::principal::Principal) {
    out.push(0x01);
    put_uleb(out, p.as_slice().len() as u128);
    out.extend_from_slice(p.as_slice());
}

/// opt blob: 00 = none, 01 + uleb len + bytes = some.
fn put_opt_blob(out: &mut Vec<u8>, b: Option<&[u8]>) {
    match b {
        None => out.push(0x00),
        Some(v) => {
            out.push(0x01);
            put_uleb(out, v.len() as u128);
            out.extend_from_slice(v);
        }
    }
}

fn put_opt_nat(out: &mut Vec<u8>, v: Option<u128>) {
    match v {
        None => out.push(0x00),
        Some(v) => {
            out.push(0x01);
            put_uleb(out, v);
        }
    }
}

fn put_opt_nat64(out: &mut Vec<u8>, v: Option<u64>) {
    match v {
        None => out.push(0x00),
        Some(v) => {
            out.push(0x01);
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
}

/// Account values: owner principal, then subaccount as opt blob — all-zero subaccount
/// canonicalized to `none` (None ≡ Some([0;32]) per icrc-ledger-types).
fn put_account(out: &mut Vec<u8>, a: &Account) {
    put_principal(out, &a.owner);
    if a.subaccount == [0u8; 32] {
        out.push(0x00);
    } else {
        put_opt_blob(out, Some(&a.subaccount));
    }
}

/// `icrc1_transfer` argument bytes (POST `call`, method `icrc1_transfer`).
pub fn transfer_arg(
    to: &Account,
    from_subaccount: Option<[u8; 32]>,
    amount: u128,
    fee: Option<u128>,
    memo: Option<Vec<u8>>,
    created_at_time_ns: Option<u64>,
) -> Vec<u8> {
    let mut out = TRANSFER_PREFIX.to_vec();
    put_account(&mut out, to); // to (0x657b)
    put_opt_nat(&mut out, fee); // fee (0x4dbe46)
    put_opt_blob(&mut out, memo.as_deref()); // memo (0x485944ba)
    put_opt_blob(&mut out, from_subaccount.as_ref().map(|s| &s[..])); // from_subaccount (0x6d652f22)
    put_opt_nat64(&mut out, created_at_time_ns); // created_at_time (0xc23cf982)
    put_uleb(&mut out, amount); // amount (0xd50311d8)
    out
}

/// `icrc2_approve` argument bytes. `amount: None` encodes as `0` (the revoke value);
/// `from_subaccount: Some([0;32])` is preserved as an explicit opt-some.
#[allow(clippy::too_many_arguments)]
pub fn approve_arg(
    from_subaccount: Option<[u8; 32]>,
    spender: &Account,
    amount: Option<u128>,
    expected_allowance: Option<u128>,
    expires_at_ns: Option<u64>,
    memo: Option<Vec<u8>>,
    created_at_time_ns: Option<u64>,
    fee: Option<u128>,
) -> Vec<u8> {
    let mut out = APPROVE_PREFIX.to_vec();
    put_opt_nat(&mut out, fee); // fee (0x4dbe46)
    put_opt_blob(&mut out, memo.as_deref()); // memo (0x485944ba)
    put_opt_blob(&mut out, from_subaccount.as_ref().map(|s| &s[..])); // from_subaccount (0x6d652f22)
    put_opt_nat64(&mut out, created_at_time_ns); // created_at_time (0xc23cf982)
    put_uleb(&mut out, amount.unwrap_or(0)); // amount (0xd50311d8)
    put_opt_nat(&mut out, expected_allowance); // expected_allowance (0xd7e70e11)
    put_opt_nat64(&mut out, expires_at_ns); // expires_at (0xdb5dd3de)
    put_account(&mut out, spender); // spender (0xe6970b4b)
    out
}

/// `icrc1_balance_of` query argument bytes.
pub fn balance_of_arg(a: &Account) -> Vec<u8> {
    let mut out = ACCOUNT_PREFIX.to_vec();
    put_account(&mut out, a);
    out
}

/// `icrc2_allowance` query argument bytes.
pub fn allowance_arg(account: &Account, spender: &Account) -> Vec<u8> {
    let mut out = ALLOWANCE_PREFIX.to_vec();
    put_account(&mut out, account);
    put_account(&mut out, spender);
    out
}

// --- results (variant tags per ledger.did; no GenericBatchError exists in the .did) -----------------

/// `TransferError` from the ledger .did — payloads: nat → u128, nat64 timestamps → u64,
/// BlockIndex → u64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransferError {
    BadFee { expected_fee: u128 },
    BadBurn { min_burn_amount: u128 },
    InsufficientFunds { balance: u128 },
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    TemporarilyUnavailable,
    Duplicate { duplicate_of: u64 },
    GenericError { error_code: u128, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransferResult {
    Ok(u64),
    Err(TransferError),
}

/// `ApproveError` from the ledger .did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApproveError {
    GenericError { error_code: u128, message: String },
    TemporarilyUnavailable,
    Duplicate { duplicate_of: u64 },
    BadFee { expected_fee: u128 },
    AllowanceChanged { current_allowance: u128 },
    CreatedInFuture { ledger_time: u64 },
    TooOld,
    Expired { ledger_time: u64 },
    InsufficientFunds { balance: u128 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApproveResult {
    /// `Ok : BlockIndex` (nat) per the ledger .did (~line 42) — not unit.
    Ok(u64),
    Err(ApproveError),
}

// --- DIDL reader ---------------------------------------------------------------------------------

/// candid type-graph node; forward table refs (`Ty::Ref`) are resolved once the whole
/// table is parsed (DIDL tables routinely reference later entries).
#[derive(Debug, Clone, PartialEq)]
enum Ty {
    Prim(i64),
    /// unresolved index into the type table
    Ref(u32),
    Opt(Box<Ty>),
    Vec(Box<Ty>),
    Rec(Vec<(u32, Ty)>),
    Var(Vec<(u32, Ty)>),
}

const OP_OPT: i64 = -18;
const OP_VEC: i64 = -19;
const OP_REC: i64 = -20;
const OP_VAR: i64 = -21;

fn idl_hash(name: &str) -> u32 {
    let mut h: u32 = 0;
    for b in name.as_bytes() {
        h = h.wrapping_mul(223).wrapping_add(u32::from(*b));
    }
    h
}

struct Rd<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Rd<'a> {
    fn err(m: &str) -> IcpError {
        IcpError::DidlDecode(m.to_string())
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], IcpError> {
        let s = self.b.get(self.i..self.i + n).ok_or_else(|| Self::err("truncated"))?;
        self.i += n;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, IcpError> {
        Ok(self.take(1)?[0])
    }

    /// Unsigned LEB128 bounded to u128, with the bound checked BEFORE any shift
    /// executes: at most 19 groups (18×7 = 126 bits + a final group whose payload
    /// must fit the 2 remaining bits). Without the guard a ≥20-group overlong
    /// encoding executes a `7*k >= 128` shift — a debug panic, and in release the
    /// LLVM-masked shift silently decodes a WRONG value.
    fn uleb(&mut self) -> Result<u128, IcpError> {
        let mut v: u128 = 0;
        for k in 0..19 {
            let b = self.u8()?;
            let payload = b & 0x7f;
            if k == 18 && payload > 0x03 {
                // 19th group: only 2 bits of headroom remain in a u128.
                return Err(Self::err("uleb128 exceeds u128"));
            }
            v |= u128::from(payload) << (7 * k);
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(Self::err("uleb128 overflow"))
    }

    fn sleb(&mut self) -> Result<i64, IcpError> {
        i64::try_from(self.sleb_i128()?).map_err(|_| Self::err("sleb128 exceeds i64"))
    }

    /// Arbitrary-precision sleb128 (the `int` prim carries up to i128 on the wire).
    /// Stricter-than-reference (the production candid crate shares this blind spot):
    /// at the 19th group the payload is range-checked BEFORE any shift executes, and
    /// must fit the 2 bits an i128 has left after 18×7 = 126 AND be an exact sign
    /// extension of value bit 127. Without the guard the ≥19-group overlong
    /// non-canonical tails (`80×18 40` → 0, `80×18 02` → i128::MIN, `80×18 3f`,
    /// `80×18 41` → garbage) silently decode a WRONG value; they must Err instead.
    fn sleb_i128(&mut self) -> Result<i128, IcpError> {
        let mut v: i128 = 0;
        let mut shift = 0u32;
        loop {
            let b = self.u8()?;
            let payload = b & 0x7f;
            if shift == 126 {
                // 19th group: only bits 126..127 remain. Legal payloads are the exact
                // sign extensions — {0,1} (bit 127 clear) / {0x7e,0x7f} (bit 127 set),
                // the tails of candid's own i128::MIN/i128::MAX encodings.
                if !matches!(payload, 0x00 | 0x01 | 0x7e | 0x7f) {
                    return Err(Self::err("sleb128 exceeds i128"));
                }
            } else if shift > 126 {
                return Err(Self::err("sleb128 overflow"));
            }
            v |= i128::from(payload) << shift;
            shift += 7;
            if b & 0x80 == 0 {
                if shift < 128 && b & 0x40 != 0 {
                    v |= -1i128 << shift;
                }
                return Ok(v);
            }
        }
    }

    /// A not-yet-resolved forward type reference (index into the table being built).
    /// DIDL type tables routinely reference later entries (T0 → T1 before T1 exists),
    /// so refs are recorded during the table pass and resolved afterwards.
    fn child(&mut self) -> Result<Ty, IcpError> {
        let o = self.sleb()?;
        if o >= 0 {
            Ok(Ty::Ref(o as u32))
        } else {
            Ok(Ty::Prim(o))
        }
    }

    fn fields(&mut self) -> Result<Vec<(u32, Ty)>, IcpError> {
        let n = self.uleb()? as usize;
        if n > 128 {
            return Err(Self::err("type table field count out of range"));
        }
        let mut fs = Vec::with_capacity(n);
        for _ in 0..n {
            // record/variant field labels are uleb of the u32 idl_hash
            // (candid ser.rs: leb128_encode(u64::from(id.get_id())))
            let label = self.uleb()? as u32;
            let ty = self.child()?;
            fs.push((label, ty));
        }
        Ok(fs)
    }

    /// Resolve all forward refs against the finished table (checked after the table is
    /// fully parsed, so refs to later entries are valid). Depth-capped: a malformed
    /// cyclic table aborts instead of looping (legit chains are bounded by table size).
    fn resolve(&self, ty: &Ty, types: &[Ty]) -> Result<Ty, IcpError> {
        self.resolve_depth(ty, types, 0)
    }

    fn resolve_depth(&self, ty: &Ty, types: &[Ty], depth: u32) -> Result<Ty, IcpError> {
        if depth > 128 {
            return Err(Self::err("type table recursion too deep"));
        }
        match ty {
            Ty::Ref(i) => {
                let t = types.get(*i as usize).ok_or_else(|| Self::err("type ref out of range"))?;
                self.resolve_depth(t, types, depth + 1)
            }
            Ty::Opt(t) => Ok(Ty::Opt(Box::new(self.resolve_depth(t, types, depth + 1)?))),
            Ty::Vec(t) => Ok(Ty::Vec(Box::new(self.resolve_depth(t, types, depth + 1)?))),
            Ty::Rec(fs) => Ok(Ty::Rec(
                fs.iter()
                    .map(|(l, t)| Ok((*l, self.resolve_depth(t, types, depth + 1)?)))
                    .collect::<Result<_, _>>()?,
            )),
            Ty::Var(fs) => Ok(Ty::Var(
                fs.iter()
                    .map(|(l, t)| Ok((*l, self.resolve_depth(t, types, depth + 1)?)))
                    .collect::<Result<_, _>>()?,
            )),
            Ty::Prim(_) => Ok(ty.clone()),
        }
    }

    /// Parse a full DIDL message; returns (types, nargs, arg0 type).
    fn message(&mut self) -> Result<(Vec<Ty>, usize, Ty), IcpError> {
        if self.take(4)? != b"DIDL" {
            return Err(Self::err("missing DIDL magic"));
        }
        let ntypes = self.uleb()? as usize;
        if ntypes > 64 {
            return Err(Self::err("type table too large"));
        }
        let mut types = Vec::with_capacity(ntypes);
        for _ in 0..ntypes {
            let o = self.sleb()?;
            let ty = match o {
                OP_OPT => Ty::Opt(Box::new(self.child()?)),
                OP_VEC => Ty::Vec(Box::new(self.child()?)),
                OP_REC => Ty::Rec(self.fields()?),
                OP_VAR => Ty::Var(self.fields()?),
                -24..=-1 => Ty::Prim(o),
                _ => return Err(Self::err("unsupported type-table opcode")),
            };
            types.push(ty);
        }
        // resolve forward refs now that the table is complete
        let types = types.iter().map(|t| self.resolve(t, &types)).collect::<Result<Vec<_>, _>>()?;
        let nargs = self.uleb()? as usize;
        if nargs == 0 || nargs > 8 {
            return Err(IcpError::DidlType(format!("expected 1..=8 args, got {nargs}")));
        }
        let mut arg_tys = Vec::with_capacity(nargs);
        for _ in 0..nargs {
            arg_tys.push(self.child()?);
        }
        let arg0 = self.resolve(&arg_tys.swap_remove(0), &types)?;
        Ok((types, nargs, arg0))
    }

    fn finish(&self) -> Result<(), IcpError> {
        if self.i != self.b.len() {
            return Err(Self::err("trailing bytes after value"));
        }
        Ok(())
    }

    // -- value readers --

    fn nat(&mut self) -> Result<u128, IcpError> {
        self.uleb()
    }

    fn nat64(&mut self) -> Result<u64, IcpError> {
        let s = self.take(8)?;
        let mut v = [0u8; 8];
        v.copy_from_slice(s);
        Ok(u64::from_le_bytes(v))
    }

    fn text(&mut self) -> Result<String, IcpError> {
        let n = self.uleb()? as usize;
        if n > 1 << 20 {
            return Err(Self::err("text length out of range"));
        }
        let s = self.take(n)?;
        String::from_utf8(s.to_vec()).map_err(|_| Self::err("bad utf8 in text"))
    }

    /// Variant: uleb index into the (label-sorted) field list, then the payload.
    /// Returns the (label, payload-type) cloned out — types are tiny and this keeps
    /// the reader freely mutable during payload decode.
    fn variant(&mut self, v: &[(u32, Ty)]) -> Result<(u32, Ty), IcpError> {
        let idx = self.uleb()? as usize;
        if idx >= v.len() {
            return Err(IcpError::DidlType(format!("variant index {idx} out of range")));
        }
        Ok(v[idx].clone())
    }
}

/// The reply arg must be the BARE result variant — this is the shape the real
/// ic-icrc1-ledger replies with on replica AND mainnet (verified against live captures);
/// the one-field record wrapper some generators emit is NOT accepted (no legacy paths).
fn bare_variant<'t>(ty: &'t Ty) -> Result<&'t [(u32, Ty)], IcpError> {
    let Ty::Var(v) = ty else {
        return Err(IcpError::DidlType("reply arg must be a bare variant".into()));
    };
    Ok(v)
}

fn u64_of(v: u128, what: &str) -> Result<u64, IcpError> {
    u64::try_from(v).map_err(|_| IcpError::DidlDecode(format!("{what} exceeds u64")))
}

/// Decode an `icrc1_transfer` reply (`TransferResult`).
pub fn decode_transfer_result(bytes: &[u8]) -> Result<TransferResult, IcpError> {
    let mut rd = Rd { b: bytes, i: 0 };
    let (_, _, arg0) = rd.message()?;
    let outer = bare_variant(&arg0)?;
    let (label, payload) = rd.variant(outer)?;
    let result = match label {
        l if l == idl_hash("Ok") => TransferResult::Ok(u64_of(rd.nat()?, "block index")?),
        l if l == idl_hash("Err") => {
            let Ty::Var(inner) = payload else {
                return Err(IcpError::DidlType("Err payload must be a variant".into()));
            };
            let (elabel, epayload) = rd.variant(&inner)?;
            TransferResult::Err(transfer_error(&mut rd, elabel, &epayload)?)
        }
        l => return Err(IcpError::DidlType(format!("unknown TransferResult label {l:#x}"))),
    };
    rd.finish()?;
    Ok(result)
}

/// single numeric record field: nat (uleb) or nat64 (8B LE).
fn num_field(rd: &mut Rd, fs: &[(u32, Ty)], what: &str) -> Result<u128, IcpError> {
    if fs.len() != 1 {
        return Err(IcpError::DidlType(format!("{what} payload must have one field")));
    }
    match &fs[0].1 {
        Ty::Prim(-3) => rd.nat(),
        Ty::Prim(-8) => Ok(u128::from(rd.nat64()?)),
        _ => Err(IcpError::DidlType(format!("unexpected {what} field type"))),
    }
}

fn transfer_error(rd: &mut Rd, label: u32, payload: &Ty) -> Result<TransferError, IcpError> {
    // unit variants carry a null payload with no wire bytes
    if label == idl_hash("TooOld") {
        return Ok(TransferError::TooOld);
    }
    if label == idl_hash("TemporarilyUnavailable") {
        return Ok(TransferError::TemporarilyUnavailable);
    }
    let Ty::Rec(fs) = payload else {
        return Err(IcpError::DidlType("TransferError payload must be a record".into()));
    };
    match label {
        l if l == idl_hash("BadFee") => Ok(TransferError::BadFee { expected_fee: num_field(rd, fs, "BadFee")? }),
        l if l == idl_hash("BadBurn") => Ok(TransferError::BadBurn { min_burn_amount: num_field(rd, fs, "BadBurn")? }),
        l if l == idl_hash("InsufficientFunds") => {
            Ok(TransferError::InsufficientFunds { balance: num_field(rd, fs, "InsufficientFunds")? })
        }
        l if l == idl_hash("CreatedInFuture") => {
            if fs.len() != 1 {
                return Err(IcpError::DidlType("CreatedInFuture payload must have one field".into()));
            }
            Ok(TransferError::CreatedInFuture { ledger_time: rd.nat64()? })
        }
        l if l == idl_hash("Duplicate") => Ok(TransferError::Duplicate {
            duplicate_of: u64_of(num_field(rd, fs, "Duplicate")?, "duplicate_of")?,
        }),
        l if l == idl_hash("GenericError") => {
            // fields on wire sorted by label: message (0x9a1135c7) before error_code (0xd6ac4c44)
            let mut message = None;
            let mut error_code = None;
            for (fl, _ft) in fs {
                match *fl {
                    f if f == idl_hash("message") => message = Some(rd.text()?),
                    f if f == idl_hash("error_code") => error_code = Some(rd.nat()?),
                    f => return Err(IcpError::DidlType(format!("unknown GenericError field {f:#x}"))),
                }
            }
            Ok(TransferError::GenericError {
                error_code: error_code.ok_or_else(|| Rd::err("GenericError missing error_code"))?,
                message: message.ok_or_else(|| Rd::err("GenericError missing message"))?,
            })
        }
        l => Err(IcpError::DidlType(format!("unknown TransferError label {l:#x}"))),
    }
}

/// Decode an `icrc2_approve` reply (`ApproveResult`).
pub fn decode_approve_result(bytes: &[u8]) -> Result<ApproveResult, IcpError> {
    let mut rd = Rd { b: bytes, i: 0 };
    let (_, _, arg0) = rd.message()?;
    let outer = bare_variant(&arg0)?;
    let (label, payload) = rd.variant(outer)?;
    let res = match label {
        l if l == idl_hash("Ok") => ApproveResult::Ok(u64_of(rd.nat()?, "block index")?),
        l if l == idl_hash("Err") => {
            let Ty::Var(inner) = payload else {
                return Err(IcpError::DidlType("Err payload must be a variant".into()));
            };
            let (elabel, epayload) = rd.variant(&inner)?;
            ApproveResult::Err(approve_error(&mut rd, elabel, &epayload)?)
        }
        l => return Err(IcpError::DidlType(format!("unknown ApproveResult label {l:#x}"))),
    };
    rd.finish()?;
    Ok(res)
}

fn approve_error(rd: &mut Rd, label: u32, payload: &Ty) -> Result<ApproveError, IcpError> {
    if label == idl_hash("TemporarilyUnavailable") {
        return Ok(ApproveError::TemporarilyUnavailable);
    }
    if label == idl_hash("TooOld") {
        return Ok(ApproveError::TooOld);
    }
    let Ty::Rec(fs) = payload else {
        return Err(IcpError::DidlType("ApproveError payload must be a record".into()));
    };
    match label {
        l if l == idl_hash("GenericError") => {
            let mut message = None;
            let mut error_code = None;
            for (fl, _ft) in fs {
                match *fl {
                    f if f == idl_hash("message") => message = Some(rd.text()?),
                    f if f == idl_hash("error_code") => error_code = Some(rd.nat()?),
                    f => return Err(IcpError::DidlType(format!("unknown GenericError field {f:#x}"))),
                }
            }
            Ok(ApproveError::GenericError {
                error_code: error_code.ok_or_else(|| Rd::err("GenericError missing error_code"))?,
                message: message.ok_or_else(|| Rd::err("GenericError missing message"))?,
            })
        }
        l if l == idl_hash("Duplicate") => Ok(ApproveError::Duplicate {
            duplicate_of: u64_of(num_field(rd, fs, "Duplicate")?, "duplicate_of")?,
        }),
        l if l == idl_hash("BadFee") => Ok(ApproveError::BadFee { expected_fee: num_field(rd, fs, "BadFee")? }),
        l if l == idl_hash("AllowanceChanged") => {
            Ok(ApproveError::AllowanceChanged { current_allowance: num_field(rd, fs, "AllowanceChanged")? })
        }
        l if l == idl_hash("CreatedInFuture") => {
            if fs.len() != 1 {
                return Err(IcpError::DidlType("CreatedInFuture payload must have one field".into()));
            }
            Ok(ApproveError::CreatedInFuture { ledger_time: rd.nat64()? })
        }
        l if l == idl_hash("Expired") => {
            if fs.len() != 1 {
                return Err(IcpError::DidlType("Expired payload must have one field".into()));
            }
            Ok(ApproveError::Expired { ledger_time: rd.nat64()? })
        }
        l if l == idl_hash("InsufficientFunds") => {
            Ok(ApproveError::InsufficientFunds { balance: num_field(rd, fs, "InsufficientFunds")? })
        }
        l => Err(IcpError::DidlType(format!("unknown ApproveError label {l:#x}"))),
    }
}

/// Decode a single-value INTEGER reply — any prim of the DIDL integer family:
/// `nat8/16/32/64` and `nat` (uleb) zero-extended, `int8..64` (fixed-width LE,
/// sign-extended) and `int` (arbitrary sleb128), all returned as `i128`.
/// Covers every integer the ICRC-1 read methods return (`icrc1_balance_of` → nat,
/// `icrc1_fee` → nat, `icrc1_decimals` → nat8).
pub fn decode_int(bytes: &[u8]) -> Result<i128, IcpError> {
    let mut rd = Rd { b: bytes, i: 0 };
    let (_, nargs, arg0) = rd.message()?;
    if nargs != 1 {
        return Err(IcpError::DidlType(format!("integer reply must have 1 arg, got {nargs}")));
    }
    let Ty::Prim(t) = arg0 else {
        return Err(IcpError::DidlType("integer reply arg must be an integer prim".into()));
    };
    // DIDL prim codes: nat=-3 int=-4 nat8=-5 nat16=-6 nat32=-7 nat64=-8 int8=-9 …
    // int16=-10 int32=-11 int64=-12 (goldens generated with candid 0.10.22).
    let v = match t {
        -3 => i128::try_from(rd.nat()?).map_err(|_| Rd::err("nat exceeds i128"))?,
        -4 => rd.sleb_i128()?,
        -5 => i128::from(rd.take(1)?[0]),
        -6 => {
            let s = rd.take(2)?;
            i128::from(u16::from_le_bytes([s[0], s[1]]))
        }
        -7 => {
            let s = rd.take(4)?;
            let mut b = [0u8; 4];
            b.copy_from_slice(s);
            i128::from(u32::from_le_bytes(b))
        }
        -8 => i128::from(rd.nat64()?),
        -9 => i128::from(rd.take(1)?[0] as i8),
        -10 => {
            let s = rd.take(2)?;
            i128::from(i16::from_le_bytes([s[0], s[1]]))
        }
        -11 => {
            let s = rd.take(4)?;
            let mut b = [0u8; 4];
            b.copy_from_slice(s);
            i128::from(i32::from_le_bytes(b))
        }
        -12 => {
            let s = rd.take(8)?;
            let mut b = [0u8; 8];
            b.copy_from_slice(s);
            i128::from(i64::from_le_bytes(b))
        }
        _ => return Err(IcpError::DidlType(format!("not an integer prim (tag {t})"))),
    };
    rd.finish()?;
    Ok(v)
}
