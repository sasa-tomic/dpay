// node-anvil tier, test 2 of 3 — the SEND path (e2e flows 219/222's service half), no browser:
// the app's sendErc20 driven end-to-end on the real chain (estimate → gas gate passes → sign
// 1559 → broadcast → receipt poll → real balance delta), then the gas-refusal branch: the payer
// drained BELOW the signed worst-case fee (under even a two-transaction worst case) refuses with
// the instructive EvmGasGateError and broadcasts NOTHING.
//
// Two timing facts the assertions respect: anvil produces 1s blocks, and the relay pipe TTL-
// caches reads for 2s — so every "did the app see it yet" read is a POLL through the seam, while
// the exact numbers are asserted on DIRECT anvil reads (the second source).
import {expect, test, beforeAll} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deriveEvmAddress,
  getEvmReceiptStatus,
  isEvmGasGateError,
  quoteEvmFee,
  readEvmBalances,
  sendErc20,
  type EvmKey,
} from '../../evm';
import {encodeTransfer} from '../../evm/abi';
import {toHex0x} from '../../evm/tx';
import {
  ANVIL_ACCOUNT_1,
  ANVIL_CHAIN_ID,
  devSeed,
  ethBalanceRaw,
  fundEthDirect,
  fundZchfDirect,
  nodeAnvilEnv,
  pollUntil,
  tokenBalanceRaw,
  txCountRaw,
  wireSeamToPipe,
  type NodeAnvilEnv,
} from './anvilEnv';

const ZCHF = (n: bigint): bigint => n * 10n ** 18n;
const SEND_AMOUNT = ZCHF(7n);
const STAGED_ETH_WEI = 1_000_000_000_000_000n; // 0.001 ETH

let env: NodeAnvilEnv;
let secretHex: string;
let device: string;
let KEYS: EvmKey[];

beforeAll(async () => {
  env = nodeAnvilEnv();
  await AsyncStorage.clear();
  await wireSeamToPipe(env);
  secretHex = devSeed('220 device');
  device = deriveEvmAddress(secretHex);
  KEYS = [{chainId: ANVIL_CHAIN_ID, token: 'ZCHF', tokenAddress: env.token, decimals: 18}];
});

test('220 · quoteEvmFee returns the chain\u2019s own arithmetic, then sendErc20 lands on chain', async () => {
  await fundEthDirect(env.rpc, device, STAGED_ETH_WEI);
  await fundZchfDirect(env.rpc, env.token, device, ZCHF(100n));

  // The chain's OWN quote over the same typed inputs the send will use (D15.2: dpay never quotes).
  const quote = await quoteEvmFee(
    ANVIL_CHAIN_ID,
    device,
    env.token,
    toHex0x(encodeTransfer(ANVIL_ACCOUNT_1, SEND_AMOUNT)),
  );
  expect(BigInt(quote.gasUnits) > 0n).toBe(true);
  expect(BigInt(quote.baseFeeWei) > 0n).toBe(true);
  expect(BigInt(quote.maxFeeWei) > 0n).toBe(true);
  expect(BigInt(quote.maxFeePerGasWei) >= BigInt(quote.baseFeeWei)).toBe(true);

  const txsBefore = await txCountRaw(env.rpc, device);
  const paidBefore = await tokenBalanceRaw(env.rpc, env.token, ANVIL_ACCOUNT_1);
  const {txHash} = await sendErc20(
    secretHex,
    {chainId: ANVIL_CHAIN_ID, tokenAddress: env.token, to: ANVIL_ACCOUNT_1, rawAmount: '7', decimals: 18},
  );
  expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  await expect(getEvmReceiptStatus(ANVIL_CHAIN_ID, txHash)).resolves.toBe('included');

  // REAL chain state: exactly one new tx, the ZCHF delta exact, gas burned on the ETH leg.
  const [zchfAfter, paid, txsAfter] = await pollUntil(
    'send inclusion',
    async () => [
      await tokenBalanceRaw(env.rpc, env.token, device),
      await tokenBalanceRaw(env.rpc, env.token, ANVIL_ACCOUNT_1),
      await txCountRaw(env.rpc, device),
    ] as const,
    ([, , n]) => n === txsBefore + 1n,
  );
  expect(zchfAfter.toString()).toBe((ZCHF(100n) - SEND_AMOUNT).toString());
  expect(paid.toString()).toBe((paidBefore + SEND_AMOUNT).toString());
  expect(txsAfter.toString()).toBe((txsBefore + 1n).toString());
  expect((await ethBalanceRaw(env.rpc, device)) < STAGED_ETH_WEI).toBe(true);

  // The app's own poll agrees, through the pipe (polled past its 2s read cache).
  const read = await pollUntil(
    'app poll sees the send',
    async () => readEvmBalances(secretHex, KEYS),
    (r) => {
      const t = r.tokens[`${ANVIL_CHAIN_ID}:ZCHF`];
      return t.kind === 'balance' && t.amount === (ZCHF(100n) - SEND_AMOUNT).toString();
    },
  );
  expect(read.tokens[`${ANVIL_CHAIN_ID}:ZCHF`]).toEqual({kind: 'balance', amount: (ZCHF(100n) - SEND_AMOUNT).toString()});
}, 60_000);

