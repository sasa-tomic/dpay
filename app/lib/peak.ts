/**
 * peak.ts — the pure gate for the one-shot offline peak moment (Trip Ready J5, 2026-08-22).
 *
 * The FIRST truly-offline confirmed payment earns the campaign moment ("Roaming off. Payment
 * on."). This module owns ONLY the decision — presentation lives in OfflinePeak.tsx, awarding
 * lives in the paid surfaces (via journey.awardStamp, idempotent). Keeping the gate pure makes
 * the honesty contract jest-pinnable:
 *
 *   - 'online' NEVER qualifies — a payment the payer's own connection submitted is not the
 *     offline story, no matter how fresh the wallet is.
 *   - 'offlineQr' qualifies — the payer approved with no reachable gateway and handed off a
 *     signed envelope QR, later confirmed by reconcile (flows 20/21/59).
 *   - 'nfcMerchantSettled' qualifies — the NFC payer never submitted anything; the merchant's
 *     own connection settled the DPN2 bundle and returned the signed result (flow 87). The
 *     caller passes this path ONLY when the payer device was actually offline at the result.
 *   - A journey already carrying `firstOfflinePayment` NEVER re-qualifies — one shot, ever.
 *     Idempotence is structural: the stamp IS the "already celebrated" bit.
 */
import {JOURNEY_STAMPS, hasStamp, type Journey} from './journey';

/** The truth-labeled payment paths that can reach a confirmed Paid view. */
export type PeakPath = 'offlineQr' | 'nfcMerchantSettled' | 'online';

/**
 * Whether this confirmed payment should play the offline peak. Pure; call sites gate on the
 * outcome being CONFIRMED first (never pending/unknown — the hard honest-money rule) and pass
 * the truthful path for HOW it settled.
 */
export function shouldShowOfflinePeak(journey: Journey, path: PeakPath): boolean {
  if (path === 'online') return false;
  return !hasStamp(journey, JOURNEY_STAMPS.firstOfflinePayment);
}
