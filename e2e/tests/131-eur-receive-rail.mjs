// Flow 131 — Receive on the EUR dual-rail: both addresses, both fee facts, and the thin note
// exactly where it belongs (Stage 5 of the EUR dual-rail addition).
//
// EUR's default rail is EURC@Solana (deep liquidity — the stated preference), so Receive ▸
// "My address" opens on the SOLANA side: the wallet's EURC ATA, the SOL signature fee + one-time
// ATA rent in SOL, and NO health line (warn tone renders nothing on a deep rail). One toggle
// right flips to VEUR@IC WITHOUT leaving the sub-mode: the wallet's own ICRC-1 principal, the
// 10000-e8s fee in VEUR, and the thin-liability note — receiving on VEUR is the action the note
// qualifies, so the note rides the disclosure itself, above the toggle.
//
// Ownership assertions mirror flow 122: the IC address must equal railPrincipalText of the
// account's public hex; the EURC ATA is base58-shaped and stable across a flip-away-and-back
// (the harness has no independent ATA derivation — stability under one identity is the bound).
import {
  setup, assert, assertEq, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent,
  accountOf, railPrincipalText,
 waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '131',
  name: 'eur-receive-rail',
  journey: 'deposit',
  covers: ['home-currency', 'receive', 'rails', 'eur', 'eurc', 'veur', 'rail-health', 'fees'],
  verifies: 'Receive ▸ My address on home=EUR defaults to EURC@Solana (own ATA + SOL fees, no health line on the deep rail) and toggles to VEUR@IC (own principal + e8s VEUR fee + the thin-liability note on the disclosure) without leaving the sub-mode; both addresses stable across flips.',
  timeoutMs: 30000,
};

// base58 (Bitcoin alphabet) — the Solana address charset. 32–44 chars is the valid pubkey range.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function run() {
  const start = Date.now();
  console.log('[131-eur-receive-rail] setup (relay + web + browser, solStub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[131-eur-receive-rail] onboarding with home=EUR…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-eur-receive', {timeoutMs: 8_000});
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup');
    await driver.click('mnemonic-backup-checkbox');
    await waitForEnabled(driver, 'btn-mnemonic-continue');
    await driver.click('btn-mnemonic-continue');
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title');
    await driver.click('home-currency-EUR');
    await driver.click('btn-home-currency-continue');
    await waitForWallet(driver);
    const account = await accountOf(driver);
    const wantPrincipal = await railPrincipalText(account.publicHex);

    // The Solana RPC simulator (same seam as every SOL flow): the EURC ATA EXISTS with a zero
    // balance, so the address surface is READY rather than the setup gate.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 0, token: {amount: '0', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: '11111111111111111111111111111111', lamports: 2039280}}),
        getBalance: () => ({value: 0}),
        getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}}),
      };
    });

    // 1. The default rail is EURC@Solana: own ATA, SOL fee + rent, and NO health line (deep).
    console.log('[131-eur-receive-rail] opening Receive ▸ My address on the default rail (EURC)…');
    await driver.click('tab-receive');
    await driver.click('btn-receive-address');
    const why1 = await driver.readText('receive-rail-why');
    assertIncludes(why1, 'EURC · Solana', 'the default rail is the stated preference (EURC), named');
    // docs/specs/2026-09-07-ux-decisions.md
    assert(!why1.includes('—'), `a pure preference adds no reason suffix, got "${why1}"`);
    assertEq((await driver.readText('receive-rail-fee')).trim(),
      'Solana · Fee 0.000005 SOL + one-time account rent 0.00203928 SOL',
      'the EURC fee fact: signature fee + the one-time ATA rent, in SOL — never converted');
    const disclosure1 = await driver.readText('receive-rail-disclosure');
    assert(!disclosure1.includes('Very little'),
      `the DEEP rail carries no thin note — warn tone renders nothing on EURC. Got: ${JSON.stringify(disclosure1)}`);
    const eurcAddr1 = (await driver.readText('sol-receive-address')).trim();
    assert(BASE58.test(eurcAddr1), `the EURC rail address is a valid base58 ATA, got "${eurcAddr1}"`);
    const toggleTxt = await driver.readText('receive-rail-toggle');
    assertIncludes(toggleTxt, 'Solana', 'the rail toggle offers the Solana side');
    assertIncludes(toggleTxt, 'Internet Computer', 'the rail toggle offers the IC side');
    await driver.screenshot('131-eur-receive-eurc');
    console.log('[131-eur-receive-rail] ✓ default rail disclosed (EURC, no preference suffix, own ATA + fees)');

    // 2. One toggle right: VEUR@IC — own principal, e8s fee, and the thin note ON the disclosure.
    console.log('[131-eur-receive-rail] flipping to the sibling rail (VEUR)…');
    await driver.click('btn-receive-rail-right');
    await driver.findByTestID('deposit-address', {timeoutMs: 10_000});
    const why2 = await driver.readText('receive-rail-why');
    assertIncludes(why2, 'VEUR · Internet Computer', 'the sibling rail is named by its own line');
    assert(!why2.includes('—'), `the sibling carries no reason suffix (only the pick does), got "${why2}"`);
    assertEq((await driver.readText('receive-rail-fee')).trim(),
      'Internet Computer · Fee 0.0001 VEUR',
      'the VEUR fee fact: the catalog row\'s 10000-e8s fee, in VEUR\'s own 8 decimals');
    const disclosure2 = await driver.readText('receive-rail-disclosure');
    assertIncludes(disclosure2, 'Very little VEUR exists on-chain today',
      'the thin note rides the disclosure itself — receiving on VEUR is the action it qualifies');
    const veurAddr = (await driver.readText('deposit-address')).trim();
    assertEq(veurAddr, wantPrincipal, 'the VEUR rail address is the wallet\'s own ICRC-1 principal');
    await driver.screenshot('131-eur-receive-veur');
    console.log('[131-eur-receive-rail] ✓ sibling rail disclosed (VEUR, own principal, e8s fee, thin note)');

    // 3. Toggle back: still in the sub-mode, and the ATA is the SAME derivation (same identity).
    await driver.click('btn-receive-rail-left');
    const eurcAddr2 = (await driver.readText('sol-receive-address', {timeoutMs: 10_000})).trim();
    assertEq(eurcAddr2, eurcAddr1, 'the EURC ATA is stable across a rail flip (same wallet)');
    console.log('[131-eur-receive-rail] ✓ rail flip is reversible and the ATA is stable');

    console.log(`[131-eur-receive-rail] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[131-eur-receive-rail] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
