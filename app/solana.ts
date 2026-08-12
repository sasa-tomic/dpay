// SOL native device-key rail — the isolation-boundary seam (mirrors `app/wallet.ts`→
// `app/walletconnect.ts`). Statically imports ONLY the PURE modules (`solana/identity`,
// `solana/tx`, `solana/nonce`, `solana/spl`, `solana/qr`, `payments` — no network, no `@solana/*`
// SDK, safe under jest/e2e). The network module `solana/rpc` is reached via a lazy
// `await import('./solana/rpc')` INSIDE the async network functions, gated by a non-empty
// `SOLANA_RPC_URL`. With the URL empty (jest.setup.js + the e2e driver set
// `__DPAY_TEST_SOLANA_RPC_URL=''`), these functions no-op / throw — so the offline inner loop
// never imports the network module and never touches devnet.
//
// Offline-pay lifecycle:
//   signOfflineSolPayment / signOfflineSplPayment — PURE (no RPC). The payer signs fully offline
//     against its stored durable-nonce value, producing a `solpay:` URI for the merchant.
//   createNonceAccount — ONLINE. Funds a durable-nonce account owned by the device key.
//   broadcastSolPayment — ONLINE (merchant). Broadcasts a signed `solpay`, confirms, returns the
//     receipt with the advanced nonce value (the receipt-nonce-relay hand-back).
//   resyncNonce — ONLINE. Re-reads the current nonce value after a stale/rejected payment.

import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {SOLANA_RPC_URL, SOL_GENESIS_HASH, SOL_PAYMENT_MAX_WINDOW_SECONDS, SOL_PAYMENT_COMMITMENT, SOL_BROADCAST_TIMEOUT_MS} from './config/constants';
import {solanaUsdcAvailable} from './config/assets';
import {deriveSolanaKeypair, deriveSolanaAddress, deriveSlip10Ed25519} from './solana/identity';
import {base58Decode32, buildSignedTransfer, signTransaction, buildCanonicalSolMessage, verifySolPayment, extractSignedTxParts} from './solana/tx';
import {assembleMessage, buildAdvanceAndTransferMessage, buildCreateNonceAccountMessage} from './solana/nonce';
import {buildAdvanceAndSplTransferMessage, buildSplTransferInstruction, buildCanonicalUsdcMessage, deriveAta, USDC_MINT_ADDRESS} from './solana/spl';
import {encodeSolPay} from './solana/qr_v1';
import {encodeSolReq, generateRid} from './solana/qr';
import type {SolReq, SolPay} from './solana/qr_v1';
import type {SolReqV2, SolPayV2, SolReceiptV2, SolReqInput, SolPayInput} from './solana/qr';
import type {SolanaSignatureStatus} from './solana/rpc';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from './payments';
import type {ReceiptCode} from './payments';
import {hexToBytes} from './lib/format';

export {deriveSolanaAddress};

// --- types ---------------------------------------------------------------------

/** The receipt the merchant hands back to the offline payer after broadcasting a `solpay`.
 *  `status` mirrors the IC receipt codes (RECEIPT_SETTLED/REJECTED/UNREACHABLE — single source of
 *  truth in `payments.ts`). `nextNonce` is the advanced nonce value IF settled — the payer adopts it
 *  optimistically for the next offline payment (the receipt-nonce-relay). `sig` is the on-chain
 *  transaction signature IF settled. */
interface SolReceipt {
  readonly status: ReceiptCode;
  readonly npub: string;
  readonly nextNonce: string | null;
  readonly sig: string | null;
}

// --- private helpers -----------------------------------------------------------

