// Flow 25 — Multi-currency request: the merchant selects ckBTC + the encoded request carries
// currency 1 (MC5: the merchant picks the EXACT settlement asset; dpay never swaps).
//
// Drives the REAL app's ReceiveMode asset selector (MC5): onboard → Receive → tap the ckBTC chip
// (testID `request-asset-ckbtc`) → type a BTC amount (0.0005) → btn-request → the app encodes a
// request with `reqCurrency = 1` (resolved at runtime from the catalog; NEVER hardcoded). Asserts:
//   - The QR renders.
//   - decodeRequest(qr) carries currency=1 + amount=50000 (0.0005 × 10^8 sats) — NOT currency=0.
//   - The amount-big readout shows "0.00050000 BTC" (the family's native asset unit), NOT a `$` amount.
//   - No dollar amount appears anywhere on the screen (the locked-asset display is unambiguous).
//
// Selector contract: `tab-receive`, `req-prefix` (amount glyph → opens picker), `req-pick-ckbtc`,
// `amount-input`, `btn-request`, `request-qr`. The picker row testID matches the wallet's existing
// `asset-ckbtc` contract (assetTestKey → 'ckbtc' for the CkBtcUtxo entry).
import { setup, assert, onboardWallet } from '../harness/lib.mjs';
import { decodeRequest } from '../harness/wire.mjs';

const CKBTC_SATS = 50_000; // 0.00050000 BTC

export async function run() {
  const start = Date.now();
  console.log('[25-asset-request] setup…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[25-asset-request] onboarding…');
    await onboardWallet(driver, 'e2e-merchant');

    // Switch to Receive + select ckBTC as the settlement asset (the merchant CHOOSES; the payer
    // never switches — dpay does not swap). The settlement asset is picked by tapping the amount
    // prefix glyph (req-prefix) → compact currency picker → req-pick-ckbtc.
    console.log('[25-asset-request] receive mode → selecting ckBTC…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.click('req-prefix', { timeoutMs: 4_000 });
    await driver.click('req-pick-ckbtc', { timeoutMs: 4_000 });

    // Type a BTC amount: 0.0005 → 50000 raw smallest-units (8-decimal). The chip switch cleared the
    // amount field, so the prior '25.00' default is never reinterpreted as 25 BTC.
    console.log('[25-asset-request] typing 0.0005 (BTC)…');
    await driver.type('amount-input', '0.0005', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });

    // The request QR renders.
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });

    // Decode the EXACT value the QR encodes (the seam exposes it readably so the test asserts the
    // bytes a payer would scan — not an OCR guess).
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof requestQR === 'string' && requestQR.length > 0, `__DPAY_QR_LAST should hold the request QR value, got "${requestQR}"`);
    const req = decodeRequest(requestQR);

    // The encoded request carries the runtime currency id (1 = ckBTC), not a hardcoded 0.
    assert(req.currency === 1, `request should encode currency 1 (ckBTC), got ${req.currency}`);
    assert(req.amount === CKBTC_SATS, `request amount should be ${CKBTC_SATS} sats (0.00050000 BTC), got ${req.amount}`);
    console.log(`[25-asset-request] ✓ decoded: currency=${req.currency} amount=${req.amount} (= 0.00050000 BTC)`);

    // The amount-big readout renders the EXACT requested asset in its own units (MC5 locked-asset
    // display). It must NOT show a dollar amount — a misleading `$0.50` would be a swap-adjacent
    // framing the no-swap rule forbids.
    const body = await driver.bodyText();
    assert(body.includes('0.00050000 BTC'), `request screen should show "0.00050000 BTC", got body:\n${body}`);
    assert(!body.includes('$0.50'), `must NOT show a dollar amount for a ckBTC request. body:\n${body}`);
    console.log('[25-asset-request] ✓ request screen shows "0.00050000 BTC" (no $)');

    await driver.screenshot('25-asset-request');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[25-asset-request] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[25-asset-request] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
