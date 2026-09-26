/**
 * The EVM JSON-RPC candidate WALK (app/evm/rpc.ts) — the `solana-rpc-walk.test.ts` pins,
 * restated for the EVM pipe (spec 2026-09-26 D10/D12). Each rule:
 *   • transport failure OR HTTP ≥500 (without the relay marker) OR a `dpayRelayError` marker
 *     body ⇒ try the next candidate;
 *   • HTTP 4xx (incl. 404) and a JSON-RPC `error` body are ANSWERS about THIS request ⇒
 *     refuse in place, no walk;
 *   • a live 429 brands EvmRateLimited and opens a per-URL cooldown the next call SKIPS;
 *   • 2xx returns immediately — never walked past (a broadcast is sent exactly once);
 *   • exhaustion precedence: MARKER → EvmRelayPathDown, else upstream 5xx →
 *     EvmEndpointRefused(status), else all-gated → EvmRateLimited, else the LAST transport
 *     error verbatim.
 * The error shapes are matched by their BRAND FIELDS, never instanceof (two module instances:
 * thrown in the network module, caught in the seam).
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';

const realFetch = globalThis.fetch;

/** A fresh network module per test: the per-URL cooldown map is module state. */
function freshRpc(): typeof import('../evm/rpc') {
  let mod!: typeof import('../evm/rpc');
  jest.isolateModules(() => {
    mod = require('../evm/rpc');
  });
  return mod;
}

/** A minimal Response double: the walk reads `headers.get` (content-length, Retry-After),
 *  `text()` on non-OK, and `json()` on OK — nothing else. */
function res(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: (n: string) => headers[n.toLowerCase()] ?? null},
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

const envelope = (result: unknown) => JSON.stringify({jsonrpc: '2.0', id: 1, result});
const marker = (code: string) => JSON.stringify({dpayRelayError: code, detail: 'upstream missing'});

/** Install a fetch double routed by URL; records every (url, method-of-envelope) pair. */
function route(byUrl: Record<string, (method: string) => Response | Promise<Response>>): {calls: Array<{url: string; method: string}>} {
  const calls: Array<{url: string; method: string}> = [];
  (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL, init?: {body?: string}) => {
    const u = String(url);
    const method = (JSON.parse(init?.body ?? '{}') as {method?: string}).method ?? '?';
    calls.push({url: u, method});
    const h = byUrl[u];
    if (!h) throw new Error(`unexpected fetch ${u} ${method}`);
    return await h(method);
  }) as typeof fetch;
  return {calls};
}

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
});

const A = 'https://a.example/evm';
const B = 'https://b.example/evm';

describe('evm rpc walk — answers and walks', () => {
  test('a 2xx returns the result — never walked past, cooldown cleared', async () => {
    const rpc = freshRpc();
    const {calls} = route({[A]: () => res(200, envelope('0x7a69'))});
    await expect(rpc.ethChainId(A)).resolves.toBe('0x7a69');
    expect(calls).toEqual([{url: A, method: 'eth_chainId'}]);
  });

  test('a transport death on home A walks to home B; the SAME envelope id rides both', async () => {
    const rpc = freshRpc();
    const bodies: string[] = [];
    (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL, init?: {body?: string}) => {
      bodies.push(init?.body ?? '');
      if (String(url) === A) throw new TypeError('network dead');
      return res(200, envelope('0x1'));
    }) as typeof fetch;
    await expect(rpc.ethChainId([A, B])).resolves.toBe('0x1');
    expect(bodies.length).toBe(2);
    expect(JSON.parse(bodies[0]).id).toBe(JSON.parse(bodies[1]).id); // one logical request
  });

  test('a relay marker (503 evm-unconfigured) walks; a healthy second home answers', async () => {
    const rpc = freshRpc();
    const {calls} = route({
      [A]: () => res(503, marker('evm-unconfigured')),
      [B]: () => res(200, envelope('0x64')),
    });
    await expect(rpc.ethGetBalance([A, B], '0x1')).resolves.toBe('0x64');
    expect(calls.map((c) => c.url)).toEqual([A, B]);
  });

  test('a provider 5xx WITHOUT the marker walks too (relay the status verbatim at exhaustion)', async () => {
    const rpc = freshRpc();
    const {calls} = route({
      [A]: () => res(502, '<html>bad gateway</html>'),
      [B]: () => res(200, envelope('0x2')),
    });
    await expect(rpc.ethChainId([A, B])).resolves.toBe('0x2');
    expect(calls.length).toBe(2);
  });

  test('a 2xx body carrying the marker is a broken relay — walks, never decoded as JSON-RPC', async () => {
    const rpc = freshRpc();
    const {calls} = route({
      [A]: () => res(200, marker('evm-upstream-unreachable')),
      [B]: () => res(200, envelope('0x3')),
    });
    await expect(rpc.ethChainId([A, B])).resolves.toBe('0x3');
    expect(calls.length).toBe(2);
  });
});

