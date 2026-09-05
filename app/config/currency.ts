// The HOME CURRENCY — the one currency the wallet is "in" (founder direction, 2026-09-04).
//
// A currency is NOT an asset. It is a set of rails that all settle the same unit: CHF is VCHF on
// the Internet Computer and (when it lands) VCHF on Solana; USD is ckUSDC on the IC and USDC on
// Solana. The user picks a currency; this module resolves it to the concrete assets the CURRENT
// catalog can actually realise, in preference order. Full direction + the boundary that keeps
// rail-selection out of swap territory: docs/specs/2026-09-04-currency-first-wallet-plan.md.
//
// Two rules this module exists to enforce, both of them honesty rules:
//
//   1. A currency is only OFFERED if the catalog carries a rail for it. EUR resolves to EURC,
//      which is not in the catalog yet, so EUR is not in the chooser yet — and it will appear on
//      its own the day an EURC row ships, with no code change here. Shipping a currency the user
//      can select and then cannot hold would be exactly the dead end the founder's 2026-08-29 rule
//      forbids.
//   2. The currency is the LABEL; the token is the UNIT. A CHF balance is displayed as
//      `12.40 VCHF`, never `CHF 12.40` — VCHF is a third party's franc-denominated token whose peg
//      is the issuer's claim, not something dpay verifies (docs/VCHF_ICP_ANALYSIS.md is the
//      authority: "the payment unit must remain VCHF"). Naming the currency in the label and the
//      token in the amount is how the wallet can be "in francs" without asserting a peg.
//
// PURE: no React, no AsyncStorage, no network. Deterministic in (currency, assets).
import {type SelectableAsset, linkNetworkOf, prettyNetwork, tokenEq} from './assets';
import {M} from '../i18n';

/** The currencies dpay can be "in". Ordered as the chooser presents them. */
export const HOME_CURRENCIES = ['CHF', 'USD', 'EUR'] as const;
export type HomeCurrency = (typeof HOME_CURRENCIES)[number];

// Which ledger tokens realise each currency, in PREFERENCE ORDER — the first one present in the
// catalog is the rail the wallet lands on. Order is a product decision, not an accident:
//   USD prefers ckUSDC because the Internet Computer rail is the one whose offline tap is proven
//   on physical hardware; the Solana USDC row is the same dollar on a second rail.
// Matching is by the asset's `linkToken` through `tokenEq` — the ONE definition of asset-token
// identity in the app (app/config/assets.ts). A second definition here would be a second way to
// resolve a currency to the wrong asset.
const CURRENCY_RAILS: Record<HomeCurrency, readonly string[]> = {
  CHF: ['VCHF'],
  USD: ['ckUSDC', 'USDC'],
  EUR: ['EURC'],
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
  return HOME_CURRENCIES.filter(c => preferredRail(c, assets) !== null);
}

/** Which currency does this asset settle, if any? The inverse of `currencyRails`, used to mark the
 *  main-currency rows in the accounts list. Null for assets outside the home-currency model
 *  (DEMO, ckBTC, ckETH, ICP, SOL) — those are held and spent, they are just not what the wallet is
 *  "in". */
export function currencyOfAsset(asset: SelectableAsset): HomeCurrency | null {
  for (const currency of HOME_CURRENCIES) {
    if (CURRENCY_RAILS[currency].some(token => tokenEq(asset.linkToken, token))) return currency;
  }
  return null;
}

/** Parse a persisted value. Anything unrecognised — including a currency written by a future build
 *  — is `null`, which means "not chosen yet" and re-opens the chooser rather than guessing. There
 *  is deliberately no default: picking francs for someone who never said so is a worse failure than
 *  asking again. */
export function parseHomeCurrency(v: string | null | undefined): HomeCurrency | null {
  return HOME_CURRENCIES.includes(v as HomeCurrency) ? (v as HomeCurrency) : null;
}

/** The currency's own name, in the user's language ("Swiss francs" / "US dollars" / "Euros"). */
export function currencyName(currency: HomeCurrency): string {
  return M.wallet.homeCurrency.name[currency];
}

/**
 * The one-line explanation of what the wallet will actually hold for this currency — the chooser's
 * subtitle, and the founder rule's "say what it is" for this screen.
 *
 * Names the LEDGER TOKEN and the SETTLEMENT CHAIN, and both halves are deliberate:
 *   • the token is `linkToken` (ckUSDC), never `symbol` (USDC) — the display glyph is the backing
 *     currency, and telling a user they hold "USDC" hides which USDC it is;
 *   • the chain is where the transfer EXECUTES (`linkNetworkOf`), never `network`, which on a
 *     chain-key row names the chain the asset is backed BY. ckUSDC's `network` is "Ethereum" while
 *     it settles on the Internet Computer, so using it produced the flatly wrong "Held as USDC on
 *     Ethereum" — a user could reasonably send Ethereum USDC somewhere on the strength of it.
 */
export function currencyRailLabel(currency: HomeCurrency, assets: SelectableAsset[]): string | null {
  const rail = preferredRail(currency, assets);
  return rail === null ? null : railLabel(rail);
}

/** `currencyRailLabel`'s per-rail half, so the chooser can label a rail it already resolved. */
export function railLabel(rail: SelectableAsset): string {
  return M.wallet.homeCurrency.rail(rail.linkToken ?? rail.symbol, prettyNetwork(linkNetworkOf(rail)));
}
