// node-anvil tier — the Uniswap V3 QUOTE path on the real chain pipe (the any-pair
// mandate's adapter pin). The scratch chain carries TWO mock stand-ins, installed with
// `anvil_setCode` at addresses the dev-chain override names (config/evmAmm.ts's sanctioned
// dev seam, the setEvmDevToken precedent):
//   • the ECHO quoter — runtime code that RETURNS ITS OWN CALLDATA. Whatever the adapter
//     sends comes back verbatim, so the assertion reads the exact calldata bytes the pipe
//     carried (a golden-vector check against the chain, not against a fixture).
//   • the FIXED quoter — runtime code that returns a canned 96-byte QuoterV2 answer
//     (amount, sqrtPriceX96After, gasEstimate). The full app path (tier walk → decode →
//     UniswapQuote) runs against REAL chain state through the relay pipe.
// All dials ride the app's own seam (the pipe); anvil-direct is the second source.
import {expect, test, beforeAll, afterAll} from '@jest/globals';
import {quoteUniswapSwap} from '../../evm';
import {EVM_AMM_CHAINS, setEvmAmmChainOverride} from '../../config/evmAmm';
import {encodeQuoteExactInputSingle} from '../../evm/uniswapPlan';
import {devSeed, nodeAnvilEnv, wireSeamToPipe, type NodeAnvilEnv} from './anvilEnv';
import {evmKeypairFromPrivate} from '../../evm/identity';
import {hexToBytes} from '../../lib/format';

let env: NodeAnvilEnv;

const QUOTER_ECHO = evmKeypairFromPrivate(hexToBytes(devSeed('uniswap-echo'))).address;
const QUOTER_FIXED = evmKeypairFromPrivate(hexToBytes(devSeed('uniswap-fixed'))).address;
const TOKEN_IN = '0x' + '11'.repeat(20);

/** Runtime: CALLDATACOPY(0,0,size); RETURN(0,size) — the calldata echo. */
const ECHO_RUNTIME = '36' + '5f' + '6000' + '37' + '36' + '5f' + 'f3';

/** Runtime: MSTORE a canned QuoterV2 answer (FOUR uint256 words — the real contract's
 *  shape: amount, sqrtPriceX96After, initializedTicksCrossed, gasEstimate), RETURN(0,0x80). */
const AMOUNT = (123n * 10n ** 15n).toString(16).padStart(64, '0');
const GAS_EST = (79821n).toString(16).padStart(64, '0');
const FIXED_RUNTIME =
  '7f' + AMOUNT + '5f52'
  + '7f' + '0'.repeat(64) + '602052'
  + '7f' + '0'.repeat(64) + '604052'
  + '7f' + GAS_EST + '606052'
  + '6080' + '5f' + 'f3';

async function setCode(rpc: string, address: string, runtime: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(rpc, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'anvil_setCode', params: [address, '0x' + runtime]}),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const j = (await res.json()) as {error?: unknown};
  if (j.error != null) throw new Error(`anvil_setCode failed: ${JSON.stringify(j.error)}`);
}

const DEV_CHAIN = {
  ...EVM_AMM_CHAINS[1]!,
  id: 31337,
  name: 'dpay-anvil',
  router: '0x' + '44'.repeat(20),
  weth: '0x' + '55'.repeat(20),
  quoter: QUOTER_FIXED,
};

beforeAll(async () => {
  env = nodeAnvilEnv();
  await wireSeamToPipe(env);
  await setCode(env.rpc, QUOTER_ECHO, ECHO_RUNTIME);
  await setCode(env.rpc, QUOTER_FIXED, FIXED_RUNTIME);
  setEvmAmmChainOverride(DEV_CHAIN);
});

afterAll(() => {
  setEvmAmmChainOverride(null);
});

test('the echo quoter returns the calldata the adapter sent — the golden vector off the pipe', async () => {
  // The adapter's own encoder output, eth_call'd through the relay pipe at the echo
  // contract: the RETURN IS the calldata, byte-for-byte.
  const data = encodeQuoteExactInputSingle({tokenIn: TOKEN_IN, tokenOut: DEV_CHAIN.weth, amountIn: 10n ** 17n, fee: 3000});
  const {ethCall} = await import('../../evm/rpc');
  const echoed = await ethCall([`${env.pipe}`], QUOTER_ECHO, data);
  expect(echoed.toLowerCase()).toBe(data.toLowerCase());
});

test('the full app quote path runs on-chain through the pipe (tier walk → decode)', async () => {
  const q = await quoteUniswapSwap({
    kind: 'exact-input',
    chainId: 31337,
    tokenIn: TOKEN_IN,
    tokenOut: DEV_CHAIN.weth,
    amountIn: 10n ** 17n,
  });
  // The fixed quoter answers every tier identically; the walk takes the FIRST positive
  // answer (tier 100) and the decode is the canned fixture.
  expect(q.feeTier).toBe(100);
  expect(q.amountOut).toBe((123n * 10n ** 15n).toString());
  expect(q.gasEstimate).toBe('79821');
  expect(q.hub).toBeUndefined();
});
