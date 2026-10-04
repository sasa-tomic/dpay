#!/usr/bin/env node
// cctp-sol-eth-bridge.mjs — the raw Circle CCTP V1 Solana->Ethereum bridge, the REVERSE of the
// proven Eth->Sol burn (app/cctp.ts): burns the float's USDC on Solana, fetches Circle's V1
// attestation, then claims the mint on Ethereum from the device rail key. Broadcast through the
// dpay relay's RPC pipes (POST /api/v1/{solana,evm}/rpc), key decrypted IN-PROCESS, never printed.
//
// Subcommands (each idempotent, each FAILS CLOSED before signing on any gate):
//   topup     Jupiter USDC->SOL on the rail (the V1 MessageSent event account needs ~0.003 SOL
//             rent up front; reclaimable after receive via `reclaim`)
//   burn      TokenMessenger(v1 Solana) depositForBurn — the full balance, sim FIRST, then send
//   attest    poll iris /v1/messages/5/<sig> until status complete; write /tmp/opencode JSON
//   receive   MessageTransmitter(v1 Eth) receiveMessage(message, attestation) from the rail key
//   reclaim   reclaim_event_account — closes the event account, returns the rent
//
// GROUND TRUTH (2026-10-04): every Solana account address below was read out of a REAL live v1
// depositForBurn (sig 2wKKPx7m…, a deBridge-wrapped burn; and the plain Sol->Eth burn
// 2bU9Hy2j…, which also pinned the domain-0 remote_token_messenger) — not derived from seeds:
// the rust (circlefin/solana-cctp-contracts DepositForBurnContext) orders accounts
// owner, event_rent_payer, sender_authority_pda, burn_token_account, message_transmitter,
// token_messenger, remote_token_messenger, token_minter, local_token, burn_token_mint,
// message_sent_event_data, mt_program, tm_program, token_program, system_program, [event_cpi
// authority, program]. Discriminator sha256("global:deposit_for_burn")[0..8] = d73c3d2e723780b0,
// args (amount u64, destinationDomain u32, mintRecipient 32B). V1 picked over V2 deliberately:
// zero fee, and the event-account rent is reclaimable IMMEDIATELY after receive (V2 locks it
// 5 days). Docs verified 2026-10-04: Ethereum MT v1 = 0x0a992d191DEeC32aFe36203Ad87D7d289a738F81
// (developers.circle.com/cctp/v1/evm-smart-contracts.md — NOT the stale 0x2643… from earlier
// notes), Solana v1 programs CCTPmbSD…/CCTPiPYP… (v1/solana-programs.md).
//
// No @solana/web3.js: the legacy tx codec below follows app/solana/tx.ts's golden-pinned format.
import {execFileSync} from 'node:child_process';
import {writeFileSync, readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {keccak_256} from '/home/sat/projects/dpay/dpay-main/app/node_modules/@noble/hashes/sha3.js';
import pkgSha512 from '/home/sat/projects/dpay/dpay-main/app/node_modules/@noble/hashes/sha512.js';
const {sha512} = pkgSha512;
import pkgEd from '/home/sat/projects/dpay/dpay-main/app/node_modules/@noble/curves/ed25519.js';
const {ed25519} = pkgEd;
import {base58} from '/home/sat/projects/dpay/dpay-main/app/node_modules/@scure/base/lib/esm/index.js';
import {
  rpc, ethCall, decodeUint256, signEip1559, sendRawRpc, deriveEvmKeypair, eip55,
} from '/home/sat/projects/dpay/dpay-main/e2e/harness/evm/evm-core.mjs';

const SOL_PIPE = 'https://dpay.kalaj.org/api/v1/solana/rpc';
const EVM_PIPE = 'https://dpay.kalaj.org/api/v1/evm/rpc';
const IRIS_V1 = 'https://iris-api.circle.com/v1/messages/5';
const JUP_API = 'https://lite-api.jup.ag';

const RAIL_SOL = 'BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX'; // sol-rail (SLIP-10 m/44'/501'/0'/0')
const ATA_USDC = '22HkLhnswJHre9qAZK4LZc5UV9HRFTWdABqmQJjpMT6Y';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const MT_PROGRAM = 'CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd'; // MessageTransmitter v1 (Solana)
const TM_PROGRAM = 'CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3'; // TokenMessengerMinter v1 (Solana)
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYS = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
// fixed v1 program accounts, read out of the live burn tx (see header):
const SENDER_AUTHORITY = 'X5rMYSBWMqeWULSdDKXXATBjqk9AJF8odHpYJYeYA9H';
const MESSAGE_TRANSMITTER = 'BWrwSWjbikT3H7qHAkUEbLmwDQoB4ZDJ4wcSEhSPTZCu';
const TOKEN_MESSENGER = 'Afgq3BHEfCE7d78D2XE9Bfyu2ieDqvE24xX8KDwreBms';
const REMOTE_TM_DOM0 = 'Hazwi3jFQtLKc2ughi7HFXPkpDeso7DQaMR9Ks4afh3j'; // data: domain 0 + 0x…bd3fa81b (Eth TokenMessenger v1)
const TOKEN_MINTER = 'DBD8hAwLDRQkTsu6EqviaYNGKPnsAMmQonxf7AH8ZcFY';
const LOCAL_TOKEN = '72bvEFk2Usi2uYc1SnaTNhBcQPc6tiJWXr9oKk7rkd4C';
const EVENT_AUTHORITY = 'CNfZLeeL4RUxwfPnjA3tLiQt4y43jp4V7bMpga673jf9';
const DFB_DISC = Buffer.from(createHash('sha256').update('global:deposit_for_burn').digest()).subarray(0, 8);
const RECLAIM_DISC = Buffer.from(createHash('sha256').update('global:reclaim_event_account').digest()).subarray(0, 8);

const EVM_RAIL = '0x18884BC8e867eEf401703b702097220bdAe27668';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MT_V1_ETH = '0x0a992d191DEeC32aFe36203Ad87D7d289a738F81'; // Circle docs v1 page, verified 2026-10-04
const MSG_FILE = '/tmp/opencode/cctp-v1-msg.json';

const die = (msg) => { console.error(`cctp-bridge: ${msg}`); process.exit(1); };
const b58d = (s) => Buffer.from(base58.decode(s));
const b58e = (b) => base58.encode(b);
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

async function solRpc(method, params) {
  const r = await (await fetch(SOL_PIPE, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})})).json();
  if (r.error) throw new Error(`sol ${method}: ${r.error.code} ${JSON.stringify(r.error.message).slice(0, 200)}`);
  return r.result;
}

