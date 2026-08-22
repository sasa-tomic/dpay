# 2026-07-31 — Finish prior session, full-issue sweep, App.tsx split, radical e2e + UX

> Master plan. Status: ⬜ todo · 🟡 in progress · ✅ done.
> Continues `2026-07-30-ux-e2e-radical.md` (whose Wave E-speed + F-partial shipped; coverage/kbd/golden/nits did NOT).
> Baseline this session: `just check` green; `just e2e` = **17/17 GREEN in 9.84s** (fast-poll seam works; the
> earlier 16s was transient CPU contention). HEAD `ebb3245`, tree clean.

## 0. Rules (enforced on every change)
- TDD: RED test reproducing the issue → GREEN → test stays. No silent errors (match/Result + log body+code+ctx).
- Constants single-sourced. No backward-compat / dead code / unwired code. New component supersedes old → unwire+remove old, wire new, update docs.
- e2e mocks ONLY at the smallest I/O boundary (FakeLedger = canister; camera scan inject; NFC seam). UX review NEVER uses mocks — drive the REAL app.
- Every I/O has a timeout. Files >2k lines split into logical units. Living docs (OPEN_ISSUES / CODEBASE_ANALYSIS / AGENTS) updated in the same change that resolves/adds a risk.
- Commit each unit. `just verify` (or the relevant slice) must stay green.

## 1. Goals
- **G1** Finish ALL prior-session unfinished work first (per user instruction): Wave E-coverage, Wave F-kbd, P2 receipt-claim golden, P3 quality nits, TASKS.md cleanup.
- **G2** Sweep + fix ALL functional/visual issues (documented first, then newly found), TDD.
- **G3** Split `app/App.tsx` (2281L) into logical modules (clean architecture, single source of truth).
- **G4** Radical e2e harness: covers EVERY supported user flow; a flows manifest (easy to list/extend); real-app-driven; seconds-fast; migrate all UI/UX verification into it.
- **G5** UX: fewest clicks/steps for common ops; intuitive, clearly-indicated keyboard shortcuts; remove all AI-slop/stubs/dev chrome from end-user surfaces.
- **G6** Persist every open issue in OPEN_ISSUES.md; keep CODEBASE_ANALYSIS.md + AGENTS.md current.

## Non-goals
- iOS, physical NFC radio hop, real camera, real BTC/ETH money, mainnet governance hand-off, O3/O4 ckERC20 offramp, N6 username-in-payload (core wire change) — all external/decision-blocked, documented.

---

## Phase 1 — Finish prior session (HIGHEST PRIORITY; well-defined; TDD)
Subagent-owned, parallel by family. Each writes a RED test first, then fixes.

### 1a. P3 quality nits (quick, high confidence)
- **1a-i `13-offline` wrong-reason**: it points at port 1 → `ERR_UNSAFE_PORT`; comment claims `ECONNREFUSED`. Use a guaranteed-refused port (e.g. a port the harness binds-then-closes, or a high unassigned port that yields `ECONNREFUSED`). Assert the real failure mode. *(file: e2e/tests/13-offline.mjs)*
- **1a-ii `camera.ts` listener leak**: `useCodeScanner` registers listeners without full cleanup. Return a proper disposer / use the effect-cleanup to remove listeners. *(file: e2e/web/camera.ts)*
- **1a-iii `09-double-spend` broad fetch patch**: it monkey-patches `window.fetch` globally. Narrow to the sanctioned seam (relay fetch only) — route the relay base URL through one fetch wrapper the test can intercept, instead of global `window.fetch`. *(files: app/App.tsx fetch seam + e2e/tests/09-double-spend.mjs)*
- **1a-iv `relayUrl` not persisted**: relay URL is component state only. Persist to AsyncStorage (single key, single source of truth) with the existing `settings-relay` input. *(file: app/App.tsx)*

### 1b. Wave F-kbd — full keyboard shortcuts (UX-V5)
- Single-key shortcuts on Web UI: `T` top-up (faucet), `A` add-money (open asset picker), `R` request (receive tab + focus amount), digits type into the focused amount, `Esc` close sheet (already). Enter submits the active form.
- On-UI hints: show the key hints inline on each affordance (small kbd badge), or a compact hint bar that appears when the user presses a key / focuses. Clearly indicated, not noisy.
- Hook into the existing `useEscapeToClose` seam → generalize to a `useHotkeys` hook (single source of truth). RN-safe (no-op off-web, or guarded).
- **e2e test** (extend `14-keyboard.mjs`): drive T/A/R/Enter/Esc end-to-end on the REAL app.

### 1c. P2 receipt-claim golden
- Add a `receipt` golden to `dfx/wire_layout.json` via the wire-layout emitter (`just wire-layout` path in `dpay-fixture`/core), pinning `buildReceiptClaimBytes`/`verifyReceiptSig` 108-byte claim byte-exact vs Rust. Extend `00-cross-val.mjs` to assert it. *(core: emit fn; fixture: add vector; e2e: assert)*

