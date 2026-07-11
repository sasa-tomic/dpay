#!/usr/bin/env python3
"""Language-level roundtrip test for the dpay UniFFI binding.

Every call below crosses the FFI into the *same* compiled `dpay-core` that the canister, relay,
and sim link — so a green run here is direct evidence that the app's languages sign and verify
with the real ledger code, not a re-implementation. Run via `verify.sh` (sets PYTHONPATH).
"""
import sys

import dpay_ffi as d

# ---------------------------------------------------------------------------------------------
# Wire layout (must match dpay_core::SignedAuthorization::to_wire): 192 bytes total.
#   [0..96)   signing_bytes = from(32) | to(32) | amount_le(8) | nonce(16) | expiry_le(8)
#   [96..160) signature(64)
#   [160..192) from_pub(32)
SIG_OFF, SIG_END = 96, 160
WIRE_LEN = 192

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

wire = d.sign_authorization(kp.secret, to_kp.public, amount, nonce, expiry)
check(len(wire) == WIRE_LEN, f"sign_authorization -> {WIRE_LEN}-byte wire blob")
check(wire[0:32] == kp.public, "wire `from` == signer public key (consent bound to signer)")
check(wire[SIG_END:WIRE_LEN] == kp.public, "wire carries payer pubkey for directory-free verify")


# 2) Wire <-> base64url QR string round-trips exactly ------------------------------------------
qr = d.encode_qr(wire)
check(isinstance(qr, str) and len(qr) == 256, "encode_qr -> 256-char base64url (no pad)")
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
    d.sign_authorization(b"\x00" * 31, to_kp.public, amount, nonce, expiry)
    raise AssertionError("FAILED: short secret should have raised")
except d.DpayError.BadSecretLength:
    check(True, "short secret -> DpayError.BadSecretLength")

try:
    d.decode_qr("!!!not-base64!!!")
    raise AssertionError("FAILED: bad base64 should have raised")
except d.DpayError.BadBase64:
    check(True, "malformed QR -> DpayError.BadBase64")

# A wire whose `from` disagrees with `from_pub` is rejected at parse time (not silently verified).
mismatch = bytearray(wire)
mismatch[160] ^= 0x01                 # perturb from_pub only
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
req_bytes = d.nfc_request_bytes(to_kp.public, amount, req_nonce, expiry)
check(len(req_bytes) == 64, "nfc_request_bytes -> 64-byte request wire")
nfc_wire = d.sign_authorization(kp.secret, to_kp.public, amount, req_nonce, expiry)


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
            seen = d.nfc_decode_request(card.request())   # payer reviews "Pay $X to <merchant>"
            assert seen.amount == amount and seen.nonce == req_nonce
            (card.provide_wire(nfc_wire) if approve else card.decline())
        step = reader.handle_response(resp)
        if step == d.NfcStep.DONE:
            return reader.wire()
        if step == d.NfcStep.DECLINED:
            return None
    raise AssertionError("NFC exchange did not terminate")


# Production single-frame path and the heavily-fragmented (1 byte/frame) path both deliver the
# exact signed wire — and it still verifies under the same crypto the canister enforces.
for mc in (MAX_CHUNK, 1):
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

step = reader.handle_response(card.process(reader.next_command()))   # pull the wire (1 frame)
check(card.phase() == d.NfcPhase.COMPLETE and card.is_complete(), "card -> Complete after last frame")
check(step == d.NfcStep.DONE and reader.phase() == d.NfcPhase.COMPLETE, "reader -> Complete / Done")


print(f"\nALL {passed} FFI CHECKS PASSED — Python called the real dpay-core across UniFFI.")
sys.exit(0)
