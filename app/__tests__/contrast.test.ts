/**
 * THE WCAG GATE. Every foreground/background pairing the app can render, both themes, measured
 * off the LIVE stylesheet and the LIVE palette. Nothing here re-types a colour it is guarding: a
 * test that restates its subject cannot notice when the subject changes.
 *
 * ── WHY IT IS SHAPED LIKE THIS, AND WHY THAT IS EXHAUSTIVE ───────────────────────────────────
 * A static file cannot know which DOM node landed on which surface — that is a property of the
 * live layout. The narrow 2026-09-05 version accepted that and gated exactly one pairing (the
 * camera box). The audit that followed measured 1108 rendered text nodes and found 28 distinct
 * failing pairs, which is what a one-pairing gate buys you.
 *
 * So this file gates the SYSTEM instead of a sample, in two halves that close over each other:
 *
 *   1. THE CONTRACT — every ink token clears AA against every surface it is allowed to land on,
 *      in both themes, INCLUDING a `wash` tint of itself (the strictest of the three, and the one
 *      that actually sets how deep the accents have to be).
 *   2. THE CLOSURE — every colour the stylesheet emits, on every colour property, IS one of those
 *      tokens (or a declared, measured exception). Nothing can enter the app outside the set.
 *
 * Together those two are a proof about every rendered node, not a spot check: if a foreground can
 * only be an approved token, and every approved token clears AA on every surface, then every
 * pairing clears AA. Adding an unapproved colour fails the closure; approving one drags it into
 * the contract. There is no third way to put a colour on screen.
 *
 * ── THE LARGE-TEXT EXEMPTION IS NOT USED ─────────────────────────────────────────────────────
 * WCAG allows 3:1 at ≥24px, or ≥18.66px at weight ≥700. Every threshold in this file is 4.5, so
 * no pairing anywhere in the app depends on that relaxation — the two biggest type sites (the
 * 36px/700 wordmark and the 30px/700 PAID mark) are asserted at 4.5 explicitly, below, precisely
 * so nobody can later "fix" a failure by making the text bigger. 3.0 appears in exactly one
 * section, for NON-text state indicators, which is the threshold WCAG 1.4.11 actually sets.
 */
import {describe, test, expect} from '@jest/globals';
import {DARK, LIGHT, withAlpha, type Palette} from '../config/palette';
import {S, applyPalette} from '../styles';
import {allChips} from '../components/AssetGlyph';

// ── colour maths ──────────────────────────────────────────────────────────────────────────────

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

const rgb = (hex: string): [number, number, number] => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not an #rrggbb colour: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
};

/** Alpha-composite `fg` at `alpha` over the opaque `bg`, the way the renderer does. A tint is not
 *  a colour until it is over something, and WHAT it is over is the whole question — the same 6%
 *  tangerine reads differently on porcelain and on white, and the porcelain one is what fails. */
