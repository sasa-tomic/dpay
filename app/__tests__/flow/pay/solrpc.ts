/**
 * solrpc.ts — the Solana test stub for flow-tier files, ported from `e2e/harness/driver.mjs`
 * (`opts.solStub` → `__DPAY_TEST_SOLANA_RPC_URL = 'stub'`) and `e2e/harness/solaccounts.mjs`
 * (`installSolAccountsHelper` — the page-side `getMultipleAccounts` answer encoder, verbatim).
 *
 * LOAD-ORDER CONTRACT: `app/config/constants.ts` captures `__DPAY_TEST_SOLANA_RPC_URL` at module
 * load, and the App module graph loads with the first `require('../harness/lib')`. A SOL flow file
 * must therefore set the override (and install the accounts helper) in its module body BEFORE the
 * require of the harness — see the header of 70-pay-link.test.tsx for the idiom.
 *
 * The RPC stub itself (`__DPAY_TEST_SOLANA_RPC_STUB`) is consulted PER CALL by `app/solana/rpc.ts`
 * (before any fetch), so flows install/flip it freely around a mounted app.
 */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Enable the in-memory RPC seam (the 'stub' sentinel the e2e driver injects). */
export function enableSolRpcStub(): void {
  (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_SOLANA_RPC_URL = 'stub';
}

type AccountSpec = {
  lamports?: number | null;
  /** ONE answer for every rail's token account (what most flows want). */
  token?: {amount: string; decimals: number} | null;
  /** Per-mint overrides: `tokens[mint]` names ONE rail; absent mints answer `token` (or null). */
  tokens?: Record<string, {amount: string; decimals: number} | null>;
  slot?: number;
};

/** Installs `globalThis.__DPAY_SOL_ACCOUNTS(params, spec)` — the balance-poll answer encoder. */
export function installSolAccountsHelper(): void {
  const decode58 = (s: string): Uint8Array => {
    const bytes = [0];
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
  };
  const toBase64 = (bytes: Uint8Array): string => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  /** A 165-byte SPL token account: mint[32] ++ owner[32] ++ amount u64LE ++ zeros. */
  const tokenAccount = (mint: string, owner: string, amount: string) => {
    const b = new Uint8Array(165);
    b.set(decode58(mint), 0);
    b.set(decode58(owner), 32);
    let v = BigInt(amount);
    for (let i = 0; i < 8; i++) { b[64 + i] = Number(v & 0xffn); v >>= 8n; }
    return {lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toBase64(b), 'base64'], executable: false, rentEpoch: 0, space: 165};
  };
  /** An 82-byte SPL mint account: decimals at offset 44. */
  const mintAccount = (decimals: number) => {
    const b = new Uint8Array(82);
    b[44] = decimals;
    return {lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toBase64(b), 'base64'], executable: false, rentEpoch: 0, space: 82};
  };

  (globalThis as unknown as Record<string, unknown>).__DPAY_SOL_ACCOUNTS = (params: unknown, spec: AccountSpec) => {
    const addresses = (params as unknown[])[0] as string[];
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
    return {context: {slot: spec.slot ?? 250_000_000}, value};
  };
}

/** The shared v2-shape stub answers (the exact shapes the e2e SOL flows install). */
export function baseSolStub(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
    getMinimumBalanceForRentExemption: () => 1447680,
    sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
    getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
    getAccountInfo: () => ({value: {data: ['', 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
    getBalance: () => ({value: 5000000000}),
    getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}}),
    ...over,
  };
}
