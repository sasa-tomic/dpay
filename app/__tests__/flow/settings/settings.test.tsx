/**
 * Flow 12 settings — the jest twin of `e2e/tests/12-settings.mjs`. (SettingsRelayList /
 * SettingsSolanaRpc tests pin the panels; this ports the live sheet walk.)
 *
 * The header shows ONLY the username (no hex); the relay input holds the ACTIVE relay (the baked
 * RELAY_DEFAULT — the harness fetch rewrite transparently redirects it to the test relay; `?relay=`
 * is a browser-BUILD layer (e2e/web/shims.ts), not app code, so jest boots on the default), normalizes on Apply,
 * persists across reload, and applies as a LIST (one address per line, order = priority); the
 * Solana endpoint row refuses plain http by name, accepts mainnet https, and treats EMPTY as a real
 * value (restores the built-in); reset shows a confirmation and only confirming clears the identity.
 *
 * Not ported (browser-only): the screenshots.
 */
import {describe, it, expect} from '@jest/globals';
import {mountApp, type Mount} from '../harness/mount';
import {
  assertEq, assertIncludes, chooseHomeCurrencyIfPresent, generateKeypair, faucetAccount,
  selectDemoAsset, waitForWallet,
} from '../harness/lib';
import {RELAY_DEFAULT} from '../../../relayConfig';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {
  getItem: (k: string) => Promise<string | null>;
  setItem: (k: string, v: string) => Promise<void>;
};

const USERNAME = 'jest-set';

/** onboardWallet's seeded fast path (the same seed the harness sugar plants). */
async function onboardSeeded(): Promise<Mount> {
  const kp = await generateKeypair();
  const fund = await faucetAccount(kp.publicHex);
  expect(fund.ok).toBe(true);
  const now = Date.now();
  await AsyncStorage.setItem('dpay.identity.v1', JSON.stringify({secretHex: kp.secretHex, publicHex: kp.publicHex, username: USERNAME}));
  await AsyncStorage.setItem('dpay.journey.v1', JSON.stringify({
    stamps: ['walkthroughDone', 'recoverySaved', 'flowUnderstood'],
    at: {walkthroughDone: now, recoverySaved: now, flowUnderstood: now},
    seen: ['firstRunPractice'],
  }));
  const m = await mountApp();
  await chooseHomeCurrencyIfPresent(m);
  await waitForWallet(m, {timeoutMs: 10_000});
  await selectDemoAsset(m);
  return m;
}

