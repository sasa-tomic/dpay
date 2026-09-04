import {parseDecimalToUnits} from './amount';
import {bytesToUtf8} from './base64url';
import {clampLinkText, sanitiseDisplayText, RE_REF} from './deepLink';
import type {AssetId} from './types';
import {tokenEq, type SelectableAsset} from '../config/assets';
import {ICP_LEDGER_PRINCIPAL} from '../config/constants';

// --- OpenCryptoPay: the pure half (scanned code → a typed fact, or a NAMED refusal) ---------------
// Paying a merchant till that shows a static OpenCryptoPay QR. Measured provider behaviour is
// `docs/specs/2026-09-01-opencryptopay-findings.md`; the plan this implements is
// `docs/specs/2026-09-01-opencryptopay-implementation.md` ("Unit A"). Neither is restated here.
//
// EVERY string this module reads was supplied by a party the wallet has no relationship with: the
// QR came off a sticker, and the host it names came out of that QR. So the module's whole job is to
// turn provider text into either an exact fact or a refusal the screen can act on — it never
// throws, never guesses, and never coerces. Two rules follow from that and explain most of the code:
//
//   1. A REFUSAL IS A CODE, NOT A SENTENCE. Same discipline as `PayLinkErr` in `lib/deepLink.ts`:
//      the UI owns the copy (`app/i18n`), this module owns the distinctions. Every reason below
//      maps to its own on-screen instruction (founder rule 2026-08-29) — which is why "damaged
//      code" and "not our code" are different reasons, and why an unpayable asset is refused BY
//      NAME instead of being dropped from the list.
//   2. MONEY IS A DECIMAL STRING, NEVER A `number`. Provider amounts are carried verbatim as text
//      and converted exactly once, by `parseDecimalToUnits` at the ASSET's own decimals
//      (`selectPayableOffers`). The one place a JSON `number` is unavoidable — the step-2 body —
//      is normalised to a plain decimal string immediately, exponent notation expanded, so a
//      16-sat amount can never reach the ledger as `1.6e-7`.
//
// SHAPE vs POLICY, the same two-stage split as `lib/destination.ts`: `parse*` answers "what does
// this string say", `selectPayableOffers` answers "which of it can this wallet pay, and why not the
// rest". Keeping them apart is what lets a provider add a method or an asset we have never heard of
// without the parse failing — an unknown method parses fine and is refused by the policy table.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO (each already has exactly one home):
//   • validate the destination account — the core does (`icpValidatePrincipal` /
//     `icpValidateIcrcAccount`), so a mistyped principal is refused by the same validator as
//     everywhere else;
//   • decide payability of a dpay asset — `isPayableAsset` (`config/catalog.ts`) does, on the
//     catalog, before signing;
//   • define when an outside party's token spelling names a wallet asset — `tokenEq`
//     (`config/assets.ts`) does, beside the `linkToken` field it compares;
//   • any I/O — the three provider calls are Unit B (`services/opencryptopay.ts`), and the `/tx`
//     submission there is ONE-SHOT (see the findings doc's loss path).

/** Why an OpenCryptoPay string cannot be used. Machine-readable codes — the UI maps each to its own
 *  instruction. Grouped by the stage that can produce it; every function's result type narrows to
 *  the ones it can actually return, so callers stay exhaustive without dead branches. */
export type OcpRefusal =
  // — the scanned code —
  /** No LNURL in the string at all: a different kind of QR, not a damaged one. */
  | 'not-lnurl'
  /** It IS an `lnurl1…` string but cannot be decoded: bad charset, mixed case, or truncated. */
  | 'malformed-lnurl'
  /** Decodable, but the bech32 checksum does not verify — a damaged code that must never be
   *  allowed to resolve to whatever host the damage happens to spell. */
  | 'bad-checksum'
  /** The LNURL decoded to something that is not a URL. */
  | 'not-a-url'
  /** A URL, but not `https` — refused loudly, never downgraded. */
  | 'not-https'
  // — a destination URI the provider returned —
  /** The URI is not the scheme this parser owns. */
  | 'wrong-scheme'
  /** Right scheme, wrong shape (missing query, unexpected path, repeated parameter). */
  | 'malformed-uri'
  /** The URI carries a query parameter this parser does not know. Its OWN reason, and a REFUSAL
   *  rather than something to ignore: a parameter the wallet drops is an instruction the provider
   *  gave and the payer never saw. `…?to=<principal>&subaccount=abcd` is the case that costs money
   *  — ignoring `subaccount` pays the owner's DEFAULT account, i.e. a different account than the
   *  one the URI named, which is exactly the silent redirect this module refuses everywhere else. */
  | 'unexpected-parameter'
  /** The URI carries a `ref` that is not the 32-hex reconciliation memo. Its own reason rather than
   *  `malformed-uri`, because the fault is precise and the console line is the only place the
   *  distinction survives: a provider that names a reference this wallet cannot put in a memo would
   *  have its sale go uncredited, so the payment is refused before any money moves. */
  | 'bad-ref'
  /** The amount is missing or is not a decimal number. Never coerced to 0. */
  | 'bad-amount'
  /** A Solana URI naming an SPL token. The Solana leg ships native SOL only, so a token URI is
   *  refused rather than paid as if it were SOL (findings: the provider omits `spl-token` even for
   *  USDC, so a URI that carries one is a contradiction we must not resolve ourselves). */
  | 'spl-token-unsupported'
  // — the provider's payment details —
  /** The step-2 body is missing or malforms a field the payment depends on. */
  | 'malformed-details'
  /** The `callback` is well-formed https but carries no `/cb/` segment, so no submission URL can be
   *  derived from it — this provider cannot be TOLD about a payment. Its own fact, and refused
   *  BEFORE consent: discovering it after the transfer would mean irreversible funds moved with no
   *  request ever issued, which is the loss path at its worst. Also its own INSTRUCTION: rescanning
   *  yields the same callback, so "scan again" would be a dead end. */
  | 'unreportable-callback'
  // — which offer this wallet can pay —
  /** The provider named a settlement method this wallet has no rail for. */
  | 'unknown-method'
  /** The provider itself says it cannot settle this method right now (`transferAmounts[].available`
   *  is false — measured live on `TaprootAsset`, `Spark` and `Arkade`). Offering it anyway would
   *  push the failure to the destination call or beyond, i.e. after the payer chose it. */
  | 'method-unavailable'
  /** USDC on Solana, refused BY NAME. What the URI's address IS was settled by measurement on
   *  2026-09-02 — it is the merchant's OWNER wallet, not a token account
   *  (`docs/specs/2026-09-01-opencryptopay-findings.md`) — so the ambiguity this refusal was first
   *  written for is gone. What stands in its place: an SPL transfer must be sent to the associated
   *  token account derived from that owner and the USDC mint, so the account credited would not be
   *  the account the review showed and the provider named. This wallet derives ATAs for its own
   *  USDC sends (`app/solana/spl.ts`), so the leg is buildable — it is simply not built here, and
   *  paying a token URI as if it were native SOL is what refusing it prevents. */
  | 'solana-usdc-unsupported'
  /** The provider accepts this asset; this wallet does not carry it (VEUR, USDT). */
  | 'asset-not-in-wallet'
  /** Two wallet assets answer to the same token on the same chain — which one the provider meant is
   *  unknowable, so neither is paid. Mirrors `resolvePayLink`'s `ambiguous_asset`. */
  | 'ambiguous-asset'
  /** The quote is past its expiry — nothing is payable until the till is rescanned. */
  | 'quote-expired';

