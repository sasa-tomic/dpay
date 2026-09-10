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
  assetLinkToken,
  assetTestKey,
  displayName,
  familyDisplay,
  gasTokenOf,
  isPayableAsset,
  isTestnetCurrency,
  solanaAssetsOf,
  testnetDisplayName,
} from './catalog';
import {isSolanaDevnet, PRACTICE_CURRENCY, solanaRpcUrl} from './constants';
import {parseDecimalToUnits} from '../lib/amount';
import {normaliseNetwork, type PayLink} from '../lib/deepLink';
import {type AssetId} from '../lib/types';
import {solanaTokenOfMint} from '../solana/tokens';
import {M} from '../i18n';

/**
 * The PRACTICE rail's stable asset id — spelled from `PRACTICE_CURRENCY`, the faucet-minted demo
 * dollar, so the rail is one fact in one place (config/constants.ts). Named once so
 * every "is this play money?" decision reads the same constant instead of re-spelling `'ic:0'`:
 * the reconcile/deeplink fallbacks below, and the trip-readiness gate that must NOT count it
 * (`decideFundsReady` — X13: a wallet holding only practice money is not ready for a trip).
 */
export const DEMO_ASSET_ID: AssetId = `ic:${PRACTICE_CURRENCY}`;

// A resolved, display-ready view of one selectable asset. Built fresh from the current catalog +
// Solana config on every call; React state stores only the STABLE `id`, never a `SelectableAsset`
// (so a catalog object refresh cannot invalidate the selection — the id is derived from the
// currency u32 / token literal alone, not from any descriptor reference).
//
// `protocol: 'ic'` recovers `currency: number`; `protocol: 'solana'` recovers `token: string` (a
// registry symbol — 'SOL'/'USDC'/'EURC'). Consumers narrow on `protocol` to get a typed ref — no
// `any`, no cast. The discriminated union matches the `AssetRef` shape so it composes with future
// Phase-3/4 selection contracts.
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
      liquidity: 'deep' | 'thin' | null; // the catalog row's ramp-liquidity fact (null = unknown)
      onramp: RampCapability;  // funding capability fact, verbatim from the catalog row
      offramp: RampCapability; // cash-out capability fact, verbatim from the catalog row
      rampPartner: string | null; // named ramp partner when a capability is 'Partner' (e.g. DFX)
      // The coin that pays the network fee on this asset's WALLET-SIGNED deposit (ckUSDC: 'ETH'),
      // resolved by the catalog from the row's own `gas_ledger`. Null when the asset is its own gas
      // (ckETH) or has no such deposit at all — the funding copy then says "leave a little extra"
      // rather than naming a coin nothing declared.
      gasToken: string | null;
      visible: boolean;        // true on every entry the builder returns (the builder IS the filter)
      testKey: string;         // stable ASCII testID key (unique within a built list)
    }
  | {
      id: `solana:${string}`;
      protocol: 'solana';
      token: string;           // the registry symbol — 'SOL' | 'USDC' | 'EURC' | …
      symbol: string;          // display symbol, verbatim from the catalog row
      linkToken: string | null; // the payment link's `?asset=` token — the ledger token itself
      networkLabel: string;    // 'SOL · Solana' | 'USDC · Solana' | 'EURC · Solana' — distinct from any IC sibling
      network: 'Solana';       // the chain's proper noun — never translated
      mint: string | null;     // the SPL mint pubkey; null ⇒ native SOL (no mint)
      decimals: number;        // SOL=9, USDC=6, EURC=6 — from the catalog row (registry-pinned)
      minFractionDigits: number; // compact-display floor (catalog `min_fraction_digits`; 0 when unset)
      liquidity: 'deep' | 'thin' | null; // the catalog row's ramp-liquidity fact (null = unknown/native)
      onramp: RampCapability;  // funding capability fact, verbatim from the catalog row
      offramp: RampCapability; // cash-out capability fact, verbatim from the catalog row
      rampPartner: string | null; // named ramp partner; null until the solana wire carries one
      visible: boolean;        // always true (appended only when the rail is enabled)
      testKey: string;         // stable ASCII testID key ('sol' | 'sol-usdc' | 'sol-eurc' | …)
    };

