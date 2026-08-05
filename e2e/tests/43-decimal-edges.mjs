// Flow 43 — Decimal-edges: 8-dec (ckBTC) + 6-dec (ckUSDC) amounts render with EXACT decimals on the
// payment review screen — no rounding, no scientific notation, no trailing-zero drift, no float
// artifact. Covers the browser-reachable slice of the MC1 units-2-4 decimal matrix (the format path
// `fmtCurrencyAmount` → `fmtAsset`).
//
// The format primitive under test (`fmtAsset` in app/lib/format.ts):
//     const n = BigInt(raw);
//     if (n === 0n) return `0 ${unit}`;                       // zero special-case (no precision pad)
//     const scale = 10n ** BigInt(decimals);
//     return `${(n / scale).toString()}.${(n % scale).toString().padStart(decimals, '0')} ${unit}`;
//
// All-BigInt math — no `Number()`, no `parseFloat`. The risk class is the alternative (float math):
//   - 12345678 sats → 0.12345678 BTC exactly via BigInt; via Number it's 0.12345678 (ok at 8 dec)
//     but at 18 dec the low digits fall off Number's 2^53 mantissa.
//   - The trailing-zero case (100000000 sats → 1.00000000 BTC) catches a trim bug (a formatter that
//     drops trailing zeros would render "1 BTC" — wrong fixed-width display).
//   - The low-digit case (1 sat → 0.00000001 BTC) catches a padStart bug.
//
// Plan scope note: the plan asked for 8-dec (ckBTC) + 18-dec (ckERC20). The catalog (FakeLedger's
// `fake_catalog`) has NO 18-dec currency — only DEMO (2), ckBTC (8), ckUSDC (6), ckUSDT (6). All
// three ckERC20 tokens registered (ckUSDC + ckUSDT) mirror their native 6-dec USDC/USDT contract
// precision. An 18-dec asset (e.g. ckDAI, ckWETH) is NOT in the catalog — adding one is a founder
// outer-loop decision (register the ledger + minter on the canister), not a test-harness concern.
// This flow covers the catalog-reachable 8-dec + 6-dec cases; an 18-dec case lands the day a
// 18-dec ckERC20 is registered. The 6-dec case proves the formatter works at non-2,non-8 precision
// just as well as the 8-dec case (the math is decimals-agnostic; only the scale exponent changes).
//
// Coverage matrix:
//   ckBTC (8 dec):
//     - mid: 12345678 sats → '0.12345678 BTC'         (full-precision, every digit exercises)
//     - low: 1 sat        → '0.00000001 BTC'          (padStart: 7 leading zeros)
//     - pad: 100000000 sats → '1.00000000 BTC'         (trailing-zero integrity)
//   ckUSDC (6 dec):
//     - mid: 1234567 raw  → '1.234567 USDC'            (full-precision)
//     - low: 1 raw        → '0.000001 USDC'           (padStart: 5 leading zeros)
//     - pad: 1000000 raw  → '1.000000 USDC'            (trailing-zero integrity)
//
// Approach: build a request QR per case via buildRequestQR (encoding the raw amount + currency),
// inject it via the camera seam (`window.__DPAY_TEST_SCAN`), then read the review screen's pay-amount
// testID + assert it contains the EXACT expected decimal string. Cancel between cases via the
// review screen's aria-label="Cancel" link (no reload needed; mirrors flow 42's pattern). No balance
// seeding needed — the review screen formats the amount from the request bytes alone, before any
// balance check (we only assert the format, not the settle).
//
// Selector contract: `pay-amount` (PayMode's review header). Camera seam: window.__DPAY_TEST_SCAN.
import { setup, assert, assertIncludes, onboardWallet } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const CKBTC_CURRENCY = 1;
const CKUSDC_CURRENCY = 2;