type Refused<R extends OcpRefusal> = {ok: false; reason: R};

export type LnurlDecode = {ok: true; url: string} | Refused<'not-lnurl' | 'malformed-lnurl' | 'bad-checksum'>;
export type OcpScan =
  | {ok: true; apiUrl: string; host: string}
  | Refused<'not-lnurl' | 'malformed-lnurl' | 'bad-checksum' | 'not-a-url' | 'not-https'>;
export type IcpUriParse =
  | {ok: true; ledger: string; to: string; amount: string; ref: string | null}
  | Refused<'wrong-scheme' | 'malformed-uri' | 'unexpected-parameter' | 'bad-amount' | 'bad-ref'>;
export type SolanaUriParse =
  | {ok: true; to: string; amount: string}
  | Refused<'wrong-scheme' | 'malformed-uri' | 'unexpected-parameter' | 'bad-amount' | 'spl-token-unsupported'>;
export type OcpDetailsParse =
  | {ok: true; details: OcpDetails}
  | Refused<'malformed-details' | 'not-https' | 'unreportable-callback'>;

/** One asset amount as the provider states it. `amount` is a decimal string in DISPLAY units —
 *  exactly what the provider sent, normalised only in spelling (never rounded, never a `number`). */
export interface OcpAssetAmount {
  asset: string;
  amount: string;
}

/** One settlement method the till accepts, with the exact amount per asset. `method` is carried
 *  VERBATIM because it goes back on the wire in steps 3 and 4. */
export interface OcpTransferAmount {
  method: string;
  /** Whether the PROVIDER says it can settle this method right now. A required boolean: a body that
   *  omits it is refused rather than read as `true`, because absence is not permission — the field
   *  is measured present on every live response, so a body without it is a shape this parser does
   *  not know, and guessing "available" would put an unpayable option in front of the payer. */
  available: boolean;
  assets: OcpAssetAmount[];
}

/** The provider's step-2 answer, narrowed. Provider-supplied display text is named `claimed*` so no
 *  consumer can mistake it for something dpay verified — the SAME treatment a payment link's
 *  `label` gets (`lib/deepLink.ts`). */
export interface OcpDetails {
  /** Where the proof of an irreversible transfer will be reported: `callbackUrl` with its `/cb/`
   *  segment swapped for `/tx/` (both forms are measured accepted; this one is derived from the
   *  provider's OWN path rather than assembled from a hard-coded `/v1/lnurlp/tx/` prefix, so a
   *  second OpenCryptoPay provider hosting the standard under a different layout still works).
   *
   *  DERIVED HERE, BEFORE CONSENT, ON PURPOSE. It is the one field whose absence cannot be
   *  discovered late: the payer moves irreversible funds before the provider is told, so a callback
   *  that yields no submission URL has to refuse the payment while nothing has moved. */
  submitUrl: string;
  /** The host `submitUrl` (and therefore the provider's `callback`) points at: where an irreversible
   *  transfer's proof gets reported, and where the destination address came from. Carried as its own
   *  field because a CONSUMER must be able to compare it against the host the code was scanned from
   *  without re-parsing a URL — the caller refuses a payment whose two hosts differ
   *  (`services/opencryptopay.ts`), which is what makes the single host the review shows honest. */
  proofHost: string;
  quoteId: string;
  /** Epoch ms. The quote lives 300s; a payment must be signed and submitted inside that window. */
  quoteExpiresAt: number;
  callbackUrl: string;
  /** The merchant name the PROVIDER claims. Null when it sent none — a missing name never blocks a
   *  payment (the review screen still shows the provider host and the full destination). */
  claimedMerchantName: string | null;
  /** What the till asked for in ITS OWN unit (e.g. CHF 1) — the merchant's price tag, and the only
   *  thing on the review a payer can check against the printed price: `0.0000162 BTC` means nothing
   *  on its own. It is the PROVIDER's number, shown as claimed and never as dpay's (dpay does not
   *  quote and does not convert), and it never moves: `transferAmounts` is what gets paid.
   *
   *  Null when absent or unreadable, exactly like `claimedMerchantName` and for the same reason —
   *  it is display context, and display context must never refuse a payment. (It used to: this was
   *  a hard refusal of the whole payment on a field nothing read.) */
  requestedAmount: OcpAssetAmount | null;
  transferAmounts: OcpTransferAmount[];
}

/** An offer this wallet can pay: the provider's own method/asset spelling (what steps 3+4 must echo
 *  back), the amount as sent, and the resolved wallet asset with the amount in exact raw units. */
