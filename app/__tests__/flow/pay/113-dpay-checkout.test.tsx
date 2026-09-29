/**
 * Flow 113 — the jest twin of `e2e/tests/113-dpay-checkout.mjs` (a dpay wallet pays a dpay-SERVED
 * OpenCryptoPay checkout, via the checkout_wire.json golden).
 *
 * Leg 1: the checkout offers only InternetComputer/VCHF and the payer pays it — the explicit review
 * shows the VCHF total, the full destination, the relay as the price's host, the claimed name and
 * the SIGNED note (what the charge is for); Approve moves the exact VCHF carrying the checkout's
 * per-charge `ref` as the on-chain memo, then reports the proof exactly once as
 * `<vchf ledger>:<block index>` (the spelling a non-ICP ICRC ledger requires). Leg 2: a 202 PENDING
 * answer renders as sent-and-waiting with the ledger reference — never as paid, never as failed,
 * never with a second submission.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {
  accountOf, armPayScan, assert, assertEq, assertIncludes, faucetAccount, generateKeypair,
  getBalance, onboardWallet, openBalances, railPrincipalText, selectCurrency,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {
  DPAY_CHECKOUT, installCheckoutStub, ocpStubState, setOcpTxMode, dpayCheckoutAt,
} from './ocp-stub';
import {scanSeam} from './local';

const VCHF = 7;
const FEE = 10_000; // the VCHF catalog fee, charged to the sender
const PAY_RAW = 999_990_000;
const SEED = 2_000_020_001; // 20.00020001 VCHF — two payments + two fees, with an odd tail
const SEED_TEXT = '20.00 Fr';
const PAY_TEXT = '10.00 VCHF'; // the TOTAL DEBIT — the checkout prices the fee in (VCHF min 2 fraction digits)

const scanCheckout = async (m: Parameters<typeof armPayScan>[0], qr: string): Promise<void> => {
  await armPayScan(m);
  await m.driver.settleFrames(1);
  scanSeam()(qr);
};

// The file's private relay — the host the checkout QR names ("our relay is not exempt").
const HF = hermeticFlow();

hermeticDescribe('flow 113 — pay dpay’s own checkout (VCHF, ref as memo, ledger-prefixed proof)', () => {
  it('Approve moves the exact VCHF to the merchant with the checkout’s ref; PENDING is not paid', async () => {
    const m = await onboardWallet('jest-dpay-checkout');
    const accountHex = (await accountOf(m))!.publicHex;
    // The golden must still quote the amount this flow funds for — every balance below is
    // arithmetic on that number.
    assertEq(DPAY_CHECKOUT.amountRaw, String(PAY_RAW), 'the checkout golden still quotes this flow’s amount');

    const merchant = await generateKeypair();
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    const fund = await faucetAccount(accountHex, SEED, {currency: VCHF});
    assert(fund.ok, `faucet funding of VCHF must succeed, got ${fund.status}`);

    // Served from the host the wallet talks to — which is precisely what makes it payable.
    const checkout = dpayCheckoutAt(HF.relay.baseURL, merchantPrincipal);
    const uninstall = installCheckoutStub(checkout.cfg);

    try {
      // --- 1. the checkout dpay serves is payable, and paying it moves real money -----------------
      await openBalances(m);
      await selectCurrency(m, 'vchf');
      assert(await m.driver.waitForText(SEED_TEXT, {timeoutMs: 10_000}), 'the app must see the VCHF seed');
      await m.driver.click('tab-pay', {timeoutMs: 5000});
      expect(m.driver.isPresent('pay-fund')).toBe(false);
      await scanCheckout(m, checkout.qr);

      await m.driver.findByTestID('pay-amount', {timeoutMs: 15_000});
      assert(await m.driver.waitForText(`Pay ${PAY_TEXT}`, {timeoutMs: 15_000}), 'the review reaches the fee-inclusive total');
      assertEq(m.driver.readText('pay-amount'), `Pay ${PAY_TEXT}`, 'the review shows the checkout’s exact quoted amount');
      assertEq(m.driver.readText('review-payee'), merchantPrincipal, 'the review shows the MERCHANT’s own account');
      const price = m.driver.readText('ocp-price');
      assertIncludes(price, 'CHF 10', 'the review shows the checkout’s own price');
      assertIncludes(price, checkout.host, 'the review names the host that set the price — our relay is not exempt');
      assertIncludes(m.driver.bodyText(), DPAY_CHECKOUT.merchant, 'the review shows the claimed name');
      // The charge-open's NOTE — what the charge is for, signed at open and served back on step-2.
      assertEq(m.driver.readText('review-memo'), DPAY_CHECKOUT.note, 'the review shows the note the merchant signed');
      expect(m.driver.isPresent('review-claimed')).toBe(false);
      expect(m.driver.isPresent('ocp-expiry')).toBe(false);
      expect(m.driver.isPresent('btn-approve')).toBe(true);
      assertEq(await getBalance(accountHex, VCHF), String(SEED), 'nothing leaves before the payer approves');

      await m.driver.click('btn-approve', {timeoutMs: 5000});
      assert(await m.driver.waitForText(`Paid ✓ ${PAY_TEXT}`, {timeoutMs: 20_000}), 'the paid state with the exact amount');
      expect(m.driver.isPresent('ocp-outcome')).toBe(false);
      assertEq(await getBalance(accountHex, VCHF), String(SEED - PAY_RAW - FEE), 'the payer is debited the exact amount + fee');
      assertEq(await getBalance(merchant.publicHex, VCHF), String(PAY_RAW), 'the MERCHANT is credited the exact amount');

      // THE REFERENCE, end to end: the merchant's history read back through the exact-memo filter.
      const byRef = await relayGet(`/api/v1/transactions/${merchant.publicHex}?currency=${VCHF}&memo=${DPAY_CHECKOUT.ref}`) as {transactions?: Array<{amount: string}>};
      assertEq(String(byRef.transactions?.length ?? 0), '1', `exactly one transfer carries the checkout's ref ${DPAY_CHECKOUT.ref}`);
      assertEq(byRef.transactions![0].amount, String(PAY_RAW), 'the referenced transfer is the one that paid the charge');

      let seen = ocpStubState();
      assertEq(seen.txUrls.length, 1, 'the proof is reported exactly once');
      const submitted = new URL(seen.txUrls[0]);
      assertEq(submitted.pathname, `/v1/lnurlp/tx/${DPAY_CHECKOUT.paymentId}`, 'the submission hits the /tx path');
      assertEq(submitted.searchParams.get('method'), DPAY_CHECKOUT.method, 'the submission echoes the checkout’s method');
      assertEq(submitted.searchParams.get('asset'), DPAY_CHECKOUT.asset, 'the submission echoes the checkout’s asset');
      // Not a shape check: the LEDGER must be this checkout's own (the 2026-09-03 defect class).
      const reportedTx = submitted.searchParams.get('tx') ?? '';
      expect(reportedTx).toMatch(new RegExp(`^${DPAY_CHECKOUT.ledger}:\\d+$`));

      // --- 2. the checkout says PENDING: reported, not credited -------------------------------------
      setOcpTxMode('pending');
      await m.driver.click('btn-new', {timeoutMs: 5000});
      await scanCheckout(m, checkout.qr);
      await m.driver.findByTestID('pay-amount', {timeoutMs: 15_000});
      await m.driver.click('btn-approve', {timeoutMs: 5000});

      expect(await m.driver.findByTestID('ocp-outcome', {timeoutMs: 25_000})).not.toBeNull();
      const outcome = m.driver.readText('ocp-outcome');
      assertIncludes(outcome, 'hasn’t matched this sale yet', 'the note says the provider has not matched the sale yet');
      assertIncludes(outcome, 'don’t pay again', 'the payer is told not to pay twice');
      expect(outcome).toMatch(/ledger block \d+/);
      const body = m.driver.bodyText();
      expect(body).not.toContain('Paid ✓');
      assertIncludes(body, `Sent ${PAY_TEXT}`, 'the honest headline is that the money was sent');
      assertEq(await getBalance(merchant.publicHex, VCHF), String(PAY_RAW * 2), 'the pending payment really settled: both transfers hold');
      expect(m.driver.isPresent('btn-approve')).toBe(false);
      seen = ocpStubState();
      assertEq(seen.txUrls.length, 2, 'a pending answer is reported once and never retried from here');
      // the spelling rule holds on every submission
      expect(new URL(seen.txUrls[1]).searchParams.get('tx') ?? '').toMatch(new RegExp(`^${DPAY_CHECKOUT.ledger}:\\d+$`));
      expect(seen.unexpected).toEqual([]);
    } finally {
      uninstall();
    }

    await m.unmount();
  }, 180_000);
});
