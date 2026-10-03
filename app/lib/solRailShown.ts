// The SOL rail's SHOWN states — the offline-pending deduction (2026-09-15 founder requirement:
// an offline payment appears with its balance DEDUCTED) — extracted pure from Wallet so the
// derivation is pinned, not just wired (2026-10-01 audit F4: the Pay/Convert engines must read
// the SAME adjusted states the balances map renders; one screen, one truth).
//
// Two halves:
//   pendingSolDeduction - per-mint/per-native gross of the pending records whose hand-off
//                         POSTDATES the rail's last successful read (a poll that lands after
//                         the hand-off carries the transfer's effect authoritatively, so the
//                         optimistic subtraction retires exactly there). SOL records key by
//                         `assetId` ('solana:SOL' native, 'solana:<TOKEN>' through the
//                         registry); IC records (currency != null) never reach this rail.
//   applySolDeduction   - the deduction applied to whatever balance the poll (or the
//                         cross-restart cache) last established. STATUSES PASS THROUGH
//                         UNTOUCHED — 'absent'/'unavailable'/'error' are facts, not amounts;
//                         only numbers adjust (and never below zero — applyOffline clamps).
//
// PURE: no React, no network. `tokenInfoOf` is injected (the caller passes the registry's
// `solanaTokenInfo`) so this module stays free of config imports.

import {applyOffline} from './amount';

/** The shape of one pending outbox record this derivation reads (a structural slice of the
 *  store's PendingPay — the record key rides along so callers pass their rows untouched). */
export type PendingSolRecord = {
  /** The store's record key. */
  k: string;
  /** The asset that moved — 'solana:SOL' native, 'solana:<TOKEN>' for an SPL rail. */
  assetId: string;
  /** IC currency id when the record is NOT a SOL-rail record (those never deduct here). */
  currency: number | null;
  /** Hand-off instant (ms) — compared against the rail's last successful read. */
  ts: number;
  /** Gross (wire+fee) raw string; the wire when the fee was unknown — the account moves both. */
  gross?: string;
  wireAmount: string;
};

/** The deduction, total: zero when the rail has never been read (`solFreshAt === 0` — nothing
 *  has been established to subtract against), else Σ gross per native and per mint. */
export function pendingSolDeduction(
  pending: readonly PendingSolRecord[],
  solFreshAt: number,
  tokenInfoOf: (token: string) => {mint: string | null} | null,
): {sol: string; tokens: Record<string, string>} {
  if (solFreshAt === 0) return {sol: '0', tokens: {}};
  const out = {sol: '0', tokens: {} as Record<string, string>};
  for (const p of pending) {
    if (p.currency != null || !p.assetId.startsWith('solana:')) continue;
    if (p.ts <= solFreshAt) continue;
    const amt = p.gross ?? p.wireAmount;
    if (p.assetId === 'solana:SOL') {
      out.sol = (BigInt(out.sol) + BigInt(amt)).toString();
    } else {
      const mint = tokenInfoOf(p.assetId.slice('solana:'.length))?.mint;
      if (mint == null) continue; // unregistered symbol (no sign gate lets it happen; skip honestly)
      out.tokens[mint] = out.tokens[mint] != null ? (BigInt(out.tokens[mint]) + BigInt(amt)).toString() : amt;
    }
  }
  return out;
}

/** The SHOWN rail states: statuses verbatim, amounts net of the deduction. The SOL state's
 *  balance carries the native deduction; each mint's state its own. Generic over the caller's
 *  exact state shapes (the hook's narrow status unions pass through untouched). */
export function applySolDeduction<
  S extends {balance: string | null; status: string},
  T extends {amount: string | null; status: string},
>(
  solState: S,
  tokenStates: Record<string, T>,
  deduction: {sol: string; tokens: Record<string, string>},
): {sol: S; tokens: Record<string, T>} {
  const sol = {
    ...solState,
    balance: applyOffline(solState.balance, deduction.sol === '0' ? {} : {0: deduction.sol}, 0),
  };
  const dedup = Object.keys(deduction.tokens);
  if (dedup.length === 0) return {sol, tokens: tokenStates};
  const tokens: Record<string, T> = {...tokenStates};
  for (const mint of dedup) {
    const state = tokenStates[mint];
    if (state == null || state.amount == null) continue; // no number to deduct against
    tokens[mint] = {...state, amount: applyOffline(state.amount, {0: deduction.tokens[mint]}, 0) ?? state.amount};
  }
  return {sol, tokens};
}
