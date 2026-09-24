/**
 * The convert matrix drift pins (docs/CONVERT_MATRIX.md + the registry that generates it):
 *
 * 1. REGISTRY COVERAGE — every mainnet venue row is actually REACHABLE in the pickers the
 *    app renders: ic_amm rows through resolveConvertDestinations (both pair directions),
 *    solana_amm + cefi rows through the SOL surface's resolveSolDestinations (the SOL-side
 *    mint as deposit), and cefi rows additionally through cefiVenuesForLedger (the IC
 *    surface's own enumeration). A registry row no picker can reach (or a hand-added doc
 *    row the registry does not carry) fails here — the doc and the app derive from the
 *    SAME registry, and neither carries a hand list.
 * 2. DOC DRIFT — docs/CONVERT_MATRIX.md is byte-identical to what
 *    scripts/gen_convert_matrix.mjs generates RIGHT NOW (regenerate-and-diff inside jest,
 *    the flows-md pattern), and the doc's venue set equals the bundled registry's
 *    non-testnet set.
 */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, test} from '@jest/globals';

import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {resolveConvertDestinations} from '../config/convert';
import {
  BUNDLED_VENUES,
  cefiVenuesForLedger,
  setRuntimeVenues,
  type VenueEntry,
} from '../config/venues';
import type {SelectableAsset} from '../config/assets';
import {resolveSolDestinations} from '../components/ConvertSolDest';
import {
  EURC_MINT_ADDRESS,
  SOLANA_TOKENS,
  USDC_MINT_ADDRESS,
  WRAPPED_SOL_MINT_ADDRESS,
} from '../solana/tokens';

const REPO_ROOT = join(__dirname, '..', '..');
const CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
const MAINNET = BUNDLED_VENUES.filter(v => !v.testnet);

afterEach(() => {
  setRuntimeVenues(null); // the BUNDLED registry is the truth under test, never an overlay
});

/** Is this pair ledger a SOLANA-side identifier (a mint, native SOL as its wrapped form)? */
const isMint = (l: string): boolean =>
  l === WRAPPED_SOL_MINT_ADDRESS || Object.values(SOLANA_TOKENS).some(t => t.mint === l);

/** The SOL-side mint of a cross-rail cefi row (the deposit side the SOL surface renders). */
const solSideOf = (v: VenueEntry): string => {
  const mint = v.pair_ledgers.find(isMint);
  expect(mint).toBeDefined();
  return mint as string;
};

/** A minimal SOL selectable asset for the resolver (only `mint` is read). */
function solAsset(mint: string | null): Extract<SelectableAsset, {protocol: 'solana'}> {
  return {
    id: `solana:${mint ?? 'SOL'}`,
    protocol: 'solana',
    token: 'SOL',
    symbol: 'SOL',
    linkToken: null,
    networkLabel: 'SOL · Solana',
    network: 'Solana',
    mint,
    decimals: 9,
    minFractionDigits: 0,
    liquidity: null,
    onramp: 'Unavailable',
    offramp: 'Unavailable',
    rampPartner: null,
    visible: true,
    testKey: 'sol',
  };
}

/** The SOL surface offers this venue as a mechanism when the asset named `mint` is deposited. */
function solSurfaceOffers(v: VenueEntry, kind: 'amm' | 'cefi', mint: string): boolean {
  const res = resolveSolDestinations(solAsset(mint), CATALOG);
  if (res == null) return false;
  return res.groups.some(g =>
    g.mechs.some(m => m.kind === kind && m.venue.venue_id === v.venue_id),
  );
}

describe('convert matrix — every mainnet registry row is reachable in the pickers', () => {
  test('ic_amm rows: both pair directions resolve through resolveConvertDestinations', () => {
    const rows = MAINNET.filter(v => v.kind === 'ic_amm');
    expect(rows.length).toBeGreaterThan(0);
    for (const v of rows) {
      const [a, b] = v.pair_ledgers;
      for (const [from, to] of [[a, b], [b, a]] as const) {
        const dest = resolveConvertDestinations(from, false).find(d => d.destLedger === to);
        expect(dest).toBeDefined();
        expect(dest?.routes.some(r => r.kind === 'direct' && r.venueId === v.venue_id)).toBe(true);
      }
    }
  });

  test('solana_amm rows: offered from both mints through resolveSolDestinations', () => {
    const rows = MAINNET.filter(v => v.kind === 'solana_amm');
    expect(rows.length).toBeGreaterThan(0);
    for (const v of rows) {
      for (const mint of v.pair_ledgers) {
        expect(solSurfaceOffers(v, 'amm', mint)).toBe(true);
      }
    }
  });

  test('cefi rows: offered from the SOL-side mint, and from the IC ledger (cefiVenuesForLedger)', () => {
    const rows = MAINNET.filter(v => v.kind === 'cefi');
    expect(rows.length).toBeGreaterThan(0);
    for (const v of rows) {
      expect(solSurfaceOffers(v, 'cefi', solSideOf(v))).toBe(true);
      const icSide = v.pair_ledgers.find(l => !isMint(l));
      expect(icSide).toBeDefined();
      expect(cefiVenuesForLedger(icSide as string).some(x => x.venue_id === v.venue_id)).toBe(true);
    }
  });

  test('the mainnet set is exactly the four known SOL-rail mints + IC principals (registry is the only source)', () => {
    // Sanity anchor: the resolvers above are the REAL picker walks — this only proves the
    // test did not silently pass on an empty registry.
    expect(MAINNET.map(v => v.venue_id)).toEqual([
      'icpswap', 'icpswap-ckusdc', 'icpswap-cketh', 'icpswap-ckbtc', 'icpswap-ckbtc-cketh',
      'icpswap-vchf-ckusdc', 'jupiter', 'jupiter-eurc', 'jupiter-usdc-eurc',
      'sideshift', 'sideshift-usdc', 'sideshift-eurc', 'trocador',
    ]);
    // and the constants this suite names are the registry's own (a mint change fails loudly here)
    expect(WRAPPED_SOL_MINT_ADDRESS).toBe('So11111111111111111111111111111111111111112');
    expect(USDC_MINT_ADDRESS).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(EURC_MINT_ADDRESS).toBe('HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr');
  });
});

describe('convert matrix — the generated doc is current and matches the registry', () => {
  test('docs/CONVERT_MATRIX.md is byte-identical to a fresh generation (regenerate-and-diff)', () => {
    execFileSync('node', [join('scripts', 'gen_convert_matrix.mjs'), '--check'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  });

  test('the doc venue set == the bundled non-testnet registry set', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'CONVERT_MATRIX.md'), 'utf8');
    const ids = doc
      .split('\n')
      .filter(l => l.startsWith('| '))
      .map(l => l.split('|')[3]?.trim() ?? '')
      .filter(cell => cell.startsWith('`'))
      .map(cell => cell.replaceAll('`', ''));
    expect(ids).toHaveLength(MAINNET.length);
    expect(new Set(ids)).toEqual(new Set(MAINNET.map(v => v.venue_id)));
  });
});
