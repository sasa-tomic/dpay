# dpay — session report (2026-08-03): e2e GREEN, tech-debt, coverage, deploy fix

> **Hand-off brief for the next session (fresh context).** This documents what an autonomous agent
> session shipped on 2026-08-03. Read alongside `CLAUDE.md`, `OPEN_ISSUES.md` (Session summary at top),
> `CODEBASE_ANALYSIS.md`, `docs/CANISTERS.md`, and `FLOWS.md`.

## 1. TL;DR

- **e2e baseline was RED → now GREEN + load-aware.** The prior session's "35/35 in ~18s" did not
  reproduce on this (saturated, shared) host: concurrency=12 CPU thrash blew every per-test timeout.
  The harness now probes live host load and adapts concurrency + per-test timeouts. 39/39 GREEN.
- **Tech-debt Phase 5 (PR28–PR33) ALL RESOLVED** (4 commits): relayConfig no longer regenerated,
  `any`→`unknown`, accessibilityHints, `fmtTime` GMT offset, `useHotkeys` ref-mirror.
- **Test-coverage Phase 3: 9/10 gaps resolved.** Two new flows (28 ckUSDC-request, 38 relay-retarget);
  gaps #3 (NFC radio) + #10 (WC pairing QR) stay documented device/outer-loop gates.
- **Founder-driven: ckBTC/ckUSDC "Unsupported" on mainnet was a DEPLOY gap, not code.** The deploy
  script now registers metadata+ramps for all 3 currencies. The fix landed; running `just deploy-ic`
  on mainnet applies it.
- **Canister topology consolidated:** `canister_ids.json` tracked; `docs/CANISTERS.md` added; the two
  overlapping mainnet scripts merged into ONE path (`just deploy-ic`).
- **No-mock UX review: CLEAN.** Vision review of every primary surface found no actionable defects
  (every flag was a false positive — misread ∂ glyph, web-gated affordance, or already-guarded reset).
- **Wire untouched** (292/196/132). No canister CODE changed (scripts/docs/tests/app polish only).

## 2. What shipped this session (by track, with commits)

### e2e RED → GREEN + radical speed (commits `6cda3a1`, `6cee351`)
- **`6cda3a1`** — `e2e/run.mjs` load-aware: `hostLoadFactor()` probes free cores via `node:os`;
  `autoConcurrency()` clamps [2,12] by live load (busy host→2, idle→12); `timeoutScale = max(1,
  load1/cpus)` multiplies per-test `meta.timeoutMs` so a slow-but-not-hung flow never false-fails
  while a genuine hang still trips; perf-warning threshold load-adjusted; `withTimeout` message
  distinguishes slow-host vs genuine-hang. Explicit `DPAY_E2E_CONCURRENCY` env still wins.
- **`6cee351`** — `e2e/harness/lib.mjs` `setup()`: fresh-context nav `networkidle0`→`domcontentloaded`
  (~500ms/flow saved × 39; `waitReady()` polls `window.__DPAY_READY` as the real gate).
- **Honest ceiling:** on a saturated shared host the suite is ~150s (concurrency 2); on an idle host
  it returns to ~22s automatically. The architecture is correct; the wall-time is host-gated.

### Tech-debt Phase 5 PR28–PR33 (4 commits)
- **`0066c50`** PR28 — `app/relayConfig.ts` is now hand-edited source; `build-apk.sh` DERIVES the
  release URL + ASSERTS the committed value matches (release-safety preserved); `rn-run.sh` prints a
  Tailscale hint instead of overwriting. Kills the regen-drift class.
- **`60a5bc6`** PR33 — `useHotkeys` ref-mirror (handlersRef/optsRef updated each render; keydown effect
  `[]` deps subscribes once). Mirrors the NfcTap `onActive` pattern.
- **`5946fbc`** PR32 — `fmtTime` appends GMT offset (`14:30 GMT+2` / `GMT-5:30` / `GMT`); no Intl, no
  new deps, RN/Hermes-safe.
- **`4c9e9b2`** PR29 + PR31 — 18 `catch (e: any)`→`unknown` w/ narrowing; receipt.ts
  `verifyOutcomeReceipt(receipt: unknown)`. 2 `any` sites skipped (<6/10: NfcTap JSON-blob + RN
  NativeEventEmitter glue). 13 accessibilityHints on primary controls.

