/**
 * buildCurrencyBalances (lib/assetBalances.ts) — the per-currency SUMMED balance layer
 * (founder forks #2 + #4, 2026-09-24 currency-first redesign).
 *
 * What is pinned, and why each is load-bearing:
 *   • THE SKETCH: "4,54 Fr" / "$4.54" — a two-rail dollar currency reads as ONE summed
 *     currency-unit figure, exact via BigInt scaling when rail decimals differ.
 *   • Single-rail token currencies are byte-identical to the per-rail display they replace
 *     ("0.0005 BTC") — the currency row is a re-layering, not a re-formatting.
 *   • Status rollup honesty: readable rails sum what is readable; an unreadable rail never
 *     zeroes the sum; NO readable rail renders '—' with the honest rollup status, never a
 *     fabricated zero.
 *   • The '~' staleness marker rides the sum when ANY contributing rail is stale (one rule,
 *     the same marker the per-asset views bake in).
 *   • Fixed money-style 2 decimals for the stables; the preferred rail's own display facts for
 *     token currencies (ckETH's 6-of-18 cap included).
 */
import {describe, test, expect} from '@jest/globals';
import {buildCurrencyBalances} from '../lib/assetBalances';
import {fmtMoneyCompact} from '../lib/format';
import type {SelectableAsset} from '../config/assets';
import type {CurrencyDescriptor} from '../config/catalog';
import type {BalanceView} from '../lib/assetBalances';
import type {AssetId} from '../lib/types';

// Hand-built fixtures — the minimum SelectableAsset shape the builder reads (id, protocol,
// currency/token, decimals, minFractionDigits, mint). A second BTC rail at 2 DECIMALS is the
// mixed-precision case no shipped catalog carries yet; the rail table matches it by linkToken.
const ASSETS: SelectableAsset[] = [
  {id: 'ic:7', protocol: 'ic', currency: 7, symbol: 'VCHF', networkLabel: '', network: null, decimals: 8, linkToken: 'VCHF', minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'vchf'},
  {id: 'ic:2', protocol: 'ic', currency: 2, symbol: 'ckUSDC', networkLabel: '', network: 'Ethereum', decimals: 6, linkToken: 'ckUSDC', minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'ckusdc'},
  {id: 'solana:USDC', protocol: 'solana', token: 'USDC', symbol: 'USDC', networkLabel: '', network: 'Solana', mint: 'mint-usdc', decimals: 6, linkToken: 'USDC', minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'sol-usdc'},
  {id: 'ic:1', protocol: 'ic', currency: 1, symbol: 'ckBTC', networkLabel: '', network: 'Bitcoin', decimals: 8, linkToken: 'ckBTC', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'ckbtc'},
  // The hypothetical second BTC rail: same link token, 2 decimals — the mixed-decimals sum case.
  {id: 'ic:12', protocol: 'ic', currency: 12, symbol: 'ckBTC2', networkLabel: '', network: 'Bitcoin', decimals: 2, linkToken: 'ckBTC', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'ckbtc2'},
  {id: 'ic:6', protocol: 'ic', currency: 6, symbol: 'ckETH', networkLabel: '', network: 'Ethereum', decimals: 18, linkToken: 'ckETH', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'cketh'},
];

const CATALOG = [
  {currency: 7, decimals: 8, display_decimals: 8, backing_symbol: 'VCHF'},
  {currency: 2, decimals: 6, display_decimals: 6, backing_symbol: 'USDC'},
  {currency: 1, decimals: 8, display_decimals: 8, backing_symbol: 'BTC'},
  {currency: 6, decimals: 18, display_decimals: 6, backing_symbol: 'ETH'},
] as unknown as CurrencyDescriptor[];

const view = (status: BalanceView['status'], displayText = ''): BalanceView =>
  ({displayText, status, failure: null});

/** Views where every listed asset is 'ok' (readable) and everything else is 'loading'. */
const okViews = (...ids: AssetId[]) =>
  Object.fromEntries(ASSETS.filter(a => ids.includes(a.id)).map(a => [a.id, view('ok')]));

const build = (over: Partial<Parameters<typeof buildCurrencyBalances>[0]> = {}) => buildCurrencyBalances({
  currencies: ['CHF', 'USD', 'EUR', 'BTC', 'ETH'],
  assets: ASSETS,
  catalog: CATALOG,
  views: {},
  icBalances: {},
  solBalance: null,
  tokenAmounts: {},
  approx: {},
  ...over,
});

