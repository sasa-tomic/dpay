/**
 * The IC gateway override is editable from the phone (F2) — the Solana endpoint row's twin.
 *
 * `icGatewayUrl`/`setIcGatewayUrl` + `IC_GATEWAY_STORAGE_KEY` are the seam every IC /api/v2
 * submission goes through, and App.tsx applies the stored value at boot — but until 2026-09-12 no
 * screen reached it, so pointing a demo phone at a local replica required a store release. That
 * was F2 of the measured `just demo` break (2026-09-07): even with the catalog aligned, the phone
 * kept talking to icp-api.io.
 *
 * The row keeps the twins' two invariants:
 *   • EMPTY IS A VALUE (it restores the public icp-api.io base), so it must be applicable, and
 *     the field re-seeds from the RESOLVED base afterwards so the operator can see what "empty"
 *     meant.
 *   • APPLYING CAN FAIL, loudly: `setIcGatewayUrl` throws an actionable refusal (unparseable URL,
 *     plain http on a public host), and that sentence renders verbatim — nothing is persisted and
 *     the balances are not re-polled on that path.
 * Plus the demo's own acceptance: plain http for a LOCAL host (the emulator→host loopback) is a
 * value, not a refusal.
 */
import {describe, test, expect, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SettingsSheet} from '../components/SettingsSheet';
import {icGatewayUrl, setIcGatewayUrl} from '../config/constants';

const DEFAULTS = {
  relayUrls: ['http://127.0.0.1:4391'],
  setRelayUrls: (_urls: string[]) => {},
  setSolanaRpc: (_u: string) => {},
  onSolanaRpcApplied: () => {},
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
  setIcGatewayUrl(''); // back to the default — this module state is global
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

/** Mount + expand Advanced (collapsed by default — this row is operator-facing, not a feature). */
async function mountAdvanced(applied: string[] = [], repolls: {n: number} = {n: 0}) {
  await act(async () => {
    tree = renderer.create(
      <SettingsSheet
        {...DEFAULTS}
        // The prop App.tsx supplies: apply through the REAL validator (so its refusals are the
        // ones under test), and record the call.
        setIcGateway={(u: string) => { applied.push(u); setIcGatewayUrl(u); }}
        onIcGatewayApplied={() => { repolls.n += 1; }}
      />,
    );
  });
  const t = tree!;
  await act(async () => { node(t, 'btn-advanced-toggle').props.onPress(); });
  return t;
}

const type = async (t: renderer.ReactTestRenderer, value: string) => {
  await act(async () => { node(t, 'settings-ic-gateway').props.onChangeText(value); });
};
const apply = async (t: renderer.ReactTestRenderer) => {
  await act(async () => { node(t, 'btn-ic-gateway-apply').props.onPress(); });
};

describe('SettingsSheet — the IC gateway row', () => {
  test('the row is behind Advanced and shows the default; Apply is inert until the draft differs', async () => {
    await act(async () => {
      tree = renderer.create(
        <SettingsSheet {...DEFAULTS} setIcGateway={() => {}} onIcGatewayApplied={() => {}} />,
      );
    });
    expect(has(tree!, 'settings-ic-gateway')).toBe(false); // collapsed by default
    await act(async () => { node(tree!, 'btn-advanced-toggle').props.onPress(); });
    expect(has(tree!, 'settings-ic-gateway')).toBe(true);
    expect(node(tree!, 'settings-ic-gateway').props.value).toBe('https://icp-api.io');
    expect(node(tree!, 'btn-ic-gateway-apply').props.disabled).toBe(true);
  });

  test('typing changes nothing; Apply is what switches the base, and it re-polls the balances', async () => {
    const applied: string[] = [];
    const repolls = {n: 0};
    const t = await mountAdvanced(applied, repolls);
    await type(t, 'http://10.0.2.2:4943');
    expect(applied).toEqual([]); // not on keystroke
    expect(node(t, 'btn-ic-gateway-apply').props.disabled).toBe(false);
    await apply(t);
    expect(applied).toEqual(['http://10.0.2.2:4943']);
    expect(icGatewayUrl()).toBe('http://10.0.2.2:4943');
    expect(repolls.n).toBe(1); // the operator sees the retarget work, not stale dashes
    expect(node(t, 'btn-ic-gateway-apply').props.disabled).toBe(true); // settled: draft === applied
    expect(has(t, 'settings-ic-gateway-err')).toBe(false);
  });

  test('a refused base shows the refusal VERBATIM, changes nothing and re-polls nothing', async () => {
    const applied: string[] = [];
    const repolls = {n: 0};
    const t = await mountAdvanced(applied, repolls);
    await type(t, 'http://icp-api.example');
    await apply(t);
    expect(textOf(t, 'settings-ic-gateway-err')).toContain('https://');
    expect(icGatewayUrl()).toBe('https://icp-api.io'); // untouched
    expect(repolls.n).toBe(0);
    // …and the draft is left alone so the operator can correct it rather than retype it.
    expect(node(t, 'settings-ic-gateway').props.value).toBe('http://icp-api.example');
  });

  test('EMPTY IS A VALUE — clearing follows the public gateway again and the field says which one', async () => {
    setIcGatewayUrl('http://10.0.2.2:4943'); // a previous override, as a returning demo phone would boot with
    const applied: string[] = [];
    const repolls = {n: 0};
    const t = await mountAdvanced(applied, repolls);
    expect(node(t, 'settings-ic-gateway').props.value).toBe('http://10.0.2.2:4943');
    await type(t, '');
    await apply(t);
    expect(applied).toEqual(['']);
    expect(icGatewayUrl()).toBe('https://icp-api.io');
    // Re-seeded from the RESOLVED base: the operator sees what "empty" meant.
    expect(node(t, 'settings-ic-gateway').props.value).toBe('https://icp-api.io');
    expect(repolls.n).toBe(1);
    expect(node(t, 'btn-ic-gateway-apply').props.disabled).toBe(true);
  });
});
