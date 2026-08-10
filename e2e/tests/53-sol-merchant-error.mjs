// Flow 53 — SOL error path: merchant broadcast with a rejecting stub.
//
// Proves a SOL broadcast error is surfaced as a FRIENDLY message — never the raw RPC error text and
// never a false "Received". Same setup as flow 51 (merchant broadcast) BUT the stub's sendTransaction
// THROWS the canonical "no record of a prior credit" error (the #1 unfunded-account failure).
//
// Code path: onSignedQr → broadcastSolPayment → sendTransaction THROWS → broadcastSolPayment's catch
// matches the rejection regex (/no record of a prior credit|simulation failed|debit/i) → returns
// {status: RECEIPT_REJECTED} → onSignedQr sets the friendly "Payment rejected" message on sol-req-err.
// The raw RPC text ("Transaction simulation failed" / "Attempt to debit") NEVER reaches the DOM.
//
// Asserts:
//   - sol-req-err renders with the friendly rejection text (contains "rejected").
//   - The body does NOT contain the raw RPC error ("Transaction simulation failed" / "Attempt to debit").
//   - sol-req-status (the "Received" success) does NOT render (no false success).
//
// Selector contract: same as flow 51 (asset-sol-select, tab-receive, btn-sol-req-make, sol-req-qr,
// sol-req-err).
import {setup, assert, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '53',
  name: 'sol-merchant-error',
  journey: 'offline',
  covers: ['sol-merchant', 'sol-error', 'solpay-match', 'friendly-error'],
  verifies: 'SOL merchant broadcast error surfaces a friendly message (not raw RPC, not false Received).',
  timeoutMs: 25000,
};

const PAYER_NPUB = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';

function nonceAccountB64() {
  const buf = Buffer.alloc(80, 0);
  buf.writeUInt32LE(0, 0);
  buf.writeUInt32LE(1, 4);
  buf.fill(1, 8, 40);
  Buffer.from('deadbeef'.repeat(8), 'hex').copy(buf, 40);
  buf.writeBigUInt64LE(5000n, 72);
  return buf.toString('base64');
}

function decodeSolReq(uri) {
  const payload = uri.split('solreq:v1?')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

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
  console.log('[53-sol-merchant-error] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[53-sol-merchant-error] onboarding…');
    await onboardWallet(driver, 'e2e-sol-err');

    // Install the REJECTING stub: sendTransaction throws the unfunded-account error. The other
    // methods stay functional so the flow reaches the broadcast point (getBalance funds the SOL card,
    // getLatestBlockhash is unused by broadcast but harmless, getSignatureStatuses is never reached).
    const nonceB64 = nonceAccountB64();
    await driver.eval((b64) => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getLatestBlockhash: () => ({value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => { throw new Error('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit'); },
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: [b64, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
        getBalance: () => ({value: 5000000000}),
      };
    }, nonceB64);

    // 1. Select SOL → Receive tab → build the solreq QR (same as flow 51).
    console.log('[53-sol-merchant-error] selecting SOL via Balances…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});

    console.log('[53-sol-merchant-error] switching to the Receive tab…');
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});

    console.log('[53-sol-merchant-error] creating the solreq QR…');
    await driver.type('sol-req-amount-input', '0.025', {timeoutMs: 5_000});
    await driver.click('btn-sol-req-make', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 5_000});

    const solreqUri = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof solreqUri === 'string' && solreqUri.startsWith('solreq:v1?'),
      `the solreq QR must be captured, got: ${JSON.stringify(solreqUri)?.slice(0, 80)}`);
    const req = decodeSolReq(solreqUri);
    const solpayUri = buildSolPay(req);

    // 2. Open the scanner + fire the matching solpay → broadcast FAILS (rejecting stub).
    console.log('[53-sol-merchant-error] opening the scanner + scanning the matching solpay…');
    await driver.eval(() => {
      const el = document.querySelector('[aria-label="Scan the payer\'s signed code"]');
      if (el) el.click();
    });
    await driver.waitForText('Scan the payer\'s signed code', {timeoutMs: 5_000});
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solpayUri);

    // 3. Assert the friendly error is shown (sol-req-err) — NOT the raw RPC error.
    const errEl = await driver.findByTestID('sol-req-err', {timeoutMs: 12_000});
    const errTxt = await errEl.evaluate((n) => (n.textContent ?? '').trim());
    assert(/rejected/i.test(errTxt),
      `the friendly error should mention "rejected", got: "${errTxt}"`);
    // The raw RPC error must NEVER reach the DOM.
    assert(!/Transaction simulation failed/.test(errTxt),
      `the raw RPC error must not leak to the UI, got: "${errTxt}"`);
    assert(!/Attempt to debit/.test(errTxt),
      `the raw RPC error must not leak to the UI, got: "${errTxt}"`);
    console.log(`[53-sol-merchant-error] ✓ friendly error: "${errTxt}"`);

    // 4. No false success: sol-req-status ("Received") must NOT render.
    const body = await driver.bodyText();
    assert(!/Received/.test(body), 'the body must NOT show "Received" (no false success on a rejected broadcast)');
    console.log('[53-sol-merchant-error] ✓ no false "Received"');

    await driver.screenshot('53-sol-merchant-error');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[53-sol-merchant-error] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[53-sol-merchant-error] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
