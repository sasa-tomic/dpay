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
import {ed25519 as nobleEd25519} from '@noble/curves/ed25519';
import {bs58Encode} from './soltx.mjs';
import {deriveSolanaKeypair} from './jupiter.mjs';
import {getProgramDerivedAddress} from '../../app/node_modules/@solana/addresses/dist/index.node.mjs';
const sha256b = (...chunks) => { const h = createHash('sha256'); for (const c of chunks) h.update(c); return new Uint8Array(h.digest()); };

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
const log = (...a) => console.log('[cctp-claim]', ...a);
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
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error).slice(0, 400)} params=${JSON.stringify(params).slice(0, 200)}`);
  return j.result;
}
const accountInfo = async (addr) => {
  if (addr == null) throw new Error(`accountInfo(null) — caller bug`);
  log(`lookup ${addr}`);
  return (await rpc('getAccountInfo', [addr, {encoding: 'base64'}])).value;
};

// --- PDA derivation (canonical: @solana/addresses getProgramDerivedAddress — the same
// dependency the app's SOL rail uses; a hand-rolled sha256+off-curve check disagreed with the
// chain and was removed) ------------------------------------------------------
// @solana/addresses lives in the APP's node_modules (the SOL rail's own dependency) — the
// harness tree does not ship it; import it by the relative package path.
async function findPda(programIdB58, seeds) {
  // strings are utf8 seeds, Uint8Arrays pass through as raw bytes
  const norm = seeds.map(x => typeof x === 'string' ? enc.encode(x) : new Uint8Array(x));
  const [addr, bump] = await getProgramDerivedAddress({programAddress: programIdB58, seeds: norm});
  return {address: addr, bump};
}

// --- sol rail key: CANONICAL derivation (e2e/harness/jupiter.mjs deriveSolanaKeypair — the
// mirror of app/solana/identity.ts). A hand-rolled SLIP-10 here derived a DIFFERENT key (the
// first ed25519 level hashes the SERIALIZED key, not the seed); never re-derive what already
// has one proven implementation. The result is asserted against the registered rail address.
function loadRail() {
  const env = {...process.env, SOPS_AGE_KEY_FILE: process.env.SOPS_AGE_KEY_FILE || '.dev/age/agent-key.txt'};
  const hex = execFileSync('node', ['scripts/agent-key.mjs', 'seed'], {env, cwd: process.cwd()}).toString().trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('float seed: unexpected shape from agent-key.mjs seed');
  const rail = deriveSolanaKeypair(hex);
  return {seed: rail.seed, secret64: new Uint8Array([...rail.seed, ...rail.publicKey]), pub: rail.publicKey, address: rail.address};
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
  // BurnMessageV2 layout — version u32 @0, then seven bytes32/u256 fields; verified against
  // REAL mainnet messages AND Circle's documented offsets (messageSender@100, maxFee@132,
  // feeExecuted@164, expirationBlock@196): burnToken@4 | mintRecipient@36 (a RAW 32-byte
  // Solana pubkey when dst=5) | amount u256 @68 | messageSender@100 | maxFee@132 |
  // feeExecuted@164 | expirationBlock@196. Body is exactly 228 bytes when hookData is empty.
  const b = Buffer.from(body);
  if (b.length < 100) throw new Error(`burn body too short: ${b.length}`);
  return {
    version: b.readUInt32BE(0),
    burnToken: b.subarray(4, 36).toString('hex'),
    mintRecipient: bs58Encode(b.subarray(36, 68)),
    amount: BigInt(`0x${b.subarray(68, 100).toString('hex')}`),
    maxFee: BigInt(`0x${b.subarray(132, 164).toString('hex')}`),
  };
}

// --- claim account census -----------------------------------------------------
async function resolveAccounts(msg, rail, userTokenAccount) {
  const owner = rail.pub;
  const found = {};
  const must = async (name, addr, why) => {
    const info = await accountInfo(addr);
    if (info == null) throw new Error(`account ${name} (${String(addr)} type=${typeof addr}) NOT FOUND on-chain — ${why}`);
    found[name] = {addr, dataLen: info.data.length, owner: info.owner};
    return addr;
  };
  found.payer = rail.address;
  found.caller = rail.address;
  // The recipient token account must exist AND match the burn's own mintRecipient (32B) —
  // receiveMessage mints into exactly that account. The account need NOT be a canonical ATA:
  // the dpay sol-rail's USDC lives in a plain token account (22HkLhns…), so the caller passes
  // whichever account the burn named.
  const userAta = userTokenAccount ?? findPda(ATA_PROGRAM, [owner, b32(TOKEN_PROGRAM), b32(USDC_MINT)]).address;
  log(`user_token_account = ${JSON.stringify(userAta)} (param was ${JSON.stringify(userTokenAccount)})`);
  await must('user_token_account', userAta, 'the burn’s recipient USDC token account must exist');
  // The authority PDA is an "empty PDA" (receive_message.rs: CHECK empty PDA) — it exists
  // only for CPI signer verification and may legitimately have NO on-chain account.
  found.authority_pda = {addr: (await findPda(MT_PROGRAM, [enc.encode('message_transmitter_authority'), b32(TM_PROGRAM)])).address, emptyPda: true};
  // config: canonical seed per the Circle test client (findProgramAddress('message_transmitter',
  // null, MT_PROGRAM)).
  const config = (await findPda(MT_PROGRAM, ['message_transmitter'])).address;
  await must('message_transmitter', config, 'the MessageTransmitterV2 config PDA');
  const usedNonce = (await findPda(MT_PROGRAM, [enc.encode('used_nonce'), msg.nonce])).address;
  found.used_nonce = {addr: usedNonce, expectNull: true, exists: (await accountInfo(usedNonce)) != null};
  found.receiver = TM_PROGRAM;
  await must('token_messenger', (await findPda(TM_PROGRAM, [enc.encode('token_messenger')])).address, 'TM token_messenger PDA');
  const remote = (await findPda(TM_PROGRAM, ['remote_token_messenger', String(msg.sourceDomain)])).address;
  await must('remote_token_messenger', remote, 'TM remote_token_messenger for source domain 0');
  await must('token_minter', (await findPda(TM_PROGRAM, [enc.encode('token_minter')])).address, 'TM token_minter PDA');
  await must('local_token', (await findPda(TM_PROGRAM, [enc.encode('local_token'), b32(USDC_MINT)])).address, 'TM local_token PDA for USDC');
  // the remote token seed is the RAW 32 bytes (left-padded EVM address), never its base58 text
  const remoteTokenBytes = new Uint8Array(Buffer.from(USDC_ERC20.replace(/^0x/, '').padStart(64, '0'), 'hex'));
  const pair = (await findPda(TM_PROGRAM, ['token_pair', String(msg.sourceDomain), remoteTokenBytes])).address;
  await must('token_pair', pair, 'TM token_pair PDA for the burned USDC (eth source)');
  await must('custody', (await findPda(TM_PROGRAM, [enc.encode('custody'), b32(USDC_MINT)])).address, 'TM custody PDA for USDC');
  found.event_authority = (await findPda(MT_PROGRAM, [enc.encode('__event_authority')])).address;
  found.tm_event_authority = (await findPda(TM_PROGRAM, [enc.encode('__event_authority')])).address;
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
    Buffer.from(header), Buffer.from(bs58Decode(bh.blockhash)),
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
  const sig = nobleEd25519.sign(new Uint8Array(message), rail.seed);
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
const isMain = process.argv[1] != null && import.meta.url === (await import('node:url').then(m => m.pathToFileURL(process.argv[1])).catch(() => null))?.href;
if (isMain) {
  const [cmd, txHash] = process.argv.slice(2);
  try {
    const rail = loadRail();
    log(`rail: ${rail.address}`);
    if (cmd === 'balance') {
      const ata = findPda(ATA_PROGRAM, [rail.pub, b32(TOKEN_PROGRAM), b32(USDC_MINT)]).address;
      const bal = await ataBalance(ata);
      console.log(JSON.stringify({ata, ...bal}, null, 2));
    } else if (cmd === 'status' || cmd === 'claim' || cmd === 'dryrun') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? '')) throw new Error('usage: cctp-claim.mjs status|claim|dryrun <0xtxhash>');
      const m = await fetchMessage(txHash);
      const msg = parseMessage(m.message);
      const att = new Uint8Array(Buffer.from(m.attestation.replace(/^0x/, ''), 'hex'));
      const burn = parseBurnBody(msg.body);
      log(`message: v${msg.version} src=${msg.sourceDomain} dst=${msg.destinationDomain} minFinality=${msg.minFinality} fte=${msg.fte} status=${m.status}`);
      log(`burn: token=0x${burn.burnToken} mintRecipient=${burn.mintRecipient} amount=${burn.amount} subunits`);
      if (msg.sourceDomain !== 0 || msg.destinationDomain !== 5) throw new Error('message is not eth->sol');
      if (msg.recipient.join() !== b32(TM_PROGRAM).join()) throw new Error('recipient is not TokenMessengerMinterV2');
      if (msg.destinationCaller.some((x) => x !== 0)) throw new Error('destinationCaller set — not permissionless');
      if (burn.burnToken.replace(/^0x/, '').toLowerCase().padStart(64, '0') !== USDC_ERC20.toLowerCase().replace(/^0x/, '').padStart(64, '0')) throw new Error('burn token is not mainnet USDC');
      if (burn.amount <= 0n) throw new Error('zero amount');
      const burnRecipient = burn.mintRecipient;
      const a = await resolveAccounts(msg, rail, burnRecipient);
      log('account census: ' + JSON.stringify(a, null, 2));
      if (cmd === 'dryrun') {
        // Sign the full claim transaction and STOP — the dry run proves parsing, account
        // census, tx construction and key derivation against LIVE Circle+Solana data without
        // broadcasting anything (and without touching anyone's funds: a completed burn's
        // used_nonce is already consumed, so even an accidental send would fail on-chain).
        const {txBase64} = await buildAndSign(rail, msg, att, a);
        log(`DRY RUN signed OK — ${txBase64.length} b64 bytes, NOT sent (burn already claimed/pending by its owner)`);
        console.log(JSON.stringify({dryRun: true, burnTx: txHash, mintRecipient: burnRecipient, signedTxB64Len: txBase64.length}, null, 2));
      } else if (cmd === 'status') {
        const ata = a.user_token_account.addr;
        log(`pre-claim USDC at recipient account: ${JSON.stringify(await ataBalance(ata))}`);
        console.log('STATUS OK - ready to claim');
      } else if (cmd === 'claim') {
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
