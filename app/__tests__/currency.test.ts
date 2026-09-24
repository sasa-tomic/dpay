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
  STABLE_CURRENCIES,
  TOKEN_CURRENCIES,
  WALLET_CURRENCIES,
  chooseRail,
  currencyOfAsset,
  currencyRails,
  currencyUnitOf,
  fundedAlternative,
  isStableCurrency,
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
const CKETH = mk({currency: 6, minter: 's', minter_family: 'CkEthErc20', symbol: 'ETH', decimals: 18, wrapper_name: 'ckETH', backing_symbol: 'ETH', network: 'Ethereum'});
const VCHF = mk({currency: 7, minter_family: null, symbol: 'VCHF', decimals: 8, wrapper_name: 'VCHF', backing_symbol: 'VCHF', network: 'Internet Computer'});
const ICP = mk({currency: 8, minter_family: null, symbol: 'ICP', decimals: 8, wrapper_name: 'ICP', backing_symbol: 'ICP', network: 'Internet Computer'});
// The RETIRED VEUR row exactly as a legacy SERVED catalog still carries it (prod serves the old
// catalog until the founder redeploys): thin liquidity, sellable through DFX, a 10000-e8s
// transfer fee. EURC on Solana is the ONE catalogued EUR rail — this fixture exists to prove the
// served row renders honestly WITHOUT becoming a EUR rail again.
const LEGACY_VEUR = mk({currency: 9, minter_family: null, symbol: 'VEUR', decimals: 8, wrapper_name: 'VEUR', backing_symbol: 'VEUR', network: 'Internet Computer', fee: '10000', onramp: 'Unavailable', offramp: 'Partner', liquidity: 'thin', ramp_partner: 'DFX'});

const build = (catalog: CurrencyDescriptor[], solana = false): SelectableAsset[] =>
  buildSelectableAssets(catalog, {showTestnet: false, solanaEnabled: solana, solanaTokens: solana});

const FULL = build([DEMO, CKBTC, CKUSDC, CKETH, VCHF, ICP]);

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

  it('resolves the token currencies to exactly their own rails (generalized main, 2026-09-24)', () => {
    // BTC/ETH/ICP are IC rails; SOL's is the device-key rail's native row. One rail each today,
    // but the resolution is the SAME rail-table walk the stables use — no per-token special case.
    expect(currencyRails('BTC', FULL).map(a => a.id)).toEqual(['ic:1']);
    expect(currencyRails('ETH', build([DEMO, CKETH])).map(a => a.id)).toEqual(['ic:6']);
    expect(currencyRails('ICP', FULL).map(a => a.id)).toEqual(['ic:8']);
    expect(currencyRails('SOL', build([DEMO, CKBTC], true)).map(a => a.id)).toEqual(['solana:SOL']);
  });

  it('resolves EUR to nothing while its rail is not visible', () => {
    // The honesty gate stays: the rail table names EURC, but the row is not in THIS asset list
    // (no solana section), so EUR must resolve — and offer — nothing.
    expect(currencyRails('EUR', FULL)).toEqual([]);
  });

  it('resolves EUR to its single rail (EURC) even while a legacy VEUR row is still served', () => {
    // A legacy served catalog may still carry the retired VEUR row — it is NOT a rail (the rail
    // table shrank to EURC on 2026-09-19), so the resolved group is exactly one rail.
    const withEur = build([DEMO, CKUSDC, VCHF, LEGACY_VEUR], true);
    expect(currencyRails('EUR', withEur).map(a => a.id)).toEqual(['solana:EURC']);
  });

  it('resolves EUR to nothing when only the retired VEUR row is catalogued', () => {
    // The honesty gate in its sharpest form: a served VEUR row alone must NOT make EUR offerable
    // again — the rail table, not the catalog row, decides what EUR is.
    expect(currencyRails('EUR', build([DEMO, LEGACY_VEUR]))).toEqual([]);
  });

  it('never resolves the practice rail as a currency rail', () => {
    // DEMO is not a currency in this model: no currency's rail set may contain it, whatever
    // else the catalog carries.
    const railIds = WALLET_CURRENCIES.flatMap(c => currencyRails(c, FULL).map(a => a.id));
    expect(railIds).not.toContain('ic:0');
    // ...and every REAL asset in the list settles exactly one currency now (the generalized
    // model's totality: ckBTC→BTC, ICP→ICP, VCHF→CHF, ckUSDC→USD).
    for (const a of FULL) {
      if (a.id === 'ic:0') continue;
      expect(WALLET_CURRENCIES.filter(c => currencyRails(c, FULL).some(r => r.id === a.id))).toHaveLength(1);
    }
  });
});

