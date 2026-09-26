// The EVM rail's app-side catalog: parsing the relay's `NetworkAssets::Evm` rows into the
// wallet's asset model, the `evm:<chainId>:<TOKEN>` identity, the chain slugs, the chip labels,
// and the visible-row enumeration. PURE (no fetch, no AsyncStorage, no React) — the
// `SolanaAsset`/`buildSelectableAssets` machinery's mirror, held in this one module so every
// EVM display fact has exactly one home.
//
// THE INVARIANT this module protects (the CRITICAL INVARIANT, spec 2026-09-26 D1/D6): EVM never
// enters the ICRC catalog. An evm row is NOT a `CurrencyDescriptor` — no currency id, no ledger
// principal, no minter family. The rows arrive in the relay catalog's SEPARATE `protocol:'evm'`
// sections (`crates/dpay-relay/src/catalog.rs`, `EvmAsset`) and are parsed here, beside — never
// inside — the IC helpers (`familyDisplay`, `isPayableAsset` never inspect an evm row; an evm
// row's payability is a property of its PARSE: a fail-closed parsed row IS payable, the way a
// SOL row is).
//
// # Where this plugs in (the one-line integrations, owned by the UI wave)
//   • `parseNetworkCatalog` (config/catalog.ts) — add the `'evm'` arm calling `parseEvmRow` /
//     push `EvmSection`s (an unknown-protocol section is skipped whole today: old app + new
//     relay = EVM absent, nothing crashes — the D8 compatibility story).
//   • `buildSelectableAssets` (config/assets.ts) — append `evmSelectableRow` outputs after the
//     solana rows, gated on the `evmEnabled` flag (the `solanaEnabled` precedent, off under
//     jest/e2e until a rail is configured — D11); `parseAssetId` gains the evm shape via
//     `parseEvmAssetId`.
// Until those lines land, this module is complete and inert: everything here is pure over the
// raw wire envelope and fully jest-tested on its own.

import {eip55ChecksumBad} from './eip55';
import type {AssetId} from './types';
import {M} from '../i18n';

// ── Ramp vocabulary (the catalog's own; duplicated here, not imported, so this module stays
// pure — config/catalog.ts pulls the relay client and cannot be imported from lib) ──────────────
export type RampCapability = 'Direct' | 'Partner' | 'Unavailable';

function parseRamp(v: unknown): RampCapability {
  return v === 'Direct' || v === 'Partner' || v === 'Unavailable' ? v : 'Unavailable';
}

function parseLiquidity(v: unknown): 'deep' | 'thin' | null {
  return v === 'deep' || v === 'thin' ? v : null;
}

// ── The parsed row (D6) ────────────────────────────────────────────────────────────────────────

/** One EVM asset row, parsed. The wire shape is the relay's `EvmAsset` (snake_case); the app
 *  model is camelCase, mirroring how `parseIcpRow`/`parseSolanaRow` map their rows. */
export type EvmAsset = {
  token: string;            // 'ZCHF' — the SelectableAsset token literal + linkToken
  symbol: string;           // display symbol ('ZCHF')
  decimals: number;         // smallest-unit decimal count (18 for ZCHF)
  minFractionDigits: number | null; // the compact-display floor (2 — unit-denominated)
  chainId: number;          // THE settlement chain (the row IS money on that chain — D4)
  address: string;          // EIP-55 checksummed ERC-20 contract (verified at parse)
  liquidity: 'deep' | 'thin' | null;
  onramp: RampCapability;   // fail-closed to 'Unavailable'
  offramp: RampCapability;
  testnet: boolean;         // stamped from the owning section's environment, never re-inferred
};

/**
 * Map one wire evm row → `EvmAsset`, or null (fail-closed skip — the row renders nothing
 * rather than something wrong). Required: token, symbol, decimals, chainId, address.
 * `eip55ChecksumBad(address)` REJECTS the row: a mangled checksum on the wire is a
 * money-routing bug, not a display nit (D6) — the address is where the money moves.
 */
