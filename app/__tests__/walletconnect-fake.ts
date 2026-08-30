/**
 * walletconnect-fake — a tsc-checked WalletConnect provider test double.
 *
 * MC8 U6.2 hardening: every WalletConnect mock/stub/fake in this repo must be 100% representative of
 * the real `@walletconnect/ethereum-provider` SDK surface, enforced at COMPILE time (not only at
 * device runtime). This module is the typed fake: `FakeEthereumProvider` IMPLEMENTS the genuine
 * provider contract and `FAKE_INIT` mirrors the real `EthereumProvider.init` factory signature, so
 * an SDK bump that renames/removes/retypes `request`/`init`/`enable`/`connect`/`disconnect` fails
 * `just typecheck` here — before it can ship to a device.
 *
 * How the real surface is sourced (load-bearing — verified against the INSTALLED 2.23.10 .d.ts): the
 * package ships `EthereumProvider` as a `const` VALUE (`export declare const EthereumProvider: typeof
 * Provider`) and does NOT re-export the `IEthereumProvider` interface from the package root (only
 * `EthereumProviderOptions`/`RpcEvent`/`RpcMethod`). Its `exports` map also blocks deep subpath
 * imports (confirmed: `@walletconnect/ethereum-provider/dist/types/...` fails under the project's
 * `moduleResolution: "bundler"`). So the genuine provider surface is reached the ONLY way the
 * package permits — by deriving the class instance type: `InstanceType<typeof EthereumProvider>`.
 * Every member below is typed verbatim from that real instance type (a `Pick` of it); this is NOT a
 * hand-rolled shape, and a signature change in the SDK's shipped `.d.ts` propagates here at compile
 * time. The full `init` signature is additionally pinned in `walletconnect-conformance.test.ts`.
 *
 * These imports are TYPE-ONLY (erased by babel-jest) so there is no runtime dependency on the WC SDK
 * and no module cycle with the jest stub (`__stubs__/walletconnect-stub.ts`) that re-exports
 * `FAKE_INIT` as the stubbed `EthereumProvider.init`.
 */
import {jest} from '@jest/globals';
import type {EthereumProvider, EthereumProviderOptions} from '@walletconnect/ethereum-provider';
// TYPE-ONLY, and it must stay that way: `__stubs__/walletconnect-stub.ts` imports this module for
// its value (`FAKE_INIT`) and `walletconnect.ts` imports that stub under jest — a runtime import
// here would close the cycle. `import type` is erased (isolatedModules pins that).
import type {WalletConnectSession} from '../walletconnect';

/** The real public provider instance type (the contract `EthereumProvider` itself `implements`). */
type EthereumProviderInstance = InstanceType<typeof EthereumProvider>;

/** Minimal request-args shape (mirrors the SDK's `RequestArguments` and dpay's `Eip1193Provider`). */
type RequestArgs = {method: string; params?: unknown[] | object};

/**
 * FakeEthereumProvider — a controllable jest.fn-backed provider that `implements` the REAL
 * EthereumProvider instance surface (a `Pick` of it). `request` is a jest.fn (assert/override via
 * `setHandler` or directly with `.mockResolvedValue`); `enable`/`connect`/`disconnect` are inert
 * jest.fn stubs so the fake can also stand in for the fuller WC contract. `on`/`removeListener` are
 * a real listener registry (backed by a Map) so tests can `emit` events (`display_uri`, `connect`)
 * to exercise the pairing flow; they are ALSO jest.fn-wrapped so tests can assert registration.
 * This is what `FAKE_INIT` resolves to.
 */
