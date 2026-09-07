// SOL native device-key rail — the isolation-boundary seam (mirrors `app/wallet.ts`→
// `app/walletconnect.ts`). Statically imports ONLY the PURE modules (`solana/identity`,
// `solana/tx`, `solana/spl`, `solana/qr`, `payments` — no network, no `@solana/*` SDK, safe under
// jest/e2e). The network module `solana/rpc` is reached via a lazy `await import('./solana/rpc')`
// INSIDE the async network functions, gated by a non-empty `SOLANA_RPC_URL`. With the URL empty
// (jest.setup.js + the e2e driver set `__DPAY_TEST_SOLANA_RPC_URL=''`), these functions no-op /
// throw — so the offline inner loop never imports the network module and never touches devnet.
//
// v2 recent-blockhash payment lifecycle (the durable-nonce rail was REMOVED — see
// 2026-08-12-solana-recent-blockhash-rewrite-plan.md):
//   createSolPaymentRequest — ONLINE merchant fetches genesis hash + fresh blockhash + builds SolReqV2.
//   signSolPayment / signSplPayment — OFFLINE payer signs the canonical message (no network).
//   broadcastSolPayment — ONLINE merchant strictly verifies, freshness-checks, broadcasts, confirms.
// (The v1 durable-nonce reclaim tool was removed 2026-08-14: no user ever held v1 nonce funds.)

import bs58 from 'bs58';
import {SOLANA_RPC_URL, SOL_GENESIS_HASH, SOL_PAYMENT_MAX_WINDOW_SECONDS, SOL_PAYMENT_COMMITMENT, SOL_BROADCAST_TIMEOUT_MS} from './config/constants';
import {solanaTokenAvailable} from './config/assets';
import {deriveSolanaKeypair, deriveSolanaAddress} from './solana/identity';
import {SOL_DECIMALS, SOL_UNIT} from './solana/identity';
import {fmtAsset} from './lib/format';
import {base58Decode32, buildSignedTransfer, signTransaction, assembleMessage, buildCanonicalSolMessage, verifySolPayment, extractSignedTxParts, buildMemoInstruction, buildSolTransferInstruction, type Instruction} from './solana/tx';
import {buildSplTransferInstruction, buildTransferCheckedInstruction, buildCreateAtaIdempotentInstruction, buildCanonicalSplMessage, deriveAta, SOL_ATA_SETUP_MIN_LAMPORTS} from './solana/spl';
import {solanaTokenInfo, solanaTokenOfMint} from './solana/tokens';
import {utf8ToBytes} from './lib/base64url';
import {encodeSolReq, generateRid} from './solana/qr';
import type {SolReqV2, SolPayV2, SolReceiptV2, SolReqInput, SolPayInput} from './solana/qr';
import type {SolanaSignatureStatus, SolanaTransactionDetail} from './solana/rpc';
import type {SolanaHistory} from './solana/history';
import {verifySettledTransaction} from './solana/settleVerify';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE, RECEIPT_MISMATCH} from './solana/payments';
import {M} from './i18n';

export {deriveSolanaAddress};
// Type-only re-export: the history hook consumes these shapes but must reach the network module
// only through this seam. `export type` is erased, so nothing is pulled into the bundle.
export type {SolanaHistory, SolanaHistoryRow} from './solana/history';
// Same reason: `getSolSignatureStatus` hands its caller the chain's verdict verbatim, so the shape
// of that verdict has to be nameable without importing the network module.
export type {SolanaSignatureStatus} from './solana/rpc';

// --- existing exports (unchanged) ----------------------------------------------

/** Read an account's lamport balance as a decimal-digit string. Returns `null` (no throw, no
 *  network) when SOL is offline (`SOLANA_RPC_URL` empty) — the hook treats null as "no balance". */
export async function getSolanaBalance(address: string, signal?: AbortSignal): Promise<string | null> {
  if (!SOLANA_RPC_URL) return null;
  const {getBalance} = await import('./solana/rpc');
  return getBalance(SOLANA_RPC_URL, address, {signal});
}

/** Recent SOL + USDC movements for `address`, newest-first (the SOL rail's half of the Transactions
 *  list). Returns `null` (no throw, no network, no dynamic import) when SOL is offline
 *  (`SOLANA_RPC_URL` empty) — the SAME offline contract as `getSolanaBalance`, so the offline inner
 *  loop never reaches the network module. THROWS when the RPC is configured but the signature
 *  queries fail: an unreadable list is an error state the caller surfaces, never an empty ledger.
 *  Individually unreadable transactions are logged and counted in `SolanaHistory.dropped`. */
export async function getSolanaHistory(address: string, signal?: AbortSignal): Promise<SolanaHistory | null> {
  if (!SOLANA_RPC_URL) return null;
  const {fetchSolanaHistory} = await import('./solana/history');
  return fetchSolanaHistory(SOLANA_RPC_URL, address, {signal});
}

