// Flow 74 — SOL v2 USDC full payment cycle (merchant create → payer sign → merchant broadcast).
//
// Closes the coverage gap: flow 51 proves the SOL cycle; this proves the USDC@Sol cycle — the ONLY
// code path that exercises `signSplPayment` (TransferChecked with mint + decimals) and
// `buildCanonicalUsdcMessage` end-to-end through the REAL app. If the SPL signing or the
// TransferChecked instruction builder has a bug, this flow catches it.
//
// Approach (mirrors flow 51 but with USDC selected):
//   1. Select USDC@Sol → Receive tab → enter amount → Request.
//   2. createSolPaymentRequest (ONLINE stub: getGenesisHash + getLatestBlockhash) → USDC solreq:v2 QR.
//   3. Switch to Pay tab → NFC autoSign receives the USDC request → signSplPayment builds a REAL
//      TransferChecked tx + Ed25519 signs → capture the solpay:v2 URI.
//   4. Extract the first sig → stash for the stub's sendTransaction to echo (v2 strict verify).
//   5. Switch back to Receive → scan the signed solpay → broadcastSolPayment (strict verify +
//      freshness) → "Received" + signature.
//
// Selector contract: `asset-sol-usdc-select`, `tab-receive`, `sol-req-amount-input`,
// `btn-sol-req-make`, `sol-req-qr`, `sol-req-status`, `sol-req-sig`, `sol-pay-scan`.
import {setup, assert, onboardWallet, armNfcCard} from '../harness/lib.mjs';
import {solTxDetailFromSolpay} from '../harness/soltx.mjs';

export const meta = {
  id: '74',
  name: 'sol-usdc-payment',
  journey: 'offline',
  covers: ['sol-usdc-payment', 'sol-spl-sign', 'sol-merchant', 'sol-broadcast', 'sol-v2-strict-verify'],
  verifies: 'USDC@Sol v2 full cycle: createSolPaymentRequest (USDC) → signSplPayment (TransferChecked) → broadcast → Received.',
  timeoutMs: 30000,
};

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
  console.log('[74-sol-usdc-payment] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[74-sol-usdc-payment] onboarding…');
    await onboardWallet(driver, 'e2e-sol-usdc-pay');

    // Install the SOL RPC stub (same shape as flow 51 — USDC uses the same RPC methods).
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2000000', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN', lastValidBlockHeight: 300000000}}),
        isBlockhashValid: () => ({context: {slot: 250000001}, value: true}),
        getBlockHeight: () => 250000001,
        sendTransaction: () => globalThis.__DPAY_TEST_SOL_SIG || 'sig_fallback',
        getSignatureStatuses: () => ({context: {slot: 250000002}, value: [{confirmationStatus: 'confirmed'}]}),
        getTransaction: () => globalThis.__DPAY_TEST_SOL_TX_DETAIL ?? null,
        getBalance: () => ({value: 5000000000}),
      };
    });

    // 1. Select USDC@Sol → Receive tab → create the USDC solreq:v2 QR.
    console.log('[74-sol-usdc-payment] selecting USDC@Sol + switching to Receive…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-usdc-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-usdc-select', {timeoutMs: 5_000});

    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});

    console.log('[74-sol-usdc-payment] creating the USDC solreq:v2 QR (ONLINE)…');
    await driver.type('sol-req-amount-input', '2.5', {timeoutMs: 5_000});
    await driver.click('btn-sol-req-make', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 8_000});

    // 2. Capture the solreq:v2 URI + verify it carries USDC fields (mint + toAta).
    const solreqUri = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof solreqUri === 'string' && solreqUri.startsWith('solreq:v2?'),
      `the solreq:v2 QR must be captured, got: ${JSON.stringify(solreqUri)?.slice(0, 80)}`);
    const reqPayload = JSON.parse(Buffer.from(solreqUri.split('solreq:v2?')[1], 'base64url').toString());
    assert(reqPayload.cur === 'USDC', `request should be USDC, got cur: ${reqPayload.cur}`);
    assert(reqPayload.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      `request should carry the USDC mint, got mint: ${reqPayload.mint}`);
    assert(typeof reqPayload.toAta === 'string' && reqPayload.toAta.length > 0,
      `request should carry the merchant ATA, got toAta: ${reqPayload.toAta}`);
    console.log('[74-sol-usdc-payment] ✓ USDC solreq:v2 QR created (mint + toAta present)');

    // 3. Switch to Pay tab → NFC review → the payer's Approve click produces a REAL signed
    //    solpay:v2 via signSplPayment — AUTO-SIGNED on arrival (one-press rule, 2026-08-24).
    console.log('[74-sol-usdc-payment] switching to Pay tab + NFC request auto-sign (USDC TransferChecked)…');
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
    console.log('[74-sol-usdc-payment] ✓ auto-sign produced a real signed USDC solpay:v2 (TransferChecked)');

    // 4. Extract the sig + stash it so the stub's sendTransaction echoes it back.
    const sig = extractSig(solpayUri);
    await driver.eval((s) => { globalThis.__DPAY_TEST_SOL_SIG = s; }, sig);
    console.log(`[74-sol-usdc-payment] sig extracted + stashed: ${sig.slice(0, 12)}…`);

    // 4b. Seed the settle-gate fixture from the REAL TransferChecked canonical bytes (the re-read
    //     must recompile to the same legacy message — this is what makes it matching).
    const detail = solTxDetailFromSolpay(solpayUri);
    await driver.eval((d) => { globalThis.__DPAY_TEST_SOL_TX_DETAIL = d; }, detail);
    console.log('[74-sol-usdc-payment] settle-gate getTransaction fixture seeded from the signed USDC tx');

    // Dismiss the NFC overlay.
    await driver.eval(() => {
      const btn = document.querySelector('button[aria-label="Done"]') || document.querySelector('button[aria-label="Cancel"]');
      if (btn) btn.click();
    });
    await driver.waitGone('sol-nfc-status', {timeoutMs: 5_000});

    // 5. Switch back to Receive → scan the signed solpay → broadcast → "Received".
    console.log('[74-sol-usdc-payment] switching to Receive + scanning the signed USDC solpay…');
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
    console.log(`[74-sol-usdc-payment] ✓ ${statusTxt}`);

    const sigEl = await driver.findByTestID('sol-req-sig', {timeoutMs: 5_000});
    const sigTxt = await sigEl.evaluate((n) => (n.textContent ?? '').trim());
    assert(sigTxt.length > 0, `the received signature should be rendered, got: "${sigTxt}"`);
    console.log(`[74-sol-usdc-payment] ✓ signature: ${sigTxt.slice(0, 24)}…`);

    await driver.screenshot('74-sol-usdc-payment');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[74-sol-usdc-payment] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[74-sol-usdc-payment] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
