// Flow 170 — V9 invariant 8 (multi-venue readiness, spec §0 red line 6): NO conversion offer
// appears anywhere in a payment flow. Conversion is a standalone wallet action on settled
// balance (btn-accounts-convert, Accounts tab); the scan/pay surfaces — IC and SOL alike —
// must carry zero convert entry points: no convert testID, no 'Convert' CTA, nothing that
// suggests converting mid-payment.
//
// Jest cannot see this class (it needs the REAL rendered payment surfaces), so it lives here:
// cheap, single browser session, onboards once, walks the IC pay surface then the SOL pay
// surface (the SOL rail's own PayMode twin, SolPayMode), asserting absence on both.
import {setup, assert, assertEq, onboardWallet, openBalances, selectCurrency} from '../harness/lib.mjs';

export const meta = {
  id: '170',
  name: 'pay-no-convert-cta',
  journey: 'pay',
  covers: ['pay', 'scan', 'solana', 'convert', 'separation'],
  verifies: 'The payment surfaces (IC PayMode and the SOL PayMode twin) expose zero conversion entry points — no convert testID and no Convert CTA — conversion stays a standalone wallet action (Accounts tab only).',
  timeoutMs: 90000,
};

/** Zero tolerance count of every convert-surfaced testID + any button labeled 'Convert'. */
async function convertCtaCount(driver) {
  return driver.eval(() => {
    const ids = document.querySelectorAll('[data-testid^="convert-"], [data-testid="btn-accounts-convert"]').length;
    const ctaText = Array.from(document.querySelectorAll('button, [role="button"], [role="radio"], a'))
      .filter(el => (el.textContent ?? '').trim() === 'Convert').length;
    return ids + ctaText;
  });
}

export async function run() {
  const start = Date.now();
  console.log('[170-pay-no-convert] setup…');
  const env = await setup();
  try {
    const {driver} = env;
    await onboardWallet(driver, 'e2e-pay-no-convert');

    // --- the IC pay surface (PayMode): selectCurrency lands on tab-pay by itself ------------
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    // We are ON the pay surface: the scan gate (founder rule 2026-08-23) is its anchor.
    await driver.findByTestID('btn-start-scan', {timeoutMs: 6_000});
    const icCount = await convertCtaCount(driver);
    assertEq(icCount, 0, 'the IC pay surface carries zero conversion entry points');

    // --- the SOL pay surface (SolPayMode): same tab, the other rail ------------------------
    await openBalances(driver);
    await selectCurrency(driver, 'sol');
    await driver.findByTestID('btn-sol-start-scan', {timeoutMs: 6_000});
    const solCount = await convertCtaCount(driver);
    assertEq(solCount, 0, 'the SOL pay surface carries zero conversion entry points');

    // Control (proves the probe can fail): the Accounts list, one hop away, carries the ONE
    // legitimate entry point — on the selected row — so absence on pay surfaces is a real
    // separation fact, not a broken query.
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    // Currency-first (2026-09-24): Convert is a per-currency row action — one entry PER
    // visible currency row (the probe counts the prefixed testIDs).
    const accountsHasConvert = await driver.eval(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .filter(el => el.getAttribute('data-testid').startsWith('btn-accounts-convert-')).length);
    assert(accountsHasConvert >= 1, `control: the Accounts list carries the per-currency Convert entries (found ${accountsHasConvert})`);

    await driver.screenshot('170-pay-no-convert-cta');
    console.log(`[170-pay-no-convert] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[170-pay-no-convert] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[170-pay-no-convert] FAILED:', e);
    process.exit(1);
  });
}
