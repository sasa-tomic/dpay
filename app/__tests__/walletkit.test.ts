/**
 * W1 step 2 — the wallet-side WalletKit seam (`walletkit.ts`), pinned OFFLINE (no relay, no real
 * SDK: every `@reown/*` / `@walletconnect/{core,utils}` specifier resolves to the typed stub via
 * jest.config.js's moduleNameMapper, the same belt-and-braces as the dApp side).
 *
 * What this suite pins:
 *   (1) DISABLED GUARD — empty projectId OR Platform 'web' → null/no-op, `WalletKit.init` is never
 *       called (the `walletconnect.ts` guard, mirrored).
 *   (2) ISOLATED CORE (MANDATORY, plan §2.1) — init constructs `new Core({projectId,
 *       customStoragePrefix: 'walletkit'})` and passes it to `WalletKit.init`, with dpay metadata
 *       + `redirect: {native: 'dpay://'}`. The distinct storage prefix is what keeps the
 *       wallet-side session/pairing stores separate from the dApp-side provider's.
 *   (3) SINGLETON — init exactly once across repeated calls; a REJECTED init drops the cache so
 *       the next call retries (the `walletconnect.ts` recovery).
 *   (4) TYPED EMITTER — init registers the `session_proposal` + `session_request` SDK listeners;
 *       onProposal/onRequest subscribers receive emitted payloads and unsubscribe cleanly.
 *   (5) SESSION API — pair delegates `{uri}`; approve builds namespaces via the SDK helper and
 *       calls approveSession; reject/respond/disconnect carry the real SDK error codes.
 *
 * The module double is `FakeWalletKit`/`FAKE_WALLETKIT_INIT` (`./walletkit-fake`), tsc-checked
 * against the REAL SDK surface, so an SDK signature change breaks `just typecheck` before it can
 * ship. `WALLETCONNECT_PROJECT_ID` is a module-load const, so each case re-evaluates
 * `walletkit.ts` inside `jest.isolateModules` with the desired override.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {
  FakeWalletKit,
  FAKE_CORE,
  FAKE_WALLETKIT_INIT,
  FAKE_BUILD_APPROVED_NAMESPACES,
} from './walletkit-fake';

// Controllable `Platform.OS` (the `walletconnect.test.ts` move). `jest.mock` is hoisted; the
// factory reads this at require time (lazy), so a test flips it BEFORE loading the module.
let mockPlatformOS = 'android';
jest.mock('react-native', () => ({
  // walletkit.ts imports `Platform` only.
  Platform: {OS: mockPlatformOS},
}));

const PROJECT_ID = 'test-project-id';

/** The module surface plus the stub mocks the test drives and asserts on. */
type Loaded = typeof import('../walletkit') & {
  init: typeof FAKE_WALLETKIT_INIT;
  core: typeof FAKE_CORE;
  buildApproved: typeof FAKE_BUILD_APPROVED_NAMESPACES;
  /** The FakeWalletKit the most recent init resolved (the instance the module cached). */
  kit: () => FakeWalletKit | undefined;
};

