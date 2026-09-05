import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { utf8ToBytes } from '../lib/base64url';
import { isValidSolanaAddress } from './identity';

const RE_DECIMAL_AMOUNT = /^\d+(\.\d+)?$/;
const RE_ZERO_AMOUNT = /^0*\.?0*$/;

/** The UTF-8 byte cap on a scanned `memo` param. The memo rides the transfer as an SPL Memo
 *  instruction and a legacy Solana transaction tops out at 1232 bytes, so an unbounded memo is a
 *  broadcast failure the payer can only see as an opaque RPC error. Refusing at the scan — where
 *  "ask the merchant for a fresh code" is still actionable — is the honest place for this bound. */
const MEMO_MAX_BYTES = 64;

/** Why a scanned `solana:` URI is not payable. CODES, not sentences: the four-locale copy lives in
 *  `M.pay.spay.*` next to the surface that renders it (the opencryptopay.ts discipline), so the
 *  refusal can name the broken part and the way out without this pure module knowing any words. */
export type SolanaPayRefusal =
  | 'malformed-uri'
  | 'bad-recipient'
  | 'bad-amount'
  | 'bad-spl-token'
  | 'bad-reference'
  | 'unexpected-parameter'
  | 'memo-too-long';

/** A parsed Solana Pay request — the payer's half of the spec this wallet's own receive QR
 *  (SolanaReceiveSheet) emits. `amount`/`splToken`/`label`/`message`/`memo` are null when the URI
 *  did not carry them (all are optional per spec; a bare `solana:<recipient>` is a valid transfer
 *  request). The text params are kept VERBATIM here — sanitising display text is the renderer's
 *  job (`sanitiseDisplayText`, same as a wire request's name/memo), and the on-chain memo must keep
 *  the bytes the merchant wrote. */
export type SolanaPayRequest = {
  recipient: string;
  amount: string | null;
  splToken: string | null;
  references: string[];
  label: string | null;
  message: string | null;
  memo: string | null;
};

export type SolanaPayScan =
  | {ok: true; request: SolanaPayRequest}
  | {ok: false; reason: SolanaPayRefusal; param?: string};

/** Percent-decode one URI component, refusing (not throwing) on a broken escape — a stranger's QR
 *  must never crash the scanner, and "%E0%A4%A" is a damaged code, not an exception. */
