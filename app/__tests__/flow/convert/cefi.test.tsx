/**
 * cefi — the jest twins of e2e/tests/{187,194,207,208}-convert-*.mjs (M2 batch C).
 *
 * Flow 187 convert-cefi-sideshift — ICP → SOL through SideShift, the partner key held on the
 *   relay: quotes/orders ride the relay proxy (ZERO bare upstream calls, the secret never in
 *   the UI), the record parks at awaiting_deposit with the venue's OWN deposit address + exact
 *   amount verbatim and the handoff copy (venue holds funds, dpay not a party), nothing signed
 *   (ICP unchanged), status advances device-direct over the keyless GET (waiting → multiple →
 *   settled with the venue's own figures; expired and refunded dead-ends), and a mid-processing
 *   reload resumes WITHOUT re-creating the order.
 * Flow 194 convert-cefi-sideshift-eurc — the EUR→IC bridge venue (sideshift-eurc) on the same
 *   fixture pattern: the settle leg rendered in EURC, the composed route behind the expander,
 *   reload resume, post-reload poll sequencing before the settled verdict.
 * Flow 207 convert-trocador-no-quote — the honest LISTED-BUT-UNQUOTED state: a distinct
 *   attributed line (venue named, nothing sent, way out), never the generic red error, no
 *   receive figure, confirm withheld, ZERO trades created, and the sibling mechanism still
 *   quotes.
 * Flow 208 convert-cefi-lifecycle — expired is a WATCH not the end (the slow poll keeps
 *   running and the venue's later refunded word lands on its own), the honest last-checked
 *   line on processing, and the deposit handoff naming the shift id + expiry window.
 *
 * The relay upstream's counters accumulate for the process — count asserts are DELTAS against
 * a per-test baseline (the e2e own-relay isolation, re-expressed; gap filed).
 */
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openConvertFor,
  typeConvertAmount, pickSwapTarget, openOtherVenues, fmtHero, isDisabled,
} from '../harness/lib';
import {
  disposeConvertStubs, installSideShiftStub, setSideShiftStatus, sideShiftStubState,
  sideshiftRelayHits, trocadorConfig, trocadorRelayHits, enableSolRail, installSolRpcStub,
  deriveSolanaKeypair,
} from './convertStubs';

const DEPOSIT_ADDRESS = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // the stub's valid ICRC-1 account text
const SHIFT_ID = 'e2e-shift-9c1d';
const SEED_ICP = 2000000000; // 20 ICP

afterEach(() => {
  disposeConvertStubs();
});

/** confirmCefi — press the CTA and wait for the awaiting panel; a moved-quote interrupt gets
 *  the e2e re-review treatment (one extra press, only when the sheet says the rate moved), and
 *  a press that never took (swallowed by a surface transition) is issued once more. */
