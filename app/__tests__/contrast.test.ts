/**
 * WCAG contrast gate for the pairings the stylesheet PINS — the ones where a token is placed on a
 * surface that is not the page (X17).
 *
 * WHY THIS FILE IS NARROW ON PURPOSE. Most of the app's contrast is a property of the LIVE layout
 * (which token landed on which surface), and that is measured by driving the real app — a static
 * file cannot know that `S.dim2` ended up on a warm-black camera box. What it CAN gate is the
 * places where styles.ts itself decides BOTH halves of the pair, and the camera box is the whole of
 * that set today: `S.camBox`'s fill is a deliberate theme-INVARIANT literal (the `just campreview`
 * pixel gate keys on it), so the ink that sits on it is fixed too, and nothing about the page's
 * theme can rescue a wrong choice there.
 *
 * X17, measured on the deployed build: the on-camera copy used `S.reviewTo` / `S.dim2`, whose
 * colour is `p.sub` — a secondary ink designed for a PORCELAIN page. On the camera fill the LIGHT
 * palette's `sub` (`#676257`) gives 3.0:1 against the 4.5:1 AA needs; the DARK palette's `sub`
 * happened to pass, so the defect existed in exactly ONE theme and a single-theme check would have
 * missed it. Both are asserted here.
 *
 * Every colour is READ OFF the live stylesheet/palette, never re-typed: a test that restates the
 * values it is guarding cannot notice when they change.
 */
import {describe, test, expect} from '@jest/globals';
import {DARK, LIGHT} from '../config/palette';
import {S} from '../styles';

/** WCAG 2.x relative luminance of an `#rrggbb` colour. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not an #rrggbb colour: ${hex}`);
  const chan = (h: string) => {
    const s = parseInt(h, 16) / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(m[1]) + 0.7152 * chan(m[2]) + 0.0722 * chan(m[3]);
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The camera box's own fill, read off the live stylesheet — the one place it is written. */
const CAM_BG = String((S.camBox as {backgroundColor?: string}).backgroundColor);
/** The two inks the stylesheet places on it. */
const CAM_INK = String((S.camText as {color?: string}).color);
const CAM_SUB = String((S.camSubText as {color?: string}).color);

const AA = 4.5;

describe('WCAG contrast — the pairings styles.ts fixes on both sides', () => {
  test('the contrast function agrees with the references every reader can check', () => {
    // Black on white is exactly 21:1; a colour against itself is exactly 1:1. Without this the
    // rest of the file could pass with a broken formula.
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#676257', '#676257')).toBeCloseTo(1, 5);
    // …and it reproduces the ratio the UX review measured on the deployed build, to the digit.
    expect(contrast(LIGHT.sub, CAM_BG)).toBeCloseTo(3.0, 1);
  });

  test('the on-camera inks clear AA on the camera box', () => {
    expect(contrast(CAM_INK, CAM_BG)).toBeGreaterThanOrEqual(AA);
    expect(contrast(CAM_SUB, CAM_BG)).toBeGreaterThanOrEqual(AA);
  });

  test('they are theme-INVARIANT, because the box they sit on is', () => {
    // The tokens are read from `DARK` by construction (styles.ts), so they cannot move with the
    // page's theme — which is the property that makes one measurement cover both palettes.
    expect(CAM_INK).toBe(DARK.ink);
    expect(CAM_SUB).toBe(DARK.sub);
  });

  test("the PAGE's secondary ink is the wrong ink here — the exact regression X17 was", () => {
    expect(contrast(LIGHT.sub, CAM_BG)).toBeLessThan(AA);
    expect(CAM_SUB).not.toBe(LIGHT.sub);
  });

  test('the page inks still clear AA on their OWN page, both themes', () => {
    // The counterpart rule: `sub` is correct where it was designed to live. If a future palette
    // change breaks that, it must fail here rather than on a user's screen.
    expect(contrast(LIGHT.sub, LIGHT.bg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(DARK.sub, DARK.bg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(LIGHT.ink, LIGHT.bg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(DARK.ink, DARK.bg)).toBeGreaterThanOrEqual(AA);
  });
});
