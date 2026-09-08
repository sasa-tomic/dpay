// Palette v5 — "Traveler Paper", dual theme, WCAG 2.2 AA throughout (2026-09-08).
//
// v4 (2026-08-20) kept the 2026-08-17 warm-porcelain values byte-for-byte. A full contrast audit
// (256 rendered text nodes, 6 screens × 2 themes, effective background walked up the tree) found
// that the accent and the third ink tier had never cleared AA: `sub2` measured 2.30:1 on porcelain,
// the tangerine 2.76:1, white-on-tangerine 3.12:1. v5 is the arithmetic answer. The SURFACES and
// the PRIMARY ink are unchanged — the paper, the depth-by-layering and the near-black warm ink are
// the identity and none of them moved. What moved is the accent's lightness and the two lower ink
// tiers. Mirrors crates/dpay-relay/assets/landing.html CSS vars (the two homes for one palette —
// keep them in lockstep).
//
// ── THE CONTRAST CONTRACT ────────────────────────────────────────────────────────────────────
// Gated by `app/__tests__/contrast.test.ts`, which walks THIS file against the live stylesheet.
//
// ONE surface binds each theme, and it is not the same one:
//   LIGHT — dark ink on light paper, so the DARKEST surface binds: `bg` #F4F1E8. A token that
//           clears 4.5:1 there clears panel2/panel/card automatically.
//   DARK  — light ink on dark paper, so the LIGHTEST surface binds: `card` #2A2620.
// Any token that also appears inside a soft tint OF ITSELF (`wash`) must clear AA against that
// composite too, which is strictly harder — that constraint, not the page, is what sets the
// accents' depth. Every accent below was solved against it.
//
// ── WHY THERE ARE THREE INK TIERS AND NOT TWO ────────────────────────────────────────────────
// On porcelain, AA caps a foreground at Y ≤ 0.1566 while `sub` sits at Y = 0.1231: a compliant
// third tier has ~4 points of OKLCH lightness to live in below `sub`, which is not a tier, it is
// a rounding error. The fix is not a darker `sub2` — it is RE-SPACING. `sub` moved down (L .497
// → .420) to open the band, `sub2` sits just inside the AA floor (L .520), and the remaining
// step is carried by TYPOGRAPHY: every `sub2` site is already mono, uppercase, letterspaced and
// 10–12px (eyebrows, timestamps, receipt labels, memos). Three tiers, ~.20 and ~.10 of OKLCH
// lightness apart, all AA. The dark theme is re-spaced the same way, mirrored.
//
// ── WHY THE TANGERINE IS A TWO-STEP RAMP ─────────────────────────────────────────────────────
// One tangerine cannot be both a fill behind white text and text on porcelain: white on a fill
// needs the fill at Y ≤ 0.1833, text on porcelain needs Y ≤ 0.1566, and the wash constraint above
// pushes the text step to Y ≤ 0.140. A single value forced to the strictest of those is a
// mahogany CTA. So `brand` is the FILL step and `brandText` is the INK step, one hue (OKLCH h
// 37.7 — the same angle as the retired #FF5A1F), two lightnesses, each with its job stated below.
//
// Discipline (unchanged from v4): the tangerine is spent ONLY on primary CTAs, active
// tabs/chips, and the mark. `ok` green is success/online ONLY. Never tint large surfaces with the
// accent. NO pure #000 anywhere in the dark theme — the warm family keeps the "paper" voice.
//
// MECHANISM: `C` below is a MUTABLE plain object initialized from LIGHT. `applyPalette(p)`
// (app/styles.ts) Object.assigns a palette onto `C` AND onto the `S` stylesheet holder, then the
// app re-renders — every `C.x` / `S.x` read site picks up the new values. Never reassign the
// bindings; only mutate in place (ESM live bindings + CJS interop both observe in-place
// mutation). LIGHT/DARK are frozen templates and are never handed to rendering directly. A
// component must therefore read `C.x` AT RENDER TIME: a module-level `const X = C.brand` captures
// one theme's value forever, which was invisible while the two themes shared a tangerine and is a
// visible bug now that they do not.
export type Palette = {
  // Surfaces (depth by layering, not borders-everywhere). Unchanged since 2026-08-17.
  bg: string; // page — the BINDING surface for every light-theme foreground
  panel: string; // raised sheet / cards
  panel2: string; // inset wells, tab strips
  card: string; // cards, inputs — the BINDING surface for every dark-theme foreground
  field: string; // inputs sit on cards/panel2
  // Ink — three tiers, re-spaced in v5 so all three clear AA (see the header note)
  ink: string; // primary text: amounts, names, headings
  sub: string; // secondary text: body copy, labels, inactive tab labels
  sub2: string; // tertiary: eyebrows, timestamps, memos, receipt labels — mono/caps/small
  // Accent — one hue, two steps, one ink
  brand: string; // FILL ONLY: buttons, active tabs/chips, filled dots, the mark's tile
  brandText: string; // every UNFILLED tangerine: text, icons, hairline rings, and its own `wash`
  brand2: string; // pressed tone / brand shadow. Never carries text and never sits under text.
  brandInk: string; // the ink ON a saturated fill — `brand`, and `ok`/`warn` when they are fills
  // Status — each one serves as text, as a `wash`, and as a fill under `brandInk`
  ok: string; // success / online ONLY
  bad: string; // errors, refusals, destructive
  warn: string; // cautions, expiries, "already settled"
  // Lines
  line: string; // hairline on page bg
  line2: string; // softer hairline on cards
  // Theme-derived extras (kept IN the palette so styles.ts builds from one object)
  shadow: string; // soft ink shadow color for LIFT (near-black in dark, never #000)
  veil: string; // modal backdrop veil (pickBackdrop)
  glyphBorder: string; // AssetGlyph chip ring (light: warm-ink; dark: cream)
  glyphBorderLg: string;
  /** The ONE alpha for a soft tint of an accent on a surface (status pills, the MAIN badge, the
   *  asset-glyph chips, the reset/backup boxes). It is a CONTRAST parameter, not a taste one:
   *  every accent above was solved to still clear 4.5:1 against a tint of itself at exactly this
   *  alpha, over every surface. Raising it re-opens the failures v5 closed. Border alphas on the
   *  same pills stay per-site — a hairline carries emphasis, not text. */
  wash: number;
};

