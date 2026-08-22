# 2026-08-17 — COMPLETE redesign: everything, ignore the old design

> STATUS: COMPLETE (2026-08-17). Commit chain: 56c66a9 (R0+R1 identity + Android brand) →
> 1c557f3 (R2+R3 component sweep) → aa63214 (R4 landing) → e913c87 + d59454a (R4 relay-test pins)
> → d47c74f (R5 shots + baselines) → 9114f10 (campreview hardening) → R6 audit fixes (privacy
> page migration + dead plex_mono_600 removal). All gates GREEN: just verify full (e2e 78/78),
> jest 834/834, tsc clean, just app + just ondevice + just campreview PASS (fresh dpay_api36
> emulator). IMPORTANT-8 audit clean after fixes.

> Founder directive (verbatim): "I do want a COMPLETE redesign. EVERYTHING! Ignore fully the
> existing design." The 2026-08-16 pass was too conservative — it kept the palette, logo, and
> layout skeleton. This session replaces the entire visual identity: palette, typography, logo,
> launcher icon, splash, every app surface, and the landing page.

## New design language — "Traveler Paper"

A LIGHT wallet. Rationale: the user is a traveler/tourist tapping/scan-paying outdoors in
sunlight; every competitor wallet is dark crypto-chic; warm porcelain + ink + tangerine reads
premium (editorial, Wise/Monzo-adjacent) and photographs beautifully on the landing page.

- **Palette v3 (single source `app/config/palette.ts`, mirrored in landing CSS vars):**
  - `bg #F5F3EC` warm porcelain; `panel #FCFBF7`; `card #FFFFFF` w/ `line #E8E3D7`, `line2 #EFEAE0`
  - `ink #1B1A17`; `sub #6B675C`; `sub2 #A29D90`
  - `brand #FF5A1F` vivid tangerine (primary CTA / active only); `brand2 #E0480F` pressed;
    `brandInk #FFFFFF`
  - `ok #0E9F6E` (success/online ONLY), `bad #E5484D`, `warn #B45309`
  - `field #FFFFFF` (inputs/cards on porcelain), shadows ink-tinted, never black glows
- **Typography**: Space Grotesk (500/600/700) bundled — app via `android res/font` (resource-only,
  NO new JS deps), web/landing via `@font-face` from relay assets. Numerals/amounts in Space
  Grotesk (signature look); system stack below as fallback.
- **Shape**: radius scale 14/18/24; cards on porcelain with hairline borders + soft ink-tinted
  shadows (elevation 2–6); NO neon glows; pills only for filters/chips, not every control.
- **Logo**: NEW mark (not the old `d` D_PATH) — a rounded-square tangerine tile with a porcelain
  glyph; new wordmark "dpay" set in Space Grotesk. Same mark drives: `Logo.tsx`, landing, favicon,
  Android adaptive launcher (fg/bg/monochrome vectors + rasterized PNGs), splash.
- **QR cards** stay WHITE with ink modules (scan contrast is not a style choice).

## In scope (EVERYTHING visual)

1. `app/config/palette.ts` v3 + `app/styles.ts` full value rewrite (keys may be renamed only with
   a consumer sweep; stays ONE StyleSheet.create).
2. Fonts: `app/android/app/src/main/res/font/*.ttf` + `react-native.config.js` untouched (res/font
   needs no config); e2e web `@font-face`; relay-served woff/ttf for landing.
3. `Logo.tsx` new mark + wordmark; `NfcIcon` recolored; `AssetGlyph` family colors retuned for
   light bg (tinted chips on white cards).
4. Every component surface re-skinned; layout rhythm improvements welcome; IA/testIDs frozen.
5. Android launcher: `ic_launcher_background/foreground/monochrome.xml` NEW vectors + regenerate
  legacy `mipmap-*/ic_launcher*.png` (rasterize via headless chrome from the SVG geometry);
  `splash.xml` new look. Manifest unchanged.
6. Landing `landing.html`: full redesign (keep `{{DOWNLOAD}}` placeholder, `/shots/*` refs,
  `/wallet` + privacy links, reduced-motion support). Keep copy substance, restyle everything.
7. Re-stage the 7 landing `shot-*.png` via `e2e/stage-landing-shots.mjs` after the app redesign.
8. Reseed visual baselines (`just e2e-visual-seed`) + commit.
9. Update tests that PIN design values (e.g. `icons.test.tsx` family colors) to the new tokens.

## Frozen contracts (NOT design — do not touch)

- All testIDs + e2e/jest-asserted textContent ('Paid ✓', 'Copied ✓', tab labels, etc.).
- Wire bytes, NFC AIDs, `WIRE_LEN`/`SIGNING_LEN`/`REQUEST_LEN`, manifest, gradle, applicationId.
- `styles.ts` = ONE StyleSheet.create; relative imports; only `App.tsx` imports `./relayConfig`.
- The 5-baseline pixel contract is reseeded at the END (post-redesign), not mid-flight.

## Phases (each = one commit)

- **R0 Design core (direct)**: palette v3 + fonts fetched/bundled (fallback: system stack if
  offline fetch fails) + new Logo geometry + `AssetGlyph` light-bg retune + `icons.tsx` default
  color + `styles.ts` token-level rewrite skeleton + jest pins updated. Verify: tsc + jest green.
- **R1 Android brand**: launcher vectors + PNG regen + splash (+ `just app`, `just ondevice` —
  `app/android/**` triggers the device gates).
- **R2 App chrome + screens A**: header/tabs/rail/BalancesSheet/AssetPicker/CurrencyRow/PayMode/
  ReceiveMode (+SOL twins) re-skinned to Paper.
- **R3 App screens B**: Ledger, SettingsSheet, Onboarding, FundFirstPanel, deposit/withdraw sheets,
  NfcTapView, QrScanner frame.
- **R4 Landing redesign** (fonts as relay assets, new sections' look, keep substance + template).
- **R5 Shots + baselines + full gates**: stage-landing-shots rerun, `just e2e-visual-seed`,
  `just verify` full, `just campreview` (scan layout touched).
- **R6 Docs + IMPORTANT-8**: CODEBASE_ANALYSIS/OPEN_ISSUES/plan status + independent commit audit.

## Subagent strategy

R2/R3/R4 = orchestrator-implementer subagents with the R0 spec (palette tokens, fonts, radius/
shadow rules, frozen-contract list). R0/R1 partly direct (asset generation). R5/R6 in-session.
Fresh subagent on failure. All work offline after the one-time font fetch.
