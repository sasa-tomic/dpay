/**
 * The pay-link family — jest twins of `e2e/tests/70-deeplink-ic-routing.mjs`,
 * `102-sol-pay-link.mjs`, `103-pay-link-refused.mjs`, and `123-pay-link-named-rail.mjs`.
 *
 * A payment link is a PINNED request: it routes to the rail it NAMES (never the preferred one),
 * never auto-sends, and refuses with usable instructions when the wallet cannot pay it.
 *
 * LOAD-ORDER CONTRACT (see ./solrpc): constants.ts captures the SOL RPC override at module load,
 * so this file sets it and installs the accounts helper BEFORE the harness require loads App.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from './solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../harness/lib') as typeof import('../harness/lib');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {mountApp} = require('../harness/mount') as typeof import('../harness/mount');
const {assertEq, assertIncludes, onboardWallet, waitForWallet} = lib;
// Assertion functions need an explicitly-annotated call target (TS2775) — never destructure them.
const assert: typeof lib.assert = lib.assert;

const DEST_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const SEND_AMOUNT = '0.001';
const PRINCIPAL = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // a real, CRC-valid IC principal

hermeticDescribe('flow 70 — an IC link routes to the IC engine while SOL is idle-selected', () => {
  it('SOL selected + IC link → PayMode review mounts, SolPayMode unmounts, selection untouched', async () => {
    const m = await onboardWallet('jest-ic-route');

    // SOL idle-selected (the failure precondition: SolPayMode owns the Pay tab).
    await lib.openBalances(m);
    await lib.selectCurrency(m, 'sol', {timeoutMs: 5000});
    assertEq(m.driver.readText('active-asset-label'), 'Balance SOL', 'SOL main');
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});

    // The foreground-link seam (the same handler the OS App Link listener drives).
    const bob = await lib.generateKeypair();
    const bobPrincipal = await lib.railPrincipalText(bob.publicHex);
    const link = `https://dpay.kalaj.org/wallet/pay/${bobPrincipal}`
      + `?asset=DEMO&network=internet-computer&amount=25&label=Bob&ref=${'cd'.repeat(16)}`;
    const deeplink = G.__DPAY_TEST_DEEPLINK as (u: string) => void;
    assert(typeof deeplink === 'function', '__DPAY_TEST_DEEPLINK is not registered — Wallet did not mount');
    deeplink(link);

    // ROUTING: the resolve effect selects the link's asset for the WORKING surface only.
    await m.driver.findByTestID('pay-amount', {timeoutMs: 5000});
    assertEq(m.driver.readText('active-asset-label'), 'Balance SOL', 'the routing flipped the WORKING selection only');
    assertIncludes(m.driver.readText('pay-amount'), '∂25.00', 'PayMode review shows the exact requested amount');
    assertIncludes(m.driver.bodyText(), 'Bob', 'review shows the label the link carried');
    expect(m.driver.isPresent('sol-pay-scan')).toBe(false);
    await m.driver.findByTestID('btn-approve', {timeoutMs: 5000});

    await m.unmount();
  }, 120_000);
});

hermeticDescribe('flow 102 — a SOL link pre-fills the Send-to-address form (rail parity with flow 49)', () => {
  it('the link selects SOL, pre-fills address + amount, never auto-sends; Confirm broadcasts', async () => {
    const m = await onboardWallet('jest-sol-link');

    // 5 SOL on the device so the send form renders instead of the fund-first gate.
    G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
      getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, token: {amount: '0', decimals: 6}}),
    });

    // --- 1. The link selected the SOL rail for the user; the chip keeps the MAIN currency. -------
    // Pin MAIN=CHF deterministically (the browser profile's persisted home in the e2e twin): a
    // sibling describe in this file selects SOL as MAIN, and MAIN outlives the remount.
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-CHF', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await m.unmount();
    const link = `/wallet/pay/${DEST_ADDR}?asset=SOL&network=solana&amount=${SEND_AMOUNT}&label=${encodeURIComponent('Sol Merchant')}`;
    const m2 = await mountApp({url: link});

    await m2.driver.findByTestID('sol-send-address-input', {timeoutMs: 10_000});
    assertEq(m2.driver.readText('active-asset-label'), 'Balance CHF', 'the link moves the WORKING selection, never main');

    // 2. Pre-filled with the link's destination + amount (a state update — wait for the values).
    await m2.driver.waitForFunction(
      () => m2.driver.readInputValue('sol-send-address-input') === DEST_ADDR
        && m2.driver.readInputValue('sol-send-amount-input') === SEND_AMOUNT,
      {timeoutMs: 10_000, label: 'the link pre-fills the send form'},
    );
    expect(m2.driver.readInputValue('sol-send-address-input')).toBe(DEST_ADDR);
    expect(m2.driver.readInputValue('sol-send-amount-input')).toBe(SEND_AMOUNT);

    // 3. NOTHING was sent — the review (0.001 + the 5000-lamport fee) is showing.
    await m2.driver.findByTestID('sol-send-review', {timeoutMs: 5000});
    expect(m2.driver.readText('sol-send-review')).toMatch(/0\.001005 SOL/);
    expect(m2.driver.bodyText()).not.toMatch(/Sent/);

    // 4. Confirm → the REAL send path through the stub.
    await m2.driver.click('btn-sol-send-confirm', {timeoutMs: 5000});
    await m2.driver.findByTestID('sol-send-outcome', {timeoutMs: 12_000});
    expect(m2.driver.readText('sol-send-outcome')).toMatch(/Sent/);
    expect(m2.driver.readText('sol-send-signature')).toMatch(/^sig_/);

    await m2.unmount();
  }, 150_000);
});

hermeticDescribe('flow 103 — a link the wallet cannot pay is refused with a usable instruction', () => {
  it('wrong chain / unknown asset / malformed each name the problem + the next step', async () => {
    const m0 = await onboardWallet('jest-link-refused');
    await m0.unmount();

    const open = async (query: string) => {
      const m = await mountApp({url: `/wallet/pay/${PRINCIPAL}?${query}`});
      await m.driver.findByTestID('pay-link-error', {timeoutMs: 8000});
      return {m, body: m.driver.readText('pay-link-error-body')};
    };

    // 1. WRONG CHAIN — the wallet holds ckUSDC on the IC; the link names USDC@Solana. Guessing
    //    would pay the wrong (unrecoverable) chain — the reason `network` is required.
    {
      const {m, body} = await open('asset=ckUSDC&network=solana&amount=1');
      assertIncludes(body, 'ckUSDC', 'the refusal must name the asset the link asked for');
      assertIncludes(body, 'Solana', 'the refusal must name the chain the link asked for');
      assertIncludes(body, 'elsewhere', 'the refusal must say the wallet holds it elsewhere');
      assertIncludes(body, 'wrong chain', 'the refusal must state the consequence of guessing');
      assertIncludes(body, 'ask the sender', 'the refusal must tell the payer what to do next');
      expect(m.driver.isPresent('pay-amount')).toBe(false);
      expect(m.driver.isPresent('btn-approve')).toBe(false);
      // Dismissing returns the payer to the normal Pay surface — the refusal is not a trap.
      await m.driver.click('btn-pay-link-error-close', {timeoutMs: 5000});
      await m.driver.waitGone('pay-link-error', {timeoutMs: 5000});
      await m.driver.findByTestID('btn-start-scan', {timeoutMs: 5000});
      await m.unmount();
    }

    // 2. UNKNOWN ASSET — not in the catalog; dpay never swaps, so there is no fallback to offer.
    {
      const {m, body} = await open('asset=ckDOGE&network=internet-computer&amount=1');
      assertIncludes(body, 'ckDOGE', 'the refusal must name the unknown asset verbatim');
      assertIncludes(body, 'never swaps', 'the refusal must state why no substitute is offered');
      await m.unmount();
    }

    // 3. MALFORMED — no amount; naming the missing part lets the payer ask for a correct link.
    {
      const {m, body} = await open('asset=DEMO&network=internet-computer');
      assertIncludes(body, 'the amount', 'the refusal must name the missing part of the link');
      assertIncludes(body, 'new link', 'the refusal must tell the payer to ask for a new link');
      await m.unmount();
    }
  }, 150_000);
});

hermeticDescribe('flow 123 — a link that NAMES the sibling rail pays exactly that rail (never-override)', () => {
  it('home=USD + preferred ckUSDC selected; the USDC@Solana link pins the Solana form + pays it', async () => {
    const m = await onboardWallet('jest-named-rail');

    // Pin home=USD ⇒ the preferred ckUSDC rail is selected first (the baseline to override).
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-USD', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});
    await m.driver.click('tab-home', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('home-headline-label'), 'Balance USD',
      'home=USD must start on the preferred ckUSDC rail');

    // USDC FUNDED (2.5 — the richer sibling, tempting any chooser) + 5 SOL for fees.
    G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
      getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, token: {amount: '2500000', decimals: 6}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    });

    // The link NAMES the sibling rail.
    await m.unmount();
    const link = `/wallet/pay/${DEST_ADDR}?asset=USDC&network=solana&amount=${SEND_AMOUNT}&label=${encodeURIComponent('Named Rail Merchant')}`;
    const m2 = await mountApp({url: link});

    await m2.driver.findByTestID('sol-send-address-input', {timeoutMs: 10_000});
    assertEq(m2.driver.readText('active-asset-label'), 'Balance USD',
      'the chip headlines the MAIN currency — the NAMED rail is pinned by the working surface');
    await m2.driver.waitForFunction(
      () => m2.driver.readInputValue('sol-send-address-input') === DEST_ADDR
        && m2.driver.readInputValue('sol-send-amount-input') === SEND_AMOUNT,
      {timeoutMs: 10_000, label: 'the link pre-fills the send form'},
    );
    expect(m2.driver.readInputValue('sol-send-address-input')).toBe(DEST_ADDR);
    expect(m2.driver.readInputValue('sol-send-amount-input')).toBe(SEND_AMOUNT);

    // The pinned path carries NO rail-selection copy — and never the preferred rail's name.
    const body = m2.driver.bodyText();
    expect(body).not.toMatch(/Switch to/);
    expect(body).not.toMatch(/ckUSDC/);
    expect(body).not.toMatch(/default rail/);
    expect(m2.driver.isPresent('receive-rail-disclosure')).toBe(false);
    expect(m2.driver.isPresent('fund-sibling-rail')).toBe(false);

    // The review pays the NAMED rail exactly; nothing was sent by the link itself.
    await m2.driver.findByTestID('sol-send-review', {timeoutMs: 5000});
    expect(m2.driver.readText('sol-send-review')).toMatch(/0\.001 USDC/);
    expect(body).not.toMatch(/Sent/);
    await m2.driver.click('btn-sol-send-confirm', {timeoutMs: 5000});
    await m2.driver.findByTestID('sol-send-outcome', {timeoutMs: 12_000});
    expect(m2.driver.readText('sol-send-outcome')).toMatch(/Sent/);

    await m2.unmount();
  }, 150_000);
});
