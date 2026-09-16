// Flow 188 — the 2026-09-16 coverage expansion, VCHF ↔ ckUSDC pair (venue icpswap-vchf-ckusdc).
//
// Registry row icpswap-vchf-ckusdc (pool hx7nb-diaaa-aaaar-qbxsa-cai, MEASURED live 2026-09-16:
// token0 = VCHF, token1 = ckUSDC, fee 3000 — the CHF→USD direct pair) puts the first
// fiat-to-stablecoin DIRECT pair on the IC registry. This flow proves the pair end-to-end
// through the offline test-helpers relay's fake-IC (the fixture pool is auto-seeded from the
// catalog), with the same direction honesty as flow 183's header note:
//   * resolveConvertDirection is REGISTRY-FIRST: VCHF still resolves to ICP (the row-0 venue)
//     and ckUSDC still resolves to ICP — so neither asset's direct form drives THIS pool. The
//     app-reachable path through it is the VCHF → USDC(Ethereum) multihop route whose SWAP HOP
//     is this pool; the DIRECT pair itself is asserted through the production route as oracle
//     quotes in BOTH directions.
//   * the served registry: GET /api/v1/venues lists all ELEVEN real venues in registry order
//     (seven IC pools + two Jupiter + two SideShift) — the expansion is visible on the wire.
//   * VCHF → ckUSDC DIRECT quote: venue_id icpswap-vchf-ckusdc, zero_for_one TRUE (the pool's
//     token0 is VCHF), the venue's own 0.30% tier, a 6-decimal ckUSDC amount_out shape.
//   * ckUSDC → VCHF reverse quote: zero_for_one FALSE, an 8-decimal VCHF amount_out shape.
//   * UI: the VCHF direct form is untouched (row-0 pool principals, no fail-closed panel), the
//     new pool surfaces as the destination-picker's Route A row — and because the hop is THE
//     canonical USDC row, the full cross-rail composition rides the SAME venue (Route B +CCTP,
//     Route C +jupiter): a three-route picker, so the one-route honesty line stays quiet.
//     Picking Route A quotes the hop through THIS pool: the min-you'll-receive is the hop
//     quote's 1% floor. QUOTE-ONLY: nothing executes (the full multihop execution mechanics
//     are pinned by flow 184).
// Private relay (startRelay, the flow-183 pattern): deterministic catalog, isolated pools.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const VCHF_USDC_POOL = 'hx7nb-diaaa-aaaar-qbxsa-cai'; // venue icpswap-vchf-ckusdc's OWN pool
const VCHF_ICP_POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the row-0 venue's pool (the direct form's)
const VENUE = 'icpswap-vchf-ckusdc';
const ROUTE_ROW = 'convert-dest-route-multihop:icpswap-vchf-ckusdc:2';
const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // lowercase 0x+40hex — valid

const SEED_VCHF = 50000000000; // 500 VCHF (plain Number — the faucet body is JSON)
const AMOUNT_IN_VCHF = 1000000000n; // 10 VCHF (8 decimals)
const VCHF_FEE = 10000n; // 0.0001 VCHF — the ledger's transfer fee (catalog row)

export const meta = {
  id: '188',
  name: 'convert-vchf-ckusdc-pair',
  journey: 'convert',
  covers: ['convert', 'venues', 'icpswap', 'vchf', 'ckusdc', 'decimal-pairs', '8-decimal', '6-decimal', 'registry-order', 'multihop', 'route-a', 'destination-address', 'quote-only'],
  verifies: 'The 2026-09-16 VCHF ↔ ckUSDC ICPSwap pool is live: the served registry lists all eleven real venues in registry order, the DIRECT pair quotes both directions through the production route (VCHF in → zero_for_one true with a 6-decimal USDC out; ckUSDC in → zero_for_one false with an 8-decimal VCHF out), the app\'s VCHF direct form still resolves the row-0 VCHF ↔ ICP venue untouched, and the new pool surfaces as the VCHF → USDC(Ethereum) multihop route whose hop quotes through the SAME pool — the min-you\'ll-receive is the hop quote\'s 1% floor, and nothing executes.',
  timeoutMs: 90000,
};

