// Flow 46 — SOL offline-pay: durable-nonce setup → scan → offline sign → honest pending.
//
// Proves the SOL offline-pay feature end-to-end through the REAL app:
//   1. The payer creates a durable-nonce account (first-use setup, via the stub RPC simulator).
//   2. The payer scans a merchant's `solreq:` QR (via the camera seam), reviews, Approves.
//   3. The app signs FULLY OFFLINE (no RPC — signs against the stored durable-nonce value).
//   4. The signed `solpay:` QR is shown for the merchant to scan + broadcast.
//   5. The payer marks "Handed to merchant" → the HONEST pending state: "Sent X · awaiting
//      the merchant's confirmation" (NEVER "Paid ✓" — the offline payer can't know it settled).
//
// The stub RPC (`__DPAY_TEST_SOLANA_RPC_STUB`) simulates a Solana node: it returns rent-exempt
// minimums, accepts transactions, confirms them immediately, and serves the nonce account state.
// This keeps the inner loop fully offline (no devnet) while proving the REAL app code path.
//
// Selector contract: `rail-sol` (the SOL rail of the Pay tab's segmented selector — SOL is a
// first-class asset now, selected inline via the RailSelector, not via Balances→send sheet),
// `btn-sol-pay-setup`, `sol-pay-scan`, `sol-pay-amount`, `btn-sol-pay-approve`, `sol-pay-qr`,
// `btn-sol-pay-handed`, `sol-pay-status`.
import {setup, assert, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '46',
  name: 'sol-offline-handoff',
  journey: 'offline',
  covers: ['sol-offline-sign', 'sol-nonce-setup', 'qr-handoff', 'honest-pending'],
  verifies: 'SOL durable-nonce setup → scan solreq: → offline sign → solpay: QR → honest pending.',
  timeoutMs: 25000,
};

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_LAMPORTS = '1000000'; // 0.001 SOL

// Build the 80-byte NonceState account data as base64 (the layout getNonceAccount parses).
// u32(0) version | u32(1) state=Initialized | 32B authority | 32B nonce value | u64 fee.
function nonceAccountB64() {
  const buf = Buffer.alloc(80, 0);
  buf.writeUInt32LE(0, 0);    // version
  buf.writeUInt32LE(1, 4);    // state = Initialized
  buf.fill(1, 8, 40);         // authority (arbitrary — createNonceAccount ignores .authority)
  Buffer.from('deadbeef'.repeat(8), 'hex').copy(buf, 40); // nonce value (deadbeef×8)
  buf.writeBigUInt64LE(5000n, 72); // fee.lamports_per_signature
  return buf.toString('base64');
}

function buildSolReq() {
  const obj = {
    v: 1, to: MERCHANT_ADDR, amt: PAY_LAMPORTS, cur: 'SOL',
    mint: null, toAta: null,
    exp: Math.floor(Date.now() / 1000) + 600,
    name: 'merchant', memo: '',
  };
  return 'solreq:v1?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export async function run() {
  const start = Date.now();
  console.log('[46-sol-offline-handoff] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // 1. Onboard (funds the IC wallet; the SOL address is derived locally from the same seed).
    console.log('[46-sol-offline-handoff] onboarding…');
    await onboardWallet(driver, 'e2e-sol-pay');

    // 2. Install the SOL RPC stub (simulates a Solana node for createNonceAccount).
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

    // 3. SOL is a first-class asset now: select the SOL rail on the Pay tab (the default tab after
    //    onboarding) to mount SolPayMode INLINE. The RailSelector pre-selects the NFC HCE service
    //    (DpaySolNfc AID ..02) — this MUST happen before any tap, so the rail is user-chosen, not
    //    auto-detected. (Was reached via Balances → SOL send sheet → 'Pay offline instead' link,
    //    now removed; the direct rail path is faster — no Balances detour.)
    console.log('[46-sol-offline-handoff] selecting the SOL rail on the Pay tab…');
    await driver.findByTestID('rail-sol', {timeoutMs: 8_000});
    await driver.click('rail-sol', {timeoutMs: 5_000});

    // 4. First-use setup: create the durable-nonce account (online, via stub).
    console.log('[46-sol-offline-handoff] setting up durable-nonce account…');
    await driver.findByTestID('btn-sol-pay-setup', {timeoutMs: 5_000});
    await driver.click('btn-sol-pay-setup', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 12_000});
    console.log('[46-sol-offline-handoff] ✓ durable-nonce account created (stub)');

    // 5. Scan the merchant's solreq: QR (via the camera seam).
    const solreqUri = buildSolReq();
    console.log('[46-sol-offline-handoff] scanning solreq:…');
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solreqUri);

    // 6. Review: the amount + merchant name are shown.
    const amount = await driver.findByTestID('sol-pay-amount', {timeoutMs: 5_000});
    const amountTxt = await amount.evaluate((n) => (n.textContent ?? '').trim());
    assert(/SOL/.test(amountTxt), `review should show the SOL amount, got: "${amountTxt}"`);
    console.log(`[46-sol-offline-handoff] ✓ review: ${amountTxt}`);

    // 7. Approve → offline sign (PURE, no RPC) → solpay: QR.
    console.log('[46-sol-offline-handoff] approving (offline sign)…');
    await driver.click('btn-sol-pay-approve', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-qr', {timeoutMs: 5_000});

    // Capture the signed solpay: URI (the QR shim stashes it on window.__DPAY_QR_LAST).
    const solpayUri = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v1?'),
      `the signed solpay: QR must be captured, got: ${JSON.stringify(solpayUri)?.slice(0, 80)}`);
    console.log('[46-sol-offline-handoff] ✓ offline-signed solpay: QR rendered');

    // 8. "Handed to merchant" → the HONEST pending state (NOT "Paid ✓").
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
