// The Solana token registry — the pure, static table of the SPL tokens this wallet can hold.
// One row per token: its mainnet mint pubkey + on-chain decimals. Everything else in the app
// (catalog rows, asset enumeration, ATA derivation, balance display, the send/receive engines)
// resolves a token SYMBOL through this table (or through the catalog's solana section) — never
// through a scattered USDC literal. USDC's own constants still live in `spl.ts` for import
// stability, but they are re-exported FROM here so this file is the single source of truth.
//
// PURE module — no network, no config. Adding a token here + a catalog row is what makes a new
// SPL asset exist end-to-end (Stage 2 of the EUR dual-rail, 2026-09-06).

/** A registered Solana token. `mint: null` marks the native asset (SOL itself — no SPL mint). */
export type SolanaTokenInfo = {
  readonly mint: string | null;
  readonly decimals: number;
};

/** Native SOL — lamports, no mint. Kept here so token lookups answer for SOL too. */
export const SOL_TOKEN = 'SOL';
/** USDC (mainnet mint, 6 decimals — the value `spl.ts` has pinned since the golden vectors). */
export const USDC_TOKEN = 'USDC';
/** USDC mainnet mint. The devnet mint differs — config surfaces in a later unit; this is the default. */
export const USDC_MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** USDC has 6 decimals (1 USDC = 1_000_000 raw units). */
export const USDC_DECIMALS = 6;
/**
 * The WRAPPED-SOL mint (the SPL token account of native SOL). NOT a row in SOLANA_TOKENS — the
 * wallet holds native SOL, whose registry marker is `mint: null` — this address is ONLY the
 * stable string identifier a VENUE route (Jupiter and any later Solana aggregator) carries for
 * the native side of a pair: an AMM route names mints, and the mint it names for SOL is the
 * wrapped form. Pinned against `dfx/catalog_truth.json` venues[].pair_ledgers by
 * `catalog.test.ts` (the same drift alarm that pins the EURC mint).
 */
export const WRAPPED_SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
/** The token a venue mint identifier resolves to for the NATIVE side (wrapped SOL ⇒ SOL). */
export const WRAPPED_SOL_TOKEN = 'SOL';
/** EURC (Circle's euro stablecoin on Solana mainnet, 6 decimals — the EUR dual-rail's deep half). */
export const EURC_TOKEN = 'EURC';
/** EURC mainnet mint (pinned to `dfx/catalog_truth.json` `eurc_mint` — see `catalog.test.ts`). */
export const EURC_MINT_ADDRESS = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
/** EURC has 6 decimals (1 EURC = 1_000_000 raw units). */
export const EURC_DECIMALS = 6;

/** The registry. Frozen — a token joins by adding a row, not by special-casing call sites. */
export const SOLANA_TOKENS: Readonly<Record<string, SolanaTokenInfo>> = Object.freeze({
  [SOL_TOKEN]: Object.freeze({mint: null, decimals: 9}),
  [USDC_TOKEN]: Object.freeze({mint: USDC_MINT_ADDRESS, decimals: USDC_DECIMALS}),
  [EURC_TOKEN]: Object.freeze({mint: EURC_MINT_ADDRESS, decimals: EURC_DECIMALS}),
});

/** Registry lookup by token symbol (exact case). Null for an unknown token. */
export function solanaTokenInfo(token: string): SolanaTokenInfo | null {
  return Object.prototype.hasOwnProperty.call(SOLANA_TOKENS, token) ? SOLANA_TOKENS[token] : null;
}

/** Registry lookup by mint pubkey (exact case). Null for unknown mints; SOL matches `null`. */
export function solanaTokenOfMint(mint: string | null): string | null {
  for (const [token, info] of Object.entries(SOLANA_TOKENS)) {
    if (info.mint === mint) return token;
  }
  return null;
}
