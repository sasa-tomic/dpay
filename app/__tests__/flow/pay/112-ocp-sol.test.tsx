/**
 * Flow 112 — the jest twin of `e2e/tests/112-opencryptopay-sol.mjs` (the OpenCryptoPay checkout on
 * the Solana rail, through the in-process provider fixture + the RPC stub).
 *
 * Leg 1: the checkout lists Solana USDC but its code names no token account — refused BY NAME, one
 * read, nothing signed. Leg 2: SOL reviews explicitly (9-decimal amount, full address, the price +
 * host line), Approve broadcasts exactly once and reports the proof once → Paid. Legs 3-4: the
 * confirmation goes UNREADABLE after the broadcast — the outcome is honest pending, the submission
 * stays unspent — and when the cluster comes back dpay re-READS the same signature (no second
 * broadcast) and completes the sale on its own.
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
  armPayScan, assertEq, assertIncludes, onboardWallet, openBalances, selectSolRail,
  selectCurrency,
} = lib;
const assert: typeof lib.assert = lib.assert;
const {CHECKOUT_QR, CLAIMED_MERCHANT, PAYMENT_ID, PROVIDER_HOST, installCheckoutStub, ocpStubState} =
  require('./ocp-stub') as typeof import('./ocp-stub');
const {scanSeam} = require('./local') as typeof import('./local');

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_DISPLAY = '0.01219752 SOL'; // the quoted amount + the network fee, at SOL's 9 decimals

/** The Solana RPC simulator: sendSol's REAL build/sign/broadcast/confirm path runs against it.
 *  `__E2E_SOL_SENT` makes the "never auto-signs" claim about money, not pixels. */
function installSolStub(): void {
  G.__E2E_SOL_SENT = [];
  G.__E2E_SOL_STATUS = 'confirmed';
  G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
    getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, token: {amount: '2500000', decimals: 6}}),
    sendTransaction: (_params: unknown) => {
      const sig = `sig_ocp_${(G.__E2E_SOL_SENT as string[]).length + 1}`;
      (G.__E2E_SOL_SENT as string[]).push(sig);
      return sig;
    },
    getSignatureStatuses: () => {
      if (G.__E2E_SOL_STATUS === 'unreadable') throw new Error('solana rpc: status node unavailable');
      return {context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]};
    },
    getBalance: () => ({value: 5_000_000_000}),
    getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
    getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
  });
}

const broadcasts = (): string[] => G.__E2E_SOL_SENT as string[];

/** Select an asset and land on its Pay scan surface, then point the camera at the checkout. */
async function selectAndScan(m: Parameters<typeof armPayScan>[0], assetKey: string): Promise<void> {
  await openBalances(m);
  if (assetKey === 'sol') {
    await selectCurrency(m, 'sol', {timeoutMs: 8000});
  } else {
    // Multi-rail currency: the SOL-rail USDC surface is reached through the receive asset switch.
    await selectSolRail(m, assetKey, {timeoutMs: 8000});
  }
  await m.driver.click('tab-pay', {timeoutMs: 5000});
  await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000});
  await armPayScan(m);
  await m.driver.settleFrames(1);
  scanSeam()(CHECKOUT_QR);
}

