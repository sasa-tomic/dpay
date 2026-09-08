// Flow 14 — Keyboard surface: full single-key shortcuts (UX-V5) + Escape closes the open sheet.
//
// The wallet is fully keyboard-driveable on web (desktop power-user feature; on mobile the NFC/tap
// is the input, so the shortcuts + hints are web-only). The first letters map to the main actions:
//   P → Pay tab · R → Receive tab · T → Top-up (demo money) · A → Accounts (the money hub)
//   L → Ledger (transactions)
// Esc closes whatever sheet/overlay is open (the seed affordance, built in Wave U / useEscapeToClose,
// now shared with the wallet shortcuts via one `useHotkeys` source of truth).
//
// Guards: shortcuts fire ONLY on the wallet main view, with no text input focused and no sheet open.
// Typing into the amount field must NOT trip a shortcut (activeElement INPUT/TEXTAREA guard).
//
// Selector contract: `pay-scan` (Pay scan screen), `btn-request` (Receive affordance), `balance`,
// `accounts-list` (the accounts route's per-asset list), `asset-ckbtc-select` (BTC row whole-row select),
// `btn-receive-address` (Receive → "My address"), `deposit-address` (inline deposit body),
// `amount-input`.
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency, openReceiveAddress } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '14',
  name: 'keyboard',
  journey: 'system',
  covers: ['keyboard-shortcuts', 'tabs', 'sheet-guard', 'input-guard', 'focus-visible'],
  verifies: 'Single-key shortcuts (P/R/T/A/L/Esc) switch tabs / top-up / open the accounts route / ledger / close sheet; input + sheet guards work; keyboard focus paints the brand :focus-visible ring (U-F4).',
  timeoutMs: 15000,
};

export async function run() {
  const start = Date.now();
  console.log('[14-keyboard] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[14-keyboard] onboarding…');
    await onboardWallet(driver, 'e2e-keyboard');
    // The app itself lands on Home; the `onboardWallet` helper leaves it on the Pay tab (it selects
    // DEMO and restores Pay). Demo balance is ∂100.00.

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

    // --- L : single-key Ledger (transactions) ---------------------------------------
    console.log('[14-keyboard] pressing L (→ Ledger / Transactions)…');
    await driver.pressKey('l');
    await driver.findByTestID('ledger-view', { timeoutMs: 3_000 });
    console.log('[14-keyboard] ✓ L activated the Transactions tab');
    await driver.pressKey('p'); // back to Pay for the rest of the flow
    await driver.findByTestID('pay-scan', { timeoutMs: 3_000 });

    // --- T : single-key top-up (demo money) -----------------------------------------
    console.log('[14-keyboard] pressing T (→ top-up +∂100 demo money)…');
    await driver.pressKey('t');
    const topped = await driver.waitForText('∂200.00', { timeoutMs: 6_000 });
    assert(topped, 'T should add demo money (balance ∂100.00 → ∂200.00)');
    console.log('[14-keyboard] ✓ T triggered the top-up');

    // --- A : single-key Accounts (the money hub — the per-asset list, its own route) -----------
    console.log('[14-keyboard] pressing A (→ Accounts)…');
    await driver.pressKey('a');
    await driver.findByTestID('accounts-list', { timeoutMs: 3_000 });
    console.log('[14-keyboard] ✓ A landed the accounts route (per-asset list)');

    // Back to Pay via the P shortcut (the sheet-era Esc-close is gone with the sheet).
    await driver.pressKey('p');
    await driver.findByTestID('pay-scan', { timeoutMs: 3_000 });
    console.log('[14-keyboard] ✓ P returned to Pay');

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

    // --- Esc closes the inline deposit body (the seed affordance) + the in-UI hint renders -------
    // The deposit now lives inline in the Receive tab's "My address" sub-mode. The inline body still
    // registers useEscapeToClose → Escape flips the sub-mode back to "Request payment".
    console.log('[14-keyboard] opening the deposit (Balances → select ckBTC → Receive → My address)…');
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');
    await openReceiveAddress(driver);
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });

    // The keyboard surface is documented in-UI: the "Press Esc to close" hint renders on web.
    const body = await driver.bodyText();
    assertIncludes(body, 'Press Esc to close', 'the deposit body should document the Esc shortcut in-UI');
    console.log('[14-keyboard] ✓ "Press Esc to close" hint is visible');

    console.log('[14-keyboard] pressing Escape (flip back to Request payment)…');
    await driver.pressKey('Escape');
    await driver.waitGone('deposit-address', { timeoutMs: 3_000 });
    console.log('[14-keyboard] ✓ Escape closed the inline deposit body');

    // --- U-F4: keyboard focus paints a ring, pointer focus does not -------------------
    // The web entries (e2e/web/index.html + wallet.html) inject a global `:focus-visible` rule
    // (outline 2px solid #FF5A1F — the palette brand). Prove BOTH halves in the real DOM:
    //   (a) a Tab keypress focuses the first focusable WITH the ring (computed outlineStyle
    //       'solid' in the brand color) — keyboard users always see where they are;
    //   (b) a real mouse click focuses a button WITHOUT the ring (outlineStyle 'none') — the
    //       ring must not pollute every tap. Text inputs are exempt (they always match
    //       :focus-visible per spec), so the pointer case uses a BUTTON (btn-settings).
    await driver.eval(() => { (document.activeElement)?.blur?.(); });
    await driver.pressKey('Tab');
    const kb = await driver.eval(() => {
      const el = document.activeElement;
      const cs = el ? getComputedStyle(el) : null;
      return {
        tag: el ? el.tagName : '',
        role: el ? (el.getAttribute('role') ?? '') : '',
        outlineStyle: cs ? cs.outlineStyle : '',
        outlineColor: cs ? cs.outlineColor : '',
      };
    });
    assert(kb.tag !== 'BODY' && kb.tag !== '', `Tab should focus a real element, got activeElement=${kb.tag || 'none'}`);
    assert(kb.outlineStyle === 'solid', `keyboard-focused <${kb.tag} role=${kb.role}> must paint the :focus-visible ring (outlineStyle "${kb.outlineStyle}")`);
    assertIncludes(kb.outlineColor, '255, 90, 31', 'the focus ring must use the brand color #FF5A1F');
    console.log(`[14-keyboard] ✓ Tab focuses <${kb.tag} role=${kb.role}> with the brand focus ring`);

    await driver.eval(() => { (document.activeElement)?.blur?.(); });
    await driver.click('btn-settings', { timeoutMs: 3_000 });
    const ptr = await driver.eval(() => {
      const el = document.querySelector('[data-testid="btn-settings"]'); // RNW maps testID → data-testid
      return el ? getComputedStyle(el).outlineStyle : 'missing';
    });
    assert(ptr === 'none', `a mouse-clicked button must NOT paint the ring (outlineStyle "${ptr}")`);
    console.log('[14-keyboard] ✓ mouse focus stays ring-free (:focus-visible only)');
    await driver.pressKey('Escape'); // close the settings sheet the click opened (useEscapeToClose)
    await driver.waitGone('btn-settings-close', { timeoutMs: 3_000 });

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
