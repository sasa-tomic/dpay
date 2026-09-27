/**
 * convert-core — the jest twins of e2e/tests/{141,143,145,169}-convert-*.mjs (M2 batch C).
 *
 * Flow 141 convert-pending-withdrawal — the pool's #ok with a held withdrawal (fail_withdrawal
 *   knob) is an HONEST pending_withdrawal screen, never a fabricated done; settle_pending
 *   drains the venue queue and the SAME screen flips to done with the SEEN amount.
 * Flow 143 convert-stale-quote-refresh — a fresh quote renders attributed+timestamped with no
 *   staleness notice; the app's own __DPAY_TEST_CONVERT_STALE_MS seam forces staleness and the
 *   surface flags + re-fetches it (proven by a request counter); a REAL venue-price move via
 *   the relay's fee knob raises the quote-changed review interrupt while confirm stays armed.
 * Flow 145 convert-fund-gate — a zero balance replaces the form with the fund gate that names
 *   the asset and the Receive ▸ My address route (and offers it); an unreachable amount
 *   disables the confirm and states what the conversion needs; an affordable amount re-arms
 *   the confirm with the receive headline leading. TRIMMED (browser-only, recorded gap): the
 *   horizontal-overflow census and screenshots — layout metrics are structurally meaningless
 *   under react-test-renderer (spec risk 1).
 * Flow 169 convert-resume-reload — a pending conversion survives an app reload under the
 *   identity-scoped v3 store key and the wallet-load resume engine drives it to done without
 *   the Convert screen ever opening; nothing re-signed; a terminal record is not resurrected.
 *
 * The e2e twins ran knob flows on their OWN relay (startRelay) because the pool knobs are
 * GLOBAL mutations of the shared fake pool. jest's frozen harness spawns ONE relay per run,
 * so this file keeps every armed window as short as the flow allows and RESTORES the knobs in
 * finally — the cross-file serialization gap is filed for the integrator.
 */
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openConvertFor,
  openBalances, typeConvertAmount, isDisabled,
} from '../harness/lib';
import {relayGet, relayPost} from '../harness/relayClient';
import {disposeConvertStubs, swapPoolKnob} from './convertStubs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai';
const SEED = 300000000; // 3 ICP
const AMOUNT_IN = 100000000n; // 1 ICP

async function swapQuoteOut(): Promise<bigint> {
  const q = await relayGet(`/api/v1/swap_quote?pool=${POOL}&token_in=${ICP_LEDGER}&token_out=${VCHF_LEDGER}&amount_in=${AMOUNT_IN}`) as {amount_out: string};
  return BigInt(q.amount_out);
}

