/**
 * Flow 117 checkout-tap — the jest twin of `e2e/tests/117-checkout-tap.mjs` (batch D port).
 * A dpay payer TAPS a dpay checkout, and the shop's own charge is credited: the counter arms the
 * NFC reader FROM the charge (its own account, the raw VCHF price less the fee the shop absorbs,
 * the CHARGE's reference as the request nonce), the payer's offline-signed bundle — delivered over
 * the session seam, as flows 86/87 deliver theirs — settles a real icrc1_transfer whose ICRC-1
 * memo is therefore the reference, and `GET /api/v1/checkout/{id}` (which re-derives settlement
 * from the merchant's ledger history, knowing nothing about taps) flips to paid and names the row.
 *
 * WHAT IS REAL: the checkout-open signature (the app's own core), the relay checkout routes, the
 * reader request (DpayCore.buildRequestHex), the signed transfer, the ledger. WHAT IS NOT: the
 * radio (the seam; the antenna hop is a physical-device gate).
 */
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {relayBaseURL} from '../harness/relayClient';
import {it, expect, afterEach} from '@jest/globals';
import {scaled as budgetScaled} from '../harness/budget';
import {
  accountOf, assert, assertEq, assertIncludes, DpayCore, faucetAccount, generateKeypair,
  getBalance, icpCatalog, onboardWallet, openBalances, railPrincipalText, selectCurrency,
} from '../harness/lib';
import {clickByAria, type NfcEvent} from './h';

const g = globalThis as unknown as Record<string, unknown>;

const VCHF = 7;                 // the ONE asset a dpay checkout takes
const FEE = 10_000;             // the VCHF catalog fee, charged to the SENDER
const PRICE = '4.50';           // what the cashier types
const PRICE_RAW = 450_000_000;  // 450 rappen × 10^(8−2)
const PAY_RAW = PRICE_RAW - FEE; // the settlement amount: the price less the fee the shop absorbs
const PAYER_SEED = 2_000_000_000;

type CheckoutOpen = {merchant?: string; reference?: string; id?: string};
type NfcResult = {status: number; nonceHex: string; requestIdHex: string};

let restoreFetch: (() => void) | null = null;
// The fetch wrapper is this file's own probe — restored here. The NFC stashes are the harness's
// (the lifecycle + the hermetic hook reset them per test).
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

hermeticFlow();