describe('buildCurrencyBalances — the summed currency-unit figure (forks #2 + #4)', () => {
  test('a two-rail dollar currency sums to ONE "$4.54" — the founder sketch, exactly', () => {
    const out = build({
      views: okViews('ic:2', 'solana:USDC'),
      icBalances: {2: '1500000'},            // 1.50 ckUSDC (6 dec)
      tokenAmounts: {'mint-usdc': '3040000'}, // 3.04 USDC@Solana (6 dec)
    });
    expect(out.USD).toEqual({displayText: '$4.54', status: 'ok', failure: null});
  });

  test('a stable balance renders in the currency unit with money-style fixed 2 decimals', () => {
    const out = build({
      views: okViews('ic:7'),
      icBalances: {7: '454000000'}, // 4.54 VCHF (8 dec)
    });
    expect(out.CHF!.displayText).toBe('4.54 Fr');
    // Trailing zeros stay (money display, like the sketch's "4,54"): 1.20, never "1.2".
    const out2 = build({views: okViews('ic:7'), icBalances: {7: '120000000'}});
    expect(out2.CHF!.displayText).toBe('1.20 Fr');
  });

  test('EUR renders as a € prefix', () => {
    // EUR's rail set is EURC — absent from this fixture list, so prove the PREFIX placement on
    // the formatter level and the currency-unit wiring through USD/CHF above.
    expect(fmtMoneyCompact('454', 2, {position: 'prefix', symbol: '€'}, 2, 2)).toBe('€4.54');
    expect(outEurPrefix()).toBe('€4.54');
  });

  test('mixed rail DECIMALS sum exactly — BigInt-scaled to the widest contributing precision', () => {
    // 1 BTC (8 dec) + 0.50 on a 2-dec rail: 100000000 + 50·10^6 = 150000000 → "1.5 BTC".
    const out = build({
      views: okViews('ic:1', 'ic:12'),
      icBalances: {1: '100000000', 12: '50'},
    });
    expect(out.BTC!.displayText).toBe('1.5 BTC');
    expect(out.BTC!.status).toBe('ok');
  });

  test('a single-rail token currency is byte-identical to the per-rail row it replaces', () => {
    const out = build({views: okViews('ic:1'), icBalances: {1: '50000'}});
    expect(out.BTC!.displayText).toBe('0.0005 BTC');
    // ...including the ckETH display cap (6 of 18 decimals) and its truncation marker.
    const eth = build({
      views: okViews('ic:6'),
      icBalances: {6: '123456700000000000'}, // 0.1234567 ETH — the 7th digit hides behind the cap
    });
    expect(eth.ETH!.displayText).toBe('≈ 0.123456 ETH');
  });

  test('a zero currency balance is an honest known zero, dim status, in the currency unit', () => {
    const out = build({
      views: {'ic:2': view('zero'), 'solana:USDC': view('absent')},
      icBalances: {2: '0'},
      tokenAmounts: {'mint-usdc': null}, // 'absent' ATA — a KNOWN zero-by-absence
    });
    expect(out.USD).toEqual({displayText: '$0.00', status: 'zero', failure: null});
  });

  test('a below-resolution balance names the threshold instead of rendering a fake zero', () => {
    const out = build({
      views: okViews('ic:2'),
      icBalances: {2: '4000'}, // $0.004 — invisible at 2-decimal money display
    });
    expect(out.USD!.displayText).toBe('< $0.01');
    expect(out.USD!.status).toBe('ok'); // it is money, even if the display cannot show it
  });

  test('an unreadable rail contributes nothing and never zeroes the readable one', () => {
    const out = build({
      views: {'ic:2': view('ok'), 'solana:USDC': view('error')},
      icBalances: {2: '1500000'},
      tokenAmounts: {'mint-usdc': null},
    });
    expect(out.USD!.displayText).toBe('$1.50');
    expect(out.USD!.status).toBe('ok');
  });

  test('no readable rail at all renders "—" with the honest rollup status', () => {
    const base = {views: {'ic:2': view('error'), 'solana:USDC': view('error')}};
    expect(build({...base}).USD!.status).toBe('error');
    expect(build({...base}).USD!.displayText).toBe('—');
    expect(build({views: {'ic:2': view('loading'), 'solana:USDC': view('loading')}}).USD!.status).toBe('loading');
    expect(build({views: {'ic:2': view('unavailable'), 'solana:USDC': view('loading')}}).USD!.status).toBe('unavailable');
  });

  test('ANY contributing rail\'s staleness marks the whole sum "~" — the one marker rule', () => {
    const out = build({
      views: okViews('ic:2', 'solana:USDC'),
      icBalances: {2: '1500000'},
      tokenAmounts: {'mint-usdc': '3040000'},
      approx: {'solana:USDC': true},
    });
    expect(out.USD!.displayText).toBe('~$4.54');
  });

  test('a currency with no rail in the list is skipped — never an empty row', () => {
    const out = build({views: okViews('ic:7'), icBalances: {7: '454000000'}});
    // EUR has no rail here — skipped entirely. USD/BTC/ETH have rails but no reads yet: they
    // roll up to the honest '—'/'loading', exactly like a per-asset view before its first poll.
    expect(out.EUR).toBeUndefined();
    expect(Object.keys(out)).toEqual(['CHF', 'USD', 'BTC', 'ETH']);
    expect(out.USD).toEqual({displayText: '—', status: 'loading', failure: null});
  });

  test('the SOL currency sums through the native balance input', () => {
    const sol: SelectableAsset = {id: 'solana:SOL', protocol: 'solana', token: 'SOL', symbol: 'SOL', networkLabel: '', network: 'Solana', mint: null, decimals: 9, linkToken: 'SOL', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'sol'};
    const out = build({
      currencies: ['SOL'],
      assets: [...ASSETS, sol],
      views: {'solana:SOL': view('ok')},
      solBalance: '1000000000', // 1 SOL (9 dec)
    });
    expect(out.SOL!.displayText).toBe('1 SOL');
  });
});

