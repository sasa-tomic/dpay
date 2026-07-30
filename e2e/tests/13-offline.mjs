// Flow 13 — Offline handling: graceful, logged, no crash/blank, with a retry path.
//
// After onboarding against a reachable relay, this flow opens the Settings sheet, points the app at
// an UNREACHABLE relay (a dead port via the settings input), and triggers a faucet top-up. The app's
// fetch fails fast (ECONNREFUSED); the topUp path catches it and surfaces a clear, honest "Offline —
// try again when connected" — NOT a crash, NOT a blank screen, NOT a false success. After closing
// Settings, the wallet stays rendered (balance still visible) and the header shows the offline
// indicator ("~ approx."). Every network op has a timeout (AbortController); failures are logged by
// the driver (requestfailed) with context.
//
// Selector contract: `btn-settings`, `settings-relay`, `btn-topup`, `btn-settings-close`, `balance`.
import { setup, assert, onboardWallet } from '../harness/lib.mjs';

const DEAD_RELAY = 'http://127.0.0.1:1'; // port 1: privileged, nothing listening → ECONNREFUSED

export async function run() {
  const start = Date.now();
  console.log('[13-offline] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Onboard against the GOOD relay (funds $100, proves the wallet works when online).
    console.log('[13-offline] onboarding (online)…');
    await onboardWallet(driver, 'e2e-offline');

    // Open Settings, retarget the app at a DEAD relay via the settings input.
    console.log('[13-offline] opening Settings to change the relay URL…');
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    console.log(`[13-offline] pointing the app at a dead relay (${DEAD_RELAY})…`);
    await driver.type('settings-relay', DEAD_RELAY, { timeoutMs: 4_000 });

    // Trigger a faucet top-up against the dead relay → the app catches the failure and surfaces a
    // clear, honest offline message (NOT a false success, NOT a crash).
    console.log('[13-offline] clicking btn-topup against the dead relay…');
    await driver.click('btn-topup', { timeoutMs: 4_000 });
    const offlineMsg = await driver.waitForText('Offline', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(offlineMsg, `the app should surface a clear offline message. body excerpt:\n${body.slice(0, 500)}`);
    console.log('[13-offline] ✓ app shows an honest offline message (with a retry path)');

    // Close Settings — the balance poll has been failing underneath; the header should now show the
    // offline indicator ("~ approx.").
    console.log('[13-offline] closing Settings to verify the wallet surface…');
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });
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
