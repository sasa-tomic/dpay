// Flow 22 — Deposit unreachable/error state (gateway down → honest error, no spinner-forever/crash).
//
// When the IC gateway is unreachable, the DepositSheet's address query fails fast (ECONNREFUSED —
// the REAL "network down" failure mode, not a synthetic stub). The sheet must surface a clear,
// honest error + a retry hint — NOT spin forever, NOT crash, NOT show a fake address. This flow
// pins that:
//   1. Onboard online (good relay), then kill BOTH transports the sheet depends on:
//      the IC /api/v2 gateway (the address critical path since the W8 user-principal cutover —
//      `railBtcDepositAddress` is a signed get_btc_address UPDATE (call + request_status poll)
//      straight to the gateway, NOT a relay fetch) AND the relay (the supplementary depositInfo
//      fetch + the offline wallet surface).
//   2. Open the deposit sheet (via the asset picker → ckBTC). The sheet mounts and immediately
//      signs + POSTs the get_btc_address update at the dead gateway.
//   3. The POST fails fast → `loading` flips false, `err` is set to the plain-language transient
//      message "Couldn't load your deposit address. Check your connection and try again." (H5: no
//      "relay" / "reopen the sheet" dev jargon — just a clear retry hint in user language).
//   4. Assert the error text shows AND the spinner is gone (loading=false) — the sheet reached a
//      terminal error state, not a stuck loading state. The wallet surface is still intact (balance
//      still rendered; no crash).
//
// NOTE (premise fix, 2026-08-20): this flow originally killed ONLY the relay — valid before the
// cutover, when the sheet fetched the address from the relay. Since W8 the address is a signed
// query against the IC gateway (e2e routes it at the test relay via the `__DPAY_TEST_IC_GATEWAY`
// seam, set once from `?relay=` at page load), so a dead relay alone left the address path alive
// and the flow deterministically RED (a real address rendered). The gateway seam is re-read on
// every call by `icGatewayBase()`, so retargeting it mid-session to a genuinely-dead port
// reproduces the real ECONNREFUSED failure mode through the REAL transport.
//
// This is the H5 path: the deposit error must be plain-language + distinguish the transient
// (reachability) case from the distinct "no minter" 503 case (which surfaces "This asset isn't
// available for deposits yet." — covered by the unit path). Here we drive the transient
// (ECONNREFUSED) variant through the REAL app + a REAL closed port.
//
// Selector contract: `btn-settings`, `settings-relay`, `btn-settings-close`, `balance` (header →
// Balances), `asset-ckbtc-select` (BTC row whole-row select), `btn-receive-address` (Receive → "My
// address"), `deposit-status` (absent — no address fetched).
import { setup, assert, assertIncludes, onboardWallet, goOffline, openBalances, selectCurrency, openReceiveAddress, pickFreePort, waitForWallet} from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '22',
  name: 'deposit-error',
  journey: 'deposit',
  covers: ['deposit-error', 'offline', 'graceful'],
  verifies: 'IC gateway unreachable when opening the deposit sheet → honest error (\'Check connection\'), no spinner-forever.',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[22-deposit-error] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Onboard online ($100 funded — proves the wallet works before we break the network).
    console.log('[22-deposit-error] onboarding…');
    await onboardWallet(driver, 'e2e-deposit-err');

    // Kill the IC gateway transport (the deposit ADDRESS critical path since W8): retarget the
    // e2e seam at a genuinely-dead port → the signed get_btc_address POST gets ECONNREFUSED, the
    // real "gateway unreachable" failure mode. The certified clock for the update expiry comes
    // from the same dead gateway (icStampExpiry throws) and pollExpiry falls back to the device
    // clock — either way the path dies fast at the closed port.
    const deadGwPort = await pickFreePort();
    const deadGateway = `http://127.0.0.1:${deadGwPort}`;
    driver.allowRequestFailuresFrom(deadGateway);
    await driver.eval((gw) => {
      globalThis.__DPAY_TEST_IC_GATEWAY = gw;
    }, deadGateway);

    // Also kill the relay (the supplementary depositInfo fetch degrades to "none"/"no minimum",
    // and the wallet surface must stay intact offline — as before the cutover).
    console.log('[22-deposit-error] going offline (IC gateway + relay)…');
    await goOffline(driver);

    // Open Balances → select ckBTC → Receive → "My address" (the inline deposit body). The
    // DepositSheet mounts against the dead gateway. `asset-ckbtc-select` is always present
    // (selectable at any balance); the dead-gateway failure surfaces in the inline deposit body.
    console.log('[22-deposit-error] Balances → select ckBTC → Receive → My address (dead gateway)…');
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');
    await openReceiveAddress(driver);

    // The sheet's query fails fast → the error state renders. H5: plain-language transient copy
    // (dead gateway = ECONNREFUSED → transient). The fetch has an 8s AbortController ceiling, but
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
    await waitForWallet(driver, { timeoutMs: 4_000 });
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
