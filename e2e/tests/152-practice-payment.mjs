// Flow 152 — the first run's practice payment is a REAL payment.
//
// The screen it replaces (`Rehearsal.tsx`) told a solo user to "Open dpay on another phone…" and
// then congratulated them for reading it. Three independent UX reviewers returned CUT
// (`docs/specs/2026-09-07-ux-decisions.md` §4). What stands in its place makes the payment: the
// wallet signs a real ∂1.00 `icrc1_transfer` on the practice ledger to the pinned practice payee,
// and the ledger settles it.
//
// This flow is the proof that it is real rather than staged, and it takes that in four places
// none of which a mock could satisfy:
//   1. the review the user approves is the SAME component the Pay tab renders — asserted through
//      PayMode's own testIDs (`pay-amount`, `btn-approve`, `btn-review-cancel`), which is what
//      makes "practice is the real thing" checkable rather than a claim in a comment;
//   2. the wallet's practice balance falls ∂100.00 → ∂99.00 on screen;
//   3. the RELAY's own ledger reads 9900 for this account — the money moved somewhere the app
//      does not control;
//   4. the journey store does NOT gain `paymentTested`. That is deliberate and is the difference
//      between "you have seen how this works" and "you have paid a counterparty" — leaving it
//      unfilled is what keeps the trip passport's last step honest. `flowUnderstood` IS held
//      afterwards, but note what that does and does not prove: the walkthrough already awards it
//      on mount, so this flow pins the state, not the awarder (the awarder is pinned in
//      app/__tests__/Practice.test.tsx, against a journey that starts empty).
//
// Selector contract: `practice`, `practice-card`, `practice-balance`, `btn-practice-review`,
// `pay-amount`, `btn-approve`, `practice-outcome`, `practice-outcome-body`, `practice-left`,
// `btn-practice-continue`, `home-currency-title`.
import {
  setup, assert, assertEq, assertIncludes, waitForEnabled, accountOf, getBalance,
  skipWalkthroughIfPresent,
} from '../harness/lib.mjs';

export const meta = {
  id: '152',
  name: 'practice-payment',
  journey: 'onboard',
  covers: ['practice', 'first-run', 'demo', 'real-settlement', 'flow-understood', 'journey-stamps'],
  verifies: 'The first-run practice settles a REAL ∂1.00 practice transfer to the pinned practice payee: the request card names payee and amount, the review is the Pay tab’s own review, Approve signs one envelope, the ledger confirms, the balance drops to ∂99.00, flowUnderstood persists and paymentTested does NOT.',
  timeoutMs: 90000,
};

/** Read + parse the persisted journey store (dpay.journey.v1) from page localStorage. */
async function readJourney(driver) {
  const raw = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
  return raw ? JSON.parse(raw) : null;
}

export async function run() {
  const start = Date.now();
  console.log('[152-practice-payment] setup (relay + web + browser)…');
  const env = await setup({ lazyBoot: false });
  try {
    const {driver, relayBaseURL} = env;

    // Onboard by hand — `onboardWallet` LEAVES practice, and practice is the subject here.
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-practice', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});

    // 1. The request card — a shop's code, with the real polled balance above it.
    await driver.findByTestID('practice', {timeoutMs: 15_000});
    await driver.findByTestID('practice-card', {timeoutMs: 8_000});
    assertIncludes(await driver.readText('practice-card'), 'Practice shop', 'the request card names the payee');
    assertIncludes(await driver.readText('practice-card'), '∂1.00', 'the request card names the amount');
    await driver.waitForText('∂100.00', {timeoutMs: 10_000});
    assertIncludes(await driver.readText('practice-balance'), '∂100.00', 'the header carries the REAL polled practice balance');
    await driver.screenshot('152-practice-request');
    console.log('[152-practice-payment] ✓ the request card is a shop code for ∂1.00');

    // 2. The review is the Pay tab's own review — same component, same testIDs.
    await driver.click('btn-practice-review', {timeoutMs: 5_000});
    await driver.findByTestID('btn-approve', {timeoutMs: 8_000});
    assertIncludes(await driver.readText('pay-amount'), '∂1.00', 'the review names the exact amount');
    assert(await driver.isPresent('btn-review-cancel'), 'the review offers the same Cancel the Pay tab does');
    assert(await driver.isPresent('practice-fee'), 'the review discloses the fee before the payer approves');
    await driver.screenshot('152-practice-review');
    console.log('[152-practice-payment] ✓ the REAL review card, with Approve and Cancel');

    // 3. Approve → the ledger settles it.
    await driver.click('btn-approve', {timeoutMs: 5_000});
    await driver.findByTestID('practice-outcome', {timeoutMs: 30_000});
    const body = await driver.readText('practice-outcome-body');
    assertEq(
      body,
      'That was a real payment on the practice ledger — your phone signed it and the ledger settled it.',
      'the settled outcome says what actually happened',
    );
    assertIncludes(await driver.readText('practice-left'), '∂99.00', 'the remaining balance is measured, not assumed');
    await driver.screenshot('152-practice-settled');
    console.log('[152-practice-payment] ✓ settled, ∂99.00 left');

    // 4. The money moved on a ledger the app does not control.
    const identity = await accountOf(driver);
    assert(identity && typeof identity.publicHex === 'string', 'the wallet identity must be persisted');
    const ledgerBal = await getBalance(relayBaseURL, identity.publicHex, 0);
    assertEq(ledgerBal, '9900', 'the RELAY’s ledger confirms the ∂1.00 left the account');

    // 5. The stamps: seeing the flow, not paying a counterparty.
    const j = await readJourney(driver);
    assert(j, 'the journey store must exist');
    assert(j.stamps.includes('flowUnderstood'), `a settled practice payment leaves flowUnderstood held (got ${j.stamps.join(',')})`);
    assert(!j.stamps.includes('paymentTested'),
      `practice must NOT award paymentTested — the payee is not a counterparty (got ${j.stamps.join(',')})`);
    console.log('[152-practice-payment] ✓ flowUnderstood stamped, paymentTested left for a real payment');

    // 6. One exit, onto the currency question.
    await driver.click('btn-practice-continue', {timeoutMs: 5_000});
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});
    const seen = (await readJourney(driver))?.seen ?? [];
    assert(seen.includes('firstRunPractice'), `leaving practice must persist its seen marker (got ${JSON.stringify(seen)})`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[152-practice-payment] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[152-practice-payment] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
