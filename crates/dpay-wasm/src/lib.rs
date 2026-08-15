//! # dpay-wasm — the frozen wire core as a framework-free wasm32 module
//!
//! The Rust core in `dpay-core` is the SINGLE source of truth for the frozen wire v2 format
//! (`SIGNING_LEN=196`, `WIRE_LEN=292`, `REQUEST_LEN=132`, receipt claim `108`). Android reaches it
//! through the UniFFI bridge; this crate compiles the very same code to
//! `wasm32-unknown-unknown` so every web surface (the browser wallet, merchant terminals) signs and
//! builds the EXACT same bytes as Android — no third JS implementation to drift.
//!
//! The build artifact is staged at `crates/dpay-relay/assets/dpay-core.wasm` (committed, like the
//! shot-*.png assets) and served by the relay at `GET /dpay-core.wasm`. Byte-parity against the
//! trusted JS oracle (`e2e/harness/wire.mjs`) is enforced offline by `scripts/check-wasm-core.mjs`
//! (run by `just wasm`); regenerate the artifact with `just wasm`.
//!
//! ## Design rules
//!
//! - **No framework.** Plain `#[no_mangle] pub extern "C"` exports; no wasm-bindgen, no serde, no
//!   RNG, no wall-clock, no globals that mutate across calls (beyond the bump-allocator cursor).
//!   All functions are pure/synchronous over the module's linear memory.
//! - **Deterministic.** Ed25519 signing with a caller-supplied seed is deterministic, so identical
//!   inputs produce identical bytes on Android, on the canister, and here.
//!
//! ## Memory & ownership contract
//!
//! The module owns its linear memory (no imported memory). All pointer arguments are `u32` byte
//! offsets into it. The protocol for every call:
//!
//! 1. Caller allocates input/output regions with [`w_alloc`] (a page-lifetime bump allocator:
//!    there is no free; regions stay valid until the instance is dropped).
//! 2. Caller writes inputs (e.g. seed bytes, the 132-byte request) into the returned offsets.
//! 3. Caller invokes the export; it reads inputs, writes outputs to the caller's out-pointers,
//!    and returns a status code (see below).
//! 4. Caller reads outputs and may reuse or abandon the regions (nothing is ever freed).
//!
//! Out-of-bounds pointers never trap: every export bounds-checks pointer+len against the current
//! memory size and returns `BAD_LEN` (or `0` for the functions whose success contract is a length)
//! instead of dereferencing. Allocations grow memory as needed; if growth fails, [`w_alloc`]
//! returns `0` (treat as OOM). Input buffers must be fully written BEFORE calling; outputs are
//! only valid after a success return.
//!
//! ## Export interface (FROZEN — web integrations compile against these exact symbols)
//!
//! | export | signature | notes |
//! |---|---|---|
//! | `w_alloc` | `(size: u32) -> u32` | bump allocator; page lifetime, no free; `0` = OOM |
//! | `w_abi_version` | `() -> u32` | always `1` |
//! | `w_layout_json` | `(out_ptr: u32, cap: u32) -> u32` | the core's wire layout as JSON, the same document `dfx/wire_layout.json` describes; returns bytes written, `0` if `cap` too small |
//! | `w_error_message` | `(code: u32, out_ptr: u32, cap: u32) -> u32` | static ASCII error string per code; returns bytes written, `0` if `cap` too small |
//! | `w_pubkey` | `(seed_ptr: u32, out_pub32: u32) -> u32` | ed25519 public key of the 32-byte seed |
//! | `w_sign_request` | `(seed_ptr, req_ptr /*132*/, from_name_ptr, from_name_len, out_wire_ptr /*292*/) -> u32` | signs the scanned request exactly as the app does (see below) |
//! | `w_decode_request` | `(req_ptr, out_json_ptr, cap) -> u32` | request → JSON `{toHex,amount,nonceHex,expiry,currency,toName,memo}`; `amount`/`expiry` are decimal strings (u64-exact); returns len, `0` on cap-too-small |
//! | `w_sign_withdraw` | `(seed_ptr, dest_ptr, dest_len, amount_lo, amount_hi, nonce_ptr, expiry_lo, expiry_hi, currency, out_sig_ptr /*64*/) -> u32` | signs the `WithdrawAuth` layout; u64s passed as (lo, hi) u32 halves |
//! | `w_verify_receipt_sig` | `(pub_ptr, claim_ptr, claim_len, sig_ptr) -> u32` | `1` = valid, `0` = invalid (any reason) |
//!
//! `w_sign_request` semantics: it builds the signed authorization from the request's own
//! `to`/`amount`/`nonce`/`expiry`/`currency`/`to_name`/`memo` fields verbatim (the same
//! `PaymentRequest::to_authorization` path the app uses), sets `from` to the seed's public key and
//! `from_name` to the caller's UTF-8 name NUL-padded/truncated to 32 bytes (byte-truncation, the
//! core's pad rule), then writes `signing|sig|from_pub` (292 bytes) and returns `OK`.
//!
//! ## Status codes
//!
//! | code | name | meaning |
//! |---|---|---|
//! | `0` | `OK` | success |
//! | `1` | `BAD_LEN` | out-of-bounds pointer, wrong fixed size, or (for JSON writers) too-small cap |
//! | `2` | `BAD_UTF8` | a caller-supplied string was not valid UTF-8 |
//! | `3` | `VERIFY_FAILED` | a signature/attestation check failed (reserved; the boolean verifiers return `0/1` instead) |

