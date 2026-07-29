// Flow 13 — Offline handling: graceful, logged, no crash/blank, with a retry path.
//
// After onboarding against a reachable relay, this flow points the app at an UNREACHABLE relay (a
// dead port via the settings input) and triggers a faucet top-up. The app's fetch fails fast
// (ECONNREFUSED); the topUp path catches it and surfaces a clear, honest "Offline — try again when
// connected" (App.tsx topUp catch) — NOT a crash, NOT a blank screen, NOT a false success. The
// wallet stays rendered (balance still visible), and the retry path is the automatic poll + the
// user can fix the URL. Every network op has a timeout (AbortController); failures are logged by the
// driver (requestfailed) with context.
//
// Selector contract: `settings-relay`, `btn-topup`, `balance`.
import { setup, assert, assertIncludes } from '../harness/lib.mjs';

const ONBOARD_PLACEHOLDER = 'e.g. Alice';
const DEAD_RELAY = 'http://127.0.0.1:1'; // port 1: privileged, nothing listening → ECONNREFUSED

export async function run() {
  const start = Date.now();
  console.log('[13-offline] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Onboard against the GOOD relay (funds $100, proves the wallet works when online).
    console.log('[13-offline] onboarding (online)…');
    await driver.typeByPlaceholder(ONBOARD_PLACEHOLDER, 'e2e-offline', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    await driver.waitForText('$100.00', { timeoutMs: 12_000 });

    // Retarget the app at a DEAD relay via the settings input. The balance poll now fails → the
    // header flips to the offline indicator ("~ approx."), but the wallet stays rendered.
    console.log(`[13-offline] pointing the app at a dead relay (${DEAD_RELAY})…`);
    await driver.type('settings-relay', DEAD_RELAY, { timeoutMs: 4_000 });
    // Give the next balance poll a beat to fail and flip the online indicator.
    const approx = await driver.waitForText('approx.', { timeoutMs: 8_000 });
    assert(approx, 'the header should show the offline indicator ("~ approx.") once the relay is unreachable');
    console.log('[13-offline] ✓ header shows the offline indicator (graceful, no crash)');

    // Trigger a faucet top-up against the dead relay → the app catches the failure and surfaces a
    // clear, honest offline message (NOT a false success, NOT a crash).
    console.log('[13-offline] clicking btn-topup against the dead relay…');
    await driver.click('btn-topup', { timeoutMs: 4_000 });
    const offlineMsg = await driver.waitForText('Offline — try again when connected', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(offlineMsg, `the app should surface a clear offline message. body excerpt:\n${body.slice(0, 500)}`);
    console.log('[13-offline] ✓ app shows "Offline — try again when connected" (honest, with a retry path)');

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
