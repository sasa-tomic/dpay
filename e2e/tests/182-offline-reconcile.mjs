// Flow 182 — back online, the pending payment reconciles into a settled history row. The full
// honest arc of the offline hand-off: offline QR hand-off (pending row + optimistic gross
// deduction) → relay restored (the authoritative poll returns the UNMOVED balance — the merchant
// has not settled yet, and the optimistic deduction retires in favour of the truth) → the
// merchant's phone submits the envelope server-side (railTransfer with the SAME memo nonce) →
// the history row lands, the pending record retires by join key, and the balance settles at
// funded − gross with the row headlining the gross exactly once (no pending/settled duplicate).
import {
  setup, assert, assertIncludes, assertEq, onboardWallet, armPayScan, getBalance, selectCurrency, openBalances,
  faucetAccount, accountOf, goOffline, setRelay, railTransfer,
} from '../harness/lib.mjs';
import { openHistory } from '../harness/flow-steps.mjs';
import { buildRequestQR, generateKeypair, randNonceHex } from '../harness/wire.mjs';

const CURRENCY = 8; // ICP
const SEED = 210000001;
const PAY = 100000001;
const FEE = 10000;
const WIRE = PAY - FEE;

export const meta = {
  id: '182',
  name: 'offline-reconcile',
  journey: 'offline',
  covers: ['offline', 'pending', 'reconcile', 'history', 'balances'],
  verifies: 'Back online: the authoritative poll replaces the optimistic deduction, then the settled history row (same memo) retires the pending row with no duplicate.',
  timeoutMs: 90_000,
};

export async function run() {
  const start = Date.now();
  console.log('[182-offline-reconcile] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    await onboardWallet(driver, 'e2e-offline-reconcile');
    const merchant = await generateKeypair();

    const payer = await accountOf(driver);
    const fund = await faucetAccount(relayBaseURL, payer.publicHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    assert(await driver.waitForText('2.10000001 ICP', { timeoutMs: 10_000 }), 'the header must show the funded ICP balance before the offline leg');

    // --- The offline hand-off (flow 180's contract, kept short here). ---------------------------
    // keepGateway: the hand-off sign needs the certified IC clock (see flow 180's comment); the
    // relay death alone is what makes this wallet "offline" for the balance/history surfaces.
    await goOffline(driver, { keepGateway: true });
    assert(await driver.waitForText('approx.', { timeoutMs: 8_000 }), 'the offline eyebrow must appear');
    const nonceHex = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(merchant.publicHex, String(WIRE), nonceHex, expiry, CURRENCY, 'Café Sunrise');
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    await driver.findByTestID('btn-paid', { timeoutMs: 6_000 });
    await driver.click('btn-paid', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-new', { timeoutMs: 5_000 });
    await driver.click('btn-new', { timeoutMs: 4_000 });
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-hist-pending-0', { timeoutMs: 6_000 });
    await openBalances(driver);
    assertIncludes(await driver.bodyText(), '1.1 ICP', 'the optimistic gross deduction renders offline (sheet row)');
    console.log('[182-offline-reconcile] ✓ offline hand-off done (pending row + optimistic deduction)');

    // --- Back online, merchant has NOT settled: the authoritative balance wins. ------------------
    // The Balances sheet is still open (the per-asset row is the assertion surface — compact form).
    await setRelay(driver, relayBaseURL);
    // The sheet renders ICP at full precision (210000001 e8-sats → '2.10000001 ICP'); the same
    // formatter trims 110000000 to '1.1 ICP' — 180/181 already pin that compact form.
    assert(await driver.waitForText('2.10000001 ICP', { timeoutMs: 15_000 }),
      'the restored poll must replace the optimistic view with the authoritative UNMOVED balance');
    await driver.click('tab-home', { timeoutMs: 4_000 });
    // The SUBTRACTION retired with the poll; the pending ROW stays (only history evidence retires it).
    await driver.findByTestID('home-hist-pending-0', { timeoutMs: 6_000 });
    assert(!(await driver.bodyText()).includes('~1.1 ICP'), 'no stale optimistic figure may linger');
    console.log('[182-offline-reconcile] ✓ back online: authoritative balance shown, pending row kept (unproven either way)');

    // --- The merchant's phone settles the handed-off envelope (same wire, same memo nonce). -----
    // Whoever holds the envelope submits it — this is exactly what the merchant app does with the
    // payer's QR. The rail moves the wire and charges the fee: the account moves the gross.
    const settle = await railTransfer(relayBaseURL, payer.secretHex, merchant.publicHex, WIRE, { currency: CURRENCY, memoHex: nonceHex });
    assert(settle.ok, `the merchant-side settle must be accepted, got ${settle.status}`);
    console.log('[182-offline-reconcile] ✓ envelope submitted server-side (memo = the request nonce)');

    // --- The reconciliation: settled row lands, pending row retires, balance settles once. ------
    await openBalances(driver);
    assert(await driver.waitForText('1.1 ICP', { timeoutMs: 20_000 }),
      'the settled transfer must bring the balance back to funded − gross');
    await openHistory(driver, { recentMs: 5_000 });
    await driver.waitGone('hist-pending-0', { timeoutMs: 15_000 }); // throws if it lingers

    const ledger = await driver.bodyText();
    assertIncludes(ledger, '\u22121.00000001 ICP', 'the settled row headlines the GROSS (2026-09-14 rule, note-sourced)');
    assertIncludes(ledger, '\u2212 0.0001 ICP fees', 'the fee annotation rides the settled row');
    assertIncludes(ledger, 'Café Sunrise', 'the merchant name from the request still rides the row');
    // Exactly ONE row for this payment — the pending projection and the settled row never coexist.
    assertEq((ledger.match(/\u22121\.00000001 ICP/g) ?? []).length, 1, 'exactly one row headlines this payment');
    console.log('[182-offline-reconcile] ✓ settled row reconciled: gross headline + fee + name, pending row gone, no duplicate');

    // The rail truth agrees: the account moved the gross, exactly once.
    const after = await getBalance(relayBaseURL, payer.publicHex, CURRENCY);
    assertEq(String(after), String(SEED - PAY), 'the rail balance equals funded − gross');

    await driver.screenshot('182-offline-reconcile');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[182-offline-reconcile] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[182-offline-reconcile] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
