/**
 * funding — how a user who holds NOTHING gets some (founder direction 2026-09-09; the design and
 * the measured provider evidence live in `docs/specs/2026-09-09-funding-routes-plan.md`).
 *
 * These are claims about the world, not about a renderer, which is why `fundingRoute` is pure and
 * tested here rather than inlined into the deposit surfaces. What is asserted:
 *   - each asset family resolves to the route that actually works for it, including the two that
 *     are easy to get wrong: a chain-key asset is a ONE-HOP buy of its backing asset (you buy BTC
 *     and send it to the address the sheet already shows), while VCHF has no card route anywhere
 *     and must go through native ICP;
 *   - play money is never given a funding route, because it is not money;
 *   - the provider table obeys the regulatory constraints it exists under: alphabetical (no
 *     ranking), no referral parameters, and every figure carrying the date it was read.
 */
import {describe, test, expect} from '@jest/globals';
import {
  fundingRoute, fundsByConversion, bankRouteApplies,
  FUNDING_PROVIDERS, FUNDING_SOURCES_READ_ON,
} from '../config/funding';
import type {SelectableAsset} from '../config/assets';
import {USDC_MINT_ADDRESS} from '../solana/tokens';

const demo: SelectableAsset = {id: 'ic:0', protocol: 'ic', currency: 0, symbol: 'DEMO', networkLabel: 'play money', network: null, decimals: 2, linkToken: null, minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'demo'};
const ckbtc: SelectableAsset = {id: 'ic:1', protocol: 'ic', currency: 1, symbol: 'BTC', networkLabel: 'BTC · Bitcoin', network: 'Bitcoin', decimals: 8, linkToken: 'ckBTC', minFractionDigits: 0, liquidity: null, onramp: 'Direct', offramp: 'Direct', rampPartner: null, visible: true, testKey: 'ckbtc'};
const vchf: SelectableAsset = {id: 'ic:7', protocol: 'ic', currency: 7, symbol: 'VCHF', networkLabel: 'VCHF · Internet Computer', network: 'Internet Computer', decimals: 8, linkToken: 'VCHF', minFractionDigits: 2, liquidity: 'thin', onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'vchf'};
const icp: SelectableAsset = {id: 'ic:8', protocol: 'ic', currency: 8, symbol: 'ICP', networkLabel: 'ICP · Internet Computer', network: 'Internet Computer', decimals: 8, linkToken: 'ICP', minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'icp'};
const solUsdc: SelectableAsset = {id: 'solana:USDC', protocol: 'solana', token: 'USDC', symbol: 'USDC', networkLabel: 'USDC · Solana', network: 'Solana', mint: USDC_MINT_ADDRESS, decimals: 6, linkToken: 'USDC', minFractionDigits: 2, liquidity: 'deep', onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'sol-usdc'};

describe('fundingRoute', () => {
  test('a Solana asset is bought directly and sent to the address on screen', () => {
    expect(fundingRoute(solUsdc, false)).toEqual({kind: 'buy', token: 'USDC', networkLabel: 'USDC · Solana'});
  });

  test('native ICP is bought directly — the ONE card-reachable Internet Computer asset', () => {
    expect(fundingRoute(icp, false)).toEqual({kind: 'buy', token: 'ICP', networkLabel: 'ICP · Internet Computer'});
  });

  test('a chain-key asset is a one-hop buy of its BACKING asset, not a conversion', () => {
    // The easy mistake: ckBTC is not sold anywhere, so it looks like it needs a convert leg. It
    // does not — the deposit sheet already shows a real Bitcoin address, and the minter does the
    // rest. The token to buy is plain BTC, which is exactly what the wallet already displays
    // (backing symbols, never wrapper ids).
    expect(fundingRoute(ckbtc, false)).toEqual({kind: 'buy', token: 'BTC', networkLabel: 'BTC · Bitcoin'});
  });

  test('VCHF has no card route anywhere, so it goes through native ICP and a user-signed convert', () => {
    expect(fundingRoute(vchf, false)).toEqual({kind: 'convert', viaToken: 'ICP', targetSymbol: 'VCHF'});
    expect(fundsByConversion(vchf, false)).toBe(true);
    expect(fundsByConversion(icp, false)).toBe(false);
  });

  test('a TESTNET coin is sent to a faucet, never to a card provider', () => {
    // The naive check is `network !== 'Internet Computer' ⇒ buy it`, which cheerfully tells the
    // user to purchase testnet BTC from MoonPay. Testnet-ness is server-declared, so it is passed
    // in rather than inferred from a label.
    expect(fundingRoute({...ckbtc, symbol: 'BTC testnet', networkLabel: 'BTC testnet · Bitcoin Testnet'}, true))
      .toEqual({kind: 'testnet', symbol: 'BTC testnet', networkLabel: 'BTC testnet · Bitcoin Testnet'});
    // And testnet-ness outranks every other branch, including the Solana one.
    expect(fundingRoute(solUsdc, true).kind).toBe('testnet');
  });

  test('play money is never given a funding route', () => {
    // Offering to sell someone play money is the scam signature the first-run work exists to
    // remove, and it would be a lie besides — no provider sells it and it has no cash value.
    expect(fundingRoute(demo, false)).toEqual({kind: 'none'});
    expect(fundsByConversion(demo, false)).toBe(false);
  });
});

