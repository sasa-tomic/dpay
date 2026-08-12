// Phase 1 — the pure, unified asset domain (2026-08-12 unified asset selection rewrite).
//
// The wallet's selectable-asset layer: a resolved view model (`SelectableAsset`) built from the
// validated IC catalog PLUS explicit app-defined Solana assets, plus the ONE pure list builder
// every Wallet selector consumes and the deterministic fallback policy for the idle selection.
//
// CRITICAL INVARIANT — SOL never enters the ICRC catalog (CLAUDE.md non-negotiable). SOL is a
// device-key rail: there is no ICRC ledger, no relay round trip, no facade entry, no IC wire
// currency id. Solana assets live HERE, in the app's asset domain, appended after the IC entries.
// Forcing SOL into a `CurrencyDescriptor` would contaminate every catalog helper (`familyDisplay`,
// `displayName`, `fmtCurrencyAmount`, the NFC disclosure, the request QR codec) — so it is held
// behind this boundary instead.
//
// This module is PURE: no React, no AsyncStorage, no network. Its outputs are deterministic
// functions of (catalog, options) and the Solana config constants; it is safe to unit-test
// directly and to call on every render.

import {
  type CurrencyDescriptor,
  type RampCapability,
  assetTestKey,
  displayName,
  familyDisplay,
  isTestnetCurrency,
  testnetDisplayName,
} from './catalog';
import {IS_SOLANA_DEVNET, SOLANA_RPC_URL} from './constants';
import {USDC_DECIMALS, USDC_MINT_ADDRESS} from '../solana/spl';
import {SOL_DECIMALS} from '../solana/identity';
import {type AssetId} from '../lib/types';

// Per-asset funding / cash-out capability. Mirrors the catalog's `RampCapability` shape so a
// consumer renders IC and Solana rows through the SAME capability logic — no rail special case at
// the UI surface (the capability values differ; the SHAPE is uniform). SOL carries Direct/Direct:
// the device holds the key, so deposit = send SOL/USDC to the device address and withdraw = sign a
// transfer from it (no third-party counterparty, no swap, no relay).
export type AssetCapabilities = {onramp: RampCapability; offramp: RampCapability};

// A resolved, display-ready view of one selectable asset. Built fresh from the current catalog +
// Solana config on every call; React state stores only the STABLE `id`, never a `SelectableAsset`
// (so a catalog object refresh cannot invalidate the selection — the id is derived from the
// currency u32 / token literal alone, not from any descriptor reference).
//
// `protocol: 'ic'` recovers `currency: number`; `protocol: 'solana'` recovers `token: 'SOL'|'USDC'`.
// Consumers narrow on `protocol` to get a typed ref — no `any`, no cast. The discriminated union
// matches the `AssetRef` shape so it composes with future Phase-3/4 selection contracts.
export type SelectableAsset =
  | {
      id: `ic:${number}`;
      protocol: 'ic';
      currency: number;
      symbol: string;          // display NAME (BTC/USDC/DEMO/BTC testnet) — never a raw ledger id
      networkLabel: string;    // subtitle ("<symbol> · <network>" for non-DEMO; "play money…" for DEMO)
      decimals: number;        // smallest-unit decimal count for amount formatting
      visible: boolean;        // true on every entry the builder returns (the builder IS the filter)
      capabilities: AssetCapabilities;
      testKey: string;         // stable ASCII testID key (unique within a built list)
    }
  | {
      id: 'solana:SOL' | 'solana:USDC';
      protocol: 'solana';
      token: 'SOL' | 'USDC';
      symbol: string;          // 'SOL' | 'USDC'
      networkLabel: string;    // 'SOL · Solana' | 'USDC · Solana' — distinct from any IC USDC
      decimals: number;        // SOL=9, USDC=6
      visible: boolean;        // always true (appended only when the rail is enabled)
      capabilities: AssetCapabilities; // Direct/Direct — device-key rail
      testKey: string;         // stable ASCII testID key ('sol' | 'sol-usdc')
    };

