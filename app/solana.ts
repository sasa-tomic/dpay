// SOL native device-key rail — the isolation-boundary seam (mirrors `app/wallet.ts`→
// `app/walletconnect.ts`). Statically imports ONLY the PURE modules (`solana/identity`,
// `solana/tx` — no network, no `@solana/*` SDK, safe under jest/e2e). The network module
// `solana/rpc` is reached via a lazy `await import('./solana/rpc')` INSIDE the async network
// functions, gated by a non-empty `SOLANA_RPC_URL`. With the URL empty (jest.setup.js + the e2e
// driver set `__DPAY_TEST_SOLANA_RPC_URL=''`), these functions no-op / throw — so the offline
// inner loop never imports the network module and never touches devnet.

import {SOLANA_RPC_URL} from './config/constants';
import {deriveSolanaKeypair, deriveSolanaAddress} from './solana/identity';
import {base58Decode32, buildSignedTransfer} from './solana/tx';

export {deriveSolanaAddress};

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
