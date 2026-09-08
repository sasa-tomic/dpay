// Flow 13 — Offline handling: graceful, logged, no crash/blank, honest failure mode.
//
// After onboarding against a reachable relay, this flow retargets the app at an UNREACHABLE
// relay (a genuinely-closed port). The balance poll then fails fast with ECONNREFUSED (the REAL
// "relay unreachable" failure mode) and the app degrades honestly: the header shows the offline
// indicator ("~ approx."), the wallet stays rendered, nothing crashes or blanks.
//
// Since the capability work (2026-09-07) the DEMO top-up is HIDDEN while the relay is
// unreachable — `relayCapabilities` fails closed, so the wallet stops advertising a faucet it
// cannot reach instead of offering a button that can only fail. This flow pins that too.
//
// DEAD RELAY CHOICE (NIT 1a-i): the harness grabs a free TCP port (binds to :0 then immediately
// closes the socket) so NOTHING listens on it → a connect yields ECONNREFUSED. This is the real
// failure mode the app must handle. (An earlier version pointed at port 1, but Chrome blocks port
// 1 with ERR_UNSAFE_PORT BEFORE attempting the connection — a different, artifact failure mode that
// let this test pass for the WRONG reason. We assert the failure is a connection error, not an
// unsafe-port block, to lock in the right reason.)
//
// Selector contract: `btn-settings`, `settings-relay`, `btn-settings-close`, `balance` (header
// chip → the accounts route), `btn-topup` (inside the accounts list — ABSENT offline).
import { setup, assert, onboardWallet, openBalances, goOffline } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '13',
  name: 'offline',
  journey: 'system',
  covers: ['offline', 'econnrefused', 'graceful', 'capability-fail-closed', 'right-reason'],
  verifies: 'Relay down → the app degrades honestly (header "~ approx.", wallet rendered, no crash), balance requests fail for the right reason (ECONNREFUSED, not unsafe-port), and the DEMO top-up is hidden rather than advertised (capability fail-closed).',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[13-offline] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Onboard against the GOOD relay (funds $100, proves the wallet works when online).
    console.log('[13-offline] onboarding (online)…');
    await onboardWallet(driver, 'e2e-offline');

    // Retarget the app at a GENUINELY-DEAD relay (a port nothing listens on → ECONNREFUSED, the real
    // "relay unreachable" failure mode, not an unsafe-port artifact). `goOffline` picks the port,
    // registers the dead origin with the driver (so ECONNREFUSED doesn't fail-close the flow), and
    // retargets via Settings. The balance poll underneath now fires against this dead relay.
    console.log('[13-offline] going offline (dead relay)…');
    await goOffline(driver);

    // Record the underlying request failures so we can prove the dead relay fails for the RIGHT
    // reason (ECONNREFUSED — a real connection refusal), not the ERR_UNSAFE_PORT artifact.
    const failures = driver.recordRequestFailures();

    // The capability-fail-closed pin: with the relay unreachable, the Home accounts list must NOT
    // advertise the DEMO faucet — a hidden action instead of a guaranteed failure.
    console.log('[13-offline] opening Home (accounts) — the DEMO top-up must be hidden…');
    await openBalances(driver);
    assert(!(await driver.isPresent('btn-topup')),
      'the DEMO top-up must be hidden while the relay is unreachable (capability fail-closed)');
    console.log('[13-offline] ✓ DEMO top-up hidden, not advertised (fail-closed)');

    // The RIGHT-REASON gate: the balance poll to the dead relay must have failed with a
    // CONNECTION error (refused), NOT an unsafe-port block. This locks the test to the real failure
    // mode instead of a Chrome port-policy artifact.
    let failed = [];
    for (let i = 0; i < 20 && failed.length === 0; i++) {
      failed = failures().filter((f) => f.url.includes('/api/v1/balances'));
      if (failed.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    assert(failed.length > 0, `the balance poll to the dead relay must have failed (got ${failures().length} failed reqs)`);
    const errText = failed[0].errorText;
    assert(/CONNECTION|NETWORK|REFUSED|FAILED/i.test(errText),
      `dead relay should fail with a connection error, got "${errText}"`);
    assert(!/UNSAFE_PORT/i.test(errText),
      `dead relay must NOT be an unsafe-port artifact (that's the wrong failure mode), got "${errText}"`);
    console.log(`[13-offline] ✓ dead relay failed for the right reason: ${errText}`);

    // The header should now show the offline indicator ("~ DEMO approx." — the asset name is
    // prefixed after D3; substring 'approx.' is what the assertion matches).
    console.log('[13-offline] verifying the offline indicator…');
    const approx = await driver.waitForText('approx.', { timeoutMs: 8_000 });
    assert(approx, 'the header should show the offline indicator ("~ DEMO approx.") once the relay is unreachable');
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
