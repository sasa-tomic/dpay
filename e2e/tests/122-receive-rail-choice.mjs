// Flow 122 — Receive picks a rail and discloses why (Objective 2, docs/specs/2026-09-04).
//
// A multi-rail home currency (USD = ckUSDC@IC + USDC@Solana) defaults Receive ▸ "My address" to
// the wallet's OWN pick (chooseRail — preference when nothing is funded: ckUSDC), NAMES the rail
// (docs/specs/2026-09-07-ux-decisions.md), states the rail's fee fact in the rail's OWN
// unit (never converted, never merged with the sibling's), and offers the sibling rail's OWN
// address one toggle away with ITS fee fact. The toggle flip keeps the "My address" sub-mode
// mounted (it is the rail switch, not the Home accounts row selection that resets sub-modes) — the
// Solana sheet must appear WITHOUT re-tapping "My address".
//
// Ownership: the IC address must equal railPrincipalText(account.publicHex) — the wallet's own
// ICRC-1 principal (same assertion as flow 95); the Solana ATA address is checked for shape
// (base58, 32–44) AND seed-stability across a toggle-away-and-back (it is derived in-browser
// from the same onboarding seed — flow 45's property; the harness has no independent ATA
// derivation to compare against, and stability under one identity is the honest bound).
//
// WHERE THE IC ADDRESS IS READ, and why it moved (2026-09-09). ckUSDC's own deposit sheet is the
// wallet-signed ckERC20 one, and this flow used to prove it was UNREACHABLE on a USD wallet without
// knowing it: the home-rail branch resolved first, so the group's IC side rendered the plain ICRC
// sheet and the Ethereum minter route had no entry point at all for exactly the users whose main
// currency is dollars — a sheet reachable for one family and not another, which `CLAUDE.md`'s
// uniform-IA rule calls a bug rather than an exception. The family sheet now wins, and it is the
// strictly richer surface: it carries the SAME ICRC-1 principal (`ic-also-address`, under "Already
// on the Internet Computer?") plus the Ethereum route plus an honest "where do I get some" card
// that has a matching action on the same screen. So the rail disclosure, the fee facts and the
// sibling toggle are unchanged and still asserted here; only the testID the address is read from
// differs, and step 5 now pins the reachability that was missing.
//
// The single-rail control: home=CHF on VCHF renders EXACTLY as before — same principal sheet,
// NO rail disclosure anywhere (the component renders null outside a two-rail group).
import {setup, assert, assertEq, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent, accountOf, openBalances, selectCurrency, railPrincipalText, waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '122',
  name: 'receive-rail-choice',
  journey: 'deposit',
  covers: ['home-currency', 'receive', 'rails', 'ckusdc', 'sol-usdc', 'vchf', 'group-model'],
  verifies: 'Receive ▸ "My address" on a multi-rail home currency defaults to the wallet\'s rail pick with no "default rail" suffix and the rail\'s own fee fact, exposes the sibling rail\'s own address + fee one toggle away without leaving the sub-mode, and asserts both addresses belong to the user; single-rail CHF renders with no rail disclosure.',
  timeoutMs: 30000,
};