async function confirmCefi(m: Awaited<ReturnType<typeof onboardWallet>>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    const deadline = Date.now() + 8_000;
    for (;;) {
      if (m.driver.isPresent('convert-awaiting-deposit')) return;
      const moved = m.driver.readTextSafe('convert-moved-note') != null;
      if (moved || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (m.driver.readTextSafe('convert-moved-note') == null && m.driver.isPresent('convert-awaiting-deposit')) return;
  }
  await awaitDepositPanel(m);
}

/** awaitDepositPanel — the awaiting-deposit wait with an on-failure screen dump. */
async function awaitDepositPanel(m: Awaited<ReturnType<typeof onboardWallet>>): Promise<void> {
  try {
    await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
  } catch (e) {
    console.log('    [cefi-dbg] body:', JSON.stringify(m.driver.bodyText()).slice(0, 1500));
    throw e;
  }
}

describe('flow 187 — ICP → SOL via SideShift: partner key relay-held, deposit handoff, venue status', () => {
  it('hands off verbatim, advances on the venue\'s own word, resumes order-free, dead-ends honestly', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-cefi-sideshift');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      const kp = deriveSolanaKeypair(account!.secretHex);
      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await sideshiftRelayHits();

      // §1 the disclosed pick, the disclosure, and the verbatim quote.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the pick line names the venue');
      await openOtherVenues(m);
      expect(m.driver.isPresent('convert-venues-expanded')).toBe(true);
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-settle-address'), kp.address, 'the payout address is the wallet\'s OWN derived Solana address');
      expect(await m.driver.waitForText('0.0495 SOL', {timeoutMs: 15_000})).toBe(true);
      assertIncludes(m.driver.readText('convert-quote-source'), 'SideShift', 'the quote is attributed to SideShift');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-counterparty'), {timeoutMs: 15_000, label: 'the census mounted'});
      const counterparty = m.driver.readText('convert-counterparty');
      assertIncludes(counterparty, 'SideShift', 'the counterparty line names the venue');
      assertIncludes(counterparty, 'automated exchange service', 'the cefi copy says what the venue IS');
      assertIncludes(counterparty, 'Nothing is signed on this phone', 'the phone signs nothing — the user deposits to the venue themselves');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'sideshift.ai/terms', 'the venue\'s OWN published terms link renders');
      assertIncludes(disclosure, 'not a licensed provider', 'the disclosure says what the venue is NOT');

      // §2 confirm: order created through the relay; the deposit handoff renders verbatim.
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS, 'the venue\'s deposit address renders VERBATIM');
      const handoff = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(handoff, '3', 'the EXACT deposit amount renders');
      assertIncludes(handoff, 'holds', 'the handoff copy says the venue holds funds mid-trade');
      assertIncludes(handoff, 'not a party', 'dpay names itself a non-party');

      // §3 the partner-key audit: credentialed upstream calls only, one order so far.
      let hits = await sideshiftRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.shiftCalls - hits0.shiftCalls).toBe(1);
      expect(hits.quoteCalls - hits0.quoteCalls).toBeGreaterThanOrEqual(2);
      expect(handoff.includes('e2e-stub-partner-secret')).toBe(false);

      // 'waiting' is steady-state: still awaiting_deposit a beat later (no false transition).
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);

      // §4 processing: the venue's own word drives the record.
      setSideShiftStatus('multiple');
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});

      // §5 reload mid-processing: resume WITHOUT re-creating the order.
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
      expect(shiftsBefore - hits0.shiftCalls).toBe(1);
      await m.remount();
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);

      // §6 settled: the venue's own figures complete the record.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-settle-sig-187'});
      await m.driver.findByTestID('convert-done', {timeoutMs: 45_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495 SOL', 'done reports the VENUE\'s own settle amount');
      assertIncludes(done, kp.address, 'the payout is named at the user\'s Solana address');

      // §7 the expired dead-end (a second order, born waiting, driven to expiry).
      await m.driver.click('btn-convert-back', {timeoutMs: 5_000});
      setSideShiftStatus('waiting');
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      setSideShiftStatus('expired');
      await m.driver.findByTestID('convert-quote-expired', {timeoutMs: 45_000});
      assertIncludes(m.driver.readText('convert-quote-expired'), 'expired', 'the expired dead-end says expired');

      // §8 the refunded dead-end (a third order, refunded by the venue).
      await m.driver.click('btn-convert-back', {timeoutMs: 5_000});
      setSideShiftStatus('waiting');
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      setSideShiftStatus('refunded');
      await m.driver.findByTestID('convert-provider-refunded', {timeoutMs: 45_000});
      assertIncludes(m.driver.readText('convert-provider-refunded'), 'SideShift', 'the refund dead-end names the venue that holds the remedy');

      // §9 audits: status keying, no unexpected origins, ledger truth.
      const st = sideShiftStubState();
      expect(st).not.toBeNull();
      expect(st!.unexpected.length).toBe(0);
      expect(st!.statusCalls.length).toBeGreaterThanOrEqual(3);
      for (const c of st!.statusCalls) {
        expect(c.id).toBe(SHIFT_ID);
      }
      hits = await sideshiftRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.shiftCalls - hits0.shiftCalls).toBe(3);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 194 — ICP → EURC via sideshift-eurc (the EUR→IC bridge\'s venue)', () => {
  it('sub-picks the cefi venue in the EURC group, hands off verbatim, resumes, settles in EURC', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The EUR target needs the EURC(Solana) rail in the wallet's asset list.
      await enableSolRail();
      m = await onboardWallet('jest-cefi-sideshift-eurc');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      const kp = deriveSolanaKeypair(account!.secretHex);
      installSolRpcStub({refuseSend: true});
      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await sideshiftRelayHits();

      // §1 the EUR pair: the SideShift venue is the only device-signable row → auto-picked;
      // the composed CCTP+jupiter route is the explicit opt-in row behind the expander.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'EUR');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the pick line names the CeFi venue');
      await openOtherVenues(m);
      expect(await m.driver.findByTestID('convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter-usdc-eurc', {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(true);
      assertIncludes(m.driver.readText('convert-settle-address'), kp.address, 'the payout address is the wallet\'s OWN derived Solana address');
      expect(await m.driver.waitForText(`≈ ${fmtHero('49500', 6, 'EURC', {stable: true})}`, {timeoutMs: 15_000})).toBe(true);
      assertIncludes(m.driver.readText('convert-quote-source'), 'SideShift', 'the quote is attributed to SideShift');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-quote-verbatim'), {timeoutMs: 15_000, label: 'the census mounted'});
      assertIncludes(m.driver.readText('convert-quote-verbatim'), '0.0495 EURC', 'Details carries SideShift\'s verbatim quoted settle figure');
      const counterparty = m.driver.readText('convert-counterparty');
      assertIncludes(counterparty, 'SideShift', 'the counterparty line names the venue');
      assertIncludes(counterparty, 'automated exchange service', 'the cefi copy says what the venue IS');
      assertIncludes(counterparty, 'Nothing is signed on this phone', 'the phone signs nothing');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'sideshift.ai/terms', 'the venue\'s OWN published terms link renders');
      assertIncludes(disclosure, 'not a licensed provider', 'the disclosure says what the venue is NOT');

      // §2 confirm → the deposit handoff verbatim.
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS, 'the venue\'s deposit address renders VERBATIM');
      const handoff = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(handoff, '3', 'the EXACT deposit amount renders');
      assertIncludes(handoff, 'holds', 'the handoff copy says the venue holds funds mid-trade');
      assertIncludes(handoff, 'not a party', 'dpay names itself a non-party');

      // §3 the partner-key audit.
      let hits = await sideshiftRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.shiftCalls - hits0.shiftCalls).toBe(1);
      expect(hits.quoteCalls - hits0.quoteCalls).toBeGreaterThanOrEqual(2);
      expect(handoff.includes('e2e-stub-partner-secret')).toBe(false);

      // Steady waiting, then processing.
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);
      setSideShiftStatus('multiple');
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});

      // §5 reload mid-processing: resume WITHOUT re-creating the order; let the resumed record
      // poll AT LEAST TWICE before the settled verdict flips (sequencing, not sleeping).
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
      await m.remount();
      installSideShiftStub({initialStatus: 'multiple'});
      await openConvertFor(m, 'icp');
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);
      await m.driver.waitForFunction(
        () => (sideShiftStubState()?.statusCalls.length ?? 0) >= 2,
        {timeoutMs: 15_000, label: 'post-reload: >=2 keyed status polls observed'},
      );

      // §6 settled: the venue's own figures complete the record (EURC settle leg).
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-settle-sig-194'});
      await m.driver.findByTestID('convert-done', {timeoutMs: 45_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495 EURC', 'done reports the VENUE\'s own settle amount in EURC');
      assertIncludes(done, kp.address, 'the payout is named at the user\'s Solana address');

      // §7 audits.
      const st = sideShiftStubState();
      expect(st).not.toBeNull();
      expect(st!.unexpected.length).toBe(0);
      expect(st!.statusCalls.length).toBeGreaterThanOrEqual(3);
      for (const c of st!.statusCalls) {
        expect(c.id).toBe(SHIFT_ID);
      }
      hits = await sideshiftRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.shiftCalls - hits0.shiftCalls).toBe(1);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 207 — the trocador listed-but-unquoted verdict renders as the attributed no-quote line', () => {
  it('names the venue + the way out, withholds confirm, creates nothing, sibling still quotes', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-trocador-no-quote');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      // The sideshift half quotes through the relay; its status read is keyless device-direct.
      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await trocadorRelayHits();

      // §1 the SOL pair's venue area: BOTH CeFi services as rows.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-venues', {timeoutMs: 8_000});
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the registry-first venue is the auto pick (disclosed)');
      await openOtherVenues(m);
      expect(m.driver.isPresent('convert-venue-trocador')).toBe(true);

      // §2 the armed no-quote venue answers; the surface names it honestly.
      await trocadorConfig({no_quote: true});
      await m.driver.click('convert-venue-trocador', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-no-quote', {timeoutMs: 20_000});
      const noQuoteText = m.driver.readText('convert-no-quote');
      assertIncludes(noQuoteText, 'Trocador', 'the line attributes the verdict to the VENUE');
      assertIncludes(noQuoteText, 'no live market', 'the line says the venue has no live market right now');
      assertIncludes(noQuoteText, 'Nothing was sent', 'the line states the fail-closed fact first');
      assertIncludes(noQuoteText, 'Pick another venue or try again later', 'the line names the way out');
      expect(m.driver.isPresent('convert-quote-err')).toBe(false);
      const receiveText = m.driver.readText('convert-receive');
      expect(/\d/.test(receiveText.replace('1%', ''))).toBe(false);
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(true);

      // §3 fail-closed audit: the quote was asked, nothing was created.
      const hits = await trocadorRelayHits();
      expect(hits.rateCalls - hits0.rateCalls).toBeGreaterThanOrEqual(1);
      expect(hits.tradeCalls - hits0.tradeCalls).toBe(0);
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      assertIncludes(hits.lastQuery ?? '', 'markup=0', 'the no-dpay-cut pin rode the quote');
      assertIncludes(hits.lastQuery ?? '', 'best_only=True', 'the aggregator\'s one-quote pin rode the quote');

      // §4 the sibling mechanism is unaffected: sideshift quotes normally.
      await m.driver.click('convert-venue-sideshift', {timeoutMs: 5_000});
      expect(m.driver.isPresent('convert-no-quote')).toBe(false);
      await m.driver.findByTestID('convert-headline', {timeoutMs: 20_000});
      assertIncludes(m.driver.readText('convert-headline'), '0.0495 SOL', 'the sideshift quote renders verbatim');
      assertIncludes(m.driver.readText('convert-quote-source'), 'SideShift', 'the quote is attributed to the sibling venue');
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});

