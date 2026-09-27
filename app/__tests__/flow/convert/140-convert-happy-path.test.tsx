/**
 * Flow 140 convert-happy-path — the jest twin of `e2e/tests/140-convert-happy-path.mjs` (M1
 * reference port for the HARDEST class: the convert engine, its seams, and the fake-IC pool).
 *
 * The founder's two-tap convert through the REAL app against the test-helpers relay's fake-IC
 * pool: faucet 3 ICP → Accounts ▸ ICP ▸ Convert opens the pre-computed intent sheet (amount
 * prefilled to the net max, the single venue auto-picked and disclosed mechanically) → type `1`
 * → the card re-quotes; the flow-side relay oracle (swap_quote) pins the money math → tap 2 →
 * the Settlement Field runs the on-device-signed approve+swap → settle is EXACT against the
 * fake-IC books (ICP −amount−2 fees, VCHF +gross) and the Ledger names the venue.
 *
 * TRIMMED vs the e2e flow (M2 batch C owns full parity): the §0.6 payment-review red-line leg
 * (it needs the URL deep-link surface, proven separately by the location-stub port) and the
 * moved-quote retry ladder (jest's one-relay-per-run here has no sibling convert flows mutating
 * the pool). Everything else — sheet, oracle math, engine, settlement, ledger row — is the full
 * flow.
 */
import {describe, it, expect} from '@jest/globals';
import {
  assertIncludes, faucetAccount, fmtHero, getBalance, onboardWallet, openConvertFor,
  openBalances, typeConvertAmount, accountOf,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';

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
    expect(autoLine).not.toContain('of 2 venues');
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
