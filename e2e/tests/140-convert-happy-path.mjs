// Flow 140 — the TWO-TAP convert drive: Balances → ICP ▸ Convert (tap 1) → Convert 1 ICP (tap 2) → done.
//
// The founder's 2-click directive (design brief Part V, 2026-09-26), through the REAL app
// against the offline test-helpers relay's fake-IC pool:
//   * §0.6 RED LINE FIRST: a payment-review card carries NO conversion offer anywhere —
//     "Convert" must not appear on it.
//   * Entry is the uniform currency-row Convert button (tap 1). The INTENT SHEET opens fully
//     pre-computed: the amount pre-filled to the spendable max net of route fees, the standing
//     target on its line, the single venue auto-picked and DISCLOSED mechanically ("Executed
//     via ICPSwap"), the 1% floor visible, the census folded behind Details. The flow types
//     `1` over the prefill to pin the money math against the relay oracle.
//   * EVERY §5 transparency fact survives: attribution + timestamp, pool fee tier, both
//     ledger fees, counterparty + pool principal, the venue disclosure sentence, the refusal
//     outcome, minimum-you'll-receive at the default 1% slippage. The slippage CHIP AXIS is
//     gone (a disclosed default inside Details now); dpay-paid-nothing / net / impact lines
//     stay gone — absences asserted.
//   * Tap 2 = the CTA ("Convert 1 ICP"): re-quotes fresh at the gesture, then the §4 engine
//     runs on-device-signed envelopes; the screen floods to the SETTLEMENT FIELD (the
//     full-bleed in-flight tracker) and resolves to done with the SEEN ledger figure.
//   * Settlement is exact: ICP −(amount + approve fee + input fee), VCHF +gross out, and the
//     Ledger shows the incoming VCHF row from the pool's short principal.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openConvertFor, railPrincipalText,
  typeConvertAmount, fmtHero,
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
  * locale). The app renders the compact formatter everywhere (founder rule 2026-09-13). */
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
  covers: ['convert', 'icp', 'vchf', 'two-tap', 'intent-sheet', 'uniform-ia', 'auto-venue-pick', 'quote-attribution', 'fees-itemised', 'no-impact-line', 'min-out', 'slippage-default', 'icrc2-approve', 'deposit-from-and-swap', 'settlement-field', 'ledger-watch', 'settle', 'balance-refresh', 'ledger-row', 'no-mid-payment-conversion'],
  verifies: 'The TWO-TAP convert: a payment review carries no Convert anywhere (§0.6); Accounts ▸ ICP ▸ Convert opens the pre-computed intent sheet (amount prefilled to the net max, standing target on its line, the single venue auto-picked and disclosed mechanically, floor + attributed quote on the card, the §5 census folding behind Details with the slippage chips GONE — a disclosed 1% default instead); tap 2 (Convert 1 ICP) re-quotes then signs approve+swap on-device through the Settlement Field tracker; settle is exact (ICP −amount−2 fees, VCHF +gross) with done derived from the SEEN ledger row and the Ledger showing the incoming VCHF row.',
  timeoutMs: 180000,
};

