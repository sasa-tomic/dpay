// Flow 53 — SOL v2 error path: merchant broadcast with a rejecting stub.
//
// Proves a SOL broadcast error is surfaced as a FRIENDLY message — never the raw RPC error text and
// never a false "Received". Same setup as flow 51 (merchant broadcast with a REAL signed solpay) BUT
// the stub's sendTransaction THROWS the canonical unfunded-account error.
//
// v2 code path: onSignedQr → broadcastSolPayment → strict-verify PASSES (real signed tx) →
// freshness check PASSES → sendTransaction THROWS → catch matches the rejection regex
// (/Instruction|insufficient|no record of a prior credit|simulation failed|debit|custom|already|blockhash|nonce/i)
// → returns {status: RECEIPT_REJECTED} → SolReceiveMode shows the friendly "rejected" message on
// sol-req-err. The raw RPC text NEVER reaches the DOM.
//
// Asserts:
//   - sol-req-err renders with the friendly rejection text (contains "rejected").
//   - The body does NOT contain the raw RPC error text.
//   - sol-req-status ("Received") does NOT render (no false success).
//
// Selector contract: same as flow 51.
import {setup, assert, onboardWallet, armNfcCard, waitForWallet, openBalances} from '../harness/lib.mjs';
import { nfcPhaseWalk } from '../harness/flow-steps.mjs';

export const meta = {
  id: '53',
  name: 'sol-merchant-error',
  journey: 'offline',
  covers: ['sol-merchant', 'sol-error', 'sol-v2-rejected', 'friendly-error'],
  verifies: 'SOL v2 merchant broadcast error surfaces a friendly message (not raw RPC, not false Received).',
  timeoutMs: 30000,
};

// Minimal base58 encoder (see flow 47).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

function extractSig(solpayUri) {
  const payload = solpayUri.split('solpay:v2?')[1];
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const tx = Buffer.from(obj.tx, 'base64url');
  return bs58Encode(new Uint8Array(tx.slice(1, 65)));
}

export async function run() {
  const start = Date.now();
  console.log('[53-sol-merchant-error] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[53-sol-merchant-error] onboarding…');
    await onboardWallet(driver, 'e2e-sol-err');

    // Install the REJECTING stub: sendTransaction throws the unfunded-account error. The other
    // methods stay functional so the flow reaches the broadcast point (createSolPaymentRequest uses
    // getGenesisHash + getLatestBlockhash; broadcastSolPayment uses isBlockhashValid + getBlockHeight
    // before hitting sendTransaction).
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2000000', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN', lastValidBlockHeight: 300000000}}),
        isBlockhashValid: () => ({context: {slot: 250000001}, value: true}),
        getBlockHeight: () => 250000001,
        sendTransaction: () => { throw new Error('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit'); },
        getSignatureStatuses: () => ({context: {slot: 250000002}, value: [{confirmationStatus: 'confirmed'}]}),
        getBalance: () => ({value: 5000000000}),
      };
    });

    // 1. Select SOL → Receive tab → create the solreq QR.
    console.log('[53-sol-merchant-error] selecting SOL + switching to Receive…');
    await waitForWallet(driver, {timeoutMs: 8_000});
    await openBalances(driver, {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});

    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});

    console.log('[53-sol-merchant-error] creating the solreq:v2 QR (ONLINE)…');
    await driver.type('sol-req-amount-input', '0.025', {timeoutMs: 5_000});
    await driver.click('btn-sol-req-make', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 8_000});

    // The QR is the payment LINK now (founder 2026-09-12) — the machine code is read off the
    // armed reader seam (`__DPAY_SOL_REQ_LAST`, what the card will actually receive).
    let solreqUri = null;
    for (let i = 0; i < 100 && !solreqUri; i++) {
      solreqUri = await driver.eval(() => window.__DPAY_SOL_REQ_LAST ?? null);
      if (!solreqUri) await new Promise((r) => setTimeout(r, 50));
    }
    assert(typeof solreqUri === 'string' && solreqUri.startsWith('solreq:v2?'),
      `the reader must arm with the solreq:v2 machine code, got: ${JSON.stringify(solreqUri)?.slice(0, 80)}`);

    // 2. Produce a REAL signed solpay via the NFC auto-sign (one-press rule — same approach as
    //    flow 51: the request signs on arrival, no review/Approve).
    console.log('[53-sol-merchant-error] switching to Pay tab + NFC request (auto-sign)…');
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});

    const dispatch = async (event) => { await armNfcCard(driver, 'sol'); return driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event); };
    await nfcPhaseWalk(driver, dispatch, ['linking'], { statusId: 'sol-nfc-status', text: null });
    await dispatch({type: 'request', role: 'card', solreqUri});
    await driver.waitForText('Communicating', {timeoutMs: 6_000});

    const solpayUri = await driver.eval(() => window.__DPAY_SOL_NFC_LAST);
    assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v2?'),
      `the arrival auto-sign should produce a solpay:v2 URI, got: ${JSON.stringify(solpayUri)?.slice(0, 80)}`);

    // Dismiss the NFC overlay.
    await driver.eval(() => {
      const btn = document.querySelector('button[aria-label="Done"]') || document.querySelector('button[aria-label="Cancel"]');
      if (btn) btn.click();
    });
    await driver.waitGone('sol-nfc-status', {timeoutMs: 5_000});

    // 3. Switch back to Receive → scan the signed solpay → broadcast FAILS (rejecting stub).
    console.log('[53-sol-merchant-error] switching to Receive + scanning the signed solpay…');
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 5_000});

    await driver.eval(() => {
      const el = document.querySelector('[aria-label="Scan the payer\'s signed code"]');
      if (el) el.click();
    });
    await driver.waitForText('Scan the payer\'s signed code', {timeoutMs: 5_000});
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solpayUri);

    // 4. Assert the friendly error is shown (sol-req-err) — NOT the raw RPC error.
    const errEl = await driver.findByTestID('sol-req-err', {timeoutMs: 15_000});
    const errTxt = await errEl.evaluate((n) => (n.textContent ?? '').trim());
    assert(/rejected/i.test(errTxt),
      `the friendly error should mention "rejected", got: "${errTxt}"`);
    // The raw RPC error must NEVER reach the DOM.
    assert(!/Transaction simulation failed/.test(errTxt),
      `the raw RPC error must not leak to the UI, got: "${errTxt}"`);
    assert(!/Attempt to debit/.test(errTxt),
      `the raw RPC error must not leak to the UI, got: "${errTxt}"`);
    console.log(`[53-sol-merchant-error] ✓ friendly error: "${errTxt}"`);

    // 5. No false success: sol-req-status ("Received") must NOT render.
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
