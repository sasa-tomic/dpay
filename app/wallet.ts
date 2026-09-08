/**
 * wallet — the EIP-1193 provider seam for the ckERC-20 direct onramp.
 *
 * The onramp is NON-CUSTODIAL: dpay never sees the user's Ethereum key. The user connects their own
 * wallet (`window.ethereum` on web; WalletConnect v2 on Android — see `walletconnect.ts`), dpay
 * BUILDS the two transactions' calldata (see `cketh.ts`), and the user's wallet SIGNS + broadcasts.
 * This module is the thin transport over the EIP-1193 provider — it does no key handling.
 *
 * `resolveOnrampProvider()` is the provider SOURCE picker (MC8 U6.2): web-first — it returns
 * `window.ethereum` when present (the browser path + the e2e mock provider flow 16 installs), and
 * otherwise lazily dynamic-imports `./walletconnect` ONLY on native with a non-empty
 * `WALLETCONNECT_PROJECT_ID`. That dynamic import is the load-bearing isolation boundary: web/jest
 * never statically pull `@walletconnect/*`, so the offline inner loop (`just verify`) never executes
 * WalletConnect code. The dedicated transport helpers below (`connectWallet`/`getChainId`/
 * `waitForReceipt`/`sendTransaction`) are pure and take `provider: Eip1193Provider` as a param —
 * they work identically against `window.ethereum` OR a WalletConnect provider.
 *
 * The mock-provider contract (unit test + e2e harness both use it): an object with a `request({method,
 * params}) -> Promise<unknown>` method, identical to the real EIP-1193 surface. The e2e mock records the
 * `eth_sendTransaction` params so a flow can assert the calldata is byte-exact vs the `cketh.ts` goldens
 * — proving the onramp wiring is correct offline, with zero real ETH movement.
 */

import {Linking, Platform} from 'react-native';
import {WALLETCONNECT_PROJECT_ID} from './config/constants';
import {M} from './i18n';

/** The minimal EIP-1193 provider surface this module uses (a subset of the real injected wallet). */
export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
};

// ── Every request() is BOUNDED ────────────────────────────────────────────────────────────────
// EIP-1193 defines no timeout parameter, which is a fact about the STANDARD and was never a reason
// for this app to wait forever: a WalletConnect request travels to a relay, to a phone, to a human,
// and any of those three can simply stop. Unbounded, `await p.request(…)` leaves the deposit sheet
// spinning with no error, no retry and no way back — and `waitForReceipt` was worse, because its
// 120 s deadline is only consulted BETWEEN polls, so one hung read disabled the deadline itself.
//
// The bound is on OUR side and, like the pairing bound it mirrors (`PAIR_TIMEOUT_MS`,
// walletconnect.ts), it cannot cancel the underlying call — a JS promise has no cancel. It ends OUR
// wait and hands the caller a decision; a late answer is simply ignored.

/** A request a HUMAN must act on in another app — connect, and sign. Five minutes: the same number
 *  `PAIR_TIMEOUT_MS` gives someone to scan a pairing QR, because it is the same person doing the
 *  same kind of thing (find the wallet, read a prompt, decide). Anything in seconds would time out
 *  people, not wallets. */
export const WALLET_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** A request NO human touches: `eth_chainId` (answered by the WalletConnect provider locally, or by
 *  an injected wallet over the wire) and a receipt read (routed by the eip155 provider to its own
 *  HTTP RPC). Thirty seconds is generous for a machine round trip and well inside
 *  `waitForReceipt`'s 120 s budget, so a stalled read costs at most one poll. */
export const WALLET_READ_TIMEOUT_MS = 30_000;

/**
 * A wallet request that ran out of time on OUR side.
 *
 * Its message SAYS SO, in the user's language — the wallet did not answer, so open it, deal with
 * whatever is waiting there, and try again. It used to be deliberately empty, routing every caller's
 * `e.message || <localized fallback>` to a generic "Could not connect to your wallet"; that fallback
 * named no cause and no next action, and a wallet that never answered is a different thing from a
 * wallet that refused. The diagnostic — which method, which bound — stays on `method`/`timeoutMs`
 * and in the log line at the throw site, because it is for us, not for the user.
 *
 * This message is only ever right when NOTHING WAS SIGNED. `sendTransaction` catches this type and
 * rethrows `TransactionHashMissing`, whose copy does not tell the user to try again — see there.
 */