// Read a durable-nonce account's current value, retrying up to 3× with 500ms spacing to absorb the
// confirm→queryable lag (the account state may lag `confirm` by a slot or two on a fast-producing
// node — the local test-validator is the extreme case; mainnet has a smaller but nonzero gap).
// Shared by createNonceAccount (the post-confirm initial read) and resyncNonce (a standalone read) so
// a transient RPC lag doesn't strand the user on the stale-nonce screen (resyncNonce previously made
// a SINGLE getNonceAccount call with no retry — asymmetric with createNonceAccount's retry loop).
async function readNonceWithRetry(address: string, signal?: AbortSignal): Promise<string> {
  const {getNonceAccount} = await import('./solana/rpc');
  let value: string;
  for (let attempt = 0; ; attempt++) {
    try {
      ({value} = await getNonceAccount(SOLANA_RPC_URL, address, {signal}));
      break;
    } catch (e) {
      if (attempt >= 3 || signal?.aborted) throw e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return value;
}

// SLIP-10 path m/44'/501'/0'/1' — a sibling of the main Solana key (m/44'/501'/0'/0') for the
// durable-nonce account keypair. Deterministic from the device seed (a single backup recovers both
// the wallet key and the nonce-account key). The nonce account is a utility account: its private key
// is only needed once (to sign CreateAccount); after initialization only the AUTHORITY (the device
// key at m/44'/501'/0'/0') advances the nonce.
const NONCE_ACCOUNT_PATH = [44, 501, 0, 1].map((i) => i + 0x80000000);

function deriveNonceAccountKeypair(secretHex: string): {
  seed: Uint8Array;
  publicKey: Uint8Array;
  address: string;
} {
  const derived = deriveSlip10Ed25519(hexToBytes(secretHex), NONCE_ACCOUNT_PATH);
  const seed = new Uint8Array(32);
  seed.set(derived);
  const publicKey = ed25519.getPublicKey(seed);
  return {seed, publicKey, address: bs58.encode(publicKey)};
}

// Multi-signer transaction serialization: compact-u16(n) || sig0(64) || ... || message.
// Used for CreateAccount (2 signers). The offline-pay messages are single-signer (via signTransaction).
function signTransactionMulti(seeds: Uint8Array[], message: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + seeds.length * 64 + message.length);
  out[0] = seeds.length; // compact-u16 for counts 0–127
  let off = 1;
  for (const seed of seeds) {
    out.set(ed25519.sign(message, seed), off);
    off += 64;
  }
  out.set(message, off);
  return out;
}

// --- existing exports (unchanged) ----------------------------------------------

/** Read an account's lamport balance as a decimal-digit string. Returns `null` (no throw, no
 *  network) when SOL is offline (`SOLANA_RPC_URL` empty) — the hook treats null as "no balance". */
export async function getSolanaBalance(address: string, signal?: AbortSignal): Promise<string | null> {
  if (!SOLANA_RPC_URL) return null;
  const {getBalance} = await import('./solana/rpc');
  return getBalance(SOLANA_RPC_URL, address, {signal});
}

/** Build, sign, broadcast, and confirm a System Program Transfer of `lamports` to `toAddress`.
 *  Signs LOCALLY with the device-derived key (no relay, no DpayCore — non-custodial). Throws if SOL
 *  is offline, on a network/RPC error, or if the transaction fails on-chain. Returns the signature. */
export async function sendSol(secretHex: string, toAddress: string, lamports: bigint, signal?: AbortSignal): Promise<string> {
  if (!SOLANA_RPC_URL) throw new Error('Solana is offline (no RPC endpoint configured)');
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const {getLatestBlockhash, sendTransaction, confirmTransaction} = await import('./solana/rpc');
  const {blockhash} = await getLatestBlockhash(SOLANA_RPC_URL, {signal});
  const raw = buildSignedTransfer(seed, publicKey, toAddress, lamports, base58Decode32(blockhash));
  const signature = await sendTransaction(SOLANA_RPC_URL, raw, {signal});
  await confirmTransaction(SOLANA_RPC_URL, signature, {signal});
  return signature;
}

/** Phase 6 — Build, sign, broadcast, and confirm an SPL Token `transfer` of `amount` raw USDC (6
 *  decimals) to `destAddress`. The recipient is a base58 Solana WALLET address (the same shape SOL
 *  send takes); the recipient's USDC Associated Token Account is DERIVED from it. Signs LOCALLY with
 *  the device-derived key (non-custodial — same shape as sendSol).
 *
 *  FAIL-CLOSED ATA checks (mirror Phase 4's principle): the device's source ATA + the recipient's ATA
 *  must BOTH exist on-chain. The Token program rejects transfers to a non-existent account, so
 *  pre-checking saves the user a failed-fee confusion. The sender check runs FIRST so the error names
 *  the right party. A TOCTOU race (an ATA created between check + submit) is fine — the confirm path
 *  succeeds on re-submit.
 *
 *  Throws if SOL is offline, if either ATA is missing, on a network/RPC error, or if the on-chain tx
 *  fails. Returns the signature. Reuses the byte-exact `buildSplTransferInstruction` (Token program
 *  transfer ix — proven in solana-spl.test.ts). */
export async function sendSpl(secretHex: string, destAddress: string, amount: bigint, signal?: AbortSignal): Promise<string> {
  if (!SOLANA_RPC_URL) throw new Error('Solana is offline (no RPC endpoint configured)');
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const senderAddress = bs58.encode(publicKey);
  const senderAta = deriveAta(senderAddress, USDC_MINT_ADDRESS);
  const recipientAta = deriveAta(destAddress, USDC_MINT_ADDRESS);
  const {accountExists, getLatestBlockhash, sendTransaction, confirmTransaction} = await import('./solana/rpc');

  // Sender ATA first — the device must hold a USDC account to debit from.
  if (!(await accountExists(SOLANA_RPC_URL, bs58.encode(senderAta), {signal}))) {
    throw new Error("Your wallet doesn't have a USDC account yet");
  }
  // Recipient ATA second — the Token program would otherwise reject the transfer.
  if (!(await accountExists(SOLANA_RPC_URL, bs58.encode(recipientAta), {signal}))) {
    throw new Error("The recipient doesn't have a USDC account — they need to set one up first");
  }

  const ix = buildSplTransferInstruction(senderAta, recipientAta, publicKey, amount);
  const {blockhash} = await getLatestBlockhash(SOLANA_RPC_URL, {signal});
  const message = assembleMessage(publicKey, [ix], base58Decode32(blockhash));
  const raw = signTransaction(message, seed);
  const signature = await sendTransaction(SOLANA_RPC_URL, raw, {signal});
  await confirmTransaction(SOLANA_RPC_URL, signature, {signal});
  return signature;
}

// --- offline sign (PURE — no RPC, no dynamic import) ---------------------------

/** Sign a durable-nonce SOL payment fully offline. Builds `{AdvanceNonceAccount, Transfer}` with
 *  `recentBlockhash = nonceValue` (the stored durable nonce, NOT a live blockhash) and signs with the
 *  device key. Returns the encoded `solpay:v1?…` URI for the merchant. Works in airplane mode — no
 *  network at all. */
export function signOfflineSolPayment(
  secretHex: string,
  req: SolReq,
  nonceAccountAddress: string,
  nonceValue: string,
): string {
  if (req.cur !== 'SOL') throw new Error('signOfflineSolPayment: expected SOL currency');
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const nonceAccount = base58Decode32(nonceAccountAddress);
  const storedNonce = base58Decode32(nonceValue);
  const msg = buildAdvanceAndTransferMessage(publicKey, nonceAccount, req.to, BigInt(req.amt), storedNonce);
  const tx = signTransaction(msg, seed);
  return encodeSolPay({to: req.to, amt: req.amt, cur: req.cur, npub: nonceAccountAddress, tx});
}

/** Sign a durable-nonce SPL/USDC payment fully offline. Builds `{AdvanceNonceAccount, Token.transfer}`
 *  with `recentBlockhash = nonceValue` and signs with the device key. The payer's source ATA is
 *  derived from the device key + mint (must pre-exist on-chain — see OPEN_ISSUES v2 follow-up). */
export function signOfflineSplPayment(
  secretHex: string,
  req: SolReq,
  nonceAccountAddress: string,
  nonceValue: string,
): string {
  if (req.cur !== 'USDC') throw new Error('signOfflineSplPayment: expected USDC currency');
  if (!req.mint || !req.toAta) throw new Error('signOfflineSplPayment: mint and toAta required for USDC');
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const authorityAddress = bs58.encode(publicKey);
  const sourceAta = deriveAta(authorityAddress, req.mint);
  const nonceAccount = base58Decode32(nonceAccountAddress);
  const destAta = base58Decode32(req.toAta);
  const storedNonce = base58Decode32(nonceValue);
  const msg = buildAdvanceAndSplTransferMessage(
    publicKey, nonceAccount, sourceAta, destAta, publicKey, BigInt(req.amt), storedNonce,
  );
  const tx = signTransaction(msg, seed);
  return encodeSolPay({to: req.to, amt: req.amt, cur: req.cur, npub: nonceAccountAddress, tx});
}

// --- online lifecycle (dynamic-import rpc; throw 'offline' when URL empty) -----

/** Create a durable-nonce account funded by the device key. ONLINE — throws if SOL is offline.
 *  Derives the nonce-account keypair at m/44'/501'/0'/1' (deterministic from the seed), funds it with
 *  rent-exempt lamports, initializes it with the device key as authority, then reads back the initial
 *  nonce value. Returns `{address, value}` to persist for offline signing. */
export async function createNonceAccount(
  secretHex: string,
  signal?: AbortSignal,
): Promise<{address: string; value: string}> {
  if (!SOLANA_RPC_URL) throw new Error('Solana is offline (no RPC endpoint configured)');
  const authority = deriveSolanaKeypair(secretHex);
  const nonceAcct = deriveNonceAccountKeypair(secretHex);
  const {getLatestBlockhash, getMinimumBalanceForRentExemption, sendTransaction, confirmTransaction} =
    await import('./solana/rpc');
  const {blockhash} = await getLatestBlockhash(SOLANA_RPC_URL, {signal});
  const rent = await getMinimumBalanceForRentExemption(SOLANA_RPC_URL, 80, {signal});
  const msg = buildCreateNonceAccountMessage(authority.publicKey, nonceAcct.publicKey, rent, base58Decode32(blockhash));
  const raw = signTransactionMulti([authority.seed, nonceAcct.seed], msg);
  const sig = await sendTransaction(SOLANA_RPC_URL, raw, {signal});
  await confirmTransaction(SOLANA_RPC_URL, sig, {signal});
  // Read back the initial nonce value (with retry — the account state may lag `confirm` by a slot or
  // two; the shared readNonceWithRetry mirrors resyncNonce's retry so both read paths are symmetric).
  const value = await readNonceWithRetry(nonceAcct.address, signal);
  return {address: nonceAcct.address, value};
}

/** Broadcast a signed `solpay` and return the receipt. ONLINE (merchant) — throws if SOL is offline.
 *  On settle, reads back the advanced nonce value (the receipt-nonce-relay hand-back the payer adopts
 *  for its next offline payment). On a definitive Solana rejection (instruction error, insufficient
 *  funds, nonce/blockhash issue) returns status REJECTED. On a network/timeout error returns
 *  UNREACHABLE (the tx MAY still land — honest pending, never a false failure). */
export async function broadcastSolPayment(
  solpay: SolPay,
  signal?: AbortSignal,
): Promise<SolReceipt> {
  if (!SOLANA_RPC_URL) throw new Error('Solana is offline (no RPC endpoint configured)');
  const {sendTransaction, confirmTransaction, getNonceAccount} = await import('./solana/rpc');
  const npub = solpay.npub;
  try {
    const sig = await sendTransaction(SOLANA_RPC_URL, solpay.tx, {signal});
    await confirmTransaction(SOLANA_RPC_URL, sig, {signal});
    const {value: nextNonce} = await getNonceAccount(SOLANA_RPC_URL, npub, {signal});
    return {status: RECEIPT_SETTLED, npub, nextNonce, sig};
  } catch (e) {
    console.warn('broadcastSolPayment error:', e);
    const msg = String((e as Error)?.message ?? e);
    if (/Instruction|insufficient|no record of a prior credit|simulation failed|debit|custom|already|blockhash|nonce/i.test(msg)) {
      return {status: RECEIPT_REJECTED, npub, nextNonce: null, sig: null};
    }
    return {status: RECEIPT_UNREACHABLE, npub, nextNonce: null, sig: null};
  }
}

/** Re-read the current durable-nonce value (after a stale/rejected payment). ONLINE — throws if SOL
 *  is offline. Retries 3×/500ms via the shared readNonceWithRetry (same as createNonceAccount's
 *  post-confirm read) so a transient RPC lag doesn't strand the user on the stale-nonce screen. */
export async function resyncNonce(
  nonceAccountAddress: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!SOLANA_RPC_URL) throw new Error('Solana is offline (no RPC endpoint configured)');
  return readNonceWithRetry(nonceAccountAddress, signal);
}