export interface OcpOffer {
  method: string;
  asset: string;
  amount: string;
  assetId: AssetId;
  rawAmount: string;
}

/** An offer this wallet cannot pay, named. The UI renders every one of these — an asset that simply
 *  vanished from the list is a dead end, and a dead end is a bug (founder rule 2026-08-29). */
export interface OcpOfferRefusal {
  method: string;
  asset: string;
  reason: Extract<
    OcpRefusal,
    | 'unknown-method'
    | 'method-unavailable'
    | 'solana-usdc-unsupported'
    | 'asset-not-in-wallet'
    | 'ambiguous-asset'
    | 'bad-amount'
    | 'quote-expired'
  >;
}

// --- bech32 (BIP-173) ------------------------------------------------------------------------
// Hand-rolled: nothing in the app's dependency set decodes bech32, and this is ~40 lines. The
// CHECKSUM is the point — it does not stop a hostile sticker (nothing does; that is why the payer
// approves an explicit review showing the host), but it stops a scuffed or misread QR from
// resolving to a DIFFERENT host than the one printed on it.
//
// LUD-01 profile: hrp is exactly `lnurl`, and bech32's 90-character limit does NOT apply (the real
// example is 94 chars). A cap is still enforced, at the same 2000 chars `solana/qr.ts` bounds its
// URIs to, so a pathological QR cannot spin the polymod loop.
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const LNURL_HRP = 'lnurl';
const MAX_LNURL_LEN = 2000;
const BECH32_CHECKSUM_LEN = 6;

/** BIP-173 polymod over the hrp-expanded values + data. Stays inside 30 bits, so JS's signed
 *  bitwise ops are exact here. */
function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= BECH32_GENERATORS[i];
    }
  }
  return chk;
}

/** BIP-173 hrp expansion: high bits, separator, low bits. */
function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** BIP-173 5-bit → 8-bit regrouping. Null when the trailing padding is not the spec's "fewer than
 *  5 bits, all zero" — accepting sloppy padding would let two different codes decode to one URL. */
function bech32FromWords(words: number[]): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  return Uint8Array.from(out);
}

/**
 * Decode an LNURL (LUD-01) to the URL it carries, verifying the bech32 checksum.
 *
 * Damage is separated from foreignness on purpose: `not-lnurl` means "this QR is something else"
 * (the user should scan the right code), while `malformed-lnurl` / `bad-checksum` mean "this IS an
 * LNURL and it is broken" (the user should rescan or ask the merchant for a fresh code). Pure,
 * total, never throws.
 */
export function decodeLnurl(s: string): LnurlDecode {
  const raw = typeof s === 'string' ? s.trim() : '';
  const lower = raw.toLowerCase();
  // bech32 separates on the LAST '1', so the hrp is everything before it. Anything but `lnurl` is
  // simply not our code.
  const sep = lower.lastIndexOf('1');
  if (sep < 0 || lower.slice(0, sep) !== LNURL_HRP) return {ok: false, reason: 'not-lnurl'};
  if (raw.length > MAX_LNURL_LEN) return {ok: false, reason: 'malformed-lnurl'};
  // Mixed case is invalid bech32: the checksum is defined over one case only, so a mixed-case
  // string has no well-defined answer at all.
  if (raw !== lower && raw !== raw.toUpperCase()) return {ok: false, reason: 'malformed-lnurl'};
  const data = lower.slice(sep + 1);
  if (data.length < BECH32_CHECKSUM_LEN) return {ok: false, reason: 'malformed-lnurl'};
  const words: number[] = [];
  for (const ch of data) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) return {ok: false, reason: 'malformed-lnurl'};
    words.push(v);
  }
  if (bech32Polymod([...bech32HrpExpand(LNURL_HRP), ...words]) !== 1) return {ok: false, reason: 'bad-checksum'};
  const bytes = bech32FromWords(words.slice(0, -BECH32_CHECKSUM_LEN));
  if (bytes === null || bytes.length === 0) return {ok: false, reason: 'malformed-lnurl'};
  try {
    return {ok: true, url: bytesToUtf8(bytes)};
  } catch {
    // `bytesToUtf8` is strict RFC 3629 — non-text payload ⇒ this is not a usable LNURL.
    return {ok: false, reason: 'malformed-lnurl'};
  }
}

/**
 * Recognise an OpenCryptoPay code: a bare `LNURL1…` string, or any URL carrying it in a `lightning`
 * query parameter (the shape the till's QR actually prints,
 * `https://app.dfx.swiss/pl/?lightning=LNURL1…`).
 *
 * `apiUrl` is the decoded string VERBATIM — a provider URL is never rewritten, so what the wallet
 * calls is exactly what the code said. `host` is returned alongside because the review screen MUST
 * show which host the quote came from: an LNURL can name any host on earth, and "why does this say
 * api.evil.example" has to be answerable before the payer approves. It is `host`, not `hostname`,
 * so a non-default port is part of what the user sees.
 */
export function parseOcpScan(raw: string): OcpScan {
  const raw0 = typeof raw === 'string' ? raw.trim() : '';
  if (raw0.length === 0) return {ok: false, reason: 'not-lnurl'};
  // The `lightning:` URI scheme is how most of the Lightning world hands an LNURL to a wallet, and
  // a till printed that way used to read as "not a payment code" — a dead end at a checkout with no
  // way to tell an unsupported sticker from a damaged one. Stripped, not parsed as a URL: the
  // payload after the scheme is the code itself, and `lightning://` is the same thing with the
  // authority slashes some encoders add. (`decodeLnurl` still decides whether it IS an LNURL.)
  const t = stripLightningScheme(raw0);
  // The provider's OWN endpoint, printed with no LNURL wrapper at all. DFX's `PaymentLinkDto`
  // carries `url` beside `frontendUrl`, so a sticker made from the wrong field looks exactly like
  // this. Admitted only for an LNURL-pay endpoint PATH, never for any https URL: dpay's own payment
  // links are https too and must keep routing to the link parser (`classifyScan`).
  const direct = lnurlpEndpointOf(t);
  if (direct !== null) return direct;
  const candidate = t.toLowerCase().startsWith(`${LNURL_HRP}1`) ? t : lightningParamOf(t);
  if (candidate === null) return {ok: false, reason: 'not-lnurl'};
  const decoded = decodeLnurl(candidate);
  if (!decoded.ok) return decoded;
  return providerUrl(decoded.url);
}

