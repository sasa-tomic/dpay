/**
 * Flow 114 — the jest twin of `e2e/tests/114-checkout-open.mjs` (the MERCHANT side of dpay's
 * checkout: open a charge on the counter, and the screen flips when the RELAY sees the money).
 *
 * The shop opens a CHF 10.50 charge with the shared message box's note riding the checkout-open as
 * the signed note; the code shows the franc price, what the shop receives, and the honest waiting
 * line (never a scan claim); the toggles hide while a charge is live. The customer (a harness
 * keypair) resolves the checkout's own payer routes and settles the exact netted amount carrying
 * the per-charge ref; the screen reports the sale with the ledger row, the shop is credited the
 * price less the fee it absorbs, the customer moves by exactly the price — and "Next customer"
 * keeps the shared note.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assert, assertEq, assertIncludes, faucetAccount, generateKeypair, getBalance,
  onboardWallet, openBalances, railPrincipalText, railTransfer, selectCurrency,
} from '../harness/lib';

const VCHF = 7; // the ONE asset a dpay checkout takes
const PRICE = '10.50';
const PRICE_RAW = 1_050_000_000; // 1050 rappen × 10^(8−2)
const FEE = 10_000; // the VCHF catalog fee the shop absorbs
const PAY_RAW = PRICE_RAW - FEE;
const PAYER_SEED = 2_000_000_000;
const NOTE = '2x Kafi, Tisch 4';

/** Record every /api/v1/checkout open (request body + answer) the app sends. */
function observeCheckoutOpens(): {opens(): Array<{body: {note?: string} | null; answer: {asset: string; merchant: string; id: string}}>; restore: () => void} {
  const opens: Array<{body: {note?: string} | null; answer: {asset: string; merchant: string; id: string}}> = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await prev(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/api\/v1\/checkout$/.test(url) && response.ok) {
      let body: {note?: string} | null = null;
      try {
        body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      } catch {
        body = {unparsed: String(init?.body)} as unknown as null;
      }
      opens.push({body, answer: (await response.clone().json()) as {asset: string; merchant: string; id: string}});
    }
    return response;
  }) as typeof fetch;
  return {opens: () => opens, restore: () => { globalThis.fetch = prev; }};
}

