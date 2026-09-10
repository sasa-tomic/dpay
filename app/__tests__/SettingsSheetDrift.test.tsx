/**
 * SettingsSheet — the wave-2 drift-banner freshness pin.
 *
 * `relayBuildDrift()` is walk state latched by ANY relay call in the app — not by this sheet —
 * and the sheet computed it once per render. Nothing re-rendered the sheet when a walk latched
 * drift (or a re-point cleared it) while the Advanced disclosure stood open, so the banner could
 * sit stale — missing a live latch, or lingering after the operator fixed it — until some
 * unrelated state changed. Wave-2: while the disclosure is open, the sheet re-renders on a 1 s
 * interval (minimal by design — no event system). This pins both halves with fake timers:
 * latch while open → visible within the interval; re-point (revision bump) → gone within it.
 *
 * Only `fetch` is faked: the drift is latched by the REAL `relayFetch` walk, and the sheet is
 * the real component (react-test-renderer is this project's only renderer).
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SettingsSheet} from '../components/SettingsSheet';
import {RelayBuildDriftError, relayBuildDrift, relayFetch, resetRelayBuildStateForTest} from '../services/relay';
import {resetRelayAddressesForTest, setRelayAddresses} from '../services/relayAddresses';
import type {SelectableAsset} from '../config/assets';
import type {Identity} from '../lib/types';

jest.mock('../services/native', () => ({DpayCore: {}}));

const realFetch = globalThis.fetch;
const requests: string[] = [];
const A = 'http://a.example';
const B = 'http://b.example';

type Entry = {ok: boolean; status: number; body?: unknown} | 'reject';

/** The relayFailover.test.ts stand-in, trimmed to what a drift latch needs: per-origin PATH
 *  table, instant answers, refusal for anything unlisted. */
function serve(handlers: Record<string, Record<string, Entry>>) {
  (globalThis as unknown as {fetch: unknown}).fetch = jest.fn((url: string) => {
    requests.push(url);
    const u = new URL(url);
    const hit = handlers[u.origin]?.[u.pathname];
    if (hit == null || hit === 'reject') return Promise.reject(new Error('network refused'));
    return Promise.resolve({ok: hit.ok, status: hit.status, json: async () => hit.body ?? {}} as unknown as Response);
  });
}

const versionBody = (commit: string) => ({name: 'dpay-relay', version: '1.0.0', commit, commit_date: '2026-09-10'});
const integrityBody = () => ({facade_canister: 'facade-id', live_module_hash: 'live', pinned_module_hash: 'h1', status: 'MATCH', relay_commit: 'x'});
const probes = (commit: string) => ({
  '/api/v1/version': {ok: true, status: 200, body: versionBody(commit)},
  '/api/v1/integrity': {ok: true, status: 200, body: integrityBody()},
});

/** A live build-drift mismatch: A dead for data but readable (c1), B answering on a DIFFERENT
 *  commit (c2) — the walk latches drift the moment B's 2xx reaches the build gate. */
function serveDriftWorld() {
  serve({
    [A]: {'/api/v1/x': 'reject', ...probes('c1')},
    [B]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'b'}}, ...probes('c2')},
  });
}

let tree: renderer.ReactTestRenderer | null = null;

beforeEach(() => {
  resetRelayBuildStateForTest();
  resetRelayAddressesForTest();
  requests.length = 0;
  jest.useFakeTimers({doNotFake: ['Date']});
});
afterEach(async () => {
  if (tree) {
    act(() => { tree!.unmount(); });
    tree = null;
  }
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  // React's work scheduler queues due-at-now 0 ms ticks around renders under a frozen fake
  // clock; fire them so the hard assertion below proves no REAL timer (the 1 s drift interval)
  // outlived the disclosure/unmount.
  await jest.advanceTimersByTimeAsync(0);
  expect(jest.getTimerCount()).toBe(0); // the interval died with the disclosure/unmount
  jest.useRealTimers();
});

function mountSheet() {
  return act(async () => {
    tree = renderer.create(
      <SettingsSheet
        relayUrls={[A, B]}
        setRelayUrls={jest.fn()}
        setSolanaRpc={jest.fn()}
        onSolanaRpcApplied={jest.fn()}
        onClose={jest.fn()}
        onReset={jest.fn()}
        onRestore={jest.fn<(id: Identity) => Promise<void>>().mockImplementation(async () => {})}
        secretHex={'ab'.repeat(32)}
        username="Kiosk"
        themeChoice={null}
        onSetTheme={jest.fn()}
        localeChoice={null}
        onSetLocale={jest.fn()}
        homeCurrency="CHF"
        onSetHomeCurrency={jest.fn()}
        assets={[] as SelectableAsset[]}
        openAdvanced
      />,
    );
  });
}

const findDrift = () => tree!.root.findAll((n) => n.props.testID === 'settings-relay-drift');
// One banner renders as BOTH the composite Text and its host element (both carry the testID), so
// presence is a boolean, never a count.
const bannerVisible = () => findDrift().length > 0;

describe('the drift banner is FRESH while the Advanced disclosure is open (wave-2)', () => {
  test('a walk latching drift mid-open shows the banner within the interval; a re-point clears it', async () => {
    serveDriftWorld();
    setRelayAddresses([A, B]);
    await mountSheet();
    expect(bannerVisible()).toBe(false); // clean world: no banner

    // Any relay call in the app latches drift (B's build differs from A's)…
    await expect(relayFetch(A, '/api/v1/x')).rejects.toBeInstanceOf(RelayBuildDriftError);
    // …but nothing re-rendered the sheet yet — this was exactly the staleness bug: without the
    // interval, a latch mid-open stayed invisible until some unrelated render.
    expect(bannerVisible()).toBe(false);
    expect(relayBuildDrift()).not.toBeNull(); // the latch IS live — the view is what was stale

    await act(async () => { jest.advanceTimersByTime(1000); }); // one interval tick
    expect(bannerVisible()).toBe(true); // latched → banner visible within the second

    // The operator re-points the list: the latch dies with the revision (relayBuildDrift() reads
    // null at once) — the banner must not LINGER past the next tick.
    setRelayAddresses([B]);
    expect(relayBuildDrift()).toBeNull();
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(bannerVisible()).toBe(false); // cleared → banner gone within the second
  });
});
