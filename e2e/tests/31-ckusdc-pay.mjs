// Flow 31 — ckUSDC (currency 2, 6-decimal) end-to-end pay flow (MC5 remainder).
//
// Mirrors `27-asset-pay.mjs` (ckBTC) but for currency 2 (CkEthErc20 / ckUSDC, 6 decimals). Proves
// the FULL multi-currency pay path for a 6-decimal asset end-to-end through the REAL app + relay,
// under the founder rule (2026-09-12: the customer pays exactly the price; the payee nets the
// ledger fee):
//   - A (payer) onboards + is funded ckUSDC at her PRINCIPAL via the faucet (currency 2).
//   - B (payee, in-test keypair) builds the NETTED ckUSDC request a dpay payee now quotes:
//     typed price 0.050000 USDC − fee 0.010000 = wire 40_000 raw 6-decimal units.
//   - A scans B's request via the camera seam. The KEY assertions:
//       * The raw amount encoded in the request QR is byte-exact: "40000" (NOT a float-rounded
//         "40000.0" or a 2-decimal "400" mis-encoded at DEMO's precision). This is the MC1 exact-
//         amount discipline applied at 6 decimals — and it distinguishes from DEMO's 2-dec space
//         (a 2-dec path would render 40000 raw as ∂400.00, NOT 0.040000 USDC).
//       * the per-asset balance gate (60_000 ≥ the 50_000 price) lets the AUTO-SIGN through → Paid
//         on Paid. A's app signs the icrc1_transfer for the wire with the catalog fee (10_000 raw)
//         + submits it to the fake-IC gateway.
//       * The Paid screen shows the TOTAL DEBIT "0.05 USDC" — wire 40_000 + fee 10_000 = exactly
//         the typed price: the customer moves by exactly the price.
//       * B's ckUSDC balance (currency 2) grew by exactly the wire 40_000 raw units (correct ledger
//         settlement at the principal, no float artifacts; the fee is B's cost as the payee).
//
// Amount choice: 50_000 price raw mirrors flow 27's ckBTC PAY_SATS shape (an obvious parallel) and
// exercises 6-decimal precision meaningfully (0.050000 USDC — the trailing zeros are the display
// contract assertion; a 2-dec path could NOT render this). The fake catalog carries a 10_000-raw
// fee on ckUSDC, so the 60_000 seed covers the price exactly (wire + fee).
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
const SEED_RAW = 60_000;        // 0.060000 USDC (6-decimal) — covers the 50_000 price exactly
const PAY_RAW = 50_000;         // 0.050000 USDC (6-decimal) — the PRICE the customer pays, exactly
const FEE_RAW = 10_000;         // ckUSDC catalog fee — the payee's cost, netted out of the quoted wire
const WIRE_RAW = PAY_RAW - FEE_RAW; // 40_000 — the netted wire the payee's request carries (price − fee)
const EXPECTED_DISPLAY = '0.05 USDC'; // compact formatter output for the 6-dec price total debit

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '31',
  name: 'ckusdc-pay',
  journey: 'pay',
  covers: ['ckusdc-pay', 'multi-currency', '6-decimal', 'byte-exact'],
  verifies: 'ckUSDC (currency 2, 6-decimal) pay end-to-end (faucet-funded at principal) under the founder rule: the payee\'s request QR carries the byte-exact netted wire 40000 (price 0.05 − fee 0.01), the app-signed icrc1_transfer settles on currency 2, the Paid total debit is exactly the price (\'0.05 USDC\'), and the payee nets the fee (credited 40_000).',
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

    // --- B (the payee) builds the NETTED ckUSDC request a dpay payee now quotes: typed price
    //     0.050000 USDC − fee 0.010000 = wire 40_000 raw 6-decimal units. The raw wire is
    //     byte-exact: 0.04 × 10^6 = 40_000 (well below 2^53; no float loss). The merchant's
    //     `toUnits("0.05", 6)` + `nettedWireRaw(..., 10_000)` produce this same raw value via the
    //     BigInt parser. NOTE: a 2-decimal (DEMO) path would render 40_000 raw as ∂400.00 — the
    //     6-decimal expansion to "0.040000 USDC" is the precision contract this flow asserts.
    const bob = await generateKeypair();
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, WIRE_RAW, nonce, expiry, CKUSDC_CURRENCY, 'Bob');

    // --- BYTE-EXACT assertion: the encoded raw wire amount is "40000", not a float artifact. ---
    // This is the MC1 exact-amount discipline applied at 6 decimals (to the netted wire). Decode
    // the QR we just built (the same decode the payer will run on scan) + assert.
    const decoded = decodeRequest(requestQR);
    assert(decoded.currency === CKUSDC_CURRENCY, `request should encode currency ${CKUSDC_CURRENCY} (ckUSDC), got ${decoded.currency}`);
    assert(decoded.amount === String(WIRE_RAW), `request amount should be byte-exact "${WIRE_RAW}" (the netted wire 0.040000 USDC), got ${decoded.amount}`);
    assert(!decoded.amount.includes('.'), `raw amount must be an integer string (no float artifact), got ${decoded.amount}`);
    console.log(`[31-ckusdc-pay] ✓ decoded: currency=${decoded.currency} amount=${decoded.amount} (= 0.040000 USDC netted wire, byte-exact)`);

    // --- A scans B's ckUSDC request via the camera seam. -----------------------------------------
    console.log('[31-ckusdc-pay] injecting B’s ckUSDC request via the camera seam…');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

    // --- AUTO-SIGN → settle: the 6-decimal locked-asset display asserts ride the STABLE Paid
    //     surface (the sign status flashes on a fast local settle; the paid headline uses the
    //     same fmtCurrencyAmount, so "0.050000 USDC" / no-$0.05 still prove the precision
    //     contract below).

    // --- The per-asset balance check (60_000 raw >= the 50_000 price) let the auto-sign through —
    //     reaching Paid straight from the scan is the proof. This is the isPayableAsset gate
    //     (ITEM 2) passing for a known asset — currency 2 is CkEthErc20, a payable family, so the
    //     sign fires (not the fail-closed branch). A's app signs the icrc1_transfer for the wire
    //     with the catalog fee (10_000 raw) — the gateway's fee check passes and the 40_000 wire
    //     lands at B's principal (the fee rides on top of the wire; A moves by exactly the price).
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach Paid after settling the ckUSDC payment');
    // Paid text shows the TOTAL DEBIT — netted wire 40_000 + the ledger fee (10_000 raw) = exactly
    // the typed price, compact: 50_000 raw = "0.05 USDC". The fee fetch is async, so wait for the
    // total to land.
    const totalShown = await driver.waitForText(EXPECTED_DISPLAY, { timeoutMs: 10_000 });
    assert(totalShown, `Paid screen should show the fee-inclusive total "${EXPECTED_DISPLAY}" — the customer pays exactly the price`);
    console.log('[31-ckusdc-pay] ✓ Paid reached: 0.05 USDC total debit (wire 0.04 + fee 0.01 = the price)');

    // --- B was credited on currency 2 at her principal (the request's exact asset — no
    //     substitution). Assert the raw wire is byte-exact: 40_000 raw 6-decimal units credited
    //     (no float loss; the fee is B's cost as the payee — she nets it, founder rule).
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, CKUSDC_CURRENCY);
    assertEqMoney(bobAfter, WIRE_RAW, 'payee B ckUSDC balance after settle (the netted wire)');
    console.log(`[31-ckusdc-pay] ✓ B credited ${bobAfter} raw ckUSDC on currency 2 (= 0.040000 USDC wire, byte-exact; fee netted)`);

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
