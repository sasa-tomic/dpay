// WalletKit (wallet-side WalletConnect SDK) noop shim for the e2e web build (W1 step 2).
//
// The real app's `walletkit.ts` is the ONLY file that statically imports `@reown/*` (+ the
// `@walletconnect/core`/`utils` pieces the wallet side names), and the app reaches it only through
// a lazy dynamic import from the post-identity path — which does not exist in this web build (the
// guard is `Platform.OS !== 'web'` under react-native-web + a non-empty `WALLETCONNECT_PROJECT_ID`
// (unset in the harness)). So the wallet-side code path is doubly unreachable in `just e2e`.
//
// This shim is the belt-and-braces alias target (mirrors `walletconnect-provider.ts` above):
// `@reown/walletkit`, `@walletconnect/core` and `@walletconnect/utils` all resolve here, so even if
// an import path changed the vite bundle never executes real WC code nor pulls the SDK's heavy dep
// tree. The real SDK types are still resolved by `tsc` for the RN app (vite aliasing does not
// affect `app/`'s typecheck), so `walletkit.ts` remains type-checked against the genuine surface.
//
// The e2e package has NO WC SDK in its node_modules and NO tsc gate (`just typecheck` covers only
// `app/`), so this shim declares local structural mirrors (the `walletconnect-provider.ts` move)
// rather than importing the real types.

/** The members of a settled WalletKit client `walletkit.ts` reaches. */
interface WalletKitLike {
  pair: (params: {uri: string}) => Promise<void>;
  approveSession: (params: {id: number; namespaces: unknown}) => Promise<unknown>;
  rejectSession: (params: {id: number; reason: unknown}) => Promise<void>;
  respondSessionRequest: (params: {topic: string; response: unknown}) => Promise<void>;
  disconnectSession: (params: {topic: string; reason: unknown}) => Promise<void>;
  getActiveSessions: () => Record<string, unknown>;
  getPendingSessionProposals: () => Record<string, unknown>;
  getPendingSessionRequests: () => unknown[];
  on: (event: string, listener: (args: unknown) => void) => unknown;
}

/** The inert client `init` resolves to (never reached under `just e2e`). */
const inertWalletKit: WalletKitLike = {
  pair: async () => undefined,
  approveSession: async () => ({}),
  rejectSession: async () => undefined,
  respondSessionRequest: async () => undefined,
  disconnectSession: async () => undefined,
  getActiveSessions: () => ({}),
  getPendingSessionProposals: () => ({}),
  getPendingSessionRequests: () => [],
  on: () => undefined,
};

export const WalletKit: {init: (opts?: unknown) => Promise<WalletKitLike>} = {
  init: () => Promise.resolve(inertWalletKit),
};

/** Inert `Core` stand-in (walletkit.ts constructs it with the isolated storage prefix). */
export class Core {
  readonly projectId: string | undefined;
  readonly customStoragePrefix: string;
  constructor(opts?: {projectId?: string; customStoragePrefix?: string}) {
    this.projectId = opts?.projectId;
    this.customStoragePrefix = opts?.customStoragePrefix ?? '';
  }
}

export const buildApprovedNamespaces: (params?: unknown) => Record<string, unknown> = () => ({});

/** The real SDK error map entries walletkit.ts names (copied from @walletconnect/utils). */
export const getSdkError = (key: string): {code: number; message: string} => {
  const errors: Record<string, {code: number; message: string}> = {
    USER_REJECTED: {code: 5000, message: 'User rejected.'},
    USER_DISCONNECTED: {code: 6000, message: 'User disconnected.'},
    UNSUPPORTED_CHAINS: {code: 5100, message: 'Unsupported chains.'},
  };
  return errors[key] ?? {code: -1, message: key};
};

export default {WalletKit, Core, buildApprovedNamespaces, getSdkError};
