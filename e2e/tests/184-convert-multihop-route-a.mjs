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
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency, openConvertFor, pickSwapTarget, openOtherVenues, typeConvertAmount, fmtHero} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai'; // venue icpswap-ckusdc's OWN pool
const MINTER = 'sv3dd-oaaaa-aaaar-qacoa-cai'; // the ckETH minter that governs all ckERC20s
const ROUTE_B_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp';
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
  name: 'convert-route-rows',
  journey: 'convert',
  covers: ['convert', 'multihop', 'route-b', 'cctp', 'icpswap', 'ckusdc', 'swap-screen', 'venue-area', 'no-external-address', 'destination-address', 'fee-census', 'registry-order'],
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

    // --- the venue area: the USD pair's executable rows, in kind order, Route A GONE -----------
    await openConvertFor(driver, 'icp');
    await pickSwapTarget(driver, 'USD');
    await typeConvertAmount(driver, '5');
    // Two venues serve the pair? No — four mechanisms: the direct pool + the CeFi service +
    // the hub + Route B. The sheet AUTO-PICKS the direct pool (highest net quoted output among
    // the live-quoted venue rows) and the other three wait behind the ONE Other-venues
    // expander, verbatim in kind/registry order.
    await driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
    await openOtherVenues(driver);
    for (const rowId of ['hub:icpswap:7:icpswap-vchf-ckusdc', 'multihop:icpswap-ckusdc:2:cctp', 'sideshift-usdc']) {
      assert(await driver.findByTestID(`convert-venue-${rowId}`, {timeoutMs: 4_000}) != null,
        `the USD pair offers its ${rowId} row behind the expander`);
    }
    assert(await driver.findByTestID('convert-venue-multihop:icpswap-ckusdc:2', {timeoutMs: 1_000}).catch(() => null) == null,
      'the external-address cash-out route is NOT offered — the swap screen converts between the user\'s own balances (the withdraw surface owns cash-out)');
    assertIncludes(await driver.readText('convert-venue-auto'), 'Executed via', 'the direct pool is the auto pick (disclosed mechanically)');
    assert(await driver.findByTestID('convert-headline', {timeoutMs: 4_000}) != null,
      'the review card stands at the pick (nothing is withheld — the pick is dpay\'s job now)');
    assert(await driver.findByTestID('convert-dest-address', {timeoutMs: 1_000}).catch(() => null) == null,
      'no destination address input before a route row is picked');

    // --- picking Route B swaps the surface: the crossing\'s signer-side address + the hop quote --
    await driver.click(ROUTE_B_ROW);
    await driver.type('convert-dest-address', DEST);
    await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
    assert(await driver.findByTestID('convert-dest-address-invalid', {timeoutMs: 1_000}).catch(() => null) == null,
      'a valid 0x destination address passes live validation');

    // The oracle BEFORE the confirm: the hop's own quote through the production route.
    const oracle = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP);
    assertEq(oracle.venue_id, 'icpswap-ckusdc', 'the hop quotes under the ckUSDC venue id');
    assertEq(oracle.zero_for_one, true, 'the pool\'s token0 is ICP → ICP in is zero_for_one true');
    const gross = BigInt(oracle.amount_out);
    assert(gross > 0n, 'the quoted ckUSDC output is non-zero');
    const net = gross - CKUSDC_FEE;
    const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // 1% slippage, the app's exact floor math

    // The route census: hop quote verbatim (headline net) + the crossing's 1% floor (route-min)
    // stay MAIN; the minter's live gas fee and the burn counterparty fold behind the ONE Details
    // control (10x-verbosity pass 2026-09-16) — open it before pinning them.
    assertIncludes(await driver.readText('convert-headline'), `≈ ${fmtHero(net, 6, 'USDC', { stable: true })}`, 'the headline states the hop\'s net ckUSDC output at standard display precision');
    assertIncludes(await driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the crossing minimum is the hop quote\'s 1% floor');
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('convert-quote-verbatim'), `${fmt(gross, 6)} USDC`, 'Details carries the hop venue\'s verbatim quoted figure');
    assertIncludes(await driver.readText('convert-gas-note'), `${fmt(GAS_WEI, 18)} ETH`, 'the gas census line states the minter\'s live figure');
    assertEq((await driver.readText('convert-minter-principal')).trim(), MINTER,
      'the burn counterparty principal is the ckETH minter');
    assertIncludes(await driver.readText('convert-counterparty'), 'ICPSwap', 'the swap counterparty is attributed to ICPSwap');
    // The funded wallet passes the gas preflight silently — the panel only renders on shortfall.
    assert(await driver.findByTestID('convert-gas-preflight', {timeoutMs: 1_000}).catch(() => null) == null,
      'a wallet holding ckETH for gas sees no preflight block');
    await driver.screenshot('184-convert-route-b-review');

    console.log(`[184-convert-route-rows] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);    console.log(`[184-convert-route-a] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
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
