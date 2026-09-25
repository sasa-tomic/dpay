// Flow 154 — from a cold launch to the wallet, nothing asks the user for money.
//
// The founder's verdict that opened the first-run redesign was, verbatim: *"the initial experience
// is VERY confusing. I get greeted with several screens that just ask me to pay in some money.
// Looks like scam."* That is not a copy problem and cannot be fixed by softening a sentence — it is
// STRUCTURAL, so this flow is structural: it walks every screen between launch and the wallet and
// requires that none of them mounts a deposit address, a fund gate, an add-money action, or a
// top-up button (anti-scam rules R1/R7, `docs/specs/2026-09-08-first-run-redesign.md` §4).
//
// It runs against a relay whose demo faucet is OFF, which is the WORST case and the one that makes
// the assertion mean something: the wallet genuinely has nothing, the app genuinely cannot give it
// anything, and it must still not turn round and ask. The practice screen has to say so and offer
// a way on — the founder's other hard rule (2026-08-29: a useful instruction on every step,
// especially the error path) — without offering an address.
//
// The wallet itself is a different matter and the rule says so (R7): an ask-for-funds surface is
// legitimate when it is reachable only from a gesture the user made. So the wallet is held to the
// narrower half — no deposit address and no fund PANEL may be standing there unprompted — while
// Home's Add money BUTTON is required to be present, as the positive control. Without that
// control the whole flow would pass on a build that had simply lost the ability to fund anything.
//
// Selector contract: the absence set below, plus `practice-nofaucet`, `btn-practice-continue`,
// `home-currency-title`, `balance`, `btn-home-add-money`.
import {
  setup, assert, assertIncludes, waitForEnabled, skipWalkthroughIfPresent,
  chooseHomeCurrencyIfPresent,
 waitForWallet} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

export const meta = {
  id: '154',
  name: 'first-run-no-solicitation',
  journey: 'onboard',
  covers: ['first-run', 'no-funding-solicitation', 'anti-scam', 'structural', 'practice', 'positive-control'],
  verifies: 'From cold launch to the wallet — walkthrough, create, backup, practice (on its no-faucet branch) and the currency chooser — no screen renders a deposit address, a fund gate, an add-money action or a top-up button, and the wallet then opens on no fund panel either; Home’s Add money action IS present as the positive control, so funding is a choice the user can make rather than one pushed at them.',
  timeoutMs: 90000,
};

/** Every affordance in the app that asks the user to put money in. None may appear before the
 *  wallet. Named individually so a failure says WHICH one leaked. */
const SOLICITATIONS = [
  'deposit-address',      // the ICRC / chain-key deposit sheets' address text
  'pay-fund',             // the Pay tab's fund-first instruction panel
  'pay-fund-go',          // …and its "Show my address" primary
  'btn-topup',            // the accounts route's demo top-up
  'btn-home-add-funds',   // Home's Add funds action
  'btn-receive-address',  // the Receive tab's "My address" toggle
];

/** The subset that is a SOLICITATION wherever it appears: a panel or an address the user did not
 *  ask to see. The rest of the set above are affordances, legitimate inside the wallet. */
const UNPROMPTED = ['deposit-address', 'pay-fund', 'pay-fund-go'];

/** Assert that not one of `ids` is mounted on whatever is on screen right now. */
async function assertAbsent(driver, ids, where) {
  for (const id of ids) {
    assert(!(await driver.isPresent(id)), `${where}: must not render "${id}" — nothing asks a new user for money before the wallet`);
  }
}
const assertNoSolicitation = (driver, where) => assertAbsent(driver, SOLICITATIONS, where);

export async function run() {
  const start = Date.now();
  console.log('[154-first-run-no-solicitation] setup (relay + web + browser)…');
  const env = await setup({ lazyBoot: false });
  const noFaucet = await startRelay({faucet: false});
  try {
    const {driver, webBaseURL} = env;

    // The ephemeral relay dies in the finally BEFORE env.stop() closes the page — the still-live
    // history fan-out then lands ERR_CONNECTION_REFUSED on a dead origin and the driver's teardown
    // diagnostics would fail-closed the flow. Its failures are expected; allowlist the origin.
    driver.allowRequestFailuresFrom(noFaucet.baseURL);

    // A relay that hands out nothing: the app has nothing to give, which is exactly when a lesser
    // design starts asking.
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(noFaucet.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});

    // 1. The walkthrough.
    await driver.findByTestID('walkthrough', {timeoutMs: 10_000});
    await assertNoSolicitation(driver, 'walkthrough');
    await skipWalkthroughIfPresent(driver);

    // 2. The create form.
    await driver.findByTestID('btn-create', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await assertNoSolicitation(driver, 'create form');
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-nosolicit', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});

    // 3. The backup gate.
    await driver.findByTestID('mnemonic-backup', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await assertNoSolicitation(driver, 'backup gate');
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});

    // 4. Practice, on its no-faucet branch — the screen that has the strongest excuse to ask, and
    //    must not. It says the server hands out none, and offers the way on.
    await driver.findByTestID('practice', {timeoutMs: 15_000});
    await driver.findByTestID('practice-nofaucet', {timeoutMs: 15_000});
    await assertNoSolicitation(driver, 'practice (no faucet)');
    assert(!(await driver.isPresent('practice-nofaucet-go')),
      'the no-faucet branch must offer no primary action at all — a "Show my address" here is the whole defect');
    assertIncludes((await driver.readText('practice-nofaucet')).toLowerCase(), 'practice money',
      'and it must still explain itself in the user’s terms');
    assert(await driver.isPresent('btn-practice-continue'), 'and it must offer the way on');
    await driver.screenshot('154-practice-no-faucet');
    await driver.click('btn-practice-continue', {timeoutMs: 5_000});

    // 5. The currency chooser — the first thing the app asks for, and it asks for a choice, not money.
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});
    await assertNoSolicitation(driver, 'currency chooser');
    await chooseHomeCurrencyIfPresent(driver);

    // 6. The wallet itself, landing on Home. Nothing is STANDING there asking — no address, no
    //    fund panel — on a wallet the app has just failed to fund.
    await waitForWallet(driver, {timeoutMs: 10_000});
    await assertAbsent(driver, UNPROMPTED, 'the wallet’s landing screen');
    console.log('[154-first-run-no-solicitation] ✓ five first-run surfaces solicit nothing, and the wallet opens on no panel');

    // POSITIVE CONTROL. Funding is one deliberate tap away for a user who wants it — the Add money
    // action is right there on Home. Without this the flow would pass on a build that had simply
    // lost the ability to fund anything.
    await driver.findByTestID('btn-home-add-funds', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    console.log('[154-first-run-no-solicitation] ✓ positive control: Home DOES offer Add funds, as a choice');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[154-first-run-no-solicitation] GREEN in ${elapsed}s`);
  } finally {
    // env.stop() first (flow-38 convention): closing the page quiesces the app's balance/history
    // polls — a poll that fired after noFaucet.stop() would surface as a requestfailed diagnostic
    // at driver.close() and RED an otherwise-green flow under load.
    await env.stop();
    await noFaucet.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[154-first-run-no-solicitation] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
