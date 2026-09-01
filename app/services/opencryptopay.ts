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
// The provider's payload shape is decided in exactly ONE place — the pure half
// (`lib/opencryptopay.ts`), whose `parsePaymentDetails` this module calls directly. Nothing here
// re-derives a field from a provider body.
//
// HTTP goes through the app's one fetch wrapper (`fetchWithTimeout`, `services/relay.ts`). Bodies
// are read with the local `readJson` rather than relay.ts's `readJsonOrEmpty`, because that helper
// answers `{}` on a parse failure — a default this module must never take: an unreadable body is a
// state the caller has to see, not one to paper over.
import {
  claimedMerchantNameOf,
  offerNamesAsset,
  parseIcpUri,
  parsePaymentDetails,
  parseSolanaUri,
  selectPayableOffers,
  type OcpDetails,
  type OcpOffer,
  type OcpOfferRefusal,
} from '../lib/opencryptopay';
import {parseDecimalToUnits} from '../lib/amount';
import {ledgerToCurrency, type CurrencyDescriptor} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {isValidSolanaAddress} from '../solana/identity';
import type {AssetId} from '../lib/types';
import {DpayCore} from './native';
import {fetchWithTimeout} from './relay';
import {M} from '../i18n';

/** The two fields every post-quote provider call needs — the live quote and the URL it is served
 *  from. Narrower than `OcpDetails` (which it is structurally satisfied by) so the submission path
 *  demands the least authority it can: `submitProof` has no business reading a merchant name. */
export type OcpQuoteRef = {
  /** `quote.id` — names the live 300-second quote on every subsequent call. */
  readonly quoteId: string;
  /** `callback` — the step-3 transfer-details URL. Its `/cb/` segment becomes `/tx/` to submit. */
  readonly callbackUrl: string;
};

export type OcpDetailsResult =
  | {kind: 'ok'; details: OcpDetails}
  | {kind: 'no-pending'; claimedMerchantName: string | null}
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
 *  The provider returns TWO different 404s and the user needs different instructions for each:
 *   - the payment-link payload with no charge on it — the till simply has not rung anything up yet,
 *     so the honest screen names the merchant and says to ask them to start the payment;
 *   - `{"statusCode":404,"message":"Payment link not found",…}` — the code is stale or not this
 *     provider's, which is an error, not something waiting to happen.
 *  They are told apart by whether the body is the payment-link payload. */
