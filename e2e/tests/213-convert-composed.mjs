// Flow 213 — the COMPOSED IC+CeFi conversion end to end (design brief 2026-09-26 §5.4 item 2,
// the 2-press fold): VCHF → ICP (icpswap pool) → SideShift-EURC order → EURC, at the ONE
// consent press (the 2-press grammar: entry tap, then the Convert CTA).
//
// The sheet consumes the engine's composed kind; this flow pins the REAL surface:
//   * the EUR target's only device-signable row is the composed chain — the sheet auto-picks
//     it, the review card names the IC leg (Swap VCHF → ICP on ICPSwap), the settle venue
//     (SideShift), and the deposit line ("Sending <floor> ICP to SideShift"),
//   * THE ONE CONSENT: the Convert press re-quotes fresh, creates the venue order
//     (order-first, exactly once) and CONTINUES straight into the three signed legs
//     (approve/swap/deposit_transfer) in the SAME gesture — no intermediate stop. The
//     deposit transfer moves EXACTLY the IC floor to the venue's address (the books prove
//     it: ICP nets gross − floor − the ICP fee), and the record parks at awaiting_deposit
//     with the deposit row's durable identity (sentTx) on the record,
//   * the tracker narrates the venue-side facts LIVE: the order (venue + locked settle
//     figure verbatim, attributed + timestamped), the venue's deposit address revealed
//     verbatim, the exact signed amount, and the venue's deposit window,
//   * a reload resumes the venue payout watch WITHOUT re-creating the order, and the venue's
//     own settled figures complete it (done names SideShift and 0.0495 EURC),
//   * the deposit gate's refusal paths, seeded as v3 records cloned from the real one:
//     a past deposit window refuses ONCE (never retried, the leg frozen Refused), and an
//     exact-amount corruption (order figure ≠ signed transfer figure) refuses before any
//     signature — both landing the deposit_refused taxonomy with the hub asset named.
// Store keys are v3 (`dpay.convert.v3.<pub>`) throughout.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance,
  openBalances, openConvertFor,
  pickSwapTarget, typeConvertAmount,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {installSideShiftStub, setSideShiftStatus} from '../harness/sideshift.mjs';

const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const POOL_VCHF_ICP = '65mrh-fqaaa-aaaar-qapoa-cai'; // venue icpswap's OWN pool (token0 = VCHF)
const COMPOSED_ROW = 'composed:icpswap:sideshift-eurc'; // resolveConvertDestinations' route id

const SEED_VCHF = 2000000000; // 20 VCHF
const AMOUNT_TEXT = '2';
const AMOUNT_IN = 200000000n;
const VCHF_FEE = 10000n;
const ICP_FEE = 10000n;
const DEPOSIT_ADDRESS = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // the stub's valid ICRC-1 account text
const SHIFT_ID = 'e2e-shift-9c1d';
const SETTLE_HASH = 'sol-settle-sig-213';
const COMPOSED_ROW_TESTID = `convert-venue-${COMPOSED_ROW}`;

export const meta = {
  id: '213',
  name: 'convert-composed',
  journey: 'convert',
  covers: ['convert', 'composed', 'iccefi', 'sideshift', 'order-first', 'one-consent',
    'deposit-transfer', 'deposit-gate', 'v3-store', 'deposit-leg-copy', 'reload-recovery',
    'no-re-sign', 'deposit-refused', 'live-narration'],
  verifies: 'The composed IC+CeFi kind converts VCHF to EURC at the ONE consent press (the 2-press grammar: entry tap, then the Convert CTA): the sheet auto-picks the composed row for the EUR target and discloses the venue + locked figure before the tap, the Convert press re-quotes fresh, creates the venue order exactly once and continues straight into the three signed legs with the deposit transfer moving exactly the IC floor to the venue\'s address (books match), the tracker narrates the venue facts live (order + locked figure attributed, deposit address revealed verbatim, exact amount, deposit window), the record parks at awaiting_deposit with the deposit row identity, a reload resumes the payout watch without re-creating the order, the venue\'s own figures complete it, and the seeded-v3 refusal paths (a past deposit window, an exact-amount corruption) land deposit_refused once with the hub asset named.',
  timeoutMs: 180000,
};

async function relayHits(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/sideshift-upstream/hits`);
  if (!res.ok) throw new Error(`relay stub hits failed (${res.status})`);
  return res.json();
}

/** The venue's own IC quote off the relay, exactly as the app reads it (flow 190's oracle). */
async function relayQuote(relayBaseURL, pool, tokenIn, tokenOut, amountIn) {
  const res = await fetch(`${relayBaseURL}/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`);
  if (!res.ok) throw new Error(`relay oracle quote failed (${res.status}): ${await res.text()}`);
  return res.json();
}

function fmt(raw, decimals) {
  const n = BigInt(raw);
  const d = BigInt(decimals);
  const frac = (n % 10n ** d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${n / 10n ** d}${frac ? '.' + frac : ''}`;
}

