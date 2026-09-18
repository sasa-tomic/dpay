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
  prepareHubConvertRecord: jest.fn(),
}));

// The burn-side rail services (gas quote + ledger fee): the minter's live figure is part of
// the route census and its preflight, and must be mockable per test.
jest.mock('../services/rail', () => ({
  submitTransfer: jest.fn(),
  fetchGasFeeWei: jest.fn(),
  fetchLedgerFee: jest.fn(),
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
}));

import {ConvertMode} from '../components/ConvertMode';
import {convertRecordMinOut, deriveConvertMath, fetchConvertQuote, prepareConvertRecord, prepareHubConvertRecord, prepareMultihopConvertRecord} from '../convert';
import {acknowledgeStuckRecord, adoptConvertRecord, convertResumeSnapshot} from '../convertResume';
import {fetchGasFeeWei, fetchLedgerFee} from '../services/rail';
import type {ConvertMath, ConvertQuote, ConvertRecord} from '../convert';
import {buildSelectableAssets} from '../config/assets';
import type {Identity} from '../lib/types';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {BUNDLED_VENUES, setRuntimeVenues, type VenueEntry} from '../config/venues';
import {convertEn} from '../i18n/domains/en/convert';
import {formatClock} from '../i18n/intl';
import {convertDe} from '../i18n/domains/de/convert';
import {convertEs} from '../i18n/domains/es/convert';
import {convertFr} from '../i18n/domains/fr/convert';
import {fmtAssetCompact} from '../lib/format';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: false, solanaTokens: false});
const ICP_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 8)!;
const IDENTITY: Identity = {secretHex: 'aa'.repeat(32), publicHex: 'bb'.repeat(32), username: 'tester'};

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
  jest.mocked(fetchGasFeeWei).mockResolvedValue('78000000000000'); // the fake-IC minter's 78e12 wei
  jest.mocked(fetchLedgerFee).mockResolvedValue('2000000000000'); // ckETH ledger fee
});

describe('C1 — the unit is printed exactly once on every money line', () => {
  test('balance and minimum carry ONE unit on the main surface; the fee census folds behind Details', async () => {
    const tree = await mountConvert('250000000', '1');
    // The input leg's unit (ICP) and the output leg's (VCHF) each appear once per money line.
    expect(occurrences(textOf(tree, 'convert-balance'), 'ICP')).toBe(1);
    expect(occurrences(textOf(tree, 'convert-min-out'), 'VCHF')).toBe(1);
    // …and the amounts themselves are the compact formatter's strings (trailing zeros trimmed).
    expect(textOf(tree, 'convert-balance')).toContain('2.5 ICP');
    expect(textOf(tree, 'convert-min-out')).toContain('0.40782196 VCHF');
    // The fee census folds behind the ONE Details control (10x-verbosity pass 2026-09-16);
    // open it and the per-side fee lines still carry exactly one unit each. The old net
    // end-state line is GONE — the headline number IS the end state.
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
        d.minReceiveLine('9.99 VCHF', '1%'),
        d.doneBody('9.99 VCHF'),
      ];
      for (const line of lines) {
        expect(`${locale}: ${line}`).not.toContain('undefined');
        expect(`${locale}: ${line}`.match(/9\.99 (ICP|VCHF)/g)).toHaveLength(1);
        // the amount is stated once and no bare unit trails it
        expect(`${locale}: ${line}`).not.toMatch(/9\.99 (ICP|VCHF) \1/);
      }
      // 'ICP' alone is not countable here — the venue's registry display name may CONTAIN a unit
      // token, and naming the counterparty is a §5 requirement. Count the FORMATTED amounts
      // instead: each must appear exactly once, with no bare unit trailing it.
      const signed = d.stuckSigned('9.99 ICP', '4.44 VCHF', 'ICPSwap');
      expect(occurrences(signed, '9.99 ICP')).toBe(1);
      expect(occurrences(signed, '4.44 VCHF')).toBe(1);
      expect(signed).not.toMatch(/9\.99 ICP ICP|4\.44 VCHF VCHF/);
    }
  });
});

