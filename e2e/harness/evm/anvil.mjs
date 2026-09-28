#!/usr/bin/env node
// e2e/harness/evm/anvil.mjs — local Anvil staging for the EVM rail (D26): spawn a SCRATCH chain
// (31337, offline, 1s blocks so receipt polls behave like Arbitrum's cadence), deploy the COMMITTED
// MockZCHF blob (e2e/harness/evm/MockZCHF.hex) with a raw signed type-2 tx from anvil's well-known
// account #0 key (public and valueless), fund the DEVICE-derived EVM key (anvil_setBalance for gas
// + a plain signed ZCHF transfer from the deployer), and print/write the config block.
//
// No forge/solc at runtime — the offline inner-loop rule. The blob is compiled ONCE and committed
// (provenance + hashes: e2e/harness/evm/README.md); this module fails loud if the .hex and the
// .json blob disagree, so a half-updated pair can never deploy silently.
//
// Device key: derived from a 32-byte seed with the SAME SLIP-10 path the app uses
// (m/44'/60'/0'/0/0 — evm-core.mjs, vector-proven). Resolution order:
//   DPAY_EVM_DEVICE_KEY   raw 32-byte private key hex (power users / exact-match tests)
//   DPAY_EVM_DEV_SEED     32-byte identity seed hex (the app-side Identity.secretHex)
//   DPAY_EVM_DEV_ADDR     a bare 0x address — fund it WITHOUT any seed knowledge (D26.3)
//   (unset)               the fixed, documented, VALUELESS dev seed below (deterministic address)
//
// CLI (what `just evm-anvil` runs):
//   node e2e/harness/evm/anvil.mjs               stage on :8545, leave the chain RUNNING (detached,
//                                                logs → anvil.log), print the config JSON, exit 0.
//   node e2e/harness/evm/anvil.mjs --foreground  same but anvil stays attached (Ctrl-C stops both).
//   --port N                                     stage on another port (default 8545).
// Idempotent: a re-run stops the previous instance (pidfile) and stages a FRESH chain — the token
// address is deterministic (deployer #0, nonce 0), so anvil.json converges to the same values.
import {spawn} from 'node:child_process';
import {existsSync, openSync, readFileSync, writeFileSync, unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {sha256} from '@noble/hashes/sha2';
import {
  eip55, evmAddressOf, keccak, deriveEvmKeypair, rpc, ethCall, signEip1559,
  encodeErc20Transfer, encodeErc20BalanceOf, sendRawAndWait, decodeUint256, bytesOf,
} from './evm-core.mjs';
import {trackChild, untrackChild} from '../procs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
export const ANVIL_CHAIN_ID = 31337;
export const ANVIL_BLOCK_TIME = 1; // seconds — receipt polls at Arbitrum-like cadence (D26.1)
export const ANVIL_PORT = 8545;
export const ANVIL_JSON = join(__dirname, 'anvil.json');
export const ANVIL_PID = join(__dirname, 'anvil.pid');
export const ANVIL_LOG = join(__dirname, 'anvil.log');

// Anvil's well-known account #0 (mnemonic "test test ... junk"), public and valueless. The DEPLOYER.
export const ANVIL_ACCOUNT_0_PRIV = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const ANVIL_DEPLOYER = eip55(evmAddressOf(ANVIL_ACCOUNT_0_PRIV)); // 0xf39F…92266

// The fixed dev seed — deterministic, DOCUMENTED, valueless (a scratch local chain only; never a
// secret). Deriving it from a phrase (instead of a bare magic literal) keeps it out of the "looks
// like a key" class while staying stable across machines, so anvil.json's device address is too.
// Exported so live-chain scripts (evm-sepolia-roundtrip) can derive the SAME seed's further
// indices — a harness-derived counterparty — without re-stating the phrase.
export const DEV_SEED = Buffer.from(sha256(Buffer.from('dpay evm anvil dev seed — valueless, offline only', 'utf8'))).toString('hex');
// Defaults mirroring D26.3: 10 finney of gas + a working ZCHF balance to pay with.
export const DEV_DEFAULT_ETH_WEI = 10_000_000_000_000n;    // 10 finney = 0.01 ETH
export const DEV_DEFAULT_ZCHF_RAW = 50_000n * 10n ** 18n;  // 50,000 ZCHF

// --- binary resolution (third_party cache first, per the pocket-ic precedent) -----------------
export function findAnvilBin() {
  const vendored = join(REPO_ROOT, 'third_party', 'bin', 'anvil');
  if (existsSync(vendored)) return vendored;
  const foundry = process.env.HOME ? join(process.env.HOME, '.foundry', 'bin', 'anvil') : null;
  if (foundry && existsSync(foundry)) return foundry;
  throw new Error(
    'anvil not found — the EVM e2e chain needs the foundry binary.\n' +
    '  fix (one line): curl -L https://foundry.paradigm.xyz | bash && foundryup\n' +
    `  then it is picked up from ~/.foundry/bin/anvil, or vendored once: mkdir -p third_party/bin && cp ~/.foundry/bin/anvil third_party/bin/anvil`);
}

// --- the committed blob (deployed as-is; never compiled at runtime) ----------------------------
function readBlob() {
  const hex = readFileSync(join(__dirname, 'MockZCHF.hex'), 'utf8').trim();
  if (!/^0x[0-9a-f]+$/.test(hex) || hex.length < 400) {
    throw new Error('MockZCHF.hex is not a plausible creation bytecode blob — refusing to deploy garbage');
  }
  const json = JSON.parse(readFileSync(join(__dirname, 'MockZCHF.json'), 'utf8'));
  const got = '0x' + keccak(Buffer.from(hex.slice(2), 'hex')).toString('hex');
  if (json.bytecode_keccak256 !== got) {
    throw new Error(`MockZCHF.hex does not match MockZCHF.json's pinned keccak (${json.bytecode_keccak256} != ${got}) — the committed pair is half-updated`);
  }
  return hex;
}

// --- spawn + readiness -------------------------------------------------------------------------
export async function spawnAnvil({port = ANVIL_PORT, chainId = ANVIL_CHAIN_ID, blockTime = ANVIL_BLOCK_TIME, foreground = false} = {}) {
  const bin = findAnvilBin();
  // Pre-flight: a chain already answering on this port is a STALE/FOREIGN instance — staging onto
  // it would fund+deploy against state we don't own (measured failure mode: an orphaned anvil from
  // a crashed run answers eth_chainId, the fresh spawn dies on EADDRINUSE, and the readiness poll
  // happily adopts the stale chain). Fail loud instead; never adopt.
  const url = `http://127.0.0.1:${port}`;
  try {
    await rpc(url, 'eth_chainId', [], {timeoutMs: 1_000});
    throw new Error(`port ${port} already serves an EVM chain at ${url} — kill the stale instance first (see: pgrep -af anvil), or stage on another port (--port / DPAY_EVM_ANVIL_PORT)`);
  } catch (e) {
    if (e.message.includes('already serves')) throw e;
    // else: connection refused — the port is free, proceed
  }
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--block-time', String(blockTime), '--silent'];
  let child;
  if (foreground) {
    child = spawn(bin, args, {stdio: ['ignore', 'inherit', 'inherit']});
  } else {
    const logFd = openSync(ANVIL_LOG, 'w');
    child = spawn(bin, args, {stdio: ['ignore', logFd, logFd], detached: true});
    child.unref(); // the CLI exits after staging; the chain keeps serving (that is the point)
  }
  trackChild(child.pid);
  child.on('exit', () => untrackChild(child.pid));
  const deadline = Date.now() + 15_000;
  let lastErr = null;
  let exited = false;
  child.on('exit', () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) {
      // Our own anvil died (bad flag, EADDRINUSE, …) — surface its log tail, never adopt a
      // foreign listener that may be answering on the same port.
      let tail = '';
      try { tail = readFileSync(ANVIL_LOG, 'utf8').split('\n').slice(-8).join('\n'); } catch {}
      throw new Error(`anvil exited before becoming ready on ${url}. log tail:\n${tail}`);
    }
    try {
      const id = await rpc(url, 'eth_chainId', [], {timeoutMs: 1_500});
      if (BigInt(id) === BigInt(chainId)) return {child, url, port, pid: child.pid};
      lastErr = new Error(`eth_chainId answered ${id}, expected ${chainId}`);
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  try { child.kill('SIGKILL'); } catch {}
  throw new Error(`anvil never became ready on ${url} within 15s (last error: ${lastErr?.message ?? 'none'})`);
}

/** Stop the previously staged instance, if the pidfile still points at a live anvil. */
export async function stopStaged() {
  if (!existsSync(ANVIL_PID)) return false;
  const pid = parseInt(readFileSync(ANVIL_PID, 'utf8').trim(), 10);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40 && alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    if (alive) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  try { unlinkSync(ANVIL_PID); } catch {}
  return true;
}

// --- deploy + fund (raw signed txs; no forge at runtime) ----------------------------------------
async function fees(url) {
  const head = await rpc(url, 'eth_getBlockByNumber', ['latest', false]);
  const baseFee = BigInt(head.baseFeePerGas);
  const tip = 2_000_000_000n; // 2 gwei — generous on a scratch chain, irrelevant to correctness
  return {maxFeePerGas: baseFee * 4n + tip, maxPriorityFeePerGas: tip};
}

async function sendTx(url, {privHex, to = null, data = '0x', value = 0n, gasLimit}) {
  const from = eip55(evmAddressOf(privHex));
  const nonce = BigInt(await rpc(url, 'eth_getTransactionCount', [from, 'pending']));
  const {maxFeePerGas, maxPriorityFeePerGas} = await fees(url);
  const {rawTx, txHash} = signEip1559({privHex, chainId: ANVIL_CHAIN_ID, nonce, maxFeePerGas, maxPriorityFeePerGas, gasLimit, to, value, data});
  const {receipt, reverted} = await sendRawAndWait(url, rawTx, {timeoutMs: 20_000});
  if (reverted) throw new Error(`tx ${txHash} reverted (status ${receipt.status})`);
  return {txHash, receipt};
}

/** Deploy the committed MockZCHF blob from the well-known deployer. Deterministic address. */
export async function deployToken(url) {
  const creationCode = readBlob();
  const {receipt} = await sendTx(url, {privHex: ANVIL_ACCOUNT_0_PRIV, to: null, data: creationCode, gasLimit: 3_000_000n});
  const token = receipt.contractAddress;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token ?? '')) throw new Error(`deploy produced no contract address (${token})`);
  return eip55(token);
}

