// Flow 184 — multi-hop Route A (2026-09-14 spec): ICP → USDC(Ethereum) as ONE user intent.
//
// A single confirm signs and executes FIVE IC legs on the user's device — approve ICP→pool,
// the pool's depositFromAndSwap, approve ckUSDC→minter, approve ckETH→minter for gas, and the
// minter's withdraw_erc20 to the user's own Ethereum address — through the offline
// test-helpers relay's fake-IC (which simulates withdraw_erc20: amount + gas burn, minter #ok
// block index). This flow proves:
//   * the composed destination is an explicit opt-in (the direct pair stays the default row),
//   * the quote is the SWAP HOP's own venue quote rendered verbatim, with the destination's
//     figure stated as the min-you'll-receive line and the minter's live gas fee as its own
//     census line,
//   * all five legs execute with per-leg status, and the done panel names the net amount AT
//     THE DESTINATION plus the address and the payout record,
//   * ledger truth: ICP = amount + two fees; ckUSDC = gross − burn(minOut) − approve fee (the
//     surplus above the floor stays in-wallet, by design); ckETH = the 78e12-wei gas burn +
//     its approve fee.
// The mid-route dead-end (burn-side refusal → failed_leg, hop asset in-wallet) is pinned by
// the jest suite (app/__tests__/convertMultihop.test.ts) — the fake-IC gateway has no
// withdraw-refusal knob and none was added for it.
// Private relay (startRelay, the flow-183 pattern): execution mutates pool + ledger state.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai'; // venue icpswap-ckusdc's OWN pool
const MINTER = 'sv3dd-oaaaa-aaaar-qacoa-cai'; // the ckETH minter that governs all ckERC20s
const ROUTE_ROW = 'convert-dest-route-multihop:icpswap-ckusdc:2';
const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase(); // checksummed form's lowercase twin — valid 0x+40hex

const SEED_ICP = 2000000000; // 20 ICP (plain Number — the faucet body is JSON)
const SEED_ETH = 400000000000000; // 0.0004 ckETH (18 decimals; 2^53-safe as a JSON Number)
const AMOUNT_IN_ICP = 500000000n; // 5 ICP
const ICP_FEE = 10000n; // 0.0001 ICP
const CKUSDC_FEE = 10000n; // 0.01 ckUSDC
const CKETH_FEE = 2000000000000n; // 0.000002 ckETH
const GAS_WEI = 78000000000000n; // the fake-IC minter's own eip-1559 figure — quoted AND charged

export const meta = {
  id: '184',
  name: 'convert-multihop-route-a',
  journey: 'convert',
  covers: ['convert', 'multihop', 'route-a', 'icpswap', 'ckusdc', 'withdraw_erc20', 'cketh-gas', 'burn', 'destination-address', 'fee-census', 'per-leg-status'],
  verifies: 'Route A converts ICP to USDC on Ethereum as one intent: the composed destination is an opt-in row beside the direct pair, the swap-hop quote renders verbatim with the min-you\'ll-receive and the minter\'s live gas fee as census lines, all five IC legs execute with per-leg status, and the done panel names the net USDC at the destination address plus the payout record.',
  timeoutMs: 120000,
};

/** The venue's own quote, read off the relay exactly as the app reads it (the oracle pattern of flow 183). */
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

