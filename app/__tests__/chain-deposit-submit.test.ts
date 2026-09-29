// THE D32 DEFECT PIN — the chain deposit's broadcast must survive a provider preflight refusal.
//
// The live finding (2026-09-29, two funded-signature attempts, zero value at risk): the chain
// route's frozen deposit bytes were VALID on mainnet (byte-exact rebuild simulated clean through
// ATA-create + SPL transfer), yet the broadcast never landed — `getSignatureStatuses` null with
// history search, rail EURC measured unchanged. Root cause: `submitRawSolTx` ran with preflight
// ON, the relay pipe's provider answered a (broken-layer) SIMULATION refusal, and rpcFetch's
// walk only fired for blockhash-shaped errors — "refused in place, never walked", so the public
// failover tail (the attempt-#6 fix's whole point) was never tried.
//
// This pin reproduces that exact shape OFFLINE (mocked fetch, the jest contract) and holds the
// two halves of the fix:
//   1. the walk: a preflight-shaped JSON-RPC refusal from the head WALKS the same bytes to the
//      next candidate (no re-sign, dedup by signature) — pre-D32-fix code FAILS this pin;
//   2. the posture: the submit reaches the wire with `skipPreflight: true, maxRetries: 0` —
//      the send surface's own founder-approved broadcast posture.
// It also pins the SCOPE: a READ method (getBalance) is never walked on the same refusal — the
// walk is sendTransaction-only, and other JSON-RPC errors still refuse in place.
import {describe, expect, jest, test} from '@jest/globals';

// The live finding's refusal, verbatim shape: a simulation failure with NO blockhash language.
const PREFLIGHT_REFUSAL = {
  jsonrpc: '2.0',
  error: {code: -32002, message: 'Transaction simulation failed: Attempt to debit an account but found no record of it prior to simulation for the transaction [0]'},
};
const OTHER_REFUSAL = {
  jsonrpc: '2.0',
  error: {code: -32002, message: 'ExecutionCustom error: invalid instruction data'},
};

type Call = {url: string; method: string; params: unknown[]};

function freshModuleGraph(opts: {headError: unknown; tailSig: string}): {calls: Call[]} {
  // Fresh module registry with the OFFLINE seam UNSET: the derived broadcast list is
  // [pipe/api/v1/solana/rpc, public mainnet tail] — exactly the live topology.
  const calls: Call[] = [];
  jest.resetModules();
  (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string}).__DPAY_TEST_SOLANA_RPC_URL = undefined as unknown as string;
  const constants = require('../config/constants');
  constants.setRelayBaseForSolana(['https://pipe.example']);
  constants.setSolanaRpcUrl(''); // no operator home: the derived list + public tail stand

  global.fetch = jest.fn(async (url: string, init?: {body?: string}) => {
    let method = '';
    try { method = JSON.parse(init?.body ?? '{}').method; } catch { /* malformed */ }
    calls.push({url, method, params: method === 'sendTransaction' ? JSON.parse(init?.body ?? '{}').params : []});
    if (method === 'sendTransaction') {
      if (url.startsWith('https://pipe.example/')) return {ok: true, status: 200, json: async () => opts.headError};
      return {ok: true, status: 200, json: async () => ({jsonrpc: '2.0', result: opts.tailSig})};
    }
    // Every non-send method (fee quote, status reads) walks nowhere: answer on the first home.
    if (method === 'getLatestBlockhash') {
      return {ok: true, status: 200, json: async () => ({jsonrpc: '2.0', result: {context: {slot: 1}, value: {blockhash: 'GLa3sFc5vE5WPfJAI8BtySFbuqZP4WwseDYEaGhw2EPm', lastValidBlockHeight: 429699999}}})};
    }
    if (method === 'getFeeForMessage') return {ok: true, status: 200, json: async () => ({jsonrpc: '2.0', result: {context: {slot: 1}, value: {lamports: 5000}}})};
    if (method === 'getSignatureStatuses') return {ok: true, status: 200, json: async () => ({jsonrpc: '2.0', result: {context: {slot: 2}, value: [null]}})};
    if (method === 'getBlockHeight') return {ok: true, status: 200, json: async () => ({jsonrpc: '2.0', result: 429600000})};
    return {ok: true, status: 200, json: async () => ({jsonrpc: '2.0', result: null})};
  }) as unknown as typeof fetch;
  return {calls};
}

describe('the chain deposit broadcast survives a provider preflight refusal (the D32 defect)', () => {
  const TAIL_SIG = '58ZqLWjih1eroeDR6BGJPW29U2pq7kTLrwwov1rXTVRWt7yRJ2SW8J5xUB62SUE5Z3xVK85SCrVw2rfZsmyfq8d6';
  const RAW = new Uint8Array(64).fill(7); // arbitrary "signed bytes" — the seam treats them opaquely

  test('walks the same bytes to the public tail on a preflight-shaped refusal and returns the tail signature', async () => {
    const {calls} = freshModuleGraph({headError: PREFLIGHT_REFUSAL, tailSig: TAIL_SIG});
    const sol = require('../solana');
    const sig = await sol.submitRawSolTx(RAW);
    expect(sig).toBe(TAIL_SIG);
    const sends = calls.filter((c) => c.method === 'sendTransaction');
    expect(sends).toHaveLength(2); // head refused → tail answered; one walk, two attempts total
    expect(sends[0]!.url).toContain('pipe.example');
    expect(sends[1]!.url).toBe('https://api.mainnet-beta.solana.com');
    // THE POSTURE: skipPreflight + maxRetries 0 reach the wire on every candidate.
    for (const s of sends) {
      expect(s.params[1]).toMatchObject({encoding: 'base64', skipPreflight: true, maxRetries: 0});
    }
  });

  test('the blockhash-shaped refusal still walks (attempt-#6 regression guard)', async () => {
    const {calls} = freshModuleGraph({
      headError: {jsonrpc: '2.0', error: {code: -32002, message: 'Transaction simulation failed: Blockhash not found'}},
      tailSig: TAIL_SIG,
    });
    const sol = require('../solana');
    await expect(sol.submitRawSolTx(RAW)).resolves.toBe(TAIL_SIG);
    expect(calls.filter((c) => c.method === 'sendTransaction')).toHaveLength(2);
  });

  test('a REAL instruction verdict still refuses in place — the walk never swallows a bad tx', async () => {
    const {calls} = freshModuleGraph({headError: OTHER_REFUSAL, tailSig: TAIL_SIG});
    const sol = require('../solana');
    await expect(sol.submitRawSolTx(RAW)).rejects.toThrow('invalid instruction data');
    expect(calls.filter((c) => c.method === 'sendTransaction')).toHaveLength(1); // no walk for a byte verdict
  });

  test('a READ method is never walked on the same refusal (sendTransaction-only scope)', async () => {
    const {calls} = freshModuleGraph({headError: PREFLIGHT_REFUSAL, tailSig: 'sig'});
    const rpc = require('../solana/rpc');
    await expect(rpc.getBalance(['https://pipe.example/api/v1/solana/rpc'], 'BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX')).rejects.toThrow();
    expect(calls.filter((c) => c.method === 'getBalance')).toHaveLength(1);
  });
});

