// The UNISWAP V3 PURE surface — calldata encoders, quote codec, plan builders. No network,
// no react-native: safe to static-import from convert prepare code and the jest pins (the
// seam discipline — the network module `evm/uniswap.ts` is the only thing that dials).
//
// The bytes are D31-live-proven: `__tests__/evm-uniswap.test.ts` pins the encoder against
// the multicall SwapRouter02 executed on Ethereum mainnet (tx 0x0ab8f11a…c7801) and against
// live QuoterV2 answers (recorded 2026-09-30). dpay never custodies: the device key signs,
// gas is the user's own, every number shown is the venue's own quote or the chain's own fee
// arithmetic.
import type {EvmAmmChain} from '../config/evmAmm';
import {encodeApprove, functionSelector} from './abi';

// ── Encoders (PURE — jest-pinned against the mainnet capture) ──────────────────────────────────

export function word32(v: bigint): string {
  if (v < 0n || v >= 1n << 256n) throw new Error(`value out of uint256 range: ${v}`);
  return v.toString(16).padStart(64, '0');
}

export function addrWord(address: string): string {
  const a = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error(`not an address: ${address}`);
  return '00'.repeat(12) + a;
}

export function hex(data: Uint8Array): string {
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

/** The Uniswap V3 pool fee tiers, shallow-to-deep. Every tier is QUOTED and the best liquid
 *  answer wins: a fee tier is execution detail inside ONE venue, not a second venue. */
export const UNISWAP_FEE_TIERS = [100, 500, 3000, 10000] as const;

/** The venue's own quote, normalized: the winning tier + both sides in raw units. */
export interface UniswapQuote {
  readonly feeTier: number;
  /** exact-input: what the venue pays out for `amountIn`; exact-output: what it charges. */
  readonly amountIn: string;
  readonly amountOut: string;
  /** The winning tier's own gas estimate (QuoterV2's figure — attribution, never a promise). */
  readonly gasEstimate: string;
  readonly fetchedAtMs: number;
  /** Present when the quote is the WETH-hub composition (no direct pool answered): the two
   *  legs' tiers + leg 1's own floor, the hub facts the plan builder re-derives from. */
  readonly hub?: {feeTierLeg1: number; feeTierLeg2: number; minOutLeg1: string};
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
export const RECIPIENT_WORD = '00'.repeat(12) + RECIPIENT_PLACEHOLDER;

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


/** token → WETH → token (the HUB fallback, 2026-09-28): when no direct pool answers for a
 *  same-chain pair, the chain's wrap target is the hub asset — ONE multicall runs both legs,
 *  leg 1 pays the ROUTER, leg 2 pays the user, and leg 2's own floor rides on leg 1's floor
 *  (the compounding-floor rule every other hub route follows). Both legs are QUOTED before
 *  commit; the fee surface shows the two pool fees. */
export function planTokenViaWethHub(args: {
  chain: EvmAmmChain;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** Leg 1's floor in WETH raw units (the hub floor leg 2 is sized on). */
  minOutLeg1: bigint;
  /** The final floor in tokenOut raw units (the swap leg's amountOutMinimum). */
  minOut: bigint;
  feeTierLeg1: number;
  feeTierLeg2: number;
  deadlineSecs: bigint;
}): UniswapSwapPlan {
  const {chain, tokenIn, tokenOut, amountIn} = args;
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
            tokenIn, tokenOut: chain.weth, fee: args.feeTierLeg1, recipient: chain.router,
            amountIn, amountOutMinimum: args.minOutLeg1,
          }),
          encodeExactInputSingle({
            tokenIn: chain.weth, tokenOut, fee: args.feeTierLeg2, recipient: '0x' + RECIPIENT_PLACEHOLDER,
            amountIn: args.minOutLeg1, amountOutMinimum: args.minOut,
          }),
        ], args.deadlineSecs),
        label: 'swap',
      },
    ],
  };
}
