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
 * MC8 U6.2 hardening: the provider double is `FakeEthereumProvider` (in `./walletconnect-fake`),
 * which `implements Pick<InstanceType<typeof EthereumProvider>, 'request'|'enable'|'connect'|
 * 'disconnect'>` — i.e. it is tsc-checked against the REAL SDK instance surface, not a hand-rolled
 * `{request} as unknown as Eip1193Provider` shape that could drift undetected. `init` is the typed
 * `FAKE_INIT` (its arg is the genuine `EthereumProviderOptions`).
 *
 * `WALLETCONNECT_PROJECT_ID` is a module-load const (mirrors `EXPECTED_RECEIPT_PUBKEY`), so each
 * case re-evaluates `walletconnect.ts` inside `jest.isolateModules` with the desired override — the
 * same pattern `receipt.test.ts` uses. `@walletconnect/ethereum-provider` resolves to the typed
 * `__stubs__/walletconnect-stub.ts` (jest.config.js moduleNameMapper), whose `EthereumProvider.init`
 * IS `FAKE_INIT`, so NO real WalletConnect code executes and the test asserts on the same typed
 * `jest.fn` instance `walletconnect.ts` captured at import time.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import type {EthereumProviderOptions} from '@walletconnect/ethereum-provider';
import type {Eip1193Provider} from '../wallet';
import {FakeEthereumProvider, FAKE_INIT} from './walletconnect-fake';

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

/** The typed init mock shape exported by the stub (a `jest.MockedFunction`, arg = real options). */
type InitMock = typeof FAKE_INIT;

/** Re-evaluate `walletconnect.ts` with `projectId` baked into constants + `mockPlatformOS` set. */
function load(id: string): {
  getWalletConnectProvider: () => Promise<Eip1193Provider | null>;
  init: InitMock;
} {
  let out!: {
    getWalletConnectProvider: () => Promise<Eip1193Provider | null>;
    init: InitMock;
  };
  jest.isolateModules(() => {
    if (id) {
      (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = id;
    } else {
      delete (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID;
    }
    // The stub is re-evaluated inside isolateModules → a fresh FAKE_INIT jest.fn. Grab it so the
    // test can configure + assert on the SAME instance walletconnect.ts captured at import time.
    // One cast on the untyped CJS `require` boundary (connects it to the typed fake) — NOT a
    // type-safety hole: the shape is pinned by FAKE_INIT's real-EthereumProviderOptions signature.
    const stub = require('@walletconnect/ethereum-provider') as {
      EthereumProvider: {init: InitMock};
    };
    out = {
      init: stub.EthereumProvider.init,
      getWalletConnectProvider: require('../walletconnect').getWalletConnectProvider,
    };
  });
  return out;
}

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
    // The typed fake factory resolves a FakeEthereumProvider — type-checked against the real init
    // arg signature (EthereumProviderOptions), so an SDK signature change breaks compilation.
    init.mockResolvedValue(new FakeEthereumProvider());
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
    const fake = new FakeEthereumProvider();
    const {init, getWalletConnectProvider} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    const provider = await getWalletConnectProvider();
    expect(provider).not.toBeNull();
    // Single narrowing cast after a runtime null check (NOT the old `as unknown as` double-cast):
    // FakeEthereumProvider implements the real `request`, so it is assignable to Eip1193Provider.
    const p = provider as Eip1193Provider;
    await p.request({method: 'eth_chainId', params: []});
    expect(fake.request).toHaveBeenCalledWith({method: 'eth_chainId', params: []});
  });
});

// NOTE — out of scope (outer-loop gate): the WalletConnect PAIRING itself (QR modal → wallet app
// handshake → encrypted session over the WC relay) requires a real wallet + network and cannot be
// exercised offline. These tests pin the provider CONTRACT (disabled guard / singleton / EIP-1193
// surface) using the typed `FakeEthereumProvider`/`FAKE_INIT`; the live pairing is a device/outer-
// loop fidelity gate, the same way the NFC radio hop and the ETH tx-mining hop are.
