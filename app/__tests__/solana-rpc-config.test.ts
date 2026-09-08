/**
 * The operator's Solana endpoint slot (`config/constants.ts`).
 *
 * WHY IT EXISTS. Until 2026-09-08 the endpoint was a build-time literal and nothing else, so a key
 * that stopped answering could only be replaced by editing source, rebuilding an APK and shipping a
 * store release — days, for a one-line change, while the EUR rail stayed dark
 * (`docs/specs/2026-09-08-solana-rpc-plan.md` §1.4). This slot is the fix, and it mirrors the relay
 * URL's: a baked default, a runtime setter, one persisted key read at boot.
 *
 * ONE SOURCE OF TRUTH is the property under test, not just the setter's arithmetic: the last case
 * drives the real seam and asserts the POST went to the operator's endpoint, because a second place
 * holding the URL would silently keep talking to the old one.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';

const realFetch = globalThis.fetch;

/** Load a FRESH copy of the config module (its active endpoint is module state). */
function freshConfig(baked = 'https://baked.example/?api-key=k') {
  const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string};
  const prev = g.__DPAY_TEST_SOLANA_RPC_URL;
  let mod!: typeof import('../config/constants');
  jest.isolateModules(() => {
    g.__DPAY_TEST_SOLANA_RPC_URL = baked;
    mod = require('../config/constants');
  });
  g.__DPAY_TEST_SOLANA_RPC_URL = prev;
  return mod;
}

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
});

describe('setSolanaRpcUrl / solanaRpcUrl — the operator slot', () => {
  test('the baked default is what a fresh install talks to', () => {
    const c = freshConfig('https://baked.example/?api-key=k');
    expect(c.solanaRpcUrl()).toBe('https://baked.example/?api-key=k');
    expect(c.SOLANA_RPC_BAKED).toBe('https://baked.example/?api-key=k');
  });

  test('an operator endpoint replaces it — the whole point: a rotation without a release', () => {
    const c = freshConfig();
    c.setSolanaRpcUrl('https://mainnet.provider.example/?api-key=rotated');
    expect(c.solanaRpcUrl()).toBe('https://mainnet.provider.example/?api-key=rotated');
  });

  test('an empty value restores the built-in default (the way back is one field, cleared)', () => {
    const c = freshConfig('https://baked.example/?api-key=k');
    c.setSolanaRpcUrl('https://other.example');
    c.setSolanaRpcUrl('');
    expect(c.solanaRpcUrl()).toBe('https://baked.example/?api-key=k');
    // …and surrounding whitespace is not a different endpoint.
    c.setSolanaRpcUrl('   https://spaced.example   ');
    expect(c.solanaRpcUrl()).toBe('https://spaced.example');
  });

  test('plain http is REFUSED, by name — an endpoint that can be rewritten in transit lies about balances', () => {
    const c = freshConfig();
    expect(() => c.setSolanaRpcUrl('http://insecure.example')).toThrow(/https:\/\//);
    expect(c.solanaRpcUrl()).toBe('https://baked.example/?api-key=k'); // unchanged: a refusal changes nothing
  });

  test('a devnet/testnet endpoint is REFUSED, naming the host — this wallet holds mainnet funds', () => {
    // It is also what keeps IS_SOLANA_DEVNET honest: that flag is derived from the BAKED default,
    // so an override that could switch clusters would leave every "DEVNET" badge lying.
    const c = freshConfig();
    expect(() => c.setSolanaRpcUrl('https://api.devnet.solana.com')).toThrow(/api\.devnet\.solana\.com/);
    expect(() => c.setSolanaRpcUrl('https://testnet.provider.example')).toThrow(/testnet\.provider\.example/);
    expect(c.solanaRpcUrl()).toBe('https://baked.example/?api-key=k');
    expect(c.IS_SOLANA_DEVNET).toBe(false);
  });

  test('a value that is not a URL is refused with an instruction, not a stack trace', () => {
    const c = freshConfig();
    expect(() => c.setSolanaRpcUrl('helius.example/rpc')).toThrow(/Not a valid URL[\s\S]*https:\/\//);
    expect(c.solanaRpcUrl()).toBe('https://baked.example/?api-key=k');
  });

  test('IS_SOLANA_DEVNET still reads the baked default — a dev build that bakes devnet still badges', () => {
    const c = freshConfig('https://api.devnet.solana.com');
    expect(c.IS_SOLANA_DEVNET).toBe(true);
  });

  test('the SEAM reads the operator endpoint — one source of truth, proven by where the POST goes', async () => {
    const urls: string[] = [];
    (globalThis as unknown as {fetch: unknown}).fetch = (url: string) => {
      urls.push(url);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({result: {context: {slot: 1}, value: [{lamports: 5, owner: '11111111111111111111111111111111', data: ['', 'base64']}]}}),
      } as unknown as Response);
    };
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string};
    const prev = g.__DPAY_TEST_SOLANA_RPC_URL;
    let p: Promise<unknown> | undefined;
    jest.isolateModules(() => {
      g.__DPAY_TEST_SOLANA_RPC_URL = 'https://baked.example/?api-key=k';
      const {setSolanaRpcUrl} = require('../config/constants');
      setSolanaRpcUrl('https://operator.example/?api-key=theirs');
      const {readSolanaBalances} = require('../solana');
      p = readSolanaBalances('4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', []);
    });
    g.__DPAY_TEST_SOLANA_RPC_URL = prev;
    await p;
    expect(urls).toEqual(['https://operator.example/?api-key=theirs']);
  });
});
