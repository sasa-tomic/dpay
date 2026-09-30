/**
 * The Solana candidate WALK (`solana/rpc.ts` rpcFetch) — R2's headline client half
 * (docs/specs/2026-09-09-relay-ha-and-solana-proxy.md §"Direction 1" + §"Direction 2"
 * surface-split: the RPC proxy is multi-home, stateless + cache, so reads AND broadcasts
 * walk).
 *
 * The walk's rules, each pinned here:
 *   • transport failure OR HTTP ≥500 OR a relay-marker body ⇒ try the next candidate;
 *   • HTTP 4xx (incl. 404) is an ANSWER about this request ⇒ `SolanaEndpointRefused` as
 *     today, no walk;
 *   • 2xx is the answer — a return, never walked past (sendTransaction's one forbidden move)
 *     — EXCEPT a 2xx body carrying the relay marker (a broken/hostile relay), which walks;
 *   • (attempt-#6 + the D32 widening) a Blockhash-not-found OR preflight-simulation refusal
 *     on sendTransaction — however wrapped (2xx JSON-RPC error object or HTTP error body) —
 *     WALKS, re-sending the SAME signed bytes; every other refusal refuses in place, and
 *     reads never walk on it (see the last describe below);
 *   • a multi-candidate walk arms EVERY attempt with its own deadline (attempt 0 = the FULL
 *     timeoutMs, attempt i = timeoutMs>>i floored at 1 s, total ≈2×timeoutMs); an armed
 *     expiry is transport-dead. A single-candidate list keeps the caller-owns-deadline
 *     contract (a caller abort always throws out of the walk immediately).
 *
 * EXHAUSTION precedence, as implemented (do not re-derive):
 *   1. MARKER — any home answered with the relay's `dpayRelayError` body (503/504 by
 *      contract, or a hostile 2xx carrying it) → `SolanaRelayPathDown` (transport class —
 *      dpay's relay answered HTTP, so the phone is online; its Solana leg is what is dead);
 *   2. UPSTREAM STATUS — else any home answered a provider ≥500 relayed verbatim →
 *      `SolanaEndpointRefused` with THAT status;
 *   3. ALL-GATED — else every candidate sat inside an open 429 cooldown and ZERO requests
 *      were sent → `SolanaRateLimited` for the first gate;
 *   4. TRANSPORT — else all attempts transport-dead (refused, or their own armed deadline
 *      expired) → rethrow the LAST transport error verbatim (the seam's oracle probes the
 *      IC boundary from there).
 * A LIVE 429 answers mid-walk (the cooldown branch) — the provider that spoke wins over a
 * dead transport home.
 *
 * The last test drives the SEAM (`solana.ts` readSolanaBalances) end-to-end over a mocked
 * fetch: marker exhaustion must classify 'unreachable' with NO IC probe — the branded error
 * proves the phone is online (the relay answered HTTP), so the oracle is skipped.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';

const realFetch = globalThis.fetch;

/** A fresh copy of the network module — its per-URL cooldown map (and genesis cache) are
 *  module state, and the cooldown tests need every test to start with an empty map. */
function freshRpc(): typeof import('../solana/rpc') {
  let mod!: typeof import('../solana/rpc');
  jest.isolateModules(() => {
    mod = require('../solana/rpc');
  });
  return mod;
}

/** A minimal `Response` double: the walk reads `headers.get` (Retry-After), `text()` on
 *  non-OK, and `json()` on OK — nothing else. */
function res(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: (n: string) => headers[n] ?? null},
    json: () => Promise.resolve(JSON.parse(body)),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

const A = 'https://a.example/api/v1/solana/rpc';
const B = 'https://b.example/api/v1/solana/rpc';
const C2 = 'https://c.example/api/v1/solana/rpc';
const D2 = 'https://d.example/api/v1/solana/rpc';
const E2 = 'https://e.example/api/v1/solana/rpc';

