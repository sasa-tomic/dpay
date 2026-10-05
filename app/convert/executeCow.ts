// executeCow — the CoW Swap convert's driver (the second EVM venue, 2026-10-03). The engine
// calls it for every non-terminal EVM record whose venue is a `cowswap` family row — the
// executeEvm twin, with the venue's own lifecycle in place of the on-chain swap legs.
//
// The shape of the wait: the chain legs sign HERE at drive time (approve, plus the native-
// out unwrap after fulfillment), and the ORDER is re-signed deterministically from the
// record's frozen facts — identical bytes, so the venue's UID dedup and the derivable UID
// make every resume idempotent. Each milestone persists its durable identity the moment it
// exists (approveTxHash, uid), so a kill anywhere resumes from the recorded position:
//   gate refused            → failed_refunded ('gas_short')  — nothing signed, nothing moved;
//   approve reverted        → failed_refunded ('swap_refused') — the exact-amount allowance
//                             may have landed, named by the failure copy;
//   submit refused          → failed_refunded (the venue's own errorType) — an off-chain
//                             order never moves funds; the allowance is the only residue;
//   expired / cancelled     → failed_refunded (the venue's real cause) — same residue;
//   poll budget out         → unchanged (still settling) — the engine re-arms; the venue's
//                             own validTo is the honest clock, never a local timer.
//
// Phases, idempotent under every resume: (1) the approve + the submit — skipped per their
// own frozen identities; (2) the fulfillment freeze + the native-out unwrap — skipped once
// txHashes carries the unwrap; (3) the realized-credit read → the done line. A record may
// sit at `swapping` (pre-submit) or `settling` (submitted) and re-enter ANY phase; the
// frozen identities decide, never the step alone.
import {driveCowSequence, readEvmRailBalance, unwrapCowWeth} from '../evm';
import {venueOfId, venueDisplayName} from '../config/venues';
import {evmAmmChainOf, evmAmmFamilyOf} from '../config/evmAmm';
import {saveTxNote} from '../services/txNotes';
import {type ConvertRecord} from './types';
import {saveConvertRecord} from './records';

export type CowExecutorDeps = {
  publicHex: string; // the IC identity (store scope + annotations)
  secretHex: string; // the device key (the EVM rail's signing key, SLIP-10 m/44'/60'/…)
  relayUrl: string; // the active relay base — the CoW order API's pipes
  onUpdate: (record: ConvertRecord) => void | Promise<void>;
};

export type CowExecutorOpts = {
  payoutReads?: number;
  pollIntervalMs?: number;
};

/** The order facts the executor signs, re-derived from the record's frozen fields alone
 *  (amountIn IS the sellAmount — the modern order signs feeAmount '0'; buyAmount IS the
 *  signed floor minOut). */
function orderOf(leg: NonNullable<ConvertRecord['evmSwap']>, weth: string) {
  return {
    sellToken: leg.tokenIn,
    buyToken: leg.tokenOut === '' ? weth : leg.tokenOut,
    receiver: null,
    sellAmount: leg.amountIn,
    buyAmount: leg.minOut,
    validTo: leg.deadlineSecs,
    appData: leg.cow!.appData,
    feeAmount: '0',
  };
}

