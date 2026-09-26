#!/usr/bin/env node
// e2e/harness/evm-sign.mjs — the agent test float's EVM tool (docs/AGENT-FUNDS.md). NO
// ethers/web3/circle-sdk — the crypto core (keccak + secp256k1 + SLIP-10 + RLP + EIP-1559 +
// ABI slices + JSON-RPC) is the ONE shared implementation in harness/evm/evm-core.mjs
// (D26.2), the same module the local-Anvil harness and the 213-217 flow proofs import.
// This file is the thin float shell around it: the sops-key loading + the LIVE-mainnet
// command surface. The key decrypts from sops INSIDE this process (execFileSync capture)
// and is never printed, logged, or written to disk. EVM evidence lives in ledger `tx`
// fields (funds history is IC-only).
//
// Usage (RPC: DPAY_LIVE_EVM_RPC, default https://ethereum-rpc.publicnode.com):
//   node e2e/harness/evm-sign.mjs status
//      address (verified against secrets/agent-evm.pub.json — refuses to run otherwise),
//      nonce (pending), balance, gas baseFee, USDC balance + allowance to TokenMessengerV2.
//   node e2e/harness/evm-sign.mjs approve <spender> <amountSubunits>
//      ERC-20 approve, signed + broadcast; prints the tx hash and waits for the receipt.
//   node e2e/harness/evm-sign.mjs cctp-burn <amountSubunits> <solBase58> <maxFeeSubunits> [minFinality=1000]
//      CCTP V2 TokenMessenger.depositForBurn(amount, domain=5(Solana), mintRecipient=32B
//      solana address, burnToken=USDC, destinationCaller=0, maxFee, minFinalityThreshold),
//      signed + broadcast; prints the tx hash and waits for the receipt.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  eip55, evmAddressOf, signEip1559, rpc, ethCall,
  selector, word32BE, addressWord, decodeUint256,
} from './evm/evm-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPC_URL = process.env.DPAY_LIVE_EVM_RPC ?? 'https://ethereum-rpc.publicnode.com';
const PUB = join(ROOT, 'secrets/agent-evm.pub.json');
const SEC = join(ROOT, 'secrets/agent-evm.sops.json');
const CHAIN_ID = 1n;

// CCTP V2 mainnet constants — same census the app's cctp.ts pins (app/config/constants.ts).
export const USDC_ERC20 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
export const CCTP_DOMAIN_SOLANA = 5;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function bs58Decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bs58: bad char ${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16).padStart(s.length * 2 > 64 ? 64 : 2, '0');
  let bytes = Buffer.from(hex, 'hex');
  // Leading '1's are leading zero bytes.
  let zeros = 0;
  for (const c of s) { if (c !== '1') break; zeros++; }
  if (zeros > 0) bytes = Buffer.concat([Buffer.alloc(zeros), bytes]);
  return bytes;
}

// Re-exports so existing importers keep working (the core is the single implementation).
export {eip55, evmAddressOf};

/** The float's EVM key, decrypted at the moment of use. NEVER print. */
function evmKeyHex() {
  const out = execFileSync('sops', ['-d', SEC], {
    encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, SOPS_AGE_KEY_FILE: join(ROOT, '.dev/age/agent-key.txt')},
  });
  const key = JSON.parse(out).private_key_hex;
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('evm-sign: sops key is not 32 bytes of hex — refusing');
  return key;
}

/** Decrypt + derive + verify against the registered plaintext address. HARD GATE. */
function loadKey() {
  const priv = evmKeyHex();
  const derived = evmAddressOf(priv);
  const registered = JSON.parse(readFileSync(PUB, 'utf8')).address;
  if (eip55(derived).toLowerCase() !== registered.toLowerCase()) {
    throw new Error(`evm-sign: derived ${derived} != registered ${registered} — refusing to sign`);
  }
  return priv;
}

// --- RPC (the URL is the float's; everything else comes from the shared core) ---------------
const rpcAt = (method, params) => rpc(RPC_URL, method, params, {timeoutMs: 30_000});
const ethEstimateGas = (tx) => rpcAt('eth_estimateGas', [tx]);

// --- ABI helpers (float-specific slices; generic ones live in evm-core) ----------------------
export function encodeErc20Approve(spender, amountSubunits) {
  return selector('approve(address,uint256)')
    + addressWord(spender).toString('hex')
    + word32BE(amountSubunits).toString('hex');
}

export function encodeDepositForBurn(amountSubunits, mintRecipient32B, maxFeeSubunits, minFinality) {
  const sig = 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)';
  return selector(sig)
    + word32BE(amountSubunits).toString('hex')                      // amount
    + word32BE(CCTP_DOMAIN_SOLANA).toString('hex')                  // destinationDomain
    + Buffer.from(mintRecipient32B).toString('hex').padStart(64, '0') // mintRecipient
    + addressWord(USDC_ERC20).toString('hex')                       // burnToken
    + '0'.repeat(64)                                                // destinationCaller = 0 (permissionless)
    + word32BE(maxFeeSubunits).toString('hex')                      // maxFee
    + word32BE(minFinality).toString('hex');                        // minFinalityThreshold
}

export function usdcBalanceOfData(owner) { return selector('balanceOf(address)') + addressWord(owner).toString('hex'); }
export function usdcAllowanceData(owner, spender) { return selector('allowance(address,address)') + addressWord(owner).toString('hex') + addressWord(spender).toString('hex'); }

