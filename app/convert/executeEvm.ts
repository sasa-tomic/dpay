// executeEvm — the EVM convert's driver (the any-pair mandate, 2026-09-28). The engine calls
// it for every non-terminal EVM record, exactly like the Solana driver.
//
// The legs are SIGNED HERE, at drive time, from the record's frozen facts (nonces move, so
// the EVM mirror of "identical bytes only" is: a broadcast hash is durable identity, watched
// to its receipt, never re-signed past a broadcast). The gate order is the executor's own
// (wrong-chain → fee probe → AGGREGATE gas gate → sign/broadcast/receipt per leg):
//   gate refused → failed_refunded ('gas_short') — nothing signed, nothing moved;
//   leg reverted → failed_refunded ('swap_refused') — the sequence stops dead; an approve
//                  that landed leaves an exact-amount allowance to the ROUTER, named by the
//                  failure copy (it can only ever pull what the swap would have pulled);
//   receipt never landed → stuck (honest unknown; the hashes stay watchable).
import {executeUniswapSequence, readEvmRailBalance} from '../evm';
import {venueOfId, venueDisplayName} from '../config/venues';
import {evmAmmChainOf} from '../config/evmAmm';
import {planTokenToNative, planTokenToToken} from '../evm/uniswapPlan';
import {saveTxNote} from '../services/txNotes';
import {type ConvertRecord} from './types';
import {saveConvertRecord} from './records';

export type EvmExecutorDeps = {
  publicHex: string; // the IC identity (store scope + annotations)
  secretHex: string; // the device key (the EVM rail's signing key, SLIP-10 m/44'/60'/…)
  onUpdate: (record: ConvertRecord) => void | Promise<void>;
};

export type EvmExecutorOpts = {
  /** Balance-read budget for the realized-credit line (the done figure). */
  payoutReads?: number;
  pollIntervalMs?: number;
};

/** Drive an EVM-shaped record one state forward (or to its honest park). */
export async function executeEvmConvert(
  start: ConvertRecord,
  deps: EvmExecutorDeps,
  opts: EvmExecutorOpts = {},
): Promise<ConvertRecord> {
  const leg = start.evmSwap;
  if (leg == null) return start; // not an EVM record — nothing to drive (hydration prevents this)
  let rec = start;
  const advance = async (patch: Partial<ConvertRecord>): Promise<ConvertRecord> => {
    rec = {...rec, ...patch};
    await saveConvertRecord(deps.publicHex, rec);
    await deps.onUpdate(rec);
    return rec;
  };

  if (rec.step !== 'swapping' && rec.step !== 'settling') return rec;

  if (rec.step === 'swapping') {
    const venue = venueOfId(leg.venueId);
    const chain = venue != null ? evmAmmChainOf(venue.venue_id) : null;
    if (venue == null || chain == null) {
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'venue-unresolved'});
    }
    const plan = leg.tokenOut === ''
      ? planTokenToNative({chain, tokenIn: leg.tokenIn, amountIn: BigInt(leg.amountIn), minOut: BigInt(leg.minOut), feeTier: leg.feeTier, deadlineSecs: BigInt(leg.deadlineSecs)})
      : planTokenToToken({chain, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut, amountIn: BigInt(leg.amountIn), minOut: BigInt(leg.minOut), feeTier: leg.feeTier, deadlineSecs: BigInt(leg.deadlineSecs)});
    const hashes = [...(leg.txHashes ?? [])];
    try {
      await executeUniswapSequence(deps.secretHex, {
        chainId: leg.chainId,
        plan,
      }, undefined, (step) => {
        hashes.push(step.txHash);
        // Durable identity per accepted leg, persisted immediately (the crash-safe watch keys).
        void advance({evmSwap: {...leg, txHashes: [...hashes]}});
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const gasGate = (e as {name?: string}).name === 'EvmGasGateError'
        || (e as {requiredWei?: string}).requiredWei != null;
      if (gasGate) {
        return advance({step: 'failed_refunded', failureCode: 'gas_short', failureDetail: msg.slice(0, 200)});
      }
      if (/no receipt/.test(msg)) {
        return advance({step: 'stuck', failureCode: 'unknown', failureDetail: hashes.join(',')});
      }
      if (/reverted on-chain/.test(msg)) {
        const partial = hashes.length > 1 ? `approve landed (exact-amount allowance to ${venueDisplayName(leg.venueId)}); ` : '';
        return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: `${partial}${msg.slice(0, 160)}`});
      }
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: msg.slice(0, 200)});
    }
    if (hashes.length > 0) {
      void saveTxNote(deps.publicHex, {k: hashes[hashes.length - 1]!.toLowerCase(), who: venueDisplayName(leg.venueId)}, Date.now());
    }
    rec = await advance({step: 'settling', evmSwap: {...leg, txHashes: [...hashes]}});
  }

  // settling: the receipts are in; the realized OUT credit decides the done line.
  const reads = opts.payoutReads ?? 4;
  const intervalMs = opts.pollIntervalMs ?? 500;
  for (let i = 0; i < reads; i++) {
    const after = await readEvmRailBalance(leg.chainId, deps.secretHex, leg.tokenOut === '' ? null : leg.tokenOut).catch(() => null);
    if (after != null) {
      const pre = leg.preOutRaw != null && /^\d+$/.test(leg.preOutRaw) ? BigInt(leg.preOutRaw) : null;
      const delta = pre != null && BigInt(after) >= pre ? (BigInt(after) - pre).toString() : null;
      // Honest end state: the measured delta when both reads exist, else the floor (a
      // guarantee, never a guess) — the Solana driver's payout rule, EVM twin.
      return advance({
        step: 'done',
        outAmountNet: delta ?? rec.expectedNet,
        outTx: (leg.txHashes ?? [])[leg.tokenOut === '' ? 1 : 0] ?? (leg.txHashes ?? []).slice(-1)[0] ?? '',
        ...(delta == null ? {failureDetail: 'payout-floor'} : {failureDetail: undefined}),
      });
    }
    if (i < reads - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return advance({step: 'done', outAmountNet: rec.expectedNet, outTx: (leg.txHashes ?? []).slice(-1)[0] ?? '', failureDetail: 'payout-floor'});
}