describe('C2 — the venue publishes no price impact, and none is invented', () => {
  test('NO impact line renders: not a number, not a placeholder, nothing', async () => {
    // 2026-09-11 (spec V8: display what the venue publishes): the impact line was REMOVED —
    // it was dpay's own curve-slope estimate from a second reference quote, presented beside
    // venue facts. The execution protection (minimum received + slippage) stays; impact does
    // not. A re-introduced line — placeholder, number, or "unmeasurable" sentence — is RED.
    const tree = await mountConvert('250000000', '1');
    expect(present(tree, 'convert-impact')).toBe(false);
    expect(present(tree, 'convert-impact-warn')).toBe(false);
    // …and no Text anywhere on the screen claims an impact at all.
    const flat = (c: unknown): string =>
      Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
    const allText = tree.root.findAllByType(Text).map(n => flat(n.props.children)).join(' ');
    expect(allText).not.toContain('Price impact');
    expect(allText).not.toContain('impact');
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
    expect(line).toContain('1.2 VCHF'); // what is actually held, in its own ledger unit
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
    expect(line).toContain('2.0002 ICP'); // 2 ICP + the two ledger fees it also costs
    expect(line).toContain('1 ICP'); // the balance it is measured against
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

  test('not one §5 census fact was dropped by the verbosity pass — they fold behind Details', async () => {
    const tree = await mountConvert('250000000', '1');
    // Main surface: the decision facts. The net end-state line is GONE (the headline IS the
    // end state) and dpay's paid-nothing line is GONE from every locale and render site.
    expect(present(tree, 'convert-details')).toBe(true);
    for (const id of ['convert-min-out', 'convert-slippage', 'convert-quote-source']) {
      expect(`${id}: ${present(tree, id)}`).toBe(`${id}: true`);
    }
    expect(present(tree, 'convert-net')).toBe(false);
    expect(present(tree, 'convert-dpay-fee')).toBe(false);
    // impact is the ONE §5-era line that is deliberately gone (V8, 2026-09-11): the venue
    // publishes no such figure, so the checklist must not render one.
    expect(present(tree, 'convert-impact')).toBe(false);
    // One tap opens the census: every folded §5 fact is still rendered.
    await openDetails(tree);
    for (const id of [
      'convert-counterparty', 'convert-rate', 'convert-pool-fee',
      'convert-in-fee', 'convert-out-fee', 'convert-venue-disclosure',
      'convert-refusal',
    ]) {
      expect(`${id}: ${present(tree, id)}`).toBe(`${id}: true`);
    }
    // the counterparty disclosure names the venue, its pool, and who signs — trimmed to bare
    // attribution (the licensing tail is gone; quoteSource carries whose quote this is)
    const cp = textOf(tree, 'convert-counterparty');
    expect(cp).toContain('ICPSwap');
    expect(cp).toContain('65mrh-fqaaa-aaaar-qapoa-cai');
    expect(cp).toContain('Your phone signs');
    expect(cp).not.toContain('not a licensed provider and not dpay');
  });

  test('the displayed rate is EXACTLY the derivation of the venue\'s own reply digits', async () => {
    // scaledRate (ConvertMode) = out×1e8÷in, floored — recomputed here independently so the
    // rendered string is pinned to the pure derivation, never to a hand-copied literal.
    const tree = await mountConvert('250000000', '1');
    const scaled = (BigInt(QUOTE.amountOutGross) * 10n ** 8n) / BigInt(QUOTE.amountIn);
    const expected = fmtAssetCompact(scaled.toString(), 8, 'VCHF');
    expect(expected).toBe('0.41194138 VCHF'); // 41194138e8 / 100000000 — the derivation itself
    await openDetails(tree); // the rate folds behind Details (10x-verbosity pass 2026-09-16)
    expect(textOf(tree, 'convert-rate')).toContain(expected);
    expect(textOf(tree, 'convert-rate')).toContain(convertEn.rateLabel('ICP', 'VCHF'));
  });

  test('the single-venue disclosure renders from the registry key, exactly once', async () => {
    const tree = await mountConvert('250000000', '1');
    // The bundled venue's disclosure_key is 'icpswap' (dfx/catalog_truth.json venues[]) — the
    // known sentence, not the generic fallback, and only ONE Text carries it (counted by type:
    // RN mirrors testID onto the host layer under a Text, so raw findAll double-counts).
    await openDetails(tree); // the disclosure folds behind Details (verbosity pass 2026-09-16)
    const expected = convertEn.disclosures.byKey.icpswap('ICPSwap');
    expect(textOf(tree, 'convert-venue-disclosure').trim()).toBe(expected);
    expect(tree.root.findAllByType(Text).filter(n => n.props.testID === 'convert-venue-disclosure')).toHaveLength(1);
  });

  test('the pool principal is its own line, so it can never wrap mid-token', async () => {
    const tree = await mountConvert('250000000', '1');
    // Exactly ONE Text element carries it, and it carries nothing else — so the 27-character
    // hyphenated principal is a line, not a run inside a wrapping paragraph. It lives behind
    // the Details control (verbosity pass 2026-09-16); open it first.
    await openDetails(tree);
    const principals = tree.root.findAllByType(Text).filter(n => n.props.testID === 'convert-pool-principal');
    expect(principals).toHaveLength(1);
    expect(textOf(tree, 'convert-pool-principal').trim()).toBe('65mrh-fqaaa-aaaar-qapoa-cai');
  });
});

// --- V5 — the venue chooser, when the relay serves TWO venues on the pair -------------------------
// The three red lines (spec 2026-09-08), pinned as STRUCTURAL facts of the rendered screen:
//   (1) rows keep REGISTRY order no matter what they quote (never sorted by output);
//   (2) nothing is preselected — no row is picked, no "obviously better" venue is highlighted;
//   (3) no last-used memory — the amount can change, the quotes can swap places, and the
//       selection stays exactly what the user tapped (here: still nothing, mid-test).
// The two-venue world is simulated by arming the runtime overlay (setRuntimeVenues) with the
// real bundled icpswap entry plus the offline fixture venue `icpswap-fixture-b` — the same
// second venue the test-helpers relay serves behind POST /api/v1/test/venue.
describe('V5 — the venue chooser (two venues on one pair)', () => {
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
    amountOutGross: '90000000', // B quotes BETTER than A's 41194138 — and must still render SECOND
    feeMillionths: 1000,
  };
  const MATH_B: ConvertMath = {
    ...MATH,
    grossOut: '90000000',
    minOut: '89100000',
    netOut: '89990000',
  };
  const REC_B: ConvertRecord = {
    id: 'rec-b',
    createdAtMs: 0,
    step: 'approving',
    venueId: VENUE_B.venue_id,
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
    legs: [],
  };

  /** The row testIDs in RENDER order — the never-rank red line, read straight off the tree.
   *  RN's Pressable mirrors testID onto its internal wrapper layers, so duplicates appear in
   *  `findAll`; what matters (and what is asserted) is the ORDER OF FIRST APPEARANCE. */
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

  let quoteForB = '90000000';
  let quoteForA = QUOTE_A.amountOutGross;

  beforeEach(() => {
    setRuntimeVenues([VENUE_A, VENUE_B]);
    quoteForB = '90000000';
    quoteForA = QUOTE_A.amountOutGross;
    jest.mocked(fetchConvertQuote).mockImplementation((async (_r: string, _in: string, _out: string, _amt: string, opts?: {venue?: VenueEntry}) =>
      Promise.resolve(opts?.venue?.venue_id === VENUE_B.venue_id
        ? {...QUOTE_B, amountOutGross: quoteForB}
        : {...QUOTE_A, amountOutGross: quoteForA}) as never));
    jest.mocked(deriveConvertMath).mockImplementation((async (q: ConvertQuote) =>
      (q.venueId === VENUE_B.venue_id ? {...MATH_B, grossOut: q.amountOutGross} : MATH) as never));
    jest.mocked(prepareConvertRecord).mockResolvedValue(REC_B as never);
    jest.mocked(adoptConvertRecord).mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    setRuntimeVenues(null); // never leak the two-venue overlay into the C1–C5 suites
    jest.mocked(convertResumeSnapshot).mockReturnValue({});
  });

  test('two rows render, in registry order, NONE preselected; confirm + headline stay withheld', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(present(tree, 'convert-venues')).toBe(true);
    expect(rowOrder(tree)).toEqual([`convert-venue-${VENUE_A.venue_id}`, `convert-venue-${VENUE_B.venue_id}`]);
    // B quotes better (0.90000000 vs 0.41194138) yet stays row 2 — the never-rank red line.
    expect(textOf(tree, `convert-venue-${VENUE_B.venue_id}-quote`)).toContain('0.9 VCHF');
    // NOTHING is selected: both rows radio-off, the none-selected line shows, and the decision
    // surfaces (headline, checklist, confirm) that follow a pick are all absent/disabled.
    for (const id of [VENUE_A.venue_id, VENUE_B.venue_id]) {
      expect(node(tree, `convert-venue-${id}`)!.props.accessibilityState).toEqual({checked: false});
    }
    expect(present(tree, 'convert-venue-none')).toBe(true);
    expect(textOf(tree, 'convert-venue-none')).toContain(convertEn.venueNoneSelected);
    expect(present(tree, 'convert-headline')).toBe(false);
    // The checklist card carries no testID of its own — its absence is proven by its lines.
    expect(present(tree, 'convert-counterparty')).toBe(false);
    expect(present(tree, 'convert-venue-disclosure')).toBe(false); // no pick → no disclosure
    expect(present(tree, 'convert-min-out')).toBe(false);
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
  });

  test('row order + no-selection survive the quotes SWAPPING places (never ranked, never remembered)', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(rowOrder(tree)).toEqual([`convert-venue-${VENUE_A.venue_id}`, `convert-venue-${VENUE_B.venue_id}`]);
    // Flip which venue quotes better — A now far above B — and re-key the amount to refetch.
    quoteForA = '90000000';
    quoteForB = '20000000';
    await act(async () => {
      node(tree, 'convert-amount')!.props.onChangeText('12');
    });
    expect(textOf(tree, `convert-venue-${VENUE_A.venue_id}-quote`)).toContain('0.9 VCHF');
    expect(textOf(tree, `convert-venue-${VENUE_B.venue_id}-quote`)).toContain('0.2 VCHF');
    // The refetch really happened (values above prove it) and the order did NOT move.
    expect(rowOrder(tree)).toEqual([`convert-venue-${VENUE_A.venue_id}`, `convert-venue-${VENUE_B.venue_id}`]);
    // Still nothing selected: no last-used default appears just because rates diverged.
    for (const id of [VENUE_A.venue_id, VENUE_B.venue_id]) {
      expect(node(tree, `convert-venue-${id}`)!.props.accessibilityState).toEqual({checked: false});
    }
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
  });

  test('picking fixture B executes through pool B: headline + counterparty follow the pick, record carries venueId', async () => {
    const tree = await mountConvert('250000000', '1');
    await act(async () => {
      node(tree, `convert-venue-${VENUE_B.venue_id}`)!.props.onPress();
    });
    // The decision surfaces appear under the pick and quote venue B's OWN numbers.
    expect(present(tree, 'convert-venue-none')).toBe(false);
    expect(node(tree, `convert-venue-${VENUE_B.venue_id}`)!.props.accessibilityState).toEqual({checked: true});
    expect(node(tree, `convert-venue-${VENUE_A.venue_id}`)!.props.accessibilityState).toEqual({checked: false});
    expect(textOf(tree, 'convert-headline')).toContain('0.8999 VCHF');
    await openDetails(tree); // the pool principal folds behind Details (verbosity pass)
    expect(textOf(tree, 'convert-pool-principal').trim()).toBe(FIXTURE_POOL); // B's pool, not A's
    // Confirm re-quotes the PICKED venue only and executes through it.
    await act(async () => {
      node(tree, 'btn-convert-confirm')!.props.onPress();
    });
    expect(jest.mocked(prepareConvertRecord).mock.calls.length).toBe(1);
    const arg = jest.mocked(prepareConvertRecord).mock.calls[0][0] as {quote: ConvertQuote};
    expect(arg.quote.venueId).toBe(VENUE_B.venue_id);
    expect(arg.quote.pool).toBe(FIXTURE_POOL);
    expect(jest.mocked(adoptConvertRecord).mock.calls.length).toBe(1); // handed to the ENGINE
    expect(jest.mocked(adoptConvertRecord).mock.calls[0][0]).toBe(REC_B); // the record it prepared
    // The screen moved to the state panel for a record whose venue is B (looked-up facts follow it).
    expect(present(tree, 'convert-approving')).toBe(true);
  });

  test('the PICKED venue\'s disclosure renders once, from its own registry disclosure_key', async () => {
    const tree = await mountConvert('250000000', '1');
    // Before a pick the checklist is withheld, so the disclosure is too (pinned above); under
    // the pick it is B's OWN key ('icpswap' — the fixture carries the same key as the real
    // venue, so the sentence must name B, proving it followed the pick and not a default).
    await act(async () => {
      node(tree, `convert-venue-${VENUE_B.venue_id}`)!.props.onPress();
    });
    await openDetails(tree); // the disclosure folds behind Details (verbosity pass)
    const expected = convertEn.disclosures.byKey.icpswap(VENUE_B.display_name);
    expect(textOf(tree, 'convert-venue-disclosure').trim()).toBe(expected);
    expect(tree.root.findAllByType(Text).filter(n => n.props.testID === 'convert-venue-disclosure')).toHaveLength(1);
    // The disclosure is CHECKLIST-ONLY (V8): the chooser rows never repeat it — two rows would
    // otherwise render the same sentence twice on one screen.
    expect(textOf(tree, 'convert-venues')).not.toContain(expected);
  });

  test('the two-venue rate follows the PICKED venue\'s own reply digits', async () => {
    const tree = await mountConvert('250000000', '1');
    await act(async () => {
      node(tree, `convert-venue-${VENUE_B.venue_id}`)!.props.onPress();
    });
    // B's own quote: 90000000 out for 100000000 in ⇒ scaled 90000000 ⇒ exactly this string.
    const scaled = (BigInt(QUOTE_B.amountOutGross) * 10n ** 8n) / BigInt(QUOTE_B.amountIn);
    await openDetails(tree); // the rate folds behind Details (verbosity pass)
    expect(textOf(tree, 'convert-rate')).toContain(fmtAssetCompact(scaled.toString(), 8, 'VCHF'));
    expect(textOf(tree, 'convert-rate')).toContain('0.9 VCHF');
  });

  test('a picked-but-unquoted venue is attributed HONESTLY — never another venue\'s name or pool', async () => {
    // The gap this pins (audit 2026-09-11): venue B's quote ERRORED while the user has B picked
    // (the same shape as a quote still in flight or cleared by a re-key). Nothing can sign
    // (canConfirm needs a live quote) — but the PRE-SIGN disclosure used to fall back to the
    // registered default, naming venue A + A's pool under a B pick. The honest shape: B's own
    // name on the counterparty and disclosure lines, and NO pool principal at all until B's own
    // number stands behind it — never another venue's principal.
    jest.mocked(fetchConvertQuote).mockImplementation((async (_r: string, _in: string, _out: string, _amt: string, opts?: {venue?: VenueEntry}) =>
      opts?.venue?.venue_id === VENUE_B.venue_id
        ? Promise.reject(new Error('venue B unreachable'))
        : Promise.resolve({...QUOTE_A, amountOutGross: quoteForA}) as never));
    const tree = await mountConvert('250000000', '1');
    // B's row carries its OWN error line; the pick still lands (a pick is a user decision).
    expect(present(tree, `convert-venue-${VENUE_B.venue_id}-err`)).toBe(true);
    await act(async () => {
      node(tree, `convert-venue-${VENUE_B.venue_id}`)!.props.onPress();
    });
    expect(node(tree, `convert-venue-${VENUE_B.venue_id}`)!.props.accessibilityState).toEqual({checked: true});
    // The counterparty + disclosure name the PICKED venue — B, not the registered default A.
    await openDetails(tree); // they fold behind Details (verbosity pass 2026-09-16)
    expect(textOf(tree, 'convert-counterparty')).toContain(VENUE_B.display_name);
    expect(textOf(tree, 'convert-venue-disclosure').trim()).toBe(convertEn.disclosures.byKey.icpswap(VENUE_B.display_name));
    // No pool principal renders, and venue A's pool appears NOWHERE on the screen — the old
    // fallback printed it inside the counterparty card. Full-text dump proves the absence.
    expect(present(tree, 'convert-pool-principal')).toBe(false);
    const flat = (c: unknown): string =>
      Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
    const allText = tree.root.findAllByType(Text).map(n => flat(n.props.children)).join('\n');
    expect(allText).not.toContain(QUOTE_A.pool);
    // And nothing can sign on another venue's behalf: the confirm stays disabled.
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
  });
});

