// Flow 13 — Offline handling: graceful, logged, no crash/blank, with a retry path.
//
// After onboarding against a reachable relay, this flow opens the Settings sheet, points the app at
// an UNREACHABLE relay (a genuinely-closed port), and triggers a faucet top-up. The app's fetch
// fails fast with ECONNREFUSED (the REAL "relay unreachable" failure mode); the topUp path catches
// it and surfaces a clear, honest "Offline — try again when connected" — NOT a crash, NOT a blank
// screen, NOT a false success. After closing Settings, the wallet stays rendered (balance still
// visible) and the header shows the offline indicator ("~ approx."). Every network op has a timeout
// (AbortController); failures are logged by the driver (requestfailed) with context.
//
// DEAD RELAY CHOICE (NIT 1a-i): the harness grabs a free TCP port (binds to :0 then immediately
// closes the socket) so NOTHING listens on it → a connect yields ECONNREFUSED. This is the real
// failure mode the app must handle. (An earlier version pointed at port 1, but Chrome blocks port
// 1 with ERR_UNSAFE_PORT BEFORE attempting the connection — a different, artifact failure mode that
// let this test pass for the WRONG reason. We assert the failure is a connection error, not an
// unsafe-port block, to lock in the right reason.)
//
// Selector contract: `btn-settings`, `settings-relay`, `btn-settings-close`, `balance` (header →
// Balances), `btn-topup` (inside Balances), `btn-balances-close`.
import { setup, assert, onboardWallet, pickFreePort, openBalances } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[13-offline] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // A genuinely-dead relay: a port nothing listens on (bind :0 → close → freed). A connect to it
    // is refused (ECONNREFUSED), not unsafe-port-blocked.
    const deadPort = await pickFreePort();
    const DEAD_RELAY = `http://127.0.0.1:${deadPort}`;
    driver.allowRequestFailuresFrom(DEAD_RELAY);

    // Onboard against the GOOD relay (funds $100, proves the wallet works when online).
    console.log('[13-offline] onboarding (online)…');
    await onboardWallet(driver, 'e2e-offline');

    // Open Settings, retarget the app at a DEAD relay via the settings input, then close Settings.
    console.log('[13-offline] opening Settings to change the relay URL…');
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    console.log(`[13-offline] pointing the app at a dead relay (${DEAD_RELAY})…`);
    await driver.type('settings-relay', DEAD_RELAY, { timeoutMs: 4_000 });
    await driver.click('btn-relay-apply', { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // Record the underlying request failures so we can prove the dead relay fails for the RIGHT
    // reason (ECONNREFUSED — a real connection refusal), not the ERR_UNSAFE_PORT artifact.
    const failures = driver.recordRequestFailures();

    // Trigger a faucet top-up against the dead relay from the Balances sheet → the app catches the
    // failure and surfaces a clear, honest offline message (NOT a false success, NOT a crash).
    console.log('[13-offline] opening Balances to trigger the faucet against the dead relay…');
    await openBalances(driver);
    console.log('[13-offline] clicking btn-topup against the dead relay…');
    await driver.click('btn-topup', { timeoutMs: 4_000 });
    const offlineMsg = await driver.waitForText('Offline', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(offlineMsg, `the app should surface a clear offline message. body excerpt:\n${body.slice(0, 500)}`);
    console.log('[13-offline] ✓ app shows an honest offline message (with a retry path)');

    // The RIGHT-REASON gate: the faucet request to the dead relay must have failed with a
    // CONNECTION error (refused), NOT an unsafe-port block. This locks the test to the real failure
    // mode instead of a Chrome port-policy artifact.
    const failed = failures().filter((f) => f.url.includes('/api/v1/faucet'));
    assert(failed.length > 0, `the faucet request to the dead relay must have failed (got ${failures().length} failed reqs)`);
    const errText = failed[0].errorText;
    assert(/CONNECTION|NETWORK|REFUSED|FAILED/i.test(errText),
      `dead relay should fail with a connection error, got "${errText}"`);
    assert(!/UNSAFE_PORT/i.test(errText),
      `dead relay must NOT be an unsafe-port artifact (that's the wrong failure mode), got "${errText}"`);
    console.log(`[13-offline] ✓ dead relay failed for the right reason: ${errText}`);

    // Close Balances — the balance poll has been failing underneath; the header should now show the
    // offline indicator ("~ approx.").
    console.log('[13-offline] closing Balances to verify the wallet surface…');
    await driver.click('btn-balances-close', { timeoutMs: 4_000 });
    const approx = await driver.waitForText('approx.', { timeoutMs: 8_000 });
    assert(approx, 'the header should show the offline indicator ("~ approx.") once the relay is unreachable');
    console.log('[13-offline] ✓ header shows the offline indicator (graceful, no crash)');

    // The wallet is still rendered (no blank/crash): the balance element is still present.
    await driver.findByTestID('balance', { timeoutMs: 4_000 });
    console.log('[13-offline] ✓ wallet still rendered (no crash/blank)');

    await driver.screenshot('13-offline');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[13-offline] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[13-offline] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
