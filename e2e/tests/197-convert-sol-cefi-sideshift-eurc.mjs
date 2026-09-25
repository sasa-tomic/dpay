// Flow 197 — the SAME UI surfaces on the OTHER rail: EURC(Solana) → ICP through SideShift,
// driven from the SOL convert surface (registered 2026-09-19; the founder's same-surfaces
// rule — per-rail divergence is a bug).
//
// Flow 194 pins the IC-side direction (ICP in, EURC out at the wallet's derived Solana
// address). This flow pins the MIRROR direction, which the SOL surface could not even
// RENDER before 2026-09-20: its destination picker walked solana_amm venues only, so
// every registered cefi row was invisible SOL-side. What must be true now:
//
//   1. THE DESTINATION PICKER OFFERS THE CEFI VENUE BESIDE THE IN-WALLET SPL GROUP —
//      EURC(Solana) shows the amm USDC row AND 'ICP — via SideShift (exchange service)'.
//   2. THE DEPOSIT LEG IS A HANDOFF, NOT A SIGNED TX: the payout target is the user's OWN
//      derived IC account identifier — the 64-hex account hash of the wallet's principal,
//      the form the venue's ICP payout layer can deliver to (it cannot pay principal-format
//      addresses; SideShift engineering 2026-09-21) — nothing typed, nothing entrusted,
//      shown BEFORE the order; confirming locks the fixed ORDER; the user then sends an
//      SPL transfer THEMSELVES. Nothing is ever broadcast on the SOL rail by the app
//      (unlike the Jupiter flows).
//   3. NO EXACT-MATCH GATE: the venue's rate may tick between review and confirm — the
//      ORDER is the lock (flow 187's static stub was blind to this; the defect that
//      livelocked the IC confirm).
//   4. THE FULL PROVIDER LIFECYCLE on the SOL surface: awaiting_deposit → (venue
//      processing) → done with the realized settle + payout address — the generic
//      provider panel, rail-agnostic, plus the SOL-rail deposit-fee note.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, openBalances, openConvertFor, pickSwapTarget} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {deriveSolanaKeypair} from '../harness/jupiter.mjs';
import {icpAccountIdentifierHex} from '../harness/wire.mjs';
import {installSideShiftStub, setSideShiftStatus, sideShiftStubState} from '../harness/sideshift.mjs';

const AMOUNT_TEXT = '2';
// The relay stub's deterministic venue figures (src/app.rs sideshift_stub_*): the quote is
// a FIXED 0.0495 settle for any pair — here rendered in ICP (the settle side of THIS pair,
// 8 decimals) — and the order ECHOES the quote's depositAmount (quote-derived, never a
// default; the app's prepare red line refuses a mismatched order amount).
const SETTLE_TEXT = '0.0495 ICP';
const DEPOSIT_ADDRESS = 'e2e-deposit-address-01';
const SHIFT_ID = 'e2e-shift-9c1d';
const SETTLE_HASH = 'ic-settle-sig-197';

export const meta = {
  id: '197',
  name: 'convert-sol-cefi-sideshift-eurc',
  journey: 'convert',
  covers: ['convert', 'solana-rail', 'venue:sideshift-eurc', 'cefi', 'same-surfaces', 'deposit-handoff',
    'derived-payout-address', 'order-locks-quote', 'reload-recovery', 'cross-rail'],
  verifies: 'With the cefi venue sideshift-eurc registered (ICP<->EURC(Solana)) the SOL convert surface for EURC offers BOTH destination groups: the in-wallet SPL USDC row and the cefi ICP row (same surfaces as the IC side). Picking the cefi row shows the user\'s OWN derived IC account identifier (the 64-hex account hash of the wallet\'s principal — the form the venue\'s ICP payout layer requires; it cannot pay principal-format addresses) as the payout address BEFORE any order, quotes verbatim through the relay partner-key proxy (estimate, SideShift attribution, no slippage axis — the rate is locked at order), confirms to a fixed ORDER without an exact-match gate against the ticking venue quote, and lands at the deposit handoff: the venue\'s own deposit address verbatim, the exact deposit amount, the SOL-side network-fee note, nothing signed or broadcast on the SOL rail. The provider lifecycle then drives awaiting_deposit → processing → done with the realized settle and the payout-at-own-address line, surviving a page reload on the persisted record.',
  timeoutMs: 180000,
};