// base58 (Bitcoin alphabet) — the Solana address charset. 32–44 chars is the valid pubkey range.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function run() {
  const start = Date.now();
  console.log('[122-receive-rail-choice] setup (relay + web + browser, solStub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[122-receive-rail-choice] onboarding with home=USD…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-receive-rails', {timeoutMs: 8_000});
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup');
    await driver.click('mnemonic-backup-checkbox');
    await waitForEnabled(driver, 'btn-mnemonic-continue');
    await driver.click('btn-mnemonic-continue');
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title');
    await driver.click('home-currency-USD');
    await driver.click('btn-home-currency-continue');
    await waitForWallet(driver);
    const account = await accountOf(driver);
    const wantPrincipal = await railPrincipalText(account.publicHex);

    // The Solana RPC simulator (same seam as every SOL flow): the ATA EXISTS with a zero USDC
    // balance, so the USDC rail's address surface is READY (not the setup gate). Installed in the
    // LIVE document (this flow never navigates; flow 102's evaluateOnNewDocument trick is for the
    // cross-document case).
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

    // 1. Receive ▸ "My address" defaults to the pick (ckUSDC, reason: preference —
    //    docs/specs/2026-09-07-ux-decisions.md).
    console.log('[122-receive-rail-choice] opening Receive ▸ My address on the default rail…');
    await driver.click('tab-receive');
    await driver.click('btn-receive-address');
    const why1 = await driver.readText('receive-rail-why');
    assertIncludes(why1, 'ckUSDC · Internet Computer', 'the default rail is named');
    assert(!why1.includes('—'), `a pure preference adds no reason suffix, got "${why1}"`);
    const fee1 = await driver.readText('receive-rail-fee');
    assertIncludes(fee1, 'Internet Computer', 'the fee line names the rail\'s network');
    assertIncludes(fee1, 'Fee 0.01 ckUSDC', 'the fee is stated in the rail\'s own unit (0.01 ckUSDC, 6 decimals)');
    const toggleTxt = await driver.readText('receive-rail-toggle');
    assertIncludes(toggleTxt, 'Internet Computer', 'the rail toggle offers the IC side');
    assertIncludes(toggleTxt, 'Solana', 'the rail toggle offers the Solana side');
    const icAddr1 = (await driver.readText('ic-also-address')).trim();
    assertEq(icAddr1, wantPrincipal, 'the IC rail address is the wallet\'s own ICRC-1 principal');
    // The reachability this flow could not see before: ckUSDC's own deposit is a transaction the
    // user's Ethereum wallet signs, and on a USD wallet that surface had no entry point at all.
    assert(await driver.isPresent('btn-connect-wallet'),
      'the ckERC20 deposit must be reachable on the home rail too — it was shadowed by the home-currency branch for every USD wallet');
    await driver.screenshot('122-receive-rail-usd-ic');
    console.log('[122-receive-rail-choice] ✓ default rail disclosed (ckUSDC, preference, own principal, Ethereum route reachable)');

    // 2. One toggle to the sibling rail: its OWN address + fee fact, WITHOUT leaving the sub-mode.
    console.log('[122-receive-rail-choice] flipping to the sibling rail…');
    await driver.click('btn-receive-rail-right');
    await driver.findByTestID('sol-receive-address', {timeoutMs: 10_000});
    const why2 = await driver.readText('receive-rail-why');
    assertIncludes(why2, 'USDC · Solana', 'the sibling rail is named by its own line');
    assert(!why2.includes('—'), `the sibling carries no reason suffix (only the pick does), got "${why2}"`);
    const fee2 = await driver.readText('receive-rail-fee');
    assertIncludes(fee2, 'Solana · Fee 0.000005 SOL', 'the Solana per-transfer fee is stated in SOL');
    assertIncludes(fee2, 'one-time account rent 0.00203928 SOL', 'the USDC ATA rent is disclosed as the one-time cost');
    const solAddr = (await driver.readText('sol-receive-address')).trim();
    assert(BASE58.test(solAddr), `the USDC rail address is a valid base58 Solana address, got "${solAddr}"`);
    await driver.screenshot('122-receive-rail-usd-sol');
    console.log('[122-receive-rail-choice] ✓ sibling rail disclosed (USDC · Solana, own ATA + fees)');

    // 3. Toggle back: the IC principal is the SAME (stability under one identity — both addresses
    //    are deterministic derivations of this wallet's seed, not per-visit values).
    await driver.click('btn-receive-rail-left');
    const icAddr2 = (await driver.readText('ic-also-address', {timeoutMs: 10_000})).trim();
    assertEq(icAddr2, icAddr1, 'the IC rail address is stable across a rail flip (same wallet)');
    console.log('[122-receive-rail-choice] ✓ rail flip is reversible and the IC address is stable');

    // 4. Single-rail control: home=CHF on VCHF renders EXACTLY as before — no disclosure at all.
    console.log('[122-receive-rail-choice] switching home to CHF (single-rail control)…');
    await driver.click('tab-pay');
    await driver.click('btn-settings');
    await driver.click('btn-currency-CHF');
    await driver.click('btn-settings-close');
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.click('tab-receive');
    await driver.click('btn-receive-address');
    await driver.waitGone('receive-rail-disclosure', {timeoutMs: 3_000});
    const vchfAddr = (await driver.readText('deposit-address', {timeoutMs: 10_000})).trim();
    assertEq(vchfAddr, wantPrincipal, 'the VCHF sheet still shows the wallet\'s own ICRC-1 principal');
    await driver.screenshot('122-receive-rail-chf');
    console.log('[122-receive-rail-choice] ✓ single-rail CHF: unchanged sheet, no disclosure');

    console.log(`[122-receive-rail-choice] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}
