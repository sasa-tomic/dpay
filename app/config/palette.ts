// Palette v3 — "Traveler Paper" (2026-08-17 complete redesign).
// Warm porcelain light theme with vivid tangerine accent. The traveler uses this wallet
// OUTDOORS in sunlight — light chrome photographs beautifully, reads in glare, and stands
// apart from every dark crypto-chic competitor. Mirrors crates/dpay-relay/assets/landing.html
// CSS vars (the two homes for one palette — keep them in lockstep).
//
// Discipline: `brand` is spent ONLY on primary CTAs, active tabs/chips, and the logo.
// `ok` green is success/online ONLY. Never tint large surfaces with the accent.
export const C = {
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
  // Lines
  line: '#E5DFD1', // hairline on porcelain
  line2: '#EDE8DC', // softer hairline on cards
};

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
