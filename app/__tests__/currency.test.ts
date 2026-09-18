/**
 * app/config/currency.ts — the HOME CURRENCY domain.
 *
 * What these tests pin, and why each one is load-bearing:
 *   1. A currency resolves to the rails the CURRENT catalog carries, in the module's stated
 *      preference order — not in catalog order, so the wallet's rail choice stays a decision.
 *   2. A currency with no rail is NOT offerable. This is the honesty gate: EUR must not appear in
 *      the chooser until an EURC row exists, because a currency the user can pick and then cannot
 *      hold is exactly the dead end the founder's 2026-08-29 rule forbids.
 *   3. `parseHomeCurrency` has NO default. An unrecognised stored value re-opens the chooser rather
 *      than silently picking francs for someone who never said so.
 *   4. `currencyOfAsset` is the exact inverse of the rail table, so the accounts list can mark the
 *      main-currency rows without a second mapping.
 */
import {describe, it, expect} from '@jest/globals';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {
  HOME_CURRENCIES,
  chooseRail,
  currencyOfAsset,
  currencyRails,
  fundedAlternative,
  offerableCurrencies,
  parseHomeCurrency,
  preferredRail,
  railFees,
  railLiquidity,
  railLiquidityLine,
  railRampLine,
  railsLabel,
  type RailBalances,
} from '../config/currency';
import type {CurrencyDescriptor} from '../config/catalog';
import {EURC_MINT_ADDRESS} from '../solana/tokens';
import type {BalanceView} from '../lib/assetBalances';
import type {AssetId} from '../lib/types';

