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
//  - Duplicate{duplicate_of} is settled: the ledger identifies the block that already executed
//    these exact transfer arguments. It must never be rendered as a decline.
import {DpayCore} from './native';
import {icStampExpiry, icSubmit, icPollRequestStatus, icPollSignedRequestStatus, icQuery, IC_SUBMIT_TIMEOUT_MS, INGRESS_AHEAD_S} from './icp';
import {hexToBytes, bytesToHex, base, short} from '../lib/format';
import {bytesToBase64Url, base64UrlToBytes} from '../lib/base64url';
import {fetchWithTimeout} from './relay';
import {HISTORY_TIMEOUT_MS} from '../config/constants';
import type {PayIntent, Req, TransactionsRow} from '../lib/types';
import {M} from '../i18n';

export type RailPrepared = {
  ledger: string; // ledger principal text (submission target + read_state path)
  envelopeHex: string; // signed update envelope — resubmit VERBATIM, never re-sign
  requestIdHex: string; // read_state poll key
  amount: string; // raw u64 decimal string
  currency: number;
  memoHex: string; // the request nonce — reconciliation key
  readStateEnvelopeHex?: string; // NFC only: payer-signed reusable request_status capability
};

/** What one signed reply decodes to — shared by the transfer (wasm) and minter (frozen-shape)
 * decoders below so `pollTransfer` treats them identically. */
type RailReplyOutcome = {ok: boolean; blockIndex?: string; errVariant?: string; errDetail?: string};

export type RailOutcome =
  | {kind: 'settled'; blockIndex: string}
  | {kind: 'rejected'; reason: string; variant?: string} // definitive refusal; variant = the structured ICRC TransferError tag (e.g. 'Duplicate') when one was decoded — branch on it, not on the human message
  | {kind: 'unknown'}; // not terminal in budget / unreachable — honest pending

/** Build + sign the icrc1_transfer envelope from a scanned request. Throws with a user-presentable
 *  message on hard local errors (unsupported asset, no ledger, bad clock) — the caller shows the
 *  error and does NOT fall through to any handoff (nothing was signed). */
export async function prepareTransfer(
  secretHex: string,
  catalog: {currencies: Array<{currency: number; ledger: string; fee: string | null}>},
  req: {toPrincipal: string; amount: string; currency: number; nonceHex: string},
): Promise<RailPrepared> {
  const desc = catalog.currencies.find(c => c.currency === req.currency);
  if (!desc || !desc.ledger) throw new Error(M.errors.ic.noLedgerForCurrency);
  const argHex = await DpayCore.icpTransferArg(req.toPrincipal, '', '', req.amount, desc.fee ?? '', req.nonceHex);
  // Clock-gated: refuses to sign when the IC clock is unreachable or skewed vs the device.
  const expiry = await icStampExpiry(secretHex);
  const signed = await DpayCore.icpSignUpdate(secretHex, desc.ledger, 'icrc1_transfer', argHex, expiry);
  return {ledger: desc.ledger, envelopeHex: signed.envelopeHex, requestIdHex: signed.requestIdHex, amount: req.amount, currency: req.currency, memoHex: req.nonceHex};
}

/** Turn a decoded 132-byte wire request into the payment intent the review + sign path consumes.
 *  The wire addresses the payee by raw Ed25519 PUBKEY; the ledger account owner is
 *  `self_authenticating(pubkey)` — that derivation is the ONE place the wire's addressing meets the
 *  rail's, and it lives here so a payment link (which already carries a principal) needs no second
 *  conversion. The destination renders as the short pubkey, exactly as a scanned request always has. */
export async function wireRequestToIntent(req: Req): Promise<PayIntent> {
  return {
    toPrincipal: await DpayCore.icpPrincipalFromPubkey(req.toHex),
    toName: req.toName,
    toAccountText: short(req.toHex),
    amount: req.amount,
    currency: req.currency,
    nonceHex: req.nonceHex,
    memo: req.memo,
    expiry: req.expiry,
    source: 'wire',
  };
}

/** NFC payer preparation performs no network call. The online merchant stamped `req.expiry` from
 * certified IC time; the payer signs the update at that expiry and a reusable request-status read
 * with 60 seconds more headroom, then hands both envelopes to the merchant. */
