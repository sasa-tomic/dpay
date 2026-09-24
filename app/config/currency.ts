// The MAIN CURRENCY — the one currency the wallet is "in" (founder direction, 2026-09-04).
//
// A currency is NOT an asset. It is a set of rails that all settle the same unit: CHF is VCHF on
// the Internet Computer and (when it lands) VCHF on Solana; USD is ckUSDC on the IC and USDC on
// Solana; EUR is EURC on Solana — the sole EUR rail since the 2026-09-19 VEUR retirement. The user
// picks a currency; this module
// resolves it to the concrete assets the CURRENT catalog can actually realise, in preference
// order. Full direction + the boundary that keeps rail-selection out of swap territory:
// docs/specs/2026-09-04-currency-first-wallet-plan.md.
//
// GENERALIZED MAIN CURRENCY (2026-09-24, the currency-first redesign): the wallet's main currency
// is no longer one of the fiat stables — ANY wallet currency can be main, the pure-token ones
// (BTC/ETH/ICP/SOL) included. A token currency is its own currency: its rail set is the rows that
// settle exactly that token, and its display unit IS the token (currency == unit there). DEMO is
// deliberately NOT a currency in this model: practice money is never settable as main and never
// enters the currency list — it keeps its own separated practice slot wherever it renders.
//
// Two rules this module exists to enforce, both of them honesty rules:
//
//   1. A currency is only OFFERED if the catalog carries a rail for it. EUR is the live case: it
//      is offered exactly while an EURC row is catalogued — a currency whose last row vanishes
//      disappears from the chooser on its own, with no code change here (VEUR's 2026-09-19
//      retirement shrank EUR to its one remaining rail by editing only CURRENCY_RAILS below).
//      Shipping a currency the user can select and then cannot hold
//      would be exactly the dead end the founder's 2026-08-29 rule forbids.
//   2. BALANCES RENDER IN THE CURRENCY UNIT (founder fork #4, 2026-09-24 — supersedes the
//      2026-09-04 token-is-the-unit rule for BALANCE DISPLAY only): a CHF balance renders
//      `4.54 Fr`, a USD balance `$4.54`, a EUR balance `€4.54`; pure-token currencies keep their
//      token unit (`0.0005 BTC`). The peg disclosure lives where fees/quotes are shown — a
//      balance is not a peg claim, and VCHF remains the only thing a CHF rail actually moves
//      (docs/VCHF_ICP_ANALYSIS.md). History rows keep their own token units.
//
// PURE: no React, no AsyncStorage, no network. Deterministic in (currency, assets, balances,
// destination, catalog).
//
// Objective 2 (2026-09-04 plan): the GROUP is the model. A currency is a set of rails, and this
// module also answers "which rail, and why" (chooseRail) and "what does each rail cost" (railFees)
// — as FACTS, never as a verdict: every fee stays in its own token's unit, because comparing
// "0.0001 VCHF" against "0.000005 SOL" is an FX quote, and dpay does not quote FX (no swap, no
// exchange credentials — CLAUDE.md boundary). The day a price comparison is wanted, a quote source
// arrives first; until then both numbers are shown side by side, in their own units, and the human
// does the comparing.
import {type SelectableAsset, linkNetworkOf, prettyNetwork, tokenEq} from './assets';
import {type CurrencyDescriptor, assetLinkToken} from './catalog';
import {type BalanceView} from '../lib/assetBalances';
import {fmtAssetCompact} from '../lib/format';
import {type AssetId} from '../lib/types';
import {SOL_ATA_RENT_LAMPORTS, SOL_FEE_LAMPORTS} from '../solana/spl';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {M} from '../i18n';

/** The currencies dpay can be "in". Ordered as every list presents them: the fiat stables first,
 *  then the pure-token currencies ("Other"). DEMO is deliberately absent — practice money is
 *  never a main currency (docs/specs/2026-09-24-currency-first-radical-redesign.md). */
