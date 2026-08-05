// Flow 42 — Receipt reject: a tampered/malformed receipt MUST be rejected by the app's
// verifyOutcomeReceipt, surfacing the honest 'Couldn't verify the payment' and NEVER a fake
// 'Paid ✓'. Pairs with flow 30 (trusted-receipt, which proves the WRONG-KEY reject path).
//
// verifyOutcomeReceipt (app/services/receipt.ts) has THREE reject conditions, in order:
//   (1) KEY PIN: receipt.pubkey !== EXPECTED_RECEIPT_PUBKEY → false (flow 30's case)
//   (2) SIGNATURE: DpayCore.verifyReceiptSig(...) over the canonical claim → false
//   (3) AUTH BINDING: receipt {from,to,amount,currency,nonce} != signed authorization → false
//
// Harness-reachability probe (2026-08-05): verifyOutcomeReceipt is NOT exported on window; the only
// path that exercises it is the app's POST /api/v1/pay handler in PayMode.approve (and the /receipt
// poll in phase='qr'). The relay's GET /receipt/:nonce route ONLY READS a stored receipt (it does
// NOT verify a posted receipt — that's a client-side check). So the only harness-reachable seam for
// the reject paths is the same one flow 30 uses: install a narrowed /pay interceptor that returns a
// tampered receipt, then drive the app's real approve() and assert verifyOutcomeReceipt's verdict
// surfaces as the honest error (NOT Paid ✓).
//
// This flow covers TWO tamper cases:
//   (a) WRONG PUBKEY: receipt carries a non-pinned pubkey (mutate the field). Key-pin (1) rejects.
//       Conceptually the SAME attack class as flow 30 (wrong key), but here the receipt body is the
//       SAME as a real one with ONLY the pubkey mutated — proving the pin rejects a tampered-real-
//       receipt, not just a forged-from-scratch one. (The two flows are complementary: 30 forges
//       under a fresh key; 42 mutates a body that would otherwise be valid.)
//   (b) TAMPERED SIG: receipt carry the CORRECT pinned pubkey + a flipped-byte sig. The pin (1)
//       PASSES; the sig check (2) REJECTS. This is the NEW coverage — proving the sig gate fires
//       even when the pubkey looks right (defense in depth: the pin alone is not enough).
//
// Recorder discipline (mirrors flow 30 / flow 09): the interceptor is NARROWED to ONLY
// POST /api/v1/pay, every other fetch passes through untouched, and it SELF-UNINSTALLS the instant
// it serves the one tampered response (restoring native window.fetch), so the global override
// exists only for that single capture and cannot mask a later failure.
//
// Selector contract: `pay-amount`, `btn-approve`, `review-err` (PayMode's err container), `balance`.
import { setup, assert, onboardWallet, accountOf, getBalance } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

// The pinned receipt-signing pubkey injected by the harness (driver.mjs: `__DPAY_TEST_RECEIPT_PUBKEY`).
// We DON'T need to read it from the page — we only need to know that for case (b) (sig tamper) the
// receipt's `pubkey` field must MATCH the pin so the pin gate passes + the sig gate fires. For case
// (a) (wrong pubkey) we mutate to ANY non-pinned value. The pin is a fixed constant (the FakeLedger's
// stable receipt key, see driver.mjs's injectTestGlobals comment for how it's derived).
const PINNED_PUBKEY = '379bd5b7d1494939afe9f87b3587a50a96bde608f695e759daf3a3f106173e76';

const PAY_CENTS = 2500; // ∂25.00 (raw units)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '42',
  name: 'receipt-reject',
  journey: 'pay',
  covers: ['receipt', 'receipt-reject', 'malicious-relay', 'verifyOutcomeReceipt'],
  verifies: 'Tampered receipt (wrong pubkey / flipped sig) → verifyOutcomeReceipt rejects → honest "Couldn\'t verify", no fake Paid ✓, no debit.',
  timeoutMs: 30000, // two reload cycles + interceptor cases — wider than the 20s default
};

