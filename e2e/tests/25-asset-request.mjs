// Flow 25 — Multi-currency request: the merchant selects ckBTC + the request carries
// currency 1 (MC5: the merchant picks the EXACT settlement asset; dpay never swaps).
//
// Drives the REAL app's ReceiveMode asset selector (MC5): onboard → Receive → tap the ckBTC chip
// (testID `request-asset-ckbtc`) → type a BTC amount (0.0004) → btn-request. Founder decision
// 2026-09-12: the QR is the payment LINK, so the asset contract asserts the LINK (asset ckBTC,
// network, unrounded amount, own principal) AND — with the radio forced ready — the 132-byte wire
// the NFC reader arms with, where the currency-id encode contract still lives:
//   - decodeRequest(reader) carries currency=1 + amount=40000 (0.0004 price; wire netted − fee) — NOT currency=0.
//   - The amount-big readout shows "0.0004 BTC" (the family's native asset unit), NOT a `$` amount.
//   - No dollar amount appears anywhere on the screen (the locked-asset display is unambiguous).
//
// Selector contract: `tab-receive`, `req-prefix` (amount glyph → opens picker), `req-pick-ckbtc`,
// `amount-input`, `btn-request`, `request-qr`. The picker row testID matches the wallet's existing
// `asset-ckbtc` contract (assetTestKey → 'ckbtc' for the CkBtcUtxo entry).
import { setup, assert, onboardWallet, accountOf, railPrincipalText } from '../harness/lib.mjs';
import { decodeRequestHex } from '../harness/wire.mjs';
import { parsePayLink } from '../harness/paylink.mjs';

const CKBTC_SATS = 40_000; // the PRICE typed into the request: 0.0004 BTC
// Exact-price rule (founder 2026-09-12): the customer pays the price; the LEDGER fee is netted
// OUT of the wire the merchant receives — this wallet pays the fee. The LINK therefore carries
// the NETTED amount (price − fee), which became visible when the ckBTC icrc1_fee was measured
// and pinned to 10 sats (2026-09-18; before the pin the netting was a no-op).
const CKBTC_LEDGER_FEE = 10n;

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '25',
  name: 'asset-request',
  journey: 'pay',
  covers: ['asset-request', 'ckbtc', 'currency-id', 'encode', 'btc-units', 'pay-link'],
  verifies: 'ckBTC chip + BTC amount → QR is the payment LINK (ckBTC/IC/0.0004, own principal); NFC wire encodes RUNTIME currency 1 + the netted wire sats; readout \'0.0004 BTC\' (no $).',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[25-asset-request] setup…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[25-asset-request] onboarding…');
    // Force the radio ready so the request ALSO builds the NFC machine code (its one surface now)
    // and the reader arms — the wire-seam read below depends on it.
    const nfcSeam = await driver.addInitScript(() => { globalThis.__DPAY_TEST_NFC_STATUS = 'ready'; });
    await onboardWallet(driver, 'e2e-merchant');
    await driver.removeInitScript(nfcSeam);
    const accountHex = (await accountOf(driver))?.publicHex;

    // Switch to Receive + select ckBTC as the settlement asset (the merchant CHOOSES; the payer
    // never switches — dpay does not swap). The settlement asset is picked by tapping the amount
    // prefix glyph (req-prefix) → compact currency picker → req-pick-ckbtc.
    console.log('[25-asset-request] receive mode → selecting ckBTC…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.click('req-prefix', { timeoutMs: 4_000 });
    await driver.click('req-pick-ckbtc', { timeoutMs: 4_000 });

    // Type a BTC amount: 0.0004 → 40000 raw smallest-units (8-decimal). Must sit BELOW the
// spendable balance (the 2026-09-18 pinned 10-sat ckBTC icrc1_fee makes 49990 the ceiling),
// or the request honestly clamps to what can settle and the unrounded-carry assert breaks. The chip switch cleared the
    // amount field, so the prior '25.00' default is never reinterpreted as 25 BTC.
    console.log('[25-asset-request] typing 0.0004 (BTC)…');
    await driver.type('amount-input', '0.0004', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });

    // The request QR renders.
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });

    // Read the EXACT value the QR encodes (the seam exposes it so the test asserts the string a
    // payer's camera would open — not an OCR guess). Founder 2026-09-12: that string is the LINK.
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof requestQR === 'string' && requestQR.length > 0, `__DPAY_QR_LAST should hold the request QR value, got "${requestQR}"`);
    const link = parsePayLink(requestQR);
    assert(link !== null, `the request QR must BE the payment link, got "${requestQR}"`);
    const selfPrincipal = await railPrincipalText(accountHex);
    assert(link.recipient === selfPrincipal, `the link must pay THIS wallet's principal, got "${link.recipient}"`);
    assert(link.asset === 'ckBTC', `the link must name ckBTC, got "${link.asset}"`);
    assert(link.network === 'internet-computer', `the link must name the settlement chain, got "${link.network}"`);
    assert(link.amount === '0.0003999', `the link carries the NETTED wire (40000 price − 10-sat ledger fee = 39990 sats = 0.0003999 BTC), got "${link.amount}"`);
    console.log('[25-asset-request] ✓ QR is the payment link (ckBTC, own principal)');

    // The wire the NFC reader armed with carries the runtime currency id (1 = ckBTC), not a
    // hardcoded 0 — the byte-exact encode contract lives on the radio now.
    let readerHex = null;
    for (let i = 0; i < 100 && !readerHex; i++) {
      readerHex = await driver.eval(() => window.__DPAY_TEST_NFC_READER_REQUEST ?? null);
      if (!readerHex) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(typeof readerHex === 'string' && readerHex.length > 0, 'the NFC reader must arm with the 132-byte wire request');
    const req = decodeRequestHex(readerHex);
    assert(req.currency === 1, `request should encode currency 1 (ckBTC), got ${req.currency}`);
    assert(req.amount === '39990', `wire request should be the netted 39990 sats (0.0004 price − 10-sat ledger fee), got ${req.amount}`);
    console.log(`[25-asset-request] ✓ decoded: currency=${req.currency} amount=${req.amount} (netted)`);

    // The amount-big readout renders the EXACT requested asset in its own units (MC5 locked-asset
    // display). It must NOT show a dollar amount — a misleading `$0.50` would be a swap-adjacent
    // framing the no-swap rule forbids.
    const body = await driver.bodyText();
    assert(body.includes('0.0004 BTC'), `request screen should show "0.0004 BTC", got body:\n${body}`);
    assert(!body.includes('$0.40'), `must NOT show a dollar amount for a ckBTC request. body:\n${body}`);
    console.log('[25-asset-request] ✓ request screen shows "0.0004 BTC" (no $)');

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
