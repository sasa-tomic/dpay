# 2026-08-10 Code Review Findings

> Research-only review (HEAD `af6ac8f`, clean tree). No code was changed. Covers: recent commits
> (dead/half-wired code), code quality (silent errors, DRY, dead code, timeouts, large files),
> e2e coverage gaps, and UX quick-wins from code. Sorted by value descending; only value ≥ 4 included.

---

## Top findings by value

### [1] Silent network errors in poll/reconcile loops — 8+ sites with `} catch {` and NO logging
- **Area:** code-quality
- **What:** The repo rule is "NO SILENT ERRORS — every error path must log enough to debug (error
  code + relevant state)." Eight network-fetch catch blocks in poll/retry loops swallow errors with
  zero logging. If a relay returns 500s, times out, or the JSON body is malformed, the developer has
  no diagnostic trace:
  - `app/hooks/useBalancePoll.ts:155` — `} catch { if (fresh()) setOnline(false); }` — the batch
    balance fetch fails (timeout, network, CORS) and the error is discarded entirely.
  - `app/components/PayMode.tsx:104` — `} catch { /* best-effort: keep polling */ }` — receipt
    reconcile poll error discarded.
  - `app/components/ReceiveMode.tsx:114` — `} catch { /* best-effort: keep polling */ }` — the
    settlement receipt poll error discarded.
  - `app/components/ReceiveMode.tsx:183` — `} catch { /* network/timeout */ }` — the merchant's
    `payAndClassify` fetch error discarded (the body's error reason is lost).
  - `app/components/NfcTap.tsx:76` — `} catch { /* keep polling */ }` — NFC receipt reconcile poll.
  - `app/components/CkErc20DepositSheet.tsx:312` — `} catch { /* keep watching */ }` — the ckERC20
    balance-growth poll error discarded.
  - `app/components/Onboarding.tsx:33` — `} catch { setPendingId(id); setBusy(false); }` — the
    faucet fetch failure (timeout/offline/5xx) discarded with no log.
  - `app/components/Wallet.tsx:137` — `} catch { if (alive) setNfc('unknown'); }` — NFC status read
    failure discarded.
- **Why it matters:** These are the #1 "why is this not working?" debugging blind spots. A relay
  returning persistent 500s during reconciliation, a CORS misconfiguration, or a DNS failure would
  be completely invisible in logs. The user sees a spinner or "Offline" with no server-side or
  client-side trace. The comments explain *why* the poll continues, but the rule says *log the
  error*, not just continue.
- **Fix:** Add `console.warn('context:', e)` (or `e instanceof Error ? e.message : String(e)`) to
  each catch. The poll continues; the error is now visible in logcat/devtools. One-liner per site.
- **value:** 8  **effort:** S  **confidence:** 10

---

### [2] merchant.html has a completely empty `} catch {}` — zero logging, zero comment
- **Area:** code-quality
- **What:** `crates/dpay-relay/assets/merchant.html:181` — the merchant terminal's receipt poll
  catches ALL errors with a completely empty body (`} catch {}`), no comment, no logging:
  ```js
  try {
    const r=await fetchWithTimeout('/api/v1/receipt/'+currentNonce, {}, 5000);
    if(r.ok){ const j=await r.json(); handleSettled(j); }
  } catch {}
  ```
- **Why it matters:** The merchant terminal is the user-facing settlement confirmation screen. If
  the poll fails (relay crash, 5xx, malformed JSON, DNS), the merchant never sees "Paid ✓" and has
  zero diagnostic information — the poll just silently retries every 1.2s. A persistent relay error
  = a permanent "waiting" state with no clue why. This is strictly worse than the app-side catches
  (which at least have comments); this one has nothing.
- **Fix:** Add `console.error('receipt poll failed:', e);` inside the catch. The poll continues.
- **value:** 7  **effort:** S  **confidence:** 10

---

### [3] SOL NFC tap error/decline/pending paths have ZERO e2e coverage
- **Area:** e2e-gap
- **What:** Flow 60 (`60-nfc-error.mjs`) covers the IC NFC rail's error/declined/pending-ignored
  phases. The SOL NFC rail (`app/components/SolNfcTap.tsx`) has equivalent error paths —
  `declined` at lines 54, 60, 85, 97; `pending` at lines 100, 106; the catch-all at 102-106 — but
  NO e2e flow exercises them. Flow 47 (`sol-nfc`) only covers the happy path (request → autoSign →
  broadcast-stub → receipt → adopt nonce → Paid ✓).
- **Why it matters:** The SOL NFC adapter's error handling is structurally different from IC (it
  has `npubRef` binding, `solpayMatchesReq`, `onStale`, and a catch-all that hands
  `RECEIPT_UNREACHABLE`). A regression in any of these (e.g. a `decideSolPayerReceipt` classification
  bug, a missing `confirmSolReceipt` call, or the catch-all `onStale` not firing) would sail through
  `just verify` with 62/62 green. This is the exact class of bug flow 60 catches for IC.
