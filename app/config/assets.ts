// Phase 1 — the pure, unified asset domain (2026-08-12 unified asset selection rewrite).
//
// The wallet's selectable-asset layer: a resolved view model (`SelectableAsset`) built from the
// validated IC catalog PLUS the catalog's solana section rows (catalog v2 — display facts from the
// same `NetworkSection[]` the IC rows come from), plus the ONE pure list builder every Wallet
// selector consumes and the deterministic fallback policy for the idle selection.
//
// CRITICAL INVARIANT — SOL never enters the ICRC catalog (CLAUDE.md non-negotiable). SOL is a
// device-key rail: there is no ICRC ledger, no relay round trip for signing, no facade entry, no IC
// wire currency id. Solana rows live in the catalog's SEPARATE `protocol:'solana'` sections (display
// facts only) and are appended after the IC entries here. Forcing SOL into a `CurrencyDescriptor`
// would contaminate every catalog helper (`familyDisplay`, `displayName`, `fmtCurrencyAmount`, the
// NFC disclosure, the request QR codec) — so it is held behind this boundary instead.
//
// This module is PURE: no React, no AsyncStorage, no network. Its outputs are deterministic
// functions of (catalog, options) and the Solana config constants; it is safe to unit-test
// directly and to call on every render.

import {
  type CurrencyDescriptor,
  type NetworkSection,
  type RampCapability,
  type SolanaAsset,
  BUNDLED_NETWORKS,
  assetTestKey,
  displayName,
  familyDisplay,
  isTestnetCurrency,
  solanaAssetsOf,
  testnetDisplayName,
} from './catalog';
import {IS_SOLANA_DEVNET, SOLANA_RPC_URL} from './constants';
import {USDC_MINT_ADDRESS} from '../solana/spl';
import {type AssetId} from '../lib/types';
import {M} from '../i18n';

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
      network: string | null;  // the CHAIN's proper noun ('Bitcoin'/'Ethereum') — wire/constant, never translated; null for DEMO
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
      network: 'Solana';       // the chain's proper noun — never translated
      decimals: number;        // SOL=9, USDC=6
      visible: boolean;        // always true (appended only when the rail is enabled)
      capabilities: AssetCapabilities; // Direct/Direct — device-key rail
      testKey: string;         // stable ASCII testID key ('sol' | 'sol-usdc')
    };

// Options for the list builder. `solanaUsdc` is an explicit override used by tests; production
// callers omit it and the builder resolves USDC availability from the live Solana config (the
// `solanaUsdcAvailable()` helper below — pure over the config constants). `networks` is the
// network-first catalog (catalog v2): when omitted, the bundled sections (`BUNDLED_NETWORKS`)
// supply the Solana display facts, so a cold/offline first load renders the identical rows.
export type BuildSelectableAssetsOptions = {
  showTestnet: boolean;
  solanaEnabled: boolean;
  solanaUsdc?: boolean;
  networks?: NetworkSection[];
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
    // Catalog v2: the SOL/USDC display facts (symbol/decimals/ramps) are CATALOG-DRIVEN — read from
    // the network sections (the parsed relay response, or the bundled fallback when omitted — same
    // one code path, so cold/offline first-load rendering is identical). A missing SOL row simply
    // omits the asset; ids/testKeys stay stable literals so testID derivation never shifts.
    const solana = solanaAssetsOf(opts.networks ?? BUNDLED_NETWORKS);
    const sol = solana.find(a => a.token === 'SOL');
    if (sol) assets.push(solanaAssetRow(sol, 'SOL', 'sol'));
    // Solana USDC is fail-closed when the cluster is misconfigured (empty RPC, or mainnet mint on
    // a non-mainnet RPC — see `solanaUsdcAvailable`). An unfulfillable USDC row would silently
    // point at a non-existent token account; fail closed instead.
    const usdc = opts.solanaUsdc ?? solanaUsdcAvailable();
    const usdcRow = solana.find(a => a.token === 'USDC');
    if (usdc && usdcRow) assets.push(solanaAssetRow(usdcRow, 'USDC', 'sol-usdc'));
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
    ? M.wallet.asset.demoSubtitle
    : M.wallet.asset.networkLabel(name, network ?? 'IC');
  return {
    id: `ic:${desc.currency}` as const,
    protocol: 'ic',
    currency: desc.currency,
    symbol: name,
    networkLabel,
    network,
    decimals: desc.decimals ?? 0,
    visible: true,
    capabilities: {onramp: desc.onramp, offramp: desc.offramp},
    testKey: icTestKey(desc, isPrimary, testnet),
  };
}

