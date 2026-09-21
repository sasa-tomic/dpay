import {randNonceHex} from '../lib/format';
import {fetchJupiterSwapTx, type JupiterQuote} from '../services/jupiter';
import {
  getSolBlockHeight,
  getSolNativeCredit,
  getSolSignatureStatus,
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
import {WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';
import {venueDisplayName, venueOfId} from '../config/venues';
import {saveTxNote} from '../services/txNotes';
import {M} from '../i18n';
import {type ConvertRecord, type SolanaSwapLeg} from './types';
import {saveConvertRecord} from './records';
// --- the Solana driver (solana_amm venues — Jupiter, 2026-09-15) -----------------------------------
//
// The ONE record shape with a per-leg protocol discriminator (design decision, 2026-09-15): a
// Solana record is a ConvertRecord with `solanaLeg` set and `legs: []` — no canister/method/
// argHex theater over a tx that has none. Submission goes through the SAME RPC path SOL
// payments use (`app/solana.ts` seams over solanaRpcUrls(), which includes the relay's pure
// RPC proxy — never a bespoke convert submit), and the only authority on outcome is the
// chain's own signature status, read history-aware so a late confirmation is still found.

export type SolanaConvertPrepareArgs = {
  secretHex: string;
  /** The active relay — the swap-tx build dials it (services/jupiter, 2026-09-16). */
  relayUrl: string;
  quote: JupiterQuote; // the verbatim read piped through the relay (services/jupiter)
  inAsset: {symbol: string; mint: string; decimals: number}; // mint: WRAPPED form for native SOL
  outAsset: {symbol: string; mint: string; decimals: number};
};

/** Build + verify + sign the Solana swap and park the record at `swapping` (money has NOT
 *  moved — the only irreversible act so far was quoting). Red lines enforced BEFORE the
 *  signature: the venue row exists and is a mainnet solana_amm; the quote names the pair the
 *  registry says the venue trades; Jupiter's tx is decodable, requires EXACTLY the user's
 *  signature, pays fees from the USER's key, and — for an SPL output — routes the proceeds to
 *  the user's OWN ATA for that mint. Any violation fails closed with the IC prepare's own
 *  error vocabulary; nothing is signed, no record is written. */
export async function prepareSolanaConvertRecord(args: SolanaConvertPrepareArgs): Promise<ConvertRecord> {
  const {secretHex, relayUrl, quote, inAsset, outAsset} = args;
  // Red line 1: the venue row, from the registry — a stored/roaming venueId that names no row
  // (or a non-Solana row) never reaches https.
  const venue = venueOfId(quote.venueId);
  if (venue == null || venue.kind !== 'solana_amm' || venue.testnet) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // Red line 2: the quote's mints are the pair the REGISTRY says this venue trades (the
  // 'pool' check's mint analog — the venue may only execute what it is registered for).
  const pair = venue.pair_ledgers;
  if (
    quote.inputMint !== inAsset.mint || quote.outputMint !== outAsset.mint
    || !pair.includes(inAsset.mint) || !pair.includes(outAsset.mint)
    || inAsset.mint === outAsset.mint
  ) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  // Who the user is on this rail: the SOL key derived from the same device secret (SLIP-10).
  const kp = deriveSolanaKeypair(secretHex);
  const built = await fetchJupiterSwapTx(relayUrl, quote, kp.address);
  if (!built.ok) {
    if (built.code === 'refused') throw new Error(M.convert.errors.quoteRefused(venue.display_name));
    throw new Error(M.convert.errors.quoteUnavailable(built.code));
  }
  const decoded = decodeVenueSwapTx(built.swap.swapTransaction);
  if (decoded == null) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  // Red line 3 (the beneficiary check — INV-2's Solana analog): the user is the fee payer and
  // the output's destination is the user's OWN ATA (native-SOL output needs no ATA: unwrap
  // lands on the fee payer). Verified against the bytes in hand, before the signature.
  const outIsNativeSol = outAsset.mint === WRAPPED_SOL_MINT_ADDRESS;
  const outAta = outIsNativeSol ? null : deriveAta(kp.address, outAsset.mint);
  const beneficiary = verifyVenueSwapTxBeneficiaries(
    decoded,
    {pubkey: kp.publicKey, outAta},
  );
  if (!beneficiary.ok) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // The honest fee line, frozen now: the chain's own quote for THIS tx's message. Null (RPC
  // could not compute it) stays absent — no invented figure ever renders.
  let solFeeLamports: string | undefined;
  try {
    const fee = await quoteSolMessageFee(decoded.message);
    if (fee != null) solFeeLamports = fee.toString(10);
  } catch {
    // offline/unreadable fee is not a refusal — the swap can still run; the line just stays absent
  }
  // The signature — the ONLY irreversible-bytes act, over the venue's own message, by the user.
  const signed = signVenueSwapTx(built.swap.swapTransaction, kp.seed);
  if (signed == null || signed.feePayer !== kp.address) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  return {
    id: randNonceHex(),
    createdAtMs: Date.now(),
    step: 'swapping',
    venueId: venue.venue_id,
    // No numeric catalog currency on this shape — mints + symbols are the identifiers.
    inLedger: inAsset.mint,
    outLedger: outAsset.mint,
    inSymbol: inAsset.symbol,
    outSymbol: outAsset.symbol,
    inDecimals: inAsset.decimals,
    outDecimals: outAsset.decimals,
    amountIn: quote.inAmount,
    expectedGross: quote.outAmount, // the venue's estimate, verbatim
    expectedNet: quote.otherAmountThreshold, // the venue's OWN min-out floor for the chosen slippage
    inFee: '0',
    outFee: '0',
    slippageBps: quote.slippageBps,
    legs: [],
    solanaLeg: {
      protocol: 'solana',
      signedTxHex: bytesToHex(signed.raw),
      signature: signed.signature,
      lastValidBlockHeight: built.swap.lastValidBlockHeight,
    },
    ...(solFeeLamports != null ? {solFeeLamports} : {}),
  };
}

export type SolanaExecutorDeps = {
  publicHex: string; // the IC identity (store scope + annotations), same as the IC driver
  /** The user's SOL address — the owner filter for realized token-credit reads. */
  solAddress: string;
  onUpdate: (record: ConvertRecord) => void | Promise<void>;
};

export type SolanaExecutorOpts = {
  /** Submit rounds for the identical bytes (Solana dedups by signature — a repeat is a no-op). */
  submitAttempts?: number;
  /** Confirmation polls before parking `stuck` (the engine's slow watch then takes over). */
  confirmAttempts?: number;
  pollIntervalMs?: number;
  nowMs?: () => number;
};

type SolWatchOutcome =
  | {kind: 'confirmed'}
  | {kind: 'failed'; detail: string}
  | {kind: 'dead'} // blockhash expired with the tx unseen — it can NEVER land
  | {kind: 'unknown'};

/** The chain is the only oracle: poll the signature status (history-aware) and the block
 *  height until one of the four truths holds. Never re-signs; never re-builds. */
export async function watchSolTx(
  leg: SolanaSwapLeg,
  attempts: number,
  intervalMs: number,
): Promise<SolWatchOutcome> {
  for (let i = 0; i < attempts; i++) {
    let status = null;
    try {
      status = await getSolSignatureStatus(leg.signature);
    } catch {
      status = null; // an unreadable status proves nothing either way
    }
    if (status != null && status.err != null) {
      return {kind: 'failed', detail: JSON.stringify(status.err).slice(0, 120)};
    }
    if (status != null && status.confirmationStatus != null) {
      return {kind: 'confirmed'};
    }
    let height: number | null = null;
    try {
      height = await getSolBlockHeight();
    } catch {
      height = null;
    }
    if (height != null && height > leg.lastValidBlockHeight) {
      return {kind: 'dead'};
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return {kind: 'unknown'};
}

/** The realized payout for the done line — never the estimate dressed as fact. Token output:
 *  the user's own post−pre token delta; native-SOL output: the fee payer's post−pre lamports
 *  (payout minus the network fee). Null ⇒ the caller falls back to the venue's own floor. */
async function realizedSolPayout(rec: ConvertRecord, solAddress: string): Promise<string | null> {
  if (rec.outLedger === WRAPPED_SOL_MINT_ADDRESS) {
    return getSolNativeCredit(rec.solanaLeg?.signature ?? '');
  }
  return getSolTokenCredit(rec.solanaLeg?.signature ?? '', solAddress, rec.outLedger);
}

/** Drive a Solana-shaped record one state forward (or to its honest park). The engine calls
 *  this for every non-terminal Solana record and for unacknowledged `stuck` ones — the same
 *  cadence contract the IC executor has. */
export async function executeSolanaConvert(
  start: ConvertRecord,
  deps: SolanaExecutorDeps,
  opts: SolanaExecutorOpts = {},
): Promise<ConvertRecord> {
  const submitAttempts = opts.submitAttempts ?? 2;
  const confirmAttempts = opts.confirmAttempts ?? 12;
  const intervalMs = opts.pollIntervalMs ?? 400;
  let rec = start;
  const leg = rec.solanaLeg;
  if (leg == null) return rec; // not a Solana record — nothing to drive (hydration prevents this)
  const advance = async (patch: Partial<ConvertRecord>): Promise<ConvertRecord> => {
    rec = {...rec, ...patch};
    await saveConvertRecord(deps.publicHex, rec);
    await deps.onUpdate(rec);
    return rec;
  };
  const settle = async (): Promise<ConvertRecord> => {
    const outcome = await watchSolTx(leg, confirmAttempts, intervalMs);
    if (outcome.kind === 'confirmed') {
      const realized = await realizedSolPayout(rec, deps.solAddress).catch(() => null);
      // Honest end state: the REALIZED credit when the chain could be read, else the venue's
      // own min-out floor (a guarantee, not a guess). outTx is the tx signature.
      return advance({
        step: 'done',
        outAmountNet: realized ?? rec.expectedNet,
        outTx: leg.signature,
        ...(realized == null ? {failureDetail: 'payout-floor'} : {}),
      });
    }
    if (outcome.kind === 'failed') {
      // The chain confirmed the tx WITH an error: the route did not run; the input never left
      // the wallet (a failed Solana tx moves nothing but its fee).
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    }
    if (outcome.kind === 'dead') {
      // Unseen + past the blockhash's death: the bytes can never execute. Input unmoved.
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    }
    // Unknown after the full window: park honestly; the engine's stuck-watch keeps re-reading
    // the status (a late confirmation is found via history-aware reads; expiry eventually
    // resolves the other way). Never resubmit NEW bytes past this point — identical bytes only.
    return advance({step: 'stuck', failureCode: 'unknown'});
  };

  // --- stuck (the slow-watch entry): re-read, don't resubmit unless the bytes are still live --
  if (rec.step === 'stuck') {
    const outcome = await watchSolTx(leg, 1, 0);
    if (outcome.kind === 'confirmed') {
      rec = await advance({step: 'settling'});
    } else if (outcome.kind === 'failed') {
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    } else if (outcome.kind === 'dead') {
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    } else {
      return rec; // still genuinely unknown — stays stuck until acknowledged or resolved
    }
  }

  // --- swapping: submit the signed bytes (identical on every retry — the chain dedups them) --
  if (rec.step === 'swapping') {
    const raw = hexToBytes(leg.signedTxHex);
    if (raw == null) {
      return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'unreadable-signed-bytes'});
    }
    void saveTxNote(deps.publicHex, {k: leg.signature, who: venueDisplayName(rec.venueId)}, Date.now());
    let submitted = false;
    let lastErr: unknown = null;
    for (let i = 0; i < submitAttempts && !submitted; i++) {
      try {
        const nodeSig = await submitRawSolTx(raw);
        // The single-signer tx's identity IS the signature we recorded; anything else means
        // we are not looking at our own bytes — park, never guess.
        submitted = nodeSig === leg.signature;
        if (!submitted) return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'signature-mismatch'});
      } catch (e) {
        lastErr = e;
        // A throw is NOT a refusal verdict: the tx may already be in flight (or the error was
        // a timeout). Ask the chain before retrying — identical bytes only, never a rebuild.
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
      // Exhausted identical-byte rounds with no chain answer: honest unknown (lastErr kept in
      // the console only — provider prose never reaches a screen).
      if (lastErr != null) console.warn('solana convert submit: no verdict after retries', lastErr);
      return advance({step: 'stuck', failureCode: 'unknown'});
    }
    rec = await advance({step: 'settling'});
  }

  if (rec.step === 'settling') {
    return settle();
  }
  return rec;
}
