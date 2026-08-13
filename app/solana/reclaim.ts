// Phase 6 — ISOLATED legacy durable-nonce reclaim. NOT a payment path (invariant #15 of the
// 2026-08-12 recent-blockhash rewrite). The shipped v1 durable-nonce account (derived at
// m/44'/501'/0'/1' from the recovery seed) was funded before the v2 rewrite; this module drains its
// locked lamports back to the user's main Solana wallet (m/44'/501'/0'/0') in a one-time online
// Settings action. It has ZERO imports from the payment code (qr.ts / payments.ts / payment
// components) — the only retained legacy surface, deliberately walled off.
//
// The minimum legacy nonce derivation + account parser + withdraw builder live here. The PURE pieces
// (derive, inspect, build) are unit-testable with byte-exact goldens; the one ONLINE orchestrator
// (reclaimNonceAccount) coordinates the cluster-identity check, fee quote, broadcast, and confirm.

import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {hexToBytes} from '../lib/format';
import {bytesToBase64} from '../lib/base64';
import {
  SOLANA_RPC_URL,
  SOL_GENESIS_HASH,
  SOL_PAYMENT_COMMITMENT,
  SOL_SEND_TIMEOUT_MS,
} from '../config/constants';
import {deriveSlip10Ed25519, deriveSolanaKeypair} from './identity';
import {
  assembleMessage,
  base58Decode32,
  encodeU32LE,
  encodeU64LE,
  signTransaction,
  SYSTEM_PROGRAM_BYTES,
} from './tx';
import type {Instruction} from './tx';
import {clearSolNonce} from '../services/solNoncePersist';

// SLIP-10 path m/44'/501'/0'/1' — the SHIPPED durable-nonce account keypair (sibling of the main
// wallet m/44'/501'/0'/0'; only the hardened 4th index differs: 1 vs 0). Deterministic from the
// recovery seed, so a restored wallet rediscovers the same account with no AsyncStorage marker.
const NONCE_ACCOUNT_PATH = [44, 501, 0, 1].map((i) => i + 0x80000000);

// Sysvar addresses referenced by WithdrawNonceAccount. NOTE the digit `1` in `B1ock` — the real
// on-chain base58 sysvar spelling (a Solana quirk).
const SYSVAR_RECENT_BLOCKHASHES_ADDRESS = 'SysvarRecentB1ockHashes11111111111111111111';
const SYSVAR_RENT_ADDRESS = 'SysvarRent111111111111111111111111111111111';
const SYSVAR_RECENT_BLOCKHASHES_BYTES = base58Decode32(SYSVAR_RECENT_BLOCKHASHES_ADDRESS);
const SYSVAR_RENT_BYTES = base58Decode32(SYSVAR_RENT_ADDRESS);

// SystemInstruction::WithdrawNonceAccount discriminator (bincode u32 LE = 5).
const IX_WITHDRAW_NONCE = 5;

// Durable-nonce accounts are exactly 80 bytes on-chain (NonceAccountLayout). Reclaim only drains an
// Initialized, device-authority-owned account; any other shape fails closed.
const NONCE_ACCOUNT_DATA_LENGTH = 80;

/** @internal Phase 6 reclaim — derives the shipped legacy nonce-account keypair (m/44'/501'/0'/1')
 *  from the recovery seed. Needed for the ACCOUNT ADDRESS only — the withdrawal does NOT sign with
 *  the nonce-account key (the main wallet at /0' is the authority that authorizes the withdraw). */
export function deriveNonceAccountKeypair(secretHex: string): {
  seed: Uint8Array;
  publicKey: Uint8Array;
  address: string;
} {
  const derived = deriveSlip10Ed25519(hexToBytes(secretHex), NONCE_ACCOUNT_PATH);
  // Defensive copy: the SLIP-10 leaf is a view into an HMAC output buffer that ed25519's internal
  // sha512 may overwrite, so materialise an independent 32-byte seed before key derivation.
  const seed = new Uint8Array(32);
  seed.set(derived);
  const publicKey = ed25519.getPublicKey(seed);
  return {seed, publicKey, address: bs58.encode(publicKey)};
}

