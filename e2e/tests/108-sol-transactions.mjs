// Flow 108 — a Solana transaction appears in the Transactions tab, alongside the IC rail.
//
// The SOL rail had a working history reader (`app/solana/history.ts`, unit-tested) that NOTHING
// reached: the Transactions tab listed IC rows only, so every SOL send and every SOL deposit was
// invisible in the one screen that is supposed to answer "what happened to my money". Uniform
// surfaces across rails is a CLAUDE.md hard rule, and a per-rail hole in the ledger is a bug.
//
// Proven end-to-end through the REAL app: `useSolanaHistory` polls the SOL rail through the SAME
// `__DPAY_TEST_SOLANA_RPC_STUB` seam every other SOL flow uses (real `fetchSolanaHistory` over real
// `getSignaturesForAddress` / `getTransaction` bodies — the balance-delta reader is doing the work,
// not a fixture), the rows are merged with the IC rail's by timestamp, and ONE Ledger renders both:
//   1. the SOL row shows the NET lamport delta in SOL units (2.000005 SOL — the 2 SOL transfer
//      plus the 5000-lamport fee this wallet paid, which is the honest "what left my wallet"),
//   2. its counterparty is the short form of the address the lamports actually moved to,
//   3. the IC rail's own row (the onboarding ∂100 faucet mint) is still there, in ∂ — each rail
//      formatted in its OWN units, in one list,
//   4. both filter chips render, keyed on AssetId, so neither rail can be filtered away by the
//      other's id.
//
// The stub is keyed to the wallet's REAL derived Solana address (read off the Receive ▸ My address
// screen), so the rows are attributed by the same account the device would sign with.
//
// Selector contract: `asset-sol-select`, `tab-receive`, `btn-receive-address`, `sol-receive-address`,
// `tab-transactions`, `ledger-view`, `ledger-filter-sol`, `ledger-filter-$`.
import {setup, assert, assertIncludes, onboardWallet, openBalances, openReceiveAddress} from '../harness/lib.mjs';

export const meta = {
  id: '108',
  name: 'sol-transactions',
  journey: 'pay',
  covers: ['sol-history', 'ledger', 'transactions', 'mixed-rail', 'ledger-filter', 'sol-tab-ia'],
  verifies: 'A Solana transaction appears in the Transactions tab: the SOL rail history is polled through the RPC seam, merged with the IC rail by timestamp, and rendered by the one Ledger — SOL row in SOL units with its short counterparty, the IC faucet row still in ∂, and a filter chip per rail.',
  timeoutMs: 30000,
};

const SIGNATURE = 'E2eSoLhIsToRy1111111111111111111111111111111';
const PEER = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const SLOT = 250_000_000;
const START_LAMPORTS = 5_000_000_000;   // 5 SOL before
const SENT_LAMPORTS = 2_000_000_000;    // 2 SOL transferred out
const FEE_LAMPORTS = 5_000;             // the fee this wallet paid, included in its net delta

