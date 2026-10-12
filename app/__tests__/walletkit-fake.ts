/**
 * walletkit-fake — a tsc-checked WalletKit test double (the `walletconnect-fake` pattern, wallet
 * side). Every mock/stub/fake for a WC SDK in this repo must be representative of the REAL SDK
 * surface, enforced at COMPILE time: `FakeWalletKit` implements a Pick of the genuine
 * `InstanceType<typeof WalletKit>` member types, `FAKE_WALLETKIT_INIT` takes the genuine
 * `WalletKitTypes.Options`, `FakeCore` implements the Core members the isolated-core mandate names
 * (`projectId`, `customStoragePrefix`), and `FAKE_BUILD_APPROVED_NAMESPACES` takes the genuine
 * `BuildApprovedNamespacesParams`. An SDK bump that renames/removes/retypes any of them fails
 * `just typecheck` here, before it can ship.
 *
 * How the real surface is sourced (verified against the INSTALLED @reown/walletkit 1.6.0 .d.ts):
 * the package exports the `WalletKit` class as a value, so the instance type is derived via
 * `InstanceType<typeof WalletKit>`; members whose return types need SDK structs the fake cannot
 * construct are jest.fns cast to the REAL member type (the `walletconnect-fake.ts` move), so a
 * signature change propagates here at compile time.
 *
 * These imports are TYPE-ONLY (erased by babel-jest) so there is no runtime dependency on the WC
 * SDK and no module cycle with `__stubs__/walletkit-stub.ts`, which re-exports the fakes as the
 * stubbed `WalletKit`/`Core`/`buildApprovedNamespaces`.
 */
import {jest} from '@jest/globals';
import type {WalletKit} from '@reown/walletkit';
import type {Core as RealCore} from '@walletconnect/core';
import type {
  buildApprovedNamespaces as RealBuildApprovedNamespaces,
  getSdkError as RealGetSdkError,
} from '@walletconnect/utils';

/** The real public WalletKit instance type (the contract this fake structurally mirrors). */
type WalletKitInstance = InstanceType<typeof WalletKit>;

/** The genuine init options (`{core: ICore, metadata, ...}`) — the arg type FAKE init accepts. */
type WalletKitOptions = Parameters<typeof WalletKit.init>[0];

/** The genuine Core constructor options (`projectId`, `customStoragePrefix`, ...). */
type CoreOptions = ConstructorParameters<typeof RealCore>[0];

/** The genuine `buildApprovedNamespaces` param object. */
type BuildApprovedNamespacesParams = Parameters<typeof RealBuildApprovedNamespaces>[0];

/**
 * FakeCore — records exactly what the isolated-core mandate makes load-bearing: the projectId and
 * the `customStoragePrefix` the wallet side MUST pass (plan §2.1). Nothing else of the real Core
 * (relay socket, storage, crypto) exists here — the fake must never touch a network.
 */
export class FakeCore implements Pick<InstanceType<typeof RealCore>, 'projectId' | 'customStoragePrefix'> {
  readonly projectId: string | undefined;
  readonly customStoragePrefix: string;
  constructor(opts?: CoreOptions) {
    this.projectId = opts?.projectId;
    this.customStoragePrefix = opts?.customStoragePrefix ?? '';
  }
}

/** The Core constructor as the stub exports it: a jest.fn so a test can assert the EXACT options
 *  `walletkit.ts` constructed it with (the isolated-core pin). */
export const FAKE_CORE = jest.fn((opts?: CoreOptions): FakeCore => new FakeCore(opts)) as unknown as typeof RealCore;

/**
 * FakeWalletKit — jest.fn-backed stand-in for the members `walletkit.ts` reaches. `on` is backed
 * by a real listener registry so tests can `emit('session_proposal', …)` / `emit('session_request',
 * …)` to exercise the typed emitter surface; every method is a recording jest.fn the tests assert
 * on. Returns are inert (null/undefined cast to the real member types) — no session machinery.
 */
