// Flow 30 — Trusted receipt: a wrong-key receipt from a "malicious relay" is rejected (MC4 U5).
//
// This is the malicious-relay trust-gap close. Before MC4 U5 the app read the receipt's Ed25519
// verify key FROM THE UNTRUSTED RECEIPT BODY (`pubHex = receipt?.pubkey`), so a malicious relay could
// generate its OWN keypair, sign a claim with its private key, and return `{pubkey: <relay key>,
// receipt_sig: <valid sig under relay key>}` — an internally-valid receipt the app's check accepted →
// a fake "Paid ✓". The fix: the app now PINS the expected receipt-signing pubkey (baked in config /
// injected by the harness) and rejects any receipt whose `pubkey` ≠ the pin, EVEN IF the signature is
// internally valid under that wrong key.
//
// This flow SIMULATES the attack: it installs a narrowed POST /api/v1 interceptor that returns a
// receipt carrying a VALID Ed25519 signature under a FRESHLY-GENERATED (wrong) key, with every other
// field matching the real payment (from/to/amount/currency/nonce). Under the OLD code this would pass
// (the sig verifies under the embedded key + the auth binding matches) → fake "Paid ✓". Under the NEW
// code the key-pin gate rejects it → the app stays honest ("Couldn't verify the payment", no Paid ✓).
//
// Recorder discipline (mirrors 09-double-spend): the override is NARROWED to ONLY POST /api/v1/pay,
// every other fetch passes through untouched, and it SELF-UNINSTALLS the instant it serves the one
// fabricated response (restoring native `window.fetch`), so the global override exists only for that
// single capture and cannot mask a later failure.
//
// Selector contract: `pay-amount`, `btn-approve`, `review-err`, `balance`.
import { setup, assert, onboardWallet, accountOf, getBalance } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';
import * as ed from '@noble/ed25519';

const PAY_CENTS = 2500; // ∂25.00 (raw units)

/** Build the canonical 108-byte ReceiptClaim: nonce(16)|from(32)|to(32)|amount_le(8)|currency_le(4)|
 *  block_le(8)|ts_le(8). Mirrors `dpay_core::ReceiptClaim::signing_bytes` + the web shim's builder so
 *  the attacker's signature is REAL and would verify under the embedded (wrong) key. */
function buildReceiptClaim(nonceHex, fromHex, toHex, amount, currency, blockIndex, settleTs) {
  const buf = Buffer.alloc(108);
  let off = 0;
  Buffer.from(nonceHex, 'hex').copy(buf, off); off += 16;
  Buffer.from(fromHex, 'hex').copy(buf, off); off += 32;
  Buffer.from(toHex, 'hex').copy(buf, off); off += 32;
  buf.writeBigUInt64LE(BigInt(amount), off); off += 8;
  buf.writeUInt32LE(currency, off); off += 4;
  buf.writeBigUInt64LE(BigInt(blockIndex), off); off += 8;
  buf.writeBigUInt64LE(BigInt(settleTs), off);
  return buf;
}

/**
 * Install a narrowed /pay interceptor that returns a MALICIOUS-RELAY receipt: a VALID Ed25519
 * signature under a FRESH wrong key (≠ the pinned FakeLedger key), with every other field matching
 * the real payment. The override self-uninstalls after serving the one response. `fields` carries the
 * real payment's from/to/amount/nonce/currency so the fabricated receipt is identical to a genuine
 * one EXCEPT for the signing key — making the key-pin the SOLE reason for rejection.
 */
