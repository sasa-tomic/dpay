// Flow 207 — the honest LISTED-BUT-UNQUOTED state: the trocador venue carries the pair
// but has no live market right now (the venue's own "no resulting quote", live-measured
// 2026-09-22 while /coins still listed ICP). This is a COVERAGE state of the venue, not
// a failure of dpay — so the surface must NOT render a generic red quote error. It renders
// a distinct attributed line: the venue's name, the fact that nothing was sent, and the
// way out (pick another venue or come back later).
//
// Mechanically, on the IC surface's merged ICP→SOL cefi group (sideshift + trocador):
//
//   1. The armed stub answers the venue's own 400 body verbatim through the relay —
//      the adapter's client types it 'noquote', and the screen shows the no-quote
//      verdict, never the red error, with no headline quote.
//   2. FAIL-CLOSED: no trade is ever created for an unquoted pair (stub audit).
//   3. The sibling mechanism (sideshift) stays fully pickable and quotes normally —
//      the no-quote verdict is about ONE venue's live market, never the destination.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency, openConvertFor,
  pickSwapTarget,
  pickSwapVenue,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {installSideShiftStub} from '../harness/sideshift.mjs';

const SEED_ICP = 2000000000; // 20 ICP
const AMOUNT_TEXT = '2';
// The sideshift stub's deterministic figure (src/app.rs sideshift_stub_*): a fixed
// 0.0495 settle for any pair, rendered in the settle asset's own unit — SOL here.
const SETTLE_TEXT = '0.0495 SOL';
// The merged landing spot for ICP→SOL: the composed CCTP+jupiter route forms the group
// (its route testID is the group's identity) and the cefi venues merge into it (D4) —
// the exact group flow 187 drives. The sub-picker picks the SERVICE (D2/D5 — nothing
// auto-quoted in a multi-mechanism group).
const TROCADOR_MECH = 'convert-venue-trocador';
const SIDESHIFT_MECH = 'convert-venue-sideshift';

export const meta = {
  id: '207',
  name: 'convert-trocador-no-quote',
  journey: 'convert',
  covers: ['convert', 'cefi', 'venue:trocador', 'no-quote', 'fail-closed', 'aggregator', 'same-surfaces'],
  verifies: 'When Trocador answers its own "no resulting quote" (the pair is listed on the venue but no provider is quoting it right now — live-measured 2026-09-22), the convert surface renders a distinct attributed no-quote line naming the venue, stating nothing was sent, and naming the way out — never the generic red quote error and never a quote headline. Nothing is created at the venue for an unquoted pair (zero trade calls, zero keyless calls), and the sibling mechanism (SideShift) on the same destination stays pickable and quotes normally, so the verdict reads as one venue\'s live-market state, not a broken destination.',
  timeoutMs: 180000,
};

async function relayHits(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/trocador-upstream/hits`);
  if (!res.ok) throw new Error(`relay stub hits failed (${res.status})`);
  return res.json();
}

async function armStub(relayBaseURL, state) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/trocador-upstream/config`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`relay stub arm failed (${res.status})`);
}