describe('flow 208 — the CeFi lifecycle is honest past quote expiry', () => {
  it('watches through expiry, lands the venue\'s refunded word on its own, shows last-checked', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-cefi-lifecycle');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await sideshiftRelayHits();

      // §1 the order is born into waiting; the handoff names the shift id + expiry window.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      expect(await m.driver.waitForText('SideShift', {timeoutMs: 8_000})).toBe(true);
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      const handoff = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(handoff, SHIFT_ID, 'the venue\'s shift id renders (the status-page handle)');
      assertIncludes(handoff, 'expires', 'the order\'s own expiry window renders beside it');

      // §2 expired: a watch, not a verdict.
      setSideShiftStatus('expired');
      await m.driver.findByTestID('convert-quote-expired', {timeoutMs: 45_000});
      const expired = m.driver.readText('convert-quote-expired');
      expect(expired.includes('expired')).toBe(true);
      assertIncludes(expired, 'returns it', 'the copy says the venue RETURNS a late deposit');
      assertIncludes(expired, 'keeps watching', 'the copy says dpay keeps watching in the background');
      expect(expired.includes('nothing needs reversing')).toBe(false);

      // §3 the slow watch is live: the status counter grows past the expiry.
      const pollsAtExpiry = sideShiftStubState()!.statusCalls.length;
      await m.driver.waitForFunction(
        () => (sideShiftStubState()?.statusCalls.length ?? 0) > pollsAtExpiry,
        {timeoutMs: 20_000, label: 'the quote_expired slow watch polls again'},
      );
      expect(m.driver.isPresent('convert-quote-expired')).toBe(true);

      // §4 the venue's later word lands: refunded after expiry → provider_refunded, on its own.
      setSideShiftStatus('refunded');
      await m.driver.findByTestID('convert-provider-refunded', {timeoutMs: 30_000});
      assertIncludes(m.driver.readText('convert-provider-refunded'), 'SideShift', 'the refund card names the venue that holds the remedy');
      const polls = sideShiftStubState()!.statusCalls;
      expect(polls.every((c) => c.id === SHIFT_ID)).toBe(true);

      // §5 the honest wait line: provider_processing shows "Last checked HH:MM" (no SLA).
      await m.driver.click('btn-convert-back', {timeoutMs: 5_000});
      setSideShiftStatus('waiting');
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '3');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      await confirmCefi(m);
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      setSideShiftStatus('multiple');
      await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
      await m.driver.findByTestID('convert-last-checked', {timeoutMs: 20_000});
      expect(/Last checked \d{1,2}:\d{2}/.test(m.driver.readText('convert-last-checked'))).toBe(true);

      const hits = await sideshiftRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.shiftCalls - hits0.shiftCalls).toBe(2);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});
