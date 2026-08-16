import {useCallback, useEffect, useRef, useState} from 'react';
import {Platform, Share} from 'react-native';

export type ShareState = 'shared' | null;

/**
 * Share-sheet feedback state — the sibling of useCopyFeedback for the 4 share affordances that
 * previously fired Share.share fire-and-forget with no in-DOM confirmation (request link, receipt
 * link, auth code, signed SOL code). Mirrors the useCopyFeedback extraction pattern exactly:
 * `shared` is the label-state the button reads (`null` → the default label; `'shared'` → the
 * "Link copied ✓"/"Copied ✓" confirmation). `share(text)` performs the share and flips the state
 * ONLY on sharedAction — a dismissed sheet (a user cancel, or the e2e noop shim) leaves the label
 * honest — then schedules a clear after 1500ms. The pending clear is cancelled on unmount or a
 * subsequent share so a rapid second tap never leaves a stale timer that resets `shared`
 * prematurely (the same bug the inline `setTimeout` carried).
 */
export function useShareFeedback(): {shared: ShareState; share: (message: string) => Promise<void>} {
  const [shared, setShared] = useState<ShareState>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const share = useCallback(async (message: string) => {
    try {
      const r = await Share.share({message});
      if (r.action !== 'sharedAction') return;
    } catch (e: unknown) {
      console.log(`[dpay] share failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setShared('shared');
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setShared(null), 1500);
  }, []);

  return {shared, share};
}

/**
 * The confirmation label for a flipped share button — the platform-aware half of the pattern the
 * copy buttons established ('Copied ✓' for a real clipboard write, 'Shared ✓' when the platform
 * Share sheet handled it). On web a resolved share means the no-Web-Share fallback COPIED the
 * payload (see e2e/web/shims.ts — navigator.share → clipboard write → sharedAction), so the
 * caller's web label ('Link copied ✓' / 'Copied ✓') is honest. On native sharedAction means the
 * user completed the REAL Share sheet — the sheet itself was the feedback and nothing was copied,
 * so the label must say 'Shared ✓', never 'Copied ✓'. Single source so all 4 share sites stay in
 * agreement (mirrors how useCopyFeedback's 'clipboard'/'shared' return drives the copy labels).
 */
export function shareConfirmLabel(webLabel: string): string {
  return Platform.OS === 'web' ? webLabel : 'Shared ✓';
}
