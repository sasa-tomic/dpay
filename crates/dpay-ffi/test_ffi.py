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


print(f"\nALL {passed} FFI CHECKS PASSED — Python called the real dpay-core across UniFFI.")
sys.exit(0)