export function parseEvmRow(row: unknown, testnet: boolean): EvmAsset | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.token !== 'string' || r.token.length === 0) return null;
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) return null;
  if (typeof r.decimals !== 'number' || !Number.isInteger(r.decimals) || r.decimals < 0) return null;
  if (typeof r.chain_id !== 'number' || !Number.isInteger(r.chain_id) || r.chain_id <= 0) return null;
  if (typeof r.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) return null;
  if (eip55ChecksumBad(r.address)) return null;
  return {
    token: r.token,
    symbol: r.symbol,
    decimals: r.decimals,
    minFractionDigits: typeof r.min_fraction_digits === 'number' ? r.min_fraction_digits : null,
    chainId: r.chain_id,
    address: r.address,
    liquidity: parseLiquidity(r.liquidity),
    onramp: parseRamp(r.onramp),
    offramp: parseRamp(r.offramp),
    testnet,
  };
}

// ── Sections (the raw wire envelope → evm sections) ────────────────────────────────────────────

export type EvmSection = {
  protocol: 'evm';
  name: string;
  environment: 'mainnet' | 'testnet';
  assets: EvmAsset[];
};

/**
 * Pull the evm sections out of a catalog wire envelope's `networks` array (RAW — the shape
 * config/catalog.ts's parser hands to its per-protocol arms). Independent of the config types
 * so it composes with BOTH orders: before the config parser gains its evm arm (this module
 * reads the raw envelope directly) and after (the arm delegates to `parseEvmRow`). A section
 * with a bad environment is skipped whole (classification is server-declared — the app never
 * infers it), mirroring the config parser.
 */
export function evmSectionsOf(networks: readonly unknown[]): EvmSection[] {
  const out: EvmSection[] = [];
  for (const raw of networks) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (s.protocol !== 'evm') continue;
    const environment: 'mainnet' | 'testnet' | null =
      s.environment === 'mainnet' ? 'mainnet' : s.environment === 'testnet' ? 'testnet' : null;
    if (!environment) continue;
    const list: unknown = s.assets;
    if (!Array.isArray(list)) continue;
    const rows: EvmAsset[] = [];
    for (const row of list) {
      const parsed = parseEvmRow(row, environment === 'testnet');
      if (parsed) rows.push(parsed);
    }
    out.push({protocol: 'evm', name: typeof s.name === 'string' ? s.name : '', environment, assets: rows});
  }
  return out;
}

/** The flat parsed rows from every evm section, in section order (the `solanaAssetsOf`
 *  mirror — section order IS the wallet row order). */
export function evmAssetsOf(sections: readonly EvmSection[]): EvmAsset[] {
  const out: EvmAsset[] = [];
  for (const s of sections) out.push(...s.assets);
  return out;
}

// ── Chain slugs (D7) ───────────────────────────────────────────────────────────────────────────

/**
 * The settlement-chain slug a payment link spells (`?network=<slug>`): the canonical spellings
 * for the shared links are exactly `arbitrum` and `ethereum` (the founder's `?network=arbitrum`
 * example). `normaliseNetwork` (lib/deepLink.ts) lowercases+hyphenates, so a hand-typed
 * `network=Arbitrum One` mismatches and is REFUSED (`wrong_network`) — the slug is the pinned
 * identity, not a display convenience. Single source here; the config/link layer reads it.
 */
export const EVM_CHAIN_SLUGS: Record<number, string> = {
  1: 'ethereum',
  42161: 'arbitrum',
  421614: 'arbitrum-sepolia',
  31337: 'anvil',
};

export function evmChainSlug(chainId: number): string | null {
  return EVM_CHAIN_SLUGS[chainId] ?? null;
}

/** The settlement chain named by a link slug → chainId, or null (unknown slugs refuse). */
export function evmChainIdOfSlug(slug: string): number | null {
  const entry = Object.entries(EVM_CHAIN_SLUGS).find(([, s]) => s === slug);
  return entry ? Number(entry[0]) : null;
}

