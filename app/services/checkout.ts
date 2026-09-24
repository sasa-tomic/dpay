// The MERCHANT half of dpay's own OpenCryptoPay checkout — the three routes only a shop calls.
//
// Everything else in this app PAYS a checkout (`services/opencryptopay.ts`, the payer's four provider
// reads). This module is the other side of the counter: open a charge, clear it, and watch it.
// The routes and every rule behind them are `crates/dpay-relay/src/checkout.rs`; nothing about the
// checkout's behaviour is restated here, only consumed.
//
// FOUR THINGS DECIDE THIS FILE.
//
// 1. **A CHARGE-OPEN IS SIGNED, and the signature is the merchant's claim on the money.** The checkout pays
//    the account DERIVED from `merchant_pubkey`, so naming a key is claiming an account. The core
//    signs the canonical bytes (`DpayCore.checkoutOpenSignature`, encoding pinned in
//    `dfx/checkout_open_signing.json`) over the merchant's OWN seed — this module never sees a
//    pubkey it did not derive from that seed, and the relay verifies before it opens anything.
//    A cancellation is the SAME shape with `cents = 0`, which is why one `signedBody` serves both:
//    neither signature is a valid instance of the other action.
//
// 2. **AN UNREADABLE ANSWER IS NEVER "UNPAID".** `chargeStatus` has exactly one outcome for "the
//    relay did not tell us" — `unchecked` — and the merchant's screen must render it as "can't
//    check", never as "waiting" and never as "nothing arrived". A cashier who is told a paid
//    customer has not paid hands over goods twice or accuses them; both are worse than saying the
//    checkout is out of contact. This is the same discipline the relay applies to its own ledger reads.
//
// 3. **MONEY IS INTEGER, END TO END.** A CHF price is parsed to whole cents by the exact BigInt
//    parser every amount field in this app already uses, signed as a decimal STRING, and turned
//    into raw ledger units by `checkoutRawUnits` — BigInt, never `parseFloat`, never `f64`. The one
//    place a JSON `number` is accepted is the wire's `cents` (the relay's field is a bare `u64`,
//    not the app's usual decimal string), and it is guarded by `Number.isSafeInteger` at both ends.
//
// 4. **THE PRICE THE CHECKOUT ANSWERS WITH IS CHECKED AGAINST THE PRICE THAT WAS OPENED.** A checkout-open
//    that comes back quoting a different amount than the cashier typed is refused as `mispriced`
//    rather than shown: the code would charge a customer a number nobody at the counter chose.
//
// WHERE THE WORDS COME FROM. Nothing here is a sentence for a screen. Outcomes carry the relay's
// OWN message (`said`, sanitised — it is the diagnosis, and the merchant repeats it to whoever runs
// the relay) and an English `detail` that may only ever reach `console.warn`. The localized framing
// around both is `M.receive.checkout.*`, chosen by the component: the app has four locales and no
// runtime fallback, so an English string returned from here is an English string a German cashier
// reads.
import {DpayCore} from './native';
import {fetchWithTimeout} from './relay';
import {relayAddresses, relayAddressesRevision} from './relayAddresses';
import {tokenEq, type SelectableAsset} from '../config/assets';
import {type CurrencyDescriptor} from '../config/catalog';
import {currencyOfCatalogRow, isStableCurrency} from '../config/currency';
import {parseDecimalToUnits} from '../lib/amount';
import {canonicalizeDecimal} from '../i18n/intl';
import {sanitiseDisplayText} from '../lib/deepLink';
import {base, nowSecs, randNonceHex} from '../lib/format';
import type {Identity} from '../lib/types';

/** The ONE method/asset pair dpay's checkout serves — `METHOD`/`ASSET` in `crates/dpay-relay/src/checkout.rs`.
 *  Spelled in the PROVIDER's vocabulary because that is what it is matched against: `offerNamesAsset`
 *  (`lib/opencryptopay.ts`) answers "does this provider row name that wallet asset?", and the
 *  merchant side asks the same question of the same pair rather than inventing a second rule.
 *  Pinned against the relay's real bytes by `app/__tests__/checkout.test.ts` via `dfx/checkout_wire.json`.
 *
 *  This is the PAYER-side pair (what a checkout code quotes, and what `services/opencryptopay.ts`
 *  resolves a provider offer with); it stays a fixed pair because the PAYER is told the asset by
 *  the code it scans. The MERCHANT side picks the settlement asset at open — see
 *  `checkoutSettlementRow` below. */
