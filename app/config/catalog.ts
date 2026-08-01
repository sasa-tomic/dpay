import AsyncStorage from '@react-native-async-storage/async-storage';
import {base, fmtAsset, usd} from '../lib/format';

// --- currency catalog (M0) -------------------------------------------------------------------
// The wallet's runtime source of truth for which assets exist + how to display/fund them. Fetched
// from GET /api/v1/currencies (the canister's currencies() catalog), cached in AsyncStorage, with a
// bundled default fallback so the UI renders on a cold/offline first load. Closes issue #7: the
// ckBTC currency id is RESOLVED from the catalog (the CkBtcUtxo entry) instead of the old hardcoded
// `DEPOSIT_CURRENCY = 1`, so adding a currency is canister-config-only (no app redeploy).
export type MinterFamily = 'CkBtcUtxo' | 'CkEthErc20' | 'CkSol';
export type CurrencyDescriptor = {
  currency: number;          // the Currency u32 — read from the catalog, NEVER hardcoded
  ledger: string;            // ICRC ledger principal as text
  mintable: boolean;         // true for the demo currency the facade mints/burns
  minter: string | null;     // ramp (ck minter) principal as text, or null (no deposit/withdraw path)
  minter_family: MinterFamily | null;
  symbol: string | null;     // display symbol ("$", "₿", "Ξ")
  decimals: number | null;   // smallest-unit decimal count (USD=2, BTC=8)
};
export const CATALOG_CACHE_KEY = 'dpay.currencies.v1';
// Bundled fallback so a cold/offline first load still renders. Overwritten by the live catalog on
// the first successful fetch. Mirrors the canister's demo deployment (DEMO_USD + ckBTC). The ledger
// principals are empty here (the wallet reads currency/symbol/decimals/minter_family for display;
// the relay resolves ledgers server-side from the query's currency id).
export const BUNDLED_CATALOG: CurrencyDescriptor[] = [
  {currency: 0, ledger: '', mintable: true, minter: null, minter_family: null, symbol: '$', decimals: 2},
  {currency: 1, ledger: '', mintable: false, minter: 'mqygn-kiaaa-aaaar-qaadq-cai', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8},
  {currency: 2, ledger: 'xevnm-gaaaa-aaaar-qafnq-cai', mintable: false, minter: 'sv3dd-oaaaa-aaaar-qacoa-cai', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6},
];
// Fetch the catalog from the relay, caching to AsyncStorage. Best-effort: on any failure (offline,
// timeout, bad JSON) returns `prior` (the cache or bundled default) so the UI never blocks on it.
// Timeout-bound like every other fetch.
export async function fetchCurrencies(relayUrl: string, prior: CurrencyDescriptor[]): Promise<CurrencyDescriptor[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`${base(relayUrl)}/api/v1/currencies`, {signal: ctrl.signal});
    if (!r.ok) return prior;
    const j = await r.json();
    const list: unknown = j?.currencies;
    if (!Array.isArray(list) || list.length === 0) return prior;
    const clean: CurrencyDescriptor[] = list
      .filter((c: any): c is Record<string, unknown> => !!c && typeof c.currency === 'number')
      .map((c: any) => ({
        currency: c.currency as number,
        ledger: typeof c.ledger === 'string' ? c.ledger : '',
        mintable: !!c.mintable,
        minter: typeof c.minter === 'string' ? c.minter : null,
        minter_family: (typeof c.minter_family === 'string' ? c.minter_family : null) as MinterFamily | null,
        symbol: typeof c.symbol === 'string' ? c.symbol : null,
        decimals: typeof c.decimals === 'number' ? c.decimals : null,
      }));
    if (clean.length === 0) return prior;
    AsyncStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(clean)).catch(() => {});
    return clean;
  } catch { return prior; } finally { clearTimeout(t); }
}

