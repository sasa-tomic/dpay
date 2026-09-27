/**
 * Flow-batch-B local fixtures for the pay/withdraw ports — the small e2e-harness pieces that are
 * FIXTURES (not app seams) and therefore live with the flows that use them instead of the frozen
 * harness core:
 *   - parsePayLink: the `e2e/harness/paylink.mjs` twin (app/lib/deepLink.ts is the grammar's truth).
 *   - hex/b64url byte helpers: the `e2e/harness/wire.mjs` idiom.
 *   - signIcrc1Envelope: the SIGNING half of `relayClient.railTransfer` (no POST) — the harness-side
 *     payer of flows 08/21/29, byte-identical to what the app signs (the same wasm core).
 *   - openPayerScan: ReceiveMode's "Scan the payer's signed code" affordance has no testID in the
 *     e2e DOM walk; here the Pressable is found by its accessibilityLabel and pressed through the
 *     tree (the arming effect, not the label, is the verifier).
 *   - clickByA11yLabel: the `aria-label` click the e2e driver did via querySelector.
 */
import {act} from 'react-test-renderer';
import {assert, DpayCore, icpCatalog, type Mount} from '../harness/lib';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as unknown as Record<string, unknown>;

// --- the payment link (e2e/harness/paylink.mjs twin) ---------------------------------------------

export type PayLink = {
  recipient: string; asset: string; network: string; amount: string;
  label: string; memo: string; ref: string | null;
};

export function parsePayLink(url: string): PayLink | null {
  let u: URL;
  try {
    u = new URL(url, 'https://dpay.invalid');
  } catch {
    return null;
  }
  const match = u.pathname.match(/^\/wallet\/pay\/([^/?#]+)$/);
  if (!match) return null;
  return {
    recipient: decodeURIComponent(match[1]),
    asset: u.searchParams.get('asset') ?? '',
    network: u.searchParams.get('network') ?? '',
    amount: u.searchParams.get('amount') ?? '',
    label: u.searchParams.get('label') ?? '',
    memo: u.searchParams.get('memo') ?? '',
    ref: u.searchParams.get('ref'),
  };
}

// --- byte helpers (e2e/harness/wire.mjs idiom) ----------------------------------------------------

export function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The reader seam carries HEX (the Android radio form); the core's decoder eats base64url. */
export function hexToB64url(hex: string): string {
  return b64urlEncode(hexBytes(hex));
}

// --- harness-side IC signing (relayClient.railTransfer's sign half, without the POST) -------------

export async function signIcrc1Envelope(
  payerSecretHex: string,
  payeePubHex: string,
  amountMinor: bigint | number | string,
  opts: {memoHex?: string; currency?: number} = {},
): Promise<{envelopeHex: string; requestIdHex: string; ledger: string}> {
  const currency = opts.currency ?? 0;
  const desc = (await icpCatalog()).find((c) => c.currency === currency);
  if (!desc?.ledger) throw new Error(`signIcrc1Envelope: no ledger for currency ${currency}`);
  const payee = await DpayCore.icpPrincipalFromPubkey(payeePubHex);
  const argHex = await DpayCore.icpTransferArg(payee, '', '', String(amountMinor), desc.fee ?? '', opts.memoHex ?? '');
  const expiryNs = (BigInt(Date.now()) * 1_000_000n + 300_000n * 1_000_000n).toString();
  const signed = await DpayCore.icpSignUpdate(payerSecretHex, desc.ledger, 'icrc1_transfer', argHex, expiryNs);
  return {...signed, ledger: desc.ledger};
}

// --- tree affordances the e2e driver reached via the DOM ------------------------------------------

/** ReceiveMode's offline-payer confirm affordance ("Scan the payer's signed code") — a Pressable
 *  with no testID. The press is verified by its EFFECT (a QrScanner listener arms), not by text. */
export async function openPayerScan(m: Mount, timeoutMs = 6000): Promise<void> {
  const LABEL = "Scan the payer's signed code";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = m.tree.root.findAll(
      (n) => n.props && n.props.accessibilityLabel === LABEL && typeof n.props.onPress === 'function',
    );
    if (hits.length > 0) {
      const node = hits[0];
      act(() => { node.props.onPress(node.props.onPressParam); });
      break;
    }
    if (Date.now() > deadline) {
      throw new Error('[local] the payer-scan affordance is not on screen (ReceiveMode without an open request?)');
    }
    await sleep(25);
  }
  const armDeadline = Date.now() + timeoutMs;
  for (;;) {
    const f = g.__DPAY_TEST_SCAN_COUNT as (() => number) | undefined;
    if (typeof f === 'function' && f() > 0) return;
    if (Date.now() > armDeadline) {
      throw new Error('[local] the payer-QR scanner never armed after the affordance tap');
    }
    await sleep(25);
  }
}

/** Press the node carrying `accessibilityLabel` (the e2e `button[aria-label=…]` click twin). */
export async function clickByA11yLabel(m: Mount, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = m.tree.root.findAll(
      (n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
    );
    if (hits.length > 0) {
      const node = hits[0];
      act(() => { node.props.onPress(node.props.onPressParam); });
      return;
    }
    if (Date.now() > deadline) throw new Error(`[local] no pressable with accessibilityLabel "${label}"`);
    await sleep(25);
  }
}

/** The inject seam, typed once (the __DPAY_TEST_SCAN camera shim — throws when 0 listeners). */
export function scanSeam(): (v: string) => void {
  const seam = g.__DPAY_TEST_SCAN as ((v: string) => void) | undefined;
  assert(typeof seam === 'function', 'the __DPAY_TEST_SCAN camera seam is not installed');
  return seam;
}

/** The NFC/QR reader-request stash, polled (the shim writes it once the reader arms). */
export async function pollReaderRequestHex(timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hex = g.__DPAY_TEST_NFC_READER_REQUEST as string | undefined;
    if (typeof hex === 'string' && hex.length > 0) return hex;
    if (Date.now() > deadline) throw new Error('[local] the NFC reader never armed with the 132-byte wire request');
    await sleep(50);
  }
}

/** e2e assertEq twin (the harness assert helpers live in lib.ts; this one keeps fixture files
 *  dependency-light for the money-equality checks the ports lean on). */
export function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (String(actual) !== String(expected)) {
    throw new Error(`[assert] ${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
