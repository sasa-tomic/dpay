// Flow 31 — ckUSDC (currency 2, 6-decimal) end-to-end pay flow (MC5 remainder).
//
// Mirrors `27-asset-pay.mjs` (ckBTC) but for currency 2 (CkEthErc20 / ckUSDC, 6 decimals). Proves
// the FULL multi-currency pay path for a 6-decimal asset end-to-end through the REAL app + relay:
//   - A (payer) onboards + is SEEDED ckUSDC via the test-helpers deposit route (currency 2).
//   - B (payee, in-test keypair) builds a ckUSDC request: 0.050000 USDC = 50_000 raw 6-decimal units.
//   - A scans B's request via the camera seam. The KEY assertions:
//       * The review's pay-amount reads "Pay 0.050000 USDC" (the catalog's display_decimals=6 +
//         backing_symbol=USDC drive the formatter; NO `$` even though ckUSDC IS a USD stablecoin —
//         fmtCurrencyAmount uses backing_symbol as the suffix, not currencySymbol's glyph).
//       * The raw amount encoded in the request QR is byte-exact: "50000" (NOT a float-rounded
//         "50000.0" or a 2-decimal "500" mis-encoded at DEMO's precision). This is the MC1 exact-
//         amount discipline applied at 6 decimals — and it distinguishes from DEMO's 2-dec space
//         (a 2-dec path would render 50000 raw as ∂500.00, NOT 0.050000 USDC).
//       * btn-approve is NOT disabled (the per-asset balance gate: 60_000 ≥ 50_000) → click lands
//         on Paid.
//       * The receipt verifies (canister-signed, R2) → "Paid ✓ 0.050000 USDC".
//       * B's ckUSDC balance (currency 2) grew by exactly 50_000 raw units (correct ledger
//         settlement, no float artifacts).
//
// Amount choice: 50_000 raw mirrors flow 27's ckBTC PAY_SATS shape (an obvious parallel), stays
// under the FakeLedger's default 100_000 raw per-tx cap (single global, documented simplification),
// and exercises 6-decimal precision meaningfully (0.050000 USDC — the trailing zeros are the display
// contract assertion; a 2-dec path could NOT render this).
//
// This flow exercises ITEM 1 (per-currency balance, though online not offline) + ITEM 2 (a known
// asset passes the isPayableAsset gate end-to-end) — the integrated MC5 multi-currency proof at
// 6-decimal precision.
//
// Selector contract: `balance` (header → Balances), `asset-ckusdc` (the USDC row), `btn-balances-
// close`, `pay-amount`, `btn-approve`. Camera seam: `window.__DPAY_TEST_SCAN(qr)`.
import { setup, assert, assertIncludes, getBalance, onboardWallet, accountOf, seedDeposit, refreshDeposit, openBalances } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR, decodeRequest } from '../harness/wire.mjs';

