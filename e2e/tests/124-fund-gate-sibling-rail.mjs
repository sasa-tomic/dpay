// Flow 124 — the fund-first gate points at a funded sibling rail, one tap away (Objective 2, S5).
//
// When the payment wants a rail whose balance is the reason the gate exists, and a SIBLING rail
// of the same home currency is funded, the gate stops being a dead end: it names the rail and
// its amount ("You hold 2.50 USDC on USDC · Solana") and offers the switch as ONE tap. The switch
// is a user gesture through Wallet's `payRailSelect` (under `shouldAllowUserSelect`) — this flow
// exercises the tap itself, end-to-end, on the REAL app:
//
//   1. Home = US dollars ⇒ preferred ckUSDC selected, IC balance ZERO ⇒ the pay-fund gate.
//   2. A funded USDC@Solana sibling (stub) makes the pointer appear with the exact amount + rail.
//   3. ONE tap on "Switch to Solana" flips the wallet to the funded rail — the SOL scan screen is
//      armed, header reads "USDC·Sol balance". No manual Balances trip.
//
// Selector contract: `pay-fund`, `fund-sibling-rail`, `fund-sibling-holds`,
// `btn-fund-sibling-switch`, `active-asset-label`, `btn-sol-start-scan`.
import {setup, assert, assertEq, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipRehearsalIfPresent} from '../harness/lib.mjs';

export const meta = {
  id: '124',
  name: 'fund-gate-sibling-rail',
  journey: 'pay',
  covers: ['fund-gate', 'rail-choice', 'home-currency', 'solana'],
  verifies: 'The IC fund-first gate names a funded USDC@Solana sibling rail and one tap switches to it (user gesture, selection unlocked).',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[124-fund-gate-sibling-rail] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[124-fund-gate-sibling-rail] onboarding with home=USD (manual — onboardWallet pins CHF+DEMO)…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-sibling', {timeoutMs: 8_000});
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup');
    await driver.click('mnemonic-backup-checkbox');
    await waitForEnabled(driver, 'btn-mnemonic-continue');
    await driver.click('btn-mnemonic-continue');
    await skipRehearsalIfPresent(driver);
    await driver.findByTestID('home-currency-title');
    await driver.click('home-currency-USD');
    await driver.click('btn-home-currency-continue');
    await driver.findByTestID('balance', {timeoutMs: 10_000});

    // The FIRST currency choice lands on Home (docs/specs/2026-09-07-ux-decisions.md); the gate
    // this flow exercises lives on the Pay tab, so go there.
    await driver.click('tab-pay', {timeoutMs: 5_000});

    assertIncludes(await driver.readText('active-asset-label'), 'US dollars',
      'home=USD must start on the preferred ckUSDC rail');

    // Fund the SIBLING rail only: 2.5 USDC on Solana (live install — no navigation follows). The
    // IC side stays untouched: a fresh wallet's ckUSDC balance is zero, which is what raises the
    // pay-fund gate this flow exercises.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
        getBalance: () => ({value: 5000000000}),
        getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
      };
    });

    // 1. The fund gate for the unfunded preferred rail. The balance poll needs a beat to land the
    //    zero before the gate renders.
    await driver.findByTestID('pay-fund', {timeoutMs: 15_000});

    // 2. The pointer names the sibling rail and its amount, unit included — never a merged or
    //    converted figure (no-synthetic-sums rule).
    await driver.findByTestID('fund-sibling-rail', {timeoutMs: 5_000});
    assertEq(await driver.readText('fund-sibling-holds'), 'You hold 2.50 USDC on USDC · Solana',
      'the pointer must name the funded sibling rail and its own-unit amount');
    console.log('[124-fund-gate-sibling-rail] ✓ pointer: You hold 2.50 USDC on USDC · Solana');

    // 3. ONE tap: the switch is the user's gesture, honored while unlocked. The wallet lands on
    //    the funded rail's own scan screen — no Balances detour, no sub-mode surprise.
    await driver.click('btn-fund-sibling-switch', {timeoutMs: 5_000});
    await driver.findByTestID('btn-sol-start-scan', {timeoutMs: 10_000});
    assertEq(await driver.readText('active-asset-label'), 'USDC·Sol balance',
      'the switch must select the funded sibling rail');

    await driver.screenshot('124-fund-gate-sibling-rail');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[124-fund-gate-sibling-rail] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[124-fund-gate-sibling-rail] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