// Options for the list builder. `solanaTokens` is an explicit override used by tests to force every
// non-SOL token row available/unavailable regardless of the live config; production callers omit it
// and the builder resolves per-token availability from the live Solana config (the
// `solanaTokenAvailable()` helper below — pure over the config constants). `networks` is the
// network-first catalog (catalog v2): when omitted, the bundled sections (`BUNDLED_NETWORKS`)
// supply the Solana display facts, so a cold/offline first load renders the identical rows.
export type BuildSelectableAssetsOptions = {
  showTestnet: boolean;
  solanaEnabled: boolean;
  solanaTokens?: boolean;
  networks?: NetworkSection[];
};

// The ONE pure list builder. Returns the complete ordered list of selectable assets for the current
// catalog + Solana config. Order: IC assets (catalog order, deduped by currency id, filtered by
// testnet visibility) THEN the solana rows in catalog-section order (`solana:SOL`, `solana:USDC`,
// `solana:EURC`, … — the bundled/live section order). Duplicate IC currency IDs are rejected
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
    // former accounts-list filter (now centralized here so every selector gets identical filtering).
    if (!showTestnet && isTestnetCurrency(desc)) continue;
    seenCurrencyIds.add(desc.currency);
    assets.push(icAsset(desc, catalog));
  }
  if (solanaEnabled) {
    // Catalog v2: the solana display facts (symbol/decimals/mint/liquidity) are CATALOG-DRIVEN —
    // read from the network sections (the parsed relay response, or the bundled fallback when
    // omitted — same one code path, so cold/offline first-load rendering is identical). SOL is the
    // native rail and is always present; every SPL token (USDC/EURC/…) is fail-closed when the
    // cluster is misconfigured (empty RPC, no mint, or a mainnet mint on a non-mainnet RPC — see
    // `solanaTokenCoherent`). An unfulfillable token row would silently point at a non-existent
    // token account; fail closed instead.
    const solana = solanaAssetsOf(opts.networks ?? BUNDLED_NETWORKS);
    for (const row of solana) {
      if (row.token === 'SOL') {
        assets.push(solanaAssetRow(row));
        continue;
      }
      const available = opts.solanaTokens ?? solanaTokenAvailable(row.mint);
      if (available) assets.push(solanaAssetRow(row));
    }
  }
  return assets;
}

/**
 * The SPL mints `buildSelectableAssets` will enumerate as visible token rows for the LIVE config
 * (SOL excluded — it has no mint). This is the SAME predicate the builder's production path uses
 * (`solanaTokenAvailable(row.mint)`; the `solanaTokens` test override is deliberately ignored),
 * so Wallet can feed the per-mint balance hook a mint list whose membership always matches the
 * visible asset list — no drift between "rendered row" and "polled account".
 */
export function visibleSolanaMints(networks?: NetworkSection[]): string[] {
  const mints: string[] = [];
  for (const row of solanaAssetsOf(networks ?? BUNDLED_NETWORKS)) {
    if (row.token === 'SOL') continue;
    if (row.mint != null && solanaTokenAvailable(row.mint)) mints.push(row.mint);
  }
  return mints;
}