/** F4 — whether THIS device has a USDC Associated Token Account. USDC offline-pay needs the device's
 *  ATA to pre-exist on-chain (the payer debits its source ATA; the merchant's request encodes its
 *  `toAta`). Without one the broadcast fails opaquely at the Token program; this gate surfaces the
 *  missing account BEFORE the user commits.
 *
 *  ONLINE — returns null (no throw, no network) when SOL is offline (`SOLANA_RPC_URL` empty), mirroring
 *  `getSolanaBalance`. Derives the device ATA from the seed + USDC mint and checks on-chain existence.
 *  Throws on a network error (the caller treats that as "couldn't verify" — non-blocking, since the
 *  on-chain broadcast is the authoritative gate). */
export async function checkUsdcAta(secretHex: string, signal?: AbortSignal): Promise<boolean | null> {
  if (!SOLANA_RPC_URL) return null;
  const {accountExists} = await import('./solana/rpc');
  const address = deriveSolanaAddress(secretHex);
  const ataAddress = bs58.encode(deriveAta(address, USDC_MINT_ADDRESS));
  return accountExists(SOLANA_RPC_URL, ataAddress, {signal});
}

// ============================================================================
// Phase 2 — honest Solana SOL + USDC balances (2026-08-12 unified asset selection rewrite).
//
// The wallet must render a distinct Solana-USDC balance row AND keep five states distinguishable
// (plan invariant #10): loading, known-absent ATA, known zero balance, stale/unavailable, RPC error.
// `getSolanaUsdcBalance` is the discriminated-union reader; the `useSolanaBalances` hook translates
// it into per-status state for the Wallet.
// ============================================================================

