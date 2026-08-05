# dpay — session report (2026-08-05): radical e2e + polish (visual regression, diagnostics, watch mode, coverage, de-god-component, UX audit)

> **Hand-off brief for the next session (fresh context).** This documents what an autonomous agent
> session shipped on 2026-08-05 (7 phases, 28 commits). Read alongside `CLAUDE.md`, `OPEN_ISSUES.md`
> (Session summary at top), `CODEBASE_ANALYSIS.md`, `2026-08-05-ux-audit.md` (the UX audit deliverable),
> `2026-08-05-radical-e2e-and-polish.md` (the plan), and `FLOWS.md`.

## 1. TL;DR

- **44/44 e2e GREEN** (was 39). Three new coverage flows (41 a11y census, 42 receipt-reject, 43
  decimal-edges) + the 2 real a11y bugs they surfaced (missing aria-labels) are FIXED.
- **Visual-regression harness closes the pixel-blind gap.** Flow 40 pixel-diffs the 5 primary
  surfaces vs committed baselines (`e2e/shots/baselines/`). The documented "styles.ts single-block
  class dropped = invisible to the testID+textContent net" blind spot is RESOLVED — and flow 40 is
  part of the suite, so `just verify` already runs it.
- **RED-path diagnostics.** A RED flow now dumps `e2e/shots/failures/<flow>-<ts>/` (timeline +
  console + error always land; screenshot/DOM best-effort). Wall-time +0.27s.
- **Watch mode — sub-5s dev loop.** `just e2e-watch` / `just e2e-watch-filter <token>` map a changed
  file to its journey and re-run only that subset with the shared session PERSISTING (vs ~23s cold).
- **Wallet.tsx de-god-componented: 475 → 319 lines (33% smaller).** Three data hooks extracted
  (`useCatalog`/`useBalancePoll`/`useTransactionHistory`); `fetchWithTimeout` is now the single source
  of truth for relay-fetch timeouts (11 inline AbortController sites consolidated).
- **composeTimeout caller-signal-wins bug fix** — a real latent bug: `withDefaultTimeout` armed a 10s
  backstop even when the caller supplied its own signal, silently capping `DEPOSIT_ADDRESS_TIMEOUT_MS=20s`
  at 10s. The backstop is now a safety-net for omitted-signal callers only; a caller that provides a
  signal OWNS its deadline. TDD-pinned.
- **Fresh-eyes UX audit + 6 copy fixes.** 14 real-app screenshots driven through the real FakeLedger
  relay, each analyzed via zai-vision → `2026-08-05-ux-audit.md` (10-item Quick Wins table). Applied 6
  (P0 + 3 P1 + 2 P2): camera-gate copy, deposit fee/min placeholders, empty Transactions state, Receive
  settle link, balance subtitles, onboarding CTA.
- **Gate state:** jest 257; typecheck clean; bridge-parity 21; `just e2e-visual` GREEN. **Wire untouched**
  (292/196/132). No canister/relay/core CODE changed — all 7 phases shipped under the existing kernel.

## 2. What shipped this session (by track, with commits)

### Phase 1 — Visual regression harness (commits `f1159e5`, `816b9fb`, `b8668f3`)
- **`f1159e5`** — pure pixel-diff comparator `e2e/harness/pixel.mjs` (pngjs; tolerance 0.5%; per-channel
  delta 3; a `masks` option to mask non-deterministic QR regions). No native deps; ~ms per diff.
- **`816b9fb`** — flow `40-visual-regression` re-captures the SAME 5 primary surfaces flow 35 tours
  (wallet-pay, receive-request, balances, settings, ledger) and diffs each vs its committed baseline PNG
  under `e2e/shots/baselines/`. Distinct capture filenames (`40-vr-<surface>`) so it never collides with
  flow 35. Closes the documented "testID+textContent net is pixel-blind" risk.
- **`b8668f3`** — `just e2e-visual` (re-runs flow 40 standalone for fast iteration) + `just e2e-visual-seed`
  (regenerates baselines after an intentional UI change — commit the new baselines, they ARE the contract).
  Flow 40 is part of the suite, so `just verify` already covers it; the standalone recipe avoids the
  banner + other flows.

