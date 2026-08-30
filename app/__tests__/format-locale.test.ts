// format-locale.test.ts — the COMPOSED strings: money assembled from BigInt digits plus locale
// conventions, and human-typed amounts coming back the other way.
//
// intl.test.ts pins the conventions in isolation; this file pins what a user actually reads and
// what the parser actually receives. format.test.ts covers the locale-independent guards.
import {describe, it, expect, afterEach} from '@jest/globals';
import {applyFormatLocale} from '../i18n/intl';
import {fmtAsset, fmtAssetCompact, fmtTime, parseUserAmount, toUnits, usd} from '../lib/format';

afterEach(() => applyFormatLocale('en'));

describe('usd — the demo-dollar amount', () => {
  it('reads as English money, grouped', () => {
    expect(usd('2500')).toBe('∂25.00');
    expect(usd('100000')).toBe('∂1,000.00');
    expect(usd('123456789')).toBe('∂1,234,567.89');
    expect(usd('5')).toBe('∂0.05');
  });

  it('moves the separators AND the symbol for a German reader', () => {
    applyFormatLocale('de-DE');
    const out = usd('100000');
    // `1.000,00` — the dot groups and the comma is the decimal mark. Rendering the English form
    // here is the money bug this exists to prevent: `∂1000.50` reads as a thousand-and-a-half to
    // us and as one-thousand-point-five-zero to nobody, while `1,5` means fifteen to its owner.
    expect(out).toContain('1.000,00');
    expect(out.endsWith('∂')).toBe(true);
  });

  it('stays exact past the range a double can represent', () => {
    // 2^53 cents and beyond — the whole reason the digits never meet `Number`.
    expect(usd('9007199254740993')).toBe('∂90,071,992,547,409.93');
  });
});

describe('fmtAsset — a crypto amount keeps its ticker as a suffix in every locale', () => {
  it('groups the whole part and uses the locale decimal mark', () => {
    expect(fmtAsset('123456789', 8, 'BTC')).toBe('1.23456789 BTC');
    applyFormatLocale('de-DE');
    expect(fmtAsset('123456789', 8, 'BTC')).toBe('1,23456789 BTC');
  });

  it('groups a large whole part', () => {
    expect(fmtAsset('123456700000000', 6, 'USDC')).toBe('123,456,700.000000 USDC');
  });

  it('renders zero without inventing precision', () => {
    expect(fmtAsset('0', 8, 'BTC')).toBe('0 BTC');
  });
});

// The COMPACT formatter — the glanceable sibling of fmtAsset. fmtAsset (above) stays exact and
// padded for every surface where the user commits money; these are the Balances rows, the wallet
// header and the Ledger. The rules under test, in order: trim trailing zeros to the asset's floor,
// truncate toward zero at the display cap, and SAY SO when that cap hides value.
describe('fmtAssetCompact — the glanceable amount', () => {
  it('trims the padding an 8/9-decimal asset does not need', () => {
    // The reported case: a 1.5 balance read "1.50000000 VCHF" — eight digits of nothing.
    expect(fmtAssetCompact('150000000', 8, 'VCHF', 8, 2)).toBe('1.50 VCHF');
    expect(fmtAssetCompact('150000000', 8, 'ICP', 8, 0)).toBe('1.5 ICP');
    expect(fmtAssetCompact('1500000000', 9, 'SOL', undefined, 0)).toBe('1.5 SOL');
    expect(fmtAssetCompact('50000', 8, 'BTC', 8, 0)).toBe('0.0005 BTC');
  });

  it('trims to the floor and no further — a money asset keeps its two decimals', () => {
    // The floor is the whole difference between a token (1.5) and money (1.50), and it applies to
    // zero too: a "0 VCHF" next to a "1.50 VCHF" is a ragged money column.
    expect(fmtAssetCompact('100000000', 8, 'VCHF', 8, 2)).toBe('1.00 VCHF');
    expect(fmtAssetCompact('0', 8, 'VCHF', 8, 2)).toBe('0.00 VCHF');
    expect(fmtAssetCompact('0', 8, 'BTC', 8, 0)).toBe('0 BTC');
  });

  it('never trims a digit that carries value', () => {
    // Trimming only ever removes '0's. Eight real digits are the user's money and stay whole.
    expect(fmtAssetCompact('12345678', 8, 'BTC', 8, 0)).toBe('0.12345678 BTC');
    expect(fmtAssetCompact('10000', 8, 'VCHF', 8, 2)).toBe('0.0001 VCHF');
  });

  it('groups the whole part and uses the locale decimal mark, exactly like fmtAsset', () => {
    expect(fmtAssetCompact('123456789012345', 8, 'ICP', 8, 0)).toBe('1,234,567.89012345 ICP');
    applyFormatLocale('de-DE');
    expect(fmtAssetCompact('150000000', 8, 'VCHF', 8, 2)).toBe('1,50 VCHF');
  });

  it('truncates toward zero and marks it — never rounds the balance UP', () => {
    // ckETH: 6 display decimals over an 18-decimal ledger. 0.039922980593032 rounds to 0.039923,
    // which would print more money than the user holds; truncation + "≈" is the honest pair.
    expect(fmtAssetCompact('39922980593032000', 18, 'ETH', 6, 0)).toBe('≈ 0.039922 ETH');
    // A cap that hides nothing must NOT be marked.
    expect(fmtAssetCompact('39000000000000000', 18, 'ETH', 6, 0)).toBe('0.039 ETH');
  });

  it('names the threshold instead of rendering a held balance as zero', () => {
    // The bug this closes: 500 Wei formatted as a flat "0.000000 ETH" — a real balance shown as
    // nothing. A holding below the display resolution says so.
    expect(fmtAssetCompact('500', 18, 'ETH', 6, 0)).toBe('< 0.000001 ETH');
    expect(fmtAssetCompact('1', 8, 'BTC', 2, 0)).toBe('< 0.01 BTC');
    // …and a zero-decimal display says "< 1", not "< 0." with nothing after it.
    expect(fmtAssetCompact('1', 8, 'BTC', 0, 0)).toBe('< 1 BTC');
    // A TRUE zero stays a plain zero — the threshold form is only for a nonzero holding.
    expect(fmtAssetCompact('0', 18, 'ETH', 6, 0)).toBe('0 ETH');
  });

  it('puts a Ledger row\'s sign INSIDE the marker, and leaves the threshold form unsigned', () => {
    // "−≈ 0.039922 ETH" is what a caller concatenating its own sign would produce; the marker
    // belongs outside the signed number. And "< −0.000001" would bound a negative rather than a
    // magnitude, so the threshold form takes no sign — the row's arrow and colour carry direction.
    expect(fmtAssetCompact('50000', 8, 'BTC', 8, 0, '−')).toBe('−0.0005 BTC');
    expect(fmtAssetCompact('39922980593032000', 18, 'ETH', 6, 0, '−')).toBe('≈ −0.039922 ETH');
    expect(fmtAssetCompact('500', 18, 'ETH', 6, 0, '−')).toBe('< 0.000001 ETH');
  });

  it('clamps a floor that exceeds the display cap instead of inventing digits', () => {
    // A misconfigured row (floor 4 over a 2-digit cap) must not print digits the cap forbids.
    expect(fmtAssetCompact('150', 2, 'X', 2, 4)).toBe('1.50 X');
  });
});

