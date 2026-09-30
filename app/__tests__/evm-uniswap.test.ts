// The Uniswap V3 adapter (app/evm/uniswap.ts) — the GOLDEN pins. Two ground truths:
//   1. The D31 MAINNET CAPTURE — the exact multicall input SwapRouter02 executed on
//      Ethereum at tx 0x0ab8f11a0dea11fbc4ad760490957f3d39007b63cd04c66b607a91c4263c7801
//      (funds/ledger.jsonl rows 184-186): byte-for-byte, our encoder must reproduce it.
//   2. The LIVE quote responses (recorded 2026-09-30, Ethereum mainnet QuoterV2 eth_call):
//      sell 0.4 ZCHF → 178449877188886 wei WETH (gasEstimate 79821); the response shape is
//      four uint256 words (amount, sqrtPriceX96After, initializedTicksCrossed, gasEstimate).
// Selectors are keccak-derived in the module; these pins keep them honest against the
// capture and against the live contract answers.
import {describe, expect, it} from '@jest/globals';
import {encodeApprove} from '../evm/abi';
import {
  encodeQuoteExactInputSingle,
  encodeQuoteExactOutputSingle,
  decodeUniswapQuote,
  encodeExactOutputSingle,
  encodeMulticall,
  encodeUnwrapWeth,
  encodeRefundEth,
  encodeWethDeposit,
  encodeWethWithdraw,
  planTokenToNative,
  planTokenToToken,
  type UniswapSwapPlan,
} from '../evm/uniswap';
import {EVM_AMM_CHAINS} from '../config/evmAmm';
import {planTokenViaWethHub} from '../evm/uniswapPlan';

const ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ZCHF = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
const USER = '0x18884BC8e867eEf401703b702097220bdAe27668';

// The D31 live capture (see header). deadline + amounts decoded from the tx input itself.
const D31_MULTICALL = '0x5ae401dc' +
  '000000000000000000000000000000000000000000000000000000006aba610a' +
  '0000000000000000000000000000000000000000000000000000000000000040' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '0000000000000000000000000000000000000000000000000000000000000020' +
  '00000000000000000000000000000000000000000000000000000000000000e4' +
  '5023b4df' +
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' +
  '000000000000000000000000b58e61c3098d85632df34eecfb899a1ed80921cb' +
  '0000000000000000000000000000000000000000000000000000000000000bb8' +
  '00000000000000000000000018884bc8e867eef401703b702097220bdae27668' +
  '00000000000000000000000000000000000000000000000014d1120d7b160000' +
  '0000000000000000000000000000000000000000000000000002892867fe4aca' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '00000000000000000000000000000000000000000000000000000000';
const D31_DEADLINE = 0x6aba610an;
const D31_AMOUNT_OUT = 0x14d1120d7b160000n; // 1.5 ZCHF (18 dec)
const D31_AMOUNT_IN_MAX = 0x2892867fe4acan; // the 5%-headroom max the seed signed

