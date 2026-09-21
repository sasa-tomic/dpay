// Flow 194 — the EUR→IC bridge's venue: ICP → EURC through SideShift (sideshift-eurc,
// registered 2026-09-19; the pair that completes dpay's EUR rail).
//
// The venue row pairs ICP ↔ EURC(Solana): EURC is the user's EUR deposit asset (Solana),
// ICP the settle rail — and the reverse quote (ICP in, EURC out at the user's own Solana
// address) is the direction the ICP convert surface drives, exercised here end-to-end.
// The relay accepts BOTH directions of the pair (pair_direction pins them; both live
// /pair endpoints answered keyless 2026-09-19). Everything mechanism-level — partner key
// on the relay, deposit handoff, keyless status vocabulary, dead-ends, reload resume —
// flow 187 already pins on the sibling row; this flow pins the SAME fixture pattern on
// the NEW pair, plus what is structurally new about it:
//
//   1. A THIRD cefi mechanism on the ICP surface, and a new TWO-ROUTE destination: the
//      composed CCTP+jupiter multihop (landed there by this morning's jupiter-usdc-eurc
//      row) AND the direct cefi venue are two mechanisms of the ONE EURC destination —
//      the group row is the route's id, the cefi venue an explicit sub-pick (D2/D4/D5).
//   2. The venue's EURC coin code end-to-end: the settle leg renders in EURC (the
//      6-decimal EUR unit), the payout names the wallet's derived Solana address, and
//      the record's outCurrency stays the venue's own world until settled.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {deriveSolanaKeypair} from '../harness/jupiter.mjs';
import {installSideShiftStub, setSideShiftStatus, sideShiftStubState} from '../harness/sideshift.mjs';

const SEED_ICP = 2000000000; // 20 ICP
const AMOUNT_TEXT = '3';
// The relay stub's deterministic venue figures (src/app.rs sideshift_stub_*): the quote is
// a FIXED 0.0495 settle for any pair — here rendered in the venue's EURC unit — with rate
// 0.02475; the order carries deposit address e2e-deposit-address-01 and id e2e-shift-9c1d.
// The flow types 3 ICP so the order's echoed depositAmount ("3") is QUOTE-DERIVED, never
// a default (the app's prepare red line refuses a mismatched order amount).
const SETTLE_TEXT = '0.0495 EURC';
const DEPOSIT_ADDRESS = 'e2e-deposit-address-01';
const SHIFT_ID = 'e2e-shift-9c1d';
const SETTLE_HASH = 'sol-settle-sig-194';
// The EURC destination is a MERGED multi-mechanism group (D2/D4): a composed route
// (ICP → ckUSDC → USDC(Solana) → EURC via jupiter-usdc-eurc) AND the direct cefi venue
// land on the same asset, so the group row carries the route's id and the cefi venue is
// a mechanism sub-pick beside it — the exact pattern the SOL/USDC destinations use.
const EURC_ROW = 'convert-dest-route-multihop:icpswap-ckusdc:2:cctp:jupiter-usdc-eurc';
const EURC_MECH = 'convert-dest-mech-sideshift-eurc';

export const meta = {
  id: '194',
  name: 'convert-cefi-sideshift-eurc',
  journey: 'convert',
  covers: ['convert', 'cefi', 'sideshift', 'eurc', 'eur-rail', 'partner-key', 'relay-proxy',
    'deposit-handoff', 'provider-status', 'venue-vocabulary', 'reload-recovery',
    'no-re-sign', 'disclosure', 'cross-rail'],
  verifies: 'The EUR→IC bridge venue converts ICP to EURC through SideShift (sideshift-eurc): the new cefi venue joins the EURC destination as a second mechanism beside the composed CCTP+jupiter route (explicit sub-pick, nothing auto-quoted), the quote and fixed order ride the relay proxy (upstream calls always credentialed, zero bare, the settle leg rendered in the venue\'s EURC unit), the record parks at awaiting_deposit showing the venue\'s own deposit address and exact amount verbatim with the exchange-service disclosure, nothing is signed and the ICP ledger never moves, status advances device-direct over SideShift\'s keyless GET (waiting → multiple → settled with the venue\'s own figures), and a mid-processing reload resumes without re-creating the order.',
  timeoutMs: 180000,
};

