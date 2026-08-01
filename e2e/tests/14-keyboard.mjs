// Flow 14 — Keyboard surface: full single-key shortcuts (UX-V5) + Escape closes the open sheet.
//
// The wallet is fully keyboard-driveable on web (desktop power-user feature; on mobile the NFC/tap
// is the input, so the shortcuts + hints are web-only). The first letters map to the main actions:
//   P → Pay tab · R → Receive tab · T → Top-up (demo money) · A → Balances (the money hub)
// Esc closes whatever sheet/overlay is open (the seed affordance, built in Wave U / useEscapeToClose,
// now shared with the wallet shortcuts via one `useHotkeys` source of truth).
//
// Guards: shortcuts fire ONLY on the wallet main view, with no text input focused and no sheet open.
// Typing into the amount field must NOT trip a shortcut (activeElement INPUT/TEXTAREA guard).
//
// Selector contract: `pay-scan` (Pay scan screen), `btn-request` (Receive affordance), `balance`,
// `btn-balances-close` (Balances open), `asset-add-ckbtc` (BTC row Add → deposit sheet),
// `deposit-address` (deposit sheet), `amount-input`.
import { setup, assert, assertIncludes, onboardWallet, openBalances } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[14-keyboard] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[14-keyboard] onboarding…');
    await onboardWallet(driver, 'e2e-keyboard');
    // Onboard lands on the wallet in Pay mode (the default). Demo balance is Đ100.00.

    // --- P / R : single-key tab switching -------------------------------------------
    console.log('[14-keyboard] pressing R (→ Receive)…');
    await driver.pressKey('r');
    await driver.findByTestID('btn-request', { timeoutMs: 3_000 });
    assert(!(await driver.isPresent('pay-scan')), 'R should hide the Pay scan screen');
    console.log('[14-keyboard] ✓ R activated the Receive tab');

    console.log('[14-keyboard] pressing P (→ Pay)…');
    await driver.pressKey('p');
    await driver.findByTestID('pay-scan', { timeoutMs: 3_000 });
    assert(!(await driver.isPresent('btn-request')), 'P should hide the Receive affordance (btn-request)');
    console.log('[14-keyboard] ✓ P activated the Pay tab');

    // --- T : single-key top-up (demo money) -----------------------------------------
    console.log('[14-keyboard] pressing T (→ top-up +Đ100 demo money)…');
    await driver.pressKey('t');
    const topped = await driver.waitForText('Đ200.00', { timeoutMs: 6_000 });
    assert(topped, 'T should add demo money (balance Đ100.00 → Đ200.00)');
    console.log('[14-keyboard] ✓ T triggered the top-up');

    // --- A : single-key Balances (the money hub) + Esc closes it -------------------
    console.log('[14-keyboard] pressing A (→ open Balances)…');
    await driver.pressKey('a');
    await driver.findByTestID('btn-balances-close', { timeoutMs: 3_000 });
    console.log('[14-keyboard] ✓ A opened Balances');

    console.log('[14-keyboard] pressing Escape (close Balances)…');
    await driver.pressKey('Escape');
    await driver.waitGone('btn-balances-close', { timeoutMs: 3_000 });
    console.log('[14-keyboard] ✓ Escape closed Balances');

    // --- Input guard: shortcuts must NOT fire while typing in a field ----------------
    console.log('[14-keyboard] input-guard: typing in amount-input must not trip shortcuts…');
    await driver.pressKey('r');                 // → Receive (amount-input is the focused-typeable field)
    await driver.findByTestID('amount-input', { timeoutMs: 3_000 });
    await driver.click('amount-input');          // focus the field (activeElement = INPUT)
    await driver.pressKey('p');                   // must NOT switch tabs while an input is focused
    assert(!(await driver.isPresent('pay-scan')), 'P must not activate while typing in an input');
    console.log('[14-keyboard] ✓ P correctly ignored while an input was focused');
    // Once the field loses focus, the shortcut works again.
    await driver.eval(() => { (document.activeElement)?.blur?.(); });
    await driver.pressKey('p');
    await driver.findByTestID('pay-scan', { timeoutMs: 3_000 });
    console.log('[14-keyboard] ✓ P activated again after the input lost focus');

    // --- Esc closes a sheet (the seed affordance) + the in-UI hint renders -----------
    console.log('[14-keyboard] opening the deposit sheet (from Balances → BTC row)…');
    await openBalances(driver);
    await driver.click('asset-add-ckbtc', { timeoutMs: 5_000 });
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });

    // The keyboard surface is documented in-UI: the "Press Esc to close" hint renders on web.
    const body = await driver.bodyText();
    assertIncludes(body, 'Press Esc to close', 'the deposit sheet should document the Esc shortcut in-UI');
    console.log('[14-keyboard] ✓ "Press Esc to close" hint is visible');

    console.log('[14-keyboard] pressing Escape (close the deposit sheet)…');
    await driver.pressKey('Escape');
    await driver.waitGone('deposit-address', { timeoutMs: 3_000 });
    console.log('[14-keyboard] ✓ Escape closed the deposit sheet');

    await driver.screenshot('14-keyboard');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[14-keyboard] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[14-keyboard] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