/** Install a fetch mock that answers per-URL: `routes` maps an exact URL to either a
 *  Response, a function producing one, the string 'transport' (the fetch itself throws —
 *  the candidate is unreachable), or the string 'hang' (real-fetch semantics for "TCP
 *  accepted, never answered": settles ONLY when the attempt's composed signal aborts — the
 *  behavior the armed per-attempt deadline exists for). Returns the recorded call URLs in
 *  order. */
function installRoutes(routes: Record<string, Response | (() => Response) | 'transport' | 'hang'>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: {signal?: AbortSignal}) => {
    const u = String(url);
    calls.push(u);
    const route = routes[u];
    if (route === 'transport') throw new TypeError('fetch failed');
    if (route === 'hang') {
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener('abort', onAbort, {once: true});
      });
    }
    if (typeof route === 'function') return route();
    if (route !== undefined) return route;
    throw new Error(`unexpected fetch to ${u}`);
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the candidate walk — one pass, in order, failover on transport/5xx/marker', () => {
  test('a 5xx home is skipped — the answer comes from the next candidate', async () => {
    const calls = installRoutes({
      [A]: res(503, 'upstream exploded'),
      [B]: res(200, JSON.stringify({result: {value: 123}})),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).resolves.toBe('123');
    expect(calls).toEqual([A, B]);
  });

  test('a 4xx is an ANSWER — no walk to the next home, refusal brand, the provider’s status', async () => {
    const calls = installRoutes({
      [A]: res(404, '{"error":"not found"}'),
      [B]: res(200, JSON.stringify({result: {value: 123}})),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).rejects.toMatchObject({
      dpayEndpointRefused: true,
      status: 404,
    });
    expect(calls).toEqual([A]); // B — a different home — is never consulted on a 4xx
  });

  test('a relay-marker 504 on every home → SolanaRelayPathDown (transport class, not a provider refusal)', async () => {
    const calls = installRoutes({
      [A]: res(504, JSON.stringify({dpayRelayError: 'solana-upstream-unreachable', detail: 'solana upstream unreachable: connection failed'})),
      [B]: res(504, JSON.stringify({dpayRelayError: 'solana-upstream-unreachable'})),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).rejects.toMatchObject({
      dpayRelayPathDown: true,
      relayErrorCode: 'solana-upstream-unreachable',
    });
    expect(calls).toEqual([A, B]);
  });

  test('a relay-marker 503 (unconfigured) is the same class, with its own code', async () => {
    const calls = installRoutes({[A]: res(503, JSON.stringify({dpayRelayError: 'solana-unconfigured'}))});
    const rpc = freshRpc();
    await expect(rpc.getBalance(A, 'Owner')).rejects.toMatchObject({
      dpayRelayPathDown: true,
      relayErrorCode: 'solana-unconfigured',
    });
    expect(calls).toEqual([A]); // the marker home WAS asked — the classification is not a skip
  });

  test('marker beats provider-status at exhaustion: [provider 500, relay-marker 504] is path-down', async () => {
    // The FIRST marker's verdict is kept (first-seen wins) even when a later home also
    // failed — but here the ordering matters the other way: a 500 recorded first must NOT
    // outrank a marker seen after it. Precedence is by CLASS, not by arrival.
    const calls = installRoutes({
      [A]: res(500, 'provider exploded'),
      [B]: res(504, JSON.stringify({dpayRelayError: 'solana-upstream-unreachable'})),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).rejects.toMatchObject({
      dpayRelayPathDown: true,
      relayErrorCode: 'solana-upstream-unreachable',
    });
    expect(calls).toEqual([A, B]); // both homes asked, in order — the 500 home was walked past
  });

  test('exhaustion by provider status: transport-dead + provider-500 → refused(500)', async () => {
    const calls = installRoutes({
      [A]: 'transport',
      [B]: res(500, 'provider exploded'),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).rejects.toMatchObject({
      dpayEndpointRefused: true,
      status: 500,
    });
    expect(calls).toEqual([A, B]); // the transport-dead home was tried first, then the 500 home
  });

  test('a live 429 answers mid-walk — the provider that SPOKE wins over the dead transport home', async () => {
    // Precedence (2) in its live form: a candidate that actually answered 429 throws the
    // rate-limit refusal immediately (and opens that home's cooldown); the earlier home's
    // transport death never becomes an 'offline' story.
    const calls = installRoutes({
      [A]: 'transport',
      [B]: res(429, 'rate limited', {'Retry-After': '2'}),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).rejects.toMatchObject({
      dpayEndpointRefused: true,
      status: 429,
    });
    expect(calls).toEqual([A, B]);
  });

  test('an open cooldown skips THAT home only — the next home still gets its chance', async () => {
    // Home A throttled us on an earlier call (single-home call: the 429 throws and opens
    // A's cooldown). The next multi-home call must not send a single packet toward A.
    let calls = installRoutes({
      [A]: res(429, 'slow down', {'Retry-After': '60'}),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance(A, 'Owner')).rejects.toMatchObject({status: 429});
    expect(calls).toEqual([A]);

    calls = installRoutes({
      [A]: res(429, 'slow down'), // would answer 429 again if (wrongly) asked
      [B]: res(200, JSON.stringify({result: {value: 7}})),
    });
    await expect(rpc.getBalance([A, B], 'Owner')).resolves.toBe('7');
    expect(calls).toEqual([B]); // A was gated in the map, not re-asked
  });

  test('all homes gated → the cooldown answers (the endpoint’s own instruction, held)', async () => {
    let calls = installRoutes({
      [A]: res(429, 'slow down', {'Retry-After': '60'}),
      [B]: res(429, 'slow down', {'Retry-After': '60'}),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance([A], 'Owner')).rejects.toMatchObject({status: 429});
    await expect(rpc.getBalance([B], 'Owner')).rejects.toMatchObject({status: 429});
    calls = installRoutes({
      [A]: res(429, 'slow down'),
      [B]: res(429, 'slow down'),
    });
    await expect(rpc.getBalance([A, B], 'Owner')).rejects.toMatchObject({
      dpayEndpointRefused: true,
      status: 429,
    });
    expect(calls).toEqual([]); // nobody was asked — both windows are open
  });

  test('all-transport-dead exhaustion rethrows the last transport error (the seam’s oracle case)', async () => {
    installRoutes({[A]: 'transport', [B]: 'transport'});
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).rejects.toThrow('fetch failed');
  });

  test('sendTransaction walks after a transport failure — and NEVER after a 2xx', async () => {
    let calls = installRoutes({
      [A]: 'transport',
      [B]: res(200, JSON.stringify({result: 'SigFromB', error: undefined})),
    });
    const rpc = freshRpc();
    await expect(rpc.sendTransaction([A, B], new Uint8Array([1, 2, 3]))).resolves.toBe('SigFromB');
    expect(calls).toEqual([A, B]);

    // A now healthy and FIRST: the broadcast lands there and the walk stops — B must never
    // see the identical bytes (the walk is one pass; a 2xx is final).
    calls = installRoutes({
      [A]: res(200, JSON.stringify({result: 'SigFromA'})),
      [B]: res(200, JSON.stringify({result: 'SigFromB'})),
    });
    await expect(rpc.sendTransaction([A, B], new Uint8Array([4, 5]))).resolves.toBe('SigFromA');
    expect(calls).toEqual([A]);
  });

  test('sendTransaction resubmits BYTE-IDENTICAL bodies across homes (Solana dedups by signature)', async () => {
    // The walk's broadcast-safety rests on this: the failover home receives the exact same
    // signed bytes, so the cluster's own signature dedup makes the resubmit idempotent. A walk
    // that re-encoded, mutated or reordered the body would break that guarantee silently.
    const bodies: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: {body?: string}) => {
      if (init?.body !== undefined) bodies.push(String(init.body));
      if (String(url) === A) throw new TypeError('fetch failed');
      return res(200, JSON.stringify({result: 'SigFromB'}));
    }) as unknown as typeof fetch;
    const rpc = freshRpc();
    await expect(rpc.sendTransaction([A, B], new Uint8Array([9, 9, 9, 250]))).resolves.toBe('SigFromB');
    expect(bodies).toHaveLength(2); // A was asked (and died) with the body, then B got it too
    expect(bodies[1]).toBe(bodies[0]); // byte-identical — the whole safety argument
  });

  test('a 2xx body carrying the relay marker is walked PAST — the next home’s clean 2xx answers (hostile-relay pin)', async () => {
    // Markers ride 503/504 by contract; a 2xx marker is a broken or hostile relay. The
    // machine-readable field outranks the status: walk on rather than parse the marker body
    // as a JSON-RPC envelope (whose `result` would be undefined → a raw TypeError downstream).
    const calls = installRoutes({
      [A]: res(200, JSON.stringify({dpayRelayError: 'solana-unconfigured'})),
      [B]: res(200, JSON.stringify({result: {value: 5}})),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).resolves.toBe('5');
    expect(calls).toEqual([A, B]);
  });

  test('a 2xx marker on EVERY home → exhaustion rung 1 (SolanaRelayPathDown), never a raw TypeError', async () => {
    const calls = installRoutes({
      [A]: res(200, JSON.stringify({dpayRelayError: 'solana-upstream-unreachable'})),
      [B]: res(200, JSON.stringify({dpayRelayError: 'solana-upstream-unreachable'})),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).rejects.toMatchObject({
      dpayRelayPathDown: true,
      relayErrorCode: 'solana-upstream-unreachable',
    });
    expect(calls).toEqual([A, B]);
  });

  test('a marker-looking body DECLARING more than the 64 KiB cap is NOT parsed as a marker (honest body cap)', async () => {
    // The cap: content-length > 65536 ⇒ never a marker candidate. This 503 body would parse
    // as a marker byte-for-byte, but it declares itself huge — the walk must classify it by
    // its status (a provider 503 relayed verbatim → rung 2), not burn the parse. (Lowercase
    // key: this suite's `res` double reads headers exact-key, like the lowercase literal
    // rpcFetch itself uses.)
    const calls = installRoutes({
      [A]: res(503, JSON.stringify({dpayRelayError: 'solana-unconfigured'}), {'content-length': '70000'}),
    });
    const rpc = freshRpc();
    await expect(rpc.getBalance(A, 'Owner')).rejects.toMatchObject({
      dpayEndpointRefused: true,
      status: 503,
    });
    expect(calls).toEqual([A]);
  });
});

describe('attempt deadlines — a hung home is failover fuel, and the walk is bounded (the R1 lesson)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a HUNG home fails over within its OWN armed deadline — the next home answers', async () => {
    // A accepts the connection and never answers. Before the armed fix the caller's signal was
    // forwarded AS-IS and no attempt timer armed (single-composition), so the hung home burned
    // the whole budget and B was never tried. Now every attempt of a multi-home walk arms its
    // own deadline: A's expiry is a transport failure, and B answers.
    const calls = installRoutes({
      [A]: 'hang',
      [B]: res(200, JSON.stringify({result: {value: 42}})),
    });
    const rpc = freshRpc();
    const p = rpc.getBalance([A, B], 'Owner', {timeoutMs: 8000});
    await jest.advanceTimersByTimeAsync(8000); // attempt 1’s FULL budget expires
    await expect(p).resolves.toBe('42');
    expect(calls).toEqual([A, B]); // B was reached — the whole point
    expect(jest.getTimerCount()).toBe(0); // the attempt timer was cancelled in its finally
  });

  test('the total walk is bounded ≈ 2×timeoutMs: three hung homes, geometric falloff (8000+4000+2000)', async () => {
    // Without the falloff an all-hung list stalls one walk N×timeoutMs with polls piling on.
    // The policy: attempt i gets timeoutMs >> i floored at 1 s — 8000+4000+2000 = 14000 for
    // this list, and the exhaustion (all transport-dead, rung 4) settles at exactly 14000.
    const C = 'https://c.example/api/v1/solana/rpc';
    const calls = installRoutes({[A]: 'hang', [B]: 'hang', [C]: 'hang'});
    const rpc = freshRpc();
    let outcome: string | undefined;
    const p = rpc.getBalance([A, B, C], 'Owner', {timeoutMs: 8000});
    p.catch((e: Error) => { outcome = e.message; });
    await jest.advanceTimersByTimeAsync(13999);
    expect(outcome).toBeUndefined(); // the third attempt is still inside its 2000 ms
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome).toBeDefined(); // settled at exactly 14000 — transport-dead exhaustion
    expect(calls).toEqual([A, B, C]); // every home tried once
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a single-candidate list keeps the caller-owns-deadline contract — NO internal timer arms', async () => {
    // The jest pin the single-home contract rests on (mirrors solana-rpc.test.ts’s backstop
    // pin): with a caller signal present, the signal is forwarded AS-IS and nothing arms —
    // a caller granting MORE headroom than `timeoutMs` keeps it.
    let captured: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init?: {signal?: AbortSignal}) => {
      captured = init?.signal;
      return res(200, JSON.stringify({result: {value: 1}}));
    }) as unknown as typeof fetch;
    const rpc = freshRpc();
    const ctrl = new AbortController();
    const p = rpc.getBalance([A], 'Owner', {signal: ctrl.signal, timeoutMs: 3000});
    await expect(p).resolves.toBe('1');
    expect(captured).toBe(ctrl.signal); // byte-for-byte the caller's signal, not a composition
    expect(jest.getTimerCount()).toBe(0); // arming here would be the single-relay regression
  });
});

