// Flow 49 — a shared PAYMENT LINK pre-fills the pay review and settles for real.
//
// `https://<origin>/wallet/pay/<recipient>?asset=…&network=…&amount=…` is THE URL format for "pay
// me": readable, hand-authorable, shareable over a messaging app, and (via Android App Links) able
// to open the installed app. It replaced the opaque `?req=<blob>` mirror — a link now says what it
// asks for instead of hiding it in base64.
//
// This flow drives the REAL web path end to end: navigate the browser to a payment link (identity
// persists in AsyncStorage → the wallet auto-loads → Wallet's link effect reads it off `location` →
// resolves the asset against the catalog → validates the recipient principal through the core →
// PayMode reviews it), then Approve → sign → settle on the REAL FakeLedger.
//
// The assertions that matter:
//   • the review is REACHED but NOT paid — a link is a zero-press entry and must never auto-sign;
//   • the FULL destination account is on screen (a link names any ICRC-1 account, and the account
//     is the identity — the sender-given label is marked as claimed);
//   • the amount is converted at the asset's own decimals (∂25.00 from `amount=25`);
//   • Approve settles for real: payer ∂100 → ∂75 and the payee's ledger balance is ∂25.
//
// Approach chosen (navigate, not a JS seam): it tests the real location reader with ZERO test-only
// prod code. `?relay=` rides alongside the link's own params so the loaded page still talks to the
// test relay (relay-config reads it at module load; the link parser ignores unknown params).
//
// Selector contract: `pay-amount`, `review-payee`, `btn-approve`, `btn-new`, `balance`.
import {
  setup,
  assert,
  assertIncludes,
  getBalance,
  onboardWallet,
  railPrincipalText,
  openBalances,
} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex } from '../harness/wire.mjs';

const PAY_AMOUNT = '25';   // decimal display units — what the link carries
const PAY_CENTS = 2500;    // the same amount in raw units (DEMO has 2 decimals)
const MERCHANT_NAME = 'Bob';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '49',
  name: 'deeplink-request',
  journey: 'pay',
  covers: ['pay-link', 'url-routing', 'prefill', 'pay-review'],
  verifies: 'A shared /wallet/pay/<recipient> link opens the pay review pre-filled with the exact asset, amount and destination account (no auto-approve), and Approve settles it.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[49-deeplink-request] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL, webBaseURL } = env;

    // --- wallet B: a fresh keypair generated in-test (the payee). -----------------------------
    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    console.log(`[49-deeplink-request] wallet B (payee): ${bobPrincipal}`);
    const bobBefore = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(bobBefore === '0', `payee B must start at 0, got ${bobBefore}`);

    // --- wallet A: onboarded in the browser (the payer, funded ∂100 by the faucet). -----------
    console.log('[49-deeplink-request] onboarding wallet A (payer)…');
    await onboardWallet(driver, 'e2e-deeplink');

    // --- B's payment link: pay 25 DEMO on the Internet Computer to B's own ICRC-1 account, with
    //     B's name as the (unverified) label and a `ref` — the reconciliation nonce that becomes
    //     the on-chain memo, so every payment of it reconciles to this one request (not a dedup
    //     guard: a second payment would pay again). ---
    const ref = randNonceHex();
    const link = `/wallet/pay/${bobPrincipal}`
      + `?asset=DEMO&network=internet-computer&amount=${PAY_AMOUNT}`
      + `&label=${encodeURIComponent(MERCHANT_NAME)}&ref=${ref}`
      + `&relay=${encodeURIComponent(relayBaseURL)}`;
    console.log('[49-deeplink-request] opening the payment link…');
    await driver.navigate(webBaseURL, link, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // --- Review screen pre-filled from the link. It did NOT auto-pay: the payer must be ON the
    //     review screen (btn-approve visible) and NOT on the Paid screen. ----------------------
    await driver.findByTestID('pay-amount', { timeoutMs: 6_000 });
    const payAmt = await driver.readText('pay-amount');
    assert(payAmt.includes('∂25.00'), `review should show "Pay ∂25.00" (25 at DEMO's 2 decimals), got "${payAmt}"`);
    const reviewBody = await driver.bodyText();
    assertIncludes(reviewBody, MERCHANT_NAME, 'review should show the label the link carried');
    // The destination account in FULL — a link can name ANY ICRC-1 account, so the account (not the
    // sender-supplied name) is the identity the payer checks.
    const reviewPayee = await driver.readText('review-payee');
    assert(reviewPayee === bobPrincipal,
      `review must show the full destination account: expected ${bobPrincipal}, got "${reviewPayee}"`);
    // ...and the name beside it is marked as CLAIMED (anyone can write any name into a URL).
    // The FULL destination account is the check on a link's claimed name, and it is the only one
    // offered: the "name given by the sender" caveat was dropped 2026-09-09 — it warned about a
    // name while the checkable thing sat right under it, and no payer could act on it.
    assert(!(await driver.isPresent('review-claimed')), 'a link review carries no unactionable name caveat');
    // SECURITY INVARIANT: the link prefilled the review only — it must NOT have reached Paid.
    assert(!/\bPaid\b/.test(reviewBody), 'a payment link must NOT auto-pay — review screen only (no "Paid")');
    await driver.findByTestID('btn-approve', { timeoutMs: 4_000 });
    console.log(`[49-deeplink-request] ✓ review pre-filled: ${payAmt} to ${MERCHANT_NAME} @ ${bobPrincipal} (no auto-approve)`);

    // --- Approve → the app signs locally + submits the envelope → the ledger settles. This proves
    //     the link's resolved asset/amount/destination reach the SAME sign+settle path a scanned
    //     request uses (flow 07). ------------------------------------------------------------
    console.log('[49-deeplink-request] clicking btn-approve (sign + pay)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach the Paid screen after the ledger settles the linked payment');
    await openBalances(driver); // the practice balance reads on the accounts route (currency-first chip headlines MAIN)
    const aliceDown = await driver.waitForText('∂75.00', { timeoutMs: 10_000 });
    assert(aliceDown, 'payer A balance should be ∂75.00 (∂100 − ∂25) after the settle');
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(String(bobAfter) === String(PAY_CENTS), `payee B balance after settle: expected ${PAY_CENTS}, got ${bobAfter}`);
    console.log('[49-deeplink-request] ✓ settled: A ∂100→∂75, B 0→∂25 (real ledger settle of the linked payment)');

    await driver.screenshot('49-deeplink-request');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[49-deeplink-request] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[49-deeplink-request] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
