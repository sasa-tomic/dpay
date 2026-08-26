// i18n — the message catalog the whole app reads from.
//
// Components read copy from `M` exactly as they read styles from `S` and colours from `C`. That is
// a deliberate match to the existing theme idiom: no context provider, no hook, no prop-drilling.
// There is no `React.memo` anywhere in this tree, so every re-render re-reads the catalog and a
// switch lands everywhere at once.
//
// `M` is a COPY of the English catalog, never `en` itself, and it must never be reassigned. Only
// MUTATION is visible through every bundler's module interop — `applyLocale` therefore
// `Object.assign`s the chosen catalog over it, exactly as `applyPalette` does for the palette. The
// copy matters: assigning onto `en` directly would overwrite the reference catalog in place, and
// the next switch would be spreading German over German.
//
// Because the swap replaces TOP-LEVEL keys wholesale, anything captured at module load — a section,
// a nested object, a single string — goes stale forever. Read `M.…` during render, never above it.
import type {Messages} from './keys';
import {en} from './en.ts';
import {de} from './de.ts';
import {es} from './es.ts';
import {fr} from './fr.ts';
import {applyFormatLocale} from './intl';
import {type LocaleChoice, type LocaleTag, formatLocale, resolveLocale} from './locale';

export type {Messages, NfcPhaseCopy, NfcPhaseKey} from './keys';

const CATALOGS: Record<LocaleTag, Messages> = {en, de, es, fr};

export const M: Messages = {...en};

/**
 * Switch the active language. Idempotent and cheap — call it from the render body (like
 * `applyPalette`) so the catalog is in place before any child reads it.
 *
 * Takes the user's CHOICE and the device tag rather than a resolved tag, so the prose and the
 * number/date formats are decided together and cannot drift apart: English sentences printed
 * beside `1.234,50` would invite exactly the one-and-a-bit-versus-twelve-hundred misreading that
 * localised separators exist to prevent. Returns the catalog that won, for the device self-check.
 */
export function applyLocale(choice: LocaleChoice, deviceTag: string): LocaleTag {
  const tag = resolveLocale(choice, deviceTag);
  Object.assign(M, CATALOGS[tag]);
  applyFormatLocale(formatLocale(choice, deviceTag));
  return tag;
}