describe('evm rpc walk — refusals in place', () => {
  test('HTTP 4xx never fails over', async () => {
    const rpc = freshRpc();
    const {calls} = route({[A]: () => res(400, '{"error":"bad envelope"}'), [B]: () => res(200, envelope('0x0'))});
    await expect(rpc.ethChainId([A, B])).rejects.toMatchObject({dpayEndpointRefused: true, status: 400});
    expect(calls).toEqual([{url: A, method: 'eth_chainId'}]);
  });

  test('a JSON-RPC error body refuses in place (a verdict on THIS request)', async () => {
    const rpc = freshRpc();
    const {calls} = route({
      [A]: () => res(200, JSON.stringify({jsonrpc: '2.0', id: 1, error: {message: 'execution reverted'}})),
    });
    await expect(rpc.ethCall(A, '0xtoken', '0x70a08231')).rejects.toMatchObject({
      dpayEndpointRefused: true,
      message: expect.stringContaining('execution reverted'),
    });
    expect(calls.length).toBe(1);
  });

  test('a 429 brands EvmRateLimited and opens a cooldown the next call SKIPS', async () => {
    const rpc = freshRpc();
    const {calls} = route({
      [A]: () => res(429, 'slow down', {'retry-after': '3'}),
      [B]: () => res(200, envelope('0x4')),
    });
    await expect(rpc.ethChainId([A, B])).rejects.toMatchObject({dpayEndpointRefused: true, status: 429});
    // The immediate retry must SKIP A entirely (no packet toward a throttled endpoint) and ask B.
    await expect(rpc.ethChainId([A, B])).resolves.toBe('0x4');
    expect(calls.every((c) => c.url === B || c.method === 'eth_chainId')).toBe(true);
    expect(calls.filter((c) => c.url === A).length).toBe(1);
  });
});

describe('evm rpc walk — exhaustion precedence', () => {
  test('1. every home answered with the marker → EvmRelayPathDown (transport class)', async () => {
    const rpc = freshRpc();
    route({
      [A]: () => res(503, marker('evm-unconfigured')),
      [B]: () => res(504, marker('evm-upstream-unreachable')),
    });
    await expect(rpc.ethChainId([A, B])).rejects.toMatchObject({
      dpayRelayPathDown: true,
      relayErrorCode: 'evm-unconfigured',
    });
  });

  test('2. no marker but a relayed 5xx → EvmEndpointRefused with the FIRST-seen status', async () => {
    const rpc = freshRpc();
    route({[A]: () => res(500, 'upstream boom'), [B]: () => res(503, 'upstream boom 2')});
    // First-seen wins: the earlier (preferred) home's verdict describes the world more
    // faithfully than a later failover's echo.
    await expect(rpc.ethChainId([A, B])).rejects.toMatchObject({dpayEndpointRefused: true, status: 500});
  });

  test('4. all transport-dead → the LAST transport error verbatim (the oracle classifies)', async () => {
    const rpc = freshRpc();
    (globalThis as unknown as {fetch: unknown}).fetch = (async (url: string | URL) => {
      throw new TypeError(`dead at ${String(url)}`);
    }) as typeof fetch;
    await expect(rpc.ethChainId([A, B])).rejects.toThrow(/dead at/);
  });

  test('a caller abort throws out of the walk immediately (never a walk signal)', async () => {
    const rpc = freshRpc();
    const ctrl = new AbortController();
    ctrl.abort();
    (globalThis as unknown as {fetch: unknown}).fetch = (async () => {
      throw new DOMException('Aborted', 'AbortError');
    }) as typeof fetch;
    await expect(rpc.ethChainId([A, B], {signal: ctrl.signal})).rejects.toThrow();
  });
});

describe('evm rpc — method shapes', () => {
  test('a non-hex answer is refused (the endpoint\'s bytes are the problem)', async () => {
    const rpc = freshRpc();
    route({[A]: () => res(200, envelope({weird: true}))});
    await expect(rpc.ethChainId(A)).rejects.toMatchObject({dpayEndpointRefused: true});
  });

  test('eth_sendRawTransaction demands a 32-byte 0x hash back', async () => {
    const rpc = freshRpc();
    route({[A]: () => res(200, envelope('0x' + 'ab'.repeat(32)))});
    await expect(rpc.ethSendRawTransaction(A, '0x02f86c')).resolves.toBe('0x' + 'ab'.repeat(32));

    const rpc2 = freshRpc();
    route({[A]: () => res(200, envelope('0x1234'))});
    await expect(rpc2.ethSendRawTransaction(A, '0x02f86c')).rejects.toMatchObject({dpayEndpointRefused: true});
  });

  test('ethGetLogs validates the array shape', async () => {
    const rpc = freshRpc();
    route({[A]: () => res(200, envelope({not: 'an array'}))});
    await expect(rpc.ethGetLogs(A, {fromBlock: '0x1', toBlock: '0x2', address: '0xt', topics: []}))
      .rejects.toMatchObject({dpayEndpointRefused: true});
  });
});
