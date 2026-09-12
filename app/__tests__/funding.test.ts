/**
 * funding — how a user who holds NOTHING gets some (founder direction 2026-09-09; the design and
 * the measured provider evidence live in `docs/specs/2026-09-09-funding-routes-plan.md`).
 *
 * These are claims about the world, not about a renderer, which is why `fundingRoute` is pure and
 * tested here rather than inlined into the deposit surfaces.
 *
 * ── WHY EVERY ASSET HERE COMES FROM THE REAL CATALOG ─────────────────────────────────────────
 * The first version of this file hand-typed its `SelectableAsset` fixtures, and one of them was a
 * shape the app cannot produce: play money with `linkToken: null`, where the real builder emits
 * `'DEMO'`. So the test that proved "play money is never given a funding route" was proving it
 * about an asset that does not exist, while the real DEMO row fell through to the convert branch.
 * Every asset below is now built by `buildSelectableAssets` from `BUNDLED_NETWORKS` — the same two
 * functions the app calls — so a fixture cannot describe a wallet nobody has.
 *
 * ── AND WHY THE MECHANISM IS PASSED IN ───────────────────────────────────────────────────────
 * `fundingRoute` used to infer how money arrives from `asset.network`, a DISPLAY fact about what a
 * chain-key asset is backed by. That produced the defect this file now guards: ckUSDC was told to
 * "buy USDC and send it to the address above" on a screen showing an Internet Computer principal,
 * when its real deposit is a transaction the user's own Ethereum wallet signs plus separate ETH for
 * gas. The mechanism now comes from `depositMechanism()` — the catalog's own `minter_family` — and
 * the same value picks the deposit sheet, so the instruction and the surface cannot disagree.
 */
import {describe, test, expect} from '@jest/globals';
import {
  fundingRoute, bankRouteApplies,
  FUNDING_PROVIDERS, FUNDING_SOURCES_READ_ON,
} from '../config/funding';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, depositMechanism, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';

const CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: true, solanaEnabled: true, solanaTokens: true});

/** One shipped row, by the id the app itself derives. Throws rather than skipping: a catalog that
 *  stopped carrying an asset this file reasons about is news, not a reason to pass. */
function asset(id: string): SelectableAsset {
  const found = ASSETS.find(a => a.id === id);
  if (!found) throw new Error(`no asset ${id} in the bundled catalog — this test's premise changed`);
  return found;
}
/** The mechanism the app would use for that row — the same call `ReceiveMode` makes to pick the
 *  deposit sheet, so these cases describe the screen the user actually lands on. */
function mech(id: string) {
  const a = asset(id);
  return depositMechanism(a.protocol === 'ic' ? CATALOG.find(c => c.currency === a.currency) : null);
}

const DEMO = 'ic:0', CKBTC = 'ic:1', CKUSDC = 'ic:2', CKETH = 'ic:6', VCHF = 'ic:7', ICP = 'ic:8';
const SOL_USDC = 'solana:USDC';

