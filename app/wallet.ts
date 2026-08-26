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

import {Platform} from 'react-native';
import {WALLETCONNECT_PROJECT_ID} from './config/constants';
import {M} from './i18n';

/** The minimal EIP-1193 provider surface this module uses (a subset of the real injected wallet). */
export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
};

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
 * Same-device wallet pairing — open the OS wallet app for the current WC pairing URI. Mirrors
 * `pairOnrampWallet()`'s web-first / disabled gate + lazy dynamic import isolation boundary:
 * web / disabled → false (no dynamic import); native + configured → delegates to walletconnect.ts's
 * `openWalletApp`. The sheet calls this when the user taps "Open in wallet" alongside the pairing QR.
 */
export async function openWalletApp(uri: string): Promise<boolean> {
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return false;
  const {openWalletApp: open} = await import('./walletconnect');
  return open(uri);
}

/**
 * Connect: `eth_requestAccounts` → the first authorized account address (0x…). Throws if the user
 * rejects or no account is returned. (On real wallets this is the prompt the user explicitly approves.)
 */
export async function connectWallet(p: Eip1193Provider): Promise<string> {
  const accounts = (await p.request({ method: 'eth_requestAccounts', params: [] })) as unknown[];
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('no account returned by the wallet');
  }
  return String(accounts[0]);
}

/**
 * Get the wallet's current chain id via `eth_chainId`. The result is an EIP-1193 hex string
 * (`"0x1"` = Ethereum mainnet, `"0x89"` = Polygon); this parses it to a decimal number so the caller
 * can compare it to the catalog's per-currency `chain_id` and abort a connect on a wrong-network
 * wallet (MC8 U3). Throws on a malformed/non-hex result — the caller treats that as "cannot confirm
 * the network", which fails closed (no calldata is sent on an unconfirmed chain).
 */
export async function getChainId(p: Eip1193Provider): Promise<number> {
  const raw = await p.request({ method: 'eth_chainId', params: [] });
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(`wallet returned an invalid chain id: ${JSON.stringify(raw)}`);
  }
  return parseInt(raw, 16);
}

// MC8 U4 — typed receipt errors so the caller can distinguish a REVERT (hard fail: the tx will never
// credit) from a TIMEOUT (soft: the tx was broadcast but not mined yet — keep watching). These close
// the false-"watching" bug where a reverted approve/deposit lied as "will appear in ~20 min".
/** The transaction was mined but reverted (receipt status 0x0) — it will never credit. Hard fail. */
export class ReceiptReverted extends Error {
  override readonly name = 'ReceiptReverted';
  constructor(public readonly hash: string) {
    super(M.errors.ethWallet.receiptReverted(hash));
  }
}
/** The transaction was not mined within the timeout — it may still land. Soft (keep watching). */
export class ReceiptTimeout extends Error {
  override readonly name = 'ReceiptTimeout';
  constructor(public readonly hash: string) {
    super(M.errors.ethWallet.receiptTimeout(hash));
  }
}

/**
 * Poll `eth_getTransactionReceipt` until the transaction is mined or the timeout elapses (MC8 U4).
 * - mined `status === '0x1'` → `{status: 1, gasUsed?}` (success).
 * - mined `status === '0x0'` → throws `ReceiptReverted` (the caller surfaces an honest error + stays
 *   in the enter phase; never transitions to a false "watching").
 * - no receipt for the full timeout → throws `ReceiptTimeout` (the caller treats SOFT: keeps watching,
 *   since the tx was broadcast and may still land — Fork-2 resolution).
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
    const receipt = await p.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt != null && typeof receipt === 'object') {
      const r = receipt as { status?: string; gasUsed?: string };
      if (typeof r.status === 'string') {
        if (r.status === '0x1') return { status: 1, gasUsed: r.gasUsed };
        if (r.status === '0x0') throw new ReceiptReverted(hash);
        throw new Error(`unexpected receipt status for ${hash}: ${r.status}`);
      }
    }
    if (Date.now() >= deadline) throw new ReceiptTimeout(hash);
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
 */
export async function sendTransaction(
  p: Eip1193Provider,
  from: string,
  tx: { to: string; data: string; value?: bigint },
): Promise<string> {
  const params = [{ from, to: tx.to, data: tx.data, value: toHexValue(tx.value ?? 0n) }];
  const hash = await p.request({ method: 'eth_sendTransaction', params });
  if (typeof hash !== 'string' || hash.length === 0) {
    throw new Error('wallet did not return a transaction hash');
  }
  return hash;
}
