// locale.test.ts — locale NEGOTIATION: which catalog a device gets, and which tag Intl formats with.
//
// Pure logic, so every case is a table row. The formatting conventions those tags then produce are
// intl.test.ts's job; the money/date strings they assemble are format-locale.test.ts's.
import {describe, it, expect} from '@jest/globals';
import {
  DEFAULT_LOCALE, LOCALES, LOCALE_ENDONYM, formatLocale, localePersistValue, lookupLocale,
  parseLocale, resolveLocale,
} from '../i18n/locale';

describe('lookupLocale — RFC 4647 lookup against the shipped catalogs', () => {
  it('matches an exact tag and a region-qualified tag to the same catalog', () => {
    expect(lookupLocale('de')).toBe('de');
    expect(lookupLocale('de-DE')).toBe('de');
    expect(lookupLocale('de-AT')).toBe('de');
    expect(lookupLocale('fr-CA')).toBe('fr');
  });

  it('truncates progressively, dropping a trailing single-character subtag with it', () => {
    // `de-DE-u-ca-buddhist` truncates to `de-DE-u-ca`, then `de-DE-u` — and a lone `u` is a
    // singleton, never a match, so RFC 4647 §3.4 says drop it too and try `de-DE`.
    expect(lookupLocale('de-DE-u-ca-buddhist')).toBe('de');
    expect(lookupLocale('es-419')).toBe('es');
    expect(lookupLocale('fr-Latn-CA-u-nu-latn')).toBe('fr');
  });

  it('normalises case and the underscore form Android sometimes reports', () => {
    expect(lookupLocale('DE-de')).toBe('de');
    expect(lookupLocale('de_DE')).toBe('de');
    expect(lookupLocale('ES_es')).toBe('es');
  });

  it('falls back to English for a language we do not ship, and for junk', () => {
    expect(lookupLocale('pt-BR')).toBe(DEFAULT_LOCALE);
    expect(lookupLocale('ja')).toBe(DEFAULT_LOCALE);
    // A prefix collision must NOT match: `den` (Slave) is not `de`.
    expect(lookupLocale('den')).toBe(DEFAULT_LOCALE);
    expect(lookupLocale('')).toBe(DEFAULT_LOCALE);
    expect(lookupLocale('   ')).toBe(DEFAULT_LOCALE);
  });
});

describe('resolveLocale — which catalog renders', () => {
  it('honours an explicit choice over the device', () => {
    expect(resolveLocale('fr', 'de-DE')).toBe('fr');
    expect(resolveLocale('en', 'de-DE')).toBe('en');
  });

  it('follows the device when the choice is Auto', () => {
    expect(resolveLocale(null, 'de-DE')).toBe('de');
    expect(resolveLocale(null, 'pt-BR')).toBe('en');
  });
});

describe('formatLocale — which tag Intl formats with', () => {
  it('keeps the FULL device tag on Auto when we ship its language', () => {
    // es-MX writes `1,234.56`; es-ES writes `1.234,56`. Both read the Spanish catalog, and a
    // Mexican user must not be handed Peninsular separators just because the catalog is named `es`.
    expect(formatLocale(null, 'es-MX')).toBe('es-MX');
    expect(formatLocale(null, 'de-AT')).toBe('de-AT');
  });

  it('uses the resolved catalog tag when the device language is not shipped', () => {
    // English prose beside `1.234,50` would invite exactly the one-and-a-bit vs twelve-hundred
    // misreading the number format is supposed to prevent. Prose and digits agree or neither does.
    expect(formatLocale(null, 'pt-BR')).toBe('en');
    expect(formatLocale(null, '')).toBe('en');
  });

  it('formats in the language the user explicitly picked, ignoring the device', () => {
    expect(formatLocale('de', 'en-US')).toBe('de');
    expect(formatLocale('en', 'de-DE')).toBe('en');
  });
});

describe('parseLocale / localePersistValue — the persisted round trip', () => {
  it('round-trips every shipped locale and Auto', () => {
    for (const tag of LOCALES) {
      expect(parseLocale(localePersistValue(tag))).toBe(tag);
    }
    expect(parseLocale(localePersistValue(null))).toBeNull();
  });

  it('reads Auto for anything unrecognised instead of throwing', () => {
    // Storage is user-writable and survives downgrades; an unknown value must degrade to Auto,
    // never crash the launch path.
    expect(parseLocale('system')).toBeNull();
    expect(parseLocale('pt')).toBeNull();
    expect(parseLocale('')).toBeNull();
    expect(parseLocale(null)).toBeNull();
  });
});

describe('LOCALE_ENDONYM — each language names itself', () => {
  it('covers every shipped locale with a non-English name where one exists', () => {
    for (const tag of LOCALES) {
      expect(LOCALE_ENDONYM[tag]).toBeTruthy();
    }
    // The point of endonyms: a user who cannot read the current UI language still finds their own.
    expect(LOCALE_ENDONYM.de).toBe('Deutsch');
    expect(LOCALE_ENDONYM.fr).toBe('Français');
    expect(LOCALE_ENDONYM.es).toBe('Español');
  });
});
