/**
 * THE RPC FAILOVER PROOFS UNDER THE SKIP-PREFLIGHT BROADCAST POSTURE (2026-09-21).
 *
 * The live history: the derived head (the relay's Solana proxy fronting Helius) answered the
 * broadcast with HTTP 200 + a JSON-RPC error object carrying the BARE "Blockhash not found"
 * message, 9+ consecutive attempts (#5/#6/#8) — while a byte-exact replay of the SAME signed
 * transaction to https://api.mainnet-beta.solana.com was ACCEPTED and FINALIZED (sig 5HCV…,
 * slot 449148468): the bytes were always valid; the head's send-preflight STATE was at fault.
 * THE POSTURE FIX: the payment seam (`broadcastSignedWithFreshBlockhash`) now broadcasts with
 * `skipPreflight: true, maxRetries: 0` — the provider's preflight simulation layer is bypassed
 * entirely and the chain is the referee — and the attempt-#5 blockhash-refresh-retry (plus the
 * `refused twice` class + copy) is RETIRED: its safety proof ("a preflight refusal is dropped
 * BEFORE acceptance") lived in the simulation layer skipPreflight removes, so no re-sign path
 * remains in the seam.
 *
 * The proofs, OFFLINE over recorded per-URL JSON-RPC fetch mocks in the solana-seam.test.ts
 * style — no @solana/*, no network:
 *   (a) a blockhash-shaped refusal (defensive parity — no layer should emit one under
 *       skipPreflight, the walk stays armed) → the SAME signed bytes replay down the list in
 *       deterministic order → the public tail accepts; every payload carries skipPreflight +
 *       maxRetries: 0; tracer shows `rpc-failover`; ONE blockhash fetch, ONE sign, NO refresh;
 *   (b) every candidate refuses → the walk EXHAUSTS on the unanimous refusal → the seam
 *       surfaces it VERBATIM: exactly one walk, ONE sign, nothing accepted, no refresh;
 *   (b2) transport death on EVERY candidate → the last transport error, honest, one sign,
 *       zero acceptances;
 *   (b3) accepted then FAILED on-chain → the definite `transaction failed:` class (the chain
 *       is the referee; classification intact);
 *   (c) a preflight-shaped simulation refusal is the ANSWERING NODE's opinion, not a verdict
 *       on the bytes — the SAME signed bytes walk to the next candidate (no refresh, no
 *       re-sign); a genuine byte-verdict refuses in place at the first venue (a genuinely
 *       invalid tx would be refused everywhere);
 *   (d) the candidate list + order pin: derived = relay homes in order then the public tail;
 *       the operator/test overrides and a devnet-shaped derivation stay single-homed.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {isEndpointRefusal} from '../solana/errors';

const realFetch = globalThis.fetch;

const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const MERCHANT_ADDRESS = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'; // the attempt-#6 live mint
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// The derived world the driver installs: two relay homes + the constant public tail.
const RELAY_BASES = ['https://a.example', 'https://b.example'];
const A = 'https://a.example/api/v1/solana/rpc';
const B = 'https://b.example/api/v1/solana/rpc';
const PUBLIC = 'https://api.mainnet-beta.solana.com';

const BH_REFUSAL = {code: -32002, message: 'Blockhash not found'}; // the live 2xx-wrapped shape
const IX_REFUSAL = {code: -32002, message: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1'}; // preflight-shaped — the node's opinion, walk-worthy
const IX_VERDICT = {code: -32002, message: 'ExecutionCustom error: invalid instruction data'}; // a verdict on the bytes — refused everywhere, never walked

/** One recorded JSON-RPC POST: URL + method + the exact wire body. */
interface Call {url: string; method: string; body: string}

/** A route: a fixed JSON-RPC response piece, or a per-call chooser over the record so far. */
type Route = {result: unknown} | {error: {code: number; message: string}} | ((recorded: Call[]) => Route);

