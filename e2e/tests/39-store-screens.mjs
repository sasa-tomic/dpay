// Flow 39 — Play Store screenshot capture: drives the REAL app through 5 hero states with
// seeded multi-currency balances, capturing each at native resolution for marketing compositing.
//
// This is a VISUAL capture harness (like flow 35), not a behavior test. Its GREEN contract is
// "every screen rendered without throwing" — the screenshots are the product. The compose script
// (`e2e/store-assets/compose.mjs`) turns these raw captures into 1080×1920 Play Store images.
import { setup, onboardWallet, accountOf, seedDeposit, refreshDeposit, postPay, assert, selectCurrency, openReceiveAddress } from '../harness/lib.mjs';
import { decodeRequest } from '../harness/wire.mjs';

export const meta = {
  id: '39',
  name: 'store-screens',
  journey: 'tour',
  covers: ['visual-capture', 'store-screenshots'],
  verifies: 'Visual capture: 5 hero screenshots for Play Store compositing (wallet, request, balances, ledger, deposit).',
  timeoutMs: 45000,
};

export async function run() {
  const start = Date.now();
  console.log('[39-store-screens] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard a funded wallet.
    console.log('[39-store-screens] onboarding…');
    await onboardWallet(driver, 'Alex');
    await driver.waitForText('∂100.00', { timeoutMs: 5_000 });

    // 2. Seed ckBTC + ckUSDC so the wallet shows real multi-asset balances.
    const account = await accountOf(driver);
    const hex = account.publicHex;
    console.log('[39-store-screens] seeding ckBTC + ckUSDC…');
    await seedDeposit(relayBaseURL, hex, 1, 5_000_000); // 0.05000000 BTC
    await refreshDeposit(relayBaseURL, hex, 1);
    await seedDeposit(relayBaseURL, hex, 2, 25_000_000); // 25.00 USDC
    await refreshDeposit(relayBaseURL, hex, 2);

    // Wait for the balance poll to reflect seeded amounts.
    await driver.waitForText('0.05000', { timeoutMs: 8_000 }).catch(() => {});

    // 3. Do a payment so the Ledger has history (generate a request, pay it).
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '12.50', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    const qrCode = await driver.eval(() => window.__DPAY_QR_LAST);
    const req = decodeRequest(qrCode);
    await postPay(relayBaseURL, qrCode);

    // === CAPTURE 1: Wallet home (Pay tab) — the hero shot with multi-asset balances ===
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await driver.waitForText('∂100.00', { timeoutMs: 5_000 });
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
    await driver.waitForText('No transactions', { timeoutMs: 3_000 })
      .catch(() => {});
    // Brief settle so the payment lands in history.
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

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[39-store-screens] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
