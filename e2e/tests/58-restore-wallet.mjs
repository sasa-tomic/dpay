// Flow 58 — Restore wallet from recovery seed.
//
// The "one seed recovers BOTH rails" pitch point made operational: at onboarding the user can
// restore a wallet from the 64-hex recovery seed that Backup reveals, instead of generating a fresh
// keypair. The same seed recovers the IC rail (Ed25519 — this flow) AND the Solana rail (SLIP-10
// derivation in app/solana/identity.ts — not exercised here, but the seed is identical).
//
// This flow drives the REAL app/App.tsx onboarding screen in restore mode:
//   1. The onboarding screen renders (username-input visible).
//   2. Tap btn-restore → the restore block appears (restore-seed-input visible).
//   3. Type a FIXED 32-byte seed (0x22 × 32) into restore-seed-input + a username.
//   4. Tap btn-restore-confirm → the wallet mounts (no faucet — a restored wallet has its funds).
//   5. The stored identity's secretHex EQUALS the entered seed, and publicHex is a non-empty 64-hex
//      value derived from it (proves keypairFromSecret ran through the DpayCore shim, not generate).
//
// Selector contract: `btn-restore`, `btn-restore-mode-toggle`, `restore-seed-input`, `username-input`,
// `btn-restore-confirm`, `balance`. The secretHex-equality gate is the proof: a fresh generateKeypair() would never yield
// this exact seed.
import { setup, assert, assertEq, accountOf, skipWalkthroughIfPresent, chooseHomeCurrencyIfPresent, waitForWallet} from '../harness/lib.mjs';

// Fixed 32-byte seed (64 hex chars, all 0x22). Deterministic so the secretHex-equality assertion
// is meaningful. Same seed the FFI roundtrip proves derives a matching keypair.
const SEED = '22'.repeat(32);

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '58',
  name: 'restore-wallet',
  journey: 'onboard',
  covers: ['restore-seed', 'keypair-from-secret', 'both-rails-recovery', 'btn-restore-mode-toggle'],
  verifies: 'A wallet can be restored from the 64-hex recovery seed (toggle to hex mode; no faucet; secretHex matches).',
  timeoutMs: 15_000,
};

export async function run() {
  const start = Date.now();
  console.log('[58-restore-wallet] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. The onboarding screen rendered (create mode). Trip Ready J1: skip the first-run
    //    walkthrough (restore users see it too; it is educational, not a gate).
    console.log('[58-restore-wallet] skipping first-run walkthrough if present…');
    await skipWalkthroughIfPresent(driver);
    console.log('[58-restore-wallet] onboarding screen — waiting for username input…');
    await driver.findByTestID('username-input', { timeoutMs: 8_000 });

    // 2. Switch to restore mode.
    console.log('[58-restore-wallet] tapping btn-restore → restore mode…');
    await driver.click('btn-restore', { timeoutMs: 5_000 });

    // D4-C: restore defaults to mnemonic mode. Toggle to hex mode so restore-seed-input is visible
    // for the fixed-seed test.
    await driver.click('btn-restore-mode-toggle', { timeoutMs: 5_000 });

    // 3. The restore block appears (hex input now visible).
    await driver.findByTestID('restore-seed-input', { timeoutMs: 5_000 });

    // 4. Type the seed + a username.
    console.log('[58-restore-wallet] entering recovery seed + username…');
    await driver.type('restore-seed-input', SEED, { timeoutMs: 5_000 });
    await driver.type('username-input', 'restored', { timeoutMs: 5_000 });

    // 5. Confirm → the wallet mounts (no faucet on restore). Wait for the balance testID.
    console.log('[58-restore-wallet] tapping btn-restore-confirm…');
    await driver.click('btn-restore-confirm', { timeoutMs: 5_000 });

    // 6. The Wallet screen mounts — balance testID is the gate (mirrors flow 01's wallet-loaded check).
    console.log('[58-restore-wallet] wallet screen — waiting for balance…');
    await chooseHomeCurrencyIfPresent(driver);
    await waitForWallet(driver, { timeoutMs: 10_000 });

    // 7. The stored identity's secretHex EQUALS the entered seed (proves keypairFromSecret, not
    //    generate). publicHex is a non-empty 64-hex value derived from it.
    const identity = await accountOf(driver);
    assert(identity != null, `identity should be stored in localStorage (got ${JSON.stringify(identity)})`);
    assertEq(identity.secretHex, SEED, 'restored secretHex equals the entered seed');
    assert(
      typeof identity.publicHex === 'string' && /^[0-9a-f]{64}$/.test(identity.publicHex),
      `restored publicHex should be 64 lowercase hex chars (got ${JSON.stringify(identity?.publicHex)})`,
    );
    assertEq(identity.username, 'restored', 'restored username persisted');
    console.log(`[58-restore-wallet] ✓ identity restored from seed (${identity.secretHex.slice(0, 8)}…${identity.secretHex.slice(-4)})`);

    await driver.screenshot('58-restore-wallet');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[58-restore-wallet] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/58-restore-wallet.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[58-restore-wallet] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
