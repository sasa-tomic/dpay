// node-anvil tier, test 1 of 3 — e2e flow 219 (evm-send-history) at SERVICE level, no browser:
// fund the device through the MockZCHF ladder, then prove the app's balance poll and the
// eth_getLogs history walk detect BOTH Transfer legs against REAL anvil state, and that the
// app's own sendErc20 moves real ZCHF through the relay pipe.
//
// The app path is the seam (`../../evm` → readEvmBalances / sendErc20 / getEvmHistory /
// getEvmReceiptStatus); every chain fact is asserted TWICE: through the app read, and DIRECT
// against anvil (bypassing the relay — the second source).
import {expect, test, beforeAll} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deriveEvmAddress,
  getEvmHistory,
  getEvmReceiptStatus,
  readEvmBalances,
  sendErc20,
  type EvmKey,
} from '../../evm';
import {
  ANVIL_ACCOUNT_1,
  ANVIL_CHAIN_ID,
  ANVIL_DEPLOYER,
  devSeed,
  ethBalanceRaw,
  fundEthDirect,
  fundZchfDirect,
  nodeAnvilEnv,
  pollUntil,
  tokenBalanceRaw,
  transferLogsRaw,
  wireSeamToPipe,
  type NodeAnvilEnv,
} from './anvilEnv';

const ZCHF = (n: bigint): bigint => n * 10n ** 18n;
const STAGED_ZCHF = ZCHF(500n);
const SEND_AMOUNT = ZCHF(42n);
const STAGED_ETH_WEI = 1_000_000_000_000_000n; // 0.001 ETH of gas — comfortable over the quote

let env: NodeAnvilEnv;
let secretHex: string;
let device: string;
let keys: EvmKey[];

beforeAll(async () => {
  env = nodeAnvilEnv();
  await AsyncStorage.clear();
  await wireSeamToPipe(env);
  secretHex = devSeed('219 device');
  device = deriveEvmAddress(secretHex);
  keys = [{chainId: ANVIL_CHAIN_ID, token: 'ZCHF', tokenAddress: env.token, decimals: 18}];
});

test('219 · the funding ladder lands on the real chain and the app balance poll reads it', async () => {
  await fundEthDirect(env.rpc, device, STAGED_ETH_WEI);
  await fundZchfDirect(env.rpc, env.token, device, STAGED_ZCHF);

  // DIRECT anvil state (the second source): the funding is real chain state, not a mock.
  const [zchf, eth] = await pollUntil(
    'staged funding',
    async () => [await tokenBalanceRaw(env.rpc, env.token, device), await ethBalanceRaw(env.rpc, device)] as const,
    ([z, e]) => z === STAGED_ZCHF && e === STAGED_ETH_WEI,
  );
  expect(zchf.toString()).toBe(STAGED_ZCHF.toString());
  expect(eth.toString()).toBe(STAGED_ETH_WEI.toString());

  // The app's balance poll (through the relay pipe): gas leg + token leg, exact raw strings.
  // The pipe TTL-caches reads for 2s, so the app-side read is a POLL, never an assumption.
  const read = await pollUntil(
    'app poll sees the funding',
    async () => readEvmBalances(secretHex, keys),
    (r) => r.tokens[`${ANVIL_CHAIN_ID}:ZCHF`].kind === 'balance' && r.gas[ANVIL_CHAIN_ID]?.kind === 'balance',
  );
  expect(read.gas[ANVIL_CHAIN_ID]).toEqual({kind: 'balance', wei: STAGED_ETH_WEI.toString()});
  expect(read.tokens[`${ANVIL_CHAIN_ID}:ZCHF`]).toEqual({kind: 'balance', amount: STAGED_ZCHF.toString()});

  // The history walk sees the IN leg (deployer → device) from the eth_getLogs Transfer scan.
  const history = await getEvmHistory(ANVIL_CHAIN_ID, device, env.token);
  expect(history.kind).toBe('history');
  if (history.kind !== 'history') return;
  expect(history.dropped).toBe(0);
  expect(history.rows).toHaveLength(1);
  const inLeg = history.rows[0];
  expect(inLeg.dir).toBe('in');
  expect(inLeg.amount).toBe(STAGED_ZCHF.toString());
  expect(inLeg.counterparty).toBe(ANVIL_DEPLOYER.toLowerCase());
}, 60_000);

