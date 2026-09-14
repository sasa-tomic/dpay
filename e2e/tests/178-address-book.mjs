// Flow 178 — The ADDRESS BOOK: saved destinations, browsable and editable.
//
// The founder asked on 2026-09-14 for "the address book [to] be shown somewhere in the UI." The
// store is older than the ask — every send form already auto-remembers settled destinations —
// but until this route the only surface was the send form's autocomplete chips, which are
// invisible exactly when the book is empty and the question "where do I manage these?" is first
// asked. This flow pins the whole route contract:
//   (a) the Settings entry closes the sheet and opens the route; an EMPTY book says so and
//       carries its way out (founder rule: every state names the next step, never a dead end);
//   (b) manual add: the asset chips name the RAIL (a destination is only valid on its own chain —
//       that is why the book is sectioned, not one flat list); a bad destination is refused with
//       the SEND FORM'S own words (same resolver, so the book can never accept what a send would
//       reject); a good one saves and appears under its rail;
//   (c) rename in place, and removal as one explicit tap that returns the book to its empty line;
//   (d) the send form's contextual manage link (`send-manage`) reaches the SAME route while the
//       book is populated, and Back returns to the form it came from (the route never strands the
//       user — where you came from is where you go back to).
import { setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency, openPaySend, railPrincipalText, isDisabled, assertDisabled } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '178',
  name: 'address-book',
  journey: 'system',
  covers: ['address-book', 'settings', 'send-form'],
  verifies: 'The saved-destination address book route: reached from Settings (and from the send form\'s saved list), an empty book states its way out, manual add refuses invalid destinations with the send form\'s own validation, and entries can be renamed and removed.',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[178-address-book] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[178-address-book] onboarding…');
    await onboardWallet(driver, 'e2e-addrbook');
    // The shared preamble ends on the Pay scanner (selectDemoAsset establishes it); this flow is
    // about chrome reachable from a settled wallet, so land on Home the way a cold start does —
    // the reload pattern flow 133 uses for its landing assertions.
    await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(env.relayBaseURL)}`,
      { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 10_000 });

    // A principal-shaped destination the fake-IC rail accepts (the same fixture family flow 104
    // sends to). The saved copy is the CANONICAL owner text, which is what the row testIDs key on.
    const principal = await railPrincipalText('b'.repeat(64));
    const addr8 = principal.slice(0, 8);

    // (a) Settings → Address book. The door CLOSES the sheet and OPENS the route — confirm by the
    //     route's own chrome arriving, not by the sheet's absence.
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-settings-address-book', { timeoutMs: 5_000 });
    await driver.click('btn-settings-address-book', { timeoutMs: 5_000 });
    await driver.findByTestID('addresses-list', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('settings-relay')), 'opening the address book must close the settings sheet (the door shuts it)');
    console.log('[178-address-book] ✓ Settings entry opens the route and shuts the sheet');

    // (a′) The EMPTY book says so, and says what to do next.
    const emptyLine = await driver.readText('addresses-empty', { timeoutMs: 4_000 });
    assertIncludes(emptyLine, 'No saved addresses yet', 'the empty book states its condition');
    assertIncludes(emptyLine, 'automatically', 'the empty book names its way out (send destinations are kept for you)');
    console.log('[178-address-book] ✓ empty book carries its way out');

    // (b) Add form: refuse-first. A garbage destination must be refused with a status line and the
    //     Save gate held shut — the book never accepts what a send would reject.
    await driver.click('btn-addresses-add', { timeoutMs: 5_000 });
    await driver.findByTestID('addresses-add-form', { timeoutMs: 5_000 });
    await driver.type('addr-add-address-input', 'not-an-address', { timeoutMs: 5_000 });
    await driver.findByTestID('addr-add-status', { timeoutMs: 5_000 });
    await assertDisabled(driver, 'btn-addresses-save', 'Save is disabled while the destination is invalid');
    await driver.click('btn-addresses-cancel', { timeoutMs: 5_000 });
    await driver.waitGone('addresses-add-form', { timeoutMs: 5_000 });
    console.log('[178-address-book] ✓ invalid destination refused, Save gated');

    // (b′) Add form again: pick the VCHF rail explicitly (the chips ARE the honesty mechanism — a
    //     destination only exists on its own chain; VCHF rather than the practice rail because the
    //     send-form leg below needs a rail with a send path), type a valid principal, wait for the
    //     resolver to clear the gate (the IC check is debounced), name it, save.
    await driver.click('btn-addresses-add', { timeoutMs: 5_000 });
    await driver.findByTestID('addresses-add-form', { timeoutMs: 5_000 });
    await driver.click('addr-add-asset-vchf', { timeoutMs: 5_000 });
    await driver.type('addr-add-address-input', principal, { timeoutMs: 5_000 });
    const gateDeadline = Date.now() + 6_000;
    for (;;) {
      if (!(await isDisabled(driver, 'btn-addresses-save'))) break;
      if (Date.now() > gateDeadline) throw new Error('[178-address-book] the valid destination never cleared the Save gate');
      await new Promise(r => setTimeout(r, 100));
    }
    await driver.type('addr-add-name-input', 'Landlord', { timeoutMs: 5_000 });
    await driver.click('btn-addresses-save', { timeoutMs: 5_000 });
    await driver.waitGone('addresses-add-form', { timeoutMs: 5_000 });
    const rowID = `addr-row-vchf-${addr8}`;
    const rowText = await driver.readText(rowID, { timeoutMs: 5_000 });
    assertIncludes(rowText, 'Landlord', 'the saved entry shows its label');
    assertIncludes(rowText, principal.slice(0, 5), 'the saved entry shows its address');
    console.log('[178-address-book] ✓ valid destination saved under its rail, named');

    // (c) Rename in place: the label is editable without re-entering the address.
    await driver.click(`addr-rename-vchf-${addr8}`, { timeoutMs: 5_000 });
    await driver.type('addr-rename-input-vchf', 'Canteen', { timeoutMs: 5_000 });
    await driver.click('addr-rename-save-vchf', { timeoutMs: 5_000 });
    await driver.waitGone('addr-rename-input-vchf', { timeoutMs: 5_000 });
    assertIncludes(await driver.readText(rowID, { timeoutMs: 5_000 }), 'Canteen', 'the renamed label replaced the old one');
    console.log('[178-address-book] ✓ entry renamed in place');

    // (d) The send form's contextual entry: leave the route first (Back returns to Home, the tab
    //     the settings door was covering — and the way OUT of Home to accounts is the tappable
    //     balance itself since 2026-09-14, which this leg exercises). The shared onboard preamble
    //     leaves DEMO as the PERSISTED selection (practice rail — no send path), so re-select the
    //     VCHF rail our entry lives on (flow 104's selector contract) and FUND it (the send form
    //     is balance-gated: an empty wallet sees "No VCHF available", not the form), then open
    //     the send form: its saved list shows a manage link that opens the same route, and Back
    //     returns to the form — the route never strands the traveller.
    await driver.click('btn-addresses-back', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, 'wallet account must be a 32-byte hex pubkey');
    const fund = await faucetAccount(env.relayBaseURL, accountHex, 500_000_000, { currency: 7 });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}`);
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.waitForText('5.00 VCHF', { timeoutMs: 8_000 });
    await openPaySend(driver);
    await driver.findByTestID('send-saved', { timeoutMs: 5_000 });
    await driver.click('send-manage', { timeoutMs: 5_000 });
    await driver.findByTestID('addresses-list', { timeoutMs: 5_000 });
    console.log('[178-address-book] ✓ send form manage link opens the route');
    await driver.click('btn-addresses-back', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-pay-send', { timeoutMs: 5_000 });
    console.log('[178-address-book] ✓ Back returned to the send form it came from');

    // (c′) Remove: one explicit tap on the row's forget control, and the book says so again.
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-settings-address-book', { timeoutMs: 5_000 });
    await driver.click('btn-settings-address-book', { timeoutMs: 5_000 });
    await driver.findByTestID(rowID, { timeoutMs: 5_000 });
    await driver.click(`addr-forget-vchf-${addr8}`, { timeoutMs: 5_000 });
    await driver.waitGone(rowID, { timeoutMs: 5_000 });
    assertIncludes(await driver.readText('addresses-empty', { timeoutMs: 5_000 }), 'No saved addresses yet', 'the book is empty again and says so');
    console.log('[178-address-book] ✓ entry removed, empty line restored');

    await driver.click('btn-addresses-back', { timeoutMs: 5_000 });
    await driver.screenshot('178-address-book');
    return { passed: true, meta, durationMs: Date.now() - start };
  } finally {
    await env.stop();
  }
}
