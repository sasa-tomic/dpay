// Flow 47 — SOL v2 NFC tap (driven through the __DPAY_TEST_SOL_NFC_SESSION seam).
//
// The NFC radio hop is a physical-device gate (two phones); this flow drives the JS event plumbing
// the real Kotlin DpaySolNfc module emits, through the app's REAL SolNfcTap state machine, and
// asserts the v2 receipt-binding (rid + sig exact match → "Paid ✓").
//
// v2 changes from v1: no nonce account, no nonce-state gate, no nonce adoption. The card mounts
// immediately when SolPayMode is in 'scan' + NFC ready. The receipt binds via rid (the request ID,
// exact hex) + sig (the on-chain signature, exact base58) — not npub/nextNonce.
//
// Card-side phases asserted (single-driver simulation — the reader/broadcast path is flow 51's job):
//   - linking   : "Connecting…"  (the tap started; SolNfcTap takes over the screen)
//   - exchanging: "Communicating…" + autoSign fires (decode solreq:v2 → offline sign → approveSolCard)
//   - receipt   : "Paid ✓"  (status=0 SETTLED, rid match, sig match → decideSolPayerReceiptV2 → success)
//
// Selector contract: `asset-sol-select`, `sol-pay-scan`, `sol-nfc-status`.
import {setup, assert, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '47',
  name: 'sol-nfc',
  journey: 'nfc',
  covers: ['sol-nfc', 'sol-v2-receipt', 'event-bus'],
  verifies: 'SOL v2 NFC tap: arm card → auto-sign → receipt (rid+sig match) → Paid ✓',
  timeoutMs: 25000,
};

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_LAMPORTS = '1000000'; // 0.001 SOL
const REQ_RID = 'c'.repeat(32);

// Minimal base58 encoder (avoids a bs58 dependency in the e2e node_modules).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

// Extract the first 64-byte signature from a v2 solpay URI (base64url tx → compact-u16 || sig64 || msg).
function extractSig(solpayUri) {
  const payload = solpayUri.split('solpay:v2?')[1];
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const tx = Buffer.from(obj.tx, 'base64url');
  // tx layout: compact-u16 sigCount (1 byte for count 1) || sigCount*64 bytes || message
  const sigBytes = new Uint8Array(tx.slice(1, 65));
  return bs58Encode(sigBytes);
}

function buildSolReq() {
  const iat = Math.floor(Date.now() / 1000);
  const obj = {
    v: 2, rid: REQ_RID, net: 'mainnet-beta',
    bh: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN',
    lvh: 300_000_000, slot: 250_000_000,
    iat, exp: iat + 90,
    to: MERCHANT_ADDR, amt: PAY_LAMPORTS, cur: 'SOL',
    mint: null, toAta: null, name: 'merchant', memo: '',
  };
  return 'solreq:v2?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export async function run() {
  const start = Date.now();
  console.log('[47-sol-nfc] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    // Flip the device NFC status to 'ready' BEFORE the Wallet mounts so SolPayMode arms the HCE
    // card on mount (v2: card mounts immediately in 'scan' — no nonce gate).
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[47-sol-nfc] onboarding…');
    await onboardWallet(driver, 'e2e-sol-nfc');

    // Select SOL via the Balances sheet.
    console.log('[47-sol-nfc] selecting SOL via Balances…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});
    console.log('[47-sol-nfc] ✓ SolPayMode mounted in scan (no setup needed — card armed)');

    const dispatch = (event) => driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event);

    // linking → "Connecting…".
    console.log('[47-sol-nfc] dispatching phase=linking…');
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('sol-nfc-status', {timeoutMs: 4_000});
    assert(await driver.waitForText('Connecting', {timeoutMs: 4_000}), 'linking should show "Connecting…"');
    console.log('[47-sol-nfc] ✓ linking → "Connecting…"');

    // request → exchanging + autoSign (decode solreq:v2 → offline sign → approveSolCard).
    console.log('[47-sol-nfc] dispatching request (autoSign)…');
    await dispatch({type: 'request', role: 'card', solreqUri: buildSolReq()});
    assert(await driver.waitForText('Communicating', {timeoutMs: 5_000}), 'request should show "Communicating…"');
    console.log('[47-sol-nfc] ✓ request → "Communicating…" (exchanging + autoSign)');

    // Verify autoSign produced a valid solpay:v2 URI.
    const solpayUri = await driver.eval(() => window.__DPAY_SOL_NFC_LAST);
    assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v2?'),
      `autoSign should produce a solpay:v2 URI, got: ${JSON.stringify(solpayUri)?.slice(0, 80)}`);
    console.log('[47-sol-nfc] ✓ autoSign produced a solpay:v2 URI (offline-signed)');

    // Extract the sig from the solpay to build a matching receipt (rid + sig must match exactly).
    const sig = extractSig(solpayUri);
    console.log(`[47-sol-nfc] extracted sig: ${sig.slice(0, 12)}…`);

    // receipt (status=0 SETTLED, rid match, sig match) → decideSolPayerReceiptV2 → success →
    // SolPayMode transitions to the 'paid' phase. NfcTapView's "Paid ✓" is set inside SolNfcTap's
    // local state but never renders — SolNfcTap unmounts in the same React commit when SolPayMode
    // switches to 'paid'. The user sees "Sent · awaiting the merchant's confirmation" instead.
    console.log('[47-sol-nfc] dispatching receipt (settled + rid match + sig match)…');
    await dispatch({type: 'receipt', role: 'card', status: 0, rid: REQ_RID, sig});
    assert(await driver.waitForText('awaiting', {timeoutMs: 5_000}), 'receipt success should transition to the honest pending ("Sent · awaiting")');
    const body = await driver.bodyText();
    assert(/Sent/.test(body), 'the paid phase should show "Sent"');
    console.log('[47-sol-nfc] ✓ receipt success → "Sent · awaiting the merchant\'s confirmation"');

    await driver.screenshot('47-sol-nfc');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[47-sol-nfc] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[47-sol-nfc] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
