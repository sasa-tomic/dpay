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
 *   * C2 — "Price impact: —" never resolved. A permanent placeholder is a bug; an impact that
 *     genuinely cannot be measured must say so IN WORDS and say what it means for the user
 *     (founder rule 2026-08-29: useful practical instructions on every step).
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

jest.mock('../convert', () => ({
  isQuoteStale: () => false,
  loadConvertRecords: jest.fn(async () => ({})),
  fetchConvertQuote: jest.fn(),
  deriveConvertMath: jest.fn(),
  prepareConvertRecord: jest.fn(),
  executeConvert: jest.fn(),
}));

import {ConvertMode} from '../components/ConvertMode';
import {deriveConvertMath, fetchConvertQuote} from '../convert';
import type {ConvertMath, ConvertQuote} from '../convert';
import {buildSelectableAssets} from '../config/assets';
import type {Identity} from '../lib/types';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {convertEn} from '../i18n/domains/en/convert';
import {convertDe} from '../i18n/domains/de/convert';
import {convertEs} from '../i18n/domains/es/convert';
import {convertFr} from '../i18n/domains/fr/convert';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: false, solanaTokens: false});
const ICP_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 8)!;
const IDENTITY: Identity = {secretHex: 'aa'.repeat(32), publicHex: 'bb'.repeat(32), username: 'tester'};

const QUOTE: ConvertQuote = {
  pool: '65mrh-fqaaa-aaaar-qapoa-cai',
  tokenInLedger: 'ryjl3-tyaaa-aaaaa-aaaba-cai',
  tokenOutLedger: 'ly36x-wiaaa-aaaai-aqj7q-cai',
  amountIn: '100000000',
  amountOutGross: '41194138',
  zeroForOne: true,
  feeMillionths: 3000, // the venue's own 0.30% tier, echoed by the relay off the pool's metadata
  fetchedAtMs: 1_700_000_000_000,
  impactBps: 37,
};
const MATH: ConvertMath = {
  amountIn: '100000000',
  grossOut: '41194138',
  minOut: '40782196',
  netOut: '41184138',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
  impactBps: 37,
  impactWarn: false,
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
        selectedAsset={ICP_ASSET}
        assetBalances={{8: balanceRaw}}
        onBack={jest.fn()}
        onActivity={jest.fn()}
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
  jest.mocked(fetchConvertQuote).mockResolvedValue(QUOTE);
  jest.mocked(deriveConvertMath).mockResolvedValue(MATH);
});

describe('C1 — the unit is printed exactly once on every money line', () => {
  test('balance, both fees, the minimum and the end state each carry ONE unit', async () => {
    const tree = await mountConvert('250000000', '1');
    // The input leg's unit (ICP) and the output leg's (VCHF) each appear once per money line.
    expect(occurrences(textOf(tree, 'convert-balance'), 'ICP')).toBe(1);
    expect(occurrences(textOf(tree, 'convert-in-fee'), 'ICP')).toBe(1);
    expect(occurrences(textOf(tree, 'convert-out-fee'), 'VCHF')).toBe(1);
    expect(occurrences(textOf(tree, 'convert-min-out'), 'VCHF')).toBe(1);
    expect(occurrences(textOf(tree, 'convert-net'), 'VCHF')).toBe(1);
    // …and the amounts themselves are still the formatter's exact strings.
    expect(textOf(tree, 'convert-balance')).toContain('2.50000000 ICP');
    expect(textOf(tree, 'convert-in-fee')).toContain('0.00010000 ICP');
    expect(textOf(tree, 'convert-out-fee')).toContain('0.00010000 VCHF');
    expect(textOf(tree, 'convert-min-out')).toContain('0.40782196 VCHF');
    expect(textOf(tree, 'convert-net')).toContain('0.41184138 VCHF');
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
        d.minReceiveLine('9.99 VCHF', '1%'),
        d.netEndStateLine('9.99 VCHF'),
        d.doneBody('9.99 VCHF'),
      ];
      for (const line of lines) {
        expect(`${locale}: ${line}`).not.toContain('undefined');
        expect(`${locale}: ${line}`.match(/9\.99 (ICP|VCHF)/g)).toHaveLength(1);
        // the amount is stated once and no bare unit trails it
        expect(`${locale}: ${line}`).not.toMatch(/9\.99 (ICP|VCHF) \1/);
      }
      // 'ICP' alone is not countable here — "ICPSwap" is the venue's name, and naming it is a
      // §5 requirement. Count the FORMATTED amounts instead: each must appear exactly once, with
      // no bare unit trailing it.
      const signed = d.stuckSigned('9.99 ICP', '4.44 VCHF');
      expect(occurrences(signed, '9.99 ICP')).toBe(1);
      expect(occurrences(signed, '4.44 VCHF')).toBe(1);
      expect(signed).not.toMatch(/9\.99 ICP ICP|4\.44 VCHF VCHF/);
    }
  });
});