// ── the rail keypair (SLIP-10 ed25519 m/44'/501'/0'/0' — mirrors app/solana/identity.ts) ────────
function hmacSha512(key, data) {
  const blockLen = 128;
  const normKey = key.length > blockLen ? Buffer.from(sha512(key)) : key;
  const inner = Buffer.alloc(blockLen + data.length);
  const outer = Buffer.alloc(blockLen + 64);
  const pad = Buffer.alloc(blockLen);
  pad.set(normKey);
  for (let i = 0; i < blockLen; i++) { inner[i] = pad[i] ^ 0x36; outer[i] = pad[i] ^ 0x5c; }
  inner.set(data, blockLen);
  outer.set(Buffer.from(sha512(inner)), blockLen);
  return Buffer.from(sha512(outer));
}
function deriveSolanaKeypair(secretHex) {
  const path = [44, 501, 0, 0].map((i) => i + 0x80000000);
  let it = hmacSha512(Buffer.from('ed25519 seed'), Buffer.from(secretHex, 'hex'));
  let priv = it.subarray(0, 32);
  for (const idx of path) {
    const data = Buffer.alloc(1 + 32 + 4);
    data[0] = 0; Buffer.from(priv).copy(data, 1); data.writeUInt32BE(idx, 33);
    it = hmacSha512(Buffer.from(it.subarray(32, 64)), data);
    priv = it.subarray(0, 32);
  }
  return {seed: Buffer.from(priv), pub: Buffer.from(ed25519.getPublicKey(priv))};
}
function railKeypair() {
  const seed = execFileSync('node', ['scripts/agent-key.mjs', 'seed'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: '/home/sat/projects/dpay/dpay-main'}).trim();
  if (!/^[0-9a-f]{64}$/i.test(seed)) die('agent-key seed did not return 64 hex chars - refusing');
  const kp = deriveSolanaKeypair(seed);
  seed.replace(/./g, '0');
  if (b58e(kp.pub) !== RAIL_SOL) die(`derived ${b58e(kp.pub)} != rail ${RAIL_SOL} - refusing`);
  return kp;
}

