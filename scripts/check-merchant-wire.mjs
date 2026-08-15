#!/usr/bin/env node
// Merchant-terminal wire parity assertion (the "can I pay the web terminal?" invariant).
//
// The merchant terminal builds its request QR through the WASM core: crates/dpay-relay/assets
// merchant.html loads /dpay-core.wasm (crates/dpay-wasm, the frozen Rust wire core) and its
// `merchant-wire-v2` fence is a thin binding over `w_build_request` — the SAME builder the
// Android app, canister, and relay use. There is deliberately NO fallback JS encoder: the
// v1/v2 drift class (2026-07-31: a hand-rolled 68-byte v1 encoder survived every gate until the
// founder hit it live; the terminal's QR was unreadable by the app) dies only if exactly one
// encoder exists.
//
// This script is the static net that proves the binding is wired to the bytes actually served:
// it extracts the `merchant-wire-v2` fence from the served HTML, runs its REAL init path
// (fetch('/dpay-core.wasm') → WebAssembly.instantiate → ABI check) with fetch stubbed to the
// STAGED crates/dpay-relay/assets/dpay-core.wasm (the exact artifact the relay serves), then
// asserts the fence's `encodeRequest` output is byte-identical to the trusted oracle
// (e2e/harness/wire.mjs buildRequestBytes, itself byte-validated against the Rust core) across
// the matrix of amounts/names (incl. UTF-8 + 32-byte truncation). Sub-second, no server.
//
// Usage: node scripts/check-merchant-wire.mjs   (exit 0 = parity, exit 1 = drift/wiring failure)
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {buildRequestBytes, REQUEST_LEN} from '../e2e/harness/wire.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HTML = `${ROOT}crates/dpay-relay/assets/merchant.html`;
const WASM = `${ROOT}crates/dpay-relay/assets/dpay-core.wasm`;

const html = readFileSync(HTML, 'utf8');

// Extract the fenced wasm binding (stable markers: restyling the page never moves them; the old
// `function hexToBytes`…`return b64url(b);` anchors died with the hand-rolled encoder).
const OPEN = '// >>> merchant-wire-v2', CLOSE = '// <<< merchant-wire-v2';
const o = html.indexOf(OPEN), c = html.indexOf(CLOSE);
if (o < 0 || c < 0 || c < o) {
  console.error(`FAIL: could not locate the ${OPEN} … ${CLOSE} fence in merchant.html`);
  process.exit(1);
}
const fence = html.slice(o + OPEN.length, c);

// The fence must fetch the served core — a page that loads anything else (or nothing) fails here.
if (!fence.includes(`'/dpay-core.wasm'`)) {
  console.error('FAIL: the merchant-wire-v2 fence does not reference /dpay-core.wasm');
  process.exit(1);
}
// And the page must actually CALL the encoder (a deleted call site = a terminal that never charges).
if (!html.slice(c + CLOSE.length).includes('encodeRequest(')) {
  console.error('FAIL: no encodeRequest( call site outside the fence — the terminal never builds a request');
  process.exit(1);
}

// Run the fence's REAL init path against the STAGED artifact: fetch is stubbed to serve the
// committed crates/dpay-relay/assets/dpay-core.wasm bytes (any other URL is an error, so the
// binding can't silently load something else). `globalThis` is shadowed so the fence's
// __signerReady assignment stays hermetic; WebAssembly/TextEncoder/btoa are node's own — the
// same engine class the browser runs.
let staged;
try {
  staged = readFileSync(WASM);
} catch (e) {
  console.error(`FAIL: could not read the staged ${WASM} (run \`just wasm\` to build + stage it): ${e.message}`);
  process.exit(1);
}
const fetchStub = async url => {
  if (url !== '/dpay-core.wasm') throw new Error(`unexpected fetch(${url})`);
  return new Response(staged);
};
const sandbox = new Function('fetch', 'globalThis', 'console',
  fence + '\nreturn { encodeRequest, signerReady };')(fetchStub, {}, console);

let encodeRequestTerminal;
try {
  await sandbox.signerReady; // init failure (bad status/ABI/instantiate) must fail loud here
  encodeRequestTerminal = sandbox.encodeRequest;
} catch (e) {
  console.error(`FAIL: the fence's signer-core init failed: ${e.message}`);
  process.exit(1);
}

// Ground truth fields. `to` is any 32-byte key; the core pads names to 32 with NULs itself.
// Amounts/expiry pass as Numbers — the terminal's own convention (`Date.now()/1000+600`, cents);
// all test values stay under 2^53 so the BigInt splits are exact.
const TO = 'ab'.repeat(32);
const NONCE = 'cd'.repeat(16);
const EXPIRY = 0x11223344;

const cases = [
  {cents: 2500, toName: 'Café Demo'},
  {cents: 1, toName: 'A'},
  {cents: 4503599627370495, toName: 'ünïcödé nàme 漢字 ok?'}, // 2^52-1: max exact-integer stress
  {cents: 500, toName: 'x'.repeat(40)}, // longer than 32 → must truncate identically
];

let fail = 0;
for (const {cents, toName} of cases) {
  const terminalBytes = (() => {
    const b64 = encodeRequestTerminal(TO, cents, NONCE, EXPIRY, 0, toName);
    return Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  })();
  const coreBytes = Buffer.from(buildRequestBytes(TO, BigInt(cents), NONCE, BigInt(EXPIRY), 0, toName, ''));
  const hex = b => b.toString('hex');
  const t = hex(terminalBytes), k = hex(coreBytes);
  const ok = t === k && terminalBytes.length === coreBytes.length && coreBytes.length === REQUEST_LEN;
  if (!ok) {
    fail++;
    console.error(`DRIFT (to_name=${JSON.stringify(toName)}):`);
    console.error(`  terminal: len=${terminalBytes.length} ${t.slice(0, 260)}…`);
    console.error(`  core:     len=${coreBytes.length} ${k.slice(0, 260)}…`);
  }
}

if (fail) {
  console.error(`\nFAIL: merchant.html wasm binding drifted from dpay-core (REQUEST_LEN=132 wire v2) in ${fail} case(s).`);
  console.error('The app would refuse the terminal\'s QR. Fix the merchant-wire-v2 fence / staged dpay-core.wasm (e2e/harness/wire.mjs is the oracle).');
  process.exit(1);
}
console.log(`merchant-wire parity OK: fence encodeRequest(via staged dpay-core.wasm) == dpay-core 132-byte request across ${cases.length} cases (incl. UTF-8 + 32-byte truncation)`);
