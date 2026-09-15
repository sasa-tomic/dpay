/**
 * Route composition for multi-hop conversion
 * (docs/specs/2026-09-14-multihop-conversion-spec.md).
 *
 * A route is a pure composition of REGISTERED surfaces — never a new venue, never a
 * dpay-side intermediary: the swap hop is an ic_amm venue from the registry, and the
 * burn side is the ckETH-minter withdraw_erc20 machinery the standalone Withdraw flow
 * already runs (docs/specs/2026-07-30-ckusdc-onramp-offramp.md §3). Route A
 * (ICP → USDC on Ethereum) falls out of this walk the moment an ICP↔ckUSDC venue is
 * registered — nothing here hardcodes a route.
 *
 * Cross-rail routes (feasibility doc §Multi-step routes, B/C): when the hop is THE
 * canonical USDC row on Ethereum, Route B composes Circle's CCTP V2 burn (domain 5,
 * fast finality — infrastructure, not a venue, so no venue row) to the device's own
 * Solana address; Route C additionally composes a registered solana_amm venue pairing
 * USDC(SOL) with wrapped SOL. The EVM signing boundary holds: dpay builds the burn
 * calldata, the USER's own wallet signs it — dpay never holds EVM keys.
 */

import type {CurrencyDescriptor} from './config/catalog';
import {registeredVenues} from './config/venues';
import {CCTP_DOMAIN_SOLANA, CCTP_FINALITY_FAST, USDC_ERC20_ADDRESS} from './cctp';
import {
  USDC_MINT_ADDRESS,
  WRAPPED_SOL_MINT_ADDRESS,
  WRAPPED_SOL_TOKEN,
  solanaTokenInfo,
} from './solana/tokens';

/** The destination network name for CCTP domain 5 as routes and records carry it. */
export const CCTP_DESTINATION_NETWORK = 'Solana';

/** The Circle CCTP V2 burn leg appended after the five IC legs (Route B): an
 *  external-signature leg — the user's own EVM wallet signs approve + burnForBurn-
 *  style depositForBurnWithHook on the hop's token contract; dpay only renders the
 *  exact bytes and watches Circle's status API by the burn tx hash. Composition facts
 *  only — the live fee and calldata are fetched/built at handoff time, never frozen
 *  here. */
export type CctpBurnLeg = {
  tokenContract: string;
  destinationDomain: number;
  finalityThreshold: number;
};

/** The final Jupiter leg (Route C): USDC(SOL) → SOL at the device's own SOL address,
 *  device-signed exactly like the standalone Solana convert (wave 3a machinery). */
export type SolSwapLeg = {
  venueId: string;
  outMint: string;
  outSymbol: string;
  outDecimals: number;
};

export type CrossRail = {
  cctp: CctpBurnLeg;
  sol?: SolSwapLeg;
};

/** The hop + burn legs one route adds on top of the venue's swap leg. `pool` is the
 *  swap canister (= the venue's endpoint). `burn` is the ckETH-minter triple the
 *  Withdraw flow uses: minter canister, gas ledger, and the gas token's own row for
 *  the preflight census. `dest` names what arrives where — the ERC-20 at its native
 *  network, symbol straight from the catalog row (backing_symbol first, per convention).
 *  `crossRail`, when present, composes the CCTP(+Jupiter) legs beyond the EVM address. */
export type MultihopRoute = {
  routeId: string;
  swapVenueId: string;
  pool: string;
  from: {currency: number; ledger: string; symbol: string; decimals: number; fee: string};
  hop: {currency: number; ledger: string; symbol: string; decimals: number; fee: string};
  burn: {
    minter: string;
    gasLedger: string;
    gasCurrency: number;
    gasSymbol: string;
    gasDecimals: number;
    gasFee: string;
  };
  dest: {symbol: string; network: string};
  crossRail?: CrossRail;
};

function symbolOf(c: CurrencyDescriptor): string | null {
  return c.backing_symbol ?? c.symbol ?? null;
}

/** Every registered route from `fromCurrency` out to a self-custodial EVM address:
 *  a non-testnet ic_amm venue pairing the input ledger with a CkEthErc20 row that
 *  carries a minter + token contract + gas ledger. Fails closed on any missing
 *  number (fee/decimals/currency) — a route whose legs cannot be priced is not a
 *  route. Registry order, like every venue list (never ranked). */