describe('the SEAM — marker exhaustion classifies unreachable with NO IC probe', () => {  test('readSolanaBalances over a marker-504 home → error/unreachable, fetch called exactly once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string};
    const prev = g.__DPAY_TEST_SOLANA_RPC_URL;
    const fetchMock = jest.fn(async (_url: RequestInfo | URL) =>
      res(504, JSON.stringify({dpayRelayError: 'solana-upstream-unreachable', detail: 'solana upstream unreachable: connection failed'})));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    let solana!: typeof import('../solana');
    g.__DPAY_TEST_SOLANA_RPC_URL = 'https://relay.example';
    try {
      jest.isolateModules(() => {
        solana = require('../solana');
      });
      const read = await solana.readSolanaBalances('4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', []);
      expect(read.sol).toEqual({kind: 'error', failure: 'unreachable'});
      // ONE fetch total: the getMultipleAccounts POST to the override home. The IC-boundary
      // probe (a HEAD to icp-api.io) must never fire — the branded error already proves the
      // phone is online.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://relay.example');
    } finally {
      warn.mockRestore();
      globalThis.fetch = realFetch;
      if (prev === undefined) delete g.__DPAY_TEST_SOLANA_RPC_URL;
      else g.__DPAY_TEST_SOLANA_RPC_URL = prev;
    }
  });
});

