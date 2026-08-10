# 2026-08-10 Review Sweep

Context: git tree was clean at HEAD `af6ac8f` (prod-deployed). No in-progress work. Per review
instructions, fixing documented pre-existing issues first, then doing the review for new issues.

## Phase 1 — Documented pre-existing issues (autonomous)

- [x] **Doc drift fix (OPEN_ISSUES #6 + CODEBASE_ANALYSIS.md).** MC5 offline multi-currency +
      NFC asset disclosure + unknown-asset rejection were ALL DONE in code but still marked
      "partially resolved / open" in Issue #6 and CODEBASE_ANALYSIS.md line 102. Corrected to
      ✅ RESOLVED with proof pointers. (No code change — pure doc accuracy.)
- [ ] **D3 — Header "balance" label is generic (LOW).** Prefix with the active asset symbol so
      the label is not developer-facing. Simplify the redundant `activeSol ? 'balance' : ...`
      ternary (both online branches yield 'balance'). Visual baselines re-seeded for affected
      surfaces. Effort LOW. Value ~5.
- [ ] **Device gate.** M17+L6 touched `app/android/**`; APK predates those. Run `just app`
      (assert `DPAY_SELFCHECK PASS` + `DPAY_SOL_SELFCHECK PASS`) + `just ondevice`. Background.

## Phase 2 — Review for NEW issues (delegated to planner/implementer swarm)

Filled in by the planner subagent. Focus areas per the review instructions:
- IMPORTANT 8: recent commits (af6ac8f back ~22) scanned for partially-wired / unused code.
- Code quality: DRY/KISS/YAGNI, silent errors, single-source-of-truth, dead code.
- E2e harness: coverage gaps vs the 62 flows; flows that should exist but don't.
- UX: drive the real web app (chrome-cli + zai-vision); flows/visuals NOT covered by e2e.

## Phase 3 — Implementation of found issues

Each issue: value [1-10], effort [S/M/L]. LOW/MED done immediately; HIGH split into MED for next
session. TDD (RED then GREEN). Commit each unit.

## Blockers

None yet.
