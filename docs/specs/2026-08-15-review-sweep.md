# 2026-08-15 — Broad review sweep + prod reconciliation ship

## Context

- Work order empty/neutral: HEAD `079fce9` = verified `51855d0` + docs-only commit. All prior queued work COMPLETE.
- This session = the review mandate: find + fix ALL issues (code/functional/visual), harness improvement, UX review on the REAL app (no mocks), prod reconciliation.
- **Prod state:** relay container `dpay-relay-1` runs ON THIS HOST (this sandbox is the prod host; `deploy/.env` has the tunnel token, keystore + dfx identity present). Prod APK/relay image built at `5dcdd83` (2026-08-11) — ~15 commits stale (SOL camera fix, ATA setup UX, whole-row hit-target, legacy-fund removal all unshipped). No canister changes since `5dcdd83` → `deploy-ic` correctly skipped.

## Phases

1. **Baseline** — `just verify` green at HEAD (evidence for the later prod ship).
2. **Parallel review swarm** (read-only subagents, each returns findings w/ value+effort):
   - A. RN app sweep (`app/`) — silent errors, dead/unwired code, hooks violations, DRY, slop, files>2k lines.
   - B. Rust + scripts sweep (`crates/`, `scripts/`, `deploy/`, `e2e/` harness) — same classes + timeout/termination/idempotency rules.
   - C. E2e coverage review — FLOWS.md vs recent features; gaps, redundancy, speed; jest/e2e false-confidence.
   - D. UX review, REAL app, no mocks — emulator vs PROD relay (screenshot + zai-vision) + web vs test relay; keyboard flows; click-count reduction.
   - E. Prod reconciliation — `curl` prod catalog vs app expectations; `just verify-relay`/`verify-deploy`.
3. **Fix** findings (value≥4, confidence≥6) via implementer subagents, TDD RED-first where applicable.
4. **Gates** — `just verify`; device gates (`just app`/`campreview`/`ondevice`) iff trigger paths touched.
5. **Ship** — `just apk && just up` (relay image + embedded APK → HEAD); `just verify-relay` green after.
6. **Docs** — OPEN_ISSUES.md (value/effort columns; close done), CODEBASE_ANALYSIS.md, session summary; commit each unit.

## Rules honored

- Fix pre-existing issues first (none open in OPEN_ISSUES.md — verified).
- No mocks in UX review; no backward compat; root-cause fixes only.
- Commit each unit of work; only value≥4 findings enter OPEN_ISSUES.md.

## Outcome — COMPLETE (HEAD `6eb102a`, prod shipped)

Findings fixed (5 review agents → 3 implementer waves, all value≥4 items):

| Commit | Unit | Contents |
|---|---|---|
| `0d504d6` | App hygiene (A1,A3-A7) | chainId stale-closure dep; dead `online` props; dead exports (`SOL_ATA_CHECK_TIMEOUT_MS`, `verifySignedTransaction`+tests, `generateMnemonic`, `receiptClaimBytes`) + stale OPEN_ISSUES F3 strike; `SYSTEM_PROGRAM_ADDRESS` → shared `solana/constants.ts`; `Logo` uses `C.brand`; SolPayMode friendly QR error. Jest 781. |
| `f31783f` | Rust/ops (B1-B5) | relay withdraw timeout 10s→`MINTER_CALL_TIMEOUT_SECS`(30s) — kills the >10s false-503→spent-nonce→422 money path; `ic_cdk::print` deprecation ×14 via one `#[allow(deprecated)] print_log` wrapper (prod-visible, NOT debug_print); `cf-lib.sh` bounded curls; `demo.sh` fail-loud health gate; APK route `max-age=300` + sha256 ETag + If-None-Match 304 (replaces 1-yr `immutable` CDN pin; tests 58/58). |
| `a0417f5` | App UX (D1,D3,D5,D6,A2,A8) | `S.disabledFlat` (opacity .35, no glow) at 10 primary-button sites; '0' vs '—' zero-balance semantics (ATA-absent+RPC-reachable → 0); A badge to header right edge + T badge on faucet row; Android double-back-to-exit w/ hint (verified on-emulator: hint renders, activity finishes); friendly NFC error copy (never raw `e.message`); `withdrawRejectionMessage` mapper + tests. Jest 787; flow-40 baselines reseeded (zai-vision-verified intended drift). |
| `2261386` | E2e harness (C1-C6) | flow 72 + send-side ATA lifecycle (happy + failure); NEW flow 77 USDC send-to-address + rent pre-check fold; `meta.optional` mechanism + flow 39 → `just e2e-store` (37s off default path); sirv-orphan reap (harness + `just cleanup`; 22-proc backlog cleared); flow 18 relay-direct 422s → relay.rs (literal `bad signature` assert). 74/74 default GREEN. |
| `6eb102a` | Receipt pin (E-F3, MC4 close) | prod facade `init_receipt_key` called (key materialized, verified); `EXPECTED_RECEIPT_PUBKEY` baked (`83c5c5…c4a8`); receipt.test.ts pin-loader fixed (explicit `''` vs baked-key fallthrough). |

Gates: `just verify` 74/74 + check slice green; `just app` both self-checks PASS; `just campreview` GREEN both rails; jest 787/787; relay tests 58/58; canister wasm builds warning-free.

**Prod ship:** `just apk && just up` → relay live at HEAD `6eb102a` (`/api/v1/version` match), container healthy; APK fresh via the landing page's `?v=<sha256>` link (verified live, 56544915B, ETag match). Canister unchanged (byte-fresh per verify-deploy) — correctly no deploy-ic.

**Founder-owned leftover (documented in OPEN_ISSUES, DO NOT NAG):** the CF edge still holds the pre-fix immutable object for the BARE `/download/dpay.apk` URL; the repo CF token lacks Zone·Cache Purge. One dashboard purge (or a purge-scoped token exported as `CF_PURGE_TOKEN`) finishes it; every FUTURE APK now revalidates ≤5 min by construction.

Process-only items (documented, no entry per value≥4 rule): prod-reconciliation curl assertion for deposit-metadata changes (D4) — noted in OPEN_ISSUES work order; D7 (Balances tail below fold w/ testnet on) sub-threshold.
