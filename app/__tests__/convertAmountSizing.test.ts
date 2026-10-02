/**
 * The convert sheet's amount field sizing (founder defect 2026-10-02): "in the swap dialog
 * the amounts are too large to fit into the field so the upper part is cut off".
 *
 * Two mechanisms, both deterministic:
 *  - the amount ROW grows with its content (`minHeight`, never a fixed `height`), so the
 *    glyph box of a large (or font-scaled) amount is never vertically clipped;
 *  - the amount INPUT's font size steps down by the TYPED LENGTH through a small pure
 *    function, so any realistic amount (e.g. 12345.67890123) stays fully visible on one
 *    line. Android's TextInput has no reliable adjustFontSizeToFit - hence length tiers.
 */
import {describe, test, expect} from '@jest/globals';
import {S, amountFontFor} from '../styles';

describe('the amount field sizing (2026-10-02 founder defect)', () => {
  test('short amounts keep the display size', () => {
    expect(amountFontFor('').fontSize).toBe(32);
    expect(amountFontFor('0').fontSize).toBe(32);
    expect(amountFontFor('0.5').fontSize).toBe(32);
    expect(amountFontFor('12345.678').fontSize).toBe(32); // 9 chars
  });

  test('longer amounts step down so they fit the field width', () => {
    expect(amountFontFor('12345.6789').fontSize).toBe(24); // 10 chars
    // The founder's example: a realistic 14-character amount must remain fully visible.
    expect(amountFontFor('12345.67890123').fontSize).toBe(24);
    expect(amountFontFor('123456789012345678.9').fontSize).toBe(18); // extreme, 20 chars
  });

  test('the sizing is a pure function of the typed length (stable, no platform guessing)', () => {
    expect(amountFontFor('12345.67890123')).toBe(amountFontFor('12345.67890123'));
    expect(amountFontFor(' 12 ')).toEqual(amountFontFor('12')); // trims
  });

  test('the field row grows with content instead of clipping (minHeight, never height)', () => {
    const row = S.amountRow as Record<string, unknown>;
    expect(row.minHeight).toBe(56);
    expect(row.height).toBeUndefined();
  });

  test('the tiers stay one visual family: same weight, tabular figures, same color', () => {
    for (const size of [amountFontFor('1'), amountFontFor('12345.6789'), amountFontFor('123456789012345678.9')]) {
      expect(size.fontWeight).toBe(S.amountInput.fontWeight);
      expect(size.fontFamily).toBe(S.amountInput.fontFamily);
      expect(size.color).toBe(S.amountInput.color);
      expect(size.fontVariant).toEqual(S.amountInput.fontVariant);
      expect(size.fontSize as number).toBeLessThanOrEqual(32);
    }
    expect(amountFontFor('1').fontSize!).toBeGreaterThan(amountFontFor('12345.6789').fontSize!);
    expect(amountFontFor('12345.6789').fontSize!).toBeGreaterThan(amountFontFor('123456789012345678.9').fontSize!);
  });
});