/**
 * Install a narrowed /pay interceptor that returns a TAMPERED receipt built from the payer's real
 * auth fields + the per-case mutation. The override self-uninstalls after serving the one response
 * (mirrors flow 30's discipline). `case_` is 'wrong-pubkey' or 'tampered-sig'; both build a receipt
 * body with the same from/to/amount/currency/nonce/block/ts the real receipt would carry, then
 * mutate the case-specific field:
 *   - 'wrong-pubkey': pubkey = a non-pinned value (zero-byte hex), receipt_sig = anything (won't
 *     reach sig verification).
 *   - 'tampered-sig': pubkey = the pinned value (passes pin), receipt_sig = the all-zero sig (a
 *     structurally-valid 64-byte hex that fails ed25519 verify).
 */
async function installTamperedPayInterceptor(driver, case_, fields) {
  const body = {
    nonce: fields.nonce, from: fields.from, to: fields.to,
    amount: String(fields.amount), currency: fields.currency,
    block_index: '1', settle_ts: String(fields.settleTs),
  };
  if (case_ === 'wrong-pubkey') {
    // Any non-pinned 64-hex value. All-zeros is obviously wrong; the pin gate fires on the
    // case-insensitive mismatch (see verifyOutcomeReceipt §1).
    body.pubkey = '00'.repeat(32);
    body.receipt_sig = 'ff'.repeat(64); // arbitrary; never reaches sig verification
  } else {
    // case === 'tampered-sig': pubkey matches the pin (passes §1), sig is a 64-byte all-zero hex
    // (structurally valid, fails ed25519 verify under any key). §2 fires.
    body.pubkey = PINNED_PUBKEY;
    body.receipt_sig = '00'.repeat(64);
  }
  await driver.eval((b) => {
    const orig = window.fetch;
    window.__DPAY_ORIG_FETCH = orig;
    const tamperedReceipt = b;
    window.fetch = (url, opts) => {
      const isPayPost = typeof url === 'string' && url.includes('/api/v1/pay')
        && opts && opts.method === 'POST';
      if (isPayPost) {
        // Self-uninstall IMMEDIATELY (mirrors 09/30 discipline — one capture, then gone).
        window.fetch = orig;
        return Promise.resolve(new Response(JSON.stringify({ok: true, receipt: tamperedReceipt}), {
          status: 200, headers: {'Content-Type': 'application/json'},
        }));
      }
      return orig(url, opts);
    };
  }, body);
}

/**
 * Drive the app's real approve path: scan B's request, click approve, then assert the tampered
 * receipt was rejected (no Paid ✓, honest 'verify the payment' visible). The review screen carries
 * the err inline (review-err text), so the assertion is bodyText-based (mirrors flow 30).
 *
 * Pre: the interceptor is installed. Post: review screen with `err` set; verifyOutcomeReceipt
 * returned false; no Paid phase transition; no debit (the interceptor returns without calling
 * through to the real relay → FakeLedger never sees the /pay).
 */
async function assertReject(driver, nonce, payeeHex, label) {
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const requestQR = buildRequestQR(payeeHex, PAY_CENTS, nonce, expiry, 0, 'merchant');
  await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
  await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
  console.log(`[42-receipt-reject] ${label}: clicking btn-approve (POST /pay returns tampered receipt)…`);
  await driver.click('btn-approve', { timeoutMs: 5_000 });
  // The honest verdict: NO 'Paid' anywhere + the 'verify the payment' error inline.
  const body = await driver.bodyText();
  assert(!body.includes('Paid'),
    `[42-receipt-reject] ${label}: the app must NOT show a fake "Paid ✓" for a tampered receipt. body excerpt:\n${body.slice(0, 500)}`);
  const verifyErr = await driver.waitForText('verify the payment', { timeoutMs: 6_000 });
  assert(verifyErr,
    `[42-receipt-reject] ${label}: the app should surface the honest "Couldn't verify the payment" error. body excerpt:\n${body.slice(0, 500)}`);
  console.log(`[42-receipt-reject] ✓ ${label}: tampered receipt rejected — no fake Paid ✓, honest verify error shown`);
  // The interceptor must have self-uninstalled (no lingering global override masking later failures).
  const restored = await driver.eval(() => window.fetch === window.__DPAY_ORIG_FETCH);
  assert(restored === true, `[42-receipt-reject] ${label}: the interceptor must restore window.fetch after serving`);
  console.log(`[42-receipt-reject] ✓ ${label}: window.fetch restored (narrow, transient interception)`);
  // Reset PayMode's review-screen state for the next case. The Cancel link has no testID (a bare
  // Pressable with accessibilityLabel="Cancel"), so click it via aria-label selector — the SAME
  // control a screen-reader user would target. The app's reset() returns phase to 'scan' so the
  // next scan + interceptor install cleanly. Avoids a page reload (which would need the ?relay=
  // query re-threaded and cost ~2s).
  const canceled = await driver.eval(() => {
    const btn = document.querySelector('button[aria-label="Cancel"]');
    if (btn) { btn.click(); return true; }
    return false;
  });
  assert(canceled === true, `[42-receipt-reject] ${label}: review Cancel link should be reachable via aria-label`);
  await driver.waitGone('pay-amount', { timeoutMs: 4_000 });
}