hermeticDescribe('flow 117 — a tap credits the shop’s own charge (the reference is the missing link)', () => {
  it('reader armed from the charge → offline bundle → memo=reference transfer → checkout flips paid', async () => {
    // The counter must believe it has a radio, or the reader never mounts.
    g.__DPAY_TEST_NFC_STATUS = 'ready';

    const m = await onboardWallet('Bahnhof Kiosk');
    const merchant = await accountOf(m);
    const merchantPrincipal = await railPrincipalText(merchant!.publicHex);

    // The customer: an independent key, funded on VCHF only. Nothing about them is in the app.
    const payer = await generateKeypair();
    const funded = await faucetAccount(payer.publicHex, PAYER_SEED, {currency: VCHF});
    assert(funded.ok, `the customer must be funded in VCHF, got HTTP ${funded.status}`);
    assertEq(String(await getBalance(merchant!.publicHex, VCHF)), '0', 'the shop starts with no VCHF');

    // --- the counter: open the charge, with a passive copy of every checkout-open answer. -------
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    const opens: CheckoutOpen[] = observeCheckoutOpens();
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000});
    await m.driver.type('amount-input', PRICE, {timeoutMs: 4000});
    await m.driver.click('btn-checkout-open', {timeoutMs: 4000});
    await m.driver.findByTestID('checkout-qr', {timeoutMs: 15000});

    // UNIT 1: the checkout-open the merchant SIGNED names the charge's reference.
    expect(opens.length).toBe(1);
    const open = opens[0];
    assertEq(open.merchant, merchantPrincipal, 'the charge is opened on the shop’s own account');
    expect(open.reference ?? '').toMatch(/^[0-9a-f]{32}$/);
    const idle = await getJson<CheckoutOpen & {state?: string; reference?: string}>(`/api/v1/checkout/${open.id}`);
    assertEq(idle.state, 'open', 'nothing is credited before the money moves');
    expect(idle.reference).toBeUndefined(); // the bearer-read route must not restate the reference

    // UNIT 2: the counter armed the reader FROM that charge (waited for, not sampled).
    await m.driver.waitForFunction(
      () => ((g.__DPAY_TEST_NFC_COUNT as () => number)() ?? 0) >= 1,
      {label: 'the counter mounts a reader NfcTap (>=1 DpayNfcEvent listener)', timeoutMs: 5000},
    );
    let armedHex: string | null = null;
    for (let i = 0; i < 200 && !armedHex; i++) {
      armedHex = (g.__DPAY_TEST_NFC_READER_REQUEST as string | undefined) ?? null;
      if (!armedHex) await new Promise((r) => setTimeout(r, budgetScaled(50)));
    }
    assert(armedHex != null, 'reader mode arming never happened');
    const req = await DpayCore.decodeRequest(hexToB64url(armedHex));
    assertEq(req.toHex, merchant!.publicHex, 'the tap request is payable to the SHOP’s own account');
    assertEq(String(req.amount), String(PAY_RAW), 'the tap asks for the price less the fee the shop absorbs');
    assertEq(req.currency, VCHF, 'a checkout charge settles in VCHF and nothing else');
    assertEq(req.nonceHex, open.reference, 'the tap request’s nonce must be the charge’s own reference');
    assertIncludes(m.driver.bodyText(), 'any phone camera opens it, and a dpay phone can tap it too',
      'the cashier is told the code opens on any camera and taps on a dpay phone');

    // --- the customer taps: an offline-signed bundle over the merchant's reader. ----------------
    const catalog = await icpCatalog();
    const desc = catalog.find((c) => c.currency === VCHF);
    assert(desc?.ledger != null, 'the relay’s catalog must name the VCHF ledger');
    assertEq(String(desc.fee), String(FEE), 'the VCHF fee this flow subtracts must be the catalog’s own');
    const argHex = await DpayCore.icpTransferArg(await railPrincipalText(req.toHex), '', '', String(req.amount), String(desc.fee), req.nonceHex);
    const expiryNs = (BigInt(Date.now()) * 1_000_000n + 240_000n * 1_000_000n).toString();
    const signed = await DpayCore.icpSignUpdate(payer.secretHex, desc.ledger, 'icrc1_transfer', argHex, expiryNs);
    const readStateHex = await DpayCore.icpSignReadState(payer.secretHex, [signed.requestIdHex], false, (BigInt(expiryNs) + 60_000_000_000n).toString());

    // Native ordering: the transport reaches Settling, then hands over the immutable bundle.
    const emit = (e: NfcEvent): void => { (g.__DPAY_TEST_NFC_SESSION as (x: NfcEvent) => void)(e); };
    emit({type: 'phase', role: 'reader', phase: 'settling'});
    emit({type: 'done', role: 'reader', envelopeHex: signed.envelopeHex, readStateEnvelopeHex: readStateHex, requestIdHex: signed.requestIdHex});

    // The tap OWNS the screen while it is in flight.
    await m.driver.findByTestID('nfc-status', {timeoutMs: 5000});
    expect(m.driver.isPresent('checkout-qr')).toBe(false);

    let queued: NfcResult | null = null;
    for (let i = 0; i < 200 && !queued; i++) {
      queued = (g.__DPAY_TEST_NFC_RESULT as NfcResult | null) ?? null;
      if (!queued) await new Promise((r) => setTimeout(r, budgetScaled(50)));
    }
    assertEq(queued?.status, 0, 'the merchant must reach a settled verdict from exact ledger history');
    assertEq(queued?.requestIdHex, signed.requestIdHex, 'the returned result binds the payer’s own update');
    assertEq(queued?.nonceHex, open.reference, 'the result is bound to the charge’s reference');
    emit({type: 'confirmed', role: 'reader'});
    expect(await m.driver.waitForText('Received', {timeoutMs: 20000})).toBe(true);

    // --- UNIT 3: THE RELAY credits the sale, knowing nothing about the tap. ---------------------
    let paid: {state: string; paid?: {amount_raw: string; block: number}} | null = null;
    for (let i = 0; i < 200 && paid == null; i++) {
      const s = await getJson<{state: string; paid?: {amount_raw: string; block: number}}>(`/api/v1/checkout/${open.id}`);
      if (s.state === 'paid') paid = s; else await new Promise((r) => setTimeout(r, budgetScaled(50)));
    }
    assert(paid != null, 'the checkout never observed the transfer');
    assertEq(paid.paid?.amount_raw, String(PAY_RAW), 'the sale is credited the exact raw VCHF it was priced at');
    expect(Number.isInteger(paid.paid?.block)).toBe(true);

    // …and the money really moved, exactly once.
    assertEq(String(await getBalance(merchant!.publicHex, VCHF)), String(PAY_RAW), 'the shop was credited the exact VCHF');
    assertEq(String(await getBalance(payer.publicHex, VCHF)), String(PAYER_SEED - PRICE_RAW),
      'the customer was debited the price and not one unit more');

    // --- the counter's own light is the RELAY's answer, not the tap's. --------------------------
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.findByTestID('checkout-paid', {timeoutMs: 15000});
    const counter = m.driver.bodyText();
    assertIncludes(counter, 'Paid 4.50 CHF', 'the counter reports the sale in the francs the cashier rang up');
    assertIncludes(counter, `Ledger block ${paid.paid?.block}`, 'and names the ledger row the RELAY credited it from');

    await m.unmount();
  }, 180_000);
});

/** Wrap the app's fetch just long enough to keep a copy of every successful checkout-open answer,
 *  without changing what the app receives. (The e2e wraps window.fetch; jest wraps the harness
 *  rewrite chain — same position, same transparency. Restored in-file, never across tests.) */
function observeCheckoutOpens(): CheckoutOpen[] {
  const opens: CheckoutOpen[] = [];
  const prev = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await prev(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/api\/v1\/checkout$/.test(url) && response.ok) {
      try { opens.push(await response.clone().json() as CheckoutOpen); } catch { /* copy only */ }
    }
    return response;
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = prev; };
  return opens;
}

/** GET a relay route and parse it, failing loudly on anything but 200. */
async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${relayBaseURL()}${path}`);
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** The reader seam carries HEX; the core's decoder eats base64url (the flow-06 twin). */
function hexToB64url(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
