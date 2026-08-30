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
import {readFileSync} from 'fs';
import {join} from 'path';
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import type {Eip1193Provider, KnownWallet} from '../wallet';
import {M} from '../i18n';
import {FakeEthereumProvider, FAKE_INIT, fakeSession} from './walletconnect-fake';

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

/** The module surface `load()` hands back — declared once, used for both the local and the return. */
type Loaded = {
  getWalletConnectProvider: (chainId?: number) => Promise<Eip1193Provider | null>;
  pairWalletConnect: (
    onUri: (uri: string | null) => void,
    chainId?: number,
  ) => Promise<void>;
  disconnectWalletConnect: () => Promise<void>;
  openWalletApp: (uri: string) => Promise<boolean>;
  recordWalletChoice: (wallet: KnownWallet) => Promise<void>;
  pairTimeoutMs: number;
  androidDeepLink: string;
  deepLinkChoiceKey: string;
  init: InitMock;
  /**
   * The ISOLATED `wallet.ts` the isolated `walletconnect.ts` imported. `instanceof` compares class
   * IDENTITY, and each `jest.isolateModules` registry evaluates its own copy of `wallet.ts` — so a
   * class captured from the outer import would never match the one actually thrown. Typed as the
   * real module so the error constructors need no restated signature.
   */
  wallet: typeof import('../wallet');
};

/**
 * A wallet approving `chainId` — the CAIP-10 session `connect()` leaves behind on success, and the
 * one a restored session carries. `pairWalletConnect` reads exactly this to decide reuse vs re-pair
 * and to verify the approval, so every pairing test has to leave one.
 */
function approve(fake: FakeEthereumProvider, chainId: number, address = '0xb0bfeed'): void {
  fake.session = fakeSession({eip155: [`eip155:${chainId}:${address}`]});
}

/** Re-evaluate `walletconnect.ts` with `projectId` baked into constants + `mockPlatformOS` set. */
function load(id: string): Loaded {
  let out!: Loaded;
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
    const mod = require('../walletconnect') as Omit<
      Loaded,
      'init' | 'pairTimeoutMs' | 'androidDeepLink' | 'deepLinkChoiceKey' | 'wallet'
    > & {
      PAIR_TIMEOUT_MS: number;
      ANDROID_DEEP_LINK: string;
      WALLETCONNECT_DEEPLINK_CHOICE: string;
    };
    out = {
      init: stub.EthereumProvider.init,
      getWalletConnectProvider: mod.getWalletConnectProvider,
      pairWalletConnect: mod.pairWalletConnect,
      disconnectWalletConnect: mod.disconnectWalletConnect,
      openWalletApp: mod.openWalletApp,
      recordWalletChoice: mod.recordWalletChoice,
      pairTimeoutMs: mod.PAIR_TIMEOUT_MS,
      androidDeepLink: mod.ANDROID_DEEP_LINK,
      deepLinkChoiceKey: mod.WALLETCONNECT_DEEPLINK_CHOICE,
      // Same registry as `mod` (walletconnect.ts imports it), so the classes here ARE the ones it
      // throws — see the `wallet` field's note on `instanceof` and module identity.
      wallet: require('../wallet') as typeof import('../wallet'),
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
      // ProviderInfo {chainId}) when the wallet approves the session, and leaves the settled
      // session behind (the approved-chain check below reads it).
      fake.emit('display_uri', 'wc:abcdef-1234@2?relay-protocol=…&symKey=…');
      fake.emit('connect', {chainId: '0x1'});
      approve(fake, 1);
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
      approve(fake, 1);
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
    // A TRANSPORT failure, deliberately not a user rejection: this case owns the cleanup contract,
    // and the rejection-vs-other classification is owned by its own describe below.
    fake.connect.mockRejectedValue(new Error('relay unreachable'));

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
      approve(fake, 1);
    });

    await pairWalletConnect(jest.fn());

    expect(fake.removeListener).toHaveBeenCalledWith('display_uri', expect.any(Function));
    expect(fake.removeListener).toHaveBeenCalledWith('connect', expect.any(Function));
  });

  test('no display_uri event (a wallet that settles over a deep link) → onUri never called, still resolves', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    // connect() settles the session without either event firing — no QR was ever needed.
    fake.connect.mockImplementation(async () => approve(fake, 1));

    const onUri = jest.fn();
    await pairWalletConnect(onUri);
    expect(onUri).not.toHaveBeenCalled();
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });
});

