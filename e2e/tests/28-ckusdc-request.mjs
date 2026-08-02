// Flow 28 — Multi-currency request (ckUSDC): the merchant selects ckUSDC + the encoded request
// carries currency 2 (6-decimal). Closes gap #2 (ReceiveMode ckUSDC merchant-create — flow 31
// covers the pay side, not the merchant-create side) + gap #9 (fills the empty #28 slot).
//
// Mirrors `25-asset-request.mjs` (ckBTC) but selects ckUSDC (currency 2, 6 decimals) and asserts the
// 6-decimal encode contract (the precision space DEMO's 2 decimals could never produce):
//   - The QR renders.
//   - decodeRequest(qr) carries currency=2 + amount='50000' (0.05 × 10^6, byte-exact STRING — no
//     float drift, no '.' artifact).
//   - The amount-big readout shows "0.050000 USDC" (6-decimal zero-padded, backing_symbol suffix).
//   - No "$0.05" appears (fmtCurrencyAmount uses backing_symbol as the unit suffix, NOT the $ glyph;
//     a 2-decimal DEMO mis-encode would render 50000 raw as ∂500.00, not 0.050000 USDC).
//
// Selector contract: `tab-receive`, `req-prefix` (amount glyph → opens picker),
// `req-pick-ckusdc` (assetTestKey → 'ckusdc' for the CkEthErc20 descriptor), `amount-input`,
// `btn-request`, `request-qr`. QR seam: `window.__DPAY_QR_LAST`.
import { setup, assert, onboardWallet } from '../harness/lib.mjs';
import { decodeRequest } from '../harness/wire.mjs';

const CKUSDC_CURRENCY = 2;
const CKUSDC_RAW = 50_000; // 0.050000 USDC (6-decimal)
const EXPECTED_DISPLAY = '0.050000 USDC';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '28',
  name: 'ckusdc-request',
  journey: 'pay',
  covers: ['ckusdc-merchant-create', 'request-asset-picker', 'multi-currency', '6-decimal', 'byte-exact'],
  verifies: 'ckUSDC chip + 0.05 amount → request QR encodes currency 2 + 50000 raw (6-dec); readout \'0.050000 USDC\' (no $0.05).',
  timeoutMs: 15000,
};

export async function run() {
  const start = Date.now();
  console.log('[28-ckusdc-request] setup…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[28-ckusdc-request] onboarding…');
    await onboardWallet(driver, 'e2e-merchant');

    // Switch to Receive + select ckUSDC as the settlement asset (MC5: merchant chooses; payer never
    // switches — dpay does not swap). The settlement asset is picked via the amount prefix glyph
    // (req-prefix) → compact currency picker → req-pick-ckusdc.
    console.log('[28-ckusdc-request] receive mode → selecting ckUSDC…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.click('req-prefix', { timeoutMs: 4_000 });
    await driver.click('req-pick-ckusdc', { timeoutMs: 4_000 });

    // Type a USDC amount: 0.05 → 50000 raw 6-decimal units (byte-exact; well below 2^53). The chip
    // switch cleared the amount field so the prior '25.00' default is never reinterpreted as USDC.
    console.log('[28-ckusdc-request] typing 0.05 (USDC)…');
    await driver.type('amount-input', '0.05', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });

    // The request QR renders.
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });

    // Decode the EXACT value the QR encodes (the seam exposes it so the test asserts the bytes a
    // payer would scan — not an OCR guess).
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof requestQR === 'string' && requestQR.length > 0, `__DPAY_QR_LAST should hold the request QR value, got "${requestQR}"`);
    const req = decodeRequest(requestQR);

    // The encoded request carries the runtime currency id (2 = ckUSDC), not a hardcoded 0 or 1.
    assert(req.currency === CKUSDC_CURRENCY, `request should encode currency ${CKUSDC_CURRENCY} (ckUSDC), got ${req.currency}`);
    // 6-decimal byte-exact discipline: 0.05 × 10^6 = 50000, an integer string (no float artifact).
    assert(req.amount === String(CKUSDC_RAW), `request amount should be ${CKUSDC_RAW} raw (0.050000 USDC), got ${req.amount}`);
    assert(!req.amount.includes('.'), `raw amount must be an integer string (no float artifact), got ${req.amount}`);
    console.log(`[28-ckusdc-request] ✓ decoded: currency=${req.currency} amount=${req.amount} (= 0.050000 USDC)`);

    // The amount-big readout renders the EXACT requested asset in its own 6-decimal units (MC5
    // locked-asset display via fmtCurrencyAmount → backing_symbol suffix). It must NOT show a "$0.05"
    // dollar framing — fmtCurrencyAmount uses the unit suffix, not the currencySymbol glyph.
    const body = await driver.bodyText();
    assert(body.includes(EXPECTED_DISPLAY), `request screen should show "${EXPECTED_DISPLAY}", got body:\n${body}`);
    assert(!body.includes('$0.05'), `must NOT show a dollar amount for a ckUSDC request. body:\n${body}`);
    console.log(`[28-ckusdc-request] ✓ request screen shows "${EXPECTED_DISPLAY}" (no $0.05)`);

    await driver.screenshot('28-ckusdc-request');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[28-ckusdc-request] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[28-ckusdc-request] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
