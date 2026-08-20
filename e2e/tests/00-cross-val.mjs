// Cross-validation test — proves the JS byte builders the e2e harness uses are byte-identical to
// the Rust core, so every local pay flow that uses them settles on the real fake-IC /api/v2 gateway
// (which verifies envelopes with the same rules as the replica).
//
// This test is the FIRST thing that runs in the suite (`00-` prefix). It does NOT need a browser or
// a relay — it loads the wire_layout.json golden bytes and the harness's pure builders
// (e2e/harness/wire.mjs), then asserts:
//   1. Re-signing the golden Authorization produces the golden sig (byte-exact).
//   2. Re-assembling the wire produces the golden wire (byte-exact).
//   3. The golden sig verifies under the golden key (ed25519 parity with dalek verify_strict).
//   4. The golden QR round-trips: build → decode recovers the original fields.
//   5. The TS BigInt amount parser matches the Rust parser goldens (incl. > 2^53).
//   6. The icp builders (transfer arg / balance_of arg / call request_id) match the dpay-icp
//      production-encoder goldens (the IC rail the whole suite now settles over).
//
// Retired surfaces (withdraw signing buffer, canister-signed receipt claim) were dropped at the
// IC-rail cutover (user-principal envelopes, rail proofs) — their layout JSON survives ONLY as a
// static-layout guard in scripts/check-wasm-core.mjs (w_layout_json pins the file byte-for-byte),
// so no golden here needs to re-pin them.
//
// If this test fails, do NOT proceed to the flow tests — the local pay path is broken. That is the
// "no silent errors" guarantee: a stale wire_layout.json or a bug in the builders surfaces HERE,
// not as a mysterious 422 from the gateway two flows later.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash as cryptoCreateHash } from 'node:crypto';
import { assert, assertEq } from '../harness/lib.mjs';
import { icpTransferArgBytes, icpBalanceOfArgBytes, uleb } from '../harness/wire.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIRE_LAYOUT = join(__dirname, '..', '..', 'dfx', 'wire_layout.json');

// Import the shim's internals. Node's static analyzer needs the explicit extension; the .ts is
// resolved via a tiny on-disk build step or (here) by reading the layout + reimplementing the byte
// math directly. To keep the test zero-build, we replicate ONLY what's needed: the builders operate
// purely on the layout JSON's offsets/lengths (the same ones the shim uses). If the shim and this
// test disagree on a layout constant, both read the same JSON so the divergence is caught here.
const layout = JSON.parse(readFileSync(WIRE_LAYOUT, 'utf8'));

// --- replicate the shim's pure byte builders (mirror e2e/web/dpay-core.ts exactly) ------------
// MC1 units 2-4: u64 read/write via BigInt (exact for the full u64 range; never `Math.floor`/
// `& 0xff` which is lossy above 2^53). `readU64Le` returns an UNSIGNED decimal STRING. A small
// JSON-number golden (2500) round-trips byte-identically to the old lossy path.
function hex(h) { return Buffer.from(h, 'hex'); }
function bytesToHex(b) { return Buffer.from(b).toString('hex'); }

function putU64Le(buf, offset, val) {
  let v = BigInt(val);
  for (let i = 0; i < 8; i++) { buf[offset + i] = Number(v & 0xffn); v >>= 8n; }
}
function readU64Le(buf, offset) {
  let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[offset + i]); return v.toString();
}
function putU32Le(buf, offset, val) {
  let v = Math.floor(val);
  for (let i = 0; i < 4; i++) { buf[offset + i] = v & 0xff; v = Math.floor(v / 0x100); }
}
function readU32Le(buf, offset) {
  let v = 0; for (let i = 3; i >= 0; i--) v = v * 0x100 + buf[offset + i]; return v;
}

// Display name + memo codec (NUL-padded UTF-8, truncate to 32 bytes) — mirrors `padName32`/`trimName32`.
const NAME_LEN = 32;
function padName32(s) {
  const utf8 = Buffer.from(s, 'utf8');
  const buf = Buffer.alloc(NAME_LEN);
  utf8.subarray(0, NAME_LEN).copy(buf);
  return buf;
}
function trimName32(bytes) {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return Buffer.from(bytes.subarray(0, end)).toString('utf8');
}