// --- session reuse / re-pair / the approved-chain check ---------------------------------------
// Two bugs met here. (1) `connect()` was called UNCONDITIONALLY, so a live or restored session
// produced a fresh approval prompt in the wallet every time the deposit sheet opened. (2) the
// sheet's network gate reads `eth_chainId`, which checks NOTHING on this transport (why:
// `getChainId` in wallet.ts). What the wallet approved is in the session's namespaces, and that is
// what these pin: reuse when it covers the chain, tear down and re-pair when it does not, and an
// honest refusal when the settled session still does not cover it.
describe('pairWalletConnect — session states + the approved-chain check', () => {
  test('(b) a session already approving the chain is reused — no connect(), no QR, no re-init', async () => {
    const fake = new FakeEthereumProvider();
    approve(fake, 1); // the session restored at init (or left by an earlier pair)
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);

    const onUri = jest.fn();
    await pairWalletConnect(onUri, 1);

    expect(fake.connect).not.toHaveBeenCalled(); // ← the wallet is NOT prompted again
    expect(fake.disconnect).not.toHaveBeenCalled();
    expect(onUri).not.toHaveBeenCalled(); // no pairing URI ⇒ the sheet renders no QR
    expect(init).toHaveBeenCalledTimes(1);
  });

  test('(b) a chain-scoped namespace key (eip155:11155111) is read like a bare eip155 one', async () => {
    const fake = new FakeEthereumProvider();
    // WC v2 permits either keying; only the accounts inside carry the approval.
    fake.session = fakeSession({'eip155:11155111': ['eip155:11155111:0xb0bfeed']});
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);

    await pairWalletConnect(jest.fn(), 11155111);
    expect(fake.connect).not.toHaveBeenCalled();
  });

  test('(c) a session approving another chain is torn down and re-paired on the requested one', async () => {
    const stale = new FakeEthereumProvider();
    approve(stale, 1); // an earlier mainnet ckUSDC deposit
    const fresh = new FakeEthereumProvider();
    fresh.connect.mockImplementation(async () => {
      fresh.emit('display_uri', 'wc:sepolia-pairing');
      approve(fresh, 11155111);
    });
    const {init, getWalletConnectProvider, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);

    await getWalletConnectProvider(1); // prime the cache the way the mainnet deposit did
    const uris: (string | null)[] = [];
    await pairWalletConnect((uri) => uris.push(uri), 11155111); // now a Sepolia deposit

    expect(stale.disconnect).toHaveBeenCalledTimes(1); // the mainnet session is dropped…
    expect(stale.connect).not.toHaveBeenCalled(); // …never re-used for Sepolia
    expect(init).toHaveBeenNthCalledWith(1, expect.objectContaining({chains: [1]}));
    expect(init).toHaveBeenNthCalledWith(2, expect.objectContaining({chains: [11155111]}));
    expect(fresh.connect).toHaveBeenCalledTimes(1);
    expect(uris).toEqual(['wc:sepolia-pairing']); // a real pairing ⇒ a real QR
  });

  test('a settled session that approved a DIFFERENT chain is refused, naming both', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    // The wallet approved mainnet while the deposit settles on Sepolia — the state the sheet's
    // eth_chainId gate cannot see.
    fake.connect.mockImplementation(async () => approve(fake, 1));

    const err = await pairWalletConnect(jest.fn(), 11155111).catch((e: unknown) => e);
    // Exact copy, not a substring: it also proves the refusal is NOT wrapped as a pairing failure
    // (the check runs after the connect try/catch) and that both chain ids reach the message.
    expect((err as Error).message).toBe(M.errors.ethWallet.chainNotApproved(11155111, '1'));
  });

  test('connect() that settles no session at all is refused (nothing was approved)', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    fake.connect.mockResolvedValue(undefined); // resolves, but leaves no session behind

    const err = await pairWalletConnect(jest.fn(), 1).catch((e: unknown) => e);
    expect((err as Error).message).toBe(M.errors.ethWallet.chainNotApproved(1, ''));
  });
});