export async function run() {
  const env = await setup();
  // OWN relay: the trocador stub is SERVER-side state on the relay this page dials, and
  // the setup relay is SHARED across lanes (the flow-194/198 isolation rule).
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-trocador-no-quote');

    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
    assert(fund.ok, `faucet ICP credit ok (status ${fund.status})`);

    // The sideshift half of the merged group quotes through the relay; its STATUS read is
    // keyless device-direct (page-scoped stub, the flow-194 pattern). This flow never
    // confirms, so only the status stub is needed.
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});

    // --- §1 the SOL pair's venue area: BOTH CeFi services as rows (registry order, nothing
    // preselected — the sub-picker is gone, each service IS a row).
    await openConvertFor(driver, 'icp');
    await pickSwapTarget(driver, 'SOL');
    assert(await driver.findByTestID('convert-screen', {timeoutMs: 8_000}) != null, 'the IC convert surface opens for ICP');
    await driver.type('convert-amount', AMOUNT_TEXT);
    assert(await driver.findByTestID('convert-venues', {timeoutMs: 8_000}) != null, 'the venue area renders for the SOL pair');
    assert(await driver.findByTestID(SIDESHIFT_MECH, {timeoutMs: 3_000}) != null, 'the registry-first venue is offered');
    assert(await driver.findByTestID(TROCADOR_MECH, {timeoutMs: 3_000}) != null, 'the trocador aggregator is offered beside it');

    // --- §2 the armed no-quote venue answers; the surface names it honestly
    await armStub(r2.baseURL, {no_quote: true});
    await driver.click(TROCADOR_MECH, {timeoutMs: 5_000});
    const noQuote = await driver.findByTestID('convert-no-quote', {timeoutMs: 20_000});
    assert(noQuote != null, 'the attributed no-quote line renders');
    const noQuoteText = await driver.readText('convert-no-quote');
    assertIncludes(noQuoteText, 'Trocador', 'the line attributes the verdict to the VENUE');
    assertIncludes(noQuoteText, 'no live market', 'the line says the venue has no live market right now');
    assertIncludes(noQuoteText, 'Nothing was sent', 'the line states the fail-closed fact first');
    assertIncludes(noQuoteText, 'Pick another venue or try again later', 'the line names the way out');
    assert(await driver.findByTestID('convert-quote-err', {timeoutMs: 1_000}).catch(() => null) == null,
      'NOT a generic red quote error — the state carries its own attributed line');
    assert(await driver.findByTestID('convert-headline', {timeoutMs: 1_000}).catch(() => null) == null,
      'no receive headline — there is no quote to show');
    const confirmDisabled = await driver.eval((t) => {
      const el = document.querySelector(`[data-testid="${t}"]`);
      return el ? el.getAttribute('aria-disabled') : null;
    }, 'btn-convert-confirm');
    assert(confirmDisabled === 'true', 'confirm is withheld on an unquoted pair — nothing can be created');
    // The shot pins the LINE itself (scroll it into the viewport — the picker fills the fold).
    await driver.eval((t) => {
      document.querySelector(`[data-testid="${t}"]`)?.scrollIntoView({block: 'center'});
    }, 'convert-no-quote');
    await driver.screenshot('207-trocador-no-quote');

    // --- §3 fail-closed audit: the quote was asked, nothing was created
    const hits = await relayHits(r2.baseURL);
    assert(hits.rateCalls >= 1, `the venue was actually asked (rate calls: ${hits.rateCalls})`);
    assertEq(hits.tradeCalls, 0, 'ZERO trade creations for an unquoted pair');
    assertEq(hits.bareCalls, 0, 'no keyless upstream call — the key attaches server-side as always');
    const lastQuery = hits.lastQuery ?? '';
    assertIncludes(lastQuery, 'markup=0', 'the no-dpay-cut pin rode the quote');
    assertIncludes(lastQuery, 'best_only=True', 'the aggregator\'s one-quote pin rode the quote');

    // --- §4 the sibling mechanism is unaffected: sideshift quotes normally
    await driver.click(SIDESHIFT_MECH, {timeoutMs: 5_000});
    assert(await driver.findByTestID('convert-no-quote', {timeoutMs: 1_000}).catch(() => null) == null,
      'the no-quote verdict clears with the venue pick');
    assert(await driver.findByTestID('convert-headline', {timeoutMs: 20_000}) != null, 'the sibling venue quotes');
    assertIncludes(await driver.readText('convert-headline'), SETTLE_TEXT, 'the sideshift quote renders verbatim');
    assertIncludes(await driver.readText('convert-quote-source'), 'SideShift', 'the quote is attributed to the sibling venue');
    await driver.screenshot('207-sideshift-still-quotes');

    console.log(`GREEN 207 — the trocador listed-but-unquoted verdict renders as the attributed no-quote line (venue named, nothing sent, way out stated), never a generic error; zero trades created; the sideshift mechanism on the same destination quotes untouched`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 207:', e);
    process.exit(1);
  });
}