// ============================================================================
// THE SEND-PREFLIGHT WALK (attempt-#6, 2026-09-21). The headline client defect: the head
// (Helius via the relay's pipe) refused a VALID signed deposit 8/8 with a 2xx-wrapped
// "Blockhash not found" JSON-RPC error, the walk treated that 2xx as a completed call, and the
// list had one entry — while the byte-exact replay of the SAME signed tx to
// api.mainnet-beta.solana.com was ACCEPTED and FINALIZED. Pins, at the rpc layer:
//   • sendTransaction (and ONLY sendTransaction) walks a preflight-state refusal (blockhash-
//     not-found or the simulation family) — however wrapped — to the next candidate with the
//     SAME signed bytes (byte-identity re-pinned);
//   • every OTHER JSON-RPC/HTTP refusal refuses in place (a genuine byte-verdict would be
//     refused everywhere; failover homes are not hammered);
//   • reads NEVER walk on it (the tail is broadcast-only);
//   • exhaustion is the UNANIMOUS refusal: any transport death, provider 5xx or relay marker
//     outranks it (the strict all-refused rule keeps the thrown verdict readable);
//   • each advance traces `money: sol send step rpc-failover <host> → <host> (why)`.
// POSTURE (the same day, attempts #5/#6/#8 resolution): the payment seam now broadcasts
// skipPreflight, so ITS provider should never answer with this state — the walk stays LIVE for
// the preflight-running paths (submitRawSolTx's venue hand-off, broadcastSolPayment's merchant
// rail) and is defensive parity for the seam; the seam's old refresh-and-resign is retired.
// ============================================================================
describe('the send-preflight walk — a preflight-state refusal is walk-worthy for sendTransaction only', () => {
  const BH_ERR = JSON.stringify({error: {code: -32002, message: 'Blockhash not found'}});
  const IX_VERDICT = JSON.stringify({error: {code: -32002, message: 'ExecutionCustom error: invalid instruction data'}});

  test('a 2xx-wrapped blockhash refusal walks the SAME signed bytes to the next home', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: {body?: string}) => {
      const u = String(url);
      if (init?.body !== undefined) bodies.push(String(init.body));
      if (u === A) return res(200, BH_ERR);
      if (u === B) return res(200, JSON.stringify({result: 'SigFromB'}));
      throw new Error(`unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;
    const rpc = freshRpc();
    await expect(rpc.sendTransaction([A, B], new Uint8Array([1, 2, 3]))).resolves.toBe('SigFromB');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]); // the SAME bytes — no re-sign, no re-encode
    // The advance is on the money log, hosts only.
    expect(warn.mock.calls.map(c => String(c[0]))).toContain(
      'money: sol send step rpc-failover a.example → b.example (blockhash-not-found)',
    );
    warn.mockRestore();
  });

  test('exhaustion on the UNANIMOUS refusal throws the refusal verbatim — the class the payment seam surfaces honestly', async () => {
    installRoutes({[A]: res(200, BH_ERR), [B]: res(200, BH_ERR)});
    const rpc = freshRpc();
    const err: unknown = await rpc.sendTransaction([A, B], new Uint8Array([1])).then(
      () => { throw new Error('expected the walk to exhaust with the refusal class'); },
      (e: unknown) => e,
    );
    expect((err as {dpayEndpointRefused?: boolean}).dpayEndpointRefused).toBe(true);
    expect((err as {status?: number | null}).status).toBeNull();
    expect((err as Error).message).toMatch(/sendTransaction → a\.example: Blockhash not found$/);
    const {isSolBlockhashNotFound} = require('../solana/errors') as typeof import('../solana/errors');
    // The whole point: the message still carries the raw state, classified by the walk's own
    // predicate (the seam no longer refreshes on it — skipPreflight posture — it surfaces it).
    expect(isSolBlockhashNotFound((err as Error).message)).toBe(true);
  });

  test('single-candidate list: the refusal still lands in the seam-readable class (the operator shape)', async () => {
    installRoutes({[A]: res(200, BH_ERR)});
    const rpc = freshRpc();
    await expect(rpc.sendTransaction([A], new Uint8Array([1]))).rejects.toMatchObject({
      dpayEndpointRefused: true,
      status: null,
    });
  });

  test('a transport death breaks the unanimity — the last transport error outranks the refusal', async () => {
    installRoutes({[A]: res(200, BH_ERR), [B]: 'transport'});
    const rpc = freshRpc();
    await expect(rpc.sendTransaction([A, B], new Uint8Array([1]))).rejects.toThrow('fetch failed');
  });

  test('a provider 5xx outranks the refusal at exhaustion (strict all-refused rule)', async () => {
    installRoutes({[A]: res(200, BH_ERR), [B]: res(500, 'provider exploded')});
    const rpc = freshRpc();
    await expect(rpc.sendTransaction([A, B], new Uint8Array([1]))).rejects.toMatchObject({
      dpayEndpointRefused: true,
      status: 500,
    });
  });

  test('a relay marker outranks the refusal at exhaustion (marker stays rung 1)', async () => {
    installRoutes({
      [A]: res(200, BH_ERR),
      [B]: res(504, JSON.stringify({dpayRelayError: 'solana-upstream-unreachable'})),
    });
    const rpc = freshRpc();
    await expect(rpc.sendTransaction([A, B], new Uint8Array([1]))).rejects.toMatchObject({
      dpayRelayPathDown: true,
    });
  });

  test('a genuine byte-verdict refuses in place — one home asked, the invalid tx never walks', async () => {
    let calls = installRoutes({[A]: res(200, IX_VERDICT), [B]: res(200, JSON.stringify({result: 'SigFromB'}))});
    const rpc = freshRpc();
    const err: unknown = await rpc.sendTransaction([A, B], new Uint8Array([1])).then(
      () => { throw new Error('expected the byte-verdict to refuse in place'); },
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/invalid instruction data/);
    expect((err as {dpayEndpointRefused?: boolean}).dpayEndpointRefused).toBe(true);
    expect(calls).toEqual([A]); // B never saw a genuinely invalid transaction
  });

  test('an HTTP-400 body naming preflight state walks too — however wrapped; a non-preflight 400 body does not', async () => {
    let calls = installRoutes({
      [A]: res(400, '{"error":"Blockhash not found"}'),
      [B]: res(200, JSON.stringify({result: 'SigFromB'})),
    });
    const rpc = freshRpc();
    await expect(rpc.sendTransaction([A, B], new Uint8Array([1]))).resolves.toBe('SigFromB');
    expect(calls).toEqual([A, B]);

    calls = installRoutes({
      [A]: res(400, '{"error":"Transaction simulation failed: InstructionError"}'),
      [B]: res(200, JSON.stringify({result: 'SigFromB'})),
    });
    await expect(rpc.sendTransaction([A, B], new Uint8Array([2]))).resolves.toBe('SigFromB'); // the simulation wording is the node's opinion — walk
    expect(calls).toEqual([A, B]);

    calls = installRoutes({
      [A]: res(400, '{"error":"ExecutionCustom error: invalid instruction data"}'),
      [B]: res(200, JSON.stringify({result: 'SigFromB'})),
    });
    await expect(rpc.sendTransaction([A, B], new Uint8Array([3]))).rejects.toMatchObject({
      dpayEndpointRefused: true,
      status: 400,
    });
    expect(calls).toEqual([A]);
  });

  test('READS never walk on a blockhash refusal — the tail is broadcast-only', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = installRoutes({[A]: res(200, BH_ERR), [B]: res(200, JSON.stringify({result: {value: 7}}))});
    const rpc = freshRpc();
    await expect(rpc.getBalance([A, B], 'Owner')).rejects.toThrow(/Blockhash not found/);
    expect(calls).toEqual([A]); // no walk, no failover tracer on a read
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual([]);
    warn.mockRestore();
  });

  test('every advance names its reason — cooldown, transport, marker, 5xx, blockhash', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installRoutes({[A]: res(429, 'slow down', {'Retry-After': '60'})});
    const rpc = freshRpc();
    await rpc.getBalance(A, 'Owner').catch(() => undefined); // opens A's cooldown (60 s)
    // A gated, B transport-dead, C marker-504, D 500 — all walked past; E answers.
    installRoutes({
      [A]: res(429, 'slow down', {'Retry-After': '60'}),
      [B]: 'transport',
      [C2]: res(504, JSON.stringify({dpayRelayError: 'solana-upstream-unreachable'})),
      [D2]: res(500, 'provider exploded'),
      [E2]: res(200, JSON.stringify({result: '1'})),
    });
    await expect(rpc.sendTransaction([A, B, C2, D2, E2], new Uint8Array([1]))).resolves.toBe('1');
    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines).toContain('money: sol send step rpc-failover a.example → b.example (cooldown)');
    expect(lines).toContain('money: sol send step rpc-failover b.example → c.example (transport)');
    expect(lines).toContain('money: sol send step rpc-failover c.example → d.example (relay-marker)');
    expect(lines).toContain('money: sol send step rpc-failover d.example → e.example (http 500)');
    // NO advance is traced from the LAST candidate — the move is the event, not the exhaustion.
    expect(lines.some(l => l.includes('→ e.example (') && l.includes('rpc-failover e.example'))).toBe(false);
    warn.mockRestore();
  });
});
