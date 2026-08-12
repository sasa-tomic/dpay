// Phase 1 relocation (2026-08-12 unified asset selection rewrite) — moved verbatim out of
// `components/CurrencyRow.tsx` so that file is purely presentational. Domain construction (the
// unified currency-row list builder + its curated subtitle/name/key helpers) does not belong in a
// presentational component: it would otherwise grow entangled with display props and survive a
// Phase-3 component rewrite by accident.
//
// This is a LIFT-AND-SHIFT — behavior byte-identical to the pre-Phase-1 implementation. The pure
// asset domain (`config/assets.ts`) is the long-term home for selection/list logic; this file is
// the UI-row adapter that BRIDGES the catalog → CurrencyRow props, and Phase 3 will fold it into
// the SelectableAsset view model when the selectors are rewritten.

import {
  type CurrencyDescriptor,
  familyDisplay,
  assetTestKey,
  displayName,
  fmtCurrencyAmount,
  isTestnetCurrency,
  testnetDisplayName,
} from '../config/catalog';
import {cmpRaw} from './amount';
import {fmtAsset} from './format';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';

// One unified currency-row item for BOTH selectors (BalancesSheet card variant + ReceiveMode plain
// variant). IC items come from the catalog; a single synthetic SOL item is appended when the device
// key is derived. SOL stays OUT of the catalog (device-key rail — CLAUDE.md non-negotiable).
export type CurrencyListItem =
  | {kind: 'ic'; desc: CurrencyDescriptor; key: string; name: string; subtitle: string;
     amountText: string | null; zero: boolean; active: boolean}
  | {kind: 'sol'; key: 'sol'; name: 'SOL'; subtitle: string;
     amountText: string | null; zero: boolean; active: boolean};

// The curated subtitle for an IC catalog currency. Identical logic in both selectors (Issue 3).
function icSubtitle(catalog: CurrencyDescriptor[], a: CurrencyDescriptor): string {
  const isPrimary = a.currency === 0;
  const testnet = !isPrimary && isTestnetCurrency(a);
  if (isPrimary) return 'play money for testing';
  if (testnet) return a.network ?? 'testnet';
  if (a.minter_family === 'CkBtcUtxo') return 'Bitcoin';
  if (a.minter_family === 'CkEthErc20' && (a.backing_symbol === 'USDC' || a.backing_symbol === 'USDT')) return 'US dollar stablecoin';
  return familyDisplay(catalog, a.currency)?.networkLabel ?? 'Unsupported asset';
}

// The display name for an IC catalog currency (DEMO / testnet-display / backing-symbol).
function icName(a: CurrencyDescriptor): string {
  const isPrimary = a.currency === 0;
  const testnet = !isPrimary && isTestnetCurrency(a);
  return isPrimary ? 'DEMO' : (testnet ? testnetDisplayName(a) : displayName(a));
}

// The stable ASCII testID key for an IC catalog currency.
function icKey(a: CurrencyDescriptor): string {
  return a.currency === 0 ? 'demo' : assetTestKey(a);
}

// The unified currency list builder. Produces ONE ordered list of rows for BOTH selectors. IC items
// first (catalog order, filtered by testnet visibility); SOL appended when the device key exists.
export function buildCurrencyList(args: {
  catalog: CurrencyDescriptor[];
  assetBalances: Record<number, string>;
  primaryBalance: string | null;
  online: boolean;
  showTestnet: boolean;
  currentCurrency: number;
  activeSol: boolean;
  solAddress: string | null;
  solBalance: string | null;
}): CurrencyListItem[] {
  const {catalog, assetBalances, primaryBalance, online, showTestnet, currentCurrency, activeSol, solAddress, solBalance} = args;
  const visibleCatalog = showTestnet ? catalog : catalog.filter(a => !isTestnetCurrency(a));
  const items: CurrencyListItem[] = visibleCatalog.map(a => {
    const isPrimary = a.currency === 0;
    const assetBal = assetBalances[a.currency] ?? '0';
    const funded = !isPrimary && cmpRaw(assetBal, '0') > 0;
    const balanceText = isPrimary
      ? (primaryBalance == null ? '—' : `${online ? '' : '~'}${fmtCurrencyAmount(catalog, a.currency, primaryBalance)}`)
      : fmtCurrencyAmount(catalog, a.currency, assetBal);
    return {
      kind: 'ic' as const,
      desc: a,
      key: icKey(a),
      name: icName(a),
      subtitle: icSubtitle(catalog, a),
      amountText: balanceText,
      zero: !isPrimary && !funded,
      active: a.currency === currentCurrency,
    };
  });
  if (solAddress) {
    items.push({
      kind: 'sol' as const,
      key: 'sol',
      name: 'SOL',
      subtitle: 'Solana · self-custody',
      amountText: solBalance == null ? '—' : fmtAsset(solBalance, SOL_DECIMALS, SOL_UNIT),
      zero: solBalance == null || cmpRaw(solBalance, '0') === 0,
      active: activeSol,
    });
  }
  return items;
}
