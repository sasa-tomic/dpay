#!/usr/bin/env python3
"""Language-level roundtrip test for the dpay UniFFI binding.

Every call below crosses the FFI into the *same* compiled `dpay-core` that the canister, relay,
and sim link — so a green run here is direct evidence that the app's languages sign and verify
with the real ledger code, not a re-implementation. Run via `verify.sh` (sets PYTHONPATH).
"""
import sys

import dpay_ffi as d

# ---------------------------------------------------------------------------------------------
# IC user-principal rail (2026-08-19 cutover): the facade wire (292 B SignedAuthorization) left the
# value path. The phone now signs full IC /call envelopes (byte-identical to ic-agent) via the
# `icp_*` surface, and the NFC transport carries the ~390 B envelope (2 frames @ 240 B chunk).
# The 132 B merchant request wire is FROZEN and unchanged.
CKBTC_LEDGER = "mxzaz-hqaaa-aaaar-qaada-cai"   # real ckBTC ledger principal (CRC-valid)

passed = 0
def check(cond, label):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label}")
    passed += 1
    print(f"  ok  {label}")


# 1) Device keypair + IC principal identity -----------------------------------------------------
kp = d.generate_keypair()
check(len(kp.secret) == 32, "generate_keypair -> 32-byte secret seed")
check(len(kp.public) == 32, "generate_keypair -> 32-byte public key")

to_kp = d.generate_keypair()          # the merchant / payee identity
amount = 1499                          # $14.99 in minor units
expiry = 2_000_000_000                 # far-future unix seconds
TO_NAME, MEMO = "Bob", "coffee"        # carried by the 132 B request wire

# The self principal (derived from the seed) must equal the principal derived from the raw pubkey —
# two routes to Account{owner: self_authenticating(pub)} on every external ledger.
self_p = d.icp_self_principal(kp.secret)
from_pub_p = d.icp_principal_from_pubkey(kp.public)
check(isinstance(self_p, str) and len(self_p) == 63, "icp_self_principal -> 63-char principal text")
check(self_p == from_pub_p, "icp_self_principal == icp_principal_from_pubkey (same account owner)")
payee_p = d.icp_principal_from_pubkey(to_kp.public)
check(payee_p != self_p, "payee principal differs from payer principal")

# Ingress expiry string math: ns timestamp + ahead_s seconds (decimal strings, exact u64).
check(d.icp_ingress_expiry("1000000000000000000", 300) == "1000000300000000000",
      "icp_ingress_expiry(1e18 ns, 300 s) == 1000000300000000000")


# 2) IC envelope round-trip: transfer arg -> signed /call envelope -> request_id ----------------
nonce = bytes(range(16))                                # the merchant's request_id -> ledger nonce
nonce_hex = nonce.hex()                                  # memo = reconciliation key (request nonce)
arg = d.icp_transfer_arg(payee_p, "", "", str(amount), "", nonce_hex)
check(len(arg) > 100, "icp_transfer_arg -> DIDL bytes")
signed = d.icp_sign_update(kp.secret, CKBTC_LEDGER, "icrc1_transfer", arg,
                           "1800000000000000000")
env, rid = signed.envelope, signed.request_id
check(len(env) > 350, f"icp_sign_update -> {len(env)}-byte envelope (mainnet-measured 388-398 B)")
check(len(rid) == 32, "request_id is 32 bytes (read_state poll key)")
check(d.icp_envelope_request_id(env) == rid,
      "icp_envelope_request_id(envelope) == signed.request_id  (merchant-side rid derivation)")


