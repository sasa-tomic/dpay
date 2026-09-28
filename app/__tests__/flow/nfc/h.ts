/**
 * Batch-D flow helpers — the ported slices of `e2e/harness/flow-steps.mjs` (nfcPhase/nfcPhaseWalk),
 * the aria-label button press (the DOM `button[aria-label=…]` idiom the e2e NFC flows use, re-expressed
 * as a react-test-renderer tree probe), and the SOL v2 fixture builders the e2e flows keep inline
 * (base58, sig extraction, solreq builder, the getTransaction settle-gate fixture from
 * `e2e/harness/soltx.mjs`, and the `__DPAY_SOL_ACCOUNTS` encoder from `e2e/harness/solaccounts.mjs`).
 * Test-file helpers only — the harness core (flow/harness/*) is frozen and untouched.
 */
import {act} from 'react-test-renderer';
import type {Mount} from '../harness/lib';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {installFlowLifecycle} = require('../harness/setupFlow') as {installFlowLifecycle: () => void};

// The per-test lifecycle (fresh AsyncStorage, seam resets, the fail-closed fetch assertion) is
// registered by jest.flow-after-env.js, which the flow project's config wires as a
// setupFilesAfterEnv file (harness M3). The exported installer stays CALLABLE at collection time
// (it is idempotent — the second registration no-ops), so this batch-D helper keeps working
// unchanged either way.
installFlowLifecycle();

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the NFC phase machine (flow-steps.mjs port) --------------------------------------------------

/** The app's phase → status-line contract (NfcView). `awaitingApproval` maps to the exchanging
 *  line (auto-sign retires the review park). */
export const NFC_PHASE_TEXT: Record<string, string> = {
  linking: 'Connecting',
  exchanging: 'Communicating',
  awaitingApproval: 'Communicating',
  settling: 'Confirming',
  success: 'Paid ✓',
  pending: 'Not confirmed',
  declined: 'Declined',
};

export type NfcEvent = Record<string, unknown>;
export type NfcDispatch = (event: NfcEvent) => Promise<void>;

export type PhaseOpts = {
  role?: string;
  timeoutMs?: number;
  /** Override the phase→text contract; `null` skips the wait entirely. */
  text?: string | null;
  /** The status surface to mount-wait before the text wait (the session-opener step). */
  statusId?: string;
};

/** Dispatch one NFC phase event through `dispatch`, then wait for the status surface + its text.
 *  Returns the waitForText boolean (false on timeout) — the caller gates or discards. */
export async function nfcPhase(m: Mount, dispatch: NfcDispatch, phase: string, opts: PhaseOpts = {}): Promise<boolean> {
  const role = opts.role ?? 'card';
  const timeoutMs = opts.timeoutMs ?? 4000;
  const text = 'text' in opts ? opts.text : NFC_PHASE_TEXT[phase] ?? null;
  await dispatch({type: 'phase', role, phase});
  if (opts.statusId) await m.driver.findByTestID(opts.statusId, {timeoutMs});
  if (text == null) return true;
  return m.driver.waitForText(text, {timeoutMs});
}

/** Walk phases in order; the FIRST one may mount the status surface (the session opener). */
export async function nfcPhaseWalk(m: Mount, dispatch: NfcDispatch, phases: string[], opts: PhaseOpts = {}): Promise<boolean[]> {
  const results: boolean[] = [];
  for (let i = 0; i < phases.length; i++) {
    const ok = await nfcPhase(m, dispatch, phases[i], {...opts, statusId: i === 0 ? opts.statusId : undefined});
    if (ok === false) {
      throw new Error(`[nfcPhaseWalk] ${phases[i]} should show "${opts.text ?? NFC_PHASE_TEXT[phases[i]]}…"`);
    }
    results.push(ok);
  }
  return results;
}

// --- aria-label button press (the e2e clickNfcButton idiom) ---------------------------------------

/** Press the pressable whose accessibilityLabel is `expected`; poll for the label first (a phase
 *  event only queues a React update — the same tick can still show the OLD label). Returns the
 *  label actually pressed, or whichever of `fallbacks` was present when the poll ran out. */
export async function clickByAria(m: Mount, expected: string, fallbacks: string[] = ['Done', 'Cancel'], timeoutMs = 4000): Promise<string | null> {
  const find = (label: string) =>
    m.tree.root.findAll((n) => n.props && (n.props.accessibilityLabel === label || n.props['aria-label'] === label) && typeof n.props.onPress === 'function');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = find(expected);
    if (hits.length > 0) {
      act(() => { hits[0].props.onPress(hits[0].props.onPressParam); });
      return expected;
    }
    if (Date.now() > deadline) break;
    await sleep(50);
  }
  for (const label of fallbacks) {
    const hits = find(label);
    if (hits.length > 0) return label;
  }
  return null;
}

/** A testID presence probe for the motion-beat assertions (the e2e `has` helper). */
export function has(m: Mount, testID: string): boolean {
  return m.driver.isPresent(testID);
}