// Per-minter-family display + rail config. Single-sources the old per-asset literals
// (DEPOSIT_NETWORK/DEPOSIT_ASSET/BTC_BLOCK_MIN/WITHDRAW_MIN_SATS): every asset of a given family
// shares the same native chain, so the chain/rail metadata lives HERE keyed by minter_family, not
// per-currency and not hardcoded inside the sheets. Adding a new family (e.g. CkEthErc20) = one entry.
export type FamilyDisplay = {
  networkLabel: string;       // chain name shown in instructions + the asset card label ('Bitcoin')
  nativeAsset: string;        // the asset the user sends on that chain; also the amount-unit suffix ('BTC')
  blockMin: number;           // avg native-chain block time (min) → est. time-to-credit
  withdrawMinRaw: number;     // raw smallest-unit floor for offramp (mirrors the minter's min)
  amountDecimals: number;     // decimal count for amount formatting (BTC=8)
  addressPlaceholder: string; // native-chain address placeholder ('bc1q…')
};
const FD_CKBTC: FamilyDisplay = {
  networkLabel: 'Bitcoin', nativeAsset: 'BTC', blockMin: 10,
  withdrawMinRaw: 50_000, amountDecimals: 8, addressPlaceholder: 'bc1q…',
};
// ckERC-20 (ckUSDC etc.): the onramp is a wallet-connect contract-call flow (NOT a per-principal
// address) — see CkErc20DepositSheet. These display fields still drive the asset card + amounts.
const FD_CKETH_ERC20: FamilyDisplay = {
  networkLabel: 'Ethereum', nativeAsset: 'USDC', blockMin: 1,
  withdrawMinRaw: 0, amountDecimals: 6, addressPlaceholder: '0x…',
};
const FAMILY_DISPLAY: Partial<Record<MinterFamily, FamilyDisplay>> = {CkBtcUtxo: FD_CKBTC, CkEthErc20: FD_CKETH_ERC20};
// Resolve a currency's family display from the catalog. MC1 unit 6 — FAIL-CLOSED: an unknown family
// (e.g. CkSol) or a no-minter ICRC currency returns `null` instead of silently falling back to the
// ckBTC config. Per CLAUDE.md dpay never swaps, so a wrong-currency render (a SOL asset labelled
// "BTC") is a non-custodial-trust violation, not a cosmetic glitch. Every caller MUST branch on
// `null` → explicit "Unsupported" UI (the type system enforces this; no `!`/`any` suppression).
// NOTE: DEMO (currency 0) also has minter_family null → returns null here, but its display never
// depended on this — displayName/currencySymbol/fmtCurrencyAmount early-return for currency 0.
export function familyDisplay(catalog: CurrencyDescriptor[], currency: number): FamilyDisplay | null {
  const f = catalog.find(c => c.currency === currency)?.minter_family ?? null;
  return f ? (FAMILY_DISPLAY[f] ?? null) : null;
}
// A stable ASCII key for an asset's testID (the catalog symbol may be a non-ASCII glyph like ₿).
// ckBTC keeps 'ckbtc' to honour the existing e2e testID contract; other assets use their symbol.
// MC1 unit 6: an unknown family with no symbol returns the honest 'asset' key (never 'btc').
export function assetTestKey(a: CurrencyDescriptor): string {
  if (a.minter_family === 'CkBtcUtxo') return 'ckbtc';
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

// The primary ASSET NAME shown as the heading on the asset card + picker rows (H1). Maps each
// currency/family to its friendly NAME, independent of the raw catalog `symbol` (the on-chain
// icrc1_symbol, which may be a unit glyph like '₿' or a 'ck'-prefixed token id like 'ckUSDC').
// DISTINCT from `currencySymbol` (the amount-prefix glyph: ∂/₿/$) and from `nativeAsset` (the
// backing token unit, used in raw-amount formatting + the "Send X on NETWORK" line). So a user
// scanning for an asset sees its NAME (BTC/USDC/DEMO), not the chain it rides on.
export function displayName(a: CurrencyDescriptor): string {
  if (a.currency === 0) return 'DEMO';
  if (a.minter_family === 'CkBtcUtxo') return 'BTC';
  if (a.minter_family === 'CkEthErc20') return 'USDC';
  // Future families: the catalog symbol when it reads as a name, else an explicit "Unsupported".
  // MC1 unit 6: NEVER fall back to the BTC native-asset unit for an unknown family.
  const sym = a.symbol;
  if (sym && sym.length >= 2) return sym;
  return 'Unsupported';
}

// The amount-prefix glyph for a currency (shown before a typed amount in Receive + as the prefix of
// a DEMO amount string). Family-driven so it is stable regardless of the raw catalog `symbol`:
// DEMO→'∂', BTC→'₿', USDC→'$'. ('$' was DEMO's old prefix; it moves to USDC now that DEMO uses ∂.)
// Distinct from displayName (the NAME) and nativeAsset (the raw-amount unit suffix).
export function currencySymbol(catalog: CurrencyDescriptor[], currency: number): string {
  if (currency === 0) return '∂';
  const a = catalog.find(c => c.currency === currency);
  const fam = a?.minter_family ?? null;
  if (fam === 'CkBtcUtxo') return '₿';
  if (fam === 'CkEthErc20') return '$';
  const sym = a?.symbol;
  if (sym && sym.length <= 2) return sym;
  // MC1 unit 6: unknown family → explicit "?" glyph, never the Bitcoin ₿ fallback.
  return '?';
}

// Format a raw smallest-units amount for display in its OWN currency's units. Currency 0 (DEMO_USD)
// renders as `∂`; any other currency renders via its catalog descriptor's decimals + the family's
// native asset unit (e.g. 50000 raw @ currency 1 → "0.00050000 BTC"). Used by ReceiveMode + PayMode
// so a ckBTC request/review reads "0.00050000 BTC" (never a misleading dollar amount) — the
// merchant-selected asset is what the payer sees + pays. Per CLAUDE.md, dpay never swaps, so the
// display NEVER converts across assets. Decimals come from the catalog descriptor directly (NOT
// `familyDisplay`, which would mis-render DEMO_USD's 2). MC1 unit 6 — FAIL-CLOSED: an unknown family
// returns the explicit "Unsupported" sentinel instead of a wrong "… BTC" amount.
export function fmtCurrencyAmount(catalog: CurrencyDescriptor[], currency: number, raw: number): string {
  if (currency === 0) return usd(raw);
  const a = catalog.find(c => c.currency === currency);
  const disp = familyDisplay(catalog, currency);
  if (!disp) return 'Unsupported';
  const decimals = a?.decimals ?? disp.amountDecimals;
  return fmtAsset(raw, decimals, disp.nativeAsset);
}
