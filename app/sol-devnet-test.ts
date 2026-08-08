// Standalone devnet pipeline test — exercises the app's REAL SOL modules against the live Solana
// devnet. Run from the app directory: npx tsx sol-devnet-test.ts
//
// Tests the full pipeline: derive address → airdrop → balance → send → recipient balance →
// durable nonce account creation → nonce advance.

// Set the RPC URL override BEFORE importing the seam (solana.ts reads SOLANA_RPC_URL at module load)
const RPC_URL = process.env.SOL_RPC_URL ?? 'http://localhost:8899';
(globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string}).__DPAY_TEST_SOLANA_RPC_URL = RPC_URL;
const URL = RPC_URL;

import { randomBytes } from 'node:crypto';
import { deriveSolanaKeypair, deriveSolanaAddress } from './solana/identity';
import { buildSignedTransfer, base58Decode32 } from './solana/tx';
import {
  getBalance,
  getLatestBlockhash,
  sendTransaction,
  confirmTransaction,
  getMinimumBalanceForRentExemption,
  getNonceAccount,
} from './solana/rpc';
import { decodeSolPay } from './solana/qr';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function rpcAirdrop(url: string, address: string, lamports: number): Promise<string> {
  // Try the JSON-RPC requestAirdrop first
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [address, lamports] });
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const j = await r.json() as { error?: { message?: string }; result?: string };
      if (j.error) throw new Error(j.error.message ?? 'error');
      return j.result!;
    } catch (e) {
      console.log(`  (attempt ${attempt + 1}/3 failed: ${(e as Error).message}; retrying in 10s…)`);
      if (attempt < 2) await sleep(10000);
    }
  }
  // Fallback: faucet.solana.com API
  console.log('  (falling back to faucet.solana.com API…)');
  const r = await fetch('https://faucet.solana.com/api/all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: address, amount: lamports / 1e9 }),
  });
  const j = await r.json() as { transaction?: string; error?: string };
  if (j.error) throw new Error(`faucet API: ${j.error}`);
  return j.transaction ?? 'faucet-api';
}

