// Flow 24 — Group A UX fixes (H1/H2/H3/H4): asset labels (name-primary, not chain), multi-currency
// history, header cleanup (username only, no hex), short history counterparties.
//
// This flow is the RED→GREEN gate for the four Group-A issues:
//   - H1: ckUSDC was labeled "Ethereum" (the chain) instead of "ckUSDC" (the asset). The picker rows
//         + the wallet asset card must show the asset NAME (symbol) as the primary heading; the chain
//         ('Ethereum'/'Bitcoin') appears ONLY in the "Send X on NETWORK" instruction line.
//   - H2: history was hardcoded to currency=0, so ckBTC/ckUSDC payments never appeared. The wallet
//         must now fetch history for EVERY catalog currency, union + dedup by nonce, newest-first.
//         Proven by settling a currency-1 (ckBTC) payment and asserting it surfaces in RECENT — the
//         ONLY way the wallet learns of the payee is via the currency-1 ledger, so its appearance
//         proves the multi-currency fetch.
//   - H3: counterparties were raw 64-char hex. Now shortened (best-effort; the username isn't in the
//         signed wire — N6/FROZEN core). Assert the FULL 64-char hex is absent and the short form is.
//   - H4: the header appended the hex pubkey ("Alice · 1b8a5ee7…"). Now username only.
//
// Selector contract: `header-who` (username line, added by this change), `btn-deposit`,
// `asset-picker-row-ckusdc` / `asset-picker-row-ckbtc`, `btn-picker-close`.
import { setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, seedDeposit, refreshDeposit, postPay } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, signAuthorizationCode } from '../harness/wire.mjs';

const CKBTC_CURRENCY = 1;   // the CkBtcUtxo catalog entry (resolved at runtime, not hardcoded in app)
const SEED_SATS = 60_000;   // 0.00060000 BTC — funds A so it can spend currency 1
const PAY_SATS = 50_000;    // 0.00050000 BTC — under the per-tx cap; a valid currency-1 payment

export async function run() {
  const start = Date.now();
  console.log('[24-wallet-cleanup] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // Onboard A (funded $100 DEMO_USD by the faucet). Capture its identity (pubkey + secret) so the
    // currency-1 payment can be signed Node-side with A's real on-device key.
    await onboardWallet(driver, 'e2e-alice');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    assert(typeof identity?.secretHex === 'string' && identity.secretHex.length === 64, 'wallet secret must be present for Node-side signing');

    // --- H4: the header shows ONLY the username; the hex pubkey is gone from the main display. -----
    const whoText = await driver.readText('header-who');
    assertEq(whoText, 'e2e-alice', 'header who line');
    assert(!whoText.includes(accountHex.slice(0, 8)), `header must NOT include the hex pubkey, got "${whoText}"`);
    console.log('[24-wallet-cleanup] ✓ header shows only the username (H4)');

    // --- H1: picker rows are labeled by the asset NAME (symbol), not the chain. -------------------
    // ckUSDC: primary heading "ckUSDC" (was "Ethereum"). The chain still appears in the instruction
    // subtitle "Send USDC on Ethereum" — that's correct. ckBTC: primary heading "ckBTC" (was "Bitcoin").
    await driver.click('btn-deposit', { timeoutMs: 5_000 });
    const ckusdcRow = await driver.findByTestID('asset-picker-row-ckusdc', { timeoutMs: 5_000 });
    const ckusdcTxt = await ckusdcRow.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(ckusdcTxt, 'ckUSDC', 'ckUSDC picker row must be labeled "ckUSDC" (not "Ethereum")');
    assert(ckusdcTxt.startsWith('ckUSDC'), `ckUSDC row primary heading should be "ckUSDC", got "${ckusdcTxt}"`);
    const ckbtcRow = await driver.findByTestID('asset-picker-row-ckbtc', { timeoutMs: 3_000 });
    const ckbtcTxt = await ckbtcRow.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(ckbtcTxt, 'ckBTC', 'ckBTC picker row must be labeled "ckBTC"');
    console.log(`[24-wallet-cleanup] ✓ picker rows name-first (H1): ckUSDC="${ckusdcTxt}" / ckBTC="${ckbtcTxt}"`);
    await driver.click('btn-picker-close', { timeoutMs: 5_000 });
    await driver.waitGone('asset-picker-row-ckusdc', { timeoutMs: 3_000 });

    // --- H2: multi-currency history. Seed ckBTC, pay in currency 1, assert it lands in RECENT. -----
    // Seed + refresh a ckBTC (currency 1) deposit so A can spend it (deposit_status credits the
    // balance; it does NOT itself create a history row — only a settled pay/withdraw does).
    await seedDeposit(relayBaseURL, accountHex, CKBTC_CURRENCY, SEED_SATS);
    await refreshDeposit(relayBaseURL, accountHex, CKBTC_CURRENCY);
    // Settle a currency-1 payment A → B (signed Node-side with A's key, byte-exact vs the Rust core
    // per flow 00, so the FakeLedger verifies the sig + settles). This records a TxnRecord on
    // currency 1 — invisible to the OLD currency=0-only history fetch; visible to the new multi-currency one.
    const bob = await generateKeypair();
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const code = await signAuthorizationCode(identity.secretHex, bob.publicHex, PAY_SATS, nonce, expiry, CKBTC_CURRENCY);
    const pay = await postPay(relayBaseURL, code);
    assert(pay.ok === true && pay.status === 200, `currency-1 pay must settle (ok+200), got ${JSON.stringify(pay)}`);
    console.log('[24-wallet-cleanup] ✓ currency-1 (ckBTC) payment settled');

    // The wallet's history poll (fast-poll seam) must now fetch currency 1 and surface the row. B
    // never transacted in currency 0, so B's appearance in RECENT PROVES the currency-1 fetch landed.
    const hasRecent = await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    assert(hasRecent, 'RECENT card should render once the currency-1 payment lands in history');
    const sawShort = await driver.waitForText(bob.publicHex.slice(0, 8), { timeoutMs: 8_000 });
    assert(sawShort, 'history should show the currency-1 payee (short pubkey) — proves multi-currency fetch (H2)');

    // --- H3: counterparty is shown SHORT, not the full 64-char hex blob. --------------------------
    const histBody = await driver.bodyText();
    assertIncludes(histBody, bob.publicHex.slice(0, 8), 'history should show the short counterparty');
    assert(!histBody.includes(bob.publicHex), 'history must NOT dump the full 64-char counterparty hex (H3)');
    console.log('[24-wallet-cleanup] ✓ multi-currency history (H2) + short counterparty (H3)');

    await driver.screenshot('24-wallet-cleanup');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[24-wallet-cleanup] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[24-wallet-cleanup] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