// ── legacy Solana tx codec (app/solana/tx.ts format, generalized to N instructions) ────────────
function encodeCompactU16(value) {
  const out = [];
  let rem = value;
  for (;;) { const b = rem & 0x7f; rem >>= 7; out.push(rem === 0 ? b : b | 0x80); if (rem === 0) return out; }
}
function buildLegacyMessage({signersWritable, signersReadonly, writable, readonly_, blockhash, instructions}) {
  const keys = [...signersWritable, ...signersReadonly, ...writable, ...readonly_];
  const idx = (k) => {
    const i = keys.indexOf(k);
    if (i < 0) die(`account ${k} not in key list`);
    return i;
  };
  const out = [];
  out.push(signersWritable.length + signersReadonly.length, signersReadonly.length, readonly_.length);
  out.push(...encodeCompactU16(keys.length));
  for (const k of keys) out.push(...b58d(k));
  out.push(...b58d(blockhash));
  out.push(...encodeCompactU16(instructions.length));
  for (const ins of instructions) {
    out.push(idx(ins.program));
    out.push(...encodeCompactU16(ins.accounts.length));
    for (const a of ins.accounts) out.push(idx(a));
    const data = ins.data ?? Buffer.alloc(0);
    out.push(...encodeCompactU16(data.length));
    for (const b of data) out.push(b);
  }
  return {message: Buffer.from(out), keys};
}
function signLegacyTx({message, keys, signers}) {
  const nSig = keys.filter((k) => signers.some((s) => s.pub.equals(b58d(k)))).length;
  const sigs = new Map();
  for (const s of signers) sigs.set(b58e(s.pub), Buffer.from(ed25519.sign(message, s.seed)));
  const ordered = keys.slice(0, nSig).map((k) => {
    const s = sigs.get(k);
    if (!s) die(`signer for ${k} missing`);
    return s;
  });
  return Buffer.concat([Buffer.from(encodeCompactU16(nSig)), ...ordered, message]);
}
function decodeUnsignedLegacyTx(base64) {
  const raw = Buffer.from(base64, 'base64');
  const rdCu = (buf, off) => { let v = 0, sh = 0, i = off; for (;;) { const b = buf[i++]; v += (b & 0x7f) * 2 ** sh; if ((b & 0x80) === 0) return {v, next: i}; sh += 7; } };
  const sc = rdCu(raw, 0);
  const msgStart = sc.next + sc.v * 64;
  const msg = raw.subarray(msgStart);
  let o = 0;
  const versioned = (msg[0] & 0x80) !== 0;
  const version = versioned ? msg[o++] & 0x7f : 'legacy';
  const header = {req: msg[o++], roSigned: msg[o++], roUnsigned: msg[o++]};
  const nk = rdCu(msg, o); o = nk.next;
  const keys = [];
  for (let i = 0; i < nk.v; i++) { keys.push(b58e(msg.subarray(o, o + 32))); o += 32; }
  const blockhash = b58e(msg.subarray(o, o + 32)); o += 32;
  const ni = rdCu(msg, o); o = ni.next;
  const instructions = [];
  for (let i = 0; i < ni.v; i++) {
    const progIdx = msg[o++];
    const na = rdCu(msg, o); o = na.next;
    const accounts = [];
    for (let j = 0; j < na.v; j++) accounts.push(keys[msg[o++]]);
    const nd = rdCu(msg, o); o = nd.next;
    instructions.push({program: keys[progIdx], accounts, data: Buffer.from(msg.subarray(o, o + nd.v))});
    o += nd.v;
  }
  return {versioned, version, header, keys, blockhash, instructions, messageBytes: Buffer.from(msg), sigCount: sc.v};
}

