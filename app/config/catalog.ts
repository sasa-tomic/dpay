import AsyncStorage from '@react-native-async-storage/async-storage';
import {fmtAsset, fmtAssetCompact, usd} from '../lib/format';
import {MAX_DECIMALS} from '../lib/amount';
import {M} from '../i18n';
import {BALANCE_TIMEOUT_MS} from './constants';
import {relayFetch} from '../services/relay';
import {SOL_DECIMALS} from '../solana/identity';
import {USDC_DECIMALS, USDC_MINT_ADDRESS} from '../solana/spl';
import {EURC_DECIMALS, EURC_MINT_ADDRESS} from '../solana/tokens';
import {parseEvmRow, type EvmAsset} from '../lib/evmCatalog';
import {ZCHF_TOKEN, ZCHF_DECIMALS, USDC_TOKEN, USDC_EVM_DECIMALS} from '../evm/chains';

// --- currency catalog (M0 + MC1 unit 5 + catalog v2 network-first) ---------------------------
// The wallet's runtime source of truth for which assets exist + how to display/fund them. Fetched
// from GET /api/v1/currencies (the relay's multi-network composition), cached in AsyncStorage, with
// a bundled default fallback so the UI renders on a cold/offline first load. Closes issue #7: the
// ckBTC currency id is RESOLVED from the catalog (the CkBtcUtxo entry) instead of the old hardcoded
// `DEPOSIT_CURRENCY = 1`, so adding a currency is canister-config-only (no app redeploy).
//
// MC1 unit 5: every currency carries AUTHORITATIVE per-currency metadata (backing symbol, wrapper
// name, network, decimals, fee, cap, chain id, token contract, per-direction ramp capability) —
// the canister is the single source of truth for ICRC facts, the relay composes, the app caches.
//
// Catalog v2 (2026-08-27): the response is NETWORK-FIRST —
//   {"networks":[{protocol, name, environment, assets:[...]}, ...]}
// with icp mainnet + icp testnet + solana mainnet sections. ONE shape everywhere: the parsed
// response, the AsyncStorage cache, and the bundled fallback are all `NetworkSection[]`, and the
// flat IC `CurrencyDescriptor[]` consumers expect is DERIVED (`icpCatalogOf`) — never a second
// hand-maintained shape. Testnet-ness is SERVER-DECLARED: the relay partitions IC rows into
// mainnet/testnet sections (an IC row is testnet iff `network.is_some() && network ∉
// {Bitcoin, Ethereum}`; `network == null` DEMO is mainnet-side); the app stamps each row's
// `testnet` field from its owning section's environment at parse time and NEVER re-infers. The
// FROZEN payment wire format is untouched (this is catalog metadata, not wire bytes).
export type MinterFamily = 'CkBtcUtxo' | 'CkEthErc20' | 'CkSol';
// Per-direction ramp capability. Mirrors the relay catalog's `RampCapability`. `Unavailable` ⇒ the
// UI shows NO button for that direction — DEMO's offramp, and BOTH directions on VCHF/ICP, which
// have no fiat ramp. On VCHF/ICP that is fiat-ramp honesty ONLY: a transfer in from any IC wallet
// still works, via Receive ▸ My address (`IcrcDepositSheet`).
export type RampCapability = 'Direct' | 'Partner' | 'Unavailable';
export type CurrencyDescriptor = {
  currency: number;          // the Currency u32 — read from the catalog, NEVER hardcoded
  ledger: string;            // ICRC ledger principal as text
  mintable: boolean;         // true for the demo currency the facade mints/burns
  minter: string | null;     // ramp (ck minter) principal as text, or null (no deposit/withdraw path)
  minter_family: MinterFamily | null;
  symbol: string | null;     // display symbol ("$", "₿", "ETH", "ckUSDC" — never a glyph the bundled fonts lack)
  decimals: number | null;   // smallest-unit decimal count (USD=2, BTC=8, USDC=6)
  // MC1 unit 5 — authoritative per-currency metadata:
  wrapper_name: string | null;     // IC wrapper token name ("ckBTC"/"ckUSDC")
  backing_symbol: string | null;   // backing native-chain asset symbol ("BTC"/"USDC"/"ETH")
  network: string | null;          // native settlement network name ("Bitcoin"/"Ethereum")
  display_decimals: number | null; // UI precision; default = `decimals` (full precision) when unset
  // The compact display's MINIMUM fractional digits — the floor `display_decimals` caps from
  // above. 2 for the unit-denominated tokens counted like money (ckUSDC/VCHF → "1.50", "0.00"),
  // null ⇒ 0 for the ones written trimmed (BTC/ETH/ICP/SOL → "1.5", "0"). Read ONLY by
  // `fmtAssetCompact`; the exact formatter (`fmtAsset`) ignores it.
  min_fraction_digits: number | null;
  fee: string | null;              // ICRC ledger fee in RAW units (string for forward-compat; MC2 governs)
  cap: string | null;              // per-currency tx cap in RAW units (string for forward-compat; MC2 governs)
  chain_id: number | null;         // EVM chain id for ckERC20 (1=Ethereum mainnet)
  token_contract: string | null;   // ERC-20 contract address (0x…) for ckERC20 — per-token
  gas_ledger: string | null;       // ckETH gas-ledger principal for ckERC20 cash-out (withdraw_erc20); null otherwise
  onramp: RampCapability;          // funding capability; Unavailable ⇒ no "Add money" button
  offramp: RampCapability;         // cash-out capability; Unavailable ⇒ no "Cash out" button
  // EUR dual-rail Stage 1 (2026-09-06) — DATA, not prose. Market-liquidity tier + the fiat-ramp
  // PARTNER an `offramp: 'Partner'` row names — generic machinery kept for legacy served catalogs
  // (the 2026-09-19-retired VEUR row still names 'DFX' on prod until the redeploy). Both OPTIONAL
  // on the wire (the relay skips the keys when unset — rows without them serialize
  // byte-identically) and parsed FAIL-CLOSED to null on anything unexpected.
  liquidity: 'deep' | 'thin' | null;
  ramp_partner: string | null;
  // Catalog v2 — SERVER-DECLARED environment: stamped at parse time from the owning icp section's
  // `environment` (bundled fallback rows carry it too). The app NEVER re-infers this from the
  // display `network` string — the mainnet/testnet partition rule lives only in the relay.
  testnet: boolean;
};

// --- catalog v2: the network-first section shape ----------------------------------------------
// One section per (protocol, environment). icp sections carry `CurrencyDescriptor` rows (the ICRC
// facts the facade is the source of truth for — row shape UNCHANGED from the flat catalog era);
// solana sections carry the device-key rail's display facts. Adding a future chain = a new
// `protocol` arm + a new app rail module; the catalog/cache/picker plumbing keeps this shape.
export type SolanaAsset = {
  token: string;              // 'SOL' | 'USDC' | 'EURC' — the SelectableAsset token literal
  symbol: string;             // display symbol ('SOL' / 'USDC' / 'EURC')
  decimals: number;           // smallest-unit decimal count (SOL=9, USDC=6, EURC=6)
  // The same compact-display floor the IC rows carry, so USDC/EURC read "1.50" on BOTH rails.
  min_fraction_digits: number | null;
  mint: string | null;        // SPL mint principal as text; null for native SOL
  // EUR dual-rail Stage 1 (2026-09-06): market-liquidity tier — OPTIONAL on the wire (the relay
  // skips the key when unset), parsed FAIL-CLOSED to null on anything unexpected.
  liquidity: 'deep' | 'thin' | null;
  // Fiat ramps (RE-ADDED 2026-09-06 — the relay always emitted these; the app now parses them).
  // SEMANTICS: these declare FIAT ramps, matching the relay's 2026-09-06 correction — the old
  // 'Direct' on SOL/USDC meant structural self-custody (a tautology on the device-key rail).
  // Parsed fail-closed to 'Unavailable' on unknown values, same as the IC rows.
  onramp: RampCapability;
  offramp: RampCapability;
};
export type NetworkSection =
  | {protocol: 'icp'; name: string; environment: 'mainnet' | 'testnet'; assets: CurrencyDescriptor[]}
  | {protocol: 'solana'; name: string; environment: 'mainnet' | 'testnet'; assets: SolanaAsset[]}
  | {protocol: 'evm'; name: string; environment: 'mainnet' | 'testnet'; assets: EvmAsset[]};
