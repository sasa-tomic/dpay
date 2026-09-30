/**
 * ConvertMode — the money-decision surface itself, as a user sees it.
 *
 * `convert.test.ts` pins the module (state machine, decoder, persistence); this suite pins the
 * SCREEN, and exists because a live drive of the production build on 2026-09-08 found five
 * defects that every green gate had missed (docs/specs/2026-09-08-conversion-hardening-plan.md
 * stream C). Each test below is one of them, so a repeat is RED before it is shipped:
 *
 *   * C1 — the unit was printed TWICE on every money line ("Balance: 0 ICP ICP"). `fmtAsset`
 *     already suffixes the unit, so the i18n templates must never re-append it. Pinned twice:
 *     once on the rendered screen, once directly on all four locale catalogs (a locale that
 *     re-appends is a bug that only shows up in that locale).
 *   * C2 — "Price impact: —" never resolved, then (2026-09-11, spec V8) the line itself was
 *     removed: the venues publish no impact figure, so none is displayed. The pin now asserts
 *     NO impact line renders at all — a re-introduced placeholder or number is RED.
 *   * C3 — "Re-quote and confirm" was enabled on a wallet holding nothing: a confirm that can
 *     only fail. It now fails closed with the fund-gate shape the Pay tab already uses, and the
 *     neighbouring case (an amount above the balance, fees included) fails closed too.
 *   * C4 — the slippage chips were three naked percentages with no label and no group name.
 *   * C5 — no hierarchy. The restructure is typographic, so the load-bearing assertion is that
 *     NOT ONE §5 disclosure line was dropped in the process (spec 2026-09-07 §5 lines are
 *     regulatory commitments) and that the headline states what the user actually receives.
 *
 * The venue module is mocked: this suite is about what the screen renders from a quote, never
 * about how the quote is fetched or signed.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('../convert', () => {
  const actual = jest.requireActual<typeof import('../convert')>('../convert');
  return {
    ...actual,
    isQuoteStale: () => false,
  isTerminalConvertStep: (step: string) =>
    ['done', 'failed_refunded', 'stuck', 'quote_expired', 'provider_refunded'].includes(step),
  TERMINAL_CONVERT_STEPS: new Set(['done', 'failed_refunded', 'stuck', 'quote_expired', 'provider_refunded']),
  convertAbortFlavor: jest.fn(() => 'clean'),
  // The gas-fund NEED derivation: the real arithmetic (fee + the engine's 20% headroom), so a
  // test asserting the card's numbers reads the same digits the engine freezes into the record.
  gasFundNeededWei: (feeWei: string) => ((BigInt(feeWei) * 120n) / 100n).toString(),
  convertRecordMinOut: jest.fn(async () => null),
  loadVenueRegistry: jest.fn(async () => []),
  fetchConvertQuote: jest.fn(),
  deriveConvertMath: jest.fn(),
  prepareConvertRecord: jest.fn(),
    prepareMultihopConvertRecord: jest.fn(),
    prepareHubConvertRecord: jest.fn(),
    fetchCctpBurnFee: jest.fn(async () => ({
      finalityThreshold: 1000,
      minimumFeeBps: 8n,
      forwardFeeSubunits: 282032n,
    })),
  };
});

// Circle's OWN published burn fee (the cross-fee census) + the destination wallet's ETH
// probe (the gas-fund offer's measured have): both are live-API reads, mockable per test.
jest.mock('../cctp', () => ({
  ...jest.requireActual<typeof import('../cctp')>('../cctp'),
  fetchCctpBurnFee: jest.fn(async () => ({
    finalityThreshold: 1000,
    minimumFeeBps: 8n,
    forwardFeeSubunits: 282032n,
  })),
  fetchEthBalance: jest.fn(async () => null),
}));

// The burn-side rail services (gas quote + ledger fee): the minter's live figure is part of
// the route census and its preflight, and must be mockable per test.
jest.mock('../services/rail', () => ({
  submitTransfer: jest.fn(),
  fetchGasFeeWei: jest.fn(),
  fetchLedgerFee: jest.fn(),
}));
jest.mock('../services/native', () => ({
  DpayCore: {
    icpPrincipalFromPubkey: jest.fn(async () => 'my-ic-principal'),
    icpAccountIdFromPrincipal: jest.fn(async () => 'cd'.repeat(32)),
  },
  DpayNfc: {},
  DpaySolNfc: {},
}));

// The engine (V6): the screen is a VIEW onto app/convertResume.ts — it reads the snapshot on
// mount, subscribes for updates, and hands freshly-prepared records to the engine. It no longer
// loads the store or runs the executor itself. `mockEngineSub` captures the subscription so a
// test can play the engine's notifications (the mock-variable prefix is jest's own escape hatch).
const mockEngineSub: {cb: ((rs: Record<string, unknown>) => void) | null} = {cb: null};
jest.mock('../convertResume', () => ({
  convertResumeSnapshot: jest.fn((): Record<string, unknown> => ({})),
  subscribeConvertRecords: jest.fn((cb: (rs: Record<string, unknown>) => void) => {
    mockEngineSub.cb = cb;
    return () => {
      mockEngineSub.cb = null;
    };
  }),
  adoptConvertRecord: jest.fn(async () => undefined),
  acknowledgeStuckRecord: jest.fn(async () => undefined),
  abortConvertRecord: jest.fn(async () => undefined),
  providerLastCheckedAtMs: jest.fn((): number | null => null),
}));

import {ConvertMode} from '../components/ConvertMode';
import {convertAbortFlavor, convertRecordMinOut, deriveConvertMath, fetchConvertQuote, prepareConvertRecord, prepareHubConvertRecord, prepareMultihopConvertRecord} from '../convert';
import {abortConvertRecord, acknowledgeStuckRecord, adoptConvertRecord, convertResumeSnapshot, providerLastCheckedAtMs} from '../convertResume';
import {fetchGasFeeWei, fetchLedgerFee} from '../services/rail';
import type {ConvertMath, ConvertQuote, ConvertRecord} from '../convert';
import {buildSelectableAssets} from '../config/assets';
import type {Identity} from '../lib/types';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {BUNDLED_VENUES, setRuntimeVenues, venueDisplayName, type VenueEntry} from '../config/venues';
import {convertEn} from '../i18n/domains/en/convert';
import {nonBreakingClock} from '../components/ConvertShared';
import {formatClock} from '../i18n/intl';
import {convertDe} from '../i18n/domains/de/convert';
import {convertEs} from '../i18n/domains/es/convert';
import {convertFr} from '../i18n/domains/fr/convert';
import {fmtAssetCompact} from '../lib/format';
import {deriveEvmAddress} from '../evm';
import {toChecksumAddress} from '../evm/identity';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
// The wallet's real asset list carries BOTH rails of every multi-rail currency — the swap
// pair walk resolves cross-rail rows (CCTP routes, CeFi venues) through the SOL-side rails.
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
const ICP_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 8)!;
const IDENTITY: Identity = {secretHex: 'aa'.repeat(32), publicHex: 'bb'.repeat(32), username: 'tester'};
// The device's OWN EVM address — the standing payout destination (founder directive
// 2026-09-30). Tests assert the sheet derives exactly this from the identity seed.
const OWN_EVM = toChecksumAddress(deriveEvmAddress(IDENTITY.secretHex));

const QUOTE: ConvertQuote = {
  venueId: 'icpswap',
  pool: '65mrh-fqaaa-aaaar-qapoa-cai',
  tokenInLedger: 'ryjl3-tyaaa-aaaaa-aaaba-cai',
  tokenOutLedger: 'ly36x-wiaaa-aaaai-aqj7q-cai',
  amountIn: '100000000',
  amountOutGross: '41194138',
  zeroForOne: true,
  feeMillionths: 3000, // the venue's own 0.30% tier, echoed by the relay off the pool's metadata
  fetchedAtMs: 1_700_000_000_000,
};
const MATH: ConvertMath = {
  amountIn: '100000000',
  grossOut: '41194138',
  minOut: '40782196',
  netOut: '41184138',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
};

/** Flatten every string this subtree renders (children can be arrays or nested Text). */
const textOf = (tree: renderer.ReactTestRenderer, testID: string): string => {
  const node = tree.root.findAll(n => n.props != null && n.props.testID === testID)[0];
  if (node == null) return '';
  const flat = (c: unknown): string =>
    Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
  return node.findAllByType(Text).map(n => flat(n.props.children)).join(' ');
};
const present = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAll(n => n.props != null && n.props.testID === testID).length > 0;
const node = (tree: renderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll(n => n.props != null && n.props.testID === testID)[0];
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
/** Open the ONE Details disclosure (10x-verbosity pass 2026-09-16): every test that pins a
 *  folded census line presses it first — collapsed is the default state for everyone. */
const openDetails = async (tree: renderer.ReactTestRenderer): Promise<void> => {
  await act(async () => {
    node(tree, 'convert-details')!.props.onPress();
  });
};

/** Mount the screen with a given ICP balance, then type `amount` and settle every async effect.
 *  The tree is registered for teardown in `afterEach`: ConvertMode arms a stale-quote interval, so
 *  a tree left mounted by a FAILING assertion would keep the timer alive and hang the whole file. */
let mounted: renderer.ReactTestRenderer | null = null;
async function mountConvert(
  balanceRaw: string,
  amount: string | null,
  over: Partial<React.ComponentProps<typeof ConvertMode>> = {},
): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <ConvertMode
        identity={IDENTITY}
        relayUrl="http://relay"
        catalog={CATALOG}
        visibleCurrencies={['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL'] as const}
        // The source currency's SUMMED view (fork #4): the balance line renders the currency
        // unit — for ICP the unit IS the token, so the display equals the per-rail formatter.
        currencyBalances={{ICP: {displayText: fmtAssetCompact(balanceRaw, 8, 'ICP'), status: balanceRaw !== '0' ? 'ok' : 'zero', failure: null}}}
        selectedAsset={ICP_ASSET}
        assetBalances={{8: balanceRaw}}
        onBack={jest.fn()}
        onShowDepositAddress={jest.fn()}
        {...over}
      />,
    );
  });
  if (amount != null) {
    const input = node(tree, 'convert-amount');
    if (input != null) {
      await act(async () => {
        input.props.onChangeText(amount);
      });
    }
  }
  mounted = tree;
  return tree;
}