/** The Solana USDC balance result — a discriminated union capturing the four states the plan requires
 *  stay distinct at the seam boundary (the hook maps them to per-status UI state):
 *    - `offline`: SOLANA_RPC_URL empty (offline inner loop) OR `solanaUsdcAvailable()` false (a
 *      mainnet mint pointed at a non-mainnet RPC — fail-closed rather than read a non-existent token).
 *      No network call is made.
 *    - `absent`: the device's USDC ATA does NOT exist on-chain. The user has never received USDC;
 *      this is a KNOWN zero, not an unverifiable state.
 *    - `balance`: ATA exists and `getTokenAccountBalance` returned the exact raw `amount` (a decimal-
 *      digit STRING — money-critical, never coerced through JS `number`) + `decimals` (USDC = 6).
 *      A zero balance is `{kind:'balance', amount:'0', decimals:6}` — still a balance, not absent.
 *    - `error`: RPC failure (existence check or balance read threw). Transient/unverifiable; the hook
 *      preserves any prior amount (it does NOT turn a prior value into zero). */
export type SolanaUsdcBalanceResult =
  | {kind: 'offline'}
  | {kind: 'absent'}
  | {kind: 'balance'; amount: string; decimals: number}
  | {kind: 'error'};

/** Read the device's USDC ATA balance as a discriminated result (the new balance path — replaces the
 *  boolean-only `checkUsdcAta` for BALANCE purposes; `checkUsdcAta` stays for the F4 ATA-existence
 *  gate in the receive flow).
 *
 *  ONLINE — returns `{kind:'offline'}` (no throw, no network) when `SOLANA_RPC_URL` is empty OR
 *  `solanaUsdcAvailable()` is false (mirroring `getSolanaBalance`'s offline no-op). Derives the
 *  device ATA from the seed + USDC mint, checks on-chain existence, and if present reads the exact
 *  token balance string via `getTokenAccountBalance`. On any RPC error returns `{kind:'error'}` and
 *  logs the ATA + message at `console.warn` (debuggability — a silent error here would render as a
 *  stale balance forever). */