export const STABLE_CURRENCIES = ['CHF', 'USD', 'EUR'] as const;
export const TOKEN_CURRENCIES = ['BTC', 'ETH', 'ICP', 'SOL'] as const;
export const WALLET_CURRENCIES = [...STABLE_CURRENCIES, ...TOKEN_CURRENCIES] as const;
export type HomeCurrency = (typeof WALLET_CURRENCIES)[number];

/** Is this one of the fiat stables ("Stable currencies" section) or a pure token ("Other")? */
export function isStableCurrency(c: HomeCurrency): boolean {
  return (STABLE_CURRENCIES as readonly string[]).includes(c);
}

/**
 * Fork #4 — the currency-unit format for a balance: prefix ("$4.54", "€4.54"), suffix
 * ("4.54 Fr"), or null for a pure-token currency, whose unit IS the token and rides as the
 * suffix the token formatters already render ("0.0005 BTC"). Symbols are locale-invariant
 * product identity (the i18n catalog's own rule), never translated copy.
 */
export type CurrencyUnitFormat = {position: 'prefix' | 'suffix'; symbol: string};
export function currencyUnitOf(currency: HomeCurrency): CurrencyUnitFormat | null {
  switch (currency) {
    case 'CHF': return {position: 'suffix', symbol: 'Fr'};
    case 'USD': return {position: 'prefix', symbol: '$'};
    case 'EUR': return {position: 'prefix', symbol: '€'};
    default: return null;
  }
}

// Which ledger tokens realise each currency, in PREFERENCE ORDER — the first one present in the
// catalog is the rail the wallet lands on. Order is a product decision, not an accident:
//   USD prefers ckUSDC because the Internet Computer rail is the one whose offline tap is proven
//   on physical hardware; the Solana USDC row is the same dollar on a second rail.
//   EUR is EURC on Solana alone since the 2026-09-19 VEUR retirement: VEUR was the thin IC rail
//   (VEUR rode second in this list as the fallback), and the deep-liquidity EURC rail — the
//   stated preference, backed by a catalog field — is the one that remains.
//   The token currencies settle exactly their own token: ckBTC is the BTC rail, ckETH the ETH
//   rail, ICP and native SOL are theirs. A testnet sibling (ckTESTBTC, ckSepoliaUSDC) carries a
//   DIFFERENT wrapper token, so it never resolves as a rail of the mainnet currency.
// Matching is by the asset's `linkToken` through `tokenEq` — the ONE definition of asset-token
// identity in the app (app/config/assets.ts). A second definition here would be a second way to
// resolve a currency to the wrong asset.
const CURRENCY_RAILS: Record<HomeCurrency, readonly string[]> = {
  CHF: ['VCHF'],
  USD: ['ckUSDC', 'USDC'],
  EUR: ['EURC'],
  BTC: ['ckBTC'],
  ETH: ['ckETH'],
  ICP: ['ICP'],
  SOL: ['SOL'],
};

/**
 * Every visible asset that settles `currency`, in preference order. Empty when the catalog carries
 * no rail for it — which is the signal that the currency must not be offered.
 *
 * Preference order comes from CURRENCY_RAILS, NOT from catalog order, so the wallet's choice of
 * rail is a stated product decision rather than a side effect of how the relay happens to sort its
 * rows.
 */
export function currencyRails(currency: HomeCurrency, assets: SelectableAsset[]): SelectableAsset[] {
  const rails: SelectableAsset[] = [];
  for (const token of CURRENCY_RAILS[currency]) {
    for (const asset of assets) {
      if (tokenEq(asset.linkToken, token)) rails.push(asset);
    }
  }
  return rails;
}

/** The rail the wallet lands on for `currency`, or null when the catalog cannot realise it. */
export function preferredRail(currency: HomeCurrency, assets: SelectableAsset[]): SelectableAsset | null {
  const rails = currencyRails(currency, assets);
  return rails.length > 0 ? rails[0] : null;
}

/**
 * The currencies this catalog can actually realise — the chooser's list. Derived, never hardcoded,
 * so a new rail row (EURC, VCHF on Solana) enables its currency with no change here.
 */
