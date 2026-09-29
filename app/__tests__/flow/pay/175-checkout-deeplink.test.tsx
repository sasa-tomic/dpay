/**
 * Flow 175 — the jest twin of `e2e/tests/175-checkout-deeplink.mjs` (a checkout code arriving as an
 * OS App Link routes from idle Balances — the Pay tab never opened — straight into the SAME
 * OpenCryptoPay review a camera scan produces, on both rails).
 *
 * Exact amount, full destination, one price+host line — and no auto-sign on either rail: the IC
 * ledger balance is unchanged and the device broadcasts nothing until an Approve this flow never
 * presses.
 *
 * LOAD-ORDER CONTRACT: the RPC override is set before the harness require (see ./solrpc).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from './solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../harness/lib') as typeof import('../harness/lib');
const {accountOf, assertEq, assertIncludes, faucetAccount, generateKeypair, getBalance,
  onboardWallet, openBalances, railPrincipalText, selectCurrency} = lib;
const assert: typeof lib.assert = lib.assert;
const {CHECKOUT_QR, CLAIMED_MERCHANT, PAYMENT_ID, PROVIDER_HOST, installCheckoutStub, ocpStubState} =
  require('./ocp-stub') as typeof import('./ocp-stub');

const CHECKOUT_LINK = 'https://dpay.kalaj.org' + new URL(CHECKOUT_QR).pathname + new URL(CHECKOUT_QR).search;
const ICP = 8;
const ICP_SEED = 500_000_001;
const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const SOL_PAY_DISPLAY = '0.01219752 SOL'; // the checkout's 0.01219252 SOL at 9 decimals

hermeticDescribe('flow 175 — a checkout App Link opens the review from idle Balances, never auto-signing', () => {
  it('IC: idle → the scan review; SOL: the twin; no money moves on either rail', async () => {
    const m = await onboardWallet('jest-checkout-link');
    const accountHex = (await accountOf(m))!.publicHex;
    const merchant = await generateKeypair();
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    const fund = await faucetAccount(accountHex, ICP_SEED, {currency: ICP});
    assert(fund.ok, `faucet funding of ICP must succeed, got ${fund.status}`);

    const uninstall = installCheckoutStub({
      providerOrigin: `https://${PROVIDER_HOST}`,
      paymentId: PAYMENT_ID,
      callbackUrl: `https://${PROVIDER_HOST}/v1/lnurlp/cb/${PAYMENT_ID}`,
      merchantName: CLAIMED_MERCHANT,
      transferAmounts: (require('./ocp-stub') as typeof import('./ocp-stub')).TRANSFER_AMOUNTS,
      requestedAmount: {asset: 'CHF', amount: 1},
      uris: {
        'InternetComputer/ICP': `icp:ryjl3-tyaaa-aaaaa-aaaba-cai/transfer?to=${merchantPrincipal}&amount=0.50795551`,
        'Solana/SOL': `solana:${MERCHANT_ADDR}?amount=0.01219252`,
      },
    });

    try {
      // --- 1. IC rail: the App Link opens the review, never the browser's flow ---------------------
      await openBalances(m);
      await selectCurrency(m, 'icp');
      assert(await m.driver.waitForText('5.00000001 ICP', {timeoutMs: 10_000}), 'the app must see the ICP seed');
      // Deliberately NOT clicking tab-pay: the OS entry does its own routing (flow 70's territory).
      const deeplink = G.__DPAY_TEST_DEEPLINK as (u: string) => void;
      deeplink(CHECKOUT_LINK);

      await m.driver.findByTestID('pay-amount', {timeoutMs: 15_000});
      assert(await m.driver.waitForText('Pay 0.50805551 ICP', {timeoutMs: 15_000}), 'the review reaches the fee-inclusive total');
      assertEq(m.driver.readText('pay-amount'), 'Pay 0.50805551 ICP', 'the SAME review a camera scan produces');
      assertEq(m.driver.readText('review-payee'), merchantPrincipal, 'the FULL destination account');
      assertEq(m.driver.readText('ocp-price'), `CHF 1 · price from ${PROVIDER_HOST}`, 'the price+host line, unchanged');
      assertIncludes(m.driver.bodyText(), CLAIMED_MERCHANT, 'the claimed name');
      expect(m.driver.isPresent('btn-approve')).toBe(true);
      assertEq(await getBalance(accountHex, ICP), String(ICP_SEED), 'nothing leaves before the payer approves');
      expect(ocpStubState().txUrls).toEqual([]); // an unapproved review never touches the submission
      await m.driver.click('btn-review-cancel', {timeoutMs: 4000});

      // --- 2. SOL rail: the same App Link through the SOL twin ---------------------------------------
      G.__E2E_SOL_SENT = [];
      G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
        getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, token: {amount: '2500000', decimals: 6}}),
        sendTransaction: (_params: unknown) => {
          const sig = `sig_deeplink_${(G.__E2E_SOL_SENT as string[]).length + 1}`;
          (G.__E2E_SOL_SENT as string[]).push(sig);
          return sig;
        },
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
        getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
      });
      await openBalances(m);
      await selectCurrency(m, 'sol', {timeoutMs: 8000});
      deeplink(CHECKOUT_LINK);

      await m.driver.findByTestID('sol-pay-amount', {timeoutMs: 15_000});
      assertEq(m.driver.readText('sol-pay-amount'), `Pay ${SOL_PAY_DISPLAY}`, 'the SOL twin at 9-decimal precision');
      assertEq(m.driver.readText('sol-pay-payee'), MERCHANT_ADDR, 'the FULL destination address');
      assertEq(m.driver.readText('ocp-price'), `CHF 1 · price from ${PROVIDER_HOST}`, 'one component renders the price line for both rails');
      expect(m.driver.isPresent('btn-approve')).toBe(true);
      expect(G.__E2E_SOL_SENT as string[]).toEqual([]); // nothing broadcast while unapproved
    } finally {
      uninstall();
    }

    await m.unmount();
  }, 150_000);
});
