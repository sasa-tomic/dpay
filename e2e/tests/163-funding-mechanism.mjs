// Flow 163 — the funding instruction must match the deposit that actually runs.
//
// THE DEFECT THIS EXISTS FOR, stated as it shipped. `fundingRoute` decided how a user gets an asset
// from `asset.network`, a DISPLAY fact naming the chain a chain-key token is BACKED by. For ckUSDC
// that is "Ethereum", which is not the Internet Computer, so the resolver concluded "buy USDC and
// send it to the address above" — on the deposit surface a USD wallet actually lands on, which
// shows an Internet Computer principal. A user who followed that sentence would send Ethereum USDC
// to an address that cannot receive it. ckUSDC has no deposit address at all: its deposit is
// `approve` + `depositErc20` signed by the user's own EVM wallet, with the fee paid separately in
// ETH.
//
// It was reachable on the DEFAULT rail of a USD wallet, which is why this flow sets USD rather than
// taking the suite's default francs. Two structural bugs sat behind it and are pinned here too:
// the home-currency branch shadowed the ckERC20 sheet entirely (so the Ethereum minter route was
// unreachable from Receive on exactly those wallets), and the "buy it on X" chain was read off the
// row's settlement subtitle, which would have told a ckBTC holder to buy Bitcoin "on the Internet
// Computer" the moment that surface was wired.
//
// The rule the app now holds, owned by `DepositMechanism` in app/config/catalog.ts and not restated
// here: ONE switch picks the deposit sheet AND writes the instruction under it, so a surface and
// its funding copy cannot describe different deposits.
//
// What this pins, per mechanism:
//   (a) evm-wallet (ckUSDC) — the wallet-connect sheet is what renders, and its funding card says
//       there is no address, names ETH as a separate holding, and never says "send it to the
//       address above";
//   (b) send-to-address (ckBTC) — buy BTC on BITCOIN, and DO send it to the address on screen;
//   (c) send-to-address (Solana) — the same shape on a rail with no catalog descriptor at all.
//
// Flow 162 owns the provider table, the attribution and the VCHF/ICP split; none of that is
// re-asserted here.
//
// Selector contract: `asset-ckusdc-select`, `asset-ckbtc-select`, `asset-sol-select`,
// `btn-receive-address`, `ckerc20-deposit`, `btn-connect-wallet`, `deposit-address`,
// `sol-receive-qr`, `funding-routes`, `funding-bridge`.
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency, openReceiveAddress, waitForWallet } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '163',
  name: 'funding-mechanism',
  journey: 'deposit',
  covers: ['funding-routes', 'deposit-mechanism', 'ckerc20', 'ckbtc', 'solana', 'money-loss-guard', 'honest-instructions'],
  verifies: 'The "don\'t have any yet?" instruction matches the deposit that actually runs. On a USD wallet ckUSDC reaches the wallet-signed ckERC20 sheet (not the ICRC address sheet that used to shadow it) and its funding card says there is no address, names ETH as a separate holding for the fee, and never says to send the token to an address; ckBTC says buy BTC on Bitcoin — the backing chain, not the Internet Computer its row settles on — and does send it to the address shown; and the Solana rail gets the same send-to-address shape with no catalog descriptor behind it.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[163-funding-mechanism] setup (relay + web + browser)…');
  const env = await setup({ solStub: true });
  try {
    const { driver } = env;

    console.log('[163-funding-mechanism] onboarding…');
    await onboardWallet(driver, 'e2e-funding-mechanism');

    // The wallet must be IN dollars: `CURRENCY_RAILS.USD` is ['ckUSDC', 'USDC'], which is what made
    // ckUSDC a two-rail home group and sent it down the branch that shadowed its own deposit sheet.
    // On the suite's default francs the bug is unreachable, and a gate that cannot see the defect
    // it is named after is worse than no gate.
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-currency-USD', { timeoutMs: 5_000 });
    await driver.click('btn-settings-close', { timeoutMs: 5_000 });
    await waitForWallet(driver, { timeoutMs: 8_000 });

    // ---- (a) ckUSDC: a wallet-signed deposit, and copy that says so --------------------------
    await openBalances(driver);
    await selectCurrency(driver, 'ckusdc');
    await openReceiveAddress(driver);

    // The sheet itself. `ckerc20-deposit` is the wallet-connect surface's own card; its presence is
    // the proof that the ckERC20 family beat the home-rail branch. (Its "Already on the Internet
    // Computer?" section still offers the plain ICRC transfer, so nothing was taken away — the
    // richer sheet simply carries both routes.)
    await driver.findByTestID('ckerc20-deposit', { timeoutMs: 10_000 });
    assert(await driver.isPresent('btn-connect-wallet'),
      'a USD wallet must be able to reach the Ethereum deposit for ckUSDC — the home-currency branch used to shadow it, leaving the minter route unreachable from Receive');
    assert(await driver.isPresent('ic-also-section'),
      'and the ICRC-transfer route must still be on that sheet, so the richer surface loses nothing');

    await driver.findByTestID('funding-routes', { timeoutMs: 8_000 });
    const usdc = await driver.readText('funding-bridge');
    // The exact sentence the money-loss reading came from. Asserted as an ABSENCE because that is
    // the shape of the defect: the old copy was a complete, confident, wrong instruction.
    assert(!/send it to the address/i.test(usdc),
      `a wallet-signed deposit must never tell the user to send the token to an address — there is none. Got: ${JSON.stringify(usdc)}`);
    assertIncludes(usdc, 'no address for this one', 'the card must say plainly that this deposit has no address');
    assertIncludes(usdc, 'ETH', 'and it must name ETH — without it in the same wallet, the deposit cannot be signed at all');
    assertIncludes(usdc, 'network fee', 'the reason ETH is needed must be given, not left as a bare token name');
    // The chain to buy on is Ethereum — the BACKING chain here, which is right for this mechanism
    // and wrong for the address one. Both readings of `network` exist; the mechanism picks.
    assertIncludes(usdc, 'Ethereum', 'ckUSDC is bought on Ethereum, which is where the signed deposit runs');
    console.log('[163-funding-mechanism] ✓ ckUSDC: wallet-signed sheet, and copy that never offers an address');
    // Shoot the card itself, not the top of the sheet: the artifact is only useful if the sentence
    // this flow exists to guard is inside it.
    await driver.eval((sel) => { document.querySelector(sel)?.scrollIntoView({block: 'center'}); }, '[data-testid="funding-routes"]');
    await driver.screenshot('163-funding-mechanism-ckusdc');

    // ---- (b) ckBTC: a real address, and the BACKING chain named ------------------------------
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');
    await openReceiveAddress(driver);
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });
    await driver.findByTestID('funding-routes', { timeoutMs: 8_000 });
    const btc = await driver.bodyText();
    assertIncludes(btc, 'Bitcoin',
      'ckBTC is bought on BITCOIN — the row settles on the Internet Computer, and naming that as the place to buy sends the user looking for something nobody sells there');
    assertIncludes(btc, 'send it to the address above',
      'and this mechanism DOES have an address, so the instruction must end there');
    assert(!/no address for this one/i.test(btc),
      'the wallet-signed sentence must not leak onto a sheet that shows a real address');
    console.log('[163-funding-mechanism] ✓ ckBTC: buy BTC on Bitcoin, send it to the address shown');

    // ---- (c) Solana: the same shape, with no descriptor behind it ----------------------------
    await openBalances(driver);
    await driver.click('asset-sol-select', { timeoutMs: 5_000 });
    await driver.click('tab-receive', { timeoutMs: 5_000 });
    await driver.click('btn-receive-address', { timeoutMs: 5_000 });
    await driver.findByTestID('sol-receive-qr', { timeoutMs: 10_000 });
    await driver.findByTestID('funding-routes', { timeoutMs: 8_000 });
    const sol = await driver.bodyText();
    assertIncludes(sol, 'Solana', 'the Solana rail names its own chain as the place to buy');
    assertIncludes(sol, 'send it to the address above', 'and it is an address deposit like any other');
    console.log('[163-funding-mechanism] ✓ Solana: same instruction shape on a rail with no catalog row');
    await driver.eval((sel) => { document.querySelector(sel)?.scrollIntoView({block: 'center'}); }, '[data-testid="funding-routes"]');
    await driver.screenshot('163-funding-mechanism-sol');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[163-funding-mechanism] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[163-funding-mechanism] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
