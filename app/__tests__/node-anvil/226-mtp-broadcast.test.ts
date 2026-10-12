// node-anvil tier — the Mt Pelerin cash-out broadcast (plan R2 step 2), test 226: the cash-out's
// SEND half driven end-to-end on the real chain — the wallet's own ERC-20 path (the exact call
// EvmWithdrawSheet's confirm makes: estimate → gas gate passes → sign 1559 → broadcast →
// receipt poll) moving REAL ZCHF to a STUB offRampAddress (an anvil account standing in for the
// venue's sell-order deposit address). The submitted-not-settled honesty made real: the app
// holds the hash the moment the chain accepts, and the chain then proves the funds landed at
// exactly the venue address for exactly the quoted amount.
//
// NOT RUN on the dev loop (`just node-anvil` runs it; AGENTS.md: slow suites exactly once before
// commits move back). Written per the 219-225 convention: real anvil + real relay pipe, no
// browser, polls through the seam, exact numbers asserted on direct anvil reads.
import {expect, test, beforeAll} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deriveEvmAddress,
  getEvmReceiptStatus,
  sendErc20,
} from '../../evm';
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
const CASH_OUT_AMOUNT = ZCHF(3n); // the typed 3 ZCHF the sheet sends
const STAGED_ETH_WEI = 1_000_000_000_000_000n; // 0.001 ETH of gas
// The STUB offRampAddress: the venue's sell-order deposit address, stand-in for the
// `offRampAddress` a real conversion answer carries. ANVIL_ACCOUNT_1 is an address this test
// does not control by derivation, which is exactly the property that matters — dpay sends, it
// does not receive.
const STUB_OFFRAMP = ANVIL_ACCOUNT_1;

let env: NodeAnvilEnv;
let secretHex: string;
let device: string;

beforeAll(async () => {
  env = nodeAnvilEnv();
  await AsyncStorage.clear();
  await wireSeamToPipe(env);
  secretHex = devSeed('226 device');
  device = deriveEvmAddress(secretHex);
});

test('226 · the cash-out send lands the exact ZCHF amount at the stub offRampAddress, submitted-not-settled', async () => {
  // The staged wallet: gas (the gate reads the payer's ETH) + the token being cashed out.
  await fundEthDirect(env.rpc, device, STAGED_ETH_WEI);
  await fundZchfDirect(env.rpc, env.token, device, ZCHF(10n));

  const txsBefore = await txCountRaw(env.rpc, device);
  const offRampBefore = await tokenBalanceRaw(env.rpc, env.token, STUB_OFFRAMP);

  // THE SEND, exactly as the sheet's confirm makes it: the token contract + decimals come from
  // the catalog row, the destination is the venue's order address, the amount is the user's
  // typed figure. The returned hash is what the sheet's submitted-not-settled terminal shows.
  const {txHash} = await sendErc20(
    secretHex,
    {chainId: ANVIL_CHAIN_ID, tokenAddress: env.token, to: STUB_OFFRAMP, rawAmount: '3', decimals: 18},
  );
  expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

  // The chain's own verdict: receipt included, the payer's nonce advanced by exactly one, and
  // the stub offRampAddress holds the EXACT delta — every sat of the 3 ZCHF arrived.
  await expect(getEvmReceiptStatus(ANVIL_CHAIN_ID, txHash)).resolves.toBe('included');
  const [deviceZchf, offRampAfter, txsAfter] = await pollUntil(
    'mtp broadcast inclusion',
    async () => [
      await tokenBalanceRaw(env.rpc, env.token, device),
      await tokenBalanceRaw(env.rpc, env.token, STUB_OFFRAMP),
      await txCountRaw(env.rpc, device),
    ] as const,
    ([, , n]) => n === txsBefore + 1n,
  );
  expect(deviceZchf.toString()).toBe((ZCHF(10n) - CASH_OUT_AMOUNT).toString());
  expect(offRampAfter.toString()).toBe((offRampBefore + CASH_OUT_AMOUNT).toString());
  expect(txsAfter).toBe(txsBefore + 1n);
  // Gas was burned on the ETH leg (the gate's own arithmetic, D15) — the payer's ETH is down.
  expect((await ethBalanceRaw(env.rpc, device)) < STAGED_ETH_WEI).toBe(true);
}, 60_000);