const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, min_fraction_digits: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false, ...d,
});
const DEMO = mk({currency: 0, mintable: true, minter_family: null, symbol: '$', decimals: 2});
const CKBTC = mk({currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin'});
const CKUSDC = mk({currency: 2, minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum'});
const VCHF = mk({currency: 7, minter_family: null, symbol: 'VCHF', decimals: 8, wrapper_name: 'VCHF', backing_symbol: 'VCHF', network: 'Internet Computer'});
const ICP = mk({currency: 8, minter_family: null, symbol: 'ICP', decimals: 8, wrapper_name: 'ICP', backing_symbol: 'ICP', network: 'Internet Computer'});
// The EUR dual-rail catalog shape (Stage 1): VEUR on the IC carries the ramp/liquidity facts —
// thin liquidity, sellable through DFX, a 10000-e8s transfer fee — while EURC on Solana carries
// deep liquidity and no ramp (the solana row's parsed defaults).
const VEUR = mk({currency: 9, minter_family: null, symbol: 'VEUR', decimals: 8, wrapper_name: 'VEUR', backing_symbol: 'VEUR', network: 'Internet Computer', fee: '10000', onramp: 'Unavailable', offramp: 'Partner', liquidity: 'thin', ramp_partner: 'DFX'});

const build = (catalog: CurrencyDescriptor[], solana = false): SelectableAsset[] =>
  buildSelectableAssets(catalog, {showTestnet: false, solanaEnabled: solana, solanaTokens: solana});

const FULL = build([DEMO, CKBTC, CKUSDC, VCHF, ICP]);

describe('currencyRails — a currency is a set of rails', () => {
  it('resolves CHF to the VCHF row', () => {
    expect(currencyRails('CHF', FULL).map(a => a.id)).toEqual(['ic:7']);
  });

  it('resolves USD to every dollar rail present, ckUSDC first', () => {
    // Both rails are dollars; the ORDER is the product decision (the IC rail's offline tap is the
    // one proven on hardware), so it must not follow catalog order.
    const withSol = build([DEMO, CKBTC, CKUSDC, VCHF], true);
    expect(currencyRails('USD', withSol).map(a => a.id)).toEqual(['ic:2', 'solana:USDC']);
  });

  it('resolves EUR to nothing while neither of its rails is visible', () => {
    // The honesty gate stays: the rail table names EURC+VEUR, but neither row is in THIS asset
    // list (no solana section, no VEUR descriptor), so EUR must resolve — and offer — nothing.
    expect(currencyRails('EUR', FULL)).toEqual([]);
  });

  it('resolves EUR to both rails, EURC first — the stated preference, not catalog order', () => {
    // The IC descriptor comes BEFORE the solana section in the built list, so the EURC-first
    // order proves the PREFERENCE won, not the enumeration.
    const withEur = build([DEMO, CKUSDC, VCHF, VEUR], true);
    expect(currencyRails('EUR', withEur).map(a => a.id)).toEqual(['solana:EURC', 'ic:9']);
  });

  it('resolves EUR to its one visible rail when only VEUR is catalogued', () => {
    expect(currencyRails('EUR', build([DEMO, VEUR])).map(a => a.id)).toEqual(['ic:9']);
  });

  it('ignores assets that are not a currency rail', () => {
    // ckBTC, ICP and DEMO are held and spent; they are not what the wallet is "in".
    const railIds = HOME_CURRENCIES.flatMap(c => currencyRails(c, FULL).map(a => a.id));
    expect(railIds).not.toContain('ic:0');
    expect(railIds).not.toContain('ic:1');
    expect(railIds).not.toContain('ic:8');
  });
});

describe('preferredRail — the asset the wallet lands on', () => {
  it('is the first rail in preference order', () => {
    const withSol = build([DEMO, CKUSDC, VCHF], true);
    expect(preferredRail('USD', withSol)?.id).toBe('ic:2');
    expect(preferredRail('CHF', withSol)?.id).toBe('ic:7');
    // EUR's preference is the deep-liquidity rail (EURC@Solana), not the catalog-first IC row.
    expect(preferredRail('EUR', build([DEMO, VEUR], true))?.id).toBe('solana:EURC');
  });

  it('is null when the catalog cannot realise the currency', () => {
    expect(preferredRail('EUR', FULL)).toBeNull();
    // ...and for a currency whose only rail was filtered out of the visible list entirely.
    expect(preferredRail('CHF', build([DEMO, CKBTC]))).toBeNull();
  });
});

describe('offerableCurrencies — the chooser never offers what it cannot deliver', () => {
  it('offers only the currencies the catalog carries a rail for', () => {
    expect(offerableCurrencies(FULL)).toEqual(['CHF', 'USD']);
  });

  it('drops a currency whose rail is missing, and keeps declaration order', () => {
    expect(offerableCurrencies(build([DEMO, CKUSDC]))).toEqual(['USD']);
    expect(offerableCurrencies(build([DEMO, VCHF]))).toEqual(['CHF']);
  });

  it('offers nothing when no rail exists at all — a broken catalog, surfaced not hidden', () => {
    expect(offerableCurrencies(build([DEMO, CKBTC]))).toEqual([]);
  });
});

describe('currencyOfAsset — the inverse mapping the accounts list marks rows with', () => {
  it('names the currency a rail settles', () => {
    const vchf = FULL.find(a => a.id === 'ic:7')!;
    const ckusdc = FULL.find(a => a.id === 'ic:2')!;
    expect(currencyOfAsset(vchf)).toBe('CHF');
    expect(currencyOfAsset(ckusdc)).toBe('USD');
  });

  it('is null for assets outside the home-currency model', () => {
    for (const id of ['ic:0', 'ic:1', 'ic:8']) {
      expect(currencyOfAsset(FULL.find(a => a.id === id)!)).toBeNull();
    }
  });

  it('round-trips with currencyRails for every offerable currency', () => {
    for (const c of offerableCurrencies(FULL)) {
      for (const rail of currencyRails(c, FULL)) expect(currencyOfAsset(rail)).toBe(c);
    }
  });
});

describe('parseHomeCurrency — absent means UNCHOSEN, never a guess', () => {
  it('accepts exactly the known currencies', () => {
    expect(parseHomeCurrency('CHF')).toBe('CHF');
    expect(parseHomeCurrency('USD')).toBe('USD');
    expect(parseHomeCurrency('EUR')).toBe('EUR');
  });

  it('returns null for absent, empty, unknown or wrongly-cased values', () => {
    for (const v of [null, undefined, '', 'chf', 'GBP', 'system', 'ic:7']) {
      expect(parseHomeCurrency(v)).toBeNull();
    }
  });
});

describe('railFees — fee FACTS in each rail\'s own unit, never a cross-token verdict', () => {
  const CKUSDC_FEE = mk({currency: 2, minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', fee: '10000'});
  const withSol = build([DEMO, CKUSDC_FEE, VCHF], true);

  it('formats an IC rail\'s catalog fee with the asset\'s own decimals and token', () => {
    const ckusdc = withSol.find(a => a.id === 'ic:2')!;
    expect(railFees(ckusdc, [DEMO, CKUSDC_FEE, VCHF]).perTransfer).toEqual({raw: '10000', formatted: '0.01 ckUSDC'});
    expect(railFees(ckusdc, [DEMO, CKUSDC_FEE, VCHF]).oneTime).toBeNull();
  });

  it('reports an IC rail with no catalog fee as unknown, never as free', () => {
    const vchf = withSol.find(a => a.id === 'ic:7')!;
    expect(railFees(vchf, [DEMO, CKUSDC_FEE, VCHF]).perTransfer).toBeNull();
    expect(railFees(vchf, []).perTransfer).toBeNull();
  });

  it('reports a native-SOL rail\'s signature fee in SOL, with no one-time cost', () => {
    const sol = withSol.find(a => a.id === 'solana:SOL')!;
    expect(railFees(sol, []).perTransfer).toEqual({raw: '5000', formatted: '0.000005 SOL'});
    expect(railFees(sol, []).oneTime).toBeNull();
  });

  it('keeps the USDC rail\'s signature fee in SOL (not USDC decimals) and adds the one-time ATA rent', () => {
    // The signature fee is charged in SOL even when moving USDC — the unit label stays SOL
    // (9-decimal lamports raw), not the rail token's decimals; display is compact.
    const usdc = withSol.find(a => a.id === 'solana:USDC')!;
    expect(railFees(usdc, []).perTransfer).toEqual({raw: '5000', formatted: '0.000005 SOL'});
    expect(railFees(usdc, []).oneTime).toEqual({raw: '2039280', formatted: '0.00203928 SOL'});
  });

  it('states EURC\'s one-time ATA rent too — the rent is a property of ANY SPL token rail', () => {
    // Generalized from the USDC special case: holding EURC needs the same associated token
    // account, so its fee fact carries the same rent in SOL at EURC's own rail.
    const eurc = withSol.find(a => a.id === 'solana:EURC')!;
    expect(railFees(eurc, []).perTransfer).toEqual({raw: '5000', formatted: '0.000005 SOL'});
    expect(railFees(eurc, []).oneTime).toEqual({raw: '2039280', formatted: '0.00203928 SOL'});
  });

  it('formats the VEUR rail\'s catalog fee with the IC row\'s own token', () => {
    const veur = build([DEMO, VEUR], true).find(a => a.id === 'ic:9')!;
    expect(railFees(veur, [VEUR]).perTransfer).toEqual({raw: '10000', formatted: '0.0001 VEUR'});
  });
});

describe('chooseRail — which rail, and why', () => {
  const withSol = build([DEMO, CKUSDC, VCHF], true);
  const ckusdc = withSol.find(a => a.id === 'ic:2')!;
  const vchf = withSol.find(a => a.id === 'ic:7')!;
  const usdc = withSol.find(a => a.id === 'solana:USDC')!;
  const bv = (status: BalanceView['status']): BalanceView => ({displayText: '1 X', status, failure: null});
  const bal = (...entries: [AssetId, BalanceView['status']][]): RailBalances =>
    Object.fromEntries(entries.map(([id, status]) => [id, bv(status)])) as RailBalances;

  it('falls back to the stated preference when nothing constrains the choice', () => {
    expect(chooseRail('USD', withSol)).toEqual({rail: ckusdc, reason: 'preference'});
    expect(chooseRail('CHF', withSol)).toEqual({rail: vchf, reason: 'preference'});
    expect(chooseRail('CHF', withSol, {})).toEqual({rail: vchf, reason: 'preference'});
  });

  it('is null when the catalog carries no rail for the currency', () => {
    // Within the HomeCurrency type, CHF with no VCHF row present is the no-rail case (a foreign
    // code like 'GBP' is a type error by design — the API only speaks home currencies).
    expect(chooseRail('CHF', build([DEMO, CKUSDC], true))).toBeNull();
  });

  it('resolves EUR to the EURC rail when it is the only visible one', () => {
    // This asset list carries solana:EURC but no VEUR row: EUR resolves to its one rail, so a
    // partially-catalogued EUR is still offerable (and honest — one rail is one rail).
    const out = chooseRail('EUR', withSol);
    expect(out?.rail.id).toBe('solana:EURC');
    // Narrow the solana arm to read the row's registry mint.
    expect(out != null && out.rail.protocol === 'solana' ? out.rail.mint : null).toBe(EURC_MINT_ADDRESS);
  });

  it('picks EURC over VEUR on preference, VEUR when it is the funded one', () => {
    const withEur = build([DEMO, CKUSDC, VCHF, VEUR], true);
    const veur = withEur.find(a => a.id === 'ic:9')!;
    // Fresh wallet: the deep-liquidity rail is the stated preference — EURC first.
    expect(chooseRail('EUR', withEur)).toEqual({rail: withEur.find(a => a.id === 'solana:EURC')!, reason: 'preference'});
    // Funded VEUR outranks the unfunded default — "already holds" beats "would default", the
    // same rule USD lives by; being thin changes the health NOTE, never the choice rule.
    expect(chooseRail('EUR', withEur, bal(['ic:9', 'ok']))).toEqual({rail: veur, reason: 'funded'});
  });

  it('picks the funded rail, in preference order among the funded ones', () => {
    expect(chooseRail('USD', withSol, bal(['ic:2', 'ok']))).toEqual({rail: ckusdc, reason: 'funded'});
    // A funded sibling is chosen over the unfunded default — "already holds" outranks "would default".
    expect(chooseRail('USD', withSol, bal(['solana:USDC', 'ok']))).toEqual({rail: usdc, reason: 'funded'});
    expect(chooseRail('CHF', withSol, bal(['ic:7', 'ok']))).toEqual({rail: vchf, reason: 'funded'});
  });

  it('never treats an unknown or known-zero balance as funded', () => {
    for (const status of ['loading', 'zero', 'absent', 'unavailable', 'error'] as const) {
      expect(chooseRail('USD', withSol, bal(['solana:USDC', status]))).toEqual({rail: ckusdc, reason: 'preference'});
    }
  });

  it('returns the destination-pinned rail, whichever rail of the group it names', () => {
    expect(chooseRail('USD', withSol, null, ckusdc)).toEqual({rail: ckusdc, reason: 'destination'});
    // The request's own rail wins even when the OTHER rail is funded — a merchant's settlement
    // asset is never second-guessed onto a "better" rail.
    expect(chooseRail('USD', withSol, bal(['ic:2', 'ok']), usdc)).toEqual({rail: usdc, reason: 'destination'});
  });

  it('is null when the destination names an asset outside the currency\'s group', () => {
    expect(chooseRail('USD', withSol, null, vchf)).toBeNull();
  });
});

describe('railsLabel — the whole group on one line', () => {
  it('names every rail of a two-rail currency, preferred first', () => {
    const withSol = build([DEMO, CKUSDC, VCHF], true);
    expect(railsLabel('USD', withSol)).toBe('ckUSDC · Internet Computer, USDC · Solana');
  });

  it('names EUR\'s two rails with EURC first', () => {
    expect(railsLabel('EUR', build([DEMO, VEUR], true))).toBe('EURC · Solana, VEUR · Internet Computer');
  });

  it('names the single rail of a one-rail currency', () => {
    expect(railsLabel('CHF', FULL)).toBe('VCHF · Internet Computer');
  });

  it('is null when the catalog carries no rail for the currency', () => {
    expect(railsLabel('EUR', FULL)).toBeNull();
  });
});

describe('rail health + ramp lines — catalog facts or silence', () => {
  // The dual-rail EUR shape: VEUR thin + DFX-sellable on the IC, EURC deep + rampless on Solana.
  // ckUSDC is rebuilt Direct+Direct (the bundled catalog's shape) so the both-direct derivation
  // has its live case too — the shared CKUSDC fixture above defaults Unavailable like VCHF.
  const CKUSDC_DIRECT = mk({currency: 2, minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', onramp: 'Direct', offramp: 'Direct'});
  const withEur = build([DEMO, CKUSDC_DIRECT, VCHF, VEUR], true);
  const eurc = withEur.find(a => a.id === 'solana:EURC')!;
  const veur = withEur.find(a => a.id === 'ic:9')!;
  const vchf = withEur.find(a => a.id === 'ic:7')!;
  const sol = withEur.find(a => a.id === 'solana:SOL')!;
  const usdc = withEur.find(a => a.id === 'solana:USDC')!;
  const ckusdc = withEur.find(a => a.id === 'ic:2')!;

  it('carries the catalog\'s liquidity tier verbatim, null when the row says nothing', () => {
    expect(railLiquidity(veur)).toBe('thin');
    expect(railLiquidity(eurc)).toBe('deep');
    // VCHF, SOL and USDC rows carry no tier — that is null, never a default verdict.
    expect(railLiquidity(vchf)).toBeNull();
    expect(railLiquidity(sol)).toBeNull();
    expect(railLiquidity(usdc)).toBeNull();
  });

  it('names the LEDGER token in the thin line, and states deep as a plain fact', () => {
    expect(railLiquidityLine(veur)).toBe('Very little VEUR exists on-chain today — receiving can be hard, and paying needs someone who holds it.');
    expect(railLiquidityLine(eurc)).toBe('Circulates widely on-chain today.');
    // Untiered rows make NO statement — no speculative copy for a tier the catalog cannot name.
    expect(railLiquidityLine(vchf)).toBeNull();
    expect(railLiquidityLine(sol)).toBeNull();
    expect(railLiquidityLine(usdc)).toBeNull();
  });

  it('derives the ramp line from the capabilities, and stays silent otherwise', () => {
    // VEUR: Unavailable onramp + Partner offramp naming DFX — the partner comes from the row.
    expect(railRampLine(veur)).toBe('DFX — sell only today.');
    // VCHF/EURC/SOL: Unavailable both ways ⇒ wallet-to-wallet, no ramp implied.
    expect(railRampLine(vchf)).toBe('No fiat ramp — wallet to wallet only.');
    expect(railRampLine(eurc)).toBe('No fiat ramp — wallet to wallet only.');
    expect(railRampLine(sol)).toBe('No fiat ramp — wallet to wallet only.');
    // ckUSDC: Direct both ways ⇒ the wired deposit/cash-out statement.
    expect(railRampLine(ckusdc)).toBe('Deposit and cash-out are wired in.');
  });

  it('renders NO ramp line for shapes the catalog does not carry today', () => {
    // A Partner offramp with no named partner has no honest line (the copy names the partner).
    expect(railRampLine({...veur, rampPartner: null})).toBeNull();
    // Direct mixed with a non-Direct direction has no derivable statement — no speculative key.
    expect(railRampLine({...veur, onramp: 'Direct'})).toBeNull();
    expect(railRampLine({...ckusdc, offramp: 'Unavailable'})).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// fundedAlternative — "this account is empty; which account of yours is not?" (X1, 2026-09-08).
//
// The measured defect it exists to kill: a brand-new wallet holds ∂100 of spendable practice
// money and every fund-blocked surface pointed at a 63-character deposit address instead, never
// naming the money the user already had. The answer is ranked, and the ranking is the whole
// design — a same-currency rail substitutes EXACTLY, another real asset is spendable but is a
// different currency, and practice money is neither, so it is named last and only where the
// action is paying.
// ---------------------------------------------------------------------------------------------
describe('fundedAlternative — the funded account a fund-blocked surface can name', () => {
  const withSol = build([DEMO, CKBTC, CKUSDC, VCHF, ICP], true);
  const ok = (displayText: string): BalanceView => ({displayText, status: 'ok', failure: null});

  const ask = (over: Partial<Parameters<typeof fundedAlternative>[0]>) => fundedAlternative({
    homeCurrency: 'USD',
    assets: withSol,
    balances: {},
    selectedAssetId: 'ic:2',
    purpose: 'pay',
    ...over,
  });

  it('prefers a funded rail of the SAME currency — the only substitute that is the same money', () => {
    const out = ask({balances: {'solana:USDC': ok('2.50 USDC'), 'ic:0': ok('∂100.00'), 'ic:1': ok('0.0005 BTC')}});
    expect(out).not.toBeNull();
    expect(out!.asset.id).toBe('solana:USDC');
    expect(out!.kind).toBe('sibling');
    expect(out!.held.displayText).toBe('2.50 USDC');
  });

  it('falls to another funded REAL account when the currency group has nothing', () => {
    // ckBTC selected: no home-currency group applies at all, and the wallet holds BTC nowhere —
    // but it does hold dollars, and holding dollars is a fact worth naming on a dead screen.
    const out = ask({selectedAssetId: 'ic:1', balances: {'ic:2': ok('5.00 ckUSDC'), 'ic:0': ok('∂100.00')}});
    expect(out!.asset.id).toBe('ic:2');
    expect(out!.kind).toBe('other');
  });

  it('names PRACTICE money last, and only when the action is paying', () => {
    // Nothing real is funded — the ∂100 the founder watched the app hide is the answer.
    expect(ask({balances: {'ic:0': ok('∂100.00')}})).toEqual(
      expect.objectContaining({kind: 'practice'}),
    );
    expect(ask({balances: {'ic:0': ok('∂100.00')}})!.asset.id).toBe('ic:0');
    // Sending needs a rail off the wallet, which practice money does not have — so it is not an
    // answer there and the surface must not pretend otherwise.
    expect(ask({purpose: 'send', balances: {'ic:0': ok('∂100.00')}})).toBeNull();
  });

  it('never names the selected account, and never an unfunded one', () => {
    expect(ask({balances: {'ic:2': ok('5.00 ckUSDC')}})).toBeNull();
    for (const status of ['zero', 'absent', 'unavailable', 'error', 'loading'] as const) {
      expect(ask({balances: {'solana:USDC': {displayText: '0.00 USDC', status, failure: null}}})).toBeNull();
    }
  });

  it('is null with nothing funded anywhere, and null before an asset is selected', () => {
    expect(ask({})).toBeNull();
    expect(ask({selectedAssetId: null, balances: {'ic:0': ok('∂100.00')}})).toBeNull();
  });
});
