/**
 * Flows 104 + 106 + 107 (+ the 105 fold) — the jest twins of `e2e/tests/104-send-to-address.mjs`,
 * `106-send-auto-route.mjs`, `107-send-account-identifier.mjs`, and the fold spec names for 105
 * (its refusal matrix is already pinned by `app/__tests__/destination.test.ts`; the DISABLED-BUTTON
 * composition ports here).
 *
 * 104: a no-minter direct-ICRC asset (VCHF) sends to an external IC account — route disclosed with
 * the fee BEFORE the amount, review shows amount/fee/total, one icrc1_transfer settles, both sides
 * move at the gateway, the UI follows. 106: ONE destination field routes ckBTC by what is pasted
 * (Bitcoin address → the burn body; IC principal → the direct body) and executes the direct rail.
 * 107: ICP to a 64-hex account identifier via the legacy `transfer` — a one-character corruption
 * dies on the CRC before anything is signed. 105-fold: every refusal leaves the send button
 * disabled, never pressable.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assert, assertDisabled, assertEq, assertIncludes, faucetAccount, getBalance,
  onboardWallet, openBalances, railPrincipalText, selectCurrency, openPaySend,
} from '../harness/lib';
import {icpAccountIdentifierHex} from '../pay/local';

const VCHF_CURRENCY = 7;
const BTC_CURRENCY = 1;
const ICP_CURRENCY = 8;
const BTC_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const ETH_ADDR = '0x000000000000000000000000000000000000dead';
const VCHF_PUBKEY = 'b'.repeat(64);
const BTC_PUBKEY = 'c'.repeat(64);
const ICP_PUBKEY = 'd'.repeat(64);

/** Wait the route line out (the classifier is async), then return it. */
async function routeLine(m: Parameters<typeof openBalances>[0], needle: string): Promise<string> {
  await m.driver.waitForFunction(() => (m.driver.readTextSafe('send-status') ?? '').includes(needle),
    {timeoutMs: 6000, label: `the route line names ${needle}`});
  return m.driver.readText('send-status');
}

