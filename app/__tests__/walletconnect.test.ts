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
 * `WALLETCONNECT_PROJECT_ID` is a module-load const, so each case re-evaluates `walletconnect.ts`
 * inside `jest.isolateModules` with the desired override. `@walletconnect/ethereum-provider` resolves to the typed
 * `__stubs__/walletconnect-stub.ts` (jest.config.js moduleNameMapper), whose `EthereumProvider.init`
 * IS `FAKE_INIT`, so NO real WalletConnect code executes and the test asserts on the same typed
 * `jest.fn` instance `walletconnect.ts` captured at import time.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import type {Eip1193Provider} from '../wallet';
import {FakeEthereumProvider, FAKE_INIT} from './walletconnect-fake';

// Controllable `Platform.OS`. `jest.mock` is hoisted; the factory reads this at require time
// (lazy), so a test flips it BEFORE loading the module. Named with the `mock` prefix so jest's
// hoisting rule permits the reference. Default 'android' (the native path under test); the web
// case sets it to 'web' before `load()`.
let mockPlatformOS = 'android';
const mockLinkingOpenURL = jest.fn<(uri: string) => Promise<void>>();
jest.mock('react-native', () => ({
  // walletconnect.ts imports `Platform` + `Linking` from react-native — mock both minimally.
  Platform: {OS: mockPlatformOS},
  Linking: {openURL: mockLinkingOpenURL},
}));

const PROJECT_ID = 'test-project-id';

/** The typed init mock shape exported by the stub (a `jest.MockedFunction`, arg = real options). */
type InitMock = typeof FAKE_INIT;

/** Re-evaluate `walletconnect.ts` with `projectId` baked into constants + `mockPlatformOS` set. */
function load(id: string): {
  getWalletConnectProvider: (chainId?: number) => Promise<Eip1193Provider | null>;
  pairWalletConnect: (
    onUri: (uri: string | null) => void,
    chainId?: number,
  ) => Promise<void>;
  disconnectWalletConnect: () => Promise<void>;
  openWalletApp: (uri: string) => Promise<boolean>;
  pairTimeoutMs: number;
  init: InitMock;
} {
  let out!: {
    getWalletConnectProvider: (chainId?: number) => Promise<Eip1193Provider | null>;
    pairWalletConnect: (
      onUri: (uri: string | null) => void,
      chainId?: number,
    ) => Promise<void>;
    disconnectWalletConnect: () => Promise<void>;
    openWalletApp: (uri: string) => Promise<boolean>;
    pairTimeoutMs: number;
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
    const mod = require('../walletconnect') as {
      getWalletConnectProvider: (chainId?: number) => Promise<Eip1193Provider | null>;
      pairWalletConnect: (
        onUri: (uri: string | null) => void,
        chainId?: number,
      ) => Promise<void>;
      disconnectWalletConnect: () => Promise<void>;
      openWalletApp: (uri: string) => Promise<boolean>;
      PAIR_TIMEOUT_MS: number;
    };
    out = {
      init: stub.EthereumProvider.init,
      getWalletConnectProvider: mod.getWalletConnectProvider,
      pairWalletConnect: mod.pairWalletConnect,
      disconnectWalletConnect: mod.disconnectWalletConnect,
      openWalletApp: mod.openWalletApp,
      pairTimeoutMs: mod.PAIR_TIMEOUT_MS,
    };
  });
  return out;
}

