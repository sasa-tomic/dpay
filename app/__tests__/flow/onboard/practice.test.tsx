/**
 * Flows 152 + 153 + 156 — the first-run practice payment — the jest twins of
 * `e2e/tests/152-practice-payment.mjs`, `153-practice-not-settled.mjs`, `156-restore-skips-practice.mjs`.
 * (Practice.test.tsx pins the sheet component; this ports the cold-boot router legs.)
 *
 * 152: the request card → the REAL Pay review → settle → ∂99.00 measured on the relay's ledger;
 *      flowUnderstood stamped, paymentTested left for a real counterparty, Continue → currency.
 * 153: a practice payment that does not settle never claims that it did — UNKNOWN (read_state polls
 *      blocked after the /call lands: the ledger DID move the money, the screen claims nothing,
 *      no stamp) and REJECTED (the wallet is told it has money it does not have, so the LEDGER
 *      refuses and the screen quotes the decoded reason over an unmoved balance).
 * 156: a RESTORED wallet skips practice forever (the seen marker persists across launches).
 *
 * Port deviations (same semantics, harness-gap note for the integrator):
 * - 153 REJECTED used a second faucet-less relay (`startRelay({faucet:false})`) — jest's harness
 *   spawns exactly ONE relay (globalSetup) and must not import e2e/harness/*.mjs. The same ledger
 *   refusal is produced over the ONE relay by failing the create-time faucet POST (ledger stays at
 *   zero) and stubbing /api/v1/balances/ to fake ∂100 — the refusal then comes from the LEDGER,
 *   not from a local guard, which is the property under test.
 * - The `localStorage` journey reads go through AsyncStorage (its RNW backing store); the
 *   `window.fetch` stubs wrap the harness's recorder fetch; failures are pre-declared.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {mountApp, type Mount} from '../harness/mount';
import {
  accountOf, assertIncludes, chooseHomeCurrencyIfPresent, getBalance,
  skipPracticeIfPresent, skipWalkthroughIfPresent, waitForEnabled, waitForWallet,
} from '../harness/lib';
import {relayBaseURL} from '../harness/relayClient';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {
  getItem: (k: string) => Promise<string | null>;
  clear: () => Promise<void>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Journey = {stamps: string[]; seen?: string[]} | null;
async function readJourney(): Promise<Journey> {
  const raw = await AsyncStorage.getItem('dpay.journey.v1');
  return raw ? JSON.parse(raw) as Journey : null;
}

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

/** Walk a fresh context from the walkthrough to the practice request card (the twin's helper). */
async function onboardToPractice(m: Mount, name: string): Promise<void> {
  await skipWalkthroughIfPresent(m);
  await m.driver.typeByPlaceholder('e.g. Alice', name, {timeoutMs: 8000});
  await m.driver.click('btn-create', {timeoutMs: 4000});
  await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
  await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
  await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
  await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});
  await m.driver.findByTestID('practice', {timeoutMs: 15_000});
}

/** The seen marker rides an async store write (journey.ts markSeen) — poll the PERSISTED store. */
async function seenEventually(marker: string, timeoutMs = 5000): Promise<string[]> {
  const deadline = budgetDeadline(timeoutMs); // positive transition (the persisted write) — budget-scaled
  for (;;) {
    const seen = (await readJourney())?.seen ?? [];
    if (seen.includes(marker)) return seen;
    if (Date.now() > deadline) return seen;
    await sleep(50);
  }
}

