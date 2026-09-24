/**
 * `groupAccountsByCurrency` (config/currency.ts) — the ACCOUNTS route's currency sections.
 *
 * The contract under test is the honesty one: the sections are LABELS over the `orderAccounts`
 * output, never a recomputation of it. What is pinned:
 *   • section ORDER: home currency first, then every other offered currency in HOME_CURRENCIES
 *     order, then the non-currency tail — no section at all for a currency with no rail;
 *   • intra-section order is EXACTLY the input order (grouping is presentation over
 *     `orderAccounts`; the funded-before-unfunded policy stays that function's);
 *   • the buckets PARTITION the list — every account appears exactly once;
 *   • no magnitude anywhere: a funded account never jumps sections, a bigger number never
 *     reorders a section (the no-FX-quote rule — the reason the helper takes no balances).
 */
import {describe, test, expect} from '@jest/globals';
import {groupAccountsByCurrency} from '../config/currency';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const assets = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
const ids = (sections: ReturnType<typeof groupAccountsByCurrency>): string[] =>
  sections.flatMap(s => s.assets.map(a => a.id));

describe('groupAccountsByCurrency — section order', () => {
  test('home currency leads; other currencies follow in HOME_CURRENCIES order; the tail is last', () => {
    const ordered = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    const sections = groupAccountsByCurrency(ordered, 'USD');
    expect(sections.map(s => s.currency)).toEqual(['USD', 'CHF', 'EUR', null]);
    expect(sections[0]!.assets.map(a => a.id)).toEqual(['ic:2', 'solana:USDC']); // preferred rail first
    expect(sections[1]!.assets.map(a => a.id)).toEqual(['ic:7']); // VCHF alone settles CHF
    expect(sections[2]!.assets.map(a => a.id)).toEqual(['solana:EURC']);
  });

  test('a currency with no rail in the list emits NO section — not even the home one', () => {
    const stripped = assets.filter(a => a.id !== 'ic:7' && a.id !== 'solana:EURC');
    expect(groupAccountsByCurrency(stripped, 'CHF').map(s => s.currency)).toEqual(['USD', null]);
  });
});

describe('groupAccountsByCurrency — presentation over the given order, nothing more', () => {
  test('intra-section order is the input order — funding never promotes an account across sections', () => {
    // Deliberately NOT orderAccounts output: the helper must not care how its input was ordered,
    // only preserve it. A funded ckBTC stays inside the tail; it never joins a currency section.
    const ordered = [assets[3]!, assets[1]!, assets[0]!].filter(Boolean);
    const sections = groupAccountsByCurrency(ordered, 'CHF');
    expect(ids(sections)).toEqual(ordered.map(a => a.id));
  });

  test('the buckets partition the list — every account exactly once, none dropped', () => {
    const sections = groupAccountsByCurrency(assets, 'CHF');
    const out = ids(sections);
    expect(out).toHaveLength(assets.length);
    expect(new Set(out).size).toBe(assets.length);
    // Every input list sits whole inside exactly one section (buckets preserve order internally;
    // only the section assembly reorders).
    for (const a of assets) {
      expect(sections.filter(s => s.assets.includes(a))).toHaveLength(1);
    }
  });

  test('the practice rail stays in the tail (its divider renders above it, exactly where it sits)', () => {
    const sections = groupAccountsByCurrency(assets, 'CHF');
    const tail = sections[sections.length - 1]!;
    expect(tail.currency).toBeNull();
    expect(tail.assets.map(a => a.id)).toContain('ic:0');
  });
});