describe('the bank route is bounded by the approval it actually has', () => {
  test('named for CHF only — DFX holds a Swiss sale approval, not a general one', () => {
    expect(bankRouteApplies('CHF')).toBe(true);
    expect(bankRouteApplies('EUR')).toBe(false);
    expect(bankRouteApplies('USD')).toBe(false);
    expect(bankRouteApplies(null)).toBe(false);
  });
});

describe('the provider table obeys the constraints it exists under', () => {
  // docs/REGULATORY.md §4: never label a route "best" (4), let the user choose the venue (5), take
  // no venue-paid compensation (6). These are the machine-checkable halves of that.
  test('alphabetical, so the order cannot be read as a ranking', () => {
    const names = FUNDING_PROVIDERS.map(p => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  });

  test('no source URL carries a referral or affiliate parameter', () => {
    for (const p of FUNDING_PROVIDERS) {
      expect(p.source).not.toMatch(/[?&](ref|referral|aff|affiliate|utm_|partner)/i);
      expect(p.source).not.toContain('?');
    }
  });

  test('every provider carries at least one published figure or is not listed', () => {
    // A row with nothing to say is a name with an implied endorsement and no information.
    for (const p of FUNDING_PROVIDERS) {
      const states = (r: typeof p.card) => r !== null && r.kind !== 'varies';
      const hasFigure = states(p.card) || states(p.bank) || p.minFee !== null || p.spreadPct !== null;
      expect(hasFigure).toBe(true);
      expect(p.source.length).toBeGreaterThan(0);
    }
  });

  test('the read-on date is a real ISO date — the attribution line depends on it', () => {
    expect(FUNDING_SOURCES_READ_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(FUNDING_SOURCES_READ_ON))).toBe(false);
  });

  test('each rate carries the SHAPE it was published in, not a flattened approximation', () => {
    // This is the assertion that caught the first version of the model. A single `cap` boolean
    // forced Coinbase's flat 2.5% to render as "from 2.5%" — a different claim, and a false one.
    // A cap is not a price, a floor is not a cap, and "no published figure" is not zero.
    const by = (k: string) => FUNDING_PROVIDERS.find(p => p.key === k);
    expect(by('coinbase')?.card).toEqual({kind: 'flat', pct: 2.5});
    expect(by('moonpay')?.card).toEqual({kind: 'cap', pct: 4.5});
    expect(by('moonpay')?.bank).toEqual({kind: 'floor', pct: 1});
    // Transak's docs contain a 0.99% worked EXAMPLE and no published rate. Presenting a derived
    // number as the provider's own figure is the overstatement this table exists to avoid.
    expect(by('transak')?.card).toEqual({kind: 'varies'});
    expect(by('transak')?.bank).toEqual({kind: 'varies'});
    expect(by('transak')?.spreadPct).toBe(2.5);
  });
});
