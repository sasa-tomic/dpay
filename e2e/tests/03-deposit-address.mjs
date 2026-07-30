// Flow 03 — Deposit sheet: address + complete instructions (U1) + web deep link (U6).
//
// Proves the deposit sheet renders the per-account native address AND a complete, reassuring
// instruction block (network name "Bitcoin", asset "BTC", est. time, fee, min, non-custody line).
// Opens the sheet via the WEB DEEP LINK `?screen=deposit` — a returning user (identity already in
// localStorage from onboarding) lands directly on the open sheet, which is also what makes the web
// build bookmarkable/shareable to top-up. Values are read from the REAL relay's `deposit_info`
// (FakeLedger: min_confirmations=1, deposit_fee=0, deposit_min_amount=0) — never hardcoded.
//
// Selector contract for Wave E1: `deposit-address` (the address text), `deposit-instructions`
// (the instruction card), `deposit-status` (the single linear progress cue), `btn-deposit-check`
// (manual refresh), `btn-deposit-copy` (copy), `btn-deposit-close` (Esc/X close).
import { setup, assert, assertIncludes, onboardWallet } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[03-deposit-address] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, webBaseURL, relayBaseURL } = env;

    // 1. Onboard once so an identity is persisted to localStorage (the deep link only auto-opens the
    //    sheet for a RETURNING user — Onboarding never mounts the Wallet).
    console.log('[03-deposit-address] onboarding to seed an identity…');
    await onboardWallet(driver, 'e2e-deposit');

    // 2. Re-navigate with the deep link. The browser context retains localStorage, so the Wallet
    //    mounts directly and `?screen=deposit` auto-opens the sheet. `domcontentloaded` because the
    //    Wallet's continuous polls (balance/history/deposit) can stall networkidle0.
    console.log('[03-deposit-address] deep-linking to ?screen=deposit…');
    const deepLink = `/?relay=${encodeURIComponent(relayBaseURL)}&screen=deposit`;
    await driver.navigate(webBaseURL, deepLink, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // 3. The sheet auto-opened via the deep link — the address is the gate.
    console.log('[03-deposit-address] waiting for the deposit address…');
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });
    const address = await driver.readText('deposit-address');
    // The FakeLedger derives a recognizable `bc1qdpay<pubkey[:8] hex>` address.
    assert(/^bc1qdpay[0-9a-f]{16}$/.test(address),
      `deposit address should look like a bc1qdpay… address, got "${address}"`);
    console.log(`[03-deposit-address] ✓ address: ${address}`);

    // 4. The complete instruction block is present and correct (the heart of U1). Every value comes
    //    from deposit_info; the network/asset are single-sourced constants in App.tsx.
    const body = await driver.bodyText();
    const checks = {
      'network name "Bitcoin"': 'Bitcoin',
      'asset "BTC"': 'BTC',
      'confirmation estimate': 'confirmation',
      'network fee line': 'fee',
      'minimum deposit line': 'Min',
      'non-custody reassurance': 'never holds',
    };
    for (const [label, needle] of Object.entries(checks)) {
      assertIncludes(body, needle, `deposit instructions should include ${label}`);
    }
    console.log('[03-deposit-address] ✓ instruction block complete (network/asset/time/fee/min/custody)');

    // 5. The single linear progress cue is present (U2): "Waiting for your deposit" (no pending utxos).
    assertIncludes(body, 'Waiting for your deposit', 'progress cue shows the waiting state');

    await driver.screenshot('03-deposit-address');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[03-deposit-address] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/03-deposit-address.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[03-deposit-address] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