# 3) Reply decoding over live-captured golden bytes ---------------------------------------------
# G_TR_OK: real ledger TransferResult Ok(block_index=2) captured on mainnet (goldens.rs).
G_TR_OK = bytes.fromhex(
    "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd"
    "0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018b"
    "bdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000002"
)
tr = d.icp_decode_transfer_result(G_TR_OK)
check(tr.ok is True and tr.block_index == "2", "icp_decode_transfer_result(golden Ok) -> block_index 2")
# G_TR_BADFEE tail: Err variant BadFee{expected_fee: 10000}.
G_TR_BADFEE = bytes.fromhex(
    "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd"
    "0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018b"
    "bdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000104904e"
)
tr2 = d.icp_decode_transfer_result(G_TR_BADFEE)
check(tr2.ok is False and tr2.err_variant == "BadFee", "icp_decode_transfer_result(BadFee) -> err_variant")
# DUSD icrc1_decimals reply (nat8 2), live-captured on mainnet.
check(d.icp_decode_int(bytes.fromhex("4449444c00017b02")) == "2",
      "icp_decode_int(nat8 golden) == '2'  (DUSD decimals)")


# 4) Cross-language error mapping: malformed inputs raise typed DpayError -----------------------
try:
    d.keypair_from_secret(b"\x00" * 31)
    raise AssertionError("FAILED: short secret should have raised")
except d.DpayError.BadSecretLength:
    check(True, "short secret -> DpayError.BadSecretLength")
try:
    d.icp_balance_of_arg("not-a-principal", "")
    raise AssertionError("FAILED: bad principal should have raised")
except d.DpayError.BadInput:
    check(True, "invalid principal text -> DpayError.BadInput")

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
    d.decode_request("!!!not-base64!!!")
    raise AssertionError("FAILED: bad base64 should have raised")
except d.DpayError.BadBase64:
    check(True, "malformed request QR -> DpayError.BadBase64")


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

# A dropped RF link is explicit at the FFI boundary: even midway through request push, the next
# command is the original SELECT rather than a stale C2/C4/C6 command.
reset_card = d.FfiCardSession(MAX_CHUNK)
reset_reader = d.FfiReaderConductor(req_bytes, MAX_CHUNK)
first_select = reset_reader.next_command()
reset_reader.handle_response(reset_card.process(first_select))
check(reset_reader.next_command()[1] == 0xC2, "reader advances to request push before reset")
reset_reader.reset_link()
check(reset_reader.next_command() == first_select, "reader.reset_link -> byte-identical SELECT first")

# The payer serves a DPN2 bundle containing the signed /call update and its signed /read_state poll.
env_arg = d.icp_transfer_arg(payee_p, "", "", str(amount), "", req_nonce.hex())
env_signed = d.icp_sign_update(kp.secret, CKBTC_LEDGER, "icrc1_transfer", env_arg,
                               "1800000000000000000")
nfc_env = env_signed.envelope
read_state_env = d.icp_sign_read_state(kp.secret, [env_signed.request_id], True,
                                       "1800000000000000000")
nfc_bundle = d.nfc_bundle_bytes(nfc_env, read_state_env)
decoded_bundle = d.nfc_decode_bundle(nfc_bundle)
check(decoded_bundle.request_id == env_signed.request_id,
      "nfc_bundle_bytes derives the update envelope request_id")
check(decoded_bundle.update == nfc_env and decoded_bundle.read_state == read_state_env,
      "nfc_decode_bundle returns both envelopes byte-identically")
check(nfc_bundle[:4] == b"DPN2", "NFC bundle starts with DPN2 magic")


def run_nfc(max_chunk, approve=True, result_status=d.NfcResultStatus.SETTLED):
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
            (card.provide_wire(nfc_bundle) if approve else card.decline())
        step = reader.handle_response(resp)
        if step == d.NfcStep.DONE:
            check(reader.wire() == nfc_bundle, "reader.wire returns the byte-identical DPN2 bundle")
            result = d.nfc_result_bytes(to_kp.secret, result_status, req_nonce,
                                        decoded_bundle.request_id)
            check(len(result) == 114, "nfc_result_bytes -> fixed 114-byte signed result")
            reader.provide_result(result)
        if step == d.NfcStep.CONFIRMED:
            received = card.result()
            assert received is not None
            assert received.status == result_status
            assert received.nonce == req_nonce
            assert received.request_id == decoded_bundle.request_id
            assert card.wire_delivered() and card.is_complete()
            return reader.wire()
        if step == d.NfcStep.DECLINED:
            return None
    raise AssertionError("NFC exchange did not terminate")