export function offerableCurrencies(assets: SelectableAsset[]): HomeCurrency[] {
  return WALLET_CURRENCIES.filter(c => preferredRail(c, assets) !== null);
}

/** Which currency does this LINK TOKEN settle, if any? The one resolver `currencyOfAsset` and the
 *  catalog-row form below both share — token identity has exactly one definition (`tokenEq`), so
 *  the currency lookup has exactly one too. Null only for DEMO (practice money is not a currency
 *  in this model — it is never main and never a list row). */
export function currencyOfLinkToken(linkToken: string | null | undefined): HomeCurrency | null {
  const t = linkToken ?? null;
  for (const currency of WALLET_CURRENCIES) {
    if (CURRENCY_RAILS[currency].some(token => tokenEq(t, token))) return currency;
  }
  return null;
}

/** Which currency does this asset settle, if any? The inverse of `currencyRails`, used to mark the
 *  main-currency rows in the accounts list. */
export function currencyOfAsset(asset: SelectableAsset): HomeCurrency | null {
  return currencyOfLinkToken(asset.linkToken);
}

/** The same lookup for a raw catalog row (the convert surfaces resolve destinations by LEDGER,
 *  before any SelectableAsset exists) — `assetLinkToken` is the row's own link token, the same
 *  field `buildSelectableAssets` copies onto the asset. */
export function currencyOfCatalogRow(row: CurrencyDescriptor): HomeCurrency | null {
  return currencyOfLinkToken(assetLinkToken(row));
}

/** Parse a persisted value. Anything unrecognised — including a currency written by a future build
 *  — is `null`, which means "not chosen yet" and re-opens the chooser rather than guessing. There
 *  is deliberately no default: picking francs for someone who never said so is a worse failure than
 *  asking again. */
export function parseHomeCurrency(v: string | null | undefined): HomeCurrency | null {
  return (WALLET_CURRENCIES as readonly string[]).includes(v as string) ? (v as HomeCurrency) : null;
}

/** The currency's own name, in the user's language ("Swiss francs" / "Bitcoin" / …). */
export function currencyName(currency: HomeCurrency): string {
  return M.wallet.homeCurrency.name[currency];
}

/**
 * One rail's compact line — LEDGER TOKEN · SETTLEMENT CHAIN ("ckUSDC · Internet Computer",
 * "USDC · Solana"). Both halves are deliberate honesty choices, inherited from the chooser's
 * original single-rail subtitle:
 *   • the token is `linkToken` (ckUSDC), never `symbol` (USDC) — the display glyph is the backing
 *     currency, and telling a user they hold "USDC" hides which USDC it is;
 *   • the chain is where the transfer EXECUTES (`linkNetworkOf`), never `network`, which on a
 *     chain-key row names the chain the asset is backed BY. ckUSDC's `network` is "Ethereum" while
 *     it settles on the Internet Computer, so using it produced the flatly wrong "Held as USDC on
 *     Ethereum" — a user could reasonably send Ethereum USDC somewhere on the strength of it.
 */
export function railLineLabel(rail: SelectableAsset): string {
  return M.wallet.asset.networkLabel(rail.linkToken ?? rail.symbol, prettyNetwork(linkNetworkOf(rail)));
}

/**
 * Every rail of `currency`'s group on one subtitle line ("ckUSDC · Internet Computer, USDC ·
 * Solana"), or null when the catalog carries no rail for it. The whole-group counterpart of
 * `railLineLabel`: surfaces that summarise (Settings) name the group; surfaces that ask the user
 * to choose (the chooser) print one `railLineLabel` per rail instead.
 */
export function railsLabel(currency: HomeCurrency, assets: SelectableAsset[]): string | null {
  const rails = currencyRails(currency, assets);
  return rails.length === 0 ? null : rails.map(railLineLabel).join(', ');
}

