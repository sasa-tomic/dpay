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

// --- ckBTC / ckETH minter args (types pinned from the real minter .did services; type tables
// --- regenerated with the cached production candid 0.10.22 — same generator as the goldens) ---

fn put_opt_principal(out: &mut Vec<u8>, p: Option<&crate::principal::Principal>) {
    match p {
        None => out.push(0x00),
        Some(p) => {
            out.push(0x01);
            put_principal(out, p);
        }
    }
}

fn put_text(out: &mut Vec<u8>, s: &str) {
    put_uleb(out, s.len() as u128);
    out.extend_from_slice(s.as_bytes());
}

/// ckBTC minter `get_btc_address` argument: `(MinterAccount)` — ONE record arg (a 2-tuple traps
/// IC0503 on the real minter). owner = the user's principal (arbitrary owners are accepted);
/// subaccount is the payer's subaccount on the minter's ledger account.
pub fn minter_account_arg(owner: &crate::principal::Principal, subaccount: Option<[u8; 32]>) -> Vec<u8> {
    // type table: service get_btc_address: (MinterAccount) -> (text); arg = rec{owner, subaccount}
    let mut out = vec![
        0x44, 0x49, 0x44, 0x4c, 0x04, 0x6c, 0x02, 0xb3, 0xb0, 0xda, 0xc3, 0x03,
        0x01, 0xad, 0x86, 0xca, 0x83, 0x05, 0x02, 0x6e, 0x68, 0x6e, 0x03, 0x6d,
        0x7b, 0x01, 0x00,
    ];
    put_opt_principal(&mut out, Some(owner));
    put_opt_blob(&mut out, subaccount.as_ref().map(|s| &s[..]));
    out
}

/// ckBTC minter `retrieve_btc_with_approval` argument: address + amount (sats, nat64) +
/// opt from_subaccount (the user's subaccount whose ledger account holds the approved ckBTC).
pub fn retrieve_btc_arg(address: &str, amount: u64, from_subaccount: Option<[u8; 32]>) -> Vec<u8> {
    let mut out = vec![
        0x44, 0x49, 0x44, 0x4c, 0x03, 0x6c, 0x03, 0xa2, 0xde, 0x94, 0xeb, 0x06,
        0x01, 0xb4, 0xe3, 0xad, 0xe8, 0x09, 0x71, 0xd8, 0xa3, 0x8c, 0xa8, 0x0d,
        0x78, 0x6e, 0x02, 0x6d, 0x7b, 0x01, 0x00,
    ];
    // Value order per the candid-generated golden: from_subaccount (opt blob) first, then
    // address (text), then amount (nat64 LE) — DIDL records serialize in field-hash order.
    put_opt_blob(&mut out, from_subaccount.as_ref().map(|s| &s[..])); // from_subaccount
    put_text(&mut out, address); // address
    out.extend_from_slice(&amount.to_le_bytes()); // amount: nat64
    out
}

/// ckETH minter `withdraw_eth` argument: recipient + amount (Wei, nat) + opt from_subaccount.
pub fn withdraw_eth_arg(recipient: &str, amount: u128, from_subaccount: Option<[u8; 32]>) -> Vec<u8> {
    let mut out = vec![
        0x44, 0x49, 0x44, 0x4c, 0x03, 0x6c, 0x03, 0xd9, 0xf7, 0x8b, 0x9a, 0x05,
        0x71, 0xa2, 0xde, 0x94, 0xeb, 0x06, 0x01, 0xd8, 0xa3, 0x8c, 0xa8, 0x0d,
        0x7d, 0x6e, 0x02, 0x6d, 0x7b, 0x01, 0x00,
    ];
    put_text(&mut out, recipient); // recipient (text)
    put_opt_blob(&mut out, from_subaccount.as_ref().map(|s| &s[..])); // from_subaccount
    put_uleb(&mut out, amount); // amount: nat
    out
}

