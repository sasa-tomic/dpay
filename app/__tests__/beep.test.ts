import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import {NativeModules, Platform} from 'react-native';
import {beepPaymentComplete} from '../lib/beep';

/** The slice of WebAudio beep.ts uses, as a recorder: two oscillators with their envelope gains. */
function fakeContext() {
  const oscillators: Array<{frequency: {value: number}; start: jest.Mock; stop: jest.Mock}> = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    close: jest.fn(async () => undefined),
    createOscillator: jest.fn(() => {
      const osc = {type: '', frequency: {value: 0}, connect: jest.fn(), start: jest.fn(), stop: jest.fn()};
      oscillators.push(osc);
      return osc;
    }),
    createGain: jest.fn(() => ({
      gain: {setValueAtTime: jest.fn(), exponentialRampToValueAtTime: jest.fn()},
      connect: jest.fn(),
    })),
  };
  return {ctx, oscillators};
}

const g = globalThis as {AudioContext?: unknown; webkitAudioContext?: unknown};
const nat = NativeModules as Record<string, unknown>;

describe('beepPaymentComplete — the completion blip (founder 2026-10-09)', () => {
  const realOs = Platform.OS;
  beforeEach(() => {
    jest.clearAllMocks();
    delete g.AudioContext;
    delete g.webkitAudioContext;
    delete nat.DpayBeep;
  });
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', {value: realOs});
  });

  test('web: one two-note blip — oscillators at A5 (880) then E6 (1318.5)', () => {
    Object.defineProperty(Platform, 'OS', {value: 'web'});
    const {ctx, oscillators} = fakeContext();
    g.AudioContext = jest.fn(() => ctx);
    beepPaymentComplete();
    expect(g.AudioContext).toHaveBeenCalledTimes(1);
    expect(oscillators).toHaveLength(2);
    expect(oscillators[0]!.frequency.value).toBe(880);
    expect(oscillators[1]!.frequency.value).toBe(1318.5);
    expect(oscillators[0]!.start).toHaveBeenCalledTimes(1);
    expect(oscillators[1]!.start).toHaveBeenCalledTimes(1);
  });

  test('web: no WebAudio available — a silent no-op, never a throw', () => {
    Object.defineProperty(Platform, 'OS', {value: 'web'});
    expect(() => beepPaymentComplete()).not.toThrow();
  });

  test('web: a throwing AudioContext constructor stays swallowed', () => {
    Object.defineProperty(Platform, 'OS', {value: 'web'});
    g.AudioContext = jest.fn(() => {
      throw new Error('autoplay policy');
    });
    expect(() => beepPaymentComplete()).not.toThrow();
  });

  test('native: plays the DpayBeep notification tone exactly once', () => {
    Object.defineProperty(Platform, 'OS', {value: 'android'});
    const play = jest.fn();
    nat.DpayBeep = {play};
    beepPaymentComplete();
    expect(play).toHaveBeenCalledTimes(1);
  });

  test('native: a device without DpayBeep stays silent, never a throw', () => {
    Object.defineProperty(Platform, 'OS', {value: 'android'});
    expect(() => beepPaymentComplete()).not.toThrow();
  });
});
