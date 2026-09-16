// Flow 140 — delegated conversion happy path: Balances → ICP → Convert → every §5 line → confirm → done.
//
// The PoC's one happy-path proof (spec 2026-09-07 §6 e2e (a)), through the REAL app against the
// offline test-helpers relay's fake-IC pool:
//   * §0.6 RED LINE FIRST: a payment-review card (the ICP deeplink explicit-approve surface)
//     carries NO conversion offer/hint anywhere — "Convert" must not appear on it. Recipient-side
//     conversion is a §0 red line, so this is asserted before anything else.
//   * Entry point is the UNIFORM asset action row: Accounts ▸ ICP row ▸ Convert (btn-accounts-convert) —
//     the same button every asset gets (uniform-IA hard rule); ICP simply has a venue behind it.
//   * EVERY §5 transparency checklist item is a rendered line on the ONE pre-signing surface, each
//     asserted by testID: counterparty (pool principal, autonomous contract, not licensed/not
//     dpay, phone-signs), the venue disclosure sentence, attributed+timestamped rate, pool fee
//     tier 0.30%, input fee, output fee, dpay-paid-nothing, minimum-you'll-receive + refusal
//     outcome, net end state. NO price-impact line (removed 2026-09-11, spec V8: the venue
//     publishes no such figure and none is invented).
//     Amounts are cross-checked against the relay's OWN quote response fetched flow-side (single
//     source of truth — the app must render the venue's numbers, never its own math).
//   * Confirm re-quotes (spec §5), then the §4 state machine runs on-device-signed envelopes:
//     icrc2_approve (exact amount + expected_allowance + 10-min expiry) → depositFromAndSwap →
//     ledger-watch settle → done{out_amount_net,out_tx} — done NEVER from the pool #ok alone.
//   * Settlement is exact: ICP −(amount + approve fee + input fee), VCHF +gross out (fake pool
//     credits the full gross; the SEEN ledger row is the record's out_amount_net), and the
//     Ledger/Recent tab shows the incoming VCHF row from the pool's short principal.
//   * Screenshots: the pre-signing checklist, the in-flight state panel, done, and the ledger row.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, railPrincipalText,
} from '../harness/lib.mjs';
import { openHistory } from '../harness/flow-steps.mjs';
import { generateKeypair, randNonceHex } from '../harness/wire.mjs';
import { startRelay } from '../harness/relay.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai';
const ICP_FEE = 10000n; // raw e8s, the catalog fee field the deposit sheets also show
const VCHF_FEE = 10000n;
const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const AMOUNT_IN = 100000000n; // 1 ICP

