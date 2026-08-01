#!/usr/bin/env python3
"""Language-level roundtrip test for the dpay UniFFI binding.

Every call below crosses the FFI into the *same* compiled `dpay-core` that the canister, relay,
and sim link — so a green run here is direct evidence that the app's languages sign and verify
with the real ledger code, not a re-implementation. Run via `verify.sh` (sets PYTHONPATH).
"""
import sys

import dpay_ffi as d

# ---------------------------------------------------------------------------------------------
# Wire layout (must match dpay_core::SignedAuthorization::to_wire): 292 bytes total (wire-format v2).
#   [0..196)   signing_bytes = from(32) | to(32) | amount_le(8) | nonce(16) | expiry_le(8) |
#               currency_le(4) | from_name(32) | to_name(32) | memo(32)
#   [196..260) signature(64)
#   [260..292) from_pub(32)
SIG_OFF, SIG_END = 196, 260
FROM_PUB_OFF = 260
WIRE_LEN = 292
# Name/memo field offsets inside the signing region (UTF-8, NUL-padded, truncate to 32).
FROM_NAME_OFF, TO_NAME_OFF, MEMO_OFF = 100, 132, 164

passed = 0
def check(cond, label):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label}")
    passed += 1
    print(f"  ok  {label}")


# 1) A device keypair signs an authorization ---------------------------------------------------
kp = d.generate_keypair()
check(len(kp.secret) == 32, "generate_keypair -> 32-byte secret seed")
check(len(kp.public) == 32, "generate_keypair -> 32-byte public key")

to_kp = d.generate_keypair()          # the merchant / payee identity
amount = 1499                          # $14.99 in minor units
nonce = bytes(range(16))              # stands in for the merchant's request_id
expiry = 2_000_000_000                 # far-future unix seconds
# Display names + memo (wire-format v2): all three ride inside the signed bytes so history is
# self-describing on both sides. `from_name` is the payer's own; `to_name` + `memo` come from the
# scanned merchant request. Both signing paths (this native FFI + the web TS shim) carry them.
FROM_NAME, TO_NAME, MEMO = "Alice", "Bob", "coffee"

wire = d.sign_authorization(kp.secret, to_kp.public, amount, nonce, expiry, 0,
                            FROM_NAME, TO_NAME, MEMO)
check(len(wire) == WIRE_LEN, f"sign_authorization -> {WIRE_LEN}-byte wire blob")
# The exported length accessors must agree with the real wire the core just produced (the App.tsx
# self-check derives its expected hex length from `wireLen()` — a mismatch here would rot that check).
check(d.wire_len() == WIRE_LEN, f"wire_len() == {WIRE_LEN} (matches the signed wire)")
check(d.signing_len() == 196, "signing_len() == 196 (the 196-byte signed region)")
check(d.request_len() == 132, "request_len() == 132 (the merchant request wire)")
check(len(wire) == d.wire_len(), "signed wire length matches wire_len()")
check(wire[0:32] == kp.public, "wire `from` == signer public key (consent bound to signer)")
check(wire[FROM_PUB_OFF:WIRE_LEN] == kp.public, "wire carries payer pubkey for directory-free verify")

# Names ride inside the signed region, NUL-padded to 32 bytes (positions 100..196). A byte-exact
# check here is the native-path analogue of e2e cross-val for the web shim — both paths agree.
check(wire[FROM_NAME_OFF:FROM_NAME_OFF + len(FROM_NAME)] == FROM_NAME.encode(),
      "wire carries `from_name` (Alice) NUL-padded at offset 100")
check(wire[TO_NAME_OFF:TO_NAME_OFF + len(TO_NAME)] == TO_NAME.encode(),
      "wire carries `to_name` (Bob) NUL-padded at offset 132")
check(wire[MEMO_OFF:MEMO_OFF + len(MEMO)] == MEMO.encode(),
      "wire carries `memo` (coffee) NUL-padded at offset 164")
check(wire[FROM_NAME_OFF + len(FROM_NAME)] == 0, "from_name is NUL-padded after the ASCII bytes")

# A name-field tamper MUST invalidate the signature — names are authenticated, not advisory.
name_tampered = bytearray(wire)
name_tampered[FROM_NAME_OFF] ^= 0x01    # flip the first byte of from_name (inside signing_bytes)
check(d.verify_wire(bytes(name_tampered)) is False, "verify_wire(from_name-tampered) == False")