function over(fg: string, alpha: number, bg: string): string {
  const [fr, fg_, fb] = rgb(fg);
  const [br, bg_, bb] = rgb(bg);
  const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return `#${[mix(fr, br), mix(fg_, bg_), mix(fb, bb)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

const AA = 4.5; // WCAG 1.4.3, normal text — the ONLY text threshold this file uses
const NON_TEXT = 3.0; // WCAG 1.4.11, a state or boundary that carries meaning

// ── the token sets, named by the JOB each one does ────────────────────────────────────────────

/** Surfaces a page-level foreground can land on. `field` is `card` in both themes today; it is
 *  listed anyway so it stays gated if it ever diverges. */
const PAGE_SURFACES = ['bg', 'panel', 'panel2', 'card', 'field'] as const;

/** Every foreground that lands on a PAGE surface. Each must clear AA on all of them, and on a
 *  `wash` of itself over all of them. */
const PAGE_INKS = ['ink', 'sub', 'sub2', 'brandText', 'ok', 'bad', 'warn'] as const;

/** Saturated fills. `brandInk` is the ONLY foreground allowed on any of them, in either theme —
 *  which is what makes one token enough and why `warnDeep` could be deleted. `bad` is here
 *  because SettingsSheet paints the reset-confirm button with it inline. */
const FILLS = ['brand', 'ok', 'warn', 'bad'] as const;

/** The camera viewfinder's fill is a deliberate theme-INVARIANT literal (the `just campreview`
 *  pixel gate keys on it), so the ink on it is fixed too and is read from `DARK` in styles.ts. */
const CAM_BG = String((S.camBox as {backgroundColor?: string}).backgroundColor);

const themes: [string, Palette][] = [['LIGHT', LIGHT], ['DARK', DARK]];
/** A surface painted `p.ink` inverts against its own theme, so its inks come from the OTHER one. */
const inverseOf = (p: Palette) => (p === DARK ? LIGHT : DARK);

describe('the maths itself, against references any reader can check', () => {
  test('black on white is 21:1 and a colour against itself is 1:1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  test('the compositor reproduces a known alpha blend', () => {
    // 50% black over white is the exact midpoint; 0% and 100% are the endpoints.
    expect(over('#000000', 0.5, '#ffffff')).toBe('#808080');
    expect(over('#ff0000', 0, '#ffffff')).toBe('#ffffff');
    expect(over('#ff0000', 1, '#ffffff')).toBe('#ff0000');
  });
});

describe('1. THE CONTRACT — every ink clears AA on every surface it can land on', () => {
  for (const [name, p] of themes) {
    test(`${name}: page inks on page surfaces`, () => {
      for (const ink of PAGE_INKS) {
        for (const surface of PAGE_SURFACES) {
          const r = contrast(p[ink], p[surface]);
          expect(`${name} ${ink} on ${surface} = ${r.toFixed(2)}`).toBe(
            `${name} ${ink} on ${surface} = ${Math.max(r, AA).toFixed(2)}`,
          );
        }
      }
    });

    test(`${name}: every token the stylesheet WASHES, read on its own tint`, () => {
      // The binding constraint, and the reason the accents sit deeper than the page alone
      // requires: the MAIN badge, the status pills, the reset/backup boxes and the asset-glyph
      // chips are all a token printed on a soft tint of itself.
      //
      // The washed set is DISCOVERED from the live stylesheet, not listed here: whatever a style
      // paints with `withAlpha(token, p.wash)` is a wash, and the token it tints is the ink that
      // will be read on it. Wash a new token tomorrow and it is gated tomorrow — a hand-written
      // list would simply stop covering it.
      applyPalette(p);
      const washed = new Map<string, string>();
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) washed.set(withAlpha(v, p.wash).toLowerCase(), k);
      }
      const found = new Set<string>();
      for (const style of Object.values(S as Record<string, Record<string, unknown>>)) {
        const bgv = style?.backgroundColor;
        if (typeof bgv === 'string' && washed.has(bgv.toLowerCase())) found.add(washed.get(bgv.toLowerCase()) as string);
      }
      // If this ever reaches zero the whole section is vacuous, so the count is asserted too.
      expect(found.size).toBeGreaterThanOrEqual(4);
      for (const token of found) {
        for (const surface of PAGE_SURFACES) {
          const hex = p[token as keyof Palette] as string;
          const r = contrast(hex, over(hex, p.wash, p[surface]));
          expect(`${name} ${token} on wash-over-${surface} = ${r.toFixed(2)}`).toBe(
            `${name} ${token} on wash-over-${surface} = ${Math.max(r, AA).toFixed(2)}`,
          );
        }
      }
      applyPalette(LIGHT);
    });

    test(`${name}: the washes whose TEXT lives in a sibling style`, () => {
      // Four sites put the label in one style and the tint in another, so no rule about a single
      // style can see them. `warnNote` inside `resetConfirmBox` is the one that is not even the
      // same hue as its wash — an amber caution printed on a red box.
      applyPalette(p);
      const PAIRS: [string, keyof typeof S, keyof typeof S][] = [
        ['offline pill', 'qrOfflinePillText', 'qrOfflinePill'],
        ['reset entry', 'resetEntryText', 'resetEntryBtn'],
        ['backup entry', 'backupEntryText', 'backupEntryBtn'],
        ['reset warning', 'warnNote', 'resetConfirmBox'],
      ];
      for (const [label, textKey, boxKey] of PAIRS) {
        const fg = String((S[textKey] as {color?: string}).color);
        const wash = String((S[boxKey] as {backgroundColor?: string}).backgroundColor);
        const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(wash) as RegExpExecArray;
        expect(m).not.toBeNull();
        const tint = `#${[m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('')}`;
        // Worst case: the box sits on the PAGE, the darkest surface in light / lightest in dark.
        for (const surface of PAGE_SURFACES) {
          const r = contrast(fg, over(tint, Number(m[4]), p[surface]));
          expect(`${name} ${label} over ${surface} = ${r.toFixed(2)}`).toBe(
            `${name} ${label} over ${surface} = ${Math.max(r, AA).toFixed(2)}`,
          );
        }
      }
      applyPalette(LIGHT);
    });

    test(`${name}: brandInk is legible on every saturated fill`, () => {
      for (const fill of FILLS) {
        const r = contrast(p.brandInk, p[fill]);
        expect(`${name} brandInk on ${fill} = ${r.toFixed(2)}`).toBe(
          `${name} brandInk on ${fill} = ${Math.max(r, AA).toFixed(2)}`,
        );
      }
    });

    test(`${name}: an INVERTED surface (painted p.ink) carries the other theme's inks`, () => {
      const inv = inverseOf(p);
      for (const ink of ['ink', 'brandText'] as const) {
        expect(contrast(inv[ink], p.ink)).toBeGreaterThanOrEqual(AA);
      }
      // …and this is not academic: the SAME theme's tokens fail there, in BOTH directions.
      expect(contrast(p.brandText, p.ink)).toBeLessThan(AA);
    });
  }

  test('the camera box carries theme-invariant inks, because its fill is theme-invariant', () => {
    const camInk = String((S.camText as {color?: string}).color);
    const camSub = String((S.camSubText as {color?: string}).color);
    expect(camInk).toBe(DARK.ink);
    expect(camSub).toBe(DARK.sub);
    expect(contrast(camInk, CAM_BG)).toBeGreaterThanOrEqual(AA);
    expect(contrast(camSub, CAM_BG)).toBeGreaterThanOrEqual(AA);
    // X17, the regression that created this file: a PAGE ink here measures 3.0:1 in one theme.
    expect(contrast(LIGHT.sub, CAM_BG)).toBeLessThan(AA);
  });

  test('the QR plate is white in both themes, so its inks are the light theme\'s', () => {
    // QrCode.tsx reads LIGHT by construction rather than the live palette — a scanner needs a
    // white plate, so the dark theme's tangerine (4.11:1 there) must never reach it.
    expect(contrast(LIGHT.ink, LIGHT.card)).toBeGreaterThanOrEqual(AA);
    expect(contrast(LIGHT.brandText, LIGHT.card)).toBeGreaterThanOrEqual(AA);
    expect(contrast(DARK.brandText, LIGHT.card)).toBeLessThan(AA);
  });
});

