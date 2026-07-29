// Flow 01 — Onboard (verify gate for the scaffold).
//
// Boots the REAL app/App.tsx in a real browser, against the REAL test relay (FakeLedger, offline),
// and drives the new-user onboarding flow end-to-end:
//   1. The Onboarding screen renders (no identity in AsyncStorage yet).
//   2. Type a username into the field (no testID — find by placeholder "e.g. Alice").
//   3. Click btn-create. The app calls DpayCore.generateKeypair (our @noble/ed25519 shim), saves the
//      identity to AsyncStorage, and best-effort funds the account via POST /api/v1/faucet.
//   4. The Wallet screen renders with: balance (the faucet funds $100.00 in DEMO_USD), empty history.
//   5. Screenshot to e2e/shots/01-onboard.png.
//
// Note on the asserted balance: the brief said "$0.00", but the REAL app's `create()` does a
// best-effort faucet POST on onboarding (see App.tsx:233-235). With the REAL relay up (the whole
// point of the harness), that POST succeeds and funds $100.00, so the wallet's first balance poll
// reads $100.00 — NOT $0.00. Asserting $0.00 would require disabling the faucet, which would break
// the "use the REAL relay + REAL FakeLedger" rule. We assert $100.00 (proves faucet→balance
// end-to-end) and note this deviation. Empty history is asserted verbatim (no payments settled yet).
import { setup, assert, assertIncludes } from '../harness/lib.mjs';

const ONBOARD_USERNAME = 'e2e-alice';
const ONBOARD_PLACEHOLDER = 'e.g. Alice';

export async function run() {
  const start = Date.now();
  console.log('[01-onboard] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. The onboarding screen rendered. The username input has no testID — find it by placeholder.
    //    (If this fails, the app shims aren't loading or Onboarding didn't mount.)
    console.log('[01-onboard] onboarding screen — waiting for username input…');
    await driver.typeByPlaceholder(ONBOARD_PLACEHOLDER, ONBOARD_USERNAME, { timeoutMs: 8_000 });

    // 2. Click btn-create. The button transitions to "Creating…" then the wallet mounts.
    console.log('[01-onboard] clicking btn-create…');
    await driver.click('btn-create', { timeoutMs: 4_000 });

    // 3. The Wallet screen mounts. The balance Text (testID="balance") is the gate. The app polls
    //    /api/v1/balance every 2.5s; the faucet funds the account synchronously in create(), so by
    //    the time the Wallet mounts the balance is $100.00 (the brief's $0.00 is wrong with a working
    //    relay — see file header).
    console.log('[01-onboard] wallet screen — waiting for balance…');
    // The balance element appears once the wallet mounts (the app's first state is balance=null →
    // shows '—'; once the first poll completes it reads the faucet-funded $100.00).
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    // The poll runs every 2.5s; allow up to 12s for the first successful poll to land on $100.00.
    const got = await driver.waitForText('$100.00', { timeoutMs: 12_000 });
    const body = await driver.bodyText();
    assert(got, `wallet balance should read $100.00 (faucet-funded on onboarding). body excerpt:\n${body.slice(0, 500)}`);
    console.log('[01-onboard] ✓ balance shows $100.00 (faucet-funded through the REAL relay)');

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

// Allow `node tests/01-onboard.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[01-onboard] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