// Build the SelectableAsset for one Solana catalog row. The display facts come from the row the
// relay/bundled sections supplied (symbol/decimals/ramps); the id/testKey stay STABLE literals so
// selection + testID derivation never shifts with catalog metadata. USDC's `networkLabel` is
// distinct from any IC USDC so the two never read as the same balance (no-swap / no-confusion
// invariant).
function solanaAssetRow(row: SolanaAsset, token: 'SOL' | 'USDC', testKey: string): SelectableAsset {
  return {
    id: token === 'SOL' ? 'solana:SOL' : 'solana:USDC',
    protocol: 'solana',
    token,
    symbol: row.symbol,
    networkLabel: M.wallet.asset.networkLabel(row.symbol, 'Solana'),
    network: 'Solana',
    decimals: row.decimals,
    visible: true,
    capabilities: {onramp: row.onramp, offramp: row.offramp},
    testKey,
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

// Phase 5 — deeplink routing to the IC engine. A `dpay:req`/`dpay:pay` blob is IC-only: the requested
// currency lives INSIDE the blob (only DpayCore.decodeRequest can read it), so at routing time ANY IC
// selection suffices — PayMode/ReceiveMode decode the blob and review with the EXACT requested asset.
// If a Solana asset is idle-selected when such a blob arrives, SolPayMode/SolReceiveMode would mount
// instead and the blob would be SILENTLY LOST (those engines never consume IC prefills). This returns
// the IC asset id the Wallet must programmatically select so the IC engine mounts. It is a NO-OP when
// an IC asset is already selected (preserve the exact id — do not reset to ic:0, which would churn the
// header). Solana deeplinks (solreq:/solpay:) are a different scheme handled by the SOL engines' own
// QR-scan path and are NOT OS deeplinks; this helper is for IC blobs only.
export function routeDeeplinkToIc(selectedId: AssetId | null, assets: SelectableAsset[]): AssetId | null {
  // Already on an IC asset — the IC engine mounts; nothing to change.
  if (selectedId !== null && selectedId.startsWith('ic:')) return selectedId;
  // Prefer DEMO (always present, the default home asset), else the first IC asset in catalog order.
  const demo = assets.find(a => a.id === 'ic:0');
  if (demo) return demo.id;
  const firstIc = assets.find(a => a.protocol === 'ic');
  return firstIc ? firstIc.id : null;
}

// Phase 5 — the selection-lock gate for USER-initiated asset selection. While an in-flight pay/receive
// op holds the lock (Wallet.selectionLocked), a user gesture that would switch the idle asset is
// suppressed: switching unmounts the active engine and destroys the captured request snapshot (the
// review the user is mid-flow on). It also arms the wrong protocol's NFC reader (invariant #11). The
// lock is released when the user cancels/resets the op (the engine reports onLockChange(false)).
//
// PROGRAMMATIC selection (deeplink routing → routeDeeplinkToIc) BYPASSES this gate entirely: it calls
// setSelectedAssetId directly, never through handleSelect, because a deeplink is not a user gesture
// and routing the user to the right engine for an incoming request must always win.
export function shouldAllowUserSelect(selectionLocked: boolean): boolean {
  return !selectionLocked;
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

// The active-rail chip + header balance label. Returns the bare asset `symbol` UNLESS another
// visible asset shares the same symbol — the unified-asset-selection rewrite made USDC appear on
// TWO rails (ic:2 = Ethereum, solana:USDC = Solana) with the SAME symbol 'USDC', so the bare chip
// was ambiguous. When a collision exists, the chip qualifies with a SHORT network tag
// (`USDC·Eth` / `USDC·Sol`) so a user reads the network at a glance. No collision (DEMO/BTC/ETH/SOL)
// ⇒ the chip stays compact (YAGNI — qualifying every chip would just add noise).
//
// The short network tag reads the asset's `network` field — the chain's PROPER NOUN, which arrives
// from the descriptor's wire `network` or the FAMILY_DISPLAY constants and is never translated. It
// used to be recovered by splitting `networkLabel` on its ` · ` joiner, but that joiner is produced
// by the catalog (`M.wallet.asset.networkLabel`), so the first locale to punctuate the subtitle
// differently would have silently emptied the tag and collapsed `USDC·Eth`/`USDC·Sol` back into two
// identical chips. Same class of bug as Tab.tsx's label-derived testID: display copy must never be
// re-parsed to recover data. The three known mainnet networks get clean tags; anything else (a
// future/testnet network) falls back to a short prefix so it still disambiguates. Pure: no React,
// no native deps; deterministic in (asset, all).
const SHORT_NETWORK_TAG: Record<string, string> = {
  Ethereum: 'Eth',
  Solana: 'Sol',
  Bitcoin: 'Btc',
};
function shortNetworkTag(asset: SelectableAsset): string {
  const network = asset.network ?? '';
  const mapped = SHORT_NETWORK_TAG[network];
  if (mapped) return mapped;
  // Fallback for an unmapped network: a short prefix (≤3 chars) keeps the chip compact while still
  // distinguishing the colliding assets (e.g. "Bitcoin Testnet" → "Bit", distinct from "Btc").
  return network.length <= 3 ? network : network.slice(0, 3);
}
export function chipLabel(asset: SelectableAsset, all: SelectableAsset[]): string {
  const collision = all.some(a => a.id !== asset.id && a.symbol === asset.symbol);
  if (!collision) return asset.symbol;
  return `${asset.symbol}·${shortNetworkTag(asset)}`;
}

// The Solana Pay-tab gate (2026-08-16 zero-funds UX): when the active asset is KNOWN unfunded, the
// payer should fund the wallet FIRST, not scan a doomed payment. Pure derivation from the
// useSolanaBalances states — the Wallet computes it, SolPayMode renders it.
//   'sol-zero'    — SOL selected, RPC confirmed balance === '0' (a KNOWN zero, not loading/missing)
//   'usdc-absent' — USDC selected, the device's USDC token account (ATA) is KNOWN absent
//   'usdc-zero'   — USDC selected, ATA exists, RPC confirmed amount === '0'
//   'none'        — fundable as-is (OR any UNCONFIRMED state: loading / unavailable / error — the
//                   gate FAILS OPEN to the live scanner per the offline-first rule; error preserves
//                   the last amount by hook contract, so it is never a confident zero).
// The NFC card must NOT arm while gated (a tap is auto-sign consent — a zero balance signs a
// signature the merchant can never settle).
export type SolPayGate = 'none' | 'sol-zero' | 'usdc-absent' | 'usdc-zero';
export function solPayGate(
  selectedToken: 'SOL' | 'USDC',
  sol: {balance: string | null; status: string},
  usdc: {amount: string | null; status: string},
): SolPayGate {
  if (selectedToken === 'SOL') {
    return sol.status === 'ok' && sol.balance === '0' ? 'sol-zero' : 'none';
  }
  if (usdc.status === 'absent') return 'usdc-absent';
  if (usdc.status === 'balance' && usdc.amount != null && usdc.amount === '0') return 'usdc-zero';
  return 'none';
}