const CKUSDC_CURRENCY = 2;
const SEED_RAW = 60_000;        // 0.060000 USDC (6-decimal)
const PAY_RAW = 50_000;         // 0.050000 USDC (6-decimal) — mirrors flow 27's PAY_SATS shape
const EXPECTED_DISPLAY = '0.050000 USDC'; // fmtCurrencyAmount output for 6-dec USDC

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '31',
  name: 'ckusdc-pay',
  journey: 'pay',
  covers: ['ckusdc-pay', 'multi-currency', '6-decimal', 'byte-exact'],
  verifies: 'ckUSDC (currency 2, 6-decimal) pay end-to-end: review \'0.050000 USDC\', byte-exact raw, settles on currency 2.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[31-ckusdc-pay] setup…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- A onboards (funded $100 DEMO by the faucet; will also be seeded ckUSDC). ----------------
    console.log('[31-ckusdc-pay] onboarding A (payer)…');
    await onboardWallet(driver, 'e2e-alice');
    const identity = await accountOf(driver);
    const accountHex = identity.publicHex;

    // --- Seed ckUSDC for A so assetBalances[2] is non-zero. The refresh drains + credits; the app's
    //     next balance poll (150ms in the harness) surfaces it as `asset-ckusdc` "0.060000 USDC". ----
    console.log(`[31-ckusdc-pay] seeding ${SEED_RAW} raw (${(SEED_RAW / 1e6).toFixed(6)} USDC) ckUSDC for A…`);
    await seedDeposit(relayBaseURL, accountHex, CKUSDC_CURRENCY, SEED_RAW);
    await refreshDeposit(relayBaseURL, accountHex, CKUSDC_CURRENCY);

    // Wait for A's app poll to show the ckUSDC balance in the Balances USDC row — this PROVES
    // assetBalances[2] is populated (the wallet's parallel per-currency balance poll wrote it;
    // PayMode's review gate reads it). Mirrors flow 27's pattern (open Balances, assert the row).
    console.log('[31-ckusdc-pay] opening Balances; waiting for A’s ckUSDC balance to render…');
    await openBalances(driver);
    const seededShown = await driver.waitForText('0.060000 USDC', { timeoutMs: 10_000 });
    assert(seededShown, 'A should render 0.060000 USDC in the Balances USDC row after seeding (assetBalances[2] populated)');
    console.log('[31-ckusdc-pay] ✓ A’s ckUSDC balance visible (assetBalances[2] populated)');
    // Close Balances so the Pay tab's QrScanner is the top surface again before the camera scan.
    await driver.click('btn-balances-close', { timeoutMs: 5_000 });
    await driver.waitGone('btn-balances-close', { timeoutMs: 4_000 });

    // --- B (the payee) builds a ckUSDC request: 0.050000 USDC = 50_000 raw 6-decimal units. -------
    // The raw amount is byte-exact: 0.05 × 10^6 = 50_000 (well below 2^53; no float loss). The
    // merchant's `toUnits("0.05", 6)` produces this same raw value via the BigInt parser. NOTE: a
    // 2-decimal (DEMO) path would render 50_000 raw as ∂500.00 — the 6-decimal expansion to
    // "0.050000 USDC" is the precision contract this flow asserts.
    const bob = await generateKeypair();
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_RAW, nonce, expiry, CKUSDC_CURRENCY, 'Bob');

    // --- BYTE-EXACT assertion: the encoded raw amount is "50000", not a float artifact. ----------
    // This is the MC1 exact-amount discipline applied at 6 decimals. Decode the QR we just built
    // (the same decode the payer will run on scan) + assert.
    const decoded = decodeRequest(requestQR);
    assert(decoded.currency === CKUSDC_CURRENCY, `request should encode currency ${CKUSDC_CURRENCY} (ckUSDC), got ${decoded.currency}`);
    assert(decoded.amount === String(PAY_RAW), `request amount should be byte-exact "${PAY_RAW}" (0.050000 USDC), got ${decoded.amount}`);
    assert(!decoded.amount.includes('.'), `raw amount must be an integer string (no float artifact), got ${decoded.amount}`);
    console.log(`[31-ckusdc-pay] ✓ decoded: currency=${decoded.currency} amount=${decoded.amount} (= 0.050000 USDC, byte-exact)`);

    // --- A scans B's ckUSDC request via the camera seam. -----------------------------------------
    console.log('[31-ckusdc-pay] injecting B’s ckUSDC request via the camera seam…');
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

    // --- Review screen: locked-asset display (USDC units at 6 decimals) + merchant name. ----------
    // The display is "Pay 0.050000 USDC" — driven by fmtCurrencyAmount(catalog, 2, "50000"):
    //   decimals = display_decimals=6 from the descriptor; unit = backing_symbol="USDC".
    //   fmtAsset("50000", 6, "USDC") = "0.050000 USDC" (zero-padded to 6 fractional places).
    // NOT "$0.05" — fmtCurrencyAmount uses backing_symbol as the suffix, not currencySymbol's glyph.
    // A 2-decimal (DEMO) mis-encode would render 50000 raw as ∂500.00 — the 6-dec display is the
    // precision contract proof.
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    const payAmt = await driver.readText('pay-amount');
    assertIncludes(payAmt, EXPECTED_DISPLAY, `review should show "Pay ${EXPECTED_DISPLAY}" (locked-asset display at 6 decimals), got "${payAmt}"`);
    assert(!/\$0\.05/.test(payAmt), `review must NOT show a "$0.05" amount for a ckUSDC request (fmtCurrencyAmount uses backing_symbol as the unit suffix), got "${payAmt}"`);
    const reviewBody = await driver.bodyText();
    assertIncludes(reviewBody, 'Bob', 'review should name the merchant (from the request bytes)');
    console.log(`[31-ckusdc-pay] ✓ review: ${payAmt} (6-decimal USDC, no $0.05) · names Bob`);

    // --- Approve is NOT disabled: the per-asset balance check (60_000 raw >= 50_000 raw) passes.
    //     The click landing on Paid is the proof; a disabled button would time out. This is the
    //     isPayableAsset gate (ITEM 2) passing for a known asset — currency 2 is CkEthErc20, a
    //     payable family, so the review renders the sign button (not the fail-closed branch).
    console.log('[31-ckusdc-pay] clicking btn-approve (sign + settle on currency 2)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach Paid after settling the ckUSDC payment');
    // Paid text shows the exact ckUSDC amount + asset unit (the locked-asset display continues).
    const paidBody = await driver.bodyText();
    assertIncludes(paidBody, EXPECTED_DISPLAY, `Paid screen should show "${EXPECTED_DISPLAY}" (6-decimal ckUSDC amount), got body:\n${paidBody.slice(0, 400)}`);
    console.log(`[31-ckusdc-pay] ✓ Paid reached: ${EXPECTED_DISPLAY}`);

    // --- B was credited on currency 2 (the request's exact asset — no substitution). -------------
    // Assert the raw amount is byte-exact: 50_000 raw 6-decimal units credited (no float loss).
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, CKUSDC_CURRENCY);
    assertEqMoney(bobAfter, PAY_RAW, 'payee B ckUSDC balance after settle');
    console.log(`[31-ckusdc-pay] ✓ B credited ${bobAfter} raw ckUSDC on currency 2 (= 0.050000 USDC, byte-exact)`);

    await driver.screenshot('31-ckusdc-pay');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[31-ckusdc-pay] GREEN in ${elapsed}s`);
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
  run().catch(async (e) => { console.error(`\n[31-ckusdc-pay] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}