/**
 * What a rail charges, as FACTS in the rail's own units — the inputs to a cost decision, never
 * the decision: comparing fees across tokens would be an FX quote (module boundary above).
 *
 *   IC rails: the ICRC transfer fee from the catalog row, formatted with the asset's own
 *   decimals and token (a null/absent fee is reported as null — "unknown", never "free").
 *   SOL rails: the per-transaction signature fee, always in SOL even on the USDC rail (Solana
 *   charges fees in SOL, not in the token being moved), plus the ONE-TIME associated-token-account
 *   rent where relevant — a USDC rail needs an ATA the first time it is used; a native-SOL rail
 *   is its own account and needs none.
 */
export type RailFeeFact = {raw: string; formatted: string};
export type RailFees = {perTransfer: RailFeeFact | null; oneTime: RailFeeFact | null};

export function railFees(rail: SelectableAsset, catalog: readonly CurrencyDescriptor[]): RailFees {
  if (rail.protocol === 'solana') {
    const signature = SOL_FEE_LAMPORTS.toString();
    const fee: RailFees = {
      perTransfer: {raw: signature, formatted: fmtAssetCompact(signature, SOL_DECIMALS, SOL_UNIT)},
      oneTime: null,
    };
    if (rail.token !== 'SOL') {
      // ANY SPL token rail (USDC, EURC, …) needs its associated token account the first time it is
      // used — the rent is a property of holding the token, not of USDC specifically. Native SOL is
      // its own account and needs none.
      const rent = SOL_ATA_RENT_LAMPORTS.toString();
      fee.oneTime = {raw: rent, formatted: fmtAssetCompact(rent, SOL_DECIMALS, SOL_UNIT)};
    }
    return fee;
  }
  const fee = catalog.find(c => c.currency === rail.currency)?.fee;
  const perTransfer = fee != null && /^\d+$/.test(fee)
    ? {raw: fee, formatted: fmtAssetCompact(fee, rail.decimals, rail.linkToken ?? rail.symbol)}
    : null;
  return {perTransfer, oneTime: null};
}

/**
 * One ACCOUNTS-ROUTE section: the ordered account list partitioned by the currency each account
 * settles, so the route reads as currencies first and loose assets after. `currency: null` is the
 * non-currency tail (DEMO — practice money; every real asset settles a wallet currency now).
 */
export type CurrencyAccountGroup = {currency: HomeCurrency | null; assets: SelectableAsset[]};

/**
 * Presentation-only grouping OVER the `orderAccounts` output — the order inside every section is
 * exactly the order handed in, and the sections themselves are fixed: the MAIN currency's rails
 * first, then every other offered currency's rails in WALLET_CURRENCIES order (stables, then the
 * token currencies), then the non-currency tail. No section is emitted for a currency the list
 * carries no rail for.
 *
 * It exists because a flat list answers "how much is in each account" while the wallet's own
 * question is "what am I in": the section header NAMES the currency, which is what lets a USD
 * wallet read its two dollar rails as one group. What it deliberately does NOT do is sum a
 * section or reorder anything by magnitude — the rows keep their own units and the no-FX-quote
 * rule untouched. (The SUMMED per-currency balance is a separate, fork-#4 display layer —
 * lib/assetBalances.ts `buildCurrencyBalances`.)
 */
export function groupAccountsByCurrency(
  ordered: SelectableAsset[],
  homeCurrency: HomeCurrency,
): CurrencyAccountGroup[] {
  const buckets = new Map<HomeCurrency | 'other', SelectableAsset[]>();
  for (const a of ordered) {
    const key = currencyOfAsset(a) ?? 'other';
    const bucket = buckets.get(key);
    if (bucket == null) buckets.set(key, [a]);
    else bucket.push(a);
  }
  const sections: CurrencyAccountGroup[] = [];
  const home = buckets.get(homeCurrency);
  if (home != null) sections.push({currency: homeCurrency, assets: home});
  for (const c of WALLET_CURRENCIES) {
    if (c === homeCurrency) continue;
    const bucket = buckets.get(c);
    if (bucket != null) sections.push({currency: c, assets: bucket});
  }
  const other = buckets.get('other');
  if (other != null) sections.push({currency: null, assets: other});
  return sections;
}

