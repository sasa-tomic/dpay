// Flow 80 — SOL fund FUNNEL + ATA unlock (2026-08-16 zero-funds UX).
//
// Proves the full zero-to-pay journey on the SOL rail — the founder complaint: "prompt user ASAP
// to pay in these required funds and open an account instead of prompting to pay and scanning
// the QR code even without funds":
//
//   1. USDC absent + SOL zero → the Pay tab shows the SETUP CARD with the insufficient warning
//      AND the fund-SOL escape hatch (btn-sol-ata-fund) — the DEAD-END copy ("then come back")
//      is GONE.
//   2. btn-sol-ata-fund → one tap to the SOL deposit address (the funding funnel entry).
//   3. Stub-fund SOL → the setup card's create ENABLES (one-tap unlock at rent+fee).
//   4. Create ATA → stub confirms → the ATA exists → the USDC Pay surface becomes the USDC
//      fund panel (account exists, balance zero) — the funnel walked end-to-end.
//   5. Balances row: the 'Needs setup' badge shows iff the ATA is absent, and disappears after
//      the create.
import {setup, assert, assertIncludes, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '80',
  name: 'sol-fund-funnel',
  journey: 'system',
  covers: ['sol-fund-funnel', 'ata-setup', 'needs-setup-badge', 'escape-hatch', 'zero-funds'],
  verifies: 'SOL zero→pay journey: absent-ATA setup card with fund hatch (no dead-end copy), 1-tap to SOL address, funded unlock, one-tap create, badge truth.',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[80-sol-fund-funnel] setup (relay + web + browser)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[80-sol-fund-funnel] onboarding to seed a device identity…');
    await onboardWallet(driver, 'e2e-sol-funnel');

    // Stub: ATA ABSENT + SOL ZERO — the founder's exact starting state.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS = false;
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '1'.repeat(32), lastValidBlockHeight: 999999}}),
        getBalance: () => ({value: 0}),
        getAccountInfo: () => ({value: globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS
          ? {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}
          : null}),
        getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'SigAtaE2E',
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
      };
    });

    // ---- 5a. Badge truth: absent ATA → 'Needs setup' on the Balances USDC row ----
    console.log('[80-sol-fund-funnel] Balances: Needs-setup badge on absent USDC row…');
    await openBalances(driver);
    const badge = await driver.findByTestID('asset-sol-usdc-badge', {timeoutMs: 10_000});
    const badgeText = await badge.evaluate((n) => n.textContent);
    assertIncludes(badgeText, 'Needs setup', 'badge copy');

    // ---- 1. USDC absent + SOL zero: setup card + warning + escape hatch (no dead end) ----
    console.log('[80-sol-fund-funnel] selecting USDC; setup card with fund hatch…');
    await driver.click('asset-sol-usdc-select', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    const instr = await driver.findByTestID('sol-pay-ata-instructions', {timeoutMs: 10_000});
    const instrText = await instr.evaluate((n) => n.textContent);
    assertIncludes(instrText, 'You need about', 'insufficient warning present');
    assert(!instrText.includes('then come back'), 'the dead-end copy must be gone');
    const fundBtn = await driver.findByTestID('btn-sol-ata-fund', {timeoutMs: 5_000});
    assert(!!fundBtn, 'fund-SOL escape hatch renders on the Pay setup card');
    const createBtn = await driver.findByTestID('btn-sol-pay-ata-create', {timeoutMs: 5_000});
    const createDisabled = await createBtn.evaluate((n) => n.getAttribute('aria-disabled') === 'true' || n.disabled === true);
    assert(createDisabled, 'create disabled while SOL < rent+fee');
    const scannerLeak = await driver.eval(() => !!document.querySelector('[data-testid="sol-pay-scan"]'));
    assert(!scannerLeak, 'no scanner while the USDC account is absent');
    console.log('[80-sol-fund-funnel] ✓ setup card + hatch, create disabled, no scanner');

    // ---- 2. Escape hatch → one tap to the SOL deposit address ----
    console.log('[80-sol-fund-funnel] hatch → SOL deposit address in one tap…');
    await driver.click('btn-sol-ata-fund', {timeoutMs: 5_000});
    await driver.findByTestID('sol-receive-address', {timeoutMs: 8_000});
    await driver.findByTestID('sol-receive-waiting', {timeoutMs: 5_000});
    console.log('[80-sol-fund-funnel] ✓ hatch landed on the SOL address (waiting cue)');

    // ---- 3. Stub-fund SOL → create unlocks (one-tap) ----
    console.log('[80-sol-fund-funnel] stub SOL funding → create unlocks…');
    await driver.eval(() => { globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getBalance = () => ({value: 5000000000}); });
    // The hatch switched the selected asset to SOL (goToDeposit) — re-select USDC to walk the
    // funnel as the user would (Balances → USDC → Pay).
    await openBalances(driver);
    await driver.click('asset-sol-usdc-select', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    const createBtn2 = await driver.findByTestID('btn-sol-pay-ata-create', {timeoutMs: 10_000});
    await driver.waitGone('sol-ata-insufficient', {timeoutMs: 10_000});
    const createEnabled = await createBtn2.evaluate((n) => !(n.getAttribute('aria-disabled') === 'true' || n.disabled === true));
    assert(createEnabled, 'create must unlock once SOL ≥ rent+fee');
    console.log('[80-sol-fund-funnel] ✓ funded → create enabled');

    // ---- 4. Create → confirmed → USDC Pay becomes the USDC fund panel ----
    console.log('[80-sol-fund-funnel] one-tap create → USDC fund panel…');
    await driver.eval(() => {
      const orig = globalThis.__DPAY_TEST_SOLANA_RPC_STUB.sendTransaction;
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.sendTransaction = (tx) => {
        globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS = true;
        return orig(tx);
      };
    });
    await driver.click('btn-sol-pay-ata-create', {timeoutMs: 5_000});
    const usdcPanel = await driver.findByTestID('sol-pay-fund', {timeoutMs: 15_000});
    const usdcText = await usdcPanel.evaluate((n) => n.textContent);
    assertIncludes(usdcText, 'Add USDC to pay', 'post-create Pay surface = USDC fund panel');
    console.log('[80-sol-fund-funnel] ✓ create confirmed → USDC fund panel');

    // ---- 5b. Badge truth: badge GONE after the create ----
    console.log('[80-sol-fund-funnel] Balances: badge gone after create…');
    await openBalances(driver);
    await driver.waitGone('asset-sol-usdc-badge', {timeoutMs: 10_000});
    console.log('[80-sol-fund-funnel] ✓ badge disappeared once the ATA exists');

    await driver.screenshot('80-sol-fund-funnel');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[80-sol-fund-funnel] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/80-sol-fund-funnel.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[80-sol-fund-funnel] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