// Build the SelectableAsset view model for one IC catalog descriptor. Pure; called per visible
// descriptor. The `id` is `ic:${currency}` — derived from the currency u32 ALONE, so a refreshed
// descriptor object (same currency id, different metadata/reference) yields the SAME id.
function icAsset(desc: CurrencyDescriptor, catalog: CurrencyDescriptor[]): SelectableAsset {
  const isPrimary = desc.currency === 0;
  const testnet = !isPrimary && isTestnetCurrency(desc);
  const name = isPrimary ? 'DEMO' : (testnet ? testnetDisplayName(desc) : displayName(desc));
  const network = isPrimary
    ? null
    : (desc.network ?? familyDisplay([desc], desc.currency)?.networkLabel ?? null);
  // X23 — a chain-key row's subtitle names BOTH of its chains, in the direction they relate.
  //
  // `desc.network` is the chain the asset is BACKED by: ckUSDC's is "Ethereum", ckBTC's is
  // "Bitcoin". Every one of these assets SETTLES on the Internet Computer, and every one of their
  // receive addresses is an Internet Computer principal. Naming ONE of the two is wrong in both
  // directions, and the app has now shipped each mistake:
  //   • "USDC · Ethereum" — what shipped first. A user reads the row as "my USDC on Ethereum",
  //     reads an address off the account, and sends Ethereum USDC to a place that cannot receive
  //     it. Money-loss-shaped, and on a USD-home wallet that row also wears the MAIN badge.
  //   • "USDC · Internet Computer" — the over-correction. Safe about the address, and it hides the
  //     chain the deposit actually runs on, so the row and its own deposit sheet ("Send only USDC
  //     on Ethereum") appear to disagree.
  // The founder's call, 2026-09-09: show both, concisely. The arrow is what makes the pair readable
  // rather than merely present — it reads "bridged from Ethereum, lives here".
  // (Named by concept, not by identifier: `rail-choice-isolation.test.ts` greps this file's SOURCE
  // for the chooser's symbols, and that guard is worth more than the convenience of a symbol here.)
  //
  // The BACKING SYMBOL is kept either way (the founder's display rule: BTC/USDC/ETH, never the ck*
  // wrapper). A row already ON the Internet Computer (VCHF/ICP/VEUR) has one chain and says one.
  const settles = prettyNetwork('internet-computer');
  const networkLabel = isPrimary
    ? M.wallet.asset.demoSubtitle
    : network !== null && network !== settles
      ? M.wallet.asset.bridgedLabel(name, network, settles)
      : M.wallet.asset.networkLabel(name, settles);
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
    liquidity: desc.liquidity,
    onramp: desc.onramp,
    offramp: desc.offramp,
    rampPartner: desc.ramp_partner,
    // Resolved from the row's own `gas_ledger` against the catalog it came from — the fee coin for
    // a wallet-signed ckERC20 deposit, which the funding copy must name before the user starts.
    gasToken: gasTokenOf(desc, catalog),
    visible: true,
    testKey: icTestKey(desc, isPrimary, testnet),
  };
}

