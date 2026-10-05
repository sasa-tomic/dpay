/**
 * lib/postActionRepoll — the POST-ACTION RE-POLL WINDOW's pure half (founder 2026-10-05:
 * "Solana refresh => should be done also periodically and/or for some time after making payments
 * and after conversions").
 *
 * The wall-clock rules: after a payment sent on the Solana rail, or a conversion whose PAYOUT
 * lands on Solana (a cefi venue payout, a CCTP mint), the rail's balances + transactions re-poll
 * at a short cadence for a bounded window, then stop for good — an incoming payout surfaces
 * without the user pulling to refresh, and a window that ended stays ended. The timers live in
 * the one hook that already owns the recheck composition (hooks/useRecheckAll `armSolWindow`);
 * everything decidable without a clock lives here, so the law is pinnable in milliseconds:
 *   • WHICH actions earn a Solana window: the payout rail must be Solana — or UNKNOWN, because a
 *     bounded window is cheap and a silently-missed payout is not. A known IC or EVM payout is
 *     skipped: those rails' own polls already cover them (useBalancePoll 2.5s / useEvmBalances).
 *   • re-arming NEVER stacks and NEVER runs forever: the deadline is absolute and a re-arm keeps
 *     the LATER of the two ends. Ten actions in a minute hold one window, not ten.
 *
 * `convertRecordPayoutRail` reads only the persisted record's own facts — the shape fields first
 * (a `solanaLeg` swap, a `crossRail` CCTP block, an `evmSwap` block are unambiguous), then the
 * `outLedger` string's shape: a cefi record carries the Solana MINT for a SOL-rail payout
 * (config/swap.ts hands `quote.tokenOutLedger` the mint) and the ledger PRINCIPAL text for an IC
 * payout, and EVM payouts carry an `evm:`-prefixed rail id or an 0x address. The base58 alphabet
 * excludes `-` and `0x` prefixes cannot collide, so the discrimination is total on the shapes the
 * app persists — and anything else degrades to 'unknown', the safe side.
 */

/** Where a money action's payout lands, as far as the record can say. */
export type PayoutRail = 'solana' | 'ic' | 'evm' | 'unknown';

/** The record facts the derivation reads — a structural slice of `ConvertRecord` (this module
 *  stays pure; the union's own types live in convert/types.ts). `unknown` fields: presence is
 *  the fact, never their contents. */
export type PayoutRailFacts = {
  outLedger: string;
  solanaLeg?: unknown;
  crossRail?: unknown;
  evmSwap?: unknown;
};

/** The canonical base58 alphabet (Solana addresses/mints) — no `-`, no `0`, no `I`, no `O`. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** An IC principal in its canonical text form (lowercase base32-ish groups joined by dashes),
 *  or the bare 64-hex account spelling legacy rows carried. */
const PRINCIPAL_RE = /^[0-9a-z]+(-[0-9a-z]+)+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Which rail a conversion's PAYOUT lands on, from the record alone. Pure; total. */
export function convertRecordPayoutRail(rec: PayoutRailFacts): PayoutRail {
  // Shape fields first — a record carrying a Solana swap leg or a cross-rail (CCTP) block pays
  // out on Solana whatever its legacy outLedger string looks like; an EVM swap block pays on EVM.
  if (rec.solanaLeg != null) return 'solana';
  if (rec.crossRail != null) return 'solana'; // Routes B/C: the burn mints on the Solana side
  if (rec.evmSwap != null) return 'evm';
  const ledger = rec.outLedger;
  if (ledger.startsWith('evm:') || ledger.startsWith('0x')) return 'evm';
  if (PRINCIPAL_RE.test(ledger) || HEX64_RE.test(ledger)) return 'ic';
  if (BASE58_RE.test(ledger)) return 'solana';
  return 'unknown';
}

/** Should the Solana-side post-action window run for this payout rail? Solana — yes; UNKNOWN —
 *  yes (bounded, and a missed payout costs more than 36 bounded reads); a known IC or EVM
 *  payout — no, that rail's own periodic poll already covers it. */
export function repollWantedForPayoutRail(rail: PayoutRail): boolean {
  return rail === 'solana' || rail === 'unknown';
}

/** The absolute end of a window armed at `nowMs`. A re-arm inside a live window keeps the LATER
 *  end (extend, never shorten, never stack); a re-arm after it closed starts a fresh window. */
export function extendRepollDeadline(prevUntilMs: number, nowMs: number, windowMs: number): number {
  return Math.max(prevUntilMs, nowMs + windowMs);
}

/** Delay to the next window tick, or null when the window is over (the caller must not arm a
 *  timer it would have to ignore). At the window's edge the delay is whatever REMAINS, so the
 *  last tick fires exactly at the end — and not after it. */
export function nextRepollDelayMs(nowMs: number, untilMs: number, intervalMs: number): number | null {
  if (nowMs >= untilMs) return null;
  return Math.min(intervalMs, untilMs - nowMs);
}
