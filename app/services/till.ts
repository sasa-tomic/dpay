// The MERCHANT half of dpay's own OpenCryptoPay till — the three routes only a shop calls.
//
// Everything else in this app PAYS a till (`services/opencryptopay.ts`, the payer's four provider
// reads). This module is the other side of the counter: ring a charge up, clear it, and watch it.
// The routes and every rule behind them are `crates/dpay-relay/src/till.rs`; nothing about the
// till's behaviour is restated here, only consumed.
//
// FOUR THINGS DECIDE THIS FILE.
//
// 1. **A RING-UP IS SIGNED, and the signature is the merchant's claim on the money.** The till pays
//    the account DERIVED from `merchant_pubkey`, so naming a key is claiming an account. The core
//    signs the canonical bytes (`DpayCore.tillOpenSignature`, encoding pinned in
//    `dfx/till_open_signing.json`) over the merchant's OWN seed — this module never sees a
//    pubkey it did not derive from that seed, and the relay verifies before it opens anything.
//    A cancellation is the SAME shape with `cents = 0`, which is why one `signedBody` serves both:
//    neither signature is a valid instance of the other action.
//
// 2. **AN UNREADABLE ANSWER IS NEVER "UNPAID".** `chargeStatus` has exactly one outcome for "the
//    relay did not tell us" — `unchecked` — and the merchant's screen must render it as "can't
//    check", never as "waiting" and never as "nothing arrived". A cashier who is told a paid
//    customer has not paid hands over goods twice or accuses them; both are worse than saying the
//    till is out of contact. This is the same discipline the relay applies to its own ledger reads.
//
// 3. **MONEY IS INTEGER, END TO END.** A CHF price is parsed to whole cents by the exact BigInt
//    parser every amount field in this app already uses, signed as a decimal STRING, and turned
//    into raw ledger units by `tillRawUnits` — BigInt, never `parseFloat`, never `f64`. The one
//    place a JSON `number` is accepted is the wire's `cents` (the relay's field is a bare `u64`,
//    not the app's usual decimal string), and it is guarded by `Number.isSafeInteger` at both ends.
//
// 4. **THE PRICE THE TILL ANSWERS WITH IS CHECKED AGAINST THE PRICE THAT WAS RUNG UP.** A ring-up
//    that comes back quoting a different amount than the cashier typed is refused as `mispriced`
//    rather than shown: the code would charge a customer a number nobody at the counter chose.
//
// WHERE THE WORDS COME FROM. Nothing here is a sentence for a screen. Outcomes carry the relay's
// OWN message (`said`, sanitised — it is the diagnosis, and the merchant repeats it to whoever runs
// the relay) and an English `detail` that may only ever reach `console.warn`. The localized framing
// around both is `M.receive.till.*`, chosen by the component: the app has four locales and no
// runtime fallback, so an English string returned from here is an English string a German cashier
// reads.
import {DpayCore} from './native';
import {fetchWithTimeout} from './relay';
import {relayAddresses, relayAddressesRevision} from './relayAddresses';
import {parseDecimalToUnits} from '../lib/amount';
import {sanitiseDisplayText} from '../lib/deepLink';
import {base, nowSecs, randNonceHex} from '../lib/format';
import type {Identity} from '../lib/types';

/** The ONE method/asset pair dpay's till serves — `METHOD`/`ASSET` in `crates/dpay-relay/src/till.rs`.
 *  Spelled in the PROVIDER's vocabulary because that is what it is matched against: `offerNamesAsset`
 *  (`lib/opencryptopay.ts`) answers "does this provider row name that wallet asset?", and the
 *  merchant side asks the same question of the same pair rather than inventing a second rule.
 *  Pinned against the relay's real bytes by `app/__tests__/till.test.ts` via `dfx/till_wire.json`. */
export const TILL_OFFER = {method: 'InternetComputer', asset: 'VCHF'} as const;

/** CHF has two decimals, everywhere and forever — the scale a till charge is priced at. */
const CHF_DECIMALS = 2;