/** Relay quote oracle — the venue's own numbers, fetched flow-side (never restated). */
async function relayQuote(relayBaseURL, tokenIn, tokenOut, amountIn) {
  const u = `${relayBaseURL}/api/v1/swap_quote?pool=${POOL}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`swap_quote ${r.status}: ${await r.text()}`);
  return r.json();
}

/** fmtAssetCompact twin (8 decimals, trailing zeros trimmed, '.' separator — the web driver
  * locale). The app renders the compact formatter everywhere now (founder rule 2026-09-13). */
function fmt8(raw) {
  const n = BigInt(raw);
  const whole = n / 100000000n;
  let frac = (n % 100000000n).toString().padStart(8, '0');
  frac = frac.replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export const meta = {
  id: '140',
  name: 'convert-happy-path',
  journey: 'convert',
  covers: ['convert', 'icp', 'vchf', 'uniform-ia', 'transparency-checklist', 'counterparty', 'venue-disclosure', 'quote-attribution', 'fees-itemised', 'no-impact-line', 'min-out', 'slippage', 'icrc2-approve', 'deposit-from-and-swap', 'state-machine', 'ledger-watch', 'settle', 'balance-refresh', 'ledger-row', 'no-mid-payment-conversion'],
  verifies: 'The delegated-conversion happy path: a payment review carries no Convert anywhere (§0.6); Accounts ▸ ICP ▸ Convert opens the one pre-signing surface where every §5 line renders (counterparty/pool principal, the venue disclosure sentence, attributed+timestamped quote, itemised fees, dpay-paid-nothing, NO impact line, minimum+refusal, net end state — all matching the relay\'s own quote); confirm re-quotes then signs approve+swap on-device; settle is exact (ICP −amount−2 fees, VCHF +gross) with done derived from the SEEN ledger row and the Ledger showing the incoming VCHF row from the pool.',
  timeoutMs: 180000, // onboard + review-navigation + quote + approve/swap submit+poll + settle watch (120 s inner wait) + ledger polls
};

export async function run() {
  const start = Date.now();
  console.log('[140-convert-happy-path] setup (own relay + shared web + browser)…');
  const env = await setup();
  // Own fake-IC gateway: the shared pool's constant-product reserves are mutated by sibling
  // convert flows running in parallel (flow 143's comment names the class), which raced this
  // flow's flow-side quote oracle against the screen's own fetch (~2e-6 relative). A private
  // relay makes the 1-ICP happy path deterministic end to end.
  const r2 = await startRelay();
  try {
    const { webBaseURL, driver } = env;
    const relayBaseURL = r2.baseURL;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });

    // --- Onboard, then the §0.6 red line FIRST: the payment review offers NO conversion ---------
    console.log('[140-convert-happy-path] onboarding + payment-review no-Convert red line…');
    await onboardWallet(driver, 'e2e-convert-happy');
    const account = await accountOf(driver);

    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    await driver.navigate(
      webBaseURL,
      `/wallet/pay/${bobPrincipal}?asset=ICP&network=internet-computer&amount=1.00000001&label=Bob&ref=${randNonceHex()}`
        + `&relay=${encodeURIComponent(relayBaseURL)}`,
      { waitUntil: 'domcontentloaded', timeoutMs: 8_000 },
    );
    await driver.waitReady({ timeoutMs: 10_000 });
    assert(await driver.findByTestID('pay-amount', { timeoutMs: 8_000 }) != null, 'payment link reaches the review card');
    const reviewBody = await driver.bodyText();
    assert(!reviewBody.includes('Convert'), '§0.6: the payment review card offers/suggests NO conversion (no "Convert" text)');
    await driver.navigate(webBaseURL, `/wallet?relay=${encodeURIComponent(relayBaseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // --- Fund ICP; enter through the uniform action row ----------------------------------------
    console.log('[140-convert-happy-path] faucet 3 ICP and open Convert from the accounts action row…');
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    // selectCurrency makes ICP the active asset and leaves on Pay; re-open the accounts route so
    // Convert (which renders on the SELECTED row only) is on screen.
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.waitForText('Convert', { timeoutMs: 6_000 });
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('convert-screen', { timeoutMs: 8_000 }) != null, 'Convert surface opens for ICP (venue exists)');

    // --- The one pre-signing surface: EVERY §5 checklist line, asserted one by one --------------
    console.log('[140-convert-happy-path] asserting every §5 transparency line…');
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-quote-source', { timeoutMs: 10_000 });

    const oracle = await relayQuote(relayBaseURL, ICP_LEDGER, VCHF_LEDGER, AMOUNT_IN);
    // The relay derives this from the POOL's own metadata, not from a pin. On the venue as
    // MEASURED 2026-09-08 (token0 = VCHF, token1 = ICP) an ICP-in trade is token1-in ⇒ FALSE.
    // The 2026-09-07 build pinned the pair backwards, so this bit read `true` in production and
    // every ICP→VCHF quote came back at the VCHF→ICP rate (~5.9x against the user).
    assertEq(oracle.zero_for_one, false, 'relay derives zero_for_one from the pool\'s own pair (ICP is token1)');
    assertEq(oracle.fee_millionths, 3000, 'the venue\'s OWN fee tier is echoed by the relay, not claimed by dpay');
    assertEq(oracle.venue_id, 'icpswap', 'the quote is ATTRIBUTED to its venue (registry venue_id echo)');
    const gross = BigInt(oracle.amount_out);
    const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // the core's exact floor math
    const net = gross - VCHF_FEE;

    const counterparty = await driver.readText('convert-counterparty');
    assertIncludes(counterparty, POOL, 'counterparty names the pool principal');
    assertIncludes(counterparty, 'ICPSwap', 'counterparty names ICPSwap');
    assertIncludes(counterparty, 'autonomous on-chain contract', 'counterparty: autonomous contract, not a provider');
    assertIncludes(counterparty, 'not a licensed provider and not dpay', 'counterparty: not licensed, not dpay');
    assertIncludes(counterparty, 'Your phone signs', 'counterparty: the phone signs, the pool pulls exactly the approved amount');

    const quoteSource = await driver.readText('convert-quote-source');
    assertIncludes(quoteSource, 'Quote from ICPSwap, fetched', 'rate is attributed + timestamped');
    // formatClock is locale-aware (12h "12:35 PM" or 24h "14:32:05") — the spec pins attribution
    // + an instant, not one clock format; accept whatever the active locale's clock renders.
    assert(/\d{1,2}:\d{2}/.test(quoteSource), `quote carries a clock instant (${quoteSource})`);

    assertIncludes(await driver.readText('convert-rate'), 'ICP', 'rate line names the input unit');
    assertIncludes(await driver.readText('convert-rate'), 'VCHF', 'rate line names the output unit');
    assertIncludes(await driver.readText('convert-pool-fee'), '0.30%', 'pool fee tier is itemised (0.3%)');
    assertIncludes(await driver.readText('convert-in-fee'), `${fmt8(ICP_FEE)} ICP`, `input fee line is the catalog fee (${fmt8(ICP_FEE)} ICP)`);
    assertIncludes(await driver.readText('convert-out-fee'), `${fmt8(VCHF_FEE)} VCHF`, `output fee line is the catalog fee (${fmt8(VCHF_FEE)} VCHF)`);
    assertIncludes(await driver.readText('convert-dpay-fee'), 'dpay charges nothing and is paid nothing', 'dpay-paid-nothing line');

    // NO price-impact line renders (removed 2026-09-11, spec V8 "display what the venue
    // publishes, derive only what it does not"): it was dpay's own curve-slope estimate from a
    // SECOND reference quote — a second relay call per keystroke presented as venue fact. The
    // venue publishes no impact, so the checklist renders none; minimum-received + slippage are
    // the execution protection and stay.
    assert(await driver.findByTestID('convert-impact', {timeoutMs: 1_000}).catch(() => null) == null,
      'no price-impact line renders (the venue publishes none)');

    // WAITED FOR, not sampled: the quote and the min-out it derives arrive on a relay round trip,
    // so reading the line the instant it mounts races the number into it. Under parallel load that
    // race is what a red here means — and a gate that fails for a non-reason teaches everyone to
    // ignore it. The ASSERTION is unchanged: the exact figure, or nothing.
    assert(await driver.waitForText(`${fmt8(minOut)} VCHF`, {timeoutMs: 8_000}),
      `minimum-you'll-receive is the core's min-out at 1% (${fmt8(minOut)} VCHF); screen:\n${(await driver.readText('convert-min-out'))}`);
    assertIncludes(await driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown (default 1%)');

    const refusal = await driver.readText('convert-refusal');
    assertIncludes(refusal, 'ICP', 'refusal outcome names the asset the user keeps');
    assertIncludes(refusal, 'approval expires', 'refusal outcome: the approval expires unused');

    assertIncludes(await driver.readText('convert-net'), `${fmt8(net)} VCHF`, `net end state is gross − output fee (${fmt8(net)} VCHF)`);

    // Slippage options: 0.5 / 1 / 3%, all rendered, default 1%.
    for (const bps of [50, 100, 300]) {
      assert(await driver.findByTestID(`convert-bps-${bps}`, { timeoutMs: 3_000 }) != null, `slippage chip ${bps} present`);
    }
    // Switching to 0.5% re-derives min-out live (the derivation the user signs against).
    await driver.click('convert-bps-50', { timeoutMs: 4_000 });
    const min50 = (gross / 10000n) * 9950n + ((gross % 10000n) * 9950n) / 10000n;
    await driver.waitForFunction(
      () => document.querySelector('[data-testid="convert-min-out"]')?.textContent?.includes('0.50% slippage'),
      { timeoutMs: 6_000 },
    );
    assertIncludes(await driver.readText('convert-min-out'), `${fmt8(min50)} VCHF`, `min-out re-derives at 0.5% (${fmt8(min50)} VCHF)`);
    await driver.click('convert-bps-100', { timeoutMs: 4_000 }); // back to the default before confirming

    await driver.screenshot('140-convert-checklist');

    // --- Confirm: re-quote, then the §4 state machine on identical envelopes --------------------
    console.log('[140-convert-happy-path] confirm → approve → swap → settle…');
    // `gross` the checklist asserted is the quote at form time; the swap only signs when the
    // confirm re-quote comes back UNCHANGED (§5 "re-quote at confirm"). Sibling convert flows
    // swap against the SAME shared fake pool, so a swap landing between form and confirm trips
    // the quote-changed interrupt — correct product behavior (never sign a stale number), so
    // this loop re-reads the pool's own quote, asserts the interrupt copy, and re-confirms.
    // The EXECUTED swap always pays the last accepted quote exactly, so settlement asserts use
    // `executedGross` (updated on every interrupt), not the form-time number.
    let executedGross = gross;
    let doneText = false;
    for (let round = 0; round < 5 && !doneText; round++) {
      await driver.click('btn-convert-confirm', { timeoutMs: 6_000 });
      // In-flight: the state panel with practical copy for every non-done step (founder hard
      // rule). The approve→swap→settle chain slows under the FULL suite's parallel contention —
      // budget 60 s per round. waitForText returns FALSE on timeout (soft-probe contract).
      doneText = await driver.waitForText('Converted', { timeoutMs: 60_000 });
      if (doneText) break;
      const changed = await driver.readText('convert-quote-changed').catch(() => null);
      if (changed != null) {
        assertIncludes(changed, 'Quote changed', 'interrupt names itself');
        assertIncludes(changed, 'Review and confirm again', 'interrupt asks for a re-review');
        executedGross = BigInt((await relayQuote(relayBaseURL, ICP_LEDGER, VCHF_LEDGER, AMOUNT_IN)).amount_out);
        console.log('[140-convert-happy-path] pool drifted (shared pool) → re-confirmed at the fresh quote');
        continue; // the form is re-armed; sign against the number the screen now shows
      }
      const state = await driver.readText('convert-state').catch(() => '(absent)');
      if (state === '(absent)') {
        const confirmErr = await driver.readText('convert-confirm-err').catch(() => '(absent)');
        const quoteErr = await driver.readText('convert-quote-err').catch(() => '(absent)');
        throw new Error(
          `confirm produced no state panel in 60 s (round ${round}) — convert-state: ${state}; convert-confirm-err: ${confirmErr}; convert-quote-err: ${quoteErr}`,
        );
      }
      // else: an in-flight panel (approving/swapping/settling) — keep waiting within the next round.
    }
    if (!doneText) {
      const state = await driver.readText('convert-state').catch(() => '(absent)');
      throw new Error(`done never rendered — last convert-state: ${state}`);
    }
    assert(doneText, 'done panel renders');
    await driver.screenshot('140-convert-inflight-or-done');
    const doneBody = await driver.readText('convert-done');
    assertIncludes(doneBody, 'VCHF', 'done names the asset received');
    assertIncludes(doneBody, `${fmt8(executedGross)} VCHF`, `done amount is the SEEN ledger row (pool credits full gross: ${fmt8(executedGross)} VCHF)`);
    const payout = await driver.readText('convert-done');
    assert(/Payout record/.test(payout), 'done carries the payout record line (out_tx)');

    // --- Exact settlement against the fake-IC books ----------------------------------------------
    console.log('[140-convert-happy-path] asserting exact settlement…');
    const icpAfter = await getBalance(relayBaseURL, account.publicHex, 8);
    const vchfAfter = await getBalance(relayBaseURL, account.publicHex, 7);
    assertEq(BigInt(icpAfter), BigInt(SEED) - AMOUNT_IN - ICP_FEE - ICP_FEE, 'ICP: −amount − approve fee − input fee');
    assertEq(BigInt(vchfAfter), executedGross, 'VCHF: +gross out (the pool credits the full output)');

    // --- Ledger row: the incoming VCHF transfer from the pool's short principal -------------------
    console.log('[140-convert-happy-path] asserting the Ledger row…');
    await openHistory(driver, { timeoutMs: 5_000 });
    await driver.waitForText(POOL.slice(0, 8), { timeoutMs: 12_000 });
    const ledgerBody = await driver.bodyText();
    assertIncludes(ledgerBody, 'VCHF', 'ledger shows the VCHF conversion row');
    assertIncludes(ledgerBody, POOL.slice(0, 8), 'ledger row counterparty is the pool\'s short principal');
    await driver.screenshot('140-convert-ledger');

    console.log(`[140-convert-happy-path] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('140-convert-happy-path RED:', e.stack || e.message || e);
  });
}
