import {fetchJupiterQuote, fetchJupiterSwapTx} from '../services/jupiter';
import {
  getSolNativeCredit,
  getSolTokenCredit,
  quoteSolMessageFee,
  submitRawSolTx,
} from '../solana';
import {deriveSolanaKeypair} from '../solana/identity';
import {deriveAta} from '../solana/spl';
import {
  bytesToHex,
  decodeVenueSwapTx,
  hexToBytes,
  signVenueSwapTx,
  verifyVenueSwapTxBeneficiaries,
} from '../solana/tx';
import {USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';
import {venueDisplayName, venueOfId} from '../config/venues';
import {saveTxNote} from '../services/txNotes';
import {type CctpMessageStatus} from '../cctp';
import {M} from '../i18n';
import {type ConvertRecord, type CrossRailInfo} from './types';
import {saveConvertRecord} from './records';
import {fetchCctpMessageStatus} from './cctp';
import {type SolanaExecutorOpts, watchSolTx} from './executeSolana';
// --- the cross-rail drivers (Routes B/C, 2026-09-16) -------------------------------------------------
//
// Everything past the five IC legs. The signing boundary is the design: the CCTP burn is
// the USER's own EVM wallet's transaction (dpay builds the calldata, renders it, and never
// holds an EVM key), so `awaiting_external` advances only on USER action (attach or
// decline); the mint watch keys on Circle's own status API by the burn hash and NEVER
// manufactures a failure (a stall stays a pending with the Circle/Etherscan links); and
// Route C's final Jupiter leg re-uses the wave-3a machine verbatim (fresh quote, verify
// beneficiaries, device signature) — only its payout reads key on the cross-rail facts.

export type CrossRailDeps = {
  secretHex: string;
  publicHex: string;
  onUpdate: (record: ConvertRecord) => void | Promise<void>;
};

export type CrossRailOpts = {
  /** How many status polls one drive performs before parking back on `crossing`. */
  watchAttempts?: number;
  watchIntervalMs?: number;
};

/** Drive the `crossing` phase: poll Circle's message status by the burn hash; when Circle
 *  says complete (the forward tx executed the Solana mint), corroborate the credit at the
 *  user's USDC ATA through the SOL rail before anything downstream is offered. A pending
 *  or attested-but-unminted message parks back on `crossing` — an attestation stall is a
 *  PENDING with links (the mission's rule: never a false failure). A transport error also
 *  parks: the engine re-arms at its cadence. */
export async function executeCrossRailConvert(
  start: ConvertRecord,
  deps: CrossRailDeps,
  opts: CrossRailOpts = {},
): Promise<ConvertRecord> {
  const watchAttempts = opts.watchAttempts ?? 1;
  const watchIntervalMs = opts.watchIntervalMs ?? 0;
  let rec = start;
  const cross = rec.crossRail;
  if (cross == null || rec.step !== 'crossing' || cross.burnTxHash == null) return rec;
  const advance = async (patch: Partial<ConvertRecord>, crossPatch?: Partial<CrossRailInfo>): Promise<ConvertRecord> => {
    rec = {...rec, ...patch, ...(crossPatch != null ? {crossRail: {...(rec.crossRail as CrossRailInfo), ...crossPatch}} : {})};
    await saveConvertRecord(deps.publicHex, rec);
    await deps.onUpdate(rec);
    return rec;
  };

  let status: CctpMessageStatus | null = null;
  for (let i = 0; i < watchAttempts; i++) {
    try {
      status = await fetchCctpMessageStatus(cross.burnTxHash);
    } catch {
      status = null; // transport-class: proves nothing either way — park, retry next cadence
    }
    if (status != null && status.state === 'complete') break;
    if (i < watchAttempts - 1 && watchIntervalMs > 0) await new Promise(r => setTimeout(r, watchIntervalMs));
  }
  if (status == null || status.state !== 'complete') {
    return rec; // still attesting/minting — the pending-with-links screen stays up
  }
  // Circle executed the destination mint. Corroborate through the SOL rail before the
  // record claims a credit: the forward tx's USDC token delta AT THE USER'S ATA.
  let credit: string | null = null;
  try {
    credit = await getSolTokenCredit(status.forwardTxHash, cross.solAddress, USDC_MINT_ADDRESS);
  } catch {
    credit = null;
  }
  if (credit == null) {
    // forwardTxHash present but the rail read did not corroborate YET — freeze the hash,
    // park on crossing, and let the next cadence retry the read. Never claim unverified.
    return advance({}, {forwardTxHash: status.forwardTxHash});
  }
  const planIdx = rec.legPlan?.findIndex(p => p.kind === 'cctp_burn') ?? -1;
  const legPlan = rec.legPlan?.map((p, i) => (i === planIdx ? {...p, state: 'confirmed' as const} : p));
  if (cross.kind === 'cctp') {
    // Route B terminal: USDC at the user's own ATA, verified. outAmountNet is the REALIZED
    // credit; outTx is Circle's forward signature (the durable Solana-side evidence).
    return advance({step: 'done', outAmountNet: credit, outTx: status.forwardTxHash, legPlan},
      {forwardTxHash: status.forwardTxHash, mintSubunits: credit});
  }
  // Route C: the swap offer unlocks — the user confirms the final leg on a FRESH quote.
  return advance({step: 'sol_ready', legPlan}, {forwardTxHash: status.forwardTxHash, mintSubunits: credit});
}

/** Build + verify + sign Route C's final Jupiter leg and move `sol_ready` → `swapping`.
 *  The wave-3a red lines verbatim: the venue row is a registered mainnet solana_amm; the
 *  fresh quote names the registry pair (USDC mint → the record's own out mint — wrapped
 *  SOL on the original Route C, any registered USDC-pair SPL token such as EURC on the
 *  generalized one); the venue's tx is decodable, fee-payer IS the user, and the proceeds
 *  land at the user's OWN destination — the fee payer for a native-SOL unwrap (no ATA
 *  needed), the user's own ATA for the out mint on an SPL out; the message fee is quoted
 *  honestly; the device signs. The input is the VERIFIED mint credit — never an estimate. */
export async function prepareCrossRailSolLeg(secretHex: string, rec: ConvertRecord, relayUrl: string): Promise<ConvertRecord> {
  const cross = rec.crossRail;
  if (cross == null || rec.step !== 'sol_ready' || cross.kind !== 'cctp_sol') {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  if (cross.mintSubunits == null || cross.solVenueId == null) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  const venue = venueOfId(cross.solVenueId);
  if (venue == null || venue.kind !== 'solana_amm' || venue.testnet) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // The record's own out mint (frozen at prepare): wrapped SOL unless the record names
  // an SPL token. The venue must actually serve the USDC→outMint pair — a record whose
  // venue stopped pairing it is refused, never re-routed.
  const outMint = cross.solOutMint ?? WRAPPED_SOL_MINT_ADDRESS;
  if (!venue.pair_ledgers.includes(USDC_MINT_ADDRESS) || !venue.pair_ledgers.includes(outMint)) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  const kp = deriveSolanaKeypair(secretHex);
  if (kp.address !== cross.solAddress) {
    // The derivation no longer matches the frozen recipient — refuse, never re-target.
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  const quoted = await fetchJupiterQuote(relayUrl, venue, USDC_MINT_ADDRESS, outMint, cross.mintSubunits, rec.slippageBps);
  if (!quoted.ok) {
    if (quoted.code === 'refused') throw new Error(M.convert.errors.quoteRefused(venue.display_name));
    throw new Error(M.convert.errors.quoteUnavailable(quoted.code));
  }
  const built = await fetchJupiterSwapTx(relayUrl, quoted.quote, kp.address);
  if (!built.ok) {
    if (built.code === 'refused') throw new Error(M.convert.errors.quoteRefused(venue.display_name));
    throw new Error(M.convert.errors.quoteUnavailable(built.code));
  }
  const decoded = decodeVenueSwapTx(built.swap.swapTransaction);
  if (decoded == null) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  // Output destination (the beneficiary red line, both shapes): a native-SOL unwrap lands
  // on the fee payer — no SPL destination to pin; an SPL out (e.g. EURC) MUST arrive at
  // the USER'S OWN ATA for the out mint — the device's address, the same rule the
  // standalone Solana swap applies. Anything else is refused before anything signs.
  const beneficiary = verifyVenueSwapTxBeneficiaries(decoded, {
    pubkey: kp.publicKey,
    outAta: outMint === WRAPPED_SOL_MINT_ADDRESS ? null : deriveAta(kp.address, outMint),
  });
  if (!beneficiary.ok) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  let solFeeLamports: string | undefined;
  try {
    const fee = await quoteSolMessageFee(decoded.message);
    if (fee != null) solFeeLamports = fee.toString(10);
  } catch {
    // offline/unreadable fee is not a refusal — the line stays absent
  }
  const signed = signVenueSwapTx(built.swap.swapTransaction, kp.seed);
  if (signed == null || signed.feePayer !== kp.address) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  const planIdx = rec.legPlan?.findIndex(p => p.kind === 'sol_swap') ?? -1;
  const legPlan = rec.legPlan?.map((p, i) => (i === planIdx ? {...p, state: 'sent' as const} : p));
  return {
    ...rec,
    step: 'swapping',
    legPlan,
    solanaLeg: {
      protocol: 'solana',
      signedTxHex: bytesToHex(signed.raw),
      signature: signed.signature,
      lastValidBlockHeight: built.swap.lastValidBlockHeight,
    },
    ...(solFeeLamports != null ? {solFeeLamports} : {}),
    crossRail: {
      ...cross,
      // The floor is frozen in the OUT ASSET's own units: lamports for native SOL (the
      // original field, byte-stable), the out mint's base subunits for an SPL token.
      ...(outMint === WRAPPED_SOL_MINT_ADDRESS
        ? {solExpectedLamports: quoted.quote.otherAmountThreshold}
        : {solExpectedSubunits: quoted.quote.otherAmountThreshold}),
    },
  };
}

/** Drive the cross-rail Jupiter leg (`swapping`/`settling`/its `stuck`): the wave-3a
 *  machine's exact transitions, with the payout reads keyed on the cross-rail facts —
 *  the realized credit is the fee payer's lamports delta for a native-SOL out, the
 *  out-mint token credit at the user's ATA for an SPL out (expected and realized both
 *  in the out mint's base units); the fallback floor is the leg's own signed min-out,
 *  NOT the record's IC-hop figures — different asset, different units. A refusal leaves
 *  the USDC(SOL) AT THE USER'S ATA — the failed copy names it and the exit (a standalone
 *  Solana convert, or holding the USDC). */
export async function executeCrossRailSolSwap(
  start: ConvertRecord,
  deps: CrossRailDeps,
  opts: SolanaExecutorOpts = {},
): Promise<ConvertRecord> {
  const submitAttempts = opts.submitAttempts ?? 2;
  const confirmAttempts = opts.confirmAttempts ?? 12;
  const intervalMs = opts.pollIntervalMs ?? 400;
  let rec = start;
  const leg = rec.solanaLeg;
  const cross = rec.crossRail;
  if (leg == null || cross == null) return rec;
  // The out asset (the record's own frozen mint): native SOL on the original Route C,
  // the SPL token (e.g. EURC) on the generalized one. Every payout read + floor
  // fallback below keys on it — expected vs realized compare in the SAME base units.
  const outMint = cross.solOutMint ?? WRAPPED_SOL_MINT_ADDRESS;
  const nativeOut = outMint === WRAPPED_SOL_MINT_ADDRESS;
  const advance = async (patch: Partial<ConvertRecord>): Promise<ConvertRecord> => {
    rec = {...rec, ...patch};
    await saveConvertRecord(deps.publicHex, rec);
    await deps.onUpdate(rec);
    return rec;
  };
  // The final leg's own plan entry follows the tx it represents: confirmed when the watch says
  // so (the leg list IS the progress UI — a done record with a 'Sent' tail would lie).
  const confirmSolLeg = (r: ConvertRecord): ConvertRecord => {
    if (r.legPlan == null) return r;
    const idx = r.legPlan.findIndex(l => l.kind === 'sol_swap');
    if (idx < 0 || r.legPlan[idx].state === 'confirmed') return r;
    const legPlan = r.legPlan.slice();
    legPlan[idx] = {...legPlan[idx], state: 'confirmed'};
    return {...r, legPlan};
  };
  const settle = async (): Promise<ConvertRecord> => {
    const outcome = await watchSolTx(leg, confirmAttempts, intervalMs);
    if (outcome.kind === 'confirmed') {
      const realized = await (nativeOut
        ? getSolNativeCredit(leg.signature)
        : getSolTokenCredit(leg.signature, cross.solAddress, outMint)
      ).catch(() => null);
      rec = confirmSolLeg(rec);
      return advance({
        step: 'done',
        outAmountNet: realized ?? (nativeOut ? cross.solExpectedLamports : cross.solExpectedSubunits) ?? '',
        outTx: leg.signature,
        ...(realized == null ? {failureDetail: 'payout-floor'} : {}),
      });
    }
    if (outcome.kind === 'failed') {
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    }
    if (outcome.kind === 'dead') {
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    }
    return advance({step: 'stuck', failureCode: 'unknown'});
  };
  if (rec.step === 'stuck') {
    const outcome = await watchSolTx(leg, 1, 0);
    if (outcome.kind === 'confirmed') {
      rec = await advance({step: 'settling'});
    } else if (outcome.kind === 'failed') {
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    } else if (outcome.kind === 'dead') {
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    } else {
      return rec;
    }
  }
  if (rec.step === 'swapping') {
    const raw = hexToBytes(leg.signedTxHex);
    if (raw == null) {
      return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'unreadable-signed-bytes'});
    }
    void saveTxNote(deps.publicHex, {k: leg.signature, who: venueDisplayName(cross.solVenueId ?? rec.venueId)}, Date.now());
    let submitted = false;
    let lastErr: unknown = null;
    for (let i = 0; i < submitAttempts && !submitted; i++) {
      try {
        const nodeSig = await submitRawSolTx(raw);
        submitted = nodeSig === leg.signature;
        if (!submitted) return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'signature-mismatch'});
      } catch (e) {
        lastErr = e;
        const probe = await watchSolTx(leg, 1, 0);
        if (probe.kind === 'confirmed') {
          submitted = true;
        } else if (probe.kind === 'failed') {
          return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: probe.detail});
        } else if (probe.kind === 'dead') {
          return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
        }
      }
    }
    if (!submitted) {
      if (lastErr != null) console.warn('cross-rail sol submit: no verdict after retries', lastErr);
      return advance({step: 'stuck', failureCode: 'unknown'});
    }
    rec = await advance({step: 'settling'});
  }
  if (rec.step === 'settling') {
    return settle();
  }
  return rec;
}