const resolveRoute = (route: Route, recorded: Call[]): {result: unknown} | {error: {code: number; message: string}} =>
  typeof route === 'function' ? resolveRoute(route(recorded), recorded) : route;

/** Install a per-URL, per-METHOD fetch mock. Records every call (url, method, raw body) so the
 *  tests can pin order, byte-identity and method counts. An unrouted request fails loud. */
function installRpc(table: Record<string, Record<string, Route>>): Call[] {
  const recorded: Call[] = [];
  globalThis.fetch = (async (url: unknown, init?: {body?: string}) => {
    const u = String(url);
    const req = JSON.parse(String(init?.body)) as {id: number; method: string};
    recorded.push({url: u, method: req.method, body: String(init?.body)});
    const route = table[u]?.[req.method];
    if (route === undefined) throw new Error(`unexpected fetch: ${req.method} → ${u}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({jsonrpc: '2.0', id: req.id, ...resolveRoute(route, recorded)}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return recorded;
}

// --- shared answer pieces -----------------------------------------------------
const BH_OK = {result: {context: {slot: 449_102_443}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 427_143_204}}};
const SIG_OK = {result: '5HCVuLRvNDgBddqHybKvB3bTNRUiv9JE2vFYK97ZyLWTy5aQ92HGHZ1SUkxkWNtgksVuWDmJ13Y1BtbxViLx11is'};
const CONFIRM_OK = {result: {value: [{confirmationStatus: 'finalized', err: null}]}};
/** The attempt-#6 pre-broadcast world: sender ATA exists, the venue's fresh deposit ATA is
 *  missing (createIdempotent joins the transfer), SOL covers rent+fee. */
const ATA_CHECKS: Route = (recorded) => {
  const n = recorded.filter(c => c.method === 'getAccountInfo').length;
  return n === 1
    ? {result: {value: {data: ['', 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280}}}
    : {result: {value: null}};
};
/** Reads + blockhash + confirm all answer cleanly at `url` (any method except sendTransaction). */
const headThatServesReads = (sendRoute: Route): Record<string, Route> => ({
  getAccountInfo: ATA_CHECKS,
  getBalance: {result: {value: 1_000_000_000}},
  getLatestBlockhash: BH_OK,
  getSignatureStatuses: CONFIRM_OK,
  sendTransaction: sendRoute,
});

const sendCalls = (calls: Call[]): Call[] => calls.filter(c => c.method === 'sendTransaction');
const bhCalls = (calls: Call[]): Call[] => calls.filter(c => c.method === 'getLatestBlockhash');

/** The driver: fresh module registry, jest test override REMOVED (the derived list must be
 *  live), two relay bases wired, the seam required. Mirrors the solana-rpc-config SEAM test. */
async function withDerivedList<T>(run: (solana: typeof import('../solana')) => Promise<T>): Promise<T> {
  const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string};
  const prev = g.__DPAY_TEST_SOLANA_RPC_URL;
  delete g.__DPAY_TEST_SOLANA_RPC_URL;
  let p: Promise<T> | undefined;
  jest.isolateModules(() => {
    const constants = require('../config/constants') as typeof import('../config/constants');
    constants.setRelayBaseForSolana(RELAY_BASES);
    const solana = require('../solana') as typeof import('../solana');
    p = run(solana);
  });
  try {
    return await p!;
  } finally {
    if (prev === undefined) delete g.__DPAY_TEST_SOLANA_RPC_URL;
    else g.__DPAY_TEST_SOLANA_RPC_URL = prev;
  }
}

/** Drive sendSpl at the attempt-#6 shape (EURC to a fresh venue deposit address). */
const sendEurc = (solana: typeof import('../solana'), venue: string, amount: bigint): Promise<string> =>
  (solana.sendSpl as (s: string, d: string, a: bigint, m: string) => Promise<string>)(SEED_HEX, venue, amount, EURC_MINT);

const warnLines = (spy: jest.Spied<typeof console.warn>): string[] => spy.mock.calls.map(c => String(c[0]));
const stepLines = (lines: string[]): string[] =>
  lines.filter(l => l.startsWith('money: sol send step ')).map(l => l.slice('money: sol send step '.length));

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('proof (a): a blockhash-shaped refusal (defensive parity) → SAME bytes walk → public tail accepts', () => {
  test('walk order a → b → public, byte-identical bodies, ONE blockhash fetch, ONE sign, rpc-failover traced', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Reads (ATA/balance pre-checks + blockhash fetch + confirm) walk the READ list → A answers.
    // The BROADCAST walk: A refuses the blockhash state (the live head), B refuses it too, and
    // the PUBLIC tail — the endpoint that accepted the live replay — takes the SAME bytes.
    const recorded = installRpc({
      [A]: headThatServesReads({error: BH_REFUSAL}),
      [B]: {sendTransaction: {error: BH_REFUSAL}},
      [PUBLIC]: {sendTransaction: SIG_OK},
    });
    const sig = await withDerivedList(solana => sendEurc(solana, MERCHANT_ADDRESS, 8_800_000n));
    expect(sig).toBe(SIG_OK.result);
    // THE WALK: A refused, B refused, PUBLIC accepted — deterministic order, no skips, and the
    // pre-check/confirm reads stayed on the read list at A.
    expect(recorded.map(c => `${c.url} ${c.method}`)).toEqual([
      `${A} getAccountInfo`, // sender ATA
      `${A} getAccountInfo`, // venue ATA (missing → createIdempotent joins)
      `${A} getBalance`, // rent pre-check
      `${A} getLatestBlockhash`, // ONE fetch — the seam never re-fetched
      `${A} sendTransaction`, // the live refusal
      `${B} sendTransaction`, // walked, SAME bytes
      `${PUBLIC} sendTransaction`, // walked, SAME bytes — accepted (the live replay, replayed)
      `${A} getSignatureStatuses`, // confirm at the read list, as ever
    ]);
    // Byte-identical signed bodies at every candidate — ONE signature, replayed verbatim (the
    // exact live-proof property: the signature is valid on any endpoint).
    const sends = sendCalls(recorded);
    expect(sends).toHaveLength(3);
    expect(sends[1].body).toBe(sends[0].body);
    expect(sends[2].body).toBe(sends[0].body);
    // THE POSTURE ON THE WIRE: every candidate received skipPreflight (the broken preflight
    // layer bypassed) + maxRetries: 0 (retry policy app-owned).
    const wire = JSON.parse(sends[0].body) as {params: unknown[]};
    expect(wire.params[1]).toEqual({encoding: 'base64', skipPreflight: true, maxRetries: 0});
    // ONE sign: one blockhash fetch, no refresh — nothing re-signs anywhere in the walk.
    expect(bhCalls(recorded)).toHaveLength(1);
    // THE TRACER: the walk's advances are on the money log, in order, hosts only (no
    // key-bearing URL ever prints).
    const steps = stepLines(warnLines(warn));
    expect(steps).toEqual([
      'sender-ata-check',
      'recipient-ata-check',
      'sender-balance-check',
      'blockhash',
      'sign',
      'broadcast',
      'rpc-failover a.example → b.example (blockhash-not-found)',
      'rpc-failover b.example → api.mainnet-beta.solana.com (blockhash-not-found)',
      'confirm',
    ]);
    expect(warnLines(warn).some(l => /BROADCAST accepted sig=5HCVuLRv/.test(l))).toBe(true);
    warn.mockRestore();
  });
});

describe('proof (b): every candidate refuses → the walk exhausts on the UNANIMOUS refusal → the seam surfaces it verbatim', () => {
  test('one walk a → b → public, exactly ONE sign, nothing accepted, no refresh, the refusal + its brand honest', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const recorded = installRpc({
      [A]: headThatServesReads({error: BH_REFUSAL}),
      [B]: {sendTransaction: {error: BH_REFUSAL}},
      [PUBLIC]: {sendTransaction: {error: BH_REFUSAL}}, // even the tail refuses
    });
    let refusedBrand = false;
    await expect(withDerivedList(async solana => {
      try {
        return await sendEurc(solana, MERCHANT_ADDRESS, 8_800_000n);
      } catch (e) {
        refusedBrand = isEndpointRefusal(e);
        throw e;
      }
    })).rejects.toThrow(/sendTransaction → a\.example: Blockhash not found$/);
    expect(refusedBrand).toBe(true); // the answering node's verdict, branded as a refusal
    // ONE walk of the list, in order — the seam STOPPED there (the refresh is retired; a
    // re-sign under skipPreflight has no dropped-before-acceptance proof).
    expect(sendCalls(recorded).map(c => c.url)).toEqual([A, B, PUBLIC]);
    // Exactly ONE blockhash fetch/sign. Nothing was ever accepted — the honest outcome.
    expect(bhCalls(recorded)).toHaveLength(1);
    // Pre-checks ran ONCE: sender ATA + recipient ATA — no refresh's second pair.
    expect(recorded.filter(c => c.method === 'getAccountInfo')).toHaveLength(2);
    expect(warnLines(warn).some(l => /BROADCAST accepted/.test(l))).toBe(false);
    // The tracer tells the single walk; no refresh step exists anymore.
    expect(stepLines(warnLines(warn))).toEqual([
      'sender-ata-check', 'recipient-ata-check', 'sender-balance-check',
      'blockhash', 'sign', 'broadcast',
      'rpc-failover a.example → b.example (blockhash-not-found)',
      'rpc-failover b.example → api.mainnet-beta.solana.com (blockhash-not-found)',
    ]);
    expect(warnLines(warn).some(l => /FAILED at step=broadcast: solana rpc sendTransaction/.test(l))).toBe(true);
    warn.mockRestore();
  });
});

describe('proof (b2): transport death on EVERY candidate → the last transport error, honest, zero acceptances', () => {
  test('the walk exhausts transport-dead, one sign, no refresh, the seam rethrows the transport truth', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Reads answer at A (the pre-checks + blockhash are reads); every sendTransaction attempt
    // dies at the fetch — the walk-worthy class that remains under skipPreflight.
    const sends: string[] = [];
    let ataChecks = 0;
    globalThis.fetch = (async (url: unknown, init?: {body?: string}) => {
      const u = String(url);
      const req = JSON.parse(String(init?.body)) as {method: string};
      if (req.method === 'sendTransaction') {
        sends.push(u);
        throw new TypeError('fetch failed');
      }
      if (u !== A) throw new Error(`unexpected read fetch: ${req.method} → ${u}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({jsonrpc: '2.0', id: 1, result:
          req.method === 'getLatestBlockhash'
            ? {context: {slot: 449_102_443}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 427_143_204}}
            : req.method === 'getAccountInfo'
              ? {value: ++ataChecks === 1
                ? {data: ['', 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280} // sender ATA exists
                : null} // recipient ATA missing → createIdempotent joins
              : {value: 1_000_000_000}, // getBalance covers rent+fee
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(withDerivedList(solana => sendEurc(solana, MERCHANT_ADDRESS, 8_800_000n)))
      .rejects.toThrow('fetch failed'); // the LAST transport error, verbatim — R3's oracle case
    // Every candidate was tried with the same bytes; nothing answered; nothing was accepted.
    expect(sends).toEqual([A, B, PUBLIC]);
    expect(warnLines(warn).some(l => /BROADCAST accepted/.test(l))).toBe(false);
    expect(stepLines(warnLines(warn))).toEqual([
      'sender-ata-check', 'recipient-ata-check', 'sender-balance-check',
      'blockhash', 'sign', 'broadcast',
      'rpc-failover a.example → b.example (transport)',
      'rpc-failover b.example → api.mainnet-beta.solana.com (transport)',
    ]);
    warn.mockRestore();
  });
});

describe('proof (b3): accepted then FAILED on-chain → the definite transaction-failed class (the chain is the referee)', () => {
  test('the tail accepts, the status poll reports err, the definite class surfaces — classification intact', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const CHAIN_FAIL = {result: {value: [{confirmationStatus: 'confirmed', err: {InstructionError: [0, {Custom: 1}]}}]}};
    const recorded = installRpc({
      // The confirm poll rides the READ list, so A carries the chain's verdict; the broadcast
      // walk lands on the public tail (the live replay shape).
      [A]: {...headThatServesReads({error: BH_REFUSAL}), getSignatureStatuses: CHAIN_FAIL},
      [B]: {sendTransaction: {error: BH_REFUSAL}},
      [PUBLIC]: {sendTransaction: SIG_OK},
    });
    let raw = '';
    await expect(withDerivedList(async solana => {
      try {
        return await sendEurc(solana, MERCHANT_ADDRESS, 8_800_000n);
      } catch (e) {
        raw = e instanceof Error ? e.message : String(e);
        throw e;
      }
    })).rejects.toThrow(/^transaction failed: /);
    // The definite class: the network INCLUDED the tx and failed it — never the honest-unknown
    // timeout story, never a re-send.
    const {isSolTransactionFailed} = require('../solana/errors') as {isSolTransactionFailed: (m: string) => boolean};
    expect(isSolTransactionFailed(raw)).toBe(true);
    expect(sendCalls(recorded).map(c => c.url)).toEqual([A, B, PUBLIC]); // the walk, once
    expect(bhCalls(recorded)).toHaveLength(1);
    expect(warnLines(warn).some(l => /BROADCAST accepted sig=5HCVuLRv/.test(l))).toBe(true);
    expect(warnLines(warn).some(l => /FAILED at step=confirm: transaction failed:/.test(l))).toBe(true);
    warn.mockRestore();
  });
});

describe("proof (c): a preflight simulation refusal is the node's opinion, not the bytes — the walk answers", () => {
  test("B accepts the SAME signed bytes after the head's preflight refusal — one sign, one blockhash, no refresh", async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const recorded = installRpc({
      [A]: headThatServesReads({error: IX_REFUSAL}), // the head's simulation layer speaks
      [B]: {sendTransaction: SIG_OK}, // the next home takes the SAME bytes
      [PUBLIC]: {sendTransaction: SIG_OK}, // never consulted — B answered
    });
    const sig = await withDerivedList(solana => sendEurc(solana, MERCHANT_ADDRESS, 8_800_000n));
    expect(sig).toBe(SIG_OK.result);
    // THE WALK: A's preflight refusal, B accepted — deterministic order, and the
    // pre-check/confirm reads stayed on the read list at A.
    expect(recorded.map(c => `${c.url} ${c.method}`)).toEqual([
      `${A} getAccountInfo`, // sender ATA
      `${A} getAccountInfo`, // venue ATA (missing → createIdempotent joins)
      `${A} getBalance`, // rent pre-check
      `${A} getLatestBlockhash`, // ONE fetch — the seam never re-fetched
      `${A} sendTransaction`, // the preflight refusal
      `${B} sendTransaction`, // walked, SAME bytes — accepted
      `${A} getSignatureStatuses`, // confirm at the read list, as ever
    ]);
    // Byte-identical signed bodies — ONE signature, replayed verbatim (no re-sign anywhere).
    const sends = sendCalls(recorded);
    expect(sends).toHaveLength(2);
    expect(sends[1].body).toBe(sends[0].body);
    expect(bhCalls(recorded)).toHaveLength(1);
    // The tracer tells the single walk; no refresh step exists.
    expect(stepLines(warnLines(warn))).toEqual([
      'sender-ata-check', 'recipient-ata-check', 'sender-balance-check',
      'blockhash', 'sign', 'broadcast',
      'rpc-failover a.example → b.example (blockhash-not-found)',
      'confirm',
    ]);
    expect(warnLines(warn).some(l => /BROADCAST accepted sig=5HCVuLRv/.test(l))).toBe(true);
    warn.mockRestore();
  });

  test('a genuine byte-verdict refuses in place at the first venue — B and PUBLIC never consulted, the venue message surfaces', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const recorded = installRpc({
      [A]: headThatServesReads({error: IX_VERDICT}), // a verdict on the tx itself
      [B]: {sendTransaction: {error: IX_VERDICT}}, // MUST never be consulted
      [PUBLIC]: {sendTransaction: {error: IX_VERDICT}}, // MUST never be consulted
    });
    let refusedBrand = false;
    await expect(withDerivedList(async solana => {
      try {
        return await sendEurc(solana, MERCHANT_ADDRESS, 8_800_000n);
      } catch (e) {
        refusedBrand = isEndpointRefusal(e);
        throw e;
      }
    })).rejects.toThrow(/invalid instruction data/);
    expect(refusedBrand).toBe(true);
    // ONE venue consulted for the broadcast — the walk never swallows a genuine byte-verdict,
    // and the seam never refreshed.
    expect(sendCalls(recorded).map(c => c.url)).toEqual([A]);
    expect(bhCalls(recorded)).toHaveLength(1);
    expect(stepLines(warnLines(warn))).toEqual([
      'sender-ata-check', 'recipient-ata-check', 'sender-balance-check',
      'blockhash', 'sign', 'broadcast',
    ]);
    expect(warnLines(warn).every(l => !l.includes('rpc-failover'))).toBe(true);
    warn.mockRestore();
  });
});