export const CHECKOUT_OFFER = {method: 'InternetComputer', asset: 'VCHF'} as const;

/** The price scale a checkout charge is typed at: two decimals, for EVERY currency a checkout can price —
 *  francs, dollars and euros all carry a minor unit of 1/100, so one parser serves all three and
 *  no asset outside a STABLE currency can be priced at all (a price settled in BTC or ICP would need
 *  an exchange rate, and dpay has none to quote — `checkoutSettlementRow`; the 2026-09-24 generalized
 *  main makes BTC/ETH/ICP/SOL wallet currencies, but a wallet currency is not thereby a checkout
 *  pricing unit). */
const PRICE_DECIMALS = 2;

/** What the cashier typed, as whole minor units (rappen/cents) of the settlement asset's own
 *  currency — or which rule it broke. Integer end to end: the same exact BigInt parser every other
 *  amount field in this app uses, at the currency's two decimals, so a price can never be wrong in
 *  the last digit. The input goes through `canonicalizeDecimal` first for the same reason every
 *  other amount field does: a decimal-pad renders a COMMA key on a German, French or Spanish
 *  device, and without the rewrite `10,50` would be refused as not-a-number — the checkout's entry
 *  price, untypeable across most of Europe. `too-precise` is told apart from `not-a-number`
 *  because they send the cashier to do different things (round the smallest coin vs type a
 *  number). */