describe('flow 112 — OpenCryptoPay checkout (Solana rail): explicit review, one-shot proof, recoverable unknown', () => {
  it('USDC refused by name; SOL pays once; an unreadable verdict stays honest and recovers itself', async () => {
    const m = await onboardWallet('jest-ocp-sol');
    installSolStub();
    const uninstall = installCheckoutStub({
      providerOrigin: `https://${PROVIDER_HOST}`,
      paymentId: PAYMENT_ID,
      callbackUrl: `https://${PROVIDER_HOST}/v1/lnurlp/cb/${PAYMENT_ID}`,
      merchantName: CLAIMED_MERCHANT,
      transferAmounts: (require('./ocp-stub') as typeof import('./ocp-stub')).TRANSFER_AMOUNTS,
      requestedAmount: {asset: 'CHF', amount: 1},
      uris: {
        // The live shape — no `spl-token` parameter exists on this rail at all (measured), which is
        // exactly why leg 1 refuses USDC: the same URI names no token account.
        'Solana/SOL': `solana:${MERCHANT_ADDR}?amount=0.01219252`,
      },
      detailsDelayMs: 800, // the reads take real time; the wallet must say so
    });

    try {
      // --- 1. Solana USDC: offered by the checkout, refused by dpay --------------------------------
      await selectAndScan(m, 'sol-usdc');
      assert(await m.driver.waitForText('doesn’t say which account to pay', {timeoutMs: 12_000}),
        'the refusal names the measured reason: the code does not say which account to pay');
      assertIncludes(m.driver.bodyText(), 'pay with SOL instead', 'the refusal points at the asset that CAN pay');
      expect(m.driver.isPresent('sol-pay-amount')).toBe(false);
      expect(m.driver.isPresent('btn-approve')).toBe(false);

      let seen = ocpStubState();
      assertEq(seen.calls.length, 1, 'an unpayable checkout costs exactly one provider read');
      assertIncludes(seen.calls[0], 'timeout=0', 'the details read asks for the current charge');
      assertEq(seen.txUrls.length, 0, 'a refusal never touches the submission endpoint');
      expect(broadcasts()).toEqual([]); // nothing broadcast — that refusal stops money reaching the wrong account

      // --- 2. SOL: the explicit review, then the payment --------------------------------------------
      await selectAndScan(m, 'sol');
      expect(await m.driver.findByTestID('ocp-checking', {timeoutMs: 8000})).not.toBeNull();
      assertIncludes(m.driver.readText('ocp-checking'), 'payment provider', 'the waiting message names who is being asked');

      await m.driver.findByTestID('sol-pay-amount', {timeoutMs: 15_000});
      assertEq(m.driver.readText('sol-pay-amount'), `Pay ${PAY_DISPLAY}`, 'the review shows the exact quoted amount');
      assertEq(m.driver.readText('sol-pay-payee'), MERCHANT_ADDR, 'the review shows the FULL destination address');
      assertEq(m.driver.readText('ocp-price'), `CHF 1 · price from ${PROVIDER_HOST}`, 'the price + host line, byte-identical to the IC rail');
      expect(m.driver.isPresent('review-claimed')).toBe(false);
      expect(m.driver.isPresent('ocp-expiry')).toBe(false);
      assertIncludes(m.driver.bodyText(), CLAIMED_MERCHANT, 'the review shows the claimed name');
      expect(m.driver.isPresent('btn-approve')).toBe(true);
      expect(broadcasts()).toEqual([]); // nothing broadcast before the payer approves

      // --- 3. Approve: one transfer, one report, paid ------------------------------------------------
      await m.driver.click('btn-approve', {timeoutMs: 5000});
      assert(await m.driver.waitForText(`Paid ✓ ${PAY_DISPLAY}`, {timeoutMs: 20_000}), 'the paid state with the exact amount');
      expect(m.driver.isPresent('ocp-outcome')).toBe(false);
      const sent = broadcasts();
      assertEq(sent.length, 1, 'Approve broadcasts EXACTLY one Solana transaction');
      seen = ocpStubState();
      assertEq(seen.txUrls.length, 1, 'the proof is reported EXACTLY once');
      const submitted = new URL(seen.txUrls[0]);
      assertEq(submitted.pathname, `/v1/lnurlp/tx/${PAYMENT_ID}`, 'the submission hits the /tx path');
      assertEq(submitted.searchParams.get('method'), 'Solana', 'the submission echoes the method spelling');
      assertEq(submitted.searchParams.get('asset'), 'SOL', 'the submission echoes the asset spelling');
      assertEq(submitted.searchParams.get('tx'), sent[0], 'the reported proof is the broadcast signature');

      // --- 4. confirmation fails AFTER the broadcast — still recoverable -----------------------------
      G.__E2E_SOL_STATUS = 'unreadable';
      await m.driver.click('btn-sol-pay-done', {timeoutMs: 5000});
      await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000});
      await armPayScan(m);
      await m.driver.settleFrames(1);
      scanSeam()(CHECKOUT_QR);
      await m.driver.findByTestID('sol-pay-amount', {timeoutMs: 15_000});
      await m.driver.click('btn-approve', {timeoutMs: 5000});

      const pending = await m.driver.findByTestID('ocp-outcome', {timeoutMs: 20_000});
      expect(pending).not.toBeNull();
      const pendingText = m.driver.readText('ocp-outcome');
      assertIncludes(pendingText, 'neither paid nor failed', 'an unconfirmable transfer is neither paid nor failed');
      assertIncludes(pendingText, 'Keep this screen open', 'the copy names what keeps the recovery running');
      expect(m.driver.bodyText()).not.toContain(`Paid ✓ ${PAY_DISPLAY}`);
      assertEq(broadcasts().length, 2, 'this leg broadcasts exactly one more transaction');
      assertEq(ocpStubState().txUrls.length, 1, 'an unconfirmed transfer must not be reported — the submission stays unspent');

      // The cluster comes back: dpay re-reads the SAME signature — no second broadcast — and the
      // sale completes on its own.
      G.__E2E_SOL_STATUS = 'confirmed';
      assert(await m.driver.waitForText(`Paid ✓ ${PAY_DISPLAY}`, {timeoutMs: 20_000}),
        'a recovered transfer completes the sale with no action from the payer');
      expect(m.driver.isPresent('ocp-outcome')).toBe(false);
      const recovered = broadcasts();
      assertEq(recovered.length, 2, 'recovery re-READS the transaction; it never re-broadcasts one');
      seen = ocpStubState();
      const distinctProofs = [...new Set(seen.txUrls)];
      assertEq(distinctProofs.length, 2, 'exactly two DISTINCT proofs are reported in total');
      expect(distinctProofs.every((u) => recovered.includes(new URL(u).searchParams.get('tx') ?? ''))).toBe(true);
      assertEq(new URL(seen.txUrls[1]).searchParams.get('tx'), recovered[1], 'the recovered proof names the actual broadcast');

      expect(ocpStubState().unexpected).toEqual([]);
    } finally {
      uninstall();
    }

    await m.unmount();
  }, 180_000);
});