describe('preferredRail — the asset the wallet lands on', () => {
  it('is the first rail in preference order', () => {
    const withSol = build([DEMO, CKUSDC, VCHF], true);
    expect(preferredRail('USD', withSol)?.id).toBe('ic:2');
    expect(preferredRail('CHF', withSol)?.id).toBe('ic:7');
    // EUR's single rail is the deep-liquidity EURC rail (VEUR retired 2026-09-19).
    expect(preferredRail('EUR', build([DEMO, LEGACY_VEUR], true))?.id).toBe('solana:EURC');
  });

  it('is null when the catalog cannot realise the currency', () => {
    expect(preferredRail('EUR', FULL)).toBeNull();
    // ...and for a currency whose only rail was filtered out of the visible list entirely.
    expect(preferredRail('CHF', build([DEMO, CKBTC]))).toBeNull();
  });
});

describe('offerableCurrencies — the chooser never offers what it cannot deliver', () => {
  it('offers only the currencies the catalog carries a rail for — stables AND token currencies', () => {
    // The generalized main (2026-09-24): the bundled IC catalog realises CHF/USD and, through
    // their own token rails, BTC/ETH/ICP; EUR needs the Solana EURC row (absent here); SOL needs
    // the device-key rail (solana disabled here). Order is declaration order: stables, then tokens.
    expect(offerableCurrencies(FULL)).toEqual(['CHF', 'USD', 'BTC', 'ETH', 'ICP']);
  });

  it('drops a currency whose rail is missing, and keeps declaration order', () => {
    expect(offerableCurrencies(build([DEMO, CKUSDC]))).toEqual(['USD']);
    expect(offerableCurrencies(build([DEMO, VCHF]))).toEqual(['CHF']);
    expect(offerableCurrencies(build([DEMO, ICP]))).toEqual(['ICP']);
  });

  it('offers nothing when no rail exists at all — a broken catalog, surfaced not hidden', () => {
    // DEMO alone is practice money, not a currency: nothing may be offered.
    expect(offerableCurrencies(build([DEMO]))).toEqual([]);
  });
});

