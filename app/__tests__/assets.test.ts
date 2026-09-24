/**
 * Phase 1 — the pure asset domain (2026-08-12 unified asset selection rewrite).
 *
 * `buildSelectableAssets` is the ONE pure list builder every Wallet selector consumes. It produces
 * a resolved view model (`SelectableAsset`) from the validated IC catalog PLUS the catalog's
 * solana section rows (catalog v2 — display facts catalog-driven, bundled fallback when the relay
 * is unreachable). SOL never enters the ICRC catalog; it is appended here as `solana:*` ids.
 *
 * These tests pin the load-bearing Phase-1 invariants:
 *   1. The complete visible list = every visible IC descriptor + solana:SOL (+ solana:USDC when
 *      the configured Solana cluster supports it).
 *   2. AssetIds are STABLE across a catalog object/metadata refresh (same currency id, different
 *      object reference ⇒ same AssetId). State never stores a descriptor.
 *   3. Duplicate IC currency IDs are rejected deterministically (first wins).
 *   4. `reconcileSelectedAsset` preserves a visible selection; falls back to `ic:0` then first
 *      visible then null. Hiding a selected testnet asset applies the fallback atomically.
 *   5. Every `testKey` is unique stable ASCII (e2e matches testID literally).
 *   6. Two USDC assets (IC + Solana) carry distinct `networkLabel`s (no swap / no confusion).
 *   7. `solanaTokenAvailable` fail-closes on an empty or misconfigured cluster (mainnet mint on a
 *      non-mainnet RPC ⇒ false; empty RPC ⇒ false).
 */
import {describe, it, expect} from '@jest/globals';
import {
  buildSelectableAssets,
  chipLabel,
  linkNetworkOf,
  reconcileSelectedAsset,
  resolvePayLink,
  solanaTokenAvailable,
  solanaTokenCoherent,
  tokenEq,
  type SelectableAsset,
} from '../config/assets';
import {assetLinkToken, BUNDLED_NETWORKS, displayName, icpCatalogOf, parseNetworkCatalog} from '../config/catalog';
import type {PayLink} from '../lib/deepLink';
import {USDC_MINT_ADDRESS as MAINNET_MINT} from '../solana/tokens';
import type {CurrencyDescriptor, NetworkSection, SolanaAsset} from '../config/catalog';
import {buildAssetBalances} from '../lib/assetBalances';

