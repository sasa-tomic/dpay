import {useCallback, useEffect, useRef, useState} from 'react';
import {copyToClipboard} from '../lib/clipboard';

export type CopyState = 'clipboard' | 'shared' | null;

/**
 * Copy-to-clipboard feedback state — the shared hook for the 6 sheets that show a "Copied ✓" /
 * "Shared ✓" confirmation after the user taps a copy button (deposit address, withdraw destination,
 * SOL address, SOL sig, recovery seed, SOL request sig). Mirrors the useHotkeys extraction pattern:
 * collapse the duplicated `setCopied(how); setTimeout(() => setCopied(null), 1500)` + the
 * `copyToClipboard(...)` call behind one stable surface.
 *
 * `copied` is the label-state the button reads (`null` → the default label; `'clipboard'`/`'shared'`
 * → the success label). `copy(text)` performs the clipboard write, sets `copied` to the path taken
 * (real clipboard vs Share sheet), and schedules a clear after 1500ms. The pending clear is
 * cancelled on unmount or a subsequent copy so a rapid second tap never leaves a stale timer that
 * resets `copied` prematurely (the bug the inline `setTimeout` carried — a queued clear from tap 1
 * could fire right after tap 2's set, blanking the second confirmation).
 */
export function useCopyFeedback(): {copied: CopyState; copy: (text: string) => Promise<void>; clear: () => void} {
  const [copied, setCopied] = useState<CopyState>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const clear = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setCopied(null);
  }, []);

  const copy = useCallback(async (text: string) => {
    const how = await copyToClipboard(text);
    setCopied(how);
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setCopied(null), 1500);
  }, []);

  return {copied, copy, clear};
}