# 2) Wire <-> base64url QR string round-trips exactly ------------------------------------------
qr = d.encode_qr(wire)
check(isinstance(qr, str) and len(qr) == 390, "encode_qr -> 390-char base64url (no pad; 292 B wire)")
import base64
check(base64.urlsafe_b64decode(qr + "==") == wire, "QR string is real base64url of the wire")
back = d.decode_qr(qr)
check(back == wire, "decode_qr(encode_qr(wire)) == wire  (roundtrip is lossless)")


# 3) verify_wire: TRUE for a good sig, FALSE after flipping one signature byte -----------------
check(d.verify_wire(wire) is True, "verify_wire(good) == True")

tampered = bytearray(wire)
tampered[SIG_OFF] ^= 0x01             # flip a bit inside the signature; from/from_pub stay equal
check(bytes(tampered) != wire, "tamper actually changed the bytes")
check(d.verify_wire(bytes(tampered)) is False, "verify_wire(sig-flipped) == False")

# A payload-tamper (change the amount) must also fail the carried signature.
amt_tampered = bytearray(wire)
amt_tampered[64] ^= 0xFF              # first byte of amount_le
check(d.verify_wire(bytes(amt_tampered)) is False, "verify_wire(amount-tampered) == False")


# 4) validate: accepts a good payment, rejects expired / over-cap / etc. -----------------------
NOW = 1_700_000_000
GOOD_EXPIRY = NOW + 120               # ~2 min window, like the real short expiry
check(d.validate(amount, NOW, GOOD_EXPIRY, 10_000, 50_000, False, True) is None,
      "validate(good) == None  (accepted)")
check(d.validate(amount, NOW, NOW - 1, 10_000, 50_000, False, True) == "expired",
      "validate(expired) == 'expired'")
check(d.validate(amount, NOW, GOOD_EXPIRY, 100, 50_000, False, True) == "over_cap",
      "validate(amount>cap) == 'over_cap'")
check(d.validate(amount, NOW, GOOD_EXPIRY, 10_000, 100, False, True) == "insufficient_funds",
      "validate(amount>balance) == 'insufficient_funds'")
check(d.validate(0, NOW, GOOD_EXPIRY, 10_000, 50_000, False, True) == "zero_amount",
      "validate(zero) == 'zero_amount'")
check(d.validate(amount, NOW, GOOD_EXPIRY, 10_000, 50_000, True, True) == "nonce_reused",
      "validate(nonce seen) == 'nonce_reused'")
check(d.validate(amount, NOW, GOOD_EXPIRY, 10_000, 50_000, False, False) == "bad_signature",
      "validate(sig_ok=False) == 'bad_signature'")


# 5) Cross-language error mapping: malformed inputs raise typed DpayError -----------------------
try:
    d.sign_authorization(b"\x00" * 31, to_kp.public, amount, nonce, expiry, 0,
                         FROM_NAME, TO_NAME, MEMO)
    raise AssertionError("FAILED: short secret should have raised")
except d.DpayError.BadSecretLength:
    check(True, "short secret -> DpayError.BadSecretLength")

# 5b) Merchant request QR (encode_request / decode_request) carries to_name + memo --------------
# The merchant's to_name + memo live inside the 132-byte request bytes; decoding recovers them as
# strings (NUL-trimmed, lossy). This is the QR-path twin of the NFC request check in section 6.
req_qr = d.encode_request(to_kp.public, amount, nonce, expiry, 0, TO_NAME, MEMO)
decoded = d.decode_request(req_qr)
check(decoded.amount == amount, "decode_request round-trips amount")
check(decoded.nonce == nonce, "decode_request round-trips nonce")
check(decoded.to_name == TO_NAME, "decode_request carries `to_name` (Bob)")
check(decoded.memo == MEMO, "decode_request carries `memo` (coffee)")

try:
    d.decode_qr("!!!not-base64!!!")
    raise AssertionError("FAILED: bad base64 should have raised")
except d.DpayError.BadBase64:
    check(True, "malformed QR -> DpayError.BadBase64")

# A wire whose `from` disagrees with `from_pub` is rejected at parse time (not silently verified).
mismatch = bytearray(wire)
mismatch[FROM_PUB_OFF] ^= 0x01         # perturb from_pub only (first byte of the from_pub region)
try:
    d.verify_wire(bytes(mismatch))
    raise AssertionError("FAILED: pubkey mismatch should have raised")
except d.DpayError.PubkeyMismatch:
    check(True, "from/from_pub mismatch -> DpayError.PubkeyMismatch")


# 6) NFC transport: drive the whole HCE card <-> reader exchange through the real core ---------
# Every APDU below is built, parsed, framed, and reassembled by the *same* compiled dpay-core the
# canister links — so a green run proves the phone's NFC path signs & settles the real ledger code.
MAX_CHUNK = d.nfc_default_max_chunk()
check(MAX_CHUNK == 240, "nfc_default_max_chunk() == 240")

