// Flow 08 — Merchant receive → settle (the RECIPIENT side, explicitly).
//
// The mirror of flow 07 from the recipient's perspective, on the IC rail. Wallet B (the merchant)
// is onboarded in the browser and requests ∂30; wallet A (the payer) is generated + faucet-funded
// in-test. A signs a REAL icrc1_transfer envelope for B's request (wire.mjs golden oracle,
// byte-identical to the app's wasm signer; memo = the request nonce) and hands the base64url
// envelope to B's app through the offline-payer scan affordance. B's app decodes it, submits it to
// the fake-IC /api/v2 gateway, and its read_state poll reconciles the request → "Received". This is
// the "merchant online-confirm" half of the two-phone flow: the recipient learns the payment settled
// through ITS OWN submission + ledger-sourced poll, not a payer-presented claim. Asserts the
// recipient-side state EXPLICITLY:
//   - B's app reaches "Received ∂30.00" (B submitted the payer's envelope itself).
//   - B's `$` balance grew by the amount (currency 0, fake-IC ledger).
//   - B's Recent history shows the INCOMING payment from A — as A's short PRINCIPAL text (rail rows
//     are name-less; memo is the reconciliation key).
//
// Selector contract: `tab-receive`, `amount-input`, `btn-request`, `request-qr`, `balance`.
import {
  setup,
  assert,
  getBalance,
  faucetAccount,
  icpCatalog,
  railPrincipalText,
  onboardWallet,
  accountOf,
  openBalances,
} from '../harness/lib.mjs';
import { openHistory } from '../harness/flow-steps.mjs';
import { generateKeypair, icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate, b64urlEncode } from '../harness/wire.mjs';
import { parsePayLink } from '../harness/paylink.mjs';

