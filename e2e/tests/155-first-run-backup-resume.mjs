// Flow 155 — the 24 words cannot be got past by dying at the right moment.
//
// The defect this pins is not hypothetical and it was in the shipped build until 2026-09-08: the
// keypair was written to `dpay.identity.v1` the instant Create was pressed, and the words were
// shown afterwards. `Onboarding` renders only when there is NO identity — so a phone that died
// while the words were on screen came back with a wallet, walked straight past the backup screen,
// and never offered it again. An unwritten seed, permanently, for a user who was one tap from
// writing it down.
//
// The fix is that a wallet is PENDING until its words are acknowledged. This flow kills the app at
// exactly that moment (a reload with the words on screen) and requires three things:
//   1. the app comes back ON the backup gate, not past it;
//   2. it shows the SAME 24 words — they are derived from the seed, so a resume that produced
//      different words would mean the first set was for a wallet that no longer exists;
//   3. `dpay.identity.v1` is still absent, so a second kill lands here again, and only the
//      acknowledgement writes it.
//
// Selector contract: `mnemonic-backup`, `mnemonic-word-{0..23}`, `mnemonic-backup-checkbox`,
// `btn-mnemonic-continue`, `btn-create`, `practice`, `balance`.
import {setup, assert, assertEq, waitForEnabled, skipWalkthroughIfPresent} from '../harness/lib.mjs';

export const meta = {
  id: '155',
  name: 'first-run-backup-resume',
  journey: 'onboard',
  covers: ['backup-gate', 'persistence', 'recovery', 'first-run-router', 'pending-identity'],
  verifies: 'The backup gate survives an app kill: a wallet created and reloaded before the words are acknowledged comes back to the SAME 24 words, has no persisted identity until they are acknowledged, and cannot reach the wallet in between.',
  timeoutMs: 45_000,
};

/** Read the 24 words off the backup screen (the chips glue "{n}{word}" together). */
async function readWords(driver) {
  const words = [];
  for (let i = 0; i < 24; i++) {
    words.push((await driver.readText(`mnemonic-word-${i}`)).replace(/^\d+\s*/, '').trim());
  }
  return words;
}

const identityKey = () => localStorage.getItem('dpay.identity.v1');
const pendingKey = () => localStorage.getItem('dpay.identity.pending.v1');

export async function run() {
  const start = Date.now();
  console.log('[155-first-run-backup-resume] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, webBaseURL} = env;

    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-resume', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    const before = await readWords(driver);
    assert(before.every(w => w.length > 0), `all 24 words must render (got ${JSON.stringify(before)})`);

    // The wallet does not exist yet — it is PENDING. That is the whole mechanism.
    assertEq(await driver.eval(identityKey), null, 'no identity is written while the words are unacknowledged');
    assert(await driver.eval(pendingKey), 'the generated keypair is parked as pending');
    console.log('[155-first-run-backup-resume] ✓ words on screen, no identity written');

    // THE KILL. A reload is exactly what the phone dying does to this page: every in-memory
    // machine is gone and only what was persisted survives.
    await driver.navigate(webBaseURL, '/', {timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});

    // 1 + 2: back ON the gate, with the same words.
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 10_000});
    assert(!(await driver.isPresent('balance')), 'the wallet must be unreachable until the words are acknowledged');
    assert(!(await driver.isPresent('practice')), 'and so must every screen after it');
    assert(!(await driver.isPresent('btn-create')), 'the resume shows the GATE, not a second create form');
    const after = await readWords(driver);
    assertEq(after.join(' '), before.join(' '), 'the resumed gate shows the SAME 24 words');
    // 3: still nothing written, so a second kill lands here too.
    assertEq(await driver.eval(identityKey), null, 'a kill mid-backup still leaves no identity behind');
    await driver.screenshot('155-first-run-backup-resume');
    console.log('[155-first-run-backup-resume] ✓ reload lands back on the gate, same words, nothing written');

    // Only the acknowledgement creates the wallet.
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.findByTestID('practice', {timeoutMs: 15_000});
    const persisted = JSON.parse(await driver.eval(identityKey));
    assert(persisted && typeof persisted.publicHex === 'string' && persisted.publicHex.length === 64,
      `acknowledging the words is what writes the identity (got ${JSON.stringify(persisted)})`);
    assertEq(await driver.eval(pendingKey), null, 'and the pending record is cleared, not left as a second wallet');
    console.log('[155-first-run-backup-resume] ✓ the acknowledgement — and only it — creates the wallet');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[155-first-run-backup-resume] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[155-first-run-backup-resume] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