async function confirm(sig, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await solRpc('getTransaction', [sig, {encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed'}]).catch(() => null);
    if (r) {
      if (r.meta?.err) { console.log('logs:'); for (const l of r.meta.logMessages ?? []) console.log('  ', l.slice(0, 200)); die(`tx ${sig} FAILED on-chain: ${JSON.stringify(r.meta.err)}`); }
      return r;
    }
    const st = await solRpc('getSignatureStatuses', [[sig]]).catch(() => null);
    if (st?.value?.[0]?.err) die(`tx ${sig} failed: ${JSON.stringify(st.value[0].err)}`);
    if (Date.now() - t0 > timeoutMs) die(`tx ${sig} not confirmed in ${timeoutMs}ms - check explorer, DO NOT rebroadcast blind`);
    await new Promise((res) => setTimeout(res, 2000));
  }
}

async function sendAndConfirm(txBase64, label) {
  const sig = await solRpc('sendTransaction', [txBase64, {encoding: 'base64', skipPreflight: false}]);
  console.log(`[${label}] sent ${sig}`);
  const r = await confirm(sig);
  console.log(`[${label}] confirmed, fee ${r.meta.fee} lamports`);
  return sig;
}

async function solBalance(addr) {
  const r = await solRpc('getBalance', [addr, {commitment: 'confirmed'}]);
  return r.value;
}
async function ataBalance() {
  const r = await solRpc('getTokenAccountBalance', [ATA_USDC, {commitment: 'confirmed'}]);
  return BigInt(r.value.amount);
}

// ── subcommands ─────────────────────────────────────────────────────────────────────────────────

async function cmdTopup() {
  const kp = railKeypair();
  const amountRaw = 250000; // 0.25 USDC -> ~0.002 SOL; rent ~0.003 needed vs 0.0016 held
  const q = await (await fetch(`${JUP_API}/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${WSOL_MINT}&amount=${amountRaw}&slippageBps=200&restrictIntermediateVersion=strict`)).json();
  if (!q?.outAmount) die(`jupiter quote failed: ${JSON.stringify(q).slice(0, 300)}`);
  console.log(`[topup] quote: ${amountRaw} USDC -> ${Number(q.outAmount) / 1e9} SOL (route ${q.routePlan?.length} hops)`);
  const swap = await (await fetch(`${JUP_API}/swap/v1/swap`, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({quoteResponse: q, userPublicKey: RAIL_SOL, wrapAndUnwrapSol: true})})).json();
  if (!swap?.swapTransaction) die(`jupiter swap failed: ${JSON.stringify(swap).slice(0, 300)}`);
  const tx = decodeUnsignedLegacyTx(swap.swapTransaction);
  if (tx.keys[0] !== RAIL_SOL) die(`jupiter tx fee payer ${tx.keys[0]} != rail - refusing`);
  if (tx.header.req !== 1) die(`jupiter tx needs ${tx.header.req} signers - refusing (expected exactly the rail)`);
  if (!tx.keys.includes(ATA_USDC)) die('my USDC ATA not among the tx static keys - refusing to sign blind');
  console.log(`[topup] tx: version ${tx.version}, ${tx.instructions.length} instructions, ${tx.keys.length} static keys, ALT-present=${tx.versioned}`);
  // sign the venue's message bytes VERBATIM (legacy or v0 — opaque bytes, never rebuilt)
  const wire = Buffer.concat([Buffer.from(encodeCompactU16(1)), ed25519.sign(tx.messageBytes, kp.seed), tx.messageBytes]);
  await sendAndConfirm(Buffer.from(wire).toString('base64'), 'topup');
  console.log(`[topup] SOL balance now ${await solBalance(RAIL_SOL)} lamports; USDC ${await ataBalance()}`);
}
// re-serializing the venue's tx is forbidden — the message bytes are signed VERBATIM above.

async function cmdBurn() {
  const kp = railKeypair();
  const balance = await ataBalance();
  if (balance < 1_000_000n) die(`ATA balance ${balance} too small - refusing`);
  const amount = balance; // burn ALL: v1 has no dust constraint, destination = exact same amount
  const sol = await solBalance(RAIL_SOL);
  if (sol < 2_400_000) die(`rail SOL ${sol} lamports < ~2.4M needed for event-account rent + fee - run topup first`);
  // fresh uninitialized non-PDA address for the MessageSent event account
  const eventKp = {seed: (await import('node:crypto')).randomBytes(32)};
  eventKp.pub = Buffer.from(ed25519.getPublicKey(eventKp.seed));
  const eventAddr = b58e(eventKp.pub);
  const existing = await solRpc('getAccountInfo', [eventAddr, {encoding: 'base64'}]);
  if (existing.value !== null) die('fresh event keypair already exists on chain - regenerate');

  const mintRecipient = Buffer.concat([Buffer.alloc(12), Buffer.from(EVM_RAIL.slice(2).toLowerCase(), 'hex')]);
  if (mintRecipient.length !== 32) die('mintRecipient not 32 bytes');
  const args = Buffer.concat([DFB_DISC, u64le(amount), u32le(0), mintRecipient]); // domain 0 = Ethereum
  const keys = {
    signersWritable: [RAIL_SOL, eventAddr], // event_rent_payer + message_sent_event_data (owner == rent payer here)
    signersReadonly: [],
    writable: [ATA_USDC, MESSAGE_TRANSMITTER, LOCAL_TOKEN, USDC_MINT],
    readonly_: [COMPUTE_BUDGET, SENDER_AUTHORITY, TOKEN_MESSENGER, REMOTE_TM_DOM0, TOKEN_MINTER, MT_PROGRAM, TM_PROGRAM, SPL, SYS, EVENT_AUTHORITY],
  };
  const blockhashRes = await solRpc('getLatestBlockhash', [{commitment: 'finalized'}]);
  const {message, keys: allKeys} = buildLegacyMessage({
    ...keys, blockhash: blockhashRes.value.blockhash,
    instructions: [
      {program: COMPUTE_BUDGET, accounts: [], data: Buffer.concat([Buffer.from([3]), u64le(30000)])}, // priority fee 30k microlamports
      {program: COMPUTE_BUDGET, accounts: [], data: Buffer.concat([Buffer.from([2]), u32le(300_000)])}, // CU limit
      {program: TM_PROGRAM, accounts: [
        RAIL_SOL, RAIL_SOL, SENDER_AUTHORITY, ATA_USDC, MESSAGE_TRANSMITTER, TOKEN_MESSENGER,
        REMOTE_TM_DOM0, TOKEN_MINTER, LOCAL_TOKEN, USDC_MINT, eventAddr,
        MT_PROGRAM, TM_PROGRAM, SPL, SYS, EVENT_AUTHORITY, TM_PROGRAM, // event_cpi: [authority, program]
      ], data: args},
    ],
  });
  // account-index sanity: every referenced index resolves to the right key
  const dfb = {accounts: [RAIL_SOL, RAIL_SOL, SENDER_AUTHORITY, ATA_USDC, MESSAGE_TRANSMITTER, TOKEN_MESSENGER, REMOTE_TM_DOM0, TOKEN_MINTER, LOCAL_TOKEN, USDC_MINT, eventAddr, MT_PROGRAM, TM_PROGRAM, SPL, SYS, EVENT_AUTHORITY, TM_PROGRAM]};
  dfb.accounts.forEach((a, i) => { if (!allKeys.includes(a)) die(`DFB account ${i} ${a} missing from key list`); });
  const raw = signLegacyTx({message, keys: allKeys, signers: [kp, eventKp]});
  const txBase64 = Buffer.from(raw).toString('base64');
  // SIM FIRST — never broadcast un-simulated calldata (float rule)
  const sim = await solRpc('simulateTransaction', [txBase64, {encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed'}]);
  if (sim.value?.err) {
    console.log('logs:'); for (const l of sim.value.logs ?? []) console.log('  ', l.slice(0, 220));
    die(`simulation FAILED: ${JSON.stringify(sim.value.err)} - nothing broadcast`);
  }
  console.log(`[burn] sim OK: CU consumed ${sim.value.unitsConsumed}, logs ${sim.value.logs?.length}`);
  for (const l of sim.value.logs ?? []) console.log('  ', l.slice(0, 160));
  console.log(`[burn] burning ${amount} USDC -> EVM ${EVM_RAIL} (domain 0); event account ${eventAddr}`);
  if (!process.argv.includes('--go')) { console.log('[burn] DRY RUN (add --go to broadcast)'); return; }
  const sig = await sendAndConfirm(txBase64, 'burn');
  writeFileSync('/tmp/opencode/cctp-v1-burn.json', JSON.stringify({sig, eventAccount: eventAddr, amount: amount.toString(), at: new Date().toISOString()}, null, 2));
  console.log(`[burn] BURN_SIG=${sig}`);
  console.log(`[burn] next: node scripts/cctp-sol-eth-bridge.mjs attest ${sig}`);
}

async function cmdAttest(sig) {
  if (!sig) {
    if (!existsSync('/tmp/opencode/cctp-v1-burn.json')) die('no burn sig arg and no /tmp/opencode/cctp-v1-burn.json');
    sig = JSON.parse(readFileSync('/tmp/opencode/cctp-v1-burn.json')).sig;
  }
  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`${IRIS_V1}/${sig}`);
    if (res.ok) {
      const body = await res.json();
      const m = body.messages?.[0];
      if (m?.attestation && m.attestation !== 'PENDING') {
        writeFileSync(MSG_FILE, JSON.stringify({sig, message: m.message, attestation: m.attestation, nonce: m.eventNonce, fetchedAt: new Date().toISOString()}, null, 2));
        console.log(`[attest] COMPLETE after ${Math.round((Date.now() - t0) / 1000)}s: nonce ${m.eventNonce}, message ${m.message.slice(0, 42)}…, attestation ${m.attestation.slice(0, 24)}…`);
        console.log(`[attest] next: node scripts/cctp-sol-eth-bridge.mjs receive`);
        return;
      }
    }
    process.stdout.write(`[attest] ${Math.round((Date.now() - t0) / 1000)}s ${res.status} ${res.status === 404 ? '(no attestation yet)' : ''}\r`);
    if (Date.now() - t0 > 40 * 60_000) die(`attestation not available after 40 min - record as unknown, do NOT rebroadcast`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function cmdReceive() {
  if (!existsSync(MSG_FILE)) die(`no ${MSG_FILE} - run attest first`);
  const {message, attestation, nonce} = JSON.parse(readFileSync(MSG_FILE, 'utf8'));
  const seed = execFileSync('node', ['scripts/agent-key.mjs', 'seed'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: '/home/sat/projects/dpay/dpay-main'}).trim();
  if (!/^[0-9a-f]{64}$/i.test(seed)) die('bad seed');
  const rail = deriveEvmKeypair(seed);
  seed.replace(/./g, '0');
  if (eip55(rail.address) !== eip55(EVM_RAIL)) die(`derived ${rail.address} != EVM rail - refusing`);
  const msgBytes = Buffer.from(message.replace(/^0x/, ''), 'hex');
  const attBytes = Buffer.from(attestation.replace(/^0x/, ''), 'hex');
  console.log(`[receive] message ${msgBytes.length}B, attestation ${attBytes.length}B, nonce ${nonce}`);
  // decode the message header for the honest printout — v1 wire: version u32 @0, sourceDomain u32
  // @4, destinationDomain u32 @8, nonce u64 @12, sender 32B @20, recipient 32B @52, destCaller @84,
  // body @116 (BurnMessage: … mintRecipient 32B, amount u256 tail)
  const srcDom = msgBytes.readUInt32BE(4), dstDom = msgBytes.readUInt32BE(8);
  // BurnMessage body (solana-cctp-contracts burn_message.rs, 132B): version u32 @0, burnToken 32B
  // @4, mintRecipient 32B @36, amount u64 BE written into a 32B field @68 (so @92), sender 32B @100.
  const BODY = 116; // 4+4+4+8+32+32+32 header
  const bodyMintRecipient = '0x' + msgBytes.subarray(BODY + 36, BODY + 68).toString('hex');
  const bodyAmount = BigInt('0x' + msgBytes.subarray(BODY + 92, BODY + 100).toString('hex'));
  console.log(`[receive] body: mintRecipient ${bodyMintRecipient}, amount ${bodyAmount} raw`);
  const recipient = '0x' + bodyMintRecipient.slice(-40); // strip the bytes32 left-padding
  console.log(`[receive] srcDomain ${srcDom} -> dstDomain ${dstDom}, mintRecipient ${recipient}`);
  if (srcDom !== 5 || dstDom !== 0) die('message domains are not Solana->Ethereum - refusing');
  if (recipient.toLowerCase() !== EVM_RAIL.toLowerCase()) die('message mintRecipient != rail - refusing');
  const data = '0x' + Buffer.from(keccak_256(Buffer.from('receiveMessage(bytes,bytes)'))).subarray(0, 4).toString('hex')
    + word32(0x40) + word32(0x40 + 32 + Math.ceil(msgBytes.length / 32) * 32)
    + word32(msgBytes.length) + msgBytes.toString('hex') + '0'.repeat((Math.ceil(msgBytes.length / 32) * 32 - msgBytes.length) * 2)
    + word32(attBytes.length) + attBytes.toString('hex') + '0'.repeat((Math.ceil(attBytes.length / 32) * 32 - attBytes.length) * 2);
  // preflight: USDC balance before + gas estimate (free)
  const balBefore = BigInt(await ethCall(EVM_PIPE, USDC_ETH, '0x70a08231' + rail.address.replace(/^0x/, '').toLowerCase().padStart(64, '0'), {timeoutMs: 20_000}));
  console.log(`[receive] USDC before: ${balBefore}`);
  const est = await rpc(EVM_PIPE, 'eth_estimateGas', [{from: rail.address, to: MT_V1_ETH, data}, 'latest'], {timeoutMs: 30_000});
  const gas = BigInt(est);
  console.log(`[receive] eth_estimateGas: ${gas}`);
  if (gas > 400_000n) die(`estimate ${gas} > 400k - investigate before signing`);
  const nonceTx = BigInt(await rpc(EVM_PIPE, 'eth_getTransactionCount', [rail.address, 'pending'], {timeoutMs: 20_000}));
  const head = await rpc(EVM_PIPE, 'eth_getBlockByNumber', ['latest', false], {timeoutMs: 20_000});
  const base = BigInt(head.baseFeePerGas);
  const tip = 10_000_000n; // 0.01 gwei
  const maxFee = base * 4n + tip;
  const eth = BigInt(await rpc(EVM_PIPE, 'eth_getBalance', [rail.address, 'latest'], {timeoutMs: 20_000}));
  if (gas * (base + tip) + 0n > eth) die(`gas ${gas}x${base + tip} wei exceeds balance ${eth} - stop`);
  const {rawTx, txHash} = signEip1559({privHex: rail.privateKeyHex, chainId: 1n, nonce: nonceTx, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, gasLimit: gas + 60_000n, to: MT_V1_ETH, value: 0n, data});
  console.log(`[receive] sending (base ${Number(base) / 1e9} gwei, maxFee ${Number(maxFee) / 1e9})...`);
  await sendRawRpc(EVM_PIPE, rawTx, {timeoutMs: 30_000});
  const t0 = Date.now();
  for (;;) {
    const rec = await rpc(EVM_PIPE, 'eth_getTransactionReceipt', [txHash], {timeoutMs: 20_000}).catch(() => null);
    if (rec) {
      const status = BigInt(rec.status);
      const balAfter = BigInt(await ethCall(EVM_PIPE, USDC_ETH, '0x70a08231' + rail.address.replace(/^0x/, '').toLowerCase().padStart(64, '0'), {timeoutMs: 20_000}));
      console.log(`[receive] status ${status} block ${BigInt(rec.blockNumber)} gasUsed ${BigInt(rec.gasUsed)}`);
      console.log(`[receive] USDC ${balBefore} -> ${balAfter} (delta ${balAfter - balBefore})`);
      if (status !== 1n) die('receiveMessage REVERTED - ledger the burned gas, do NOT retry unchanged');
      if (balAfter - balBefore !== BigInt(bodyAmount)) die('USDC delta != message amount - investigate');
      console.log(`[receive] PASS tx=${txHash}`);
      return;
    }
    if (Date.now() - t0 > 180_000) die(`receipt for ${txHash} never landed in 180s - record as unknown, DO NOT rebroadcast`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const word32 = (n) => BigInt(n).toString(16).padStart(64, '0');

async function cmdReclaim() {
  const kp = railKeypair();
  const burn = JSON.parse(readFileSync('/tmp/opencode/cctp-v1-burn.json', 'utf8'));
  const {attestation} = JSON.parse(readFileSync(MSG_FILE, 'utf8'));
  const attBytes = Buffer.from(attestation.replace(/^0x/, ''), 'hex');
  const solBefore = await solBalance(RAIL_SOL);
  const blockhashRes = await solRpc('getLatestBlockhash', [{commitment: 'finalized'}]);
  const {message, keys} = buildLegacyMessage({
    signersWritable: [RAIL_SOL], signersReadonly: [],
    writable: [MESSAGE_TRANSMITTER, burn.eventAccount],
    readonly_: [MT_PROGRAM, SYS],
    blockhash: blockhashRes.value.blockhash,
    instructions: [{program: MT_PROGRAM, accounts: [RAIL_SOL, MESSAGE_TRANSMITTER, burn.eventAccount],
      data: Buffer.concat([RECLAIM_DISC, u32le(attBytes.length), attBytes])}],
  });
  const raw = signLegacyTx({message, keys, signers: [kp]});
  const txBase64 = Buffer.from(raw).toString('base64');
  const sim = await solRpc('simulateTransaction', [txBase64, {encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed'}]);
  if (sim.value?.err) { for (const l of sim.value.logs ?? []) console.log('  ', l.slice(0, 200)); die(`reclaim sim FAILED: ${JSON.stringify(sim.value.err)}`); }
  console.log(`[reclaim] sim OK`);
  if (!process.argv.includes('--go')) { console.log('[reclaim] DRY RUN'); return; }
  await sendAndConfirm(txBase64, 'reclaim');
  console.log(`[reclaim] SOL ${solBefore} -> ${await solBalance(RAIL_SOL)} lamports`);
}

const CMDS = {topup: cmdTopup, burn: cmdBurn, attest: cmdAttest, receive: cmdReceive, reclaim: cmdReclaim};
const cmd = process.argv[2];
if (!CMDS[cmd]) die(`usage: cctp-sol-eth-bridge.mjs <${Object.keys(CMDS).join('|')}> [args] [--go]`);
await CMDS[cmd](process.argv[3]);