- **Fix:** Add flow `62-sol-nfc-error.mjs` mirroring flow 60's structure: inject a SOL NFC transport
  error mid-tap → assert "Tap failed" (not Paid); inject a `RECEIPT_REJECTED` → assert "Declined" +
  `onStale` fires; inject a late error after settle → assert ignored. Uses the
  `__DPAY_TEST_SOL_NFC_SESSION` seam.
- **value:** 7  **effort:** M  **confidence:** 9

---

### [4] DpayCore.encodeQr error silently swallowed — native-module error reason lost
- **Area:** code-quality
- **What:** `app/components/NfcTap.tsx:88`:
  ```ts
  const code = await DpayCore.encodeQr(wireHex).catch(() => null);
  if (!code) { ctx.finalize('error', 'Could not encode the authorization'); return; }
  ```
  The `.catch(() => null)` discards the actual error from the FFI/native module. The user sees
  "Could not encode the authorization" but the real reason (a wire format mismatch, a serialization
  error, a bridge arity regression) is permanently lost.
- **Why it matters:** This is the exact class of device-blind-spot bug (AGENTS.md blind-spot 3:
  wire/bridge arity). An FFI throw here could be a wire-format regression, and the developer would
  see only "Could not encode" with no stack trace or error code. Per the repo rule the error must be
  logged.
- **Fix:** `DpayCore.encodeQr(wireHex).catch((e: unknown) => { console.warn('encodeQr failed', e); return null; })`.
- **value:** 6  **effort:** S  **confidence:** 10

---

### [5] AsyncStorage operations silently swallow errors — 10+ sites, zero logging
- **Area:** code-quality
- **What:** Every AsyncStorage read/write in three persistence modules catches errors with empty
  bodies:
  - `app/services/withdraw.ts:7` — `} catch { return null; }` (saved withdraw addr load)
  - `app/services/withdraw.ts:10` — `} catch { /* best-effort */ }` (saved withdraw addr save)
  - `app/services/solNoncePersist.ts:64,71,85,94` — load/save/remove nonce state (4 sites)
  - `app/services/ckerc20Persist.ts:58,65,82,91` — load/save/remove watching state (4 sites)
- **Why it matters:** AsyncStorage failures are rare but indicate a corrupted storage state or a
  disk-full condition. If `saveSolNonce` silently fails, the payer's durable-nonce state is lost on
  restart → offline-pay breaks with no trace. If `saveWithdrawAddr` fails, the "Use last" chip
  disappears with no explanation. Per the repo rule, these should `console.warn` the error.
- **Fix:** Add `console.warn` to each catch (one-liner each). The graceful fallback (return null /
  continue) is preserved.
- **value:** 5  **effort:** S  **confidence:** 10

---

### [6] Dead exports: `padName32` / `trimName32` — zero production callers
- **Area:** code-quality / dead-code
- **What:** `app/lib/format.ts:84` (`padName32`) and `app/lib/format.ts:97` (`trimName32`) are
  exported but have ZERO production callers. The name padding is done internally by the Rust core
  (`DpayCore.encodeRequest` / `DpayCore.signAuthorization` via FFI). These TS mirrors exist only in
  `__tests__/format.test.ts` (20 test cases). Verified: `grep -rn "padName32\|trimName32"` across all
  non-test `.ts`/`.tsx` returns zero matches outside the definition.
- **Why it matters:** YAGNI — these are dead production code. A future developer might mistakenly
  think the TS layer does the padding and introduce a divergent implementation. The test-only
  nature should be explicit (or the functions deleted, with the tests removed or moved to test the
  FFI path). The `just typecheck` `--noUnusedLocals` gate does NOT catch unused *exports* (only
  unused locals), so this sailed through.
