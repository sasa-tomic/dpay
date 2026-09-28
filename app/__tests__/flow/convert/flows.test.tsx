/**
 * flows — the M2 batch C convert suite: ALL 34 ported convert flows (141-223 minus 140, M1's
 * reference port) in ONE jest file — 199 (the trocador partner agreement) included as of the M3
 * harness wave: it spawns its own startFlowRelay relay (see the cefi IIFE below).
 *
 * WHY ONE FILE. The frozen flow harness spawns ONE relay per jest run, and the convert flows'
 * relay-side state is GLOBAL on it: the fake-IC pool knobs (fee/impact/fail_withdrawal), the
 * fixture-venue serving knob, the served-venue registry cache (per app-module session), and the
 * sideshift/trocador/jupiter test-stub upstreams' counters. The e2e twins isolated each flow on
 * its OWN relay (startRelay); jest has no equivalent, so any two convert files running in
 * separate workers corrupt each other (observed: order-count deltas, venue worlds, mint watches).
 * Consolidating the batch into one file makes the in-file execution sequential and the knob
 * windows mutually exclusive — deterministic at any --maxWorkers.
 *
 * Remaining shared-relay exposure: flows 140-198's pool/stub knobs can still race OTHER batches'
 * convert surfaces at maxWorkers=4; flow 199 opts OUT of that class entirely (private relay).
 *
 * Layout (each source file became one IIFE; its module scope is closure-scoped, so the
 * per-file constants/helpers never collide):
 *   convert-core   141 143 145 169      (pool knobs, staleness seam, fund gate, resume)
 *   venues         142 166 167 168 173 183  (fixture-venue world, registry-order, pair pools)
 *   multihop       184 188 190 196      (route rows, hub, gas-fund, VCHF pair registry)
 *   jupiter        185 189 193 186 209 200  (jupiter-config flows, Route C, the three stops)
 *   cefi           187 194 207 208 197 198 199  (sideshift/trocador orders, no-quote, lifecycle,
 *                                      the partner agreement on its own relay)
 *   failures       191 192 195          (approve refusal, abort, Route C EURC)
 *   dest-groups    206                  (target grammar)
 *   composed       213 223              (one-consent IC+CeFi, EVM-native cefi)
 */
import {describe, it, expect, afterEach, beforeEach, beforeAll, afterAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openConvertFor,
  openBalances, selectCurrency, typeConvertAmount, pickSwapTarget, openOtherVenues, fmtHero,
  isDisabled, pointRelayListAt,
} from '../harness/lib';
import type {Mount} from '../harness/mount';
import {relayGet, relayPost, relayBaseURL, relayGetAt} from '../harness/relayClient';
import {startFlowRelay, pickFreePort} from '../harness/flowRelay';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setSolanaRpcUrl} from '../../../config/constants';
import {setEvmRpcUrl} from '../../../evm/endpoints';
import {
  disposeConvertStubs, swapPoolKnob, venueKnob, approveFailKnob, icDelayKnob, installCctpStub,
  installSolRpcStub, installMutableEthBalance, configureJupiterStub, jupiterStubState,
  cctpFeeExpectations, FORWARD_TX_HASH, deriveSolanaKeypair, deriveAta, bs58Encode,
  jupiterSwapTxB64, solConvertTxDetail, solSentTxs, fmt, floor99, installEvmSignSeam,
  evmSignsRecorded, setCctpMessageState, cctpStubState, icpAccountIdHex, enableSolRail,
  installSideShiftStub, setSideShiftStatus, sideShiftStubState, sideshiftRelayHits, trocadorConfig,
  trocadorRelayHits, deriveEvmKeypair, eip55,
} from './convertStubs';

const FIXTURE_VENUE = 'icpswap-fixture-b';

// The served venue registry is loaded ONCE per relay and cached for the app-module session
// (loadVenueRegistry → VENUE_REGISTRY_CACHE; e2e got a fresh page per flow, jest gets one
// module graph per file) — so the two-venue world is armed ONCE, before this file's FIRST
// convert open, and held for the whole file. Every flow here is written against that world:
// the fixture trades only VCHF ↔ ICP, so the USD/EUR/ckUSDC/ckETH/SOL pairs are untouched, and
// the ICP ↔ VCHF flows' picks follow the live quotes exactly as the e2e twins pinned them.
// Flow 188's served-registry assert filters the knob row and pins the THIRTEEN real venues.
beforeAll(async () => {
  await venueKnob(FIXTURE_VENUE, true);
});

afterAll(async () => {
  try {
    await venueKnob(FIXTURE_VENUE, false);
    await swapPoolKnob({pool: '65mrh-fqaaa-aaaar-qapoa-cai', fee_millionths: 3000, impact_bps: 0, fail_withdrawal: false, settle_pending: true});
    await swapPoolKnob({pool: '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7', fee_millionths: 1000, impact_bps: 0});
    await swapPoolKnob({pool: 'mohjv-bqaaa-aaaag-qjyia-cai', fee_millionths: 3000, impact_bps: 0, fail_withdrawal: false, settle_pending: true});
    await swapPoolKnob({pool: '65mrh-fqaaa-aaaar-qapoa-cai', fail_withdrawal: false, settle_pending: true});
    await swapPoolKnob({pool: 'angxa-baaaa-aaaag-qcvnq-cai', impact_bps: 0});
  } catch { /* the relay itself dying reports at the assertions that matter */ }
});

/** The rail OPERATOR overrides are module-session state in the app (setSolanaRpcUrl/setEvmRpcUrl
 *  win over the test overrides until cleared) — every flow boots with them OFF unless the flow
 *  itself enables a rail (enableSolRail plants the storage key its own boot reads).
 *
 * The storage purge goes through the APP'S OWN module import because the v3 async-storage mock
 * is a per-database registry (createAsyncStorage('legacy')) and the harness's AsyncStorage.clear()
 * (installFlowLifecycle) demonstrably purges a different instance than the app reads — keys
 * written by a previous flow's boot survive it (observed: the SOL rail placeholder leaked into
 * every later flow's fetch surface). File this with the integrator: per-test isolation is
 * harness-core territory. */
beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AS = require('@react-native-async-storage/async-storage') as {
    getAllKeys: () => Promise<string[]>;
    removeItem: (k: string) => Promise<void>;
  };
  for (const k of await AS.getAllKeys()) await AS.removeItem(k);
  setSolanaRpcUrl('');
  setEvmRpcUrl('');
});

afterEach(() => {
  disposeConvertStubs();
});


