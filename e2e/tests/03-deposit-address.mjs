// Flow 03 — Deposit (Receive "My address"): address + complete instructions (U1) + web deep link.
//
// Proves the on-chain deposit surface renders the per-account native address AND a complete,
// reassuring instruction block (network name "Bitcoin", asset "BTC", est. time, fee, min, non-custody
// line). The `?screen=deposit` deep link now lands a returning user (identity already in localStorage
// from onboarding) directly on the Receive tab's "My address" sub-mode for ckBTC (the deposit/withdraw
// surfaces moved OUT of the Balances per-row buttons INTO the Pay/Receive tabs). Values are read from
// the REAL relay's `deposit_info` (FakeLedger: min_confirmations=1, deposit_fee=0,
// deposit_min_amount=0) — never hardcoded.
//
// Selector contract for Wave E1: `deposit-address` (the address text), `deposit-instructions`
// (the instruction card), `deposit-status` (the single linear progress cue), `btn-deposit-check`
// (manual refresh), `btn-deposit-copy` (copy). (The old `btn-deposit-close` is gone — the inline body
// has no overlay close button; the "Done" button + the toggle handle the exit.)
import { setup, assert, assertIncludes, onboardWallet } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '03',
  name: 'deposit-address',
  journey: 'deposit',
  covers: ['deposit-address', 'qr', 'instructions', 'fee-min', 'deep-link'],
  verifies: 'ckBTC deposit sheet: address + QR + instructions + fee/min; deep-link ?screen=deposit works.',
  timeoutMs: 15000,
};

export async function run() {
  const start = Date.now();
  console.log('[03-deposit-address] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, webBaseURL, relayBaseURL } = env;

    // 1. Onboard once so an identity is persisted to localStorage (the deep link only seeds the
    //    Receive "My address" sub-mode for a RETURNING user — Onboarding never mounts the Wallet).
    console.log('[03-deposit-address] onboarding to seed an identity…');
    await onboardWallet(driver, 'e2e-deposit');

    // 2. Re-navigate with the deep link. The browser context retains localStorage, so the Wallet
    //    mounts directly and `?screen=deposit` flips mode to 'receive' + the "My address" sub-mode +
    //    selects ckBTC. `domcontentloaded` because the Wallet's continuous polls can stall networkidle0.
    console.log('[03-deposit-address] deep-linking to ?screen=deposit (Receive → My address)…');
    const deepLink = `/?relay=${encodeURIComponent(relayBaseURL)}&screen=deposit`;
    await driver.navigate(webBaseURL, deepLink, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // 3. The deep link landed on the Receive "My address" sub-mode — the address is the gate.
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

    // C3: the INSTRUCTIONS block must NEVER render a raw "0.00000000". The FakeLedger/test minter
    // returns zero fee + zero min; the line now shows "—" for a zero value (instead of formatting
    // zero to 8 decimals, which read as a broken stub). Scoped to the deposit-instructions card: the
    // wallet's always-visible zero-balance asset cards (MC5) correctly render "0.00000000 BTC" behind
    // the sheet, so a body-wide check would false-trip on those. Production's non-zero values format
    // normally.
    const instrEl = await driver.findByTestID('deposit-instructions', { timeoutMs: 5_000 });
    const instrTxt = await instrEl.evaluate((n) => (n.textContent ?? '').trim());
    assert(!instrTxt.includes('0.00000000'),
      `deposit instructions must never show a raw zero amount like "0.00000000" (C3). instructions text:\n${instrTxt}`);
    console.log('[03-deposit-address] ✓ no raw zero amounts in instructions (fee/min show "—" when zero)');

  // 5. The single linear progress cue is present (U2): "Watching for your deposit" — the honest
  //    balance-watching copy of the user-principal rail (the facade per-UTXO cue died with custody).
  assertIncludes(body, 'Watching for your deposit', 'progress cue shows the waiting state');

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
