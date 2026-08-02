import AsyncStorage from '@react-native-async-storage/async-storage';
import {base, fmtAsset, usd} from '../lib/format';
import {BALANCE_TIMEOUT_MS} from './constants';

// --- currency catalog (M0 + MC1 unit 5 authoritative per-currency metadata) ------------------
// The wallet's runtime source of truth for which assets exist + how to display/fund them. Fetched
// from GET /api/v1/currencies (the canister's currencies() catalog), cached in AsyncStorage, with a
// bundled default fallback so the UI renders on a cold/offline first load. Closes issue #7: the
// ckBTC currency id is RESOLVED from the catalog (the CkBtcUtxo entry) instead of the old hardcoded
// `DEPOSIT_CURRENCY = 1`, so adding a currency is canister-config-only (no app redeploy).
//
// MC1 unit 5: every currency now carries AUTHORITATIVE per-currency metadata (backing symbol,
// wrapper name, network, decimals, fee, cap, chain id, token contract, per-direction ramp
// capability) — the canister is the single source of truth, the relay passes it through, the app
// caches it. This replaces the family-level assumptions that made every CkEthErc20 display as USDC
// and lets a future ckERC20 (e.g. ckUSDT) render as itself. The FROZEN wire format is untouched
// (this is catalog metadata, not wire bytes).
export type MinterFamily = 'CkBtcUtxo' | 'CkEthErc20' | 'CkSol';
// Per-direction ramp capability. Mirrors the canister's `RampCapability`. `Unavailable` ⇒ the UI
// shows NO button for that direction (no-swap honesty; ckUSDC offramp is `Unavailable` per Fork-C).
export type RampCapability = 'Direct' | 'Partner' | 'Unavailable';
export type CurrencyDescriptor = {
  currency: number;          // the Currency u32 — read from the catalog, NEVER hardcoded
  ledger: string;            // ICRC ledger principal as text
  mintable: boolean;         // true for the demo currency the facade mints/burns
  minter: string | null;     // ramp (ck minter) principal as text, or null (no deposit/withdraw path)
  minter_family: MinterFamily | null;
  symbol: string | null;     // display symbol ("$", "₿", "Ξ", "ckUSDC")
  decimals: number | null;   // smallest-unit decimal count (USD=2, BTC=8, USDC=6)
  // MC1 unit 5 — authoritative per-currency metadata:
  wrapper_name: string | null;     // IC wrapper token name ("ckBTC"/"ckUSDC")
  backing_symbol: string | null;   // backing native-chain asset symbol ("BTC"/"USDC"/"ETH")
  network: string | null;          // native settlement network name ("Bitcoin"/"Ethereum")
  display_decimals: number | null; // UI precision; default = `decimals` (full precision) when unset
  fee: string | null;              // ICRC ledger fee in RAW units (string for forward-compat; MC2 governs)
  cap: string | null;              // per-currency tx cap in RAW units (string for forward-compat; MC2 governs)
  chain_id: number | null;         // EVM chain id for ckERC20 (1=Ethereum mainnet)
  token_contract: string | null;   // ERC-20 contract address (0x…) for ckERC20 — per-token
  onramp: RampCapability;          // funding capability; Unavailable ⇒ no "Add money" button
  offramp: RampCapability;         // cash-out capability; Unavailable ⇒ no "Cash out" button
};
export const CATALOG_CACHE_KEY = 'dpay.currencies.v1';
// Bundled fallback so a cold/offline first load still renders. Overwritten by the live catalog on
// the first successful fetch. Mirrors the canister's demo deployment (DEMO_USD + ckBTC + ckUSDC).
// The ledger principals are empty here (the wallet reads currency/symbol/decimals/minter_family +
// the MC1 unit 5 per-currency metadata for display; the relay resolves ledgers server-side from the
// query's currency id). Ramp honesty (no-swap + Fork-C/O3): DEMO onramp=Direct(off)/offramp=Unavailable;
// ckBTC onramp=Direct/offramp=Direct; ckUSDC onramp=Direct/offramp=Unavailable (NO cash-out).
export const BUNDLED_CATALOG: CurrencyDescriptor[] = [
  {currency: 0, ledger: '', mintable: true, minter: null, minter_family: null, symbol: '$', decimals: 2,
    wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, fee: null, cap: null,
    chain_id: null, token_contract: null, onramp: 'Direct', offramp: 'Unavailable'},
  {currency: 1, ledger: '', mintable: false, minter: 'mqygn-kiaaa-aaaar-qaadq-cai', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8,
    wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8, fee: null, cap: null,
    chain_id: null, token_contract: null, onramp: 'Direct', offramp: 'Direct'},
  {currency: 2, ledger: 'xevnm-gaaaa-aaaar-qafnq-cai', mintable: false, minter: 'sv3dd-oaaaa-aaaar-qacoa-cai', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6,
    wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', display_decimals: 6, fee: '10000', cap: null,
    chain_id: 1, token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', onramp: 'Direct', offramp: 'Unavailable'},
];
// Fetch the catalog from the relay, caching to AsyncStorage. Best-effort: on any failure (offline,
// timeout, bad JSON) returns `prior` (the cache or bundled default) so the UI never blocks on it.
// Timeout-bound like every other fetch. Reads the MC1 unit 5 per-currency metadata fields from the
// relay JSON (forward-compatible: fee/cap carried as string for future exact-amount transport).
export async function fetchCurrencies(relayUrl: string, prior: CurrencyDescriptor[]): Promise<CurrencyDescriptor[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), BALANCE_TIMEOUT_MS);
  try {
    const r = await fetch(`${base(relayUrl)}/api/v1/currencies`, {signal: ctrl.signal});
    if (!r.ok) return prior;
    const j = await r.json();
    const list: unknown = j?.currencies;
    if (!Array.isArray(list) || list.length === 0) return prior;
    const clean: CurrencyDescriptor[] = list
      .filter((c: Record<string, unknown>): c is Record<string, unknown> => !!c && typeof c.currency === 'number')
      .map((c: Record<string, unknown>) => ({
        currency: c.currency as number,
        ledger: typeof c.ledger === 'string' ? c.ledger : '',
        mintable: !!c.mintable,
        minter: typeof c.minter === 'string' ? c.minter : null,
        minter_family: (typeof c.minter_family === 'string' ? c.minter_family : null) as MinterFamily | null,
        symbol: typeof c.symbol === 'string' ? c.symbol : null,
        decimals: typeof c.decimals === 'number' ? c.decimals : null,
        wrapper_name: typeof c.wrapper_name === 'string' ? c.wrapper_name : null,
        backing_symbol: typeof c.backing_symbol === 'string' ? c.backing_symbol : null,
        network: typeof c.network === 'string' ? c.network : null,
        display_decimals: typeof c.display_decimals === 'number' ? c.display_decimals : null,
        // fee/cap: accept number or string from the relay; carry as string (forward-compatible for
        // u64 values that exceed Number.MAX_SAFE_INTEGER once MC2 governs them).
        fee: c.fee == null ? null : String(c.fee),
        cap: c.cap == null ? null : String(c.cap),
        chain_id: typeof c.chain_id === 'number' ? c.chain_id : null,
        token_contract: typeof c.token_contract === 'string' ? c.token_contract : null,
        onramp: (typeof c.onramp === 'string' && (c.onramp === 'Direct' || c.onramp === 'Partner' || c.onramp === 'Unavailable') ? c.onramp : 'Unavailable') as RampCapability,
        offramp: (typeof c.offramp === 'string' && (c.offramp === 'Direct' || c.offramp === 'Partner' || c.offramp === 'Unavailable') ? c.offramp : 'Unavailable') as RampCapability,
      }));
    if (clean.length === 0) return prior;
    AsyncStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(clean)).catch(() => {});
    return clean;
  } catch { return prior; } finally { clearTimeout(t); }
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
const FAMILY_DISPLAY: Partial<Record<MinterFamily, FamilyDisplay>> = {CkBtcUtxo: FD_CKBTC, CkEthErc20: FD_CKETH_ERC20};
// Resolve a currency's family display from the catalog. MC1 unit 6 — FAIL-CLOSED: an unknown family
// (e.g. CkSol) or a no-minter ICRC currency returns `null` instead of silently falling back to the
// ckBTC config. Per CLAUDE.md dpay never swaps, so a wrong-currency render (a SOL asset labelled
// "BTC") is a non-custodial-trust violation, not a cosmetic glitch. Every caller MUST branch on
// `null` → explicit "Unsupported" UI (the type system enforces this; no `!`/`any`).
//
// MC1 unit 5: the per-currency facts (networkLabel/nativeAsset/amountDecimals) are sourced FROM
// THE DESCRIPTOR when present (authoritative single source of truth), with the family-default as a
// fallback for a legacy descriptor that predates unit 5. NOTE: DEMO (currency 0) has minter_family
// null → returns null here, but its display never depended on this — the helpers early-return for 0.
export function familyDisplay(catalog: CurrencyDescriptor[], currency: number): FamilyDisplay | null {
  const a = catalog.find(c => c.currency === currency);
  const f = a?.minter_family ?? null;
  if (!f) return null;
  const base = FAMILY_DISPLAY[f];
  if (!base) return null;
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
// MC8 U1 — NFC asset disclosure resolver. The blind-tap bug: NfcTap.autoSign fired
// `await signAuthorization` and only set the amount disclosure AFTER the await, so during signing the
// payer saw a generic "Communicating…" with NO asset name / amount / network. This PURE resolver
// returns the honest asset name + network + asset-correct amount so the caller (autoSign) can set
// the disclosure state SYNCHRONOUSLY BEFORE the first await — React then renders
// "Paying 0.00050000 BTC on Bitcoin" during the exchanging/awaitingApproval/settling window.
//
// Returns `null` when an honest disclosure is impossible (defense-in-depth): the caller declines the
// card and NEVER signs. This is a STRICTER gate than `isPayableAsset` — a payable asset whose amount
// cannot be formatted honestly (no decimals) or whose network cannot be resolved still gets declined,
// because signing it blind is worse than declining. DEMO (currency 0) always resolves (internal play
// money; `usd()` always formats; it has no external network → `networkLabel: null` is expected).
export type NfcDisclosure = {
  assetName: string;        // the honest asset NAME (BTC/USDC/DEMO) — never a raw ledger id
  networkLabel: string | null; // the native settlement network (Bitcoin/Ethereum); null for DEMO
  formattedAmount: string;  // asset-correct amount ("0.00050000 BTC"), never the DEMO ∂ formatter
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
  if (name === 'Unsupported') return null; // no honest name → decline
  const network = a.network ?? familyDisplay(catalog, currency)?.networkLabel ?? null;
  if (!network) return null; // no honest network → decline
  const formatted = fmtCurrencyAmount(catalog, currency, amount);
  if (formatted === 'Unsupported') return null; // no honest amount → decline
  return {assetName: name, networkLabel: network, formattedAmount: formatted};
}

// MC5 — the "is this currency a PAYABLE asset" predicate. Used as the defense-in-depth gate BEFORE
// the payer signs: a request carrying an unknown/unsupported currency (a garbage/retired id, or a
// CkSol-family currency with no ramp config) must NEVER reach signAuthorization. The canister also
// rejects retired/unknown currencies, but the app should fail closed FIRST — never let the user
// Approve a sign for an unsupported asset.
//
// "Supported" ≠ "familyDisplay non-null": DEMO (currency 0) has minter_family null → familyDisplay
// returns null, BUT DEMO IS payable (the faucet funds it; its display never depended on
// familyDisplay's BTC fallback — see MC1 unit 6). So the predicate is the disjunction:
//   currency === 0 (DEMO always payable) || familyDisplay(catalog, currency) !== null (known family).
// CkBtcUtxo + CkEthErc20 ⇒ payable; CkSol / missing-from-catalog / no-minter ICRC ⇒ NOT payable.
// Mirrors the fail-closed discipline of MC1 unit 6 (never a silent Bitcoin fallback).
export function isPayableAsset(catalog: CurrencyDescriptor[], currency: number): boolean {
  if (currency === 0) return true; // DEMO is always payable (the faucet funds it).
  return familyDisplay(catalog, currency) !== null; // known family ⇒ payable; else fail closed.
}
// A stable ASCII key for an asset's testID (the catalog symbol may be a non-ASCII glyph like ₿).
// ckBTC keeps 'ckbtc' to honour the existing e2e testID contract; other assets use their wrapper
// name (MC1 unit 5 authoritative) or symbol. MC1 unit 6: an unknown family with no name returns the
// honest 'asset' key (never 'btc').
export function assetTestKey(a: CurrencyDescriptor): string {
  if (a.minter_family === 'CkBtcUtxo') return 'ckbtc';
  const name = a.wrapper_name;
  if (name && name.length > 0) return name.toLowerCase();
  const sym = a.symbol;
  if (sym && sym.length > 0) return sym.toLowerCase();
  return 'asset';
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
  return 'Unsupported';
}

// The amount-prefix glyph for a currency (shown before a typed amount in Receive + as the prefix of
// a DEMO amount string). MC1 unit 5: a `$`-style stablecoin glyph is NOT assumed by family — only
// when the descriptor's backing_symbol/symbol indicates a USD-like asset. DEMO→'∂', BTC→'₿',
// USDC→'$'. Distinct from displayName (the NAME) and from the raw-amount unit suffix.
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
  // MC1 unit 6: unknown family → explicit "?" glyph, never the Bitcoin ₿ fallback.
  return '?';
}

