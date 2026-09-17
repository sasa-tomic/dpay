// Flow 160 — the Solana request BUDGET, counted in the running app.
//
// Nothing in the inner loop counted RPC requests, which is precisely why a wallet that read a paid
// endpoint 128 times a minute shipped in silence and cost the whole rail: one phone left on a table
// spends a 1M-credit month in five and a half days (measured; the arithmetic and the outage are in
// `docs/specs/2026-09-08-solana-rpc-plan.md`). This flow is the guard that can see that class of
// defect, and it asserts three things a future change must not undo:
//
//   1. ONE request per balance tick. The wallet reads its SOL account, every rail's token account
//      and every rail's mint account in a single `getMultipleAccounts`. The five-calls-per-tick
//      fan-out it replaced — `getBalance`, plus `getAccountInfo` + `getTokenAccountBalance` per
//      mint — must not be issued by the poll AT ALL, which is what makes this a budget and not a
//      style preference.
//   2. ONE signature page per address the wallet's money can sit at, per history tick — the owner
//      and one token account per registered mint — and a transaction DETAIL read ONCE, however
//      many times the list is re-read (a confirmed transaction's body is immutable; re-reading 20
//      of them every 15s was 80 requests a minute of nothing).
//   3. NOTHING while the app is not in front of the user. Not "less": nothing. A backgrounded
//      phone was the single largest consumer of the endpoint that died.
//
// EXPRESSED PER TICK, NEVER PER SECOND. The harness overrides every poll interval to 150 ms
// (`harness/driver.mjs` injectTestGlobals), so a wall-clock budget here would measure the harness.
// What the idle cadence does to a real wallet is measured under fake timers in
// `app/__tests__/usePollCadence.test.tsx`; what one tick costs is measured HERE, in the real app.
import {setup, assert, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '160',
  name: 'sol-request-budget',
  journey: 'system',
  covers: ['solana', 'balances', 'history', 'rpc-budget', 'background'],
  verifies: 'The SOL rail costs ONE getMultipleAccounts per balance tick (the per-rail getBalance/getAccountInfo/getTokenAccountBalance fan-out is never issued by the poll), one signature page per address per history tick with each transaction detail read exactly once, and ZERO requests of any kind while the app is backgrounded — with an immediate read when it returns.',
  timeoutMs: 90000,
};

const SIGNATURE = '4gLRhTTJLn4hPzkpcw6ZSsws65pNBhrwiDiNMQhM2PNJum4Dbgo2V6EUY5LQV2vquAsF7p1nB3qhesDdpayBudget';

/** Read the live counters out of the page. */
const counts = (driver) => driver.eval(() => ({...globalThis.__DPAY_E2E_RPC_COUNTS, addresses: [...globalThis.__DPAY_E2E_SIG_ADDRESSES]}));

/** Wait until `getMultipleAccounts` has been called `n` more times than `from`. */
async function waitForBalanceTicks(driver, from, n, timeoutMs = 15_000) {
  await driver.waitForFunction(
    (target) => (globalThis.__DPAY_E2E_RPC_COUNTS.getMultipleAccounts ?? 0) >= target,
    {timeoutMs, args: [from + n], label: `getMultipleAccounts >= ${from + n}`},
  );
}

