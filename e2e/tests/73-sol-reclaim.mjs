// Flow 73 — Legacy durable-nonce reclaim (Phase 6 isolated recovery, NOT a payment path).
//
// Drives the REAL app's Settings → "Legacy funds" section against the SOL RPC stub:
//   1. Onboard → read the wallet's secretHex.
//   2. Derive the main wallet pubkey (m/44'/501'/0'/0') + nonce account address (m/44'/501'/0'/1')
//      in Node via SLIP-10 HMAC-SHA512 + Web Crypto Ed25519 (no @noble dependency in the harness).
//   3. Install the stub returning a reclaimable nonce account (authority = main wallet pubkey).
//   4. Settings → Check → assert "Reclaimable" → Reclaim → assert "Reclaimed".
//   5. Flip the stub to absent → re-Check → assert "No legacy nonce account".
//
// Covers: inspectReclaim (genesis + getAccountInfo + inspect), reclaimNonceAccount (blockhash + fee +
// balance + sign + send + confirm), clearSolNonce, and the UI testIDs + state machine. The ed25519
// pubkey is derived independently in Node (Web Crypto) and must match the app's @noble derivation — a
// cross-implementation parity check baked into the flow.
import {setup, assertIncludes} from '../harness/lib.mjs';
import crypto from 'crypto';

export const meta = {
  id: '73',
  name: 'sol-reclaim',
  journey: 'offline',
  covers: ['sol-reclaim', 'settings-legacy-funds', 'sol-slip10-parity'],
  verifies: 'Legacy durable-nonce reclaim: inspect → reclaimable → drain → reclaimed; absent path.',
  timeoutMs: 30000,
};

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const BLOCKHASH = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN';
const LAMPORTS = 1447680;
const FEE = 5000;
const MAIN_BALANCE = 10_000_000_000;

// SLIP-10 ed25519 derivation (mirrors app/solana/identity.ts deriveSlip10Ed25519).
function deriveSlip10(seedHex, hardenedIndices) {
  let i = crypto.createHmac('sha512', Buffer.from('ed25519 seed')).update(Buffer.from(seedHex, 'hex')).digest();
  let key = i.subarray(0, 32), chain = i.subarray(32);
  for (const idx of hardenedIndices) {
    const data = Buffer.alloc(37);
    data[0] = 0; Buffer.from(key).copy(data, 1); data.writeUInt32BE(idx, 33);
    i = crypto.createHmac('sha512', chain).update(data).digest();
    key = i.subarray(0, 32); chain = i.subarray(32);
  }
  return Buffer.from(key);
}

// ed25519 public key (32 bytes) from a raw seed via Web Crypto (cross-impl parity with @noble).
async function ed25519Pubkey(seed32) {
  const subtle = crypto.webcrypto.subtle;
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed32]);
  const key = await subtle.importKey('pkcs8', pkcs8, {name: 'Ed25519'}, true, ['sign']);
  const jwk = await subtle.exportKey('jwk', key);
  return Buffer.from(jwk.x, 'base64url');
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

const HARDENED = (n) => n + 0x80000000;

export async function run() {
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[73-sol-reclaim] onboarding…');
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-sol-reclaim', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    // Wait for Continue enabled (gate checkbox), then dismiss backup → wallet.
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.findByTestID('balance', {timeoutMs: 10_000});

    const identity = await driver.eval(() => {
      const v = localStorage.getItem('dpay.identity.v1');
      return v ? JSON.parse(v) : null;
    });
    const secretHex = identity.secretHex;

    // Derive keys in Node (cross-impl parity: must match the app's @noble derivation).
    const mainPub = await ed25519Pubkey(deriveSlip10(secretHex, [44, 501, 0, 0].map(HARDENED)));
    const noncePub = await ed25519Pubkey(deriveSlip10(secretHex, [44, 501, 0, 1].map(HARDENED)));
    const nonceAddress = bs58Encode(noncePub);

    // Build the 80-byte NonceAccountLayout: u32 version(0) | u32 state(1=Initialized) | 32B authority |
    // 32B stored nonce value | u64 fee. Only version+state+authority matter for inspectNonceAccount.
    const acct = Buffer.alloc(80);
    acct.writeUInt32LE(0, 0);
    acct.writeUInt32LE(1, 4);
    mainPub.copy(acct, 8);
    acct.writeBigUInt64LE(5000n, 72);
    const acctB64 = acct.toString('base64');

    console.log('[73-sol-reclaim] installing reclaimable stub (nonce addr ' + nonceAddress.slice(0, 8) + '…)…');
    await driver.eval((addr, dataB64, lamports, genesis, bh, fee, balance) => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => genesis,
        getAccountInfo: (params) => params[0] === addr
          ? {value: {data: [dataB64, 'base64'], owner: '11111111111111111111111111111111', lamports, executable: false, rentEpoch: 0}}
          : {value: null},
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: bh, lastValidBlockHeight: 300000000}}),
        getFeeForMessage: () => fee,
        getBalance: () => ({value: balance}),
        sendTransaction: () => 'sig_reclaim_e2e',
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
      };
    }, nonceAddress, acctB64, LAMPORTS, MAINNET_GENESIS, BLOCKHASH, FEE, MAIN_BALANCE);

    console.log('[73-sol-reclaim] opening Settings → check…');
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.findByTestID('btn-sol-reclaim-check', {timeoutMs: 5_000});
    await driver.click('btn-sol-reclaim-check', {timeoutMs: 5_000});

    const status = await driver.readText('sol-reclaim-status', {timeoutMs: 8_000});
    assertIncludes(status, 'Reclaimable', 'check status shows reclaimable');

    console.log('[73-sol-reclaim] reclaiming…');
    await driver.findByTestID('btn-sol-reclaim-confirm', {timeoutMs: 5_000});
    await driver.click('btn-sol-reclaim-confirm', {timeoutMs: 5_000});
    const result = await driver.readText('sol-reclaim-result', {timeoutMs: 15_000});
    assertIncludes(result, 'Reclaimed', 'reclaim result shows reclaimed');

    console.log('[73-sol-reclaim] absent re-check…');
    await driver.eval(() => { globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getAccountInfo = () => ({value: null}); });
    await driver.click('btn-sol-reclaim-check', {timeoutMs: 5_000});
    const absent = await driver.readText('sol-reclaim-status', {timeoutMs: 8_000});
    assertIncludes(absent, 'No legacy nonce account', 'absent check status');

    console.log('[73-sol-reclaim] PASS');
  } finally {
    await env.cleanup?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
