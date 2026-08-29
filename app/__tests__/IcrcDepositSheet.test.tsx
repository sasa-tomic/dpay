/**
 * IcrcDepositSheet — the direct-ICRC receive surface (VCHF/ICP, 2026-08-29 founder hard rule:
 * every funding gate gives useful practical instructions). GATE matrix:
 *
 *   direct-ICRC row (7/8) + principal derived → instructions card (send-from-any-IC-wallet,
 *       no-memo, catalog fee) + QR + copyable principal + honest watch + manual check.
 *   non-direct row (e.g. ckBTC 1, family-mintered) → fail-closed noAddress error, NO QR.
 *   received delta (ledger balance strictly above the watched baseline) → success card with the
 *       exact received amount (formatted via the catalog descriptor) + Done.
 *
 * DpayCore.icpSelfPrincipal is mocked at the services/native seam; railBalanceOf (the signed
 * icrc1_balance_of watch) at the services/rail seam — the smallest boundaries, same pattern as
 * trust-fund-sheets.test.tsx.
 */
import {describe, test, expect, afterEach, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

import {IcrcDepositSheet} from '../components/IcrcDepositSheet';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {Identity} from '../lib/types';

const BUNDLED_CATALOG = icpCatalogOf(BUNDLED_NETWORKS);

const PRINCIPAL = 'w7x7r-cok77-xa2jb-wa2jb-bc'; // stand-in self principal
jest.mock('../services/native', () => ({
  DpayCore: {icpSelfPrincipal: jest.fn(async () => PRINCIPAL)},
}));
jest.mock('../services/rail', () => ({
  railBalanceOf: jest.fn(),
}));

import {railBalanceOf} from '../services/rail';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'test'};

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  return String(node.props.children ?? '');
}

/** Every string under a subtree — for asserting instruction-card copy assembled from runs. */
function allText(node: renderer.ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string') { parts.push(n); return; }
    if (typeof n === 'number') { parts.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    (n as renderer.ReactTestInstance).children?.forEach(walk);
  };
  walk(node);
  return parts.join(' ');
}

let activeTree: renderer.ReactTestRenderer | null = null;

async function renderSheet(currency: number) {
  const tree = await renderSheetInner(currency);
  activeTree = tree;
  return tree;
}

async function renderSheetInner(currency: number) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<IcrcDepositSheet identity={IDENTITY} catalog={BUNDLED_CATALOG} currency={currency} onClose={() => {}} />);
  });
  await act(async () => {}); // flush the derivation effect
  return tree;
}

describe('IcrcDepositSheet', () => {
  afterEach(() => {
    // Unmount (inside act so effect cleanup clears the receive-watch interval) — leaked timers
    // force-exit the jest worker.
    if (activeTree) { const t = activeTree; activeTree = null; act(() => { t.unmount(); }); }
  });

  test('VCHF: principal + practical instructions + fee from the catalog + copy/watch testIDs', async () => {
    (railBalanceOf as unknown as ReturnType<typeof jest.fn>).mockResolvedValue(null);
    const tree = await renderSheet(7);
    expect(textOf(tree, 'deposit-address')).toBe(PRINCIPAL);
    const instr = allText(tree.root.findAll(n => n.props && n.props.testID === 'deposit-instructions')[0]);
    expect(instr).toContain('VCHF');                      // names the EXACT asset
    expect(instr).toContain('Internet Computer');         // names the network to send from
    expect(instr).toContain('No memo or reference needed'); // plain-transfer instruction
    expect(instr).toContain('0.00010000 VCHF');        // ledger fee formatted via the descriptor
    expect(has(tree, 'deposit-qr')).toBe(true);
    expect(has(tree, 'btn-deposit-copy')).toBe(true);
    expect(has(tree, 'deposit-status')).toBe(true);
    expect(has(tree, 'btn-deposit-check')).toBe(true);
  });

  test('ICP (currency 8) renders the same complete surface', async () => {
    (railBalanceOf as unknown as ReturnType<typeof jest.fn>).mockResolvedValue(null);
    const tree = await renderSheet(8);
    expect(textOf(tree, 'deposit-address')).toBe(PRINCIPAL);
    const instr = allText(tree.root.findAll(n => n.props && n.props.testID === 'deposit-instructions')[0]);
    expect(instr).toContain('ICP');
    expect(instr).toContain('0.00010000 ICP'); // ICP ledger fee 10_000 e8s
  });

  test('non-direct row fails CLOSED: noAddress error, no QR, no copy button', async () => {
    const tree = await renderSheet(1); // ckBTC — family-mintered, not direct-ICRC
    const errText = allText(tree.root).toString();
    expect(errText).toContain('No deposit address available.');
    expect(has(tree, 'deposit-qr')).toBe(false);
    expect(has(tree, 'btn-deposit-copy')).toBe(false);
    expect(has(tree, 'btn-deposit-check')).toBe(false);
  });

  test('received delta: strictly-higher balance → success card with the exact amount + Done', async () => {
    const bal = railBalanceOf as unknown as ReturnType<typeof jest.fn>;
    bal.mockResolvedValueOnce('10000')   // mount poll → baseline (0.0001 VCHF)
       .mockResolvedValueOnce('20000');  // manual check → +0.0001 VCHF received
    const tree = await renderSheet(7);
    expect(has(tree, 'deposit-instructions')).toBe(true); // still watching before the delta
    await act(async () => {
      tree.root.findAll(n => n.props && n.props.testID === 'btn-deposit-check')[0].props.onPress();
    });
    const card = allText(tree.root).toString();
    expect(card).toContain('received');
    expect(card).toContain('0.00010000 VCHF');
    expect(has(tree, 'btn-deposit-done')).toBe(true);
    expect(has(tree, 'deposit-instructions')).toBe(false); // the watch surface is replaced
  });
});
