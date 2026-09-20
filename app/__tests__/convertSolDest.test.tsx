/**
 * The SOL convert surface's OUT-DESTINATION picker (spec 2026-09-16 §2 decision 5).
 *
 * `solanaAmmVenueForMint` assumed one venue per mint; with `jupiter-eurc` registered, SOL holds
 * TWO out options (USDC via `jupiter`, EURC via `jupiter-eurc`) and the first-match derivation
 * silently made EURC unreachable. The pins below:
 *
 *   * SOL input renders BOTH destination rows in registry order, with the FIRST venue (USDC)
 *     preselected — the exact pair the surface served before a second venue existed, so a
 *     one-venue mint behaves exactly as before.
 *   * Switching destination re-quotes against the PICKED venue's pair and RESETS the quote
 *     (the old pair's digits never render under the new heading); the typed amount stays.
 *   * USDC and EURC inputs hold TWO destinations since jupiter-usdc-eurc (2026-09-19):
 *     their SOL-pair venue first (registry order, still the default) + the rail-local
 *     USDC↔EURC venue second.
 *   * A confirm failure's error line belongs to its pair — picking another destination clears
 *     it — and the picker is frozen while a confirm is in flight.
 *   * A mint no venue serves still fails closed on the unavailable panel.
 *
 * The venue module is REAL (the bundled registry's order IS the surface's order — that is the
 * thing being pinned); only the https Jupiter client is mocked, with per-pair digits so a
 * mis-paired quote is visible in the rendered numbers.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('../convert', () => ({
  isQuoteStale: () => false,
  isTerminalConvertStep: (step: string) =>
    ['done', 'failed_refunded', 'stuck', 'quote_expired', 'provider_refunded'].includes(step),
  TERMINAL_CONVERT_STEPS: new Set(['done', 'failed_refunded', 'stuck', 'quote_expired', 'provider_refunded']),
  convertRecordMinOut: jest.fn(async () => null),
  loadVenueRegistry: jest.fn(async () => []),
  fetchConvertQuote: jest.fn(),
  deriveConvertMath: jest.fn(),
  prepareConvertRecord: jest.fn(),
  prepareMultihopConvertRecord: jest.fn(),
  prepareCeFiConvertRecord: jest.fn(),
  prepareSolanaConvertRecord: jest.fn(),
  fetchCeFiConvertQuote: jest.fn(),
  fetchCctpBurnFee: jest.fn(),
  buildCctpHandoff: jest.fn(),
  ceFiQuoteFromResult: jest.fn(),
  ceFiServiceError: jest.fn(),
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
jest.mock('../services/jupiter', () => ({
  fetchJupiterQuote: jest.fn(),
  fetchJupiterSwapTx: jest.fn(),
}));

import {ConvertMode} from '../components/ConvertMode';
import {fetchJupiterQuote} from '../services/jupiter';
import type {JupiterQuote} from '../services/jupiter';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import type {Identity} from '../lib/types';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {EURC_MINT_ADDRESS, USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
const SOL_ASSET = ASSETS.find(a => a.protocol === 'solana' && a.symbol === 'SOL')!;
const USDC_ASSET = ASSETS.find(a => a.protocol === 'solana' && a.symbol === 'USDC')!;
const EURC_ASSET = ASSETS.find(a => a.protocol === 'solana' && a.symbol === 'EURC')!;
const IDENTITY: Identity = {secretHex: 'aa'.repeat(32), publicHex: 'bb'.repeat(32), username: 'tester'};

/** Per-pair quote digits: 1 SOL → 10.36 USDC / 84.12 EURC; 1 USDC → 0.0147 SOL. */
const OUT_BY_MINT: Record<string, {outAmount: string; otherAmountThreshold: string}> = {
  [USDC_MINT_ADDRESS]: {outAmount: '10360000', otherAmountThreshold: '10250000'},
  [EURC_MINT_ADDRESS]: {outAmount: '84120000', otherAmountThreshold: '83000000'},
  [WRAPPED_SOL_MINT_ADDRESS]: {outAmount: '14700000', otherAmountThreshold: '14500000'},
};
/** The jupiter-usdc-eurc digits, keyed by PAIR — both mints already carry their SOL-pair
 *  digits above, so per-output-mint alone would mis-serve this venue's quotes.
 *  1 USDC → 0.87 EURC (floor 0.855); 1 EURC → 1.149 USDC (floor 1.13). */