export async function fundEth(url, address, wei) {
  await rpc(url, 'anvil_setBalance', [address, '0x' + BigInt(wei).toString(16)], {timeoutMs: 5_000});
}

export async function transferToken(url, tokenAddress, fromPrivHex, to, amountRaw) {
  await sendTx(url, {privHex: fromPrivHex, to: tokenAddress, data: encodeErc20Transfer(to, BigInt(amountRaw)), gasLimit: 80_000n});
}

export async function zchfBalanceOf(url, tokenAddress, owner) {
  const res = await ethCall(url, tokenAddress, encodeErc20BalanceOf(owner), {timeoutMs: 5_000});
  return decodeUint256(res);
}

// --- device-account resolution ------------------------------------------------------------------
/**
 * Resolve the device account from the env ladder (see the header). Returns
 * `{address, privHex?, source}` — privHex present only when a seed/key was given (a bare
 * DPAY_EVM_DEV_ADDR is fundable without key knowledge, D26.3's driver path).
 */
export function resolveDeviceAccount(env = process.env) {
  if (env.DPAY_EVM_DEVICE_KEY) {
    const privHex = bytesOf(env.DPAY_EVM_DEVICE_KEY, 32).toString('hex');
    return {address: eip55(evmAddressOf(privHex)), privHex, source: 'DPAY_EVM_DEVICE_KEY'};
  }
  if (env.DPAY_EVM_DEV_SEED) {
    const {address, privateKeyHex} = deriveEvmKeypair(env.DPAY_EVM_DEV_SEED);
    return {address, privHex: privateKeyHex, source: 'DPAY_EVM_DEV_SEED'};
  }
  if (env.DPAY_EVM_DEV_ADDR) {
    const addr = env.DPAY_EVM_DEV_ADDR.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`DPAY_EVM_DEV_ADDR=${addr} is not a 0x + 40-hex address`);
    return {address: eip55(addr), source: 'DPAY_EVM_DEV_ADDR'};
  }
  const {address, privateKeyHex} = deriveEvmKeypair(DEV_SEED);
  return {address, privHex: privateKeyHex, source: 'default dev seed (valueless)'};
}