/** The EUR prefix through the FULL builder — EURC's rail added to the fixture list on the fly. */
function outEurPrefix(): string {
  const eurc: SelectableAsset = {id: 'solana:EURC', protocol: 'solana', token: 'EURC', symbol: 'EURC', networkLabel: '', network: 'Solana', mint: 'mint-eurc', decimals: 6, linkToken: 'EURC', minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'sol-eurc'};
  const out = buildCurrencyBalances({
    currencies: ['EUR'],
    assets: [...ASSETS, eurc],
    catalog: CATALOG,
    views: {'solana:EURC': view('ok')},
    icBalances: {},
    solBalance: null,
    tokenAmounts: {'mint-eurc': '4540000'},
    approx: {},
  });
  return out.EUR!.displayText;
}

describe('fmtMoneyCompact — the currency-unit formatter (one core, two unit placements)', () => {
  test('prefix hugs the number; suffix rides the crypto-unit space', () => {
    expect(fmtMoneyCompact('454', 2, {position: 'prefix', symbol: '$'}, 2, 2)).toBe('$4.54');
    expect(fmtMoneyCompact('454', 2, {position: 'suffix', symbol: 'Fr'}, 2, 2)).toBe('4.54 Fr');
  });

  test('the truncation marker sits OUTSIDE the unit, and the sign outside the number', () => {
    // 0.1234567 @ 6-dec display: the hidden 7 hides behind "≈", the sign leads the whole figure.
    expect(fmtMoneyCompact('1234567', 7, {position: 'prefix', symbol: '$'}, 6, 2)).toBe('≈ $0.123456');
    expect(fmtMoneyCompact('1234567', 7, {position: 'suffix', symbol: 'BTC'}, 6, 0, '−')).toBe('≈ −0.123456 BTC');
  });

  test('a null unit renders the bare number', () => {
    expect(fmtMoneyCompact('454', 2, null, 2, 2)).toBe('4.54');
  });

  test('trailing-zero trim respects the floor, never the caller\'s hopes', () => {
    expect(fmtMoneyCompact('150', 2, {position: 'suffix', symbol: 'Fr'}, 2, 2)).toBe('1.50 Fr');
    expect(fmtMoneyCompact('150', 2, {position: 'suffix', symbol: 'BTC'}, 2, 0)).toBe('1.5 BTC');
  });
});
