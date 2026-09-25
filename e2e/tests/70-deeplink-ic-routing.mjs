// Flow 70 — an IC payment LINK routes to the IC Pay engine even when SOL is idle-selected
// (Phase 5, concern A).
//
// Problem: the wallet mounts ONE rail's engine at a time, chosen by the idle asset selection. If a
// Solana asset is selected when a link for an IC asset arrives, SolPayMode would be on screen and
// the payment would be SILENTLY LOST (the SOL engine never consumes an IC payment). So Wallet
// routes it: resolving the link yields the exact asset the link names, and Wallet programmatically
// selects THAT asset so its engine mounts. This is PROGRAMMATIC — it calls setSelectedAssetId
// directly, NOT handleSelect, so it bypasses the selection lock (concern B): an incoming link is
// not a user gesture and routing to the right engine must always win.
//
// This flow reproduces the failure scenario and asserts the routing:
//   1. Select SOL (Balances → asset-sol-select). The Pay tab now mounts SolPayMode (sol-pay-scan).
//   2. Fire the foreground-link seam `__DPAY_TEST_DEEPLINK(<url>)` — the SAME handler the OS App
//      Link listener drives, taking the URL verbatim. (Web navigation can't reproduce this:
//      selectedAssetId is session-local, so a page load resets it to the IC default and the SOL→IC
//      routing never fires. The seam is the documented foreground-link path, mirroring the
//      __DPAY_TEST_SCAN / __DPAY_TEST_SOLANA_RPC_URL precedents.)
//   3. The resolve effect fires: selectedAssetId → ic:0, header label → 'DEMO balance', PayMode
//      mounts and reviews the link. Assert pay-amount (∂25.00, the EXACT requested amount) is
//      showing and sol-pay-scan is GONE (SolPayMode unmounted).
//
// Selector contract: `active-asset-label` (header asset label; the former active-rail chip was
// dropped 2026-08-18), `sol-pay-scan` (SolPayMode scan surface), `pay-amount` (PayMode review
// amount), `btn-approve` (review → sign).
import {
  setup,
  assert,
  assertEq,
  assertIncludes,
  onboardWallet,
  openBalances,
  railPrincipalText,
  selectCurrency,
} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex } from '../harness/wire.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout) and
  * by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for id/name;
  * journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '70',
  name: 'deeplink-ic-routing',
  journey: 'system',
  covers: ['pay-link-routing', 'ic-engine-routing', 'solana-to-ic-handoff', 'prefill-preserve'],
  verifies: 'An IC payment link arriving while SOL is idle-selected routes to the IC Pay engine (PayMode review), not SolPayMode — the payment is never silently lost.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[70-deeplink-ic-routing] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet (DEMO seeded, label 'DEMO balance').
    console.log('[70-deeplink-ic-routing] onboarding…');
    await onboardWallet(driver, 'e2e-ic-route');

    // 2. Select SOL via Balances. deriveSolanaAddress is pure (works in web), so solAddress is
    //    populated and selecting SOL arms the SOL engine.
    await openBalances(driver);
    await selectCurrency(driver, 'sol', { timeoutMs: 5_000 });
    assertEq(await driver.readText('active-asset-label'), 'Balance SOL', 'SOL main (the chip headlines Balance SOL)');

    // 3. The Pay tab now mounts SolPayMode (the SOL scan surface). This is the failure precondition:
    //    if an IC link arrived here without routing, SolPayMode would ignore it.
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await driver.findByTestID('sol-pay-scan', { timeoutMs: 5_000 });
    console.log('[70-deeplink-ic-routing] ✓ SOL idle-selected; SolPayMode mounted (failure precondition)');

    // 4. Fire the foreground-link seam with a ∂25.00 DEMO payment link. This is the SAME handler
    //    the OS App Link listener drives: it parses the URL, resolves the asset against the
    //    catalog, and hands PayMode a ready payment.
    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const link = `https://dpay.kalaj.org/wallet/pay/${bobPrincipal}`
      + `?asset=DEMO&network=internet-computer&amount=25&label=Bob&ref=${randNonceHex()}`;
    await driver.eval(
      (u) => {
        if (typeof window.__DPAY_TEST_DEEPLINK !== 'function') {
          throw new Error('__DPAY_TEST_DEEPLINK is not registered — Wallet did not mount or its link effect (Wallet.tsx) did not fire');
        }
        window.__DPAY_TEST_DEEPLINK(u);
      },
      link,
    );

    // 5. ROUTING: the resolve effect selects the asset the link names → setSelectedAssetId('ic:0').
    //    The header label flips to 'DEMO balance' and PayMode mounts in place of SolPayMode.
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    assertEq(await driver.readText('active-asset-label'), 'Balance SOL', 'the routing flipped the WORKING selection only — the chip keeps the main currency');

    // 6. PayMode resolved the link and is in review with the EXACT requested amount. SolPayMode is gone.
    assertIncludes(await driver.readText('pay-amount'), '∂25.00', 'PayMode review shows the exact requested amount (immutable snapshot)');
    const body = await driver.eval(() => document.body?.innerText ?? '');
    assertIncludes(body, 'Bob', 'review shows the label the link carried');
    const solPayGone = await driver.eval((id) => !document.querySelector(`[data-testid="${id}"]`), 'sol-pay-scan');
    assert(solPayGone, 'SolPayMode must be unmounted after the IC payment link routed to PayMode');
    await driver.findByTestID('btn-approve', { timeoutMs: 5_000 }); // review is actionable, not stuck
    console.log('[70-deeplink-ic-routing] ✓ IC payment link routed SOL → IC; PayMode review mounted (not SolPayMode)');

    await driver.screenshot('70-deeplink-ic-routing');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[70-deeplink-ic-routing] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/70-deeplink-ic-routing.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[70-deeplink-ic-routing] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
