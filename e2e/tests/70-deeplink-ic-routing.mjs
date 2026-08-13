// Flow 70 — A dpay:req deeplink routes to the IC Pay engine even when SOL is idle-selected
// (Phase 5, concern A).
//
// Problem: a `dpay:req/<blob>` (or web `?req=`) is an IC-only deeplink — the requested currency lives
// INSIDE the blob, readable only by DpayCore.decodeRequest. If a Solana asset is idle-selected when
// such a blob arrives, SolPayMode would mount instead and the blob would be SILENTLY LOST (SOL engines
// never consume IC prefills). So Wallet routes the blob to the IC engine: a useEffect sees the pending
// prefill + a non-IC selection and programmatically selects an IC asset (routeDeeplinkToIc), so
// PayMode mounts and consumes the blob. This is PROGRAMMATIC — it calls setSelectedAssetId directly,
// NOT handleSelect, so it bypasses the selection lock (concern B): an incoming request is not a user
// gesture and routing to the right engine must always win.
//
// This flow reproduces the failure scenario and asserts the routing:
//   1. Select SOL (Balances → asset-sol-select). The Pay tab now mounts SolPayMode (sol-pay-scan).
//   2. Fire the foreground-deeplink seam `__DPAY_TEST_DEEPLINK({kind:'req', blob})` — the SAME
//      applyBlob path the OS intent listener + web readers drive. (Web reload can't reproduce this:
//      selectedAssetId is session-local, so a reload resets it to the IC default and the SOL→IC
//      routing never fires. The seam is the documented foreground-deeplink path, mirroring the
//      __DPAY_TEST_RECEIPT_PUBKEY / __DPAY_TEST_SCAN precedents.)
//   3. The routing effect fires: selectedAssetId → ic:0, chip → 'DEMO', PayMode mounts, the prefill
//      effect decodes the blob → review. Assert pay-amount (∂25.00, the EXACT requested amount) is
//      showing and sol-pay-scan is GONE (SolPayMode unmounted).
//
// Selector contract: `active-rail-chip` (header chip), `sol-pay-scan` (SolPayMode scan surface),
// `pay-amount` (PayMode review amount), `btn-approve` (review → sign).
import { setup, assert, assertEq, assertIncludes, onboardWallet, openBalances } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout) and
  * by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for id/name;
  * journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '70',
  name: 'deeplink-ic-routing',
  journey: 'system',
  covers: ['deeplink-routing', 'ic-engine-routing', 'solana-to-ic-handoff', 'prefill-preserve'],
  verifies: 'A dpay:req deeplink arriving while SOL is idle-selected routes to the IC Pay engine (PayMode review), not SolPayMode — the blob is never silently lost.',
  timeoutMs: 20000,
};

const PAY_CENTS = 2500; // ∂25.00 DEMO (currency 0).

export async function run() {
  const start = Date.now();
  console.log('[70-deeplink-ic-routing] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet (DEMO seeded, chip 'DEMO').
    console.log('[70-deeplink-ic-routing] onboarding…');
    await onboardWallet(driver, 'e2e-ic-route');

    // 2. Select SOL via Balances. deriveSolanaAddress is pure (works in web), so solAddress is
    //    populated and selecting SOL arms the SOL engine.
    await openBalances(driver);
    await driver.click('asset-sol-select', { timeoutMs: 5_000 });
    await driver.waitGone('btn-balances-close', { timeoutMs: 5_000 });
    assertEq(await driver.readText('active-rail-chip'), 'SOL', 'SOL selected (chip "SOL")');

    // 3. The Pay tab now mounts SolPayMode (the SOL scan surface). This is the failure precondition:
    //    if a dpay:req blob arrived here without routing, SolPayMode would ignore it.
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await driver.findByTestID('sol-pay-scan', { timeoutMs: 5_000 });
    console.log('[70-deeplink-ic-routing] ✓ SOL idle-selected; SolPayMode mounted (failure precondition)');

    // 4. Fire the foreground-deeplink seam with a ∂25.00 DEMO request blob. This is the SAME applyBlob
    //    path the OS intent listener and the web ?req= reader drive — it sets prefillRequest + mode
    //    'pay'. The blob is a real buildRequestQR output (the exact bytes PayMode will decode).
    const bob = await generateKeypair();
    const blob = buildRequestQR(bob.publicHex, PAY_CENTS, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'Bob');
    await driver.eval(
      (d) => {
        if (typeof window.__DPAY_TEST_DEEPLINK !== 'function') {
          throw new Error('__DPAY_TEST_DEEPLINK is not registered — Wallet did not mount or its deeplink effect (Wallet.tsx) did not fire');
        }
        window.__DPAY_TEST_DEEPLINK(d);
      },
      { kind: 'req', blob },
    );

    // 5. ROUTING: the effect sees the pending prefill + a SOL selection → setSelectedAssetId('ic:0').
    //    The chip flips to 'DEMO' and PayMode mounts in place of SolPayMode.
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    assertEq(await driver.readText('active-rail-chip'), 'DEMO', 'routing flipped the idle selection to the IC asset (chip "DEMO")');

    // 6. PayMode decoded the blob and is in review with the EXACT requested amount. SolPayMode is gone.
    assertIncludes(await driver.readText('pay-amount'), '∂25.00', 'PayMode review shows the exact requested amount (immutable snapshot)');
    const body = await driver.eval(() => document.body?.innerText ?? '');
    assertIncludes(body, 'Bob', 'review shows the merchant name from the decoded request');
    const solPayGone = await driver.eval((id) => !document.querySelector(`[data-testid="${id}"]`), 'sol-pay-scan');
    assert(solPayGone, 'SolPayMode must be unmounted after the IC deeplink routed to PayMode');
    await driver.findByTestID('btn-approve', { timeoutMs: 5_000 }); // review is actionable, not stuck
    console.log('[70-deeplink-ic-routing] ✓ dpay:req routed SOL → IC; PayMode review mounted (not SolPayMode)');

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
