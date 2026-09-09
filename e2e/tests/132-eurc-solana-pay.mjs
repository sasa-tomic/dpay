// Flow 132 — paying EURC through the per-token solana engine (Stage 3 payoff, pinned here).
//
// The solana engine speaks ANY catalogued SPL token (commit b2f3998): with home=EUR the wallet
// sits on the EURC rail, and a scanned `solana:` URI naming EURC's mint pays EURC — the review
// NAMES the token it will move (1.500000 EURC, 6 decimals), the full payee, and the ATA rent —
// and Approve completes with the amount restated in EURC. The refusal half is the honesty gate:
// a mint that is NOT in the catalog is refused BY NAME with its pubkey, never guessed at, never
// silently routed to another token.
import {
  setup, assert, assertEq, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent,
  armPayScan,
 waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '132',
  name: 'eurc-solana-pay',
  journey: 'pay',
  covers: ['solana-pay', 'eur', 'eurc', 'scan', 'refusal', 'fees'],
  verifies: 'home=EUR on the EURC rail: a scanned solana: URI naming EURC\'s mint reviews and pays EURC (named token, own 6 decimals, ATA rent disclosed); a non-catalog mint is refused BY NAME with its pubkey.',
  timeoutMs: 30000,
};

const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const REFERENCE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrzZDsGYdLVL9zYtAWWM'; // a second pubkey — the merchant's reference
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'; // Circle's native EURC on mainnet (6 dec)

export async function run() {
  const start = Date.now();
  console.log('[132-eurc-solana-pay] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // Onboard with home=EUR — the wallet lands on the EURC rail (the stated preference).
    console.log('[132-eurc-solana-pay] onboarding with home=EUR…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-eurc-pay', {timeoutMs: 8_000});
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup');
    await driver.click('mnemonic-backup-checkbox');
    await waitForEnabled(driver, 'btn-mnemonic-continue');
    await driver.click('btn-mnemonic-continue');
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title');
    await driver.click('home-currency-EUR');
    await driver.click('btn-home-currency-continue');
    await waitForWallet(driver, {timeoutMs: 10_000});
    // The wallet lands on HOME, and Home states the chosen currency in its own headline — the
    // header chip is not rendered there (it names the SELECTION, which is a different fact; see
    // flow 158). `home-headline-label` is the currency statement on this surface.
    const label = await driver.readText('home-headline-label');
    assertIncludes(label, 'uros', 'home=EUR names the currency in the header');

    // The SOL RPC simulator (same seam as flow 119): 5 SOL for fees, 2 units (6 dec) of the
    // requested token, token accounts present so sender and merchant ATAs exist — no create leg.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2000000', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
        // This flow pays via the SENDER path (sendSolanaPay → confirmTransaction v1) which never
        // re-reads the tx. The stub entry exists so the settle gate FAILS LOUD if that ever
        // changes — no detail is seeded here (there is no captured solpay to derive one from).
        getTransaction: () => globalThis.__DPAY_TEST_SOL_TX_DETAIL ?? null,
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
        getBalance: () => ({value: 5000000000}),
        getTokenAccountBalance: () => ({value: {amount: '2000000', decimals: 6, uiAmount: 2, uiAmountString: '2'}}),
      };
    });

    // 1. A non-catalog mint is refused BY NAME, with its pubkey — before anything is paid.
    console.log('[132-eurc-solana-pay] unknown mint: named refusal first…');
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 8_000});
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), `solana:${MERCHANT}?spl-token=${REFERENCE}&amount=1.5`);
    await driver.waitForText(REFERENCE, {timeoutMs: 8_000});
    console.log('[132-eurc-solana-pay] ✓ non-catalog mint named with its pubkey');

    // 2. The EURC request: the review NAMES the token it will move, in EURC's own 6 decimals.
    console.log('[132-eurc-solana-pay] scanning an EURC request…');
    await armPayScan(driver);
    await driver.eval(
      (qr) => window.__DPAY_TEST_SCAN(qr),
      `solana:${MERCHANT}?spl-token=${EURC_MINT}&amount=1.5&reference=${REFERENCE}&label=Kaffeestation&message=Bestellung%2042`,
    );
    const amount = await driver.findByTestID('sol-pay-amount', {timeoutMs: 8_000});
    const amountTxt = await amount.evaluate((n) => (n.textContent ?? '').trim());
    assert(/1\.500000 EURC/.test(amountTxt), `the review should name 1.500000 EURC, got: "${amountTxt}"`);
    assertEq(await driver.readText('sol-pay-payee'), MERCHANT, 'the FULL merchant address must be on the review');
    await driver.waitForText('Kaffeestation', {timeoutMs: 5_000});
    await driver.findByTestID('sol-spay-ata-note', {timeoutMs: 5_000});
    console.log('[132-eurc-solana-pay] ✓ review: EURC named with its mint-backed decimals, full payee, ATA rent');
    await driver.screenshot('132-eurc-review');

    // 3. Approve → the EURC transfer completes; the outcome restates the amount in EURC.
    await driver.waitGone('sol-pay-lowbal', {timeoutMs: 10_000});
    await driver.click('btn-approve', {timeoutMs: 5_000});
    const status = await driver.findByTestID('sol-pay-status', {timeoutMs: 12_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/1\.500000 EURC/.test(statusTxt), `the outcome should name the paid EURC amount, got: "${statusTxt}"`);
    const sig = await driver.findByTestID('sol-spay-signature', {timeoutMs: 5_000});
    const sigTxt = await sig.evaluate((n) => (n.textContent ?? '').trim());
    assert(/^sig_/.test(sigTxt), `the transaction signature should be rendered, got: "${sigTxt}"`);
    console.log(`[132-eurc-solana-pay] ✓ paid — ${statusTxt} (${sigTxt})`);
    await driver.screenshot('132-eurc-paid');

    console.log(`[132-eurc-solana-pay] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[132-eurc-solana-pay] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