export class WalletRequestTimeout extends Error {
  override readonly name = 'WalletRequestTimeout';
  constructor(public readonly method: string, public readonly timeoutMs: number) {
    super(M.errors.ethWallet.requestTimedOut);
  }
}

/** An OS call across the React Native bridge — `Linking.canOpenURL` / `Linking.openURL`. Local, so
 *  it should answer in milliseconds; five seconds is a stall detector. It matters because
 *  `installedWallets()` fires one probe per known wallet and the picker waits for all of them, so a
 *  single wedged bridge call used to leave the sheet with a spinner and no way forward. */
export const WALLET_OS_TIMEOUT_MS = 5_000;

/**
 * `work`, or `WalletRequestTimeout` after `timeoutMs`. The timer is cleared on BOTH outcomes, so a
 * fast answer leaves no pending handle (the leak that would otherwise keep a React Native app's
 * timer queue alive for five minutes after every single call). It cannot cancel `work` — a JS
 * promise has no cancel — it ends OUR wait; a late answer is ignored.
 */
async function bounded<T>(work: Promise<T>, what: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          console.warn(`wallet: ${what} was not answered within ${timeoutMs} ms — giving up on this attempt`);
          reject(new WalletRequestTimeout(what, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One EIP-1193 round trip, bounded. */
async function boundedRequest(
  p: Eip1193Provider,
  args: { method: string; params?: unknown[] | object },
  timeoutMs: number,
): Promise<unknown> {
  return bounded(p.request(args), args.method, timeoutMs);
}

/** True where an injected wallet could exist (react-native-web). Native uses WalletConnect later. */
function isWeb(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as { window?: unknown }).window !== 'undefined';
}

/**
 * Get the injected EIP-1193 provider (`window.ethereum`). Returns null on native, or on web when no
 * wallet is installed. Some wallets expose an array (`window.ethereum.providers`); pick the first.
 */
export function getEthereumProvider(): Eip1193Provider | null {
  if (!isWeb()) return null;
  const w = (globalThis as { ethereum?: Eip1193Provider & { providers?: Eip1193Provider[] } }).ethereum;
  if (!w) return null;
  if (Array.isArray(w.providers) && w.providers.length > 0) return w.providers[0];
  return w;
}

/**
 * MC8 U6.2 — resolve the onramp EIP-1193 provider SOURCE. Web-first:
 *  (a) `window.ethereum` when present (the browser path; the e2e harness mock provider; the ONLY
 *      path `just verify` ever exercises). Returned FIRST, before any WalletConnect code is reached.
 *  (b) else, on native AND with a non-empty `WALLETCONNECT_PROJECT_ID`, lazily dynamic-import
 *      `./walletconnect` (the isolation boundary — web/jest never statically pull `@walletconnect/*`)
 *      and return its singleton WalletConnect provider.
 *  (c) else null (no onramp source available — the UI offers the manual path).
 *
 * The (a)→(b) ordering is load-bearing: it GUARANTEES the web/browser path and flow 16's mock
 * provider return `window.ethereum` unchanged, so WalletConnect is invisible to the offline inner
 * loop. The transport helpers below (`connectWallet`/`sendTransaction`/…) consume the result purely
 * via the `Eip1193Provider` interface, so they are source-agnostic.
 *
 * `chainId` (OPEN_ISSUES #1/#2): the requested ckERC20 currency's EVM chain id (ckUSDC=1 mainnet,
 * ckSepoliaUSDC=11155111 Sepolia). Passed through to `getWalletConnectProvider` so the WC session
 * binds to the deposit's target network. Default 1 (mainnet) — the pre-testnet behavior.
 */
export async function resolveOnrampProvider(
  chainId: number = 1,
): Promise<Eip1193Provider | null> {
  // (a) Web-first — the injected browser wallet / the e2e mock. Never reaches WalletConnect.
  const web = getEthereumProvider();
  if (web) return web;
  // (b) Native + configured → lazy-load the WalletConnect source (the dynamic import is the
  //     isolation boundary; this line is unreachable on web/jest because (a) returned or the
  //     Platform/projectId gate fails closed).
  if (Platform.OS !== 'web' && WALLETCONNECT_PROJECT_ID) {
    const {getWalletConnectProvider} = await import('./walletconnect');
    return getWalletConnectProvider(chainId);
  }
  // (c) No onramp source available.
  return null;
}

/**
 * MC8 U6 capstone — pair the onramp wallet (WalletConnect session establishment). Web-first /
 * disabled → returns `false` (no dynamic import, no WC code touched). Native + configured → lazily
 * dynamic-imports `./walletconnect` (the isolation boundary — the sheet imports ONLY from wallet.ts,
 * never statically from walletconnect.ts) and delegates to `pairWalletConnect(onUri)`, which
 * subscribes to the WC `display_uri` event and drives the pairing. Returns `true` after a successful
 * delegation. The sheet renders a custom `<QRCode>` from the URI `onUri` surfaces.
 *
 * Mirrors `resolveOnrampProvider()`'s web-first ordering and isolation boundary exactly. `chainId`
 * (OPEN_ISSUES #1/#2) threads the requested currency's EVM chain into the pairing session.
 */
export async function pairOnrampWallet(
  onUri: (uri: string | null) => void,
  chainId: number = 1,
): Promise<boolean> {
  // Web-first / disabled — no dynamic import is ever evaluated on the web/jest path.
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return false;
  // Native + configured → lazy-load the WC pairing driver (the dynamic import is the isolation
  // boundary; this line is unreachable on web/jest because the gate above short-circuits).
  const {pairWalletConnect} = await import('./walletconnect');
  await pairWalletConnect(onUri, chainId);
  return true;
}

/**
 * Same-device pairing for a wallet dpay cannot name — hands the `wc:` URI to the OS intent chooser.
 * The "other wallet" route, kept for the 200+ WalletConnect wallets outside `KNOWN_WALLETS`; the
 * named route is `openWalletWithUri` below. Mirrors `pairOnrampWallet()`'s web-first / disabled gate
 * + lazy dynamic import isolation boundary: web / disabled → false (no dynamic import); native +
 * configured → delegates to walletconnect.ts's `openWalletApp`, whose doc records what this route
 * costs the user.
 */
export async function openWalletApp(uri: string): Promise<boolean> {
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return false;
  const {openWalletApp: open} = await import('./walletconnect');
  return open(uri);
}

/**
 * A wallet dpay can name, open by itself, and record a deeplink choice for. Three fields, because
 * three is what the picker needs: the display name, the app's own URL scheme (`mobile.native` in
 * the WalletConnect Explorer), and the Android application id — which the manifest's `<queries>`
 * block must declare or `Linking.canOpenURL` answers false for an installed wallet.
 */
export type KnownWallet = {
  name: string;
  scheme: string;
  androidPackage: string;
};

/**
 * The wallets the picker can offer by name.
 *
 * SOURCE — a live query of the WalletConnect Explorer API
 * (`https://explorer-api.walletconnect.com/v3/wallets`, this project's own projectId), each row's
 * `mobile.native` and Play `id=` cross-checked against the store listing, 2026-08-30. Every value
 * here is that response verbatim; nothing is inferred, corrected or abbreviated. Adding a wallet
 * means querying the Explorer again — never guessing a scheme.
 *
 * WHY A LIST AND NOT THE SYSTEM CHOOSER: `@walletconnect/sign-client` foregrounds the wallet for a
 * signing request only when a deeplink choice was recorded for it (see `recordWalletChoice` in
 * walletconnect.ts). Recording one requires KNOWING which wallet was opened, which the `wc:` intent
 * chooser (`openWalletApp` above) cannot report. The list is what makes the choice knowable; the
 * chooser stays as the route for everything not on it.
 *
 * `AndroidManifest.xml`'s `<queries>` block must agree with this table exactly — pinned by
 * `__tests__/wallet-picker.test.ts`, which derives the expectation from these rows.
 */
export const KNOWN_WALLETS: readonly KnownWallet[] = [
  {name: 'Trust Wallet', scheme: 'trust://', androidPackage: 'com.wallet.crypto.trustapp'},
  {name: 'MetaMask', scheme: 'metamask://', androidPackage: 'io.metamask'},
  {name: 'Rainbow', scheme: 'rainbow://', androidPackage: 'me.rainbow'},
  {name: 'Zerion', scheme: 'zerion://', androidPackage: 'io.zerion.android'},
  {name: 'Safe', scheme: 'safe://', androidPackage: 'global.safe.mobileapp'},
  {name: 'Uniswap Wallet', scheme: 'uniswap://', androidPackage: 'com.uniswap.mobile'},
];

/**
 * The `KNOWN_WALLETS` rows this device can actually open, in table order — what the picker lists.
 *
 * Disabled gate (web / empty projectId → `[]`) for two independent reasons, either of which alone
 * would justify it: on web `react-native-web`'s `Linking.canOpenURL` resolves `true` for every URL
 * unconditionally, so the answer there would be six wallets dpay has NOT established are installed;
 * and with WalletConnect disabled there is no pairing URI to open one with. A probe that throws
 * drops only its own wallet — one broken scheme must not blank the whole picker — and says why.
 */
export async function installedWallets(): Promise<KnownWallet[]> {
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return [];
  const probed = await Promise.all(
    KNOWN_WALLETS.map(async (wallet) => {
      try {
        const can = await bounded(
          Linking.canOpenURL(wallet.scheme),
          `Linking.canOpenURL(${wallet.scheme})`,
          WALLET_OS_TIMEOUT_MS,
        );
        return can ? wallet : null;
      } catch (e) {
        console.warn(
          `installedWallets: canOpenURL(${wallet.scheme}) failed:`,
          e instanceof Error ? e.message : String(e),
        );
        return null;
      }
    }),
  );
  return probed.filter((wallet): wallet is KnownWallet => wallet !== null);
}

/**
 * Open `wallet` on the pairing URI and record it as the deeplink choice, so every LATER signing
 * request in this session brings that same wallet to the front (see `recordWalletChoice`).
 *
 * The link shape is `${scheme}wc?uri=${encodeURIComponent(uri)}` — what
 * `@reown/appkit-controllers`' `formatNativeUrl` emits and therefore what every AppKit dapp sends;
 * Trust documents the identical `/wc?uri=` shape for its own scheme. Note it is NOT what gets
 * STORED: the stored href is the bare scheme, because the consumer appends its own path.
 *
 * Returns whether the WALLET OPENED — that, and only that, is what the caller can tell the user
 * about. A failed open returns false and records nothing (a choice for a wallet that never opened
 * would foreground the wrong app later). A failed RECORD still returns true, because the wallet is
 * in the foreground and saying otherwise would be false; it is logged, never swallowed.
 * Same web-first / disabled gate + lazy dynamic import boundary as the exports above.
 */
export async function openWalletWithUri(wallet: KnownWallet, uri: string): Promise<boolean> {
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return false;
  const link = `${wallet.scheme}wc?uri=${encodeURIComponent(uri)}`;
  try {
    await bounded(Linking.openURL(link), `Linking.openURL(${wallet.name})`, WALLET_OS_TIMEOUT_MS);
  } catch (e) {
    console.warn(
      `openWalletWithUri: ${wallet.name} did not open ${link}:`,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
  try {
    const {recordWalletChoice} = await import('./walletconnect');
    await recordWalletChoice(wallet);
  } catch (e) {
    console.warn(
      `openWalletWithUri: recording the ${wallet.name} deeplink choice failed:`,
      e instanceof Error ? e.message : String(e),
    );
  }
  return true;
}

/**
 * Connect: `eth_requestAccounts` → the first authorized account address (0x…). Throws if the user
 * rejects or no account is returned. (On real wallets this is the prompt the user explicitly approves.)
 */
export async function connectWallet(p: Eip1193Provider): Promise<string> {
  const accounts = (await boundedRequest(
    p,
    { method: 'eth_requestAccounts', params: [] },
    WALLET_APPROVAL_TIMEOUT_MS,
  )) as unknown[];
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('no account returned by the wallet');
  }
  return String(accounts[0]);
}

/**
 * Get the wallet's current chain id via `eth_chainId`, as a decimal number the caller compares to
 * the catalog's per-currency `chain_id` (MC8 U3).
 *
 * This DECODES THE TWO ENCODINGS dpay's two real transports emit — one codec, not a fallback:
 *  - an INJECTED wallet (`window.ethereum`) answers over the wire in the EIP-1193 encoding: a hex
 *    STRING, `"0x1"` = Ethereum mainnet, `"0x89"` = Polygon.
 *  - WALLETCONNECT answers a plain NUMBER, and answers it LOCALLY — the request never reaches the
 *    wallet. Verified in the installed SDK: `@walletconnect/universal-provider`'s eip155 provider
 *    has `case"eth_chainId":return parseInt(this.getDefaultChain());` over
 *    `getDefaultChain(){if(this.chainId)return this.chainId.toString(); …}`, and
 *    `@walletconnect/ethereum-provider` does not intercept it
 *    (`request(t,e){return await this.signer.request(t,this.formatChainId(this.chainId),e)}`).
 *    Two consequences: requiring the hex string made this throw on EVERY WalletConnect connect, and
 *    — because the value is just what dpay itself asked for at init, echoed back — it can NEVER
 *    detect a wallet on the wrong network over WalletConnect. That check is the session-approval
 *    check in `walletconnect.ts`; this one is real only for an injected wallet.
 *
 * Anything else throws, naming the value received: a decimal string (neither encoding, and never
 * emitted by either transport), a fraction, a negative, a non-safe integer, null. The caller treats
 * a throw as "cannot confirm the network" and fails closed — no calldata on an unconfirmed chain.
 */
export async function getChainId(p: Eip1193Provider): Promise<number> {
  const raw = await boundedRequest(p, { method: 'eth_chainId', params: [] }, WALLET_READ_TIMEOUT_MS);
  if (typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw, 16);
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  // `JSON.stringify` renders a bad NUMBER unhelpfully (NaN and Infinity both become "null"), so
  // numbers are shown with String() and everything else quoted/typed by JSON.
  throw new Error(
    M.errors.ethWallet.invalidChainId(typeof raw === 'number' ? String(raw) : JSON.stringify(raw)),
  );
}

// MC8 U4 — the ONE typed receipt error: a REVERT is the only receipt outcome a caller branches on
// (hard fail — the tx is mined and will never credit). It closes the false-"watching" bug where a
// reverted approve/deposit lied as "will appear in ~20 min". Every OTHER way the receipt fails to
// arrive (the poll timing out, the RPC read itself failing) leaves the caller in one identical
// position — broadcast, outcome unknown — so they stay plain Errors carrying their own message.
/** The transaction was mined but reverted (receipt status 0x0) — it will never credit. Hard fail. */
export class ReceiptReverted extends Error {
  override readonly name = 'ReceiptReverted';
  constructor(public readonly hash: string) {
    super(M.errors.ethWallet.receiptReverted(hash));
  }
}

/**
 * `eth_sendTransaction` produced no usable transaction hash — EITHER because the wallet answered
 * without one, OR because it did not answer at all inside `WALLET_APPROVAL_TIMEOUT_MS`. Typed
 * because neither is a failed send: the wallet may well have broadcast the transaction, and only
 * the hash is lost, so there is nothing to poll a receipt for and nothing to show on a block
 * explorer. Reporting it as "not sent" invites the user to pay the same money twice, which is why
 * the caller must be able to tell it apart from a decline.
 *
 * `reason` is the DIFFERENCE BETWEEN THE TWO, and it is user-facing rather than diagnostic: only
 * `'answered-without-id'` licenses saying anything at all about what the wallet did. On
 * `'no-answer'` dpay does not know the wallet ever saw the request, so the message says exactly
 * that and nothing more. `received` stays the diagnostic — the value that came back, or the bound
 * that expired. Neither message ends in "try again": the caller finishes the sentence with the
 * step-specific instruction (`M.deposit.erc20.{deposit,approve}HashUnknown`), because whether a
 * retry is safe depends on which transaction was being signed.
 */
export class TransactionHashMissing extends Error {
  override readonly name = 'TransactionHashMissing';
  constructor(
    public readonly received: string,
    public readonly reason: 'answered-without-id' | 'no-answer',
  ) {
    super(reason === 'no-answer' ? M.errors.ethWallet.sendTimedOut : M.errors.ethWallet.hashMissing(received));
  }
}

// Typed PAIRING errors, same contract as the two receipt errors above: the caller switches on the
// TYPE instead of sniffing the message. They live here rather than in `walletconnect.ts` for one
// reason — `instanceof` needs a VALUE import, and the deposit sheet must never statically import
// `@walletconnect/*` (the isolation boundary documented at the top of this file). `pairWalletConnect`
// decides which one to throw, once, where it still holds the SDK's own error.
/**
 * The user declined the pairing in their wallet. A deliberate choice, not a malfunction — the
 * caller must say "you declined", never "something went wrong". `detail` is the SDK's own wording,
 * kept for logs; the message stays the existing pairing-failed copy so a caller that renders it
 * verbatim reads exactly as before.
 */
export class PairingRejected extends Error {
  override readonly name = 'PairingRejected';
  constructor(public readonly detail: string) {
    super(M.errors.ethWallet.pairingFailed(detail));
  }
}
/**
 * The wallet settled a session, but not on the chain this deposit needs (a wallet may approve a
 * subset — or, with an empty `approved`, nothing at all). Carries both chain sets so the caller can
 * build its own copy without re-parsing the message.
 */
export class ChainNotApproved extends Error {
  override readonly name = 'ChainNotApproved';
  constructor(public readonly requested: number, public readonly approved: readonly string[]) {
    super(M.errors.ethWallet.chainNotApproved(requested, approved.join(', ')));
  }
}

/**
 * Poll `eth_getTransactionReceipt` until the transaction is mined or the timeout elapses (MC8 U4).
 * - mined `status === '0x1'` → `{status: 1, gasUsed?}` (success).
 * - mined `status === '0x0'` → throws `ReceiptReverted` (the caller surfaces an honest error + stays
 *   in the enter phase; never transitions to a false "watching").
 * - no receipt for the full timeout → throws a plain `Error` saying so. It is NOT typed, because a
 *   timed-out poll and a poll whose RPC read threw leave the caller in the identical position — the
 *   tx was broadcast and may still land — and the caller therefore treats both the same way
 *   (Fork-2 resolution: keep watching). `ReceiptReverted` is the only distinction that changes what
 *   the caller does.
 */
export async function waitForReceipt(
  p: Eip1193Provider,
  hash: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ status: number; gasUsed?: string }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // ONE POLL IS BOUNDED, AND A BOUNDED POLL IS NOT FATAL. Before this, a provider that never
    // answered a single read left this loop suspended forever and the `deadline` below was never
    // reached — the timeout existed but could not fire. A stalled read is now just a poll that
    // produced nothing, exactly like a pending transaction, and `deadline` decides when to stop.
    let receipt: unknown;
    try {
      receipt = await boundedRequest(p, { method: 'eth_getTransactionReceipt', params: [hash] }, WALLET_READ_TIMEOUT_MS);
    } catch (e) {
      // A real RPC failure still propagates (the caller treats it as "broadcast, outcome unknown"
      // and keeps watching — see this function's doc); only OUR bound is retried, and it was
      // already logged with the method and the bound by `boundedRequest`.
      if (!(e instanceof WalletRequestTimeout)) throw e;
      receipt = null;
    }
    if (receipt != null && typeof receipt === 'object') {
      const r = receipt as { status?: string; gasUsed?: string };
      if (typeof r.status === 'string') {
        if (r.status === '0x1') return { status: 1, gasUsed: r.gasUsed };
        if (r.status === '0x0') throw new ReceiptReverted(hash);
        throw new Error(`unexpected receipt status for ${hash}: ${r.status}`);
      }
    }
    if (Date.now() >= deadline) throw new Error(M.errors.ethWallet.receiptTimeout(hash));
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/** Encode a bigint amount as EIP-1193 hex (`0x…`; `0n` → `0x0`). */
function toHexValue(n: bigint): string {
  if (n < 0n) throw new Error('value cannot be negative');
  return '0x' + n.toString(16);
}

/**
 * Send a transaction from `from`. `data` is 0x-prefixed calldata (built by `cketh.ts`); `value` defaults
 * to 0 (approve + depositErc20 are contract calls, not ETH transfers). Returns the transaction hash.
 * Mirrors the real `eth_sendTransaction` param shape the wallet expects.
 *
 * A DECLINE propagates the wallet's own error verbatim; an accepted request that answers with no
 * usable hash throws `TransactionHashMissing` instead — see that class for why the two must not be
 * reported to the user as the same thing.
 */
export async function sendTransaction(
  p: Eip1193Provider,
  from: string,
  tx: { to: string; data: string; value?: bigint },
): Promise<string> {
  const params = [{ from, to: tx.to, data: tx.data, value: toHexValue(tx.value ?? 0n) }];
  let hash: unknown;
  try {
    hash = await boundedRequest(p, { method: 'eth_sendTransaction', params }, WALLET_APPROVAL_TIMEOUT_MS);
  } catch (e) {
    // A SILENT WALLET AND A LOST HASH LEAVE THE USER IN THE SAME PLACE, so they are reported as the
    // same thing: the transaction may or may not have been broadcast, and there is no id to poll or
    // look up. Anything that reads as "it failed" here invites paying the same money twice, which is
    // exactly why `TransactionHashMissing` exists — see that class. `received` names the real cause
    // so a log and a support conversation can still tell the two apart.
    if (e instanceof WalletRequestTimeout) {
      throw new TransactionHashMissing(`no answer within ${e.timeoutMs} ms`, 'no-answer');
    }
    throw e;
  }
  if (typeof hash !== 'string' || hash.length === 0) {
    // `JSON.stringify` is what names the value usefully (`""`, `null`, `{}`) but returns the VALUE
    // undefined for undefined, so that one case is spelled out rather than rendered.
    throw new TransactionHashMissing(hash === undefined ? 'undefined' : JSON.stringify(hash), 'answered-without-id');
  }
  return hash;
}
