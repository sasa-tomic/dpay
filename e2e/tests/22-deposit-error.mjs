// Flow 22 — Deposit unreachable/error state (relay down → honest error, no spinner-forever/crash).
//
// When the relay is unreachable, the DepositSheet's address/info fetch fails fast (ECONNREFUSED —
// the REAL "relay down" failure mode, not a synthetic stub). The sheet must surface a clear, honest
// error + a retry hint — NOT spin forever, NOT crash, NOT show a fake address. This flow pins that:
//   1. Onboard online (good relay), then switch to a genuinely-dead relay (closed port).
//   2. Open the deposit sheet (via the asset picker → ckBTC). The sheet mounts and immediately
//      tries to fetch depositAddress + depositInfo from the dead relay.
//   3. Both fetches fail fast → `loading` flips false, `err` is set to the plain-language transient
//      message "Couldn't load your deposit address. Check your connection and try again." (H5: no
//      "relay" / "reopen the sheet" dev jargon — just a clear retry hint in user language).
//   4. Assert the error text shows AND the spinner is gone (loading=false) — the sheet reached a
//      terminal error state, not a stuck loading state. The wallet surface is still intact (balance
//      still rendered; no crash).
//
// This is the H5 path: the deposit error must be plain-language + distinguish the transient
// (reachability) case from the distinct "no minter" 503 case (which surfaces "This asset isn't
// available for deposits yet." — covered by the unit path). Here we drive the transient
// (ECONNREFUSED) variant through the REAL app + a REAL closed port.
//
// Selector contract: `btn-settings`, `settings-relay`, `btn-settings-close`, `balance` (header →
// Balances), `asset-ckbtc-select` (BTC row whole-row select), `btn-receive-address` (Receive → "My
// address"), `deposit-status` (absent — no address fetched).
import { setup, assert, assertIncludes, onboardWallet, pickFreePort, openBalances, selectCurrency, openReceiveAddress } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '22',
  name: 'deposit-error',
  journey: 'deposit',
  covers: ['deposit-error', 'offline', 'graceful'],
  verifies: 'Relay unreachable when opening the deposit sheet → honest error (\'Check connection\'), no spinner-forever.',
  timeoutMs: 15000,
};

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
    driver.allowRequestFailuresFrom(DEAD_RELAY);
    console.log(`[22-deposit-error] going offline (${DEAD_RELAY})…`);
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.type('settings-relay', DEAD_RELAY, { timeoutMs: 4_000 });
    await driver.click('btn-relay-apply', { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // Open Balances → select ckBTC → Receive → "My address" (the inline deposit body). The
    // DepositSheet mounts against the dead relay. `asset-ckbtc-select` is always present (selectable
    // at any balance); the dead-relay failure surfaces in the inline deposit body.
    console.log('[22-deposit-error] Balances → select ckBTC → Receive → My address (dead relay)…');
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');
    await openReceiveAddress(driver);

    // The sheet's fetch fails fast → the error state renders. H5: plain-language transient copy
    // (dead relay = ECONNREFUSED → transient). The fetch has an 8s AbortController ceiling, but
    // ECONNREFUSED returns immediately.
    const errShown = await driver.waitForText("Couldn't load your deposit address", { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(errShown, `the deposit sheet should show the plain-language transient error. body excerpt:\n${body.slice(0, 600)}`);
    // H5: the error must NOT leak the dev-jargon word "relay" (nor "reopen the sheet").
    assert(!/relay/i.test(body), 'the deposit error text must not leak the dev-jargon word "relay" (H5)');
    assertIncludes(body, 'Check your connection and try again', 'transient error carries a plain retry hint (H5)');
    console.log('[22-deposit-error] ✓ deposit error uses plain language (no "relay" jargon) + retry hint');

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