/** A charge as the ring-up answered it. `cents` is what THIS device signed (the open response does
 *  not echo it), `qr` is the string that belongs in a QR — the `?lightning=` wrapper a generic
 *  phone camera opens as a web page — and the two instants are the charge's own clock, so the
 *  cashier's countdown needs no copy of the relay's lifetime constant.
 *
 *  `reference` is THIS CHARGE'S NAME ON THE LEDGER: the relay credits only a transfer whose ICRC-1
 *  memo carries it (`match_payment`, `crates/dpay-relay/src/till.rs`). A payer scanning the code
 *  learns it from the till's step-3 instruction; the MERCHANT learns it here, which is what lets
 *  this app collect the same sale over a channel the standard has no part in — an NFC tap, whose
 *  request nonce becomes that memo (`prepareNfcTransfer`, `services/rail.ts`). A tap built with any
 *  other nonce would move the customer's money and credit nothing. */
export type TillCharge = {
  id: string;
  cents: string;
  qr: string;
  reference: string;
  createdSecs: number;
  expiresAt: number;
};

/** Where a charge stands, in the relay's own vocabulary (`ChargeState`). */
export type TillChargeState = 'open' | 'paid' | 'superseded' | 'cancelled' | 'expired';

/** The settlement, as the relay OBSERVED it on the merchant's own ledger history. `block` is the
 *  row that paid — what the merchant's screen names, and the only stable identity a transfer has. */
export type TillSettled = {from: string; amountRaw: string; atSecs: number; block: number};

export type TillStatus = {
  id: string;
  cents: string;
  state: TillChargeState;
  createdSecs: number;
  expiresAt: number;
  paid: TillSettled | null;
};

export type TillOpenOutcome =
  | {kind: 'open'; charge: TillCharge}
  /** The till answered with a price that is not the one that was rung up. Nothing is shown. */
  | {kind: 'mispriced'; quoted: string}
  /** The relay serves no till (`DPAY_ENABLE_TILL` unset — its routes are not registered, so the
   *  POST 404s with nothing to say). A first-class state, not an error: this relay simply is not a
   *  till, and the merchant needs to hear that rather than "something went wrong". `addr` is the
   *  relay that ANSWERED — the sentence must name the relay actually asked, which under a walk or
   *  a pin need not be the caller's preferred URL. */
  | {kind: 'not-served'; addr: string}
  /** The till refused, and said why. `said` is its own sentence — the price bound, the clock skew,
   *  the reused nonce — every one of which already names the fix. */
  | {kind: 'refused'; said: string | null; status: number}
  /** The relay could not be reached at all. `tried` names the address(es) this call actually
   *  tried — the pin ALONE once a session is pinned to an address still in the configured list
   *  (a mid-session failure is a fact about that one relay), else every address of the walk —
   *  so the merchant's error never blames a relay that was not asked. */
  | {kind: 'unreachable'; detail: string; tried: string[]}
  /** This device could not produce the signature. Nothing was sent. */
  | {kind: 'unsigned'; detail: string};

export type TillStatusOutcome =
  | {kind: 'status'; status: TillStatus}
  /** The relay does not hold this charge (a restart, or a sweep). Nothing was credited HERE. */
  | {kind: 'gone'; said: string | null}
  /** WE DO NOT KNOW. Never "unpaid", never "still waiting" — see rule 2 in the module header. */
  | {kind: 'unchecked'; detail: string};

export type TillVoidOutcome =
  | {kind: 'cancelled'; status: TillStatus}
  /** Includes the one refusal that matters: the charge was already PAID, with the block that paid
   *  it named in `said`. Money moved, so nothing rings it away. */
  | {kind: 'refused'; said: string | null; status: number}
  /** Same attribution as the open path's `unreachable`: the addresses actually asked — the pin
   *  ALONE once a session is pinned to an address still in the configured list, else the whole
   *  walk in order — so the "could NOT cancel" copy names who did not answer instead of blaming
   *  the caller's preferred URL. */
  | {kind: 'unreachable'; detail: string; tried: string[]}
  | {kind: 'unsigned'; detail: string};

/** What the cashier typed, as whole CHF cents — or which rule it broke. Integer end to end: the
 *  same exact BigInt parser every other amount field in this app uses, at CHF's two decimals, so a
 *  price can never be wrong in the last digit. `too-precise` is told apart from `not-a-number`
 *  because they send the cashier to do different things (round the rappen vs type a number). */