req_nonce = bytes(range(16, 32))                       # the merchant's request_id -> ledger nonce
REQ_TO_NAME, REQ_MEMO = "Bob", "tap-memo"              # merchant-defined; copied verbatim by the payer
req_bytes = d.nfc_request_bytes(to_kp.public, amount, req_nonce, expiry, 0, REQ_TO_NAME, REQ_MEMO)
check(len(req_bytes) == 132, "nfc_request_bytes -> 132-byte request wire (wire-format v2)")
# The merchant's to_name + memo ride inside the 132-byte request (offsets 68 / 100), NUL-padded.
check(req_bytes[68:68 + len(REQ_TO_NAME)] == REQ_TO_NAME.encode(),
      "nfc_request_bytes carries `to_name` (Bob) at offset 68")
check(req_bytes[100:100 + len(REQ_MEMO)] == REQ_MEMO.encode(),
      "nfc_request_bytes carries `memo` (tap-memo) at offset 100")
nfc_wire = d.sign_authorization(kp.secret, to_kp.public, amount, req_nonce, expiry, 0,
                                FROM_NAME, TO_NAME, MEMO)


def run_nfc(max_chunk, approve=True):
    """Loop the merchant reader against the payer's HCE card entirely in memory, returning the wire
    the reader reassembled (or None if the payer declined). Bounded so a stuck machine can't hang."""
    card = d.FfiCardSession(max_chunk)
    reader = d.FfiReaderConductor(req_bytes, max_chunk)
    for _ in range(5000):
        cmd = reader.next_command()
        if cmd is None:
            raise AssertionError("reader ran out of commands before finishing")
        resp = card.process(cmd)
        if card.awaiting_decision():
            seen = d.nfc_decode_request(card.request())   # payer reviews "Pay $X to <to_name>"
            assert seen.amount == amount and seen.nonce == req_nonce
            assert seen.to_name == REQ_TO_NAME and seen.memo == REQ_MEMO  # names survived transport
            (card.provide_wire(nfc_wire) if approve else card.decline())
        step = reader.handle_response(resp)
        if step == d.NfcStep.DONE:
            return reader.wire()
        if step == d.NfcStep.DECLINED:
            return None
    raise AssertionError("NFC exchange did not terminate")


# Production single-frame path and the most-aggressive still-valid fragmentation both deliver the
# exact signed wire — and it still verifies under the same crypto the canister enforces. The wire is
# 292 B (wire-format v2); the NFC `seq` byte caps a payload at MAX_FRAMES=256 frames, so 1 byte/frame
# (292 frames) is no longer representable. The smallest chunk that keeps the wire under the ceiling
# is 2 (→ 146 frames), which still exercises heavy multi-frame fragmentation.
#
# chunk=1 on the 292-byte wire is therefore an unrepresentable configuration: the transport must
# refuse it with a typed error (NfcProtocol = Frame(TooManyFrames)) rather than silently truncate.
# Pin that boundary here so a future wire resize or seq widening surfaces explicitly (mirrors the
# core Rust `signed_wire_survives_nfc_and_verifies` mc=1 rejection assertion).
try:
    run_nfc(1)
    raise AssertionError("FAILED: chunk=1 must be unrepresentable (292 frames > MAX_FRAMES=256)")
except d.DpayError.NfcProtocol:
    check(True, "chunk=1 on 292-byte wire -> DpayError.NfcProtocol (TooManyFrames; u8 seq ceiling)")

for mc in (MAX_CHUNK, 2):
    got = run_nfc(mc)
    check(got == nfc_wire, f"NFC exchange delivers byte-identical wire (chunk={mc})")
    check(d.verify_wire(got) is True, f"reassembled wire still verifies (chunk={mc})")

# The decline path surfaces as Declined — never a hang, never a bogus wire.
check(run_nfc(MAX_CHUNK, approve=False) is None, "NFC decline -> reader sees Declined")

# A non-dpay tap (SELECT answered 'application not found') is a typed error, not silent acceptance.
try:
    r = d.FfiReaderConductor(req_bytes, MAX_CHUNK)
    r.next_command()                                   # the SELECT
    r.handle_response(bytes([0x6a, 0x82]))             # SW 6A82: not found
    raise AssertionError("FAILED: NotDpay should have raised")
except d.DpayError.NfcNotDpay:
    check(True, "non-dpay SELECT response -> DpayError.NfcNotDpay")