describe('C2 — price impact never renders a bare placeholder', () => {
  test('a measured impact renders as a percentage', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(textOf(tree, 'convert-impact')).toContain('0.37%');
  });

  test('an unmeasurable impact says so in words and what it means — never "—"', async () => {
    jest.mocked(fetchConvertQuote).mockResolvedValue({...QUOTE, impactBps: null});
    jest.mocked(deriveConvertMath).mockResolvedValue({...MATH, impactBps: null, impactWarn: false});
    const tree = await mountConvert('250000000', '1');
    const line = textOf(tree, 'convert-impact');
    // The shipped defect verbatim: the value slot filled with a placeholder and nothing else.
    expect(line).not.toBe(convertEn.impactLine('—'));
    expect(line).not.toMatch(/[-–—]\s*$/); // never ENDS on a dash either
    expect(line.length).toBeGreaterThan(60); // a sentence, not a dash
    // it must point at the number that DOES bound the outcome
    expect(line.toLowerCase()).toContain('minimum');
  });
});

describe('C3 — a confirm that can only fail is refused before it is offered', () => {
  test('zero balance: no form, no confirm, and the next action is named', async () => {
    const tree = await mountConvert('0', null);
    expect(present(tree, 'convert-fund')).toBe(true);
    expect(present(tree, 'btn-convert-confirm')).toBe(false);
    expect(present(tree, 'convert-amount')).toBe(false);
    const gate = textOf(tree, 'convert-fund');
    expect(gate).toContain('ICP'); // names the asset the user lacks
    expect(gate.toLowerCase()).toContain('receive'); // names what to do instead
  });

  test('the fund gate OFFERS the route it names, exactly as the Pay tab\'s gate does', async () => {
    // Naming "Receive ▸ My address" and then making the user walk there by hand is half a gate.
    // The Pay tab's fund gate has always carried the button (PayMode → InstructionPanel
    // `onPrimary`); Convert now passes the same callback, so the dead end is one tap from its own
    // remedy (founder rule 2026-08-29: useful practical instructions on every step).
    const onShowDepositAddress = jest.fn();
    const tree = await mountConvert('0', null, {onShowDepositAddress});
    // Same panel, same derived testID shape the Pay tab's gate uses (`pay-fund-go`).
    const btn = node(tree, 'convert-fund-go');
    expect(btn).not.toBeUndefined();
    expect(btn!.props.accessibilityRole).toBe('button');
    expect(textOf(tree, 'convert-fund')).toContain('ICP'); // the button names the asset it funds
    await act(async () => { btn!.props.onPress(); });
    expect(onShowDepositAddress).toHaveBeenCalledTimes(1);
  });

  // The funded-account pointer the Pay gate has and this gate did not. It is offerable HONESTLY
  // only here: the PoC venue trades exactly ONE unordered pair, so the only account that could
  // ever help is the pair's other leg — already resolved as this screen's output leg. A generic
  // "switch to BTC" would be a dead offer, which is why the pointer is not generic.
  test('the OTHER leg of the pair is named and offered when it holds something', async () => {
    const onSwitchAsset = jest.fn();
    // No ICP (currency 8) and 1.2 VCHF (currency 7) — the pair's other side.
    const tree = await mountConvert('0', null, {assetBalances: {8: '0', 7: '120000000'}, onSwitchAsset});
    expect(present(tree, 'convert-fund-other')).toBe(true);
    const line = textOf(tree, 'convert-fund-other-holds');
    expect(line).toContain('1.20000000 VCHF'); // what is actually held, in its own ledger unit
    expect(line).toContain('ICP');            // and what it would become
    const btn = node(tree, 'btn-convert-fund-other');
    expect(btn!.props.accessibilityRole).toBe('button');
    await act(async () => { btn!.props.onPress(); });
    // Switching selects the OTHER leg's asset id, which re-enters Convert with the legs swapped.
    expect(onSwitchAsset).toHaveBeenCalledWith('ic:7');
  });

  test('a pair whose other leg is empty offers nothing — there is no account to point at', async () => {
    const tree = await mountConvert('0', null, {assetBalances: {8: '0', 7: '0'}, onSwitchAsset: jest.fn()});
    expect(present(tree, 'convert-fund')).toBe(true);       // the deposit route is still the answer
    expect(present(tree, 'convert-fund-other')).toBe(false); // …and it is the WHOLE answer
  });

  test('a balance nobody has read is not a zero — nothing is offered on an unknown', async () => {
    // The same fail-open rule the gate itself uses: `assetBalances` simply has no entry yet.
    const tree = await mountConvert('0', null, {assetBalances: {8: '0'}, onSwitchAsset: jest.fn()});
    expect(present(tree, 'convert-fund-other')).toBe(false);
  });

  test('while the selection is LOCKED the account is still named, only the button is withheld', async () => {
    // The Pay pointer's rule: knowledge is not gated on the lock (Wallet passes no callback while
    // an engine holds it, because a mid-flight switch would destroy a captured request).
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
    expect(line).toContain('2.00020000 ICP'); // 2 ICP + the two ledger fees it also costs
    expect(line).toContain('1.00000000 ICP'); // the balance it is measured against
  });

  test('the fee overhead is part of the check: exactly-the-balance is still refused', async () => {
    // A conversion costs amountIn PLUS two input-ledger fees (the approve and the pool's pull),
    // so spending the whole balance can never settle.
    const tree = await mountConvert('100000000', '1');
    expect(present(tree, 'convert-insufficient')).toBe(true);
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
  });

  test('an affordable amount is confirmable', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(present(tree, 'convert-insufficient')).toBe(false);
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(false);
  });
});

