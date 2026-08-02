// Flow 12 — Settings: identity/account shown + relay control + reset clears identity.
//
// The app has a dedicated Settings sheet (opened from the wallet's bottom bar via `btn-settings`)
// that holds: the relay URL input, the demo faucet button, and a reset affordance with a
// confirmation dialog. The wallet header (on the main screen) still shows the username + the
// account's short pubkey + NFC pill. This flow asserts the full surface:
//   - the header shows the onboarded username + the account's short pubkey.
//   - the Settings sheet's relay input holds the relay URL the app is actually using.
//   - editing the relay input updates it (it persists in component state — the polls retarget).
//   - reset shows a confirmation dialog; confirming clears the on-device identity → Onboarding.
//
// Selector contract: `btn-settings`, `settings-relay`, `btn-reset`, `btn-reset-confirm`, `btn-create`.
import { setup, assert, assertIncludes, assertEq, onboardWallet, accountOf } from '../harness/lib.mjs';

const USERNAME = 'e2e-settings';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '12',
  name: 'settings',
  journey: 'system',
  covers: ['settings', 'relay-config', 'reset', 'persist'],
  verifies: 'Settings: edit relay URL (persists across reload) + reset wallet (wipes identity → onboarding).',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[12-settings] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL, webBaseURL } = env;

    console.log('[12-settings] onboarding…');
    await onboardWallet(driver, USERNAME);
    const id = await accountOf(driver);
    const accountHex = id?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, 'onboarded identity must be present');

    // 1. The header shows ONLY the username (H4: the hex pubkey was removed from the main display).
    const whoText = await driver.readText('header-who');
    assertEq(whoText, USERNAME, 'header who line (H4: username only)');
    assert(!whoText.includes(accountHex.slice(0, 8)), `header must NOT show the hex pubkey (H4), got "${whoText}"`);
    console.log(`[12-settings] ✓ header shows username "${USERNAME}" only (no hex)`);

    // 2. Open the Settings sheet.
    console.log('[12-settings] opening Settings…');
    await driver.click('btn-settings', { timeoutMs: 4_000 });

    // 3. The relay input holds the relay URL the app is using.
    const relayVal = await driver.readInputValue('settings-relay', { timeoutMs: 4_000 });
    assertEq(relayVal, relayBaseURL, 'settings-relay should hold the active relay URL');
    console.log(`[12-settings] ✓ relay input holds ${relayVal}`);

    // 4. Editing the relay input updates it (component state; the polls retarget to the new URL).
    // Keep the relay reachable: this flow proves edit/persistence, not offline handling. The trailing
    // slash is a real edit while the app's request URL normalizer still targets the same relay.
    const edited = `${relayBaseURL}/`;
    await driver.type('settings-relay', edited, { timeoutMs: 4_000 });
    await driver.click('btn-relay-apply', { timeoutMs: 4_000 });
    const after = await driver.readInputValue('settings-relay');
    assertEq(after, edited, 'settings-relay should reflect the edited URL');
    console.log(`[12-settings] ✓ relay input editable → ${after}`);

    // 4b. The relay URL PERSISTS across reload (AsyncStorage, like identity) — NIT 1a-iv. Reload with
    // NO ?relay= query so the only source of the URL is persisted state; the identity also persists,
    // so we land back on the wallet (not onboarding). RED before the fix: the URL is component state
    // only → lost on reload → the input falls back to the default.
    console.log('[12-settings] reloading (no ?relay=) to verify the relay URL persists…');
    await driver.navigate(webBaseURL, '/', { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });
    await driver.click('btn-settings', { timeoutMs: 6_000 });
    const persistedRelay = await driver.readInputValue('settings-relay', { timeoutMs: 4_000 });
    assertEq(persistedRelay, edited, 'settings-relay must persist across reload (AsyncStorage)');
    console.log(`[12-settings] ✓ relay URL persisted across reload → ${persistedRelay}`);

    // 5. Reset shows a confirmation dialog (UX-V3: reset is no longer one-tap-dangerous).
    console.log('[12-settings] clicking btn-reset (opens confirmation)…');
    await driver.click('btn-reset', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-reset-confirm', { timeoutMs: 4_000 });
    console.log('[12-settings] ✓ confirmation dialog shown');

    // 6. Confirming clears the on-device identity → Onboarding returns.
    console.log('[12-settings] clicking btn-reset-confirm…');
    await driver.click('btn-reset-confirm', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-create', { timeoutMs: 6_000 }); // Onboarding returned
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