// Options for the list builder. `solanaUsdc` is an explicit override used by tests; production
// callers omit it and the builder resolves USDC availability from the live Solana config (the
// `solanaUsdcAvailable()` helper below — pure over the config constants).
export type BuildSelectableAssetsOptions = {
  showTestnet: boolean;
  solanaEnabled: boolean;
  solanaUsdc?: boolean;
};

// The ONE pure list builder. Returns the complete ordered list of selectable assets for the current
// catalog + Solana config. Order: IC assets (catalog order, deduped by currency id, filtered by
// testnet visibility) THEN `solana:SOL` THEN `solana:USDC`. Duplicate IC currency IDs are rejected
// deterministically (first occurrence wins) so a malformed catalog cannot produce two rows for one
// currency id (a row that would make selection ambiguous).
//
// Every entry in the returned list has `visible: true` — the builder IS the visibility filter
// (testnet currencies are omitted, not flagged). Hiding a selected testnet asset therefore
// manifests to `reconcileSelectedAsset` as "disappears from the list", which triggers the fallback.
export function buildSelectableAssets(
  catalog: CurrencyDescriptor[],
  opts: BuildSelectableAssetsOptions,
): SelectableAsset[] {
  const {showTestnet, solanaEnabled} = opts;
  const assets: SelectableAsset[] = [];
  const seenCurrencyIds = new Set<number>();
  for (const desc of catalog) {
    // Dedupe by IC currency id, keeping the FIRST occurrence (catalog order). A duplicate would
    // produce two rows for one logical asset — ambiguous selection + a duplicate testID.
    if (seenCurrencyIds.has(desc.currency)) continue;
    // Testnet visibility filter: hide testnet currencies unless opted in app-wide. Mirrors the
    // former BalancesSheet filter (now centralized here so every selector gets identical filtering).
    if (!showTestnet && isTestnetCurrency(desc)) continue;
    seenCurrencyIds.add(desc.currency);
    assets.push(icAsset(desc));
  }
  if (solanaEnabled) {
    assets.push(solanaSolAsset());
    // Solana USDC is fail-closed when the cluster is misconfigured (empty RPC, or mainnet mint on
    // a non-mainnet RPC — see `solanaUsdcAvailable`). An unfulfillable USDC row would silently
    // point at a non-existent token account; fail closed instead.
    const usdc = opts.solanaUsdc ?? solanaUsdcAvailable();
    if (usdc) assets.push(solanaUsdcAsset());
  }
  return assets;
}

// Build the SelectableAsset view model for one IC catalog descriptor. Pure; called per visible
// descriptor. The `id` is `ic:${currency}` — derived from the currency u32 ALONE, so a refreshed
// descriptor object (same currency id, different metadata/reference) yields the SAME id.
function icAsset(desc: CurrencyDescriptor): SelectableAsset {
  const isPrimary = desc.currency === 0;
  const testnet = !isPrimary && isTestnetCurrency(desc);
  const name = isPrimary ? 'DEMO' : (testnet ? testnetDisplayName(desc) : displayName(desc));
  const network = isPrimary
    ? null
    : (desc.network ?? familyDisplay([desc], desc.currency)?.networkLabel ?? null);
  const networkLabel = isPrimary
    ? 'play money for testing'
    : `${name} · ${network ?? 'IC'}`;
  return {
    id: `ic:${desc.currency}` as const,
    protocol: 'ic',
    currency: desc.currency,
    symbol: name,
    networkLabel,
    decimals: desc.decimals ?? 0,
    visible: true,
    capabilities: {onramp: desc.onramp, offramp: desc.offramp},
    testKey: icTestKey(desc, isPrimary, testnet),
  };
}

