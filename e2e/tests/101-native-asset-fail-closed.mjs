// Flow 101 — Native-asset fail-closed paths (wave: VCHF+ICP support, 2026-08-28).
//
// Obligation (10): the new no-minter native rows must inherit the wallet's fail-closed posture —
// insufficient per asset (VCHF AND ICP legs), malformed/unknown currency as one shared leg:
//   * Insufficient (per asset): a request for more than the wallet's balance in THAT asset parks
//         the review card on review-lowbal "Not enough balance to cover this payment." with NO
//         approve button and NO paid button — no doomed submit, no envelope ever signed (fetch
//         recorder stays empty), and the payee receives nothing in that currency.
//   * Unknown currency (shared): a request for currency 99 (not in the catalog) hits the
//         unsupported-asset branch: review-unsupported, "Unsupported asset" + "(currency 99)"
//         body, NO approve, NO sign, NO canister call. dpay never swaps — there is no fallback.
// After all three legs the wallet's balances are exactly what was faucet-seeded: nothing moved.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, armPayScan,
} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const INSUFFICIENT_LEGS = [
  { currency: 7, tag: 'VCHF', testKey: 'vchf' },
  { currency: 8, tag: 'ICP', testKey: 'icp' },
];
const TINY_SEED = 20000; // 0.00020000 VCHF/ICP — far below the request, but nonzero (funded, still insufficient)
const PAY = 100000001; // 1.00000001 — what the merchant asks
const UNKNOWN_CURRENCY = 99; // not in the catalog — the malformed/unknown leg

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '101',
  name: 'native-asset-fail-closed',
  journey: 'pay',
  covers: ['vchf', 'icp', 'icp-mainnet', 'insufficient', 'unknown-currency', 'unsupported-asset', 'fail-closed', 'no-swap'],
  verifies: 'Insufficient VCHF and ICP requests park on review-lowbal with no approve/paid button and no signed envelope; an unknown-currency (99) request hits the unsupported-asset branch with no fallback; the payee receives nothing and the payer keeps exactly its seeded balances.',
  timeoutMs: 30000, // three blocked legs + two tiny faucets + recorder checks under parallel load
};

export async function run() {
  const start = Date.now();
  console.log('[101-native-asset-fail-closed] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL, driver } = env;

    console.log('[101-native-asset-fail-closed] onboarding payer…');
    await onboardWallet(driver, 'e2e-failclosed');
    const account = await accountOf(driver);
    const merchant = await generateKeypair();

    // Ledger-target recorder over window.fetch — installed once; NO leg may ever reach a canister.
    await driver.eval(() => {
      window.__E2E_CANISTER_CALLS = [];
      const orig = window.fetch;
      window.fetch = function patchedFetch(input) {
        try {
          const u = typeof input === 'string' ? input : (input && input.url) || String(input);
          if (u.includes('/api/v2/canister/')) window.__E2E_CANISTER_CALLS.push(u);
        } catch { /* never break the app on a recorder fault */ }
        return orig.apply(this, arguments);
      };
    });

    // --- Insufficient legs (VCHF, then ICP) ----------------------------------------------------
    for (const leg of INSUFFICIENT_LEGS) {
      console.log(`[101-native-asset-fail-closed] insufficient ${leg.tag} leg…`);
      await openBalances(driver);
      await selectCurrency(driver, leg.testKey);
      const fund = await faucetAccount(relayBaseURL, account.publicHex, TINY_SEED, { currency: leg.currency });
      assert(fund.ok, `${leg.tag} tiny faucet credit ok (status ${fund.status})`);
      await driver.waitForText(`0.00020000 ${leg.tag}`, { timeoutMs: 10_000 }); // funded, still insufficient

      await driver.click('tab-pay', { timeoutMs: 4_000 });
      await armPayScan(driver);
      const nonce = randNonceHex();
      const expiry = Math.floor(Date.now() / 1000) + 600;
      const requestQR = buildRequestQR(merchant.publicHex, PAY, nonce, expiry, leg.currency, 'Merchant');
      await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

      const body = await driver.bodyText();
      assertIncludes(body, 'Not enough balance to cover this payment.', `${leg.tag}: review shows the insufficient-balance block`);
      assertIncludes(body, `Pay 1.00000001 ${leg.tag}`, `${leg.tag}: blocked review still shows the exact requested amount`);
      assert(!(await driver.isPresent('btn-approve')), `${leg.tag}: no approve button on a doomed payment`);
      assert(!(await driver.isPresent('btn-paid')), `${leg.tag}: no paid button on a doomed payment`);
      assert(!body.match(/\bPaid\b/), `${leg.tag}: payment never executes`);

      const calls = (await driver.eval(() => window.__E2E_CANISTER_CALLS ?? [])) || [];
      assert(calls.length === 0, `${leg.tag}: NO envelope was signed or submitted (canister calls: ${calls.length})`);
      assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, leg.currency)), '0', `${leg.tag}: merchant received nothing`);

      await driver.click('btn-review-cancel', { timeoutMs: 4_000 });
      await driver.findByTestID('pay-scan', { timeoutMs: 6_000 }); // back to the scan surface
    }

    // --- Unknown-currency leg (shared) -----------------------------------------------------------
    console.log('[101-native-asset-fail-closed] unknown-currency (99) leg…');
    await armPayScan(driver);
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const ghostQR = buildRequestQR(merchant.publicHex, PAY, nonce, expiry, UNKNOWN_CURRENCY, 'Merchant');
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, ghostQR);

    const ghostBody = await driver.bodyText();
    assertIncludes(ghostBody, 'Unsupported asset', 'unknown-currency request hits the unsupported-asset branch');
    assertIncludes(ghostBody, 'currency 99', 'unsupported body names the offending currency id');
    assert(!(await driver.isPresent('btn-approve')), 'no approve button for an unsupported asset');
    assert(!(await driver.isPresent('btn-paid')), 'no paid button for an unsupported asset');
    assert(!ghostBody.match(/\bPaid\b/), 'unsupported request never executes');

    const seen = (await driver.eval(() => window.__E2E_CANISTER_CALLS ?? [])) || [];
    const calls = seen.filter((u) => u.endsWith('/call')); // ignore /read_state status polls
    assert(calls.length === 0, `unsupported leg signed nothing (canister calls: ${calls.length})`);

    // --- Nothing moved: the payer keeps exactly what was seeded ---------------------------------
    assertEq(String(await getBalance(relayBaseURL, account.publicHex, '0')), '10000', 'payer DEMO balance intact after all blocked legs');
    assertEq(String(await getBalance(relayBaseURL, account.publicHex, '7')), String(TINY_SEED), 'payer VCHF balance intact (tiny seed, nothing spent)');
    assertEq(String(await getBalance(relayBaseURL, account.publicHex, '8')), String(TINY_SEED), 'payer ICP balance intact (tiny seed, nothing spent)');

    await driver.screenshot('101-native-asset-fail-closed');
    console.log(`[101-native-asset-fail-closed] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('101-native-asset-fail-closed RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