const OUT_BY_PAIR: Record<string, {outAmount: string; otherAmountThreshold: string}> = {
  [`${USDC_MINT_ADDRESS}>${EURC_MINT_ADDRESS}`]: {outAmount: '870000', otherAmountThreshold: '855000'},
  [`${EURC_MINT_ADDRESS}>${USDC_MINT_ADDRESS}`]: {outAmount: '1149000', otherAmountThreshold: '1130000'},
};

function quoteOf(venueId: string, inputMint: string, outputMint: string, amount: string): {ok: true; quote: JupiterQuote} {
  const digits = OUT_BY_PAIR[`${inputMint}>${outputMint}`] ?? OUT_BY_MINT[outputMint];
  return {
    ok: true,
    quote: {
      venueId,
      inputMint,
      outputMint,
      inAmount: amount,
      outAmount: digits.outAmount,
      otherAmountThreshold: digits.otherAmountThreshold,
      priceImpactPct: '0.003',
      slippageBps: 100,
      platformFeeBps: null,
      raw: {},
      fetchedAtMs: 1_700_000_000_000,
    },
  };
}

beforeEach(() => {
  jest.mocked(fetchJupiterQuote).mockReset();
  jest.mocked(fetchJupiterQuote).mockImplementation(async (_relayUrl, venue, inputMint, outputMint, amount) =>
    quoteOf(venue.venue_id, inputMint, outputMint, amount),
  );
});

afterEach(() => {
  jest.mocked(fetchJupiterQuote).mockReset();
});

const mountProps = (asset: SelectableAsset) => ({
  identity: IDENTITY,
  relayUrl: 'http://relay.test',
  catalog: CATALOG,
  selectedAsset: asset,
  assetBalances: {},
  onBack: () => undefined,
  onActivity: () => undefined,
  onShowDepositAddress: () => undefined,
  solana: {sol: '5000000000', tokens: {} as Record<string, string | null>},
});

const present = (tree: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance[] =>
  tree.root.findAll(n => n.props != null && n.props.testID === testID);
const exists = (tree: renderer.ReactTestRenderer, testID: string): boolean => present(tree, testID).length > 0;
const checked = (tree: renderer.ReactTestRenderer, testID: string): boolean | undefined => {
  const node = present(tree, testID)[0];
  return (node?.props.accessibilityState as {checked?: boolean} | undefined)?.checked;
};
const textOf = (tree: renderer.ReactTestRenderer, testID: string): string => {
  const node = present(tree, testID)[0];
  if (node == null) return '';
  const flat = (c: unknown): string =>
    Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
  return node.findAllByType(Text).map(n => flat(n.props.children)).join(' ');
};
const lastQuoteCall = (): {venueId: string; inputMint: string; outputMint: string; amount: string} => {
  const calls = jest.mocked(fetchJupiterQuote).mock.calls;
  const [_relayUrl, venue, inputMint, outputMint, amount] = calls[calls.length - 1];
  return {venueId: venue.venue_id, inputMint, outputMint, amount};
};
/** Mount + flush the mount-time quote effect (if any). */
async function mount(asset: SelectableAsset): Promise<renderer.ReactTestRenderer> {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ConvertMode {...mountProps(asset)} />);
  });
  return tree!;
}