hermeticDescribe('flow 104 — send VCHF to an external IC account (direct icrc1_transfer)', () => {
  it('route + fee disclosed first; one transfer settles; both sides move; the UI follows', async () => {
    const m = await onboardWallet('jest-send');
    const accountHex = (await accountOf(m))!.publicHex;
    const recipientPrincipal = await railPrincipalText(VCHF_PUBKEY);

    const fund = await faucetAccount(accountHex, 500_000_000, {currency: VCHF_CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    assertEq(await getBalance(accountHex, VCHF_CURRENCY), '500000000', 'pre-send VCHF at the sender');
    assertEq(await getBalance(VCHF_PUBKEY, VCHF_CURRENCY).catch(() => '0'), '0', 'recipient starts with none');

    await openBalances(m);
    await m.driver.waitForText('5.00 VCHF', {timeoutMs: 8000});
    await selectCurrency(m, 'vchf');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});

    // The route line resolves through the REAL core parser: network + fee, BEFORE any amount.
    await m.driver.type('send-address-input', recipientPrincipal, {timeoutMs: 4000});
    const route = await routeLine(m, 'Internet Computer');
    // The fee rides the route when the ledger fee resolved in time; otherwise the honest
    // unknown-fee wording shows and the review cell pins the exact fee below.
    expect(/0\.0001 VCHF|the ledger's own fee applies/.test(route)).toBe(true);

    await m.driver.type('send-amount-input', '1.25000000', {timeoutMs: 4000});
    await m.driver.findByTestID('send-review-amount', {timeoutMs: 4000});
    assertIncludes(m.driver.readText('send-review-amount'), '1.25 VCHF', 'review shows the amount, compact');
    // The fee cell starts at "set by the ledger" and resolves to the ledger's icrc1_fee.
    await m.driver.waitForFunction(() => !m.driver.readTextSafe('send-review-fee')?.includes('set by the ledger'),
      {timeoutMs: 8000, label: 'the review fee cell resolved'});
    assertIncludes(m.driver.readText('send-review-fee'), '0.0001', 'review shows the ledger fee');
    assertIncludes(m.driver.readText('send-review-total'), '1.2501', 'review shows amount + fee as the total');

    await m.driver.click('btn-send-confirm', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Sent', {timeoutMs: 15_000}), 'the send confirms "Sent"');
    assertEq(m.driver.readText('send-destination'), recipientPrincipal, 'the success screen shows the full destination');

    assertEq(await getBalance(accountHex, VCHF_CURRENCY), String(500_000_000 - 125_000_000 - 10_000),
      'sender debited by amount + fee');
    assertEq(await getBalance(VCHF_PUBKEY, VCHF_CURRENCY), '125000000', 'recipient credited by exactly the amount');

    // The wallet SURFACE agrees: the CHF row drops to 3.74 Fr (the currency-unit sum).
    await m.driver.click('btn-send-done', {timeoutMs: 5000});
    await openBalances(m);
    assert(await m.driver.waitForText('3.74 Fr', {timeoutMs: 10_000}), 'the UI CHF row dropped');
    expect(m.driver.readText('accounts-list')).not.toContain('5.00 Fr');

    await m.unmount();
  }, 180_000);
});

hermeticDescribe('flow 106 — send-auto-route: one destination field routes ckBTC by what is pasted', () => {
  it('Bitcoin paste → the burn body; IC principal → the direct body; the direct send settles', async () => {
    const m = await onboardWallet('jest-autoroute');
    const accountHex = (await accountOf(m))!.publicHex;
    const recipientPrincipal = await railPrincipalText(BTC_PUBKEY);

    const fund = await faucetAccount(accountHex, 200_000, {currency: BTC_CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    assertEq(await getBalance(accountHex, BTC_CURRENCY), '200000', 'pre-send ckBTC balance');

    await openBalances(m);
    await m.driver.waitForText('0.002 BTC', {timeoutMs: 8000});
    await selectCurrency(m, 'ckbtc');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});

    // 1. A Bitcoin address → the chain-key burn with BITCOIN economics.
    await m.driver.type('send-address-input', BTC_ADDR, {timeoutMs: 4000});
    const btcRoute = await routeLine(m, 'Bitcoin');
    assertIncludes(btcRoute, '0.0005', 'the route quotes Bitcoin’s withdraw minimum, not an IC fee');
    await m.driver.findByTestID('withdraw-amount-input', {timeoutMs: 5000});
    expect(m.driver.isPresent('send-amount-input')).toBe(false);

    // 2. The SAME field, an IC principal → the direct rail; the bodies swap.
    await m.driver.type('send-address-input', recipientPrincipal, {timeoutMs: 4000});
    const icRoute = await routeLine(m, 'Internet Computer');
    expect(icRoute).not.toContain('Bitcoin');
    await m.driver.findByTestID('send-amount-input', {timeoutMs: 5000});
    expect(m.driver.isPresent('withdraw-amount-input')).toBe(false);

    // 3. Execute the direct route: 30_000 sats is BELOW the Bitcoin minimum and still valid on IC.
    await m.driver.type('send-amount-input', '0.00030000', {timeoutMs: 4000});
    await m.driver.findByTestID('send-review-amount', {timeoutMs: 4000});
    // The fee cell states the LEDGER-reported fee exactly (the pinned 10 sats) — never a zero.
    assertEq(m.driver.readText('send-review-fee'), '0.0000001 BTC', 'the fee cell states the ledger fee exactly');
    await m.driver.click('btn-send-confirm', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Sent', {timeoutMs: 15_000}), 'the IC send confirms "Sent"');
    assertEq(m.driver.readText('send-destination'), recipientPrincipal, 'the success screen shows the full IC destination');

    assertEq(await getBalance(BTC_PUBKEY, BTC_CURRENCY), '30000', 'recipient credited on the ckBTC LEDGER (a transfer, not a burn)');
    assertEq(await getBalance(accountHex, BTC_CURRENCY), String(200_000 - 30_000 - 10),
      'sender debited by the amount plus the pinned 10-sat ledger fee');

    await m.unmount();
  }, 180_000);
});

hermeticDescribe('flow 107 — send ICP to a 64-hex account identifier (legacy transfer, CRC-validated)', () => {
  it('a corrupted identifier dies on the CRC; the real one settles at the owning principal', async () => {
    const m = await onboardWallet('jest-acctid');
    const accountHex = (await accountOf(m))!.publicHex;

    const recipientAccountId = icpAccountIdentifierHex(ICP_PUBKEY);
    assertEq(recipientAccountId.length, 64, 'an account identifier is 64 hex characters');

    const fund = await faucetAccount(accountHex, 400_000_000, {currency: ICP_CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    // Seed the recipient so the gateway KNOWS the principal (an unseen account cannot be resolved).
    const seedRecipient = await faucetAccount(ICP_PUBKEY, 1, {currency: ICP_CURRENCY});
    assert(seedRecipient.ok, 'recipient seed must succeed');
    assertEq(await getBalance(accountHex, ICP_CURRENCY), '400000000', 'pre-send ICP balance');

    await openBalances(m);
    await m.driver.waitForText('4.00000000 ICP', {timeoutMs: 8000});
    await selectCurrency(m, 'icp');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});

    // A mistyped exchange address dies on the CRC, before anything is signed.
    const broken = recipientAccountId.slice(0, 63) + (recipientAccountId[63] === 'a' ? 'b' : 'a');
    await m.driver.type('send-address-input', broken, {timeoutMs: 4000});
    assert(await m.driver.waitForText('incomplete or mistyped', {timeoutMs: 6000}),
      'a one-character corruption is caught by the CRC');

    // The real address: the ICP account rail, fee disclosed up front.
    await m.driver.type('send-address-input', recipientAccountId, {timeoutMs: 4000});
    const route = await routeLine(m, 'ICP account');
    assertIncludes(route, 'ICP account', 'the route line names the ICP account rail');

    await m.driver.type('send-amount-input', '1.00000000', {timeoutMs: 4000});
    await m.driver.findByTestID('send-review-total', {timeoutMs: 4000});
    await m.driver.waitForFunction(() => !m.driver.readTextSafe('send-review-fee')?.includes('set by the ledger'),
      {timeoutMs: 8000, label: 'the review fee cell resolved'});
    assertIncludes(m.driver.readText('send-review-total'), '1.0001', 'the review totals amount + fee');

    await m.driver.click('btn-send-confirm', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Sent', {timeoutMs: 15_000}), 'the legacy send confirms "Sent"');
    assertEq(m.driver.readText('send-destination'), recipientAccountId, 'the success screen shows the full identifier');

    assertEq(await getBalance(accountHex, ICP_CURRENCY), String(400_000_000 - 100_000_000 - 10_000),
      'sender debited by amount + fee');
    assertEq(await getBalance(ICP_PUBKEY, ICP_CURRENCY), String(1 + 100_000_000), 'the principal owning the identifier was credited (seed + the send)');

    await m.unmount();
  }, 180_000);
});

hermeticDescribe('flow 105 (fold) — refusals leave the send button disabled, never pressable', () => {
  it('every wrong-destination paste names the problem + the next step with Confirm disabled', async () => {
    const m = await onboardWallet('jest-refuse');
    const accountHex = (await accountOf(m))!.publicHex;
    const fund = await faucetAccount(accountHex, 500_000_000, {currency: VCHF_CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);

    await openBalances(m);
    await m.driver.waitForText('5.00 VCHF', {timeoutMs: 8000});
    await selectCurrency(m, 'vchf');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});

    const accountId = icpAccountIdentifierHex('a'.repeat(64));
    const cases: Array<{text: string; expect: string[]}> = [
      {text: BTC_ADDR, expect: ['Bitcoin', 'Internet Computer']},
      {text: ETH_ADDR, expect: ['Ethereum', 'Internet Computer']},
      {text: accountId, expect: ['ICP account identifier', 'principal']},
    ];
    for (const {text, expect: needles} of cases) {
      await m.driver.type('send-address-input', text, {timeoutMs: 4000});
      for (const needle of needles) {
        await m.driver.waitForFunction(() => (m.driver.readTextSafe('send-status') ?? '').includes(needle),
          {timeoutMs: 6000, label: `the refusal names ${needle}`});
      }
      await assertDisabled(m, 'btn-send-confirm', `the send button never becomes pressable for "${needles[0]}"`);
    }

    // A checksum-broken principal is called incomplete — check the digits, not the chain.
    const good = await railPrincipalText('a'.repeat(64));
    const broken = good.slice(0, good.length - 2) + (good.endsWith('ae') ? 'aa' : 'ae');
    await m.driver.type('send-address-input', broken, {timeoutMs: 4000});
    await m.driver.waitForFunction(() => (m.driver.readTextSafe('send-status') ?? '').includes('incomplete or mistyped'),
      {timeoutMs: 6000, label: 'the broken principal is called incomplete'});
    await assertDisabled(m, 'btn-send-confirm', 'a broken principal leaves Confirm disabled');

    await m.unmount();
  }, 180_000);
});
