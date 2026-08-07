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
import {SOLANA_RPC_URL} from './config/constants';
import {deriveSolanaKeypair, deriveSolanaAddress, deriveSlip10Ed25519} from './solana/identity';
import {base58Decode32, buildSignedTransfer, signTransaction} from './solana/tx';
import {buildAdvanceAndTransferMessage, buildCreateNonceAccountMessage} from './solana/nonce';
import {buildAdvanceAndSplTransferMessage, deriveAta} from './solana/spl';
import {encodeSolPay} from './solana/qr';
import type {SolReq, SolPay} from './solana/qr';
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
export interface SolReceipt {
  readonly status: ReceiptCode;
  readonly npub: string;
  readonly nextNonce: string | null;
  readonly sig: string | null;
}

// --- private helpers -----------------------------------------------------------

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
  const {getLatestBlockhash, getMinimumBalanceForRentExemption, sendTransaction, confirmTransaction, getNonceAccount} =
    await import('./solana/rpc');
  const {blockhash} = await getLatestBlockhash(SOLANA_RPC_URL, {signal});
  const rent = await getMinimumBalanceForRentExemption(SOLANA_RPC_URL, 80, {signal});
  const msg = buildCreateNonceAccountMessage(authority.publicKey, nonceAcct.publicKey, rent, base58Decode32(blockhash));
  const raw = signTransactionMulti([authority.seed, nonceAcct.seed], msg);
  const sig = await sendTransaction(SOLANA_RPC_URL, raw, {signal});
  await confirmTransaction(SOLANA_RPC_URL, sig, {signal});
  const {value} = await getNonceAccount(SOLANA_RPC_URL, nonceAcct.address, {signal});
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
    if (/Instruction|insufficient|custom|already|blockhash|nonce/i.test(msg)) {
      return {status: RECEIPT_REJECTED, npub, nextNonce: null, sig: null};
    }
    return {status: RECEIPT_UNREACHABLE, npub, nextNonce: null, sig: null};
  }
}

/** Re-read the current durable-nonce value (after a stale/rejected payment). ONLINE — throws if SOL
 *  is offline. */
export async function resyncNonce(
  nonceAccountAddress: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!SOLANA_RPC_URL) throw new Error('Solana is offline (no RPC endpoint configured)');
  const {getNonceAccount} = await import('./solana/rpc');
  const {value} = await getNonceAccount(SOLANA_RPC_URL, nonceAccountAddress, {signal});
  return value;
}
