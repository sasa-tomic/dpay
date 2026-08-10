// Flow 51 — SOL merchant broadcast (SolReceiveMode.onSignedQr path).
//
// The ENTIRE merchant broadcast path was uncovered before this flow: build solreq → scan the payer's
// signed solpay → broadcast via the stub RPC → "Received". Flow 46 covers the PAYER side (offline
// sign → solpay QR → honest pending); this flow is the MERCHANT side that consumes that solpay.
//
// Proves end-to-end through the REAL SolReceiveMode:
//   1. Select SOL → Receive tab mounts SolReceiveMode.
//   2. Enter amount → Request → solreq: QR rendered (`sol-req-qr`), stashed at `__DPAY_QR_LAST`.
//   3. Tap "Scan the payer's signed code" → QrScanner mounts (listener registered).
//   4. Fire `__DPAY_TEST_SCAN(solpayUri)` with a MATCHING solpay (to/cur/amt echoed from the solreq).
//   5. onSignedQr → decodeSolPay → solpayMatchesReq ✓ → broadcastSolPayment (stub) → "Received".
//
// The matching solpay is built in Node by decoding the stashed solreq (extract {to, amt, cur}) and
// echoing them — `solpayMatchesReq` binds exactly those three fields. The stub's sendTransaction
// always returns a random sig + getSignatureStatuses returns confirmed, so any tx bytes work. The
// merchant does NOT set up a durable nonce (that's the payer's side); it only broadcasts.
//
// Selector contract: `asset-sol-select`, `tab-receive`, `sol-req-amount-input`, `btn-sol-req-make`,
// `sol-req-qr`, `sol-req-status`, `sol-req-sig`.
import {setup, assert, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '51',
  name: 'sol-merchant-broadcast',
  journey: 'offline',
  covers: ['sol-merchant', 'sol-broadcast', 'solpay-match', 'qr-scan'],
  verifies: 'SOL merchant: build solreq → scan matching solpay → broadcast (stub) → Received.',
  timeoutMs: 25000,
};

// Any valid base58 address for the solpay's npub (the merchant's stub getAccountInfo ignores the
// address and always returns valid NonceState data, so this is never validated on-chain).
const PAYER_NPUB = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';

// Build the 80-byte NonceState account data as base64 (the layout getNonceAccount parses).
// broadcastSolPayment calls getNonceAccount(npub) AFTER sendTransaction+confirm to read the advanced
// nonce; the stub returns this for any address.
function nonceAccountB64() {
  const buf = Buffer.alloc(80, 0);
  buf.writeUInt32LE(0, 0);    // version
  buf.writeUInt32LE(1, 4);    // state = Initialized
  buf.fill(1, 8, 40);         // authority
  Buffer.from('deadbeef'.repeat(8), 'hex').copy(buf, 40); // nonce value
  buf.writeBigUInt64LE(5000n, 72); // fee.lamports_per_signature
  return buf.toString('base64');
}

// Decode a solreq: URI → the parsed JSON object ({to, amt, cur, ...}).
function decodeSolReq(uri) {
  const payload = uri.split('solreq:v1?')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

// Build a matching solpay: URI (echoes to/amt/cur from the solreq so solpayMatchesReq passes).
function buildSolPay(req) {
  const obj = {
    v: 1, to: req.to, amt: req.amt, cur: req.cur,
    npub: PAYER_NPUB,
    tx: Buffer.from('dummy-signed-tx-bytes').toString('base64url'),
  };
  return 'solpay:v1?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export async function run() {
  const start = Date.now();
  console.log('[51-sol-merchant-broadcast] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[51-sol-merchant-broadcast] onboarding…');
    await onboardWallet(driver, 'e2e-sol-merchant');

    // Install the SOL RPC stub. The merchant broadcast path needs: sendTransaction (broadcast),
    // getSignatureStatuses (confirmTransaction), getAccountInfo (getNonceAccount post-confirm).
    // getBalance is polled by useSolanaBalance regardless.
    const nonceB64 = nonceAccountB64();
    await driver.eval((b64) => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getLatestBlockhash: () => ({value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: [b64, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
        getBalance: () => ({value: 5000000000}),
      };
    }, nonceB64);

    // 1. Select SOL via the Balances sheet (the selected asset implies the rail).
    console.log('[51-sol-merchant-broadcast] selecting SOL via Balances…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});

    // 2. Switch to the Receive tab → SolReceiveMode mounts (activeSol + solAddress).
    console.log('[51-sol-merchant-broadcast] switching to the Receive tab…');
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});

    // 3. Build the request QR. Type an explicit amount (the field defaults to empty — D1).
    console.log('[51-sol-merchant-broadcast] creating the solreq QR…');
    await driver.type('sol-req-amount-input', '0.025', {timeoutMs: 5_000});
    await driver.click('btn-sol-req-make', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 5_000});

    // 4. Read the stashed solreq URI + decode it to build a matching solpay.
    const solreqUri = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof solreqUri === 'string' && solreqUri.startsWith('solreq:v1?'),
      `the solreq QR must be captured, got: ${JSON.stringify(solreqUri)?.slice(0, 80)}`);
    const req = decodeSolReq(solreqUri);
    console.log(`[51-sol-merchant-broadcast] ✓ solreq decoded: to=${req.to.slice(0, 8)}… amt=${req.amt} cur=${req.cur}`);

    const solpayUri = buildSolPay(req);
    assert(solpayUri.startsWith('solpay:v1?'), 'built solpay URI must have the solpay: prefix');

    // 5. Tap "Scan the payer's signed code" (no testID — click via aria-label) → QrScanner mounts.
    console.log('[51-sol-merchant-broadcast] opening the scanner…');
    await driver.eval(() => {
      const el = document.querySelector('[aria-label="Scan the payer\'s signed code"]');
      if (el) el.click();
    });
    // Wait for the scan listener to register (QrScanner's useEffect).
    await driver.waitForText('Scan the payer\'s signed code', {timeoutMs: 5_000});

    // 6. Fire the scan with the matching solpay → onSignedQr → broadcast → "Received".
    console.log('[51-sol-merchant-broadcast] scanning the matching solpay…');
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solpayUri);

    // 7. Assert the success state: "Received" + a transaction signature.
    const status = await driver.findByTestID('sol-req-status', {timeoutMs: 12_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/Received/.test(statusTxt), `the merchant should see "Received", got: "${statusTxt}"`);
    console.log(`[51-sol-merchant-broadcast] ✓ ${statusTxt}`);
    const sig = await driver.findByTestID('sol-req-sig', {timeoutMs: 5_000});
    const sigTxt = await sig.evaluate((n) => (n.textContent ?? '').trim());
    assert(/^sig_/.test(sigTxt), `the received signature should be rendered, got: "${sigTxt}"`);
    console.log(`[51-sol-merchant-broadcast] ✓ signature: ${sigTxt}`);

    await driver.screenshot('51-sol-merchant-broadcast');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[51-sol-merchant-broadcast] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[51-sol-merchant-broadcast] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
