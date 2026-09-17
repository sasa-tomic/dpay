// Flow 05 — Deposit credited end-to-end (BTC top-up through the REAL relay + fake-IC gateway).
//
// Proves the CREDITED deposit path — the money-in proof — not just the address/instructions (flows
// 03/04). On the IC user-principal rail (2026-08-19 cutover) a deposit = funds landing at
// Account{owner: the user's principal} on the currency's ledger. The harness simulates the
// Bitcoin-side leg by crediting fake-IC ckBTC (currency 1) at THIS wallet's principal via
// `POST /api/v1/faucet {account, currency: 1, amount}` — the documented deposit-simulation seam.
// Detection is the app's OWN honest mechanism: DepositSheet captures a railBalanceOf baseline on
// its first successful ledger read, then rechecks (150ms poll in the harness, 10s in prod + the
// "Check now" button) — any strictly-higher read is the minted delta, shown as "Deposited ✓" +
// "<amount> minted". No per-UTXO confirmations exist at the user principal (that view died with
// facade custody); the sheet reports a BALANCE DELTA, and this flow asserts exactly that contract.
//
// SEAMLESSNESS PROOF (the user's primary goal): after the deposit completes, the credited BTC must
// remain VISIBLE in the wallet — the Balances sheet surfaces currency 1 as a clearly-labeled BTC
// asset row (testID `asset-ckbtc`) on the same balance poll. So this test flips back to "Request
// payment", re-opens Balances, and asserts `asset-ckbtc` shows the minted BTC amount. A top-up
// that credits an INVISIBLE balance is broken UX; this guards exactly that regression.
//
// IMPORTANT — asset segregation (documented, by design): the wallet HEADER balance shows `∂` =
// DEMO_USD (currency 0); the deposit + the visible asset row operate on BTC (currency 1,
// DEPOSIT_CURRENCY). A currency-1 faucet credit lands on the currency-1 rail — NOT the `∂` header.
// So this test asserts the credited path on the DEPOSIT ASSET: (a) the sheet shows "Deposited ✓" +
// minted BTC, (b) the relay's currency-1 balance grew, and (c) the wallet's `asset-ckbtc` row shows
// the minted BTC. The `∂` header is a different asset (DEMO_USD) and deliberately does not move —
// merging them would blur the non-custodial, no-swap line.
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc` (the BTC row in the Balances
// sheet), `asset-ckbtc-select` (the whole-row select Pressable), `btn-receive-address`
// (Receive → "My address"), `deposit-address`, `btn-deposit-check` (manual "Check now"),
// `deposit-status` (the "Watching for your deposit" cue). Value seam: POST /api/v1/faucet
// {account, currency, amount}.
import { setup, assert, assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openBalances, selectCurrency, openReceiveAddress, railPrincipalText } from '../harness/lib.mjs';

const DEPOSIT_CURRENCY = 1; // ckBTC — the Balances row selected for the deposit flow
const SEED_SATS = 50_000;   // 0.0005 BTC

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '05',
  name: 'deposit-credited',
  journey: 'deposit',
  covers: ['deposit-credit', 'mint-delta', 'asset-card', 'balance-update'],
  verifies: 'ckBTC deposit lands via faucet-at-principal → balance-recheck delta "Deposited ✓", relay balance grows, asset row appears.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[05-deposit-credited] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard → wallet, and capture THIS wallet's account (its pubkey hex) from localStorage. The
    //    deposit address + the faucet target are both keyed off this account's PRINCIPAL.
    console.log('[05-deposit-credited] onboarding…');
    await onboardWallet(driver, 'e2e-deposit');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    console.log(`[05-deposit-credited] wallet account: ${accountHex.slice(0, 16)}…`);

    // Before any top-up, open the Balances sheet. The BTC row is ALWAYS visible there — asset rows
    // render at every balance (including zero). Assert it reads the zero balance in BTC units + carries
    // the BTC label. The sheet stays open long enough to read the row; we then SELECT ckBTC so the
    // Receive "My address" sub-mode keys off it.
    console.log('[05-deposit-credited] opening Balances…');
    await openBalances(driver);
    const zeroCard = await driver.findByTestID('asset-ckbtc', { timeoutMs: 5_000 });
    const zeroTxt = await zeroCard.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(zeroTxt, '0 BTC', `the BTC card should show the zero balance before any top-up. card text:\n${zeroTxt}`);
    assertIncludes(zeroTxt, 'BTC', `the BTC card should be clearly labeled "BTC". card text:\n${zeroTxt}`);
    console.log(`[05-deposit-credited] BTC card visible at zero balance: "${zeroTxt}"`);

    // 2. Pre-credit: the ckBTC (currency 1) rail balance for this account is zero (only DEMO_USD funded).
    const before = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assert(before === '0', `pre-fund ckBTC balance must be 0, got ${before}`);

    // 3. Select ckBTC (makes it the active asset) → Receive → "My address" (the inline deposit body).
    //    Count the sheet's OWN ledger reads first (installed before it mounts): every
    //    `railBalanceOf` is a signed `icrc1_balance_of` posted to `/api/v2/canister/<ledger>/query`,
    //    so the count is a direct, deterministic witness of "the sheet has polled the ledger N
    //    times" — which is what step 4 needs and what a wall-clock sleep could only guess at.
    console.log('[05-deposit-credited] selecting ckBTC → Receive → My address…');
    await driver.eval(() => {
      globalThis.__E2E_IC_QUERIES = [];
      const real = globalThis.fetch;
      globalThis.fetch = async function countedFetch(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        const r = await real.call(this, input, init);
        if (/\/api\/v2\/canister\/[^/]+\/query$/.test(url)) globalThis.__E2E_IC_QUERIES.push(url);
        return r;
      };
    });
    await selectCurrency(driver, 'ckbtc');
    await openReceiveAddress(driver);
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });

    // 3b. The deposit address is derived by the minter query at THIS user's principal — assert it
    //     matches the gateway's documented derivation 'bc1qdpay' + hex(principal[:8]) (16 hex
    //     chars), tying the address to the principal the faucet credits. hex() lowercases, so the
    //     trailing 16 chars are strictly [0-9a-f].
    const address = await driver.readText('deposit-address');
    const principalText = await railPrincipalText(accountHex);
    assert(/^bc1qdpay[0-9a-f]{16}$/.test(address), `deposit address should look like a bc1qdpay… address, got "${address}"`);
    console.log(`[05-deposit-credited] address ${address} (derived at principal ${principalText.slice(0, 12)}…)`);

    // 4. Let the sheet's balance recheck capture its WATCHING BASELINE before any funds move. The
    //    sheet polls railBalanceOf every POLL.deposit (150ms in the harness); its first successful
    //    read is the baseline, and only a strictly-higher LATER read counts as the mint. If the
    //    baseline were captured AFTER the faucet credit it would swallow the whole deposit and the
    //    delta would never fire — so the pre-fund reads are WAITED FOR, not slept through: two
    //    completed `/query` round trips mean the first one's reply has had a full poll cycle to be
    //    decoded and stored. (A wall-clock 700ms bought zero reads on a host slow enough, which is
    //    exactly the load-sensitive failure this replaces. An app-side "baseline captured" signal
    //    would make it exact; DepositSheet keeps the baseline in a ref that renders nothing, so
    //    there is none to wait on today — the counted reads are the closest honest witness.)
    await driver.waitForFunction(
      () => (globalThis.__E2E_IC_QUERIES?.length ?? 0) >= 2,
      { timeoutMs: 10_000, label: 'the deposit sheet completed two pre-fund ledger balance reads' },
    );
    const watching = await driver.bodyText();
    assertIncludes(watching, 'Watching for your deposit', 'the sheet should be in the honest watching state before funding (baseline captured)');

    // 5. Fund the deposit: credit fake-IC ckBTC at THIS wallet's principal via the faucet (the
    //    documented deposit-simulation seam — the stand-in for the Bitcoin leg landing at the
    //    minter + minting 1:1 at the owner's account).
    console.log(`[05-deposit-credited] crediting ${SEED_SATS} sats ckBTC at the wallet's principal via faucet…`);
    const funded = await faucetAccount(relayBaseURL, accountHex, SEED_SATS, { currency: DEPOSIT_CURRENCY });
    assert(funded.ok, `faucet credit should succeed, got status ${funded.status}: ${JSON.stringify(funded.body)}`);

    // 6. Click the manual "Check now" button — the app's own refreshNow recheck (the same function
    //    the 150ms auto-poll runs). Honest semantics: strictly-higher-than-baseline = minted delta.
    //    The 150ms auto-poll can legitimately win this race (same code path, same outcome); if the
    //    button already unmounted because the sheet flipped to "Deposited ✓", that IS the credited
    //    state — only a flip that never happens is a failure (asserted next).
    console.log('[05-deposit-credited] clicking btn-deposit-check (Check now)…');
    await driver.click('btn-deposit-check', { timeoutMs: 3_000 }).catch(async (e) => {
      const already = await driver.waitForText('Deposited', { timeoutMs: 2_000 });
      if (!already) throw e;
    });

    // 7. The sheet flips to "Deposited ✓" + the minted delta ("0.0005 BTC minted" via
    //    fmtAsset(delta, 8, 'BTC')). This is the honest balance-delta report — no per-UTXO cues.
    console.log('[05-deposit-credited] waiting for the deposit to be detected…');
    const credited = await driver.waitForText('Deposited', { timeoutMs: 8_000 });
    const body = await driver.bodyText();
    assert(credited, `deposit sheet should show "Deposited ✓" after the recheck. body excerpt:\n${body.slice(0, 600)}`);
    assertIncludes(body, '0.0005 BTC', 'sheet should show the minted BTC delta');
    console.log('[05-deposit-credited] ✓ sheet shows "Deposited ✓" + minted delta');

    // 8. The credited path proven directly on the rail: the currency-1 balance grew by the funded
    //    amount. (The `∂` wallet header is currency 0 — a separate asset; see file header.)
    const after = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assert(after === String(SEED_SATS), `credited ckBTC balance must equal the faucet amount (${SEED_SATS}), got ${after}`);
    console.log(`[05-deposit-credited] ✓ ckBTC rail balance 0 → ${after} sats (credited at the user principal)`);

    // 9. SEAMLESSNESS: flip the toggle back to "Request payment" (hides the inline deposit body) and
    //    prove the credited ckBTC stays VISIBLE. The wallet's balance poll fetches every catalog
    //    currency; re-open the Balances hub and the BTC row re-renders with the minted amount. A
    //    top-up whose balance vanishes when the deposit closes is the bug this guards.
    console.log('[05-deposit-credited] toggle to "Request payment" — asserting the balance stays visible…');
    await driver.click('btn-receive-request', { timeoutMs: 5_000 });
    await driver.waitGone('deposit-address', { timeoutMs: 4_000 });
    await openBalances(driver);
    const assetEl = await driver.findByTestID('asset-ckbtc', { timeoutMs: 8_000 });
    const assetTxt = await assetEl.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(assetTxt, '0.0005 BTC', `the wallet's visible BTC card should show the minted BTC after the sheet closes. card text:\n${assetTxt}`);
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
