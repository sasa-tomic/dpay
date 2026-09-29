/**
 * Flows 133 + 135 + 136 + 150 — the Home surface and the accounts route — the jest twins of
 * `e2e/tests/133-home-surface.mjs`, `135-home-activity.mjs`, `136-accounts-page.mjs`,
 * `150-accounts-route.mjs`.
 *
 * 133: a cold start lands on Home (zero taps); the headline is the HOME CURRENCY figure (practice
 *      money never reaches it, X4); the balance is the accounts affordance; a currency-row tap
 *      sets main and the headline follows (the deliberate gesture) while a practice tap does not
 *      rewrite it; the Pay sub-mode pin survives.
 * 135: the Home activity feed — newest 5 rows in ∂ units, the cap holds, See-all opens the full
 *      Transactions tab.
 * 136: the accounts page — zero-balance currencies stay visible, the practice row sits last under
 *      its divider, the Main badge is the main row's alone, the row press sets main, and the
 *      semantics survive a reload.
 * 150: the accounts ROUTE — one tap from the Pay scanner, no modal overlay, origin-aware Back,
 *      reachable by the `a` hotkey and the Home affordance.
 *
 * GAP vs the browser twins (filed for the integrator): DOM-order enumeration
 * (querySelectorAll) and role="dialog" counting have no react-test-renderer equivalent; the
 * same facts are pinned through aria-selected props, the Main badge testIDs, and the presence of
 * the bottom tabs.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assertEq, assertIncludes, faucetAccount, generateKeypair, onboardWallet,
  openBalances, openPaySend, railTransfer, selectCurrency,
} from '../harness/lib';
import {freshContext} from '../onboard/helpers';

hermeticDescribe('flow 133 — home-surface', () => {
  it('cold start lands on Home; the headline owns the home currency; set-main gesture; sub-mode pin', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-home');
    // A reload is the cheapest cold start, and the landing mode is what is under test. The remount
    // also resets the location stub to '/' (a fresh page load carries no ?screen= history).
    await m.remount({url: '/'});

    // (a) The landing surface IS Home — zero taps. The scanner is one tap away, not in front.
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 10_000});
    expect(m.driver.isPresent('pay-scan')).toBe(false);
    await m.driver.findByTestID('tab-pay', {timeoutMs: 4000});

    // (b) The headline is the HOME CURRENCY in the currency unit; ∂100 of practice money does NOT
    //     reach it (X4).
    assertEq(m.driver.readText('home-headline-label'), 'Balance CHF', "the headline names the home CURRENCY");
    expect(m.driver.readText('home-headline-amount').includes('∂')).toBe(false);

    // (d) The accounts AFFORDANCE is the headline itself; the LIST is not here.
    await m.driver.findByTestID('btn-home-accounts', {timeoutMs: 4000});
    expect(m.driver.isPresent('accounts-list')).toBe(false);
    expect(m.driver.isPresent('asset-demo-select')).toBe(false);

    // (d′) Tapping the balance opens the accounts route; Back returns.
    await m.driver.click('btn-home-accounts', {timeoutMs: 4000});
    await m.driver.findByTestID('accounts-list', {timeoutMs: 5000});
    await m.driver.click('btn-accounts-back', {timeoutMs: 4000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});

    // (b″) Tapping a CURRENCY row sets main — the headline follows, deliberately.
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});
    assertEq(m.driver.readText('home-headline-label'), 'Balance BTC',
      "the currency-row tap sets main — the headline follows it");

    // (b′) X4's core: a practice-row tap re-points the working selection without the headline.
    await openBalances(m);
    await selectCurrency(m, 'demo', {timeoutMs: 5000});
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});
    assertEq(m.driver.readText('home-headline-label'), 'Balance BTC',
      'a practice tap must NOT rewrite the home currency the headline states (X4)');

    // (c)+(d′) The Pay sub-mode pin: Send → Home → Pay tab → one toggle tap → live scanner.
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');
    await openPaySend(m);
    await m.driver.findByTestID('btn-pay-send', {timeoutMs: 4000});
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 4000});
    await m.driver.click('btn-pay-scan', {timeoutMs: 4000});
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});

    // (e) Receive still opens the request form.
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.findByTestID('req-prefix', {timeoutMs: 5000});

    await m.unmount();
  }, 150_000);
});

hermeticDescribe('flow 135 — home-activity', () => {
  it('newest 5 rail payments in ∂ units, the cap holds, See-all opens the full ledger', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-feed');
    const alice = await accountOf(m);
    const payer = await generateKeypair();
    const fund = await faucetAccount(payer.publicHex, 20000);
    expect(fund.ok).toBe(true);

    // Five rail payments from an ephemeral payer grow the ledger to 6 rows — one past the cap.
    for (const cents of [1200, 2300, 3400, 4500, 5600]) {
      const pay = await railTransfer(payer.secretHex, alice!.publicHex, cents, {});
      expect({ok: pay.ok, status: pay.status}).toEqual({ok: true, status: 202});
    }

    // (a)+(b) The feed lands the newest rows, newest first, capped at 5.
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});
    expect(await m.driver.waitForText('+∂56.00', {timeoutMs: 10_000})).toBe(true);
    const activity = m.driver.readText('home-activity');
    assertIncludes(activity, '+∂56.00', 'the newest payment renders in its own ∂ unit');
    assertIncludes(activity, '+∂45.00', 'the second payment renders in its own ∂ unit');
    assertIncludes(activity, '+∂12.00', 'the oldest payment inside the cap renders in its own ∂ unit');
    expect(activity.includes('+∂100.00')).toBe(false); // the mint row is capped out
    expect(m.driver.isPresent('home-hist-time-5')).toBe(false);
    await m.driver.findByTestID('home-hist-time-4', {timeoutMs: 4000});

    // (c) See all opens the full Transactions tab — the capped-out oldest row is still listed.
    await m.driver.click('btn-home-activity-all', {timeoutMs: 4000});
    await m.driver.findByTestID('ledger-view', {timeoutMs: 5000});
    const ledger = m.driver.readText('ledger-view');
    assertIncludes(ledger, '+∂100.00', 'the full Transactions tab still lists the oldest (mint) row');
    assertIncludes(ledger, '+∂56.00', 'the full Transactions tab lists the newest row too');

    await m.unmount();
  }, 120_000);
});

hermeticDescribe('flow 136 — accounts-page', () => {
  it('zero rows stay, practice sits last under its divider, Main badge on CHF only, row press sets main, survives reload', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-accounts-page');

    await openBalances(m);
    await m.driver.findByTestID('accounts-list', {timeoutMs: 5000});
    expect(m.driver.isPresent('home-accounts')).toBe(false); // the retired container name

    // 1. Zero-balance currencies STAY; the funded practice row shows its balance.
    assertIncludes(m.driver.readText('accounts-currency-CHF'), '0.00 Fr', 'the zero CHF row stays visible');
    assertIncludes(m.driver.readText('accounts-currency-ICP'), '0 ICP', 'zero-balance ICP stays visible');
    assertIncludes(m.driver.readText('asset-demo'), '∂100.00', 'the funded practice row shows its balance');
    // The main currency leads (pinned through aria-selected; DOM-order enumeration is browser-only).
    expect(m.driver.propOf('accounts-currency-CHF', 'aria-selected')).toBe(true);
    const note = m.driver.readText('accounts-practice-note');
    assertIncludes(note.toLowerCase(), 'practice', 'the divider names the practice money');
    assertIncludes(note.toLowerCase(), 'no shop', 'the divider says what practice money cannot do');

    // 2. The Main badge sits on the MAIN currency row only.
    expect(m.driver.isPresent('currency-CHF-main')).toBe(true);
    expect(m.driver.isPresent('currency-USD-main')).toBe(false);

    // 3. The row press sets MAIN and goes Home.
    await m.driver.click('btn-accounts-currency-CHF', {timeoutMs: 5000});
    await m.driver.findByTestID('home-headline-label', {timeoutMs: 5000});
    assertEq(m.driver.readText('home-headline-label'), 'Balance CHF', 'the row press set CHF main and landed Home');

    // 4. The semantics SURVIVE a reload.
    await m.remount();
    await m.driver.findByTestID('home-headline-label', {timeoutMs: 8000});
    assertEq(m.driver.readText('home-headline-label'), 'Balance CHF', 'the reload resumes under the remembered main');

    await m.unmount();
  }, 120_000);
});

hermeticDescribe('flow 150 — accounts-route', () => {
  it('one tap from the scanner, zero-balance rows included, no modal, origin-aware Back, hotkey + Home affordance', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-accounts-route');

    // (a) ONE tap on the header chip from the Pay scanner.
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});
    await m.driver.click('balance', {timeoutMs: 5000});
    await m.driver.findByTestID('accounts-list', {timeoutMs: 5000});
    expect(m.driver.isPresent('pay-scan')).toBe(false);

    // (b) Every wallet CURRENCY renders, zero balances included.
    for (const code of ['CHF', 'USD', 'BTC', 'ETH', 'ICP', 'SOL']) {
      expect(m.driver.isPresent(`accounts-currency-${code}`)).toBe(true);
    }
    expect(m.driver.isPresent('asset-demo')).toBe(true);
    assertIncludes(m.driver.readText('accounts-currency-ICP'), '0 ICP', 'a zero-balance row states its zero honestly');

    // (d) It is a ROUTE: no modal overlay (pinned via the bottom navigation still being present —
    //     a dialog would take the tabs away; role="dialog" counting is browser-only).
    await m.driver.findByTestID('tab-pay', {timeoutMs: 3000});
    await m.driver.findByTestID('tab-home', {timeoutMs: 3000});

    // (c) Back returns to the surface it was opened FROM.
    await m.driver.click('btn-accounts-back', {timeoutMs: 5000});
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});
    expect(m.driver.isPresent('accounts-list')).toBe(false);

    // …and from a DIFFERENT origin it returns THERE.
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    await m.driver.findByTestID('ledger-view', {timeoutMs: 5000});
    await m.driver.click('balance', {timeoutMs: 5000});
    await m.driver.findByTestID('accounts-list', {timeoutMs: 5000});
    await m.driver.click('btn-accounts-back', {timeoutMs: 5000});
    await m.driver.findByTestID('ledger-view', {timeoutMs: 5000});

    // (e) The `a` hotkey and the Home affordance reach the same route.
    await m.driver.pressKey('a');
    await m.driver.findByTestID('accounts-list', {timeoutMs: 5000});
    await m.driver.click('btn-accounts-back', {timeoutMs: 5000});
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.click('btn-home-accounts', {timeoutMs: 5000});
    await m.driver.findByTestID('accounts-list', {timeoutMs: 5000});

    await m.unmount();
  }, 120_000);
});
