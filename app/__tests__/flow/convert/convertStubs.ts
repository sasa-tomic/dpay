/**
 * convertStubs.ts — the offline venue stand-ins the convert flows need, re-expressed for the
 * jest flow tier. e2e kept these as IN-PAGE window.fetch replacements driven by driver.eval
 * (e2e/harness/{jupiter,cctp,sideshift,solaccounts}.mjs); jest has no page, so the same seams
 * install as wrappers over the harness's own fetch rewrite (setupFlow.ts) and as plain
 * globalThis objects — same seam NAMES (`__DPAY_TEST_SOLANA_RPC_STUB`, `__DPAY_TEST_EVM_SIGN`),
 * same fail-closed rule (an unexpected origin is recorded and thrown, never papered over).
 *
 * What is NOT re-expressed: the venue/quote CLIENTS (app/services/{sideshift,jupiter}.ts run
 * for real against the relay's test-stub upstreams — configure/hits below are plain HTTP calls)
 * and the wallet identity mirrors (the app's own pure modules derive them: solana/identity,
 * solana/spl, evm/identity, and the wasm core's icpAccountIdFromPrincipal). The two small
 * byte-builders the venue fixtures need (the unsigned legacy swap tx, the getTransaction
 * detail) mirror e2e/harness/jupiter.mjs and are cross-checked by the app's own decode paths.
 */
import type {SolanaRpcStub, SolanaTransactionDetail} from '../../../solana/rpc';
import {relayBaseURL, relayGet, relayPost} from '../harness/relayClient';
import {DpayCore} from '../harness/lib';

// --- the wrapper stack (dispose in afterEach; jest's globals are per-FILE, not per-test) --------

type Wrapped = {prev: typeof fetch};
const wrappers: Wrapped[] = [];

/** Wrap globalThis.fetch (ON TOP of the harness rewrite — setupFlow installed first, so this
 *  sees the app's ORIGINAL url strings). */
function wrapFetch(handlers: (parsed: URL, init: RequestInit | undefined) => Promise<Response | undefined>): void {
  const prev = globalThis.fetch;
  wrappers.push({prev});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let parsed: URL;
    try {
      parsed = new URL(url, 'http://localhost');
    } catch {
      return prev(input, init);
    }
    const handled = await handlers(parsed, init);
    return handled ?? prev(input, init);
  }) as typeof fetch;
}

/** Undo every wrapper this module installed (afterEach of every file that uses it), and reset
 *  the rail OPERATOR overrides the app captured at boot — setSolanaRpcUrl/setEvmRpcUrl win over
 *  the test overrides for the whole module session, so a rail enabled for one flow must be
 *  cleared before the next one boots, or its placeholder endpoint pollutes every later fetch. */
export function disposeConvertStubs(): void {
  while (wrappers.length > 0) {
    globalThis.fetch = wrappers.pop()!.prev;
  }
  delete (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: unknown}).__DPAY_TEST_SOLANA_RPC_STUB;
  delete (globalThis as {__DPAY_TEST_EVM_SIGN?: unknown}).__DPAY_TEST_EVM_SIGN;
  setSolanaRpcUrl('');
  setEvmRpcUrl('');
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

// --- relay test knobs (the same routes e2e posts to) ---------------------------------------------

export async function swapPoolKnob(body: Record<string, unknown>): Promise<void> {
  const r = await relayPost('/api/v1/test/swap_pool', body);
  if (!r.ok) throw new Error(`swap_pool knob ${r.status}: ${await r.text()}`);
}

export async function venueKnob(venueId: string, served: boolean): Promise<void> {
  const r = await relayPost('/api/v1/test/venue', {venue_id: venueId, served});
  if (!r.ok) throw new Error(`venue knob ${r.status}: ${await r.text()}`);
}

export async function approveFailKnob(ledger: string): Promise<void> {
  const r = await relayPost('/api/v1/test/approve_fail', {ledger});
  if (!r.ok) throw new Error(`approve_fail knob ${r.status}: ${await r.text()}`);
}

export async function icDelayKnob(method: string, ms: number): Promise<void> {
  const r = await relayPost('/api/v1/test/ic_delay', {method, ms});
  if (!r.ok) throw new Error(`ic_delay knob ${r.status}: ${await r.text()}`);
}

