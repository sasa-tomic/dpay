// Flow 79 — SOL fund-first Pay gate (2026-08-16 zero-funds UX).
//
// Proves the Pay-tab zero-funds gate on the SOL rail, driven through the REAL app against the
// Solana RPC stub seam:
//
//   1. SOL known-zero      → the fund-first panel (sol-pay-fund) rides BELOW a still-reachable
//                            scan surface (X3, 2026-09-08 — it used to replace it, which stopped
//                            a payer reading a request naming an asset they actually held).
//   2. funnel              → one tap on sol-pay-fund-go lands on the SOL deposit address QR
//                            (Receive → My address — the ONE funding surface, no inline dupe).
//   3. auto-release        → stub getBalance flips to positive; within one poll the panel
//                            disappears and the live scanner (sol-pay-scan) returns — no user
//                            action, no reload (the poll IS the release).
//   4. fail-open           → stub getBalance errors / RPC unavailable: the scanner stays live
//                            (offline-first — an unknown balance never gates).
//   5. USDC zero (balance) → same panel with the USDC copy + Show-my-SOL-address secondary.
import {setup, assert, assertIncludes, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '79',
  name: 'sol-fund-first-pay',
  journey: 'system',
  covers: ['sol-fund-first', 'pay-gate', 'nfc-disarm', 'fail-open', 'zero-funds'],
  verifies: 'SOL Pay tab: known-zero → fund panel replaces scanner+NFC, 1-tap to deposit QR, auto-release on funding, fail-open on unknown.',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[79-sol-fund-first-pay] setup (relay + web + browser)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[79-sol-fund-first-pay] onboarding to seed a device identity…');
    await onboardWallet(driver, 'e2e-sol-fund');

    // Stub: SOL balance KNOWN ZERO, USDC ATA present with zero (for step 5).
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS = true;
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 0, token: {amount: '0', decimals: 6}}),
        getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '1'.repeat(32), lastValidBlockHeight: 999999}}),
        getBalance: () => ({value: 0}),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
        getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'SigE2E',
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
      };
    });

    console.log('[79-sol-fund-first-pay] selecting solana:SOL as the active asset…');
    await openBalances(driver);
    await driver.click('asset-sol-select', {timeoutMs: 5_000});

    // ---- 1. KNOWN-ZERO: the fund panel replaces the scanner + NFC ----
    console.log('[79-sol-fund-first-pay] known-zero: fund panel replaces the scanner…');
    await driver.findByTestID('tab-pay', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    const panel = await driver.findByTestID('sol-pay-fund', {timeoutMs: 10_000});
    const panelText = await panel.evaluate((n) => n.textContent);
    assertIncludes(panelText, 'No SOL available', 'gate headline');
    assertIncludes(panelText, 'Show my SOL address', 'primary deposit action');
    // X3 (2026-09-08): the panel rides BELOW the scan surface instead of replacing it. A
    // `solreq:v2` names its OWN currency and mint, so the selected balance cannot decide whether a
    // request is readable — the funding funnel keeps its entry and the lens stays one tap away.
    assert(await driver.isPresent('btn-sol-start-scan'), 'the scan surface stays reachable on a zero balance (X3)');
    const camLeak = await driver.eval(() => !!document.querySelector('[data-testid="scan-cam-box"]'));
    assert(!camLeak, 'the camera itself still waits for the Pay Now press (pay-intent gate)');
    console.log('[79-sol-fund-first-pay] ✓ gate panel shown BESIDE a reachable scan surface');

    // ---- 2. FUNNEL: one tap lands on the deposit address QR ----
    console.log('[79-sol-fund-first-pay] one tap → deposit address QR…');
    await driver.click('sol-pay-fund-go', {timeoutMs: 5_000});
    await driver.findByTestID('sol-receive-address', {timeoutMs: 8_000});
    await driver.findByTestID('sol-receive-qr', {timeoutMs: 5_000});
    const addr = await driver.readText('sol-receive-address');
    assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr), `deposit address must be base58, got "${addr}"`);
    // The waiting cue is honest on a KNOWN-zero balance (checks every few seconds).
    await driver.findByTestID('sol-receive-waiting', {timeoutMs: 5_000});
    console.log('[79-sol-fund-first-pay] ✓ 1-tap funnel: address QR + waiting cue');

    // ---- 3. AUTO-RELEASE: stub funding flips the panel away within one poll ----
    console.log('[79-sol-fund-first-pay] stub funding → panel auto-releases…');
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-fund', {timeoutMs: 5_000});
    // RESUME-FUNNEL EXTENSION (UX review r2 finding 3): re-fire the 1-tap funnel FROM THE USDC
    // PAY TAB (origin remembered), fund SOL, and assert the "Back to paying USDC" resume link
    // appears on My-address and returns to the USDC Pay tab in one tap.
    await openBalances(driver);
    await driver.click('asset-sol-usdc-select', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-fund', {timeoutMs: 10_000});
    // "Show my SOL address" secondary on the USDC panel carries the USDC origin.
    await driver.click('sol-pay-fund-sol', {timeoutMs: 5_000});
    await driver.findByTestID('sol-receive-address', {timeoutMs: 8_000});
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getBalance = () => ({value: 5000000000});
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getMultipleAccounts = (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '0', decimals: 6}});
    });
    const resume = await driver.findByTestID('btn-sol-receive-return', {timeoutMs: 15_000});
    const resumeText = await resume.evaluate((n) => n.textContent);
    assertIncludes(resumeText, 'Back to paying USDC', 'resume link copy');
    await driver.click('btn-sol-receive-return', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-fund', {timeoutMs: 10_000});
    const backPanel = await driver.findByTestID('sol-pay-fund', {timeoutMs: 5_000});
    const backText = await backPanel.evaluate((n) => n.textContent);
    assertIncludes(backText, 'No USDC available', 'resume landed on the USDC Pay tab');
    console.log('[79-sol-fund-first-pay] ✓ resume funnel: USDC origin → SOL deposit → back to USDC pay');
    // Now the plain zero→scan release from the SOL rail (original invariant).
    await openBalances(driver);
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 15_000});
    await driver.waitGone('sol-pay-fund', {timeoutMs: 5_000});
    console.log('[79-sol-fund-first-pay] ✓ funding auto-released the gate (poll-driven)');

    // ---- 4. FAIL-OPEN: error status keeps the scanner live ----
    console.log('[79-sol-fund-first-pay] RPC error → scanner stays live (fail-open)…');
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getBalance = () => { throw new Error('rpc down'); };
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getMultipleAccounts = () => { throw new Error('rpc down'); };
    });
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 10_000});
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getBalance = () => ({value: 0});
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getMultipleAccounts = (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 0, token: {amount: '0', decimals: 6}});
    });
    await driver.findByTestID('sol-pay-fund', {timeoutMs: 15_000});
    console.log('[79-sol-fund-first-pay] ✓ error failed open, zero re-gated');

    // ---- 5. USDC ZERO: same panel, USDC copy + SOL-address secondary ----
    console.log('[79-sol-fund-first-pay] USDC zero: panel + SOL-address secondary…');
    await openBalances(driver);
    await driver.click('asset-sol-usdc-select', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    const usdcPanel = await driver.findByTestID('sol-pay-fund', {timeoutMs: 10_000});
    const usdcText = await usdcPanel.evaluate((n) => n.textContent);
    assertIncludes(usdcText, 'No USDC available', 'USDC gate headline');
    assertIncludes(usdcText, 'Show my USDC address', 'USDC deposit primary');
    assertIncludes(usdcText, 'Show my SOL address', 'SOL-address secondary (fees note pair)');
    assert(await driver.isPresent('btn-sol-start-scan'), 'a USDC zero keeps the scan surface reachable too (X3)');
    console.log('[79-sol-fund-first-pay] ✓ USDC zero panel with SOL secondary, scanner reachable');

    await driver.screenshot('79-sol-fund-first-pay');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[79-sol-fund-first-pay] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/79-sol-fund-first-pay.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[79-sol-fund-first-pay] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