// --- V9 — venue-agnostic chooser invariants: arbitrary venue sets through the overlay seam ----------
// Waves 1–3 pinned the chooser against exactly two known venues; V9's ask is that NOTHING here
// knows the venue count or names. Every set below is injected through setRuntimeVenues (the same
// seam loadVenueRegistry arms in production), incl. a rank-bait-hostile display name — so a
// crossing by ANY future venue (a third, a fourth, a nastily-named one) fails these, not just
// icpswap. INV-4's relay half is in tests/relay.rs, its quote-mapping half in venueInvariants.
describe('V9 — chooser invariants parametric over arbitrary venue sets', () => {
  // Self-contained fixture set (the V5 describe above keeps its own): bundled A + fixture B +
  // an invented hostile C. Nothing outside this block knows these venues — that is the point.
  const VENUE_A = BUNDLED_VENUES.find(v => v.venue_id === 'icpswap')!;
  const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7';
  const VENUE_B: VenueEntry = {
    venue_id: 'icpswap-fixture-b',
    display_name: 'ICPSwap (offline fixture)',
    kind: 'ic_amm',
    endpoint: POOL_B,
    pair_ledgers: [QUOTE.tokenInLedger, QUOTE.tokenOutLedger],
    testnet: true,
    disclosure_key: 'icpswap',
  };
  const POOL_C = '2xh5b-7xkab-aaaaa-qbkcq-cai'; // invented — a hostile third venue's "pool"
  const VENUE_C: VenueEntry = {
    venue_id: 'hostile-rankbait',
    display_name: 'Best Rate Swap ⚡ Zero Fees', // rank-bait: nothing may sort/rank/label by it
    kind: 'ic_amm',
    endpoint: POOL_C,
    pair_ledgers: [QUOTE.tokenInLedger, QUOTE.tokenOutLedger],
    testnet: false,
    disclosure_key: 'icpswap',
  };
  const QUOTE_A = QUOTE;
  const QUOTE_B: ConvertQuote = {...QUOTE, venueId: VENUE_B.venue_id, pool: POOL_B, amountOutGross: '90000000', feeMillionths: 1000};
  const QUOTE_C: ConvertQuote = {...QUOTE, venueId: VENUE_C.venue_id, pool: POOL_C, amountOutGross: '70000000', feeMillionths: 4321};
  const MATH_A = MATH;
  const MATH_B: ConvertMath = {...MATH, grossOut: '90000000', minOut: '89100000', netOut: '89990000'};
  const MATH_C: ConvertMath = {...MATH, grossOut: '70000000', minOut: '69300000', netOut: '69990000'};
  const REC_ANY: ConvertRecord = {
    id: 'rec-v9',
    createdAtMs: 0,
    step: 'approving',
    venueId: VENUE_B.venue_id,
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
    legs: [],
  };

  // Distinct outputs per venue: A 0.41194138 < C 0.70000000 < B 0.90000000 — the ordering the
  // rows must NOT follow (registry order wins over every rank-bait temptation).
  const QUOTES: Record<string, ConvertQuote> = {
    [VENUE_A.venue_id]: QUOTE_A,
    [VENUE_B.venue_id]: QUOTE_B,
    [VENUE_C.venue_id]: QUOTE_C,
  };
  const MATHS: Record<string, ConvertMath> = {
    [VENUE_A.venue_id]: MATH_A,
    [VENUE_B.venue_id]: MATH_B,
    [VENUE_C.venue_id]: MATH_C,
  };
  const SETS: ReadonlyArray<readonly VenueEntry[]> = [
    [VENUE_A, VENUE_B],
    [VENUE_A, VENUE_B, VENUE_C],
  ];

  /** Row testIDs in render order for an ARBITRARY venue set (first appearance dedup — RN's
   *  Pressable mirrors testID onto wrapper layers). */
  const rowOrderOf = (tree: renderer.ReactTestRenderer, venues: readonly VenueEntry[]): string[] => {
    const wanted = venues.map(v => `convert-venue-${v.venue_id}`);
    const seen: string[] = [];
    for (const n of tree.root.findAll(
      (x: {props?: {testID?: unknown}}) => x.props != null && wanted.includes(String(x.props.testID)),
    )) {
      const id = String(n.props.testID);
      if (!seen.includes(id)) seen.push(id);
    }
    return seen;
  };

  beforeEach(() => {
    jest.mocked(fetchConvertQuote).mockImplementation((async (_r: string, _in: string, _out: string, _amt: string, opts?: {venue?: VenueEntry}) =>
      Promise.resolve(QUOTES[opts?.venue?.venue_id ?? ''] ?? QUOTE_A) as never));
    jest.mocked(deriveConvertMath).mockImplementation((async (q: ConvertQuote) =>
      (MATHS[q.venueId] ?? MATH_A) as never));
    jest.mocked(prepareConvertRecord).mockResolvedValue(REC_ANY as never);
    jest.mocked(adoptConvertRecord).mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    setRuntimeVenues(null);
  });

  describe.each(SETS.map(venues => [String(venues.length), venues] as const))
  ('%s-venue registry (INV-5: registry order, no preselection, hostile names included)', (_n, venues) => {
    beforeEach(() => {
      setRuntimeVenues(venues);
    });

    test('rows render in REGISTRY order — never by quote, name, or kind', async () => {
      const tree = await mountConvert('250000000', '1');
      expect(rowOrderOf(tree, venues)).toEqual(venues.map(v => `convert-venue-${v.venue_id}`));
      // The hostile display name renders as the row's own label — registry-driven, not whitelisted.
      if (venues.some(v => v.venue_id === VENUE_C.venue_id)) {
        expect(textOf(tree, `convert-venue-${VENUE_C.venue_id}`)).toContain(VENUE_C.display_name);
      }
    });

    test('nothing is preselected for ANY set: every radio off, confirm withheld, no headline', async () => {
      const tree = await mountConvert('250000000', '1');
      for (const v of venues) {
        expect(node(tree, `convert-venue-${v.venue_id}`)!.props.accessibilityState).toEqual({checked: false});
      }
      expect(present(tree, 'convert-venue-none')).toBe(true);
      expect(present(tree, 'convert-headline')).toBe(false);
      expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
    });

    test('INV-4 render half: each row shows ITS OWN venue reply, byte-identical to the echo', async () => {
      const tree = await mountConvert('250000000', '1');
      for (const v of venues) {
        // The "Quote: " prefix is GONE (verbosity pass 2026-09-16): the row is the venue's
        // name and the compact amount, nothing else.
        const expected = fmtAssetCompact(QUOTES[v.venue_id]!.amountOutGross, 8, 'VCHF');
        expect(textOf(tree, `convert-venue-${v.venue_id}-quote`).trim()).toBe(expected);
        expect(textOf(tree, `convert-venue-${v.venue_id}-quote`)).not.toContain('Quote:');
      }
    });

    test('INV-6 (verbosity pass): the dpay-paid-nothing line is GONE under every pick; the census is one tap away', async () => {
      const tree = await mountConvert('250000000', '1');
      for (const v of venues) {
        await act(async () => {
          node(tree, `convert-venue-${v.venue_id}`)!.props.onPress();
        });
        // The line was deleted from every locale and every render site (10x-verbosity pass
        // 2026-09-16); attribution lives with quoteSource on the headline.
        expect(present(tree, 'convert-dpay-fee')).toBe(false);
        expect(present(tree, 'convert-net')).toBe(false);
        // the Details control is present under every pick; opening it reveals the census
        expect(present(tree, 'convert-details')).toBe(true);
        await openDetails(tree);
        expect(present(tree, 'convert-counterparty')).toBe(true);
        await act(async () => {
          node(tree, 'convert-details')!.props.onPress(); // re-close for the next pick
        });
      }
    });
  });

  // The registry's disclosure_key is DATA: a venue this catalog has no sentence for (a newer
  // relay serving a key this build never shipped) must still get an HONEST generic disclosure —
  // fail closed, never blank, never a guess at the unknown venue's nature.
  test('unknown disclosure_key falls back to the generic sentence, naming the venue', async () => {
    const POOL_D = 'b7d2z-qzdqb-aaaaa-qbzkq-cai'; // invented — carries a key no locale knows
    const VENUE_D: VenueEntry = {
      venue_id: 'venue-unknown-key',
      display_name: 'Mystery Venue',
      kind: 'ic_amm',
      endpoint: POOL_D,
      pair_ledgers: [QUOTE.tokenInLedger, QUOTE.tokenOutLedger],
      testnet: false,
      disclosure_key: 'no-such-key',
    };
    setRuntimeVenues([VENUE_A, VENUE_D]); // overrides the describe.each overlay for this test
    jest.mocked(fetchConvertQuote).mockImplementation((async (_r: string, _in: string, _out: string, _amt: string, opts?: {venue?: VenueEntry}) =>
      Promise.resolve(opts?.venue?.venue_id === VENUE_D.venue_id
        ? {...QUOTE, venueId: VENUE_D.venue_id, pool: POOL_D}
        : QUOTE) as never));
    jest.mocked(deriveConvertMath).mockImplementation((async () => MATH as never));
    const tree = await mountConvert('250000000', '1');
    await act(async () => {
      node(tree, `convert-venue-${VENUE_D.venue_id}`)!.props.onPress();
    });
    await openDetails(tree); // the disclosure folds behind Details (verbosity pass)
    expect(textOf(tree, 'convert-venue-disclosure').trim()).toBe(convertEn.disclosures.generic(VENUE_D.display_name));
    expect(textOf(tree, 'convert-venue-disclosure')).not.toContain(convertEn.disclosures.byKey.icpswap(VENUE_D.display_name));
  });
});

