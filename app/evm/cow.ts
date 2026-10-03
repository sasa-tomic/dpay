// The COW SWAP adapter — network half: the venue quote, the approve/unwrap chain legs, the
// signed-order submission and the status poll, all through dpay's OWN relay pipes
// (`POST /api/v1/cow/mainnet/*` for the order API, the EVM RPC pipe for the chain legs —
// the same discipline as `evm/uniswap.ts`, whose gate order this module keeps). NETWORK
// module — reached ONLY through the seam `app/evm.ts` (dynamic import, gated on a non-empty
// `evmRpcUrl(chainId)` for the chain legs; the order API rides relayFetch like every venue
// client).
//
// The lifecycle this module drives (each step persists its own durable identity in the
// record, the crash-safe resume keys):
//   1. QUOTE — the venue's own numbers verbatim (sellAmount/buyAmount/feeAmount/validTo);
//   2. wrong-chain gate — `ensureChain` before any spend-shaped request;
//   3. fee probe + GAS GATE — the chain legs' own arithmetic (approve, plus the unwrap
//      when the destination is native): the aggregate worst-case fee must fit the wallet's
//      native balance BEFORE anything is signed, or the sequence refuses (EvmGasGateError);
//   4. APPROVE — exact amount to the VaultRelayer, signed/broadcast/receipt-waited
//      (the D31 sequential discipline: one nonce, wait for the receipt);
//   5. SIGN + SUBMIT — the EIP-712 order signed OFFLINE (gasless for the trader: the
//      solver pays gas and the venue's cost rides the quote), POSTed through the relay;
//      the venue answers the order UID, the record freezes it;
//   6. POLL — GET /api/v1/orders/{uid} until the venue's own terminal status: fulfilled
//      (→ the unwrap leg when the destination is native, then the realized-credit read)
//      or expired/cancelled (→ the honest terminal with the venue's real cause — the
//      order was OFF-CHAIN, so nothing left the wallet but the approve allowance).
//
// The PURE surface lives in `./cowPlan` and is re-exported here. LIVE ORDER TRIP: UNPROVEN
// (the venue's D31 follow-up — the V3 adapter earned the same note before its 2026-10-03 trip).
import {signEip1559Tx, toHex0x} from './tx';
import {deriveEvmKeypair} from './identity';
import {EvmGasGateError} from './errors';
import {
  ethEstimateGas,
  ethGasPrice,
  ethGetBalance,
  ethGetTransactionCount,
  ethGetTransactionReceipt,
  ethMaxPriorityFeePerGas,
  ethSendRawTransaction,
  rpcSleep,
  type EvmReceipt,
} from './rpc';
import {evmRpcUrls} from './endpoints';
import {ensureChain} from './service';
import {relayFetch} from '../services/relay';
import {
  buildOrderPostBody,
  buildQuoteBody,
  COW_VAULT_RELAYER,
  cowOrderUid,
  cowSettlementOf,
  DPAY_COW_APP_DATA_JSON,
  dpayCowAppDataHash,
  isCowOrderTerminal,
  parseCowOrderStatus,
  parseCowQuote,
  parseCowQuoteError,
  signCowOrder,
  type CowOrderParams,
  type CowOrderStatusBody,
} from './cowPlan';
import {encodeApproveHex, encodeWethWithdraw} from './uniswapPlan';

export * from './cowPlan';
export type {CowOrderParams, CowOrderStatusBody};

// ── the quote (network — the venue's own number, verbatim) ──────────────────────────────────

/** The order's validity window, counted from the QUOTE ask (the venue echoes it; the
 *  orderbook bounds it — 400 `ExcessiveValidTo` past its own ceiling). Ten minutes past
 *  the ask covers the review gesture + a resume, and stays far under the ceiling. */
export const COW_QUOTE_VALID_SECS = 600;

/** The venue's own quote for one EVM pair. `tokenOut === ''` is the native destination —
 *  the order buys the chain's WETH (the wrap target the post-fulfillment unwrap converts
 *  1:1), the CoW twin of the V3 adapter's WETH answer rule. */
export interface CowQuoteArgs {
  readonly relayUrl: string;
  readonly chainId: number;
  readonly tokenIn: string; // lowercase address
  readonly tokenOut: string; // lowercase address, or '' = native out (the WETH rule)
  readonly amountIn: bigint; // the total the venue may pull (raw sell units)
}

/** The quoted facts the sheet renders and the record freezes (the venue's own figures,
 *  never recomputed). */
