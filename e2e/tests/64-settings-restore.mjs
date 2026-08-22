// Flow 64 — Settings: Restore wallet (import without wipe).
//
// A user who loses their phone had no in-app import path before — they had to Reset (wipe identity)
// first, then restore from Onboarding. The new Settings → Restore section (mirroring Backup's
// two-step idiom) lets them import a wallet from a 64-hex seed WITHOUT wiping first. This flow
// proves the new surface against the REAL app:
//   1. Onboard a fresh wallet (identity A) — secretHex + publicHex captured for the assertion.
//   2. Open Settings → tap btn-settings-restore → settings-restore-seed-input is visible.
//   3. SAME-SEED restore: type A's secretHex → confirm → wallet re-mounts. Assert the new identity
//      is byte-identical to A (same secretHex AND same publicHex — proves keypairFromSecret ran +
//      the identity was REPLACED, not wiped), and the username is preserved.
//   4. DIFFERENT-SEED restore: open Settings → btn-settings-restore → type a different seed
//      ('33'.repeat(32)) → confirm → wallet re-mounts with a NEW key. Assert secretHex changed +
//      publicHex is a fresh 64-hex + the username is STILL preserved (restore keeps the display
//      name across both replacements).
//
// The identity-replace semantics are the heart of the flow: Restore REPLACES identity directly
// (no wipe), so the storage write path is `setItem` (not `removeItem` then `setItem`). The
// same-seed step proves the publicHex derivation is deterministic (a re-derive of the same seed
// yields the same key); the different-seed step proves a fresh seed yields a fresh key.
//
// Selector contract: `btn-settings`, `btn-settings-restore`, `settings-restore-seed-input`,
// `btn-settings-restore-confirm`, `btn-settings-restore-cancel`, `balance`, `header-who`.
// Mirrors flow 58 (Onboarding restore) + flow 57 (Settings backup).
import { setup, assert, assertEq, onboardWallet, accountOf } from '../harness/lib.mjs';

// A second deterministic 32-byte seed, distinct from identity A's. The different-seed step types
// this into the form to prove the wallet key actually changes (a fresh generate would never match).
// '33'.repeat(32) keeps the same shape as flow 58's '22'.repeat(32) but is distinct from it.
const SEED_B = '33'.repeat(32);

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '64',
  name: 'settings-restore',
  journey: 'system',
  covers: ['restore-seed', 'restore-mnemonic-words', 'settings-restore', 'identity-replace', 'keypair-from-secret'],
  verifies: 'Settings → Restore replaces wallet identity from 24 words OR 64-hex seed (no wipe); username preserved.',
  timeoutMs: 60_000, // 2026-08-22: ~27s solo, ~45s under full-suite load on a busy shared host (measured at HEAD too) — 40s budget tipped over deterministically; raised with margin.
};

