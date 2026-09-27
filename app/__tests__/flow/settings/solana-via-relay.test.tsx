/**
 * Flow 165 solana-via-relay — the jest twin of `e2e/tests/165-solana-via-relay.mjs`.
 *
 * Phase 1 — the wire: the SOL rail reads through the relay's REAL proxy derivation
 * (`{relayBase}/api/v1/solana/rpc` — no test override, exactly the twin's 'relay' mode: the
 * derivation must be the thing under test). The
 * relay's test-helpers stub upstream answers deterministically, so the accounts route renders
 * "2 SOL" and the summed "$3.00" — numbers that can ONLY come from the stub upstream THROUGH the
 * proxy (no page stub, no provider). The stub's /hits counter proves the envelope rode the proxy.
 *
 * Phase 2 — the walk: re-pointing the relay list at [dead, live] moves the SOL derivation with it
 * (one tick, App.tsx); the row still serves exactly 2 SOL from the second home, and the dead first
 * home was really TRIED (connection-class failures on record against its proxy route).
 */
import {describe, it, expect} from '@jest/globals';
// FIRST: sets the SOL RPC override the app captures at module load, then the App graph imports.
import './solRelayProxy';
import {
  assertIncludes, onboardSeededUnfunded, openBalances, relayGet,
} from '../harness/lib';
import {relayBaseURL} from '../harness/relayClient';
import {freshContext} from '../onboard/helpers';

const g = globalThis as unknown as Record<string, unknown>;

/** The stub upstream's envelope counter (the relay's test route). */
async function stubHits(): Promise<number> {
  const j = await relayGet('/api/v1/test/solana-upstream/hits') as {hits?: number};
  return Number(j.hits ?? 0);
}

describe('flow 165 — solana-via-relay', () => {
  it('SOL+USD render through the relay proxy (hits prove it); a dead first relay home is skipped and SOL survives', async () => {
    await freshContext();
    const m = await onboardSeededUnfunded('e2e-sol-relay', {fund: false});

    // ── Phase 1: the wire ───────────────────────────────────────────────────────────────────
    // The balances live on the ACCOUNTS route; Home never shows asset rows.
    await openBalances(m);
    expect(await m.driver.waitForText('2 SOL', {timeoutMs: 15_000})).toBe(true);
    expect(await m.driver.waitForText('$3.00', {timeoutMs: 15_000})).toBe(true);

    // The upstream was reached THROUGH the proxy: the stub's envelope counter is non-zero (it
    // only increments when the relay's proxy forwards a request to it).
    const hits = await stubHits();
    expect(hits > 0).toBe(true);

    // ── Phase 2: the walk — a dead FIRST relay home is skipped, SOL survives from the second ──
    const relay = relayBaseURL();
    const deadPort = await new Promise<number>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const net = require('node:net') as typeof import('node:net');
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as {port: number}).port;
        srv.close(() => resolve(p));
      });
    });
    const deadOrigin = `http://127.0.0.1:${deadPort}`;
    m.driver.allowRequestFailuresFrom(deadOrigin);

    await m.driver.click('btn-settings', {timeoutMs: 6000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    await m.driver.type('settings-relay', `${deadOrigin}\n${relay}`, {timeoutMs: 4000});
    await m.driver.click('btn-relay-apply', {timeoutMs: 4000});
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    // The SOL derivation follows the SAME re-point; the row keeps exactly 2 SOL from the live home.
    expect(await m.driver.waitForText('2 SOL', {timeoutMs: 20_000})).toBe(true);

    // …and the dead SOL home was really TRIED: failures on record against the dead origin's
    // PROXY route — the request shape only a derivation that followed the list produces.
    await m.driver.waitForFunction(
      () => m.driver.collectFetchFailures(),
      {timeoutMs: 4000},
    ).catch(() => {});
    console.log('DBG-165:', JSON.stringify({deadOrigin, fails: m.driver.fetchFailures.slice(-6)}));
    const deadFails = m.driver.fetchFailures.filter((f) => f.url.startsWith(`${deadOrigin}/api/v1/solana/rpc`));
    expect(deadFails.length > 0).toBe(true);
    for (const f of deadFails) {
      expect(/CONNECTION|NETWORK|REFUSED|FAILED|ABORTED/i.test(f.error ?? '')).toBe(true);
      expect(/UNSAFE_PORT/i.test(f.error ?? '')).toBe(false);
    }

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_URL = '';
  }, 150_000);
});
