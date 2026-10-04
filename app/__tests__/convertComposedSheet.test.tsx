/**
 * The sheet's COMPOSED consumption (2026-09-26, the 2-press fold): the ONE-consent press
 * on a composed IC→CeFi row.
 *
 *   the CTA press IS the one consent: the gesture re-quotes fresh (a moved IC quote re-arms
 *   the same button with the old/new inline note BEFORE the order exists — nothing created,
 *   nothing signed), then runs the ORDER-FIRST prepare and CONTINUES straight into the
 *   engine (the IC legs + the device-signed deposit transfer as the last leg) in the same
 *   press — no intermediate stop. The venue's deposit address is disclosed live on the
 *   Settlement Field tracker, which narrates order created → deposit address revealed →
 *   exact amount → signing → sent → payout watch → done/failed. (There is no
 *   prepared-but-unconsented record anymore, so the old "edit discards the review" pin is
 *   moot: the unmount guard before adoption is what keeps a dead gesture from adopting.)
 *
 * Everything money-real is REAL: the venue rows are the bundled registry (icpswap VCHF/ICP,
 * sideshift-eurc ICP/EURC), resolveSwapTargets + resolveConvertDestinations run for real,
 * prepareComposedConvertRecord runs for real, and the sheet's bundle fetcher is the shared
 * fetchComposedQuotes. Only the wire boundaries are mocked.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(),
    icpApproveArg: jest.fn(),
    icpDepositAndSwapArg: jest.fn(),
    icpTransferArg: jest.fn(),
    icpLegacyTransferArg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpPrincipalFromPubkey: jest.fn(),
    icpAccountIdFromPrincipal: jest.fn(),
    icpValidateIcrcAccount: jest.fn(),
    icpValidateAccountId: jest.fn(),
    icpDecodeSwapResult: jest.fn(),
    icpDecodeApproveResult: jest.fn(),
    icpDecodeTransferResult: jest.fn(),
    icpDecodeLegacyTransferResult: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({relayFetch: jest.fn(), fetchWithTimeout: jest.fn()}));
jest.mock('../services/sideshift', () => ({
  sideShiftStatusUrl: (o: string) => `https://sideshift.ai/api/v2/shifts/${o}`,
  SIDESHIFT_STATUS_BASE: 'https://sideshift.ai/api/v2',
  fetchSideShiftQuote: jest.fn(),
  createSideShiftFixedShift: jest.fn(),
}));
jest.mock('../convertResume', () => ({
  convertResumeSnapshot: jest.fn((): Record<string, unknown> => ({})),
  subscribeConvertRecords: jest.fn((cb: unknown) => {
    (globalThis as {__SHEET_TEST_EMIT?: unknown}).__SHEET_TEST_EMIT = cb;
    return () => undefined;
  }),
  adoptConvertRecord: jest.fn(async () => undefined),
  acknowledgeStuckRecord: jest.fn(async () => undefined),
  attachCctpBurnTx: jest.fn(),
  confirmCrossRailSolLeg: jest.fn(),
  declineCctpHandoff: jest.fn(),
}));
// Real convert module except staleness (fixed timestamps would spin the 1 s clock) and
// deriveConvertMath (the native core does not exist under jest; the fake derives the same
// 1% floor shape).
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
import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {relayFetch} from '../services/relay';
import {fetchSideShiftQuote, createSideShiftFixedShift} from '../services/sideshift';
import {adoptConvertRecord} from '../convertResume';
import {formatClock} from '../i18n/intl';
import type {ConvertRecord} from '../convert';
import type {Identity} from '../lib/types';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {SideShiftQuoteResult, SideShiftFixedShift} from '../services/sideshift';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
const VCHF_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 7)!;
const IDENTITY: Identity = {secretHex: 'aa'.repeat(32), publicHex: 'bb'.repeat(32), username: 'tester'};
const VCHF_LEDGER = CATALOG.find(c => c.currency === 7)!.ledger!;
const ICP_LEDGER = CATALOG.find(c => c.currency === 8)!.ledger!;
const POOL1 = '65mrh-fqaaa-aaaar-qapoa-cai'; // icpswap (VCHF/ICP)
const VENUE_DEPOSIT_ADDRESS = 'vnh5b-riaaa-aaaai-aqj7q-cai'; // an ICRC-1 text account

const fakeRes = (body: unknown, ok = true, status = 200): Response =>
  ({ok, status, json: async () => body} as unknown as Response);

/** The IC pool's own quote: amount_out = 0.9 × the REQUESTED amount (the pool answers the
 *  ask, so a re-quoted amount prices consistently). The sheet's math floors it 1%. */
