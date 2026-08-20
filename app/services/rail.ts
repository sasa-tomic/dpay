// IC user-principal rail pay operations — the ONE implementation of "build, sign, submit, poll"
// shared by PayMode (online pay + offline QR handoff) and NfcTap (payer card + merchant reader).
//
// Semantics pinned by 2026-08-18-user-principal-rail.md (do not re-derive):
//  - The transfer memo is the REQUEST NONCE (16 bytes) — the reconciliation key. request_id dedup
//    makes retries safe; re-signing is FORBIDDEN (new request_id = double-pay). Callers keep the
//    prepared envelope verbatim for any resubmit.
//  - Fee: the catalog's registered fee when present, else None (the ledger charges its default —
//    ICRC-1 semantics; no stale-fee pinning).
//  - Outcome honesty: 'unknown' means NOT TERMINAL within budget (may still execute) — never
//    render it as failure. 'rejected' is a decoded, definitive ledger refusal.
//  - Duplicate{duplicate_of} maps to SETTLED — the ledger telling us this exact transfer already
//    executed (same result, different block).
import {DpayCore} from './native';
import {icStampExpiry, icSubmit, icPollRequestStatus, icQuery, IC_SUBMIT_TIMEOUT_MS} from './icp';
import {hexToBytes} from '../lib/format';
import {bytesToBase64Url, base64UrlToBytes} from '../lib/base64url';

export type RailPrepared = {
  ledger: string; // ledger principal text (submission target + read_state path)
  envelopeHex: string; // signed update envelope — resubmit VERBATIM, never re-sign
  requestIdHex: string; // read_state poll key
  amount: string; // raw u64 decimal string
  currency: number;
  memoHex: string; // the request nonce — reconciliation key
};

/** What one signed reply decodes to — shared by the transfer (wasm) and minter (frozen-shape)
 * decoders below so `pollTransfer` treats them identically. */
type RailReplyOutcome = {ok: boolean; blockIndex?: string; errVariant?: string; errDetail?: string};

export type RailOutcome =
  | {kind: 'settled'; blockIndex: string}
  | {kind: 'rejected'; reason: string} // definitive (decoded TransferError / canister reject)
  | {kind: 'unknown'}; // not terminal in budget / unreachable — honest pending

/** Build + sign the icrc1_transfer envelope from a scanned request. Throws with a user-presentable
 *  message on hard local errors (unsupported asset, no ledger, bad clock) — the caller shows the
 *  error and does NOT fall through to any handoff (nothing was signed). */
export async function prepareTransfer(
  secretHex: string,
  catalog: {currencies: Array<{currency: number; ledger: string; fee: string | null}>},
  req: {toHex: string; amount: string; currency: number; nonceHex: string},
): Promise<RailPrepared> {
  const desc = catalog.currencies.find(c => c.currency === req.currency);
  if (!desc || !desc.ledger) throw new Error('Unsupported asset — no ledger for this currency');
  const toPrincipal = await DpayCore.icpPrincipalFromPubkey(req.toHex);
  const argHex = await DpayCore.icpTransferArg(toPrincipal, '', '', req.amount, desc.fee ?? '', req.nonceHex);
  // Clock-gated: refuses to sign when the IC clock is unreachable or skewed vs the device.
  const expiry = await icStampExpiry(secretHex);
  const signed = await DpayCore.icpSignUpdate(secretHex, desc.ledger, 'icrc1_transfer', argHex, expiry);
  return {ledger: desc.ledger, envelopeHex: signed.envelopeHex, requestIdHex: signed.requestIdHex, amount: req.amount, currency: req.currency, memoHex: req.nonceHex};
}

/** Submit the prepared envelope (verbatim bytes) and poll read_state to a terminal state.
 *  `pollerSecret` signs the read_state polls — any principal may read request_status; the
 *  merchant's own key polls in the handoff case. Budget-exhaustion → 'unknown' (honest pending).
 *  `decodeReply` overrides the reply decoder (minter calls reply a different candid shape). */
