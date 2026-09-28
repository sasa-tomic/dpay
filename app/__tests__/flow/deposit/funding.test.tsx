/**
 * Flows 162 + 163 — the jest twins of `e2e/tests/162-funding-routes.mjs` and
 * `163-funding-mechanism.mjs` (the "I don't have any yet" funding card).
 *
 * 162: the VCHF deposit surface answers the dead end honestly — no provider sells VCHF, so the
 * route is buy ICP and convert; every provider row carries its OWN published figure with the
 * "up to" qualifier intact; the attribution is dated and says "not prices"; the screen states dpay
 * recommends none and is paid by none; native ICP is a DIRECT buy; and another asset's address is
 * ONE tap away with the address sub-mode kept. 163: the funding instruction matches the deposit
 * that actually runs — ckUSDC reaches the wallet-signed ckERC20 sheet whose card says there is no
 * address and names ETH for fees (never "send it to the address"); ckBTC says buy BTC on Bitcoin
 * and DOES send to the address shown; the Solana rail gets the same address shape with no catalog
 * descriptor behind it.
 *
 * LOAD-ORDER CONTRACT: the RPC override is set before the harness require (see ../pay/solrpc).
 */
import {beforeEach, describe, it, expect} from '@jest/globals';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from '../pay/solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();
// The zero-balance stub answers (accounts exist, balances zero) — the exact answers the e2e twins
// install. Re-armed per test: the lane helper's lifecycle beforeEach wipes the SOL seams, and a
// balance-poll tick with the URL override 'stub' but no stub object would fetch('stub') and trip
// the harness's fail-closed request rule. Registered AFTER the require of './h' (which installs
// the lifecycle), so this beforeEach runs after the wipe and the stub is live from the first tick.
const ZERO_BALANCE_STUB = baseSolStub({
  getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 0, token: {amount: '0', decimals: 6}}),
  getBalance: () => ({value: 0}),
});
beforeEach(() => {
  G.__DPAY_TEST_SOLANA_RPC_STUB = ZERO_BALANCE_STUB;
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const h = require('./h') as typeof import('./h');
const {
  assertIncludes, onboardWallet, openBalances, openReceiveAddress, readStable, selectCurrency,
  waitForWallet,
} = h;

describe('flow 162 — funding routes: honest instructions, attributed figures, one-tap asset switch', () => {
  it('VCHF names buy-ICP-then-convert; provider ceilings keep their qualifiers; ICP is a direct buy', async () => {
    const m = await onboardWallet('jest-funding');

    // ---- (a)+(b) VCHF: the exact surface the founder called a dead end ------------------------
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await openReceiveAddress(m);
    await readStable(m, 'deposit-address');
    await readStable(m, 'funding-routes');
    const vchfBody = m.driver.bodyText();

    // The route that actually works: nobody sells VCHF, so the card route to francs is a
    // user-signed convert from a purchased IC asset.
    assertIncludes(vchfBody, 'No provider sells', 'VCHF must say plainly that nobody sells it directly');
    assertIncludes(vchfBody, 'Convert', 'VCHF must name the convert leg — it is the only card route to francs');

    // ---- (c) providers, with their own figures and the qualifier intact ----------------------
    for (const key of ['coinbase', 'moonpay', 'ramp', 'transak']) {
      expect(m.driver.isPresent(`funding-provider-${key}`)).toBe(true);
    }
    assertIncludes(vchfBody, 'up to 4.5%', "MoonPay's card rate must keep its 'up to' qualifier — it is a cap, not a price");
    assertIncludes(vchfBody, 'card 2.5%', "Coinbase's card rate is published as a flat figure and reads as one");
    // F2: Ramp's 3.9% ceiling is USD/EUR/GBP only — CHF pays the other-currencies ceiling. Both
    // rows stay visible, each with its own qualifier.
    assertIncludes(vchfBody, 'up to 3.9%', "Ramp's USD/EUR/GBP card ceiling must stay visible with its qualifier");
    assertIncludes(vchfBody, 'up to 5.45%', "Ramp's other-currencies card ceiling must be its own visible row");
    assertIncludes(vchfBody, 'incl. CHF', 'the other-currencies row must name CHF so a CHF user can find their number');
    assertIncludes(vchfBody, 'non-USD purchases', "MoonPay's non-USD minimum-fee uplift must be stated — CHF buyers pay it");
    // Transak publishes per-method figures as text — no "varies by country" placeholder may remain.
    assertIncludes(vchfBody, '3.5% + €1', "Transak's published card rate (EUR) must render with its fixed €1 on top");
    assertIncludes(vchfBody, 'SEPA 0.99%', "Transak's published SEPA rate must render");
    assertIncludes(vchfBody, 'margin', 'the spread most providers take must be named, not omitted');
    expect(vchfBody.includes('varies by country')).toBe(false);

    // ---- (d) attribution + the explicit non-endorsement ---------------------------------------
    const attribution = await readStable(m, 'funding-attribution');
    assertIncludes(attribution, '2026', 'the figures must carry the date they were read');
    assertIncludes(attribution, 'not prices', 'the attribution must say these are limits rather than prices');
    const endorsement = await readStable(m, 'funding-no-endorsement');
    assertIncludes(endorsement, 'recommends none', 'the screen must state that dpay recommends none of them');
    assertIncludes(endorsement, 'paid by none', 'the screen must state that dpay is paid by none of them');

    // ---- (e) native ICP is a DIRECT buy, reached by the ONE-tap switch ------------------------
    // The switch must KEEP the address sub-mode (the ordinary asset select resets it).
    await m.driver.click('btn-receive-asset-switch', {timeoutMs: 5000});
    await m.driver.click('req-pick-icp', {timeoutMs: 5000});
    await readStable(m, 'deposit-address');
    expect(m.driver.isPresent('btn-request')).toBe(false);
    await readStable(m, 'funding-routes');
    const icpBody = m.driver.bodyText();
    assertIncludes(icpBody, 'Buy', 'ICP is purchasable directly and must say so');
    expect(icpBody.includes('No provider sells')).toBe(false);

    await m.unmount();
  }, 150_000);
});

describe('flow 163 — funding mechanism: the instruction matches the deposit that actually runs', () => {
  it('ckUSDC never offers an address; ckBTC and Solana do, naming the backing chain', async () => {
    const m = await onboardWallet('jest-fund-mech');

    // The wallet must be IN dollars: CURRENCY_RAILS.USD is ['ckUSDC', 'USDC'] — the group that
    // once shadowed ckUSDC's own deposit sheet.
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-USD', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});

    // ---- (a) ckUSDC: a wallet-signed deposit, and copy that says so --------------------------
    await openBalances(m);
    await selectCurrency(m, 'ckusdc');
    await openReceiveAddress(m);
    // The ckERC20 family sheet beat the home-rail branch: the Ethereum route is reachable, and the
    // ICRC-transfer route rides along on the same (richer) surface.
    await readStable(m, 'ckerc20-deposit');
    expect(m.driver.isPresent('btn-connect-wallet')).toBe(true);
    expect(m.driver.isPresent('ic-also-section')).toBe(true);

    await readStable(m, 'funding-routes');
    const usdc = await readStable(m, 'funding-bridge');
    // The exact sentence the money-loss reading came from — asserted as an ABSENCE, because that
    // is the shape of the defect: a complete, confident, wrong instruction.
    expect(/send it to the address/i.test(usdc)).toBe(false);
    assertIncludes(usdc, 'No address exists for this one', 'the card must say plainly that this deposit has no address');
    assertIncludes(usdc, 'ETH', 'and it must name ETH — without it in the same wallet, the deposit cannot be signed at all');
    assertIncludes(usdc, 'in it for fees', 'the reason ETH is needed must be given, not left as a bare token name');
    assertIncludes(usdc, 'Ethereum', 'ckUSDC is bought on Ethereum, which is where the signed deposit runs');

    // ---- (b) ckBTC: a real address, and the BACKING chain named ------------------------------
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');
    await openReceiveAddress(m);
    await readStable(m, 'deposit-address');
    await readStable(m, 'funding-routes');
    const btc = m.driver.bodyText();
    assertIncludes(btc, 'Bitcoin', 'ckBTC is bought on BITCOIN — the row settles on the Internet Computer, and naming that as the place to buy sends the user looking for something nobody sells there');
    assertIncludes(btc, 'send it to the address above', 'and this mechanism DOES have an address, so the instruction must end there');
    expect(/no address exists for this one/i.test(btc)).toBe(false);

    // ---- (c) Solana: the same shape, with no descriptor behind it ----------------------------
    await openBalances(m);
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await readStable(m, 'sol-receive-qr');
    await readStable(m, 'funding-routes');
    const sol = m.driver.bodyText();
    assertIncludes(sol, 'Solana', 'the Solana rail names its own chain as the place to buy');
    assertIncludes(sol, 'send it to the address above', 'and it is an address deposit like any other');

    await m.unmount();
  }, 150_000);
});