const PAY_CENTS = 3000; // ∂30.00
const DEMO_LEDGER = 'td2nx-oaaaa-aaaab-qhdnq-cai'; // REAL DUSD ledger (catalog currency 0; the fake-IC gateway registers its ledger at this principal text — asserted against the catalog below)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '08',
  name: 'merchant-settle',
  journey: 'pay',
  covers: ['receive', 'settle', 'confirmation'],
  verifies: 'Merchant scans the payer\'s signed icrc1_transfer envelope, submits it to the IC gateway → recipient \'Received\' confirmation.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[08-merchant-settle] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- wallet A (payer): generated + faucet-funded in-test (the offline-style payer). ----------
    const alice = await generateKeypair();
    const fundA = await faucetAccount(relayBaseURL, alice.publicHex, 10_000);
    assert(fundA.ok, `payer A faucet funding must succeed, got ${fundA.status}`);
    const alicePrincipal = await railPrincipalText(alice.publicHex);
    console.log(`[08-merchant-settle] wallet A (payer, funded ∂100): ${alicePrincipal.slice(0, 10)}…`);

    // --- wallet B (merchant): onboarded in the browser. ---------------------------------------
    console.log('[08-merchant-settle] onboarding wallet B (merchant)…');
    await onboardWallet(driver, 'e2e-merchant');
    const bob = await accountOf(driver);
    const bobHex = bob.publicHex;

    // --- B creates a ∂30 receive request; read the request QR the app rendered + decode it. ----
    console.log('[08-merchant-settle] B requesting ∂30.00…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '30.00', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    // The QR is the payment LINK now (founder 2026-09-12) — the reconciliation key the payer must
    // memo on-chain is the link's `ref`, and the recipient is B's own principal.
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    const link = parsePayLink(requestQR);
    assert(link !== null, `the request QR must BE the payment link, got "${requestQR}"`);
    assertEqHex(link.recipient, await railPrincipalText(bobHex), 'B link.recipient == B principal');
    assertEq(link.amount, '30.00', 'B link.amount == ∂30.00');
    assert(/^[0-9a-f]{32}$/.test(link.ref ?? ''), `the link's ref must be the 16-byte request nonce, got "${link.ref}"`);
    const nonceHex = link.ref;
    console.log(`[08-merchant-settle] B request nonce=${nonceHex.slice(0, 12)}…`);

    // --- A signs a REAL icrc1_transfer envelope for B's request (memo = the request nonce). -----
    // Byte-identical to the app's wasm signer (cross-validated in flow 00), so the fake-IC gateway
    // verifies A's signature and executes the transfer when B's app submits it.
    console.log('[08-merchant-settle] A signing the icrc1_transfer envelope…');
    const catalog = await icpCatalog(relayBaseURL);
    const ledger = catalog.find(c => c.currency === 0)?.ledger;
    assertEq(ledger, DEMO_LEDGER, 'catalog currency 0 ledger');
    const arg = icpTransferArgBytes(icpPrincipalBytes(bobHex), BigInt(PAY_CENTS), {fee: null, memoHex: nonceHex});
    const expiryNs = BigInt(Date.now() + 300_000) * 1_000_000n;
    const signed = await icpSignUpdate(alice.secretHex, ledger, 'icrc1_transfer', arg, expiryNs);
    const envelopeB64 = b64urlEncode(hexBytes(signed.envelopeHex));
    console.log('[08-merchant-settle] ✓ envelope signed (request_id=' + signed.requestIdHex.slice(0, 12) + '…)');

    // --- Hand the envelope to B's app through the offline-payer scan affordance. ----------------
    // B scans A's signed QR (injected via the camera seam) → onSignedQr decodes + submits it to
    // /api/v2/canister/<ledger>/call → the gateway verifies + executes → B's read_state poll
    // reconciles the open request → "Received".
    await openPayerScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), envelopeB64);
    console.log('[08-merchant-settle] B scanned the payer\'s envelope — app submitting to the IC gateway…');

    // --- B's app confirms receipt via its read_state poll → "Received ∂30.00". -----------------
    const received = await driver.waitForText('Received ∂30.00', { timeoutMs: 12_000 });
    assert(received, 'merchant B should reach the "Received ∂30.00" screen after submitting the payer\'s envelope');
    console.log('[08-merchant-settle] ✓ B app shows "Received ∂30.00" (ledger-sourced confirmation)');

    // --- B's `$` balance grew by the amount. --------------------------------------------------
    await openBalances(driver); // the practice balance reads on the accounts route (currency-first chip headlines MAIN)
    const bobUp = await driver.waitForText('∂130.00', { timeoutMs: 10_000});
    assert(bobUp, `merchant B balance should be ∂130.00 (∂100 + ∂30) after the settle`);
    const bobLedger = await getBalance(relayBaseURL, bobHex, 0);
    assert(bobLedger === '13000', `B ledger balance must be 13000 cents, got ${bobLedger}`);
    const aliceLedger = await getBalance(relayBaseURL, alice.publicHex, 0);
    assert(aliceLedger === '7000', `A ledger balance must be 7000 cents (10000 − 3000), got ${aliceLedger}`);
    console.log('[08-merchant-settle] ✓ B balance ∂100.00 → ∂130.00 (A debited once)');

    // --- B's Recent history shows the INCOMING payment from A (recipient row, short principal). -
    assert(await openHistory(driver), 'B history should render the incoming payment');
    // The history hook polls (POLL.history); the transfer row may land after RECENT first paints.
    // Poll for the payer's short principal rather than snapshotting once.
    const shortPayer = alicePrincipal.slice(0, 8);
    const named = await driver.waitForText(shortPayer, { timeoutMs: 10_000 });
    const histBody = await driver.bodyText();
    assert(named, `B history row should name the payer (short principal ${shortPayer}). history:\n${histBody.slice(0, 500)}`);
    assert(!histBody.includes(alicePrincipal), 'B history must not dump A\'s full principal text');
    console.log('[08-merchant-settle] ✓ B history shows the incoming payment from A (short principal)');

    await driver.screenshot('08-merchant-settle');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[08-merchant-settle] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

/** Open ReceiveMode's "Scan the payer's signed code" affordance (the offline-payer confirm path). The
 *  button has no testID — find the exact label text node and walk up, clicking each wrapper (RNW
 *  renders Pressables as plain elements). Same pattern as flow 21. */
async function openPayerScan(driver) {
  await driver.eval(() => {
    const nodes = Array.from(document.querySelectorAll('text, span, div, a, button, [role]'));
    const target = nodes.find(e => (e.textContent || '').trim() === "Scan the payer's signed code" && e.children.length === 0);
    if (!target) throw new Error('affordance button label node not found');
    let el = target;
    for (let i = 0; i < 5 && el; i++) {
      el.click?.();
      el = el.parentElement;
    }
  });
  const scanning = await driver.waitForText("Scan the payer's signed code", { timeoutMs: 5_000 });
  assert(scanning, 'clicking the affordance should mount the scanner (label swaps)');
}

function hexBytes(hex) {
  return Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
}

function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`[assert] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertEqHex(a, b, label) {
  if (String(a).toLowerCase() !== String(b).toLowerCase()) throw new Error(`[assert] ${label}: expected ${b}, got ${a}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[08-merchant-settle] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