// ============================================================================
// (d) The candidate list + order pin. The constant, the derivation, the override slots that
// must stay single-homed, and the devnet guard — config-level, fresh registries, no network.
// ============================================================================

// ============================================================================
// (e/f) THE HANG BOUNDS (2026-09 stream D pins, extending the audit table in `solana.ts`'s
// header). Every await on the send path answers to exactly one deadline; these two pin the
// bounds that live OUTSIDE the sheet's 60s withTimeout:
//   (e) the module load's own bound (`loadRpcForSend`) — expiry throws the engine-load class
//       (friendlySolError → M.sol.engineLoad), never an unbounded wait on the lazy chunk;
//   (f) the confirm loop's own bound (`confirmTransaction`) — the poll throws at its deadline,
//       which is what turns "the chain never answered" into the sheet's honest unknown.
// ============================================================================

describe('the hang bounds: module-load deadline and confirm-loop deadline', () => {
  test('(e) loadRpcForSend expiry throws the engine-load class — the lazy chunk can never hang a send', async () => {
    const {loadRpcForSend} = require('../solana') as typeof import('../solana');
    const {friendlySolError} = require('../solana/errors') as typeof import('../solana/errors');
    const {M} = require('../i18n') as typeof import('../i18n');
    // A chunk that never arrives (the stalled origin fetch of the 2026-09-21 live sends) against
    // a short injected deadline: the race must REJECT, with the message the classifier maps to
    // the engine-load copy ("check your connection, reopen, retry"), not a silent hang.
    const never = (): Promise<never> => new Promise(() => {});
    let raw = '';
    await expect(loadRpcForSend(20, never).catch((err: unknown) => {
      raw = err instanceof Error ? err.message : String(err);
      throw err;
    })).rejects.toThrow(/rpc module failed to load within 20ms/);
    expect(friendlySolError(raw)).toBe(M.sol.engineLoad);
  });

  test('(f) confirmTransaction throws at its deadline — the poll is bounded, never a forever loop', async () => {
    const rpc = require('../solana/rpc') as typeof import('../solana/rpc');
    // A cluster that has never heard of the signature, answering `[null]` forever (exactly the
    // shape the relay's offline stub serves by default). The loop must end at the deadline with
    // its honest timeout — the caller (sheet → unknown) owns the story from there.
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: Record<string, unknown>};
    g.__DPAY_TEST_SOLANA_RPC_STUB = {
      getSignatureStatuses: () => ({context: {slot: 1}, value: [null]}),
    };
    try {
      await expect(rpc.confirmTransaction(['https://stub.test'], SIG_OK.result, {timeoutMs: 80, pollMs: 10}))
        .rejects.toThrow('solana confirmation timeout');
    } finally {
      delete g.__DPAY_TEST_SOLANA_RPC_STUB;
    }
  });
});