// --- the ONE parser (wire JSON → NetworkSection[]) ---------------------------------------------
// PURE: validates the network-first envelope, maps icp rows field-for-field exactly as the flat
// catalog era did (IC row shape UNCHANGED), stamps each row's `testnet` from its owning section's
// `environment`, and validates solana rows to SolanaAsset. The SAME parser serves the live
// response, the AsyncStorage cache read, and (structurally) the bundled fallback — one code path,
// one shape. Returns null for anything else (missing/malformed `networks`, a legacy
// `{currencies:[…]}` envelope, or a response whose every section parsed to zero assets) so callers
// keep their prior catalog. Malformed SECTIONS/rows are skipped; a section whose `environment` is
// neither 'mainnet' nor 'testnet' is skipped whole (classification is server-declared — the app
// never infers it); a section with an unknown `protocol` (a future chain this app version has no
// rail for) is skipped.
export function parseNetworkCatalog(j: unknown): NetworkSection[] | null {
  const networks = (j as {networks?: unknown} | null | undefined)?.networks;
  if (!Array.isArray(networks)) return null;
  const sections: NetworkSection[] = [];
  let assetCount = 0;
  for (const raw of networks) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const environment: 'mainnet' | 'testnet' | null =
      s.environment === 'mainnet' ? 'mainnet' : s.environment === 'testnet' ? 'testnet' : null;
    if (!environment) continue;
    const name = typeof s.name === 'string' ? s.name : '';
    const list: unknown = s.assets;
    if (!Array.isArray(list)) continue;
    if (s.protocol === 'icp') {
      const rows: CurrencyDescriptor[] = [];
      for (const row of list) {
        const parsed = parseIcpRow(row, environment === 'testnet');
        if (parsed) rows.push(parsed);
      }
      assetCount += rows.length;
      sections.push({protocol: 'icp', name, environment, assets: rows});
    } else if (s.protocol === 'solana') {
      const rows: SolanaAsset[] = [];
      for (const row of list) {
        const parsed = parseSolanaRow(row);
        if (parsed) rows.push(parsed);
      }
      assetCount += rows.length;
      sections.push({protocol: 'solana', name, environment, assets: rows});
    } else if (s.protocol === 'evm') {
      // The EVM device-key rail's rows — parsed by the same fail-closed parser the lib owns
      // (`parseEvmRow`: a broken checksum or a missing field SKIPS the row, never renders it).
      // EVM never enters the ICRC catalog — these rows live in their own protocol section, the
      // `SolanaAsset` precedent (the CRITICAL INVARIANT, lib/evmCatalog.ts header).
      const rows: EvmAsset[] = [];
      for (const row of list) {
        const parsed = parseEvmRow(row, environment === 'testnet');
        if (parsed) rows.push(parsed);
      }
      assetCount += rows.length;
      sections.push({protocol: 'evm', name, environment, assets: rows});
    }
  }
  return assetCount > 0 ? sections : null;
}

// Map one wire icp row → CurrencyDescriptor. Field-for-field the flat-catalog-era mapping (IC row
// shape is UNCHANGED on the wire); `testnet` comes from the OWNING SECTION, never the row.
function parseIcpRow(c: unknown, testnet: boolean): CurrencyDescriptor | null {
  if (!c || typeof c !== 'object') return null;
  const r = c as Record<string, unknown>;
  if (typeof r.currency !== 'number') return null;
  return {
    currency: r.currency,
    ledger: typeof r.ledger === 'string' ? r.ledger : '',
    mintable: !!r.mintable,
    minter: typeof r.minter === 'string' ? r.minter : null,
    minter_family: (typeof r.minter_family === 'string' ? r.minter_family : null) as MinterFamily | null,
    symbol: typeof r.symbol === 'string' ? r.symbol : null,
    decimals: typeof r.decimals === 'number' ? r.decimals : null,
    wrapper_name: typeof r.wrapper_name === 'string' ? r.wrapper_name : null,
    backing_symbol: typeof r.backing_symbol === 'string' ? r.backing_symbol : null,
    network: typeof r.network === 'string' ? r.network : null,
    display_decimals: typeof r.display_decimals === 'number' ? r.display_decimals : null,
    min_fraction_digits: typeof r.min_fraction_digits === 'number' ? r.min_fraction_digits : null,
    // fee/cap: accept number or string from the relay; carry as string (forward-compatible for
    // u64 values that exceed Number.MAX_SAFE_INTEGER once MC2 governs them).
    fee: r.fee == null ? null : String(r.fee),
    cap: r.cap == null ? null : String(r.cap),
    chain_id: typeof r.chain_id === 'number' ? r.chain_id : null,
    token_contract: typeof r.token_contract === 'string' ? r.token_contract : null,
    gas_ledger: typeof r.gas_ledger === 'string' ? r.gas_ledger : null,
    onramp: parseRamp(r.onramp),
    offramp: parseRamp(r.offramp),
    // EUR dual-rail Stage 1 (2026-09-06): optional wire fields, fail-closed to null when absent
    // (pre-EUR rows) or anything unexpected.
    liquidity: parseLiquidity(r.liquidity),
    ramp_partner: typeof r.ramp_partner === 'string' && r.ramp_partner.length > 0 ? r.ramp_partner : null,
    testnet,
  };
}

// Map one wire solana row → SolanaAsset. token/symbol/decimals are required (a row without them
// renders nothing honestly); mint defaults to null (native SOL); ramps fail closed to Unavailable;
// liquidity fails closed to null.
function parseSolanaRow(a: unknown): SolanaAsset | null {
  if (!a || typeof a !== 'object') return null;
  const r = a as Record<string, unknown>;
  if (typeof r.token !== 'string' || r.token.length === 0) return null;
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) return null;
  if (typeof r.decimals !== 'number') return null;
  return {
    token: r.token,
    symbol: r.symbol,
    decimals: r.decimals,
    min_fraction_digits: typeof r.min_fraction_digits === 'number' ? r.min_fraction_digits : null,
    mint: typeof r.mint === 'string' ? r.mint : null,
    liquidity: parseLiquidity(r.liquidity),
    onramp: parseRamp(r.onramp),
    offramp: parseRamp(r.offramp),
  };
}

// Ramp vocabulary validation (Direct/Partner/Unavailable); anything else fails closed.
function parseRamp(v: unknown): RampCapability {
  return v === 'Direct' || v === 'Partner' || v === 'Unavailable' ? v : 'Unavailable';
}

// Liquidity tier validation (deep/thin — the relay's lowercase LiquidityTier serde tags);
// anything else fails closed to null.
function parseLiquidity(v: unknown): 'deep' | 'thin' | null {
  return v === 'deep' || v === 'thin' ? v : null;
}

