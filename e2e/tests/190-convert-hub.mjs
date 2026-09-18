// Flow 190 — IC hub 2-hop conversion (2026-09-18 hub UX widening of the multihop spec):
// VCHF → ICP → ETH as ONE user intent, device-signed as FOUR legs (approve/swap/approve/swap).
//
// The offline fake-IC seeds BOTH fixture pools the route composes (icpswap VCHF/ICP and
// icpswap-cketh ICP/ckETH, from dfx/catalog_truth.json via FakeIc::from_catalog), so the hub
// path is fully drivable end-to-end on the private test-helpers relay. This flow proves:
//   * the destination picker's D1–D6 shape on a hub-capable asset: ONE row per in-wallet
//     destination (ICP as the standing direct row, ckUSDC/ckETH/ckBTC as in-wallet rows) with
//     in-wallet copy — never the cash-out-only "to your <network> address" phrasing,
//   * a hub-only destination (ckETH: no direct pool anywhere in the registry) selects its only
//     mechanism directly — no sub-picker, no address input — and the quote branch is the
//     COMPOSED two-venue surface: both venues attributed on the headline, the `via ICP · 2
//     swaps` route chip, the in-wallet floor promise (routeMinWalletLine, not the at-address
//     phrasing), and the two-hop census folded behind the one Details control,
//   * all FOUR legs execute with per-leg status and the D15 step tracker ("Step n of 4 —"),
//     and the done panel is the in-wallet receipt — "Converted / <SEEN> ETH received in your
//     wallet" (the SEEN payout amount, never the expected; no address, no "on its way"),
//   * ledger truth (fake-IC bookkeeping): VCHF debited amount + two VCHF fees; ICP nets
//     gross1 − floor1 − two ICP fees (the above-floor surplus stays in-wallet); ckETH credited
//     the FULL gross of swap2 (the SEEN amount the receipt names),
//   * the mechanism sub-picker (D2/D5) on a direct+hub destination: ckUSDC shows `Direct pool`
//     first and `Via ICP` second in stable order — the sub-picker defaults to the direct pool
//     (UX §6 red line 9: a hub mechanism is an explicit switch away, never a default) — and
//     picking `Via ICP` arms the same composed surface for that destination (selection only;
//     the second conversion is NOT executed),
//   * a swap2 refusal (impact knob degrades the pool under the signed floor) lands in the hub
//     failed_leg taxonomy: the screen names the HUB asset (ICP) as the in-wallet position —
//     never failed_refunded (the input already converted) — and the books match: ICP holds
//     swap1's gross minus its own two fees, ckETH unchanged.
// Jest covers the failure-state matrix in depth (app/__tests__/convertHub.test.ts); this flow
// pins the REAL app surface end-to-end.
// Private relay (startRelay, the flow-183/184 pattern): execution mutates pool + ledger state,
// and the impact knob must never leak into a sibling flow's pools.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance,
  openBalances, selectCurrency,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKETH_LEDGER = 'ss2fx-dyaaa-aaaar-qacoq-cai';
const POOL_VCHF_ICP = '65mrh-fqaaa-aaaar-qapoa-cai'; // venue icpswap's OWN pool (token0 = VCHF)
const POOL_ICP_CKETH = 'angxa-baaaa-aaaag-qcvnq-cai'; // venue icpswap-cketh's OWN pool (token0 = ICP)

const DIRECT_ROW = 'convert-dest-direct'; // the standing pair (ICP), direct + via-ckUSDC hub merged
const CKUSDC_ROW = 'convert-dest-inwallet-2';
const CKETH_ROW = 'convert-dest-inwallet-6';
const CKBTC_ROW = 'convert-dest-inwallet-1';
const STANDING_HUB_MECH = 'convert-dest-mech-hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc'; // VCHF → ckUSDC → ICP
const CKUSDC_HUB_MECH = 'convert-dest-mech-hub:icpswap:8:icpswap-ckusdc'; // VCHF → ICP → ckUSDC

const SEED_VCHF = 2000000000; // 20 VCHF (plain Number — the faucet body is JSON)
const AMOUNT_IN = 200000000n; // 2 VCHF
const VCHF_FEE = 10000n; // 0.0001 VCHF
const ICP_FEE = 10000n; // 0.0001 ICP
const CKETH_FEE = 2000000000000n; // 0.000002 ckETH (the dest ledger's own fee)

