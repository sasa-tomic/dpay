// Flow 156 — a restored wallet is not made to practise.
//
// Practice exists because a brand-new wallet has never made a payment and has nobody to make one
// with. A restored wallet is neither: it already holds whatever it held, and the person restoring
// it has just typed 24 words out of their own backup, which is a stronger demonstration of the
// model than any exercise. Putting them through a ∂1.00 practice run would be the app asking for
// something it has already been given.
//
// The mechanism is one line of the first-run router (App.tsx): restore marks `firstRunPractice`
// seen as it hands the identity over, so practice never mounts and never mounts LATER either. The
// second half is what makes that a real assertion rather than a rendering accident — the marker is
// read back out of the persisted journey, so a relaunch cannot resurrect the screen.
//
// The restore happens on a genuinely fresh context (cleared storage, walkthrough and all), because
// that is the real case: a new phone, an old seed.
//
// Selector contract: `btn-create`, `btn-restore`, `restore-mnemonic-input`, `btn-restore-confirm`,
// `mnemonic-word-{0..23}`, `practice`, `home-currency-title`, `balance`.
import {
  setup, assert, assertEq, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent,
  chooseHomeCurrencyIfPresent,
 waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '156',
  name: 'restore-skips-practice',
  journey: 'onboard',
  covers: ['restore', 'first-run-router', 'journey-stamps', 'practice'],
  verifies: 'A restored wallet skips practice entirely — it lands on the currency chooser with firstRunPractice already seen, and the screen does not return on the next launch.',
  timeoutMs: 60_000,
};

async function readJourney(driver) {
  const raw = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
  return raw ? JSON.parse(raw) : null;
}

export async function run() {
  const start = Date.now();
  console.log('[156-restore-skips-practice] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, webBaseURL, relayBaseURL} = env;

    // Mint a real seed the honest way: create a wallet and read its own 24 words off the gate.
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-seed-source', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    const words = [];
    for (let i = 0; i < 24; i++) {
      words.push((await driver.readText(`mnemonic-word-${i}`)).replace(/^\d+\s*/, '').trim());
    }
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await skipPracticeIfPresent(driver);
    await chooseHomeCurrencyIfPresent(driver);
    await waitForWallet(driver, {timeoutMs: 12_000});
    console.log(`[156-restore-skips-practice] ✓ seed minted (${words[0]} … ${words[23]})`);

    // A NEW device: nothing carried over, not even the walkthrough's own stamp.
    await driver.clearStorage();
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, {timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});
    await skipWalkthroughIfPresent(driver);

    await driver.click('btn-restore', {timeoutMs: 5_000});
    await driver.findByTestID('restore-mnemonic-input', {timeoutMs: 5_000});
    await driver.type('restore-mnemonic-input', words.join(' '), {timeoutMs: 8_000});
    await driver.type('username-input', 'e2e-restored', {timeoutMs: 5_000});
    await driver.click('btn-restore-confirm', {timeoutMs: 5_000});

    // Straight to the currency question — practice never mounts.
    await driver.findByTestID('home-currency-title', {timeoutMs: 12_000});
    assert(!(await driver.isPresent('practice')), 'a restored wallet must never be shown the practice payment');
    const seen = (await readJourney(driver))?.seen ?? [];
    assert(seen.includes('firstRunPractice'),
      `restore must persist the practice marker, not merely skip the render (got ${JSON.stringify(seen)})`);
    console.log('[156-restore-skips-practice] ✓ chooser reached, practice marked seen');

    await chooseHomeCurrencyIfPresent(driver);
    await waitForWallet(driver, {timeoutMs: 12_000});

    // And it stays gone: the marker is persisted, so the next launch routes past it too.
    // `domcontentloaded` because the wallet's balance poll keeps the network busy — a networkidle
    // wait would time out on a perfectly healthy app.
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 10_000});
    await driver.waitReady({timeoutMs: 10_000});
    await waitForWallet(driver, {timeoutMs: 12_000});
    assert(!(await driver.isPresent('practice')), 'and it does not come back on the next launch');
    await driver.screenshot('156-restore-skips-practice');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[156-restore-skips-practice] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[156-restore-skips-practice] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
