import {describe, it, expect} from '@jest/globals';
import {readFileSync} from 'fs';
import {join} from 'path';
import {decodeLnurl, parseIcpUri, parseOcpScan, parsePaymentDetails, parseProviderInstant} from '../lib/opencryptopay';
import {parseDecimalToUnits} from '../lib/amount';
import {BUNDLED_NETWORKS, icpCatalogOf, ledgerToCurrency} from '../config/catalog';

// dpay's own till, read by dpay's own payer — the PAYER half of the `dfx/till_wire.json` golden,
// whose `_doc` says what that file is, why it has to be a file, and how each half reads it. Loaded
// at test time, like the catalog drift alarm in catalog.test.ts, so it is independent of any
// bundler config — the prod app has no JSON imports.
//
// What this suite adds that `opencryptopay.test.ts` cannot: those cases parse bodies recorded from
// DFX, so they pin the RULES. These parse the bytes dpay's own relay emits, so they pin the two
// sides against each other — the ledger the relay names against the one this app's catalog calls
// VCHF, the decimal the relay spells against the integer the relay means by it, the path the relay
// serves against the submission URL this app derives from it.
//
// It does NOT decide whether this till is payable from this app: whether VCHF — the only asset it
// serves — may be paid at all turns on WHO served it, and that rule is `selectPayableOffers`'
// business (`lib/opencryptopay.ts`, exercised in `opencryptopay.test.ts` and end to end by e2e flow
// 113). What is pinned here is the wire, on both sides of it.
const GOLDEN = JSON.parse(readFileSync(join(__dirname, '..', '..', 'dfx', 'till_wire.json'), 'utf8')) as {
  input: {merchant_name: string; note: string; host: string};
  amount_raw: string;
  open: {id: string; merchant: string; url: string; lnurl: string; qr: string; amount: string; reference: string; created_secs: number; expires_at: number};
  details: Record<string, unknown>;
  callback: {blockchain: string; expiryDate: string; uri: string};
};

/** The wallet's own IC rows — the bundled catalog it falls back to on a cold start. The relay's URI
 *  names a ledger; the payer only ever pays it through THIS list, so this is the list that decides
 *  which asset the relay actually asked for. */
const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);

