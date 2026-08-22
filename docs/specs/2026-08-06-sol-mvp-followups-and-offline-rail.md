# 2026-08-06 — SOL MVP follow-ups + offline-pay durable-nonce rail

> Created at session start. The SOL native device-key MVP shipped 2026-08-06 part 4
> (commits `0fafae7`→`329b4d5`); this plan carries the documented follow-ups forward and scopes the
> next major feature (the differentiating offline-pay rail). Aligns with the CLAUDE.md top-priority
> directive: native-asset (BTC/ETH/SOL) in/out. SOL online in/out is DONE; this closes its residual
> follow-ups and starts the offline-pay rail.

## Context (do not re-derive)

- SOL rail is **app-scoped only** (no IC canister / relay / facade / wire change). Frozen wire
  (292/196/132) must stay untouched.
- Key path: SLIP-10 ed25519 `m/44'/501'/0'/0'` from the IC identity seed → separate Solana key.
  Pure modules (`solana/identity.ts`, `solana/tx.ts`) static-imported; network (`solana/rpc.ts`)
  reached via a lazy `await import('./solana/rpc')` inside async fns in `app/solana.ts`, gated by a
  non-empty `SOLANA_RPC_URL`. Empty URL → no-op (jest + e2e set the override `''`).
- Deps in use: `@noble/curves@1.8.0`, `@noble/hashes@1.4.0`, `bs58@6.0.0` — all transitive only.
- Device gate: `DPAY_SOL_SELFCHECK` self-check already in `App.tsx` + `scripts/rn-run.sh`.

## Phase 1 — close the SOL MVP residual follow-ups (autonomous, high value)

### 1a. 🔴 Promote transitive SOL deps to explicit (FRAGILE — do first)
- **Problem:** `@noble/curves`, `@noble/hashes`, `bs58` are imported by `app/solana/*` but are NOT
  declared in `app/package.json` (transitive via `@walletconnect/*`, `viem`, `@reown/appkit`).
  A dedupe/upgrade that drops any of them silently breaks the SOL rail + `DPAY_SOL_SELFCHECK`.
- **Fix:** add all three as explicit `dependencies` pinned to the currently-resolved versions
  (`@noble/curves@1.8.0`, `@noble/hashes@1.4.0`, `bs58@6.0.0`); `npm install --offline` to refresh
  the lockfile without network. No code change. Conf 10/10 safe.
- **Verify:** `just typecheck` clean, jest green (solana-identity/tx suites), `just e2e` green (flow 45).

### 1b. 🟠 Run the device gate (`just app` → `DPAY_SELFCHECK PASS` + `DPAY_SOL_SELFCHECK PASS`)
- The sandbox has `/dev/kvm` + the API-36 emulator. Run `just app` and assert BOTH self-checks PASS
  in logcat. This proves `@noble/curves`/`@noble/hashes`/`bs58` actually bundle under Metro/Hermes
  (the exact structural blind spot, AGENTS.md blind-spot 1). Outer-loop but runnable here.

### 1c. 🟠 Real devnet round-trip from the APP (proof, not required for MVP)
- The tx builder is byte-exact vs `@solana/web3.js` in jest, and the PoC proved a live round-trip —
  but the PoC used `@solana/web3.js`, NOT the app's hand-rolled `rpc.ts`. To prove the app's path:
  fund the derived address on devnet, then either (a) `just app` + a real send, or (b) a node script
  that imports `app/solana.ts` with `SOLANA_RPC_URL=devnet` and sends 0.001 SOL.
- **Gated on:** devnet faucet (free, no key) + network (outer-loop). Try; if blocked, record precisely.

## Phase 2 — the differentiating feature: SOL offline-pay durable-nonce rail

> This is dpay's signature feature applied to SOL: the payer signs FULLY OFFLINE (airplane mode),
> the online merchant broadcasts + confirms in ~1s, then hands the advanced nonce back so the payer
> can make the next offline payment without resync. PoC on-chain-proven in `.dev/sol-poc/`.

### Design forks (founder input needed BEFORE building — batch the question)

> **RESOLVED 2026-08-06 (founder).** Decisions recorded below; the chosen path expands scope over the
> minimalist recommendations (NFC parity + SPL tokens in addition to the recommended receipt-relay).

1. **QR-only vs NFC tap for the MVP.** The IC rail has NFC HCE glue; SOL has no NFC work yet.
   Recommendation was: QR-only MVP. **DECISION: QR + NFC tap now** — build NFC HCE parity for SOL
   alongside QR (both transports). NFC work is net-new for the SOL rail.
2. **Sequential offline payments.** Solana's `advance` rotates the nonce value, so it's one offline
   payment per nonce-sync. **DECISION: merchant receipt-nonce-relay** (the recommendation) — the
   online merchant hands the advanced nonce back over the tap/QR so the payer's next offline payment
   uses it without a resync. A nonce-account POOL is the later scale mitigation (non-goal for MVP).
