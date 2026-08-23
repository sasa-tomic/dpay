// Flow 61 — counterparty rendering on the IC rail (principal text; names are GONE).
//
// HISTORY: this was the "merchant Received shows from_name" flow — the payer's signed wire carried
// `from_name` (wire-v2) and the facade attached it to the /pay + /receipt responses so the
// merchant's "Received" screen read "from Bob". The IC-rail cutover DELETED the facade settlement
// surface: payments are icrc1_transfer envelopes submitted straight to the ledger, and the ledger's
// txn rows carry EMPTY from_name/to_name. There is no transport for friendly names anymore — the
// "Received" confirmation renders the generic "from payer".
//
// WHAT THIS FLOW NOW GATES (the regression that still matters — honest scope):
//   - counterparties render as SHORT PRINCIPAL TEXT (8-char prefix + …), never a full principal,
//     never the raw hex pubkey;
//   - the MEMO (the request nonce the payer bound the payment to) is visible on the history row —
//     with names dead, the memo is the reconciliation key between a payment and its request;
//   - the online direct payment updates balance + history (it does NOT flip the merchant's
//     "Received" — that flip is merchant-app-submission only, gated by flows 08/21).
import { setup, assert, assertIncludes, getBalance, onboardWallet, accountOf, railTransfer, railPrincipalText, faucetAccount } from '../harness/lib.mjs';
import { generateKeypair } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // Đ25.00

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '61',
  name: 'merchant-received-name',
  journey: 'pay',
  covers: ['receive', 'settle', 'confirmation', 'counterparty-rendering', 'memo-reconciliation'],
  verifies: 'IC-rail counterparty rendering: history shows the short PRINCIPAL TEXT (not full principal, not hex pubkey) and the memo (reconciliation key) is visible; friendly names died with the facade settlement.',
  timeoutMs: 25_000,
};

export async function run() {
  const start = Date.now();
  console.log('[61-merchant-received-name] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- wallet A (merchant): onboarded in the browser. ---------------------------------------
    await onboardWallet(driver, 'Alice');
    const alice = await accountOf(driver);
    const alicePub = alice.publicHex;

    // --- wallet B (payer): generated in-test, fauceted Đ100, pays the request on the rail. -----
    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const fund = await faucetAccount(relayBaseURL, bob.publicHex, 10000);
    assert(fund.ok, `payer B faucet should succeed, got status ${fund.status}: ${JSON.stringify(fund.body)}`);

    // --- A creates a Đ25 receive request; read the QR the app rendered (nonce = memo). --------
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '25.00', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);

    // The request QR carries the nonce at bytes 40..56 (FROZEN wire layout, single-sourced in
    // crates/dpay-core/src/lib.rs) — decoded in-page since the harness builders aren't in the
    // browser context. The nonce is the memo B binds the payment to.
    const req = await driver.eval((qr) => {
      const b64 = qr.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const nonceHex = Array.from(bytes.slice(40, 56)).map((b) => b.toString(16).padStart(2, '0')).join('');
      return {nonceHex};
    }, requestQR);
    console.log(`[61-merchant-received-name] A request nonce=${req.nonceHex.slice(0, 12)}…`);

    // --- B settles ON THE RAIL (online direct payment — no merchant-app submission). ----------
    const pay = await railTransfer(relayBaseURL, bob.secretHex, alicePub, BigInt(PAY_CENTS), {memoHex: req.nonceHex});
    assert(pay.ok === true && pay.status === 202, `B's rail payment must be accepted (202), got ${JSON.stringify(pay)}`);
    console.log('[61-merchant-received-name] ✓ B settled on the rail (memo = request nonce)');

    // --- Ledger truth: A credited. --------------------------------------------------------------
    const aliceBal = await getBalance(relayBaseURL, alicePub, 0);
    assert(aliceBal === '12500', `A must be credited (12500), got ${aliceBal}`);

    // --- A's history renders the payment: SHORT PRINCIPAL + memo (the reconciliation key). ----
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    const sawShort = await driver.waitForText(bobPrincipal.slice(0, 8), { timeoutMs: 8_000});
    assert(sawShort, 'history should show the payer as the short PRINCIPAL prefix');
    const body = await driver.bodyText();
    assertIncludes(body, bobPrincipal.slice(0, 8), 'history shows the short principal counterparty');
    assert(!body.includes(bobPrincipal), 'history must NOT dump the full principal');
    assert(!body.includes(bob.publicHex), 'history must NOT show the raw hex pubkey');
    assertIncludes(body, req.nonceHex.slice(0, 8), 'the memo (request nonce prefix) is visible — the reconciliation key');
    console.log('[61-merchant-received-name] ✓ principal rendered short + memo visible (names are gone; memo reconciles)');

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