export async function submitTransfer(
  prepared: {ledger: string; envelopeHex: string; requestIdHex: string},
  pollerSecret: string,
  opts: {attempts: number; intervalMs: number},
  decodeReply?: (replyArgHex: string) => Promise<RailReplyOutcome>,
): Promise<RailOutcome> {
  const out = await icSubmit(prepared.ledger, 'call', prepared.envelopeHex, IC_SUBMIT_TIMEOUT_MS);
  if (out.kind === 'rejected') {
    // Definitive at the boundary node (malformed envelope / bad signature / expired ingress).
    // The transfer did NOT execute; the user can start a fresh payment.
    return {kind: 'rejected', reason: ingressRejectMessage(out.status, out.bodyText)};
  }
  if (out.kind === 'unknown') return {kind: 'unknown'}; // resubmit the SAME bytes later
  return await pollTransfer(prepared, pollerSecret, opts, decodeReply);
}

/** Poll read_state for the prepared request_id to a terminal state (already-submitted case —
 *  e.g. the payer reconciling an offline handoff, or the merchant after a field drop). */
export async function pollTransfer(
  prepared: {ledger: string; requestIdHex: string},
  pollerSecret: string,
  opts: {attempts: number; intervalMs: number},
  decodeReply?: (replyArgHex: string) => Promise<RailReplyOutcome>,
): Promise<RailOutcome> {
  const st = await icPollRequestStatus(pollerSecret, prepared.ledger, prepared.requestIdHex, opts);
  if (st == null) return {kind: 'unknown'};
  if (st.state === 'replied' && st.replyArgHex != null) {
    const decode = decodeReply ?? ((hex: string) => DpayCore.icpDecodeTransferResult(hex));
    const tr = await decode(st.replyArgHex);
    if (tr.ok) return {kind: 'settled', blockIndex: tr.blockIndex ?? ''};
    return {kind: 'rejected', reason: transferRejectionMessage(tr.errVariant ?? '', tr.errDetail ?? '')};
  }
  if (st.state === 'rejected') {
    return {kind: 'rejected', reason: st.rejectMessage || 'The ledger declined the payment'};
  }
  if (st.state === 'done') return {kind: 'unknown'}; // terminal-but-opaque: honest pending
  return {kind: 'unknown'};
}

/** Friendly text for a decoded ICRC TransferError. Mirrors payments.rejectionMessage's voice. */
export function transferRejectionMessage(variant: string, detail: string): string {
  switch (variant) {
    case 'InsufficientFunds': return 'Not enough balance';
    case 'BadFee': return `Wrong fee${detail ? ` (${detail})` : ''} — try again`;
    case 'BadBurn': return `Amount below the ledger minimum${detail ? ` (${detail})` : ''}`;
    case 'TooOld': return 'The request expired';
    case 'CreatedInFuture': return 'Clock skew — try again';
    case 'TemporarilyUnavailable': return 'The ledger is busy — try again';
    case 'Duplicate': return 'Already paid';
    default: return detail ? `The ledger declined the payment (${detail})` : 'The ledger declined the payment';
  }
}

function ingressRejectMessage(status: number, bodyText: string): string {
  if (bodyText.includes('expired')) return 'The payment window closed — try again';
  return `The IC gateway refused the payment (${status})`;
}

/** Envelope → QR payload (base64url of the envelope bytes — same codec family as every other
 *  dpay QR blob). The merchant's scanner decodes, derives the request_id, submits, polls. */
export function envelopeToQrPayload(envelopeHex: string): string {
  return bytesToBase64Url(hexToBytes(envelopeHex));
}

export function qrPayloadToEnvelopeHex(payload: string): string | null {
  const bytes = base64UrlToBytes(payload.trim());
  if (bytes == null || bytes.length < 64) return null; // envelopes are ~390B; anything tiny is garbage
  return bytesToHex(bytes);
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (const v of b) out += v.toString(16).padStart(2, '0');
  return out;
}

// --- user-principal offramp ---------------------------------------------------------------------------
// Two-phase, ALL user-signed, sequenced by the caller (WithdrawSheet):
//   1. icrc2_approve on the ledger(s) — EXACT amounts (single-use burn semantics on retrieve).
//   2. the minter call (retrieve_btc_with_approval / withdraw_eth / withdraw_erc20).
// Retry rules identical to transfers: resubmit identical bytes ONLY; re-signing a SUBMITTED
// envelope is forbidden (new request_id = double-spend risk on approve).

export type OfframpStep = {ledger: string; envelopeHex: string; requestIdHex: string; label: string};

