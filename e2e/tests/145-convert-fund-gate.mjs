// Flow 145 — Convert fails closed BEFORE the confirm, and says what to do instead.
//
// The 2026-09-08 live drive of the production build found "Re-quote and confirm" ENABLED on a
// wallet holding 0 ICP (`aria-disabled` null) — a confirm whose only possible outcome is a ledger
// refusal, on the screen where the user commits money. This flow drives the real app through both
// halves of that gate and through the restructured decision surface:
//   * ZERO balance: no amount field, no confirm button at all — the Pay tab's fund-gate shape
//     instead, naming the asset the wallet lacks and the exact surface that can fund it
//     (Receive ▸ My address, both reachable from the bottom nav on this very screen). The founder's
//     2026-08-29 rule: every dead end names the user's next action.
//   * ENTERED ABOVE THE BALANCE: the form stays, the numbers stay honest, and the confirm is
//     `aria-disabled="true"` with a line naming what the conversion needs (amount + the TWO
//     input-ledger fees it also costs) against what the wallet holds.
//   * AFFORDABLE: the confirm re-arms, and the surface leads with what the user RECEIVES — the
//     headline card the restructure added — with every §5 disclosure still rendered below it.
//   * NO HORIZONTAL OVERFLOW anywhere on the surface — the money screen never slides sideways.
//   * Screenshots: the fund gate, the refusal, and the armed decision surface.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency, openConvertFor,
  typeConvertAmount,
} from '../harness/lib.mjs';

const SEED = 50000000; // 0.5 ICP — enough to convert a little, never enough for the 2 ICP attempt

export const meta = {
  id: '145',
  name: 'convert-fund-gate',
  journey: 'convert',
  covers: ['convert', 'icp', 'vchf', 'fail-closed', 'fund-gate', 'insufficient-balance', 'ledger-fees', 'a11y-disabled', 'hierarchy', 'honest-copy', 'no-horizontal-overflow'],
  verifies: 'Convert refuses a swap that could only fail: a zero balance replaces the form with the fund gate that names the asset and the Receive ▸ My address route; an amount above the balance disables the confirm (aria-disabled) and states what the conversion needs (amount plus both input-ledger fees) against the balance; an affordable amount re-arms the confirm and the screen leads with the amount the user will receive.',
  timeoutMs: 90000,
};

/** The confirm button's own accessibility truth — the attribute the live drive found null. */
const confirmDisabled = (driver) =>
  driver.eval(() => document.querySelector('[data-testid="btn-convert-confirm"]')?.getAttribute('aria-disabled') ?? null);

async function openConvert(driver) {
  // selectCurrency makes ICP the active asset and leaves on Pay; re-open the accounts route so
  // Convert (which renders on the SELECTED row only) is on screen.
  await openConvertFor(driver, 'icp');
  assert(await driver.findByTestID('convert-screen', { timeoutMs: 8_000 }) != null, 'Convert surface opens for ICP');
}

