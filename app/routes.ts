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
 * Wave 1 scope: hop = a CkEthErc20 row (ckUSDC-style burn-withdraw). Excludes ckETH
 * itself — its native-ETH withdraw_eth rail is a different leg shape, deliberately
 * not composed here (spec §9).
 */

import type {CurrencyDescriptor} from './config/catalog';
import {registeredVenues} from './config/venues';

/** The hop + burn legs one route adds on top of the venue's swap leg. `pool` is the
 *  swap canister (= the venue's endpoint). `burn` is the ckETH-minter triple the
 *  Withdraw flow uses: minter canister, gas ledger, and the gas token's own row for
 *  the preflight census. `dest` names what arrives where — the ERC-20 at its native
 *  network, symbol straight from the catalog row (backing_symbol first, per convention). */
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
    routes.push({
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
    });
  }
  return routes;
}
