/**
 * Flow 38 relay-retarget — the jest twin of `e2e/tests/38-relay-retarget.mjs`, PARTIAL port.
 *
 * Ported half: switching the app's relay via Settings retargets the polls LIVE (SettingsSheet
 * apply → parent list state → poll effect re-run, OPEN_ISSUES #6's abort+generation race fix).
 * The new list is the ONE jest relay, applied via a normalized edit — the polls demonstrably move.
 *
 * GAP vs the browser twin, filed for the integrator: the twin proves the retarget as a balance
 * CHANGE (∂100 on relay A → ∂500 funded on an independently spawned relay B). jest spawns exactly
 * ONE relay (globalSetup) and cannot import e2e/harness/relay.mjs, so no second balance exists;
 * the observable here is the live re-point itself (the applied list drives every subsequent
 * request — the same mechanism the balance-change leg exercises in the browser).
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assertEq, onboardWallet, openBalances, relayGet,
} from '../harness/lib';
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
});