/// ckETH minter `withdraw_erc20` argument (dual-ledger path): amount + ckerc20_ledger_id +
/// recipient + from_cketh_subaccount + from_ckerc20_subaccount.
#[allow(clippy::too_many_arguments)]
pub fn withdraw_erc20_arg(
    amount: u128,
    ckerc20_ledger_id: &crate::principal::Principal,
    recipient: &str,
    from_cketh_subaccount: Option<[u8; 32]>,
    from_ckerc20_subaccount: Option<[u8; 32]>,
) -> Vec<u8> {
    let mut out = vec![
        0x44, 0x49, 0x44, 0x4c, 0x03, 0x6c, 0x05, 0x9e, 0xa7, 0xa9, 0x98, 0x02,
        0x68, 0xd9, 0xf7, 0x8b, 0x9a, 0x05, 0x71, 0xb0, 0xb4, 0xdb, 0xff, 0x08,
        0x01, 0xd5, 0x97, 0xed, 0xb9, 0x0a, 0x01, 0xd8, 0xa3, 0x8c, 0xa8, 0x0d,
        0x7d, 0x6e, 0x02, 0x6d, 0x7b, 0x01, 0x00,
    ];
    put_principal(&mut out, ckerc20_ledger_id); // ckerc20_ledger_id
    put_text(&mut out, recipient); // recipient
    put_opt_blob(&mut out, from_cketh_subaccount.as_ref().map(|s| &s[..]));
    put_opt_blob(&mut out, from_ckerc20_subaccount.as_ref().map(|s| &s[..]));
    put_uleb(&mut out, amount); // amount: nat
    out
}

/// ckETH minter `eip_1559_transaction_price` QUERY argument: opt record{ckerc20_ledger_id}.
pub fn eip1559_price_arg(ckerc20_ledger_id: &crate::principal::Principal) -> Vec<u8> {
    let mut out = vec![
        0x44, 0x49, 0x44, 0x4c, 0x02, 0x6e, 0x01, 0x6c, 0x01, 0x9e, 0xa7, 0xa9,
        0x98, 0x02, 0x68, 0x01, 0x00,
    ];
    out.push(0x01); // opt some
    put_principal(&mut out, ckerc20_ledger_id);
    out
}

/// Decode a `text` reply (get_btc_address) — bare DIDL string. Returns the UTF-8 address.
pub fn decode_text(arg: &[u8]) -> Result<String, IcpError> {
    let mut rd = Rd { b: arg, i: 0 };
    rd.message()?;
    let t = rd.text()?;
    rd.finish()?;
    Ok(t)
}

/// Decoded `eip_1559_transaction_price` reply (ckETH minter query) — Wei figures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Eip1559Price {
    pub gas_limit: u128,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub max_transaction_fee: u128,
    pub timestamp: Option<u64>,
}

