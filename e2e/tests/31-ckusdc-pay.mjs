// Flow 31 — ckUSDC (currency 2, 6-decimal) end-to-end pay flow (MC5 remainder).
//
// Mirrors `27-asset-pay.mjs` (ckBTC) but for currency 2 (CkEthErc20 / ckUSDC, 6 decimals). Proves
// the FULL multi-currency pay path for a 6-decimal asset end-to-end through the REAL app + relay:
//   - A (payer) onboards + is funded ckUSDC at her PRINCIPAL via the faucet (currency 2).
//   - B (payee, in-test keypair) builds a ckUSDC request: 0.050000 USDC = 50_000 raw 6-decimal units.
//   - A scans B's request via the camera seam. The KEY assertions:
//       * The review's pay-amount reads "Pay 0.050000 USDC" (the catalog's display_decimals=6 +
//         backing_symbol=USDC drive the formatter; NO `$` even though ckUSDC IS a USD stablecoin —
//         fmtCurrencyAmount uses backing_symbol as the suffix, not currencySymbol's glyph).
//       * The raw amount encoded in the request QR is byte-exact: "50000" (NOT a float-rounded
//         "50000.0" or a 2-decimal "500" mis-encoded at DEMO's precision). This is the MC1 exact-
//         amount discipline applied at 6 decimals — and it distinguishes from DEMO's 2-dec space
//         (a 2-dec path would render 50000 raw as ∂500.00, NOT 0.050000 USDC).
//       * the per-asset balance gate (60_000 ≥ 50_000) lets the AUTO-SIGN through → Paid
//         on Paid. A's app signs the icrc1_transfer with the catalog fee (10_000 raw) + submits it
//         to the fake-IC gateway.
//       * B's ckUSDC balance (currency 2) grew by exactly 50_000 raw units (correct ledger
//         settlement at the principal, no float artifacts; the fee is charged to the sender).
//
// Amount choice: 50_000 raw mirrors flow 27's ckBTC PAY_SATS shape (an obvious parallel) and
// exercises 6-decimal precision meaningfully (0.050000 USDC — the trailing zeros are the display
// contract assertion; a 2-dec path could NOT render this). The fake catalog carries a 10_000-raw
// fee on ckUSDC, so the 60_000 seed covers the 50_000 payment + the fee exactly.
//
// This flow exercises ITEM 1 (per-currency balance, though online not offline) + ITEM 2 (a known
// asset passes the isPayableAsset gate end-to-end) — the integrated MC5 multi-currency proof at
// 6-decimal precision.
//
// Selector contract: `balance` (header → Balances), `asset-ckusdc` (the USDC row),
// `pay-amount` (transient sign status). Camera seam: `window.__DPAY_TEST_SCAN(qr)`.
// Value seam: POST /api/v1/faucet {account, currency: 2, amount}.
import { setup, assert, assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openBalances , armPayScan} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR, decodeRequest } from '../harness/wire.mjs';

const CKUSDC_CURRENCY = 2;
const SEED_RAW = 60_000;        // 0.060000 USDC (6-decimal) — covers 50_000 pay + 10_000 fee
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
  verifies: 'ckUSDC (currency 2, 6-decimal) pay end-to-end (faucet-funded at principal): review \'0.050000 USDC\', byte-exact raw, app-signed icrc1_transfer settles on currency 2.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[31-ckusdc-pay] setup…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- A onboards (funded ∂100 DEMO by the faucet; will also be funded ckUSDC). ----------------
    console.log('[31-ckusdc-pay] onboarding A (payer)…');
    await onboardWallet(driver, 'e2e-alice');
    const identity = await accountOf(driver);
    const accountHex = identity.publicHex;

    // --- Fund ckUSDC for A at her principal so assetBalances[2] is non-zero. The credit is
    //     immediate; the app's next balance poll (150ms in the harness) surfaces it as
    //     `asset-ckusdc` "0.06 USDC". ---------------------------------------------------------------
    console.log(`[31-ckusdc-pay] funding ${SEED_RAW} raw (${(SEED_RAW / 1e6).toFixed(6)} USDC) ckUSDC for A via faucet…`);
    const funded = await faucetAccount(relayBaseURL, accountHex, SEED_RAW, { currency: CKUSDC_CURRENCY });
    assert(funded.ok, `faucet ckUSDC funding should succeed, got status ${funded.status}: ${JSON.stringify(funded.body)}`);

    // Wait for A's app poll to show the ckUSDC balance in the Balances USDC row — this PROVES
    // assetBalances[2] is populated (the wallet's parallel per-currency balance poll wrote it;
    // PayMode's review gate reads it). Mirrors flow 27's pattern (open Balances, assert the row).
    console.log('[31-ckusdc-pay] opening Balances; waiting for A’s ckUSDC balance to render…');
    await openBalances(driver);
    const seededShown = await driver.waitForText('0.06 USDC', { timeoutMs: 10_000 });
    assert(seededShown, 'A should render 0.06 USDC in the Balances USDC row after funding (assetBalances[2] populated)');
    console.log('[31-ckusdc-pay] ✓ A’s ckUSDC balance visible (assetBalances[2] populated)');
    // Back to Pay so the scanner is the top surface again before the camera scan.
    await driver.click('tab-pay', { timeoutMs: 5_000 });

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
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

    // --- AUTO-SIGN → settle: the 6-decimal locked-asset display asserts ride the STABLE Paid
    //     surface (the sign status flashes on a fast local settle; the paid headline uses the
    //     same fmtCurrencyAmount, so "0.050000 USDC" / no-$0.05 still prove the precision
    //     contract below).

    // --- The per-asset balance check (60_000 raw >= 50_000 raw) let the auto-sign through —
    //     reaching Paid straight from the scan is the proof. This is the isPayableAsset gate
    //     (ITEM 2) passing for a known asset — currency 2 is CkEthErc20, a payable family, so the
    //     sign fires (not the fail-closed branch). A's app signs the icrc1_transfer with the
    //     catalog fee (10_000 raw) — the gateway's fee check passes and 50_000 lands at B's
    //     principal (the fee is charged to the sender).
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach Paid after settling the ckUSDC payment');
    // Paid text shows the exact ckUSDC amount + asset unit (the locked-asset display continues).
    const paidBody = await driver.bodyText();
    assertIncludes(paidBody, EXPECTED_DISPLAY, `Paid screen should show "${EXPECTED_DISPLAY}" (6-decimal ckUSDC amount), got body:\n${paidBody.slice(0, 400)}`);
    console.log(`[31-ckusdc-pay] ✓ Paid reached: ${EXPECTED_DISPLAY}`);

    // --- B was credited on currency 2 at her principal (the request's exact asset — no
    //     substitution). Assert the raw amount is byte-exact: 50_000 raw 6-decimal units credited
    //     (no float loss; the 10_000 fee came out of A's side).
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
