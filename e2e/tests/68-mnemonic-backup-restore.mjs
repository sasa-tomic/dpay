// Flow 68 — Mnemonic backup→restore cycle (BIP-39 round-trip).
//
// D4's headline proof: the 24 words shown at create time ACTUALLY recover the same wallet. Creates a
// wallet, reads the 24 mnemonic words from the backup screen, resets, then restores via those exact
// words (the default restore mode). The restored identity's publicHex MUST equal the original — that's
// the proof the mnemonic↔entropy codec is a lossless round-trip through the REAL UI.
//
// This flow is the end-to-end analog of the BIP-39 unit tests (app/lib/bip39.ts): it proves the
// on-device key generation → hexToWords → display → stringToWords → wordsToHex → keypairFromSecret
// chain preserves the exact Ed25519 keypair. One seed recovers BOTH rails (IC + SOL), but this flow
// asserts the IC publicHex (the SOL key is SLIP-10 derived from the same seed, exercised separately).
//
// Selector contract: `btn-create`, `mnemonic-backup`, `mnemonic-word-{0..23}`,
// `mnemonic-backup-checkbox`, `btn-mnemonic-continue`, `btn-settings`, `btn-reset`,
// `btn-reset-confirm`, `btn-restore`, `restore-mnemonic-input`, `btn-restore-confirm`, `balance`.
import { setup, assert, assertEq, accountOf, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '68',
  name: 'mnemonic-backup-restore',
  journey: 'onboard',
  covers: ['mnemonic-backup', 'mnemonic-word-{0..23}', 'mnemonic-backup-checkbox', 'btn-mnemonic-continue', 'restore-mnemonic-input', 'bip39-round-trip', 'restore-via-mnemonic'],
  verifies: 'The 24 mnemonic words shown at create time recover the exact same wallet keypair (publicHex match) when entered on restore.',
  timeoutMs: 45_000,
};

export async function run() {
  const start = Date.now();
  console.log('[68-mnemonic-backup-restore] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Fresh onboarding: skip the first-run walkthrough (Trip Ready J1), type username + tap Create.
    console.log('[68-mnemonic-backup-restore] skipping first-run walkthrough if present…');
    await skipWalkthroughIfPresent(driver);
    console.log('[68-mnemonic-backup-restore] onboarding (create)…');
    await driver.typeByPlaceholder('e.g. Alice', 'MnemonicTester', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });

    // 2. Mnemonic backup screen appears — read all 24 words (strip the "{n}" number prefix; RNW
    //    concatenates the number+word text nodes with no space, so \s* handles both cases).
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    const words = [];
    for (let i = 0; i < 24; i++) {
      const t = await driver.readText(`mnemonic-word-${i}`);
      words.push(t.replace(/^\d+\s*/, '').trim());
    }
    const blankIdx = words.findIndex((w) => !w);
    assert(blankIdx === -1, `all 24 mnemonic words should be non-empty (blank at index ${blankIdx})`);
    console.log(`[68-mnemonic-backup-restore] ✓ read 24 words (${words[0]} … ${words[23]})`);

    // 2b. The Copy-words button must put the PURE space-joined words on the clipboard — no
    //     position numbers (the rendered chips glue "{n}{word}" together, so a manual
    //     select-all-copy drags the numbers along; 2026-08-16 founder report).
    await driver.click('btn-mnemonic-copy', { timeoutMs: 4_000 });
    const copiedWords = await driver.eval(() => window.__DPAY_TEST_CLIPBOARD);
    assertEq(copiedWords, words.join(' '),
      'btn-mnemonic-copy should copy the pure space-joined words (no position numbers)');
    console.log('[68-mnemonic-backup-restore] ✓ Copy words → clipboard holds the pure 24 words');

    // 3. Dismiss the backup (checkbox + Continue) → the faucet runs + the wallet loads.
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
    // The recovery beat plays, then the first-run practice payment; leave it (create path only).
    await skipPracticeIfPresent(driver);

    // 4. Wallet loaded — read the original identity's publicHex (the assertion target).
    await chooseHomeCurrencyIfPresent(driver);
    await driver.findByTestID('balance', { timeoutMs: 12_000 });
    const original = await accountOf(driver);
    assert(original && typeof original.publicHex === 'string' && original.publicHex.length === 64,
      `original identity must have a 64-hex publicHex (got ${JSON.stringify(original?.publicHex)})`);
    const originalPublicHex = original.publicHex;
    console.log(`[68-mnemonic-backup-restore] ✓ wallet created (${originalPublicHex.slice(0, 16)}…)`);

    // 5. Settings → Reset → confirm → onboarding returns.
    console.log('[68-mnemonic-backup-restore] resetting wallet…');
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-reset', { timeoutMs: 5_000 });
    await driver.click('btn-reset-confirm', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-create', { timeoutMs: 8_000 });

    // 6. Restore via the mnemonic words (the DEFAULT restore mode — no toggle needed).
    console.log('[68-mnemonic-backup-restore] restoring via mnemonic words…');
    await driver.click('btn-restore', { timeoutMs: 5_000 });
    await driver.findByTestID('restore-mnemonic-input', { timeoutMs: 5_000 });
    await driver.type('restore-mnemonic-input', words.join(' '), { timeoutMs: 8_000 });
    await driver.type('username-input', 'MnemonicTester2', { timeoutMs: 5_000 });
    await driver.click('btn-restore-confirm', { timeoutMs: 5_000 });

    // 7. Wallet loaded under the restored keypair.
    await chooseHomeCurrencyIfPresent(driver);
    await driver.findByTestID('balance', { timeoutMs: 12_000 });

    // 8. The restored identity's publicHex MUST equal the original — the mnemonic recovered the
    //    exact same Ed25519 keypair.
    const restored = await accountOf(driver);
    assert(restored && typeof restored.publicHex === 'string',
      `restored identity must have a publicHex (got ${JSON.stringify(restored?.publicHex)})`);
    assertEq(restored.publicHex, originalPublicHex,
      'restored publicHex must equal the original (mnemonic round-trip preserves the keypair)');
    console.log(`[68-mnemonic-backup-restore] ✓ mnemonic restored the same keypair (${restored.publicHex.slice(0, 16)}…)`);
    assertEq(restored.username, 'MnemonicTester2', 'restored username should be the one typed at restore');

    await driver.screenshot('68-mnemonic-backup-restore');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[68-mnemonic-backup-restore] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/68-mnemonic-backup-restore.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[68-mnemonic-backup-restore] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
