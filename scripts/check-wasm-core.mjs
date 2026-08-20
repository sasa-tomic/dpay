#!/usr/bin/env node
// dpay-wasm core parity guard (the "every web surface signs the SAME bytes as Android" invariant).
//
// `crates/dpay-wasm` compiles the FROZEN Rust wire core to wasm32-unknown-unknown; the artifact is
// staged at crates/dpay-relay/assets/dpay-core.wasm (committed, like shot-*.png) and served by the
// relay at GET /dpay-core.wasm. Any browser surface (wallet/merchant terminals) that loads it signs
// and builds the EXACT bytes the Android app's UniFFI core produces — one signing source.
//
// This script loads the STAGED artifact (not the build dir — it proves what would actually be
// served), instantiates it with NO imports, exercises the FULL export surface, and asserts
// byte-parity against the trusted JS oracle (e2e/harness/wire.mjs, itself byte-validated against
// the Rust core by tests/00-cross-val):
//   - w_abi_version == 1; w_error_message covers every code; w_alloc is a sane bump allocator.
//   - w_layout_json deep-equals dfx/wire_layout.json (the Rust-emitted single source of truth).
//   - w_pubkey('ab'×32) matches the from_pub the noble oracle derives.
//   - golden + UTF-8 + 32-byte-truncation + u64-stress requests: w_decode_request JSON round-trips
//     wire.mjs decodeRequest, and w_sign_request emits a 292-byte wire byte-identical to
//     wire.mjs signAuthorizationCode (deterministic ed25519).
//   - w_sign_withdraw sig hex == wire.mjs signWithdrawalHex across u64 stress (2^52-1, 2^63+0xdead,
//     u64::MAX) and empty/long destinations.
//   - w_verify_receipt_sig: the Rust-generated receipt golden (wire_layout.json `receipt` section —
//     the same fixture wire.mjs treats as ground truth; wire.mjs has no receipt-signing export)
//     verifies → 1; one flipped sig byte / wrong pubkey / bad claim_len → 0.
//   - w_build_request: the merchant-side request ENCODER — golden + UTF-8 + 32-byte-truncation +
//     u64::MAX requests must be byte-identical to wire.mjs buildRequestBytes (the trusted oracle).
//   - w_receipt_claim: the payer/receipt-side claim assembler — the canonical golden hex (embedded
//     below; produced by dpay-core's ReceiptClaim::signing_bytes via the crate's HOST test), a
//     field-for-field rebuild of the wire_layout.json receipt golden, and u64 extremes.
//   - w_icp_* (IC user-principal rail): the additive-only export census, the minter_ok reply
//     golden, and ARG-BUILD/SIGN GOLDENS — w_icp_transfer_arg / w_icp_approve_arg DIDL bytes and
//     the w_icp_sign_update envelope + request_id, pinned against hex produced by the dpay-wasm
//     HOST test (icp::goldens, the Rust single source). Plus the error contract: an expires
//     value above u64::MAX must return BAD_UTF8 (never silently wrap — the 2026-08-20 u128→u64
//     truncation bug) and a malformed read_state cert must ERROR, not fabricate unknown-pending.
//
// Usage: node scripts/check-wasm-core.mjs   (exit 0 = parity, exit 1 = drift; failures print hex diffs)
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  buildRequestBytes, decodeRequest, signAuthorizationCode, signWithdrawalHex,
  b64urlEncode, b64urlDecode, REQUEST_LEN, WIRE_LEN,
} from '../e2e/harness/wire.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WASM = `${ROOT}crates/dpay-relay/assets/dpay-core.wasm`;
const LAYOUT_PATH = `${ROOT}dfx/wire_layout.json`;

