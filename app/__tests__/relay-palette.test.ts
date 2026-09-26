/**
 * The website cannot fall behind the app's palette — the drift alarm (M5).
 *
 * WHAT BROKE, AND WHY A TEST IS THE FIX. Palette v5 (2026-09-08) re-grounded every accent for WCAG
 * AA and moved the tangerine. The app moved with it. The relay's four static pages did not: each
 * carried its OWN hand-typed copy of the light+dark var block, so the website kept painting v4 —
 * and `checkout.html`/`checkout-code.html` had drifted off v4 *before* that change, with their own `--ok`,
 * `--panel`, `--line` and a dark `--ink` set to the LIGHT page colour. Four copies of one fact is
 * four places to forget, and nothing failed when three of them were forgotten.
 *
 * The copies are gone: `app/config/palette.ts` is the single source, `app/config/relayPaletteCss.ts`
 * emits the CSS, `crates/dpay-relay/assets/palette.css` is the checked-in artifact the Rust build
 * `include_str!`s (the relay must never need Node), and the pages carry a `{{PALETTE}}` token the
 * relay substitutes. This file is what makes that structure hold:
 *
 *   1. the artifact matches the emitter, byte for byte (`just palette-css` regenerates it);
 *   2. every page consumes the token and defines no palette of its own;
 *   3. no page re-types a palette colour as a literal — the failure mode that produced the drift;
 *   4. the `<meta name="theme-color">` values, which are the ONE place a var cannot reach, still
 *      equal the palette's page colours.
 *
 * It is the same shape as the catalog's drift alarm against `dfx/catalog_truth.json`, for the same
 * reason: a fact with two homes needs a test standing between them.
 */
import {describe, test, expect} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DARK, LIGHT} from '../config/palette';
import {relayPaletteCss} from '../config/relayPaletteCss';

const REPO = join(__dirname, '..', '..');
const ASSETS = join(REPO, 'crates', 'dpay-relay', 'assets');
const PAGES = ['landing.html', 'privacy.html', 'checkout.html', 'checkout-code.html'] as const;

const read = (name: string) => readFileSync(join(ASSETS, name), 'utf8');

describe('the relay palette is GENERATED from the app palette', () => {
  test('the checked-in palette.css is exactly what the emitter produces', () => {
    // If this fails, palette.ts moved and the website did not: run `just palette-css`.
    expect(read('palette.css')).toBe(relayPaletteCss(LIGHT, DARK));
  });

  test('every palette token reaches the CSS, in both themes, with its channel form', () => {
    const css = read('palette.css');
    // The channel form is what killed the `rgba(255,90,31,…)` literals: a page tints with
    // `rgba(var(--brandRGB), .22)` instead of re-typing the colour at a new alpha.
    for (const [name, hex] of [['brand', LIGHT.brand], ['brandText', LIGHT.brandText], ['ok', LIGHT.ok]] as const) {
      expect(css).toContain(`--${name}: ${hex};`);
      expect(css).toContain(`--${name}RGB:`);
    }
    expect(css).toContain(`--brand: ${DARK.brand};`); // the dark half is emitted too
  });

  test('it serves BOTH theme mechanisms, so no page had to change how it resolves the theme', () => {
    const css = read('palette.css');
    // checkout/checkout-code follow the OS (class="scheme-auto", no script); landing/privacy resolve the
    // theme themselves and set data-theme-mode pre-paint. One block, both hooks.
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('html.scheme-auto');
    expect(css).toContain('html[data-theme-mode="light"]');
    expect(css).toContain('html[data-theme-mode="dark"], html.dark');
  });
});

describe('every served page consumes it — and defines no palette of its own', () => {
  test.each(PAGES)('%s carries the {{PALETTE}} token exactly once', (page) => {
    const html = read(page);
    expect(html.split('{{PALETTE}}').length - 1).toBe(1);
  });

  test.each(PAGES)('%s declares which theme mechanism it uses, and only one', (page) => {
    const html = read(page);
    const auto = html.includes('class="scheme-auto"');
    const own = html.includes("localStorage.getItem('dpay-theme')");
    expect(auto !== own).toBe(true); // exactly one: OS-following, or self-resolving
  });

  test.each(PAGES)('%s re-types NO palette colour as a literal', (page) => {
    // The whole failure. Every hex in `Palette` — including the retired v4 values a page might
    // still be carrying — must be absent from the page body. The two `<meta name="theme-color">`
    // lines are the documented exception (a meta attribute cannot hold a CSS var) and are checked
    // for equality below instead.
    const html = read(page).replace(/<meta name="theme-color"[^>]*>/g, '');
    const RETIRED = [
      // v4 (the original tangerine family)
      '#FF5A1F', '#D8450D', '#FF7A45', '#E0480F', '#676257', '#A6A093', '#0E9F6E', '#1E7F4F',
      // v5 "Traveler Paper" (retired 2026-09-26 by Ballast)
      '#F4F1E8', '#FDFCF9', '#F8F6F0', '#1B1A17', '#524D41', '#6D675B', '#D03F00', '#B93700',
      '#912900', '#C32335', '#9B5400', '#1B7351', '#E5DFD1', '#EDE8DC', '#141210', '#1D1A16',
      '#24211C', '#2A2620', '#F2EEE6', '#BEB6A9', '#9A9386', '#FF6F41', '#30B180', '#F77476',
      '#E9A23B', '#3B362D', '#34302A',
    ];
    const live = (Object.values(LIGHT) as unknown[]).concat(Object.values(DARK) as unknown[])
      .filter((v): v is string => typeof v === 'string' && v.startsWith('#'));
    for (const hex of new Set([...live, ...RETIRED])) {
      expect(html.toUpperCase()).not.toContain(hex.toUpperCase());
    }
  });

  test.each(PAGES)('%s states the page colour the palette states, in both themes', (page) => {
    // The one place a CSS var cannot reach: the browser chrome colour. So it is asserted instead.
    const html = read(page);
    expect(html).toContain(`<meta name="theme-color" content="${LIGHT.bg}" />`);
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${DARK.bg}" />`);
  });

  test.each(PAGES)('%s references only tokens the palette actually emits', (page) => {
    // A `var(--typo)` resolves to nothing and paints an inherited colour — an invisible bug on a
    // page with no visual baseline, and exactly what privacy.html shipped (`var(--sub)` against a
    // vocabulary that never defined it). Anything not in the palette must be declared by the page.
    const html = read(page);
    // Read the emitted names off the ARTIFACT, not off `Palette`'s keys: the block also carries the
    // theme-invariant mark and fixed-ink tokens, which are not palette fields.
    const emitted = new Set(read('palette.css').match(/--[A-Za-z0-9]+(?=:)/g) ?? []);
    const declaredLocally = new Set([...html.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map(m => m[1]));
    const used = new Set([...html.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map(m => m[1]));
    const undefinedRefs = [...used].filter(v => !emitted.has(v) && !declaredLocally.has(v));
    expect(undefinedRefs).toEqual([]);
  });
});