// ═══ ====================================================================================================
// 140-convert-happy-path.test.tsx (M1's reference port, absorbed: its single-venue pin is
// adapted to the fixture-armed world — the disclosure now states the comparison count)
// ═══ ====================================================================================================
(() => {
const ICP_FEE = 10000n; // raw e8s — the catalog fee field the deposit sheets also show
const VCHF_FEE = 10000n;
const SEED = 300000000; // 3 ICP
const AMOUNT_IN = 100000000n; // 1 ICP
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';

/** fmt8 twin — the app renders the compact 8-decimals formatter everywhere (trailing zeros
 *  trimmed); the flow pins its figures with the same reduction. */
function fmt8(raw: bigint): string {
  const whole = raw / 100000000n;
  let frac = (raw % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

type Quote = {zero_for_one: boolean; fee_millionths: number; venue_id: string; amount_out: string};
const relayQuote = async (tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> =>
  await relayGet(`/api/v1/swap_quote?pool=${POOL}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;

describe('flow 140 — the two-tap convert (sheet → oracle → engine → exact settle)', () => {
  it('prefills the net max, re-quotes to 1 ICP, settles exactly, and names the venue', async () => {
    const m = await onboardWallet('jest-convert-happy');
    const account = await accountOf(m);
    expect(account).not.toBeNull();

    // Fund 3 ICP; TAP 1 — the uniform currency-row Convert button opens the pre-computed sheet.
    const fund = await faucetAccount(account!.publicHex, SEED, {currency: 8});
    expect(fund.ok).toBe(true);
    await openBalances(m);
    await openConvertFor(m, 'icp');

    await m.driver.findByTestID('convert-sheet', {timeoutMs: 8000});
    await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
    const autoLine = m.driver.readText('convert-venue-auto');
    assertIncludes(autoLine, 'Executed via ICPSwap', 'the venue pick is disclosed mechanically (attribution, no "best" claim)');
    expect(autoLine.toLowerCase()).not.toContain('best');
    // The consolidated suite runs in the fixture-armed venue world (see the file header): the
    // ICP ↔ VCHF pair carries TWO venues here, so the mechanical pick DISCLOSES the comparison.
    // The real pool still wins the pick at this size (its net quoted output is higher).
    assertIncludes(autoLine, 'of 2 venues', 'the pick states the comparison count as a fact');
    const prefilled = m.driver.readInputValue('convert-amount');
    assertIncludes(prefilled, '2.9998', `the amount is prefilled to the net max (3 ICP − 2×${fmt8(ICP_FEE)})`);

    // Pin the money math at exactly 1 ICP: typing over the prefill re-quotes. The card renders
    // the prefill's figure until the fresh quote lands — the deterministic signal is the figure
    // ITSELF matching the relay oracle.
    await typeConvertAmount(m, '1');
    const oracle = await relayQuote(ICP_LEDGER, VCHF_LEDGER, AMOUNT_IN);
    expect(oracle.zero_for_one).toBe(false);
    expect(oracle.fee_millionths).toBe(3000);
    expect(oracle.venue_id).toBe('icpswap');
    const gross = BigInt(oracle.amount_out);
    const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
    await m.driver.waitForFunction(
      () => m.driver.readTextSafe('convert-receive')?.includes(`≈ ${fmtHero((gross - VCHF_FEE).toString(), 8, 'VCHF', {stable: true})}`) === true,
      {timeoutMs: 15_000, label: 'the receive figure re-keyed to the typed amount'},
    );

    // §5 transparency lines in the open; the retired lines stay retired.
    assertIncludes(m.driver.readText('convert-receive'),
      `≈ ${fmtHero((gross - VCHF_FEE).toString(), 8, 'VCHF', {stable: true})}`,
      'the receive hero is the venue\'s own net estimate at display precision');
    const quoteSource = m.driver.readText('convert-quote-source');
    assertIncludes(quoteSource, 'Quote from ICPSwap, fetched', 'rate is attributed + timestamped');
    expect(quoteSource).toMatch(/\d{1,2}:\d{2}/);
    assertIncludes(m.driver.readText('convert-min-out'), `${fmt8(minOut)} VCHF`,
      `minimum-you'll-receive is the core's floor at the default 1%`);
    assertIncludes(m.driver.readText('convert-min-out'), '1% slippage', 'the default slippage is disclosed on the card');
    expect(m.driver.isPresent('convert-dpay-fee')).toBe(false);
    expect(m.driver.isPresent('convert-net')).toBe(false);
    expect(m.driver.isPresent('convert-impact')).toBe(false);
    assertIncludes(m.driver.readText('convert-cta'), 'Convert 1 ICP', 'the CTA names the amount');

    // TAP 2: re-quote at the gesture, then the Settlement Field runs the engine.
    await m.driver.click('btn-convert-confirm', {timeoutMs: 6000});
    expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
    const doneBody = m.driver.readText('convert-done');
    assertIncludes(doneBody, 'VCHF', 'done names the asset received');
    assertIncludes(doneBody, `${fmt8(gross)} VCHF`, 'done amount is the SEEN ledger row (the pool credits full gross)');
    expect(doneBody).toMatch(/Payout record/);

    // Exact settlement against the fake-IC books.
    const icpAfter = await getBalance(account!.publicHex, 8);
    const vchfAfter = await getBalance(account!.publicHex, 7);
    expect(BigInt(icpAfter)).toBe(BigInt(SEED) - AMOUNT_IN - ICP_FEE - ICP_FEE);
    expect(BigInt(vchfAfter)).toBe(gross);

    // The Ledger row names the VENUE, not the pool principal.
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    expect(await m.driver.waitForText('from ICPSwap', {timeoutMs: 12_000})).toBe(true);

    await m.unmount();
  }, 180_000);
});
})();

// ═══ ====================================================================================================
// convert-core.test.tsx (its module scope, closure-scoped)
// ═══ ====================================================================================================
(() => {
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai';
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // the fixture venue's pool (file runs venue-armed)
const SEED = 300000000; // 3 ICP
const AMOUNT_IN = 100000000n; // 1 ICP

/** The pool the sheet's auto pick is executing through (real vs fixture — the file runs in the
 *  two-venue world, and the real pool's edge over the fixture flips as its state drifts). */
function pickedPool(m: Awaited<ReturnType<typeof onboardWallet>>): string {
  return (m.driver.readTextSafe('convert-venue-auto') ?? '').includes('offline fixture') ? POOL_B : POOL;
}

async function swapQuoteOut(pool: string): Promise<bigint> {
  const q = await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${ICP_LEDGER}&token_out=${VCHF_LEDGER}&amount_in=${AMOUNT_IN}`) as {amount_out: string};
  return BigInt(q.amount_out);
}

/** Knob hygiene for the ONE shared relay: never leave a held withdrawal or a moved fee armed. */
async function restorePool(): Promise<void> {
  try {
    await swapPoolKnob({pool: POOL, fail_withdrawal: false, settle_pending: true, fee_millionths: 3000, impact_bps: 0});
    await swapPoolKnob({pool: POOL_B, fail_withdrawal: false, settle_pending: true, fee_millionths: 1000, impact_bps: 0});
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

      // Hold the venue's output leg BEFORE confirming (BOTH pools — the pick follows the live
      // quotes in the two-venue world); re-read the winning pool's quote right before arming so
      // the confirm re-quote matches the number the screen shows.
      await swapPoolKnob({pool: POOL, fail_withdrawal: true});
      await swapPoolKnob({pool: POOL_B, fail_withdrawal: true});
      const winPool = pickedPool(m);
      let executedGross = await swapQuoteOut(winPool);
      let pending = false;
      for (let round = 0; round < 5 && !pending; round++) {
        await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
        // The settle watch exhausts (the harness seam: ~10 probes × 100 ms) → pending, NOT done.
        pending = await m.driver.findByTestID('convert-pending', {timeoutMs: 20_000}).then(() => true).catch(() => false);
        if (!pending) {
          const changed = m.driver.readTextSafe('convert-moved-note');
          if (changed != null) {
            // Shared-pool drift tripped the confirm re-quote — re-read and re-confirm.
            executedGross = await swapQuoteOut(winPool);
            continue;
          }
          break;
        }
      }
      expect(pending).toBe(true);
      const pendingBody = m.driver.readText('convert-pending');
      assertIncludes(pendingBody, 'Payout pending', 'pending title');
      assertIncludes(pendingBody, 'VCHF', 'pending names the asset owed');
      assertIncludes(pendingBody, winPool, 'pending names the pool principal (support line)');
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

      // A REAL venue-price move raises the review interrupt — driven via the relay's fee knob
      // on BOTH pools (whichever venue the sheet picked must see its quote move).
      const knob = await relayPost('/api/v1/test/swap_pool', {pool: POOL, fee_millionths: 4000});
      expect(knob.ok).toBe(true);
      const knobB = await relayPost('/api/v1/test/swap_pool', {pool: POOL_B, fee_millionths: 4321});
      expect(knobB.ok).toBe(true);
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

      // Park the conversion on the honest pending (venue holds the output) — both pools, the
      // winner-derived gross, exactly flow 141's adaptation to the two-venue world.
      await swapPoolKnob({pool: POOL, fail_withdrawal: true});
      await swapPoolKnob({pool: POOL_B, fail_withdrawal: true});
      const winPool = pickedPool(m);
      const executedGross = await swapQuoteOut(winPool);
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

})();


// ═══ ====================================================================================================
// venues.test.tsx (its module scope, closure-scoped)
// ═══ ====================================================================================================
(() => {
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKETH_LEDGER = 'ss2fx-dyaaa-aaaar-qacoq-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // fixture B's own pool
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const CKETH_POOL = 'angxa-baaaa-aaaag-qcvnq-cai';
const FIXTURE_VENUE = 'icpswap-fixture-b';
const ICP_FEE = 10000n;
const VCHF_FEE = 10000n;
const CKUSDC_FEE = 10000n;

/** Raw e8s compact twin (8 decimals, trailing zeros trimmed). */
function fmt8(raw: bigint): string {
  return fmt(raw, 8);
}

type Quote = {venue_id: string; zero_for_one: boolean; fee_millionths: number; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint | number): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}

/** Restore every relay-side knob this file touches (the e2e twins' own relays died instead). */
async function restoreKnobs(): Promise<void> {
  try {
    await venueKnob(FIXTURE_VENUE, false);
    await swapPoolKnob({pool: POOL, fee_millionths: 3000, impact_bps: 0});
    await swapPoolKnob({pool: POOL_B, fee_millionths: 1000, impact_bps: 0});
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

/** Unique venue-row testIDs in tree order (the RN-web DOM-order twin via the rendered tree). */
function venueRowOrder(m: Mount): string[] {
  const ids: string[] = [];
  const walk = (n: unknown): void => {
    const props = (n as {props?: {testID?: unknown}}).props;
    const id = props && typeof props.testID === 'string' ? props.testID : null;
    if (id != null && (id === 'convert-venue-icpswap' || id === `convert-venue-${FIXTURE_VENUE}`) && !ids.includes(id)) ids.push(id);
    for (const c of (n as {children?: unknown[]}).children ?? []) {
      if (c && typeof c === 'object') walk(c);
    }
  };
  walk(m.tree.root);
  return ids;
}

/** Find a testID that STARTS WITH a prefix (the hub-row probe; exact findAllByProps can't). */
function findTestIDByPrefix(m: Awaited<ReturnType<typeof onboardWallet>>, prefix: string): string | null {
  let hit: string | null = null;
  const walk = (n: unknown): void => {
    const props = (n as {props?: {testID?: unknown}}).props;
    const id = props && typeof props.testID === 'string' ? props.testID : null;
    if (hit == null && id != null && id.startsWith(prefix)) hit = id;
    for (const c of (n as {children?: unknown[]}).children ?? []) {
      if (c && typeof c === 'object') walk(c);
    }
  };
  walk(m.tree.root);
  return hit;
}

afterEach(() => {
  disposeConvertStubs();
});

// The served venue registry is loaded ONCE per relay and cached for the app-module session
// (loadVenueRegistry → VENUE_REGISTRY_CACHE; e2e got a fresh page per flow, jest gets one
// module graph per file) — so the two-venue world is armed ONCE, before this file's FIRST
// convert open, and held for the whole file. Tests here that don't touch the fixture pairs
// are unaffected (the fixture trades only VCHF ↔ ICP).
afterAll(async () => {
  await restoreKnobs();
});

describe('flow 142 — venue-less fails closed; a venue subject opens the form from the SAME button', () => {
  it('renders no VEUR row, no DEMO convert affordance, and the real ICP form', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-venueless');

      // The retirement: no VEUR row anywhere.
      await openBalances(m);
      expect(await m.driver.findByTestID('asset-veur', {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(false);

      // DEMO: the practice row offers NO convert affordance at all.
      await selectCurrency(m, 'demo');
      await openBalances(m);
      expect(await m.driver.findByTestID('asset-demo', {timeoutMs: 5_000})).not.toBeNull();
      expect(await m.driver.findByTestID('btn-accounts-convert-DEMO', {timeoutMs: 2_000}).then(() => true).catch(() => false)).toBe(false);
      expect(m.driver.bodyText()).not.toContain('Minimum you\'ll receive');

      // ICP: the SAME button, an asset that HAS a venue → the real form.
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 300000000, {currency: 8});
      expect(fund.ok).toBe(true);
      await openConvertFor(m, 'icp');
      expect(await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000})).not.toBeNull();
      expect(await m.driver.findByTestID('convert-amount', {timeoutMs: 4_000})).not.toBeNull();
      expect(await m.driver.findByTestID('convert-unavailable', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 120_000);
});

describe('flow 166 — the disclosed auto pick + the one-tap override + the INV-6 fee census', () => {
  it('picks the higher net quote, overrides in one tap, and pins every fee line byte-exact', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-chooser');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 300000000, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
      // The served registry lands async: wait for BOTH rows' quotes before any expander read.
      await m.driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000}).catch(() => null);
      await m.driver.findByTestID('convert-venue-icpswap-quote', {timeoutMs: 10_000}).catch(() => null);

      // The mechanical pick, cross-checked against the two oracle replies for the same amount.
      const oracleA = await relayQuote(POOL, ICP_LEDGER, VCHF_LEDGER, 100000000n);
      const netA = BigInt(oracleA.amount_out) - VCHF_FEE;
      const oracleB = await relayQuote(POOL_B, ICP_LEDGER, VCHF_LEDGER, 100000000n);
      const netB = BigInt(oracleB.amount_out) - VCHF_FEE;
      const best = netB > netA
        ? {id: FIXTURE_VENUE, name: 'ICPSwap (offline fixture)', net: netB}
        : {id: 'icpswap', name: 'ICPSwap', net: netA};

      const autoLine = m.driver.readText('convert-venue-auto');
      assertIncludes(autoLine, 'Executed via', 'the pick line names its executor');
      assertIncludes(autoLine, 'highest quoted rate of 2 venues', 'the pick states the comparison count as a fact');
      expect(autoLine.toLowerCase()).not.toContain('best');
      assertIncludes(autoLine, best.name, `the pick followed the higher net quote (${best.name})`);
      const headlineNet = m.driver.readText('convert-receive');
      assertIncludes(headlineNet, `≈ ${fmtHero(best.net.toString(), 8, 'VCHF', {stable: true})}`, 'the receive hero is the PICKED venue\'s own reply at display precision');

      // The expander holds exactly the OTHER row, carrying its OWN quote at the typed amount.
      await openOtherVenues(m);
      const otherId = best.id === 'icpswap' ? FIXTURE_VENUE : 'icpswap';
      const otherNet = best.id === 'icpswap' ? netB : netA;
      const typed = m.driver.readInputValue('convert-amount');
      assertIncludes(typed, '1', 'the sheet\'s input holds the typed amount');
      const expectedOther = `${fmt8(otherNet + VCHF_FEE)} VCHF`;
      await m.driver.waitForFunction(
        () => (m!.driver.readTextSafe(`convert-venue-${otherId}-quote`) ?? '').trim() === expectedOther,
        {timeoutMs: 15_000, label: 'the other row shows its OWN quote at the typed amount'},
      );
      const order = venueRowOrder(m);
      expect(order.length).toBe(1);
      expect(order[0]).toBe(`convert-venue-${otherId}`);

      // ONE-TAP override: attribution + floor + headline move to the picked row's numbers.
      await m.driver.click(`convert-venue-${otherId}`, {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});
      const overriddenSource = m.driver.readText('convert-quote-source');
      assertIncludes(overriddenSource, 'fetched', 'the overridden card still carries attribution + a timestamp');
      assertIncludes(overriddenSource, otherId === 'icpswap' ? 'Quote from ICPSwap,' : 'ICPSwap (offline fixture)', 'the attribution names the OVERRIDDEN venue');
      expect(m.driver.isPresent('convert-venue-auto')).toBe(false);
      // The overridden row's fresh quote lands async — the deterministic signal is the hero
      // itself carrying the overridden venue's own reply (the flow-140 oracle pattern).
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-receive')?.includes(`≈ ${fmtHero(otherNet.toString(), 8, 'VCHF', {stable: true})}`) === true,
        {timeoutMs: 15_000, label: 'the receive hero follows the overridden row\'s own reply'},
      );

      // --- INV-6 fee census: force the real pool tier to 4321 millionths, re-key, override. ----
      await swapPoolKnob({pool: POOL, fee_millionths: 4321});
      const AMOUNT_IN = 200000000n;
      const oracle = await relayQuote(POOL, ICP_LEDGER, VCHF_LEDGER, AMOUNT_IN);
      expect(String(oracle.fee_millionths)).toBe('4321');
      expect(oracle.venue_id).toBe('icpswap');
      const gross = BigInt(oracle.amount_out);
      const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
      const net = gross - VCHF_FEE;

      await typeConvertAmount(m, '2');
      if (m.driver.isPresent('convert-venue-icpswap') === false) await openOtherVenues(m);
      await m.driver.click('convert-venue-icpswap', {timeoutMs: 5_000});
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      // The pool-fee line settling at the FORCED tier + the hero re-keying to the typed
      // amount are jointly the deterministic signal that the fresh quote landed (the two
      // card sections settle on separate ticks — poll the money figure, then read the rest).
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-receive')?.includes(`≈ ${fmtHero(net.toString(), 8, 'VCHF', {stable: true})}`) === true,
        {timeoutMs: 15_000, label: 'the receive hero re-keyed to the forced-tier quote'},
      );
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-pool-fee')?.includes('0.4321%') === true,
        {timeoutMs: 15_000, label: 'the pool-fee line settles at the FORCED tier'},
      );

      // THE CENSUS — every fee-bearing money line, byte-exact:
      const poolFeeLine = m.driver.readText('convert-pool-fee');
      assertIncludes(poolFeeLine, '0.4321%', 'pool fee = the FORCED tier (4 decimals, never rounded)');
      assertIncludes(poolFeeLine, 'ICPSwap fee tier', 'the tier is attributed to the venue whose quote it rode');
      assertIncludes(m.driver.readText('convert-in-fee'), `Input fee: ${fmt8(ICP_FEE)} ICP`, 'input fee = the catalog ledger fee, exact');
      assertIncludes(m.driver.readText('convert-out-fee'), `${fmt8(VCHF_FEE)} VCHF`, 'output fee = the catalog ledger fee, exact');
      expect(m.driver.isPresent('convert-dpay-fee')).toBe(false);
      assertIncludes(m.driver.readText('convert-receive'), `≈ ${fmtHero(net.toString(), 8, 'VCHF', {stable: true})}`, 'receive hero = gross − output fee from the forced quote');
      assertIncludes(m.driver.readText('convert-quote-verbatim'), `${fmt8(gross)} VCHF`, 'Details carries the forced quote\'s verbatim gross');
      const minOutLine = m.driver.readText('convert-min-out');
      assertIncludes(minOutLine, `${fmt8(minOut)} VCHF`, 'the floor = the core\'s floor math on the forced quote');
      assertIncludes(minOutLine, '1% slippage', 'at the default 1% slippage');
      expect(m.driver.isPresent('convert-net')).toBe(false);
      expect(m.driver.readText('convert-venue-disclosure').trim().length).toBeGreaterThan(0);
      expect(m.driver.isPresent('convert-impact')).toBe(false);
    } finally {
      await restoreKnobs();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});

describe('flow 167 — the auto pick follows the quotes; the expander holds exactly the complement', () => {
  it('flips the pick in BOTH knob directions with the zeroed floored row quoted byte-identically', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-order');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 300000000, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
      await openOtherVenues(m);
      const before = venueRowOrder(m);
      expect(before.length).toBe(1);
      expect(before[0]).toBe(`convert-venue-${FIXTURE_VENUE}`);

      // Phase 1: the real pool's payout floors to zero → the pick flips to the fixture.
      await swapPoolKnob({pool: POOL, impact_bps: 10000});
      await typeConvertAmount(m, '2');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-venue-auto')?.includes('offline fixture') === true,
        {timeoutMs: 15_000, label: 'the pick flipped to the fixture venue'},
      );
      const autoLine1 = m.driver.readText('convert-venue-auto');
      assertIncludes(autoLine1, 'Executed via ICPSwap (offline fixture)', 'the disclosed pick followed the strictly-better fixture venue');
      assertIncludes(autoLine1, 'highest quoted rate of 2 venues', 'the pick states the comparison count');
      const after1 = venueRowOrder(m);
      expect(after1.length).toBe(1);
      expect(after1[0]).toBe('convert-venue-icpswap');
      const aQuote = m.driver.readText('convert-venue-icpswap-quote');
      expect(/^0(\.0+)? VCHF$/.test(aQuote.trim())).toBe(true);
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(true);

      // Phase 2: re-price fixture B, floor it, restore the real pool → the pick flips back.
      await swapPoolKnob({pool: POOL_B, fee_millionths: 4321});
      await swapPoolKnob({pool: POOL_B, impact_bps: 10000});
      await swapPoolKnob({pool: POOL, impact_bps: 0});
      await typeConvertAmount(m, '3');
      await m.driver.waitForFunction(
        () => {
          const auto = m!.driver.readTextSafe('convert-venue-auto') ?? '';
          return auto.includes('Executed via ICPSwap,') && !auto.includes('offline fixture');
        },
        {timeoutMs: 15_000, label: 'the pick flipped back to the real venue'},
      );
      const autoLine2 = m.driver.readText('convert-venue-auto');
      assertIncludes(autoLine2, 'Executed via ICPSwap,', 'the disclosed pick flipped back to the real venue');
      expect(autoLine2).not.toContain('offline fixture');
      const after2 = venueRowOrder(m);
      expect(after2.length).toBe(1);
      expect(after2[0]).toBe(`convert-venue-${FIXTURE_VENUE}`);
      const bQuote2 = m.driver.readText(`convert-venue-${FIXTURE_VENUE}-quote`);
      expect(/^0(\.0+)? VCHF$/.test(bQuote2.trim())).toBe(true);
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(true);
    } finally {
      await restoreKnobs();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});

describe('flow 168 — picking fixture venue B executes through pool B, end-to-end', () => {
  it('quotes, settles and pays B\'s reversed-pool output verbatim', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-fixture');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 300000000, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
      await openOtherVenues(m);

      // The oracle BEFORE the pick: pool B's own facts (its token0 is ICP).
      const oracle = await relayQuote(POOL_B, ICP_LEDGER, VCHF_LEDGER, 100000000n);
      expect(oracle.venue_id).toBe(FIXTURE_VENUE);
      expect(oracle.zero_for_one).toBe(true);
      expect(oracle.fee_millionths).toBe(1000);
      const gross = BigInt(oracle.amount_out);
      const net = gross - VCHF_FEE;
      const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;

      // Pick venue B → the decision surfaces quote B, attributed to B, on B's pool.
      await m.driver.click(`convert-venue-${FIXTURE_VENUE}`, {timeoutMs: 6_000});
      await m.driver.findByTestID('convert-headline', {timeoutMs: 10_000});
      expect(m.driver.isPresent('convert-venue-none')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      expect(m.driver.readText('convert-pool-principal').trim()).toBe(POOL_B);
      assertIncludes(m.driver.readText('convert-counterparty'), 'ICPSwap (offline fixture)', 'the counterparty is attributed to venue B');
      assertIncludes(m.driver.readText('convert-headline'), `≈ ${fmtHero(net.toString(), 8, 'VCHF', {stable: true})}`, 'the headline states B\'s net output at display precision');
      assertIncludes(m.driver.readText('convert-quote-verbatim'), `${fmt8(gross)} VCHF`, 'Details carries B\'s verbatim quoted figure');
      assertIncludes(m.driver.readText('convert-min-out'), `${fmt8(minOut)} VCHF`, 'the minimum follows B\'s quote');
      assertIncludes(m.driver.readText('convert-pool-fee'), '0.10%', 'the fee line states B\'s own 0.10% tier');

      // Confirm (a quote-changed interrupt would demand a re-confirm — retry a few rounds).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
      }
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt8(gross)} VCHF`, 'the done panel states B\'s quoted payout');
      assertIncludes(done, 'Payout record', 'the done panel carries the payout record');

      // Settlement: pool B paid its quoted output VERBATIM.
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(300000000) - 100000000n - 2n * ICP_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(gross);
    } finally {
      await restoreKnobs();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});

describe('flow 173 — the auto-pick invariants in the REVERSE direction (VCHF → ICP)', () => {
  it('flips the pick in both phases where the pools disagree about token0', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-order-rev');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 1_000_000_000, {currency: 7}); // 10 VCHF
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'ICP');
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
      await openOtherVenues(m);
      const before = venueRowOrder(m);
      expect(before.length).toBe(1);
      expect(before[0]).toBe('convert-venue-icpswap');

      // Phase 1: floor the real pool → the fixture picks, the real row zeroes (in ICP units).
      await swapPoolKnob({pool: POOL, impact_bps: 10000});
      await typeConvertAmount(m, '2');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-venue-auto')?.includes('offline fixture') === true,
        {timeoutMs: 15_000, label: 'the pick flipped to the fixture venue (reverse)'},
      );
      const autoLine1 = m.driver.readText('convert-venue-auto');
      assertIncludes(autoLine1, 'Executed via ICPSwap (offline fixture)', 'the pick followed the strictly-better fixture venue');
      assertIncludes(autoLine1, 'highest quoted rate of 2 venues', 'the pick states the comparison count');
      const after1 = venueRowOrder(m);
      expect(after1.length).toBe(1);
      expect(after1[0]).toBe('convert-venue-icpswap');
      await m.driver.waitForFunction(
        () => /^0(\.0+)? ICP$/.test((m!.driver.readTextSafe('convert-venue-icpswap-quote') ?? '').trim()),
        {timeoutMs: 15_000, label: 'the floored real row shows its OWN zeroed reverse reply'},
      );
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(true);

      // Phase 2: re-price then floor fixture B while the real pool restores → the pick flips back.
      await swapPoolKnob({pool: POOL_B, fee_millionths: 4321});
      await swapPoolKnob({pool: POOL_B, impact_bps: 10000});
      await swapPoolKnob({pool: POOL, impact_bps: 0});
      await typeConvertAmount(m, '3');
      await m.driver.waitForFunction(
        () => {
          const auto = m!.driver.readTextSafe('convert-venue-auto') ?? '';
          return auto.includes('Executed via ICPSwap,') && !auto.includes('offline fixture');
        },
        {timeoutMs: 15_000, label: 'the pick flipped back to the real venue (reverse)'},
      );
      const autoLine2 = m.driver.readText('convert-venue-auto');
      assertIncludes(autoLine2, 'Executed via ICPSwap,', 'the pick flipped back to the real venue');
      expect(autoLine2).not.toContain('offline fixture');
      const after2 = venueRowOrder(m);
      expect(after2.length).toBe(1);
      expect(after2[0]).toBe(`convert-venue-${FIXTURE_VENUE}`);
      await m.driver.waitForFunction(
        () => /^0(\.0+)? ICP$/.test((m!.driver.readTextSafe(`convert-venue-${FIXTURE_VENUE}-quote`) ?? '').trim()),
        {timeoutMs: 15_000, label: 'the floored fixture row shows its OWN zeroed reverse reply'},
      );
      expect(m.driver.isPresent('btn-convert-confirm')).toBe(true);
    } finally {
      await restoreKnobs();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});

describe('flow 183 — the pair-scoped ICPSwap venues (ckUSDC, ckETH) are live on Convert', () => {
  it('executes ckUSDC→ICP through its pool and pins the 6- and 18-decimal quote shapes', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-ckusdc');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 1000000000, {currency: 2}); // 1000 ckUSDC
      expect(fund.ok).toBe(true);

      // ckUSDC→ICP: discover the pair on the Convert surface.
      await openConvertFor(m, 'ckusdc');
      await pickSwapTarget(m, 'ICP');
      await typeConvertAmount(m, '100');
      // ONE direct venue on this pair → the sheet auto-picks it; the via-VCHF hub waits behind
      // the ONE expander as an explicit opt-in row.
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 15_000});
      const autoLine = m.driver.readText('convert-venue-auto');
      assertIncludes(autoLine, 'Executed via', 'the pick line names its executor');
      expect(autoLine).not.toContain('of 2 venues');
      expect(m.driver.isPresent('convert-venue-none')).toBe(false);
      await openOtherVenues(m);
      expect(findTestIDByPrefix(m, 'convert-venue-hub:')).not.toBeNull();
      expect(m.driver.isPresent('convert-unavailable')).toBe(false);

      // The oracle BEFORE the confirm: the pool's own facts (its token0 is ICP).
      const oracle = await relayQuote(CKUSDC_POOL, CKUSDC_LEDGER, ICP_LEDGER, 100000000n);
      expect(oracle.venue_id).toBe('icpswap-ckusdc');
      expect(oracle.zero_for_one).toBe(false);
      expect(oracle.fee_millionths).toBe(3000);
      let gross = BigInt(oracle.amount_out);
      expect(gross > 0n).toBe(true);
      let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;

      await m.driver.click('convert-details', {timeoutMs: 5_000});
      expect(m.driver.readText('convert-pool-principal').trim()).toBe(CKUSDC_POOL);
      assertIncludes(m.driver.readText('convert-counterparty'), 'ICPSwap', 'the counterparty is attributed to ICPSwap');
      assertIncludes(m.driver.readText('convert-headline'), `${fmt(gross - ICP_FEE, 8)} ICP`, 'the headline states the net ICP output');
      assertIncludes(m.driver.readText('convert-min-out'), `${fmt(minOut, 8)} ICP`, 'the minimum follows the pool\'s quote');
      assertIncludes(m.driver.readText('convert-pool-fee'), '0.30%', 'the fee line states the pool\'s 0.30% tier');

      // The forward ICP→ckUSDC quote through the production route (the 6-decimal side).
      const fwd = await relayQuote(CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, 100000000n);
      expect(fwd.venue_id).toBe('icpswap-ckusdc');
      expect(fwd.zero_for_one).toBe(true);
      expect(fwd.fee_millionths).toBe(3000);
      const fwdOut = BigInt(fwd.amount_out);
      expect(fwdOut > 0n).toBe(true);
      expect(/^(\d+)(\.\d{1,6})?$/.test(fmt(fwdOut, 6))).toBe(true);

      // Confirm (quote-changed interrupt → re-confirm, re-deriving the oracle after a move).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        const re = await relayQuote(CKUSDC_POOL, CKUSDC_LEDGER, ICP_LEDGER, 100000000n);
        gross = BigInt(re.amount_out);
        minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
      }
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt(gross, 8)} ICP`, 'the done panel states the pool\'s quoted ICP payout');
      assertIncludes(done, 'Payout record', 'the done panel carries the payout record');

      // Settlement: 6-decimal ckUSDC input math; the ICP side is the quoted output verbatim.
      expect(BigInt(await getBalance(account!.publicHex, 2))).toBe(BigInt(1000000000) - 100000000n - 2n * CKUSDC_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(gross);

      // --- ckETH pair: offered quote-only (the 18-decimal side) --------------------------------
      const fundEth = await faucetAccount(account!.publicHex, 4000000000000000, {currency: 6}); // 0.004 ckETH
      expect(fundEth.ok).toBe(true);
      await openConvertFor(m, 'cketh');
      await typeConvertAmount(m, '0.002');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      expect(m.driver.isPresent('convert-venue-none')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      expect(m.driver.readText('convert-pool-principal').trim()).toBe(CKETH_POOL);
      assertIncludes(m.driver.readText('convert-counterparty'), 'ICPSwap', 'the ckETH counterparty is attributed to ICPSwap');
      const oracleEth = await relayQuote(CKETH_POOL, CKETH_LEDGER, ICP_LEDGER, 2000000000000000n);
      expect(oracleEth.venue_id).toBe('icpswap-cketh');
      expect(oracleEth.zero_for_one).toBe(false);
      const grossEth = BigInt(oracleEth.amount_out);
      expect(grossEth > 0n).toBe(true);
      // The sheet re-keys to the typed amount async — the deterministic signal is the headline
      // itself carrying the typed amount's oracle figure (the flow-140 pattern).
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes(`${fmt(grossEth - ICP_FEE, 8)} ICP`) === true,
        {timeoutMs: 15_000, label: 'the ckETH checklist headline re-keyed to the typed amount'},
      );
      const minOutEth = (grossEth / 10000n) * 9900n + ((grossEth % 10000n) * 9900n) / 10000n;
      const fwdEth = await relayQuote(CKETH_POOL, ICP_LEDGER, CKETH_LEDGER, 100000000n);
      expect(fwdEth.venue_id).toBe('icpswap-cketh');
      expect(fwdEth.zero_for_one).toBe(true);
      expect(fwdEth.fee_millionths).toBe(3000);
      const fwdEthOut = BigInt(fwdEth.amount_out);
      expect(fwdEthOut > 0n).toBe(true);
      expect(/^(\d+)(\.\d{1,18})?$/.test(fmt(fwdEthOut, 18))).toBe(true);
      // QUOTE-ONLY: nothing executes on this leg.
      expect(m.driver.isPresent('convert-done')).toBe(false);
      assertIncludes(m.driver.readText('convert-min-out'), `${fmt(minOutEth, 8)} ICP`, 'the ckETH minimum follows the pool\'s quote (form, not done panel)');
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});

})();


// ═══ ====================================================================================================
// multihop.test.tsx (its module scope, closure-scoped)
// ═══ ====================================================================================================
(() => {
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKETH_LEDGER = 'ss2fx-dyaaa-aaaar-qacoq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const POOL_VCHF_ICP = '65mrh-fqaaa-aaaar-qapoa-cai';
const POOL_ICP_CKETH = 'angxa-baaaa-aaaag-qcvnq-cai';
const VCHF_USDC_POOL = 'hx7nb-diaaa-aaaar-qbxsa-cai';
const MINTER = 'sv3dd-oaaaa-aaaar-qacoa-cai';
const GAS_WEI = 78000000000000n;
const ICP_FEE = 10000n;
const VCHF_FEE = 10000n;
const CKUSDC_FEE = 10000n;
const CKETH_FEE = 2000000000000n;

type Quote = {venue_id: string; zero_for_one: boolean; fee_millionths: number; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}

async function restorePoolKnobs(): Promise<void> {
  try {
    await swapPoolKnob({pool: POOL_VCHF_ICP, fail_withdrawal: false, settle_pending: true, fee_millionths: 3000, impact_bps: 0});
    await swapPoolKnob({pool: POOL_ICP_CKETH, fail_withdrawal: false, settle_pending: true, fee_millionths: 3000, impact_bps: 0});
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 184 — Route A: ICP → USDC(Ethereum) as one opt-in intent', () => {
  it('offers the composed row in kind order, quotes the hop verbatim, names the gas census', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-route-a');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, 2000000000, {currency: 8}); // 20 ICP
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, 400000000000000, {currency: 6}); // 0.0004 ckETH
      expect(fundEth.ok).toBe(true);

      // The venue area: the USD pair's rows in kind order, Route A gone.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'USD');
      await typeConvertAmount(m, '5');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      for (const rowId of ['hub:icpswap:7:icpswap-vchf-ckusdc', 'multihop:icpswap-ckusdc:2:cctp', 'sideshift-usdc']) {
        expect(await m.driver.findByTestID(`convert-venue-${rowId}`, {timeoutMs: 4_000}).then(() => true).catch(() => false)).toBe(true);
      }
      expect(await m.driver.findByTestID('convert-venue-multihop:icpswap-ckusdc:2', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);
      assertIncludes(m.driver.readText('convert-venue-auto'), 'Executed via', 'the direct pool is the auto pick (disclosed mechanically)');
      expect(m.driver.isPresent('convert-headline')).toBe(true);
      expect(m.driver.isPresent('convert-dest-address')).toBe(false);

      // Picking Route B swaps the surface: the crossing's signer-side address + the hop quote.
      await m.driver.click('convert-venue-multihop:icpswap-ckusdc:2:cctp');
      await m.driver.type('convert-dest-address', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      expect(m.driver.isPresent('convert-dest-address-invalid')).toBe(false);

      // The hop's own quote through the production route.
      const oracle = await relayQuote(CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, 500000000n);
      expect(oracle.venue_id).toBe('icpswap-ckusdc');
      expect(oracle.zero_for_one).toBe(true);
      const gross = BigInt(oracle.amount_out);
      expect(gross > 0n).toBe(true);
      const net = gross - CKUSDC_FEE;
      const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;

      // The route census: hop quote + floor stay MAIN; the minter's gas fee + burn counterparty
      // fold behind the ONE Details control.
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes(`≈ ${fmtHero(net.toString(), 6, 'USDC', {stable: true})}`) === true,
        {timeoutMs: 15_000, label: 'the headline re-keyed to the hop oracle'},
      );
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the crossing minimum is the hop quote\'s 1% floor');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-quote-verbatim') && m!.driver.isPresent('convert-gas-note'),
        {timeoutMs: 15_000, label: 'the census lines mounted behind Details'},
      );
      assertIncludes(m.driver.readText('convert-quote-verbatim'), `${fmt(gross, 6)} USDC`, 'Details carries the hop venue\'s verbatim quoted figure');
      assertIncludes(m.driver.readText('convert-gas-note'), `${fmt(GAS_WEI, 18)} ETH`, 'the gas census line states the minter\'s live figure');
      expect(m.driver.readText('convert-minter-principal').trim()).toBe(MINTER);
      assertIncludes(m.driver.readText('convert-counterparty'), 'ICPSwap', 'the swap counterparty is attributed to ICPSwap');
      expect(m.driver.isPresent('convert-gas-preflight')).toBe(false);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

describe('flow 188 — the VCHF ↔ ckUSDC pair (registry order + both-direction quotes)', () => {
  it('serves the registry, quotes both directions, routes the USD walk through the new pool', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The served registry: the expansion is on the wire, in registry order. The file-scoped
      // fixture knob adds a 14th row (icpswap-fixture-b) — filter it and pin the THIRTEEN real
      // venues' order (the e2e twin ran on an un-armed private relay).
      const venuesRes = await relayGet('/api/v1/venues') as {venues: Array<{venue_id: string}>};
      expect(venuesRes.venues.map((v) => v.venue_id).filter((id) => id !== 'icpswap-fixture-b').join('|')).toBe([
        'icpswap', 'icpswap-ckusdc', 'icpswap-cketh', 'icpswap-ckbtc', 'icpswap-ckbtc-cketh',
        'icpswap-vchf-ckusdc', 'jupiter', 'jupiter-eurc', 'jupiter-usdc-eurc', 'sideshift',
        'sideshift-usdc', 'sideshift-eurc', 'trocador',
      ].join('|'));

      // The DIRECT pair: production-route oracle quotes, both directions.
      const fwd = await relayQuote(VCHF_USDC_POOL, VCHF_LEDGER, CKUSDC_LEDGER, 1000000000n);
      expect(fwd.venue_id).toBe('icpswap-vchf-ckusdc');
      expect(fwd.zero_for_one).toBe(true);
      expect(fwd.fee_millionths).toBe(3000);
      const fwdOut = BigInt(fwd.amount_out);
      expect(fwdOut > 0n).toBe(true);
      expect(/^(\d+)(\.\d{1,6})?$/.test(fmt(fwdOut, 6))).toBe(true);
      const rev = await relayQuote(VCHF_USDC_POOL, CKUSDC_LEDGER, VCHF_LEDGER, 100000000n);
      expect(rev.venue_id).toBe('icpswap-vchf-ckusdc');
      expect(rev.zero_for_one).toBe(false);
      expect(rev.fee_millionths).toBe(3000);
      const revOut = BigInt(rev.amount_out);
      expect(revOut > 0n).toBe(true);
      expect(/^(\d+)(\.\d{1,8})?$/.test(fmt(revOut, 8))).toBe(true);

      // The app: the direct form is untouched; the new pool surfaces as the Route B hop.
      m = await onboardWallet('jest-convert-vchf-usdc');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 50000000000, {currency: 7}); // 500 VCHF
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'vchf');
      await typeConvertAmount(m, '10');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      expect(m.driver.isPresent('convert-unavailable')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-pool-principal'),
        {timeoutMs: 15_000, label: 'the details census mounted'},
      );
      expect(m.driver.readText('convert-pool-principal').trim()).toBe(VCHF_USDC_POOL);

      await pickSwapTarget(m, 'USD');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp', {timeoutMs: 3_000});
      await m.driver.click('convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp', {timeoutMs: 4_000});
      await m.driver.type('convert-dest-address', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      expect(m.driver.isPresent('convert-dest-address-invalid')).toBe(false);
      const minOut = (fwdOut / 10000n) * 9900n + ((fwdOut % 10000n) * 9900n) / 10000n;
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the destination minimum is the hop quote\'s 1% floor through the NEW pool');

      // QUOTE-ONLY: nothing executed.
      expect(m.driver.isPresent('convert-done')).toBe(false);
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(BigInt(50000000000));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

describe('flow 190 — the hub 2-hop conversion (VCHF → ICP → ETH), one 4-leg intent', () => {
  it('runs the composed surface, the 4-leg tracker, the in-wallet receipt, and the refusal taxonomy', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-hub');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 2000000000, {currency: 7}); // 20 VCHF
      expect(fund.ok).toBe(true);

      // The target list: currency chips from VCHF; the ICP pair carries the direct pool + hub.
      await openConvertFor(m, 'vchf');
      for (const code of ['ICP', 'ETH', 'BTC', 'SOL']) {
        expect(m.driver.isPresent(`convert-target-chip-${code}`)).toBe(true);
      }
      await pickSwapTarget(m, 'ICP');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc', {timeoutMs: 8_000});

      // The hub-only target: ETH — no address input, the composed surface arms on it.
      await pickSwapTarget(m, 'ETH');
      expect(m.driver.isPresent('convert-dest-address')).toBe(false);
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});

      // The composed oracle BEFORE confirming: the exact two quotes the surface shows.
      const hubOracle = async () => {
        const q1 = await relayQuote(POOL_VCHF_ICP, VCHF_LEDGER, ICP_LEDGER, 200000000n);
        expect(q1.venue_id).toBe('icpswap');
        expect(q1.zero_for_one).toBe(true);
        const gross1 = BigInt(q1.amount_out);
        const minOut1 = floor99(gross1);
        const q2 = await relayQuote(POOL_ICP_CKETH, ICP_LEDGER, CKETH_LEDGER, minOut1);
        expect(q2.venue_id).toBe('icpswap-cketh');
        expect(q2.zero_for_one).toBe(true);
        const gross2 = BigInt(q2.amount_out);
        expect(gross2 > CKETH_FEE).toBe(true);
        return {gross1, minOut1, gross2, minOut2: floor99(gross2), net2: gross2 - CKETH_FEE};
      };
      let {gross1, minOut1, gross2, net2} = await hubOracle();
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes(`≈ ${fmtHero(net2.toString(), 18, 'ETH', {displayDecimals: 6})}`) === true,
        {timeoutMs: 15_000, label: 'the composed headline re-keyed to the two-hop oracle'},
      );
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      assertIncludes(m.driver.readText('convert-quote-verbatim'), `${fmt(gross2, 18)} ETH`, 'Details carries swap2\'s verbatim quoted figure');
      assertIncludes(m.driver.readText('convert-quote-source'), 'Quotes from ICPSwap and ICPSwap, fetched ', 'the attribution names BOTH venues verbatim');
      assertIncludes(m.driver.readText('convert-route-via'), 'via ICP · 2 swaps', 'the route chip names the hub and the swap count');
      const census = m.driver.readText('convert-hub-census');
      assertIncludes(census, 'Two swaps, itemized', 'the census heading names the fold');
      assertIncludes(census, 'Combined rate, VCHF → ETH:', 'the composed rate names both ends');
      assertIncludes(census, 'Swap VCHF → ICP on ICPSwap', 'hop 1 names its venue and its pair');
      assertIncludes(census, 'Swap ICP → ETH on ICPSwap', 'hop 2 names its venue and its pair');
      assertIncludes(census, 'Pool fee: 0.30% (ICPSwap fee tier)', 'each hop names its own fee tier');
      assertIncludes(census, 'Approving the next pool costs 0.0001 VCHF', 'hop 1\'s approve cost is its own census line');
      assertIncludes(census, 'Approving the next pool costs 0.0001 ICP', 'hop 2\'s approve cost is its own census line');
      assertIncludes(census, 'the surplus stays in this wallet as ICP or ETH.', 'the surplus note covers both hops');

      // Confirm: four legs, per-leg status, the in-wallet receipt.
      let confirmed = false;
      for (let round = 0; round < 5 && !confirmed; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) { confirmed = true; break; }
        ({gross1, minOut1, gross2, net2} = await hubOracle());
      }
      expect(confirmed).toBe(true);
      await m.driver.findByTestID('convert-state', {timeoutMs: 10_000});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
      const stateText = m.driver.readText('convert-state');
      assertIncludes(stateText, 'Convert VCHF → ETH', 'the state screen keeps the plain selection heading');
      expect(m.driver.isPresent('convert-route-legs')).toBe(true);
      const legLabels = [
        'Approve the pool to pull your VCHF',
        'Swap VCHF → ICP on ICPSwap',
        'Approve the pool to pull your ICP',
        'Swap ICP → ETH on ICPSwap',
      ];
      for (let i = 0; i < 4; i++) {
        assertIncludes(m.driver.readText(`convert-leg-${i}`), legLabels[i], `leg ${i} carries its own label`);
        assertIncludes(m.driver.readText(`convert-leg-${i}-state`), 'Confirmed', `leg ${i} reads Confirmed after the run`);
      }
      assertIncludes(m.driver.readText('convert-leg-0-state'), '· 0.0001 VCHF', 'leg 1\'s approve fee is its own ledger\'s fee');
      assertIncludes(m.driver.readText('convert-leg-2-state'), '· 0.0001 ICP', 'leg 3\'s approve fee is the hub ledger\'s fee');
      const done = m.driver.readText('convert-done');
      assertIncludes(done, 'Converted', 'the done title is the in-wallet receipt\'s title');
      assertIncludes(done, `${fmt(gross2, 18)} ETH received in your wallet.`, 'the receipt names the SEEN payout amount');
      assertIncludes(done, 'Payout record: ', 'the receipt carries the dest-ledger payout record');
      expect(!done.includes('on its way') && !stateText.includes('Ethereum')).toBe(true);

      // Ledger truth: VCHF debited amount + two fees; ICP nets the surplus; ckETH the full gross.
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(BigInt(2000000000) - 200000000n - 2n * VCHF_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(gross1 - minOut1 - 2n * ICP_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(gross2);

      // --- the USD pair's venue rows: direct pool standing, hub opt-in; selection only ----------
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'USD');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'Executed via', 'the direct pool is the auto pick for the USD pair');
      await openOtherVenues(m);
      const hubRow = m.driver.readText('convert-venue-hub:icpswap:8:icpswap-ckusdc');
      assertIncludes(hubRow, 'Via ICP', 'the opt-in hub row names its mechanism');
      assertIncludes(hubRow, '2 swaps', 'the opt-in hub row carries its static shape line');
      await m.driver.click('convert-venue-hub:icpswap:8:icpswap-ckusdc');
      await typeConvertAmount(m, '1');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-route-via')?.includes('via ICP · 2 swaps') === true,
        {timeoutMs: 15_000, label: 'picking Via ICP arms the composed surface for USD'},
      );
      expect(m.driver.isPresent('convert-dest-address')).toBe(false);

      // --- the swap2 refusal: park on pending_withdrawal, degrade the hop pool, settle ----------
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'ETH');
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      const run2 = await hubOracle(); // fresh: run 1 moved both pools
      // fail_withdrawal does NOT touch the quote curve — the confirm-time re-quote still matches.
      await swapPoolKnob({pool: POOL_VCHF_ICP, fail_withdrawal: true});
      let run2Confirmed = false;
      for (let round = 0; round < 5 && !run2Confirmed; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) { run2Confirmed = true; break; }
      }
      expect(run2Confirmed).toBe(true);
      // swap1 executes (#ok) but its payout row never lands → the honest pending_withdrawal park.
      let parked = false;
      for (let i = 0; i < 40 && !parked; i++) {
        parked = await m.driver.findByTestID('convert-pending', {timeoutMs: 500}).then(() => true).catch(() => false);
      }
      expect(parked).toBe(true);
      // NOW degrade the hop pool: any swap2 pays 5% of its curve — far below the signed floor.
      await swapPoolKnob({pool: POOL_ICP_CKETH, impact_bps: 9500});
      // Drain the queued payout → swap1 confirms → the engine marches into the degraded swap2.
      await swapPoolKnob({pool: POOL_VCHF_ICP, fail_withdrawal: false, settle_pending: true});
      let refused = false;
      for (let i = 0; i < 60 && !refused; i++) {
        refused = await m.driver.findByTestID('convert-failed-leg', {timeoutMs: 300}).then(() => true).catch(() => false);
      }
      expect(refused).toBe(true);
      assertIncludes(m.driver.readText('convert-leg-3-state'), 'Refused', 'the refused leg names itself');
      const failed = m.driver.readText('convert-failed-leg');
      assertIncludes(failed, 'ICP', 'the failure names the HUB asset as the in-wallet position');
      assertIncludes(failed, 'ETH', 'the failure names what the refused leg was bound for');
      expect(m.driver.bodyText()).not.toContain('received in your wallet');
      // Books: swap2 pulled NOTHING — the user holds swap1's gross minus ICP's approve fee.
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(BigInt(2000000000) - 2n * (200000000n + 2n * VCHF_FEE));
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe((gross1 - minOut1 - 2n * ICP_FEE) + (run2.gross1 - ICP_FEE));
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(gross2);
    } finally {
      await restorePoolKnobs();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 196 — the cross-rail gas-fund card', () => {
  it('gates on checksum + re-entry, offers need-vs-have, rechecks, prepends the gas legs', async () => {
    const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const DEST_BAD = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48';
    const DEST_OTHER = DEST.toLowerCase().slice(0, -1) + '3';
    const SEED_ICP = 2000000000n;
    const SEED_ETH = 50000000000000n; // 0.00005 ckETH — below need: gasShort from the start
    const NEED_WEI = 93600000000000n; // fresh feeWei 7.8e13 + 20%
    const F = (n: bigint, d: number): string => {
      const s = BigInt(n).toString().padStart(d + 1, '0');
      return `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, '');
    };

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-crossrail-gas-fund');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, Number(SEED_ICP), {currency: 8});
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, Number(SEED_ETH), {currency: 6});
      expect(fundEth.ok).toBe(true);

      // The fail-closed CCTP stub, then a MUTABLE balance layer on top (last wrap wins).
      installCctpStub({});
      const eth = installMutableEthBalance('0x' + SEED_ETH.toString(16));

      // §1 checksum at entry + the one-time re-type gate.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '5');
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter', {timeoutMs: 3_000});
      await m.driver.click('convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});

      // Shape-valid but checksum-bad: refused AT ENTRY, minimal line, no re-type ask yet.
      await m.driver.type('convert-dest-address', DEST_BAD);
      expect(await m.driver.waitForText('Checksum mismatch', {timeoutMs: 8_000})).toBe(true);
      expect(m.driver.isPresent('convert-dest-address-invalid')).toBe(false);
      expect(await isDisabled(m, 'btn-convert-confirm')).toBe(true);
      expect(m.driver.isPresent('convert-dest-reenter')).toBe(false);

      // Fix the one character: the ask becomes a one-time re-entry that must COMPARE.
      await m.driver.type('convert-dest-address', DEST);
      await m.driver.waitForFunction(() => !m!.driver.isPresent('convert-dest-checksum'), {timeoutMs: 8_000, label: 'the checksum line cleared'});
      await m.driver.findByTestID('convert-dest-reenter', {timeoutMs: 5_000});
      await m.driver.type('convert-dest-reenter', DEST_OTHER);
      expect(await m.driver.waitForText('Does not match', {timeoutMs: 5_000})).toBe(true);
      await m.driver.type('convert-dest-reenter', DEST);
      await m.driver.waitForFunction(() => !m!.driver.isPresent('convert-dest-reenter'), {timeoutMs: 8_000, label: 'the re-type gate passed'});
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-dest-cross-note'), 'also the wallet that signs', 'the destination input warns this address also SIGNS the crossing');

      // §2 the offer card: Need ≈ / Your wallet: (one number per line).
      await m.driver.findByTestID('convert-gas-fund-card', {timeoutMs: 20_000});
      const card = m.driver.readText('convert-gas-fund-card');
      assertIncludes(card, `Need ≈ ${F(NEED_WEI, 18)} ETH`, 'the card names the need (fresh feeWei + headroom)');
      assertIncludes(card, `Your wallet: ${F(SEED_ETH, 18)} ETH`, 'the card names the measured have');
      expect(m.driver.isPresent('convert-gas-preflight')).toBe(false);
      expect(await isDisabled(m, 'btn-gas-fund-wallet')).toBe(false);
      expect(eth.reads()).toBeGreaterThanOrEqual(1);

      // §3 the self path: address, Send ≥, recheck names the shortfall, recheck returns.
      await m.driver.click('btn-gas-fund-self');
      expect(await m.driver.waitForText(`Send ≥ ${F(NEED_WEI, 18)} ETH`, {timeoutMs: 5_000})).toBe(true);
      assertIncludes(m.driver.readText('convert-gas-fund-card'), DEST, 'the self path names the destination to fund');

      eth.set('0x' + 20000000000000n.toString(16));
      await m.driver.click('btn-gas-fund-recheck');
      expect(await m.driver.waitForText(`Still ${F(NEED_WEI - 20000000000000n, 18)} ETH short`, {timeoutMs: 10_000})).toBe(true);

      eth.set('0x' + 1000000000000000n.toString(16));
      await m.driver.click('btn-gas-fund-recheck');
      expect(await m.driver.waitForText('Your wallet: 0.001 ETH', {timeoutMs: 10_000})).toBe(true);

      // §4 the funded path: prepended legs, honest decline.
      const ethBefore = BigInt(await getBalance(account!.publicHex, 6));
      await m.driver.click('btn-gas-fund-wallet');
      for (let round = 0; round < 5; round++) {
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        if (m.driver.isPresent('btn-gas-fund-wallet')) await m.driver.click('btn-gas-fund-wallet');
        else await m.driver.click('btn-convert-confirm');
      }
      await m.driver.findByTestID('convert-gas-legs-note', {timeoutMs: 20_000});
      assertIncludes(m.driver.readText('convert-gas-legs-note'), 'fund the gas', 'the checklist names the gas legs');
      expect(await m.driver.findByTestID('convert-leg-6-state', {timeoutMs: 10_000}).then(() => true).catch(() => false)).toBe(true);
      expect(await m.driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000})).toBe(true);
      const ethAfter = BigInt(await getBalance(account!.publicHex, 6));
      expect(ethAfter > ethBefore).toBe(true);

      // Decline at awaiting_external on a gas-funded record: BOTH assets get their whereabouts.
      await m.driver.click('btn-crossrail-decline', {timeoutMs: 10_000});
      expect(await m.driver.waitForText('Nothing crossed', {timeoutMs: 10_000})).toBe(true);
      const failedCard = m.driver.readText('convert-failed-leg');
      assertIncludes(failedCard, DEST, 'the decline card names the USDC\'s address');
      assertIncludes(failedCard, 'still in this wallet', 'the decline card names where the gas funding sits');

      // Ledger truth: the funding left the wallet and the ckETH net position is UP.
      const icpAfter = BigInt(await getBalance(account!.publicHex, 8));
      expect(icpAfter < SEED_ICP - 500000000n - 10000n).toBe(true);
      expect(icpAfter > 0n).toBe(true);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});


})();


// ═══ ====================================================================================================
// jupiter.test.tsx (its module scope, closure-scoped)
// ═══ ====================================================================================================
(() => {
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
// Shared constants for the cross-rail blocks below (186/200/209 — moved into this file so every
// jupiter-upstream CONFIGURING flow lives in ONE jest worker file; the stub's state is relay-global).
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const VCHF_USDC_POOL = 'hx7nb-diaaa-aaaar-qbxsa-cai';
const SEED_ICP = 2000000000;
const SEED_ETH = 400000000000000;
const ICP_FEE = 10000n;
const CKUSDC_FEE = 10000n;
const CKETH_FEE = 2000000000000n;
const GAS_WEI = 78000000000000n;
const VCHF_FEE = 10000n;
const BURN_HASH = '0x' + '1b'.repeat(32);
const SHIFT_ID = 'e2e-shift-9c1d';

type Quote = {venue_id: string; amount_out: string};
async function relayQuote(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
  return await relayGet(`/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`) as Quote;
}

async function restorePool(): Promise<void> {
  try {
    await swapPoolKnob({pool: CKUSDC_POOL, fee_millionths: 3000, impact_bps: 0, fail_withdrawal: false, settle_pending: true});
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 185 — SOL → USDC(Solana) via Jupiter, end to end, offline', () => {
  it('renders Jupiter\'s digits verbatim, POSTs the verbatim quote, broadcasts once, reports realized', async () => {
    const IN_LAMPORTS = '1000000000';
    const OUT_USDC = '10360000';
    const FLOOR_USDC = '10250000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-jupiter-sol');
      const id = await accountOf(m);
      expect(id).not.toBeNull();

      // Prebuild the venue's deterministic reply for THIS wallet.
      const kp = deriveSolanaKeypair(id!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, USDC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);
      installSolRpcStub({swapDetail: solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(OUT_USDC)})});
      await configureJupiterStub({
        quote: {outAmount: OUT_USDC, otherAmountThreshold: FLOOR_USDC, priceImpact: '0.003'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });

      // The stub's call vectors accumulate per relay process (no reset route) — every count
      // assert below is a DELTA against this baseline (the e2e twin's own-relay isolation,
      // re-expressed for the one shared relay; the gap is filed for the integrator).
      const jup0 = await jupiterStubState();
      expect(jup0).not.toBeNull();

      // §1 the surface is reachable for a SOLANA wallet at all (the V11 gate, now open).
      await openConvertFor(m, 'sol');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → USD', 'heading names the currency pair');
      expect(m.driver.isPresent('convert-venue-jupiter')).toBe(false);

      // §2 Jupiter's own digits, verbatim through the relay proxy.
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});
      const quoteSource = m.driver.readText('convert-quote-source');
      assertIncludes(quoteSource, 'Jupiter', 'attribution names the venue');
      assertIncludes(quoteSource, 'fetched', 'attribution carries the read instant');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('10.36 USDC') === true,
        {timeoutMs: 15_000, label: 'the receive estimate re-keyed to the typed amount'},
      );
      assertIncludes(m.driver.readText('convert-min-out'), '10.25 USDC', 'minimum is otherAmountThreshold verbatim');
      assertIncludes(m.driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown (default 1%)');

      // The census folds behind Details; the fee-note + dpay lines are GONE.
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-rate') && m!.driver.isPresent('convert-pool-principal'),
        {timeoutMs: 15_000, label: 'the census mounted behind Details'},
      );
      assertIncludes(m.driver.readText('convert-rate'), '10.36', 'rate is the only derived figure (BigInt, cross-decimal 9→6)');
      assertIncludes(m.driver.readText('convert-pool-principal'), 'https://lite-api.jup.ag', 'the venue https endpoint is shown where IC shows the pool principal');
      const counterparty = m.driver.readText('convert-counterparty');
      assertIncludes(counterparty, 'Jupiter', 'counterparty line names the venue');
      expect(counterparty.includes('aggregator')).toBe(false);
      assertIncludes(counterparty, 'nobody else signs', 'the Solana signing sentence is present');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'autonomous on-chain aggregator', 'byKey.jupiter disclosure');
      assertIncludes(disclosure, 'not a party', 'dpay party-hood denied');
      assertIncludes(m.driver.readText('convert-sol-impact'), '0.003', 'price impact is Jupiter\'s own figure, unmodified');
      expect(m.driver.isPresent('convert-sol-fees-note')).toBe(false);
      expect(m.driver.isPresent('convert-dpay-fee')).toBe(false);
      assertIncludes(m.driver.readText('convert-refusal'), 'SOL', 'refusal line names the input asset');
      expect(m.driver.isPresent('convert-net')).toBe(false);
      for (const bps of [50, 100, 300]) {
        expect(m.driver.isPresent(`convert-bps-${bps}`)).toBe(false);
      }
      assertIncludes(m.driver.readText('convert-balance'), '5 SOL', 'balance line is the SOL rail balance');

      // §4 confirm: re-quote, verbatim quoteResponse POST, beneficiary-checked venue tx, one broadcast.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);

      // §5 the done panel is honest: the REALIZED chain credit, payout by signature.
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '10.36 USDC', 'done reports the realized token credit');
      assertIncludes(done, 'Payout record:', 'done names the payout record');

      expect(solSentTxs().length).toBe(1);
      const sent = solSentTxs()[0];
      expect(sent.signature.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(sent.signature)).toBe(true);
      assertIncludes(done, sent.signature, 'the payout record IS that signature');

      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const swap = jup!.swapCalls[jup!.swapCalls.length - 1];
      expect(swap.asLegacyTransaction).toBe(true);
      expect(swap.wrapAndUnwrapSol).toBe(true);
      expect(jup!.lastQuoteResponse?.inAmount).toBe(IN_LAMPORTS);
      expect(jup!.lastQuoteResponse?.outAmount).toBe(OUT_USDC);
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      const quoteCalls = jup!.quoteCalls.slice(jup0!.quoteCalls.length);
      expect(quoteCalls.length).toBeGreaterThanOrEqual(1);
      // The sheet's Max prefill legitimately quotes the FULL balance on open; every quote AFTER
      // that prefill must be at the typed amount.
      const postPrefill = [...quoteCalls];
      while (postPrefill.length > 0 && postPrefill[0].amount === '5000000000') postPrefill.shift();
      for (const q of postPrefill) {
        expect(q.inputMint).toBe(WRAPPED_SOL_MINT);
        expect(q.outputMint).toBe(USDC_MINT);
        expect(q.amount).toBe(IN_LAMPORTS);
        expect(q.slippageBps).toBe('100');
      }
      expect(postPrefill[postPrefill.length - 1]?.amount).toBe(IN_LAMPORTS);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});

describe('flow 189 — the out-destination picker: SOL → EURC via jupiter-eurc', () => {
  it('defaults unchanged, re-targets the pair on pick, and lands the realized EURC credit', async () => {
    const IN_LAMPORTS = '1000000000';
    const OUT_EURC = '84120000';
    const FLOOR_EURC = '83000000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-jupiter-sol-eurc');
      const id = await accountOf(m);
      expect(id).not.toBeNull();

      const kp = deriveSolanaKeypair(id!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, EURC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);
      installSolRpcStub({swapDetail: solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(OUT_EURC), mint: EURC_MINT})});
      await configureJupiterStub({
        quote: {outAmount: OUT_EURC, otherAmountThreshold: FLOOR_EURC, priceImpact: '0.003'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });

      const jup0 = await jupiterStubState();
      expect(jup0).not.toBeNull();

      // §1 the standing target is the registry-row-0 venue's other side (USD — flow 185's pair).
      await openConvertFor(m, 'sol');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'EUR');
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → EUR', 'the heading names the picked pair');

      // §3 Jupiter's digits for the EURC pair, verbatim through the relay proxy.
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});
      assertIncludes(m.driver.readText('convert-quote-source'), 'Jupiter', 'attribution names the venue');
      assertIncludes(m.driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('84.12 EURC') === true,
        {timeoutMs: 15_000, label: 'the receive estimate re-keyed to the typed amount'},
      );
      assertIncludes(m.driver.readText('convert-min-out'), '83 EURC', 'minimum is otherAmountThreshold verbatim');
      assertIncludes(m.driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-rate') && m!.driver.isPresent('convert-sol-impact'),
        {timeoutMs: 15_000, label: 'the census mounted behind Details'},
      );
      assertIncludes(m.driver.readText('convert-rate'), '84.12', 'rate is the only derived figure');
      assertIncludes(m.driver.readText('convert-pool-principal'), 'https://lite-api.jup.ag', 'the venue https endpoint is shown');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Jupiter', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'nobody else signs', 'the Solana signing sentence is present');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'autonomous on-chain aggregator', 'byKey.jupiter disclosure (shared key)');
      assertIncludes(disclosure, 'not a party', 'dpay party-hood denied');
      assertIncludes(m.driver.readText('convert-sol-impact'), '0.003', 'price impact is Jupiter\'s own figure');
      expect(m.driver.isPresent('convert-sol-fees-note')).toBe(false);
      expect(m.driver.isPresent('convert-dpay-fee')).toBe(false);
      expect(m.driver.isPresent('convert-net')).toBe(false);
      assertIncludes(m.driver.readText('convert-balance'), '5 SOL', 'balance line is the SOL rail balance');

      // §4 confirm → one broadcast; §5 the realized EURC credit.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '84.12 EURC', 'done reports the realized token credit');
      assertIncludes(done, 'Payout record:', 'done names the payout record');

      expect(solSentTxs().length).toBe(1);
      const sent = solSentTxs()[0];
      expect(sent.signature.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(sent.signature)).toBe(true);
      assertIncludes(done, sent.signature, 'the payout record IS that signature');

      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const swap = jup!.swapCalls[jup!.swapCalls.length - 1];
      expect(swap.asLegacyTransaction).toBe(true);
      expect(swap.wrapAndUnwrapSol).toBe(true);
      expect(jup!.lastQuoteResponse?.inAmount).toBe(IN_LAMPORTS);
      expect(jup!.lastQuoteResponse?.outputMint).toBe(EURC_MINT);
      expect(jup!.lastQuoteResponse?.outAmount).toBe(OUT_EURC);
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      const quoteCalls = jup!.quoteCalls.slice(jup0!.quoteCalls.length);
      expect(quoteCalls.length).toBeGreaterThanOrEqual(1);
      // Pre-pick calls legitimately quote the STANDING pair; every post-pick call names EURC.
      const postPick = quoteCalls.filter((q) => q.outputMint === EURC_MINT && q.amount !== '5000000000');
      expect(postPick.length).toBeGreaterThanOrEqual(1);
      for (const q of postPick) {
        expect(q.inputMint).toBe(WRAPPED_SOL_MINT);
        expect(q.outputMint).toBe(EURC_MINT);
        expect(q.amount).toBe(IN_LAMPORTS);
        expect(q.slippageBps).toBe('100');
      }
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});

describe('flow 193 — the rail-local FX pair: USDC(Solana) → EURC via jupiter-usdc-eurc', () => {
  it('stands stable-first USD→EUR, re-targets on pick, and lands the realized EURC credit', async () => {
    const IN_MICRO = '1000000';
    const OUT_EURC = '870000';
    const FLOOR_EURC = '855000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-jupiter-usdc-eurc');
      const id = await accountOf(m);
      expect(id).not.toBeNull();

      const kp = deriveSolanaKeypair(id!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, EURC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);
      installSolRpcStub({swapDetail: solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(OUT_EURC), mint: EURC_MINT})});
      await configureJupiterStub({
        quote: {outAmount: OUT_EURC, otherAmountThreshold: FLOOR_EURC, priceImpact: '0.000002'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });

      const jup0 = await jupiterStubState();
      expect(jup0).not.toBeNull();

      // §1 the standing target is stable-first (USD → EUR through the FX venue).
      await openConvertFor(m, 'sol-usdc');
      await m.driver.findByTestID('convert-screen', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-screen'), 'Convert USD → EUR', 'the standing pair is USD→EUR (stable-first)');

      // §2 Jupiter's digits for the standing FX pair, verbatim.
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});
      assertIncludes(m.driver.readText('convert-quote-source'), 'Jupiter', 'attribution names the venue');
      assertIncludes(m.driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.87 EURC') === true,
        {timeoutMs: 15_000, label: 'the receive estimate re-keyed to the typed amount'},
      );
      assertIncludes(m.driver.readText('convert-min-out'), '0.855 EURC', 'minimum is otherAmountThreshold verbatim');
      assertIncludes(m.driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-rate') && m!.driver.isPresent('convert-sol-impact'),
        {timeoutMs: 15_000, label: 'the census mounted behind Details'},
      );
      assertIncludes(m.driver.readText('convert-rate'), '0.87', 'rate is the only derived figure (6→6 decimals)');
      assertIncludes(m.driver.readText('convert-pool-principal'), 'https://lite-api.jup.ag', 'the venue https endpoint is shown');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Jupiter', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'nobody else signs', 'the Solana signing sentence is present');
      const disclosure = m.driver.readText('convert-venue-disclosure');
      assertIncludes(disclosure, 'autonomous on-chain aggregator', 'byKey.jupiter disclosure');
      assertIncludes(disclosure, 'not a party', 'dpay party-hood denied');
      assertIncludes(m.driver.readText('convert-sol-impact'), '0.000002', 'price impact is Jupiter\'s own figure, unmodified');
      expect(m.driver.isPresent('convert-sol-fees-note')).toBe(false);
      expect(m.driver.isPresent('convert-dpay-fee')).toBe(false);
      expect(m.driver.isPresent('convert-net')).toBe(false);
      // Fork #4: the balance line is the CURRENCY-unit summed figure (USD across the rails).
      assertIncludes(m.driver.readText('convert-balance'), '$2.50', 'balance line is the currency-unit figure');

      // §4 confirm → one broadcast; §5 the realized EURC credit.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 60_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.87 EURC', 'done reports the realized token credit');
      assertIncludes(done, 'Payout record:', 'done names the payout record');

      expect(solSentTxs().length).toBe(1);
      const sent = solSentTxs()[0];
      expect(sent.signature.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(sent.signature)).toBe(true);
      assertIncludes(done, sent.signature, 'the payout record IS that signature');

      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const swap = jup!.swapCalls[jup!.swapCalls.length - 1];
      expect(swap.asLegacyTransaction).toBe(true);
      expect(swap.wrapAndUnwrapSol).toBe(true);
      expect(jup!.lastQuoteResponse?.inAmount).toBe(IN_MICRO);
      expect(jup!.lastQuoteResponse?.inputMint).toBe(USDC_MINT);
      expect(jup!.lastQuoteResponse?.outputMint).toBe(EURC_MINT);
      expect(jup!.lastQuoteResponse?.outAmount).toBe(OUT_EURC);
      expect(jup!.lastQuoteResponse?.platformFee).toBeNull();
      const quoteCalls = jup!.quoteCalls.slice(jup0!.quoteCalls.length);
      expect(quoteCalls.length).toBeGreaterThanOrEqual(1);
      const postPrefill = [...quoteCalls];
      while (postPrefill.length > 0 && postPrefill[0].amount === '2500000') postPrefill.shift();
      for (const q of postPrefill) {
        expect(q.inputMint).toBe(USDC_MINT);
        expect(q.outputMint).toBe(EURC_MINT);
        expect(q.amount).toBe(IN_MICRO);
        expect(q.slippageBps).toBe('100');
      }
      expect(postPrefill[postPrefill.length - 1]?.amount).toBe(IN_MICRO);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 240_000);
});
describe('flow 186 — Route C: ICP → SOL via USDC as one cross-rail intent', () => {
  it('hands off keyless, parks honestly on a stall, resumes from the mint watch, lands SOL', async () => {
    const ROUTE_C_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
    const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const SOL_OUT = '260000000';
    const SOL_FLOOR = '257000000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-crossrail-icp-sol');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, SEED_ETH, {currency: 6});
      expect(fundEth.ok).toBe(true);

      // Prebuild the deterministic venue + mint fixtures for THIS wallet.
      const kp = deriveSolanaKeypair(account!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, USDC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);

      // The census oracle BEFORE anything renders.
      const oracle0 = await relayQuote(CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, 500000000n);
      let gross = BigInt(oracle0.amount_out);
      let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
      let fees = cctpFeeExpectations(minOut);
      const mintCredit = fees.mintFloor;

      const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(mintCredit)});
      const nativeDetail = {
        transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
        meta: {preBalances: [1000000000], postBalances: [1000000000 + Number(SOL_OUT)], preTokenBalances: [], postTokenBalances: []},
        slot: 250000001, blockTime: null, version: 'legacy',
      };
      installSolRpcStub({forwardTxHash: FORWARD_TX_HASH, tokenDetail, swapDetail: nativeDetail});
      const jup0 = await jupiterStubState();
      await configureJupiterStub({
        quote: {outAmount: SOL_OUT, otherAmountThreshold: SOL_FLOOR, priceImpact: '0.001'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });
      installCctpStub({forwardTxHash: FORWARD_TX_HASH});
      installEvmSignSeam(BURN_HASH);

      // §1 the composed route is an explicit opt-in row behind the expander.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'SOL');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      expect(await m.driver.findByTestID(ROUTE_C_ROW, {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(true);
      await m.driver.click(ROUTE_C_ROW);
      await typeConvertAmount(m, '5');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.type('convert-dest-address', DEST);
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-dest-cross-note'), 'also the wallet that signs', 'the destination input warns that this address also SIGNS the crossing');
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the route floor is the burn amount, in the HOP asset');

      // §2 the cross-rail fee census (the census lines mount behind Details).
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('crossrail-external-gas') && m!.driver.isPresent('crossrail-circle-fee') && m!.driver.isPresent('crossrail-mint-floor'),
        {timeoutMs: 15_000, label: 'the cross-rail census mounted'},
      );
      assertIncludes(m.driver.readText('crossrail-external-gas'), 'your wallet', 'the census names WHO pays the EVM gas');
      assertIncludes(m.driver.readText('crossrail-circle-fee'), `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s published fee renders as its own census line');
      assertIncludes(m.driver.readText('crossrail-mint-floor'), `${fmt(fees.mintFloor, 6)} USDC`, 'the mint floor names what survives the fee');
      assertIncludes(m.driver.readText('convert-gas-note'), `${fmt(GAS_WEI, 18)} ETH`, 'the minter gas line is unchanged from Route A');

      // Confirm (quote-changed interrupt → re-review, re-deriving the oracle after a move).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        const re = await relayQuote(CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, 500000000n);
        gross = BigInt(re.amount_out);
        minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
        fees = cctpFeeExpectations(minOut);
      }

      // §3 the handoff: five device-signed IC legs, then dpay renders the EXACT txs.
      expect(await m.driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000})).toBe(true);
      await m.driver.waitForText('Step 1', {timeoutMs: 10_000});
      expect(m.driver.isPresent('crossrail-handoff')).toBe(true);
      const handoff = m.driver.readText('crossrail-handoff');
      assertIncludes(handoff, `${fmt(minOut, 6)} USDC`, 'the intro names the crossed amount (the burn floor)');
      assertIncludes(handoff, 'Nothing is signed on dpay', 'the what-signing line says dpay signs nothing');
      const approveData = m.driver.readText('crossrail-approve-calldata');
      const burnData = m.driver.readText('crossrail-burn-calldata');
      assertIncludes(approveData.slice(0, 10), '0x095ea7b3', 'tx 1 is a plain ERC-20 approve');
      assertIncludes(burnData.slice(0, 10), '0x779b432d', 'tx 2 is depositForBurnWithHook');
      assertIncludes(handoff, 'seconds to a few minutes', 'the timing note sets the honest expectation');
      assertIncludes(handoff, `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s fee line renders in the handoff too');

      // The wallet double signs, the app attaches the reported hash.
      await m.driver.type('crossrail-burn-tx', 'signed');
      for (let i = 0; i < 3; i++) {
        try {
          await m.driver.click('btn-crossrail-attach', {timeoutMs: 5_000});
          break;
        } catch (e) {
          if (i === 2) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 10_000});

      // §4 the mint watch: parked pending with Circle's link — never a false failure.
      const crossing = m.driver.readText('crossrail-crossing');
      assertIncludes(crossing, 'Crossing to Solana', 'the crossing panel titles the wait');
      assertIncludes(crossing, BURN_HASH, 'the burn tx hash is visible and copyable');
      assertIncludes(m.driver.readText('crossrail-still'), 'not failed', 'the not-failed line is explicit');
      expect(m.driver.isPresent('btn-crossrail-view-circle')).toBe(true);
      expect(m.driver.isPresent('btn-crossrail-view-burn')).toBe(true);
      const sigs = evmSignsRecorded();
      expect(sigs.length).toBe(1);
      assertIncludes(String(sigs[0].burnCalldata).slice(0, 10), '0x779b432d', 'what dpay asked the wallet to sign IS the burn calldata');
      assertIncludes(String(sigs[0].approveCalldata).slice(0, 10), '0x095ea7b3', '…and the approve calldata');
      expect(String(sigs[0].burnTo).toLowerCase()).toContain('28b5a0e9c621a5badaa536219b3a228c8168cf5d');
      expect(String(sigs[0].approveTo).toLowerCase()).toContain('a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      expect(String(sigs[0].amountSubunits)).toBe(minOut.toString());

      // The STALL: state still pending — the record must stay parked, not failed.
      const pollsAtStall = cctpStubState().messageCalls.length;
      await m.driver.waitForFunction(
        () => cctpStubState().messageCalls.length > pollsAtStall,
        {timeoutMs: 15_000, label: 'the mint watch polls again while parked'},
      );
      expect(m.driver.isPresent('crossrail-crossing')).toBe(true);
      const cctpBeforeReload = cctpStubState();

      // §5 reload: the engine resumes from the MINT WATCH; the IC legs are never re-signed.
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      const ethBefore = BigInt(await getBalance(account!.publicHex, 6));
      await m.remount();
      // The window stubs live on globalThis and survive the remount (jest's one-context model).
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});
      const readLegs = async (n: number): Promise<string[]> => {
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push(m!.driver.readText(`convert-leg-${i}-state`));
        return out;
      };
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-leg-5-state'),
        {timeoutMs: 15_000, label: 'the six-leg list rendered after the resume'},
      );
      const legsAfterReload = await readLegs(6);
      for (let i = 0; i < 5; i++) {
        assertIncludes(legsAfterReload[i], 'Confirmed', `after reload IC leg ${i} reads Confirmed (resumed, not re-signed)`);
      }
      assertIncludes(legsAfterReload[5], 'Sent', 'the cctp_burn leg reads Sent (hash known, mint watched)');
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(ethBefore);

      // §6 the mint lands: Circle reports complete, dpay CORROBORATES at the ATA, then SOL.
      setCctpMessageState('complete');
      await m.driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('crossrail-sol-out'), {timeoutMs: 15_000, label: 'the final leg\'s estimate rendered'});
      const ready = m.driver.readText('crossrail-sol-ready');
      assertIncludes(ready, `${fmt(mintCredit, 6)} USDC`, 'the verified mint credit renders (corroborated at the ATA)');
      assertIncludes(ready, ataString, 'the USDC location is named: the user\'s own ATA');
      assertIncludes(ready, 'it is yours either way', 'keeping the USDC is offered as an equal exit');
      assertIncludes(m.driver.readText('crossrail-sol-out'), fmt(SOL_OUT, 9), 'the fresh Jupiter estimate renders (SOL now, not USDC)');
      assertIncludes(ready, `${fmt(SOL_FLOOR, 9)} SOL`, 'the final leg\'s floor is Jupiter\'s own otherAmountThreshold');

      await m.driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('verified on-chain', {timeoutMs: 60_000})).toBe(true);
      await m.driver.findByTestID('convert-done', {timeoutMs: 15_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt(SOL_OUT, 9)} SOL`, 'done reports the REALIZED native credit');
      assertIncludes(done, kp.address, 'the Solana address is named');
      for (let i = 0; i < 7; i++) {
        assertIncludes(m.driver.readText(`convert-leg-${i}-state`), 'Confirmed', `final leg ${i} of 7 reads Confirmed`);
      }

      // Stub audits + ledger truth.
      expect(solSentTxs().length).toBe(1);
      assertIncludes(done, solSentTxs()[0].signature, 'the payout record IS the broadcast signature');
      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const finalLegQuotes = jup!.quoteCalls.slice(jup0!.quoteCalls.length)
        .filter((q) => q.inputMint === USDC_MINT && q.outputMint === 'So11111111111111111111111111111111111111112');
      expect(finalLegQuotes.length).toBeGreaterThanOrEqual(1);
      expect(finalLegQuotes[finalLegQuotes.length - 1].amount).toBe(mintCredit.toString());
      const cctpAfter = cctpStubState();
      expect(cctpAfter.unexpected.length).toBe(0);
      expect(cctpBeforeReload.feesCalls + cctpAfter.feesCalls).toBeGreaterThanOrEqual(2);
      const allMessageCalls = [...cctpBeforeReload.messageCalls, ...cctpAfter.messageCalls];
      expect(allMessageCalls.length).toBeGreaterThanOrEqual(2);
      for (const msg of allMessageCalls) {
        expect(msg.hash).toBe(BURN_HASH);
      }
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP) - 500000000n - 2n * ICP_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 2))).toBe(gross - minOut - CKUSDC_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(BigInt(SEED_ETH) - GAS_WEI - CKETH_FEE);
    } finally {
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});


