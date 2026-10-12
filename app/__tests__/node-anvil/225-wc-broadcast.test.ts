// node-anvil tier — the WalletConnect send path (plan W1 step 3 + step 5), test 225: an approved
// `eth_sendTransaction` review is param-filled from the chain (nonce + gas + fees through the
// relay-proxy pipe, exactly the fields a dApp omits), signed with the DEVICE key, broadcast as
// exactly those signed bytes, and the answered hash LANDS ON CHAIN - the submitted-not-settled
// result made real. This is the WC twin of 220's sendErc20 proof: same pipe, same wrong-chain
// guard, same honest hash - reached through `approveWcRequest` (the sheet's approve button),
// never through dpay's own send path.
//
// NOT RUN on the dev loop (`just node-anvil` runs it; AGENTS.md: slow suites exactly once before
// commits move back). Written per the 219-224 convention: real anvil + real relay pipe, no
// browser, polls through the seam, exact numbers asserted on direct anvil reads.
import {expect, test, beforeAll} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {deriveEvmAddress, getEvmReceiptStatus} from '../../evm';
import {approveWcRequest} from '../../components/WcRequestSheet';
import type {WcRequest, WcResponse} from '../../walletkit';
import {
  ANVIL_ACCOUNT_1,
  ANVIL_CHAIN_ID,
  devSeed,
  ethBalanceRaw,
  fundEthDirect,
  nodeAnvilEnv,
  pollUntil,
  txCountRaw,
  wireSeamToPipe,
  type NodeAnvilEnv,
} from './anvilEnv';

const STAGED_ETH_WEI = 10_000_000_000_000_000n; // 0.01 ETH
const SEND_WEI = 1_234_500_000_000_000n; // 0.0012345 ETH

let env: NodeAnvilEnv;
let secretHex: string;
let device: string;
let answers: Array<{topic: string; response: WcResponse}>;

beforeAll(async () => {
  env = nodeAnvilEnv();
  await AsyncStorage.clear();
  await wireSeamToPipe(env);
  secretHex = devSeed('225 device');
  device = deriveEvmAddress(secretHex);
  answers = [];
});

/** The dApp's request, shape-faithful: from/to/value only - nonce, gas and fees are the
 *  param-fill's job (chainId also omitted: the session chain answers it). */
function wcSendRequest(id: number): WcRequest {
  return {
    topic: 'anvil-topic',
    id,
    params: {
      requester: {publicKey: 'pk', metadata: {name: 'anvil-dapp', description: 'd', url: 'https://anvil.invalid', icons: []}},
      chainId: 'eip155:31337',
      request: {method: 'eth_sendTransaction', params: [{from: device, to: ANVIL_ACCOUNT_1, value: `0x${SEND_WEI.toString(16)}`}]},
    },
  } as unknown as WcRequest;
}

test('225 · an approved WalletConnect eth_sendTransaction param-fills, signs, broadcasts, and lands on chain', async () => {
  await fundEthDirect(env.rpc, device, STAGED_ETH_WEI);

  const balanceBefore = await ethBalanceRaw(env.rpc, ANVIL_ACCOUNT_1);
  const txsBefore = await txCountRaw(env.rpc, device);

  // The sheet's approve path, end to end: summarize -> wrong-chain guard -> param-fill over the
  // relay pipe -> sign -> broadcast -> answer the dApp with OUR hash (submitted, not settled).
  const out = await approveWcRequest({
    request: wcSendRequest(1),
    secretHex,
    evmAddress: device,
    activeChain: 'eip155:31337',
    unsupportedChains: {code: 5100, message: 'Unsupported chains.'},
    respond: async (topic, response) => {
      answers.push({topic, response});
    },
  });

  // The dApp saw exactly one answer: the hash, 0x + 32 bytes.
  expect(out.submittedHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(answers).toHaveLength(1);
  expect(answers[0]!.response).toEqual({id: 1, jsonrpc: '2.0', result: out.submittedHash});

  // REAL chain state: the hash the dApp holds is the chain's tx - receipt included, the payer's
  // nonce advanced by exactly one, and the recipient's native balance up by the exact amount.
  const hash = out.submittedHash as string;
  await expect(getEvmReceiptStatus(ANVIL_CHAIN_ID, hash)).resolves.toBe('included');
  const [paidAfter, txsAfter] = await pollUntil(
    'wc broadcast inclusion',
    async () => [
      await ethBalanceRaw(env.rpc, ANVIL_ACCOUNT_1),
      await txCountRaw(env.rpc, device),
    ] as const,
    ([balance, count]) => balance >= balanceBefore + SEND_WEI && count === txsBefore + 1n,
  );
  expect(txsAfter).toBe(txsBefore + 1n);
  expect(paidAfter).toBe(balanceBefore + SEND_WEI);
});