export async function run() {
  const start = Date.now();
  console.log('[140-convert-happy-path] setup (own relay + shared web + browser)…');
  const env = await setup();
  // Own fake-IC gateway: the shared pool's constant-product reserves are mutated by sibling
  // convert flows running in parallel (flow 143's comment names the class), which raced this
  // flow's flow-side quote oracle against the screen's own fetch. A private relay makes the
  // 1-ICP drive deterministic end to end.
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

    // --- Fund ICP; TAP 1 — the uniform currency-row Convert button opens the pre-computed sheet -
    console.log('[140-convert-happy-path] faucet 3 ICP; tap 1 opens the intent sheet…');
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    await openConvertFor(driver, 'icp');
    assert(await driver.findByTestID('convert-sheet', { timeoutMs: 8_000 }) != null, 'tap 1 lands on the intent sheet (venue exists)');

    // Pre-computed on open: the amount prefilled to the net max (3 ICP − the two ledger fees),
    // the single venue auto-picked and disclosed mechanically, the CTA already armed.
    await driver.findByTestID('convert-venue-auto', { timeoutMs: 10_000 });
    const autoLine = await driver.readText('convert-venue-auto');
    assertIncludes(autoLine, 'Executed via ICPSwap', 'the venue pick is disclosed mechanically (attribution, no "best" claim)');
    assert(!autoLine.toLowerCase().includes('best'), 'the word "best" never appears (the designed-out MetaMask failure)');
    assert(!autoLine.includes('of 2 venues'), 'a single-venue pair carries the one-venue disclosure, not a comparison');
    const prefilled = await inputValue(driver, 'convert-amount');
    assertIncludes(prefilled, '2.9998', `the amount is prefilled to the net max (3 ICP − 2×${fmt8(ICP_FEE)}), got: ${prefilled}`);
    await assertEnabledCTA(driver, true, 'tap 2 is armed at the prefill (the founder\'s two-tap shape)');

    // The flow pins the money math at exactly 1 ICP: typing over the prefill re-quotes. The
    // card renders the PREFILL's figure until the fresh quote lands (the sheet is never
    // quote-less), so the deterministic signal is the figure ITSELF matching the oracle.
    await typeConvertAmount(driver, '1');

    const oracle = await relayQuote(relayBaseURL, ICP_LEDGER, VCHF_LEDGER, AMOUNT_IN);
    assertEq(oracle.zero_for_one, false, 'relay derives zero_for_one from the pool\'s own pair (ICP is token1)');
    assertEq(oracle.fee_millionths, 3000, 'the venue\'s OWN fee tier is echoed by the relay, not claimed by dpay');
    assertEq(oracle.venue_id, 'icpswap', 'the quote is ATTRIBUTED to its venue (registry venue_id echo)');
    const gross = BigInt(oracle.amount_out);
    const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // the core's exact floor math
    await driver.waitForFunction(
      (want) => (document.querySelector('[data-testid="convert-receive"]')?.textContent ?? '').includes(want),
      { timeoutMs: 15_000, label: 'the receive figure re-keyed to the typed amount', args: [`≈ ${fmtHero(gross - VCHF_FEE, 8, 'VCHF', { stable: true })}`] },
    );

    // --- The review card: the decision facts live in the open; the census folds behind Details --
    console.log('[140-convert-happy-path] asserting every §5 transparency line…');
    const receive = await driver.readText('convert-receive');
    // The hero reads at the asset's standard display precision (VCHF is currency-class: 2
    // decimals); the venue's VERBATIM figure is pinned in Details below.
    assertIncludes(receive, `≈ ${fmtHero(gross - VCHF_FEE, 8, 'VCHF', { stable: true })}`, 'the receive hero is the venue\'s own net estimate at standard display precision');
    const quoteSource = await driver.readText('convert-quote-source');
    assertIncludes(quoteSource, 'Quote from ICPSwap, fetched', 'rate is attributed + timestamped');
    assert(/\d{1,2}:\d{2}/.test(quoteSource), `quote carries a clock instant (${quoteSource})`);
    const minOutLine = await driver.readText('convert-min-out');
    assertIncludes(minOutLine, `${fmt8(minOut)} VCHF`, `minimum-you'll-receive is the core's floor at the default 1% (${fmt8(minOut)} VCHF)`);
    assertIncludes(minOutLine, '1% slippage', 'the default 1% slippage is disclosed on the card');
    // The slippage CHIP AXIS is retired (a disclosed default inside Details now).
    for (const bps of [50, 100, 300]) {
      assert(await driver.findByTestID(`convert-bps-${bps}`, { timeoutMs: 1_000 }).catch(() => null) == null,
        `slippage chip ${bps} is gone (a default, not a decision)`);
    }
    // The retired lines stay retired.
    assert(await driver.findByTestID('convert-dpay-fee', { timeoutMs: 1_000 }).catch(() => null) == null,
      'dpay-paid-nothing line is gone');
    assert(await driver.findByTestID('convert-net', { timeoutMs: 1_000 }).catch(() => null) == null,
      'net end-state line is gone: the receive figure IS the end state');
    assert(await driver.findByTestID('convert-impact', { timeoutMs: 1_000 }).catch(() => null) == null,
      'no price-impact line renders (the venue publishes none, V8)');

    // The census folds behind the ONE Details control (default CLOSED) — open and pin it.
    await driver.click('convert-details', { timeoutMs: 5_000 });
    // The hero's rounding is presentation only: the venue's own verbatim quote sits in
    // Details, attributed — the never-computed red line is untouched.
    assertIncludes(await driver.readText('convert-quote-verbatim'), `${fmt8(gross)} VCHF`,
      'Details carries the venue\'s verbatim quoted figure');
    const counterparty = await driver.readText('convert-counterparty');
    assertIncludes(counterparty, POOL, 'counterparty names the pool principal');
    assertIncludes(counterparty, 'ICPSwap', 'counterparty names ICPSwap');
    assertIncludes(counterparty, 'Your phone signs', 'counterparty: the phone signs, the pool pulls exactly the approved amount');
    const rateLine = await driver.readText('convert-rate');
    assertIncludes(rateLine, 'ICP', 'rate line names the input unit');
    assertIncludes(rateLine, 'VCHF', 'rate line names the output unit');
    assertIncludes(await driver.readText('convert-pool-fee'), '0.30%', 'pool fee tier is itemised (0.30%)');
    assertIncludes(await driver.readText('convert-in-fee'), `${fmt8(ICP_FEE)} ICP`, `input fee line is the catalog fee (${fmt8(ICP_FEE)} ICP)`);
    assertIncludes(await driver.readText('convert-out-fee'), `${fmt8(VCHF_FEE)} VCHF`, `output fee line is the catalog fee (${fmt8(VCHF_FEE)} VCHF)`);
    const refusal = await driver.readText('convert-refusal');
    assertIncludes(refusal, 'ICP', 'refusal outcome names the asset the user keeps');
    assertIncludes(refusal, 'approval expires', 'refusal outcome: the approval expires unused');
    assertIncludes(await driver.readText('convert-slippage'), '1%', 'the slippage default is disclosed inside Details');
    // The CTA names the amount.
    assertIncludes(await driver.readText('convert-cta'), 'Convert 1 ICP', 'the CTA names the amount ("Convert 1 ICP")');

    await driver.screenshot('140-convert-sheet');

    // --- TAP 2: re-quote at the gesture, then the Settlement Field runs the engine --------------
    console.log('[140-convert-happy-path] tap 2 → re-quote → approve → swap → settle…');
    // `gross` the sheet asserted is the review quote; the swap only signs when the confirm
    // re-quote comes back UNCHANGED (§5 red line). Sibling flows cannot touch this private
    // pool, so a moved-quote interrupt here would be real market movement — the loop re-reads
    // the pool's own quote and re-confirms (the moved note re-arms the same button).
    let executedGross = gross;
    let done = false;
    for (let round = 0; round < 5 && !done; round++) {
      await driver.click('btn-convert-confirm', { timeoutMs: 6_000 });
      // The Settlement Field: the full-bleed in-flight tracker with practical copy.
      done = await driver.waitForText('Converted', { timeoutMs: 60_000 });
      if (done) break;
      const moved = await driver.readText('convert-moved-note').catch(() => null);
      if (moved != null) {
        assertIncludes(moved, 'The rate moved', 'the moved note names both figures inline');
        assertIncludes(moved, 'Confirm again', 'the moved note re-arms the same button');
        executedGross = BigInt((await relayQuote(relayBaseURL, ICP_LEDGER, VCHF_LEDGER, AMOUNT_IN)).amount_out);
        console.log('[140-convert-happy-path] market moved → re-confirmed at the fresh quote');
        continue;
      }
      const state = await driver.readText('convert-state').catch(() => '(absent)');
      if (state === '(absent)') {
        const confirmErr = await driver.readText('convert-confirm-err').catch(() => '(absent)');
        throw new Error(`tap 2 produced no tracker in 60 s (round ${round}) — convert-state: ${state}; convert-confirm-err: ${confirmErr}`);
      }
      // else: an in-flight tracker (signing/swapping/settling) — keep waiting within the round.
    }
    assert(done, 'done floods the Settlement Field');
    await driver.screenshot('140-convert-done');
    const doneBody = await driver.readText('convert-done');
    assertIncludes(doneBody, 'VCHF', 'done names the asset received');
    assertIncludes(doneBody, `${fmt8(executedGross)} VCHF`, `done amount is the SEEN ledger row (pool credits full gross: ${fmt8(executedGross)} VCHF)`);
    assert(/Payout record/.test(doneBody), 'done carries the payout record line (out_tx)');

    // --- Exact settlement against the fake-IC books ----------------------------------------------
    console.log('[140-convert-happy-path] asserting exact settlement…');
    const icpAfter = await getBalance(relayBaseURL, account.publicHex, 8);
    const vchfAfter = await getBalance(relayBaseURL, account.publicHex, 7);
    assertEq(BigInt(icpAfter), BigInt(SEED) - AMOUNT_IN - ICP_FEE - ICP_FEE, 'ICP: −amount − approve fee − input fee');
    assertEq(BigInt(vchfAfter), executedGross, 'VCHF: +gross out (the pool credits the full output)');

    // --- Ledger row: the conversion is named for its venue, not its pool principal ----------------
    console.log('[140-convert-happy-path] asserting the Ledger row…');
    await openHistory(driver, { timeoutMs: 5_000 });
    await driver.waitForText('ICPSwap', { timeoutMs: 12_000 });
    const ledgerBody = await driver.bodyText();
    assertIncludes(ledgerBody, 'VCHF', 'ledger shows the VCHF conversion row');
    assertIncludes(ledgerBody, 'from ICPSwap', 'the payout row names the VENUE (a pool principal is not a counterparty)');
    // The receipt keeps the checkable ledger truth beneath the venue name.
    await driver.click('hist-row-0', { timeoutMs: 5_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    assertIncludes(await driver.readText('txn-receipt-account'), 'ICPSwap', 'the receipt names the venue as the party');
    assertIncludes(await driver.readText('txn-receipt-account-principal'), POOL, 'the pool principal survives as the receipt\'s checkable line');
    await driver.screenshot('140-convert-ledger');

    console.log(`[140-convert-happy-path] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

/** An input's VALUE (textContent is empty for <input> nodes). */
async function inputValue(driver, testID) {
  return driver.eval((id) => document.querySelector(`[data-testid="${id}"]`)?.value ?? '', testID);
}

/** Read the CTA's enabled state off the aria attribute (the alias Pressable carries it). */
async function assertEnabledCTA(driver, wantEnabled, why) {
  const el = await driver.findByTestID('btn-convert-confirm', { timeoutMs: 5_000 });
  const disabled = await el.evaluate((node) =>
    node.getAttribute('aria-disabled') === 'true' || node.hasAttribute('disabled'));
  assert(disabled === !wantEnabled, why);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('140-convert-happy-path RED:', e.stack || e.message || e);
  });
}