// --- tiny assert harness (collect failures, print hex diffs, exit 1 on any) ---------------------
let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${name}`);
    if (detail) console.error(`  ${detail}`);
  }
}
function hex(b) { return Buffer.from(b).toString('hex'); }
function fromHex(h) { return Uint8Array.from(Buffer.from(h, 'hex')); }
function hexDiff(label, got, want) {
  const g = hex(got), w = hex(want);
  if (g === w) return undefined;
  let i = 0; while (i < g.length && g[i] === w[i]) i++;
  return `${label}: len got=${got.length} want=${want.length}, first diff at hex char ${i}\n    got:  ${g.slice(0, 320)}${g.length > 320 ? '…' : ''}\n    want: ${w.slice(0, 320)}${w.length > 320 ? '…' : ''}`;
}
function jsonDiff(label, got, want) {
  if (got === want) return undefined;
  return `${label}:\n    got:  ${got.slice(0, 400)}\n    want: ${want.slice(0, 400)}`;
}
// Order-insensitive canonical JSON compare (both sides are parsed JSON).
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (x !== null && typeof x === 'object')
    return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x);
}

// --- load + instantiate the staged wasm (no imports; the module owns its memory) ---------------
let ex;
try {
  const bytes = readFileSync(WASM);
  const {instance} = await WebAssembly.instantiate(bytes);
  ex = instance.exports;
} catch (e) {
  console.error(`FAIL: could not load/instantiate ${WASM} (run \`just wasm\` to build + stage it): ${e.message}`);
  process.exit(1);
}
const enc = new TextEncoder();
const dec = new TextDecoder();
// Write bytes into a fresh w_alloc region (re-derive the view AFTER alloc — growth detaches).
function writeBytes(bytes) {
  const p = ex.w_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
  return p;
}
function writeStr(s) { return writeBytes(enc.encode(s)); }
function readBytes(p, len) { return new Uint8Array(ex.memory.buffer.slice(p, p + len)); }
function readStr(p, len) { return dec.decode(readBytes(p, len)); }
// Split a BigInt u64 into (lo, hi) u32s — the ABI's answer to JS's missing u64.
const split64 = v => { v = BigInt(v); return [Number(v & 0xffffffffn), Number((v >> 32n) & 0xffffffffn)]; };

// --- ABI + alloc + error strings ---------------------------------------------------------------
check('w_abi_version == 1', ex.w_abi_version() === 1, `got ${ex.w_abi_version()}`);
{
  const a = ex.w_alloc(64), b = ex.w_alloc(64), c = ex.w_alloc(0);
  check('w_alloc returns nonzero, increasing, aligned ptrs',
    a !== 0 && b === a + 64 && c >= b && a % 8 === 0, `a=${a} b=${b} c=${c}`);
}
{
  const errors = {0: 'ok', 1: 'bad_len', 2: 'bad_utf8', 3: 'verify_failed'};
  const p = ex.w_alloc(64);
  for (const [code, want] of Object.entries(errors)) {
    const n = ex.w_error_message(code, p, 64);
    check(`w_error_message(${code}) == "${want}"`, n === want.length && readStr(p, n) === want,
      `n=${n} str=${JSON.stringify(readStr(p, n))}`);
  }
  const n = ex.w_error_message(999, p, 64);
  check('w_error_message(unknown) is a nonempty fallback', n > 0, `n=${n}`);
  check('w_error_message(cap too small) == 0', ex.w_error_message(1, p, 2) === 0);
}

// --- w_layout_json deep-equals the Rust-emitted dfx/wire_layout.json ---------------------------
{
  const p = ex.w_alloc(32768);
  const n = ex.w_layout_json(p, 32768);
  check('w_layout_json writes a document', n > 0, `n=${n}`);
  if (n > 0) {
    const got = JSON.parse(readStr(p, n));
    const want = JSON.parse(readFileSync(LAYOUT_PATH, 'utf8'));
    check('w_layout_json deep-equals dfx/wire_layout.json',
      canon(got) === canon(want),
      jsonDiff('layout JSON drift', canon(got), canon(want)));
  }
  check('w_layout_json(cap too small) == 0', ex.w_layout_json(p, 8) === 0);
}

// --- fixture request matrix: golden + UTF-8 + 32-byte truncation + u64 stress -------------------
const SEED_HEX = 'ab'.repeat(32);
const SEED = fromHex(SEED_HEX);
const L = JSON.parse(readFileSync(LAYOUT_PATH, 'utf8'));
const CASES = [
  {name: 'golden',  to: L.golden.to_hex, amount: 2500n, nonce: L.golden.nonce_hex, expiry: 4102444800n, currency: 0, toName: 'Bob', memo: 'coffee'},
  {name: 'utf8',    to: L.golden.to_hex, amount: 8400000000000000000n, nonce: 'cd'.repeat(16), expiry: 1700000120n, currency: 2, toName: 'ünïcödé nàme 漢字 ok?', memo: 'café ☕'},
  {name: 'trunc40', to: L.golden.to_hex, amount: 1n,    nonce: 'ee'.repeat(16), expiry: 1n, currency: 0, toName: 'x'.repeat(40), memo: 'm'.repeat(40)},
  {name: 'u64max',  to: L.golden.to_hex, amount: 18446744073709551615n, nonce: '2a'.repeat(16), expiry: 18446744073709551615n, currency: 0xffffffff, toName: '', memo: ''},
];