// ============================================================================
// (d) The candidate list + order pin. The constant, the derivation, the override slots that
// must stay single-homed, and the devnet guard — config-level, fresh registries, no network.
// ============================================================================

/** Fresh constants module (its operator/relay slots are module state), jest override `baked`. */
function freshConfig(baked?: string): typeof import('../config/constants') {
  const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string};
  const prev = g.__DPAY_TEST_SOLANA_RPC_URL;
  let mod!: typeof import('../config/constants');
  jest.isolateModules(() => {
    if (baked === undefined) delete g.__DPAY_TEST_SOLANA_RPC_URL;
    else g.__DPAY_TEST_SOLANA_RPC_URL = baked;
    mod = require('../config/constants');
  });
  if (prev === undefined) delete g.__DPAY_TEST_SOLANA_RPC_URL;
  else g.__DPAY_TEST_SOLANA_RPC_URL = prev;
  return mod;
}

describe('proof (d): the broadcast candidate list — deterministic head + public tail', () => {
  test('the tail is the public mainnet endpoint, exported and constant', () => {
    const c = freshConfig();
    expect(c.SOLANA_RPC_PUBLIC_FAILOVER_URL).toBe('https://api.mainnet-beta.solana.com');
  });

  test('derived: relay homes in list order, then the tail, always LAST — reads stay tail-free', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana(['https://second.example', 'https://first.example']);
    expect(c.solanaBroadcastRpcUrls()).toEqual([
      'https://second.example/api/v1/solana/rpc',
      'https://first.example/api/v1/solana/rpc',
      'https://api.mainnet-beta.solana.com',
    ]);
    // The READ list is untouched — the tail is broadcast-only (the 2.5s poll must not burn
    // the public quota the money path may need in the same minute).
    expect(c.solanaRpcUrls()).toEqual([
      'https://second.example/api/v1/solana/rpc',
      'https://first.example/api/v1/solana/rpc',
    ]);
  });

  test('the operator override stays a SINGLE home — the operator removed every default', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana(['https://a.example', 'https://b.example']);
    c.setSolanaRpcUrl('https://operator.example/?api-key=theirs');
    expect(c.solanaBroadcastRpcUrls()).toEqual(['https://operator.example/?api-key=theirs']);
  });

  test('the jest/e2e test override stays a SINGLE home — the offline contract never touches the internet', () => {
    const c = freshConfig('https://stub.example');
    c.setRelayBaseForSolana(['https://a.example', 'https://b.example']);
    expect(c.solanaBroadcastRpcUrls()).toEqual(['https://stub.example']);
    // …and the EMPTY override is still rail-off ('' — the list of one empty string).
    const offline = freshConfig('');
    expect(offline.solanaBroadcastRpcUrls()).toEqual(['']);
  });

  test('a devnet/testnet-shaped derivation stays single-homed — no mainnet endpoint behind a test cluster', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana(['https://devnet-relay.example']);
    expect(c.isSolanaDevnet()).toBe(true);
    expect(c.solanaBroadcastRpcUrls()).toEqual(['https://devnet-relay.example/api/v1/solana/rpc']);
  });
});
