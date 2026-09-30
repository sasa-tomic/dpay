// The UNISWAP V3 adapter — quote (QuoterV2) and swap (SwapRouter02) for the `evm_amm`
// venue rows (config/evmAmm.ts). NETWORK module — reached ONLY through the seam `app/evm.ts`
// (dynamic import, gated on a non-empty `evmRpcUrl(chainId)`), the same discipline as
// `evm/service.ts`, whose gate order this module keeps:
//
//   1. wrong-chain gate — `ensureChain` before any spend-shaped request;
//   2. fee probe — the chain's own arithmetic (estimateGas per leg + gasPrice + priority);
//   3. GAS HONESTY GATE — the payer's measured native balance must cover the WHOLE
//      sequence's worst-case fee (summed over the legs, before anything is signed), or the
//      sequence refuses with `EvmGasGateError` carrying the instructive numbers;
//   4. sign type-2 per leg, broadcast, WAIT FOR THE RECEIPT, then the next nonce — the
//      D31-hardenened seed's sequential discipline (scripts/evm-mainnet-zchf-buy.mjs):
//      every leg waits for its own receipt, so the local nonce counter stays exact, and a
//      reverted leg stops the sequence dead (no blind retry — the caller ledgers it).
//
// The bytes are D31-live-proven: `__tests__/evm-uniswap.test.ts` pins the encoder against
// the multicall SwapRouter02 executed on Ethereum mainnet and against live QuoterV2 answers.
// dpay never custodies: the device key signs, gas is the user's own, every number shown is
// the venue's own quote or the chain's own fee arithmetic.
import {encodeApprove} from './abi';
import {decodeUint256, functionSelector} from './abi';
import {signEip1559Tx, toHex0x, addressToBytes} from './tx';
import {deriveEvmKeypair} from './identity';
import {EvmGasGateError} from './errors';
import {
  ethCall,
  ethChainId,
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
import type {EvmAmmChain} from '../config/evmAmm';

// ── Encoders (PURE — jest-pinned against the mainnet capture) ──────────────────────────────────

function word32(v: bigint): string {
  if (v < 0n || v >= 1n << 256n) throw new Error(`value out of uint256 range: ${v}`);
  return v.toString(16).padStart(64, '0');
}

function addrWord(address: string): string {
  const a = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error(`not an address: ${address}`);
  return '00'.repeat(12) + a;
}

function hex(data: Uint8Array): string {
  return '0x' + Buffer.from(data).toString('hex');
}

function callHex(sig: string, ...words: string[]): string {
  return hex(functionSelector(sig)) + words.join('');
}

/** ERC-20 `approve` as 0x-hex — the adapter's own leg vocabulary. */
export function encodeApproveHex(spender: string, amount: bigint): string {
  return hex(encodeApprove(spender, amount));
}

/** QuoterV2 `quoteExactInputSingle((tokenIn,tokenOut,amountIn,fee,sqrtLimit))` — sqrtLimit
 *  is always 0 (no bounded-price quotes; the pool's own curve answers). */
export function encodeQuoteExactInputSingle(p: {tokenIn: string; tokenOut: string; amountIn: bigint; fee: number}): string {
  return callHex('quoteExactInputSingle((address,address,uint256,uint24,uint160))',
    addrWord(p.tokenIn), addrWord(p.tokenOut), word32(p.amountIn), word32(BigInt(p.fee)), word32(0n));
}

/** QuoterV2 `quoteExactOutputSingle((tokenIn,tokenOut,amountOut,fee,sqrtLimit))`. */
export function encodeQuoteExactOutputSingle(p: {tokenIn: string; tokenOut: string; amountOut: bigint; fee: number}): string {
  return callHex('quoteExactOutputSingle((address,address,uint256,uint24,uint160))',
    addrWord(p.tokenIn), addrWord(p.tokenOut), word32(p.amountOut), word32(BigInt(p.fee)), word32(0n));
}

/** The QuoterV2 answer: (uint256 amount, uint160 sqrtPriceX96After, uint32 ticks, uint256 gas). */
export interface UniswapQuoteRaw {
  /** amountIn (exact-output quotes) or amountOut (exact-input quotes), raw units. */
  readonly amount: bigint;
  readonly gasEstimate: bigint;
}

export function decodeUniswapQuote(response: string): UniswapQuoteRaw {
  const h = response.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(h) || h.length < 256) throw new Error(`uniswap quote: bad response width (${h.length} hex chars)`);
  return {amount: BigInt('0x' + h.slice(0, 64)), gasEstimate: BigInt('0x' + h.slice(192, 256))};
}