use core::sync::atomic::{AtomicU32, Ordering};

use dpay_core::{
    Authorization, PaymentRequest, ReceiptClaim, SignedAuthorization, WithdrawAuth, DEMO_USD,
    MEMO_LEN, NAME_LEN, NONCE_LEN, PUBKEY_LEN, RECEIPT_CLAIM_LEN, REQUEST_LEN, SIG_LEN,
    SIGNING_LEN, WIRE_LEN,
};
use ed25519_dalek::SigningKey;

/// Everything succeeded.
pub const OK: u32 = 0;
/// A pointer/length pair was out of bounds, or a fixed-size buffer had the wrong size, or an
/// output capacity was too small.
pub const BAD_LEN: u32 = 1;
/// A caller-supplied string was not valid UTF-8.
pub const BAD_UTF8: u32 = 2;
/// A signature or attestation check failed (reserved for future boolean-style exports).
pub const VERIFY_FAILED: u32 = 3;

// --- linear memory plumbing -------------------------------------------------------------------
//
// The module owns its memory. `mem_pages`/`grow_pages` are wasm intrinsics; the host fallbacks make
// `cargo check -p dpay-wasm` (host triple) compile clean AND behave safely: memory reports as
// empty on the host, so every bounds check fails and no export ever dereferences a wild pointer.
// Host builds exist for compile-checking only — the deliverable is the wasm32 cdylib.

#[cfg(target_arch = "wasm32")]
fn mem_pages() -> usize {
    core::arch::wasm32::memory_size(0)
}
#[cfg(not(target_arch = "wasm32"))]
fn mem_pages() -> usize {
    0
}

#[cfg(target_arch = "wasm32")]
fn grow_pages(delta: usize) -> usize {
    core::arch::wasm32::memory_grow(0, delta)
}
#[cfg(not(target_arch = "wasm32"))]
fn grow_pages(_delta: usize) -> usize {
    usize::MAX // growth always "fails" on the compile-check-only host build
}

/// Current memory size in bytes (0 on the host → every bounds check fails there).
fn mem_bytes() -> u64 {
    mem_pages() as u64 * 65536
}

/// Is `[off, off+len)` fully inside linear memory?
fn in_bounds(off: u32, len: u32) -> bool {
    off as u64 + len as u64 <= mem_bytes()
}

/// # Safety
/// `[off, off+len)` must be in bounds (caller checked via [`in_bounds`]).
unsafe fn slice_at(off: u32, len: u32) -> &'static [u8] {
    core::slice::from_raw_parts(off as *const u8, len as usize)
}

/// # Safety
/// `[off, off+bytes.len())` must be in bounds (caller checked via [`in_bounds`]).
unsafe fn write_at(off: u32, bytes: &[u8]) {
    (off as *mut u8).copy_from_nonoverlapping(bytes.as_ptr(), bytes.len());
}

// --- the bump allocator -----------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
extern "C" {
    /// wasm-ld symbol: first free byte after the module's static data. The heap starts here.
    static __heap_base: u8;
}