/** Knob hygiene for the ONE shared relay: never leave a held withdrawal or a moved fee armed. */
async function restorePool(): Promise<void> {
  try {
    await swapPoolKnob({pool: POOL, fail_withdrawal: false, settle_pending: true});
    await swapPoolKnob({pool: POOL, fee_millionths: 3000, impact_bps: 0});
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 141 — pool #ok with a held withdrawal is an honest pending_withdrawal', () => {
  it('parks honest, names the asset + pool + support recipe, resolves in place, credits exactly', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-pending');
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      const fund = await faucetAccount(account!.publicHex, SEED, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

      // Hold the venue's output leg BEFORE confirming; re-read the pool's own quote right
      // before arming so the confirm re-quote matches the number the screen shows.
      await swapPoolKnob({pool: POOL, fail_withdrawal: true});
      let executedGross = await swapQuoteOut();
      let pending = false;
      for (let round = 0; round < 5 && !pending; round++) {
        await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
        // The settle watch exhausts (the harness seam: ~10 probes × 100 ms) → pending, NOT done.
        pending = await m.driver.findByTestID('convert-pending', {timeoutMs: 20_000}).then(() => true).catch(() => false);
        if (!pending) {
          const changed = m.driver.readTextSafe('convert-moved-note');
          if (changed != null) {
            // Shared-pool drift tripped the confirm re-quote — re-read and re-confirm.
            executedGross = await swapQuoteOut();
            continue;
          }
          break;
        }
      }
      expect(pending).toBe(true);
      const pendingBody = m.driver.readText('convert-pending');
      assertIncludes(pendingBody, 'Payout pending', 'pending title');
      assertIncludes(pendingBody, 'VCHF', 'pending names the asset owed');
      assertIncludes(pendingBody, POOL, 'pending names the pool principal (support line)');
      assertIncludes(pendingBody, 'quote this to support', 'the practical support recipe stays');
      assertIncludes(pendingBody, 'watching', 'it keeps watching (no dead end)');
      expect(m.driver.bodyText()).not.toContain('Converted');

      // The VCHF is NOT credited while held.
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(0n);

      // Resolution: drain the venue's queue → the screen flips to done on its own.
      await swapPoolKnob({pool: POOL, fail_withdrawal: false, settle_pending: true});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 30_000})).toBe(true);
      const doneBody = m.driver.readText('convert-done');
      assertIncludes(doneBody, 'VCHF', 'done names the asset received');

      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(executedGross);
    } finally {
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

describe('flow 143 — a stale quote refreshes itself; confirm re-quotes', () => {
  it('flags + re-fetches staleness (counter-proven) and raises the moved-quote interrupt', async () => {
    const g = globalThis as Record<string, unknown>;
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-stale');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

      // Fresh: attributed + timestamped, no stale notice, no quote-changed interrupt.
      assertIncludes(m.driver.readText('convert-quote-source'), 'Quote from ICPSwap, fetched', 'fresh quote renders attributed + timestamped');
      expect(m.driver.isPresent('convert-stale')).toBe(false);
      expect(m.driver.isPresent('convert-moved-note')).toBe(false);
      const fetchedBefore = m.driver.readText('convert-quote-source');

      // Deterministic re-fetch proof: count every /api/v1/swap_quote request the surface issues.
      let quoteFetches = 0;
      const prevFetch = g.fetch as typeof fetch;
      g.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (String(url).includes('/api/v1/swap_quote')) quoteFetches += 1;
        return prevFetch(input, init);
      }) as typeof fetch;
      const fetchesBefore = quoteFetches;

      // Force staleness through the app's own seam (the __DPAY_TEST_* convention).
      g.__DPAY_TEST_CONVERT_STALE_MS = 50;

      // The stale notice appears (the 1 s staleness sweep picks it up), then clears on refresh.
      await m.driver.findByTestID('convert-stale', {timeoutMs: 10_000});
      await m.driver.waitForFunction(() => !m!.driver.isPresent('convert-stale'), {timeoutMs: 12_000, label: 'the stale notice cleared on refresh'});
      const fetchedAfter = m.driver.readText('convert-quote-source');
      assertIncludes(fetchedAfter, 'Quote from ICPSwap, fetched', 'refreshed quote is still attributed + timestamped');
      expect(quoteFetches).toBeGreaterThan(fetchesBefore);
      if (fetchedBefore === fetchedAfter) {
        // formatClock is minute-granular — the instant MAY render identically within one minute;
        // the re-fetch counter above is the hard proof.
        console.log('    [143] note: fetched-at text unchanged within the minute (locale clock granularity)');
      }

      // A REAL venue-price move raises the review interrupt — driven via the relay's fee knob.
      const knob = await relayPost('/api/v1/test/swap_pool', {pool: POOL, fee_millionths: 4000});
      expect(knob.ok).toBe(true);
      await m.driver.findByTestID('convert-moved-note', {timeoutMs: 15_000});
      const changedText = m.driver.readText('convert-moved-note');
      assertIncludes(changedText, 'The rate moved', 'the interrupt names what happened, both figures inline');
      assertIncludes(changedText, 'Confirm again', 'the interrupt re-arms the same button');
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).__DPAY_TEST_CONVERT_STALE_MS;
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

describe('flow 145 — convert refuses a swap that could only fail', () => {
  it('fund-gates a zero balance, disables the confirm out of reach, re-arms when it fits', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // --- half 1: nothing to convert ---------------------------------------------------------
      m = await onboardWallet('jest-convert-fundgate'); // funds DEMO only — ICP stays zero
      const account = await accountOf(m);
      await openConvertFor(m, 'icp');

      await m.driver.findByTestID('convert-fund', {timeoutMs: 8_000});
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(false);
      expect(m.driver.isPresent('convert-amount')).toBe(false);
      const gate = m.driver.readText('convert-fund');
      assertIncludes(gate, 'ICP', 'the gate names the asset the wallet lacks');
      assertIncludes(gate, 'Receive', 'the gate names the tab that can fund it');
      assertIncludes(gate, 'My address', 'the gate names the sub-surface inside it');
      assertIncludes(gate, 'Show my ICP address', 'the gate offers the route it names, as a button');
      await m.driver.click('convert-fund-go', {timeoutMs: 5_000});
      await m.driver.findByTestID('deposit-address', {timeoutMs: 8_000});

      // --- half 2: funded, but the entered amount is out of reach ------------------------------
      const fund = await faucetAccount(account!.publicHex, 50000000, {currency: 8}); // 0.5 ICP
      expect(fund.ok).toBe(true);
      // A reload is the deterministic way to make the wallet read the new balance (no poll race).
      await m.remount();
      await openConvertFor(m, 'icp');
      assertIncludes(m.driver.readText('convert-balance'), '0.5 ICP', 'the balance line shows the funded amount');

      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-insufficient', {timeoutMs: 8_000});
      const refusal = m.driver.readText('convert-insufficient');
      assertIncludes(refusal, '2.0002 ICP', 'the refusal states what the conversion needs (amount + both input-ledger fees)');
      assertIncludes(refusal, '0.5 ICP', 'the refusal states the balance it is measured against');
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(true);

      // --- half 3: an affordable amount re-arms the confirm, headline first --------------------
      await typeConvertAmount(m, '0.1');
      const rearmDeadline = Date.now() + 12_000;
      while (await isDisabled(m, 'btn-convert-confirm')) {
        if (Date.now() > rearmDeadline) throw new Error('[145] the confirm never re-armed once the amount fit');
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(false);
      const headline = m.driver.readText('convert-headline');
      assertIncludes(headline, 'You receive', 'the screen leads with what the user receives');
      assertIncludes(headline, 'VCHF', 'the headline is in the asset the user ends up holding');
      // The census folds behind the ONE Details control: the rate + pool principal are still
      // spelled on their own lines; the net end-state line is GONE (the headline IS the end state).
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      assertIncludes(m.driver.readText('convert-rate'), 'ICP', 'the rate names both legs');
      assertIncludes(m.driver.readText('convert-pool-principal'), POOL, 'the pool principal has a line of its own');
      expect(m.driver.isPresent('convert-net')).toBe(false);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

describe('flow 169 — a pending conversion survives an app reload; the engine drives it home', () => {
  it('persists under the identity-scoped v3 key, resumes to done unmounted, never resurrects', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-resume');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

      // Park the conversion on the honest pending (venue holds the output).
      await swapPoolKnob({pool: POOL, fail_withdrawal: true});
      const executedGross = await swapQuoteOut();
      let parked = false;
      for (let round = 0; round < 5 && !parked; round++) {
        await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
        parked = await m.driver.findByTestID('convert-pending', {timeoutMs: 20_000}).then(() => true).catch(() => false);
        if (!parked && m.driver.readTextSafe('convert-moved-note') == null) break;
      }
      expect(parked).toBe(true);

      // The record persists under the IDENTITY-SCOPED key: read it from the app's own store.
      // (RN-web maps AsyncStorage 1:1 onto localStorage; the engine's advance and its persist
      // are two steps, so poll briefly instead of reading once.)
      const scopedKey = `dpay.convert.v3.${account!.publicHex}`;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};
      const readParked = async (): Promise<{step?: string; legs?: unknown[]} | null> => {
        const raw = await AsyncStorage.getItem(scopedKey);
        if (raw == null) return null;
        const all = JSON.parse(raw) as Record<string, {step?: string; legs?: unknown[]}>;
        const rec = Object.values(all)[0];
        return rec ?? null;
      };
      let rec: {step?: string; legs?: unknown[]} | null = null;
      for (let i = 0; i < 20; i++) {
        rec = await readParked();
        if (rec?.step === 'pending_withdrawal') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(rec).not.toBeNull();
      expect(rec!.step).toBe('pending_withdrawal');
      expect(rec!.legs?.length).toBe(2);

      // --- the full reload: identity AND the scoped store survive (remount, no clear) ----------
      await m.remount();
      // Wallet (not onboarding) mounts the engine on load; the Convert screen is NEVER opened
      // from here on — only the engine can move the parked record.
      await swapPoolKnob({pool: POOL, fail_withdrawal: false, settle_pending: true});

      let resolved: {step?: string; outTx?: unknown} | null = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const raw = await AsyncStorage.getItem(scopedKey);
        const all = raw == null ? {} : JSON.parse(raw) as Record<string, {step?: string; outTx?: unknown}>;
        const candidate = Object.values(all)[0] ?? null;
        if (candidate?.step === 'done') { resolved = candidate; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(resolved).not.toBeNull();
      expect(resolved!.outTx).not.toBeNull();
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(executedGross);

      // A terminal record is NOT resurrected: opening Convert shows the form, not a done panel.
      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 10_000});
      expect(await m.driver.findByTestID('convert-done', {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(false);
      assertIncludes(m.driver.bodyText(), 'ICP', 'the convert form renders for the next conversion');
    } finally {
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});