// Format a raw smallest-units amount for display in its OWN currency's units. Currency 0 (DEMO_USD)
// renders as `∂`; any other currency renders via its catalog descriptor's decimals + the
// per-currency backing symbol (MC1 unit 5: `descriptor.backing_symbol` instead of a family-level
// nativeAsset assumption, so a future ckUSDT no longer renders "… USDC"). e.g. "50000" raw @
// currency 1 → "0.00050000 BTC". Used by ReceiveMode + PayMode so a ckBTC request/review reads
// "0.00050000 BTC" (never a misleading dollar amount) — the merchant-selected asset is what the
// payer sees + pays. Per CLAUDE.md, dpay never swaps, so the display NEVER converts across assets.
// Decimals come from the catalog descriptor directly (display_decimals ?? decimals, NOT
// `familyDisplay`, which would mis-render DEMO_USD's 2). MC1 unit 6 — FAIL-CLOSED: an unknown family
// returns the explicit "Unsupported" sentinel instead of a wrong "… BTC" amount.
//
// MC1 units 2-4: `raw` is a raw-u64 decimal STRING (never `number`) — `fmtAsset` formats it via the
// exact BigInt parser (no precision loss above 2^53).
export function fmtCurrencyAmount(catalog: CurrencyDescriptor[], currency: number, raw: string): string {
  if (currency === 0) return usd(raw);
  const a = catalog.find(c => c.currency === currency);
  // The display unit is the per-currency backing symbol (authoritative); fall back to the family's
  // cosmetic label only for a legacy descriptor without backing_symbol. An unknown family fail-closes.
  const unit = a?.backing_symbol ?? familyDisplay(catalog, currency)?.networkLabel;
  if (!unit) return 'Unsupported';
  const decimals = a?.display_decimals ?? a?.decimals ?? null;
  if (decimals == null) return 'Unsupported';
  return fmtAsset(raw, decimals, unit);
}
