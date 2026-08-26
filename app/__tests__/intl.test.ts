// intl.test.ts — the locale CONVENTIONS layer: separators, grouping, symbol side, clock/date shape.
//
// These tests pin BEHAVIOUR, never ICU DATA. Exact glyphs (the narrow no-break space French groups
// with, the space before AM/PM) move between ICU versions and ship with the system image, so
// asserting them would fail on a device for a reason that is not a bug. What must hold everywhere:
// German decimals are commas, grouping appears, the symbol lands on the locale's side.
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  activeFormatTag, applyFormatLocale, canonicalizeDecimal, decimalSep, formatClock, formatMonthDay,
  formatMonthDayYear, groupDigits, placeCurrency,
} from '../i18n/intl';

// The module holds ONE active convention set, like `S`/`C`/`M`. Every test leaves it on English.
afterEach(() => applyFormatLocale('en'));

const AT = new Date(Date.UTC(2026, 7, 26, 13, 5));

describe('applyFormatLocale', () => {
  it('switches the active tag and reports it', () => {
    expect(activeFormatTag()).toBe('en');
    applyFormatLocale('de-DE');
    expect(activeFormatTag()).toBe('de-DE');
  });

  it('refuses a locale whose Intl data cannot describe a number', () => {
    // A stubbed or trimmed ICU returns a formatted number with no decimal part. Rendering money
    // through it would silently drop the separator — German `1,5` reads as fifteen to its owner
    // and one-and-a-half to us. Fail loudly instead; there is no safe fallback for this.
    const real = globalThis.Intl;
    globalThis.Intl = {
      NumberFormat: function () {
        return {formatToParts: () => [{type: 'integer', value: '11111111'}]};
      },
      DateTimeFormat: real.DateTimeFormat,
    } as unknown as typeof Intl;
    try {
      expect(() => applyFormatLocale('de-AT')).toThrow(/no usable number data/);
    } finally {
      globalThis.Intl = real;
    }
  });
});

describe('decimalSep', () => {
  it('is a dot in English and a comma in German, French and Peninsular Spanish', () => {
    expect(decimalSep()).toBe('.');
    for (const tag of ['de-DE', 'fr-FR', 'es-ES']) {
      applyFormatLocale(tag);
      expect(decimalSep()).toBe(',');
    }
  });

  it('follows the REGION, not the language — es-MX writes dots', () => {
    applyFormatLocale('es-MX');
    expect(decimalSep()).toBe('.');
  });
});

describe('groupDigits — grouping applied to a digit STRING, never to a number', () => {
  it('groups English in threes', () => {
    expect(groupDigits('1234567')).toBe('1,234,567');
    expect(groupDigits('1000')).toBe('1,000');
  });

  it('leaves short runs untouched', () => {
    expect(groupDigits('0')).toBe('0');
    expect(groupDigits('100')).toBe('100');
    expect(groupDigits('')).toBe('');
  });

  it('groups German with dots', () => {
    applyFormatLocale('de-DE');
    expect(groupDigits('1234567')).toBe('1.234.567');
  });

  it('respects the minimum-grouping-digits rule — es-ES writes 1000 but 10.000', () => {
    applyFormatLocale('es-ES');
    expect(groupDigits('1000')).toBe('1000');
    expect(groupDigits('10000')).toBe('10.000');
  });

  it('stays exact for a value far beyond what a double can hold', () => {
    // 18-decimal ETH raw units. The whole point of taking a string: no value ever meets `Number`.
    expect(groupDigits('123456789012345678901234')).toBe('123,456,789,012,345,678,901,234');
  });
});

describe('placeCurrency — the symbol sits where the locale puts it', () => {
  it('leads in English with no separator', () => {
    expect(placeCurrency('∂', '25.00')).toBe('∂25.00');
  });

  it('trails in German and French', () => {
    for (const tag of ['de-DE', 'fr-FR']) {
      applyFormatLocale(tag);
      const out = placeCurrency('∂', '25,00');
      expect(out.startsWith('25,00')).toBe(true);
      expect(out.endsWith('∂')).toBe(true);
    }
  });

  it('leads again in es-MX, where Spanish follows the American convention', () => {
    applyFormatLocale('es-MX');
    // Leading, but glued with a no-break space rather than butted against the digits — which is
    // why the separator is data read out of ICU and not a constant anywhere in the app.
    const out = placeCurrency('∂', '25.00');
    expect(out.startsWith('∂')).toBe(true);
    expect(out.endsWith('25.00')).toBe(true);
  });
});

describe('canonicalizeDecimal — what the keyboard produced becomes what the parser accepts', () => {
  it('is a no-op in English', () => {
    expect(canonicalizeDecimal('1.50')).toBe('1.50');
    expect(canonicalizeDecimal('')).toBe('');
  });

  it('translates the comma key a German decimal-pad renders', () => {
    applyFormatLocale('de-DE');
    expect(canonicalizeDecimal('1,50')).toBe('1.50');
    expect(canonicalizeDecimal(',5')).toBe('.5');
  });

  it('leaves a typed dot alone so a hardware keyboard still means what it says', () => {
    // A German typing `1.5` on a laptop means one-and-a-half. Stripping `.` as a group separator
    // would turn it into fifteen — a wrong number, which is worse than a refused one.
    applyFormatLocale('de-DE');
    expect(canonicalizeDecimal('1.5')).toBe('1.5');
    // Genuinely ambiguous grouped input survives as a shape the parser refuses outright.
    expect(canonicalizeDecimal('1.234,56')).toBe('1.234.56');
  });
});

describe('formatClock / formatMonthDay — device date shape', () => {
  it('is 12-hour in English and 24-hour in German', () => {
    expect(formatClock(AT)).toContain('PM');
    applyFormatLocale('de-DE');
    const de = formatClock(AT);
    expect(de).toContain('13');
    expect(de).not.toMatch(/[AP]M/);
  });

  it('names the month in the locale, not in English', () => {
    expect(formatMonthDay(AT)).toContain('Aug');
    applyFormatLocale('fr-FR');
    expect(formatMonthDay(AT)).toContain('août');
  });

  it('carries the year only in the long form', () => {
    expect(formatMonthDay(AT)).not.toContain('2026');
    expect(formatMonthDayYear(AT)).toContain('2026');
  });
});
