/**
 * The CeFi confirm gate — regression for the exact-match livelock (live-sweep defect 2,
 * 2026-09-20). The confirm's re-quote exists only to mint a FRESH quoteId for the fixed
 * order; the venue's rate LOCKS at order creation, so demanding exact settle equality
 * between the review quote and the confirm-time re-quote could never pass against a live
 * ticking venue (review → moved → review → moved …). The pin: a ticking rate must still
 * CONFIRM — the order is created from the fresh quote and the record renders the ORDER's
 * own locked figures (the deposit handoff), never a re-review loop.
 *
 * Everything money-real here is REAL: the venue module is the bundled registry (the
 * sideshift rows are real), the quote fetcher / order creator are the real
 * services/sideshift wire shapes (mocked at the https boundary with a TICKING rate), and
 * fetchCeFiConvertQuote / prepareCeFiConvertRecord run the real app/convert.ts code — so
 * prepare's own red line (the order's depositAmount must equal the quoted deposit) is
 * exercised too. Only the engine boundary is stubbed.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('../services/sideshift', () => ({
  sideShiftStatusUrl: (orderId: string) => `https://sideshift.ai/api/v2/shifts/${orderId}`,
  SIDESHIFT_STATUS_BASE: 'https://sideshift.ai/api/v2',
  fetchSideShiftQuote: jest.fn(),
  createSideShiftFixedShift: jest.fn(),
}));
// The CeFi refund derivation — the user's OWN IC account identifier: the native core
// derives the principal from the device key, then its 64-hex account hash (the form the
// venue's ICP payout layer can actually deliver to; SideShift cannot pay principal-format
// addresses). Under jest the chain stubs to a named principal→identifier pair every
// IC-surface test can pin.
jest.mock('../services/native', () => ({
  DpayCore: {
    icpPrincipalFromPubkey: jest.fn(async () => 'my-ic-principal-refund'),
    icpAccountIdFromPrincipal: jest.fn(async (owner: string) =>
      owner === 'my-ic-principal-refund'
        ? 'cd'.repeat(32)
        : Promise.reject(new Error(`unexpected owner: ${owner}`))),
  },
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
// The real convert module EXCEPT the two things jest cannot run: staleness (fixed
// fetchedAtMs fixtures would spin the stale-refetch loop under real timers) and
// deriveConvertMath — the real one calls the NATIVE core (DpayCore.icpSwapMinOut) which
// does not exist under jest; the fake derives the same honest shape (1% floor) so the
// confirm gate reads the same fields. Everything CeFi-specific stays REAL.
jest.mock('../convert', () => {
  const actual = jest.requireActual('../convert') as Record<string, unknown>;
  return {
    ...actual,
    isQuoteStale: () => false,
    deriveConvertMath: (q: {amountIn: string; amountOutGross: string}, inFee: string, outFee: string, slippageBps: number) =>
      Promise.resolve({
        amountIn: q.amountIn,
        grossOut: q.amountOutGross,
        minOut: ((BigInt(q.amountOutGross) * 9900n) / 10000n).toString(),
        netOut: q.amountOutGross,
        inFee,
        outFee,
        slippageBps,
      }),
  };
});

import {ConvertMode} from '../components/ConvertMode';
import {fetchSideShiftQuote, createSideShiftFixedShift} from '../services/sideshift';
import {DpayCore} from '../services/native';
import {adoptConvertRecord} from '../convertResume';
import type {ConvertRecord} from '../convert';
import type {Identity} from '../lib/types';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {SideShiftQuoteResult, SideShiftFixedShift} from '../services/sideshift';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: false, solanaTokens: false});
const ICP_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 8)!;
const IDENTITY: Identity = {secretHex: 'aa'.repeat(32), publicHex: 'bb'.repeat(32), username: 'tester'};

/** The ticking venue: call 1 (the review quote) settles 0.0495 SOL; call 2 (the
 *  confirm-time re-quote) has TICKED to 0.0400 — a move far past any rounding dust, so
 *  the old exact-equality gate would have tripped here. */
const TICKED: SideShiftQuoteResult[] = [
  {venueId: 'sideshift', quoteId: 'q-review', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: 1_700_000_000_000},
  {venueId: 'sideshift', quoteId: 'q-confirm', settleAmount: '0.0400', rate: '0.0400', fetchedAtMs: 1_700_000_000_500},
];

const ORDER: SideShiftFixedShift = {
  id: 'shift-tick-1',
  depositAddress: 'ss-deposit-address-tick',
  depositMemo: null,
  depositAmount: '1',
  settleAmount: '0.0400',
  expiresAt: '2026-09-20T12:00:00.000Z',
};

const mountProps = {
  identity: IDENTITY,
  relayUrl: 'http://relay.test',
  catalog: CATALOG,
  selectedAsset: ICP_ASSET,
  assetBalances: {8: '200000000'} as Record<number, string>,
  onBack: () => undefined,
  onActivity: () => undefined,
  onShowDepositAddress: () => undefined,
};

const present = (tree: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance[] =>
  tree.root.findAll(n => n.props != null && n.props.testID === testID);
const exists = (tree: renderer.ReactTestRenderer, testID: string): boolean => present(tree, testID).length > 0;
const textOf = (tree: renderer.ReactTestRenderer, testID: string): string => {
  const node = present(tree, testID)[0];
  if (node == null) return '';
  const flat = (c: unknown): string =>
    Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
  return node.findAllByType(Text).map(n => flat(n.props.children)).join(' ');
};

async function mountWithSideshiftPicked(): Promise<renderer.ReactTestRenderer> {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ConvertMode {...mountProps} />);
  });
  // Pick the SOL destination's group (the CCTP→jupiter route to Solana — the SAME landing
  // spot the CeFi venue folds into, D4's merged group), then the venue's own mechanism row
  // — the same two gestures the e2e drives.
  await act(async () => {
    present(tree!, 'convert-dest-route-multihop:icpswap-ckusdc:2:cctp:jupiter')[0].props.onPress();
  });
  await act(async () => {
    present(tree!, 'convert-dest-mech-sideshift')[0].props.onPress();
  });
  return tree!;
}

