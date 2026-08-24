/**
 * Trip Readiness pure logic (Trip Ready J5b) — truth tables for computeReadiness (order
 * stability, next-step selection, capstone), decideFundsReady (the spendable>0 gate:
 * demo funds count, ~approx counts, "—" nulls don't), and awardPaymentTested (one-shot,
 * no-op when stamped). The UI contract is pinned by TripPassport.test.tsx + e2e flow 94.
 */
import {describe, expect, test, beforeEach, jest} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {awardStamp, hasStamp, EMPTY_JOURNEY, type Journey} from '../lib/journey';
import {
  PASSPORT_STAMPS, READINESS_STAMPS, PASSPORT_COLLAPSED_KEY,
  computeReadiness, decideFundsReady, awardPaymentTested,
} from '../lib/readiness';
import type {BalanceView} from '../lib/assetBalances';

function journeyWith(...stamps: string[]): Journey {
  return {stamps, at: Object.fromEntries(stamps.map(s => [s, 1])), seen: []};
}

function view(displayText: string, status: BalanceView['status']): BalanceView {
  return {displayText, status};
}

describe('READINESS_STAMPS / PASSPORT_STAMPS', () => {
  test('the four readiness keys in display order, matching PASSPORT_STAMPS', () => {
    expect(READINESS_STAMPS).toEqual(['recoverySaved', 'flowUnderstood', 'fundsReady', 'paymentTested']);
    expect(PASSPORT_STAMPS.map(s => s.key)).toEqual(READINESS_STAMPS);
  });

  test('every stamp carries non-empty two-line label + hint (the card never renders blanks)', () => {
    for (const s of PASSPORT_STAMPS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.label.includes('\n')).toBe(true);
      expect(s.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('computeReadiness', () => {
  test('empty journey: nothing filled, next = first stamp in ORDER (not award order)', () => {
    const r = computeReadiness(EMPTY_JOURNEY);
    expect(r.filled).toEqual([]);
    expect(r.missing).toEqual(READINESS_STAMPS);
    expect(r.complete).toBe(false);
    expect(r.next?.key).toBe('recoverySaved');
    expect(r.next?.hint).toBe(PASSPORT_STAMPS[0].hint);
  });

  test('filled/missing stay in DISPLAY order regardless of award order', () => {
    // Awarded out of order: paymentTested, fundsReady, recoverySaved.
    const j = journeyWith('paymentTested', 'fundsReady', 'recoverySaved');
    const r = computeReadiness(j);
    expect(r.filled).toEqual(['recoverySaved', 'fundsReady', 'paymentTested']);
    expect(r.missing).toEqual(['flowUnderstood']);
    expect(r.complete).toBe(false);
    // The ONE next step is the first missing in display order.
    expect(r.next?.key).toBe('flowUnderstood');
  });

  test('ignores non-readiness stamps (walkthroughDone/firstOfflinePayment are not slots)', () => {
    const j = journeyWith('walkthroughDone', 'recoverySaved', 'firstOfflinePayment');
    const r = computeReadiness(j);
    expect(r.filled).toEqual(['recoverySaved']);
    expect(r.missing).toEqual(['flowUnderstood', 'fundsReady', 'paymentTested']);
    expect(r.next?.key).toBe('flowUnderstood');
  });

  test('capstone: complete only when ALL four filled; then no next step', () => {
    const r = computeReadiness(journeyWith(...READINESS_STAMPS));
    expect(r.filled).toEqual(READINESS_STAMPS);
    expect(r.missing).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.next).toBeUndefined();
  });

  test('the harness onboarding state (walkthrough skip + recovery + faucet) reads 2 of 4', () => {
    // walkthroughDone is journey chrome, NOT a passport slot — only recoverySaved + fundsReady count.
    const r = computeReadiness(journeyWith('walkthroughDone', 'recoverySaved', 'fundsReady'));
    expect(r.filled).toEqual(['recoverySaved', 'fundsReady']);
    expect(r.missing).toEqual(['flowUnderstood', 'paymentTested']);
    expect(r.next?.key).toBe('flowUnderstood');
  });
});

describe('decideFundsReady', () => {
  test('empty balance map: not ready', () => {
    expect(decideFundsReady({})).toBe(false);
  });

  test('DEMO funded (status ok, real text): ready', () => {
    expect(decideFundsReady({demo: view('∂100.00', 'ok')})).toBe(true);
  });

  test('DEMO null balance ("—" but status ok): NOT ready — no displayable money', () => {
    expect(decideFundsReady({demo: view('—', 'ok')})).toBe(false);
  });

  test('offline approx value (~∂91.00): ready — approximations come from funded reality', () => {
    expect(decideFundsReady({demo: view('~∂91.00', 'ok')})).toBe(true);
  });

  test('zero / unavailable / error / loading / absent never count', () => {
    expect(decideFundsReady({a: view('∂0.00', 'zero')})).toBe(false);
    expect(decideFundsReady({a: view('—', 'unavailable')})).toBe(false);
    expect(decideFundsReady({a: view('—', 'error')})).toBe(false);
    expect(decideFundsReady({a: view('…', 'loading')})).toBe(false);
    expect(decideFundsReady({a: view('—', 'absent')})).toBe(false);
  });

  test('ANY one funded asset in a mixed map flips it true', () => {
    const balances = {
      'ic:0': view('—', 'ok'),
      'ic:1': view('—', 'unavailable'),
      'ic:3': view('~2.50 USDC', 'ok'),
      'solana:SOL': view('—', 'absent'),
    };
    expect(decideFundsReady(balances)).toBe(true);
  });

  test('all-null map (fresh wallet before first poll): false', () => {
    expect(decideFundsReady({'ic:0': view('—', 'ok'), 'ic:1': view('—', 'unavailable')})).toBe(false);
  });
});

describe('awardPaymentTested', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('awards the stamp when missing and persists it', async () => {
    awardPaymentTested(EMPTY_JOURNEY);
    await actAsync();
    expect(hasStamp(await importJourney(), 'paymentTested')).toBe(true);
  });

  test('a confirmed payment ALSO awards flowUnderstood (a real payment IS the flow; the rehearsal is unreachable for pre-arc wallets)', async () => {
    awardPaymentTested(EMPTY_JOURNEY);
    await actAsync();
    const j = await importJourney();
    expect(hasStamp(j, 'flowUnderstood')).toBe(true);
  });

  test('no-op when already stamped (idempotent — call sites stay tiny and fire freely)', async () => {
    const first = await awardStamp('paymentTested');
    awardPaymentTested(first);
    await actAsync();
    const again = await importJourney();
    expect(again.stamps.filter(s => s === 'paymentTested').length).toBe(1);
    expect(again.at.paymentTested).toBe(first.at.paymentTested);
  });

  test('the collapse marker is a seen-key, not a stamp (no census impact)', () => {
    expect(PASSPORT_COLLAPSED_KEY).toBe('passportCollapsed');
  });
});

/** awardStamp is fire-and-forget async; give the write queue + microtask queue a tick. */
async function actAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
  await Promise.resolve();
}

/** Read the persisted journey (post-await so the store settled). */
async function importJourney(): Promise<Journey> {
  const {loadJourney} = await import('../lib/journey');
  return loadJourney();
}

// Keep jest's test-env globals honest (no silent unused import when types tree-shake).
void jest;
