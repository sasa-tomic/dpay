// Flow 27 — Multi-currency pay: locked-asset review + per-asset balance check + correct settlement
// (MC5: the payer sees + pays the EXACT requested asset; the balance check uses ONLY that asset's
// balance; dpay never swaps).
//
// Wallet A "e2e-alice" onboards (faucet-funded $100 DEMO = 10000 cents) and is then SEEDED ckBTC
// (currency 1) via the test-helpers deposit/seed route + a refresh (mirrors flow 24). A's app poll
// surfaces the seeded ckBTC balance as `asset-ckbtc` "0.00060000 BTC" — this PROVES assetBalances[1]
// is populated + flows into PayMode's review gate.
//
// Then wallet B "Bob" (in-test keypair) builds a ckBTC request: 50000 sats (0.00050000 BTC). A
// scans it via the camera seam. The KEY assertion: the OLD code would gate Approve as insufficient
// because `req.amount (50000) > shownBalance (10000 cents)` — a cross-asset comparison that is
// nonsense (sats vs cents). The NEW code (MC5) checks `assetBalances[1] (60000 sats) >= req.amount
// (50000 sats)` → sufficient → Approve is ENABLED → the click succeeds → settlement lands on
// currency 1's ledger (B credited 50000 ckBTC sats). The review also displays "0.00050000 BTC" (NOT
// a misleading "$500.00") — the locked-asset display.
//
// Asserts:
//   - After seeding, A's app shows `0.00060000 BTC` (assetBalances[1] populated through the poll).
//   - The review's pay-amount reads "Pay 0.00050000 BTC" (locked-asset display, no `$`).
//   - The review names the merchant "Bob" (from the request bytes).
//   - btn-approve is NOT disabled (the per-asset balance gate passes), clicking it lands on Paid.
//   - B's ckBTC balance (currency 1) grew by 50000 sats (correct ledger settlement).
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc` (the BTC row in Balances),
// `btn-balances-close`, `pay-amount`, `btn-approve`. Camera seam: `window.__DPAY_TEST_SCAN(qr)`.
import { setup, assert, assertIncludes, getBalance, onboardWallet, accountOf, seedDeposit, refreshDeposit, openBalances } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const CKBTC_CURRENCY = 1;
const SEED_SATS = 60_000;   // 0.00060000 BTC
const PAY_SATS = 50_000;    // 0.00050000 BTC

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '27',
  name: 'asset-pay',
  journey: 'pay',
  covers: ['asset-pay', 'ckbtc', 'per-asset-balance', 'locked-asset-display', 'ledger-units', 'review-short-payee'],
  verifies: 'ckBTC pay: review shows \'0.00050000 BTC\' (no $) + short pubkey (U-F5); per-asset balance gate (60000≥50000 sats) → settles on currency 1; Ledger row shows the exact ckBTC units.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[27-asset-pay] setup…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- A onboards (funded $100 DEMO by the faucet; will also be seeded ckBTC). ----------------
    console.log('[27-asset-pay] onboarding A (payer)…');
    await onboardWallet(driver, 'e2e-alice');
    const identity = await accountOf(driver);
    const accountHex = identity.publicHex;

    // --- Seed ckBTC for A so assetBalances[1] is non-zero. The refresh drains + credits; the app's
    //     next balance poll (150ms in the harness) surfaces it as `asset-ckbtc` "0.00060000 BTC". ----
    console.log(`[27-asset-pay] seeding ${SEED_SATS} sats ckBTC for A…`);
    await seedDeposit(relayBaseURL, accountHex, CKBTC_CURRENCY, SEED_SATS);
    await refreshDeposit(relayBaseURL, accountHex, CKBTC_CURRENCY);

    // Wait for A's app poll to show the ckBTC balance in the Balances BTC row — this PROVES
    // assetBalances[1] is populated (the wallet's parallel per-currency balance poll wrote it;
    // PayMode's review gate reads it). The asset rail no longer lives on the main screen, so the
    // seeded amount is verified in the Balances sheet (the money hub).
    console.log('[27-asset-pay] opening Balances; waiting for A’s ckBTC balance to render…');
    await openBalances(driver);
    const seededShown = await driver.waitForText('0.00060000 BTC', { timeoutMs: 10_000 });
    assert(seededShown, 'A should render 0.00060000 BTC in the Balances BTC row after seeding (assetBalances[1] populated)');
    console.log('[27-asset-pay] ✓ A’s ckBTC balance visible (assetBalances[1] populated)');
    // Close Balances so the Pay tab's QrScanner is the top surface again before the camera scan.
    await driver.click('btn-balances-close', { timeoutMs: 5_000 });
    await driver.waitGone('btn-balances-close', { timeoutMs: 4_000 });

    // --- B (the payee) builds a ckBTC request: 50000 sats. ---------------------------------------
    const bob = await generateKeypair();
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_SATS, nonce, expiry, CKBTC_CURRENCY, 'Bob');

    // --- A scans B's ckBTC request via the camera seam. -----------------------------------------
    console.log('[27-asset-pay] injecting B’s ckBTC request via the camera seam…');
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

    // --- Review screen: locked-asset display (BTC units, NOT $) + merchant name. -----------------
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    const payAmt = await driver.readText('pay-amount');
    assertIncludes(payAmt, '0.00050000 BTC', `review should show "Pay 0.00050000 BTC" (locked-asset display), got "${payAmt}"`);
    assert(!payAmt.includes('$'), `review must NOT show a dollar amount for a ckBTC request, got "${payAmt}"`);
  const reviewBody = await driver.bodyText();
  assertIncludes(reviewBody, 'Bob', 'review should name the merchant (from the request bytes)');
  // U-F5 (asset rail twin of flow 26): the dim short-payee line under the merchant name.
  await driver.findByTestID('review-payee', { timeoutMs: 5_000 });
  const reviewPayee = await driver.readText('review-payee');
  if (reviewPayee !== `${bob.publicHex.slice(0, 8)}…`) {
    throw new Error(`[assert] review short-payee line (U-F5): expected ${bob.publicHex.slice(0, 8)}…, got ${JSON.stringify(reviewPayee)}`);
  }
  console.log(`[27-asset-pay] ✓ review: ${payAmt} (no $) · names Bob · ${reviewPayee}`);

    // --- Approve is NOT disabled: the per-asset balance check (60000 sats >= 50000 sats) passes,
    //     even though the DEMO balance (10000 cents) would have FAILED the old cross-asset gate. The
    //     click landing on Paid is the proof; a disabled button would time out.
    console.log('[27-asset-pay] clicking btn-approve (sign + settle on currency 1)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach Paid after settling the ckBTC payment');
    console.log('[27-asset-pay] ✓ Paid reached (per-asset balance gate let the ckBTC payment through)');

    // --- B was credited on currency 1 (the request's exact asset — no substitution). -------------
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, CKBTC_CURRENCY);
    assertEqMoney(bobAfter, PAY_SATS, 'payee B ckBTC balance after settle');
    console.log(`[27-asset-pay] ✓ B credited ${bobAfter} ckBTC sats on currency 1`);

    // --- Ledger row exact units (closes the MC5 coverage gap): the payer's transaction history row
    //     must render the ckBTC payment in its OWN asset's units — "−0.00050000 BTC" (Ledger.tsx
    //     composes the U+2212 minus + fmtCurrencyAmount) — NOT a misleading dollar amount. The OLD
    //     familyDisplay() path would have NPE'd or shown `$`; fmtCurrencyAmount is fail-closed. This
    //     is the assertion FLOWS.md documented as missing (the row's exact units post multi-currency
    //     settle). 'RECENT' is uppercased via CSS text-transform (matches flow 07's anchor). ---------
    await driver.click('tab-transactions', { timeoutMs: 5_000 });
    const hasRecent = await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    assert(hasRecent, 'the Ledger should render the ckBTC payment row once it lands in history');
    const ledgerBody = await driver.bodyText();
    assertIncludes(ledgerBody, '0.00050000 BTC', 'Ledger row must show the EXACT ckBTC units (−0.00050000 BTC), not a $ amount');
    // The row must not leak a dollar figure for this ckBTC payment (the header's ∂ glyph is not '$',
    // so any '$' here would be a cross-asset formatting bug).
    assert(!ledgerBody.includes('$'), 'Ledger must not show a dollar amount for a ckBTC payment row');
    console.log('[27-asset-pay] ✓ Ledger row shows the exact ckBTC units (−0.00050000 BTC, no $)');

    await driver.screenshot('27-asset-pay');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[27-asset-pay] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function assertEqMoney(actual, expected, label) {
  // MC1 units 2-4: compare raw-u64 amounts as decimal strings (BigInt-safe; `actual` is the relay's
  // string form, `expected` may be a number literal in the test).
  if (String(actual) !== String(expected)) throw new Error(`[assert] ${label}: expected ${expected}, got ${actual}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[27-asset-pay] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