test('220 · the gas-refusal branch: drained ETH refuses BEFORE anything broadcasts', async () => {
  // Drain the payer to a residual dust balance that is provably below the signed worst case: the
  // chain's own estimate for this very transfer exceeds 2x it, and a real fee can never be
  // smaller (any tx burns >= 21000 gas x base fee). The refusal must fire on the payer's
  // MEASURED balance.
  const quote = await quoteEvmFee(
    ANVIL_CHAIN_ID,
    device,
    env.token,
    toHex0x(encodeTransfer(ANVIL_ACCOUNT_1, SEND_AMOUNT)),
  );
  const drainedTo = 1_000_000_000n; // 1 gwei of dust
  expect(BigInt(quote.maxFeeWei) > 2n * BigInt(drainedTo)).toBe(true);
  await fundEthDirect(env.rpc, device, drainedTo);
  // The gate reads the payer's balance THROUGH the pipe (2s read cache): poll the app's own read
  // until it sees the drained figure, or the gate would refuse on the STALE pre-drain balance.
  await pollUntil(
    'app poll sees the drain',
    async () => readEvmBalances(secretHex, KEYS),
    (r) => {
      const g = r.gas[ANVIL_CHAIN_ID];
      return g.kind === 'balance' && g.wei === drainedTo.toString();
    },
  );

  const zchfBefore = await tokenBalanceRaw(env.rpc, env.token, device);
  const paidBefore = await tokenBalanceRaw(env.rpc, env.token, ANVIL_ACCOUNT_1);
  const txsBefore = await txCountRaw(env.rpc, device);

  let refusal: unknown = null;
  try {
    await sendErc20(
      secretHex,
      {chainId: ANVIL_CHAIN_ID, tokenAddress: env.token, to: ANVIL_ACCOUNT_1, rawAmount: '7', decimals: 18},
    );
  } catch (e) {
    refusal = e;
  }
  expect(isEvmGasGateError(refusal)).toBe(true);
  const gate = refusal as {requiredWei: string; gasBalanceWei: string; address: string; nativeSymbol: string};
  expect(BigInt(gate.requiredWei) > BigInt(gate.gasBalanceWei)).toBe(true);
  expect(gate.gasBalanceWei).toBe(drainedTo.toString()); // the payer's MEASURED balance, read live
  expect(gate.address.toLowerCase()).toBe(device.toLowerCase());
  expect(gate.nativeSymbol).toBe('ETH');

  // Nothing broadcast: tx count unchanged, both token balances unchanged (DIRECT reads).
  expect((await txCountRaw(env.rpc, device)).toString()).toBe(txsBefore.toString());
  expect((await tokenBalanceRaw(env.rpc, env.token, device)).toString()).toBe(zchfBefore.toString());
  expect((await tokenBalanceRaw(env.rpc, env.token, ANVIL_ACCOUNT_1)).toString()).toBe(paidBefore.toString());
}, 60_000);
