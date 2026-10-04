/**
 * The SOL source's TARGET-CURRENCY picker (the 2026-09-24 swap screen — successor of the old
 * out-destination picker). The grammar is currency-level now: the SOL source's targets are
 * CURRENCIES (USD via jupiter, EUR via jupiter-eurc, ICP via the CeFi venues), the standing
 * target follows REGISTRY order (the row-0 venue's other side), and a rail-local mint is
 * never named — the surface speaks currencies, the venue rows speak execution.
 *
 * The pins below:
 *   * SOL input: the standing target is USD (jupiter's other side, registry row 0) and the
 *     single solamm row arms without a pick — the one-venue attributed line.
 *   * Switching target re-quotes against the PICKED target's venue pair and RESETS the quote
 *     (the old pair's digits never render under the new heading); the typed amount stays.
 *   * USDC input (USD on the SOL rail): its own currency is excluded, so the standing target
 *     is EUR via jupiter-usdc-eurc — the SOL self-pair no longer exists as a "destination".
 *   * EURC input: standing SOL via jupiter-eurc, USD second via jupiter-usdc-eurc.
 *   * A confirm failure's error line belongs to its pair — picking another target clears
 *     it — and the target picker is frozen while a confirm is in flight.
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

jest.mock('../services/native', () => ({
  DpayCore: {
    icpPrincipalFromPubkey: jest.fn(async () => 'test-principal-text'),
    icpAccountIdFromPrincipal: jest.fn(async () => 'test-account-id-text'),
  },
}));

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
  visibleCurrencies: ['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL'] as const,
  currencyBalances: {},
  onBack: () => undefined,
  onShowDepositAddress: () => undefined,
  solana: {sol: '5000000000', tokens: {} as Record<string, string | null>},
});

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
const lastQuoteCall = (): {venueId: string; inputMint: string; outputMint: string; amount: string} => {
  const calls = jest.mocked(fetchJupiterQuote).mock.calls;
  const [_relayUrl, venue, inputMint, outputMint, amount] = calls[calls.length - 1];
  return {venueId: venue.venue_id, inputMint, outputMint, amount};
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

/** Mount + flush the mount-time quote effect (if any). */
async function mount(asset: SelectableAsset): Promise<renderer.ReactTestRenderer> {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ConvertMode {...mountProps(asset)} />);
  });
  mountedTrees.push(tree!);
  return tree!;
}

