# 2026-08-08 — tech-debt sweep + deeplink scheme

> Execution plan for the **NEXT SESSION work order (2026-08-08)** in `OPEN_ISSUES.md` (lines 11-70).
> Baseline at session start: `7856b69` (clean tree, 7 ahead of origin/main). Gates green:
> test-core 45/45, typecheck 0, bridge-parity OK (28 methods). Other gates per prior summaries.

The founder's instruction is: **finish the documented work order first**, TDD (RED-first where
applicable), commit each unit, run the relevant gate per change, keep `OPEN_ISSUES.md` +
`CODEBASE_ANALYSIS.md` current as items land. No new features beyond item 6. Wire is **mutable**
(founder correction 2026-08-07) — wire-format changes are on the table but must stay byte-exact
across `dpay-core` (Rust) ↔ `app/payments.ts` (TS mirror) ↔ `dfx/wire_layout.json` (e2e fixture) ↔
the e2e shim.

## Work items (in execution order)

### Wave 1 — parallel (distinct files)

#### Item 3 — `RECEIPT_CLAIM_LEN` single-source (correctness, SMALL) → subagent
- `dpay-fixture main.rs:522` already emits `receipt.fixed_len = RECEIPT_CLAIM_LEN` (the Rust named
  sum at `dpay-core/src/lib.rs:123`); `dfx/wire_layout.json` carries `receipt.fixed_len = 108` and
  the e2e shim `e2e/web/dpay-core.ts` already asserts `== 108`.
- **Gap:** `app/payments.ts:142` re-derives 108 as the magic sum `16 + 32 + 32 + 8 + 4 + 8 + 8`.
  A receipt-field resize now drifts silently between Rust and the prod TS (the prod app does NOT
  import the JSON; only the e2e shim does).
- **Fix (minimal, safe):** add a jest test that imports the wire-layout JSON and asserts
  `payments.RECEIPT_CLAIM_LEN === json.receipt.fixed_len` and that the per-field byte layout
  (`NONCE_LEN+PUBKEY_LEN+...`) matches the JSON offsets. RED if it drifts; green today. This makes
  the JSON the single source for the *value* while payments.ts keeps the *byte layout* (which it
  needs for `receiptClaimBytes()`).
- **Stretch (only if clean):** have a build/codegen step emit a `app/lib/wire.ts` from the JSON so
  payments.ts reads a symbol — but weigh the bundle/CI cost vs a jest assertion. **Lean toward the
  test unless the founder objects.**
- Gates: `just typecheck`, jest (`just test-jest` if it exists, else `node e2e/...` jest runner),
  `just test-core`. Commit unit.

#### Item 1 — NFC component merge (DRY, MEDIUM) → subagent
- Extract `useNfcTapState({ ...adapters })` hook + shared `<NfcTapView>` shell from
  `app/components/NfcTap.tsx` (338L) + `SolNfcTap.tsx` (239L). ~80% identical: 9-phase
  `NFC_UI`/`SOL_NFC_UI` records, lifecycle (`finalize`/`clearSettleTimer`/`markActive`/`aliveRef`/
  `committed`), the `useEffect` subscribe→arm→cleanup, terminal render JSX (differs only in
  `testID`).
- **Adapters MUST keep the protocol boundary:** IC = `signAuthorization` + relay `/pay` +
  nonce-reconcile + optimistic deduction; SOL = `signOfflineSolPayment` + RPC broadcast +
  npub-match + nextNonce adoption.
- **e2e seam names differ** (`DpayNfcEvent`/`__DPAY_TEST_NFC_SESSION` vs `DpaySolNfcEvent`/
  `__DPAY_TEST_SOL_NFC_SESSION`) and native modules differ (`DpayNfc` vs `DpaySolNfc`) — these are
  *correct* and must stay distinct.
- Device-gated money-moving UI: run `just app` (assert `DPAY_SELFCHECK PASS`) + `just ondevice`
  after. `just e2e` must stay 49/49 (flows 11 IC + 47 SOL). ~150 lines removed.
- Gates: `just typecheck`, `just e2e`, then the device gate. Re-seed visual baselines if the merged
  view changes pixels (flow 40). Commit unit.

#### Item 5 — WithdrawSheet confirm-step (verify-or-improve) → self
- `app/components/WithdrawSheet.tsx` ALREADY has the inline review card (`withdraw-review` lines
  183-189) + a disabled-until-valid `btn-withdraw-confirm` (lines 193-202) with live validation
  (below-min/over-balance/bad-addr). **Hypothesis: this is sufficient.**
- **Verify** by reading the component + the e2e flows that cover withdraw (look up in `FLOWS.md`).
  If sufficient, document the verdict (no change) in `OPEN_ISSUES.md`. If a separate explicit
  two-step review genuinely reads better, weigh extra tap + e2e-flow churn. Default: **keep as-is**.