/**
 * The rail's catalogued liquidity tier — a FACT carried by the catalog row ('deep' | 'thin'), or
 * null when the row says nothing (SOL, native assets, unknown). The tier feeds the rail-health
 * lines (`railLiquidityLine`) and nothing else: it is never a verdict and never a comparison.
 */
export function railLiquidity(asset: SelectableAsset): 'deep' | 'thin' | null {
  return asset.liquidity;
}

/**
 * The rail-health statement for `asset`, or null when the catalog makes none. Thin and deep are
 * the only two statements — there is deliberately no key for a tier the catalog cannot name. The
 * note renders ON the rail it describes, so it never names the token: 2–3 words, per the founder
 * (2026-09-19) — the essay the thin line used to carry is gone.
 */
export function railLiquidityLine(asset: SelectableAsset): string | null {
  const tier = railLiquidity(asset);
  if (tier === 'thin') return M.wallet.railHealth.thin;
  if (tier === 'deep') return M.wallet.railHealth.deep;
  return null;
}

/**
 * The rail's ramp capability as ONE statement derivable from the catalog row, or null when no
 * honest line exists. Exactly four derivations, no speculative keys:
 *   Direct + Direct            → deposit and cash-out are wired in dpay (the ck* family shape)
 *   Unavailable + Partner(p)   → p lists this token as sellable; buying is not available today
 *   Unavailable + Unavailable  → no fiat ramp today; it moves wallet to wallet
 *   anything else             → null (a Partner onramp, a Direct mixed with a non-Direct — the day
 *                               one of those ships, its key ships with it). A Partner offramp with
 *                               no named partner is also null: the line names DFX because the
 *                               catalog does, never a guess.
 */
export function railRampLine(rail: SelectableAsset): string | null {
  if (rail.onramp === 'Direct' && rail.offramp === 'Direct') return M.wallet.railDetail.rampBothDirect;
  if (rail.onramp === 'Unavailable' && rail.offramp === 'Partner') {
    return rail.rampPartner != null ? M.wallet.railDetail.rampSellPartner(rail.rampPartner) : null;
  }
  if (rail.onramp === 'Unavailable' && rail.offramp === 'Unavailable') return M.wallet.railDetail.rampNone;
  return null;
}

/**
 * The per-asset balance map the wallet already renders from (`buildAssetBalances`) — keyed by
 * stable AssetId. May be absent entirely (first chooser render before any poll).
 */
export type RailBalances = Readonly<Partial<Record<AssetId, BalanceView>>>;

/**
 * PRACTICE MONEY — the DEMO rail (`ic:0`). It spends through exactly the same surfaces as a real
 * asset inside dpay and is worth nothing outside it, which is why every screen that OFFERS it has
 * to say both halves. Kept here rather than inferred at each call site because the answer decides
 * what a user is told about money.
 */
export function isPracticeAsset(asset: SelectableAsset): boolean {
  return asset.protocol === 'ic' && asset.currency === 0;
}

/**
 * What kind of account the user was pointed at, which decides what the pointer is allowed to
 * promise:
 *   'sibling'  — a rail of the SAME home currency. The same unit and the same money, so the
 *                payment the user was about to make still works after the switch.
 *   'other'    — a funded account outside that group. Real, spendable money in a DIFFERENT
 *                currency: the switch changes what the tab acts on, and nothing is converted.
 *   'practice' — the DEMO balance. Never presented as a way to pay a real merchant.
 */
export type FundedAlternativeKind = 'sibling' | 'other' | 'practice';
export type FundedAlternative = {asset: SelectableAsset; held: BalanceView; kind: FundedAlternativeKind};

