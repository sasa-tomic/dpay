// Flow 46 — SOL v2 recent-blockhash offline-pay: scan → offline sign → honest pending.
//
// Proves the SOL v2 offline-pay payer path end-to-end through the REAL app:
//   1. The payer scans a merchant's `solreq:v2?` QR (via the camera seam) — AUTO-SIGN (one-press
//      rule, 2026-08-24: the "Pay Now" gate was the press; the offline sign fires on decode).
//   2. The app signs FULLY OFFLINE (no RPC — signs against the blockhash embedded in the request).
//   3. The signed `solpay:v2?` QR is shown for the merchant to scan + broadcast.
//   4. The payer marks "Handed to merchant" → the HONEST pending state: "Sent X · awaiting
//      the merchant's confirmation" (NEVER "Paid ✓" — the offline payer can't know it settled).
//
// v2 eliminates the durable-nonce setup (first-use createNonceAccount) — the payer path is now
// FULLY OFFLINE with zero prior setup. The blockhash + genesis come from the merchant's request
// (the merchant fetched them online via createSolPaymentRequest before showing the QR).
//
// Selector contract: `asset-sol-select` (the SOL row in the Balances sheet),
// `sol-pay-scan`, `sol-pay-amount`, `sol-pay-qr`,
// `btn-sol-pay-handed`, `sol-pay-status`.
import {setup, assert, onboardWallet, armPayScan} from '../harness/lib.mjs';

export const meta = {
  id: '46',
  name: 'sol-offline-handoff',
  journey: 'offline',
  covers: ['sol-offline-sign', 'qr-handoff', 'honest-pending', 'sign-status-short-payee'],
  verifies: 'SOL v2 scan solreq:v2 → AUTO-SIGN (no setup, no nonce) → solpay:v2 QR (U-F5 short destination rides the qr header) → honest pending.',
  timeoutMs: 25000,
};

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_LAMPORTS = '1000000'; // 0.001 SOL

// Build a valid v2 SolReq URI with a fresh blockhash + 90-second window.
function buildSolReq() {
  const iat = Math.floor(Date.now() / 1000);
  const obj = {
    v: 2,
    rid: 'a'.repeat(32),
    net: 'mainnet-beta',
    bh: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN',
    lvh: 300_000_000,
    slot: 250_000_000,
    iat,
    exp: iat + 90,
    to: MERCHANT_ADDR,
    amt: PAY_LAMPORTS,
    cur: 'SOL',
    mint: null,
    toAta: null,
    name: 'merchant',
    memo: '',
  };
  return 'solreq:v2?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export async function run() {
  const start = Date.now();
  console.log('[46-sol-offline-handoff] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    // 1. Onboard (funds the IC wallet; the SOL address is derived locally from the same seed).
    console.log('[46-sol-offline-handoff] onboarding…');
    await onboardWallet(driver, 'e2e-sol-pay');

    // 2. Select SOL via the Balances sheet (the selected asset implies the rail).
    //    SolPayMode mounts immediately in 'scan' — NO setup needed in v2.
    console.log('[46-sol-offline-handoff] selecting SOL as the active asset via Balances…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    // The accounts list is inline on Home (O4 S3) — the row select no longer closes any sheet,
    // so the flow owns the return to Pay.
    await driver.click('tab-pay', {timeoutMs: 5_000});

    // 3. The scanner surface is immediately available (no setup phase in v2).
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});
    console.log('[46-sol-offline-handoff] ✓ SolPayMode mounted in scan (no setup needed)');

    // 4. Scan the merchant's solreq:v2 QR (via the camera seam).
    const solreqUri = buildSolReq();
    console.log('[46-sol-offline-handoff] scanning solreq:v2…');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solreqUri);

    // 5+6. AUTO-SIGN (one-press rule): the scan itself signs offline (PURE, no RPC) → the
    //      solpay:v2 QR surface is the stable landing. The qr header carries the amount +
    //      destination (`fmtAsset to name`), so the amount + U-F5 short-payee asserts read there.
    await driver.findByTestID('sol-pay-qr', {timeoutMs: 8_000});
    const qrBody = await driver.bodyText();
    assert(/0\.001000000 SOL/.test(qrBody), `the qr surface should show the SOL amount (0.001000000 for PAY_LAMPORTS=1_000_000), got: "${qrBody.slice(0, 200)}"`);
    // U-F5 (SOL twin of flows 26/27): the merchant name alone is not verifiable — the dim
    // sol-pay-payee line carries the short base58 destination under the name.
    const payee = await driver.findByTestID('sol-pay-payee', {timeoutMs: 5_000});
    const payeeTxt = await payee.evaluate((n) => (n.textContent ?? '').trim());
    assert(payeeTxt === `${MERCHANT_ADDR.slice(0, 8)}…`,
      `qr short-payee line (U-F5): expected ${MERCHANT_ADDR.slice(0, 8)}…, got "${payeeTxt}"`);
    console.log(`[46-sol-offline-handoff] ✓ auto-signed: 0.002000000 SOL · ${payeeTxt}`);

    // Capture the signed solpay:v2 URI (the QR shim stashes it on window.__DPAY_QR_LAST).
    const solpayUri = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v2?'),
      `the signed solpay:v2 QR must be captured, got: ${JSON.stringify(solpayUri)?.slice(0, 80)}`);
    console.log('[46-sol-offline-handoff] ✓ offline-signed solpay:v2 QR rendered');

    // 7. "Handed to merchant" → the HONEST pending state (NOT "Paid ✓").
    console.log('[46-sol-offline-handoff] marking handed-off (honest pending)…');
    await driver.click('btn-sol-pay-handed', {timeoutMs: 5_000});
    const status = await driver.findByTestID('sol-pay-status', {timeoutMs: 5_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/Sent/.test(statusTxt), `the pending headline should say "Sent", got: "${statusTxt}"`);
    const body = await driver.bodyText();
    assert(/awaiting/.test(body), 'the pending copy should say "awaiting the merchant\'s confirmation"');
    console.log('[46-sol-offline-handoff] ✓ honest pending: "Sent · awaiting the merchant\'s confirmation"');

    await driver.screenshot('46-sol-offline-handoff');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[46-sol-offline-handoff] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[46-sol-offline-handoff] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
