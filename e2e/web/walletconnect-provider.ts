// WalletConnect noop shim for the e2e web build (MC8 U6.2).
//
// The real app's `wallet.ts` `resolveOnrampProvider()` is WEB-FIRST: it returns `window.ethereum`
// (which the e2e harness's flow 16 installs as a recording mock) before EVER reaching the
// WalletConnect branch, and that branch is gated on `Platform.OS !== 'web'` (the vite build is
// react-native-web → Platform.OS === 'web') AND a non-empty `WALLETCONNECT_PROJECT_ID` (unset in
// the harness). So the WC code path is doubly unreachable in `just e2e`.
//
// This shim is the belt-and-braces alias target (mirrors the `react-native-vision-camera` alias in
// vite.config.js): `@walletconnect/ethereum-provider` AND `@walletconnect/react-native-compat` both
// resolve here, so even if an import path changed the vite bundle never executes real WalletConnect
// code (and never pulls the WC SDK's heavy dep tree into the web bundle). The real
// `@walletconnect/ethereum-provider` types are still resolved by `tsc` for the RN app (vite aliasing
// does not affect `app/`'s typecheck), so `walletconnect.ts` remains type-checked against the genuine
// WC surface.
//
// `react-native-compat` is imported in `walletconnect.ts` purely for its side effects (RN polyfills);
// aliasing it to this side-effect-free module is a harmless no-op on web.
//
// MC8 U6.2 hardening (types): the e2e package has NO `@walletconnect/ethereum-provider` in its
// node_modules and NO tsc gate (`just typecheck` covers only `app/`), so this shim cannot import the
// real `IEthereumProvider`. Instead it declares a LOCAL structural mirror of the genuine public
// EIP-1193 surface (`request`/`enable`/`connect`/`disconnect`) the app consumes, and types `init`
// against it so the shim's own types stay honest and structurally aligned. The real, tsc-enforced
// drift pin (real `EthereumProvider` instance ↔ dpay's `Eip1193Provider`) lives in
// `app/__tests__/walletconnect-conformance.test.ts`.

/** Request args (mirrors the SDK `RequestArguments` + dpay's `Eip1193Provider`). */
export type Eip1193RequestArgs = {method: string; params?: unknown[] | object};

/**
 * Local structural mirror of the real `IEthereumProvider` public surface the app uses. `request` is
 * required (the wrapper's only load-bearing call); the rest are optional so the inert shim stays a
 * faithful-but-minimal stand-in. Kept structurally compatible with dpay's `app/wallet.ts`
 * `Eip1193Provider` (which requires only `request`).
 */
export interface Eip1193ProviderLike {
  request: (args: Eip1193RequestArgs) => Promise<unknown>;
  enable?: () => Promise<string[]>;
  connect?: (opts?: unknown) => Promise<void>;
  disconnect?: () => Promise<void>;
}

/** The inert provider `init` resolves to (never reached under `just e2e` — web-first resolver). */
const inertProvider: Eip1193ProviderLike = {
  request: async () => null,
};

/**
 * Inert `EthereumProvider` stand-in. `init` is never called in the web build (web-first resolver),
 * but if it ever were it resolves a minimal EIP-1193-shaped provider rather than throwing. Typed so
 * the returned provider is checked against `Eip1193ProviderLike`.
 */
export const EthereumProvider: {
  init: (opts?: unknown) => Promise<Eip1193ProviderLike>;
} = {
  init: () => Promise.resolve(inertProvider),
};

export default {EthereumProvider};
