// OpenCryptoPay provider client — the I/O half (Unit B of
// `docs/specs/2026-09-01-opencryptopay-implementation.md`). Measured provider behaviour lives in
// `docs/specs/2026-09-01-opencryptopay-findings.md` and is NOT restated here.
//
// THE ONE THING TO KNOW BEFORE TOUCHING THIS FILE: `submitProof` is one-shot. By the time it runs
// the payer has already moved irreversible funds, and the provider grants exactly one attempt — a
// failed submission burns BOTH the quote and the transaction id, so no retry can ever succeed and a
// second attempt only makes the money harder to attribute. Every indefinite answer is therefore
// `unknown` (honest pending — the same outcome vocabulary as `RailOutcome` in `services/rail.ts`),
// never a failure and never a success.
//
// Narrowing of the provider's step-2 payload is INJECTED, not imported, so the shape of a provider
// payload is decided in exactly one place — the pure half (`lib/opencryptopay.ts`). See the note on
// `fetchPaymentDetails`.
//
// HTTP goes through the app's one fetch wrapper (`fetchWithTimeout`, `services/relay.ts`). Bodies
// are read with the local `readJson` rather than relay.ts's `readJsonOrEmpty`, because that helper
// answers `{}` on a parse failure — a default this module must never take: an unreadable body is a
// state the caller has to see, not one to paper over.
import {fetchWithTimeout} from './relay';

/** The part of the provider's step-2 payload this module actually uses. Structural on purpose: the
 *  pure half's richer `OcpDetails` (paymentId, quoteExpiresAt, claimedMerchantName,
 *  transferAmounts…) satisfies it, and the generic on `fetchPaymentDetails` hands that richer type
 *  straight back to the caller instead of widening it to this minimum. */
export type OcpDetails = {
  /** `quote.id` — names the live 300-second quote on every subsequent call. */
  readonly quoteId: string;
  /** `callback` — the step-3 transfer-details URL. Its `/cb/` segment becomes `/tx/` to submit. */
  readonly callbackUrl: string;
};

/** The pure half's `parsePaymentDetails`, passed in. Injected rather than imported so this module
 *  owns I/O only and the payload shape has a single owner (DRY): Unit C wires the real parser,
 *  these tests wire a stub, and neither duplicates the narrowing. */
export type OcpParseDetails<D extends OcpDetails> = (
  json: unknown,
) => {ok: true; details: D} | {ok: false; reason: string};

export type OcpDetailsResult<D extends OcpDetails> =
  | {kind: 'ok'; details: D}
  | {kind: 'no-pending'; claimedMerchantName?: string}
  | {kind: 'error'; message: string};

export type OcpTransferUriResult =
  | {kind: 'ok'; uri: string; expiresAt: number}
  | {kind: 'error'; message: string};

export type OcpSubmitResult =
  | {kind: 'accepted'}
  /** A definitive provider refusal: HTTP 4xx carrying a readable body. */
  | {kind: 'rejected'; message: string}
  /** Timeout / transport / unreadable body — the transfer may well have happened. Honest pending. */
  | {kind: 'unknown'; message: string};

/** Read calls happen BEFORE any money moves, so a tight bound is safe: the user can just re-scan. */
export const OCP_READ_TIMEOUT_MS = 15000;
/** The submission happens AFTER the money moved and may not be repeated, so it gets a deliberately
 *  generous bound — the provider verifies the transaction against the chain before answering, and
 *  giving up early costs the user the payment. Still far inside the 300s quote lifetime. */
export const OCP_SUBMIT_TIMEOUT_MS = 30000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Read a provider body as JSON. Never throws, never substitutes a default — an unreadable body is
 *  reported as such so each caller can decide what it means (an error before payment, an honest
 *  `unknown` after it). */
async function readJson(r: Response): Promise<{ok: true; json: unknown} | {ok: false}> {
  try {
    return {ok: true, json: await r.json()};
  } catch (e) {
    console.warn(`opencryptopay: provider body was not JSON (HTTP ${r.status}): ${errText(e)}`);
    return {ok: false};
  }
}

/** The provider's error envelope is NestJS's `{statusCode, message, error}` — recorded live on
 *  2026-09-01 for every failing status this module can meet (400 "Invalid method or asset", 400
 *  "Transaction … already assigned to another quote", 404 "Payment link not found", 404 "No actual
 *  quote with ID … found"). Returns the human sentence, or null when the body carries none. */
function providerMessage(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const m = (json as {message?: unknown}).message;
  return typeof m === 'string' && m.length > 0 ? m : null;
}

/** Is this body the payment-link payload rather than the error envelope? The payload carries the
 *  LNURL `tag` and the merchant's `displayName`; the error envelope carries neither. This is what
 *  separates the provider's two DIFFERENT 404s — see `fetchPaymentDetails`. */
function isPaymentLinkBody(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const o = json as {tag?: unknown; displayName?: unknown};
  return o.tag === 'payRequest' || typeof o.displayName === 'string';
}

