// i18n-catalogs.test.ts — every shipped locale against the English reference, and the live switch.
//
// `tsc` already proves each catalog is STRUCTURALLY complete (a missing key is a compile error, by
// design — see i18n/keys.ts). What it cannot prove is that the values are usable: an interpolation
// that drops its argument, a function that throws on a plural boundary, an empty string. Those
// render as a blank label or a crash in a language nobody on the team reads, so they get a test.
import {describe, it, expect, afterEach} from '@jest/globals';
import {M, applyLocale} from '../i18n';
import {en} from '../i18n/en.ts';
import {de} from '../i18n/de.ts';
import {es} from '../i18n/es.ts';
import {fr} from '../i18n/fr.ts';
import {LOCALES, type LocaleTag} from '../i18n/locale';

const CATALOGS: Record<LocaleTag, unknown> = {en, de, es, fr};
const TRANSLATED = LOCALES.filter(l => l !== 'en');

afterEach(() => { applyLocale('en', 'en-US'); });

/** Every leaf in a catalog, as `path -> value`. Objects recurse; strings and functions are leaves. */
function leaves(node: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) leaves(v, p, out);
    else out.set(p, v);
  }
  return out;
}

const EN_LEAVES = leaves(en);

describe.each(TRANSLATED)('the %s catalog', (tag) => {
  const got = leaves(CATALOGS[tag]);

  it('covers exactly the English key set — no missing key, no stray one', () => {
    expect([...got.keys()].sort()).toEqual([...EN_LEAVES.keys()].sort());
  });

  it('keeps every leaf the same KIND and every function the same arity', () => {
    // An interpolation that quietly became a constant string is the failure this catches: the
    // amount, the asset or the merchant name would simply vanish from the sentence.
    const wrong: string[] = [];
    for (const [p, ref] of EN_LEAVES) {
      const v = got.get(p);
      if (typeof v !== typeof ref) wrong.push(`${p}: ${typeof ref} -> ${typeof v}`);
      else if (typeof ref === 'function' && (v as Function).length !== ref.length) {
        wrong.push(`${p}: arity ${ref.length} -> ${(v as Function).length}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('has no empty string and no untranslated placeholder marker', () => {
    const bad: string[] = [];
    for (const [p, v] of got) {
      if (typeof v === 'string' && v.trim() === '' && (EN_LEAVES.get(p) as string).trim() !== '') bad.push(p);
      if (typeof v === 'string' && /\bTODO\b|\{\{/.test(v)) bad.push(`${p} (placeholder)`);
    }
    expect(bad).toEqual([]);
  });

  it.each([0, 1, 2])('renders every interpolation without throwing, at count %i', (n) => {
    // All-numeric arguments hit the plural boundaries (0 / 1 / many) that each locale implements
    // by hand, because Hermes ships no `Intl.PluralRules`. A string parameter stringifies fine.
    const broken: string[] = [];
    for (const [p, v] of got) {
      if (typeof v !== 'function') continue;
      const args = Array.from({length: v.length}, () => n);
      let out: unknown;
      try {
        out = (v as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        broken.push(`${p} threw: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // Most keys return a sentence; the deposit instructions return an array of typed RUNS
      // (`{t, em?}`) so the asset and network names can be emphasised mid-sentence.
      const rendered = Array.isArray(out)
        ? out.map(r => String((r as {t: unknown}).t)).join('')
        : out;
      if (typeof rendered !== 'string' || rendered.trim() === '') {
        broken.push(`${p} produced ${JSON.stringify(out)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('actually differs from English on the copy a user reads first', () => {
    // A guard against a locale file that was created but left as a copy of the reference.
    const prose: string[] = ['common.done', 'wallet.tab.pay', 'settings.title', 'nfc.settled'];
    for (const p of prose) {
      expect({key: p, value: got.get(p)}).not.toEqual({key: p, value: EN_LEAVES.get(p)});
    }
  });
});

describe('applyLocale — the live switch', () => {
  it('replaces the catalog in place, so every call site sees the new language', () => {
    const english = M.wallet.tab.pay;
    applyLocale('de', 'en-US');
    expect(M.wallet.tab.pay).toBe(de.wallet.tab.pay);
    expect(M.wallet.tab.pay).not.toBe(english);
  });

  it('never mutates the English reference catalog', () => {
    // `M` is a COPY of `en`. Assigning onto `en` itself would destroy the reference, and the next
    // switch would be spreading one translation over another.
    const before = en.wallet.tab.pay;
    applyLocale('fr', 'fr-FR');
    applyLocale('es', 'es-ES');
    expect(en.wallet.tab.pay).toBe(before);
  });

  it('returns the catalog that won, and follows the device when the choice is Auto', () => {
    expect(applyLocale(null, 'de-DE')).toBe('de');
    expect(applyLocale(null, 'pt-BR')).toBe('en');
    expect(applyLocale('fr', 'de-DE')).toBe('fr');
  });

  it('moves the number formats along with the prose', () => {
    // The whole reason `applyLocale` takes the choice rather than a resolved tag: English sentences
    // beside German separators (or the reverse) is exactly the misreading this prevents.
    applyLocale(null, 'de-DE');
    expect(M.wallet.tab.pay).toBe(de.wallet.tab.pay);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('../lib/format').usd('100000')).toContain('1.000,00');
  });
});