// --- shared fixtures (mirror catalog.test.ts's `mk`) -----------------------------------------
const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, min_fraction_digits: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false, ...d,
});
const DEMO: CurrencyDescriptor = mk({currency: 0, mintable: true, minter_family: null, symbol: '$', decimals: 2, onramp: 'Direct', offramp: 'Unavailable'});
const CKBTC: CurrencyDescriptor = mk({currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8, onramp: 'Direct', offramp: 'Direct'});
const CKUSDC: CurrencyDescriptor = mk({currency: 2, ledger: 'l', minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', display_decimals: 6, chain_id: 1, token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', onramp: 'Direct', offramp: 'Direct'});
const CKTESTBTC: CurrencyDescriptor = mk({currency: 3, minter: 'mt', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckTESTBTC', backing_symbol: 'BTC', network: 'Bitcoin Testnet', display_decimals: 8, onramp: 'Direct', offramp: 'Direct', testnet: true});
const BASE_CATALOG: CurrencyDescriptor[] = [DEMO, CKBTC, CKUSDC];

const ids = (as: SelectableAsset[]): string[] => as.map(a => a.id);

// =============================================================================================
// 1. Complete visible list = visible IC + solana:SOL (+ solana:USDC when configured)
// =============================================================================================
describe('buildSelectableAssets — complete visible list', () => {
  it('returns every IC descriptor (in catalog order) when solanaEnabled=false', () => {
    const assets = buildSelectableAssets(BASE_CATALOG, {showTestnet: false, solanaEnabled: false});
    expect(ids(assets)).toEqual(['ic:0', 'ic:1', 'ic:2']);
  });

  it('appends exactly solana:SOL when solanaEnabled=true and USDC is unavailable', () => {
    // The default jest state has solanaRpcUrl() === '' (jest.setup.js) ⇒ solanaTokenAvailable() === false.
    const assets = buildSelectableAssets(BASE_CATALOG, {showTestnet: false, solanaEnabled: true});
    expect(ids(assets)).toEqual(['ic:0', 'ic:1', 'ic:2', 'solana:SOL']);
  });

  it('appends the token rows (USDC, EURC) after solana:SOL when solanaTokens is forced on', () => {
    // Force-build the list with the token override so the order is provable without RPC. The
    // override now enables EVERY catalog token row (Stage 2 widened it from the USDC-only gate),
    // so the bundled catalog's EURC row is enumerated right after USDC.
    const assets = buildSelectableAssets(BASE_CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    expect(ids(assets)).toEqual(['ic:0', 'ic:1', 'ic:2', 'solana:SOL', 'solana:USDC', 'solana:EURC']);
  });

  it('omits the solana rail entirely when solanaEnabled=false even if tokens would be available', () => {
    const assets = buildSelectableAssets(BASE_CATALOG, {showTestnet: false, solanaEnabled: false, solanaTokens: true});
    expect(ids(assets)).toEqual(['ic:0', 'ic:1', 'ic:2']);
  });

  it('hides testnet IC descriptors when showTestnet=false', () => {
    const catalog: CurrencyDescriptor[] = [DEMO, CKBTC, CKTESTBTC];
    const assets = buildSelectableAssets(catalog, {showTestnet: false, solanaEnabled: false});
    expect(ids(assets)).toEqual(['ic:0', 'ic:1']); // ic:3 (testnet) is omitted
  });

  it('reveals testnet IC descriptors when showTestnet=true', () => {
    const catalog: CurrencyDescriptor[] = [DEMO, CKBTC, CKTESTBTC];
    const assets = buildSelectableAssets(catalog, {showTestnet: true, solanaEnabled: false});
    expect(ids(assets)).toEqual(['ic:0', 'ic:1', 'ic:3']);
  });

  it('every returned asset has visible=true (the builder is the visibility filter)', () => {
    const assets = buildSelectableAssets(BASE_CATALOG, {showTestnet: true, solanaEnabled: true});
    expect(assets.every(a => a.visible === true)).toBe(true);
  });

  it('handles an empty catalog (SOL still appended when enabled)', () => {
    expect(ids(buildSelectableAssets([], {showTestnet: false, solanaEnabled: false}))).toEqual([]);
    expect(ids(buildSelectableAssets([], {showTestnet: false, solanaEnabled: true}))).toEqual(['solana:SOL']);
  });
});

// =============================================================================================
// 1b. Catalog-driven Solana rows (catalog v2) — display facts read from the network sections
// =============================================================================================
describe('buildSelectableAssets — catalog-driven Solana rows (catalog v2)', () => {
  const SOL_ROWS: SolanaAsset[] = [
    {token: 'SOL', symbol: 'SOLANA', decimals: 4, min_fraction_digits: null, mint: null, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable'},
    {token: 'USDC', symbol: 'USDC', decimals: 5, min_fraction_digits: 2, mint: 'Mint111111111111111111111111111111111111111', liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable'},
  ];
  const NETWORKS: NetworkSection[] = [
    {protocol: 'icp', name: 'Internet Computer', environment: 'mainnet', assets: []},
    {protocol: 'icp', name: 'Internet Computer', environment: 'testnet', assets: []},
    {protocol: 'solana', name: 'Solana', environment: 'mainnet', assets: SOL_ROWS},
  ];

  it('omitted networks ⇒ the BUNDLED sections supply the SOL facts (cold/offline first load, identical rows)', () => {
    const assets = buildSelectableAssets([], {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    const sol = assets.find(a => a.id === 'solana:SOL')!;
    const usdc = assets.find(a => a.id === 'solana:USDC')!;
    expect(sol.symbol).toBe('SOL');
    expect(sol.decimals).toBe(9);
    expect(sol.testKey).toBe('sol');
    expect(usdc.symbol).toBe('USDC');
    expect(usdc.decimals).toBe(6);
    expect(usdc.testKey).toBe('sol-usdc');
  });

  it('reads symbol/decimals from the solana section rows when networks is supplied', () => {
    const assets = buildSelectableAssets([], {showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: NETWORKS});
    const sol = assets.find(a => a.id === 'solana:SOL')!;
    expect(sol.symbol).toBe('SOLANA');
    expect(sol.decimals).toBe(4);
    const usdc = assets.find(a => a.id === 'solana:USDC')!;
    expect(usdc.decimals).toBe(5);
  });

  it('ids + testKeys stay the stable literals regardless of catalog metadata (testID contract)', () => {
    // The section may rename symbols or shift decimals, but `solana:SOL`/'sol' and
    // `solana:USDC`/'sol-usdc' are the e2e testID contract — never derived from metadata.
    const assets = buildSelectableAssets([], {showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: NETWORKS});
    expect(assets.map(a => [a.id, a.testKey])).toEqual([['solana:SOL', 'sol'], ['solana:USDC', 'sol-usdc']]);
  });

  it('the USDC availability gate still applies when networks is supplied', () => {
    const assets = buildSelectableAssets([], {showTestnet: false, solanaEnabled: true, solanaTokens: false, networks: NETWORKS});
    expect(ids(assets)).toEqual(['solana:SOL']);
  });

  it('omits a row the section does not carry (no SOL in the section ⇒ no solana:SOL asset)', () => {
    const usdcOnly: NetworkSection[] = [
      {protocol: 'solana', name: 'Solana', environment: 'mainnet', assets: [SOL_ROWS[1]]},
    ];
    const assets = buildSelectableAssets([], {showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: usdcOnly});
    expect(ids(assets)).toEqual(['solana:USDC']);
  });
});

// =============================================================================================
// 2. AssetIds are STABLE across a descriptor object/metadata refresh
// =============================================================================================
describe('AssetIds survive a descriptor object/metadata refresh', () => {
  it('same currency id + different object reference + changed metadata ⇒ SAME AssetId', () => {
    // Two distinct object references for the SAME logical currency (1) with different cosmetic
    // metadata (network label changed). The AssetId must be `ic:1` in both — state never stores a
    // descriptor, so a catalog refresh cannot invalidate the selection.
    const before: CurrencyDescriptor[] = [mk({currency: 1, minter_family: 'CkBtcUtxo', wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', decimals: 8})];
    const after: CurrencyDescriptor[] = [mk({currency: 1, minter_family: 'CkBtcUtxo', wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin Testnet', decimals: 8})];
    const a1 = buildSelectableAssets(before, {showTestnet: true, solanaEnabled: false});
    const a2 = buildSelectableAssets(after, {showTestnet: true, solanaEnabled: false});
    expect(ids(a1)).toEqual(['ic:1']);
    expect(ids(a2)).toEqual(['ic:1']);
    expect(a1[0].id).toBe(a2[0].id);
  });
});

// =============================================================================================
// 3. Duplicate IC currency IDs are rejected deterministically (first wins)
// =============================================================================================
describe('Duplicate IC currency IDs are deduped deterministically', () => {
  it('keeps the FIRST occurrence of a duplicate currency id (catalog order)', () => {
    const first = mk({currency: 1, minter_family: 'CkBtcUtxo', wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', decimals: 8});
    const dup = mk({currency: 1, minter_family: 'CkBtcUtxo', wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin Testnet', decimals: 8});
    const assets = buildSelectableAssets([first, dup], {showTestnet: true, solanaEnabled: false});
    // Only ONE ic:1 entry; and it carries the FIRST descriptor's metadata (network 'Bitcoin').
    // Read off `network` — the backing-chain FIELD — rather than off `networkLabel`, which names
    // the SETTLEMENT chain for every IC row (X23) and so cannot tell two backing chains apart.
    expect(ids(assets)).toEqual(['ic:1']);
    expect(assets[0].network).toBe('Bitcoin');
    expect(assets[0].network).not.toContain('Testnet');
  });
});

// =============================================================================================
// 4. reconcileSelectedAsset — deterministic fallback policy
// =============================================================================================
describe('reconcileSelectedAsset — preserve/fallback policy', () => {
  const VISIBLE = buildSelectableAssets(BASE_CATALOG, {showTestnet: false, solanaEnabled: true});

  it('preserves a still-visible selection', () => {
    expect(reconcileSelectedAsset('ic:1', VISIBLE, null)).toBe('ic:1');
    expect(reconcileSelectedAsset('solana:SOL', VISIBLE, null)).toBe('solana:SOL');
  });

  it('returns null for a null selection when no assets are visible', () => {
    expect(reconcileSelectedAsset(null, [], null)).toBeNull();
  });

  it('falls back to ic:0 when the selected id is no longer present', () => {
    expect(reconcileSelectedAsset('ic:99', VISIBLE, null)).toBe('ic:0');
  });

  it('falls back to ic:0 when the selected id is null but ic:0 is present', () => {
    expect(reconcileSelectedAsset(null, VISIBLE, null)).toBe('ic:0');
  });

  it('falls back to the FIRST visible asset when ic:0 is absent', () => {
    const noDemo = buildSelectableAssets([CKBTC, CKUSDC], {showTestnet: false, solanaEnabled: false});
    expect(reconcileSelectedAsset('ic:99', noDemo, null)).toBe('ic:1');
    expect(reconcileSelectedAsset(null, noDemo, null)).toBe('ic:1');
  });

  it('falls back to ic:0 even when ic:0 is not the first visible asset (ic:0 wins over first)', () => {
    // Catalog order: [ckBTC, DEMO, ckUSDC]. First visible is ic:1, but ic:0 is the preferred fallback.
    const reordered = buildSelectableAssets([CKBTC, DEMO, CKUSDC], {showTestnet: false, solanaEnabled: false});
    expect(ids(reordered)).toEqual(['ic:1', 'ic:0', 'ic:2']);
    expect(reconcileSelectedAsset('ic:99', reordered, null)).toBe('ic:0');
  });

  it('returns null when no assets are visible (fail-closed)', () => {
    expect(reconcileSelectedAsset('ic:99', [], null)).toBeNull();
    expect(reconcileSelectedAsset('solana:SOL', [], null)).toBeNull();
  });

  it('hiding a selected testnet asset atomically applies the fallback (rebuild ⇒ reconcile)', () => {
    // Step 1: testnet visible, user selects ic:3 (ckTESTBTC).
    const withTestnet = buildSelectableAssets([DEMO, CKBTC, CKTESTBTC], {showTestnet: true, solanaEnabled: false});
    expect(reconcileSelectedAsset('ic:3', withTestnet, null)).toBe('ic:3');
    // Step 2: user hides testnet — the rebuilt list no longer contains ic:3.
    const withoutTestnet = buildSelectableAssets([DEMO, CKBTC, CKTESTBTC], {showTestnet: false, solanaEnabled: false});
    expect(ids(withoutTestnet)).not.toContain('ic:3');
    // Step 3: reconcile falls back to ic:0 (deterministic).
    expect(reconcileSelectedAsset('ic:3', withoutTestnet, null)).toBe('ic:0');
  });

  // The home-currency precedence (2026-09-04). `preferredId` sits BETWEEN "keep what's selected"
  // and "fall back to DEMO", which is what makes the wallet open in the user's own currency on
  // every launch — the selection is session state, so a cold start always arrives here with null.
  it('lands on the home currency rail when nothing is selected', () => {
    expect(reconcileSelectedAsset(null, VISIBLE, 'ic:2')).toBe('ic:2');
  });

  it('lands on the home currency rail when the selected id has disappeared', () => {
    expect(reconcileSelectedAsset('ic:99', VISIBLE, 'ic:2')).toBe('ic:2');
  });

  it('does NOT override a still-visible explicit selection with the home currency', () => {
    // The user switched to BTC on purpose; a re-render must not yank them back to their main currency.
    expect(reconcileSelectedAsset('ic:1', VISIBLE, 'ic:2')).toBe('ic:1');
  });

  it('falls through to ic:0 when the home currency rail is not visible', () => {
    // e.g. the currency's only rail is a testnet row the user has hidden, or a catalog that lost it.
    expect(reconcileSelectedAsset(null, VISIBLE, 'ic:77')).toBe('ic:0');
  });
});

// =============================================================================================
// 5. Every testKey is unique stable ASCII
// =============================================================================================
describe('testKey — unique stable ASCII', () => {
  const isAscii = (s: string): boolean => /^[\x20-\x7E]+$/.test(s);

  it('every entry\'s testKey is unique ASCII across a mixed catalog + testnet + SOL + USDC', () => {
    const assets = buildSelectableAssets([DEMO, CKBTC, CKUSDC, CKTESTBTC], {showTestnet: true, solanaEnabled: true, solanaTokens: true});
    const keys = assets.map(a => a.testKey);
    // All ASCII.
    expect(keys.every(isAscii)).toBe(true);
    // All unique.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the same descriptor (refreshed object) yields the same testKey', () => {
    // A refreshed catalog descriptor is a NEW object reference with possibly-changed benign metadata
    // (a new fee, a new ledger principal). The testKey — derived from the currency id alone — must
    // be IDENTICAL so the e2e net's `asset-<key>` testID stays stable across a catalog refresh.
    // (Mutating `network` to a testnet value would be classification-changing, not benign — use fee.)
    const a1 = buildSelectableAssets([CKBTC], {showTestnet: false, solanaEnabled: false});
    const a2 = buildSelectableAssets([{...CKBTC, fee: '99999'}], {showTestnet: false, solanaEnabled: false});
    expect(a1[0].testKey).toBe(a2[0].testKey);
  });

  it('Solana SOL and USDC carry distinct stable keys', () => {
    const assets = buildSelectableAssets([], {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    const sol = assets.find(a => a.id === 'solana:SOL')!;
    const usdc = assets.find(a => a.id === 'solana:USDC')!;
    expect(sol.testKey).not.toBe(usdc.testKey);
    expect(isAscii(sol.testKey)).toBe(true);
    expect(isAscii(usdc.testKey)).toBe(true);
  });
});

// =============================================================================================
// 6. Network qualification — two USDC assets carry distinct networkLabels
// =============================================================================================
describe('Network qualification — IC USDC vs Solana USDC', () => {
  // X23 — a chain-key row names BOTH its chains, in the direction they relate. Each half alone has
  // shipped and each was wrong: "USDC · Ethereum" put a row that reads as Ethereum USDC over an
  // Internet Computer principal (money-loss-shaped), and the over-correction to "USDC · Internet
  // Computer" hid the chain the deposit actually runs on, so the row appeared to contradict its own
  // deposit sheet ("Send only USDC on Ethereum"). Founder decision 2026-09-09: both, concisely.
  // The two USDC rows still have to be distinguishable — that was this test's original subject and
  // it still holds.
  it('IC USDC names BOTH its chains in direction; Solana USDC names Solana', () => {
    const assets = buildSelectableAssets([DEMO, CKUSDC], {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    const icUsdc = assets.find(a => a.id === 'ic:2')!;
    const solUsdc = assets.find(a => a.id === 'solana:USDC')!;
    expect(icUsdc.networkLabel).not.toBe(solUsdc.networkLabel);
    // The ORDER is the meaning: bridged FROM Ethereum, settles ON the Internet Computer. Reversed,
    // the row would say the deposit runs on the IC and the address is on Ethereum — both false.
    expect(icUsdc.networkLabel).toBe('USDC · Ethereum → Internet Computer');
    expect(solUsdc.networkLabel).toMatch(/Solana/);
    // The backing chain is also still the field the deposit sheets read, which is where "send USDC
    // on Ethereum" is the true instruction for the minter route.
    expect(icUsdc.network).toBe('Ethereum');
  });

  it('a row already ON the Internet Computer names one chain, not an arrow to itself', () => {
    // VCHF/ICP are not bridged from anywhere. "VCHF · Internet Computer → Internet Computer" would
    // be noise dressed as a fact, so the two-chain form is reserved for rows that have two.
    const vchf = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {showTestnet: false, solanaEnabled: false})
      .find(a => a.id === 'ic:7')!;
    expect(vchf.networkLabel).toBe('VCHF · Internet Computer');
  });

  it('SOL networkLabel references Solana (distinct from any IC asset)', () => {
    const assets = buildSelectableAssets([DEMO, CKBTC, CKUSDC], {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    const sol = assets.find(a => a.id === 'solana:SOL')!;
    expect(sol.networkLabel).toMatch(/Solana/);
    // No IC asset's label references Solana.
    expect(assets.filter(a => a.protocol === 'ic').every(a => !/Solana/.test(a.networkLabel))).toBe(true);
  });
});

// =============================================================================================
// 7. solanaTokenAvailable / solanaTokenCoherent — fail-closed for misconfigured cluster
// =============================================================================================
describe('solanaTokenCoherent — pure coherence predicate', () => {
  it('empty RPC URL ⇒ false (SOL disabled)', () => {
    expect(solanaTokenCoherent('', false, MAINNET_MINT)).toBe(false);
  });

  it('mainnet RPC + mainnet mint ⇒ true', () => {
    expect(solanaTokenCoherent('https://mainnet.helius-rpc.com', false, MAINNET_MINT)).toBe(true);
  });

  it('devnet RPC + mainnet mint ⇒ false (the only configured mint is mainnet; fail-closed)', () => {
    // The fund-loss case this guards: devnet RPC + mainnet mint would silently point at a
    // non-existent account. Fail-closed rather than risk an unfulfillable USDC row.
    expect(solanaTokenCoherent('https://api.devnet.solana.com', true, MAINNET_MINT)).toBe(false);
  });

  it('missing mint ⇒ false (no configured mint for this cluster)', () => {
    expect(solanaTokenCoherent('https://mainnet.solana.com', false, '')).toBe(false);
  });
});

describe('solanaTokenAvailable — default jest state is fail-closed', () => {
  // jest.setup.js sets __DPAY_TEST_SOLANA_RPC_URL='' ⇒ the '' test override is the default at
  // module load and no operator override replaces it ⇒ solanaRpcUrl() answers '' ⇒
  // solanaTokenAvailable() MUST be false under the default jest state (no real devnet hit).
  it('returns false when the RPC URL is empty (default offline inner loop)', () => {
    expect(solanaTokenAvailable(MAINNET_MINT)).toBe(false);
  });
});

// =============================================================================================
// 8. chipLabel — qualify the chip with a short network tag ONLY when two visible assets share a symbol
// =============================================================================================
describe('chipLabel — collision-driven network qualification', () => {
  // The unified-asset-selection rewrite surfaced a UX ambiguity: `selectedAsset.symbol` is `USDC`
  // for BOTH IC USDC (ic:2, network Ethereum) AND Solana USDC (solana:USDC, network Solana), so the
  // active-rail chip + header balance label read bare `USDC` for both — a user could not tell which
  // network was selected from the main screen. `chipLabel` qualifies the chip with a short network
  // tag ONLY when another visible asset shares the same symbol (YAGNI: unique symbols stay compact).
  it('returns the bare symbol when no other visible asset shares it (DEMO/BTC/ETH/SOL)', () => {
    const assets = buildSelectableAssets([DEMO, CKBTC, CKUSDC], {showTestnet: false, solanaEnabled: true});
    const demo = assets.find(a => a.id === 'ic:0')!;
    const btc = assets.find(a => a.id === 'ic:1')!;
    const sol = assets.find(a => a.id === 'solana:SOL')!;
    expect(chipLabel(demo, assets)).toBe('DEMO');
    expect(chipLabel(btc, assets)).toBe('BTC');
    expect(chipLabel(sol, assets)).toBe('SOL');
  });

  it('qualifies IC USDC + Solana USDC with DISTINCT short network tags when both are visible', () => {
    // Both ic:2 and solana:USDC carry symbol 'USDC' — a collision. The chip must distinguish them.
    const assets = buildSelectableAssets([DEMO, CKBTC, CKUSDC], {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    const icUsdc = assets.find(a => a.id === 'ic:2')!;
    const solUsdc = assets.find(a => a.id === 'solana:USDC')!;
    const icLabel = chipLabel(icUsdc, assets);
    const solLabel = chipLabel(solUsdc, assets);
    // Both qualified (no longer the bare colliding symbol).
    expect(icLabel).not.toBe('USDC');
    expect(solLabel).not.toBe('USDC');
    // The two labels are DISTINCT — the network tag disambiguates.
    expect(icLabel).not.toBe(solLabel);
    // The short tag is appended to the symbol so a user still reads `USDC` first.
    expect(icLabel).toMatch(/^USDC/);
    expect(solLabel).toMatch(/^USDC/);
  });

  it('a USDC asset whose counterpart is NOT visible stays bare (no spurious qualification)', () => {
    // Solana disabled ⇒ no solana:USDC ⇒ ic:2 is the only USDC ⇒ bare symbol (YAGNI).
    const icOnly = buildSelectableAssets([DEMO, CKUSDC], {showTestnet: false, solanaEnabled: false});
    const icUsdc = icOnly.find(a => a.id === 'ic:2')!;
    expect(chipLabel(icUsdc, icOnly)).toBe('USDC');
    // Symmetric: Solana USDC alone (no IC catalog) ⇒ bare.
    const solOnly = buildSelectableAssets([], {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    const solUsdc = solOnly.find(a => a.id === 'solana:USDC')!;
    expect(chipLabel(solUsdc, solOnly)).toBe('USDC');
  });

  it('is pure: the same (asset, all) pair yields the same label across calls', () => {
    const assets = buildSelectableAssets([DEMO, CKUSDC], {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    const icUsdc = assets.find(a => a.id === 'ic:2')!;
    expect(chipLabel(icUsdc, assets)).toBe(chipLabel(icUsdc, assets));
  });
});

// =============================================================================================
// 9. VCHF/ICP (2026-08-28) — the bundled direct-ICRC rows: stable ids/keys, mainnet visibility,
//    refresh-stable order, zero-balance visibility, and no-ramp action honesty.
// =============================================================================================
describe('buildSelectableAssets — bundled VCHF/ICP direct-ICRC rows (2026-08-28)', () => {
  const BUNDLED: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);

  it('derives stable ids ic:7/ic:8 with testKeys vchf/icp — MAINNET-visible under showTestnet=false', () => {
    // No production special case: the builder maps the two no-minter rows like any IC descriptor.
    // They are stamped testnet:false by the owning icp MAINNET section, so the default wallet view
    // (showTestnet=false) shows them in catalog order after ckETH (ic:6). VEUR (ic:9) is RETIRED
    // (2026-09-19) and no longer enumerates — the id is never reused.
    const assets = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: false});
    expect(ids(assets)).toEqual(['ic:0', 'ic:1', 'ic:2', 'ic:6', 'ic:7', 'ic:8']);
    expect(assets.find(a => a.id === 'ic:7')!.testKey).toBe('vchf');
    expect(assets.find(a => a.id === 'ic:8')!.testKey).toBe('icp');
    expect(assets.find(a => a.id === 'ic:7')!.visible).toBe(true);
    expect(assets.find(a => a.id === 'ic:8')!.visible).toBe(true);
  });

  it('a persisted VEUR selection reconciles to EURC — the retired rail never strands the wallet', () => {
    // Tolerance pin (2026-09-19): a user whose persisted preferred rail was ic:9 must fall back
    // cleanly now that the rail is uncatalogued — no crash, and the EUR group's remaining rail
    // (solana:EURC) wins once the solana rows are on.
    const assets = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    expect(reconcileSelectedAsset('ic:9', assets, 'solana:EURC')).toBe('solana:EURC');
    // With no preferred id either, the fallback walks the visible list (DEMO first) — still no
    // crash, never a resuscitated ic:9.
    expect(reconcileSelectedAsset('ic:9', assets, null)).toBe('ic:0');
  });

  it('a legacy SERVED catalog still carrying the retired VEUR row renders it as a normal row', () => {
    // TOLERANCE RULE (2026-09-19): prod serves the old catalog until the founder redeploys. The
    // retired row (thin + Partner/DFX) must parse, enumerate, and stay visible — no crash, no
    // dropped row; the home-currency rail map alone keeps it out of the EUR group.
    const legacy: CurrencyDescriptor = {
      ...BUNDLED[0],
      currency: 9, ledger: 'wu6g4-6qaaa-aaaan-qmrza-cai', mintable: false, minter: null, minter_family: null,
      symbol: 'VEUR', decimals: 8, wrapper_name: 'VEUR', backing_symbol: 'VEUR', network: 'Internet Computer',
      display_decimals: 8, min_fraction_digits: 2, fee: '10000', cap: '1000000000000',
      chain_id: null, token_contract: null, gas_ledger: null,
      onramp: 'Unavailable', offramp: 'Partner', liquidity: 'thin', ramp_partner: 'DFX', testnet: false,
    };
    const wire = {
      networks: [
        {protocol: 'icp', name: 'Internet Computer', environment: 'mainnet', assets: [...BUNDLED.map(c => ({...c})), legacy]},
        {protocol: 'icp', name: 'Internet Computer', environment: 'testnet', assets: []},
        {protocol: 'solana', name: 'Solana', environment: 'mainnet', assets: []},
      ],
    };
    const parsed = parseNetworkCatalog(wire)!;
    const assets = buildSelectableAssets(icpCatalogOf(parsed), {showTestnet: false, solanaEnabled: true, solanaTokens: true});
    const veur = assets.find(a => a.id === 'ic:9')!;
    expect(veur.testKey).toBe('veur');
    expect(veur.visible).toBe(true);
    expect(veur.liquidity).toBe('thin');
    expect(veur.rampPartner).toBe('DFX');
  });

  it('network labels distinguish the IC rows honestly ("Internet Computer", never Bitcoin/Ethereum)', () => {
    const assets = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: false});
    const vchf = assets.find(a => a.id === 'ic:7')!;
    const icp = assets.find(a => a.id === 'ic:8')!;
    expect(vchf.network).toBe('Internet Computer');
    expect(vchf.networkLabel).toContain('Internet Computer');
    expect(icp.networkLabel).toContain('Internet Computer');
    expect(vchf.networkLabel).not.toMatch(/Bitcoin|Ethereum/);
    expect(icp.networkLabel).not.toMatch(/Bitcoin|Ethereum/);
    expect(vchf.symbol).toBe('VCHF');
    expect(icp.symbol).toBe('ICP');
    expect(vchf.decimals).toBe(8);
    expect(icp.decimals).toBe(8);
  });

  it('selector ids/testKeys/order SURVIVE a live catalog refresh (wire envelope → parse → rebuild)', () => {
    // Simulate the refresh exactly as useCatalog delivers it: the LIVE response (a wire envelope
    // carrying the same rows) REPLACES the bundled default; the flat catalog is re-derived through
    // parseNetworkCatalog → icpCatalogOf and the asset list is rebuilt with NEW descriptor objects.
    // ids, testKeys, and order must be IDENTICAL — the Wallet selection (keyed by AssetId) must
    // survive the swap without resetting.
    const wire = {
      networks: [
        {protocol: 'icp', name: 'Internet Computer', environment: 'mainnet', assets: BUNDLED.map(c => ({...c}))},
        {protocol: 'icp', name: 'Internet Computer', environment: 'testnet', assets: []},
        {protocol: 'solana', name: 'Solana', environment: 'mainnet', assets: []},
      ],
    };
    const parsed = parseNetworkCatalog(wire)!;
    expect(icpCatalogOf(parsed).map(c => c.currency)).toEqual([0, 1, 2, 6, 7, 8]);
    const before = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: false});
    const after = buildSelectableAssets(icpCatalogOf(parsed), {showTestnet: false, solanaEnabled: false});
    expect(ids(after)).toEqual(ids(before));
    expect(after.map(a => a.testKey)).toEqual(before.map(a => a.testKey));
    // The CACHE replay (fetchCurrencies persists the envelope; the next load re-parses it through
    // JSON) is order-stable too — a cache hit cannot reshuffle the picker.
    const cached = icpCatalogOf(parseNetworkCatalog(JSON.parse(JSON.stringify({networks: parsed})))!);
    expect(ids(buildSelectableAssets(cached, {showTestnet: false, solanaEnabled: false}))).toEqual(ids(before));
  });

  it('zero-balance VCHF/ICP rows remain visible with honest "0 VCHF"/"0 ICP" balance views', () => {
    // The list builder never reads balances (visibility ≠ funded). buildAssetBalances defaults a
    // never-polled IC asset to '0' → status 'zero' (dims) but the ROW + amount still render.
    const assets = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: false});
    const balances = buildAssetBalances({
      catalog: BUNDLED,
      assets,
      icBalances: {},            // never polled ⇒ each IC asset reads '0'
      primaryBalance: null,
      solState: {balance: null, status: 'unavailable'},
      tokenStates: {},
    });
    expect(balances['ic:7']).toEqual({displayText: '0.00 VCHF', status: 'zero', failure: null});
    expect(balances['ic:8']).toEqual({displayText: '0 ICP', status: 'zero', failure: null});
  });

  it('NO Add money / Cash out actions for VCHF/ICP: ramps Unavailable, no minter, not mintable', () => {
    // The catalog-level mirror of the UI action gates: PayMode's Add-money predicate
    // (gateDepositable = !mintable && onramp !== 'Unavailable' && minter != null) and the
    // accounts-list/WithdrawSheet cash-out family gate both read exactly these DESCRIPTOR fields —
    // the view model carries no ramp copy. VCHF/ICP fail every leg ⇒ no action button is ever
    // emitted, while remaining selectable/payable (rows asserted above).
    for (const currency of [7, 8] as const) {
      const d = BUNDLED.find(c => c.currency === currency)!;
      expect(d.onramp).toBe('Unavailable');
      expect(d.offramp).toBe('Unavailable');
      expect(d.mintable).toBe(false);
      expect(d.minter).toBeNull();
      expect(d.minter_family).toBeNull();
      // PayMode gateDepositable mirror — the Add-money predicate is FALSE for both rows.
      expect(!d.mintable && d.onramp !== 'Unavailable' && d.minter != null).toBe(false);
      // accounts-list/WithdrawSheet cash-out family gate mirror — FALSE for both rows.
      expect(d.offramp !== 'Unavailable' && (d.minter_family === 'CkBtcUtxo' || d.minter_family === 'CkEthErc20')).toBe(false);
    }
  });
});

// =============================================================================================
// 8. resolvePayLink — which asset does a shared payment link mean, and for how much
// =============================================================================================
// The money-critical half of the payment link (the URL grammar itself is pinned in
// deeplink.test.ts). Every branch here is a REFUSAL boundary: dpay never swaps, so resolving to
// "an asset close to what the link said" would move the wrong money on the wrong chain.
describe('resolvePayLink — link → asset + raw amount', () => {
  // A visible list with BOTH USDCs present: the IC chain-key wrapper (ckUSDC, backed by Ethereum,
  // settling on the Internet Computer) and native Solana USDC. This is the collision the
  // settlement-chain parameter exists for.
  const assets = buildSelectableAssets(BASE_CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
  const link = (over: Partial<PayLink> = {}): PayLink => ({
    recipient: 'ryjl3-tyaaa-aaaaa-aaaba-cai', asset: 'ckUSDC', network: 'internet-computer',
    amount: '1.5', label: '', memo: '', ref: null, ...over,
  });

  it('resolves an IC asset and converts the amount at that asset\'s decimals', () => {
    const out = resolvePayLink(link(), assets, BASE_CATALOG);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target.asset.id).toBe('ic:2');
    expect(out.target.rawAmount).toBe('1500000'); // 1.5 at 6 decimals
  });

  it('resolves the Solana rail from the same grammar (one link shape, both rails)', () => {
    const out = resolvePayLink(link({asset: 'SOL', network: 'solana', amount: '0.5'}), assets, BASE_CATALOG);
    expect(out.ok && out.target.asset.id).toBe('solana:SOL');
    expect(out.ok && out.target.rawAmount).toBe('500000000'); // 0.5 SOL at 9 decimals
  });

  it('separates the two USDCs by settlement chain — the collision the chain param exists for', () => {
    const onSolana = resolvePayLink(link({asset: 'USDC', network: 'solana', amount: '2'}), assets, BASE_CATALOG);
    expect(onSolana.ok && onSolana.target.asset.id).toBe('solana:USDC');
    // 'USDC' is NOT the IC row's token (that row is ckUSDC), so the IC chain has no such asset.
    const onIc = resolvePayLink(link({asset: 'USDC', network: 'internet-computer', amount: '2'}), assets, BASE_CATALOG);
    expect(onIc).toEqual({ok: false, err: 'wrong_network'});
  });

  it('refuses a right-token/wrong-chain link instead of paying the other chain', () => {
    // ckUSDC exists here, but only on the Internet Computer. A link claiming it settles on Solana
    // is refused — never silently redirected to the IC row.
    expect(resolvePayLink(link({network: 'solana'}), assets, BASE_CATALOG)).toEqual({ok: false, err: 'wrong_network'});
  });

  it('matches token and chain case-insensitively (a hand-typed link still works)', () => {
    const out = resolvePayLink(link({asset: 'ckusdc', network: 'INTERNET-COMPUTER'}), assets, BASE_CATALOG);
    expect(out.ok && out.target.asset.id).toBe('ic:2');
  });

  it('names DEMO explicitly (its catalog symbol is the "$" glyph, never a link token)', () => {
    const out = resolvePayLink(link({asset: 'DEMO', amount: '25'}), assets, BASE_CATALOG);
    expect(out.ok && out.target.asset.id).toBe('ic:0');
    expect(out.ok && out.target.rawAmount).toBe('2500'); // 25.00 at 2 decimals
    expect(resolvePayLink(link({asset: '$'}), assets, BASE_CATALOG)).toEqual({ok: false, err: 'unknown_asset'});
  });

  it('refuses an asset this wallet has never heard of', () => {
    expect(resolvePayLink(link({asset: 'ckDOGE'}), assets, BASE_CATALOG)).toEqual({ok: false, err: 'unknown_asset'});
  });

  it('distinguishes a HIDDEN testnet asset from an unknown one (the user can reveal it)', () => {
    const full = [...BASE_CATALOG, CKTESTBTC];
    const visible = buildSelectableAssets(full, {showTestnet: false, solanaEnabled: false});
    expect(resolvePayLink(link({asset: 'ckTESTBTC'}), visible, full)).toEqual({ok: false, err: 'hidden_asset'});
    // Revealed, it resolves normally — same link, no re-share needed.
    const revealed = buildSelectableAssets(full, {showTestnet: true, solanaEnabled: false});
    expect(resolvePayLink(link({asset: 'ckTESTBTC', amount: '0.001'}), revealed, full).ok).toBe(true);
  });

  it('refuses an amount with more precision than the asset has (never rounds money)', () => {
    // ckUSDC has 6 decimals; a 7-decimal amount is a broken link, not a rounded payment.
    expect(resolvePayLink(link({amount: '1.1234567'}), assets, BASE_CATALOG)).toEqual({ok: false, err: 'amount'});
  });

  it('refuses a zero, negative, non-numeric or overflowing amount', () => {
    for (const amount of ['0', '0.00', '-1', 'abc', '9'.repeat(30)]) {
      expect(resolvePayLink(link({amount}), assets, BASE_CATALOG)).toEqual({ok: false, err: 'amount'});
    }
  });

  it('refuses an IC row that is not payable, BEFORE any amount reaches the signer', () => {
    // A row with no minter family and an incomplete ICRC descriptor (no ledger/decimals) fails
    // isPayableAsset — the same fail-closed gate the scan path applies.
    const broken = mk({currency: 9, minter_family: null, symbol: 'BROKEN', decimals: null, wrapper_name: 'BROKEN'});
    const withBroken = [...BASE_CATALOG, broken];
    const visible = buildSelectableAssets(withBroken, {showTestnet: false, solanaEnabled: false});
    expect(resolvePayLink(link({asset: 'BROKEN'}), visible, withBroken)).toEqual({ok: false, err: 'unsupported_asset'});
  });
});

describe('linkNetworkOf — the settlement chain a link must name', () => {
  const assets = buildSelectableAssets(BASE_CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
  it('every IC asset settles on the Internet Computer, including the chain-key wrappers', () => {
    // ckUSDC's catalog `network` says 'Ethereum' — that is what BACKS it. The link must name where
    // the transfer EXECUTES, or a link would claim an Ethereum payment that never touches Ethereum.
    const ckusdc = assets.find(a => a.id === 'ic:2')!;
    expect(ckusdc.network).toBe('Ethereum');
    expect(linkNetworkOf(ckusdc)).toBe('internet-computer');
    expect(assets.filter(a => a.protocol === 'ic').every(a => linkNetworkOf(a) === 'internet-computer')).toBe(true);
  });
  it('Solana rows settle on Solana', () => {
    expect(linkNetworkOf(assets.find(a => a.id === 'solana:USDC')!)).toBe('solana');
  });
});

describe('tokenEq — the ONE definition of asset-token identity', () => {
  // Collapsed 2026-09-01 from two copies (this module's and `lib/opencryptopay.ts`'s). It decides
  // WHICH ASSET a payment link or a merchant checkout's offer names, so a second copy free to drift is
  // a payment matched to the wrong asset. Covered directly here because the two callers reach only
  // the tokens their own fixtures carry: the null and whitespace edges below are unreachable
  // through `resolvePayLink`, which is where the drift would have hidden.
  it('matches a token whatever case either side spells it in', () => {
    // A link may be hand-typed and a provider spells `ckBTC`/`VCHF` however it likes.
    expect(tokenEq('ckBTC', 'ckbtc')).toBe(true);
    expect(tokenEq('ckbtc', 'CKBTC')).toBe(true);
    expect(tokenEq('VCHF', 'VCHF')).toBe(true);
  });

  it('refuses a different token, and a token that merely starts the same', () => {
    // Prefix leniency here would pay ckUSDT against a ckUSDC request.
    expect(tokenEq('ckUSDC', 'ckUSDT')).toBe(false);
    expect(tokenEq('ckBTC', 'ckBT')).toBe(false);
    expect(tokenEq('BTC', 'ckBTC')).toBe(false);
    expect(tokenEq('ICP', '')).toBe(false);
  });

  it('never matches an asset that has no link token — not even against an empty string', () => {
    // `linkToken === null` means "nothing can name this asset in a link" (a row whose only name is
    // a glyph). Matching it against anything would make an unnameable asset payable by accident.
    expect(tokenEq(null, 'VCHF')).toBe(false);
    expect(tokenEq(null, '')).toBe(false);
    expect(tokenEq(null, 'null')).toBe(false);
  });

  it('does NOT trim: a token arriving with whitespace is a broken token, not a match', () => {
    // Both sides are whitespace-free by construction (`assetLinkToken`'s charset gate; the OCP
    // parser trims the provider's asset first). Repairing one here would hide the breakage
    // upstream, and the thing being decided is which asset moves.
    expect(tokenEq('VCHF', ' VCHF')).toBe(false);
    expect(tokenEq(' VCHF', 'VCHF')).toBe(false);
    expect(tokenEq('VCHF\n', 'VCHF')).toBe(false);
  });

  it('gives an out-of-contract `undefined` no silent "no match" branch', () => {
    // THE edge the two collapsed versions disagreed on: one tested `!= null` (undefined absorbed as
    // "no match"), the other `!== null`. `undefined` is not in the parameter type and no caller can
    // produce it — `assetLinkToken` returns `string | null` — so a branch for it would be a
    // fallback for a state the types forbid, hiding a malformed asset row instead of failing on it.
    expect(() => tokenEq(undefined as unknown as string | null, 'VCHF')).toThrow(TypeError);
  });
});

describe('assetLinkToken — the ledger token that names an asset in a link', () => {
  it('is the wrapper name for chain-key assets, never the backing symbol', () => {
    // 'BTC' is what the wallet DISPLAYS for ckBTC; a link saying asset=BTC would promise a native
    // Bitcoin payment that an IC principal cannot receive.
    expect(assetLinkToken(CKBTC)).toBe('ckBTC');
    expect(displayName(CKBTC)).toBe('BTC');
  });
  it('is the plain symbol for a direct ICRC asset, and DEMO for the demo rail', () => {
    expect(assetLinkToken(mk({currency: 7, minter_family: null, symbol: 'VCHF', wrapper_name: 'VCHF'}))).toBe('VCHF');
    expect(assetLinkToken(DEMO)).toBe('DEMO');
  });
  it('is null for a row whose only name is a glyph (unnameable ⇒ not linkable)', () => {
    expect(assetLinkToken(mk({currency: 5, minter_family: null, symbol: '₿'}))).toBeNull();
    expect(assetLinkToken(mk({currency: 5, minter_family: null, symbol: null}))).toBeNull();
  });
});