/** The app's exact 1% floor math (default 100 bps slippage). */
function floor99(gross) {
  return (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
}

/** Re-enter the convert surface from the accounts route. */
async function reopenConvert(driver) {
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    try {
      await openConvertFor(driver, 'vchf', {timeoutMs: 8_000});
      opened = true;
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
}

async function storeRecords(driver, publicHex) {
  return driver.eval((key) => {
    const raw = window.localStorage.getItem(key);
    return raw == null ? {} : JSON.parse(raw);
  }, `dpay.convert.v3.${publicHex}`);
}

/** Seed a cloned composed record parked just before the deposit leg. `patch` mutates the clone. */
async function seedComposedClone(driver, publicHex, seedId, patch) {
  const out = await driver.eval((key, id, mutate) => {
    const store = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    const tpl = Object.values(store).find((r) => r != null && r.composedDeposit != null);
    if (tpl == null) throw new Error('no composed record to clone');
    const rec = JSON.parse(JSON.stringify(tpl));
    delete rec.outAmountNet; delete rec.outTx; delete rec.hopTx; delete rec.destTx;
    delete rec.failureCode; delete rec.failureDetail; delete rec.acknowledgedStuckAtMs;
    delete rec.composedDeposit.sentTx;
    rec.id = id;
    rec.step = 'approving';
    rec.createdAtMs = Date.now() + 5_000;
    rec.legPlan = rec.legPlan.map((lp, i) => ({...lp, state: i < 2 ? 'confirmed' : 'pending'}));
    // The leg envelopes stay future-dated: only the field under test may expire.
    const now = Date.now();
    rec.legs = rec.legs.map((l) => ({...l, expiresAtMs: now + 300_000}));
    // eslint-disable-next-line no-new-func
    (new Function('rec', 'now', mutate))(rec, now);
    store[id] = rec;
    window.localStorage.setItem(key, JSON.stringify(store));
    return Object.keys(store).length;
  }, `dpay.convert.v3.${publicHex}`, seedId, patch);
  return out;
}

/** Poll the store until the engine's gate has failed the seeded record. */
async function waitForFailure(driver, publicHex, id, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const store = await storeRecords(driver, publicHex);
    if (store[id]?.failureCode != null) return store[id];
    if (Date.now() > deadline) throw new Error(`waitForFailure: ${id} never failed (step: ${store[id]?.step ?? 'absent'})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function run() {
  const start = Date.now();
  console.log('[213-convert-composed] setup (own relay + shared web + browser)…');
  // solStub: the EUR target is offerable only when its EURC(Solana) rail exists in the
  // wallet's asset list — the RPC stub answers the existence probe honestly offline (the
  // flow-194 pattern; the settle side is a Solana-rail mint).
  const env = await setup({solStub: true});
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;

    console.log('[213-convert-composed] onboarding + funding 20 VCHF…');
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-convert-composed');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_VCHF, {currency: 7});
    assert(fund.ok, `faucet VCHF credit ok (status ${fund.status})`);
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});

    // The composed oracle: the IC leg's gross + floor, exactly what the order will price.
    const q1 = await relayQuote(r2.baseURL, POOL_VCHF_ICP, VCHF_LEDGER, ICP_LEDGER, AMOUNT_IN);
    assertEq(q1.venue_id, 'icpswap', 'the IC leg quotes under the icpswap venue id');
    const gross1 = BigInt(q1.amount_out);
    const minOut1 = floor99(gross1);
    const depositDecimal = fmt(minOut1, 8);

    // --- §1 the 2-press happy path: auto-pick → entry facts → THE ONE consent press ---------
    console.log('[213-convert-composed] the EUR target auto-picks the composed row…');
    await openBalances(driver, {timeoutMs: 8_000});
    await openConvertFor(driver, 'vchf');
    await pickSwapTarget(driver, 'EUR');
    await typeConvertAmount(driver, AMOUNT_TEXT);
    // The composed row is the pair's only device-signable row → the sheet AUTO-PICKS it.
    // The review card names the settle venue's own figure, the pick line, the IC leg, and
    // the deposit line in the pre-provisioned depositLeg copy — the venue + locked figure
    // are disclosed BEFORE the tap.
    await driver.findByTestID('convert-venue-auto', {timeoutMs: 15_000});
    // The hero reads EURC at standard display precision (2 decimals); the settle venue's
    // verbatim quote stays in Details (the census is opened further down for the route pins).
    assertIncludes(await driver.readText('convert-receive'), '≈ 0.04 EURC',
      'the receive hero is the settle venue\'s own quote at standard display precision');
    assertIncludes(await driver.readText('convert-venue-auto'), 'SideShift',
      'the pick disclosure names the settle venue');
    assertIncludes(await driver.readText('convert-route-via'), 'Swap VCHF → ICP on ICPSwap',
      'the route names its IC leg verbatim');
    assertIncludes(await driver.readText('convert-route-via'), `to SideShift`,
      'the deposit line names the venue that will hold the order');
    assertIncludes(await driver.readText('convert-route-via'), depositDecimal,
      'the deposit line names the IC floor the order will price');
    // The hero's rounding is presentation only — Details carries SideShift's verbatim quote.
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('convert-quote-verbatim'), '0.0495 EURC',
      'Details carries the settle venue\'s verbatim quoted figure');
    await driver.click('convert-details', {timeoutMs: 5_000}); // close it again for the press

    // NOTHING is adopted before the consent: the store is still empty.
    let store = await storeRecords(driver, account.publicHex);
    assertEq(Object.keys(store).length, 0, 'no record exists before the consent (pre-broadcast invariant)');

    // THE ONE CONSENT — the Convert press re-quotes fresh, creates the venue order ONCE and
    // continues straight into the three signed legs in the same gesture; the tracker takes
    // over and narrates the venue facts live.
    console.log('[213-convert-composed] the one consent press: order + three legs + live narration…');
    const vchfBefore = BigInt(await getBalance(r2.baseURL, account.publicHex, 7));
    const icpAfterSwapBooks = {gross1: gross1.toString(), minOut1: minOut1.toString()};
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('convert-state', {timeoutMs: 15_000});
    await driver.findByTestID('convert-leg-2', {timeoutMs: 15_000}); // the deposit leg renders
    await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
    const awaiting = await driver.readText('convert-awaiting-deposit');
    assertIncludes(awaiting, 'SideShift', 'the payout watch names the venue');
    assertIncludes(awaiting, depositDecimal, 'the deposit leg\'s copy names the sent amount');
    assertEq((await relayHits(r2.baseURL)).shiftCalls, 1, 'exactly ONE venue order exists');

    // The live narration: the venue's order facts, verbatim, attributed — the deposit
    // address (which only exists once the order does) disclosed during execution.
    assertIncludes(await driver.readText('convert-composed-order'), 'SideShift',
      'the order line names the venue');
    assertIncludes(await driver.readText('convert-composed-order'), '0.0495',
      'the order line carries the venue\'s LOCKED settle figure verbatim');
    assertIncludes(await driver.readText('convert-composed-order-id'), SHIFT_ID,
      'the venue\'s order id renders in the narration');
    assertIncludes(await driver.readText('convert-composed-order-at'), 'SideShift',
      'the locked figure is attributed to the venue');
    assertIncludes(await driver.readText('convert-composed-deposit-amount'), depositDecimal,
      'the exact-amount gate\'s figure is the IC chain\'s floored amount');
    assertIncludes(await driver.readText('convert-composed-deposit-address'), DEPOSIT_ADDRESS,
      'the venue\'s own deposit address is revealed live, verbatim');
    await driver.screenshot('213-composed-live-narration');

    // The record: awaiting_deposit, the deposit row's durable identity frozen on it.
    store = await storeRecords(driver, account.publicHex);
    const rec = Object.values(store).find((r) => r != null && r.composedDeposit != null);
    assert(rec != null, 'the consented record persisted');
    assertEq(rec.step, 'awaiting_deposit', 'the record parks at the venue payout watch');
    assert(rec.composedDeposit.sentTx != null, 'the deposit row identity is on the record (the ledger-row evidence)');
    assertEq(rec.legPlan.length, 3, 'three legs: approve, swap, deposit_transfer');
    assertEq(rec.legPlan[2].kind, 'deposit_transfer', 'the last leg IS the deposit transfer');
    assertEq(rec.composedDeposit.amountDecimal, depositDecimal, 'the order amount is the IC floor, verbatim');

    // The books: VCHF debited amount + TWO input fees (the approve's and the swap pull's);
    // ICP nets gross − floor − the ICP transfer fee (the surplus stays in-wallet).
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 7)), vchfBefore - AMOUNT_IN - 2n * VCHF_FEE,
      'VCHF debited the amount plus its two ledger fees');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 8)),
      gross1 - minOut1 - ICP_FEE,
      'ICP nets swap gross − the deposited floor − the transfer fee (the surplus stays in-wallet)');
    await driver.screenshot('213-composed-awaiting-deposit');

    // --- §2 reload: the payout watch resumes WITHOUT re-creating the order -------------------
    console.log('[213-convert-composed] reload: the watch resumes, the order is never re-created…');
    const shiftsBefore = (await relayHits(r2.baseURL)).shiftCalls;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'}); // page stubs die with the page
    await reopenConvert(driver);
    await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
    assertEq((await relayHits(r2.baseURL)).shiftCalls, shiftsBefore,
      'the venue order was NEVER re-created across the reload');

    // --- §3 the venue settles: its own figures complete the record ----------------------------
    await setSideShiftStatus(driver, 'settled', {settleAmount: '0.0495', settleHash: SETTLE_HASH});
    await driver.findByTestID('convert-done', {timeoutMs: 45_000});
    const done = await driver.readText('convert-done');
    assertIncludes(done, '0.0495', 'done reports the VENUE\'s own settle amount');
    assertIncludes(done, 'SideShift', 'done attributes the trade to the venue');
    await driver.screenshot('213-composed-done');

    // --- §4 the expired deposit window (seeded): the gate refuses ONCE, nothing re-signs -----
    // The refusal is driven by the ENGINE from the seeded v3 record (cloned from the real
    // one) and asserted on the STORE — the engine is the mover, so the store IS the record
    // of what the user's screen reports (the tracker's failed-leg copy for this taxonomy is
    // pinned by app/__tests__/convertComposedSheet.test.tsx). The seed bumps the deposit
    // amount CONSISTENTLY (+1 raw unit, decimal re-derived) so the gate's ledger-row probe
    // cannot mistake §1's real deposit row for this record's transfer, then sets the venue
    // window in the past: exact-amount passes, the probe misses, the window check refuses.
    console.log('[213-convert-composed] seeded refusal: a past deposit window…');
    await seedComposedClone(driver, account.publicHex, 'seeded-expired-213', `
      const bumped = (BigInt(rec.composedDeposit.amountRaw) + 1n).toString();
      rec.composedDeposit.amountRaw = bumped;
      const neg = bumped.padStart(9, '0');
      rec.composedDeposit.amountDecimal = (neg.slice(0, -8).replace(/^0+(?=.)|^0$/, '') || '0') + '.' + neg.slice(-8).replace(/0+$/, '');
      rec.composedDeposit.expiresAtMs = now - 1_000;`);
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});
    await waitForFailure(driver, account.publicHex, 'seeded-expired-213');
    store = await storeRecords(driver, account.publicHex);
    assertEq(store['seeded-expired-213'].failureCode, 'deposit_refused', 'the refusal is the deposit_refused taxonomy');
    assertIncludes(store['seeded-expired-213'].failureDetail, 'venue order expired',
      'the refusal detail names the dead deposit window');
    assertEq(store['seeded-expired-213'].legPlan[2].state, 'failed', 'the leg state froze failed — never retried');
    assertEq(store['seeded-expired-213'].legs.length, 3, 'the record still carries exactly its three legs');

    // --- §5 the exact-amount corruption (seeded): the gate refuses before any signature -------
    console.log('[213-convert-composed] seeded refusal: order figure ≠ signed transfer figure…');
    await seedComposedClone(driver, account.publicHex, 'seeded-amount-213',
      `rec.composedDeposit.amountRaw = (BigInt(rec.composedDeposit.amountRaw) + 1n).toString();`);
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});
    await waitForFailure(driver, account.publicHex, 'seeded-amount-213');
    store = await storeRecords(driver, account.publicHex);
    assertEq(store['seeded-amount-213'].failureCode, 'deposit_refused', 'the corruption landed deposit_refused');
    assertIncludes(store['seeded-amount-213'].failureDetail, 'order amount',
      'the refusal detail names the exact-amount invariant');
    assertEq(store['seeded-amount-213'].legPlan[2].state, 'failed', 'the corrupt transfer never signed');

    // The stub's order counter never moved past the ONE consented order.
    assertEq((await relayHits(r2.baseURL)).shiftCalls, shiftsBefore,
      'no refusal path re-created or re-signed anything at the venue');

    console.log(`[213-convert-composed] PASS (${Date.now() - start}ms)`);
  } finally {
    // env.stop() first (flow-38 convention): closing the page quiesces the app's polls before
    // the relay dies (the teardown race flow-190 documents).
    await env.stop();
    await r2.stop();
  }
}
