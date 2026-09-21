#!/usr/bin/env node
// e2e/harness/evm-sign.mjs — minimal dependency-free EVM signer for the agent test float's
// evm-float key (docs/AGENT-FUNDS.md). NO ethers/web3/circle-sdk — keccak + secp256k1 + RLP
// built on the same @noble packages the harness already ships (jupiter.mjs precedent), plus
// ~200 lines of EIP-1559 signing. The key decrypts from sops INSIDE this process (execFileSync
// capture) and is never printed, logged, or written to disk. EVM evidence lives in ledger
// `tx` fields (funds history is IC-only).
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
import {keccak_256} from '@noble/hashes/sha3';
import {secp256k1} from '@noble/curves/secp256k1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPC = process.env.DPAY_LIVE_EVM_RPC ?? 'https://ethereum-rpc.publicnode.com';
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

// --- RLP -----------------------------------------------------------------
function rlpEncode(item) {
  if (item instanceof Uint8Array || Buffer.isBuffer(item)) {
    const b = Buffer.from(item);
    if (b.length === 1 && b[0] < 0x80) return b;
    if (b.length < 56) return Buffer.concat([Buffer.from([0x80 + b.length]), b]);
    const len = b.length;
    const lenBytes = bigintBytes(BigInt(len));
    return Buffer.concat([Buffer.from([0xb7 + lenBytes.length]), lenBytes, b]);
  }
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlpEncode));
    if (body.length < 56) return Buffer.concat([Buffer.from([0xc0 + body.length]), body]);
    const lenBytes = bigintBytes(BigInt(body.length));
    return Buffer.concat([Buffer.from([0xf7 + lenBytes.length]), lenBytes, body]);
  }
  throw new Error(`rlp: bad item ${typeof item}`);
}
function bigintBytes(n) {
  if (n === 0n) return Buffer.from([]);
  const hex = n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0');
  return Buffer.from(hex, 'hex');
}
function num(x) { return bigintBytes(typeof x === 'bigint' ? x : BigInt(x)); }

// --- EIP-55 / key ----------------------------------------------------------
export function eip55(addr) {
  const lower = addr.toLowerCase().replace(/^0x/, '');
  const h = Buffer.from(keccak_256(lower)).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

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

export function evmAddressOf(privHex) {
  const pub = secp256k1.getPublicKey(Buffer.from(privHex, 'hex'), false); // 65B uncompressed
  return '0x' + Buffer.from(keccak_256(pub.slice(1)).slice(-20)).toString('hex');
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

// --- RPC --------------------------------------------------------------------
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
}
export const ethCall = (to, data) => rpc('eth_call', [{to, data}, 'latest']);
export const ethEstimateGas = (tx) => rpc('eth_estimateGas', [tx]);

// --- ABI helpers --------------------------------------------------------------
const hex = (n) => '0x' + (typeof n === 'bigint' ? n : BigInt(n)).toString(16);
function word32BE(v) { // 32-byte left-padded word from a bigint
  let h = (typeof v === 'bigint' ? v : BigInt(v)).toString(16).padStart(64, '0');
  if (h.length > 64) throw new Error(`abi: value too big: ${v}`);
  return Buffer.from(h, 'hex');
}
function selector(sig) { return '0x' + Buffer.from(keccak_256(Buffer.from(sig))).toString('hex').slice(0, 8); }
function addressWord(a) { return word32BE(BigInt(a)); }

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
function decodeUint256(hexStr) {
  const body = hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr;
  return BigInt('0x' + (body || '0'));
}

// --- sign + send ---------------------------------------------------------------
async function signAndSend({to, data, gasLimit, value = 0n}) {
  const priv = loadKey();
  const from = eip55(evmAddressOf(priv));
  const nonce = BigInt(await rpc('eth_getTransactionCount', [from, 'pending']));
  const tip = 2_000_000_000n; // 2 gwei priority — generous, gas is ~0.7 gwei
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  const baseFee = BigInt(head.baseFeePerGas);
  const maxFee = baseFee * 4n + tip;
  const tx = {
    chainId: CHAIN_ID, nonce,
    maxPriorityFeePerGas: tip, maxFeePerGas: maxFee,
    gasLimit: BigInt(gasLimit), to: Buffer.from(to.replace(/^0x/, ''), 'hex'),
    value, data: Buffer.from(data.replace(/^0x/, ''), 'hex'),
    accessList: [],
  };
  const payload = rlpEncode([
    num(tx.chainId), num(tx.nonce), num(tx.maxPriorityFeePerGas), num(tx.maxFeePerGas),
    num(tx.gasLimit), tx.to, num(tx.value), tx.data, rlpEncode([]),
  ]);
  const digest = keccak_256(Buffer.concat([Buffer.from('02', 'hex'), payload]));
  const sig = secp256k1.sign(digest, Buffer.from(priv, 'hex'), {prehash: false});
  if (sig.recovery !== 0 && sig.recovery !== 1) throw new Error('evm-sign: bad recovery');
  const signed = rlpEncode([
    num(tx.chainId), num(tx.nonce), num(tx.maxPriorityFeePerGas), num(tx.maxFeePerGas),
    num(tx.gasLimit), tx.to, num(tx.value), tx.data, rlpEncode([]),
    num(sig.recovery), Buffer.from(sig.r.toString(16).padStart(64, '0'), 'hex'), Buffer.from(sig.s.toString(16).padStart(64, '0'), 'hex'),
  ]);
  const raw = '0x02' + signed.toString('hex');
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  console.log(`sent   ${hash}`);
  console.log(`       to=${to} gasLimit=${gasLimit} maxFeePerGas=${maxFee} wei nonce=${nonce}`);
  return hash;
}

async function waitReceipt(hash, {timeoutMs = 240_000} = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
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
      rpc('eth_getTransactionCount', [addr, 'pending']),
      rpc('eth_getBalance', [addr, 'latest']),
      rpc('eth_getBlockByNumber', ['latest', false]),
      ethCall(USDC_ERC20, usdcBalanceOfData(addr)),
      ethCall(USDC_ERC20, usdcAllowanceData(addr, TOKEN_MESSENGER_V2)),
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