export interface CowQuote {
  readonly amountIn: string;
  /** The venue's own buy-side figure (raw buy units) — the receive hero, before slippage. */
  readonly buyAmount: string;
  /** The venue's own fee estimate (raw sell units) — displayed verbatim, never hidden.
   *  The modern orderbook rejects a nonzero SIGNED fee, so this is the honest cost figure
   *  the review carries, not a field the order signs. */
  readonly feeAmount: string;
  /** The venue's own volume-fee policy in bps when the response names one. */
  readonly protocolFeeBps: string | null;
  /** The venue's own gas estimate for executing the trade (attribution, not a promise). */
  readonly gasAmount: string;
  /** The venue-bounded order expiry (absolute unix seconds) — the signed order and the
   *  UID derivation both take it from here. */
  readonly validTo: number;
  readonly fetchedAtMs: number;
}

export async function quoteCow(args: CowQuoteArgs & {readonly secretHex: string}, signal?: AbortSignal): Promise<CowQuote> {
  const settlement = cowSettlementOf(args.chainId);
  if (settlement == null) throw new Error(`cow: no venue on chain ${args.chainId}`);
  const urls = evmRpcUrls(args.chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  await ensureChain(args.chainId, urls, signal);
  const {evmAmmChainById} = await import('../config/evmAmm');
  const weth = evmAmmChainById(args.chainId)?.weth ?? '';
  if (args.tokenOut === '' && weth === '') throw new Error(`cow: no wrap target on chain ${args.chainId}`);
  const from = deriveEvmKeypair(args.secretHex).address;
  const body = buildQuoteBody({
    sellToken: args.tokenIn,
    buyToken: args.tokenOut === '' ? weth : args.tokenOut,
    sellAmountBeforeFee: args.amountIn.toString(),
    from,
    validTo: Math.floor(Date.now() / 1000) + COW_QUOTE_VALID_SECS,
  });
  let r: Response;
  try {
    r = await relayFetch(args.relayUrl, '/api/v1/cow/mainnet/quote', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    }, 15_000);
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error('cow quote: unreachable');
  }
  if (r.status === 400) {
    const errBody = await r.json().catch(() => null);
    const venue = parseCowQuoteError(errBody);
    throw new Error(venue != null
      ? `cow quote: ${venue.errorType}`
      : 'cow quote: refused');
  }
  if (!r.ok) throw new Error(`cow quote: unavailable (${r.status})`);
  const parsed = parseCowQuote(await r.json().catch(() => null));
  return {
    amountIn: args.amountIn.toString(),
    buyAmount: parsed.buyAmount,
    feeAmount: parsed.feeAmount,
    protocolFeeBps: parsed.protocolFeeBps,
    gasAmount: parsed.gasAmount,
    validTo: parsed.validTo,
    fetchedAtMs: Date.now(),
  };
}

// ── the chain legs (approve, and the unwrap when the destination is native) ────────────────

export const COW_RECEIPT_TIMEOUT_MS = 90_000;
/** The approve + unwrap legs' gas floors (the D31 figures' own kinds). */
const APPROVE_GAS_FLOOR = 80_000n;
const UNWRAP_GAS_FLOOR = 80_000n;

export interface CowChainLegsInput {
  readonly chainId: number;
  readonly tokenIn: string;
  /** The chain's wrap target (the WETH the native-out unwrap withdraws). */
  readonly weth: string;
  /** The exact pull the approve covers: sellAmount + feeAmount (feeAmount '0' today —
   *  the whole pull, once, exact — the per-op exact-amount approval red line). */
  readonly pullAmount: bigint;
  /** The unwrap leg exists iff the destination is native ('' marker upstream). */
  readonly nativeOut: boolean;
  /** The unwrap's amount floor (the order's buyAmount floor); the actual withdrawn amount
   *  is whatever the settlement delivered — the leg withdraws the wallet's WETH balance
   *  delta, floored here for the estimate. */
  readonly unwrapAmount: bigint;
  readonly recipient: string;
}

function receiptStatus(r: EvmReceipt | null): 'included' | 'pending' | 'failed' {
  if (r === null) return 'pending';
  if (r.status === '0x1') return 'included';
  if (r.status === '0x0') return 'failed';
  return 'pending';
}

/** The chain legs' aggregate worst-case fee, before anything is signed (the review's fee
 *  line + prepare's dry gate; the executor re-probes at drive time — prices move). Same
 *  arithmetic the V3 probe runs, over THIS venue's two legs. */