/** The outcome of PURELY inspecting a nonce account's on-chain data + balance against the device
 *  authority. Never produced by a throw — `inspectNonceAccount` maps every malformed shape to a kind. */
export type ReclaimInspection =
  | {kind: 'absent'}
  | {kind: 'reclaimable'; lamports: bigint}
  | {kind: 'uninitialized'}
  | {kind: 'wrong-authority'}
  | {kind: 'malformed'};

/** PURE. Inspect a durable-nonce account's raw 80-byte data + balance and decide whether it is
 *  reclaimable by `expectedAuthorityBytes`. NEVER throws — every parse issue maps to 'malformed'.
 *
 *  NonceAccountLayout: u32 version (0=legacy, 1=current) | u32 state (0=Uninitialized, 1=Initialized)
 *  | 32B authority | 32B storedBlockhash | u64 lamports_per_signature (fee, NOT the balance).
 *  The account BALANCE (the reclaimable lamports) is the `balance` argument (from getAccountInfo),
 *  NOT the u64 at offset 72 (that's the per-signature fee the stored blockhash quotes). */
export function inspectNonceAccount(
  data: Uint8Array | null,
  balance: bigint,
  expectedAuthorityBytes: Uint8Array,
): ReclaimInspection {
  if (data === null) return {kind: 'absent'};
  if (data.length !== NONCE_ACCOUNT_DATA_LENGTH) return {kind: 'malformed'};
  try {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const version = dv.getUint32(0, true);
    const state = dv.getUint32(4, true);
    // Version must be 0 (legacy) or 1 (current). Any other tag is an unknown layout → fail closed.
    if (version !== 0 && version !== 1) return {kind: 'malformed'};
    // state=0 → Uninitialized (account exists but never initialized, or already closed-and-reopened).
    if (state !== 1) return {kind: 'uninitialized'};
    const authority = data.subarray(8, 40);
    for (let i = 0; i < 32; i++) {
      if (authority[i] !== expectedAuthorityBytes[i]) return {kind: 'wrong-authority'};
    }
    return {kind: 'reclaimable', lamports: balance};
  } catch {
    return {kind: 'malformed'};
  }
}

/** PURE. Build the unsigned legacy message for a WithdrawNonceAccount instruction that drains the
 *  full `lamports` balance from the nonce account to the main wallet. The main wallet is the fee
 *  payer, the nonce authority (signer), AND the destination — all the same key.
 *
 *  Byte-exact vs the @solana/web3.js `SystemProgram.nonceWithdraw` golden
 *  (.dev/sol-poc/11-withdraw-nonce-golden.mjs). The instruction references FIVE account metas: the
 *  nonce account (writable), the destination (writable, = main wallet), SysvarRecentBlockhashes,
 *  SysvarRent, and the authority (signer, = main wallet again). The destination + authority are the
 *  SAME pubkey; `assembleMessage` dedups them into one account-table slot with merged
 *  (signer=true, writable=true) flags. Omitting SysvarRent produces a tx the runtime rejects. */
export function buildWithdrawNonceMessage(
  mainWalletBytes: Uint8Array,
  nonceAccountBytes: Uint8Array,
  lamports: bigint,
  recentBlockhash: Uint8Array,
): Uint8Array {
  if (lamports < 0n) throw new Error('lamports must be non-negative');
  // WithdrawNonceAccount data: u32(5) || u64(lamports).
  const data: number[] = [];
  encodeU32LE(data, IX_WITHDRAW_NONCE);
  encodeU64LE(data, lamports);
  const withdrawIx: Instruction = {
    programId: SYSTEM_PROGRAM_BYTES,
    keys: [
      {pubkey: nonceAccountBytes, signer: false, writable: true},
      {pubkey: mainWalletBytes, signer: false, writable: true},
      {pubkey: SYSVAR_RECENT_BLOCKHASHES_BYTES, signer: false, writable: false},
      {pubkey: SYSVAR_RENT_BYTES, signer: false, writable: false},
      {pubkey: mainWalletBytes, signer: true, writable: false},
    ],
    data: new Uint8Array(data),
  };
  return assembleMessage(mainWalletBytes, [withdrawIx], recentBlockhash);
}

