/**
 * The Solana endpoint slot (`config/constants.ts`) — R2: the default is DERIVED from the relay.
 *
 * WHY THE DERIVATION EXISTS. Until 2026-09-10 the endpoint was a provider URL + API key baked
 * into the bundle, so the key shipped in every client (its death — HTTP 401/429, measured
 * 2026-09-08/09 — was a multi-day outage) and a rotation was a store release. R2
 * (docs/specs/2026-09-09-relay-ha-and-solana-proxy.md §"Direction 1 — the proxy") moved the
 * default behind the relay: `${relayBase}/api/v1/solana/rpc`, base = the ACTIVE relay address
 * (R1 list [0], wired by App.tsx via `setRelayBaseForSolana`). The provider key lives in relay
 * configuration. The OPERATOR override (`setSolanaRpcUrl`, Settings ▸ Advanced) remains the
 * escape hatch that removes dpay from the path.
 *
 * ONE SOURCE OF TRUTH is the property under test, not just the precedence arithmetic: the last
 * case drives the real seam (`solana.ts` reads) and asserts the POST went to the operator's
 * endpoint, because a second place holding the URL would silently keep talking to the old one.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';

const realFetch = globalThis.fetch;

/** Load a FRESH copy of the config module (its operator/relay slots are module state). `baked`
 *  becomes the `__DPAY_TEST_SOLANA_RPC_URL` override — UNDEFINED (the prod shape: the derivation
 *  stands, nothing fights it) when omitted. The previous global is always restored. */
function freshConfig(baked?: string) {
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

describe('solanaRpcUrl — the R2 derivation (default = the relay’s proxy route)', () => {
  test('no test override: the default derives from the pre-wiring relay base (WALLET_ORIGIN)', () => {
    const c = freshConfig(); // prod shape: __DPAY_TEST_SOLANA_RPC_URL unset
    expect(c.solanaRpcUrl()).toBe('https://dpay.kalaj.org/api/v1/solana/rpc');
    expect(c.solanaRpcUrl()).toBe(`https://dpay.kalaj.org${c.SOLANA_RPC_PROXY_PATH}`);
  });

  test('trailing-slash-safe join: a base that carries slashes still composes ONE clean path', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana('https://relay.example/');
    expect(c.solanaRpcUrl()).toBe('https://relay.example/api/v1/solana/rpc');
    c.setRelayBaseForSolana('https://relay.example///');
    expect(c.solanaRpcUrl()).toBe('https://relay.example/api/v1/solana/rpc');
  });

  test('a relay-list change re-derives the default — the base is runtime state, not a constant', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana('https://first.example');
    expect(c.solanaRpcUrl()).toBe('https://first.example/api/v1/solana/rpc');
    c.setRelayBaseForSolana('https://second.example');
    expect(c.solanaRpcUrl()).toBe('https://second.example/api/v1/solana/rpc');
  });

  test('the operator override wins absolutely — the Settings escape hatch removes dpay from the path', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana('https://relay.example');
    c.setSolanaRpcUrl('https://mainnet.provider.example/?api-key=rotated');
    expect(c.solanaRpcUrl()).toBe('https://mainnet.provider.example/?api-key=rotated');
    // …and it wins over a LATER relay re-point too: the two slots are independent.
    c.setRelayBaseForSolana('https://other-relay.example');
    expect(c.solanaRpcUrl()).toBe('https://mainnet.provider.example/?api-key=rotated');
  });

  test('an empty override FOLLOWS THE RELAY again — not offline, not a baked literal', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana('https://relay.example');
    c.setSolanaRpcUrl('https://mainnet.provider.example/?api-key=rotated');
    c.setSolanaRpcUrl('');
    // Non-empty derived URL: the rail is ON and pointed at the relay, never ''-offline.
    expect(c.solanaRpcUrl()).toBe('https://relay.example/api/v1/solana/rpc');
    // …and surrounding whitespace is not a different endpoint.
    c.setSolanaRpcUrl('   https://spaced.example   ');
    expect(c.solanaRpcUrl()).toBe('https://spaced.example');
  });

  test('the ‘’ test override still means OFFLINE — the jest/e2e seam is untouched by the derivation', () => {
    const c = freshConfig(''); // jest.setup.js shape: the override IS '' → SOL off
    expect(c.solanaRpcUrl()).toBe('');
    c.setSolanaRpcUrl(''); // '' clears the OPERATOR slot — the default ('' override) stands
    expect(c.solanaRpcUrl()).toBe('');
    c.setSolanaRpcUrl('https://operator.example');
    expect(c.solanaRpcUrl()).toBe('https://operator.example'); // the operator still wins
  });
});

