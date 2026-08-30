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
  type SolanaAsset,
  BUNDLED_NETWORKS,
  assetLinkToken,
  assetTestKey,
  displayName,
  familyDisplay,
  isPayableAsset,
  isTestnetCurrency,
  solanaAssetsOf,
  testnetDisplayName,
} from './catalog';
import {IS_SOLANA_DEVNET, SOLANA_RPC_URL} from './constants';
import {USDC_MINT_ADDRESS} from '../solana/spl';
import {parseDecimalToUnits} from '../lib/amount';
import {normaliseNetwork, type PayLink} from '../lib/deepLink';
import {type AssetId} from '../lib/types';
import {M} from '../i18n';

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
      linkToken: string | null; // the payment link's `?asset=` token (ckBTC/VCHF/ICP/DEMO); null ⇒ not linkable
      networkLabel: string;    // subtitle ("<symbol> · <network>" for non-DEMO; "play money…" for DEMO)
      network: string | null;  // the CHAIN's proper noun ('Bitcoin'/'Ethereum') — wire/constant, never translated; null for DEMO
      decimals: number;        // smallest-unit decimal count for amount formatting
      minFractionDigits: number; // compact-display floor (catalog `min_fraction_digits`; 0 when unset)
      visible: boolean;        // true on every entry the builder returns (the builder IS the filter)
      testKey: string;         // stable ASCII testID key (unique within a built list)
    }
  | {
      id: 'solana:SOL' | 'solana:USDC';
      protocol: 'solana';
      token: 'SOL' | 'USDC';
      symbol: string;          // 'SOL' | 'USDC'
      linkToken: string | null; // the payment link's `?asset=` token — the ledger token itself
      networkLabel: string;    // 'SOL · Solana' | 'USDC · Solana' — distinct from any IC USDC
      network: 'Solana';       // the chain's proper noun — never translated
      decimals: number;        // SOL=9, USDC=6
      minFractionDigits: number; // compact-display floor (catalog `min_fraction_digits`; 0 when unset)
      visible: boolean;        // always true (appended only when the rail is enabled)
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
    // Catalog v2: the SOL/USDC display facts (symbol/decimals) are CATALOG-DRIVEN — read from
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
    linkToken: assetLinkToken(desc),
    networkLabel,
    network,
    decimals: desc.decimals ?? 0,
    minFractionDigits: desc.min_fraction_digits ?? 0,
    visible: true,
    testKey: icTestKey(desc, isPrimary, testnet),
  };
}