/** The merchant name the provider CLAIMS. Never verified — render it as claimed, exactly as a
 *  payment link's `label` is (`lib/deepLink.ts` module header is the authority for that posture). */
function claimedName(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const n = (json as {displayName?: unknown}).displayName;
  return typeof n === 'string' && n.length > 0 ? n : undefined;
}

/** Parse a provider URL and refuse anything that is not https. A scanned LNURL names an arbitrary
 *  host and the step-2 body names its own callback, so both are attacker-controlled strings; the
 *  callback in particular is where a transaction id gets reported, and reporting it over cleartext
 *  is a downgrade a wallet must not perform. Enforced here, at this module's own network boundary,
 *  because this is the last point before the request leaves the device. */
function httpsUrl(raw: string): {ok: true; url: URL} | {ok: false; reason: string} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {ok: false, reason: `Not a usable provider address: ${raw}. Re-scan the merchant's code.`};
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `Refused a ${url.protocol}// provider address (${url.host}). OpenCryptoPay must be https — re-scan the merchant's code.`,
    };
  }
  return {ok: true, url};
}

/** Describe a non-OK response for the user: the provider's own sentence when it gave one, otherwise
 *  the status and the host that produced it. Never a bare "something went wrong". */
function failureMessage(host: string, status: number, body: {ok: true; json: unknown} | {ok: false}): string {
  if (!body.ok) return `${host} answered HTTP ${status} with an unreadable body.`;
  return providerMessage(body.json) ?? `${host} answered HTTP ${status} without giving a reason.`;
}

/** Step 2 — the live quote and what the till is charging. `timeout=0` asks for the current charge
 *  instead of long-polling for one.
 *
 *  `parse` is the pure half's `parsePaymentDetails`; its `D` flows through untouched so the caller
 *  keeps every field it narrowed, not just the two this module reads.
 *
 *  The provider returns TWO different 404s and the user needs different instructions for each:
 *   - the payment-link payload with no charge on it — the till simply has not rung anything up yet,
 *     so the honest screen names the merchant and says to ask them to start the payment;
 *   - `{"statusCode":404,"message":"Payment link not found",…}` — the code is stale or not this
 *     provider's, which is an error, not something waiting to happen.
 *  They are told apart by whether the body is the payment-link payload. */
export async function fetchPaymentDetails<D extends OcpDetails>(
  apiUrl: string,
  parse: OcpParseDetails<D>,
): Promise<OcpDetailsResult<D>> {
  const target = httpsUrl(apiUrl);
  if (!target.ok) return {kind: 'error', message: target.reason};
  target.url.searchParams.set('timeout', '0');

  let r: Response;
  try {
    r = await fetchWithTimeout(target.url.toString(), undefined, OCP_READ_TIMEOUT_MS);
  } catch (e) {
    return {kind: 'error', message: `Couldn't reach ${target.url.host}: ${errText(e)}. Check your connection and scan again.`};
  }

  const body = await readJson(r);
  if (r.status === 404 && body.ok && isPaymentLinkBody(body.json)) {
    return {kind: 'no-pending', claimedMerchantName: claimedName(body.json)};
  }
  if (!r.ok) return {kind: 'error', message: failureMessage(target.url.host, r.status, body)};
  if (!body.ok) return {kind: 'error', message: `${target.url.host} answered with an unreadable body. Scan again.`};

  const parsed = parse(body.json);
  if (!parsed.ok) return {kind: 'error', message: parsed.reason};
  return {kind: 'ok', details: parsed.details};
}

/** Step 3 — the destination for one chosen `{method, asset}`. Still before any money moves, so a
 *  failure here is a plain error the user can retry by re-scanning.
 *
 *  The returned URI does NOT name the asset (a Solana USDC URI is byte-identical to a native SOL one
 *  apart from the amount), so the provider's `blockchain` echo is the only integrity signal the
 *  answer carries. A mismatch against the method we asked for means we would be paying on a chain we
 *  did not choose, and is refused rather than reconciled. The URI itself is parsed by the pure half
 *  (`parseIcpUri` / `parseSolanaUri`), not here. */
