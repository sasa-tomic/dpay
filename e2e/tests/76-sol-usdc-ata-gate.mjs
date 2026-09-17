// Flow 76 — Solana USDC ATA gate tri-state (receive surfaces, 2026-08-14 audit fix).
//
// Proves the USDC receive gate NEVER makes a false claim about the device's USDC account, across
// the full status matrix, using the REAL app against the e2e Solana RPC stub seam:
//
//   1. absent    → "My address" shows the ONE-TAP SETUP CARD (btn-sol-ata-create) instead of the
//                  address QR, AND the request form shows the inline setup card with Request
//                  BLOCKED (a doomed USDC request must not be creatable — the payer would sign a
//                  transferChecked to a non-existent account; broadcast fails after they leave).
//   2. absent + insufficient SOL → sol-ata-insufficient warning, create DISABLED (honest cost).
//   3. absent + funded → create ENABLED; clicking it runs the REAL createUsdcAta broadcast path
//                  (stubbed RPC: one createIdempotent ix, confirmed) — on success the poll flips
//                  status → balance and the ADDRESS QR APPEARS (the honest happy path end-to-end).
//   4. balance   → direct: address QR renders, no gate.
//
// The stub seam (__DPAY_TEST_SOLANA_RPC_STUB) routes all RPC through an in-memory simulator —
// the inner loop stays fully offline. getAccountInfo null/absent ↔ funded token account flips the
// ATA status exactly as production's getSolanaUsdcBalance does.
import {setup, assert, assertIncludes, assertEq, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '76',
  name: 'sol-usdc-ata-gate',
  journey: 'system',
  covers: ['sol-usdc', 'ata-gate', 'tri-state', 'ata-setup-card', 'request-block', 'ata-create'],
  verifies: 'USDC receive gate: absent→setup card + Request blocked; insufficient→disabled; funded→one-tap create flips to the address QR; balance→direct address.',
  timeoutMs: 90000,
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export async function run() {
  const start = Date.now();
  console.log('[76-sol-usdc-ata-gate] setup (relay + web + browser)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[76-sol-usdc-ata-gate] onboarding to seed a device identity…');
    await onboardWallet(driver, 'e2e-sol-usdc-ata');

    // The stub: USDC ATA ABSENT (getAccountInfo → null), SOL balance FUNDED (5 SOL — enough for
    // the create). accountExists/getTokenAccountBalance ride the same seam. State is mutable so
    // step 3 can flip the ATA to present after the successful create.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS = false;
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS ? {amount: '0', decimals: 6} : null}),
        getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '1'.repeat(32), lastValidBlockHeight: 999999}}),
        getBalance: () => ({value: 5000000000}),
        getAccountInfo: () => ({value: globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS
          ? {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}
          : null}),
        getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'SigAtaE2E',
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
      };
    });

    console.log('[76-sol-usdc-ata-gate] selecting solana:USDC as the active asset…');
    await openBalances(driver);
    await driver.click('asset-sol-usdc-select', {timeoutMs: 5_000});

    // ---- 1. ABSENT: the request form shows the inline setup card and Request is BLOCKED ----
    console.log('[76-sol-usdc-ata-gate] request form: inline setup card + Request blocked…');
    await driver.findByTestID('tab-receive', {timeoutMs: 5_000});
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('btn-sol-req-ata-create', {timeoutMs: 8_000});
    const reqBtn = await driver.findByTestID('btn-sol-req-make', {timeoutMs: 5_000});
    const reqDisabled = await reqBtn.evaluate((n) => n.getAttribute('aria-disabled') === 'true' || n.disabled === true);
    assert(reqDisabled, 'Request must be disabled when the device USDC ATA is known absent (doomed request)');
    console.log('[76-sol-usdc-ata-gate] ✓ Request blocked + inline setup card on the request form');

    // ---- 2. ABSENT: "My address" shows the setup card, NOT the address ----
    console.log('[76-sol-usdc-ata-gate] My address: setup card replaces the QR…');
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    await driver.findByTestID('btn-sol-ata-create', {timeoutMs: 8_000});
    const leakedAddr = await driver.eval(() => !!document.querySelector('[data-testid="sol-receive-address"]'));
    assert(!leakedAddr, 'the USDC ATA address must NOT render when the ATA is known absent');
    const insufficient = await driver.eval(() => !!document.querySelector('[data-testid="sol-ata-insufficient"]'));
    assert(!insufficient, 'no insufficient-SOL warning when SOL is funded (5 SOL > rent+fee)');
    console.log('[76-sol-usdc-ata-gate] ✓ setup card (funded) — no address leak, no false warning');

    // ---- 3. INSUFFICIENT: drop SOL below rent+fee → warning + create DISABLED ----
    console.log('[76-sol-usdc-ata-gate] insufficient SOL: warning + disabled create…');
    // Two readers, one wallet: the balance POLL reads accounts in one getMultipleAccounts, the
    // create's rent pre-check reads getBalance directly. Moving the SOL moves both.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getBalance = () => ({value: 1000000});
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getMultipleAccounts = (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 1000000, token: globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS ? {amount: '0', decimals: 6} : null});
    });
    await driver.click('btn-receive-request', {timeoutMs: 5_000});
    // Leave Receive and come back so the balance poll re-fires. The Pay leg is WAITED FOR: while
    // the Receive tab is still active `setMode('receive')` is a no-op, so a second tab press fired
    // before the first has taken effect leaves the wallet where it started — no remount, no
    // re-poll, and the gate below then times out for a reason that has nothing to do with SOL.
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.waitGone('btn-receive-address', {timeoutMs: 8_000});
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    await driver.findByTestID('sol-ata-insufficient', {timeoutMs: 10_000});
    const createBtn = await driver.findByTestID('btn-sol-ata-create', {timeoutMs: 5_000});
    const createDisabled = await createBtn.evaluate((n) => n.getAttribute('aria-disabled') === 'true' || n.disabled === true);
    assert(createDisabled, 'create must be disabled when SOL < rent+fee (honest cost gate)');
    console.log('[76-sol-usdc-ata-gate] ✓ insufficient-SOL: warning + disabled create');

    // ---- 4. FUNDED + CREATE: the real createUsdcAta broadcast → status flips → QR appears ----
    console.log('[76-sol-usdc-ata-gate] one-tap create → confirmed → address QR appears…');
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getBalance = () => ({value: 5000000000});
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.getMultipleAccounts = (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS ? {amount: '0', decimals: 6} : null});
      // The NEXT sendTransaction is the create; on confirmation the ATA exists.
      const orig = globalThis.__DPAY_TEST_SOLANA_RPC_STUB.sendTransaction;
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB.sendTransaction = (tx) => {
        globalThis.__DPAY_TEST_SOLANA_ATA_EXISTS = true;
        return orig(tx);
      };
    });
    await driver.click('btn-receive-request', {timeoutMs: 5_000});
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.waitGone('btn-receive-address', {timeoutMs: 8_000}); // the tab really changed
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    const btn = await driver.findByTestID('btn-sol-ata-create', {timeoutMs: 10_000});
    await driver.waitGone('sol-ata-insufficient', {timeoutMs: 10_000});
    await driver.click('btn-sol-ata-create', {timeoutMs: 5_000});
    // createUsdcAta confirms, Wallet refreshes BOTH polls, status flips balance → the address QR.
    await driver.findByTestID('sol-receive-address', {timeoutMs: 15_000});
    const address = await driver.readText('sol-receive-address');
    assert(BASE58.test(address), `after create, the USDC ATA address should render (base58), got "${address}"`);
    console.log(`[76-sol-usdc-ata-gate] ✓ create confirmed → address QR (${address})`);

    // ---- 5. BALANCE (direct): the request form is unblocked (no inline card) ----
    console.log('[76-sol-usdc-ata-gate] request form unblocked after create…');
    await driver.click('btn-receive-request', {timeoutMs: 5_000});
    await driver.waitGone('btn-sol-req-ata-create', {timeoutMs: 8_000});
    const reqBtn2 = await driver.findByTestID('btn-sol-req-make', {timeoutMs: 5_000});
    const reqEnabled = await reqBtn2.evaluate((n) => !(n.getAttribute('aria-disabled') === 'true' || n.disabled === true));
    assert(reqEnabled, 'Request must be enabled once the ATA exists');
    console.log('[76-sol-usdc-ata-gate] ✓ Request enabled after the ATA exists');

    await driver.screenshot('76-sol-usdc-ata-gate');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[76-sol-usdc-ata-gate] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/76-sol-usdc-ata-gate.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[76-sol-usdc-ata-gate] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