# provide_wire out of turn is a typed state error, not a silent no-op.
try:
    d.FfiCardSession(MAX_CHUNK).provide_wire(nfc_wire)
    raise AssertionError("FAILED: provide_wire before a request should have raised")
except d.DpayError.NfcWrongState:
    check(True, "provide_wire with no request -> DpayError.NfcWrongState")


# 7) NFC lifecycle phase: the live status the UI renders, read straight from the core machine -----
# The app maps these to a spinner (Linking/Exchanging), a review prompt (AwaitingApproval), and a
# terminal ✓/declined mark (Complete/Declined). Here we step one exchange and assert each transition.
card = d.FfiCardSession(MAX_CHUNK)
reader = d.FfiReaderConductor(req_bytes, MAX_CHUNK)
check(card.phase() == d.NfcPhase.IDLE, "card phase starts Idle")
check(reader.phase() == d.NfcPhase.LINKING, "reader phase starts Linking")

reader.handle_response(card.process(reader.next_command()))          # SELECT handshake
check(reader.phase() == d.NfcPhase.EXCHANGING, "reader -> Exchanging after SELECT")

ack = card.process(reader.next_command())                            # push the request
check(card.phase() == d.NfcPhase.AWAITING_APPROVAL, "card -> AwaitingApproval holding the request")
check(card.is_complete() is False, "card not complete before serving")
reader.handle_response(ack)

card.provide_wire(nfc_wire)                                           # payer approves
check(card.phase() == d.NfcPhase.EXCHANGING, "card -> Exchanging while serving the wire")

# The 292-byte wire (wire-format v2) spans 2 frames at MAX_CHUNK=240 (292 > 240); pull frames until
# the reader reassembles the whole wire. Each frame but the last is Continue; the last is Done.
step = None
for _ in range(100):
    cmd = reader.next_command()
    assert cmd is not None, "reader stalled before pulling the full wire"
    step = reader.handle_response(card.process(cmd))
    if step == d.NfcStep.DONE:
        break
    check(step == d.NfcStep.CONTINUE, "wire-pull frames are Continue until the last (Done)")
check(step == d.NfcStep.DONE, "reader -> Done (has the wire)")
check(card.is_complete() and not card.is_confirmed(), "card: wire sent but not yet confirmed")
check(card.phase() == d.NfcPhase.SETTLING, "card -> Settling (awaiting the receipt)")
check(reader.phase() == d.NfcPhase.SETTLING, "reader -> Settling (about to settle online)")
check(reader.next_command() is None, "reader waits for the merchant to settle online")


# 8) Receipt-return: the (online) merchant hands the settlement outcome back to the offline payer ---
codes = d.nfc_receipt_codes()
check(codes.settled == 0, "receipt code: settled == 0")
receipt = d.nfc_receipt_bytes(req_nonce, codes.settled)          # merchant settled → build receipt
reader.provide_receipt(receipt)
rstep = reader.handle_response(card.process(reader.next_command()))  # push receipt (1 frame)
check(rstep == d.NfcStep.CONFIRMED, "reader -> Confirmed after delivering the receipt")
check(card.is_confirmed() and card.phase() == d.NfcPhase.COMPLETE, "card -> Confirmed / Complete")

# The offline payer decodes the outcome and matches it to the payment it signed (by nonce).
got = d.nfc_decode_receipt(card.receipt())
check(got.settled is True, "payer sees: settled")
check(got.nonce == req_nonce, "receipt nonce matches the signed payment")

# A rejected settlement is carried back just as faithfully.
c2 = d.FfiCardSession(MAX_CHUNK)
r2 = d.FfiReaderConductor(req_bytes, MAX_CHUNK)
while True:
    cmd = r2.next_command()
    if cmd is None:
        r2.provide_receipt(d.nfc_receipt_bytes(req_nonce, codes.rejected))
        continue
    resp = c2.process(cmd)
    if c2.awaiting_decision():
        c2.provide_wire(nfc_wire)
    s = r2.handle_response(resp)
    if s == d.NfcStep.CONFIRMED:
        break
check(d.nfc_decode_receipt(c2.receipt()).settled is False, "payer sees: rejected (settled == False)")


# 9) Exact decimal <-> u64 amount parser (MC1 unit 1) ------------------------------------------
# parse_amount / format_amount call the SAME compiled dpay-core parser the canister/relay link.
# This is the human↔u64 boundary that retires the lossy number/Double amount path: a green run here
# proves the app's languages parse amounts with the real core, exact (no float), at up to 18 decimals.
# Goldens are deterministic and triple-pinned (here + core Rust unit tests + the e2e TS cross-val).

