import bs58 from 'bs58';
import {encodeApprove as encodeErc20Approve} from '../cketh';
import {
  CCTP_DOMAIN_SOLANA,
  CCTP_FINALITY_FAST,
  TOKEN_MESSENGER_V2_ADDRESS,
  USDC_ERC20_ADDRESS,
  buildForwardHookData,
  cctpMaxFee,
  cctpMintFloor,
  encodeDepositForBurnWithHook,
  parseCctpBurnFees,
  parseCctpMessageStatus,
  type CctpBurnFee,
  type CctpMessageStatus,
} from '../cctp';
import {deriveSolanaKeypair} from '../solana/identity';
import {deriveAta} from '../solana/spl';
import {bytesToHex} from '../solana/tx';
import {USDC_MINT_ADDRESS} from '../solana/tokens';
import {M} from '../i18n';
import {type ConvertRecord} from './types';
import {convertRecordMinOut} from './records';
// --- the CCTP leg: build the burn for the USER's wallet, then watch Circle attest and mint ---

/** Circle's published fee endpoints (CCTP V2). The burn lane is fixed by the route: USDC
 *  from Ethereum (domain 0) to Solana (domain 5), FAST finality, Forwarding Service ON
 *  with recipient setup included — so the URL is composed once, here, not per call. */
const CCTP_BURN_FEES_URL =
  'https://iris-api.circle.com/v2/burn/USDC/fees/0/5?forward=true&includeRecipientSetup=true';
const CCTP_MESSAGES_BASE_URL = 'https://iris-api.circle.com/v2/messages/0?transactionHash=';

/** Circle's live fee numbers for the USDC Ethereum→Solana burn at FAST finality: the
 *  protocol bps plus the Forwarding Service's fee (med) — the census's own numbers and
 *  the base of the signed maxFee. Fail-closed, exactly like the minter's gas quote: an
 *  unreachable fee API means the cross-rail intent cannot be priced honestly, so prepare
 *  and the handoff both refuse rather than sign a stale guess. */
export async function fetchCctpBurnFee(timeoutMs = 8000): Promise<CctpBurnFee> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(CCTP_BURN_FEES_URL, {signal: ctl.signal});
    if (!res.ok) throw new Error(M.convert.errors.cctpFeeUnavailable);
    const fee = parseCctpBurnFees(await res.json(), CCTP_FINALITY_FAST);
    if (fee == null) throw new Error(M.convert.errors.cctpFeeUnavailable);
    return fee;
  } catch {
    throw new Error(M.convert.errors.cctpFeeUnavailable);
  } finally {
    clearTimeout(timer);
  }
}

/** Circle's CCTP V2 message status, keyed by the BURN tx hash (the watch the mission spec
 *  names). A 404 is Circle's "not attested yet" — a PENDING, never a failure. Only a
 *  transport-class error throws; the caller parks and retries at the engine's cadence. */