/** The full reclaim outcome surfaced to the UI. Each kind maps to a distinct honest message:
 *  absent (nothing to reclaim — hide the section), reclaimed (success — funds returned + sig),
 *  insufficient-fee (the main wallet can't cover the fee), unknown (sent but unconfirmed — honest),
 *  offline (no RPC configured), error (definitive failure — show the message). */
export type ReclaimResult =
  | {kind: 'absent'}
  | {kind: 'reclaimed'; sig: string; lamports: bigint}
  | {kind: 'insufficient-fee'; fee: bigint; balance: bigint}
  | {kind: 'unknown'; sig: string; lamports: bigint}
  | {kind: 'offline'}
  | {kind: 'error'; message: string};

/** The OLD nonce-storage key (`dpay.sol.nonce.v1.<pubkeyHex>`) was keyed by the IC IDENTITY pubkey
 *  (the value in `Identity.publicHex`), NOT the derived Solana address — the payment code had the IC
 *  identity in scope, not the Solana address. So to clear the exact key createNonceAccount wrote, we
 *  re-derive the IC ed25519 public key from the same seed. Pure + synchronous. */
function icPublicHexFromSeed(secretHex: string): string {
  const pub = ed25519.getPublicKey(hexToBytes(secretHex));
  let hex = '';
  for (let i = 0; i < pub.length; i++) hex += pub[i].toString(16).padStart(2, '0');
  return hex;
}

/** The check-only outcome for the UI's two-step flow (inspect → show amount → confirm → drain).
 *  Mirrors ReclaimInspection but adds offline/error so the UI can render every state without a try/
 *  catch. Distinct from ReclaimResult (the drain outcome) — inspecting never broadcasts. */
export type ReclaimCheck = ReclaimInspection | {kind: 'offline'} | {kind: 'error'; message: string};

/** READ-ONLY check: derive the legacy nonce account, verify cluster identity, read + inspect the
 *  account. Returns whether it is reclaimable (and how many lamports) WITHOUT broadcasting. The UI
 *  calls this to render the checking/absent/reclaimable/wrong-authority/malformed states, then calls
 *  `reclaimNonceAccount` on user confirm. NEVER throws across the UI boundary.
 *
 *  `reclaimNonceAccount` re-runs this same inspect logic internally (intentional re-validation right
 *  before broadcast — the account state is re-checked at confirm time, not trusted from the check). */
export async function inspectReclaim(secretHex: string, signal: AbortSignal): Promise<ReclaimCheck> {
  if (!SOLANA_RPC_URL) return {kind: 'offline'};
  const reclaimCtrl = new AbortController();
  const timer = setTimeout(() => reclaimCtrl.abort(), SOL_SEND_TIMEOUT_MS);
  const onCallerAbort = () => reclaimCtrl.abort();
  if (signal.aborted) reclaimCtrl.abort();
  else signal.addEventListener('abort', onCallerAbort, {once: true});
  try {
    const rpc = await import('./rpc');
    const mainWallet = deriveSolanaKeypair(secretHex);
    const nonceAccount = deriveNonceAccountKeypair(secretHex);
    const genesis = await rpc.getGenesisHash(SOLANA_RPC_URL, {signal: reclaimCtrl.signal});
    if (genesis !== SOL_GENESIS_HASH) {
      return {kind: 'error', message: `cluster genesis mismatch (got ${genesis}, expected ${SOL_GENESIS_HASH})`};
    }
    const account = await rpc.getAccountInfo(SOLANA_RPC_URL, nonceAccount.address, {signal: reclaimCtrl.signal});
    return inspectNonceAccount(account?.data ?? null, account?.lamports ?? 0n, mainWallet.publicKey);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/aborted/i.test(msg)) return {kind: 'error', message: 'check cancelled'};
    return {kind: 'error', message: msg};
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
}