// Expected payer pubkey under SEED (from_pub is the last 32 bytes of any oracle-signed wire).
const EXP_PUB = b64urlDecode(await signAuthorizationCode(SEED_HEX, CASES[0].to, CASES[0].amount, CASES[0].nonce, CASES[0].expiry, CASES[0].currency)).slice(260, 292);

// w_pubkey
{
  const out = ex.w_alloc(32);
  const rc = ex.w_pubkey(writeBytes(SEED), out);
  check('w_pubkey(seed ab×32) == noble-derived pubkey', rc === 0 && hexDiff('pubkey', readBytes(out, 32), EXP_PUB) === undefined,
    `rc=${rc} ${hexDiff('pubkey', readBytes(out, 32), EXP_PUB)}`);
}

// per-case decode + sign
const FROM_NAMES = ['Alice', '', 'ünïcödé nàme 漢字 ok?', 'y'.repeat(40)];
for (const c of CASES) {
  const reqBytes = buildRequestBytes(c.to, c.amount, c.nonce, c.expiry, c.currency, c.toName, c.memo);
  check(`request[${c.name}] oracle builds 132 bytes`, reqBytes.length === REQUEST_LEN, `len=${reqBytes.length}`);

  // w_decode_request == wire.mjs decodeRequest
  {
    const want = decodeRequest(b64urlEncode(reqBytes));
    const out = ex.w_alloc(1024);
    const n = ex.w_decode_request(writeBytes(reqBytes), out, 1024);
    check(`w_decode_request[${c.name}] writes JSON`, n > 0, `n=${n}`);
    if (n > 0) {
      const got = JSON.parse(readStr(out, n));
      const field = (k) => check(`decode[${c.name}].${k}`, got[k] === want[k], `got ${JSON.stringify(got[k])} want ${JSON.stringify(want[k])}`);
      field('toHex'); field('amount'); field('nonceHex'); field('expiry'); field('currency'); field('toName'); field('memo');
      check(`decode[${c.name}].amount is a decimal string`, typeof got.amount === 'string', `typeof=${typeof got.amount}`);
    }
    check(`w_decode_request[${c.name}] cap-too-small == 0`, ex.w_decode_request(writeBytes(reqBytes), out, 8) === 0);
  }

  // w_sign_request == wire.mjs signAuthorizationCode (byte-identical 292-byte wire)
  for (const fromName of FROM_NAMES) {
    const want = b64urlDecode(await signAuthorizationCode(SEED_HEX, c.to, c.amount, c.nonce, c.expiry, c.currency, fromName, c.toName, c.memo));
    const wire = ex.w_alloc(292);
    const rc = ex.w_sign_request(writeBytes(SEED), writeBytes(reqBytes), writeStr(fromName), enc.encode(fromName).length, wire);
    const got = readBytes(wire, 292);
    check(`w_sign_request[${c.name} from=${JSON.stringify(fromName).slice(0, 24)}] byte-identical to oracle`,
      rc === 0 && got.length === WIRE_LEN && hexDiff('wire', got, want) === undefined,
      `rc=${rc} ${hexDiff('wire', got, want)}`);
  }
}
// w_sign_request rejects non-UTF-8 from_name
{
  const reqBytes = buildRequestBytes(CASES[0].to, CASES[0].amount, CASES[0].nonce, CASES[0].expiry, CASES[0].currency, 'Bob', 'coffee');
  const wire = ex.w_alloc(292);
  const bad = writeBytes(new Uint8Array([0xff, 0xfe, 0xfd]));
  check('w_sign_request(bad UTF-8 from_name) == BAD_UTF8(2)',
    ex.w_sign_request(writeBytes(SEED), writeBytes(reqBytes), bad, 3, wire) === 2);
}

