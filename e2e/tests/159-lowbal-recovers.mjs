// Flow 159 — a refusal the wallet has since changed its mind about must not be a dead end.
//
// The camera path decides ONCE, at decode, whether to auto-sign (one-press rule, founder directive
// 2026-08-24). When that one decision lands on a balance that cannot cover the request, the payer
// is refused — correctly, and with no sign control at all (flow 19 owns that contract). What flow
// 19 does NOT cover is what happens when the refusal stops being true: money arrives, the poll
// answers, and the note disappears. Before this flow the screen went blank of controls — amount,
// payee, Cancel, nothing to press — while the header a few pixels above showed a balance that
// covered the payment. A payer standing at a checkout had to Cancel and re-scan to spend money the app
// could already see.
//
// Driven end to end through the REAL app + REAL relay:
//   1. onboard (faucet-funded ∂100.00), scan a ∂200.00 request while ONLINE
//      → `review-lowbal` reads "Not enough balance…" and there is NO sign control (flow 19's
//        structural gate, re-asserted here so this flow cannot pass by weakening it);
//   2. ∂200.00 is credited to the payer's own account STRAIGHT ON THE RELAY (not through the app —
//      the review holds the selection lock, which is exactly the state the bug lived in), so the
//      only thing that changes is what the app's own balance poll reads next;
//   3. the note disappears AND a deliberate `btn-approve` appears — never a silent re-sign: money
//      must not move at a moment the payer did not choose, after they watched it be refused;
//   4. pressing it pays: the payee is credited the exact amount on the ledger.
//
// Selector contract: `pay-amount`, `review-lowbal`, `btn-approve`, `btn-review-cancel`.
import { setup, assert, assertIncludes, accountOf, faucetAccount, getBalance, onboardWallet, armPayScan } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const OVER_CENTS = 20_000; // ∂200.00 — twice the ∂100.00 the faucet grants at onboarding
const TOP_UP_CENTS = 20_000; // credited mid-review, so ∂100.00 + ∂200.00 covers it

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '159',
  name: 'lowbal-recovers',
  journey: 'pay',
  covers: ['low-balance', 'insufficient', 'no-sign-gate', 'scan', 'sign', 'settle'],
  verifies: 'A payment refused on a low balance becomes payable — with a deliberate Approve, never a silent re-sign — as soon as the poll reads enough.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[159-lowbal-recovers] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // The payee: a fresh keypair, no browser needed — its credit is read straight off the ledger.
    const bob = await generateKeypair();
    const bobBefore = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(bobBefore === '0', `payee must start at 0, got ${bobBefore}`);

    console.log('[159-lowbal-recovers] onboarding (faucet-funded ∂100.00)…');
    await onboardWallet(driver, 'e2e-lowbal-recover');
    const me = await accountOf(driver);
    assert(me && typeof me.publicHex === 'string', 'the onboarded identity must carry a publicHex');

    // --- 1. ONLINE + insufficient: refused, nothing signed, and no sign control exists. ---------
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, OVER_CENTS, nonce, expiry, 0, 'merchant');
    console.log('[159-lowbal-recovers] scanning a ∂200.00 request against ∂100.00…');
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    await driver.findByTestID('review-lowbal', { timeoutMs: 5_000 });
    const refusal = await driver.readText('review-lowbal');
    assertIncludes(refusal, 'Not enough balance to cover this payment.',
      'the online refusal must state the block, not the offline warning');
    assert(!(await driver.isPresent('btn-approve')),
      'flow 19 contract: while the payment IS unaffordable there is no sign control at all');
    console.log('[159-lowbal-recovers] ✓ refused honestly, nothing signed, no sign control');

    // --- 2. the money arrives while the review is on screen ------------------------------------
    // Credited on the RELAY, not through the app: the review holds the selection lock, so the
    // wallet's own top-up affordance is (correctly) out of reach — which is precisely the state
    // the payer was stranded in. Nothing about the app changes except what its next poll reads.
    const credited = await faucetAccount(relayBaseURL, me.publicHex, TOP_UP_CENTS);
    assert(credited.ok, `crediting the payer must succeed, got ${credited.status} ${JSON.stringify(credited.body)}`);
    console.log(`[159-lowbal-recovers] credited ∂${(TOP_UP_CENTS / 100).toFixed(2)} → balance ${credited.body.balance}`);

    // --- 3. the refusal clears and the payer gets a DELIBERATE press ---------------------------
    await driver.findByTestID('btn-approve', { timeoutMs: 12_000 });
    assert(!(await driver.isPresent('review-lowbal')),
      'the low-balance note must clear once the poll reads a balance that covers the payment');
    // Nothing may have signed on its own in the meantime: the payer is still on the review.
    await driver.findByTestID('pay-amount', { timeoutMs: 2_000 });
    console.log('[159-lowbal-recovers] ✓ the refusal cleared and Approve appeared — no silent re-sign');

    // --- 4. the deliberate press pays ----------------------------------------------------------
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 15_000 });
    assert(paid, 'the deliberate Approve must sign + settle the payment it was refused for');
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(String(bobAfter) === String(OVER_CENTS),
      `payee must be credited exactly ${OVER_CENTS}, got ${bobAfter}`);
    console.log(`[159-lowbal-recovers] ✓ payee credited 0 → ${bobAfter} (∂${(Number(bobAfter) / 100).toFixed(2)})`);

    await driver.screenshot('159-lowbal-recovers');

    const elapsed = ((Date.now() - start) / 1_000).toFixed(2);
    console.log(`[159-lowbal-recovers] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[159-lowbal-recovers] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