/** Drop a `lightning:` / `lightning://` / `lnurlp:` scheme prefix, in any case. Anything else is
 *  returned untouched — this only unwraps, it never decides what the payload is. */
function stripLightningScheme(t: string): string {
  const m = /^(?:lightning|lnurlp):(?:\/\/)?/i.exec(t);
  return m === null ? t : t.slice(m[0].length);
}

/** An LNURL-pay endpoint given directly (`https://<host>/…/lnurlp/<id>`), or null when the string is
 *  not one. The `/lnurlp/` path segment is the discriminator: it is the convention every LNURL-pay
 *  server uses, it is what this provider serves, and it is absent from dpay's own link shape — so a
 *  payment link and a random https URL both fall through to the callers that own them. */
function lnurlpEndpointOf(text: string): OcpScan | null {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.pathname.toLowerCase().includes('/lnurlp/')) return null;
  return providerUrl(text);
}

/** The final gate every accepted spelling passes through: it must be an https URL, and the host is
 *  carried out for the review screen. ONE place, so a new input shape cannot skip the scheme check. */
function providerUrl(url: string): OcpScan {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return {ok: false, reason: 'not-a-url'};
  }
  if (u.protocol !== 'https:') return {ok: false, reason: 'not-https'};
  return {ok: true, apiUrl: url, host: u.host};
}

/** The `lightning` parameter of an absolute URL, or null when the string is not a URL or carries no
 *  such parameter. `URL` + `searchParams` is the platform path the payment-link parser already
 *  relies on for https URLs on every runtime this app ships to. */
function lightningParamOf(text: string): string | null {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  // Case-INSENSITIVE on the parameter name. A QR encoder that picks alphanumeric mode (denser code,
  // fewer modules) uppercases the entire string, parameter names included — so the same sticker can
  // arrive as `?LIGHTNING=`. The value's case never mattered: bech32 is case-insensitive.
  for (const [name, value] of u.searchParams) {
    if (name.toLowerCase() === 'lightning' && value.length > 0) return value;
  }
  return null;
}

// --- the destination URIs the provider hands back (step 3) --------------------------------------
// Hand-parsed rather than fed to `URL`: these are non-special schemes, and the only URL machinery
// on the phone is a polyfill pulled in transitively by another dependency. The fields decided here
// name a ledger and move money, so they must parse identically on Hermes, jest/Node and the web
// bundle — a hand-rolled split does; a polyfill's treatment of opaque paths is not something to
// discover in production.

// The amount grammar. Mirrors what `lib/amount.ts` accepts (calculator-style: `1.` and `.5` are
// both numbers) — including the live provider's `amount=1.`, which naive parsers reject. This is a
// SHAPE gate only, because the asset (and therefore the precision and the u64 bound) is not known
// until an offer is selected; the exact conversion is `parseDecimalToUnits` in
// `selectPayableOffers`. Its only job is to make sure an unreadable amount is refused instead of
// being carried forward toward a 0.
const RE_DECIMAL_AMOUNT = /^(\d+\.?\d*|\.\d+)$/;

const ICP_URI_SCHEME = 'icp:';
const ICP_TRANSFER_METHOD = 'transfer';
const SOLANA_URI_SCHEME = 'solana:';

/** The query parameters each destination URI may carry: the ones this wallet ACTS ON. Anything else
 *  is refused, never ignored — see `unexpected-parameter`, and `hasUnknownParam` for why that is not
 *  pedantry. The lists are data, so a parameter joins one the day the code that honours it lands and
 *  not before: admitting a name without implementing it is precisely the silent drop this refuses.
 *
 *  ICP: `to` names the account, `amount` names the value, and `ref` names the sale — the reference a
 *  provider wants echoed as the transfer's on-chain memo so its ledger match is exact rather than a
 *  resemblance (dpay's own till mints one per charge, `crates/dpay-relay/src/till.rs`). It is
 *  honoured, which is why it is listed: the payer's transfer carries it as the ICRC-1 memo. Same
 *  name and same 32-hex shape as a payment link's `ref` (`lib/deepLink.ts`, the authority for
 *  both), because it is the same fact. `subaccount` — the one a real wallet might be tempted to
 *  accept — stays out, for the reason the `to` value's own `owner.subaccount` spelling is refused a
 *  step later (`destinationOf`, `services/opencryptopay.ts`).
 *
 *  Solana: `amount` only. Solana Pay also defines `spl-token`, `reference`, `memo`, `label` and
 *  `message`, and NONE of them may be silently dropped here:
 *   • `spl-token` gets its own louder refusal below (it contradicts the selected asset);
 *   • `reference` is a read-only account the transaction MUST carry for the payee to find the
 *     payment — a transfer built without it is one the merchant's own tooling cannot match;
 *   • `memo` demands an SPL Memo instruction this rail does not build, so honouring it is not
 *     something the wallet can do and ignoring it changes what the provider receives;
 *   • `label` / `message` are display-only in Solana Pay, but they are stranger-supplied text this
 *     review does not render — accepting one means the payer approves a URI carrying words they
 *     were never shown. The measured provider sends none of them (findings doc), so refusing costs
 *     a conversation while accepting-and-ignoring costs the payment. */
const ICP_URI_PARAMS = ['to', 'amount', 'ref'];
const SOLANA_URI_PARAMS = ['amount'];

/** True when the query carries a parameter outside `allowed`. FAIL-CLOSED on purpose: this module
 *  advertises that a destination it cannot fully read is refused, and a parser that reads the two
 *  fields it knows and drops the rest is exactly the fail-open this module says it is not. */