hermeticDescribe('flow 12 — settings', () => {
  it('username-only header; relay list edits + persists; Solana endpoint refuses http and accepts empty; reset confirms', async () => {
    const m = await onboardSeeded();
    const identity = await AsyncStorage.getItem('dpay.identity.v1');
    const accountHex = (JSON.parse(identity ?? '{}') as {publicHex?: string}).publicHex ?? '';
    expect(accountHex).toHaveLength(64);

    // 1. The header shows ONLY the username (H4: the hex pubkey is not on the main display).
    const whoText = m.driver.readText('header-who');
    assertEq(whoText, USERNAME, 'header who line (H4: username only)');
    expect(whoText.includes(accountHex.slice(0, 8))).toBe(false);

    // 2. Open Settings + expand Advanced so the relay input is reachable.
    await m.driver.click('btn-settings', {timeoutMs: 4000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});

    // 3. The relay input holds the relay URL the app is using (RELAY_DEFAULT — every request to it
    // is rewritten to the test relay by the harness, so edits OF this URL stay on the test relay);
    // custody honesty lives here too.
    const relay = RELAY_DEFAULT;
    assertEq(m.driver.readInputValue('settings-relay'), relay, 'settings-relay should hold the active relay URL');
    await m.driver.findByTestID('privacy-policy', {timeoutMs: 4000});
    const aboutText = m.driver.readText('about-custody');
    assertIncludes(aboutText, 'non-custodial', 'Settings About must use the explicit term');
    assertIncludes(aboutText, 'cannot move, freeze, or recover it', 'Settings About must state the concrete limits');

    // 4. Editing updates it (the polls retarget); Apply NORMALIZES each line (R1 list editor).
    await m.driver.type('settings-relay', `${relay}/`, {timeoutMs: 4000});
    await m.driver.click('btn-relay-apply', {timeoutMs: 4000});
    assertEq(m.driver.readInputValue('settings-relay'), relay, 'settings-relay reflects the edit, normalized (no trailing slash)');

    // 4b. The relay LIST PERSISTS across reload — reload with NO ?relay= so persisted state is
    //     the only source; the identity persists, so we land back on the wallet.
    await m.remount();
    await m.driver.click('btn-settings', {timeoutMs: 6000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    assertEq(m.driver.readInputValue('settings-relay'), relay, 'settings-relay must persist across reload (AsyncStorage, normalized)');

    // 4b2. A two-line edit APPLIES as a two-entry list and PERSISTS as two lines (both name the
    //      live relay — mechanics only; flow 164 owns the dead-first-address case).
    await m.driver.type('settings-relay', `${relay}\n${relay}`, {timeoutMs: 4000});
    await m.driver.click('btn-relay-apply', {timeoutMs: 4000});
    assertEq(m.driver.readInputValue('settings-relay'), `${relay}\n${relay}`, 'the applied list renders one address per line');
    await m.remount();
    await m.driver.click('btn-settings', {timeoutMs: 6000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    assertEq(m.driver.readInputValue('settings-relay'), `${relay}\n${relay}`, 'the two-line list must persist across reload');
    // Back to the single-address list for the steps below (deterministic field state).
    await m.driver.type('settings-relay', relay, {timeoutMs: 4000});
    await m.driver.click('btn-relay-apply', {timeoutMs: 4000});

    // 4c. The SOLANA ENDPOINT row: a draft, an explicit Apply, honest refusal, EMPTY is a value.
    await m.driver.findByTestID('settings-sol-rpc', {timeoutMs: 4000});
    expect(m.driver.isPresent('settings-sol-rpc-err')).toBe(false);
    // Plain http can be read and rewritten in transit — refused, by name, in place.
    await m.driver.type('settings-sol-rpc', 'http://insecure.example', {timeoutMs: 4000});
    await m.driver.click('btn-sol-rpc-apply', {timeoutMs: 4000});
    const solErr = m.driver.readText('settings-sol-rpc-err');
    assertIncludes(solErr, 'https://', 'the refusal must name what the endpoint has to be');
    assertIncludes(solErr, 'http://', 'and quote what was actually entered');
    // An ACCEPTED endpoint is applied for real: the SOL rail wakes up and reads it — that outbound
    // attempt is the assertion that the wiring reaches the rail; its failure is pre-declared.
    m.driver.allowRequestFailuresFrom('https://mainnet.provider.example');
    await m.driver.type('settings-sol-rpc', 'https://mainnet.provider.example/?api-key=e2e', {timeoutMs: 4000});
    expect(m.driver.isPresent('settings-sol-rpc-err')).toBe(false);
    await m.driver.click('btn-sol-rpc-apply', {timeoutMs: 4000});
    expect(m.driver.isPresent('settings-sol-rpc-err')).toBe(false);
    assertEq(m.driver.readInputValue('settings-sol-rpc'), 'https://mainnet.provider.example/?api-key=e2e',
      'the accepted endpoint is what the field shows');
    // EMPTY IS A VALUE: restores the endpoint baked into the build (empty here → the rail sleeps).
    await m.driver.type('settings-sol-rpc', '', {timeoutMs: 4000});
    await m.driver.click('btn-sol-rpc-apply', {timeoutMs: 4000});
    assertEq(m.driver.readInputValue('settings-sol-rpc'), '', 'clearing the field restores the built-in endpoint and shows it');

    // 5. Reset shows a confirmation dialog (reset is no longer one-tap-dangerous).
    await m.driver.click('btn-reset', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-reset-confirm', {timeoutMs: 4000});

    // 6. Confirming clears the on-device identity → Onboarding returns.
    await m.driver.click('btn-reset-confirm', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-create', {timeoutMs: 6000});
    expect(await AsyncStorage.getItem('dpay.identity.v1')).toBeNull();

    await m.unmount();
  }, 120_000);
});
