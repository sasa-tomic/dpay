// Flow 102 — a SOL payment link pre-fills the Solana "Send to address" form (rail parity).
//
// The same-surfaces hard rule says every currency is handled through the SAME UI surfaces and
// flows. A payment link is one of those surfaces: `…/wallet/pay/<address>?asset=SOL&network=solana`
// must work exactly like its IC twin (flow 49), landing the payer on the rail's own confirm
// surface with the destination + amount already filled in.
//
// The rails differ in ONE physically-forced way, and this flow pins it: SOL has no IC-style
// request/review engine, so its equivalent is the pre-filled "Send to address" form in the SAME Pay
// tab — the same tab, the same toggle, reached without the user touching either. What must NOT
// differ: the link grammar, the routing, and the rule that a link never sends money on its own.
//
// Proves end-to-end through the REAL app:
//   1. Opening a SOL payment link selects the SOL asset (header flips to "SOL balance") — the user
//      does not have to find the rail themselves.
//   2. The Pay tab lands on "Send to address" with the link's address + amount already entered.
//   3. Nothing was sent: the review card is showing and the payer must still press Confirm.
//   4. Confirm signs + broadcasts (stub) → Sent ✓ — the link fed the REAL send path.
//
// Selector contract: `active-asset-label`, `sol-send-address-input`, `sol-send-amount-input`,
// `sol-send-review`, `btn-sol-send-confirm`, `sol-send-outcome`.
import {setup, assert, assertEq, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '102',
  name: 'sol-pay-link',
  journey: 'pay',
  covers: ['pay-link', 'url-routing', 'sol-send', 'rail-parity'],
  verifies: 'A SOL payment link selects the SOL rail and pre-fills the Send-to-address form with the link\'s address + amount (no auto-send); Confirm broadcasts it.',
  timeoutMs: 90000,
};

const DEST_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const SEND_AMOUNT = '0.001'; // 0.001 SOL = 1_000_000 lamports

export async function run() {
  const start = Date.now();
  console.log('[102-sol-pay-link] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    console.log('[102-sol-pay-link] onboarding…');
    await onboardWallet(driver, 'e2e-sol-link');

    // The SOL RPC stub (same shapes as flow 52): funds the device 5 SOL so the send form renders
    // instead of the zero-balance fund-first gate, and answers the broadcast/confirm calls.
    // Installed on EVERY subsequent document (not just this one) because this flow navigates to the
    // payment link — a plain driver.eval would be wiped by that load.
    await driver.page.evaluateOnNewDocument(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '0', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
        getBalance: () => ({value: 5000000000}),
        getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}}),
      };
    });

    // Open the SOL payment link. `?relay=` rides alongside so the loaded page keeps talking to the
    // test relay.
    const link = `/wallet/pay/${DEST_ADDR}?asset=SOL&network=solana&amount=${SEND_AMOUNT}`
      + `&label=${encodeURIComponent('Sol Merchant')}`
      + `&relay=${encodeURIComponent(relayBaseURL)}`;
    console.log('[102-sol-pay-link] opening the SOL payment link…');
    await driver.navigate(webBaseURL, link, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});

    // 1. The link selected the SOL rail for the user (no manual Balances trip).
    await driver.findByTestID('sol-send-address-input', {timeoutMs: 10_000});
    assertEq(await driver.readText('active-asset-label'), 'SOL balance',
      'the SOL link must select the SOL asset (header label "SOL balance")');

    // 2. The Send-to-address form is pre-filled with the link's destination + amount.
    const addr = await driver.eval((id) => document.querySelector(`[data-testid="${id}"]`)?.value ?? '', 'sol-send-address-input');
    assertEq(addr, DEST_ADDR, 'the send form must carry the link\'s destination address');
    const amt = await driver.eval((id) => document.querySelector(`[data-testid="${id}"]`)?.value ?? '', 'sol-send-amount-input');
    assertEq(amt, SEND_AMOUNT, 'the send form must carry the link\'s amount');
    console.log(`[102-sol-pay-link] ✓ pre-filled: ${amt} SOL → ${addr}`);

    // 3. NOTHING was sent — the payer's Confirm is still the consent, exactly as when they type the
    //    two fields by hand.
    const review = await driver.findByTestID('sol-send-review', {timeoutMs: 5_000});
    const reviewTxt = await review.evaluate((n) => (n.textContent ?? '').trim());
    assert(/0\.001005 SOL/.test(reviewTxt), `review should show 0.001005 SOL, got: "${reviewTxt}"`);
    const body = await driver.bodyText();
    assert(!/Sent/.test(body), 'a payment link must NOT auto-send — the review is the terminal state');

    // 4. Confirm → the REAL send path (local sign + broadcast through the stub).
    console.log('[102-sol-pay-link] confirming (sign + broadcast via stub)…');
    await driver.click('btn-sol-send-confirm', {timeoutMs: 5_000});
    const status = await driver.findByTestID('sol-send-outcome', {timeoutMs: 12_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/Sent/.test(statusTxt), `the sheet should show "Sent ✓", got: "${statusTxt}"`);
    console.log(`[102-sol-pay-link] ✓ ${statusTxt}`);

    await driver.screenshot('102-sol-pay-link');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[102-sol-pay-link] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[102-sol-pay-link] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
