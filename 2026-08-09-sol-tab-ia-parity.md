# 2026-08-09 — SOL tab-IA parity (close the per-currency exception)

> Parent: `2026-08-09-send-receive-tabs-refactor.md`. This is its follow-up (OPEN_ISSUES.md §"SOL parity in tab IA").
> Status: IN PROGRESS (2026-08-09). Scope: **app/ + e2e only.** NO wire / canister / relay / core.

## Why

CLAUDE.md HARD RULE (2026-08-09): every currency MUST use the SAME UI surfaces/flows. The 2026-08-09
Send/Receive tabs IA refactor moved IC on-chain deposit/withdraw into the Pay/Receive tab toggles
(`ModeToggle` sub-modes), but **left SOL's Balances per-row buttons** (`btn-sol-receive`/`btn-sol-send`)
as a "deliberate, temporary exception". A per-currency IA special case is a bug. This closes it: SOL
becomes byte-parallel to IC — pure whole-row select in Balances, and the deposit/send surfaces live in
the Pay/Receive tab sub-modes.

## Target IA (SOL === IC, exactly)

| Tab    | Toggle (always shown for SOL) | Left segment (default) | Right segment                |
|--------|-------------------------------|------------------------|------------------------------|
| Pay    | `pay-mode-toggle`             | `Scan to pay` → SolPayMode (offline dpay-to-dpay) | `Send to address` → SolanaWithdrawSheet body inline |
| Receive| `receive-mode-toggle`         | `Request payment` → SolReceiveMode (offline merchant) | `My address` → SolanaReceiveSheet body inline |

The `paySubMode`/`receiveSubMode` state already lives in `Wallet.tsx` (lines 58-59, shared IC/SOL).

## Reference: the IC pattern to mirror (already read, verified)

- `PayMode.tsx:306-330` — `subMode==='send' && withdrawFamily` → `<ModeToggle>` + `<WithdrawSheet inline onClose={() => onSubModeChange('scan')}>`. Toggle also rendered on the scan screen (line 338-346) when a family exists.
- `ReceiveMode.tsx:266-299` — `subMode==='address' && depositFamily` → `<ModeToggle>` + `<DepositSheet|CkErc20DepositSheet inline onClose={() => onSubModeChange('request')}>`. Toggle also on the request screen (line 303-311).
- `WithdrawSheet.tsx:206-222` / `DepositSheet.tsx:241+` — the `inline?` dual-mode idiom: build `body` JSX once, `if (inline) return <View style={S.sheetBody}>{body}</View>;` else wrap in `SheetOverlay/SafeAreaView/StatusBar/sheetHead/ScrollView`.
- `ModeToggle.tsx` — presentational joined pill toggle (left/right segments, testIDs, a11y).

## Change set (ordered for TDD)

### Phase 0 — RED: re-route the 2 e2e flows first (will fail against current code)
1. **`e2e/tests/45-sol-receive.mjs`**: `Balances → btn-sol-receive → sheet` ⟹ `Balances → asset-sol-select → Receive tab → btn-receive-address ("My address") → sol-receive-address (inline)`. Drop the `btn-sol-receive-close` close step (inline has no overlay ✕; use tab/toggle back). Drop the "Send button absent" assertion (btn-sol-send no longer exists anywhere) OR replace with asserting the Pay→"Send to address" toggle exists. Keep the address base58 + copy-control assertions. Update the header comment.
2. **`e2e/tests/52-sol-withdraw.mjs`**: `Balances → btn-sol-send → SolanaWithdrawSheet` ⟹ `Balances → asset-sol-select → Pay tab → btn-pay-send ("Send to address") → sol-send-address-input (inline)`. Rest (enter addr+amt → review → confirm → Sent ✓ + signature) unchanged. Update header comment.

