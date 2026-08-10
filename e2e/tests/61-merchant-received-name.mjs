// Flow 61 — Merchant "Received ∂X from <name>" shows the payer's friendly name.
//
// Closes the H3/wire-v2 merchant-side gap: the payer's signed authorization carries `from_name`
// (wire-format v2), the relay records it in the TxnRecord (history rows already show it — flow 07),
// AND now also attaches it as an UNSIGNED display field on the /receipt/:nonce response so the
// merchant's polling-confirmed "Received" screen can render "from <name>" instead of the raw
// `<hex pubkey>…` short-prefix. The signed receipt body still binds only pubkeys + amount + nonce
// (verifyOutcomeReceipt is unchanged); these display fields are pure metadata.
//
// Approach (mirrors flow 50): wallet A (merchant) is onboarded in the browser; wallet B (payer) is
// a fresh in-test keypair (Node side, @noble/ed25519). B signs an authorization paying A's request
// WITH fromName='Bob' and posts directly via /api/v1/pay → FakeLedger settles → real receipt. A's
// app polls /api/v1/receipt/<nonce> → the response now carries from_name='Bob' → A's "Received"
// confirmation reads "from Bob" (not "from <hex prefix>").
//
// Selector contract: `tab-receive`, `amount-input`, `btn-request`, `request-qr`, `balance`,
// `window.__DPAY_QR_LAST` (the QR-value seam).
import { setup, assert, assertIncludes, getBalance, onboardWallet, accountOf, postPay, faucetAccount } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, signAuthorizationCode } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // ∂25.00
const PAYER_NAME = 'Bob';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '61',
  name: 'merchant-received-name',
  journey: 'pay',
  covers: ['receive', 'settle', 'confirmation', 'from-name', 'wire-v2', 'friendly-counterparties'],
  verifies: 'Merchant\'s \'Received\' confirmation shows the payer\'s friendly name (from_name) — not the raw short pubkey prefix — when the payer chose a name.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[61-merchant-received-name] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- wallet A (merchant): onboarded in the browser. ---------------------------------------
    console.log('[61-merchant-received-name] onboarding wallet A (merchant)…');
    await onboardWallet(driver, 'Alice');
    const alice = await accountOf(driver);
    const alicePub = alice.publicHex;
    console.log(`[61-merchant-received-name] wallet A (merchant): ${alicePub.slice(0, 16)}…`);

    // --- wallet B (payer): generated in-test, fauceted ∂100, signs WITH fromName='Bob'. -------
    const bob = await generateKeypair();
    console.log(`[61-merchant-received-name] wallet B (payer, "${PAYER_NAME}"): ${bob.publicHex.slice(0, 16)}…`);
    const fund = await faucetAccount(relayBaseURL, bob.publicHex, 10000);
    assert(fund.ok, `payer B faucet should succeed, got status ${fund.status}: ${JSON.stringify(fund.body)}`);

    // --- A creates a ∂25 receive request; read the request QR the app rendered + decode it. ----
    console.log('[61-merchant-received-name] A requesting ∂25.00…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '25.00', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);

    // Decode the request QR's nonce + expiry (so B can sign against them).
    const req = await driver.eval((qr) => {
      // The harness's wire.mjs builders aren't reachable from the browser context; re-derive the
      // nonce/expiry from the 132-byte request decoded as base64url. Layout (FROZEN, single-sourced
      // in crates/dpay-core/src/lib.rs): to(32) | amount_le(8) | nonce(16) | expiry_le(8) | ... .
      const b64 = qr.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const nonceHex = Array.from(bytes.slice(40, 56)).map((b) => b.toString(16).padStart(2, '0')).join('');
      const expiryLe = new DataView(bytes.buffer).getUint32(56, true) + 2 ** 32 * new DataView(bytes.buffer).getUint32(60, true);
      return {nonceHex, expiry: expiryLe};
    }, requestQR);
    console.log(`[61-merchant-received-name] A request nonce=${req.nonceHex.slice(0, 12)}…`);

    // --- B (online payer) signs WITH fromName='Bob' + posts /pay → FakeLedger settles. --------
    console.log(`[61-merchant-received-name] B signing (fromName="${PAYER_NAME}") + submitting…`);
    const code = await signAuthorizationCode(bob.secretHex, alicePub, PAY_CENTS, req.nonceHex, req.expiry, 0, PAYER_NAME, 'Alice', '');
    const pay = await postPay(relayBaseURL, code);
    assert(pay.ok && pay.body?.receipt, `B's /pay must settle, got status=${pay.status} body=${JSON.stringify(pay.body)}`);
    // The /pay response itself carries the new display fields (additive). Light sanity check.
    assert(pay.body.from_name === PAYER_NAME, `/pay response should carry from_name="${PAYER_NAME}", got ${JSON.stringify(pay.body.from_name)}`);
    console.log(`[61-merchant-received-name] ✓ B settled (FakeLedger verified + credited A); /pay attached from_name="${PAYER_NAME}"`);

    // --- A's app confirms receipt via its /receipt poll → "Received ∂25.00 from <name>". ------
    // Primary assertion: the FROM label is the friendly name "Bob", NOT a hex prefix. The hex
    // prefix would be `bob.publicHex.slice(0, 8)` (e.g. "bc87126a"); assert that DOES NOT appear.
    const received = await driver.waitForText('Received', { timeoutMs: 10_000 });
    assert(received, 'merchant A should reach the "Received" screen via the receipt poll');
    const aliceBody = await driver.bodyText();
    assertIncludes(aliceBody, PAYER_NAME, 'A\'s "Received" screen should show the friendly payer name (from_name on the /receipt response)');
    assert(!aliceBody.includes(bob.publicHex.slice(0, 8)), `A\'s "Received" screen must NOT show the raw hex prefix when from_name is present. body excerpt:\n${aliceBody.slice(0, 500)}`);
    console.log(`[61-merchant-received-name] ✓ A sees "Received ∂25.00 from ${PAYER_NAME}" (not the hex prefix)`);

    await driver.screenshot('61-merchant-received-name');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[61-merchant-received-name] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[61-merchant-received-name] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