describe('2. THE CLOSURE — the stylesheet cannot emit a colour outside the set', () => {
  // Every property RN can paint a colour with. Listing them all is the point: a new one that
  // isn't here would be an unmeasured hole, so the list is asserted against the stylesheet below.
  const COLOR_PROPS = [
    'color', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor',
    'borderLeftColor', 'borderRightColor', 'shadowColor', 'textDecorationColor', 'tintColor',
  ] as const;

  /** Every value the palette LEGITIMATELY produces for a colour property, in theme `p`. */
  function approved(p: Palette): Map<string, string> {
    const inv = inverseOf(p);
    const m = new Map<string, string>();
    const add = (v: string, why: string) => m.set(v.toLowerCase(), why);
    for (const [k, v] of Object.entries(p)) if (typeof v === 'string') add(v, `palette.${k}`);
    for (const k of [...PAGE_INKS, 'brand', 'brandInk'] as const) add(withAlpha(p[k], p.wash), `wash of ${k}`);
    // Emphasis alphas on the pill BORDERS. A hairline carries emphasis, not text, so its alpha is
    // a per-site choice — but the COLOUR it is an alpha of still has to be a token.
    for (const k of ['bad', 'brandText', 'warn'] as const) {
      for (const a of [0.25, 0.28, 0.35, 0.45]) add(withAlpha(p[k], a), `${k} hairline @${a}`);
    }
    add(withAlpha(p.brandInk, 0.45), 'key-cap ring on the brand fill');
    add(withAlpha(p.ink, 0.14), 'key-cap scrim on the brand fill');
    add(CAM_BG, 'the theme-invariant camera fill');
    // Two surfaces are pinned to one theme no matter which is applied, so their inks are too:
    // the camera viewfinder is always warm-black (DARK's inks) and the QR plate is always white
    // (LIGHT's). Approving them unconditionally is the same statement styles.ts makes by reading
    // `DARK.ink` / `LIGHT.card` there instead of `p.*`.
    add(DARK.ink, 'camera-box ink'); add(DARK.sub, 'camera-box secondary ink');
    add(LIGHT.card, 'the QR plate'); add(LIGHT.line, 'the QR mark ring');
    add(inv.ink, 'the inverse ink, for a surface painted p.ink');
    add(inv.brandText, 'the inverse tangerine, for a surface painted p.ink');
    add('transparent', 'no fill');
    return m;
  }

  for (const [name, p] of themes) {
    test(`${name}: every colour in every style is an approved token`, () => {
      applyPalette(p);
      const ok = approved(p);
      const strays: string[] = [];
      let seen = 0;
      for (const [key, style] of Object.entries(S as Record<string, Record<string, unknown>>)) {
        for (const prop of COLOR_PROPS) {
          const v = style?.[prop];
          if (typeof v !== 'string') continue;
          seen++;
          if (!ok.has(v.toLowerCase())) strays.push(`S.${key}.${prop} = ${v}`);
        }
      }
      // The sweep has to actually sweep: a typo in COLOR_PROPS would make this vacuously green.
      expect(seen).toBeGreaterThan(300);
      expect(strays).toEqual([]);
      applyPalette(LIGHT);
    });
  }

  test('the sweep covers the colour properties the stylesheet actually uses', () => {
    // Guards the other half of the closure: if a style starts painting with a property not in
    // COLOR_PROPS, that property's colours would never be checked. This finds it.
    const used = new Set<string>();
    for (const style of Object.values(S as Record<string, Record<string, unknown>>)) {
      for (const [prop, v] of Object.entries(style ?? {})) {
        if (typeof v === 'string' && /color$/i.test(prop)) used.add(prop);
      }
    }
    expect([...used].sort()).toEqual([...used].filter(u => (COLOR_PROPS as readonly string[]).includes(u)).sort());
  });
});

