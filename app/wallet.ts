/**
 * wallet — the EIP-1193 (window.ethereum) seam for the ckERC-20 direct onramp.
 *
 * The onramp is NON-CUSTODIAL: dpay never sees the user's Ethereum key. The user connects their own
 * wallet (MetaMask/Rabby/etc. via `window.ethereum` on web; WalletConnect on Android is a follow-up),
 * dpay BUILDS the two transactions' calldata (see `cketh.ts`), and the user's wallet SIGNS + broadcasts.
 * This module is the thin transport over the injected EIP-1193 provider — it does no key handling.
 *
 * Web/browser-wallet first (matches the e2e harness, which injects a mock provider). On native, or when
 * no wallet is injected, `getEthereumProvider()` returns null and the UI offers the manual path.
 *
 * The mock-provider contract (unit test + e2e harness both use it): an object with a `request({method,
 * params}) -> Promise<unknown>` method, identical to the real EIP-1193 surface. The e2e mock records the
 * `eth_sendTransaction` params so a flow can assert the calldata is byte-exact vs the `cketh.ts` goldens
 * — proving the onramp wiring is correct offline, with zero real ETH movement.
 */

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
    super(`transaction ${hash} reverted on chain`);
  }
}
/** The transaction was not mined within the timeout — it may still land. Soft (keep watching). */
export class ReceiptTimeout extends Error {
  override readonly name = 'ReceiptTimeout';
  constructor(public readonly hash: string) {
    super(`transaction ${hash} was not mined within the timeout`);
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