/// First usable heap offset (8-byte aligned). On the host this is a dummy constant — the host
/// build is compile-check only and `w_alloc` fails fast there anyway (`grow_pages` never succeeds).
#[cfg(target_arch = "wasm32")]
fn heap_start() -> u32 {
    (core::ptr::addr_of!(__heap_base) as u32 + 7) & !7
}
#[cfg(not(target_arch = "wasm32"))]
fn heap_start() -> u32 {
    1 << 20
}

/// Bump-allocate `size` bytes (rounded up to 8-byte alignment; `size 0` returns the current top).
/// Grows linear memory on demand. Returns the offset, or `0` on growth failure / exhaustion.
#[no_mangle]
pub extern "C" fn w_alloc(size: u32) -> u32 {
    static HEAP: AtomicU32 = AtomicU32::new(0);
    let size = size.wrapping_add(7) & !7u32; // keep every future allocation 8-aligned
    let mut pos = HEAP.load(Ordering::Relaxed);
    if pos == 0 {
        pos = heap_start();
        HEAP.store(pos, Ordering::Relaxed);
    }
    let end = pos as u64 + size as u64;
    if end > u32::MAX as u64 {
        return 0;
    }
    HEAP.store(pos + size, Ordering::Relaxed);
    if end > mem_bytes() {
        let delta = ((end - mem_bytes()) as usize + 65535) / 65536;
        if grow_pages(delta) == usize::MAX {
            return 0;
        }
    }
    pos
}

/// ABI version of the export surface (see the table in the crate docs). Currently `1`.
#[no_mangle]
pub extern "C" fn w_abi_version() -> u32 {
    1
}

/// Write the module's static error string for `code` to `out_ptr`. Returns bytes written, or `0`
/// if `cap` is too small / `out_ptr` is out of bounds. Strings are plain ASCII.
#[no_mangle]
pub extern "C" fn w_error_message(code: u32, out_ptr: u32, cap: u32) -> u32 {
    let msg: &str = match code {
        0 => "ok",
        1 => "bad_len",
        2 => "bad_utf8",
        3 => "verify_failed",
        _ => "unknown",
    };
    write_str_out(msg.as_bytes(), out_ptr, cap)
}

/// Write `bytes` to `out_ptr` if it fits in `cap`; returns bytes written or `0`.
fn write_str_out(bytes: &[u8], out_ptr: u32, cap: u32) -> u32 {
    if bytes.len() > cap as usize || !in_bounds(out_ptr, bytes.len() as u32) {
        return 0;
    }
    unsafe { write_at(out_ptr, bytes) };
    bytes.len() as u32
}

// --- small pure helpers -----------------------------------------------------------------------

/// The core's pad rule: copy at most the first 32 BYTES (not chars), NUL-fill the rest. Mirrors
/// `wire.mjs#padName32` and the builder-side pad used across the codebase.
fn pad_name(utf8: &[u8]) -> [u8; NAME_LEN] {
    let mut b = [0u8; NAME_LEN];
    let n = utf8.len().min(NAME_LEN);
    b[..n].copy_from_slice(&utf8[..n]);
    b
}

/// Display rule for the fixed 32-byte name/memo fields: bytes up to the first NUL, decoded
/// lossily (mirrors the JS side's NUL-trim + UTF-8 decode).
fn display_field(field: &[u8]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).into_owned()
}

/// Lowercase hex (no external crates in this cdylib).
fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

