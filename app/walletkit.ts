/**
 * walletkit — the WalletConnect WALLET-side (responder) SDK source: dpay as a connectable wallet
 * for third-party dApps (Mt Pelerin's widget, WalletConnect's test dapp, any WC v2 app). The
 * dApp-side counterpart is `walletconnect.ts` (dpay CONSUMES an external wallet's EIP-1193
 * provider); this module is the mirror image — dpay PROVIDES the accounts and answers the
 * requests. Zero key surface, same as the dApp side: the device key never leaves; WalletConnect
 * transports only end-to-end-encrypted envelopes and dpay returns signatures/hashes only.
 *
 * ISOLATION (the house seam, mirrored from `walletconnect.ts`): this is the ONLY file that
 * statically imports `@reown/*` (+ the `@walletconnect/core`/`utils` pieces the wallet side
 * needs). The app reaches it ONLY through a lazy dynamic `import('./walletkit')` from the
 * post-identity path (the Wallet mount wiring arrives with a later wave). Belt-and-braces: jest's
 * moduleNameMapper maps every `^@reown/.*` specifier (plus the two `@walletconnect/*` specifiers
 * this module names) to typed no-op stubs (`__stubs__/walletkit-stub.ts`), so even a stray import
 * resolves to a no-op, never real WC code.
 *
 * ISOLATED CORE (MANDATORY — plan §2.1, the correction to feasibility §4): the Core is constructed
 * HERE with `customStoragePrefix: 'walletkit'` and handed to `WalletKit.init`. Core instances are
 * shared globally by default (`globalThis._walletConnectCore_<prefix>`), and storage keys carry no
 * client identity (`wc@2:client:<ver><prefix>//session`, `wc@2:core:<ver><prefix>//pairing` on
 * core 2.25.0) — without the distinct prefix, the wallet-side client and the shipped dApp-side
 * provider (`@walletconnect/ethereum-provider`) would write the SAME session and pairing stores
 * (last-writer-wins corruption, double event delivery). A second Core with the default prefix is
 * never even created (core returns the globally shared instance); only a distinct fixed prefix
 * yields two isolated Cores and stores. Never rely on init order.
 *
 * IMPORT ORDER (load-bearing): `./evm/textDecoderHermes` FIRST (Hermes's TextDecoder rejects the
 * `fatal` option and `@walletconnect/pay` constructs with it at module scope — without the shim
 * the import chain crashes the app at start), then `@walletconnect/react-native-compat` before
 * any `@reown/*` import (walletkit RN docs) — its side effects install the polyfills the SDK
 * expects on React Native. `fast-text-encoding` (explicit dep per the same docs) rides after.
 *
 * DISABLED GUARD (mirrors `walletconnect.ts`): web (`Platform.OS === 'web'` — the browser has no
 * wallet side here) or an empty `WALLETCONNECT_PROJECT_ID` disables every export (null / no-op /
 * false), so callers never special-case the disabled path.
 */
import './evm/textDecoderHermes'; // MUST stay first: Hermes TextDecoder rejects {fatal}; @walletconnect/pay constructs with it at module scope
import '@walletconnect/react-native-compat'; // side-effect FIRST: RN polyfills before any @reown/* import
import 'fast-text-encoding'; // explicit per the walletkit RN install docs (TextEncoder/TextDecoder polyfill)
import {Core} from '@walletconnect/core';
import {buildApprovedNamespaces, getSdkError} from '@walletconnect/utils';
import {WalletKit} from '@reown/walletkit';
import type {WalletKitTypes} from '@reown/walletkit';
import {Platform} from 'react-native';
import {WALLETCONNECT_PROJECT_ID} from './config/constants';
import {SOLANA_MAINNET_CAIP2, SOLANA_V1_METHODS} from './solana/wcDecode';

/** The real WalletKit instance type (the package exports the class as a value; the instance type is
 *  derived via InstanceType — the same move `walletconnect.ts` makes for EthereumProvider). */
type WalletKitInstance = InstanceType<typeof WalletKit>;

/** A settled approved session, typed from the SDK's own surface (no transitive type imports). */
export type WcSession = Awaited<ReturnType<WalletKitInstance['approveSession']>>;

/** A `session_proposal` event payload (the dApp asking to connect). */
export type WcProposal = WalletKitTypes.SessionProposal;

