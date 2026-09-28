/**
 * Flow 164 relay-failover — the jest twin of `e2e/tests/164-relay-failover.mjs`, BOTH phases.
 *
 * Phase 1: the ordered walk past a dead first address. The wallet boots with a PERSISTED relay
 * list [dead, live] (the twin passes the same list through `?relay=` — a browser-build layer; the
 * persisted list is the app's own storage surface). Funding the SAME account on the live relay
 * out of band means ∂100.00 can only arrive by WALKING past the dead primary — and the walk
 * really tried it: connection-class failures must be on record against the dead origin.
 *
 * Phase 2 (below): a 4xx is an ANSWER — no failover. The twin's second origin is the web dev
 * server; the jest stand-in is a local http server that 404s every route while staying alive.
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
      expect(/CONNECTION|NETWORK|REFUSED|FAILED|ABORTED|ECONNREFUSED/i.test(f.error ?? '')).toBe(true);
      expect(/UNSAFE_PORT/i.test(f.error ?? '')).toBe(false);
    }

    await m.unmount();
  }, 150_000);

  // ── Phase 2: a 4xx is an ANSWER — the walk NEVER fails over on it ──────────────────────────────
  // The twin retargets the list to [webOrigin, relay2] mid-session (the web dev server answers
  // 404 on /api/v1); the jest stand-in for that origin is a local http server that answers 404
  // on everything — a real, ALIVE origin whose every /api/v1 route is a refused request. The
  // walk must stop there: the header flips to the offline 'approx.' eyebrow while relay2 is
  // provably healthy. A buggy failover-on-4xx would read 200 from relay2 and show the exact
  // online balance instead.
  it('phase 2 — a 4xx from the first address stops the walk: offline eyebrow while the second relay is alive', async () => {
    await freshContext();
    const live = relayBaseURL();
    // Ground truth: funded and exact on the healthy single-relay list.
    const m = await onboardSeededUnfunded('e2e-failover-4xx', {fund: false});
    const identity = await accountOf(m);
    const fund = await faucetAccount(identity!.publicHex);
    expect(fund.ok).toBe(true);
    expect(await m.driver.waitForText('∂100.00', {timeoutMs: 15_000})).toBe(true);

    // An ALIVE origin whose every route is a 404 (the twin's web-dev-server role — real address
    // shape, real HTTP answers, no /api/v1).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require('node:http') as typeof import('node:http');
    const srv = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const fourohfour = `http://127.0.0.1:${(srv.address() as {port: number}).port}`;
    m.driver.allowRequestFailuresFrom(fourohfour); // pre-declared: the 404s are the point

    // relay2 must be ALIVE, or 'approx.' would prove nothing.
    const alive = await fetch(`${live}/api/v1/health`);
    expect(alive.ok).toBe(true);

    // Retarget mid-session: [404-origin, live] — order = priority, one address per line.
    try {
      await m.driver.click('btn-settings', {timeoutMs: 6000});
      await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
      await m.driver.type('settings-relay', `${fourohfour}\n${live}`, {timeoutMs: 4000});
      await m.driver.click('btn-relay-apply', {timeoutMs: 4000});
      await m.driver.click('btn-settings-close', {timeoutMs: 4000});

      // A 4xx is an answer: the walk stops, `online` flips false, the header grows the offline
      // 'approx.' eyebrow. If a buggy walk failed over on 4xx, relay2's 200 would keep the
      // header exact (online=true) and this wait would time out.
      expect(await m.driver.waitForText('approx.', {timeoutMs: 15_000})).toBe(true);
    } finally {
      await m.unmount();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }, 150_000);
});