// Build the SelectableAsset for one Solana catalog row. The display facts come from the row the
// relay/bundled sections supplied (symbol/decimals); the id/testKey stay STABLE literals so
// selection + testID derivation never shifts with catalog metadata. USDC's `networkLabel` is
// distinct from any IC USDC so the two never read as the same balance (no-swap / no-confusion
// invariant).
function solanaAssetRow(row: SolanaAsset, token: 'SOL' | 'USDC', testKey: string): SelectableAsset {
  return {
    id: token === 'SOL' ? 'solana:SOL' : 'solana:USDC',
    protocol: 'solana',
    token,
    symbol: row.symbol,
    // The Solana rail's link token IS its ledger token ('SOL'/'USDC') — the mint is the asset, so
    // the symbol needs no wrapper distinction (and never collides with the IC 'ckUSDC' row).
    linkToken: token,
    networkLabel: M.wallet.asset.networkLabel(row.symbol, 'Solana'),
    network: 'Solana',
    decimals: row.decimals,
    minFractionDigits: row.min_fraction_digits ?? 0,
    visible: true,
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

// Phase 5 — receipt-hand-back routing to the IC engine. A `dpay:pay/<blob>` rail proof is IC-only:
// its currency lives inside the settled transfer, so at routing time ANY IC selection suffices —
// ReceiveMode verifies the proof against the open request. If a Solana asset is idle-selected when
// such a blob arrives, SolReceiveMode would mount instead and the blob would be SILENTLY LOST (that
// engine never consumes IC prefills). This returns the IC asset id the Wallet must programmatically
// select so the IC engine mounts. It is a NO-OP when an IC asset is already selected (preserve the
// exact id — do not reset to ic:0, which would churn the header). A payment LINK needs no such
// helper: it names its own asset, so resolvePayLink yields the exact id to select — on either rail.
export function routeDeeplinkToIc(selectedId: AssetId | null, assets: SelectableAsset[]): AssetId | null {
  // Already on an IC asset — the IC engine mounts; nothing to change.
  if (selectedId !== null && selectedId.startsWith('ic:')) return selectedId;
  // Prefer DEMO (always present, the default home asset), else the first IC asset in catalog order.
  const demo = assets.find(a => a.id === 'ic:0');
  if (demo) return demo.id;
  const firstIc = assets.find(a => a.protocol === 'ic');
  return firstIc ? firstIc.id : null;
}

// --- payment-link resolution: which asset does `?asset=<token>` mean, and how much is `?amount=` ---
// The money-critical half of the payment link (the pure URL grammar lives in lib/deepLink.ts). It
// turns the link's TEXT into a concrete asset + a raw amount, or refuses. It never guesses: dpay
// does not swap, so paying "something close to what the link said" is not an option.
//
// Resolution is an exact, case-insensitive match on the PAIR (link token, settlement chain) over
// the VISIBLE asset list (the list the wallet can actually mount an engine for). The chain is half
// the identity, not a tie-breaker: "USDC" names a different asset on the Internet Computer, on
// Ethereum and on Solana, and paying the wrong chain is unrecoverable. Failure modes are
// distinguished so each gets its own instruction on screen:
//   unknown    — no such token anywhere in the catalog
//   wrong_network — the token exists but not on the chain the link named (e.g. `USDC` +
//                   `internet-computer`, where the IC row is ckUSDC): refuse, never "correct" it
//   ambiguous  — two visible rows share BOTH token and chain (a malformed catalog)
//   hidden     — the token names a testnet row the user has not revealed (actionable: reveal it)
//   unsupported— the row exists but is not payable (isPayableAsset fails closed before signing)
//   amount     — not a number / negative / more precision than the asset has / zero / overflow

/** The resolved link: which asset to pay and the exact raw amount, plus the link it came from. */
export type PayLinkTarget = {asset: SelectableAsset; rawAmount: string; link: PayLink};
/** Why a well-formed payment link cannot be paid on THIS wallet. */
export type PayLinkResolveErr =
  | 'unknown_asset' | 'wrong_network' | 'ambiguous_asset' | 'hidden_asset' | 'unsupported_asset' | 'amount';
export type PayLinkResolution = {ok: true; target: PayLinkTarget} | {ok: false; err: PayLinkResolveErr};

/** The SETTLEMENT chain of an asset, as a payment link spells it: where the transfer actually
 *  executes. Every IC row settles on the Internet Computer — including the chain-key wrappers,
 *  whose catalog `network` names the chain they are BACKED by (ckUSDC: Ethereum) and which must
 *  therefore never be used here. Solana rows settle on Solana. */
export function linkNetworkOf(asset: SelectableAsset): string {
  return asset.protocol === 'ic' ? 'internet-computer' : 'solana';
}

/** A settlement-chain slug as prose for an error message: `internet-computer` → "Internet
 *  Computer". Chain names are proper nouns (never translated — the same rule the asset rows'
 *  `network` field follows), so this is a pure spelling transform, not a lookup table that would
 *  have to be extended for every future chain. */
export function prettyNetwork(slug: string): string {
  return slug
    .split('-')
    .filter(w => w.length > 0)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Case-insensitive token match (ASCII tokens only — see `assetLinkToken`). */
const tokenEq = (a: string | null, b: string) => a != null && a.toLowerCase() === b.toLowerCase();

/** Resolve a parsed payment link against the wallet's visible assets + full catalog. PURE. */
export function resolvePayLink(
  link: PayLink,
  assets: SelectableAsset[],
  catalog: CurrencyDescriptor[],
): PayLinkResolution {
  const network = normaliseNetwork(link.network);
  const byToken = assets.filter(a => tokenEq(a.linkToken, link.asset));
  const matches = byToken.filter(a => linkNetworkOf(a) === network);
  if (matches.length > 1) return {ok: false, err: 'ambiguous_asset'};
  if (matches.length === 0) {
    // The token exists here, but on a different chain than the link named. Refusing is the whole
    // point of carrying the chain: silently paying the same-named asset on the wrong chain sends
    // real money somewhere the sender never asked for.
    if (byToken.length > 0) return {ok: false, err: 'wrong_network'};
    // Not visible at all — is it a testnet row the user simply has not revealed? That is a
    // different (recoverable) situation from an asset this wallet has never heard of.
    const hidden = catalog.find(c => tokenEq(assetLinkToken(c), link.asset));
    return {ok: false, err: hidden && isTestnetCurrency(hidden) ? 'hidden_asset' : 'unknown_asset'};
  }
  const asset = matches[0];
  // Fail closed BEFORE any amount is shown: an IC row that is not payable can never be signed.
  if (asset.protocol === 'ic' && !isPayableAsset(catalog, asset.currency)) {
    return {ok: false, err: 'unsupported_asset'};
  }
  // Exact decimal → raw units at THIS asset's precision. Over-precision/overflow is refused, never
  // rounded: a link that says 0.001 BTC-with-2-decimals is a broken link, not a 0.00 payment.
  const parsed = parseDecimalToUnits(link.amount, asset.decimals);
  if (!parsed.ok || parsed.raw === '0') return {ok: false, err: 'amount'};
  return {ok: true, target: {asset, rawAmount: parsed.raw, link}};
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
