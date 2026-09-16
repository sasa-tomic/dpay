// Flow 24 — Group A UX fixes (H1/H2/H3/H4): asset labels (name-primary, not chain), multi-currency
// history, header cleanup (username only, no key material), short history counterparties.
//
// IC-rail cutover: the currency-1 (ckBTC) funding + payment now ride the RAIL — the test-helper
// faucet credits the fake-IC ledger for currency 1, and the payment is a REAL signed icrc1_transfer
// envelope (railTransfer, Node-side with A's on-device key) submitted to /api/v2/canister/<ledger>/call.
//
//   - H1: USDC labeled "USDC" (the asset), not "Ethereum" (the chain); BTC likewise.
//   - H2: history fans out to EVERY catalog currency. Proven by settling a currency-1 (BTC)
//         transfer — the ONLY way the wallet learns of the payee is via the currency-1 ledger.
//   - H3: counterparties render SHORT. On the IC rail, rows carry PRINCIPAL TEXT (not hex pubkeys):
//         assert the short PRINCIPAL prefix is shown and the FULL principal (and the old hex pubkey)
//         are absent.
//   - H4: the header shows ONLY the username.
//
// Selector contract: `header-who` (username line), `balance` (header → Home tab),
// `asset-ckusdc` / `asset-ckbtc` (the currency rows in the Home accounts list), `tab-pay`.
import { setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, railTransfer, railPrincipalText, openBalances } from '../harness/lib.mjs';
import { openHistory } from '../harness/flow-steps.mjs';
import { generateKeypair } from '../harness/wire.mjs';

const CKBTC_CURRENCY = 1;   // the CkBtcUtxo catalog entry (resolved at runtime, not hardcoded in app)
const SEED_SATS = 60_000;   // 0.00060000 BTC — funds A so it can spend currency 1
const PAY_SATS = 50_000;    // 0.00050000 BTC — the currency-1 payment

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '24',
  name: 'wallet-cleanup',
  journey: 'system',
  covers: ['asset-cards', 'labels', 'symbols'],
  verifies: 'Funded non-dollar balances/history (rail faucet + icrc1_transfer on currency 1) render as asset cards/rows with known symbols and short principal-text counterparties.',
  timeoutMs: 25_000,
};

export async function run() {
  const start = Date.now();
  console.log('[24-wallet-cleanup] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // Onboard A (funded ∂100 DEMO by the faucet). Capture its identity (pubkey + secret) so the
    // currency-1 transfer can be signed Node-side with A's real on-device key.
    await onboardWallet(driver, 'e2e-alice');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    assert(typeof identity?.secretHex === 'string' && identity.secretHex.length === 64, 'wallet secret must be present for Node-side signing');

    // --- H4: the header shows ONLY the username; key material is gone from the main display. ----
    const whoText = await driver.readText('header-who');
    assertEq(whoText, 'e2e-alice', 'header who line');
    assert(!whoText.includes(accountHex.slice(0, 8)), `header must NOT include the hex pubkey, got "${whoText}"`);
    console.log('[24-wallet-cleanup] ✓ header shows only the username (H4)');

    // --- H1: Balances rows are labeled by the asset NAME (symbol), not the chain. ----------------
    await openBalances(driver);
    const ckusdcRow = await driver.findByTestID('asset-ckusdc', { timeoutMs: 5_000 });
    // Rows lead with the family monogram chip ($ ₿ Ξ …) — decorative, strip before the heading check.
    const stripGlyph = (t) => t.replace(/^[^\w]+/, '');
    const ckusdcTxt = await ckusdcRow.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(ckusdcTxt, 'USDC', 'USDC row must be labeled "USDC" (not "Ethereum")');
    assert(stripGlyph(ckusdcTxt).startsWith('USDC'), `USDC row primary heading should be "USDC", got "${ckusdcTxt}"`);
    const ckbtcRow = await driver.findByTestID('asset-ckbtc', { timeoutMs: 3_000 });
    const ckbtcTxt = await ckbtcRow.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(ckbtcTxt, 'BTC', 'BTC row must be labeled "BTC"');
    console.log(`[24-wallet-cleanup] ✓ Balances rows name-first (H1): USDC="${ckusdcTxt}" / BTC="${ckbtcTxt}"`);
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await driver.waitGone('asset-ckusdc', { timeoutMs: 3_000 });

    // --- H2 prep: fund A with ckBTC via the rail faucet (test-helper on the fake-IC ledger). -----
    const seed = await fetch(`${relayBaseURL}/api/v1/faucet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: accountHex, currency: CKBTC_CURRENCY, amount: SEED_SATS }),
    });
    assert(seed.ok, `currency-1 faucet seed must succeed, got ${seed.status}`);
    console.log('[24-wallet-cleanup] ✓ ckBTC seeded via the rail faucet');

    // --- H2/H3: settle a currency-1 icrc1_transfer A → B (railTransfer signs + submits the
    // envelope to /api/v2/canister/<ckBTC-ledger>/call; the fake-IC ledger executes it). B never
    // transacted in currency 0, so B's appearance in RECENT PROVES the currency-1 history fetch.
    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const pay = await railTransfer(relayBaseURL, identity.secretHex, bob.publicHex, BigInt(PAY_SATS), {currency: CKBTC_CURRENCY});
    assert(pay.ok === true && pay.status === 202, `currency-1 rail transfer must be accepted (202), got ${JSON.stringify(pay)}`);
    console.log('[24-wallet-cleanup] ✓ currency-1 (BTC) icrc1_transfer accepted by the IC gateway');

    assert(await openHistory(driver), 'RECENT card should render once the currency-1 transfer lands in history');
    const sawShort = await driver.waitForText(bobPrincipal.slice(0, 8), { timeoutMs: 8_000});
    assert(sawShort, 'history should show the currency-1 payee (short PRINCIPAL text) — proves multi-currency fetch (H2)');

    // --- H3: counterparty is shown SHORT (principal prefix), never the full identifier. ----------
    const histBody = await driver.bodyText();
    assertIncludes(histBody, bobPrincipal.slice(0, 8), 'history should show the short principal counterparty');
    assert(!histBody.includes(bobPrincipal), 'history must NOT dump the full principal text (H3)');
    assert(!histBody.includes(bob.publicHex), 'history must NOT show the raw hex pubkey either (H3)');
    console.log('[24-wallet-cleanup] ✓ multi-currency history (H2) + short principal counterparty (H3)');

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