/**
 * "This account is empty — which account of yours is not?"
 *
 * The measured defect this answers (X1, `OPEN_ISSUES.md` "UX swarm 2026-09-08"): on a new wallet
 * every fund-blocked surface asked for a deposit to a 63-character principal while ∂100 of
 * spendable practice money sat one tap away and was never named. Naming it is not a copy tweak —
 * it is the difference between a screen that only asks and a screen that offers.
 *
 * Ranked, first match wins, and the ranking IS the honesty:
 *   1. a funded rail of the home currency's group (only when the SELECTED asset is itself in that
 *      group — otherwise "same currency" means nothing here), in stated preference order;
 *   2. any other funded REAL account, in asset-list order;
 *   3. the practice balance, and only when `purpose` is 'pay' — practice money has no route off
 *      the wallet, so offering it on a send surface would be a dead end wearing an offer's clothes.
 *
 * "Funded" is `status: 'ok'` — the ONE definition the whole app renders by. Unknown is not funded:
 * a loading, errored, absent or zero account is skipped, so the wallet never points at money it
 * cannot see. Never returns the selected account itself.
 */
export function fundedAlternative(args: {
  homeCurrency: HomeCurrency | null;
  assets: SelectableAsset[];
  balances: RailBalances;
  selectedAssetId: AssetId | null;
  purpose: 'pay' | 'send';
}): FundedAlternative | null {
  const {homeCurrency, assets, balances, selectedAssetId, purpose} = args;
  if (selectedAssetId == null) return null;
  const funded = (a: SelectableAsset): boolean => a.id !== selectedAssetId && balances[a.id]?.status === 'ok';
  const answer = (asset: SelectableAsset, kind: FundedAlternativeKind): FundedAlternative =>
    ({asset, held: balances[asset.id]!, kind});

  const selected = assets.find(a => a.id === selectedAssetId) ?? null;
  if (homeCurrency != null && selected != null && currencyOfAsset(selected) === homeCurrency) {
    const sibling = currencyRails(homeCurrency, assets).find(funded);
    if (sibling != null) return answer(sibling, 'sibling');
  }
  const other = assets.find(a => funded(a) && !isPracticeAsset(a));
  if (other != null) return answer(other, 'other');
  if (purpose === 'pay') {
    const practice = assets.find(a => funded(a) && isPracticeAsset(a));
    if (practice != null) return answer(practice, 'practice');
  }
  return null;
}

/** Why chooseRail returned the rail it did — the reason is part of the answer, not a log line. */
export type RailReason = 'destination' | 'funded' | 'preference';
export type RailChoice = {rail: SelectableAsset; reason: RailReason};

/**
 * Which rail of `currency`'s group to use, and why. The policy is exactly three steps, first
 * match wins:
 *
 *   1. DESTINATION — a request that names an asset pins the answer. The request's own rail is
 *      returned if (and only if) it belongs to this currency's group; a destination naming some
 *      other asset returns null, because this currency has nothing honest to say about that
 *      request. A merchant's settlement asset is never second-guessed, never "improved" onto a
 *      cheaper rail (CLAUDE.md boundary).
 *   2. FUNDED — the first rail in stated-preference order whose balance is a known non-zero
 *      (`status: 'ok'` — the ONE definition the whole app already renders by). Unknown is not
 *      funded: a loading, errored, absent or zero rail is skipped, so the wallet never "chooses"
 *      a rail it cannot see money on.
 *   3. PREFERENCE — CURRENCY_RAILS order: the stated product default (ckUSDC's offline tap is
 *      hardware-proven). This is also exactly `preferredRail`, which stays the one-line form of
 *      "no balances, no request — just the default".
 *
 * Null when the catalog carries no rail for the currency at all.
 */
export function chooseRail(
  currency: HomeCurrency,
  assets: SelectableAsset[],
  balances?: RailBalances | null,
  destination?: SelectableAsset | null,
): RailChoice | null {
  const rails = currencyRails(currency, assets);
  if (rails.length === 0) return null;
  if (destination != null) {
    const pinned = rails.find(r => r.id === destination.id);
    return pinned == null ? null : {rail: pinned, reason: 'destination'};
  }
  if (balances != null) {
    const funded = rails.find(r => balances[r.id]?.status === 'ok');
    if (funded != null) return {rail: funded, reason: 'funded'};
  }
  return {rail: rails[0], reason: 'preference'};
}
