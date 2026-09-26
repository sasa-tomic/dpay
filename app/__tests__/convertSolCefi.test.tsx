// The SOL-side CeFi surface (2026-09-20, live-sweep defect 1), on the 2026-09-24 swap screen's
// currency grammar: a registered cefi venue whose pair carries a SPL mint as the DEPOSIT side
// is offered as a VENUE ROW under its TARGET CURRENCY (ICP for sideshift-eurc) — the same row
// vocabulary the IC source sees in the other direction — with the venue's own quote figures,
// the user's own derived IC account identifier as the payout target, and the order as the
// lock. Founder rule: every currency through the SAME UI surfaces — per-rail divergence is a
// bug; per-rail EXECUTION shapes are not (the CeFi row's engine is unchanged).
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

// The settle address the venue pays out to: the wallet's IC ACCOUNT IDENTIFIER as 64-hex —
// the 32-byte account hash (SHA-224 of the principal blob with the empty subaccount), the
// same value `scripts/agent-key.mjs balance` prints as `account`. NOT the principal text:
// SideShift's ICP payout layer cannot send to principals (the 2026-09-20 `settling`-hours
// refund). Pinned derivation vector, exercised through the native binding below.
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
import {BUNDLED_VENUES, setRuntimeVenues} from '../config/venues';
import {deriveSolanaAddress} from '../solana/identity';
import {DpayCore} from '../services/native';
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


// Every mounted tree is unmounted in afterEach: the sheet arms its 1 s stale-quote clock on
// mount, so a tree left alive after its test would keep the interval armed and hang the whole
// file at exit (jest waits on the timer before the worker can die).
const mountedTrees: renderer.ReactTestRenderer[] = [];
afterEach(async () => {
  const trees = mountedTrees.splice(0);
  for (const t of trees) {
    await act(async () => { t.unmount(); });
  }
});

async function mount(): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <ConvertMode
        identity={IDENTITY}
        relayUrl="http://relay.test"
        catalog={CATALOG}
        selectedAsset={EURC_ASSET}
        assetBalances={{}}
        visibleCurrencies={['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL'] as const}
        currencyBalances={{}}
        solana={{sol: '5000000000', tokens: BALANCES}}
        onBack={() => undefined}
        onShowDepositAddress={() => undefined}
      />,
    );
  });
  mountedTrees.push(tree);
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

async function mountWithCefiPicked(tree: renderer.ReactTestRenderer): Promise<void> {
  // Pick the ICP target (the cefi venue's landing currency), then type the amount. ICP is
  // reached by ONE cefi row here — the sheet auto-picks it and pre-fills the amount, so the
  // walk CLEARS the prefill first and then types '1': exactly ONE review fetch, at the typed
  // amount, then the confirm's own re-quote. Awaited acts throughout: the pick re-keys the
  // quote effect and the cefi fetch must land before the assertions read.
  await act(async () => {
    present(tree, 'convert-amount')[0].props.onChangeText('');
  });
  await act(async () => {
    present(tree, 'convert-target-chip-ICP')[0].props.onPress();
  });
  await act(async () => {
    present(tree, 'convert-amount')[0].props.onChangeText('1');
  });
  await act(async () => {});
}

