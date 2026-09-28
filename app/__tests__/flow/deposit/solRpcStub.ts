/**
 * solRpcStub.ts — the e2e `setup({solStub: true})` semantics, ported test-side (the harness core
 * is frozen; the integrator may promote this to flow/harness).
 *
 * Two halves, mirroring `e2e/harness/driver.mjs` + `e2e/harness/solaccounts.mjs`:
 *  1. `armSolStubOverride()` — sets `__DPAY_TEST_SOLANA_RPC_URL = 'stub'`. MUST run before the
 *     app's constants module loads (it captures the override at module load): call it at the top
 *     of the flow file's module body, before requiring the harness. Without it every SPL row
 *     (USDC/EURC on Solana) is fail-closed under the jest default `''` and never renders.
 *  2. `installSolRpcStub(spec)` — the runtime RPC simulator (`__DPAY_TEST_SOLANA_RPC_STUB`,
 *     checked per call by app/solana/rpc.ts): getMultipleAccounts answered through the ported
 *     `__DPAY_SOL_ACCOUNTS` encoder, so a flow declares BALANCES and not SPL byte layouts.
 *
 * The account layouts encoded here are the ones pinned against real mainnet bytes in
 * app/__tests__/solana-account-decode.test.ts; this is the write side of the same fact.
 */

/** Runs before the harness require: flips the test override to the in-page stub mode. */
export function armSolStubOverride(): void {
  (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_SOLANA_RPC_URL = 'stub';
}

export type SolTokenSpec = {amount: string; decimals: number};
export type SolAccountsSpec = {
  lamports?: number | null;
  /** One answer per mint (the per-rail form). */
  tokens?: Record<string, SolTokenSpec | null>;
  /** The same answer for every rail (what most flows want). */
  token?: SolTokenSpec | null;
  slot?: number;
};

/** The `__DPAY_SOL_ACCOUNTS` page helper (e2e/harness/solaccounts.mjs), ported verbatim-in-spirit. */
function solAccounts(params: unknown[], spec: SolAccountsSpec): unknown {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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

  const addresses = params[0] as string[];
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
    // `tokens[mint]` names ONE rail; `token` is the same answer for every rail; `null` either way
    // means the account does not exist (what a Solana node answers for a missing account).
    const t = mint in tokens ? tokens[mint] : (spec.token ?? null);
    if (isMint) return mintAccount(t?.decimals ?? 6);
    return t ? tokenAccount(mint, owner, t.amount) : null;
  });
  return {context: {slot: spec.slot ?? 250000000}, value};
}

/** The standard flow stub (the object e2e flows 122/131/… install via driver.eval): the ATA
 *  EXISTS with a zero SPL balance, so the rail's address surface is READY, not the setup gate. */
export function installSolRpcStub(spec: SolAccountsSpec = {lamports: 0, token: {amount: '0', decimals: 6}}): void {
  (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_SOLANA_RPC_STUB = {
    // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
    getMultipleAccounts: (p: unknown[]) => solAccounts(p, spec),
    getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    getAccountInfo: () => ({value: {data: ['', 'base64'], owner: '11111111111111111111111111111111', lamports: 2039280}}),
    getBalance: () => ({value: 0}),
    getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}}),
  };
}