/// Decode the `Eip1559TransactionPrice` record reply. DIDL records serialize field values
/// transparently (no tags) in label-HASH order — for this record that is:
/// max_priority_fee_per_gas, max_fee_per_gas, max_transaction_fee, timestamp (opt nat64),
/// gas_limit. The shape IS the validation (golden-pinned in tests/goldens.rs).
pub fn decode_eip1559_price(arg: &[u8]) -> Result<Eip1559Price, IcpError> {
    let mut rd = Rd { b: arg, i: 0 };
    rd.message()?;
    let max_priority_fee_per_gas = rd.nat()?;
    let max_fee_per_gas = rd.nat()?;
    let max_transaction_fee = rd.nat()?;
    let timestamp = rd.opt_nat64()?;
    let gas_limit = rd.nat()?;
    rd.finish()?;
    Ok(Eip1559Price { gas_limit, max_fee_per_gas, max_priority_fee_per_gas, max_transaction_fee, timestamp })
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

    fn opt_nat64(&mut self) -> Result<Option<u64>, IcpError> {
        let tag = self.take(1)?[0];
        match tag {
            0x00 => Ok(None),
            0x01 => Ok(Some(self.nat64()?)),
            _ => Err(Self::err("bad opt tag")),
        }
    }

    fn opt_blob(&mut self) -> Result<Option<Vec<u8>>, IcpError> {
        let tag = self.take(1)?[0];
        match tag {
            0x00 => Ok(None),
            0x01 => {
                let n = self.uleb()? as usize;
                if n > 1 << 16 {
                    return Err(Self::err("blob length out of range"));
                }
                Ok(Some(self.take(n)?.to_vec()))
            }
            _ => Err(Self::err("bad opt tag")),
        }
    }

    fn opt_nat(&mut self) -> Result<Option<u128>, IcpError> {
        let tag = self.take(1)?[0];
        match tag {
            0x00 => Ok(None),
            0x01 => Ok(Some(self.uleb()?)),
            _ => Err(Self::err("bad opt tag")),
        }
    }

    fn principal(&mut self) -> Result<crate::principal::Principal, IcpError> {
        let tag = self.take(1)?[0];
        if tag != 0x01 {
            return Err(Self::err("bad principal class byte"));
        }
        let n = self.uleb()? as usize;
        if n > 29 {
            return Err(Self::err("principal too long"));
        }
        crate::principal::Principal::from_bytes(self.take(n)?)
    }

    fn opt_principal(&mut self) -> Result<Option<crate::principal::Principal>, IcpError> {
        let tag = self.take(1)?[0];
        match tag {
            0x00 => Ok(None),
            0x01 => Ok(Some(self.principal()?)),
            _ => Err(Self::err("bad opt tag")),
        }
    }

    /// Account value as put_account writes it: owner principal, then subaccount as
    /// opt blob (zero-subaccount canonicalized to `none`).
    fn account(&mut self) -> Result<Account, IcpError> {
        let tag = self.take(1)?[0];
        if tag != 0x01 {
            return Err(Self::err("bad principal class byte"));
        }
        let n = self.uleb()? as usize;
        if n > 29 {
            return Err(Self::err("principal too long"));
        }
        let owner = crate::principal::Principal::from_bytes(self.take(n)?)?;
        let sub = self.opt_blob()?;
        let mut subaccount = [0u8; 32];
        if let Some(b) = sub {
            if b.len() != 32 {
                return Err(Self::err("subaccount must be 32 bytes"));
            }
            subaccount.copy_from_slice(&b);
        }
        Ok(Account { owner, subaccount })
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


// --- gateway-side arg decoders + reply encoders (fake-IC /api/v2 test gateway) ---------------------
//
// These power the offline test relay's fake-IC gateway: decode the exact args the app
// builds above, and re-encode replies byte-compatible with a real ledger. Production
// surfaces (app/relay/canister) never call these; the real IC is the authority.

/// Decoded `icrc1_transfer` argument.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransferArg {
    pub to: Account,
    pub from_subaccount: Option<[u8; 32]>,
    pub amount: u128,
    pub fee: Option<u128>,
    pub memo: Option<Vec<u8>>,
    pub created_at_time_ns: Option<u64>,
}

/// Decode an `icrc1_transfer` argument built by [`transfer_arg`] (hash field order:
/// to, fee, memo, from_subaccount, created_at_time, amount).
pub fn decode_transfer_arg(arg: &[u8]) -> Result<TransferArg, IcpError> {
    let mut rd = Rd { b: arg, i: 0 };
    rd.message()?;
    let to = rd.account()?;
    let fee = rd.opt_nat()?;
    let memo = rd.opt_blob()?;
    let from_sub = rd.opt_blob()?;
    let from_subaccount = match from_sub {
        None => None,
        Some(b) => {
            let mut sa = [0u8; 32];
            if b.len() != 32 {
                return Err(IcpError::DidlDecode("from_subaccount must be 32 bytes".into()));
            }
            sa.copy_from_slice(&b);
            Some(sa)
        }
    };
    let created_at_time_ns = rd.opt_nat64()?;
    let amount = rd.nat()?;
    rd.finish()?;
    Ok(TransferArg { to, from_subaccount, amount, fee, memo, created_at_time_ns })
}

/// Decoded `icrc2_approve` argument.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApproveArg {
    pub from_subaccount: Option<[u8; 32]>,
    pub spender: Account,
    pub amount: Option<u128>,
    pub expected_allowance: Option<u128>,
    pub expires_at_ns: Option<u64>,
    pub memo: Option<Vec<u8>>,
    pub created_at_time_ns: Option<u64>,
    pub fee: Option<u128>,
}

