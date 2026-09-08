// The relay's static pages, painted from the app's palette — ONE source, four consumers.
//
// WHY THIS EXISTS. `app/config/palette.ts` is the single home for dpay's colour VALUES, and it was
// the single home for exactly one of the five surfaces that render them. `landing.html`,
// `privacy.html`, `till.html` and `till-code.html` each carried a HAND-MAINTAINED copy of the
// light+dark var block, so palette v5 (2026-09-08) moved the app and left the website on v4 —
// and till.html/till-code.html had already drifted off v4 before that (`--ok:#1E7F4F`,
// `--panel:#1D1A17`, `--line:#2E2A25`, a dark `--ink` set to the LIGHT page colour). Four copies of
// one fact is four places to forget; the fix is not to update them, it is to stop having them.
//
// The pages now carry a `{{PALETTE}}` token that the relay substitutes with the emitted block
// below (`crates/dpay-relay/src/app.rs`, the same mechanism `{{DOWNLOAD}}` already used), and every
// colour in them is `var(--token)`. The checked-in artifact is
// `crates/dpay-relay/assets/palette.css`, because the Rust build `include_str!`s it and must never
// depend on Node; `app/__tests__/relay-palette.test.ts` fails the moment it stops matching this
// emitter, which is the drift alarm the catalog already has against `dfx/catalog_truth.json`.
//
// ── TWO DARK-MODE MECHANISMS, ONE BLOCK ────────────────────────────────────────────────────────
// landing/privacy resolve the theme in a pre-paint script that sets `data-theme-mode` (and the
// `.dark` class their component rules key on) from `localStorage` falling back to the OS scheme;
// till/till-code have no script at all and follow `prefers-color-scheme` directly. Rather than pick
// a winner (which would mean adding JS to a kiosk page, or taking the toggle off the landing page),
// the emitted block serves both and each page DECLARES which it uses with one static attribute:
// a page that follows the OS puts `class="scheme-auto"` on <html>; a page that resolves the theme
// itself does not. Behaviour on all four is byte-identical to before this change.
//
// ── WHAT IS EMITTED ────────────────────────────────────────────────────────────────────────────
// Every hex token of `Palette`, twice: `--<name>` (the colour) and `--<name>RGB` (its channels), so
// a page can tint with `rgba(var(--brandRGB), .22)` instead of re-typing the tangerine at a new
// alpha — which is how a dozen `rgba(255,90,31,…)` literals survived a palette change that moved
// the tangerine. `--wash` (the alpha the app uses for a token tinted on itself) rides along so a
// page can compose the app's own soft tint exactly. The non-hex tokens (`veil`, `glyphBorder*`) are
// deliberately NOT emitted: nothing on the website uses them, and emitting dead vars invites use.
//
// Plus THREE theme-INVARIANT mark tokens. The ∂ tile is the one thing on any dpay surface that does
// not flip: `app/components/Logo.tsx` paints it from `LIGHT` in both themes, and the Android
// adaptive launcher mirrors those same two stops, because a launcher icon has no night variant and
// an emblem that disagreed with the icon on the same home screen is the drift this repo forbids.
// The website's inline SVG mark is the same mark, so it reads the same three values — emitted once,
// outside the theme blocks, so no theme rule can move them. `--fixedInk`/`--fixedPaper` are the
// other half of the same idea and the CSS answer to the app's own `inv` binding
// (app/styles.ts): a small element that INVERTS against whatever theme it sits in — the landing
// page's step-number chip is near-black with white digits on porcelain AND on near-black — needs
// inks that do not flip, or it inherits a cream chip under white text the moment the page goes
// dark. Naming them is what let that override be a border rule instead of a re-typed colour.
//
// ── WHY IT LIVES HERE, AND TAKES ITS PALETTES AS ARGUMENTS ─────────────────────────────────────
// It sits beside the palette it derives, and NO app module imports it — it is reached by
// `scripts/gen-relay-palette.mjs` (which writes the artifact) and by
// `app/__tests__/relay-palette.test.ts` (the drift alarm). It takes `light`/`dark` as parameters
// rather than importing them so its only import is a TYPE, which Node's type-stripping erases
// outright: that is what lets a plain `node` script call it with no bundler, no transpile step and
// nothing added to the offline inner loop.
import type {Palette} from './palette';

/** The tokens emitted, in order. Hex-valued `Palette` keys only — see the header for what is left
 *  out and why. Ordered by role (surfaces → ink → accent → status → lines → depth) so a human
 *  diff of the generated file reads like the palette it came from. */
const TOKENS: (keyof Palette)[] = [
  'bg', 'panel', 'panel2', 'card', 'field',
  'ink', 'sub', 'sub2',
  'brand', 'brandText', 'brand2', 'brandInk',
  'ok', 'bad', 'warn',
  'line', 'line2',
  'shadow',
];

/** `#RRGGBB` → `R, G, B` for `rgba(var(--xRGB), a)`. Throws on anything else: a token that is not a
 *  plain hex has no channel form, and silently skipping it would emit a var that resolves to
 *  nothing at run time — an invisible colour bug on a page with no test that can see it. */
function channels(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`relay-palette-css: token value ${hex} is not a 6-digit hex colour`);
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function block(palette: Palette, indent = '  '): string {
  const lines = TOKENS.map(t => `${indent}--${t}: ${palette[t]}; --${t}RGB: ${channels(String(palette[t]))};`);
  lines.push(`${indent}--wash: ${palette.wash};`);
  return lines.join('\n');
}

/** The exact bytes of `crates/dpay-relay/assets/palette.css`. Pure — same palette in, same file out,
 *  which is what lets the drift alarm be a byte comparison. */
export function relayPaletteCss(light: Palette, dark: Palette): string {
  return [
    '/* GENERATED FILE — DO NOT EDIT.',
    ' *',
    ' * Source of truth: app/config/palette.ts (LIGHT + DARK). Emitter + rationale:',
    ' * app/config/relayPaletteCss.ts. Regenerate with `just palette-css`; the drift alarm that fails',
    ' * when this file and the palette disagree is app/__tests__/relay-palette.test.ts.',
    ' *',
    ' * The relay substitutes this whole block for each page\'s palette placeholder — `with_palette`',
    ' * in crates/dpay-relay/src/app.rs — in landing.html, privacy.html, till.html and',
    ' * till-code.html. The placeholder is deliberately NOT spelled out here: this text is injected',
    ' * into every page, so a copy of the token inside the injected block would survive the',
    ' * substitution and defeat the serving test that checks the substitution happened.',
    ' *',
    ' * A page that follows the OS scheme carries class="scheme-auto" on <html>; a page that',
    ' * resolves the theme itself sets data-theme-mode pre-paint.',
    ' */',
    '',
    '/* Theme-INVARIANT islands. The MARK: app/components/Logo.tsx paints the tile from LIGHT in both',
    ' * themes and the Android launcher mirrors it, so the website mark must too. The FIXED inks: the',
    ' * near-black and the white that a small inverted element keeps whatever theme it sits in. */',
    ':root {',
    `  --markTop: ${light.brand}; --markBottom: ${light.brand2}; --markInk: ${light.panel};`,
    `  --fixedInk: ${light.ink}; --fixedPaper: ${light.card};`,
    '}',
    '',
    ':root {',
    block(light),
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  html.scheme-auto {',
    block(dark, '    '),
    '  }',
    '}',
    'html[data-theme-mode="light"] {',
    block(light),
    '}',
    'html[data-theme-mode="dark"], html.dark {',
    block(dark),
    '}',
    '',
  ].join('\n');
}
