// Flow 57 — Settings seed/backup: reveal the IC seed behind a confirm gate + copy.
//
// The documented "one backup recovers BOTH rails" pitch point: the same `identity.secretHex`
// (32-byte IC ed25519 seed, stored in AsyncStorage under `dpay.identity.v1`) also derives the
// SOL key. This flow proves the SettingsSheet affordance:
//   1. The seed is HIDDEN until the user enters + confirms the backup gate (no accidental reveal).
//   2. Once revealed, `seed-phrase` shows the EXACT `identity.secretHex` (read from localStorage).
//   3. The copy button writes the seed to the REAL clipboard (the `window.__DPAY_TEST_CLIPBOARD`
//      seam set by e2e/web/shims.ts:47 — proves `navigator.clipboard.writeText`, not the Share noop).
//
// Selector contract: `btn-settings`, `btn-backup`, `btn-backup-confirm`, `seed-phrase`,
// `btn-copy-seed`. Mirrors flow 04 (deposit-copy) for the clipboard-seam assertion idiom.
import { setup, assertEq, assert, onboardWallet, accountOf } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '57',
  name: 'settings-seed-backup',
  journey: 'system',
  covers: ['seed-backup', 'confirm-gate', 'secret-reveal', 'clipboard-copy'],
  verifies: 'Seed stays hidden behind a confirm gate; once revealed it matches identity.secretHex; copy writes the seed to the real clipboard.',
  timeoutMs: 30_000,
};

export async function run() {
  const start = Date.now();
  console.log('[57-settings-seed-backup] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard a fresh wallet, then read the seeded identity's secretHex (the assertion target).
    //    `onboardWallet` returns the driver; `accountOf` reads the identity back from localStorage.
    console.log('[57-settings-seed-backup] onboarding…');
    await onboardWallet(driver, 'e2e-seed');
    const identity = await accountOf(driver);
    const secretHex = identity?.secretHex;
    assert(
      typeof secretHex === 'string' && secretHex.length > 0,
      `identity.secretHex should be a non-empty string in localStorage (got ${JSON.stringify(secretHex)})`,
    );

    // 2. Open Settings.
    console.log('[57-settings-seed-backup] opening Settings → Backup…');
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.findByTestID('settings-relay', { timeoutMs: 5_000 });

    // 3. The Backup entry row is present; the seed is NOT (it lives behind the confirm gate).
    await driver.findByTestID('btn-backup', { timeoutMs: 5_000 });
    const seedBefore = await driver.isPresent('seed-phrase');
    assertEq(seedBefore, false, 'seed-phrase must be ABSENT before the confirm gate is opened');

    // 4. Open the confirm gate (btn-backup) — the warning + btn-backup-confirm appear; seed still hidden.
    await driver.click('btn-backup', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-backup-confirm', { timeoutMs: 5_000 });
    const seedAtGate = await driver.isPresent('seed-phrase');
    assertEq(seedAtGate, false, 'seed-phrase must be ABSENT at the confirm gate (before pressing confirm)');

    // 5. Confirm → the seed is revealed and matches identity.secretHex EXACTLY.
    await driver.click('btn-backup-confirm', { timeoutMs: 5_000 });
    await driver.findByTestID('seed-phrase', { timeoutMs: 5_000 });
    const revealed = await driver.readText('seed-phrase');
    assertEq(revealed, secretHex, 'revealed seed-phrase must equal identity.secretHex');
    console.log(`[57-settings-seed-backup] ✓ revealed seed matches identity (${secretHex.slice(0, 8)}…${secretHex.slice(-4)})`);

    // 6. The clipboard seam starts empty (proves no prior write leaked the seed).
    const before = await driver.eval(() => window.__DPAY_TEST_CLIPBOARD);
    assertEq(before, '', 'clipboard seam should be empty before copy');

    // 7. Copy the seed → "Copied ✓" confirms the clipboard path (not the Share "Shared ✓" label).
    console.log('[57-settings-seed-backup] clicking btn-copy-seed…');
    await driver.click('btn-copy-seed', { timeoutMs: 5_000 });
    await driver.waitForText('Copied', { timeoutMs: 4_000 });

    // 8. The seam now holds the EXACT seed — proves a real clipboard write happened (not the Share noop).
    const after = await driver.eval(() => window.__DPAY_TEST_CLIPBOARD);
    assertEq(after, secretHex, 'clipboard seam after copy should equal identity.secretHex');
    console.log('[57-settings-seed-backup] ✓ clipboard captured the seed');

    await driver.screenshot('57-settings-seed-backup');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[57-settings-seed-backup] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/57-settings-seed-backup.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[57-settings-seed-backup] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
