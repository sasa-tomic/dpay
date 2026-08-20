// Palette v4 — "Traveler Paper" dual theme (2026-08-20).
// LIGHT is byte-identical to the 2026-08-17 warm-porcelain single theme (zero visual churn —
// flow 40's committed light baselines stay valid). DARK is the warm near-black night reading of
// the same identity: cream ink on layered umber surfaces, tangerine kept for action.
// Mirrors crates/dpay-relay/assets/landing.html CSS vars (the two homes for one palette — keep
// them in lockstep).
//
// Discipline (both themes): `brand` is spent ONLY on primary CTAs, active tabs/chips, and the
// logo. `ok` green is success/online ONLY. Never tint large surfaces with the accent. NO pure
// #000 anywhere in the dark theme — the warm family reads softer and keeps the "paper" voice.
//
// MECHANISM: `C` below is a MUTABLE plain object initialized from LIGHT. `applyPalette(p)`
// (app/styles.ts) Object.assigns a palette onto `C` AND onto the `S` stylesheet holder, then the
// app re-renders — every `C.x` / `S.x` read site picks up the new values. Never reassign the
// bindings; only mutate in place (ESM live bindings + CJS interop both observe in-place
// mutation). LIGHT/DARK are frozen templates and are never handed to rendering directly.
export type Palette = {
  // Surfaces (depth by layering, not borders-everywhere)
  bg: string; // page
  panel: string; // raised sheet / cards
  panel2: string; // inset wells, tab strips
  card: string; // cards, inputs
  field: string; // inputs sit on cards/panel2
  // Ink
  ink: string; // primary text
  sub: string; // secondary text
  sub2: string; // tertiary / eyebrows
  // Accent
  brand: string; // vivid tangerine — CTA / active / logo ONLY (same hue both themes)
  brand2: string; // pressed tangerine / brand shadow tone
  brandInk: string; // text on brand
  // Status
  ok: string; // success / online dot ONLY
  bad: string;
  warn: string; // warning TEXT tone (lifted cream-amber in dark)
  warnDeep: string; // warning FILL tone (dark enough for brandInk glyphs on top — checkAlready)
  // Lines
  line: string; // hairline on page bg
  line2: string; // softer hairline on cards
  // Theme-derived extras (kept IN the palette so styles.ts builds from one object)
  shadow: string; // soft ink shadow color for LIFT (near-black in dark, never #000)
  veil: string; // modal backdrop veil (pickBackdrop)
  glyphBorder: string; // AssetGlyph chip ring (light: warm-ink; dark: cream)
  glyphBorderLg: string;
  // Base "r,g,b" strings for the low-alpha status tints (pill/box washes). Keeping the rgb stem
  // in the palette lets the per-site alphas in styles.ts stay byte-identical in light while dark
  // swaps the stem to its lifted hue.
  badRGB: string;
  warnRGB: string;
};

export const LIGHT: Palette = {
  // Surfaces (depth by layering, not borders-everywhere)
  bg: '#F4F1E8', // warm porcelain page
  panel: '#FDFCF9', // raised sheet / cards on porcelain
  panel2: '#F8F6F0', // inset wells, tab strips
  card: '#FFFFFF', // white cards, inputs
  field: '#FFFFFF', // inputs sit on cards/panel2 as white
  // Ink
  ink: '#1B1A17', // near-black warm ink
  sub: '#676257', // secondary text
  sub2: '#A6A093', // tertiary / eyebrows
  // Accent
  brand: '#FF5A1F', // vivid tangerine — CTA / active / logo ONLY
  brand2: '#E0480F', // pressed tangerine
  brandInk: '#FFFFFF', // text on brand
  // Status
  ok: '#0E9F6E', // success / online dot ONLY
  bad: '#E5484D',
  warn: '#B45309',
  warnDeep: '#B45309',
  // Lines
  line: '#E5DFD1', // hairline on porcelain
  line2: '#EDE8DC', // softer hairline on cards
  // Extras (light values are byte-identical to the pre-theme literals)
  shadow: '#1B1A17',
  veil: 'rgba(27,26,23,0.45)',
  glyphBorder: 'rgba(27,26,23,0.07)',
  glyphBorderLg: 'rgba(27,26,23,0.09)',
  badRGB: '229,72,77',
  warnRGB: '180,83,9',
};

// Dark — "Traveler Paper at night". Warm near-black family: the same warm-ink hue family as
// light (no blue-gray crypto-dark), surfaces lifted in three steps (bg → panel → panel2/card)
// so depth still comes from layering. Cream ink #F2EEE6 (16.2:1 on bg), tangerine UNCHANGED
// (5.99:1 on bg as text — passes AA, so no lifted brand-text variant is needed). Status hues
// lift where they sit as text on dark surfaces (warn → cream-amber; bad already passes; ok
// passes everywhere it renders as text on bg). Contrast table in the Wave-4 report.
export const DARK: Palette = {
  bg: '#141210', // warm near-black page (never #000)
  panel: '#1D1A16', // raised sheet
  panel2: '#24211C', // inset wells, tab strips
  card: '#2A2620', // cards, inputs
  field: '#2A2620', // inputs sit on cards/panel2
  ink: '#F2EEE6', // cream primary text
  sub: '#A8A094', // secondary text (7.2:1 on bg)
  sub2: '#8A8274', // tertiary / eyebrows (4.9:1 on bg)
  brand: '#FF5A1F', // tangerine unchanged
  brand2: '#E0480F', // pressed tangerine / brand shadow tone unchanged
  brandInk: '#FFFFFF',
  ok: '#0E9F6E',
  bad: '#E5484D',
  warn: '#E9A23B', // lifted cream-amber for TEXT on dark (8.6:1 on bg)
  warnDeep: '#B45309', // FILL tone — dark enough for the white checkmark (4.7:1)
  line: '#3B362D', // hairline on page
  line2: '#34302A', // softer hairline on cards
  shadow: '#0A0908', // near-black lift shadow (not #000)
  veil: 'rgba(0,0,0,0.60)',
  glyphBorder: 'rgba(242,238,230,0.08)',
  glyphBorderLg: 'rgba(242,238,230,0.10)',
  badRGB: '241,106,111',
  warnRGB: '233,162,59',
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
