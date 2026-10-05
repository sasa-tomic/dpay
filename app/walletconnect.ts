/**
 * walletconnect — the WalletConnect v2 EIP-1193 provider source + pairing driver for the NATIVE
 * (Android) ckERC20 direct onramp. The web/browser path uses `window.ethereum` (see `wallet.ts`);
 * this module is the Android counterpart, reached ONLY via `wallet.ts`'s `resolveOnrampProvider()`
 * (web-first: it returns `window.ethereum` before ever reaching here) AND only when
 * `WALLETCONNECT_PROJECT_ID` is non-empty.
 *
 * NON-CUSTODIAL INVARIANT (load-bearing — see CLAUDE.md): WalletConnect brokers an ENCRYPTED
 * request/response between this dApp and the user's wallet app. The wallet signs locally and
 * returns ONLY a signature / transaction hash. dpay sends `{method, params}` and receives hashes —
 * it NEVER sees, holds, or transports the user's Ethereum key. This module adds ZERO key surface.
 *
 * PAIRING (MC8 U6 capstone): WC's built-in QR modal (`@reown/appkit/core`) is web-only and has no
 * RN-resolvable subpath — at runtime it would crash. We bypass it entirely: `showQrModal:false` in
 * `EthereumProvider.init`, then `pairWalletConnect(onUri)` subscribes to the provider's `display_uri`
 * event (the SDK emits the WC pairing URI as a plain string — see `IProviderEvents.EventArguments`
 * in the installed .d.ts) and forwards it to the caller, which renders a custom on-brand `<QRCode>`
 * (react-native-qrcode-svg, already a dep). When the wallet approves the session the `connect` event
 * fires → `onUri(null)` clears the QR. This makes the @reown/appkit import path RUNTIME-UNREACHABLE
 * (ethereum-provider only dynamic-imports the modal when showQrModal is true), so the Metro shim
 * (`app/shims/reown-appkit-core.js`) is a pure build-time satisfier — see its FIXME.
 *
 * Isolation (load-bearing — `just verify` never executes WalletConnect code): this module is the
 * ONLY file in the app that statically imports `@walletconnect/*`. `wallet.ts`'s
 * `resolveOnrampProvider()` + `pairOnrampWallet()` reach it via a lazy dynamic `import('./walletconnect')`
 * that the web/jest path never takes (web-first resolver returns `window.ethereum` first; jest has no
 * `window.ethereum` AND an empty `WALLETCONNECT_PROJECT_ID` via jest.setup.js, so the dynamic import
 * is never evaluated). Belt-and-braces: the e2e vite build aliases `@walletconnect/ethereum-provider` +
 * `@walletconnect/react-native-compat` to no-op shims (e2e/vite.config.js), and jest's
 * moduleNameMapper maps `^@walletconnect/.*` to a stub (__stubs__/walletconnect-stub.ts) — so even
 * a stray import resolves to a no-op, never real WC code.
 */
import {Platform, Linking} from 'react-native';
import {EthereumProvider} from '@walletconnect/ethereum-provider';
import '@walletconnect/react-native-compat'; // side-effect: RN polyfills for the WC SDK
import {WALLETCONNECT_PROJECT_ID} from './config/constants';
import {ChainNotApproved, PairingRejected, type Eip1193Provider, type KnownWallet} from './wallet';
import {M} from './i18n';

// The real EthereumProvider instance type (the package root exports a `const` value; the instance
// type is derived via InstanceType — see walletconnect-fake.ts for the detailed rationale).
type EthereumProviderInstance = InstanceType<typeof EthereumProvider>;

// PR3 — dpay-side bound on `provider.connect()`. The WC SDK's pairing topic has its own ~5min TTL,
// but dpay must NOT rely silently on that internal behavior: if the wallet never scans the QR, the
// sheet would otherwise wait indefinitely on `connect()` with no honest error. 5min is generous
// (matches the SDK's pairing-topic TTL ceiling) and surfaces a truthful "timed out" error to the
// user instead of an infinite spinner. Exported so the test can advance fake timers by exactly this.
export const PAIR_TIMEOUT_MS = 5 * 60 * 1000;

