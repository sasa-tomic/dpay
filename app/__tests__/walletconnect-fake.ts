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

/** The real public provider instance type (the contract `EthereumProvider` itself `implements`). */
type EthereumProviderInstance = InstanceType<typeof EthereumProvider>;

/** Minimal request-args shape (mirrors the SDK's `RequestArguments` and dpay's `Eip1193Provider`). */
type RequestArgs = {method: string; params?: unknown[] | object};

/**
 * FakeEthereumProvider — a controllable jest.fn-backed provider that `implements` the REAL
 * EthereumProvider instance surface (a `Pick` of it). `request` is a jest.fn (assert/override via
 * `setHandler` or directly with `.mockResolvedValue`); `enable`/`connect`/`disconnect` are inert
 * jest.fn stubs so the fake can also stand in for the fuller WC contract. This is what `FAKE_INIT`
 * resolves to.
 */
export class FakeEthereumProvider
  implements Pick<EthereumProviderInstance, 'request' | 'enable' | 'connect' | 'disconnect'>
{
  private readonly handlers = new Map<string, (args: RequestArgs) => unknown>();

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

  /** WC `connect` — inert jest.fn. */
  connect = jest.fn(async (_opts?: unknown): Promise<void> => undefined) as EthereumProviderInstance['connect'];

  /** WC `disconnect` — inert jest.fn. */
  disconnect = jest.fn(async (): Promise<void> => undefined) as EthereumProviderInstance['disconnect'];
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
