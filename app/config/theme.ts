/**
 * Wave 7 — manual theme override model (Light / Dark / Auto on top of the OS scheme).
 *
 * `'auto'` (default) follows the OS/browser color scheme exactly like the Wave-4 auto-only
 * behavior; `'light'`/`'dark'` pin the palette regardless of scheme. The override persists via
 * `THEME_STORAGE_KEY` (AsyncStorage — same pattern as the relay URL). Resolution stays PURE so
 * jest can pin the truth table; App.tsx owns the state + persistence + the applyPalette call.
 */
import type {ColorSchemeName} from 'react-native';

export type ThemeOverride = 'auto' | 'light' | 'dark';

// Cycle order for the one-tap toggle (header + Settings): Auto → Light → Dark → Auto.
export const THEME_CYCLE: readonly ThemeOverride[] = ['auto', 'light', 'dark'] as const;

export function nextTheme(t: ThemeOverride): ThemeOverride {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(t) + 1) % THEME_CYCLE.length];
}

/** Resolve override + OS scheme → the palette that should be applied. */
export function resolveTheme(
  override: ThemeOverride,
  scheme: ColorSchemeName | null | undefined,
): 'light' | 'dark' {
  if (override === 'auto') return scheme === 'dark' ? 'dark' : 'light';
  return override;
}

/** Parse a persisted/stored value; anything unknown falls back to `'auto'`. */
export function parseTheme(v: string | null | undefined): ThemeOverride {
  return v === 'light' || v === 'dark' ? v : 'auto';
}

/** Display label for the current override mode (Settings sheet + a11y labels). */
export function themeLabel(t: ThemeOverride): string {
  return t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark';
}