export async function prepareNfcTransfer(
  secretHex: string,
  catalog: {currencies: Array<{currency: number; ledger: string; fee: string | null}>},
  req: {toHex: string; amount: string; currency: number; nonceHex: string; expiry: number},
): Promise<RailPrepared & {readStateEnvelopeHex: string}> {
  const desc = catalog.currencies.find(c => c.currency === req.currency);
  if (!desc || !desc.ledger) throw new Error(M.errors.ic.noLedgerForCurrency);
  const toPrincipal = await DpayCore.icpPrincipalFromPubkey(req.toHex);
  const argHex = await DpayCore.icpTransferArg(toPrincipal, '', '', req.amount, desc.fee ?? '', req.nonceHex);
  const updateExpiryNs = (BigInt(req.expiry) * 1_000_000_000n).toString();
  const signed = await DpayCore.icpSignUpdate(secretHex, desc.ledger, 'icrc1_transfer', argHex, updateExpiryNs);
  const readExpiryNs = (BigInt(req.expiry + 60) * 1_000_000_000n).toString();
  const readStateEnvelopeHex = await DpayCore.icpSignReadState(secretHex, [signed.requestIdHex], false, readExpiryNs);
  return {
    ledger: desc.ledger,
    envelopeHex: signed.envelopeHex,
    requestIdHex: signed.requestIdHex,
    amount: req.amount,
    currency: req.currency,
    memoHex: req.nonceHex,
    readStateEnvelopeHex,
  };
}

/** Submit the prepared envelope (verbatim bytes) and poll read_state to a terminal state.
 *  `pollerSecret` MUST belong to the update sender; the IC does not authorize another principal to
 *  read this request_status. Budget-exhaustion → 'unknown' (honest pending).
 *  `decodeReply` overrides the reply decoder (minter calls reply a different candid shape). */
export async function submitTransfer(
  prepared: {ledger: string; envelopeHex: string; requestIdHex: string},
  pollerSecret: string,
  opts: {attempts: number; intervalMs: number},
  decodeReply?: (replyArgHex: string) => Promise<RailReplyOutcome>,
): Promise<RailOutcome> {
  // HTTP only says what THIS POST observed. An identical peer submission may already have entered
  // consensus, so even 4xx/429 cannot safely produce a decline. The sender-authorized request_status
  // is the sole terminal verdict.
  await icSubmit(prepared.ledger, 'call', prepared.envelopeHex, IC_SUBMIT_TIMEOUT_MS);
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
  return decodeTransferStatus(st, decodeReply);
}

/** Merchant-only NFC settlement: submit the offline payer's immutable update and poll with the
 * payer-signed read_state envelope that arrived in the same DPN2 bundle. */
export async function submitNfcTransfer(
  prepared: {ledger: string; envelopeHex: string; requestIdHex: string; readStateEnvelopeHex: string},
  opts: {attempts: number; intervalMs: number},
): Promise<RailOutcome> {
  await icSubmit(prepared.ledger, 'call', prepared.envelopeHex, IC_SUBMIT_TIMEOUT_MS);
  const st = await icPollSignedRequestStatus(
    prepared.ledger,
    prepared.requestIdHex,
    prepared.readStateEnvelopeHex,
    opts,
  );
  return decodeTransferStatus(st);
}

async function decodeTransferStatus(
  st: Awaited<ReturnType<typeof icPollRequestStatus>>,
  decodeReply?: (replyArgHex: string) => Promise<RailReplyOutcome>,
): Promise<RailOutcome> {
  if (st == null) return {kind: 'unknown'};
  if (st.state === 'replied' && st.replyArgHex != null) {
    const decode = decodeReply ?? ((hex: string) => DpayCore.icpDecodeTransferResult(hex));
    const tr = await decode(st.replyArgHex);
    if (tr.ok) return {kind: 'settled', blockIndex: tr.blockIndex ?? ''};
    if (tr.errVariant === 'Duplicate') {
      return {kind: 'settled', blockIndex: tr.errDetail?.match(/\d+$/)?.[0] ?? ''};
    }
    return {kind: 'rejected', reason: transferRejectionMessage(tr.errVariant ?? '', tr.errDetail ?? ''), variant: tr.errVariant || undefined};
  }
  if (st.state === 'rejected') {
    return {kind: 'rejected', reason: st.rejectMessage || M.rail.declined('')};
  }
  if (st.state === 'done') return {kind: 'unknown'}; // terminal-but-opaque: honest pending
  return {kind: 'unknown'};
}

/** Friendly text for a decoded ICRC TransferError (the structured `variant` — not a parsed message). */
export function transferRejectionMessage(variant: string, detail: string): string {
  switch (variant) {
    case 'InsufficientFunds': return M.rail.insufficientFunds;
    case 'BadFee': return M.rail.badFee(detail);
    case 'BadBurn': return M.rail.badBurn(detail);
    case 'TooOld': return M.rail.tooOld;
    case 'CreatedInFuture': return M.rail.createdInFuture;
    case 'TemporarilyUnavailable': return M.rail.temporarilyUnavailable;
    case 'Duplicate': return M.rail.duplicate;
    default: return M.rail.declined(detail);
  }
}

export type IncomingTransfer = {
  relayUrl: string;
  receiverPublicHex: string;
  currency: number;
  amount: string;
  memoHex: string;
};

/** Receiver-side proof for a payer-owned update. The receiver cannot read the payer's request_status
 * on the real IC, so it confirms the exact open request from the ledger's durable transaction log.
 * Matching recipient + currency + amount + random 16-byte memo binds success to this request. */
