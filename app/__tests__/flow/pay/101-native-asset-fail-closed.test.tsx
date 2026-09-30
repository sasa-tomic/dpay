/**
 * Flow 101 — the jest twin of `e2e/tests/101-native-asset-fail-closed.mjs` (obligation 10: the
 * no-minter native rows inherit the wallet's fail-closed posture).
 *
 * Insufficient (per asset, VCHF then ICP): a request over that asset's balance parks on
 * review-lowbal "Not enough balance." with NO approve/paid button, no signed
 * envelope (the canister-call recorder stays empty), the payee receives nothing. Unknown currency
 * (99): the unsupported-asset branch, "Unsupported asset" + "(currency 99)", no fallback — dpay
 * never swaps. After all legs the wallet keeps exactly what was seeded: nothing moved.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, armPayScan, assert, assertEq, assertIncludes, DpayCore, faucetAccount, generateKeypair,
  getBalance, onboardWallet, openBalances, selectCurrency,
} from '../harness/lib';
import {scanSeam} from './local';

const INSUFFICIENT_LEGS = [
  {currency: 7, tag: 'VCHF', testKey: 'vchf'},
  {currency: 8, tag: 'ICP', testKey: 'icp'},
];
const TINY_SEED = 20000; // 0.00020000 — far below the request, but nonzero (funded, still insufficient)
const PAY = '100000001'; // 1.00000001 — what the merchant asks
const UNKNOWN_CURRENCY = '99';

hermeticDescribe('flow 101 — native-asset fail-closed: insufficient + unsupported refuse without signing', () => {
  it('VCHF/ICP insufficient legs and the unknown-currency leg never sign; nothing moves', async () => {
    const m = await onboardWallet('jest-failclosed');
    const account = await accountOf(m);
    const merchant = await generateKeypair();

    // Canister-call recorder over the harness's rewritten fetch — NO leg may ever reach one.
    const canisterCalls: string[] = [];
    const prevFetch = globalThis.fetch;
    (globalThis as unknown as {fetch: typeof fetch}).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (u.includes('/api/v2/canister/')) canisterCalls.push(u);
      } catch { /* never break the app on a recorder fault */ }
      return prevFetch(input, init);
    }) as typeof fetch;

    try {
      // --- Insufficient legs (VCHF, then ICP) ----------------------------------------------------
      for (const leg of INSUFFICIENT_LEGS) {
        await openBalances(m);
        await selectCurrency(m, leg.testKey);
        const fund = await faucetAccount(account!.publicHex, TINY_SEED, {currency: leg.currency});
        assert(fund.ok, `${leg.tag} tiny faucet credit ok (status ${fund.status})`);
        // "The credit surfaced, still insufficient": the family figure flips to the tiny '< 0.01'
        // form (VCHF folds into the CHF group) — or, on a full-precision build, the raw row form.
        const CREDIT_SHOWN: Record<string, RegExp> = {
          vchf: /(< 0\.01 Fr|0\.0002(0000)? VCHF)/,
          icp: /(< 0\.01 ICP|0\.0002(0000)? ICP)/,
        };
        // (waitForFunction throws on timeout — a plain await is the assertion.)
        await m.driver.waitForFunction(
          () => CREDIT_SHOWN[leg.testKey].test(m.driver.bodyText()),
          {timeoutMs: 10_000, label: `${leg.tag}: funded, still insufficient`},
        );

        await m.driver.click('tab-pay', {timeoutMs: 4000});
        await armPayScan(m);
        await m.driver.settleFrames(1);
        const expiry = Math.floor(Date.now() / 1000) + 600;
        const requestQR = await DpayCore.encodeRequest(
          merchant.publicHex, PAY, 'ab'.repeat(16), expiry, leg.currency, 'Merchant', '');
        scanSeam()(requestQR);

        // WAIT for the refusal, then snapshot (never snapshot the pre-render surface).
        assert(await m.driver.waitForText('Not enough balance.', {timeoutMs: 10_000}),
          `${leg.tag}: review must show the insufficient-balance block`);
        const body = m.driver.bodyText();
        assertIncludes(body, `Pay 1.00000001 ${leg.tag}`, `${leg.tag}: blocked review still shows the exact amount`);
        expect(m.driver.isPresent('btn-approve')).toBe(false);
        expect(m.driver.isPresent('btn-paid')).toBe(false);
        expect(body).not.toMatch(/\bPaid\b/);
        expect(canisterCalls).toHaveLength(0);
        assertEq(await getBalance(merchant.publicHex, leg.currency), '0', `${leg.tag}: merchant received nothing`);

        await m.driver.click('btn-review-cancel', {timeoutMs: 4000});
        await m.driver.findByTestID('pay-scan', {timeoutMs: 6000});
      }

      // --- Unknown-currency leg (shared) ---------------------------------------------------------
      await armPayScan(m);
      await m.driver.settleFrames(1);
      const ghostQR = await DpayCore.encodeRequest(
        merchant.publicHex, PAY, 'cd'.repeat(16), Math.floor(Date.now() / 1000) + 600, Number(UNKNOWN_CURRENCY), 'Merchant', '');
      scanSeam()(ghostQR);

      assert(await m.driver.waitForText('Unsupported asset', {timeoutMs: 10_000}),
        'unknown-currency request must hit the unsupported-asset branch');
      const ghostBody = m.driver.bodyText();
      assertIncludes(ghostBody, 'currency 99', 'unsupported body names the offending currency id');
      expect(m.driver.isPresent('btn-approve')).toBe(false);
      expect(m.driver.isPresent('btn-paid')).toBe(false);
      expect(ghostBody).not.toMatch(/\bPaid\b/);
      expect(canisterCalls.filter((u) => u.endsWith('/call'))).toHaveLength(0);

      // --- Nothing moved: the payer keeps exactly what was seeded --------------------------------
      assertEq(await getBalance(account!.publicHex, 0), '10000', 'payer DEMO balance intact');
      assertEq(await getBalance(account!.publicHex, 7), String(TINY_SEED), 'payer VCHF balance intact');
      assertEq(await getBalance(account!.publicHex, 8), String(TINY_SEED), 'payer ICP balance intact');
    } finally {
      (globalThis as unknown as {fetch: typeof fetch}).fetch = prevFetch;
    }

    await m.unmount();
  }, 180_000);
});