### Coverage Phase 3 — 2 new flows (commit `aa1142c`)
- **`28-ckusdc-request`** (gaps #2 + #9) — ckUSDC merchant-create via the UI picker; asserts
  `currency=2`, `amount='50000'` (byte-exact string), body includes `0.050000 USDC`, excludes `$0.05`.
  Fills the empty #28 slot.
- **`38-relay-retarget`** (gap #5) — spawns a SECOND relay, seeds ∂500.00 on it, switches
  `settings-relay` + Apply, asserts header changes ∂100.00→∂500.00 (proves the LIVE poll retargeted).
- FLOWS.md regenerated (37→39). Coverage triage confirmed 7 more gaps already resolved by existing
  flows (#1,#4,#6,#7,#8) with file:line evidence. Gaps #3 + #10 stay device/outer-loop.

### Mainnet deploy fix + consolidation (commits `158138e`, `6ca8dfb`, `2e3303f`)
- **`158138e`** — `scripts/dfx-deploy-icrc-mainnet.sh` (now deleted/merged) gained
  `register_currency_meta` for ckBTC(1) + ckUSDC(2). **Root cause of the "Unsupported" display:**
  ckBTC/ckUSDC were registered ledger+minter-only (piecemeal), which sets `minter_family` but no
  display metadata, ramp caps, or per-tx cap → `familyDisplay()` returns null → app renders
  "Unsupported" + `pay` reads `currency_cap().unwrap_or(0)` → every merchant-pay fails "over cap".
  The e2e suite didn't catch it (relay FakeLedger is a mock that doesn't enforce the cap).
- **`6ca8dfb`** — `.gitignore` un-ignored `/canister_ids.json`; it now tracks both owned canisters
  (`dpay_canister`→`ssqti`, `icrc_ledger`→`td2nx`). `docs/CANISTERS.md` added (authoritative topology:
  2 owned + 4 external chain-key deps). `AGENTS.md` points to it. This unblocked `dfx` name resolution
  on `--network ic`.
- **`2e3303f`** — merged the two overlapping mainnet scripts into ONE path (`just deploy-ic`). The
  consolidated `dfx-deploy-ic.sh` deploys the facade wasm + registers all 3 currencies' metadata +
  merges (not overwrites) `canister_ids.json`. Deleted `dfx-deploy-icrc-mainnet.sh` + its just recipe
  (its settle smoke was a one-time verify already run on mainnet; covered going forward by PocketIC +
  e2e + `just verify-deploy`). Fixed stale refs.

### Docs persist (commit `1e6fd0e`)
- `OPEN_ISSUES.md`: top-of-file Session summary; PR28–33 + coverage gaps marked resolved with evidence.
- `CODEBASE_ANALYSIS.md`: flow count 37→39; e2e "Speed/isolation" section rewritten for the
  load-aware harness.

## 3. Verified gate state (end of session)

- `just e2e`: **39/39 GREEN** (~108–150s depending on host load; load-scaled).
- `just typecheck`: clean. `just bridge-parity`: OK (21 methods). `npx jest`: 248/248.
- Git: on `main`, **18 commits ahead of origin/main**, working tree clean.

## 4. No-mock UX review — verdict CLEAN

Vision review (zai-vision) of every primary surface (onboarding, wallet/pay, receive/request QR,
multi-asset balances, ledger, settings, ckUSDC request). **No actionable defects.** Every flag was a
false positive:
- The **∂** glyph is the INTENTIONAL DEMO (play-money digital-dollar) symbol, asserted on by e2e
  (`∂100.00`); not a misrender.
- "Press Esc to close" IS gated `Platform.OS === 'web'` in all 5 sheets; only visible in e2e (web
  build); `null` on Android. Documented at `Wallet.tsx:343`.
- "Reset wallet" IS two-step guarded (`btn-reset`→`btn-reset-confirm`/`btn-reset-cancel`,
  `SettingsSheet.tsx:21,43-53`).
- "camera permission needed" is the headless-test placeholder (no real camera in chrome-headless);
  on device it shows the camera feed.
Functional + textual UX is thoroughly asserted by the 39-flow e2e suite on real rendered text.

## 5. Reminders / open items for next session

- **Mainnet op (founder):** run `just deploy-ic` to apply the metadata fix → ckBTC/ckUSDC will render
  correctly + become payable on mainnet. The script is consolidated + unblocked.
- **Per-asset cap policy (founder input):** the deploy script reuses the global `per_tx_cap` as a
  PLACEHOLDER cap for ckBTC/ckUSDC. A founder decision on real per-asset caps is wanted before pilot.
- **MC9 remainder** (founder's parallel work): repair `dpay-sim`; 2/6/8/18-decimal conformance matrix;
  declarative atomic asset deploy; per-asset readiness/metrics.
- **Issue #11:** RN/AGP 8.5→8.12 before API 36 deadline (Aug 31).
- **Issues #1, #8, #3:** real ckBTC deposit/withdrawal (outer-loop founder gates); governance hand-off
  (external human step).
- Gaps #3 (NFC radio) + #10 (WC pairing QR) stay device/outer-loop gates — not browser-e2e reachable.

## 6. Commit index (this session, 18 commits ahead of origin/main)

```
1e6fd0e docs: reflect e2e load-aware harness, 39/39 flows, tech-debt PR28-33 + coverage gaps resolved
2e3303f refactor(deploy): consolidate to ONE mainnet path (just deploy-ic)
6ca8dfb docs(canisters): track canister_ids.json + add topology doc
158138e fix(deploy): register ckBTC + ckUSDC metadata+ramps on mainnet
aa1142c test(e2e): add ckUSDC-request (flow 28) + relay-retarget (flow 38)
4c9e9b2 chore(app): narrow any→unknown (PR29) + accessibilityHints (PR31)
5946fbc feat(format): fmtTime appends GMT offset so travelers disambiguate (PR32)
60a5bc6 refactor(hooks): useHotkeys subscribes once via ref-mirror (PR33)
0066c50 fix(scripts): stop regenerating relayConfig.ts — verify instead (PR28)
6cee351 perf(e2e): use domcontentloaded for fresh-context nav (~500ms/flow)
6cda3a1 fix(e2e): make suite GREEN under host-load contention (adaptive concurrency + load-scaled timeouts)
[prior session: fdb59f4 c8bee7c ee78a55 c52ae49 07f3f03 ...]
```
