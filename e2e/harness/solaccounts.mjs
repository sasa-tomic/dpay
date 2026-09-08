// The page-side helper every Solana flow's RPC stub answers `getMultipleAccounts` with.
//
// WHY IT EXISTS. The wallet's balance poll is ONE `getMultipleAccounts` per tick over
// [wallet, (token account, mint) per rail] — that is the demand cut of 2026-09-08
// (`docs/specs/2026-09-08-solana-rpc-plan.md`). A flow that wants to say "5 SOL, 2 USDC, no EURC
// account" would otherwise have to hand-encode the SPL account layouts, so the encoding lives here
// once, and each flow keeps declaring only its own NUMBERS:
//
//   getMultipleAccounts: (p) => __DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, tokens: {[MINT]: {amount: '2000000', decimals: 6}}}),
//
// A mint absent from `tokens` (or mapped to null) answers `null` for its token account — which is
// what a Solana node answers for an account that does not exist, and what the wallet reads as a
// KNOWN-absent token account. The layouts encoded here are the ones pinned against real mainnet
// bytes in app/__tests__/solana-account-decode.test.ts; this is the write side of the same fact.
//
// Installed by `driver.mjs` on every `setup({solStub: true})` page, before any app script runs.

/** Runs IN THE PAGE. Self-contained: no imports, no closure over harness state. */
export function installSolAccountsHelper() {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  /** base58 → bytes (the address alphabet; leading '1's are leading zero bytes). */
  const decode58 = (s) => {
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
  const toBase64 = (bytes) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  /** A 165-byte SPL token account: mint[32] ++ owner[32] ++ amount u64LE ++ zeros. */
  const tokenAccount = (mint, owner, amount) => {
    const b = new Uint8Array(165);
    b.set(decode58(mint), 0);
    b.set(decode58(owner), 32);
    let v = BigInt(amount);
    for (let i = 0; i < 8; i++) { b[64 + i] = Number(v & 0xffn); v >>= 8n; }
    return {lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toBase64(b), 'base64'], executable: false, rentEpoch: 0, space: 165};
  };
  /** An 82-byte SPL mint account: decimals at offset 44. */
  const mintAccount = (decimals) => {
    const b = new Uint8Array(82);
    b[44] = decimals;
    return {lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toBase64(b), 'base64'], executable: false, rentEpoch: 0, space: 82};
  };

  globalThis.__DPAY_SOL_ACCOUNTS = (params, spec) => {
    const addresses = params[0];
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
      // `tokens[mint]` names ONE rail; `token` is the same answer for every rail (what most flows
      // want, and what the per-mint handlers they replaced actually did); `null` either way means
      // the account does not exist.
      const t = mint in tokens ? tokens[mint] : (spec.token ?? null);
      if (isMint) return mintAccount(t?.decimals ?? 6);
      return t ? tokenAccount(mint, owner, t.amount) : null;
    });
    return {context: {slot: spec.slot ?? 250000000}, value};
  };
}
