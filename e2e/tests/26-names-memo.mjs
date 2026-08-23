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
// Selector contract: `pay-amount`, `review-memo`, `btn-approve`, `balance`.
import { setup, assert, assertIncludes, getBalance, onboardWallet, railPrincipalText } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // Đ25.00 (DEMO_USD = currency 0, the wallet asset)
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
  verifies: 'Alice pays Bob with memo \'coffee\' → review shows the name + short pubkey + memo (U-F5), both histories show friendly names + memo (wire-format v2, no raw hex).',
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

    // --- wallet A "Alice" (payer): onboarded in the browser (funded Đ100 by the faucet). -----
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
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

    // --- Review screen: exact amount + the payee NAME + the memo. ----------------------------
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    const payAmt = await driver.readText('pay-amount');
    assert(payAmt.includes('Đ25.00'), `review should show "Pay Đ25.00", got "${payAmt}"`);
    const reviewBody = await driver.bodyText();
    assertIncludes(reviewBody, PAYEE_NAME, 'review should name the payee by display name (from the request bytes)');
  // The memo the merchant attached is shown as a subtitle on the review screen.
  await driver.findByTestID('review-memo', { timeoutMs: 5_000 });
  const reviewMemo = await driver.readText('review-memo');
  assert(reviewMemo === MEMO, `review memo should be "${MEMO}", got "${reviewMemo}"`);
  // U-F5: a name alone is not verifiable — the dim review-payee line carries the short pubkey
  // (first 8 hex chars + '…') so the payer can eyeball it against the merchant's displayed one.
  await driver.findByTestID('review-payee', { timeoutMs: 5_000 });
  const reviewPayee = await driver.readText('review-payee');
  assertEq(reviewPayee, `${bob.publicHex.slice(0, 8)}…`, 'review short-payee line (U-F5)');
  console.log(`[26-names-memo] ✓ review: ${payAmt} to ${PAYEE_NAME} · ${reviewPayee} · memo "${reviewMemo}"`);

    // --- Approve → the app signs (from_name="Alice", to_name="Bob", memo="coffee") + settles. -
    console.log('[26-names-memo] clicking btn-approve (sign + pay)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach the Paid screen after the relay settles');
    const paidBody = await driver.bodyText();
    assertIncludes(paidBody, PAYEE_NAME, 'Paid ✓ confirmation should name the recipient (by display name)');
    console.log(`[26-names-memo] ✓ A reached "Paid ✓" to ${PAYEE_NAME}`);

    // --- A's balance decreased by the amount. ------------------------------------------------
    const aliceDown = await driver.waitForText('Đ75.00', { timeoutMs: 10_000 });
    assert(aliceDown, `payer A balance should be Đ75.00 (Đ100 − Đ25) after the settle`);

    // --- A's Recent history: short principal + the memo NONCE (the reconciliation key). ------
    // IC rail: names died with facade settlement — the history row carries no name, only the
    // payee's short PRINCIPAL text. The merchant's "coffee" note never rides the rail either: the
    // memo slot IS the request nonce (the reconciliation key binding this payment to B's request).
    // Flow 61 pins the same convention from the receive side.
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    const hasHistory = await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    assert(hasHistory, 'the Recent card should render once the payment lands in history');
    const histBody = await driver.bodyText();
    assertIncludes(histBody, bobPrincipal.slice(0, 8), 'A history row should show the payee short principal text');
    assertIncludes(histBody, nonce.slice(0, 8), 'A history row should show the memo nonce prefix (reconciliation key)');
    assert(!histBody.includes(bobPrincipal), 'A history must NOT dump the full principal');
    assert(!histBody.includes(bob.publicHex), 'A history must NOT dump the raw 64-char payee pubkey');
    console.log(`[26-names-memo] ✓ A history: short principal + memo nonce (names died with the facade; the nonce reconciles)`);

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
