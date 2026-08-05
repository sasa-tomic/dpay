# 2026-08-06 — Session work order

> Continues the `OPEN_ISSUES.md` "NEXT SESSION — work order" left by the 2026-08-05 session.
> The 2026-08-05 session shipped: visual regression harness, RED-path diagnostics, watch mode,
> coverage flows 41-43, the Wallet hook extraction (god-component teardown, -33%), a fetchWithTimeout
> DRY pass + a real composeTimeout caller-signal-wins bug fix, a fresh-eyes UX audit
> (`2026-08-05-ux-audit.md`), and 6 of the audit's copy fixes (Phase 6.5). All gates green at close:
> `just verify` 44/44, jest 258/258, typecheck clean, bridge-parity OK, e2e-visual GREEN, gradle
> release BUILD SUCCESSFUL, `just app`/`just ondevice` GREEN on the API-36 emulator. 41 commits ahead.

## Goal

Close as many of the 8 unblocked DO NEXT items as possible (all autonomous, no founder op needed
except #1/#2 which need investigation). The 3 POSTPONE items (governance hand-off, ADMIN_CALLERS
rotation, real mainnet ckBTC) stay postponed.

## Work units (parallelizable; conflict notes inline)

### Wave 1 — independent, dispatch in parallel

**W1.A — #3 18-dec ckERC20 coverage (flow 43 gap).** Pure test code.
- Add an 18-dec fake asset to `FakeLedger.fake_catalog` (relay: `crates/dpay-relay/src/ledger.rs`).
- Add a parallel 18-dec test canister ledger to `dpay-canister-tests` (or extend an existing one).
- Add a flow `43-decimal-edges` case asserting 18-dec exact-decimal on the review screen.
- Closes the last decimal-edge gap. No mainnet.

**W1.B — #4 Settings "Server" rename + Advanced disclosure (audit P1).** App code.
- `app/components/SettingsSheet.tsx`: rename "Relay URL" → "Server", collapse behind an
  "Advanced" disclosure, gate Apply behind a confirm when the URL differs from last-known-good.
- Coordinate with W1.C (Settings copy also lives in this sheet).
- Single owner of `app/components/SettingsSheet.tsx`.

**W1.C — #5 Remaining UX audit P1/P2 (NOT Settings — see W1.B).** App code.
- Quick Wins #1 (camera copy, `QrScanner.tsx`), #3 (fee/min placeholders, `DepositSheet.tsx`),
  #4 (empty Ledger state, `Ledger.tsx`), #5 (Receive "Scan to settle" rephrase/hide, `ReceiveMode.tsx`),
  #6 (drop "on Bitcoin"/"on Ethereum" from asset subtitles, `BalancesSheet.tsx`),
  #7 (separate "dpay" wordmark from username, `Wallet.tsx`),
  #8 (shorten "Create & fund wallet" → "Create wallet", `Onboarding.tsx`),
  #9 (timestamps "Today, 1:19 PM", `Ledger.tsx`),
  #10 (offline-status pill on Receive-QR, `ReceiveMode.tsx`).
- Coordinate with W1.B: W1.C does NOT touch SettingsSheet.tsx.

**W1.D — #6 Flow 38 relay-retarget race fix.** App code + e2e.
- Real race: the asset-balance poll lags the relay retarget → flow 38 went RED once.
- Fix the race (likely an awaited refetch on Apply, or a key bump that resets the poll).
- Verify flow 38 stays GREEN.

**W1.E — #8 Real-flow RED diagnostics enhancement.** e2e harness only.
- `e2e/harness/driver.mjs`: when `unexpectedDiagnostics.size > 0` at `driver.close()`,
  snapshot screenshot + DOM (~8% wall cost — measure before committing).
- Distinct from Wave-1's other work; pure harness change.

### Wave 2 — after Wave 1 (heavier; coordinate the deploy-script work)

**W2.A — #7 MC9 autonomous pieces.** Multiple sub-units:
- Repair `dpay-sim` (stale against wire-format v2; the narrated demo).
- 2/6/8/18-decimal conformance matrix (overlaps W1.A — fold them).
- Atomic asset-deploy script (single declarative path for `register_currency`).
- Per-asset readiness/metrics.
- Split out anything founder-ops-gated.

### Wave 2 — investigate autonomy first

**W2.B — #1 Testnet ckBTC + ckSepoliaUSDC live-path wiring.** Investigate whether a
throwaway staging facade can be deployed autonomously (vs needing founder `register_currency` op
on the production facade `ssqti`). If yes → ship (a) deploy-script block, (b) `e2e-live` flow.
**W2.C — #2 WalletConnect live pairing via Sepolia** rides on W2.B.

## Conflict avoidance

- `app/components/SettingsSheet.tsx` → W1.B only.
- `app/components/ReceiveMode.tsx`, `Ledger.tsx` → W1.C only (multiple fixes within).
- `app/components/Wallet.tsx` header → W1.C only.
- `e2e/harness/driver.mjs` → W1.E only.
- `e2e/tests/38-relay-retarget.mjs` + the polling path → W1.D only.
- `crates/dpay-relay/src/ledger.rs` (FakeLedger) → W1.A only.
- `e2e/tests/43-decimal-edges.mjs` → W1.A only.

## Finalize

- Re-seed visual baselines (`just e2e-visual-seed`) after all UI copy changes land — the 5 primary
  surfaces will drift, that's expected.
- Final `just verify` green.
- Update `OPEN_ISSUES.md` (close items, advance the work order), `CODEBASE_ANALYSIS.md` (any new
  surface/risk), `2026-08-05-ux-audit.md` (mark resolved Quick Wins), `FLOWS.md` (regenerate).
- Write `2026-08-06-session-report.md`.
- Commit each unit when done.
