// Flow 06 — Request QR (receive): renders the payment LINK and keeps the wire on the radio.
//
// Founder decision 2026-09-12: the request QR IS the payment-link URL on every rail, so a regular
// phone camera opens dpay (verified App Link) or the web wallet. This flow drives the REAL app's
// ReceiveMode and asserts:
//   - the QR value is a link on this wallet's own principal: /wallet/pay/<principal> with the exact
//     asset/network/amount, the merchant's username as label, and ref = the request nonce (the
//     on-chain memo — paying the link reconciles the very screen it came from);
//   - Share carries the SAME string the QR renders (one payment, one code — never two);
//   - the 132-byte wire request still exists where it is load-bearing: NFC. With the radio forced
//     ready, the reader arms with the REAL machine code (stashed by the shim on
//     __DPAY_TEST_NFC_READER_REQUEST), decoded here field-for-field against the wire layout:
//     to/amount/expiry/currency/to_name/memo + REQUEST_LEN.
// The QR value is read via the __DPAY_QR_LAST shim seam (the QR pixels already encode it; the seam
// exposes it readably so the test asserts the EXACT string a payer would scan — not an OCR guess).
//
// Selector contract: `tab-receive`, `amount-input`, `btn-request`, `request-qr`.
import { setup, assert, assertEq, onboardWallet, accountOf, railPrincipalText } from '../harness/lib.mjs';
import { decodeRequestHex, REQUEST_LEN } from '../harness/wire.mjs';
import { parsePayLink } from '../harness/paylink.mjs';

const EXPIRY_WINDOW_SLACK = 1000; // EXPIRY_WINDOW=900 in constants.ts (U-F3 15-min TTL) + a few seconds of test latency

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '06',
  name: 'request-qr',
  journey: 'pay',
  covers: ['request-qr', 'pay-link', 'merchant', 'to-name', 'memo', 'share', 'nfc-wire'],
  verifies: 'Merchant enters amount → request QR renders the payment LINK (own principal, exact asset/chain/amount/label, ref = reconciliation nonce); Share emits the SAME link; the NFC reader arms with the real 132-byte request, decoded field-for-field.',
  timeoutMs: 38000,
};