/** A `session_request` event payload (the dApp asking dpay to sign something). */
export type WcRequest = WalletKitTypes.SessionRequest;

/** A JSON-RPC answer to a session request — the result or the error half of JsonRpcResponse,
 *  shaped locally (the exact type lives in a transitive package dpay does not name). */
export type WcResponse =
  | {id: number; jsonrpc: '2.0'; result: unknown}
  | {id: number; jsonrpc: '2.0'; error: {code: number; message: string; data?: string}};

/** The Android deep link dpay claims (`AndroidManifest.xml`) — what a dApp is redirected to after
 *  dpay answers. Same literal `walletconnect.ts` pins as `ANDROID_DEEP_LINK`; restated here rather
 *  than imported so the two SDK stacks stay welded together only through the manifest, not through
 *  a module edge (importing `./walletconnect` would pull the dApp-side provider into this graph). */
export const WC_WALLET_DEEP_LINK = 'dpay://';

/** The storage prefix that ISOLATES this client's stores from the dApp-side provider's — see the
 *  header comment. Exported so a test can pin init against it. */
export const WC_STORAGE_PREFIX = 'walletkit';

/** The v1 session surface (plan W1 step 3): both wired mainnet chains, the Explorer-QA method set,
 *  and the two events every EVM wallet emits. The REQUEST DISPATCH for these methods lands with
 *  the review sheet (a later wave); the namespace is what a proposal is APPROVED against. The
 *  Solana namespace (plan Track S step 4) rides the SAME surface: mainnet-beta only, exactly
 *  SOLANA_V1_METHODS (the single source in wcDecode.ts, the module the review decoder serves),
 *  no events — advertised only when the caller hands a solana address (no identity = no solana
 *  namespace, EVM still works). */
export const WC_SUPPORTED_CHAINS = ['eip155:1', 'eip155:42161'];
export const WC_SUPPORTED_METHODS = [
  'eth_accounts',
  'eth_chainId',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'wallet_switchEthereumChain',
];
export const WC_SUPPORTED_EVENTS = ['chainChanged', 'accountsChanged'];

// The single cached init promise, kept for the LIFE OF THE PROCESS (the `walletconnect.ts`
// pattern): the relay socket behind the Core is long-lived, and re-initializing per pairing would
// stand up live Cores nothing tears down. A REJECTED init drops the cache so the next call retries
// instead of wedging on a dead promise forever.
let cachedKit: Promise<WalletKitInstance> | null = null;

function walletKitSupported(): boolean {
  return Platform.OS !== 'web' && WALLETCONNECT_PROJECT_ID !== '';
}

/** The lazy singleton creator every entry point shares. Registers the session listeners BEFORE the
 *  promise settles, so no proposal/request can slip between init resolution and wiring. */
function ensureWalletKit(): Promise<WalletKitInstance> {
  if (cachedKit) return cachedKit;
  const init = createWalletKit();
  init.catch(() => {
    // Drop only OUR OWN still-cached promise: a later, successful init must not be evicted by a
    // stale handler. Callers still see the rejection through the returned promise.
    if (cachedKit === init) cachedKit = null;
  });
  cachedKit = init;
  return init;
}

async function createWalletKit(): Promise<WalletKitInstance> {
  const kit = await WalletKit.init({
    core: new Core({
      projectId: WALLETCONNECT_PROJECT_ID,
      // MANDATORY (plan §2.1): the distinct fixed prefix is what keeps this wallet-side client's
      // session/pairing stores separate from the dApp-side provider's. Never the default.
      customStoragePrefix: WC_STORAGE_PREFIX,
    }),
    metadata: {
      name: 'dpay',
      description: 'dpay non-custodial wallet',
      url: 'https://dpay.kalaj.org',
      icons: [],
      redirect: {native: WC_WALLET_DEEP_LINK}, // same claimed scheme `walletconnect.ts` pins
    },
  });
  registerSdkListeners(kit);
  return kit;
}

// The typed emitter surface: init registers the SDK listeners once (above); the app-side wiring
// (Wallet mount, a later wave) subscribes post-identity via onProposal/onRequest and unsubscribes
// with the returned closure. A request arriving with no subscriber is simply not observed — the
// review sheet is the only path to `respondSessionRequest` once the sheet wave lands.
const proposalListeners = new Set<WcProposalListener>();
const requestListeners = new Set<WcRequestListener>();

