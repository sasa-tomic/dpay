// Palette v6 - "Ballast", dual theme, WCAG 2.2 AA throughout (2026-09-26).
//
// Ballast replaces "Traveler Paper" wholesale: cold mist surfaces + deep petrol teal action +
// graphite ink (LIGHT "Mist"), petrol-black night + lifted aqua-teal + ice ink (DARK "Deep
// water"). No warm channel exists in either map. The one saturated moment is the Settlement
// Field: a full-bleed `brand` surface carrying `brandInk` type wherever value is in motion.
// The contract below is unchanged from v5; only the VALUES moved. Mirrors
// crates/dpay-relay/assets/palette.css (the two homes for one palette - keep them in lockstep).
//
// ── THE CONTRAST CONTRACT ────────────────────────────────────────────────────────────────────
// Gated by `app/__tests__/contrast.test.ts`, which walks THIS file against the live stylesheet.
//
// ONE surface binds each theme, and it is not the same one:
//   LIGHT - dark ink on light ground, so the DARKEST surface binds: `bg` #EBF0ED. A token that
//           clears 4.5:1 there clears panel2/panel/card automatically.
//   DARK  - light ink on dark ground, so the LIGHTEST surface binds: `card` #1F2A26.
// Any token that also appears inside a soft tint OF ITSELF (`wash`) must clear AA against that
// composite too, which is strictly harder - that constraint, not the page, is what sets the
// accents' depth. Every accent below was solved against it.
//
// ── WHY THE ACCENT IS A TWO-STEP RAMP ────────────────────────────────────────────────────────
// One petrol teal cannot be both a fill behind `brandInk` and text on mist: a fill needs depth
// for the white label, text needs headroom against the page AND against its own `wash` tint.
// A single value forced to the strictest of those goes near-black. So `brand` is the FILL step
// and `brandText` is the INK step, one hue family, two lightnesses, each with its job below.
//
// Discipline: `brand` is spent ONLY on the Settlement Field, primary CTAs, active tabs/chips and
// filled dots. `brandText` is the only accent an unfilled element may wear. `ok`/`bad`/`warn`
// keep their traffic-light meanings and never decorate. NO pure #000 anywhere in the dark theme.
//
// MECHANISM: `C` below is a MUTABLE plain object initialized from LIGHT. `applyPalette(p)`
// (app/styles.ts) Object.assigns a palette onto `C` AND onto the `S` stylesheet holder, then the
// app re-renders - every `C.x` / `S.x` read site picks up the new values. Never reassign the
// bindings; only mutate in place (ESM live bindings + CJS interop both observe in-place
// mutation). LIGHT/DARK are frozen templates and are never handed to rendering directly. A
// component must therefore read `C.x` AT RENDER TIME: a module-level `const X = C.brand` captures
// one theme's value forever.
export type Palette = {
  // Surfaces (depth by layering, not borders-everywhere)
  bg: string; // page - the BINDING surface for every light-theme foreground
  panel: string; // raised sheet / cards
  panel2: string; // inset wells, tab strips
  card: string; // cards, inputs - the BINDING surface for every dark-theme foreground
  field: string; // inputs sit on cards/panel2, one step off card so a field reads at rest
  // Ink - three tiers
  ink: string; // primary text: amounts, names, headings
  sub: string; // secondary text: body copy, labels, inactive tab labels
  sub2: string; // tertiary: timestamps, memos, receipt labels (sentence-case sans)
  // Accent - one hue family, two steps, one ink
  brand: string; // FILL ONLY: the Settlement Field, buttons, active tabs/chips, filled dots
  brandText: string; // every UNFILLED accent: text, icons, hairline rings, and its own `wash`
  brand2: string; // pressed tone / brand separators. Never carries text and never sits under text.
  brandInk: string; // the ink ON a saturated fill - `brand`, and `ok`/`warn` when they are fills
  // Status - each one serves as text, as a `wash`, and as a fill under `brandInk`
  ok: string; // success / settled ONLY
  bad: string; // errors, refusals, destructive
  warn: string; // cautions, expiries, "already settled"
  // Lines - separators, not boxes
  line: string; // hairline on page bg
  line2: string; // softer hairline on cards
  // Theme-derived extras (kept IN the palette so styles.ts builds from one object)
  shadow: string; // soft ink shadow color for LIFT (near-black in dark, never #000)
  veil: string; // modal backdrop veil (pickBackdrop)
  glyphBorder: string; // AssetGlyph chip ring (light: graphite; dark: ice)
  glyphBorderLg: string;
  /** The ONE alpha for a soft tint of an accent on a surface (status pills, the MAIN badge, the
   *  asset-glyph chips, the reset/backup boxes). It is a CONTRAST parameter, not a taste one:
   *  every accent above was solved to still clear 4.5:1 against a tint of itself at exactly this
   *  alpha, over every surface. Raising it re-opens failures. Border alphas on the same pills
   *  stay per-site - a hairline carries emphasis, not text. */
  wash: number;
};