export class FakeEthereumProvider
  implements Pick<
    EthereumProviderInstance,
    'request' | 'enable' | 'connect' | 'disconnect' | 'on' | 'removeListener' | 'session' | 'signer'
  >
{
  /**
   * The two `IKeyValueStorage` methods `walletconnect.ts` reaches through
   * `signer.client.core.storage` — the SDK's own store, where the WALLETCONNECT_DEEPLINK_CHOICE key
   * lives (see `recordWalletChoice`). jest.fn-backed so a test can assert the exact key + value
   * written, and drive a write/removal failure. Declared BEFORE `signer`, which closes over it.
   */
  readonly storage = {
    setItem: jest.fn(async (_key: string, _value: unknown): Promise<void> => undefined),
    removeItem: jest.fn(async (_key: string): Promise<void> => undefined),
  };

  /**
   * WC `signer` — the UniversalProvider. `walletconnect.ts` reaches exactly ONE thing through it
   * (`client.core.storage`) and a real UniversalProvider cannot be constructed in a test, so the
   * fake supplies that sub-tree under the REAL member type — the same `as unknown as` shape `on` /
   * `removeListener` below already use for the members a structural stand-in cannot satisfy. Drift
   * on the PATH is caught at compile time by walletconnect.ts's own `signer.client.core.storage`
   * expression; drift on the MEMBER NAME is caught by the `implements Pick<…, 'signer'>` above.
   */
  signer = {client: {core: {storage: this.storage}}} as unknown as EthereumProviderInstance['signer'];

  /**
   * WC `session` — the settled session, `undefined` until a pairing succeeds (the real provider
   * also restores one from storage at init). Tests assign it, or have `connect` assign it, to drive
   * the reuse / wrong-chain / nothing-approved branches of `pairWalletConnect`. Typed as the real
   * `session` member, so an SDK change to the session shape fails `just typecheck` here.
   */
  session: EthereumProviderInstance['session'] = undefined;

  private readonly handlers = new Map<string, (args: RequestArgs) => unknown>();
  // The listener registry: event name → set of listener fns. `emit` (test helper) fans a payload
  // out to every registered listener for that event, exactly like the real EventEmitter.
  private readonly eventListeners = new Map<string, Set<(args: unknown) => void>>();

  /** Install a per-`method` handler (tests override the default `null` return for a given method). */
  setHandler(method: string, fn: (args: RequestArgs) => unknown): this {
    this.handlers.set(method, fn);
    return this;
  }

  /** EIP-1193 request — jest.fn-backed so tests can assert/override; typed as the real signature. */
  request = jest.fn(
    async <T = unknown>(args: RequestArgs, _expiry?: number): Promise<T> => {
      const h = this.handlers.get(args.method);
      return (h ? h(args) : null) as T;
    },
  ) as EthereumProviderInstance['request'];

  /** WC `enable` — inert jest.fn returning an empty account list. */
  enable = jest.fn(async (): Promise<string[]> => []) as EthereumProviderInstance['enable'];

  /** WC `connect` — jest.fn (tests override to resolve or reject to drive the pairing flow). Typed
   * as `jest.MockedFunction<real signature>` so tests can call `.mockImplementation()`/`.mockResolvedValue()`
   * while STILL satisfying the `implements Pick<..., 'connect'>` constraint (the intersection preserves
   * the SDK call signature for drift detection). */
  connect = jest.fn(async (_opts?: unknown): Promise<void> => undefined) as jest.MockedFunction<
    EthereumProviderInstance['connect']
  >;

  /** WC `disconnect` — jest.fn (tests override to reject to drive the teardown-error path). Typed
   * as `jest.MockedFunction<real signature>` so tests can call `.mockRejectedValue()` while STILL
   * satisfying the `implements Pick<..., 'disconnect'>` constraint (the intersection preserves the
   * SDK call signature for drift detection — mirrors `connect` above). */
  disconnect = jest.fn(async (): Promise<void> => undefined) as jest.MockedFunction<
    EthereumProviderInstance['disconnect']
  >;

  /**
   * WC `on` — jest.fn that ALSO registers the listener in the internal registry so `emit` can fire
   * it. Returns `this` (the real `on` returns the EthereumProvider for chaining). Typed as the real
   * generic `on` signature.
   */
  on = jest.fn(((event: string, listener: (args: unknown) => void) => {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event)!.add(listener);
    return this;
  }) as unknown as EthereumProviderInstance['on']);

  /**
   * WC `removeListener` — jest.fn that ALSO removes the listener from the registry so cleanup is
   * observable. Typed as the real generic `removeListener` signature.
   */
  removeListener = jest.fn(((event: string, listener: (args: unknown) => void) => {
    this.eventListeners.get(event)?.delete(listener);
    return this;
  }) as unknown as EthereumProviderInstance['removeListener']);

  /**
   * Test helper: emit an event payload to every registered listener for that event (mirrors the real
   * EventEmitter). The payload is passed as the SINGLE listener argument — matches the real SDK's
   * `display_uri: string` and `connect: ProviderInfo` shapes (one arg, not spread).
   */
  emit(event: string, payload: unknown): void {
    const set = this.eventListeners.get(event);
    if (set) for (const fn of set) fn(payload);
  }
}

/**
 * FAKE_INIT — a jest.fn typed against the REAL `EthereumProvider.init` ARGUMENT signature. The arg
 * type is the genuine `EthereumProviderOptions` (exported from the package root), so an SDK change
 * to `init`'s options (e.g. `chains`/`showQrModal` renamed or retyped) fails `just typecheck` here
 * AND in `walletconnect.ts`'s real `EthereumProvider.init({...})` call site. The return is the fake
 * (a structural stand-in for the EIP-1193 surface the wrapper consumes — the fake implements a Pick
 * of the real instance type, not the full class, so it cannot be typed as the full
 * `typeof EthereumProvider.init` return without lying); the complete real `init` signature —
 * `(opts: EthereumProviderOptions) => Promise<EthereumProvider>` — is independently pinned in
 * `walletconnect-conformance.test.ts`.
 */
export const FAKE_INIT: jest.MockedFunction<
  (opts: EthereumProviderOptions) => Promise<FakeEthereumProvider>
> = jest.fn(async (_opts: EthereumProviderOptions) => new FakeEthereumProvider());

/**
 * A settled session whose namespaces approve exactly `accountsByNamespace` — the input a wallet's
 * approval reduces to. Keyed by namespace so a test can use the bare (`eip155`) or the chain-scoped
 * (`eip155:1`) form WC v2 both allow, with CAIP-10 accounts (`eip155:<chainId>:<address>`).
 *
 * Every other field is filled with an inert placeholder because the REAL `SessionTypes.Struct`
 * requires it: the return type is the genuine session type (via `walletconnect.ts`), so this is
 * tsc-checked against the SDK — a new required field breaks the build here instead of letting a
 * hand-rolled `as` cast drift away from what the SDK actually hands the app.
 */
export function fakeSession(accountsByNamespace: Record<string, string[]>): WalletConnectSession {
  const metadata = {name: 'fake', description: 'fake', url: 'https://fake.invalid', icons: []};
  const namespaces: WalletConnectSession['namespaces'] = {};
  for (const [key, accounts] of Object.entries(accountsByNamespace)) {
    namespaces[key] = {accounts, methods: [], events: []};
  }
  return {
    topic: 'fake-topic',
    pairingTopic: 'fake-pairing-topic',
    relay: {protocol: 'irn'},
    expiry: 0,
    acknowledged: true,
    controller: 'fake-controller',
    namespaces,
    requiredNamespaces: {},
    optionalNamespaces: {},
    self: {publicKey: 'fake-self', metadata},
    peer: {publicKey: 'fake-peer', metadata},
  };
}