/** `#rrggbb` + alpha → the `rgba()` string RN and RNW both accept. Exists so a tint is DERIVED
 *  from the token it tints instead of being re-typed as an rgb triple beside it — the v4 palette
 *  carried `badRGB`/`warnRGB` stems and six hand-written `rgba(255,90,31,…)` literals, i.e. eight
 *  copies of three colours, each free to drift on the next palette edit. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`withAlpha needs an #rrggbb colour, got: ${hex}`);
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

// LIGHT — warm porcelain paper. Ratios in the comments are against `bg` (the binding surface)
// unless another surface is named; every one is asserted in app/__tests__/contrast.test.ts.
export const LIGHT: Palette = {
  // Surfaces — byte-identical to 2026-08-17.
  bg: '#F4F1E8', // warm porcelain page
  panel: '#FDFCF9', // raised sheet / cards on porcelain
  panel2: '#F8F6F0', // inset wells, tab strips
  card: '#FFFFFF', // white cards, inputs
  field: '#FFFFFF', // inputs sit on cards/panel2 as white
  // Ink
  ink: '#1B1A17', // near-black warm ink — 15.41
  sub: '#524D41', // secondary — 7.45 (was #676257 / 5.37; moved down to open the third tier)
  sub2: '#6D675B', // tertiary — 4.97 (was #A6A093 / 2.30, the audit's worst text failure)
  // Accent — OKLCH h 37.7 for both steps, the retired #FF5A1F's own hue angle
  brand: '#D03F00', // FILL — brandInk on it 4.78; 4.13 against the page, so the shape reads
  brandText: '#B93700', // INK/RING/WASH — 5.15, and 4.72 on a `wash` of itself over any surface
  brand2: '#912900', // pressed / shadow only
  brandInk: '#FFFFFF', // on `brand` 4.78, on `ok` 5.80, on `warn` 5.73
  // Status
  ok: '#1B7351', // 5.13, 4.73 on its own wash; white on it 5.80
  bad: '#C32335', // 5.13, 4.70 on its own wash; white on it 5.81
  warn: '#9B5400', // 5.08, 4.70 on its own wash; white on it 5.73 (also the "already" fill)
  // Lines
  line: '#E5DFD1', // hairline on porcelain
  line2: '#EDE8DC', // softer hairline on cards
  // Extras
  shadow: '#1B1A17',
  veil: 'rgba(27,26,23,0.45)',
  glyphBorder: 'rgba(27,26,23,0.07)',
  glyphBorderLg: 'rgba(27,26,23,0.09)',
  wash: 0.06,
};

// DARK — "Traveler Paper at night". Same warm family, surfaces lifted in three steps so depth
// still comes from layering. The accents are the LIFTED step of each hue and the ink that sits on
// them flips to the warm near-black: a dark mode's saturated fill wants a dark label, and a deep
// fill on a near-black page reads as mud. Ratios are against `card` (the binding surface here).
export const DARK: Palette = {
  bg: '#141210', // warm near-black page (never #000)
  panel: '#1D1A16', // raised sheet
  panel2: '#24211C', // inset wells, tab strips
  card: '#2A2620', // cards, inputs — the binding surface
  field: '#2A2620',
  ink: '#F2EEE6', // cream primary text — 12.99
  sub: '#BEB6A9', // secondary — 7.49 (was #A8A094 / 5.81; lifted to open the third tier)
  sub2: '#9A9386', // tertiary — 4.93 (was #8A8274 / 3.96)
  brand: '#FF5A1F', // FILL — the original tangerine, kept: brandInk on it 5.58, 5.99 vs the page
  brandText: '#FF6F41', // INK/RING/WASH — 5.44, and 4.72 on a `wash` of itself over any surface
  brand2: '#E0480F', // pressed / shadow only
  brandInk: '#1B1A17', // the warm near-black, ON the lifted fills (brand 5.58, ok 6.0, warn 8.0)
  ok: '#30B180', // 5.29, 4.75 on its own wash
  bad: '#F77476', // 5.38, 4.72 on its own wash
  warn: '#E9A23B', // 6.94, 5.78 on its own wash (also the "already" fill — unchanged from v4)
  line: '#3B362D', // hairline on page
  line2: '#34302A', // softer hairline on cards
  shadow: '#0A0908', // near-black lift shadow (not #000)
  veil: 'rgba(0,0,0,0.60)',
  glyphBorder: 'rgba(242,238,230,0.08)',
  glyphBorderLg: 'rgba(242,238,230,0.10)',
  wash: 0.1,
};

/** The LIVE palette. Mutable in place by `applyPalette` (app/styles.ts) — read `C.x` at render
 *  time; do not capture values at module load in components. Initialized from the OS scheme
 *  (synchronous probe at styles.ts module load) so the FIRST paint already matches (no light
 *  flash on a dark OS). */
export const C: Palette = {...LIGHT};

// Type stack. Space Grotesk (bundled) carries everything; IBM Plex Mono (bundled) carries
// numerals, addresses, seeds — the "receipt" voice. Android serves both via res/font
// (RN resolves fontFamily by the resource name = the lowercase ttf filename); the web build
// registers @font-face families under the SAME names (e2e/web/{index,wallet}.html), so one
// fontFamily string works on both platforms.
export const FONT = {
  sans: 'space_grotesk_500',
  sansMedium: 'space_grotesk_600',
  sansBold: 'space_grotesk_700',
  mono: 'plex_mono_500',
};
