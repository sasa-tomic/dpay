// Flow 59 — Share receipt button (`btn-share-receipt`) on an ONLINE settle.
//
// The NFC-less receipt hand-back button: when the payer settles ONLINE (NFC unavailable), they hold
// the canister-signed receipt. PayMode.tsx renders a `btn-share-receipt` that calls
// `Share.share({message: shareHandoff('pay', receiptShareBlob(paid.receipt!))})` so the payer can
// hand the receipt back for the merchant to verify + reconcile. On web the payload is an OPENABLE
// `<origin>/wallet?pay=<base64url>` URL (a browser cannot open the dpay: scheme); on native it is
// the `dpay:pay/<base64url>` URI. This button had ZERO e2e coverage (it only renders when
// `paid.receipt` is set, which happens exclusively on a fresh online settle). This flow drives the
// EXACT path: onboard A (payer) → scan B's request → Approve → online settle → "Paid" + receipt →
// btn-share-receipt renders → tap → assert the Share payload is a `/wallet?pay=` link whose blob is
// the exact receipt.
//
// The Share.share call is captured by the `window.__DPAY_TEST_SHARE` seam (shims.ts wraps Share.share
// to record the `message` field before resolving the clipboard-fallback sharedAction — mirrors the
// clipboard seam). This proves the button hands encodeReceiptDeeplink's output to Share, byte-for-byte
// the URI scheme a merchant opens via flow 50's verify path. The sharedAction flip also drives the
// in-DOM 'Link copied ✓' feedback label (asserted below).
//
// Selector contract: `pay-amount`, `btn-approve`, `btn-share-receipt`.
import { setup, assert, onboardWallet } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // ∂25.00 (DEMO_USD = currency 0, the wallet asset)
const MERCHANT_NAME = 'Bob';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '59',
  name: 'share-receipt',
  journey: 'pay',
  covers: ['share-receipt', 'receipt-link', 'handback', 'online-settle', 'deeplink'],
  verifies: 'After an online settle, btn-share-receipt hands an openable /wallet?pay= receipt URL to Share and flips to "Link copied ✓".',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[59-share-receipt] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- wallet B: a fresh keypair generated in-test (the payee/merchant). ------------------
    const bob = await generateKeypair();
    console.log(`[59-share-receipt] wallet B (payee): ${bob.publicHex.slice(0, 16)}…`);

    // --- wallet A: onboarded in the browser (the payer, funded ∂100 by the faucet). ---------
    console.log('[59-share-receipt] onboarding wallet A (payer)…');
    await onboardWallet(driver, 'e2e-alice');

    // --- B's request QR: to=B, amount=∂25, fresh nonce, +10min expiry, currency 0 (DEMO_USD).
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, MERCHANT_NAME);

    // --- A scans B's request via the camera seam → review screen. ---------------------------
    console.log('[59-share-receipt] injecting B’s request QR via the camera seam…');
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    const payAmt = await driver.readText('pay-amount');
    assert(payAmt.includes('∂25.00'), `review should show "Pay ∂25.00", got "${payAmt}"`);

    // --- Approve → online settle (relay reachable) → "Paid" with a fresh receipt. ------------
    // The online path sets paid.receipt (only on a fresh, non-replayed settle), which gates the
    // btn-share-receipt render. A button NOT rendering here would mean the receipt capture broke.
    console.log('[59-share-receipt] clicking btn-approve (sign + pay)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach the Paid screen after the relay settles');

    // --- btn-share-receipt renders ONLY because paid.receipt was captured on the online settle. -
    await driver.findByTestID('btn-share-receipt', { timeoutMs: 5_000 });
    console.log('[59-share-receipt] ✓ btn-share-receipt rendered (online settle captured a receipt)');

    // --- Reset the Share seam, tap btn-share-receipt, assert the captured payload is an OPENABLE
    //     /wallet?pay=<base64url> URL (web shareHandoff) — the wallet's own readPaymentDeeplink
    //     consumes the same blob, so the merchant lands on the verified receipt hand-back. --------
    await driver.eval(() => { window.__DPAY_TEST_SHARE = ''; });
    console.log('[59-share-receipt] clicking btn-share-receipt…');
    await driver.click('btn-share-receipt', { timeoutMs: 5_000 });

    // U-F1: the tap must give IN-DOM feedback, not a dead fire-and-forget. The local-mode shim
    // now mirrors prod-web's no-Web-Share behavior (clipboard-write fallback → sharedAction), so
    // the button label flips to the web confirmation 'Link copied ✓' (the 1500ms dwell) — the
    // exact state a headless/prod web user sees. Assert it lands in the DOM.
    const flipped = await driver.waitForText('Link copied ✓', { timeoutMs: 4_000 });
    assert(flipped, 'btn-share-receipt should flip its label to "Link copied ✓" after the share fallback copies');

    const shared = await driver.eval(() => window.__DPAY_TEST_SHARE);
    assert(typeof shared === 'string' && shared.length > 0, `Share.share should have captured a message, got ${JSON.stringify(shared)}`);
    const url = new URL(shared);
    assert(url.pathname === '/wallet', `the shared message should be a /wallet URL, got "${String(shared).slice(0, 40)}…"`);
    assert(url.searchParams.has('pay'), 'the /wallet URL must carry ?pay=<blob>');
    // The blob after the param is base64url(JSON.stringify(receipt)) — non-empty + URL-safe charset.
    const blob = url.searchParams.get('pay');
    assert(blob.length > 0, 'the ?pay= link must carry a non-empty receipt blob');
    assert(/^[A-Za-z0-9_-]+$/.test(blob), `the receipt blob must be base64url (no padding/specials), got "${blob.slice(0, 24)}…"`);
    console.log(`[59-share-receipt] ✓ Share.share captured a /wallet?pay=<base64url> URL (${blob.length}-char blob)`);

    // Belt-and-suspenders: the blob JSON-decodes to the post-W8 rail proof {ledger, block_index,
    // request_id} (the interim settlement receipt: certified read_state, not BLS-verified
    // on-device — chain-key receipts are the documented OPEN_ISSUES follow-up). The request_id
    // (the signed envelope's hash) IS the nonce binding — unique per signing; the merchant's
    // verify path (ReceiveMode) binds exactly this rid to the open request via read_state. The
    // old facade receipt fields (nonce + canister sig) are gone with the cutover.
    const decoded = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8'));
    assert(typeof decoded === 'object' && decoded !== null, 'the receipt blob must decode to a JSON object');
    assert(/^[0-9a-f]{64}$/.test(String(decoded.request_id)), `the receipt must carry a 32-byte hex request_id (the merchant binding key), got ${JSON.stringify(decoded)}`);
    const catalog = (await (await fetch(`${relayBaseURL}/api/v1/currencies`)).json()).currencies;
    const ledger0 = catalog.find((c) => c.currency === 0).ledger;
    assert(String(decoded.ledger) === ledger0, `the receipt ledger must be this settle's target (currency-0 ledger ${ledger0}), got ${decoded.ledger}`);
    assert(/^\d+$/.test(String(decoded.block_index)), `block_index must be a u64 decimal string, got ${decoded.block_index}`);
    console.log('[59-share-receipt] ✓ shared receipt decodes to the rail proof {ledger, block_index, request_id}');

    await driver.screenshot('59-share-receipt');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[59-share-receipt] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[59-share-receipt] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
