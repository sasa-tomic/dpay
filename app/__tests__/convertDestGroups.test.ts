/**
 * `groupDestSections` (components/ConvertShared.tsx) — the Convert destination picker's
 * currency sections. Same honesty contract as the accounts route's `groupAccountsByCurrency`:
 * the sections are LABELS over `buildDestGroups`' registry order, never a recomputation of it.
 * What is pinned, over the REAL VCHF pipeline (resolveLegs → resolveConvertDestinations →
 * buildDestGroups — the exact sequence ConvertMode renders):
 *   • section ORDER: the wallet currencies in WALLET_CURRENCIES order (a section only when the
 *     picker carries a destination for it), then the tail of destinations that settle no wallet
 *     currency (the external-address payouts);
 *   • intra-section order is EXACTLY buildDestGroups' order restricted to that section
 *     (registry order) — grouping is presentation, not a re-sort;
 *   • the sections PARTITION the picker — every row appears exactly once, none dropped;
 *   • a section carries no amounts, so nothing can be summed, ranked, or FX-ordered.
 */
import {describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(),
    icpApproveArg: jest.fn(),
    icpDepositAndSwapArg: jest.fn(),
    icpWithdrawErc20Arg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpPrincipalFromPubkey: jest.fn(),
    icpDecodeSwapResult: jest.fn(),
    icpDecodeApproveResult: jest.fn(),
    icpDecodeMinterOk: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({relayFetch: jest.fn()}));
jest.mock('../services/rail', () => ({
  submitTransfer: jest.fn(),
  fetchGasFeeWei: jest.fn(),
  fetchLedgerFee: jest.fn(),
}));

import {buildDestGroups, groupDestSections, resolveLegs, type ConvertLegs} from '../components/ConvertShared';
import {hubRoutes, multihopRoutesFrom} from '../routes';
import {resolveConvertDestinations} from '../config/convert';
import {cefiVenuesForLedger} from '../config/venues';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const VCHF = BUNDLED.find(c => c.currency === 7)!;

/** The exact pipeline ConvertMode renders: legs → destinations → groups. */
const pickerFor = (catalog: CurrencyDescriptor[], from: CurrencyDescriptor) => {
  const legs: ConvertLegs | null = resolveLegs(catalog, {
    protocol: 'ic', id: `ic:${from.currency}` as never, currency: from.currency,
    symbol: from.backing_symbol ?? from.symbol ?? '', linkToken: from.backing_symbol ?? from.symbol ?? '',
    networkLabel: '', network: 'Internet Computer', decimals: from.decimals ?? 8,
    minFractionDigits: 0, liquidity: null, onramp: 'Unavailable' as never, offramp: 'Unavailable' as never,
  } as never);
  if (legs == null) throw new Error('fixture: VCHF must convert');
  const groups = buildDestGroups(
    catalog, legs,
    resolveConvertDestinations(legs.inDesc.ledger, legs.inDesc.testnet),
    hubRoutes(catalog, legs.inDesc.ledger!),
    multihopRoutesFrom(catalog, from.currency),
    cefiVenuesForLedger(legs.inDesc.ledger!),
  );
  return {legs, groups};
};

describe('groupDestSections — labels over registry order, nothing more', () => {
  const {legs, groups} = pickerFor(BUNDLED, VCHF);

  test('wallet currencies first in WALLET_CURRENCIES order, then the tail', () => {
    const sections = groupDestSections(groups, BUNDLED, legs);
    // From VCHF the currency-settling destinations are ckUSDC (USD) and — since the generalized
    // model (2026-09-24) — the token currencies their rows settle: ckBTC→BTC, ckETH→ETH, and the
    // standing direct pair VCHF→ICP now sections under ICP instead of the tail. There is no CHF
    // section — the input asset is not a destination.
    expect(sections.map(s => s.currency)).toEqual(['USD', 'BTC', 'ETH', 'ICP', null]);
  });

  test('intra-section order is buildDestGroups order restricted to the section; the sections partition the picker', () => {
    const sections = groupDestSections(groups, BUNDLED, legs);
    const flat = sections.flatMap(s => s.groups.map(g => g.key));
    expect(new Set(flat)).toEqual(new Set(groups.map(g => g.key)));
    expect(flat).toHaveLength(groups.length);
    // Each section's rows appear in the SAME relative order buildDestGroups produced.
    for (const s of sections) {
      const idx = groups.map(g => g.key);
      const slice = s.groups.map(g => idx.indexOf(g.key));
      expect([...slice].sort((a, b) => a - b)).toEqual(slice);
    }
    // And the USD section carries exactly the ckUSDC row; the direct pair (ICP) leads the ICP
    // section, and the tail is the external-address payouts.
    const usd = sections.find(s => s.currency === 'USD')!;
    expect(usd.groups.map(g => g.key)).toEqual(['ic:2']);
    const icpSection = sections.find(s => s.currency === 'ICP')!;
    expect(icpSection.groups[0]!.key).toBe('direct');
    const tail = sections.find(s => s.currency === null)!;
    expect(tail.groups.every(g => g.key.startsWith('ext:'))).toBe(true);
  });

  test('a section is a LABEL: it carries no amounts, so nothing can be summed or ranked', () => {
    const sections = groupDestSections(groups, BUNDLED, legs);
    for (const s of sections) {
      expect(Object.keys(s).sort()).toEqual(['currency', 'groups']);
      for (const g of s.groups) expect(g).not.toHaveProperty('amount');
    }
  });
});
