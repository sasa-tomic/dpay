// The CeFi surface's ORGANIC-DEMAND rate discipline (2026-09-22 partner agreement, term 1):
// a venue rate is fetched when the conversion screen opens and re-fetched when the user
// CHANGES THE AMOUNT — never on a timer. This suite used to pin the stale-refresh
// SINGLE-FLIGHT guard (one refresh in flight, added 2026-09-21 after the unguarded 1s
// interval stamped the partner-key proxy during the live attempt-#3 livelock); the partner
// agreement supersedes it: the timed cefi refresh is GONE entirely, so there is nothing to
// single-flight — a stale CeFi quote simply stands until the user moves the amount or
// confirms (the confirm-time re-quote mints the order's own locked rate and stays the
// execution protection). The Jupiter leg keeps the timed refresh (its public quote API is
// not a partner surface) and its single-flight guard with it.
//
// `isQuoteStale` is pinned TRUE for the whole file: even PERPETUALLY STALE, the cefi quote
// must never re-fetch — the strongest form of the pin, deterministic under jest fake timers.
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

const mockIcPrincipal = 'vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae';
const mockSettleAccountId = '9fac39d1ffbd746a5a6e18ad812d053ef2fbebeacd28a4e236d3cca052692279';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpPrincipalFromPubkey: jest.fn(async () => mockIcPrincipal),
    icpAccountIdFromPrincipal: jest.fn(async () => mockSettleAccountId),
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
// Real convert module except staleness — pinned STALE here (see the file header).
jest.mock('../convert', () => {
  const actual = jest.requireActual('../convert') as Record<string, unknown>;
  return {...actual, isQuoteStale: () => true};
});

import {ConvertMode} from '../components/ConvertMode';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {EURC_MINT_ADDRESS} from '../solana/tokens';
import {fetchSideShiftQuote} from '../services/sideshift';

const IDENTITY = {secretHex: 'aa'.repeat(32), publicHex: 'bb'.repeat(32), username: 'tester'};
const CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
const EURC_ASSET = ASSETS.find(a => a.protocol === 'solana' && a.token === 'EURC') as SelectableAsset & {protocol: 'solana'};
const BALANCES = {[EURC_MINT_ADDRESS]: '2000000'};

const quoteOf = (id: string) => ({venueId: 'sideshift-eurc', quoteId: id, settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});

describe('CeFi quotes never refresh on a timer (organic-demand, partner agreement term 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a PERPETUALLY STALE cefi quote stands: no interval re-fetch, ever', async () => {
    jest.mocked(fetchSideShiftQuote).mockResolvedValue(quoteOf('q-review'));
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
    await act(async () => {});
    await act(async () => {
      tree.root.findAll(n => n.props != null && n.props.testID === 'convert-sol-dest-cefi-sideshift-eurc')[0].props.onPress();
      tree.root.findAll(n => n.props != null && n.props.testID === 'convert-amount')[0].props.onChangeText('1');
    });
    // The review quote is in — exactly one fetch, from opening the screen + typing the amount.
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(1);

    // The quote is pinned stale (see the header): the old build re-fetched here on a 1s
    // interval. The agreement forbids machine-generated demand: minutes of wall-clock ticks
    // and a slow venue answering later must produce NOTHING further.
    await act(() => { jest.advanceTimersByTime(1100); });
    await act(() => { jest.advanceTimersByTime(60_000); });
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(1);
    jest.mocked(fetchSideShiftQuote).mockResolvedValue(quoteOf('q-late'));
    await act(async () => { await Promise.resolve(); });
    await act(() => { jest.advanceTimersByTime(60_000); });
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(1);
    await act(async () => { tree.unmount(); });
  });
});
