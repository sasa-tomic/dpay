// Flow 51 — SOL v2 merchant broadcast (SolReceiveMode.onSignedQr path).
//
// The ENTIRE merchant broadcast path through the REAL SolReceiveMode:
//   1. Select SOL → Receive tab → enter amount → Request.
//   2. createSolPaymentRequest (ONLINE via stub: getGenesisHash + getLatestBlockhash) → solreq:v2 QR.
//   3. Produce a REAL v2 signed solpay (using the app's own NFC autoSign path — no crypto duplication).
//   4. Feed the signed solpay to the merchant scanner → broadcastSolPayment (strict verify + broadcast).
//   5. "Received" + the transaction signature.
//
// v2 strict verification: broadcastSolPayment checks encodeSolReq(request)===canonicalRequestUri,
// verifies the Ed25519 signature, checks blockhash freshness, and asserts sendTransaction returns the
// SAME sig the local verify produced. Dummy tx bytes are REJECTED — the solpay must be a REAL signed
// transaction. This flow produces it via the app's own signSolPayment (through the NFC card autoSign
// seam), then extracts the sig so the stub's sendTransaction echoes it back.
//
// Approach:
//   - Merchant creates the solreq (Receive tab, ONLINE stub) → capture from __DPAY_QR_LAST.
//   - Switch to Pay tab → dispatch NFC request with the solreq → autoSign → capture solpay from
//     __DPAY_SOL_NFC_LAST (a REAL Ed25519-signed tx).
//   - Extract the sig from the solpay, stash it for the stub's sendTransaction to echo.
//   - Switch back to Receive tab → open scanner → scan the solpay → broadcast → "Received".
//
// Selector contract: `asset-sol-select`, `tab-receive`, `tab-pay`, `sol-req-amount-input`,
// `btn-sol-req-make`, `sol-req-qr`, `sol-req-status`, `sol-req-sig`, `sol-pay-scan`.
import {setup, assert, onboardWallet, armNfcCard} from '../harness/lib.mjs';

export const meta = {
  id: '51',
  name: 'sol-merchant-broadcast',
  journey: 'offline',
  covers: ['sol-merchant', 'sol-broadcast', 'sol-v2-strict-verify', 'qr-scan'],
  verifies: 'SOL v2 merchant: createSolPaymentRequest (ONLINE) → scan real signed solpay → broadcast → Received.',
  timeoutMs: 30000,
};

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const BLOCKHASH = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN';
const LVH = 300_000_000;
const SLOT = 250_000_000;

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
  console.log('[51-sol-merchant-broadcast] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // Force NFC ready (needed for the autoSign step that produces the real signed solpay).
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[51-sol-merchant-broadcast] onboarding…');
    await onboardWallet(driver, 'e2e-sol-merchant');

    // Install the SOL RPC stub with v2 methods.
    // Phase 1 (createSolPaymentRequest): getGenesisHash + getLatestBlockhash.
    // Phase 2 (broadcastSolPayment): isBlockhashValid + getBlockHeight + sendTransaction + getSignatureStatuses.
    // sendTransaction echoes the sig stashed in __DPAY_TEST_SOL_SIG (set after extracting from the solpay).
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN', lastValidBlockHeight: 300000000}}),
        isBlockhashValid: () => ({context: {slot: 250000001}, value: true}),
        getBlockHeight: () => 250000001,
        sendTransaction: () => globalThis.__DPAY_TEST_SOL_SIG || 'sig_fallback',
        getSignatureStatuses: () => ({context: {slot: 250000002}, value: [{confirmationStatus: 'confirmed'}]}),
        getBalance: () => ({value: 5000000000}),
      };
    });

    // 1. Select SOL → Receive tab → create the solreq QR.
    console.log('[51-sol-merchant-broadcast] selecting SOL + switching to Receive…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});

    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});

    console.log('[51-sol-merchant-broadcast] creating the solreq:v2 QR (ONLINE)…');
    await driver.type('sol-req-amount-input', '0.025', {timeoutMs: 5_000});
    await driver.click('btn-sol-req-make', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 8_000});

    // 2. Capture the solreq:v2 URI.
    const solreqUri = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof solreqUri === 'string' && solreqUri.startsWith('solreq:v2?'),
      `the solreq:v2 QR must be captured, got: ${JSON.stringify(solreqUri)?.slice(0, 80)}`);
    console.log('[51-sol-merchant-broadcast] ✓ solreq:v2 QR created');

    // 3. Switch to Pay tab → dispatch NFC request → the request AUTO-SIGNS on arrival (one-press
    //    rule, founder directive 2026-08-24: the "Pay Now" gate was the deliberate press) → a REAL
    //    signed solpay:v2 exists with no intermediate review/Approve.
    console.log('[51-sol-merchant-broadcast] switching to Pay tab + NFC request (auto-sign)…');
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});

    const dispatch = async (event) => { await armNfcCard(driver, 'sol'); return driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event); };
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('sol-nfc-status', {timeoutMs: 4_000});
    await dispatch({type: 'request', role: 'card', solreqUri});
    await driver.waitForText('Communicating', {timeoutMs: 6_000});

    const solpayUri = await driver.eval(() => window.__DPAY_SOL_NFC_LAST);
    assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v2?'),
      `the arrival auto-sign should produce a solpay:v2 URI, got: ${JSON.stringify(solpayUri)?.slice(0, 80)}`);
    console.log('[51-sol-merchant-broadcast] ✓ auto-sign produced a real signed solpay:v2');

    // 4. Extract the sig + stash it so the stub's sendTransaction echoes it back (the v2 strict
    //    verify requires sendTransaction to return the SAME sig the local verify computed).
    const sig = extractSig(solpayUri);
    await driver.eval((s) => { globalThis.__DPAY_TEST_SOL_SIG = s; }, sig);
    console.log(`[51-sol-merchant-broadcast] sig extracted + stashed: ${sig.slice(0, 12)}…`);

    // Dismiss the NFC overlay (Done button).
    await driver.eval(() => {
      const btn = document.querySelector('button[aria-label="Done"]') || document.querySelector('button[aria-label="Cancel"]');
      if (btn) btn.click();
    });
    await driver.waitGone('sol-nfc-status', {timeoutMs: 5_000});

    // 5. Switch back to Receive → open scanner → scan the real signed solpay → broadcast → "Received".
    console.log('[51-sol-merchant-broadcast] switching to Receive + scanning the signed solpay…');
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 5_000});

    await driver.eval(() => {
      const el = document.querySelector('[aria-label="Scan the payer\'s signed code"]');
      if (el) el.click();
    });
    await driver.waitForText('Scan the payer\'s signed code', {timeoutMs: 5_000});
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solpayUri);

    // 6. Assert success: "Received" + the signature.
    const status = await driver.findByTestID('sol-req-status', {timeoutMs: 15_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/Received/.test(statusTxt), `the merchant should see "Received", got: "${statusTxt}"`);
    console.log(`[51-sol-merchant-broadcast] ✓ ${statusTxt}`);

    const sigEl = await driver.findByTestID('sol-req-sig', {timeoutMs: 5_000});
    const sigTxt = await sigEl.evaluate((n) => (n.textContent ?? '').trim());
    assert(sigTxt.length > 0, `the received signature should be rendered, got: "${sigTxt}"`);
    console.log(`[51-sol-merchant-broadcast] ✓ signature: ${sigTxt.slice(0, 24)}…`);

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
