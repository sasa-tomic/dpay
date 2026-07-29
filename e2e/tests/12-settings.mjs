// Flow 12 — Settings: identity/account shown + relay control + reset clears identity.
//
// The app has no dedicated "settings screen"; its settings surface is (a) the wallet header
// (username + the account's short pubkey + NFC pill) and (b) the bottom bar (the `ledger` relay URL
// input + a `reset` link). This flow asserts that surface is complete and functional:
//   - the header shows the onboarded username + the account's short pubkey.
//   - the relay input holds the relay URL the app is actually using.
//   - editing the relay input updates it (it persists in component state — the polls retarget).
//   - reset clears the on-device identity → the Onboarding screen returns.
// No silent missing fields: every piece of identity/repo info the app renders is verified present.
//
// Selector contract: `settings-relay`, `btn-reset`, `btn-create` (Onboarding returns after reset).
import { setup, assert, assertIncludes, assertEq } from '../harness/lib.mjs';

const ONBOARD_PLACEHOLDER = 'e.g. Alice';
const USERNAME = 'e2e-settings';

export async function run() {
  const start = Date.now();
  console.log('[12-settings] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    console.log('[12-settings] onboarding…');
    await driver.typeByPlaceholder(ONBOARD_PLACEHOLDER, USERNAME, { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    await driver.waitForText('$100.00', { timeoutMs: 12_000 });
    const id = await driver.eval(() => JSON.parse(localStorage.getItem('dpay.identity.v1') ?? 'null'));
    const accountHex = id?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, 'onboarded identity must be present');

    // 1. The header shows the username + the account's short pubkey (identity/account info).
    const body = await driver.bodyText();
    assertIncludes(body, USERNAME, 'header should show the onboarded username');
    assertIncludes(body, accountHex.slice(0, 8), 'header should show the account short pubkey');
    console.log(`[12-settings] ✓ header shows username + account ${accountHex.slice(0, 8)}…`);

    // 2. The relay input holds the relay URL the app is using.
    const relayVal = await driver.readInputValue('settings-relay', { timeoutMs: 4_000 });
    assertEq(relayVal, relayBaseURL, 'settings-relay should hold the active relay URL');
    console.log(`[12-settings] ✓ relay input holds ${relayVal}`);

    // 3. Editing the relay input updates it (component state; the polls retarget to the new URL).
    const edited = 'http://127.0.0.1:9999';
    await driver.type('settings-relay', edited, { timeoutMs: 4_000 });
    const after = await driver.readInputValue('settings-relay');
    assertEq(after, edited, 'settings-relay should reflect the edited URL');
    console.log(`[12-settings] ✓ relay input editable → ${after}`);

    // 4. Reset clears the on-device identity → Onboarding returns.
    console.log('[12-settings] clicking btn-reset…');
    await driver.click('btn-reset', { timeoutMs: 4_000 });
    await driver.typeByPlaceholder(ONBOARD_PLACEHOLDER, '', { timeoutMs: 6_000 }); // Onboarding returned
    const stored = await driver.eval(() => localStorage.getItem('dpay.identity.v1'));
    assert(stored === null, `reset must clear the identity from storage, got ${JSON.stringify(stored)}`);
    console.log('[12-settings] ✓ reset cleared the identity → Onboarding returned');

    await driver.screenshot('12-settings');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[12-settings] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[12-settings] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
