// Flow 131 — Receive on home=EUR: ONE address surface, exactly like any single-rail currency
// (the 2026-09-19 VEUR retirement collapsed the former dual-rail disclosure).
//
// EUR used to default Receive ▸ "My address" to EURC@Solana and offer the VEUR@IC principal one
// toggle away, with the thin-liability note riding the disclosure. With VEUR retired, EUR has ONE
// rail, so the whole rail machinery renders NOTHING: `RailDisclosure` nulls outside a two-rail
// group (the same rule CHF has always followed — flow 122's control), leaving Receive ▸ "My
// address" as the plain EURC ATA surface. This flow pins:
//
//   * The surface IS the EURC ATA: base58-shaped, derived from the onboarding seed.
//   * NO rail disclosure survives the retirement: no pick-and-why line, no fee line, no
//     two-sided toggle, and no thin-liability note anywhere (VEUR was the only thin rail).
//   * The ATA is stable across leaving and re-opening the sub-mode (the harness has no
//     independent ATA derivation — stability under one identity is the bound).
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency,
 waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '131',
  name: 'eur-receive-single-rail',
  journey: 'deposit',
  covers: ['home-currency', 'receive', 'rails', 'eur', 'eurc', 'rail-health', 'fees'],
  verifies: 'Receive ▸ My address on home=EUR — single-rail since the 2026-09-19 VEUR retirement — lands directly on the EURC ATA (base58, seed-derived) with NO rail disclosure at all: no why/fee lines, no two-sided toggle, no thin-liability note (uniform with CHF), and the ATA is stable across a leave-and-return.',
  timeoutMs: 90000,
};

// base58 (Bitcoin alphabet) — the Solana address charset. 32–44 chars is the valid pubkey range.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function run() {
  const start = Date.now();
  console.log('[131-eur-receive-single-rail] setup (relay + web + browser, solStub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[131-eur-receive-single-rail] onboarding, pinning home=EUR…');
    await onboardWallet(driver, 'e2e-eur-receive');
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-currency-EUR', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});
    await waitForWallet(driver, {timeoutMs: 8_000});
    await openBalances(driver);
    await selectCurrency(driver, 'sol-eurc');

    // The Solana RPC simulator (same seam as every SOL flow): the EURC ATA EXISTS with a zero
    // balance, so the address surface is READY rather than the setup gate.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 0, token: {amount: '0', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: '11111111111111111111111111111111', lamports: 2039280}}),
        getBalance: () => ({value: 0}),
        getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}}),
      };
    });

    // 1. The surface IS the EURC ATA — and NO rail machinery renders for a one-rail currency.
    console.log('[131-eur-receive-single-rail] opening Receive ▸ My address on EURC…');
    await driver.click('tab-receive');
    await driver.click('btn-receive-address');
    const eurcAddr1 = (await driver.readText('sol-receive-address', {timeoutMs: 10_000})).trim();
    assert(BASE58.test(eurcAddr1), `the EURC address is a valid base58 ATA, got "${eurcAddr1}"`);
    assert(!(await driver.isPresent('receive-rail-disclosure')),
      'a single-rail currency renders NO rail disclosure — the component nulls outside a two-rail group (uniform with CHF, flow 122)');
    assert(!(await driver.isPresent('receive-rail-why')) && !(await driver.isPresent('receive-rail-fee')),
      'no pick-and-why line and no fee line survive the retirement — the disclosure they lived on is gone');
    assert(!(await driver.isPresent('receive-rail-toggle'))
      && !(await driver.isPresent('btn-receive-rail-right')) && !(await driver.isPresent('btn-receive-rail-left')),
      'no rail toggle may remain — there is no sibling rail to flip to (VEUR retired 2026-09-19)');
    const body = await driver.bodyText();
    assert(!body.includes('Thin liquidity'),
      `the thin-liability note renders NOWHERE on the surface — VEUR was the only thin rail. Got: ${JSON.stringify(body.slice(0, 400))}`);
    assert(!body.includes('VEUR'),
      `the retired rail must not survive as copy anywhere on the receive surface. Got: ${JSON.stringify(body.slice(0, 400))}`);
    await driver.screenshot('131-eur-receive-eurc');
    console.log('[131-eur-receive-single-rail] ✓ EURC ATA surface with no rail disclosure, toggle, or thin note');

    // 2. Leave and re-open: the SAME derivation (same identity, single rail).
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    const eurcAddr2 = (await driver.readText('sol-receive-address', {timeoutMs: 10_000})).trim();
    assertEq(eurcAddr2, eurcAddr1, 'the EURC ATA is stable across a leave-and-return (same wallet)');
    console.log('[131-eur-receive-single-rail] ✓ re-open lands on the same ATA');

    console.log(`[131-eur-receive-single-rail] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[131-eur-receive-single-rail] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
