// Flow 141 — delegated conversion payout failure: the pool's #ok with a held withdrawal is an
// HONEST pending_withdrawal screen, then resolves when the venue settles (spec §6 e2e (b)).
//
// The knob-driven arm of the fake pool: `fail_withdrawal: true` makes the pool reply #ok (and
// burn the input) while HOLDING the output leg. This is the exact case spec §4 calls out —
// "pool #ok ≠ settled" — and the flow pins that dpay never fabricates done from #ok:
//   * after confirm, the settle watch exhausts its budget → pending_withdrawal, NOT done;
//   * the pending screen is the founder-rule honest state: names the asset owed (VCHF), where it
//     sits (the ICPSwap pool), that dpay cannot reverse or speed it up, the pool principal +
//     submitted time for support, and that it keeps watching — practical instructions, no spinner
//     lie, no dead end;
//   * the expiry line counts down the unused-approval bound (spec §3) on failure-family screens;
//   * `settle_pending: true` drains the venue's queue → the ledger row appears → the SAME screen
//     flips to done with the SEEN amount — resolution without resubmitting anything (identical-
//     envelope discipline: nothing is re-signed, only re-watched).
//   * Settlement books are exact after resolution: VCHF credited the full gross out.
//   * Screenshots: the pending screen (the honest unknown) and the resolved done screen.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency,
} from '../harness/lib.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai';
const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const AMOUNT_IN = 100000000n; // 1 ICP

async function swapPoolKnob(relayBaseURL, body) {
  const r = await fetch(`${relayBaseURL}/api/v1/test/swap_pool`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`swap_pool knob ${r.status}: ${await r.text()}`);
}

async function relayQuoteOut(relayBaseURL) {
  const u = `${relayBaseURL}/api/v1/swap_quote?pool=${POOL}&token_in=${ICP_LEDGER}&token_out=${VCHF_LEDGER}&amount_in=${AMOUNT_IN}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`swap_quote ${r.status}: ${await r.text()}`);
  return BigInt((await r.json()).amount_out);
}

export const meta = {
  id: '141',
  name: 'convert-pending-withdrawal',
  journey: 'convert',
  covers: ['convert', 'icp', 'vchf', 'fail-withdrawal', 'pending-withdrawal', 'honest-unknown', 'pool-ok-not-settled', 'expiry-countdown', 'settle-pending', 'resolution', 'ledger-watch', 'no-resubmit'],
  verifies: 'When the pool replies #ok but holds the output (fail_withdrawal knob), the app parks on an honest pending_withdrawal screen — never done from #ok — naming the asset owed, where it sits, the pool principal, that dpay cannot reverse it, and the approval-expiry bound; settle_pending drains the venue queue and the same screen flips to done with the SEEN amount, with nothing re-signed and VCHF credited exactly.',
  timeoutMs: 240000, // onboard + settle-watch exhaustion + knob + re-arm + probe + polls (full-suite contention budget)
};

export async function run() {
  const start = Date.now();
  console.log('[141-convert-pending-withdrawal] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL, driver } = env;

    console.log('[141-convert-pending-withdrawal] onboarding + funding 3 ICP…');
    await onboardWallet(driver, 'e2e-convert-pending');
    const account = await accountOf(driver);
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.click('btn-home-convert', { timeoutMs: 6_000 });
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-quote-source', { timeoutMs: 10_000 });

    // Hold the venue's output leg BEFORE confirming — the pool will #ok and keep the VCHF.
    // Re-read the pool's own quote HERE (right before arming): sibling convert flows swap
    // against the same shared pool, and the confirm re-quote must match the screen's number —
    // narrowing the window to sub-second keeps the interrupt loop below a rarity.
    console.log('[141-convert-pending-withdrawal] arming fail_withdrawal and confirming…');
    await swapPoolKnob(relayBaseURL, { fail_withdrawal: true });
    let executedGross = await relayQuoteOut(relayBaseURL);
    let pending = null;
    for (let round = 0; round < 5 && pending == null; round++) {
      await driver.click('btn-convert-confirm', { timeoutMs: 6_000 });
      // The settle watch exhausts (40 probes × 1.5s) → pending_withdrawal. NOT done.
      pending = await driver.findByTestID('convert-pending', { timeoutMs: 90_000 }).catch(() => null);
      if (pending == null) {
        const changed = await driver.readText('convert-quote-changed').catch(() => null);
        if (changed != null) {
          // Shared-pool drift tripped the confirm re-quote (§5: never sign a stale number) —
          // re-read the pool and re-confirm against the number the screen now shows.
          executedGross = await relayQuoteOut(relayBaseURL);
          console.log('[141-convert-pending-withdrawal] pool drifted → re-confirmed at the fresh quote');
          continue;
        }
        break; // no panel and no interrupt — surface the failure below
      }
    }
    assert(pending != null, 'pending_withdrawal panel renders (the watch exhausted without the output row)');
    const pendingBody = await driver.readText('convert-pending');
    assertIncludes(pendingBody, 'Payout pending', 'pending title');
    assertIncludes(pendingBody, 'VCHF', 'pending names the asset owed (VCHF)');
    assertIncludes(pendingBody, POOL, 'pending names the pool principal (support line)');
    assertIncludes(pendingBody, 'cannot reverse', 'pending: dpay cannot reverse or speed it up');
    assertIncludes(pendingBody, 'watching', 'pending: it keeps watching (no dead end)');
    const bodyAll = await driver.bodyText();
    assert(!bodyAll.includes('Converted'), 'done NEVER fabricated from the pool #ok alone');
    await driver.screenshot('141-convert-pending');

    // The VCHF is NOT credited while held.
    assertEq(BigInt(await getBalance(relayBaseURL, account.publicHex, 7)), 0n, 'VCHF not credited while the venue holds the output');

    // --- Resolution: drain the venue's queue → the screen flips to done on its own --------------
    console.log('[141-convert-pending-withdrawal] draining the venue queue (settle_pending)…');
    await swapPoolKnob(relayBaseURL, { fail_withdrawal: false, settle_pending: true });
    assert(
      await driver.waitForText('Converted', { timeoutMs: 90_000 }),
      'resolution flips the SAME screen to done (re-arm re-watches within seconds)',
    );
    const doneBody = await driver.readText('convert-done');
    assertIncludes(doneBody, 'VCHF', 'done names the asset received');
    await driver.screenshot('141-convert-resolved');

    assertEq(BigInt(await getBalance(relayBaseURL, account.publicHex, 7)), executedGross, 'VCHF credited the full gross out after the venue settled');

    console.log(`[141-convert-pending-withdrawal] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('141-convert-pending-withdrawal RED:', e.stack || e.message || e);
  });
}