// --- w_build_request: the merchant-side encoder vs the trusted request oracle -------------------
for (const c of CASES) {
  const want = buildRequestBytes(c.to, c.amount, c.nonce, c.expiry, c.currency, c.toName, c.memo);
  const [alo, ahi] = split64(c.amount), [elo, ehi] = split64(c.expiry);
  const out = ex.w_alloc(REQUEST_LEN);
  const rc = ex.w_build_request(
    writeBytes(fromHex(c.to)), alo, ahi, writeBytes(fromHex(c.nonce)), elo, ehi, c.currency,
    writeStr(c.toName), enc.encode(c.toName).length, writeStr(c.memo), enc.encode(c.memo).length, out);
  const got = readBytes(out, REQUEST_LEN);
  check(`w_build_request[${c.name}] byte-identical to oracle buildRequestBytes`,
    rc === 0 && hexDiff('request', got, want) === undefined,
    `rc=${rc} ${hexDiff('request', got, want)}`);
}
{
  const out = ex.w_alloc(REQUEST_LEN);
  const bad = writeBytes(new Uint8Array([0xff, 0xfe, 0xfd]));
  const to = writeBytes(fromHex(L.golden.to_hex)), nonce = writeBytes(fromHex('cd'.repeat(16)));
  check('w_build_request(bad UTF-8 toName) == BAD_UTF8(2)',
    ex.w_build_request(to, 1, 0, nonce, 1, 0, 0, bad, 3, writeStr(''), 0, out) === 2);
  check('w_build_request(bad UTF-8 memo) == BAD_UTF8(2)',
    ex.w_build_request(to, 1, 0, nonce, 1, 0, 0, writeStr(''), 0, bad, 3, out) === 2);
  check('w_build_request(out-of-bounds out_req_ptr) == BAD_LEN(1)',
    ex.w_build_request(to, 1, 0, nonce, 1, 0, 0, writeStr(''), 0, writeStr(''), 0, 0xffff0000) === 1);
}