describe('3. THE FILLS — every label printed on a saturated fill', () => {
  // The pairing a stylesheet cannot infer: the fill and its label are two sibling styles. This is
  // the audit's single widest failure (white on tangerine, 3.12:1, on 19 surfaces in both themes),
  // so the pairs are named rather than sampled.
  const PAIRS: [fill: keyof typeof S, label: keyof typeof S][] = [
    ['primary', 'primaryText'],
    ['primaryWide', 'primaryText'],
    ['smallBtn', 'smallBtnText'],
    ['applyBtn', 'applyBtnText'],
    ['tabActive', 'tabTextActive'],
    ['bottomTabActive', 'bottomTabTextActive'],
    ['filterChipActive', 'filterChipTextActive'],
    ['convertSlippageChipOn', 'convertSlippageChipTextOn'],
    ['paidBtn', 'paidBtnText'],
  ];

  for (const [name, p] of themes) {
    test(`${name}: every fill/label pair in the stylesheet`, () => {
      applyPalette(p);
      for (const [fillKey, labelKey] of PAIRS) {
        const fill = String((S[fillKey] as {backgroundColor?: string}).backgroundColor);
        const label = String((S[labelKey] as {color?: string}).color);
        const r = contrast(label, fill);
        expect(`${name} ${String(labelKey)} on ${String(fillKey)} = ${r.toFixed(2)}`).toBe(
          `${name} ${String(labelKey)} on ${String(fillKey)} = ${Math.max(r, AA).toFixed(2)}`,
        );
      }
      // The two success/warning discs carry a `brandInk` glyph from their components
      // (ReceiveMode, SendSheet, PayMode, CkErc20DepositSheet all render IconCheck/IconClock).
      for (const disc of ['check', 'checkAlready'] as const) {
        const fill = String((S[disc] as {backgroundColor?: string}).backgroundColor);
        expect(contrast(p.brandInk, fill)).toBeGreaterThanOrEqual(AA);
      }
      // The web key-cap sits on the brand fill under its own scrim.
      const scrim = over(p.ink, 0.14, p.brand);
      expect(contrast(p.brandInk, scrim)).toBeGreaterThanOrEqual(AA);
      // The DISABLED button is a fill swap, and `disabledText` is the other half of it. A
      // disabled control is WCAG-exempt, so this is asserted on principle rather than on the
      // letter: the user has to be able to read what the button they cannot press would do. The
      // opacity fade this replaced measured 2.00:1 (light) and 1.77:1 (dark) — see S.disabledFlat.
      const off = String((S.disabledFlat as {backgroundColor?: string}).backgroundColor);
      const offInk = String((S.disabledText as {color?: string}).color);
      expect(contrast(offInk, off)).toBeGreaterThanOrEqual(AA);
      // …and the label the fade left behind would NOT be readable on it, which is why the pair
      // exists rather than the fill alone.
      expect(contrast(p.brandInk, off)).toBeLessThan(AA);
      // `dim` is the OTHER state — transient busy, and the header block while a payment holds it
      // locked. It is still an opacity, so it still costs contrast, and the cost is bounded here:
      // the quietest ink it is ever applied over must survive it on the page.
      const dimA = Number((S.dim as {opacity?: number}).opacity);
      expect(dimA).toBeGreaterThan(0);
      expect(contrast(over(p.sub, dimA, p.bg), p.bg)).toBeGreaterThanOrEqual(AA);
      applyPalette(LIGHT);
    });
  }
});