/// Decode an `icrc2_approve` argument built by [`approve_arg`] (hash field order:
/// fee, memo, from_subaccount, created_at_time, amount, expected_allowance, expires_at, spender).
#[allow(clippy::too_many_arguments)]
pub fn decode_approve_arg(arg: &[u8]) -> Result<ApproveArg, IcpError> {
    let mut rd = Rd { b: arg, i: 0 };
    rd.message()?;
    let fee = rd.opt_nat()?;
    let memo = rd.opt_blob()?;
    let from_sub = rd.opt_blob()?;
    let from_subaccount = match from_sub {
        None => None,
        Some(b) => {
            let mut sa = [0u8; 32];
            if b.len() != 32 {
                return Err(IcpError::DidlDecode("from_subaccount must be 32 bytes".into()));
            }
            sa.copy_from_slice(&b);
            Some(sa)
        }
    };
    let created_at_time_ns = rd.opt_nat64()?;
    let amount = rd.nat()?;
    let expected_allowance = rd.opt_nat()?;
    let expires_at_ns = rd.opt_nat64()?;
    let spender = rd.account()?;
    rd.finish()?;
    Ok(ApproveArg {
        from_subaccount,
        spender,
        // candid encodes `amount: None` (the revoke value) as literal 0; both mean the
        // same thing at the ledger, so normalize to None here.
        amount: if amount == 0 { None } else { Some(amount) },
        expected_allowance,
        expires_at_ns,
        memo,
        created_at_time_ns,
        fee,
    })
}

/// Decoded `icrc1_balance_of` / `icrc2_allowance` account argument (balance_of takes one).
pub fn decode_account_arg(arg: &[u8]) -> Result<Account, IcpError> {
    let mut rd = Rd { b: arg, i: 0 };
    rd.message()?;
    let a = rd.account()?;
    rd.finish()?;
    Ok(a)
}

/// Decoded `retrieve_btc_with_approval` argument (hash order: from_subaccount, address, amount).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetrieveBtcArg {
    pub from_subaccount: Option<[u8; 32]>,
    pub address: String,
    pub amount: u64,
}

pub fn decode_retrieve_btc_arg(arg: &[u8]) -> Result<RetrieveBtcArg, IcpError> {
    let mut rd = Rd { b: arg, i: 0 };
    rd.message()?;
    let from_sub = rd.opt_blob()?;
    let from_subaccount = match from_sub {
        None => None,
        Some(b) => {
            let mut sa = [0u8; 32];
            if b.len() != 32 {
                return Err(IcpError::DidlDecode("from_subaccount must be 32 bytes".into()));
            }
            sa.copy_from_slice(&b);
            Some(sa)
        }
    };
    let address = rd.text()?;
    let amount = rd.nat64()?;
    rd.finish()?;
    Ok(RetrieveBtcArg { from_subaccount, address, amount })
}

/// Decoded `withdraw_eth` argument (hash order: from_subaccount, recipient, amount).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithdrawEthArg {
    pub from_subaccount: Option<[u8; 32]>,
    pub recipient: String,
    pub amount: u128,
}

pub fn decode_withdraw_eth_arg(arg: &[u8]) -> Result<WithdrawEthArg, IcpError> {
    let mut rd = Rd { b: arg, i: 0 };
    rd.message()?;
    // Field-hash order matches the encoder + production-candid golden: recipient (text)
    // first, then from_subaccount (opt blob), then amount (nat).
    let recipient = rd.text()?;
    let from_sub = rd.opt_blob()?;
    let from_subaccount = match from_sub {
        None => None,
        Some(b) => {
            let mut sa = [0u8; 32];
            if b.len() != 32 {
                return Err(IcpError::DidlDecode("from_subaccount must be 32 bytes".into()));
            }
            sa.copy_from_slice(&b);
            Some(sa)
        }
    };
    let amount = rd.nat()?;
    rd.finish()?;
    Ok(WithdrawEthArg { from_subaccount, recipient, amount })
}


/// Decoded `MinterAccount` (the ONE-record arg ckBTC `get_btc_address` takes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MinterAccountArg {
    pub owner: Option<crate::principal::Principal>,
    pub subaccount: Option<[u8; 32]>,
}