describe('flow 209 — the Stop on the later legs: crossing, sol_ready, and provider stops', () => {
  it('stops honestly at each phase, freezes the watches, and stays aborted across a reload', async () => {
    const ROUTE_C_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
    const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const BURN_209 = '0x' + '3c'.repeat(32);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-abort-cefi');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, SEED_ETH, {currency: 6});
      expect(fundEth.ok).toBe(true);

      const kp = deriveSolanaKeypair(account!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, USDC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, ataString);
      const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: 2400000});
      const nativeDetail = {
        transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
        meta: {preBalances: [1000000000], postBalances: [1000000000], preTokenBalances: [], postTokenBalances: []},
        slot: 250000001, blockTime: null, version: 'legacy',
      };
      installSolRpcStub({forwardTxHash: FORWARD_TX_HASH, tokenDetail, swapDetail: nativeDetail});
      installCctpStub({forwardTxHash: FORWARD_TX_HASH});
      const jup0 = await jupiterStubState();
      await configureJupiterStub({
        quote: {outAmount: '260000000', otherAmountThreshold: '257000000', priceImpact: '0.001'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });
      installEvmSignSeam(BURN_209);

      /** One Route C run up to a LIVE crossing (the 209 helper). */
      const attachBurnAndGetCrossing = async (amountText: string): Promise<void> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await typeConvertAmount(m!, amountText).catch(() => undefined);
          await m!.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
          await m!.driver.type('convert-dest-address', DEST);
          await m!.driver.findByTestID('convert-route-min', {timeoutMs: 20_000});
          await m!.driver.click('btn-convert-confirm');
          const changed = await m!.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
          if (changed == null) break;
          await m!.driver.click('btn-convert-back', {timeoutMs: 5_000}).catch(() => undefined);
        }
        await m!.driver.findByTestID('crossrail-handoff', {timeoutMs: 90_000});
        await m!.driver.waitForText('Step 1', {timeoutMs: 15_000});
        await m!.driver.type('crossrail-burn-tx', 'signed');
        for (let i = 0; i < 3; i++) {
          try {
            await m!.driver.click('btn-crossrail-attach', {timeoutMs: 5_000});
            break;
          } catch (e) {
            if (i === 2) throw e;
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        await m!.driver.findByTestID('crossrail-crossing', {timeoutMs: 20_000});
      };

      // §B the CROSSING STOP: the burn is out — watching, never "nothing moved".
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await openOtherVenues(m);
      await m.driver.click(ROUTE_C_ROW, {timeoutMs: 5_000});
      await attachBurnAndGetCrossing('5');
      await m.driver.waitForFunction(
        () => cctpStubState().messageCalls.length > 0,
        {timeoutMs: 15_000, label: 'the mint watch polls Circle at least once'},
      );
      expect(m.driver.isPresent('btn-convert-stop')).toBe(true);
      assertIncludes(m.driver.readText('btn-convert-stop'), 'Stop watching', 'the crossing stop is honestly labeled watching');
      await m.driver.click('btn-convert-stop', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-aborted', {timeoutMs: 15_000});
      const crossingAborted = m.driver.readText('convert-aborted');
      assertIncludes(crossingAborted, 'may still complete the mint', 'the crossing aborted card never claims nothing moved');
      assertIncludes(crossingAborted, ataString, 'the card names where the funds land: the user\'s OWN ATA');
      const pollsAtAbort = cctpStubState().messageCalls.length;
      await new Promise((r) => setTimeout(r, 2500));
      expect(cctpStubState().messageCalls.length - pollsAtAbort).toBe(0);

      // §C the SOL_READY STOP: the final leg was never signed — clean.
      await m.driver.click('btn-convert-back', {timeoutMs: 8_000});
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      await openOtherVenues(m);
      await m.driver.click(ROUTE_C_ROW, {timeoutMs: 5_000});
      await attachBurnAndGetCrossing('5');
      setCctpMessageState('complete');
      await m.driver.findByTestID('crossrail-sol-ready', {timeoutMs: 40_000});
      expect(m.driver.isPresent('btn-convert-stop')).toBe(true);
      await m.driver.click('btn-convert-stop', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-aborted', {timeoutMs: 15_000});
      const readyAborted = m.driver.readText('convert-aborted');
      assertIncludes(readyAborted, 'Nothing was signed', 'the sol_ready stop is honestly CLEAN');
      assertIncludes(readyAborted, 'final swap never ran', 'the card names what was skipped');
      assertIncludes(readyAborted, ataString, 'the card names where the USDC sits');
      expect(solSentTxs().length).toBe(0);

      // §A the PROVIDER STOP on awaiting_deposit.
      const sideshift0 = await sideshiftRelayHits();
      installSideShiftStub({initialStatus: 'waiting'});
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(m, 'SOL');
      const icpBeforeCefi = BigInt(await getBalance(account!.publicHex, 8));
      await typeConvertAmount(m, '3');
      try {
        await m.driver.waitForFunction(
          () => m!.driver.readTextSafe('convert-headline')?.includes('0.0495 SOL') === true,
          {timeoutMs: 20_000, label: 'the cefi quote rendered before the confirm'},
        );
      } catch (e) {
        console.log('    [209-dbg] body:', JSON.stringify(m.driver.bodyText()).slice(0, 1200));
        throw e;
      }
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 15_000});
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      await m.driver.waitForFunction(
        () => (sideShiftStubState()?.statusCalls.length ?? 0) > 0,
        {timeoutMs: 15_000, label: 'the provider watch polls the venue at least once'},
      );
      expect(m.driver.isPresent('btn-convert-stop')).toBe(true);
      await m.driver.click('btn-convert-stop', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-aborted', {timeoutMs: 15_000});
      const providerAborted = m.driver.readText('convert-aborted');
      assertIncludes(providerAborted, 'never sent the deposit', 'the aborted card carries the unfunded-order truth');
      assertIncludes(providerAborted, 'may still settle', 'the aborted card carries the deposit-already-sent truth');
      assertIncludes(providerAborted, SHIFT_ID, 'the venue shift id renders');
      expect(m.driver.isPresent('btn-convert-stop')).toBe(false);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBeforeCefi);

      // Reload: the records STAY aborted, the watch never comes back, the order is not re-created.
      await m.remount();
      const storeAfterReload = await AsyncStorage.getItem(`dpay.convert.v3.${account!.publicHex}`);
      expect(storeAfterReload).not.toBeNull();
      expect(storeAfterReload).toContain('"step":"aborted"');
      const pollsAtReload = sideShiftStubState()?.statusCalls.length ?? 0;
      await new Promise((r) => setTimeout(r, 2500));
      expect((sideShiftStubState()?.statusCalls.length ?? 0)).toBe(pollsAtReload);
      expect((await sideshiftRelayHits()).shiftCalls - sideshift0.shiftCalls).toBe(1);

      const icpEnd = BigInt(await getBalance(account!.publicHex, 8));
      expect(icpEnd).toBeLessThan(BigInt(SEED_ICP));
      expect((await jupiterStubState())!.swapCalls.length - jup0!.swapCalls.length).toBe(0);
    } finally {
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 200 — VCHF → SOL Route C with the whole venue chain named before anything signs', () => {
  it('names the chain at the picker + census, reads the floor as mid-stop, attributes the receipt', async () => {
    const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const BURN_HASH = '0x' + 'c7'.repeat(32);
    const SOL_OUT = '260000000';
    const SOL_FLOOR = '257000000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The SOL rail must be CONFIGURED before boot (the e2e twin's setup({solStub:true})):
      // the mint-watch corroboration and the final leg ride the rail's own RPC path.
      await enableSolRail();
      m = await onboardWallet('jest-crossrail-vchf-sol');
      const account = await accountOf(m);
      const fundVchf = await faucetAccount(account!.publicHex, 50000000000, {currency: 7}); // 500 VCHF
      expect(fundVchf.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, 400000000000000, {currency: 6});
      expect(fundEth.ok).toBe(true);

      // The deterministic venue + mint fixtures for THIS wallet.
      const kp = deriveSolanaKeypair(account!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
      const txBytes = jupiterSwapTxB64(kp.address, ataString);

      // The census oracle BEFORE anything renders.
      const oracle0 = await relayQuote(VCHF_USDC_POOL, VCHF_LEDGER, CKUSDC_LEDGER, 1000000000n);
      let gross = BigInt(oracle0.amount_out);
      let minOut = floor99(gross);
      let fees = cctpFeeExpectations(minOut);
      const mintCredit = fees.mintFloor;

      const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(mintCredit)});
      const nativeDetail = {
        transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
        meta: {preBalances: [1000000000], postBalances: [1000000000 + Number(SOL_OUT)], preTokenBalances: [], postTokenBalances: []},
        slot: 250000001, blockTime: null, version: 'legacy',
      };
      installSolRpcStub({forwardTxHash: FORWARD_TX_HASH, tokenDetail, swapDetail: nativeDetail});
      const jup0 = await jupiterStubState();
      await configureJupiterStub({
        quote: {outAmount: SOL_OUT, otherAmountThreshold: SOL_FLOOR, priceImpact: '0.001'},
        userPublicKey: kp.address,
        txB64: txBytes,
        lastValidBlockHeight: 300000000,
      });
      installCctpStub({forwardTxHash: FORWARD_TX_HASH});
      installEvmSignSeam(BURN_HASH);

      // §1 the composed route: explicit opt-in; the destination input renders on pick.
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'SOL');
      await typeConvertAmount(m, '10');
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp:jupiter', {timeoutMs: 10_000});
      await m.driver.click('convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp:jupiter', {timeoutMs: 10_000});
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await m.driver.type('convert-dest-address', DEST);
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 20_000});
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the route floor is the burn amount, in the HOP asset');

      // §2 the review census: full chain + the destination's own estimate (the fee lines land
      // async behind Details — wait for the census to mount before reading it).
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('convert-route-venues') && m!.driver.isPresent('crossrail-circle-fee'),
        {timeoutMs: 15_000, label: 'the census lines mounted behind Details'},
      );
      assertIncludes(m.driver.readText('convert-route-venues'), 'Route: ICPSwap → Circle CCTP → Jupiter', 'the census names the FULL venue chain in one line');
      assertIncludes(m.driver.readText('crossrail-circle-fee'), `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s published fee renders as its own census line');
      const floorLine = m.driver.readText('crossrail-mint-floor');
      assertIncludes(floorLine, `${fmt(fees.mintFloor, 6)} USDC`, 'the mint floor names what survives the fee, in the HOP asset');
      assertIncludes(floorLine, 'crosses to your Solana address', 'the floor line reads USDC as the MID-STOP');
      assertIncludes(floorLine, 'final step swaps it on', 'the floor line names the onward swap');
      await m.driver.findByTestID('crossrail-dest-estimate', {timeoutMs: 10_000});
      const estimateLine = m.driver.readText('crossrail-dest-estimate');
      assertIncludes(estimateLine, '≈', 'the estimate is labeled an ESTIMATE, never a promise');
      assertIncludes(estimateLine, `${fmt(SOL_OUT, 9)} SOL`, 'the estimate names the DESTINATION asset and figure');
      assertIncludes(estimateLine, 'Jupiter', 'the estimate names the venue that will produce the fresh final quote');

      // Confirm (quote-changed interrupt → re-review).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        const re = await relayQuote(VCHF_USDC_POOL, VCHF_LEDGER, CKUSDC_LEDGER, 1000000000n);
        gross = BigInt(re.amount_out);
        minOut = floor99(gross);
        fees = cctpFeeExpectations(minOut);
      }

      // §3 the handoff keeps the mid-stop phrasing.
      expect(await m.driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000})).toBe(true);
      await m.driver.waitForText('Step 1', {timeoutMs: 10_000});
      const handoff = m.driver.readText('crossrail-handoff');
      assertIncludes(handoff, `${fmt(minOut, 6)} USDC`, 'the intro names the crossed amount (the burn floor)');
      assertIncludes(handoff, `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s fee line renders in the handoff too');
      assertIncludes(handoff, `${fmt(fees.mintFloor, 6)} USDC`, 'the handoff floor line carries the hop-asset figure');
      assertIncludes(handoff, 'crosses to your Solana address', 'the handoff floor line reads USDC as the MID-STOP');

      // The wallet double signs, the app attaches the reported hash.
      await m!.driver.type('crossrail-burn-tx', 'signed');
      for (let i = 0; i < 3; i++) {
        try {
          await m!.driver.click('btn-crossrail-attach', {timeoutMs: 5_000});
          break;
        } catch (e) {
          if (i === 2) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      await m!.driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});

      // §4 the mint lands, then the final leg's offer.
      setCctpMessageState('complete');
      await m.driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('crossrail-sol-out'),
        {timeoutMs: 15_000, label: 'the final leg\'s Jupiter estimate rendered'},
      );
      const ready = m.driver.readText('crossrail-sol-ready');
      assertIncludes(ready, `${fmt(mintCredit, 6)} USDC`, 'the verified mint credit renders');
      assertIncludes(m.driver.readText('crossrail-sol-out'), fmt(SOL_OUT, 9), 'the final leg\'s fresh Jupiter estimate renders in SOL');

      await m.driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('verified on-chain', {timeoutMs: 60_000})).toBe(true);
      await m.driver.findByTestID('convert-done', {timeoutMs: 15_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt(SOL_OUT, 9)} SOL`, 'done reports the REALIZED native credit');
      assertIncludes(done, kp.address, 'the Solana address is named');
      assertIncludes(m.driver.readText('crossrail-done-via'), 'ICPSwap, Circle and Jupiter', 'the done receipt attributes the conversion to all three');

      // Stub audits + ledger truth.
      expect(solSentTxs().length).toBe(1);
      assertIncludes(done, solSentTxs()[0].signature, 'the payout record IS the broadcast signature');
      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(BigInt(50000000000) - 1000000000n - 2n * VCHF_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 2))).toBe(gross - minOut - CKUSDC_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(BigInt(400000000000000) - GAS_WEI - CKETH_FEE);
    } finally {
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

})();


// ═══ ====================================================================================================
// cefi.test.tsx (its module scope, closure-scoped)
// ═══ ====================================================================================================
(() => {
const DEPOSIT_ADDRESS = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // the stub's valid ICRC-1 account text
const DEPOSIT_ADDRESS_SIDESHIFT = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const DEPOSIT_ADDRESS_TROCADOR = 'e2e-trocador-deposit-01';
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const constants = require('../../../config/constants') as {solanaRpcUrl: () => string};
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AS = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};
      const storedSol = await AS.getItem('dpay.solanaRpc.v1');
      console.log('    [187-probe] solanaRpcUrl:', constants.solanaRpcUrl(), '| stored:', storedSol);
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
      if (st!.unexpected.length > 0) {
        console.log('    [187-dbg] unexpected sample:', JSON.stringify(st!.unexpected.slice(0, 4)));
      }
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
      // Knob hygiene: the no-quote arming is relay-global — flow 198 quotes Trocador next.
      try {
        await trocadorConfig({no_quote: false});
      } catch { /* the relay itself dying reports at the assertions that matter */ }
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
describe('flow 197 — EURC(Solana) → ICP via sideshift-eurc from the SOL surface', () => {
  it('offers the cefi target, pays at the derived IC identifier, hands off with zero broadcasts', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-sol-cefi-eurc');
      const account = await accountOf(m);
      expect(account).not.toBeNull();
      const kp = deriveSolanaKeypair(account!.secretHex);
      expect(kp.address.length).toBeGreaterThanOrEqual(32);

      installSolRpcStub({refuseSend: true});
      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await sideshiftRelayHits();

      // §1 the standing target is stable-first USD; the ICP target carries the cefi venue.
      await openConvertFor(m, 'sol-eurc', {timeoutMs: 8_000});
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      expect(m.driver.isPresent('convert-unavailable')).toBe(false);
      assertIncludes(m.driver.readText('convert-screen'), 'Convert EUR → USD', 'the standing pair is EUR→USD (stable-first)');

      // §2 the cefi target: derived payout address FIRST, venue quote verbatim.
      await pickSwapTarget(m, 'ICP');
      assertIncludes(m.driver.readText('convert-screen'), 'Convert EUR → ICP', 'the heading names the picked pair');
      await typeConvertAmount(m, '2');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.0495 ICP') === true,
        {timeoutMs: 20_000, label: 'the venue settle figure rendered (the rate arrived)'},
      );
      assertIncludes(m.driver.readText('convert-quote-source'), 'SideShift', 'attribution names the venue');
      assertIncludes(m.driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      const settle = m.driver.readText('convert-settle-address');
      const expectedSettleId = await icpAccountIdHex(account!.publicHex);
      expect(settle).toBe(expectedSettleId);
      expect(m.driver.isPresent('convert-slippage')).toBe(false);
      expect(m.driver.isPresent('convert-min-out')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-counterparty'), {timeoutMs: 15_000, label: 'the census mounted'});
      assertIncludes(m.driver.readText('convert-counterparty'), 'SideShift', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'automated exchange service', 'not a licensed provider');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Nothing is signed on this phone', 'the cefi signing sentence: the deposit is a handoff');
      assertIncludes(m.driver.readText('convert-venue-disclosure'), 'sideshift.ai/terms', 'the venue disclosure is present');
      expect(m.driver.isPresent('convert-pool-principal')).toBe(false);

      // §3 confirm → the fixed ORDER; the handoff is the venue's address.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}).then(() => true).catch(() => false)).toBe(true);
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS_SIDESHIFT, 'the venue deposit address renders verbatim');
      const handoff = m.driver.readText('convert-deposit-handoff');
      assertIncludes(handoff, '2 EURC', 'the exact deposit amount renders in the deposit asset');
      assertIncludes(handoff, 'exactly the deposit amount', 'the handoff says what to send');
      assertIncludes(handoff, 'not a party', 'dpay party-hood denied');
      expect(m.driver.isPresent('convert-deposit-sol-fee-note')).toBe(true);
      expect(await m.driver.waitForText('Converted', {timeoutMs: 1_000}).catch(() => false)).toBe(false);
      expect(solSentTxs().length).toBe(0);

      // §4 the partner-key audit.
      const hits = await sideshiftRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.shiftCalls - hits0.shiftCalls).toBe(1);
      expect(hits.quoteCalls - hits0.quoteCalls).toBeGreaterThanOrEqual(2);

      // §5 the provider lifecycle.
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);
      setSideShiftStatus('multiple');
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);

      // §6 reload resume: the persisted record re-enters the provider panel.
      await m.remount();
      await openConvertFor(m, 'sol-eurc', {timeoutMs: 8_000});
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);
      expect((await sideshiftRelayHits()).shiftCalls).toBe(hits0.shiftCalls + 1);
      await m.driver.waitForFunction(
        () => (sideShiftStubState()?.statusCalls.length ?? 0) >= 2,
        {timeoutMs: 15_000, label: 'post-reload: >=2 keyed status polls observed'},
      );

      // §7 settle → done with the realized figures at the user's own address.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'ic-settle-sig-197'});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 45_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495 ICP', 'done reports the realized settle figure');
      assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
      assertIncludes(done, settle.slice(0, 12), 'the payout address IS the derived IC account identifier');
      const st = sideShiftStubState();
      expect(st).not.toBeNull();
      expect(st!.unexpected.length).toBe(0);
      expect(st!.statusCalls.length).toBeGreaterThanOrEqual(3);
      for (const c of st!.statusCalls) {
        expect(c.id).toBe(SHIFT_ID);
      }
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});


describe('flow 198 — SOL → ICP via the trocador aggregator: every venue call relay-borne', () => {
  it('sub-picks the service, locks a fixed order, drives the lifecycle through the relay status route', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-sol-cefi-trocador');
      const account = await accountOf(m);
      const kp = deriveSolanaKeypair(account!.secretHex);
      installSolRpcStub({refuseSend: true});
      const hits0 = await trocadorRelayHits();

      // §1 the venue area: SideShift is the auto pick; Trocador waits behind the expander.
      await openConvertFor(m, 'sol', {timeoutMs: 8_000});
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → USD', 'the standing pair is SOL→USD (registry order)');
      await pickSwapTarget(m, 'ICP');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      await openOtherVenues(m);
      expect(m.driver.isPresent('convert-venue-trocador')).toBe(true);
      await m.driver.click('convert-venue-trocador', {timeoutMs: 3_000});
      assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → ICP', 'the heading names the picked pair');
      await typeConvertAmount(m, '2');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.0496 ICP') === true,
        {timeoutMs: 20_000, label: 'the venue settle figure rendered (the rate arrived)'},
      );
      assertIncludes(m.driver.readText('convert-quote-source'), 'Trocador', 'attribution names the venue');
      assertIncludes(m.driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      const settle = m.driver.readText('convert-settle-address');
      expect(settle).toBe(await icpAccountIdHex(account!.publicHex));
      expect(m.driver.isPresent('convert-slippage')).toBe(false);
      expect(m.driver.isPresent('convert-min-out')).toBe(false);
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-counterparty'), {timeoutMs: 15_000, label: 'the census mounted'});
      assertIncludes(m.driver.readText('convert-counterparty'), 'Trocador', 'counterparty line names the venue');
      assertIncludes(m.driver.readText('convert-counterparty'), 'automated exchange service', 'not a licensed provider');
      assertIncludes(m.driver.readText('convert-counterparty'), 'Nothing is signed on this phone', 'the cefi signing sentence');
      assertIncludes(m.driver.readText('convert-venue-disclosure'), 'trocador.app/terms', 'the venue disclosure is present');
      expect(m.driver.isPresent('convert-pool-principal')).toBe(false);

      // §3 confirm → the venue's ORDER; the handoff is the venue's own deposit address.
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      expect(await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}).then(() => true).catch(() => false)).toBe(true);
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS_TROCADOR, 'the venue deposit address renders verbatim');
      const handoff = m.driver.readText('convert-deposit-handoff');
      assertIncludes(handoff, '2 SOL', 'the exact deposit amount renders in the deposit asset');
      assertIncludes(handoff, 'exactly the deposit amount', 'the handoff says what to send');
      assertIncludes(handoff, 'not a party', 'dpay party-hood denied');
      expect(await m.driver.waitForText('Converted', {timeoutMs: 1_000}).catch(() => false)).toBe(false);
      expect(solSentTxs().length).toBe(0);

      // §4 the partner-key audit: EVERY venue call rode the relay, key attached.
      const hits = await trocadorRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.tradeCalls - hits0.tradeCalls).toBe(1);
      expect(hits.rateCalls - hits0.rateCalls).toBeGreaterThanOrEqual(2);
      expect(hits.keyCalls).toBeGreaterThanOrEqual(hits.rateCalls + hits.tradeCalls - hits0.keyCalls);
      const tradeQuery = hits.lastTradeQuery ?? '';
      assertIncludes(tradeQuery, 'refund=', 'the trade request carried the refund address (the fund-loss guard)');
      assertIncludes(tradeQuery, 'min_kycrating=A', 'the non-KYC backends-only pin is relay-side');
      assertIncludes(tradeQuery, 'markup=0', 'the no-dpay-cut pin is relay-side');
      assertIncludes(tradeQuery, 'fixed=True', 'the trade is the venue\'s fixed-rate kind');

      // §5 the lifecycle THROUGH the key-gated relay status route.
      await new Promise((r) => setTimeout(r, 2500));
      expect(m.driver.isPresent('convert-awaiting-deposit')).toBe(true);
      const statusCallsBefore = (await trocadorRelayHits()).statusCalls;
      expect(statusCallsBefore).toBeGreaterThanOrEqual(1);
      await trocadorConfig({status: 'Processing'});
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 90_000}).then(() => true).catch(() => false)).toBe(true);

      // §6 reload resume: the persisted record re-enters the provider panel, still relay-fed.
      await m.remount();
      await openConvertFor(m, 'sol', {timeoutMs: 8_000});
      expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 90_000}).then(() => true).catch(() => false)).toBe(true);
      const after = await trocadorRelayHits();
      expect(after.tradeCalls).toBe(hits0.tradeCalls + 1);
      expect(after.statusCalls).toBeGreaterThan(statusCallsBefore);

      // §7 settle → done with the realized figures at the user's own address.
      await trocadorConfig({status: 'Completed', amount_to: '0.0496', hashout: 'sol-settle-sig-198'});
      expect(await m.driver.waitForText('Converted', {timeoutMs: 90_000})).toBe(true);
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0496 ICP', 'done reports the realized settle figure');
      assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
      assertIncludes(done, settle.slice(0, 12), 'the payout address IS the derived IC identifier');
      expect(kp.address.length).toBeGreaterThanOrEqual(32);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
  });

  // ── Flow 199 — the PARTNER AGREEMENT the relay runs around every Trocador call ────────────────
  // The pre-agreement SURFACE semantics are flow 198's pin (above); this pins what the agreement
  // ADDS when the relay runs as the agreement deploys it: DPAY_PUBLIC_ORIGIN set, its own
  // DPAY_TROCADOR_LOG_DIR. That is relay-PROCESS config, so this owns a startFlowRelay spawn
  // (the app rides the persisted list + the IC gateway seam; the SOL rail is the in-memory stub
  // behind the operator override, nothing broadcast — the cefi deposit is a handoff).
  //
  //   1. TRADE CREATION CARRIES THE WEBHOOK PARAMS UPSTREAM — the stub venue observes
  //      webhook=<origin>/api/v1/trocador/webhook and webhook_key=<order_id>, and the relay
  //      answers the device with X-Dpay-Order-Id (the same id).
  //   2. THE WEBHOOK ROUTE IS LIVE AT CREATION TIME — the venue's probe-shaped GET answers 200.
  //   3. THE WEBHOOK IS THE PRIMARY STATUS CHANNEL — a delivery keyed to the order's webhook_key
  //      lands the pushed status in the app's convert view (processing → done) with the stub's
  //      status hit-count FROZEN (zero upstream status reads; the cache serves verbatim).
  //   4. THE ACCESS LOG EXISTS AND CORRELATES — kinds rate/trade/status/webhook/webhook-unmatched,
  //      matched webhook lines carry the order/trade ids, cache-served reads carry NO upstream
  //      status, and the unmatched deliveries are logged (the GET probe; the bogus-key POST).
  describe('flow 199 — the trocador partner agreement (webhook registration, webhook-first status, access log)', () => {
    it('drives a real SOL→ICP trocador convert on an agreement-configured private relay', async () => {
      const logDir = await mkdtemp(join(tmpdir(), 'dpay-jest-199-agreement-'));
      const port = await pickFreePort();
      const r2 = await startFlowRelay({
        port,
        env: {
          DPAY_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, // the same shape prod sets
          DPAY_TROCADOR_LOG_DIR: logDir,
        },
      });
      const webhookURL = `${r2.baseURL}/api/v1/trocador/webhook`;
      const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
      const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
      const g = globalThis as unknown as Record<string, unknown>;

      const hitsAt = async (): Promise<{bareCalls: number; tradeCalls: number; rateCalls: number; statusCalls: number; lastTradeQuery?: string}> =>
        await relayGetAt(r2.baseURL, '/api/v1/test/trocador-upstream/hits') as Awaited<ReturnType<typeof hitsAt>>;
      const accessLines = async (): Promise<Array<Record<string, unknown>>> => {
        const text = await readFile(join(logDir, 'trocador-access.jsonl'), 'utf8');
        return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      };
      const deliverWebhook = async (key: string, payload: string): Promise<void> => {
        const res = await fetch(`${webhookURL}?key=${encodeURIComponent(key)}`, {
          method: 'POST', headers: {'content-type': 'application/json'}, body: payload,
        });
        expect(res.ok).toBe(true);
        expect(await res.text()).toBe('{"ok":true}');
      };

      let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
      try {
        // The app world rides the persisted relay list + the per-call IC gateway seam; the SOL
        // rail is the operator override + the in-memory RPC stub (nothing is ever broadcast).
        g.__DPAY_TEST_IC_GATEWAY = r2.baseURL;
        await pointRelayListAt(r2.baseURL);
        await enableSolRail();
        m = await onboardWallet('jest-trocador-agreement', {relayBase: r2.baseURL});
        const account = await accountOf(m);
        const kp = deriveSolanaKeypair(account!.secretHex);
        const settleAddress = await icpAccountIdHex(account!.publicHex);
        installSolRpcStub({refuseSend: true});

        // §1 drive a real convert to the Trocador order (the surface walk is flow 198's to pin).
        await openConvertFor(m, 'sol', {timeoutMs: 8_000});
        await pickSwapTarget(m, 'ICP');
        await openOtherVenues(m);
        await m.driver.click('convert-venue-trocador', {timeoutMs: 8_000});
        assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → ICP', 'the heading names the picked pair');
        await typeConvertAmount(m, '2');
        await m.driver.waitForFunction(
          () => m!.driver.readTextSafe('convert-headline')?.includes('0.0496 ICP') === true,
          {timeoutMs: 20_000, label: 'the venue settle figure rendered (the rate arrived)'},
        );
        assertIncludes(m.driver.readText('convert-quote-source'), 'Trocador', 'attribution names the venue');
        expect(m.driver.readText('convert-settle-address')).toBe(settleAddress);

        // §2 confirm → a REAL order at awaiting_deposit (nothing broadcast — the cefi handoff).
        await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
        expect(await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}).then(() => true).catch(() => false)).toBe(true);
        assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS_TROCADOR, 'the venue deposit address renders verbatim');
        expect(solSentTxs().length).toBe(0);

        // §3 CREATION-TIME AGREEMENT FACTS: the webhook registration rode the trade upstream.
        const hits = await hitsAt();
        expect(hits.bareCalls).toBe(0); // no bare (keyless) upstream call — the key attaches server-side
        expect(hits.tradeCalls).toBe(1);
        expect(hits.rateCalls).toBeGreaterThanOrEqual(2);
        const tradeQuery = hits.lastTradeQuery ?? '';
        assertIncludes(tradeQuery, `webhook=${webhookURL}`, 'trade creation registered THIS relay\'s webhook URL upstream (stub observed it)');
        assertIncludes(tradeQuery, 'webhook_key=trod-', 'trade creation carried a relay-minted webhook_key');
        const webhookKey = new URLSearchParams(tradeQuery).get('webhook_key');
        expect(webhookKey ?? '').toMatch(/^trod-[0-9a-f]{16}$/);

        // The access log's trade line correlates: webhook_key IS the relay's order id.
        const lines = await accessLines();
        const tradeLines = lines.filter((l) => l.kind === 'trade');
        expect(tradeLines.length).toBe(1);
        expect(tradeLines[0].order_id).toBe(webhookKey);
        expect(tradeLines[0].upstream_status).toBe(200);
        const tradeId = tradeLines[0].trade_id as string;
        const orderId = webhookKey as string;
        expect(typeof tradeLines[0].client_order_id === 'string' && (tradeLines[0].client_order_id as string).length > 0).toBe(true);

        // (b) the venue PROBES the webhook URL at creation — the receiver is already live.
        const probe = await fetch(webhookURL);
        expect(probe.status).toBe(200);
        expect(await probe.text()).toBe('{"ok":true}');
        // An UNMATCHED delivery (bogus key) is still a 200 — never retry-worthy — and is logged.
        await deliverWebhook('trod-deadbeefdeadbeef', JSON.stringify({status: 'Completed'}));

        // §4 WEBHOOK-FIRST LIFECYCLE: deliveries drive the app; the stub's status counter freezes.
        const midPayload = JSON.stringify({
          trade_id: tradeId, status: 'Processing', amount_from: '2', amount_to: '0.0496',
          provider: 'StubSwap', fixed: true,
        });
        await deliverWebhook(orderId, midPayload);
        const statusCallsBeforePush = (await hitsAt()).statusCalls;

        // The status route serves the delivery VERBATIM — the zero-upstream cache.
        const cached = await fetch(`${r2.baseURL}/api/v1/trocador/trade?id=${encodeURIComponent(tradeId)}`);
        expect(cached.status).toBe(200);
        expect(await cached.text()).toBe(midPayload);
        expect((await hitsAt()).statusCalls).toBe(statusCallsBeforePush);

        // The app's convert view advances on the pushed status, cache-served either way (the
        // engine tick may wait out the pre-push fallback read's 60s spacing — hence the 90s).
        expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 90_000}).then(() => true).catch(() => false)).toBe(true);
        expect((await hitsAt()).statusCalls).toBe(statusCallsBeforePush);

        // Terminal delivery: the venue's own realized figures ride the SAME channel.
        const donePayload = JSON.stringify({
          trade_id: tradeId, status: 'Completed', amount_from: '2', amount_to: '0.0496',
          provider: 'StubSwap', fixed: true, details: {hashout: 'sol-settle-sig-199'},
        });
        await deliverWebhook(orderId, donePayload);
        expect(await m.driver.waitForText('Converted', {timeoutMs: 90_000})).toBe(true);
        const done = m.driver.readText('convert-done');
        assertIncludes(done, '0.0496 ICP', 'done reports the realized settle figure off the webhook payload');
        assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
        assertIncludes(done, settleAddress.slice(0, 12), 'the payout address IS the derived IC identifier');
        expect((await hitsAt()).statusCalls).toBe(statusCallsBeforePush);

        // §5 the device-facing correlation: a protocol-level creation names the order id at
        // X-Dpay-Order-Id — the value the webhook_key echoes; each trade mints its OWN id. (The
        // app's own record is already terminal; this second order cannot disturb it.)
        const probeTrade = await fetch(`${r2.baseURL}/api/v1/trocador/trade`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            rateId: 'stub-rate-1', provider: 'StubSwap',
            settleAddress, refundAddress: kp.address,
            depositLedger: WRAPPED_SOL_MINT, settleLedger: ICP_LEDGER, depositAmount: '2',
          }),
        });
        expect(probeTrade.status).toBe(200);
        const headerOrderId = probeTrade.headers.get('x-dpay-order-id');
        expect(headerOrderId ?? '').toMatch(/^trod-[0-9a-f]{16}$/);
        expect(headerOrderId).not.toBe(orderId);
        const probeQuery = new URLSearchParams((await hitsAt()).lastTradeQuery ?? '');
        expect(probeQuery.get('webhook')).toBe(webhookURL);
        expect(probeQuery.get('webhook_key')).toBe(headerOrderId);
        const probeLines = await accessLines();
        const probeTradeLine = probeLines.filter((l) => l.kind === 'trade').pop();
        expect(probeTradeLine?.order_id).toBe(headerOrderId);
        expect((await hitsAt()).statusCalls).toBe(statusCallsBeforePush);

        // §6 THE ACCESS LOG CENSUS: every proxied call correlated, the zero-upstream signature.
        const all = await accessLines();
        const kinds = new Set(all.map((l) => l.kind));
        for (const kind of ['rate', 'trade', 'status', 'webhook', 'webhook-unmatched']) {
          expect(kinds.has(kind)).toBe(true);
        }
        for (const l of all) {
          expect(typeof l.ip === 'string' && (l.ip as string).length > 0).toBe(true);
          expect(typeof l.user_agent === 'string' && (l.user_agent as string).length > 0).toBe(true);
          expect(typeof l.accept_language === 'string' && (l.accept_language as string).length > 0).toBe(true);
        }
        const webhookLines = all.filter((l) => l.kind === 'webhook');
        expect(webhookLines.length).toBe(2); // both deliveries logged as matched webhooks
        for (const l of webhookLines) {
          expect(l.order_id).toBe(orderId);
          expect(l.trade_id).toBe(tradeId);
        }
        const unmatched = all.filter((l) => l.kind === 'webhook-unmatched');
        expect(unmatched.some((l) => l.method === 'GET')).toBe(true); // the creation-time probe
        expect(unmatched.some((l) => l.method === 'POST')).toBe(true); // the bogus-key delivery
        const statusLines = all.filter((l) => l.kind === 'status');
        expect(statusLines.length).toBeGreaterThanOrEqual(1);
        expect(statusLines.some((l) => l.upstream_status != null)).toBe(true); // the fallback read
        expect(statusLines.some((l) => l.upstream_status == null)).toBe(true); // the cache-served reads
      } finally {
        if (m) await m.unmount().catch(() => undefined);
      }
    }, 300_000);
  });


})();


// ═══ ====================================================================================================
// failures.test.tsx (its module scope, closure-scoped)
// ═══ ====================================================================================================
(() => {
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const SEED_ICP = 300000000; // 3 ICP
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';

async function restoreIcDelay(): Promise<void> {
  try {
    await icDelayKnob('depositFromAndSwap', 0);
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

async function restorePool(): Promise<void> {
  try {
    await swapPoolKnob({pool: CKUSDC_POOL, fee_millionths: 3000, impact_bps: 0, fail_withdrawal: false, settle_pending: true});
  } catch { /* the relay itself dying reports at the assertions that matter */ }
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 191 — the approve refusal is a terminal failed card, never a stuck spinner', () => {
  it('surfaces the refusal, names the asset, and leaves the ledger byte-whole', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-approve-refused');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

      // Arm the approve_fail knob (AllowanceChanged{0}, the live-defect shape; one refusal).
      await approveFailKnob(ICP_LEDGER);

      await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
      // A green here PROVES the panel left the Approving spinner: the old bug rendered it for
      // the full 5-minute envelope window and only then flipped to stuck.
      expect(await m.driver.findByTestID('convert-failed', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);
      expect(await m.driver.findByTestID('convert-stuck', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);

      const failedBody = m.driver.readText('convert-failed');
      expect(failedBody.includes('Swap not executed')).toBe(true);
      expect(failedBody.includes('ICP') && failedBody.includes('refused the approval')).toBe(true);
      expect(failedBody.includes('nothing moved') || failedBody.includes('No allowance was created')).toBe(true);
      expect(failedBody.includes('Approving')).toBe(false);

      // The ledger is byte-whole: a refused approve charges no fee and moves nothing.
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(SEED_ICP));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

describe('flow 192 — the Stop during a LIVE swap aborts honestly', () => {
  it('labels the in-flight window watching, stops to the terminal card, and removes the control', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      m = await onboardWallet('jest-convert-abort');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_ICP, {currency: 8});
      expect(fund.ok).toBe(true);

      await openConvertFor(m, 'icp');
      expect(m.driver.isPresent('convert-screen')).toBe(true);
      await typeConvertAmount(m, '1');
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

      // The swap reply stays pending 12 s — the deterministic in-flight window.
      await icDelayKnob('depositFromAndSwap', 12_000);

      await m.driver.click('btn-convert-confirm', {timeoutMs: 6_000});
      expect(await m.driver.findByTestID('convert-swapping', {timeoutMs: 45_000}).then(() => true).catch(() => false)).toBe(true);

      await m.driver.findByTestID('btn-convert-stop', {timeoutMs: 5_000});
      assertIncludes(m.driver.readText('btn-convert-stop'), 'Stop watching', 'the watching flavor labels the button');

      await m.driver.click('btn-convert-stop', {timeoutMs: 5_000});
      expect(await m.driver.findByTestID('convert-aborted', {timeoutMs: 15_000}).then(() => true).catch(() => false)).toBe(true);
      const abortedBody = m.driver.readText('convert-aborted');
      expect(abortedBody.includes('The swap may still go through')).toBe(true);
      expect(await m.driver.findByTestID('btn-convert-stop', {timeoutMs: 1_000}).then(() => true).catch(() => false)).toBe(false);
    } finally {
      await restoreIcDelay();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

describe('flow 195 — Route C generalized: ICP → EURC via USDC as one cross-rail intent', () => {
  it('composes the EURC route, hands off keyless, resumes, and lands EURC without double units', async () => {
    const ROUTE_C_SOL_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
    const ROUTE_C_EURC_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter-usdc-eurc';
    const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const BURN_HASH = '0x' + '2c'.repeat(32);
    const EURC_OUT = '10300000';
    const EURC_FLOOR = '10200000';

    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-crossrail-icp-eurc');
      const account = await accountOf(m);
      const fundIcp = await faucetAccount(account!.publicHex, 2000000000, {currency: 8}); // 20 ICP
      expect(fundIcp.ok).toBe(true);
      const fundEth = await faucetAccount(account!.publicHex, 400000000000000, {currency: 6});
      expect(fundEth.ok).toBe(true);

      // Prebuild the deterministic venue + mint fixtures for THIS wallet (the EURC leg pays
      // out at the USER'S OWN EURC ATA — the app's beneficiary check re-derives it).
      const kp = deriveSolanaKeypair(account!.secretHex);
      const ataString = bs58Encode(deriveAta(kp.address, USDC_MINT));
      const eurcAtaString = bs58Encode(deriveAta(kp.address, EURC_MINT));
      const txB64 = jupiterSwapTxB64(kp.address, eurcAtaString);

      // The census oracle BEFORE anything renders.
      const oracle0 = await relayGet(`/api/v1/swap_quote?pool=${CKUSDC_POOL}&token_in=${ICP_LEDGER}&token_out=${CKUSDC_LEDGER}&amount_in=500000000`) as {amount_out: string};
      let gross = BigInt(oracle0.amount_out);
      let minOut = floor99(gross);
      let fees = cctpFeeExpectations(minOut);
      const mintCredit = fees.mintFloor;

      const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataString, outAmount: Number(mintCredit)});
      const eurcDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: eurcAtaString, outAmount: Number(EURC_OUT), mint: EURC_MINT, decimals: 6});
      installSolRpcStub({forwardTxHash: FORWARD_TX_HASH, tokenDetail, swapDetail: eurcDetail});
      const jup0 = await jupiterStubState();
      await configureJupiterStub({
        quote: {outAmount: EURC_OUT, otherAmountThreshold: EURC_FLOOR, priceImpact: '0.001'},
        userPublicKey: kp.address,
        txB64,
        lastValidBlockHeight: 300000000,
      });
      installCctpStub({forwardTxHash: FORWARD_TX_HASH});
      installEvmSignSeam(BURN_HASH);

      // §1 the EURC route composes beside the CeFi venue; the original SOL route still exists.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'EUR');
      await typeConvertAmount(m, '5');
      await m.driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      await pickSwapTarget(m, 'SOL');
      await openOtherVenues(m);
      expect(await m.driver.findByTestID(ROUTE_C_SOL_ROW, {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(true);
      await pickSwapTarget(m, 'EUR');
      expect(await m.driver.findByTestID(ROUTE_C_EURC_ROW, {timeoutMs: 3_000}).then(() => true).catch(() => false)).toBe(true);
      await m.driver.click(ROUTE_C_EURC_ROW);
      await m.driver.type('convert-dest-address', DEST);
      await m.driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      assertIncludes(m.driver.readText('convert-dest-cross-note'), 'also the wallet that signs', 'the destination warns that this address also SIGNS the crossing');
      assertIncludes(m.driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the route floor is the burn amount, in the HOP asset');

      // §2 the census (unchanged from the SOL route, USDC-denominated).
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.isPresent('crossrail-circle-fee') && m!.driver.isPresent('crossrail-mint-floor'),
        {timeoutMs: 15_000, label: 'the cross-rail census mounted'},
      );
      assertIncludes(m.driver.readText('crossrail-external-gas'), 'your wallet', 'the census names WHO pays the EVM gas');
      assertIncludes(m.driver.readText('crossrail-circle-fee'), `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s published fee renders as its own census line');
      assertIncludes(m.driver.readText('crossrail-mint-floor'), `${fmt(fees.mintFloor, 6)} USDC`, 'the mint floor names what survives the fee');
      assertIncludes(m.driver.readText('convert-gas-note'), `${fmt(78000000000000n, 18)} ETH`, 'the minter gas line is unchanged from Route A');

      // Confirm (quote-changed interrupt → re-review).
      for (let round = 0; round < 5; round++) {
        await m.driver.click('btn-convert-confirm');
        const changed = await m.driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
        if (changed == null) break;
        const re = await relayGet(`/api/v1/swap_quote?pool=${CKUSDC_POOL}&token_in=${ICP_LEDGER}&token_out=${CKUSDC_LEDGER}&amount_in=500000000`) as {amount_out: string};
        gross = BigInt(re.amount_out);
        minOut = floor99(gross);
        fees = cctpFeeExpectations(minOut);
      }

      // §3 the handoff (byte-identical CCTP chain — the burn cannot tell the destinations apart).
      expect(await m.driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000})).toBe(true);
      await m.driver.waitForText('Step 1', {timeoutMs: 10_000});
      expect(m.driver.isPresent('crossrail-handoff')).toBe(true);
      const handoff = m.driver.readText('crossrail-handoff');
      assertIncludes(handoff, `${fmt(minOut, 6)} USDC`, 'the intro names the crossed amount (the burn floor)');
      assertIncludes(handoff, 'Nothing is signed on dpay', 'the what-signing line says dpay signs nothing');
      assertIncludes(m.driver.readText('crossrail-approve-calldata').slice(0, 10), '0x095ea7b3', 'tx 1 is a plain ERC-20 approve');
      assertIncludes(m.driver.readText('crossrail-burn-calldata').slice(0, 10), '0x779b432d', 'tx 2 is depositForBurnWithHook');
      assertIncludes(handoff, `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s fee line renders in the handoff too');

      // The wallet double signs; the app attaches the reported hash.
      await m.driver.type('crossrail-burn-tx', 'signed');
      for (let i = 0; i < 3; i++) {
        try {
          await m.driver.click('btn-crossrail-attach', {timeoutMs: 5_000});
          break;
        } catch (e) {
          if (i === 2) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 10_000});

      // §4 the mint watch parks honestly.
      const sigs = evmSignsRecorded();
      expect(sigs.length).toBe(1);
      expect(String(sigs[0].amountSubunits)).toBe(minOut.toString());
      const pollsAtStall = cctpStubState().messageCalls.length;
      await m.driver.waitForFunction(
        () => cctpStubState().messageCalls.length > pollsAtStall,
        {timeoutMs: 15_000, label: 'the mint watch polls again while parked'},
      );
      expect(m.driver.isPresent('crossrail-crossing')).toBe(true);
      const cctpBeforeReload = cctpStubState();

      // §5 reload: the engine resumes from the MINT WATCH; the IC legs are never re-signed.
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      const ethBefore = BigInt(await getBalance(account!.publicHex, 6));
      await m.remount();
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await m.driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-leg-5-state'), {timeoutMs: 15_000, label: 'the six-leg list rendered'});
      for (let i = 0; i < 5; i++) {
        assertIncludes(m.driver.readText(`convert-leg-${i}-state`), 'Confirmed', `after reload IC leg ${i} reads Confirmed (resumed, not re-signed)`);
      }
      assertIncludes(m.driver.readText('convert-leg-5-state'), 'Sent', 'the cctp_burn leg reads Sent');
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(ethBefore);

      // §6 the mint lands, then the EURC leg offers on a FRESH quote.
      setCctpMessageState('complete');
      await m.driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
      await m.driver.waitForFunction(() => m!.driver.isPresent('crossrail-sol-out'), {timeoutMs: 15_000, label: 'the final leg\'s estimate rendered'});
      const ready = m.driver.readText('crossrail-sol-ready');
      assertIncludes(ready, `${fmt(mintCredit, 6)} USDC`, 'the verified mint credit renders');
      assertIncludes(ready, ataString, 'the USDC location is named: the user\'s own ATA');
      assertIncludes(ready, 'it is yours either way', 'keeping the USDC is offered as an equal exit');
      assertIncludes(m.driver.readText('crossrail-sol-out'), fmt(EURC_OUT, 6), 'the fresh Jupiter estimate renders in EURC units');
      assertIncludes(ready, `${fmt(EURC_FLOOR, 6)} EURC`, 'the final leg\'s floor is Jupiter\'s own otherAmountThreshold, named EURC');
      expect(ready.includes('EURC EURC')).toBe(false);
      assertIncludes(m.driver.readText('btn-crossrail-sol-confirm'), 'Swap to EURC', 'the confirm button names the destination token');

      await m.driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
      expect(await m.driver.waitForText('verified on-chain', {timeoutMs: 60_000})).toBe(true);
      await m.driver.findByTestID('convert-done', {timeoutMs: 15_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, `${fmt(EURC_OUT, 6)} EURC`, 'done reports the REALIZED EURC credit');
      expect(done.includes('EURC EURC')).toBe(false);
      assertIncludes(done, kp.address, 'the Solana address is named');
      for (let i = 0; i < 7; i++) {
        assertIncludes(m.driver.readText(`convert-leg-${i}-state`), 'Confirmed', `final leg ${i} of 7 reads Confirmed`);
      }

      // Stub audits + ledger truth.
      expect(solSentTxs().length).toBe(1);
      assertIncludes(done, solSentTxs()[0].signature, 'the payout record IS the broadcast signature');
      const jup = await jupiterStubState();
      expect(jup).not.toBeNull();
      expect(jup!.unexpected.length).toBe(jup0!.unexpected.length);
      expect(jup!.userMismatch ?? null).toBeNull();
      expect(jup!.swapCalls.length - jup0!.swapCalls.length).toBe(1);
      const eurcLegQuotes = jup!.quoteCalls.slice(jup0!.quoteCalls.length)
        .filter((q) => q.inputMint === USDC_MINT && q.outputMint === EURC_MINT);
      expect(eurcLegQuotes.length).toBeGreaterThanOrEqual(1);
      expect(eurcLegQuotes[0].amount).toBe(mintCredit.toString());
      const cctpAfter = cctpStubState();
      expect(cctpAfter.unexpected.length).toBe(0);
      expect(cctpBeforeReload.feesCalls + cctpAfter.feesCalls).toBeGreaterThanOrEqual(2);
      const allMessageCalls = [...cctpBeforeReload.messageCalls, ...cctpAfter.messageCalls];
      expect(allMessageCalls.length).toBeGreaterThanOrEqual(2);
      for (const msg of allMessageCalls) {
        expect(msg.hash).toBe(BURN_HASH);
      }
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(BigInt(2000000000) - 500000000n - 2n * 10000n);
      expect(BigInt(await getBalance(account!.publicHex, 2))).toBe(gross - minOut - 10000n);
      expect(BigInt(await getBalance(account!.publicHex, 6))).toBe(BigInt(400000000000000) - 78000000000000n - 2000000000000n);
    } finally {
      await restorePool();
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

})();


// ═══ ====================================================================================================
// dest-groups.test.tsx (its module scope, closure-scoped)
// ═══ ====================================================================================================
(() => {
/** The sheet's target + venue testIDs in TRUE TREE ORDER (the DOM-order twin). */
function targetLayout(m: Mount): string[] {
  const ids: string[] = [];
  const walk = (n: unknown): void => {
    const props = (n as {props?: {testID?: unknown}}).props;
    const id = props && typeof props.testID === 'string' ? props.testID : null;
    if (id != null && (id === 'convert-target-line' || /^convert-target-chip-[A-Z]+$/.test(id) || /^convert-venue-/.test(id))) {
      ids.push(id);
    }
    for (const c of (n as {children?: unknown[]}).children ?? []) {
      if (c && typeof c === 'object') walk(c);
    }
  };
  walk(m.tree.root);
  // RN-web mirrors testID onto wrapper layers — the DOM-order twin de-dupes (first occurrence).
  return [...new Set(ids)];
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 206 — the intent sheet\'s target grammar: the standing line + the sibling chips', () => {
  it('stands on the value twin, carries exactly the reachable chips, flips on one tap, kinds the rows', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      await enableSolRail();
      m = await onboardWallet('jest-dest-groups');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, 50000000000, {currency: 7}); // 500 VCHF
      expect(fund.ok).toBe(true);

      // Tap 1 — the convert sheet on the VCHF account.
      await openConvertFor(m, 'vchf');
      await m.driver.findByTestID('convert-target-leg', {timeoutMs: 15_000});

      // 1. the standing target is the value twin; the chips carry exactly the reachable set.
      const layout = targetLayout(m);
      const chips = layout.filter((t) => t.startsWith('convert-target-chip-'));
      const expectedChips = [
        'convert-target-chip-USD',
        'convert-target-chip-BTC',
        'convert-target-chip-ETH',
        'convert-target-chip-ICP',
        'convert-target-chip-SOL',
      ];
      expect(JSON.stringify(chips)).toBe(JSON.stringify(expectedChips));
      expect(layout.includes('convert-target-line')).toBe(true);
      assertIncludes(m.driver.readText('convert-target-line'), 'Euros', 'a stable source stands on its value twin');
      // The pair walk arms the sheet: the standing pair is already quoted on open.
      await m.driver.findByTestID('convert-quote-source', {timeoutMs: 15_000});

      // 2. one chip tap re-resolves the pair (the optional decision, one tap).
      await pickSwapTarget(m, 'ICP');
      assertIncludes(m.driver.readText('convert-target-line'), 'Internet Computer', 'the line flipped to the picked currency');
      expect(m.driver.isPresent('convert-target-chip-USD')).toBe(true);
      expect(m.driver.isPresent('convert-target-chip-ICP')).toBe(false);

      // 3. the USD pair: its OTHER rows in the expander, kind order.
      await pickSwapTarget(m, 'USD');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-venue-auto'), 'Executed via', 'the direct pool is auto-picked and mechanically disclosed');
      await openOtherVenues(m);
      const venueRows = targetLayout(m)
        .filter((t) => t.startsWith('convert-venue-') && t !== 'convert-venue-auto' && !/-quote$|-err$|-slow$/.test(t));
      const expectedRows = [
        'convert-venue-hub:icpswap:8:icpswap-ckusdc',        // via the ICP hub
        // The composed IC+CeFi chains: direct-then-hub IC legs into the sideshift-usdc
        // order, keyed on the settle mint, in registry order.
        'convert-venue-composed:icpswap:sideshift-usdc',
        'convert-venue-composed:hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc:sideshift-usdc',
        'convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp', // Route B (in-wallet landing)
      ];
      expect(JSON.stringify(venueRows)).toBe(JSON.stringify(expectedRows));
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 180_000);
});

})();


// ═══ ====================================================================================================
// composed.test.tsx (its module scope, closure-scoped)
// ═══ ====================================================================================================
(() => {
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const POOL_VCHF_ICP = '65mrh-fqaaa-aaaar-qapoa-cai';
const DEPOSIT_ADDRESS = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // the stub's valid ICRC-1 account text
const SHIFT_ID = 'e2e-shift-9c1d';
const SEED_VCHF = 2000000000; // 20 VCHF
const VCHF_FEE = 10000n;
const ICP_FEE = 10000n;
const ETH_RAIL_ID = 'evm:native-eth';

type ConvertRecord = {
  step?: string;
  legPlan?: Array<{kind?: string; state?: string}>;
  legs?: unknown[];
  composedDeposit?: {sentTx?: unknown; amountRaw?: string; amountDecimal?: string; expiresAtMs?: number};
  venueId?: string;
  outLedger?: string;
  outSymbol?: string;
  outDecimals?: number;
  destAddress?: string;
  providerRef?: unknown;
  failureCode?: string;
  failureDetail?: string;
  failureDetailIncludes?: string;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = () => require('@react-native-async-storage/async-storage') as {
  getItem: (k: string) => Promise<string | null>;
  setItem: (k: string, v: string) => Promise<void>;
};

async function storeRecords(publicHex: string): Promise<Record<string, ConvertRecord>> {
  const raw = await AsyncStorage().getItem(`dpay.convert.v3.${publicHex}`);
  return raw == null ? {} : JSON.parse(raw) as Record<string, ConvertRecord>;
}

/** Clone the real composed record parked just before the deposit leg; `patch` mutates it. */
async function seedComposedClone(
  publicHex: string,
  seedId: string,
  patch: (rec: ConvertRecord, now: number) => void,
): Promise<number> {
  const store = await storeRecords(publicHex);
  const tpl = Object.values(store).find((r) => r != null && r.composedDeposit != null);
  if (tpl == null) throw new Error('no composed record to clone');
  const rec = JSON.parse(JSON.stringify(tpl)) as ConvertRecord & Record<string, unknown>;
  delete rec.outAmountNet;
  for (const k of ['outTx', 'hopTx', 'destTx', 'failureCode', 'failureDetail', 'acknowledgedStuckAtMs'] as const) {
    delete rec[k];
  }
  delete rec.composedDeposit!.sentTx;
  rec.id = seedId;
  rec.step = 'approving';
  rec.createdAtMs = Date.now() + 5_000;
  rec.legPlan = rec.legPlan!.map((lp, i) => ({...lp, state: i < 2 ? 'confirmed' : 'pending'}));
  const now = Date.now();
  rec.legs = (rec.legs ?? []).map((l) => ({...(l as {expiresAtMs?: number}), expiresAtMs: now + 300_000}));
  patch(rec, now);
  store[seedId] = rec;
  await AsyncStorage().setItem(`dpay.convert.v3.${publicHex}`, JSON.stringify(store));
  return Object.keys(store).length;
}

/** Poll the store until the engine's gate has failed the seeded record. */
async function waitForFailure(publicHex: string, id: string, timeoutMs = 45_000): Promise<ConvertRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const store = await storeRecords(publicHex);
    if (store[id]?.failureCode != null) return store[id];
    if (Date.now() > deadline) throw new Error(`waitForFailure: ${id} never failed (step: ${store[id]?.step ?? 'absent'})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

afterEach(() => {
  disposeConvertStubs();
});

describe('flow 213 — the composed IC+CeFi conversion at the ONE consent press', () => {
  it('creates the order once, signs three legs, narrates live, resumes, and refuses seeded corruption', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The EUR target is offerable only when its EURC(Solana) rail exists in the asset list.
      await enableSolRail();
      m = await onboardWallet('jest-convert-composed');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_VCHF, {currency: 7});
      expect(fund.ok).toBe(true);

      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await sideshiftRelayHits();

      // The composed oracle: the IC leg's gross + floor, exactly what the order will price.
      const q1 = await relayGet(`/api/v1/swap_quote?pool=${POOL_VCHF_ICP}&token_in=${VCHF_LEDGER}&token_out=${ICP_LEDGER}&amount_in=200000000`) as {venue_id: string; amount_out: string};
      expect(q1.venue_id).toBe('icpswap');
      const gross1 = BigInt(q1.amount_out);
      const minOut1 = (gross1 / 10000n) * 9900n + ((gross1 % 10000n) * 9900n) / 10000n;
      const neg = minOut1.toString().padStart(9, '0');
      const depositDecimal = `${neg.slice(0, -8).replace(/^0+(?=.)|^0$/, '') || '0'}.${neg.slice(-8).replace(/0+$/, '')}`;

      // §1 the 2-press happy path: auto-pick → entry facts → THE ONE consent press.
      await openConvertFor(m, 'vchf');
      await pickSwapTarget(m, 'EUR');
      await typeConvertAmount(m, '2');
      await m.driver.findByTestID('convert-venue-auto', {timeoutMs: 15_000});
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-receive')?.includes('≈ 0.04 EURC') === true,
        {timeoutMs: 15_000, label: 'the receive hero settled on the venue quote'},
      );
      assertIncludes(m.driver.readText('convert-venue-auto'), 'SideShift', 'the pick disclosure names the settle venue');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-route-via')?.includes('Swap VCHF → ICP on ICPSwap') === true,
        {timeoutMs: 15_000, label: 'the route named its IC leg'},
      );
      assertIncludes(m.driver.readText('convert-route-via'), 'to SideShift', 'the deposit line names the venue that will hold the order');
      assertIncludes(m.driver.readText('convert-route-via'), depositDecimal, 'the deposit line names the IC floor the order will price');
      await m.driver.click('convert-details', {timeoutMs: 5_000});
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-quote-verbatim')?.includes('0.0495 EURC') === true,
        {timeoutMs: 15_000, label: 'the settle venue\'s verbatim quote in Details'},
      );
      await m.driver.click('convert-details', {timeoutMs: 5_000}); // close it again for the press

      // NOTHING is adopted before the consent: the store is still empty.
      let store = await storeRecords(account!.publicHex);
      expect(Object.keys(store).length).toBe(0);

      // THE ONE CONSENT — order + three legs + live narration.
      const vchfBefore = BigInt(await getBalance(account!.publicHex, 7));
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-state', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-leg-2', {timeoutMs: 15_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
      const awaiting = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(awaiting, 'SideShift', 'the payout watch names the venue');
      assertIncludes(awaiting, depositDecimal, 'the deposit leg\'s copy names the sent amount');
      expect((await sideshiftRelayHits()).shiftCalls - hits0.shiftCalls).toBe(1);

      // The live narration: the venue's order facts, verbatim, attributed.
      await m.driver.waitForFunction(() => m!.driver.isPresent('convert-composed-order'), {timeoutMs: 15_000, label: 'the order line rendered'});
      assertIncludes(m.driver.readText('convert-composed-order'), 'SideShift', 'the order line names the venue');
      assertIncludes(m.driver.readText('convert-composed-order'), '0.0495', 'the order line carries the venue\'s LOCKED settle figure');
      assertIncludes(m.driver.readText('convert-composed-order-id'), SHIFT_ID, 'the venue\'s order id renders');
      assertIncludes(m.driver.readText('convert-composed-order-at'), 'SideShift', 'the locked figure is attributed to the venue');
      assertIncludes(m.driver.readText('convert-composed-deposit-amount'), depositDecimal, 'the exact-amount gate\'s figure is the floored amount');
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-composed-deposit-address')?.includes(DEPOSIT_ADDRESS) === true,
        {timeoutMs: 15_000, label: 'the venue deposit address revealed live'},
      );

      // The record: awaiting_deposit, the deposit row's durable identity frozen on it.
      store = await storeRecords(account!.publicHex);
      const rec = Object.values(store).find((r) => r != null && r.composedDeposit != null);
      expect(rec).not.toBeNull();
      expect(rec!.step).toBe('awaiting_deposit');
      expect(rec!.composedDeposit!.sentTx != null).toBe(true);
      expect(rec!.legPlan!.length).toBe(3);
      expect(rec!.legPlan![2].kind).toBe('deposit_transfer');
      expect(rec!.composedDeposit!.amountDecimal).toBe(depositDecimal);

      // The books: VCHF debited amount + TWO input fees; ICP nets gross − floor − the fee.
      expect(BigInt(await getBalance(account!.publicHex, 7))).toBe(vchfBefore - 200000000n - 2n * VCHF_FEE);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(gross1 - minOut1 - ICP_FEE);

      // §2 reload: the payout watch resumes WITHOUT re-creating the order.
      const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
      await m.remount();
      await openConvertFor(m, 'vchf', {timeoutMs: 8_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);

      // §3 the venue settles: its own figures complete the record.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'sol-settle-sig-213'});
      await m.driver.findByTestID('convert-done', {timeoutMs: 45_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495', 'done reports the VENUE\'s own settle amount');
      assertIncludes(done, 'SideShift', 'done attributes the trade to the venue');

      // §4 the expired deposit window (seeded): the gate refuses ONCE, nothing re-signs.
      await seedComposedClone(account!.publicHex, 'seeded-expired-213', (clone, now) => {
        const bumped = (BigInt(clone.composedDeposit!.amountRaw!) + 1n).toString();
        clone.composedDeposit!.amountRaw = bumped;
        const negB = bumped.padStart(9, '0');
        clone.composedDeposit!.amountDecimal = `${negB.slice(0, -8).replace(/^0+(?=.)|^0$/, '') || '0'}.${negB.slice(-8).replace(/0+$/, '')}`;
        clone.composedDeposit!.expiresAtMs = now - 1_000;
      });
      await m.remount();
      const failedWindow = await waitForFailure(account!.publicHex, 'seeded-expired-213');
      expect(failedWindow.failureCode).toBe('deposit_refused');
      assertIncludes(failedWindow.failureDetail ?? '', 'venue order expired', 'the refusal detail names the dead deposit window');
      expect(failedWindow.legPlan![2].state).toBe('failed');
      expect(failedWindow.legs!.length).toBe(3);

      // §5 the exact-amount corruption (seeded): the gate refuses before any signature.
      await seedComposedClone(account!.publicHex, 'seeded-amount-213', (clone) => {
        clone.composedDeposit!.amountRaw = (BigInt(clone.composedDeposit!.amountRaw!) + 1n).toString();
      });
      await m.remount();
      const failedAmount = await waitForFailure(account!.publicHex, 'seeded-amount-213');
      expect(failedAmount.failureCode).toBe('deposit_refused');
      assertIncludes(failedAmount.failureDetail ?? '', 'order amount', 'the refusal detail names the exact-amount invariant');
      expect(failedAmount.legPlan![2].state).toBe('failed');

      // The stub's order counter never moved past the ONE consented order.
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

describe('flow 223 — the EVM-native CeFi destination (ICP → native ETH via sideshift-eth)', () => {
  it('gates on the EVM rail, settles at the derived EVM identity, and locks the EVM facts', async () => {
    let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
    try {
      // The EVM rail gate opens through the OPERATOR override (Settings ▸ Advanced, persisted —
      // App reads it at boot and it wins over jest.setup.js's empty test override; the e2e twin
      // deleted the override for the relay-derived path — the same configured-rail outcome).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Storage = require('@react-native-async-storage/async-storage') as {setItem: (k: string, v: string) => Promise<void>};
      await Storage.setItem('dpay.evmRpc.v1', `${relayBaseURL()}/api/v1/evm/rpc`);

      m = await onboardWallet('jest-convert-cefi-eth');
      const account = await accountOf(m);
      const fund = await faucetAccount(account!.publicHex, SEED_VCHF, {currency: 8});
      expect(fund.ok).toBe(true);

      // The settle address, derived INDEPENDENTLY through the app's own SLIP-10 module (the
      // app's derivation returns the lowercase form; the checksum is applied for display AND
      // as the order's settle address — pinned by app/__tests__/evm-identity.test.ts).
      const kp = deriveEvmKeypair(account!.secretHex);
      const expectedAddress = eip55(kp.address.toLowerCase());

      installSideShiftStub({initialStatus: 'waiting'});
      const hits0 = await sideshiftRelayHits();

      // §1 the gated pick: the ETH target carries the sideshift-eth row behind the expander.
      await openConvertFor(m, 'icp');
      await pickSwapTarget(m, 'ETH');
      await openOtherVenues(m);
      await m.driver.findByTestID('convert-venue-sideshift-eth', {timeoutMs: 8_000});
      await m.driver.click('convert-venue-sideshift-eth', {timeoutMs: 5_000});
      await typeConvertAmount(m, '3');
      // The payout rail is NAMED before anything can be confirmed.
      await m.driver.findByTestID('convert-settle-rail', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-settle-rail'), 'Ethereum', 'the settle-rail line names Ethereum mainnet');
      await m.driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
      const settle = m.driver.readText('convert-settle-address');
      assertIncludes(settle, expectedAddress, 'the payout address is the wallet\'s OWN derived EVM address');
      expect(settle.trim()).toBe(expectedAddress);
      await m.driver.waitForFunction(
        () => m!.driver.readTextSafe('convert-headline')?.includes('0.0495 ETH') === true,
        {timeoutMs: 20_000, label: 'the venue settle figure rendered'},
      );
      assertIncludes(m.driver.readText('convert-quote-source'), 'SideShift', 'the quote is attributed to SideShift');

      // NOTHING is adopted before the consent: the store is still empty.
      let store = await storeRecords(account!.publicHex);
      expect(Object.keys(store).length).toBe(0);

      // §2 THE ONE CONSENT: order + deposit handoff verbatim.
      const icpBefore = BigInt(await getBalance(account!.publicHex, 8));
      await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
      await m.driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
      assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS, 'the venue\'s deposit address renders VERBATIM');
      const handoff = m.driver.readText('convert-awaiting-deposit');
      assertIncludes(handoff, '3', 'the EXACT deposit amount renders');
      assertIncludes(handoff, 'holds', 'the handoff copy says the venue holds funds mid-trade');

      // The partner-key audit + the record's provenance.
      const hits = await sideshiftRelayHits();
      expect(hits.bareCalls - hits0.bareCalls).toBe(0);
      expect(hits.shiftCalls - hits0.shiftCalls).toBe(1);
      expect(hits.quoteCalls - hits0.quoteCalls).toBeGreaterThanOrEqual(2);
      store = await storeRecords(account!.publicHex);
      const rec = Object.values(store).find((r) => r != null && r.providerRef != null);
      expect(rec).not.toBeNull();
      expect(rec!.step).toBe('awaiting_deposit');
      expect(rec!.venueId).toBe('sideshift-eth');
      expect(rec!.outLedger).toBe(ETH_RAIL_ID);
      expect(rec!.outSymbol).toBe('ETH');
      expect(rec!.outDecimals).toBe(18);
      expect(rec!.destAddress).toBe(expectedAddress);
      expect(BigInt(await getBalance(account!.publicHex, 8))).toBe(icpBefore);

      // §3 reload: the payout watch resumes WITHOUT re-creating the order.
      const shiftsBefore = (await sideshiftRelayHits()).shiftCalls;
      await m.remount();
      await openConvertFor(m, 'icp', {timeoutMs: 8_000});
      await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
      expect((await sideshiftRelayHits()).shiftCalls).toBe(shiftsBefore);

      // §4 the venue settles: its own figures complete the record.
      setSideShiftStatus('settled', {settleAmount: '0.0495', settleHash: 'eth-settle-hash-223'});
      await m.driver.findByTestID('convert-done', {timeoutMs: 45_000});
      const done = m.driver.readText('convert-done');
      assertIncludes(done, '0.0495', 'done reports the VENUE\'s own settle amount');
      assertIncludes(done, 'ETH', 'done names the payout asset');
      assertIncludes(done, expectedAddress, 'done names the payout at the user\'s EVM address');
    } finally {
      if (m) await m.unmount().catch(() => undefined);
    }
  }, 300_000);
});

})();
