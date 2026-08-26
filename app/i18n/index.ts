/**
 * i18n — the live message catalog.
 *
 * Components read copy from `M` exactly the way they read styles from `S` and colours from `C`
 * (see styles.ts): a module-level object, imported once, read during render. That is a deliberate
 * match to the existing theme idiom rather than a new pattern — the app has no `React.memo`
 * anywhere, so a state change in `App` re-renders the whole tree and every component re-reads the
 * current catalog on the spot. No context provider, no hook call in 40 components, no re-plumbing.
 *
 * Today there is one locale, so `M` IS the English catalog. When the second locale lands, `M`
 * becomes a copy that `Object.assign` swaps in place — the same trick `applyPalette` uses, and the
 * reason it must never be reassigned: only mutation is visible through every bundler's module
 * interop. Call sites do not change when that happens.
 */
import type {Messages} from './keys';
import {en} from './en.ts';

export type {Messages, NfcPhaseCopy, NfcPhaseKey} from './keys';

/** The catalog in force. Read it during render; never hold a destructured copy across a locale change. */
export const M: Messages = en;
