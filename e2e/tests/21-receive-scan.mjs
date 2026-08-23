// Flow 21 — receive-scan (IC rail): the MERCHANT confirms a payer's offline hand-off by scanning
// the payer's signed QR. Alice (an offline payer) signs a REAL icrc1_transfer envelope whose memo
// is the REQUEST's nonce (the reconciliation key binding payment→request), base64url-wraps it, and
// we inject it through the camera seam into the merchant B's "Scan payer's signed QR" affordance.
// B's app derives the request_id from the envelope, SUBMITS it to the fake-IC /api/v2 gateway
// (POST /call), then polls read_state until replied — the "Received" flip is ledger-sourced
// (submitted by B's own app), exactly the production confirm path.
//
// This is the envelope-twin of flow 08 (which drives the same settle from a fresh request).
import {setup, assert, assertIncludes, getBalance, faucetAccount, onboardWallet, accountOf} from '../harness/lib.mjs';
import {generateKeypair, decodeRequest, icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate, b64urlEncode} from '../harness/wire.mjs';
import {railPrincipalText} from '../harness/lib.mjs';

export const meta = {
  id: '21',
  name: 'receive-scan',
  journey: 'offline',
  covers: ['receive-scan', 'offline-settle'],
  verifies: 'merchant scans a base64url icrc1_transfer envelope (memo = request nonce) via the camera seam → app submits it to the IC gateway → read_state poll flips "Received"; balance + history follow from the ledger',
  timeoutMs: 25_000,
};

const PAY_CENTS = 2500n;

export async function run() {
  const start = Date.now();
  console.log(`[${meta.name}] pay-journey cutover: merchant-side envelope scan-confirm`);
  const env = await setup();
  try {
    // --- Payer: a funded offline wallet (keys only — the payer's phone never talks to the relay). -
    const alice = await generateKeypair();
    await faucetAccount(env.relayBaseURL, alice.publicHex, 10_000);
    const alicePrincipal = await railPrincipalText(alice.publicHex);

    // --- Merchant B: onboarded, with an OPEN Đ25 request. --------------------------------------
    await onboardWallet(env.driver, 'e2e-merchant');
    const bob = await accountOf(env.driver);
    const bobHex = bob.publicHex;
    await env.driver.click('tab-receive', {timeoutMs: 4_000});
    await env.driver.typeByPlaceholder('0.00', '25.00');
    await env.driver.click('btn-request', {timeoutMs: 4_000});
    const requestQR = await env.driver.eval(() => window.__DPAY_QR_LAST);
    const req = decodeRequest(requestQR);
    assertEqHex(req.toHex, bobHex, 'request QR payee must be merchant B');
    assertEq(req.amount, '2500', 'request QR amount must be Đ25.00');

    // --- Payer signs an icrc1_transfer envelope bound to the request (memo = nonce). -----------
    const catalog = (await (await fetch(`${env.relayBaseURL}/api/v1/currencies`)).json()).currencies;
    const ledger = catalog.find((c) => c.currency === 0).ledger;
    const arg = icpTransferArgBytes(icpPrincipalBytes(bobHex), PAY_CENTS, {fee: null, memoHex: req.nonceHex});
    const expiryNs = BigInt(Date.now() + 300_000) * 1_000_000n;
    const signed = await icpSignUpdate(alice.secretHex, ledger, 'icrc1_transfer', arg, expiryNs);
    console.log(`[${meta.name}] ✓ envelope signed (request_id=${signed.requestIdHex.slice(0, 12)}…)`);
    const envelopeB64 = b64urlEncode(hexBytes(signed.envelopeHex));

    // --- B opens the scan affordance and receives the payer's hand-off QR. ---------------------
    await openPayerScan(env.driver);
    await env.driver.eval((payload) => window.__DPAY_TEST_SCAN(payload), envelopeB64);

    // --- The Received flip — B's app submitted + reconciled the transfer via read_state. -------
    const received = await env.driver.waitForText('Received Đ25.00', {timeoutMs: 12_000});
    assert(received, 'B should reach the "Received Đ25.00" screen after scanning the payer\'s envelope');
    console.log(`[${meta.name}] ✓ B app shows "Received Đ25.00" (B submitted + reconciled)`);

    // --- Ledger truth: B credited, alice debited once. -----------------------------------------
    const bobLedger = await getBalance(env.relayBaseURL, bobHex, 0);
    assert(bobLedger === '12500', `B ledger balance must be 12500 cents, got ${bobLedger}`);
    const aliceLedger = await getBalance(env.relayBaseURL, alice.publicHex, 0);
    assert(aliceLedger === '7500', `alice ledger balance must be 7500 cents (10000 − 2500), got ${aliceLedger}`);
    console.log(`[${meta.name}] ✓ ledger: B 12500 / alice 7500`);

    // --- B's on-screen balance picked up the credit (poll-driven). -----------------------------
    const bobUp = await env.driver.waitForText('Đ125.00', {timeoutMs: 10_000});
    assert(bobUp, 'B on-screen balance should be Đ125.00 after the scan-settle');

    await env.driver.screenshot('21-receive-scan');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[${meta.name}] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

/** Open ReceiveMode's "Scan payer's signed QR" affordance (the offline-payer confirm path). The
 *  button has no testID — find the exact label text node and walk up, clicking each wrapper (RNW
 *  renders Pressables as plain elements). */
async function openPayerScan(driver) {
  await driver.eval(() => {
    const nodes = Array.from(document.querySelectorAll('text, span, div, a, button, [role]'));
    const target = nodes.find((e) => (e.textContent || '').trim() === "Scan payer's signed QR" && e.children.length === 0);
    if (!target) throw new Error('affordance button label node not found');
    let el = target;
    for (let i = 0; i < 5 && el; i++) {
      el.click?.();
      el = el.parentElement;
    }
  });
  const scanning = await driver.waitForText("Scan the payer's signed QR", {timeoutMs: 5_000});
  assert(scanning, 'B should mount the payer-QR scanner after the affordance tap');
}

function hexBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function assertEq(got, want, msg) {
  if (got !== want) throw new Error(`[assert] ${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function assertEqHex(got, want, msg) {
  if (String(got).toLowerCase() !== String(want).toLowerCase()) {
    throw new Error(`[assert] ${msg}: got ${got}, want ${want}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[${meta.name}] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