/** Re-evaluate `walletkit.ts` with `projectId` baked into constants + `mockPlatformOS` set. */
function load(id: string): Loaded {
  let out!: Loaded;
  jest.isolateModules(() => {
    // ALWAYS set the override (even to '') — constants.ts now defaults to the REAL project id, so
    // deleting the override would ENABLE the wallet side. `load('')` → '' disables it.
    (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = id;
    // The stubs re-evaluate inside isolateModules → fresh jest.fns. Grab them so the test
    // configures + asserts on the SAME instances `walletkit.ts` captured at import time.
    const stub = require('@reown/walletkit') as {
      WalletKit: {init: typeof FAKE_WALLETKIT_INIT};
    };
    const coreStub = require('@walletconnect/core') as {Core: typeof FAKE_CORE};
    const utilsStub = require('@walletconnect/utils') as {
      buildApprovedNamespaces: typeof FAKE_BUILD_APPROVED_NAMESPACES;
    };
    // The fake is ALSO re-evaluated inside isolateModules (the stub requires it) — grab ITS copy of
    // the recorder, not the outer-registry one this file imported.
    const fake = require('./walletkit-fake') as typeof import('./walletkit-fake');
    const mod = require('../walletkit') as typeof import('../walletkit');
    out = {
      ...mod,
      init: stub.WalletKit.init,
      core: coreStub.Core,
      buildApproved: utilsStub.buildApprovedNamespaces,
      // The fake records each resolved instance at creation (a mock result would carry the
      // PROMISE); this reads the one the just-loaded module registry created.
      kit: () => fake.lastFakeWalletKit(),
    };
  });
  return out;
}

afterEach(() => {
  mockPlatformOS = 'android';
  (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
});

/**
 * A `session_proposal` payload shaped EXACTLY like the SDK event (typed as the real
 * `WcProposal`): id + params + verifyContext (the SDK omits `topic` on proposals). Only the
 * fields the assertions read are filled with content; the rest are inert protocol fixtures.
 */
function fakeProposal(id = 42): import('../walletkit').WcProposal {
  const metadata = {name: 'fake-dapp', description: 'fake', url: 'https://fake.invalid', icons: []};
  return {
    id,
    params: {
      id,
      expiryTimestamp: 0,
      relays: [{protocol: 'irn'}],
      proposer: {publicKey: 'fake-proposer-key', metadata},
      requiredNamespaces: {},
      optionalNamespaces: {},
      pairingTopic: 'fake-pairing-topic',
    },
    verifyContext: {
      verified: {origin: 'https://fake.invalid', validation: 'UNKNOWN', verifyUrl: ''},
    },
  };
}

describe('initWalletKit — (1) disabled guard', () => {
  test('empty projectId → null and WalletKit.init is never called', async () => {
    const {initWalletKit, init, core} = load('');
    await expect(initWalletKit()).resolves.toBeNull();
    expect(init).not.toHaveBeenCalled();
    expect(core).not.toHaveBeenCalled();
  });

  test('web Platform → null and WalletKit.init is never called (even with a projectId set)', async () => {
    mockPlatformOS = 'web';
    const {initWalletKit, init, core} = load(PROJECT_ID);
    await expect(initWalletKit()).resolves.toBeNull();
    expect(init).not.toHaveBeenCalled();
    expect(core).not.toHaveBeenCalled();
  });

  test('disabled → pair/respond/reject are honest no-ops, discover is null', async () => {
    const {pair, respondSessionRequest, rejectSession, discover, init} = load('');
    await expect(pair('wc:faketest')).resolves.toBe(false);
    await expect(respondSessionRequest('topic', {id: 1, jsonrpc: '2.0', result: null})).resolves.toBeUndefined();
    await expect(rejectSession(fakeProposal())).resolves.toBeUndefined();
    await expect(discover()).resolves.toBeNull();
    expect(init).not.toHaveBeenCalled();
  });
});

describe('initWalletKit — (2) isolated core + metadata (the plan §2.1 pin)', () => {
  test('init constructs Core({projectId, customStoragePrefix: "walletkit"}) and passes it with dpay metadata', async () => {
    const {initWalletKit, init, core} = load(PROJECT_ID);
    await initWalletKit();
    expect(init).toHaveBeenCalledTimes(1);
    // THE ISOLATION MANDATE: a distinct FIXED storage prefix. The default-prefix Core would be
    // globally shared with the dApp-side provider and corrupt its session/pairing stores.
    expect(core).toHaveBeenCalledTimes(1);
    expect(core).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      customStoragePrefix: 'walletkit',
    });
    expect(init).toHaveBeenCalledWith({
      core: expect.objectContaining({projectId: PROJECT_ID, customStoragePrefix: 'walletkit'}),
      metadata: {
        name: 'dpay',
        description: 'dpay non-custodial wallet',
        url: 'https://dpay.kalaj.org',
        icons: [],
        redirect: {native: 'dpay://'}, // the scheme AndroidManifest.xml actually claims
      },
    });
  });

  test('init registers exactly one session_proposal and one session_request SDK listener', async () => {
    const {initWalletKit, kit} = load(PROJECT_ID);
    await initWalletKit();
    expect(kit()?.listenersFor('session_proposal')).toBe(1);
    expect(kit()?.listenersFor('session_request')).toBe(1);
  });
});

