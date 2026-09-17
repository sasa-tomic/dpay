// Flow 28 — Multi-currency request (ckUSDC): the merchant selects ckUSDC + the request carries
// currency 2 (6-decimal). Closes gap #2 (ReceiveMode ckUSDC merchant-create — flow 31
// covers the pay side, not the merchant-create side) + gap #9 (fills the empty #28 slot).
//
// Founder decision 2026-09-12: the request QR is the payment LINK, so the merchant-create contract
// asserts the LINK (asset ckUSDC, network, netted amount, own principal) AND — with the radio
// forced ready — the 132-byte wire the NFC reader arms with, which is where the 6-decimal
// byte-exact encode contract still lives. Founder rule 2026-09-12: the customer pays exactly the
// price, the payee nets the ledger fee — the link `amount=` and the NFC wire both carry the
// NETTED wire (typed price − fee):
//   - decodeRequest(reader) carries currency=2 + amount='40000' (0.05 price − 0.01 fee = 0.04 ×
//     10^6, byte-exact STRING — no float drift, no '.' artifact).
//   - The amount-big readout shows "0.050000 USDC" (the typed price, 6-decimal zero-padded,
//     backing_symbol suffix) + the fee line "you receive 0.04 USDC".
//   - No "$0.05" appears (fmtCurrencyAmount uses backing_symbol as the unit suffix, NOT the $ glyph;
//     a 2-decimal DEMO mis-encode would render 50000 raw as ∂500.00, not 0.050000 USDC).
//
// Selector contract: `tab-receive`, `req-prefix` (amount glyph → opens picker),
// `req-pick-ckusdc` (assetTestKey → 'ckusdc' for the CkEthErc20 descriptor), `amount-input`,
// `btn-request`, `request-qr`. QR seam: `window.__DPAY_QR_LAST`; wire seam:
// `window.__DPAY_TEST_NFC_READER_REQUEST`.
import { setup, assert, onboardWallet, accountOf, railPrincipalText } from '../harness/lib.mjs';
import { decodeRequestHex } from '../harness/wire.mjs';
import { parsePayLink } from '../harness/paylink.mjs';

const CKUSDC_CURRENCY = 2;
const CKUSDC_RAW = 50_000; // 0.050000 USDC (6-decimal) — the typed PRICE the customer pays, exactly
const CKUSDC_FEE = 10_000; // ckUSDC catalog fee — the payee's cost (0.010000 USDC)
const CKUSDC_WIRE = CKUSDC_RAW - CKUSDC_FEE; // 40_000 — the netted wire the link + NFC carry (price − fee)
const EXPECTED_DISPLAY = '0.05 USDC';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '28',
  name: 'ckusdc-request',
  journey: 'pay',
  covers: ['ckusdc-merchant-create', 'request-asset-picker', 'multi-currency', '6-decimal', 'byte-exact', 'pay-link'],
  verifies: 'ckUSDC chip + 0.05 price → QR is the payment LINK with the NETTED amount (ckUSDC/IC/0.04 = price − fee, own principal); NFC wire encodes currency 2 + 40000 raw (6-dec, netted); readout headlines \'0.05 USDC\' with a fee line "you receive 0.04 USDC" (no $0.05).',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[28-ckusdc-request] setup…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[28-ckusdc-request] onboarding…');
    // Force the radio ready so the request ALSO builds the NFC machine code (its one surface now)
    // and the reader arms — the wire-seam read below depends on it.
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });
    await onboardWallet(driver, 'e2e-merchant');
    const accountHex = (await accountOf(driver))?.publicHex;

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

    // Parse the EXACT value the QR encodes (the seam exposes it so the test asserts the string a
    // payer's camera would open — not an OCR guess). Founder 2026-09-12: that string is the LINK.
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof requestQR === 'string' && requestQR.length > 0, `__DPAY_QR_LAST should hold the request QR value, got "${requestQR}"`);
    const link = parsePayLink(requestQR);
    assert(link !== null, `the request QR must BE the payment link, got "${requestQR}"`);
    const selfPrincipal = await railPrincipalText(accountHex);
    assert(link.recipient === selfPrincipal, `the link must pay THIS wallet's principal, got "${link.recipient}"`);
    assert(link.asset === 'ckUSDC', `the link must name ckUSDC, got "${link.asset}"`);
    assert(link.network === 'internet-computer', `the link must name the settlement chain, got "${link.network}"`);
    assert(link.amount === '0.04', `the link carries the netted wire (price 0.05 − fee 0.01), got "${link.amount}"`);
    console.log('[28-ckusdc-request] ✓ QR is the payment link (ckUSDC, own principal)');

    // The wire the NFC reader armed with carries the runtime currency id (2 = ckUSDC), not a
    // hardcoded 0 or 1.
    let readerHex = null;
    for (let i = 0; i < 100 && !readerHex; i++) {
      readerHex = await driver.eval(() => window.__DPAY_TEST_NFC_READER_REQUEST ?? null);
      if (!readerHex) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(typeof readerHex === 'string' && readerHex.length > 0, 'the NFC reader must arm with the 132-byte wire request');
    const req = decodeRequestHex(readerHex);

    // 6-decimal byte-exact discipline: 0.05 price − 0.01 fee = 0.04 × 10^6 = 40000, an integer
    // string (no float artifact). The wire nets the fee — the payer's total debit is the price.
    assert(req.currency === CKUSDC_CURRENCY, `request should encode currency ${CKUSDC_CURRENCY} (ckUSDC), got ${req.currency}`);
    assert(req.amount === String(CKUSDC_WIRE), `request amount should be ${CKUSDC_WIRE} raw (the netted wire 0.040000 USDC), got ${req.amount}`);
    assert(!req.amount.includes('.'), `raw amount must be an integer string (no float artifact), got ${req.amount}`);
    console.log(`[28-ckusdc-request] ✓ decoded: currency=${req.currency} amount=${req.amount} (= 0.040000 USDC netted wire)`);

    // The amount-big readout renders the EXACT requested asset in its own 6-decimal units (MC5
    // locked-asset display via fmtCurrencyAmount → backing_symbol suffix). It must NOT show a "$0.05"
    // dollar framing — fmtCurrencyAmount uses the unit suffix, not the currencySymbol glyph.
    const body = await driver.bodyText();
    assert(body.includes(EXPECTED_DISPLAY), `request screen should show "${EXPECTED_DISPLAY}", got body:\n${body}`);
    assert(!body.includes('$0.05'), `must NOT show a dollar amount for a ckUSDC request. body:\n${body}`);
    assert(body.includes('you receive 0.04 USDC'), `request screen fee line should name the netted wire "you receive 0.04 USDC". body:\n${body}`);
    console.log(`[28-ckusdc-request] ✓ request screen shows "${EXPECTED_DISPLAY}" price + fee line (no $0.05)`);

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