/** Build, sign, broadcast, and confirm a System Program Transfer of `lamports` to `toAddress`.
 *  Signs LOCALLY with the device-derived key (no relay, no DpayCore — non-custodial). Throws if SOL
 *  is offline, on a network/RPC error, or if the transaction fails on-chain. Returns the signature.
 *
 *  `onBroadcast` fires the moment the network ACCEPTS the transaction, before confirmation — i.e.
 *  the first instant at which a throw can no longer mean "nothing happened". A throw after it may
 *  be a confirmation timeout over a transfer that lands seconds later, so a caller that must tell
 *  "definitely not sent" from "unknown" (the OpenCryptoPay report is one-shot and irreversible —
 *  `services/opencryptopay.ts`) needs the signature to survive the failure. Callers that treat any
 *  throw as a failed send simply omit it. */
export async function sendSol(
  secretHex: string,
  toAddress: string,
  lamports: bigint,
  signal?: AbortSignal,
  onBroadcast?: (signature: string) => void,
): Promise<string> {
  if (!SOLANA_RPC_URL) throw new Error(M.errors.solana.offline);
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const {getLatestBlockhash, sendTransaction, confirmTransaction} = await import('./solana/rpc');
  const {blockhash} = await getLatestBlockhash(SOLANA_RPC_URL, {signal});
  const raw = buildSignedTransfer(seed, publicKey, toAddress, lamports, base58Decode32(blockhash));
  const signature = await sendTransaction(SOLANA_RPC_URL, raw, {signal});
  onBroadcast?.(signature);
  await confirmTransaction(SOLANA_RPC_URL, signature, {signal});
  return signature;
}

/** The chain's own verdict on a signature this device already broadcast — null when the cluster has
 *  never heard of it. History-aware (`searchTransactionHistory:true`), so a transaction that landed
 *  while the app was not looking is still observable after it drops out of the recent-status cache.
 *
 *  It exists for the one caller that must resolve a transfer AFTER `sendSol` threw: the
 *  OpenCryptoPay report is one-shot and irreversible, so a broadcast whose confirmation failed is
 *  the payer's only claim on the money and its verdict has to be readable again later
 *  (`SolPayMode`, findings doc "The loss path"). Reading is safe to repeat — nothing here signs or
 *  moves anything.
 *
 *  Throws when the rail is offline, exactly like `sendSol`: a signature can only exist because a
 *  broadcast succeeded, so an RPC that has since gone missing is a state the caller must see and
 *  retry, never one to answer with a silent "not found" (which reads as "it never landed"). */
export async function getSolSignatureStatus(
  signature: string,
  signal?: AbortSignal,
): Promise<SolanaSignatureStatus | null> {
  if (!SOLANA_RPC_URL) throw new Error(M.errors.solana.offline);
  const {getSignatureStatusesForSig} = await import('./solana/rpc');
  const {status} = await getSignatureStatusesForSig(SOLANA_RPC_URL, signature, {signal});
  return status;
}

/** Phase 6 — Build, sign, broadcast, and confirm an SPL Token `transfer` of `amount` raw units of
 *  the registry token `mint` (at its `decimals`) to `destAddress`. The recipient is a base58 Solana
 *  WALLET address (the same shape SOL send takes); the recipient's Associated Token Account for the
 *  mint is DERIVED from it. Signs LOCALLY with the device-derived key (non-custodial — same shape
 *  as sendSol).
 *
 *  FAIL-CLOSED sender check: the device's source ATA must exist on-chain (you cannot send tokens
 *  you don't hold an account for — the error names the sender, the first check).
 *
 *  RECIPIENT AUTO-CREATE (2026-08-14 founder-approved): if the recipient's ATA is missing, the SAME
 *  transaction carries an AssociatedTokenProgram.createIdempotent instruction BEFORE the transfer —
 *  the sender pays the recipient's one-time account rent (≈0.002 SOL, disclosed on the review
 *  screen). createIdempotent is a no-op when the ATA exists, so a TOCTOU race (created between
 *  check + submit) is harmless. This is a real on-chain instruction in the real signed tx — nothing
 *  simulated, nothing hidden.
 *
 *  Throws if SOL is offline, if the sender ATA is missing, on a network/RPC error, or if the
 *  on-chain tx fails. Returns the signature. Reuses the byte-exact `buildSplTransferInstruction` +
 *  `buildCreateAtaIdempotentInstruction` (proven in solana-spl.test.ts). */
export async function sendSpl(
  secretHex: string,
  destAddress: string,
  amount: bigint,
  mint: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!SOLANA_RPC_URL) throw new Error(M.errors.solana.offline);
  const token = solanaTokenOfMint(mint);
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const senderAddress = bs58.encode(publicKey);
  const senderAta = deriveAta(senderAddress, mint);
  const recipientAta = deriveAta(destAddress, mint);
  const {accountExists, getBalance, getLatestBlockhash, sendTransaction, confirmTransaction} = await import('./solana/rpc');

  // Sender ATA first — the device must hold the token account to debit from (fail-closed).
  if (!(await accountExists(SOLANA_RPC_URL, bs58.encode(senderAta), {signal}))) {
    throw new Error(M.errors.solana.senderNoTokenAccount(token ?? mint));
  }
  // Recipient ATA — if missing, create it in the same tx (sender pays the one-time rent, disclosed
  // upstream on the review screen; idempotent so a race with another creator is harmless).
  const ixs: Instruction[] = [];
  if (!(await accountExists(SOLANA_RPC_URL, bs58.encode(recipientAta), {signal}))) {
    // Honest cost pre-check (mirrors createTokenAta): without it the send passes review and dies at
    // broadcast with a raw "custom program error: 0x1" that no friendlySolError pattern matches.
    const lamports = await getBalance(SOLANA_RPC_URL, senderAddress, {signal});
    if (BigInt(lamports) < SOL_ATA_SETUP_MIN_LAMPORTS) {
      throw new Error(M.errors.solana.recipientNoTokenAccount(fmtAsset(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT), token ?? mint));
    }
    ixs.push(buildCreateAtaIdempotentInstruction(publicKey, recipientAta, base58Decode32(destAddress), base58Decode32(mint)));
  }
  ixs.push(buildSplTransferInstruction(senderAta, recipientAta, publicKey, amount));

  const {blockhash} = await getLatestBlockhash(SOLANA_RPC_URL, {signal});
  const message = assembleMessage(publicKey, ixs, base58Decode32(blockhash));
  const raw = signTransaction(message, seed);
  const signature = await sendTransaction(SOLANA_RPC_URL, raw, {signal});
  await confirmTransaction(SOLANA_RPC_URL, signature, {signal});
  return signature;
}

