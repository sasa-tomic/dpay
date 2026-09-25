// Flow 01 — Onboard (verify gate for the scaffold).
//
// Boots the REAL app/App.tsx in a real browser, against the REAL test relay (FakeLedger, offline),
// and drives the new-user onboarding flow end-to-end:
//   1. The Onboarding screen renders (no identity in AsyncStorage yet).
//   2. Type a username into the field (no testID — find by placeholder "e.g. Alice").
//   3. Click btn-create. The app calls DpayCore.generateKeypair (our @noble/ed25519 shim), saves the
//      identity to AsyncStorage, and best-effort funds the account via POST /api/v1/faucet.
//   4. The Wallet screen renders with: balance (the faucet funds ∂100.00 in DEMO_USD), empty history.
//   5. Screenshot to e2e/shots/01-onboard.png.
//
// Note on the asserted balance: the brief said "∂0.00", but the REAL app's `create()` does a
// best-effort faucet POST on onboarding (see App.tsx:233-235). With the REAL relay up (the whole
// point of the harness), that POST succeeds and funds ∂100.00, so the wallet's first balance poll
// reads ∂100.00 — NOT ∂0.00. Asserting ∂0.00 would require disabling the faucet, which would break
// the "use the REAL relay + REAL FakeLedger" rule. We assert ∂100.00 (proves faucet→balance
// end-to-end) and note this deviation. Empty history is asserted verbatim (no payments settled yet).
import {
  setup,
  assert,
  assertIncludes,
  waitForEnabled,
  skipWalkthroughIfPresent,
  skipPracticeIfPresent,
  chooseHomeCurrencyIfPresent,
  selectDemoAsset,
  waitForWallet,
  openBalances,
} from '../harness/lib.mjs';

const ONBOARD_USERNAME = 'e2e-alice';
const ONBOARD_PLACEHOLDER = 'e.g. Alice';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '01',
  name: 'onboard',
  journey: 'onboard',
  covers: ['onboard', 'faucet', 'first-balance', 'empty-history', 'non-custodial'],
  verifies: 'New user enters a name → wallet created, faucet funds ∂100, balance + empty history render; custody + never-moves-money honesty copy present at create + backup.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[01-onboard] setup (relay + web + browser)…');
  const env = await setup({ lazyBoot: false });
  try {
    const { driver } = env;

    // 1. The onboarding screen rendered. Trip Ready J1: a fresh boot shows the walkthrough first —
    //    skip it (awards walkthroughDone) so the create form is reachable.
    console.log('[01-onboard] skipping first-run walkthrough if present…');
    await skipWalkthroughIfPresent(driver);

    // 1a. The username input has no testID — find it by placeholder.
    //     (If this fails, the app shims aren't loading or Onboarding didn't mount.)
    console.log('[01-onboard] onboarding screen — waiting for username input…');
    await driver.typeByPlaceholder(ONBOARD_PLACEHOLDER, ONBOARD_USERNAME, { timeoutMs: 8_000 });

    // 1b. M7 (reworded 2026-09-07) — the create-button subtext is honest user-benefit language:
    //     creating a wallet never solicits money, and DEMO is named as valueless practice money.
    const onboardBody = await driver.bodyText();
    assertIncludes(onboardBody, 'does not deposit, buy, or move any money', 'onboarding must state creation never moves money');
    assertIncludes(onboardBody, 'practice money with no cash value', 'onboarding must state DEMO is valueless');

    // 1c. Custody honesty (2026-08-22): the create form states the implicit model in plain words —
    //     no account, key never leaves the phone, dpay cannot move the money. The explicit term
    //     "non-custodial" lives in Settings/landing; onboarding carries the consequence language.
    assertIncludes(onboardBody, 'No account', 'onboarding must state there is no dpay account');
    assertIncludes(onboardBody, 'never leaves this phone', 'onboarding must state the key stays on-device');
    console.log('[01-onboard] ✓ create form carries the non-custodial consequence copy');

    // 2. Click btn-create. The button transitions to "Creating…" then the mnemonic backup screen shows.
    console.log('[01-onboard] clicking btn-create…');
    await driver.click('btn-create', { timeoutMs: 4_000 });

    // D4-B: dismiss the mnemonic backup screen (checkbox + Continue) so the faucet runs.
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    // D4-c: the backup gate explains WHY the words matter — no account to sign back into, and not
    // even dpay can recover the funds. This is the implicit-custody moment (2026-08-22).
    const backupBody = await driver.bodyText();
    assertIncludes(backupBody, 'not even dpay can recover them', 'backup screen must state recovery is impossible without the words');
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
    // Trip Ready J2B/J3 — the create path plays the RECOVERY SAVED beat then the payment
    // practice payment before the wallet; leave it (faucet-failed + restore paths never see it).
    await skipPracticeIfPresent(driver);

    // 3. The Wallet screen mounts. The balance Text (testID="balance") is the gate. The app polls
    //    /api/v1/balances every 2.5s; the faucet funds the account synchronously in create(), so by
    //    the time the Wallet mounts the balance is ∂100.00 (the brief's ∂0.00 is wrong with a working
    //    relay — see file header).
    console.log('[01-onboard] wallet screen — waiting for balance…');
    // The balance element appears once the wallet mounts (the app's first state is balance=null →
    // shows '—'; once the first poll completes it reads the faucet-funded ∂100.00).
    await chooseHomeCurrencyIfPresent(driver);
    await waitForWallet(driver, { timeoutMs: 10_000 });
    // The wallet opens on the chosen CURRENCY now, so the demo rail this assertion is about has to
    // be selected explicitly. Flow 118 is where the currency landing itself is proven.
    await selectDemoAsset(driver);
    // The poll runs every 2.5s; allow up to 12s for the first successful poll to land on ∂100.00.
    await openBalances(driver); // the practice balance reads on the accounts route (currency-first chip headlines MAIN)
    const got = await driver.waitForText('∂100.00', { timeoutMs: 12_000 });
    const body = await driver.bodyText();
    assert(got, `wallet balance should read ∂100.00 (faucet-funded on onboarding). body excerpt:\n${body.slice(0, 500)}`);
    console.log('[01-onboard] ✓ balance shows ∂100.00 (faucet-funded through the REAL relay)');

    // 4. The username from onboarding shows in the wallet header.
    assertIncludes(body, ONBOARD_USERNAME, 'wallet header shows the onboarded username');

    // 5. Empty history: the "Recent" card only renders when history.length > 0 (App.tsx:414). With no
    //    payments settled, the card is absent — so "Recent" must NOT be on the page.
    assert(!body.includes('Recent'), `history must be empty (no "Recent" card). body excerpt:\n${body.slice(0, 500)}`);
    console.log('[01-onboard] ✓ history is empty (no "Recent" card renders)');

    // 6. Screenshot to e2e/shots/01-onboard.png — proves the wallet screen rendered.
    await driver.screenshot('01-onboard');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[01-onboard] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/01-onboard.mjs` run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[01-onboard] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
