/**
 * Flow 131 eur-receive-rail — the jest twin of `e2e/tests/131-eur-receive-rail.mjs`.
 *
 * Receive on home=EUR: ONE address surface, exactly like any single-rail currency (the 2026-09-19
 * VEUR retirement collapsed the former dual-rail disclosure). The surface IS the EURC ATA
 * (base58, seed-derived); NO rail machinery renders for a one-rail currency — no pick-and-why
 * line, no fee line, no two-sided toggle, and no thin-liability note anywhere. The ATA is stable
 * across a leave-and-return.
 */
// EUR's one rail is EURC@Solana — an SPL row that is fail-closed when the RPC override is empty
// (the jest default). Flip the override to the stub mode BEFORE the harness (and thus the app's
// constants module) loads — the e2e setup({solStub:true}) semantics. Value requires ride below.
(globalThis as unknown as Record<string, unknown>).__DPAY_TEST_SOLANA_RPC_URL = 'stub';
/* eslint-disable @typescript-eslint/no-require-imports */
const {assertEq, onboardWallet, openBalances, selectSolRail} = require('../harness/lib') as typeof import('../harness/lib');
const {installSolRpcStub} = require('./solRpcStub') as typeof import('./solRpcStub');
/* eslint-enable @typescript-eslint/no-require-imports */

// base58 (Bitcoin alphabet) — the Solana address charset. 32–44 chars is the valid pubkey range.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

import {describe, it, expect} from '@jest/globals';

describe('flow 131 — EUR receive: a single-rail currency renders one plain ATA surface', () => {
  it('the EURC ATA with no rail disclosure, toggle, or thin note — stable across leave-and-return', async () => {
    // Onboard, pin home=EUR, and land on the EURC rail's "My address" surface.
    const m = await onboardWallet('jest-eur-receive');
    await m.driver.click('btn-settings', {timeoutMs: 5_000});
    await m.driver.click('btn-currency-EUR', {timeoutMs: 5_000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5_000});
    await openBalances(m);
    await selectSolRail(m, 'sol-eurc');

    // The Solana RPC simulator: the EURC ATA EXISTS with a zero balance, so the address surface
    // is READY rather than the setup gate.
    installSolRpcStub();

    // 1. The surface IS the EURC ATA — and NO rail machinery renders for a one-rail currency.
    await m.driver.click('tab-receive', {timeoutMs: 5_000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5_000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 10_000});
    const eurcAddr1 = m.driver.readText('sol-receive-address').trim();
    expect(eurcAddr1).toMatch(BASE58);
    expect(m.driver.isPresent('receive-rail-disclosure')).toBe(false);
    expect(m.driver.isPresent('receive-rail-why')).toBe(false);
    expect(m.driver.isPresent('receive-rail-fee')).toBe(false);
    expect(m.driver.isPresent('receive-rail-toggle')).toBe(false);
    expect(m.driver.isPresent('btn-receive-rail-right')).toBe(false);
    expect(m.driver.isPresent('btn-receive-rail-left')).toBe(false);
    const body = m.driver.bodyText();
    expect(body.includes('Thin liquidity')).toBe(false);
    expect(body.includes('VEUR')).toBe(false);

    // 2. Leave and re-open: the SAME derivation (same identity, single rail).
    await m.driver.click('tab-pay', {timeoutMs: 5_000});
    await m.driver.click('tab-receive', {timeoutMs: 5_000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5_000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 10_000});
    const eurcAddr2 = m.driver.readText('sol-receive-address').trim();
    assertEq(eurcAddr2, eurcAddr1, 'the EURC ATA is stable across a leave-and-return (same wallet)');

    await m.unmount();
  }, 120_000);
});
