/**
 * Flows 27 + 31 — the jest twins of `e2e/tests/27-asset-pay.mjs` and `e2e/tests/31-ckusdc-pay.mjs`
 * (multi-currency pay: the payer sees + pays the EXACT requested asset; the balance gate compares
 * ONLY that asset's balance — dpay never swaps).
 *
 * 27 (ckBTC, currency 1): A is faucet-funded 60000 sats at her principal; B requests 50000 sats;
 * the OLD cross-asset gate (sats vs DEMO cents) would have blocked — the per-asset gate lets the
 * auto-sign through → Paid; B credited on currency 1; the Ledger row shows the FEE-INCLUSIVE net
 * debit in ckBTC units with the fee only as the annotation line. 31 (ckUSDC, currency 2, 6-dec):
 * the request carries the byte-exact NETTED wire 40000 (0.05 price − 0.01 fee); the Paid total
 * debit is exactly the typed price ("0.05 USDC"); B nets the wire (40000 credited).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {ceiling as budgetCeiling} from '../harness/budget';
import {
  accountOf, armPayScan, assert, assertEq, assertIncludes, faucetAccount, generateKeypair,
  getBalance, onboardWallet, openBalances,
} from '../harness/lib';
import {DpayCore} from '../harness/lib';
import {scanSeam} from './local';

const CKBTC_CURRENCY = 1;
const CKUSDC_CURRENCY = 2;
const SEED_SATS = '60000'; // 0.00060000 BTC
const PAY_SATS = '50000'; // 0.0005 BTC
const CKUSDC_FEE_RAW = 10_000; // the ckUSDC catalog fee (0.01 USDC) — netted out of the quoted wire
const CKUSDC_WIRE_RAW = '40000'; // 0.05 price − 0.01 fee = 0.04 × 10^6, byte-exact

function nonce(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0').repeat(4);
}

hermeticDescribe('flow 27 — asset-pay (ckBTC, per-asset balance gate, ledger units)', () => {
  it('60000 sats ≥ 50000 sats → Paid on currency 1; the Ledger row shows the exact ckBTC units', async () => {
    const m = await onboardWallet('jest-asset-pay');
    const accountHex = (await accountOf(m))!.publicHex;

    // Fund ckBTC at A's principal so assetBalances[1] is non-zero; the poll surfaces it in Balances.
    const funded = await faucetAccount(accountHex, Number(SEED_SATS), {currency: CKBTC_CURRENCY});
    assert(funded.ok, `faucet ckBTC funding should succeed, got ${funded.status}`);
    await openBalances(m);
    assert(await m.driver.waitForText('0.0006 BTC', {timeoutMs: 10_000}),
      'A should render 0.0006 BTC in the Balances BTC row (assetBalances[1] populated)');
    await m.driver.click('tab-pay', {timeoutMs: 5000});

    // B (the payee) builds a ckBTC request: 50000 sats.
    const bob = await generateKeypair();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = await DpayCore.encodeRequest(bob.publicHex, PAY_SATS, nonce(), expiry, CKBTC_CURRENCY, 'Bob', '');

    // A scans → the per-asset gate (60000 ≥ 50000 sats) lets the AUTO-SIGN through.
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(requestQR);
    expect(await m.driver.waitForText('Paid', {timeoutMs: 10_000})).toBe(true);

    // B credited on currency 1 at her principal (the request's exact asset — no substitution).
    assertEq(await getBalance(bob.publicHex, CKBTC_CURRENCY), PAY_SATS, 'payee B ckBTC balance after settle');

    // The payer's Ledger row: the FEE-INCLUSIVE net debit in ckBTC units + the fee annotation line,
    // never a dollar amount (the row headlines note.gross; fees ride only as the annotation).
    // The row lands through the transactions poll AFTER the Ledger renders - wait for the EVENT,
    // not the screen (the bare assert raced the poll under box load; 2026-10-01 flow 27).
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Recent', {timeoutMs: 8000}), 'the Ledger should render the ckBTC row');
    assert(await m.driver.waitForText('0.0005001 BTC', {timeoutMs: 10_000}),
      'Ledger row must show the fee-inclusive net ckBTC debit');
    const ledgerBody = m.driver.bodyText();
    assertIncludes(ledgerBody, '0.0005001 BTC', 'Ledger row must show the fee-inclusive net ckBTC debit');
    assertIncludes(ledgerBody, '0.0000001 BTC fees', 'Ledger row must annotate the pinned 10-sat ledger fee');
    expect(ledgerBody).not.toContain('$');

    await m.unmount();
  }, budgetCeiling(90_000));
});

hermeticDescribe('flow 31 — ckusdc-pay (6-decimal, byte-exact netted wire, price-exact total)', () => {
  it('wire 40000 raw is byte-exact; Paid totals exactly the price; B nets the wire', async () => {
    const m = await onboardWallet('jest-ckusdc-pay');
    const accountHex = (await accountOf(m))!.publicHex;

    // Fund ckUSDC (60000 raw = 0.06 USDC — covers the 50000 price exactly).
    const funded = await faucetAccount(accountHex, 60_000, {currency: CKUSDC_CURRENCY});
    assert(funded.ok, `faucet ckUSDC funding should succeed, got ${funded.status}`);
    await openBalances(m);
    assert(await m.driver.waitForText('$0.06', {timeoutMs: 10_000}),
      'A should render the USDC row after funding (assetBalances[2] populated)');
    await m.driver.click('tab-pay', {timeoutMs: 5000});

    // B builds the NETTED request a dpay payee quotes: 0.05 price − 0.01 fee = 40000 raw 6-dec.
    const bob = await generateKeypair();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = await DpayCore.encodeRequest(bob.publicHex, CKUSDC_WIRE_RAW, nonce(), expiry, CKUSDC_CURRENCY, 'Bob', '');

    // BYTE-EXACT: the encoded raw wire is "40000" (a 2-dec DEMO path would have mangled this).
    const decoded = await DpayCore.decodeRequest(requestQR);
    assertEq(decoded.currency, CKUSDC_CURRENCY, 'request should encode currency 2 (ckUSDC)');
    assertEq(decoded.amount, CKUSDC_WIRE_RAW, 'request amount should be the byte-exact netted wire');
    expect(decoded.amount).not.toContain('.');

    // A scans → the per-asset gate (60000 ≥ the 50000 price) lets the auto-sign through.
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(requestQR);
    expect(await m.driver.waitForText('Paid', {timeoutMs: 10_000})).toBe(true);
    // Paid shows the TOTAL DEBIT — wire 40000 + fee 10000 = exactly the typed price (async fee
    // fetch, so wait for it).
    assert(await m.driver.waitForText('0.05 USDC', {timeoutMs: 25_000}),
      'Paid screen should show the fee-inclusive total "0.05 USDC" — the customer pays exactly the price');

    // B credited the raw wire on currency 2 (the fee is B's cost as the payee — she nets it).
    assertEq(await getBalance(bob.publicHex, CKUSDC_CURRENCY), CKUSDC_WIRE_RAW,
      'payee B ckUSDC balance after settle (the netted wire)');
    void CKUSDC_FEE_RAW;

    await m.unmount();
  }, budgetCeiling(90_000));
});