export async function run() {
  const start = Date.now();
  console.log('[108-sol-transactions] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[108-sol-transactions] onboarding (also mints the ∂100 DEMO faucet row)…');
    await onboardWallet(driver, 'e2e-sol-history');

    // Install the stub BEFORE the SOL polls start hitting it. `__E2E_SOL_OWNER` is filled in once
    // the app has told us which address it derived; until then the signature queries answer "no
    // activity" (an empty list is a real, valid RPC answer — nothing is faked into existence).
    console.log('[108-sol-transactions] installing the SOL RPC stub…');
    await driver.eval((cfg) => {
      globalThis.__E2E_SOL_OWNER = null;
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getBalance: () => ({value: cfg.startLamports - cfg.sentLamports - cfg.feeLamports}),
        // No USDC token account for this wallet → the USDC balance reads a KNOWN absent, and the
        // ATA's signature query returns nothing.
        getAccountInfo: () => ({value: null}),
        getSignaturesForAddress: (params) => (
          params[0] === globalThis.__E2E_SOL_OWNER
            ? [{signature: cfg.signature, slot: cfg.slot}]
            : []
        ),
        // A real `getTransaction` body: the direction and the amount are read by the app off these
        // BALANCE DELTAS (never from an instruction decode), so this is the actual code path.
        getTransaction: () => ({
          slot: cfg.slot,
          blockTime: Math.floor(Date.now() / 1000) - 60,
          meta: {
            err: null,
            fee: cfg.feeLamports,
            preBalances: [cfg.startLamports, 0],
            postBalances: [cfg.startLamports - cfg.sentLamports - cfg.feeLamports, cfg.sentLamports],
            preTokenBalances: [],
            postTokenBalances: [],
          },
          transaction: {message: {accountKeys: [globalThis.__E2E_SOL_OWNER, cfg.peer]}},
        }),
      };
    }, {
      signature: SIGNATURE, slot: SLOT, peer: PEER,
      startLamports: START_LAMPORTS, sentLamports: SENT_LAMPORTS, feeLamports: FEE_LAMPORTS,
    });

    // Select SOL, then read the address the device actually derived (Receive ▸ My address — the
    // same surface every rail uses). The stub is keyed to it, so the row is attributed to the real
    // signing account rather than to a fixture that merely looks like one.
    console.log('[108-sol-transactions] selecting SOL and reading its derived address…');
    await openBalances(driver);
    await driver.click('asset-sol-select', {timeoutMs: 8_000});
    await driver.waitGone('btn-balances-close', {timeoutMs: 5_000});
    await openReceiveAddress(driver);
    const solAddress = await driver.readText('sol-receive-address');
    assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solAddress), `expected a base58 Solana address, got "${solAddress}"`);
    console.log(`[108-sol-transactions] wallet SOL address: ${solAddress}`);
    await driver.eval((addr) => { globalThis.__E2E_SOL_OWNER = addr; }, solAddress);

    // The Transactions tab — the ONE surface both rails render through.
    console.log('[108-sol-transactions] opening the Transactions tab…');
    await driver.click('tab-transactions', {timeoutMs: 5_000});
    await driver.findByTestID('ledger-view', {timeoutMs: 5_000});

    // 1. The SOL row lands (the next history poll picks the stub up) in SOL units. 2 SOL + the
    //    5000-lamport fee = 2.000005 SOL is the net that left the wallet. Every assertion below
    //    reads the LEDGER's own text, never the whole page — the header balance carries a ∂ amount
    //    too, and a body-wide match would pass on it.
    const landed = await driver.waitForText('2.000005 SOL', {timeoutMs: 10_000});
    const ledger = await driver.readText('ledger-view');
    assert(landed, `the SOL transaction should appear in the Transactions tab. ledger text:\n${ledger.slice(0, 800)}`);
    assertIncludes(ledger, '−2.000005 SOL', 'the SOL row renders as an outgoing amount in SOL units');
    console.log('[108-sol-transactions] ✓ SOL row: −2.000005 SOL');

    // 2. The counterparty is the short form of the address the lamports moved to — derived from the
    //    same deltas, not from the request that created the payment.
    assertIncludes(ledger, `${PEER.slice(0, 8)}…`, 'the SOL row names the counterparty it moved lamports to');
    console.log(`[108-sol-transactions] ✓ counterparty: ${PEER.slice(0, 8)}…`);

    // 3. The IC rail is untouched: the onboarding faucet mint still renders in the SAME list, in ∂.
    assertIncludes(ledger, '+∂100.00', 'the IC rail\'s faucet row is still listed, in its own ∂ units');
    console.log('[108-sol-transactions] ✓ the IC faucet row coexists in ∂');

    // 4. One filter chip per PRESENT asset, across both rails — the merge is asset-keyed, so the
    //    Solana chip cannot collide with an IC currency id.
    await driver.findByTestID('ledger-filter-sol', {timeoutMs: 5_000});
    await driver.findByTestID('ledger-filter-$', {timeoutMs: 5_000});
    console.log('[108-sol-transactions] ✓ both rails have a filter chip (ledger-filter-sol + ledger-filter-$)');

    // Filtering to SOL leaves the IC row out — proof the chip filters on the row's AssetId.
    await driver.click('ledger-filter-sol', {timeoutMs: 5_000});
    const filtered = await driver.readText('ledger-view');
    assertIncludes(filtered, '−2.000005 SOL', 'the SOL row survives its own filter');
    assert(!filtered.includes('+∂100.00'), `the DEMO row must be filtered out when the SOL chip is active. ledger text:\n${filtered.slice(0, 500)}`);
    console.log('[108-sol-transactions] ✓ the SOL chip filters to the SOL rail alone');

    await driver.screenshot('108-sol-transactions');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[108-sol-transactions] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[108-sol-transactions] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