# Production and the most-aggressive still-valid fragmentation both deliver the exact bundle and
# complete the merchant-result return. The u8 frame sequence caps every payload at 256 frames.
#
# chunk=1 on the 292-byte wire is therefore an unrepresentable configuration: the transport must
# refuse it with a typed error (NfcProtocol = Frame(TooManyFrames)) rather than silently truncate.
# Pin that boundary here so a future wire resize or seq widening surfaces explicitly (mirrors the
# core Rust `signed_wire_survives_nfc_and_verifies` mc=1 rejection assertion).
try:
    run_nfc(1)
    raise AssertionError("FAILED: chunk=1 must be unrepresentable (bundle > MAX_FRAMES=256)")
except d.DpayError.NfcProtocol:
    check(True, "chunk=1 on DPN2 bundle -> DpayError.NfcProtocol (u8 seq ceiling)")

MIN_CHUNK = (len(nfc_bundle) + 255) // 256
for mc in (MAX_CHUNK, MIN_CHUNK):
    got = run_nfc(mc)
    check(got == nfc_bundle, f"NFC exchange delivers byte-identical bundle + result (chunk={mc})")

# All three authenticated result statuses survive the FFI lifecycle and decode on the card.
for status in (d.NfcResultStatus.REJECTED, d.NfcResultStatus.UNKNOWN):
    check(run_nfc(MAX_CHUNK, result_status=status) == nfc_bundle,
          f"NFC result status {status} reaches Confirmed")

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
    d.FfiCardSession(MAX_CHUNK).provide_wire(nfc_bundle)
    raise AssertionError("FAILED: provide_wire before a request should have raised")
except d.DpayError.NfcWrongState:
    check(True, "provide_wire with no request -> DpayError.NfcWrongState")


# 7) NFC lifecycle phase: the live status the UI renders, read straight from the core machine -----
# The app maps these to transport progress. Settling means the immutable signed envelope has left
# NFC; ledger submission and polling continue independently on both phones.
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

card.provide_wire(nfc_bundle)                                        # payer approves (serves the bundle)
check(card.phase() == d.NfcPhase.EXCHANGING, "card -> Exchanging while serving the wire")

# The ~390-byte envelope spans 2 frames at MAX_CHUNK=240; pull frames until the reader reassembles
# the whole payload. Each frame but the last is Continue; the last is Done.
step = None
for _ in range(100):
    cmd = reader.next_command()
    assert cmd is not None, "reader stalled before pulling the full wire"
    step = reader.handle_response(card.process(cmd))
    if step == d.NfcStep.DONE:
        break
    check(step == d.NfcStep.CONTINUE, "wire-pull frames are Continue until the last (Done)")
check(step == d.NfcStep.DONE, "reader -> Done (has the envelope)")
check(card.wire_delivered(), "card records the bundle was fully served")
check(card.is_complete() is False, "card is not complete before merchant result")
check(card.phase() == d.NfcPhase.SETTLING, "card -> Settling (awaiting merchant result)")
check(reader.phase() == d.NfcPhase.SETTLING, "reader -> Settling (has immutable bundle)")
check(reader.next_command() is None, "reader pauses commands while settling online")

settled_result = d.nfc_result_bytes(to_kp.secret, d.NfcResultStatus.SETTLED,
                                    req_nonce, decoded_bundle.request_id)
reader.provide_result(settled_result)
check(reader.phase() == d.NfcPhase.LINKING, "reader re-links before returning result")
check(reader.handle_response(card.process(reader.next_command())) == d.NfcStep.CONTINUE,
      "result return SELECT sees AwaitingResult")
check(reader.handle_response(card.process(reader.next_command())) == d.NfcStep.CONFIRMED,
      "PUT_RESULT -> Confirmed")
check(card.is_complete() and card.phase() == d.NfcPhase.COMPLETE,
      "card -> Complete only after verified result")
