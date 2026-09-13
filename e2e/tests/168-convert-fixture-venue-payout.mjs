// Flow 168 — V5 execution: picking the fixture venue executes through ITS pool, end-to-end.
//
// Spec docs/specs/2026-09-08-multi-venue-readiness.md V5: selecting a venue executes through it
// — the record carries that venueId and the signed legs target that venue's OWN pool (Wave-1
// made execution pool-keyed; the relay tests prove pool-keyed payout in isolation — this flow
// proves the SCREEN path: pick → checklist under the pick → confirm → settle on pool B).
//
// Asserted against pool B's own oracle (GET /api/v1/swap_quote?pool=6st72…): venue_id
// 'icpswap-fixture-b', zero_for_one TRUE (pool B's token0 is ICP — the reversed-order pool),
// fee tier 1000, and the on-ledger payout is B's quoted output verbatim. Private relay
// (startRelay, the flow-164 pattern): the venue knob cannot reach any sibling flow.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const AMOUNT_IN = 100000000n; // 1 ICP
const ICP_FEE = 10000n;
const VCHF_FEE = 10000n;
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const FIXTURE_POOL = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // venue B's OWN pool
const FIXTURE_VENUE = 'icpswap-fixture-b';

export const meta = {
  id: '168',
  name: 'convert-fixture-venue-payout',
  journey: 'convert',
  covers: ['convert', 'venues', 'venue-chooser', 'pool-keyed-execution', 'venue-attribution', 'fixture-venue-b'],
  verifies: 'Picking the served fixture venue B in the chooser executes through pool B end-to-end: the checklist quotes B (its reversed token order → zero_for_one true, its own 0.10% tier), confirm settles on pool B, and the output ledger pays B\'s quoted amount verbatim.',
  timeoutMs: 120000,
};

/** The venue's own quote, read off the relay exactly as the app reads it (the oracle pattern of flow 140). */
async function relayQuote(relayBaseURL, pool, tokenIn, tokenOut, amountIn) {
  const res = await fetch(`${relayBaseURL}/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`);
  if (!res.ok) throw new Error(`relay oracle quote failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Raw e8s → the compact formatter's string (8 decimals, trailing zeros trimmed — 2026-09-13). */
function fmt8(raw) {
  const n = BigInt(raw);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const frac = (abs % 10n ** 8n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${abs / 10n ** 8n}${frac ? '.' + frac : ''}`;
}

export async function run() {
  const start = Date.now();
  console.log('[168-convert-fixture] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[168-convert-fixture] onboarding + funding 3 ICP on the private relay…');
    await onboardWallet(driver, 'e2e-convert-fixture');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED, {currency: 8});
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true}),
    });
    assert(arm.ok, `venue knob armed (status ${arm.status})`);

    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.type('convert-amount', '1');
    await driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000});

    // The oracle BEFORE the pick: pool B's own facts (reversed token order → ICP is its token0).
    const oracle = await relayQuote(r2.baseURL, FIXTURE_POOL, ICP_LEDGER, VCHF_LEDGER, AMOUNT_IN);
    assertEq(oracle.venue_id, FIXTURE_VENUE, 'pool B quotes under its own venue id');
    assertEq(oracle.zero_for_one, true, 'pool B\'s token0 is ICP (reversed order) → zero_for_one true');
    assertEq(oracle.fee_millionths, 1000, 'pool B echoes its own 0.10% fee tier');
    const gross = BigInt(oracle.amount_out);
    const net = gross - VCHF_FEE;
    const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // 1% slippage, the app's exact floor math

    // Pick venue B → the decision surfaces appear quoting B, attributed to B, on B's pool.
    console.log('[168-convert-fixture] picking the fixture venue…');
    await driver.click(`convert-venue-${FIXTURE_VENUE}`, {timeoutMs: 6_000});
    await driver.findByTestID('convert-headline', {timeoutMs: 10_000});
    assert((await driver.findByTestID('convert-venue-none', {timeoutMs: 1_000}).catch(() => null)) == null,
      'the none-selected line clears under the pick');
    assertEq((await driver.readText('convert-pool-principal')).trim(), FIXTURE_POOL,
      'the counterparty principal is pool B\'s own canister');
    const counterparty = await driver.readText('convert-counterparty');
    assertIncludes(counterparty, 'ICPSwap (offline fixture)', 'the counterparty is attributed to venue B');
    assertIncludes(await driver.readText('convert-headline'), `${fmt8(net)} VCHF`, 'the headline states B\'s net output');
    assertIncludes(await driver.readText('convert-min-out'), `${fmt8(minOut)} VCHF`, 'the minimum follows B\'s quote');
    assertIncludes(await driver.readText('convert-pool-fee'), '0.10%', 'the fee line states B\'s own 0.10% tier');

    // Confirm (a quote-changed interrupt would demand a re-confirm — retry a few rounds).
    for (let round = 0; round < 5; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) break;
      console.log(`[168-convert-fixture] quote moved (round ${round + 1}) — re-reviewing and confirming again`);
    }
    await driver.waitForText('Converted', {timeoutMs: 60_000});
    // Flow-140 semantics: the done panel states the SETTLED row (the quoted output the pool paid,
    // verbatim — gross; the net figure lives in the headline above).
    const done = await driver.readText('convert-done');
    assertIncludes(done, `${fmt8(gross)} VCHF`, 'the done panel states B\'s quoted payout');
    assertIncludes(done, 'Payout record', 'the done panel carries the payout record');

    // Settlement on the private relay's own ledgers: pool B paid its quoted output VERBATIM.
    const icpAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    const vchfAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 7));
    assertEq(icpAfter, BigInt(SEED) - AMOUNT_IN - 2n * ICP_FEE, 'input ledger: amount + two ICP fees');
    assertEq(vchfAfter, gross, 'output ledger: pool B\'s quoted amount, verbatim');

    await driver.screenshot('168-convert-fixture-payout');
    console.log(`[168-convert-fixture] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[168-convert-fixture] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[168-convert-fixture] FAILED:', e);
    process.exit(1);
  });
}