/** ONLINE reclaim orchestrator. Drains the deterministic legacy nonce account's full balance back to
 *  the main wallet. Every RPC op runs under a reclaim-scoped deadline (first-abort-wins with the
 *  caller's signal). NEVER throws across the UI boundary — every failure maps to an honest
 *  ReclaimResult (offline / error / unknown / insufficient-fee / absent / reclaimed).
 *
 *  Steps: derive main + nonce keys → cluster-identity check (fail-closed on wrong cluster) → read the
 *  account (one getAccountInfo: balance + 80-byte data in one round trip) → inspect → if absent,
 *  clear the stale storage key best-effort + return 'absent'; if not reclaimable, map the inspection
 *  kind to a result; if reclaimable, fetch a fresh blockhash, build the withdraw message, quote the
 *  fee, verify the main wallet can pay it, sign, broadcast, confirm. On confirm: clear storage +
 *  'reclaimed'. On confirm timeout: 'unknown' (the tx may still land — never a false failure). On
 *  confirm on-chain error or RPC failure: 'error' with the message.
 *
 *  `opts` (test-only — mirrors broadcastSolPayment's seam) lets the test harness shrink the confirm
 *  timeout + poll spacing so the 'unknown'/timeout path resolves in milliseconds instead of 60s. The
 *  UI omits it and gets the SOL_* production defaults. */
