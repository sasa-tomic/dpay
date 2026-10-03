/**
 * solRailShown — the SOL rail's offline-pending deduction and the SHOWN states it produces
 * (2026-10-01 audit F4). The Pay tab's fund gates, the Convert surface's fund/insufficient
 * checks and the balances map MUST read the same adjusted numbers; these pins freeze the
 * derivation both consume: the freshAt retirement rule, the gross-of-the-record amount, the
 * registry-keyed token mapping, the never-read-rail zero, and the statuses-pass-through rule.
 */
import {describe, test, expect} from '@jest/globals';
import {EURC_MINT_ADDRESS, USDC_MINT_ADDRESS} from '../solana/tokens';
import {applySolDeduction, pendingSolDeduction, type PendingSolRecord} from '../lib/solRailShown';

const tokenInfoOf = (token: string): {mint: string | null} | null => {
  if (token === 'SOL') return {mint: null};
  if (token === 'USDC') return {mint: USDC_MINT_ADDRESS};
  if (token === 'EURC') return {mint: EURC_MINT_ADDRESS};
  return null;
};

const rec = (over: Partial<PendingSolRecord> = {}): PendingSolRecord => ({
  k: 'aa',
  assetId: 'solana:SOL',
  currency: null,
  ts: 1000,
  gross: '6000',
  wireAmount: '5000',
  ...over,
});

describe('pendingSolDeduction — which pending records debit the SOL rail, and by how much', () => {
  test('a never-read rail (freshAt 0) deducts nothing — nothing established to subtract against', () => {
    expect(pendingSolDeduction([rec()], 0, tokenInfoOf)).toEqual({sol: '0', tokens: {}});
  });

  test('a hand-off POSTDATING the last read deducts GROSS (wire+fee — the account moves both)', () => {
    const d = pendingSolDeduction([rec({gross: '6000', wireAmount: '5000'})], 999, tokenInfoOf);
    expect(d.sol).toBe('6000');
  });

  test('a poll that landed AFTER the hand-off retires the deduction (the read is authoritative)', () => {
    expect(pendingSolDeduction([rec({ts: 1000})], 1000, tokenInfoOf).sol).toBe('0');
    expect(pendingSolDeduction([rec({ts: 1001})], 1001, tokenInfoOf).sol).toBe('0');
  });

  test('an unknown-fee record falls back to the wire (never zero — the money did move)', () => {
    expect(pendingSolDeduction([rec({gross: undefined, wireAmount: '5000'})], 999, tokenInfoOf).sol).toBe('5000');
  });

  test('SPL records key by MINT through the registry; unregistered symbols skip honestly', () => {
    const d = pendingSolDeduction([
      rec({assetId: 'solana:USDC', gross: '100', wireAmount: '100'}),
      rec({assetId: 'solana:EURC', gross: '200', wireAmount: '200'}),
      rec({assetId: 'solana:NOPE', gross: '300', wireAmount: '300'}),
    ], 999, tokenInfoOf);
    expect(d.sol).toBe('0');
    expect(d.tokens[USDC_MINT_ADDRESS]).toBe('100');
    expect(d.tokens[EURC_MINT_ADDRESS]).toBe('200');
    expect(Object.keys(d.tokens)).toHaveLength(2);
  });

  test('IC records (currency set) never touch the SOL rail', () => {
    expect(pendingSolDeduction([rec({currency: 7, gross: '999', wireAmount: '999'})], 999, tokenInfoOf)).toEqual({sol: '0', tokens: {}});
  });

  test('two pending records on one asset ADD (a second offline payment deducts on top)', () => {
    const d = pendingSolDeduction([rec({gross: '100'}), rec({gross: '200'})], 999, tokenInfoOf);
    expect(d.sol).toBe('300');
  });
});

describe('applySolDeduction — the SHOWN states the balances map and the Pay gates share', () => {
  test('the native deduction lands on the balance; statuses pass through untouched', () => {
    const out = applySolDeduction(
      {balance: '10000', status: 'ok'},
      {},
      {sol: '6000', tokens: {}},
    );
    expect(out.sol.balance).toBe('4000');
    expect(out.sol.status).toBe('ok');
  });

  test('a deduction never drives a balance below zero (the clamp is the applyOffline contract)', () => {
    const out = applySolDeduction({balance: '100', status: 'error'}, {}, {sol: '6000', tokens: {}});
    expect(out.sol.balance).toBe('0');
    expect(out.sol.status).toBe('error'); // the fact survives; only the number adjusted
  });

  test('a null balance stays null (an unknown is not a zero — the gate fails open honestly)', () => {
    const out = applySolDeduction({balance: null, status: 'unavailable'}, {}, {sol: '6000', tokens: {}});
    expect(out.sol.balance).toBeNull();
  });

  test('a zero deduction returns the token states UNCHANGED (same identity, no churn)', () => {
    const states = {[USDC_MINT_ADDRESS]: {amount: '5000', status: 'balance'}};
    const out = applySolDeduction({balance: '1', status: 'ok'}, states, {sol: '0', tokens: {}});
    expect(out.tokens).toBe(states);
  });

  test('each mint deducts ITS OWN pending amount; a state without a number is skipped', () => {
    const states = {
      [USDC_MINT_ADDRESS]: {amount: '500', status: 'balance'},
      [EURC_MINT_ADDRESS]: {amount: null, status: 'balance'}, // nothing measured — nothing to deduct
    };
    const out = applySolDeduction(
      {balance: '1', status: 'ok'},
      states,
      {sol: '0', tokens: {[USDC_MINT_ADDRESS]: '500', [EURC_MINT_ADDRESS]: '200'}},
    );
    expect(out.tokens[USDC_MINT_ADDRESS].amount).toBe('0');
    expect(out.tokens[EURC_MINT_ADDRESS].amount).toBeNull(); // no number to deduct against
    expect(out.tokens[USDC_MINT_ADDRESS].status).toBe('balance');
  });
});
