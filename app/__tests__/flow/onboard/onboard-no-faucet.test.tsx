/**
 * Flow 37 onboard-no-faucet — the jest twin of `e2e/tests/37-onboard-no-faucet.mjs`.
 *
 * The wallet boots against a GENUINELY-dead relay (a freed port — connection refused, the real
 * unreachable-relay failure mode; seeded here through the persisted relay list, the app's own
 * storage surface). Wallet creation stays independent from relay funding: the backup gate opens,
 * practice takes its OFFLINE branch — a re-check and a way on, never a deposit address or an
 * add-money action — the wallet mounts with the identity persisted, no ∂100.00 ever appears, and
 * the header shows the honest "~ … approx." indicator instead of a fabricated zero.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, chooseHomeCurrencyIfPresent, skipPracticeIfPresent, skipWalkthroughIfPresent,
  waitForEnabled, waitForWallet,
} from '../harness/lib';
import {mountApp} from '../harness/mount';
import {freshContext} from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {setItem: (k: string, v: string) => Promise<void>};

hermeticDescribe('flow 37 — onboard-no-faucet', () => {
  it('creation proceeds unfunded against a dead relay: practice fails closed, no ∂100, honest approx. indicator', async () => {
    await freshContext();
    // A genuinely-dead relay: bind :0, close — a port nothing listens on.
    const net = require('node:net') as typeof import('node:net');
    const deadPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as {port: number}).port;
        srv.close(() => resolve(p));
      });
    });
    const DEAD_RELAY = `http://127.0.0.1:${deadPort}`;

    // Seed the persisted operator list to the dead relay BEFORE the boot — the equivalent of the
    // twin's `?relay=` (a browser-build layer): Onboarding's capability probe then targets it.
    await AsyncStorage.setItem('dpay.relays.v1', JSON.stringify([DEAD_RELAY]));

    const m = await mountApp();
    m.driver.allowRequestFailuresFrom(DEAD_RELAY);

    await skipWalkthroughIfPresent(m);
    await m.driver.typeByPlaceholder('e.g. Alice', 'e2e-nofaucet', {timeoutMs: 8000});
    await m.driver.click('btn-create', {timeoutMs: 4000});

    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
    await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});

    // The first-run PRACTICE screen against a dead relay takes its OFFLINE branch — and the
    // assertion of record is what that branch does NOT do: no funding primary, no deposit address.
    await m.driver.findByTestID('practice', {timeoutMs: 15_000});
    await m.driver.findByTestID('practice-offline', {timeoutMs: 15_000});
    expect(m.driver.isPresent('practice-offline-go')).toBe(false);
    expect(m.driver.isPresent('deposit-address')).toBe(false);
    expect(m.driver.isPresent('practice-offline-check')).toBe(true);
    expect(m.driver.isPresent('btn-practice-continue')).toBe(true);

    await skipPracticeIfPresent(m);
    await chooseHomeCurrencyIfPresent(m);
    await waitForWallet(m, {timeoutMs: 10_000});
    expect(m.driver.readText('header-who')).toBe('e2e-nofaucet');
    const identity = await accountOf(m);
    expect(typeof identity?.publicHex === 'string' && identity.publicHex.length === 64).toBe(true);

    // ∂100.00 (the faucet-funded happy path) must NEVER appear; the honest offline indicator must.
    await m.driver.waitForText('∂100.00', {timeoutMs: 1500}).catch(() => {});
    expect(m.driver.bodyText().includes('∂100.00')).toBe(false);
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);

    await m.unmount();
  }, 120_000);
});