export async function run() {
  const start = Date.now();
  console.log('[64-settings-restore] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard identity A. Capture secretHex + publicHex — the same-seed assertion compares
    //    byte-for-byte against these. The faucet funds the onboarding so `balance` mounts.
    console.log('[64-settings-restore] onboarding identity A…');
    await onboardWallet(driver, 'alice');
    const idA = await accountOf(driver);
    assert(idA != null && typeof idA.secretHex === 'string', `identity A should be stored (got ${JSON.stringify(idA)})`);
    const seedA = idA.secretHex;
    const pubA = idA.publicHex;
    assert(typeof pubA === 'string' && /^[0-9a-f]{64}$/.test(pubA), `identity A publicHex should be 64-hex (got ${JSON.stringify(pubA)})`);
    console.log(`[64-settings-restore] ✓ identity A captured (${seedA.slice(0, 8)}…${seedA.slice(-4)})`);

    // 2. SAME-SEED restore via Settings → Restore. Opens the form, types A's own seed, confirms.
    //    The wallet re-mounts under the (re-derived) identity; `balance` is the gate. The identity
    //    is BYTE-IDENTICAL to A (the same seed deterministically derives the same keypair) — this
    //    proves keypairFromSecret ran AND onRestore persisted+replaced (not wiped) the identity.
    console.log('[64-settings-restore] same-seed restore (A → A) via Settings…');
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-settings-restore', { timeoutMs: 5_000 });
    await driver.click('btn-settings-restore', { timeoutMs: 5_000 });
    await driver.findByTestID('settings-restore-seed-input', { timeoutMs: 5_000 });
    await driver.type('settings-restore-seed-input', seedA, { timeoutMs: 5_000 });
    await driver.click('btn-settings-restore-confirm', { timeoutMs: 5_000 });

    // The wallet re-mounts under the replaced identity → Settings sheet unmounts + `balance` is
    // back. Wait for it before re-reading the identity from localStorage.
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    const idAfterSame = await accountOf(driver);
    assert(idAfterSame != null, `identity should be present after same-seed restore (got ${JSON.stringify(idAfterSame)})`);
    assertEq(idAfterSame.secretHex, seedA, 'same-seed restore: secretHex should equal A\'s seed');
    assertEq(idAfterSame.publicHex, pubA, 'same-seed restore: publicHex should be unchanged (deterministic derivation)');
    assertEq(idAfterSame.username, 'alice', 'same-seed restore: username preserved');
    console.log(`[64-settings-restore] ✓ same-seed restore → identity unchanged (${idAfterSame.secretHex.slice(0, 8)}…${idAfterSame.secretHex.slice(-4)}), username 'alice' preserved`);

    // 3b. WORDS restore: Backup reveals the 24 BIP-39 words by default, so Settings → Restore
    //     must accept them too (not just 64-hex — 2026-08-16 founder report). Read A's words
    //     from the Backup screen, type THEM into the restore form, and expect identity A back
    //     (words → validateMnemonic → wordsToHex → same deterministic keypair as seedA).
    console.log('[64-settings-restore] words restore (A → A) via Settings…');
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-backup', { timeoutMs: 5_000 });
    await driver.click('btn-backup-confirm', { timeoutMs: 5_000 });
    await driver.findByTestID('mnemonic-words', { timeoutMs: 5_000 });
    const wordsA = [];
    for (let i = 0; i < 24; i++) {
      const t = await driver.readText(`mnemonic-word-${i}`);
      wordsA.push(t.replace(/^\d+\s*/, '').trim());
    }
    await driver.click('btn-settings-restore', { timeoutMs: 5_000 });
    await driver.findByTestID('settings-restore-seed-input', { timeoutMs: 5_000 });
    await driver.type('settings-restore-seed-input', wordsA.join(' '), { timeoutMs: 5_000 });
    await driver.click('btn-settings-restore-confirm', { timeoutMs: 5_000 });
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    const idAfterWords = await accountOf(driver);
    assertEq(idAfterWords?.secretHex, seedA, 'words restore: secretHex should round-trip to A\'s seed');
    assertEq(idAfterWords?.publicHex, pubA, 'words restore: publicHex should equal A\'s (deterministic derivation)');
    assertEq(idAfterWords?.username, 'alice', 'words restore: username preserved');
    console.log('[64-settings-restore] ✓ words restore → identity A back, username preserved');

    // 3. DIFFERENT-SEED restore. Re-opens Settings + the restore form, types a DIFFERENT seed, and
    //    confirms. The wallet re-mounts with a NEW key (different secretHex + different publicHex),
    //    while the username is STILL preserved — proving the identity-replace path threads the
    //    current `username` through to the rebuilt Identity (not a hardcoded default, not wiped).
    console.log('[64-settings-restore] different-seed restore (A → B) via Settings…');
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-settings-restore', { timeoutMs: 5_000 });
    await driver.click('btn-settings-restore', { timeoutMs: 5_000 });
    await driver.findByTestID('settings-restore-seed-input', { timeoutMs: 5_000 });
    await driver.type('settings-restore-seed-input', SEED_B, { timeoutMs: 5_000 });
    await driver.click('btn-settings-restore-confirm', { timeoutMs: 5_000 });
    await driver.findByTestID('balance', { timeoutMs: 10_000 });

    const idB = await accountOf(driver);
    assert(idB != null, `identity B should be present after different-seed restore (got ${JSON.stringify(idB)})`);
    assertEq(idB.secretHex, SEED_B, 'different-seed restore: secretHex should equal the entered seed B');
    assert(
      typeof idB.publicHex === 'string' && /^[0-9a-f]{64}$/.test(idB.publicHex) && idB.publicHex !== pubA,
      `different-seed restore: publicHex should be a fresh 64-hex distinct from A's (got ${JSON.stringify(idB?.publicHex)})`,
    );
    assertEq(idB.username, 'alice', 'different-seed restore: username STILL preserved across the replace');
    console.log(`[64-settings-restore] ✓ different-seed restore → new key (${idB.secretHex.slice(0, 8)}…${idB.secretHex.slice(-4)}), username 'alice' still preserved`);

    // 4. The header still shows the preserved username (the wallet re-mounted under the new identity
    //    + the username carried through both restores).
    const whoText = await driver.readText('header-who');
    assertEq(whoText, 'alice', 'header-who should still show the preserved username after both restores');

    await driver.screenshot('64-settings-restore');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[64-settings-restore] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/64-settings-restore.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[64-settings-restore] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