function decodePart(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The UTF-8 byte length of `s` — the unit the SPL Memo instruction and the 1232-byte transaction
 *  limit actually count, which a string's `.length` (UTF-16 code units) is not. Via the shared
 *  hand-rolled encoder (`lib/base64url.ts`): no TextEncoder dependency on Hermes. */
function utf8ByteLength(s: string): number {
  return utf8ToBytes(s).length;
}

/**
 * Parse a scanned Solana Pay URI (`solana:<recipient>?amount=&spl-token=&reference=&label=&message=&memo=`)
 * into a payable request or a named refusal. Hand-rolled, no `URL`: `solana:` is not a special
 * scheme and Hermes has no URL polyfill behind it (the deepLink.ts/opencryptopay.ts precedent), and
 * a QR encoder uppercases freely so the scheme match is case-insensitive.
 *
 * What is refused, and why each has its own name (the payer can act on the difference):
 *   • `malformed-uri` — no recipient, a recipient containing `/` or `:` (the `solana:https://…`
 *     transaction-REQUEST form is a different flow this payer cannot serve), a broken %-escape, a
 *     param with no `=`, or a non-`reference` param given twice.
 *   • `bad-recipient`/`bad-spl-token`/`bad-reference` — the pubkey-shaped params must decode to
 *     exactly 32 bytes (`isValidSolanaAddress`, the same validator the emit half uses).
 *   • `bad-amount` — the spec's plain decimal only (no `1e-9`, `.5`, `1.`, negatives) and it must
 *     be greater than zero: a zero transfer has nothing to pay.
 *   • `unexpected-parameter` — anything outside the spec's six params; paying a code with
 *     unrecognised meaning in it would sign semantics this wallet cannot review.
 *   • `memo-too-long` — the memo rides an on-chain instruction inside a size-capped transaction.
 *
 * Pure, total, never throws. `reference` may legally appear more than once (the spec's "one or
 * more"); every other param is single-valued.
 */
export function parseSolanaPayUri(raw: string): SolanaPayScan {
  const t = raw.trim();
  if (!t.toLowerCase().startsWith('solana:')) return {ok: false, reason: 'malformed-uri'};
  const body = t.slice('solana:'.length);
  const qm = body.indexOf('?');
  const recipientPart = qm === -1 ? body : body.slice(0, qm);
  const query = qm === -1 ? '' : body.slice(qm + 1);
  if (recipientPart.length === 0 || recipientPart.includes('/') || recipientPart.includes(':')) {
    return {ok: false, reason: 'malformed-uri'};
  }
  const decodedRecipient = decodePart(recipientPart);
  if (decodedRecipient === null || !isValidSolanaAddress(decodedRecipient)) {
    return {ok: false, reason: 'bad-recipient'};
  }

  const request: SolanaPayRequest = {
    recipient: decodedRecipient,
    amount: null,
    splToken: null,
    references: [],
    label: null,
    message: null,
    memo: null,
  };
  const seen = new Set<string>();
  if (query.length > 0) {
    for (const piece of query.split('&')) {
      if (piece.length === 0) return {ok: false, reason: 'malformed-uri'};
      const eq = piece.indexOf('=');
      if (eq <= 0) return {ok: false, reason: 'malformed-uri'};
      const key = decodePart(piece.slice(0, eq));
      const value = decodePart(piece.slice(eq + 1));
      if (key === null || value === null) return {ok: false, reason: 'malformed-uri'};
      if (key !== 'reference' && seen.has(key)) return {ok: false, reason: 'malformed-uri'};
      seen.add(key);
      switch (key) {
        case 'amount':
          if (value.length === 0 || !RE_DECIMAL_AMOUNT.test(value) || RE_ZERO_AMOUNT.test(value)) {
            return {ok: false, reason: 'bad-amount'};
          }
          request.amount = value;
          break;
        case 'spl-token':
          if (value.length === 0 || !isValidSolanaAddress(value)) return {ok: false, reason: 'bad-spl-token'};
          request.splToken = value;
          break;
        case 'reference':
          if (value.length === 0 || !isValidSolanaAddress(value)) return {ok: false, reason: 'bad-reference'};
          request.references.push(value);
          break;
        case 'label':
          request.label = value.length === 0 ? null : value;
          break;
        case 'message':
          request.message = value.length === 0 ? null : value;
          break;
        case 'memo':
          if (utf8ByteLength(value) > MEMO_MAX_BYTES) return {ok: false, reason: 'memo-too-long'};
          request.memo = value.length === 0 ? null : value;
          break;
        default:
          return {ok: false, reason: 'unexpected-parameter', param: key};
      }
    }
  }
  return {ok: true, request};
}

export function createSolanaPayReference(): string {
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);
  return bs58.encode(ed25519.getPublicKey(seed));
}

export function buildSolanaPayUri(
  recipient: string,
  opts: {amount?: string | null; splToken?: string | null; reference?: string | null} = {},
): string {
  if (!isValidSolanaAddress(recipient)) {
    throw new Error(`solana pay recipient is not a base58 pubkey: ${recipient}`);
  }
  if (opts.splToken != null && !isValidSolanaAddress(opts.splToken)) {
    throw new Error(`solana pay spl-token is not a base58 pubkey: ${opts.splToken}`);
  }
  if (opts.reference != null && !isValidSolanaAddress(opts.reference)) {
    throw new Error(`solana pay reference is not a base58 pubkey: ${opts.reference}`);
  }
  if (opts.amount != null && (typeof opts.amount !== 'string' || !RE_DECIMAL_AMOUNT.test(opts.amount))) {
    throw new Error(`solana pay amount must be a plain decimal string: ${opts.amount}`);
  }
  const params: string[] = [];
  if (opts.amount != null) params.push(`amount=${opts.amount}`);
  if (opts.splToken != null) params.push(`spl-token=${opts.splToken}`);
  if (opts.reference != null) params.push(`reference=${opts.reference}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return `solana:${recipient}${query}`;
}