check(reader.phase() == d.NfcPhase.COMPLETE, "reader -> Complete after result acknowledgement")
card_result = card.result()
check(card_result.status == d.NfcResultStatus.SETTLED and card_result.nonce == req_nonce,
      "card.result returns verified status and nonce")
check(card_result.request_id == decoded_bundle.request_id,
      "card.result returns the bundle request_id")

# A structurally valid result signed by the wrong key is rejected by the card and never stored.
bad_card = d.FfiCardSession(MAX_CHUNK)
bad_reader = d.FfiReaderConductor(req_bytes, MAX_CHUNK)
bad_reader.handle_response(bad_card.process(bad_reader.next_command()))
bad_resp = bad_card.process(bad_reader.next_command())
bad_card.provide_wire(nfc_bundle)
bad_reader.handle_response(bad_resp)
while True:
    bad_step = bad_reader.handle_response(bad_card.process(bad_reader.next_command()))
    if bad_step == d.NfcStep.DONE:
        break
bad_result = d.nfc_result_bytes(kp.secret, d.NfcResultStatus.SETTLED,
                                req_nonce, decoded_bundle.request_id)
bad_reader.provide_result(bad_result)
bad_reader.handle_response(bad_card.process(bad_reader.next_command()))
try:
    bad_reader.handle_response(bad_card.process(bad_reader.next_command()))
    raise AssertionError("FAILED: wrong merchant signature should have raised")
except d.DpayError.NfcProtocol:
    check(bad_card.is_complete() is False and bad_card.result() is None,
          "wrong merchant signature -> NfcProtocol and no card result")


# 8) Exact decimal <-> u64 amount parser (MC1 unit 1) ------------------------------------------
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
expect_amount_err(".", 2, "not_a_number", "bare dot (no whole, no fraction)")
expect_amount_err("-1", 2, "negative", "negative (-1)")
expect_amount_err("-abc", 2, "negative", "leading minus (regardless of shape)")
expect_amount_err("1.5", 0, "too_many_decimals", "1 fractional digit > decimals=0")
expect_amount_err("0.1234567890123456789", 18, "too_many_decimals", "19 frac digits at decimals=18")
expect_amount_err("99999999999999999999999999999", 0, "overflow", "29 nines > u64::MAX")
expect_amount_err("1", 19, "overflow", "decimals > MAX_DECIMALS (18)")

# Calculator-style shapes are ACCEPTED since 19c6e8f: leading dot `.5` → 0.5, trailing dot `5.` → 5.
check(d.parse_amount(".5", 2) == 50, "parse_amount('.5', 2) == 50 (calculator-style leading dot)")
check(d.parse_amount("5.", 2) == 500, "parse_amount('5.', 2) == 500 (calculator-style trailing dot)")


# 9) OpenCryptoPay till: the merchant's ring-up proof ------------------------------------------
# `till_open_signature` is what stops `POST /api/v1/till` from opening a charge for a key the caller
# does not hold (a probe did exactly that with `deadbeef…deadbeef` on 2026-09-03). The signature
# covers the SEED's own public key — the app never supplies one — plus the price, nonce, timestamp
# and the CLAIMED merchant name. Pinned here against the committed golden emitted from the same core
# by `just wire-layout`, so a green run proves the phone signs what the relay verifies.
import json, pathlib
_golden = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "dfx" / "till_open_signing.json").read_text()
)
_g = _golden["golden"]
_sig = d.till_open_signature(
    bytes.fromhex(_g["secret_hex"]), _g["cents"], bytes.fromhex(_g["nonce_hex"]),
    _g["issued_at"], _g["merchant_name"],
)
check(_sig.hex() == _g["sig_hex"], "till_open_signature reproduces dfx/till_open_signing.json sig_hex")
check(d.keypair_from_secret(bytes.fromhex(_g["secret_hex"])).public.hex() == _g["merchant_pubkey_hex"],
      "the signature covers the seed's OWN public key (never a caller-supplied one)")
