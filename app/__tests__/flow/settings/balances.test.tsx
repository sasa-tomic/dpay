/**
 * Flow 54 testnet-toggle — the jest twin of `e2e/tests/54-testnet-toggle.mjs`.
 *
 * The REAL catalog's testnet section carries currencies 3/4/5, so the reveal toggle renders; all
 * three testnet rows are filtered out by default, revealed on tap with their exact
 * testnetDisplayNames, and hidden again on the second tap.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {onboardWallet, openBalances} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const TESTNET_ROWS = [
  {tid: 'asset-ckbtc-testnet', name: 'BTC testnet'},
  {tid: 'asset-cksepoliausdc-testnet', name: 'USDC testnet'},
  {tid: 'asset-cksepoliaeth-testnet', name: 'ETH testnet'},
];
const TESTNET_TIDS = TESTNET_ROWS.map((r) => r.tid);

hermeticDescribe('flow 54 — testnet-toggle', () => {
  it('testnet rows hidden by default, revealed with testnet names, hidden again', async () => {
    const m = await onboardWallet('e2e-testnet');

    // The toggle renders because the catalog has testnet currencies.
    await openBalances(m);
    await m.driver.findByTestID('btn-toggle-testnet', {timeoutMs: 8000});

    // Before reveal, all three testnet rows are filtered out.
    for (const tid of TESTNET_TIDS) {
      expect({tid, present: m.driver.isPresent(tid)}).toEqual({tid, present: false});
    }

    // Tap reveal → all three rows appear (the driver reads each row's subtree text).
    await m.driver.click('btn-toggle-testnet', {timeoutMs: 5000});
    for (const {tid, name} of TESTNET_ROWS) {
      await m.driver.findByTestID(tid, {timeoutMs: 5000});
      expect({tid, text: m.driver.readText(tid), name}).toEqual({tid, text: expect.stringContaining(name), name});
    }

    // Tap hide → all three rows disappear again.
    await m.driver.click('btn-toggle-testnet', {timeoutMs: 5000});
    for (const tid of TESTNET_TIDS) {
      await m.driver.waitGone(tid, {timeoutMs: 5000});
    }

    await m.unmount();
  }, 90_000);
});
