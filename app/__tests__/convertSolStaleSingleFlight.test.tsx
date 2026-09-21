// The SOL surface's stale-refresh SINGLE-FLIGHT (2026-09-21): a stale quote must have at
// most ONE refresh in flight — the IC surface's exact guard. The missing check let the
// 1s interval fire a fresh quote fetch EVERY SECOND while the venue was slow or
// unreachable: up to 8 concurrent 8s-budget calls hammering the relay's partner-key
// proxy — the request storm behind the live attempt-#3 confirm livelock ("Could not
// reach SideShift" alternating with this refresh's own "Quote changed" banner).
//
// `isQuoteStale` is pinned TRUE for the whole file: the refresh path must be exercised
// deterministically, without waiting a real 30s staleness window or a real 1s tick
// (jest fake timers advance the interval; the sibling suite pins the opposite pin).
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

/** A quote fetch that never answers until `release()` — the slow/unreachable venue. */
function heldQuote(): {promise: Promise<{venueId: string; quoteId: string; settleAmount: string; rate: string; fetchedAtMs: number}>; release: () => void} {
  let release!: () => void;
  const promise = new Promise<{venueId: string; quoteId: string; settleAmount: string; rate: string; fetchedAtMs: number}>((res) => {
    release = () => res(quoteOf('q-held'));
  });
  return {promise, release};
}

describe('SOL stale refresh is single-flight (the IC guard, both rails)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a stale quote holds ONE refresh in flight — no 1s stampede against the venue', async () => {
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
    // The review quote is in (exactly one fetch so far) and the stale interval is armed.
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(1);

    // The venue stops answering: every refresh from here is held in flight.
    const held = heldQuote();
    jest.mocked(fetchSideShiftQuote).mockImplementation(() => held.promise);

    // One tick: exactly ONE refresh starts. Three more seconds: STILL one — the 1s
    // interval kept ticking but the single-flight guard refused every pass. (The defect
    // this pins: the unguarded effect reached FOUR+ concurrent fetches here.)
    await act(() => { jest.advanceTimersByTime(1100); });
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(2);
    await act(() => { jest.advanceTimersByTime(3000); });
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(2);

    // The venue answers: the refresh settles and the guard RELEASES — the next tick may
    // start exactly one more, held again: still one in flight, never a second.
    await act(async () => { held.release(); });
    await act(async () => {});
    const held2 = heldQuote();
    jest.mocked(fetchSideShiftQuote).mockImplementation(() => held2.promise);
    await act(() => { jest.advanceTimersByTime(1100); });
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(3);
    await act(() => { jest.advanceTimersByTime(3000); });
    expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBe(3);
    await act(async () => { tree.unmount(); });
  });
});
