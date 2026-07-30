# 2026-07-30 — Fix all issues + radical e2e harness + UX optimization

> Master plan for this session. Status legend: ⬜ todo · 🟡 in progress · ✅ done.
> The previous session (2026-07-29-ck-topup-seamless-e2e.md) is COMPLETE (e2e 16/16, core 36/36,
> relay 38/38). This session starts from a fully-green baseline.

---

## 0. Baseline (verified this session)

- `just test-core` → 36/36 GREEN
- `just test-relay --features test-helpers` → 38/38 GREEN
- `just e2e` → 16/16 GREEN in **22.89s** (target: seconds; slipped past the 12s ideal)
- Previous plan (ck top-up + radical e2e harness + prod verification) is DONE.
- App is a single `app/App.tsx` (1706 lines) — React Native + react-native-web; the Web UI IS the
  desktop/web surface. **No TUI exists and none is planned** (a TUI makes no product sense for a
  tap-to-pay mobile wallet). Per the user's "(alternatively: desktop)" clause, the **Web UI is the
  target surface** for the radical e2e harness. Flagged to the user as a decision.

## 0.1 Issues found so far (seed; authoritative copy in OPEN_ISSUES.md)

### Visual / UX (from real-app screenshot review via zai-vision)
- **UX-V1** The **"＋ Add money" button is TRUNCATED** ("+ Add mo") in the balance header — overflow.
- **UX-V2** A **"ledger" bar with a localhost URL sits on the MAIN screen** — developer-facing config
  (`settings-relay` TextInput + raw URL) exposed to end users. Belongs behind a Settings screen.
- **UX-V3** **"reset" (wipe identity) is a bare red text link on the main screen** — no confirmation,
  one tap destroys the wallet. Dangerous; must be in Settings with a confirm dialog.
- **UX-V4** Header is **crowded**: balance + `+$50` faucet pill + `Add money` button all compete.
- **UX-V5** Only **Escape** is a keyboard shortcut. The plan deferred T=topup / R=request / etc.
- **UX-S1** e2e suite is **22.9s** (target seconds). Per-flow waits are dominated by the app's 2.5s
  balance poll + 5s history poll; tests `waitForText` bounded by those intervals.

### Harness gaps (to confirm via deep-dive subagent)
- Missing flow coverage: withdraw error paths (below-min / insufficient / wrong-sig / double), the
  full two-wallet NFC round trip incl. receipt, history rendering, low-balance warning, username
  default, Cancel flows, full keyboard-shortcut matrix.

## 1. Goals / non-goals

**Goals**
- G1. **Fix ALL functional + visual issues** (pre-existing + newly found), TDD where possible.
- G2. **Radical e2e harness**: faster (seconds), covers EVERY supported user flow, no
  false-confidence mocks (mock only the smallest I/O boundary), real-app-driven.
- G3. **UX optimization**: fewest clicks/steps for common ops; intuitive keyboard shortcuts for the
  Web UI, clearly indicated; remove all AI-slop/stubs/dev-facing chrome from end-user surfaces.
- G4. **Persist every open issue** in OPEN_ISSUES.md; keep CODEBASE_ANALYSIS.md + AGENTS.md current.

**Non-goals**
- iOS, NFC radio hop on physical devices, real camera, real BTC, mainnet governance hand-off (all
  documented external/fidelity gates in OPEN_ISSUES.md).

## 2. Wave breakdown (subagent-orchestrated)

### Wave R — Reviews (parallel; fresh-context subagents)
- **R-ux**: no-mock UX review — drive the REAL web app (relay ↔ real canister via PocketIC, AgentLedger)
  with chrome-cli as a new then returning user through EVERY flow; screenshot each state; analyze with
  zai-vision; report ALL functional + visual issues with severity. MUST NOT use FakeLedger for the
  functional review (the global rule). Output: a structured issue list appended to OPEN_ISSUES.md.
- **R-harness**: read every e2e test + the harness; report (a) missing flows, (b) speed bottlenecks
  with concrete fixes, (c) any false-confidence assertions, (d) opportunities to fold tests together.
  Output: a findings doc.

### Wave F — Fixes (after R; parallel by family; TDD)
- **F-ux**: the end-user chrome cleanup — move ledger URL + reset into a real Settings screen with a
  confirm dialog; fix the truncated Add-money button; declutter the header; remove dev-facing surfaces.
- **F-kbd**: intuitive keyboard-shortcut surface (T top-up, A add-money, R request, Esc close, etc.)
  with on-UI hints; codify in an e2e test.
- **F-func**: any functional bugs R-ux surfaces (TDD: RED → GREEN).