export class FakeWalletKit
  implements
    Pick<
      WalletKitInstance,
      | 'pair'
      | 'approveSession'
      | 'rejectSession'
      | 'respondSessionRequest'
      | 'disconnectSession'
      | 'getActiveSessions'
      | 'getPendingSessionProposals'
      | 'getPendingSessionRequests'
      | 'on'
    >
{
  pair = jest.fn(async (_params: {uri: string}): Promise<void> => undefined) as WalletKitInstance['pair'];

  approveSession = jest.fn(
    async (_params: {id: number; namespaces: unknown}): Promise<null> => null,
  ) as unknown as WalletKitInstance['approveSession'];

  rejectSession = jest.fn(
    async (_params: {id: number; reason: unknown}): Promise<void> => undefined,
  ) as unknown as WalletKitInstance['rejectSession'];

  respondSessionRequest = jest.fn(
    async (_params: {topic: string; response: unknown}): Promise<void> => undefined,
  ) as unknown as WalletKitInstance['respondSessionRequest'];

  disconnectSession = jest.fn(
    async (_params: {topic: string; reason: unknown}): Promise<void> => undefined,
  ) as unknown as WalletKitInstance['disconnectSession'];

  getActiveSessions = jest.fn(
    (): Record<string, null> => ({}),
  ) as unknown as WalletKitInstance['getActiveSessions'];

  getPendingSessionProposals = jest.fn(
    (): Record<number, null> => ({}),
  ) as unknown as WalletKitInstance['getPendingSessionProposals'];

  getPendingSessionRequests = jest.fn(
    (): unknown[] => [],
  ) as unknown as WalletKitInstance['getPendingSessionRequests'];

  // The listener registry behind `on` — a real Map so `emit` fans payloads out exactly like the
  // real EventEmitter (one argument per listener). `on` itself is jest.fn so tests can assert
  // `walletkit.ts` registered the two SDK listeners AT INIT.
  private readonly eventListeners = new Map<string, Set<(args: unknown) => void>>();

  on = jest.fn(((event: string, listener: (args: unknown) => void) => {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event)!.add(listener);
    return this;
  }) as unknown as WalletKitInstance['on']);

  /** Test helper: fire an event payload at every registered listener (mirrors the real client). */
  emit(event: string, payload: unknown): void {
    const set = this.eventListeners.get(event);
    if (set) for (const fn of set) fn(payload);
  }

  /** Test helper: the listeners currently registered for `event`. */
  listenersFor(event: string): number {
    return this.eventListeners.get(event)?.size ?? 0;
  }
}

/**
 * FAKE_WALLETKIT_INIT — a jest.fn typed against the REAL `WalletKit.init` ARGUMENT signature
 * (`WalletKitTypes.Options`), so an SDK change to the init options (e.g. `core` renamed, metadata
 * reshaped) fails `just typecheck` here AND at `walletkit.ts`'s real call site. Resolves a fresh
 * `FakeWalletKit` per call and records it in `lastFakeWalletKit()` (a mock result would carry the
 * PROMISE; tests want the resolved instance the module cached).
 */
let lastKit: FakeWalletKit | undefined;
export function lastFakeWalletKit(): FakeWalletKit | undefined {
  return lastKit;
}

export const FAKE_WALLETKIT_INIT: jest.MockedFunction<(opts: WalletKitOptions) => Promise<FakeWalletKit>> = jest.fn(
  async (_opts: WalletKitOptions) => {
    lastKit = new FakeWalletKit();
    return lastKit;
  },
);

/** FAKE_BUILD_APPROVED_NAMESPACES — typed against the genuine param object; returns a minimal
 *  namespaces stand-in (cast to the real signature). Tests assert the INPUT (proposal + the
 *  supportedNamespaces dpay advertises), not the SDK's validation, which stays real-side. */
export const FAKE_BUILD_APPROVED_NAMESPACES: jest.MockedFunction<
  (params: BuildApprovedNamespacesParams) => ReturnType<typeof RealBuildApprovedNamespaces>
> = jest.fn((_params: BuildApprovedNamespacesParams) => ({}) as ReturnType<typeof RealBuildApprovedNamespaces>);

/**
 * The SDK error map entries `walletkit.ts` names — copied verbatim from the installed
 * `@walletconnect/utils` (errors.js), so a test asserting a rejection reason sees the REAL code +
 * message a live session would carry. If the real map ever drifts, walletconnect's own conformance
 * pin (`getSdkError` codes are also pinned app-wide) or this comment's provenance goes red.
 */
export const FAKE_SDK_ERRORS: Record<string, {code: number; message: string}> = {
  USER_REJECTED: {code: 5000, message: 'User rejected.'},
  USER_DISCONNECTED: {code: 6000, message: 'User disconnected.'},
  UNSUPPORTED_CHAINS: {code: 5100, message: 'Unsupported chains.'},
};

/** Typed against the genuine `getSdkError` signature (key of the real map → {message, code}). */
export const fakeGetSdkError: typeof RealGetSdkError = (key: string, _context?: string | number) => {
  const err = FAKE_SDK_ERRORS[key];
  if (!err) throw new Error(`fakeGetSdkError: unknown key ${key}`);
  return {...err};
};
