# dpay — agent instructions

## Project memory

Read **`CLAUDE.md`** first — it holds the project memory, the non-negotiables (autonomous + offline dev loop, shared Rust core, PocketIC, non-custodial/no-swap/no-exchange-creds), the positioning/monetization pointers, and the current build state. Treat its constraints as hard requirements, not preferences.

Then read **`OPEN_ISSUES.md`** — the authoritative list of known blockers and documented follow-ups (chain-key receipts, governance hand-off, reconcile generalization, etc.). Check it before starting work so you don't re-derive what's already known or re-attempt something blocked on an external step.

## Codebase analysis — read before working, keep current

**Read `CODEBASE_ANALYSIS.md` at the start of every coding session in this repo**, immediately after `CLAUDE.md`. It is the living structural analysis: architecture health, where the design earns its keep, and the risks to know before editing (canister controller, open `mint()`, unsigned receipt, etc.).

It is not a historical snapshot — it is maintained alongside the code:

- **When a change resolves a documented risk** (e.g. `mint()` gains a caller guard, the canister controller is governed, the receipt is canister-signed), strike that risk in `CODEBASE_ANALYSIS.md` in the same change and note the resolution.
- **When a change adds a new surface, invariant, or risk**, add it to `CODEBASE_ANALYSIS.md` in the same change.
- **If anything here stops matching the code, the doc is wrong — fix the doc.** Stale analysis is worse than none.

## Working in this repo

Inner loop runs fully offline via `just` and completes in seconds (`just verify` = core + canister + relay + e2e; `just test-core`, `just test-canister`, `just test-relay`, `just sim`, `just ffi` for individual slices). `third_party/` is the canonical local source cache — look there first; `.dev/`, `third_party/`, `vendor/`, and `target/` are gitignored. The Android emulator / physical devices are an outer-loop fidelity gate only, never on the inner loop.

**The RN app (`app/`) is a modular tree, not a monolith** (split 2026-07-31; see `2026-07-31-app-split-plan.md`). `app/App.tsx` (~80 lines) is the root — it loads identity + relay, self-checks, and routes `Onboarding | Wallet`. The rest is layered: `config/` (palette, constants incl. the module-level `POLL`, currency catalog), `lib/` (types + pure format helpers), `hooks/`, `services/` (the single `NativeModules.DpayCore/DpayNfc` destructure + relay/withdraw fetch clients + receipt verify), `styles.ts` (ONE `StyleSheet.create` block — do NOT partition it; the e2e net matches testID + textContent only and cannot catch a dropped style key), and `components/` (all presentational components incl. the `Wallet` container). Use relative imports only (no `@/` aliases). Only `app/App.tsx` imports `./relayConfig` (the e2e `?relay=` override is anchored on that path); thread `relayUrl` as a prop everywhere else.

## E2e flow catalog

**`FLOWS.md`** is the authoritative manifest of every tested user flow (28 flows, organized by journey). Read it to see what's covered and how to add a new flow. Run `just e2e` (all) or `DPAY_E2E_FILTER=NN node e2e/run.mjs` (one flow).

## Human expectations

**`CLAUDE.md`** is the human-expectations document: the non-negotiables (non-custodial/no-swap/offline-dev-loop), the positioning/pitch, the monetization direction, and the scope boundaries. Keep it current when the founder provides guidance. Treat its constraints as hard requirements.