/// Append `s` as a JSON string literal, escaping the JSON-mandated set. Non-ASCII passes through
/// verbatim (the output is UTF-8 JSON, same as the page-side JSON.parse expects).
fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let v = c as u32;
                out.push_str("\\u00");
                out.push(HEX[(v >> 4) as usize] as char);
                out.push(HEX[(v & 0xf) as usize] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Read the 32-byte seed at `seed_ptr` and derive its ed25519 key.
fn read_seed(seed_ptr: u32) -> Result<SigningKey, u32> {
    if !in_bounds(seed_ptr, PUBKEY_LEN as u32) {
        return Err(BAD_LEN);
    }
    let bytes: [u8; PUBKEY_LEN] = unsafe { slice_at(seed_ptr, PUBKEY_LEN as u32) }
        .try_into()
        .unwrap();
    Ok(SigningKey::from_bytes(&bytes))
}

// --- exports ----------------------------------------------------------------------------------

/// Write the seed's 32-byte ed25519 public key to `out_pub32`.
#[no_mangle]
pub extern "C" fn w_pubkey(seed_ptr: u32, out_pub32: u32) -> u32 {
    let sk = match read_seed(seed_ptr) {
        Ok(sk) => sk,
        Err(e) => return e,
    };
    if !in_bounds(out_pub32, PUBKEY_LEN as u32) {
        return BAD_LEN;
    }
    unsafe { write_at(out_pub32, &sk.verifying_key().to_bytes()) };
    OK
}

/// Sign the scanned 132-byte request at `req_ptr` as the app does: authorization = the request's
/// own fields + `from` = the seed's pubkey + `from_name` = the caller's UTF-8 name (validated as
/// UTF-8, then byte-padded/truncated to 32). Writes `signing|sig|from_pub` (292 bytes) to
/// `out_wire_ptr`.
#[no_mangle]
pub extern "C" fn w_sign_request(
    seed_ptr: u32,
    req_ptr: u32,
    from_name_ptr: u32,
    from_name_len: u32,
    out_wire_ptr: u32,
) -> u32 {
    let sk = match read_seed(seed_ptr) {
        Ok(sk) => sk,
        Err(e) => return e,
    };
    if !in_bounds(req_ptr, REQUEST_LEN as u32) {
        return BAD_LEN;
    }
    let request = match PaymentRequest::from_bytes(unsafe { slice_at(req_ptr, REQUEST_LEN as u32) }) {
        Ok(r) => r,
        Err(_) => return BAD_LEN,
    };
    if !in_bounds(from_name_ptr, from_name_len) {
        return BAD_LEN;
    }
    let name = match std::str::from_utf8(unsafe { slice_at(from_name_ptr, from_name_len) }) {
        Ok(s) => s,
        Err(_) => return BAD_UTF8,
    };
    let auth = request.to_authorization(sk.verifying_key().to_bytes(), pad_name(name.as_bytes()));
    let wire = SignedAuthorization::new(&sk, auth).to_wire();
    if !in_bounds(out_wire_ptr, WIRE_LEN as u32) {
        return BAD_LEN;
    }
    unsafe { write_at(out_wire_ptr, &wire) };
    OK
}

/// Decode the 132-byte request at `req_ptr` into JSON at `out_json_ptr` (compact UTF-8 JSON):
/// `{"toHex":…,"amount":…,"nonceHex":…,"expiry":…,"currency":…,"toName":…,"memo":…}`.
/// `amount`/`expiry` are decimal STRINGS (u64-exact for JS), `currency` a JSON number. Returns the
/// byte length written, or `0` if `cap` is too small / the request pointer is out of bounds.
#[no_mangle]
pub extern "C" fn w_decode_request(req_ptr: u32, out_json_ptr: u32, cap: u32) -> u32 {
    if !in_bounds(req_ptr, REQUEST_LEN as u32) {
        return 0;
    }
    let Ok(request) = PaymentRequest::from_bytes(unsafe { slice_at(req_ptr, REQUEST_LEN as u32) })
    else {
        return 0;
    };
    let mut json = String::with_capacity(288);
    json.push_str("{\"toHex\":\"");
    json.push_str(&hex(&request.to));
    json.push_str("\",\"amount\":\"");
    json.push_str(&request.amount.to_string());
    json.push_str("\",\"nonceHex\":\"");
    json.push_str(&hex(&request.nonce));
    json.push_str("\",\"expiry\":\"");
    json.push_str(&request.expiry.to_string());
    json.push_str("\",\"currency\":");
    json.push_str(&request.currency.to_string());
    json.push_str(",\"toName\":");
    push_json_str(&mut json, &display_field(&request.to_name));
    json.push_str(",\"memo\":");
    push_json_str(&mut json, &display_field(&request.memo));
    json.push('}');
    write_str_out(json.as_bytes(), out_json_ptr, cap)
}

/// Sign a withdrawal: `WithdrawAuth = from_pubkey(32) | amount u64le | nonce(16) | expiry u64le |
/// currency u32le | addr_len u32le | addr utf8` with `from_pubkey` = the seed's pubkey. The u64s
/// arrive as (lo, hi) u32 halves (JS side splits its BigInt). Writes the 64-byte signature to
/// `out_sig_ptr`.
#[no_mangle]
pub extern "C" fn w_sign_withdraw(
    seed_ptr: u32,
    dest_ptr: u32,
    dest_len: u32,
    amount_lo: u32,
    amount_hi: u32,
    nonce_ptr: u32,
    expiry_lo: u32,
    expiry_hi: u32,
    currency: u32,
    out_sig_ptr: u32,
) -> u32 {
    let sk = match read_seed(seed_ptr) {
        Ok(sk) => sk,
        Err(e) => return e,
    };
    if !in_bounds(dest_ptr, dest_len) || !in_bounds(nonce_ptr, NONCE_LEN as u32) {
        return BAD_LEN;
    }
    let dest = match std::str::from_utf8(unsafe { slice_at(dest_ptr, dest_len) }) {
        Ok(s) => s.to_string(),
        Err(_) => return BAD_UTF8,
    };
    let nonce: [u8; NONCE_LEN] = unsafe { slice_at(nonce_ptr, NONCE_LEN as u32) }
        .try_into()
        .unwrap();
    let auth = WithdrawAuth {
        from_pubkey: sk.verifying_key().to_bytes(),
        destination: dest,
        amount: (u64::from(amount_hi) << 32) | u64::from(amount_lo),
        nonce,
        expiry: (u64::from(expiry_hi) << 32) | u64::from(expiry_lo),
        currency,
    };
    let sig = dpay_core::sign_withdraw(&sk, &auth).to_bytes();
    if !in_bounds(out_sig_ptr, SIG_LEN as u32) {
        return BAD_LEN;
    }
    unsafe { write_at(out_sig_ptr, &sig) };
    OK
}

/// Verify a receipt signature: `pub` = 32-byte receipt pubkey, `claim` = the frozen 108-byte
/// receipt-claim layout (`nonce|from|to|amount|currency|block_index|settle_ts`, little-endian,
/// exactly `wire_layout.json`'s `receipt` section), `sig` = 64 bytes. Returns `1` valid / `0`
/// invalid (bad lengths count as invalid — there is no error channel on a boolean).
#[no_mangle]
pub extern "C" fn w_verify_receipt_sig(
    pub_ptr: u32,
    claim_ptr: u32,
    claim_len: u32,
    sig_ptr: u32,
) -> u32 {
    if claim_len != RECEIPT_CLAIM_LEN as u32 {
        return 0;
    }
    if !in_bounds(pub_ptr, PUBKEY_LEN as u32)
        || !in_bounds(claim_ptr, claim_len)
        || !in_bounds(sig_ptr, SIG_LEN as u32)
    {
        return 0;
    }
    let claim = parse_receipt_claim(unsafe { slice_at(claim_ptr, claim_len) });
    let key: [u8; PUBKEY_LEN] = unsafe { slice_at(pub_ptr, PUBKEY_LEN as u32) }
        .try_into()
        .unwrap();
    let sig: [u8; SIG_LEN] = unsafe { slice_at(sig_ptr, SIG_LEN as u32) }
        .try_into()
        .unwrap();
    u32::from(dpay_core::verify_receipt(&key, &claim, &sig))
}

/// Parse the frozen 108-byte claim layout into a [`ReceiptClaim`] (see `wire_layout.json`'s
/// `receipt.fields`). The slice length is exactly `RECEIPT_CLAIM_LEN` (checked by the caller).
fn parse_receipt_claim(b: &[u8]) -> ReceiptClaim {
    ReceiptClaim {
        nonce: b[0..16].try_into().unwrap(),
        from: b[16..48].try_into().unwrap(),
        to: b[48..80].try_into().unwrap(),
        amount: u64::from_le_bytes(b[80..88].try_into().unwrap()),
        currency: u32::from_le_bytes(b[88..92].try_into().unwrap()),
        block_index: u64::from_le_bytes(b[92..100].try_into().unwrap()),
        settle_ts: u64::from_le_bytes(b[100..108].try_into().unwrap()),
    }
}

/// Write the core's wire layout as JSON — the same document `dfx/wire_layout.json` describes
/// (generated by `dpay-fixture`, byte-validated by the e2e cross-val suite). Web pages parse this
/// instead of hardcoding offsets, so a layout change travels with the binary that implements it.
/// Returns bytes written, or `0` if `cap` is too small.
#[no_mangle]
pub extern "C" fn w_layout_json(out_ptr: u32, cap: u32) -> u32 {
    write_str_out(layout_json().as_bytes(), out_ptr, cap)
}

// --- the layout document (mirrors dpay-fixture's emitter; pinned by check-wasm-core.mjs) -------

/// Append one field-spec entry `"<name>":{"offset":…,"len":…}` plus `"endian":"le"|null` when
/// `le` is `Some` (wire-block fields carry no `endian` member — they are opaque byte regions);
/// `first` marks the first entry of its object (no leading comma).
fn push_field(s: &mut String, first: bool, name: &str, off: usize, len: usize, le: Option<bool>) {
    if !first {
        s.push(',');
    }
    s.push('"');
    s.push_str(name);
    s.push_str("\":{\"offset\":");
    s.push_str(&off.to_string());
    s.push_str(",\"len\":");
    s.push_str(&len.to_string());
    if let Some(le) = le {
        s.push_str(",\"endian\":");
        s.push_str(if le { "\"le\"" } else { "null" });
    }
    s.push('}');
}

/// Build the layout JSON from the core's own constants and golden values — no serde, no floats:
/// every number is an integer offset/length, every byte blob is lowercase hex, `endian` is `null`
/// or `"le"`. Mirrors dpay-fixture's emitter field-for-field (same deterministic seeds: key 0x03
/// pays/signs, key 0x04 receives).
fn layout_json() -> String {
    let payer = SigningKey::from_bytes(&[3u8; PUBKEY_LEN]);
    let merchant = SigningKey::from_bytes(&[4u8; PUBKEY_LEN]);
    let payer_pub = payer.verifying_key().to_bytes();
    let merchant_pub = merchant.verifying_key().to_bytes();

    // The pay golden (identical inputs to dpay-fixture / dfx/wire_layout.json).
    let nonce = [42u8; NONCE_LEN];
    let auth = Authorization {
        from: payer_pub,
        to: merchant_pub,
        amount: 2500,
        nonce,
        expiry: 4102444800,
        currency: DEMO_USD,
        from_name: pad_name(b"Alice"),
        to_name: pad_name(b"Bob"),
        memo: pad_name(b"dinner"),
    };
    let signing = auth.signing_bytes();
    let wire = SignedAuthorization::new(&payer, auth).to_wire();
    let sig = &wire[SIGNING_LEN..SIGNING_LEN + SIG_LEN];
    let request = PaymentRequest {
        to: merchant_pub,
        amount: 2500,
        nonce,
        expiry: 4102444800,
        currency: DEMO_USD,
        to_name: pad_name(b"Bob"),
        memo: pad_name(b"coffee"),
    };
    let request_bytes = request.to_bytes();

    // The withdraw golden.
    let withdraw = WithdrawAuth {
        from_pubkey: payer_pub,
        destination: String::from("bc1qdpaygoldenwithdrawaladdress"),
        amount: 50000,
        nonce,
        expiry: 4102444800,
        currency: DEMO_USD,
    };
    let withdraw_signing = withdraw.signing_bytes();
    let withdraw_sig = dpay_core::sign_withdraw(&payer, &withdraw).to_bytes();

    // The receipt golden.
    let claim = ReceiptClaim {
        nonce,
        from: payer_pub,
        to: merchant_pub,
        amount: 1234,
        currency: DEMO_USD,
        block_index: 7,
        settle_ts: 1700000000,
    };
    let claim_signing = claim.signing_bytes();
    let claim_sig = dpay_core::sign_receipt(&payer, &claim).to_bytes();

    // Offsets, computed exactly like dpay-fixture from the core constants.
    let (from_off, to_off) = (0, PUBKEY_LEN);
    let amount_off = 2 * PUBKEY_LEN;
    let nonce_off = amount_off + 8;
    let expiry_off = nonce_off + NONCE_LEN;
    let currency_off = expiry_off + 8;
    let from_name_off = currency_off + 4;
    let to_name_off = from_name_off + NAME_LEN;
    let memo_off = to_name_off + NAME_LEN;

    let req_amount_off = PUBKEY_LEN;
    let req_nonce_off = req_amount_off + 8;
    let req_expiry_off = req_nonce_off + NONCE_LEN;
    let req_currency_off = req_expiry_off + 8;
    let req_to_name_off = req_currency_off + 4;
    let req_memo_off = req_to_name_off + NAME_LEN;

    let w_amount_off = PUBKEY_LEN;
    let w_nonce_off = w_amount_off + 8;
    let w_expiry_off = w_nonce_off + NONCE_LEN;
    let w_currency_off = w_expiry_off + 8;
    let w_addr_len_off = w_currency_off + 4;
    // dpay-fixture's `fixed_len` (68) = offset of the address-length prefix, i.e. the fixed
    // from_pubkey|amount|nonce|expiry|currency block; the u32 length + address bytes follow it.
    let withdraw_fixed = w_addr_len_off;

    let r_from_off = NONCE_LEN;
    let r_to_off = r_from_off + PUBKEY_LEN;
    let r_amount_off = r_to_off + PUBKEY_LEN;
    let r_currency_off = r_amount_off + 8;
    let r_block_off = r_currency_off + 4;
    let r_settle_off = r_block_off + 8;

    // Compact JSON, emitted in the same field order as the committed dfx/wire_layout.json.
    let mut s = String::with_capacity(4096);
    use std::fmt::Write as _;
    let _ = write!(
        s,
        "{{\"signing_len\":{SIGNING_LEN},\"wire_len\":{WIRE_LEN},\"request_len\":{REQUEST_LEN},\
         \"sig_len\":{SIG_LEN},\"pubkey_len\":{PUBKEY_LEN},\"nonce_len\":{NONCE_LEN},\
         \"name_len\":{NAME_LEN},\"memo_len\":{MEMO_LEN},\"fields\":{{"
    );
    push_field(&mut s, true, "from", from_off, PUBKEY_LEN, Some(false));
    push_field(&mut s, false, "to", to_off, PUBKEY_LEN, Some(false));
    push_field(&mut s, false, "amount", amount_off, 8, Some(true));
    push_field(&mut s, false, "nonce", nonce_off, NONCE_LEN, Some(false));
    push_field(&mut s, false, "expiry", expiry_off, 8, Some(true));
    push_field(&mut s, false, "currency", currency_off, 4, Some(true));
    push_field(&mut s, false, "from_name", from_name_off, NAME_LEN, Some(false));
    push_field(&mut s, false, "to_name", to_name_off, NAME_LEN, Some(false));
    push_field(&mut s, false, "memo", memo_off, MEMO_LEN, Some(false));
    s.push_str("},\"request_fields\":{");
    push_field(&mut s, true, "to", 0, PUBKEY_LEN, Some(false));
    push_field(&mut s, false, "amount", req_amount_off, 8, Some(true));
    push_field(&mut s, false, "nonce", req_nonce_off, NONCE_LEN, Some(false));
    push_field(&mut s, false, "expiry", req_expiry_off, 8, Some(true));
    push_field(&mut s, false, "currency", req_currency_off, 4, Some(true));
    push_field(&mut s, false, "to_name", req_to_name_off, NAME_LEN, Some(false));
    push_field(&mut s, false, "memo", req_memo_off, MEMO_LEN, Some(false));
    s.push_str("},\"wire_fields\":{");
    push_field(&mut s, true, "signing", 0, SIGNING_LEN, None);
    push_field(&mut s, false, "sig", SIGNING_LEN, SIG_LEN, None);
    push_field(&mut s, false, "from_pub", SIGNING_LEN + SIG_LEN, PUBKEY_LEN, None);
    s.push_str("},\"golden\":{\"secret_hex\":\"");
    s.push_str(&hex(&[3u8; PUBKEY_LEN]));
    s.push_str("\",\"public_hex\":\"");
    s.push_str(&hex(&payer_pub));
    s.push_str("\",\"to_hex\":\"");
    s.push_str(&hex(&merchant_pub));
    s.push_str("\",\"amount\":2500,\"nonce_hex\":\"");
    s.push_str(&hex(&nonce));
    s.push_str("\",\"expiry\":4102444800,\"currency\":0,\"signing_hex\":\"");
    s.push_str(&hex(&signing));
    s.push_str("\",\"sig_hex\":\"");
    s.push_str(&hex(sig));
    s.push_str("\",\"wire_hex\":\"");
    s.push_str(&hex(&wire));
    s.push_str("\",\"request_hex\":\"");
    s.push_str(&hex(&request_bytes));
    s.push_str("\",\"from_name_hex\":\"");
    s.push_str(&hex(&pad_name(b"Alice")));
    s.push_str("\",\"to_name_hex\":\"");
    s.push_str(&hex(&pad_name(b"Bob")));
    s.push_str("\",\"memo_hex\":\"");
    s.push_str(&hex(&pad_name(b"dinner")));
    s.push_str("\",\"request_to_name_hex\":\"");
    s.push_str(&hex(&pad_name(b"Bob")));
    s.push_str("\",\"request_memo_hex\":\"");
    s.push_str(&hex(&pad_name(b"coffee")));
    s.push_str("\"},\"withdraw\":{\"fixed_len\":");
    let _ = write!(s, "{withdraw_fixed}");
    s.push_str(",\"addr_len_bytes\":4,\"fields\":{");
    push_field(&mut s, true, "from_pubkey", 0, PUBKEY_LEN, Some(false));
    push_field(&mut s, false, "amount", w_amount_off, 8, Some(true));
    push_field(&mut s, false, "nonce", w_nonce_off, NONCE_LEN, Some(false));
    push_field(&mut s, false, "expiry", w_expiry_off, 8, Some(true));
    push_field(&mut s, false, "currency", w_currency_off, 4, Some(true));
    push_field(&mut s, false, "address_len", w_addr_len_off, 4, Some(true));
    s.push_str("},\"golden\":{\"secret_hex\":\"");
    s.push_str(&hex(&[3u8; PUBKEY_LEN]));
    s.push_str("\",\"public_hex\":\"");
    s.push_str(&hex(&payer_pub));
    s.push_str("\",\"destination\":\"bc1qdpaygoldenwithdrawaladdress\",\"amount\":50000,\"nonce_hex\":\"");
    s.push_str(&hex(&nonce));
    s.push_str("\",\"expiry\":4102444800,\"currency\":0,\"signing_hex\":\"");
    s.push_str(&hex(&withdraw_signing));
    s.push_str("\",\"sig_hex\":\"");
    s.push_str(&hex(&withdraw_sig));
    s.push_str("\"}},\"receipt\":{\"fixed_len\":");
    let _ = write!(s, "{RECEIPT_CLAIM_LEN}");
    s.push_str(",\"fields\":{");
    push_field(&mut s, true, "nonce", 0, NONCE_LEN, Some(false));
    push_field(&mut s, false, "from", r_from_off, PUBKEY_LEN, Some(false));
    push_field(&mut s, false, "to", r_to_off, PUBKEY_LEN, Some(false));
    push_field(&mut s, false, "amount", r_amount_off, 8, Some(true));
    push_field(&mut s, false, "currency", r_currency_off, 4, Some(true));
    push_field(&mut s, false, "block_index", r_block_off, 8, Some(true));
    push_field(&mut s, false, "settle_ts", r_settle_off, 8, Some(true));
    s.push_str("},\"golden\":{\"secret_hex\":\"");
    s.push_str(&hex(&[3u8; PUBKEY_LEN]));
    s.push_str("\",\"public_hex\":\"");
    s.push_str(&hex(&payer_pub));
    s.push_str("\",\"from_hex\":\"");
    s.push_str(&hex(&payer_pub));
    s.push_str("\",\"to_hex\":\"");
    s.push_str(&hex(&merchant_pub));
    s.push_str("\",\"amount\":1234,\"nonce_hex\":\"");
    s.push_str(&hex(&nonce));
    s.push_str("\",\"currency\":0,\"block_index\":7,\"settle_ts\":1700000000,\"signing_hex\":\"");
    s.push_str(&hex(&claim_signing));
    s.push_str("\",\"sig_hex\":\"");
    s.push_str(&hex(&claim_sig));
    s.push_str("\"}}");
    s.push('}');
    s
}
