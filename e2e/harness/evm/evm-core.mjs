// e2e/harness/evm/evm-core.mjs — the ONE dependency-free EVM implementation the harness shares:
// keccak + secp256k1 + SLIP-10 + RLP + EIP-1559 signing + the ABI slices + a JSON-RPC client.
// NO ethers/web3 — built on the same @noble packages the app ships (app/evm/* is the app-side
// mirror; this file is the harness-side twin and must never import app code: flows run in plain
// node against committed bytes only).
//
// Consumers:
//   e2e/harness/evm-sign.mjs   the agent float tool (sops-key CLI; thin shell over this core)
//   e2e/harness/evm/anvil.mjs  local Anvil staging (deploy MockZCHF, fund device keys)
//   e2e/harness/evm/pipe-smoke.mjs + e2e/tests/21{3..7}-evm-*.mjs  relay-pipe proofs
//
// SLIP-10 note: the secp256k1 HMAC-SHA512 here is the hand-rolled RFC 2104 form (sha512 only),
// byte-for-byte the same construction as app/evm/identity.ts — same master seed ("Bitcoin
// seed"), same path m/44'/60'/0'/0/0 — so a seed funded by anvil.mjs is the address the app
// derives, and flow 218's cross-check holds over BOTH implementations.
import {keccak_256} from '@noble/hashes/sha3';
import {sha512} from '@noble/hashes/sha512';
import {secp256k1} from '@noble/curves/secp256k1';

// --- keccak -----------------------------------------------------------------
export const keccak = (bytes) => Buffer.from(keccak_256(bytes));
export const keccakHex = (bytes) => '0x' + keccak(bytes).toString('hex');