describe('CeFi confirm vs a ticking venue rate', () => {
  beforeEach(() => {
    jest.mocked(fetchSideShiftQuote).mockReset();
    jest.mocked(createSideShiftFixedShift).mockReset();
    jest.mocked(adoptConvertRecord).mockReset().mockResolvedValue(undefined);
    let call = 0;
    jest.mocked(fetchSideShiftQuote).mockImplementation(async (_relayUrl, venue) => {
      const res = TICKED[Math.min(call, TICKED.length - 1)]!;
      call += 1;
      return {...res, venueId: venue.venue_id};
    });
    jest.mocked(createSideShiftFixedShift).mockImplementation(async (_relayUrl, venue, args) => {
      expect(args.quoteId).toBe('q-confirm'); // the order rides the FRESH quote id
      expect(args.settleAddress.length).toBeGreaterThan(0); // the user's own derived address
      // The user's own IC ACCOUNT IDENTIFIER — refunds land THERE (the venue's payout
      // layer cannot deliver to principal-format addresses; the hex form is emitted).
      expect(args.refundAddress).toBe('cd'.repeat(32));
      expect(jest.mocked(DpayCore.icpAccountIdFromPrincipal)).toHaveBeenCalledWith('my-ic-principal-refund', '');
      expect(args.depositLedger).toBe(CATALOG.find(c => c.currency === 8)!.ledger); // names the deposit rail for the relay's refund check
      return {...ORDER, id: `${ORDER.id}-${venue.venue_id}`};
    });
  });

  afterEach(() => {
    jest.mocked(fetchSideShiftQuote).mockReset();
    jest.mocked(createSideShiftFixedShift).mockReset();
  });

  test('a ticking rate still confirms: the order locks the fresh figures, no re-review loop', async () => {
    const tree = await mountWithSideshiftPicked();
    // Review quote (call 1): 1 ICP → 0.0495 SOL on the headline.
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(1);
    expect(exists(tree, 'convert-headline')).toBe(true);

    // Confirm (call 2, the TICK): the confirm must PROCEED — order created, record
    // adopted, deposit handoff rendered. The old exact-match gate dead-ended here
    // instead (quote-changed + return, forever).
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(2);
    expect(jest.mocked(createSideShiftFixedShift).mock.calls.length).toBe(1);
    expect(exists(tree, 'convert-awaiting-deposit')).toBe(true);
    // The handoff shows the ORDER's own figures, verbatim — the consent point.
    expect(textOf(tree, 'convert-deposit-address')).toContain('ss-deposit-address-tick');
    expect(textOf(tree, 'convert-deposit-amount')).toContain('1 ICP');
    // The record is the legless provider shape, expectedNet = the ORDER's locked settle.
    const rec = jest.mocked(adoptConvertRecord).mock.calls[0][0] as ConvertRecord;
    expect(rec.step).toBe('awaiting_deposit');
    expect(rec.legs.length).toBe(0);
    expect(rec.providerRef?.orderId).toContain('shift-tick-1');
    expect(rec.expectedNet).toBe('40000000'); // 0.0400 SOL at 9 decimals — the fresh lock
    // No re-review state anywhere: the form is gone, no quote-changed warn, no error.
    expect(exists(tree, 'btn-convert-confirm')).toBe(false);
    expect(exists(tree, 'convert-confirm-err')).toBe(false);
  });

  test('the pre-broadcast invariant: back at review (unmount before confirm) NO order exists, NOTHING is adopted', async () => {
    // C1 (2026-09-24): no record exists before the confirm tap. The review quote may have
    // been fetched, but the venue order — the ONE pre-broadcast side effect — is created
    // only AT the confirm gesture. Unmounting at review discards the in-memory state and
    // leaves nothing to clean up: no venue order, no record, no store write.
    const tree = await mountWithSideshiftPicked();
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(1); // the review quote
    await act(async () => {
      tree.unmount();
    });
    expect(jest.mocked(createSideShiftFixedShift).mock.calls.length).toBe(0);
    expect(jest.mocked(adoptConvertRecord).mock.calls.length).toBe(0);
  });

  test('a failed confirm-time re-quote still fails closed with an error line, no order', async () => {
    const tree = await mountWithSideshiftPicked();
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    jest.mocked(fetchSideShiftQuote).mockImplementationOnce(async () => {
      throw new Error('unreachable');
    });
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(exists(tree, 'convert-confirm-err')).toBe(true);
    expect(jest.mocked(createSideShiftFixedShift).mock.calls.length).toBe(0);
    expect(jest.mocked(adoptConvertRecord).mock.calls.length).toBe(0);
  });

  test('an order whose depositAmount is not the quoted deposit is refused by prepare', async () => {
    const tree = await mountWithSideshiftPicked();
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    // A venue echoing a DIFFERENT deposit than the user asked to trade — the phone-side
    // red line must refuse, and nothing is adopted.
    jest.mocked(createSideShiftFixedShift).mockImplementationOnce(async () => ({...ORDER, depositAmount: '2'}));
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(exists(tree, 'convert-confirm-err')).toBe(true);
    expect(jest.mocked(adoptConvertRecord).mock.calls.length).toBe(0);
  });
});
