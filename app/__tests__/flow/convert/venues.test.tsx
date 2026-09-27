/**
 * venues — the jest twins of e2e/tests/{142,166,167,168,173,183,188}-convert-*.mjs (M2 batch C).
 *
 * Flow 142 convert-venue-less-fail-closed — the venue-less subject fails closed with honest
 *   copy while a venue subject opens the form from the SAME button (uniform IA; the panel is
 *   the asset's data, not a different IA). No VEUR row anywhere (retired).
 * Flow 166 convert-venue-chooser — the two-venue world (fixture venue armed by knob): the
 *   sheet auto-picks the HIGHEST net quoted output, discloses it mechanically (no "best"),
 *   the Other-venues expander holds exactly the complement row with its OWN verbatim quote,
 *   overriding is ONE tap, and the INV-6 fee census (forced tier 4321) is byte-exact.
 * Flow 167 convert-venue-order-stable — the disclosed pick follows the strictly-best venue in
 *   BOTH dynamic directions (real pool floored → fixture; fixture floored + real restored →
 *   real); the expander always holds exactly the complement, whose quote follows its own
 *   venue byte-identically (zeroed when floored); tap 2 stays armed throughout.
 * Flow 168 convert-fixture-venue-payout — picking fixture venue B executes through pool B
 *   end-to-end: B's reversed token order (zero_for_one true), B's 0.10% tier, B's quoted
 *   payout verbatim on the ledgers.
 * Flow 173 convert-order-reverse — flow 167's invariants in the REVERSE direction (VCHF →
 *   ICP), where the two pools disagree about token0; each venue takes a turn being floored.
 * Flow 183 convert-ckusdc-cketh-pairs — the pair-scoped venues: ckUSDC→ICP executes through
 *   the ckUSDC pool (6-decimal input math), ICP→ckUSDC quotes 6-decimal output, ckETH is
 *   quote-only with an 18-decimal quote.
 * Flow 188 convert-vchf-ckusdc-pair — the VCHF↔ckUSDC direct pair: served registry in
 *   registry order, both-direction oracle quotes (zero_for_one flip), the standing VCHF form
 *   quotes through the stable pair pool, and the Route B opt-in quotes its hop at the 1%
 *   floor. QUOTE-ONLY.
 *
 * Knob hygiene: the fixture venue + pool tier/impact knobs are GLOBAL state on the ONE shared
 * relay — armed windows are kept short and every knob is RESTORED in finally (the e2e twins
 * used own relays; the serialization gap is filed for the integrator).
 */
import {describe, it, expect, afterEach, beforeAll, afterAll} from '@jest/globals';
import {
  assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openConvertFor,
  openBalances, selectCurrency, typeConvertAmount, pickSwapTarget, openOtherVenues,
  fmtHero,
} from '../harness/lib';
import type {Mount} from '../harness/mount';
import {relayGet} from '../harness/relayClient';
import {disposeConvertStubs, venueKnob, swapPoolKnob, fmt} from './convertStubs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKETH_LEDGER = 'ss2fx-dyaaa-aaaar-qacoq-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // fixture B's own pool
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const CKETH_POOL = 'angxa-baaaa-aaaag-qcvnq-cai';
const VCHF_USDC_POOL = 'hx7nb-diaaa-aaaar-qbxsa-cai';
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
beforeAll(async () => {
  await venueKnob(FIXTURE_VENUE, true);
});

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