/** What a Solana Pay transfer carries beyond a plain send (see sendSolanaPay). `amount` is RAW
 *  integer units at the asset's decimals (lamports for SOL, 6-decimal base units for USDC) — the
 *  caller parsed the URI's decimal string at review time; `references` are the scanned URI's
 *  base58 reference pubkeys (possibly empty — the spec makes the param optional); `memo` is the
 *  SPL Memo program's on-chain text (null when the URI carried none). */
export type SolanaPayTransfer = {
  recipient: string;
  splToken: string | null;
  amount: bigint;
  references: string[];
  memo: string | null;
};

/** Build, sign, broadcast, and confirm a scanned Solana Pay request (`solana:<recipient>?…`, the
 *  open standard this wallet's own receive QR emits — `solana/payments.ts` is the format's home).
 *  Signs LOCALLY with the device-derived key, exactly like sendSol/sendSpl — non-custodial; dpay
 *  never holds keys or funds, and paying another wallet's standard never becomes a swap.
 *
 *  What makes it a Solana Pay transfer rather than a plain send:
 *    • `reference` — the merchant's matching mechanism. Each reference pubkey is attached to the
 *      transfer instruction as an additional READONLY non-signing account key (the System/Token
 *      programs ignore it; the merchant finds the payment by the key). NOT a memo — the spec's
 *      matching story is account keys, full stop.
 *    • `memo` — the SPL Memo program's text, as its OWN instruction before the transfer (per
 *      spec ordering) when the URI carried one.
 *    • `spl-token` — the URI recipient is the wallet OWNER; the transfer target is the derived
 *      Associated Token Account for (owner, mint), auto-created idempotently when missing with
 *      the same rent pre-check + disclosure sendSpl has. SOL path uses a System transfer, the
 *      USDC path uses `transferChecked` (commits mint + decimals, the solana-pay SDK's choice).
 *
 *  Supports exactly the mints the token registry supports (`solana/tokens.ts` — USDC + EURC
 *  mainnet) — anything else is refused by name at the scan surface AND here, so reaching this seam
 *  with a foreign mint is a wiring error and is thrown as such (the error NAMES the mint pubkey).
 *  `onBroadcast` carries the same "accepted, pre-confirmation" contract as sendSol. Throws
 *  offline / on RPC error / on-chain failure; returns the signature. */
export async function sendSolanaPay(
  secretHex: string,
  transfer: SolanaPayTransfer,
  signal?: AbortSignal,
  onBroadcast?: (signature: string) => void,
): Promise<string> {
  if (!SOLANA_RPC_URL) throw new Error(M.errors.solana.offline);
  if (transfer.splToken !== null) {
    const token = solanaTokenOfMint(transfer.splToken);
    if (token === null) {
      throw new Error(`unsupported spl-token mint for Solana Pay: ${transfer.splToken}`);
    }
  }
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const {accountExists, getBalance, getLatestBlockhash, sendTransaction, confirmTransaction} = await import('./solana/rpc');
  const referenceKeys = transfer.references.map(base58Decode32);
  const ixs: Instruction[] = [];
  if (transfer.memo !== null) ixs.push(buildMemoInstruction(utf8ToBytes(transfer.memo)));
  if (transfer.splToken === null) {
    ixs.push(buildSolTransferInstruction(publicKey, base58Decode32(transfer.recipient), transfer.amount, referenceKeys));
  } else {
    const senderAddress = bs58.encode(publicKey);
    const senderAta = deriveAta(senderAddress, transfer.splToken);
    const recipientAta = deriveAta(transfer.recipient, transfer.splToken);
    const token = solanaTokenOfMint(transfer.splToken) ?? transfer.splToken;
    // Sender ATA first — the device must hold the token account to debit from (fail-closed, same
    // as sendSpl).
    if (!(await accountExists(SOLANA_RPC_URL, bs58.encode(senderAta), {signal}))) {
      throw new Error(M.errors.solana.senderNoTokenAccount(token));
    }
    if (!(await accountExists(SOLANA_RPC_URL, bs58.encode(recipientAta), {signal}))) {
      // Same honest cost pre-check as sendSpl: without it the payment passes review and dies at
      // broadcast with a raw program error no friendlySolError pattern matches.
      const lamports = await getBalance(SOLANA_RPC_URL, senderAddress, {signal});
      if (BigInt(lamports) < SOL_ATA_SETUP_MIN_LAMPORTS) {
        throw new Error(M.errors.solana.recipientNoTokenAccount(fmtAsset(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT), token));
      }
      ixs.push(buildCreateAtaIdempotentInstruction(publicKey, recipientAta, base58Decode32(transfer.recipient), base58Decode32(transfer.splToken)));
    }
    // The registry's decimals for this mint — transferChecked commits to mint + decimals, so a
    // foreign/wrong decimals can never satisfy the payment.
    const decimals = solanaTokenInfo(solanaTokenOfMint(transfer.splToken) ?? '')?.decimals;
    if (decimals == null) throw new Error(`unsupported spl-token mint for Solana Pay: ${transfer.splToken}`);
    ixs.push(buildTransferCheckedInstruction(senderAta, base58Decode32(transfer.splToken), recipientAta, publicKey, transfer.amount, decimals, referenceKeys));
  }

  const {blockhash} = await getLatestBlockhash(SOLANA_RPC_URL, {signal});
  const message = assembleMessage(publicKey, ixs, base58Decode32(blockhash));
  const raw = signTransaction(message, seed);
  const signature = await sendTransaction(SOLANA_RPC_URL, raw, {signal});
  onBroadcast?.(signature);
  await confirmTransaction(SOLANA_RPC_URL, signature, {signal});
  return signature;
}