function hasUnknownParam(params: Map<string, string>, allowed: string[]): boolean {
  for (const key of params.keys()) if (!allowed.includes(key)) return true;
  return false;
}

/**
 * Parse `icp:<ledger>/transfer?to=<principal>&amount=<decimal>[&ref=<32 hex>]`.
 *
 * The path's method segment is checked against `transfer` exactly: the URI tells the wallet which
 * ledger call to make, and anything other than a plain transfer is a call this wallet will not
 * perform on a stranger's say-so. Likewise the query is closed, not sampled (`ICP_URI_PARAMS`). The
 * principal is NOT validated here — the caller runs the core validator, so a mistyped destination
 * is refused by the same code that refuses one from a payment link.
 *
 * `ref` is OPTIONAL and absence is not a failure: a provider that names no reference gets the
 * wallet's own fresh nonce as the memo, which is what every till payment did before references
 * existed. A `ref` that is PRESENT and unreadable is refused rather than dropped — it is the
 * provider's instruction for how its sale gets matched, so ignoring it is how money moves and a
 * sale goes uncredited. Pure, total, never throws.
 */
export function parseIcpUri(uri: string): IcpUriParse {
  const t = typeof uri === 'string' ? uri.trim() : '';
  if (!t.toLowerCase().startsWith(ICP_URI_SCHEME)) return {ok: false, reason: 'wrong-scheme'};
  const rest = t.slice(ICP_URI_SCHEME.length);
  const q = rest.indexOf('?');
  if (q < 0) return {ok: false, reason: 'malformed-uri'};
  const path = rest.slice(0, q).split('/');
  if (path.length !== 2 || path[0].length === 0 || path[1] !== ICP_TRANSFER_METHOD) {
    return {ok: false, reason: 'malformed-uri'};
  }
  const params = queryParams(rest.slice(q + 1));
  if (params === null) return {ok: false, reason: 'malformed-uri'};
  if (hasUnknownParam(params, ICP_URI_PARAMS)) return {ok: false, reason: 'unexpected-parameter'};
  const to = params.get('to') ?? '';
  if (to.length === 0) return {ok: false, reason: 'malformed-uri'};
  const amount = params.get('amount') ?? '';
  // Missing and unreadable are one fact for the payer: there is no amount to pay.
  if (!RE_DECIMAL_AMOUNT.test(amount)) return {ok: false, reason: 'bad-amount'};
  const ref = params.get('ref') ?? null;
  if (ref !== null && !RE_REF.test(ref)) return {ok: false, reason: 'bad-ref'};
  // Lowercased, because a memo is compared as bytes downstream and the ledger renders it as
  // lowercase hex — the same normalisation `parsePayLink` applies to the identical field.
  return {ok: true, ledger: path[0], to, amount, ref: ref === null ? null : ref.toLowerCase()};
}

/**
 * Parse `solana:<address>?amount=<decimal>`.
 *
 * Two refusals carry the weight here. An `spl-token` parameter means the URI is not the native SOL
 * transfer this rail signs, and the live provider omits that parameter even for USDC — so its
 * presence is a contradiction, not an instruction. And a destination containing `/` or `:` is
 * Solana Pay's transaction-REQUEST form (`solana:https://…`), an entirely different interaction
 * that must never be mistaken for a transfer. Every OTHER Solana Pay parameter is refused as well
 * (`SOLANA_URI_PARAMS` says why each one), because ignoring a field is the provider giving an
 * instruction the payer never sees. The address itself is not validated here; the Solana rail's own
 * validator does that. Pure, total, never throws.
 */
export function parseSolanaUri(uri: string): SolanaUriParse {
  const t = typeof uri === 'string' ? uri.trim() : '';
  if (!t.toLowerCase().startsWith(SOLANA_URI_SCHEME)) return {ok: false, reason: 'wrong-scheme'};
  const rest = t.slice(SOLANA_URI_SCHEME.length);
  const q = rest.indexOf('?');
  if (q < 0) return {ok: false, reason: 'malformed-uri'};
  const to = rest.slice(0, q);
  if (to.length === 0 || to.includes('/') || to.includes(':')) return {ok: false, reason: 'malformed-uri'};
  const params = queryParams(rest.slice(q + 1));
  if (params === null) return {ok: false, reason: 'malformed-uri'};
  // Checked BEFORE the generic unknown-parameter refusal: a token URI is a specific contradiction
  // with its own explanation, and collapsing it into "a parameter I don't know" would lose that.
  if (params.has('spl-token')) return {ok: false, reason: 'spl-token-unsupported'};
  if (hasUnknownParam(params, SOLANA_URI_PARAMS)) return {ok: false, reason: 'unexpected-parameter'};
  const amount = params.get('amount') ?? '';
  if (!RE_DECIMAL_AMOUNT.test(amount)) return {ok: false, reason: 'bad-amount'};
  return {ok: true, to, amount};
}

/** Split a URI query into its parameters. Null when a parameter is REPEATED (`?amount=1&amount=99`
 *  has no honest answer, and silently keeping one of them is how a wallet pays the wrong number) or
 *  when a percent-escape is broken. No `+`-as-space translation: this is a URI query, not an HTML
 *  form, and no field here can contain a space. */
function queryParams(qs: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const pair of qs.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    try {
      const k = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
      const v = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1));
      if (out.has(k)) return null;
      out.set(k, v);
    } catch {
      return null;
    }
  }
  return out;
}

// --- the provider's deadlines (step 2's quote expiry, step 3's transfer-instruction expiry) -----

/** The ONE spelling this wallet reads a provider deadline in: an RFC 3339 UTC instant, seconds
 *  mandatory, up to milliseconds optional, `Z` mandatory. Exactly what the live provider sends
 *  ("2026-09-01T14:50:04.660Z" — findings doc, measured), and nothing else. */