export async function getSolanaUsdcBalance(
  secretHex: string,
  signal?: AbortSignal,
): Promise<SolanaUsdcBalanceResult> {
  if (!SOLANA_RPC_URL || !solanaUsdcAvailable()) return {kind: 'offline'};
  const {accountExists, getTokenAccountBalance} = await import('./solana/rpc');
  const address = deriveSolanaAddress(secretHex);
  const ataAddress = bs58.encode(deriveAta(address, USDC_MINT_ADDRESS));
  try {
    const exists = await accountExists(SOLANA_RPC_URL, ataAddress, {signal});
    if (!exists) return {kind: 'absent'};
    const {amount, decimals} = await getTokenAccountBalance(SOLANA_RPC_URL, ataAddress, {signal});
    return {kind: 'balance', amount, decimals};
  } catch (e) {
    console.warn(`getSolanaUsdcBalance: RPC failure for ATA ${ataAddress}:`, e instanceof Error ? e.message : String(e));
    return {kind: 'error'};
  }
}

/** Whether the Solana RPC rail is configured (RPC URL non-empty). A pure sync read of the constant —
 *  independent of relay `online` (plan invariant #9 — the relay could be reachable while SOL RPC is
 *  not, or vice versa). The USDC-coherence sense (a mainnet mint pointed at a non-mainnet RPC) is the
 *  separate `solanaUsdcAvailable()` predicate. */