afterEach(async () => {
  const tree = mounted;
  mounted = null;
  if (tree != null) await act(async () => { tree.unmount(); });
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(providerLastCheckedAtMs).mockReturnValue(null);
  jest.mocked(fetchConvertQuote).mockResolvedValue(QUOTE);
  jest.mocked(deriveConvertMath).mockResolvedValue(MATH);
  jest.mocked(fetchGasFeeWei).mockResolvedValue('78000000000000'); // the fake-IC minter's 78e12 wei
  jest.mocked(fetchLedgerFee).mockResolvedValue('2000000000000'); // ckETH ledger fee
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The suites below drive the TWO-TAP INTENT SHEET (design brief Part V, 2026-09-26): the
// screen pre-computes the target, the amount and the venue pick; tap 2 is the CTA. The
// superseded 2026-09-11 no-preselection chooser suites were rewritten for the auto pick with
// its compensating controls (mechanical pick, verbatim attribution, one-tap override, order
// stability in the Other-venues expander) — the founder directive and its flag recorded in
// docs/specs. The record-view suites (engine view, CeFi panel, decimals threading) carry over
// against the Settlement Field tracker and the untouched StatePanel.

describe('C1 — the unit is printed exactly once on every money line', () => {
  test('balance and minimum carry ONE unit on the sheet; the fee census folds behind Details', async () => {
    const tree = await mountConvert('250000000', '1');
    // The input leg's unit (ICP) and the output leg's (VCHF) each appear once per money line.
    expect(occurrences(textOf(tree, 'convert-balance'), 'ICP')).toBe(1);
    expect(occurrences(textOf(tree, 'convert-min-out'), 'VCHF')).toBe(1);
    // …and the amounts themselves are the compact formatter's strings (trailing zeros trimmed).
    expect(textOf(tree, 'convert-balance')).toContain('2.5 ICP');
    expect(textOf(tree, 'convert-min-out')).toContain('0.40782196 VCHF');
    // The fee census folds behind the ONE Details control; open it and the per-side fee
    // lines still carry exactly one unit each. The old net end-state line is GONE — the
    // receive figure IS the end state.
    expect(present(tree, 'convert-details')).toBe(true);
    expect(present(tree, 'convert-net')).toBe(false);
    expect(present(tree, 'convert-dpay-fee')).toBe(false);
    await openDetails(tree);
    expect(occurrences(textOf(tree, 'convert-in-fee'), 'ICP')).toBe(1);
    expect(occurrences(textOf(tree, 'convert-out-fee'), 'VCHF')).toBe(1);
    expect(textOf(tree, 'convert-in-fee')).toContain('0.0001 ICP');
    expect(textOf(tree, 'convert-out-fee')).toContain('0.0001 VCHF');
  });

  test('a zero balance reads "0 ICP", never "0 ICP ICP" (the shipped defect verbatim)', async () => {
    const tree = await mountConvert('0', null);
    expect(textOf(tree, 'convert-balance')).not.toContain('ICP ICP');
  });

  test('no locale re-appends a unit to an already-formatted amount', () => {
    for (const [locale, d] of Object.entries({en: convertEn, de: convertDe, es: convertEs, fr: convertFr})) {
      const lines = [
        d.balanceLine('9.99 ICP'),
        d.inputFeeLine('9.99 ICP'),
        d.approvingBody('9.99 ICP', '14:42'),
        d.outputFeeLine('9.99 VCHF'),
        d.composedOrderLine('ICPSwap', '9.99 VCHF'),
        d.atLeast('9.99 VCHF'),
        d.doneBody('9.99 VCHF'),
      ];
      for (const line of lines) {
        expect(`${locale}: ${line}`).not.toContain('undefined');
        expect(`${locale}: ${line}`.match(/9\.99 (ICP|VCHF)/g)).toHaveLength(1);
        // the amount is stated once and no bare unit trails it
        expect(`${locale}: ${line}`).not.toMatch(/9\.99 (ICP|VCHF) \1/);
      }
      // 'ICP' alone is not countable here — the venue's registry display name may CONTAIN a
      // unit token, and naming the counterparty is a §5 requirement. Count the FORMATTED
      // amounts instead: each must appear exactly once, with no bare unit trailing it.
      const signed = d.stuckSigned('9.99 ICP', '4.44 VCHF', 'ICPSwap');
      expect(occurrences(signed, '9.99 ICP')).toBe(1);
      expect(occurrences(signed, '4.44 VCHF')).toBe(1);
      expect(signed).not.toMatch(/9\.99 ICP ICP|4\.44 VCHF VCHF/);
    }
  });
});

describe('C2 — the venue publishes no price impact, and none is invented', () => {
  test('NO impact line renders: not a number, not a placeholder, nothing', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(present(tree, 'convert-impact')).toBe(false);
    const flat = (c: unknown): string =>
      Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
    const allText = tree.root.findAllByType(Text).map(n => flat(n.props.children)).join(' ');
    expect(allText).not.toContain('Price impact');
    expect(allText).not.toContain('impact');
  });
});

describe('C3 — a confirm that can only fail is refused before it is offered', () => {
  test('zero balance: no sheet, no confirm, and the next action is named', async () => {
    const tree = await mountConvert('0', null);
    expect(present(tree, 'convert-fund')).toBe(true);
    expect(present(tree, 'btn-convert-confirm')).toBe(false);
    expect(present(tree, 'convert-amount')).toBe(false);
    const gate = textOf(tree, 'convert-fund');
    expect(gate).toContain('ICP');
    expect(gate.toLowerCase()).toContain('receive');
  });

  test('the fund gate OFFERS the route it names, exactly as the Pay tab\'s gate does', async () => {
    const onShowDepositAddress = jest.fn();
    const tree = await mountConvert('0', null, {onShowDepositAddress});
    const btn = node(tree, 'convert-fund-go');
    expect(btn).not.toBeUndefined();
    expect(btn!.props.accessibilityRole).toBe('button');
    await act(async () => { btn!.props.onPress(); });
    expect(onShowDepositAddress).toHaveBeenCalledTimes(1);
  });

  test('the OTHER leg of the pair is named and offered when it holds something', async () => {
    const onSwitchAsset = jest.fn();
    const tree = await mountConvert('0', null, {assetBalances: {8: '0', 7: '120000000'}, onSwitchAsset});
    expect(present(tree, 'convert-fund-other')).toBe(true);
    const line = textOf(tree, 'convert-fund-other-holds');
    expect(line).toContain('1.2 VCHF');
    expect(line).toContain('ICP');
    await act(async () => { node(tree, 'btn-convert-fund-other')!.props.onPress(); });
    expect(onSwitchAsset).toHaveBeenCalledWith('ic:7');
  });

  test('a pair whose other leg is empty offers nothing — there is no account to point at', async () => {
    const tree = await mountConvert('0', null, {assetBalances: {8: '0', 7: '0'}, onSwitchAsset: jest.fn()});
    expect(present(tree, 'convert-fund')).toBe(true);
    expect(present(tree, 'convert-fund-other')).toBe(false);
  });

  test('a balance nobody has read is not a zero — nothing is offered on an unknown', async () => {
    const tree = await mountConvert('0', null, {assetBalances: {8: '0'}, onSwitchAsset: jest.fn()});
    expect(present(tree, 'convert-fund-other')).toBe(false);
  });

  test('while the selection is LOCKED the account is still named, only the button is withheld', async () => {
    const tree = await mountConvert('0', null, {assetBalances: {8: '0', 7: '120000000'}});
    expect(present(tree, 'convert-fund-other')).toBe(true);
    expect(present(tree, 'btn-convert-fund-other')).toBe(false);
  });

  test('an amount above the balance fails closed and names the shortfall', async () => {
    // 2 ICP requested against a 1 ICP balance.
    const tree = await mountConvert('100000000', '2');
    expect(present(tree, 'convert-insufficient')).toBe(true);
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
    const line = textOf(tree, 'convert-insufficient');
    expect(line).toContain('ICP');
    expect(line).toContain('2.0002 ICP'); // 2 ICP + the two ledger fees it also costs
    expect(line).toContain('1 ICP'); // the balance it is measured against
    expect(line).toContain(convertEn.smallerAmount); // the named way out (the presets do it)
  });

  test('the fee overhead is part of the check: exactly-the-balance is still refused', async () => {
    const tree = await mountConvert('100000000', '1');
    expect(present(tree, 'convert-insufficient')).toBe(true);
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
  });

  test('an affordable amount is confirmable', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(present(tree, 'convert-insufficient')).toBe(false);
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(false);
  });

  test('the sheet PRE-FILLS the amount: the full spendable balance net of the route fees', async () => {
    // 2.5 ICP minus the two ledger fees = 2.4998 ICP — the "convert what I have" default,
    // on screen before the user touches a thing (brief 5.2).
    const tree = await mountConvert('250000000', null);
    expect(node(tree, 'convert-amount')!.props.value).toBe('2.4998');
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(false);
    // The 25% preset is exactly a quarter of that figure.
    await act(async () => { node(tree, 'convert-preset-25')!.props.onPress(); });
    expect(node(tree, 'convert-amount')!.props.value).toBe('0.62495');
  });

  test('a typed amount wins over the prefill; the presets recompute from the balance', async () => {
    const tree = await mountConvert('250000000', null);
    await act(async () => { node(tree, 'convert-amount')!.props.onChangeText('1'); });
    expect(node(tree, 'convert-amount')!.props.value).toBe('1');
    await act(async () => { node(tree, 'convert-preset-max')!.props.onPress(); });
    expect(node(tree, 'convert-amount')!.props.value).toBe('2.4998');
  });
});

