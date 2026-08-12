// Flow 52 — SOL withdraw (SolanaWithdrawSheet, inline in the Pay tab).
//
// The SOL withdraw sheet (8KB component) had ZERO e2e coverage before this flow. Its local signing
// is byte-exact vs @solana/web3.js (proven in jest), but the UI submit/confirm/done phases were only
// covered by mirror (WithdrawSheet). This flow drives the REAL SolanaWithdrawSheet through the stub
// RPC via the SAME tab IA every IC currency uses (no per-currency exception): Balances → select SOL
// → Pay tab → "Send to address" sub-mode (the pay-mode-toggle right segment) → enter addr+amount →
// Send → "Sent ✓" + signature.
//
// Proves end-to-end through the REAL app:
//   1. SOL is selectable in Balances (whole-row select, uniform with IC — no per-row Send button).
//   2. The Pay tab "Send to address" toggle surfaces the SolanaWithdrawSheet body INLINE in the tab.
//   3. Entering a valid address + amount surfaces the review card.
//   4. Confirm → sendSol (getLatestBlockhash + sendTransaction + confirm, all stubbed) → "Sent ✓".
//   5. The transaction signature is rendered + the success state is reachable.
//
// Selector contract: `asset-sol-select`, `tab-pay`, `btn-pay-send`, `sol-send-address-input`,
// `sol-send-amount-input`, `sol-send-review`, `sol-send-review-amount`, `btn-sol-send-confirm`,
// `sol-send-status`, `sol-send-signature`.
import {setup, assert, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '52',
  name: 'sol-withdraw',
  journey: 'withdraw',
  covers: ['sol-withdraw', 'sol-send', 'sol-tab-ia', 'sign'],
  verifies: 'SOL withdraw: select SOL → Pay tab "Send to address" → enter addr+amount → sign+broadcast (stub) → Sent ✓.',
  timeoutMs: 25000,
};

const DEST_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const SEND_AMOUNT = '0.001'; // 0.001 SOL = 1_000_000 lamports

export async function run() {
  const start = Date.now();
  console.log('[52-sol-withdraw] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[52-sol-withdraw] onboarding…');
    await onboardWallet(driver, 'e2e-sol-send');

    // Install the SOL RPC stub (v2 response shapes — context:{slot} wrappers). sendSol needs:
    // getLatestBlockhash, sendTransaction, confirmTransaction (getSignatureStatuses). getBalance
    // (5 SOL) is polled by useSolanaBalance → funds the inline send. getTokenAccountBalance silences
    // the USDC balance poll (returns empty — no USDC ATA).
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
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

    // 1. Open Balances → select SOL as the active asset (whole-row select, uniform with IC). The
    //    stub funds the SOL balance to 5 SOL, but that no longer gates a per-row Send button — the
    //    send surface lives in the Pay tab now.
    console.log('[52-sol-withdraw] opening Balances; selecting SOL…');
    await openBalances(driver);
    await driver.findByTestID('asset-sol-select', {timeoutMs: 8_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.waitGone('btn-balances-close', {timeoutMs: 5_000});

    // 2. Switch to the Pay tab. SolPayMode mounts; its mount effect reads the seeded nonce →
    //    phase='scan' (the scan screen, not the setup gate).
    console.log('[52-sol-withdraw] switching to the Pay tab (scan phase via seeded nonce)…');
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('pay-mode-toggle', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 8_000});

    // Back-toggle regression (Rules of Hooks): SolPayMode's early return for the 'send' sub-mode
    // MUST sit below its useState calls. We verify toggling send→scan→send preserves the component
    // state (the scan screen stays mounted, the send inputs come and go cleanly).
    await driver.click('btn-pay-send', {timeoutMs: 5_000});
    await driver.findByTestID('sol-send-address-input', {timeoutMs: 5_000});
    await driver.click('btn-pay-scan', {timeoutMs: 5_000});
    await driver.waitGone('sol-send-address-input', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 8_000});
    console.log('[52-sol-withdraw] ✓ scan phase preserved across the send detour (no hook-order reset)');

    // 3. Re-open "Send to address" + enter the destination address + amount.
    await driver.click('btn-pay-send', {timeoutMs: 5_000});
    await driver.findByTestID('sol-send-address-input', {timeoutMs: 5_000});
    await driver.type('sol-send-address-input', DEST_ADDR, {timeoutMs: 4_000});
    await driver.type('sol-send-amount-input', SEND_AMOUNT, {timeoutMs: 4_000});

    // 4. The review card appears once a valid amount is entered.
    const review = await driver.findByTestID('sol-send-review', {timeoutMs: 4_000});
    const reviewTxt = await review.evaluate((n) => (n.textContent ?? '').trim());
    assert(/0\.001000000 SOL/.test(reviewTxt), `review should show 0.001000000 SOL, got: "${reviewTxt}"`);
    console.log(`[52-sol-withdraw] ✓ review: ${reviewTxt}`);

    // 5. Confirm → sendSol signs locally + broadcasts via the stub → "Sent ✓".
    console.log('[52-sol-withdraw] confirming (sign + broadcast via stub)…');
    await driver.click('btn-sol-send-confirm', {timeoutMs: 5_000});

    // 6. Assert the success state.
    const status = await driver.findByTestID('sol-send-status', {timeoutMs: 12_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/Sent/.test(statusTxt), `the sheet should show "Sent ✓", got: "${statusTxt}"`);
    console.log(`[52-sol-withdraw] ✓ ${statusTxt}`);
    const sig = await driver.findByTestID('sol-send-signature', {timeoutMs: 5_000});
    const sigTxt = await sig.evaluate((n) => (n.textContent ?? '').trim());
    assert(/^sig_/.test(sigTxt), `the sent signature should be rendered, got: "${sigTxt}"`);
    console.log(`[52-sol-withdraw] ✓ signature: ${sigTxt}`);

    await driver.screenshot('52-sol-withdraw');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[52-sol-withdraw] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[52-sol-withdraw] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
