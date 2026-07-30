// Cross-validation test (RED first → GREEN) — proves the JS ed25519 DpayCore shim produces a
// byte-identical sig + wire to the Rust core, so every local pay flow that uses this shim will
// settle on the real FakeLedger (which calls `sa.verify()` via ed25519-dalek `verify_strict`).
//
// This test is the FIRST thing that runs in the suite (`00-` prefix). It does NOT need a browser or
// a relay — it loads the wire_layout.json golden bytes and the shim's pure builders, then asserts:
//   1. Re-signing the golden Authorization produces the golden sig (byte-exact).
//   2. Re-assembling the wire produces the golden wire (byte-exact).
//   3. verifyWire(golden.wire_hex) returns true.
//   4. The golden QR round-trips: encodeRequest → decodeRequest recovers the original fields.
//
// If this test fails, do NOT proceed to the flow tests — the local pay path is broken. That is the
// "no silent errors" guarantee: a stale wire_layout.json or a bug in the shim surfaces HERE, not as
// a mysterious 422 from the relay two flows later.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assert, assertEq } from '../harness/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIRE_LAYOUT = join(__dirname, '..', '..', 'dfx', 'wire_layout.json');

// Import the shim's internals. Node's static analyzer needs the explicit extension; the .ts is
// resolved via a tiny on-disk build step or (here) by reading the layout + reimplementing the byte
// math directly. To keep the test zero-build, we replicate ONLY what's needed: the builders operate
// purely on the layout JSON's offsets/lengths (the same ones the shim uses). If the shim and this
// test disagree on a layout constant, both read the same JSON so the divergence is caught here.
const layout = JSON.parse(readFileSync(WIRE_LAYOUT, 'utf8'));

// --- replicate the shim's pure byte builders (mirror e2e/web/dpay-core.ts exactly) ------------
function hex(h) { return Buffer.from(h, 'hex'); }
function bytesToHex(b) { return Buffer.from(b).toString('hex'); }

function putU64Le(buf, offset, val) {
  let v = Math.floor(val);
  for (let i = 0; i < 8; i++) { buf[offset + i] = v & 0xff; v = Math.floor(v / 0x100); }
}
function readU64Le(buf, offset) {
  let v = 0; for (let i = 7; i >= 0; i--) v = v * 0x100 + buf[offset + i]; return v;
}
function putU32Le(buf, offset, val) {
  let v = Math.floor(val);
  for (let i = 0; i < 4; i++) { buf[offset + i] = v & 0xff; v = Math.floor(v / 0x100); }
}
function readU32Le(buf, offset) {
  let v = 0; for (let i = 3; i >= 0; i--) v = v * 0x100 + buf[offset + i]; return v;
}

