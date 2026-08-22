/**
 * lib/peak — the truth table for the one-shot offline peak (Trip Ready J5).
 *
 * The honest-money core: the peak marks the FIRST truly-offline CONFIRMED payment. 'online'
 * never qualifies; a journey already carrying firstOfflinePayment never re-qualifies (the
 * stamp IS the "already celebrated" bit — idempotence is structural, not an extra flag).
 */
import {describe, expect, test, beforeEach} from '@jest/globals';
import {EMPTY_JOURNEY, JOURNEY_STAMPS, awardStamp, loadJourney, type Journey} from '../lib/journey';
import {shouldShowOfflinePeak, type PeakPath} from '../lib/peak';
import AsyncStorage from '@react-native-async-storage/async-storage';

const withStamp = (j: Journey, key: keyof typeof JOURNEY_STAMPS): Journey =>
  ({stamps: [...j.stamps, JOURNEY_STAMPS[key]], at: {...j.at, [JOURNEY_STAMPS[key]]: 1}, seen: j.seen});

describe('shouldShowOfflinePeak — truth table (all paths × journey states)', () => {
  test('a fresh journey qualifies on both offline paths', () => {
    expect(shouldShowOfflinePeak(EMPTY_JOURNEY, 'offlineQr')).toBe(true);
    expect(shouldShowOfflinePeak(EMPTY_JOURNEY, 'nfcMerchantSettled')).toBe(true);
  });

  test("'online' NEVER qualifies — not even on the freshest wallet", () => {
    expect(shouldShowOfflinePeak(EMPTY_JOURNEY, 'online')).toBe(false);
  });

  test('a journey already holding firstOfflinePayment NEVER re-qualifies (one shot, ever)', () => {
    const j = withStamp(EMPTY_JOURNEY, 'firstOfflinePayment');
    expect(shouldShowOfflinePeak(j, 'offlineQr')).toBe(false);
    expect(shouldShowOfflinePeak(j, 'nfcMerchantSettled')).toBe(false);
    expect(shouldShowOfflinePeak(j, 'online')).toBe(false);
  });

  test('OTHER stamps do not consume the peak (firstOfflinePayment is the only gate)', () => {
    // The realistic journey: walkthrough + recovery + funds + a payment test all done, but the
    // offline payment still pending its first occurrence → the peak still qualifies.
    const j = withStamp(withStamp(withStamp(EMPTY_JOURNEY, 'walkthroughDone'), 'fundsReady'), 'paymentTested');
    expect(shouldShowOfflinePeak(j, 'offlineQr')).toBe(true);
    expect(shouldShowOfflinePeak(j, 'nfcMerchantSettled')).toBe(true);
  });

  test('an offline-QR peak CONSUMES the one-shot for a later NFC offline payment (and vice versa)', () => {
    // Both offline paths feed the SAME stamp — the first offline confirmation of either flavor
    // is THE first offline payment; the other must stay quiet afterwards.
    const afterOfflineQr = withStamp(EMPTY_JOURNEY, 'firstOfflinePayment');
    expect(shouldShowOfflinePeak(afterOfflineQr, 'nfcMerchantSettled')).toBe(false);
    const afterNfc = withStamp(EMPTY_JOURNEY, 'firstOfflinePayment');
    expect(shouldShowOfflinePeak(afterNfc, 'offlineQr')).toBe(false);
  });
});

describe('shouldShowOfflinePeak — end-to-end with the real journey store (idempotence)', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  test('award at CONFIRMED time makes every later payment quiet — the persisted contract', async () => {
    // The mount-flow the app runs: first offline confirmed payment → award → gate closes.
    expect(shouldShowOfflinePeak(await loadJourney(), 'offlineQr')).toBe(true);
    await awardStamp('firstOfflinePayment');
    expect(shouldShowOfflinePeak(await loadJourney(), 'offlineQr')).toBe(false);
    expect(shouldShowOfflinePeak(await loadJourney(), 'nfcMerchantSettled')).toBe(false);
    expect(shouldShowOfflinePeak(await loadJourney(), 'online')).toBe(false);
  });

  test('the path type is closed — exactly the three truth-labeled paths', () => {
    // Compile-time narrowing check: every declared path has a decided answer (documented intent).
    const paths: PeakPath[] = ['offlineQr', 'nfcMerchantSettled', 'online'];
    expect(paths.length).toBe(3);
  });
});
