# 2026-07-29 — Seamless ck top-up + radical e2e harness + production verification

> Master plan for this session. Built on top of the **already-shipped** ckBTC deposit backend
> (`deposit-integration-plan.md`, implemented in commit `2996eb9`). This plan covers the user-facing +
> verification layer that the backend plan explicitly deferred: a seamless top-up UX, a radical e2e
> harness that drives the **real** app, and a production-verification swarm that proves it on mainnet.
>
> Status legend: ⬜ todo · 🟡 in progress · ✅ done. Update as work lands.

---

## 0. Findings (verified this session)

### What is DONE (backend ckBTC deposit)
- `dpay-canister`: `deposit_address` / `refresh_deposit` / `deposit_info` (+ admin `register_minter`),
  proxying the ck minter with `owner=canister_self()`, `subaccount=pubkey`. Proven offline: 19/19 PocketIC.
- `dpay-relay`: `/api/v1/deposit/{address,refresh,info}` + `FakeLedger` deposit simulation. 26/26 unit.
- `dpay-mock-minter`: test-only canister, end-to-end deposit→mint→balance→spend proof.
- RN app `app/App.tsx`: `DepositSheet` (instructions + address + QR + copy + refresh poll + confirming/credited status).
- Mainnet canister live: `ssqti-wiaaa-aaaab-qhdia-cai`; relay live at `https://dpay.kalaj.org` (health `ok`).

### What is BROKEN / missing (the work)
1. **🔴 PRODUCTION: deployed relay is STALE.** Live `/api/v1/deposit/info?currency=1` and
   `/deposit/address/*` return **HTTP 404** (balance/pay/faucet return 200). The deployed image predates
   the deposit routes — the relay container has NOT been rebuilt/redeployed since `2996eb9`. The top-up
   flow is **unusable in production today**.
2. **🟠 Minter not registered on the live canister** (status unknown; the 404 hides it). ckBTC minter
   `mqygn-kiaaa-aaaar-qaadq-cai` must be `register_minter`'d for currency=1, and the facade principal
   must be KYC-allowlisted for ckBTC minting — both are deploy/governance steps, not code.
3. **🟠 No e2e harness drives the real app.** `ui/` builds **parallel** JSX components (`ui/src/*.jsx`),
   not the real `app/App.tsx`; it is a marketing-page + golden-shot harness, not a flow verifier.
   `app/__tests__` is a trivial smoke test + `payments.ts` unit tests only.
4. **🟠 Web has no top-up flow.** The deposit/top-up UX exists only in the RN app; the web build has none.
5. **🟡 Plan docs were untracked** — ✅ committed this session (`1359716`).
6. **No `OPEN_ISSUES.md`** for tracking; `TASKS.md` is stale (Week-1 ledger todos already done).

### Confidences (per the global rule: 1–10 correct, 1–10 safe)
- Redeploy relay with deposit routes + register minter: correct **10**, safe **9** (production value move).
- e2e harness drives real App.tsx via react-native-web: correct **9**, safe **8** (shim surface is small).
- Supersede `ui/src/*` parallel components with the real-app harness: correct **8**, safe **7** (loses
  nothing if the new harness screenshots the same states; reversible).

---

## 1. Goals / non-goals

**Goals**
- G1. A **seamless top-up UX**: from the wallet, one tap → instructions + address + QR + live
  confirmations progress → "Deposited ✓" → balance reflects it. Works in RN **and** web. No hunting.
- G2. A **radical e2e harness** that drives the **real** app (App.tsx) + **real** relay, runs in
  seconds, covers **every** supported flow, asserts on real outcomes (not pixel-only), and runs in two
  modes: `local` (FakeLedger, offline, fast) and `live` (mainnet, production gate).
- G3. **Production verification**: redeploy relay, register minter, prove the live top-up path, fix
  gaps, iterate to all-green. No silent failures.
