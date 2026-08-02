// Flow 05 — Deposit credited end-to-end (BTC top-up through the REAL relay + FakeLedger).
//
// Proves the CREDITED deposit path — the money-in proof — not just the address/instructions (flows
// 03/04). The harness seeds a pending BTC deposit via the feature-gated `POST /api/v1/test/deposit/
// seed` route (currency 1 = BTC), then the app's OWN deposit sheet polls/refreshes (currency 1) →
// the FakeLedger drains + credits → the sheet flips to "Deposited ✓". The credit is then verified
// DIRECTLY against the real relay's currency-1 balance for this wallet's account.
//
// SEAMLESSNESS PROOF (the user's primary goal): after the sheet closes, the credited BTC must
// remain VISIBLE in the wallet — the F1 fix surfaces currency 1 as a clearly-labeled "Bitcoin"
// asset card (testID `asset-ckbtc`) on the same balance poll. So this test closes the sheet and
// asserts `asset-ckbtc` is present + shows the minted BTC amount. A top-up that credits an INVISIBLE
// balance is broken UX; this guards exactly that regression.
//
// IMPORTANT — asset segregation (documented, by design): the wallet HEADER balance shows `$` =
// DEMO_USD (currency 0); the deposit + the visible asset card operate on BTC (currency 1,
// DEPOSIT_CURRENCY). Per the canister's per-currency segregation (a CODEBASE_ANALYSIS strength), a
// currency-1 deposit credits the currency-1 balance — NOT the `$` header. So this test asserts the
// credited path on the DEPOSIT ASSET: (a) the sheet shows "Deposited ✓" + minted BTC, (b) the
// relay's currency-1 balance grew, and (c) the wallet's `asset-ckbtc` card shows the minted BTC
// after the sheet closes. The `$` header is a different asset (DEMO_USD) and deliberately does not
// move — merging them would blur the non-custodial, no-swap line.
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc` (the BTC row in the Balances
// sheet), `asset-add-ckbtc` (BTC row Add → deposit sheet), `deposit-address`, `btn-deposit-check`
// (manual refresh), `deposit-status`, `btn-deposit-close`. Seed route: POST /api/v1/test/deposit/seed
// {account, currency, amount}.
import { setup, assert, assertIncludes, seedDeposit, getBalance, onboardWallet, accountOf, openBalances } from '../harness/lib.mjs';

const DEPOSIT_CURRENCY = 1; // BTC — matches App.tsx DEPOSIT_CURRENCY (the deposit asset)
const SEED_SATS = 50_000;   // 0.00050000 BTC

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '05',
  name: 'deposit-credited',
  journey: 'deposit',
  covers: ['deposit-credit', 'mint', 'asset-card', 'balance-update'],
  verifies: 'ckBTC deposit lands via test-helpers seed → \'Deposited ✓\', balance updates, asset card appears.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[05-deposit-credited] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard → wallet, and capture THIS wallet's account (its pubkey hex) from localStorage. The
    //    deposit address + the seed target are both keyed off this account.
    console.log('[05-deposit-credited] onboarding…');
    await onboardWallet(driver, 'e2e-deposit');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    console.log(`[05-deposit-credited] wallet account: ${accountHex.slice(0, 16)}…`);

    // Before any top-up, open the Balances sheet. The BTC row is ALWAYS visible there — asset rows
    // render at every balance (including zero). Assert it reads the zero balance in BTC units + carries
    // the BTC label (MC5: cards always visible, clearly labeled, never merged). The sheet stays open
    // for the whole flow: the deposit sheet stacks ON TOP of it, and closing the deposit returns here.
    console.log('[05-deposit-credited] opening Balances…');
    await openBalances(driver);
    const zeroCard = await driver.findByTestID('asset-ckbtc', { timeoutMs: 5_000 });
    const zeroTxt = await zeroCard.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(zeroTxt, '0 BTC', `the BTC card should show the zero balance before any top-up. card text:\n${zeroTxt}`);
    assertIncludes(zeroTxt, 'BTC', `the BTC card should be clearly labeled "BTC". card text:\n${zeroTxt}`);
    console.log(`[05-deposit-credited] BTC card visible at zero balance: "${zeroTxt}"`);

    // 2. Pre-credit: the BTC (currency 1) balance for this account is zero (only DEMO_USD funded).
    const before = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assert(before === '0', `pre-seed BTC balance must be 0, got ${before}`);

    // 3. Open the deposit sheet from the Balances BTC row's "Add" action (stacks on top of Balances).
    console.log('[05-deposit-credited] opening the deposit sheet (from the Balances BTC row)…');
    await driver.click('asset-add-ckbtc', { timeoutMs: 5_000 });
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });

    // 4. Seed a pending BTC deposit for THIS account via the test-helpers route. The balance is NOT
    //    credited yet — a real mint lands only after the next /deposit/refresh drains it (mirrors the
    //    ck minter minting after confirmations). This is the honesty property: no false "Deposited ✓".
    console.log(`[05-deposit-credited] seeding ${SEED_SATS} sats BTC via test/deposit/seed…`);
    const seeded = await seedDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY, SEED_SATS);
    assert(seeded?.seeded === true, `seed must return {seeded:true}, got ${JSON.stringify(seeded)}`);
    const notYet = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assert(notYet === '0', `seed must NOT credit the balance before a refresh, got ${notYet}`);

    // 5. The deposit sheet's own auto-poll (refreshNow, the app's real code path) drains the seeded
    //    pending deposit and credits currency 1; minted_total > 0 flips the sheet to "Deposited ✓".
    //    (The manual "Check now" button calls the same refreshNow — under the fast-poll harness the
    //    auto-poll credits within ~150ms, so the manual nudge is racy and redundant here.)
    console.log('[05-deposit-credited] waiting for the auto-poll to credit the deposit…');
    const credited = await driver.waitForText('Deposited', { timeoutMs: 8_000 });
    const body = await driver.bodyText();
    assert(credited, `deposit sheet should show "Deposited ✓" after the refresh. body excerpt:\n${body.slice(0, 600)}`);
    // The minted amount renders via btc(minted_total) → "0.00050000 BTC minted".
    assertIncludes(body, '0.00050000 BTC', 'sheet should show the minted BTC amount');
    console.log('[05-deposit-credited] ✓ sheet shows "Deposited ✓" + minted amount');

    // 6. The credited path proven directly on the real ledger: the currency-1 balance grew by the
    //    seeded amount. (The `$` wallet header is currency 0 — a separate asset; see file header.)
    const after = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assert(after === String(SEED_SATS), `credited BTC balance must equal the seed (${SEED_SATS}), got ${after}`);
    console.log(`[05-deposit-credited] ✓ BTC balance 0 → ${after} sats (credited through the REAL relay+FakeLedger)`);

    // 7. SEAMLESSNESS: close the deposit sheet (returns to the Balances sheet still open underneath)
    //    and prove the credited BTC stays VISIBLE. The wallet's balance poll (every 2.5s) fetches
    //    currency 1; the Balances BTC row re-renders with the minted amount. A top-up whose balance
    //    vanishes when the sheet closes is the bug this guards.
    console.log('[05-deposit-credited] closing the deposit sheet — asserting the balance stays visible…');
    await driver.click('btn-deposit-close', { timeoutMs: 5_000 });
    await driver.waitGone('deposit-address', { timeoutMs: 4_000 });
    // Re-open Balances (opening the deposit closed it — one sheet at a time). The BTC row re-renders
    // with the minted amount on the next currency-1 poll (≤2.5s).
    await openBalances(driver);
    const assetEl = await driver.findByTestID('asset-ckbtc', { timeoutMs: 8_000 });
    const assetTxt = await assetEl.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(assetTxt, '0.00050000 BTC', `the wallet's visible BTC card should show the minted BTC after the sheet closes. card text:\n${assetTxt}`);
    assertIncludes(assetTxt, 'BTC', 'the BTC card should be clearly labeled "BTC" (the deposited asset name, H1)');
    console.log(`[05-deposit-credited] ✓ BTC balance VISIBLE in the wallet post-close: "${assetTxt}"`);

    await driver.screenshot('05-deposit-credited');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[05-deposit-credited] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[05-deposit-credited] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
