// Driver-side CCTP V2 Solana claim (2026-09-21). The app's WithHook burn lane routes through
// Circle's Forwarding Service, whose fee (~0.315 USDC) exceeds the agent float's burn size, so
// the live Route-B proof burns PLAIN depositForBurn from the evm-float key and THIS script
// executes the destination-side receiveMessage with the SOL rail key — the mission's sanctioned
// fallback. Every derived account is verified ON-CHAIN before any signature (a wrong PDA
// derivation yields a null account => refuse). NEVER prints keys.
//
// Usage:
//   node e2e/harness/cctp-claim.mjs status <eth-burn-tx-hash>  — fetch message+attestation, parse,
//                                                                verify every PDA on-chain
//   node e2e/harness/cctp-claim.mjs claim <eth-burn-tx-hash>   — build, sign, send receiveMessage
//   node e2e/harness/cctp-claim.mjs balance                    — USDC balance at the rail ATA
import {execFileSync} from 'node:child_process';
import {createHash, createHmac} from 'node:crypto';
import {ed25519} from '@noble/curves/ed25519';
import {ExtendedPoint} from '@noble/curves/ed25519';
import {bs58Encode} from './soltx.mjs';

const RPC = process.env.DPAY_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const IRIS = 'https://iris-api.circle.com';

// V2 mainnet programs (developers.circle.com/cctp/references/solana-programs, Solana = domain 5).
const MT_PROGRAM = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'; // MessageTransmitterV2
const TM_PROGRAM = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe'; // TokenMessengerMinterV2
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_ERC20 = 'A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

// --- base58 -----------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Decode(s) {
  let num = 0n;
  for (const c of s) {
    const idx = B58.indexOf(c);
    if (idx < 0) throw new Error(`bad base58 char ${c}`);
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) { bytes.unshift(Number(num % 256n)); num /= 256n; }
  let zeros = 0;
  for (const c of s) { if (c === '1') zeros++; else break; }
  return new Uint8Array([...Array(zeros).fill(0), ...bytes]);
}
const b32 = (b58) => { const b = bs58Decode(b58); if (b.length !== 32) throw new Error(`not 32 bytes: ${b58}`); return b; };
const enc = new TextEncoder();

// --- async rpc --------------------------------------------------------------
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
  });
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error).slice(0, 400)}`);
  return j.result;
}
const accountInfo = async (addr) =>
  (await rpc('getAccountInfo', [addr, {encoding: 'base64'}])).value;

// --- PDA derivation (solana findProgramAddress) ------------------------------
function sha256b(...chunks) {
  const h = createHash('sha256');
  for (const c of chunks) h.update(c);
  return new Uint8Array(h.digest());
}
const offCurve = (b32arr) => { try { ExtendedPoint.fromHex(Buffer.from(b32arr).toString('hex')); return false; } catch { return true; } };
function findPda(programIdB58, seeds) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256b(...seeds, new Uint8Array([bump]), b32(programIdB58));
    if (offCurve(h)) return {address: bs58Encode(h), bump};
  }
  throw new Error('no pda found');
}

// --- sol rail key (SLIP-10 ed25519 m/44'/501'/0'/0' from the IC float seed) --
function loadRail() {
  const env = {...process.env, SOPS_AGE_KEY_FILE: process.env.SOPS_AGE_KEY_FILE || '.dev/age/agent-key.txt'};
  const hex = execFileSync('node', ['scripts/agent-key.mjs', 'seed'], {env, cwd: process.cwd()}).toString().trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('float seed: unexpected shape from agent-key.mjs seed');
  const seed = Buffer.from(hex, 'hex');
  const mac = (key, data) => createHmac('sha512', key).update(data).digest();
  const I = mac(enc.encode('ed25519 seed'), seed);
  let k = new Uint8Array(I.slice(0, 32)), c = new Uint8Array(I.slice(32));
  for (const idx of [44, 501, 0, 0]) {
    const data = Buffer.concat([Buffer.from([0]), Buffer.from(k), Buffer.from(Uint32Array.of(0x80000000 | idx).buffer)]);
    const d = mac(c, data);
    k = new Uint8Array(d.slice(0, 32)); c = new Uint8Array(d.slice(32));
  }
  const pub = ed25519.getPublicKey(k);
  return {secret64: new Uint8Array([...k, ...pub]), pub, address: bs58Encode(pub)};
}

// --- CCTP message fetch + parse ---------------------------------------------
async function fetchMessage(txHash) {
  const u = `${IRIS}/v2/messages/0?transactionHash=${txHash}`;
  const r = await fetch(u);
  if (r.status === 404) throw new Error('message not attested yet (404) — retry later');
  if (!r.ok) throw new Error(`iris ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const m = j.messages?.[0];
  if (!m?.attestation || m.attestation === 'PENDING') throw new Error(`attestation pending (status=${m?.status})`);
  return m; // {message, attestation, status, ...}
}
function parseMessage(hexMsg) {
  const b = Buffer.from(hexMsg.replace(/^0x/, ''), 'hex');
  if (b.length < 148) throw new Error(`message too short: ${b.length}`);
  const u32 = (o) => b.readUInt32BE(o);
  const f32 = (o) => new Uint8Array(b.subarray(o, o + 32));
  const msg = {
    version: u32(0), sourceDomain: u32(4), destinationDomain: u32(8),
    nonce: f32(12), sender: f32(44), recipient: f32(76), destinationCaller: f32(108),
    minFinality: u32(140), fte: u32(144), body: new Uint8Array(b.subarray(148)),
    raw: b,
  };
  return msg;
}
function parseBurnBody(body) {
  // V1/V2 BurnMessage: version u32 | burnMessageLength u32 | burnToken 32 | mintRecipient 32 | amount u64
  const v = Buffer.from(body).readUInt32BE(0);
  const len = Buffer.from(body).readUInt32BE(4);
  const bb = body.subarray(8, 8 + len);
  return {
    version: v,
    burnToken: Buffer.from(bb.subarray(0, 32)).toString('hex'),
    mintRecipient: bs58Encode(bb.subarray(32, 64)),
    amount: BigInt(`0x${Buffer.from(bb.subarray(64, 72)).toString('hex')}`),
  };
}

