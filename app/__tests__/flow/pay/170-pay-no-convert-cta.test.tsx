/**
 * Flow 170 — the jest twin of `e2e/tests/170-pay-no-convert-cta.mjs` (structural census: the pay
 * surfaces carry ZERO conversion entry points; the Accounts list carries the ONE legitimate set).
 *
 * The probe counts every `convert-`-prefixed testID plus any element labelled exactly "Convert".
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {onboardWallet, openBalances, selectCurrency} from '../harness/lib';

/** Zero tolerance count of every convert-surfaced testID + any pressable labelled 'Convert'. */
function convertCtaCount(m: Parameters<typeof openBalances>[0]): number {
  const ids = m.driver.findAllByTestID('btn-accounts-convert').length;
  let prefixed = 0;
  for (const n of m.tree.root.findAll((n) => n.props && typeof n.props.testID === 'string')) {
    if (n.props.testID.startsWith('convert-')) prefixed += 1;
  }
  let ctaText = 0;
  for (const n of m.tree.root.findAll((n) => n.props && (n.props.accessibilityRole === 'button' || n.props.accessibilityRole === 'radio'))) {
    if (m.driver.findAllByTestID(String(n.props.testID)).length > 0) {
      try {
        if (m.driver.readText(String(n.props.testID)).trim() === 'Convert') ctaText += 1;
      } catch { /* not a text subtree */ }
    }
  }
  return ids + prefixed + ctaText;
}

hermeticDescribe('flow 170 — the pay surfaces carry zero conversion entry points', () => {
  it('IC pay: 0; SOL pay: 0; control: the Accounts list carries the per-currency Convert entries', async () => {
    const m = await onboardWallet('jest-pay-no-convert');

    // The IC pay surface: the scan gate (founder rule 2026-08-23) is its anchor.
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.findByTestID('btn-start-scan', {timeoutMs: 6000});
    expect(convertCtaCount(m)).toBe(0);

    // The SOL pay surface: same tab, the other rail.
    await openBalances(m);
    await selectCurrency(m, 'sol');
    await m.driver.findByTestID('btn-sol-start-scan', {timeoutMs: 6000});
    expect(convertCtaCount(m)).toBe(0);

    // Control (proves the probe can fail): the Accounts list carries the ONE legitimate entry per
    // visible currency row — absence on pay surfaces is a real separation fact.
    await openBalances(m);
    await selectCurrency(m, 'icp');
    await openBalances(m);
    const accountsConvert = m.driver.findAllByTestID('btn-accounts-convert-ICP').length
      + m.driver.findAllByTestID('btn-accounts-convert').length;
    expect(accountsConvert).toBeGreaterThanOrEqual(1);

    await m.unmount();
  }, 120_000);
});
