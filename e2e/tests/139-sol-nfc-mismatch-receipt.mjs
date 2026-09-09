// Flow 139 — SOL v2 NFC receipt with status 3 (RECEIPT_MISMATCH): the payer NEVER sees a decline.
//
// Settle-verify (OPEN_ISSUES 6(b)) adds receipt code 3: the merchant re-read the confirmed
// transaction and its body was NOT the canonical request. That is terminal doubt for the MERCHANT
// — but the PAYER did sign and hand over a real tx, so code 3 maps to honest pending exactly like
// UNREACHABLE (three-verdict discipline: an outcome the payer's phone cannot verify is never
// promoted to a decline). The real Kotlin hop needs no change (unknown codes → PENDING card phase,
// re-emitted verbatim); this flow drives the same event the card emits through the REAL
// SolNfcTap/SolPayMode state machine (flow-47 synthetic-receipt idiom).
//
// Asserts: receipt(status=3, rid+sig EXACT match) → decideSolPayerReceiptV2 → 'pending' → the
// honest "Sent · awaiting the merchant's confirmation" phase — NOT a decline (no rejected copy,
// no bounce back to the scan screen).
//
// Selector contract: `asset-sol-select`, `sol-pay-scan`, `sol-nfc-status`, `__DPAY_SOL_NFC_LAST`.
import {setup, assert, onboardWallet, armNfcCard, waitForWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '139',
  name: 'sol-nfc-mismatch-receipt',
  journey: 'nfc',
  covers: ['sol-nfc', 'sol-v2-receipt', 'sol-settle-verify', 'three-verdict'],
  verifies: 'SOL NFC receipt code 3 (settle-verify mismatch) → payer honest pending ("Sent · awaiting"), never a decline.',
  timeoutMs: 25000,
};

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_LAMPORTS = '1000000'; // 0.001 SOL
const REQ_RID = 'c'.repeat(32);

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
  console.log('[139-sol-nfc-mismatch-receipt] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[139-sol-nfc-mismatch-receipt] onboarding…');
    await onboardWallet(driver, 'e2e-sol-mismatch');

    console.log('[139-sol-nfc-mismatch-receipt] selecting SOL via Balances…');
    await waitForWallet(driver, {timeoutMs: 8_000});
    await openBalances(driver, {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});

    const dispatch = async (event) => { await armNfcCard(driver, 'sol'); return driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event); };

    console.log('[139-sol-nfc-mismatch-receipt] dispatching phase=linking…');
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('sol-nfc-status', {timeoutMs: 4_000});
    assert(await driver.waitForText('Connecting', {timeoutMs: 4_000}), 'linking should show "Connecting…"');

    console.log('[139-sol-nfc-mismatch-receipt] dispatching request (auto-signs on arrival)…');
    await dispatch({type: 'request', role: 'card', solreqUri: buildSolReq()});
    assert(await driver.waitForText('Communicating', {timeoutMs: 6_000}), 'request should auto-sign → "Communicating…"');

    const solpayUri = await driver.eval(() => window.__DPAY_SOL_NFC_LAST);
    assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v2?'),
      `the auto-sign should produce a solpay:v2 URI, got: ${JSON.stringify(solpayUri)?.slice(0, 80)}`);
    const sig = extractSig(solpayUri);
    console.log(`[139-sol-nfc-mismatch-receipt] extracted sig: ${sig.slice(0, 12)}…`);

    // receipt(status=3 RECEIPT_MISMATCH, rid match, sig match) → decideSolPayerReceiptV2 →
    // 'pending' (code 3 is NEVER a decline) → the honest "Sent · awaiting" paid phase.
    console.log('[139-sol-nfc-mismatch-receipt] dispatching receipt (status=3 mismatch + rid match + sig match)…');
    await dispatch({type: 'receipt', role: 'card', status: 3, rid: REQ_RID, sig});
    assert(await driver.waitForText('awaiting', {timeoutMs: 5_000}),
      'receipt code 3 should land the honest pending ("Sent · awaiting"), exactly like unreachable');
    const body = await driver.bodyText();
    assert(/Sent/.test(body), 'the paid phase should show "Sent"');
    assert(!/rejected/i.test(body), 'a mismatch receipt must NEVER surface a rejection to the payer');
    assert(!(await driver.isPresent('sol-pay-scan')),
      'a mismatch receipt must NOT bounce the payer back to scan (that is the decline treatment)');
    console.log('[139-sol-nfc-mismatch-receipt] ✓ honest pending, never declined');

    await driver.screenshot('139-sol-nfc-mismatch-receipt');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[139-sol-nfc-mismatch-receipt] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[139-sol-nfc-mismatch-receipt] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