# Ed25519 is deterministic, so a differing signature proves the field entered the signed bytes.
check(d.till_open_signature(bytes.fromhex(_g["secret_hex"]), _g["cents"] + 1,
                            bytes.fromhex(_g["nonce_hex"]), _g["issued_at"],
                            _g["merchant_name"]).hex() != _g["sig_hex"],
      "till_open_signature binds the price")
check(d.till_open_signature(bytes.fromhex(_g["secret_hex"]), _g["cents"],
                            bytes.fromhex(_g["nonce_hex"]), _g["issued_at"],
                            "Migros").hex() != _g["sig_hex"],
      "till_open_signature binds the CLAIMED merchant name")
# Malformed inputs are typed errors, never a silently wrong signature.
try:
    d.till_open_signature(b"\x00" * 31, 1, bytes(16), 1, "")
    raise AssertionError("FAILED: short seed should have raised")
except d.DpayError.BadSecretLength:
    check(True, "till_open_signature(short seed) -> DpayError.BadSecretLength")
try:
    d.till_open_signature(b"\x00" * 32, 1, bytes(15), 1, "")
    raise AssertionError("FAILED: short nonce should have raised")
except d.DpayError.BadNonceLength:
    check(True, "till_open_signature(short nonce) -> DpayError.BadNonceLength")


# 10) ICPSwap conversion surface (delegated-conversion PoC, spec 2026-09-07) -------------------
# The two-call flow the app drives: icrc2_approve naming the pool as spender, then the
# one-call depositFromAndSwap. Both args cross through the SAME compiled core the phone
# signs with; the golden pins the DIDL bytes against the production @dfinity/candid encoder.
POOL = "65mrh-fqaaa-aaaar-qapoa-cai"  # the ICPSwap ICP/VCHF pool (spec 2026-09-07)
G_SWAP = bytes.fromhex(
    "4449444c016c05a8bb95a7037dddefb5ca0671a5d0b4f8087ed8ddd1d70971b1b4bc800a7d0100"
    "904e09313032303030303030010731383030303030904e"
)
swap_arg = d.icp_deposit_and_swap_arg("102000000", "1800000", "10000", "10000", True)
check(swap_arg == G_SWAP, "icp_deposit_and_swap_arg -> byte-exact golden (float-op shape)")
# The approval the app signs first: exact swap amount + approve fee, expected_allowance
# present, finite expiry (spec §3 shape) — then the swap call signs against the pool.
approve_arg = d.icp_approve_arg(POOL, "", "", "102010000", "102010000",
                                "1810000000000000000", "", "10000")
signed_approve = d.icp_sign_update(kp.secret, "ryjl3-tyaaa-aaaaa-aaaba-cai",
                                   "icrc2_approve", approve_arg, "1800000000000000000")
signed_swap = d.icp_sign_update(kp.secret, POOL, "depositFromAndSwap", swap_arg,
                                "1800000000000000000")
check(len(signed_approve.envelope) > 350 and len(signed_swap.envelope) > 350,
      "approve + depositFromAndSwap both produce signable envelopes")
# The min-out math lives in the core, never TS: exact floor, saturating at full slippage.
check(d.icp_swap_min_out("2000000", 300) == "1940000", "icp_swap_min_out(2e6, 300bps) == 1940000")
check(d.icp_swap_min_out("2000000", 10000) == "0", "icp_swap_min_out(100% bps) == 0")
check(d.icp_swap_min_out(str(2**128 - 1), 100) == "336879543251729078828740861357450529340",
      "icp_swap_min_out(u128::MAX, 100bps) == exact floor (no overflow-to-0)")
try:
    d.icp_deposit_and_swap_arg("1.5", "0", "0", "0", False)
    raise AssertionError("FAILED: non-integer amountIn should have raised")
except d.DpayError.BadInput:
    check(True, "non-integer amount -> DpayError.BadInput")
try:
    d.icp_swap_min_out("nope", 100)
    raise AssertionError("FAILED: bad quote should have raised")
except d.DpayError.BadInput:
    check(True, "non-numeric quote -> DpayError.BadInput")


print(f"\nALL {passed} FFI CHECKS PASSED — Python called the real dpay-core across UniFFI.")
sys.exit(0)