/** The relay sideshift upstream's audit counters (credentialed vs bare calls, per kind). */
export async function sideshiftRelayHits(): Promise<{bareCalls: number; shiftCalls: number; quoteCalls: number}> {
  return await relayGet('/api/v1/test/sideshift-upstream/hits') as {bareCalls: number; shiftCalls: number; quoteCalls: number};
}

export async function trocadorRelayHits(): Promise<{bareCalls: number; tradeCalls: number; rateCalls: number; keyCalls: number; statusCalls: number; lastTradeQuery?: string; lastQuery?: string}> {
  return await relayGet('/api/v1/test/trocador-upstream/hits') as {
    bareCalls: number; tradeCalls: number; rateCalls: number; keyCalls: number; statusCalls: number; lastTradeQuery?: string; lastQuery?: string;
  };
}

export async function trocadorConfig(state: Record<string, unknown>): Promise<void> {
  const r = await relayPost('/api/v1/test/trocador-upstream/config', state);
  if (!r.ok) throw new Error(`trocador config ${r.status}: ${await r.text()}`);
}

// --- the wallet's identity mirrors (the APP's own pure modules — never re-implemented) -----------

import {deriveSolanaKeypair} from '../../../solana/identity';
import {deriveAta} from '../../../solana/spl';
import bs58 from 'bs58';
import {deriveEvmKeypair, toChecksumAddress} from '../../../evm/identity';

export {deriveSolanaKeypair, deriveAta, deriveEvmKeypair};
export const eip55 = (lowerHex: string): string => toChecksumAddress(lowerHex);
export const bs58Encode = (bytes: Uint8Array): string => bs58.encode(bytes);

/** The IC account identifier (the 64-hex deposit-rail address the venue's IC payout layer
 *  requires) — derived through the SAME wasm core the app uses for its refund address. */
export async function icpAccountIdHex(publicHex: string): Promise<string> {
  const principal = await DpayCore.icpPrincipalFromPubkey(publicHex);
  return DpayCore.icpAccountIdFromPrincipal(principal, '');
}

// --- the SOL rail: enable + the in-memory RPC simulator -------------------------------------------

import {SOLANA_RPC_STORAGE_KEY, setSolanaRpcUrl} from '../../../config/constants';
import {setEvmRpcUrl} from '../../../evm/endpoints';

/**
 * Turn the SOL rail ON the way production configures it: the OPERATOR override (Settings ▸
 * Advanced, persisted — App reads it at boot and it wins over jest.setup.js's empty test
 * override), pointed at a placeholder https mainnet-looking endpoint. The in-memory RPC stub
 * below answers every method BEFORE any fetch, so the placeholder is never dialed.
 * Returns the storage key value to await-clean in the test's own AsyncStorage teardown
 * (installFlowLifecycle already clears AsyncStorage between tests).
 */
export async function enableSolRail(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = require('@react-native-async-storage/async-storage') as {setItem: (k: string, v: string) => Promise<void>};
  await AsyncStorage.setItem(SOLANA_RPC_STORAGE_KEY, 'https://sol-stub.dpay.invalid');
}

type SolAccountsSpec = {
  lamports?: number | null;
  token?: {amount: string; decimals: number} | null;
  tokens?: Record<string, {amount: string; decimals: number} | null>;
  slot?: number;
};

/** The `getMultipleAccounts` answer over [wallet, ata(m0), m0, ata(m1), m1, …] — the write side
 *  of the layouts pinned by app/__tests__/solana-account-decode.test.ts (the solaccounts.mjs
 *  port: a mint absent from `tokens`/`token` answers null, a real known-absent). */