/** Decode a MINTER call reply (retrieve_btc_with_approval / withdraw_eth / withdraw_erc20):
 * `variant { Ok(record {block_index: nat64}) }` — a DIFFERENT candid shape from the ledger's
 * `variant { Ok(nat) }`. Decoded by the platform core (dpay-icp `decode_minter_ok`, single
 * source — the same Rust knowledge that ENCODES the frozen reply shape in the e2e fake gateway
 * via `encode_minter_ok`), exposed as DpayCore.icpDecodeMinterOk on BOTH rails (UniFFI on
 * Android, wasm on web). The approve steps on the LEDGERS stay transfer-shaped and go through
 * `icpDecodeTransferResult`; a reply that matches NEITHER shape throws (caller surfaces it). */
async function decodeMinterReply(replyArgHex: string): Promise<RailReplyOutcome> {
  return DpayCore.icpDecodeMinterOk(replyArgHex);
}

/** Live gas estimate for a ckERC20 withdrawal (Wei) — signed query to the ckETH minter. */
export async function fetchGasFeeWei(
  secretHex: string,
  minter: string,
  ckerc20Ledger: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const argHex = await DpayCore.icpEip1559PriceArg(ckerc20Ledger);
  const reply = await icQuery(secretHex, minter, 'eip_1559_transaction_price', argHex, signal);
  if (reply == null) return null;
  const p = await DpayCore.icpDecodeEip1559Price(reply);
  return p.maxTransactionFee;
}

/** Empty DIDL argument (`icrc1_fee` takes no parameters). */
const EMPTY_DIDL_ARG_HEX = '4449444c0000';

/** The ledger's icrc1_fee — ICRC-2 `approve` MUST carry it verbatim (a wrong/absent fee is
 * rejected with BadFee, exactly like a transfer). Fetched live per ledger: the catalog's fee
 * field is display metadata; the ledger is authoritative. */
async function fetchApproveFee(secretHex: string, ledger: string): Promise<string> {
  const reply = await icQuery(secretHex, ledger, 'icrc1_fee', EMPTY_DIDL_ARG_HEX);
  if (reply == null) throw new Error("Couldn't fetch the ledger fee — check your connection");
  return await DpayCore.icpDecodeInt(reply);
}

/** ckBTC offramp: approve(spender=minter, amount) on the ckBTC ledger, then retrieve from the minter. */
export async function prepareBtcWithdrawal(
  secretHex: string,
  ledger: string,
  minter: string,
  btcAddress: string,
  amountSats: string,
): Promise<OfframpStep[]> {
  const expiry = await icStampExpiry(secretHex);
  const fee = await fetchApproveFee(secretHex, ledger);
  const steps: OfframpStep[] = [];
  {
    const argHex = await DpayCore.icpApproveArg(minter, '', '', amountSats, '', '', '', fee);
    const signed = await DpayCore.icpSignUpdate(secretHex, ledger, 'icrc2_approve', argHex, expiry);
    steps.push({ledger, envelopeHex: signed.envelopeHex, requestIdHex: signed.requestIdHex, label: 'approve'});
  }
  {
    const argHex = await DpayCore.icpRetrieveBtcArg(btcAddress, amountSats, '');
    const signed = await DpayCore.icpSignUpdate(secretHex, minter, 'retrieve_btc_with_approval', argHex, expiry);
    steps.push({ledger: minter, envelopeHex: signed.envelopeHex, requestIdHex: signed.requestIdHex, label: 'retrieve'});
  }
  return steps;
}

/** ckETH (native) offramp: approve(amount + max_transaction_fee) on ckETH, then withdraw_eth. */
export async function prepareEthWithdrawal(
  secretHex: string,
  ckethLedger: string,
  minter: string,
  recipient: string,
  amountWei: string,
  gasFeeWei: string,
): Promise<OfframpStep[]> {
  const expiry = await icStampExpiry(secretHex);
  const fee = await fetchApproveFee(secretHex, ckethLedger);
  const steps: OfframpStep[] = [];
  const totalApprove = (BigInt(amountWei) + BigInt(gasFeeWei)).toString();
  {
    const argHex = await DpayCore.icpApproveArg(minter, '', '', totalApprove, '', '', '', fee);
    const signed = await DpayCore.icpSignUpdate(secretHex, ckethLedger, 'icrc2_approve', argHex, expiry);
    steps.push({ledger: ckethLedger, envelopeHex: signed.envelopeHex, requestIdHex: signed.requestIdHex, label: 'approve'});
  }
  {
    const argHex = await DpayCore.icpWithdrawEthArg(recipient, amountWei, '');
    const signed = await DpayCore.icpSignUpdate(secretHex, minter, 'withdraw_eth', argHex, expiry);
    steps.push({ledger: minter, envelopeHex: signed.envelopeHex, requestIdHex: signed.requestIdHex, label: 'withdraw'});
  }
  return steps;
}