/// Decode a [`minter_account_arg`] payload (hash order: owner opt-principal, subaccount opt-blob).
pub fn decode_minter_account_arg(arg: &[u8]) -> Result<MinterAccountArg, IcpError> {
    let mut rd = Rd { b: arg, i: 0 };
    rd.message()?;
    let owner = match rd.opt_principal()? {
        Some(p) => Some(p),
        None => None,
    };
    let sub = rd.opt_blob()?;
    let subaccount = sub.map(|b| {
        let mut a = [0u8; 32];
        if b.len() == 32 {
            a.copy_from_slice(&b);
        }
        a
    });
    rd.finish()?;
    Ok(MinterAccountArg { owner, subaccount })
}

/// Decoded `withdraw_erc20` argument.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithdrawErc20ArgDecoded {
    pub amount: u128,
    pub ckerc20_ledger_id: crate::principal::Principal,
    pub recipient: String,
    pub from_cketh_subaccount: Option<[u8; 32]>,
    pub from_ckerc20_subaccount: Option<[u8; 32]>,
}

/// Decode a [`withdraw_erc20_arg`] payload (hash order: ledger principal, recipient text,
/// cketh subaccount, ckerc20 subaccount, amount).
pub fn decode_withdraw_erc20_arg(arg: &[u8]) -> Result<WithdrawErc20ArgDecoded, IcpError> {
    let mut rd = Rd { b: arg, i: 0 };
    rd.message()?;
    let ckerc20_ledger_id = rd.principal()?;
    let recipient = rd.text()?;
    let eth_sub = rd.opt_blob()?;
    let erc_sub = rd.opt_blob()?;
    let amount = rd.nat()?;
    rd.finish()?;
    let to_arr = |b: Option<Vec<u8>>| -> Option<[u8; 32]> {
        b.map(|v| {
            let mut a = [0u8; 32];
            if v.len() == 32 {
                a.copy_from_slice(&v);
            }
            a
        })
    };
    Ok(WithdrawErc20ArgDecoded {
        amount,
        ckerc20_ledger_id,
        recipient,
        from_cketh_subaccount: to_arr(eth_sub),
        from_ckerc20_subaccount: to_arr(erc_sub),
    })
}

// --- reply encoders (byte-compatible with the real ledgers; tables pinned to goldens) -------------

/// The TransferResult reply type table (8 types), shared by every transfer reply —
/// the exact bytes of the production-candid 0.10.22 golden prefix.
const TRANSFER_REPLY_TABLE: &[u8] = &[
    0x44, 0x49, 0x44, 0x4c, 0x08, 0x6b, 0x02, 0xbc, 0x8a, 0x01, 0x7d, 0xc5, 0xfe, 0xd2, 0x01,
    0x01, 0x6b, 0x08, 0xd1, 0xc4, 0x98, 0x7c, 0x02, 0xc2, 0x91, 0xec, 0xb9, 0x02, 0x7f, 0x94,
    0xc1, 0xc7, 0x89, 0x04, 0x03, 0xeb, 0x82, 0xa8, 0x97, 0x04, 0x04, 0xa1, 0xc3, 0xeb, 0xfd,
    0x07, 0x05, 0xf0, 0x87, 0xe6, 0xdb, 0x09, 0x06, 0x93, 0xe5, 0xbe, 0xc8, 0x0c, 0x7f, 0xeb,
    0x9c, 0xdb, 0xd5, 0x0f, 0x07, 0x6c, 0x02, 0xc7, 0xeb, 0xc4, 0xd0, 0x09, 0x71, 0xc4, 0x98,
    0xb1, 0xb5, 0x0d, 0x7d, 0x6c, 0x01, 0x9b, 0xb3, 0xbe, 0xa6, 0x0a, 0x7d, 0x6c, 0x01, 0x8b,
    0xbd, 0xf2, 0x9b, 0x01, 0x7d, 0x6c, 0x01, 0xbf, 0x9b, 0xb7, 0xf0, 0x0d, 0x7d, 0x6c, 0x01,
    0xa3, 0xbb, 0x91, 0x8c, 0x0a, 0x78, 0x6c, 0x01, 0x9c, 0xba, 0xb6, 0x9c, 0x02, 0x7d,
];

