// Flow 119 — Solana Pay ACCEPT: scan a merchant's `solana:` QR, review, pay.
//
// The emit half landed in 259bfe3 (the receive QR IS a Solana Pay URI); the accept half is this
// flow's subject: the SOL rail's camera takes a MERCHANT's Solana Pay code (`solana:<recipient>?…`,
// the open standard — amount/spl-token/reference/label/message/memo), validates it by name,
// reviews it explicitly (stranger-supplied values are NEVER auto-signed), and pays it with the
// merchant's reference keys attached to the transfer instruction (their matching mechanism) and
// the optional memo as an SPL Memo instruction.
//
// Proves end-to-end through the REAL app (all RPC stubbed, offline inner loop):
//   1. The IC rail refuses a `solana:` URI BY NAME (it can be paid, one rail over — not a shrug).
//   2. The SOL rail reviews the fixed values: amount, merchant label, message, FULL destination.
//   3. Approve → sendSolanaPay (getLatestBlockhash + sendTransaction + confirm, stubbed) → Paid
//      + the transaction signature rendered.
//   4. A spl-token (USDC) request pays via the recipient-ATA path with its rent disclosed.
//   5. Unknown params and unknown mints are refused BY NAME on the scan surface, nothing sent.
//
// Selector contract: `pay-err` (IC rail refusal), `sol-pay-scan`, `sol-pay-amount`, `sol-pay-payee`,
// `sol-spay-message`, `btn-approve`, `btn-sol-pay-cancel`, `sol-pay-status`, `sol-spay-signature`,
// `sol-spay-ata-note`, `sol-pay-err`, `btn-sol-pay-done`.
import {setup, assert, assertEq, onboardWallet, openBalances, armPayScan} from '../harness/lib.mjs';

export const meta = {
  id: '119',
  name: 'solana-pay-scan',
  journey: 'pay',
  covers: ['solana-pay', 'sol-scan', 'review', 'reference-keys', 'spl-token', 'ata', 'refusal', 'sign', 'broadcast'],
  verifies: 'Solana Pay accept: scan a merchant solana: URI → named refusals on the IC rail and for unknown params/mints → explicit review (amount/label/message/full payee) → Approve sends SOL then USDC via the recipient ATA with reference keys attached (stub RPC).',
  timeoutMs: 30000,
};