describe('solanaRpcUrls — the walk’s candidate list (R2 multi-home)', () => {
  test('maps the FULL relay list in order — one proxy candidate per relay home, deduped', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana(['https://a.example', 'https://b.example', 'https://a.example/']);
    expect(c.solanaRpcUrls()).toEqual([
      'https://a.example/api/v1/solana/rpc',
      'https://b.example/api/v1/solana/rpc',
    ]);
    // `solanaRpcUrl()` stays the HEAD of the list — the availability gates keep reading one
    // string and zero call sites outside this seam changed shape.
    expect(c.solanaRpcUrl()).toBe('https://a.example/api/v1/solana/rpc');
  });

  test('empty entries are dropped; an all-empty install is ignored (the previous list stands)', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana(['https://a.example']);
    c.setRelayBaseForSolana(['', '   ', '']);
    expect(c.solanaRpcUrls()).toEqual(['https://a.example/api/v1/solana/rpc']);
    c.setRelayBaseForSolana(['', ' https://b.example/ ']);
    expect(c.solanaRpcUrls()).toEqual(['https://b.example/api/v1/solana/rpc']);
  });

  test('the OPERATOR override collapses the list to ONE candidate — the operator removed dpay from the path', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana(['https://a.example', 'https://b.example']);
    c.setSolanaRpcUrl('https://operator.example/?api-key=theirs');
    expect(c.solanaRpcUrls()).toEqual(['https://operator.example/?api-key=theirs']);
    // A later relay re-point does not grow the list back — the slots are independent.
    c.setRelayBaseForSolana(['https://other.example']);
    expect(c.solanaRpcUrls()).toEqual(['https://operator.example/?api-key=theirs']);
  });

  test('a NON-EMPTY test override IS the whole list — the harness stub endpoint is the only home', () => {
    const c = freshConfig('https://stub.example');
    c.setRelayBaseForSolana(['https://a.example', 'https://b.example']);
    expect(c.solanaRpcUrls()).toEqual(['https://stub.example']);
  });

  test('the EMPTY test override stays rail-off: a one-element [\'\'] list, unchanged by relay wiring', () => {
    const c = freshConfig(''); // jest.setup.js shape
    expect(c.solanaRpcUrls()).toEqual(['']);
    c.setRelayBaseForSolana(['https://a.example']);
    expect(c.solanaRpcUrls()).toEqual(['']); // the seam gate (solanaRpcUrl() === '') fires first
  });

  test('App-mutator shape: every list installation syncs the derivation in the same tick', () => {
    const c = freshConfig();
    // App.tsx mount effect: the initial valid list is wired synchronously, before the first
    // render's polls — no window where the relay list moved but the SOL derivation didn't.
    c.setRelayBaseForSolana(['https://boot1.example', 'https://boot2.example']);
    expect(c.solanaRpcUrls()).toEqual([
      'https://boot1.example/api/v1/solana/rpc',
      'https://boot2.example/api/v1/solana/rpc',
    ]);
    // The persisted-list load (.then()) REPLACES the list in one call — no stale tail survives.
    c.setRelayBaseForSolana(['https://stored.example']);
    expect(c.solanaRpcUrls()).toEqual(['https://stored.example/api/v1/solana/rpc']);
    // persistRelayList (the Settings editor): a mid-session re-point lands whole, deduped, ordered.
    c.setRelayBaseForSolana(['https://edited.example', 'https://stored.example', 'https://edited.example/']);
    expect(c.solanaRpcUrls()).toEqual([
      'https://edited.example/api/v1/solana/rpc',
      'https://stored.example/api/v1/solana/rpc',
    ]);
  });
});