// --- RLP (byte-identical to the app's rlp.ts semantics) -----------------------
function rlpEncode(item) {
  if (item instanceof Uint8Array || Buffer.isBuffer(item)) {
    const b = Buffer.from(item);
    if (b.length === 1 && b[0] < 0x80) return b;
    if (b.length < 56) return Buffer.concat([Buffer.from([0x80 + b.length]), b]);
    const lenBytes = bigintBytes(BigInt(b.length));
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

// --- EIP-55 / keys -----------------------------------------------------------
export function eip55(addr) {
  const lower = addr.toLowerCase().replace(/^0x/, '');
  const h = keccak(Buffer.from(lower, 'utf8')).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** 0x-address of a secp256k1 private key (32B hex, 0x optional). */
export function evmAddressOf(privHex) {
  const pub = secp256k1.getPublicKey(bytesOf(privHex, 32), false); // 65B uncompressed
  return '0x' + keccak(pub.slice(1)).slice(-20).toString('hex');
}

// --- SLIP-10 secp256k1 (m/44'/60'/0'/0/0 — the EVM rail's device path) --------
const SLIP10_MASTER_KEY = Buffer.from('Bitcoin seed', 'utf8');
const HARDENED = 0x80000000;
const N = secp256k1.CURVE.n;
export const EVM_DERIVATION_PATH = [44, 60, 0].map((i) => i + HARDENED).concat([0, 0]);

// RFC 2104 HMAC-SHA512 on the stable sha512 primitive (never noble's hmac — see the header of
// app/evm/identity.ts for the version-drift rationale; the construction must stay identical).
function hmacSha512(key, data) {
  const blockLen = 128;
  const normKey = key.length > blockLen ? Buffer.from(sha512(key)) : Buffer.from(key);
  const pad = Buffer.alloc(blockLen);
  normKey.copy(pad);
  const inner = Buffer.alloc(blockLen + data.length);
  const outer = Buffer.alloc(blockLen + 64);
  for (let i = 0; i < blockLen; i++) { inner[i] = pad[i] ^ 0x36; outer[i] = pad[i] ^ 0x5c; }
  data.copy(inner, blockLen);
  Buffer.from(sha512(inner)).copy(outer, blockLen);
  return Buffer.from(sha512(outer));
}

/**
 * SLIP-10 secp256k1 child derivation over hardened (>= 0x80000000) and normal indices. Exported so
 * the SLIP-10 official test vectors can assert master AND intermediate nodes directly against the
 * reference (flow 218 pins TV1 + TV2), not just the leaf of one fixed path. Throws on the SLIP-10
 * invalid-key conditions (IL = 0, IL >= n, or the normal-derivation sum wrapping past n) — at a
 * fixed path that is a derivation-code bug, never a runtime condition to recover from.
 */
export function deriveSlip10Secp256k1Node(masterSeed, indices) {
  let intermediate = hmacSha512(SLIP10_MASTER_KEY, masterSeed);
  let privKey = Buffer.from(intermediate.subarray(0, 32)); // IL (copy: buffer reuse below)
  let chainCode = Buffer.from(intermediate.subarray(32, 64)); // IR
  for (const index of indices) {
    const hardened = index >= HARDENED;
    // data = (0x00 || IL) for hardened, serP(K) for normal — 33 bytes either way — || index_be32.
    // Total 37 bytes ALWAYS; a (hardened ? 1 : 33) + 4 shape is the classic 5-byte overflow bug.
    const data = Buffer.alloc(33 + 4);
    if (hardened) {
      data[0] = 0x00;
      privKey.copy(data, 1);
    } else {
      Buffer.from(secp256k1.getPublicKey(privKey, true)).copy(data, 0);
    }
    data.writeUInt32BE(index >>> 0, data.length - 4);
    intermediate = hmacSha512(chainCode, data);
    const il = intermediate.subarray(0, 32);
    // SLIP-10 validity + child key: for secp256k1 the child key is (IL + parent) mod n for BOTH
    // hardened and normal children (only the HMAC DATA differs between the two) and must be in
    // [1, n-1]. Skipping the add on hardened is the classic ed25519 conflation — vectors catch it.
    const ilInt = BigInt('0x' + Buffer.from(il).toString('hex'));
    if (ilInt === 0n || ilInt >= N) throw new Error('SLIP-10 secp256k1: derived invalid IL');
    const parentInt = BigInt('0x' + privKey.toString('hex'));
    const childInt = (ilInt + parentInt) % N;
    if (childInt === 0n) throw new Error('SLIP-10 secp256k1: derived zero child key');
    privKey = Buffer.from(childInt.toString(16).padStart(64, '0'), 'hex');
    chainCode = Buffer.from(intermediate.subarray(32, 64));
  }
  return {privateKey: privKey, chainCode};
}

/**
 * Derive the device EVM keypair from the SAME 32-byte identity seed the Solana rail uses
 * (Identity.secretHex) at the standard Ethereum coin-type path. Mirrors app/evm/identity.ts
 * `deriveEvmKeypair` exactly (flow 218 cross-checks the two).
 */
export function deriveEvmKeypair(secretHex) {
  const seed = typeof secretHex === 'string' ? bytesOf(secretHex) : Buffer.from(secretHex);
  const leaf = deriveSlip10Secp256k1Node(seed, EVM_DERIVATION_PATH);
  const privateKeyHex = leaf.privateKey.toString('hex');
  return {privateKeyHex, address: eip55(evmAddressOf(privateKeyHex))};
}

function bytesOf(hexStr, expectLen) {
  const s = String(hexStr).toLowerCase().replace(/^0x/, '');
  if (s === '') return Buffer.alloc(0);
  if (!/^[0-9a-f]+$/.test(s) || s.length % 2 !== 0) throw new Error(`evm-core: bad hex: ${String(hexStr).slice(0, 12)}…`);
  const b = Buffer.from(s, 'hex');
  if (expectLen != null && b.length !== expectLen) throw new Error(`evm-core: expected ${expectLen} bytes, got ${b.length}`);
  return b;
}
export {bytesOf};

// --- ABI slices (the selectors this rail needs — app/evm/abi.ts is the app mirror) -----------
export function selector(sig) { return '0x' + keccak(Buffer.from(sig, 'utf8')).toString('hex').slice(0, 8); }
export function word32BE(v) {
  const h = (typeof v === 'bigint' ? v : BigInt(v)).toString(16).padStart(64, '0');
  if (h.length > 64) throw new Error(`abi: value too big: ${v}`);
  return Buffer.from(h, 'hex');
}
export function addressWord(a) { return word32BE(BigInt(a)); }

export function encodeErc20Transfer(to, amountRaw) {
  return selector('transfer(address,uint256)')
    + addressWord(to).toString('hex') + word32BE(amountRaw).toString('hex');
}
export function encodeErc20BalanceOf(owner) {
  return selector('balanceOf(address)') + addressWord(owner).toString('hex');
}
export function encodeErc20Nonces(owner) {
  return selector('nonces(address)') + addressWord(owner).toString('hex');
}
export function encodePermit(owner, spender, value, deadline, v, r, s) {
  // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  return selector('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)')
    + addressWord(owner).toString('hex') + addressWord(spender).toString('hex')
    + word32BE(value).toString('hex') + word32BE(deadline).toString('hex')
    + word32BE(v).toString('hex') + bytesOf(r, 32).toString('hex') + bytesOf(s, 32).toString('hex');
}
export function encodeTransferFrom(from, to, amountRaw) {
  return selector('transferFrom(address,address,uint256)')
    + addressWord(from).toString('hex') + addressWord(to).toString('hex') + word32BE(amountRaw).toString('hex');
}
export function encodeDomainSeparator() { return selector('DOMAIN_SEPARATOR()'); }
export function decodeUint256(hexStr) {
  const body = String(hexStr ?? '').toLowerCase().replace(/^0x/, '');
  return BigInt('0x' + (body || '0'));
}

// --- EIP-712 permit digest (D21/D24: the offline claim's signature target) --------------------
const PERMIT_TYPEHASH = keccak(Buffer.from('Permit(address owner,address spender,uint256 value,uint256 deadline,uint256 nonce)', 'utf8'));
const DOMAIN_TYPEHASH = keccak(Buffer.from('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)', 'utf8'));

/** keccak256(abi.encode(...)) over flat 32-byte words — enough for both hashes here. */
function abiEncode32(words) { return Buffer.concat(words.map((w) => word32BE(w))); }

export function domainSeparator({name, version, chainId, verifyingContract}) {
  return keccakHex(abiEncode32([
    BigInt('0x' + DOMAIN_TYPEHASH.toString('hex')),
    BigInt('0x' + keccak(Buffer.from(name, 'utf8')).toString('hex')),
    BigInt('0x' + keccak(Buffer.from(version, 'utf8')).toString('hex')),
    chainId,
    BigInt(verifyingContract),
  ]));
}

// The MINIMAL EIP-712 domain: chainId + verifyingContract ONLY — no name, no version. This is
// what the REAL ZCHF (Frankencoin's ERC20PermitLight) signs and therefore what the committed
// MockZCHF blob implements (MockZCHF.sol's DOMAIN_TYPEHASH). NOTE for the app twin: spec D9
// named a full {name, version} domain — the real ZCHF does NOT use one; stream S2 must pin the
// minimal form for ZCHF or verify against DOMAIN_SEPARATOR() before any permit ships.
const MINIMAL_DOMAIN_TYPEHASH = keccak(Buffer.from('EIP712Domain(uint256 chainId,address verifyingContract)', 'utf8'));

export function domainSeparatorMinimal({chainId, verifyingContract}) {
  return keccakHex(abiEncode32([
    BigInt('0x' + MINIMAL_DOMAIN_TYPEHASH.toString('hex')),
    chainId,
    BigInt(verifyingContract),
  ]));
}

/** The EIP-2612 digest a payer signs OFFLINE — MINIMAL domain (the ZCHF/MockZCHF form). */
export function permitDigestMinimal({chainId, verifyingContract, owner, spender, value, deadline, nonce}) {
  const ds = Buffer.from(domainSeparatorMinimal({chainId, verifyingContract}).slice(2), 'hex');
  const structHash = keccak(abiEncode32([
    BigInt('0x' + PERMIT_TYPEHASH.toString('hex')),
    BigInt(owner), BigInt(spender), value, deadline, nonce,
  ]));
  return keccakHex(Buffer.concat([Buffer.from([0x19, 0x01]), ds, structHash]));
}

/** The EIP-2612 digest a payer signs OFFLINE (flow 220; app/evm/permit.ts is the app mirror). */
export function permitDigest({name, version, chainId, verifyingContract, owner, spender, value, deadline, nonce}) {
  const ds = Buffer.from(domainSeparator({name, version, chainId, verifyingContract}).slice(2), 'hex');
  const structHash = keccak(abiEncode32([
    BigInt('0x' + PERMIT_TYPEHASH.toString('hex')),
    BigInt(owner), BigInt(spender), value, deadline, nonce,
  ]));
  return keccakHex(Buffer.concat([Buffer.from([0x19, 0x01]), ds, structHash]));
}

/** Sign a 32-byte digest → the 65-byte EIP-2612 signature as `0x` + 130 lowercase hex chars. */
export function signDigest(digestHex, privHex) {
  const sig = secp256k1.sign(bytesOf(digestHex, 32), bytesOf(privHex, 32), {prehash: false});
  if (sig.recovery !== 0 && sig.recovery !== 1) throw new Error('evm-core: bad recovery');
  const r = Buffer.from(BigInt(sig.r).toString(16).padStart(64, '0'), 'hex');
  const s = Buffer.from(BigInt(sig.s).toString(16).padStart(64, '0'), 'hex');
  const sigHex = '0x' + r.toString('hex') + s.toString('hex') + (sig.recovery === 0 ? '1b' : '1c');
  return {r: '0x' + r.toString('hex'), s: '0x' + s.toString('hex'), v: sig.recovery, sigHex};
}

// --- EIP-1559 (type 2) signing ---------------------------------------------------------------
/**
 * Build + sign a type-2 tx. `to = null` deploys (creation bytecode in `data`).
 * Returns `{rawTx, txHash}` — txHash is keccak over the raw bytes (what nodes key receipts by).
 */
export function signEip1559({privHex, chainId, nonce, maxFeePerGas, maxPriorityFeePerGas, gasLimit, to, value = 0n, data = '0x'}) {
  const priv = bytesOf(privHex, 32);
  const toBytes = to == null ? Buffer.alloc(0) : bytesOf(to, 20);
  const dataBytes = bytesOf(data.startsWith('0x') ? data : '0x' + data);
  const payload = rlpEncode([
    num(chainId), num(nonce), num(maxPriorityFeePerGas), num(maxFeePerGas),
    num(gasLimit), toBytes, num(value), dataBytes, [], // accessList: a NESTED LIST item — passing rlpEncode([]) would double-encode it as the byte string 0x81c0 (undecodable)
  ]);
  const digest = keccak(Buffer.concat([Buffer.from([0x02]), payload]));
  const sig = secp256k1.sign(digest, priv, {prehash: false});
  if (sig.recovery !== 0 && sig.recovery !== 1) throw new Error('evm-core: bad recovery');
  const signed = rlpEncode([
    num(chainId), num(nonce), num(maxPriorityFeePerGas), num(maxFeePerGas),
    num(gasLimit), toBytes, num(value), dataBytes, [], // accessList: a NESTED LIST item — passing rlpEncode([]) would double-encode it as the byte string 0x81c0 (undecodable)
    num(sig.recovery), Buffer.from(BigInt(sig.r).toString(16).padStart(64, '0'), 'hex'), Buffer.from(BigInt(sig.s).toString(16).padStart(64, '0'), 'hex'),
  ]);
  // Integrity: the recovered signer must be the key we were handed (a swap here would fund/
  // transfer from an address nobody owns — fail before any broadcast). Address = keccak(pub)[12:].
  const recovered = '0x' + keccak(Buffer.from(sig.recoverPublicKey(digest).toRawBytes(false).slice(1))).slice(-20).toString('hex');
  const sender = eip55(evmAddressOf(priv.toString('hex')));
  if (recovered.toLowerCase() !== sender.toLowerCase()) throw new Error(`evm-core: signer recovery mismatch ${recovered} != ${sender}`);
  const rawTx = '0x02' + signed.toString('hex');
  return {rawTx, txHash: keccakHex(Buffer.from(rawTx.slice(2), 'hex')), from: sender};
}

// --- JSON-RPC client (bounded timeout; error surfacing is the caller's taxonomy) --------------
let rpcId = 0;
export async function rpc(url, method, params = [], {timeoutMs = 10_000} = {}) {
  const res = await fetch(url, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: ++rpcId, method, params}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
}

export const ethCall = (url, to, data, opts) => rpc(url, 'eth_call', [{to, data}, 'latest'], opts);

/**
 * Broadcast + wait for the receipt. Polls `eth_getTransactionReceipt` until non-null; a REVERTED
 * receipt is RETURNED (status 0x0), never thrown — callers assert on status where it matters.
 */
export async function sendRawAndWait(url, rawTx, {timeoutMs = 30_000, pollMs = 250} = {}) {
  const hash = await sendRawRpc(url, rawTx, {timeoutMs});
  const t0 = Date.now();
  for (;;) {
    const r = await rpc(url, 'eth_getTransactionReceipt', [hash]);
    if (r != null) return {hash, receipt: r, reverted: BigInt(r.status) !== 1n};
    if (Date.now() - t0 > timeoutMs) throw new Error(`evm-core: receipt for ${hash} never landed within ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/**
 * eth_sendRawTransaction with ONE defensive retry of the IDENTICAL bytes. Rationale: anvil was
 * once observed answering a verbatim-forwarded raw tx with a spurious `Failed to decode
 * transaction` (reads + estimate on the same pipe stayed green; never reproduced since), and the
 * relay forwards the client's bytes verbatim (evm.rs fetch_once). Resending the SAME signature is
 * safe — nodes dedup by hash ('already known' → the first send landed) and this is NOT the app's
 * blind-re-sign rule (no new signing material, ever; the app seam keeps its own stricter rule).
 */
export async function sendRawRpc(url, rawTx, {timeoutMs = 10_000} = {}) {
  try {
    return await rpc(url, 'eth_sendRawTransaction', [rawTx], {timeoutMs});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('Failed to decode transaction')) throw e;
    await new Promise((res) => setTimeout(res, 1_200));
    try {
      return await rpc(url, 'eth_sendRawTransaction', [rawTx], {timeoutMs});
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      if (msg2.includes('already known')) return keccakHex(Buffer.from(rawTx.slice(2), 'hex'));
      throw e2;
    }
  }
}

// --- Transfer log decoding (history's raw material; flow 219 asserts the decode) --------------
export const TRANSFER_TOPIC = '0x' + keccak(Buffer.from('Transfer(address,address,uint256)', 'utf8')).toString('hex');

/** Decode one ERC-20 Transfer event log → {from, to, value}. Null when it is not a Transfer. */
export function decodeTransferLog(log) {
  const topics = log.topics ?? [];
  if (topics.length !== 3 || topics[0].toLowerCase() !== TRANSFER_TOPIC) return null;
  return {
    from: '0x' + topics[1].slice(-40),
    to: '0x' + topics[2].slice(-40),
    value: decodeUint256(log.data),
  };
}