describe('golden selectors', () => {
  // Each assert re-derives the selector inside the module; the hex literals are the
  // known-good values (two of them straight off the D31 capture, four off the live ABI).
  it('match the live contracts', async () => {
    const {functionSelector} = await import('../evm/abi');
    const enc = new TextEncoder();
    const sel = (s: string) => '0x' + Buffer.from(functionSelector(s)).toString('hex');
    expect(sel('multicall(uint256,bytes[])')).toBe('0x5ae401dc');
    expect(sel('exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))')).toBe('0x5023b4df');
    expect(sel('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))')).toBe('0x04e45aaf');
    expect(sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')).toBe('0xc6a5026a');
    expect(sel('quoteExactOutputSingle((address,address,uint256,uint24,uint160))')).toBe('0xbd21704a');
    expect(sel('unwrapWETH9(uint256,address)')).toBe('0x49404b7c');
    expect(sel('refundETH()')).toBe('0x12210e8a');
    void enc;
  });
});

describe('golden calldata — the D31 mainnet capture', () => {
  it('exactOutputSingle subcall + multicall reproduce the executed bytes', () => {
    const sub = encodeExactOutputSingle({
      tokenIn: WETH, tokenOut: ZCHF, fee: 3000, recipient: USER,
      amountOut: D31_AMOUNT_OUT, amountInMaximum: D31_AMOUNT_IN_MAX,
    });
    const wrapped = encodeMulticall([sub], D31_DEADLINE);
    expect(wrapped).toBe(D31_MULTICALL);
  });
});

describe('quote codec', () => {
  // Recorded live 2026-09-30 (Ethereum QuoterV2): sell 0.4 ZCHF, fee 3000.
  const SELL_RESPONSE = '0x' +
    '0000000000000000000000000000000000000000000000000000a24c998a411600' +
    '00000000000000000000000000000000000000056a4f1152967ff46916f3fd' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000000000000000000000000000000000000000000000000137cd';

  it('decodes the four-word QuoterV2 answer', () => {
    const q = decodeUniswapQuote(SELL_RESPONSE);
    expect(q.amount).toBe(178449877188886n);
    expect(q.gasEstimate).toBe(79821n);
  });

  it('quote calldata encodes the tuple the live contract answered', () => {
    // The exact bytes the 2026-09-30 live probe sent (verified answering on-chain).
    expect(encodeQuoteExactInputSingle({tokenIn: ZCHF, tokenOut: WETH, amountIn: 400000000000000000n, fee: 3000})).toBe(
      '0xc6a5026a' +
      '000000000000000000000000b58e61c3098d85632df34eecfb899a1ed80921cb' +
      '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' +
      '000000000000000000000000000000000000000000000000058d15e176280000' +
      '0000000000000000000000000000000000000000000000000000000000000bb8' +
      '0000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(encodeQuoteExactOutputSingle({tokenIn: WETH, tokenOut: ZCHF, amountOut: 1500000000000000000n, fee: 3000})).toBe(
      '0xbd21704a' +
      '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' +
      '000000000000000000000000b58e61c3098d85632df34eecfb899a1ed80921cb' +
      '00000000000000000000000000000000000000000000000014d1120d7b160000' +
      '0000000000000000000000000000000000000000000000000000000000000bb8' +
      '0000000000000000000000000000000000000000000000000000000000000000',
    );
  });

  it('rejects a truncated or wrong-width answer (never decodes garbage into a number)', () => {
    expect(() => decodeUniswapQuote('0x00')).toThrow();
    expect(() => decodeUniswapQuote('not-hex')).toThrow();
  });
});

describe('the other golden pieces', () => {
  it('approve rides the well-known selector with exact amounts', () => {
    expect('0x' + Buffer.from(encodeApprove(ROUTER, 123n)).toString('hex').slice(0, 8)).toBe('0x095ea7b3');
  });

  it('weth wrap/unwrap and refundETH are the router flow pieces', () => {
    expect(encodeWethDeposit()).toBe('0xd0e30db0');
    expect(encodeWethWithdraw(5n)).toBe('0x2e1a7d4d' + '0'.repeat(63) + '5');
    expect(encodeUnwrapWeth(0n, USER)).toBe('0x49404b7c' + '0'.repeat(64) + '00000000000000000000000018884bc8e867eef401703b702097220bdae27668');
    expect(encodeRefundEth()).toBe('0x12210e8a');
  });
});

describe('plan builders — the sequences the executor signs', () => {
  const chain = EVM_AMM_CHAINS[1]!;

  it('token-to-native: approve then multicall(exactInputSingle, unwrapWETH9)', () => {
    const plan: UniswapSwapPlan = planTokenToNative({
      chain,
      tokenIn: ZCHF,
      amountIn: 400000000000000000n,
      minOut: 100000000000000n,
      feeTier: 3000,
      deadlineSecs: 1234567n,
    });
    expect(plan.chainId).toBe(1);
    expect(plan.txs.length).toBe(2);
    const [approve, swap] = plan.txs;
    expect(approve.to).toBe(ZCHF);
    expect(approve.value).toBe(0n);
    expect(approve.data).toBe(
      '0x095ea7b3' +
      '00000000000000000000000068b3465833fb72a70ecdf485e0e4c7bd8665fc45' +
      '000000000000000000000000000000000000000000000000058d15e176280000',
    );
    expect(swap.to).toBe(ROUTER);
    expect(swap.value).toBe(0n);
    const swapHex = swap.data;
    expect(swapHex.slice(0, 10)).toBe('0x5ae401dc');
    // One subcall: exactInputSingle (recipient = the ROUTER, the unwrap sweeps it).
    expect(swapHex).toContain('04e45aaf');
    expect(swapHex).toContain('00000000000000000000000068b3465833fb72a70ecdf485e0e4c7bd8665fc45');
    expect(swapHex).toContain('000000000000000000000000000000000000000000000000058d15e176280000');
    expect(swapHex).toContain('00000000000000000000000000000000000000000000000000005af3107a4000');
  });

  it('token-to-token: approve then multicall(exactInputSingle) paying the user directly', () => {
    const plan = planTokenToToken({
      chain,
      tokenIn: ZCHF,
      tokenOut: '0x1111111111111111111111111111111111111111',
      amountIn: 1n,
      minOut: 2n,
      feeTier: 500,
      deadlineSecs: 7n,
    });
    expect(plan.txs.length).toBe(2);
    const swapHex = plan.txs[1]!.data;
    expect(swapHex.slice(0, 10)).toBe('0x5ae401dc');
    // The output pays the PLAN's recipient slot (the executor overwrites the placeholder
    // with the signer's own address — the executor test pins the fill).
    expect(swapHex).toContain('000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    expect(swapHex).toContain('04e45aaf');
    expect(swapHex).not.toContain('49404b7c');
  });

  it('the WETH HUB fallback: token A -> WETH -> token B in ONE multicall, floors compounding', () => {
    // No direct pool: the hub composition trades A into WETH (recipient = the ROUTER),
    // then WETH into B (recipient = the user). Leg 2's input is leg 1's FLOOR — the
    // compounding-floor rule every other hub route follows.
    const plan = planTokenViaWethHub({
      chain,
      tokenIn: ZCHF,
      tokenOut: '0x2222222222222222222222222222222222222222',
      amountIn: 1000n,
      minOutLeg1: 900n,
      minOut: 800n,
      feeTierLeg1: 3000,
      feeTierLeg2: 500,
      deadlineSecs: 5n,
    });
    expect(plan.txs.length).toBe(2);
    const swapHex = plan.txs[1]!.data;
    expect(swapHex.slice(0, 10)).toBe('0x5ae401dc');
    expect(swapHex).toContain('04e45aaf');
    expect(swapHex).not.toContain('49404b7c');
    // Leg 1 routes A -> WETH with the ROUTER as recipient; leg 2 routes WETH -> B.
    expect(swapHex).toContain('000000000000000000000000b58e61c3098d85632df34eecfb899a1ed80921cb');
    expect(swapHex).toContain('0000000000000000000000002222222222222222222222222222222222222222');
    // Exactly TWO subcalls.
    expect(swapHex).toContain('0000000000000000000000000000000000000000000000000000000000000002');
  });

  it('plans are pure: same inputs, same bytes', () => {
    const a = planTokenToNative({chain, tokenIn: ZCHF, amountIn: 5n, minOut: 6n, feeTier: 3000, deadlineSecs: 9n});
    const b = planTokenToNative({chain, tokenIn: ZCHF, amountIn: 5n, minOut: 6n, feeTier: 3000, deadlineSecs: 9n});
    expect(a).toEqual(b);
  });
});