export async function run() {
  const start = Date.now();
  console.log('[184-convert-route-a] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[184-convert-route-a] onboarding + funding ICP and ckETH-for-gas on the private relay…');
    await onboardWallet(driver, 'e2e-convert-route-a');
    const account = await accountOf(driver);
    const fundIcp = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
    assert(fundIcp.ok, `faucet ICP credit ok (status ${fundIcp.status})`);
    const fundEth = await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
    assert(fundEth.ok, `faucet ckETH credit ok (status ${fundEth.status})`);

    // --- the destination picker: direct pair is the default, the route is an explicit pick ------
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.type('convert-amount', '5');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    // Direct (ICP→VCHF) is ONE venue → no chooser; the ROUTE row sits beside it, unpicked.
    assert(await driver.findByTestID('convert-venues', {timeoutMs: 1_000}).catch(() => null) == null,
      'single venue on the direct pair → no chooser');
    assert(await driver.findByTestID(ROUTE_ROW, {timeoutMs: 2_000}) != null,
      'the Route A row is offered beside the direct pair');
    assert(await driver.findByTestID('convert-dest-address', {timeoutMs: 1_000}).catch(() => null) == null,
      'no destination address input before the route is picked');
    assertIncludes(await driver.readText('convert-route-note'), 'One route', 'the one-route honesty line says so');

    await driver.click(ROUTE_ROW);
    await driver.type('convert-dest-address', DEST);
    await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
    assert(await driver.findByTestID('convert-dest-address-invalid', {timeoutMs: 1_000}).catch(() => null) == null,
      'a valid 0x destination address passes live validation');

    // The oracle BEFORE the confirm: the hop's own quote through the production route.
    const oracle = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP);
    assertEq(oracle.venue_id, 'icpswap-ckusdc', 'the hop quotes under the ckUSDC venue id');
    assertEq(oracle.zero_for_one, true, 'the pool\'s token0 is ICP → ICP in is zero_for_one true');
    let gross = BigInt(oracle.amount_out);
    assert(gross > 0n, 'the quoted ckUSDC output is non-zero');
    const net = gross - CKUSDC_FEE;
    let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // 1% slippage, the app's exact floor math

    // The route census: hop quote verbatim (headline net), the destination's figure as the
    // min-you'll-receive (in DESTINATION units — USDC, not the hop's ckUSDC-in-wallet framing),
    // the minter's live gas fee as its own line, and the burn counterparty by principal.
    assertIncludes(await driver.readText('convert-headline'), `${fmt(net, 6)} USDC`, 'the headline states the hop\'s net ckUSDC output');
    assertIncludes(await driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the destination minimum is the hop quote\'s 1% floor');
    assertIncludes(await driver.readText('convert-gas-note'), `${fmt(GAS_WEI, 18)} ETH`, 'the gas census line states the minter\'s live figure');
    assertEq((await driver.readText('convert-minter-principal')).trim(), MINTER,
      'the burn counterparty principal is the ckETH minter');
    assertIncludes(await driver.readText('convert-counterparty'), 'ICPSwap', 'the swap counterparty is attributed to ICPSwap');
    // The funded wallet passes the gas preflight silently — the panel only renders on shortfall.
    assert(await driver.findByTestID('convert-gas-preflight', {timeoutMs: 1_000}).catch(() => null) == null,
      'a wallet holding ckETH for gas sees no preflight block');

    // Confirm (a quote-changed interrupt would demand a re-confirm — retry a few rounds).
    for (let round = 0; round < 5; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) break;
      console.log(`[184-convert-route-a] quote moved (round ${round + 1}) — re-reviewing and confirming again`);
      const re = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP);
      gross = BigInt(re.amount_out);
      minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
    }

    // --- the run: all five legs execute, per-leg status visible ---------------------------------
    await driver.waitForText('Cash-out under way', {timeoutMs: 60_000});
    assert(await driver.findByTestID('convert-route-legs', {timeoutMs: 2_000}) != null, 'the leg list renders');
    for (let i = 0; i < 5; i++) {
      const state = await driver.readText(`convert-leg-${i}-state`);
      assertIncludes(state, 'Confirmed', `leg ${i} reads Confirmed after the run`);
    }
    const done = await driver.readText('convert-done');
    assertIncludes(done, `${fmt(minOut, 6)} USDC`, 'the done panel names the USDC amount at the destination');
    assertIncludes(done, DEST, 'the done panel names the destination address');
    assertIncludes(done, 'on its way', 'the done copy says on-its-way, never received (no EVM eyes)');
    assertIncludes(done, 'Payout record', 'the done panel carries the minter\'s payout record');

    // --- ledger truth: every leg's fee is where the census said it would be ---------------------
    const icpAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    const usdcAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 2));
    const ethAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 6));
    assertEq(icpAfter, BigInt(SEED_ICP) - AMOUNT_IN_ICP - 2n * ICP_FEE, 'ICP ledger: amount + two fees (approve + swap input)');
    assertEq(usdcAfter, gross - minOut - CKUSDC_FEE, 'ckUSDC ledger: gross − burned(minOut) − approve fee (surplus stays in-wallet)');
    assertEq(ethAfter, BigInt(SEED_ETH) - GAS_WEI - CKETH_FEE, 'ckETH ledger: the minter\'s gas burn + its approve fee');
    await driver.screenshot('184-convert-route-a-executed');

    console.log(`[184-convert-route-a] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[184-convert-route-a] standalone run complete');
    process.exit(0);
  }, err => {
    console.error('[184-convert-route-a] FAILED:', err);
    process.exit(1);
  });
}