export function isSolanaRpcAvailable(): boolean {
  return SOLANA_RPC_URL !== '';
}

// ============================================================================
// Phase 3 — v2 recent-blockhash payment seam. ADDITIVE alongside the v1 seam above; the UI stays on
// v1 until Phase 4 rewires it. The lifecycle:
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
    cur: 'SOL' | 'USDC';
    mint: string | null;
    toAta: string | null;
    name: string;
    memo: string;
  },
  signal: AbortSignal,
): Promise<{request: SolReqV2; uri: string}> {
  if (!isSolanaRpcAvailable()) throw new Error('Solana is offline (no RPC endpoint configured)');
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

/** OFFLINE payer (USDC). NO network. Same as `signSolPayment` with the USDC canonical builder
 *  (`{Memo, Token.transferChecked}` — commits to mint + decimals + ATAs). */
export function signSplPayment(secretHex: string, request: SolReqV2): SolPayV2 {
  if (request.cur !== 'USDC') throw new Error('signSplPayment: expected USDC currency');
  if (!request.mint || !request.toAta) throw new Error('signSplPayment: mint and toAta required for USDC');
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const message = buildCanonicalUsdcMessage(publicKey, request);
  const tx = signTransaction(message, seed);
  const payInput: SolPayInput = {rid: request.rid, tx};
  return {v: 2, ...payInput};
}

/** ONLINE merchant broadcast + confirm. STRICT. Runs the canonical-message rebuild + Ed25519 verify
 *  BEFORE any network send, freshness-checks the blockhash + block height against the request, then
 *  broadcasts with preflight and confirms via history-aware signature status polling.
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
 *    • Confirm: confirmed     → SETTLED, sig=<verified>.
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
export async function broadcastSolPaymentV2(
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

  // 3. Build the expected canonical message from the open request + extracted payer.
  const expectedMessage = request.cur === 'SOL'
    ? buildCanonicalSolMessage(parts.feePayer, request)
    : buildCanonicalUsdcMessage(parts.feePayer, request);

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

  if (!isSolanaRpcAvailable()) throw new Error('Solana is offline (no RPC endpoint configured)');
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
          return {status: RECEIPT_SETTLED, rid, sig};
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
