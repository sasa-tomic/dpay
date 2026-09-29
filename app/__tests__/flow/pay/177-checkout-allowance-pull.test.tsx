/**
 * Flow 177 — the jest twin of `e2e/tests/177-checkout-allowance-pull.mjs` (the allowance-wallet
 * path into dpay's checkout: the customer APPROVES the shop, tells the checkout, and the SHOP's own
 * phone collects the sale — the app is never told anything, it reads the claim off its poll).
 *
 * An approval is a permission, not a payment: no money moves (the customer pays one ledger fee for
 * the approve and nothing else). The standard's retryable PENDING is what an allowance wallet gets;
 * once the shop collects, the screen reports the sale with the ledger row, the shop is credited the
 * price less the fee it absorbs, and the customer moved by exactly the price (two fees: their
 * approve + the pull's transfer fee, charged to the approved allowance).
 */
import {it} from '@jest/globals';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {
  accountOf, assert, assertEq, assertIncludes, DpayCore, faucetAccount, generateKeypair,
  getBalance, icpCatalog, onboardWallet, openBalances, railPrincipalText, selectCurrency,
} from '../harness/lib';

// The file's private relay — the origin every direct gateway/checkout fetch below targets.
const HF = hermeticFlow();

const VCHF = 7;
const FEE = 10_000; // the VCHF catalog fee, charged by the ledger to the SENDER
const PRICE = '4.50';
const PRICE_RAW = 450_000_000; // 450 rappen × 10^(8−2)
const PAY_RAW = PRICE_RAW - FEE;
const PAYER_SEED = 2_000_000_000;

function observeCheckoutOpens(): {opens(): Array<Record<string, unknown>>; restore: () => void} {
  const opens: Array<Record<string, unknown>> = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await prev(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/api\/v1\/checkout$/.test(url) && response.ok) {
      opens.push((await response.clone().json()) as Record<string, unknown>);
    }
    return response;
  }) as typeof fetch;
  return {opens: () => opens, restore: () => { globalThis.fetch = prev; }};
}

/** THE ALLOWANCE WALLET, stood in for: sign a real `icrc2_approve` naming the shop as spender.
 *  The approved amount is `amount + fee` — what a pull actually costs the customer. */
async function approveTheShop(payer: {secretHex: string}, merchantPubHex: string, amount: string, ledger: string): Promise<void> {
  const spender = await DpayCore.icpPrincipalFromPubkey(merchantPubHex);
  const argHex = await DpayCore.icpApproveArg(
    spender, '', '',
    (BigInt(amount) + BigInt(FEE)).toString(),
    '',
    (BigInt(Date.now() + 5 * 60_000) * 1_000_000n).toString(),
    '',
    String(FEE),
  );
  const expiry = (BigInt(Date.now()) * 1_000_000n + 300_000n * 1_000_000n).toString();
  const signed = await DpayCore.icpSignUpdate(payer.secretHex, ledger, 'icrc2_approve', argHex, expiry);
  const bytes = new Uint8Array(signed.envelopeHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const r = await fetch(`${HF.relay.baseURL}/api/v2/canister/${ledger}/call`, {
    method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: bytes,
  });
  assert(r.ok, `the approve must be accepted by the gateway, got HTTP ${r.status}`);
}

hermeticDescribe('flow 177 — allowance pull: approve the shop, report, and the shop collects the sale', () => {
  it('an approval moves no money; the pull settles it; the counter reports the sale', async () => {
    const m = await onboardWallet('Bahnhof Kiosk');
    const merchant = (await accountOf(m))!;
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    const payer = await generateKeypair();
    const payerPrincipal = await railPrincipalText(payer.publicHex);
    const funded = await faucetAccount(payer.publicHex, PAYER_SEED, {currency: VCHF});
    assert(funded.ok, `the customer must be funded in VCHF, got ${funded.status}`);
    const ledger = (await icpCatalog()).find((c) => c.currency === VCHF)?.ledger;
    assert(typeof ledger === 'string' && ledger.length > 0, 'the catalog must name the VCHF ledger');

    // --- the counter ------------------------------------------------------------------------------
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    const observer = observeCheckoutOpens();
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000});
    await m.driver.type('amount-input', PRICE, {timeoutMs: 4000});
    await m.driver.click('btn-checkout-open', {timeoutMs: 4000});
    await m.driver.findByTestID('checkout-qr', {timeoutMs: 15_000});

    const opens = observer.opens();
    assertEq(opens.length, 1, 'exactly one checkout-open was sent');
    const open = opens[0];
    assertEq(open.merchant as string, merchantPrincipal, 'the charge is opened on the shop’s own account');
    assertEq(open.amount as string, '4.4999', 'the checkout quotes the price less the fee the shop absorbs');

    // --- the customer APPROVES, and tells the checkout so --------------------------------------------
    await approveTheShop(payer, merchant.publicHex, String(PAY_RAW), ledger);
    assertEq(await getBalance(merchant.publicHex, VCHF), '0', 'an approval must move no money at all');
    assertEq(await getBalance(payer.publicHex, VCHF), String(PAYER_SEED - FEE),
      'the approve costs the customer one ledger fee and nothing else');

    const fetchJson = async (url: string): Promise<Record<string, unknown>> => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
      return JSON.parse(await r.text()) as Record<string, unknown>;
    };
    const details = await fetchJson(`${HF.relay.baseURL}/v1/lnurlp/${open.id as string}?timeout=0`);
    const quote = (details?.quote as {id?: string} | undefined)?.id;
    assert(typeof quote === 'string', 'the checkout must mint a quote');
    const report = `${HF.relay.baseURL}/v1/lnurlp/tx/${open.id as string}?quote=${encodeURIComponent(quote)}` +
      `&method=InternetComputer&asset=VCHF&sender=${encodeURIComponent(payerPrincipal)}`;
    const reported = await fetch(report);
    assertEq(reported.status, 202, 'the standard’s retryable PENDING is what an allowance wallet gets');

    // --- the SHOP's own phone collects it: the app reads the claim off its own poll -----------------
    assert(await m.driver.waitForText('Paid 4.50 CHF', {timeoutMs: 30_000}), 'the sale lands once the shop collects');
    const settled = m.driver.bodyText();
    assertIncludes(settled, 'Ledger block', 'the sale names the ledger row that paid it');

    // The money, and the founder's rule on it: the price moved, not the price plus a fee.
    assertEq(await getBalance(merchant.publicHex, VCHF), String(PAY_RAW), 'the shop credited the price less the fee it absorbs');
    assertEq(await getBalance(payer.publicHex, VCHF), String(PAYER_SEED - PRICE_RAW - FEE),
      'the customer moved by exactly the price (the pull transfer’s fee rides the approved allowance)');
    observer.restore();

    await m.unmount();
  }, 180_000);
});
