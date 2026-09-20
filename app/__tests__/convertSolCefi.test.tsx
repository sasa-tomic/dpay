// The SOL-side CeFi surface (2026-09-20, live-sweep defect 1): a registered cefi venue whose
// pair carries a SPL mint as the DEPOSIT side must be offered on the SOL convert screen exactly
// as the IC surface offers it in the other direction — one destination group, the venue's own
// quote figures, the user's own derived IC principal as the payout target, and the order as the
// lock. Founder rule: every currency through the SAME UI surfaces — per-rail divergence is a bug.
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpPrincipalFromPubkey: jest.fn(async () => 'myprinc-ipay'),
  },
  DpayNfc: {},
  DpaySolNfc: {},
}));
jest.mock('../services/sideshift', () => ({
  sideShiftStatusUrl: (o: string) => `https://provider.test/shifts/${o}`,
  SIDESHIFT_STATUS_BASE: 'https://provider.test',
  fetchSideShiftQuote: jest.fn(),
  createSideShiftFixedShift: jest.fn(),
}));
jest.mock('../services/jupiter', () => ({
  fetchJupiterQuote: jest.fn(),
  fetchJupiterSwapTx: jest.fn(),
}));
jest.mock('../convertResume', () => ({
  convertResumeSnapshot: jest.fn((): Record<string, unknown> => ({})),
  subscribeConvertRecords: jest.fn(() => () => undefined),
  adoptConvertRecord: jest.fn(async () => undefined),
  acknowledgeStuckRecord: jest.fn(async () => undefined),
  attachCctpBurnTx: jest.fn(),
  confirmCrossRailSolLeg: jest.fn(),
  declineCctpHandoff: jest.fn(),
}));
// Real convert module except staleness (fixed fixture timestamps would spin the stale loop
// under real timers). prepareCeFiConvertRecord + fetchCeFiConvertQuote stay REAL.
jest.mock('../convert', () => {
  const actual = jest.requireActual('../convert') as Record<string, unknown>;
  return {...actual, isQuoteStale: () => false};
});

import {ConvertMode} from '../components/ConvertMode';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {EURC_MINT_ADDRESS} from '../solana/tokens';
import {deriveSolanaAddress} from '../solana/identity';
import {fetchSideShiftQuote, createSideShiftFixedShift} from '../services/sideshift';
import {adoptConvertRecord} from '../convertResume';

const CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
const EURC_ASSET = ASSETS.find(a => a.protocol === 'solana' && a.token === 'EURC') as SelectableAsset & {protocol: 'solana'};
const IDENTITY = {secretHex: 'aa'.repeat(32), publicHex: 'bb'.repeat(32), username: 'tester'};
// 2 EURC held; typing '1' keeps the insufficient gate quiet and matches ORDER.depositAmount.
const BALANCES = {[EURC_MINT_ADDRESS]: '2000000'};

const ORDER = {
  id: 'shift-sol-e2e-1',
  depositAddress: 'icp-deposit-address-e2e',
  depositMemo: null,
  depositAmount: '1',
  settleAmount: '0.0495',
  expiresAt: '2026-09-21T12:00:00.000Z',
};

function mount() {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ConvertMode
        identity={IDENTITY}
        relayUrl="http://relay.test"
        catalog={CATALOG}
        selectedAsset={EURC_ASSET}
        assetBalances={{}}
        solana={{sol: '5000000000', tokens: BALANCES}}
        onActivity={() => undefined}
        onBack={() => undefined}
        onShowDepositAddress={() => undefined}
      />,
    );
  });
  return tree;
}

const present = (tree: renderer.ReactTestRenderer, t: string) =>
  tree.root.findAll(n => n.props != null && n.props.testID === t);
const textOf = (node: {props: {children?: unknown}}): string => {
  const walk = (c: unknown): string =>
    c == null ? ''
    : typeof c === 'string' ? c
    : Array.isArray(c) ? c.map(walk).join('')
    : typeof c === 'object' && 'props' in (c as object) ? walk((c as {props: {children?: unknown}}).props.children)
    : '';
  return walk(node.props.children);
};

function mountWithCefiPicked(tree: renderer.ReactTestRenderer): void {
  // Pick the cefi destination group, then type the amount.
  act(() => {
    present(tree, 'convert-sol-dest-cefi-sideshift-eurc')[0].props.onPress();
  });
  act(() => {
    present(tree, 'convert-amount')[0].props.onChangeText('1');
  });
}

