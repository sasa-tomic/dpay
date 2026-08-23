// Flow 35 — UX tour: capture a screenshot of every major screen for visual/flow review.
//
// The e2e net is pixel-BLIND (AGENTS.md: "Style regressions are invisible to the suite" — it matches
// testID + textContent only). This flow drives the REAL app (react-native-web; only I/O is shimmed)
// through every primary surface and captures a PNG at each via `driver.screenshot(name)` into
// `e2e/shots/`. The screenshots are then reviewed with zai-vision for layout/visual/flow quality —
// the class of issues the assertion net structurally cannot catch (overflow, contrast, alignment,
// dead-space, confusing hierarchy, inconsistent units).
//
// This is NOT a behavior test (the 01–34 flows cover behavior); it is a VISUAL capture harness. Its
// GREEN contract is merely "every screen rendered without throwing" — the screenshots are the product.
//
// Screens captured: onboarded wallet (Pay), Receive + request QR, Balances hub, Settings, Ledger.
import { setup, onboardWallet, assert } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '35',
  name: 'ux-tour',
  journey: 'tour',
  covers: ['visual-capture', 'screen-census', 'screenshots'],
  verifies: 'Visual capture: screenshots of every major screen (Pay, Receive+QR, Balances, Settings, Ledger) for review.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[35-ux-tour] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard a funded wallet ($100 demo). Lands on the Pay tab.
    console.log('[35-ux-tour] onboarding…');
    await onboardWallet(driver, 'e2e-tour');
    await driver.waitForText('Đ100.00', { timeoutMs: 5_000 });
    await driver.screenshot('35-tour-wallet-pay');
    console.log('[35-ux-tour] ✓ shot: onboarded wallet (Pay tab)');

    // 2. Receive → enter an amount → request QR screen.
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '42.50', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    await driver.screenshot('35-tour-receive-request');
    console.log('[35-ux-tour] ✓ shot: receive + request QR');
    // NOTE: an earlier version tried `click('btn-new')` here to leave the request screen, but btn-new
    // exists ONLY in PayMode (after a payment), never in ReceiveMode — so that click burned its full
    // 3s timeout every run waiting for a button that cannot exist (a silent 3s tax on the critical
    // path). The header `balance` is always present (even over the request card), and tapping it
    // opens the Balances hub directly — the next destination anyway. One click, zero wasted seconds.

    // 3. Balances hub (full currency list + per-asset actions) — opened by tapping the header balance.
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    await driver.screenshot('35-tour-balances');
    console.log('[35-ux-tour] ✓ shot: balances hub');
    await driver.click('btn-balances-close', { timeoutMs: 4_000 });

    // 4. Settings (relay config + reset). Expand the Advanced disclosure so the relay input is
    //    captured (the founder-directed default is collapsed).
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.click('btn-advanced-toggle', { timeoutMs: 4_000 });
    await driver.findByTestID('settings-relay', { timeoutMs: 5_000 });
    await driver.screenshot('35-tour-settings');
    console.log('[35-ux-tour] ✓ shot: settings');
    // Dismiss Settings via its close button (NOT a full location.reload() — that re-fetched the
    // bundle + re-ran the poll IIFE, costing ~2s for no coverage gain). btn-settings-close returns
    // to the wallet root with the funded identity still mounted.
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // 5. Ledger tab (transaction history — empty initially for a fresh wallet).
    //    The tab is labeled "Transactions" → testID `tab-transactions` (Tab.tsx: `tab-${label.toLowerCase()}`).
    await driver.click('tab-transactions', { timeoutMs: 5_000 });
    // An empty wallet renders the literal "No payments yet." (Ledger.tsx); wait for it with a
    // SHORT timeout — the fast-poll seam (150ms) lands it near-instantly, and this is a non-asserting
    // best-effort render beat, not a correctness gate, so never pay a long timeout here.
    await driver.waitForText('No payments yet', { timeoutMs: 3_000 }).catch(() => {});
    await driver.screenshot('35-tour-ledger');
    console.log('[35-ux-tour] ✓ shot: ledger');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[35-ux-tour] GREEN in ${elapsed}s (5 screens captured → e2e/shots/)`);
    assert(true, 'tour completed');
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[35-ux-tour] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
