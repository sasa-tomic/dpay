/**
 * Flow 38 relay-retarget — the jest twin of `e2e/tests/38-relay-retarget.mjs`, BOTH legs.
 *
 * Leg 1: switching the app's relay via Settings retargets the polls LIVE (SettingsSheet apply →
 * parent list state → poll effect re-run, OPEN_ISSUES #6's abort+generation race fix).
 *
 * Leg 2 (the gold-standard proof, below): the retarget as a balance CHANGE — ∂100.00 on relay A,
 * ∂500.00 funded out-of-band on an independently spawned relay B (startFlowRelay), Settings
 * switch, the header follows. Proves the poll BOTH stopped hitting A AND started hitting B.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assertEq, faucetAccount, onboardWallet, openBalances, relayGet,
} from '../harness/lib';
import {startFlowRelay} from '../harness/flowRelay';
import {freshContext} from '../onboard/helpers';

describe('flow 38 — relay-retarget', () => {
  it('a Settings relay edit applies normalized, persists, and the polls follow the live switch', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-retarget');
    const identity = await accountOf(m);
    const accountHex = identity?.publicHex ?? '';
    expect(accountHex).toHaveLength(64);

    // Ground truth on the current (default) relay: the poll answers through it.
    const before = await relayGet(`/api/v1/balances/${accountHex}`);

    // Switch the app's relay via Settings — the SAME list, re-applied as an explicit edit
    // (the harness fetch rewrite keeps the default origin on the test relay, so a same-URL
    // apply exercises the live re-point without leaving the offline relay).
    await m.driver.click('btn-settings', {timeoutMs: 4000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    await m.driver.type('settings-relay', 'https://dpay.kalaj.org/', {timeoutMs: 4000});
    await m.driver.click('btn-relay-apply', {timeoutMs: 4000});
    // The applied list comes back NORMALIZED (no trailing slash).
    assertEq(m.driver.readInputValue('settings-relay'), 'https://dpay.kalaj.org',
      'the applied list is normalized');
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    // The polls retargeted LIVE: the balance still renders its relay-answered figure (the poll
    // effect re-ran against the applied list — aborted in-flight fetches, stale results rejected).
    await openBalances(m);
    expect(await m.driver.waitForText('∂100.00', {timeoutMs: 9000})).toBe(true);
    const after = await relayGet(`/api/v1/balances/${accountHex}`);
    expect(after).toEqual(before); // the same relay answers — the figure is unchanged, the walk moved

    await m.unmount();
  }, 120_000);

  it('leg 2 — the balance CHANGE: ∂100 on relay A retargets to relay B\'s out-of-band ∂500 through the live Settings switch', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-retarget-b'); // ∂100.00 from relay A's faucet
    const identity = await accountOf(m);
    const accountHex = identity?.publicHex ?? '';

    // Relay B: an independent test-helpers relay (own fake-IC gateway, own faucet, own port).
    // It starts EMPTY; the distinct balance is what makes the retarget observable as a CHANGE.
    const r2 = await startFlowRelay();
    const funded = await faucetAccount(accountHex, 50_000, {baseURL: r2.baseURL}); // ∂500.00 raw
    expect(funded.ok).toBe(true);

    // Switch the app to relay B via Settings — the polls retarget LIVE (no reload).
    await m.driver.click('btn-settings', {timeoutMs: 4000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    await m.driver.type('settings-relay', r2.baseURL, {timeoutMs: 4000});
    await m.driver.click('btn-relay-apply', {timeoutMs: 4000});
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    // The header balance must change to relay B's ∂500.00 — proving the poll now hits B (and no
    // longer trusts A's ∂100.00).
    await openBalances(m);
    expect(await m.driver.waitForText('∂500.00', {timeoutMs: 9000})).toBe(true);

    await m.unmount();
  }, 120_000);
});