async function installMaliciousPayInterceptor(driver, fields) {
  // Generate the attacker's keypair + sign the claim OUTSIDE the page (node has @noble; the page
  // does too, but doing it here keeps the injected function tiny + deterministic).
  const attackerSecret = ed.utils.randomPrivateKey();
  const attackerPub = Buffer.from(await ed.getPublicKeyAsync(attackerSecret)).toString('hex');
  const claim = buildReceiptClaim(
    fields.nonce, fields.from, fields.to, fields.amount, fields.currency, 1, fields.settleTs,
  );
  const attackerSig = Buffer.from(await ed.signAsync(claim, attackerSecret)).toString('hex');

  await driver.eval((f) => {
    const orig = window.fetch;
    window.__DPAY_ORIG_FETCH = orig;
    const maliciousReceipt = {
      nonce: f.nonce, from: f.from, to: f.to, amount: String(f.amount), currency: f.currency,
      block_index: '1', settle_ts: String(f.settleTs),
      receipt_sig: f.attackerSig, pubkey: f.attackerPub, // wrong key + a sig that is VALID under it
    };
    window.fetch = (url, opts) => {
      const isPayPost = typeof url === 'string' && url.includes('/api/v1/pay')
        && opts && opts.method === 'POST';
      if (isPayPost) {
        // Self-uninstall IMMEDIATELY so the override exists only for this one capture (09 discipline).
        window.fetch = orig;
        return Promise.resolve(new Response(JSON.stringify({ok: true, receipt: maliciousReceipt}), {
          status: 200, headers: {'Content-Type': 'application/json'},
        }));
      }
      return orig(url, opts); // every other fetch (balance/history/etc.) passes through untouched
    };
  }, {nonce: fields.nonce, from: fields.from, to: fields.to, amount: fields.amount,
     currency: fields.currency, settleTs: fields.settleTs, attackerPub, attackerSig});

  return attackerPub;
}

export async function run() {
  const start = Date.now();
  console.log('[30-trusted-receipt] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    const bob = await generateKeypair();
    console.log(`[30-trusted-receipt] wallet B (payee): ${bob.publicHex.slice(0, 16)}…`);

    // 1. Onboard A and read its pubkey (the `from` the malicious receipt must carry to look genuine).
    console.log('[30-trusted-receipt] onboarding A…');
    await onboardWallet(driver, 'e2e-trusted');
    const alice = await accountOf(driver);
    assert(alice && typeof alice.publicHex === 'string', 'onboarded wallet must expose a publicHex');

    // 2. Install the malicious-relay /pay interceptor BEFORE the pay so it serves the fabricated
    //    receipt. The receipt carries a VALID sig under a wrong key + matching from/to/amount/nonce,
    //    so the key-pin is the SOLE gate that can reject it.
    const nonce = randNonceHex();
    const settleTs = Math.floor(Date.now() / 1000);
    const attackerPub = await installMaliciousPayInterceptor(driver, {
      nonce, from: alice.publicHex, to: bob.publicHex, amount: PAY_CENTS, currency: 0, settleTs,
    });
    console.log(`[30-trusted-receipt] malicious-relay interceptor armed (wrong key ${attackerPub.slice(0, 16)}…)`);

    // 3. A real app-driven pay: scan B's request → approve → the app POSTs /pay (intercepted).
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, 'merchant');
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    console.log('[30-trusted-receipt] A approving the pay (POST /pay returns the malicious receipt)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });

    // 4. The key-pin gate: the app must NOT show "Paid ✓" for the malicious receipt. It stays on the
    //    review screen with the honest "Couldn't verify the payment" error (never a fake success).
    const body = await driver.bodyText();
    assert(!body.includes('Paid'),
      `the app must NOT show a fake "Paid ✓" for a wrong-key receipt. body excerpt:\n${body.slice(0, 500)}`);
    const verifyErr = await driver.waitForText('verify the payment', { timeoutMs: 6_000 });
    assert(verifyErr,
      `the app should surface the honest "Couldn't verify the payment" error. body excerpt:\n${body.slice(0, 500)}`);
    console.log('[30-trusted-receipt] ✓ wrong-key receipt rejected — no fake "Paid ✓", honest verify error shown');

    // 5. The recorder must have self-uninstalled (no lingering global override that could mask a later
    //    failure) — mirrors the 09-double-spend discipline.
    const restored = await driver.eval(() => window.fetch === window.__DPAY_ORIG_FETCH);
    assert(restored === true, 'the malicious-relay interceptor must restore window.fetch after serving');
    console.log('[30-trusted-receipt] ✓ window.fetch restored after serving (narrow, transient interception)');

    // 6. No debit occurred — the malicious receipt did NOT move funds (the FakeLedger never saw the
    //    /pay; the interceptor returned before calling through). A's balance is unchanged.
    const aliceAfter = await getBalance(relayBaseURL, alice.publicHex, 0);
    assert(aliceAfter === '10000',
      `A must NOT be debited by the rejected malicious receipt: got ${aliceAfter}, want 10000`);
    console.log(`[30-trusted-receipt] ✓ no debit — A stays at ${aliceAfter}`);

    await driver.screenshot('30-trusted-receipt');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[30-trusted-receipt] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[30-trusted-receipt] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