// --- typed pairing failures (the component switches on a TYPE, not on a regex) -----------------
// The deposit sheet used to classify a pair failure with `/reject|denied|user/i.test(msg)` — a
// string sniff over copy that is translated into four languages, i.e. a classifier that silently
// changes meaning whenever a translator edits a sentence. `pairWalletConnect` is the ONE place that
// holds the SDK's own error, so it decides once and throws a type. Both branches are pinned here.
describe('pairWalletConnect — typed failures', () => {
  test('a wallet-side rejection throws PairingRejected carrying the SDK detail', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect, wallet} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    // Verbatim what arrives here: the wallet answers the proposal with getSdkError('USER_REJECTED')
    // = {code:5000, message:'User rejected.'}, and EthereumProvider.connect() re-throws
    // `new Error(error.message)` — the code is GONE by this point, the message is all that is left.
    fake.connect.mockRejectedValue(new Error('User rejected.'));

    const err = await pairWalletConnect(jest.fn(), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(wallet.PairingRejected);
    expect((err as InstanceType<typeof wallet.PairingRejected>).detail).toBe('User rejected.');
  });

  test('a transport failure is NOT a rejection — plain Error with the pairing-failed message', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect, wallet} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    fake.connect.mockRejectedValue(new Error('WebSocket connection closed abnormally'));

    const err = await pairWalletConnect(jest.fn(), 1).catch((e: unknown) => e);
    // The user did NOT decline — telling them they did would be a lie, and it is what the old
    // regex did for any message containing "user".
    expect(err).not.toBeInstanceOf(wallet.PairingRejected);
    expect((err as Error).message).toBe(
      M.errors.ethWallet.pairingFailed('WebSocket connection closed abnormally'),
    );
  });

  test('a wrong-network approval throws ChainNotApproved carrying both chain sets', async () => {
    const fake = new FakeEthereumProvider();
    const {init, pairWalletConnect, wallet} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    fake.connect.mockImplementation(async () => approve(fake, 1)); // mainnet, for a Sepolia deposit

    const err = await pairWalletConnect(jest.fn(), 11155111).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(wallet.ChainNotApproved);
    // The fields exist so the caller can build its own copy without re-parsing the message string.
    const chainErr = err as InstanceType<typeof wallet.ChainNotApproved>;
    expect(chainErr.requested).toBe(11155111);
    expect(chainErr.approved).toEqual(['1']);
    // It is NOT a rejection: the user approved something, just not this network.
    expect(err).not.toBeInstanceOf(wallet.PairingRejected);
  });
});