// PR13 — the Android deep link the wallet opens to send the user back to dpay after they approve
// (passed as WC `metadata.redirect.native`). It MUST be a URL SCHEME this build actually claims;
// an Android `applicationId` is NOT a URL scheme, so the previous "org.kalaj.dpay://" resolved to
// nothing on the device and stranded the user in their wallet app. The schemes this build claims
// are declared in `app/android/app/src/main/AndroidManifest.xml`, and only the private `dpay` one
// can carry a bare "come back" URL (the other, https, is host- and path-scoped to payment links).
// Exported so walletconnect.test.ts can pin it AGAINST that manifest — the drift this fixes has to
// stay impossible, and a literal repeated in a test would only drift alongside it.
// Landing on it costs nothing: `Wallet.handleUrl` routes a payment link or a `dpay:pay/<blob>`
// receipt and ignores anything else, so the WC return URL just foregrounds the app.
export const ANDROID_DEEP_LINK = 'dpay://';

// The storage key `@walletconnect/sign-client` reads before every session request to decide which
// wallet to foreground (`getDeepLink(core.storage, "WALLETCONNECT_DEEPLINK_CHOICE")` →
// `handleDeeplinkRedirect`). It is declared by the SDK as a literal
// (`@walletconnect/sign-client/dist/types/constants/client.d.ts`) but NOT importable here: that
// package is a transitive dependency, and under jest every `@walletconnect/*` specifier resolves to
// the stub. So it is written once, here, and walletconnect.test.ts reads the SDK's own declaration
// and fails if the two ever disagree. Exported for that pin and for the teardown assertions.
export const WALLETCONNECT_DEEPLINK_CHOICE = 'WALLETCONNECT_DEEPLINK_CHOICE';

// How a USER REJECTION reaches `pairWalletConnect`'s catch, read out of the installed SDK: the
// wallet answers the proposal with `getSdkError("USER_REJECTED")` = `{code: 5000, message: "User
// rejected."}` (the CHAINS/METHODS/EVENTS variants are 5001-5003, worded "User rejected …"). That
// JSON-RPC error travels as a PLAIN OBJECT — `createDelayedPromise`'s reject takes an
// `ErrorResponse`, not an Error — until `EthereumProvider.connect()` catches it and re-throws
// `new Error(error.message)`, DROPPING the code. So by the time dpay sees it the code is gone and
// the message is the only signal left: matching on it is not a shortcut taken for convenience, it
// is the entire remaining evidence. Done ONCE, here, so callers switch on a type instead.
const USER_REJECTED = /user rejected/i;

// The single cached init promise, kept for the LIFE OF THE PROCESS. WalletConnect's pairing/session
// is long-lived, and every `EthereumProvider.init` builds a fresh WalletConnect Core — relay socket
// included — that its own `disconnect()` never tears down (it drops the SESSION only), so a
// disconnect→init cycle per sheet open accumulated live Cores on-device (OPEN_ISSUES: "WalletConnect
// Core is already initialized… Init() was called N times"). Init ONCE; every pair/tear-down cycle
// reuses this instance, rebinding the requested chains per pairing via `connect({chains})` — the
// SDK-supported rebind (`ConnectOps.chains` re-seeds the namespaces `connect` proposes with).
//
// The only thing that may reset the cache is a REJECTED init (see `ensureProvider`): a failed init
// would otherwise wedge the module forever now that nothing else ever clears it.
//
// MC8 U6 capstone — typed as `Promise<EthereumProviderInstance>` (the FULL provider surface) so
// `pairWalletConnect` can use `.on('display_uri', ...)` / `.connect()` / `.removeListener(...)`.
// `getWalletConnectProvider()` narrows it to `Eip1193Provider | null` on return — the assignability
// is pinned at compile time by walletconnect-conformance.test.ts (`_promisePin` +
// `_instanceToEip1193`), so an SDK bump that breaks the narrowing fails `just typecheck`.
let cachedProvider: Promise<EthereumProviderInstance> | null = null;

/** The lazy singleton creator both entry points share. The FIRST call wins the init-time `chains`
 *  (the provider is constructed bound to that network); every later pairing rebinds the requested
 *  chains via `connect({chains})` in `pairWalletConnect`. A REJECTED init drops the cache so the
 *  next open retries rather than wedging on a dead promise forever — the recovery the old
 *  clear-on-disconnect used to provide, now that disconnect clears nothing. */