afterEach(() => {
  mockPlatformOS = 'android';
  mockLinkingOpenURL.mockReset();
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
    // init promise the first created → init fires exactly once. Default chainId=1 (mainnet).
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

  // OPEN_ISSUES #1/#2 — the chains parameterization. A Sepolia ckERC20 (chain_id 11155111) MUST seed
  // `chains:[11155111]` so the WC session binds to Sepolia (a mainnet-only session would force a
  // network switch, and the chain-id gate in CkErc20DepositSheet aborts a wrong-network wallet). The
  // default (no arg) stays mainnet (chains:[1]) — pinned by the test above. This case is RED under
  // the pre-testnet code (which hardcoded chains:[1] regardless of the arg).
  test('chainId=11155111 → init seeds chains:[11155111] (Sepolia testnet wiring)', async () => {
    const {init, getWalletConnectProvider} = load(PROJECT_ID);
    init.mockResolvedValue(new FakeEthereumProvider());
    await getWalletConnectProvider(11155111);
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        chains: [11155111],
        optionalChains: [11155111],
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

// --- PR3 — provider.connect() is dpay-bounded (no infinite spinner) ----------------------------
// Without a dpay-side bound, a wallet that never scans the QR leaves `provider.connect()` pending
// forever (relying silently on the SDK's internal pairing-topic TTL). PR3 wraps it in Promise.race
// with PAIR_TIMEOUT_MS (5min) so the user sees an honest "timed out" error. Listeners + the timer
// are cleaned up in `finally` on both the happy path and the timeout.
describe('pairWalletConnect — PR3 pair timeout', () => {
  test('times out after PAIR_TIMEOUT_MS when connect() never resolves (wallet never scanned)', async () => {
    jest.useFakeTimers();
    try {
      const fake = new FakeEthereumProvider();
      const {init, pairWalletConnect, pairTimeoutMs} = load(PROJECT_ID);
      init.mockResolvedValue(fake);
      // connect() never settles: the wallet never scanned the QR.
      fake.connect.mockImplementation(() => new Promise<void>(() => {}));

      const onUri = jest.fn();
      const p = pairWalletConnect(onUri);
      // `pairWalletConnect` is async: it has run synchronously to its first `await cachedProvider`
      // and then suspended (the listeners + the timeout timer are scheduled AFTER that await). The
      // async variant of advanceTimersByTime drains pending microtasks first → the function resumes
      // past the await, registers the listeners, schedules the setTimeout, and settles into the
      // Promise.race; then advancing past PAIR_TIMEOUT_MS fires the timeout → the race rejects →
      // the catch wraps it → pairWalletConnect rejects with an honest "timed out" message.
      //
      // Register the rejection assertion BEFORE firing the timer: under fake timers the rejection
      // lands during `advanceTimersByTimeAsync`, and an unattached rejection would surface as an
      // unhandled-rejection test failure before a later `await expect(p).rejects` could catch it.
      const assertion = expect(p).rejects.toThrow(/timed out/i);
      await jest.advanceTimersByTimeAsync(pairTimeoutMs);
      await assertion;

      // Cleanup still runs on timeout (listeners + the timer cleared in `finally`).
      expect(fake.removeListener).toHaveBeenCalledWith('display_uri', expect.any(Function));
      expect(fake.removeListener).toHaveBeenCalledWith('connect', expect.any(Function));
    } finally {
      jest.useRealTimers();
    }
  });

  test('PAIR_TIMEOUT_MS is the documented 5-minute bound (mirrors the SDK pairing-topic TTL)', () => {
    const {pairTimeoutMs} = load(PROJECT_ID);
    expect(pairTimeoutMs).toBe(5 * 60 * 1000);
  });
});

// --- U6.5 — disconnectWalletConnect (clear cache + provider.disconnect) ------------------------
// `cachedProvider` was previously NEVER cleared: a pairing left mid-flight (or a dropped session)
// wedged the cache so the next open reused a dead provider. U6.5 adds a teardown helper that calls
// `provider.disconnect()` AND nulls the cache, forcing a fresh `init` on the next open. Idempotent
// and safe to fire-and-forget from a React unmount cleanup (swallows disconnect failures).
describe('disconnectWalletConnect — U6.5 (clear cache + provider.disconnect)', () => {
  test('clears the cached provider and calls provider.disconnect() exactly once', async () => {
    const fake = new FakeEthereumProvider();
    const {init, getWalletConnectProvider, disconnectWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    await getWalletConnectProvider(); // prime the cache
    await disconnectWalletConnect();
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    // Cache cleared → a subsequent get re-inits (init fires again with a fresh provider).
    init.mockClear();
    init.mockResolvedValue(new FakeEthereumProvider());
    await getWalletConnectProvider();
    expect(init).toHaveBeenCalledTimes(1);
  });

  test('no-op when no provider is cached (never initialized)', async () => {
    const {init, disconnectWalletConnect} = load(PROJECT_ID);
    await expect(disconnectWalletConnect()).resolves.toBeUndefined();
    expect(init).not.toHaveBeenCalled();
  });

  test('empty projectId → no-op (disabled guard)', async () => {
    const {init, disconnectWalletConnect} = load('');
    await expect(disconnectWalletConnect()).resolves.toBeUndefined();
    expect(init).not.toHaveBeenCalled();
  });

  test('web Platform → no-op (disabled guard, even with a projectId set)', async () => {
    mockPlatformOS = 'web';
    const {init, disconnectWalletConnect} = load(PROJECT_ID);
    await expect(disconnectWalletConnect()).resolves.toBeUndefined();
    expect(init).not.toHaveBeenCalled();
  });

  test('idempotent — a second call is a no-op (cache already cleared by the first)', async () => {
    const fake = new FakeEthereumProvider();
    const {init, getWalletConnectProvider, disconnectWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    await getWalletConnectProvider();
    await disconnectWalletConnect();
    await disconnectWalletConnect(); // second call: cache is null → no-op
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  test('swallows a provider.disconnect failure (cache still cleared, no throw to caller)', async () => {
    const fake = new FakeEthereumProvider();
    fake.disconnect.mockRejectedValue(new Error('session already closed'));
    const {init, getWalletConnectProvider, disconnectWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    await getWalletConnectProvider();
    // Must NOT throw — the helper is called fire-and-forget from a React unmount cleanup where an
    // unhandled rejection would be invisible + noisy.
    await expect(disconnectWalletConnect()).resolves.toBeUndefined();
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    // Cache cleared despite the failure → next get re-inits.
    init.mockClear();
    init.mockResolvedValue(new FakeEthereumProvider());
    await getWalletConnectProvider();
    expect(init).toHaveBeenCalledTimes(1);
  });
});

// --- openWalletApp — same-device pairing via OS intent chooser -------------------------------
// `openWalletApp(uri)` is the same-device alternative to scanning the QR: it calls Linking.openURL
// with the wc: URI, routing to an installed wallet on Android via the system intent. Returns true on
// success, false if no wallet is registered (the caller keeps the QR visible for cross-device scan).
describe('openWalletApp — same-device pairing via OS intent', () => {
  test('calls Linking.openURL with the wc: URI and returns true', async () => {
    const {openWalletApp} = load(PROJECT_ID);
    mockLinkingOpenURL.mockResolvedValue(undefined);
    const result = await openWalletApp('wc:abcdef@2?relay-protocol=…&symKey=…');
    expect(mockLinkingOpenURL).toHaveBeenCalledWith('wc:abcdef@2?relay-protocol=…&symKey=…');
    expect(result).toBe(true);
  });

  test('web Platform → returns false without calling Linking.openURL (disabled guard)', async () => {
    mockPlatformOS = 'web';
    const {openWalletApp} = load(PROJECT_ID);
    const result = await openWalletApp('wc:test');
    expect(result).toBe(false);
    expect(mockLinkingOpenURL).not.toHaveBeenCalled();
  });

  test('returns false when no wallet app is registered (Linking.openURL rejects)', async () => {
    const {openWalletApp} = load(PROJECT_ID);
    mockLinkingOpenURL.mockRejectedValue(new Error('No activity found to handle Intent { wc:… }'));
    const result = await openWalletApp('wc:no-wallet');
    expect(result).toBe(false);
  });
});

// --- PR13 — redirect.native deep-link literal pinned to the build.gradle applicationId ---------
// The wallet's "return to dpay" deep-link depends on redirect.native matching the applicationId. A
// drift breaks it SILENTLY (no error, just a dead tap). This pins the literal so a future change to
// ANDROID_DEEP_LINK is visible here (and points the reader at build.gradle to cross-check).
describe('initProvider — PR13 deep-link redirect', () => {
  test('passes redirect.native = "org.kalaj.dpay://" (the build.gradle applicationId + "://")', async () => {
    // Cross-reference: app/android/app/build.gradle → applicationId "org.kalaj.dpay".
    const {init, getWalletConnectProvider} = load(PROJECT_ID);
    init.mockResolvedValue(new FakeEthereumProvider());
    await getWalletConnectProvider();
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          redirect: {native: 'org.kalaj.dpay://'},
        }),
      }),
    );
  });
});

// NOTE — out of scope (outer-loop gate): the WalletConnect PAIRING itself (QR modal → wallet app
// handshake → encrypted session over the WC relay) requires a real wallet + network and cannot be
// exercised offline. These tests pin the provider CONTRACT (disabled guard / singleton / EIP-1193
// surface) using the typed `FakeEthereumProvider`/`FAKE_INIT`; the live pairing is a device/outer-
// loop fidelity gate, the same way the NFC radio hop and the ETH tx-mining hop are.
