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
//   - (2026-09-08, M4) the SOLANA ENDPOINT row, the relay row's twin. `setSolanaRpcUrl` has been
//     the seam every Solana read goes through and App.tsx has applied the stored value at boot
//     since 2026-09-08, but no screen reached it — so on a phone a dead provider key was a store
//     release rather than a settings edit. This flow drives the refusal path, because a refusal
//     that only appears in a thrown Error nobody renders is the same dead end again.
//
// Selector contract: `btn-settings`, `settings-relay`, `settings-sol-rpc`, `btn-sol-rpc-apply`,
// `settings-sol-rpc-err`, `privacy-policy`, `btn-reset`, `btn-reset-confirm`, `btn-create`.
import { setup, assert, assertIncludes, assertEq, onboardWallet, accountOf } from '../harness/lib.mjs';

const USERNAME = 'e2e-settings';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '12',
  name: 'settings',
  journey: 'system',
  covers: ['settings', 'relay-config', 'solana-rpc-config', 'privacy-policy', 'non-custodial', 'reset', 'persist'],
  verifies: 'Settings: privacy policy is reachable, the non-custodial statement is present, relay URL persists, the Solana endpoint is editable from the phone with an explicit Apply that shows its refusals verbatim and treats an empty value as "use the built-in one", and reset wallet wipes identity.',
  // Measured 2026-09-09: ~28s of wall clock ALONE on this host — above the 20000 it declared, which
  // therefore only ever passed on the runner's host-load scale multiplier (the same defect flow 101
  // had). The flow does a full onboarding, two Settings round trips, a reload, four RPC-field
  // submissions and a reset-to-onboarding.
  timeoutMs: 90000,
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

    // 2b. Expand the "Advanced" disclosure so the relay input is reachable (defaults collapsed).
    await driver.click('btn-advanced-toggle', { timeoutMs: 4_000 });

    // 3. The relay input holds the relay URL the app is using.
    const relayVal = await driver.readInputValue('settings-relay', { timeoutMs: 4_000 });
    assertEq(relayVal, relayBaseURL, 'settings-relay should hold the active relay URL');
    await driver.findByTestID('privacy-policy', { timeoutMs: 4_000 });
    // 3b. Custody honesty (2026-08-22): Settings About carries the full explicit statement — the
    //     word "non-custodial" plus the concrete capabilities dpay does NOT have. On-demand surface:
    //     nobody must read it unless they open Settings.
    const aboutText = await driver.readText('about-custody', { timeoutMs: 4_000 });
    assertIncludes(aboutText, 'non-custodial', 'Settings About must use the explicit term');
    assertIncludes(aboutText, 'cannot move, freeze, or recover your funds', 'Settings About must state the concrete limits');
    console.log('[12-settings] ✓ About states the non-custodial model explicitly');
    console.log(`[12-settings] ✓ relay input holds ${relayVal}`);

    // 4. Editing the relay input updates it (component state; the polls retarget to the new URL).
    // Keep the relay reachable: this flow proves edit/persistence, not offline handling. The trailing
    // slash is a real edit while the app's request URL normalizer still targets the same relay.
    // R1 (2026-09-10): the field is now a LIST editor (one address per line) that NORMALIZES each
    // line on Apply — a trailing slash is accepted, and the applied list comes back stripped, which
    // is what the post-apply read below now pins (pre-R1 it echoed the raw draft verbatim).
    const edited = `${relayBaseURL}/`;
    await driver.type('settings-relay', edited, { timeoutMs: 4_000 });
    await driver.click('btn-relay-apply', { timeoutMs: 4_000 });
    const after = await driver.readInputValue('settings-relay');
    assertEq(after, relayBaseURL, 'settings-relay should reflect the edited URL, normalized (no trailing slash)');
    console.log(`[12-settings] ✓ relay input editable → ${after}`);

    // 4b. The relay LIST PERSISTS across reload (AsyncStorage, like identity) — NIT 1a-iv. Reload with
    // NO ?relay= query so the only source of the list is persisted state; the identity also persists,
    // so we land back on the wallet (not onboarding). RED before the fix: the URL is component state
    // only → lost on reload → the input falls back to the default.
    console.log('[12-settings] reloading (no ?relay=) to verify the relay list persists…');
    await driver.navigate(webBaseURL, '/', { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });
    await driver.click('btn-settings', { timeoutMs: 6_000 });
    await driver.click('btn-advanced-toggle', { timeoutMs: 4_000 }); // expand the disclosure again
    const persistedRelay = await driver.readInputValue('settings-relay', { timeoutMs: 4_000 });
    assertEq(persistedRelay, relayBaseURL, 'settings-relay must persist across reload (AsyncStorage, normalized)');
    console.log(`[12-settings] ✓ relay list persisted across reload → ${persistedRelay}`);

    // 4b2. R1 (2026-09-10): the relay field is a LIST editor — one address per line, order =
    // priority. A two-line edit must APPLY as a two-entry list and PERSIST as two lines. Both
    // lines name the same live relay (this flow proves list mechanics, not failover — flow 164
    // owns the dead-first-address case), so every poll keeps answering while the list is wide.
    console.log('[12-settings] two-line list edit (same relay twice — mechanics only)…');
    await driver.type('settings-relay', `${relayBaseURL}\n${relayBaseURL}`, { timeoutMs: 4_000 });
    await driver.click('btn-relay-apply', { timeoutMs: 4_000 });
    const twoLines = await driver.readInputValue('settings-relay');
    assertEq(twoLines, `${relayBaseURL}\n${relayBaseURL}`, 'the applied list renders one address per line');
    await driver.navigate(webBaseURL, '/', { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });
    await driver.click('btn-settings', { timeoutMs: 6_000 });
    await driver.click('btn-advanced-toggle', { timeoutMs: 4_000 });
    const persistedTwo = await driver.readInputValue('settings-relay', { timeoutMs: 4_000 });
    assertEq(persistedTwo, `${relayBaseURL}\n${relayBaseURL}`, 'the two-line list must persist across reload');
    console.log('[12-settings] ✓ relay list of two lines applied + persisted');
    // Back to the single-address list for the steps below (deterministic field state).
    await driver.type('settings-relay', relayBaseURL, { timeoutMs: 4_000 });
    await driver.click('btn-relay-apply', { timeoutMs: 4_000 });

    // 4c. The SOLANA ENDPOINT row (M4) — the relay row's twin, one section down: a draft, an
    // explicit Apply, nothing on keystroke. Two things separate it from the relay row and both are
    // driven here: applying can FAIL with a sentence written for the user, and an empty value is a
    // real value (it restores the endpoint baked into the build).
    console.log('[12-settings] the Solana endpoint row: draft, explicit Apply, honest refusal…');
    await driver.click('btn-advanced-toggle', {timeoutMs: 4_000}); // the reload above collapsed it? no — already open
    await driver.click('btn-advanced-toggle', {timeoutMs: 4_000}); // …so toggle twice: end open, deterministically
    await driver.findByTestID('settings-sol-rpc', {timeoutMs: 4_000});
    assert(!(await driver.isPresent('settings-sol-rpc-err')), 'no refusal is shown before anything is applied');
    // An endpoint on plain http can be read and rewritten in transit — refused, by name, in place.
    await driver.type('settings-sol-rpc', 'http://insecure.example', {timeoutMs: 4_000});
    await driver.click('btn-sol-rpc-apply', {timeoutMs: 4_000});
    const solErr = await driver.readText('settings-sol-rpc-err', {timeoutMs: 4_000});
    assertIncludes(solErr, 'https://', 'the refusal must name what the endpoint has to be');
    assertIncludes(solErr, 'http://', 'and quote what was actually entered');
    await driver.screenshot('12-settings-sol-rpc-refusal');
    // Editing clears it — the message belongs to one attempt, not to the screen.
    // An ACCEPTED endpoint is applied for real: the SOL rail wakes up and reads it, which is the
    // point of the row and is also why this origin is allowed to fail here. That outbound attempt
    // IS the assertion that the wiring reaches the rail — a Settings field that changed nothing
    // would produce no request at all.
    driver.allowRequestFailuresFrom('https://mainnet.provider.example');
    await driver.type('settings-sol-rpc', 'https://mainnet.provider.example/?api-key=e2e', {timeoutMs: 4_000});
    assert(!(await driver.isPresent('settings-sol-rpc-err')), 'editing after a refusal clears the refusal');
    await driver.click('btn-sol-rpc-apply', {timeoutMs: 4_000});
    assert(!(await driver.isPresent('settings-sol-rpc-err')), 'a mainnet https endpoint is accepted');
    assertEq(await driver.readInputValue('settings-sol-rpc'), 'https://mainnet.provider.example/?api-key=e2e',
      'the accepted endpoint is what the field shows');
    // EMPTY IS A VALUE: it restores the endpoint baked into the build, so it must be applicable —
    // and the field then shows what "empty" resolved to, which is how a user learns what it means.
    // (This build bakes an empty endpoint, which is what puts the SOL rail back to sleep here.)
    await driver.type('settings-sol-rpc', '', {timeoutMs: 4_000});
    await driver.click('btn-sol-rpc-apply', {timeoutMs: 4_000});
    assertEq(await driver.readInputValue('settings-sol-rpc'), '',
      'clearing the field restores the built-in endpoint and shows it');
    console.log('[12-settings] ✓ Solana endpoint applied; refusals render verbatim, empty restores the built-in');

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