function solAccountsAnswer(params: unknown[], spec: SolAccountsSpec): unknown {
  const addresses = params[0] as string[];
  void addresses;
  if (!Array.isArray(addresses)) throw new Error('solAccountsAnswer: params[0] is not an array');
  const owner = addresses[0];
  const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
  const tokenAccount = (mint: string, amt: string): unknown => {
    const b = new Uint8Array(165);
    b.set(bs58.decode(mint), 0);
    b.set(bs58.decode(owner), 32);
    let v = BigInt(amt);
    for (let i = 0; i < 8; i++) { b[64 + i] = Number(v & 0xffn); v >>= 8n; }
    return {lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toB64(b), 'base64'], executable: false, rentEpoch: 0, space: 165};
  };
  const mintAccount = (decimals: number): unknown => {
    const b = new Uint8Array(82);
    b[44] = decimals;
    return {lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [toB64(b), 'base64'], executable: false, rentEpoch: 0, space: 82};
  };
  const tokens = spec.tokens ?? {};
  const value = addresses.map((_addr, i) => {
    if (i === 0) {
      return spec.lamports == null ? null : {lamports: spec.lamports, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0};
    }
    const isMint = i % 2 === 0;
    const mint = isMint ? addresses[i] : addresses[i + 1];
    const t = mint in tokens ? tokens[mint] : (spec.token ?? null);
    if (isMint) return mintAccount(t?.decimals ?? 6);
    return t ? tokenAccount(mint, t.amount) : null;
  });
  return {context: {slot: spec.slot ?? 250000000}, value};
}

/** base58 of the tx's own first signature slot (sigCount=1 || sig[64]) — the convert driver
 *  checks the node's signature IS the one the device signed, so the stub must echo it. */
function sigFromRawTx(rawB64: string): string {
  const bytes = new Uint8Array(Buffer.from(rawB64, 'base64'));
  return bs58.encode(bytes.slice(1, 65));
}

/** What the venue's legacy swap tx bytes look like for THIS wallet (e2e jupiter.mjs port). */
export function jupiterSwapTxB64(userPublicKey: string, userAta: string): string {
  const user = bs58.decode(userPublicKey);
  const ata = bs58.decode(userAta);
  const tokenProgram = bs58.decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const blockhash = new Uint8Array(32).fill(7);
  const message = new Uint8Array([
    1, 0, 1, // header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
    3, // account count (compact-u16)
    ...user, ...ata, ...tokenProgram,
    ...blockhash,
    1, // instruction count (compact-u16)
    2, // programIdIndex: the (fake) route program at the third static key
    2, 0, 1, // key count (compact-u16) + key indices
    3, 1, 2, 3, // data length (compact-u16) + route calldata
  ]);
  const tx = new Uint8Array(1 + 64 + message.length);
  tx[0] = 1;
  tx.set(message, 65);
  return Buffer.from(tx).toString('base64');
}

/** The getTransaction json detail the settle path re-reads — the realized-payout oracle
 *  (e2e jupiter.mjs port; the postTokenBalances row whose mint is the OUT mint and whose
 *  owner is the user IS the chain's own account of what the route paid). */
export function solConvertTxDetail(opts: {
  userPublicKey: string; userAta: string; outAmount: number;
  mint?: string; decimals?: number; slot?: number;
}): SolanaTransactionDetail {
  const mint = opts.mint ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const decimals = opts.decimals ?? 6;
  return {
    slot: opts.slot ?? 250000003,
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      fee: 5000,
      preBalances: [5000000000, 2039280, 1],
      postBalances: [4999995000, 2039280, 1],
      preTokenBalances: [],
      postTokenBalances: [{
        accountIndex: 1,
        mint,
        owner: opts.userPublicKey,
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: {amount: String(opts.outAmount), decimals, uiAmount: opts.outAmount / 10 ** decimals},
      }],
    },
    transaction: {
      message: {
        accountKeys: [opts.userPublicKey, opts.userAta, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
        recentBlockhash: bs58.encode(new Uint8Array(32).fill(7)),
        header: {numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1},
        instructions: [{programIdIndex: 2, accounts: [0, 1], data: Buffer.from([1, 2, 3]).toString('base64')}],
        version: 'legacy',
      },
      signatures: [],
    },
  } as unknown as SolanaTransactionDetail;
}

export type SolRpcStubCfg = {
  /** keyed getTransaction: the Circle forward tx hash → tokenDetail; anything else → swapDetail. */
  forwardTxHash?: string;
  tokenDetail?: SolanaTransactionDetail;
  swapDetail?: unknown;
  /** cefi flows never broadcast — the stub refuses loudly instead of echoing a signature. */
  refuseSend?: boolean;
};