describe('toUnits / parseUserAmount — what the keyboard produced', () => {
  it('accepts the dot an English decimal-pad renders', () => {
    expect(toUnits('1.50', 2)).toBe('150');
    expect(toUnits('0.00050000', 8)).toBe('50000');
  });

  it('accepts the COMMA a German, French or Spanish decimal-pad renders', () => {
    // Before this, a comma produced `not_a_number` -> `'0'` -> a Request button that did nothing
    // and said nothing. Total loss of function across most of Europe and Latin America.
    for (const tag of ['de-DE', 'fr-FR', 'es-ES']) {
      applyFormatLocale(tag);
      expect(toUnits('1,50', 2)).toBe('150');
      expect(toUnits(',5', 2)).toBe('50');
    }
  });

  it('still reads a typed dot as a decimal point on a comma locale', () => {
    applyFormatLocale('de-DE');
    expect(toUnits('1.5', 2)).toBe('150');
  });

  it('refuses ambiguous grouped input rather than guessing a number', () => {
    applyFormatLocale('de-DE');
    // `1.234,56` could be built into 1234.56 by stripping the dot — but the same user typing
    // `1.234` on a laptop means one-point-two-three-four. Refusing beats a wrong amount.
    expect(parseUserAmount('1.234,56', 2).ok).toBe(false);
  });

  it('keeps the parser error codes intact through canonicalisation', () => {
    expect(parseUserAmount('', 2)).toEqual({ok: false, err: 'empty'});
    expect(parseUserAmount('-1', 2)).toEqual({ok: false, err: 'negative'});
    expect(parseUserAmount('1.234', 2)).toEqual({ok: false, err: 'too_many_decimals'});
    applyFormatLocale('de-DE');
    expect(parseUserAmount('1,234', 2)).toEqual({ok: false, err: 'too_many_decimals'});
  });
});

describe('fmtTime — relative day from the catalog, clock and month from Intl', () => {
  const NOW_SECS = Math.floor(Date.now() / 1000);

  it('names today and yesterday in words, with a 12-hour English clock', () => {
    expect(fmtTime(NOW_SECS)).toMatch(/^Today, .*[AP]M$/);
    expect(fmtTime(NOW_SECS - 86_400)).toMatch(/^Yesterday, /);
  });

  it('switches to a 24-hour clock where the locale uses one', () => {
    applyFormatLocale('de-DE');
    expect(fmtTime(NOW_SECS)).not.toMatch(/[AP]M/);
  });

  it('names an older month in the locale and carries the year across years', () => {
    const march2020 = Math.floor(Date.UTC(2020, 2, 15, 12, 0) / 1000);
    expect(fmtTime(march2020)).toContain('Mar');
    expect(fmtTime(march2020)).toContain('2020');
    applyFormatLocale('fr-FR');
    expect(fmtTime(march2020)).toContain('mars');
  });
});
