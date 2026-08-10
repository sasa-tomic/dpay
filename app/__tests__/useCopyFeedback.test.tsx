/**
 * useCopyFeedback — the shared hook for the 6 copy buttons across the app (deposit address,
 * withdraw destination, SOL address, SOL sig, recovery seed, SOL request sig). Collapses the
 * `setCopied(how); setTimeout(() => setCopied(null), 1500)` + `copyToClipboard(...)` pattern behind
 * a stable surface. Key behaviors under test:
 *   - `copy(text)` sets `copied` to the path returned by `copyToClipboard` and schedules a clear.
 *   - the clear fires after 1500ms (the inline pattern's cadence — the "Copied ✓" dwell).
 *   - a second `copy` before the first clear cancels the first timer (the bug the inline `setTimeout`
 *     carried: a queued clear from tap 1 could fire right after tap 2's set, blanking confirmation).
 *   - `clear()` immediately resets state + cancels the pending timer (the SettingsSheet Hide path).
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

jest.mock('../lib/clipboard', () => ({
  copyToClipboard: jest.fn(async () => 'clipboard' as const),
}));

import {copyToClipboard} from '../lib/clipboard';
import {useCopyFeedback} from '../hooks/useCopyFeedback';

const mockedCopyToClipboard = copyToClipboard as jest.MockedFunction<typeof copyToClipboard>;

// A minimal harness that exposes the hook's state + actions to the test via a ref the renderer
// holds across re-renders. Avoids @testing-library/react-hooks (not a project dep).
function Harness({apiRef}: {apiRef: React.MutableRefObject<ReturnType<typeof useCopyFeedback> | null>}) {
  const api = useCopyFeedback();
  apiRef.current = api;
  return <></>;
}

describe('useCopyFeedback', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedCopyToClipboard.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('copy sets copied to the clipboard path, clears after 1500ms', async () => {
    mockedCopyToClipboard.mockResolvedValue('clipboard');
    const apiRef: React.MutableRefObject<ReturnType<typeof useCopyFeedback> | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Harness apiRef={apiRef} />); });
    expect(apiRef.current!.copied).toBe(null);

    await act(async () => { await apiRef.current!.copy('addr');  });
    expect(apiRef.current!.copied).toBe('clipboard');

    act(() => { jest.advanceTimersByTime(1499); });
    expect(apiRef.current!.copied).toBe('clipboard');

    act(() => { jest.advanceTimersByTime(1); });
    expect(apiRef.current!.copied).toBe(null);

    act(() => { tree.unmount(); });
  });

  test('copy sets copied to "shared" when the Share fallback path is taken', async () => {
    mockedCopyToClipboard.mockResolvedValue('shared');
    const apiRef: React.MutableRefObject<ReturnType<typeof useCopyFeedback> | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Harness apiRef={apiRef} />); });

    await act(async () => { await apiRef.current!.copy('addr');  });
    expect(apiRef.current!.copied).toBe('shared');

    act(() => { tree.unmount(); });
  });

  test('a second copy before the first clear cancels the first timer (no premature reset)', async () => {
    mockedCopyToClipboard.mockResolvedValue('clipboard');
    const apiRef: React.MutableRefObject<ReturnType<typeof useCopyFeedback> | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Harness apiRef={apiRef} />); });

    await act(async () => { await apiRef.current!.copy('addr1');  });
    expect(apiRef.current!.copied).toBe('clipboard');

    act(() => { jest.advanceTimersByTime(1000); });

    await act(async () => { await apiRef.current!.copy('addr2');  });
    expect(apiRef.current!.copied).toBe('clipboard');

    // 600ms later — the FIRST timer (1000ms already elapsed + 500ms more) would have fired at 1500ms
    // from tap 1. With the bug, this would blank confirmation after tap 2. With the cancel, the
    // second timer owns the schedule (1500ms from tap 2).
    act(() => { jest.advanceTimersByTime(600); });
    expect(apiRef.current!.copied).toBe('clipboard');

    // Cross the second timer's 1500ms (1000 elapsed pre-tap2 + 1500 from tap2 = 2500 total).
    act(() => { jest.advanceTimersByTime(900); });
    expect(apiRef.current!.copied).toBe(null);

    act(() => { tree.unmount(); });
  });

  test('clear immediately resets copied and cancels the pending timer', async () => {
    mockedCopyToClipboard.mockResolvedValue('clipboard');
    const apiRef: React.MutableRefObject<ReturnType<typeof useCopyFeedback> | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Harness apiRef={apiRef} />); });

    await act(async () => { await apiRef.current!.copy('addr');  });
    expect(apiRef.current!.copied).toBe('clipboard');

    act(() => { apiRef.current!.clear(); });
    expect(apiRef.current!.copied).toBe(null);

    // A late timer fire (the canceled one) must NOT flip copied back.
    act(() => { jest.advanceTimersByTime(5000); });
    expect(apiRef.current!.copied).toBe(null);

    act(() => { tree.unmount(); });
  });

  test('unmount cancels the pending timer (no setState-after-unmount warning)', async () => {
    mockedCopyToClipboard.mockResolvedValue('clipboard');
    const apiRef: React.MutableRefObject<ReturnType<typeof useCopyFeedback> | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Harness apiRef={apiRef} />); });

    await act(async () => { await apiRef.current!.copy('addr');  });
    act(() => { tree.unmount(); });

    // Advancing past the 1500ms clear must not throw / warn (the timer was cleared on unmount).
    act(() => { jest.advanceTimersByTime(5000); });
  });
});