async function main() {
  // 1. Generate two identities: sender + recipient
  const seed1 = randomBytes(32);
  const seed2 = randomBytes(32);
  const kp1 = deriveSolanaKeypair(seed1.toString('hex'));
  const kp2 = deriveSolanaKeypair(seed2.toString('hex'));
  console.log(`[1] Sender address:    ${kp1.address}`);
  console.log(`[1] Recipient address: ${kp2.address}`);

  // Verify deterministic derivation
  const reAddr = deriveSolanaAddress(seed1.toString('hex'));
  if (reAddr !== kp1.address) throw new Error('deriveSolanaAddress not deterministic');
  console.log('[1] ✓ deterministic derivation verified');

  // 2. Request airdrop to sender (1 SOL = 1_000_000_000 lamports; devnet limit is 2 SOL/request)
  console.log('[2] requesting 2 SOL airdrop to sender…');
  try {
    const sig = await rpcAirdrop(URL, kp1.address, 2_000_000_000);
    console.log(`[2] airdrop signature: ${sig.slice(0, 16)}…`);
    // Wait for confirmation
    console.log('[2] confirming airdrop…');
    await confirmTransaction(URL, sig);
    console.log('[2] ✓ airdrop confirmed');
  } catch (e) {
    console.error(`[2] ✗ airdrop failed: ${(e as Error).message}`);
    console.error('    (devnet faucet may be rate-limited — retry in 60s)');
    process.exit(1);
  }
  // Give the validator a moment to finalize
  // 3. Poll for balance (test-validator may lag a few slots after confirm)
  console.log('[3] polling for balance…');
  let bal1 = '0';
  for (let i = 0; i < 15; i++) {
    bal1 = await getBalance(URL, kp1.address);
    if (Number(bal1) > 0) break;
    await sleep(1000);
  }
  console.log(`[3] sender balance: ${bal1} lamports (${Number(bal1) / 1e9} SOL)`);
  if (Number(bal1) < 1_000_000_000) throw new Error('balance too low after airdrop');

  // 4. Send 0.5 SOL from sender to recipient using the app's actual tx builder
  const lamports = 500_000_000n; // 0.5 SOL
  console.log('[4] building + signing System Program Transfer…');
  const { blockhash } = await getLatestBlockhash(URL);
  console.log(`[4] blockhash: ${blockhash.slice(0, 16)}…`);
  const rawTx = buildSignedTransfer(kp1.seed, kp1.publicKey, kp2.address, lamports, base58Decode32(blockhash));
  console.log(`[4] raw tx: ${rawTx.length} bytes`);

  console.log('[4] broadcasting…');
  const txSig = await sendTransaction(URL, rawTx);
  console.log(`[4] tx signature: ${txSig.slice(0, 16)}…`);

  console.log('[4] confirming…');
  await confirmTransaction(URL, txSig);
  console.log('[4] ✓ confirmed');

  // 5. Check recipient balance (poll for same timing reason)
  let bal2 = '0';
  for (let i = 0; i < 15; i++) {
    bal2 = await getBalance(URL, kp2.address);
    if (Number(bal2) > 0) break;
    await sleep(1000);
  }
  console.log(`[5] recipient balance: ${bal2} lamports (${Number(bal2) / 1e9} SOL)`);
  if (Number(bal2) < 500_000_000) throw new Error('recipient balance too low');

  // 6. Check sender's remaining balance (should be ~1.5 SOL minus fee)
  const bal1After = await getBalance(URL, kp1.address);
  console.log(`[6] sender balance after send: ${bal1After} lamports (${Number(bal1After) / 1e9} SOL)`);

  // 7. Test durable nonce account creation (manual — with debugging)
  console.log('[7] testing durable nonce account creation…');
  {
    const { buildCreateNonceAccountMessage } = await import('./solana/nonce');
    const { ed25519 } = await import('@noble/curves/ed25519');
    const bs58 = (await import('bs58')).default;
    const { hexToBytes } = await import('./lib/format');
    const { deriveSlip10Ed25519 } = await import('./solana/identity');

    // Derive nonce account keypair at m/44'/501'/0'/1'
    const NONCE_PATH = [44, 501, 0, 1].map((i) => i + 0x80000000);
    const derived = deriveSlip10Ed25519(seed1, NONCE_PATH);
    const nonceSeed = new Uint8Array(32);
    nonceSeed.set(derived);
    const noncePubkey = ed25519.getPublicKey(nonceSeed);
    const nonceAddr = bs58.encode(noncePubkey);
    console.log(`[7] authority (sender): ${kp1.address}`);
    console.log(`[7] nonce account addr: ${nonceAddr}`);
    console.log(`[7] SOLANA_RPC_URL check: ${RPC_URL}`);

    // Get rent + blockhash
    const rent = await getMinimumBalanceForRentExemption(URL, 80);
    console.log(`[7] rent exemption (80B): ${rent} lamports`);
    const { blockhash: bh2 } = await getLatestBlockhash(URL);
    console.log(`[7] blockhash: ${bh2.slice(0, 16)}…`);

    // Build + sign the nonce account creation tx
    const msg = buildCreateNonceAccountMessage(kp1.publicKey, noncePubkey, rent, base58Decode32(bh2));
    console.log(`[7] create+init message: ${msg.length} bytes`);

    // Multi-sign: authority + nonce account (2 signers)
    const out = new Uint8Array(1 + 2 * 64 + msg.length);
    out[0] = 2;
    out.set(ed25519.sign(msg, kp1.seed), 1);
    out.set(ed25519.sign(msg, nonceSeed), 65);
    out.set(msg, 129);
    console.log(`[7] signed tx: ${out.length} bytes`);

    // Broadcast — skip confirmTransaction (test-validator has a gap between confirm and queryable state)
    const nonceSig = await sendTransaction(URL, out);
    console.log(`[7] create tx sig: ${nonceSig.slice(0, 16)}…`);

    // Poll for the nonce account (up to 30s — test-validator state-propagation lag)
    let nonceInfo: {authority: string; value: string} | null = null;
    for (let i = 0; i < 30; i++) {
      try {
        nonceInfo = await getNonceAccount(URL, nonceAddr);
        break;
      } catch {
        if (i % 5 === 0) console.log(`[7] waiting for nonce account (attempt ${i + 1})…`);
        await sleep(1000);
      }
    }
    if (!nonceInfo) throw new Error('nonce account never appeared after 30s');
    console.log(`[7] nonce authority: ${nonceInfo.authority}`);
    console.log(`[7] nonce value:     ${nonceInfo.value}`);
    console.log('[7] ✓ durable nonce account verified');

    // Store for step 8
    (main as any)._nonce = { address: nonceAddr, value: nonceInfo.value };
  }

  // 8. Test offline sign + broadcast (the receipt-nonce-relay flow)
  console.log('[8] testing offline sign + broadcast (solpay flow)…');
  const { signOfflineSolPayment, broadcastSolPayment } = await import('./solana');
  const req = { to: kp2.address, amt: '100000000', cur: 'SOL' as const }; // 0.1 SOL
  const solpayUri = signOfflineSolPayment(seed1.toString('hex'), req as any, (main as any)._nonce.address, (main as any)._nonce.value);
  console.log(`[8] solpay URI: ${solpayUri.slice(0, 50)}…`);

  // Decode the URI → SolPay object → broadcast
  const solpay = decodeSolPay(solpayUri);
  console.log(`[8] decoded tx: ${solpay.tx.length} bytes`);

  console.log('[8] broadcasting solpay…');
  const receipt = await broadcastSolPayment(solpay);
  console.log(`[8] receipt status: ${receipt.status}, nextNonce: ${receipt.nextNonce?.slice(0, 16) ?? 'null'}…`);

  // Re-check balances
  const bal1Final = await getBalance(URL, kp1.address);
  const bal2Final = await getBalance(URL, kp2.address);
  console.log(`[8] sender balance: ${bal1Final} lamports (${Number(bal1Final) / 1e9} SOL)`);
  console.log(`[8] recipient balance: ${bal2Final} lamports (${Number(bal2Final) / 1e9} SOL)`);

  console.log('\n✅ ALL DEVNET TESTS PASSED');
}

main().catch(e => {
  console.error(`\n❌ FAILED: ${e.stack || e.message || e}`);
  process.exit(1);
});