describe('SOL-side CeFi destination (sideshift-eurc)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('EURC screen offers the cefi destination group beside the in-wallet SPL group', () => {
    jest.mocked(fetchSideShiftQuote).mockResolvedValue({venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});
    const tree = mount();
    // The asset-key testID contract (defect 3): in-wallet rows use sol-*/cefi rows use the venue id.
    expect(present(tree, 'convert-sol-dest').length).toBeGreaterThan(0);
    expect(present(tree, 'convert-sol-dest-sol-usdc').length).toBeGreaterThan(0);
    const cefi = present(tree, 'convert-sol-dest-cefi-sideshift-eurc');
    expect(cefi.length).toBeGreaterThan(0);
    // The row says WHAT lands, on WHICH rail, through WHICH venue — the IC row's exact shape.
    const label = textOf(cefi[0]);
    expect(label).toContain('ICP');
    expect(label).toContain('SideShift');
  });

  test('picked cefi group: venue quote verbatim, derived IC payout address, no slippage axis', async () => {
    jest.mocked(fetchSideShiftQuote).mockResolvedValue({venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});
    const tree = mount();
    mountWithCefiPicked(tree);
    await act(async () => {});
    // The settle figure is the venue's own number, verbatim (V8): 0.0495 ICP raw = 4950000.
    expect(present(tree, 'convert-headline').length).toBeGreaterThan(0);
    expect(textOf(present(tree, 'convert-headline')[0])).toContain('0.0495');
    expect(textOf(present(tree, 'convert-quote-source')[0])).toContain('SideShift');
    // The payout target is the wallet's OWN derived IC principal (DpayCore, never typed).
    expect(textOf(present(tree, 'convert-settle-address')[0])).toContain('myprinc-ipay');
    // A locked-rate order has NO slippage axis and NO floor line (the IC cefi rule).
    expect(present(tree, 'convert-slippage').length).toBe(0);
    expect(present(tree, 'convert-min-out').length).toBe(0);
  });

  test('confirm locks the ORDER: payout at the derived principal, handoff names the venue deposit', async () => {
    jest.mocked(fetchSideShiftQuote).mockResolvedValue({venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});
    jest.mocked(createSideShiftFixedShift).mockResolvedValue(ORDER);
    const tree = mount();
    mountWithCefiPicked(tree);
    await act(async () => {});
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    // The order was created with the user's own derived settle address, and the
    // deposit-rail refund address: the wallet's OWN Solana address (the venue returns
    // the funds THERE on a failed deposit or expiry — the fund-loss guard).
    expect(createSideShiftFixedShift).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createSideShiftFixedShift).mock.calls[0][2]).toMatchObject({
      quoteId: 'q1',
      settleAddress: 'myprinc-ipay',
      refundAddress: deriveSolanaAddress(IDENTITY.secretHex),
    });
    // Nothing signed, nothing adopted beyond the watch record.
    expect(adoptConvertRecord).toHaveBeenCalledTimes(1);
    const rec = jest.mocked(adoptConvertRecord).mock.calls[0][0];
    expect(rec.step).toBe('awaiting_deposit');
    expect(rec.legs.length).toBe(0);
    expect(rec.providerRef?.orderId).toBe('shift-sol-e2e-1');
    expect(rec.inCurrency).toBeUndefined();
    // The generic StatePanel renders the handoff: the VENUE's deposit address verbatim, the
    // exact amount, and the SOL-side network-fee note.
    expect(present(tree, 'convert-awaiting-deposit').length).toBeGreaterThan(0);
    expect(textOf(present(tree, 'convert-deposit-address')[0])).toContain('icp-deposit-address-e2e');
    expect(textOf(present(tree, 'convert-deposit-amount')[0])).toContain('1 EURC');
    expect(textOf(present(tree, 'convert-deposit-sol-fee-note')[0])).toContain('SOL');
  });

  test('ticking venue rate still confirms — the order locks the fresh figures (no re-review loop)', async () => {
    // Review 0.0495, confirm-time re-quote 0.0400: the exact-match gate the IC surface had
    // (defect 2) would dead-end here forever; the order is the lock and the consent point.
    jest.mocked(fetchSideShiftQuote)
      .mockResolvedValueOnce({venueId: 'sideshift-eurc', quoteId: 'q-review', settleAmount: '0.0495', rate: null, fetchedAtMs: Date.now()})
      .mockResolvedValueOnce({venueId: 'sideshift-eurc', quoteId: 'q-confirm', settleAmount: '0.0400', rate: null, fetchedAtMs: Date.now()});
    jest.mocked(createSideShiftFixedShift).mockResolvedValue({...ORDER, settleAmount: '0.0400'});
    const tree = mount();
    mountWithCefiPicked(tree);
    await act(async () => {});
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(fetchSideShiftQuote).toHaveBeenCalledTimes(2);
    expect(createSideShiftFixedShift).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createSideShiftFixedShift).mock.calls[0][2]).toMatchObject({
      quoteId: 'q-confirm',
      settleAddress: 'myprinc-ipay',
      refundAddress: deriveSolanaAddress(IDENTITY.secretHex),
    });
    const rec = jest.mocked(adoptConvertRecord).mock.calls[0][0];
    expect(rec.expectedNet).toBe('4000000'); // 0.0400 ICP raw (8 decimals), the ORDER's own locked figure
    expect(present(tree, 'convert-awaiting-deposit').length).toBeGreaterThan(0);
    expect(present(tree, 'convert-confirm-err').length).toBe(0);
  });

  test('a failed confirm-time re-quote fails closed with an error line, no order', async () => {
    jest.mocked(fetchSideShiftQuote)
      .mockResolvedValueOnce({venueId: 'sideshift-eurc', quoteId: 'q-review', settleAmount: '0.0495', rate: null, fetchedAtMs: Date.now()})
      .mockRejectedValueOnce('unreachable');
    const tree = mount();
    mountWithCefiPicked(tree);
    await act(async () => {});
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(createSideShiftFixedShift).not.toHaveBeenCalled();
    expect(present(tree, 'convert-confirm-err').length).toBeGreaterThan(0);
    expect(adoptConvertRecord).not.toHaveBeenCalled();
  });
});