- **Fix:** Either (a) delete `padName32`/`trimName32` + their tests (the Rust core is the source of
  truth, tested via FFI roundtrip), or (b) mark them `/** @internal */` and move to a test-only
  helper file. Option (a) is cleaner.
- **value:** 5  **effort:** S  **confidence:** 9

---

### [7] SOL USDC toggle offered but offline-pay is non-functional without pre-existing ATAs (F4 deferred, no gate)
- **Area:** e2e-gap / ux
- **What:** `app/components/SolReceiveMode.tsx:264` offers a SOL ↔ USDC toggle in the merchant
  request form, and `SolPayMode.tsx:139-141` signs USDC offline payments. But per OPEN_ISSUES.md
  item F4 (DEFERRED), USDC offline-pay requires a pre-existing source Associated Token Account
  (ATA) — without it, the broadcast fails with a confusing on-chain error. The toggle is ungated
  (no ATA-existence check before offering USDC). No e2e flow tests the USDC toggle at all.
- **Why it matters:** A merchant who toggles to USDC creates a `solreq:` that a payer signs, then
  the broadcast fails with a raw Solana "account not found" error. The payer has a useless signed
  QR and no explanation. This is the same class of "raw RPC error to the user" bug that was fixed
  for SOL (commit `30045a8`, `friendlySolError`), but the USDC-specific ATA-existence gate was
  deferred (F4).
- **Fix:** (a) Add an ATA-existence check (`getAccountInfo` on the source ATA) before offering the
  USDC toggle, failing closed with "Set up USDC first" if absent. (b) Add e2e flow `63-sol-usdc-toggle`
  that exercises the toggle switching (even if the full USDC flow needs the stub to pre-fund an ATA).
  The gate is the higher-value half; the test is secondary.
- **value:** 5  **effort:** M  **confidence:** 8

---

### [8] SOL setup-nonce failure + resync paths have no e2e test
- **Area:** e2e-gap
- **What:** `app/components/SolPayMode.tsx` has two error-path surfaces with ZERO coverage:
  - **Setup failure** (line 107-108): `createNonceAccount` can fail (insufficient SOL, RPC error,
    devnet-pool lag). The `sol-pay-setup-err` testID surfaces `friendlySolError`, but no flow tests
    it. A regression in the error mapping would be invisible.
  - **Resync** (line 156-172): `btn-sol-pay-resync` is wired for the stale-nonce recovery path, but
    no flow drives the stale → resync → ready cycle.
- **Why it matters:** The setup-failure path is the first SOL experience for an unfunded user (the
  exact bug the founder hit — commit `30045a8`). Without an e2e test, a regression in
  `friendlySolError` for the no-credit case (F6) would sail through. The resync path is the only
  recovery from a rejected broadcast — a regression there = a dead-end with no escape.
- **Fix:** Add flow `64-sol-setup-error.mjs`: inject a rejecting RPC stub (no-credit error) →
  assert `sol-pay-setup-err` shows the friendly message (not raw RPC). Optionally add
  `65-sol-resync.mjs`: inject a stale-nonce state → assert `btn-sol-pay-resync` renders → inject a
  success stub → assert nonce state flips to ready.
- **value:** 5  **effort:** M  **confidence:** 8

---

### [9] nfc.rs at 1749 lines — split candidate (grew past the 2000-bar threshold after the SOL NFC additions)
- **Area:** code-quality / large-files
- **What:** `crates/dpay-core/src/nfc.rs` is 1749 lines (was ~1663 per CODEBASE_ANALYSIS.md; grew
  with receipt/SOL additions). It contains three distinct concerns: (1) APDU codec + chunking/
  reassembly (pure byte-shuffling), (2) `CardSession` (payer/HCE state machine), (3)
  `ReaderConductor` (merchant state machine). The canister was split at this threshold
  (`lib.rs` 2145 → 1547 + `proxy.rs` 655); `nfc.rs` is approaching the same bar.
- **Why it matters:** A single 1749-line file with three logically independent concerns makes
  targeted changes harder (a codec change scrolls past two state machines). The codec is pure and
  independently proptestable; the two state machines share only the `SessionPhase` enum + the
  `phase()` accessor. Not urgent, but the canister precedent (M7 split) shows the pattern is
  established.