export async function confirmIncomingTransfer(
  expected: IncomingTransfer,
  opts: {attempts: number; intervalMs: number},
): Promise<boolean> {
  const me = (await DpayCore.icpPrincipalFromPubkey(expected.receiverPublicHex)).toLowerCase();
  const memo = expected.memoHex.toLowerCase();
  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    try {
      const r = await fetchWithTimeout(
        `${base(expected.relayUrl)}/api/v1/transactions/${expected.receiverPublicHex}?currency=${expected.currency}&limit=1&memo=${memo}`,
        undefined,
        HISTORY_TIMEOUT_MS,
      );
      const body = await r.json().catch(() => null) as {transactions?: TransactionsRow[]} | null;
      if (r.ok && body?.transactions?.some(row =>
        row.currency === expected.currency
        && row.to.toLowerCase() === me
        && row.amount === expected.amount
        && row.memo.toLowerCase() === memo
      )) return true;
    } catch (e) {
      console.warn('incoming transfer history poll failed:', e instanceof Error ? e.message : String(e));
    }
    if (attempt + 1 < opts.attempts && opts.intervalMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, opts.intervalMs));
    }
  }
  return false;
}

/** Submit a payer-owned envelope verbatim, then prove the receiver's exact request in ledger history.
 * HTTP rejection is not a verdict: the payer may have submitted the same request concurrently. */
export async function submitAndConfirmIncomingTransfer(
  ledger: string,
  envelopeHex: string,
  expected: IncomingTransfer,
  opts: {attempts: number; intervalMs: number},
): Promise<boolean> {
  await icSubmit(ledger, 'call', envelopeHex, IC_SUBMIT_TIMEOUT_MS);
  return await confirmIncomingTransfer(expected, opts);
}

/** Envelope → QR payload (base64url of the envelope bytes — same codec family as every other
 *  dpay QR blob). The merchant's scanner decodes, derives the request_id, submits, polls. */
export function envelopeToQrPayload(envelopeHex: string): string {
  return bytesToBase64Url(hexToBytes(envelopeHex));
}

// Minimum plausible signed-envelope size — the garbage gate for decoded QR payloads. Real
// envelopes are ~390B; anything below this is not an envelope (a stray base64url blob, a shard).
const MIN_ENVELOPE_BYTES = 64;

export function qrPayloadToEnvelopeHex(payload: string): string | null {
  const bytes = base64UrlToBytes(payload.trim());
  if (bytes == null || bytes.length < MIN_ENVELOPE_BYTES) return null;
  return bytesToHex(bytes);
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
 * Android, wasm on web). The approve steps on the LEDGERS are DELIBERATELY decoded
 * transfer-shaped and go through `icpDecodeTransferResult` (dpay-icp's dedicated
 * `decode_approve_result` intentionally does not cross the bridge — smaller ABI surface, and
 * the ledger's approve replies carry the same variant names); a reply that matches NEITHER
 * shape throws (caller surfaces it). */
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
  if (reply == null) throw new Error(M.errors.ic.feeUnavailable);
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

/** ckBTC deposit address at THIS user's principal — a signed get_btc_address UPDATE against the
 *  minter (arbitrary owners accepted; the address pays Account{owner: user principal}). The real
 *  minter exposes get_btc_address as an update method ONLY — the query form dies on mainnet with
 *  "Canister has no query method 'get_btc_address'" (found on a physical device 2026-08-23; the
 *  offline fake gateway used to accept the query form, which is why every inner-loop gate was
 *  green). Same rail discipline as a transfer: sign ONCE (certified-clock expiry), POST the exact
 *  bytes to /api/v2/call, poll the request_id to a terminal state — a call that times out
 *  mid-poll is re-polled on the next sheet open, never re-signed blind. Returns the address, or
 *  null when unreachable/rejected/not-terminal-in-budget (caller shows the transient state). */
export async function railBtcDepositAddress(secretHex: string, minter: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const selfPrincipal = await DpayCore.icpSelfPrincipal(secretHex);
    const argHex = await DpayCore.icpMinterAccountArg(selfPrincipal, '');
    const expiry = await icStampExpiry(secretHex, INGRESS_AHEAD_S, signal);
    const signed = await DpayCore.icpSignUpdate(secretHex, minter, 'get_btc_address', argHex, expiry);
    await icSubmit(minter, 'call', signed.envelopeHex, IC_SUBMIT_TIMEOUT_MS, signal);
    const st = await icPollRequestStatus(secretHex, minter, signed.requestIdHex, {attempts: 12, intervalMs: 500, signal});
    if (st == null || st.state !== 'replied' || st.replyArgHex == null) return null;
    const addr = await DpayCore.icpDecodeText(st.replyArgHex);
    return addr === '' ? null : addr;
  } catch (e) {
    console.warn('get_btc_address update failed:', e instanceof Error ? e.message : String(e));
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
