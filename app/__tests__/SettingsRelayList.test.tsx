/**
 * The relay-address LIST editor in Settings (R1, spec 2026-09-09 §"Direction 2") — the relay row's
 * old draft/Apply contract, widened from one URL to one address PER LINE (order = priority).
 *
 * Pinned here, in the Solana row's own style:
 *   • APPLY IS WHAT ACTS — typing changes nothing;
 *   • an invalid line never reaches the app: its refusal renders under the field, naming the line
 *     number (the user's only map into their own textarea), and typing clears it;
 *   • EMPTY IS A VALUE — it applies as [], which the parent resolves to the addresses baked into
 *     the build (the same contract the Solana endpoint row established);
 *   • a relay build-drift error fired anywhere in the session renders HERE, verbatim — this is the
 *     screen an operator lands on to fix the address list.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SettingsSheet} from '../components/SettingsSheet';
import {relayFetch, relayBuildDrift, resetRelayBuildStateForTest} from '../services/relay';
import {resetRelayAddressesForTest, setRelayAddresses} from '../services/relayAddresses';
import {RelayBuildDriftError} from '../services/relay';

const DEFAULTS = {
  relayUrls: ['https://primary.example'],
  setSolanaRpc: () => {},
  onSolanaRpcApplied: () => {},
  setIcGateway: () => {},
  onIcGatewayApplied: () => {},
  onClose: () => {},
  onReset: () => {},
  onRestore: async () => {},
  secretHex: '9f'.repeat(32),
  username: 'tester',
  themeChoice: null,
  onSetTheme: () => {},
  localeChoice: null,
  onSetLocale: () => {},
  homeCurrency: 'CHF' as const,
  onSetHomeCurrency: () => {},
  assets: [],
};

let tree: renderer.ReactTestRenderer | null = null;
const realFetch = globalThis.fetch;

afterEach(async () => {
  if (tree) { const t = tree; tree = null; await act(async () => { t.unmount(); }); }
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  resetRelayBuildStateForTest();
  resetRelayAddressesForTest();
});

function node(t: renderer.ReactTestRenderer, testID: string) {
  return t.root.findAll(n => n.props?.testID === testID)[0];
}
function has(t: renderer.ReactTestRenderer, testID: string) {
  return t.root.findAll(n => n.props?.testID === testID).length > 0;
}
function textOf(t: renderer.ReactTestRenderer, testID: string): string {
  const c = node(t, testID).props.children;
  return Array.isArray(c) ? c.join('') : String(c ?? '');
}

/** Mount with a recording parent, Advanced expanded (collapsed by default — same as the Solana row). */
async function mountListEditor(applied: string[][] = []) {
  await act(async () => {
    tree = renderer.create(
      <SettingsSheet
        {...DEFAULTS}
        setRelayUrls={(urls: string[]) => { applied.push(urls); }}
      />,
    );
  });
  const t = tree!;
  await act(async () => { node(t, 'btn-advanced-toggle').props.onPress(); });
  return t;
}

const type = async (t: renderer.ReactTestRenderer, value: string) => {
  await act(async () => { node(t, 'settings-relay').props.onChangeText(value); });
};
const apply = async (t: renderer.ReactTestRenderer) => {
  await act(async () => { node(t, 'btn-relay-apply').props.onPress(); });
};