- **Fix:** Extract `nfc/codec.rs` (APDU codec + chunking) from the two state machines when the file
  next needs a material change. Keep `CardSession` + `ReaderConductor` together (they share the
  phase enum). No behavioral change; proptest suite proves byte-identical output.
- **value:** 4  **effort:** M  **confidence:** 7

---

### [10] ledger.rs at 1600 lines — split candidate (FakeLedger + trait + catalog + onramp helpers)
- **Area:** code-quality / large-files
- **What:** `crates/dpay-relay/src/ledger.rs` is 1600 lines. It contains: (1) the `Ledger` trait +
  `LedgerError` types, (2) `FakeLedger` (the test/demo implementation), (3) catalog types +
  `fake_catalog()`, (4) onramp helpers (`ckerc20_onramp_from_descriptor` + chain_id logic + tests),
  (5) catalog truth drift tests. The canister was split along similar seams (`types.rs` + `calls.rs`
  + `proxy.rs` + `lib.rs`); the relay has only `app.rs` + `ledger.rs` + `agent_ledger.rs`.
- **Why it matters:** `ledger.rs` mixes the abstract `Ledger` trait (the interface every consumer
  depends on) with the `FakeLedger` implementation (test/demo-only) and catalog metadata logic. A
  change to the onramp chain_id dispatch requires scrolling past the trait definition. Splitting
  `Ledger` trait + types into `ledger.rs`, `FakeLedger` into `fake_ledger.rs` (cfg-gated or always-
  compiled), and catalog/onramp into `catalog.rs` would mirror the canister's structure.
- **Fix:** Extract `fake_ledger.rs` (FakeLedger + fake_catalog) and `catalog.rs` (CurrencyDescriptor
  + onramp helpers + drift tests) from `ledger.rs`. Keep the `Ledger` trait + `LedgerError` in
  `ledger.rs`. The agent_ledger.rs consumer is unaffected (imports the trait).
- **value:** 4  **effort:** M  **confidence:** 7

---

### [11] D3 "balance" header label appears RESOLVED in code but still listed as DEFERRED in OPEN_ISSUES.md
- **Area:** code-quality / doc-drift
- **What:** OPEN_ISSUES.md lines 107-114 list finding D3 ("Header 'balance' label is generic") as
  DEFERRED with confidence 6/10. But `app/components/Wallet.tsx:359` now renders:
  ```tsx
  <Text style={S.balLabel}>{online ? `${activeAssetName} balance` : `~ ${activeAssetName} approx.`}</Text>
  ```
  where `activeAssetName` resolves to 'DEMO', 'SOL', or `displayName(currentDesc)` (BTC/USDC/ETH).
  The comment at line 355 explicitly says "D3: the header label names the active asset in BOTH
  branches." So D3 appears to have been resolved in commit `af6ac8f` (the most recent commit), but
  OPEN_ISSUES.md was not updated to mark it DONE.
- **Why it matters:** Stale issue tracking. A future session reading OPEN_ISSUES.md would re-derive
  or re-attempt D3, wasting effort on already-shipped work. The AGENTS.md rule: "If anything here
  stops matching the code, the doc is wrong — fix the doc."
- **Fix:** Strike D3 in OPEN_ISSUES.md (mark DONE, reference commit `af6ac8f`), matching the D1/D2/D5
  pattern already there.
- **value:** 4  **effort:** S  **confidence:** 9

---

### [12] SOL receive-address clipboard copy untested (flow 04 covers IC only)
- **Area:** e2e-gap
- **What:** `app/components/SolanaReceiveSheet.tsx` has a copy-address affordance (mirrors the IC
  `DepositSheet` clipboard copy). Flow 04 (`04-deposit-copy.mjs`) proves the IC deposit address
  reaches the real clipboard via `window.__DPAY_TEST_CLIPBOARD`. The SOL receive-address copy has
  no equivalent test — a regression in the SOL copy path (wrong testID, missing clipboard write)
  would be invisible.
- **Why it matters:** The copy-address function is the primary way a SOL user shares their deposit
  address off-app (messaging, email). A silent regression here = a dead "Copy" button. The IC path
  is pinned; the SOL path should be too (uniform-coverage principle from CLAUDE.md).
- **Fix:** Add a SOL clipboard assertion to flow 45 (`45-sol-receive.mjs`) — after rendering the SOL
  receive address, tap the copy button and assert `window.__DPAY_TEST_CLIPBOARD` matches the
  derived address. One assertion, not a new flow.