test('219 · sendErc20 through the pipe moves real ZCHF and history carries BOTH legs', async () => {
  const before = await pollUntil(
    'pre-send staged state',
    async () => [await tokenBalanceRaw(env.rpc, env.token, device), await ethBalanceRaw(env.rpc, device)] as const,
    ([z, e]) => z === STAGED_ZCHF && e === STAGED_ETH_WEI,
  );

  // The app's send path end-to-end: estimate → gas gate → sign 1559 → broadcast → receipt poll.
  const broadcastHashes: string[] = [];
  // The recipient is a SHARED well-known account across this run's files, so its assertion is a
  // DELTA (read BEFORE the send).
  const paidBefore = await tokenBalanceRaw(env.rpc, env.token, ANVIL_ACCOUNT_1);
  const {txHash} = await sendErc20(
    secretHex,
    {chainId: ANVIL_CHAIN_ID, tokenAddress: env.token, to: ANVIL_ACCOUNT_1, rawAmount: '42', decimals: 18},
    undefined,
    (h) => { broadcastHashes.push(h); },
  );
  expect(broadcastHashes).toEqual([txHash]); // onBroadcast fired with the SAME hash, pre-confirmation
  await expect(getEvmReceiptStatus(ANVIL_CHAIN_ID, txHash)).resolves.toBe('included');

  // DIRECT anvil: ZCHF moved by exactly the amount, ETH dropped by real gas.
  const [zchfAfter, paid, ethAfter] = await pollUntil(
    'post-send balances',
    async () => [
      await tokenBalanceRaw(env.rpc, env.token, device),
      await tokenBalanceRaw(env.rpc, env.token, ANVIL_ACCOUNT_1),
      await ethBalanceRaw(env.rpc, device),
    ] as const,
    ([z]) => z === STAGED_ZCHF - SEND_AMOUNT,
  );
  expect(zchfAfter.toString()).toBe((STAGED_ZCHF - SEND_AMOUNT).toString());
  expect(paid.toString()).toBe((paidBefore + SEND_AMOUNT).toString());
  expect(ethAfter).toBeLessThan(before[1]);

  // The app's poll agrees (through the pipe; polled past its 2s read cache).
  const read = await pollUntil(
    'app poll sees the send',
    async () => readEvmBalances(secretHex, keys),
    (r) => {
      const t = r.tokens[`${ANVIL_CHAIN_ID}:ZCHF`];
      return t.kind === 'balance' && t.amount === (STAGED_ZCHF - SEND_AMOUNT).toString();
    },
  );
  expect(read.tokens[`${ANVIL_CHAIN_ID}:ZCHF`]).toEqual({kind: 'balance', amount: (STAGED_ZCHF - SEND_AMOUNT).toString()});

  // The eth_getLogs walk now carries BOTH legs, newest-first: the out transfer (42 → account #1)
  // above the in transfer (500 from the deployer). The raw Transfer log for the out leg is read
  // DIRECT too, decoded with the app's own decoder.
  const history = await getEvmHistory(ANVIL_CHAIN_ID, device, env.token);
  expect(history.kind).toBe('history');
  if (history.kind !== 'history') return;
  expect(history.dropped).toBe(0);
  expect(history.rows).toHaveLength(2);
  const [outLeg, inLeg] = history.rows;
  expect(outLeg.dir).toBe('out');
  expect(outLeg.amount).toBe(SEND_AMOUNT.toString());
  expect(outLeg.counterparty).toBe(ANVIL_ACCOUNT_1.toLowerCase());
  expect(outLeg.txHash).toBe(txHash.toLowerCase());
  expect(inLeg.dir).toBe('in');
  expect(inLeg.amount).toBe(STAGED_ZCHF.toString());

  const logs = await transferLogsRaw(env.rpc, env.token, '0x1');
  const out = logs.find((l) => l.txHash.toLowerCase() === txHash.toLowerCase());
  expect(out).toBeDefined();
  expect(out?.from.toLowerCase()).toBe(device.toLowerCase());
  expect(out?.to.toLowerCase()).toBe(ANVIL_ACCOUNT_1.toLowerCase());
  expect(out?.amount.toString()).toBe(SEND_AMOUNT.toString());
}, 60_000);