// --- w_sign_withdraw: u64 stress via lo/hi + empty/long destinations ---------------------------
{
  const pubHex = hex(EXP_PUB);
  const W = [
    {dest: 'bc1qdpaygoldenwithdrawaladdress', amount: 50000n, expiry: 4102444800n, currency: 0},
    {dest: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', amount: 2n ** 52n - 1n, expiry: 1700000120n, currency: 1},
    {dest: 'bc1q' + 'x'.repeat(80), amount: 2n ** 63n + 0xdeadn, expiry: 4102444800n, currency: 3},
    {dest: '', amount: 18446744073709551615n, expiry: 18446744073709551615n, currency: 0xffffffff},
  ];
  for (const w of W) {
    const nonceHex = '2a'.repeat(16);
    const want = await signWithdrawalHex(SEED_HEX, pubHex, w.dest, w.amount, nonceHex, w.expiry, w.currency);
    const [alo, ahi] = split64(w.amount), [elo, ehi] = split64(w.expiry);
    const out = ex.w_alloc(64);
    const rc = ex.w_sign_withdraw(writeBytes(SEED), writeStr(w.dest), enc.encode(w.dest).length, alo, ahi, writeBytes(fromHex(nonceHex)), elo, ehi, w.currency, out);
    const got = hex(readBytes(out, 64));
    check(`w_sign_withdraw[dest=${JSON.stringify(w.dest).slice(0, 20)} amount=${w.amount}] hex == oracle`,
      rc === 0 && got === want, `rc=${rc}\n    got:  ${got}\n    want: ${want}`);
  }
  // non-UTF-8 destination
  const out = ex.w_alloc(64);
  const bad = writeBytes(new Uint8Array([0xff]));
  check('w_sign_withdraw(bad UTF-8 dest) == BAD_UTF8(2)',
    ex.w_sign_withdraw(writeBytes(SEED), bad, 1, 1, 0, writeBytes(fromHex('2a'.repeat(16))), 1, 0, 0, out) === 2);
}

// --- w_verify_receipt_sig: Rust-generated golden verifies; tamper fails ------------------------
{
  const G = L.receipt.golden;
  const claim = fromHex(G.signing_hex); // the frozen 108-byte claim layout
  const pub = fromHex(G.public_hex);
  const sig = fromHex(G.sig_hex);
  check('receipt golden claim is 108 bytes', claim.length === L.receipt.fixed_len, `len=${claim.length}`);
  check('w_verify_receipt_sig(golden) == 1', ex.w_verify_receipt_sig(writeBytes(pub), writeBytes(claim), claim.length, writeBytes(sig)) === 1);

  const badSig = sig.slice(); badSig[5] ^= 0x01;
  check('w_verify_receipt_sig(flipped sig byte) == 0', ex.w_verify_receipt_sig(writeBytes(pub), writeBytes(claim), claim.length, writeBytes(badSig)) === 0);
  check('w_verify_receipt_sig(wrong pubkey) == 0', ex.w_verify_receipt_sig(writeBytes(fromHex(G.to_hex)), writeBytes(claim), claim.length, writeBytes(sig)) === 0);
  check('w_verify_receipt_sig(bad claim_len) == 0', ex.w_verify_receipt_sig(writeBytes(pub), writeBytes(claim), claim.length - 1, writeBytes(sig)) === 0);
}

// --- w_receipt_claim: the frozen 108-byte canister-signed claim ---------------------------------
// GOLDEN_CLAIM_HEX comes from dpay-core's ReceiptClaim::signing_bytes via the crate's HOST test
// (crates/dpay-wasm/src/lib.rs, receipt_claim_matches_core_and_pins_golden_hex): nonce 'cd'×16,
// from 'ab'×32, to 'ef'×32, amount 1234, currency 0, block_index 8168, settle_ts 1786815398.
{
  const GOLDEN_CLAIM_HEX = 'cd'.repeat(16) + 'ab'.repeat(32) + 'ef'.repeat(32)
    + 'd204000000000000'   // amount 1234 le
    + '00000000'           // currency 0 le
    + 'e81f000000000000'   // block_index 8168 le
    + 'a6a3806a00000000';  // settle_ts 1786815398 le
  const buildClaim = (nonceHex, fromHexStr, toHexStr, amount, currency, blockIndex, settleTs) => {
    const [alo, ahi] = split64(amount), [blo, bhi] = split64(blockIndex), [slo, shi] = split64(settleTs);
    const out = ex.w_alloc(108);
    const rc = ex.w_receipt_claim(writeBytes(fromHex(nonceHex)), writeBytes(fromHex(fromHexStr)),
      writeBytes(fromHex(toHexStr)), alo, ahi, currency, blo, bhi, slo, shi, out);
    return [rc, readBytes(out, 108)];
  };
  {
    const [rc, got] = buildClaim('cd'.repeat(16), 'ab'.repeat(32), 'ef'.repeat(32), 1234n, 0, 8168n, 1786815398n);
    check('w_receipt_claim(golden) == host-test golden hex (dpay-core signing_bytes)',
      rc === 0 && hex(got) === GOLDEN_CLAIM_HEX,
      `rc=${rc}\n    got:  ${hex(got)}\n    want: ${GOLDEN_CLAIM_HEX}`);
  }
  // Rebuild the wire_layout.json receipt golden field-for-field (Rust-emitted ground truth).
  {
    const G = L.receipt.golden;
    const [rc, got] = buildClaim(G.nonce_hex, G.from_hex, G.to_hex, BigInt(G.amount), G.currency, BigInt(G.block_index), BigInt(G.settle_ts));
    check('w_receipt_claim rebuilds wire_layout.json receipt golden',
      rc === 0 && hexDiff('claim', got, fromHex(G.signing_hex)) === undefined,
      `rc=${rc} ${hexDiff('claim', got, fromHex(G.signing_hex))}`);
  }
  // u64 extremes through the (lo, hi) halves vs an independent DataView assembly of the frozen layout.
  for (const [name, amount, blockIndex, settleTs] of [
    ['u64max', 18446744073709551615n, 18446744073709551615n, 18446744073709551615n],
    ['hi-only', 0n, 0xdead000000000000n, 1n << 63n],
    ['2^63+0xdead', (1n << 63n) + 0xdeadn, 2n ** 52n - 1n, 1700000120n],
  ]) {
    const currency = 0xffffffff;
    const [rc, got] = buildClaim('2a'.repeat(16), 'ab'.repeat(32), 'ef'.repeat(32), amount, currency, blockIndex, settleTs);
    const want = new Uint8Array(108);
    const dv = new DataView(want.buffer);
    want.set(fromHex('2a'.repeat(16)), 0);
    want.set(fromHex('ab'.repeat(32)), 16);
    want.set(fromHex('ef'.repeat(32)), 48);
    dv.setBigUint64(80, amount, true);
    dv.setUint32(88, currency, true);
    dv.setBigUint64(92, blockIndex, true);
    dv.setBigUint64(100, settleTs, true);
    check(`w_receipt_claim[${name}] == DataView-assembled frozen layout`,
      rc === 0 && hexDiff('claim', got, want) === undefined,
      `rc=${rc} ${hexDiff('claim', got, want)}`);
  }
  check('w_receipt_claim(out-of-bounds out_claim_ptr) == BAD_LEN(1)',
    ex.w_receipt_claim(writeBytes(fromHex('cd'.repeat(16))), writeBytes(fromHex('ab'.repeat(32))), writeBytes(fromHex('ef'.repeat(32))), 1, 0, 0, 1, 0, 1, 0, 0xffff0000) === 1);
}

// --- IC user-principal rail export census (additive-only, ABI v1) --------------------------------
// The IC-rail cutover made the wasm core the ENTIRE /api/v2 rail (envelope signing + reply
// decoding) — a dropped or renamed w_icp_* export would silently break the web wallet's value
// path while `just check` stayed green. Mirror the export table in crates/dpay-wasm/src/icp.rs
// as a pinned list: every entry MUST be present (additive-only policy — new exports extend this
// list; a rename/removal is an ABI break and fails here).
{
  const PINNED_ICP_EXPORTS = [
    'w_icp_self_principal', 'w_icp_principal_from_pubkey', 'w_icp_ingress_expiry',
    'w_icp_transfer_arg', 'w_icp_approve_arg', 'w_icp_balance_of_arg',
    'w_icp_minter_account_arg', 'w_icp_retrieve_btc_arg', 'w_icp_withdraw_eth_arg',
    'w_icp_withdraw_erc20_arg', 'w_icp_eip1559_price_arg',
    'w_icp_decode_text', 'w_icp_decode_eip1559_price',
    'w_icp_sign_update', 'w_icp_sign_query', 'w_icp_sign_read_state',
    'w_icp_envelope_request_id', 'w_icp_decode_query', 'w_icp_decode_read_state',
    'w_icp_decode_transfer_result', 'w_icp_decode_minter_ok', 'w_icp_decode_int',
  ];
  for (const name of PINNED_ICP_EXPORTS) {
    check(`icp export present: ${name}`, typeof ex[name] === 'function',
      'missing/renamed w_icp_* export — ABI break; fix crates/dpay-wasm/src/icp.rs (or update the pinned census)');
  }
  // Guard the guard: unknown w_icp_* exports appearing in the artifact without being pinned
  // (the additive-only policy expects this list to be EXTENDED in the same change).
  const present = Object.keys(ex).filter(k => k.startsWith('w_icp_'));
  const unpinned = present.filter(k => !PINNED_ICP_EXPORTS.includes(k));
  check('no unpinned w_icp_* exports (extend the census when adding one)',
    unpinned.length === 0, `unpinned: ${unpinned.join(', ')}`);
}

// --- w_icp_decode_minter_ok golden (single-source minter reply decoder) --------------------------
// The minter retrieve/withdraw Ok({block_index: nat64}) reply shape is frozen in dpay-icp
// (`encode_minter_ok` — also what the e2e fake-IC gateway emits). This golden pins the WASM
// decoder against a hand-encoded reply + the shared transfer-error Err side, so the web rail's
// offramp outcome decoding can never silently drift from the Rust single source.
{
  const CAP = 256;
  // encode_minter_ok(1234): frozen 22-byte prefix + 1234 as 8 LE bytes.
  const MINTER_OK_1234 =
    '4449444c026b01bc8a01016c01e09ecba90278010000' + // DIDL + table + 0x00 0x00 pad
    'd204000000000000';                               // 1234 LE u64
  const decodeMinter = (hexStr) => {
    const arg = writeBytes(fromHex(hexStr));
    const out = ex.w_alloc(CAP);
    const n = ex.w_icp_decode_minter_ok(arg, fromHex(hexStr).length, out, CAP);
    return [n, n > 0 ? readStr(out, n) : ''];
  };
  {
    const [n, s] = decodeMinter(MINTER_OK_1234);
    check('w_icp_decode_minter_ok(encode_minter_ok(1234)) == {"ok":true,"blockIndex":"1234"}',
      n > 0 && canon(JSON.parse(s)) === canon({ok: true, blockIndex: '1234'}), `n=${n} s=${s}`);
  }
  {
    // u64 extreme round-trip: u64::MAX
    const [n, s] = decodeMinter('4449444c026b01bc8a01016c01e09ecba90278010000ffffffffffffffff');
    check('w_icp_decode_minter_ok(u64::MAX block) == {"ok":true,"blockIndex":"18446744073709551615"}',
      n > 0 && canon(JSON.parse(s)) === canon({ok: true, blockIndex: '18446744073709551615'}), `n=${n} s=${s}`);
  }
  {
    // Err side shares the transfer-error table: a transfer-shaped TooOld reply decodes as Err.
    const [n, s] = decodeMinter('4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000106');
    check('w_icp_decode_minter_ok(TooOld Err reply) == {"ok":false,"errVariant":"TooOld",…}',
      n > 0 && canon(JSON.parse(s)) === canon({ok: false, errVariant: 'TooOld', errDetail: ''}), `n=${n} s=${s}`);
  }
  {
    // BAD_LEN on out-of-bounds arg ptr (same guard as the other decoders).
    check('w_icp_decode_minter_ok(oob arg_ptr) == BAD_LEN(1)',
      ex.w_icp_decode_minter_ok(0xffff0000, 32, ex.w_alloc(CAP), CAP) === 1);
    // 0 (bad input) on garbage that is not a DIDL message.
    // (Non-DIDL bytes fail Rd::message() → IcpError → the export's Err(_) arm returns BAD_UTF8(2),
    //  the decoder-family convention for "reply didn't parse".)
    const [n] = decodeMinter('deadbeef');
    check('w_icp_decode_minter_ok(non-DIDL garbage) == BAD_UTF8(2)', n === 2, `n=${n}`);
  }
}

// --- w_icp arg-build + sign goldens (byte-parity with the Rust single source) ---------------------
// Fixed inputs mirrored in the dpay-wasm HOST test (crates/dpay-wasm/src/icp.rs icp::goldens),
// which pins the SAME hex straight from the dpay-icp builders/signer — the sanctioned golden
// generation path. These prove the wasm marshaling layer (string parse → builder → bytes)
// returns byte-identical DIDL/CBOR to Rust, and the error-contract checks pin the two
// 2026-08-20 correctness fixes (u128→u64 expires wrap; swallowed read_state decode errors).
{
  const OWNER = 'mxzaz-hqaaa-aaaar-qaada-cai'; // real ckBTC ledger principal (stable)
  const TRANSFER_ARG_HEX = '4449444c066c06fbca0101c6fcb60204ba89e5c20402a2de94eb060282f3f3910c05d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e780100010a000000000230000601010120abababababababababababababababababababababababababababababababab01904e0104deadbeef0120cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00d295fcf1e49df8b9c3edbfc8ee31';
  const APPROVE_ARG_HEX = '4449444c066c08c6fcb60201ba89e5c20402a2de94eb060282f3f3910c04d8a38ca80d7d919c9cbf0d01dea7f7da0d04cb96dcb40e056e7d6e036d7b6e786c02b3b0dac30368ad86ca8305020100010a000120cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00ffffffffffffffffffffffffffffffffffff03012a0100b8186dbce2fa18010a000000000230000601010120efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef';
  const SIGN_ENV_HEX = 'd9d9f7a367636f6e74656e74a66c726571756573745f747970656463616c6c6e696e67726573735f6578706972791b18fae2bc6d18b8006673656e646572581d8063a4d954534c765fe2ffc1a1eca87da3a49ecef29d774aef160a31026b63616e69737465725f69644a000000000230000601016b6d6574686f645f6e616d656e69637263315f7472616e736665726361726758a84449444c066c06fbca0101c6fcb60204ba89e5c20402a2de94eb060282f3f3910c05d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e780100010a000000000230000601010120abababababababababababababababababababababababababababababababab01904e0104deadbeef0120cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00d295fcf1e49df8b9c3edbfc8ee316d73656e6465725f7075626b6579582c302a300506032b6570032100248acbdbaf9e050196de704bea2d68770e519150d103b587dae2d9cad53dd9306a73656e6465725f73696758406b4449e37093d8d16926035cbdf2e6f0b2d47ed422684ae1274ebafb97ccfeb6bddead475e5a5939bf66164798a159da1b843950644f847f73f3e99e4c45930c';
  const SIGN_RID_HEX = '3d83e7a3f67257803e762223224a95d6e3e15191876ebd29a37202a7c4f18ddb';
  const CAP = 4096;
  const sl = s => enc.encode(s).length;

  // w_icp_transfer_arg: to = OWNER+'ab'×32, from_sub = 'cd'×32, u128-scale amount, fee, memo.
  // (subaccounts/memo cross the wire as hex TEXT — the export's hex_at parses them.)
  {
    const out = ex.w_alloc(CAP);
    const n = ex.w_icp_transfer_arg(
      writeStr(OWNER), sl(OWNER),
      writeStr('ab'.repeat(32)), sl('ab'.repeat(32)),
      writeStr('cd'.repeat(32)), sl('cd'.repeat(32)),
      writeStr('123456789012345678901234567890'), sl('123456789012345678901234567890'),
      writeStr('10000'), sl('10000'),
      writeStr('deadbeef'), sl('deadbeef'),
      out, CAP);
    const got = n > 0 ? hex(readBytes(out, n)) : '';
    check('w_icp_transfer_arg(golden inputs) == dpay-icp transfer_arg hex',
      n > 0 && got === TRANSFER_ARG_HEX,
      `n=${n}\n    got:  ${got}\n    want: ${TRANSFER_ARG_HEX}`);
  }

  // w_icp_approve_arg: spender = OWNER+'ef'×32, from_sub = 'cd'×32, amount = u128::MAX,
  // expected = 42, expires fixed, memo none, fee 10.
  const approveCall = (amount, expected, expires, fee) => {
    const out = ex.w_alloc(CAP);
    const n = ex.w_icp_approve_arg(
      writeStr(OWNER), sl(OWNER),
      writeStr('ef'.repeat(32)), sl('ef'.repeat(32)),
      writeStr('cd'.repeat(32)), sl('cd'.repeat(32)),
      writeStr(amount), sl(amount),
      writeStr(expected), sl(expected),
      writeStr(expires), sl(expires),
      writeStr(''), 0,
      writeStr(fee), sl(fee),
      out, CAP);
    return [n, out];
  };
  {
    const [n, out] = approveCall('340282366920938463463374607431768211455', '42', '1800000300000000000', '10');
    const got = n > 0 ? hex(readBytes(out, n)) : '';
    check('w_icp_approve_arg(golden inputs) == dpay-icp approve_arg hex',
      n > 0 && got === APPROVE_ARG_HEX,
      `n=${n}\n    got:  ${got}\n    want: ${APPROVE_ARG_HEX}`);
    // THE u128→u64 wrap regression (2026-08-20): 2^64 must ERROR, never wrap mod 2^64.
    check('w_icp_approve_arg(expires = 2^64) == BAD_UTF8(2) — no silent u64 wrap',
      approveCall('1', '', '18446744073709551616', '')[0] === 2);
    // Boundary: u64::MAX is the largest LEGAL expiry and still builds (returns arg length,
    // not an error status — statuses are 0..3, real args here are 150+ bytes).
    check('w_icp_approve_arg(expires = u64::MAX) still builds',
      approveCall('1', '', '18446744073709551615', '')[0] > 3);
  }

  // w_icp_sign_update over the transfer-arg golden bytes → exact envelope hex; the envelope's
  // request_id (via w_icp_envelope_request_id) must equal the Rust-derived golden rid.
  {
    const out = ex.w_alloc(CAP);
    const n = ex.w_icp_sign_update(
      writeBytes(SEED),
      writeStr(OWNER), sl(OWNER),
      writeStr('icrc1_transfer'), sl('icrc1_transfer'),
      writeBytes(fromHex(TRANSFER_ARG_HEX)), TRANSFER_ARG_HEX.length / 2,
      writeStr('1800000300000000000'), sl('1800000300000000000'),
      out, CAP);
    const env = n > 0 ? readBytes(out, n) : new Uint8Array();
    check('w_icp_sign_update(golden inputs) == dpay-icp sign_update envelope hex',
      n > 0 && hex(env) === SIGN_ENV_HEX,
      `n=${n}\n    got:  ${hex(env).slice(0, 320)}${hex(env).length > 320 ? '…' : ''}\n    want: ${SIGN_ENV_HEX.slice(0, 320)}…`);
    const rid = ex.w_alloc(32);
    const rc = ex.w_icp_envelope_request_id(writeBytes(env), n, rid);
    check('w_icp_envelope_request_id(signed envelope) == golden request_id hex',
      rc === 0 && hex(readBytes(rid, 32)) === SIGN_RID_HEX,
      `rc=${rc} got=${hex(readBytes(rid, 32))}`);
  }

  // Malformed read_state cert must ERROR (BAD_UTF8), never a fabricated unknown-pending JSON
  // (the 2026-08-20 swallowed-decode-error fix — the web wallet surfaces the poll error).
  check('w_icp_decode_read_state(malformed cert) == BAD_UTF8(2)',
    ex.w_icp_decode_read_state(writeBytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), 4,
      ex.w_alloc(32 * 8), 0, ex.w_alloc(CAP), CAP) === 2);
}

// --- verdict ------------------------------------------------------------------------------------
if (failures) {
  console.error(`\nFAIL: dpay-core.wasm drifted from the trusted oracle in ${failures}/${checks} check(s).`);
  console.error('The staged web core would NOT sign the same bytes as Android. Fix crates/dpay-wasm, then `just wasm`.');
  process.exit(1);
}
console.log(`wasm-core parity OK: staged dpay-core.wasm == e2e/harness/wire.mjs across ${checks} checks (layout, request build+decode, sign, withdraw u64-stress, receipt verify, receipt-claim build, icp census+arg/sign goldens)`);