export async function fetchTransferUri(
  details: OcpDetails,
  method: string,
  asset: string,
): Promise<OcpTransferUriResult> {
  const target = httpsUrl(details.callbackUrl);
  if (!target.ok) return {kind: 'error', message: target.reason};
  target.url.searchParams.set('quote', details.quoteId);
  target.url.searchParams.set('method', method);
  target.url.searchParams.set('asset', asset);

  let r: Response;
  try {
    r = await fetchWithTimeout(target.url.toString(), undefined, OCP_READ_TIMEOUT_MS);
  } catch (e) {
    return {kind: 'error', message: `Couldn't reach ${target.url.host}: ${errText(e)}. Check your connection and scan again.`};
  }

  const body = await readJson(r);
  if (!r.ok) return {kind: 'error', message: failureMessage(target.url.host, r.status, body)};
  if (!body.ok) return {kind: 'error', message: `${target.url.host} answered with an unreadable body. Scan again.`};

  const o = body.json as {uri?: unknown; expiryDate?: unknown; blockchain?: unknown};
  if (typeof o.blockchain !== 'string' || o.blockchain !== method) {
    return {
      kind: 'error',
      message: `${target.url.host} answered for ${String(o.blockchain)} when ${method} was requested. Refusing — don't pay this code.`,
    };
  }
  if (typeof o.uri !== 'string' || o.uri.length === 0) {
    return {kind: 'error', message: `${target.url.host} gave no payment address for ${asset} on ${method}. Scan again.`};
  }
  if (typeof o.expiryDate !== 'string') {
    return {kind: 'error', message: `${target.url.host} gave no expiry for this quote. Scan again.`};
  }
  const expiresAt = Date.parse(o.expiryDate);
  if (!Number.isFinite(expiresAt)) {
    return {kind: 'error', message: `${target.url.host} gave an unreadable expiry (${o.expiryDate}). Scan again.`};
  }
  return {kind: 'ok', uri: o.uri, expiresAt};
}

/** Step 4 — report the on-chain proof. ONE-SHOT, and the only place in the app that calls `/tx`.
 *
 *  NO CALLER MAY WRAP THIS IN A RETRY, a loop, or a "try again" button. The payer's funds are gone
 *  before this runs, and the provider spends the attempt whether or not it succeeds: a failed
 *  submission burns the quote (a second call answers `404 No actual quote with ID … found`) AND
 *  records the transaction id against it (reusing that id under a fresh quote answers `400
 *  Transaction … already assigned to another quote`). A retry therefore cannot succeed, and each
 *  extra attempt only widens the window in which the user believes something is still being tried.
 *  Measured; see the findings doc's "The loss path".
 *
 *  Consequently the outcome mapping is deliberately asymmetric:
 *   - 2xx with a readable body → accepted.
 *   - 4xx with a readable body → rejected: a definitive refusal, whose sentence the user is shown
 *     alongside the block index so they can claim the payment with the merchant.
 *   - anything else — timeout, transport failure, 5xx, an unreadable body on ANY status → unknown.
 *  A 2xx whose body cannot be read is `unknown` rather than `accepted` on purpose: a false
 *  "unknown" costs the user a pending screen they can resolve with the merchant, while a false
 *  "paid" costs them the goods. The costs are not symmetric, so the doubt resolves to pending. */
export async function submitProof(
  details: OcpDetails,
  method: string,
  asset: string,
  txId: string,
): Promise<OcpSubmitResult> {
  const target = httpsUrl(details.callbackUrl);
  if (!target.ok) return {kind: 'unknown', message: `${target.reason} The transfer is on-chain — quote your transaction id (${txId}) to the merchant.`};

  // The submission URL is the callback with its `/cb/` segment replaced by `/tx/`. Built as a
  // string and re-parsed rather than mutated: `URL.pathname` is readonly under this project's TS
  // lib. An absent `/cb/` segment is refused loudly — silently posting the proof to the callback
  // itself would spend the one attempt on the wrong endpoint.
  const path = target.url.pathname;
  const at = path.lastIndexOf('/cb/');
  if (at < 0) {
    return {
      kind: 'unknown',
      message: `${target.url.host} gave a callback with no /cb/ segment (${path}), so the payment can't be reported. The transfer is on-chain — quote your transaction id (${txId}) to the merchant.`,
    };
  }
  const q = new URLSearchParams(target.url.search);
  q.set('quote', details.quoteId);
  q.set('method', method);
  q.set('asset', asset);
  q.set('tx', txId);
  const submitUrl = `${target.url.origin}${path.slice(0, at)}/tx/${path.slice(at + '/cb/'.length)}?${q.toString()}`;

  // EXACTLY ONE request. No loop, no retry, no second attempt on any outcome.
  let r: Response;
  try {
    r = await fetchWithTimeout(submitUrl, undefined, OCP_SUBMIT_TIMEOUT_MS);
  } catch (e) {
    return {
      kind: 'unknown',
      message: `Couldn't confirm with ${target.url.host} (${errText(e)}). Your transfer is on-chain — quote transaction ${txId} to the merchant. Don't send it again.`,
    };
  }

  const body = await readJson(r);
  if (!body.ok) {
    return {
      kind: 'unknown',
      message: `${target.url.host} answered HTTP ${r.status} with an unreadable body. Your transfer is on-chain — quote transaction ${txId} to the merchant. Don't send it again.`,
    };
  }
  if (r.status >= 400 && r.status < 500) {
    return {kind: 'rejected', message: providerMessage(body.json) ?? `${target.url.host} refused the payment with HTTP ${r.status} and gave no reason.`};
  }
  if (!r.ok) {
    return {
      kind: 'unknown',
      message: `${target.url.host} answered HTTP ${r.status}. Your transfer is on-chain — quote transaction ${txId} to the merchant. Don't send it again.`,
    };
  }
  return {kind: 'accepted'};
}
