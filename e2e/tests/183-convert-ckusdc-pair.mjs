// Flow 183 — the pair-scoped ICPSwap venues registered 2026-09-15 (ICP↔ckUSDC, ICP↔ckETH).
//
// Registry rows icpswap-ckusdc (pool mohjv-bqaaa-aaaag-qjyia-cai) and icpswap-cketh (pool
// angxa-baaaa-aaaag-qcvnq-cai) each put ONE new pair on the Convert surface. This flow proves
// the onboarding end-to-end through the offline test-helpers relay's fake-IC (the fixture pools
// are auto-seeded from the catalog):
//   * ckUSDC→ICP EXECUTION through the ckUSDC pool: the pair is discoverable from the ckUSDC
//     asset, the venue row is attributed "ICPSwap", the quote fetches, confirm settles through
//     the pool, and the ICP ledger pays the quoted amount verbatim (input-side ckUSDC math at
//     6 decimals: amount + two ckUSDC fees). NOTE the direction: in the app each asset converts
//     into its pair's OTHER leg (resolveConvertDirection), and ICP itself still resolves to
//     VCHF first — so the app-reachable funded direction through this pool is ckUSDC→ICP; the
//     reverse ICP→ckUSDC leg is asserted as a QUOTE through the same production route below.
//   * ICP→ckUSDC QUOTE (the 6-decimal side): the production swap_quote route in the pool's
//     forward direction — 6-decimal amount_out shape, zero_for_one true (the pool's token0 is
//     ICP), the venue's own 0.30% tier.
//   * ICP↔ckETH QUOTE-ONLY (the 18-decimal side): from the ckETH asset the Convert form offers
//     the pair (checklist on the angxa pool, attributed ICPSwap) and the ICP→ckETH quote
//     renders an 18-decimal amount_out — no execution on this leg.
// Private relay (startRelay, the flow-168 pattern): execution mutates pool state.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency, openConvertFor, pickSwapTarget, openOtherVenues, typeConvertAmount,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKETH_LEDGER = 'ss2fx-dyaaa-aaaar-qacoq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai'; // venue icpswap-ckusdc's OWN pool
const CKETH_POOL = 'angxa-baaaa-aaaag-qcvnq-cai'; // venue icpswap-cketh's OWN pool
const VENUE_USDC = 'icpswap-ckusdc';
const VENUE_ETH = 'icpswap-cketh';

const SEED_USDC = 1000000000; // 1000 ckUSDC (plain Number — the faucet body is JSON)
const AMOUNT_IN_USDC = 100000000n; // 100 ckUSDC (6 decimals)
const CKUSDC_FEE = 10000n; // 0.01 ckUSDC — the ledger's transfer fee (catalog row)
const ICP_FEE = 10000n; // 0.0001 ICP
const AMOUNT_IN_ICP_FWD = 100000000n; // 1 ICP for the forward ICP→ckUSDC/ckETH oracle quotes
const SEED_ETH = 4000000000000000; // 0.004 ckETH (18 decimals; 2^53-safe as a JSON Number)
const AMOUNT_IN_ETH = 2000000000000000n; // 0.002 ckETH

export const meta = {
  id: '183',
  name: 'convert-ckusdc-cketh-pairs',
  journey: 'convert',
  covers: ['convert', 'venues', 'icpswap', 'ckusdc', 'cketh', 'decimal-pairs', '6-decimal', '18-decimal', 'pool-keyed-execution', 'venue-attribution'],
  verifies: 'The pair-scoped ICPSwap venues are live on Convert: ckUSDC→ICP executes through the ckUSDC pool end-to-end (ICP payout verbatim, 6-decimal ckUSDC input math), the reverse ICP→ckUSDC quote renders a 6-decimal amount_out, and the ckETH pair is offered quote-only with an 18-decimal quote.',
  timeoutMs: 120000,
};