describe('SOL convert out-destination picker', () => {
  test('SOL input: both destinations in registry order, first venue (USDC) is the default', async () => {
    const tree = await mount(SOL_ASSET);
    // The picker renders with BOTH rows; the heading already names the default pair.
    expect(exists(tree, 'convert-sol-dest')).toBe(true);
    expect(exists(tree, 'convert-sol-dest-sol-usdc')).toBe(true);
    expect(exists(tree, 'convert-sol-dest-sol-eurc')).toBe(true);
    expect(checked(tree, 'convert-sol-dest-sol-usdc')).toBe(true);
    expect(checked(tree, 'convert-sol-dest-sol-eurc')).toBe(false);
    expect(exists(tree, 'convert-unavailable')).toBe(false);
    // No amount typed → no venue ask yet. Typing asks the DEFAULT pair (the same pair the
    // surface served before a second venue existed).
    expect(jest.mocked(fetchJupiterQuote).mock.calls.length).toBe(0);
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter',
      inputMint: WRAPPED_SOL_MINT_ADDRESS,
      outputMint: USDC_MINT_ADDRESS,
      amount: '1000000000',
    });
    expect(textOf(tree, 'convert-headline')).toContain('10.36 USDC');
  });

  test('switching destination re-quotes the picked pair, resets the quote, keeps the amount', async () => {
    const tree = await mount(SOL_ASSET);
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    // USDC quote arrived under the default pair.
    expect(exists(tree, 'convert-headline')).toBe(true);
    expect(textOf(tree, 'convert-headline')).toContain('10.36 USDC');
    const heading = textOf(tree, 'convert-screen');
    expect(heading).toContain('Convert SOL to USDC');

    // Pick EURC: the OLD quote resets immediately (no stale USDC digits under the EURC pair),
    // the amount survives, and the fresh quote is asked from the EURC venue's own pair.
    const eurcChip = present(tree, 'convert-sol-dest-sol-eurc')[0];
    await act(async () => {
      eurcChip.props.onPress();
    });
    expect(checked(tree, 'convert-sol-dest-sol-usdc')).toBe(false);
    expect(checked(tree, 'convert-sol-dest-sol-eurc')).toBe(true);
    expect(present(tree, 'convert-amount')[0].props.value).toBe('1');
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter-eurc',
      inputMint: WRAPPED_SOL_MINT_ADDRESS,
      outputMint: EURC_MINT_ADDRESS,
      amount: '1000000000',
    });
    expect(textOf(tree, 'convert-screen')).toContain('Convert SOL to EURC');
    expect(textOf(tree, 'convert-headline')).toContain('84.12 EURC');
    expect(textOf(tree, 'convert-headline')).not.toContain('USDC');
  });

  test('USDC input: TWO destinations since jupiter-usdc-eurc — SOL first (default), EURC second', async () => {
    const tree = await mount(USDC_ASSET);
    // Registry order: the SOL-pair venue (jupiter) first and preselected — the one-venue
    // behavior is the default — then the rail-local FX venue's EURC row.
    expect(exists(tree, 'convert-sol-dest')).toBe(true);
    expect(exists(tree, 'convert-sol-dest-sol')).toBe(true);
    expect(exists(tree, 'convert-sol-dest-sol-eurc')).toBe(true);
    expect(checked(tree, 'convert-sol-dest-sol')).toBe(true);
    expect(checked(tree, 'convert-sol-dest-sol-eurc')).toBe(false);
    expect(exists(tree, 'convert-unavailable')).toBe(false);
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter',
      inputMint: USDC_MINT_ADDRESS,
      outputMint: WRAPPED_SOL_MINT_ADDRESS,
      amount: '1000000',
    });
    // Pick EURC: the FX venue's own pair, quoted from the USDC mint.
    const eurcChip = present(tree, 'convert-sol-dest-sol-eurc')[0];
    await act(async () => {
      eurcChip.props.onPress();
    });
    expect(checked(tree, 'convert-sol-dest-sol')).toBe(false);
    expect(checked(tree, 'convert-sol-dest-sol-eurc')).toBe(true);
    expect(present(tree, 'convert-amount')[0].props.value).toBe('1');
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter-usdc-eurc',
      inputMint: USDC_MINT_ADDRESS,
      outputMint: EURC_MINT_ADDRESS,
      amount: '1000000',
    });
    expect(textOf(tree, 'convert-screen')).toContain('Convert USDC to EURC');
    expect(textOf(tree, 'convert-headline')).toContain('0.87 EURC');
  });

  test('EURC input: TWO destinations — SOL first (default), USDC second via jupiter-usdc-eurc', async () => {
    const tree = await mount(EURC_ASSET);
    expect(exists(tree, 'convert-sol-dest')).toBe(true);
    expect(exists(tree, 'convert-sol-dest-sol')).toBe(true);
    expect(exists(tree, 'convert-sol-dest-sol-usdc')).toBe(true);
    expect(checked(tree, 'convert-sol-dest-sol')).toBe(true);
    expect(exists(tree, 'convert-unavailable')).toBe(false);
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter-eurc',
      inputMint: EURC_MINT_ADDRESS,
      outputMint: WRAPPED_SOL_MINT_ADDRESS,
      amount: '1000000',
    });
    // Pick USDC: the FX venue's own pair, quoted from the EURC mint.
    const usdcChip = present(tree, 'convert-sol-dest-sol-usdc')[0];
    await act(async () => {
      usdcChip.props.onPress();
    });
    expect(checked(tree, 'convert-sol-dest-sol')).toBe(false);
    expect(checked(tree, 'convert-sol-dest-sol-usdc')).toBe(true);
    expect(present(tree, 'convert-amount')[0].props.value).toBe('1');
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter-usdc-eurc',
      inputMint: EURC_MINT_ADDRESS,
      outputMint: USDC_MINT_ADDRESS,
      amount: '1000000',
    });
    expect(textOf(tree, 'convert-screen')).toContain('Convert EURC to USDC');
    expect(textOf(tree, 'convert-headline')).toContain('1.149 USDC');
  });

  test('a failed confirm leaves an error line that picking another destination clears', async () => {
    const tree = await mount(SOL_ASSET);
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    // The confirm gesture's re-quote fails: an error line renders under the USDC pair.
    jest.mocked(fetchJupiterQuote).mockImplementationOnce(async () => ({ok: false as const, code: 'unreachable' as const, status: 503}));
    const confirm = present(tree, 'btn-convert-confirm')[0];
    await act(async () => {
      confirm.props.onPress();
    });
    expect(exists(tree, 'convert-confirm-err')).toBe(true);

    // Picking EURC wipes the old pair's error with the old pair's quote.
    await act(async () => {
      present(tree, 'convert-sol-dest-sol-eurc')[0].props.onPress();
    });
    expect(exists(tree, 'convert-confirm-err')).toBe(false);
    expect(textOf(tree, 'convert-headline')).toContain('84.12 EURC');
  });

  test('the picker is frozen while a confirm is in flight', async () => {
    const tree = await mount(SOL_ASSET);
    const input = present(tree, 'convert-amount')[0];
    await act(async () => {
      input.props.onChangeText('1');
    });
    // A confirm whose re-quote never resolves pins confirmBusy for the gesture below.
    let release: (q: ReturnType<typeof quoteOf>) => void = () => undefined;
    jest.mocked(fetchJupiterQuote).mockImplementationOnce(async (...args: Parameters<typeof fetchJupiterQuote>) =>
      new Promise(resolve => {
        release = () => resolve(quoteOf(args[1].venue_id, args[2], args[3], args[4]));
      }),
    );
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });

    // Mid-flight: the EURC gesture is a no-op — the in-flight confirm closes over THIS pair,
    // and its late setQuote must never land under the newly picked pair's heading.
    await act(async () => {
      present(tree, 'convert-sol-dest-sol-eurc')[0].props.onPress();
    });
    expect(checked(tree, 'convert-sol-dest-sol-usdc')).toBe(true);
    expect(checked(tree, 'convert-sol-dest-sol-eurc')).toBe(false);

    await act(async () => {
      release(quoteOf('jupiter', WRAPPED_SOL_MINT_ADDRESS, USDC_MINT_ADDRESS, '1000000000'));
    });
    expect(textOf(tree, 'convert-headline')).toContain('10.36 USDC');
  });

  test('a mint no venue serves still fails closed on the unavailable panel', async () => {
    // Typed as the SOLANA arm directly: spreading the SelectableAsset union under a new id
    // widens the literal back to the whole union and tsc rejects the mount, so the source
    // asset is narrowed first.
    const fake: Extract<SelectableAsset, {protocol: 'solana'}> = {
      ...(SOL_ASSET as Extract<SelectableAsset, {protocol: 'solana'}>),
      id: 'solana:FAKE',
      symbol: 'FAKE',
      mint: '4Nd1mFakeMint11111111111111111111111111111',
    };
    const tree = await mount(fake);
    expect(exists(tree, 'convert-unavailable')).toBe(true);
    expect(exists(tree, 'convert-sol-dest')).toBe(false);
    expect(jest.mocked(fetchJupiterQuote).mock.calls.length).toBe(0);
  });
});