describe('C4 — the slippage chips are labelled', () => {
  test('the label renders and the chip group carries an accessible name', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(textOf(tree, 'convert-slippage')).toContain(convertEn.slippageLabel);
    const row = node(tree, 'convert-slippage-chips')!;
    expect(row.props.accessibilityLabel).toBe(convertEn.slippageLabel);
    expect(row.props.accessibilityRole).toBe('radiogroup');
    // each chip states whether it is the chosen one, not just its number
    const chosen = node(tree, 'convert-bps-100')!;
    expect(chosen.props.accessibilityState).toEqual({selected: true});
    expect(node(tree, 'convert-bps-300')!.props.accessibilityState).toEqual({selected: false});
  });
});

describe('C5 — hierarchy, with every §5 disclosure kept', () => {
  test('the headline states what the user receives', async () => {
    const tree = await mountConvert('250000000', '1');
    const headline = textOf(tree, 'convert-headline');
    expect(headline).toContain('0.41184138 VCHF'); // the net end-state amount, as the headline
    expect(headline).toContain(convertEn.receiveHeadline);
  });

  test('not one spec §5 disclosure line was dropped by the restructure', async () => {
    const tree = await mountConvert('250000000', '1');
    for (const id of [
      'convert-counterparty', 'convert-quote-source', 'convert-rate', 'convert-pool-fee',
      'convert-in-fee', 'convert-out-fee', 'convert-dpay-fee', 'convert-impact',
      'convert-min-out', 'convert-refusal', 'convert-net',
    ]) {
      expect(`${id}: ${present(tree, id)}`).toBe(`${id}: true`);
    }
    // the counterparty disclosure still names the venue, what it is not, and who signs
    const cp = textOf(tree, 'convert-counterparty');
    expect(cp).toContain('ICPSwap');
    expect(cp).toContain('65mrh-fqaaa-aaaar-qapoa-cai');
    expect(cp).toContain('not a licensed provider and not dpay');
    expect(cp).toContain('Your phone signs');
  });

  test('the pool principal is its own line, so it can never wrap mid-token', async () => {
    const tree = await mountConvert('250000000', '1');
    // Exactly ONE Text element carries it, and it carries nothing else — so the 27-character
    // hyphenated principal is a line, not a run inside a wrapping paragraph.
    const principals = tree.root.findAllByType(Text).filter(n => n.props.testID === 'convert-pool-principal');
    expect(principals).toHaveLength(1);
    expect(textOf(tree, 'convert-pool-principal').trim()).toBe('65mrh-fqaaa-aaaar-qapoa-cai');
  });
});