export async function estimateCowSequenceFee(
  secretHex: string,
  args: CowChainLegsInput,
  signal?: AbortSignal,
): Promise<{maxFeeWei: string}> {
  const legs = cowLegCalldata(args);
  const urls = evmRpcUrls(args.chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  await ensureChain(args.chainId, urls, signal);
  const from = deriveEvmKeypair(secretHex).address;
  const headBaseFee = BigInt(await ethGasPrice(urls, {signal}));
  const priorityHex = await ethMaxPriorityFeePerGas(urls, {signal}).catch((e: unknown) => {
    if (signal?.aborted) throw e;
    return null;
  });
  const priority = priorityHex === null ? 0n : BigInt(priorityHex);
  const maxFeePerGas = headBaseFee * 2n + priority;
  let total = 0n;
  for (const leg of legs) {
    let units: bigint;
    try {
      const est = await ethEstimateGas(urls, {from, to: leg.to, data: leg.data, value: '0x0'}, {signal});
      units = BigInt(Number(BigInt(est)));
    } catch (e) {
      if (signal?.aborted) throw e;
      units = leg.floor; // an estimate refusal falls back to the floor — the chain enforces reality
    }
    const withHeadroom = units + (units * 20n) / 100n + 1n;
    total += (withHeadroom > leg.floor ? withHeadroom : leg.floor) * maxFeePerGas;
  }
  return {maxFeeWei: total.toString(10)};
}

/** The legs' calldata, in signing order: approve(VaultRelayer, pull) then, for a native
 *  destination, WETH.withdraw (the post-fulfillment unwrap). */
function cowLegCalldata(args: CowChainLegsInput): Array<{to: string; data: string; floor: bigint}> {
  const legs = [{to: args.tokenIn, data: encodeApproveHex(COW_VAULT_RELAYER, args.pullAmount), floor: APPROVE_GAS_FLOOR}];
  if (args.nativeOut) {
    if (args.weth === '') throw new Error(`cow: no wrap target on chain ${args.chainId}`);
    legs.push({to: args.weth, data: encodeWethWithdraw(args.unwrapAmount), floor: UNWRAP_GAS_FLOOR});
  }
  return legs;
}

/** Sign + broadcast + receipt-wait ONE chain leg (the D31 discipline: one fresh nonce read
 *  per leg, the receipt watched before the next move). Returns the local tx hash. */
async function signAndSendLeg(
  secretHex: string,
  chainId: number,
  leg: {to: string; data: string},
  signal?: AbortSignal,
): Promise<string> {
  const urls = evmRpcUrls(chainId);
  const keypair = deriveEvmKeypair(secretHex);
  const nonce = Number(BigInt(await ethGetTransactionCount(urls, keypair.address, {signal})));
  const headBaseFee = BigInt(await ethGasPrice(urls, {signal}));
  const priorityHex = await ethMaxPriorityFeePerGas(urls, {signal}).catch((e: unknown) => {
    if (signal?.aborted) throw e;
    return null;
  });
  const priority = priorityHex === null ? 0n : BigInt(priorityHex);
  const maxFeePerGas = headBaseFee * 2n + priority;
  let units: bigint;
  try {
    const est = await ethEstimateGas(urls, {from: keypair.address, to: leg.to, data: leg.data, value: '0x0'}, {signal});
    units = BigInt(Number(BigInt(est)));
  } catch (e) {
    if (signal?.aborted) throw e;
    units = APPROVE_GAS_FLOOR;
  }
  const withHeadroom = units + (units * 20n) / 100n + 1n;
  const gasLimit = withHeadroom > APPROVE_GAS_FLOOR ? withHeadroom : APPROVE_GAS_FLOOR;
  const signed = signEip1559Tx({
    chainId,
    nonce,
    maxPriorityFeePerGas: priority,
    maxFeePerGas,
    gasLimit,
    to: leg.to,
    value: 0n,
    data: Uint8Array.from(Buffer.from(leg.data.replace(/^0x/, ''), 'hex')),
  }, keypair.privateKey);
  const localHash = toHex0x(signed.txHash);
  await ethSendRawTransaction(urls, toHex0x(signed.raw), {signal});
  const receipt = await pollReceipt(urls, localHash, signal);
  if (receiptStatus(receipt) === 'failed') {
    throw new Error(`cow: ${leg.to} leg ${localHash} reverted on-chain — nothing retried`);
  }
  return localHash;
}

async function pollReceipt(urls: readonly string[], txHash: string, signal?: AbortSignal): Promise<EvmReceipt> {
  const deadline = Date.now() + COW_RECEIPT_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) throw new Error('aborted');
    let r: EvmReceipt | null = null;
    try {
      r = await ethGetTransactionReceipt(urls, txHash, {signal});
    } catch (e) {
      if (signal?.aborted) throw e;
      r = null; // a transient read failure is not a verdict; keep polling
    }
    if (r !== null && receiptStatus(r) !== 'pending') return r;
    if (Date.now() >= deadline) {
      throw new Error(`cow: no receipt for ${txHash} within the window — the tx may still land; do not re-broadcast`);
    }
    await rpcSleep(1500, signal);
  }
}