### Wave E — Radical e2e harness (after R-harness + F; parallel)
- **E-speed**: drive the suite under seconds — e.g. a test-only "fast poll" seam so tests aren't
  bounded by the 2.5s/5s production poll intervals (the PROD app keeps its intervals; only tests
  shorten them via a guarded hook). Single source of truth for the poll constants.
- **E-coverage**: add every missing flow (withdraw errors, NFC receipt round trip, history, etc.).
- **E-dry**: fold shared setup; one catalog of flows that's trivial to list + extend.

### Wave V — Verify + Docs (final)
- Run `just verify` + `just e2e`; independent verifier subagent confirms clean architecture, no
  dead code, single sources of truth, rules followed. Update OPEN_ISSUES / CODEBASE_ANALYSIS / AGENTS.

## 3. Dev-loop + correctness rules (enforced)
- Every I/O has a timeout; no silent errors (match/try-catch logs status + body + context).
- Constants single-sourced; no backward-compat / dead code / unwired code.
- TDD: RED test reproducing the issue → GREEN → test stays.
- e2e mocks ONLY at the smallest I/O boundary (FakeLedger = canister; camera scan inject; NFC seam).
- New component supersedes old: unwire + remove the old, wire in the new, update docs.

## R-harness findings

> From the R-harness deep-dive (analysis only; no code changed). Full report delivered in chat.
> Baseline measured this session: **16/16 GREEN in 23.57s** (concurrency 6). Per-test timings captured.

### Headline numbers (speed)
| test | time | | test | time |
|---|---|---|---|---|
| 00-cross-val | 0.11s | | 08-merchant-settle | 5.42s |
| 01-onboard | 12.22s | | 09-double-spend | 5.92s |
| 02-faucet | 12.42s | | 10-expired | 3.97s |
| 03-deposit-address | 12.53s | | 11-nfc | 3.73s |
| 04-deposit-copy | 12.66s | | 12-settings | 2.95s |
| 05-deposit-credited | 14.74s | | 13-offline | 4.30s |
| 06-request-qr | 12.67s | | 14-keyboard | 3.84s |
| 07-scan-pay | 6.36s | | 15-withdraw | 5.83s |

The **first parallel batch (01–06) all take ~12s each** because they wait on
`waitForText('$100.00', {timeoutMs:12_000})` bounded by the app's 2.5s balance poll under 6-way CPU
contention. Tests that don't block on a production poll (11/12/14) finish in ~3s. **Root cause of the
23s: the suite is paced by the production poll intervals, not by work.**

### Coverage gaps (count: 27 untested behaviors)
Highest-value (P0/P1): withdraw error paths (below-min/insufficient/wrong-sig/double), the full NFC
round trip (only `phase` events today — no request→sign→wire→receipt→confirmed), the offline QR
hand-off (`btn-paid`/`btn-notpaid`/pending UI), `review-lowbal`, online "Not enough balance", the
"Payer offline? Scan their QR" receive path, and the deposit unreachable/error state.

### Top fixes (drive Wave E)
1. **E-speed (P0):** one test-only "fast-poll" seam — hoist App.tsx's 5 inline poll literals
   (2500/5000/10000/2500/1500) to module consts reading a guarded `globalThis.__DPAY_TEST_POLL`
   with prod defaults. Harness sets it via `evaluateOnNewDocument` (before bundle). RN has no window
   → prod untouched. Should take the suite to single-digit seconds.
2. **E-coverage (P1):** add ~8 flows for the gaps above (withdraw-errors, NFC receipt round trip,
   offline-QR-handoff, lowbal, insufficient, receive-scan-payer, deposit-error, username-default).
3. **E-dry (P2):** fold the 15×-copy-pasted onboarding preamble (type/create/wait-$100) into one
   `lib.onboardWallet(driver)` helper; single-source `ONBOARD_PLACEHOLDER` + `DEPOSIT_CURRENCY`.
4. **Byte-exactness nit (P2):** `00-cross-val` pins wire + withdraw sigs byte-exact, but the
   108-byte **receipt claim** (`buildReceiptClaimBytes`/`verifyReceiptSig`) has NO golden in
   `wire_layout.json` — its byte-exactness vs Rust is only transitively tested, not pinned.

### Quality nits (P3)
- `13-offline` uses port 1 (`ERR_UNSAFE_PORT`) but its comment claims `ECONNREFUSED`.
- `camera.ts` `useCodeScanner` leaks listeners (admitted; cleanup is best-effort microtask).
- `09-double-spend` monkey-patches global `window.fetch` (broader than the seam rule; honest + scoped).
- `relayUrl` is component state only (never persisted) — "relay persistence" is a missing app feature.
