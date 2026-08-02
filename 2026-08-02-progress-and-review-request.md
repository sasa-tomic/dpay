# dpay — session progress (2026-08-02) + pedantic review request

> **Hand-off brief for the next session (fresh context).** This documents what an autonomous agent
> session shipped on 2026-08-02, the verified state of the tree, and an explicit request to
> **pedantically review the code from all completed stages** before any further work. Read alongside
> `CLAUDE.md`, `OPEN_ISSUES.md` (MC1–MC9 statuses), `CODEBASE_ANALYSIS.md`, and `FLOWS.md`.

## 1. TL;DR

- **MC1–MC8 are functionally complete** (MC9 release-gates is the founder's active parallel work:
  browser-fail-closed / `DPAY_SELFCHECK FAIL` is now a failing e2e gate).
- The bridge-parity defense-in-depth plan (issue #10) landed in full (Wave A/B/C) and a latent
  `just app` launch bug was fixed (Layer-3 gate unbroken).
- WalletConnect v2 is integrated end-to-end for the native Android ckERC20 onramp (real-wallet pair
  over the live WC relay remains an outer-loop founder sign-off).
- Inner-loop quality pass: `just test-live` promoted onto the hot `just check` path; the App.test.tsx
  teardown warning fixed (jest CLI now exit 0); a no-mock UX review shipped (request-QR expiry
  countdown, zero-balance shortcut, reusable visual-regression tour flow).
- **Gates green across the board:** `test-canister` 65, `test-relay` 46, `test-live` 45, `jest` 231
  (13 suites), `e2e` 35/35, `just app` `DPAY_SELFCHECK PASS`, `just ondevice` 9/9.

## 2. What shipped this session (by stage, with commits)

### Bridge-parity plan (OPEN_ISSUES #10) — defense against the wire-v2 launch-crash class
- `d7a6173` Wave A — strict TS bridge types + `just typecheck` gate; `scripts/bridge-parity.mjs` +
  `just bridge-parity` (arity parity Kotlin `@ReactMethod` ↔ TS interface); FFI `wire_len()`/
  `signing_len()`/`request_len()` + Kotlin/TS accessors; App.tsx self-check derives hex len from
  `wireLen()` (no magic literal); Kotlin `signWithdrawal` `@ReactMethod`.
- `132df85` Wave B — emulator gate resurrected (dead gradle-8.9 lookup fixed in
  `scripts/android-ondevice.sh`); 2 hidden wire-v2 NFC instrumented-test failures fixed (both were
  TEST bugs, not core bugs; the `mc=1 → TooManyFrames` protocol limit is now pinned in core + python).
- `469372b` Wave C — Layer-3 pre-merge `just app` checklist in `AGENTS.md`; issue #10 + risk #9 struck.
- `3eb9745` — fixed `just app` launch component (namespace `com.dpay` ≠ applicationId `org.kalaj.dpay`;
  the `.MainActivity` shorthand resolved to a non-existent class). Unbroke the Layer-3 gate silently
  broken since the Play rebrand.

### MC1 — exact amounts + authoritative asset metadata
Exact decimal-string transport for protocol `u64` across TS ↔ Kotlin `@ReactMethod` ↔ relay JSON; a
shared exact parser (`dpay_core::parse_decimal_to_units` + TS BigInt mirror), round-trip-pinned across
the whole `u64 × 0..=18` space; flow `29-exact-amount` asserts `9007199254740993` (2^53+1) byte-exact.
`CurrencyDescriptor` carries per-currency `wrapper_name`/`backing_symbol`/`network`/`display_decimals`/
`fee`/`cap`/`chain_id`/`token_contract` + `onramp`/`offramp: RampCapability`. Unknown families fail
closed (no Bitcoin fallback). Commits: `662ab29` (parser), `8c5bda1` (fail-closed), `04e5ec3`
(metadata), `cd40ef2` (transport), `a839671` (docs).

### MC2 — safe currency identity + policy (canister-only)
Governed per-currency cap (fail-closed), immutable ledger/minter identity (insert-only), irreversible
`retire_currency`, and atomic `register_currency(CurrencyRegistration)` with cross-canister strict
validation of `decimals`/`fee`/`wrapper_name` against the live ledger (F3 — no exemptions, incl. DEMO).
Commits: `0742e56` (U1 cap), `1ccb075` (U2 immutable), `51bffc4` (U3 retire), `2130169` (U4 atomic).

### MC3 — authoritative balances + freshness contract
Facade `refresh_balance(pubkey,currency)` authoritative update; `refresh_deposit` inline-refreshes
`BAL_CACHE` after every successful minter call; relay `Ledger::balance` TTL-gates (≤15s staleness).
Covers direct ICRC + async ckERC20 heartbeat mints via on-demand refresh. Commits: `a8ae4b7` (U1),
`746d409` (U2).

### MC4 — trusted receipts + durable reconciliation
Receipt key ensured BEFORE the ledger commit (eliminates first-pay trap); `reconcile` reconstructs
signed receipts for trap-orphans; relay `/receipt/:nonce` is canister-backed + restart-safe; `/pay`
Transient-exhausted falls back to a durable receipt lookup; `GET /receipt_pubkey` discovery route; the
APP pins the expected receipt pubkey independently (rejects a wrong-key receipt EVEN IF its sig is
internally valid — the malicious-relay close) + full-auth binding. Commits: `d642140`, `56ad1cd`,
`42fd745`, `c915a26`, `1bb97ac`.

### MC5 — asset-first wallet + transaction UX (remainder)
Currency-keyed offline deduction (`applyOffline` helper; an offline ckBTC hand-off reduces ONLY ckBTC,
never DEMO); unknown-asset rejection before signing (`isPayableAsset` gate in PayMode + NfcTap); ckUSDC
6-decimal e2e pay flow. Commits: `9e51929`, `9069dcd`, `9a21abd`, `ef748c9` (docs).

### MC8 — native/NFC parity + honest ramps
NFC asset disclosure (at-tap pre-sign); ckERC20 params catalog/token-specific (fail-closed); chain-ID
enforced at connect; ETH receipts/reverts awaited; ckERC20 deposit state persisted across restart;
ramp-honesty regression pins. Commits: `dbc3df7`, `822f4df`, `b3ccbd1`, `ac10e8f`, `33d7782`, `4417c3e`.

### MC8 U6 — WalletConnect v2 native onramp (founder-chosen; the onramp is online-by-nature)
Provider-agnostic `resolveOnrampProvider()` (web `window.ethereum` first; native → WC-backed EIP-1193);
isolated behind a lazy dynamic import + vite/jest shims so `just verify` never executes WC code; mocks
are tsc-checked against the real SDK surface with a compile-time drift-detector
(`walletconnect-conformance.test.ts`); functional capstone uses `showQrModal:false` + a `display_uri`
QR (zero new deps). Commits: `d8ba488`, `ece4b75`, `8275cc4` (mock-fidelity hardening), `098f905`,
`4ec8f1b`, `f07520b`, `a93fd57`.

### Inner-loop quality pass
- `5dddc9a` — promoted `just test-live` onto the hot `just check` path (closes the off-hot-path gap
  that let MC2 U1 break `test-live` silently while `just verify` stayed green).
- `08d6f86` — fixed App.test.tsx teardown (jest CLI exit 0; no "Cannot log after tests are done").
- `d6472ce` — no-mock UX review: request-QR live expiry countdown, zero-balance shortcut, reusable
  visual-regression tour flow (`e2e/tests/35-ux-tour.mjs`).

### Founder's parallel shipped work (not this session's, but in the tree)
Play signing hardening, API-35 retarget, R8 minify + resource shrinking (closes #12), the
`@reown/appkit/core` build-time shim (#13, FIXME'd as runtime-dead under `showQrModal:false`), the
browser-fail-closed e2e diagnostics (MC9).

## 3. Verified tree + gate state (as of `d6472ce`)

- Working tree clean. `origin/main` has advanced (founder pushes in parallel); use `git log` for the
  authoritative recent history rather than `origin/main..HEAD`.
- `just verify` = full inner loop green (now incl. `test-live`): core + canister (65) + relay (46) +
  live (45) + typecheck + bridge-parity (21 methods) + e2e (35/35).
- `just app` → `DPAY_SELFCHECK PASS`; `just ondevice` → 9/9. (Emulator `emulator-5554` / AVD
  `dpay_api34`. `just app` bakes a tailscale relay IP into `app/relayConfig.ts` — always
  `git checkout -- app/relayConfig.ts` after a `just app` run.)

## 4. REQUEST: pedantic fresh-context review of all completed stages

Before any further feature work, **pedantically review the code + invariants from every completed
stage below**, with a fresh context (do not trust this progress doc's claims — verify against the
code). The session was long and autonomous (~50 commits); a skeptical second pass is the safety net.
For each item: read the cited code, confirm the invariant actually holds, check for subtle bugs /
edge cases / security holes / tech debt the autonomous pass missed, and file concrete findings as
issues (or fix directly if small + >=6/10 confidence, per the standing rules).

Priority review targets (highest risk/value first):

1. **MC4 receipt trust + durable reconciliation (security-critical).** Verify:
   - `app/services/receipt.ts` `verifyOutcomeReceipt` actually rejects a wrong-`pubkey` receipt EVEN
     WHEN the sig is internally valid, and that the full-auth binding compares `amount` via `cmpRaw`
     (BigInt), never lexicographic string compare.
   - The pin (`EXPECTED_RECEIPT_PUBKEY`) is empty-by-default = dev fallback, and the e2e harness
     injects the FakeLedger key so flows exercise the PINNED path (flow `30-trusted-receipt`).
   - Canister `pay()` ensures the receipt key BEFORE `ledger_transfer` (the commit point) — confirm
     no post-commit `raw_rand` await remains on the first-pay path.
   - `reconcile()` block_index derivation (`start + i`) is correct against the ICRC-3 contract.
   - Relay `/receipt/:nonce` + `/pay` Transient fallback actually query `Ledger::receipt` (durable),
     not just the process-local cache.
2. **MC2 currency identity + policy (money-safety).** Verify `register_currency` atomicity (mismatch →
   NOTHING inserted), the per-currency cap is fail-closed (`None ⇒ 0 ⇒ OverCap`), `retire_currency` is
   irreversible + honored at every call site, and the cross-canister validation is strict for ALL
   currencies (no DEMO exemption).
3. **MC1 exact-amount transport.** Confirm NO `parseFloat`/`number`/`Double` remains in any protocol
   `u64` path (TS/Kotlin/relay JSON); that the parser rejects negative/overflow/too-many-decimals;
   and that `cmpRaw` is used for every amount comparison (never raw `<`/`>` on strings).
4. **MC8 U6 WalletConnect integration.** Confirm the isolation boundary holds (web/jest never execute
   WC code — check the e2e dist bundle + jest moduleNameMapper + vite aliases); the conformance
   drift-detector genuinely fails on an SDK surface change; `showQrModal:false` makes the appkit shim
   runtime-unreachable; and the non-custodial invariant (no ETH key ever reaches RN JS) holds.
5. **MC3 balance freshness.** Confirm `balance_of` stays the fast cached query, `refresh_balance` is
   the authoritative source the relay TTL-gates, and `refresh_deposit` refreshes inline in BOTH
   branches.
6. **Bridge-parity guards.** Confirm `scripts/bridge-parity.mjs` + `just typecheck` are in `just check`
   and would catch a wire/arity regression; the Layer-3 `just app` checklist is in `AGENTS.md`.

General things to hunt for across all stages: silent errors (catches that swallow without a logged
err code + state — m0001 mandates debuggable, match-style errors), missing I/O timeouts, non-idempotent
ops, dead code, duplicated truth, and any `as unknown as` / `!` / `any` that bypasses type safety.

## 5. Deferred / open follow-ups (not blockers)

- **WC real-wallet pair** over the live WC relay (scan QR with MetaMask on a 2nd device + online relay)
  = outer-loop founder sign-off (like real-BTC deposit, OPEN_ISSUES #1).
- **MC8 U6.5** — WalletConnect disconnect helper (small; clear cached provider + `provider.disconnect()`,
  surface in Settings). Note: the cache is typed `Promise<EthereumProviderInstance>` after the capstone;
  adding disconnect should keep the conformance test green.
- **MC9** — release gates (founder active on browser-fail-closed/`DPAY_SELFCHECK` gate). Remaining:
  2/6/8/18-decimal conformance matrix, declarative atomic asset deploy, per-asset readiness/metrics,
  repair `dpay-sim`.
- **Tech-debt file-splits** — `crates/dpay-canister/src/lib.rs` (~2921 lines), `icrc_settle.rs`
  (~2101), `nfc.rs` (~1755), `relay.rs` test (~1686). ⚠️ **lib.rs is RISKY** — the canister stable-memory
  layout is sensitive; a bad split can break upgrades. Get a founder nod before splitting lib.rs.
- **Radical e2e** — audit the 35 flows vs `FLOWS.md`; fill error-path/edge-case/asset-scenario gaps.
- **Low:** retire the `@reown/appkit/core` shim once a real `@walletconnect/modal-react-native` modal
  replaces the `display_uri` QR path (currently runtime-dead, FIXME'd).

## 6. Standing rules for the review session (from CLAUDE.md / AGENTS.md / m0001)

- Inner loop runs fully offline via `just` in seconds (`just verify` = check + e2e). Device gates
  (`just app` / `just ondevice`) are outer-loop fidelity only.
- Wire format is FROZEN: `WIRE_LEN=292`, `SIGNING_LEN=196`, `REQUEST_LEN=132` — do not change wire bytes.
- Non-custodial / no-swap / no-exchange-creds are hard non-negotiables.
- TDD RED-first; commit each unit; ship only >=6/10 confidence; never commit founder WIP (stage only
  your own files; use `git add -p` for files with parallel founder edits).
- Update `CODEBASE_ANALYSIS.md` + `OPEN_ISSUES.md` alongside any code change (living docs).