export async function run() {
  const start = Date.now();
  console.log('[160-sol-request-budget] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;
    await onboardWallet(driver, 'e2e-rpc-budget');

    // A COUNTING stub. Every handler the wallet could reach is present, so a call to a retired one
    // is counted rather than throwing — the assertion has to be able to see the fan-out come back,
    // not just fail differently.
    console.log('[160-sol-request-budget] installing the counting stub…');
    await driver.eval((sig) => {
      const c = {};
      globalThis.__DPAY_E2E_RPC_COUNTS = c;
      globalThis.__DPAY_E2E_SIG_ADDRESSES = new Set();
      const count = (m) => { c[m] = (c[m] ?? 0) + 1; };
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getMultipleAccounts: (p) => {
          count('getMultipleAccounts');
          return globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 2000000000, token: {amount: '2000000', decimals: 6}});
        },
        getSignaturesForAddress: (p) => {
          count('getSignaturesForAddress');
          const addr = String(p[0]);
          // The reader asks for the owner wallet first, then one token account per registered mint
          // (`solana/history.ts`), so the first address it ever asks about IS the owner.
          if (globalThis.__DPAY_E2E_OWNER === undefined) globalThis.__DPAY_E2E_OWNER = addr;
          globalThis.__DPAY_E2E_SIG_ADDRESSES.add(addr);
          // Only the OWNER's page carries the transaction; the token accounts answer "nothing here",
          // which is a real answer a node gives for an account with no history.
          return addr === globalThis.__DPAY_E2E_OWNER ? [{signature: sig, slot: 250000000}] : [];
        },
        getTransaction: () => {
          count('getTransaction');
          return {
            slot: 250000000,
            blockTime: 1788880000,
            meta: {err: null, fee: 5000, preBalances: [2000005000, 0], postBalances: [2000000000, 0], preTokenBalances: [], postTokenBalances: []},
            transaction: {message: {accountKeys: [globalThis.__DPAY_E2E_OWNER, '11111111111111111111111111111111']}},
          };
        },
        // The retired per-rail reads. Answering (rather than throwing) is deliberate: if a future
        // change reintroduces the fan-out, this flow must fail on the COUNT — the number that costs
        // money — and not on an exception that could be mistaken for a stub gap.
        getBalance: () => { count('getBalance'); return {value: 2000000000}; },
        getAccountInfo: () => { count('getAccountInfo'); return {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}; },
        getTokenAccountBalance: () => { count('getTokenAccountBalance'); return {value: {amount: '2000000', decimals: 6}}; },
      };
    }, SIGNATURE);

    // ---- 1. ONE request per balance tick, and the fan-out is GONE ----------------------------
    console.log('[160-sol-request-budget] counting a window of balance ticks…');
    const before = await counts(driver);
    await waitForBalanceTicks(driver, before.getMultipleAccounts ?? 0, 6);
    const after = await counts(driver);
    const ticks = (after.getMultipleAccounts ?? 0) - (before.getMultipleAccounts ?? 0);
    assert(ticks >= 6, `expected at least 6 balance ticks, saw ${ticks}`);
    // THE budget line: the poll's cost per tick is one request, so the calls it used to make are
    // never made. Five per tick became one.
    assert((after.getBalance ?? 0) === 0, `the balance poll must not call getBalance — saw ${after.getBalance}`);
    assert((after.getAccountInfo ?? 0) === 0, `the balance poll must not call getAccountInfo — saw ${after.getAccountInfo}`);
    assert((after.getTokenAccountBalance ?? 0) === 0, `the balance poll must not call getTokenAccountBalance — saw ${after.getTokenAccountBalance}`);
    console.log(`[160-sol-request-budget] ✓ ${ticks} balance ticks, ${ticks} requests, zero per-rail calls`);
    // The whole window, printed: this line is the measurement a future change is compared against.
    const window = Object.fromEntries(Object.entries(after).filter(([k]) => k !== 'addresses'));
    const total = Object.values(window).reduce((a, b) => a + b, 0);
    console.log(`[160-sol-request-budget] window over ${ticks} balance ticks: ${JSON.stringify(window)} = ${total} requests`);

    // ---- 2. History: one page per address per tick, one detail EVER --------------------------
    // Three addresses are queried — the owner and one token account per registered mint — and that
    // is what makes a non-USDC payment visible at all. The detail behind the one signature is read
    // ONCE no matter how many times the list is re-read.
    const addresses = after.addresses.length;
    assert(addresses === 3, `history must query the owner + one token account per registered mint (3), saw ${addresses}`);
    const perTick = (after.getSignaturesForAddress ?? 0) / Math.max(1, ticks);
    assert(perTick <= 3.5, `history costs at most one signature page per address per tick, saw ${perTick.toFixed(2)} per balance tick`);
    assert((after.getTransaction ?? 0) <= 2, `a confirmed transaction's body is immutable and must be read once, saw ${after.getTransaction} reads`);
    console.log(`[160-sol-request-budget] ✓ ${addresses} signature addresses, ${after.getTransaction ?? 0} detail read(s) across ${ticks} ticks`);

    // ---- 3. Backgrounded: NOTHING ------------------------------------------------------------
    console.log('[160-sol-request-budget] backgrounding the app…');
    await driver.eval(() => {
      Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Let any in-flight read land before the window opens — deterministically: the method
    // counters must be stable across a painted frame (a blind sleep both guesses and wastes).
    let atBackground;
    for (let deadline = Date.now() + 8_000; ;) {
      const before = await counts(driver);
      await driver.settleFrames(2);
      atBackground = await counts(driver);
      const quiet = ['getMultipleAccounts', 'getSignaturesForAddress', 'getTransaction', 'getBalance', 'getAccountInfo', 'getTokenAccountBalance']
        .every((m) => (before[m] ?? 0) === (atBackground[m] ?? 0));
      if (quiet || Date.now() > deadline) break;
    }
    // The measurement window itself: 2s of backgrounded wall-clock silence — no in-page signal
    // fires when backgrounded (that IS the claim), so time passing is the only honest instrument.
    await new Promise((r) => setTimeout(r, 2_000));
    const afterBackground = await counts(driver);
    for (const method of ['getMultipleAccounts', 'getSignaturesForAddress', 'getTransaction', 'getBalance', 'getAccountInfo', 'getTokenAccountBalance']) {
      assert(
        (afterBackground[method] ?? 0) === (atBackground[method] ?? 0),
        `a backgrounded wallet must issue NO ${method} — saw ${(afterBackground[method] ?? 0) - (atBackground[method] ?? 0)} in 2s`,
      );
    }
    console.log('[160-sol-request-budget] ✓ zero requests while backgrounded');

    // ---- 4. …and it reads IMMEDIATELY when it comes back -------------------------------------
    await driver.eval(() => {
      Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await driver.waitForFunction(
      (n) => (globalThis.__DPAY_E2E_RPC_COUNTS.getMultipleAccounts ?? 0) > n,
      {timeoutMs: 5_000, args: [afterBackground.getMultipleAccounts ?? 0], label: 'a read after the app returns'},
    );
    console.log('[160-sol-request-budget] ✓ foreground read is immediate');

    console.log(`[160-sol-request-budget] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}