/** One-time token account (ATA) setup for THIS device's wallet — the receiver-side onboarding for
 *  a registered Solana SPL token (2026-08-14; generalized per-mint 2026-09-06). Builds, signs
 *  LOCALLY (device key), broadcasts, and confirms a single AssociatedTokenProgram.createIdempotent
 *  instruction (payer = owner = the device key, mint = `mint`). Non-custodial: the device key
 *  signs; dpay never holds keys or funds.
 *
 *  Honest cost: the one-time account rent + transaction fee come out of the device's SOL balance.
 *  Pre-checked with a friendly error when the balance can't cover the ESTIMATE (the chain enforces
 *  the real value — the constant is display/pre-check only, never trust-bearing). Throws when SOL
 *  is offline, when the rail is incoherent (mainnet mint on a non-mainnet RPC), on insufficient
 *  SOL, or on any RPC/on-chain failure. Returns the transaction signature. */
export async function createTokenAta(secretHex: string, mint: string, signal?: AbortSignal): Promise<string> {
  const token = solanaTokenOfMint(mint);
  if (!SOLANA_RPC_URL || !solanaTokenAvailable(mint)) throw new Error(M.errors.solana.tokenUnavailable(token ?? mint));
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const ownerAddress = bs58.encode(publicKey);
  const ata = deriveAta(ownerAddress, mint);
  const {getBalance, getLatestBlockhash, sendTransaction, confirmTransaction} = await import('./solana/rpc');

  const lamports = await getBalance(SOLANA_RPC_URL, ownerAddress, {signal});
  if (BigInt(lamports) < SOL_ATA_SETUP_MIN_LAMPORTS) {
    throw new Error(M.errors.solana.ownTokenAccountRent(fmtAsset(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT), token ?? mint));
  }

  const ix = buildCreateAtaIdempotentInstruction(publicKey, ata, publicKey, base58Decode32(mint));
  const {blockhash} = await getLatestBlockhash(SOLANA_RPC_URL, {signal});
  const message = assembleMessage(publicKey, [ix], base58Decode32(blockhash));
  const raw = signTransaction(message, seed);
  const signature = await sendTransaction(SOLANA_RPC_URL, raw, {signal});
  await confirmTransaction(SOLANA_RPC_URL, signature, {signal});
  return signature;
}

// --- existing exports (unchanged) ----------------------------------------------

// ============================================================================
// Phase 2 — honest Solana SOL + USDC balances (2026-08-12 unified asset selection rewrite).
//
// The wallet must render a distinct Solana-USDC balance row AND keep five states distinguishable
// (plan invariant #10): loading, known-absent ATA, known zero balance, stale/unavailable, RPC error.
// `getSolanaUsdcBalance` is the discriminated-union reader; the `useSolanaBalances` hook translates
// it into per-status state for the Wallet.
// ============================================================================

/** The Solana token balance result — a discriminated union capturing the four states the plan
 *  requires stay distinct at the seam boundary (the hook maps them to per-status UI state):
 *    - `offline`: SOLANA_RPC_URL empty (offline inner loop) OR `solanaTokenAvailable(mint)` false
 *      (a mainnet mint pointed at a non-mainnet RPC — fail-closed rather than read a non-existent
 *      token). No network call is made.
 *    - `absent`: the device's token account for the mint does NOT exist on-chain. The user has
 *      never received this token; this is a KNOWN zero, not an unverifiable state.
 *    - `balance`: the ATA exists and `getTokenAccountBalance` returned the exact raw `amount` (a
 *      decimal-digit STRING — money-critical, never coerced through JS `number`) + `decimals`
 *      (the chain's own answer, expected to equal the registry's). A zero balance is
 *      `{kind:'balance', amount:'0', …}` — still a balance, not absent.
 *    - `error`: RPC failure (existence check or balance read threw). Transient/unverifiable; the
 *      hook preserves any prior amount (it does NOT turn a prior value into zero). */