function ensureProvider(chainId: number): Promise<EthereumProviderInstance> {
  if (cachedProvider) return cachedProvider;
  const init = initProvider(chainId);
  init.catch(() => {
    // Drop only OUR OWN still-cached promise: a later, successful init must not be evicted by a
    // stale handler. Callers still see the rejection through the returned promise.
    if (cachedProvider === init) cachedProvider = null;
  });
  cachedProvider = init;
  return init;
}

/**
 * Initialize the provider with the capstone options (showQrModal:false — we render the QR ourselves).
 *
 * `chainId` (OPEN_ISSUES #1/#2 testnet wiring) is the EVM chain the requested ckERC20 currency
 * settles on (ckUSDC = 1 Ethereum mainnet; ckSepoliaUSDC = 11155111 Sepolia). It seeds BOTH
 * `chains` and `optionalChains` so the WC session binds to the EXACT network the deposit targets —
 * a mainnet-only session would force the user to switch networks (and the chain-id gate in
 * CkErc20DepositSheet aborts a wrong-network wallet anyway), and a Sepolia deposit MUST pair against
 * Sepolia from the start. Default 1 (mainnet) preserves the pre-testnet behavior for callers that
 * don't thread the currency's chain_id.
 */
function initProvider(chainId: number = 1): Promise<EthereumProviderInstance> {
  return EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [chainId], // the chain the ckERC20 deposit settles on (MC8 U3 gate + testnet wiring)
    optionalChains: [chainId],
    showQrModal: false, // MC8 U6 capstone: bypass the web-only @reown/appkit modal; render our own QR.
    metadata: {
      name: 'dpay',
      description: 'dpay non-custodial wallet',
      url: 'https://dpay.kalaj.org',
      icons: [],
      redirect: {native: ANDROID_DEEP_LINK}, // PR13: deep-link back into this app after the wallet signs
    },
  });
}

/**
 * Get the WalletConnect EIP-1193 provider (singleton). Returns null when WalletConnect is DISABLED
 * — i.e. on web (`Platform.OS === 'web'` — the browser uses `window.ethereum` instead) or when no
 * `WALLETCONNECT_PROJECT_ID` is configured (empty = disabled). When enabled, initializes the
 * provider once and caches the promise; the resolved provider's `.request` IS the EIP-1193 surface
 * `wallet.ts` consumes.
 *
 * `chainId` (OPEN_ISSUES #1/#2): the EVM chain the requested ckERC20 currency settles on. The FIRST
 * call wins the init-time `chains:[chainId]`; `pairWalletConnect` owns chain correctness from there
 * — it reuses a session that already approved the requested chain, drops the session when it covers
 * some other chain, and re-pairs on the requested one via `connect({chains})`. The PROVIDER
 * instance survives every one of those cycles (one WC Core per app run), so a provider resolved
 * before a pairing is never invalidated by it.
 * Default 1 (mainnet) for callers that don't thread the currency's chain_id.
 */
export async function getWalletConnectProvider(
  chainId: number = 1,
): Promise<Eip1193Provider | null> {
  // Disabled guard (defense-in-depth — `resolveOnrampProvider()` already gates Platform + projectId
  // before dynamically importing this module; this makes the module self-protecting too).
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return null;
  // EthereumProviderInstance is assignable to Eip1193Provider (request signature compatible) —
  // pinned by walletconnect-conformance.test.ts. No cast needed (pure assignability).
  return ensureProvider(chainId);
}

/** A settled WalletConnect session, as the SDK's own provider surface types it (no cast, no new dep). */
export type WalletConnectSession = NonNullable<EthereumProviderInstance['session']>;

/**
 * The EIP-155 chain ids a settled session APPROVED — i.e. what the WALLET agreed to, deduped, in
 * the order it returned them. It is the only network check with any meaning on this transport; why
 * `eth_chainId` is not: `getChainId` in wallet.ts.
 *
 * A WC v2 session may key `namespaces` by bare namespace (`eip155`) or chain-scoped (`eip155:1`),
 * so every entry's `accounts` is flattened; each account is CAIP-10 `eip155:<chainId>:<address>`.
 */