export type WcProposalListener = (proposal: WcProposal) => void;
export type WcRequestListener = (request: WcRequest) => void;

/** Subscribe to `session_proposal` (a dApp asking to connect). Returns the unsubscribe closure. */
export function onProposal(listener: WcProposalListener): () => void {
  proposalListeners.add(listener);
  return () => {
    proposalListeners.delete(listener);
  };
}

/** Subscribe to `session_request` (a dApp asking dpay to sign). Returns the unsubscribe closure. */
export function onRequest(listener: WcRequestListener): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

function registerSdkListeners(kit: WalletKitInstance): void {
  kit.on('session_proposal', (args) => {
    for (const listener of proposalListeners) listener(args);
  });
  kit.on('session_request', (args) => {
    for (const listener of requestListeners) listener(args);
  });
}

/** Initialize the wallet-side client. Returns null when disabled (web / empty project ID) — the
 *  same disabled shape `getWalletConnectProvider()` hands back on the dApp side. Initialized in
 *  the post-identity path only: requests arrive while the relay socket is live, never before an
 *  EVM address exists. */
export async function initWalletKit(): Promise<WalletKitInstance | null> {
  if (!walletKitSupported()) return null;
  return ensureWalletKit();
}

/**
 * Pair with a dApp from a `wc:` URI (a scanned QR or an inbound `wc:` deep link — the two inbound
 * paths of W1 step 4 land in the same entry). Resolves once the pairing topic is live; the dApp
 * then sends its proposal, which surfaces through `onProposal`. Returns false when disabled.
 */
export async function pair(uri: string): Promise<boolean> {
  if (!walletKitSupported()) return false;
  const kit = await ensureWalletKit();
  await kit.pair({uri});
  return true;
}

/**
 * Approve a proposal with the dpay EVM address on both wired chains and — when the wallet has a
 * solana identity at approval time — the Solana mainnet namespace with exactly the v1 method
 * surface (plan Track S step 4; `solanaAddress: null` leaves the solana namespace out entirely,
 * EVM still works). Addresses are the device keys' (threaded by the caller — this module stays
 * free of identity imports). The approved namespaces are built with the SDK's own validator,
 * which refuses proposals asking for chains/methods/events dpay does not support (that refusal
 * is the SDK's, not improvised here). Returns the settled session, or null when disabled.
 */
export async function approveSession(proposal: WcProposal, evmAddress: string, solanaAddress: string | null = null): Promise<WcSession | null> {
  if (!walletKitSupported()) return null;
  const kit = await ensureWalletKit();
  const supportedNamespaces: Parameters<typeof buildApprovedNamespaces>[0]['supportedNamespaces'] = {
    eip155: {
      chains: [...WC_SUPPORTED_CHAINS],
      methods: [...WC_SUPPORTED_METHODS],
      events: [...WC_SUPPORTED_EVENTS],
      accounts: WC_SUPPORTED_CHAINS.map((chain) => `${chain}:${evmAddress}`),
    },
  };
  if (solanaAddress != null) {
    supportedNamespaces.solana = {
      chains: [SOLANA_MAINNET_CAIP2],
      methods: [...SOLANA_V1_METHODS],
      events: [],
      accounts: [`${SOLANA_MAINNET_CAIP2}:${solanaAddress}`],
    };
  }
  const namespaces = buildApprovedNamespaces({
    proposal: proposal.params,
    supportedNamespaces,
  });
  return kit.approveSession({id: proposal.id, namespaces});
}

/**
 * Can dpay SERVE this proposal? True iff every REQUIRED namespace is inside what
 * `approveSession` builds (the SDK's `buildApprovedNamespaces` refuses the rest, which used to
 * surface as an error-only Approve). Mirror of that validator, not a reimplementation of it:
 * approve still runs the SDK check - this is the pre-Approve honest gate the sheet renders from.
 * `solanaAddress: null` leaves the solana namespace unbuilt, so a proposal REQUIRING solana is
 * unservable (EVM-only wallets reject solana-required dApps here, not at approve time).
 */