export async function run() {
  const start = Date.now();
  console.log('[145-convert-fund-gate] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL, webBaseURL, driver } = env;

    // --- half 1: nothing to convert -----------------------------------------------------------
    console.log('[145-convert-fund-gate] onboarding an UNFUNDED wallet → the fund gate…');
    await onboardWallet(driver, 'e2e-convert-fundgate');
    const account = await accountOf(driver);
    await openConvert(driver);

    assert(await driver.findByTestID('convert-fund', { timeoutMs: 8_000 }) != null, 'a zero balance lands on the fund gate, not the form');
    assert(
      await driver.findByTestID('btn-convert-confirm', { timeoutMs: 1_000 }).catch(() => null) == null,
      'no confirm button exists at all on a wallet holding nothing (it could only fail)',
    );
    assert(
      await driver.findByTestID('convert-amount', { timeoutMs: 1_000 }).catch(() => null) == null,
      'no amount field on the fund gate — there is nothing to spend',
    );
    const gate = await driver.readText('convert-fund');
    assertIncludes(gate, 'ICP', 'the gate names the asset the wallet lacks');
    assertIncludes(gate, 'Receive', 'the gate names the tab that can fund it');
    assertIncludes(gate, 'My address', 'the gate names the sub-surface inside it (the deposit address)');
    // …and OFFERS it. Naming a route the user then has to walk by hand is half a gate; the Pay
    // tab's fund panel has always carried this button, and Convert now passes the same callback.
    assertIncludes(gate, 'Show my ICP address', 'the gate offers the route it names, as a button');
    await driver.screenshot('145-convert-fund-gate');
    await driver.click('convert-fund-go', { timeoutMs: 5_000 });
    assert(
      await driver.findByTestID('deposit-address', { timeoutMs: 8_000 }) != null,
      'the gate button lands the deposit surface that can actually fund ICP (Receive ▸ My address)',
    );

    // --- half 2: funded, but the entered amount is out of reach --------------------------------
    console.log('[145-convert-fund-gate] faucet 0.5 ICP, reload, ask to convert 2 ICP…');
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);
    // A reload is the deterministic way to make the wallet read the new balance (no poll race).
    await driver.navigate(webBaseURL, `/wallet?relay=${encodeURIComponent(relayBaseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });
    await openConvert(driver);
    assertIncludes(await driver.readText('convert-balance'), '0.5 ICP', 'the balance line shows the funded amount, with ONE unit');

    await typeConvertAmount(driver, '2');
    await driver.waitForFunction(
      () => document.querySelector('[data-testid="convert-insufficient"]') != null,
      { timeoutMs: 8_000 },
    );
    const refusal = await driver.readText('convert-insufficient');
    assertIncludes(refusal, '2.0002 ICP', 'the refusal states what the conversion needs: 2 ICP plus BOTH input-ledger fees');
    assertIncludes(refusal, '0.5 ICP', 'the refusal states the balance it is measured against');
    assert((await confirmDisabled(driver)) === 'true', 'the confirm is aria-disabled while the amount is out of reach');
    await driver.screenshot('145-convert-insufficient');

    // --- half 3: an affordable amount re-arms the confirm, headline first ----------------------
    console.log('[145-convert-fund-gate] drop to 0.1 ICP → the confirm re-arms, headline leads…');
    await typeConvertAmount(driver, '0.1');
    await driver.waitForFunction(
      () => document.querySelector('[data-testid="btn-convert-confirm"]') != null
        && document.querySelector('[data-testid="btn-convert-confirm"]').getAttribute('aria-disabled') !== 'true',
      { timeoutMs: 12_000 },
    );
    assert((await confirmDisabled(driver)) !== 'true', 'the confirm re-arms once the amount fits');
    const headline = await driver.readText('convert-headline');
    assertIncludes(headline, 'You receive', 'the screen leads with what the user receives');
    assertIncludes(headline, 'VCHF', 'the headline is in the asset the user ends up holding');
    // The census folds behind the ONE Details control (10x-verbosity pass 2026-09-16): open
    // it and the rate + pool principal are still spelled on their own lines. The net end-state
    // line is GONE — the headline number IS the end state; its absence is pinned, not assumed.
    await driver.click('convert-details', { timeoutMs: 5_000 });
    assertIncludes(await driver.readText('convert-rate'), 'ICP', 'the rate names both legs');
    assertIncludes(await driver.readText('convert-pool-principal'), '65mrh-fqaaa-aaaar-qapoa-cai', 'the pool principal has a line of its own');
    assert(await driver.findByTestID('convert-net', {timeoutMs: 1_000}).catch(() => null) == null,
      'the net end-state line is gone (verbosity pass 2026-09-16)');
    // Scroll to the top so the capture shows the decision, not the middle of the terms.
    await driver.eval(() => window.scrollTo(0, 0));
    // A money screen may never slide sideways. The amount `<input>`'s intrinsic width used to beat
    // `flex: 1` on react-native-web (min-width defaults to `auto`), so focusing the field scrolled
    // the whole app column 41px left and cut the balance, the headline label and the fee lines off
    // at the edge — invisible to every testID assertion, visible in every screenshot.
    const overflow = await driver.eval(() => {
      const doc = document.documentElement;
      let widest = 0;
      let scrolled = 0;
      let widestId = null;
      document.querySelectorAll('*').forEach((el) => {
        // An element that declares `text-overflow: ellipsis` is TRUNCATING ON PURPOSE and says so
        // on screen with the ellipsis itself — that is the opposite of the defect this measures,
        // which is content sliding out of view with no mark that anything is missing. (The header
        // username ellipsizes since X18, so that it yields the row's width to the account chip
        // instead of pushing it off the phone; without this exemption the guard would forbid the
        // very fix.) Everything else that exceeds its own box is still fatal.
        if (getComputedStyle(el).textOverflow === 'ellipsis') return;
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
          const d = el.scrollWidth - el.clientWidth;
          if (d > widest) { widest = d; widestId = el.getAttribute('data-testid') ?? el.tagName; }
        }
        scrolled = Math.max(scrolled, el.scrollLeft);
      });
      return { docOverflow: doc.scrollWidth - doc.clientWidth, widest, widestId, scrolled };
    });
    assertEq(overflow.scrolled, 0, 'nothing on the Convert screen is scrolled sideways');
    assertEq(overflow.widest, 0, `no element overflows its own box horizontally (${JSON.stringify(overflow)})`);
    await driver.screenshot('145-convert-decision');

    console.log(`[145-convert-fund-gate] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('145-convert-fund-gate RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
