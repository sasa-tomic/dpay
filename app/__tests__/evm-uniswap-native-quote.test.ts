// The convert sheet passes tokenOut '' for a NATIVE-ETH destination (its native marker).
// The quoter needs a REAL token: quoteUniswap must substitute the chain's WETH (the plan's
// wrap target - token to WETH 1:1 IS the native amount after the unwrap leg). The 2026-10-03
// D31 live trip hit the raw throw 'not an address: ' instead: the sheet's quote walk died at
// addrWord('') before any RPC, the quote errored, and the convert button never armed.
import {describe, expect, it, jest} from '@jest/globals';

const mockEthCall = jest.fn<(...a: unknown[]) => Promise<string>>();

jest.mock('../evm/endpoints', () => ({evmRpcUrls: () => ['http://pipe']}));
jest.mock('../evm/service', () => ({ensureChain: async () => undefined}));
jest.mock('../evm/rpc', () => ({
  ethCall: (...a: unknown[]) => mockEthCall(...(a as [])),
  ethGasPrice: jest.fn(),
  ethGetBalance: jest.fn(),
  ethGetTransactionCount: jest.fn(),
  ethGetTransactionReceipt: jest.fn(),
  ethMaxPriorityFeePerGas: jest.fn(),
  ethSendRawTransaction: jest.fn(),
  rpcSleep: jest.fn(),
}));

import {quoteUniswap} from '../evm/uniswap';
import {addrWord} from '../evm/uniswapPlan';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // Ethereum mainnet wrap target
const ZCHF = '0x79d4f0232A66c4c91b89c76362016A1707CFBF4f';
// decodeUniswapQuote reads amount from word 0 and gasEstimate from word 3 (256 hex chars).
const ANSWER = '0x' + BigInt(100).toString(16).padStart(64, '0') + '00'.repeat(64) + BigInt(70000).toString(16).padStart(64, '0');

describe('quoteUniswap: a native-ETH destination quotes the chain WETH', () => {
  it('substitutes WETH for the empty native marker instead of throwing', async () => {
    mockEthCall.mockResolvedValue(ANSWER);
    const q = await quoteUniswap({kind: 'exact-input', chainId: 1, tokenIn: ZCHF, tokenOut: '', amountIn: 1000n});
    expect(q.amountOut).toBe('100');
    // Every tier call must carry the WETH word in the tokenOut slot - never the empty marker.
    expect(mockEthCall.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockEthCall.mock.calls) {
      const data = String(call[2]);
      expect(data.toLowerCase()).toContain(addrWord(WETH).toLowerCase());
    }
  });
});
