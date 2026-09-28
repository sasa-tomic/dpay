/**
 * Flow 108 — the jest twin of `e2e/tests/108-sol-transactions.mjs` (a Solana transaction in the
 * ONE Transactions tab, alongside the IC rail).
 *
 * `useSolanaHistory` polls the SOL rail through the `__DPAY_TEST_SOLANA_RPC_STUB` seam (real
 * `getSignaturesForAddress`/`getTransaction` bodies — the balance-delta reader does the work), the
 * rows merge with the IC rail by timestamp, and ONE Ledger renders both: the SOL row in SOL units
 * with its short counterparty, the IC faucet row still in ∂, and a filter chip per rail.
 *
 * LOAD-ORDER CONTRACT: the RPC override is set before the harness require (see ./solrpc).
 */
import {describe, it, expect} from '@jest/globals';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from './solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../harness/lib') as typeof import('../harness/lib');
const {
  assertIncludes, onboardWallet, openReceiveAddress} = lib;
const assert: typeof lib.assert = lib.assert;

const SIGNATURE = 'E2eSoLhIsToRy1111111111111111111111111111111';
const PEER = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const SLOT = 250_000_000;
const START_LAMPORTS = 5_000_000_000; // 5 SOL before
const SENT_LAMPORTS = 2_000_000_000; // 2 SOL transferred out
const FEE_LAMPORTS = 5_000; // the fee this wallet paid, included in its net delta

describe('flow 108 — a Solana transaction lands in the Transactions tab beside the IC rail', () => {
  it('SOL row in SOL units + short counterparty, the ∂ faucet row coexists, per-rail filters', async () => {
    const m = await onboardWallet('jest-sol-history'); // also mints the ∂100 DEMO faucet row

    // The stub answers "no activity" until the app tells us its derived address (__E2E_SOL_OWNER).
    G.__E2E_SOL_OWNER = null;
    const cfg = {signature: SIGNATURE, slot: SLOT, peer: PEER, startLamports: START_LAMPORTS, sentLamports: SENT_LAMPORTS, feeLamports: FEE_LAMPORTS};
    G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
      getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: START_LAMPORTS - SENT_LAMPORTS - FEE_LAMPORTS, token: null}),
      getBalance: () => ({value: START_LAMPORTS - SENT_LAMPORTS - FEE_LAMPORTS}),
      getAccountInfo: () => ({value: null}),
      getSignaturesForAddress: (params: unknown[]) => (params[0] === G.__E2E_SOL_OWNER
        ? [{signature: cfg.signature, slot: cfg.slot}]
        : []),
      // A real `getTransaction` body: direction + amount are read off the BALANCE DELTAS.
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
        transaction: {message: {accountKeys: [G.__E2E_SOL_OWNER, cfg.peer]}},
      }),
    });

    // Select SOL, then read the address the device actually derived (Receive ▸ My address) and key
    // the stub to it — the row is attributed to the real signing account.
    await lib.openBalances(m);
    await lib.selectCurrency(m, 'sol', {timeoutMs: 8000});
    await openReceiveAddress(m);
    const solAddress = m.driver.readText('sol-receive-address');
    expect(solAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    G.__E2E_SOL_OWNER = solAddress;

    // The Transactions tab — the ONE surface both rails render through.
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    await m.driver.findByTestID('ledger-view', {timeoutMs: 5000});

    // 1. The SOL row lands, in SOL units: 2 SOL + the 5000-lamport fee is the net that left.
    assert(await m.driver.waitForText('2.000005 SOL', {timeoutMs: 10_000}),
      `the SOL transaction should appear in the Transactions tab. ledger text:\n${m.driver.readText('ledger-view').slice(0, 800)}`);
    const ledger = m.driver.readText('ledger-view');
    assertIncludes(ledger, '−2.000005 SOL', 'the SOL row renders as an outgoing amount in SOL units');

    // 2. The counterparty is the short form of the address the lamports moved to.
    assertIncludes(ledger, `${PEER.slice(0, 8)}…`, 'the SOL row names the counterparty it moved lamports to');

    // 3. The IC rail is untouched: the onboarding faucet mint still renders, in ∂.
    assertIncludes(ledger, '+∂100.00', 'the IC rail’s faucet row is still listed, in its own ∂ units');

    // 4. One filter chip per present asset, across both rails.
    await m.driver.findByTestID('ledger-filter-sol', {timeoutMs: 5000});
    await m.driver.findByTestID('ledger-filter-$', {timeoutMs: 5000});

    // Filtering to SOL leaves the IC row out — the chip filters on the row's AssetId.
    await m.driver.click('ledger-filter-sol', {timeoutMs: 5000});
    const filtered = m.driver.readText('ledger-view');
    assertIncludes(filtered, '−2.000005 SOL', 'the SOL row survives its own filter');
    expect(filtered).not.toContain('+∂100.00');

    await m.unmount();
  }, 150_000);
});