// --- SOL v2 fixtures (the e2e flows' inline builders, verbatim in spirit) -------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function bs58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

/** Extract the first 64-byte signature from a v2 solpay URI (base64url tx → compact-u16 || sig64 || msg). */
export function extractSig(solpayUri: string): string {
  const payload = solpayUri.split('solpay:v2?')[1];
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const tx = Buffer.from(obj.tx, 'base64url');
  return bs58Encode(new Uint8Array(tx.slice(1, 65)));
}

export const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
export const PAY_LAMPORTS = '1000000'; // 0.001 SOL

/** Build a solreq:v2 URI; `opts.expired` anchors iat/exp in the past (exp-iat ≤ 90 so the
 *  structural decode passes and the freshness gate is what fires). `amt` is the wire the request
 *  carries — flow 47 passes the NETTED wire (price − 5000 fee), the others the gross. */
export function buildSolReq(opts: {expired?: boolean; rid?: string; amt?: string} = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const iat = opts.expired ? now - 85 : now;
  const exp = opts.expired ? now - 5 : iat + 90;
  const obj = {
    v: 2, rid: opts.rid ?? 'c'.repeat(32), net: 'mainnet-beta',
    bh: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN',
    lvh: 300_000_000, slot: 250_000_000,
    iat, exp,
    to: MERCHANT_ADDR, amt: opts.amt ?? PAY_LAMPORTS, cur: 'SOL',
    mint: null, toAta: null, name: 'merchant', memo: '',
  };
  return 'solreq:v2?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function readCompactU16(bytes: Uint8Array, off: number): {value: number; next: number} {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const b = bytes[i]; i++;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return {value, next: i};
    shift += 7;
  }
}

/**
 * The getTransaction json-detail a REAL node would answer for the captured signed solpay:v2 —
 * derived FROM the canonical bytes, which is exactly what makes the settle gate match.
 * (`e2e/harness/soltx.mjs#solTxDetailFromSolpay`, ported; `over` splices the deliberate defects
 * flow 138 drives: a wrong body, meta.err.)
 */
export function solTxDetailFromSolpay(solpayUri: string, over: {message?: Record<string, unknown>; meta?: Record<string, unknown>; metaNull?: boolean; err?: unknown} = {}): Record<string, unknown> {
  const payload = solpayUri.split('solpay:v2?')[1];
  if (!payload) throw new Error('solTxDetailFromSolpay: not a solpay:v2 URI');
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const tx = new Uint8Array(Buffer.from(obj.tx, 'base64url'));
  const sigs = readCompactU16(tx, 0);
  const msg = tx.subarray(sigs.next + sigs.value * 64);
  let off = 0;
  const header = {
    numRequiredSignatures: msg[off++],
    numReadonlySignedAccounts: msg[off++],
    numReadonlyUnsignedAccounts: msg[off++],
  };
  const nk = readCompactU16(msg, off); off = nk.next;
  const accountKeys: string[] = [];
  for (let i = 0; i < nk.value; i++) { accountKeys.push(bs58Encode(msg.subarray(off, off + 32))); off += 32; }
  const recentBlockhash = bs58Encode(msg.subarray(off, off + 32)); off += 32;
  const ni = readCompactU16(msg, off); off = ni.next;
  const instructions: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ni.value; i++) {
    const programIdIndex = msg[off++];
    const na = readCompactU16(msg, off); off = na.next;
    const accounts: number[] = [];
    for (let j = 0; j < na.value; j++) accounts.push(msg[off++]);
    const nd = readCompactU16(msg, off); off = nd.next;
    instructions.push({programIdIndex, accounts, data: Buffer.from(msg.subarray(off, off + nd.value)).toString('base64')});
    off += nd.value;
  }
  return {
    slot: 250_000_003,
    blockTime: Math.floor(Date.now() / 1000),
    meta: over.metaNull ? null : {err: over.err ?? null, fee: 5000, preBalances: [], postBalances: [], ...over.meta},
    transaction: {message: {accountKeys, recentBlockhash, header, instructions, version: 'legacy', ...over.message}},
  };
}

// --- the SOL RPC stub environment -----------------------------------------------------------------

type SolAccountSpec = {lamports?: number | null; token?: {amount: string; decimals: number} | null; tokens?: Record<string, {amount: string; decimals: number} | null>};

/** The `__DPAY_SOL_ACCOUNTS` page helper (e2e/harness/solaccounts.mjs, ported): answers
 *  getMultipleAccounts with a wallet account + per-rail 165-byte SPL token accounts / 82-byte
 *  mints, so a stub declares NUMBERS and never SPL byte layouts. */
