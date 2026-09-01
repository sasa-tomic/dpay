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

/**
 * Web-only focus trap for sheet overlays. On mount: saves the currently focused element, makes the
 * container programmatically focusable (`tabindex=-1`) and focuses it so keyboard/screen-reader focus
 * enters the sheet (instead of staying on the now-hidden wallet behind the opaque overlay). Traps Tab
 * within the container's focusable descendants (wraps first↔last). On unmount: restores focus to the
 * element that was focused before the sheet opened. No-op on native (Android uses touch + the hardware
 * Back button; no physical Tab key). The container ref comes from a `<View ref={…}>` — on
 * react-native-web this is the underlying DOM `div`, so DOM methods (`setAttribute`, `querySelectorAll`,
 * `focus`) are available.
 */
export function useFocusTrap(ref: {current: unknown}): void {
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    type Focusable = {focus?: () => void; disabled?: boolean};
    type DomEl = Focusable & {
      setAttribute?: (k: string, v: string) => void;
      querySelectorAll?: (s: string) => Focusable[];
    };
    type Doc = {
      activeElement?: DomEl;
      addEventListener?: (t: string, fn: (e: {key: string; shiftKey: boolean; preventDefault: () => void}) => void) => void;
      removeEventListener?: (t: string, fn: (e: {key: string; shiftKey: boolean; preventDefault: () => void}) => void) => void;
    };
    const el = ref.current as DomEl | null;
    if (!el || typeof el.focus !== 'function') {
      return;
    }
    const doc = globalThis as unknown as {document?: Doc};
    const d = doc.document;
    if (!d || typeof d.addEventListener !== 'function') {
      return;
    }
    const prev = d.activeElement;
    el.setAttribute?.('tabindex', '-1');
    el.focus();
    const FOCUSABLE = 'button, [role="button"], a[href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [data-focusable]';
    const onKeydown = (e: {key: string; shiftKey: boolean; preventDefault: () => void}) => {
      if (e.key !== 'Tab') {
        return;
      }
      const nodes = el.querySelectorAll?.(FOCUSABLE) ?? [];
      const focusable = nodes.filter((n) => !n.disabled);
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = d.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus?.();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus?.();
      }
    };
    d.addEventListener('keydown', onKeydown);
    return () => {
      d.removeEventListener?.('keydown', onKeydown);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