describe('the dpay till’s wire, read by the dpay payer', () => {
  it('hands out a URL its own scanner recognises as a provider code, over https', () => {
    // The `url` the merchant's screen turns into a QR. It is admitted only because of its `/lnurlp/`
    // path segment (an https URL without one stays a payment link or a plain website), so the route
    // the relay serves this provider under is load-bearing on the payer side too.
    expect(parseOcpScan(GOLDEN.open.url)).toEqual({
      ok: true,
      apiUrl: GOLDEN.open.url,
      host: GOLDEN.input.host,
    });
  });

  it('decodes the bech32 code the relay minted back to the relay’s own endpoint', () => {
    // THE CROSS-LANGUAGE PROOF, and the reason the relay mints the LNURL rather than the screen
    // that renders it: this string was produced by `lnurl_of` in Rust
    // (`crates/dpay-relay/src/till.rs`) and is read here by the wallet's own hand-rolled bech32.
    // Two independent implementations of LUD-01, agreeing on a value neither of them wrote into
    // this file — a bare https endpoint is scannable by dpay and by nothing else, so getting this
    // wrong would ship a QR no wallet could use.
    expect(decodeLnurl(GOLDEN.open.lnurl)).toEqual({ok: true, url: GOLDEN.open.url});
    // Single-case, which is what makes the checksum well-defined at all — and uppercase, which is
    // what lets a QR encoder pick alphanumeric mode.
    expect(GOLDEN.open.lnurl).toBe(GOLDEN.open.lnurl.toUpperCase());

    // …and the QR string the merchant's screen actually renders is that code inside the wrapper a
    // generic phone camera opens as a web page. The scanner must reach the SAME endpoint from it,
    // through the `?lightning=` branch rather than the bare-URL one.
    expect(parseOcpScan(GOLDEN.open.qr)).toEqual({
      ok: true,
      apiUrl: GOLDEN.open.url,
      host: GOLDEN.input.host,
    });
  });

  it('states the charge’s own clock, so a cashier’s screen needs no copy of the till’s lifetime', () => {
    // Both instants are on the wire because the alternative is a copy of the relay's charge TTL
    // living in this app — the drift the golden exists to prevent. What is asserted HERE is only
    // that the pair is usable: two whole unix seconds, the deadline after the ring-up, so a
    // countdown is subtraction and nothing else. The VALUE of the gap is the relay's own rule and
    // is pinned there, against the relay's own constant — restating it here would be the second
    // copy this field removes.
    expect(Number.isInteger(GOLDEN.open.created_secs)).toBe(true);
    expect(Number.isInteger(GOLDEN.open.expires_at)).toBe(true);
    expect(GOLDEN.open.expires_at).toBeGreaterThan(GOLDEN.open.created_secs);
  });

  it('narrows the till’s payment details to the exact quote, price and deadline', () => {
    const parsed = parsePaymentDetails(GOLDEN.details);
    if (!parsed.ok) throw new Error(`the till’s own step-2 body must parse, got ${parsed.reason}`);
    const d = parsed.details;
    // The submission URL is DERIVED from the provider's callback by swapping `/cb/` for `/tx/`, and
    // what it must land on is the route the relay really serves (`crates/dpay-relay/src/app.rs`).
    // Composed from the golden's own host and link id so the only literal here is the standard's
    // path — which is the thing being asserted.
    expect(d.submitUrl).toBe(`https://${GOLDEN.input.host}/v1/lnurlp/tx/${GOLDEN.open.id}`);
    expect(d.callbackUrl).toBe(GOLDEN.details.callback);
    expect(d.proofHost).toBe(GOLDEN.input.host);
    expect(d.quoteId).toBe((GOLDEN.details.quote as {id: string}).id);
    expect(d.claimedMerchantName).toBe(GOLDEN.input.merchant_name);
    // What the charge is FOR, read from the body's OWN `note` field — never out of the LUD-06
    // metadata the relay folds the note into for wallets with no such field (that rendering is
    // the relay's, pinned on the relay side; this reader keeps one source). The literal pins the
    // wire itself: the golden must keep carrying the note the till was rung up with.
    expect(d.claimedNote).toBe(GOLDEN.input.note);
    expect(GOLDEN.input.note).toBe('2× Kafi, Tisch 4');
    // The till prices in francs and settles in VCHF, and the two are DIFFERENT numbers: the fiat
    // ask is the price the customer agreed to, while the settlement amount is that price less the
    // ledger fee the shop absorbs, so the customer's account moves by exactly CHF 10.00. Both
    // spellings survive the parse — the ask as a JSON number turned into an exact decimal string,
    // the settlement amount exactly as sent. Read from the golden rather than retyped: the relay
    // that recorded it is the one that owns the subtraction.
    expect(d.requestedAmount).toEqual({asset: 'CHF', amount: '10'});
    expect(d.transferAmounts).toEqual([
      {method: 'InternetComputer', available: true, assets: [{asset: 'VCHF', amount: GOLDEN.open.amount}]},
    ]);
    expect(GOLDEN.open.amount).toBe('9.9999');
    // The deadline is read as the exact UTC instant the relay wrote, not as device-local time. The
    // round trip proves both halves: the relay's spelling is one this reader accepts, and the
    // instant it accepts is the one the relay meant.
    expect(new Date(d.quoteExpiresAt).toISOString()).toBe((GOLDEN.details.quote as {expiration: string}).expiration);
    expect(parseProviderInstant(GOLDEN.callback.expiryDate)).not.toBeNull();
  });

  it('turns the till’s destination into the exact ledger, account and raw units it means', () => {
    const parsed = parseIcpUri(GOLDEN.callback.uri);
    if (!parsed.ok) throw new Error(`the till’s own step-3 URI must parse, got ${parsed.reason}`);
    // The account is the merchant's own, the same one their ring-up answer named. dpay holds no key
    // for it and never appears between the two.
    expect(parsed.to).toBe(GOLDEN.open.merchant);
    // The till's per-charge reference, which the payer carries as the transfer's ICRC-1 memo and
    // the till matches its history on. Read here as the 16-byte memo the app will actually sign:
    // if this parsed to null the payment would go out with a nonce of the wallet's own and the
    // sale would never be credited, with the money already gone.
    expect(parsed.ref).toMatch(/^[0-9a-f]{32}$/);
    // …and it is the SAME value the ring-up handed the merchant. This file holds both halves of the
    // recording, so it is the one place that can state it: a customer who scans the code and a
    // customer who taps the merchant's phone put the same memo on the ledger, because the merchant's
    // own tap request is built from `open.reference` (`components/TillCharge.tsx`). Two references
    // would mean one of those two customers pays and is never credited.
    expect(parsed.ref).toBe(GOLDEN.open.reference);
    // The instruction and the quote must be the same money — they are separate calls, and a payer
    // that signed the URI's amount against the quote's price would be paying an unquoted number.
    const quoted = (GOLDEN.details as {transferAmounts: {assets: {amount: string}[]}[]}).transferAmounts[0].assets[0];
    expect(parsed.amount).toBe(quoted.amount);
    // THE MONEY ASSERTION. The relay states the price as a decimal and means an integer number of
    // raw units; the payer converts that decimal at the precision ITS OWN catalog carries for the
    // ledger the relay named. A payment is correct exactly when the two land on the same integer.
    const row = CATALOG.find(c => c.currency === ledgerToCurrency(CATALOG, parsed.ledger));
    if (row === undefined || row.decimals === null) {
      throw new Error(`this wallet carries no precision for the ledger the till named (${parsed.ledger})`);
    }
    expect(parseDecimalToUnits(parsed.amount, row.decimals)).toEqual({ok: true, raw: GOLDEN.amount_raw});
  });

  it('resolves a swapped destination ledger to a different asset than the till quoted', () => {
    // The one redirect neither parser can see: `icp:<ledger>/transfer?…` is well-formed whichever
    // ledger it names, so a body that quoted VCHF and then instructed a payment on another ICRC
    // ledger parses perfectly and asks for a different asset. What catches it is the ledger→currency
    // lookup above, and this is that check with its teeth showing — against the relay's real URI and
    // against a real second ledger out of the same catalog.
    const honest = parseIcpUri(GOLDEN.callback.uri);
    if (!honest.ok) throw new Error(`the till’s own step-3 URI must parse, got ${honest.reason}`);
    const quoted = ledgerToCurrency(CATALOG, honest.ledger);
    expect(quoted).not.toBeNull();
    const other = CATALOG.find(c => c.currency !== quoted && c.ledger.length > 0);
    if (other === undefined) throw new Error('the bundled catalog must carry a second IC ledger');
    const swapped = parseIcpUri(GOLDEN.callback.uri.replace(honest.ledger, other.ledger));
    if (!swapped.ok) throw new Error(`a ledger swap must still parse, got ${swapped.reason}`);
    expect(ledgerToCurrency(CATALOG, swapped.ledger)).toBe(other.currency);
    expect(ledgerToCurrency(CATALOG, swapped.ledger)).not.toBe(quoted);
  });
});