function approvedChainIds(session: WalletConnectSession): string[] {
  const ids = new Set<string>();
  for (const ns of Object.values(session.namespaces)) {
    for (const account of ns.accounts) {
      const [namespace, reference] = account.split(':');
      if (namespace === 'eip155' && reference) ids.add(reference);
    }
  }
  return [...ids];
}

/**
 * MC8 U6 capstone — establish a WalletConnect session for `chainId`, surfacing the pairing URI for
 * a custom QR when (and only when) a pairing is actually needed.
 *
 * THREE STATES, no fallbacks:
 *  (a) no session → pair. With `showQrModal:false` the SDK does NOT open its own modal; it emits the
 *      pairing URI via `display_uri` (payload: a plain `string` — the `wc:` URI the wallet scans).
 *      This subscribes BEFORE calling `connect()`, forwards the URI to `onUri` (the sheet renders a
 *      custom `<QRCode>`), and clears it (`onUri(null)`) when the `connect` event fires. Listeners
 *      are removed on success AND failure so a subsequent pair doesn't double-fire.
 *  (b) a session that already approved `chainId` → REUSE it: no `connect()`, no URI, and no second
 *      approval prompt in the wallet. Re-pairing a live session was prompting the user on every
 *      sheet open.
 *  (c) a session that does NOT approve `chainId` (e.g. a cached mainnet session while a Sepolia
 *      deposit is requested) → drop the SESSION (the provider and its Core are reused — no
 *      re-init, no second Core) and re-pair on the requested chain.
 *
 * Then, in every state, the WALLET's own approval is verified against `chainId` — see the check at
 * the end. Throws on pair failure or a wrong-network approval (the caller surfaces the message).
 *
 * Disabled guard: web Platform / empty projectId → returns immediately (no-op). This mirrors
 * `getWalletConnectProvider()`'s guard and makes `pairOnrampWallet`'s delegation safe.
 *
 * `chainId` (OPEN_ISSUES #1/#2): the EVM chain the requested ckERC20 currency settles on, threaded
 * into `connect({chains})` (and into `initProvider` on the very first init) so the pairing session
 * binds to that network. Default 1 (mainnet).
 */
export async function pairWalletConnect(
  onUri: (uri: string | null) => void,
  chainId: number = 1,
): Promise<void> {
  // Disabled guard — same gate as getWalletConnectProvider (defense-in-depth).
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return;
  const provider = await ensureProvider(chainId);

  const restored = provider.session;
  if (restored) {
    // (b) the live/restored session already covers this chain — done, nothing to prompt.
    if (approvedChainIds(restored).includes(String(chainId))) return;
    // (c) it covers some other chain: the session cannot be moved — drop it and re-pair on the
    //     requested chain. The PROVIDER stays cached and alive; only the session dies.
    await dropSession(provider);
  }

  // Subscribe BEFORE connect() so the display_uri event (emitted during connect) is never missed.
  // The display_uri payload is a plain string (the WC pairing URI); the connect payload is
  // ProviderInfo {chainId} — we ignore it and just signal "paired" via onUri(null).
  const onDisplayUri = (uri: string) => onUri(uri);
  const onConnect = () => onUri(null);
  provider.on('display_uri', onDisplayUri);
  provider.on('connect', onConnect);

  // PR3 — bound connect() with Promise.race + PAIR_TIMEOUT_MS so a wallet that never scans the QR
  // surfaces an honest "timed out" error instead of hanging forever on the SDK's internal TTL. The
  // timeout promise's timer is cleared in `finally` on the happy path (no dangling timer). Declared
  // in the enclosing scope so `finally` can clear it (a `let` inside `try` would be out of scope).
  // NOTE: Promise.race cannot truly cancel the underlying connect() (JS promises aren't
  // cancellable) — the SDK's connect() stays pending until its own pairing-topic TTL or until
  // `disconnectWalletConnect()` tears the session down (the sheet wires that on close; the next
  // `connect()` also runs the SDK's `cleanupPendingPairings()`, retiring the abandoned topic).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // connect() initiates the pairing handshake; it resolves when the session is established (the
    // wallet approved). The SDK emits display_uri (→ onUri(uri)) during this call, then connect
    // (→ onUri(null)) when the session settles. `connect({chains, optionalChains})` rebinds the
    // proposed networks for THIS pairing (`ConnectOps` → `loadConnectOpts` overwrites the provider's
    // rpc config), so a reused provider pairs on the chain this deposit needs even when its first
    // init bound another. Both fields, exactly as `initProvider` seeds them — leaving
    // optionalChains at its init value would let the wallet offer that first chain as an optional
    // add-on to (say) a Sepolia pairing.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(M.errors.ethWallet.pairingTimedOut)),
        PAIR_TIMEOUT_MS,
      );
    });
    await Promise.race([
      provider.connect({chains: [chainId], optionalChains: [chainId]}),
      timeout,
    ]);
  } catch (e) {
    // The ONE place that holds the SDK's own error, so the rejection-vs-other call is made here and
    // travels as a TYPE (see USER_REJECTED above for what the evidence actually is).
    const detail = e instanceof Error ? e.message : String(e);
    if (USER_REJECTED.test(detail)) throw new PairingRejected(detail);
    throw new Error(M.errors.ethWallet.pairingFailed(detail));
  } finally {
    // Always clean up listeners + the timeout timer (success OR failure) so a re-pair doesn't stack
    // duplicate handlers or leak a dangling timer.
    if (timer) clearTimeout(timer);
    provider.removeListener('display_uri', onDisplayUri);
    provider.removeListener('connect', onConnect);
  }

  // The network check that MEANS something on this transport: what the wallet actually approved.
  // `connect()` resolving proves a session settled, not that it settled on the chain this deposit
  // needs — a wallet may approve a subset. No session at all is the same failure with an empty
  // approval set, so it lands on the same honest error rather than continuing on nothing.
  const settled = provider.session;
  const approved = settled === undefined ? [] : approvedChainIds(settled);
  if (!approved.includes(String(chainId))) throw new ChainNotApproved(chainId, approved);
}