// --- claim account census -----------------------------------------------------
async function resolveAccounts(msg, rail) {
  const owner = rail.pub;
  const ataSeeds = [owner, b32(TOKEN_PROGRAM), b32(USDC_MINT)];
  const found = {};
  const must = async (name, addr, why) => {
    const info = await accountInfo(addr);
    if (info == null) throw new Error(`account ${name} (${addr}) NOT FOUND on-chain — ${why}`);
    found[name] = {addr, dataLen: info.data.length, owner: info.owner};
    return addr;
  };
  found.payer = rail.address;
  found.caller = rail.address;
  const ata = findPda(ATA_PROGRAM, ataSeeds).address;
  await must('user_token_account', ata, 'the recipient USDC ATA must exist (create it first)');
  await must('authority_pda', findPda(MT_PROGRAM, [enc.encode('message_transmitter_authority'), b32(TM_PROGRAM)]).address, 'MT authority PDA');
  // config: try documented seed candidates; fall back to the used_nonce seed for reference.
  let config = null;
  for (const seeds of [
    [enc.encode('message_transmitter')],
    [enc.encode('message_transmitter'), Buffer.from([5, 0, 0, 0])],
    [enc.encode('message_transmitter'), Buffer.from([0, 0, 0, 5])],
    [enc.encode('message_transmitter_config')],
  ]) {
    const cand = findPda(MT_PROGRAM, seeds).address;
    if (await accountInfo(cand) != null) { config = cand; break; }
  }
  if (config == null) throw new Error('message_transmitter config not found by any seed candidate');
  found.message_transmitter = {addr: config};
  const usedNonce = findPda(MT_PROGRAM, [enc.encode('used_nonce'), msg.nonce]).address;
  found.used_nonce = {addr: usedNonce, expectNull: true, exists: (await accountInfo(usedNonce)) != null};
  found.receiver = TM_PROGRAM;
  await must('token_messenger', findPda(TM_PROGRAM, [enc.encode('token_messenger')]).address, 'TM token_messenger PDA');
  let remote = null;
  for (const d of [Buffer.from([0, 0, 0, 0]) /* sourceDomain=0 both orders identical */]) {
    remote = findPda(TM_PROGRAM, [enc.encode('remote_token_messenger'), d]).address;
  }
  await must('remote_token_messenger', remote, 'TM remote_token_messenger for source domain 0');
  await must('token_minter', findPda(TM_PROGRAM, [enc.encode('token_minter')]).address, 'TM token_minter PDA');
  await must('local_token', findPda(TM_PROGRAM, [enc.encode('local_token'), b32(USDC_MINT)]).address, 'TM local_token PDA for USDC');
  let pair = null;
  for (const dom of [Buffer.from([0, 0, 0, 0])]) {
    for (const tok of [new Uint8Array(Buffer.from(USDC_ERC20.replace(/^0x/, '').padStart(64, '0'), 'hex'))]) {
      const cand = findPda(TM_PROGRAM, [enc.encode('token_pair'), dom, tok]).address;
      if (await accountInfo(cand) != null) { pair = cand; break; }
    }
  }
  if (pair == null) throw new Error('token_pair PDA not found (USDC eth->sol pair)');
  found.token_pair = {addr: pair};
  await must('custody', findPda(TM_PROGRAM, [enc.encode('custody'), b32(USDC_MINT)]).address, 'TM custody PDA for USDC');
  found.event_authority = findPda(MT_PROGRAM, [enc.encode('__event_authority')]).address;
  found.tm_event_authority = findPda(TM_PROGRAM, [enc.encode('__event_authority')]).address;
  return found;
}