// --- sign + send ---------------------------------------------------------------
async function signAndSend({to, data, gasLimit, value = 0n}) {
  const priv = loadKey();
  const from = eip55(evmAddressOf(priv));
  const nonce = BigInt(await rpcAt('eth_getTransactionCount', [from, 'pending']));
  const tip = 2_000_000_000n; // 2 gwei priority — generous, gas is ~0.7 gwei
  const head = await rpcAt('eth_getBlockByNumber', ['latest', false]);
  const baseFee = BigInt(head.baseFeePerGas);
  const maxFee = baseFee * 4n + tip;
  const {rawTx} = signEip1559({
    privHex: priv, chainId: CHAIN_ID, nonce,
    maxFeePerGas: maxFee, maxPriorityFeePerGas: tip,
    gasLimit: BigInt(gasLimit), to, value, data,
  });
  const hash = await rpcAt('eth_sendRawTransaction', [rawTx]);
  console.log(`sent   ${hash}`);
  console.log(`       to=${to} gasLimit=${gasLimit} maxFeePerGas=${maxFee} wei nonce=${nonce}`);
  return hash;
}

async function waitReceipt(hash, {timeoutMs = 240_000} = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await rpcAt('eth_getTransactionReceipt', [hash]);
    if (r != null) {
      const ok = BigInt(r.status) === 1n;
      console.log(`receipt status=${r.status} gasUsed=${BigInt(r.gasUsed)} block=${BigInt(r.blockNumber)} ${ok ? 'OK' : 'REVERTED'}`);
      if (!ok) process.exitCode = 3;
      return r;
    }
    if (Date.now() - t0 > timeoutMs) { console.log('receipt: still pending (not an error)'); return null; }
    await new Promise((r2) => setTimeout(r2, 4_000));
  }
}

// --- CLI -------------------------------------------------------------------------
const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === (await import('node:fs').then(m => m.realpathSync(process.argv[1])).catch(() => null));
if (isMain) {
const [cmd, ...args] = process.argv.slice(2);
const gwei = (wei) => `${Number(wei) / 1e9} gwei`;

try {
  if (cmd === 'status') {
    const priv = loadKey();
    const addr = eip55(evmAddressOf(priv));
    const [nonce, balance, head, usdc, allowance] = await Promise.all([
      rpcAt('eth_getTransactionCount', [addr, 'pending']),
      rpcAt('eth_getBalance', [addr, 'latest']),
      rpcAt('eth_getBlockByNumber', ['latest', false]),
      ethCall(RPC_URL, USDC_ERC20, usdcBalanceOfData(addr), {timeoutMs: 30_000}),
      ethCall(RPC_URL, USDC_ERC20, usdcAllowanceData(addr, TOKEN_MESSENGER_V2), {timeoutMs: 30_000}),
    ]);
    console.log(`address    ${addr}`);
    console.log(`nonce      ${nonce}`);
    console.log(`ETH        ${Number(BigInt(balance)) / 1e18} (${BigInt(balance)} wei)`);
    console.log(`baseFee    ${gwei(BigInt(head.baseFeePerGas))}`);
    console.log(`USDC       ${Number(decodeUint256(usdc)) / 1e6} (${decodeUint256(usdc)} subunits)`);
    console.log(`USDC allowance → TokenMessengerV2: ${decodeUint256(allowance)} subunits`);
  } else if (cmd === 'approve') {
    const [spender, amount] = args;
    if (!/^0x[0-9a-fA-F]{40}$/.test(spender ?? '')) throw new Error(`approve: bad spender ${spender}`);
    if (!/^\d+$/.test(amount ?? '')) throw new Error(`approve: bad amount ${amount}`);
    const est = await ethEstimateGas({from: eip55(evmAddressOf(loadKey())), to: USDC_ERC20, data: '0x' + encodeErc20Approve(spender, amount)});
    const gasLimit = (BigInt(est) * 12n) / 10n + 10000n;
    console.log(`approve ${spender} ${amount} (est ${est} → limit ${gasLimit})`);
    const hash = await signAndSend({to: USDC_ERC20, data: encodeErc20Approve(spender, amount), gasLimit});
    await waitReceipt(hash);
  } else if (cmd === 'cctp-burn') {
    const [amount, solAddr, maxFee, finality = '1000'] = args;
    if (!/^\d+$/.test(amount ?? '')) throw new Error(`cctp-burn: bad amount ${amount}`);
    const recipient = bs58Decode(solAddr ?? '');
    if (recipient.length !== 32) throw new Error(`cctp-burn: solana address must decode to 32 bytes, got ${recipient.length}`);
    if (!/^\d+$/.test(maxFee ?? '')) throw new Error(`cctp-burn: bad maxFee ${maxFee}`);
    const data = encodeDepositForBurn(amount, recipient, maxFee, parseInt(finality, 10));
    const est = await ethEstimateGas({from: eip55(evmAddressOf(loadKey())), to: TOKEN_MESSENGER_V2, data});
    const gasLimit = (BigInt(est) * 12n) / 10n + 10000n;
    console.log(`depositForBurn amount=${amount} recipient=${solAddr} maxFee=${maxFee} finality=${finality} (est ${est} → limit ${gasLimit})`);
    const hash = await signAndSend({to: TOKEN_MESSENGER_V2, data, gasLimit});
    await waitReceipt(hash);
  } else if (cmd === 'receipt') {
    await waitReceipt(args[0], {timeoutMs: 30_000});
  } else {
    console.error('unknown command — see header');
    process.exit(2);
  }
} catch (e) {
  console.error(`evm-sign FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
}