/** The GAS GATE + approve leg: refuse before ANY signature when the native balance cannot
 *  cover both chain legs' worst case; otherwise sign/broadcast/wait the exact-amount
 *  approve to the VaultRelayer. Returns the approve tx hash (the record's durable key). */
export async function approveForCow(
  secretHex: string,
  args: CowChainLegsInput,
  signal?: AbortSignal,
): Promise<string> {
  const urls = evmRpcUrls(args.chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  await ensureChain(args.chainId, urls, signal);
  const from = deriveEvmKeypair(secretHex).address;
  const {maxFeeWei} = await estimateCowSequenceFee(secretHex, args, signal);
  const gasWei = BigInt(await ethGetBalance(urls, from, {signal}));
  if (gasWei < BigInt(maxFeeWei)) {
    const {EVM_CHAINS} = await import('./chains') as typeof import('./chains');
    throw new EvmGasGateError({
      requiredWei: maxFeeWei,
      gasBalanceWei: gasWei.toString(10),
      chainId: args.chainId,
      chainName: EVM_CHAINS[args.chainId as keyof typeof EVM_CHAINS]?.name ?? `chain ${args.chainId}`,
      nativeSymbol: 'ETH',
      address: from,
    });
  }
  const legs = cowLegCalldata(args);
  return signAndSendLeg(secretHex, args.chainId, legs[0]!, signal);
}

/** The post-fulfillment unwrap: withdraw the settlement's WETH credit to native at the
 *  owner (the token→native tail; gas was gated with the approve). Returns the tx hash. */
export async function unwrapCowWeth(
  secretHex: string,
  args: {chainId: number; amount: bigint},
  signal?: AbortSignal,
): Promise<string> {
  const {evmAmmChainById} = await import('../config/evmAmm');
  const weth = evmAmmChainById(args.chainId)?.weth;
  if (weth == null) throw new Error(`cow: no wrap target on chain ${args.chainId}`);
  const urls = evmRpcUrls(args.chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  await ensureChain(args.chainId, urls, signal);
  return signAndSendLeg(secretHex, args.chainId, {to: weth, data: encodeWethWithdraw(args.amount)}, signal);
}

// ── the order submission + poll (the gasless half) ─────────────────────────────────────────

/** Sign the FROZEN order facts and POST them through the relay. The signature is
 *  deterministic (RFC 6979): a resume re-derives byte-identical bytes, so the derived UID
 *  is stable and the venue dedups by it. Returns the venue's UID (56 bytes). */
export async function submitCowOrder(args: {
  relayUrl: string;
  chainId: number;
  secretHex: string;
  order: CowOrderParams;
  signal?: AbortSignal;
}): Promise<string> {
  const keypair = deriveEvmKeypair(args.secretHex);
  const sig = signCowOrder(keypair.privateKey, args.chainId, args.order);
  const body = buildOrderPostBody({
    order: args.order,
    signatureHex: toHex0x(sig.serialized),
    from: keypair.address,
  });
  let r: Response;
  try {
    r = await relayFetch(args.relayUrl, '/api/v1/cow/mainnet/orders', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    }, 15_000);
  } catch (e) {
    if (args.signal?.aborted) throw e;
    throw new Error('cow order: unreachable');
  }
  if (r.status === 400) {
    const errBody = await r.json().catch(() => null);
    const venue = parseCowQuoteError(errBody);
    throw new Error(venue != null ? `cow order: ${venue.errorType}` : 'cow order: refused');
  }
  if (r.status === 403) throw new Error('cow order: forbidden');
  if (!r.ok) throw new Error(`cow order: unavailable (${r.status})`);
  const uid = await r.json().catch(() => null);
  if (typeof uid !== 'string' || !/^0x[0-9a-fA-F]{112}$/.test(uid)) {
    throw new Error('cow order: shape');
  }
  // The venue's UID must agree with the derivation the record can re-run (the crash-safe
  // resume contract): a mismatch is a hostile/broken pipe, never persisted.
  const derived = cowOrderUid(args.chainId, args.order, keypair.address);
  if (uid.toLowerCase() !== derived.toLowerCase()) {
    throw new Error('cow order: uid mismatch');
  }
  return uid;
}

/** One status read (GET through the relay). Throws 'unreachable' on transport death — the
 *  driver keeps polling; a venue answer is the verdict. */
export async function fetchCowOrderStatus(args: {
  relayUrl: string;
  uid: string;
  signal?: AbortSignal;
}): Promise<CowOrderStatusBody> {
  let r: Response;
  try {
    r = await relayFetch(args.relayUrl, `/api/v1/cow/mainnet/orders/${encodeURIComponent(args.uid)}`, undefined, 15_000);
  } catch (e) {
    if (args.signal?.aborted) throw e;
    throw new Error('cow status: unreachable');
  }
  if (!r.ok) throw new Error(`cow status: unavailable (${r.status})`);
  return parseCowOrderStatus(await r.json().catch(() => null));
}

/** The FULL swap: approve → sign+submit → poll (per-drive budget), each milestone handed
 *  back through `onProgress` so the record persists its durable identity the moment it
 *  exists. Terminal outcomes return; a still-open order returns `null` (keep watching).
 *  This is the executor's inner sequence — the record driver (convert/executeCow.ts)
 *  owns the states. */
export interface CowDriveInput {
  readonly chainId: number;
  readonly tokenIn: string;
  /** The chain's wrap target (the native-out unwrap withdraws it). */
  readonly weth: string;
  readonly nativeOut: boolean;
  readonly order: CowOrderParams; // the FROZEN facts — re-signed deterministically
  readonly uid: string | null; // frozen at submit; null = not submitted yet
  readonly approveTxHash: string | null; // frozen once the approve landed
  readonly relayUrl: string;
  /** Per-drive poll budget (ms) — the drive returns to the engine's re-arm, never spins. */
  readonly pollBudgetMs?: number;
}

export type CowDriveProgress =
  | {kind: 'approved'; txHash: string}
  | {kind: 'submitted'; uid: string}
  | {kind: 'fulfilled'; status: CowOrderStatusBody}
  | {kind: 'unwrapped'; txHash: string}
  | {kind: 'terminal'; status: CowOrderStatusBody};

export async function driveCowSequence(
  secretHex: string,
  input: CowDriveInput,
  signal: AbortSignal | undefined,
  onProgress: (p: CowDriveProgress) => void | Promise<void>,
): Promise<CowDriveProgress | null> {
  const settlement = cowSettlementOf(input.chainId);
  if (settlement == null) throw new Error(`cow: no venue on chain ${input.chainId}`);
  const pullAmount = BigInt(input.order.sellAmount) + BigInt(input.order.feeAmount);
  let uid = input.uid;
  if (input.approveTxHash == null) {
    const txHash = await approveForCow(secretHex, {
      chainId: input.chainId,
      tokenIn: input.tokenIn,
      weth: input.weth,
      pullAmount,
      nativeOut: input.nativeOut,
      unwrapAmount: BigInt(input.order.buyAmount),
      recipient: deriveEvmKeypair(secretHex).address,
    }, signal);
    await onProgress({kind: 'approved', txHash});
  }
  if (uid == null) {
    uid = await submitCowOrder({
      relayUrl: input.relayUrl,
      chainId: input.chainId,
      secretHex,
      order: input.order,
      signal,
    });
    await onProgress({kind: 'submitted', uid});
  }
  // The per-drive poll budget: the venue settles in seconds-to-minutes; the drive returns
  // to the engine's re-arm cadence rather than spinning (liveness = the sweep, not the loop).
  const budget = input.pollBudgetMs ?? 8_000;
  const deadline = Date.now() + budget;
  for (;;) {
    if (signal?.aborted) throw new Error('aborted');
    let status: CowOrderStatusBody;
    try {
      status = await fetchCowOrderStatus({relayUrl: input.relayUrl, uid, signal});
    } catch (e) {
      if (signal?.aborted) throw e;
      status = null as unknown as CowOrderStatusBody; // transport death is not a verdict
    }
    if (status != null) {
      if (status.status === 'fulfilled') {
        await onProgress({kind: 'fulfilled', status});
        return {kind: 'fulfilled', status};
      }
      if (isCowOrderTerminal(status.status)) {
        await onProgress({kind: 'terminal', status});
        return {kind: 'terminal', status};
      }
    }
    if (Date.now() >= deadline) return null; // still open — the engine re-arms
    await rpcSleep(1500, signal);
  }
}

export {COW_VAULT_RELAYER, DPAY_COW_APP_DATA_JSON, dpayCowAppDataHash};
