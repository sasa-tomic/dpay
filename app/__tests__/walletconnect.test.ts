/**
 * MC8 U6.2 — WalletConnect v2 provider source (native Android ckERC20 onramp).
 *
 * `getWalletConnectProvider()` is the EIP-1193 provider source for the NATIVE path only. It is
 * reached solely via `wallet.ts`'s `resolveOnrampProvider()` (web-first: it returns
 * `window.ethereum` before ever reaching here) AND only when `WALLETCONNECT_PROJECT_ID` is
 * non-empty. This suite pins three properties OFFLINE (the WC pairing itself needs a real wallet +
 * network and is an outer-loop gate — explicitly scoped out, see the note at the bottom):
 *   (1) DISABLED GUARD — empty projectId OR Platform 'web' → null, `EthereumProvider.init` is
 *       never called (no network, no QR modal).
 *   (2) SINGLETON — when enabled, `init` is called EXACTLY ONCE across repeated calls (the WC
 *       pairing/session is long-lived; re-init would re-prompt the QR modal every time).
 *   (3) EIP-1193 SURFACE — the returned provider exposes a working `request({method,params})`.
 *
 * `WALLETCONNECT_PROJECT_ID` is a module-load const (mirrors `EXPECTED_RECEIPT_PUBKEY`), so each
 * case re-evaluates `walletconnect.ts` inside `jest.isolateModules` with the desired override — the
 * same pattern `receipt.test.ts` uses. `@walletconnect/ethereum-provider` resolves to the
 * `__stubs__/walletconnect-stub.ts` no-op (jest.config.js moduleNameMapper), so `init` is a
 * controllable `jest.fn` and NO real WalletConnect code executes.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import type {Eip1193Provider} from '../wallet';

// Controllable `Platform.OS`. `jest.mock` is hoisted; the factory reads this at require time
// (lazy), so a test flips it BEFORE loading the module. Named with the `mock` prefix so jest's
// hoisting rule permits the reference. Default 'android' (the native path under test); the web
// case sets it to 'web' before `load()`.
let mockPlatformOS = 'android';
jest.mock('react-native', () => ({
  // walletconnect.ts imports ONLY `Platform` from react-native — mock the surface minimally.
  Platform: {OS: mockPlatformOS},
}));

const PROJECT_ID = 'test-project-id';
// Typed as an EIP-1193 `request` (Promise-returning) so `.mockResolvedValue` type-checks; the
// implementation is thrown away once a test calls mockResolvedValue/mockResolvedValueOnce on it.
const FAKE_REQUEST = jest.fn((_args: {method: string; params?: unknown[] | object}) =>
  Promise.resolve('0x1' as unknown),
);
const FAKE_PROVIDER = {request: FAKE_REQUEST} as unknown as Eip1193Provider;

/** Re-evaluate `walletconnect.ts` with `projectId` baked into constants + `mockPlatformOS` set. */
function load(id: string): {
  getWalletConnectProvider: () => Promise<Eip1193Provider | null>;
  init: jest.MockedFunction<(opts?: unknown) => Promise<unknown>>;
} {
  let out!: {
    getWalletConnectProvider: () => Promise<Eip1193Provider | null>;
    init: jest.MockedFunction<(opts?: unknown) => Promise<unknown>>;
  };
  jest.isolateModules(() => {
    if (id) {
      (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = id;
    } else {
      delete (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID;
    }
    // The stub is re-evaluated inside isolateModules → a fresh jest.fn. Grab it so the test can
    // configure + assert on the SAME instance walletconnect.ts captured at import time.
    const stub = require('@walletconnect/ethereum-provider');
    out = {
      init: stub.EthereumProvider.init,
      getWalletConnectProvider: require('../walletconnect').getWalletConnectProvider,
    };
  });
  return out;
}

beforeEach(() => {
  FAKE_REQUEST.mockClear();
  FAKE_REQUEST.mockResolvedValue('0x1');
});
afterEach(() => {
  mockPlatformOS = 'android';
  delete (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID;
});

describe('getWalletConnectProvider — (1) disabled guard', () => {
  test('empty projectId → null and init is never called', async () => {
    const {init, getWalletConnectProvider} = load('');
    const result = await getWalletConnectProvider();
    expect(result).toBeNull();
    expect(init).not.toHaveBeenCalled();
  });

  test('web Platform → null and init is never called (even with a projectId set)', async () => {
    mockPlatformOS = 'web';
    const {init, getWalletConnectProvider} = load(PROJECT_ID);
    const result = await getWalletConnectProvider();
    expect(result).toBeNull();
    expect(init).not.toHaveBeenCalled();
  });
});

describe('getWalletConnectProvider — (2) singleton (init exactly once)', () => {
  test('two calls → EthereumProvider.init invoked exactly once (cached init promise)', async () => {
    const {init, getWalletConnectProvider} = load(PROJECT_ID);
    init.mockResolvedValue(FAKE_PROVIDER);
    // Both calls are made before either resolves; the module-level cache means the second sees the
    // init promise the first created → init fires exactly once.
    const [a, b] = await Promise.all([getWalletConnectProvider(), getWalletConnectProvider()]);
    expect(a).toBe(b); // same resolved provider (both awaited the one cached init promise)
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        chains: [1],
        optionalChains: [1],
        showQrModal: true,
      }),
    );
  });
});

describe('getWalletConnectProvider — (3) EIP-1193 surface', () => {
  test('the returned provider exposes a working request({method,params}) -> Promise', async () => {
    const {init, getWalletConnectProvider} = load(PROJECT_ID);
    init.mockResolvedValue(FAKE_PROVIDER);
    const provider = await getWalletConnectProvider();
    expect(provider).not.toBeNull();
    expect(typeof (provider as Eip1193Provider).request).toBe('function');
    await (provider as Eip1193Provider).request({method: 'eth_chainId', params: []});
    expect(FAKE_REQUEST).toHaveBeenCalledWith({method: 'eth_chainId', params: []});
  });
});

// NOTE — out of scope (outer-loop gate): the WalletConnect PAIRING itself (QR modal → wallet app
// handshake → encrypted session over the WC relay) requires a real wallet + network and cannot be
// exercised offline. These tests pin the provider CONTRACT (disabled guard / singleton / EIP-1193
// surface) using a stubbed `EthereumProvider.init`; the live pairing is a device/outer-loop
// fidelity gate, the same way the NFC radio hop and the ETH tx-mining hop are.
