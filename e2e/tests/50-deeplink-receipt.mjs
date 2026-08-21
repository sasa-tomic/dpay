// Flow 50 — Deeplink receipt hand-back (`dpay:pay` — the W3 NFC-less rail proof).
//
// When NFC is unavailable, the payer (online) settles their own payment — an icrc1_transfer whose
// memo is the REQUEST NONCE — and shares the rail proof {ledger, block_index, request_id} back to
// the merchant as a `dpay:pay/<blob>` link. The blob is base64url(JSON.stringify(proof)) — the
// receiptShareBlob codec (what the payer's Paid screen Share button actually produces; flow 59
// asserts that side). The merchant's app binds the proof to the OPEN request: parseRailProof
// format-checks (request_id 64-hex + block_index decimal), then treats it only as a trigger. The
// "Received ∂25.00 from payer" flip comes from an exact recipient/currency/amount/memo match in
// durable ledger history, never from the blob itself.
//
// FORGERY LEG (F2, 2026-08-20): a well-formed proof with a RANDOM request_id (never signed —
// no matching ledger transaction exists) is injected FIRST. It must NOT flip the screen to Received:
// the pre-fix bug rendered "Received" in the same tick after only format validation, letting a
// forged proof release goods for free. The fixed handler is history-gated and bounded. Only the REAL pre-settled
// proof (injected second) completes to Received.
//
// block_index honesty: TxnRecord carries no block index, and decoding the gateway's CBOR
// encode_transfer_ok reply by hand is out of scope for the harness — the app's prefill path only
// sanity-checks block_index as /^\d+$/, so the proof carries '0' and the REAL confirmation is the
// ledger state itself, which this flow asserts directly (memo-keyed txn row + the merchant's
// balance grew). That is exactly the app's documented W6-labeled posture: bind + sanity-check +
// ledger confirmation, with full BLS cert verification future work.
//
// Approach: A (merchant) is onboarded in the browser and builds a REAL request through the app UI
// (amount 25.00 → Request) — the QR payload is read via the __DPAY_QR_LAST seam and decoded, so the
// nonce/amount/to paid are the app's own bytes, not a synthetic request. B (payer) is a harness
// keypair fauceted ∂100 that settles via railTransfer (a signed icrc1_update envelope POSTed to the
// fake-IC /api/v2 gateway — byte-identical to what the payer's app signs). The hand-back is injected
// via the __DPAY_TEST_DEEPLINK foreground seam (Wallet registers it for exactly this: it drives the
// SAME applyBlob path as the web ?pay= reader + the native foreground url listener; a page reload
// would work too but wipes the open request, which is the thing the proof binds to).
//
// SECURITY assertion: the merchant sees "Received ∂25.00" ONLY after exact ledger history
// confirms the open request tuple (the forged random-rid leg above stays on the open request;
// a malformed proof errors — never a silent Received). The merchant also lands on RECEIVE — a
// dpay:pay never routes to the Pay review.
//
// Selector contract: `amount-input`, `btn-request`, `request-qr` (merchant's request), the
// __DPAY_QR_LAST + __DPAY_TEST_DEEPLINK seams.
import { randomBytes } from 'node:crypto';
import { setup, assert, assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, railTransfer, railPrincipalText } from '../harness/lib.mjs';
import { generateKeypair, decodeRequest, b64urlEncode } from '../harness/wire.mjs';