### Phase 2 — RED-path diagnostics (commits `9290d55`, `e76241e`, `de8bc89`, `cb76128`)
- **`9290d55`** — `Driver` gains a per-action timeline; `dumpDiagnosticsFor(file,err)` writes a bundle.
- **`e76241e`** — wires the dump via `_testCtx` AsyncLocalStorage keyed by file + a `_drivers` Map; the
  runPool catch calls `dumpDiagnosticsFor` BEFORE recording the failure. Diagnostics never mask the RED error.
- **`de8bc89`** — keep the driver registered through the dump (the flow's `finally{env.stop()}` had
  already torn it down before the catch fired).
- **`cb76128`** — doc-comment alignment tidy.
- On a RED flow, `e2e/shots/failures/<flow>-<ts>/` gets: `actions.json` (timeline) + `console.log` +
  `error.txt` ALWAYS land; `screenshot.png` + `dom.html` best-effort (a real flow closes its page in
  `finally` first; always land for throwaway flows). Wall-time cost ~0.27s.

### Phase 3 — Watch mode (commits `ea97dcd`, `03d299b`, `0d36bba`)
- **`ea97dcd`** — `run.mjs` refactored: the runner + summary + verdict + slip-target logic move into
  `runTestsSubset(tests, opts)`; `main()` is the `just e2e` entry and is import-guarded so the watcher
  importing `run.mjs` does not side-effect the suite. Also exports `loadTests` + `withTimeout`.
- **`03d299b`** — `e2e/watch.mjs`: Node 24 `fs.watch({recursive:true})`, 300ms debounce, a static
  `FILE_JOURNEY` map (component → journey; shared-infra/unknown → ALL), `keepSession:true` so the shared
  relay+web+browser process PERSISTS across re-runs (sub-5s feedback vs ~23s cold start). SIGINT/SIGTERM
  teardown (0 leaked procs).
- **`0d36bba`** — `just e2e-watch` + `just e2e-watch-filter <token>` recipes.

### Phase 4 — Coverage flows 41-43 (commits `9880ad4`, `9618201`, `f21d5ce`, `de57c7f`)
- **`9880ad4`** — flow `41-a11y-census` (RED): every interactive element (50 across 7 surfaces) MUST
  carry a non-empty aria-label AND a role. Surfaces 2 real bugs.
- **`9618201`** — fix the 2 a11y bugs: `amount-input` (`ReceiveMode.tsx`) + `settings-relay`
  (`SettingsSheet.tsx`) both lacked aria-labels → RED → GREEN. (Census re-runs 0 missing.)
- **`f21d5ce`** — flow `42-receipt-reject`: a tampered receipt (wrong pubkey / flipped sig) is rejected
  by `verifyOutcomeReceipt` → honest "Couldn't verify the payment", no fake "Paid ✓", no debit. Complements
  flow 30 (which forges under a fresh key).
- **`de57c7f`** — flow `43-decimal-edges`: 8-dec (ckBTC) + 6-dec (ckUSDC) amounts render with EXACT
  decimals on the review screen (no rounding, no sci-notation, no trailing-zero drift). All-BigInt format
  path. 18-dec deferred (no 18-dec asset in the catalog).

### Phase 5 — Tech-debt: Wallet.tsx hook extraction + fetchWithTimeout (commits `371e1e4`, `d3239ba`, `2a36390`, `ba27ec3`, `210a7c6`)
- **`371e1e4`** — `app/services/relay.ts` gains `fetchWithTimeout` (the single source of truth for
  relay-fetch timeouts).
- **`d3239ba`** — consolidate 11 inline AbortController sites across 7 files to `fetchWithTimeout`.
- **`2a36390` / `ba27ec3` / `210a7c6`** — extract `useCatalog`, `useBalancePoll`, `useTransactionHistory`
  from the Wallet god-component. **Wallet.tsx: 475 → 319 lines (~33% reduction).** jest 254 → 257 (+3 TDD).

### Bonus — composeTimeout caller-signal-wins (commit `d5b992f`)
- A real latent bug found during Phase 5. `withDefaultTimeout(signal)` armed a 10s backstop EVEN WHEN the
  caller supplied its own signal — so "first abort wins" capped every caller at 10s, silently defeating
  `DEPOSIT_ADDRESS_TIMEOUT_MS=20s` in `DepositSheet` (ckBTC `deposit_address` is an IC update call,
  5-7s+ on mainnet under load). Fix: the backstop is a SAFETY-NET for omitted-signal callers only; a
  caller that provides a signal OWNS its deadline. TDD: new jest case RED under old code → GREEN after.

