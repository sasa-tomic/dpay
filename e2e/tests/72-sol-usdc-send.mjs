// Flow 72 — Solana USDC direct send (Phase 6 asset-aware "Send to address").
//
// Phase 6 (2026-08-12 unified asset selection rewrite) makes SolanaWithdrawSheet asset-aware: when
// Solana USDC is the selected asset, the Pay tab's "Send to address" sub-mode must run the SPL
// Token transfer path (sendSpl), NOT the native SOL path. The fail-closed sender-ATA gate mirrors
// Phase 4's receive-side gate: if the device's USDC ATA is known absent, the send form is REPLACED
// by an instruction card (you can't send USDC you don't have an account for).
//
// This flow proves end-to-end through the REAL app:
//   1. Solana USDC is selectable in Balances (uniform with the SOL row + IC rows).
//   2. The Pay tab "Send to address" toggle surfaces SolanaWithdrawSheet with the USDC unit.
//   3. When the device's USDC ATA is ABSENT (stub getAccountInfo → null), the fail-closed
//      instruction card renders (`sol-send-instructions`) — the form is suppressed so the user
//      can never submit a doomed USDC send.
//   4. The instruction text honestly explains the one-time ATA setup requirement.
//   5. ONE-TAP CREATE (2026-08-14 send-side setup card — was a dead-end message): tapping
//      `btn-sol-send-ata-create` runs the REAL createUsdcAta path through the stubbed seam —
//      busy state (`sol-ata-busy`) while the create confirms, then the ATA flips to existing and
//      the send form (`sol-send-address-input`) replaces the card.
//   6. CREATE FAILURE: when the stub's broadcast rejects, `sol-ata-err` renders the (verbatim)
//      error and the sheet stays usable — the create button returns, not busy, still tappable.
//
// The happy-path SPL send (both ATAs present → sign + broadcast) is covered by flow 77; the jest
// byte-exact tx proof lives in solana-seam.test.ts. This flow covers the UI-visible gate + the
// one-tap setup lifecycle that jest structurally cannot see.
//
// Uses `setup({solStub: true})` so the Solana rail + Solana USDC row are coherent. The stub's
// getAccountInfo is STATEFUL (mutable via `__DPAY_TEST_ATA_STATE`): it starts absent (the gate),
// and the sendTransaction wrapper flips it on a successful create — exactly what the real chain
// would do.
//
// Selector contract: `asset-sol-usdc-select`, `tab-pay`, `btn-pay-send`, `sol-send-instructions`,
// `btn-sol-send-ata-create`, `sol-ata-busy`, `sol-ata-err`, `sol-send-address-input`.
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
  id: '72',
  name: 'sol-usdc-send',
  journey: 'system',
  covers: ['sol-usdc-send', 'spl-transfer', 'fail-closed-ata', 'asset-aware-send', 'ata-create-one-tap'],
  verifies: 'Solana USDC "Send to address": fail-closed device-ATA gate → one-tap create (busy → form appears) and the create-failure leg (err shown, sheet stays usable).',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[72-sol-usdc-send] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[72-sol-usdc-send] onboarding…');
    await onboardWallet(driver, 'e2e-sol-usdc-send');

    // Stateful stub: funded SOL (getBalance) + a MUTABLE device-ATA existence flag. `ataExists`
    // starts false (the fail-closed gate below); the sendTransaction wrapper models
    // createUsdcAta's broadcast — it holds the busy window open long enough to observe
    // `sol-ata-busy`, can be told to fail (the error leg), and flips the ATA to existing on
    // success (what the real chain does). The post-create USDC poll reads a funded token
    // balance → status 'balance' → `usdcAtaAbsent` false → the form appears.
    await driver.eval(() => {
      const st = {ataExists: false, createDelayMs: 2500, failCreate: false};
      globalThis.__DPAY_TEST_ATA_STATE = st;
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, st.ataExists ? {lamports: 5000000000, token: {amount: '2500000', decimals: 6}} : {lamports: 5000000000, token: null}),
        getGenesisHash: () => '5eykt4UsFv8PJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: async () => {
          await new Promise((resolve) => setTimeout(resolve, st.createDelayMs));
          if (st.failCreate) throw new Error('e2e stub: create ATA broadcast rejected');
          st.ataExists = true;
          return 'sig_ata_' + Math.random().toString(36).slice(2, 12);
        },
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => (st.ataExists
          ? {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}
          : {value: null}),
        getBalance: () => ({value: 5000000000}),
        // Post-create the wallet HOLDS USDC (2.5) — the 2026-08-16 fund-first gate ('usdc-zero')
        // correctly replaces the send form while the token balance is a KNOWN zero, so the send
        // exercises here need a funded account for the form to appear (you cannot send USDC you
        // don't hold — that gate is flow 79's subject, not this one's).
        getTokenAccountBalance: () => (st.ataExists
          ? {value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}
          : {value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}}),
      };
    });

    // 1. Select Solana USDC via Balances. selectedAssetId flips to 'solana:USDC' → SolPayMode mounts
    //    with selectedToken='USDC'. The Pay tab will now drive the SPL send path, not native SOL.
    console.log('[72-sol-usdc-send] selecting Solana USDC via Balances…');
    await openBalances(driver);
    await selectSolRail(driver, 'sol-usdc', {timeoutMs: 5_000});

    // 2. Switch to the Pay tab. SolPayMode mounts; it reads the seeded nonce (if any) → phase='setup'
    //    (first-use gate) since we did NOT seed a nonce. That's fine — we're driving the "Send to
    //    address" sub-mode which bypasses the scan/setup phase entirely (the early-return for
    //    subMode==='send' sits before the phase rendering).
    console.log('[72-sol-usdc-send] switching to the Pay tab…');
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('pay-mode-toggle', {timeoutMs: 5_000});

    // 3. Switch to "Send to address" sub-mode. SolanaWithdrawSheet mounts with token='USDC'. Since the
    //    device's USDC ATA is absent (stub getAccountInfo → null), the fail-closed instruction card
    //    renders INSTEAD of the form — the user can never submit a doomed USDC send.
    console.log('[72-sol-usdc-send] switching to "Send to address" (asserting fail-closed ATA gate)…');
    await driver.click('btn-pay-send', {timeoutMs: 5_000});

    // 4. FAIL-CLOSED: the instruction card renders with `sol-send-instructions` testID. The form
    //    inputs (sol-send-address-input / sol-send-amount-input) must NOT be present — the gate
    //    replaces the entire form body. This is the honest pre-check: you can't send USDC you don't
    //    have an account for.
    const instrEl = await driver.findByTestID('sol-send-instructions', {timeoutMs: 8_000});
    const instrTxt = await instrEl.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(instrTxt, 'USDC account', 'the fail-closed instruction should mention "USDC account"');
    console.log('[72-sol-usdc-send] ✓ fail-closed instruction card rendered');

    // The form inputs must be absent — the gate replaces the form.
    const formPresent = await driver.eval(() => !!document.querySelector('[data-testid="sol-send-address-input"]'));
    assert(formPresent === false, 'the send form must NOT render when the device ATA is absent (gate replaces it)');
    console.log('[72-sol-usdc-send] ✓ send form suppressed (no doomed submit possible)');

    await driver.screenshot('72-sol-usdc-send');

    // 5. ONE-TAP CREATE — the happy lifecycle. The create button renders on the card (funded SOL →
    //    enabled). Tap it: the REAL createUsdcAta runs (getBalance pre-check → blockhash → sign →
    //    sendTransaction → confirm, all through the stub). While the stubbed broadcast holds, the
    //    card is in its busy state; when it resolves, the ATA exists and the next USDC poll flips
    //    `usdcAtaAbsent` → the form replaces the card.
    console.log('[72-sol-usdc-send] tapping "Create my USDC account" (happy path)…');
    const createBtn = await driver.findByTestID('btn-sol-send-ata-create', {timeoutMs: 8_000});
    const createDisabled = await createBtn.evaluate((n) => n.getAttribute('aria-disabled') === 'true' || n.disabled === true);
    assert(createDisabled === false, 'the create button must be enabled (SOL funded above the rent floor)');
    await driver.click('btn-sol-send-ata-create', {timeoutMs: 5_000});

    // Busy state: the stubbed broadcast holds ~2.5s, so `sol-ata-busy` (which REPLACES the button)
    // is observable. If the create were instant, this would be a flaky race — the delay makes it
    // deterministic.
    await driver.findByTestID('sol-ata-busy', {timeoutMs: 2_000});
    console.log('[72-sol-usdc-send] ✓ busy state rendered while the create confirms');

    // Completion: the ATA now exists → the USDC poll reads a (known-zero) balance → the setup card
    // unmounts and the REAL send form appears.
    await driver.findByTestID('sol-send-address-input', {timeoutMs: 15_000});
    console.log('[72-sol-usdc-send] ✓ create completed — the send form appeared');
    await driver.screenshot('72-sol-usdc-send-created');

    // 6. CREATE FAILURE — the sheet stays usable. Flip the ATA back to absent (the next USDC poll,
    //    150ms fast-poll seam, re-mounts the gate) and make the stubbed broadcast REJECT. Tap
    //    create again: `sol-ata-err` renders the error verbatim (friendlySolError passes an
    //    unmatched stub message through), the busy state clears, and the create button returns —
    //    the sheet is not bricked by a failed create.
    console.log('[72-sol-usdc-send] re-gating + failing the create (error leg)…');
    await driver.eval(() => {
      const st = globalThis.__DPAY_TEST_ATA_STATE;
      st.ataExists = false;
      st.failCreate = true;
      st.createDelayMs = 300;
    });
    await driver.waitGone('sol-send-address-input', {timeoutMs: 8_000});
    await driver.findByTestID('btn-sol-send-ata-create', {timeoutMs: 8_000});
    await driver.click('btn-sol-send-ata-create', {timeoutMs: 5_000});

    const errEl = await driver.findByTestID('sol-ata-err', {timeoutMs: 8_000});
    const errTxt = await errEl.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(errTxt, 'create ATA broadcast rejected', 'the setup card should surface the create failure verbatim');
    console.log('[72-sol-usdc-send] ✓ create failure surfaced');

    // Usable again: the button is back (not the busy indicator) and still tappable.
    await driver.findByTestID('btn-sol-send-ata-create', {timeoutMs: 5_000});
    const busyAfterErr = await driver.eval(() => !!document.querySelector('[data-testid="sol-ata-busy"]'));
    assert(busyAfterErr === false, 'the busy indicator must clear after a failed create');
    console.log('[72-sol-usdc-send] ✓ sheet usable after failure (create button returned, not busy)');
    await driver.screenshot('72-sol-usdc-send-error');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[72-sol-usdc-send] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[72-sol-usdc-send] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