const icQuoteRes = (path: string) => {
  const amountIn = new URL('http://x' + path).searchParams.get('amount_in') ?? '0';
  return fakeRes({
    venue_id: 'icpswap',
    pool: POOL1,
    token_in: VCHF_LEDGER,
    token_out: ICP_LEDGER,
    amount_in: amountIn,
    amount_out: ((BigInt(amountIn) * 9n) / 10n).toString(),
    zero_for_one: true,
    fee_millionths: 3000,
    fetched_at: 1_700_000_000_000,
  });
};

const CEFI_QUOTE: SideShiftQuoteResult = {
  venueId: 'sideshift-eurc', quoteId: 'q-comp', settleAmount: '0.88', rate: '0.88', fetchedAtMs: 1_700_000_001_000,
};
// depositAmount MUST equal the IC chain's floored deposit (prepare verifies by value).
const ORDER: SideShiftFixedShift = {
  id: 'shift-comp-1',
  depositAddress: VENUE_DEPOSIT_ADDRESS,
  depositMemo: null,
  depositAmount: '0.891',
  settleAmount: '0.88',
  expiresAt: '2026-09-26T23:59:00.000Z',
};

const mountProps = {
  identity: IDENTITY,
  relayUrl: 'http://relay.test',
  catalog: CATALOG,
  selectedAsset: VCHF_ASSET,
  assetBalances: {7: '200000000'} as Record<number, string>,
  visibleCurrencies: ['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL'] as const,
  currencyBalances: {},
  onBack: () => undefined,
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

const mountedTrees: renderer.ReactTestRenderer[] = [];
afterEach(async () => {
  const trees = mountedTrees.splice(0);
  for (const t of trees) {
    await act(async () => { t.unmount(); });
  }
});

/** Mount on VCHF, stand on the EUR twin (the standing target line since 72311ff — a stable
 *  source stands on its value twin, so there is no EUR chip to tap), type 1. */
async function mountComposedEur(): Promise<renderer.ReactTestRenderer> {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ConvertMode {...mountProps} />);
  });
  mountedTrees.push(tree!);
  await act(async () => {
    present(tree!, 'convert-amount')[0].props.onChangeText('');
  });
  // The standing target IS the EUR pair (the composed chain is its only row).
  expect(textOf(tree!, 'convert-target-line')).toContain('Euros');
  await act(async () => {
    present(tree!, 'convert-amount')[0].props.onChangeText('1');
  });
  await act(async () => {});
  return tree!;
}

