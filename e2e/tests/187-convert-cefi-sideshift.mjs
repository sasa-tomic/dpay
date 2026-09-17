// Flow 187 — the CeFi venue: ICP → SOL through SideShift (founder decision 3, 2026-09-14;
// the first relay-held partner-key surface).
//
// What makes this venue different from every prior one, all asserted here:
//
//   1. THE KEY LIVES ON THE RELAY, NOT THE DEVICE. Quotes and fixed-order creation ride the
//      relay's POST /api/v1/sideshift/* routes (the harness relay is spawned with FAKE
//      DPAY_SIDESHIFT_* credentials pointing at its own in-process stub); the device-side
//      audit is the stub's counter split — every upstream call carried the secret, ZERO
//      bare calls, and the secret string itself never appears in anything the page sees.
//   2. THE USER DEPOSITS TO THE VENUE'S ADDRESS. This IS CeFi: confirm creates the order
//      and the record parks at awaiting_deposit showing SideShift's OWN deposit address
//      and the EXACT deposit amount verbatim, with the handoff copy that says the venue
//      holds funds mid-trade and dpay is not a party. Nothing is signed; the ICP ledger
//      must be UNCHANGED end-to-end (the deposit is the user's own off-app act).
//   3. STATUS IS THE VENUE'S OWN KEYLESS GET, DEVICE-DIRECT. The resume engine's provider
//      path polls https://sideshift.ai/api/v2/shifts/{id} (page stub here) and maps
//      SideShift's vocabulary: waiting → still awaiting_deposit, multiple → processing,
//      settled → done with the venue's own settleAmount/settleHash, expired → dead-end,
//      refunded → the honest refund dead-end.
//   4. RELOAD RESUMES WITHOUT RE-CREATING THE ORDER. Mid-processing reload: the record
//      comes back at provider_processing, the relay stub's shift-creation counter does
//      not move, and the status poll stays keyed by the one shift id.
//   5. THE DISCLOSURE IS THE VENUE'S OWN. The checklist renders the byKey.sideshift copy
//      naming SideShift as an automated exchange service (not a licensed provider, dpay
//      paid nothing) with their own published terms link.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {deriveSolanaKeypair} from '../harness/jupiter.mjs';
import {installSideShiftStub, setSideShiftStatus, sideShiftStubState} from '../harness/sideshift.mjs';

const SEED_ICP = 2000000000; // 20 ICP
const AMOUNT_TEXT = '3';
// The relay stub's deterministic venue figures (src/app.rs sideshift_stub_*): the quote is
// a FIXED 0.0495 SOL settle for any deposit, rate 0.02475; the order carries deposit
// address e2e-deposit-address-01 and id e2e-shift-9c1d. The flow types 3 ICP so the order's
// echoed depositAmount ("3") is QUOTE-DERIVED, never a default — the app's prepare red line
// refuses an order whose amount is not the reviewed quote's.
const SETTLE_TEXT = '0.0495 SOL';
const DEPOSIT_ADDRESS = 'e2e-deposit-address-01';
const SHIFT_ID = 'e2e-shift-9c1d';
const SETTLE_HASH = 'sol-settle-sig-187';
const CEFI_ROW = 'convert-dest-cefi-sideshift';

export const meta = {
  id: '187',
  name: 'convert-cefi-sideshift',
  journey: 'convert',
  covers: ['convert', 'cefi', 'sideshift', 'partner-key', 'relay-proxy', 'deposit-handoff',
    'provider-status', 'venue-vocabulary', 'reload-recovery', 'no-re-sign', 'dead-end-honesty',
    'disclosure', 'cross-rail'],
  verifies: 'The first CeFi venue converts ICP to SOL through SideShift with the partner key held on the relay: the quote and fixed order ride the relay proxy (upstream calls always credentialed, zero bare), the record parks at awaiting_deposit showing the venue\'s own deposit address and exact amount verbatim with the exchange-service disclosure and terms link, nothing is signed and the ICP ledger never moves, status advances device-direct over SideShift\'s keyless GET (waiting, multiple→processing, settled with the venue\'s own figures, expired and refunded dead-ends), and a mid-processing reload resumes without re-creating the order.',
  timeoutMs: 180000,
};

