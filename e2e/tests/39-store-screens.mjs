// Flow 39 — Play Store screenshot capture: drives the REAL app through 5 hero states with
// rail-funded multi-currency balances, capturing each at native resolution for marketing compositing.
//
// IC-rail cutover: the ckBTC/ckUSDC seeds ride the test-helper FAUCET (fake-IC ledger, per
// currency), and the payment is a REAL icrc1_transfer envelope (railTransfer from an in-test payer
// wallet to the on-device wallet's principal) — the old deposit-seed + postPay routes are gone.
//
// This is a VISUAL capture harness (like flow 35), not a behavior test. Its GREEN contract is
// "every screen rendered without throwing" — the screenshots are the product. The compose script
// (`e2e/store-assets/compose.mjs`) turns these raw captures into 1080×1920 Play Store images.
//
// `optional: true` keeps this OFF the default `just e2e` path (~37s of render-only capture that is
// not a behavior gate); `just e2e-store` runs it on demand (DPAY_E2E_FILTER=store-screens).
import { setup, onboardWallet, accountOf, railTransfer, assert, selectCurrency, openReceiveAddress } from '../harness/lib.mjs';
import { generateKeypair, decodeRequest } from '../harness/wire.mjs';

export const meta = {
  id: '39',
  name: 'store-screens',
  journey: 'tour',
  covers: ['visual-capture', 'store-screenshots'],
  verifies: 'Visual capture: 5 hero screenshots for Play Store compositing (wallet, request, balances, ledger, deposit), rail-funded.',
  timeoutMs: 45000,
  optional: true,
};

export async function run() {
  const start = Date.now();
  console.log('[39-store-screens] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard a funded wallet (Đ100 DEMO via the onboarding faucet).
    console.log('[39-store-screens] onboarding…');
    await onboardWallet(driver, 'Alex');
    await driver.waitForText('Đ100.00', { timeoutMs: 5_000 });

    const account = await accountOf(driver);
    const hex = account.publicHex;

    // 2. Fund ckBTC + ckUSDC via the rail faucet (test-helper on the fake-IC ledgers) so the
    // wallet shows real multi-asset balances.
    console.log('[39-store-screens] funding ckBTC + ckUSDC (rail faucet)…');
    await faucetCurrency(relayBaseURL, hex, 1, 5_000_000); // 0.05000000 BTC
    await faucetCurrency(relayBaseURL, hex, 2, 25_000_000); // 25.00 USDC

    // Wait for the balance poll to reflect funded amounts.
    await driver.waitForText('0.05000', { timeoutMs: 8_000 }).catch(() => {});

    // 3. Do a payment so the Ledger has history: Alex requests Đ12.50, an in-test payer wallet
    // settles it on the rail (icrc1_transfer with memo = request nonce).
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '12.50', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    const qrCode = await driver.eval(() => window.__DPAY_QR_LAST);
    const req = decodeRequest(qrCode);
    const payer = await generateKeypair();
    await faucetCurrency(relayBaseURL, payer.publicHex, 0, 10_000);
    const pay = await railTransfer(relayBaseURL, payer.secretHex, hex, 1250n, {memoHex: req.nonceHex});
    assert(pay.ok === true && pay.status === 202, `the Đ12.50 rail payment must be accepted (202), got ${JSON.stringify(pay)}`);

    // === CAPTURE 1: Wallet home (Pay tab) — the hero shot with multi-asset balances ============
    // (Đ100 onboarding + Đ12.50 received = Đ112.50 once the balance poll lands.)
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await driver.waitForText('Đ112.50', { timeoutMs: 8_000 });
    await driver.screenshot('39-store-wallet');
    console.log('[39-store-screens] ✓ wallet home');

    // === CAPTURE 2: Receive request QR — shows the request flow ===
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '42.50', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    await driver.screenshot('39-store-request');
    console.log('[39-store-screens] ✓ request QR');

    // === CAPTURE 3: Balances hub — shows all assets with actions ===
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    await driver.screenshot('39-store-balances');
    console.log('[39-store-screens] ✓ balances hub');

    // === CAPTURE 4: Ledger — transaction history (faucet credit + payment) ===
    await driver.click('btn-balances-close', { timeoutMs: 4_000 });
    await driver.click('tab-transactions', { timeoutMs: 5_000 });
    // Brief settle so the payment lands in history (the poll seam is fast).
    await new Promise(r => setTimeout(r, 600));
    await driver.screenshot('39-store-ledger');
    console.log('[39-store-screens] ✓ ledger');

    // === CAPTURE 5: Deposit address (ckBTC) — shows the deposit flow ===
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    await selectCurrency(driver, 'ckbtc');
    await openReceiveAddress(driver);
    await driver.waitForText('bc1', { timeoutMs: 12_000 }).catch(() => {});
    await driver.findByTestID('deposit-address', { timeoutMs: 8_000 }).catch(() => {});
    await driver.screenshot('39-store-deposit');
    console.log('[39-store-screens] ✓ deposit address');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[39-store-screens] GREEN in ${elapsed}s (5 screens captured → e2e/shots/)`);
    assert(true, 'store screens captured');
  } finally {
    await env.stop();
  }
}

/** Credit a currency via the test-helper faucet (fake-IC ledger per currency). */
async function faucetCurrency(relayBaseURL, accountHex, currency, amount) {
  const res = await fetch(`${relayBaseURL}/api/v1/faucet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: accountHex, currency, amount }),
  });
  if (!res.ok) throw new Error(`faucet(currency=${currency}) failed: ${res.status}`);
  return res.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[39-store-screens] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