/** Walk the checkout's OWN payer routes for the charge: quote → transfer instruction. */
async function resolveCharge(relayBaseURL: string, id: string): Promise<{to: string; amount: string; ref: string; displayName: string}> {
  const fetchJson = async (url: string): Promise<Record<string, unknown>> => {
    const r = await fetch(url);
    const text = await r.text();
    if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const details = await fetchJson(`${relayBaseURL}/v1/lnurlp/${id}?timeout=0`);
  const quote = (details?.quote as {id?: string} | undefined)?.id;
  assert(typeof quote === 'string' && quote.length > 0, 'the checkout must mint a quote');
  const callback = `${details.callback as string}?quote=${encodeURIComponent(quote)}&method=InternetComputer&asset=VCHF`;
  const instruction = await fetchJson(callback);
  const uri = (instruction?.uri as string) ?? '';
  const to = /[?&]to=([^&]+)/.exec(uri)?.[1] ?? null;
  const amount = /[?&]amount=([^&]+)/.exec(uri)?.[1] ?? null;
  const ref = /[?&]ref=([0-9a-f]{32})/.exec(uri)?.[1] ?? null;
  assert(to !== null && amount !== null && ref !== null, `the step-3 URI must name to/amount/ref, got "${uri}"`);
  return {to, amount, ref, displayName: details.displayName as string};
}

describe('flow 114 — checkout open: the counter sells, the relay sees the money, the screen flips', () => {
  it('opens the charge with the signed note; the customer pays; the shop’s screen reports the sale', async () => {
    // The shop, in the app.
    const m = await onboardWallet('Bahnhof Kiosk');
    const merchant = (await accountOf(m))!;
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    // The customer: an independent key, funded on VCHF only. Nothing about them is in the app.
    const payer = await generateKeypair();
    const funded = await faucetAccount(payer.publicHex, PAYER_SEED, {currency: VCHF});
    assert(funded.ok, `the customer must be funded in VCHF, got ${funded.status}`);
    expect(await getBalance(merchant.publicHex, VCHF)).toBe('0');

    // --- the counter -------------------------------------------------------------------------
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    // The checkout code is a CHECKBOX beside the shared amount row — not a third tab.
    expect(m.driver.isPresent('receive-code-form')).toBe(true);
    const observer = observeCheckoutOpens();
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000});

    // ONE message box, both code forms (founder 2026-09-14): the text survives the toggle both ways.
    await m.driver.type('memo-input', NOTE, {timeoutMs: 4000});
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000});
    expect(m.driver.isPresent('memo-input')).toBe(true);
    assertEq(m.driver.readInputValue('memo-input'), NOTE, 'the text survives unchecking');
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000});
    expect(m.driver.isPresent('memo-input')).toBe(true);
    assertEq(m.driver.readInputValue('memo-input'), NOTE, 'the text survives checking again');

    await m.driver.type('amount-input', PRICE, {timeoutMs: 4000});
    await m.driver.click('btn-checkout-open', {timeoutMs: 4000});

    await m.driver.findByTestID('checkout-qr', {timeoutMs: 15_000});
    const shown = m.driver.bodyText();
    assertIncludes(shown, '10.50 CHF', 'the cashier reads the franc price back');
    assertIncludes(shown, '10.4999 VCHF', 'and what the SHOP receives, the price less the fee it absorbs');
    assertIncludes(shown, 'Waiting for the payment', 'the honest waiting line');
    expect(shown).not.toMatch(/scanned/i); // no status route → the screen may never imply one
    await m.driver.waitGone('receive-code-form', {timeoutMs: 4000}); // the checkbox hides while live
    expect(m.driver.isPresent('receive-code-form')).toBe(false);
    await m.driver.waitGone('receive-mode-toggle', {timeoutMs: 4000});

    // What the relay actually opened: one open, the shared note riding it as the signed `note`.
    const opens = observer.opens();
    assertEq(opens.length, 1, 'exactly one checkout-open was sent');
    assertEq(opens[0].body?.note, NOTE, 'the shared message box’s text rides the open as the signed note');
    const open = opens[0].answer;
    assertEq(open.asset, 'VCHF', 'a dpay checkout quotes VCHF and nothing else');
    assertEq(open.merchant, merchantPrincipal, 'the charge is opened on the shop’s own account (no custody)');
    expect(open.id).toMatch(/^pl_[0-9a-f]{16}$/);
    observer.restore();

    // --- the customer pays it, through the checkout's own routes ---------------------------------
    const instruction = await resolveCharge(process.env.DPAY_JEST_RELAY_URL as string, open.id);
    assertEq(instruction.to, merchantPrincipal, 'the instruction names the shop’s own account');
    assertEq(instruction.amount, '10.4999', 'the checkout instructs the settlement amount, never the price');
    assertEq(instruction.displayName, 'Bahnhof Kiosk', 'the checkout carries the shop’s claimed name');
    const paid = await railTransfer(payer.secretHex, merchant.publicHex, PAY_RAW, {currency: VCHF, memoHex: instruction.ref});
    assert(paid.ok, `the customer's transfer must be accepted, got ${paid.status}: ${paid.bodyText.slice(0, 200)}`);

    // --- the screen flips because the RELAY saw the money -----------------------------------------
    assert(await m.driver.waitForText('Paid 10.50 CHF', {timeoutMs: 30_000}), 'the screen reports the sale');
    const settled = m.driver.bodyText();
    assertIncludes(settled, 'Ledger block', 'the sale names the ledger row that paid it');
    expect(settled).not.toMatch(/expired/i); // paid inside the code’s life — not late

    // The money is really there, exactly per the founder rule (the price moved the customer).
    assertEq(await getBalance(merchant.publicHex, VCHF), String(PAY_RAW), 'the shop was credited the price less the fee');
    assertEq(await getBalance(payer.publicHex, VCHF), String(PAYER_SEED - PRICE_RAW), 'the customer was debited the price, not a unit more');

    // --- back to an empty counter -------------------------------------------------------------------
    await m.driver.click('btn-checkout-new', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-checkout-open', {timeoutMs: 4000});
    await m.driver.findByTestID('receive-code-form', {timeoutMs: 4000});
    expect(m.driver.isPresent('receive-code-form')).toBe(true);
    assertEq(m.driver.readInputValue('memo-input'), NOTE, 'the shared message box keeps its text for the next customer');

    await m.unmount();
  }, 180_000);
});