// --- V6 — the screen is a VIEW onto the engine, never a private executor --------------------------
// The resume engine (app/convertResume.ts, mounted from Wallet) owns all driving. What the screen
// owes the user: the newest live record renders ON OPEN (no private store read, no adoption),
// the stuck unknown stays honestly watchable, and the acknowledge gesture reaches the engine.
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

  test('a live record in the engine snapshot renders its state panel on open — no private resume', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({[liveRecord.id]: liveRecord});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-approving')).toBe(true);
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
    // The user acknowledges; the engine persists + notifies, and the panel answers:
    await act(async () => {
      mockEngineSub.cb?.({[stuckRecord.id]: {...stuckRecord, acknowledgedStuckAtMs: 123}});
    });
    expect(textOf(tree, 'convert-stuck')).toContain(convertEn.stuckAcknowledged);
    expect(present(tree, 'btn-convert-stuck-ack')).toBe(false);
  });
});

// --- decimals threading (audit 2026-09-11) ---------------------------------------------------------
// The record freezes each leg's ledger decimals at prepare; the state screens and the rate line
// read THEM, falling back to 8 only for records that predate the field (the e8s world every IC
// ledger lives in today). These pins hold the threading: a 6-decimal output ledger renders
// 6-decimal money and a 6-decimal-scaled rate, a legacy record still renders 8 — and no literal
// 8 survives anywhere a ledger fact is available.
describe('decimals threading — money lines read the ledger, never a literal 8', () => {
  // A 6-decimal output ledger (the shape of a future non-e8s pair): the same flat descriptor
  // list with the VCHF row's decimals overridden — legs, fmtAsset and scaledRate must follow.
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
    // 41194138 gross for 100000000 in (= 1.0 ICP at 8 decimals): the rate is out-per-display-in,
    // so the IN scale normalizes the raw ratio — (41194138 × 10^8) / 10^8 = 41194138 raw ⇒
    // "41.194138 VCHF" rendered at the output ledger's SIX decimals. A literal-8 RENDERING
    // instead yields "0.41194138 VCHF", and an OUT-scale normalization (the pre-2026-09-15
    // latent form, exposed by the first cross-decimal pair SOL 9 → USDC 6) reads 1000× off.
    const scaled = (BigInt(QUOTE.amountOutGross) * 10n ** 8n) / BigInt(QUOTE.amountIn);
    await openDetails(tree); // the rate folds behind Details (verbosity pass 2026-09-16)
    expect(textOf(tree, 'convert-rate')).toContain(fmtAssetCompact(scaled.toString(), 6, 'VCHF'));
    expect(textOf(tree, 'convert-rate')).toContain('41.194138 VCHF');
  });

  test('a record with frozen decimals renders its state money at THEM (approving, input side)', async () => {
    jest.mocked(convertResumeSnapshot).mockReturnValue({dec6: {...stateRecord, inDecimals: 6, outDecimals: 6}});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-approving')).toBe(true);
    // amountIn 100000000 raw at SIX decimals = 100.000000 ICP; a literal-8 regression prints
    // 1.00000000 ICP — a 100× lie about what was approved.
    expect(textOf(tree, 'convert-approving')).toContain('100 ICP');
  });

  test('the stuck panel carries BOTH legs\' frozen decimals (signed amount in, minimum out)', async () => {
    jest.mocked(convertRecordMinOut).mockResolvedValue('40782196' as never);
    jest.mocked(convertResumeSnapshot).mockReturnValue({stuck6: {...stateRecord, step: 'stuck', failureCode: 'unknown', inDecimals: 6, outDecimals: 6}});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-stuck')).toBe(true);
    // minOut 40782196 raw at SIX decimals = 40.782196 VCHF (literal-8 regression: 0.40782196).
    expect(textOf(tree, 'convert-stuck')).toContain('100 ICP');
    expect(textOf(tree, 'convert-stuck')).toContain('40.782196 VCHF');
  });

  test('a record that predates the fields (the legacy e8s world) falls back to 8 — the renderer owns it', async () => {
    jest.mocked(convertRecordMinOut).mockResolvedValue('40782196' as never);
    jest.mocked(convertResumeSnapshot).mockReturnValue({legacy: {...stateRecord, step: 'stuck', failureCode: 'unknown'}});
    const tree = await mountConvert('250000000', null);
    expect(present(tree, 'convert-stuck')).toBe(true);
    // No decimals on the record ⇒ 8 (today's IC reality), never a crash or a blank line.
    expect(textOf(tree, 'convert-stuck')).toContain('1 ICP');
    expect(textOf(tree, 'convert-stuck')).toContain('0.40782196 VCHF');
  });
});

