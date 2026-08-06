// Minimal Solana JSON-RPC 2.0 client over `fetch` with bounded timeouts. NETWORK module —
// dynamic-imported from the seam `app/solana.ts` so `@solana/*` (here: none) and real RPC never run
// under jest/e2e (the seam no-ops when `SOLANA_RPC_URL` is empty, which jest.setup.js + the e2e
// driver set). Exposes the four calls the online SOL MVP needs:
//   getBalance, getLatestBlockhash, sendTransaction, confirmTransaction (poll getSignatureStatuses).
//
// Timeouts mirror `services/relay.ts`'s manual `AbortController + setTimeout` compose (NOT
// AbortSignal.any/AbortSignal.timeout — those ES2024/ES2022 statics are absent from this project's
// TS `lib` and not guaranteed on Hermes/RN). A caller signal (first-abort-wins) is forwarded in.

export interface SolanaBlockhash {
  /** base58-encoded recent blockhash (raw RPC shape — decode to 32 bytes at the call site). */
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export interface SolanaRpcOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** confirmTransaction poll spacing (default 1.5s). */
  pollMs?: number;
}

export interface SolanaSignatureStatus {
  readonly confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
  readonly err?: unknown;
}

const DEFAULT_TIMEOUT_MS = 8000;
const CONFIRM_TIMEOUT_MS = 30000;
const CONFIRM_POLL_MS = 1500;

let nextId = 1;

function composeTimeout(callerSignal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): {signal: AbortSignal; cancel: () => void} {
  if (callerSignal) return {signal: callerSignal, cancel: () => {}};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return {signal: ctrl.signal, cancel: () => clearTimeout(timer)};
}

async function rpcFetch(url: string, method: string, params: unknown[], opts?: SolanaRpcOpts): Promise<unknown> {
  const {signal, cancel} = composeTimeout(opts?.signal, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: nextId++, method, params}),
      signal,
    });
    if (!r.ok) throw new Error(`solana rpc http ${r.status}`);
    const j: {error?: {message?: string}; result?: unknown} = await r.json();
    if (j.error) throw new Error(`solana rpc: ${j.error.message ?? 'error'}`);
    return j.result;
  } finally {
    cancel();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, {once: true});
  });
}

/** Read an account's lamport balance as a decimal-digit string (lamports < 2^53 for all real
 *  supplies, but String() keeps the app-wide "amounts are strings" invariant). */
export async function getBalance(url: string, address: string, opts?: SolanaRpcOpts): Promise<string> {
  const result = (await rpcFetch(url, 'getBalance', [address], opts)) as {value: number};
  return String(result.value);
}

/** Fetch a fresh recent blockhash + its last-valid block height (needed to build + track a tx). */
export async function getLatestBlockhash(url: string, opts?: SolanaRpcOpts): Promise<SolanaBlockhash> {
  const result = (await rpcFetch(url, 'getLatestBlockhash', [], opts)) as {
    value: {blockhash: string; lastValidBlockHeight: number};
  };
  return {blockhash: result.value.blockhash, lastValidBlockHeight: result.value.lastValidBlockHeight};
}

/** Broadcast a raw signed transaction (bytes). Base64-encodes internally for the wire. Returns the
 *  transaction signature (base58). */
export async function sendTransaction(url: string, rawBytes: Uint8Array, opts?: SolanaRpcOpts): Promise<string> {
  const result = (await rpcFetch(url, 'sendTransaction', [bytesToBase64(rawBytes), {encoding: 'base64'}], opts)) as string;
  return result;
}

/** Poll `getSignatureStatuses` until the transaction is confirmed/finalized. Throws on a reported
 *  transaction error or a timeout (the tx may still land after a timeout — the caller surfaces that
 *  truthfully, never as a false success). */
export async function confirmTransaction(url: string, signature: string, opts?: SolanaRpcOpts): Promise<void> {
  const deadline = Date.now() + (opts?.timeoutMs ?? CONFIRM_TIMEOUT_MS);
  while (true) {
    if (opts?.signal?.aborted) throw new Error('aborted');
    const result = (await rpcFetch(url, 'getSignatureStatuses', [[signature]], {
      signal: opts?.signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })) as {value: (SolanaSignatureStatus | null)[]};
    const status = result.value?.[0];
    if (status) {
      if (status.err != null) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }
    if (Date.now() >= deadline) throw new Error('solana confirmation timeout');
    await sleep(opts?.pollMs ?? CONFIRM_POLL_MS, opts?.signal);
  }
}

// RFC 4648 base64 of a byte array. Hand-rolled (no Buffer/btoa dependency) so it is identical on
// RN/Hermes, jest/Node, and the e2e browser bundle.
function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 0x3f] : '=';
  }
  return out;
}
