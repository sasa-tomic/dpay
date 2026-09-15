/**
 * The DEMO rail's balance view (`demoView` in app/lib/assetBalances.ts) and the ONE thing it
 * decides beyond its own row: whether the wallet has funds at all.
 *
 * Defect D4 (docs/specs/2026-09-08-first-run-redesign.md §0/§5) lived exactly here: DEMO was
 * exempted from the zero rule, so a wallet holding ∂0.00 rendered at full colour AND stamped
 * `fundsReady` — the passport said FUNDS LOADED over an empty wallet. These cases pin the rule
 * that replaced the exemption: DEMO is graded like every other asset (zero ⇒ 'zero', unknown ⇒
 * 'loading'), and the composition with `decideFundsReady` is asserted on the REAL map the wallet
 * builds, not on a hand-written BalanceView.
 *
 * Scope: the DEMO rail only. Every other rail's truth table (IC ck-assets, SOL, per-mint SPL
 * tokens, cross-rail isolation) lives in wallet-selection.test.ts and is not repeated here.
 */
import {describe, it, expect} from '@jest/globals';
import {buildSelectableAssets} from '../config/assets';
import {buildAssetBalances, type BalanceView} from '../lib/assetBalances';
import {decideFundsReady} from '../lib/readiness';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';

const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, min_fraction_digits: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false, ...d,
});
const DEMO: CurrencyDescriptor = mk({currency: 0, mintable: true, minter_family: null, symbol: '$', decimals: 2, onramp: 'Direct', offramp: 'Unavailable'});
const CKUSDC: CurrencyDescriptor = mk({currency: 2, ledger: 'l', minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', display_decimals: 6, min_fraction_digits: 2, chain_id: 1, token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', onramp: 'Direct', offramp: 'Direct'});
const CATALOG: CurrencyDescriptor[] = [DEMO, CKUSDC];
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});

/** The wallet's real map for a given DEMO balance; `approx` marks the DEMO read stale (2026-09-15:
 *  the caller owns the staleness rule now — offline AND older than 60 s — the view only marks). */
function mapFor(primaryBalance: string | null, approx = false): Record<string, BalanceView> {
  return mapWith({}, primaryBalance, approx);
}

/** The same map with one or more NON-practice IC rails polled — the only kind of balance that can
 *  make a wallet trip-ready (X13). */
function mapWith(icBalances: Record<number, string>, primaryBalance: string | null, approx = false): Record<string, BalanceView> {
  return buildAssetBalances({
    catalog: CATALOG, assets: ASSETS,
    icBalances, primaryBalance,
    approx: approx ? {'ic:0': true} : undefined,
    solState: {balance: null, status: 'unavailable'},
    tokenStates: {},
  });
}

describe('demoView — the DEMO rail is graded like every other asset', () => {
  it('a funded balance ⇒ ok, formatted with the ∂ unit', () => {
    expect(mapFor('10000')['ic:0']).toEqual({displayText: '∂100.00', status: 'ok', failure: null});
  });

  it('a stale read (approx) ⇒ the "~" marker, and a funded approximation still reads ok', () => {
    // The marker says "best-known, not authoritative"; it does not make the money unknown, so the
    // status stays 'ok' and the header + the row read byte-identical text.
    expect(mapFor('9100', true)['ic:0']).toEqual({displayText: '~∂91.00', status: 'ok', failure: null});
  });

  it('D4: a ZERO balance ⇒ zero (dims) — the faucet button on the row is the top-up affordance, not a colour', () => {
    expect(mapFor('0')['ic:0']).toEqual({displayText: '∂0.00', status: 'zero', failure: null});
    // …and stale the zero is still a zero: the marker never upgrades an empty wallet.
    expect(mapFor('0', true)['ic:0']).toEqual({displayText: '~∂0.00', status: 'zero', failure: null});
  });

  it('D4: an UNKNOWN balance (no poll returned yet) ⇒ loading + "—" — unknown is never a funded state', () => {
    expect(mapFor(null)['ic:0']).toEqual({displayText: '—', status: 'loading', failure: null});
  });
});

describe('decideFundsReady over the REAL map (the D4 regression pin)', () => {
  it('a wallet holding zero of everything is NOT funds-ready', () => {
    const balances = mapFor('0');
    // Nothing anywhere: DEMO zero, ckUSDC unpolled-zero, the Solana rail unreachable.
    expect(decideFundsReady(balances)).toBe(false);
  });

  it('a wallet whose first poll has not returned is NOT funds-ready', () => {
    expect(decideFundsReady(mapFor(null))).toBe(false);
  });

  it('X13: a faucet top-up of the DEMO rail does NOT flip it — practice money is not trip funds', () => {
    // The stamp lives on a TRIP-readiness card. ∂100 of faucet-minted demo dollars buys nothing
    // from any merchant, so a wallet holding only that is not ready for anything (UX swarm X13).
    expect(decideFundsReady(mapFor('10000'))).toBe(false);
    expect(decideFundsReady(mapFor('9100', true))).toBe(false);
  });

  it('a REAL asset flips it — and offline it stays flipped', () => {
    // ckUSDC polled at 2.50; DEMO empty. The approximation marker says "best-known", not
    // "unknown", so a stale reading of a funded rail still counts.
    expect(decideFundsReady(mapWith({2: '2500000'}, '0'))).toBe(true);
    expect(decideFundsReady(mapWith({2: '2500000'}, '0', true))).toBe(true);
  });
});

