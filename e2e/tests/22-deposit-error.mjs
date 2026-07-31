// Flow 22 — Deposit unreachable/error state (relay down → honest error, no spinner-forever/crash).
//
// When the relay is unreachable, the DepositSheet's address/info fetch fails fast (ECONNREFUSED —
// the REAL "relay down" failure mode, not a synthetic stub). The sheet must surface a clear, honest
// error + a retry hint — NOT spin forever, NOT crash, NOT show a fake address. This flow pins that:
//   1. Onboard online (good relay), then switch to a genuinely-dead relay (closed port).
//   2. Open the deposit sheet (via the asset picker → ckBTC). The sheet mounts and immediately
//      tries to fetch depositAddress + depositInfo from the dead relay.
//   3. Both fetches fail fast → `loading` flips false, `err` is set to
//      "Could not reach the ledger for a deposit address" + the retry hint
//      "Check the relay is reachable, then reopen the sheet."
//   4. Assert the error text shows AND the spinner is gone (loading=false) — the sheet reached a
//      terminal error state, not a stuck loading state. The wallet surface is still intact (balance
//      still rendered; no crash).
//
// This is the N7-adjacent path: the deposit error must be truthful about reachability (vs the
// distinct "no minter" 503 case, which the app now also distinguishes — covered by the unit path).
// Here we drive the unreachable (ECONNREFUSED) variant through the REAL app + a REAL closed port.
//
// Selector contract: `btn-settings`, `settings-relay`, `btn-settings-close`, `btn-deposit`,
// `asset-picker-row-ckbtc`, `deposit-status` (absent — no address fetched), `balance`.
import { setup, assert, onboardWallet, pickFreePort } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[22-deposit-error] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Onboard online ($100 funded — proves the wallet works before we break the relay).
    console.log('[22-deposit-error] onboarding…');
    await onboardWallet(driver, 'e2e-deposit-err');

    // Switch to a genuinely-dead relay (closed port → ECONNREFUSED, the real failure mode).
    const deadPort = await pickFreePort();
    const DEAD_RELAY = `http://127.0.0.1:${deadPort}`;
    console.log(`[22-deposit-error] going offline (${DEAD_RELAY})…`);
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.type('settings-relay', DEAD_RELAY, { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // Open the deposit sheet via the asset picker (the catalog carries >1 onramp asset, so btn-deposit
    // opens the picker). Pick ckBTC → the DepositSheet mounts against the dead relay.
    console.log('[22-deposit-error] opening the deposit sheet against the dead relay…');
    await driver.click('btn-deposit', { timeoutMs: 5_000 });
    await driver.click('asset-picker-row-ckbtc', { timeoutMs: 5_000 });

    // The sheet's fetch fails fast → the error state renders. Assert the honest reachability copy.
    // The fetch has an 8s AbortController ceiling, but ECONNREFUSED returns immediately.
    const errShown = await driver.waitForText('Could not reach the ledger for a deposit address', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(errShown, `the deposit sheet should show the reachability error. body excerpt:\n${body.slice(0, 600)}`);
    assert(/check the relay is reachable, then reopen/i.test(body),
      'the error should carry the retry hint ("Check the relay is reachable, then reopen the sheet.")');
    console.log('[22-deposit-error] ✓ deposit error shows the honest reachability message + retry hint');

    // The spinner must be GONE (loading=false): the sheet reached a terminal error, not stuck loading.
    assert(!(await driver.isPresent('deposit-status')),
      'deposit-status (the address/pending UI) must NOT render — no address was fetched');
    const spinnerGone = await driver.eval(() =>
      !document.querySelector('[data-testid="deposit-address"], .deposit-loading-spinner, [role="progressbar"]')
    );
    assert(spinnerGone, 'no deposit address / spinner should be present (terminal error, not loading)');
    console.log('[22-deposit-error] ✓ no spinner/address (terminal error state, not stuck loading)');

    // The wallet surface is still intact (no crash/blank): balance still rendered.
    await driver.findByTestID('balance', { timeoutMs: 4_000 });
    console.log('[22-deposit-error] ✓ wallet surface intact (no crash)');

    await driver.screenshot('22-deposit-error');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[22-deposit-error] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[22-deposit-error] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
