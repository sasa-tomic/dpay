// Flow 05 — Deposit credited end-to-end (ckBTC top-up through the REAL relay + FakeLedger).
//
// Proves the CREDITED deposit path — the money-in proof — not just the address/instructions (flows
// 03/04). The harness seeds a pending ckBTC deposit via the feature-gated `POST /api/v1/test/deposit/
// seed` route (currency 1 = ckBTC), then the app's OWN deposit sheet polls/refreshes (currency 1) →
// the FakeLedger drains + credits → the sheet flips to "Deposited ✓". The credit is then verified
// DIRECTLY against the real relay's currency-1 balance for this wallet's account.
//
// IMPORTANT — asset segregation (documented deviation, by design): the wallet HEADER balance shows
// `$` = DEMO_USD (currency 0); the deposit sheet operates on ckBTC (currency 1, DEPOSIT_CURRENCY).
// Per the canister's per-currency segregation (a CODEBASE_ANALYSIS strength), a currency-1 deposit
// credits the currency-1 balance — NOT the `$` header. So this test asserts the credited path on the
// DEPOSIT ASSET: (a) the sheet shows "Deposited ✓" + the minted BTC amount, and (b) the relay's
// currency-1 balance for this account grew by the seeded amount. The `$` header is a different asset
// (DEMO_USD) and deliberately does not move — surfacing it would blur the non-custodial, no-swap line.
//
// Selector contract: `btn-deposit` (Add money), `deposit-address`, `btn-deposit-check` (manual
// refresh), `deposit-status`. Seed route: POST /api/v1/test/deposit/seed {account, currency, amount}.
import { setup, assert, assertIncludes, seedDeposit, getBalance } from '../harness/lib.mjs';

const ONBOARD_PLACEHOLDER = 'e.g. Alice';
const DEPOSIT_CURRENCY = 1; // ckBTC — matches App.tsx DEPOSIT_CURRENCY (the deposit asset)
const SEED_SATS = 50_000;   // 0.00050000 BTC

export async function run() {
  const start = Date.now();
  console.log('[05-deposit-credited] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard → wallet, and capture THIS wallet's account (its pubkey hex) from localStorage. The
    //    deposit address + the seed target are both keyed off this account.
    console.log('[05-deposit-credited] onboarding…');
    await driver.typeByPlaceholder(ONBOARD_PLACEHOLDER, 'e2e-deposit', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    await driver.waitForText('$100.00', { timeoutMs: 12_000 });
    const identity = await driver.eval(() => {
      const v = localStorage.getItem('dpay.identity.v1');
      return v ? JSON.parse(v) : null;
    });
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    console.log(`[05-deposit-credited] wallet account: ${accountHex.slice(0, 16)}…`);

    // 2. Pre-credit: the ckBTC (currency 1) balance for this account is zero (only DEMO_USD funded).
    const before = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assert(before === 0, `pre-seed ckBTC balance must be 0, got ${before}`);

    // 3. Open the deposit sheet via the "Add money" affordance.
    console.log('[05-deposit-credited] opening the deposit sheet…');
    await driver.click('btn-deposit', { timeoutMs: 5_000 });
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });

    // 4. Seed a pending ckBTC deposit for THIS account via the test-helpers route. The balance is NOT
    //    credited yet — a real mint lands only after the next /deposit/refresh drains it (mirrors the
    //    ck minter minting after confirmations). This is the honesty property: no false "Deposited ✓".
    console.log(`[05-deposit-credited] seeding ${SEED_SATS} sats ckBTC via test/deposit/seed…`);
    const seeded = await seedDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY, SEED_SATS);
    assert(seeded?.seeded === true, `seed must return {seeded:true}, got ${JSON.stringify(seeded)}`);
    const notYet = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assert(notYet === 0, `seed must NOT credit the balance before a refresh, got ${notYet}`);

    // 5. Trigger the refresh via the sheet's manual "Check now" button (the app's OWN code path —
    //    POST /api/v1/deposit/refresh/{hex}?currency=1). The FakeLedger drains the pending deposit
    //    and credits currency 1; minted_total > 0 flips the sheet to "Deposited ✓".
    console.log('[05-deposit-credited] clicking btn-deposit-check (refresh)…');
    await driver.click('btn-deposit-check', { timeoutMs: 5_000 });
    const credited = await driver.waitForText('Deposited', { timeoutMs: 8_000 });
    const body = await driver.bodyText();
    assert(credited, `deposit sheet should show "Deposited ✓" after the refresh. body excerpt:\n${body.slice(0, 600)}`);
    // The minted amount renders via btc(minted_total) → "0.00050000 BTC minted".
    assertIncludes(body, '0.00050000 BTC', 'sheet should show the minted BTC amount');
    console.log('[05-deposit-credited] ✓ sheet shows "Deposited ✓" + minted amount');

    // 6. The credited path proven directly on the real ledger: the currency-1 balance grew by the
    //    seeded amount. (The `$` wallet header is currency 0 — a separate asset; see file header.)
    const after = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assert(after === SEED_SATS, `credited ckBTC balance must equal the seed (${SEED_SATS}), got ${after}`);
    console.log(`[05-deposit-credited] ✓ ckBTC balance 0 → ${after} sats (credited through the REAL relay+FakeLedger)`);

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