# decimals=2 (cents): "84.00" -> 8400, "0.84" -> 84.
check(d.parse_amount("84.00", 2) == 8400, "parse_amount('84.00', 2) == 8400")
check(d.parse_amount("0.84", 2) == 84, "parse_amount('0.84', 2) == 84")
check(d.parse_amount("8.4", 2) == 840, "parse_amount('8.4', 2) == 840")
check(d.parse_amount("0", 0) == 0, "parse_amount('0', 0) == 0")

# decimals=18: 8.4 -> 8.4e18 (> 2^53; would be WRONG via IEEE-754 float). Surrounding ws trimmed.
check(d.parse_amount("8.4", 18) == 8_400_000_000_000_000_000, "parse_amount('8.4', 18) == 8.4e18 (> 2^53)")
check(d.parse_amount("  8.4  ", 18) == 8_400_000_000_000_000_000, "parse_amount trims surrounding whitespace")
# The 2^53 + 1 f64-loss probe: 0.009007199254740993 * 1e18 == 9007199254740993.
check(d.parse_amount("0.009007199254740993", 18) == 9_007_199_254_740_993, "parse_amount('0.009007199254740993', 18) == 2^53+1")

# format_amount trims trailing fractional zeros; whole numbers render with no decimal point.
check(d.format_amount(8400, 2) == "84", "format_amount(8400, 2) == '84' (trims, no decimal pt)")
check(d.format_amount(84, 2) == "0.84", "format_amount(84, 2) == '0.84'")
check(d.format_amount(42, 0) == "42", "format_amount(42, 0) == '42'")
check(d.format_amount(0, 18) == "0", "format_amount(0, 18) == '0'")
check(d.format_amount(8_400_000_000_000_000_000, 18) == "8.4", "format_amount(8.4e18, 18) == '8.4' (trims 17 zeros)")
check(d.format_amount(9_007_199_254_740_993, 18) == "0.009007199254740993", "format_amount(2^53+1 @18) golden")

# u64::MAX at 18 decimals round-trips exactly (the boundary case; no trailing zero to trim).
U64_MAX = 18_446_744_073_709_551_615
check(d.format_amount(U64_MAX, 18) == "18.446744073709551615", "format_amount(u64::MAX, 18) == canonical")
check(d.parse_amount(d.format_amount(U64_MAX, 18), 18) == U64_MAX, "u64::MAX round-trips at 18 decimals")
# A general round-trip over a few precisions + values (mirrors the core proptest).
for raw, dec in [(0, 0), (1, 2), (99, 2), (8400, 2), (50_000, 8), (U64_MAX, 18), (9_007_199_254_740_993, 18)]:
    check(d.parse_amount(d.format_amount(raw, dec), dec) == raw,
          f"round-trip raw={raw} dec={dec}")

# Rejections map to DpayError.Amount(<code>) — debuggable codes matching the TS mirror's err strings.
# UniFFI surfaces the payload via thiserror's Display, so str(e) is "amount: <code>"; we check the
# code is carried (substring) and the exception TYPE is exactly DpayError.Amount.
def expect_amount_err(human, dec, code, label):
    try:
        d.parse_amount(human, dec)
        raise AssertionError(f"FAILED: {label} should have raised")
    except d.DpayError.Amount as e:
        # str(e) is "amount: <code>" via #[error("amount: {0}")]; the code is the debuggable part.
        check(code in str(e), f"{label} -> DpayError.Amount carries code '{code}' (got '{e}')")

expect_amount_err("", 2, "empty", "empty input")
expect_amount_err("   ", 2, "empty", "whitespace-only input")
expect_amount_err("abc", 2, "not_a_number", "non-numeric")
expect_amount_err("1.2.3", 2, "not_a_number", "multiple dots")
expect_amount_err(".5", 2, "not_a_number", "leading dot (no whole part)")
expect_amount_err("5.", 2, "not_a_number", "trailing dot (no fraction)")
expect_amount_err("-1", 2, "negative", "negative (-1)")
expect_amount_err("-abc", 2, "negative", "leading minus (regardless of shape)")
expect_amount_err("1.5", 0, "too_many_decimals", "1 fractional digit > decimals=0")
expect_amount_err("0.1234567890123456789", 18, "too_many_decimals", "19 frac digits at decimals=18")
expect_amount_err("99999999999999999999999999999", 0, "overflow", "29 nines > u64::MAX")
expect_amount_err("1", 19, "overflow", "decimals > MAX_DECIMALS (18)")


print(f"\nALL {passed} FFI CHECKS PASSED — Python called the real dpay-core across UniFFI.")
sys.exit(0)
