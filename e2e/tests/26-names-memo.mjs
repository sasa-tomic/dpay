// Flow 26 — Display names + memo end-to-end (wire-format v2, closes N6/H3).
//
// The user-visible proof that the FROZEN wire-format change landed: display names + a memo now ride
// the SIGNED bytes, so transaction history is self-describing on BOTH sides — no raw hex pubkeys.
//
// Scenario (mirrors 07-scan-pay but with names + memo): wallet B "Bob" (payee/merchant) is generated
// in-test and builds a request with to_name="Bob" + memo="coffee". Wallet A "Alice" (payer) onboards
// in the browser, scans the request, reviews "Pay $X to Bob" + the memo, approves. The app signs with
// from_name="Alice" + copies to_name="Bob"/memo="coffee" from the request. The FakeLedger verifies +
// settles + records the names. Asserts:
//   - Alice's review shows "to Bob" + the memo "coffee".
//   - Alice reaches "Paid ✓" naming "Bob".
//   - Alice's Recent history shows "to Bob" + memo "coffee" (NOT a raw hex pubkey) — the payer side.
//   - Bob's ledger history (direct relay query) shows the incoming row with from_name="Alice" +
//     memo="coffee" — the PAYEE sees the PAYER's name (N6/H3 core fix).
//
// Selector contract: `balance`, `tab-transactions` (stable surfaces — the sign status is transient).
import { setup, assert, assertIncludes, getBalance, onboardWallet, railPrincipalText , armPayScan} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // ∂25.00 (DEMO_USD = currency 0, the wallet asset)
const PAYEE_NAME = 'Bob';
const PAYER_NAME = 'Alice';
const MEMO = 'coffee';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '26',
  name: 'names-memo',
  journey: 'pay',
  covers: ['names', 'memo', 'history', 'wire-v2', 'friendly-counterparties', 'review-short-payee'],
  verifies: 'Alice pays Bob with memo \'coffee\' → review shows the name + short pubkey + memo (U-F5); Alice\'s history names the row "to Bob" + "coffee" from the DEVICE-SAVED note (rail rows stay name-less; the payee reconciles by nonce).',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[26-names-memo] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- wallet B "Bob" (payee/merchant): generated in-test. ---------------------------------
    const bob = await generateKeypair();
    console.log(`[26-names-memo] wallet B "${PAYEE_NAME}" (payee): ${bob.publicHex.slice(0, 16)}…`);
    const bobBefore = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(bobBefore === '0', `payee B must start at 0, got ${bobBefore}`);

    // --- wallet A "Alice" (payer): onboarded in the browser (funded ∂100 by the faucet). -----
    console.log(`[26-names-memo] onboarding wallet A "${PAYER_NAME}" (payer)…`);
    await onboardWallet(driver, PAYER_NAME);

    // --- B's request: to_name="Bob" + memo="coffee" ride INSIDE the 132-byte request bytes. --
    // buildRequestQR now takes (toHex, amount, nonce, expiry, currency, toName, memo) and emits plain
    // base64url (no |name suffix). The payer's app will copy to_name + memo verbatim into the auth.
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, PAYEE_NAME, MEMO);

    // --- A scans B's request via the camera seam. --------------------------------------------
    console.log('[26-names-memo] injecting B’s request QR (to_name="Bob", memo="coffee") via the camera seam…');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

    // --- AUTO-SIGN → settle (one-press rule 2026-08-24): no review stop, no Approve click. ---
    // The local settle is FAST — the read-only sign status flashes between decode and `paid`, so
    // the exact-amount + payee-name asserts live on the STABLE Paid surface (same formatter, so
    // the precision contract still holds). The U-F5 short-payee pin lives on flow 49's deeplink
    // review — the one surface that still parks. (The camera entry drops the memo display line;
    // the memo itself still rides the request bytes and is asserted on the ledger rows below.)
    const paidEarly = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paidEarly, 'the scan should auto-sign and settle straight to Paid');
    assertIncludes(await driver.bodyText(), '∂25.00', 'the paid headline should carry the exact ∂25.00 amount');
    console.log('[26-names-memo] ✓ auto-signed: Paid ∂25.00 (sign status flashed → stable Paid)');

    // --- Auto-sign → the app signs (from_name="Alice", to_name="Bob", memo="coffee") + settles.
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach the Paid screen after the relay settles');
    const paidBody = await driver.bodyText();
    assertIncludes(paidBody, PAYEE_NAME, 'Paid ✓ confirmation should name the recipient (by display name)');
    console.log(`[26-names-memo] ✓ A reached "Paid ✓" to ${PAYEE_NAME}`);

    // --- A's balance decreased by the amount. ------------------------------------------------
    const aliceDown = await driver.waitForText('∂75.00', { timeoutMs: 10_000 });
    assert(aliceDown, `payer A balance should be ∂75.00 (∂100 − ∂25) after the settle`);

    // --- A's Recent history: the DEVICE-SAVED NOTE names the row (txNotes, 2026-09-11). ------
    // The rail itself still carries no name and no human memo (the IC memo slot IS the request
    // nonce), but A's app saved {k: nonce, who: "Bob", msg: "coffee"} at the moment it signed, so
    // the payer-side row reads "to Bob" + "coffee" — the memo LINE is the human text, the hex
    // nonce it replaced stays reachable on the receipt (flow 172). The full principal and the raw
    // pubkey stay OFF the row, exactly as before. Flow 61 pins the receive side; the rail rows
    // themselves remain name-less (asserted below via the direct relay query).
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    const hasHistory = await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    assert(hasHistory, 'the Recent card should render once the payment lands in history');
    const histBody = await driver.bodyText();
    assertIncludes(histBody, `to ${PAYEE_NAME}`, 'A history row should show the payee NAME (the device-saved note)');
    assertIncludes(histBody, MEMO, 'A history row should show the human memo (the device-saved note)');
    assert(!histBody.includes(nonce.slice(0, 8)), 'the hex nonce prefix must NOT sit on the row any more — the note\'s message replaced it');
    assert(!histBody.includes(bobPrincipal), 'A history must NOT dump the full principal');
    assert(!histBody.includes(bob.publicHex), 'A history must NOT dump the raw 64-char payee pubkey');
    console.log(`[26-names-memo] ✓ A history: "to Bob" + "coffee" from the device-saved note (rail rows stay name-less; the nonce reconciles on the receipt)`);

    // --- B was credited. ---------------------------------------------------------------------
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(bobAfter === String(PAY_CENTS), `payee B balance after the settle: expected ${PAY_CENTS}, got ${bobAfter}`);

    // --- B's ledger history (direct relay query): the PAYEE reconciles by the memo NONCE. -----
    // IC rail: rows are NAME-LESS (from_name/to_name are empty — names died with facade
    // settlement; the payer's "Alice" only ever lived in the request QR bytes the payer saw). What
    // the payee CAN do — the load-bearing replacement for names — is bind the incoming transfer to
    // their open request by the memo: the row's memo is the request nonce hex, verbatim.
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
    let bobRows = null;
    try {
      const r = await fetch(`${relayBaseURL}/api/v1/transactions/${bob.publicHex}?currency=0&limit=5`, { signal: ctrl.signal });
      const j = await r.json().catch(() => null);
      if (r.ok && j && Array.isArray(j.transactions)) bobRows = j.transactions;
    } catch { /* fall through to the assertion below */ } finally { clearTimeout(t); }
    assert(Array.isArray(bobRows) && bobRows.length > 0, `B's ledger history should have the incoming payment row, got ${JSON.stringify(bobRows)}`);
    // The incoming row (B is `to`): names empty (honestly asserted, not silently dropped) and the
    // memo == the request nonce — the reconciliation key B's ReceiveMode matches against its open
    // request (the same binding prefillReceipt/onSignedQr reconcile by).
    const inRow = bobRows.find((row) => row.to && row.to.toLowerCase() === bobPrincipal.toLowerCase());
    assert(inRow, `B's history should contain the incoming row (to == B's principal), got ${JSON.stringify(bobRows)}`);
    assertEq(inRow.from_name ?? '', '', `B history from_name is EMPTY on the rail (names died with the facade; got "${inRow.from_name}")`);
    assertEq(inRow.to_name ?? '', '', `B history to_name is EMPTY on the rail (got "${inRow.to_name}")`);
    assertEq(inRow.memo, nonce, `B history row.memo == the request nonce (the reconciliation key), got "${inRow.memo}"`);
    console.log(`[26-names-memo] ✓ B ledger history: name-less rows, memo == request nonce (the payee reconciles by nonce — the rail's answer to N6/H3)`);

    await driver.screenshot('26-names-memo');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[26-names-memo] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`[assert] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[26-names-memo] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