/** The venue's own quote, read off the relay exactly as the app reads it (the oracle pattern of flows 183/184). */
async function relayQuote(relayBaseURL, pool, tokenIn, tokenOut, amountIn) {
  const res = await fetch(`${relayBaseURL}/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`);
  if (!res.ok) throw new Error(`relay oracle quote failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Raw ledger units → the compact formatter's string (given decimals, trailing zeros trimmed). */
function fmt(raw, decimals) {
  const n = BigInt(raw);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const d = BigInt(decimals);
  const frac = (abs % 10n ** d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${abs / 10n ** d}${frac ? '.' + frac : ''}`;
}

/** The app's exact 1% floor math (default 100 bps slippage). */
function floor99(gross) {
  return (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
}

/** The composed two-hop oracle, off the SAME pools the fake-IC will execute against. */
async function hubOracle(relayBaseURL, amountIn) {
  const q1 = await relayQuote(relayBaseURL, POOL_VCHF_ICP, VCHF_LEDGER, ICP_LEDGER, amountIn);
  assertEq(q1.venue_id, 'icpswap', 'leg 1 quotes under the icpswap venue id');
  assertEq(q1.zero_for_one, true, 'the VCHF/ICP pool\'s token0 is VCHF → VCHF in is zero_for_one true');
  const gross1 = BigInt(q1.amount_out);
  assert(gross1 > 0n, 'leg 1\'s quoted ICP output is non-zero');
  const minOut1 = floor99(gross1);
  const q2 = await relayQuote(relayBaseURL, POOL_ICP_CKETH, ICP_LEDGER, CKETH_LEDGER, minOut1);
  assertEq(q2.venue_id, 'icpswap-cketh', 'leg 2 quotes under the icpswap-cketh venue id');
  assertEq(q2.zero_for_one, true, 'the ICP/ckETH pool\'s token0 is ICP → ICP in is zero_for_one true');
  const gross2 = BigInt(q2.amount_out);
  assert(gross2 > CKETH_FEE, 'leg 2\'s gross clears the ckETH ledger fee (a real composed estimate)');
  return {gross1, minOut1, gross2, minOut2: floor99(gross2), net2: gross2 - CKETH_FEE};
}

async function swapPoolKnob(relayBaseURL, body) {
  const r = await fetch(`${relayBaseURL}/api/v1/test/swap_pool`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`swap_pool knob ${r.status}: ${await r.text()}`);
}

/** Open the Convert form on the VCHF account (selectCurrency leaves Pay on; re-open Balances
 *  so Convert — which renders on the SELECTED row only — is on screen). */
async function openVchfConvert(driver) {
  await openBalances(driver);
  await selectCurrency(driver, 'vchf');
  await openBalances(driver);
  await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
}

export const meta = {
  id: '190',
  name: 'convert-hub',
  journey: 'convert',
  covers: ['convert', 'hub', 'hub-route', 'two-hop', 'icpswap', 'vchf', 'icp', 'cketh', 'ckusdc', 'in-wallet-dest', 'dest-picker', 'mech-picker', 'composed-quote', 'hub-census', 'per-leg-status', 'in-wallet-receipt', 'ledger-truth', 'impact-knob-refusal'],
  verifies: 'A hub 2-hop conversion VCHF → ICP → ETH runs as one intent over the composed picker: in-wallet destination rows carry in-wallet copy (never cash-out phrasing), the hub-only ckETH destination arms the two-venue quote surface (composed headline, via-ICP chip, in-wallet floor promise, two-hop census, no address input), four legs execute with per-leg status and the D15 tracker, the done receipt names the SEEN ETH in-wallet, the books match the fake-IC truth exactly, the ckUSDC mechanism sub-picker orders Direct-pool before Via-ICP and picking Via-ICP arms the same surface, and a swap2 refusal lands the hub failed_leg taxonomy with the ICP position named and the books proving it.',
  timeoutMs: 120000, // onboard + two 4-leg executions + picker/mech asserts (flow-184 budget class)
};

export async function run() {
  const start = Date.now();
  console.log('[190-convert-hub] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[190-convert-hub] onboarding + funding 20 VCHF on the private relay…');
    await onboardWallet(driver, 'e2e-convert-hub');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_VCHF, {currency: 7});
    assert(fund.ok, `faucet VCHF credit ok (status ${fund.status})`);

    // --- the destination picker (D1–D6): ONE row per in-wallet asset, in-wallet copy -------------
    console.log('[190-convert-hub] destination picker: in-wallet rows from VCHF…');
    await openVchfConvert(driver);
    for (const [row, sym] of [[DIRECT_ROW, 'ICP'], [CKUSDC_ROW, 'USDC'], [CKETH_ROW, 'ETH'], [CKBTC_ROW, 'BTC']]) {
      const el = await driver.findByTestID(row, {timeoutMs: 5_000});
      assert(el != null, `the ${sym} destination row is offered`);
      const label = await driver.readText(row);
      assertIncludes(label, `${sym} — in this wallet`, `the ${sym} row is an in-wallet row`);
      assert(!label.includes('to your'), `the ${sym} row carries NO cash-out-only copy`);
    }
    // The standing ICP group merges BOTH mechanisms that reach the ICP ledger: the direct pool
    // and the via-ckUSDC hub route — direct first, and the direct pool is the shipped default
    // (UX §6 red line 9), so the standing sub-picker renders on open with direct checked.
    await driver.findByTestID(STANDING_HUB_MECH, {timeoutMs: 8_000});
    const standing = await driver.eval((directId, hubId) => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const d = q(directId);
      const h = q(hubId);
      if (d == null || h == null) return null;
      // RNW does not project accessibilityState → aria-checked (the flow-166 gap), so the
      // checked row is read STRUCTURALLY: the radio dot (10×10px rounded View) renders only
      // when the row is the active mechanism.
      const hasDot = (row) => Array.from(row.querySelectorAll('div')).some((el) => {
        const s = getComputedStyle(el);
        return parseFloat(s.width) === 10 && parseFloat(s.height) === 10 && parseFloat(s.borderRadius) === 5;
      });
      return {
        directFirst: !!(d.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING),
        directChecked: hasDot(d),
        hubChecked: hasDot(h),
      };
    }, 'convert-dest-mech-direct', STANDING_HUB_MECH);
    assert(standing != null && standing.directFirst, 'the standing group lists the direct pool BEFORE the via-ckUSDC hub route');
    assert(standing != null && standing.directChecked && !standing.hubChecked, 'the standing group defaults to the direct pool (radio-dot probe)');

    // --- the hub-only destination: ckETH (no direct pool anywhere in the registry) ---------------
    console.log('[190-convert-hub] hub-only dest ckETH: the composed quote branch…');
    await driver.click(CKETH_ROW);
    // Hub-only = exactly ONE mechanism → no sub-picker, and the hub mechanism auto-arms.
    assert(await driver.findByTestID('convert-dest-mechs', {timeoutMs: 1_000}).catch(() => null) == null,
      'a hub-only destination renders NO mechanism sub-picker (its only mechanism self-resolves)');
    assert(await driver.findByTestID('convert-dest-address', {timeoutMs: 1_000}).catch(() => null) == null,
      'a hub destination adds NO address input (the dest IS this wallet)');
    await driver.type('convert-amount', '2');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});

    // The oracle BEFORE confirming: the exact two quotes the composed surface shows.
    let {gross1, minOut1, gross2, minOut2, net2} = await hubOracle(r2.baseURL, AMOUNT_IN);
    const headline = await driver.readText('convert-headline');
    assertIncludes(headline, `${fmt(net2, 18)} ETH`, 'the headline states the COMPOSED net estimate (both hops, dest fee netted)');
    assertIncludes(await driver.readText('convert-quote-source'), 'Quotes from ICPSwap and ICPSwap, fetched ',
      'the attribution names BOTH venues verbatim (D11)');
    assertIncludes(await driver.readText('convert-route-via'), 'via ICP · 2 swaps', 'the route chip names the hub and the swap count (D8)');
    assertIncludes(await driver.readText('convert-route-min'),
      `At least ${fmt(minOut2, 18)} ETH stays in this wallet (slippage floor 1%)`,
      'the floor promise is the SECOND swap\'s floor as an in-wallet amount (D9)');
    // The two-hop census folds behind the ONE Details control (D10).
    await driver.click('convert-details', {timeoutMs: 5_000});
    const census = await driver.readText('convert-hub-census');
    assertIncludes(census, 'Two swaps, itemized', 'the census heading names the fold');
    assertIncludes(census, 'Combined rate, VCHF → ETH:', 'the composed rate names both ends');
    assertIncludes(census, 'Swap VCHF → ICP on ICPSwap', 'hop 1 names its venue and its pair');
    assertIncludes(census, 'Swap ICP → ETH on ICPSwap', 'hop 2 names its venue and its pair');
    assertIncludes(census, 'Pool fee: 0.30% (ICPSwap fee tier)', 'each hop names its own fee tier (both are 0.30%)');
    assertIncludes(census, 'Approving the next pool costs 0.0001 VCHF', 'hop 1\'s approve cost is its own census line');
    assertIncludes(census, 'Approving the next pool costs 0.0001 ICP', 'hop 2\'s approve cost is its own census line');
    assertIncludes(census, 'the surplus stays in this wallet as ICP or ETH.', 'the surplus note covers both hops');
    await driver.screenshot('190-convert-hub-quote');

    // --- confirm: four legs, per-leg status, the D15 tracker, the in-wallet receipt --------------
    console.log('[190-convert-hub] confirming the hub intent (4 legs)…');
    let confirmed = false;
    for (let round = 0; round < 5 && !confirmed; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) {
        confirmed = true;
        break;
      }
      console.log(`[190-convert-hub] quote moved (round ${round + 1}) — re-reviewing and confirming again`);
      ({gross1, minOut1, gross2, minOut2, net2} = await hubOracle(r2.baseURL, AMOUNT_IN));
    }
    assert(confirmed, 'the confirm took (a private relay never drifts the pair)');
    await driver.findByTestID('convert-state', {timeoutMs: 10_000});
    // The D15 tracker: "Step n of 4 — <the current leg's own label>" while any leg is open.
    // The tracker is a SHOULD: a fast run (or a loaded host) can finish the whole 4-leg run
    // between ticks, unmounting the tracker — if the done surface is already up, observing
    // the transient is moot. Bounded budget, short reads (never the driver's 9s default).
    let stepText = null;
    let sawDone = false;
    const trackerDeadline = Date.now() + 12_000;
    while (Date.now() < trackerDeadline) {
      const t = await driver.readText('convert-step', {timeoutMs: 300}).catch(() => null);
      if (t != null && /^Step \d of 4 — /.test(t)) { stepText = t; break; }
      if (await driver.findByTestID('convert-done', {timeoutMs: 300}).catch(() => null) != null) { sawDone = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (stepText == null && sawDone) {
      console.log('[190-convert-hub] run completed before the transient step tracker was observed (SHOULD, skipping)');
    }
    assert(stepText != null || sawDone, `the step tracker renders "Step n of 4 — <leg label>" while the run is live (last read: ${stepText})`);
    assert(await driver.waitForText('Converted', {timeoutMs: 60_000}), 'the run reaches the done receipt');
    // The hub record keeps the plain selection heading (D12) — not a route line with a network.
    const stateText = await driver.readText('convert-state');
    assertIncludes(stateText, 'Convert VCHF → ETH', 'the state screen keeps the plain selection heading (D12)');
    // The leg list stays FULLY expanded (D14): four legs, each confirmed, approve legs fee'd.
    assert(await driver.findByTestID('convert-route-legs', {timeoutMs: 2_000}) != null, 'the leg list renders');
    const legLabels = [
      'Approve the pool to pull your VCHF',
      'Swap VCHF → ICP on ICPSwap',
      'Approve the pool to pull your ICP',
      'Swap ICP → ETH on ICPSwap',
    ];
    for (let i = 0; i < 4; i++) {
      assertIncludes(await driver.readText(`convert-leg-${i}`), legLabels[i], `leg ${i} carries its own label`);
      const state = await driver.readText(`convert-leg-${i}-state`);
      assertIncludes(state, 'Confirmed', `leg ${i} reads Confirmed after the run`);
    }
    assertIncludes(await driver.readText('convert-leg-0-state'), '· 0.0001 VCHF', 'leg 1\'s approve fee is its own ledger\'s fee');
    assertIncludes(await driver.readText('convert-leg-2-state'), '· 0.0001 ICP', 'leg 3\'s approve fee is the hub ledger\'s fee');
    // The in-wallet receipt (D17): the SEEN dest amount, no address, no "on its way".
    const done = await driver.readText('convert-done');
    assertIncludes(done, 'Converted', 'the done title is the in-wallet receipt\'s title');
    assertIncludes(done, `${fmt(gross2, 18)} ETH received in your wallet.`, 'the receipt names the SEEN payout amount (full gross, not the expected net)');
    assertIncludes(done, 'Payout record: ', 'the receipt carries the dest-ledger payout record');
    assert(!done.includes('on its way') && !stateText.includes('Ethereum'), 'no cash-out copy leaks into the in-wallet receipt (D17)');
    await driver.screenshot('190-convert-hub-done');

    // Ledger truth (fake-IC bookkeeping): VCHF debited amount + two VCHF fees; ICP nets
    // gross1 − floor1 − two ICP fees (the surplus stays in-wallet); ckETH credited full gross.
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 7)),
      BigInt(SEED_VCHF) - AMOUNT_IN - 2n * VCHF_FEE, 'VCHF debited the amount plus its two ledger fees');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 8)),
      gross1 - minOut1 - 2n * ICP_FEE, 'ICP nets swap1\'s gross minus the signed floor minus its two fees');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 6)),
      gross2, 'ckETH holds the full swap2 gross (the SEEN amount)');

    // --- the mechanism sub-picker (D2/D5): ckUSDC has direct + via-ICP; selection only -----------
    console.log('[190-convert-hub] mechanism sub-picker on ckUSDC (no execution)…');
    await openVchfConvert(driver);
    await driver.click(CKUSDC_ROW);
    await driver.findByTestID('convert-dest-mechs', {timeoutMs: 5_000});
    const mechs = await driver.eval((directId, hubId) => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const d = q(directId);
      const h = q(hubId);
      if (d == null || h == null) return null;
      const hasDot = (row) => Array.from(row.querySelectorAll('div')).some((el) => {
        const s = getComputedStyle(el);
        return parseFloat(s.width) === 10 && parseFloat(s.height) === 10 && parseFloat(s.borderRadius) === 5;
      });
      return {
        directFirst: !!(d.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING),
        directChecked: hasDot(d),
        hubChecked: hasDot(h),
      };
    }, 'convert-dest-mech-direct', CKUSDC_HUB_MECH);
    assert(mechs != null, 'the ckUSDC sub-picker shows the direct row and the Via-ICP hub row');
    assert(mechs.directFirst, 'the sub-picker order is stable: Direct pool first, Via ICP second (registry order, never ranked)');
    assert(mechs.directChecked && !mechs.hubChecked,
      'the sub-picker defaults to the direct pool (a hub mechanism is an explicit switch away, UX §6 red line 9; radio-dot probe)');
    const hubRow = await driver.readText(CKUSDC_HUB_MECH);
    assertIncludes(hubRow, 'Via ICP', 'the unpicked hub row names its mechanism');
    assertIncludes(hubRow, 'via ICP · 2 swaps', 'the unpicked hub row carries its static shape line (D5)');
    assert(await driver.findByTestID('convert-route-via', {timeoutMs: 1_000}).catch(() => null) == null,
      'no hub surface is armed while the direct mechanism is the pick');
    // Pick `Via ICP` → the SAME composed surface arms for ckUSDC. Selection-surface assertions
    // only — this second conversion is deliberately NOT executed.
    await driver.click(CKUSDC_HUB_MECH);
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    assertIncludes(await driver.readText('convert-route-via'), 'via ICP · 2 swaps', 'picking Via ICP arms the composed surface for ckUSDC');
    assert(await driver.findByTestID('convert-dest-address', {timeoutMs: 1_000}).catch(() => null) == null,
      'still no address input under a hub pick');
    await driver.screenshot('190-convert-hub-mechs');

    // --- the swap2 refusal: the hub failed_leg taxonomy (impact knob under the signed floor) -----
    // Deterministic choreography (the render-lag-safe variant of flow 141's knobs): parking
    // swap1 on the honest pending_withdrawal state FREEZES the run between swap1 and swap2, so
    // the hop pool can be degraded with ZERO race against the engine's leg cadence — then one
    // settle drains the queue, swap1 confirms, and swap2 walks into the degraded pool.
    console.log('[190-convert-hub] swap2 refusal: park on pending_withdrawal, degrade the hop pool, settle…');
    await openVchfConvert(driver);
    await driver.click(CKETH_ROW);
    await driver.type('convert-amount', '2');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    let run2 = await hubOracle(r2.baseURL, AMOUNT_IN); // fresh: run 1 moved both pools
    // fail_withdrawal does NOT touch the quote curve — the confirm-time re-quote still matches.
    await swapPoolKnob(r2.baseURL, {pool: POOL_VCHF_ICP, fail_withdrawal: true});
    let run2Confirmed = false;
    for (let round = 0; round < 5 && !run2Confirmed; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) {
        run2Confirmed = true;
        break;
      }
      run2 = await hubOracle(r2.baseURL, AMOUNT_IN);
    }
    assert(run2Confirmed, 'the second confirm took');
    // swap1 executes (#ok) but its payout row never lands → the run parks on the honest
    // pending_withdrawal screen (flow 141's semantics) — a STABLE state, not a race window.
    let parked = null;
    for (let i = 0; i < 40 && parked == null; i++) {
      parked = await driver.findByTestID('convert-pending', {timeoutMs: 500}).catch(() => null);
    }
    assert(parked != null, 'swap1 parks on pending_withdrawal (its payout is queued, not paid)');
    // NOW degrade the hop pool: any swap2 executed from here pays 5% of its curve — far below
    // the floor signed into the frozen legs.
    await swapPoolKnob(r2.baseURL, {pool: POOL_ICP_CKETH, impact_bps: 9500});
    // Drain the queued payout → the hop ledger row appears → swap1 confirms → the engine
    // marches on to approve2 + swap2, and swap2 refuses below its signed floor.
    await swapPoolKnob(r2.baseURL, {pool: POOL_VCHF_ICP, fail_withdrawal: false, settle_pending: true});
    // Wait for the refusal, logging every leg-state TRANSITION so a stall names itself.
    let refused = null;
    let lastLegs = '';
    for (let i = 0; i < 60 && refused == null; i++) {
      refused = await driver.findByTestID('convert-failed-leg', {timeoutMs: 300}).catch(() => null);
      if (refused != null) break;
      const s2 = await driver.readText('convert-leg-2-state').catch(() => '?');
      const s3 = await driver.readText('convert-leg-3-state').catch(() => '?');
      const cur = `${s2}|${s3}`;
      if (cur !== lastLegs) { console.log(`[190-convert-hub] refusal wait: leg3(approve)=${s2} leg4(swap)=${s3}`); lastLegs = cur; }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(refused != null, 'swap2 refuses below the signed floor → the hub failed_leg screen');
    assertIncludes(await driver.readText('convert-leg-3-state'), 'Refused', 'the refused leg names itself');
    const failed = await driver.readText('convert-failed-leg');
    assertIncludes(failed, 'ICP', 'the failure names the HUB asset as the in-wallet position (D18)');
    assertIncludes(failed, 'ETH', 'the failure names what the refused leg was bound for');
    assert(!(await driver.bodyText()).includes('received in your wallet'), 'done is NEVER fabricated past a refused leg');
    await driver.screenshot('190-convert-hub-refused');
    // Books: swap2 pulled NOTHING — the user holds swap1's whole gross minus ICP's own fees.
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 7)),
      BigInt(SEED_VCHF) - 2n * (AMOUNT_IN + 2n * VCHF_FEE), 'VCHF paid for both intents and nothing else');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 8)),
      (gross1 - minOut1 - 2n * ICP_FEE) + (run2.gross1 - ICP_FEE),
      'ICP holds run 1\'s surplus plus run 2\'s whole gross minus its approve fee only — the refused swap never pulled its input (or its fee)');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 6)),
      gross2, 'ckETH is unchanged — the refused leg never paid');

    console.log(`[190-convert-hub] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await r2.stop();
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    process.exit(0);
  }, (e) => {
    console.error('190-convert-hub RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
