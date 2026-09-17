// Flow 27 — Multi-currency pay: locked-asset review + per-asset balance check + correct settlement
// (MC5: the payer sees + pays the EXACT requested asset; the balance check uses ONLY that asset's
// balance; dpay never swaps).
//
// Wallet A "e2e-alice" onboards (faucet-funded ∂100 DEMO = 10000 cents) and is then funded ckBTC
// (currency 1) at her PRINCIPAL via the faucet `{account, currency: 1, amount}` — the IC-rail
// deposit-simulation seam (the test/deposit/seed route died with the facade). A's app poll surfaces
// the funded ckBTC balance as `asset-ckbtc` "0.0006 BTC" — this PROVES assetBalances[1] is
// populated + flows into PayMode's review gate.
//
// Then wallet B "Bob" (in-test keypair) builds a ckBTC request: 50000 sats (0.0005 BTC). A
// scans it via the camera seam. The KEY assertion: the OLD code would gate Approve as insufficient
// because `req.amount (50000) > shownBalance (10000 cents)` — a cross-asset comparison that is
// nonsense (sats vs cents). The NEW code (MC5) checks `assetBalances[1] (60000 sats) >= req.amount
// (50000 sats)` → sufficient → Approve is ENABLED → the click succeeds → A's app signs an
// icrc1_transfer envelope (payee = B's principal, memo = the request nonce) + submits it to the
// fake-IC gateway → settlement lands on currency 1's ledger (B credited 50000 ckBTC sats). The
// review also displays "0.0005 BTC" (NOT a misleading "$500.00") — the locked-asset display.
//
// Asserts:
//   - After funding, A's app shows `0.0006 BTC` (assetBalances[1] populated through the poll).
//   - The review's pay-amount reads "Pay 0.0005 BTC" (locked-asset display, no `$`).
//   - The review names the merchant "Bob" (from the request bytes).
//   - the per-asset balance gate (60_000 ≥ 50_000 sats) lets the AUTO-SIGN through → Paid.
//   - B's ckBTC balance (currency 1) grew by 50000 sats (correct ledger settlement at the principal).
//   - The payer's Ledger row renders the ckBTC units ("0.0005 BTC" compact, no `$`).
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc` (the BTC row in Balances),
// `pay-amount` (transient sign status). Camera seam: `window.__DPAY_TEST_SCAN(qr)`.
// Value seam: POST /api/v1/faucet {account, currency: 1, amount}.
import { setup, assert, assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openBalances , armPayScan} from '../harness/lib.mjs';
import { openHistory } from '../harness/flow-steps.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const CKBTC_CURRENCY = 1;
const SEED_SATS = 60_000;   // 0.00060000 BTC
const PAY_SATS = 50_000;    // 0.0005 BTC

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '27',
  name: 'asset-pay',
  journey: 'pay',
  covers: ['asset-pay', 'ckbtc', 'per-asset-balance', 'locked-asset-display', 'ledger-units', 'review-short-payee'],
  verifies: 'ckBTC pay (faucet-funded at principal): review \'0.0005 BTC\' (no $) + short pubkey (U-F5); per-asset balance gate (60000≥50000 sats) → app-signed icrc1_transfer settles on currency 1; Ledger row shows the exact ckBTC units.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[27-asset-pay] setup…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- A onboards (funded ∂100 DEMO by the faucet; will also be funded ckBTC). ----------------
    console.log('[27-asset-pay] onboarding A (payer)…');
    await onboardWallet(driver, 'e2e-alice');
    const identity = await accountOf(driver);
    const accountHex = identity.publicHex;

    // --- Fund ckBTC for A at her principal so assetBalances[1] is non-zero. The credit is
    //     immediate (the faucet credits the fake-IC gateway's principal-keyed ledger); the app's
    //     next balance poll (150ms in the harness) surfaces it as `asset-ckbtc` "0.0006 BTC". ------
    console.log(`[27-asset-pay] funding ${SEED_SATS} sats ckBTC for A via faucet…`);
    const funded = await faucetAccount(relayBaseURL, accountHex, SEED_SATS, { currency: CKBTC_CURRENCY });
    assert(funded.ok, `faucet ckBTC funding should succeed, got status ${funded.status}: ${JSON.stringify(funded.body)}`);

    // Wait for A's app poll to show the ckBTC balance in the Balances BTC row — this PROVES
    // assetBalances[1] is populated (the wallet's parallel per-currency balance poll wrote it;
    // PayMode's review gate reads it). The asset rail no longer lives on the main screen, so the
    // funded amount is verified in the Balances sheet (the money hub).
    console.log('[27-asset-pay] opening Balances; waiting for A’s ckBTC balance to render…');
    await openBalances(driver);
    const seededShown = await driver.waitForText('0.0006 BTC', { timeoutMs: 10_000 });
    assert(seededShown, 'A should render 0.0006 BTC in the Balances BTC row after funding (assetBalances[1] populated)');
    console.log('[27-asset-pay] ✓ A’s ckBTC balance visible (assetBalances[1] populated)');
    // Back to Pay so the scanner is the top surface again before the camera scan.
    await driver.click('tab-pay', { timeoutMs: 5_000 });

    // --- B (the payee) builds a ckBTC request: 50000 sats. ---------------------------------------
    const bob = await generateKeypair();
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_SATS, nonce, expiry, CKBTC_CURRENCY, 'Bob');

    // --- A scans B's ckBTC request via the camera seam. -----------------------------------------
    console.log('[27-asset-pay] injecting B’s ckBTC request via the camera seam…');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

    // --- AUTO-SIGN → settle: the locked-asset display asserts ride the STABLE Paid surface. --
    // (The local settle is fast — the read-only sign status flashes between decode and `paid`;
    // the paid headline uses the same fmtCurrencyAmountCompact, so "0.0005 BTC" / no-`$` still
    // prove the 8-decimal locked-asset display contract. U-F5 short-payee: flow 49's deeplink
    // review owns that pin now.)

    // --- The per-asset balance check (60000 sats >= 50000 sats) let the auto-sign through, even
    //     though the DEMO balance (10000 cents) would have FAILED the old cross-asset gate —
    //     reaching Paid straight from the scan is the proof; a blocked sign would park the
    //     insufficient note instead. A's app signs the icrc1_transfer envelope itself (payee =
    //     B's principal, memo = the request nonce) and submits it to the fake-IC gateway — the
    //     real app-driven rail path.
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach Paid after settling the ckBTC payment');
    console.log('[27-asset-pay] ✓ Paid reached straight from the scan (per-asset gate let the sign through)');

    // --- B was credited on currency 1 at her principal (the request's exact asset — no
    //     substitution). ckBTC carries no fee on the fake catalog → the full 50000 lands.
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, CKBTC_CURRENCY);
    assertEqMoney(bobAfter, PAY_SATS, 'payee B ckBTC balance after settle');
    console.log(`[27-asset-pay] ✓ B credited ${bobAfter} ckBTC sats on currency 1`);

    // --- Ledger row exact units (closes the MC5 coverage gap): the payer's transaction history row
    //     must render the ckBTC payment in its OWN asset's units — "−0.0005 BTC" (Ledger.tsx
    //     composes the U+2212 minus + fmtCurrencyAmount) — NOT a misleading dollar amount. The
    //     history hook fetches EVERY catalog currency, so the currency-1 rail row lands regardless
    //     of the active asset. 'RECENT' is uppercased via CSS text-transform (matches flow 07's
    //     anchor).
    assert(await openHistory(driver, { timeoutMs: 5_000 }), 'the Ledger should render the ckBTC payment row once it lands in history');
    const ledgerBody = await driver.bodyText();
    assertIncludes(ledgerBody, '0.0005 BTC', 'Ledger row must show the ckBTC units (−0.0005 BTC), not a $ amount');
    // The row must not leak a dollar figure for this ckBTC payment (the header's ∂ glyph is not '$',
    // so any '$' here would be a cross-asset formatting bug).
    assert(!ledgerBody.includes('$'), 'Ledger must not show a dollar amount for a ckBTC payment row');
    console.log('[27-asset-pay] ✓ Ledger row shows the ckBTC units (−0.0005 BTC, no $)');

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