// Each case: { label, currency, raw, expected }. `expected` is the exact substring the review's
// `pay-amount` should contain (PayMode renders `Pay ${fmtCurrencyAmount(...)}`, so the assertion is
// a substring check on the formatted amount + unit, NOT the whole review body — guards against a
// future UI change adding unrelated numbers).
const CASES = [
  // ckBTC (8 dec) — full-precision, low-digit, trailing-zero
  { label: 'ckBTC mid (12345678 sats)',  currency: CKBTC_CURRENCY, raw: 12_345_678,  expected: '0.12345678 BTC' },
  { label: 'ckBTC low (1 sat)',          currency: CKBTC_CURRENCY, raw: 1,           expected: '0.00000001 BTC' },
  { label: 'ckBTC pad (100000000 sats)', currency: CKBTC_CURRENCY, raw: 100_000_000, expected: '1.00000000 BTC' },
  // ckUSDC (6 dec) — full-precision, low-digit, trailing-zero
  { label: 'ckUSDC mid (1234567 raw)',   currency: CKUSDC_CURRENCY, raw: 1_234_567,   expected: '1.234567 USDC' },
  { label: 'ckUSDC low (1 raw)',         currency: CKUSDC_CURRENCY, raw: 1,           expected: '0.000001 USDC' },
  { label: 'ckUSDC pad (1000000 raw)',   currency: CKUSDC_CURRENCY, raw: 1_000_000,   expected: '1.000000 USDC' },
];

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '43',
  name: 'decimal-edges',
  journey: 'pay',
  covers: ['decimal', 'format', 'ckbtc', 'ckerc20'],
  verifies: '8-dec (ckBTC) + 6-dec (ckUSDC) amounts render with exact decimals on review (no rounding, no sci-notation, no trailing-zero drift).',
  timeoutMs: 25000, // 6 scan/cancel cycles + onboard — wider than the 20s default
};

export async function run() {
  const start = Date.now();
  console.log('[43-decimal-edges] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Wallet B (payee) — in-test keypair; the request QR encodes B's pubkey. No balance seeding
    // needed: the review screen formats the amount from the request bytes alone.
    const bob = await generateKeypair();
    console.log(`[43-decimal-edges] wallet B (payee): ${bob.publicHex.slice(0, 16)}…`);

    console.log('[43-decimal-edges] onboarding A…');
    await onboardWallet(driver, 'e2e-decimal');

    // Single expiry reused across cases (10min window) — fresh nonce per case (the nonce is the
    // idempotency key; reusing would let a stale state mask a fresh scan).
    const expiry = Math.floor(Date.now() / 1000) + 600;

    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i];
      const nonce = randNonceHex();
      // Build a merchant request for `c.raw` in `c.currency` (buildRequestQR encodes the raw amount
      // + the currency id; the bytes are what a payer would scan — no decimal-string inference).
      const requestQR = buildRequestQR(bob.publicHex, c.raw, nonce, expiry, c.currency, 'merchant');

      console.log(`[43-decimal-edges] case ${i + 1}/${CASES.length}: ${c.label} (raw=${c.raw}) → expect "${c.expected}"`);
      // Inject via the camera seam — the same path flow 07 uses. The app's onRequestString decodes
      // the QR + transitions to the review screen with the formatted amount.
      await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
      // Wait for the review screen to mount + render the formatted amount.
      await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
      const payAmt = await driver.readText('pay-amount');
      // EXACT substring match — catches rounding (0.12345679), truncation (0.123), sci-notation
      // (1.23e-7), trim (1 BTC for 100000000 sats), and padStart (0.0000001 BTC for 1 sat).
      assertIncludes(payAmt, c.expected, `case "${c.label}" review pay-amount should include exact decimal string`);
      // Anti-pattern spot checks (the float-math failure modes): no scientific notation, no rounded
      // trailing digit. The `expected` substring match already catches these, but the explicit
      // asserts make the failure mode readable in the RED report.
      assert(!/\de[+-]\d/i.test(payAmt), `case "${c.label}": pay-amount must NOT use scientific notation, got "${payAmt}"`);
      console.log(`[43-decimal-edges] ✓ ${c.label}: "${payAmt}" includes "${c.expected}"`);

      // Reset PayMode for the next case via the review screen's Cancel link (aria-label="Cancel";
      // same approach as flow 42 — avoids a reload + the ?relay= re-thread). Skip on the last case
      // (no next iteration to reset for).
      if (i < CASES.length - 1) {
        const canceled = await driver.eval(() => {
          const btn = document.querySelector('button[aria-label="Cancel"]');
          if (btn) { btn.click(); return true; }
          return false;
        });
        assert(canceled === true, `case "${c.label}": review Cancel link should be reachable via aria-label`);
        await driver.waitGone('pay-amount', { timeoutMs: 4_000 });
      }
    }

    await driver.screenshot('43-decimal-edges');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[43-decimal-edges] GREEN in ${elapsed}s (${CASES.length} cases across 8-dec + 6-dec assets)`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[43-decimal-edges] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