// --- the ONE derivation: NetworkSection[] → the shapes consumers expect -------------------------
// The flat IC catalog every existing consumer (Wallet filters, PayMode, familyDisplay,
// isPayableAsset, fmtCurrencyAmount…) expects: icp section rows in section order (the relay emits
// mainnet then testnet; concatenation preserves arrival order). The bundled fallback, the cache,
// and the live response all derive their flat catalog through THIS function — one code path.
export function icpCatalogOf(networks: NetworkSection[]): CurrencyDescriptor[] {
  const out: CurrencyDescriptor[] = [];
  for (const s of networks) {
    if (s.protocol === 'icp') out.push(...s.assets);
  }
  return out;
}

// The Solana display facts (symbol/decimals/mint/ramps) from every solana section — what
// `buildSelectableAssets` reads to render the device-key rail's rows catalog-driven.
export function solanaAssetsOf(networks: NetworkSection[]): SolanaAsset[] {
  const out: SolanaAsset[] = [];
  for (const s of networks) {
    if (s.protocol === 'solana') out.push(...s.assets);
  }
  return out;
}

// The EVM rows from every evm section, in section order (the `solanaAssetsOf` mirror — the
// relay emits Arbitrum One then Ethereum, and section order IS the wallet row order).
export function evmAssetsOf(networks: NetworkSection[]): EvmAsset[] {
  const out: EvmAsset[] = [];
  for (const s of networks) {
    if (s.protocol === 'evm') out.push(...s.assets);
  }
  return out;
}

