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
 *  cashier's countdown needs no copy of the relay's lifetime constant. */
export type TillCharge = {
  id: string;
  cents: string;
  qr: string;
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
   *  till, and the merchant needs to hear that rather than "something went wrong". */
  | {kind: 'not-served'}
  /** The till refused, and said why. `said` is its own sentence — the price bound, the clock skew,
   *  the reused nonce — every one of which already names the fix. */
  | {kind: 'refused'; said: string | null; status: number}
  /** The relay could not be reached at all. */
  | {kind: 'unreachable'; detail: string}
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
  | {kind: 'unreachable'; detail: string}
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
  try {
    r = await fetchWithTimeout(
      `${base(relayUrl)}/api/v1/till`,
      {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)},
      TILL_TIMEOUT_MS,
    );
  } catch (e) {
    const detail = errText(e);
    console.warn(`till: ring-up could not reach ${relayUrl}: ${detail}`);
    return {kind: 'unreachable', detail};
  }
  const json = await readJson(r);
  if (!r.ok) {
    // A 404 with no readable body is the route not being REGISTERED — this relay serves no till
    // (`DPAY_ENABLE_TILL`). Every real refusal from a live till carries the envelope and a sentence.
    if (r.status === 404 && said(json) === null) return {kind: 'not-served'};
    return {kind: 'refused', said: said(json), status: r.status};
  }
  if (typeof json !== 'object' || json === null) {
    return {kind: 'unreachable', detail: `ring-up answered HTTP ${r.status} with an unreadable body`};
  }
  const o = json as Record<string, unknown>;
  const id = str(o, 'id');
  const qr = str(o, 'qr');
  const amount = str(o, 'amount');
  const createdSecs = whole(o, 'created_secs');
  const expiresAt = whole(o, 'expires_at');
  if (id === null || qr === null || amount === null || createdSecs === null || expiresAt === null) {
    const detail = `ring-up answered without {id, qr, amount, created_secs, expires_at}: ${JSON.stringify(o).slice(0, 200)}`;
    console.warn(`till: ${detail}`);
    return {kind: 'unreachable', detail};
  }
  // THE PRICE CHECK. The till states its price as a decimal and means an integer number of raw
  // units; the cashier rang up cents. The charge is only honest when the two land on the same
  // integer.
  const quoted = parseDecimalToUnits(amount, decimals);
  if (!quoted.ok || quoted.raw !== tillRawUnits(cents, decimals)) {
    console.warn(`till: rang up ${cents} cents, the till answered "${amount}" — refusing to show it`);
    return {kind: 'mispriced', quoted: amount};
  }
  return {kind: 'open', charge: {id, cents, qr, createdSecs, expiresAt}};
}

/** `GET /api/v1/till/{id}` — what the merchant's screen polls. The relay re-derives settlement from
 *  the merchant's own ledger history on every read, so this answer is the money and not a memory. */
export async function tillChargeStatus(relayUrl: string, id: string): Promise<TillStatusOutcome> {
  let r: Response;
  try {
    r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/till/${encodeURIComponent(id)}`, undefined, TILL_TIMEOUT_MS);
  } catch (e) {
    const detail = errText(e);
    console.warn(`till: could not check charge ${id}: ${detail}`);
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
    const detail = `charge ${id} answered an unreadable status body`;
    console.warn(`till: ${detail}`);
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
  try {
    r = await fetchWithTimeout(
      `${base(relayUrl)}/api/v1/till/void`,
      {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)},
      TILL_TIMEOUT_MS,
    );
  } catch (e) {
    const detail = errText(e);
    console.warn(`till: cancellation could not reach ${relayUrl}: ${detail}`);
    return {kind: 'unreachable', detail};
  }
  const json = await readJson(r);
  if (!r.ok) return {kind: 'refused', said: said(json), status: r.status};
  const status = parseStatus(json);
  if (status === null) {
    const detail = `cancellation answered HTTP ${r.status} with an unreadable status body`;
    console.warn(`till: ${detail}`);
    return {kind: 'unreachable', detail};
  }
  return {kind: 'cancelled', status};
}