function buildSigningBytes(fromHex, toHex, amount, nonceHex, expiry, currency, fromName = '', toName = '', memo = '') {
  const from = hex(fromHex), to = hex(toHex), nonce = hex(nonceHex);
  const buf = Buffer.alloc(layout.signing_len);
  buf.set(from, layout.fields.from.offset);
  buf.set(to, layout.fields.to.offset);
  putU64Le(buf, layout.fields.amount.offset, amount);
  buf.set(nonce, layout.fields.nonce.offset);
  putU64Le(buf, layout.fields.expiry.offset, expiry);
  putU32Le(buf, layout.fields.currency.offset, currency);
  buf.set(padName32(fromName), layout.fields.from_name.offset);
  buf.set(padName32(toName), layout.fields.to_name.offset);
  buf.set(padName32(memo), layout.fields.memo.offset);
  return new Uint8Array(buf);
}
function buildWire(signing, sig, fromPub) {
  const wire = new Uint8Array(layout.wire_len);
  wire.set(signing, layout.wire_fields.signing.offset);
  wire.set(sig, layout.wire_fields.sig.offset);
  wire.set(fromPub, layout.wire_fields.from_pub.offset);
  return wire;
}

// The cross-validation needs an Ed25519 impl that's binary-compatible with dalek. @noble/ed25519 is
// RFC 8032 strict, same as dalek's default verifier. The browser shim imports the same package; this
// test uses it directly (Node-side) to prove the bytes match.
import * as ed from '@noble/ed25519';

const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64urlEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_URL[b0 >> 2];
    out += B64_URL[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64_URL[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64_URL[b2 & 0x3f];
  }
  return out;
}
function b64urlDecode(s) {
  const cleaned = s.replace(/=+$/g, '');
  const rev = {}; for (let i = 0; i < B64_URL.length; i++) rev[B64_URL[i]] = i;
  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 4) {
    const c0 = rev[cleaned[i]], c1 = rev[cleaned[i + 1]];
    const c2 = i + 2 < cleaned.length ? rev[cleaned[i + 2]] : undefined;
    const c3 = i + 3 < cleaned.length ? rev[cleaned[i + 3]] : undefined;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 !== undefined) bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 !== undefined) bytes.push(((c2 & 0x03) << 6) | c3);
  }
  return new Uint8Array(bytes);
}

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '00',
  name: 'cross-val',
  journey: 'wire',
  covers: ['wire-format', 'ed25519-parity', 'golden-bytes', 'icp-builders'],
  verifies: 'JS byte builders (pay wire, request QR, amount parser, icp transfer/balance/rid) are byte-exact vs the Rust core goldens — no browser, ~0.1s.',
  timeoutMs: 5000,
};

