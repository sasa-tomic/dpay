/**
 * Flows 122 + 131 — the jest twins of `e2e/tests/122-receive-rail-choice.mjs` and
 * `131-eur-receive-rail.mjs` (the Receive rail machinery).
 *
 * 122: on a two-rail home currency (USD = ckUSDC@IC + USDC@Solana), Receive ▸ "My address"
 * defaults to the wallet's own pick (ckUSDC, pure preference — no reason suffix), names the rail,
 * states the rail's fee fact in the rail's OWN unit, offers the sibling rail one toggle away
 * WITHOUT leaving the sub-mode, and both addresses belong to the user (IC = the wallet's ICRC-1
 * principal; the Solana ATA is base58 + stable). The ckERC20 Ethereum route is REACHABLE on the
 * home rail. Control: single-rail CHF renders the plain principal sheet with NO disclosure.
 * 131: home=EUR is single-rail since the VEUR retirement — the EURC ATA with NO rail machinery at
 * all (no why/fee lines, no toggle, no thin-liability note, no VEUR copy anywhere).
 *
 * LOAD-ORDER CONTRACT: the RPC override is set before the harness require (see ../pay/solrpc).
 */
import {beforeEach, describe, it, expect} from '@jest/globals';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from '../pay/solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();
// The zero-balance stub answers (accounts exist, balances zero) — the exact answers the e2e twins
// install. Re-armed per test: the lane helper's lifecycle beforeEach wipes the SOL seams, and a
// balance-poll tick with the URL override 'stub' but no stub object would fetch('stub') and trip
// the harness's fail-closed request rule. Registered AFTER the require of './h' (which installs
// the lifecycle), so this beforeEach runs after the wipe and the stub is live from the first tick.
const ZERO_BALANCE_STUB = baseSolStub({
  getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 0, token: {amount: '0', decimals: 6}}),
  getBalance: () => ({value: 0}),
});
beforeEach(() => {
  G.__DPAY_TEST_SOLANA_RPC_STUB = ZERO_BALANCE_STUB;
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const h = require('./h') as typeof import('./h');
const {
  accountOf, assert, assertEq, assertIncludes, onboardWallet, openBalances, railPrincipalText,
  readStable, selectCurrency, selectSolRail, waitForWallet,
} = h;

// base58 (Bitcoin alphabet) — the Solana address charset. 32–44 chars is the valid pubkey range.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

describe('flow 122 — receive rail choice: the wallet pick, disclosed, with the sibling one toggle away', () => {
  it('USD defaults to ckUSDC with fee facts + own addresses; single-rail CHF has no disclosure', async () => {
    const m = await onboardWallet('jest-rails');
    // The wallet must be IN dollars: CURRENCY_RAILS.USD is ['ckUSDC', 'USDC'] — the two-rail group.
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-USD', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m);
    await selectCurrency(m, 'ckusdc');
    const account = await accountOf(m);
    const wantPrincipal = await railPrincipalText(account!.publicHex);


    // 1. Receive ▸ "My address" defaults to the pick (ckUSDC, reason: pure preference).
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    const why1 = await readStable(m, 'receive-rail-why');
    await readStable(m, 'ic-also-address');
    assertIncludes(why1, 'ckUSDC · Internet Computer', 'the default rail is named');
    expect(why1.includes('—')).toBe(false, 'a pure preference adds no reason suffix');
    const fee1 = await readStable(m, 'receive-rail-fee');
    assertIncludes(fee1, 'Internet Computer', "the fee line names the rail's network");
    assertIncludes(fee1, 'Fee 0.01 ckUSDC', "the fee is stated in the rail's own unit (0.01 ckUSDC, 6 decimals)");
    const toggleTxt = await readStable(m, 'receive-rail-toggle');
    assertIncludes(toggleTxt, 'Internet Computer', 'the rail toggle offers the IC side');
    assertIncludes(toggleTxt, 'Solana', 'the rail toggle offers the Solana side');
    const icAddr1 = (await readStable(m, 'ic-also-address')).trim();
    assertEq(icAddr1, wantPrincipal, "the IC rail address is the wallet's own ICRC-1 principal");
    // The reachability the home-rail branch once shadowed: the ckERC20 Ethereum deposit.
    expect(m.driver.isPresent('btn-connect-wallet')).toBe(true);

    // 2. One toggle to the sibling rail: its OWN address + fee fact, still in "My address".
    await m.driver.click('btn-receive-rail-right', {timeoutMs: 5000});
    const why2 = await readStable(m, 'receive-rail-why');
    await readStable(m, 'sol-receive-address');
    assertIncludes(why2, 'USDC · Solana', 'the sibling rail is named by its own line');
    expect(why2.includes('—')).toBe(false, 'the sibling carries no reason suffix (only the pick does)');
    const fee2 = await readStable(m, 'receive-rail-fee');
    assertIncludes(fee2, 'Solana · Fee 0.000005 SOL', 'the Solana per-transfer fee is stated in SOL');
    assertIncludes(fee2, 'one-time account rent 0.00203928 SOL', 'the USDC ATA rent is disclosed as the one-time cost');
    const solAddr = (await readStable(m, 'sol-receive-address')).trim();
    assert(BASE58.test(solAddr), `the USDC rail address is a valid base58 Solana address, got "${solAddr}"`);

    // 3. Toggle back: the IC principal is the SAME (deterministic derivation of one seed).
    await m.driver.click('btn-receive-rail-left', {timeoutMs: 5000});
    const icAddr2 = (await readStable(m, 'ic-also-address')).trim();
    assertEq(icAddr2, icAddr1, 'the IC rail address is stable across a rail flip (same wallet)');

    // 4. Single-rail control: home=CHF on VCHF renders EXACTLY as before — no disclosure at all.
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-CHF', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.waitGone('receive-rail-disclosure', {timeoutMs: 3000});
    const vchfAddr = (await readStable(m, 'deposit-address')).trim();
    assertEq(vchfAddr, wantPrincipal, "the VCHF sheet still shows the wallet's own ICRC-1 principal");

    await m.unmount();
  }, 150_000);
});

describe('flow 131 — EUR receive is single-rail: the plain EURC ATA, no rail machinery', () => {
  it('home=EUR lands on the EURC ATA with no disclosure, toggle, or thin note; stable on re-open', async () => {
    const m = await onboardWallet('jest-eur-rcv');
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-EUR', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m);
    await selectSolRail(m, 'sol-eurc');


    // 1. The surface IS the EURC ATA — and NO rail machinery renders for a one-rail currency.
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    const eurcAddr1 = (await readStable(m, 'sol-receive-address')).trim();
    assert(BASE58.test(eurcAddr1), `the EURC address is a valid base58 ATA, got "${eurcAddr1}"`);
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
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    const eurcAddr2 = (await readStable(m, 'sol-receive-address')).trim();
    assertEq(eurcAddr2, eurcAddr1, 'the EURC ATA is stable across a leave-and-return (same wallet)');

    await m.unmount();
  }, 150_000);
});