export async function reclaimNonceAccount(
  secretHex: string,
  signal: AbortSignal,
  opts?: {confirmTimeoutMs?: number; pollMs?: number},
): Promise<ReclaimResult> {
  if (!SOLANA_RPC_URL) return {kind: 'offline'};

  const confirmTimeoutMs = opts?.confirmTimeoutMs ?? SOL_SEND_TIMEOUT_MS;
  // The reclaim-scoped deadline is deliberately 2× the confirm timeout so confirmTransaction's OWN
  // typed timeout fires first (→ 'unknown') rather than the reclaim abort (→ 'error'). The reclaim
  // deadline is the backstop for the pre-confirm RPC ops (genesis/accountInfo/blockhash/fee/balance/
  // send) when the caller hasn't armed its own signal deadline.
  const reclaimDeadlineMs = confirmTimeoutMs * 2;
  const reclaimCtrl = new AbortController();
  const timer = setTimeout(() => reclaimCtrl.abort(), reclaimDeadlineMs);
  const onCallerAbort = () => reclaimCtrl.abort();
  if (signal.aborted) reclaimCtrl.abort();
  else signal.addEventListener('abort', onCallerAbort, {once: true});
  const reclaimSignal = reclaimCtrl.signal;

  const mainWallet = deriveSolanaKeypair(secretHex);
  const nonceAccount = deriveNonceAccountKeypair(secretHex);
  const icPubHex = icPublicHexFromSeed(secretHex);

  try {
    const rpc = await import('./rpc');

    // Cluster identity — fail-closed on a non-mainnet RPC. A wrong-cluster endpoint must never drain
    // (or appear to drain) a mainnet account. Mismatch → honest error (the user fixes their config).
    const genesis = await rpc.getGenesisHash(SOLANA_RPC_URL, {signal: reclaimSignal});
    if (genesis !== SOL_GENESIS_HASH) {
      return {kind: 'error', message: `cluster genesis mismatch (got ${genesis}, expected ${SOL_GENESIS_HASH})`};
    }

    // Read the nonce account in ONE round trip. getAccountInfo returns balance + data from the same
    // RPC slot (mutually consistent — no getBalance/accountInfo race). lamports is the reclaimable
    // balance (the full account balance, since Withdraw drains everything).
    const account = await rpc.getAccountInfo(SOLANA_RPC_URL, nonceAccount.address, {signal: reclaimSignal});
    const balance = account?.lamports ?? 0n;
    const inspection = inspectNonceAccount(account?.data ?? null, balance, mainWallet.publicKey);

    if (inspection.kind === 'absent') {
      // No funded account to reclaim — clear the stale storage marker best-effort (an app reinstall
      // or seed restore loses AsyncStorage, so reclaim rediscovers from the chain; clearing the stale
      // marker tidies up the case where AsyncStorage outlived the on-chain closure).
      await clearSolNonce(icPubHex).catch((e: unknown) => {
        console.warn('reclaim: clearSolNonce on absent failed (best-effort):', e instanceof Error ? e.message : String(e));
      });
      return {kind: 'absent'};
    }
    if (inspection.kind !== 'reclaimable') {
      // uninitialized / wrong-authority / malformed → surface honestly without broadcasting.
      return {kind: 'error', message: `nonce account is ${inspection.kind} — cannot reclaim`};
    }

    const lamports = inspection.lamports;

    // Fresh blockhash for the withdraw tx (a live recent blockhash, NOT the stored nonce value).
    const bh = await rpc.getLatestBlockhash(SOLANA_RPC_URL, {signal: reclaimSignal});
    const message = buildWithdrawNonceMessage(mainWallet.publicKey, nonceAccount.publicKey, lamports, base58Decode32(bh.blockhash));

    // Quote the fee and prove the main wallet can pay it. getFeeForMessage returns null when the RPC
    // can't compute the fee (e.g. the message references an unloadable account) → honest error.
    const fee = await rpc.getFeeForMessage(SOLANA_RPC_URL, bytesToBase64(message), {signal: reclaimSignal, minContextSlot: bh.contextSlot});
    if (fee === null) {
      return {kind: 'error', message: 'could not quote the reclaim fee from the RPC'};
    }
    const mainBalanceStr = await rpc.getBalance(SOLANA_RPC_URL, mainWallet.address, {signal: reclaimSignal});
    const mainBalance = BigInt(mainBalanceStr);
    if (mainBalance < fee) {
      return {kind: 'insufficient-fee', fee, balance: mainBalance};
    }

    // Sign + broadcast. The main wallet is the sole signer (authority + fee payer).
    const raw = signTransaction(message, mainWallet.seed);
    const sig = await rpc.sendTransaction(SOLANA_RPC_URL, raw, {
      signal: reclaimSignal,
      config: {commitment: SOL_PAYMENT_COMMITMENT, minContextSlot: bh.contextSlot, skipPreflight: false},
    });
    if (!sig || sig.length === 0) {
      // An empty signature is an honest unknown — the RPC accepted the tx but returned no id.
      return {kind: 'unknown', sig: '', lamports};
    }

    // Broadcast succeeded — we're COMMITTED. Stop the reclaim deadline so it can't race with
    // confirm's own timeout (the reclaim deadline is a backstop for the PRE-broadcast phase only;
    // once the tx is on the wire, confirm must run to its own timeout, and the caller's signal is
    // the only cancel source). Switching to the caller signal here means a user cancel during confirm
    // is honest 'unknown' (the tx may still land), not a false 'error'.
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);

    // Confirm. confirmTransaction throws 'solana confirmation timeout' on timeout, or 'aborted' if
    // the caller cancels mid-confirm — BOTH map to 'unknown' (the tx was broadcast; it may still
    // land, so never report a false failure). A status.err → 'transaction failed: …' → error
    // (definitive on-chain rejection, funds still locked, the user can retry).
    try {
      await rpc.confirmTransaction(SOLANA_RPC_URL, sig, {
        signal,
        timeoutMs: confirmTimeoutMs,
        pollMs: opts?.pollMs,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout|aborted/i.test(msg)) {
        return {kind: 'unknown', sig, lamports};
      }
      return {kind: 'error', message: msg};
    }

    // Confirmed — the account is closed and the lamports returned. Clear the stale storage marker.
    await clearSolNonce(icPubHex).catch((e: unknown) => {
      console.warn('reclaim: clearSolNonce on reclaimed failed (best-effort):', e instanceof Error ? e.message : String(e));
    });
    return {kind: 'reclaimed', sig, lamports};
  } catch (e) {
    // Any uncaught failure (RPC error, abort, cluster check throw) → honest error. An abort surfaces
    // as 'aborted' which is honest (the user cancelled; the tx MAY or MAY NOT have landed — but
    // since we surface it as error before broadcast in all but the confirm path, no false success).
    const msg = e instanceof Error ? e.message : String(e);
    if (/aborted/i.test(msg)) {
      // Caller cancelled. If we had already broadcast, the caller can't tell — surface as error
      // (honest: "we stopped waiting"); the reclaim UI can re-check the account on the next open.
      return {kind: 'error', message: 'reclaim cancelled'};
    }
    return {kind: 'error', message: msg};
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
}
