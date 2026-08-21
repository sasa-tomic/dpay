/**
 * Wave 7 — manual theme model, two-state (Light / Dark) since 2026-08-21.
 *
 * The state seeds itself from the OS/browser color scheme: while no explicit choice is stored
 * (`null`), the resolved theme FOLLOWS the scheme live (the Wave-4 auto behavior). The first
 * user click pins an explicit `'light'`/`'dark'` that persists via `THEME_STORAGE_KEY`
 * (AsyncStorage — same pattern as the relay URL). Resolution stays PURE so jest can pin the
 * truth table; App.tsx owns the state + persistence + the applyPalette call.
 */
import type {ColorSchemeName} from 'react-native';

export type ThemeOverride = 'light' | 'dark';

/** One-tap toggle (header + Settings): flip Light ↔ Dark. */
export function nextTheme(t: ThemeOverride): ThemeOverride {
  return t === 'light' ? 'dark' : 'light';
}

/**
 * Resolve the (nullable) stored choice + OS scheme → the palette to apply. `null` (no stored
 * choice) follows the scheme — the automatic system-preference default.
 */
export function resolveTheme(
  choice: ThemeOverride | null,
  scheme: ColorSchemeName | null | undefined,
): 'light' | 'dark' {
  return choice ?? (scheme === 'dark' ? 'dark' : 'light');
}

/**
 * Parse a persisted/stored value; anything unknown — including the legacy tri-state `'auto'`
 * — falls back to `null` (= follow the OS scheme, never a crash).
 */
export function parseTheme(v: string | null | undefined): ThemeOverride | null {
  return v === 'light' || v === 'dark' ? v : null;
}

/** Display label for the current theme (Settings sheet + a11y labels). */
export function themeLabel(t: ThemeOverride): string {
  return t === 'light' ? 'Light' : 'Dark';
}