describe('SOL-side CeFi destination (sideshift-eurc)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('EURC screen offers ICP as a target whose venue row is the cefi service', async () => {
    jest.mocked(fetchSideShiftQuote).mockResolvedValue({venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});
    const tree = await mount();
    await act(async () => {});
    // The currency grammar: USD is the STANDING target (the sheet's own line), SOL and ICP
    // ride as sibling chips; the ICP target's single cefi row is auto-picked and its
    // attribution renders on the review card once quoted.
    expect(textOf(present(tree, 'convert-target-line')[0])).toContain('US dollars');
    for (const code of ['SOL', 'ICP']) {
      expect(present(tree, `convert-target-chip-${code}`).length).toBeGreaterThan(0);
    }
    await act(async () => {
      present(tree, 'convert-amount')[0].props.onChangeText('');
    });
    await act(async () => {
      present(tree, 'convert-target-chip-ICP')[0].props.onPress();
    });
    await act(async () => {
      present(tree, 'convert-amount')[0].props.onChangeText('1');
    });
    await act(async () => {});
    expect(present(tree, 'convert-quote-source').length).toBeGreaterThan(0);
    expect(textOf(present(tree, 'convert-quote-source')[0])).toContain('SideShift');
  });

  test('a relay-demoted (settlement-degraded) cefi row says so honestly: the slow line renders', async () => {
    jest.mocked(fetchSideShiftQuote).mockResolvedValue({venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});
    // The relay serves the degraded venue flagged and demoted to the tail; the overlay here
    // carries exactly that row — the app renders the honest slow line on it (2026-09-20 SLA gate).
    setRuntimeVenues(BUNDLED_VENUES.map(v => v.venue_id === 'sideshift-eurc'
      ? {...v, health: {status: 'degraded', settle_seconds: 7200, measured_at: 1758000000}}
      : v));
    const tree = await mount();
    await act(async () => {});
    // Walk to the ICP target: its single cefi row IS the standing pick, so the honesty line
    // renders on the review card itself — no second gesture needed.
    await act(async () => {
      present(tree, 'convert-target-chip-ICP')[0].props.onPress();
    });
    await act(async () => {});
    const slow = present(tree, 'convert-venue-sideshift-eurc-slow');
    expect(slow.length).toBeGreaterThan(0);
    expect(textOf(slow[0])).toContain('Recently slow to settle.');
    setRuntimeVenues(null);
  });

  test('a healthy (never-demoted) cefi row carries NO slow line — absence is never invented', async () => {
    jest.mocked(fetchSideShiftQuote).mockResolvedValue({venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});
    setRuntimeVenues(BUNDLED_VENUES);
    const tree = await mount();
    await act(async () => {});
    await act(async () => {
      present(tree, 'convert-target-chip-ICP')[0].props.onPress();
    });
    await act(async () => {});
    expect(present(tree, 'convert-venue-sideshift-eurc-slow').length).toBe(0);
    setRuntimeVenues(null);
  });

  test('picked cefi group: venue quote verbatim, derived IC payout address, no slippage axis', async () => {
    jest.mocked(fetchSideShiftQuote).mockResolvedValue({venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});
    const tree = await mount();
    await mountWithCefiPicked(tree);
    // The settle figure is the venue's own number, verbatim (V8): 0.0495 ICP raw = 4950000.
    expect(present(tree, 'convert-headline').length).toBeGreaterThan(0);
    expect(textOf(present(tree, 'convert-headline')[0])).toContain('0.0495');
    expect(textOf(present(tree, 'convert-quote-source')[0])).toContain('SideShift');
    // The payout target is the wallet's OWN derived IC account identifier (DpayCore,
    // never typed) — the pinned 64-hex vector, derived from the principal by the core;
    // the derivation chain's exact call shapes are pinned too.
    expect(textOf(present(tree, 'convert-settle-address')[0])).toContain(mockSettleAccountId);
    expect(jest.mocked(DpayCore.icpPrincipalFromPubkey)).toHaveBeenCalledWith(IDENTITY.publicHex);
    expect(jest.mocked(DpayCore.icpAccountIdFromPrincipal)).toHaveBeenCalledWith(mockIcPrincipal, '');
    // A locked-rate order has NO slippage axis and NO floor line (the IC cefi rule).
    expect(present(tree, 'convert-slippage').length).toBe(0);
    expect(present(tree, 'convert-min-out').length).toBe(0);
  });

  test('confirm locks the ORDER: payout at the derived account identifier, handoff names the venue deposit', async () => {
    jest.mocked(fetchSideShiftQuote).mockResolvedValue({venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});
    jest.mocked(createSideShiftFixedShift).mockResolvedValue(ORDER);
    const tree = await mount();
    await mountWithCefiPicked(tree);
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    // The derivation chain ran through the core: principal → the default-subaccount
    // account identifier (the 64-hex form the venue's payout layer requires).
    expect(DpayCore.icpAccountIdFromPrincipal).toHaveBeenCalledWith(mockIcPrincipal, '');
    // The order was created with the user's own derived settle address, and the
    // deposit-rail refund address: the wallet's OWN Solana address (the venue returns
    // the funds THERE on a failed deposit or expiry — the fund-loss guard).
    expect(createSideShiftFixedShift).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createSideShiftFixedShift).mock.calls[0][2]).toMatchObject({
      quoteId: 'q1',
      settleAddress: mockSettleAccountId,
      refundAddress: deriveSolanaAddress(IDENTITY.secretHex),
      depositLedger: EURC_MINT_ADDRESS,
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
    const tree = await mount();
    await mountWithCefiPicked(tree);
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(fetchSideShiftQuote).toHaveBeenCalledTimes(2);
    expect(createSideShiftFixedShift).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createSideShiftFixedShift).mock.calls[0][2]).toMatchObject({
      quoteId: 'q-confirm',
      settleAddress: mockSettleAccountId,
      refundAddress: deriveSolanaAddress(IDENTITY.secretHex),
      depositLedger: EURC_MINT_ADDRESS,
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
    const tree = await mount();
    await mountWithCefiPicked(tree);
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(createSideShiftFixedShift).not.toHaveBeenCalled();
    expect(present(tree, 'convert-confirm-err').length).toBeGreaterThan(0);
    expect(adoptConvertRecord).not.toHaveBeenCalled();
  });

  test('a SLOW venue answer still lands the order — the confirm budget covers the relay (attempt-#3 replay)', async () => {
    // The live 2026-09-21 attempt-#3 signature: the venue answered the RELAY inside its
    // 15s upstream budget, but the phone's confirm fetches rode an 8s budget — the client
    // aborted mid-round-trip, so the one shifts/fixed 201 that DID land was never adopted
    // (no awaiting-deposit panel, the deposit handoff never began). The fix is the 20s
    // confirm budget (CONVERT_CEFI_CONFIRM_TIMEOUT_MS > the relay's 15s): a slow-but-
    // successful quote AND a slow-but-successful order must both complete to the panel.
    const slow = <T,>(v: T): Promise<T> => new Promise((res) => setTimeout(() => res(v), 80));
    jest.mocked(fetchSideShiftQuote)
      .mockResolvedValueOnce({venueId: 'sideshift-eurc', quoteId: 'q-review', settleAmount: '0.0495', rate: null, fetchedAtMs: Date.now()})
      .mockImplementationOnce(() => slow({venueId: 'sideshift-eurc', quoteId: 'q-confirm', settleAmount: '0.0400', rate: null, fetchedAtMs: Date.now()}));
    jest.mocked(createSideShiftFixedShift).mockImplementationOnce(() => slow({...ORDER, settleAmount: '0.0400'}));
    const tree = await mount();
    await mountWithCefiPicked(tree);
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    // The confirm chain crosses two real 80ms timers (quote, then order) — wait until the
    // chain has fully settled (the record ADOPTED) before asserting anything.
    for (let i = 0; i < 50 && jest.mocked(adoptConvertRecord).mock.calls.length === 0; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    }
    await act(async () => {});
    // Both confirm-path calls carry the 20s budget, NOT the 8s review default — the pin
    // that keeps a client abort from orphaning a venue-side order ever again.
    expect(jest.mocked(fetchSideShiftQuote).mock.calls[1][5]).toBe(20000);
    expect(jest.mocked(createSideShiftFixedShift).mock.calls[0][3]).toBe(20000);
    expect(fetchSideShiftQuote).toHaveBeenCalledTimes(2);
    expect(createSideShiftFixedShift).toHaveBeenCalledTimes(1);
    // The venue's own locked figures adopted; the handoff panel renders; no error line.
    const rec = jest.mocked(adoptConvertRecord).mock.calls[0][0];
    expect(rec.step).toBe('awaiting_deposit');
    expect(rec.providerRef?.orderId).toBe('shift-sol-e2e-1');
    expect(rec.expectedNet).toBe('4000000');
    expect(present(tree, 'convert-awaiting-deposit').length).toBeGreaterThan(0);
    expect(textOf(present(tree, 'convert-deposit-address')[0])).toContain('icp-deposit-address-e2e');
    expect(present(tree, 'convert-confirm-err').length).toBe(0);
    // Drain BEFORE ending: an in-flight confirm chain that resolves inside the NEXT test
    // double-counts its mocks (the cross-test leak). Unmount detaches the effects.
    await act(async () => { tree.unmount(); });
  });

  test('a venue echo that reformats (not changes) the deposit amount still adopts the order', async () => {
    // prepareCeFiConvertRecord's red line compares decimal VALUES (sameDecimalAmount): the
    // venue echoing '1.00000000' for the quoted '1' must adopt the order it already
    // created — a spelling refusal would orphan a real venue-side order. A DIFFERENT
    // amount is still refused (the value line below flips the adoption off).
    jest.mocked(fetchSideShiftQuote).mockResolvedValue({venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0495', rate: '0.0495', fetchedAtMs: Date.now()});
    jest.mocked(createSideShiftFixedShift).mockResolvedValue({...ORDER, depositAmount: '1.00000000'});
    const tree = await mount();
    await mountWithCefiPicked(tree);
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    await act(async () => {});
    expect(adoptConvertRecord).toHaveBeenCalledTimes(1);
    expect(jest.mocked(adoptConvertRecord).mock.calls[0][0].providerDeposit?.depositAmount).toBe('1.00000000');
    expect(present(tree, 'convert-awaiting-deposit').length).toBeGreaterThan(0);
  });
});