export function installSolAccounts(): (params: unknown[], spec: SolAccountSpec) => unknown[] {
  const decode58 = (s: string): Uint8Array => {
    const bytes = [0];
    for (const ch of s) {
      const v = B58.indexOf(ch);
      if (v < 0) throw new Error(`__DPAY_SOL_ACCOUNTS: not base58: ${s}`);
      let carry = v;
      for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  };
  const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
  const tokenAccount = (mint: string, owner: string, amount: string) => {
    const b = new Uint8Array(165);
    b.set(decode58(mint), 0);
    b.set(decode58(owner), 32);
    let v = BigInt(amount);
    for (let i = 0; i < 8; i++) { b[64 + i] = Number(v & 0xffn); v >>= 8n; }
    return {lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toBase64(b), 'base64'], executable: false, rentEpoch: 0, space: 165};
  };
  const mintAccount = (decimals: number) => {
    const b = new Uint8Array(82);
    b[44] = decimals;
    return {lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toBase64(b), 'base64'], executable: false, rentEpoch: 0, space: 82};
  };
  const helper = (params: unknown[], spec: SolAccountSpec): unknown[] => {
    const addresses = params[0] as string[];
    if (!Array.isArray(addresses)) throw new Error('__DPAY_SOL_ACCOUNTS: getMultipleAccounts params[0] is not an array');
    const owner = addresses[0];
    const tokens = spec.tokens ?? {};
    return addresses.map((_, i) => {
      if (i === 0) {
        return spec.lamports === null || spec.lamports === undefined
          ? null
          : {lamports: spec.lamports, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0};
      }
      const isMint = i % 2 === 0;
      const mint = isMint ? addresses[i] : addresses[i + 1];
      const t = mint in tokens ? tokens[mint] : (spec.token ?? null);
      if (isMint) return mintAccount(t?.decimals ?? 6);
      return t ? tokenAccount(mint, owner, t.amount) : null;
    });
  };
  g.__DPAY_SOL_ACCOUNTS = helper;
  return helper;
}

export type SolStub = Record<string, (...args: unknown[]) => unknown>;

/** Mutable handles the stub's sendTransaction/getTransaction echo (the e2e flows stash these in
 *  page globals; in jest the stub closes over this object directly). */
export type SolStubHandles = {sig: string | null; txDetail: Record<string, unknown> | null; getTxReads: number};

/** The standard v2 RPC stub (flow 51's shape): online enough for createSolPaymentRequest +
 *  broadcast + the settle gate. `over` splices the leg's defect (flow 53's throwing
 *  sendTransaction, flow 138's throwing getTransaction). */
export function makeSolStub(h: SolStubHandles, over: Partial<SolStub> = {}): SolStub {
  installSolAccounts();
  return {
    getMultipleAccounts: (p) => (g.__DPAY_SOL_ACCOUNTS as (p: unknown[], s: SolAccountSpec) => unknown[])(p as unknown[], {lamports: 5000000000, token: {amount: '2000000', decimals: 6}}),
    getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN', lastValidBlockHeight: 300000000}}),
    isBlockhashValid: () => ({context: {slot: 250000001}, value: true}),
    getBlockHeight: () => 250000001,
    sendTransaction: () => h.sig ?? 'sig_fallback',
    getSignatureStatuses: () => ({context: {slot: 250000002}, value: [{confirmationStatus: 'confirmed'}]}),
    getTransaction: () => h.txDetail,
    getBalance: () => ({value: 5000000000}),
    ...over,
  };
}

/**
 * The SOL-enabled module environment. `__DPAY_TEST_SOLANA_RPC_URL` is captured at
 * `app/config/constants.ts` MODULE LOAD, and every `../harness/lib` import pulls the whole app
 * graph statically — so a SOL flow must set the override BEFORE the first lib require. Calling
 * this (instead of importing lib at the top) is the mechanism: it sets the override, then
 * requires lib lazily. The RPC stub itself is per-call state — set/clear `g.__DPAY_TEST_SOLANA_RPC_STUB`.
 */
export function solEnv(): typeof import('../harness/lib') {
  g.__DPAY_TEST_SOLANA_RPC_URL = 'stub';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../harness/lib') as typeof import('../harness/lib');
}

export function setSolStub(stub: SolStub | null): void {
  g.__DPAY_TEST_SOLANA_RPC_STUB = stub;
}

// --- the convert-affordance census (flow 171's zero-tolerance probe) -------------------------------

function nodeText(n: {children: Array<string | {children?: unknown}>}): string {
  const found: string[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === 'string') { found.push(x); return; }
    const node = x as {children?: Array<unknown>} | undefined;
    for (const c of node?.children ?? []) walk(c);
  };
  for (const c of n.children) walk(c);
  return found.join('');
}

/** Every convert testID, the Accounts-Convert entry point, and any pressable whose whole label is
 *  "Convert" — the SAME probe flow 170/171 run over the DOM, walked over the rendered tree. */
export function convertCtaCount(m: Mount): number {
  let count = 0;
  const nodes = m.tree.root.findAll((n) => n.props && typeof n === 'object');
  for (const n of nodes) {
    const testID = n.props.testID as string | undefined;
    if (typeof testID === 'string' && (testID.startsWith('convert-') || testID.startsWith('btn-accounts-convert-'))) count += 1;
    else if (typeof n.props.onPress === 'function' && nodeText(n).trim() === 'Convert') count += 1;
  }
  return count;
}