export function proposalServable(proposal: WcProposal, solanaAddress: string | null): boolean {
  const required = (proposal.params as {requiredNamespaces?: Record<string, {chains?: unknown; methods?: unknown; events?: unknown}> | undefined} | undefined)?.requiredNamespaces ?? {};
  const allOf = (list: unknown, ok: (v: unknown) => boolean): boolean =>
    (Array.isArray(list) ? list : []).every(ok);
  for (const [ns, req] of Object.entries(required)) {
    const r = req ?? {};
    if (ns === 'eip155') {
      if (!allOf(r.chains, (c) => typeof c === 'string' && WC_SUPPORTED_CHAINS.includes(c))) return false;
      if (!allOf(r.methods, (m) => typeof m === 'string' && WC_SUPPORTED_METHODS.includes(m))) return false;
      if (!allOf(r.events, (e) => typeof e === 'string' && WC_SUPPORTED_EVENTS.includes(e))) return false;
    } else if (ns === 'solana') {
      if (solanaAddress == null) return false;
      if (!allOf(r.chains, (c) => c === SOLANA_MAINNET_CAIP2)) return false;
      if (!allOf(r.methods, (m) => typeof m === 'string' && SOLANA_V1_METHODS.includes(m as never))) return false;
      if (!allOf(r.events, () => false)) return false; // the solana namespace advertises no events
    } else {
      return false; // a namespace dpay does not build is a proposal it cannot approve
    }
  }
  return true;
}

/** Reject a proposal — the user said no to the connection itself (SDK error USER_REJECTED, 5000).
 *  No-op when disabled. */
export async function rejectSession(proposal: WcProposal): Promise<void> {
  if (!walletKitSupported()) return;
  const kit = await ensureWalletKit();
  await kit.rejectSession({id: proposal.id, reason: getSdkError('USER_REJECTED')});
}

/** Answer a session request (the sheet's approve path hands back the signature/hash; its reject
 *  path hands a JSON-RPC error — USER_REJECTED 5000 for a user refusal). No-op when disabled. */
export async function respondSessionRequest(topic: string, response: WcResponse): Promise<void> {
  if (!walletKitSupported()) return;
  const kit = await ensureWalletKit();
  await kit.respondSessionRequest({topic, response});
}

/** One SDK error object as the responder's JSON-RPC `error` half carries it. */
export type WcSdkError = {code: number; message: string};

/** The SDK's USER_REJECTED error (code 5000) — every user refusal answers with this exact
 *  object, so the sheet's reject button and the one-review-at-a-time gate build IDENTICAL
 *  rejections. Exported as a factory (not a const) because the sheet and the Wallet wiring may
 *  not import WC specifiers themselves (the seam law) — they pass the value through. */
export function wcUserRejected(): WcSdkError {
  return getSdkError('USER_REJECTED');
}

/** The SDK's UNSUPPORTED_CHAINS error (code 5100) — a `wallet_switchEthereumChain` to a chain
 *  outside the wired pair refuses with this (plan W1 step 3). Same pass-through rationale. */
export function wcUnsupportedChains(): WcSdkError {
  return getSdkError('UNSUPPORTED_CHAINS');
}

/** Everything worth restoring a UI from: settled sessions plus whatever proposals/requests are
 *  pending right now. Passive by design — reads the CACHED client and never initializes one (a
 *  state read must not stand up a relay socket). Returns null when disabled or never initialized. */
export async function discover(): Promise<{
  sessions: ReturnType<WalletKitInstance['getActiveSessions']>;
  pendingProposals: ReturnType<WalletKitInstance['getPendingSessionProposals']>;
  pendingRequests: ReturnType<WalletKitInstance['getPendingSessionRequests']>;
} | null> {
  if (!walletKitSupported() || !cachedKit) return null;
  const kit = await cachedKit;
  return {
    sessions: kit.getActiveSessions(),
    pendingProposals: kit.getPendingSessionProposals(),
    pendingRequests: kit.getPendingSessionRequests(),
  };
}

/** Drop a settled session from dpay's side (the user disconnects a dApp). No-op when disabled or
 *  when no client was ever initialized. */
export async function disconnectSession(topic: string): Promise<void> {
  if (!walletKitSupported() || !cachedKit) return;
  const kit = await cachedKit;
  await kit.disconnectSession({topic, reason: getSdkError('USER_DISCONNECTED')});
}