export type SolanaTokenBalanceResult =
  | {kind: 'offline'}
  | {kind: 'absent'}
  | {kind: 'balance'; amount: string; decimals: number}
  | {kind: 'error'};

/** Read the device's token-account balance for `mint` as a discriminated result. Derives the
 *  device ATA from the seed + mint, checks on-chain existence, and if present reads the exact raw
 *  token balance.
 *
 *  ONLINE — returns `{kind:'offline'}` (no throw, no network) when `SOLANA_RPC_URL` is empty OR
 *  `solanaTokenAvailable(mint)` is false (mirroring `getSolanaBalance`'s offline no-op). On any RPC
 *  error returns `{kind:'error'}` and logs the ATA + message at `console.warn` (debuggability — a
 *  silent error here would render as a stale balance forever). */
export async function getSolanaTokenBalance(
  secretHex: string,
  mint: string,
  signal?: AbortSignal,
): Promise<SolanaTokenBalanceResult> {
  if (!SOLANA_RPC_URL || !solanaTokenAvailable(mint)) return {kind: 'offline'};
  const {accountExists, getTokenAccountBalance} = await import('./solana/rpc');
  const address = deriveSolanaAddress(secretHex);
  const ataAddress = bs58.encode(deriveAta(address, mint));
  try {
    const exists = await accountExists(SOLANA_RPC_URL, ataAddress, {signal});
    if (!exists) return {kind: 'absent'};
    const {amount, decimals} = await getTokenAccountBalance(SOLANA_RPC_URL, ataAddress, {signal});
    return {kind: 'balance', amount, decimals};
  } catch (e) {
    console.warn(`getSolanaTokenBalance: RPC failure for ATA ${ataAddress}:`, e instanceof Error ? e.message : String(e));
    return {kind: 'error'};
  }
}

/** Whether the Solana RPC rail is configured (RPC URL non-empty). A pure sync read of the constant —
 *  independent of relay `online` (plan invariant #9 — the relay could be reachable while SOL RPC is
 *  not, or vice versa). The token-coherence sense (a mainnet mint pointed at a non-mainnet RPC) is
 *  the separate `solanaTokenAvailable(mint)` predicate. */
export function isSolanaRpcAvailable(): boolean {
  return SOLANA_RPC_URL !== '';
}

// ============================================================================
// v2 recent-blockhash payment seam — the ONLY Solana payment path (the durable-nonce rail was
// deleted). The lifecycle:
//   createSolPaymentRequest — ONLINE merchant fetches genesis hash + fresh blockhash + builds SolReqV2.
//   signSolPayment / signSplPayment — OFFLINE payer signs the canonical message (no network).
//   broadcastSolPayment — ONLINE merchant strictly verifies, freshness-checks, broadcasts, confirms.
// See `2026-08-12-solana-recent-blockhash-rewrite-plan.md` "Freshness rules" + invariants #4/#5/#12/#13.
// ============================================================================

/** ONLINE merchant. Fetches the cluster genesis hash (cached) + a fresh blockhash (with its context
 *  slot), builds a `SolReqV2` with `iat = now` and `exp = iat + SOL_PAYMENT_MAX_WINDOW_SECONDS`, and
 *  encodes to the canonical `solreq:v2?<base64url>` URI.
 *
 *  Throws on RPC failure, genesis mismatch (wrong cluster — invariant #4 fail-closed), or when the
 *  rail is offline (`SOLANA_RPC_URL` empty). Never returns a silent empty result. */
export async function createSolPaymentRequest(
  input: {
    to: string;
    amt: string;
    cur: string;
    mint: string | null;
    toAta: string | null;
    name: string;
    memo: string;
  },
  signal: AbortSignal,
): Promise<{request: SolReqV2; uri: string}> {
  if (!isSolanaRpcAvailable()) throw new Error(M.errors.solana.offline);
  const rpc = await import('./solana/rpc');

  // Cluster identity check — fail-closed on a non-mainnet endpoint (genesis hash is immutable).
  const genesis = await rpc.getGenesisHash(SOLANA_RPC_URL, {signal});
  if (genesis !== SOL_GENESIS_HASH) {
    throw new Error(`createSolPaymentRequest: cluster genesis mismatch (got ${genesis}, expected ${SOL_GENESIS_HASH})`);
  }

  // Fresh blockhash + its observation slot. The context slot threads as `minContextSlot` for every
  // downstream freshness call in broadcastSolPayment so reorg-awareness is consistent.
  const bh = await rpc.getLatestBlockhash(SOLANA_RPC_URL, {signal});

  // iat captured when the RPC result is in hand; exp = iat + the codec's frozen max lifetime.
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SOL_PAYMENT_MAX_WINDOW_SECONDS;

  const reqInput: SolReqInput = {
    rid: generateRid(),
    net: 'mainnet-beta',
    bh: bh.blockhash,
    lvh: bh.lastValidBlockHeight,
    slot: bh.contextSlot,
    iat,
    exp,
    to: input.to,
    amt: input.amt,
    cur: input.cur,
    mint: input.mint,
    toAta: input.toAta,
    name: input.name,
    memo: input.memo,
  };
  const uri = encodeSolReq(reqInput);
  const request: SolReqV2 = {v: 2, ...reqInput};
  return {request, uri};
}