fn transfer_reply(err_variant: Option<(u8, &[u8])>, ok_block: u64) -> Vec<u8> {
    let mut out = TRANSFER_REPLY_TABLE.to_vec();
    out.push(0x01); // nargs
    out.push(0x00); // arg ref -> type 0 (variant)
    match err_variant {
        None => {
            out.push(0x00); // Ok
            let mut b = ok_block as u128;
            loop {
                let mut byte = (b & 0x7f) as u8;
                b >>= 7;
                if b != 0 {
                    byte |= 0x80;
                }
                out.push(byte);
                if b == 0 {
                    break;
                }
            }
        }
        Some((idx, payload)) => {
            out.push(0x01); // Err
            out.push(idx);
            out.extend_from_slice(payload);
        }
    }
    out
}

/// Reply bytes for `Ok(block_index)`.
pub fn encode_transfer_ok(block_index: u64) -> Vec<u8> {
    transfer_reply(None, block_index)
}

/// Reply bytes for `Err(InsufficientFunds { balance })` (variant idx 7, hash order).
pub fn encode_transfer_insufficient_funds(balance: u128) -> Vec<u8> {
    let mut payload = Vec::new();
    let mut b = balance;
    loop {
        let mut byte = (b & 0x7f) as u8;
        b >>= 7;
        if b != 0 {
            byte |= 0x80;
        }
        payload.push(byte);
        if b == 0 {
            break;
        }
    }
    transfer_reply(Some((7, &payload)), 0)
}

/// Reply bytes for `Err(BadFee { expected_fee })` (variant idx 4).
pub fn encode_transfer_bad_fee(expected_fee: u128) -> Vec<u8> {
    let mut payload = Vec::new();
    let mut b = expected_fee;
    loop {
        let mut byte = (b & 0x7f) as u8;
        b >>= 7;
        if b != 0 {
            byte |= 0x80;
        }
        payload.push(byte);
        if b == 0 {
            break;
        }
    }
    transfer_reply(Some((4, &payload)), 0)
}

/// Reply bytes for `Err(TooOld)` (variant idx 6, no payload).
pub fn encode_transfer_too_old() -> Vec<u8> {
    transfer_reply(Some((6, &[])), 0)
}

/// Reply bytes for `Err(Duplicate { duplicate_of })` (variant idx 3).
pub fn encode_transfer_duplicate(duplicate_of: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    let mut b = duplicate_of as u128;
    loop {
        let mut byte = (b & 0x7f) as u8;
        b >>= 7;
        if b != 0 {
            byte |= 0x80;
        }
        payload.push(byte);
        if b == 0 {
            break;
        }
    }
    transfer_reply(Some((3, &payload)), 0)
}


/// The ApproveResult reply type table (production-candid 0.10.22 golden prefix).
const APPROVE_REPLY_TABLE: &[u8] = &[
    0x44, 0x49, 0x44, 0x4c, 0x08, 0x6b, 0x02, 0xbc, 0x8a, 0x01, 0x7d, 0xc5, 0xfe, 0xd2, 0x01,
    0x01, 0x6b, 0x09, 0xd1, 0xc4, 0x98, 0x7c, 0x02, 0xc2, 0x91, 0xec, 0xb9, 0x02, 0x7f, 0xeb,
    0x82, 0xa8, 0x97, 0x04, 0x03, 0xa1, 0xc3, 0xeb, 0xfd, 0x07, 0x04, 0x9c, 0x84, 0xe8, 0xfc,
    0x08, 0x05, 0xf0, 0x87, 0xe6, 0xdb, 0x09, 0x06, 0x93, 0xe5, 0xbe, 0xc8, 0x0c, 0x7f, 0x85,
    0x8f, 0xee, 0x95, 0x0f, 0x06, 0xeb, 0x9c, 0xdb, 0xd5, 0x0f, 0x07, 0x6c, 0x02, 0xc7, 0xeb,
    0xc4, 0xd0, 0x09, 0x71, 0xc4, 0x98, 0xb1, 0xb5, 0x0d, 0x7d, 0x6c, 0x01, 0x8b, 0xbd, 0xf2,
    0x9b, 0x01, 0x7d, 0x6c, 0x01, 0xbf, 0x9b, 0xb7, 0xf0, 0x0d, 0x7d, 0x6c, 0x01, 0x92, 0xae,
    0xce, 0xe5, 0x0f, 0x7d, 0x6c, 0x01, 0xa3, 0xbb, 0x91, 0x8c, 0x0a, 0x78, 0x6c, 0x01, 0x9c,
    0xba, 0xb6, 0x9c, 0x02, 0x7d,
];