const RE_UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * A provider deadline as epoch ms, or null when it is not the one spelling above.
 *
 * NOT `Date.parse`. `Date.parse` accepts a long, partly implementation-defined list of spellings,
 * and one of them is the money bug: `"2026-09-01 14:50:04"` (a space, no `Z`) is read by V8 as
 * DEVICE-LOCAL time, so a phone set to UTC+14 believes a quote that died hours ago is still live —
 * and this deadline is what decides whether the one-shot submission is spent at all. `+02:00` and a
 * bare `2026-09-01` are refused for the same reason they were never sent: an unrecognised deadline
 * is a fact the payer must be told (the screen says the provider gave no readable expiry), never a
 * number to guess at.
 *
 * The instant is computed with `Date.UTC` and then read back, so it is engine-independent (no
 * fallback to any legacy parser) and rolled-over components are refused rather than accepted:
 * `2026-02-30T…` would silently become 2 March, which is a different deadline than the one sent.
 * One implementation, used by both provider deadlines (`services/opencryptopay.ts` reads step 3's
 * `expiryDate` with it) — the leniency this replaced existed twice. Pure, total, never throws.
 */
export function parseProviderInstant(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = RE_UTC_INSTANT.exec(v);
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  // "1-3 digits, milliseconds" — `.6` is 600ms, not 6ms. Padded, never truncated.
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  const at = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  const sameInstant =
    d.getUTCFullYear() === year
    && d.getUTCMonth() === month - 1
    && d.getUTCDate() === day
    && d.getUTCHours() === hour
    && d.getUTCMinutes() === minute
    && d.getUTCSeconds() === second;
  return sameInstant ? at : null;
}

// --- the provider's payment details (step 2) ----------------------------------------------------

/**
 * Narrow the provider's step-2 JSON into `OcpDetails`.
 *
 * STRICT AND WHOLE: a body missing the quote, the callback or the transfer amounts — or carrying a
 * single unreadable asset amount — is refused entirely. Keeping the readable half of a payment
 * response would put a shortened list of options on screen with no explanation of what was dropped,
 * which is exactly the silent failure this codebase does not allow. The two DISPLAY fields are the
 * exceptions — the merchant name and the till's own price both yield `null` rather than a refusal,
 * because refusing a payment over a line of context buys the payer nothing.
 *
 * The callback must be `https` for the same reason the scanned code must: it is the URL the wallet
 * will call with the proof of an irreversible transfer.
 *
 * Unknown methods and unknown assets parse FINE here — they are the policy layer's business
 * (`selectPayableOffers`), so a provider adding an asset never breaks the parse.
 */
export function parsePaymentDetails(json: unknown): OcpDetailsParse {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return {ok: false, reason: 'malformed-details'};
  const j = json as Record<string, unknown>;

  const callbackUrl = typeof j.callback === 'string' ? j.callback.trim() : '';
  if (callbackUrl.length === 0) return {ok: false, reason: 'malformed-details'};
  let cb: URL;
  try {
    cb = new URL(callbackUrl);
  } catch {
    return {ok: false, reason: 'malformed-details'};
  }
  if (cb.protocol !== 'https:') return {ok: false, reason: 'not-https'};
  const submitUrl = submissionUrlOf(cb);
  if (submitUrl === null) return {ok: false, reason: 'unreportable-callback'};

  const quote = j.quote;
  if (quote === null || typeof quote !== 'object' || Array.isArray(quote)) return {ok: false, reason: 'malformed-details'};
  const q = quote as Record<string, unknown>;
  const quoteId = typeof q.id === 'string' ? q.id.trim() : '';
  if (quoteId.length === 0) return {ok: false, reason: 'malformed-details'};
  // ONE accepted spelling, enforced (`parseProviderInstant`) rather than described: guessing between
  // seconds, milliseconds, a local-time date string and a date is precisely the coercion that turns
  // a long-expired quote into one this wallet believes is live.
  const quoteExpiresAt = parseProviderInstant(q.expiration);
  if (quoteExpiresAt === null) return {ok: false, reason: 'malformed-details'};

  const list = j.transferAmounts;
  if (!Array.isArray(list) || list.length === 0) return {ok: false, reason: 'malformed-details'};
  const transferAmounts: OcpTransferAmount[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return {ok: false, reason: 'malformed-details'};
    const e = entry as Record<string, unknown>;
    const method = typeof e.method === 'string' ? e.method.trim() : '';
    if (method.length === 0) return {ok: false, reason: 'malformed-details'};
    if (typeof e.available !== 'boolean') return {ok: false, reason: 'malformed-details'};
    if (!Array.isArray(e.assets)) return {ok: false, reason: 'malformed-details'};
    // A method the provider advertises but cannot currently settle carries an EMPTY asset list, and
    // the live provider sends three of them on every single response (measured 2026-09-01:
    // `TaprootAsset`, `Spark`, `Arkade`). That is coherent — the method exists, it offers nothing
    // right now — and it names no asset this wallet could ever select, so it is dropped and the
    // payable methods beside it survive. Refusing the whole body over it made EVERY real till
    // unpayable on both rails while the suite stayed green, because no fixture carried one.
    //
    // `available: true` with nothing to settle is the CONTRADICTORY case and stays malformed: a
    // method claiming to be settleable must name what it settles, and a parser that shrugs at a
    // self-contradictory body cannot be trusted about the rest of it.
    if (e.assets.length === 0) {
      if (e.available) return {ok: false, reason: 'malformed-details'};
      continue;
    }
    const assets: OcpAssetAmount[] = [];
    for (const a of e.assets) {
      const parsed = parseAssetAmount(a);
      if (parsed === null) return {ok: false, reason: 'malformed-details'};
      assets.push(parsed);
    }
    transferAmounts.push({method, available: e.available, assets});
  }
  // A till that named nothing settleable at all is the same fact as one that sent no methods, and
  // gets the same refusal — so every parsed `OcpDetails` still carries at least one method, and the
  // "this till takes: …" copy can never be built from an empty list.
  if (transferAmounts.length === 0) return {ok: false, reason: 'malformed-details'};

  return {
    ok: true,
    details: {
      submitUrl,
      proofHost: cb.host,
      quoteId,
      quoteExpiresAt,
      callbackUrl,
      claimedMerchantName: claimedMerchantNameOf(json),
      requestedAmount: parseAssetAmount(j.requestedAmount),
      transferAmounts,
    },
  };
}

