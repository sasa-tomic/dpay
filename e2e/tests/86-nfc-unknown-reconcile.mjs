// Flow 86 — NFC tap settles but the read_state outcome is delayed past the in-tap poll budget
// (the 2026-08-21 mainnet bug class, reproduced offline).
//
// The fake-IC gateway normally settles SYNCHRONOUSLY (the RequestState is inserted before the
// /call 202 even returns), so the "payment submitted but outcome unknown" window structurally
// never exists offline — the exact class that failed on mainnet, where the payer's 12×500ms
// in-tap poll budget ran out before the ledger's outcome landed in state certification. This
// flow arms the relay's test-helpers seam `POST /api/v1/test/hide_outcome` for the SIGNED
// envelope's request_id, hiding the outcome from more read_states than the in-tap budget can
// cover, and asserts the honest-unknown recovery path END TO END:
//   - the merchant's in-tap poll exhausts its budget → NOT a false decline: the tap ends
//     "Not confirmed" (pending) and the reader hands off to the background reconcile view
//     (`nfc-reconcile`), keeping the NFC session torn down while the poll owns the outcome;
//   - the background settlement poll (watchRid) keeps polling past the tap budget and, once the
//     hidden outcome is served again, reconciles to "Received" — the ledger-sourced truth;
//   - the merchant's balance reflects the settled transfer exactly once.
//
// Prerequisites proven elsewhere: envelope signing parity (flow 00), the merchant submit+poll
// happy path (flow 08), the reader-side NFC protocol phases (flow 11).
import { setup, assert, assertIncludes, getBalance, faucetAccount, onboardWallet, accountOf } from '../harness/lib.mjs';
import { generateKeypair, decodeRequest, icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate, b64urlEncode, randNonceHex } from '../harness/wire.mjs';

const PAY_CENTS = 1000; // ∂10.00 — the exact amount of the 2026-08-21 field failure

export const meta = {
  id: '86',
  name: 'nfc-unknown-reconcile',
  journey: 'nfc',
  covers: ['nfc', 'settle', 'unknown', 'reconcile'],
  verifies: 'NFC tap whose read_state outcome is delayed past the in-tap poll budget ends honest-pending (never a false decline) and the background poll reconciles to Received.',
  timeoutMs: 40000,
};

export async function run() {
  const start = Date.now();
  console.log('[86-nfc-unknown-reconcile] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // The merchant app must treat NFC as available (web default is 'unknown' → NfcTap never mounts).
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    // --- wallet A (payer): generated + faucet-funded in-test. -----------------------------------
    const alice = await generateKeypair();
    const fundA = await faucetAccount(relayBaseURL, alice.publicHex, 10_000);
    assert(fundA.ok, `payer A faucet funding must succeed, got ${fundA.status}`);

    // --- wallet B (merchant): onboarded in the browser. -----------------------------------------
    await onboardWallet(driver, 'e2e-merchant');
    const bob = await accountOf(driver);
    const bobHex = bob.publicHex;

    // --- B requests ∂10.00; the REAL reader mode must arm (buildRequest now returns real hex). ---
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '10.00', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    const req = decodeRequest(requestQR);
    console.log(`[86-nfc-unknown-reconcile] B request nonce=${req.nonceHex.slice(0, 12)}…`);

    // The reader NfcTap must be mounted (reader mode armed by the real buildRequest hex).
    const listeners = await driver.eval(() => window.__DPAY_TEST_NFC_COUNT());
    assert(listeners >= 1, `reader NfcTap must mount a DpayNfcEvent listener, got ${listeners}`);

    // --- A signs a REAL icrc1_transfer envelope for B's request (memo = the request nonce). -----
    const catalog = (await (await fetch(`${relayBaseURL}/api/v1/currencies`)).json()).currencies;
    const ledger = catalog.find(c => c.currency === 0)?.ledger;
    const arg = icpTransferArgBytes(icpPrincipalBytes(bobHex), BigInt(PAY_CENTS), {fee: null, memoHex: req.nonceHex});
    const expiryNs = BigInt(Date.now() + 300_000) * 1_000_000n;
    const signed = await icpSignUpdate(alice.secretHex, ledger, 'icrc1_transfer', arg, expiryNs);
    const wireHex = signed.envelopeHex; // NFC 'done' event payload: the raw envelope hex
    console.log('[86-nfc-unknown-reconcile] A signed (request_id=' + signed.requestIdHex.slice(0, 12) + '…)');

    // --- Arm the outcome-latency seam BEFORE the tap: hide this rid's outcome for MORE polls
    //     than the in-tap budget (12) — the background reconcile poll then recovers it. ----------
    const arm = await fetch(`${relayBaseURL}/api/v1/test/hide_outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: signed.requestIdHex, polls: 20 }),
    });
    assert(arm.ok, `hide_outcome seam must arm, got HTTP ${arm.status}`);

    // --- The tap: payer wire arrives (reader 'done') → merchant submits → in-tap poll budget
    //     exhausted → honest pending + handoff to the background reconcile view. ------------------
    await driver.eval((wire) => window.__DPAY_TEST_NFC_SESSION({ type: 'done', role: 'reader', wireHex: wire }), wireHex);
    const reconcile = await driver.findByTestID('nfc-reconcile', { timeoutMs: 10_000 });
    assert(reconcile, 'reader must hand off to the reconcile view (nfc-reconcile) after an unknown tap outcome');
    const pendingText = await driver.waitForText('Confirming', { timeoutMs: 4_000 });
    assert(pendingText, 'reconcile view should show the honest pending state (Confirming…)');
    console.log('[86-nfc-unknown-reconcile] ✓ in-tap budget exhausted → honest pending handoff (no false decline)');

    // --- The background poll owns the outcome: once the hidden polls are served, it reconciles
    //     to Received — ledger-sourced, without any payer-presented claim. ------------------------
    const received = await driver.waitForText('Received ∂10.00', { timeoutMs: 20_000 });
    assert(received, 'background reconcile poll should reach "Received ∂10.00" once the outcome is visible');
    console.log('[86-nfc-unknown-reconcile] ✓ background poll reconciled to Received');

    // --- The transfer settled EXACTLY ONCE: B's ledger balance is ∂100 + ∂10. --------------------
    const bobLedger = await getBalance(relayBaseURL, bobHex, 0);
    assert(bobLedger === '11000', `B ledger balance must be 11000 cents, got ${bobLedger}`);
    const aliceLedger = await getBalance(relayBaseURL, alice.publicHex, 0);
    assert(aliceLedger === '9000', `A ledger balance must be 9000 cents, got ${aliceLedger}`);

    await driver.screenshot('86-nfc-unknown-reconcile');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[86-nfc-unknown-reconcile] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[86-nfc-unknown-reconcile] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
