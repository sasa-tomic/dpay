/**
 * walletconnect-conformance — COMPILE-TIME drift detector for the WalletConnect SDK surface.
 *
 * MC8 U6.2 hardening: this suite PINS the real `@walletconnect/ethereum-provider` surface so an SDK
 * bump that renames/removes/retypes the load-bearing pieces fails `just typecheck` (which runs in
 * `just check`/`just verify`). The runtime `test()` is trivial — it exists so jest counts this file
 * as a suite and asserts the import resolves (under jest the specifier resolves to the typed stub via
 * moduleNameMapper; `init` is still a function). The REAL protection is the type-level bindings
 * below: they are erased at runtime but ENFORCED by tsc.
 *
 * What breaks `just typecheck` (and therefore `just verify`) on drift:
 *  - `_initRef` — if `init`'s static signature changes, assigning `EthereumProvider.init` to a
 *    variable of `typeof EthereumProvider.init` errors. (Init signature pin.)
 *  - `_instanceToEip1193` — if a real provider instance is no longer assignable to dpay's
 *    `Eip1193Provider` (e.g. `request` retyped to an incompatible shape), this errors. This is the
 *    wrapper's (`walletconnect.ts`) load-bearing assumption, pinned at the type level.
 *  - `_promisePin` — the `Promise<EthereumProvider>` → `Promise<Eip1193Provider>` narrowing the
 *    wrapper's cache relies on (no cast — pure assignability; the wrapper now relies on exactly this).
 *  - `_optionsPin` — forces `EthereumProviderOptions` to resolve (a rename/removal of the type
 *    itself errors) and exercises the fields the wrapper passes (`projectId`/`chains`/`showQrModal`).
 *  - `_HasRequest` / `_HasEnable` — assert the real instance type exposes `request` + `enable`.
 */
import {describe, test, expect} from '@jest/globals';
import {EthereumProvider} from '@walletconnect/ethereum-provider';
import type {EthereumProviderOptions} from '@walletconnect/ethereum-provider';
import type {Eip1193Provider} from '../wallet';

type EthereumProviderInstance = InstanceType<typeof EthereumProvider>;

// --- compile-time drift pins (enforced by `just typecheck`; erased at runtime) ---
const _initRef: typeof EthereumProvider.init = EthereumProvider.init; // `init` is the real static factory.
const _instanceToEip1193 = (p: EthereumProviderInstance): Eip1193Provider => p; // request assignable.
const _promisePin = (pp: Promise<EthereumProviderInstance>): Promise<Eip1193Provider> => pp; // cache narrowing.
const _optionsPin = (o: EthereumProviderOptions) => {
  // Forces the type to resolve + pins the fields walletconnect.ts passes to init({...}).
  void o.projectId;
  void o.chains;
  void o.showQrModal;
};
// Indexed-access pins: these type aliases are DECLARED (their RHS is evaluated by tsc even though
// the aliases are unused), so removing/renaming `request` or `enable` on the real instance type
// makes `EthereumProviderInstance['request']` / `['enable']` error here at compile time. (They must
// stay type-only — a runtime reference would need a value that does not exist.)
type _HasRequest = EthereumProviderInstance['request'];
type _HasEnable = EthereumProviderInstance['enable'];

void _initRef;
void _instanceToEip1193;
void _promisePin;
void _optionsPin;
// Re-export the type aliases under a consumed binding so they survive any future `noUnusedLocals`:
type _Consume = _HasRequest extends never ? _HasEnable : _HasRequest;
void (null as unknown as _Consume);

describe('WalletConnect SDK surface conformance (compile-time drift pins)', () => {
  test('EthereumProvider.init is the static async factory (a function)', () => {
    // Under jest this resolves to the typed stub (FAKE_INIT — still a function); under tsc the type
    // pins above are the real enforcement. This runtime assert confirms the import resolves + init exists.
    expect(typeof EthereumProvider.init).toBe('function');
  });
});