describe('the composed one-press consent', () => {
  beforeEach(() => {
    jest.mocked(relayFetch).mockReset();
    jest.mocked(fetchSideShiftQuote).mockReset();
    jest.mocked(createSideShiftFixedShift).mockReset();
    jest.mocked(adoptConvertRecord).mockReset().mockResolvedValue(undefined);
    // The venue registry load fails → the bundled registry stands (its sideshift-eurc row
    // IS the composed walk's venue).
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) => {
      const p = String(path);
      if (p.includes('/api/v1/venues')) return fakeRes({venues: []}, false, 404);
      if (p.includes('/api/v1/swap_quote')) return icQuoteRes(p);
      throw new Error(`unexpected relay path: ${p}`);
    });
    // The venue echoes the amount it is asked to price: the order's depositAmount must
    // equal the IC chain's floored deposit (prepare verifies by decimal VALUE), so the
    // quote mock remembers the last asked figure and the order mock echoes it.
    let lastAskedDeposit = '0.891';
    jest.mocked(fetchSideShiftQuote).mockImplementation(async (_relayUrl, venue, _in, _out, depositAmount: unknown) => {
      lastAskedDeposit = String(depositAmount);
      return {...CEFI_QUOTE, venueId: venue.venue_id};
    });
    jest.mocked(createSideShiftFixedShift).mockImplementation(async (_relayUrl, venue, args) => {
      expect(args.quoteId).toBe('q-comp');
      expect(args.settleAddress.length).toBeGreaterThan(0);
      expect(args.refundAddress).toBe('cd'.repeat(32));
      return {...ORDER, depositAmount: lastAskedDeposit, id: `${ORDER.id}-${venue.venue_id}`};
    });
    jest.mocked(icStampExpiry).mockResolvedValue((1_800_000_000n * 1_000_000n).toString());
    // The core's own 1% floor — the same shape the mocked deriveConvertMath derives, so the
    // sheet's review bundle and prepare's order price the SAME deposit for the same quote.
    jest.mocked(DpayCore.icpSwapMinOut).mockImplementation(async (gross: string) =>
      ((BigInt(gross) * 9900n) / 10000n).toString());
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue('me-principal');
    jest.mocked(DpayCore.icpAccountIdFromPrincipal).mockResolvedValue('cd'.repeat(32));
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({owner: 'venue-owner-principal', subaccountHex: ''});
    jest.mocked(DpayCore.icpTransferArg).mockResolvedValue('deposit-arg');
    jest.mocked(DpayCore.icpApproveArg).mockResolvedValue('approve-arg');
    jest.mocked(DpayCore.icpDepositAndSwapArg).mockResolvedValue('swap-arg');
    jest.mocked(DpayCore.icpSignUpdate).mockImplementation(async (_secret, _canister, method: string) =>
      ({envelopeHex: `env-${method}`, requestIdHex: `req-${method}`}));
  });

  test('the ONE CTA press creates the order AND adopts it in the same gesture', async () => {
    const tree = await mountComposedEur();
    // The composed row is the pair's only row: the receive figure is the SETTLE venue's own
    // quote (0.9 ICP floored to 0.891, quoted 0.88 EUR), attributed to SideShift — the venue
    // + locked figure are disclosed BEFORE the tap.
    expect(textOf(tree, 'convert-receive')).toContain('0.88');
    // ONE merged quote line (the pair's only row → the plain attribution, no count):
    // venue + read instant, the SideShift attribution carried before the tap.
    expect(textOf(tree, 'convert-venue-auto')).toContain('SideShift');
    expect(textOf(tree, 'convert-venue-auto')).toMatch(/\d{1,2}:\d{2}/);
    expect(exists(tree, 'convert-quote-source')).toBe(false);
    // Nothing is adopted, no order exists.
    expect(jest.mocked(adoptConvertRecord).mock.calls.length).toBe(0);
    expect(jest.mocked(createSideShiftFixedShift).mock.calls.length).toBe(0);

    // THE PRESS — the one consent: the order is created ONCE and the record is adopted in
    // the SAME gesture (no intermediate stop, no second press). The screen floods to the
    // Settlement Field tracker; the retired intermediate review card never renders.
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(jest.mocked(createSideShiftFixedShift).mock.calls.length).toBe(1);
    expect(jest.mocked(adoptConvertRecord).mock.calls.length).toBe(1);
    expect(exists(tree, 'convert-composed-review')).toBe(false); // retired surface
    expect(exists(tree, 'btn-convert-confirm')).toBe(false); // the sheet is gone — no second press
    expect(exists(tree, 'convert-state')).toBe(true); // the Settlement Field tracker
    expect(exists(tree, 'convert-moved-note')).toBe(false); // the market held

    // The adopted record carries the signed legs + the venue's order facts, verbatim.
    const rec = jest.mocked(adoptConvertRecord).mock.calls[0][0] as ConvertRecord;
    expect(rec.step).toBe('approving');
    expect(rec.legs.length).toBe(3); // approve + swap + the deposit transfer
    expect(rec.legPlan?.map(l => l.kind)).toEqual(['approve', 'swap', 'deposit_transfer']);
    expect(rec.composedDeposit?.depositAddress).toBe(VENUE_DEPOSIT_ADDRESS);
    expect(rec.composedDeposit?.amountRaw).toBe('89100000');
    expect(rec.providerRef?.orderId).toContain('shift-comp-1');
  });

  test('the tracker keeps the venue order facts in Details while the IC legs run', async () => {
    const tree = await mountComposedEur();
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    // ONE ACTIVE LEG (2026-10-04 composed-truth fix): while the IC legs run, the NEXT
    // leg's pre-created order is NOT the body - the body narrates the active leg, and the
    // order facts (venue, locked figure, shift id, deposit address, window) live in the
    // Details disclosure, closed by default.
    expect(exists(tree, 'convert-composed-live')).toBe(false);
    expect(exists(tree, 'convert-composed-order')).toBe(false);
    await act(async () => {
      present(tree, 'convert-details')[0].props.onPress();
    });
    await act(async () => {});
    expect(exists(tree, 'convert-composed-order')).toBe(true);
    expect(textOf(tree, 'convert-composed-order')).toContain('SideShift');
    expect(textOf(tree, 'convert-composed-order')).toContain('0.88'); // the locked payout figure
    expect(textOf(tree, 'convert-composed-order-id')).toContain('shift-comp-1');
    expect(textOf(tree, 'convert-composed-order-at')).toContain('SideShift'); // attributed + timestamped
    expect(textOf(tree, 'convert-composed-deposit-amount')).toContain('0.891'); // the exact-amount gate's figure
    expect(textOf(tree, 'convert-composed-deposit-address')).toContain(VENUE_DEPOSIT_ADDRESS);
    // The deposit leg itself renders in the leg list, still pending.
    expect(textOf(tree, 'convert-leg-2')).toContain('SideShift');
  });

  test('a mid-route park renders the ACTIVE leg (the pool payout), never the queued order', async () => {
    // The founder's 2026-10-04 screen: leg 2 (swap) still watching its payout while the
    // leg-3 SideShift order sits pre-created. The body must be leg 2's truth - the pool
    // accepted, the ICP payout is the wait - with no order details, no dest-asset claim,
    // and no 'Payout pending' (that copy names a venue payout past the deposit).
    const tree = await mountComposedEur();
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    const adopted = jest.mocked(adoptConvertRecord).mock.calls[0][0] as ConvertRecord;
    const T0 = 1_800_000_001_000; // leg 0's (spent) envelope death
    const T1 = T0 + 5_400_000; // leg 1's - the ACTIVE leg's binding deadline (90 min later)
    const parked: ConvertRecord = {
      ...adopted,
      step: 'pending_withdrawal',
      legPlan: adopted.legPlan!.map((lp, i) => (
        i === 0 ? {...lp, state: 'confirmed' as const}
          : i === 1 ? {...lp, state: 'sent' as const}
            : {...lp, state: 'pending' as const})),
      legs: adopted.legs.map((l, i) => ({...l, expiresAtMs: i === 1 ? T1 : T0})),
    };
    await act(async () => {
      (globalThis as {__SHEET_TEST_EMIT?: (records: Record<string, ConvertRecord>) => void}).__SHEET_TEST_EMIT?.({[parked.id]: parked});
    });
    // The step header and the body name the SAME leg.
    expect(textOf(tree, 'convert-step')).toContain('Step 2 of 3');
    expect(exists(tree, 'convert-pending')).toBe(true);
    const body = textOf(tree, 'convert-pending');
    expect(body).toContain('ICP'); // the payout actually being watched
    expect(body).toContain('Pool accepted'); // the pool's own truth: input spent, payout owed
    expect(body).not.toContain('Payout pending');
    expect(body).not.toContain('EURC'); // the queued leg's asset never speaks
    expect(body).not.toContain('SideShift');
    expect(body).not.toContain('Shift'); // no raw shift id in the body
    // The pre-created order is out of the body entirely.
    expect(exists(tree, 'convert-composed-live')).toBe(false);
    expect(exists(tree, 'convert-composed-order')).toBe(false);
    // ONE EXPIRY: the ACTIVE leg's binding deadline, never leg 0's spent clock.
    expect(textOf(tree, 'convert-expiry')).toContain(formatClock(new Date(T1)));
    expect(textOf(tree, 'convert-expiry')).not.toContain(formatClock(new Date(T0)));
  });

  test('the cefi wait copy says the venue is waiting for the deposit - not holding it', async () => {
    // The venue's own status word while the deposit is in flight is 'waiting': the panel
    // may not claim the venue HOLDS the deposit (that state arrives with its own step).
    const tree = await mountComposedEur();
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    const adopted = jest.mocked(adoptConvertRecord).mock.calls[0][0] as ConvertRecord;
    const awaiting: ConvertRecord = {
      ...adopted,
      step: 'awaiting_deposit',
      legPlan: adopted.legPlan!.map(lp => ({...lp, state: 'confirmed' as const})),
      composedDeposit: {...adopted.composedDeposit!, sentTx: 'block-213'},
    };
    await act(async () => {
      (globalThis as {__SHEET_TEST_EMIT?: (records: Record<string, ConvertRecord>) => void}).__SHEET_TEST_EMIT?.({[awaiting.id]: awaiting});
    });
    expect(exists(tree, 'convert-awaiting-deposit')).toBe(true);
    const body = textOf(tree, 'convert-awaiting-deposit');
    expect(body).toContain('Waiting for deposit');
    expect(body).toContain('waits for its ICP deposit'); // the venue's honest state
    expect(body).not.toContain('Payout pending');
    expect(body).not.toContain('holds the deposit and is executing'); // that is provider_processing's truth
    expect(body).not.toContain('Still watching');
    // The cefi leg IS the active leg here: the order facts belong in the body now.
    expect(exists(tree, 'convert-composed-order')).toBe(true);
    expect(textOf(tree, 'convert-composed-order')).toContain('SideShift');
  });

  test('a moved IC quote at the gesture re-arms BEFORE the order exists (old/new inline)', async () => {
    // The Max prefill quotes its own amount (and never moves); the REVIEW fetch for '1'
    // sees 0.9× and every LATER fetch for '1' sees 0.85× — the market MOVED at the gesture:
    // the order must never be created, the note must show old then new, and the same
    // button re-arms.
    const seenAmounts = new Set<string>();
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) => {
      const p = String(path);
      if (p.includes('/api/v1/venues')) return fakeRes({venues: []}, false, 404);
      if (p.includes('/api/v1/swap_quote')) {
        const amountIn = new URL('http://x' + p).searchParams.get('amount_in') ?? '0';
        const factor = amountIn === '100000000' && seenAmounts.has(amountIn) ? 85n : 90n;
        seenAmounts.add(amountIn);
        return fakeRes({
          venue_id: 'icpswap', pool: POOL1, token_in: VCHF_LEDGER, token_out: ICP_LEDGER,
          amount_in: amountIn, amount_out: ((BigInt(amountIn) * factor) / 100n).toString(),
          zero_for_one: true, fee_millionths: 3000, fetched_at: 1_700_000_000_000,
        });
      }
      throw new Error(`unexpected relay path: ${p}`);
    });
    const tree = await mountComposedEur();
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(jest.mocked(createSideShiftFixedShift).mock.calls.length).toBe(0); // nothing created
    expect(jest.mocked(adoptConvertRecord).mock.calls.length).toBe(0); // nothing adopted
    expect(exists(tree, 'convert-composed-review')).toBe(false);
    expect(exists(tree, 'convert-moved-note')).toBe(true);
    expect(textOf(tree, 'convert-moved-note')).toContain('0.9');
    expect(textOf(tree, 'convert-moved-note')).toContain('0.85');
    // The same button is re-armed: the next press re-quotes — and now the venue holds still.
    // (This second press is the moved-quote exception to the 2-press grammar, not the old
    // review-card consent: the FIRST clean press adopts in one gesture.)
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(jest.mocked(createSideShiftFixedShift).mock.calls.length).toBe(1);
    expect(jest.mocked(adoptConvertRecord).mock.calls.length).toBe(1);
    expect(exists(tree, 'convert-state')).toBe(true);
    // The adopted record prices the MOVED market's floor (0.85 floored to 0.8415), shown
    // in the order's Details disclosure (the body carries the active leg only).
    const rec = jest.mocked(adoptConvertRecord).mock.calls[0][0] as ConvertRecord;
    expect(rec.composedDeposit?.amountRaw).toBe('84150000');
    await act(async () => {
      present(tree, 'convert-details')[0].props.onPress();
    });
    await act(async () => {});
    expect(textOf(tree, 'convert-composed-deposit-amount')).toContain('0.8415');
  });

  test('the tracker renders a deposit_refused failure: the venue, the in-wallet position, the exit', async () => {
    // Adopt a composed record through the ONE consent press, then fail it at the deposit
    // leg the way the engine's gate does and push the update through the engine's own
    // notification: the pinned screen floods to the failed-leg view, whose
    // depositRefusedBody copy names the venue and the in-wallet hub asset, with the leg
    // list frozen Refused.
    const tree = await mountComposedEur();
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(jest.mocked(adoptConvertRecord).mock.calls.length).toBe(1);
    const adopted = jest.mocked(adoptConvertRecord).mock.calls[0][0] as ConvertRecord;
    const failed: ConvertRecord = {
      ...adopted,
      step: 'failed_leg',
      failureCode: 'deposit_refused',
      failureDetail: 'the venue order expired before the deposit could be sent',
      legPlan: adopted.legPlan!.map((lp, i) => (i === 2 ? {...lp, state: 'failed' as const} : {...lp, state: 'confirmed' as const})),
    };
    await act(async () => {
      (globalThis as {__SHEET_TEST_EMIT?: (records: Record<string, ConvertRecord>) => void}).__SHEET_TEST_EMIT?.({[failed.id]: failed});
    });
    expect(exists(tree, 'convert-failed-leg')).toBe(true);
    const body = textOf(tree, 'convert-failed-leg');
    expect(body).toContain('SideShift');
    expect(body).toContain('ICP');
    expect(textOf(tree, 'convert-leg-2-state')).toContain('Refused');
  });
});