/**
 * Multi-hop Route A (2026-09-14 spec): the composed destination is an explicit, gated opt-in.
 * These pin the three gates the founder rule demands BEFORE anything is signed — the
 * destination picker (nothing preselected, route is an explicit pick), the address input
 * (never signed unvalidated), and the ckETH-gas preflight (a KNOWN shortfall names the
 * requirement in copy; an unknown balance stays fail-open, per spec §6).
 */
describe('multihop — the composed destination is an explicit, gated opt-in', () => {
  const ROUTE_ROW = 'convert-dest-route-multihop:icpswap-ckusdc:2';
  const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();

  test('the picker lists the direct pair (the standing default) plus every composed route; the one-route honesty line only speaks when it is literally true', async () => {
    const tree = await mountConvert('250000000', '1');
    expect(present(tree, 'convert-dest')).toBe(true);
    expect(present(tree, 'convert-dest-direct')).toBe(true);
    expect(present(tree, ROUTE_ROW)).toBe(true);
    // The ckUSDC hop composes THREE routes today (A burn-withdraw, B +CCTP, C +CCTP+Jupiter —
    // the 2026-09-16 cross-rail widening) — all three are explicit picks, none preselected.
    expect(present(tree, 'convert-dest-route-multihop:icpswap-ckusdc:2:cctp')).toBe(true);
    expect(present(tree, 'convert-dest-route-multihop:icpswap-ckusdc:2:cctp:jupiter')).toBe(true);
    // Three routes ⇒ the "One route is registered…" line would lie; it stays hidden.
    expect(present(tree, 'convert-route-note')).toBe(false);
    // the default surface is UNCHANGED: the direct pair's own checklist, no route census
    expect(present(tree, 'convert-min-out')).toBe(true);
    expect(present(tree, 'convert-route-min')).toBe(false);
    expect(present(tree, 'convert-dest-address')).toBe(false);
  });

  test('opting in swaps the surface: route census, minter principal, gas line, address input', async () => {
    const tree = await mountConvert('250000000', '1');
    await act(async () => {
      node(tree, ROUTE_ROW)!.props.onPress();
    });
    expect(present(tree, 'convert-dest-address')).toBe(true);
    expect(present(tree, 'convert-route-min')).toBe(true);
    expect(present(tree, 'convert-min-out')).toBe(false);
    // The minter principal + gas census fold behind Details (verbosity pass 2026-09-16).
    await openDetails(tree);
    expect(present(tree, 'convert-minter-principal')).toBe(true);
    // the gas leg carries the minter's OWN live figure as its census line
    expect(present(tree, 'convert-gas-note')).toBe(true);
    // a malformed address is flagged in copy, never silently signed
    await act(async () => {
      node(tree, 'convert-dest-address')!.props.onChangeText('0x1234');
    });
    expect(present(tree, 'convert-dest-address-invalid')).toBe(true);
  });

  test('a KNOWN ckETH shortfall blocks the confirm and names the requirement first', async () => {
    const tree = await mountConvert('250000000', '1', {assetBalances: {8: '250000000', 6: '1000000000'}});
    await act(async () => {
      node(tree, ROUTE_ROW)!.props.onPress();
    });
    await act(async () => {
      node(tree, 'convert-dest-address')!.props.onChangeText(DEST);
    });
    expect(present(tree, 'convert-gas-preflight')).toBe(true);
    expect(textOf(tree, 'convert-gas-preflight')).toBe(convertEn.multihop.gasPreflightTitle + ' ' + convertEn.multihop.gasPreflightBody('0.00008 ETH'));
    expect(node(tree, 'btn-convert-confirm')!.props.disabled).toBe(true);
  });

  test('an unknown ckETH balance stays fail-open; a funded one offers the confirm, and confirming prepares the ROUTE record', async () => {
    // unknown: the wallet simply has no ckETH row yet — the requirement is shown, nothing is blocked
    const unknown = await mountConvert('250000000', '1');
    await act(async () => {
      node(unknown, ROUTE_ROW)!.props.onPress();
    });
    await act(async () => {
      node(unknown, 'convert-dest-address')!.props.onChangeText(DEST);
    });
    expect(present(unknown, 'convert-gas-preflight')).toBe(false);
    expect(node(unknown, 'btn-convert-confirm')!.props.disabled).toBe(false);

    // funded: enough ckETH for gas + its approve fee → confirm proceeds to the multihop prepare
    jest.mocked(prepareMultihopConvertRecord).mockResolvedValue({
      id: 'route1', createdAtMs: 1, step: 'approving', venueId: 'icpswap-ckusdc',
      inCurrency: 8, outCurrency: 2, inLedger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', outLedger: 'xevnm-gaaaa-aaaar-qafnq-cai',
      inSymbol: 'ICP', outSymbol: 'USDC', amountIn: '100000000', expectedGross: '1', expectedNet: '1',
      inFee: '10000', outFee: '10000', slippageBps: 100, legs: [], legPlan: [],
    } as never);
    const tree = await mountConvert('250000000', '1', {assetBalances: {8: '250000000', 6: '100000000000000000'}});
    await act(async () => {
      node(tree, ROUTE_ROW)!.props.onPress();
    });
    await act(async () => {
      node(tree, 'convert-dest-address')!.props.onChangeText(DEST);
    });
    expect(present(tree, 'convert-gas-preflight')).toBe(false);
    await act(async () => {
      node(tree, 'btn-convert-confirm')!.props.onPress();
    });
    expect(prepareMultihopConvertRecord).toHaveBeenCalledTimes(1);
    expect(jest.mocked(prepareMultihopConvertRecord).mock.calls[0][0]).toMatchObject({destAddress: DEST});
    expect(adoptConvertRecord).toHaveBeenCalledTimes(1);
  });
});