describe('SOL source target-currency picker (the intent sheet)', () => {
  /** The ONE-chip gesture every switch takes (the sheet pre-computes; changing the target
   *  stays optional). Flushes the re-keyed quote effect before returning. */
  const pickTarget = async (tree: renderer.ReactTestRenderer, code: string): Promise<void> => {
    await act(async () => {
      present(tree, `convert-target-chip-${code}`)[0].props.onPress();
    });
    await act(async () => {});
  };
  /** The standing target has NO chip (it IS the line) and names itself in the heading. */
  const standing = (tree: renderer.ReactTestRenderer, code: string): boolean =>
    !exists(tree, `convert-target-chip-${code}`) && textOf(tree, 'convert-screen').includes(`\u2192 ${code}`);
  /** Mount + flush the sheet's own mount-time work (the Max prefill re-keys the quote fetch). */
  const mountFlushed = async (asset: SelectableAsset): Promise<renderer.ReactTestRenderer> => {
    const tree = await mount(asset);
    await act(async () => {});
    return tree;
  };

  test('SOL input: the standing target is USD (registry row 0); the sheet pre-fills Max and arms tap 2', async () => {
    const tree = await mountFlushed(SOL_ASSET);
    expect(exists(tree, 'convert-unavailable')).toBe(false);
    // The chips carry every OTHER reachable currency; USD IS the standing line.
    expect(standing(tree, 'USD')).toBe(true);
    for (const code of ['EUR', 'ICP']) {
      expect(exists(tree, `convert-target-chip-${code}`)).toBe(true);
    }
    // Pre-computed: the amount is pre-filled to the full spendable balance (a SOL-side route
    // carries no input-fee overhead) and the standing pair is ALREADY quoted on open.
    expect(present(tree, 'convert-amount')[0].props.value).toBe('5');
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter',
      inputMint: WRAPPED_SOL_MINT_ADDRESS,
      outputMint: USDC_MINT_ADDRESS,
      amount: '5000000000',
    });
    // The chain widening (2026-09-28) adds the IC-rail routes (via the cefi settle into
    // ICP) behind the rail-local venue: the expander exists, the AUTO pick is still the
    // single live venue (chain rows rank only when nothing device-signable is quoted
    // above them), and tap 2 arms.
    expect(exists(tree, 'btn-convert-venues-other')).toBe(true);
    // The merged attribution line renders inside Details (the copy law, spec 2026-10-04 §3).
    await act(async () => { present(tree, 'convert-details')[0].props.onPress(); });
    await act(async () => {});
    expect(textOf(tree, 'convert-venue-auto')).toContain('Jupiter'); // the merged attribution line
    expect(present(tree, 'btn-convert-confirm')[0].props.disabled).toBe(false);
    // Typing re-quotes at the typed amount.
    await act(async () => {
      present(tree, 'convert-amount')[0].props.onChangeText('1');
    });
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter',
      inputMint: WRAPPED_SOL_MINT_ADDRESS,
      outputMint: USDC_MINT_ADDRESS,
      amount: '1000000000',
    });
    expect(textOf(tree, 'convert-headline')).toContain('10.36 USDC');
  });

  test('switching target re-quotes the picked pair, keeps the amount, resets the quote', async () => {
    const tree = await mountFlushed(SOL_ASSET);
    expect(textOf(tree, 'convert-headline')).toContain('10.36 USDC'); // the mock digits are per-mint

    // Pick EUR: the amount SURVIVES (it is a SOURCE-unit figure), the fresh quote is asked
    // from the EUR venue's own pair, and the old pair's digits never render under the new one.
    await pickTarget(tree, 'EUR');
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter-eurc',
      inputMint: WRAPPED_SOL_MINT_ADDRESS,
      outputMint: EURC_MINT_ADDRESS,
      amount: '5000000000',
    });
    expect(standing(tree, 'EUR')).toBe(true);
    expect(textOf(tree, 'convert-screen')).toContain('Convert SOL \u2192 EUR');
    expect(textOf(tree, 'convert-headline')).toContain('84.12 EURC');
    expect(textOf(tree, 'convert-headline')).not.toContain('USDC');
    expect(present(tree, 'convert-amount')[0].props.value).toBe('5');
  });

  test('USDC input (USD on the SOL rail): the stable twin CHF is now the standing line (the chain route), EUR one chip away', async () => {
    const tree = await mount(USDC_ASSET);
    await act(async () => {});
    expect(exists(tree, 'convert-unavailable')).toBe(false);
    // The source's own currency is the line's other side of the walk: never offered as a chip.
    expect(exists(tree, 'convert-target-chip-USD')).toBe(false);
    // The chain widening (2026-09-28): the twin CHF resolves (via the cefi settle into ICP,
    // then the VCHF pool) — the founder's any-pair example opens as the standing line.
    expect(exists(tree, 'convert-target-chip-CHF')).toBe(false); // CHF IS the standing line
    expect(exists(tree, 'convert-target-chip-EUR')).toBe(true);
    expect(exists(tree, 'convert-target-chip-SOL')).toBe(true);
    expect(exists(tree, 'convert-target-chip-ICP')).toBe(true);
    expect(textOf(tree, 'convert-screen')).toContain('Convert USD \u2192 CHF');
    // An unread balance is not a zero and pre-fills nothing: typing makes the ask. The
    // standing pair is a CHAIN row — its cefi leg quotes only on the typed demand.
    expect(jest.mocked(fetchJupiterQuote).mock.calls.length).toBe(0);
    await pickTarget(tree, 'EUR');
    await act(async () => {
      present(tree, 'convert-amount')[0].props.onChangeText('1');
    });
    // The picked stable FX pair quotes the venue from the USDC mint.
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter-usdc-eurc',
      inputMint: USDC_MINT_ADDRESS,
      outputMint: EURC_MINT_ADDRESS,
      amount: '1000000',
    });
    expect(textOf(tree, 'convert-screen')).toContain('Convert USD \u2192 EUR');
    // Pick SOL: the volatile leg stays one chip away, quoted from the USDC mint.
    await pickTarget(tree, 'SOL');
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter',
      inputMint: USDC_MINT_ADDRESS,
      outputMint: WRAPPED_SOL_MINT_ADDRESS,
      amount: '1000000',
    });
    expect(textOf(tree, 'convert-screen')).toContain('Convert USD \u2192 SOL');
  });

  test('EURC input: standing USD via jupiter-usdc-eurc (stable-first), SOL second via jupiter-eurc', async () => {
    const tree = await mount(EURC_ASSET);
    await act(async () => {});
    expect(exists(tree, 'convert-unavailable')).toBe(false);
    expect(standing(tree, 'USD')).toBe(true);
    expect(exists(tree, 'convert-target-chip-SOL')).toBe(true);
    await act(async () => {
      present(tree, 'convert-amount')[0].props.onChangeText('1');
    });
    // The standing pair is the stable-first FX pair, quoted from the EURC mint.
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter-usdc-eurc',
      inputMint: EURC_MINT_ADDRESS,
      outputMint: USDC_MINT_ADDRESS,
      amount: '1000000',
    });
    expect(textOf(tree, 'convert-screen')).toContain('Convert EUR \u2192 USD');
    // Pick SOL: the volatile leg is one chip away, quoted from the EURC mint.
    await pickTarget(tree, 'SOL');
    expect(standing(tree, 'SOL')).toBe(true);
    expect(present(tree, 'convert-amount')[0].props.value).toBe('1');
    expect(lastQuoteCall()).toEqual({
      venueId: 'jupiter-eurc',
      inputMint: EURC_MINT_ADDRESS,
      outputMint: WRAPPED_SOL_MINT_ADDRESS,
      amount: '1000000',
    });
    expect(textOf(tree, 'convert-screen')).toContain('Convert EUR \u2192 SOL');
  });

  test('a failed confirm leaves an error line that picking another target clears', async () => {
    const tree = await mount(SOL_ASSET);
    await act(async () => {});
    await act(async () => {
      present(tree, 'convert-amount')[0].props.onChangeText('1');
    });
    // The confirm gesture's re-quote fails: an error line renders under the USD pair.
    jest.mocked(fetchJupiterQuote).mockImplementationOnce(async () => ({ok: false as const, code: 'unreachable' as const, status: 503}));
    await act(async () => {
      present(tree, 'btn-convert-confirm')[0].props.onPress();
    });
    expect(exists(tree, 'convert-confirm-err')).toBe(true);

    // Picking EUR wipes the old pair's error with the old pair's quote.
    await pickTarget(tree, 'EUR');
    expect(exists(tree, 'convert-confirm-err')).toBe(false);
    expect(textOf(tree, 'convert-headline')).toContain('84.12 EURC');
  });

  test('the target chips are frozen while a confirm is in flight', async () => {
    const tree = await mount(SOL_ASSET);
    await act(async () => {});
    await act(async () => {
      present(tree, 'convert-amount')[0].props.onChangeText('1');
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

    // Mid-flight: the chip press is a no-op (the in-flight confirm closes over THIS pair,
    // and its late setQuote must never land under a newly picked pair's heading).
    await act(async () => {
      present(tree, 'convert-target-chip-EUR')[0].props.onPress();
    });
    expect(textOf(tree, 'convert-screen')).toContain('Convert SOL \u2192 USD');
    const calls = jest.mocked(fetchJupiterQuote).mock.calls;
    expect(calls[calls.length - 1][2]).toBe(WRAPPED_SOL_MINT_ADDRESS); // no EUR ask started

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
