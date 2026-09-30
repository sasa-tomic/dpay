/**
 * DepositSheet — the two failure paths that must not go quiet (2026-09-01).
 *
 * This sheet is where a user is told where to send real funds, so when it degrades it must still
 * leave a reason behind. Two paths swallowed their error object outright:
 *
 *   - the deposit-address fetch's catch, which set the generic on-screen error and dropped the
 *     exception. Reachability is honest here: `railBtcDepositAddress` self-catches today and
 *     returns null (it logs its own reason), so the sheet's catch is the boundary for anything
 *     else in that block throwing. The rail seam is mocked to throw so the CONTRACT is pinned —
 *     a throw is diagnosable — rather than a currently-reachable production path.
 *   - `DpayCore.icpSelfPrincipal`'s `.catch(() => {})`. This one IS reachable: it is a native
 *     bridge call. Its other two call sites (ReceiveMode, CkErc20DepositSheet) already log, so
 *     this sheet was the lone silent one, and the visible symptom — the "Already on the Internet
 *     Computer?" section rendering with no address under it — named no cause at all.
 *
 * Coverage boundary: e2e/tests/22-deposit-error.mjs owns the user-facing error COPY; this file
 * owns the diagnostics and the silence-on-success counterpart. Seams mocked at services/rail,
 * services/relay and services/native — the same boundaries trust-fund-sheets.test.tsx uses.
 */
import {describe, test, expect, beforeEach, afterEach, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

import {DepositSheet} from '../components/DepositSheet';
import {BUNDLED_NETWORKS, familyDisplay, icpCatalogOf} from '../config/catalog';
import type {Identity} from '../lib/types';
import {M} from '../i18n';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);

jest.mock('../services/rail', () => ({
  railBtcDepositAddress: jest.fn(),
  railBalanceOf: jest.fn(),
}));
jest.mock('../services/relay', () => ({depositInfo: jest.fn()}));
jest.mock('../services/native', () => ({DpayCore: {icpSelfPrincipal: jest.fn()}}));

import {railBtcDepositAddress, railBalanceOf} from '../services/rail';
import {depositInfo} from '../services/relay';
import {DpayCore} from '../services/native';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'test'};
const BTC_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const PRINCIPAL = 'w7x7r-cok77-xa2jb-wa2jb-bc';

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.mocked(railBtcDepositAddress).mockResolvedValue(BTC_ADDR);
  jest.mocked(railBalanceOf).mockResolvedValue(null);
  // Info is supplementary and is left failing on purpose (the sheet renders "none"/"no minimum"),
  // which also proves the assertions below key on their OWN prefix and not on warn traffic in
  // general.
  jest.mocked(depositInfo).mockRejectedValue(new Error('offline test'));
  jest.mocked(DpayCore.icpSelfPrincipal).mockResolvedValue(PRINCIPAL);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); });

/** Every console.warn whose first argument starts with `prefix`, joined. */
function warnings(prefix: string): string {
  return (warn.mock.calls as unknown[][])
    .map((c: unknown[]) => c.map(a => (a instanceof Error ? a.message : String(a))).join(' '))
    .filter((line: string) => line.startsWith(prefix))
    .join('\n');
}

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

async function mount(): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <DepositSheet identity={IDENTITY} relayUrl="https://relay.test" catalog={CATALOG}
        currency={1} display={familyDisplay(CATALOG, 1)!} onClose={() => {}} />,
    );
  });
  // Flush the address fetch, the principal derivation and the best-effort info miss.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return tree;
}

describe('DepositSheet — failure paths leave a reason behind', () => {
  test('a throwing address fetch names its reason in the log AND still refuses on screen', async () => {
    jest.mocked(railBtcDepositAddress).mockRejectedValue(new Error('boundary unreachable: ECONNRESET'));
    const tree = await mount();
    expect(warnings('deposit address fetch failed:')).toContain('boundary unreachable: ECONNRESET');
    // The refusal itself must survive the added logging: no address, no QR to send funds to.
    expect(has(tree, 'deposit-address')).toBe(false);
    expect(has(tree, 'deposit-qr')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a null address answer while ONLINE ⇒ the unreachable sentence: connection fine, IC named (work order 2026-09-30)', async () => {
    // The old copy — "Check your connection and try again." — blamed the phone while it was
    // online and the minter's side was down. The blame is now CLASSIFIED in the sheet
    // (`classifyIcReadFailure`); the override makes the arm hermetic.
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online'};
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    jest.mocked(railBtcDepositAddress).mockResolvedValue(null as never);
    const tree = await mount();
    const texts = tree.root.findAll(n => n.props && typeof n.props.children === 'string') as renderer.ReactTestInstance[];
    const errText = texts.map(t => t.props.children as string).find(s => s.includes('Internet Computer'));
    expect(errText).toBe(M.deposit.ck.addressUnreachable);
    expect(errText).toMatch(/connection is fine/);
    expect(errText).toMatch(/untouched/i);
    expect(has(tree, 'deposit-qr')).toBe(false);
    act(() => { tree.unmount(); });
    delete g.__DPAY_TEST_SOLANA_CONNECTIVITY;
  });

  test('a throwing address fetch while OFFLINE ⇒ the offline sentence, nobody blamed', async () => {
    const g = globalThis as unknown as {__DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online'};
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'offline';
    jest.mocked(railBtcDepositAddress).mockRejectedValue(new Error('boundary unreachable: ECONNRESET'));
    const tree = await mount();
    const texts = tree.root.findAll(n => n.props && typeof n.props.children === 'string') as renderer.ReactTestInstance[];
    const errText = texts.map(t => t.props.children as string).find(s => s.includes('offline'));
    expect(errText).toBe(M.deposit.ck.addressOffline);
    expect(errText).not.toMatch(/check your connection/i);
    act(() => { tree.unmount(); });
    delete g.__DPAY_TEST_SOLANA_CONNECTIVITY;
  });

  test('a rejected self-principal derivation names its reason and still omits only the section address', async () => {
    jest.mocked(DpayCore.icpSelfPrincipal).mockRejectedValue(new Error('native bridge unavailable'));
    const tree = await mount();
    expect(warnings('icpSelfPrincipal failed (no same-ledger receive section):')).toContain('native bridge unavailable');
    // Graceful is preserved, not traded away: the primary deposit address still renders and the
    // IC section is still there — only its address line is absent.
    expect(has(tree, 'deposit-address')).toBe(true);
    expect(has(tree, 'ic-also-section')).toBe(true);
    expect(has(tree, 'ic-also-address')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('neither diagnostic fires when both reads succeed', async () => {
    const tree = await mount();
    expect(warnings('deposit address fetch failed:')).toBe('');
    expect(warnings('icpSelfPrincipal failed')).toBe('');
    expect(has(tree, 'ic-also-address')).toBe(true);
    act(() => { tree.unmount(); });
  });
});