/**
 * Same-device pairing for a wallet dpay cannot name — hands the `wc:` URI to the OS intent chooser.
 * The route for the 200+ WalletConnect wallets outside `KNOWN_WALLETS`; the named route is
 * `openWalletWithUri` in wallet.ts, which goes through `recordWalletChoice` below.
 *
 * KNOWN CONSEQUENCE, and it is the correct trade: this path records NOTHING, because the chooser
 * never tells dpay which app the user picked and a guessed choice would foreground the wrong wallet
 * for every later request. So pairing works, but the wallet is NOT brought to the front when the
 * deposit is signed — the user has to switch to it by hand. Callers must say so rather than leave
 * the user staring at a spinner. (The named route is what avoids this; it exists for that reason.)
 *
 * Disabled guard: web Platform / empty projectId → false, mirroring the other exports.
 */
export async function openWalletApp(uri: string): Promise<boolean> {
  // Disabled guard — same gate as the other exports (defense-in-depth).
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return false;
  try {
    // On Android the `wc:` scheme routes to an installed wallet (MetaMask/Trust/Rabby) via the
    // system intent chooser. The wallet reads the pairing URI from the intent, connects to the WC
    // relay, and the session establishes the same way a QR scan would — the user approves there and
    // returns to dpay via the redirect.native deep-link (PR13). This is the same-device alternative
    // to scanning the QR (which needs a second device).
    await Linking.openURL(uri);
    return true;
  } catch {
    // No wallet app registered for the `wc:` scheme (or the intent chooser was dismissed). The
    // caller keeps the QR visible so the user can scan with a wallet on another device.
    return false;
  }
}