### Wave 2 — sequential (deploy + catalog share script files)

#### Item 4 — Deploy-script consolidation (DRY, LOW-MEDIUM, ops-only) → subagent
- Extract `deploy/dfx-lib.sh` (alongside `deploy/env-lib.sh`) holding the shared scaffolding:
  `CARGO_HOME`/`RUSTUP_HOME`/`PATH` export block, `nat()` candid-extract helper, `load_identity` +
  `dfx_i` wrappers, `candid-extractor` guard, wasm build, `jq` merge into `canister_ids.json`,
  `register_currency` idempotency.
- `scripts/dfx-deploy.sh` (152L), `dfx-deploy-ic.sh` (198L), `dfx-deploy-ic-staging.sh` (369L)
  become thin target-specific callers (source the lib, set target vars, call shared funcs).
- **Not shipped code.** Verify by `bash -n` (syntax) on each rewritten script + a smoke read of the
  call graph. Cannot run a real deploy offline; record this. Commit unit.

#### Item 2 — Currency catalog single-source (DRY/anti-pattern, MEDIUM) → subagent
- ckUSDC ERC-20 contract `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, ckETH gas-ledger principal
  `ss2fx-dyaaa-aaaar-qacoq-cai`, ckBTC minter principal, decimals (8/6/18) hardcoded in ≥3 places:
  `app/config/catalog.ts` (`BUNDLED_CATALOG` cold-load fallback), `crates/dpay-relay/src/ledger.rs`
  (`fake_catalog`), deploy scripts.
- **Minimum bar:** `fake_catalog()` references the same Rust consts it already defines (today some
  fields re-stringify literals). `test-relay` stays green.
- **Ideal:** one generator (a `just`-managed codegen or a `config/catalog.json` + small build step
  per target) emits the app fallback + relay fake_catalog + deploy literals from one source. App
  fallback MUST stay in the bundle (offline render path) — goal is **one generator, not deletion**.
- **Trade-off:** a JSON+codegen step adds CI surface; weigh against the drift risk. If the founder
  hasn't asked for codegen, the **minimum bar (Rust consts as the single source, app fallback
  duplicated-but-cross-checked by a jest assertion)** is the safe default. Decide in the subagent
  and flag if it exceeds the minimum.
- Gates: `just test-relay`, `just typecheck`, jest. Commit unit.

### Item 6 — Deeplink scheme (FEATURE — design first, then build) → self + subagent
- **Design note (this doc, below) FIRST**, then implement incrementally. HIGH effort → split if it
  blows past a medium session budget.
- Build order: (a) URI codec pure helper + jest tests (RED-first), (b) App.tsx routing, (c)
  AndroidManifest intent-filter, (d) optionally receipt hand-back `dpay:pay:...`.

**✅ DONE (2026-08-08).** (a) pure codec + 16 jest cases (`app/lib/deepLink.ts`); (b) routing in
`Wallet.tsx` (native `Linking.getInitialURL`/`addEventListener('url')`, 2s-timeout-bounded) + the web
`?req=` mirror (`readRequestDeeplink`) → `prefillRequest` state → `PayMode` prefill effect reusing the
camera-scan decode path; ReceiveMode's "Share request link" (`btn-share-request`); (c) AndroidManifest
`dpay`-scheme intent-filter on MainActivity; e2e flow 49 (reload to `?req=<blob>` — asserts review
prefill + no auto-approve + full settle). **SECURITY: a deeplink ONLY prefills review — never signs.**
(d) **DEFERRED** — `dpay:pay/<blob>` is codec-only (`decodeDeeplink` + `readPaymentDeeplink`); the
merchant-side verify/reconcile wiring is a follow-up (spec the reconcile path first). Commits
`1bf4045` → `811dbe6`. Device gate PENDING (`just app` + `just ondevice`). See OPEN_ISSUES item 6.

## Deeplink design (item 6)

### Goal
A merchant's Request QR (`ReceiveMode.tsx:152`) currently encodes a raw base64url blob — not a
URI — so it cannot be shared as a link. We want a `dpay:` scheme so a request sent over a messaging
app opens on the payer's phone and pre-populates the pay screen ("remote send-me-money"), and so a
signed payment receipt can be handed back over the same channel when NFC is unavailable.

### URI shape (proposed)
```
dpay:req/<base64url-request-blob>           # request for payment (merchant → payer)
dpay:pay/<base64url-receipt-blob>           # signed payment receipt (payer → merchant, NFC-less hand-back)
```
- `base64url` (no padding) of the EXISTING binary blob the QR already carries — **no new codec, no
  new wire format.** This keeps the wire-layout single source of truth and lets the QR and the
  deeplink share one encode/decode path.
- Path-not-query (`/` not `?`) keeps the blob opaque to URL-parsing libs (no `+`/`%` mangling) and
  matches how the QR path already treats it.
- Version prefix lives INSIDE the blob (the wire already has a version byte), so the URI itself
  needs no `?v=1`. If we ever break the blob codec, add `dpay2:` rather than a query param.

### Payer app receive path
1. Android: `<intent-filter>` for `android:scheme="dpay"` in `AndroidManifest.xml` (single activity
   = `MainActivity`, `VIEW` action, BROWSABLE category). The intent extras carry the URI; RN's
   `Linking.getInitialURL()` / `Linking.addEventListener('url')` surfaces it.
2. iOS: not in scope for this repo (Android-only target per AGENTS.md). Document as a TODO.
3. Web: `globalThis.location` — extend `app/lib/deepLink.ts` (already has
   `readDepositDeepLink()` reading `?screen=deposit`) with a `readDpayDeeplink()` that returns the
   parsed `{kind:'req'|'pay', blob}`. Web handler routes `req` → pre-fill pay sheet, `pay` → verify
   receipt.

### Routing in `App.tsx`
- On mount + on `url` events, call `readDpayDeeplink()`. For `req`: decode blob, validate it is a
  well-formed request (reuse `payments.ts` pure parse), set a `pendingRequest` state, open the pay
  sheet pre-filled with merchant + amount + currency. For `pay`: decode receipt, verify signature
  (reuse `services/receipt.ts`), mark the merchant's request settled.
- **No mocks in prod code.** The codec is pure and jest-tested; the parsing reuses the existing
  pure settlement logic.

### Receipt hand-back (stretch)
- `dpay:pay/<blob>` for NFC-less receipt hand-back. Reuses the SAME signed-receipt bytes the NFC
  path already produces (`receiptClaimBytes()` + sig). Merchant app verifies + reconciles. This
  closes the loop for devices without NFC or when tap fails. **Only build if (a)-(c) land cleanly
  and the founder wants it this session; otherwise defer to a follow-up.**
- **STATUS: DEFERRED (2026-08-08).** (a)-(c) landed cleanly (see above). The `dpay:pay/` codec is in
  place (`decodeDeeplink` parses it; `readPaymentDeeplink` reads `?pay=` on web), but the merchant-
  side verify/reconcile wiring is deferred — it needs a spec for how a merchant app consumes a
  receipt handed back over a messaging channel (where the NFC path's `confirmReceipt`/reconcile is
  not applicable). Tracked in OPEN_ISSUES as a follow-up.

### Test plan (TDD)
- RED: jest test asserting `decodeRequest(encodeRequest(req)) deep-equal req` and that a tampered
  byte round-trips to a decode error. Test the `App.tsx` routing with the e2e seam (`?dpay=...` on
  web) — add an e2e flow that simulates opening `dpay:req/...` and asserts the pay sheet pre-fills.
- The e2e flow goes in `e2e/tests/NN-name.mjs` with a `meta` export; regenerate `FLOWS.md`.
- **STATUS: DONE (2026-08-08).** jest `app/__tests__/deeplink.test.ts` (16 cases: round-trip both
  kinds, null for non-dpay/garbage/empty-blob/unknown-kind/missing-slash, base64url `-`/`_`
  preserved, scheme case-sensitivity). e2e `e2e/tests/49-deeplink-request.mjs`: reloads the browser
  to `?relay=&req=<blob>` (the REAL web `?req=` path — no test-only prod seam), asserts the review
  screen pre-fills with the merchant request (no auto-approve) then the full Approve→settle. Chose
  reload-over-seam: zero test-only prod code + flow 12 proves reload+remount is reliable. FLOWS.md
  regenerated (50 flows).

### Confidence / safety
- URI codec + parsing: confidence **9/10** (pure, testable, reuses existing wire). Safety **9/10**.
  **✅ DELIVERED** (jest 16 cases + e2e flow 49).
- Android intent-filter: confidence **7/10** (standard pattern, but device-gated — must run `just
  app` + `just ondevice`). Safety **8/10**. **✅ DELIVERED (intent-filter added); device gate PENDING.**
- Receipt hand-back: confidence **6/10** until the merchant-side reconcile path is specced. Defer
  if uncertain. **⏸️ DEFERRED** (codec only).

## Session-end checklist
- [ ] Each item committed as its own unit.
- [ ] `OPEN_ISSUES.md` work-order section struck/updated per item; `CODEBASE_ANALYSIS.md` risks
      struck where resolved, added where new surfaces appear.
- [ ] `just verify` green (or individual gates documented if `just check` times out on PocketIC).
- [ ] Device gate run for any money-moving UI change (item 1).
- [ ] `FLOWS.md` regenerated if any e2e flow added (item 6).
- [ ] Next-session work order written at the top of `OPEN_ISSUES.md` for anything genuinely
      remaining (e.g. item 6 receipt hand-back if deferred, or any fork needing founder input).