### Phase 6 — UX audit (read-only)
- 14 real-app screenshots captured by driving the REAL app through the REAL FakeLedger relay (chrome-cli),
  each analyzed via zai-vision (the opencode model has no native image view). Deliverable:
  `2026-08-05-ux-audit.md` (315 lines, 10-item Quick Wins table with file:line). Top findings:
  [P0] camera-gate jargon; [P1] Settings raw Relay URL footgun; [P1] deposit fee/min bare `—`;
  [P1] Receive "Scan to settle" unexplained; [P1] empty Transactions dead-end.

### Phase 6.5 — UX quick-win copy fixes (commits `1106e32`, `4f67b4c`, `35d3ea3`, `0d096c6`, `7467070`, `af475fc`, `f8da5ec`, `d1cb553`)
- Applied 6 of the audit's copy fixes (P0 + 3 P1 + 2 P2), each its own commit:
  - **`1106e32`** (P0) — goal-first camera-gate copy in `QrScanner.tsx` ("Point your camera at a payment
    code to pay" + "Allow camera scan").
  - **`4f67b4c`** (P1) — explicit fee/min placeholders on the deposit sheet.
  - **`35d3ea3`** (P1) — actionable empty-state in Ledger (Transactions dead-end).
  - **`0d096c6`** (P1) — Receive settle link rephrased to a concrete action.
  - **`7467070`** (P2) — drop redundant network clauses from balance subtitles.
  - **`af475fc`** (P2) — shorten onboarding CTA to "Create wallet".
- **`f8da5ec`** — update flow 06 affordance assertion (regex) for the Receive copy change.
- **`d1cb553`** — re-seed 4 drifted visual baselines (wallet-pay, receive-request, balances, ledger)
  after the copy changes.

## 3. Verified gate state (end of session)

- `just e2e`: **44/44 GREEN** (suite slip target now 30s for 44 flows; load-scaled on a busy host).
- `just e2e-visual`: GREEN (flow 40 pixel-diff vs committed baselines).
- `just typecheck`: clean. `just bridge-parity`: OK (21 methods). `npx jest`: **257/257**.
- Git: on `main`, **36 commits** ahead of origin/main (28 this session + the 8 docs/comment commits of
  this Phase 7 doc-persist pass). Working tree clean.

## 4. UX audit verdict

14 real-app screenshots (onboarding, wallet/pay, receive/request QR, balances, deposit, ledger, settings)
driven through the real FakeLedger relay, each analyzed via zai-vision. 10-item Quick Wins table in
`2026-08-05-ux-audit.md` (file:line for each). **6 applied this session** (P0 + 3 P1 + 2 P2). The
remaining P1/P2 are deferred — structural (Settings → "Server" + Advanced disclosure needs a confirm/
Apply-gate design) or low-ROI polish. See §5.

## 5. Reminders / open items for next session

- **18-dec ckERC20 coverage (flow 43 follow-up):** no 18-dec asset in `FakeLedger`'s `fake_catalog`
  (only DEMO 2-dec, ckBTC 8-dec, ckUSDC/ckUSDT 6-dec). The 6-dec case proves the formatter is decimals-
  agnostic. A founder outer-loop catalog addition (register an 18-dec ckERC20 ledger + minter + add to
  `fake_catalog`) would close it. Documented in flow 43's header comment.
- **Audit's remaining P1/P2 (deferred — structural or low-ROI), all in `2026-08-05-ux-audit.md`:**
  - Settings "Relay URL" → "Server" + Advanced disclosure (structural — needs a confirm/Apply-gate design;
    the raw URL is a footgun for non-technical users).
  - ∂ glyph in-onboarding explanation.
  - Timestamps locale-format.
  - Offline pill on Receive-QR.
  - Reset-entry-point visual weight.
  - Cancel-as-secondary-button parity.
- **Flow 38 (relay-retarget) one-off flake:** pre-existing race (asset-balance poll lags the relay
  retarget). Went RED once this session, GREEN in 4 subsequent runs. Worth a follow-up note, NOT blocking.
- **Real-flow RED diagnostics:** screenshot/DOM are best-effort (a real flow's `finally{env.stop()}`
  closes the page before runPool's catch fires); `actions.json`/`console.log`/`error.txt` always land. A
  future enhancement could snapshot in `driver.close()` when diagnostics are pending (~8% wall cost).
  Documented in `CODEBASE_ANALYSIS.md` Phase-2 paragraph.
- **Carryover open items still apply:**
  - **Issue #1 / #8** — live ckBTC deposit/withdraw. **CORRECTION:** these are exercisable on the **free** IC testnet chain-key tokens, NOT a real-money gate (I incorrectly claimed otherwise earlier this session). ckBTC Testnet (Bitcoin Testnet4): Ledger `mc6ru-gyaaa-aaaar-qaaaq-cai`, Minter `ml52i-qqaaa-aaaar-qaaba-cai`; ckETH Sepolia + ckSepoliaUSDC `yfumr-cyaaa-aaaar-qaela-cai` also exist. Wiring = register a testnet currency in the facade (admin `register_currency` w/ the testnet minter+ledger principals) + free testnet coins; the facade code path is identical (same minter candid, same 1-tuple `Call::with_args` invariant). Autonomous up to the founder's one-time currency-registration op.
  - **Issue #4** — `ADMIN_CALLERS` rotate pre-pilot.
  - **Issue #11** — RN/AGP 8.5 → 8.12 before the Play API 36 deadline (Aug 31).
  - **MC9 remainder** — repair `dpay-sim`; 2/6/8/18-decimal conformance matrix; atomic deploy; per-asset
    metrics.
  - **(Issue #3 — governance hand-off is founder-at-launch, DO NOT NAG; deliberately omitted from this list.)**

## 6. Commit index (this session, 28 commits)

```
d1cb553 chore(e2e): re-seed visual baselines after UX copy updates
f8da5ec fix(ux): update flow 06 affordance assertion for Receive copy change (P1, follow-up to 0d096c6)
af475fc fix(ux): shorten onboarding CTA to 'Create wallet' (P2 from 2026-08-05 audit)
7467070 fix(ux): drop redundant network clauses from balance subtitles (P2 from 2026-08-05 audit)
0d096c6 fix(ux): rephrase Receive settle link to concrete action (P1 from 2026-08-05 audit)
35d3ea3 fix(ux): actionable empty-state in Ledger (P1 from 2026-08-05 audit)
4f67b4c fix(ux): explicit fee/min placeholders on deposit sheet (P1 from 2026-08-05 audit)
1106e32 fix(ux): goal-first camera-gate copy in QrScanner (P0 from 2026-08-05 audit)
d5b992f fix(relay): caller signal wins over backstop (un-cap deposit_address 20s timeout)
210a7c6 refactor(wallet): extract useTransactionHistory hook
ba27ec3 refactor(wallet): extract useBalancePoll hook
2a36390 refactor(wallet): extract useCatalog hook
d3239ba refactor(app): use fetchWithTimeout for inline fetch boilerplate
371e1e4 feat(relay): fetchWithTimeout helper
0d36bba chore(just): e2e-watch + e2e-watch-filter recipes
03d299b feat(e2e): watch mode — re-run flows on app/harness/core change
cb76128 style(e2e): restore close() doc-comment alignment (Phase 2 tidy)
de8bc89 fix(e2e): keep driver registered through RED-path dump (Phase 2 unit 2 fix)
e76241e feat(e2e): wire RED-path diagnostics dump via AsyncLocalStorage (Phase 2 unit 2)
9290d55 feat(e2e): driver timeline + dumpDiagnostics (Phase 2 unit 1)
ea97dcd refactor(e2e): export runTestsSubset from run.mjs for reuse
de57c7f test(e2e): flow 43 decimal-edges
f21d5ce test(e2e): flow 42 receipt-reject
9618201 fix(a11y): label amount-input + settings-relay (RED→GREEN for flow 41)
9880ad4 test(e2e): flow 41 a11y census (RED)
b8668f3 chore(just): e2e-visual + e2e-visual-seed recipes (Phase 1/4)
816b9fb feat(e2e): flow 40 visual regression + QR mask (Phase 1/4)
f1159e5 feat(e2e): pixel-diff comparator (Phase 1/4)
[prior session: eb21569 31e6f11 a661f48 6badb96 ...]
```

> The Phase 7 doc-persist pass (8 docs/comment commits, this very file included) lands AFTER `d1cb553`
> and is NOT counted in the 28 above. Run `git log --oneline eb21569..HEAD` for the full session list
> including the doc-persist tail.