// Relay-URL-scoped cache key (Phase 1 — 2026-08-12 unified asset selection rewrite). The cache is
// keyed by the NORMALIZED relay URL (trailing slashes trimmed) so switching relays (Settings →
// advanced) cannot reuse the prior relay's catalog (a relay that exposes a different asset set —
// testnet, a different currency-id mapping — would otherwise render stale/wrong rows until the
// next fetch landed). Catalog v2 (2026-08-27) bumps v2 → v3 with the SHAPE change (flat
// CurrencyDescriptor[] → NetworkSection[]): a stale v2 flat entry can never be parsed as sections,
// and the bump keeps it from even being tried.
//
// PURE: no AsyncStorage, no side effects — unit-testable directly. Consumers (`useCatalog`,
// `fetchCurrencies`) call this with the active `relayUrl` to derive their read/write key.
const CATALOG_CACHE_PREFIX = 'dpay.currencies.v3';
export function catalogCacheKey(relayUrl: string): string {
  const normalized = relayUrl.replace(/\/+$/, '');
  return `${CATALOG_CACHE_PREFIX}:${normalized}`;
}
// Bundled fallback so a cold/offline first load still renders. Overwritten by the live catalog on
// the first successful fetch. ONE shape with the wire (NetworkSection[]): icp mainnet carries the
// demo deployment's rows (DEMO_USD + ckBTC + ckUSDC + ckETH — all stamped testnet:false — plus the
// VCHF + ICP complete no-minter direct-ICRC rows, payable without ramps; see isPayableAsset),
// icp testnet is EMPTY (the relay still emits the section — clients shouldn't infer from absence),
// and the solana section mirrors app/solana.ts's rail constants VERBATIM (decimals + the USDC
// mainnet mint are imported from the rail modules — never re-typed here) plus the EURC row (its
// mint is typed from dfx/catalog_truth.json eurc_mint — no app rail constant exists yet; Stage 4
// wires one). Ramp honesty (no-swap + Fork-C/O3): DEMO onramp=Direct(faucet)/offramp=Unavailable;
// ckBTC + ckUSDC + ckETH onramp=Direct/offramp=Direct (ckUSDC's dual-ledger withdraw_erc20
// cash-out is gated on the user holding ckETH for gas — the gas_ledger carries the ckETH
// principal). VEUR (currency 9) was RETIRED 2026-09-19 — dropped from the bundled rows (the id is
// never reused); a legacy SERVED catalog may still carry its thin+Partner row and the generic
// liquidity/ramp_partner machinery renders it as a normal row until the prod redeploy.
// Solana FIAT-ramp semantics (2026-09-06, mirroring the relay's correction):
// SOL/USDC/EURC all read Unavailable/Unavailable — the fields declare FIAT ramps now; the old
// Direct/Direct meant structural self-custody (true of every row on the device-key rail).
export const BUNDLED_NETWORKS: NetworkSection[] = [
  {
    protocol: 'icp', name: 'Internet Computer', environment: 'mainnet',
    assets: [
      {currency: 0, ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai', mintable: true, minter: null, minter_family: null, symbol: '$', decimals: 2,
        wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, min_fraction_digits: null, fee: null, cap: null,
        chain_id: null, token_contract: null, gas_ledger: null, onramp: 'Direct', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false},
      // ckBTC's ledger transfer fee is the MEASURED live value (2026-09-18, anonymous read-only
      // query: `dfx canister call mxzaz-hqaaa-aaaar-qaada-cai icrc1_fee '(record {})' --network ic`
      // → `(10 : nat)`): 10 raw units = 10 sats at 8 decimals. Pinned AHEAD of the prod
      // /api/v1/currencies row by design — the relay's compiled catalog is the sole catalog
      // authority and its redeploys are founder-run; the bundled row does not wait on that.
      // The pin is what admits the ckBTC hub routes (app/routes.ts hubRoutes) and direct pairs.
      {currency: 1, ledger: 'mxzaz-hqaaa-aaaar-qaada-cai', mintable: false, minter: 'mqygn-kiaaa-aaaar-qaadq-cai', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8,
        wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8, min_fraction_digits: null, fee: '10', cap: null,
        chain_id: null, token_contract: null, gas_ledger: null, onramp: 'Direct', offramp: 'Direct', liquidity: null, ramp_partner: null, testnet: false},
      {currency: 2, ledger: 'xevnm-gaaaa-aaaar-qafnq-cai', mintable: false, minter: 'sv3dd-oaaaa-aaaar-qacoa-cai', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6,
        wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', display_decimals: 6, min_fraction_digits: 2, fee: '10000', cap: null,
        chain_id: 1, token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', gas_ledger: 'ss2fx-dyaaa-aaaar-qacoq-cai', onramp: 'Direct', offramp: 'Direct', liquidity: null, ramp_partner: null, testnet: false},
      {currency: 6, ledger: 'ss2fx-dyaaa-aaaar-qacoq-cai', mintable: false, minter: 'sv3dd-oaaaa-aaaar-qacoa-cai', minter_family: 'CkEthErc20', symbol: 'ETH', decimals: 18,
        wrapper_name: 'ckETH', backing_symbol: 'ETH', network: 'Ethereum', display_decimals: 6, min_fraction_digits: null, fee: '2000000000000', cap: null,
        chain_id: 1, token_contract: null, gas_ledger: null, onramp: 'Direct', offramp: 'Direct', liquidity: null, ramp_partner: null, testnet: false},
      // VCHF (currency 7) + ICP (currency 8) — complete NO-MINTER direct-ICRC mainnet assets
      // (2026-08-28; docs/specs/2026-08-28-vchf-icp-support-spec.md). External IC ledgers, not
      // dpay-owned canisters: payment is a plain icrc1_transfer to `ledger`. There is no minter and
      // no minter_family (NEVER a fake family) and NO ramps: onramp/offramp Unavailable ⇒ the UI
      // shows no Add money / Cash out buttons while Pay/Receive stay enabled (isPayableAsset does
      // not inspect ramps). Caps are the initial payment-policy values (10,000 VCHF / 1,000 ICP),
      // not ledger limits. Principals + decimals are drift-checked against dfx/catalog_truth.json
      // (vchf_ledger / icp_ledger) by the jest suite.
      {currency: 7, ledger: 'ly36x-wiaaa-aaaai-aqj7q-cai', mintable: false, minter: null, minter_family: null, symbol: 'VCHF', decimals: 8,
        wrapper_name: 'VCHF', backing_symbol: 'VCHF', network: 'Internet Computer', display_decimals: 8, min_fraction_digits: 2, fee: '10000', cap: '1000000000000',
        chain_id: null, token_contract: null, gas_ledger: null, onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false},
      {currency: 8, ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', mintable: false, minter: null, minter_family: null, symbol: 'ICP', decimals: 8,
        wrapper_name: 'ICP', backing_symbol: 'ICP', network: 'Internet Computer', display_decimals: 8, min_fraction_digits: null, fee: '10000', cap: '100000000000',
        chain_id: null, token_contract: null, gas_ledger: null, onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false},
    ],
  },
  {protocol: 'icp', name: 'Internet Computer', environment: 'testnet', assets: []},
  {
    protocol: 'solana', name: 'Solana', environment: 'mainnet',
    assets: [
      // Fiat-ramp semantics (2026-09-06, mirrors the relay's correction): Unavailable/Unavailable
      // on every row — dpay wires no solana fiat rail; the old Direct/Direct meant structural
      // self-custody (true of the whole device-key rail), which nothing reads app-side.
      // liquidity null on the pre-EUR rows (the wire omits the key; the bundled shape matches).
      {token: 'SOL', symbol: 'SOL', decimals: SOL_DECIMALS, min_fraction_digits: null, mint: null, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable'},
      {token: 'USDC', symbol: 'USDC', decimals: USDC_DECIMALS, min_fraction_digits: 2, mint: USDC_MINT_ADDRESS, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable'},
      // EURC — the solana half of the EUR dual-rail (Stage 1, 2026-09-06): the DEEP-liquidity
      // EUR asset (Circle's native solana EURC). Mint + decimals come from the token registry
      // (`solana/tokens.ts`, Stage 2) — the same source of truth dfx/catalog_truth.json's
      // eurc_mint drift-checks against. Offerable since Stage 2 wired the solana asset
      // enumeration (CURRENCY_RAILS.EUR: ['EURC'] matches its linkToken).
      {token: 'EURC', symbol: 'EURC', decimals: EURC_DECIMALS, min_fraction_digits: 2, mint: EURC_MINT_ADDRESS, liquidity: 'deep', onramp: 'Unavailable', offramp: 'Unavailable'},
    ],
  },
  // The EVM device-key rail's bundled rows (D6) — Arbitrum One FIRST (the recommended event
  // rail; section order IS the wallet row order), then Ethereum, then the EMPTY Arbitrum
  // Sepolia testnet section (the icp-testnet empty-section convention: clients shouldn't infer
  // from absence). Addresses + decimals are IMPORTED from app/evm/chains.ts (the registry) —
  // never re-typed. Dev/Anvil rows are NEVER bundled (env-gated relay-side only, D3). Each
  // section's rows[0] is ZCHF, rows[1] is USDC (the wire-byte pins index that order). The ramp
  // flips on the eligible rows: the offramps R2 step 1 (2026-10-12), the ZCHF-Ethereum onramp
  // 2026-10-15 (Mt Pelerin confirmed buy support). ZCHF-Ethereum and both USDC rows read
  // Partner; the Arbitrum ZCHF row stays Unavailable both ways (Mt Pelerin delivers no ZCHF on
  // Arbitrum). Liquidity null on all (no measured venue tier; do not invent one).
  {
    protocol: 'evm', name: 'Arbitrum One', environment: 'mainnet',
    assets: [
      {token: 'ZCHF', symbol: 'ZCHF', decimals: ZCHF_DECIMALS, minFractionDigits: 2, chainId: 42161,
        address: ZCHF_TOKEN[42161]!.address, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', testnet: false},
      {token: 'USDC', symbol: 'USDC', decimals: USDC_EVM_DECIMALS, minFractionDigits: 2, chainId: 42161,
        address: USDC_TOKEN[42161]!.address, liquidity: null, onramp: 'Partner', offramp: 'Partner', testnet: false},
    ],
  },
  {
    protocol: 'evm', name: 'Ethereum', environment: 'mainnet',
    assets: [
      {token: 'ZCHF', symbol: 'ZCHF', decimals: ZCHF_DECIMALS, minFractionDigits: 2, chainId: 1,
        address: ZCHF_TOKEN[1]!.address, liquidity: null, onramp: 'Partner', offramp: 'Partner', testnet: false},
      {token: 'USDC', symbol: 'USDC', decimals: USDC_EVM_DECIMALS, minFractionDigits: 2, chainId: 1,
        address: USDC_TOKEN[1]!.address, liquidity: null, onramp: 'Partner', offramp: 'Partner', testnet: false},
    ],
  },
  {protocol: 'evm', name: 'Arbitrum Sepolia', environment: 'testnet', assets: []},
];
// Fetch the catalog from the relay, caching to AsyncStorage. Best-effort: on any failure (offline,
// timeout, bad JSON, legacy/invalid envelope) returns `prior` (the cache or bundled default) so the
// UI never blocks on it. Timeout-bound like every other fetch. The cache stores the WIRE ENVELOPE
// (`{"networks":[…]}`) byte-for-byte as received-and-validated, so the cache read replays through
// the SAME `parseNetworkCatalog` the live response does — one envelope shape on the wire and in the
// cache, `NetworkSection[]` in memory.
export async function fetchCurrencies(relayUrl: string, prior: NetworkSection[]): Promise<NetworkSection[]> {
  try {
    const r = await relayFetch(relayUrl, '/api/v1/currencies', undefined, BALANCE_TIMEOUT_MS);
    if (!r.ok) return prior;
    const j = await r.json();
    const networks = parseNetworkCatalog(j);
    if (!networks) return prior;
    AsyncStorage.setItem(catalogCacheKey(relayUrl), JSON.stringify({networks})).catch((e: unknown) => { console.warn('catalog cache persist failed: ', e); });
    return networks;
  } catch { return prior; }
}

// Per-minter-family display config. MC1 unit 5 DOWNSIZED the FAMILY-LEVEL constants to the
// cosmetic leftovers (block time, address placeholder, offramp floor) — the per-currency facts
// (`networkLabel`/`nativeAsset`/`amountDecimals`) are now SOURCED FROM THE PER-CURRENCY DESCRIPTOR
// inside `familyDisplay()` (network→descriptor.network, nativeAsset→descriptor.backing_symbol,
// amountDecimals→descriptor.display_decimals ?? descriptor.decimals). So a future ckUSDT renders as
// itself, not "USDC". Adding a new FAMILY (a new ramp dispatch shape, e.g. CkSol) = one entry;
// adding a new TOKEN of an existing family (another ckERC20) needs NO entry — it reads its facts
// from its descriptor. The type keeps the same field names so the sheet consumers compile
// unchanged; only the VALUES are now descriptor-driven (single source of truth).
export type FamilyDisplay = {
  networkLabel: string;       // chain name (descriptor.network, family-default fallback)
  nativeAsset: string;        // backing asset unit (descriptor.backing_symbol, family-default fallback)
  amountDecimals: number;     // amount precision (descriptor.display_decimals ?? descriptor.decimals ?? family default)
  blockMin: number;           // avg native-chain block time (min) → est. time-to-credit (family cosmetic)
  withdrawMinRaw: number;     // raw smallest-unit floor for offramp (family minter constant)
  addressPlaceholder: string; // native-chain address placeholder ('bc1q…' / '0x…')
};
// Family-level COSMETIC leftovers only — per-currency facts are injected from the descriptor below.
const FD_CKBTC: FamilyDisplay = {
  networkLabel: 'Bitcoin', nativeAsset: 'BTC', amountDecimals: 8, blockMin: 10,
  withdrawMinRaw: 50_000, addressPlaceholder: 'bc1q…',
};
// ckERC-20 (ckUSDC etc.): the onramp is a wallet-connect contract-call flow (NOT a per-principal
// address) — see CkErc20DepositSheet. These are the family-defaults; the descriptor overrides the
// name/symbol/decimals so a future ckUSDT no longer inherits USDC's facts.
const FD_CKETH_ERC20: FamilyDisplay = {
  networkLabel: 'Ethereum', nativeAsset: 'USDC', amountDecimals: 6, blockMin: 1,
  withdrawMinRaw: 0, addressPlaceholder: '0x…',
};
// Native ETH within the CkEthErc20 family — discriminated by `token_contract == null`. The facade's
// `withdraw` dispatches this as `withdraw_eth` (burn ckETH → send native ETH); the deposit is a single
// payable `depositEth` tx to the shared helper (see cketh.ts). 18-decimal Wei amounts. The
// `withdrawMinRaw` floor mirrors the live ckETH minter's governed `minimum_withdrawal_amount`
// (sv3dd-oaaaa… / jzenf- Sepolia; see cketh-minter.did) = 0.01 ETH (1e16 Wei), confirmed live. The
// minter returns AmountTooLow below it; matching it here stops the user from signing an entry the
// minter will reject. NOTE it EXCEEDS Number.MAX_SAFE_INTEGER (1e16 > 9.007e15) — unlike the BTC
// floor — so it survives here only because 1e16 happens to be exactly representable as a double AND
// every consumer stringifies it (`String(withdrawMinRaw)` into cmpRaw/fmtAsset) rather than doing
// arithmetic on it. Do arithmetic on this and it silently loses precision; make it a string first.
const FD_CKETH_NATIVE: FamilyDisplay = {
  networkLabel: 'Ethereum', nativeAsset: 'ETH', amountDecimals: 18, blockMin: 1,
  withdrawMinRaw: 10_000_000_000_000_000, addressPlaceholder: '0x…',
};
const FAMILY_DISPLAY: Partial<Record<MinterFamily, FamilyDisplay>> = {CkBtcUtxo: FD_CKBTC, CkEthErc20: FD_CKETH_ERC20};
// Resolve a currency's family display from the catalog. MC1 unit 6 — FAIL-CLOSED: an unknown family
// (e.g. CkSol) or a no-minter ICRC currency returns `null` instead of silently falling back to the
// ckBTC config. Per CLAUDE.md dpay never swaps, so a wrong-currency render (a SOL asset labelled
// "BTC") is a non-custodial-trust violation, not a cosmetic glitch. Every caller MUST branch on
// `null` → explicit "Unsupported" UI (the type system enforces this; no `!`/`any`). NOTE: this is
// RAMP-family display/dispatch config only — DIRECT payability of a complete no-minter row (VCHF/
// ICP, 2026-08-28) is decided by `isPayableAsset`, never here.
//
// MC1 unit 5: the per-currency facts (networkLabel/nativeAsset/amountDecimals) are sourced FROM
// THE DESCRIPTOR when present (authoritative single source of truth), with the family-default as a
// fallback for a legacy descriptor that predates unit 5. NOTE: DEMO (currency 0) has minter_family
// null → returns null here, but its display never depended on this — the helpers early-return for 0.
export function familyDisplay(catalog: CurrencyDescriptor[], currency: number): FamilyDisplay | null {
  const a = catalog.find(c => c.currency === currency);
  const f = a?.minter_family ?? null;
  if (!f) return null;
  const mapped = FAMILY_DISPLAY[f];
  if (!mapped) return null;
  // CkEthErc20 branches by `token_contract`: null = native ETH (depositEth/withdraw_eth, 18-dec
  // Wei), Some = an ERC-20 token (depositErc20, the token's decimals). The discriminator is selected
  // BEFORE injecting descriptor overrides, so a native-ETH descriptor (backing_symbol='ETH',
  // decimals=18) still produces ETH-correct values rather than the ERC-20 family default.
  let base: FamilyDisplay = mapped;
  if (f === 'CkEthErc20' && a && a.token_contract == null) {
    base = FD_CKETH_NATIVE;
  }
  if (!a) return base;
  // Inject the authoritative per-currency facts from the descriptor (single source of truth).
  return {
    networkLabel: a.network ?? base.networkLabel,
    nativeAsset: a.backing_symbol ?? base.nativeAsset,
    amountDecimals: a.display_decimals ?? a.decimals ?? base.amountDecimals,
    blockMin: base.blockMin,
    withdrawMinRaw: base.withdrawMinRaw,
    addressPlaceholder: base.addressPlaceholder,
  };
}
// MC8 U1 — NFC asset disclosure resolver. The blind-tap bug: NfcTap.autoSign awaited the envelope
// signer and only set the amount disclosure AFTER the await, so during signing the
// payer saw a generic "Communicating…" with NO asset name / amount / network. This PURE resolver
// returns the honest asset name + network + asset-correct amount so the caller (autoSign) can set
// the disclosure state SYNCHRONOUSLY BEFORE the first await — React then renders
// "Paying 0.0005 BTC on Bitcoin" during the exchanging/awaitingApproval/settling window.
//
// Returns `null` when an honest disclosure is impossible (defense-in-depth): the caller declines the
// card and NEVER signs. This is a STRICTER gate than `isPayableAsset` — a payable asset whose amount
// cannot be formatted honestly (no decimals) or whose network cannot be resolved still gets declined,
// because signing it blind is worse than declining. DEMO (currency 0) always resolves (internal play
// money; `usd()` always formats; it has no external network → `networkLabel: null` is expected).
export type NfcDisclosure = {
  assetName: string;        // the honest asset NAME (BTC/USDC/DEMO) — never a raw ledger id
  networkLabel: string | null; // the native settlement network (Bitcoin/Ethereum); null for DEMO
  formattedAmount: string;  // asset-correct amount ("0.0005 BTC"), never the DEMO ∂ formatter
};
export function resolveNfcDisclosure(
  catalog: CurrencyDescriptor[],
  req: {currency: number; amount: string},
): NfcDisclosure | null {
  const {currency, amount} = req;
  // DEMO (currency 0): internal play money. No external network to disclose, but the amount is
  // always formattable via the DEMO ∂ formatter. DEMO is the one payable asset whose display never
  // depended on familyDisplay, so it gets an early return (mirrors every other display helper).
  if (currency === 0) {
    return {assetName: 'DEMO', networkLabel: null, formattedAmount: usd(amount)};
  }
  // Non-DEMO: resolve an honest asset NAME + NETWORK + asset-correct amount. If ANY leg cannot be
  // resolved honestly, return null so the caller declines (never blind-sign a real asset).
  const a = catalog.find(c => c.currency === currency);
  if (!a) return null; // unknown currency id
  const name = displayName(a);
  if (name === M.wallet.asset.unsupported) return null; // no honest name → decline
  const network = a.network ?? familyDisplay(catalog, currency)?.networkLabel ?? null;
  if (!network) return null; // no honest network → decline
  const formatted = fmtCurrencyAmountCompact(catalog, currency, amount);
  if (formatted === M.wallet.asset.unsupported) return null; // no honest amount → decline
  return {assetName: name, networkLabel: network, formattedAmount: formatted};
}

// --- direct-ICRC payability (VCHF/ICP, 2026-08-28) ------------------------------------------------
// A COMPLETE trusted ICRC descriptor is directly payable with NO minter: the payment rail signs an
// `icrc1_transfer` to the row's exact `ledger` principal, so every fact DIRECT payment needs is on
// the descriptor itself. "Complete" (ALL legs required — any missing leg fails closed):
//   • non-empty ledger principal text (the transfer destination)
//   • integer decimals within the u64 amount contract, 0..=MAX_DECIMALS (mirrors parseDecimalToUnits)
//   • non-empty wrapper_name + backing_symbol + network (honest identity + settlement label)
//   • raw fee parseable as an unsigned integer (the ledger's transfer fee, as a raw digit string)
//   • raw cap parseable as a POSITIVE unsigned integer (the per-currency payment-policy cap)
// Deliberately NOT inspected: mintable/minter/minter_family/onramp/offramp — ramps are FUNDING
// capabilities, not payment capabilities. familyDisplay is NOT consulted here either: it stays the
// ramp-family display/dispatch config and returns null for no-minter rows (never a fake
// minter_family).
const RAW_UINT_RE = /^\d+$/;
function isCompleteDirectIcrcRow(a: CurrencyDescriptor): boolean {
  if (!a.ledger || a.ledger.length === 0) return false;
  if (a.decimals == null || !Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > MAX_DECIMALS) return false;
  if (!a.wrapper_name || a.wrapper_name.length === 0) return false;
  if (!a.backing_symbol || a.backing_symbol.length === 0) return false;
  if (!a.network || a.network.length === 0) return false;
  if (a.fee == null || !RAW_UINT_RE.test(a.fee)) return false;
  if (a.cap == null || !RAW_UINT_RE.test(a.cap) || BigInt(a.cap) <= 0n) return false;
  return true;
}

// --- direct-ICRC receive address (2026-08-29 founder hard rule: every funding gate gives the
// user useful practical instructions — a "check back soon" dead end is a bug) ----------------------
// A complete no-minter direct-ICRC row (VCHF 7 / ICP 8) is RECEIVABLE by a plain icrc1_transfer
// from ANY Internet Computer wallet to the user's OWN account (owner = self-authenticating
// principal, default subaccount) on the row's ledger — the exact rail payments already use. This
// predicate gates the two surfaces that turn the zero-balance fund gate into real top-up
// instructions: the Receive tab's "My address" sub-mode and the Pay fund-first primary. Family
// rows keep their family sheets (a native BTC/ETH deposit is strictly more useful there); mintable
// rows never hit the fund gate (faucet); incomplete rows fail closed.
export function isDirectIcrcAsset(a: CurrencyDescriptor | null | undefined): boolean {
  return !!a && !a.mintable && a.minter == null && isCompleteDirectIcrcRow(a);
}

// --- HOW money gets in: the one deposit-mechanism switch ------------------------------------------
// The question every deposit surface answers is "what do I actually do to end up holding this",
// and it has exactly four answers in this wallet. They are NOT interchangeable, and the difference
// between two of them is money:
//
//   send-to-address    the sheet shows an address on the asset's OWN chain; sending the named token
//                      there credits the wallet (ckBTC shows a real Bitcoin address; a Solana row
//                      shows a Solana address).
//   icrc-transfer      the address shown is an INTERNET COMPUTER account. The chain to send from is
//                      the IC — never the chain the asset is backed by. `network` on a chain-key row
//                      names the BACKING chain ("Ethereum" for ckUSDC), so reading the send-from
//                      chain off that field points the sender at a chain this address cannot receive.
//   evm-wallet         there is NO address. The user's own EVM wallet signs `approve` +
//                      `depositErc20` against the minter's helper contract, and the gas is a
//                      SEPARATE holding of the chain's native coin. "Send it to the address on
//                      screen" is not a weaker instruction here, it is a wrong one.
//   evm-wallet-native  the same wallet-signed shape for the chain's own coin (ckETH): one payable
//                      `depositEth`, and the fee comes out of the same balance.
//
// ONE switch with TWO consumers — `ReceiveMode` picks the deposit sheet with it, and `FundingRoutes`
// writes the "don't have any yet?" instruction from it — so a surface and its instruction cannot
// drift apart. They did: the first funding-routes implementation inferred the mechanism from
// `network !== 'Internet Computer'` and therefore told a ckUSDC holder to buy USDC and send it to an
// address, on a screen showing an IC principal (`docs/specs/2026-09-09-funding-routes-plan.md`).
export type DepositMechanism = 'send-to-address' | 'icrc-transfer' | 'evm-wallet' | 'evm-wallet-native' | 'none';

/**
 * The deposit mechanism for one IC catalog row, from SERVER-DECLARED facts only (`mintable`,
 * `minter_family`, `token_contract`) — never from a chain name or a display label.
 *
 * `none` covers the two rows that have no deposit at all: the facade-minted practice dollar (its
 * money comes from a faucet, and offering to sell someone play money is a lie besides), and any
 * row too incomplete to instruct on — which fails closed rather than guessing a mechanism.
 *
 * Solana rows have no descriptor and are always `send-to-address`; that is a property of the rail,
 * asserted where the Solana surface builds its own instruction.
 */
export function depositMechanism(a: CurrencyDescriptor | null | undefined): DepositMechanism {
  if (!a) return 'none';
  if (a.mintable) return 'none';
  if (a.minter_family === 'CkBtcUtxo') return 'send-to-address';
  // The SAME rule Wallet's `depositNativeEth` uses to pick the sheet's branch: a null token
  // contract is the chain's own coin (ckETH), anything else is an ERC-20 (ckUSDC).
  if (a.minter_family === 'CkEthErc20') return a.token_contract == null ? 'evm-wallet-native' : 'evm-wallet';
  if (isDirectIcrcAsset(a)) return 'icrc-transfer';
  return 'none';
}

/**
 * The coin that pays the network fee for an `evm-wallet` deposit, as the catalog itself declares it:
 * the row's `gas_ledger` names the ledger the fee is charged on (ckUSDC's is the ckETH ledger), and
 * that row's backing symbol is the coin the user must actually be holding. Null when the asset IS
 * its own gas (`gas_ledger` unset — ckETH) or when the catalog cannot say, which the copy renders as
 * the self-funding variant rather than naming a coin this wallet cannot source.
 */
export function gasTokenOf(a: CurrencyDescriptor, catalog: CurrencyDescriptor[]): string | null {
  if (a.gas_ledger == null || a.gas_ledger.length === 0) return null;
  const gas = catalog.find(c => c.ledger === a.gas_ledger);
  return gas ? displayName(gas) : null;
}

// --- the reverse lookup: an ICRC ledger principal → its currency id -----------------------------
// Every accessor above indexes BY currency id, because that is the handle dpay's own wire carries.
// An EXTERNAL counterparty cannot: a third-party payment request names the ICRC LEDGER PRINCIPAL,
// because the canister is the asset's identity everywhere outside this wallet while the currency id
// means nothing off it. This helper is the one place that translation runs — so a caller never
// scatters its own `catalog.find(c => c.ledger === …)` and never grows a second matching rule.
//
// Comparison is EXACT-STRING against the canonical principal text form — the form the catalog
// carries and the form every IC tool prints. No trimming, no case folding, no normalisation: a
// string that differs is a DIFFERENT canister, and resolving it to a neighbouring asset would point
// a payment at the wrong ledger. Fail closed instead (mirrors familyDisplay/isPayableAsset): null
// means "this wallet has no such asset", and the caller must name that refusal rather than guess.
// An empty query never matches — a wire row with no ledger parses to `''` (parseIcpRow), so
// matching it would map "no ledger at all" onto a real currency.
export function ledgerToCurrency(catalog: CurrencyDescriptor[], ledger: string): number | null {
  if (ledger.length === 0) return null;
  const a = catalog.find(c => c.ledger === ledger);
  return a ? a.currency : null;
}

// MC5 — the "is this currency a PAYABLE asset" predicate. Used as the defense-in-depth gate BEFORE
// the payer signs: a request carrying an unknown/unsupported currency (a garbage/retired id) must
// NEVER reach the envelope signer (prepareTransfer). The ledger also rejects retired/unknown
// currencies, but the app should fail closed FIRST — never let the user Approve a sign for an
// unsupported asset.
//
// "Supported" ≠ "familyDisplay non-null": PAYMENT capability and RAMP capability are DISTINCT
// (2026-08-28, VCHF/ICP). A ramp family (CkBtcUtxo/CkEthErc20 — the ck assets) vouches for its rows:
// the bundled fallback rows legitimately carry null fee/cap metadata while the minter — not a raw
// descriptor fact — is the thing the app talks to. Symmetrically, a COMPLETE no-minter ICRC
// descriptor (VCHF currency 7 / ICP currency 8) is payable WITHOUT any minter: the app signs a
// plain icrc1_transfer against the row's own ledger. The predicate is the disjunction:
//   currency === 0 (DEMO always payable — the faucet funds it; its display never depended on
//                  familyDisplay, see MC1 unit 6)
//   || familyDisplay(catalog, currency) !== null (a known ramp family)
//   || isCompleteDirectIcrcRow(descriptor) (a complete trusted direct-ICRC row).
// mintable/minter/minter_family/onramp/offramp are deliberately NOT inspected for DIRECT payability
// (Unavailable ramps hide Add money / Cash out without hiding the asset or disabling Pay/Receive).
// Unknown ids (missing from the catalog) and malformed/incomplete rows fail closed — mirrors the
// fail-closed discipline of MC1 unit 6 (never a silent Bitcoin fallback).
export function isPayableAsset(catalog: CurrencyDescriptor[], currency: number): boolean {
  if (currency === 0) return true; // DEMO is always payable (the faucet funds it).
  const a = catalog.find(c => c.currency === currency);
  if (!a) return false; // unknown currency id ⇒ fail closed BEFORE signing.
  if (familyDisplay(catalog, currency) !== null) return true; // known ramp family ⇒ payable.
  return isCompleteDirectIcrcRow(a); // complete direct-ICRC row ⇒ payable; else fail closed.
}
// A stable ASCII key for an asset's testID (the catalog symbol may be a non-ASCII glyph like ₿).
// ckBTC keeps 'ckbtc' to honour the existing e2e testID contract; other assets use their wrapper
// name (MC1 unit 5 authoritative) or symbol. MC1 unit 6: an unknown family with no name returns the
// honest 'asset' key (never 'btc').
//
// TESTNET disambiguation: a testnet currency shares its backing_symbol/wrapper_name with a mainnet
// sibling (ckTESTBTC + ckBTC both render "BTC"; a Sepolia ckUSDC + mainnet ckUSDC both "USDC"). To
// keep the testID UNIQUE (the e2e net matches testID literally — a collision makes two rows
// indistinguishable + breaks `asset-add-<key>`), a testnet currency's key gets a `-testnet` suffix.
// Mainnet keys are UNCHANGED (the e2e testID contract for currencies 0/1/2 + the SOL bolt-on is
// preserved byte-for-byte).
export function assetTestKey(a: CurrencyDescriptor): string {
  let key: string;
  if (a.minter_family === 'CkBtcUtxo') key = 'ckbtc';
  else {
    const name = a.wrapper_name;
    if (name && name.length > 0) key = name.toLowerCase();
    else {
      const sym = a.symbol;
      if (sym && sym.length > 0) key = sym.toLowerCase();
      else key = 'asset';
    }
  }
  return isTestnetCurrency(a) ? `${key}-testnet` : key;
}

// --- testnet detection + labelling (single source of truth) ----------------------------------
// The production relay serves mainnet AND testnet chain-key currencies side-by-side: mainnet ckBTC
// (network "Bitcoin") next to ckTESTBTC (network "Bitcoin Testnet"), mainnet ckUSDC (network
// "Ethereum") next to ckSepoliaUSDC (network "Sepolia"). Catalog v2: classification is
// SERVER-DECLARED — the relay partitions IC rows into mainnet/testnet sections and the app stamps
// each descriptor's `testnet` field at parse time from its owning section's environment. The old
// client-side `MAINNET_NETWORKS` string-set inference is DELETED (the `network` field stays
// display-only); a field read is the whole check. Bundled fallback rows carry the field too.
export function isTestnetCurrency(a: CurrencyDescriptor): boolean {
  return a.testnet;
}
// The display NAME for a testnet currency: "<backing_symbol> testnet" → "BTC testnet" / "USDC
// testnet" / "ETH testnet". This is the founder-chosen label (not "ckTESTBTC" / "ckBTC" — those are
// indistinguishable duplicates of the mainnet row). Falls back to the wrapper name then "Testnet"
// when backing_symbol is absent, so a malformed descriptor still reads honestly.
export function testnetDisplayName(a: CurrencyDescriptor): string {
  const backing = a.backing_symbol;
  if (backing && backing.length > 0) return M.wallet.asset.testnetName(backing);
  const wrap = a.wrapper_name;
  if (wrap && wrap.length > 0) return M.wallet.asset.testnetName(wrap);
  return M.wallet.asset.testnet;
}
// Validate a native-chain destination address against its minter family's format. Catches the most
// common user error — pasting a wrong-chain address (e.g. an ETH 0x… into the BTC cash-out) — before
// the user signs. Does NOT verify the checksum (the minter does that at settle time): this is a
// prefix + charset + length sanity check, conservative (accepts valid-looking) not exhaustive.
export function isValidDestinationAddress(family: MinterFamily, addr: string): boolean {
  const a = addr.trim();
  if (a.length < 26) return false;
  if (family === 'CkBtcUtxo') {
    return /^(bc1[02-9ac-hj-np-z]{6,87}|[13][a-km-zA-HJ-NP-Z1-9]{24,})$/i.test(a);
  }
  if (family === 'CkEthErc20') {
    return /^0x[a-fA-F0-9]{40}$/.test(a);
  }
  return a.length > 0;
}

// The primary ASSET NAME shown as the heading on the asset card + picker rows (H1). MC1 unit 5:
// prefers the per-currency `backing_symbol` (authoritative) over the family-level assumption, so
// every CkEthErc20 no longer inherits "USDC" — a future ckUSDT renders as "USDT". DISTINCT from
// `currencySymbol` (the amount-prefix glyph: ∂/₿/$) and from `wrapper_name` (the IC token id like
// "ckUSDC"). So a user scanning for an asset sees its NAME (BTC/USDC/DEMO), not the chain it rides.
// The token that names this asset in a shared payment link (`?asset=`). It is the LEDGER token —
// `wrapper_name` when the row has one (ckBTC, ckUSDC, ckETH, ckTESTBTC, …), else the plain symbol
// (VCHF, ICP) — and NEVER the backing native symbol `displayName` returns: a link that said
// `asset=BTC` would be a lie, because native BTC cannot be sent to an IC principal. DEMO (currency
// 0) is named 'DEMO' (its symbol is the '$' glyph). Returns null for a row with no name that reads
// as a token (a bare glyph): such an asset simply cannot be named in a link — fail closed rather
// than invent a token for it.
const RE_LINK_TOKEN = /^[A-Za-z][A-Za-z0-9]*$/;
export function assetLinkToken(a: CurrencyDescriptor): string | null {
  if (a.currency === 0) return 'DEMO';
  const name = a.wrapper_name ?? a.symbol;
  return name != null && RE_LINK_TOKEN.test(name) ? name : null;
}

export function displayName(a: CurrencyDescriptor): string {
  if (a.currency === 0) return 'DEMO';
  // Authoritative per-currency backing symbol first (MC1 unit 5).
  const backing = a.backing_symbol;
  if (backing && backing.length > 0) return backing;
  // Legacy fallback for a descriptor that predates unit 5 (no backing_symbol registered): the
  // known families keep their old names so a stale catalog still renders correctly.
  if (a.minter_family === 'CkBtcUtxo') return 'BTC';
  if (a.minter_family === 'CkEthErc20') return 'USDC';
  // Future/unknown families: the catalog symbol when it reads as a name, else "Unsupported".
  // MC1 unit 6: NEVER fall back to the BTC native-asset unit for an unknown family.
  const sym = a.symbol;
  if (sym && sym.length >= 2) return sym;
  return M.wallet.asset.unsupported;
}

// The amount-prefix glyph for a currency (shown before a typed amount in Receive + as the prefix of
// a DEMO amount string). MC1 unit 5: a `$`-style stablecoin glyph is NOT assumed by family — only
// when the descriptor's backing_symbol/symbol indicates a USD-like asset. DEMO→'∂', BTC→'₿',
// USDC→'$'. VCHF/ICP (2026-08-28): a COMPLETE trusted direct-ICRC row renders its exact unit text
// ('VCHF'/'ICP'). Distinct from displayName (the NAME) and from the raw-amount unit suffix.
export function currencySymbol(catalog: CurrencyDescriptor[], currency: number): string {
  if (currency === 0) return '∂';
  const a = catalog.find(c => c.currency === currency);
  // A USDC/USD backing (or the legacy CkEthErc20 + USDC symbol) renders the $ glyph.
  const backing = a?.backing_symbol;
  if (backing && (backing === 'USDC' || backing === 'USD')) return '$';
  const fam = a?.minter_family ?? null;
  if (fam === 'CkBtcUtxo') return '₿';
  if (fam === 'CkEthErc20') {
    // Legacy descriptor without backing_symbol: the known ckUSDC stablecoin ⇒ '$'.
    if (a?.symbol === 'ckUSDC' || a?.symbol === '$') return '$';
  }
  const sym = a?.symbol;
  if (sym && sym.length <= 2) return sym;
  // VCHF/ICP (2026-08-28): a COMPLETE trusted direct-ICRC row renders its EXACT payment-unit text
  // (the descriptor's backing_symbol — 'VCHF'/'ICP'), not the ambiguous '?'. The unit is honest
  // catalog metadata (a short ASCII string the bundled fonts carry — never a franc glyph or a token
  // icon). Incomplete no-minter rows and unknown ids keep the '?' fallback.
  if (a && isCompleteDirectIcrcRow(a) && a.backing_symbol) return a.backing_symbol;
  // MC1 unit 6: unknown family → explicit "?" glyph, never the Bitcoin ₿ fallback.
  return '?';
}

// Format a raw smallest-units amount for display in its OWN currency's units. Currency 0 (DEMO_USD)
// renders as `∂`; any other currency renders via its catalog descriptor's decimals + the
// per-currency backing symbol (MC1 unit 5: `descriptor.backing_symbol` instead of a family-level
// nativeAsset assumption, so a future ckUSDT no longer renders "… USDC"). e.g. "50000" raw @
// currency 1 → "0.00050000 BTC". The EXACT, padded form — kept for the one place a formatted string
// must round-trip through the amount parser (an input fill, e.g. SendSheet's Max); every glanceable
// money surface uses `fmtCurrencyAmountCompact` instead (founder rule 2026-09-13). Per CLAUDE.md,
// dpay never swaps, so the display NEVER converts across assets.
// Decimals come from the catalog descriptor directly (display_decimals ?? decimals, NOT
// `familyDisplay`, which would mis-render DEMO_USD's 2). MC1 unit 6 — FAIL-CLOSED: an unknown family
// returns the explicit "Unsupported" sentinel instead of a wrong "… BTC" amount.
//
// MC1 units 2-4: `raw` is a raw-u64 decimal STRING (never `number`) — `fmtAsset` formats it via the
// exact BigInt parser (no precision loss above 2^53).
export function fmtCurrencyAmount(catalog: CurrencyDescriptor[], currency: number, raw: string): string {
  if (currency === 0) return usd(raw);
  const d = amountDisplayOf(catalog, currency);
  if (!d) return M.wallet.asset.unsupported;
  return fmtAsset(raw, d.decimals, d.unit, d.displayDecimals);
}

// The COMPACT sibling — same asset resolution, `fmtAssetCompact` instead of the exact formatter.
// The DEFAULT for every glanceable money surface (reviews, paid screens, history rows, receipts,
// fees, disclosures — founder rule 2026-09-13: best-effort rounded amounts everywhere the user just
// READS money); the exact `fmtCurrencyAmount` survives only where a string must round-trip through
// the amount parser (an input fill). See `fmtAssetCompact` for the trim/truncate/mark rules.
export function fmtCurrencyAmountCompact(
  catalog: CurrencyDescriptor[], currency: number, raw: string, sign = '',
): string {
  // DEMO (currency 0) is fixed-width ∂ play money at 2 decimals — its exact rendering already IS
  // its compact one, so delegate and keep the "currency 0 → usd()" rule in exactly one place. It
  // never carries a truncation marker, so its sign is a plain prefix.
  if (currency === 0) return `${sign}${fmtCurrencyAmount(catalog, currency, raw)}`;
  const d = amountDisplayOf(catalog, currency);
  if (!d) return M.wallet.asset.unsupported;
  return fmtAssetCompact(raw, d.decimals, d.unit, d.displayDecimals, d.minFractionDigits, sign);
}

// The ONE asset→display-facts resolution both formatters share (unit + the three precisions).
// Returns null when the asset cannot be rendered honestly — an unknown family with no
// backing_symbol, or a descriptor with no decimals — so both callers fail closed to "Unsupported"
// rather than printing a wrong "… BTC" amount (MC1 unit 6). Currency 0 (DEMO) never reaches here:
// both formatters early-return the `∂` formatter for it.
type AmountDisplay = {unit: string; decimals: number; displayDecimals: number; minFractionDigits: number};
function amountDisplayOf(catalog: CurrencyDescriptor[], currency: number): AmountDisplay | null {
  const a = catalog.find(c => c.currency === currency);
  // The display unit is the per-currency backing symbol (authoritative); fall back to the family's
  // cosmetic label only for a legacy descriptor without backing_symbol. An unknown family fail-closes.
  const unit = a?.backing_symbol ?? familyDisplay(catalog, currency)?.networkLabel;
  if (!unit) return null;
  const decimals = a?.decimals ?? null;
  if (decimals == null) return null;
  return {
    unit,
    decimals,
    displayDecimals: a?.display_decimals ?? decimals,
    minFractionDigits: a?.min_fraction_digits ?? 0,
  };
}