describe('setSolanaRpcUrl — refusals (unchanged: the override stays mainnet-https-only)', () => {
  test('plain http is REFUSED, by name — an endpoint that can be rewritten in transit lies about balances', () => {
    const c = freshConfig();
    expect(() => c.setSolanaRpcUrl('http://insecure.example')).toThrow(/https:\/\//);
    // A refusal changes nothing: the derived default still stands.
    expect(c.solanaRpcUrl()).toBe('https://dpay.kalaj.org/api/v1/solana/rpc');
  });

  test('a devnet/testnet endpoint is REFUSED, naming the host — this wallet holds mainnet funds', () => {
    // It is also what keeps isSolanaDevnet() honest: the flag reads the EFFECTIVE endpoint, so
    // an override that could switch clusters would leave every "DEVNET" badge lying.
    const c = freshConfig();
    expect(() => c.setSolanaRpcUrl('https://api.devnet.solana.com')).toThrow(/api\.devnet\.solana\.com/);
    expect(() => c.setSolanaRpcUrl('https://testnet.provider.example')).toThrow(/testnet\.provider\.example/);
    expect(c.solanaRpcUrl()).toBe('https://dpay.kalaj.org/api/v1/solana/rpc');
    expect(c.isSolanaDevnet()).toBe(false);
  });

  test('a value that is not a URL is refused with an instruction, not a stack trace', () => {
    const c = freshConfig();
    expect(() => c.setSolanaRpcUrl('provider.example/rpc')).toThrow(/Not a valid URL[\s\S]*https:\/\//);
    expect(c.solanaRpcUrl()).toBe('https://dpay.kalaj.org/api/v1/solana/rpc');
  });
});

describe('isSolanaDevnet — derived from the EFFECTIVE endpoint (R2)', () => {
  test('false on the derived mainnet default', () => {
    const c = freshConfig();
    expect(c.isSolanaDevnet()).toBe(false);
  });

  test('true on a devnet override — the dev-build way onto a test cluster', () => {
    const c = freshConfig('https://api.devnet.solana.com');
    expect(c.isSolanaDevnet()).toBe(true);
  });

  test('follows the live endpoint: a relay base whose host names devnet flips the badge', () => {
    const c = freshConfig();
    c.setRelayBaseForSolana('https://devnet-relay.example');
    expect(c.isSolanaDevnet()).toBe(true);
  });
});

describe('the SEAM — one source of truth, proven by where the POST goes', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('reads go to the OPERATOR endpoint, not the default the module booted with', async () => {
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string};
    const prev = g.__DPAY_TEST_SOLANA_RPC_URL;
    let constants!: typeof import('../config/constants');
    let solana!: typeof import('../solana');
    const urls: string[] = [];
    g.__DPAY_TEST_SOLANA_RPC_URL = 'https://default.example';
    try {
      jest.isolateModules(() => {
        constants = require('../config/constants');
        constants.setSolanaRpcUrl('https://operator.example/?api-key=theirs');
        solana = require('../solana');
      });
      globalThis.fetch = ((url: string) => {
        urls.push(url);
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({result: {context: {slot: 1}, value: [{lamports: 5, owner: '11111111111111111111111111111111', data: ['', 'base64']}]}}),
        } as unknown as Response);
      }) as unknown as typeof fetch;
      await solana.readSolanaBalances('4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', []);
      expect(urls).toEqual(['https://operator.example/?api-key=theirs']);
    } finally {
      globalThis.fetch = realFetch;
      if (prev === undefined) delete g.__DPAY_TEST_SOLANA_RPC_URL;
      else g.__DPAY_TEST_SOLANA_RPC_URL = prev;
    }
  });
});