### 1d. Wave E-coverage — ~8 NEW e2e flows (real-app-driven)
New files under `e2e/tests/`. Each is a REAL user flow, FakeLedger at the canister boundary only:
1. `17-withdraw-errors.mjs` — below-min (under 50_000 sats), over-balance, wrong-sig rejection, double-withdraw (nonce replay). Assert the UI error text per case.
2. `18-nfc-roundtrip.mjs` — full two-device NFC: request→arm→tap→sign→wire→receipt→both confirm "Paid ✓"/"Received ✓" (drive the NFC seam for both roles).
3. `19-offline-handoff.mjs` — payer offline path: merchant shows QR, payer pays offline, `btn-paid`/`btn-notpaid` + pending UI; then reconcile.
4. `20-pay-lowbal.mjs` — `review-lowbal` warning + online "Not enough balance" gate.
5. `21-receive-scan-payer.mjs` — merchant scans a signed payer QR ("Payer offline? Scan their QR") and settles.
6. `22-deposit-error.mjs` — deposit unreachable/error state (relay returns 503 / no-minter) → correct UI message (not the misleading "check relay" text).
7. `23-username-default.mjs` — onboarding empty-name handling + default identity.
8. `24-history.mjs` — history rendering: faucet mint row labeled ("Demo funds", not hex sentinel), pay/receive rows, ordering.

### 1e. TASKS.md cleanup
- Strike the stale "Decouple DEPOSIT_CURRENCY=1" item (closed by M0). Keep genuinely-open items (multi-currency merchant picker = issue #6).

**Phase 1 exit:** `just verify` green; OPEN_ISSUES updated (mark Wave E/F + P2/P3 done).

---

## Phase 2 — No-mock UX + functional audit (find NEW issues)
- **R-ux** subagent: drive the REAL web app via chrome-cli as (a) new user, (b) returning user through EVERY flow; screenshot each state; analyze with zai-vision. Report ALL functional + visual issues w/ severity + repro. NO MOCKS for canister-dependent behaviors (use AgentLedger ↔ real canister on PocketIC for faucet-cooldown-style paths; FakeLedger web server for pure-visual/layout). Output → append to OPEN_ISSUES.md as N11+.
- **R-harness** subagent: re-audit the (now-expanded) harness for false-confidence assertions, missing edge cases, opportunities to fold. Output → findings.
- Decide App.tsx split target structure here (planner subagent): propose module boundaries, dependency direction, no circular deps.

## Phase 3 — Split `app/App.tsx` (2281L → logical modules)
Target (single source of truth, one execution path each):
- `app/lib/` — pure helpers (fmt, parseRequestQR, toSats, currency math), no React.
- `app/config/` — palette `C`, catalog types/defaults, poll/timeout consts, storage keys.
- `app/hooks/` — useBalancePoll, useHistoryPoll, useEscapeToClose→useHotkeys, useClipboard, useDeepLink, usePersistedRelay, useCatalog.
- `app/services/` — relay clients (deposit/withdraw/onramp/faucet/pay) behind ONE fetch wrapper (the seam tests intercept).
- `app/components/` — Logo, Onboarding, Wallet shell, Tab, NfcPill, QrScanner, NfcTap, PayMode, ReceiveMode, DepositSheet, WithdrawSheet, CkErc20DepositSheet, SettingsSheet, AssetPickerSheet.
- `app/styles.ts` — the `S` palette/sheet styles.
- `app/App.tsx` — thin root: load identity, route Onboarding|Wallet.
- Hard rule: NO behavior change. The expanded e2e suite (Phase 1) is the safety net — it must stay 100% green byte-for-byte. Wire-layout/cross-val must stay byte-identical.

## Phase 4 — TDD-fix ALL issues (documented + newly found)
- Fix each N11+ (new) and any still-open documented item, RED→GREEN, smallest-scope:
  - **N1 reconcile FakeLedger faucet** with canister semantics (fixed amount + rate-limit) so e2e catches the cooldown bug; surface retry time in UI.
  - **Issue #6 multi-currency merchant request picker** (the request QR carries currency; add the picker to Receive).
  - All R-ux findings, ranked by severity.
- Commit per issue; update OPEN_ISSUES + CODEBASE_ANALYSIS in the same change.

## Phase 5 — Radical harness hardening
- `e2e/FLOWS.md`: a single catalog listing every tested flow + how to add one (the user's explicit ask).
- Remove false-confidence: assert REAL outcomes (signed bytes, ledger state, UI text) — never a stub returning OK.
- Ensure suite stays <12s with the added flows (fold shared onboarding; one shared session).
- Optional: parameterize a few flows (amount/currency) to multiply coverage cheaply.

## Phase 6 — Docs + final verify
- Update OPEN_ISSUES.md (close done; add any new external blockers w/ options), CODEBASE_ANALYSIS.md (App.tsx split, new surfaces/risks), AGENTS.md (link the flows manifest + open-issues pointer), CLAUDE.md build state.
- Independent verifier subagent: confirms clean architecture, single source of truth, no dead/unwired code, rules followed, no silent errors.
- `just verify` green end-to-end. Report blockers (or None).

---

## Subagent orchestration
- Phase 1: 3 parallel implementer subagents (1a nits · 1b kbd · 1c golden) then 1d coverage (can fan out), each TDD + `just e2e` slice green. Wrap in `timeout`.
- Phase 2: 2 review subagents (R-ux no-mock · R-harness) + 1 planner (split structure).
- Phase 3: 1 implementer (split) behind the expanded e2e net; verifier after.
- Phase 4: fan out per-issue implementers.
- Phase 5/6: 1 each + final verifier.
- Prefer fresh low-cost subagents for mechanical work; reserve strong model for the split + architecture review.