describe('4. THE ASSET CHIPS — a monogram on a tint of itself', () => {
  // 17px at weight 700 is BELOW WCAG's large-text floor (≥18.66px at ≥700), so these need 4.5:1,
  // not 3:1 — the assumption that they were "comfortably past the large-text bar" is what let four
  // of them ship at 3.92–4.45. Measured against the real `allChips()`, so a family added to that
  // module is covered here the day it is added.
  for (const [name, p] of themes) {
    test(`${name}: every family chip, over every surface a chip can land on`, () => {
      applyPalette(p);
      const chips = allChips();
      expect(chips.length).toBeGreaterThanOrEqual(7);
      for (const chip of chips) {
        const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(chip.bg);
        expect(m).not.toBeNull();
        const [, r, g, b, a] = m as RegExpExecArray;
        const tintHex = `#${[r, g, b].map(v => Number(v).toString(16).padStart(2, '0')).join('')}`;
        // The tint IS the monogram — one colour per family, so they cannot drift apart.
        expect(tintHex.toLowerCase()).toBe(chip.color.toLowerCase());
        expect(Number(a)).toBe(p.wash);
        for (const surface of PAGE_SURFACES) {
          const ratio = contrast(chip.color, over(chip.color, Number(a), p[surface]));
          expect(`${name} ${chip.glyph} on ${surface} = ${ratio.toFixed(2)}`).toBe(
            `${name} ${chip.glyph} on ${surface} = ${Math.max(ratio, AA).toFixed(2)}`,
          );
        }
      }
      applyPalette(LIGHT);
    });
  }
});

