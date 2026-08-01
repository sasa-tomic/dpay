// Flow 09 — Double-spend refused (replay protection, REAL relay + FakeLedger).
//
// Drives a REAL app pay (A scans B's request, approves, the app signs + POSTs /api/v1/pay), CAPTURES
// the exact signed authorization the app produced (via a fetch recorder on /pay), then SUBMITS THE
// SAME signed authorization again (a replay) and asserts it does NOT debit twice.
//
// Replay protection in the real system is TWO-LAYER, both enforced here:
//   1. The relay's nonce-keyed idempotency cache: a second submission of the SAME nonce returns the
//      cached receipt with `{replayed: true}` and NEVER touches the ledger again (HTTP 200, not 422).
//   2. The ledger's spent-nonce set (defense-in-depth): even bypassing the relay cache, the FakeLedger
//      rejects a spent nonce with `NonceReused`.
// The money-safety property — "the same signed authorization debits exactly once" — is what this
// test proves: A is debited once, B is credited once, and the replay is a no-op.
//
// (Note: a same-nonce replay returns `replayed:true`, NOT a 422 "rejection" — the relay treats it as
// an idempotent success that does not move funds, which is the correct, merchant-friendly behavior.
// The app surfaces this as "Already paid, not charged again". The no-double-debit is the assertion.)
//
// Selector contract: `pay-amount`, `btn-approve`, `balance`.
import { setup, assert, getBalance, postPay, onboardWallet } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // Đ25.00

/** Install a fetch recorder that captures every POST /api/v1/pay body into window.__DPAY_PAY_CODES,
 *  so the test can replay the EXACT signed authorization the app produced. Returns nothing; read
 *  `window.__DPAY_PAY_CODES` after a pay.
 *
 *  Scope (NIT 1a-iii): the interception is NARROWED to ONLY `POST /api/v1/pay` — every other fetch
 *  (balance/history polls, etc.) passes through to the native fetch UNTOUCHED, so the wrapper can
 *  never mask an unrelated failure. The wrapper also SELF-UNINSTALLS the instant it captures the one
 *  signed code it needs (restoring the native `window.fetch`), so the global override exists ONLY
 *  for that single capture — it does not linger for the rest of the test. */
async function installPayRecorder(driver) {
  await driver.eval(() => {
    window.__DPAY_PAY_CODES = [];
    const orig = window.fetch;
    window.__DPAY_ORIG_FETCH = orig; // test asserts restoration against this reference
    window.fetch = (url, opts) => {
      // ONLY intercept a POST to /api/v1/pay; everything else is a transparent passthrough.
      const isPayPost = typeof url === 'string' && url.includes('/api/v1/pay')
        && opts && opts.method === 'POST' && typeof opts.body === 'string';
      if (isPayPost) {
        try {
          const parsed = JSON.parse(opts.body);
          if (parsed && typeof parsed.qr === 'string') {
            window.__DPAY_PAY_CODES.push(parsed.qr);
            // Captured the one signed auth we need → restore the native fetch IMMEDIATELY so the
            // global override exists only for this single capture (no chance to mask later fetches).
            window.fetch = orig;
          }
        } catch { /* not a /pay JSON body — ignore */ }
      }
      return orig(url, opts);
    };
  });
}

export async function run() {
  const start = Date.now();
  console.log('[09-double-spend] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    const bob = await generateKeypair();
    console.log(`[09-double-spend] wallet B (payee): ${bob.publicHex.slice(0, 16)}…`);

    // 1. Onboard A; install the recorder BEFORE the pay so it captures the app's signed code.
    console.log('[09-double-spend] onboarding A + installing /pay recorder…');
    await onboardWallet(driver, 'e2e-replay');
    await installPayRecorder(driver);

    // 2. A real app-driven pay: scan B's request → approve → the app signs + POSTs (captured).
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, 'merchant');
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    console.log('[09-double-spend] A paying Đ25.00 (capturing the signed authorization)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'first pay must settle before we attempt the replay');

    const codes = await driver.eval(() => window.__DPAY_PAY_CODES);
    assert(Array.isArray(codes) && codes.length === 1, `recorder must capture exactly one /pay code, got ${JSON.stringify(codes)}`);
    const signedCode = codes[0];
    console.log(`[09-double-spend] ✓ captured the app's signed authorization (${signedCode.length} chars)`);

    // NIT 1a-iii: the recorder's window.fetch override must have SELF-UNINSTALLED after the capture,
    // so the global fetch is the untouched native one for the rest of the test (no broad override
    // lingering that could mask a later failure). RED with the old always-on global patch.
    const restored = await driver.eval(() => window.fetch === window.__DPAY_ORIG_FETCH);
    assert(restored === true, 'the /pay recorder must restore window.fetch after capture (no lingering global override)');
    console.log('[09-double-spend] ✓ window.fetch restored after capture (narrow, transient interception)');

    // Baseline after the first settle: A down to Đ75, B at Đ25.
    await driver.waitForText('Đ75.00', { timeoutMs: 8_000 });
    const aliceAfterFirst = await getBalance(relayBaseURL, (await driver.eval(() => JSON.parse(localStorage.getItem('dpay.identity.v1')).publicHex)), 0);
    const bobAfterFirst = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(aliceAfterFirst === 7500 && bobAfterFirst === 2500,
      `post-first-pay balances wrong: A=${aliceAfterFirst} (want 7500), B=${bobAfterFirst} (want 2500)`);

    // 3. REPLAY the exact signed authorization the app produced.
    console.log('[09-double-spend] replaying the SAME signed authorization…');
    const replay = await postPay(relayBaseURL, signedCode);
    // The relay's idempotency cache returns the cached receipt with replayed:true (HTTP 200, no debit).
    assert(replay.ok, `replay must be accepted (idempotent), got status ${replay.status} body ${JSON.stringify(replay.body)}`);
    assert(replay.body?.replayed === true, `replay must report replayed:true (no second settle), got ${JSON.stringify(replay.body)}`);
    console.log('[09-double-spend] ✓ replay returned {replayed:true} — no second settle');

    // 4. The money-safety assertion: NO double-debit. A and B unchanged after the replay.
    const aliceAfterReplay = await getBalance(relayBaseURL, (await driver.eval(() => JSON.parse(localStorage.getItem('dpay.identity.v1')).publicHex)), 0);
    const bobAfterReplay = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(aliceAfterReplay === aliceAfterFirst, `A must NOT be debited twice: ${aliceAfterFirst} → ${aliceAfterReplay}`);
    assert(bobAfterReplay === bobAfterFirst, `B must NOT be credited twice: ${bobAfterFirst} → ${bobAfterReplay}`);
    console.log(`[09-double-spend] ✓ no double-debit: A stays ${aliceAfterReplay}, B stays ${bobAfterReplay}`);

    await driver.screenshot('09-double-spend');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[09-double-spend] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[09-double-spend] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
