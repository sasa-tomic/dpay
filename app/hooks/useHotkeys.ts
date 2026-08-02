import {useEffect, useRef} from 'react';
import {Platform} from 'react-native';

/**
 * Web-only keyboard-shortcut surface — the single source of truth for keyboard wiring. Attaches ONE
 * real DOM `keydown` listener (web only; native has no physical keyboard, and Android uses the
 * hardware Back button which is handled separately) and dispatches `e.key` (lower-cased) to the
 * matching handler in `handlers`.
 *
 *   - `ignoreIfInputFocused`: when set, a key pressed while an INPUT/TEXTAREA is focused is ignored
 *     (so typing into the amount/address/username fields never trips a shortcut). Escape is exempt
 *     — it should close a sheet even with a field focused (universal dialog-dismiss behaviour).
 *   - `enabled`: when false the listener becomes a no-op (e.g. the wallet main-view actions are
 *     suspended while any sheet/overlay covers the screen).
 *
 * Plan flow 14 / UX-V5: `useEscapeToClose` delegates here with `{escape: onClose}`; the wallet's
 * P/R/T/A actions pass both options. Uses `globalThis` + a structural key type so it typechecks
 * without the DOM lib (RN's tsconfig ships no DOM types). PR33 — `handlers`/`opts` are caller-inline
 * closures (recreated each render), so they are mirrored into refs and the listener subscribes ONCE
 * (stable identity) while always dispatching to the latest closures. Matches the NfcTap `onActive`
 * ref-mirror pattern. The `enabled` check moves inside `onKey` so a runtime toggle stays a no-op
 * without a teardown/resubscribe cycle (semantically identical to the prior attach/detach behavior).
 */
export function useHotkeys(handlers: Record<string, () => void>, opts?: {ignoreIfInputFocused?: boolean; enabled?: boolean}): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    type HasKey = {key: string};
    const g = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: HasKey) => void) => void;
      removeEventListener?: (type: string, fn: (e: HasKey) => void) => void;
    };
    if (typeof g.addEventListener !== 'function') {
      return;
    }
    const doc = globalThis as unknown as {document?: {activeElement?: {tagName?: string}}};
    const onKey = (e: HasKey) => {
      const o = optsRef.current;
      if (o?.enabled === false) {
        return;
      }
      if (o?.ignoreIfInputFocused) {
        const tag = doc.document?.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          return;
        }
      }
      const fn = handlersRef.current[(e.key ?? '').toLowerCase()];
      if (fn) {
        fn();
      }
    };
    g.addEventListener('keydown', onKey);
    return () => { g.removeEventListener?.('keydown', onKey); };
    // Subscribe once; `handlers` + `opts` are read live via refs so inline closures always dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Escape closes an open sheet/modal — the seed keyboard affordance (plan flow 14). Thin wrapper over
 * `useHotkeys`; deliberately carries NO input guard so Escape dismisses a sheet even when a field is
 * focused (the universal dialog-dismiss behaviour).
 */
export function useEscapeToClose(onClose: () => void): void {
  useHotkeys({escape: onClose});
}
