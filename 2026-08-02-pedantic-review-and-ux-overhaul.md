# 2026-08-02 — Pedantic review (MC1–MC8) + UX/e2e overhaul

> Continuation of `2026-08-02-progress-and-review-request.md`. The previous session shipped MC1–MC8
> autonomously and explicitly requested a **pedantic fresh-context review** before any new work.
> This plan covers: (1) that review, (2) the broader m0001 mandate (find/fix all issues, radical
> e2e harness, no-mock UX review, tech-debt reduction, alignment verification).

## Hard constraints (from CLAUDE.md / AGENTS.md / m0001)

- Non-custodial / no-swap / no-exchange-creds — restructure, don't accept violations.
- Inner loop fully offline via `just`, seconds. Baseline: `just verify` 35/35 in ~29s (over the 22s
  target — flag).
- Wire format FROZEN: `WIRE_LEN=292`, `SIGNING_LEN=196`, `REQUEST_LEN=132`. Do not change wire bytes.
- TDD RED-first; commit each unit; ship only ≥6/10 confidence; never commit founder WIP.
- No mocks in prod code; mocks in tests only at the smallest I/O boundary.
- Update `CODEBASE_ANALYSIS.md` + `OPEN_ISSUES.md` alongside any code change (living docs).

## Phase 1 — Pedantic fresh-context review (the explicit hand-off request)

Orchestrate **6 parallel fresh-context subagents**, one per review target. Each subagent reads its
cited code, confirms the invariant actually holds, hunts for subtle bugs / security holes / tech
debt, and returns a concrete findings list (file:line, severity, fix-or-file). Subagents do NOT fix —
they review only (preserve my context for triage). Each subagent may spawn review sub-subagents if
the surface is large.

| # | Target | Risk class | Key files |
|---|--------|-----------|-----------|
| R1 | **MC4 receipt trust + durable reconciliation** | security-critical | `app/services/receipt.ts`, `crates/dpay-canister/src/icrc_settle.rs` (`pay`, `reconcile`), `crates/dpay-relay/src/relay.rs` (`/receipt/:nonce`, `/pay` Transient fallback), `e2e/tests/30-trusted-receipt.mjs` |
| R2 | **MC2 currency identity + policy** | money-safety | `crates/dpay-canister/src/lib.rs` (`register_currency`, `retire_currency`, `pay` cap gate), `crates/dpay-canister/src/store.rs` |
| R3 | **MC1 exact-amount transport** | money-safety | `crates/dpay-core/src/amount.rs` (`parse_decimal_to_units`), `app/lib/amount.ts`, `app/lib/types.ts`, Kotlin `@ReactMethod` signatures, `crates/dpay-relay/src/relay.rs` JSON |
| R4 | **MC8 U6 WalletConnect isolation** | isolation / non-custodial | `app/walletconnect.ts`, `app/shims/reown-appkit-core.js`, `app/wallet.ts`, `e2e/vite.config.js`, `app/jest.config.js`, `app/__tests__/walletconnect-conformance.test.ts` |
| R5 | **MC3 balance freshness** | display correctness | `crates/dpay-canister/src/icrc_settle.rs` (`refresh_balance`, `refresh_deposit`), `crates/dpay-relay/src/agent_ledger.rs` (TTL) |
| R6 | **Bridge-parity guards + general hunt** | regression prevention | `scripts/bridge-parity.mjs`, `justfile` (`check`/`verify`), `app/android/.../DpayCoreModule.kt`, `app/android/.../DpayNfcModule.kt`, `app/lib/types.ts` |

General hunt (all subagents): silent errors (catches that swallow without err code + state), missing
I/O timeouts, non-idempotent ops, dead code, duplicated truth, `as unknown as` / `!` / `any` that
bypasses type safety, magic numbers that should be symbolic.

## Phase 1 — Triage

Consolidate findings → decision matrix:
- Small + ≥6/10 confidence + tests stay green → **fix directly** (TDD RED-first), commit each unit.
- Big or fork needing human → **file in OPEN_ISSUES.md** with severity + next step + mitigation.
- Update `CODEBASE_ANALYSIS.md` risk list (strike resolved, add new).

## Phase 2 — Catalog ALL new issues (code/functional/visual)

Structure scan (orphan files at `app/` root: `payments.ts`, `wallet.ts`, `cketh.ts`,
`walletconnect.ts` — verify they're wired, not zombie chrome; `dashboard.html` at repo root —
verify it's not slop). Cross-check `OPEN_ISSUES.md` "Coverage gaps" + `FLOWS.md`. Record findings.

## Phase 3 — Radical e2e harness improvements

`just e2e` is ~29s for 35 flows (~0.8s/flow). Target: **<15s total**, full coverage. Levers:
- Faster browser/page setup (share contexts where safe; parallelize non-conflicting flows).
- Fold setup/teardown (onboard once where state doesn't leak; the harness already does one relay).
- Coverage gaps from `FLOWS.md`: true multi-currency Ledger row units; ckUSDC ReceiveMode round
  trip; 2/6/8/18-decimal amount matrix; Android bridge `NativeModules` surface (out of e2e scope —
  device gate). Add RED tests for the in-scope gaps.
- Organize flows so `FLOWS.md` table is auto-derivable from the test dir (single source of truth).

## Phase 4 — No-mock UX review (web = react-native-web)

Drive the REAL app via chrome-cli (web build) against the REAL relay (FakeLedger — the sanctioned
offline boundary; canister logic is the same Rust core). New + returning user perspectives.
Keyboard shortcuts (P/R/T/A/Esc) — verify intuitiveness + visibility. Hunt AI slop / stubs /
spinners that don't resolve in seconds. Capture screenshots → `zai-vision` for analysis (not
committed). File findings; fix high-confidence; adjust e2e flows for optimized UX.

## Phase 5 — Tech debt reduction

DRY/KISS/YAGNI. Single source of truth for constants. No silent errors (match-style with err code +
state). I/O timeouts everywhere. Idempotent ops. Heuristics → robust techniques. File splits for
>2k-line files (⚠️ `lib.rs` canister stable-memory layout is sensitive — founder nod before split).
Anti-patterns: invalid-data-then-detect; disconnected scripts (consolidate into one `scripts/ops`
with guided subcommands).

## Phase 6 — Persist + report

Update `OPEN_ISSUES.md` (close resolved, add new with severity/next step). Update `AGENTS.md` +
`CODEBASE_ANALYSIS.md` to reflect new state. Session-end report: blockers (or None) + recommended
forks for human input.

## Confidence + safety

Every change rated: confidence (1–10) it's correct per the rules, confidence (1–10) it's safe. Only
ship ≥6/10. Postpone forks needing human guidance; present with pros/cons at session end.