describe('C4 — slippage is a disclosed default inside Details, not a visible decision', () => {
  test('the 1% default renders in Details; the chip axis is gone', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(present(tree, 'convert-slippage-chips')).toBe(false);
    for (const bps of [50, 100, 300]) {
      expect(present(tree, `convert-bps-${bps}`)).toBe(false);
    }
    expect(textOf(tree, 'convert-min-out')).toContain(fmtAssetCompact(MATH.minOut, 8, 'VCHF')); // the floor
    await openDetails(tree);
    expect(textOf(tree, 'convert-slippage')).toContain(convertEn.slippageLabel);
    expect(textOf(tree, 'convert-slippage')).toContain('1%');
  });
});

describe('C5 — hierarchy, with every §5 disclosure kept', () => {
  test('the receive hero reads at standard display precision; the venue verbatim stays in Details', async () => {
    const tree = await mountConvert('250000000', '1');
    const headline = textOf(tree, 'convert-headline');
    // VCHF is currency-class: the hero reads like money (2 decimals), the one ≈ in the copy.
    // (The sell half has no row: the input above IS the sell figure, the CTA names the amount.)
    expect(headline).toContain(convertEn.youReceive('0.41 VCHF'));
    // The venue's verbatim figure is NOT lost — Details carries the quote's own GROSS
    // figure, unchanged, attributed (the net hero subtracts only the disclosed ledger fee).
    await openDetails(tree);
    expect(textOf(tree, 'convert-quote-verbatim')).toContain(convertEn.quoteVerbatim('ICPSwap', '0.41194138 VCHF'));
  });

  test('not one §5 census fact was dropped — the sheet carries them; the census folds behind Details', async () => {
    const tree = await mountConvert('250000000', '1');
    // On the open sheet: the decision facts — receive figure, the ONE merged quote line
    // (attribution + instant + pick count), floor, CTA. The net/dpay lines are GONE (below).
    for (const id of ['convert-min-out', 'convert-venue-auto', 'convert-receive']) {
      expect(`${id}: ${present(tree, id)}`).toBe(`${id}: true`);
    }
    expect(present(tree, 'convert-net')).toBe(false);
    expect(present(tree, 'convert-dpay-fee')).toBe(false);
    expect(present(tree, 'convert-impact')).toBe(false);
    // One tap opens the census: every folded §5 fact is still rendered.
    await openDetails(tree);
    for (const id of [
      'convert-slippage',
      'convert-counterparty', 'convert-rate', 'convert-pool-fee',
      'convert-in-fee', 'convert-out-fee', 'convert-venue-disclosure',
      'convert-refusal',
    ]) {
      expect(`${id}: ${present(tree, id)}`).toBe(`${id}: true`);
    }
    const cp = textOf(tree, 'convert-counterparty');
    expect(cp).toContain('ICPSwap');
    expect(cp).toContain('65mrh-fqaaa-aaaar-qapoa-cai');
    expect(cp).toContain('Your phone signs');
    expect(cp).not.toContain('not a licensed provider and not dpay');
  });

  test('the pick line is a MECHANICAL disclosure — it states the pick, never a "best" claim', async () => {
    const tree = await mountConvert('250000000', '1');
    const pickLine = textOf(tree, 'convert-venue-auto');
    expect(pickLine).toContain('ICPSwap'); // the executor, named
    expect(pickLine).toMatch(/\d{1,2}:\d{2}/); // the quote's read instant, on the same line
    expect(pickLine.toLowerCase()).not.toContain('best'); // the designed-out word, absent
    // ONE venue quotable → the plain attribution, no comparison that never happened.
    expect(pickLine).not.toContain('of 2 venues');
  });

  test('the displayed rate is EXACTLY the derivation of the venue\'s own reply digits', async () => {
    const tree = await mountConvert('250000000', '1');
    const scaled = (BigInt(QUOTE.amountOutGross) * 10n ** 8n) / BigInt(QUOTE.amountIn);
    const expected = fmtAssetCompact(scaled.toString(), 8, 'VCHF');
    expect(expected).toBe('0.41194138 VCHF');
    await openDetails(tree);
    expect(textOf(tree, 'convert-rate')).toContain(expected);
    expect(textOf(tree, 'convert-rate')).toContain(convertEn.rateLabel('ICP', 'VCHF'));
  });

  test('the single-venue disclosure renders from the registry key, exactly once', async () => {
    const tree = await mountConvert('250000000', '1');
    await openDetails(tree);
    const expected = convertEn.disclosures.byKey.icpswap('ICPSwap');
    expect(textOf(tree, 'convert-venue-disclosure').trim()).toBe(expected);
    expect(tree.root.findAllByType(Text).filter(n => n.props.testID === 'convert-venue-disclosure')).toHaveLength(1);
  });

  test('the pool principal is its own line, so it can never wrap mid-token', async () => {
    const tree = await mountConvert('250000000', '1');
    await openDetails(tree);
    const principals = tree.root.findAllByType(Text).filter(n => n.props.testID === 'convert-pool-principal');
    expect(principals).toHaveLength(1);
    expect(textOf(tree, 'convert-pool-principal').trim()).toBe('65mrh-fqaaa-aaaar-qapoa-cai');
  });

  test('the CTA names the amount ("Convert 1 ICP") and carries both testIDs of the migration', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(textOf(tree, 'convert-cta')).toBe(convertEn.ctaConvert('1 ICP'));
    // The legacy confirm testID lives on the Pressable itself (the alias the flows drive).
    expect(node(tree, 'btn-convert-confirm')!.props.accessibilityRole).toBe('button');
  });
});