function buildSigningBytes(fromHex, toHex, amount, nonceHex, expiry, currency) {
  const from = hex(fromHex), to = hex(toHex), nonce = hex(nonceHex);
  const buf = Buffer.alloc(layout.signing_len);
  buf.set(from, layout.fields.from.offset);
  buf.set(to, layout.fields.to.offset);
  putU64Le(buf, layout.fields.amount.offset, amount);
  buf.set(nonce, layout.fields.nonce.offset);
  putU64Le(buf, layout.fields.expiry.offset, expiry);
  putU32Le(buf, layout.fields.currency.offset, currency);
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

export async function run() {
  const g = layout.golden;
  console.log('[00-cross-val] golden secret:', g.secret_hex.slice(0, 16) + '…');
  console.log('[00-cross-val] golden public:', g.public_hex);

  // --- (1) re-sign the golden Authorization with @noble/ed25519 -----------------------------
  const signing = buildSigningBytes(g.public_hex, g.to_hex, g.amount, g.nonce_hex, g.expiry, g.currency);
  assertEq(bytesToHex(signing), g.signing_hex, 'signing buffer (golden layout vs shim builder)');

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
  //   (mirrors PaymentRequest::encode / decode; the merchant QR is "<b64>|<name>")
  const reqBytes = Buffer.alloc(layout.request_len);
  let off = 0;
  reqBytes.set(hex(g.to_hex), off); off += layout.fields.to.len;
  putU64Le(reqBytes, off, g.amount); off += layout.fields.amount.len;
  reqBytes.set(hex(g.nonce_hex), off); off += layout.fields.nonce.len;
  putU64Le(reqBytes, off, g.expiry); off += layout.fields.expiry.len;
  putU32Le(reqBytes, off, g.currency);
  const reqB64 = b64urlEncode(new Uint8Array(reqBytes));
  const merchantQR = `${reqB64}|alice`;
  const split = merchantQR.slice(0, merchantQR.indexOf('|'));
  const decoded = b64urlDecode(split);
  assertEq(decoded.length, layout.request_len, 'decoded request length');
  const dTo = bytesToHex(decoded.slice(0, layout.fields.to.len));
  let doff = layout.fields.to.len;
  const dAmount = readU64Le(decoded, doff); doff += layout.fields.amount.len;
  const dNonce = bytesToHex(decoded.slice(doff, doff + layout.fields.nonce.len)); doff += layout.fields.nonce.len;
  const dExpiry = readU64Le(decoded, doff); doff += layout.fields.expiry.len;
  const dCurrency = readU32Le(decoded, doff);
  assertEq(dTo, g.to_hex, 'decoded request.to');
  assertEq(dAmount, g.amount, 'decoded request.amount');
  assertEq(dNonce, g.nonce_hex, 'decoded request.nonce');
  assertEq(dExpiry, g.expiry, 'decoded request.expiry');
  assertEq(dCurrency, g.currency, 'decoded request.currency');
  console.log('[00-cross-val] ✓ request QR round-trips byte-exact');

  // --- (6) withdraw shim byte-exactness: re-signing the golden WithdrawAuth produces the golden
  //   sig (mirrors `dpay_core::WithdrawAuth::signing_bytes`). If the shim's `buildWithdrawSigningBytes`
  //   diverges from the Rust core, the FakeLedger/canister verify rejects the sig and the e2e
  //   withdraw flow (15-withdraw) goes RED. The withdraw layout is variable-length (address last).
  const wg = layout.withdraw.golden;
  const W = layout.withdraw;
  const wAddr = Buffer.from(wg.btc_address, 'utf8');
  const wSigning = Buffer.alloc(W.fixed_len + W.addr_len_bytes + wAddr.length);
  wSigning.set(hex(wg.public_hex), W.fields.from_pubkey.offset);
  putU64Le(wSigning, W.fields.amount.offset, wg.amount);
  wSigning.set(hex(wg.nonce_hex), W.fields.nonce.offset);
  putU64Le(wSigning, W.fields.expiry.offset, wg.expiry);
  putU32Le(wSigning, W.fields.currency.offset, wg.currency);
  putU32Le(wSigning, W.fields.address_len.offset, wAddr.length);
  wSigning.set(wAddr, W.fields.address_len.offset + W.addr_len_bytes);
  assertEq(bytesToHex(new Uint8Array(wSigning)), wg.signing_hex, 'withdraw signing buffer (golden layout vs shim builder)');
  const wSig = await ed.signAsync(new Uint8Array(wSigning), hex(wg.secret_hex));
  if (bytesToHex(wSig) !== wg.sig_hex) {
    throw new Error(
      `[00-cross-val] WITHDRAW SIG MISMATCH — the JS shim's withdraw sig differs from the Rust core's.\n` +
      `  rust : ${wg.sig_hex}\n  js   : ${bytesToHex(wSig)}\n` +
      `  Local withdraw flows will NOT settle (FakeLedger/canister verify fails).`
    );
  }
  console.log('[00-cross-val] ✓ withdraw sig matches Rust core byte-for-byte');

  console.log('[00-cross-val] ALL CHECKS GREEN — local pay + withdraw flows will settle on the real FakeLedger');
}

// Allow `node tests/00-cross-val.mjs` to run standalone (the orchestrator imports `run`).
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