export async function fetchPaymentDetails(apiUrl: string): Promise<OcpDetailsResult> {
  const target = httpsUrl(apiUrl);
  if (!target.ok) return {kind: 'error', message: target.reason};
  target.url.searchParams.set('timeout', '0');

  let r: Response;
  try {
    r = await fetchWithTimeout(target.url.toString(), undefined, OCP_READ_TIMEOUT_MS);
  } catch (e) {
    // NEVER REACHED the provider: nothing was quoted and nothing was paid, so the copy is the
    // localized "check your connection" instruction rather than a transport string the user cannot
    // act on. Every other error below quotes the provider's OWN answer, which is the useful part.
    console.warn(`opencryptopay: ${target.url.host} unreachable: ${errText(e)}`);
    return {kind: 'error', message: M.pay.ocp.providerUnreachable};
  }

  const body = await readJson(r);
  if (r.status === 404 && body.ok && isPaymentLinkBody(body.json)) {
    return {kind: 'no-pending', claimedMerchantName: claimedMerchantNameOf(body.json)};
  }
  if (!r.ok) return {kind: 'error', message: failureMessage(target.url.host, r.status, body)};
  if (!body.ok) return {kind: 'error', message: `${target.url.host} answered with an unreadable body. Scan again.`};

  const parsed = parsePaymentDetails(body.json);
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
  details: OcpQuoteRef,
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
    // Same as step 2: unreachable, before any money moves.
    console.warn(`opencryptopay: ${target.url.host} unreachable: ${errText(e)}`);
    return {kind: 'error', message: M.pay.ocp.providerUnreachable};
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
  details: OcpQuoteRef,
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

// --- the whole payment, in the ONE order that is safe -------------------------------------------
// Everything above is a single provider call. The two functions below are the sequence those calls
// have to happen in, kept here — in one place, shared by both rails — because the ORDER is the
// money-critical part (findings doc, "The loss path"): the payer moves irreversible funds before
// the provider is told, and gets exactly one chance to tell it.
//
//   resolveOcpScan  — everything BEFORE the payer approves: quote, choice of asset, destination.
//                     Two network reads, no signature, no funds. Ends with a target the review
//                     screen can render or a message it can show; never a half-answer.
//   payAndReport    — everything AFTER: move the funds on the caller's rail, and ONLY on a
//                     confirmed transfer with a real reference, report it ONCE.
//
// The rail seam is `send`: the caller supplies "move the money and tell me the reference". That is
// the only per-rail part, so the IC and Solana paths cannot drift into two different orders.

/** A payable OpenCryptoPay quote, resolved down to the exact transfer this wallet would sign. */
export type OcpTarget = {
  details: OcpDetails;
  /** The provider host the quote came from. The review MUST show it: an LNURL names any host. */
  host: string;
  /** The provider's own spelling of the settlement method + asset — echoed back verbatim on the
   *  transfer-details and submission calls, so they are carried, never re-derived. */
  method: string;
  asset: string;
  /** The wallet asset that pays it — the user's SELECTED asset, never a substitution. */
  assetId: AssetId;
  /** The destination account, as validated by the rail's own validator (canonical spelling). */
  to: string;
  /** The exact amount in the asset's raw units, converted once at its own precision. */
  rawAmount: string;
  /** The earlier of the quote's expiry and the transfer instruction's, in epoch ms. Approving
   *  after it would burn the quote AFTER the funds moved, which is the worst outcome there is. */
  expiresAt: number;
};

export type OcpResolveResult =
  | {kind: 'ok'; target: OcpTarget}
  /** Nothing was paid and nothing can be, for a reason the user can act on. */
  | {kind: 'refused'; message: string};

/**
 * Resolve a scanned till code into the exact payment this wallet would make — or into the reason it
 * cannot make one. Reads only: no signature is produced and no funds move here.
 *
 * The SELECTED asset decides what is paid (spec: `docs/specs/2026-09-01-opencryptopay-implementation.md`
 * "Unit C"). dpay never swaps, so an asset the till does not take is refused with the list of the
 * ones it does — the user switches in Balances and scans again.
 *
 * The provider's transfer instruction is then checked against what we asked for, because the URI is
 * the one place a hostile or broken provider could redirect the payment: the LEDGER must be the
 * selected asset's own ledger (`ledgerToCurrency`), the destination must pass the same core
 * validator every other destination in the app passes, and the amount must be the quoted amount to
 * the raw unit. Any disagreement is refused loudly — never reconciled.
 */
export async function resolveOcpScan(
  scan: {apiUrl: string; host: string},
  ctx: {selected: SelectableAsset; assets: SelectableAsset[]; catalog: CurrencyDescriptor[]; nowMs: number},
): Promise<OcpResolveResult> {
  const found = await fetchPaymentDetails(scan.apiUrl);
  if (found.kind === 'error') return {kind: 'refused', message: found.message};
  if (found.kind === 'no-pending') {
    return {kind: 'refused', message: M.pay.ocp.noPendingCharge(found.claimedMerchantName ?? scan.host)};
  }
  const details = found.details;

  const {payable, refused} = selectPayableOffers(details, ctx.assets, ctx.nowMs);
  const offer = payable.find(o => o.assetId === ctx.selected.id) ?? null;
  if (offer === null) return {kind: 'refused', message: unpayableMessage(details, ctx, payable, refused)};

  const uri = await fetchTransferUri(details, offer.method, offer.asset);
  if (uri.kind === 'error') return {kind: 'refused', message: uri.message};

  const dest = await destinationOf(uri.uri, ctx.selected, ctx.catalog);
  if (dest === null || dest.rawAmount !== offer.rawAmount) {
    console.warn(
      `opencryptopay: ${scan.host} answered ${offer.method}/${offer.asset} with an unusable instruction`
      + ` (uri=${uri.uri}, expected ${offer.rawAmount} raw on ${ctx.selected.id})`,
    );
    return {kind: 'refused', message: M.pay.ocp.badDestination(scan.host)};
  }

  return {
    kind: 'ok',
    target: {
      details,
      host: scan.host,
      method: offer.method,
      asset: offer.asset,
      assetId: ctx.selected.id,
      to: dest.to,
      rawAmount: dest.rawAmount,
      // The EARLIER of the two deadlines the provider stated. They are separate numbers from
      // separate calls, and signing against the later one would let a payment go out on a quote
      // that has already lapsed.
      expiresAt: Math.min(details.quoteExpiresAt, uri.expiresAt),
    },
  };
}

/** Why the selected asset cannot pay this till, in the order the reasons matter to the user. Every
 *  branch names what to do next (founder rule 2026-08-29); none of them silently drops an asset. */
function unpayableMessage(
  details: OcpDetails,
  ctx: {selected: SelectableAsset; assets: SelectableAsset[]; nowMs: number},
  payable: OcpOffer[],
  refused: OcpOfferRefusal[],
): string {
  // An expired quote refuses everything, so it is the whole story — say that, not "wrong asset".
  if (ctx.nowMs >= details.quoteExpiresAt) return M.pay.ocp.quoteExpired;
  // The one asset this wallet CARRIES and the till TAKES but dpay will not pay: USDC on Solana,
  // whose destination account is ambiguous in the provider's own URI.
  if (ctx.selected.id === 'solana:USDC' && refused.some(r => r.reason === 'solana-usdc-unsupported')) {
    return M.pay.ocp.solanaUsdcUnsupported;
  }
  // The till DOES take the selected asset, but the provider says it cannot settle that method right
  // now. Matched against the selected asset, never "some method was unavailable": the live provider
  // marks methods this wallet has no rail for unavailable on every response, so an unmatched check
  // would tell a payer their asset was blocked when the till simply never offered it.
  if (refused.some(r => r.reason === 'method-unavailable' && offerNamesAsset(r, ctx.selected))) {
    return M.pay.ocp.methodUnavailable(
      ctx.selected.symbol,
      payable.length > 0 ? walletAssetList(payable, ctx.assets) : null,
    );
  }
  if (payable.length === 0) return M.pay.ocp.noPayableAsset(offeredAssetList(details));
  return M.pay.ocp.assetNotAccepted(ctx.selected.symbol, walletAssetList(payable, ctx.assets));
}

/** The till's own asset spelling, deduped, for the case where the wallet can pay none of them. */
function offeredAssetList(details: OcpDetails): string {
  const names: string[] = [];
  for (const entry of details.transferAmounts) {
    for (const a of entry.assets) if (!names.includes(a.asset)) names.push(a.asset);
  }
  return names.join(', ');
}

/** The payable offers named as the WALLET names them (`SelectableAsset.symbol`), so "switch to one
 *  of those in Balances" points at rows the user can actually see. */
function walletAssetList(payable: OcpOffer[], assets: SelectableAsset[]): string {
  const names: string[] = [];
  for (const o of payable) {
    const name = assets.find(a => a.id === o.assetId)?.symbol ?? o.asset;
    if (!names.includes(name)) names.push(name);
  }
  return names.join(', ');
}

/** The provider's transfer instruction, parsed for the selected asset's rail and checked against
 *  it. Null on ANY disagreement — the caller refuses; there is no partial answer worth keeping. */
async function destinationOf(
  uri: string,
  selected: SelectableAsset,
  catalog: CurrencyDescriptor[],
): Promise<{to: string; rawAmount: string} | null> {
  if (selected.protocol === 'ic') {
    const parsed = parseIcpUri(uri);
    if (!parsed.ok) return null;
    // The URI names the ledger it wants paid. It must be the SELECTED asset's own ledger: paying a
    // different one would be paying a different asset, which dpay never does.
    if (ledgerToCurrency(catalog, parsed.ledger) !== selected.currency) return null;
    const raw = parseDecimalToUnits(parsed.amount, selected.decimals);
    if (!raw.ok) return null;
    try {
      // The same base32-CRC validator every other IC destination goes through. The strict PRINCIPAL
      // form on purpose: the transfer this app signs addresses an owner with the default
      // subaccount, so a `principal.subaccount` destination is refused rather than silently paid to
      // the owner's main account.
      return {to: await DpayCore.icpValidatePrincipal(parsed.to), rawAmount: raw.raw};
    } catch (e) {
      console.warn(`opencryptopay: destination principal rejected: ${errText(e)}`);
      return null;
    }
  }
  const parsed = parseSolanaUri(uri);
  if (!parsed.ok) return null;
  if (!isValidSolanaAddress(parsed.to)) return null;
  const raw = parseDecimalToUnits(parsed.amount, selected.decimals);
  return raw.ok ? {to: parsed.to, rawAmount: raw.raw} : null;
}

/** What the caller's rail did with the payer's money. Total: every path a rail can take maps to one
 *  of these, because the reporting decision below turns on nothing else. */
export type OcpSendResult =
  /** The transfer is confirmed on-chain. `txId` is what the provider verifies against the chain;
   *  `reference` is the same fact spelled for the user (`M.pay.ocp.ref`). */
  | {kind: 'settled'; txId: string; reference: string}
  /** Definitively did NOT happen — no funds left the wallet. Safe to explain and let the user retry. */
  | {kind: 'refused'; message: string}
  /** Indefinite. The money may or may not have moved, so the provider must NOT be told: the one
   *  submission we get would be spent on an identifier that may not exist. */
  | {kind: 'unknown'};

export type OcpPayResult =
  | {kind: 'paid'}
  /** Nothing moved. The user can act on it and try again. */
  | {kind: 'not-paid'; message: string}
  /** The money moved (or may have) and the sale is not credited. NEVER render as paid or as failed,
   *  and never offer a retry — the quote and the transaction id are both spent. */
  | {kind: 'unresolved'; message: string};

/**
 * Move the funds, then report them — in that order, once.
 *
 * The order is not a style choice (findings doc, "The loss path"): the provider verifies the
 * transaction against the chain, a failed submission burns BOTH the quote and the transaction id,
 * and there is no chargeback. So the proof is only ever reported for a transfer that is already
 * confirmed with a real reference, and any doubt about the transfer stops the sequence here —
 * spending the one submission on an identifier that may not exist is strictly worse than not
 * spending it, because it also destroys the user's ability to claim the payment later.
 *
 * NO CALLER MAY RETRY THIS. Not the submission, not the whole function.
 */
export async function payAndReport(
  quote: OcpQuoteRef,
  method: string,
  asset: string,
  send: () => Promise<OcpSendResult>,
): Promise<OcpPayResult> {
  const sent = await send();
  if (sent.kind === 'refused') return {kind: 'not-paid', message: sent.message};
  // Neither paid nor failed, and the provider stays untold — see above.
  if (sent.kind === 'unknown') return {kind: 'unresolved', message: M.pay.ocp.transferUnknown};

  const reported = await submitProof(quote, method, asset, sent.txId);
  if (reported.kind === 'accepted') return {kind: 'paid'};
  // The provider's own sentence is diagnostic, not instruction: the user needs to know the money is
  // gone and which reference proves it, which is what the copy says.
  console.warn(`opencryptopay: submission ${reported.kind} for tx ${sent.txId}: ${reported.message}`);
  return {
    kind: 'unresolved',
    message: reported.kind === 'rejected'
      ? M.pay.ocp.submitRejected(sent.reference)
      : M.pay.ocp.submitUnknown(sent.reference),
  };
}