// --- recordWalletChoice — the deeplink choice sign-client needs to foreground the wallet --------
// `@walletconnect/sign-client` foregrounds the wallet for a session request only when it can read
// WALLETCONNECT_DEEPLINK_CHOICE from its own storage (getDeepLink → handleDeeplinkRedirect, which
// returns immediately when the value is absent). Its only other writer is @reown/appkit, which dpay
// shims out — so without this write an `eth_sendTransaction` sits invisibly in a backgrounded
// wallet. These pin the KEY, the STORED SHAPE, and the fail-fast when nothing is paired.
describe('recordWalletChoice', () => {
  const TRUST: KnownWallet = {
    name: 'Trust Wallet',
    scheme: 'trust://',
    androidPackage: 'com.wallet.crypto.trustapp',
  };

  test('writes {href, name} under the deeplink-choice key on the SDK’s own storage', async () => {
    const fake = new FakeEthereumProvider();
    const {init, getWalletConnectProvider, recordWalletChoice, deepLinkChoiceKey} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    await getWalletConnectProvider(); // the pairing that produced the URI primes this cache

    await recordWalletChoice(TRUST);

    // `href` must be the BARE scheme: the consumer (`formatDeeplinkUrl`) appends
    // `/wc?requestId=…&sessionTopic=…` after stripping one trailing slash, so `trust://` becomes
    // `trust://wc?requestId=…`. Storing the pairing link instead would produce a dead URL.
    expect(fake.storage.setItem).toHaveBeenCalledWith(deepLinkChoiceKey, {
      href: 'trust://',
      name: 'Trust Wallet',
    });
  });

  test('the key matches the constant the SDK itself reads (drift alarm)', () => {
    const {deepLinkChoiceKey} = load(PROJECT_ID);
    // Read from the installed SDK rather than restated: sign-client declares it as a literal type,
    // so this is the single source the write has to agree with. It cannot be imported — jest's
    // moduleNameMapper sends every `@walletconnect/*` specifier to the stub.
    const declared = readFileSync(
      join(
        __dirname, '..', 'node_modules', '@walletconnect', 'sign-client',
        'dist', 'types', 'constants', 'client.d.ts',
      ),
      'utf8',
    );
    const match = /export declare const WALLETCONNECT_DEEPLINK_CHOICE = "([^"]+)"/.exec(declared);
    expect(match).not.toBeNull();
    expect(deepLinkChoiceKey).toBe((match as RegExpExecArray)[1]);
  });

  test('nothing is paired → fails fast, naming the ordering it needs', async () => {
    const {init, recordWalletChoice} = load(PROJECT_ID);
    // A choice recorded against no session would point the SDK at a wallet dpay never paired with.
    await expect(recordWalletChoice(TRUST)).rejects.toThrow(/recordWalletChoice/);
    expect(init).not.toHaveBeenCalled(); // and it must NOT init a provider as a side effect
  });

  test('empty projectId → no write (disabled guard)', async () => {
    const fake = new FakeEthereumProvider();
    const {init, recordWalletChoice} = load('');
    init.mockResolvedValue(fake);
    await expect(recordWalletChoice(TRUST)).resolves.toBeUndefined();
    expect(fake.storage.setItem).not.toHaveBeenCalled();
  });

  test('web Platform → no write (disabled guard, even with a projectId set)', async () => {
    mockPlatformOS = 'web';
    const fake = new FakeEthereumProvider();
    const {init, recordWalletChoice} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    await expect(recordWalletChoice(TRUST)).resolves.toBeUndefined();
    expect(fake.storage.setItem).not.toHaveBeenCalled();
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
    // Silenced, not asserted: the teardown log is pinned by its own case below — here it would only
    // be noise in the suite output.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Must NOT throw — the helper is called fire-and-forget from a React unmount cleanup where an
      // unhandled rejection would be invisible + noisy.
      await expect(disconnectWalletConnect()).resolves.toBeUndefined();
      expect(fake.disconnect).toHaveBeenCalledTimes(1);
      // Cache cleared despite the failure → next get re-inits.
      init.mockClear();
      init.mockResolvedValue(new FakeEthereumProvider());
      await getWalletConnectProvider();
      expect(init).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  // The recorded deeplink choice OUTLIVES the session unless teardown removes it: sign-client would
  // keep foregrounding a wallet the user is no longer paired with on the next request.
  test('deletes the recorded wallet choice as part of teardown', async () => {
    const fake = new FakeEthereumProvider();
    const {init, getWalletConnectProvider, disconnectWalletConnect, deepLinkChoiceKey} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    await getWalletConnectProvider();
    await disconnectWalletConnect();
    expect(fake.storage.removeItem).toHaveBeenCalledWith(deepLinkChoiceKey);
  });

  test('a rejecting disconnect() still leaves the choice deleted, and logs the cause', async () => {
    const fake = new FakeEthereumProvider();
    // The routine teardown failure (the session dropped on its own). It must not gate the deletion,
    // which is why the removal runs first — and it must not vanish silently either.
    fake.disconnect.mockRejectedValue(new Error('session already closed'));
    const {init, getWalletConnectProvider, disconnectWalletConnect, deepLinkChoiceKey} = load(PROJECT_ID);
    init.mockResolvedValue(fake);
    await getWalletConnectProvider();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await disconnectWalletConnect();
      expect(fake.storage.removeItem).toHaveBeenCalledWith(deepLinkChoiceKey);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('disconnectWalletConnect'),
        expect.stringContaining('session already closed'),
      );
    } finally {
      warn.mockRestore();
    }
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

// --- PR13 — the "return to dpay" redirect must be a scheme the device actually claims -----------
// It used to be the Android applicationId ("org.kalaj.dpay://"), which is not a URL scheme at all:
// nothing on the phone answered it, so after approving in the wallet the user was simply stranded
// there — no error, just a dead tap. The fix is only as good as its link to the manifest, so the
// scheme is DERIVED from the constant and looked up in the manifest rather than restated here.
describe('initProvider — PR13 deep-link redirect', () => {
  test('passes redirect.native = the exported ANDROID_DEEP_LINK', async () => {
    const {init, getWalletConnectProvider, androidDeepLink} = load(PROJECT_ID);
    init.mockResolvedValue(new FakeEthereumProvider());
    await getWalletConnectProvider();
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({redirect: {native: androidDeepLink}}),
      }),
    );
  });

  test('its scheme is declared in AndroidManifest.xml, unrestricted by host or path', async () => {
    const {androidDeepLink} = load(PROJECT_ID);
    // A bare `<scheme>://` is the only shape a wallet can open with nothing appended.
    expect(androidDeepLink).toMatch(/^[a-z][a-z0-9+.-]*:\/\/$/);
    const scheme = androidDeepLink.slice(0, -'://'.length);

    const manifest = readFileSync(
      join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf8',
    );
    const claimed = [...manifest.matchAll(/<data\b[^>]*\/>/g)]
      .map((m) => m[0])
      .filter((el) => el.includes(`android:scheme="${scheme}"`));
    expect(claimed).not.toEqual([]);
    // The app link (https) is host- + path-scoped, so it would NOT catch a bare return URL. At
    // least one claim on this scheme has to be unrestricted for the wallet's redirect to land.
    expect(claimed.some((el) => !/android:(host|pathPrefix|pathPattern|path)=/.test(el))).toBe(true);
  });
});

// NOTE — out of scope (outer-loop gate): the WalletConnect PAIRING itself (QR modal → wallet app
// handshake → encrypted session over the WC relay) requires a real wallet + network and cannot be
// exercised offline. These tests pin the provider CONTRACT (disabled guard / singleton / EIP-1193
// surface) using the typed `FakeEthereumProvider`/`FAKE_INIT`; the live pairing is a device/outer-
// loop fidelity gate, the same way the NFC radio hop and the ETH tx-mining hop are.
