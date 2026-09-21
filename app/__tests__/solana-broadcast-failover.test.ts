/**
 * THE ATTEMPT-#6 RPC FAILOVER PROOFS (2026-09-21, EURC→ICP deposit refused 8/8 live).
 *
 * The live root cause: the derived head (the relay's Solana proxy fronting Helius) answered the
 * broadcast with HTTP 200 + a JSON-RPC error object carrying the BARE "Blockhash not found"
 * message, and the walk treated that 2xx as a completed call — so the refusal was final and the
 * candidate list had exactly one entry. A byte-exact replay of the SAME signed transaction to
 * https://api.mainnet-beta.solana.com was ACCEPTED and FINALIZED (sig 5HCV…, slot 449148468):
 * the bytes were always valid; the head's send-preflight STATE was at fault.
 *
 * The fix under test (42d94ac walk + ba9ef4d list), proven OFFLINE over recorded per-URL
 * JSON-RPC fetch mocks in the solana-seam.test.ts style — no @solana/*, no network:
 *   (a) head refuses 2xx-wrapped blockhash-not-found → the SAME signed bytes replay down the
 *       list in deterministic order → the public tail accepts; tracer shows `rpc-failover`;
 *       ONE blockhash fetch, ONE sign, NO refresh;
 *   (b) every candidate refuses → the seam's ONE refresh fires → every candidate refuses again
 *       → the honest refused-twice class; exactly two signs, nothing accepted;
 *   (c) an instruction-error refusal does NOT walk — one endpoint, no failover, no refresh
 *       (a genuinely invalid tx would be refused everywhere);
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
const IX_REFUSAL = {code: -32002, message: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1'};

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

describe('attempt-#6 proof (a): head refuses blockhash → SAME bytes walk → public tail accepts', () => {
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
    // ONE sign: one blockhash fetch, no refresh — the once-only seam bound untouched.
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

describe('attempt-#6 proof (b): every candidate refuses → ONE refresh → refuses again → honest refused-twice', () => {
  test('two full walks, exactly two blockhash fetches/signs, the refused-twice class verbatim', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const recorded = installRpc({
      [A]: headThatServesReads({error: BH_REFUSAL}),
      [B]: {sendTransaction: {error: BH_REFUSAL}},
      [PUBLIC]: {sendTransaction: {error: BH_REFUSAL}}, // even the tail refuses — twice
    });
    await expect(withDerivedList(solana => sendEurc(solana, MERCHANT_ADDRESS, 8_800_000n)))
      .rejects.toThrow(/sol broadcast refused twice \(fresh block re-signed once\): .*Blockhash not found/);
    // Two FULL walks of the same list, in order — then the seam stopped (never a third).
    expect(sendCalls(recorded).map(c => c.url)).toEqual([A, B, PUBLIC, A, B, PUBLIC]);
    // The single refresh: exactly TWO blockhash fetches (one per attempt) — i.e. exactly TWO
    // signs. The once-only bound held with the walk underneath it.
    expect(bhCalls(recorded)).toHaveLength(2);
    expect(recorded.filter(c => c.method === 'getAccountInfo')).toHaveLength(2); // pre-checks ran ONCE
    // Nothing was ever accepted — the error class is the honest outcome, not a false success.
    expect(warnLines(warn).some(l => /BROADCAST accepted/.test(l))).toBe(false);
    // The tracer tells both walks + the diagnosed refresh, in order.
    expect(stepLines(warnLines(warn))).toEqual([
      'sender-ata-check', 'recipient-ata-check', 'sender-balance-check',
      'blockhash', 'sign', 'broadcast',
      'rpc-failover a.example → b.example (blockhash-not-found)',
      'rpc-failover b.example → api.mainnet-beta.solana.com (blockhash-not-found)',
      'blockhash-refresh-retry',
      'sign', 'broadcast',
      'rpc-failover a.example → b.example (blockhash-not-found)',
      'rpc-failover b.example → api.mainnet-beta.solana.com (blockhash-not-found)',
    ]);
    expect(warnLines(warn).some(l => /FAILED at step=broadcast: sol broadcast refused twice/.test(l))).toBe(true);
    warn.mockRestore();
  });
});

describe('attempt-#6 proof (c): an instruction-error refusal does NOT walk', () => {
  test('single endpoint, no failover, no refresh — the venue message surfaces with the refusal brand', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const recorded = installRpc({
      [A]: headThatServesReads({error: IX_REFUSAL}), // a verdict on the tx itself
      [B]: {sendTransaction: SIG_OK}, // MUST never be consulted
      [PUBLIC]: {sendTransaction: SIG_OK}, // MUST never be consulted
    });
    let refusedBrand = false;
    await expect(withDerivedList(async solana => {
      try {
        return await sendEurc(solana, MERCHANT_ADDRESS, 8_800_000n);
      } catch (e) {
        refusedBrand = isEndpointRefusal(e);
        throw e;
      }
    })).rejects.toThrow(/custom program error: 0x1/);
    expect(refusedBrand).toBe(true);
    // ONE endpoint consulted for the broadcast — B and the public tail never saw a genuinely
    // invalid transaction, and the seam never refreshed.
    expect(sendCalls(recorded).map(c => c.url)).toEqual([A]);
    expect(bhCalls(recorded)).toHaveLength(1);
    expect(stepLines(warnLines(warn))).not.toContain('blockhash-refresh-retry');
    expect(warnLines(warn).every(l => !l.includes('rpc-failover'))).toBe(true);
    warn.mockRestore();
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

describe('attempt-#6 proof (d): the broadcast candidate list — deterministic head + public tail', () => {
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