// Build the SelectableAsset for one Solana catalog row. Every display fact comes from the row the
// relay/bundled sections supplied (symbol/decimals/mint/liquidity); the id/testKey are DERIVED from
// the row's token alone so selection + testID derivation never shifts with catalog metadata
// (`solana:SOL`→'sol', `solana:<TOKEN>`→`sol-<token-lowercased>` — byte-stable for the existing
// SOL/USDC rows, extensible for EURC and beyond). A non-SOL row's `networkLabel` is distinct from
// any IC sibling symbol so the two never read as the same balance (no-swap / no-confusion
// invariant).
function solanaAssetRow(row: SolanaAsset): SelectableAsset {
  const testKey = row.token === 'SOL' ? 'sol' : `sol-${row.token.toLowerCase()}`;
  return {
    id: `solana:${row.token}`,
    protocol: 'solana',
    token: row.token,
    symbol: row.symbol,
    // The Solana rail's link token IS its ledger token ('SOL'/'USDC'/'EURC') — the mint is the
    // asset, so the symbol needs no wrapper distinction (and never collides with the IC 'ckUSDC'
    // row).
    linkToken: row.token,
    networkLabel: M.wallet.asset.networkLabel(row.symbol, 'Solana'),
    network: 'Solana',
    mint: row.mint,
    decimals: row.decimals,
    minFractionDigits: row.min_fraction_digits ?? 0,
    liquidity: row.liquidity,
    onramp: row.onramp,
    offramp: row.offramp,
    // The solana wire carries no ramp partner today — the only Partner row in the catalog is VEUR
    // on the IC. The field exists on BOTH arms so `railRampLine` treats every rail uniformly; the
    // day a solana partner ships, SolanaAsset gains the field and this maps it.
    rampPartner: null,
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

/**
 * Parse a PERSISTED asset id back into an `AssetId`, or null.
 *
 * Shape-checked only — that a well-formed id is still in the catalog is `reconcileSelectedAsset`'s
 * job, and it already handles a vanished selection. Anything else (absent, empty, a currency id
 * from a build with a different catalog, a hand-edited value) is null, which means "nothing
 * remembered" and lets the home currency seed the selection instead of crashing or, worse, letting
 * a malformed id flow into the engine dispatch.
 */
export function parseAssetId(v: string | null | undefined): AssetId | null {
  if (typeof v !== 'string') return null;
  if (v === 'solana:SOL' || v === 'solana:USDC') return v;
  // `solana:<TOKEN>` — an uppercase registry symbol ([A-Z0-9]{2,10}: SOL/USDC/EURC/…). Shape-checked
  // only; whether the token is selectable TODAY is `reconcileSelectedAsset`'s job (a vanished
  // selection falls back like any other stale id).
  const s = /^solana:([A-Z0-9]{2,10})$/.exec(v);
  if (s) return v as AssetId;
  const m = /^ic:(\d+)$/.exec(v);
  return m ? (`ic:${Number(m[1])}` as AssetId) : null;
}

// The deterministic idle-selection policy. Called by the Wallet on every catalog/visibility change
// with the CURRENT selected id (if any), the FRESH list of visible assets, and the HOME CURRENCY's
// rail (`preferredId` — app/config/currency.ts; null when no currency has been chosen yet):
//   1. Preserve the selected id while it remains present in the visible list.
//   2. Otherwise land on `preferredId` — the rail of the currency the user said they think in.
//      Since the selection is session state and starts null, this is what makes the wallet OPEN in
//      the user's own currency on every launch, which is the whole point of a home currency.
//   3. If there is no home currency, or its rail is not visible, prefer `ic:0` (DEMO — always
//      present in a healthy catalog) so the wallet still lands somewhere non-destructive.
//   4. If `ic:0` is absent, select the first visible asset.
//   5. If no asset is visible, return null (the caller renders a fail-closed unavailable state).
//
// `preferredId` is REQUIRED rather than defaulted: every caller has to say what the user's currency
// is, or say explicitly that there isn't one. A default would let a new call site silently inherit
// the DEMO-first policy this parameter exists to replace.
//
// Hiding a selected testnet asset is the canonical case for steps 2-4: the rebuilt list no longer
// contains its id, so step 1 fails and the stale testnet selection cannot leak into the new view.
export function reconcileSelectedAsset(
  selectedId: AssetId | null,
  assets: SelectableAsset[],
  preferredId: AssetId | null,
): AssetId | null {
  if (selectedId !== null && assets.some(a => a.id === selectedId)) return selectedId;
  if (preferredId !== null && assets.some(a => a.id === preferredId)) return preferredId;
  const demo = assets.find(a => a.id === DEMO_ASSET_ID);
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
  const demo = assets.find(a => a.id === DEMO_ASSET_ID);
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

/**
 * Does an OUTSIDE party's spelling of a ledger token (`b`) name this wallet asset's `linkToken`
 * (`a`)? The ONE definition of asset-token identity, owned here because this module owns
 * `SelectableAsset.linkToken` and `assetLinkToken` produces it — the rule belongs beside the field
 * it compares. Exported for `lib/opencryptopay.ts`, which matches a merchant provider's asset
 * spelling against the same field: two definitions of "which asset is this" is two ways to pay the
 * wrong one, so there is exactly one (collapsed 2026-09-01).
 *
 * CASE-INSENSITIVE, because a link may be hand-typed and a provider spells `ckBTC`/`VCHF` however
 * it likes — ASCII tokens only, guaranteed by `assetLinkToken`'s own charset gate.
 *
 * NOT trimmed and not otherwise normalised: both sides are whitespace-free by construction
 * (`assetLinkToken` rejects anything outside its token charset; the OCP parser trims the provider's
 * asset before it gets here), so a token arriving with whitespace means something upstream is
 * broken and must fail its own way out, not be quietly repaired into a match. Leniency here would
 * be leniency about WHICH ASSET MOVES.
 *
 * `a === null` means the asset is not linkable at all, so nothing names it. `undefined` is not in
 * the contract and gets no branch of its own: the two collapsed versions differed exactly there
 * (this one tested `!= null`, the OCP one `!== null`), and a defensive `!= null` would silently
 * absorb a malformed asset row as "no match" — a fallback for a state the types forbid.
 */
export const tokenEq = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

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

// Whether a Solana SPL token is selectable on the CURRENTLY configured cluster. Pure over the
// constants; no network. The three fail-closed cases:
//   - empty RPC URL (`solanaRpcUrl() === ''` — the offline inner loop / jest / a build with SOL
//     disabled): no cluster at all ⇒ the token is unavailable.
//   - no mint: an SPL token row with `mint: null` (other than SOL, which never reaches this check)
//     names no on-chain account ⇒ unavailable.
//   - mainnet mint on a NON-mainnet RPC: the configured mints are mainnet mints; pointing them at
//     devnet/testnet would silently address a non-existent account. Fail closed rather than ship
//     an unfulfillable token row.
//
// The pure predicate is split out (`solanaTokenCoherent`) so the policy is unit-testable without
// module-registry gymnastics; the public helper reads the config and delegates.
export function solanaTokenCoherent(rpcUrl: string, isDevnet: boolean, mint: string | null): boolean {
  if (!rpcUrl) return false;       // SOL disabled / offline inner loop
  if (!mint) return false;         // no configured mint for this cluster
  if (isDevnet) return false;      // mainnet mint on a devnet RPC ⇒ fail closed
  return true;
}

export function solanaTokenAvailable(mint: string | null): boolean {
  return solanaTokenCoherent(solanaRpcUrl(), isSolanaDevnet(), mint);
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

// The Solana Pay-tab gate (2026-08-16 zero-funds UX, generalized per-token 2026-09-06): when the
// active asset is KNOWN unfunded, the payer should fund the wallet FIRST, not scan a doomed
// payment. Pure derivation from the useSolanaBalances states — the Wallet computes it for the
// SELECTED token, SolPayMode renders it.
//   'sol-zero'     — SOL selected, RPC confirmed balance === '0' (a KNOWN zero, not loading/missing)
//   'token-absent' — an SPL token selected, the device's token account (ATA) for ITS mint is KNOWN absent
//   'token-zero'   — an SPL token selected, ATA exists, RPC confirmed amount === '0'
//   'none'         — fundable as-is (OR any UNCONFIRMED state: loading / unavailable / error — the
//                    gate FAILS OPEN to the live scanner per the offline-first rule; error preserves
//                    the last amount by hook contract, so it is never a confident zero).
// The NFC card must NOT arm while gated (a tap is auto-sign consent — a zero balance signs a
// signature the merchant can never settle).
export type SolPayGate = 'none' | 'sol-zero' | 'token-absent' | 'token-zero';
export function solPayGate(
  selectedToken: string,
  sol: {balance: string | null; status: string},
  token: {amount: string | null; status: string},
): SolPayGate {
  if (selectedToken === 'SOL') {
    return sol.status === 'ok' && sol.balance === '0' ? 'sol-zero' : 'none';
  }
  if (token.status === 'absent') return 'token-absent';
  if (token.status === 'balance' && token.amount != null && token.amount === '0') return 'token-zero';
  return 'none';
}

// The per-request-mint solreq sign gate (OPEN_ISSUES 6(a), 2026-09-06). The solreq auto-sign
// paths (QR scan + NFC card) sign PURE, offline, against an ASSUMED source ATA —
// buildCanonicalSplMessage derives sourceAta = deriveAta(payer, mint) and never checks it
// exists. A cross-mint solreq naming a mint whose ATA this wallet never created would sign
// "successfully", and the merchant's broadcast would be REJECTED on-chain — a dead QR the payer
// cannot see (they showed a signed payment; settlement just never happens). So the sign path
// must refuse BEFORE signing when the REQUEST's mint is KNOWN to have no account here.
//
// The knowledge is the useSolanaBalances per-mint state — which is exactly why an 'absent' fact
// is trustworthy enough to refuse on:
//   ONLY THE OWNER CAN CLOSE AN ATA (close_authority defaults to the owner under Solana program
//   rules), and dpay never builds a close instruction anywhere in app/solana/ — so once a mint
//   has been observed 'absent', it stays absent until this wallet creates the account (Receive ▸
//   createTokenAccount), and once observed 'balance' (ANY amount, including '0') the account
//   existed at poll time and cannot have disappeared. The hook persists these facts across
//   restarts (services/solTokenStatePersist), so they hold offline too.
//
// ── THE RULE, settled 2026-09-08 after the Solana RPC outage ──────────────────────────────────
// An unknown is not a zero, and it is not a yes either. Three outcomes, and why each is what it is:
//
//   1. A KNOWN fact decides, always. 'absent' ⇒ REFUSE (this wallet has no account for that mint,
//      so the merchant's broadcast would be rejected on-chain and the payer would be holding a
//      dead QR — the case flow 137 pins). 'balance' ⇒ ALLOW. A fact outranks whatever the endpoint
//      is doing right now: a refusing endpoint can neither re-open a refusal nor revoke one.
//   2. NO fact ⇒ SIGN ANYWAY, and SAY SO. Refusing here would break the product's own
//      non-negotiable — an offline payer must keep the ability to sign a payment that WOULD
//      settle — and the payer who does hold the account is the common case. So the gate never
//      blocks; it returns a state the surface is obliged to disclose, which is precisely why that
//      state is not spelled 'allow'.
//   3. NO fact AND the RAIL is why ('refused' — the endpoint ANSWERED and did not serve us;
//      'unreadable' bytes it served that cannot be trusted; 'unreachable' — nothing answered on
//      the rail's path while the phone IS online, proven by the IC-boundary probe answering —
//      `SolanaReadFailure` in app/solana.ts) is its OWN state: this device is online and the RAIL
//      is what is broken. That is the 2026-09-08 outage exactly, and it is the case where "we
//      could not check" has to say WHY, because the user can neither wait it out nor fix it by
//      finding signal — telling a phone that IS online to "retry when you have signal" (the
//      plain-'unverified' advice) would be wrong advice for exactly that cause.
//
// What the caller owes the user (the 2026-08-29 every-step-instruction rule): on either unverified
// state, name the token, say the account could not be checked, say what happens if it does not
// exist (the payment cannot settle), and say what to do — 'unverified' means try again when the
// wallet has signal; 'unverified-rail-down' means the Solana rail itself is not answering this
// online wallet, so the account can only be confirmed or created (Receive ▸ My address) once it
// answers again.
export type SolSplSignGate = 'allow' | 'absent' | 'unregistered' | 'unverified' | 'unverified-rail-down';
/** What the gate needs to know about each mint's poll state — the read-only projection of
 *  `SolTokenBalanceState` (hooks/useSolanaBalances.ts). It is named here because it is ALSO the
 *  prop type of every surface that can sign a cross-mint request: those props used to widen the
 *  hook's shape and drop `failure` on the way in, which made the rail-down state invisible to the
 *  type checker on exactly the components that have to disclose it. */
export type SolMintStates = Record<string, {amount: string | null; status: string; failure?: string | null}>;
export function solSplSignGate(mint: string | null, states: SolMintStates): SolSplSignGate {
  if (mint == null) return 'allow';
  if (solanaTokenOfMint(mint) == null) return 'unregistered';
  const state = states[mint];
  if (state == null) return 'unverified';
  if (state.status === 'absent') return 'absent';
  if (state.status === 'balance') return 'allow';
  // No fact. WHY there is none decides which unverified state this is: an endpoint that answered
  // and did not serve us ('refused'), bytes it served that cannot be trusted ('unreadable'), or a
  // rail path that is down while the phone IS online ('unreachable' — the IC-boundary probe
  // answered) — all three mean the rail is the problem and "find signal" would be wrong advice.
  // Anything else (loading, offline, an offline-classified transport failure) is the payer's
  // ordinary world.
  return state.failure === 'refused' || state.failure === 'unreadable' || state.failure === 'unreachable'
    ? 'unverified-rail-down'
    : 'unverified';
}

/**
 * The sentence a payment signed on NO fact owes its payer — the disclosure half of the gate above,
 * and the ONE owner of it: the QR hand-off (`SolPayMode`) and the auto-signing NFC tap
 * (`SolNfcTap`) sign the identical request under the identical doubt, so they must say the
 * identical thing.
 *
 * Null for every gate that is itself a decision: 'allow' signs on a fact and has nothing to
 * disclose, and 'absent'/'unregistered' never sign at all — they are refused BY NAME at the scan.
 */
export function solSignCaveat(gate: SolSplSignGate, mint: string | null): string | null {
  if (gate !== 'unverified' && gate !== 'unverified-rail-down') return null;
  // Unreachable by construction: `solSplSignGate` answers 'allow' for a null mint and
  // 'unregistered' for one the registry does not carry, so an unverified gate always names a
  // registry token. Log rather than print a caveat about an asset this wallet cannot name.
  const asset = mint == null ? null : solanaTokenOfMint(mint);
  if (asset == null) {
    console.warn(`solSignCaveat: gate '${gate}' for mint ${String(mint)} — solSplSignGate cannot produce that pair`);
    return null;
  }
  return gate === 'unverified-rail-down'
    ? M.errors.solana.senderTokenAccountUnverifiedRailDown(asset)
    : M.errors.solana.senderTokenAccountUnverified(asset);
}