const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const REFERENCE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; // a second pubkey — the merchant's reference
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export async function run() {
  const start = Date.now();
  console.log('[119-solana-pay-scan] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[119-solana-pay-scan] onboarding…');
    await onboardWallet(driver, 'e2e-spay');

    // Install the SOL RPC stub (v2 response shapes). getBalance (5 SOL) funds the SOL payment;
    // getTokenAccountBalance (2 USDC) funds the spl-token payment; getAccountInfo reports a token
    // account so both the sender's and the merchant's USDC ATAs exist (no create leg, no rent).
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2000000', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
        getBalance: () => ({value: 5000000000}),
        getTokenAccountBalance: () => ({value: {amount: '2000000', decimals: 6, uiAmount: 2, uiAmountString: '2'}}),
      };
    });

    // 1. On the IC rail (the default after onboarding), a Solana Pay request is refused BY NAME —
    //    not paid on the wrong rail, not shrugged at: dpay CAN pay it, one rail over.
    console.log('[119-solana-pay-scan] IC rail: refusing a Solana Pay request by name…');
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), `solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}`);
    await driver.waitForText('Solana Pay', {timeoutMs: 8_000});
    const icBody = await driver.bodyText();
    assert(/Internet Computer/.test(icBody) && /Balances/.test(icBody),
      `the IC rail refusal must name the rail and the way out, got: "${icBody}"`);
    console.log('[119-solana-pay-scan] ✓ IC rail refusal names Solana Pay + the switch instruction');
    await driver.screenshot('119-spay-ic-refusal');

    // 2. Switch to the SOL rail: Balances → select SOL → Pay tab.
    console.log('[119-solana-pay-scan] switching to the SOL rail…');
    await openBalances(driver);
    await driver.findByTestID('asset-sol-select', {timeoutMs: 8_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 8_000});

    // 3. Named refusals FIRST (nothing is sent, the scan surface stays):
    console.log('[119-solana-pay-scan] SOL rail: named refusals…');
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), `solana:${MERCHANT}?amount=0.001&residual=1`);
    await driver.waitForText('residual', {timeoutMs: 8_000});
    console.log('[119-solana-pay-scan] ✓ unknown param named: residual');
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), `solana:${MERCHANT}?spl-token=${REFERENCE}`);
    await driver.waitForText(REFERENCE, {timeoutMs: 8_000});
    console.log('[119-solana-pay-scan] ✓ unknown mint named with its pubkey');

    // 4. The full review: fixed amount, merchant label, message, FULL destination — and no
    //    auto-sign (Approve is a deliberate press on stranger-supplied values).
    console.log('[119-solana-pay-scan] scanning a full merchant request…');
    await driver.eval(
      (qr) => window.__DPAY_TEST_SCAN(qr),
      `solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}&label=Coffee%20Bar&message=Order%2042`,
    );
    const amount = await driver.findByTestID('sol-pay-amount', {timeoutMs: 8_000});
    const amountTxt = await amount.evaluate((n) => (n.textContent ?? '').trim());
    assert(/0.001005 SOL/.test(amountTxt), `review should show the total debit 0.001005 SOL, got: "${amountTxt}"`);
    assertEq(await driver.readText('sol-pay-payee'), MERCHANT, 'the FULL merchant address must be on the review');
    await driver.waitForText('Coffee Bar', {timeoutMs: 5_000});
    await driver.waitForText('Order 42', {timeoutMs: 5_000});
    await driver.findByTestID('btn-approve', {timeoutMs: 5_000});
    await driver.findByTestID('btn-sol-pay-cancel', {timeoutMs: 5_000});
    console.log('[119-solana-pay-scan] ✓ review: fixed amount, label, message, full payee');
    await driver.screenshot('119-spay-review');

    // 5. Approve → sendSolanaPay (memo-less SOL transfer with the reference key attached) →
    //    Paid + signature. The balance poll (5 SOL) must land before the fee-inclusive gate
    //    opens; waitGone on the lowbal line is that wait.
    await driver.waitGone('sol-pay-lowbal', {timeoutMs: 10_000});
    console.log('[119-solana-pay-scan] approving (sign + broadcast via stub)…');
    await driver.click('btn-approve', {timeoutMs: 5_000});
    const status = await driver.findByTestID('sol-pay-status', {timeoutMs: 12_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/0\.001005 SOL/.test(statusTxt), `the outcome should name the total debited, got: "${statusTxt}"`);
    const sig = await driver.findByTestID('sol-spay-signature', {timeoutMs: 5_000});
    const sigTxt = await sig.evaluate((n) => (n.textContent ?? '').trim());
    assert(/^sig_/.test(sigTxt), `the transaction signature should be rendered, got: "${sigTxt}"`);
    console.log(`[119-solana-pay-scan] ✓ paid — ${statusTxt} (${sigTxt})`);

    // 6. The spl-token variant: the URI recipient is the merchant's WALLET; the transfer targets
    //    the derived associated token account, and its one-time rent is disclosed on the review.
    console.log('[119-solana-pay-scan] scanning a USDC (spl-token) request…');
    await driver.click('btn-sol-pay-done', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 8_000});
    await armPayScan(driver);
    await driver.eval(
      (qr) => window.__DPAY_TEST_SCAN(qr),
      `solana:${MERCHANT}?spl-token=${USDC_MINT}&amount=1.5&reference=${REFERENCE}`,
    );
    const usdcAmount = await driver.findByTestID('sol-pay-amount', {timeoutMs: 8_000});
    const usdcTxt = await usdcAmount.evaluate((n) => (n.textContent ?? '').trim());
    assert(/1\.5 USDC/.test(usdcTxt), `the spl-token review should show 1.5 USDC, got: "${usdcTxt}"`);
    await driver.findByTestID('sol-spay-ata-note', {timeoutMs: 5_000});
    console.log('[119-solana-pay-scan] ✓ USDC review with the ATA rent disclosed');
    await driver.waitGone('sol-pay-lowbal', {timeoutMs: 10_000});
    await driver.click('btn-approve', {timeoutMs: 5_000});
    const usdcStatus = await driver.findByTestID('sol-pay-status', {timeoutMs: 12_000});
    const usdcStatusTxt = await usdcStatus.evaluate((n) => (n.textContent ?? '').trim());
    assert(/1\.5 USDC/.test(usdcStatusTxt), `the USDC outcome should name the paid amount, got: "${usdcStatusTxt}"`);
    console.log(`[119-solana-pay-scan] ✓ USDC paid — ${usdcStatusTxt}`);
    await driver.screenshot('119-spay-usdc-paid');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[119-solana-pay-scan] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[119-solana-pay-scan] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
