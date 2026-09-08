// Flow 153 — a practice payment that does not settle never claims that it did.
//
// The first screen a user meets is the worst possible place to teach them that a green tick is
// automatic. Both non-success outcomes are driven here, against the real app and the real ledger,
// and the shape of each half is chosen so it cannot be satisfied by a screen that simply always
// says the same thing:
//
//   A. UNKNOWN — the transfer IS submitted and the ledger DOES execute it; the app is simply
//      prevented from reading the result (every `read_state` poll is failed after the `/call`
//      lands). So the money really has moved and the screen still refuses to say so. That is the
//      exact asymmetry the honest-pending rule exists for: no stamp, no success sentence, no
//      balance claim — and the relay's own ledger, queried out-of-band, proves the payment was
//      real all along.
//
//   B. REJECTED — the wallet is told it has practice money it does not have (the balances read is
//      stubbed over a relay whose faucet is off), so the REFUSAL comes from the ledger rather than
//      from a local guard. The screen shows the ledger's own decoded reason and says nothing
//      moved, and the ledger agrees: still zero.
//
// Neither half may CHANGE the journey — the stamp set is captured immediately before Approve and
// must be identical after the outcome — and both must leave through Continue: practice never
// blocks the first run, however it ends. (The stamp set is not empty at that point: the
// walkthrough awards `flowUnderstood` on mount, so "no stamp was awarded" has to be checked as a
// DIFFERENCE rather than as an absence, or it would pass for the wrong reason.)
//
// Selector contract: `practice`, `btn-practice-review`, `btn-approve`, `practice-outcome`,
// `practice-outcome-body`, `practice-refused-reason`, `practice-left`, `btn-practice-continue`.
import {
  setup, assert, assertEq, assertIncludes, waitForEnabled, accountOf, getBalance,
  skipWalkthroughIfPresent,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

export const meta = {
  id: '153',
  name: 'practice-not-settled',
  journey: 'onboard',
  covers: ['practice', 'pending-honesty', 'no-false-success', 'error-path', 'first-run'],
  verifies: 'A practice payment that does not settle never claims success: an unknown outcome renders the pending state with no stamp and no success sentence even though the ledger DID move the money, a ledger refusal renders the decoded reason over an unmoved balance, and both leave Continue enabled.',
  timeoutMs: 90_000,
};

async function readJourney(driver) {
  const raw = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
  return raw ? JSON.parse(raw) : null;
}

/** Walk a fresh context from the walkthrough to the practice request card. */
async function onboardToPractice(driver, name) {
  await skipWalkthroughIfPresent(driver);
  await driver.typeByPlaceholder('e.g. Alice', name, {timeoutMs: 8_000});
  await driver.click('btn-create', {timeoutMs: 4_000});
  await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
  await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
  await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
  await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
  await driver.findByTestID('practice', {timeoutMs: 15_000});
}

export async function run() {
  const start = Date.now();
  console.log('[153-practice-not-settled] setup (relay + web + browser)…');
  const env = await setup();
  const noFaucet = await startRelay({faucet: false});
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    // ---- A. UNKNOWN: the payment happens, and the app cannot see that it did. -----------------
    await onboardToPractice(driver, 'e2e-unknown');
    // Arm the block only AFTER the submission lands: the clock the envelope is stamped with is
    // itself a read_state, and blocking that would refuse the signature instead of the reading —
    // a different failure, and not the one under test.
    await driver.eval(() => {
      window.__DPAY_BLOCK_READ_STATE = false;
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (window.__DPAY_BLOCK_READ_STATE && /\/read_state$/.test(url)) {
          throw new TypeError('[153] read_state blocked: the payment is submitted and unreadable');
        }
        const response = await real(input, init);
        if (/\/call$/.test(url)) window.__DPAY_BLOCK_READ_STATE = true;
        return response;
      };
    });
    const identity = await accountOf(driver);
    assert(identity && typeof identity.publicHex === 'string', 'the wallet identity must be persisted');
    const stampsBefore = [...((await readJourney(driver))?.stamps ?? [])].sort();

    await driver.click('btn-practice-review', {timeoutMs: 5_000});
    await driver.click('btn-approve', {timeoutMs: 8_000});
    await driver.findByTestID('practice-outcome', {timeoutMs: 40_000});

    assertEq(
      await driver.readText('practice-outcome-body'),
      'The payment was signed and sent. dpay has not seen it settle yet, so nothing is confirmed. This is exactly what a real pending payment looks like.',
      'an unknown outcome states exactly that, and nothing more',
    );
    const unknownScreen = await driver.readText('practice-outcome');
    assert(!unknownScreen.includes('the ledger settled it'),
      `an unknown outcome must NEVER carry the settled sentence. On screen: ${unknownScreen}`);
    assert(!(await driver.isPresent('practice-left')),
      'an unknown outcome must claim no remaining balance — it does not know one');
    const stampsAfter = [...((await readJourney(driver))?.stamps ?? [])].sort();
    assertEq(stampsAfter.join(','), stampsBefore.join(','),
      'an unknown outcome awards nothing — the journey is exactly what it was before Approve');
    assert(!stampsAfter.includes('paymentTested'), 'and certainly not the counterparty-payment stamp');
    assert(await driver.isPresent('btn-practice-continue'), 'and it still leaves through Continue');
    await driver.screenshot('153-practice-unknown');

    // The payment was REAL: the relay's own ledger moved while the screen refused to say so.
    const movedBal = await getBalance(relayBaseURL, identity.publicHex, 0);
    assertEq(movedBal, '9900',
      'the ledger DID execute the transfer — which is what makes the screen’s silence honesty rather than luck');
    console.log('[153-practice-not-settled] ✓ unknown: money moved, screen claims nothing, no stamp');

    // ---- B. REJECTED: the LEDGER refuses, and the screen quotes it. ---------------------------
    await driver.clearStorage();
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(noFaucet.baseURL)}`, {timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});
    // Tell the wallet it has practice money. It does not — this relay hands out none — so the only
    // thing that can refuse the payment is the ledger itself, which is the point.
    await driver.eval(() => {
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/\/api\/v1\/balances\//.test(url)) {
          return new Response(JSON.stringify({'0': '10000'}), {status: 200, headers: {'Content-Type': 'application/json'}});
        }
        return real(input, init);
      };
    });
    await onboardToPractice(driver, 'e2e-refused');
    const refusedIdentity = await accountOf(driver);
    const refusedBefore = [...((await readJourney(driver))?.stamps ?? [])].sort();
    await driver.click('btn-practice-review', {timeoutMs: 5_000});
    await driver.click('btn-approve', {timeoutMs: 8_000});
    await driver.findByTestID('practice-outcome', {timeoutMs: 40_000});

    assertEq(await driver.readText('practice-outcome-body'), 'Nothing moved.', 'a refusal says exactly that');
    assertIncludes(await driver.readText('practice-refused-reason'), 'Not enough balance',
      'the reason is the LEDGER’s own decoded refusal, not a generic error');
    const refusedAfter = [...((await readJourney(driver))?.stamps ?? [])].sort();
    assertEq(refusedAfter.join(','), refusedBefore.join(','),
      'a refused payment awards nothing either');
    assert(await driver.isPresent('btn-practice-continue'), 'and it still leaves through Continue');
    await driver.screenshot('153-practice-refused');

    const stillZero = await getBalance(noFaucet.baseURL, refusedIdentity.publicHex, 0);
    assertEq(stillZero, '0', 'nothing moved, exactly as the screen said');
    console.log('[153-practice-not-settled] ✓ rejected: the ledger’s own reason, over an unmoved balance');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[153-practice-not-settled] GREEN in ${elapsed}s`);
  } finally {
    await noFaucet.stop();
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[153-practice-not-settled] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
