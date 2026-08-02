// Flow 38 — Relay-switch retargets the LIVE balance poll (gap #5).
//
// A broken retarget = the balance poll keeps hitting the OLD relay after Settings applies a new URL →
// the user sees a STALE balance from the wrong relay (a real safety issue: they could act on a number
// that no longer reflects their position). Flow 12 only proves the relay URL EDITS + PERSISTS; it
// never proves the poll actually retargets mid-session. This flow does.
//
// Gold-standard proof (second-relay variant): onboard on relay A (∂100.00 from the faucet) → spawn a
// SECOND independent relay B → seed a DISTINCT DEMO balance on B (∂500.00) for the SAME account →
// switch the app to relay B via Settings (btn-relay-apply) → assert the header balance changes from
// ∂100.00 to ∂500.00. This proves the poll BOTH stopped hitting A AND started hitting B (the full
// retarget contract). The dead-relay variant would only prove the poll stopped hitting A.
//
// seedDeposit/refreshDeposit take the relay URL as an explicit parameter (a direct HTTP POST), so
// there is no seed-targeting ambiguity: we seed B directly without switching the app first. The
// relay-switch propagates LIVE: SettingsSheet.applyRelay → setRelayUrl → App state → Wallet prop →
// the balance-poll effect re-runs on the new relayUrl (no reload needed).
//
// Selector contract: `btn-settings`, `settings-relay`, `btn-relay-apply`, `btn-settings-close`.
import { setup, assert, onboardWallet, accountOf, seedDeposit, refreshDeposit } from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';

const SEED_RAW_DEMO_B = 50_000; // ∂500.00 on relay B (distinct from A's ∂100.00 faucet)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '38',
  name: 'relay-retarget',
  journey: 'system',
  covers: ['relay-retarget', 'settings-relay-switch', 'live-poll'],
  verifies: 'Settings relay-switch retargets the LIVE balance poll: header changes from A\'s ∂100.00 to B\'s ∂500.00.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[38-relay-retarget] setup…');
  const env = await setup();
  // Independent second relay (own FakeLedger + free port). Seeded with a distinct balance so a
  // retarget is observable as a balance CHANGE, not just an offline flip.
  const r2 = await startRelay();
  try {
    const { driver } = env;

    console.log('[38-relay-retarget] onboarding on relay A (funds ∂100.00)…');
    await onboardWallet(driver, 'e2e-retarget');
    const identity = await accountOf(driver);
    const accountHex = identity.publicHex;

    // Seed a DISTINCT DEMO balance on relay B (∂500.00). Relay A holds ∂100.00 from the faucet, so
    // after retarget the header MUST change if the poll followed the switch. Direct HTTP POSTs to r2
    // — no app switch needed (the helper takes the relay URL explicitly).
    console.log(`[38-relay-retarget] seeding ${SEED_RAW_DEMO_B} raw (∂500.00) on relay B (${r2.baseURL})…`);
    await seedDeposit(r2.baseURL, accountHex, 0, SEED_RAW_DEMO_B);
    await refreshDeposit(r2.baseURL, accountHex, 0);

    // Switch the app to relay B via Settings. The polls retarget LIVE (SettingsSheet.applyRelay →
    // setRelayUrl → Wallet prop → poll effect re-runs) — no reload needed.
    console.log('[38-relay-retarget] opening Settings → switching relay to B…');
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.type('settings-relay', r2.baseURL, { timeoutMs: 4_000 });
    await driver.click('btn-relay-apply', { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // The header balance must change to relay B's ∂500.00 — proving the poll now hits B (not A's
    // ∂100.00). The fast-poll seam (150ms) surfaces the new value within ~1s.
    console.log('[38-relay-retarget] waiting for the balance to retarget to B (∂500.00)…');
    const retargeted = await driver.waitForText('∂500.00', { timeoutMs: 9_000 });
    assert(retargeted, 'balance should retarget to relay B\'s ∂500.00 after the relay switch (poll must follow the live URL)');
    console.log('[38-relay-retarget] ✓ balance now reflects relay B (∂500.00) — poll retargeted');

    await driver.screenshot('38-relay-retarget');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[38-relay-retarget] GREEN in ${elapsed}s`);
  } finally {
    try { await r2.stop(); } catch {}
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[38-relay-retarget] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
