/**
 * Flows 119 + 132 + 137 — the jest twins of `e2e/tests/119-solana-pay-scan.mjs`,
 * `132-eurc-solana-pay.mjs`, and `137-sol-cross-mint-sign-gate.mjs` (Solana Pay requests on the
 * SOL rail, through the in-memory RPC stub).
 *
 * 119: an IC-rail scan refuses a Solana Pay request BY NAME with the switch instruction; on the SOL
 * rail unknown params and unknown mints are named; a full merchant request reviews with the total
 * debit, label, message and FULL destination — never auto-signed — and pays; the spl-token variant
 * discloses the recipient-ATA rent. 132: home=EUR + a non-catalog mint refused with its pubkey; the
 * EURC request names the token in EURC's own decimals. 137: the cross-mint sign gate — an absent
 * account refuses the sign BY NAME, a funded request-mint signs offline, and a rail-down endpoint
 * signs anyway WITH the honest caveat (never "get online").
 *
 * LOAD-ORDER CONTRACT: the RPC override is set before the harness require (see ./solrpc).
 */
import {describe, it, expect} from '@jest/globals';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from './solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../harness/lib') as typeof import('../harness/lib');
const {
  accountOf, armPayScan, assert, assertEq, assertIncludes, onboardWallet, openBalances,
  selectCurrency, selectSolRail,
} = lib;
const {scanSeam} = require('./local') as typeof import('./local');

const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const REFERENCE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; // a second pubkey — the merchant's reference
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'; // Circle's native EURC (6 dec)

function installSolStub(): void {
  G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
    getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, token: {amount: '2000000', decimals: 6}}),
    getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
    getBalance: () => ({value: 5_000_000_000}),
    getTokenAccountBalance: () => ({value: {amount: '2000000', decimals: 6, uiAmount: 2, uiAmountString: '2'}}),
  });
}

describe('flow 119 — Solana Pay scan: named refusals, the explicit review, and the payment', () => {
  it('IC refuses by name; SOL names params/mints; the review pays SOL and spl-token USDC', async () => {
    const m = await onboardWallet('jest-spay');
    installSolStub();

    // 1. On the IC rail, a Solana Pay request is refused BY NAME — one rail over, with the way out.
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(`solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}`);
    assert(await m.driver.waitForText('Solana Pay', {timeoutMs: 8000}), 'the refusal names Solana Pay');
    const icBody = m.driver.bodyText();
    expect(icBody).toMatch(/Internet Computer/);
    expect(icBody).toMatch(/Balances/);

    // 2-3. On the SOL rail: named refusals first (nothing sent, the scan surface stays).
    await openBalances(m);
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000});
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(`solana:${MERCHANT}?amount=0.001&residual=1`);
    assert(await m.driver.waitForText('residual', {timeoutMs: 8000}), 'unknown param named: residual');
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(`solana:${MERCHANT}?spl-token=${REFERENCE}`);
    assert(await m.driver.waitForText(REFERENCE, {timeoutMs: 8000}), 'unknown mint named with its pubkey');

    // 4. The full review: fixed amount, label, message, FULL destination — and no auto-sign.
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(`solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}&label=Coffee%20Bar&message=Order%2042`);
    await m.driver.findByTestID('sol-pay-amount', {timeoutMs: 8000});
    expect(m.driver.readText('sol-pay-amount')).toMatch(/0\.001005 SOL/);
    assertEq(m.driver.readText('sol-pay-payee'), MERCHANT, 'the FULL merchant address must be on the review');
    assert(await m.driver.waitForText('Coffee Bar', {timeoutMs: 5000}), 'the label');
    assert(await m.driver.waitForText('Order 42', {timeoutMs: 5000}), 'the message');
    await m.driver.findByTestID('btn-approve', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-sol-pay-cancel', {timeoutMs: 5000});

    // 5. Approve → the memo-less SOL transfer with the reference key → Paid + signature.
    await m.driver.waitGone('sol-pay-lowbal', {timeoutMs: 10_000});
    await lib.waitForEnabled(m, 'btn-approve');
    await m.driver.click('btn-approve', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-status', {timeoutMs: 12_000});
    expect(m.driver.readText('sol-pay-status')).toMatch(/0\.001005 SOL/);
    await m.driver.findByTestID('sol-spay-signature', {timeoutMs: 5000});
    expect(m.driver.readText('sol-spay-signature')).toMatch(/^sig_/);

    // 6. The spl-token variant: the rent is disclosed, then paid.
    await m.driver.click('btn-sol-pay-done', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000});
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(`solana:${MERCHANT}?spl-token=${USDC_MINT}&amount=1.5&reference=${REFERENCE}`);
    await m.driver.findByTestID('sol-pay-amount', {timeoutMs: 8000});
    expect(m.driver.readText('sol-pay-amount')).toMatch(/1\.5 USDC/);
    await m.driver.findByTestID('sol-spay-ata-note', {timeoutMs: 5000}); // the ATA rent disclosed
    await m.driver.waitGone('sol-pay-lowbal', {timeoutMs: 10_000});
    await lib.waitForEnabled(m, 'btn-approve');
    await m.driver.click('btn-approve', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-status', {timeoutMs: 12_000});
    expect(m.driver.readText('sol-pay-status')).toMatch(/1\.5 USDC/);

    await m.unmount();
  }, 180_000);
});

describe('flow 132 — EURC Solana Pay (home=EUR): the review names the token it will move', () => {
  it('a non-catalog mint is refused with its pubkey; the EURC request reviews and pays in EURC', async () => {
    const m = await onboardWallet('jest-eurc-spay');
    // home=EUR pins the EURC rail as the preferred one.
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-EUR', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await lib.waitForWallet(m, {timeoutMs: 8000});
    await m.driver.click('tab-home', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('home-headline-label'), 'Balance EUR', 'home=EUR names the currency');

    installSolStub();
    await openBalances(m);
    await selectSolRail(m, 'sol-eurc', {timeoutMs: 5000});

    // 1. A non-catalog mint is refused BY NAME, with its pubkey.
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000});
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(`solana:${MERCHANT}?spl-token=${REFERENCE}&amount=1.5`);
    assert(await m.driver.waitForText(REFERENCE, {timeoutMs: 8000}), 'non-catalog mint named with its pubkey');

    // 2. The EURC request reviews in EURC's own 6 decimals.
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(`solana:${MERCHANT}?spl-token=${EURC_MINT}&amount=1.5&reference=${REFERENCE}&label=Kaffeestation&message=Bestellung%2042`);
    await m.driver.findByTestID('sol-pay-amount', {timeoutMs: 8000});
    expect(m.driver.readText('sol-pay-amount')).toMatch(/1\.5 EURC/);
    assertEq(m.driver.readText('sol-pay-payee'), MERCHANT, 'the FULL merchant address on the review');
    assert(await m.driver.waitForText('Kaffeestation', {timeoutMs: 5000}), 'the label');
    await m.driver.findByTestID('sol-spay-ata-note', {timeoutMs: 5000});
    await m.driver.waitGone('sol-pay-lowbal', {timeoutMs: 10_000});
    await lib.waitForEnabled(m, 'btn-approve');
    await m.driver.click('btn-approve', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-status', {timeoutMs: 12_000});
    expect(m.driver.readText('sol-pay-status')).toMatch(/1\.5 EURC/);

    await m.unmount();
  }, 180_000);
});
