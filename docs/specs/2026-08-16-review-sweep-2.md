# 2026-08-16 review sweep #2 — session plan

> Trigger: no planned work remained (OPEN_ISSUES work order neutral; HEAD `c25202d` + tail
> `2914467`/`08aafe1` landed while this session started). Per review instructions: audits
> (code arc, prod reconciliation, real-app UX) → fix everything value≥4 / confidence≥6 →
> re-verify → ship prod → record.

## Baseline established
- `just check` (rust) GREEN; e2e re-run **78/78 GREEN** at `08aafe1` (first run's RED on flow 27
  was an infra collision with the concurrent session's vite/sirv, not a regression).
- `just app` GREEN (self-check PASS). campreview pending (emulator churn; re-run after reboot).
- Prod reconciliation: **prod IS at HEAD `c25202d`** byte-verified (relay /api/v1/version, /wallet
  bundle + wasm shas, canister module hash, versioned APK). Sole stale artifact = bare-URL APK at
  CF edge (founder purge, unchanged). Deploy creds ALL present in-sandbox (CF_TUNNEL_TOKEN,
  keystore, dfx `dpay` identity = controller of ssqti/td2nx) — shipping HEAD is autonomous.

## Findings to fix (all value≥4, confidence≥6)
| id | what | where | effort |
|----|------|-------|--------|
| A-F3 | wasm core `fetch` has no timeout (prod /wallet hang class; violates repo rule) | `e2e/web/dpay-core-wasm.ts:143` | S |
| U-F1 | 4 share affordances feel dead: fire-and-forget, no in-DOM feedback | `ReceiveMode` L260-272, `PayMode` L195+L232, `SolPayMode` L298 | S |
| U-F3 | link-payment request expires (~4 min) while a NEW payer onboards (writes 24 words) | request TTL constant (IC rail only; SOL ≤90s is blockhash physics — DO NOT touch) | S+M |
| U-F4 | no keyboard focus indicator on buttons | global focus-visible CSS in web entry | S |
| U-F5 | Pay review shows counterparty name only, no short pubkey for verification | PayMode review | S |
| U-F6 | landing under-answers "how do I become a merchant" | relay landing page | S |
| A-F4 | new testIDs zero coverage: `sol-send-needs-sol`, `sol-ata-checking-sol` | jest render tests | S |
| A-F1/F2 | doc drift: flow counts 75→79 (`app/README.md:40`, `CODEBASE_ANALYSIS.md:55`), stale "61-flow" note (:81), AGENTS.md:31 dangling "(see "Web wallet" below)" | docs | S |
| — | campreview `device:` display line ignores ANDROID_SERIAL (misleads debugging) | `scripts/android-campreview.sh:49` | S |

Rejected findings: "prod web wallet 10 commits stale" (byte-proven wrong — prod == HEAD);
desktop-width sparseness (value 5, effort M-L, design-level → OPEN_ISSUES note).

## Execution
1. Device gates on clean tree (app ✓, campreview after emulator reboot).
2. Two implementation agents (disjoint file sets), TDD where possible, each runs its own gates.
3. Full `just verify` + device gates re-run after last commit.
4. Ship: `just apk && just image && just up`; verify-relay-version + verify-deploy + curls.
5. Update OPEN_ISSUES.md (new items w/ value+effort, close done), plan doc, session summary.