export function chfCents(text: string): {ok: true; cents: string} | {ok: false; reason: 'too-precise' | 'not-a-number' | 'too-large'} {
  const parsed = parseDecimalToUnits(text.trim(), CHF_DECIMALS);
  if (!parsed.ok) {
    // `overflow` is a SIZE, not a shape: the parser reached a value no u64 can hold. Telling that
    // cashier to "type a number" would be telling them the wrong thing about the number they typed.
    if (parsed.err === 'too_many_decimals') return {ok: false, reason: 'too-precise'};
    return {ok: false, reason: parsed.err === 'overflow' ? 'too-large' : 'not-a-number'};
  }
  if (parsed.raw === '0') return {ok: false, reason: 'not-a-number'};
  // The wire's `cents` is a bare JSON `u64`, so it crosses as a `number`. Anything past the exact
  // integer range would be signed as one value and sent as another — refused here, where the
  // cashier can still fix it, rather than becoming a charge for a price nobody typed.
  if (!Number.isSafeInteger(Number(parsed.raw))) return {ok: false, reason: 'too-large'};
  return {ok: true, cents: parsed.raw};
}

/** The exact raw ledger units a CHF-cent price means on the till's asset — `cents × 10^(d−2)`,
 *  BigInt only. The till prices 1:1 with the franc (`crates/dpay-relay/src/till.rs`), so this is
 *  the whole conversion; there is no rate anywhere, which is why there is nothing to be wrong
 *  about. Throws on an asset whose precision cannot express a rappen — a wallet that formatted a
 *  price it cannot represent would be printing a lie. */
export function tillRawUnits(cents: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < CHF_DECIMALS) {
    throw new Error(`till: an asset with ${decimals} decimals cannot express a CHF rappen`);
  }
  let scale = 1n;
  for (let i = CHF_DECIMALS; i < decimals; i++) scale *= 10n;
  return (BigInt(cents) * scale).toString(10);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Read a till answer as JSON. Never throws and never substitutes a default: `null` means the body
 *  was unreadable, which is a state each caller has to decide about (an empty 404 is a relay that
 *  serves no till; an unreadable poll is `unchecked`). Logged, because a silent unreadable body is
 *  a debugging dead end. */
async function readJson(r: Response): Promise<unknown | null> {
  try {
    return await r.json();
  } catch (e) {
    console.warn(`till: HTTP ${r.status} body was not JSON: ${errText(e)}`);
    return null;
  }
}

/** The relay's error envelope is NestJS's `{statusCode, message, error}` — the shape its till
 *  emits for every refusal. Returns the sentence, sanitised (it is rendered, quoted, on the
 *  merchant's screen: `Text` honours newlines and bidi overrides, so an unsanitised message could
 *  scroll the instruction beside it out of view). Null when the body carries none. */
function said(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const m = (json as {message?: unknown}).message;
  const clean = sanitiseDisplayText(typeof m === 'string' ? m : '');
  return clean.length > 0 ? clean : null;
}

function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A wire field that is a JSON number and must be a whole one — a second's timestamp, a block
 *  index, a cent. Null when it is absent, fractional, or past the exact integer range. */