/** OFFLINE payer (SOL). NO network. Derives the payer keypair from `secretHex`, builds the canonical
 *  SOL message (`{Memo, System.transfer}` bound to the request URI + amount), signs it, and returns
 *  the `SolPayV2 {v:2, rid, tx}`. Pure + synchronous. */
export function signSolPayment(secretHex: string, request: SolReqV2): SolPayV2 {
  if (request.cur !== 'SOL') throw new Error('signSolPayment: expected SOL currency');
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const message = buildCanonicalSolMessage(publicKey, request);
  const tx = signTransaction(message, seed);
  const payInput: SolPayInput = {rid: request.rid, tx};
  return {v: 2, ...payInput};
}

/** OFFLINE payer (any registered SPL token — USDC, EURC, …). NO network. Same as `signSolPayment`
 *  with the generic SPL canonical builder (`{Memo, Token.transferChecked}` — commits to the
 *  request mint + ITS registry decimals + ATAs). Dispatch is per token: the decimals come from
 *  the registry via the request's `cur`/`mint`, never from a hard-coded literal. */
export function signSplPayment(secretHex: string, request: SolReqV2): SolPayV2 {
  if (request.cur === 'SOL') throw new Error('signSplPayment: expected an SPL-token currency (not SOL)');
  if (!request.mint || !request.toAta) throw new Error('signSplPayment: mint and toAta required for an SPL token');
  const info = solanaTokenInfo(request.cur);
  const decimals = info?.mint === request.mint ? info.decimals : solanaTokenInfo(solanaTokenOfMint(request.mint) ?? '')?.decimals;
  if (decimals == null) throw new Error(`signSplPayment: unsupported spl-token (cur=${request.cur}, mint=${request.mint})`);
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const message = buildCanonicalSplMessage(publicKey, request, decimals);
  const tx = signTransaction(message, seed);
  const payInput: SolPayInput = {rid: request.rid, tx};
  return {v: 2, ...payInput};
}

/** ONLINE merchant broadcast + confirm. STRICT. Runs the canonical-message rebuild + Ed25519 verify
 *  BEFORE any network send, freshness-checks the blockhash + block height against the request, then
 *  broadcasts with preflight and confirms via history-aware signature status polling — and before
 *  answering SETTLED, re-reads the confirmed transaction and requires its body to BE the canonical
 *  message (settle-verify, OPEN_ISSUES 6(b): a signature confirming is not the same as THIS
 *  payment confirming).
 *
 *  Money-critical freshness state machine (invariants #4/#5/#10/#12/#13):
 *    • URI ≠ request          → throw (programming error, never silent).
 *    • Malformed payment      → REJECTED, sig='' (definitive — never broadcast).
 *    • Strict verify fails    → REJECTED, sig='' (sig/parse/semantic failure is BLOCKING).
 *    • Blockhash invalid OR
 *      height > lvh pre-send  → REJECTED, sig=<verified> (authoritative on-chain expiry).
 *    • sendTransaction RPC sig
 *      ≠ local verified sig   → UNREACHABLE, sig=<verified> (honest unknown — never assume success).
 *    • sendTransaction
 *      InstructionError/etc.  → REJECTED, sig=<verified> (definitive Solana rejection).
 *    • sendTransaction other
 *      error                  → UNREACHABLE, sig=<verified> (honest unknown — tx MAY still land).
 *    • Confirm: status w/err  → REJECTED, sig=<verified> (on-chain rejection).
 *    • Confirm: confirmed +
 *      re-read body verified  → SETTLED, sig=<verified> (recompiled body == canonical, err==null).
 *    • Confirm: confirmed +
 *      re-read body err≠null  → REJECTED, sig=<verified> (the chain's own failure record).
 *    • Confirm: confirmed +
 *      re-read body ≠
 *      canonical              → MISMATCH(3), sig=<verified> (terminal doubt — well-formed confirmed
 *                               body that isn't this request, incl. v0/ALT claims; merchant must
 *                               NOT treat it as received, payer gets honest pending, never a
 *                               decline).
 *    • Confirm: confirmed but
 *      body unreadable
 *      (null/malformed/trans-
 *      ient RPC)             → keep polling to the deadline (unverifiable is NEVER a verdict).
 *    • Confirm timeout +
 *      authoritative expiry
 *      (height>lvh AND bh
 *      invalid@ctx≥slot AND
 *      history status null
 *      @ctx≥invaliditySlot)   → REJECTED, sig=<verified> (the tx CANNOT land — blockhash dead).
 *    • Confirm timeout,
 *      anything else          → UNREACHABLE, sig=<verified> (honest unknown — invariant #12).
 *
 *  `opts.confirmTimeoutMs` / `opts.pollMs` default to `SOL_BROADCAST_TIMEOUT_MS` / 200ms; tests pass
 *  shorter values so the timeout branches are exercisable in milliseconds. */