async function relayHits(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/sideshift-upstream/hits`);
  if (!res.ok) throw new Error(`relay stub hits failed (${res.status})`);
  return res.json();
}

/** Same SOL-rail balance simulator as flows 185/189/193 — see flow 189 for the why.
 *  No broadcast is ever expected on this flow; the stub exists so the surface can read
 *  the wallet's EURC(Solana) balance honestly. */
async function installSolRpcStub(driver) {
  await driver.eval(() => {
    globalThis.__E2E_SOL_SENT = [];
    globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2500000', decimals: 6}}),
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      getFeeForMessage: () => ({context: {slot: 250000000}, value: {lamports: 5000}}),
      sendTransaction: () => { throw new Error('NO BROADCAST: the cefi deposit is a handoff, the app never sends'); },
      getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
      getBlockHeight: () => 250000000,
      getTransaction: () => ({meta: {err: null}, slot: 250000000, blockTime: 1700000000}),
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  });
}

/** Enter the EURC(Solana) convert surface from the accounts route (standing target). */
async function openEurcConvert(driver) {
  await openConvertFor(driver, 'sol-eurc', {timeoutMs: 8_000});
}
// NOTE: on a LIVE record (the §6 reload resume) the record view replaces the form — the entry
// helper returns with that panel up; the pick gestures below are form-only.

export async function run() {
  const env = await setup({solStub: true});
  // OWN relay: the sideshift stub is SERVER-side state on the relay this page dials, and
  // the setup relay is SHARED across lanes — two cefi flows running concurrently would
  // write into each other's stub (same isolation flow 194 opts into).
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-sol-cefi-sideshift-eurc');

    const id = await accountOf(driver);
    assert(id != null && typeof id.secretHex === 'string', 'onboarded identity carries the secret');
    const kp = deriveSolanaKeypair(id.secretHex);
    assert(kp.address.length >= 32, 'the wallet\'s SOL address derives from the same key (provenance)');

    await installSolRpcStub(driver);
    // The STATUS half is page-scoped (quotes/orders ride the real relay route untouched).
    // passOrigins: the relay + web + default-relay origins — NOT sideshift.ai itself.
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});

    // --- §1 the target list: the standing target is stable-first USD (the 2026-09-25 founder
    // rule), and the ICP target carries the cefi venue — the SAME surfaces the IC source sees.
    await openEurcConvert(driver);
    assert(await driver.findByTestID('convert-screen', {timeoutMs: 8_000}) != null, 'Convert surface opens for EURC(Solana)');
    assert(await driver.findByTestID('convert-unavailable', {timeoutMs: 500}).catch(() => null) == null,
      'the EURC source is paired (no fail-closed panel)');
    assertIncludes(await driver.readText('convert-screen'), 'Convert EUR → USD', 'the standing pair is EUR→USD (stable-first, no surprise preselection)');

    // --- §2 the cefi target: derived payout address FIRST, venue quote verbatim
    await pickSwapTarget(driver, 'ICP');
    assertIncludes(await driver.readText('convert-screen'), 'Convert EUR → ICP', 'the heading names the picked pair');
    await driver.type('convert-amount', AMOUNT_TEXT);
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    assertIncludes(await driver.readText('convert-headline'), SETTLE_TEXT, 'receive estimate is the venue settle figure verbatim');
    assertIncludes(await driver.readText('convert-quote-source'), 'SideShift', 'attribution names the venue');
    assertIncludes(await driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
    const settle = await driver.readText('convert-settle-address');
    const expectSettleId = icpAccountIdentifierHex(id.publicHex);
    assertEq(settle, expectSettleId,
      'the payout target is the wallet\'s OWN derived IC account identifier (the 64-hex form the venue\'s ICP payout layer requires — it cannot pay principal-format addresses), shown before any order');
    assert(await driver.findByTestID('convert-slippage', {timeoutMs: 1_000}).catch(() => null) == null,
      'no slippage axis — a fixed shift locks its rate at order creation (the IC cefi rule)');
    assert(await driver.findByTestID('convert-min-out', {timeoutMs: 1_000}).catch(() => null) == null,
      'no min-out line — the locked settle figure IS the floor (the IC cefi rule)');
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('convert-counterparty'), 'SideShift', 'counterparty line names the venue');
    assertIncludes(await driver.readText('convert-counterparty'), 'automated exchange service', 'not a licensed provider');
    assertIncludes(await driver.readText('convert-counterparty'), 'Nothing is signed on this phone', 'the cefi signing sentence: the deposit is a handoff');
    assertIncludes(await driver.readText('convert-venue-disclosure'), 'sideshift.ai/terms', 'the venue disclosure is present');
    assert(await driver.findByTestID('convert-pool-principal', {timeoutMs: 1_000}).catch(() => null) == null,
      'no pool-principal line on cefi (the IC cefi rule: the venue API base is not depositor-checkable)');
    await driver.screenshot('197-sol-cefi-eurc-checklist');

    // --- §3 confirm → the fixed ORDER is the lock; the handoff is the venue's address
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    assert(await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}) != null, 'the record lands at awaiting_deposit');
    assertIncludes(await driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS, 'the venue deposit address renders verbatim');
    const handoff = await driver.readText('convert-deposit-handoff');
    assertIncludes(handoff, '2 EURC', 'the exact deposit amount renders in the deposit asset');
    assertIncludes(handoff, 'exactly the deposit amount', 'the handoff says what to send');
    assertIncludes(handoff, 'not a party', 'dpay party-hood denied');
    assert(await driver.findByTestID('convert-deposit-sol-fee-note', {timeoutMs: 3_000}) != null,
      'the SOL-rail deposit-fee note is present (the deposit is an SPL transfer the USER sends)');
    assert(await driver.waitForText('Converted', {timeoutMs: 1_000}).catch(() => false) === false, 'nothing is "done" — the venue holds nothing yet');
    const sent = await driver.eval(() => globalThis.__E2E_SOL_SENT);
    assertEq(sent.length, 0, 'NOTHING was ever broadcast on the SOL rail — the deposit is a handoff');
    await driver.screenshot('197-sol-cefi-eurc-awaiting-deposit');

    // --- §4 the partner-key audit: quotes/orders THROUGH the relay proxy, status device-direct
    const hits = await relayHits(r2.baseURL);
    assertEq(hits.bareCalls, 0, 'no bare (keyless) relay upstream calls');
    assertEq(hits.shiftCalls, 1, 'exactly one fixed-order creation (the confirm)');
    assert(hits.quoteCalls >= 2, `at least the review + confirm quotes rode the proxy (saw ${hits.quoteCalls})`);

    // --- §5 the provider lifecycle: waiting steady-state, then venue processing
    await new Promise((r) => setTimeout(r, 2_500));
    assert(await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 2_000}) != null, 'steady while the venue waits');
    await setSideShiftStatus(driver, 'multiple');
    assert(await driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}) != null, 'the venue\'s own status drives processing (keyless, device-direct)');

    // --- §6 reload resume: the persisted record re-enters the provider panel
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'multiple'}); // page stubs die with the page
    await openEurcConvert(driver);
    assert(await driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}) != null, 'the record resumes from storage');
    const shiftsAfter = (await relayHits(r2.baseURL)).shiftCalls;
    assertEq(shiftsAfter, 1, 'the resume created NO second order');
    // Let the resumed record poll AT LEAST TWICE before the venue's verdict flips: the
    // harness poll cadence is fast (500ms), so this is bounded and quick — but without it
    // the 'settled' flip could land on the FIRST post-reload poll, the record reaches done
    // (terminal: the poller retires) after only 2 recorded reads, and the §7 count assert
    // would measure phase timing instead of poller behavior. Sequencing, not sleeping.
    await driver.waitForFunction(() => globalThis.__E2E_SIDESHIFT.statusCalls.length >= 2,
      {timeoutMs: 15_000, label: 'post-reload: >=2 keyed status polls observed'});

    // --- §7 settle → done with the realized figures at the user's own address
    await setSideShiftStatus(driver, 'settled', {settleAmount: '0.0495', settleHash: SETTLE_HASH});
    assert(await driver.waitForText('Converted', {timeoutMs: 45_000}), 'the venue settle drives the record to done');
    const done = await driver.readText('convert-done');
    assertIncludes(done, SETTLE_TEXT, 'done reports the realized settle figure');
    assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
    assertIncludes(done, settle.slice(0, 12), 'the payout address IS the derived IC account identifier');
    const stub = await sideShiftStubState(driver);
    assert(stub != null && stub.unexpected.length === 0, 'no unexpected status origins (the status never touched the relay)');
    assert((stub.statusCalls ?? []).length >= 3, `the status poll keyed every read by the order id (${(stub.statusCalls ?? []).length} GETs: waiting-phase read, >=2 post-reload polls, then the settled verdict)`);
    for (const c of stub.statusCalls ?? []) {
      assertEq(c.id, SHIFT_ID, 'every status poll was keyed by the ONE shift id the venue issued');
    }
    await driver.screenshot('197-sol-cefi-eurc-done');

    console.log(`GREEN 197 — EURC(Solana)→ICP via sideshift-eurc from the SOL surface: both dest groups offered, payout at the derived IC account identifier, order locked the figures (no exact-match gate), deposit handoff only (0 broadcasts), lifecycle waiting→processing→done with reload resume`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 197:', e);
    process.exit(1);
  });
}