// --- AUTO — the mechanical venue pick (supersedes the V5 no-preselection chooser) -------------
// The founder's 2026-09-26 directive: dpay picks the venue, mechanically, and discloses the
// pick as a fact ("Executed via X, highest quoted rate of N venues"). The compensating
// controls, pinned here: the pick FOLLOWS the highest net quoted output (and follows it again
// if the market moves before the user confirms); the quote is the venue's own attributed +
// timestamped number; the word "best" never appears; every other row sits behind the ONE
// Other-venues expander in REGISTRY order, each still one tap away.
describe('AUTO — the disclosed mechanical venue pick', () => {
  const VENUE_A = BUNDLED_VENUES.find(v => v.venue_id === 'icpswap')!;
  const FIXTURE_POOL = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7';
  const VENUE_B: VenueEntry = {
    venue_id: 'icpswap-fixture-b',
    display_name: 'ICPSwap (offline fixture)',
    kind: 'ic_amm',
    endpoint: FIXTURE_POOL,
    pair_ledgers: [QUOTE.tokenInLedger, QUOTE.tokenOutLedger],
    testnet: true,
    disclosure_key: 'icpswap',
  };
  const QUOTE_A = QUOTE;
  const QUOTE_B: ConvertQuote = {
    ...QUOTE,
    venueId: VENUE_B.venue_id,
    pool: FIXTURE_POOL,
    amountOutGross: '90000000', // B quotes BETTER than A — so the mechanical pick takes B
    feeMillionths: 1000,
  };
  const MATH_B: ConvertMath = {
    ...MATH,
    grossOut: '90000000',
    minOut: '89100000',
    netOut: '89990000',
  };
  /** The row testIDs in first-appearance order (RN mirrors testID onto wrapper layers). */
  const rowOrder = (tree: renderer.ReactTestRenderer): string[] => {
    const seen: string[] = [];
    for (const n of tree.root.findAll(
      (x: {props?: {testID?: unknown}}) =>
        x.props != null && (x.props.testID === `convert-venue-${VENUE_A.venue_id}` || x.props.testID === `convert-venue-${VENUE_B.venue_id}`),
    )) {
      const id = String(n.props.testID);
      if (!seen.includes(id)) seen.push(id);
    }
    return seen;
  };
  const openVenues = async (tree: renderer.ReactTestRenderer): Promise<void> => {
    await act(async () => {
      node(tree, 'btn-convert-venues-other')!.props.onPress();
    });
  };

  beforeEach(() => {
    setRuntimeVenues([VENUE_A, VENUE_B]);
    jest.mocked(fetchConvertQuote).mockImplementation((async (_r: string, _in: string, _out: string, _amt: string, opts?: {venue?: VenueEntry}) =>
      Promise.resolve(opts?.venue?.venue_id === VENUE_B.venue_id ? QUOTE_B : QUOTE_A) as never));
    jest.mocked(deriveConvertMath).mockImplementation((async (q: ConvertQuote) =>
      (q.venueId === VENUE_B.venue_id ? MATH_B : MATH) as never));
    jest.mocked(adoptConvertRecord).mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    setRuntimeVenues(null); // never leak the two-venue overlay into the other suites
    jest.mocked(convertResumeSnapshot).mockReturnValue({});
  });

  test('the pick FOLLOWS the highest net quoted output and says so — with the count', async () => {
    const tree = await mountConvert('250000000', '1');
    // ONE merged quote line: venue + read instant + the mechanical comparison count.
    expect(textOf(tree, 'convert-venue-auto')).toBe(convertEn.autoVenueLine(VENUE_B.display_name, nonBreakingClock(new Date(QUOTE_B.fetchedAtMs)), 2));
    // The hero figure is B's own number at the hero's standard display precision — the pick
    // never blends or recomputes; the venue's VERBATIM figure sits in Details, attributed.
    expect(textOf(tree, 'convert-receive')).toContain(convertEn.youReceive('0.89 VCHF'));
    await openDetails(tree);
    expect(textOf(tree, 'convert-quote-verbatim')).toContain(convertEn.quoteVerbatim(VENUE_B.display_name, fmtAssetCompact(QUOTE_B.amountOutGross, 8, 'VCHF')));
    // Armed at the pick: tap 2 exists without any further decision.
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(false);
  });

  test('every other row sits behind the ONE expander, verbatim in REGISTRY order', async () => {
    const tree = await mountConvert('250000000', '1');
    // Collapsed by default.
    expect(present(tree, 'convert-venues-expanded')).toBe(false);
    await openVenues(tree);
    expect(rowOrder(tree)).toEqual([`convert-venue-${VENUE_A.venue_id}`]);
    expect(textOf(tree, `convert-venue-${VENUE_A.venue_id}-quote`)).toContain('0.41194138 VCHF');
  });

  test('row order in the expander survives the quotes SWAPPING places (registry order is the identity)', async () => {
    jest.mocked(fetchConvertQuote).mockImplementation((async (_r: string, _in: string, _out: string, _amt: string, opts?: {venue?: VenueEntry}) =>
      Promise.resolve(opts?.venue?.venue_id === VENUE_B.venue_id
        ? {...QUOTE_B, amountOutGross: '20000000'}
        : {...QUOTE_A, amountOutGross: '90000000'}) as never));
    const tree = await mountConvert('250000000', '1');
    // Now A quotes strictly better — the PICK flips to A, mechanically…
    expect(textOf(tree, 'convert-venue-auto')).toBe(convertEn.autoVenueLine(VENUE_A.display_name, nonBreakingClock(new Date(QUOTE_A.fetchedAtMs)), 2));
    // …and the expander STILL lists the other row first-served, registry order, unchanged.
    await openVenues(tree);
    expect(rowOrder(tree)).toEqual([`convert-venue-${VENUE_B.venue_id}`]);
    expect(textOf(tree, `convert-venue-${VENUE_B.venue_id}-quote`)).toContain('0.2 VCHF');
  });

  test('an override is ONE tap: the attribution switches, the mechanical-pick line stands down', async () => {
    const tree = await mountConvert('250000000', '1');
    await openVenues(tree);
    await act(async () => {
      node(tree, `convert-venue-${VENUE_A.venue_id}`)!.props.onPress();
    });
    // The user's pick governs: A's own quote + floor + attribution on the card, no pick
    // criterion line (the mechanical disclosure describes the AUTO pick, not a user choice).
    expect(present(tree, 'convert-venue-auto')).toBe(false);
    expect(textOf(tree, 'convert-quote-source')).toBe(convertEn.quoteSource(nonBreakingClock(new Date(QUOTE_A.fetchedAtMs)), VENUE_A.display_name));
    expect(textOf(tree, 'convert-min-out')).toContain(fmtAssetCompact(MATH.minOut, 8, 'VCHF'));
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(false);
  });

  test('a relay-demoted (settlement-degraded) row keeps the honest slow line — on the card when picked, in the expander when not', async () => {
    setRuntimeVenues([VENUE_A, {...VENUE_B, health: {status: 'degraded', settle_seconds: 7200, measured_at: 1758000000}}]);
    const tree = await mountConvert('250000000', '1');
    // B still quotes better and the mechanical pick takes it — the slow line renders beside
    // the attribution, honestly naming what the relay measured (2026-09-20 SLA gate).
    expect(textOf(tree, `convert-venue-${VENUE_B.venue_id}-slow`)).toContain(convertEn.venueSlow);
    // Overriding to A moves the slow line into the expander's B row (verbatim registry row).
    await openVenues(tree);
    await act(async () => {
      node(tree, `convert-venue-${VENUE_A.venue_id}`)!.props.onPress();
    });
    // The expander is still open and now holds B — its row carries the same honesty line.
    expect(textOf(tree, `convert-venue-${VENUE_B.venue_id}-slow`)).toContain(convertEn.venueSlow);
  });

  test('a pair with ONE quotable venue discloses the single form — no comparison that never happened', async () => {
    setRuntimeVenues(null); // the bundled registry alone: exactly one quotable venue on the pair
    const tree = await mountConvert('250000000', '1');
    // ONE venue = the plain attribution on the merged line, no count that never happened.
    expect(textOf(tree, 'convert-venue-auto')).toBe(convertEn.quoteSource(nonBreakingClock(new Date(QUOTE_A.fetchedAtMs)), VENUE_A.display_name));
    // The pick is already armed: the common case is literally two taps.
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(false);
  });

  test('confirming at the pick signs THE PICK\'S venue (the record carries its venueId)', async () => {
    const rec: ConvertRecord = {
      id: 'rec-auto', createdAtMs: 0, step: 'approving', venueId: VENUE_B.venue_id,
      inCurrency: 8, outCurrency: 7,
      inLedger: QUOTE.tokenInLedger, outLedger: QUOTE.tokenOutLedger,
      inSymbol: 'ICP', outSymbol: 'VCHF',
      amountIn: '100000000', expectedGross: '90000000', expectedNet: '89990000',
      inFee: '10000', outFee: '10000', slippageBps: 100, legs: [],
    };
    jest.mocked(prepareConvertRecord).mockResolvedValue(rec as never);
    const tree = await mountConvert('250000000', '1');
    await act(async () => {
      node(tree, 'btn-convert-confirm')!.props.onPress();
    });
    expect(jest.mocked(prepareConvertRecord)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(adoptConvertRecord)).toHaveBeenCalledTimes(1);
    const adopted = jest.mocked(adoptConvertRecord).mock.calls[0][0] as ConvertRecord;
    expect(adopted.venueId).toBe(VENUE_B.venue_id);
    // The screen floods to the Settlement Field: the in-flight tracker with the signing copy.
    expect(present(tree, 'convert-state')).toBe(true);
    expect(present(tree, 'convert-inflight')).toBe(true);
    expect(textOf(tree, 'convert-inflight')).toContain(convertEn.signing);
  });
});

describe('V6 — engine view', () => {
  const FIXTURE_POOL = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7';
  const LEGS = [
    {
      canister: QUOTE.tokenInLedger,
      method: 'icrc2_approve',
      argHex: 'a',
      envelopeHex: 'aa',
      requestIdHex: 'r1',
      expiresAtMs: Date.now() + 600_000,
    },
    {
      canister: FIXTURE_POOL,
      method: 'depositFromAndSwap',
      argHex: 'b',
      envelopeHex: 'bb',
      requestIdHex: 'r2',
      expiresAtMs: Date.now() + 600_000,
    },
  ];
  const liveRecord: ConvertRecord = {
    id: 'view-live',
    createdAtMs: 5,
    step: 'approving',
    venueId: 'icpswap-fixture-b',
    inCurrency: 8,
    outCurrency: 7,
    inLedger: QUOTE.tokenInLedger,
    outLedger: QUOTE.tokenOutLedger,
    inSymbol: 'ICP',
    outSymbol: 'VCHF',
    amountIn: '100000000',
    expectedGross: '90000000',
    expectedNet: '89990000',
    inFee: '10000',
    outFee: '10000',
    slippageBps: 100,
    legs: LEGS,
  };
  const stuckRecord: ConvertRecord = {
    ...liveRecord,
    id: 'view-stuck',
    step: 'stuck',
    failureCode: 'unknown',
  };

  afterEach(() => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({});
  });

  test('a live record in the engine snapshot renders the Settlement Field tracker on open', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({[liveRecord.id]: liveRecord});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-state')).toBe(true);
    expect(present(tree, 'convert-inflight')).toBe(true);
    // The screen did NOT try to drive anything itself — the engine already is.
    expect(jest.mocked(adoptConvertRecord)).not.toHaveBeenCalled();
  });

  test('the stuck unknown shows the watching line and the acknowledge button', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({[stuckRecord.id]: stuckRecord});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-stuck')).toBe(true);
    expect(textOf(tree, 'convert-stuck')).toContain(convertEn.stuckWatching);
    const btn = node(tree, 'btn-convert-stuck-ack');
    expect(btn).not.toBeUndefined();
    await act(async () => {
      btn!.props.onPress();
    });
    expect(jest.mocked(acknowledgeStuckRecord)).toHaveBeenCalledWith(stuckRecord.id);
  });

  test('an acknowledged stuck record shows the acknowledged line and NO button (the watch is off)', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({[stuckRecord.id]: stuckRecord});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-stuck')).toBe(true); // unacknowledged: still surfaced on open
    await act(async () => {
      mockEngineSub.cb?.({[stuckRecord.id]: {...stuckRecord, acknowledgedStuckAtMs: 123}});
    });
    expect(textOf(tree, 'convert-stuck')).toContain(convertEn.stuckAcknowledged);
    expect(present(tree, 'btn-convert-stuck-ack')).toBe(false);
  });
});

// --- the pre-broadcast invariant + the CeFi panel lines (carried over; StatePanel untouched) ------
describe('C1 — no record exists before the confirm (pre-broadcast invariant)', () => {
  afterEach(() => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({});
  });
  test('mount → prefill → unmount WITHOUT confirm: nothing prepared, nothing adopted', async () => {
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-screen')).toBe(true);
    expect(jest.mocked(prepareConvertRecord)).not.toHaveBeenCalled();
    expect(jest.mocked(adoptConvertRecord)).not.toHaveBeenCalled();
    await act(async () => {
      tree.unmount();
    });
    mounted = null;
    expect(jest.mocked(prepareConvertRecord)).not.toHaveBeenCalled();
    expect(jest.mocked(adoptConvertRecord)).not.toHaveBeenCalled();
  });
});