- G4. **UX polish**: run the app as a user, fix visual/functional issues, optimize clicks + keyboard.
- G5. **Living issue tracking** (`OPEN_ISSUES.md`) + keep `CODEBASE_ANALYSIS.md` current.

**Non-goals (this session)**
- ckETH/ckERC20/ckSOL minters (documented follow-up; the seam is reusable).
- iOS. Physical NFC radio hop. Real camera. Withdrawal (burn) flow.
- Changing settlement logic, custody model, or fee schedule.

---

## 2. The radical e2e harness (centerpiece) — `e2e/`

### 2.1 Architecture
One Node harness under a new top-level `e2e/` dir. It:

1. **Builds the real app for web** — a `e2e/web/` entry that imports the **actual** `app/App.tsx`,
   wrapped in `react-native-web` `<AppRegistry>` (no parallel components). **Reuse `ui/vite.config.js`
   verbatim** (it already solves the RNW alias/extension/esbuild-jsx config) — copy it into `e2e/`.
   Native modules are shimmed by a single `e2e/web/shims.ts`:
   - `DpayCore` → a JS impl over `@noble/ed25519` that produces a **real, verify-compatible** wire.
     **MANDATORY cross-validation (review amendment #4, conf 9):** `FakeLedger` actually verifies
     signatures (`ledger.rs`, `sa.verify()`), so the shim must be **byte-exact** for LOCAL pay flows
     too — not just live. Sign the same `Authorization` in Rust (via `dpay-fixture`) and in the JS shim;
     assert byte-identical 100-byte signing buffer + identical sig + mutual `verify()`. **Do NOT
     hand-transcribe the layout** — generate a `wire_layout.json` (field offsets/lengths + golden
     signed bytes) from Rust (`dpay-fixture`) and have the shim read it, so there is one source of
     truth. Signing-gate = LOCAL mode; live mode exercises deposit wiring only (review amendment #5).
   - `react-native-qrcode-svg` + `react-native-svg` → web shims (`QRCode`→ a canvas/svg renderer,
     `Svg`/`RadialGradient`/… → pass-through to `react-native-svg`'s web build). These ARE imported by
     the real app and MUST be in the shim inventory (review amendment #6).
   - `Camera` → injects a scan result via a test hook (`window.__DPAY_TEST_SCAN`), the smallest boundary.
   - `DpayNfc` → reuse the existing `__DPAY_TEST_NFC` / `__DPAY_TEST_NFC_SESSION` seam already in the app.
   - `Share` → noop (web has no share sheet); `AsyncStorage` → `localStorage`.
2. **Deposit seeding (review amendment #1, conf 9 — was a blocker):** `FakeLedger::register_deposit`
   has no HTTP route, so a browser harness cannot trigger "pending→credited" through the relay. Add a
   **cargo feature `test-helpers`** on `dpay-relay` exposing `POST /api/v1/test/deposit/seed`
   (feature-gated `#[cfg(feature="test-helpers")]` → **cannot compile into the prod image**, satisfying
   "no mocks in prod code"). Local e2e builds the relay with `--features test-helpers`; the prod image
   (`just image`) builds WITHOUT it. Flow 05 seeds via this route, then asserts the credited path
   through the REAL relay + REAL FakeLedger settlement.
2. **Runs the real relay** — spawns `target/debug/dpay-relay` (FakeLedger, port `DPAY_RELAY_PORT`),
   the thinnest fake at the canister-I/O boundary. `RELAY_DEFAULT` is overridden to `127.0.0.1:PORT`.
3. **Drives via CDP** — connects `chrome-headless-shell` (the vendored binary) over the DevTools
   protocol; clicks real elements by `testID`/text, types into real inputs, asserts on real DOM text.
4. **Screenshots each state** → replaces the golden-shot visual regression (now against the **real**
   component tree, so it also catches real-app regressions, not parallel-component drift).

### 2.2 Two modes
- `just e2e` (default, `local`): real relay + FakeLedger, offline, seconds. The inner-loop gate.
- `just e2e-live`: same harness, `DPAY_E2E_BASE=https://dpay.kalaj.org` — drives the **live** relay +
  canister. The production gate. Throttled + idempotent (uses throwaway keys, small demo amounts).

### 2.3 Flow catalog (each = one test file; easy to list + extend)
| # | Flow | Asserts |
|---|------|---------|
| 01 | Onboard (new user) | username → wallet screen, balance $0.00, history empty |
| 02 | Faucet top-up (demo $) | `btn-topup` → balance +$50.00, history row appears |
| 03 | **ck deposit: open + address + instructions** | `btn-deposit` → address shown, QR, confirmations/min/fee copy |
| 04 | **ck deposit: copy/share address** | `btn-deposit-copy` fires; address text correct |
| 05 | **ck deposit: pending → credited** (FakeLedger simulates mint via its `register_deposit` hook, surfaced through the relay) | refresh poll → "Confirming" → "Deposited ✓" + ckBTC balance grows |
| 06 | Request QR (receive) | amount → QR rendered, payload decodes via `decodeRequest` |
| 07 | Scan → review → pay (payer) | injected scan → "Pay $X to …" → Approve → offline-signed QR (or direct submit if online) |
| 08 | Merchant receive → settle | request QR shown → payer's signed wire submitted → "Paid ✓" + balance |
| 09 | Double-spend refused | replay same nonce → rejected, no second debit |
| 10 | Expired refused | expired auth → rejected with message |
| 11 | NFC tap phases (via seam) | each `__DPAY_TEST_NFC_SESSION` phase renders correct status view |
| 12 | Settings: relay switch + reset identity | relay URL persists; reset clears identity |
| 13 | Offline handling | relay down → honest "Offline — try again" (no false success) |
| 14 | Keyboard shortcuts | documented keys execute primary actions (see §4) |

The deposit flows (03–05) are the **direct answer to the user's ask** and run in both `local` and `live`.

### 2.4 Superseding the old harness
- New harness screenshots the real app at each flow state → migrates the 12 existing golden shots into
  the real-app flow screenshots. **Remove** `ui/src/*.jsx` (parallel PayScreen/ReceiveScreen/Nfc*/…)
  and the `ui/_shot-landing.mjs` marketing screenshot path; the marketing landing itself stays (it is
  served by the relay, not by `ui/`). Keep `ui/scripts/{browser,get-browser,compare}.mjs` (reused:
  browser launcher + pixel-diff). The `just ui` recipe is repointed at `just e2e --visual`.

### 2.5 Dev-cycle speed
- Relay binary: prebuilt (debug, ms). Web build: vite (cached, <2s incremental). Browser:
  chrome-headless-shell warm. Target **full e2e suite < 15s** local. If it slips, that's a bug — fix it.

---

## 3. Seamless ck top-up UX

### 3.1 RN app (`app/App.tsx` — `DepositSheet` already exists; polish)
- ✅ address + QR + copy + refresh poll + confirming/credited. Strengthen:
  - **Instructions completeness**: network name ("Bitcoin"), asset ("BTC"), est. arrival ("~N min after
    N confirmations"), network fee, min deposit, and the non-custody line ("your money at your
    address — we never hold it"). Pull from `deposit_info`; honest ranges where the minter omits them.
  - **Progress clarity**: a single linear progress cue (Confirming `k/N` → Credited) instead of two
    possible zero-states. A "still waiting" reassurance + manual "Check now" button (don't only rely on
    the 10s poll — let the user nudge it).
  - **One-tap entry**: today it's a small `ckBTC` pill beside the faucet. Promote "Add money" to a
    primary affordance that opens the sheet; keep demo-faucet as a secondary "demo $" toggle inside.
  - **Copy UX**: `Share` works on-device but is awkward; add a real clipboard copy when available.

### 3.2 Web (new — comes free from rendering the real App.tsx in the harness)
- The same `DepositSheet` renders on web via react-native-web. Expose a `?screen=deposit` route (mirror
  the existing `?screen=nfc` convention) so the web build is directly deep-linkable to top-up. This
  makes the web a first-class top-up surface, not just RN.

### 3.3 What the user gets (the seamless path)
Wallet → **Add money** → (pick asset if multi; today ckBTC) → see **address + QR + instructions +
"send BTC here"** → watch **confirmations count up** → **Deposited ✓** → balance auto-updates. One
screen, no jargon, no "supported vs unsupported" exposed, honest time/fee estimates.

---

## 4. Production verification & fixes (the live swarm)

1. **Rebuild + redeploy the relay image** (`just image` → redeploy via `deploy/`) so the live relay
   serves `/api/v1/deposit/*`. **V1 acceptance (review amendment #8):** not just "curl returns 200" —
   assert the image is built from a `cargo build --release` of the current commit (the stale-image bug
   shows the deploy pipeline drifts from the build). Verify: `curl /api/v1/deposit/info?currency=1`
   → 200 JSON (not 404), and `curl /api/v1/deposit/address/<hex>?currency=1` returns an address.
2. **Register the ckBTC minter on the live canister** for currency=1:
   `dfx canister call ssqti register_minter '(1, principal "mqygn-kiaaa-aaaar-qaadq-cai")'` (the
   operator identity is controller=`null` demo default → any caller can call `register_minter`;
   autonomous-safe). Verify `deposit_address` returns a real-looking BTC address.
3. **🔴 KYC-allowlist — HARD EXTERNAL BLOCKER (review amendment #3, conf 9).** `refresh_deposit` on
   mainnet mints **nothing** unless the facade principal (`ssqti`) is **KYC-allowlisted** by DFINITY for
   ckBTC minting — an NNS/governance step the operator CANNOT do autonomously. Until it lands, the
   **ceiling** of live verification is: address + info reachable + `refresh_deposit` returns
   `NoNewUtxos` cleanly (honest — no false mint). The **credited path stays proven offline** via the
   PocketIC mock-minter + the FakeLedger `test-helpers` seed. Flag this in `OPEN_ISSUES.md` as
   requiring human/governance action; do NOT pretend it's verified.
4. **Run `just e2e-live`** flows 03–05 against mainnet: open deposit, get address, confirm the path is
   wired (address + instructions + reachable + refresh returns `NoNewUtxos` cleanly). We never send
   real BTC during automated tests, so a real mint confirmation is not forceable — that's the honesty
   line (the credited path is proven offline, see §2/step 3).
5. **Fix every gap the swarm finds**, iterate until the verification swarm reports no issues.

> Safety: all mainnet calls are read-only or use throwaway identities + demo-scale amounts. No real
> BTC is moved in verification (we never send BTC to the address during automated tests).

---

## 5. UX review process (no mocks — start the real app)
- Spin the web build (`just e2e --serve` leaves it running) under chrome-cli; drive as a **new** then
  **returning** user. Capture screenshots → `zai-vision` for inconsistency analysis.
- Checklist per global rules: obvious how to address user needs? fewest clicks for common ops?
  keyboard shortcuts intuitive + indicated? any spinner > a few seconds = bug? any AI slop/stubs?
- Findings → `OPEN_ISSUES.md` → fix → re-verify. Codify every fixed flow as an e2e test.

---

## 6. Workstream / waves (subagent orchestration)

Each wave is delegated to implementer subagents with a tight spec + verify command; the orchestrator
(this agent) reviews diffs and runs the cross-cutting gate. Subagents may spawn more subagents.

**Wave P — plan review (fresh eyes).** ✅ Done; amendments folded into §2/§4/§6.

**Wave W + V1 (PARALLEL — independent; start together).**
- **W1 `e2e/` scaffold:** vite (copy `ui/vite.config.js`) + react-native-web entry importing real
  `app/App.tsx`; `shims.ts` (incl. svg + qrcode + ed25519 + camera + nfc seams); **Rust↔JS signing
  cross-validation** (generate `wire_layout.json` from `dpay-fixture`, golden bytes assert); CDP driver;
  relay spawner (`--features test-helpers` for local); `local`/`live` modes; **deposit-seed
  `test-helpers` route** on `dpay-relay`. Verify: `just e2e` renders wallet + onboards; cross-val green.
- **V1 production wiring (independent of W):** rebuild + redeploy relay image (assert it carries the
  deposit routes — image-fidelity check); `register_minter(1, ckBTC)` on live canister; curl-gate
  `/deposit/*` returns 200. (KYC-allowlist flagged as human blocker — see §4.3.)

**Wave U-deposit (after W; BEFORE E1 — shapes the DOM E1 asserts on).**
- DepositSheet polish (§3.1): "Add money" primary affordance, complete instructions (network/asset/
  est-time/fee/min/non-custody line), single linear progress cue, manual "Check now", clipboard copy.
- Web deposit route `?screen=deposit`. **Keyboard-shortcut surface (flow 14, review amendment #7):
  build here, then test** — add intuitive keys (e.g. `T` top-up, `R` request, enter-to-confirm) with
  on-screen hints. Re-run the web build.

**Wave E — e2e flows (after W + U-deposit; parallelize by family).**
- E1 money-in: faucet (02) + **deposit 03/04/05** (seed via `test-helpers` route).
- E2 pay/receive: 06/07/08 + double-spend 09 + expired 10 (signing gated by the W cross-validation).
- E3 platform: NFC 11, settings 12, offline 13, keyboard 14 (now built in U-deposit).
Each: RED test first → GREEN → commit. Migrate golden shots to real-app states; **delete `ui/src/*`**.

**Wave U — UX (after E, in parallel with V).** Deposit-sheet polish (§3.1), web deposit route (§3.2),
keyboard shortcuts, copy/clipboard. Re-run affected e2e.

**Wave V — production verification (after W; independent).**
- V1 redeploy relay + register minter; curl-gate the deposit routes live.
- V2 run `just e2e-live` 03–05; fix gaps; iterate to green.

**Wave D — docs/issues (parallel).** `OPEN_ISSUES.md` (seeded from §0 findings), update
`CODEBASE_ANALYSIS.md` (new e2e surface, resolved prod gap), `AGENTS.md` link, refresh `TASKS.md`.

**Verification swarm (final).** Independent verifier subagents: run `just verify` + `just e2e` +
`just e2e-live`; UX-review the live app; report issues. Iterate until clean.

---

## 7. Open issues (seed; authoritative copy in `OPEN_ISSUES.md`)
- 🔴 Live relay stale: deposit routes 404 → fixed by Wave V.
- 🟠 Minter registration + KYC-allowlist on mainnet → Wave V.
- 🟡 `ui/src/*` parallel components to be removed once e2e real-app screenshots land → Wave E.
- 🟡 No keyboard-shortcut surface in the app yet → Wave U.
- (carryover from CODEBASE_ANALYSIS) canister controller governance, signed receipt, icrc3 reconcile —
  out of scope this session, remain listed there.

---

## 8. Dev-loop / debuggability rules (enforced in all waves)
- Every I/O (fetch, relay spawn, CDP, dfx call) has a timeout.
- No silent errors: `match`/try-catch logs status + body + context.
- Constants single-sourced (e.g. `DEPOSIT_CURRENCY`, `EXPIRY_WINDOW`) — referenced by name elsewhere.
- e2e mocks only at: canister I/O (FakeLedger), camera scan (inject), NFC (existing seam), clipboard.
- TDD: RED test reproducing the issue, then GREEN, test stays to prevent regression.