describe('SettingsSheet — the relay address LIST editor', () => {
  test('behind Advanced; a MULTILINE field seeded with the active list, one address per line', async () => {
    const t = await mountListEditor();
    expect(node(t, 'settings-relay').props.value).toBe('https://primary.example');
    expect(node(t, 'settings-relay').props.multiline).toBe(true);
  });
  test('Apply is inert until the draft differs; typing changes nothing', async () => {
    const applied: string[][] = [];
    const t = await mountListEditor(applied);
    expect(node(t, 'btn-relay-apply').props.disabled).toBe(true);
    await type(t, 'https://primary.example'); // same list, different day
    expect(node(t, 'btn-relay-apply').props.disabled).toBe(true);
  });
  test('a two-line draft applies as the ordered list; the field re-seeds from what the app now uses', async () => {
    const applied: string[][] = [];
    const t = await mountListEditor(applied);
    await type(t, 'https://one.example\nhttp://two.example:8787');
    await apply(t);
    expect(applied).toEqual([['https://one.example', 'http://two.example:8787']]);
  });
  test('each line is NORMALIZED on Apply (trailing slashes are the operator\'s habit, not their intent)', async () => {
    const applied: string[][] = [];
    const t = await mountListEditor(applied);
    await type(t, 'https://one.example/\nhttp://two.example/');
    await apply(t);
    expect(applied).toEqual([['https://one.example', 'http://two.example']]);
  });
  test('an invalid line NEVER applies — the refusal names the line and what was on it', async () => {
    const applied: string[][] = [];
    const t = await mountListEditor(applied);
    await type(t, 'https://one.example\nnope\nhttps://three.example');
    await apply(t);
    expect(applied).toEqual([]);
    expect(textOf(t, 'settings-relay-err')).toContain('Line 2');
    expect(textOf(t, 'settings-relay-err')).toContain('nope');
    // …and typing clears the refusal so the fix is not fought by a stale error.
    await type(t, 'https://one.example\nhttps://two.example');
    expect(has(t, 'settings-relay-err')).toBe(false);
    await apply(t);
    expect(applied).toEqual([['https://one.example', 'https://two.example']]);
  });
  test('EMPTY IS A VALUE — it applies as [] and the parent restores the baked default', async () => {
    const applied: string[][] = [];
    const t = await mountListEditor(applied);
    await type(t, '');
    await apply(t);
    expect(applied).toEqual([[]]);
  });

  test('a relay build-drift error from anywhere in the session renders HERE, verbatim', async () => {
    // Produce a REAL drift through the real walk (mocked wire): the preferred address is down for
    // data but readable on /version; the replica answers data with a different commit.
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.origin === 'http://ref.example') {
        if (u.pathname === '/api/v1/version') return {ok: true, status: 200, json: async () => ({commit: 'commit-one', commit_date: 'd'})} as unknown as Response;
        if (u.pathname === '/api/v1/integrity') return {ok: true, status: 200, json: async () => ({facade_canister: 'f', pinned_module_hash: 'h'})} as unknown as Response;
        throw new Error('down');
      }
      if (u.origin === 'http://rep.example') {
        if (u.pathname === '/api/v1/x') return {ok: true, status: 200, json: async () => ({})} as unknown as Response;
        if (u.pathname === '/api/v1/version') return {ok: true, status: 200, json: async () => ({commit: 'commit-two', commit_date: 'd'})} as unknown as Response;
        if (u.pathname === '/api/v1/integrity') return {ok: true, status: 200, json: async () => ({facade_canister: 'f', pinned_module_hash: 'h'})} as unknown as Response;
      }
      throw new Error('unreachable');
    });
    setRelayAddresses(['http://ref.example', 'http://rep.example']);
    await expect(relayFetch('http://ref.example', '/api/v1/x')).rejects.toBeInstanceOf(RelayBuildDriftError);
    expect(relayBuildDrift()).toBeInstanceOf(RelayBuildDriftError);

    const t = await mountListEditor();
    const shown = textOf(t, 'settings-relay-drift');
    expect(shown).toContain('http://ref.example');
    expect(shown).toContain('http://rep.example');
    expect(shown).toContain('commit-one');
    expect(shown).toContain('commit-two');
    expect(shown).toContain('different builds');
  });

  test('drift visible → Apply ENABLED on a clean draft; applying clean re-probes: drift gone, next walk succeeds (M3)', async () => {
    // The same-address redeploy: the operator's replica was redeployed at the SAME URL (the drift
    // message's own advice). There is no edit to make — the draft IS the list they run — so Apply
    // must be reachable anyway, and applying a CLEAN draft while drift is latched = "I fixed it,
    // look again": bump the revision (what the walk's caches and the latch key on), clear the line.
    const serveDriftWire = () => {
      (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(async (url: string) => {
        const u = new URL(url);
        if (u.origin === 'http://ref.example') {
          if (u.pathname === '/api/v1/version') return {ok: true, status: 200, json: async () => ({commit: 'commit-one', commit_date: 'd'})} as unknown as Response;
          if (u.pathname === '/api/v1/integrity') return {ok: true, status: 200, json: async () => ({facade_canister: 'f', pinned_module_hash: 'h'})} as unknown as Response;
          throw new Error('down');
        }
        if (u.origin === 'http://rep.example') {
          if (u.pathname === '/api/v1/x') return {ok: true, status: 200, json: async () => ({})} as unknown as Response;
          if (u.pathname === '/api/v1/version') return {ok: true, status: 200, json: async () => ({commit: 'commit-two', commit_date: 'd'})} as unknown as Response;
          if (u.pathname === '/api/v1/integrity') return {ok: true, status: 200, json: async () => ({facade_canister: 'f', pinned_module_hash: 'h'})} as unknown as Response;
        }
        throw new Error('unreachable');
      });
    };
    serveDriftWire();
    setRelayAddresses(['http://ref.example', 'http://rep.example']);
    await expect(relayFetch('http://ref.example', '/api/v1/x')).rejects.toBeInstanceOf(RelayBuildDriftError);

    const applied: string[][] = [];
    const t = await mountListEditor(applied);
    expect(has(t, 'settings-relay-drift')).toBe(true);
    expect(node(t, 'btn-relay-apply').props.disabled).toBe(false); // drift showing → Apply reachable on a CLEAN draft
    await apply(t);
    expect(has(t, 'settings-relay-drift')).toBe(false); // the apply re-probed: the line is gone
    expect(node(t, 'btn-relay-apply').props.disabled).toBe(true); // and nothing is left to apply
    expect(applied).toEqual([]); // the parent was NOT told — the list did not change
    // The re-probe is real: with the redeploy landed (ref now answers data), the very same
    // fetch that latched drift succeeds.
    (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.origin === 'http://ref.example' && u.pathname === '/api/v1/x') {
        return {ok: true, status: 200, json: async () => ({served: 'ref'})} as unknown as Response;
      }
      throw new Error('unreachable');
    });
    const r = await relayFetch('http://ref.example', '/api/v1/x');
    expect(r.status).toBe(200);
  });
});
