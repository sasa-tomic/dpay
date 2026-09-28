/**
 * Batch-local Solana RPC stub helper (flow ports 147, 69/72/76/79/80/81) — a faithful port of
 * `e2e/harness/solaccounts.mjs` `installSolAccountsHelper()`, which jest cannot import (babel's
 * CJS transform breaks e2e/harness's import.meta.url). The wallet's balance poll is ONE
 * `getMultipleAccounts` per tick over [wallet, (ata, mint) per rail]; this shapes the answers so a
 * flow declares only NUMBERS. The layouts encoded here are pinned against real mainnet bytes in
 * app/__tests__/solana-account-decode.test.ts.
 */
// The SOL RPC override must be present BEFORE the app graph is imported: config/constants.ts
// captures `__DPAY_TEST_SOLANA_RPC_URL` at module load (the offline jest.setup.js default is '',
// which keeps the SOL rail asleep). A non-empty value wakes the rail; the per-call RPC stub below
// then intercepts everything, so the URL itself is never fetched. Import this module FIRST in a
// test file (before ../harness/mount), like the frozen setupFiles do.
//
// The value is the e2e driver's `'stub'` SENTINEL (solrpc.ts's twin), not a fake host: it must
// stay unparseable so a boot-window poll that fires before the per-test stub install fails the
// same way it did unfixed — the harness's fail-closed ledger records real origins only, and a
// dial that never left the process is not a network event.
const g0 = globalThis as unknown as Record<string, unknown>;
g0.__DPAY_TEST_SOLANA_RPC_URL = 'stub';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58 → bytes (leading '1's are leading zero bytes). */
function decode58(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`__DPAY_SOL_ACCOUNTS: not base58: ${s}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** A 165-byte SPL token account: mint[32] ++ owner[32] ++ amount u64LE ++ zeros. */
function tokenAccount(mint: string, owner: string, amount: string): object {
  const b = new Uint8Array(165);
  b.set(decode58(mint), 0);
  b.set(decode58(owner), 32);
  let v = BigInt(amount);
  for (let i = 0; i < 8; i++) { b[64 + i] = Number(v & 0xffn); v >>= 8n; }
  return {lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toBase64(b), 'base64'], executable: false, rentEpoch: 0, space: 165};
}

/** An 82-byte SPL mint account: decimals at offset 44. */
function mintAccount(decimals: number): object {
  const b = new Uint8Array(82);
  b[44] = decimals;
  return {lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toBase64(b), 'base64'], executable: false, rentEpoch: 0, space: 82};
}

type Spec = {
  lamports?: number | null;
  /** ONE rail keyed by mint. */
  tokens?: Record<string, {amount: string; decimals: number}>;
  /** The same answer for every rail (what most flows want). */
  token?: {amount: string; decimals: number} | null;
  slot?: number;
};

/** Install `__DPAY_SOL_ACCOUNTS` on globalThis (idempotent). */
export function installSolAccountsHelper(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.__DPAY_SOL_ACCOUNTS = (params: unknown, spec: Spec) => {
    const addresses = (Array.isArray(params) ? params[0] : null) as string[];
    if (!Array.isArray(addresses)) throw new Error('__DPAY_SOL_ACCOUNTS: getMultipleAccounts params[0] is not an array');
    const owner = addresses[0];
    const tokens = spec.tokens ?? {};
    const value = addresses.map((_, i) => {
      if (i === 0) {
        // The wallet's own account. `null` (never created) is a real state and reads as zero.
        return spec.lamports === null || spec.lamports === undefined
          ? null
          : {lamports: spec.lamports, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0};
      }
      // Positional, exactly as the seam builds it: [wallet, ata(m0), m0, ata(m1), m1, …].
      const isMint = i % 2 === 0;
      const mint = isMint ? addresses[i] : addresses[i + 1];
      const t = mint in tokens ? tokens[mint] : (spec.token ?? null);
      if (isMint) return mintAccount(t?.decimals ?? 6);
      return t ? tokenAccount(mint, owner, t.amount) : null;
    });
    return {context: {slot: spec.slot ?? 250000000}, value};
  };
}