/**
 * Record which wallet the user opened, so the SDK foregrounds THAT wallet for every later session
 * request. Called from `openWalletWithUri` in wallet.ts, across the lazy dynamic-import boundary.
 *
 * WHY IT HAS TO EXIST: `@walletconnect/sign-client` only deep-links back into the wallet when it can
 * read `WALLETCONNECT_DEEPLINK_CHOICE` from its own storage — `handleDeeplinkRedirect` returns
 * immediately when that value is absent — and its only other writer is `@reown/appkit`, which dpay
 * deliberately shims out. Without this write an `eth_sendTransaction` sits invisibly in a
 * backgrounded wallet app and the user watches a spinner.
 *
 * THE STORED SHAPE IS THE CONSUMER'S, not a choice: `handleDeeplinkRedirect` JSON-parses the value
 * and returns unless `.href` is a string, then `formatDeeplinkUrl` appends
 * `/wc?requestId=…&sessionTopic=…` after stripping ONE trailing slash. So `href` is the BARE scheme
 * (`trust://` → `trust://wc?requestId=…`), never the pairing link. `name` rides along for
 * diagnostics. `@walletconnect/keyvaluestorage`'s react-native build JSON-stringifies a non-string
 * value and applies no key prefix, so handing it the object is exactly right.
 *
 * Fails fast when nothing is paired: the write must land in the storage of the provider that owns
 * the session, and a choice recorded against no session would point the SDK at a wallet dpay never
 * paired with. Disabled guard: web Platform / empty projectId → no-op, mirroring the other exports.
 */
export async function recordWalletChoice(wallet: KnownWallet): Promise<void> {
  // Disabled guard — same gate as the other exports (defense-in-depth).
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return;
  const cached = cachedProvider;
  if (!cached) {
    throw new Error(
      `recordWalletChoice: no WalletConnect provider - pair before opening ${wallet.name}`,
    );
  }
  const provider = await cached;
  // The SDK's OWN storage, reached through its own typed path — the same object `getDeepLink` reads
  // from. Cast-free, so an SDK change to this path fails `just typecheck` right here.
  await provider.signer.client.core.storage.setItem(WALLETCONNECT_DEEPLINK_CHOICE, {
    href: wallet.scheme,
    name: wallet.name,
  });
}

/**
 * The session teardown shared by `pairWalletConnect`'s wrong-chain re-pair and the public
 * `disconnectWalletConnect`: drop the recorded wallet choice, then the session itself. The PROVIDER
 * (and its WalletConnect Core) is deliberately left alive — see the note on `cachedProvider`.
 * A teardown failure is LOGGED, never propagated: both callers are fire-and-forget/flow-continuing
 * (the sheet's unmount cleanup; the re-pair that follows immediately).
 */
async function dropSession(provider: EthereumProviderInstance): Promise<void> {
  try {
    // Drop the recorded wallet choice BEFORE disconnecting. It outlives the session otherwise, and
    // a stale href foregrounds a wallet the user is no longer paired with. Order matters: an
    // already-dropped session makes `disconnect()` throw routinely, and that must not gate this.
    await provider.signer.client.core.storage.removeItem(WALLETCONNECT_DEEPLINK_CHOICE);
    // The real provider no-ops `disconnect()` when no session is settled (`this.session && …`), so
    // the sheet's mid-pair teardown is safe to fire at any state.
    await provider.disconnect();
  } catch (e) {
    // Best-effort teardown — this runs fire-and-forget from a React unmount cleanup (or ahead of an
    // immediate re-pair), so the failure must not propagate. It is LOGGED, never silently dropped.
    console.warn(
      'disconnectWalletConnect: teardown failed:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * U6.5 — drop the cached WalletConnect provider's SESSION (wallet-choice record included). Safe to
 * call from a fire-and-forget teardown (the sheet's unmount cleanup) and idempotent at the SDK
 * level: `provider.disconnect()` is a no-op when no session is settled.
 *
 * The provider itself STAYS cached and alive. This is deliberate (see `cachedProvider`): a fresh
 * `EthereumProvider.init` per open accumulated live WC Cores — relay sockets included — because the
 * SDK's disconnect never tears a Core down. The next `pairWalletConnect()` reuses the instance and
 * re-pairs via `connect({chains})`, so the user still gets a clean re-pair; only the SESSION is
 * torn down here, never the transport.
 *
 * Disabled guard: web Platform / empty projectId → immediate no-op (mirrors the other exports, so
 * the sheet can call this unconditionally without special-casing the disabled path).
 */
export async function disconnectWalletConnect(): Promise<void> {
  // Disabled guard — same gate as the other exports (defense-in-depth).
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return;
  const cached = cachedProvider;
  if (!cached) return; // nothing cached (never initialized) → no-op.
  await dropSession(await cached);
}