// Build the SelectableAsset for native SOL.
function solanaSolAsset(): SelectableAsset {
  return {
    id: 'solana:SOL',
    protocol: 'solana',
    token: 'SOL',
    symbol: 'SOL',
    networkLabel: 'SOL · Solana',
    decimals: SOL_DECIMALS,
    visible: true,
    capabilities: {onramp: 'Direct', offramp: 'Direct'},
    testKey: 'sol',
  };
}

// Build the SelectableAsset for Solana USDC. Distinct `networkLabel` from any IC USDC so the two
// never read as the same balance (no-swap / no-confusion invariant).
function solanaUsdcAsset(): SelectableAsset {
  return {
    id: 'solana:USDC',
    protocol: 'solana',
    token: 'USDC',
    symbol: 'USDC',
    networkLabel: 'USDC · Solana',
    decimals: USDC_DECIMALS,
    visible: true,
    capabilities: {onramp: 'Direct', offramp: 'Direct'},
    testKey: 'sol-usdc',
  };
}

// The stable ASCII testID key for an IC asset. DEMO special-cases to 'demo' (its descriptor has no
// wrapper name + a non-ASCII symbol '$', so the generic `assetTestKey` would return '$'); other
// currencies delegate to the catalog's `assetTestKey` (which already appends a `-testnet` suffix
// for testnet siblings so two rows sharing a backing symbol get distinct testIDs). SOL ids are
// plain literals ('sol' / 'sol-usdc').
function icTestKey(desc: CurrencyDescriptor, isPrimary: boolean, _testnet: boolean): string {
  if (isPrimary) return 'demo';
  return assetTestKey(desc);
}

// The deterministic idle-selection fallback policy. Called by the Wallet on every catalog/visibility
// change with the CURRENT selected id (if any) and the FRESH list of visible assets:
//   1. Preserve the selected id while it remains present in the visible list.
//   2. If it is gone (removed, hidden, or never existed) prefer `ic:0` (DEMO — always present in a
//      healthy catalog) so the wallet lands on a non-destructive default.
//   3. If `ic:0` is absent, select the first visible asset.
//   4. If no asset is visible, return null (the caller renders a fail-closed unavailable state).
//
// Hiding a selected testnet asset is the canonical case: the rebuilt list no longer contains its
// id, so step 1 fails and step 2/3 picks a deterministic fallback — the stale testnet selection
// cannot leak into the new view.
export function reconcileSelectedAsset(selectedId: AssetId | null, assets: SelectableAsset[]): AssetId | null {
  if (selectedId !== null && assets.some(a => a.id === selectedId)) return selectedId;
  const demo = assets.find(a => a.id === 'ic:0');
  if (demo) return demo.id;
  return assets.length > 0 ? assets[0].id : null;
}

// Whether Solana USDC is selectable on the CURRENTLY configured cluster. Pure over the constants;
// no network. The two fail-closed cases:
//   - empty RPC URL (`SOLANA_RPC_URL=''` — the offline inner loop / jest / a build with SOL
//     disabled): no cluster at all ⇒ USDC unavailable.
//   - mainnet mint on a NON-mainnet RPC: the only configured USDC mint is the mainnet mint
//     (`USDC_MINT_ADDRESS`); pointing it at devnet/testnet would silently address a non-existent
//     account. Fail closed rather than ship an unfulfillable USDC row.
//
// The pure predicate is split out (`solanaUsdcCoherent`) so the policy is unit-testable without
// module-registry gymnastics; the public no-arg helper reads the config and delegates.
export function solanaUsdcCoherent(rpcUrl: string, isDevnet: boolean, mint: string): boolean {
  if (!rpcUrl) return false;       // SOL disabled / offline inner loop
  if (!mint) return false;         // no configured mint for this cluster
  if (isDevnet) return false;      // mainnet mint on a devnet RPC ⇒ fail closed
  return true;
}

export function solanaUsdcAvailable(): boolean {
  return solanaUsdcCoherent(SOLANA_RPC_URL, IS_SOLANA_DEVNET, USDC_MINT_ADDRESS);
}