export async function fetchCctpMessageStatus(burnTxHash: string, timeoutMs = 8000): Promise<CctpMessageStatus> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(CCTP_MESSAGES_BASE_URL + encodeURIComponent(burnTxHash), {signal: ctl.signal});
    if (res.status === 404) return {state: 'pending'};
    if (!res.ok) throw new Error('cctp status unreachable');
    return parseCctpMessageStatus(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Everything the handoff screen renders and the user's EVM wallet needs: the two exact
 *  transactions (USDC approve → TokenMessengerV2, then depositForBurnWithHook to it), the
 *  honest fee numbers behind them, and the frozen destination facts for the copy. The fee
 *  is fetched LIVE (again) — the confirm-time census is display history by now; what is
 *  signed is what Circle charges right now. */
export type CctpHandoff = {
  /** The token the approve pulls and the burn burns: canonical mainnet USDC. */
  burnToken: string;
  /** The spender of BOTH txs: TokenMessengerV2. */
  tokenMessenger: string;
  approveCalldata: string;
  burnCalldata: string;
  /** The burn amount in USDC base units — the record's own minOut, deterministic. */
  amountSubunits: string;
  /** Circle's live fee numbers at handoff (the maxFee is what the burn signs). */
  minimumFeeBps: string;
  maxFeeSubunits: string;
  mintFloorSubunits: string;
  mintRecipientAta: string;
  destinationDomain: number;
  minFinalityThreshold: number;
};

/** The two exact transactions the CCTP burn IS — approve (USDC → TokenMessengerV2) then
 *  depositForBurnWithHook — built from the record's frozen facts and a maxFee. The bytes are
 *  IDENTICAL whichever key signs them: the external handoff renders them for the user's
 *  wallet, the stage-2 device path signs them itself. `maxFeeOverride` absent → Circle's
 *  LIVE census (the confirm-time numbers are display history; what is signed is what Circle
 *  charges now); the device path passes the FROZEN maxFee instead (crash-safety: identical
 *  bytes on every re-drive — EVM nodes dedup by hash). Refuses when the re-derived mint
 *  recipient no longer matches the frozen facts — a derivation drift is a
 *  refuse-and-reprepare, never a re-target. */
export async function buildCctpBurnTxs(secretHex: string, rec: ConvertRecord, maxFeeOverride?: bigint): Promise<CctpHandoff> {
  const cross = rec.crossRail!;
  const burnAmount = BigInt(await convertRecordMinOut(rec));
  const kp = deriveSolanaKeypair(secretHex);
  const ata = deriveAta(kp.address, USDC_MINT_ADDRESS);
  if (bs58.encode(ata) !== cross.mintRecipientAta || kp.address !== cross.solAddress) {
    // Deterministic derivation drifted from the frozen facts — do not offer a burn whose
    // recipient this build cannot vouch for. Honest refusal; the user re-prepares.
    throw new Error('cross-rail destination derivation mismatch');
  }
  let minimumFeeBps = '0'; // the device path (frozen maxFee) does not re-read Circle's census
  let maxFee = maxFeeOverride;
  if (maxFee == null) {
    const fee = await fetchCctpBurnFee();
    maxFee = cctpMaxFee(burnAmount, fee);
    minimumFeeBps = fee.minimumFeeBps.toString();
  }
  return {
    burnToken: USDC_ERC20_ADDRESS,
    tokenMessenger: TOKEN_MESSENGER_V2_ADDRESS,
    approveCalldata: encodeErc20Approve(TOKEN_MESSENGER_V2_ADDRESS, burnAmount),
    burnCalldata: encodeDepositForBurnWithHook({
      amount: burnAmount,
      destinationDomain: CCTP_DOMAIN_SOLANA,
      mintRecipientHex64: bytesToHex(ata),
      burnToken: USDC_ERC20_ADDRESS,
      maxFee,
      minFinalityThreshold: CCTP_FINALITY_FAST,
      hookDataHex: buildForwardHookData(bytesToHex(kp.publicKey)),
    }),
    amountSubunits: burnAmount.toString(),
    minimumFeeBps,
    maxFeeSubunits: maxFee.toString(),
    mintFloorSubunits: cctpMintFloor(burnAmount, maxFee).toString(),
    mintRecipientAta: bs58.encode(ata),
    destinationDomain: CCTP_DOMAIN_SOLANA,
    minFinalityThreshold: CCTP_FINALITY_FAST,
  };
}

/** Build the handoff for a record parked at `awaiting_external`. Refuses (never renders a
 *  stale screen) if the record is not in the handoff phase, or if the re-derived mint
 *  recipient does not match the one frozen at prepare — the derivation changing is a
 *  refuse-and-rebuild situation, not a render-what-we-can. */
export async function buildCctpHandoff(secretHex: string, rec: ConvertRecord): Promise<CctpHandoff> {
  if (rec.crossRail == null || rec.step !== 'awaiting_external') {
    throw new Error('record is not awaiting the external signature');
  }
  if (rec.crossRail.burnSigner === 'device') {
    // Stage 2: a device-signed record's burn is the executor's job, never a handoff — this
    // surface asking an external wallet to sign would misdirect the user's funds' custody.
    throw new Error('record is device-signed — the handoff is not its signing surface');
  }
  return buildCctpBurnTxs(secretHex, rec);
}

/** The user's wallet signed and reported the burn tx hash: freeze it, mark the cctp_burn
 *  leg sent, and move to `crossing` — the mint-watch state. Pure store mutation; the
 *  resume engine picks the record up from here. Exported for the handoff UI (and the e2e
 *  seam behind it). */
export function attachCctpBurnTx(rec: ConvertRecord, burnTxHash: string): ConvertRecord {
  if (rec.crossRail == null || rec.step !== 'awaiting_external') return rec;
  // A malformed hash is a caller bug (the UI gates the button on non-empty input and the
  // engine wrapper surfaces this message) — throw, never silently no-op the user's report.
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) throw new Error(M.convert.crossrail.burnTxInvalid);
  const planIdx = rec.legPlan?.findIndex(p => p.kind === 'cctp_burn') ?? -1;
  const legPlan = rec.legPlan?.map((p, i) => (i === planIdx ? {...p, state: 'sent' as const} : p));
  return {...rec, step: 'crossing', legPlan, crossRail: {...rec.crossRail, burnTxHash}};
}

/** The user declines to sign in their wallet: an honest DEAD-END, not a failure of the
 *  chain — the five IC legs completed, so the funds sit as USDC AT THE USER'S OWN EVM
 *  ADDRESS, spendable by that wallet. The copy names exactly that. */
export function declineCctpHandoff(rec: ConvertRecord): ConvertRecord {
  if (rec.crossRail == null || rec.step !== 'awaiting_external') return rec;
  const planIdx = rec.legPlan?.findIndex(p => p.kind === 'cctp_burn') ?? -1;
  const legPlan = rec.legPlan?.map((p, i) => (i === planIdx ? {...p, state: 'failed' as const} : p));
  return {
    ...rec,
    step: 'failed_leg',
    legPlan,
    failureCode: 'external_declined',
  };
}
