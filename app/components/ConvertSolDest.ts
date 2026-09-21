// ConvertSolDest — the Solana surface's destination/mechanism resolution: registry walks and
// leg resolution only (no JSX). Extracted verbatim from ConvertMode.tsx (2026-09-21
// decomposition).
import type {CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {cefiOtherSide, cefiVenuesForLedger, solanaVenuesForMint, type VenueEntry} from '../config/venues';
import {SOLANA_TOKENS, WRAPPED_SOL_MINT_ADDRESS, WRAPPED_SOL_TOKEN} from '../solana/tokens';
import {M} from '../i18n';

// --- the SOLANA convert surface (multi-venue readiness V11, 2026-09-15) -------------------------
// The rail-local pair SOL ↔ USDC(Solana) through the registered solana_amm venue (Jupiter). The
// IC surface's rules carry over one-for-one: one venue today so no chooser chrome; quote fetched
// per keystroke DEVICE-DIRECT (no relay hop — keyless https, the opencryptopay shape), rendered
// VERBATIM (Jupiter's own outAmount/priceImpact/threshold digits, V8: no deriving, no blending);
// the pre-sign checklist names the venue + its https endpoint + the disclosure; nothing is
// preselected; the confirm re-quotes and shows a moved-quote review line before adopting a
// record. What differs is the execution shape: ONE venue-built transaction, signed by the
// device AFTER the beneficiary check (app/solana/tx.ts), submitted through the same Solana RPC
// proxy the SOL payment rail uses — the engine (convertResume) drives the record through
// swapping → settling → done; this component only renders it.

/** Mint → {symbol, decimals} for venue-pair mints: the wrapped-SOL identifier resolves to SOL
 *  itself (the registry's stable id for the native side), everything else reverse-looks-up the
 *  SPL registry. Null for unknown mints — the branch fails closed on it. */
export function solAssetOfMint(mint: string): {symbol: string; decimals: number} | null {
  if (mint === WRAPPED_SOL_MINT_ADDRESS) {
    return {symbol: WRAPPED_SOL_TOKEN, decimals: SOLANA_TOKENS.SOL.decimals};
  }
  const found = Object.entries(SOLANA_TOKENS).find(([, info]) => info.mint === mint);
  return found != null ? {symbol: found[0], decimals: found[1].decimals} : null;
}

/** Every registered out-destination for a SOL asset's input mint: the solana_amm registry rows
 *  that serve it, folded to the OTHER side of each pair and deduped by out mint, in REGISTRY
 *  ORDER (the registry's order is the display order — never sorted, never ranked). Null for a
 *  mint the SPL registry does not know; an empty `dests` for a mint no venue serves — both
 *  fail closed on the unavailable panel. */
/** One MECHANISM the Solana surface offers toward a destination: a solana_amm (Jupiter) pair,
 *  or — since 2026-09-20 (live-sweep defect 1, founder rule: every currency through the SAME
 *  surfaces) — a registered cefi venue whose pair carries this mint as the DEPOSIT side. A
 *  cefi mechanism's output lives on the IC rail: `outLedger` is the catalog ledger it settles. */
type SolDestMech =
  | {kind: 'amm'; venue: VenueEntry; outMint: string; outSym: string; outDecimals: number}
  | {kind: 'cefi'; venue: VenueEntry; outLedger: string; outSym: string; outDecimals: number};

/** One DESTINATION row (where the money LANDS) with its mechanisms — the IC-side D4 group
 *  shape mirrored: in-wallet SPL destinations keyed by mint, IC destinations keyed by the
 *  settling catalog ledger (two venues landing the same asset merge into ONE group). */
export type SolDestGroup = {key: string; testID: string; label: string; mechs: SolDestMech[]};

/** The e2e asset testKeys ('sol', 'sol-usdc', 'sol-eurc') — the dest-row testID contract,
 *  the same keys HomeAccounts/Ledger/AssetPicker pin (never derived from metadata). */
const solDestTestKey = (sym: string): string =>
  sym === WRAPPED_SOL_TOKEN ? 'sol' : `sol-${sym.toLowerCase()}`;

/** The venue sub-picker's key for one mechanism: the venue id for cefi (each venue is
 *  its own service), 'amm' for the in-wallet route (single-mech groups never show a
 *  picker). Module-level so every reader above its definition still hoists it. */
export function solMechKeyOf(m: SolDestMech): string {
  return m.kind === 'cefi' ? m.venue.venue_id : 'amm';
}

export function resolveSolDestinations(
  asset: Extract<SelectableAsset, {protocol: 'solana'}>,
  catalog: CurrencyDescriptor[],
): {inMint: string; groups: SolDestGroup[]} | null {
  // Native SOL is mint:null in the asset model but WRAPPED-sol in the venue registry — the two
  // identifiers for the same asset, translated here and only here.
  const inMint = asset.mint ?? WRAPPED_SOL_MINT_ADDRESS;
  if (solAssetOfMint(inMint) == null) return null;
  const groups: SolDestGroup[] = [];
  const byKey = new Map<string, SolDestGroup>();
  const push = (g: SolDestGroup): void => {
    groups.push(g);
    byKey.set(g.key, g);
  };
  for (const venue of solanaVenuesForMint(inMint)) {
    const outMint = venue.pair_ledgers.find(m => m !== inMint);
    if (outMint == null || byKey.has(outMint)) continue;
    const outTok = solAssetOfMint(outMint);
    if (outTok == null) continue;
    push({
      key: outMint,
      testID: `convert-sol-dest-${solDestTestKey(outTok.symbol)}`,
      label: M.convert.multihop.destDirect(outTok.symbol),
      mechs: [{kind: 'amm', venue, outMint, outSym: outTok.symbol, outDecimals: outTok.decimals}],
    });
  }
  // The CeFi half: registered cefi venues whose pair carries this mint as the deposit side —
  // the SAME rows the IC surface offers in the other direction, merged by landing spot. A
  // settle ledger the catalog doesn't know is registry/catalog drift: fail closed, no row.
  for (const venue of cefiVenuesForLedger(inMint)) {
    const outLedger = cefiOtherSide(venue, inMint);
    if (outLedger == null) continue;
    const row = catalog.find(c => c.ledger === outLedger);
    // The pricing gate's own red lines (same as resolveConvertDestinations): a settle side
    // without a catalog row or without decimals cannot be priced honestly — no row.
    if (row == null || row.decimals == null) continue;
    const outSym = row.backing_symbol ?? row.symbol ?? '';
    if (outSym === '') continue;
    const key = `ic:${outLedger}`;
    const mech: SolDestMech = {kind: 'cefi', venue, outLedger, outSym, outDecimals: row.decimals};
    const existing = byKey.get(key);
    if (existing != null) {
      existing.mechs.push(mech);
      continue;
    }
    push({
      key,
      testID: `convert-sol-dest-cefi-${venue.venue_id}`,
      label: M.convert.cefi.destRow(outSym, 'Internet Computer', venue.display_name),
      mechs: [mech],
    });
  }
  // A merged group (several venues on ONE landing spot — the trocador aggregator beside
  // sideshift since 2026-09-20) names the SPOT only; "via <venue>" moves to the mech
  // sub-picker rows. A label naming one venue would be a lie about a two-venue slot.
  for (const g of groups) {
    const first = g.mechs[0];
    if (g.mechs.length > 1 && first?.kind === 'cefi') {
      g.label = M.convert.cefi.destRowMulti(first.outSym, 'Internet Computer');
    }
  }
  return {inMint, groups};
}

/** The Solana analog of `resolveLegs`: the legs the SELECTED mechanism serves — an amm
 *  venue's other mint, or a cefi venue's settle ledger on the IC rail. Null when nothing is
 *  selected (zero destinations — the fail-closed panel renders). */
type SolLegs =
  | {kind: 'amm'; inMint: string; outMint: string; inSym: string; outSym: string; inDecimals: number; outDecimals: number}
  | {kind: 'cefi'; inMint: string; outLedger: string; inSym: string; outSym: string; inDecimals: number; outDecimals: number};

export function resolveSolLegs(
  asset: Extract<SelectableAsset, {protocol: 'solana'}>,
  mech: SolDestMech | null,
): SolLegs | null {
  const inMint = asset.mint ?? WRAPPED_SOL_MINT_ADDRESS;
  const inTok = solAssetOfMint(inMint);
  if (mech == null || inTok == null) return null;
  if (mech.kind === 'amm') {
    const outTok = solAssetOfMint(mech.outMint);
    if (outTok == null) return null;
    return {kind: 'amm', inMint, outMint: mech.outMint, inSym: inTok.symbol, outSym: outTok.symbol, inDecimals: inTok.decimals, outDecimals: outTok.decimals};
  }
  return {kind: 'cefi', inMint, outLedger: mech.outLedger, inSym: inTok.symbol, outSym: mech.outSym, inDecimals: inTok.decimals, outDecimals: mech.outDecimals};
}