hermeticDescribe('flow 152 — practice-payment', () => {
  it('shop request ∂1.00 → the real review → settles → ∂99.00 on the ledger; flowUnderstood stamped, paymentTested not', async () => {
    const m = await mountApp();

    // Onboard by hand — `onboardWallet` LEAVES practice, and practice is the subject here.
    await onboardToPractice(m, 'e2e-practice');

    // 1. The request card — a shop's code, with the real polled balance above it.
    await m.driver.findByTestID('practice-card', {timeoutMs: 8000});
    assertIncludes(m.driver.readText('practice-card'), 'Practice shop', 'the request card names the payee');
    assertIncludes(m.driver.readText('practice-card'), '∂1.00', 'the request card names the amount');
    expect(await m.driver.waitForText('∂100.00', {timeoutMs: 10_000})).toBe(true);
    assertIncludes(m.driver.readText('practice-balance'), '∂100.00', 'the header carries the REAL polled practice balance');

    // 2. The review is the Pay tab's own review — same component, same testIDs.
    await m.driver.click('btn-practice-review', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-approve', {timeoutMs: 8000});
    assertIncludes(m.driver.readText('pay-amount'), '∂1.00', 'the review names the exact amount');
    expect(m.driver.isPresent('btn-review-cancel')).toBe(true);
    expect(m.driver.isPresent('practice-fee')).toBe(true);

    // 3. Approve → the ledger settles it.
    await m.driver.click('btn-approve', {timeoutMs: 5000});
    await m.driver.findByTestID('practice-outcome', {timeoutMs: 30_000});
    expect(m.driver.readText('practice-outcome-body')).toBe(
      'A real payment: your phone signed it and the practice ledger settled it.');
    // The "what is left" line never delays the confirmed mark — it pops in when the relay answers
    // (Practice.tsx). Await the pop-in, then read the measured number.
    await m.driver.findByTestID('practice-left', {timeoutMs: 8000});
    assertIncludes(m.driver.readText('practice-left'), '∂99.00', 'the remaining balance is measured, not assumed');

    // 4. The money moved on a ledger the app does not control.
    const identity = await accountOf(m);
    expect(identity && typeof identity.publicHex === 'string').toBe(true);
    expect(await getBalance(identity!.publicHex, 0)).toBe('9900');

    // 5. The stamps: seeing the flow, not paying a counterparty.
    const j = await readJourney();
    expect(j).not.toBeNull();
    expect(j!.stamps.includes('flowUnderstood')).toBe(true);
    expect(j!.stamps.includes('paymentTested')).toBe(false);

    // 6. One exit, onto the currency question.
    await m.driver.click('btn-practice-continue', {timeoutMs: 5000});
    await m.driver.findByTestID('home-currency-title', {timeoutMs: 10_000});
    expect(await seenEventually('firstRunPractice')).toContain('firstRunPractice');

    await m.unmount();
  }, 90_000);
});

hermeticDescribe('flow 153 — practice-not-settled', () => {
  it('UNKNOWN: money moved, screen claims nothing, no stamp — REJECTED: the ledger\'s own reason over an unmoved balance', async () => {
    const harnessFetch = g.fetch as typeof fetch;
    const declared = relayBaseURL();
    {
      const m = await mountApp();
      m.driver.allowRequestFailuresFrom(declared);

      // ---- A. UNKNOWN: the payment happens, and the app cannot see that it did. ---------------
      await onboardToPractice(m, 'e2e-unknown');
      // Arm the block only AFTER the submission lands: the clock the envelope is stamped with is
      // itself a read_state, and blocking that would refuse the signature instead of the reading —
      // a different failure, and not the one under test.
      g.__DPAY_BLOCK_READ_STATE = false;
      g.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (g.__DPAY_BLOCK_READ_STATE === true && /\/read_state$/.test(url)) {
          throw new TypeError('[153] read_state blocked: the payment is submitted and unreadable');
        }
        const response = await harnessFetch(input as RequestInfo, init);
        if (/\/call$/.test(url)) g.__DPAY_BLOCK_READ_STATE = true;
        return response;
      }) as typeof fetch;

      const identity = await accountOf(m);
      expect(identity && typeof identity.publicHex === 'string').toBe(true);
      const stampsBefore = [...((await readJourney())?.stamps ?? [])].sort();

      await m.driver.click('btn-practice-review', {timeoutMs: 5000});
      await m.driver.click('btn-approve', {timeoutMs: 8000});
      await m.driver.findByTestID('practice-outcome', {timeoutMs: 40_000});

      expect(m.driver.readText('practice-outcome-body')).toBe(
        'Signed and sent, not yet settled — nothing is confirmed. This is what a real pending payment looks like.');
      const unknownScreen = m.driver.readText('practice-outcome');
      expect(unknownScreen.includes('the ledger settled it')).toBe(false);
      expect(m.driver.isPresent('practice-left')).toBe(false);
      const stampsAfter = [...((await readJourney())?.stamps ?? [])].sort();
      expect(stampsAfter.join(',')).toBe(stampsBefore.join(','));
      expect(stampsAfter.includes('paymentTested')).toBe(false);
      expect(m.driver.isPresent('btn-practice-continue')).toBe(true);

      // The payment was REAL: the relay's own ledger moved while the screen refused to say so.
      expect(await getBalance(identity!.publicHex, 0)).toBe('9900');
      await m.unmount();
    }

    // ---- B. REJECTED: the LEDGER refuses, and the screen quotes it. ---------------------------
    {
      // Fresh incognito context (the twin's clearStorage + navigate). The ledger must stay at
      // zero: fail the create-time faucet POST (the faucet-less relay's job in the twin), and
      // tell the wallet it has practice money it does not have.
      await AsyncStorage.clear();
      g.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/api\/v1\/faucet/.test(url)) {
          return new Response(JSON.stringify({error: 'faucet cooldown: try again in ~59 min'}), {status: 429, headers: {'Content-Type': 'application/json'}});
        }
        if (/\/api\/v1\/balances\//.test(url)) {
          return new Response(JSON.stringify({'0': '10000'}), {status: 200, headers: {'Content-Type': 'application/json'}});
        }
        return harnessFetch(input as RequestInfo, init);
      }) as typeof fetch;

      const m = await mountApp();
      m.driver.allowRequestFailuresFrom(declared);
      await onboardToPractice(m, 'e2e-refused');
      const refusedIdentity = await accountOf(m);
      const refusedBefore = [...((await readJourney())?.stamps ?? [])].sort();
      await m.driver.click('btn-practice-review', {timeoutMs: 5000});
      await m.driver.click('btn-approve', {timeoutMs: 8000});
      await m.driver.findByTestID('practice-outcome', {timeoutMs: 40_000});

      expect(m.driver.readText('practice-outcome-body')).toBe('Nothing moved.');
      assertIncludes(m.driver.readText('practice-refused-reason'), 'Not enough balance',
        'the reason is the LEDGER\'s own decoded refusal, not a generic error');
      const refusedAfter = [...((await readJourney())?.stamps ?? [])].sort();
      expect(refusedAfter.join(',')).toBe(refusedBefore.join(','));
      expect(m.driver.isPresent('btn-practice-continue')).toBe(true);

      // Out-of-band ledger truth: probe the relay through the PRE-stub fetch (the stubbed
      // /api/v1/balances/ answer is the lie under test — the ledger is the oracle).
      const probe = await harnessFetch(`${relayBaseURL()}/api/v1/balances/${refusedIdentity!.publicHex}`);
      const ledger = (await probe.json()) as Record<string, string>;
      expect(ledger['0']).toBe('0');
      await m.unmount();
    }
    g.fetch = harnessFetch;
  }, 120_000);});