### Phase 1 — SOL parity (mirror IC dual-mode for the SOL sheets)
3. **`app/components/SolanaReceiveSheet.tsx`**: add `inline?: boolean` prop; refactor to the dual-mode idiom (body once; `if (inline) return <View style={S.sheetBody}>{body}</View>`; else current `SheetOverlay` wrapper). Keep all existing testIDs in the body (`sol-receive-address`, `btn-sol-receive-copy`, `sol-receive-instructions`, `sol-devnet-warning`). The overlay close button `btn-sol-receive-close` stays in the overlay branch (still used until Phase 2).
4. **`app/components/SolanaWithdrawSheet.tsx`**: same dual-mode refactor (`inline?: boolean`). Keep body testIDs (`sol-send-address-input`, `sol-send-amount-input`, `sol-send-review`, `sol-send-review-amount`, `btn-sol-send-confirm`, `sol-send-status`, `sol-send-signature`, `btn-sol-send-copy`, `btn-sol-send-done`, `sol-send-err`, `sol-send-bad-addr`).
5. **`app/components/SolPayMode.tsx`**: add `subMode: 'scan'|'send'`, `onSubModeChange`, and SOL-withdraw props (`identity`, `solBalance`, `onSent`). Always render `<ModeToggle testID="pay-mode-toggle" left={Scan to pay,btn-pay-scan} right={Send to address,btn-pay-send}>` at the top. When `subMode==='send'` → `return <View style={S.center}><ModeToggle…/><SolanaWithdrawSheet inline identity balance onSent onClose={() => onSubModeChange('scan')} /></View>`. Keep the existing scan/pay body for `subMode==='scan'`. Repoint `onShowDeposit` semantics: it now means "go fund" → Wallet will switch to Receive tab + `receiveSubMode='address'` (see step 7). Keep the unfunded/error "Add SOL" affordance calling `onShowDeposit`.
6. **`app/components/SolReceiveMode.tsx`**: add `subMode: 'request'|'address'`, `onSubModeChange`, `solAddress` prop. Always render `<ModeToggle testID="receive-mode-toggle" left={Request payment,btn-receive-request} right={My address,btn-receive-address}>`. When `subMode==='address'` → `return <View style={S.center}><ModeToggle…/><SolanaReceiveSheet inline address={solAddress} onClose={() => onSubModeChange('request')} /></View>`. Keep existing request body for `subMode==='request'`.
7. **`app/components/Wallet.tsx`**:
   - Drop `solReceiveOpen`/`solSendOpen` state (lines 121-122) and their mention in `anySheetOpen` (line 311).
   - Drop `onSolReceive`/`onSolSend` props to `<BalancesSheet>` (lines 438-439).
   - Drop overlay `<SolanaReceiveSheet>` (445-450) + `<SolanaWithdrawSheet>` (451-458).
   - `<SolPayMode>` call (line 393): add `subMode={paySubMode} onSubModeChange={setPaySubMode} solBalance={solBalance} onSent={refreshSol}`, repoint `onShowDeposit={() => { setMode('receive'); setReceiveSubMode('address'); }}`.
   - `<SolReceiveMode>` call (line 408): add `subMode={receiveSubMode} onSubModeChange={setReceiveSubMode} solAddress={solAddress}`.
   - `onSelectSol` (line 437): also reset sub-modes for parity with IC `onSelect` (430): `setReceiveSubMode('request'); setPaySubMode('scan');`.
8. **`app/components/BalancesSheet.tsx`**: drop `onSolReceive`/`onSolSend` from the destructure (line 28) + prop types (50-51); drop the SOL action-button cluster (lines 191-216); make the SOL row a pure whole-row `Pressable` (testID `asset-sol-select` already exists) mirroring the IC non-DEMO row (lines 154-172). `solBalance` prop can stay (shown in the row text) or be dropped if unused after — check.

### Phase 2 — uniform dead-overlay cleanup (all 5 sheets; separate commit)
After Phase 1, NO sheet is rendered as an overlay anywhere (IC overlay usages were already removed by
the 2026-08-09 refactor; SOL overlay usages removed in step 7). The overlay branches (`SheetOverlay`/
`SafeAreaView`/`StatusBar`/`sheetHead`/close ✕ + the `inline` prop + `if (inline)` branch) are now
**dead code in all 5 sheets**: `WithdrawSheet`, `DepositSheet`, `CkErc20DepositSheet`,
`SolanaReceiveSheet`, `SolanaWithdrawSheet`. Convert all 5 to **inline-only**: drop the `inline` prop,
drop the overlay wrapper + close-✕ testIDs, return just `<View style={S.sheetBody}>{body}</View>`.
Update `PayMode`/`ReceiveMode`/`SolPayMode`/`SolReceiveMode` to stop passing `inline`. This is a
mechanical, uniform cleanup — run `just verify` after.

### Phase 3 — docs + census
9. **`e2e/tests/41-a11y-census.mjs`** (line 52-55): drop `'btn-sol-receive'` from the SOL-row census; the new SOL toggle testIDs (`btn-pay-send`, `btn-receive-address`) are already covered by the IC census — confirm no duplicate-count issue.
10. **`OPEN_ISSUES.md`**: strike the "SOL parity in tab IA" section (lines ~68-100).
11. **`CODEBASE_ANALYSIS.md`** (line 185): replace the trailing "NOTE: SOL keeps its Balances Receive/Send buttons … deliberate exception" sentence with the resolution (SOL now uniform with IC; overlay sheets gone inline-only).
12. **`FLOWS.md`**: update flow 45 + 52 descriptions if they reference the old path.

## Verify gates
- After Phase 1: `just verify` (core+canister+relay+e2e+typecheck+bridge-parity) GREEN. e2e flows 45/52 GREEN on new paths; 46/47/51/53 unaffected.
- After Phase 2: `just verify` GREEN again (confirms IC flows unaffected by inline-only conversion).
- This change touches `app/components/**` (SOL sheets + SOL modes) — NOT the wire/bridge/native-module/Android-rendering trigger paths, so the device gate (`just app`/`just ondevice`) is NOT required by the AGENTS.md pre-merge rules. (SOL Pay/Receive toggle is pure JS presentational.)

## Confidence
- Approach (mirror IC exactly, then uniform dead-code cleanup): **9/10** — it's the literal application of the all-currencies-uniform HARD RULE, using the IC pattern already proven green.
- Safety: **8/10** — pure app/+e2e, fully covered by the offline e2e suite + jest + typecheck. Only residual risk is a missed testID rename; verify catches it.
