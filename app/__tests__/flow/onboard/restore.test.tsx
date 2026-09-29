/**
 * Flows 58 + 68 + 82 — restore and own-seed creation — the jest twins of `e2e/tests/58-restore-wallet.mjs`,
 * `68-mnemonic-backup-restore.mjs`, `82-own-seed-create.mjs`. (bip39/wallet tests pin the derivation;
 * these port the surface legs.)
 *
 * 58: hex-seed restore stores the ENTERED seed as secretHex and derives a fresh 64-hex publicHex.
 * 68: the backup gate round-trips — Copy words puts the PURE space-joined words on the clipboard
 *     (no position numbers), and after a reset, restoring via the words recovers the EXACT keypair.
 * 82: the own-seed field rejects garbage with error copy, the words form round-trips onto the
 *     backup gate, and a hex paste is normalized (uppercase accepted).
 */
import {it, expect} from '@jest/globals';
import {
  accountOf, assertEq, chooseHomeCurrencyIfPresent, clipboardAfterCopy, skipPracticeIfPresent,
  skipWalkthroughIfPresent, waitForEnabled, waitForWallet,
} from '../harness/lib';
import {mountApp} from '../harness/mount';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const g = globalThis as unknown as Record<string, unknown>;

const SEED = '22'.repeat(32);
const WORDS_LIST = `${'captain baby mass dust '.repeat(5).trim()} captain baby mass fault`.replace(/\s+/g, ' ').trim();


async function readWords(m: Awaited<ReturnType<typeof mountApp>>): Promise<string[]> {
  const words: string[] = [];
  for (let i = 0; i < 24; i++) {
    words.push(m.driver.readText(`mnemonic-word-${i}`).replace(/^\d+\s*/, '').trim());
  }
  return words;
}

hermeticDescribe('flow 58 — restore-wallet', () => {
  it('hex-seed restore stores the entered seed and derives its keypair', async () => {
    const m = await mountApp();
    await skipWalkthroughIfPresent(m);
    await m.driver.findByTestID('username-input', {timeoutMs: 8000});

    // Switch to restore mode; D4-C: restore defaults to mnemonic — toggle to hex.
    await m.driver.click('btn-restore', {timeoutMs: 5000});
    await m.driver.click('btn-restore-mode-toggle', {timeoutMs: 5000});
    await m.driver.findByTestID('restore-seed-input', {timeoutMs: 5000});
    await m.driver.type('restore-seed-input', SEED, {timeoutMs: 5000});
    await m.driver.type('username-input', 'restored', {timeoutMs: 5000});
    await m.driver.click('btn-restore-confirm', {timeoutMs: 5000});

    await chooseHomeCurrencyIfPresent(m);
    await waitForWallet(m, {timeoutMs: 10_000});

    // The stored identity's secretHex EQUALS the entered seed (keypairFromSecret, not generate).
    const identity = await accountOf(m);
    expect(identity).not.toBeNull();
    assertEq(identity!.secretHex, SEED, 'restored secretHex equals the entered seed');
    expect(/^[0-9a-f]{64}$/.test(identity!.publicHex)).toBe(true);
    assertEq(identity!.username, 'restored', 'restored username persisted');

    await m.unmount();
  }, 120_000);
});

