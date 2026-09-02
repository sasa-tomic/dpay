/**
 * The on-device diagnostic log (`services/log.ts`).
 *
 * What is pinned here is mostly what this module must NOT do. It sits beside a one-shot,
 * irreversible payment path, so a logger that throws, rejects or blocks would convert a diagnostic
 * aid into a new failure mode on the exact sequence it exists to explain. Its correctness is
 * therefore "it never gets in the way", and that is not observable from reading it.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';

// `mock`-prefixed so jest allows the factory to close over them (hoisting guard).
const mockAppendLog = jest.fn<(line: string) => Promise<boolean>>();
const mockRef: {current: ((line: string) => Promise<boolean>) | undefined} = {current: undefined};
jest.mock('../services/native', () => ({DpayCore: {get appendLog() { return mockRef.current; }}}));

type LogModule = typeof import('../services/log');

const realWarn = console.warn;
const realError = console.error;
const realLog = console.log;

// A FRESH module per test. `installLogSink` is deliberately idempotent — installing twice would
// double every line — so a suite that shares one instance can only ever exercise the first test's
// console patch. Resetting the registry also clears the in-memory tail between tests.
let log: LogModule;
beforeEach(() => {
  mockAppendLog.mockReset().mockResolvedValue(true);
  mockRef.current = mockAppendLog;
  jest.resetModules();
  log = require('../services/log') as LogModule;
});
afterEach(() => {
  console.warn = realWarn;
  console.error = realError;
  console.log = realLog;
});

describe('installLogSink', () => {
  test('mirrors warnings and errors to the file WITHOUT replacing the console', () => {
    // Mirrored, not replaced: logcat, Metro and the e2e harness's console assertions must keep
    // seeing exactly what they saw before, or this module would be a silent behaviour change on
    // every existing diagnostic.
    const seen: unknown[][] = [];
    console.warn = (...a: unknown[]) => { seen.push(a); };
    log.installLogSink();

    console.warn('provider refused', {status: 400});
    console.error('boom');

    expect(seen).toEqual([['provider refused', {status: 400}]]);
    const written = mockAppendLog.mock.calls.map(c => c[0]);
    expect(written.some(l => l.includes('WARN') && l.includes('provider refused') && l.includes('{"status":400}'))).toBe(true);
    expect(written.some(l => l.includes('ERROR') && l.includes('boom'))).toBe(true);
  });

  test('does not capture console.log — the rare valuable line must not be rotated out by chatter', () => {
    log.installLogSink();
    mockAppendLog.mockClear();
    console.log('render tick');
    expect(mockAppendLog.mock.calls.map(c => c[0]).some(l => l.includes('render tick'))).toBe(false);
  });

  test('survives a build with no native method at all, and never throws on the money path', () => {
    // The web wallet and any APK built before `appendLog` existed. The in-memory tail is then the
    // whole log, and — the point — nothing raises.
    mockRef.current = undefined;
    log.installLogSink();
    expect(() => { log.logMoney('transfer confirmed as 8168'); }).not.toThrow();
    expect(log.logTail().some(l => l.includes('transfer confirmed as 8168'))).toBe(true);
  });

  test('a rejecting native writer is swallowed, not surfaced as an unhandled rejection', async () => {
    mockAppendLog.mockReset().mockRejectedValue(new Error('disk full'));
    log.installLogSink();
    expect(() => { log.logMoney('spending the one submission'); }).not.toThrow();
    // Let any rejection settle: an unhandled one here would fail the suite.
    await new Promise(r => setTimeout(r, 0));
    expect(mockAppendLog).toHaveBeenCalled();
  });

  test('every line is timestamped in UTC, so it can be read beside a ledger block', () => {
    log.installLogSink();
    log.logMoney('quote=plq_1');
    const line = log.logTail().find(l => l.includes('quote=plq_1'));
    expect(line).toBeDefined();
    // ISO-8601 with the Z: a local timezone would reintroduce exactly the skew the provider-deadline
    // parser refuses, in the one artefact used to reconstruct a payment's timing after the fact.
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
  });
});