const solSent: Array<{signature: string; raw: string}> = [];

/** Broadcasts recorded so far this file (fresh per install — the __E2E_SOL_SENT counterpart). */
export function solSentTxs(): Array<{signature: string; raw: string}> {
  return solSent;
}

/** Install the in-memory SOL RPC simulator (the seam every SOL flow uses, checked per-call in
 *  app/solana/rpc.ts — no fetch involved, so it composes with every fetch wrapper). */
export function installSolRpcStub(cfg: SolRpcStubCfg = {}): void {
  solSent.length = 0;
  const stub: SolanaRpcStub = {
    getMultipleAccounts: ((p: unknown[]) => solAccountsAnswer(p, {lamports: 5000000000, token: {amount: '2500000', decimals: 6}})) as SolanaRpcStub['getMultipleAccounts'],
    getGenesisHash: () => Promise.resolve('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
    getLatestBlockhash: () => Promise.resolve({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
    getMinimumBalanceForRentExemption: () => Promise.resolve(1447680),
    getFeeForMessage: () => Promise.resolve({context: {slot: 250000000}, value: {lamports: 5000}}),
    sendTransaction: (params: unknown[]) => {
      if (cfg.refuseSend === true) throw new Error('NO BROADCAST: the cefi deposit is a handoff, the app never sends');
      const raw = Array.isArray(params) ? (params[0] as string) : null;
      const signature = sigFromRawTx(raw ?? '');
      solSent.push({signature, raw: raw ?? ''});
      return Promise.resolve(signature);
    },
    getSignatureStatuses: () => Promise.resolve({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
    getSignaturesForAddress: () => Promise.resolve([]),
    getBlockHeight: () => Promise.resolve(250000000),
    getTransaction: (params: unknown[]) => {
      const sig = Array.isArray(params) ? (params[0] as string) : null;
      if (cfg.forwardTxHash != null && sig === cfg.forwardTxHash) return Promise.resolve(cfg.tokenDetail ?? null);
      return Promise.resolve(cfg.swapDetail ?? null);
    },
    getBalance: () => Promise.resolve({value: 5000000000}),
    getAccountInfo: () => Promise.resolve({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
    getTokenAccountBalance: () => Promise.resolve({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
  } as unknown as SolanaRpcStub;
  (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB = stub;
}

// --- the Jupiter test-stub upstream (RELAY-side state; configure + read back) ---------------------

export async function configureJupiterStub(cfg: {
  quote: {outAmount: string; otherAmountThreshold: string; priceImpact?: string | null};
  userPublicKey: string;
  txB64: string;
  lastValidBlockHeight: number;
}): Promise<void> {
  const r = await relayPost('/api/v1/test/jupiter-upstream/config', {
    quote: {outAmount: cfg.quote.outAmount, otherAmountThreshold: cfg.quote.otherAmountThreshold, priceImpact: cfg.quote.priceImpact ?? null},
    userPublicKey: cfg.userPublicKey,
    txB64: cfg.txB64,
    lastValidBlockHeight: cfg.lastValidBlockHeight,
  });
  if (!r.ok) throw new Error(`configureJupiterStub: relay stub config refused (${r.status})`);
}

export type JupiterStubState = {
  unexpected: string[];
  userMismatch?: unknown;
  swapCalls: Array<{asLegacyTransaction: boolean; wrapAndUnwrapSol: boolean}>;
  quoteCalls: Array<{inputMint: string; outputMint: string; amount: string; slippageBps: string}>;
  lastQuoteResponse: {inAmount: string; outAmount: string; inputMint?: string; outputMint?: string; platformFee: unknown} | null;
};

export async function jupiterStubState(): Promise<JupiterStubState | null> {
  try {
    return await relayGet('/api/v1/test/jupiter-upstream/hits', 4000) as JupiterStubState;
  } catch {
    return null;
  }
}

// --- the Circle CCTP v2 stub (the cctp.mjs port) ---------------------------------------------------

export const CCTP_FEES_BODY = [
  {finalityThreshold: 1000, minimumFee: 1, forwardFee: {low: 269688, med: 282032, high: 305756}},
  {finalityThreshold: 2000, minimumFee: 0, forwardFee: {low: 269688, med: 282032, high: 305756}},
];

/** Circle's destination-mint signature standing in for the Forwarding Service's Solana tx. */
export const FORWARD_TX_HASH = '5KqxTAk9FnZfQrpHcQhg5rHJFwjW9uF2mYbAoXdE3vRk';

/** Mirror of the app's fee math (app/cctp.ts) so the flow predicts the census digits. */
export function cctpFeeExpectations(minOut: bigint): {maxFee: bigint; mintFloor: bigint} {
  const base = (minOut * 1n) / 10000n + 282032n; // protocolFee (1 bps) + med forwardFee
  const maxFee = (base * 6n) / 5n; // +20% buffer, floored
  return {maxFee, mintFloor: minOut - maxFee};
}

type CctpState = {
  state: 'pending' | 'attested' | 'complete';
  feesCalls: number;
  messageCalls: Array<{hash: string; state: string}>;
  balanceCalls: Array<{address?: string}>;
  unexpected: string[];
  forwardTxHash: string;
};

let cctp: CctpState | null = null;

/** Install the Circle stub. In jest the pass-through origins are the relay the IC boundary
 *  dials AND the baked origin the fetch rewrite re-points (this wrapper runs FIRST). */
export function installCctpStub(cfg: {forwardTxHash?: string; fees?: unknown; ethBalanceHex?: string} = {}): void {
  cctp = {
    state: 'pending', feesCalls: 0, messageCalls: [], balanceCalls: [], unexpected: [],
    forwardTxHash: cfg.forwardTxHash ?? FORWARD_TX_HASH,
  };
  const passOrigins = new Set([new URL(relayBaseURL()).origin, 'https://dpay.kalaj.org']);
  wrapFetch(async (parsed, init) => {
    if (parsed.origin === 'https://ethereum-rpc.publicnode.com') {
      let body: {method?: string; params?: unknown[]; id?: number} = {};
      try { body = JSON.parse(String(init?.body ?? '{}')) as typeof body; } catch { /* fall through */ }
      if (body.method === 'eth_getBalance') {
        cctp!.balanceCalls.push({address: body.params?.[0] as string | undefined});
        return json({jsonrpc: '2.0', id: body.id ?? 1, result: cfg.ethBalanceHex ?? '0x0'});
      }
      cctp!.unexpected.push(`publicnode-method:${body.method ?? '?'}`);
      throw new TypeError(`cctp stub: unexpected publicnode method ${body.method}`);
    }
    if (parsed.origin === 'https://iris-api.circle.com') {
      if (parsed.pathname.startsWith('/v2/burn/USDC/fees/')) {
        cctp!.feesCalls += 1;
        return json(cfg.fees ?? CCTP_FEES_BODY);
      }
      if (parsed.pathname.startsWith('/v2/messages/')) {
        const hash = parsed.searchParams.get('transactionHash') ?? '';
        const state = cctp!.state;
        cctp!.messageCalls.push({hash, state});
        if (state === 'complete') {
          return json({messages: [{forwardTxHash: cctp!.forwardTxHash, status: 'complete', forwardState: 'COMPLETED'}], sourceTxHash: hash});
        }
        if (state === 'attested') {
          return json({messages: [{status: 'complete', forwardState: 'PENDING'}], sourceTxHash: hash});
        }
        // pending — Circle's honest not-yet-attested answer is a 404 with a JSON error body.
        return json({error: 'Message not found for provided parameters'}, 404);
      }
      cctp!.unexpected.push(`circle-path:${parsed.pathname}`);
      throw new TypeError(`cctp stub: unexpected Circle path ${parsed.pathname}`);
    }
    if (passOrigins.has(parsed.origin)) return undefined; // through to the harness rewrite
    cctp!.unexpected.push(parsed.origin);
    throw new TypeError(`cctp stub: unexpected origin ${parsed.origin}`);
  });
}

export function setCctpMessageState(state: 'pending' | 'attested' | 'complete'): void {
  if (cctp == null) throw new Error('cctp stub not installed');
  cctp.state = state;
}

export function cctpStubState(): CctpState & {feesBody?: unknown} {
  if (cctp == null) throw new Error('cctp stub not installed');
  return {state: cctp.state, feesCalls: cctp.feesCalls, messageCalls: [...cctp.messageCalls], balanceCalls: [...cctp.balanceCalls], unexpected: [...cctp.unexpected], forwardTxHash: cctp.forwardTxHash};
}

/** A MUTABLE external-wallet balance answer layered OVER the cctp stub (last wrap wins for the
 *  publicnode origin) — the gas-fund flow moves the balance between rechecks. */
export function installMutableEthBalance(initialHex: string): {set: (hex: string) => void; reads: () => number} {
  let hex = initialHex;
  let reads = 0;
  wrapFetch(async (parsed, init) => {
    if (parsed.origin !== 'https://ethereum-rpc.publicnode.com') return undefined;
    let body: {method?: string; params?: unknown[]; id?: number} = {};
    try { body = JSON.parse(String(init?.body ?? '{}')) as typeof body; } catch { /* fall through */ }
    if (body.method !== 'eth_getBalance') return undefined;
    reads += 1;
    return json({jsonrpc: '2.0', id: body.id ?? 1, result: hex});
  });
  return {set: (next: string) => { hex = next; }, reads: () => reads};
}

// --- the SideShift keyless status stub (the sideshift.mjs port) -----------------------------------

type SideShiftState = {
  status: string;
  extra: Record<string, unknown>;
  statusCalls: Array<{id: string}>;
  unexpected: string[];
};

let sideshift: SideShiftState | null = null;

export function installSideShiftStub(cfg: {initialStatus?: string} = {}): void {
  sideshift = {status: cfg.initialStatus ?? 'waiting', extra: {}, statusCalls: [], unexpected: []};
  const passOrigins = new Set([new URL(relayBaseURL()).origin, 'https://dpay.kalaj.org']);
  wrapFetch(async (parsed) => {
    if (!parsed.protocol.startsWith('http')) return undefined;
    if (passOrigins.has(parsed.origin)) return undefined;
    if (parsed.origin === 'https://sideshift.ai' && parsed.pathname.startsWith('/api/v2/shifts/')) {
      const id = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
      sideshift!.statusCalls.push({id});
      return json({id, status: sideshift!.status, ...sideshift!.extra});
    }
    sideshift!.unexpected.push(parsed.href);
    throw new TypeError(`sideshift stub: unexpected origin ${parsed.origin}`);
  });
}

export function setSideShiftStatus(status: string, extra: Record<string, unknown> = {}): void {
  if (sideshift == null) throw new Error('sideshift stub not installed');
  sideshift.status = status;
  sideshift.extra = extra;
}

export function sideShiftStubState(): {status: string; statusCalls: Array<{id: string}>; unexpected: string[]} | null {
  if (sideshift == null) return null;
  return {status: sideshift.status, statusCalls: [...sideshift.statusCalls], unexpected: [...sideshift.unexpected]};
}

// --- the EVM wallet double (the handoff signing seam, read at CALL time by the app) ---------------

const evmSigns: Array<Record<string, unknown>> = [];

export function installEvmSignSeam(burnHash: string): void {
  evmSigns.length = 0;
  (globalThis as {__DPAY_TEST_EVM_SIGN?: unknown}).__DPAY_TEST_EVM_SIGN = async (txs: Record<string, unknown>): Promise<string> => {
    evmSigns.push(txs);
    return burnHash;
  };
}

export function evmSignsRecorded(): Array<Record<string, unknown>> {
  return evmSigns;
}

// --- display helpers (the flows' fmt8 twins) ------------------------------------------------------

/** Raw ledger units → the compact formatter's string (trailing zeros trimmed). */
export function fmt(raw: bigint | number | string, decimals: number): string {
  const n = BigInt(raw);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const d = BigInt(decimals);
  const frac = (abs % 10n ** d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${abs / 10n ** d}${frac ? '.' + frac : ''}`;
}

/** The app's exact 1% slippage floor math (default 100 bps). */
export function floor99(gross: bigint): bigint {
  return (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
}