/** SwapRouter02 `exactOutputSingle((tokenIn,tokenOut,fee,recipient,amountOut,amountInMaximum,sqrtLimit))`
 *  — the seven-field ROUTER tuple (no deadline; expiry lives on multicall — the D31 lesson). */
export function encodeExactOutputSingle(p: {
  tokenIn: string; tokenOut: string; fee: number; recipient: string;
  amountOut: bigint; amountInMaximum: bigint;
}): string {
  return callHex('exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))',
    addrWord(p.tokenIn), addrWord(p.tokenOut), word32(BigInt(p.fee)), addrWord(p.recipient),
    word32(p.amountOut), word32(p.amountInMaximum), word32(0n));
}

/** SwapRouter02 `exactInputSingle((tokenIn,tokenOut,fee,recipient,amountIn,amountOutMinimum,sqrtLimit))`. */
export function encodeExactInputSingle(p: {
  tokenIn: string; tokenOut: string; fee: number; recipient: string;
  amountIn: bigint; amountOutMinimum: bigint;
}): string {
  return callHex('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
    addrWord(p.tokenIn), addrWord(p.tokenOut), word32(BigInt(p.fee)), addrWord(p.recipient),
    word32(p.amountIn), word32(p.amountOutMinimum), word32(0n));
}

/** SwapRouter02 `multicall(uint256 deadline, bytes[] subcalls)` — the D31-proven element
 *  encoding: each element carries its own offset (relative to the array-length word) + length
 *  + padded data. */
export function encodeMulticall(subcalls: readonly string[], deadlineSecs: bigint): string {
  const elems = subcalls.map((s) => {
    const h = s.replace(/^0x/, '');
    const padLen = Math.ceil(h.length / 64) * 64;
    return word32(BigInt(h.length / 2)) + h.padEnd(padLen, '0');
  });
  const offsets: string[] = [];
  let acc = elems.length * 32;
  for (const e of elems) {
    offsets.push(word32(BigInt(acc)));
    acc += e.length / 2;
  }
  return callHex('multicall(uint256,bytes[])',
    word32(deadlineSecs), word32(64n), word32(BigInt(elems.length)))
    + offsets.join('') + elems.join('');
}

/** SwapRouter02 `unwrapWETH9(uint256 amountOutMinimum, address recipient)` — sweeps the
 *  ROUTER's WETH balance to native at `recipient` (the token→native tail). */
export function encodeUnwrapWeth(minAmount: bigint, recipient: string): string {
  return callHex('unwrapWETH9(uint256,address)', word32(minAmount), addrWord(recipient));
}

/** SwapRouter02 `refundETH()` — returns the msg.value surplus to the caller (native-in tail). */
export function encodeRefundEth(): string {
  return callHex('refundETH()');
}

/** WETH9 `deposit()` — payable wrap (native-in head). */
export function encodeWethDeposit(): string {
  return '0xd0e30db0';
}

/** WETH9 `withdraw(uint256)` — unwrap (native-in sweep tail). */
export function encodeWethWithdraw(wei: bigint): string {
  return callHex('withdraw(uint256)', word32(wei));
}

// ── Plan builders (PURE — the sequences the executor signs) ────────────────────────────────────

/** One planned tx of a swap sequence. `value` rides the wrap leg only; `gasHint` is the
 *  floor the fee probe starts from (the D31 figures), never a signed value — the probe
 *  estimate wins. */
export interface UniswapPlanTx {
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly label: 'wrap' | 'approve' | 'swap' | 'sweep';
}

export interface UniswapSwapPlan {
  readonly chainId: number;
  readonly txs: readonly UniswapPlanTx[];
  /** The user's own destination of the proceeds (their EVM address at prepare time). */
  readonly recipient: string;
}