hermeticDescribe('flow 156 — restore-skips-practice', () => {
  it('a restored wallet is never shown the practice payment; the seen marker persists across launches', async () => {
    // Mint a real seed the honest way: create a wallet and read its own 24 words off the gate.
    let m = await mountApp();
    await skipWalkthroughIfPresent(m);
    await m.driver.typeByPlaceholder('e.g. Alice', 'e2e-seed-source', {timeoutMs: 8000});
    await m.driver.click('btn-create', {timeoutMs: 4000});
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    const words: string[] = [];
    for (let i = 0; i < 24; i++) {
      words.push(m.driver.readText(`mnemonic-word-${i}`).replace(/^\d+\s*/, '').trim());
    }
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
    await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});
    await skipPracticeIfPresent(m);
    await chooseHomeCurrencyIfPresent(m);
    await waitForWallet(m, {timeoutMs: 12_000});

    // A NEW device: nothing carried over, not even the walkthrough's own stamp.
    await m.unmount();
    await m.driver.clearStorage();
    m = await mountApp();
    await skipWalkthroughIfPresent(m);

    await m.driver.click('btn-restore', {timeoutMs: 5000});
    await m.driver.findByTestID('restore-mnemonic-input', {timeoutMs: 5000});
    await m.driver.type('restore-mnemonic-input', words.join(' '), {timeoutMs: 8000});
    await m.driver.type('username-input', 'e2e-restored', {timeoutMs: 5000});
    await m.driver.click('btn-restore-confirm', {timeoutMs: 5000});

    // Straight to the currency question — practice never mounts.
    await m.driver.findByTestID('home-currency-title', {timeoutMs: 12_000});
    expect(m.driver.isPresent('practice')).toBe(false);
    expect(await seenEventually('firstRunPractice')).toContain('firstRunPractice');

    await chooseHomeCurrencyIfPresent(m);
    await waitForWallet(m, {timeoutMs: 12_000});

    // And it stays gone: the marker is persisted, so the next launch routes past it too.
    await m.remount();
    await waitForWallet(m, {timeoutMs: 12_000});
    expect(m.driver.isPresent('practice')).toBe(false);
    await m.unmount();
  }, 120_000);
});