/** Amount knobs: DPAY_EVM_DEV_ZCHF (decimal ZCHF, or `raw:<bigint>`) / DPAY_EVM_DEV_ETH (decimal ETH). */
export function resolveAmounts(env = process.env) {
  const parseZchf = (s) => s.startsWith('raw:') ? BigInt(s.slice(4)) : BigInt(Math.floor(Number(s) * 1e6)) * 10n ** 12n;
  return {
    zchfRaw: env.DPAY_EVM_DEV_ZCHF ? parseZchf(env.DPAY_EVM_DEV_ZCHF) : DEV_DEFAULT_ZCHF_RAW,
    ethWei: env.DPAY_EVM_DEV_ETH ? BigInt(Math.floor(Number(env.DPAY_EVM_DEV_ETH) * 1e18)) : DEV_DEFAULT_ETH_WEI,
  };
}

// --- staging (one call; the flows import this) ---------------------------------------------------
/**
 * Stage the whole local chain: spawn scratch anvil, deploy MockZCHF, fund each recipient.
 * Recipients: `{seed|privHex|address, zchfRaw?, ethWei?}` — exactly one key-ish field.
 * Returns `{chainId, rpcUrl, port, stop, tokenAddress, deployer, accounts:[{address, ethWei, zchfRaw, privHex?}]}`.
 */