/** `#rrggbb` + alpha → the `rgba()` string RN and RNW both accept. Exists so a tint is DERIVED
 *  from the token it tints instead of being re-typed as an rgb triple beside it. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`withAlpha needs an #rrggbb colour, got: ${hex}`);
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

// LIGHT - "Mist": cold, green-blue-tinted paper-white. Surfaces step monotonically toward card.
// Ratios in the comments are against `bg` (the binding surface); the gate asserts them all.
export const LIGHT: Palette = {
  // Surfaces
  bg: '#EBF0ED', // cold mist page (binding surface)
  panel: '#FAFCFB', // raised sheets, pick cards
  panel2: '#F0F4F2', // inset wells, tab strips, segmented-control track
  card: '#FFFFFF', // cards, inputs
  field: '#F5F8F7', // inputs on white cards: one step off card so a field is visible at rest
  // Ink - graphite with a petrol cast
  ink: '#17221F', // ≈14.5 on bg
  sub: '#3E4F49', // ≈7.5 on bg
  sub2: '#5D6F69', // ≈4.9 on bg, ≈4.8 on panel2 (tertiary labels, sentence case)
  // Accent - deep petrol teal. brand = fill only, brandText = text/ring/wash
  brand: '#0E5F53', // FILL: brandInk on it ≈7.4; ≈6.5 vs bg so the shape reads
  brandText: '#0B5147', // ≈7.7 on bg, ≈7.2 on own wash
  brand2: '#093F37', // pressed fill / brand separators only
  brandInk: '#FFFFFF', // on brand ≈7.4, on ok ≈5.9, on warn ≈5.5
  // Status
  ok: '#1B7340', // ≈5.2 on bg; ≈4.7 on own wash
  bad: '#C22A3F', // ≈5.0 on bg; ≈4.6 on own wash
  warn: '#94560A', // ≈4.8 on bg; ≈4.6 on own wash (also the "already" fill)
  // Lines
  line: '#D6DFDA', // hairline on mist
  line2: '#E3EAE6', // softer hairline on cards
  // Extras
  shadow: '#17221F',
  veil: 'rgba(23,34,31,0.48)',
  glyphBorder: 'rgba(23,34,31,0.08)',
  glyphBorderLg: 'rgba(23,34,31,0.10)',
  wash: 0.06,
};

// DARK - "Deep water": a petrol-black, not a neutral black; the page itself carries the brand's
// hue at near-zero chroma. Fills lift; ink on fills flips to the deep ink. Ratios are against
// `card` (the binding surface here).
export const DARK: Palette = {
  // Surfaces
  bg: '#0C1312', // deep petrol-black page (never #000)
  panel: '#121B19', // raised sheet
  panel2: '#19221F', // inset wells, tab strips
  card: '#1F2A26', // cards, inputs - the binding surface (lightest of the surface stack)
  field: '#26332F', // one step off card + line border: visible at rest
  // Ink - ice with a petrol cast
  ink: '#ECF2EF', // ≈12 on card
  sub: '#B0C2BB', // ≈7 on card
  sub2: '#8CA49A', // ≈5.6 on card (1.43 step below sub; sentence-case tertiary only)
  // Accent - lifted aqua-teal. brand = fill only, brandText = text/ring/wash
  brand: '#2FB497', // FILL: brandInk on it ≈6.5
  brandText: '#63DABB', // ≈7 on card, ≥4.5 on own wash
  brand2: '#1E8A72', // pressed
  brandInk: '#0C1312', // the deep ink, ON the lifted fills (brand ≈6.5, ok ≈8, warn ≈9)
  // Status
  ok: '#46CE95', // ≥4.5 on card and on own wash
  bad: '#F79BA1',
  warn: '#E9BA66', // also the "already" fill
  // Lines
  line: '#2E3A35', // hairline on page
  line2: '#28332F', // softer hairline on cards
  // Extras
  shadow: '#060A09', // near-black lift shadow (not #000)
  veil: 'rgba(4,8,7,0.62)',
  glyphBorder: 'rgba(236,242,239,0.08)',
  glyphBorderLg: 'rgba(236,242,239,0.10)',
  wash: 0.10,
};

/** The LIVE palette. Mutable in place by `applyPalette` (app/styles.ts) - read `C.x` at render
 *  time; do not capture values at module load in components. Initialized from the OS scheme
 *  (synchronous probe at styles.ts module load) so the FIRST paint already matches (no light
 *  flash on a dark OS). */
export const C: Palette = {...LIGHT};

// Type stack. Space Grotesk (bundled) carries everything; IBM Plex Mono (bundled) carries ONLY
// opaque strings: addresses, principals, hashes, seeds, calldata, relay URLs, keycaps. Android
// serves both via res/font (RN resolves fontFamily by the resource name = the lowercase ttf
// filename); the web build registers @font-face families under the SAME names
// (e2e/web/{index,wallet}.html), so one fontFamily string works on both platforms.
export const FONT = {
  sans: 'space_grotesk_500',
  sansMedium: 'space_grotesk_600',
  sansBold: 'space_grotesk_700',
  mono: 'plex_mono_500',
};