async function relayHits(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/sideshift-upstream/hits`);
  if (!res.ok) throw new Error(`relay stub hits failed (${res.status})`);
  return res.json();
}

/** Re-enter the convert surface from the accounts route (post-terminal-variant trips). */
async function reopenConvert(driver) {
  await openBalances(driver);
  await selectCurrency(driver, 'icp');
  await openBalances(driver); // back to the accounts route — the convert entry lives there
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    try {
      await driver.click('btn-accounts-convert', {timeoutMs: 8_000});
      opened = true;
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
}

/** One full surface pass: pick the CeFi row, quote, confirm, land at awaiting_deposit with
 *  the venue's deposit handoff rendered verbatim. Returns once the panel is up. */
async function pickCefiAndConfirm(driver) {
  await driver.type('convert-amount', AMOUNT_TEXT);
  await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
  await driver.click(CEFI_ROW, {timeoutMs: 5_000});
  await driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
  await driver.waitForText('SideShift', {timeoutMs: 8_000});
  await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
  await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
  try {
    await driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
  } catch (e) {
    const panel = await driver.readText('convert-awaiting-deposit').catch(() => '<gone>');
    const store = await driver.eval(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('dpay.convert.v2')) out[k] = localStorage.getItem(k);
      }
      return out;
    });
    console.log('[187-dbg] awaiting-deposit panel text:', JSON.stringify(panel));
    console.log('[187-dbg] convert store:', JSON.stringify(store).slice(0, 3000));
    throw e;
  }
}

export async function run() {
  const start = Date.now();
  console.log('[187-sideshift] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;

    console.log('[187-sideshift] onboarding + funding ICP…');
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-cefi-sideshift');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
    assert(fund.ok, `faucet ICP credit ok (status ${fund.status})`);

    // The settle address is derived from the wallet's own seed (the venue pays the user's
    // Solana address — same derivation the SOL rail uses, never a dpay-held one).
    const kp = deriveSolanaKeypair(account.secretHex);

    // The STATUS half is page-scoped (quotes/orders ride the real relay route untouched).
    // passOrigins: the relay + web + default-relay origins — NOT sideshift.ai itself.
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});

    // --- §1 the venue row, the disclosure, and the verbatim quote
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.type('convert-amount', AMOUNT_TEXT);
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});

    assert(await driver.findByTestID(CEFI_ROW, {timeoutMs: 3_000}) != null,
      'the SideShift destination row is offered beside the direct pair and routes');
    assertIncludes(await driver.readText(CEFI_ROW), 'SideShift', 'the row names the venue');
    await driver.click(CEFI_ROW);
    const settle = await driver.readText('convert-settle-address');
    assertIncludes(settle, kp.address, 'the payout address is the wallet\'s OWN derived Solana address');
    await driver.waitForText(SETTLE_TEXT, {timeoutMs: 15_000});
    assertIncludes(await driver.readText('convert-quote-source'), 'SideShift', 'the quote is attributed to SideShift');
    // The counterparty + disclosure census folds behind the ONE Details control
    // (10x-verbosity pass 2026-09-16): open it before pinning them.
    await driver.click('convert-details', {timeoutMs: 5_000});
    const counterparty = await driver.readText('convert-counterparty');
    assertIncludes(counterparty, 'SideShift', 'the counterparty line names the venue');
    assertIncludes(counterparty, 'automated exchange service',
      'the cefi counterparty copy says what the venue IS (never the ic_amm on-chain-contract sentence)');
    assertIncludes(counterparty, 'Nothing is signed on this phone',
      'the checklist says the phone signs nothing — the user deposits to the venue themselves');
    const disclosure = await driver.readText('convert-venue-disclosure');
    assertIncludes(disclosure, 'sideshift.ai/terms', 'the venue\'s OWN published terms link renders');
    assertIncludes(disclosure, 'not a licensed provider', 'the disclosure says what the venue is NOT');
    await driver.screenshot('187-sideshift-quote');

    // --- §2 confirm: order created through the relay; the deposit handoff renders verbatim
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
    await driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
    assertIncludes(await driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS,
      'the venue\'s deposit address renders VERBATIM');
    const handoff = await driver.readText('convert-awaiting-deposit');
    assertIncludes(handoff, AMOUNT_TEXT, 'the EXACT deposit amount renders');
    assertIncludes(handoff, 'holds', 'the handoff copy says the venue holds funds mid-trade');
    assertIncludes(handoff, 'not a party', 'dpay names itself a non-party');
    await driver.screenshot('187-sideshift-deposit');

    // --- §3 the partner-key audit: credentialed upstream calls only, one order so far
    let hits = await relayHits(r2.baseURL);
    assertEq(hits.bareCalls, 0, 'ZERO bare upstream calls — the relay attached the credential every time');
    assertEq(hits.shiftCalls, 1, 'exactly one order created');
    assert(hits.quoteCalls >= 2, `quote surface used (form + confirm re-quote): ${hits.quoteCalls}`);
    assert(!(handoff.includes('e2e-stub-partner-secret')), 'the partner secret never appears in the UI');

    // 'waiting' is steady-state: 2.5s later still awaiting_deposit (no false transition).
    await new Promise((r) => setTimeout(r, 2_500));
    assert(await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 1_000}) != null,
      'a waiting shift stays at awaiting_deposit (honest still-waiting)');

    // --- §4 processing: the venue's own word drives the record
    await setSideShiftStatus(driver, 'multiple'); // SideShift's multi-deposit in-flight word
    await driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
    await driver.screenshot('187-sideshift-processing');

    // --- §5 reload mid-processing: resume WITHOUT re-creating the order
    const icpBefore = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    const shiftsBefore = (await relayHits(r2.baseURL)).shiftCalls;
    assertEq(shiftsBefore, 1, 'pre-reload: still one order');
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'multiple'}); // page stubs die with the page
    await reopenConvert(driver);
    await driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
    const shiftsAfter = (await relayHits(r2.baseURL)).shiftCalls;
    assertEq(shiftsAfter, shiftsBefore, 'the order was NEVER re-created across the reload');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 8)), icpBefore,
      'ICP ledger UNCHANGED across the reload — nothing was ever signed or sent');

    // --- §6 settled: the venue's own figures complete the record
    await setSideShiftStatus(driver, 'settled', {settleAmount: '0.0495', settleHash: SETTLE_HASH});
    await driver.findByTestID('convert-done', {timeoutMs: 45_000});
    const done = await driver.readText('convert-done');
    assertIncludes(done, SETTLE_TEXT, 'done reports the VENUE\'s own settle amount');
    assertIncludes(done, kp.address, 'the payout is named at the user\'s Solana address');
    await driver.screenshot('187-sideshift-done');

    // --- §7 the expired dead-end (a second order, driven to expiry)
    await driver.click('btn-convert-back', {timeoutMs: 5_000});
    // Each variant's order must be born into 'waiting': the engine polls a fresh record
    // immediately, and an order whose first poll reads the PREVIOUS variant's dead-end word
    // dies before the deposit handoff ever renders (the product behaves CORRECTLY — an
    // expired order is a dead quote; the flow must script the lifecycle in order: waiting
    // at birth, the dead-end word only after the handoff is up).
    await setSideShiftStatus(driver, 'waiting');
    await reopenConvert(driver);
    await pickCefiAndConfirm(driver);
    await setSideShiftStatus(driver, 'expired');
    await driver.findByTestID('convert-quote-expired', {timeoutMs: 45_000});
    assertIncludes(await driver.readText('convert-quote-expired'), 'expired', 'the expired dead-end says expired');
    await driver.screenshot('187-sideshift-expired');

    // --- §8 the refunded dead-end (a third order, refunded by the venue)
    await driver.click('btn-convert-back', {timeoutMs: 5_000});
    await setSideShiftStatus(driver, 'waiting');
    await reopenConvert(driver);
    await pickCefiAndConfirm(driver);
    await setSideShiftStatus(driver, 'refunded');
    await driver.findByTestID('convert-provider-refunded', {timeoutMs: 45_000});
    const refunded = await driver.readText('convert-provider-refunded');
    assertIncludes(refunded, 'SideShift', 'the refund dead-end names the venue that holds the remedy');
    await driver.screenshot('187-sideshift-refunded');

    // --- §9 audits: status keying, no unexpected origins, ledger truth
    const st = await sideShiftStubState(driver);
    assert(st != null, 'sideshift page-stub state present');
    assertEq(st.unexpected.length, 0, `status stub saw no unexpected origins (${st.unexpected.join(', ')})`);
    assert(st.statusCalls.length >= 3, `the provider path polled status (${st.statusCalls.length} GETs)`);
    for (const c of st.statusCalls) {
      assertEq(c.id, SHIFT_ID, 'every status poll was keyed by the ONE shift id the venue issued');
    }
    hits = await relayHits(r2.baseURL);
    assertEq(hits.bareCalls, 0, 'end-to-end: still ZERO bare upstream calls');
    assertEq(hits.shiftCalls, 3, 'three orders total (happy + expired + refunded variants)');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 8)), BigInt(SEED_ICP),
      'ICP ledger UNCHANGED end-to-end — the deposit is the user\'s own off-app act, dpay moved nothing');

    console.log(`GREEN 187 — ICP→SOL CeFi via SideShift: partner key relay-held (${hits.quoteCalls} credentialed quote calls, 0 bare), deposit handoff verbatim, waiting→multiple→settled + expired/refunded dead-ends, reload resumed order-free; ${SETTLE_TEXT} at ${kp.address.slice(0, 8)}… in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 187:', e);
    process.exit(1);
  });
}
