# Send/Receive tabs IA refactor — plan (2026-08-09)

> Status: **AGREED with founder, not yet built.** Next-session top work-order item.
> Owner: autonomous (no external blocker). Wire/canister/relay/core untouched — fully `app/`-scoped.

## Problem (founder feedback, 2026-08-09)

Three UX issues in the Balances sheet + Receive tab:

1. **Balances rows are busy + selection is undiscoverable.** Each row carries `+Receive` (deposit
   on-ramp) and `Send` (withdraw) action buttons on the right; the *select-the-active-currency*
   affordance (tap the name/balance area on the left) is weak — the `assetCard` brand left-border is
   ALWAYS brand-colored (active or not), so the only active cue is an 8×8 dot. Users can't tell how
   to pick a different currency.
2. **`+Receive` naming collides with the Receive tab.** Balances `+Receive` = show your on-chain
   deposit address; the Receive *tab* = request a dpay-to-dpay payment (QR). Same word, two actions.
3. **The Receive-tab currency picker (`CurrencyPicker`, `ReceiveMode.tsx:297`) is ugly + out of
   date.** It's a separate transparent modal with its own row style, and it lists ALL catalog
   currencies with NO testnet filter — so it shows testnet rows that Balances hides. The lists don't
   match.

## Agreed design (founder, 2026-08-09)

**Move on-chain Send/Receive OUT of the Balances sheet and INTO the existing Pay/Receive tabs** by
extending those tabs. This is preferred over a per-row "..." popup menu (which would bury primary
actions). Balances becomes a pure balance-list + select screen.

**Precedent: SOL already does this.** When SOL is the active asset, the Receive tab renders
`SolReceiveMode` (the SOL deposit address) and SOL send lives in `SolanaWithdrawSheet`. IC assets are
currently the exception (deposit address buried in Balances). This refactor makes IC stop being the
exception.

### Target layout

- **Receive tab** → gains the on-chain deposit-address flow for the active IC asset (alongside the
  existing dpay-to-dpay payment-request QR). A within-tab toggle `[ Request payment | My address ]`
  (or address-on-top + request-form-below). For SOL (`activeSol`): unchanged — already the address.
- **Pay tab** → gains a send-to-address mode (the current `WithdrawSheet` flow) alongside scan-to-pay.
  Toggle `[ Scan to pay | Send to address ]`. For SOL: `SolanaWithdrawSheet`.
- **Balances sheet** → pure balance list. The ENTIRE row (`assetCard`) becomes one `Pressable` →
  `onSelect(currency)` (click anywhere selects). No `+Receive`/`Send` buttons. Brand left-border
  active-ONLY (transparent when inactive) so the selected card pops. SOL row: same, whole-row select.
- **Receive currency picker** → unified with Balances: testnet-filtered (match the visible set),
  restyled to match Balances rows (dot active indicator + same typography). Data helpers
  (`displayName`/`currencySymbol`/`assetTestKey`/`isTestnetCurrency`) already shared via
  `config/catalog`.

### What does NOT change
- The dpay-to-dpay NFC payment rail (Pay/Receive core flows) — byte-unchanged in "Scan to pay" /
  "Request payment" modes.
- SOL routing (`activeSol` → `SolReceiveMode`/`SolPayMode`/`SolanaWithdrawSheet`) — already address-based.
- Wire/canister/relay/core — zero change. Pure `app/` component refactor.
- The active-asset model (header shows it; Balances selects it; tabs act on it).

## Phased plan (each phase = TDD RED-first, e2e reconciled, committed per unit)

### Phase 1 — Balances: whole-row select + drop action buttons (the declutter)
- `BalancesSheet.tsx`: merge `assetSelect` into the full `assetCard` width as one `Pressable` →
  `onSelect`. Remove `assetActions` (`+Receive`/`Send` buttons) + their handlers (`onAdd`/`onWithdraw`
  props become unused here — they migrate to the tabs in Phase 2/3). Brand left-border active-only.
  Add `testID={`asset-${key}-select`}` (the flow-55 follow-up). SOL row likewise.
- `Wallet.tsx`: stop passing `onAdd`/`onWithdraw` to BalancesSheet (temporary — they move to the
  tabs in Phase 2/3). Keep the handlers wired for the tab phases.
- **e2e:** flows that open Balances then tap `asset-add-*` / `btn-withdraw` to reach deposit/withdraw
  BREAK here (the buttons are gone). They get re-routed to the tabs in Phase 2/3. To keep the gate
  green mid-refactor, either (a) land Phases 1–3 as ONE atomic commit set, or (b) temporarily keep
  the buttons but whole-row-select first, then remove in Phase 3. **Recommend (a): build all three,
  commit as a sequence, run the full gate once at the end.**
