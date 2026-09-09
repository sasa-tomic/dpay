/**
 * IcrcDepositSheet — the IC-rail receive surface (2026-08-29 founder hard rule: every funding
 * gate gives useful practical instructions; Objective 2 extends it to the home currency's IC
 * rail). GATE matrix:
 *
 *   direct-ICRC row (7/8) + principal derived → instructions card (send-from-any-IC-wallet,
 *       no-memo, catalog fee) + QR + copyable principal + honest watch + manual check.
 *   home-currency IC rail (ckUSDC 2, reached via ReceiveMode's rail routing) → the SAME surface,
 *       with the network named as the SETTLEMENT chain ("Internet Computer") — never the
 *       catalog's backing-chain field ("Ethereum"), which would misdirect the sender.
 *   incomplete row (no catalog descriptor / no ledger) → fail-closed noAddress error, NO QR.
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
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import type {Identity} from '../lib/types';

const BUNDLED_CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const BUNDLED_ASSETS = buildSelectableAssets(BUNDLED_CATALOG, {showTestnet: false, solanaEnabled: false});

const assetOf = (currency: number): SelectableAsset => {
  const a = BUNDLED_ASSETS.find(x => x.protocol === 'ic' && x.currency === currency);
  if (!a) throw new Error(`no bundled IC asset for currency ${currency}`);
  return a;
};

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
    tree = renderer.create(<IcrcDepositSheet identity={IDENTITY} catalog={BUNDLED_CATALOG} asset={assetOf(currency)} onClose={() => {}} />);
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

  test('the instruction is ACTIONABLE for someone who owns no IC wallet yet', async () => {
    // "Send it from any Internet Computer wallet" is a complete instruction only for someone who
    // already has one — and the target user is a tourist who does not, is not told what one IS,
    // and was offered no second route. The gate now names the KIND of thing to look for, the other
    // route that exists (an exchange withdrawal on this network), and what the address is NOT.
    // It names no product: which wallet or exchange to send a user to is a founder decision.
    (railBalanceOf as unknown as ReturnType<typeof jest.fn>).mockResolvedValue(null);
    const tree = await renderSheet(7);
    const where = textOf(tree, 'deposit-where-from');
    expect(where).toContain('VCHF');             // the asset to look for
    expect(where).toContain('Internet Computer'); // on which network
    expect(where.toLowerCase()).toContain('wallet app');
    expect(where.toLowerCase()).toContain('exchange'); // the second, real route
    const accepts = textOf(tree, 'deposit-only-accepts');
    expect(accepts).toContain('VCHF');
    expect(accepts).toContain('Internet Computer');
    expect(accepts.toLowerCase()).toContain('card'); // an address is not a card payment
  });

  test('ICP (currency 8) renders the same complete surface', async () => {
    (railBalanceOf as unknown as ReturnType<typeof jest.fn>).mockResolvedValue(null);
    const tree = await renderSheet(8);
    expect(textOf(tree, 'deposit-address')).toBe(PRINCIPAL);
    const instr = allText(tree.root.findAll(n => n.props && n.props.testID === 'deposit-instructions')[0]);
    expect(instr).toContain('ICP');
    expect(instr).toContain('0.00010000 ICP'); // ICP ledger fee 10_000 e8s
  });

  test('ckUSDC (the home-currency IC rail): same surface, network named as the SETTLEMENT chain', async () => {
    (railBalanceOf as unknown as ReturnType<typeof jest.fn>).mockResolvedValue(null);
    const tree = await renderSheet(2); // ckUSDC — family-mintered, but reachable as USD's IC rail
    expect(textOf(tree, 'deposit-address')).toBe(PRINCIPAL);
    const instr = allText(tree.root.findAll(n => n.props && n.props.testID === 'deposit-instructions')[0]);
    expect(instr).toContain('USDC');            // displayName's family vocabulary for CkEthErc20
    expect(instr).toContain('Internet Computer'); // the chain the transfer settles on
    expect(instr).not.toContain('Ethereum');      // the catalog's backing-chain field must NOT leak
    expect(instr).toContain('0.010000 USDC');     // ckUSDC ledger fee 10_000 e6s, formatted via the descriptor
    expect(has(tree, 'deposit-qr')).toBe(true);
    expect(has(tree, 'btn-deposit-copy')).toBe(true);
  });

  test('incomplete row fails CLOSED: noAddress error, no QR, no copy button', async () => {
    // A currency with NO catalog descriptor (reachability is ReceiveMode's call; the sheet itself
    // only fails on incomplete data). Clone VCHF's row under an unknown currency id.
    const base = assetOf(7);
    const orphan: SelectableAsset = base.protocol === 'ic' ? {...base, id: 'ic:77', currency: 77} : base;
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<IcrcDepositSheet identity={IDENTITY} catalog={BUNDLED_CATALOG} asset={orphan} onClose={() => {}} />);
    });
    await act(async () => {});
    activeTree = tree;
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