fn uleb_bytes(mut b: u128) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (b & 0x7f) as u8;
        b >>= 7;
        if b != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if b == 0 {
            return out;
        }
    }
}

/// Reply bytes for an approve `Ok(block_index)`.
pub fn encode_approve_ok(block_index: u64) -> Vec<u8> {
    let mut out = APPROVE_REPLY_TABLE.to_vec();
    out.extend_from_slice(&[0x01, 0x00, 0x00]);
    out.extend_from_slice(&uleb_bytes(block_index as u128));
    out
}

/// Reply bytes for the minter retrieve/withdraw `Ok({block_index})` results — one shared
/// table (production candid 0.10.22): variant Ok of a record with a nat64 block_index.
pub fn encode_minter_ok(block_index: u64) -> Vec<u8> {
    let mut out = vec![
        0x44, 0x49, 0x44, 0x4c, 0x02, 0x6b, 0x01, 0xbc, 0x8a, 0x01, 0x01, 0x6c, 0x01, 0xe0,
        0x9e, 0xcb, 0xa9, 0x02, 0x78, 0x01, 0x00, 0x00,
    ];
    out.extend_from_slice(&block_index.to_le_bytes());
    out
}

/// Reply bytes for the ckETH minter `eip_1559_transaction_price` query — the production
/// candid table followed by values in hash order: max_priority, max_fee, max_tx_fee,
/// timestamp (opt nat64 LE), gas_limit.
pub fn encode_eip1559_price(p: &Eip1559Price) -> Vec<u8> {
    let mut out = vec![
        0x44, 0x49, 0x44, 0x4c, 0x02, 0x6c, 0x05, 0xde, 0xd6, 0xac, 0xeb, 0x03, 0x7d, 0xe3,
        0xeb, 0x88, 0xd2, 0x06, 0x7d, 0xca, 0x82, 0xb6, 0x83, 0x09, 0x7d, 0xd6, 0xa9, 0xbb,
        0xae, 0x0a, 0x01, 0xd5, 0xf8, 0xac, 0xd2, 0x0a, 0x7d, 0x6e, 0x78, 0x01, 0x00,
    ];
    out.extend_from_slice(&uleb_bytes(p.max_priority_fee_per_gas));
    out.extend_from_slice(&uleb_bytes(p.max_fee_per_gas));
    out.extend_from_slice(&uleb_bytes(p.max_transaction_fee));
    match p.timestamp {
        Some(t) => {
            out.push(0x01);
            out.extend_from_slice(&t.to_le_bytes());
        }
        None => out.push(0x00),
    }
    out.extend_from_slice(&uleb_bytes(p.gas_limit));
    out
}

/// Reply bytes for a bare `nat` (icrc1_balance_of, icrc1_decimals, …).
pub fn encode_nat_reply(v: u128) -> Vec<u8> {
    let mut out = vec![0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x7d];
    let mut b = v;
    loop {
        let mut byte = (b & 0x7f) as u8;
        b >>= 7;
        if b != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if b == 0 {
            break;
        }
    }
    out
}

/// Reply bytes for a bare `text` (get_btc_address).
pub fn encode_text_reply(t: &str) -> Vec<u8> {
    let mut out = vec![0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x6a];
    out.push(t.len() as u8);
    out.extend_from_slice(t.as_bytes());
    out
}

/// Reply bytes for a bare `nat8`.
pub fn encode_nat8_reply(v: u8) -> Vec<u8> {
    vec![0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x7b, v]
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