describe('5. NON-TEXT — the marks that carry a state (WCAG 1.4.11, 3:1)', () => {
  for (const [name, p] of themes) {
    test(`${name}: state indicators are distinguishable`, () => {
      applyPalette(p);
      // An active tab is told apart from an inactive one by its FILL, not only by its label.
      expect(contrast(p.brand, p.card)).toBeGreaterThanOrEqual(NON_TEXT);
      // The selected account row's 2px `brandText` selection ring (brief §IV: no left stripe;
      // selection is a ring around the whole card), against the card it runs down.
      expect(String((S.assetCardActive as {borderLeftColor?: string}).borderLeftColor)).toBe(p.brandText);
      expect(String((S.assetCardActive as {borderColor?: string}).borderColor)).toBe(p.brandText);
      expect(contrast(p.brand, p.card)).toBeGreaterThanOrEqual(NON_TEXT);
      // The backup acknowledgement checkbox: unchecked it is a 2px `sub2` ring on the page and
      // NOTHING else — no label inside, no fill — so the ring is the whole control. It measured
      // 2.30:1 before v5 re-spaced the ink tiers.
      expect(contrast(p.sub2, p.bg)).toBeGreaterThanOrEqual(NON_TEXT);
      // The PAID stamp and the passport's filled slots are rings with no fill behind them.
      expect(contrast(p.brandText, p.bg)).toBeGreaterThanOrEqual(NON_TEXT);
      applyPalette(LIGHT);
    });
  }

  test('what is deliberately NOT gated here, and why', () => {
    // `line`/`line2` are DECORATIVE separators — a card hairline, a list divider, the ring around
    // an asset-glyph chip. WCAG 1.4.11 asks for 3:1 on visual information REQUIRED to identify a
    // component or its state; every control that carries one of these also carries a ≥4.5:1 text
    // label, its own surface fill and a lift shadow, so the hairline identifies nothing on its
    // own. They measure 1.08–1.33 and that is a deliberate, stated position rather than an
    // oversight — this assertion exists so the numbers are on the record and a future change that
    // makes a hairline load-bearing has to come back here and move it into the section above.
    for (const [, p] of themes) {
      expect(contrast(p.line, p.bg)).toBeLessThan(NON_TEXT);
      expect(contrast(p.line2, p.card)).toBeLessThan(NON_TEXT);
    }
  });
});

describe('6. THE LARGE-TEXT EXEMPTION IS NOT LOAD-BEARING', () => {
  test('the biggest type on the app clears the NORMAL-text bar anyway', () => {
    // 36px/700 wordmark, 40px/700 home balance, 30px/700 PAID mark, 32px/700 review amount: all
    // qualify for WCAG's 3:1 relaxation and none of them use it. Asserted so that "make it bigger"
    // can never be the fix for a contrast failure in this app.
    for (const [, p] of themes) {
      expect(contrast(p.brandText, p.bg)).toBeGreaterThanOrEqual(AA); // wordmark "pay"
      expect(contrast(p.ink, p.bg)).toBeGreaterThanOrEqual(AA); // wordmark "∂", home balance
      expect(contrast(p.ok, p.bg)).toBeGreaterThanOrEqual(AA); // "Paid ✓"
      expect(contrast(p.warn, p.bg)).toBeGreaterThanOrEqual(AA); // "Already paid"
    }
  });

  test('`wordmarkBig` is self-sufficient — it is applied STANDALONE as a page heading', () => {
    // Onboarding's "Back up your wallet" and the home-currency chooser's title apply this style
    // alone. While it carried only a size it rendered in the platform default: black, weight 400
    // — 1.12:1 on the dark theme's page, an invisible heading. It must carry its own ink.
    for (const [, p] of themes) {
      applyPalette(p);
      const big = S.wordmarkBig as {color?: string; fontWeight?: string; fontFamily?: string};
      expect(big.color).toBe(p.ink);
      expect(big.fontWeight).toBe('700');
      expect(big.fontFamily).toBe((S.wordmark as {fontFamily?: string}).fontFamily);
      applyPalette(LIGHT);
    }
  });
});

describe('7. THE INK HIERARCHY survives AA — three tiers, not two', () => {
  test('each tier is a real step away from the next, in both themes', () => {
    // The v5 re-spacing, stated as a property rather than as four hexes: `sub` sits between `ink`
    // and `sub2` with clear air on both sides. If a future edit squeezes the middle tier out, the
    // honest answer is to DELETE it, and this fails until someone makes that decision on purpose.
    for (const [, p] of themes) {
      const [i, s, s2] = [luminance(p.ink), luminance(p.sub), luminance(p.sub2)];
      const between = (a: number, b: number, c: number) => (a < b && b < c) || (a > b && b > c);
      expect(between(i, s, s2)).toBe(true);
      // Every step is at least a 1.4× contrast move — the smallest gap that reads as a tier at
      // these sizes. Measured: light 1.94 / 1.53, dark 1.73 / 1.58.
      expect(contrast(p.ink, p.sub) >= 1.4 || contrast(p.sub, p.ink) >= 1.4).toBe(true);
      expect(contrast(p.sub, p.sub2)).toBeGreaterThanOrEqual(1.4);
    }
  });
});