// ── The selectable row (D7) ────────────────────────────────────────────────────────────────────

/**
 * The evm arm of the selectable-asset union, shaped field-for-field like the `ic`/`solana`
 * arms (`config/assets.ts`) so the UI wave can add it to that union and every selector renders
 * it through the SAME surfaces (D13: parameterize, never fork). `linkToken` = the token itself
 * ('ZCHF') — exact-case-insensitive tokenEq only, so it can never collide with the IC 'VCHF'
 * row ('Z' ≠ 'V'; no prefix/substring matching anywhere).
 */
export type EvmSelectableAsset = {
  id: `evm:${number}:${string}`; // `evm:42161:ZCHF` — chainId + token, both stable
  protocol: 'evm';
  token: string;
  symbol: string;
  chainId: number;
  chainName: string;      // 'Arbitrum One' | 'Ethereum' — the section name, proper noun
  address: string;        // the token contract
  linkToken: string;      // = token ('ZCHF'); never collides with IC 'VCHF'
  networkLabel: string;   // 'ZCHF · Arbitrum One'
  network: string;        // chainName (settlement chain, the SOL-arm convention)
  decimals: number;
  minFractionDigits: number;
  liquidity: 'deep' | 'thin' | null;
  onramp: RampCapability;
  offramp: RampCapability;
  rampPartner: string | null; // the evm wire carries none today (all rows Unavailable)
  visible: boolean;
  testKey: string;        // 'evm-zchf-arbitrum' / 'evm-zchf-ethereum'
  testnet: boolean;       // dev rows hide behind the existing testnet toggle
};

/** The chain proper noun for a row: the OWNING SECTION's name (the relay's 'Arbitrum One' /
 *  'Ethereum' / 'Anvil'), never re-derived from the chainId — the section name is the served
 *  fact. Falls back to the slug when a section carried no name. */
export function evmChainName(row: EvmAsset, sections?: readonly EvmSection[]): string {
  const fromSection = sections?.find((s) => s.assets.some((a) => a.chainId === row.chainId))?.name;
  if (fromSection != null && fromSection.length > 0) return fromSection;
  const named: Record<number, string> = {1: 'Ethereum', 42161: 'Arbitrum One', 421614: 'Arbitrum Sepolia', 31337: 'Anvil'};
  return named[row.chainId] ?? evmChainSlug(row.chainId) ?? `chain ${row.chainId}`;
}

/** Build the selectable-asset view for one parsed evm row. Pure; called per visible row. */
export function evmSelectableRow(row: EvmAsset, sections?: readonly EvmSection[]): EvmSelectableAsset {
  const chainName = evmChainName(row, sections);
  const slug = evmChainSlug(row.chainId) ?? String(row.chainId);
  return {
    id: `evm:${row.chainId}:${row.token}`,
    protocol: 'evm',
    token: row.token,
    symbol: row.symbol,
    chainId: row.chainId,
    chainName,
    address: row.address,
    linkToken: row.token,
    networkLabel: M.wallet.asset.networkLabel(row.symbol, chainName),
    network: chainName,
    decimals: row.decimals,
    minFractionDigits: row.minFractionDigits ?? 0,
    liquidity: row.liquidity,
    onramp: row.onramp,
    offramp: row.offramp,
    rampPartner: null,
    visible: true,
    testKey: `evm-${row.token.toLowerCase()}-${slug}`,
    testnet: row.testnet,
  };
}

/**
 * Parse a PERSISTED asset id in the evm shape — `evm:<chainId>:<TOKEN>` (shape-checked only;
 * membership is the reconcile step's job, exactly like every other arm). Uppercase registry
 * token ([A-Z0-9]{2,10}: ZCHF/USDC/…); the chainId is normalized through Number so
 * `evm:042161:ZCHF` never equals the canonical `evm:42161:ZCHF`.
 */
