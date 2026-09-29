/**
 * Flow 160 sol-request-budget — the jest twin of `e2e/tests/160-sol-request-budget.mjs`
 * (batch-E gap fix: the per-tick RPC CENSUS the first migration pass dropped).
 *
 * Nothing in the inner loop counted RPC requests, which is precisely why a wallet that read a
 * paid endpoint 128 times a minute shipped in silence and cost the whole rail (the arithmetic
 * and the outage: `docs/specs/2026-09-08-solana-rpc-plan.md`). This file is the guard that can
 * see that class of defect, counted in the RUNNING app through a counting
 * `__DPAY_TEST_SOLANA_RPC_STUB` (delta-based, reset per test), and it asserts three things a
 * future change must not undo:
 *
 *   1. ONE `getMultipleAccounts` per balance tick — the wallet account, every rail's token
 *      account and every rail's mint in a single call. The five-calls-per-tick fan-out it
 *      replaced (`getBalance`, plus `getAccountInfo` + `getTokenAccountBalance` per mint) must
 *      not be issued by the poll AT ALL, which is what makes this a budget and not a style
 *      preference. The retired methods are ANSWERED, not thrown: a reintroduced fan-out must
 *      fail on the COUNT — the number that costs money — not on an exception.
 *   2. ONE signature page per address the wallet's money can sit at, per history tick — the
 *      owner plus one token account per registered mint (3) — and a transaction DETAIL read
 *      once, however many times the list is re-read (a confirmed transaction's body is
 *      immutable; re-reading 20 of them every 15s was 80 requests a minute of nothing).
 *   3. NOTHING while the app is backgrounded — not "less": nothing (a backgrounded phone was
 *      the single largest consumer of the endpoint that died) — and an immediate read when it
 *      returns.
 *
 * Coverage split (fidelity mandate — no duplication): the IDLE/ACTIVE cadence itself (what the
 * tick SCHEDULE does over time, under fake timers) is pinned in `__tests__/usePollCadence.test.tsx`,
 * and the balance seam's hook logic in `__tests__/useSolanaBalances.test.tsx`. What this file
 * adds is the real app's end-to-end request count — the number that costs money.
 *
 * EXPRESSED PER TICK, NEVER PER SECOND: the harness overrides every poll interval to 25 ms
 * (`flow/harness/setupFlow.ts`), so a wall-clock budget here would measure the harness.
 *
 * Not ported (browser-only): the `document.visibilityState` event — AppState is the ONE code
 * path on RN (`hooks/useAppActive.ts`); the driver replays 'background'/'active' through it.
 */
import {it, expect, beforeEach} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
// FIRST: settings/solStub.ts sets `__DPAY_TEST_SOLANA_RPC_URL = 'stub'` in its module body —
// config/constants.ts captures the URL at module load and the App graph loads with the harness
// import below; the per-call stub is installed afterwards (runtime seam).
import {installSolAccountsHelper} from '../settings/solStub';
import {onboardWallet, type Mount} from '../harness/lib';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const g = globalThis as unknown as Record<string, unknown>;

installSolAccountsHelper();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SIGNATURE = '4gLRhTTJLn4hPzkpcw6ZSsws65pNBhrwiDiNMQhM2PNJum4Dbgo2V6EUY5LQV2vquAsF7p1nB3qhesDdpayBudget';

/** Every method the census watches — the six the polls could conceivably reach. */
const COUNTED = [
  'getMultipleAccounts', 'getSignaturesForAddress', 'getTransaction',
  'getBalance', 'getAccountInfo', 'getTokenAccountBalance',
] as const;
type Counts = Record<(typeof COUNTED)[number], number>;

const counts: Counts = {
  getMultipleAccounts: 0, getSignaturesForAddress: 0, getTransaction: 0,
  getBalance: 0, getAccountInfo: 0, getTokenAccountBalance: 0,
};
const sigAddresses = new Set<string>();
let owner: string | null = null;

/** A COUNTING stub. Every handler the wallet could reach is present, so a call to a retired one
 *  is counted rather than throwing — the assertion has to see the fan-out come back. */
