/**
 * relayClient.ts — thin typed fetch wrappers over the ONE test relay the flow globalSetup spawned
 * (the REAL dpay-relay built --features test-helpers: in-process fake-IC /api/v2 gateway + faucet
 * + catalog sugar + convert/OCP/solana/evm proxies). The e2e twin is `e2e/harness/lib.mjs`'s HTTP
 * helpers — re-expressed here (~120 lines) ONLY because jest must not import e2e/harness/*.mjs
 * (babel's CJS transform breaks its import.meta.url). The signing half of railTransfer goes
 * through the SAME wasm core the app signs with (DpayCore) — the oracle e2e/harness/wire.mjs
 * mirrors in JS.
 *
 * ONE relay for the whole run is safe (ported from e2e/run.mjs's documented argument — do not
 * re-litigate): the shared FakeLedger is mutex-serialized and tests use distinct random
 * identities, so there is no cross-test account state to collide.
 */

export function relayBaseURL(): string {
  const u = process.env.DPAY_JEST_RELAY_URL;
  if (!u || !u.startsWith('http')) {
    throw new Error(
      '[relayClient] DPAY_JEST_RELAY_URL is unset — the flow globalSetup did not run (use `just flow`).',
    );
  }
  return u;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  opts: {body?: unknown; timeoutMs?: number; raw?: boolean} = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  const url = `${relayBaseURL()}${path}`;
  try {
    return await fetch(url, {
      method,
      headers: opts.body !== undefined ? {'Content-Type': 'application/json'} : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(`${method} ${url} failed (transport): ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(t);
  }
}

/** Generic flow-side relay oracle (knob routes, swap_quote, proxies). */
export async function relayGet(path: string, timeoutMs = 8000): Promise<unknown> {
  const r = await request('GET', path, {timeoutMs});
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  return r.json();
}

export async function relayPost(path: string, body: unknown, timeoutMs = 8000): Promise<Response> {
  return request('POST', path, {body, timeoutMs});
}

/**
 * POST /api/v1/faucet `{account, currency?, amount?}` → credits fake-IC at the account hex's
 * PRINCIPAL (the exact POST Onboarding itself sends, → ∂100.00). Returns `{ok, status, body}`;
 * a non-2xx (e.g. cooldown) surfaces in body.error — never a throw.
 */
export async function faucetAccount(
  accountHex: string,
  amount?: number,
  opts: {currency?: number; timeoutMs?: number} = {},
): Promise<{ok: boolean; status: number; body: unknown}> {
  const r = await request('POST', '/api/v1/faucet', {
    body: {account: accountHex, amount, ...(opts.currency != null ? {currency: opts.currency} : {})},
    timeoutMs: opts.timeoutMs ?? 6000,
  });
  const body = await r.json().catch(() => ({}));
  return {ok: r.ok, status: r.status, body};
}

/**
 * GET /api/v1/balances/<hex> → the balance in minor units for `currency` (a DECIMAL STRING —
 * raw u64 across the JSON boundary). A missing entry THROWS (the route is best-effort per
 * currency; never a silent '0').
 */
export async function getBalance(accountHex: string, currency = 0, timeoutMs = 4000): Promise<string> {
  const r = await request('GET', `/api/v1/balances/${accountHex}`, {timeoutMs});
  if (!r.ok) throw new Error(`GET balances → HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const j = await r.json() as Record<string, unknown>;
  const bal = j[String(currency)];
  if (typeof bal !== 'string') {
    throw new Error(`GET balances: no entry for currency ${currency} in ${JSON.stringify(j).slice(0, 300)}`);
  }
  return bal;
}

/**
 * GET /api/v1/currencies → the v2 network-first catalog, flattened to the IC assets (icp
 * mainnet ++ icp testnet), mirroring the app's own parse seam (`icpCatalogOf`). Throws on a
 * non-v2 body (no back-compat — there are no deployed clients).
 */
export async function icpCatalog(timeoutMs = 4000): Promise<Array<{currency: number; ledger?: string; fee?: string} & Record<string, unknown>>> {
  const r = await request('GET', '/api/v1/currencies', {timeoutMs});
  if (!r.ok) throw new Error(`GET currencies → HTTP ${r.status}`);
  const j = await r.json() as {networks?: Array<{protocol: string; environment: string; assets: unknown[]}>};
  const networks = j?.networks;
  if (!Array.isArray(networks)) throw new Error('GET currencies: unexpected body (want v2 {networks:[…]})');
  const section = (environment: string) =>
    networks.find((n) => n.protocol === 'icp' && n.environment === environment)?.assets ?? [];
  return [...section('mainnet'), ...section('testnet')] as Array<{currency: number; ledger?: string; fee?: string} & Record<string, unknown>>;
}

/**
 * IC-rail transfer: sign an icrc1_transfer update envelope as a HARNESS-side payer (the stand-in
 * for "the payer's own phone submitted it online") and POST it to the fake-IC gateway. Byte-path
 * identical to the app: the wasm core builds the arg + signs (DpayCore.icpTransferArg /
 * icpSignUpdate). The request memo (nonce hex) is the reconciliation key.
 */
export async function railTransfer(
  payerSecretHex: string,
  payeePubHex: string,
  amountMinor: number | string,
  opts: {currency?: number; memoHex?: string; desc?: {ledger?: string; fee?: string} | null; timeoutMs?: number} = {},
): Promise<{ok: boolean; status: number; requestIdHex: string; bodyText: string}> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {DpayCore} = require('../../../../e2e/web/dpay-core-wasm') as {
    DpayCore: {
      icpPrincipalFromPubkey: (pub: string) => Promise<string>;
      icpTransferArg: (to: string, toSub: string, fromSub: string, amount: string, fee: string, memo: string) => Promise<string>;
      icpSignUpdate: (seed: string, canister: string, method: string, argHex: string, expiryNs: string) => Promise<{envelopeHex: string; requestIdHex: string}>;
    };
  };
  const currency = opts.currency ?? 0;
  const desc = opts.desc ?? (await icpCatalog()).find((c) => c.currency === currency);
  if (!desc?.ledger) throw new Error(`railTransfer: no ledger for currency ${currency}`);
  const payee = await DpayCore.icpPrincipalFromPubkey(payeePubHex);
  const argHex = await DpayCore.icpTransferArg(payee, '', '', String(amountMinor), desc.fee ?? '', opts.memoHex ?? '');
  const expiryNs = (BigInt(Date.now()) * 1_000_000n + 300_000n * 1_000_000n).toString();
  const signed = await DpayCore.icpSignUpdate(payerSecretHex, desc.ledger, 'icrc1_transfer', argHex, expiryNs);
  const bytes = new Uint8Array(signed.envelopeHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(`${relayBaseURL()}/api/v2/canister/${desc.ledger}/call`, {
      method: 'POST',
      headers: {'Content-Type': 'application/cbor'},
      body: bytes,
      signal: ctrl.signal,
    });
    const bodyText = await res.text().catch(() => '');
    return {ok: res.ok, status: res.status, requestIdHex: signed.requestIdHex, bodyText};
  } finally {
    clearTimeout(t);
  }
}

/** The receive HERO's display figure (the app's round-1 item 8 rule) — verbatim port of lib.mjs. */
export function fmtHero(raw: string, decimals: number, unit: string, o: {stable?: boolean; displayDecimals?: number | null} = {}): string {
  const dd = o.stable ? 2 : (o.displayDecimals ?? decimals);
  const scale = 10n ** BigInt(decimals);
  const whole = (BigInt(raw) / scale).toString();
  let frac = (BigInt(raw) % scale).toString().padStart(decimals, '0').slice(0, dd).replace(/0+$/, '');
  return frac ? `${whole}.${frac} ${unit}` : `${whole} ${unit}`;
}