const PAY_UNITS = 2500; // ∂25.00 (DEMO_USD = currency 0)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '50',
  name: 'deeplink-receipt',
  journey: 'pay',
  covers: ['deeplink', 'receipt-link', 'rail-proof', 'receive', 'handback', 'forgery'],
  verifies: 'merchant treats dpay:pay as a trigger; a forged proof before settlement never flips Received — only the exact nonce-bound ledger row does; never routes to Pay.',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[50-deeplink-receipt] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- wallet A: onboarded in the browser (the MERCHANT). ----------------------------------
    console.log('[50-deeplink-receipt] onboarding wallet A (merchant)…');
    await onboardWallet(driver, 'e2e-receipt');
    const alice = await accountOf(driver);
    const alicePub = alice.publicHex;
    console.log(`[50-deeplink-receipt] wallet A (merchant): ${alicePub.slice(0, 16)}…`);

    // --- A builds a REAL request through the app UI: Receive → 25.00 → Request. The QR payload is
    //     read via the __DPAY_QR_LAST seam (the exact bytes a payer would scan) and decoded — the
    //     nonce the payer must memo, the amount the bind will display, and `to` == A's account.
    console.log('[50-deeplink-receipt] A builds a ∂25.00 request via the app…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '25.00', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    const qrValue = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof qrValue === 'string' && qrValue.length > 0, `__DPAY_QR_LAST should hold the request QR value, got "${qrValue}"`);
    const req = decodeRequest(qrValue);
    assert(req.toHex === alicePub, `request.to must be the merchant's account, got ${req.toHex}`);
    assert(req.amount === String(PAY_UNITS), `request.amount must be ${PAY_UNITS} (∂25.00), got ${req.amount}`);
    assert(req.currency === 0, `request.currency must be 0 (DEMO), got ${req.currency}`);
    const nonce = req.nonceHex;
    console.log(`[50-deeplink-receipt] ✓ real request decoded: to=A amount=${req.amount} nonce=${nonce.slice(0, 8)}…`);

    // --- wallet B: a fresh keypair generated in-test (the PAYER), fauceted ∂100. -------------
    // B settles A's request directly on the rail (online icrc1_transfer, memo = the request nonce)
    // — the NFC-unavailable scenario where the payer settles their own payment + hands the proof
    // back. Funded via the faucet at B's principal (arbitrary account).
    const bob = await generateKeypair();
    console.log(`[50-deeplink-receipt] wallet B (payer): ${bob.publicHex.slice(0, 16)}…`);
    const fund = await faucetAccount(relayBaseURL, bob.publicHex, 10000);
    assert(fund.ok, `payer B faucet should succeed, got status ${fund.status}: ${JSON.stringify(fund.body)}`);
    const bobBal = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(String(bobBal) === '10000', `payer B must be fauceted to 10000, got ${bobBal}`);

    // Catalog: the DEMO ledger principal carried as a format-checked proof hint.
    const catR = await fetch(`${relayBaseURL}/api/v1/currencies`);
    assert(catR.ok, `catalog fetch should be 200, got ${catR.status}`);
    const catJ = await catR.json();
    const catalog = Array.isArray(catJ) ? catJ : catJ.currencies;
    const ledger = catalog.find((c) => c.currency === 0)?.ledger;
    assert(typeof ledger === 'string' && ledger.length > 0, 'catalog must carry the DEMO ledger id');

    // Forgery comes BEFORE settlement. With no exact ledger row, a well-formed random proof cannot
    // release goods. Wait through the bounded history budget before creating the real transfer.
    console.log('[50-deeplink-receipt] injecting a FORGED proof before payment — must NOT flip to Received…');
    const forgedRid = randomBytes(32).toString('hex');
    const forgedBlob = b64urlEncode(Buffer.from(JSON.stringify({ledger, block_index: '0', request_id: forgedRid}), 'utf8'));
    await driver.eval((b) => window.__DPAY_TEST_DEEPLINK({kind: 'pay', blob: b}), forgedBlob);
    await new Promise((r) => setTimeout(r, 6000));
    const body0 = await driver.bodyText();
    assert(!body0.includes('Received'), `a forged proof without a matching ledger row must not show Received; page: ${body0.slice(0, 200)}`);
    assert((await driver.eval(() => !!document.querySelector('[data-testid="request-qr"]'))), 'the open request must still be showing');
    console.log('[50-deeplink-receipt] ✓ forged proof stayed honest: no matching history row');

    // --- B settles: sign an icrc1_transfer (payee = A's principal, memo = the request nonce) and
    //     POST it to the fake-IC /api/v2 gateway — byte-identical to the payer app's own submit.
    //     202 = accepted (the gateway executes synchronously; dedup keyed on the request_id).
    console.log('[50-deeplink-receipt] B settles A’s request via railTransfer (memo = request nonce)…');
    const pay = await railTransfer(relayBaseURL, bob.secretHex, alicePub, PAY_UNITS, { currency: 0, memoHex: nonce });
    assert(pay.ok, `B's rail transfer should be accepted, got status ${pay.status}: ${pay.bodyText.slice(0, 300)}`);
    console.log(`[50-deeplink-receipt] ✓ settled on the rail (rid ${pay.requestIdHex.slice(0, 8)}…)`);

// --- Ledger-state confirmation (the honest W3 leg): the memo-keyed txn row exists + the
//     merchant's DEMO balance grew by the paid amount.
const alicePrincipal = await railPrincipalText(alicePub);
const bobPrincipal = await railPrincipalText(bob.publicHex);
const txUrl = `${relayBaseURL}/api/v1/transactions/${alicePub}?currency=0&limit=20`;
const txR = await fetch(txUrl);
assert(txR.ok, `GET transactions should be 200, got ${txR.status}`);
const txJ = await txR.json();
const row = (txJ.transactions ?? []).find((t) => t.memo === nonce);
assert(row, `the rail txn row keyed by the request memo (${nonce.slice(0, 8)}…) must exist for the merchant`);
assert(row.from === bobPrincipal && row.to === alicePrincipal, `txn row endpoints must be B→A principals, got ${row.from} → ${row.to}`);
assert(String(row.amount) === String(PAY_UNITS), `txn row amount must be ${PAY_UNITS}, got ${row.amount}`);
const aliceAfter = await getBalance(relayBaseURL, alicePub, 0);
assert(String(aliceAfter) === '12500', `merchant balance must be 12500 (10000 faucet + 2500 paid), got ${aliceAfter}`);
console.log('[50-deeplink-receipt] ✓ rail state confirms: memo row B→A + merchant balance 12500');

// --- The REAL rail proof the payer's app shares: base64url(JSON {ledger, block_index,
//     request_id}) — the receiptShareBlob codec (the harness b64urlEncode is the same RFC 4648
//     §5 codec the app's lib/base64url.ts uses). block_index '0' (display/sanity-only; see the
//     file header) + the rid of B's settled envelope.
const proof = { ledger, block_index: '0', request_id: pay.requestIdHex };
const blob = b64urlEncode(Buffer.from(JSON.stringify(proof), 'utf8'));

    // --- Hand the proof back: inject a FOREGROUND dpay:pay deeplink via the __DPAY_TEST_DEEPLINK
    //     seam (Wallet registers it to drive the SAME applyBlob the web ?pay= reader + the native
    //     url listener use — a reload would wipe the open request the proof binds to).
    console.log('[50-deeplink-receipt] handing the proof back via the dpay:pay deeplink seam…');
    await driver.eval((b) => {
      if (typeof window.__DPAY_TEST_DEEPLINK !== 'function') throw new Error('__DPAY_TEST_DEEPLINK seam not mounted (Wallet deeplink effect missing)');
      window.__DPAY_TEST_DEEPLINK({kind: 'pay', blob: b});
    }, blob);

    // --- Merchant's Receive screen flips to Received: the proof bound to the OPEN request (rid
    //     64-hex + decimal block_index) → the request's own amount + from 'payer'. A forged proof
    //     (wrong rid shape / no open request match) errors instead — never a silent Received.
    const received = await driver.waitForText('Received', { timeoutMs: 8_000 });
    assert(received, 'merchant should see "Received" after the dpay:pay proof bound to the open request');
    const body = await driver.bodyText();
    assertIncludes(body, '∂25.00', 'the Received screen should show the open request amount ∂25.00');
    assertIncludes(body, 'from ', 'the Received screen should name the payer (from …)');
    // SECURITY INVARIANT: the merchant is NOT on the Pay review screen (a req deeplink would land
    // there; a pay deeplink must route to Receive). Asserts the kind routing is correct.
    assert(!/\bPay ∂25\.00\b/.test(body), 'a dpay:pay receipt must route to Receive, not the Pay review screen');
    console.log('[50-deeplink-receipt] ✓ merchant bound the rail proof + shows Received ∂25.00 from payer');

    await driver.screenshot('50-deeplink-receipt');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[50-deeplink-receipt] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[50-deeplink-receipt] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