/** The recipient placeholder the plan builders encode and the executor overwrites with the
 *  signer's own address (40 'e's — a valid address word that no real user could be). */
const RECIPIENT_PLACEHOLDER = 'e'.repeat(40);
const RECIPIENT_WORD = '00'.repeat(12) + RECIPIENT_PLACEHOLDER;

/** token → native gas (the ZCHF→ETH row): approve the router, then one multicall trading
 *  into WETH (recipient = the ROUTER) and sweeping it back out as native to the user. */
export function planTokenToNative(args: {
  chain: EvmAmmChain;
  tokenIn: string;
  amountIn: bigint;
  minOut: bigint;
  feeTier: number;
  deadlineSecs: bigint;
}): UniswapSwapPlan {
  const {chain, tokenIn, amountIn, minOut, feeTier} = args;
  return {
    chainId: chain.id,
    recipient: '', // the executor fills it from the device key (the placeholder is overwritten)
    txs: [
      {to: tokenIn, value: 0n, data: encodeApproveHex(chain.router, amountIn), label: 'approve'},
      {
        to: chain.router,
        value: 0n,
        data: encodeMulticall([
          encodeExactInputSingle({
            tokenIn, tokenOut: chain.weth, fee: feeTier, recipient: chain.router,
            amountIn, amountOutMinimum: minOut,
          }),
          encodeUnwrapWeth(0n, '0x' + RECIPIENT_PLACEHOLDER),
        ], args.deadlineSecs),
        label: 'swap',
      },
    ],
  };
}

/** token → token, same chain: approve the router, one multicall paying the user directly. */
export function planTokenToToken(args: {
  chain: EvmAmmChain;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
  feeTier: number;
  deadlineSecs: bigint;
}): UniswapSwapPlan {
  const {chain, tokenIn, tokenOut, amountIn, minOut, feeTier} = args;
  return {
    chainId: chain.id,
    recipient: '',
    txs: [
      {to: tokenIn, value: 0n, data: encodeApproveHex(chain.router, amountIn), label: 'approve'},
      {
        to: chain.router,
        value: 0n,
        data: encodeMulticall([
          encodeExactInputSingle({
            tokenIn, tokenOut, fee: feeTier, recipient: '0x' + RECIPIENT_PLACEHOLDER,
            amountIn, amountOutMinimum: minOut,
          }),
        ], args.deadlineSecs),
        label: 'swap',
      },
    ],
  };
}

// ── The quote (network — the venue's own number, verbatim) ─────────────────────────────────────

/** The Uniswap V3 pool fee tiers, shallow-to-deep. Every tier is QUOTED and the best liquid
 *  answer wins: a fee tier is execution detail inside ONE venue, not a second venue — the
 *  no-ranking red line ranks venues, never the pool a venue runs. */
export const UNISWAP_FEE_TIERS = [100, 500, 3000, 10000] as const;

export interface UniswapQuote {
  readonly feeTier: number;
  /** exact-input: what the venue pays out for `amountIn`; exact-output: what it charges. */
  readonly amountIn: string;
  readonly amountOut: string;
  /** The winning tier's own gas estimate (QuoterV2's figure — attribution, never a promise). */
  readonly gasEstimate: string;
  readonly fetchedAtMs: number;
}

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
  /** Slippage-bounded worst case: the plan's own amounts, already floored. */
  readonly minOut: bigint;
  /** When the trade window dies (absolute unix secs, frozen at prepare). */
  readonly deadlineSecs: bigint;
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
  const headBaseFee = BigInt(await ethGasPrice(urls, {signal}));
  const priorityHex = await ethMaxPriorityFeePerGas(urls, {signal}).catch((e: unknown) => {
    if (signal?.aborted) throw e;
    return null;
  });
  const priority = priorityHex === null ? 0n : BigInt(priorityHex);
  const maxFeePerGas = headBaseFee * 2n + priority;

  // Per-leg gas: the node's estimate with the send path's 20% headroom, floored at the
  // leg kind's D31 figure (an estimate below the known floor of the router's own trade
  // would fail at inclusion, not at the gate — the floor is honesty, not optimism).
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

// Re-exports the seam + executor consumers need without re-deriving.
export {ethChainId, addressToBytes};