function whole(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

const STATES: readonly TillChargeState[] = ['open', 'paid', 'superseded', 'cancelled', 'expired'];

/** The merchant's signed request — a ring-up (`cents ≥ 1`) or a cancellation (`cents = 0`), told
 *  apart by the SIGNED price and by nothing else. Throws when the core cannot sign, which every
 *  caller turns into `unsigned`: an unsigned request is one the relay would refuse anyway, and
 *  sending it would burn a nonce for nothing. */
async function signedBody(identity: Identity, cents: string): Promise<Record<string, unknown>> {
  const centsNum = Number(cents);
  if (!Number.isSafeInteger(centsNum)) {
    throw new Error(`till: ${cents} cents cannot cross the wire exactly (the field is a JSON number)`);
  }
  const nonce = randNonceHex();
  const issuedAt = nowSecs();
  const signature = await DpayCore.tillOpenSignature(identity.secretHex, cents, nonce, issuedAt, identity.username);
  return {
    merchant_pubkey: identity.publicHex,
    merchant_name: identity.username,
    cents: centsNum,
    nonce,
    issued_at: issuedAt,
    signature,
  };
}

/** How long a merchant route may take. Generous next to a balance poll because a ring-up is a
 *  person standing at a counter waiting to be told a number is live, and short next to the
 *  submission budget on the payer side — nothing here has moved any money yet, so giving up early
 *  costs a retry rather than a payment. */
const TILL_TIMEOUT_MS = 15000;

// R1 — the till's ONE deliberate exception to multi-address selection (spec 2026-09-09
// §"Direction 2"): a till charge is RELAY-HELD, session-affine state. The charge id, its expiry
// and its settlement live on the relay that opened it, so the till client resolves ONE relay per
// session — the first address that answers — and stays there even if that address later fails:
// a mid-session failover would ask a replica that never heard of the charge and hand the cashier
// "not found" for a charge that is open elsewhere. The pin is bounded by MEMBERSHIP, not by
// eternity: it speaks for the session only while the configured list still carries its address
// (a reorder keeps it; a removal kills it — see `tillFetch`). Every other relay surface
// multi-homes through `services/relay.ts#relayFetch` instead.
let tillRelayPin: string | null = null;

/** The relay this session's till is pinned to, if any (diagnostics + tests). */
export function tillSessionRelay(): string | null {
  return tillRelayPin;
}

/** Test seam: forget the pin (the pin's own clock is the session; only tests shorten it). */
export function resetTillRelayPinForTest(): void {
  tillRelayPin = null;
}

/** The addresses a failed till call ACTUALLY tried — the pin ALONE once a session is pinned to
 *  an address the configured list still carries (a mid-session failure is a fact about that one
 *  relay), else every address of the walk in order. Carried on `TillOpenOutcome.unreachable.tried`
 *  and the warn lines so a failure is attributed to the relay(s) that did not answer, never to
 *  the caller's preferred URL by default. */
class TillUnreachable extends Error {
  readonly tried: string[];
  constructor(tried: string[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TillUnreachable';
    this.tried = tried;
  }
}

/**
 * The till's ordered walk — `relayFetch`'s shape WITHOUT the build gate, and with the pin above:
 * while unpinned it tries [the caller's relay, ...the operator list] in order; ONLY an OK (2xx)
 * answer pins — a till charge is relay-held state, so only a relay that can actually hold one
 * earns the session. A <500 non-2xx (a non-till relay's 404, a live till's 4xx refusal) is
 * remembered as the walk's answer but does NOT pin: the walk keeps looking for a 2xx further
 * down, and the next charge retries the walk, so a non-till relay sitting early in the list can
 * never hide a working till behind it. Once pinned, every call goes to the pin ALONE — ignoring
 * the caller's relay argument — for exactly as long as the configured list still carries the
 * pinned address (exact equality under the same `base` normalization the walk composes with): a
 * list edit that REMOVED the address kills the pin, and the call becomes the normal walk over
 * the new list, so a merchant who removes an address is never left with a shadow connection the
 * app keeps asking behind their back. At walk end the remembered <500 answer wins over the
 * synthetic all-dead error (a relay refusing to serve is a fact the cashier should hear);
 * otherwise the throw is `TillUnreachable`, naming every address tried.
 */
async function tillFetch(relayUrl: string, path: string, init: RequestInit, timeoutMs: number): Promise<{r: Response; addr: string}> {
  const first = base(relayUrl);
  const list = relayAddresses().map((a) => base(a));
  if (tillRelayPin != null && list.includes(tillRelayPin)) {
    try {
      return {r: await fetchWithTimeout(`${tillRelayPin}${path}`, init, timeoutMs), addr: tillRelayPin};
    } catch (e) {
      // The CALLER's abort is not a transport failure (see relayFetch for the same rule).
      if (init?.signal?.aborted) throw e;
      throw new TillUnreachable([tillRelayPin], e);
    }
  }
  // A pin whose address left the list is DEAD, not dormant — drop it so the walk below (and a
  // 2xx from it) can establish a session the CURRENT list endorses.
  tillRelayPin = null;
  const rest = list.filter((a) => a !== first);
  const walk = [first, ...rest];
  // Wave-2 pin guard: capture the list revision at walk entry; only a walk that FINISHES under
  // the same revision may pin. A stale walk (the operator re-pointed the list mid-walk) may
  // still complete its own call — its 2xx answer is a fact — but must not pin an address the
  // operator just removed: the pin outlives the call (every later till request goes to it
  // ALONE), so it may only ever name an address the CURRENT list endorses — and see the
  // membership rule above, which enforces the same bound from the other side every call.
  const walkRevision = relayAddressesRevision();
  let last: unknown;
  let answered: {r: Response; addr: string} | null = null;
  for (const addr of walk) {
    try {
      const r = await fetchWithTimeout(`${addr}${path}`, init, timeoutMs);
      if (r.ok) {
        if (relayAddressesRevision() === walkRevision) tillRelayPin = addr;
        return {r, addr};
      }
      if (r.status >= 500) {
        last = new Error(`HTTP ${r.status}`);
        continue;
      }
      // <500 non-2xx: an answer for THIS call, but NOT a pin (see the doc comment above).
      if (answered == null) answered = {r, addr};
    } catch (e) {
      // The CALLER's abort is not a transport failure (see relayFetch for the same rule).
      if (init?.signal?.aborted) throw e;
      last = e;
    }
  }
  if (answered != null) return answered;
  throw new TillUnreachable(walk, last instanceof Error ? last : new Error('all relay addresses failed for a till call'));
}

/**
 * `POST /api/v1/till` — ring up a charge on the merchant's own account.
 *
 * `decimals` is the till asset's precision, and it is here for one job: the answer's price is
 * converted back to raw units and checked against the cents that were signed, so a code that would
 * charge a different number than the cashier rang up is refused instead of displayed.
 */
export async function openTillCharge(
  relayUrl: string,
  identity: Identity,
  cents: string,
  decimals: number,
): Promise<TillOpenOutcome> {
  let body: Record<string, unknown>;
  try {
    body = await signedBody(identity, cents);
  } catch (e) {
    const detail = errText(e);
    console.warn(`till: could not sign a ring-up: ${detail}`);
    return {kind: 'unsigned', detail};
  }
  let r: Response;
  let addr: string;
  try {
    ({r, addr} = await tillFetch(
      relayUrl,
      '/api/v1/till',
      {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)},
      TILL_TIMEOUT_MS,
    ));
  } catch (e) {
    const detail = errText(e);
    const tried = e instanceof TillUnreachable ? e.tried : [base(relayUrl)];
    console.warn(`till: ring-up could not reach ${tried.join(', ')}: ${detail}`);
    return {kind: 'unreachable', detail, tried};
  }
  const json = await readJson(r);
  if (!r.ok) {
    // A 404 with no readable body is the route not being REGISTERED — this relay serves no till
    // (`DPAY_ENABLE_TILL`). Every real refusal from a live till carries the envelope and a sentence.
    if (r.status === 404 && said(json) === null) return {kind: 'not-served', addr};
    return {kind: 'refused', said: said(json), status: r.status};
  }
  if (typeof json !== 'object' || json === null) {
    return {kind: 'unreachable', detail: `ring-up answered HTTP ${r.status} with an unreadable body`, tried: [addr]};
  }
  const o = json as Record<string, unknown>;
  const id = str(o, 'id');
  const qr = str(o, 'qr');
  const amount = str(o, 'amount');
  // The reference is checked for its exact SHAPE, not merely for being present: it becomes the
  // memo of a transfer this app will build (see `TillCharge`), and a memo the relay cannot match is
  // money moved for a sale that stays open. 16 bytes of lowercase hex is what the till mints and
  // what `match_payment` compares against.
  const reference = str(o, 'reference');
  const createdSecs = whole(o, 'created_secs');
  const expiresAt = whole(o, 'expires_at');
  if (id === null || qr === null || amount === null || createdSecs === null || expiresAt === null
      || reference === null || !/^[0-9a-f]{32}$/.test(reference)) {
    const detail = `ring-up answered without {id, qr, amount, reference, created_secs, expires_at}: ${JSON.stringify(o).slice(0, 200)}`;
    console.warn(`till: ${detail}`);
    return {kind: 'unreachable', detail, tried: [addr]};
  }
  // THE PRICE CHECK. The till states its price as a decimal and means an integer number of raw
  // units; the cashier rang up cents. The charge is only honest when the two land on the same
  // integer.
  const quoted = parseDecimalToUnits(amount, decimals);
  if (!quoted.ok || quoted.raw !== tillRawUnits(cents, decimals)) {
    console.warn(`till: rang up ${cents} cents, the till answered "${amount}" — refusing to show it`);
    return {kind: 'mispriced', quoted: amount};
  }
  return {kind: 'open', charge: {id, cents, qr, reference, createdSecs, expiresAt}};
}

/** `GET /api/v1/till/{id}` — what the merchant's screen polls. The relay re-derives settlement from
 *  the merchant's own ledger history on every read, so this answer is the money and not a memory. */
export async function tillChargeStatus(relayUrl: string, id: string): Promise<TillStatusOutcome> {
  let r: Response;
  try {
    ({r} = await tillFetch(relayUrl, `/api/v1/till/${encodeURIComponent(id)}`, {}, TILL_TIMEOUT_MS));
  } catch (e) {
    const detail = errText(e);
    const where = e instanceof TillUnreachable ? e.tried.join(', ') : base(relayUrl);
    console.warn(`till: could not check charge ${id} at ${where}: ${detail}`);
    return {kind: 'unchecked', detail};
  }
  const json = await readJson(r);
  if (r.status === 404) return {kind: 'gone', said: said(json)};
  if (!r.ok) {
    const detail = `charge ${id} answered HTTP ${r.status}${said(json) ? `: ${said(json)}` : ''}`;
    console.warn(`till: ${detail}`);
    return {kind: 'unchecked', detail};
  }
  const status = parseStatus(json);
  if (status === null) {
    // The BODY is the whole diagnostic here — this branch is reached only on a 2xx whose JSON
    // parsed and then failed the shape check, so "unreadable" without it says nothing. The two
    // sibling parsers in this file both carry an excerpt; this one did not.
    const detail = `charge ${id} answered an unreadable status body`;
    console.warn(`till: ${detail}: ${JSON.stringify(json).slice(0, 200)}`);
    return {kind: 'unchecked', detail};
  }
  return {kind: 'status', status};
}

/** The relay's `ChargeStatus`, or null when any field this screen renders is missing or the wrong
 *  shape. Null is honest ignorance — the caller answers `unchecked` and keeps the charge live. */
function parseStatus(json: unknown): TillStatus | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  const id = str(o, 'id');
  const state = STATES.find(s => s === o.state) ?? null;
  const cents = whole(o, 'cents');
  const createdSecs = whole(o, 'created_secs');
  const expiresAt = whole(o, 'expires_at');
  if (id === null || state === null || cents === null || createdSecs === null || expiresAt === null) return null;
  return {id, state, cents: String(cents), createdSecs, expiresAt, paid: parseSettled(o.paid)};
}