export function parseEvmAssetId(v: string | null | undefined): AssetId | null {
  if (typeof v !== 'string') return null;
  const m = /^evm:(\d+):([A-Z0-9]{2,10})$/.exec(v);
  if (!m) return null;
  return (`evm:${Number(m[1])}:${m[2]}`) as AssetId;
}

// ── Link routing + identity (D7/D17 halves) ────────────────────────────────────────────────────

/** The settlement chain of an evm asset, as a payment link spells it: the chain slug. (The
 *  config layer's `linkNetworkOf` gains this arm; kept here so the slug lives once.) */
export function linkNetworkOfEvm(row: {chainId: number}): string {
  return evmChainSlug(row.chainId) ?? String(row.chainId);
}

/**
 * Does an outside party's token spelling name this asset? EXACT string identity,
 * case-insensitively (the config `tokenEq` rule, verbatim): no trimming, no prefix, no
 * substring. 'ZCHF' names the EVM ZCHF rows and nothing else — the IC 'VCHF' row is a
 * DIFFERENT asset and can never match (a wrong match would route a payment across rails).
 */
export const evmTokenEq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ── Chip labels (the collision-qualified chip, D5's jest half) ─────────────────────────────────

/**
 * The SHORT network tag a colliding chip qualifies with: two EVM rows share the symbol 'ZCHF'
 * (Arbitrum One + Ethereum), so their chips must read 'ZCHF·Arb' / 'ZCHF·Eth' — a bare 'ZCHF'
 * on both would be ambiguous at a glance. Proper-noun map (never translated); anything else
 * falls back to a short prefix so it still disambiguates.
 */
const EVM_SHORT_NETWORK_TAG: Record<string, string> = {
  'Arbitrum One': 'Arb',
  'Arbitrum Sepolia': 'ArbSep',
  Ethereum: 'Eth',
  Anvil: 'Anv',
};

export function evmShortNetworkTag(chainName: string): string {
  const mapped = EVM_SHORT_NETWORK_TAG[chainName];
  if (mapped) return mapped;
  return chainName.replace(/\s+/g, ' ').trim().slice(0, 3).trim();
}

/** The chip label for one evm row among all visible rows: the bare symbol UNLESS the symbol is
 *  ambiguous (more than one visible row carries it), then `SYM·<tag>` (the config `chipLabel`
 *  rule, evm arm). */
export function evmChipLabel(
  row: {symbol: string; chainName: string},
  all: readonly {symbol: string; chainName: string}[],
): string {
  const collision = all.filter((a) => a.symbol === row.symbol).length > 1;
  if (!collision) return row.symbol;
  return `${row.symbol}·${evmShortNetworkTag(row.chainName)}`;
}

// ── The polled-keys enumeration (the visibleSolanaMints invariant) ─────────────────────────────

/** One (chainId, token, address, decimals) balance-poll key — the tuple `readEvmBalances`
 *  consumes (EvmKey at the seam), and the identity of one rendered row's number. */
export interface EvmBalanceKey {
  readonly chainId: number;
  readonly token: string;
  readonly tokenAddress: string;
  readonly decimals: number;
}

/**
 * The exact set of EVM rows the wallet will RENDER as visible (testnet filtered unless opted
 * in) — the set the balance hook must poll, so the rendered rows and the polled set can never
 * drift (the stated invariant of the SOL helper). `evmEnabled` gates the whole rail (the
 * `solanaEnabled` precedent: off under jest/e2e until a rail is configured — D11).
 */
export function visibleEvmKeys(
  sections: readonly EvmSection[],
  opts?: {showTestnet?: boolean; evmEnabled?: boolean},
): EvmBalanceKey[] {
  if (opts?.evmEnabled === false) return [];
  const showTestnet = opts?.showTestnet === true;
  const out: EvmBalanceKey[] = [];
  for (const row of evmAssetsOf(sections)) {
    if (row.testnet && !showTestnet) continue;
    out.push({chainId: row.chainId, token: row.token, tokenAddress: row.address, decimals: row.decimals});
  }
  return out;
}