async function relayHits(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/sideshift-upstream/hits`);
  if (!res.ok) throw new Error(`relay stub hits failed (${res.status})`);
  return res.json();
}

/** Re-enter the convert surface from the accounts route (post-terminal trips). */
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

/** One full surface pass: pick the EURC destination group, the SideShift mechanism, quote,
 *  confirm, land at awaiting_deposit. Multi-mechanism group: the group tap reveals the
 *  sub-picker; the cefi venue is an explicit mechanism pick (D5 — nothing auto-quoted). */
async function pickEurcAndConfirm(driver) {
  await driver.type('convert-amount', AMOUNT_TEXT);
  await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
  await driver.click(EURC_ROW, {timeoutMs: 5_000});
  await driver.click(EURC_MECH, {timeoutMs: 5_000});
  await driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
  await driver.waitForText('SideShift', {timeoutMs: 8_000});
  await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
  await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
}

export async function run() {
  const start = Date.now();
  console.log('[194-sideshift-eurc] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;

    console.log('[194-sideshift-eurc] onboarding + funding ICP…');
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-cefi-sideshift-eurc');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
    assert(fund.ok, `faucet ICP credit ok (status ${fund.status})`);

    // The settle address is derived from the wallet's own seed — the venue pays the user's
    // Solana address (the EURC payout lands there; same derivation the SOL rail uses).
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

    // The EURC destination group is offered beside its siblings — the ICP surface now
    // carries THREE cefi-capable destinations (SOL, USDC, EURC). EURC is a MERGED group:
    // the composed CCTP+jupiter route AND the direct cefi venue are two mechanisms of
    // one destination (D4), so the group row is the route's id and selecting it reveals
    // the sub-picker where sideshift-eurc sits beside the route.
    assert(await driver.findByTestID(EURC_ROW, {timeoutMs: 3_000}) != null,
      'the EURC destination group (route + SideShift merged) is offered');
    await driver.click(EURC_ROW);
    assert(await driver.findByTestID(EURC_MECH, {timeoutMs: 4_000}) != null,
      'SideShift is a mechanism inside the merged EURC destination (D2/D4 merge)');
    assertIncludes(await driver.readText(EURC_MECH), 'SideShift', 'the mech row names the venue');
    await driver.click(EURC_MECH);
    const settle = await driver.readText('convert-settle-address');
    assertIncludes(settle, kp.address, 'the payout address is the wallet\'s OWN derived Solana address');
    await driver.waitForText(SETTLE_TEXT, {timeoutMs: 15_000});
    assertIncludes(await driver.readText('convert-quote-source'), 'SideShift', 'the quote is attributed to SideShift');
    // The counterparty + disclosure census folds behind the ONE Details control (as on the
    // sibling rows): open it before pinning them.
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
    await driver.screenshot('194-sideshift-eurc-quote');

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
    await driver.screenshot('194-sideshift-eurc-deposit');

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
    await driver.screenshot('194-sideshift-eurc-processing');

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
    // Let the resumed record poll AT LEAST TWICE while the venue still says 'multiple',
    // BEFORE the 'settled' verdict flips: the harness poll cadence is fast (500ms), so
    // this is bounded and quick — but without it the flip could land on the SECOND
    // post-reload poll, the record reaches done (terminal: the poller retires) after
    // only 2 recorded reads, and the §7 count assert would measure phase timing instead
    // of poller behavior (the exact flake class 0dbac56 fixed in flow 197; observed live
    // 2026-09-21: 1 RED in 2 solo runs at 2 GETs). Sequencing, not sleeping. The stub's
    // counter resets with the page (reinstall above), so these are all post-reload reads.
    await driver.waitForFunction(() => globalThis.__E2E_SIDESHIFT.statusCalls.length >= 2,
      {timeoutMs: 15_000, label: 'post-reload: >=2 keyed status polls observed'});

    // --- §6 settled: the venue's own figures complete the record (EURC settle leg)
    await setSideShiftStatus(driver, 'settled', {settleAmount: '0.0495', settleHash: SETTLE_HASH});
    await driver.findByTestID('convert-done', {timeoutMs: 45_000});
    const done = await driver.readText('convert-done');
    assertIncludes(done, SETTLE_TEXT, 'done reports the VENUE\'s own settle amount in EURC');
    assertIncludes(done, kp.address, 'the payout is named at the user\'s Solana address');
    await driver.screenshot('194-sideshift-eurc-done');

    // --- §7 audits: status keying, no unexpected origins, ledger truth
    const st = await sideShiftStubState(driver);
    assert(st != null, 'sideshift page-stub state present');
    assertEq(st.unexpected.length, 0, `status stub saw no unexpected origins (${st.unexpected.join(', ')})`);
    assert(st.statusCalls.length >= 3, `the provider path polled status (${st.statusCalls.length} GETs: >=2 post-reload multiple-phase polls, then the settled verdict)`);
    for (const c of st.statusCalls) {
      assertEq(c.id, SHIFT_ID, 'every status poll was keyed by the ONE shift id the venue issued');
    }
    hits = await relayHits(r2.baseURL);
    assertEq(hits.bareCalls, 0, 'end-to-end: still ZERO bare upstream calls');
    assertEq(hits.shiftCalls, 1, 'still exactly one order end-to-end');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 8)), BigInt(SEED_ICP),
      'ICP ledger UNCHANGED end-to-end — the deposit is the user\'s own off-app act, dpay moved nothing');

    console.log(`GREEN 194 — ICP→EURC CeFi via SideShift (the EUR→IC bridge's venue): partner key relay-held (${hits.quoteCalls} credentialed quote calls, 0 bare), single-mechanism destination group, deposit handoff verbatim, waiting→multiple→settled with the venue's own EURC figures, reload resumed order-free; ${SETTLE_TEXT} at ${kp.address.slice(0, 8)}… in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 194:', e);
    process.exit(1);
  });
}