hermeticDescribe('flow 68 — mnemonic-backup-restore', () => {
  it('Copy words copies the pure 24 words; after a reset the words recover the EXACT keypair', async () => {
    const m = await mountApp();
    await skipWalkthroughIfPresent(m);
    await m.driver.typeByPlaceholder('e.g. Alice', 'MnemonicTester', {timeoutMs: 8000});
    await m.driver.click('btn-create', {timeoutMs: 4000});

    // Read all 24 words off the backup gate.
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    const words = await readWords(m);
    expect(words.findIndex((w) => !w)).toBe(-1);

    // 2b. Copy-words puts the PURE space-joined words on the clipboard — no position numbers.
    g.__DPAY_TEST_CLIPBOARD = '';
    await m.driver.click('btn-mnemonic-copy', {timeoutMs: 4000});
    expect(await clipboardAfterCopy()).toBe(words.join(' '));

    // Dismiss the backup → the wallet loads; capture the original publicHex.
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
    await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.waitForFunction(
      () => m.driver.isPresent('practice') || m.driver.isPresent('home-currency-title') || m.driver.isPresent('tab-home'),
      {timeoutMs: 15_000, label: 'the post-backup beat mounts'},
    );
    await m.driver.click('btn-practice-skip', {timeoutMs: 3000}).catch(() => {});
    await chooseHomeCurrencyIfPresent(m);
    await waitForWallet(m, {timeoutMs: 12_000});
    const original = await accountOf(m);
    expect(original?.publicHex).toHaveLength(64);
    const originalPublicHex = original!.publicHex;

    // Settings → Reset → confirm → onboarding returns.
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-reset', {timeoutMs: 5000});
    await m.driver.click('btn-reset-confirm', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-create', {timeoutMs: 8000});

    // Restore via the mnemonic words (the DEFAULT restore mode — no toggle needed).
    await m.driver.click('btn-restore', {timeoutMs: 5000});
    await m.driver.findByTestID('restore-mnemonic-input', {timeoutMs: 5000});
    await m.driver.type('restore-mnemonic-input', words.join(' '), {timeoutMs: 8000});
    await m.driver.type('username-input', 'MnemonicTester2', {timeoutMs: 5000});
    await m.driver.click('btn-restore-confirm', {timeoutMs: 5000});

    await chooseHomeCurrencyIfPresent(m);
    await waitForWallet(m, {timeoutMs: 12_000});

    // The restored identity's publicHex MUST equal the original.
    const restored = await accountOf(m);
    expect(restored?.publicHex).toBeTruthy();
    assertEq(restored!.publicHex, originalPublicHex, 'mnemonic round-trip preserves the keypair');
    assertEq(restored!.username, 'MnemonicTester2', 'restored username is the one typed at restore');

    await m.unmount();
  }, 150_000);
});

hermeticDescribe('flow 82 — own-seed-create', () => {
  it('invalid seed rejected on the form; the words form round-trips onto the gate; a hex paste is normalized', async () => {
    const m = await mountApp();
    await skipWalkthroughIfPresent(m);
    await m.driver.findByTestID('username-input', {timeoutMs: 8000});

    // 1. INVALID seed → error copy, still on the form, no backup gate.
    await m.driver.click('btn-own-seed-toggle', {timeoutMs: 5000});
    await m.driver.findByTestID('own-seed-input', {timeoutMs: 5000});
    await m.driver.type('own-seed-input', 'not a valid seed at all', {timeoutMs: 5000});
    await m.driver.click('btn-create', {timeoutMs: 5000});
    expect(m.driver.bodyText().includes("doesn't look right")).toBe(true);
    expect(m.driver.isPresent('mnemonic-backup')).toBe(false);

    // 2. WORDS form → the backup gate shows the same words back; Continue proceeds (faucet runs).
    await m.driver.type('own-seed-input', WORDS_LIST, {timeoutMs: 5000});
    await m.driver.type('username-input', 'ownseed', {timeoutMs: 5000});
    await m.driver.click('btn-create', {timeoutMs: 5000});
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    const shown = await readWords(m);
    assertEq(shown.join(' '), WORDS_LIST, 'backup gate shows the pasted words back');
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 5000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 5000});
    // The recovery beat plays, then the first-run practice payment; leave it (create path only).
    await skipPracticeIfPresent(m);
    await chooseHomeCurrencyIfPresent(m);
    await waitForWallet(m, {timeoutMs: 10_000});
    let identity = await accountOf(m);
    expect(identity).not.toBeNull();
    assertEq(identity!.secretHex, SEED, "created secretHex equals the pasted words' hex encoding");
    assertEq(identity!.username, 'ownseed', 'username persisted');
    await m.unmount();

    // 3. HEX form → same contract via a 64-hex paste (uppercase → normalized). A NEW device:
    //    the mid-test storage purge is scenario setup (the old freshContext call — the harness
    //    lifecycle only owns the BETWEEN-test purge).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage') as {clear: () => Promise<void>};
    await AsyncStorage.clear();
    const m2 = await mountApp();
    await skipWalkthroughIfPresent(m2);
    await m2.driver.findByTestID('username-input', {timeoutMs: 8000});
    await m2.driver.click('btn-own-seed-toggle', {timeoutMs: 5000});
    await m2.driver.type('own-seed-input', SEED.toUpperCase(), {timeoutMs: 5000});
    await m2.driver.type('username-input', 'hexseed', {timeoutMs: 5000});
    await m2.driver.click('btn-create', {timeoutMs: 5000});
    await m2.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    await m2.driver.click('mnemonic-backup-checkbox', {timeoutMs: 5000});
    await m2.driver.click('btn-mnemonic-continue', {timeoutMs: 5000});
    await skipPracticeIfPresent(m2);
    await chooseHomeCurrencyIfPresent(m2);
    await waitForWallet(m2, {timeoutMs: 10_000});
    identity = await accountOf(m2);
    assertEq(identity!.secretHex, SEED, 'hex-form create stored the normalized seed');
    await m2.unmount();
  }, 180_000);
});