export async function broadcastSolPayment(
  request: SolReqV2,
  canonicalRequestUri: string,
  payment: SolPayV2,
  signal: AbortSignal,
  opts?: {confirmTimeoutMs?: number; pollMs?: number},
): Promise<SolReceiptV2> {
  // 1. Defense: the canonical URI must match the request. A mismatch is a programming error (caller
  //    passed a stale/foreign URI for this request); throw rather than risk broadcasting under wrong
  //    claims. Strip `v` (the codec stamps it) before re-encoding.
  const {v: _dropV, ...reqInput} = request;
  void _dropV;
  if (encodeSolReq(reqInput) !== canonicalRequestUri) {
    throw new Error('broadcastSolPayment: canonicalRequestUri does not match request (programming error)');
  }
  const rid = request.rid;

  // 2. Extract the payer pubkey from the signed transaction. Malformed → definitive reject (no sig
  //    trusted, no broadcast).
  const parts = extractSignedTxParts(payment.tx);
  if (!parts) {
    console.warn(`broadcastSolPayment: malformed payment tx for rid=${rid}`);
    return {status: RECEIPT_REJECTED, rid, sig: ''};
  }

  // 3. Build the expected canonical message from the open request + extracted payer. Non-SOL
  //    requests carry a registry mint; the canonical builder commits to ITS registry decimals.
  let expectedMessage: Uint8Array;
  if (request.cur === 'SOL') {
    expectedMessage = buildCanonicalSolMessage(parts.feePayer, request);
  } else {
    const info = solanaTokenInfo(request.cur);
    const decimals = info?.mint === request.mint ? info.decimals : solanaTokenInfo(solanaTokenOfMint(request.mint ?? '') ?? '')?.decimals;
    if (decimals == null) throw new Error(`broadcastSolPayment: unsupported spl-token mint ${request.mint}`);
    expectedMessage = buildCanonicalSplMessage(parts.feePayer, request, decimals);
  }

  // 4. STRICT verify: signed message must be byte-equal to the canonical rebuild + Ed25519 valid.
  //    Failure is BLOCKING (invariant #5) — never broadcast a semantically wrong signature.
  const verifyResult = verifySolPayment(expectedMessage, payment);
  if (!verifyResult.ok) {
    console.warn(`broadcastSolPayment: strict verify failed (${verifyResult.reason}) for rid=${rid}`);
    return {status: RECEIPT_REJECTED, rid, sig: ''};
  }

  // 5. The verified first signature is the stable payment identity for the receipt (invariant #10:
  //    the same signed bytes can be rebroadcast idempotently). Used for all downstream receipt codes.
  const sig = verifyResult.signature;

  if (!isSolanaRpcAvailable()) throw new Error(M.errors.solana.offline);
  const rpc = await import('./solana/rpc');

  // 6. Freshness pre-broadcast (invariant #4). The request's `slot` is `minContextSlot` so reorg-aware
  //    behavior is consistent. Blockhash invalid OR current height past lvh → authoritative on-chain
  //    expiry → definitive reject (not unreachable — the tx cannot land).
  let bhValid: {valid: boolean; contextSlot: number};
  let currentHeight: number;
  try {
    [bhValid, currentHeight] = await Promise.all([
      rpc.isBlockhashValid(SOLANA_RPC_URL, request.bh, {signal, minContextSlot: request.slot}),
      rpc.getBlockHeight(SOLANA_RPC_URL, {signal, minContextSlot: request.slot}),
    ]);
  } catch (e) {
    // A freshness-check RPC failure is NOT an authoritative reject — the RPC is unavailable, not the
    // blockhash. Honest unknown (the tx MAY still be broadcastable on retry).
    console.warn(`broadcastSolPayment: freshness RPC failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
    return {status: RECEIPT_UNREACHABLE, rid, sig};
  }
  if (!bhValid.valid || currentHeight > request.lvh) {
    console.warn(`broadcastSolPayment: pre-broadcast expiry (bhValid=${bhValid.valid}, height=${currentHeight}, lvh=${request.lvh}) for rid=${rid}`);
    return {status: RECEIPT_REJECTED, rid, sig};
  }

  // 7. Broadcast with preflight (skipPreflight:false) + the request's minContextSlot. The RPC-returned
  //    signature MUST exactly equal the locally-extracted `sig` — a mismatch means the node accepted a
  //    DIFFERENT transaction than the one we verified (honest unknown; do NOT assume success).
  let broadcastSig: string;
  try {
    broadcastSig = await rpc.sendTransaction(SOLANA_RPC_URL, payment.tx, {
      signal,
      minContextSlot: request.slot,
      config: {commitment: SOL_PAYMENT_COMMITMENT, minContextSlot: request.slot, skipPreflight: false},
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.warn(`broadcastSolPayment: sendTransaction error for rid=${rid}: ${msg}`);
    // A class of error that's a definitive Solana rejection (the tx was definitively NOT accepted).
    if (/Instruction|insufficient|no record of a prior credit|simulation failed|debit|custom|already|blockhash|nonce/i.test(msg)) {
      return {status: RECEIPT_REJECTED, rid, sig};
    }
    return {status: RECEIPT_UNREACHABLE, rid, sig};
  }
  if (broadcastSig !== sig) {
    console.warn(`broadcastSolPayment: sig identity mismatch (broadcast=${broadcastSig}, local=${sig}) for rid=${rid}`);
    return {status: RECEIPT_UNREACHABLE, rid, sig};
  }

  // 8. Confirm via history-aware signature status polling + block-height observation. Each RPC call is
  //    try/caught — a transient failure during confirm continues polling up to the timeout; only the
  //    timeout boundary triggers the authoritative-expiry decision (invariant #12).
  const deadline = Date.now() + (opts?.confirmTimeoutMs ?? SOL_BROADCAST_TIMEOUT_MS);
  const pollMs = opts?.pollMs ?? 200;
  let latestHeight: number | null = null;
  let latestHistoryStatus: {status: SolanaSignatureStatus | null; contextSlot: number} | null = null;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('aborted');

    try {
      const statusResult = await rpc.getSignatureStatusesForSig(SOLANA_RPC_URL, sig, {signal});
      latestHistoryStatus = statusResult;
      if (statusResult.status) {
        if (statusResult.status.err != null) {
          console.warn(`broadcastSolPayment: on-chain rejection for rid=${rid}: ${JSON.stringify(statusResult.status.err)}`);
          return {status: RECEIPT_REJECTED, rid, sig};
        }
        if (statusResult.status.confirmationStatus === 'confirmed' || statusResult.status.confirmationStatus === 'finalized') {
          // Confirmed alone is NOT settled (OPEN_ISSUES 6(b)): the signature says some transaction
          // with this id confirmed — the re-read must prove the confirmed body IS the canonical
          // message this merchant verified before broadcasting. No new budget: this rides the same
          // confirm deadline; every failure of the re-read keeps polling (unverifiable is NEVER a
          // verdict — three-verdict discipline, see services/rail.ts).
          let detail: SolanaTransactionDetail | null = null;
          let detailRead = false;
          try {
            detail = await rpc.getTransaction(SOLANA_RPC_URL, sig, {signal});
            detailRead = true;
          } catch (e) {
            console.warn(`broadcastSolPayment: transient getTransaction failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
          }
          if (detailRead) {
            const evidence = verifySettledTransaction(expectedMessage, detail);
            if (evidence.kind === 'verified') {
              return {status: RECEIPT_SETTLED, rid, sig};
            }
            if (evidence.kind === 'onchain-error') {
              console.warn(`broadcastSolPayment: on-chain error record for rid=${rid}`);
              return {status: RECEIPT_REJECTED, rid, sig};
            }
            if (evidence.kind === 'mismatch') {
              // TERMINAL doubt — the signature confirms a DIFFERENT well-formed transaction. The
              // merchant must not treat it as received; the payer hears honest pending (code 3).
              console.warn(`broadcastSolPayment: settle-verify mismatch for rid=${rid}: ${evidence.reason}`);
              return {status: RECEIPT_MISMATCH, rid, sig};
            }
            console.warn(`broadcastSolPayment: settle-verify unverifiable for rid=${rid}: ${evidence.reason}`);
          }
        }
      }
    } catch (e) {
      console.warn(`broadcastSolPayment: transient getSignatureStatuses failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
    }

    try {
      latestHeight = await rpc.getBlockHeight(SOLANA_RPC_URL, {signal, minContextSlot: request.slot});
    } catch (e) {
      console.warn(`broadcastSolPayment: transient getBlockHeight failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
    }

    await new Promise(r => setTimeout(r, pollMs));
  }

  // Timeout — determine AUTHORITATIVE expiry (invariants #12/#13 + "Record the context slot" rule).
  // Authoritative-expiry requires ALL THREE:
  //   (a) currentHeight > request.lvh (blockhash window passed), AND
  //   (b) isBlockhashValid returns false at contextSlot >= request.slot (reorg-safe observation), AND
  //   (c) history-aware signature status is null at contextSlot >= invalidityContextSlot (proves the
  //       tx never landed — observed AFTER the blockhash was demonstrably dead).
  // The isBlockhashValid + getSignatureStatuses calls are done in that order so the sig-status context
  // is >= the invalidity context. Anything inconsistent/unavailable → honest unknown (UNREACHABLE).
  const heightExpired = latestHeight !== null && latestHeight > request.lvh;

  let invalidityContextSlot = 0;
  try {
    const bhv = await rpc.isBlockhashValid(SOLANA_RPC_URL, request.bh, {signal, minContextSlot: request.slot});
    if (!bhv.valid && bhv.contextSlot >= request.slot) {
      invalidityContextSlot = bhv.contextSlot;
    }
  } catch (e) {
    console.warn(`broadcastSolPayment: timeout isBlockhashValid failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
  }

  let historyProvesAbsent = false;
  try {
    const statusResult = await rpc.getSignatureStatusesForSig(SOLANA_RPC_URL, sig, {signal});
    latestHistoryStatus = statusResult;
    if (
      invalidityContextSlot >= request.slot &&
      statusResult.status === null &&
      statusResult.contextSlot >= invalidityContextSlot
    ) {
      historyProvesAbsent = true;
    }
  } catch (e) {
    console.warn(`broadcastSolPayment: timeout getSignatureStatuses failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
  }

  if (heightExpired && invalidityContextSlot >= request.slot && historyProvesAbsent) {
    console.warn(`broadcastSolPayment: authoritative expiry for rid=${rid} (height=${latestHeight}, lvh=${request.lvh}, invaliditySlot=${invalidityContextSlot})`);
    return {status: RECEIPT_REJECTED, rid, sig};
  }
  console.warn(`broadcastSolPayment: honest unknown for rid=${rid} (height=${latestHeight}, lvh=${request.lvh}, invaliditySlot=${invalidityContextSlot}, historyPresent=${latestHistoryStatus?.status != null})`);
  return {status: RECEIPT_UNREACHABLE, rid, sig};
}
