// The UNISWAP V3 adapter — network half: quote (QuoterV2) and the gated sequence executor
// (SwapRouter02) for the `evm_amm` venue rows (config/evmAmm.ts). NETWORK module — reached
// ONLY through the seam `app/evm.ts` (dynamic import, gated on a non-empty
// `evmRpcUrl(chainId)`), the same discipline as `evm/service.ts`, whose gate order this
// module keeps:
//
//   1. wrong-chain gate — `ensureChain` before any spend-shaped request;
//   2. fee probe — the chain's own arithmetic (estimateGas per leg + gasPrice + priority);
//   3. GAS HONESTY GATE — the payer's measured native balance must cover the WHOLE
//      sequence's worst-case fee (summed over the legs, before anything is signed), or the
//      sequence refuses with `EvmGasGateError` carrying the instructive numbers;
//   4. sign type-2 per leg, broadcast, WAIT FOR THE RECEIPT, then the next nonce — the
//      D31-hardened seed's sequential discipline (scripts/evm-mainnet-zchf-buy.mjs):
//      every leg waits for its own receipt, so the local nonce counter stays exact, and a
//      reverted leg stops the sequence dead (no blind retry — the caller ledgers it).
//
// The PURE surface (encoders/plan builders) lives in `./uniswapPlan` and is re-exported here.
import {decodeUint256, functionSelector} from './abi';
import {signEip1559Tx, toHex0x} from './tx';
import {deriveEvmKeypair} from './identity';
import {EvmGasGateError} from './errors';
import {
  ethCall,
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
import {addrWord, decodeUniswapQuote, encodeQuoteExactInputSingle, encodeQuoteExactOutputSingle, hex, RECIPIENT_WORD,
  UNISWAP_FEE_TIERS, type UniswapPlanTx, type UniswapQuote, type UniswapSwapPlan} from './uniswapPlan';

export {UNISWAP_FEE_TIERS};
export type {UniswapQuote};

export * from './uniswapPlan';

// ── The quote (network — the venue's own number, verbatim) ─────────────────────────────────────

/** The Uniswap V3 pool fee tiers, shallow-to-deep. Every tier is QUOTED and the best liquid
 *  answer wins: a fee tier is execution detail inside ONE venue, not a second venue — the
 *  no-ranking red line ranks venues, never the pool a venue runs. */
export type UniswapQuoteArgs =
  | {kind: 'exact-input'; chainId: number; tokenIn: string; tokenOut: string; amountIn: bigint}
  | {kind: 'exact-output'; chainId: number; tokenIn: string; tokenOut: string; amountOut: bigint};

/** Quote one pair across the fee tiers through the relay pipe; the best answer wins
 *  (exact-input: max out; exact-output: min in). Tiers the venue answers "no market" for
 *  (revert) are skipped — that is the venue's own per-pool coverage, not a failure. Every
 *  tier refusing is the honest no-liquidity verdict. */
export async function quoteUniswap(args: UniswapQuoteArgs, signal?: AbortSignal): Promise<UniswapQuote> {
  const urls = evmRpcUrls(args.chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  await ensureChain(args.chainId, urls, signal);
  const quoter = (await import('../config/evmAmm')).EVM_AMM_CHAINS[args.chainId]?.quoter;
  if (quoter == null) throw new Error(`uniswap: no venue on chain ${args.chainId}`);
  let best: {tier: number; amount: bigint} | null = null;
  for (const tier of UNISWAP_FEE_TIERS) {
    const data = args.kind === 'exact-input'
      ? encodeQuoteExactInputSingle({tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn, fee: tier})
      : encodeQuoteExactOutputSingle({tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountOut: args.amountOut, fee: tier});
    let raw: string;
    try {
      raw = await ethCall(urls, quoter, data, {signal});
    } catch (e) {
      if (signal?.aborted) throw e;
      continue; // this tier has no pool (the venue's own revert) — try the next
    }
    let amount: bigint;
    try {
      amount = decodeUniswapQuote(raw).amount;
    } catch {
      continue; // an unreadable answer is not a quote
    }
    if (amount <= 0n) continue;
    const better = best == null
      || (args.kind === 'exact-input' ? amount > best.amount : amount < best.amount);
    if (better) best = {tier, amount};
  }
  if (best == null && args.kind === 'exact-input') {
    // THE HUB FALLBACK (2026-09-28): no direct pool answers — compose A → WETH → B. The
    // chain's wrap target is the hub asset; each leg takes its own best tier and the FLOORS
    // compound (leg 2 is sized on leg 1's floor). Both legs are the venue's own quotes.
    const chain = (await import('../config/evmAmm')).EVM_AMM_CHAINS[args.chainId];
    if (chain == null || args.tokenIn === chain.weth || args.tokenOut === chain.weth) {
      throw new Error('uniswap: no liquidity at any fee tier for this pair');
    }
    const leg1 = await bestTierQuote(args.tokenIn, chain.weth, args.amountIn, urls, quoter, signal);
    if (leg1 == null) throw new Error('uniswap: no liquidity at any fee tier for this pair');
    const leg2 = await bestTierQuote(chain.weth, args.tokenOut, leg1.amount, urls, quoter, signal);
    if (leg2 == null) throw new Error('uniswap: no liquidity via the WETH hub either');
    return {
      feeTier: leg1.tier,
      amountIn: args.amountIn.toString(),
      amountOut: leg2.amount.toString(),
      gasEstimate: (leg1.gas + leg2.gas).toString(),
      fetchedAtMs: Date.now(),
      hub: {feeTierLeg1: leg1.tier, feeTierLeg2: leg2.tier, minOutLeg1: leg1.amount.toString()},
    };
  }
  if (best == null) throw new Error('uniswap: no liquidity at any fee tier for this pair');
  // Re-quote the WINNING tier for its gas estimate (one free read; the quote above carried
  // the same shape — decode it fully this round).
  const data = args.kind === 'exact-input'
    ? encodeQuoteExactInputSingle({tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn, fee: best.tier})
    : encodeQuoteExactOutputSingle({tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountOut: args.amountOut, fee: best.tier});
  const full = decodeUniswapQuote(await ethCall(urls, quoter, data, {signal}));
  return {
    feeTier: best.tier,
    amountIn: args.kind === 'exact-input' ? args.amountIn.toString() : full.amount.toString(),
    amountOut: args.kind === 'exact-input' ? full.amount.toString() : args.amountOut.toString(),
    gasEstimate: full.gasEstimate.toString(),
    fetchedAtMs: Date.now(),
  };
}

/** One leg's best-tier answer: (tier, amountOut, gasEstimate) or null when every tier is dry. */
async function bestTierQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  urls: readonly string[],
  quoter: string,
  signal?: AbortSignal,
): Promise<{tier: number; amount: bigint; gas: bigint} | null> {
  let best: {tier: number; amount: bigint; gas: bigint} | null = null;
  for (const tier of UNISWAP_FEE_TIERS) {
    let raw: string;
    try {
      raw = await ethCall(urls, quoter, encodeQuoteExactInputSingle({tokenIn, tokenOut, amountIn, fee: tier}), {signal});
    } catch (e) {
      if (signal?.aborted) throw e;
      continue;
    }
    let q;
    try {
      q = decodeUniswapQuote(raw);
    } catch {
      continue;
    }
    if (q.amount <= 0n) continue;
    if (best == null || q.amount > best.amount) best = {tier, amount: q.amount, gas: q.gasEstimate};
  }
  return best;
}

// ── The executor (network — the sequence the device signs) ─────────────────────────────────────

export const UNISWAP_RECEIPT_TIMEOUT_MS = 90_000;
const PER_LEG_GAS_FLOOR: Record<UniswapPlanTx['label'], bigint> = {
  wrap: 80_000n,
  approve: 80_000n,
  swap: 300_000n,
  sweep: 80_000n,
};

export interface UniswapExecInput {
  readonly chainId: number;
  /** The frozen plan (from the record widening) — the executor re-derives nothing. */
  readonly plan: UniswapSwapPlan;
}

export interface UniswapExecStep {
  readonly label: UniswapPlanTx['label'];
  readonly txHash: string;
}

function fillRecipient(data: string, recipient: string): string {
  const addr = addrWord(recipient);
  // Legs without a recipient slot (the approve) pass through unchanged.
  if (!data.includes(RECIPIENT_WORD)) return data;
  return data.replace(RECIPIENT_WORD, addr);
}

function receiptStatus(r: EvmReceipt | null): 'included' | 'pending' | 'failed' {
  if (r === null) return 'pending';
  if (r.status === '0x1') return 'included';
  if (r.status === '0x0') return 'failed';
  return 'pending';
}

/** Execute the planned sequence: gate → per-leg sign/broadcast/receipt → done. Throws
 *  `EvmGasGateError` before ANY signature when the native balance cannot cover the whole
 *  sequence's worst case. A reverted leg stops everything (the caller ledgers; no blind
 *  retry — the float rule). Returns the legs' hashes for the record. */
export async function executeUniswapSequence(
  secretHex: string,
  input: UniswapExecInput,
  signal?: AbortSignal,
  onBroadcast?: (step: {label: UniswapPlanTx['label']; txHash: string}) => void,
): Promise<{steps: UniswapExecStep[]}> {
  const urls = evmRpcUrls(input.chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${input.chainId})`);
  await ensureChain(input.chainId, urls, signal);

  const keypair = deriveEvmKeypair(secretHex);
  const from = keypair.address;
  const legs = input.plan.txs.map((tx) => ({
    ...tx,
    data: fillRecipient(tx.data, from),
  }));

  // 2. Fee probe — the chain's own arithmetic per leg (estimate + price + priority).
  const {priority, maxFeePerGas, legGases, totalWorstWei} = await probeSequenceFee(urls, from, legs, signal);

  // 3. THE GAS GATE — one aggregate check before ANY signature.
  const gasWei = BigInt(await ethGetBalance(urls, from, {signal}));
  if (gasWei < totalWorstWei) {
    throw new EvmGasGateError({
      requiredWei: totalWorstWei.toString(10),
      gasBalanceWei: gasWei.toString(10),
      chainId: input.chainId,
      chainName: `chain ${input.chainId}`,
      nativeSymbol: 'ETH',
      address: from,
    });
  }

  // 4. Sequential legs: one nonce read, local counter, every leg waits for its receipt.
  const nonce = Number(BigInt(await ethGetTransactionCount(urls, from, {signal})));
  const steps: UniswapExecStep[] = [];
  for (let i = 0; i < legs.length; i++) {
    if (signal?.aborted) throw new Error('aborted');
    const leg = legs[i]!;
    const signed = signEip1559Tx({
      chainId: input.chainId,
      nonce: nonce + i,
      maxPriorityFeePerGas: priority,
      maxFeePerGas,
      gasLimit: legGases[i]!,
      to: leg.to,
      value: leg.value,
      data: Uint8Array.from(Buffer.from(leg.data.replace(/^0x/, ''), 'hex')),
    }, keypair.privateKey);
    const localHash = toHex0x(signed.txHash);
    await ethSendRawTransaction(urls, toHex0x(signed.raw), {signal});
    onBroadcast?.({label: leg.label, txHash: localHash});
    const receipt = await pollReceipt(urls, localHash, signal);
    if (receiptStatus(receipt) === 'failed') {
      throw new Error(`uniswap swap: ${leg.label} leg ${localHash} reverted on-chain — nothing retried`);
    }
    steps.push({label: leg.label, txHash: localHash});
  }
  return {steps};
}

/** The fee probe one sequence runs before anything is signed: gasPrice + priority (once)
 *  and one estimateGas per leg with the send path's 20% headroom, floored at the leg kind's
 *  D31 figure. `totalWorstWei` is the AGGREGATE the gas gate checks. */
async function probeSequenceFee(
  urls: readonly string[],
  from: string,
  legs: ReadonlyArray<UniswapPlanTx & {data: string}>,
  signal?: AbortSignal,
): Promise<{priority: bigint; maxFeePerGas: bigint; legGases: bigint[]; totalWorstWei: bigint}> {
  const headBaseFee = BigInt(await ethGasPrice(urls, {signal}));
  const priorityHex = await ethMaxPriorityFeePerGas(urls, {signal}).catch((e: unknown) => {
    if (signal?.aborted) throw e;
    return null;
  });
  const priority = priorityHex === null ? 0n : BigInt(priorityHex);
  const maxFeePerGas = headBaseFee * 2n + priority;
  const legGases: bigint[] = [];
  for (const leg of legs) {
    let units: bigint;
    try {
      const est = await ethEstimateGas(urls, {from, to: leg.to, data: leg.data, value: '0x' + leg.value.toString(16)}, {signal});
      units = BigInt(Number(BigInt(est)));
    } catch (e) {
      if (signal?.aborted) throw e;
      // An estimate refusal (e.g. the token's own transfer hook) falls back to the floor —
      // the chain still enforces reality at inclusion.
      units = PER_LEG_GAS_FLOOR[leg.label];
    }
    legGases.push(units + (units * 20n) / 100n + 1n > PER_LEG_GAS_FLOOR[leg.label]
      ? units + (units * 20n) / 100n + 1n
      : PER_LEG_GAS_FLOOR[leg.label]);
  }
  const totalWorstWei = legGases.reduce((a, g) => a + g * maxFeePerGas, 0n);
  return {priority, maxFeePerGas, legGases, totalWorstWei};
}

/** The review's fee figure + prepare's dry gate: the aggregate worst case for a plan, before
 *  anything is signed. Same arithmetic the executor enforces at drive time. */
export async function estimateSequenceFee(
  secretHex: string,
  args: {chainId: number; plan: UniswapSwapPlan},
  signal?: AbortSignal,
): Promise<{maxFeeWei: string}> {
  const urls = evmRpcUrls(args.chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  await ensureChain(args.chainId, urls, signal);
  const from = deriveEvmKeypair(secretHex).address;
  const legs = args.plan.txs.map((tx) => ({...tx, data: fillRecipient(tx.data, from)}));
  const {totalWorstWei} = await probeSequenceFee(urls, from, legs, signal);
  return {maxFeeWei: totalWorstWei.toString(10)};
}

async function pollReceipt(urls: readonly string[], txHash: string, signal?: AbortSignal): Promise<EvmReceipt> {
  const deadline = Date.now() + UNISWAP_RECEIPT_TIMEOUT_MS;
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
      throw new Error(`uniswap swap: no receipt for ${txHash} within the window — the tx may still land; do not re-broadcast`);
    }
    await rpcSleep(1500, signal);
  }
}

// ── post-trade reads (the done line's realized figures) ────────────────────────────────────────

/** The user's raw token balance on `chainId` ('' URL → null, never a fake 0). */
export async function readEvmTokenRaw(chainId: number, token: string, owner: string, signal?: AbortSignal): Promise<string | null> {
  const urls = evmRpcUrls(chainId);
  if (urls[0] === '') return null;
  try {
    const sel = hex(functionSelector('balanceOf(address)'));
    const data = sel + addrWord(owner);
    return decodeUint256(await ethCall(urls, token, data, {signal})).toString(10);
  } catch {
    return null;
  }
}

/** The user's raw native (gas) balance in wei. */
export async function readEvmNativeRaw(chainId: number, owner: string, signal?: AbortSignal): Promise<string | null> {
  const urls = evmRpcUrls(chainId);
  if (urls[0] === '') return null;
  try {
    return BigInt(await ethGetBalance(urls, owner, {signal})).toString(10);
  } catch {
    return null;
  }
}
