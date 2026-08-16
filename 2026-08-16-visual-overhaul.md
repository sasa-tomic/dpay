# 2026-08-16 — Radical visual overhaul (app + website)

> **STATUS: COMPLETE (2026-08-17).** All phases P0–P8 done. Commits: `e3b6bd2` (P0 icons +
> AssetGlyph + palette tokens), `aa3b0c6` (P1+P2 chrome + asset surfaces), `0dea358` (P3+P4 ghost
> buttons, SVG marks, ledger/settings/onboarding), `8f5dd40` (P5 dead-style sweep), `f119bda`
> (P5 flow-24 contract fix + baselines reseeded), `17b3bee` (P7 landing shots + staging tool),
> `451384e` (P8 IMPORTANT-8 audit cleanup: dead icons/tokens/styles removed, last glyph converted).
> Gates: `just verify` full GREEN (e2e 78/78), jest 834/834, `just app` + `just ondevice` +
> `just campreview` all PASS. Palette soft-wash tokens were removed again (YAGNI — per-surface
> alphas vary); final icon count 17 (all consumed). Landing palette was already in sync.

Session focus (founder): "Radically improve the visual appearance of the app and the website. Everything FULLY overhauled: icons, color themes, layout, UX. Do NOT limit yourself to the current looks (stop-gap)."

## Evidence base

zai-vision audit of the 5 committed visual baselines (wallet-pay, balances, receive-request) found:
1. **Text-glyph icons** — '⚙' header, '✓' checks, '✕' close, '+' faucet, 'ⓘ' info, '•' dot markers → amateurish.
2. **Harsh flat contrast** — near-black + neon accent everywhere → dated crypto-app look; accent overuse dilutes hierarchy.
3. **Text links as primary actions** — "Share request link" etc. → weak affordance, inconsistent with pill buttons.
4. **Sparse flat layout** — no surface elevation, rows too tall, no asset visual identity (monograms).
5. **Generic system-font sameness** — no size/weight/spacing rhythm.

Strengths to keep: two-scan IA, unified asset selection, focus rings/hotkeys, white QR card (scannability), Wordmark/Logo (already SVG).

## Design language — "layered calm fintech"

- **Depth via surfaces**: bg → panel → card/elevated layers (subtle steps), not flat black + borders everywhere.
- **Accent discipline**: mint brand reserved for primary CTA, active state, and success. Everything else neutral.
- **Real iconography**: one icon set, lucide-style, 24-grid, stroke 2, round caps — react-native-svg (ALREADY a dep; zero new native modules).
- **Asset monograms**: per-family colored chip + symbol glyph ($, ₿, Ξ, ◎, ∂) in every asset row.
- **Affordance rule**: every action = a button (primary / secondary / ghost tier). No bare colored text-links.
- **Rhythm**: 4-grid spacing; radius scale 12/16/20; amount column right-aligned monospace.

## Locked decisions

- NO new native deps (react-native-svg already present). NO custom font bundling this session (system stack + weight/size hierarchy instead; optional follow-up).
- palette.ts values evolve in place; landing.html CSS vars synced to the SAME values (drift risk documented).
- styles.ts stays ONE StyleSheet.create block; new keys added by P0, dead keys swept in P5.
- testIDs + asserted textContent are CONTRACT — subagents must not rename them. Glyph-only Text nodes ('✓','+','✕','⚙') may be replaced by icon components ONLY after auditing e2e/jest matches (e2e tests 02,06,08,32,36,37,40,41,42,43,47,49,52,54,57,58,60,72 + 6 jest files reference glyph-adjacent text).
- Visual baselines WILL be reseeded (`just e2e-visual-seed`) + committed at P5.

## Phases (each = one commit)

- **P0 Design core (direct)**: this plan + palette v2 + `app/components/icons.tsx` (~24 icons, exact geometry authored) + `AssetGlyph` monogram component + styles.ts additions. Jest smoke test renders every icon.
- **P1 Chrome**: header (gear icon button, balance card w/ chevron affordance), tabs w/ icons + active-rail chip, back-hint.
- **P2 Asset surfaces**: CurrencyRow monogram redesign, BalancesSheet (handle + close icon + faucet ghost button), AssetPicker parity.
- **P3 Pay/Receive**: ghost-button tier for all action links, SVG success/fail marks, QR card polish. (PayMode, ReceiveMode, SolPayMode, SolReceiveMode, NfcTapView, Deposit/Withdraw sheets.)
- **P4 Remaining**: Ledger, SettingsSheet, Onboarding (mnemonic chips → styles.ts, checkbox icon), FundFirstPanel, SolanaAtaSetupCard.
- **P5 Gates + tests**: jest updates, full `just verify`, dead-style sweep, reseed + commit baselines.
- **P6 Device gates**: `just app` (assert both self-checks), `just campreview` (scan layout touched).
- **P7 Website**: refresh relay /shots/*.png from the new app UI + landing palette sync + minor polish.
- **P8 Docs + audit**: CODEBASE_ANALYSIS.md, FLOWS.md, OPEN_ISSUES.md, IMPORTANT-8 commit audit.

## Subagent strategy

P1–P4: orchestrator-implementer subagents, one per phase, with the exact spec from P0 (styles/keys/icon names/testID contract). P5–P6 gates run in-session (single commands). P7 partly subagent (landing) after shots captured. Fresh subagent on failure.
