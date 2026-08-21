/**
 * Wave 8 — two-tier theme model (2026-08-21):
 *
 *   Header  — one-tap flip Light ↔ Dark (pins an explicit choice).
 *   Settings — three-way segmented control: Light / Dark / Auto.
 *
 * `null` (Auto) = no explicit choice → the resolved theme follows the OS/browser scheme live.
 * An explicit choice pins the palette and wins over the scheme. Persistence via
 * THEME_STORAGE_KEY stores `'light' | 'dark' | 'system'` (AsyncStorage — same pattern as the
 * relay URL); resolution stays PURE so jest can pin the truth table; App.tsx owns the state +
 * persistence + the applyPalette call.
 */
import type {ColorSchemeName} from 'react-native';

export type ThemeOverride = 'light' | 'dark';

/** One-tap toggle (header): flip Light ↔ Dark — operates on the RESOLVED theme. */
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
 * Parse a persisted/stored value; anything unknown — including the Wave-7 tri-state-era
 * `'auto'` — falls back to `null` (= follow the OS scheme, never a crash). `'system'` is the
 * value WE write for Auto, so it must round-trip to null too.
 */
export function parseTheme(v: string | null | undefined): ThemeOverride | null {
  return v === 'light' || v === 'dark' ? v : null;
}

/** The storage value for a choice: explicit modes verbatim, Auto as `'system'`. */
export function themePersistValue(t: ThemeOverride | null): string {
  return t ?? 'system';
}

/** Display label for the Settings segmented control (names the CHOICE, incl. Auto). */
export function choiceLabel(c: ThemeOverride | null): string {
  return c === 'light' ? 'Light' : c === 'dark' ? 'Dark' : 'Auto';
}

/** Display label for a resolved mode (a11y labels). */
export function themeLabel(t: ThemeOverride): string {
  return t === 'light' ? 'Light' : 'Dark';
}
