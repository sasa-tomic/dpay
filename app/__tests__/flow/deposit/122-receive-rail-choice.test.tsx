/**
 * Flow 122 receive-rail-choice — the jest twin of `e2e/tests/122-receive-rail-choice.mjs`.
 *
 * A multi-rail home currency (USD = ckUSDC@IC + USDC@Solana) defaults Receive ▸ "My address" to
 * the wallet's OWN pick (ckUSDC — preference), NAMES the rail, states the rail's fee fact in the
 * rail's OWN unit, and offers the sibling rail's OWN address one toggle away with ITS fee fact —
 * without leaving the sub-mode. Both addresses belong to the user (IC = the wallet's ICRC-1
 * principal; Solana = base58, seed-stable across a flip). The single-rail control: home=CHF on
 * VCHF renders the plain principal sheet with NO rail disclosure.
 */
// The Solana side of the USD group must EXIST (SPL rows fail-closed when the RPC override is
// empty — the jest default). Flip the override to the stub mode BEFORE the harness (and thus the
// app's constants module) loads — the e2e setup({solStub:true}) semantics. Value requires ride
// below the assignment; type-only imports are erased.
(globalThis as unknown as Record<string, unknown>).__DPAY_TEST_SOLANA_RPC_URL = 'stub';
/* eslint-disable @typescript-eslint/no-require-imports */
const {accountOf, assertEq, assertIncludes, onboardWallet, openBalances, railPrincipalText, selectCurrency, waitForWallet} = require('../harness/lib') as typeof import('../harness/lib');
const {installSolRpcStub} = require('./solRpcStub') as typeof import('./solRpcStub');
/* eslint-enable @typescript-eslint/no-require-imports */

// base58 (Bitcoin alphabet) — the Solana address charset. 32–44 chars is the valid pubkey range.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type M = import('../harness/lib').Mount;

/** Pin the home currency from Settings (the same affordance the e2e flow drives). */
async function setHomeCurrency(m: M, code: 'USD' | 'CHF'): Promise<void> {
  await m.driver.click('btn-settings', {timeoutMs: 5_000});
  await m.driver.click(`btn-currency-${code}`, {timeoutMs: 5_000});
  await m.driver.click('btn-settings-close', {timeoutMs: 5_000});
  await waitForWallet(m, {timeoutMs: 8_000});
}

import {describe, it, expect} from '@jest/globals';

describe('flow 122 — receive rail choice: the pick is named, fees are per-rail, siblings one toggle away', () => {
  it('defaults USD to ckUSDC with disclosure, flips to USDC@Solana in place, and CHF shows none', async () => {
    const m = await onboardWallet('jest-receive-rails');
    await setHomeCurrency(m, 'USD');
    await openBalances(m);
    await selectCurrency(m, 'ckusdc');
    const account = await accountOf(m);
    const wantPrincipal = await railPrincipalText(account!.publicHex);

    // The Solana RPC simulator (the same seam as every SOL flow): the ATA EXISTS with a zero USDC
    // balance, so the USDC rail's address surface is READY (not the setup gate).
    installSolRpcStub();

    // 1. Receive ▸ "My address" defaults to the pick (ckUSDC, reason: preference — no suffix).
    await m.driver.click('tab-receive', {timeoutMs: 5_000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5_000});
    const why1 = m.driver.readText('receive-rail-why');
    assertIncludes(why1, 'ckUSDC · Internet Computer', 'the default rail is named');
    expect(why1.includes('—')).toBe(false);
    const fee1 = m.driver.readText('receive-rail-fee');
    assertIncludes(fee1, 'Internet Computer', 'the fee line names the rail\'s network');
    assertIncludes(fee1, 'Fee 0.01 ckUSDC', 'the fee is stated in the rail\'s own unit (0.01 ckUSDC, 6 decimals)');
    const toggleTxt = m.driver.readText('receive-rail-toggle');
    assertIncludes(toggleTxt, 'Internet Computer', 'the rail toggle offers the IC side');
    assertIncludes(toggleTxt, 'Solana', 'the rail toggle offers the Solana side');
    // The principal text derives async on the sheet's first frames — waited for, not raced.
    await m.driver.waitForFunction(() => m.driver.isPresent('ic-also-address'),
      {timeoutMs: 5_000, label: 'the IC-receive section renders the wallet principal'});
    const icAddr1 = m.driver.readText('ic-also-address').trim();
    assertEq(icAddr1, wantPrincipal, 'the IC rail address is the wallet\'s own ICRC-1 principal');
    // The reachability the home-rail branch once shadowed: ckUSDC's own deposit is a transaction
    // the user's Ethereum wallet signs, and it must be reachable on the home rail too.
    expect(m.driver.isPresent('btn-connect-wallet')).toBe(true);

    // 2. One toggle to the sibling rail: its OWN address + fee fact, WITHOUT leaving the sub-mode.
    await m.driver.click('btn-receive-rail-right', {timeoutMs: 5_000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 10_000});
    const why2 = m.driver.readText('receive-rail-why');
    assertIncludes(why2, 'USDC · Solana', 'the sibling rail is named by its own line');
    expect(why2.includes('—')).toBe(false);
    const fee2 = m.driver.readText('receive-rail-fee');
    assertIncludes(fee2, 'Solana · Fee 0.000005 SOL', 'the Solana per-transfer fee is stated in SOL');
    assertIncludes(fee2, 'one-time account rent 0.00203928 SOL', 'the USDC ATA rent is disclosed as the one-time cost');
    const solAddr = m.driver.readText('sol-receive-address').trim();
    expect(solAddr).toMatch(BASE58);

    // 3. Toggle back: the IC principal is the SAME (deterministic derivations of this wallet's
    //    seed, not per-visit values).
    await m.driver.click('btn-receive-rail-left', {timeoutMs: 5_000});
    await m.driver.findByTestID('ic-also-address', {timeoutMs: 10_000});
    const icAddr2 = m.driver.readText('ic-also-address').trim();
    assertEq(icAddr2, icAddr1, 'the IC rail address is stable across a rail flip (same wallet)');

    // 4. Single-rail control: home=CHF on VCHF renders EXACTLY as before — no disclosure at all.
    await m.driver.click('tab-pay', {timeoutMs: 5_000});
    await setHomeCurrency(m, 'CHF');
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.click('tab-receive', {timeoutMs: 5_000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5_000});
    await m.driver.waitGone('receive-rail-disclosure', {timeoutMs: 3_000});
    await m.driver.findByTestID('deposit-address', {timeoutMs: 10_000});
    const vchfAddr = m.driver.readText('deposit-address').trim();
    assertEq(vchfAddr, wantPrincipal, 'the VCHF sheet still shows the wallet\'s own ICRC-1 principal');

    await m.unmount();
  }, 120_000);
});