- Visual baselines: `balances.png` + `wallet-pay.png` likely drift → re-seed (`just e2e-visual-seed`).

### Phase 2 — Receive tab: add "My address" mode (on-chain deposit)
- `ReceiveMode.tsx`: add a mode toggle `[ Request payment | My address ]`. "My address" renders the
  deposit-address flow for the active IC currency (lift the body of `DepositSheet` for CkBtcUtxo /
  `CkErc20DepositSheet` for CkEthErc20 into an inline mode, keyed off the active `currentCurrency`'s
  family — mirror `Wallet.tsx:422-424`'s routing). The `req-prefix` currency picker stays for
  "Request payment" mode (merchant picks settlement asset per-request); "My address" mode uses the
  active asset (change it via Balances/header).
- `Wallet.tsx`: pass `currentCurrency` + the deposit handlers into `ReceiveMode`.
- Unified picker: apply testnet filter + restyle (`ReceiveMode.tsx:297` `CurrencyPicker`).
- **e2e:** deposit flows 03/04/05/16/22/33 currently open Balances → `asset-add-*` → DepositSheet.
  Re-route: Balances (select asset) → Receive tab → "My address" → same assertions. Flow 33
  (ckerc20-persist) is the most involved (it resumes deposit-watching across a reload).

### Phase 3 — Pay tab: add "Send to address" mode (on-chain withdraw)
- `PayMode.tsx`: add a mode toggle `[ Scan to pay | Send to address ]`. "Send to address" renders the
  `WithdrawSheet` body inline for the active asset's family (CkBtcUtxo → BTC address;
  CkEthErc20 → native-ETH / ckERC20 withdraw). For SOL, `SolanaWithdrawSheet` already exists.
- `Wallet.tsx`: pass the withdraw handler into `PayMode`.
- **e2e:** withdraw flows 15/18/44/48/56 currently open Balances → `btn-withdraw` → WithdrawSheet.
  Re-route: Balances (select) → Pay tab → "Send to address" → same assertions. Flow 56
  (saved-address persistence) stays valid (same WithdrawSheet internals).

### Phase 4 — picker unification + polish
- `CurrencyPicker` restyle to match Balances rows (dot + name); testnet-filtered.
- A11y census flow 41 reconciled (it enumerates `req-pick-*` + `asset-add-*` testIDs — both change).
- `FLOWS.md` regenerated.

## e2e impact summary (flows needing reconciliation)

| Flow | Current path | New path |
|------|-------------|----------|
| 03/04/05 (deposit) | Balances → `asset-add-*` → DepositSheet | Balances(select) → Receive → "My address" |
| 16 (ckusdc-onramp) | Balances → `asset-add-ckusdc` | Receive → "My address" (ckERC20) |
| 22 (deposit-error) | Balances → `asset-add-*` | Receive → "My address" |
| 33 (ckerc20-persist) | Balances → `asset-add-ckusdc` + reload resume | Receive → "My address" + reload |
| 15/18 (withdraw) | Balances → `btn-withdraw` → WithdrawSheet | Balances(select) → Pay → "Send to address" |
| 44/48 (cketh/ckusdc withdraw) | Balances → `btn-withdraw` | Pay → "Send to address" |
| 56 (saved-addr) | Balances → `btn-withdraw` | Pay → "Send to address" |
| 24/55 (balances/select) | Balances rows | whole-row select (assertion update) |
| 41 (a11y census) | enumerates `asset-add-*`/`req-pick-*` | re-enumerate new testIDs |
| 40 (visual) | 5 baselines | re-seed `balances.png` + `wallet-pay.png` (+ `receive-request.png` if the toggle moves it) |

~12 flows touched. All mechanical re-routing (same downstream assertions, new navigation path).

## Risks / notes

- **Inline vs sheet:** lifting DepositSheet/WithdrawSheet bodies inline (into the tab) vs keeping
  them as sheets opened from the tab. Inline is cleaner (matches SOL's inline modes) but bigger
  diff. Decide per-component when building.
- **Tab toggle UX:** a segmented control at the top of each tab body (like the existing RailSelector
  `[ IC | SOL ]` at Wallet.tsx). Reuse that pattern.
- **DEMO asset:** DEMO has no deposit address (faucet only). "My address" mode for DEMO → either
  hide the toggle (DEMO isn't on-chain) or show the faucet action. Keep DEMO's faucet in Balances OR
  move it to "My address" (as "Add demo funds"). Decide when building.
- **"..." menu explicitly REJECTED** by the founder — do not add a popup overflow menu.
- **No rename:** keep "Receive" (do NOT rename to "Deposit"). The disambiguation comes from the tab
  context, not a label change.
