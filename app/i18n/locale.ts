/**
 * locale.ts — which catalog is in force, and which formatting conventions go with it.
 *
 * PURE, except for the one function that asks the platform what the device locale is. Resolution
 * is kept pure for the same reason `config/theme.ts` keeps `resolveTheme` pure: the truth table is
 * the part worth pinning in tests, and `App.tsx` owns state, persistence, and the side effect.
 * This module is the exact locale-shaped mirror of the theme two-tier model — device default with
 * a Settings override, `null` meaning "follow the device".
 *
 * TWO tags come out of one choice, and they are not the same thing:
 *
 *   - the CATALOG tag (`resolveLocale`) — which of the four translations to show. A closed set.
 *   - the FORMAT tag (`formatLocale`) — what to hand `Intl` for money, dates and separators. An
 *     open BCP 47 string, because `de-AT` and `de-DE` share a catalog but not a currency format.
 *
 * Collapsing them would either throw away the device's region (an Austrian reading German copy
 * with German-of-Germany conventions) or split the copy set four ways per region for no gain.
 */

/** The languages that ship. A closed set: a tag is here only if a complete catalog exists for it. */
export type LocaleTag = 'en' | 'de' | 'fr' | 'es';

export const LOCALES: readonly LocaleTag[] = ['en', 'de', 'fr', 'es'];

/**
 * The fallback when the device asks for a language we do not ship. English is the language the
 * product was written in and the reference every other catalog is translated from (see en.ts).
 */
export const DEFAULT_LOCALE: LocaleTag = 'en';

/** `null` = follow the device. Mirrors `ThemeOverride | null` in config/theme.ts. */
export type LocaleChoice = LocaleTag | null;

/**
 * Each language named IN ITSELF. Deliberately NOT in the message catalog: a language picker that
 * translates its own options is the one that strands a user who cannot read the current language —
 * a French speaker on a phone stuck in German needs to find "Français", not "Französisch". Every
 * OS-level picker works this way. These are endonyms, so they are data, not copy, and they do not
 * change with the active locale.
 */
export const LOCALE_ENDONYM: Record<LocaleTag, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
};

/** Lowercase, `_`-normalised form used for MATCHING only — never for handing to `Intl`. */
function normalizeTag(tag: string): string {
  return String(tag ?? '').trim().replace(/_/g, '-').toLowerCase();
}

/**
 * One step of RFC 4647 §3.4 "Lookup": drop the last subtag, and if that leaves a single-character
 * subtag trailing, drop that too. The singleton case is real — `de-DE-u-ca-buddhist` truncates to
 * `de-DE-u`, and `u` is an extension marker, never a language range in its own right.
 */
function truncate(range: string): string {
  const cut = range.lastIndexOf('-');
  if (cut < 0) return '';
  const next = range.slice(0, cut);
  const prev = next.lastIndexOf('-');
  return next.length - prev === 2 ? next.slice(0, prev) : next;
}

/**
 * RFC 4647 Lookup against the shipped set: progressively truncate the device's tag until it names
 * a language we have, else fall back to English. `de-AT` and `de-DE-u-ca-buddhist` both find `de`;
 * `ja-JP` finds nothing and lands on English.
 */
export function lookupLocale(deviceTag: string): LocaleTag {
  let range = normalizeTag(deviceTag);
  while (range) {
    const hit = LOCALES.find(l => l === range);
    if (hit) return hit;
    range = truncate(range);
  }
  return DEFAULT_LOCALE;
}

/** Which catalog to show. An explicit Settings choice always wins over the device. */
export function resolveLocale(choice: LocaleChoice, deviceTag: string): LocaleTag {
  return choice ?? lookupLocale(deviceTag);
}

/**
 * The BCP 47 tag to hand `Intl` for money, dates and separators.
 *
 * On Auto, the device's FULL tag is kept whenever its language is one we ship, so regional
 * conventions survive: an `es-MX` phone reads Spanish copy with Mexican number and date formats,
 * not Peninsular ones. When the device asks for a language we do not ship, formatting follows the
 * catalog that will actually be on screen — English prose beside `∂1.234,50` would invite exactly
 * the misreading (one-and-a-bit vs twelve hundred) that this whole area exists to prevent.
 *
 * An explicit Settings choice formats in that language's own default region: the user asked for
 * French, not for French words over German separators.
 */
export function formatLocale(choice: LocaleChoice, deviceTag: string): string {
  if (choice) return choice;
  const device = String(deviceTag ?? '').trim().replace(/_/g, '-');
  const resolved = lookupLocale(device);
  return normalizeTag(device).split('-')[0] === resolved ? device : resolved;
}

/**
 * Read a persisted choice. Anything unrecognised — a value from a future build, a half-written
 * key, the literal `'system'` this module writes for Auto — resolves to Auto rather than throwing:
 * a corrupt preference must never be able to stop the app from starting.
 */
export function parseLocale(v: string | null): LocaleChoice {
  return LOCALES.find(l => l === v) ?? null;
}

/** Auto persists as an explicit `'system'` so it is distinguishable from "never set". */
export function localePersistValue(c: LocaleChoice): string {
  return c ?? 'system';
}

/**
 * What language the device is set to, as a BCP 47 tag.
 *
 * On Hermes this is backed by `java.util.Locale.getDefault()`; in a browser by `navigator.language`.
 * `Intl.DateTimeFormat` is the right probe because it is one of the three `Intl` constructors
 * Hermes actually ships — `Intl.Locale` is ABSENT and must never be used here (see selfcheck.ts).
 *
 * Returns `''` when the platform gives nothing usable, which `lookupLocale` turns into English.
 */
export function deviceLocaleTag(): string {
  const tag = new Intl.DateTimeFormat().resolvedOptions().locale;
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(tag) ? tag : '';
}