/** The venue's own quote, read off the relay exactly as the app reads it (the oracle pattern of flow 168). */
async function relayQuote(relayBaseURL, pool, tokenIn, tokenOut, amountIn) {
  const res = await fetch(`${relayBaseURL}/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`);
  if (!res.ok) throw new Error(`relay oracle quote failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Raw ledger units → the compact formatter's string (given decimals, trailing zeros trimmed — flow 168's fmt8, generalized). */
function fmt(raw, decimals) {
  const n = BigInt(raw);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const d = BigInt(decimals);
  const frac = (abs % 10n ** d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${abs / 10n ** d}${frac ? '.' + frac : ''}`;
}

export async function run() {
  const start = Date.now();
  console.log('[183-convert-pairs] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[183-convert-pairs] onboarding + funding ckUSDC on the private relay…');
    await onboardWallet(driver, 'e2e-convert-ckusdc');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_USDC, {currency: 2});
    assert(fund.ok, `faucet ckUSDC credit ok (status ${fund.status})`);

    // --- ckUSDC→ICP: discover the pair on the Convert surface -----------------------------------
    await openConvertFor(driver, 'ckusdc');
    // The standing pair is stable-first CHF (the 2026-09-25 founder rule); this flow's facts
    // live on the ckUSDC ↔ ICP pair, so it is picked explicitly.
    await pickSwapTarget(driver, 'ICP');
    await typeConvertAmount(driver, '100');
    // ONE VENUE on this pair → the sheet AUTO-PICKS the direct pool and discloses it
    // mechanically (the single-venue form — no comparison that never happened); the composed
    // via-VCHF hub waits behind the ONE Other-venues expander as an explicit opt-in row.
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    const autoLine = await driver.readText('convert-venue-auto');
    assertIncludes(autoLine, 'Executed via', 'the pick line names its executor (the mechanical disclosure)');
    assert(!autoLine.includes('of 2 venues'), 'a single-venue pair carries the one-venue disclosure, not a comparison');
    assert(await driver.findByTestID('convert-venue-none', {timeoutMs: 1_000}).catch(() => null) == null,
      'the single venue IS the standing pick — nothing is withheld for a choice that does not exist');
    await openOtherVenues(driver);
    const hubRow = await driver.eval(() =>
      [...document.querySelectorAll('[data-testid]')]
        .map((el) => el.getAttribute('data-testid'))
        .find((t) => t != null && t.startsWith('convert-venue-hub:')) ?? null);
    assert(hubRow != null, 'the composed via-VCHF hub waits in the expander as an explicit opt-in row');
    assert(await driver.findByTestID('convert-unavailable', {timeoutMs: 500}).catch(() => null) == null,
      'the ckUSDC pair is venue-PAIRED now (no fail-closed panel — it was venue-less before 2026-09-15)');

    // The oracle BEFORE the confirm: the pool's own facts (its token0 is ICP → ckUSDC in is
    // zero_for_one FALSE) — read off the route exactly as the app reads it.
    const oracle = await relayQuote(r2.baseURL, CKUSDC_POOL, CKUSDC_LEDGER, ICP_LEDGER, AMOUNT_IN_USDC);
    assertEq(oracle.venue_id, VENUE_USDC, 'the ckUSDC pool quotes under its own venue id');
    assertEq(oracle.zero_for_one, false, 'the pool\'s token0 is ICP → ckUSDC in is zero_for_one false');
    assertEq(oracle.fee_millionths, 3000, 'the pool echoes its own 0.30% fee tier');
    const gross0 = BigInt(oracle.amount_out);
    assert(gross0 > 0n, 'the quoted ICP output is non-zero');
    let gross = gross0;
    let net = gross - ICP_FEE;
    let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // 1% slippage, the app's exact floor math

    // The counterparty census folds behind the ONE Details control (10x-verbosity pass
    // 2026-09-16): open it before pinning the principal + tier; headline + minimum stay main.
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertEq((await driver.readText('convert-pool-principal')).trim(), CKUSDC_POOL,
      'the counterparty principal is the ckUSDC pool\'s own canister');
    assertIncludes(await driver.readText('convert-counterparty'), 'ICPSwap', 'the counterparty is attributed to ICPSwap');
    assertIncludes(await driver.readText('convert-headline'), `${fmt(net, 8)} ICP`, 'the headline states the net ICP output');
    assertIncludes(await driver.readText('convert-min-out'), `${fmt(minOut, 8)} ICP`, 'the minimum follows the pool\'s quote');
    assertIncludes(await driver.readText('convert-pool-fee'), '0.30%', 'the fee line states the pool\'s 0.30% tier');

    // The REVERSE leg as a quote (the app-reachable funded direction is ckUSDC→ICP; ICP itself
    // resolves to VCHF first — see the header note): the production route, forward direction.
    const fwd = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP_FWD);
    assertEq(fwd.venue_id, VENUE_USDC, 'the forward ICP→ckUSDC quote is attributable to the venue');
    assertEq(fwd.zero_for_one, true, 'ICP in on a pool whose token0 is ICP → zero_for_one true');
    assertEq(fwd.fee_millionths, 3000, 'the forward quote echoes the same 0.30% tier');
    const fwdOut = BigInt(fwd.amount_out);
    assert(fwdOut > 0n, 'the forward ICP→ckUSDC quote is non-zero');
    assert(/^(\d+)(\.\d{1,6})?$/.test(fmt(fwdOut, 6)), 'the forward quote renders as a 6-decimal ckUSDC amount');

    // Confirm (a quote-changed interrupt would demand a re-confirm — retry a few rounds).
    for (let round = 0; round < 5; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) break;
      console.log(`[183-convert-pairs] quote moved (round ${round + 1}) — re-reviewing and confirming again`);
      // Re-derive the oracle after the move so the settled figures stay the pool's own.
      const re = await relayQuote(r2.baseURL, CKUSDC_POOL, CKUSDC_LEDGER, ICP_LEDGER, AMOUNT_IN_USDC);
      gross = BigInt(re.amount_out);
      net = gross - ICP_FEE;
      minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
    }
    await driver.waitForText('Converted', {timeoutMs: 60_000});
    // Flow-140 semantics: the done panel states the SETTLED row (the quoted output the pool paid,
    // verbatim — gross; the net figure lives in the headline above).
    const done = await driver.readText('convert-done');
    assertIncludes(done, `${fmt(gross, 8)} ICP`, 'the done panel states the pool\'s quoted ICP payout');
    assertIncludes(done, 'Payout record', 'the done panel carries the payout record');

    // Settlement on the private relay's own ledgers: the ckUSDC input side is 6-decimal math
    // (amount + two ledger fees), the ICP side is the pool's quoted output VERBATIM.
    const usdcAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 2));
    const icpAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    assertEq(usdcAfter, BigInt(SEED_USDC) - AMOUNT_IN_USDC - 2n * CKUSDC_FEE, 'ckUSDC ledger: amount + two 6-decimal fees');
    assertEq(icpAfter, gross, 'ICP ledger: the pool\'s quoted amount, verbatim');
    await driver.screenshot('183-convert-ckusdc-executed');

    // --- ckETH pair: offered quote-only (the 18-decimal side) -----------------------------------
    console.log('[183-convert-pairs] ckETH pair offered (quote-only)…');
    const fundEth = await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
    assert(fundEth.ok, `faucet ckETH credit ok (status ${fundEth.status})`);
    await openConvertFor(driver, 'cketh');
    await typeConvertAmount(driver, '0.002');
    // Single venue on the ckETH pair too → the direct pool stands, checklist surfaces directly.
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    assert(await driver.findByTestID('convert-venue-none', {timeoutMs: 1_000}).catch(() => null) == null,
      'single venue on the ckETH pair → the direct pool is the standing pick (nothing withheld)');
    await driver.click('convert-details', {timeoutMs: 5_000}); // the folded census (verbosity pass 2026-09-16)
    assertEq((await driver.readText('convert-pool-principal')).trim(), CKETH_POOL,
      'the ckETH counterparty principal is the ckETH pool\'s own canister');
    assertIncludes(await driver.readText('convert-counterparty'), 'ICPSwap', 'the ckETH counterparty is attributed to ICPSwap');
    // The ckETH→ICP oracle pins the checklist's own numbers (18-decimal in, 8-decimal out).
    const oracleEth = await relayQuote(r2.baseURL, CKETH_POOL, CKETH_LEDGER, ICP_LEDGER, AMOUNT_IN_ETH);
    assertEq(oracleEth.venue_id, VENUE_ETH, 'the ckETH→ICP quote is attributable to the venue');
    assertEq(oracleEth.zero_for_one, false, 'the ckETH pool\'s token0 is ICP → ckETH in is zero_for_one false');
    const grossEth = BigInt(oracleEth.amount_out);
    assert(grossEth > 0n, 'the quoted ckETH→ICP output is non-zero');
    assertIncludes(await driver.readText('convert-headline'), `${fmt(grossEth - ICP_FEE, 8)} ICP`,
      'the ckETH checklist headline states the net ICP output');
    const minOutEth = (grossEth / 10000n) * 9900n + ((grossEth % 10000n) * 9900n) / 10000n;
    // The forward ICP→ckETH quote through the production route: an 18-decimal amount_out.
    const fwdEth = await relayQuote(r2.baseURL, CKETH_POOL, ICP_LEDGER, CKETH_LEDGER, AMOUNT_IN_ICP_FWD);
    assertEq(fwdEth.venue_id, VENUE_ETH, 'the ICP→ckETH quote is attributable to the venue');
    assertEq(fwdEth.zero_for_one, true, 'ICP in on a pool whose token0 is ICP → zero_for_one true');
    assertEq(fwdEth.fee_millionths, 3000, 'the ckETH pool echoes the same 0.30% tier');
    const fwdEthOut = BigInt(fwdEth.amount_out);
    assert(fwdEthOut > 0n, 'the forward ICP→ckETH quote is non-zero');
    assert(/^(\d+)(\.\d{1,18})?$/.test(fmt(fwdEthOut, 18)), 'the forward quote renders as an 18-decimal ckETH amount');
    // QUOTE-ONLY: nothing executes on this leg — the checklist is still the screen.
    assert(await driver.findByTestID('convert-done', {timeoutMs: 1_000}).catch(() => null) == null,
      'the ckETH leg executes nothing (quote-only)');
    assertIncludes(await driver.readText('convert-min-out'), `${fmt(minOutEth, 8)} ICP`, 'the ckETH minimum follows the pool\'s quote (form, not done panel)');
    await driver.screenshot('183-convert-cketh-quote');

    console.log(`[183-convert-pairs] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[183-convert-pairs] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[183-convert-pairs] FAILED:', e);
    process.exit(1);
  });
}
