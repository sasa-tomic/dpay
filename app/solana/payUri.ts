import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { isValidSolanaAddress } from './identity';

const RE_DECIMAL_AMOUNT = /^\d+(\.\d+)?$/;

export function createSolanaPayReference(): string {
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);
  return bs58.encode(ed25519.getPublicKey(seed));
}

export function buildSolanaPayUri(
  recipient: string,
  opts: {amount?: string | null; splToken?: string | null; reference?: string | null} = {},
): string {
  if (!isValidSolanaAddress(recipient)) {
    throw new Error(`solana pay recipient is not a base58 pubkey: ${recipient}`);
  }
  if (opts.splToken != null && !isValidSolanaAddress(opts.splToken)) {
    throw new Error(`solana pay spl-token is not a base58 pubkey: ${opts.splToken}`);
  }
  if (opts.reference != null && !isValidSolanaAddress(opts.reference)) {
    throw new Error(`solana pay reference is not a base58 pubkey: ${opts.reference}`);
  }
  if (opts.amount != null && (typeof opts.amount !== 'string' || !RE_DECIMAL_AMOUNT.test(opts.amount))) {
    throw new Error(`solana pay amount must be a plain decimal string: ${opts.amount}`);
  }
  const params: string[] = [];
  if (opts.amount != null) params.push(`amount=${opts.amount}`);
  if (opts.splToken != null) params.push(`spl-token=${opts.splToken}`);
  if (opts.reference != null) params.push(`reference=${opts.reference}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return `solana:${recipient}${query}`;
}
