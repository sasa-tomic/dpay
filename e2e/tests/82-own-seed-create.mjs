// Flow 82 — Create a new wallet from the user's OWN seed (paste/enter instead of random).
//
// The create screen offers an ALTERNATIVE to the generated random key: "Use my own seed instead"
// reveals a field accepting EITHER the 24 BIP-39 words OR the 64-hex seed (auto-detected). This is
// distinct from Restore (flow 58): an own-seed CREATE still runs the full create pipeline — the
// backup gate + the demo faucet — it just builds the keypair from the pasted seed via
// keypairFromSecret instead of generateKeypair.
//
// State matrix exercised here:
//   1. INVALID seed  → Create stays on the form with the error copy (no wallet, no gate).
//   2. WORDS form    → backup gate shows the exact pasted words back (words→hex→words identity
//                      through the REAL app codec), Continue → faucet funds the wallet, and the
//                      stored identity's secretHex equals the words' hex encoding.
//   3. HEX form      → same contract with the 64-hex form (the restore-style input).
//
// The fixed seed is 0x22 × 32 (flow 58's SEED) so the hex-equality assertion is meaningful; its
// mnemonic (precomputed from the same codec app/lib/bip39.ts implements) is
// "captain baby mass dust" ×5 + "captain baby mass fault".
import { setup, assert, assertEq, accountOf, skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent, waitForWallet} from '../harness/lib.mjs';

const SEED = '22'.repeat(32);
const WORDS = `${'captain baby mass dust '.repeat(5).trim()} captain baby mass fault`.replace(/\s+/g, ' ').trim();

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '82',
  name: 'own-seed-create',
  journey: 'onboard',
  covers: ['own-seed', 'btn-own-seed-toggle', 'own-seed-input', 'create-from-seed', 'faucet', 'mnemonic-backup'],
  verifies: 'Create a wallet from a pasted seed (words OR hex) instead of a random one; invalid seed is rejected on the form.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[82-own-seed-create] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, webBaseURL, relayBaseURL } = env;

    // 0. The onboarding screen rendered (create mode). Trip Ready J1: skip the first-run
    //    walkthrough so the create form is reachable.
    await skipWalkthroughIfPresent(driver);
    await driver.findByTestID('username-input', { timeoutMs: 8_000 });

    // 1. INVALID seed → error copy, still on the form.
    console.log('[82-own-seed-create] opening the own-seed field…');
    await driver.click('btn-own-seed-toggle', { timeoutMs: 5_000 });
    await driver.findByTestID('own-seed-input', { timeoutMs: 5_000 });
    console.log('[82-own-seed-create] typing an INVALID seed → expecting form error…');
    await driver.type('own-seed-input', 'not a valid seed at all', { timeoutMs: 5_000 });
    await driver.click('btn-create', { timeoutMs: 5_000 });
    const errBody = await driver.bodyText();
    assert(errBody.includes("doesn't look right"), `invalid own seed should show the error copy (got: ${errBody.slice(0, 200)})`);
    assert(!(await driver.isPresent('mnemonic-backup')), 'invalid own seed must NOT open the backup gate');
    console.log('[82-own-seed-create] ✓ invalid seed rejected on the form');

    // 2. WORDS form → backup gate shows the same words back; Continue funds via the faucet.
    console.log('[82-own-seed-create] pasting the 24-word form…');
    await driver.type('own-seed-input', WORDS, { timeoutMs: 5_000 });
    await driver.type('username-input', 'ownseed', { timeoutMs: 5_000 });
    await driver.click('btn-create', { timeoutMs: 5_000 });
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    const shown = [];
    for (let i = 0; i < 24; i++) {
      const t = await driver.readText(`mnemonic-word-${i}`);
      shown.push(t.replace(/^\d+\s*/, ''));
    }
    assertEq(shown.join(' '), WORDS, 'backup gate shows the pasted words back (words→seed→words identity)');
    console.log('[82-own-seed-create] ✓ backup gate round-trips the pasted words');
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 5_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 5_000 });
    // The recovery beat plays, then the first-run practice payment; leave it (create path only).
    await skipPracticeIfPresent(driver);
    await chooseHomeCurrencyIfPresent(driver);
    await waitForWallet(driver, { timeoutMs: 10_000 });
    let identity = await accountOf(driver);
    assert(identity != null, `identity should be stored (got ${JSON.stringify(identity)})`);
    assertEq(identity.secretHex, SEED, 'created secretHex equals the pasted words\' hex encoding');
    assertEq(identity.username, 'ownseed', 'username persisted');
    console.log('[82-own-seed-create] ✓ words-form create stored the pasted seed (+faucet ran)');

    // 3. HEX form → same contract via the 64-hex paste (wiped storage = fresh onboarding; the
    //    explicit ?relay= re-seeds the relay config that clearStorage() also wiped — without it the
    //    app falls back to the default relay URL and the faucet POST dies ERR_CONNECTION_REFUSED).
    await driver.clearStorage();
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    // clearStorage() also wiped the journey store → the first-run walkthrough gates this fresh
    // boot; skip past it (educational, not a barrier) to reach the create form.
    await skipWalkthroughIfPresent(driver);
    await driver.findByTestID('username-input', { timeoutMs: 8_000 });
    await driver.click('btn-own-seed-toggle', { timeoutMs: 5_000 });
    await driver.type('own-seed-input', SEED.toUpperCase(), { timeoutMs: 5_000 }); // uppercase → normalized
    await driver.type('username-input', 'hexseed', { timeoutMs: 5_000 });
    await driver.click('btn-create', { timeoutMs: 5_000 });
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 5_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 5_000 });
    // Trip Ready J2B/J3 — same interstitial on the hex-form create path.
    await skipPracticeIfPresent(driver);
    await chooseHomeCurrencyIfPresent(driver);
    await waitForWallet(driver, { timeoutMs: 10_000 });
    identity = await accountOf(driver);
    assertEq(identity.secretHex, SEED, 'hex-form create stored the normalized seed');
    console.log('[82-own-seed-create] ✓ hex-form create stored the pasted seed');

    await driver.screenshot('82-own-seed-create');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[82-own-seed-create] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/82-own-seed-create.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[82-own-seed-create] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