/** Drive a CoW-shaped record one state forward (or to its honest park). */
export async function executeCowConvert(
  start: ConvertRecord,
  deps: CowExecutorDeps,
  opts: CowExecutorOpts = {},
): Promise<ConvertRecord> {
  let leg = start.evmSwap;
  if (leg?.cow == null) return start; // not a CoW record — nothing to drive (dispatch prevents this)
  let rec = start;
  const advance = async (patch: Partial<ConvertRecord>): Promise<ConvertRecord> => {
    rec = {...rec, ...patch};
    if (rec.evmSwap != null) leg = rec.evmSwap;
    await saveConvertRecord(deps.publicHex, rec);
    await deps.onUpdate(rec);
    return rec;
  };

  if (rec.step !== 'swapping' && rec.step !== 'settling') return rec;

  const venue = venueOfId(leg.venueId);
  const chain = venue != null ? evmAmmChainOf(venue.venue_id) : null;
  if (venue == null || chain == null || evmAmmFamilyOf(venue.venue_id) !== 'cowswap') {
    return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'venue-unresolved'});
  }

  // ── Phase 1 + 2: the chain legs + the order, until the venue fulfills (or refuses) ──
  if (leg.cow.bought == null) {
    let outcome;
    try {
      outcome = await driveCowSequence(deps.secretHex, {
        chainId: leg.chainId,
        tokenIn: leg.tokenIn,
        weth: chain.weth,
        nativeOut: leg.tokenOut === '',
        order: orderOf(leg, chain.weth),
        uid: leg.cow.uid ?? null,
        approveTxHash: leg.cow.approveTxHash ?? null,
        relayUrl: deps.relayUrl,
      }, undefined, async (p) => {
        if (p.kind === 'approved') {
          await advance({evmSwap: {...rec.evmSwap!, cow: {...rec.evmSwap!.cow!, approveTxHash: p.txHash}}});
        } else if (p.kind === 'submitted') {
          // The submit answered: the record freezes the UID and sits at `settling` —
          // money in motion the surfaces can name ("waiting for the solvers").
          await advance({step: 'settling', evmSwap: {...rec.evmSwap!, cow: {...rec.evmSwap!.cow!, uid: p.uid}}});
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The rail being OFF (the seam's empty URL — a mount reset, an operator switch) is
      // not a verdict on the trade: the sweep re-arms and the drive retries once it is on.
      if (/EVM is not configured/.test(msg)) return rec;
      const gasGate = (e as {name?: string}).name === 'EvmGasGateError'
        || (e as {requiredWei?: string}).requiredWei != null;
      if (gasGate) {
        return advance({step: 'failed_refunded', failureCode: 'gas_short', failureDetail: msg.slice(0, 200)});
      }
      if (/no receipt/.test(msg)) {
        // A broadcast's receipt is the honest unknown: park stuck with the hash watchable
        // (a re-approve of the same exact amount would be harmless, but the hash is the
        // truth until its receipt reads — never re-broadcast on a guess).
        const hash = /0x[0-9a-fA-F]{64}/.exec(msg)?.[0] ?? '';
        return advance({step: 'stuck', failureCode: 'unknown', failureDetail: hash});
      }
      if (/reverted on-chain/.test(msg)) {
        return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: msg.slice(0, 160)});
      }
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: msg.slice(0, 200)});
    }
    if (outcome == null) return rec; // still open — the engine re-arms; nothing faked
    if (outcome.kind === 'terminal') {
      // The venue refused the order on its own clock: expired or cancelled. The order was
      // OFF-CHAIN — nothing left the wallet but the approve allowance (the copy names it).
      return advance({
        step: 'failed_refunded',
        failureCode: 'swap_refused',
        failureDetail: `cow order ${outcome.status.status}`,
      });
    }
    if (outcome.kind !== 'fulfilled') return rec;
    // Fulfilled: freeze the venue's realized figures before anything else runs.
    await advance({evmSwap: {...rec.evmSwap!, cow: {
      ...rec.evmSwap!.cow!,
      uid: rec.evmSwap!.cow!.uid ?? outcome.status.uid,
      ...(outcome.status.executedSellAmount != null ? {sold: outcome.status.executedSellAmount} : {}),
      ...(outcome.status.executedBuyAmount != null ? {bought: outcome.status.executedBuyAmount} : {}),
    }}});
  }

  // ── Phase 2b: the native-out unwrap (once per record, its hash the skip identity) ──
  if (leg.tokenOut === '' && (leg.txHashes ?? []).length === 0) {
    try {
      const bought = leg.cow.bought != null && /^\d+$/.test(leg.cow.bought)
        ? BigInt(leg.cow.bought)
        : BigInt(leg.minOut);
      const unwrapHash = await unwrapCowWeth(deps.secretHex, {chainId: leg.chainId, amount: bought});
      void saveTxNote(deps.publicHex, {k: unwrapHash.toLowerCase(), who: venueDisplayName(leg.venueId)}, Date.now());
      await advance({evmSwap: {...leg, txHashes: [unwrapHash]}});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no receipt/.test(msg)) {
        return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'cow unwrap: no receipt'});
      }
      if (/reverted on-chain/.test(msg)) {
        // The WETH credit SITS at the wallet (the unwrap failed, not the trade): the
        // failure names the honest exit — send/convert the WETH from its own account.
        return advance({step: 'failed_leg', failureCode: 'withdraw_refused', failureDetail: `cow unwrap reverted: WETH stays at your address (${msg.slice(0, 120)})`});
      }
      return advance({step: 'failed_leg', failureCode: 'unknown', failureDetail: `cow unwrap: ${msg.slice(0, 160)}`});
    }
  }
  if (leg.tokenOut !== '') {
    void saveTxNote(deps.publicHex, {k: (leg.cow.uid ?? '').toLowerCase(), who: venueDisplayName(leg.venueId)}, Date.now());
  }
  if (rec.step !== 'settling') {
    await advance({step: 'settling'});
  }

  // ── Phase 3: the realized OUT credit decides the done line ──
  const cur = rec.evmSwap!;
  const reads = opts.payoutReads ?? 4;
  const intervalMs = opts.pollIntervalMs ?? 500;
  for (let i = 0; i < reads; i++) {
    const after = await readEvmRailBalance(cur.chainId, deps.secretHex, cur.tokenOut === '' ? null : cur.tokenOut).catch(() => null);
    if (after != null) {
      const pre = cur.preOutRaw != null && /^\d+$/.test(cur.preOutRaw) ? BigInt(cur.preOutRaw) : null;
      const delta = pre != null && BigInt(after) >= pre ? (BigInt(after) - pre).toString() : null;
      // Honest end state: the measured delta when both reads exist, else the venue's own
      // executed buy figure, else the floor (a guarantee, never a guess).
      const executed = cur.cow?.bought != null && /^\d+$/.test(cur.cow.bought) ? cur.cow.bought : null;
      return advance({
        step: 'done',
        outAmountNet: delta ?? executed ?? rec.expectedNet,
        outTx: cur.cow?.uid ?? '',
        ...(delta == null ? {failureDetail: 'payout-venue-figure'} : {failureDetail: undefined}),
      });
    }
    if (i < reads - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  const executed2 = cur.cow?.bought != null && /^\d+$/.test(cur.cow.bought) ? cur.cow.bought : rec.expectedNet;
  return advance({step: 'done', outAmountNet: executed2, outTx: cur.cow?.uid ?? '', failureDetail: 'payout-venue-figure'});
}
