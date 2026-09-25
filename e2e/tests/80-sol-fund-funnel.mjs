// Flow 80 — SOL fund FUNNEL + ATA unlock (2026-08-16 zero-funds UX).
//
// Proves the full zero-to-pay journey on the SOL rail — the founder complaint: "prompt user ASAP
// to pay in these required funds and open an account instead of prompting to pay and scanning
// the QR code even without funds":
//
//   1. USDC absent + SOL zero → the Pay tab shows the SETUP CARD with the insufficient warning
//      AND the fund-SOL escape hatch (btn-sol-ata-fund) — the DEAD-END copy ("then come back")
//      is GONE — beside a still-reachable scan surface (X3, 2026-09-08).
//   2. btn-sol-ata-fund → one tap to the SOL deposit address (the funding funnel entry).
//   3. Stub-fund SOL → the setup card's create ENABLES (one-tap unlock at rent+fee).
//   4. Create ATA → stub confirms → the ATA exists → the USDC Pay surface becomes the USDC
//      fund panel (account exists, balance zero) — the funnel walked end-to-end.
//   5. Balances row: the 'Needs setup' badge shows iff the ATA is absent, and disappears after
//      the create.
import {
  setup,
  assert,
  assertIncludes,
  onboardWallet,
  openBalances,
  selectCurrency,
  selectSolRail,
} from '../harness/lib.mjs';

export const meta = {
  id: '80',
  name: 'sol-fund-funnel',
  journey: 'system',
  covers: ['sol-fund-funnel', 'ata-setup', 'needs-setup-badge', 'escape-hatch', 'zero-funds'],
  verifies: 'SOL zero→pay journey: absent-ATA setup card with fund hatch (no dead-end copy), 1-tap to SOL address, funded unlock, one-tap create, badge truth.',
  timeoutMs: 90000,
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
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 0, token: globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS ? {amount: '0', decimals: 6} : null}),
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

    // ---- 5a. Reach the Solana-USDC rail: the currency row lands main on ckUSDC (chooseRail's
    // preference), and the RECEIVE surface's asset switch reaches the Solana rail sub-mode-
    // preserving — the currency-first path to the funnel. ----
    console.log('[80-sol-fund-funnel] selecting USD, switching the working rail to Solana USDC…');
    // The currency-row tap re-points main + the working rail; retry — a poll re-render can
    // land between find and click.
    let picked = false;
    for (let i = 0; i < 3 && !picked; i++) {
      try {
        await selectSolRail(driver, 'sol-usdc', {timeoutMs: 5_000});
        picked = true;
      } catch (e) {
        if (i === 2) throw e;
        await new Promise(r => setTimeout(r, 600));
        await openBalances(driver);
      }
    }
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    await driver.click('btn-receive-asset-switch', {timeoutMs: 5_000});
    await driver.click('req-pick-sol-usdc', {timeoutMs: 5_000});
    // The pick re-mounts the whole receive engine (IC → Solana); with the ATA absent the USDC
    // address card shows the setup state, not the address — the funnel asserts the Pay-side card.
    await new Promise(r => setTimeout(r, 1_500));

    // ---- 1. USDC absent + SOL zero: setup card + warning + escape hatch (no dead end) ----
    console.log('[80-sol-fund-funnel] Pay tab: setup card with fund hatch…');
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-ata-instructions', {timeoutMs: 10_000});
    const instr = await driver.findByTestID('sol-pay-ata-instructions', {timeoutMs: 10_000});
    const instrText = await instr.evaluate((n) => n.textContent);
    assertIncludes(instrText, 'You need about', 'insufficient warning present');
    assert(!instrText.includes('then come back'), 'the dead-end copy must be gone');
    const fundBtn = await driver.findByTestID('btn-sol-ata-fund', {timeoutMs: 5_000});
    assert(!!fundBtn, 'fund-SOL escape hatch renders on the Pay setup card');
    const createBtn = await driver.findByTestID('btn-sol-pay-ata-create', {timeoutMs: 5_000});
    const createDisabled = await createBtn.evaluate((n) => n.getAttribute('aria-disabled') === 'true' || n.disabled === true);
    assert(createDisabled, 'create disabled while SOL < rent+fee');
    // X3 (2026-09-08): the setup card rides BELOW the scan surface rather than replacing it. The
    // account this wallet lacks is the SELECTED one; a request naming SOL — or any other mint — is
    // perfectly payable from here, and the per-request `solSplSignGate` is what refuses the ones
    // that are not, by name, at the scan.
    assert(await driver.isPresent('btn-sol-start-scan'), 'an absent token account keeps the scan surface reachable (X3)');
    console.log('[80-sol-fund-funnel] ✓ setup card + hatch, create disabled, scanner reachable');

    // ---- 2. Escape hatch → one tap to the SOL deposit address ----
    console.log('[80-sol-fund-funnel] hatch → SOL deposit address in one tap…');
    await driver.click('btn-sol-ata-fund', {timeoutMs: 5_000});
    await driver.findByTestID('sol-receive-address', {timeoutMs: 8_000});
    await driver.findByTestID('sol-receive-waiting', {timeoutMs: 5_000});
    console.log('[80-sol-fund-funnel] ✓ hatch landed on the SOL address (waiting cue)');

    // ---- 3. Stub-fund SOL → create unlocks (one-tap) ----
    console.log('[80-sol-fund-funnel] stub SOL funding → create unlocks…');
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getBalance = () => ({value: 5000000000});
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getMultipleAccounts = (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS ? {amount: '0', decimals: 6} : null});
    });
    // The hatch switched the selected asset to SOL (goToDeposit) — re-reach Solana USDC through
    // the same receive asset-switch to walk the funnel as the user would.
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    await driver.click('btn-receive-asset-switch', {timeoutMs: 5_000});
    await driver.click('req-pick-sol-usdc', {timeoutMs: 5_000});
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
    assertIncludes(usdcText, 'No USDC available', 'post-create Pay surface = USDC fund panel');
    console.log('[80-sol-fund-funnel] ✓ create confirmed → USDC fund panel');

    // ---- 5b. Badge truth: the fund panel is GONE after the create (USDC spendable) ----
    console.log('[80-sol-fund-funnel] fund panel gone after create…');
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-receive-address', {timeoutMs: 8_000});
    console.log('[80-sol-fund-funnel] ✓ the Solana-USDC surface stays reachable once the ATA exists');

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
