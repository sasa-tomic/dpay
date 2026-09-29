/**
 * Flow 165 solana-via-relay — the jest twin of `e2e/tests/165-solana-via-relay.mjs`, BOTH phases,
 * over the relay-DERIVED SOL path (solRelayProxy.ts deletes the test override before the app
 * captures it — the exact production derivation, App.tsx wiring included).
 *
 * Phase 1 — the wire: the SOL rail reads through the relay's proxy derivation
 * (`{relayBase}/api/v1/solana/rpc`). The relay's test-helpers stub upstream answers
 * deterministically, so the accounts route renders "2 SOL" and the summed "$3.00" — numbers that
 * can ONLY come from the stub upstream THROUGH the proxy (no page stub, no provider). The stub's
 * /hits counter proves the envelope rode the proxy.
 *
 * Phase 2 — the walk (below): re-pointing the relay list at [dead, live] moves the SOL derivation
 * with it (one tick, App.tsx); the row still serves exactly 2 SOL from the second home, and the
 * dead first home was really TRIED (connection-class failures on record against its proxy route).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
// FIRST: deletes the SOL RPC test override pre-capture (the derivation), then the App graph loads.
import './solRelayProxy';
import {onboardSeededUnfunded, openBalances, relayGet} from '../harness/lib';
import {pickFreePort} from '../harness/flowRelay';
import {deadline as budgetDeadline} from '../harness/budget';
import {freshContext} from '../onboard/helpers';

/** The stub upstream's envelope counter (the relay's test route). */
async function stubHits(): Promise<number> {
  const j = await relayGet('/api/v1/test/solana-upstream/hits') as {hits?: number};
  return Number(j.hits ?? 0);
}

/** A free port that NOTHING will ever bind — the dead relay home (flow 164's trick). */
async function deadOrigin(): Promise<string> {
  return `http://127.0.0.1:${await pickFreePort()}`;
}

hermeticDescribe('flow 165 — solana-via-relay', () => {
  it('phase 1 — SOL+USD render through the relay proxy derivation and the hits counter proves the path', async () => {
    await freshContext();
    const m = await onboardSeededUnfunded('e2e-sol-relay', {fund: false});

    // The balances live on the ACCOUNTS route; Home never shows asset rows.
    await openBalances(m);
    const solRendered = await m.driver.waitForFunction(
      () => /2 SOL/.test(m.driver.bodyText()),
      {timeoutMs: 15_000},
    ).then(() => true).catch(() => false);
    expect(solRendered).toBe(true);
    expect(await m.driver.waitForText('$3.00', {timeoutMs: 15_000})).toBe(true);

    // The upstream was reached THROUGH the proxy: the stub's envelope counter is non-zero (it
    // only increments when the relay's proxy forwards a request to it).
    const hits = await stubHits();
    expect(hits > 0).toBe(true);

    await m.unmount();
  }, 150_000);

  it('phase 2 — the walk: a dead first relay home is skipped, SOL survives from the second home, and the dead proxy route was really tried', async () => {
    await freshContext();
    const dead = await deadOrigin();
    const live = process.env.DPAY_JEST_RELAY_URL ?? '';
    const m = await onboardSeededUnfunded('e2e-sol-relay-walk', {fund: false});

    // Ground truth through the derivation on the default (baked-origin) list.
    await openBalances(m);
    expect(await m.driver.waitForText('2 SOL', {timeoutMs: 15_000})).toBe(true);

    // Phase 2 aims the SOL polls at the dead origin too — expected, pre-declared.
    m.driver.allowRequestFailuresFrom(dead);

    // Re-point the relay list mid-session: [dead, live]. The SOL derivation follows in the same
    // tick (App.tsx installs the list and the SOL bases together); its first candidate is now
    // the DEAD relay's proxy route — a transport failure the walk must skip — and the live
    // second home keeps serving the row. A walk that stopped at the dead home would render the
    // unreadable state; a derivation that DIDN'T follow the list would keep the old base and the
    // dead-home failures below would not exist.
    await m.driver.click('btn-settings', {timeoutMs: 6000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    await m.driver.type('settings-relay', `${dead}\n${live}`, {timeoutMs: 4000});
    await m.driver.click('btn-relay-apply', {timeoutMs: 4000});
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    expect(await m.driver.waitForText('2 SOL', {timeoutMs: 20_000})).toBe(true);

    // The dead SOL home was really TRIED (not silently skipped): connection-class failures on
    // record against the dead origin's PROXY ROUTE — the request shape ONLY the derived
    // candidate list produces (the twin's phase-2 pin). Bounded wait: the '2 SOL' text can pass
    // off the pre-retarget render, so the evidence is the recorded dead-home dial of the NEXT
    // poll tick, not the text.
    const walkDeadline = budgetDeadline(15_000); // positive transition (next poll tick) — budget-scaled
    let deadSolFails: typeof m.driver.fetchFailures = [];
    for (;;) {
      m.driver.collectFetchFailures();
      deadSolFails = m.driver.fetchFailures.filter((f) => f.url.startsWith(`${dead}/api/v1/solana/rpc`));
      if (deadSolFails.length > 0 || Date.now() > walkDeadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(deadSolFails.length > 0).toBe(true);
    for (const f of deadSolFails) {
      expect(/CONNECTION|NETWORK|REFUSED|FAILED|ECONNREFUSED|fetch/i.test(f.error ?? '')).toBe(true);
      expect(/UNSAFE_PORT/i.test(f.error ?? '')).toBe(false);
    }
    // …and the row still reads exactly 2 SOL — from the second home, not a degraded state.
    expect(m.driver.bodyText()).toContain('2 SOL');

    await m.unmount();
  }, 180_000);
});
