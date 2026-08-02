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
  pairWalletConnect: (onUri: (uri: string | null) => void) => Promise<void>;
  init: InitMock;
} {
  let out!: {
    getWalletConnectProvider: () => Promise<Eip1193Provider | null>;
    pairWalletConnect: (onUri: (uri: string | null) => void) => Promise<void>;
    init: InitMock;
  };
  jest.isolateModules(() => {
    // ALWAYS set the override (even to '') — constants.ts now defaults to the REAL project id, so
    // deleting the override would ENABLE WC. `load('')` → '' disables WC (the disabled-guard test).
    (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = id;
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
      pairWalletConnect: require('../walletconnect').pairWalletConnect,
    };
  });
  return out;
}

afterEach(() => {
  mockPlatformOS = 'android';
  (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
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
        // MC8 U6 capstone — showQrModal:false: WC's built-in @reown/appkit modal is web-only and
        // unreachable on RN. We render the pairing URI ourselves via display_uri → custom <QRCode>.
        showQrModal: false,
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

// --- MC8 U6 capstone — pairWalletConnect (display_uri → custom QR) ---------------------------
// `pairWalletConnect(onUri)` drives the WC pairing with showQrModal:false: it subscribes to the
// provider's `display_uri` event (the SDK emits the WC URI as a plain string — see
// IProviderEvents.EventArguments.display_uri in the installed .d.ts), passes it to `onUri` so the
// sheet can render a custom on-brand <QRCode>, then calls `provider.connect()` (which initiates the
// pairing handshake). The `connect` event fires on session established → `onUri(null)` clears the
// QR. Listeners are cleaned up on both success and failure. The disabled guard (web/empty projectId)
// short-circuits without touching the provider.
describe('pairWalletConnect — disabled guard', () => {
  test('empty projectId → returns without calling connect', async () => {
    const {init, pairWalletConnect} = load('');
    const fake = new FakeEthereumProvider();
    init.mockResolvedValue(fake);
    const onUri = jest.fn();
    await pairWalletConnect(onUri);
    expect(onUri).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  test('web Platform → returns without calling connect (even with a projectId set)', async () => {
    mockPlatformOS = 'web';
    const {init, pairWalletConnect} = load(PROJECT_ID);
    const fake = new FakeEthereumProvider();
    init.mockResolvedValue(fake);
    const onUri = jest.fn();
    await pairWalletConnect(onUri);
    expect(onUri).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });
});

describe('pairWalletConnect — display_uri + connect event handling', () => {
  test('display_uri → onUri(string); connect → onUri(null); connect() is called', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);

    // `connect()` resolves immediately (the fake's default). The real SDK resolves connect() when
    // the session is established; we simulate the event ordering by emitting display_uri + connect
    // right after connect() is invoked.
    fake.connect.mockImplementation(async () => {
      // The SDK emits display_uri (with the WC pairing URI as a plain string) then connect (with
      // ProviderInfo {chainId}) when the wallet approves the session.
      fake.emit('display_uri', 'wc:abcdef-1234@2?relay-protocol=…&symKey=…');
      fake.emit('connect', {chainId: '0x1'});
    });

    const uris: (string | null)[] = [];
    await pairWalletConnect((uri) => uris.push(uri));

    // The display_uri payload (a plain string) was forwarded to onUri, then connect cleared it.
    expect(uris).toEqual(['wc:abcdef-1234@2?relay-protocol=…&symKey=…', null]);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.connect).toHaveBeenCalledWith();
  });

  test('registers display_uri + connect listeners BEFORE calling connect()', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    fake.connect.mockImplementation(async () => {
      // If the listeners weren't registered before connect(), these emits would be no-ops and onUri
      // would never fire → the assertion at the end would fail. This pins the subscribe-before-call
      // ordering (critical: missing display_uri means no QR shown; missing connect means no clear).
      fake.emit('display_uri', 'wc:test-uri');
      fake.emit('connect', {chainId: '0x1'});
    });

    const onUri = jest.fn();
    await pairWalletConnect(onUri);
    expect(onUri).toHaveBeenCalledWith('wc:test-uri');
    expect(onUri).toHaveBeenCalledWith(null);
  });

  test('a pair failure (connect rejects) throws and cleans up listeners', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    fake.connect.mockRejectedValue(new Error('user rejected'));

    const onUri = jest.fn();
    await expect(pairWalletConnect(onUri)).rejects.toThrow(/pairing/i);

    // Cleanup: both listeners removed after a failure (so a subsequent pair doesn't double-fire).
    expect(fake.removeListener).toHaveBeenCalledWith('display_uri', expect.any(Function));
    expect(fake.removeListener).toHaveBeenCalledWith('connect', expect.any(Function));
  });

  test('cleans up listeners after a successful pair', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    fake.connect.mockImplementation(async () => {
      fake.emit('display_uri', 'wc:uri');
      fake.emit('connect', {chainId: '0x1'});
    });

    await pairWalletConnect(jest.fn());

    expect(fake.removeListener).toHaveBeenCalledWith('display_uri', expect.any(Function));
    expect(fake.removeListener).toHaveBeenCalledWith('connect', expect.any(Function));
  });

  test('no display_uri event (e.g. already-paired session) → onUri never called, still resolves', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    // connect() resolves but neither display_uri nor connect fires (an already-paired provider
    // short-circuits). The function should still resolve cleanly.
    fake.connect.mockResolvedValue(undefined);

    const onUri = jest.fn();
    await pairWalletConnect(onUri);
    expect(onUri).not.toHaveBeenCalled();
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });
});

// NOTE — out of scope (outer-loop gate): the WalletConnect PAIRING itself (QR modal → wallet app
// handshake → encrypted session over the WC relay) requires a real wallet + network and cannot be
// exercised offline. These tests pin the provider CONTRACT (disabled guard / singleton / EIP-1193
// surface) using the typed `FakeEthereumProvider`/`FAKE_INIT`; the live pairing is a device/outer-
// loop fidelity gate, the same way the NFC radio hop and the ETH tx-mining hop are.
