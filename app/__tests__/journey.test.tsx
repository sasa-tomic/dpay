/**
 * journey store (Trip Ready J1) — the persist/idempotency/read contract every later
 * journey wave (recovery moment, passport, celebrations) relies on.
 */
import {describe, expect, test, beforeEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {JOURNEY_STORAGE_KEY} from '../config/constants';
import {
  EMPTY_JOURNEY, JOURNEY_STAMPS, awardStamp, hasStamp, loadJourney, parseJourney,
} from '../lib/journey';

describe('journey store', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('empty store loads as the empty journey', async () => {
    expect(await loadJourney()).toEqual(EMPTY_JOURNEY);
  });

  test('awardStamp persists a round-trip with an award time', async () => {
    const updated = await awardStamp('walkthroughDone');
    expect(updated.stamps).toEqual(['walkthroughDone']);
    expect(typeof updated.at.walkthroughDone).toBe('number');
    const reloaded = await loadJourney();
    expect(reloaded.stamps).toEqual(['walkthroughDone']);
    expect(reloaded.at.walkthroughDone).toBe(updated.at.walkthroughDone);
    // The persisted shape is the documented JSON contract.
    const raw = await AsyncStorage.getItem(JOURNEY_STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual({stamps: ['walkthroughDone'], at: {walkthroughDone: updated.at.walkthroughDone}});
  });

  test('awardStamp is idempotent (no duplicate, no rewrite, same journey back)', async () => {
    const first = await awardStamp('recoverySaved');
    const second = await awardStamp('recoverySaved');
    expect(second).toEqual(first);
    expect((await loadJourney()).stamps).toEqual(['recoverySaved']);
  });

  test('stamps accumulate in award order', async () => {
    await awardStamp('walkthroughDone');
    await awardStamp('fundsReady');
    const j = await loadJourney();
    expect(j.stamps).toEqual(['walkthroughDone', 'fundsReady']);
  });

  test('hasStamp reads the canonical key set', async () => {
    expect(hasStamp(EMPTY_JOURNEY, 'walkthroughDone')).toBe(false);
    await awardStamp('walkthroughDone');
    expect(hasStamp(await loadJourney(), 'walkthroughDone')).toBe(true);
    // The closed key set — every later-wave stamp key is already defined.
    expect(Object.keys(JOURNEY_STAMPS).sort()).toEqual([
      'firstOfflinePayment', 'flowUnderstood', 'fundsReady', 'paymentTested', 'recoverySaved', 'tripReady', 'walkthroughDone',
    ]);
  });

  test('corrupt JSON → the empty journey (fail-soft, never a throw)', async () => {
    await AsyncStorage.setItem(JOURNEY_STORAGE_KEY, '{not json');
    expect(await loadJourney()).toEqual(EMPTY_JOURNEY);
  });

  test('wrong-shape payloads parse to the empty journey; well-formed entries survive', () => {
    expect(parseJourney(null)).toEqual(EMPTY_JOURNEY);
    expect(parseJourney('"a string"')).toEqual(EMPTY_JOURNEY);
    expect(parseJourney('{"stamps":"nope"}')).toEqual(EMPTY_JOURNEY);
    expect(parseJourney('{"stamps":[],"at":[]}')).toEqual(EMPTY_JOURNEY);
    // Unknown future stamps + numeric at-times survive a downgrade round-trip…
    expect(parseJourney('{"stamps":["futureThing"],"at":{"futureThing":123}}')).toEqual({
      stamps: ['futureThing'], at: {futureThing: 123},
    });
    // …but malformed entries are dropped (string stamps + finite at-times only).
    expect(parseJourney('{"stamps":[42,"ok"],"at":{"ok":1,"bad":"x"}}')).toEqual({
      stamps: ['ok'], at: {ok: 1},
    });
  });

  test('useJourney: loads on mount, award updates state + persists', async () => {
    const {useJourney} = await import('../lib/journey');
    await AsyncStorage.setItem(
      JOURNEY_STORAGE_KEY,
      JSON.stringify({stamps: [JOURNEY_STAMPS.walkthroughDone], at: {[JOURNEY_STAMPS.walkthroughDone]: 7}}),
    );
    // A tiny probe component reads the hook — the react-test-renderer pattern the suite uses.
    const React = await import('react');
    const renderer = (await import('react-test-renderer')).default;
    const {act} = await import('react-test-renderer');
    type Probe = {journey: ReturnType<typeof import('../lib/journey')['useJourney']>['journey']; award: ReturnType<typeof import('../lib/journey')['useJourney']>['award']};
    let probe!: Probe;
    function ProbeComp() {
      const {journey, award} = useJourney();
      probe = {journey, award};
      return null;
    }
    let tree!: ReturnType<(typeof renderer)['create']>;
    await act(async () => { tree = renderer.create(<React.StrictMode><ProbeComp /></React.StrictMode>); });
    expect(hasStamp(probe.journey, 'walkthroughDone')).toBe(true);
    act(() => { probe.award('recoverySaved'); });
    expect(hasStamp(probe.journey, 'recoverySaved')).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(hasStamp(await loadJourney(), 'recoverySaved')).toBe(true);
    act(() => { tree.unmount(); });
  });
});
