/**
 * Flow 43 — the jest twin of `e2e/tests/43-decimal-edges.mjs` (8-dec ckBTC + 6-dec ckUSDC + 18-dec
 * ckETH, display-truncated to 6, on the payment sign surface — no rounding, no sci-notation, no
 * trailing-zero drift).
 *
 * Each case injects a request QR through the camera seam; the wallet holds no funds in these
 * currencies, so the sign lands on the honest read-only surface (the gateway rejection rides
 * alongside) — the format assert runs against that stable surface. Cancel resets PayMode between
 * cases; each case re-enters via a fresh scan.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {armPayScan, assert, assertIncludes, generateKeypair, onboardWallet} from '../harness/lib';
import {DpayCore} from '../harness/lib';
import {clickByA11yLabel, scanSeam} from './local';

const CKBTC_CURRENCY = 1;
const CKUSDC_CURRENCY = 2;
const CKETH_CURRENCY = 6;

// `expected` is the exact substring the sign status's pay-amount must contain (the compact
// formatter: trailing zeros trimmed, never rounded). BigInt literals REQUIRED for ckETH: the mid
// + pad raw values exceed 2^53.
const CASES = [
  {label: 'ckBTC mid (12345678 sats)', currency: CKBTC_CURRENCY, raw: '12345678', expected: '0.12345678 BTC'},
  {label: 'ckBTC low (1 sat)', currency: CKBTC_CURRENCY, raw: '1', expected: '0.00000001 BTC'},
  {label: 'ckBTC pad (100000000 sats)', currency: CKBTC_CURRENCY, raw: '100000000', expected: '1 BTC'},
  {label: 'ckUSDC mid (1234567 raw)', currency: CKUSDC_CURRENCY, raw: '1234567', expected: '1.234567 USDC'},
  {label: 'ckUSDC low (1 raw)', currency: CKUSDC_CURRENCY, raw: '1', expected: '0.000001 USDC'},
  {label: 'ckUSDC pad (1000000 raw)', currency: CKUSDC_CURRENCY, raw: '1000000', expected: '1.00 USDC'},
  {label: 'ckETH mid (1234567890123456789 wei)', currency: CKETH_CURRENCY, raw: '1234567890123456789', expected: '1.234567 ETH'},
  {label: 'ckETH low (1 wei)', currency: CKETH_CURRENCY, raw: '1', expected: '< 0.000001 ETH'},
  {label: 'ckETH pad (1000000000000000000 wei)', currency: CKETH_CURRENCY, raw: '1000000000000000000', expected: '1 ETH'},
];

hermeticDescribe('flow 43 — decimal edges on the sign surface (8-dec, 6-dec, 18-dec-truncated)', () => {
  it('every case renders the exact compact decimal string, no rounding and no sci-notation', async () => {
    const bob = await generateKeypair();
    const m = await onboardWallet('jest-decimal');
    const expiry = Math.floor(Date.now() / 1000) + 600;

    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i];
      const nonce = `${i}${i}`.repeat(16); // 32 hex chars — fresh per case (never reuse nonces)
      const requestQR = await DpayCore.encodeRequest(bob.publicHex, c.raw, nonce, expiry, c.currency, 'merchant', '');

      await armPayScan(m);
      await m.driver.settleFrames(1);
      scanSeam()(requestQR);
      await m.driver.findByTestID('pay-amount', {timeoutMs: 8000});
      const payAmt = m.driver.readText('pay-amount');
      assertIncludes(payAmt, c.expected, `case "${c.label}" pay-amount should include the exact decimal string`);
      expect(payAmt).not.toMatch(/\de[+-]\d/i); // no scientific notation (the float failure mode)

      // Reset via the sign surface's Cancel link; the scan surface comes back for the next case.
      if (i < CASES.length - 1) {
        await clickByA11yLabel(m, 'Cancel');
        await m.driver.waitGone('pay-amount', {timeoutMs: 4000});
        await m.driver.findByTestID('pay-scan', {timeoutMs: 8000});
      }
    }

    await m.unmount();
    void assert;
  }, 150_000);
});