describe('R3 — a token error state carries its classified cause into the view (audit blocker)', () => {
  // The audit's blocker case: an SPL token row in 'error' must PRESERVE its amount (never zero
  // it) AND carry the seam-classified `failure` into `BalanceView.failure` — the field the rail
  // note reads to pick its sentence. Uses the REAL bundled networks (USDC·Solana with its own
  // mint, symbol and decimals), never a hand-written asset.
  const NETWORKS = BUNDLED_NETWORKS;
  const NET_CATALOG = icpCatalogOf(NETWORKS);
  const NET_ASSETS = buildSelectableAssets(NET_CATALOG, {
    showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: NETWORKS,
  });
  const usdcSol = NET_ASSETS.flatMap(a => (a.protocol === 'solana' && a.symbol === 'USDC' ? [a] : []))[0];

  it('an error token state preserves the amount and carries failure into BalanceView.failure', () => {
    expect(usdcSol).toBeDefined(); // the registry pins the USDC mainnet mint on the row
    const balances = buildAssetBalances({
      catalog: NET_CATALOG,
      assets: NET_ASSETS,
      icBalances: {},
      primaryBalance: '0',
      solState: {balance: '1000', status: 'ok'},
      tokenStates: {
        [usdcSol!.mint!]: {amount: '1500000', decimals: 6, status: 'error', failure: 'offline'},
      },
    });
    expect(balances[usdcSol!.id]).toEqual({displayText: '1.50 USDC', status: 'error', failure: 'offline'});
  });
});

describe('the ONE staleness rule — a stale read renders "~" on every rail (2026-09-15)', () => {
  // Founder requirement #2: a balance offline for >60 s is APPROXIMATE. The caller (Wallet) owns
  // the clock; the views only MARK. These cases pin the marker reaching every rail that renders a
  // number — the same marker + condition demoView has always applied, now uniform.
  const NETWORKS = BUNDLED_NETWORKS;
  const NET_CATALOG = icpCatalogOf(NETWORKS);
  const NET_ASSETS = buildSelectableAssets(NET_CATALOG, {
    showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: NETWORKS,
  });
  const solAsset = NET_ASSETS.find(a => a.id === 'solana:SOL')!;
  const usdcSol = NET_ASSETS.flatMap(a => (a.protocol === 'solana' && a.symbol === 'USDC' ? [a] : []))[0];

  it('a non-primary IC asset marks its stale amount like DEMO does', () => {
    const fresh = mapWith({2: '2500000'}, '0');
    expect(fresh['ic:2'].displayText).not.toContain('~'); // fresh ⇒ unmarked (opt-in, not baked)
    const marked = buildAssetBalances({
      catalog: CATALOG, assets: ASSETS,
      icBalances: {2: '2500000'}, primaryBalance: '0',
      approx: {'ic:2': true},
      solState: {balance: null, status: 'unavailable'}, tokenStates: {},
    });
    expect(marked['ic:2'].displayText).toBe(`~${fresh['ic:2'].displayText}`);
    expect(marked['ic:2'].displayText).toContain('2.50');
  });

  it('a PRESERVED native-SOL balance (unreachable RPC) renders approx-marked, not "—" (req #3)', () => {
    const balances = buildAssetBalances({
      catalog: NET_CATALOG, assets: NET_ASSETS,
      icBalances: {}, primaryBalance: null,
      approx: {'solana:SOL': true},
      solState: {balance: '5000', status: 'unavailable'},
      tokenStates: {},
    });
    expect(balances[solAsset.id]).toEqual({displayText: '~0.000005 SOL', status: 'unavailable', failure: null});
  });

  it('a PRESERVED token amount (error with a prior read) renders approx-marked', () => {
    const balances = buildAssetBalances({
      catalog: NET_CATALOG, assets: NET_ASSETS,
      icBalances: {}, primaryBalance: null,
      approx: {[usdcSol!.id]: true},
      solState: {balance: null, status: 'unavailable'},
      tokenStates: {[usdcSol!.mint!]: {amount: '1500000', decimals: 6, status: 'error', failure: 'offline'}},
    });
    expect(balances[usdcSol!.id]).toEqual({displayText: '~1.50 USDC', status: 'error', failure: 'offline'});
  });

  it('a FRESH read renders unmarked on every rail — approx is opt-in per asset', () => {
    const balances = buildAssetBalances({
      catalog: NET_CATALOG, assets: NET_ASSETS,
      icBalances: {}, primaryBalance: '10000',
      solState: {balance: '5000', status: 'ok'},
      tokenStates: {[usdcSol!.mint!]: {amount: '1500000', decimals: 6, status: 'balance', failure: null}},
    });
    expect(balances['ic:0']!.displayText).toBe('∂100.00');
    expect(balances[solAsset.id].displayText).toBe('0.000005 SOL');
    expect(balances[usdcSol!.id].displayText).toBe('1.50 USDC');
  });
});