/** The venue's own quote, read off the relay exactly as the app reads it (the oracle pattern of flow 183). */
async function relayQuote(relayBaseURL, pool, tokenIn, tokenOut, amountIn) {
  const res = await fetch(`${relayBaseURL}/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`);
  if (!res.ok) throw new Error(`relay oracle quote failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Raw ledger units → the compact formatter's string (given decimals, trailing zeros trimmed — flow 183's fmt). */
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
  console.log('[188-convert-vchf-ckusdc] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;

    // --- the served registry: the expansion is on the wire, in registry order -------------------
    const venuesRes = await fetch(`${r2.baseURL}/api/v1/venues`);
    assert(venuesRes.ok, `GET /api/v1/venues ok (status ${venuesRes.status})`);
    const served = (await venuesRes.json()).venues.map(v => v.venue_id);
    assertEq(served.join('|'), [
      'icpswap', 'icpswap-ckusdc', 'icpswap-cketh', 'icpswap-ckbtc', 'icpswap-ckbtc-cketh',
      'icpswap-vchf-ckusdc', 'icpswap-ckusdc-cketh', 'jupiter', 'jupiter-eurc', 'sideshift',
      'sideshift-usdc',
    ].join('|'), 'the private relay serves all eleven real venues in registry order');

    // --- the DIRECT pair: production-route oracle quotes, both directions -----------------------
    // VCHF in (the pool's token0 → zero_for_one TRUE): 8-decimal in, 6-decimal USDC out.
    const fwd = await relayQuote(r2.baseURL, VCHF_USDC_POOL, VCHF_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_VCHF);
    assertEq(fwd.venue_id, VENUE, 'the VCHF→ckUSDC quote is attributable to its own venue id');
    assertEq(fwd.zero_for_one, true, 'VCHF in on a pool whose token0 is VCHF → zero_for_one true');
    assertEq(fwd.fee_millionths, 3000, 'the pool echoes its own 0.30% fee tier');
    const fwdOut = BigInt(fwd.amount_out);
    assert(fwdOut > 0n, 'the VCHF→ckUSDC quote is non-zero');
    assert(/^(\d+)(\.\d{1,6})?$/.test(fmt(fwdOut, 6)), 'the forward quote renders as a 6-decimal ckUSDC amount');
    // ckUSDC in (reverse): 6-decimal in, 8-decimal VCHF out.
    const rev = await relayQuote(r2.baseURL, VCHF_USDC_POOL, CKUSDC_LEDGER, VCHF_LEDGER, 100000000n);
    assertEq(rev.venue_id, VENUE, 'the reverse ckUSDC→VCHF quote is attributable too');
    assertEq(rev.zero_for_one, false, 'ckUSDC in on a pool whose token0 is VCHF → zero_for_one false');
    assertEq(rev.fee_millionths, 3000, 'the reverse quote echoes the same tier');
    const revOut = BigInt(rev.amount_out);
    assert(revOut > 0n, 'the reverse ckUSDC→VCHF quote is non-zero');
    assert(/^(\d+)(\.\d{1,8})?$/.test(fmt(revOut, 8)), 'the reverse quote renders as an 8-decimal VCHF amount');

    // --- the app: the direct form is untouched, the new pool surfaces as the route --------------
    console.log('[188-convert-vchf-ckusdc] onboarding + funding VCHF on the private relay…');
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-convert-vchf-usdc');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_VCHF, {currency: 7});
    assert(fund.ok, `faucet VCHF credit ok (status ${fund.status})`);

    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.type('convert-amount', '10');
    // Registry-first resolution: VCHF's direct form STILL lands on the row-0 VCHF ↔ ICP venue
    // (the new row must not hijack it — pinned server-side by convert.test.ts, pinned HERE in
    // the running app through the pool principal the checklist quotes).
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    assert(await driver.findByTestID('convert-unavailable', {timeoutMs: 500}).catch(() => null) == null,
      'VCHF is venue-PAIRED (no fail-closed panel — the direct form renders)');
    assertEq((await driver.readText('convert-pool-principal')).trim(), VCHF_ICP_POOL,
      'the direct form still quotes through the row-0 VCHF ↔ ICP pool');
    // The new pool's app surface: the VCHF → USDC(Ethereum) route row beside the direct pair.
    await driver.findByTestID(ROUTE_ROW, {timeoutMs: 5_000});
    // The hop is THE canonical USDC row, so the full cross-rail composition rides it: Route A
    // (this pool's hop), Route B (+CCTP to Solana USDC) and Route C (+jupiter to wrapped SOL)
    // all walk out of the SAME new venue — a real list, so the one-route honesty line stays
    // QUIET on VCHF (it speaks only when the route list is the picker's whole story).
    await driver.findByTestID('convert-dest-route-multihop:icpswap-vchf-ckusdc:2:cctp', {timeoutMs: 2_000});
    await driver.findByTestID('convert-dest-route-multihop:icpswap-vchf-ckusdc:2:cctp:jupiter', {timeoutMs: 2_000});
    assert(await driver.findByTestID('convert-route-note', {timeoutMs: 1_000}).catch(() => null) == null,
      'the one-route note stays quiet — three routes share the picker (no cefi path on VCHF)');

    // Pick the route: the hop quotes through the SAME new pool; the destination minimum is the
    // hop quote's 1% floor in the destination's own units (USDC on Ethereum, 6 decimals).
    await driver.click(ROUTE_ROW);
    await driver.type('convert-dest-address', DEST);
    await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
    assert(await driver.findByTestID('convert-dest-address-invalid', {timeoutMs: 1_000}).catch(() => null) == null,
      'a valid 0x destination address passes live validation');
    const minOut = (fwdOut / 10000n) * 9900n + ((fwdOut % 10000n) * 9900n) / 10000n;
    assertIncludes(await driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`,
      'the destination minimum is the hop quote\'s 1% floor through the NEW pool');

    // QUOTE-ONLY: nothing executed — the ledger never moved and no done panel exists.
    assert(await driver.findByTestID('convert-done', {timeoutMs: 1_000}).catch(() => null) == null,
      'the route leg executes nothing (quote-only — flow 184 pins the execution mechanics)');
    const vchfAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 7));
    assertEq(vchfAfter, BigInt(SEED_VCHF), 'the VCHF ledger is untouched by the quote stage');
    await driver.screenshot('188-convert-vchf-ckusdc-route-quoted');

    console.log(`[188-convert-vchf-ckusdc] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[188-convert-vchf-ckusdc] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[188-convert-vchf-ckusdc] FAILED:', e);
    process.exit(1);
  });
}