- **value:** 4  **effort:** S  **confidence:** 8

---

### [13] Stale comment: Wallet.tsx hotkey comment says "T=Receive" but T=top-up (demo money)
- **Area:** code-quality / doc-drift
- **What:** `app/components/Wallet.tsx:304-305`:
  ```ts
  // Web keyboard shortcuts (plan 1b / UX-V5): the first letters of the main actions —
  // P=Pay, R=Receive, T=Receive (demo money), A=Balances (the asset hub), L=Ledger (transactions).
  ```
  The comment says "T=Receive (demo money)" but T is actually Top-up (the faucet call to add demo
  ∂100). The line below it correctly maps `t: topUp`. This is a copy-paste error from a prior
  iteration (T was once mapped differently).
- **Why it matters:** A developer reading the comment would be confused ("T=Receive? but the code
  says topUp"). Low impact but a code-hygiene nit.
- **Fix:** Change the comment to "T=Top-up (demo money)".
- **value:** 4  **effort:** S  **confidence:** 10

---

## Summary

| # | Title | Area | Value | Effort | Conf |
|---|-------|------|-------|--------|------|
| 1 | Silent network errors in poll/reconcile loops (8+ sites) | code-quality | 8 | S | 10 |
| 2 | merchant.html completely empty `} catch {}` | code-quality | 7 | S | 10 |
| 3 | SOL NFC error/decline paths untested | e2e-gap | 7 | M | 9 |
| 4 | DpayCore.encodeQr error silently swallowed | code-quality | 6 | S | 10 |
| 5 | AsyncStorage operations silently swallow errors (10+ sites) | code-quality | 5 | S | 10 |
| 6 | Dead exports: padName32 / trimName32 | code-quality | 5 | S | 9 |
| 7 | SOL USDC toggle non-functional without ATAs (no gate) | e2e-gap/ux | 5 | M | 8 |
| 8 | SOL setup-nonce failure + resync untested | e2e-gap | 5 | M | 8 |
| 9 | nfc.rs 1749 lines — split candidate | code-quality | 4 | M | 7 |
| 10 | ledger.rs 1600 lines — split candidate | code-quality | 4 | M | 7 |
| 11 | D3 "balance" label resolved but OPEN_ISSUES says deferred | doc-drift | 4 | S | 9 |
| 12 | SOL receive-address clipboard copy untested | e2e-gap | 4 | S | 8 |
| 13 | Stale comment: "T=Receive" should be "T=Top-up" | doc-drift | 4 | S | 10 |

**Total: 13 findings.** All are research-only — no code was changed.

### What was checked and found clean
- **Recent commits (22 reviewed):** No dead/half-wired code found. The M7 proxy.rs extraction, M14
  base64 unification, M5 chain_id fail-closed, L5 BUNDLED_CATALOG ckETH, L4 share-receipt seam, and
  L7 timeout are all fully wired with zero orphaned exports. The `ckBtcCurrency` var is used (deep
  link), `SOL_ATA_CHECK_TIMEOUT_MS` is used, all catalog exports (`assetTestKey`,
  `testnetDisplayName`, `resolveNfcDisclosure`, etc.) have production callers.
- **DRY:** Wire consts are cross-validated by drift alarms (`catalog_truth.json` + jest + Rust).
  Base64 codecs unified (M14). `composeTimeout`/`withTimeout` consolidated. `hexToBytes`
  consolidated. No new DRY violations found beyond the known ops-only deploy-script literals.
- **Missing timeouts:** All `fetch()` calls go through `fetchWithTimeout` (10s backstop) or
  `withTimeout` (SOL). `solana/rpc.ts` has `DEFAULT_TIMEOUT_MS=8000`. The relay's
  `fetch_root_key` was the last unbounded I/O (fixed L7, commit `deec1da`). No missing timeouts
  found.
- **Silent errors:** The `verifyOutcomeReceipt`, `payAndClassify`, `broadcastSolPayment`,
  `readJsonOrEmpty` catches were all converted to `console.warn` in prior sweeps (commit `89005de`).
  The REMAINING violations are the poll/reconcile catches (findings 1, 2, 4, 5).
- **AI slop / TODOs:** Zero consumer-facing TODO/FIXME/stub/lorem in `app/` (confirmed by U6).