3. **Scope.** Native SOL only (no SPL tokens / USDC-on-Solana)? Recommendation was: SOL only.
   **DECISION: SOL + SPL/USDC now** — the offline rail covers BOTH native System Program transfers
   AND SPL Token transfers (incl. USDC-on-Solana). Adds Token-program instruction formats + ATA +
   rent concerns to the build.

### Build (after forks resolved)

- `app/solana/nonce.ts` — create / advance / authorize / resync a durable nonce account (System +
  Nonce instructions). Pure where possible; RPC behind the dynamic-import seam.
- QR formats: `solreq:` (merchant request: amount + the merchant's nonce pubkey + recent slot) and
  `solpay:` (payer's offline-signed authorization against the stored nonce, NO recent blockhash).
- Offline sign in PayMode (payer signs against the stored nonce — no network); merchant broadcast in
  ReceiveMode; receipt-nonce-relay (merchant hands the advanced nonce back so the payer can pay again).
- e2e: a `__DPAY_TEST_SOLANA_RPC` stub seam so the offline loop exercises the QR/sign/broadcast path
  against a fake RPC (the WC-precedent dynamic-import boundary keeps `@solana/*` out of the headless
  graph). Offline-sign + stale-nonce-survival is the proven invariant to pin.
- Device gate: extend `DPAY_SOL_SELFCHECK` to also exercise the nonce instruction builder.

### Non-goals (recorded so they aren't re-attempted)
- ckSOL (production canisters don't exist; the device-key path is the chosen direction).
- Nonce-account POOL (the later scale mitigation; MVP uses merchant receipt-nonce-relay).
- Mainnet RPC config (operator step; `SOLANA_RPC_URL` defaults to public devnet).

## Verification (per phase)

- Phase 1a: `just typecheck`, jest (solana suites), `just e2e` (flow 45) — all green.
- Phase 1b: `just app` logcat asserts BOTH `DPAY_SELFCHECK PASS` + `DPAY_SOL_SELFCHECK PASS`.
- Phase 1c: a real devnet signature (outer-loop; record if blocked).
- Phase 2: TDD — RED test for offline-sign + broadcast first; jest byte-exact vs PoC golden; e2e
  offline-handoff flow against a stub RPC; device gate nonce-builder self-check.

## Status

- [x] Phase 1a — transitive deps promoted (commit `ed1b4c2`)
- [x] Phase 1b — device gate SOL self-check PASS (`just app` 2026-08-06: `DPAY_SOL_SELFCHECK PASS`)
- [x] Phase 1c — devnet round-trip from the app (send sig `36iNhSstnx5DW72hmne27Thr453JmQUGFiTrL3pLYdrEHU4BukAgCUSQH6cBiZHsb9BxnEXrAjEWpYvit4rJyb3X`; proof at `.dev/sol-proof/run.cjs`)
- [x] Phase 2 — QR offline-pay rail built + e2e-proven (commits `fe2be81`→`cb4ff51`):
  - [x] U1 `solana/nonce.ts` — durable-nonce builders (byte-exact vs `@solana/web3.js` golden)
  - [x] U2 `solana/spl.ts` — SPL Token transfer + ATA PDA (byte-exact vs `@solana/spl-token` golden)
  - [x] U3 `solana/qr.ts` — `solreq:`/`solpay:` codec (30 tests, strict validation)
  - [x] U4 `solana/rpc.ts` — `getNonceAccount` + rent + e2e stub seam (`__DPAY_TEST_SOLANA_RPC_STUB`)
  - [x] U5 `solana.ts` seam — offline-pay lifecycle (signOffline/createNonce/broadcast/resync)
  - [x] U6 `services/solNoncePersist.ts` — payer nonce-account state (AsyncStorage)
  - [x] U7 `solana/payments.ts` — SOL receipt outcome logic (receipt-nonce-relay)
  - [x] U8 `components/SolPayMode.tsx` — payer offline-sign + hand-off UI
  - [x] U9 `components/SolReceiveMode.tsx` — merchant request + broadcast UI
  - [x] U10 Wallet wiring + e2e flow 46 (QR offline handoff via stub RPC, 47/47 GREEN)
  - [x] U11 SOL NFC transport (Kotlin HCE + RN bridge, AID `F06470617902`) — DEVICE GATE CONFIRMED (`just app` → both self-checks PASS, module loads)
  - [x] U12 e2e SOL NFC seam + flow 47 (48/48 GREEN)
  - [x] U13 `DPAY_SOL_SELFCHECK` extended (nonce builder on Hermes) — device gate CONFIRMED PASS
- [x] Phase 2 NFC — U11 (Kotlin HCE `DpaySolNfc`) + U12 (e2e flow 47) DONE (commit `d772ae3`); physical two-phone radio proof stays a physical-device gate