export function priceCents(text: string): {ok: true; cents: string} | {ok: false; reason: 'too-precise' | 'not-a-number' | 'too-large'} {
  const parsed = parseDecimalToUnits(canonicalizeDecimal(text.trim()), PRICE_DECIMALS);
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

/** A charge as the checkout-open answered it. `cents` is what THIS device signed (the open response does
 *  not echo it), `qr` is the string that belongs in a QR — the `?lightning=` wrapper a generic
 *  phone camera opens as a web page — and the two instants are the charge's own clock, so the
 *  cashier's countdown needs no copy of the relay's lifetime constant.
 *
 *  `reference` is THIS CHARGE'S NAME ON THE LEDGER: the relay credits only a transfer whose ICRC-1
 *  memo carries it (`match_payment`, `crates/dpay-relay/src/checkout.rs`). A payer scanning the code
 *  learns it from the checkout's step-3 instruction; the MERCHANT learns it here, which is what lets
 *  this app collect the same sale over a channel the standard has no part in — an NFC tap, whose
 *  request nonce becomes that memo (`prepareNfcTransfer`, `services/rail.ts`). A tap built with any
 *  other nonce would move the customer's money and credit nothing. */
export type CheckoutCharge = {
  id: string;
  cents: string;
  qr: string;
  reference: string;
  createdSecs: number;
  expiresAt: number;
};

/** Where a charge stands, in the relay's own vocabulary (`ChargeState`). */
export type CheckoutChargeState = 'open' | 'paid' | 'superseded' | 'cancelled' | 'expired';

/** The settlement, as the relay OBSERVED it on the merchant's own ledger history. `block` is the
 *  row that paid — what the merchant's screen names, and the only stable identity a transfer has. */
export type CheckoutSettled = {from: string; amountRaw: string; atSecs: number; block: number};

/** A payer's CLAIM that they approved this shop to COLLECT the charge, rather than sending it.
 *  An ICRC-2 allowance wallet (Oisy) pays that way: it approves the shop as spender and reports its
 *  own principal, and only the shop's own device can spend the allowance. `PullClaim` in
 *  `crates/dpay-relay/src/checkout.rs` owns the trust model — including why a claim is never believed. */
export type CheckoutPullClaim = {payer: string; atSecs: number};

export type CheckoutStatus = {
  id: string;
  cents: string;
  state: CheckoutChargeState;
  createdSecs: number;
  expiresAt: number;
  paid: CheckoutSettled | null;
  pull: CheckoutPullClaim | null;
};

export type CheckoutOpenOutcome =
  | {kind: 'open'; charge: CheckoutCharge}
  /** The checkout answered with a price that is not the one that was opened. Nothing is shown. */
  | {kind: 'mispriced'; quoted: string}
  /** The checkout opened the charge in a DIFFERENT asset than the one the cashier picked — the relay
   *  serves what it serves, and this app does not present a charge that is not the one the counter
   *  rang up (a dollar pick served as a franc charge would be an exchange the shop never made).
   *  `served` names the asset the checkout DID open; the screen's fix is one tap on the picker. */
  | {kind: 'served-other'; served: string}
  /** The relay serves no checkout (`DPAY_ENABLE_CHECKOUT=false` — its routes are not registered, so the
   *  POST 404s with nothing to say; since 2026-09-10 that is an explicit operator refusal, not
   *  the default). A first-class state, not an error: this relay simply is not a
   *  checkout, and the merchant needs to hear that rather than "something went wrong". `addr` is the
   *  relay that ANSWERED — the sentence must name the relay actually asked, which under a walk or
   *  a pin need not be the caller's preferred URL. */
  | {kind: 'not-served'; addr: string}
  /** The checkout refused, and said why. `said` is its own sentence — the price bound, the clock skew,
   *  the reused nonce — every one of which already names the fix. */
  | {kind: 'refused'; said: string | null; status: number}
  /** The relay could not be reached at all. `tried` names the address(es) this call actually
   *  tried — the pin ALONE once a session is pinned to an address still in the configured list
   *  (a mid-session failure is a fact about that one relay), else every address of the walk —
   *  so the merchant's error never blames a relay that was not asked. */
  | {kind: 'unreachable'; detail: string; tried: string[]}
  /** This device could not produce the signature. Nothing was sent. */
  | {kind: 'unsigned'; detail: string};

export type CheckoutStatusOutcome =
  | {kind: 'status'; status: CheckoutStatus}
  /** The relay does not hold this charge (a restart, or a sweep). Nothing was credited HERE. */
  | {kind: 'gone'; said: string | null}
  /** WE DO NOT KNOW. Never "unpaid", never "still waiting" — see rule 2 in the module header. */
  | {kind: 'unchecked'; detail: string};

export type CheckoutVoidOutcome =
  | {kind: 'cancelled'; status: CheckoutStatus}
  /** Includes the one refusal that matters: the charge was already PAID, with the block that paid
   *  it named in `said`. Money moved, so nothing voids it. */
  | {kind: 'refused'; said: string | null; status: number}
  /** Same attribution as the open path's `unreachable`: the addresses actually asked — the pin
   *  ALONE once a session is pinned to an address still in the configured list, else the whole
   *  walk in order — so the "could NOT cancel" copy names who did not answer instead of blaming
   *  the caller's preferred URL. */
  | {kind: 'unreachable'; detail: string; tried: string[]}
  | {kind: 'unsigned'; detail: string};

/** What the cashier typed, as whole minor units (rappen/cents) of the settlement asset's own
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

/** The exact raw ledger units a CHF-cent price SETTLES for on the checkout's asset —
 *  `cents × 10^(d−2)`, less `feeRaw`, BigInt only.
 *
 *  THE FEE IS THE SHOP'S. An ICRC ledger always debits the sender the fee ON TOP of the amount and
 *  offers no way to charge the recipient, so the only way a customer's account can move by exactly
 *  the price is for the shop to quote the price minus that fee — which is what a card terminal does
 *  and what this checkout does (founder, 2026-09-12). The relay computes the same number from the same
 *  catalog fee (`Charge::amount_raw`, `crates/dpay-relay/src/checkout.rs`, which owns the reasoning);
 *  this is the app's own statement of it, and the two are held together by the checkout-open price check
 *  below — a relay that quoted anything else is refused rather than displayed.
 *
 *  The checkout prices 1:1 with the settlement asset's OWN currency — francs into VCHF, dollars into
 *  ckUSDC (`checkoutSettlementRow` admits no other shape) — so there is no rate anywhere and nothing to
 *  be wrong about. Throws on an asset whose precision cannot express the currency's smallest coin,
 *  and on a fee that would swallow the price: a wallet that formatted a charge it cannot
 *  represent, or one that asks for nothing, would be printing a lie. */
export function checkoutRawUnits(cents: string, decimals: number, feeRaw: string): string {
  if (!Number.isInteger(decimals) || decimals < PRICE_DECIMALS) {
    throw new Error(`checkout: an asset with ${decimals} decimals cannot express a ${PRICE_DECIMALS}-decimal price`);
  }
  let scale = 1n;
  for (let i = PRICE_DECIMALS; i < decimals; i++) scale *= 10n;
  const settles = BigInt(cents) * scale - BigInt(feeRaw);
  if (settles <= 0n) {
    throw new Error(`checkout: a ${cents}-rappen price does not cover the ${feeRaw}-unit ledger fee the shop pays`);
  }
  return settles.toString(10);
}

/**
 * The opened PRICE in raw units — the same scaling as `checkoutRawUnits` with NO fee netted out. This is
 * the GROSS the checkout's displays headline (founder rule 2026-09-14: both devices read the typed
 * price; the fee rides only the log row's annotation line). The wire (`checkoutRawUnits`) remains the
 * settlement truth everywhere money moves.
 */
export function checkoutPriceUnits(cents: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < PRICE_DECIMALS) {
    throw new Error(`checkout: an asset with ${decimals} decimals cannot express a ${PRICE_DECIMALS}-decimal price`);
  }
  let scale = 1n;
  for (let i = PRICE_DECIMALS; i < decimals; i++) scale *= 10n;
  return (BigInt(cents) * scale).toString(10);
}