describe('fundingRoute — the route is the DEPOSIT MECHANISM, never the chain a token is backed by', () => {
  test('a Solana asset is bought directly and sent to the address on screen', () => {
    // No descriptor and no minter: every Solana row is bought on Solana and sent to a Solana
    // address, which is what the rail's own surface asserts when it builds its instruction.
    expect(fundingRoute(asset(SOL_USDC), false, 'send-to-address'))
      .toEqual({kind: 'buy', token: 'USDC', chain: 'Solana'});
  });

  test('native ICP is bought directly — the ONE card-reachable Internet Computer asset', () => {
    expect(mech(ICP)).toBe('icrc-transfer');
    expect(fundingRoute(asset(ICP), false, 'icrc-transfer'))
      .toEqual({kind: 'buy', token: 'ICP', chain: 'Internet Computer'});
  });

  test('ckBTC is a one-hop buy of plain BTC — the sheet shows a real Bitcoin address', () => {
    // The easy mistake in the other direction: ckBTC is not sold anywhere, so it looks like it
    // needs a convert leg. It does not — the UTXO sheet shows a real Bitcoin address and the minter
    // does the rest. The token to buy is plain BTC (the wallet shows backing symbols, never wrapper
    // ids) and the chain to buy it on is BITCOIN, not the Internet Computer the row settles on.
    expect(mech(CKBTC)).toBe('send-to-address');
    expect(fundingRoute(asset(CKBTC), false, 'send-to-address'))
      .toEqual({kind: 'buy', token: 'BTC', chain: 'Bitcoin'});
  });

  test('ckUSDC is NOT a send-to-address deposit, and saying so is money-loss-shaped', () => {
    // THE DEFECT THIS FILE EXISTS FOR. ckUSDC's deposit is `approve` + `depositErc20` signed by the
    // user's own Ethereum wallet, with the gas paid separately in ETH — there is no address to send
    // to. The old resolver read `network === 'Ethereum'` and produced "buy USDC and send it to the
    // address above", on the surface that shows an Internet Computer principal.
    expect(mech(CKUSDC)).toBe('evm-wallet');
    const route = fundingRoute(asset(CKUSDC), false, 'evm-wallet');
    expect(route).toEqual({kind: 'bridge', token: 'USDC', chain: 'Ethereum', gasToken: 'ETH'});
    // The gas coin is the catalog's own answer (ckUSDC's `gas_ledger` is the ckETH ledger), not a
    // constant typed here — a wallet with no ETH cannot complete this deposit at all.
    const usdc = asset(CKUSDC);
    expect(usdc.protocol === 'ic' ? usdc.gasToken : null).toBe('ETH');
  });

  test('ckETH is the same wallet-signed deposit, but it pays its own gas', () => {
    // `token_contract` is null, so the deposit is ONE payable `depositEth` and the fee comes out of
    // the same ETH. Naming a separate gas coin here would tell the user to go and get a second
    // holding they do not need.
    expect(mech(CKETH)).toBe('evm-wallet-native');
    expect(fundingRoute(asset(CKETH), false, 'evm-wallet-native'))
      .toEqual({kind: 'bridge', token: 'ETH', chain: 'Ethereum', gasToken: null});
  });

  test('VCHF has no card route anywhere, so it goes through native ICP and a user-signed convert', () => {
    expect(mech(VCHF)).toBe('icrc-transfer');
    expect(fundingRoute(asset(VCHF), false, 'icrc-transfer'))
      .toEqual({kind: 'convert', viaToken: 'ICP', targetSymbol: 'VCHF'});
  });

  test('a TESTNET coin is sent to a faucet, never to a card provider — and keeps its mechanism', () => {
    // The naive check is `network !== 'Internet Computer' ⇒ buy it`, which cheerfully tells the
    // user to purchase testnet BTC from MoonPay. Testnet-ness is server-declared, so it is passed
    // in rather than inferred from a label.
    expect(fundingRoute(asset(CKBTC), true, 'send-to-address'))
      .toEqual({kind: 'testnet', symbol: 'BTC', chain: 'Bitcoin', viaWallet: false});
    // A faucet coin on the ckERC20 rail still arrives by a signed transaction, so the faucet
    // instruction must not end with "send it to the address above" either.
    expect(fundingRoute(asset(CKUSDC), true, 'evm-wallet'))
      .toEqual({kind: 'testnet', symbol: 'USDC', chain: 'Ethereum', viaWallet: true});
    // And testnet-ness outranks every other branch, including the Solana one.
    expect(fundingRoute(asset(SOL_USDC), true, 'send-to-address').kind).toBe('testnet');
  });

  test('play money is never given a funding route — the REAL play-money row, not a fixture', () => {
    // Offering to sell someone play money is the scam signature the first-run work exists to
    // remove, and it would be a lie besides — no provider sells it and it has no cash value. The
    // shipped DEMO row carries `linkToken: 'DEMO'` and a null network, which the old resolver read
    // as "an Internet Computer token nobody sells" and answered with a convert route.
    expect(asset(DEMO).linkToken).toBe('DEMO');
    expect(mech(DEMO)).toBe('none');
    expect(fundingRoute(asset(DEMO), false, 'none')).toEqual({kind: 'none'});
  });

  test('a row with no honest instruction gets no card, rather than an invented chain', () => {
    // An IC row whose network the catalog does not declare cannot be instructed on. Fail closed:
    // no card beats a card naming a chain nobody said.
    const nameless = {...asset(CKBTC), network: null} as SelectableAsset;
    expect(fundingRoute(nameless, false, 'send-to-address')).toEqual({kind: 'none'});
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
    // A row with nothing to say is a name with an implied endorsement and no information. A
    // method with no published figure is omitted from `costs` (MoonPay's bank), so a provider
    // whose `costs` were empty AND carried no other published part would be exactly that.
    for (const p of FUNDING_PROVIDERS) {
      const hasFigure = p.costs.length > 0 || p.minFee !== null || p.spread !== null;
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
    // A cap is not a price, a floor is not a cap, and an omitted method is not zero.
    const by = (k: string) => FUNDING_PROVIDERS.find(p => p.key === k);
    expect(by('coinbase')?.costs).toEqual([
      {method: 'card', rate: {kind: 'flat', pct: 2.5}},
      {method: 'bank', rate: {kind: 'flat', pct: 0.5}},
    ]);
    expect(by('moonpay')?.costs).toEqual([{method: 'card', rate: {kind: 'cap', pct: 4.5}}]);
    // Re-read 2026-09-12: MoonPay still publishes NO bank figure at all (its only "1%" is the
    // Virtual Account Transaction Fee — a different product, and "typically about" is neither a
    // floor nor a cap), so the method is omitted rather than kept as a stale claim. And its
    // non-USD minimum-fee uplift is published only as a range — carried as one, never as its top.
    expect(by('moonpay')?.costs.some(c => c.method === 'bank')).toBe(false);
    expect(by('moonpay')?.nonUsdUplift).toEqual({fromPct: 0.25, toPct: 10});
    // Transak (re-read 2026-09-12): the per-method fee tables are published TEXT now, not
    // images — card 3.5% + €1 in EUR and 5.5% + €1 outside it, wallet pay 3.5% / 5.5% with a
    // €1 minimum, SEPA 0.99% with the same minimum. The `varies` this row used to carry would
    // now be the stale claim: figures ARE published.
    expect(by('transak')?.costs).toEqual([
      {method: 'card', rate: {kind: 'flat', pct: 3.5}, fixed: '€1', applies: 'eur'},
      {method: 'card', rate: {kind: 'flat', pct: 5.5}, fixed: '€1', applies: 'non-eur'},
      {method: 'walletPay', rate: {kind: 'flat', pct: 3.5}, min: '€1', applies: 'eur'},
      {method: 'walletPay', rate: {kind: 'flat', pct: 5.5}, min: '€1', applies: 'non-eur'},
      {method: 'sepa', rate: {kind: 'flat', pct: 0.99}, min: '€1'},
    ]);
    // The spread IS quantified — as "0% to 2.5%" over CoinGecko mid. Transcribed as the
    // ceiling, so it renders "up to 2.5%".
    expect(by('transak')?.spread).toEqual({kind: 'cap', pct: 2.5});
  });

  test("Ramp's split rates are each their own row — nothing conditional folded into a range (F2)", () => {
    // The F2 defect this file now guards: the table carried only the 3.9% card ceiling, which
    // is the USD/EUR/GBP figure — for other currencies, CHF among them (this wallet's home
    // market), Ramp's ceiling is 5.45%. A CHF user was shown a number that does not apply to
    // them as if it did. And the bank transfer is split by type: the old single 1.4% was the
    // MANUAL figure and understated easy (2.4%) and Pix (2.9%).
    const ramp = FUNDING_PROVIDERS.find(p => p.key === 'ramp');
    expect(ramp?.costs.filter(c => c.method === 'card')).toEqual([
      {method: 'card', rate: {kind: 'cap', pct: 3.9}, applies: 'usd-eur-gbp'},
      {method: 'card', rate: {kind: 'cap', pct: 5.45}, applies: 'other-currencies'},
    ]);
    expect(ramp?.costs.filter(c => c.method === 'bank').map(c => [c.applies, c.rate.pct]))
      .toEqual([['manual', 1.4], ['easy', 2.4], ['pix', 2.9]]);
    expect(ramp?.minFee).toBe('€2.49');
  });
});