function installCountingStub(): void {
  for (const m of COUNTED) counts[m] = 0;
  sigAddresses.clear();
  owner = null;
  g.__DPAY_TEST_SOLANA_RPC_STUB = {
    getMultipleAccounts: (p: unknown[]) => {
      counts.getMultipleAccounts += 1;
      return (g.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p,
        {lamports: 2000000000, token: {amount: '2000000', decimals: 6}});
    },
    getSignaturesForAddress: (p: unknown[]) => {
      counts.getSignaturesForAddress += 1;
      const addr = String(p[0]);
      // The reader asks for the owner wallet first, then one token account per registered mint
      // (`solana/history.ts`), so the first address it ever asks about IS the owner.
      if (owner === null) owner = addr;
      sigAddresses.add(addr);
      // Only the OWNER's page carries the transaction; the token accounts answer "nothing here",
      // a real answer a node gives for an account with no history.
      return addr === owner ? [{signature: SIGNATURE, slot: 250000000}] : [];
    },
    getTransaction: () => {
      counts.getTransaction += 1;
      return {
        slot: 250000000,
        blockTime: 1788880000,
        meta: {err: null, fee: 5000, preBalances: [2000005000, 0], postBalances: [2000000000, 0], preTokenBalances: [], postTokenBalances: []},
        transaction: {message: {accountKeys: [owner ?? '', '11111111111111111111111111111111']}},
      };
    },
    // The retired per-rail reads (see the header: counted, never thrown).
    getBalance: () => {
      counts.getBalance += 1;
      return {value: 2000000000};
    },
    getAccountInfo: () => {
      counts.getAccountInfo += 1;
      return {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}};
    },
    getTokenAccountBalance: () => {
      counts.getTokenAccountBalance += 1;
      return {value: {amount: '2000000', decimals: 6}};
    },
  };
}

/** Wait until `getMultipleAccounts` has been called `n` more times than `from` (the counters are
 *  this module's own closure state — no mount handle needed). */
async function waitForBalanceTicks(from: number, n: number, timeoutMs = 15_000): Promise<void> {
  const deadline = budgetDeadline(timeoutMs); // positive transition (poll ticks landing) — budget-scaled
  for (;;) {
    if (counts.getMultipleAccounts >= from + n) return;
    if (Date.now() > deadline) {
      throw new Error(`[160] getMultipleAccounts never reached ${from + n} within ${timeoutMs}ms (at ${counts.getMultipleAccounts})`);
    }
    await sleep(10);
  }
}

/** Let any in-flight read land before a measurement window opens — deterministically: the
 *  counters must be stable across a painted frame (a blind sleep both guesses and wastes). */
async function quietCounts(m: Mount): Promise<Counts> {
  const deadline = budgetDeadline(8000); // positive transition (counters settling) — budget-scaled
  for (;;) {
    const before = {...counts};
    await m.driver.settleFrames(2);
    const after = {...counts};
    if (COUNTED.every((k) => before[k] === after[k]) || Date.now() > deadline) return after;
  }
}

beforeEach(() => {
  installCountingStub();
});

hermeticDescribe('flow 160 — the Solana request budget, counted in the running app', () => {
  it('ONE getMultipleAccounts per balance tick (fan-out gone), one page per address per history tick, detail read once', async () => {
    const m = await onboardWallet('e2e-rpc-budget');

    // ---- 1. ONE request per balance tick, and the fan-out is GONE ----------------------------
    const before = {...counts};
    await waitForBalanceTicks(before.getMultipleAccounts, 6);
    const after = {...counts};
    const ticks = after.getMultipleAccounts - before.getMultipleAccounts;
    expect(ticks).toBeGreaterThanOrEqual(6);
    // THE budget line: the poll's cost per tick is one request, so the calls it used to make are
    // never made. Five per tick became one.
    expect(after.getBalance).toBe(0);
    expect(after.getAccountInfo).toBe(0);
    expect(after.getTokenAccountBalance).toBe(0);

    // ---- 2. History: one page per address per tick, one detail EVER --------------------------
    // Three addresses are queried — the owner and one token account per registered mint — and
    // that is what makes a non-USDC payment visible at all. The detail behind the one signature
    // is read ONCE no matter how many times the list is re-read. (Both sides are DELTAS over the
    // same window: the e2e twin's absolute numerator works only because its stub installs after
    // onboarding; this file's stub is live from beforeEach, so pre-window pages must be
    // subtracted — the same census, measured honestly.)
    expect(sigAddresses.size).toBe(3);
    const pages = after.getSignaturesForAddress - before.getSignaturesForAddress;
    const perTick = pages / Math.max(1, ticks);
    expect(perTick).toBeLessThanOrEqual(3.5);
    expect(after.getTransaction).toBeLessThanOrEqual(2);

    await m.unmount();
  }, 120_000);

  it('ZERO requests of any kind while backgrounded, and an immediate read when it returns', async () => {
    const m = await onboardWallet('e2e-rpc-budget-bg');
    await waitForBalanceTicks(counts.getMultipleAccounts, 2);

    // ---- 3. Backgrounded: NOTHING ------------------------------------------------------------
    await m.driver.background();
    const atBackground = await quietCounts(m);
    // The measurement window: 2s of backgrounded wall-clock silence — no in-app signal fires
    // when backgrounded (that IS the claim), so time passing is the only honest instrument.
    await sleep(2000);
    for (const method of COUNTED) {
      expect(counts[method]).toBe(atBackground[method]);
    }

    // ---- 4. …and it reads IMMEDIATELY when it comes back -------------------------------------
    await m.driver.foreground();
    await m.driver.waitForFunction(() => counts.getMultipleAccounts > atBackground.getMultipleAccounts,
      {timeoutMs: 5000, label: 'a read after the app returns'});

    await m.unmount();
  }, 60_000);
});
