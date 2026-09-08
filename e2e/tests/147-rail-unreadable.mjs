// Flow 147 — a balance the wallet cannot READ says so, on the row, in the running app.
//
// The baked Helius RPC key is out of quota (measured 2026-09-08: HTTP 429, "max usage reached"),
// so on every shipped build SOL, USDC·Solana and EURC·Solana render a bare "—" — and EURC·Solana
// is the PREFERRED EUR rail. That dash was also what a first poll still in flight rendered, so the
// surface gave the user no way to tell "still loading" from "this rail is unreadable right now",
// and no instruction at all on the error path (founder rule 2026-08-29).
//
// This flow drives the transition in the REAL app through the SOL RPC stub seam:
//   * a rail that ANSWERS renders its balance and says nothing extra — no false alarm;
//   * the same rail, once its endpoint starts refusing (the measured 429, verbatim), grows ONE
//     line FOR THE NETWORK (X9 — it used to be repeated verbatim on every affected account) that
//     names the network, states nothing moved and the other accounts still work, and that the
//     retry is automatic (the balance poll re-reads on its own every 2.5s behind the endpoint's
//     cooldown — so no button is promised that nothing implements, and against a rate limit an
//     extra manual read is the cause, not the cure);
//   * the IC rows on the same screen stay silent: the failure is scoped to the rail that failed.
//
// Selector contract: `balance` (the header chip that opens the accounts route), `asset-sol`,
// `rail-unreadable-solana`, `asset-vchf`.
import {setup, assert, assertIncludes, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '147',
  name: 'rail-unreadable',
  journey: 'system',
  covers: ['solana', 'balances', 'home', 'rpc-error', 'honest-copy', 'fail-closed'],
  verifies: 'A rail whose endpoint refuses (HTTP 429) stops rendering the same bare "—" a pending first poll shows: ONE line for the network says the balances could not be refreshed, names the network, says nothing moved and the other accounts still work, and that dpay keeps retrying on its own — stated once no matter how many accounts that network carries, while a rail that answers, and every IC row on the same screen, say nothing.',
  timeoutMs: 60000,
};

/** How many outage banners for the Solana network are on screen right now? X9's assertion is a
 *  COUNT: three Solana accounts share one endpoint, so one refusal is ONE fact. */
const outageBanners = (driver) =>
  driver.eval(() => document.querySelectorAll('[data-testid="rail-unreadable-solana"]').length);

export async function run() {
  const start = Date.now();
  console.log('[147-rail-unreadable] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[147-rail-unreadable] onboarding…');
    await onboardWallet(driver, 'e2e-rail-unreadable');

    // One mutable flag flips the endpoint from answering to refusing — the same shape flow 77 uses
    // for its per-address dispatch. The thrown text is the message the live endpoint returns.
    await driver.eval(() => {
      const st = {refusing: false};
      globalThis.__DPAY_TEST_SOL_RPC_STATE = st;
      const refuse = () => { throw new Error('solana rpc rate limit (HTTP 429): max usage reached'); };
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => '5eykt4UsFv8PJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getBalance: () => (st.refusing ? refuse() : {value: 2000000000}),
        getTokenAccountBalance: () => (st.refusing ? refuse() : {value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}}),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      };
    });

    // --- the rail answers: a balance, and NO warning ------------------------------------------
    console.log('[147-rail-unreadable] a rail that answers renders its balance and nothing else…');
    await openBalances(driver);
    await driver.waitForFunction(
      () => (document.querySelector('[data-testid="asset-sol"]')?.textContent ?? '').includes('2 SOL'),
      {timeoutMs: 12_000},
    );
    assert((await outageBanners(driver)) === 0, 'a rail that answers carries no outage banner');

    // --- the endpoint starts refusing: the row explains itself ---------------------------------
    console.log('[147-rail-unreadable] endpoint starts refusing (HTTP 429) → the row explains…');
    await driver.eval(() => { globalThis.__DPAY_TEST_SOL_RPC_STATE.refusing = true; });
    await driver.waitForFunction(
      () => document.querySelector('[data-testid="rail-unreadable-solana"]') != null,
      {timeoutMs: 12_000},
    );
    const line = await driver.readText('rail-unreadable-solana');
    assertIncludes(line, 'Solana', 'the line names the network that is not answering');
    assertIncludes(line, 'Nothing moved', 'the line states the funds did not move');
    assertIncludes(line, 'other accounts still work', 'the line points at what the user can still do');
    assertIncludes(line, 'keeps retrying', 'the line states the recovery is automatic (there is no button to press)');
    // X9 — three Solana accounts are unreadable at once (one endpoint, one refusal). The banner is
    // stated ONCE for the network; before this it was repeated verbatim on each of them.
    const solRows = await driver.eval(() => document.querySelectorAll('[data-testid^="asset-sol"][data-testid$="-select"]').length);
    assert(solRows >= 3, `the screen must carry >=3 Solana accounts for the count to mean anything, saw ${solRows}`);
    assert((await outageBanners(driver)) === 1, 'one network outage renders exactly ONE banner');

    // The failure is scoped to the rail that failed — the IC rows claim nothing about it.
    const vchfRow = await driver.readText('asset-vchf');
    assert(!vchfRow.includes('unreadable'), 'an IC row on the same screen is untouched by a Solana endpoint failure');
    // Bring the row itself into frame so the artifact shows the state it documents.
    await driver.eval(() => document.querySelector('[data-testid="asset-sol"]')?.scrollIntoView({block: 'center'}));
    await driver.screenshot('147-rail-unreadable');

    console.log(`[147-rail-unreadable] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}