export function multihopRoutesFrom(
  catalog: CurrencyDescriptor[],
  fromCurrency: number,
): MultihopRoute[] {
  const from = catalog.find(c => c.currency === fromCurrency);
  if (from == null || from.testnet) return [];
  if (from.ledger == null || from.fee == null || from.decimals == null) return [];
  const routes: MultihopRoute[] = [];
  for (const venue of registeredVenues()) {
    if (venue.kind !== 'ic_amm' || venue.testnet) continue;
    if (!venue.pair_ledgers.includes(from.ledger)) continue;
    const otherLedger = venue.pair_ledgers.find(l => l !== from.ledger);
    if (otherLedger == null) continue;
    const hop = catalog.find(c => c.ledger === otherLedger);
    if (hop == null || hop.testnet) continue;
    if (hop.minter_family !== 'CkEthErc20') continue;
    if (hop.minter == null || hop.token_contract == null || hop.gas_ledger == null) continue;
    if (hop.fee == null || hop.decimals == null) continue;
    const gas = catalog.find(c => c.ledger === hop.gas_ledger);
    if (gas == null || gas.fee == null || gas.decimals == null) continue;
    if (hop.network == null) continue;
    // A leg that cannot be NAMED (no symbol on any of the three rows) cannot be shown on
    // any screen this route renders — fail closed, like every other missing number.
    const fromSymbol = symbolOf(from);
    const hopSymbol = symbolOf(hop);
    const gasSymbol = symbolOf(gas);
    if (fromSymbol == null || hopSymbol == null || gasSymbol == null) continue;
    const base: MultihopRoute = {
      routeId: `multihop:${venue.venue_id}:${hop.currency}`,
      swapVenueId: venue.venue_id,
      pool: venue.endpoint,
      from: {
        currency: from.currency,
        ledger: from.ledger,
        symbol: fromSymbol,
        decimals: from.decimals,
        fee: from.fee,
      },
      hop: {
        currency: hop.currency,
        ledger: hop.ledger,
        symbol: hopSymbol,
        decimals: hop.decimals,
        fee: hop.fee,
      },
      burn: {
        minter: hop.minter,
        gasLedger: hop.gas_ledger,
        gasCurrency: gas.currency,
        gasSymbol,
        gasDecimals: gas.decimals,
        gasFee: gas.fee,
      },
      dest: {symbol: hopSymbol, network: hop.network},
    };
    routes.push(base);
    // Cross-rail composition (Routes B/C): only for THE canonical USDC row on Ethereum —
    // the CCTP builder is pinned to that one burn token + the Ethereum source domain, and
    // Circle's Solana destination mints canonical USDC only for it. CCTP is infrastructure,
    // not a venue: no venue row, the composition is keyed on the hop row's own facts.
    if (hop.token_contract === USDC_ERC20_ADDRESS && hop.network === 'Ethereum') {
      const cctp = {
        tokenContract: hop.token_contract,
        destinationDomain: CCTP_DOMAIN_SOLANA,
        finalityThreshold: CCTP_FINALITY_FAST,
      };
      // Route B: + CCTP burn → canonical USDC at the device's own Solana address.
      routes.push({
        ...base,
        routeId: `${base.routeId}:cctp`,
        crossRail: {cctp},
        dest: {symbol: hopSymbol, network: CCTP_DESTINATION_NETWORK},
      });
      // Route C: + a registered solana_amm venue pairing USDC(SOL) with wrapped SOL.
      // Registry order, like every venue walk; the out-symbol/decimals come from the
      // token registry the Solana rail already pins against the catalog truth.
      for (const solVenue of registeredVenues()) {
        if (solVenue.kind !== 'solana_amm' || solVenue.testnet) continue;
        if (!solVenue.pair_ledgers.includes(USDC_MINT_ADDRESS)) continue;
        const outMint = solVenue.pair_ledgers.find(m => m !== USDC_MINT_ADDRESS);
        if (outMint !== WRAPPED_SOL_MINT_ADDRESS) continue;
        const solToken = solanaTokenInfo(WRAPPED_SOL_TOKEN);
        if (solToken == null) continue; // no decimals on the registry token — fail closed
        routes.push({
          ...base,
          routeId: `${base.routeId}:cctp:${solVenue.venue_id}`,
          crossRail: {
            cctp,
            sol: {
              venueId: solVenue.venue_id,
              outMint,
              outSymbol: WRAPPED_SOL_TOKEN,
              outDecimals: solToken.decimals,
            },
          },
          dest: {symbol: WRAPPED_SOL_TOKEN, network: CCTP_DESTINATION_NETWORK},
        });
      }
    }
  }
  return routes;
}