/** The segment a provider's transfer-details callback is served under. Swapping it for `/tx/` is
 *  how the submission URL is derived — measured accepted live, and the derivation is preferred over
 *  the `hint`'s `/v1/lnurlp/tx/<id>` spelling because it reuses the PROVIDER'S own path instead of
 *  hard-coding DFX's API layout into a wallet that any provider may serve. */
const CALLBACK_SEGMENT = '/cb/';
const SUBMIT_SEGMENT = '/tx/';

/** The URL an on-chain proof will be reported to, or null when this callback cannot produce one.
 *  Null is a REFUSAL the caller must act on before the payer consents — never a "try the callback
 *  itself" fallback, which would spend the single submission attempt on the wrong endpoint. The
 *  callback's own query survives, because it is the provider's and the submission adds to it. */
function submissionUrlOf(cb: URL): string | null {
  const path = cb.pathname;
  const at = path.lastIndexOf(CALLBACK_SEGMENT);
  if (at < 0) return null;
  const id = path.slice(at + CALLBACK_SEGMENT.length);
  if (id.length === 0) return null;
  return `${cb.origin}${path.slice(0, at)}${SUBMIT_SEGMENT}${id}${cb.search}`;
}

/** Marks a piece of provider display text the cap CUT — a merchant name or the till's own price.
 *  Without it a truncation is indistinguishable from the whole string, and the payer would be told
 *  they are paying "Migros Bahnhofstrass" — a different merchant than the one the string actually
 *  named — or a price that is a prefix of the one that was sent. Costs 3 bytes past the cap, on the
 *  display copy only. */
const TRUNCATED_MARK = '…';

/**
 * The merchant name the provider CLAIMS, from ANY of its payload shapes. Extracted here — not
 * inline in `parsePaymentDetails` — because the provider sends the same `displayName` on a body
 * this parser REFUSES: the "no charge waiting" 404 carries the payment-link payload without a
 * quote, and the screen still names the merchant on it (`services/opencryptopay.ts`). One
 * extraction rule, two callers; never verified, always rendered as claimed.
 *
 * BOUNDED AND SANITISED, because this string is hostile input by construction: a scanned LNURL can
 * name ANY host (findings doc, "Trust model"), so a sticker over a real till points the wallet at a
 * server that writes this name. Unbounded, it is a LAYOUT weapon rather than a lie — React Native
 * `Text` renders newlines, so a name of thirty blank lines pushes the provider host, the countdown
 * and the full destination account off the screen, deleting precisely the three lines that make the
 * sticker answerable. `clampLinkText` is the payment link's answer to the identical problem on the
 * identical kind of string (`lib/deepLink.ts`), so it is reused rather than re-invented: same cap,
 * same sanitiser, one rule for a payee name wherever it came from.
 */
export function claimedMerchantNameOf(json: unknown): string | null {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const name = (json as {displayName?: unknown}).displayName;
  const clean = sanitiseDisplayText(typeof name === 'string' ? name : '');
  if (clean.length === 0) return null;
  const clamped = clampLinkText(clean);
  return clamped === clean ? clamped : `${clamped}${TRUNCATED_MARK}`;
}

/**
 * One asset amount spelled for a REVIEW LINE ("CHF 1"). Display only, and composed rather than
 * converted: the only amount rendered through it is the till's own price (`OcpDetails.requestedAmount`),
 * which is the MERCHANT's figure and never dpay's — dpay does not quote and does not convert.
 *
 * The amount's SPELLING is straightened because the grammar this module accepts is deliberately
 * calculator-style (`RE_DECIMAL_AMOUNT`: the live provider really does send `1.`), and those two
 * edge spellings read as defects in a sentence — "charging CHF 1.." with the copy's own full stop,
 * and a leading bare point as a typo. Only the point moves: no digit is added, dropped or rounded,
 * so the number shown is the number sent.
 *
 * BOUNDED AND SANITISED, through the same door as every other stranger-supplied string the review
 * renders (`claimedMerchantNameOf` above, a payment link's `label`/`memo` in `lib/deepLink.ts`).
 * Both halves need it: the provider's `asset` is free text this parser only trims, so a ticker of
 * newlines would push the host line, the countdown and the destination account off the screen — the
 * exact layout weapon the merchant name already closes — and the `amount` grammar bounds the
 * CHARACTERS but not the LENGTH, so a thousand-digit price does the same with no control character
 * at all. A cut is MARKED, because a cut price is a different price and an unmarked truncation
 * would read as the whole one. Every realistic fiat price is far inside the cap, so the mark only
 * ever appears on a figure the provider had no business sending.
 */
export function ocpPriceText(a: OcpAssetAmount): string {
  const withUnit = a.amount.startsWith('.') ? `0${a.amount}` : a.amount;
  const line = `${a.asset} ${withUnit.endsWith('.') ? withUnit.slice(0, -1) : withUnit}`;
  const clean = sanitiseDisplayText(line);
  const clamped = clampLinkText(clean);
  return clamped === clean ? clamped : `${clamped}${TRUNCATED_MARK}`;
}

/** `{asset, amount}` from the provider, with the amount normalised to a plain decimal string. */
function parseAssetAmount(v: unknown): OcpAssetAmount | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const asset = typeof o.asset === 'string' ? o.asset.trim() : '';
  if (asset.length === 0) return null;
  const amount = decimalStringOf(o.amount);
  return amount === null ? null : {asset, amount};
}

/** A provider amount as an exact decimal string. JSON gives numbers, and `String(1.6e-7)` is
 *  `"1.6e-7"` — a spelling every decimal parser in this codebase rejects, which would refuse a
 *  perfectly good 16-sat amount. So exponent notation is EXPANDED (digit shifting, no rounding) and
 *  anything that is not a plain non-negative decimal is refused. Strings pass through verbatim. */
