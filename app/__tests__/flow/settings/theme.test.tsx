/**
 * Flows 85 theme-toggle — the jest twin of `e2e/tests/85-theme-toggle.mjs`. (theme-toggle.test.tsx
 * pins the control; this ports the state machine + persistence over the full app.)
 *
 * The header toggle names the TARGET mode; a single click flips Light↔Dark; the pinned choice
 * rehydrates across a remount; the Settings 3-way control drives the same state and Auto returns
 * the choice to "follow the OS" (light under the jest scheme).
 *
 * GAP vs the browser twin (filed for the integrator): the root-background and active-segment
 * computed-style assertions are DOM/CSS reads with no react-test-renderer equivalent — they stay
 * with the visual tier; here the same facts are pinned through the persisted store + the control's
 * own accessibility labels.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {onboardWallet} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};

const themeLabel = (m: Awaited<ReturnType<typeof onboardWallet>>): string =>
  String(m.driver.propOf('btn-theme', 'accessibilityLabel') ?? '');

hermeticDescribe('flow 85 — theme-toggle', () => {
  it('header names the target and flips on one click; Dark persists across remount; Settings 3-way control + Auto', async () => {
    // 1. Onboard to reach the Wallet (the header toggle only exists there).
    const m = await onboardWallet('e2e-theme');
    await m.driver.findByTestID('btn-theme', {timeoutMs: 5000});

    // No stored choice → seeded light → the header names the TARGET (Dark).
    expect(await AsyncStorage.getItem('dpay.theme.v1')).toBeNull();
    expect(themeLabel(m)).toBe('Switch theme to Dark');

    // 2. Header flip: Light → Dark → Light.
    await m.driver.click('btn-theme');
    expect(themeLabel(m)).toBe('Switch theme to Light');
    expect(await AsyncStorage.getItem('dpay.theme.v1')).toBe('dark');
    await m.driver.click('btn-theme');
    expect(themeLabel(m)).toBe('Switch theme to Dark');
    expect(await AsyncStorage.getItem('dpay.theme.v1')).toBe('light');

    // 3. Persistence: pin Dark, remount (fresh JS context) — the choice rehydrates.
    await m.driver.click('btn-theme');
    expect(themeLabel(m)).toBe('Switch theme to Light');
    await m.remount();
    await m.driver.findByTestID('tab-home', {timeoutMs: 8000}); // the wallet shell is back
    expect(themeLabel(m)).toBe('Switch theme to Light');
    expect(await AsyncStorage.getItem('dpay.theme.v1')).toBe('dark');

    // 4. Settings drives the same state: Dark → Light via the segmented control; Auto returns the
    //    choice to the OS scheme (light here).
    await m.driver.click('btn-settings');
    await m.driver.findByTestID('btn-theme-light', {timeoutMs: 5000});
    expect(String(m.driver.propOf('btn-theme-light', 'accessibilityLabel') ?? '')).toBe('Theme: Light');
    await m.driver.click('btn-theme-light');
    expect(await AsyncStorage.getItem('dpay.theme.v1')).toBe('light');
    await m.driver.click('btn-theme-auto');
    expect(await AsyncStorage.getItem('dpay.theme.v1')).toBe('system'); // Auto = follow the OS
    await m.driver.click('btn-settings-close');
    expect(themeLabel(m)).toBe('Switch theme to Dark');

    await m.unmount();
  }, 90_000);
});