export async function run() {
  const g = layout.golden;
  console.log('[00-cross-val] golden secret:', g.secret_hex.slice(0, 16) + '…');
  console.log('[00-cross-val] golden public:', g.public_hex);

  // Layout sanity: the new wire-format v2 (N6/H3) constants. Catches a stale wire_layout.json.
  assertEq(layout.signing_len, 196, 'signing_len (wire-format v2: +from_name/to_name/memo)');
  assertEq(layout.wire_len, 292, 'wire_len (196 signing + 64 sig + 32 from_pub)');
  assertEq(layout.request_len, 132, 'request_len (wire-format v2: +to_name/memo)');

  // --- (1) re-sign the golden Authorization with @noble/ed25519 --------------------------------
  //   The golden carries from_name="Alice", to_name="Bob", memo="dinner" (NUL-padded in the JSON as
  //   from_name_hex/to_name_hex/memo_hex). They MUST appear in the 196-byte signing buffer at offsets
  //   100/132/164 — bound by the signature (a tamper breaks verify).
  const signing = buildSigningBytes(g.public_hex, g.to_hex, g.amount, g.nonce_hex, g.expiry, g.currency, 'Alice', 'Bob', 'dinner');
  assertEq(bytesToHex(signing), g.signing_hex, 'signing buffer (golden layout vs shim builder)');

  // The three 32-byte name/memo fields are present in the signed bytes at their offsets.
  assertEq(bytesToHex(signing.slice(layout.fields.from_name.offset, layout.fields.from_name.offset + layout.fields.from_name.len)),
    g.from_name_hex, 'signing.from_name == golden ("Alice" NUL-padded)');
  assertEq(bytesToHex(signing.slice(layout.fields.to_name.offset, layout.fields.to_name.offset + layout.fields.to_name.len)),
    g.to_name_hex, 'signing.to_name == golden ("Bob" NUL-padded)');
  assertEq(bytesToHex(signing.slice(layout.fields.memo.offset, layout.fields.memo.offset + layout.fields.memo.len)),
    g.memo_hex, 'signing.memo == golden ("dinner" NUL-padded)');
  // The names round-trip through NUL-trim back to the readable strings.
  assertEq(trimName32(signing.slice(layout.fields.from_name.offset, layout.fields.from_name.offset + layout.fields.from_name.len)), 'Alice', 'trimName32(from_name) == "Alice"');
  assertEq(trimName32(signing.slice(layout.fields.to_name.offset, layout.fields.to_name.offset + layout.fields.to_name.len)), 'Bob', 'trimName32(to_name) == "Bob"');
  assertEq(trimName32(signing.slice(layout.fields.memo.offset, layout.fields.memo.offset + layout.fields.memo.len)), 'dinner', 'trimName32(memo) == "dinner"');
  console.log('[00-cross-val] ✓ from_name/to_name/memo present in signed bytes + round-trip');

  const sig = await ed.signAsync(signing, hex(g.secret_hex));
  const sigHex = bytesToHex(sig);
  if (sigHex !== g.sig_hex) {
    throw new Error(
      `[00-cross-val] SIG MISMATCH — the JS shim's Ed25519 sig differs from the Rust core's.\n` +
      `  rust : ${g.sig_hex}\n` +
      `  js   : ${sigHex}\n` +
      `  This means local pay flows will NOT settle on the FakeLedger (signature verify fails).`
    );
  }
  console.log('[00-cross-val] ✓ sig matches Rust core byte-for-byte');

  // --- (2) re-assemble the wire and compare -------------------------------------------------
  const wire = buildWire(signing, sig, hex(g.public_hex));
  assertEq(bytesToHex(wire), g.wire_hex, 'wire (signing|sig|from_pub)');

  // --- (3) verifyWire: the JS verifier accepts the golden wire (mirrors FakeLedger.sa.verify) -
  const ok = await ed.verifyAsync(
    wire.slice(layout.wire_fields.sig.offset, layout.wire_fields.sig.offset + layout.wire_fields.sig.len),
    wire.slice(layout.wire_fields.signing.offset, layout.wire_fields.signing.offset + layout.wire_fields.signing.len),
    wire.slice(layout.wire_fields.from_pub.offset, layout.wire_fields.from_pub.offset + layout.wire_fields.from_pub.len),
  );
  assert(ok, 'verifyAsync(golden sig, signing, from_pub) must be true (mirrors FakeLedger)');

  // --- (4) the from_pub carried in the wire equals the from field in the signing buffer ------
  //   (dpay_core::SignedAuthorization::from_wire rejects a mismatch as PubkeyMismatch)
  const fromInSigning = bytesToHex(signing.slice(layout.fields.from.offset, layout.fields.from.offset + layout.fields.from.len));
  const fromPub = bytesToHex(wire.slice(layout.wire_fields.from_pub.offset, layout.wire_fields.from_pub.offset + layout.wire_fields.from_pub.len));
  assertEq(fromInSigning, fromPub, 'signing.from == wire.from_pub (PubkeyMismatch guard)');
  assertEq(fromPub, g.public_hex, 'wire.from_pub == golden.public_hex');

  // --- (5) request QR round-trip: encodeRequest → decodeRequest recovers the original fields --
  //   (mirrors PaymentRequest::encode / decode; the merchant QR is now PLAIN base64url — the
  //   to_name lives in the 132-byte request bytes; the old `|name` suffix is gone).
  const reqBytes = Buffer.alloc(layout.request_len);
  reqBytes.set(hex(g.to_hex), layout.request_fields.to.offset);
  putU64Le(reqBytes, layout.request_fields.amount.offset, g.amount);
  reqBytes.set(hex(g.nonce_hex), layout.request_fields.nonce.offset);
  putU64Le(reqBytes, layout.request_fields.expiry.offset, g.expiry);
  putU32Le(reqBytes, layout.request_fields.currency.offset, g.currency);
  // The golden request carries to_name="Bob" + memo="coffee" (request_to_name_hex / request_memo_hex).
  reqBytes.set(padName32('Bob'), layout.request_fields.to_name.offset);
  reqBytes.set(padName32('coffee'), layout.request_fields.memo.offset);
  const reqB64 = b64urlEncode(new Uint8Array(reqBytes));
  // Assert the rebuilt request bytes equal the golden request_hex (proves to_name/memo offsets).
  assertEq(bytesToHex(new Uint8Array(reqBytes)), g.request_hex, 'request bytes (golden layout vs builder)');
  // The QR is now plain base64url — NO `|name` suffix anymore.
  assert(!reqB64.includes('|'), 'request QR must be plain base64url (no |name suffix)');

  const decoded = b64urlDecode(reqB64);
  assertEq(decoded.length, layout.request_len, 'decoded request length (132 bytes)');
  const dTo = bytesToHex(decoded.slice(layout.request_fields.to.offset, layout.request_fields.to.offset + layout.request_fields.to.len));
  const dAmount = readU64Le(decoded, layout.request_fields.amount.offset);
  const dNonce = bytesToHex(decoded.slice(layout.request_fields.nonce.offset, layout.request_fields.nonce.offset + layout.request_fields.nonce.len));
  const dExpiry = readU64Le(decoded, layout.request_fields.expiry.offset);
  const dCurrency = readU32Le(decoded, layout.request_fields.currency.offset);
  const dToName = trimName32(decoded.slice(layout.request_fields.to_name.offset, layout.request_fields.to_name.offset + layout.request_fields.to_name.len));
  const dMemo = trimName32(decoded.slice(layout.request_fields.memo.offset, layout.request_fields.memo.offset + layout.request_fields.memo.len));
  assertEq(dTo, g.to_hex, 'decoded request.to');
  assertEq(dAmount, String(g.amount), 'decoded request.amount');
  assertEq(dNonce, g.nonce_hex, 'decoded request.nonce');
  assertEq(dExpiry, String(g.expiry), 'decoded request.expiry');
  assertEq(dCurrency, g.currency, 'decoded request.currency');
  assertEq(dToName, 'Bob', 'decoded request.to_name == "Bob" (now in the bytes, not a suffix)');
  assertEq(dMemo, 'coffee', 'decoded request.memo == "coffee"');
  console.log('[00-cross-val] ✓ request QR round-trips byte-exact (to_name + memo in bytes)');

  // --- (6) icp builders byte-exactness: the JS harness builders (e2e/harness/wire.mjs) must
  //   produce the SAME bytes as the dpay-icp production encoder (ic-transport-types + candid
  //   0.10.22 stack). These are the bytes the whole suite now settles over — the fake-IC /api/v2
  //   gateway keys envelopes by request_id and decodes args with the real candid rules, so any
  //   divergence here 4xxes every rail flow. Goldens TRIPLE-pinned: dpay-icp goldens.rs (the
  //   source of truth, generated from the production encoder) + this cross-val + the wasm core
  //   census (scripts/check-wasm-core.mjs pins the w_icp_* export surface that compiles the same
  //   Rust into the web bundle).
  const ICP = {
    // goldens.rs EXPIRY: 1_685_570_400_000_000_000 (ns)
    expiry: 1_685_570_400_000_000_000n,
    // goldens.rs selfauth(): 3d9bdaa3…0202 — also the ed25519-derived sender of sk() below.
    selfauthHex: '3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d202',
    // goldens.rs to_principal(): b56bf994…3c02 (k2t6j-2nvnp-…-6ae)
    toPrincipalHex: 'b56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c02',
    // goldens.rs G_TRANSFER_APP_SHAPE — app-shape transfer arg (default account, fee + 8B memo,
    // no created_at_time): the ONLY shape icpTransferArgBytes can emit.
    transferAppShape:
      '4449444c066c06fbca0101c6fcb60204ba89e5c20402a2de94eb060282f3f391' +
      '0c05d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e780100' +
      '011db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c0200' +
      '01904e0108aaaaaaaaaaaaaaaa0000959aef3a',
    // goldens.rs G_BALANCE_OF_DEFAULT — balance_of arg over the DEFAULT account (all-zero
    // subaccount canonicalized to none).
    balanceOfDefault:
      '4449444c036c02b3b0dac30368ad86ca8305016e026d7b0100011d3d9bdaa34fe' +
      '81df16699403f3e17d6030488fc8c9e37ab61036482d20200',
    // goldens.rs G_RID_NO_NONCE — request_id of the six-field no-nonce call over the app-shape
    // transfer arg (pins the JS requestId leaf-hash/sort/concat math).
    ridNoNonce: 'f1cd3d27b03b1505edb95e4e8f87e7c7491b80d1bc5d04f181c518fb7a1b74e7',
  };

  // icpTransferArgBytes(to, amount, {fee, memoHex}) == G_TRANSFER_APP_SHAPE.
  const transferArg = icpTransferArgBytes(hex(ICP.toPrincipalHex), 123_456_789n, { fee: 10_000n, memoHex: 'aa'.repeat(8) });
  assertEq(bytesToHex(transferArg), ICP.transferAppShape, 'icp transfer arg (app shape) == dpay-icp golden');
  // icpBalanceOfArgBytes(owner) == G_BALANCE_OF_DEFAULT.
  const balanceArg = icpBalanceOfArgBytes(hex(ICP.selfauthHex));
  assertEq(bytesToHex(balanceArg), ICP.balanceOfDefault, 'icp balance_of arg (default account) == dpay-icp golden');

  // requestId() six-field math == G_RID_NO_NONCE. The harness requestId fn is module-private, so
  // mirror its leaf/sort/concat logic here (same discipline as the wire builders above — the
  // mirror reads the same spec the harness implements; a divergence fails THIS assert).
  const ridFields = [
    ['request_type', Buffer.from('call', 'utf8')],
    ['ingress_expiry', Uint8Array.from(uleb(ICP.expiry))],
    ['sender', hex(ICP.selfauthHex)],
    ['canister_id', hex('000000000000000002')],
    ['method_name', Buffer.from('icrc1_transfer', 'utf8')],
    ['arg', Uint8Array.from(transferArg)],
  ];
  const sha256 = (b) => cryptoCreateHash('sha256').update(b).digest();
  const ridLeaf = (v) => (v.__ridArray ? sha256(Buffer.concat(v.__ridArray.map(ridLeaf))) : sha256(v));
  const ridHashed = ridFields.map(([k, v]) => [sha256(Buffer.from(k, 'utf8')), ridLeaf(v)]);
  ridHashed.sort((a, b) => Buffer.compare(a[0], b[0]) || Buffer.compare(a[1], b[1]));
  let ridConcat = Buffer.alloc(0);
  for (const [kh, vh] of ridHashed) ridConcat = Buffer.concat([ridConcat, kh, vh]);
  assertEq(bytesToHex(sha256(ridConcat)), ICP.ridNoNonce, 'icp request_id (no-nonce call) == dpay-icp golden');
  console.log('[00-cross-val] ✓ icp builders match dpay-icp production goldens (transfer arg, balance_of arg, request_id)');

  // --- (8) amount parser cross-val: TS BigInt parser == fixed Rust goldens --------------------
  //   MC1 unit 1. The canonical parser is `dpay_core::{parse_decimal_to_units,
  //   format_units_to_decimal}`; the TS BigInt mirror lives at `app/lib/amount.ts`. This cross-val
  //   asserts the TS logic produces byte-identical results to the Rust core for fixed goldens,
  //   including a value > 2^53 (the IEEE-754 loss zone the OLD number/Double amount path fell into).
  //
  //   The parser is REPLICATED inline here for the SAME reason the signing shim is replicated at the
  //   top of this file: Node cannot import `.ts` (no TS loader in e2e), so the cross-val mirrors the
  //   module's pure logic and compares against Rust-golden strings. The REAL `app/lib/amount.ts` is
  //   exercised by `app/__tests__/amount.test.ts` (jest, 23 checks); the same goldens are triple-
  //   pinned by the Python FFI roundtrip (`test_ffi.py` §9, which calls the REAL compiled Rust via
  //   UniFFI). So Rust core + Python-via-FFI + TS-logic all agree on these exact strings.
  const MAX_DECIMALS = 18;
  const U64_MAX = (1n << 64n) - 1n;
  const RE_NUMERIC_AMOUNT = /^(\d+\.?\d*|\.\d+)$/;
  function tsParseDecimalToUnits(human, decimals) {
    const s = String(human).trim();
    if (s.length === 0) return { ok: false, err: 'empty' };
    if (s.startsWith('-')) return { ok: false, err: 'negative' };
    if (!RE_NUMERIC_AMOUNT.test(s)) return { ok: false, err: 'not_a_number' };
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
      return { ok: false, err: 'overflow' };
    }
    const dot = s.indexOf('.');
    const wholeStr = dot < 0 ? s : s.slice(0, dot);
    const fracStr = dot < 0 ? '' : s.slice(dot + 1);
    if (fracStr.length > decimals) return { ok: false, err: 'too_many_decimals' };
    const scale = 10n ** BigInt(decimals);
    const whole = wholeStr.length === 0 ? 0n : BigInt(wholeStr);
    const frac = fracStr.length === 0 ? 0n : BigInt(fracStr) * (10n ** BigInt(decimals - fracStr.length));
    const total = whole * scale + frac;
    if (total > U64_MAX) return { ok: false, err: 'overflow' };
    return { ok: true, raw: total.toString(10) };
  }
  function tsFormatUnitsToDecimal(raw, decimals) {
    const d = Math.min(decimals, MAX_DECIMALS);
    const scale = 10n ** BigInt(d);
    const val = BigInt(raw);
    const whole = val / scale;
    const frac = val % scale;
    if (d === 0 || frac === 0n) return whole.toString(10);
    let fracStr = frac.toString(10).padStart(d, '0');
    while (fracStr.endsWith('0')) fracStr = fracStr.slice(0, -1);
    return `${whole.toString(10)}.${fracStr}`;
  }

  // Fixed Rust goldens — deterministic values the Rust parser produces (triple-pinned: Rust unit
  // tests + Python FFI §9 + this cross-val). Each entry: [rawUnitsStr, decimals, rustGoldenFormatted].
  const amountGoldens = [
    // value > 2^53 (the IEEE-754 loss zone): 0.009007199254740993 * 1e18 == 2^53 + 1.
    ['9007199254740993', 18, '0.009007199254740993'],
    // u64::MAX at 18 decimals (no trailing zero to trim) — the boundary round-trip.
    ['18446744073709551615', 18, '18.446744073709551615'],
    // zero.
    ['0', 18, '0'],
    // 8.4 at 18 decimals (trims 17 trailing zeros — readable, not "8.400000000000000000").
    ['8400000000000000000', 18, '8.4'],
    // cents: 8400 @ 2 trims to a whole "84".
    ['8400', 2, '84'],
  ];
  for (const [rawStr, dec, rustGolden] of amountGoldens) {
    const tsFormatted = tsFormatUnitsToDecimal(rawStr, dec);
    assertEq(tsFormatted, rustGolden, `TS format("${rawStr}", ${dec}) == Rust golden`);
    const tsParsed = tsParseDecimalToUnits(rustGolden, dec);
    assert(tsParsed.ok && tsParsed.raw === rawStr,
      `TS parse(rustGolden, ${dec}) == "${rawStr}" (round-trip; got ${JSON.stringify(tsParsed)})`);
  }

  // The > 2^53 value MUST parse to the EXACT raw — the whole point of MC1 (Number() would lose it).
  const lossyProbe = tsParseDecimalToUnits('0.009007199254740993', 18);
  assert(lossyProbe.ok && lossyProbe.raw === '9007199254740993',
    `2^53+1 parses exactly via BigInt (got ${JSON.stringify(lossyProbe)}); Number() would give 9007199254740992`);

  // Rejection parity: the TS err codes match the Rust AmountError variants exactly.
  assertEq(JSON.stringify(tsParseDecimalToUnits('', 2)), JSON.stringify({ ok: false, err: 'empty' }), 'TS reject empty');
  assertEq(JSON.stringify(tsParseDecimalToUnits('abc', 2)), JSON.stringify({ ok: false, err: 'not_a_number' }), 'TS reject not_a_number');
  assertEq(JSON.stringify(tsParseDecimalToUnits('-1', 2)), JSON.stringify({ ok: false, err: 'negative' }), 'TS reject negative');
  assertEq(JSON.stringify(tsParseDecimalToUnits('1.5', 0)), JSON.stringify({ ok: false, err: 'too_many_decimals' }), 'TS reject too_many_decimals');
  assertEq(JSON.stringify(tsParseDecimalToUnits('99999999999999999999999999999', 0)), JSON.stringify({ ok: false, err: 'overflow' }), 'TS reject overflow');
  console.log('[00-cross-val] ✓ TS BigInt amount parser matches Rust goldens (incl. > 2^53, u64::MAX, rejections)');

  console.log('[00-cross-val] ALL CHECKS GREEN — pay wire + request QR + amount parser + icp builders byte-exact vs the Rust core');
}

// Allow `node tests/00-cross-val.mjs` to run standalone (the orchestrator imports `run`).
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