function decimalStringOf(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim();
    return RE_DECIMAL_AMOUNT.test(s) ? s : null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const s = String(v);
  if (RE_DECIMAL_AMOUNT.test(s)) return s;
  const m = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(s);
  if (m === null) return null;
  const digits = m[1] + (m[2] ?? '');
  const point = m[1].length + parseInt(m[3], 10);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

// --- which offers this wallet can pay (the policy table) ----------------------------------------

/** The provider's settlement methods, mapped to the rail that would move the money. Matched exactly
 *  as the provider spells them, because the same string is echoed back in steps 3 and 4. A method
 *  that is not in this table is refused by name, never approximated: `Lightning` and `Ethereum` are
 *  real OpenCryptoPay methods this wallet has no rail for, and paying one of them "close enough" is
 *  not a thing dpay does. */
const OCP_METHOD_RAIL: Record<string, SelectableAsset['protocol']> = {
  InternetComputer: 'ic',
  Solana: 'solana',
};

/**
 * The identifier a settled IC transfer is REPORTED to the provider as (step 4's `tx`).
 *
 * Two spellings, and which one is right is decided by the LEDGER, never by the asset. Measured
 * against the live provider on 2026-09-04 by bracketing which indexes it considers to exist
 * (`just ocp-ledger-probe`, findings doc):
 *   • the NATIVE ICP ledger takes the index BARE. Prefixing it is not a harmless verbosity — an
 *     index that plainly exists on the ICP ledger answers "not confirmed in blockchain
 *     InternetComputer" once prefixed, so the prefixed spelling resolves nothing there;
 *   • EVERY OTHER ICRC ledger takes `<ledgerCanisterId>:<blockIndex>`, and a bare index on one of
 *     them is looked up on the ICP ledger instead — which is what cost a real VCHF payment on
 *     2026-09-03, before the shape was known.
 *
 * The ledger is the provider's OWN spelling from its transfer URI (`OcpTarget.ledger`), carried
 * rather than re-derived for the same reason `method` and `asset` are: the wallet answers a provider
 * in the words that provider used.
 */
export function ocpIcTxId(ledger: string, blockIndex: string): string {
  return ledger === ICP_LEDGER_PRINCIPAL ? blockIndex : `${ledger}:${blockIndex}`;
}

/** Does a provider offer row — `{method, asset}` in the PROVIDER's spelling — name this wallet
 *  asset? The (rail, ledger token) pair, matched exactly as `selectPayableOffers` matches it, and
 *  exported for that reason: a refusal row carries only the provider's spelling, so a screen that
 *  has to answer "is this refusal about the asset the payer chose?" would otherwise re-derive the
 *  rule and drift from the one that produced the row. */
export function offerNamesAsset(offer: {method: string; asset: string}, asset: SelectableAsset): boolean {
  return OCP_METHOD_RAIL[offer.method] === asset.protocol && tokenEq(asset.linkToken, offer.asset);
}

/**
 * Split the provider's offers into what this wallet can pay and what it cannot, WITH the reason.
 *
 * `assets` is the wallet's own selectable-asset list (`buildSelectableAssets`) — the one list that
 * spans both rails and already carries each asset's ledger token and precision, so an offer is
 * matched on the pair (rail, token) exactly the way a payment link's `?asset=&network=` is. It says
 * which assets this wallet CARRIES, not what it holds: a zero balance is the funding gate's answer,
 * on the review screen, in the asset's own units.
 *
 * `nowMs` is passed in rather than read from the clock so the function stays pure and the expiry
 * boundary is testable. An expired quote refuses EVERY offer with `quote-expired`: nothing is
 * payable until the till is rescanned, and one honest reason on every row beats a list of options
 * that cannot be taken.
 *
 * Order matters wherever a later step would otherwise turn a refusal into a payable offer. Solana
 * USDC is refused BEFORE the wallet lookup, because the wallet DOES carry USDC on Solana — matching
 * first would produce a payable offer for the one asset the findings say must not be paid until DFX
 * answers what that address is.
 */
export function selectPayableOffers(
  details: OcpDetails,
  assets: SelectableAsset[],
  nowMs: number,
): {payable: OcpOffer[]; refused: OcpOfferRefusal[]} {
  const payable: OcpOffer[] = [];
  const refused: OcpOfferRefusal[] = [];
  const expired = nowMs >= details.quoteExpiresAt;
  for (const entry of details.transferAmounts) {
    const rail = OCP_METHOD_RAIL[entry.method] ?? null;
    for (const offered of entry.assets) {
      const row = {method: entry.method, asset: offered.asset};
      const refuse = (reason: OcpOfferRefusal['reason']): void => {
        refused.push({...row, reason});
      };
      if (expired) {
        refuse('quote-expired');
        continue;
      }
      if (rail === null) {
        refuse('unknown-method');
        continue;
      }
      // Checked AFTER the rail, before anything per-asset: unavailability is the PROVIDER's own
      // statement about the whole method, so it disqualifies every asset under it — but only for a
      // method this wallet could otherwise have used. For a method with no rail here, "we can't pay
      // that at all" is the permanent, truthful reason and it stays.
      if (!entry.available) {
        refuse('method-unavailable');
        continue;
      }
      if (rail === 'solana' && tokenEq('USDC', offered.asset)) {
        refuse('solana-usdc-unsupported');
        continue;
      }
      const matches = assets.filter(a => offerNamesAsset(row, a));
      if (matches.length === 0) {
        refuse('asset-not-in-wallet');
        continue;
      }
      if (matches.length > 1) {
        refuse('ambiguous-asset');
        continue;
      }
      const match = matches[0];
      // The ONE conversion, at this asset's own precision. An amount with more decimals than the
      // asset has — or a zero — is refused, never rounded: dpay pays the exact amount asked for or
      // it pays nothing.
      const raw = parseDecimalToUnits(offered.amount, match.decimals);
      if (!raw.ok || raw.raw === '0') {
        refuse('bad-amount');
        continue;
      }
      payable.push({
        method: entry.method,
        asset: offered.asset,
        amount: offered.amount,
        assetId: match.id,
        rawAmount: raw.raw,
      });
    }
  }
  return {payable, refused};
}
