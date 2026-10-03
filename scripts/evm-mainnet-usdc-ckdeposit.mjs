#!/usr/bin/env node
// deposit-usdc-cketh.mjs — the CCTP round-trip FUNDING leg: move the USDC that the first
// CCTP trip's minter withdraw delivered to the rail address BACK to the IC side as ckUSDC,
// using the app's own deposit flow (ckUSDC minter helper, approve + depositErc20), signed
// by the SAME rail key the app derives. Calldata mirrors app/cketh.ts byte-for-byte
// (selector db9751af, principalToBytes32's length-prefix encoding; goldens pin both).
//
//   node tmp/deposit-usdc-cketh.mjs [relayBase]
//     relayBase default https://dpay.kalaj.org — serves /api/v1/onramp/ckerc20 (helper+erc20)
//               and the /api/v1/evm/rpc pipe.
//
// Float rule: smallest sensible = the WHOLE USDC balance (it is dead weight on the EVM rail;
// the CCTP re-drive needs it on the IC side). A reverted tx burns gas and is recorded, never
// retried blind. The seed is decrypted in-process and never printed.
import {execFileSync} from 'node:child_process';
import {
  rpc, ethCall, decodeUint256, signEip1559, sendRawRpc,
  encodeErc20BalanceOf, deriveEvmKeypair, eip55, selector, addressWord, word32BE,
} from '../e2e/harness/evm/evm-core.mjs';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const CHAIN_ID = 1n;
const TIP_GWEI = 500_000_000n; // 0.5 gwei priority — the buy script's calm-gas figure
const APPROVE_GAS = 60_000n;
const DEPOSIT_GAS = 200_000n;

// The float's IC principal (funds/wallets.json icp-float) — the mint's recipient.
const FLOAT_PRINCIPAL = process.argv[3] ?? 'vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae';
const RELAY = process.argv[2] ?? 'https://dpay.kalaj.org';

const assert = (ok, msg) => { if (!ok) throw new Error(`usdc-deposit: ${msg}`); };

/** RFC-3986 principal text → CRC-stripped bytes (the 4-byte CRC is the FIRST group). */
function principalBytes(text) {
  const t = text.replace(/-/g, '');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0; const out = [];
  for (const c of t.toLowerCase()) {
    const idx = alphabet.indexOf(c);
    assert(idx >= 0, `bad principal char ${c}`);
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out.slice(4)); // strip the CRC32 prefix — app/cketh.ts does the same
}

/** app/cketh.ts principalToBytes32: [len, ...bytes, 0-pad] in one 32-byte word. */
function principalToBytes32(text) {
  const p = principalBytes(text);
  const out = Buffer.alloc(32);
  out[0] = p.length;
  p.copy(out, 1);
  return '0x' + out.toString('hex');
}

function railKey() {
  const seed = execFileSync('node', ['scripts/agent-key.mjs', 'seed'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  assert(/^[0-9a-f]{64}$/i.test(seed), 'agent-key seed did not return 64 hex chars — refusing');
  const kp = deriveEvmKeypair(seed);
  seed.replace(/./g, '0');
  return kp;
}

const pipe = `${RELAY}/api/v1/evm/rpc`;
const chainIdHex = await rpc(pipe, 'eth_chainId', [], {timeoutMs: 10_000});
assert(BigInt(chainIdHex) === CHAIN_ID, `chain ${chainIdHex} is not mainnet`);

const kp = railKey();
console.log('rail address', eip55(kp.address));

// Onramp params from the relay — the SAME helper the app's deposit sheet drives.
const onramp = await (await fetch(`${RELAY}/api/v1/onramp/ckerc20?currency=2`)).json();
assert(onramp.kind === 'erc20' && /^0x[0-9a-fA-F]{40}$/.test(onramp.helper_address ?? ''),
  `onramp params unusable: ${JSON.stringify(onramp)}`);
console.log('helper', onramp.helper_address);

const balHex = await ethCall(pipe, USDC, encodeErc20BalanceOf(kp.address));
const amount = BigInt(balHex);
assert(amount > 0n, 'no USDC at the rail to deposit');
console.log('depositing USDC raw', amount.toString());

const pw = principalToBytes32(FLOAT_PRINCIPAL);
const zeroWord = '0'.repeat(64);

async function sendOne(label, {to, data, gasLimit}) {
  const nonce = BigInt(await rpc(pipe, 'eth_getTransactionCount', [kp.address, 'latest'], {timeoutMs: 10_000}));
  const baseHex = await rpc(pipe, 'eth_gasPrice', [], {timeoutMs: 10_000});
  const base = BigInt(baseHex);
  const maxFee = base * 2n + TIP_GWEI;
  const {rawTx: raw} = signEip1559({
    privHex: kp.privateKeyHex, chainId: CHAIN_ID, nonce,
    maxFeePerGas: maxFee, maxPriorityFeePerGas: TIP_GWEI, gasLimit, to, data,
  });
  const hash = await sendRawRpc(pipe, raw, {timeoutMs: 30_000});
  console.log(label, 'broadcast', hash);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const rec = await rpc(pipe, 'eth_getTransactionReceipt', [hash], {timeoutMs: 10_000}).catch(() => null);
    if (rec != null) {
      assert(rec.status === '0x1', `${label} REVERTED (status ${rec.status}) — recording, never retrying blind`);
      console.log(label, 'mined block', BigInt(rec.blockNumber).toString(), 'gas', BigInt(rec.gasUsed).toString());
      return hash;
    }
  }
  throw new Error(`${label}: receipt never landed in 120s — hash ${hash} (DO NOT resubmit blind)`);
}

// 1. approve(helper, amount) on USDC
const approveData = '0x' + selector('approve(address,uint256)').slice(2)
  + addressWord(onramp.helper_address).toString('hex') + word32BE(amount).toString('hex');
await sendOne('approve', {to: USDC, data: approveData, gasLimit: APPROVE_GAS});

// 2. depositErc20(erc20, amount, principal, subaccount) on the helper — mints ckUSDC 1:1
const depositData = '0x' + selector('depositErc20(address,uint256,bytes32,bytes32)').slice(2)
  + addressWord(USDC).toString('hex') + word32BE(amount).toString('hex')
  + pw.replace(/^0x/, '') + zeroWord;
const depositHash = await sendOne('deposit', {to: onramp.helper_address, data: depositData, gasLimit: DEPOSIT_GAS});

console.log('DONE approve+deposit; the ckUSDC minter mints within ~20 min.');
console.log('DEPOSIT_HASH=' + depositHash);
