/**
 * The Solana endpoint is editable from the phone (M4).
 *
 * `setSolanaRpcUrl` + `SOLANA_RPC_STORAGE_KEY` have been the seam every Solana read goes through
 * since 2026-09-08, and App.tsx has applied the stored value at boot since the same day — but no
 * screen reached it. On a web build an operator could set it from the console; on a phone nobody
 * could, so a dead provider key meant a store release rather than a settings edit. That is the gap
 * the 2026-09-08 outage cost days to (`docs/specs/2026-09-08-solana-rpc-plan.md` §1.4).
 *
 * The row is the relay row's twin — a draft, an explicit Apply, nothing on keystroke — with the two
 * differences that matter and are pinned here:
 *   • EMPTY IS A VALUE (it follows the relay-derived default again — under jest, the '' test
 *     override), so it must be applicable,
 *     and the field is re-seeded from the RESOLVED endpoint afterwards so the user can see what
 *     "empty" meant.
 *   • APPLYING CAN FAIL, loudly: `setSolanaRpcUrl` throws an actionable refusal for plain http and
 *     for a devnet host, and that sentence is what the user must read — nothing is persisted and
 *     the rail is not re-polled on that path.
 */
import {describe, test, expect, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SettingsSheet} from '../components/SettingsSheet';
import {setSolanaRpcUrl, solanaRpcUrl} from '../config/constants';
import {M} from '../i18n';

const DEFAULTS = {
  relayUrls: ['http://127.0.0.1:4391'],
  setRelayUrls: (_urls: string[]) => {},
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

afterEach(async () => {
  if (tree) { const t = tree; tree = null; await act(async () => { t.unmount(); }); }
  setSolanaRpcUrl(''); // back to the default — this module state is global
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

/** Mount + expand Advanced (collapsed by default — a curious consumer must not meet this row). */
async function mountAdvanced(applied: string[] = [], repolls: {n: number} = {n: 0}) {
  await act(async () => {
    tree = renderer.create(
      <SettingsSheet
        {...DEFAULTS}
        // The prop App.tsx supplies: apply through the REAL validator (so its refusals are the
        // ones under test), and record the call.
        setSolanaRpc={(u: string) => { applied.push(u); setSolanaRpcUrl(u); }}
        onSolanaRpcApplied={() => { repolls.n += 1; }}
        setIcGateway={() => {}}
        onIcGatewayApplied={() => {}}
      />,
    );
  });
  const t = tree!;
  await act(async () => { node(t, 'btn-advanced-toggle').props.onPress(); });
  return t;
}

const type = async (t: renderer.ReactTestRenderer, value: string) => {
  await act(async () => { node(t, 'settings-sol-rpc').props.onChangeText(value); });
};
const apply = async (t: renderer.ReactTestRenderer) => {
  await act(async () => { node(t, 'btn-sol-rpc-apply').props.onPress(); });
};

describe('SettingsSheet — the Solana endpoint row', () => {
  test('the row is behind Advanced, and Apply is inert until the draft differs', async () => {
    await act(async () => {
      tree = renderer.create(
        <SettingsSheet {...DEFAULTS} setSolanaRpc={() => {}} onSolanaRpcApplied={() => {}} setIcGateway={() => {}} onIcGatewayApplied={() => {}} />,
      );
    });
    expect(has(tree!, 'settings-sol-rpc')).toBe(false); // collapsed by default
    await act(async () => { node(tree!, 'btn-advanced-toggle').props.onPress(); });
    expect(has(tree!, 'settings-sol-rpc')).toBe(true);
    expect(node(tree!, 'btn-sol-rpc-apply').props.disabled).toBe(true);
  });

  test('typing changes nothing; Apply is what switches the endpoint, and it re-polls the rail', async () => {
    const applied: string[] = [];
    const repolls = {n: 0};
    const t = await mountAdvanced(applied, repolls);
    await type(t, 'https://mainnet.provider.example/?api-key=rotated');
    expect(applied).toEqual([]); // not on keystroke — the founder's stated preference
    expect(node(t, 'btn-sol-rpc-apply').props.disabled).toBe(false);
    await apply(t);
    expect(applied).toEqual(['https://mainnet.provider.example/?api-key=rotated']);
    expect(solanaRpcUrl()).toBe('https://mainnet.provider.example/?api-key=rotated');
    expect(repolls.n).toBe(1); // the operator sees the fix work, not 30s of the same dashes
    expect(node(t, 'btn-sol-rpc-apply').props.disabled).toBe(true); // settled: draft === applied
    expect(has(t, 'settings-sol-rpc-err')).toBe(false);
  });

  test('a refused endpoint shows the refusal VERBATIM, changes nothing and re-polls nothing', async () => {
    const applied: string[] = [];
    const repolls = {n: 0};
    const t = await mountAdvanced(applied, repolls);
    await type(t, 'http://insecure.example');
    await apply(t);
    expect(textOf(t, 'settings-sol-rpc-err')).toContain('https://');
    expect(solanaRpcUrl()).toBe(''); // the jest default ('') — untouched
    expect(repolls.n).toBe(0);
    // …and the draft is left alone so the user can correct it rather than retype it.
    expect(node(t, 'settings-sol-rpc').props.value).toBe('http://insecure.example');
  });

  test('a devnet host is refused by name — this wallet holds mainnet funds', async () => {
    const t = await mountAdvanced();
    await type(t, 'https://api.devnet.solana.com');
    await apply(t);
    expect(textOf(t, 'settings-sol-rpc-err')).toContain('api.devnet.solana.com');
    expect(solanaRpcUrl()).toBe('');
  });

  test('editing after a refusal clears the refusal — the message belongs to one attempt', async () => {
    const t = await mountAdvanced();
    await type(t, 'http://insecure.example');
    await apply(t);
    expect(has(t, 'settings-sol-rpc-err')).toBe(true);
    await type(t, 'https://mainnet.provider.example');
    expect(has(t, 'settings-sol-rpc-err')).toBe(false);
  });

  test('clearing the field is applicable, and follows the relay-derived default again', async () => {
    const applied: string[] = [];
    const t = await mountAdvanced(applied);
    await type(t, 'https://mainnet.provider.example/?api-key=theirs');
    await apply(t);
    expect(solanaRpcUrl()).toBe('https://mainnet.provider.example/?api-key=theirs');
    await type(t, '');
    expect(node(t, 'btn-sol-rpc-apply').props.disabled).toBe(false); // empty is a VALUE, not a no-op
    await apply(t);
    expect(applied[1]).toBe('');
    expect(solanaRpcUrl()).toBe(''); // the jest default is the empty test override
    // The field re-seeds from the RESOLVED endpoint, which is how the user learns what empty meant.
    expect(node(t, 'settings-sol-rpc').props.value).toBe(solanaRpcUrl());
  });

  test('the row names itself in the user\'s language and says what empty means', async () => {
    const t = await mountAdvanced();
    const labels = t.root.findAll(n => typeof n.props?.children === 'string').map(n => String(n.props.children));
    expect(labels).toContain(M.settings.advanced.solanaLabel);
    expect(labels).toContain(M.settings.advanced.solanaNote);
    expect(M.settings.advanced.solanaNote).toContain('empty');
  });
});
