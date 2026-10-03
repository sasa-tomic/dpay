// The EVM AMM venue table (2026-09-28, the any-pair mandate; widened 2026-10-03): the
// adapter-owned `evm_amm` rows — one per VENUE FAMILY per chain where the wallet's EVM
// catalog carries a token that trades there (today: ZCHF on Ethereum trades Uniswap V3
// AND CoW Swap; ZCHF on Arbitrum One trades Uniswap V3). Two venues on one pair is the
// founder's 2+venues-per-currency directive — no single venue is a point of failure.
//
// Why a separate table and NOT rows in BUNDLED_VENUES (the `evmConvert.ts` precedent, verbatim):
// the venue registry is drift-alarmed field-for-field against `dfx/catalog_truth.json`
// `venues[]` on both sides (app + relay), and these pairs are DERIVED, not registered —
// catalog chain_id + contract address are the per-asset ids the mandate names. The rows are
// registry-shaped so every venue surface — `venueOfId`, disclosure, attribution — serves them
// unchanged; the assignability pin in `config/venues.ts` is the one compile-time contract.
//
// PURE module (no imports, no react-native, no network): safe to static-import anywhere and
// to import from the generator scripts under plain node. Addresses are EIP-55-checksummed
// public, permanent facts; the Ethereum Uniswap set is D31-live-proven (funds/ledger.jsonl
// rows 183-186: QuoterV2 quote + SwapRouter02 swap settled on mainnet through the relay pipe).
//
// The rail ids: a venue pair names RAIL-CANONICAL ids, same vocabulary family as the
// registry's pair ids (IC ledger principals, SPL mints). An EVM token rail id is
// `evm:<chainId>:<lowercase address>`; the chain's native gas asset is
// `evm:native-eth:<chainId>`. Both are chain-qualified because ONE chain serves ONE ledger
// (the wrong-chain gate's own doctrine) — native ETH on Ethereum and native ETH on Arbitrum
// are different settle rails, so they get different ids. The older chain-1-only
// `ETH_NATIVE_RAIL_ID` (`evm:native-eth`, the SideShift settle id in `evmConvert.ts`) stays
// what that adapter owns; jest pins the chain-1 spelling equal to `evmNativeRailId(1)`.

/** SwapRouter02 — identical canonical address on Ethereum and Arbitrum One (D31-proven on 1). */
export const UNISWAP_V3_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

/** QuoterV2 — identical canonical address on Ethereum and Arbitrum One (D31-proven on 1). */
export const UNISWAP_V3_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

/** One chain's Uniswap V3 execution facts: the wrap target (WETH), the two Uniswap contracts,
 *  and the display name + native-gas symbol the fee/gas honesty copy renders. */
export interface EvmAmmChain {
  readonly id: number;
  readonly name: string;
  readonly weth: string;
  readonly router: string;
  readonly quoter: string;
  readonly nativeSymbol: string;
}

/** Canonical WETH9 per chain (they differ; the router and quoter do not). */
export const EVM_AMM_CHAINS: Readonly<Record<number, EvmAmmChain>> = {
  1: {
    id: 1,
    name: 'Ethereum',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    router: UNISWAP_V3_ROUTER,
    quoter: UNISWAP_V3_QUOTER,
    nativeSymbol: 'ETH',
  },
  42161: {
    id: 42161,
    name: 'Arbitrum One',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    router: UNISWAP_V3_ROUTER,
    quoter: UNISWAP_V3_QUOTER,
    nativeSymbol: 'ETH',
  },
};

/** The rail-canonical id for an EVM token: `evm:<chainId>:<lowercase address>`. */
export function evmAmmRailId(chainId: number, address: string): string {
  return `evm:${chainId}:${address.toLowerCase()}`;
}

/** The rail-canonical id for a chain's NATIVE gas asset: `evm:native-eth:<chainId>`. */
export function evmNativeRailId(chainId: number): string {
  return `evm:native-eth:${chainId}`;
}

// ── The CoW Swap facts (the SECOND EVM venue, 2026-10-03) ───────────────────────────────────

/** The v2 settlement contract — the venue row's `endpoint` (the contract identity the row
 *  names, the ic_amm endpoint convention) and the EIP-712 verifyingContract (evm/cowPlan). */
export const COWSWAP_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';

/** The venue families this table carries, keyed by the venue_id prefix (the registry's own
 *  naming convention, the cefiFamilyOf precedent). Null for a foreign id. The consumers
 *  dispatch on this: quote/prepare/execute branch per family, never per row. */