const ACCOUNT_ORDER = [
  // [key, writable, signer]
  ['payer', true, true],
  ['caller', false, true],
  ['authority_pda', false, false],
  ['message_transmitter', false, false],
  ['used_nonce', true, false],
  ['receiver', false, false],
  ['system', false, false],
  ['event_authority', false, false],
  ['MT_PROGRAM', false, false],
  ['token_messenger', false, false],
  ['remote_token_messenger', false, false],
  ['token_minter', true, false],
  ['local_token', true, false],
  ['token_pair', false, false],
  ['user_token_account', true, false],
  ['custody', true, false],
  ['TOKEN_PROGRAM', false, false],
  ['tm_event_authority', false, false],
  ['TM_PROGRAM', false, false],
];
const CONST = {system: SYSTEM_PROGRAM, MT_PROGRAM, TM_PROGRAM, TOKEN_PROGRAM};

function buildIxAccounts(a) {
  return ACCOUNT_ORDER.map(([name, writable, signer]) => {
    const key = CONST[name] ?? a[name].addr ?? a[name];
    if (typeof key !== 'string') throw new Error(`account ${name} unresolved`);
    return {pubkey: key, writable, signer};
  });
}

// --- tx build + sign ----------------------------------------------------------
function borshVec(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}
function buildClaimIx(msg, attestation) {
  const disc = sha256b(enc.encode('global:receive_message')).slice(0, 8);
  return new Uint8Array([...disc, ...borshVec(msg.raw), ...borshVec(attestation)]);
}
function cuIx(kind, value) {
  if (kind === 'limit') { const d = new Uint8Array(5); d[0] = 2; new DataView(d.buffer).setUint32(1, value, true); return d; }
  const d = new Uint8Array(9); d[0] = 3; new DataView(d.buffer).setBigUint64(1, BigInt(value), true); return d;
}
async function buildAndSign(rail, msg, attestation, a) {
  const {value: bh} = await rpc('getLatestBlockhash', [{commitment: 'confirmed'}]);
  const keys = buildIxAccounts(a);
  const instructions = [
    {programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Buffer.from(cuIx('limit', 300_000)).toString('base64')},
    {programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Buffer.from(cuIx('price', 20_000)).toString('base64')},
    {programId: MT_PROGRAM, accounts: keys.map((k) => ({pubkey: k.pubkey, isWritable: k.writable, isSigner: k.signer})), data: Buffer.from(buildClaimIx(msg, attestation)).toString('base64')},
  ];
  const roUnsigned = keys.filter((k) => !k.signer && !k.writable).length;
  const header = [keys.length ? keys.filter((k) => k.signer).length : 0, 1, roUnsigned];
  const message = Buffer.concat([
    Buffer.from(header), Buffer.from(bs58Decode(bh)),
    Buffer.from([instructions.length]),
    ...instructions.map((ix) => {
      const idx = ix.accounts.map((acc) => keys.findIndex((k) => k.pubkey === acc.pubkey));
      const progIdx = keys.findIndex((k) => k.pubkey === ix.programId);
      const head = Buffer.alloc(1 + 1 + ix.accounts.length);
      head[0] = progIdx; head[1] = ix.accounts.length;
      ix.accounts.forEach((acc, i) => { head[2 + i] = idx[i]; });
      const dl = Buffer.alloc(2); new DataView(dl.buffer).setUint16(0, ix.data.length, true);
      return Buffer.concat([head, dl, Buffer.from(ix.data, 'base64')]);
    }),
  ]);
  const sig = ed25519.sign(new Uint8Array(message), rail.secret64);
  const signers = keys.filter((k) => k.signer).length;
  const tx = Buffer.concat([
    Buffer.from(Uint16Array.of(signers).buffer),
    ...Array.from({length: signers}, () => Buffer.from(sig)),
    message,
  ]);
  return {txBase64: tx.toString('base64'), blockhash: bh};
}