describe('hub destination — the two-quote composed surface (2026-09-18 hub UX D5–D13)', () => {
  const VCHF_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 7)!;
  const rowOf = (currency: number) => CATALOG.find(c => c.currency === currency)!;
  const VCHF_LEDGER = rowOf(7).ledger!;
  const ICP_LEDGER = rowOf(8).ledger!;
  const CKETH_LEDGER = rowOf(6).ledger!;
  const CKETH_ROW = 'convert-dest-inwallet-6';
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
  /** quote2: ICP → ckETH, amountIn EXACTLY math1.minOut — the composition the engine signs. */
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
  /** The screen renders clocks with non-breaking spaces (nonBreakingClock) — match that. */
  const nbclock = (ms: number): string => formatClock(new Date(ms)).replace(/ /g, '\u00A0');
  const armHubMocks = (): void => {
    jest.mocked(fetchConvertQuote).mockReset();
    jest.mocked(fetchConvertQuote).mockImplementation(async (_relay: string, tin: string, tout: string) => {
      if (tin === VCHF_LEDGER && tout === ICP_LEDGER) return HUB_Q1;
      if (tin === ICP_LEDGER && tout === CKETH_LEDGER) return HUB_Q2;
      throw new Error('unexpected pair ' + tin + ' -> ' + tout);
    });
    // Implementation, not a Once-chain: the effect legitimately re-runs (venue list landing),
    // and every run must derive the same pair — quote1 derives by input ledger (VCHF vs ICP).
    jest.mocked(deriveConvertMath).mockReset();
    jest.mocked(deriveConvertMath).mockImplementation(async (q: ConvertQuote) =>
      q.tokenInLedger === VCHF_LEDGER ? HUB_M1 : HUB_M2);
  };
  const mountHub = async (): Promise<renderer.ReactTestRenderer> => {
    armHubMocks();
    const tree = await mountConvert('250000000', '1', {
      selectedAsset: VCHF_ASSET,
      assetBalances: {7: '250000000'},
    });
    armHubMocks(); // drop the standing-surface direct fetch from the call history
    await act(async () => {
      node(tree, CKETH_ROW)!.props.onPress();
    });
    return tree;
  };

  test('the hub-only row auto-picks its single mechanism and shows the composed two-quote surface', async () => {
    const tree = await mountHub();
    // D7: no address input, no gas preflight — the destination is this wallet.
    expect(present(tree, 'convert-dest-address')).toBe(false);
    expect(present(tree, 'convert-gas-preflight')).toBe(false);
    // D9: the promise is the in-wallet floor of the SECOND swap, never "at your address".
    expect(textOf(tree, 'convert-route-min')).toBe(
      convertEn.multihop.routeMinWalletLine(fmtAssetCompact('2970000000000', 18, 'ETH'), '1%'));
    expect(present(tree, 'convert-min-out')).toBe(false);
    // D12: the form heading names the SELECTED destination (ckETH row's symbol is ETH).
    const headingTexts = tree.root.findAllByType(Text).filter(n => n.props.children === convertEn.heading('VCHF', 'ETH'));
    expect(headingTexts.length).toBeGreaterThanOrEqual(1);
    // D7/D8/D11: "You'll receive" (in-wallet), the composed net estimate, BOTH venues verbatim.
    expect(textOf(tree, 'convert-headline')).toContain(convertEn.receiveHeadline);
    expect(textOf(tree, 'convert-headline')).toContain(fmtAssetCompact('1000000000000', 18, 'ETH'));
    expect(textOf(tree, 'convert-quote-source')).toBe(
      convertEn.multihop.hubQuoteSource('ICPSwap', 'ICPSwap', nbclock(1_700_000_005_000)));
    expect(textOf(tree, 'convert-route-via')).toBe(convertEn.multihop.viaHub('ICP'));
    // D10: the per-hop census folds in the SAME Details — both hops, each with its own
    // approve fee line and its own quoteSource timestamp.
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
    // The confirm re-quote runs BOTH hops again (fetch 1+1) before anything is signed.
    // Measured as a delta: the live-fetch effect legitimately re-runs on its own triggers.
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
  });
});