/** ckERC20 dual-ledger offramp: gas approve on ckETH + amount approve on the ckERC20 ledger,
 *  then minter withdraw_erc20 (burns both). Requires both ledger principals. */
export async function prepareErc20Withdrawal(
  secretHex: string,
  ckerc20Ledger: string,
  ckethLedger: string,
  minter: string,
  recipient: string,
  amount: string,
  gasFeeWei: string,
): Promise<OfframpStep[]> {
  const expiry = await icStampExpiry(secretHex);
  const gasLedgerFee = await fetchApproveFee(secretHex, ckethLedger);
  const erc20LedgerFee = await fetchApproveFee(secretHex, ckerc20Ledger);
  const steps: OfframpStep[] = [];
  {
    const argHex = await DpayCore.icpApproveArg(minter, '', '', gasFeeWei, '', '', '', gasLedgerFee);
    const signed = await DpayCore.icpSignUpdate(secretHex, ckethLedger, 'icrc2_approve', argHex, expiry);
    steps.push({ledger: ckethLedger, envelopeHex: signed.envelopeHex, requestIdHex: signed.requestIdHex, label: 'approve-gas'});
  }
  {
    const argHex = await DpayCore.icpApproveArg(minter, '', '', amount, '', '', '', erc20LedgerFee);
    const signed = await DpayCore.icpSignUpdate(secretHex, ckerc20Ledger, 'icrc2_approve', argHex, expiry);
    steps.push({ledger: ckerc20Ledger, envelopeHex: signed.envelopeHex, requestIdHex: signed.requestIdHex, label: 'approve-amount'});
  }
  {
    const argHex = await DpayCore.icpWithdrawErc20Arg(amount, ckerc20Ledger, recipient, '', '');
    const signed = await DpayCore.icpSignUpdate(secretHex, minter, 'withdraw_erc20', argHex, expiry);
    steps.push({ledger: minter, envelopeHex: signed.envelopeHex, requestIdHex: signed.requestIdHex, label: 'withdraw'});
  }
  return steps;
}

/** Submit + poll one offramp step to a terminal state. Each step is its own /call; sequence
 *  callers submit in order and STOP on anything but settled (approve failures make the follow-up
 *  meaningless; 'unknown' on approve = honest pending — do NOT submit the minter call blind).
 *  The minter steps (retrieve/withdraw) reply a different candid shape than the ledger steps —
 *  routed through `decodeMinterReply`. */
export async function submitOfframpStep(
  step: OfframpStep,
  secretHex: string,
  opts: {attempts: number; intervalMs: number},
): Promise<RailOutcome> {
  const decode = step.label === 'retrieve' || step.label === 'withdraw' ? decodeMinterReply : undefined;
  return submitTransfer(step, secretHex, opts, decode);
}

/** ckBTC deposit address at THIS user's principal — signed get_btc_address query against the
 *  minter (arbitrary owners accepted; the address pays Account{owner: user principal}). Returns
 *  null when unreachable or the query was rejected (caller shows a transient error). */
export async function railBtcDepositAddress(secretHex: string, minter: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const selfPrincipal = await DpayCore.icpSelfPrincipal(secretHex);
    const argHex = await DpayCore.icpMinterAccountArg(selfPrincipal, '');
    const replyArg = await icQuery(secretHex, minter, 'get_btc_address', argHex, signal);
    if (replyArg == null || replyArg === '') return null;
    return await DpayCore.icpDecodeText(replyArg);
  } catch (e) {
    console.warn('get_btc_address query failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Signed icrc1_balance_of for one's OWN principal on a ledger — the honest deposit-mint
 *  recheck (baseline-delta detection). Returns the raw balance (decimal string) or null. */
export async function railBalanceOf(secretHex: string, ledger: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const selfPrincipal = await DpayCore.icpSelfPrincipal(secretHex);
    const argHex = await DpayCore.icpBalanceOfArg(selfPrincipal, '');
    const replyArg = await icQuery(secretHex, ledger, 'icrc1_balance_of', argHex, signal);
    if (replyArg == null) return null;
    return await DpayCore.icpDecodeInt(replyArg);
  } catch (e) {
    console.warn('icrc1_balance_of query failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