describe('the CeFi panel lines — no-expiry honesty + the last-checked timestamp', () => {
  afterEach(() => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({});
    jest.mocked(providerLastCheckedAtMs).mockReturnValue(null);
    jest.mocked(convertAbortFlavor).mockReturnValue('clean');
  });
  const cefiBase: ConvertRecord = {
    id: 'cefi-view',
    createdAtMs: 5,
    step: 'awaiting_deposit',
    venueId: 'sideshift',
    inCurrency: 8,
    outLedger: 'so-mint',
    inLedger: QUOTE.tokenInLedger,
    inSymbol: 'ICP',
    outSymbol: 'SOL',
    amountIn: '100000000',
    expectedGross: '4950000',
    expectedNet: '4950000',
    inFee: '0',
    outFee: '0',
    slippageBps: 0,
    legs: [],
    providerRef: {orderId: 'shift-x1', statusUrl: 'https://sideshift.ai/api/v2/shifts/shift-x1'},
    providerDeposit: {depositAddress: 'ss-addr', depositAmount: '1'},
  };

  test('awaiting_deposit with NO venue expiry says so — the unfunded order is not quietly abandoned', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({[cefiBase.id]: cefiBase});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-awaiting-deposit')).toBe(true);
    expect(textOf(tree, 'convert-deposit-no-expiry')).toContain(convertEn.cefi.noExpiryLine);
    expect(textOf(tree, 'convert-shift-id')).toContain('shift-x1');
  });

  test('an expiry the venue DID publish renders the expiry line, not the no-expiry fact', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({
      [cefiBase.id]: {...cefiBase, providerDeposit: {...cefiBase.providerDeposit!, expiresAtMs: 1_700_000_000_000}},
    });
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-deposit-no-expiry')).toBe(false);
    expect(textOf(tree, 'convert-awaiting-deposit'))
      .toContain(convertEn.cefi.depositExpiryLine(nonBreakingClock(new Date(1_700_000_000_000))));
  });

  test('provider_processing shows the engine\'s last completed read — a timestamp, not an SLA', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({
      [cefiBase.id]: {...cefiBase, step: 'provider_processing'},
    });
    jest.mocked(providerLastCheckedAtMs).mockReturnValue(1_700_000_000_000);
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-provider-processing')).toBe(true);
    expect(textOf(tree, 'convert-last-checked'))
      .toContain(convertEn.cefi.lastCheckedLine(formatClock(new Date(1_700_000_000_000))));
  });

  test('provider_processing BEFORE this session\'s first read claims nothing (no line)', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({
      [cefiBase.id]: {...cefiBase, step: 'provider_processing'},
    });
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-provider-processing')).toBe(true);
    expect(present(tree, 'convert-last-checked')).toBe(false);
  });

  test('awaiting_deposit offers the Stop; tapping it calls abortConvertRecord through the engine', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({[cefiBase.id]: cefiBase});
    jest.mocked(convertAbortFlavor).mockReturnValue('provider');
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'btn-convert-stop')).toBe(true);
    expect(textOf(tree, 'btn-convert-stop')).toContain(convertEn.stopProvider);
    await act(async () => {
      node(tree, 'btn-convert-stop')!.props.onPress();
    });
    expect(jest.mocked(abortConvertRecord)).toHaveBeenCalledWith(cefiBase.id);
  });

  test('the aborted provider card carries the two-sided truth AND the venue handle it points at', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({[cefiBase.id]: cefiBase});
    const tree = await mountConvert('250000000', null);
    jest.mocked(convertAbortFlavor).mockReturnValue('provider');
    await act(async () => {
      mockEngineSub.cb?.({[cefiBase.id]: {...cefiBase, step: 'aborted', abortedFromStep: 'awaiting_deposit', abortedAtMs: 1}});
    });
    expect(textOf(tree, 'convert-aborted')).toContain(convertEn.abortedProvider.slice(0, 60));
    expect(textOf(tree, 'convert-aborted-shift-id')).toContain('shift-x1');
    expect(present(tree, 'btn-convert-stop')).toBe(false); // terminal: no second Stop
  });
});

// --- decimals threading (audit 2026-09-11) — carried over against the Settlement Field tracker ----
describe('decimals threading — money lines read the ledger, never a literal 8', () => {
  const CATALOG6 = CATALOG.map(c => (c.ledger === QUOTE.tokenOutLedger ? {...c, decimals: 6} : c));

  const stateRecord: ConvertRecord = {
    id: 'dec-rec',
    createdAtMs: 5,
    step: 'approving',
    venueId: 'icpswap',
    inCurrency: 8,
    outCurrency: 7,
    inLedger: QUOTE.tokenInLedger,
    outLedger: QUOTE.tokenOutLedger,
    inSymbol: 'ICP',
    outSymbol: 'VCHF',
    amountIn: '100000000',
    expectedGross: '41194138',
    expectedNet: '41184138',
    inFee: '10000',
    outFee: '10000',
    slippageBps: 100,
    legs: [],
  };

  afterEach(() => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({});
    jest.mocked(convertRecordMinOut).mockResolvedValue(null as never);
  });

  test('the rate line scales to the OUTPUT ledger\'s own decimals — 6 here, not a hardcoded 8', async () => {
    const tree = await mountConvert('250000000', '1', {catalog: CATALOG6});
    const scaled = (BigInt(QUOTE.amountOutGross) * 10n ** 8n) / BigInt(QUOTE.amountIn);
    await openDetails(tree);
    expect(textOf(tree, 'convert-rate')).toContain(fmtAssetCompact(scaled.toString(), 6, 'VCHF'));
    expect(textOf(tree, 'convert-rate')).toContain('41.194138 VCHF');
  });

  test('a record with frozen decimals renders its state money at THEM (approving, input side)', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({dec6: {...stateRecord, inDecimals: 6, outDecimals: 6}});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-approving')).toBe(true);
    // amountIn 100000000 raw at SIX decimals = 100 ICP; a literal-8 regression prints
    // 1.00000000 ICP — a 100x lie about what was approved.
    expect(textOf(tree, 'convert-approving')).toContain('100 ICP');
  });

  test('the stuck tracker carries BOTH legs\' frozen decimals (signed amount in, minimum out)', async () => {
    jest.mocked(convertRecordMinOut).mockResolvedValue('40782196' as never);
    jest.mocked(convertResumeSnapshot).mockReturnValue({stuck6: {...stateRecord, step: 'stuck', failureCode: 'unknown', inDecimals: 6, outDecimals: 6}});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-stuck')).toBe(true);
    expect(textOf(tree, 'convert-stuck')).toContain('100 ICP');
    expect(textOf(tree, 'convert-stuck')).toContain('40.782196 VCHF');
  });

  test('a record that predates the fields (the legacy e8s world) falls back to 8 — the renderer owns it', async () => {
    jest.mocked(convertRecordMinOut).mockResolvedValue('40782196' as never);
    jest.mocked(convertResumeSnapshot).mockReturnValue({legacy: {...stateRecord, step: 'stuck', failureCode: 'unknown'}});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-stuck')).toBe(true);
    expect(textOf(tree, 'convert-stuck')).toContain('1 ICP');
    expect(textOf(tree, 'convert-stuck')).toContain('0.40782196 VCHF');
  });
});