/** The settlement half. A `paid` that is present but unreadable answers null — the state field
 *  already says `paid`, and the screen renders the sale without the block rather than inventing one. */
function parseSettled(value: unknown): TillSettled | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  const from = str(p, 'from');
  const amountRaw = str(p, 'amount_raw');
  const atSecs = whole(p, 'at_secs');
  const block = whole(p, 'block');
  if (from === null || amountRaw === null || atSecs === null || block === null) {
    console.warn(`till: a settlement was reported in a shape this build cannot read: ${JSON.stringify(p).slice(0, 200)}`);
    return null;
  }
  return {from, amountRaw, atSecs, block};
}

/** `POST /api/v1/till/void` — the cashier clears a mis-keyed total. The same signed shape as a
 *  ring-up with `cents = 0`, which is what stops a captured ring-up being replayed as one. */
export async function cancelTillCharge(relayUrl: string, identity: Identity): Promise<TillVoidOutcome> {
  let body: Record<string, unknown>;
  try {
    body = await signedBody(identity, '0');
  } catch (e) {
    const detail = errText(e);
    console.warn(`till: could not sign a cancellation: ${detail}`);
    return {kind: 'unsigned', detail};
  }
  let r: Response;
  let answeredBy: string;
  try {
    ({r, addr: answeredBy} = await tillFetch(
      relayUrl,
      '/api/v1/till/void',
      {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)},
      TILL_TIMEOUT_MS,
    ));
  } catch (e) {
    const detail = errText(e);
    const tried = e instanceof TillUnreachable ? e.tried : [base(relayUrl)];
    console.warn(`till: cancellation could not reach ${tried.join(', ')}: ${detail}`);
    return {kind: 'unreachable', detail, tried};
  }
  const json = await readJson(r);
  if (!r.ok) return {kind: 'refused', said: said(json), status: r.status};
  const status = parseStatus(json);
  if (status === null) {
    const detail = `cancellation answered HTTP ${r.status} with an unreadable status body`;
    console.warn(`till: ${detail}`);
    return {kind: 'unreachable', detail, tried: [answeredBy]};
  }
  return {kind: 'cancelled', status};
}
