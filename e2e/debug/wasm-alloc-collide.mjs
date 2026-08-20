// wasm-alloc-collide — pure-Node deterministic allocator-collision regression (the mechanism
// proof behind the 2026-08-20 "wasm dual-allocator corruption" OPEN BUG, closed the same day).
//
// Invariant under test: the staged wasm core must have exactly ONE allocator over its linear
// memory. The default Rust wasm allocator (dlmalloc) manages the SAME arena `w_alloc` hands to
// JS: dlmalloc's sbrk (memory.grow) bases its chunks at the old memory top and reuses freed
// chunks — both can land on regions `w_alloc` already handed out, so a Rust-side allocation
// (an envelope String, a JSON builder's Vec) overwrites a LIVE JS input buffer mid-call
// (BAD_UTF8 on valid input) or pattern bytes stomp dlmalloc's free-list metadata
// (memory access out of bounds traps).
//
// Fully synchronous — no concurrency, no jitter: the collision is allocator-vs-allocator,
// not JS-vs-JS (that's why the browser hammer failed deterministically at #281 while a
// Node interleaved repro of the same JS call shape passed).
//
//   OLD artifact (dual allocator): RED — patterns corrupted (or a trap) within the first rounds.
//   NEW artifact (unified bump):   GREEN — Rust temps allocate ABOVE every pattern chunk.
//
// Run on any allocator / memory-plumbing change to dpay-wasm:
//   node e2e/debug/wasm-alloc-collide.mjs [path-to-wasm]
import { readFileSync } from 'node:fs';

const wasmPath =
  process.argv[2] ?? new URL('../../crates/dpay-relay/assets/dpay-core.wasm', import.meta.url).pathname;
const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;
const pages = () => ex.memory.buffer.byteLength / 65536;

const view = () => new Uint8Array(ex.memory.buffer);
const put = (b) => {
  const p = ex.w_alloc(b.length);
  if (p === 0) throw new Error('w_alloc OOM');
  view().set(b, p);
  return p;
};
const putStr = (s) => {
  const b = new TextEncoder().encode(s);
  return [put(b), b.length];
};

// Boot exactly like the app shim (e2e/web/dpay-core-wasm.ts) does: w_layout_json allocates
// Rust-side Strings on first use — on the buggy build this initialized dlmalloc's arena at the
// old memory top, right where w_alloc's cursor was about to march through.
{
  const out = ex.w_alloc(8192);
  const len = ex.w_layout_json(out, 8192);
  if (len === 0 || len > 8192) throw new Error('w_layout_json failed at boot');
}

// A signed envelope (sign_update allocates the ~400B envelope String Rust-side — the exact
// allocation shape that landed on a live input buffer in the production evidence).
const seed = new Uint8Array(32).fill(3);
const seedP = put(seed);
const canister = putStr('rrkah-fqaaa-aaaaa-aaaaq-cai');
const method = putStr('icrc1_transfer');
const argP = put(new Uint8Array(64).fill(0x44));
const expiry = putStr('4102444800000000000');
const envOut = ex.w_alloc(2048);
const envLen = ex.w_icp_sign_update(seedP, canister[0], canister[1], method[0], method[1], argP, 64, expiry[0], expiry[1], envOut, 2048);
if (envLen === 0 || envLen > 2048) throw new Error(`w_icp_sign_update failed at boot (len=${envLen})`);
const env = view().slice(envOut, envOut + envLen);

// Reserve a wide pattern region past the boot footprint: 512 KB of 4 KB chunks, each filled
// with a per-chunk byte pattern. On the buggy build this marches the w_alloc cursor straight
// through dlmalloc's arena (stomping its free chunks); on the fixed build the region is simply
// ordinary bump memory below every future allocation.
const CHUNK = 4096;
const CHUNKS = 128;
const chunks = [];
for (let i = 0; i < CHUNKS; i++) {
  const p = ex.w_alloc(CHUNK);
  if (p === 0) throw new Error(`w_alloc OOM at chunk ${i}`);
  view().fill((i * 7) & 0xff, p, p + CHUNK);
  chunks.push({ p, pat: (i * 7) & 0xff });
}
const check = () => {
  const v = view();
  for (const { p, pat } of chunks) {
    for (let o = 0; o < CHUNK; o += 16) {
      if (v[p + o] !== pat) return `offset ${p + o}: got ${v[p + o]} want ${pat}`;
    }
  }
  return null;
};

// Hammer Rust-side allocation: each call below allocates Strings/Vecs INSIDE the module. On the
// buggy build dlmalloc reuses/splits free chunks inside the pattern region (or dies on the
// stomped metadata) within the first rounds. A BAD_UTF8 from envelope_request_id is the exact
// production symptom — its 395B input buffer got overwritten mid-call.
const ROUNDS = 200;
let first = null;
let round = -1;
try {
  for (round = 0; round < ROUNDS; round++) {
    const outP = ex.w_alloc(128);
    if (ex.w_icp_self_principal(seedP, outP, 128) === 0) throw new Error('self_principal failed');
    const envP = put(env);
    const ridOut = ex.w_alloc(32);
    const st = ex.w_icp_envelope_request_id(envP, env.length, ridOut);
    if (st !== 0) throw new Error(`envelope_request_id status ${st} (BAD_UTF8 on valid input = the production symptom)`);
    const jOut = ex.w_alloc(8192);
    if (ex.w_layout_json(jOut, 8192) === 0) throw new Error('layout_json failed in loop');
    first = check();
    if (first) break;
  }
} catch (e) {
  console.error(`ALLOC-COLLIDE: FAIL at round ${round} — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
if (first) {
  console.error(`ALLOC-COLLIDE: FAIL at round ${round} — pattern corruption at ${first} (second allocator wrote over live w_alloc regions)`);
  process.exit(1);
}
console.error(
  `ALLOC-COLLIDE: PASS — ${ROUNDS} rounds × 3 allocating exports, ${(CHUNKS * CHUNK) / 1024} KB patterns intact, memory ${pages()} pages`,
);