/** The MERCHANT-side settlement SHAPE (multi-currency build-out, 2026-09): which wallet assets a
 *  checkout charge could ever be OPENED in, on the shape of the row alone. Three honest gates, each
 *  excluding a row for a stated reason:
 *   1. it settles on the Internet Computer — the checkout's method (`METHOD` in the relay's checkout.rs);
 *   2. it is a mainnet row — a charge real money settles is never opened against a testnet token;
 *   3. it settles a STABLE currency — francs, dollars or euros. The price is typed in the
 *      merchant's own currency and settles 1:1 into that currency's token; a charge priced in
 *      francs and settled in BTC or ICP would need an exchange rate, and dpay has none to quote
 *      and none may be added. No FX, ever, by construction. (The 2026-09-24 generalized main
 *      makes the token currencies wallet currencies — main-able, listable, balance-summed — but
 *      a 1/100-minor-unit pricing unit is exactly what they are not, so the gate names
 *      `isStableCurrency` explicitly.)
 * The PAYER side keeps the fixed `CHECKOUT_OFFER` pair above: the payer is TOLD the asset by the code
 * it scans, and never chooses. */
export function checkoutSettlementShape(asset: SelectableAsset, catalog: readonly CurrencyDescriptor[]): boolean {
  if (asset.protocol !== 'ic') return false;
  const row = catalog.find(c => c.currency === asset.currency);
  if (row == null || row.testnet) return false;
  if (row.decimals == null || row.decimals < PRICE_DECIMALS) return false;
  const currency = currencyOfCatalogRow(row);
  return currency !== null && isStableCurrency(currency);
}

/** The full settlement rule: the shape above AND a catalog row that STATES its ledger fee — the
 *  shop absorbs that fee out of the price (`checkoutRawUnits`), so a fee-less row has no honest price
 *  to quote (the same `checkoutFeeRaw != null` gate the counter's UI applies). This is the picker's
 *  rule; the shape alone gates the counter's entry so a fee-less row is told apart from a
 *  wrong-asset one (they send the merchant to different places). */
export function checkoutSettlementRow(asset: SelectableAsset, catalog: readonly CurrencyDescriptor[]): boolean {
  if (asset.protocol !== 'ic') return false;
  const row = catalog.find(c => c.currency === asset.currency);
  return row != null && row.fee != null && checkoutSettlementShape(asset, catalog);
}

/** Every asset the checkout may be opened in, in the wallet's own catalog order — the cashier's
 *  settlement picker, and empty exactly when this wallet can serve no checkout at all. */
