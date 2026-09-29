/**
 * Flow 111 — the jest twin of `e2e/tests/111-opencryptopay-checkout.mjs` (a merchant OpenCryptoPay
 * checkout on the IC rail, through the in-process provider fixture).
 *
 * Scanning a merchant checkout resolves a live quote onto an EXPLICIT review (full destination, one
 * line carrying the fiat price and the host that set it, no countdown while there is runway) that
 * never auto-signs; Approve moves the funds and reports the proof once → Paid; a submission that
 * never answers renders UNRESOLVED with the ledger block index and no retry; a checkout that does
 * not take the selected asset is refused by name — and offering the menu costs exactly one read.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, armPayScan, assert, assertEq, assertIncludes, faucetAccount, generateKeypair,
  getBalance, onboardWallet, openBalances, railPrincipalText, selectCurrency,
} from '../harness/lib';
import {
  CHECKOUT_QR, CLAIMED_MERCHANT, PAYMENT_ID, PROVIDER_HOST, TRANSFER_AMOUNTS,
  installCheckoutStub, ocpStubState, setOcpTxMode,
} from './ocp-stub';
import {scanSeam} from './local';

const ICP = 8;
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // == the OCP menu's ICP ledger
const ICP_SEED = 500_000_001; // 5.00000001 — the odd tail keeps the trimmed header honest
const ICP_FEE = 10_000;
const PAY_RAW = 50_795_551; // the checkout's 0.50795551 ICP at 8 decimals
const CKUSDC = 2;
const CKUSDC_SEED = 5_000_000;

const scanCheckout = async (m: Parameters<typeof armPayScan>[0]): Promise<void> => {
  await armPayScan(m);
  await m.driver.settleFrames(1);
  scanSeam()(CHECKOUT_QR);
};

hermeticDescribe('flow 111 — OpenCryptoPay checkout (IC rail): explicit review, one-shot proof, honest loss path', () => {
  it('menu on one read; picking pays the picked asset; Approve settles once; indefinite is unresolved', async () => {
    const m = await onboardWallet('jest-ocp');
    const accountHex = (await accountOf(m))!.publicHex;
    const merchant = await generateKeypair();
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    for (const [currency, amount] of [[ICP, ICP_SEED], [CKUSDC, CKUSDC_SEED]] as const) {
      const fund = await faucetAccount(accountHex, amount, {currency});
      assert(fund.ok, `faucet funding of currency ${currency} must succeed, got ${fund.status}`);
    }

    const uninstall = installCheckoutStub({
      providerOrigin: `https://${PROVIDER_HOST}`,
      paymentId: PAYMENT_ID,
      callbackUrl: `https://${PROVIDER_HOST}/v1/lnurlp/cb/${PAYMENT_ID}`,
      merchantName: CLAIMED_MERCHANT,
      transferAmounts: TRANSFER_AMOUNTS,
      requestedAmount: {asset: 'CHF', amount: 1},
      uris: {
        // The live shape: `icp:<LEDGER>/transfer?to=<PRINCIPAL>&amount=<DECIMAL>`.
        'InternetComputer/ICP': `icp:${ICP_LEDGER}/transfer?to=${merchantPrincipal}&amount=0.50795551`,
      },
      detailsDelayMs: 1000, // deliberately slow: leg 2 asserts the wallet says it is checking
    });

    try {
      // --- 1. the checkout does not take the selected asset ---------------------------------------
      await openBalances(m);
      await selectCurrency(m, 'ckusdc');
      assert(await m.driver.waitForText('$5.00', {timeoutMs: 10_000}), 'the app must see the ckUSDC seed');
      await m.driver.click('tab-pay', {timeoutMs: 5000});
      expect(m.driver.isPresent('pay-fund')).toBe(false);
      await scanCheckout(m);

      expect(await m.driver.findByTestID('ocp-choose', {timeoutMs: 12_000})).not.toBeNull();
      const body = m.driver.bodyText();
      assertIncludes(body, 'This checkout doesn’t take USDC', 'the menu names the selected asset');
      assertIncludes(body, 'dpay never swaps', 'the menu states that picking is not a conversion');
      for (const id of ['ic:1', 'ic:7', 'ic:8']) {
        expect(m.driver.isPresent(`ocp-option-${id}`)).toBe(true);
      }
      expect(m.driver.isPresent('ocp-option-ic:9')).toBe(false); // VEUR retired from the catalog
      assertIncludes(m.driver.readText('ocp-option-ic:8'), '0.50805551 ICP', 'the option states its total debit');
      expect(m.driver.isPresent('ocp-option-solana:SOL')).toBe(false);
      expect(m.driver.isPresent('pay-amount')).toBe(false);
      expect(m.driver.isPresent('btn-approve')).toBe(false);

      // Offering the menu costs exactly one provider read; nothing touches the submission endpoint.
      let seen = ocpStubState();
      assertEq(seen.calls.length, 1, 'offering the menu costs exactly one provider read');
      assertIncludes(seen.calls[0], 'timeout=0', 'the details read asks for the current charge');
      assertEq(seen.txUrls.length, 0, 'nothing before the funds move may touch the submission endpoint');

      // PICKING pays the chosen asset.
      await m.driver.click('ocp-option-ic:8', {timeoutMs: 5000});
      await m.driver.findByTestID('pay-amount', {timeoutMs: 15_000});
      assert(await m.driver.waitForText('Pay 0.50805551 ICP', {timeoutMs: 15_000}), 'the picked review reaches the fee-inclusive total');
      assertEq(m.driver.readText('pay-amount'), 'Pay 0.50805551 ICP', 'picking ICP reviews ICP — never the ckUSDC selected');
      assertEq(m.driver.readText('review-payee'), merchantPrincipal, 'the picked review shows the FULL destination');
      await m.driver.click('btn-review-cancel', {timeoutMs: 4000});

      // --- 2. the review: never auto-signs, and says who priced it --------------------------------
      await openBalances(m);
      await selectCurrency(m, 'icp');
      assert(await m.driver.waitForText('5.00000001 ICP', {timeoutMs: 10_000}), 'the app must see the ICP seed');
      await m.driver.click('tab-pay', {timeoutMs: 5000});
      expect(m.driver.isPresent('pay-fund')).toBe(false);
      await scanCheckout(m);

      expect(await m.driver.findByTestID('ocp-checking', {timeoutMs: 8000})).not.toBeNull();
      assertIncludes(m.driver.readText('ocp-checking'), 'payment provider', 'the waiting message names who is being asked');

      await m.driver.findByTestID('pay-amount', {timeoutMs: 15_000});
      assert(await m.driver.waitForText('Pay 0.50805551 ICP', {timeoutMs: 15_000}), 'the review reaches the total debit');
      assertEq(m.driver.readText('pay-amount'), 'Pay 0.50805551 ICP', 'the review shows the quoted amount + the ledger fee');
      assertEq(m.driver.readText('review-payee'), merchantPrincipal, 'the review shows the FULL destination account');
      assertEq(m.driver.readText('ocp-price'), `CHF 1 · price from ${PROVIDER_HOST}`, 'one line: the price and the host that set it');
      expect(m.driver.readText('ocp-price')).not.toContain('convert');
      expect(m.driver.isPresent('review-claimed')).toBe(false);
      expect(m.driver.isPresent('ocp-expiry')).toBe(false); // no countdown while there is runway
      assertIncludes(m.driver.bodyText(), CLAIMED_MERCHANT, 'the review shows the claimed name');

      // NEVER AUTO-SIGNS — proven with money: the ledger has not moved.
      expect(m.driver.isPresent('btn-approve')).toBe(true);
      assertEq(await getBalance(accountHex, ICP), String(ICP_SEED), 'nothing leaves before the payer approves');

      // --- 3. paid ----------------------------------------------------------------------------------
      await m.driver.click('btn-approve', {timeoutMs: 5000});
      assert(await m.driver.waitForText('Paid ✓ 0.50805551 ICP', {timeoutMs: 20_000}), 'the paid state with the exact amount');
      expect(m.driver.isPresent('ocp-outcome')).toBe(false);
      assertEq(await getBalance(accountHex, ICP), String(ICP_SEED - PAY_RAW - ICP_FEE), 'debited the exact amount + the ledger fee');

      seen = ocpStubState();
      assertEq(seen.txUrls.length, 1, 'the proof is reported EXACTLY once');
      const submitted = new URL(seen.txUrls[0]);
      assertEq(submitted.pathname, `/v1/lnurlp/tx/${PAYMENT_ID}`, 'the submission hits the /tx path');
      assertEq(submitted.searchParams.get('method'), 'InternetComputer', 'the submission echoes the method spelling');
      assertEq(submitted.searchParams.get('asset'), 'ICP', 'the submission echoes the asset spelling');
      expect(submitted.searchParams.get('tx') ?? '').toMatch(/^\d+$/); // a native ICP index, BARE

      // --- 4. UNRESOLVED: the money moved, the sale is not credited ---------------------------------
      setOcpTxMode('indefinite');
      await m.driver.click('btn-new', {timeoutMs: 5000});
      await scanCheckout(m);
      await m.driver.findByTestID('pay-amount', {timeoutMs: 15_000});
      await m.driver.click('btn-approve', {timeoutMs: 5000});

      expect(await m.driver.findByTestID('ocp-outcome', {timeoutMs: 25_000})).not.toBeNull();
      const outcome = m.driver.readText('ocp-outcome');
      assertIncludes(outcome, 'neither paid nor failed', 'the outcome is stated as neither paid nor failed');
      assertIncludes(outcome, 'don’t pay again', 'the payer is told NOT to pay again');
      const ref = /ledger block (\d+)/.exec(outcome);
      assert(ref !== null, 'the outcome shows the on-chain reference that proves the transfer');

      const bodyNow = m.driver.bodyText();
      expect(bodyNow).not.toContain('Paid ✓');
      assertIncludes(bodyNow, 'Sent 0.50805551 ICP', 'the honest pending headline');
      expect(bodyNow).not.toContain('awaiting the merchant’s confirmation');
      assertIncludes(bodyNow, `to ${CLAIMED_MERCHANT}`, 'the outcome names who the money went to');
      expect(m.driver.isPresent('btn-approve')).toBe(false);

      expect(ocpStubState().unexpected).toEqual([]);
    } finally {
      uninstall();
    }

    await m.unmount();
  }, 180_000);
});