describe('currencyOfAsset — the inverse mapping the accounts list marks rows with', () => {
  it('names the currency a rail settles', () => {
    const vchf = FULL.find(a => a.id === 'ic:7')!;
    const ckusdc = FULL.find(a => a.id === 'ic:2')!;
    expect(currencyOfAsset(vchf)).toBe('CHF');
    expect(currencyOfAsset(ckusdc)).toBe('USD');
  });

  it('names the token currencies too — the generalized main reaches every real rail', () => {
    expect(currencyOfAsset(FULL.find(a => a.id === 'ic:1')!)).toBe('BTC');
    expect(currencyOfAsset(FULL.find(a => a.id === 'ic:8')!)).toBe('ICP');
    expect(currencyOfAsset(build([DEMO, CKETH]).find(a => a.id === 'ic:6')!)).toBe('ETH');
    expect(currencyOfAsset(build([DEMO], true).find(a => a.id === 'solana:SOL')!)).toBe('SOL');
  });

  it('is null ONLY for the practice rail', () => {
    expect(currencyOfAsset(FULL.find(a => a.id === 'ic:0')!)).toBeNull();
    for (const a of FULL) {
      if (a.id === 'ic:0') continue;
      expect(currencyOfAsset(a)).not.toBeNull();
    }
  });

  it('never resolves a TESTNET sibling as a rail of the mainnet currency', () => {
    // ckTESTBTC carries its own wrapper token, so it is not a BTC rail: a testnet balance must
    // never read as, or set, the mainnet currency.
    const CKTESTBTC = mk({currency: 3, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckTESTBTC', backing_symbol: 'BTC', network: 'Bitcoin Testnet', testnet: true});
    const withTestnet = buildSelectableAssets([DEMO, CKBTC, CKTESTBTC], {showTestnet: true, solanaEnabled: false});
    expect(currencyRails('BTC', withTestnet).map(a => a.id)).toEqual(['ic:1']);
    expect(currencyOfAsset(withTestnet.find(a => a.id === 'ic:3')!)).toBeNull();
  });

  it('round-trips with currencyRails for every offerable currency', () => {
    for (const c of offerableCurrencies(FULL)) {
      for (const rail of currencyRails(c, FULL)) expect(currencyOfAsset(rail)).toBe(c);
    }
  });
});

describe('parseHomeCurrency — absent means UNCHOSEN, never a guess', () => {
  it('accepts exactly the known currencies — stables and token currencies alike', () => {
    expect(parseHomeCurrency('CHF')).toBe('CHF');
    expect(parseHomeCurrency('USD')).toBe('USD');
    expect(parseHomeCurrency('EUR')).toBe('EUR');
    // The generalized main (2026-09-24): a stored 'BTC'/'ICP' is a wallet the user deliberately
    // set to a token currency — it must survive a restart, not fall back to a stable.
    expect(parseHomeCurrency('BTC')).toBe('BTC');
    expect(parseHomeCurrency('ETH')).toBe('ETH');
    expect(parseHomeCurrency('ICP')).toBe('ICP');
    expect(parseHomeCurrency('SOL')).toBe('SOL');
  });

  it('returns null for absent, empty, unknown or wrongly-cased values', () => {
    for (const v of [null, undefined, '', 'chf', 'GBP', 'DEMO', 'system', 'ic:7']) {
      expect(parseHomeCurrency(v)).toBeNull();
    }
  });
});

describe('the generalized main — isStableCurrency + currencyUnitOf (fork #4)', () => {
  it('partitions the wallet currencies into stables and Other', () => {
    for (const c of STABLE_CURRENCIES) expect(isStableCurrency(c)).toBe(true);
    for (const c of TOKEN_CURRENCIES) expect(isStableCurrency(c)).toBe(false);
    // The two lists are the whole model, disjoint, in presentation order.
    expect(WALLET_CURRENCIES).toEqual([...STABLE_CURRENCIES, ...TOKEN_CURRENCIES]);
  });

  it('formats the stable balances in the CURRENCY unit, as the founder sketched', () => {
    // "4,54 Fr" is a SUFFIX; "$4.54" / "€4.54" are PREFIXES — the sketch's own placement.
    expect(currencyUnitOf('CHF')).toEqual({position: 'suffix', symbol: 'Fr'});
    expect(currencyUnitOf('USD')).toEqual({position: 'prefix', symbol: '$'});
    expect(currencyUnitOf('EUR')).toEqual({position: 'prefix', symbol: '€'});
  });

  it('leaves the pure-token currencies on their token unit (currency == token there)', () => {
    for (const c of TOKEN_CURRENCIES) expect(currencyUnitOf(c)).toBeNull();
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

  it('formats an IC rail\'s catalog fee with the row\'s own token', () => {
    // The legacy VEUR fixture proved this same path for a Partner row; VCHF carries the identical
    // 10000-e8s fee on the real bundled row (the shared fixture above leaves fee null — the
    // honest default — so this one restates the row's actual fee).
    const VCHF_FEE = mk({currency: 7, minter_family: null, symbol: 'VCHF', decimals: 8, wrapper_name: 'VCHF', backing_symbol: 'VCHF', network: 'Internet Computer', fee: '10000'});
    const vchf = build([DEMO, VCHF_FEE], true).find(a => a.id === 'ic:7')!;
    expect(railFees(vchf, [VCHF_FEE]).perTransfer).toEqual({raw: '10000', formatted: '0.0001 VCHF'});
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

  it('is null when the only served EUR row is the retired VEUR rail outside the group', () => {
    // A legacy served catalog carries the VEUR row, but it is NOT a EUR rail any more: with the
    // solana arm off (no EURC row anywhere in the list), a funded VEUR cannot win the EUR choice
    // (it is not in the group) and the choice is honestly null — never a crash, never a
    // resuscitated rail.
    const legacyOnly = build([DEMO, VCHF, LEGACY_VEUR]);
    expect(chooseRail('EUR', legacyOnly)).toBeNull();
    expect(chooseRail('EUR', legacyOnly, bal(['ic:9', 'ok']))).toBeNull();
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

  it('answers for the TOKEN currencies by the same three-step policy (generalized main)', () => {
    // BTC as the main currency behaves exactly like CHF: preference default, funded override,
    // destination pin — no token special case anywhere.
    const withBtc = build([DEMO, CKBTC, CKUSDC, VCHF]);
    const ckbtc = withBtc.find(a => a.id === 'ic:1')!;
    expect(chooseRail('BTC', withBtc)).toEqual({rail: ckbtc, reason: 'preference'});
    expect(chooseRail('BTC', withBtc, bal(['ic:1', 'ok']))).toEqual({rail: ckbtc, reason: 'funded'});
    expect(chooseRail('BTC', withBtc, null, ckbtc)).toEqual({rail: ckbtc, reason: 'destination'});
    expect(chooseRail('BTC', withBtc, null, vchf)).toBeNull();
    expect(chooseRail('BTC', build([DEMO, CKUSDC]))).toBeNull();
  });
});

describe('railsLabel — the whole group on one line', () => {
  it('names every rail of a two-rail currency, preferred first', () => {
    const withSol = build([DEMO, CKUSDC, VCHF], true);
    expect(railsLabel('USD', withSol)).toBe('ckUSDC · Internet Computer, USDC · Solana');
  });

  it('names EUR\'s single rail (a served legacy VEUR row does not join the line)', () => {
    expect(railsLabel('EUR', build([DEMO, LEGACY_VEUR], true))).toBe('EURC · Solana');
  });

  it('names the single rail of a one-rail currency', () => {
    expect(railsLabel('CHF', FULL)).toBe('VCHF · Internet Computer');
  });

  it('is null when the catalog carries no rail for the currency', () => {
    expect(railsLabel('EUR', FULL)).toBeNull();
  });
});

describe('rail health + ramp lines — catalog facts or silence', () => {
  // The LEGACY served EUR shape: VEUR thin + DFX-sellable on the IC (still served until the
  // founder's redeploy), EURC deep + rampless on Solana. The retired row is the thin+Partner
  // SPECIMEN: the machinery below is generic and must keep working on whatever row still ships
  // it. ckUSDC is rebuilt Direct+Direct (the bundled catalog's shape) so the both-direct
  // derivation has its live case too — the shared CKUSDC fixture above defaults Unavailable
  // like VCHF.
  const CKUSDC_DIRECT = mk({currency: 2, minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', onramp: 'Direct', offramp: 'Direct'});
  const withEur = build([DEMO, CKUSDC_DIRECT, VCHF, LEGACY_VEUR], true);
  const eurc = withEur.find(a => a.id === 'solana:EURC')!;
  const legacyVeur = withEur.find(a => a.id === 'ic:9')!;
  const vchf = withEur.find(a => a.id === 'ic:7')!;
  const sol = withEur.find(a => a.id === 'solana:SOL')!;
  const usdc = withEur.find(a => a.id === 'solana:USDC')!;
  const ckusdc = withEur.find(a => a.id === 'ic:2')!;

  it('carries the catalog\'s liquidity tier verbatim, null when the row says nothing', () => {
    expect(railLiquidity(legacyVeur)).toBe('thin');
    expect(railLiquidity(eurc)).toBe('deep');
    // VCHF, SOL and USDC rows carry no tier — that is null, never a default verdict.
    expect(railLiquidity(vchf)).toBeNull();
    expect(railLiquidity(sol)).toBeNull();
    expect(railLiquidity(usdc)).toBeNull();
  });

  it('states thin in 2–3 words on the rail it sits on, and deep as a plain fact', () => {
    expect(railLiquidityLine(legacyVeur)).toBe('Thin liquidity');
    expect(railLiquidityLine(eurc)).toBe('Circulates widely on-chain today.');
    // Untiered rows make NO statement — no speculative copy for a tier the catalog cannot name.
    expect(railLiquidityLine(vchf)).toBeNull();
    expect(railLiquidityLine(sol)).toBeNull();
    expect(railLiquidityLine(usdc)).toBeNull();
  });

  it('derives the ramp line from the capabilities, and stays silent otherwise', () => {
    // The legacy row: Unavailable onramp + Partner offramp naming DFX — the partner comes from
    // the row, whatever row it is.
    expect(railRampLine(legacyVeur)).toBe('DFX — sell only today.');
    // VCHF/EURC/SOL: Unavailable both ways ⇒ wallet-to-wallet, no ramp implied.
    expect(railRampLine(vchf)).toBe('No fiat ramp — wallet to wallet only.');
    expect(railRampLine(eurc)).toBe('No fiat ramp — wallet to wallet only.');
    expect(railRampLine(sol)).toBe('No fiat ramp — wallet to wallet only.');
    // ckUSDC: Direct both ways ⇒ the wired deposit/cash-out statement.
    expect(railRampLine(ckusdc)).toBe('Deposit and cash-out are wired in.');
  });

  it('renders NO ramp line for shapes the catalog does not carry today', () => {
    // A Partner offramp with no named partner has no honest line (the copy names the partner).
    expect(railRampLine({...legacyVeur, rampPartner: null})).toBeNull();
    // Direct mixed with a non-Direct direction has no derivable statement — no speculative key.
    expect(railRampLine({...legacyVeur, onramp: 'Direct'})).toBeNull();
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