// --- the composed routes: expander rows, the Route-B gates, the hub two-quote surface -------------
describe('multihop — the composed routes are Other-venues rows under the auto-picked direct pool', () => {
  const ROUTE_B_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp';
  const HUB_ROW = 'convert-venue-hub:icpswap:7:icpswap-vchf-ckusdc';
  const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();

  /** Clear the prefill, open the USD pair, expand the other rows, pick one, re-type 1. */
  const pickRow = async (tree: renderer.ReactTestRenderer, rowId: string): Promise<void> => {
    await act(async () => {
      node(tree, 'convert-amount')!.props.onChangeText('');
    });
    await act(async () => {
      node(tree, 'convert-target-chip-USD')!.props.onPress();
    });
    await act(async () => {
      node(tree, 'btn-convert-venues-other')!.props.onPress();
    });
    await act(async () => {
      node(tree, rowId)!.props.onPress();
    });
    await act(async () => {
      node(tree, 'convert-amount')!.props.onChangeText('1');
    });
    await act(async () => {});
  };

  test('the direct pool auto-picks; hub, Route B and the CeFi venue wait in the expander, kind order', async () => {
    const tree = await mountConvert('250000000', '1');
    await act(async () => {
      node(tree, 'convert-amount')!.props.onChangeText('');
    });
    await act(async () => {
      node(tree, 'convert-target-chip-USD')!.props.onPress();
    });
    await act(async () => {});
    // Without an amount nothing is quoted yet; the direct pool stands as the provisional row
    // and the expander carries the composed rows beside it.
    // Open the expander: the OTHER rows, verbatim in kind/registry order, NO quote of their
    // own until picked (an unpicked composed row carries its label, never another quote).
    await act(async () => {
      node(tree, 'btn-convert-venues-other')!.props.onPress();
    });
    const ids = (t: renderer.ReactTestRenderer): string[] => {
      const seen: string[] = [];
      for (const n of t.root.findAll(x => x.props != null && typeof x.props.testID === 'string' && String(x.props.testID).startsWith('convert-venue-') && !/-quote$|-err$|-slow$|-source$/.test(String(x.props.testID)))) {
        const id = String(n.props.testID);
        if (!seen.includes(id)) seen.push(id);
      }
      return seen;
    };
    expect(ids(tree)).toEqual([
      HUB_ROW,                                // via the VCHF hub
      ROUTE_B_ROW,                            // Route B (in-wallet CCTP landing)
      'convert-venue-sideshift-usdc',         // the CeFi venue
    ]);
    // Route C (the +Jupiter composite) lands SOL — it is a row on the SOL target, not here.
    await act(async () => {
      node(tree, 'convert-amount')!.props.onChangeText('');
    });
    await act(async () => {
      node(tree, 'convert-target-chip-SOL')!.props.onPress();
    });
    await act(async () => {});
    expect(present(tree, 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter')).toBe(true);
    // The cash-out row does not exist anywhere on the surface.
    expect(present(tree, 'convert-venue-multihop:icpswap-ckusdc:2')).toBe(false);
  });

  test('Route B pays out to the wallet\u2019s OWN address by default; editing sits behind the advanced control', async () => {
    const tree = await mountConvert('250000000', '1');
    await pickRow(tree, ROUTE_B_ROW);
    // The external-signature exception, disclosed at tap 1 (brief 5.4.1).
    expect(textOf(tree, 'convert-external-sign-note')).toContain(convertEn.externalSignTitle);
    // The founder directive (2026-09-30): the payout address IS the wallet's own derived
    // address — shown, never typed on entry. No input, no re-type; the crossing note keeps
    // its signer warning; manual destinations wait behind the ONE advanced control.
    expect(present(tree, 'convert-dest-address')).toBe(false);
    expect(present(tree, 'convert-dest-reenter')).toBe(false);
    expect(textOf(tree, 'convert-dest-shown')).toBe(OWN_EVM);
    expect(textOf(tree, 'convert-dest-cross-note')).toBe(convertEn.crossrail.destAddressCrossNote);
    expect(present(tree, 'btn-convert-dest-change')).toBe(true);
    expect(present(tree, 'convert-route-min')).toBe(true);
    expect(present(tree, 'convert-min-out')).toBe(false);
    await openDetails(tree);
    expect(present(tree, 'convert-minter-principal')).toBe(true);
    expect(present(tree, 'convert-gas-note')).toBe(true);
    // A malformed address is flagged in copy, never silently signed — behind the control.
    await act(async () => {
      node(tree, 'btn-convert-dest-change')!.props.onPress();
    });
    await act(async () => {
      node(tree, 'convert-dest-address')!.props.onChangeText('0x1234');
    });
    expect(present(tree, 'convert-dest-address-invalid')).toBe(true);
  });

  test('editing the destination keeps the checksum + re-type gates; the derived value auto-satisfies', async () => {
    const tree = await mountConvert('250000000', '1');
    await pickRow(tree, ROUTE_B_ROW);
    await act(async () => {
      node(tree, 'btn-convert-dest-change')!.props.onPress();
    });
    // The editor opens pre-filled with the derived address — already confirmed, no re-type.
    expect(node(tree, 'convert-dest-address')!.props.value).toBe(OWN_EVM);
    expect(present(tree, 'convert-dest-reenter')).toBe(false);
    // A custom valid address brings the one-time re-type back.
    await act(async () => {
      node(tree, 'convert-dest-address')!.props.onChangeText(DEST);
    });
    expect(present(tree, 'convert-dest-reenter')).toBe(true);
    await act(async () => {
      node(tree, 'convert-dest-reenter')!.props.onChangeText(DEST);
    });
    expect(present(tree, 'convert-dest-reenter')).toBe(false);
    // Editing BACK to the derived value auto-satisfies: the re-type never asks again.
    await act(async () => {
      node(tree, 'convert-dest-address')!.props.onChangeText(OWN_EVM);
    });
    expect(present(tree, 'convert-dest-reenter')).toBe(false);
  });

  test('a KNOWN ckETH shortfall blocks the confirm and names the requirement first', async () => {
    const tree = await mountConvert('250000000', '1', {assetBalances: {8: '250000000', 6: '1000000000'}});
    await pickRow(tree, ROUTE_B_ROW);
    expect(present(tree, 'convert-gas-preflight')).toBe(true);
    expect(textOf(tree, 'convert-gas-preflight')).toBe(convertEn.multihop.gasPreflightTitle + ' ' + convertEn.multihop.gasPreflightBody('0.00008 ETH'));
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
  });

  test('an unknown ckETH balance stays fail-open; a funded one offers the confirm, and confirming prepares the ROUTE record', async () => {
    const unknown = await mountConvert('250000000', '1');
    await pickRow(unknown, ROUTE_B_ROW);
    expect(present(unknown, 'convert-gas-preflight')).toBe(false);
    expect(node(unknown, 'btn-convert-confirm')!.props.disabled).toBe(false);
    // Tear the probe tree down HERE: `mounted` holds only the LAST tree, so an un-unmounted
    // first mount would keep its stale-quote interval armed and hang the whole file at exit.
    await act(async () => { unknown.unmount(); });

    jest.mocked(prepareMultihopConvertRecord).mockResolvedValue({
      id: 'route1', createdAtMs: 1, step: 'approving', venueId: 'icpswap-ckusdc',
      inCurrency: 8, outCurrency: 2, inLedger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', outLedger: 'xevnm-gaaaa-aaaar-qafnq-cai',
      inSymbol: 'ICP', outSymbol: 'USDC', amountIn: '100000000', expectedGross: '1', expectedNet: '1',
      inFee: '10000', outFee: '10000', slippageBps: 100, legs: [], legPlan: [],
    } as never);
    const tree = await mountConvert('250000000', '1', {assetBalances: {8: '250000000', 6: '100000000000000000'}});
    await pickRow(tree, ROUTE_B_ROW);
    expect(present(tree, 'convert-gas-preflight')).toBe(false);
    await act(async () => {
      node(tree, 'btn-convert-confirm')!.props.onPress();
    });
    expect(prepareMultihopConvertRecord).toHaveBeenCalledTimes(1);
    // The payout lands at the wallet's OWN derived address — zero typing (founder directive).
    expect(jest.mocked(prepareMultihopConvertRecord).mock.calls[0][0]).toMatchObject({destAddress: OWN_EVM});
    expect(adoptConvertRecord).toHaveBeenCalledTimes(1);
  });
});

describe('hub destination — the two-quote composed surface under the sheet (2026-09-18 hub UX)', () => {
  const VCHF_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 7)!;
  const rowOf = (currency: number) => CATALOG.find(c => c.currency === currency)!;
  const VCHF_LEDGER = rowOf(7).ledger!;
  const ICP_LEDGER = rowOf(8).ledger!;
  const CKETH_LEDGER = rowOf(6).ledger!;
  /** quote1: VCHF → ICP through icpswap; its 1% floor is what quote2 is SIZED on. */
  const HUB_Q1: ConvertQuote = {
    venueId: 'icpswap', pool: '65mrh-fqaaa-aaaar-qapoa-cai',
    tokenInLedger: VCHF_LEDGER, tokenOutLedger: ICP_LEDGER,
    amountIn: '100000000', amountOutGross: '120000000',
    zeroForOne: true, feeMillionths: 3000, fetchedAtMs: 1_700_000_000_000,
  };
  const HUB_M1: ConvertMath = {
    amountIn: '100000000', grossOut: '120000000', minOut: '118800000', netOut: '119990000',
    inFee: '10000', outFee: '10000', slippageBps: 100,
  };
  const HUB_Q2: ConvertQuote = {
    venueId: 'icpswap-cketh', pool: 'angxa-baaaa-aaaag-qcvnq-cai',
    tokenInLedger: ICP_LEDGER, tokenOutLedger: CKETH_LEDGER,
    amountIn: '118800000', amountOutGross: '3000000000000',
    zeroForOne: false, feeMillionths: 5000, fetchedAtMs: 1_700_000_005_000,
  };
  const HUB_M2: ConvertMath = {
    amountIn: '118800000', grossOut: '3000000000000', minOut: '2970000000000', netOut: '1000000000000',
    inFee: '10000', outFee: '2000000000000', slippageBps: 100,
  };
  const nbclock = (ms: number): string => formatClock(new Date(ms)).replace(/ /g, '\u00A0');
  const armHubMocks = (): void => {
    jest.mocked(fetchConvertQuote).mockReset();
    jest.mocked(fetchConvertQuote).mockImplementation(async (_relay: string, tin: string, tout: string) => {
      if (tin === VCHF_LEDGER && tout === ICP_LEDGER) return HUB_Q1;
      if (tin === ICP_LEDGER && tout === CKETH_LEDGER) return HUB_Q2;
      throw new Error('unexpected pair ' + tin + ' -> ' + tout);
    });
    jest.mocked(deriveConvertMath).mockReset();
    jest.mocked(deriveConvertMath).mockImplementation(async (q: ConvertQuote) =>
      q.tokenInLedger === VCHF_LEDGER ? HUB_M1 : HUB_M2);
  };
  const mountHub = async (balanceRaw = '250000000'): Promise<renderer.ReactTestRenderer> => {
    armHubMocks();
    const tree = await mountConvert(balanceRaw, null, {
      selectedAsset: VCHF_ASSET,
      assetBalances: {7: balanceRaw},
    });
    armHubMocks(); // drop the standing-surface direct fetch from the call history
    await act(async () => {});
    await act(async () => {
      node(tree, 'convert-target-chip-ETH')!.props.onPress();
    });
    await act(async () => {});
    return tree;
  };

  test('the hub-only target auto-picks its single mechanism and shows the composed two-quote surface', async () => {
    const tree = await mountHub();
    expect(present(tree, 'convert-dest-address')).toBe(false);
    expect(present(tree, 'convert-gas-preflight')).toBe(false);
    expect(textOf(tree, 'convert-route-min')).toBe(
      convertEn.multihop.routeMinWalletLine(fmtAssetCompact('2970000000000', 18, 'ETH')));
    expect(present(tree, 'convert-min-out')).toBe(false);
    // The heading names the CURRENCY pair (currency-first grammar): CHF → ETH.
    const headingTexts = tree.root.findAllByType(Text).filter(n => n.props.children === convertEn.heading('CHF', 'ETH'));
    expect(headingTexts.length).toBeGreaterThanOrEqual(1);
    // The receive figure is the composed net estimate; BOTH venues verbatim on the line.
    expect(textOf(tree, 'convert-headline')).toContain(convertEn.youReceive(fmtAssetCompact('1000000000000', 18, 'ETH')));
    expect(textOf(tree, 'convert-quote-source')).toBe(
      convertEn.multihop.hubQuoteSource('ICPSwap', 'ICPSwap', nbclock(1_700_000_005_000)));
    expect(textOf(tree, 'convert-route-via')).toBe(convertEn.multihop.viaHub('ICP'));
    await openDetails(tree);
    const census = textOf(tree, 'convert-hub-census');
    expect(census).toContain(convertEn.multihop.hubCensusHeading);
    expect(census).toContain(convertEn.multihop.legSwap('ICPSwap', 'VCHF', 'ICP'));
    expect(census).toContain(convertEn.multihop.legSwap('ICPSwap', 'ICP', 'ETH'));
    expect(census).toContain(convertEn.multihop.approveFeeLine(fmtAssetCompact('10000', 8, 'VCHF')));
    expect(census).toContain(convertEn.multihop.approveFeeLine(fmtAssetCompact('10000', 8, 'ICP')));
    expect(census).toContain(convertEn.quoteSource(nbclock(1_700_000_000_000), 'ICPSwap'));
    expect(census).toContain(convertEn.quoteSource(nbclock(1_700_000_005_000), 'ICPSwap'));
    expect(census).toContain(convertEn.multihop.hubSurplusNote('ICP', 'ETH'));
  });

  test('confirm re-quotes BOTH hops fresh and composes the record through prepareHubConvertRecord', async () => {
    const tree = await mountHub();
    jest.mocked(prepareHubConvertRecord).mockReset();
    jest.mocked(prepareHubConvertRecord).mockResolvedValue({
      id: 'hub1', createdAtMs: 1, step: 'approving', venueId: 'icpswap', venue2Id: 'icpswap-cketh',
      inCurrency: 7, outCurrency: 8, inLedger: VCHF_LEDGER, outLedger: ICP_LEDGER,
      destLedger: CKETH_LEDGER, destCurrency: 6, inSymbol: 'VCHF', outSymbol: 'ICP', destSymbol: 'ETH',
      amountIn: '100000000', expectedGross: '120000000', expectedNet: '119990000',
      inFee: '10000', outFee: '10000', slippageBps: 100, legs: [], legPlan: [],
    } as never);
    jest.mocked(fetchConvertQuote).mockClear();
    await act(async () => {
      node(tree, 'btn-convert-confirm')!.props.onPress();
    });
    expect(jest.mocked(fetchConvertQuote)).toHaveBeenCalledTimes(2);
    expect(prepareHubConvertRecord).toHaveBeenCalledTimes(1);
    const args = jest.mocked(prepareHubConvertRecord).mock.calls[0][0];
    expect(args.route).toMatchObject({routeId: 'hub:icpswap:8:icpswap-cketh'});
    expect(args.quote1).toMatchObject({venueId: 'icpswap', amountOutGross: '120000000'});
    expect(args.quote2).toMatchObject({venueId: 'icpswap-cketh', amountIn: '118800000'});
    expect(args.math1).toMatchObject({minOut: '118800000'});
    expect(args.math2).toMatchObject({minOut: '2970000000000'});
    expect(adoptConvertRecord).toHaveBeenCalledTimes(1);
    // The hub record floods to the Settlement Field tracker, legs fully expanded.
    expect(present(tree, 'convert-state')).toBe(true);
    expect(present(tree, 'convert-route-legs')).toBe(true);
  });

  /** A hub record as prepare leaves it (the widening fields frozen), parameterised per test. */
  const hubScreenRecord = (over: Record<string, unknown>): ConvertRecord => ({
    id: 'hub-screen', createdAtMs: 1_700_000_000_000, step: 'approving',
    venueId: 'icpswap', venue2Id: 'icpswap-cketh',
    inCurrency: 7, outCurrency: 8, destCurrency: 6,
    inLedger: VCHF_LEDGER, outLedger: ICP_LEDGER, hopLedger: ICP_LEDGER, destLedger: CKETH_LEDGER,
    inSymbol: 'VCHF', outSymbol: 'ICP', hopSymbol: 'ICP', destSymbol: 'ETH',
    inDecimals: 8, outDecimals: 8, destDecimals: 18,
    amountIn: '100000000', inFee: '10000', outFee: '10000', destFee: '2000000000000',
    slippageBps: 100, legs: [], legPlan: [], ...over,
  } as never);
  const POOL1 = '65mrh-fqaaa-aaaar-qapoa-cai';
  const POOL2 = 'angxa-baaaa-aaaag-qcvnq-cai';

  /** A CHAIN record at phase 2 (the any-pair widening): the record's in and hop both name
   *  the mid asset (the phase-2 rewrite), so the leg labels + route title must read the
   *  frozen plan's own ordered pairs instead. */
  const chainScreenRecord = (over: Record<string, unknown>): ConvertRecord => ({
    id: 'chain-screen', createdAtMs: 1_700_000_000_000, step: 'pending_withdrawal',
    venueId: 'icpswap', inCurrency: 8, outCurrency: 7,
    inLedger: ICP_LEDGER, hopLedger: ICP_LEDGER, outLedger: VCHF_LEDGER,
    inSymbol: 'ICP', hopSymbol: 'ICP', outSymbol: 'VCHF',
    inDecimals: 8, outDecimals: 8,
    amountIn: '249980000', expectedGross: '499960000', expectedNet: '490000000',
    inFee: '10000', outFee: '10000', slippageBps: 100,
    legs: [
      {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: 'aa', envelopeHex: 'ee', requestIdHex: 'r1', expiresAtMs: 1},
      {canister: POOL1, method: 'depositFromAndSwap', argHex: 'aa', envelopeHex: 'ee', requestIdHex: 'r2', expiresAtMs: 1},
    ],
    legPlan: [
      {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'confirmed'},
      {kind: 'swap', canister: POOL1, fee: '', state: 'sent'},
    ],
    destAddress: 'account-id-text', destSymbol: 'VCHF', destNetwork: 'Internet Computer',
    chainRoute: {
      venueId: 'sideshift-usdc', orderId: 'order-1',
      depositAddress: '11111111111111111111111111111111',
      amountDecimal: '1', amountRaw: '1000000',
      settleAmountDecimal: '0.495', settleAmountRaw: '49500000',
      icLegs: [{venueId: 'icpswap', pool: POOL1, fromLedger: ICP_LEDGER, toLedger: VCHF_LEDGER}],
      icFromFees: ['10000'],
    },
    ...over,
  } as never);

  test('chain phase-2: route title + swap legs read the FROZEN plan pairs (never "ICP \u2192 ICP")', async () => {
    const live = chainScreenRecord({});
    jest.mocked(convertResumeSnapshot).mockReturnValue({[live.id]: live});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-route-legs')).toBe(true);
    // The title is the plan's own route, collapsed (the mid → dest hop pair).
    expect(textOf(tree, 'convert-state')).toContain(
      convertEn.multihop.routeHeadingCollapsed('ICP', 'VCHF', 'Internet Computer'));
    // The swap leg names its OWN from→to from the frozen plan.
    expect(textOf(tree, 'convert-leg-1')).toContain(convertEn.multihop.legSwap('ICPSwap', 'ICP', 'VCHF'));
    expect(textOf(tree, 'convert-leg-1')).not.toContain('ICP \u2192 ICP');
  });

  test('chain phase-2 hub shape: both swap legs label their own plan pairs', async () => {
    const CKUSDC_LEDGER = CATALOG.find(c => c.currency === 2)!.ledger!;
    const live = chainScreenRecord({
      venue2Id: 'icpswap-ckusdc',
      outLedger: CKUSDC_LEDGER, outSymbol: 'USD', outCurrency: 2, hopSymbol: 'ICP',
      legs: [
        {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: 'aa', envelopeHex: 'ee', requestIdHex: 'r1', expiresAtMs: 1},
        {canister: POOL1, method: 'depositFromAndSwap', argHex: 'aa', envelopeHex: 'ee', requestIdHex: 'r2', expiresAtMs: 1},
        {canister: CKUSDC_LEDGER, method: 'icrc2_approve', argHex: 'ab', envelopeHex: 'ef', requestIdHex: 'r3', expiresAtMs: 1},
        {canister: POOL2, method: 'depositFromAndSwap', argHex: 'ab', envelopeHex: 'ef', requestIdHex: 'r4', expiresAtMs: 1},
      ],
      legPlan: [
        {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'confirmed'},
        {kind: 'swap', canister: POOL1, fee: '', state: 'confirmed'},
        {kind: 'approve', canister: CKUSDC_LEDGER, fee: '10000', state: 'sent'},
        {kind: 'swap', canister: POOL2, fee: '', state: 'pending'},
      ],
      chainRoute: {
        venueId: 'sideshift-usdc', orderId: 'order-2',
        depositAddress: '11111111111111111111111111111111',
        amountDecimal: '1', amountRaw: '1000000',
        settleAmountDecimal: '0.495', settleAmountRaw: '49500000',
        icLegs: [
          {venueId: 'icpswap', pool: POOL1, fromLedger: ICP_LEDGER, toLedger: CKUSDC_LEDGER},
          {venueId: 'icpswap-ckusdc', pool: POOL2, fromLedger: CKUSDC_LEDGER, toLedger: VCHF_LEDGER},
        ],
        icFromFees: ['10000', '10000'],
      },
    });
    jest.mocked(convertResumeSnapshot).mockReturnValue({[live.id]: live});
    const tree = await mountConvert('250000000', null);
    expect(textOf(tree, 'convert-leg-1')).toContain(convertEn.multihop.legSwap('ICPSwap', 'ICP', 'USDC'));
    expect(textOf(tree, 'convert-leg-3')).toContain(convertEn.multihop.legSwap(venueDisplayName('icpswap-ckusdc'), 'USDC', 'VCHF'));
  });

  test('in-flight: four legs fully expanded, per-hop labels, top line tracks the current leg (D14/D15)', async () => {
    const live = hubScreenRecord({
      id: 'hub-live',
      legPlan: [
        {kind: 'approve', canister: VCHF_LEDGER, fee: '10000', state: 'confirmed'},
        {kind: 'swap', canister: POOL1, fee: '', state: 'sent'},
        {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'pending'},
        {kind: 'swap', canister: POOL2, fee: '', state: 'pending'},
      ],
    });
    jest.mocked(convertResumeSnapshot).mockReturnValue({[live.id]: live});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-route-legs')).toBe(true);
    expect(present(tree, 'convert-leg-0')).toBe(true);
    expect(present(tree, 'convert-leg-3')).toBe(true);
    expect(textOf(tree, 'convert-leg-2')).toContain(convertEn.multihop.legApprovePull('ICP'));
    expect(textOf(tree, 'convert-leg-3')).toContain(convertEn.multihop.legSwap(venueDisplayName('icpswap-cketh'), 'ICP', 'ETH'));
    expect(textOf(tree, 'convert-step')).toBe(
      convertEn.multihop.legProgress(2, 4) + ' \u2014 ' + convertEn.multihop.legSwap(venueDisplayName('icpswap'), 'VCHF', 'ICP'));
  });

  test('done: the hub receipt is the IN-WALLET copy — never the cash-out "on its way" family (D17)', async () => {
    const live = hubScreenRecord({
      id: 'hub-done',
      legPlan: [
        {kind: 'approve', canister: VCHF_LEDGER, fee: '10000', state: 'confirmed'},
        {kind: 'swap', canister: POOL1, fee: '', state: 'confirmed'},
        {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'confirmed'},
        {kind: 'swap', canister: POOL2, fee: '', state: 'confirmed'},
      ],
    });
    jest.mocked(convertResumeSnapshot).mockReturnValue({[live.id]: live});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-route-legs')).toBe(true);
    await act(async () => {
      mockEngineSub.cb?.({
        [live.id]: {...live, step: 'done', outAmountNet: '1000000000000', outTx: 'dest-tx-9'},
      });
    });
    const receipt = textOf(tree, 'convert-done');
    expect(receipt).toContain(convertEn.doneTitle);
    expect(receipt).toContain(convertEn.doneBody(fmtAssetCompact('1000000000000', 18, 'ETH')));
    expect(receipt).not.toContain(convertEn.multihop.doneOnItsWay);
    expect(receipt).toContain(convertEn.doneTx('dest-tx-9'));
  });

  test('failed_leg: the hub trio — first swap behind you, hub asset held, its own exits (D18)', async () => {
    const live = hubScreenRecord({
      id: 'hub-failed',
      legPlan: [
        {kind: 'approve', canister: VCHF_LEDGER, fee: '10000', state: 'confirmed'},
        {kind: 'swap', canister: POOL1, fee: '', state: 'confirmed'},
        {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'failed'},
        {kind: 'swap', canister: POOL2, fee: '', state: 'pending'},
      ],
      step: 'failed_leg', failureCode: 'approve_refused', failureDetail: 'allowance expired',
    });
    jest.mocked(convertResumeSnapshot).mockReturnValue({[live.id]: live});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-failed-leg')).toBe(true);
    const dead = textOf(tree, 'convert-failed-leg');
    expect(dead).toContain(convertEn.multihop.failedHop2Body('ICP', 'ETH', 'allowance expired'));
    expect(dead).toContain(convertEn.multihop.failedHop2Exit('ICP'));
    expect(dead).not.toContain(convertEn.multihop.failedLegExit);
  });

  test('stuck: the holds line states what the completed swap already left in the wallet (D19)', async () => {
    const stuck = hubScreenRecord({
      id: 'hub-stuck', step: 'stuck',
      legPlan: [
        {kind: 'approve', canister: VCHF_LEDGER, fee: '10000', state: 'confirmed'},
        {kind: 'swap', canister: POOL1, fee: '', state: 'sent'},
        {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'pending'},
        {kind: 'swap', canister: POOL2, fee: '', state: 'pending'},
      ],
    });
    jest.mocked(convertResumeSnapshot).mockReturnValue({[stuck.id]: stuck});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-stuck')).toBe(true);
    expect(textOf(tree, 'convert-stuck')).toContain(convertEn.multihop.stuckHoldsLine('ICP'));
  });

  test('the fee gate counts the hub approve fee: the prefill dodges it, the raw amount hits it (D21)', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({});
    // 1 VCHF + three fees = 100030000 — a DIRECT conversion would pass on this balance; the
    // hub approve fee on the hub ledger (+10000) must still be counted. The sheet's prefill
    // therefore lands UNDER the amount and tap 2 arms; typing the raw 1 VCHF is refused.
    const tree = await mountHub('100020000');
    expect(node(tree, 'convert-amount')!.props.value).toBe('0.9999');
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(false);
    await act(async () => { node(tree, 'convert-amount')!.props.onChangeText('1'); });
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
    expect(present(tree, 'convert-insufficient')).toBe(true);
    expect(textOf(tree, 'convert-insufficient')).toContain(
      convertEn.multihop.insufficientHubLine(fmtAssetCompact('100030000', 8, 'VCHF'), fmtAssetCompact('100020000', 8, 'VCHF')));
  });

  test('the cash-out route heading collapses when the hop IS the destination (F1)', async () => {
    const CKUSDC_LEDGER = CATALOG.find(c => c.currency === 2)!.ledger!;
    const cashOut = hubScreenRecord({
      id: 'route-a-cashout', venueId: 'icpswap-ckusdc', venue2Id: undefined,
      hopLedger: CKUSDC_LEDGER, hopSymbol: 'USDC', hopDecimals: 6,
      destSymbol: 'USDC', destNetwork: 'Ethereum', gasSymbol: 'ETH', gasDecimals: 18,
      step: 'pending_withdrawal',
      legPlan: [
        {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'confirmed'},
        {kind: 'swap', canister: 'pool', fee: '', state: 'confirmed'},
        {kind: 'approve', canister: CKUSDC_LEDGER, fee: '10000', state: 'confirmed'},
        {kind: 'approve_gas', canister: CKETH_LEDGER, fee: '2000000000000', state: 'confirmed'},
        {kind: 'withdraw_erc20', canister: 'minter', fee: '', state: 'pending'},
      ],
    });
    jest.mocked(convertResumeSnapshot).mockReturnValue({[cashOut.id]: cashOut});
    const tree = await mountConvert('250000000', null);
    const flat = (c: unknown): string =>
      Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
    const texts = tree.root.findAllByType(Text).map(n => flat(n.props.children)).filter(s => s.length > 0);
    expect(texts).toContain(convertEn.multihop.routeHeadingCollapsed('VCHF', 'USDC', 'Ethereum'));
    expect(texts).not.toContain(convertEn.multihop.routeHeading('VCHF', 'USDC', 'USDC', 'Ethereum'));
  });

  test('Max fills the amount that survives the fee overhead (F4) — and the sheet prefilled it already', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({});
    // 1 VCHF above the hub three-fee overhead: the prefill lands on exactly 1 VCHF…
    const tree = await mountHub('100030000');
    expect(node(tree, 'convert-amount')!.props.value).toBe('1'); // the prefill IS the max
    expect(present(tree, 'btn-convert-max')).toBe(true); // the Max chip's inner alias
    await act(async () => { node(tree, 'convert-preset-max')!.props.onPress(); });
    expect(node(tree, 'convert-amount')!.props.value).toBe('1');
    expect(present(tree, 'convert-insufficient')).toBe(false);
  });

  test('hub-reachable input: ckETH converts — the direct ICP pair stands, hub-only targets are chips', async () => {
    const CKETH_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 6)!;
    jest.mocked(convertResumeSnapshot).mockReturnValue({});
    const tree = await mountConvert('1000000000000000000', null,
      {selectedAsset: CKETH_ASSET, assetBalances: {6: '1000000000000000000'}});
    // The chips carry every OTHER reachable currency; the source currency is never one.
    const chips = (t: renderer.ReactTestRenderer): string[] => {
      const seen: string[] = [];
      for (const n of t.root.findAll(x => x.props != null && typeof x.props.testID === 'string' && String(x.props.testID).startsWith('convert-target-chip-'))) {
        const id = String(n.props.testID).replace('convert-target-chip-', '');
        if (!seen.includes(id)) seen.push(id);
      }
      return seen;
    };
    // The reachable set grew with the composed walk (2026-09-26): beside ICP (direct) and
    // the hub-only {BTC, CHF, USD}, the IC+CeFi chains through ICP reach the SOL-rail mints
    // the registered cefi venues pay — EUR (sideshift-eurc) and SOL (sideshift) — so their
    // chips are TRUE reachability now, not lies.
    expect(chips(tree).sort()).toEqual(['BTC', 'CHF', 'EUR', 'SOL', 'USD']);
    expect(present(tree, 'convert-target-list')).toBe(false); // the old open/close list is gone
  });
});

