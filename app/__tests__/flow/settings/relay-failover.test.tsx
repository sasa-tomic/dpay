/**
 * Flow 164 relay-failover — the jest twin of `e2e/tests/164-relay-failover.mjs`, phase 1 (the
 * ordered walk past a dead first address) ported faithfully over the ONE jest relay.
 *
 * The wallet boots with a PERSISTED relay list [dead, live] (the twin passes the same list through
 * `?relay=` — a browser-build layer; the persisted list is the app's own storage surface). Funding
 * the SAME account on the live relay out of band means ∂100.00 can only arrive by WALKING past the
 * dead primary — and the walk really tried it: connection-class failures must be on record against
 * the dead origin, for the right reasons.
 *
 * GAP vs the browser twin, filed for the integrator: phase 2 (a 4xx is an ANSWER — no failover)
 * needs a second HTTP origin that answers 4xx on /api/v1 while staying alive; the twin uses the
 * web dev server, which jest does not spawn. No jest-side origin can produce an honest 4xx (a dead
 * port is a transport failure, where failover is CORRECT), so that half stays browser-only.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assertIncludes, faucetAccount, onboardSeededUnfunded,
} from '../harness/lib';
import {relayBaseURL} from '../harness/relayClient';
import {freshContext} from '../onboard/helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {setItem: (k: string, v: string) => Promise<void>};

/** A free port that NOTHING will ever bind — the dead primary. Real address shape, refused
 *  connections: the exact transport-failure leg of the walk rule. */
async function deadOrigin(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const net = require('node:net') as typeof import('node:net');
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as {port: number}).port;
      srv.close(() => resolve(p));
    });
  });
  return `http://127.0.0.1:${port}`;
}

describe('flow 164 — relay-failover', () => {
  it('boot [dead, live]: ∂100 arrives only by walking past the dead primary, which was really tried', async () => {
    await freshContext();
    const dead = await deadOrigin();
    const live = relayBaseURL();
    // Seed the persisted operator list BEFORE the boot — [dead, live], order = priority.
    await AsyncStorage.setItem('dpay.relays.v1', JSON.stringify([dead, live]));

    // The dead first address fails for the WHOLE flow — expected, pre-declared.
    const m = await onboardSeededUnfunded('e2e-failover', {fund: false});
    m.driver.allowRequestFailuresFrom(dead);

    const identity = await accountOf(m);
    expect(typeof identity?.publicHex === 'string' && identity.publicHex.length === 64).toBe(true);

    // The list editor renders the persisted list verbatim (one address per line, order = priority).
    await m.driver.click('btn-settings', {timeoutMs: 6000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    const listText = m.driver.readInputValue('settings-relay');
    assertIncludes(listText, live, 'the list editor must carry every address');
    assertIncludes(listText, dead, '…including the dead first one (order = priority)');
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    // Fund the SAME account on the live relay (out of band — the app never switched anything).
    // The header can only learn this number by walking dead → live.
    const fund = await faucetAccount(identity!.publicHex);
    expect(fund.ok).toBe(true);
    expect(await m.driver.waitForText('∂100.00', {timeoutMs: 15_000})).toBe(true);

    // The walk really TRIED the dead primary first (not silently skipped): connection-class
    // failures on record against the dead origin, never an unsafe-port artifact.
    m.driver.collectFetchFailures();
    const deadFails = m.driver.fetchFailures.filter((f) => f.url.startsWith(dead));
    expect(deadFails.length > 0).toBe(true);
    for (const f of deadFails) {
      expect(/CONNECTION|NETWORK|REFUSED|FAILED|ABORTED/i.test(f.error ?? '')).toBe(true);
      expect(/UNSAFE_PORT/i.test(f.error ?? '')).toBe(false);
    }

    await m.unmount();
  }, 150_000);
});
