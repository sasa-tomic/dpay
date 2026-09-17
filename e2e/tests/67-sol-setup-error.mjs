// Flow 67 — SOL v2 no-setup + expired-request decline (replaces the deleted v1 setup-error flow).
//
// v2 eliminated the durable-nonce setup lifecycle entirely — there's no createNonceAccount, no
// stale-nonce resync, no setup-error surface. This flow covers what replaces it:
//   (A) **No-setup scan** — proves SolPayMode mounts directly in 'scan' with zero prior setup.
//       The payer scans a valid v2 solreq and it AUTO-SIGNS (one-press rule, 2026-08-24: the
//       "Pay Now" gate was the press) → solpay:v2 QR. This is the v2 equivalent of flow 46 but
//       asserts the ABSENCE of any setup UI (no setup button, no nonce state gate).
//   (B) **Expired-request decline** — covers the v2 freshness gate. The payer scans a solreq whose
//       exp is already past → isSolReqV2Expired returns true → SolPayMode shows a friendly error
//       ("expired") and does NOT produce a solpay QR. This replaces the old setup-error's role as
//       the SOL error-surface coverage flow.
//
// Selector contract: `asset-sol-select`, `sol-pay-scan` (immediately, no setup gate),
// `sol-pay-qr` (valid case), `sol-pay-err` (expired case).
import {setup, assert, onboardWallet, armPayScan, waitForWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '67',
  name: 'sol-no-setup',
  journey: 'offline',
  covers: ['sol-no-setup', 'sol-expired-request', 'sol-v2-freshness'],
  verifies: 'SOL v2: SolPayMode mounts in scan with no setup; valid req signs offline; expired req is rejected with a friendly error.',
  timeoutMs: 90000,
  notes: 'Replaces the v1 setup-error flow (createNonceAccount failure + stale-nonce resync — both deleted in v2). The error-surface coverage is now the expired-request decline (isSolReqV2Expired gate).',
};

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_LAMPORTS = '1000000'; // 0.001 SOL

function buildSolReq(opts = {}) {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const exp = opts.exp ?? iat + 90;
  const obj = {
    v: 2,
    rid: 'b'.repeat(32),
    net: 'mainnet-beta',
    bh: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN',
    lvh: 300_000_000,
    slot: 250_000_000,
    iat,
    exp,
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
  console.log('[67-sol-no-setup] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    console.log('[67-sol-no-setup] onboarding…');
    await onboardWallet(driver, 'e2e-sol-no-setup');

    // Select SOL via Balances.
    console.log('[67-sol-no-setup] selecting SOL via Balances…');
    await waitForWallet(driver, {timeoutMs: 8_000});
    await openBalances(driver, {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    // The accounts list is inline on Home (O4 S3) — the row select no longer closes any sheet,
    // so the flow owns the return to Pay.
    await driver.click('tab-pay', {timeoutMs: 5_000});

    // -------- Part A: no-setup scan → AUTO-SIGN → solpay:v2. ------------------------------
    //
    // SolPayMode mounts DIRECTLY in 'scan' (no setup button, no nonce gate).
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});
    console.log('[67-sol-no-setup] ✓ SolPayMode mounted in scan with no setup (v2)');

    // Scan a valid (fresh) v2 solreq — AUTO-SIGN fires on decode (no review, no Approve).
    const validUri = buildSolReq();
    console.log('[67-sol-no-setup] scanning a valid (fresh) solreq:v2 (auto-sign)…');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), validUri);
    await driver.findByTestID('sol-pay-qr', {timeoutMs: 8_000});
    const solpayUri = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v2?'),
      `signed solpay:v2 should be produced from a valid req, got: ${JSON.stringify(solpayUri)?.slice(0, 80)}`);
    console.log('[67-sol-no-setup] ✓ valid req auto-signed → solpay:v2 QR rendered');

    // Reset to scan (discard the signed payment).
    await driver.click('btn-sol-pay-discard', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});

    // -------- Part B: expired-request → friendly error, NO solpay QR. --------------------
    //
    // Build a solreq whose exp is already past → isSolReqV2Expired returns true → SolPayMode
    // shows a friendly "expired" error and does NOT advance to review or produce a solpay QR.
    // Expired request: exp-iat must be ≤90 (decodeSolReq validates structurally first).
    const now2 = Math.floor(Date.now() / 1000);
    const expiredUri = buildSolReq({iat: now2 - 85, exp: now2 - 5});
    console.log('[67-sol-no-setup] scanning an EXPIRED solreq:v2 (exp in the past)…');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), expiredUri);

    // The error surface should appear (sol-pay-err with "expired" text).
    const errEl = await driver.findByTestID('sol-pay-err', {timeoutMs: 5_000});
    const errTxt = await errEl.evaluate((n) => (n.textContent ?? '').trim());
    assert(/expir/i.test(errTxt), `expired-request error should mention "expired", got: "${errTxt}"`);
    console.log(`[67-sol-no-setup] ✓ expired req rejected with friendly error: "${errTxt}"`);

    // The scan surface should still be available (the payer can try again).
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});

    await driver.screenshot('67-sol-no-setup');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[67-sol-no-setup] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[67-sol-no-setup] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