describe('initWalletKit — (3) singleton + failure recovery', () => {
  test('repeated calls init exactly once and resolve the same instance', async () => {
    const {initWalletKit, init} = load(PROJECT_ID);
    const [a, b] = await Promise.all([initWalletKit(), initWalletKit()]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(init).toHaveBeenCalledTimes(1);
  });

  test('a rejected init drops the cache so the next call retries', async () => {
    const {initWalletKit, init} = load(PROJECT_ID);
    init.mockRejectedValueOnce(new Error('relay unreachable'));
    await expect(initWalletKit()).rejects.toThrow('relay unreachable');
    const second = await initWalletKit();
    expect(second).not.toBeNull();
    expect(init).toHaveBeenCalledTimes(2);
  });
});

describe('typed emitter — onProposal / onRequest', () => {
  test('subscribers receive emitted payloads; unsubscribe stops delivery', async () => {
    const {initWalletKit, onProposal, onRequest, kit} = load(PROJECT_ID);
    await initWalletKit();
    const proposals: unknown[] = [];
    const requests: unknown[] = [];
    const offProposal = onProposal((p) => proposals.push(p));
    const offRequest = onRequest((r) => requests.push(r));

    const proposalPayload = fakeProposal(7);
    const requestPayload = {topic: 't', params: {request: {}}, id: 9};
    kit()!.emit('session_proposal', proposalPayload);
    kit()!.emit('session_request', requestPayload);
    expect(proposals).toEqual([proposalPayload]);
    expect(requests).toEqual([requestPayload]);

    offProposal();
    offRequest();
    kit()!.emit('session_proposal', fakeProposal(8));
    kit()!.emit('session_request', {topic: 't', params: {request: {}}, id: 10});
    expect(proposals).toHaveLength(1); // no further delivery
    expect(requests).toHaveLength(1);
  });

  test('subscribing BEFORE init resolves still receives events (listeners are array-fed at emit time)', async () => {
    const {initWalletKit, onProposal, kit} = load(PROJECT_ID);
    const seen: unknown[] = [];
    onProposal((p) => seen.push(p)); // before init
    await initWalletKit();
    kit()!.emit('session_proposal', fakeProposal(11));
    expect(seen).toHaveLength(1);
  });
});

describe('pair', () => {
  test('delegates {uri} to the paired client and reports success', async () => {
    const {initWalletKit, pair, kit} = load(PROJECT_ID);
    await initWalletKit();
    await expect(pair('wc:faketest@2?relay-protocol=irn')).resolves.toBe(true);
    expect(kit()!.pair).toHaveBeenCalledWith({uri: 'wc:faketest@2?relay-protocol=irn'});
  });
});

describe('session API — approve / reject / respond / discover / disconnect', () => {
  test('approveSession builds namespaces via the SDK helper and approves with the proposal id', async () => {
    const {initWalletKit, approveSession, buildApproved, kit} = load(PROJECT_ID);
    await initWalletKit();
    const proposal = fakeProposal(42);
    const address = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    await approveSession(proposal, address);
    // The supported namespace dpay advertises — the v1 surface, pinned HERE so it cannot drift
    // from what the request dispatch implements without this test going red.
    expect(buildApproved).toHaveBeenCalledWith({
      proposal: proposal.params,
      supportedNamespaces: {
        eip155: {
          chains: ['eip155:1', 'eip155:42161'],
          methods: [
            'eth_accounts',
            'eth_chainId',
            'personal_sign',
            'eth_signTypedData_v4',
            'eth_sendTransaction',
            'wallet_switchEthereumChain',
          ],
          events: ['chainChanged', 'accountsChanged'],
          accounts: [
            `eip155:1:${address}`,
            `eip155:42161:${address}`,
          ],
        },
      },
    });
    expect(kit()!.approveSession).toHaveBeenCalledWith({id: 42, namespaces: {}});
  });

  test('rejectSession answers with the real SDK USER_REJECTED error (code 5000)', async () => {
    const {initWalletKit, rejectSession, kit} = load(PROJECT_ID);
    await initWalletKit();
    await rejectSession(fakeProposal(43));
    expect(kit()!.rejectSession).toHaveBeenCalledWith({
      id: 43,
      reason: {code: 5000, message: 'User rejected.'},
    });
  });

  test('respondSessionRequest passes topic + response through untouched', async () => {
    const {initWalletKit, respondSessionRequest, kit} = load(PROJECT_ID);
    await initWalletKit();
    const response = {id: 44, jsonrpc: '2.0' as const, result: '0xdeadbeef'};
    await respondSessionRequest('topic-1', response);
    expect(kit()!.respondSessionRequest).toHaveBeenCalledWith({topic: 'topic-1', response});
  });

  test('discover returns null before any init, and the full state snapshot after', async () => {
    const {initWalletKit, discover} = load(PROJECT_ID);
    await expect(discover()).resolves.toBeNull(); // passive: never initializes
    await initWalletKit();
    await expect(discover()).resolves.toEqual({
      sessions: {},
      pendingProposals: {},
      pendingRequests: [],
    });
  });

  test('disconnectSession is a no-op before init and carries USER_DISCONNECTED (code 6000) after', async () => {
    const {initWalletKit, disconnectSession, kit} = load(PROJECT_ID);
    await expect(disconnectSession('nope')).resolves.toBeUndefined(); // no client, no throw
    await initWalletKit();
    await disconnectSession('topic-2');
    expect(kit()!.disconnectSession).toHaveBeenCalledWith({
      topic: 'topic-2',
      reason: {code: 6000, message: 'User disconnected.'},
    });
  });
});