export async function run() {
  const start = Date.now();
  console.log('[06-request-qr] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet; capture this wallet's account (pubkey hex) to verify the link's recipient
    //    and the wire's `to`. Force the radio ready so the request also builds the NFC machine code
    //    and arms reader mode (the wire's only exit from the screen now).
    console.log('[06-request-qr] onboarding…');
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });
    await onboardWallet(driver, 'e2e-bob');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be 32-byte hex, got "${accountHex}"`);

    // 2. Switch to Receive + enter an amount. Type 42.50 → the link carries it unrounded.
    console.log('[06-request-qr] receive mode → request…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '42.50', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });

    // 3. The request QR renders (the `request-qr` container is the gate).
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });

    // L4 + D5: the offline-payer affordance is a CONCISE button label ("Scan payer's signed QR")
    // with the explanatory sentence as smaller help-text below it (not as the button label).
    const reqBody = await driver.bodyText();
    assert(/Scan payer's signed QR/i.test(reqBody),
      `request screen should show the concise affordance button label (D5). body excerpt:\n${reqBody.slice(0, 400)}`);
    assert(/paid without scanning/i.test(reqBody) && /confirm with their phone/i.test(reqBody),
      `request screen should show the explanatory help-text below the affordance (D5). body excerpt:\n${reqBody.slice(0, 400)}`);
    console.log('[06-request-qr] ✓ concise offline-payer affordance + help-text (L4 + D5)');

    // 4. Read the EXACT value the QR encodes via the shim seam, then parse it as the payment link.
    const qrValue = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof qrValue === 'string' && qrValue.length > 0, `__DPAY_QR_LAST should hold the request QR value, got "${qrValue}"`);
    const link = parsePayLink(qrValue);
    assert(link !== null, `the request QR must BE the payment link, got "${qrValue}"`);
    const selfPrincipal = await railPrincipalText(accountHex);

    // 5. Verify the link names THIS wallet's own ICRC-1 account and the exact request terms.
    assertEq(link.recipient, selfPrincipal, 'the link must pay THIS wallet (principal derived by the real core, not a mock)');
    assertEq(link.asset, 'DEMO', 'the link names the exact asset');
    assertEq(link.network, 'internet-computer', 'the link names the settlement chain');
    assertEq(link.amount, '42.50', 'the link carries the entered amount, unrounded');
    assertEq(link.label, 'e2e-bob', 'the link carries the merchant username as the (claimed) label');
    assertEq(link.memo, '', 'no memo entered → the link omits it');
    // `ref` IS this request's nonce — the on-chain memo — so paying the link reconciles against the
    // very request whose QR is on screen. 32 lowercase hex (16 bytes).
    assert(/^[0-9a-f]{32}$/.test(link.ref ?? ''), `the link's ref must be the 16-byte request nonce, got "${link.ref}"`);
    console.log(`[06-request-qr] ✓ QR is the payment link: ${link.recipient.slice(0, 12)}… amount=${link.amount} label=${link.label} ref=${(link.ref ?? '').slice(0, 8)}…`);

    // 6. The request screen still runs its 15-minute countdown (U-F3): the window bounds the
    //    merchant's watch, while the link itself is durable by design (documented link behavior).
    assert(/Valid for ~1[0-9] min/.test(reqBody), `the request screen should show the countdown, got body:\n${reqBody.slice(0, 400)}`);

    // 7. "Share request link" carries the SAME link the QR renders — the one payment, two surfaces,
    //    never two different codes. Captured through the __DPAY_TEST_SHARE seam (shims.ts records
    //    Share.share's message), the same seam flow 59 uses for the receipt hand-back.
    await driver.eval(() => { window.__DPAY_TEST_SHARE = ''; });
    await driver.click('btn-share-request', { timeoutMs: 5_000 });
    const sharedLink = await driver.eval(() => window.__DPAY_TEST_SHARE);
    assert(typeof sharedLink === 'string' && sharedLink.length > 0, `the share button must hand a link to Share.share, got "${sharedLink}"`);
    assertEq(sharedLink, qrValue, 'Share must carry the SAME string the QR renders (one payment, one code)');
    console.log('[06-request-qr] ✓ Share carries the identical link');

    // 8. The machine code survives on the radio: the reader armed with the REAL 132-byte request
    //    (the shim stashes the hex when startReader is called). Decode it field-for-field — this is
    //    the same wire-decode coverage the QR used to carry, at its one remaining surface.
    let readerHex = null;
    for (let i = 0; i < 100 && !readerHex; i++) {
      readerHex = await driver.eval(() => window.__DPAY_TEST_NFC_READER_REQUEST ?? null);
      if (!readerHex) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(typeof readerHex === 'string' && readerHex.length > 0, 'the NFC reader must arm with the 132-byte wire request (radio ready)');
    const req = decodeRequestHex(readerHex);
    const now = Math.floor(Date.now() / 1000);
    assertEq(req.toHex, accountHex, 'wire.to == this wallet account (the deposit destination)');
    assertEq(req.amount, '4250', 'wire.amount == entered 42.50 in minor units (cents)');
    assert(req.expiry > now, `wire.expiry must be in the future (got ${req.expiry}, now ${now})`);
    assert(req.expiry < now + EXPIRY_WINDOW_SLACK, `wire.expiry must be within the ~15min window (got ${req.expiry}, now ${now})`);
    assertEq(req.currency, 0, 'wire.currency == DEMO_USD (the wallet `$` asset)');
    assertEq(req.toName, 'e2e-bob', 'wire.to_name == the merchant username');
    assertEq(req.memo, '', 'wire.memo == empty (no memo entered)');
    // decodeRequest already enforces length == REQUEST_LEN; assert explicitly for the contract.
    assertEq(REQUEST_LEN, 132, 'REQUEST_LEN (the frozen request wire size — 132 bytes with to_name + memo)');
    assertEq(req.nonceHex, link.ref, 'the wire nonce and the link ref must be the SAME 16 bytes (one request, one reconciliation key)');
    console.log(`[06-request-qr] ✓ NFC radio carries the wire: to=${req.toHex.slice(0, 12)}… amount=${req.amount} to_name=${req.toName} expiry=+${req.expiry - now}s currency=${req.currency}`);

    await driver.screenshot('06-request-qr');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[06-request-qr] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[06-request-qr] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