export function evmAmmFamilyOf(venueId: string): 'uniswapv3' | 'cowswap' | null {
  if (venueId === 'uniswapv3' || venueId.startsWith('uniswapv3-')) return 'uniswapv3';
  if (venueId === 'cowswap' || venueId.startsWith('cowswap-')) return 'cowswap';
  return null;
}

/** The Uniswap V3 rows + the CoW Swap row — derived from the chain table. `endpoint` is the
 *  venue's contract identity (the contract the phone signs against — the ic_amm endpoint
 *  convention: the contract, not an https base; CoW's row names the settlement contract,
 *  the orders themselves ride the relay's CoW pipes). `venue_id` follows the registry's
 *  pair-scoped naming convention (`icpswap-ckusdc`, `sideshift-eth`, …). */
export const EVM_AMM_VENUES = [
  {
    venue_id: 'uniswapv3-eth',
    display_name: 'Uniswap V3',
    kind: 'evm_amm',
    endpoint: UNISWAP_V3_ROUTER,
    pair_ledgers: [evmAmmRailId(1, '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB'), evmNativeRailId(1)],
    testnet: false,
    disclosure_key: 'uniswapv3',
  },
  {
    venue_id: 'uniswapv3-arb',
    display_name: 'Uniswap V3',
    kind: 'evm_amm',
    endpoint: UNISWAP_V3_ROUTER,
    pair_ledgers: [evmAmmRailId(42161, '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553'), evmNativeRailId(42161)],
    testnet: false,
    disclosure_key: 'uniswapv3',
  },
  {
    // The SECOND EVM venue (2026-10-03, the founder's 2+ venues per currency): ZCHF on
    // Ethereum trades CoW Swap too. EIP-712 signed off-chain orders, solver settlement in
    // seconds-to-minutes (gasless for the trader — the venue's own fee rides the quote),
    // the order polled by UID until fulfilled. Same pair as uniswapv3-eth: the user picks.
    // LIVE ORDER TRIP: UNPROVEN (the D31 follow-up; the V3 row earned its proof 2026-10-03).
    venue_id: 'cowswap-eth',
    display_name: 'CoW Swap',
    kind: 'evm_amm',
    endpoint: COWSWAP_SETTLEMENT,
    pair_ledgers: [evmAmmRailId(1, '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB'), evmNativeRailId(1)],
    testnet: false,
    disclosure_key: 'cowswap',
  },
] as const;

/** The chain a row trades on, from its venue_id suffix. Null for any other id. */
export function evmAmmChainOf(venueId: string): EvmAmmChain | null {
  if (venueId === 'uniswapv3-eth' || venueId === 'cowswap-eth') return EVM_AMM_CHAINS[1] ?? null;
  if (venueId === 'uniswapv3-arb') return EVM_AMM_CHAINS[42161] ?? null;
  return null;
}

// The DEV-CHAIN override (the `evm/chains.ts setEvmDevToken` precedent): the scratch anvil
// chain (31337) is not a mainnet venue, but the node-anvil tier pins the quote path ON it —
// the staging test installs mock contract addresses here. Empty in every prod build where
// nothing calls the setter; the pinned mainnet registry always wins for its own chains.
let devChainOverride: EvmAmmChain | null = null;

/** Install the dev-chain facts (node-anvil staging only). */
export function setEvmAmmChainOverride(chain: EvmAmmChain | null): void {
  devChainOverride = chain;
}

/** The execution facts for a chain id: the dev override wins, else the pinned table. */
export function evmAmmChainById(chainId: number): EvmAmmChain | null {
  return devChainOverride?.id === chainId ? devChainOverride : EVM_AMM_CHAINS[chainId] ?? null;
}

/** The evm_amm venues a rail id can trade through, in table order (the
 *  `evmNativeVenuesForLedger` analog over THIS table — the bundled registry is not consulted,
 *  it cannot carry these rows). Testnet rows are kept out, like every venue walk. */
export function evmAmmVenuesForRail(railId: string): readonly VenueRow[] {
  return EVM_AMM_VENUES.filter(
    v => v.kind === 'evm_amm' && !v.testnet && (v.pair_ledgers as readonly string[]).includes(railId),
  );
}

/** The row's own structural shape (kept in lockstep with `VenueEntry`; the consumer's
 *  assignability pin is the compile-time contract). */
export type VenueRow = (typeof EVM_AMM_VENUES)[number];