export function checkoutSettlementAssets(assets: readonly SelectableAsset[], catalog: readonly CurrencyDescriptor[]): SelectableAsset[] {
  return assets.filter(a => checkoutSettlementRow(a, catalog));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Read a checkout answer as JSON. Never throws and never substitutes a default: `null` means the body
 *  was unreadable, which is a state each caller has to decide about (an empty 404 is a relay that
 *  serves no checkout; an unreadable poll is `unchecked`). Logged, because a silent unreadable body is
 *  a debugging dead end. */
async function readJson(r: Response): Promise<unknown | null> {
  try {
    return await r.json();
  } catch (e) {
    console.warn(`checkout: HTTP ${r.status} body was not JSON: ${errText(e)}`);
    return null;
  }
}

/** The relay's error envelope is NestJS's `{statusCode, message, error}` — the shape its checkout
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

const STATES: readonly CheckoutChargeState[] = ['open', 'paid', 'superseded', 'cancelled', 'expired'];

/** The merchant's signed request — a checkout-open (`cents ≥ 1`) or a cancellation (`cents = 0`), told
 *  apart by the SIGNED price and by nothing else. `note` is what the charge is for, and it rides
 *  the SIGNATURE, not just the body: an unsigned field inside a signed request is one the relay
 *  cannot attribute, and this text is payer-read on review. Trimmed empty — the cashier typed
 *  nothing but whitespace — signs the legacy note-less v1 bytes and OMITS the wire key, so a
 *  note-less checkout-open is byte-for-byte the request every older app sends; anything else signs under
 *  the v2 tag and crosses as the trimmed text, one spelling of it everywhere. Throws when the core
 *  cannot sign, which every caller turns into `unsigned`: an unsigned request is one the relay
 *  would refuse anyway, and sending it would burn a nonce for nothing. */
async function signedBody(identity: Identity, cents: string, note: string): Promise<Record<string, unknown>> {
  const centsNum = Number(cents);
  if (!Number.isSafeInteger(centsNum)) {
    throw new Error(`checkout: ${cents} cents cannot cross the wire exactly (the field is a JSON number)`);
  }
  const trimmed = note.trim();
  const nonce = randNonceHex();
  const issuedAt = nowSecs();
  const signature = await DpayCore.checkoutOpenSignature(identity.secretHex, cents, nonce, issuedAt, identity.username, trimmed);
  const body: Record<string, unknown> = {
    merchant_pubkey: identity.publicHex,
    merchant_name: identity.username,
    cents: centsNum,
    nonce,
    issued_at: issuedAt,
    signature,
  };
  if (trimmed !== '') body.note = trimmed;
  return body;
}

/** How long a merchant route may take. Generous next to a balance poll because a checkout-open is a
 *  person standing at a counter waiting to be told a number is live, and short next to the
 *  submission budget on the payer side — nothing here has moved any money yet, so giving up early
 *  costs a retry rather than a payment. */
const CHECKOUT_TIMEOUT_MS = 15000;

// R1 — the checkout's ONE deliberate exception to multi-address selection (spec 2026-09-09
// §"Direction 2"): a checkout charge is RELAY-HELD, session-affine state. The charge id, its expiry
// and its settlement live on the relay that opened it, so the checkout client resolves ONE relay per
// session — the first address that answers — and stays there even if that address later fails:
// a mid-session failover would ask a replica that never heard of the charge and hand the cashier
// "not found" for a charge that is open elsewhere. The pin is bounded by MEMBERSHIP, not by
// eternity: it speaks for the session only while the configured list still carries its address
// (a reorder keeps it; a removal kills it — see `checkoutFetch`). Every other relay surface
// multi-homes through `services/relay.ts#relayFetch` instead.
let checkoutRelayPin: string | null = null;

/** The relay this session's checkout is pinned to, if any (diagnostics + tests). */
export function checkoutSessionRelay(): string | null {
  return checkoutRelayPin;
}

/** Test seam: forget the pin (the pin's own clock is the session; only tests shorten it). */
export function resetCheckoutRelayPinForTest(): void {
  checkoutRelayPin = null;
}

/** The addresses a failed checkout call ACTUALLY tried — the pin ALONE once a session is pinned to
 *  an address the configured list still carries (a mid-session failure is a fact about that one
 *  relay), else every address of the walk in order. Carried on `CheckoutOpenOutcome.unreachable.tried`
 *  and the warn lines so a failure is attributed to the relay(s) that did not answer, never to
 *  the caller's preferred URL by default. */
class CheckoutUnreachable extends Error {
  readonly tried: string[];
  constructor(tried: string[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CheckoutUnreachable';
    this.tried = tried;
  }
}

/**
 * The checkout's ordered walk — `relayFetch`'s shape WITHOUT the build gate, and with the pin above:
 * while unpinned it tries [the caller's relay, ...the operator list] in order; ONLY an OK (2xx)
 * answer pins — a checkout charge is relay-held state, so only a relay that can actually hold one
 * earns the session. A <500 non-2xx (a non-checkout relay's 404, a live checkout's 4xx refusal) is
 * remembered as the walk's answer but does NOT pin: the walk keeps looking for a 2xx further
 * down, and the next charge retries the walk, so a non-checkout relay sitting early in the list can
 * never hide a working checkout behind it. Once pinned, every call goes to the pin ALONE — ignoring
 * the caller's relay argument — for exactly as long as the configured list still carries the
 * pinned address (exact equality under the same `base` normalization the walk composes with): a
 * list edit that REMOVED the address kills the pin, and the call becomes the normal walk over
 * the new list, so a merchant who removes an address is never left with a shadow connection the
 * app keeps asking behind their back. At walk end the remembered <500 answer wins over the
 * synthetic all-dead error (a relay refusing to serve is a fact the cashier should hear);
 * otherwise the throw is `CheckoutUnreachable`, naming every address tried.
 */
async function checkoutFetch(relayUrl: string, path: string, init: RequestInit, timeoutMs: number): Promise<{r: Response; addr: string}> {
  const first = base(relayUrl);
  const list = relayAddresses().map((a) => base(a));
  if (checkoutRelayPin != null && list.includes(checkoutRelayPin)) {
    try {
      return {r: await fetchWithTimeout(`${checkoutRelayPin}${path}`, init, timeoutMs), addr: checkoutRelayPin};
    } catch (e) {
      // The CALLER's abort is not a transport failure (see relayFetch for the same rule).
      if (init?.signal?.aborted) throw e;
      throw new CheckoutUnreachable([checkoutRelayPin], e);
    }
  }
  // A pin whose address left the list is DEAD, not dormant — drop it so the walk below (and a
  // 2xx from it) can establish a session the CURRENT list endorses.
  checkoutRelayPin = null;
  const rest = list.filter((a) => a !== first);
  const walk = [first, ...rest];
  // Wave-2 pin guard: capture the list revision at walk entry; only a walk that FINISHES under
  // the same revision may pin. A stale walk (the operator re-pointed the list mid-walk) may
  // still complete its own call — its 2xx answer is a fact — but must not pin an address the
  // operator just removed: the pin outlives the call (every later checkout request goes to it
  // ALONE), so it may only ever name an address the CURRENT list endorses — and see the
  // membership rule above, which enforces the same bound from the other side every call.
  const walkRevision = relayAddressesRevision();
  let last: unknown;
  let answered: {r: Response; addr: string} | null = null;
  for (const addr of walk) {
    try {
      const r = await fetchWithTimeout(`${addr}${path}`, init, timeoutMs);
      if (r.ok) {
        if (relayAddressesRevision() === walkRevision) checkoutRelayPin = addr;
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
  throw new CheckoutUnreachable(walk, last instanceof Error ? last : new Error('all relay addresses failed for a checkout call'));
}

/**
 * `POST /api/v1/checkout` — open a charge on the merchant's own account.
 *
 * `decimals` and `feeRaw` are the checkout asset's precision and its ledger's transfer fee, and they
 *  are here for one job: the answer's price is converted back to raw units and checked against what
 *  the cents that were signed SHOULD settle for, so a code that would charge a customer a number
 *  nobody at the counter chose is refused instead of displayed. Both come from the catalog row the
 *  relay itself serves, which is what makes the check meaningful rather than circular.
 *
 * `settleToken` is the asset the cashier PICKED (`checkoutSettlementRow`): the answer names the asset
 *  it actually opened (`asset` on the wire), and a mismatch is refused whole — a dollar pick shown
 *  as a franc charge would be an exchange nobody at the counter made. The pick deliberately does
 *  NOT ride the request body: the checkout-open's signed bytes are pinned (`dfx/checkout_open_signing.json`)
 *  and an unsigned field inside a signed request is one the relay cannot attribute — the day the
 *  relay serves more than its own pair, the asset enters the signature, and until then the answer
 *  check fails this client closed.
 *
 * `note` is what the charge is for, already the cashier's raw typing: trimmed here, and empty
 * treated as absent (see `signedBody`).
 */
export async function openCheckoutCharge(
  relayUrl: string,
  identity: Identity,
  cents: string,
  decimals: number,
  feeRaw: string,
  note: string,
  settleToken: string,
): Promise<CheckoutOpenOutcome> {
  let body: Record<string, unknown>;
  try {
    body = await signedBody(identity, cents, note);
  } catch (e) {
    const detail = errText(e);
    console.warn(`checkout: could not sign a checkout-open: ${detail}`);
    return {kind: 'unsigned', detail};
  }
  let r: Response;
  let addr: string;
  try {
    ({r, addr} = await checkoutFetch(
      relayUrl,
      '/api/v1/checkout',
      {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)},
      CHECKOUT_TIMEOUT_MS,
    ));
  } catch (e) {
    const detail = errText(e);
    const tried = e instanceof CheckoutUnreachable ? e.tried : [base(relayUrl)];
    console.warn(`checkout: checkout-open could not reach ${tried.join(', ')}: ${detail}`);
    return {kind: 'unreachable', detail, tried};
  }
  const json = await readJson(r);
  if (!r.ok) {
    // A 404 with no readable body is the route not being REGISTERED — this relay serves no checkout
    // (`DPAY_ENABLE_CHECKOUT=false`). Every real refusal from a live checkout carries the envelope and a sentence.
    if (r.status === 404 && said(json) === null) return {kind: 'not-served', addr};
    return {kind: 'refused', said: said(json), status: r.status};
  }
  if (typeof json !== 'object' || json === null) {
    return {kind: 'unreachable', detail: `checkout-open answered HTTP ${r.status} with an unreadable body`, tried: [addr]};
  }
  const o = json as Record<string, unknown>;
  const id = str(o, 'id');
  const qr = str(o, 'qr');
  const amount = str(o, 'amount');
  // The reference is checked for its exact SHAPE, not merely for being present: it becomes the
  // memo of a transfer this app will build (see `CheckoutCharge`), and a memo the relay cannot match is
  // money moved for a sale that stays open. 16 bytes of lowercase hex is what the checkout mints and
  // what `match_payment` compares against.
  const reference = str(o, 'reference');
  const createdSecs = whole(o, 'created_secs');
  const expiresAt = whole(o, 'expires_at');
  if (id === null || qr === null || amount === null || createdSecs === null || expiresAt === null
      || reference === null || !/^[0-9a-f]{32}$/.test(reference)) {
    const detail = `checkout-open answered without {id, qr, amount, reference, created_secs, expires_at}: ${JSON.stringify(o).slice(0, 200)}`;
    console.warn(`checkout: ${detail}`);
    return {kind: 'unreachable', detail, tried: [addr]};
  }
  // THE ASSET CHECK. The answer names the asset it opened the charge in (`asset`, the relay's own
  // `ASSET` constant on the wire). When it names something other than the asset the cashier
  // picked, the charge is refused WHOLE: presenting a dollar pick as a franc charge would be an
  // exchange nobody at the counter made. Absent — an older checkout recording that predates the
  // field — no claim is made either way, and the price check below still pins the amount at the
  // picked asset's own scale.
  const served = str(o, 'asset');
  if (served !== null && !tokenEq(served, settleToken)) {
    console.warn(`checkout: picked ${settleToken}, the checkout answered "${served}" — refusing to show it`);
    return {kind: 'served-other', served};
  }
  // THE PRICE CHECK. The checkout states its price as a decimal and means an integer number of raw
  // units; the cashier rang up cents. The charge is only honest when the two land on the same
  // integer.
  const quoted = parseDecimalToUnits(amount, decimals);
  if (!quoted.ok || quoted.raw !== checkoutRawUnits(cents, decimals, feeRaw)) {
    console.warn(`checkout: rang up ${cents} cents, the checkout answered "${amount}" — refusing to show it`);
    return {kind: 'mispriced', quoted: amount};
  }
  return {kind: 'open', charge: {id, cents, qr, reference, createdSecs, expiresAt}};
}

/** `GET /api/v1/checkout/{id}` — what the merchant's screen polls. The relay re-derives settlement from
 *  the merchant's own ledger history on every read, so this answer is the money and not a memory. */
export async function checkoutChargeStatus(relayUrl: string, id: string): Promise<CheckoutStatusOutcome> {
  let r: Response;
  try {
    ({r} = await checkoutFetch(relayUrl, `/api/v1/checkout/${encodeURIComponent(id)}`, {}, CHECKOUT_TIMEOUT_MS));
  } catch (e) {
    const detail = errText(e);
    const where = e instanceof CheckoutUnreachable ? e.tried.join(', ') : base(relayUrl);
    console.warn(`checkout: could not check charge ${id} at ${where}: ${detail}`);
    return {kind: 'unchecked', detail};
  }
  const json = await readJson(r);
  if (r.status === 404) return {kind: 'gone', said: said(json)};
  if (!r.ok) {
    const detail = `charge ${id} answered HTTP ${r.status}${said(json) ? `: ${said(json)}` : ''}`;
    console.warn(`checkout: ${detail}`);
    return {kind: 'unchecked', detail};
  }
  const status = parseStatus(json);
  if (status === null) {
    // The BODY is the whole diagnostic here — this branch is reached only on a 2xx whose JSON
    // parsed and then failed the shape check, so "unreadable" without it says nothing. The two
    // sibling parsers in this file both carry an excerpt; this one did not.
    const detail = `charge ${id} answered an unreadable status body`;
    console.warn(`checkout: ${detail}: ${JSON.stringify(json).slice(0, 200)}`);
    return {kind: 'unchecked', detail};
  }
  return {kind: 'status', status};
}

/** The relay's `ChargeStatus`, or null when any field this screen renders is missing or the wrong
 *  shape. Null is honest ignorance — the caller answers `unchecked` and keeps the charge live. */
function parseStatus(json: unknown): CheckoutStatus | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  const id = str(o, 'id');
  const state = STATES.find(s => s === o.state) ?? null;
  const cents = whole(o, 'cents');
  const createdSecs = whole(o, 'created_secs');
  const expiresAt = whole(o, 'expires_at');
  if (id === null || state === null || cents === null || createdSecs === null || expiresAt === null) return null;
  return {id, state, cents: String(cents), createdSecs, expiresAt, paid: parseSettled(o.paid), pull: parsePull(o.pull)};
}

/** A pull claim, or null when there is none — which is the common case and not an error: a payer
 *  who simply sent the money never claims anything. A claim that is PRESENT but unreadable answers
 *  null too, and says so: acting on half of one would build a collection against a principal this
 *  build could not parse. */
function parsePull(value: unknown): CheckoutPullClaim | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const payer = str(p, 'payer');
  const atSecs = whole(p, 'at_secs');
  if (payer === null || atSecs === null) {
    console.warn(`checkout: a pull claim arrived in a shape this build cannot read: ${JSON.stringify(p).slice(0, 200)}`);
    return null;
  }
  return {payer, atSecs};
}

/** The settlement half. A `paid` that is present but unreadable answers null — the state field
 *  already says `paid`, and the screen renders the sale without the block rather than inventing one. */
function parseSettled(value: unknown): CheckoutSettled | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  const from = str(p, 'from');
  const amountRaw = str(p, 'amount_raw');
  const atSecs = whole(p, 'at_secs');
  const block = whole(p, 'block');
  if (from === null || amountRaw === null || atSecs === null || block === null) {
    console.warn(`checkout: a settlement was reported in a shape this build cannot read: ${JSON.stringify(p).slice(0, 200)}`);
    return null;
  }
  return {from, amountRaw, atSecs, block};
}

/** `POST /api/v1/checkout/void` — the cashier clears a mis-keyed total. The same signed shape as a
 *  checkout-open with `cents = 0`, which is what stops a captured checkout-open being replayed as one. */
export async function cancelCheckoutCharge(relayUrl: string, identity: Identity): Promise<CheckoutVoidOutcome> {
  let body: Record<string, unknown>;
  try {
    body = await signedBody(identity, '0', '');
  } catch (e) {
    const detail = errText(e);
    console.warn(`checkout: could not sign a cancellation: ${detail}`);
    return {kind: 'unsigned', detail};
  }
  let r: Response;
  let answeredBy: string;
  try {
    ({r, addr: answeredBy} = await checkoutFetch(
      relayUrl,
      '/api/v1/checkout/void',
      {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)},
      CHECKOUT_TIMEOUT_MS,
    ));
  } catch (e) {
    const detail = errText(e);
    const tried = e instanceof CheckoutUnreachable ? e.tried : [base(relayUrl)];
    console.warn(`checkout: cancellation could not reach ${tried.join(', ')}: ${detail}`);
    return {kind: 'unreachable', detail, tried};
  }
  const json = await readJson(r);
  if (!r.ok) return {kind: 'refused', said: said(json), status: r.status};
  const status = parseStatus(json);
  if (status === null) {
    const detail = `cancellation answered HTTP ${r.status} with an unreadable status body`;
    console.warn(`checkout: ${detail}`);
    return {kind: 'unreachable', detail, tried: [answeredBy]};
  }
  return {kind: 'cancelled', status};
}
