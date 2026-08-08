// Flow 50 — Deeplink receipt hand-back (`dpay:pay` via the web `?pay=` mirror).
//
// The NFC-less receipt hand-back: when NFC is unavailable, the payer (online) settles their own
// payment + shares the CANISTER-SIGNED receipt back to the merchant as a `dpay:pay/<blob>` link.
// The merchant opens it; the app INDEPENDENTLY verifies the receipt signature (verifyOutcomeReceipt:
// key-pin + Ed25519 sig) and reconciles as Received. This flow proves that verify chain end-to-end
// against the REAL FakeLedger (the receipt is genuinely signed by the FakeLedger's receipt key,
// pinned via the injected `__DPAY_TEST_RECEIPT_PUBKEY`).
//
// The `<blob>` is base64url(JSON.stringify(receipt)) — DIFFERENT from `dpay:req/`'s raw base64url
// (the `pay` handler base64url-decodes THEN JSON.parses). The receipt is the relay's POST /api/v1/pay
// `body.receipt` object.
//
// Approach (reload, mirroring flow 49): A (merchant) is onboarded in the browser; B (payer) is a
// server-side keypair fauceted ∂100. B settles A's request via /pay → real receipt → encode as
// `?pay=<blob>` → reload A's browser (identity persists in AsyncStorage) → Wallet reads ?pay= →
// ReceiveMode's verify effect → verifyOutcomeReceipt → "Received ∂25.00 from <B>". This is the EXACT
// code path a real web user opening a `dpay.kalaj.org/?pay=...` link runs.
//
// SECURITY assertion: the merchant sees "Received" ONLY because verifyOutcomeReceipt passed (the
// key-pin matches the pinned FakeLedger key + the Ed25519 signature is valid over the canonical
// ReceiptClaim). A forged/tampered receipt would NOT reach "Received" (covered by the codec null/
// garbage jest tests + flow 30's wrong-key rejection at the payer level).
//
// Selector contract: `balance`, `pay-amount` (absent — merchant lands on Receive, not Pay).
import { setup, assert, assertIncludes, getBalance, onboardWallet, accountOf, postPay, faucetAccount } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, signAuthorizationCode, b64urlEncode } from '../harness/wire.mjs';

const PAY_UNITS = 2500; // ∂25.00 (DEMO_USD = currency 0)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '50',
  name: 'deeplink-receipt',
  journey: 'pay',
  covers: ['deeplink', 'receipt-link', 'verify', 'receive', 'handback'],
  verifies: 'merchant verifies a dpay:pay receipt (canister-signed) via the web ?pay= path + reconciles as Received.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[50-deeplink-receipt] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL, webBaseURL } = env;

    // --- wallet A: onboarded in the browser (the MERCHANT). ----------------------------------
    console.log('[50-deeplink-receipt] onboarding wallet A (merchant)…');
    await onboardWallet(driver, 'e2e-receipt');
    const alice = await accountOf(driver);
    const alicePub = alice.publicHex;
    console.log(`[50-deeplink-receipt] wallet A (merchant): ${alicePub.slice(0, 16)}…`);

    // --- wallet B: a fresh keypair generated in-test (the PAYER), fauceted ∂100. -------------
    // B settles A's request directly (online /pay) — the NFC-unavailable scenario where the payer
    // settles their own payment + hands the receipt back. Funded via the faucet (arbitrary account).
    const bob = await generateKeypair();
    console.log(`[50-deeplink-receipt] wallet B (payer): ${bob.publicHex.slice(0, 16)}…`);
    const fund = await faucetAccount(relayBaseURL, bob.publicHex, 10000);
    assert(fund.ok, `payer B faucet should succeed, got status ${fund.status}: ${JSON.stringify(fund.body)}`);
    const bobBal = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(String(bobBal) === '10000', `payer B must be fauceted to 10000, got ${bobBal}`);

    // --- A's request: to=A, amount=∂25, fresh nonce, +10min expiry, currency 0. B signs an
    //     authorization paying it + posts to /pay → the FakeLedger settles → real receipt. -------
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const code = await signAuthorizationCode(bob.secretHex, alicePub, PAY_UNITS, nonce, expiry, 0, 'e2e-payer', 'e2e-receipt', '');
    const payRes = await postPay(relayBaseURL, code);
    assert(payRes.ok, `B's /pay should settle, got status ${payRes.status}: ${JSON.stringify(payRes.body)}`);
    const receipt = payRes.body.receipt;
    assert(receipt && typeof receipt === 'object', '/pay response must carry a receipt object');
    assert(String(receipt.nonce) === nonce, 'the settled receipt must answer the request nonce');
    console.log(`[50-deeplink-receipt] ✓ B settled A's request (real FakeLedger receipt, nonce ${String(receipt.nonce).slice(0, 8)}…)`);

    // --- Encode the receipt as a dpay:pay/<blob> link: base64url(JSON.stringify(receipt)). ----
    // (Mirrors the app's encodeReceiptDeeplink; the harness's b64urlEncode is the SAME hand-rolled
    // RFC 4648 §5 codec the app's lib/base64url.ts uses.)
    const blob = b64urlEncode(Buffer.from(JSON.stringify(receipt), 'utf8'));
    console.log('[50-deeplink-receipt] reloading with ?relay=&pay=<blob> to simulate the hand-back…');

    // --- Simulate the merchant opening the dpay:pay/ link: reload with ?pay=<blob>. ----------
    // AsyncStorage identity persists → wallet auto-loads → Wallet's deeplink effect reads ?pay= →
    // setPrefillReceipt + mode='receive' → ReceiveMode's verify effect → decodeReceiptDeeplink →
    // verifyOutcomeReceipt (key-pin + Ed25519 sig) → setResult → "Received ∂25.00 from <B>".
    const reloadPath = `/?relay=${encodeURIComponent(relayBaseURL)}&pay=${encodeURIComponent(blob)}`;
    await driver.navigate(webBaseURL, reloadPath, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // --- Merchant's Receive screen shows Received (the receipt verified). The verify ran
    //     verifyOutcomeReceipt with the pinned FakeLedger key — a forged receipt would NOT reach
    //     here. The amount + the payer's short pubkey come from the authenticated receipt fields. ---
    const received = await driver.waitForText('Received', { timeoutMs: 8_000 });
    assert(received, 'merchant should see "Received" after verifying the dpay:pay receipt');
    const body = await driver.bodyText();
    assertIncludes(body, '∂25.00', 'the Received screen should show the receipt amount ∂25.00');
    assertIncludes(body, 'from ', 'the Received screen should name the payer (from …)');
    // SECURITY INVARIANT: the merchant is NOT on the Pay review screen (a req deeplink would land
    // there; a pay deeplink must route to Receive). Asserts the kind routing is correct.
    assert(!/\bPay ∂25\.00\b/.test(body), 'a dpay:pay receipt must route to Receive, not the Pay review screen');
    console.log('[50-deeplink-receipt] ✓ merchant verified the receipt + shows Received ∂25.00 from payer');

    await driver.screenshot('50-deeplink-receipt');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[50-deeplink-receipt] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[50-deeplink-receipt] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