export async function run() {
  const start = Date.now();
  console.log('[42-receipt-reject] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // Payee wallet B (in-test keypair; no second browser needed — flow 07's pattern).
    const bob = await generateKeypair();
    console.log(`[42-receipt-reject] wallet B (payee): ${bob.publicHex.slice(0, 16)}…`);

    // 1. Onboard A and read its pubkey (the `from` the tampered receipts carry to look genuine).
    console.log('[42-receipt-reject] onboarding A…');
    await onboardWallet(driver, 'e2e-receipt');
    const alice = await accountOf(driver);
    assert(alice && typeof alice.publicHex === 'string', 'onboarded wallet must expose a publicHex');
    const aliceBefore = await getBalance(relayBaseURL, alice.publicHex, 0);
    assert(aliceBefore === '10000', `A must start at the faucet amount 10000, got ${aliceBefore}`);

    // 2. CASE (a) — wrong pubkey. Install the interceptor, scan + approve, assert reject.
    const nonceA = randNonceHex();
    const settleTsA = Math.floor(Date.now() / 1000);
    await installTamperedPayInterceptor(driver, 'wrong-pubkey', {
      nonce: nonceA, from: alice.publicHex, to: bob.publicHex,
      amount: PAY_CENTS, currency: 0, settleTs: settleTsA,
    });
    console.log('[42-receipt-reject] case (a) wrong-pubkey interceptor armed');
    await assertReject(driver, nonceA, bob.publicHex, 'case (a) wrong-pubkey');

    // 3. CASE (b) — tampered sig (correct pinned pubkey + flipped-byte sig). No reload needed: the
    //    Cancel-by-JS at the end of assertReject reset PayMode's phase to 'scan', so the new
    //    interceptor + scan run cleanly.
    const nonceB = randNonceHex();
    const settleTsB = Math.floor(Date.now() / 1000);
    await installTamperedPayInterceptor(driver, 'tampered-sig', {
      nonce: nonceB, from: alice.publicHex, to: bob.publicHex,
      amount: PAY_CENTS, currency: 0, settleTs: settleTsB,
    });
    console.log('[42-receipt-reject] case (b) tampered-sig interceptor armed (pubkey = pin)');
    await assertReject(driver, nonceB, bob.publicHex, 'case (b) tampered-sig');

    // 4. No debit occurred across both reject cases — neither tampered receipt moved funds (the
    //    interceptor returned before calling through; the FakeLedger never saw either /pay). A's
    //    balance is unchanged from its initial faucet amount.
    const aliceAfter = await getBalance(relayBaseURL, alice.publicHex, 0);
    assert(aliceAfter === '10000',
      `[42-receipt-reject] A must NOT be debited by the rejected tampered receipts: got ${aliceAfter}, want 10000`);
    console.log(`[42-receipt-reject] ✓ no debit across both reject cases — A stays at ${aliceAfter}`);

    await driver.screenshot('42-receipt-reject');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[42-receipt-reject] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[42-receipt-reject] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