async function ataBalance(ata) {
  try {
    const r = await rpc('getTokenAccountBalance', [ata]);
    return r.value;
  } catch { return null; }
}

// --- main ---------------------------------------------------------------------
const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  const [cmd, txHash] = process.argv.slice(2);
  try {
    const rail = loadRail();
    log(`rail: ${rail.address}`);
    if (cmd === 'balance') {
      const ata = findPda(ATA_PROGRAM, [rail.pub, b32(TOKEN_PROGRAM), b32(USDC_MINT)]).address;
      const bal = await ataBalance(ata);
      console.log(JSON.stringify({ata, ...bal}, null, 2));
    } else if (cmd === 'status' || cmd === 'claim') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? '')) throw new Error('usage: cctp-claim.mjs status|claim <0xtxhash>');
      const m = await fetchMessage(txHash);
      const msg = parseMessage(m.message);
      const att = new Uint8Array(Buffer.from(m.attestation.replace(/^0x/, ''), 'hex'));
      const burn = parseBurnBody(msg.body);
      log(`message: v${msg.version} src=${msg.sourceDomain} dst=${msg.destinationDomain} minFinality=${msg.minFinality} fte=${msg.fte} status=${m.status}`);
      log(`burn: token=0x${burn.burnToken} mintRecipient=${burn.mintRecipient} amount=${burn.amount} subunits`);
      if (msg.sourceDomain !== 0 || msg.destinationDomain !== 5) throw new Error('message is not eth->sol');
      if (msg.recipient.join() !== b32(TM_PROGRAM).join()) throw new Error('recipient is not TokenMessengerMinterV2');
      if (msg.destinationCaller.some((x) => x !== 0)) throw new Error('destinationCaller set — not permissionless');
      if (burn.burnToken !== USDC_ERC20.toLowerCase().replace(/^0x/, '')) throw new Error('burn token is not mainnet USDC');
      if (burn.amount <= 0n) throw new Error('zero amount');
      const a = await resolveAccounts(msg, rail);
      log('account census: ' + JSON.stringify(a, null, 2));
      if (cmd === 'status') {
        const ata = a.user_token_account.addr;
        log(`pre-claim USDC at rail ATA: ${JSON.stringify(await ataBalance(ata))}`);
        console.log('STATUS OK — ready to claim');
      } else {
        const balBefore = await ataBalance(a.user_token_account.addr);
        const {txBase64, blockhash} = await buildAndSign(rail, msg, att, a);
        log(`signing OK — blockhash ${blockhash}, tx ${txBase64.length} b64 bytes; sending…`);
        const sig = await rpc('sendTransaction', [txBase64, {encoding: 'base64', skipPreflight: false, maxRetries: 3}]);
        log(`sent: ${sig}`);
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const st = await rpc('getSignatureStatuses', [[sig], {searchTransactionHistory: true}]);
          const s = st.value[0];
          if (s != null) {
            if (s.err) { console.log(`CLAIM FAILED ON-CHAIN: ${JSON.stringify(s.err)}`); process.exit(3); }
            log(`confirmed at slot ${s.slot}, CU ${s.unitCount}`);
            break;
          }
        }
        const balAfter = await ataBalance(a.user_token_account.addr);
        log(`post-claim USDC at rail ATA: ${JSON.stringify(balAfter)}`);
        console.log(JSON.stringify({signature: sig, before: balBefore?.uiAmount, after: balAfter?.uiAmount}, null, 2));
      }
    } else {
      console.log('unknown command — see header');
      process.exit(2);
    }
  } catch (e) {
    console.error(`cctp-claim FAILED: ${String(e).slice(0, 600)}`);
    process.exit(1);
  }
}