export async function stageAnvil({port = ANVIL_PORT, blockTime = ANVIL_BLOCK_TIME, recipients = [], foreground = false} = {}) {
  const {child, url} = await spawnAnvil({port, blockTime, foreground});
  const stop = async () => { try { child.kill('SIGTERM'); } catch {} };
  try {
    // Scratch-chain invariant: the deployer MUST be at nonce 0 on a fresh chain. Non-zero means
    // the port answers with a stale chain (the pre-flight race lost) — never stage onto it.
    const deployerNonce = await rpc(url, 'eth_getTransactionCount', [ANVIL_DEPLOYER, 'pending'], {timeoutMs: 5_000});
    if (BigInt(deployerNonce) !== 0n) throw new Error(`port ${port} serves a USED chain (deployer nonce ${deployerNonce}) — a scratch anvil must be fresh; kill the stale instance`);
    const tokenAddress = await deployToken(url);
    const accounts = [];
    for (const r of recipients) {
      const acct = r.privHex ? {address: eip55(evmAddressOf(r.privHex)), privHex: r.privHex, source: 'privHex'}
        : r.seed ? (({address, privateKeyHex}) => ({address, privHex: privateKeyHex, source: 'seed'}))(deriveEvmKeypair(r.seed))
        : r.address ? {address: eip55(r.address), source: 'address'}
        : (() => { throw new Error('stageAnvil recipient needs one of seed|privHex|address'); })();
      const ethWei = r.ethWei ?? 0n;
      const zchfRaw = r.zchfRaw ?? 0n;
      if (ethWei > 0n) await fundEth(url, acct.address, ethWei);
      if (zchfRaw > 0n) await transferToken(url, tokenAddress, ANVIL_ACCOUNT_0_PRIV, acct.address, zchfRaw);
      accounts.push({...acct, ethWei, zchfRaw});
    }
    return {chainId: ANVIL_CHAIN_ID, rpcUrl: url, port, pid: child.pid, child, stop, tokenAddress, deployer: ANVIL_DEPLOYER, accounts};
  } catch (e) {
    await stop();
    throw e;
  }
}

// --- CLI ----------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {port: parseInt(process.env.DPAY_EVM_ANVIL_PORT ?? '', 10) || ANVIL_PORT, foreground: false};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--foreground') out.foreground = true;
    else throw new Error(`unknown arg ${argv[i]}`);
  }
  return out;
}

const isMain = process.argv[1] != null && await import('node:fs').then((m) => { try { return m.realpathSync(process.argv[1]); } catch { return null; } }) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const {port, foreground} = parseArgs(process.argv.slice(2));
    await stopStaged(); // idempotency: a re-run always stages a FRESH scratch chain
    const device = resolveDeviceAccount();
    const {zchfRaw, ethWei} = resolveAmounts();
    console.log(`[evm-anvil] device: ${device.address} (${device.source})`);
    const staged = await stageAnvil({
      port, foreground,
      recipients: [{...device, zchfRaw, ethWei}],
    });
    // Pidfile FIRST — every fallible step after staging (serialization, balance check) must not
    // orphan the chain it just staged (measured leak: a throw between spawn and pidfile left an
    // untracked anvil holding the port, and the next run adopted it).
    writeFileSync(ANVIL_PID, String(staged.pid));
    const config = {
      chainId: staged.chainId,
      rpcUrl: staged.rpcUrl,
      tokenAddress: staged.tokenAddress,
      token: 'MockZCHF (ZCHF stand-in, 18 dec, EIP-2612 permit — see README.md)',
      deployer: staged.deployer,
      device: {address: device.address, source: device.source, ethWei: ethWei.toString(), zchfRaw: zchfRaw.toString()},
      blockTime: ANVIL_BLOCK_TIME,
      spawnedAt: new Date().toISOString(),
      pid: staged.pid,
    };
    writeFileSync(ANVIL_JSON, JSON.stringify(config, null, 2) + '\n');
    const bal = await zchfBalanceOf(staged.rpcUrl, staged.tokenAddress, device.address);
    if (bal !== zchfRaw) throw new Error(`post-fund balance check failed: ${bal} != ${zchfRaw}`);
    console.log(JSON.stringify(config, null, 2));
    console.log(`[evm-anvil] config → ${ANVIL_JSON}; anvil logs → ${ANVIL_LOG}`);
    console.log(`[evm-anvil] the chain stays RUNNING on ${staged.rpcUrl} (stop: kill $(cat ${ANVIL_PID}) or just stop)`);
    if (foreground) {
      // anvil runs attached (stdio inherited); Ctrl-C reaches it as a process-group signal.
      await new Promise((resolve) => staged.child.on('exit', resolve));
    } else {
      staged.child.unref?.();
    }
    process.exit(0);
  } catch (e) {
    console.error(`[evm-anvil] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
