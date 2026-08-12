# 2026-08-10 — Unified Currency Selector Plan (PLANNING ONLY)

> **SUPERSEDED 2026-08-12 by `2026-08-12-unified-asset-selection-rewrite.md`.** This plan unified
> row presentation but retained `currentCurrency`, `activeSol`, `reqCurrency`, and the Solana-local
> SOL/USDC toggle. Do not use its rail-switch architecture for new work.
>
> Planning document for the 3 coupled UX issues the founder filed on the currency
> selectors. **No source changes made here** — this is the design + file-by-file
> change set + e2e impact analysis. Implementation is a follow-up.
>
> Issues: **#4** (Receive picker transparency, LOW) · **#3** (selectors must look/work
> the same, MEDIUM) · **#2** (unify IC + SOL in ONE list + chain labels, MEDIUM).

---

## 1. Current state (what's broken)

### Issue 4 — Receive picker card is nearly invisible
- `app/config/palette.ts`: `C.card = 'rgba(255,255,255,0.025)'` (2.5% white wash).
- `app/styles.ts:255` `pickCard.backgroundColor = C.card`.
- `app/styles.ts:254` `pickBackdrop.backgroundColor = 'rgba(0,0,0,0.6)'`.
- Composited: `#06070a` → 60% black veil → 2.5% white wash ≈ `#080808`. The picker
  card is indistinguishable from its backdrop. Confirmed by reading both styles.
- `C.card` is used by **6 styles** (`assetCard`, `pickerRow`, `pickCard`, `instrCard`,
  `depositStatus`, `reviewCard`). The other 5 sit directly on opaque `C.bg`, so the
  wash reads correctly there. **Only `pickCard` is broken** (it floats over a
  translucent backdrop).

### Issue 3 — two selectors, two visual languages
- **BalancesSheet** (`app/components/BalancesSheet.tsx:153-198`): each row is an
  `assetCard` View → `assetRow` Pressable → `assetSelect` (`dot` + `assetLabel` +
  `assetAmt`) with an `assetSub` line below. Active = brand `borderLeftColor`
  (`assetCardActive`, styles.ts:170) + brand `dot`. Whole card is the Pressable.
- **ReceiveMode CurrencyPicker** (`app/components/ReceiveMode.tsx:365-398`): each row
  is a `pickItem` Pressable → `dot` + `pickName` + `pickCheck` ('✓'). **No amount,
  no subtitle.** Active = check mark only. Different typography (`pickName` 16/700
  vs `assetLabel` 16/700 — same weight but no `assetAmt`/`assetSub` siblings, so the
  spacing/line-height differs).

### Issue 2 — SOL is a separate code path; absent from the picker
- `BalancesSheet.tsx:173-198`: SOL is a hard-coded row **separate from the
  `visibleCatalog.map(...)` loop**, with its own props (`solAddress`, `solBalance`,
  `activeSol`, `onSelectSol`). TestIDs `asset-sol` / `asset-sol-select`. Subtitle
  "Solana · self-custody".
- `ReceiveMode.tsx:365-398` `CurrencyPicker`: **only IC catalog currencies**. No SOL
  row. A merchant cannot pick SOL as the receive currency from the picker.
- `Wallet.tsx:126` `activeSol` is the rail boolean; `Wallet.tsx:408` swaps
  `ReceiveMode` ↔ `SolReceiveMode` on it. `ReceiveMode` **unmounts** when
  `activeSol` flips true, so a SOL pick in the picker must signal up to Wallet
  *before* re-render.

---

## 2. Architecture decision

### 2a. Shared `CurrencyRow` component (RECOMMENDED over shared styles)

A new presentational component `app/components/CurrencyRow.tsx` renders ONE row and
is consumed by **both** BalancesSheet and the ReceiveMode picker. Props:

```ts
type CurrencyRowProps = {
  testId: string;                  // base testID — 'asset-ckbtc' (Balances) | 'req-pick-ckbtc' (picker)
  name: string;                    // 'BTC' | 'USDC' | 'SOL' | 'DEMO'
  subtitle?: string;               // chain label / curated description
  amount?: string;                 // '0.00050000 BTC' (Balances); omit in picker
  active: boolean;                 // selects dot color + check mark + (card) left-edge
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  variant: 'card' | 'plain';       // card = Balances assetCard chrome; plain = picker pickItem
  showCheck?: boolean;             // render ✓ when active (default true in BOTH → unified indicator)
  zero?: boolean;                  // dim the amount (unfunded asset → assetCardZero)
  actions?: React.ReactNode;       // DEMO faucet button slot (card variant only)
  children?: React.ReactNode;      // extra nodes below the subtitle (topUpErr line)
};
```

**Why a component, not just shared styles:** the two surfaces diverge in structure
(container View + Pressable for Balances vs. bare Pressable for the picker) and in
content (Balances shows amount + curated subtitle; picker shows check + chain label).
A component captures the shared layout (dot + name + trailing + subtitle) with two
explicit `variant`s; shared styles alone would still leave two duplicated JSX blocks
that drift (the exact bug the founder filed).

**testID strategy (preserves the e2e contract byte-for-byte):**
- `variant='card'`: renders `<View testId={testId}>…<Pressable testId={`${testId}-select`}>…</Pressable>…</View>` → matches the existing `asset-<key>` (container) + `asset-<key>-select` (Pressable) pattern.
- `variant='plain'`: renders `<Pressable testId={testId}>…</Pressable>` → matches `req-pick-<key>` (no container).

**Active indicator (unified):** `dot` turns `C.brand` when active AND a `✓` check
renders at the row's trailing edge. This is identical in both surfaces. The Balances
card's `assetCardActive` brand left-edge **stays** as a card-level affordance (not
the primary indicator — the dot+check is). Rationale: the founder said "same active
indicator"; dot+check is the single shared cue. Keeping the card edge is a harmless
bonus that avoids churning the Balances visual further.

### 2b. Unified currency LIST — a UI-layer builder, NOT a catalog change

**Recommendation: keep SOL OUT of the catalog; build a unified selector list at the
call site.**

A new pure helper (co-located in `CurrencyRow.tsx` or a sibling
`app/lib/currencyList.ts` — see §3) exports:

```ts
export type CurrencyListItem =
  | { kind: 'ic'; desc: CurrencyDescriptor; key: string; name: string; subtitle: string;
      amountText: string | null; zero: boolean; active: boolean }
  | { kind: 'sol'; key: 'sol'; name: 'SOL'; subtitle: string;
      amountText: string | null; zero: boolean; active: boolean };

export function buildCurrencyList(args: {
  catalog: CurrencyDescriptor[];
  assetBalances: Record<number, string>;
  primaryBalance: string | null;
  online: boolean;
  showTestnet: boolean;
  currentCurrency: number;
  activeSol: boolean;
  solAddress: string | null;
  solBalance: string | null;
}): CurrencyListItem[];
```

- IC items: one per `visibleCatalog` entry (testnet filter mirrors BalancesSheet).
  `name` = `displayName(desc)` (or `'DEMO'` for currency 0); `subtitle` = the
  **same curated logic BalancesSheet already inlines** (lines 99-107: BTC →
  "Bitcoin", USDC/USDT → "US dollar stablecoin", testnet → `network`, fallback →
  `familyDisplay.networkLabel`, DEMO → "play money for testing"). Extracting this
  into the builder makes both surfaces render identical subtitles.
- SOL item: appended **only when `solAddress` is non-null** (mirrors BalancesSheet's
  existing gate). `subtitle` = "Solana" (or "Solana · self-custody" to match the
  current Balances text — open decision §7).

**Why NOT add SOL to `CurrencyDescriptor` / the catalog:**
- The catalog is the **canister's** `currencies()` truth — SOL is a device-key rail
  with no ICRC ledger, no `minter_family`, no `currency` id. Forcing it in is a
  category error and violates the "SOL is app-only, no IC canister/relay/wire
  involvement" constraint.
- Every catalog helper (`isPayableAsset`, `familyDisplay`, `fmtCurrencyAmount`,
  `resolveNfcDisclosure`, `assetTestKey`) would need SOL special-casing. Contagion.
- The unified list is a **UI concern** (two selectors rendering the same rows), not
  a data-model concern. Keeping it at the UI layer contains the SOL special-case to
  the one place it already exists (BalancesSheet) + the one place it's being added
  (the picker).

### 2c. SOL pick in ReceiveMode picker → Wallet rail switch

Add an `onSelectSol` prop to `ReceiveMode` (and to the inner `CurrencyPicker`),
mirroring the prop BalancesSheet already has. Wiring:

- `Wallet.tsx`: pass `onSelectSol={() => { setActiveSol(true); setReceiveSubMode('request'); setPaySubMode('scan'); }}` to `<ReceiveMode>`.
- `ReceiveMode.tsx` `CurrencyPicker`: when the tapped item is `kind === 'sol'`, call
  `onSelectSol?.()` and **return** (do NOT call `setReqCurrency` / `setAmount` /
  `setPickOpen(false)` — ReceiveMode is about to unmount; the local state churn is
  moot and React may warn about updating an unmounting component).

This is the same up-call pattern BalancesSheet uses (`onSelectSol` → Wallet sets
`activeSol=true`). The swap `ReceiveMode → SolReceiveMode` happens on Wallet's
re-render, **after** the callback returns — no race.

### 2d. Chain labels — reuse the BalancesSheet curated subtitle

The founder's example "USDC · Ethereum", "SOL · Solana" is satisfied by giving the
picker rows a **subtitle line** (currently absent). Source the subtitle from the
SAME curated builder BalancesSheet uses (§2b). Format options:
- (default) **Subtitle on a second line below the name** — matches BalancesSheet's
  established `assetSub` idiom; the founder's "·" form is a cosmetic variant the
  builder can produce (`\`${name} · ${chain}\``) but the two-line layout reads
  cleaner in a dense list.
- (alt) **Inline "NAME · CHAIN"** on the name line — closer to the founder's literal
  example but crowds the check mark in the picker.

**Recommend the subtitle line** (uniformity with Balances, less width pressure).
The subtitle STRING can still be "Ethereum" / "Solana" / "play money for testing"
(exactly what Balances shows today) — no string change needed.

### 2e. Transparency fix — local to `pickCard`, NOT global to `C.card`

Change `pickCard.backgroundColor` from `C.card` (2.5% wash) to an opaque raised
surface. Options ranked:
1. **`C.panel` (`#0c0f14`)** — the established "raised surface" color
   (`panel`/`panel2`). Visually consistent with the Settings/Deposit sheet chrome.
   **RECOMMENDED.**
2. `C.field` (`#10141a`) — matches input-field wells; slightly lighter.
3. A new dedicated color — unnecessary; `C.panel` already exists for this role.

Leave `C.card` unchanged (the 5 other uses over opaque `C.bg` are correct as-is).

---

## 3. File-by-file changes

### `app/styles.ts` (ONE block — keys added/edited, NOT partitioned)
- **Edit** `pickCard.backgroundColor: C.card` → `C.panel` (Issue 4). 1-line fix.
- **Add** a `pickRowGap` / reuse `pickItem` for the picker row. The shared
  `CurrencyRow` consumes `assetCard`, `assetCardActive`, `assetRow`, `assetSelect`,
  `assetLabel`, `assetAmt`, `assetSub`, `assetCardZero`, `assetActions`,
  `pickItem`, `pickName`, `pickCheck`, `dot` — all already defined. No new keys
  strictly required; if the picker row needs a subtitle style, reuse `assetSub`
  (same typography is the goal). Possibly add `pickSubtitle` aliasing `assetSub`
  for clarity (optional).
- **Do NOT** remove `pickName`/`pickCheck` even if `CurrencyRow` ends up using
  `assetLabel`/a shared trailing style — other call sites (a11y census, future
  pickers) may reference them; safer to keep until a follow-up audit. (Stricter
  `typecheck` will flag any genuinely-unused key, but these are still imported by
  the current ReceiveMode until the refactor lands.)

### `app/components/CurrencyRow.tsx` (NEW FILE, ~90 LOC)
- Export `CurrencyRow` (the presentational component, §2a) + `CurrencyListItem`
  type + `buildCurrencyList` helper (§2b). Co-locating the builder keeps the list
  shape next to its only consumer (the row); if the founder prefers the pure-layer
  rule strictly, move the builder to `app/lib/currencyList.ts` (pure, no React
  import) and keep only the component in `components/`. Both are defensible; the
  plan defaults to **co-location** (smaller diff, one import per consumer).
- Pure presentational; no hooks, no native-module calls. Safe under `just typecheck`
  + `just verify`.

### `app/components/BalancesSheet.tsx` (refactor, ~216 → ~150 LOC)
- Replace the **3 row shapes** (DEMO two-part row, non-DEMO IC row, SOL row) with a
  single `items.map(item => <CurrencyRow ... />)` loop driven by `buildCurrencyList`.
- DEMO keeps its faucet button via `actions={<Pressable testID='btn-topup' …/>}` and
  its `topUpErr` line via `children`.
- Preserve every testID the e2e net reads: `asset-<key>` (container, via the card
  variant), `asset-<key>-select` (the inner Pressable), `asset-sol`,
  `asset-sol-select`, `btn-topup`, `topup-err`, `btn-balances-close`,
  `btn-toggle-testnet`. **No testID renames.**
- Subtitles now come from `buildCurrencyList` (same strings as today — "play money
  for testing", "Bitcoin", "US dollar stablecoin", "Solana · self-custody", etc.).
- Net: ~66 fewer lines (3 row templates collapse into 1 driven by the list).

### `app/components/ReceiveMode.tsx` (refactor CurrencyPicker, ~398 LOC unchanged outside the picker)
- `CurrencyPicker` (lines 365-398): replace the inline `visible.map(...)` with
  `buildCurrencyList` + `<CurrencyRow variant='plain' showCheck …/>`. Each row now
  shows `name` + `subtitle` (chain label) + `✓` when active. **Amount is omitted**
  (the picker is a selector, not a balance list).
- Add the SOL row: `buildCurrencyList` returns it when `solAddress` is non-null.
- Add `onSelectSol` prop to `CurrencyPicker` and to `ReceiveMode`; on a SOL tap,
  call `onSelectSol()` and return early (no local state churn — ReceiveMode is
  about to unmount). TestID for the new row: **`req-pick-sol`**.
- Preserve `req-pick-<key>` testIDs for every IC row (the e2e contract). The
  `req-pick-sol` row is NEW (no flow depends on it yet — see §5).
- Note: `reqCurrency` local state stays an IC-only `number` (the picker still
  encodes an IC currency id into the request). Picking SOL does NOT set
  `reqCurrency` — it flips the rail, which swaps to `SolReceiveMode` (which has its
  own `cur: 'SOL' | 'USDC'` state). This keeps the IC request-encoding path
  byte-untouched (flows 25/28 unaffected).

### `app/components/Wallet.tsx` (1 prop added to the ReceiveMode call)
- `Wallet.tsx:410-418` `<ReceiveMode>`: add
  `onSelectSol={() => { setActiveSol(true); setReceiveSubMode('request'); setPaySubMode('scan'); }}`.
  Mirrors the existing `onSelectSol` passed to `<BalancesSheet>` at line 437.
- No other Wallet changes. The `activeSol` boolean remains the rail source of truth;
  SOL-from-picker and SOL-from-Balances both funnel through the same setter.

### `app/components/SolReceiveMode.tsx` — **NO CHANGES**
- SolReceiveMode already mounts when `activeSol` is true. Picking SOL from the
  Receive picker just flips `activeSol`; SolReceiveMode renders on the next tick.
  Unchanged.

### `app/config/catalog.ts` — **NO CHANGES**
- The catalog stays IC-only. SOL is not added (§2b).

---

## 4. New testIDs

| testID | Where | Purpose |
|---|---|---|
| `req-pick-sol` | `ReceiveMode` CurrencyPicker SOL row | Assert SOL is selectable as a receive currency (NEW — no flow yet) |

All existing testIDs are preserved byte-for-byte. No renames.

---

## 5. E2e impact + flows to update

### Flows that MUST be updated

- **`e2e/tests/41-a11y-census.mjs`** — add `'req-pick-sol'` to the `receive` surface
  list (line 48-49). The new SOL Pressable must carry `accessibilityRole='button'`
  + a non-empty `accessibilityLabel` (e.g. "Receive in SOL") — the census asserts
  both. Without this, flow 41 REDS with "missing role/aria-label" on `req-pick-sol`.
- **`e2e/tests/40-visual-regression.mjs`** — the `balances` baseline WILL drift
  (active rows now show a `✓`; non-DEMO rows may re-flow slightly as the unified
  `CurrencyRow` replaces 3 hand-rolled templates). Re-seed with
  `DPAY_E2E_REGEN_BASELINES=1 just e2e-visual` and **review the diff in the commit**
  (the gate only re-seeds surfaces that actually drifted past 0.5%, so the diff is
  honest). The other 4 surfaces (wallet-pay, receive-request, settings, ledger) are
  unaffected — the picker isn't captured and no other surface changed.

### Flows that need a NEW assertion (optional but recommended)

- **Pick SOL from the Receive picker → rail switches.** Either extend
  `55-balances-select-asset.mjs` (which already drives `asset-sol-select` in
  Balances) with a second half, OR add a small new flow
  `63-picker-sol-rail.mjs`: onboard → Receive → `req-prefix` → `req-pick-sol` →
  assert `active-rail-chip` reads 'SOL' + the SolReceiveMode form mounts
  (`sol-req-amount-input` present). This is the direct coverage for Issue 2b/2d
  (SOL selectable in the picker + switches the rail). **Recommend a new flow** to
  keep 55 focused on the Balances→header binding.

### Flows that are SAFE (verified — they use `assertIncludes` substring matching)

Confirmed by reading each flow's assertion + the harness:
- `assertIncludes` (`lib.mjs:274`) is substring-based.
- `readText` (`driver.mjs:334-337`) returns the trimmed `textContent`.
- **No flow uses `assertEq` on a row's full textContent.** Flow 55 uses `assertEq`
  on `active-rail-chip` (the header chip), not a row. Every row assertion is
  `assertIncludes('BTC')`, `assertIncludes('0 BTC')`, `assertIncludes('SOL')`,
  `assertIncludes('—')`, `assertIncludes('0.00060000 BTC')`, etc.

Therefore adding a `✓` check mark or a chain-label subtitle to a row's textContent
is **safe** for every existing flow — the substring they assert is still present.
Specifically verified:
- `05-deposit-credited` (lines 68-72): `assertIncludes(zeroTxt, '0 BTC')`,
  `assertIncludes(zeroTxt, 'BTC')` — safe.
- `27-asset-pay` (line 71): `waitForText('0.00060000 BTC')` body-wide — safe.
- `45-sol-receive` (lines 45-47): `assertIncludes(cardTxt, 'SOL')`,
  `assertIncludes(cardTxt, '—')` — safe.
- `24-wallet-cleanup` (lines 65-74): presence checks (`findByTestID`, `isPresent`,
  `waitGone`) — safe (testID unchanged).
- `25/28-asset-request` / `28-ckusdc-request`: tap `req-pick-ckbtc` /
  `req-pick-ckusdc` — testIDs preserved; safe.
- `54-testnet-toggle`: `asset-ckbtc-testnet` — preserved; safe.
- `44-cketh-withdraw`: `asset-cketh-select` — preserved (ckETH is a CkEthErc20
  catalog entry, renders through the unified loop); safe.

---

## 6. Visual baseline impact (flow 40)

| Surface | Captured? | Drift? | Action |
|---|---|---|---|
| `wallet-pay` | yes | no | — |
| `receive-request` | yes (QR screen, picker closed) | no | — |
| `balances` | yes | **YES** (✓ on active row + unified row template) | **Re-seed** (`DPAY_E2E_REGEN_BASELINES=1`); review diff |
| `settings` | yes | no | — |
| `ledger` | yes | no | — |

Only one baseline needs re-seeding. The picker itself is not a captured surface, so
its visual overhaul (subtitle added, opaque card, SOL row) requires no baseline
work — only the a11y census + (recommended) a new SOL-pick flow.

---

## 7. Implementation order (minimizes churn + keeps each step independently green)

1. **Issue 4 — picker transparency** (1-line `styles.ts` edit). Lands the most
   visible improvement with zero risk. No e2e/baseline impact (picker not
   captured). `just verify` green.
2. **New `CurrencyRow` + `buildCurrencyList`** (new file, not yet wired). Typecheck
   only. `just typecheck` green; no behavior change.
3. **Refactor `BalancesSheet` to consume `CurrencyRow`** (collapse 3 row templates
   into 1). Preserve all testIDs. Re-seed the `balances` flow-40 baseline. `just
   verify` green.
4. **Refactor `ReceiveMode` CurrencyPicker to consume `CurrencyRow` + add SOL row +
   `onSelectSol` prop; wire Wallet.** Add `req-pick-sol`. Update flow 41 census.
   Add the new `req-pick-sol` flow (or extend 55). `just verify` green.
5. **(Off the hot path — founder-run device gate)** `just app` (assert
   `DPAY_SELFCHECK PASS`) + `just ondevice`. The change touches
   `app/components/**` (no `StatusBar`/`SafeAreaView`/`BackHandler`/`Platform`
   changes, no native-module/autolinking/wire/AID surface), so the device gate is
   **recommended** (the trigger path is `app/components/**`) but the
   structurally-invisible classes (1/2/3 in AGENTS.md) don't apply — this is pure
   presentational RN. Still, a `just app` self-check is cheap insurance.

Each step is independently commitable + verifiable. Steps 1-4 can also collapse
into a single atomic commit if the founder prefers (see §8).

---

## 8. Suggested commit messages

Split (recommended — each is reviewable in isolation):

```
fix(receive): give currency picker an opaque card background

C.card (rgba 2.5% white) is correct over opaque C.bg but vanishes over the
rgba(0,0,0,0.6) picker backdrop. Use C.panel (#0c0f14) for pickCard only — the
5 other C.card consumers sit on opaque surfaces and are unaffected.

Closes founder issue #4.
```
```
feat(wallet): shared CurrencyRow + unified currency list builder

Extract the 3 hand-rolled row templates in BalancesSheet (DEMO two-part, IC
non-DEMO, SOL) into a single CurrencyRow component with 'card' | 'plain'
variants. buildCurrencyList() produces one unified list (IC catalog + the
synthetic SOL entry) so both selectors render identical rows: dot + name +
chain-label subtitle + (active) ✓ check.

SOL stays OUT of the catalog (it's a device-key rail, not an ICRC asset); the
unified list is a UI-layer concern. Closes founder issues #2a + #3.
```
```
feat(receive): add SOL to the currency picker + rail-switch on pick

CurrencyPicker now lists SOL (req-pick-sol). Tapping it calls onSelectSol →
Wallet flips activeSol true → SolReceiveMode mounts (ReceiveMode unmounts
cleanly; the up-call fires before re-render, no race). IC picks still encode
the IC currency id into the request (flows 25/28 byte-unchanged).

E2e: add req-pick-sol to flow 41 census; add flow 63 (picker SOL → rail
switch); re-seed the flow 40 balances baseline for the unified row template.

Closes founder issue #2b/2c/2d.
```

Or collapsed into ONE commit (if the founder wants a single atomic UX change):
```
feat(wallet): unify currency selectors (Balances + Receive picker)

- Shared CurrencyRow component (card | plain variants) + buildCurrencyList
  helper (IC catalog + synthetic SOL entry — SOL stays out of the catalog).
- BalancesSheet: 3 row templates collapse into 1; active indicator = dot + ✓.
- ReceiveMode CurrencyPicker: opaque card (was ~invisible over the backdrop),
  chain-label subtitle on every row, SOL row added (req-pick-sol) → onSelectSol
  flips the rail before ReceiveMode unmounts.
- E2e: flow 41 census += req-pick-sol; new flow 63 (picker SOL → rail switch);
  flow 40 balances baseline re-seeded.

Closes founder issues #2, #3, #4.
```

---

## 9. Risks (ranked)

1. **Flow 40 `balances` baseline drift on the unified row template** — the
   re-seed is mechanical (`DPAY_E2E_REGEN_BASELINES=1 just e2e-visual`), but the
   founder MUST eyeball the diff PNG to confirm the new layout is the intended UX
   (not a regression that happened to render). The gate only re-seeds surfaces that
   drifted >0.5%, so the diff is honest, but a wrong-but-stable re-seed ships a
   visual bug locked into the baseline. **Mitigation:** screenshot the picker +
   Balances on the emulator (`just app` + screenshot via zai-vision) and reconcile
   against the founder's intent before committing the re-seed.
2. **SOL pick race / React "update on unmounting component" warning.** If the
   picker's SOL branch calls `setReqCurrency` / `setPickOpen` AFTER `onSelectSol`,
   React may warn (ReceiveMode unmounts mid-update). **Mitigation:** the SOL branch
   in `onPick` calls `onSelectSol()` and returns immediately (no local setState).
   Documented in §2c.
3. **`buildCurrencyList` subtitle drift from the current BalancesSheet curation.**
   The subtitle logic (BTC → "Bitcoin", USDC/USDT → "US dollar stablecoin",
   testnet → `network`, SOL → "Solana · self-custody", DEMO → "play money for
   testing") is currently inlined in BalancesSheet lines 99-107. Extracting it is
   mechanical but a copy-paste error would silently change a row's label (the e2e
   net uses substring matching, so a wrong label may sail through). **Mitigation:**
   the extracted builder is unit-checkable; eyeball-diff the extracted strings
   against the original lines 99-107 during review.
4. *(minor)* **DEMO row's extra `<View style=assetRow>` wrapper** when
   `actions` is undefined (non-DEMO rows). The original made the Pressable BE the
   `assetRow`; the unified component wraps the Pressable in an `assetRow` View to
   host the optional `actions` sibling. Render-equivalent (invisible, same layout),
   but a purist may want the branch elided. Flag, don't block.
5. *(minor)* **SOL subtitle wording inconsistency** — Balances currently shows
   "Solana · self-custody"; the founder's example said "SOL · Solana". The plan
   reuses the Balances curated string in both surfaces for uniformity. If the
   founder prefers the shorter "Solana" in the picker (or the literal "SOL ·
   Solana" inline form), that's a one-line tweak in `buildCurrencyList`. Open
   decision — see §2d/§7 of the plan.

---

## 10. Open decisions for the founder (none block implementation)

- **SOL subtitle text** in the picker: "Solana" (short) vs "Solana · self-custody"
  (current Balances text) vs the literal inline "SOL · Solana" form. Default:
  reuse the Balances curated string.
- **Co-locate `buildCurrencyList` in `CurrencyRow.tsx`** vs pure-layer
  `app/lib/currencyList.ts`. Default: co-locate (smaller diff).
- **New flow `63-picker-sol-rail.mjs`** vs extending flow 55. Default: new flow.
- **Keep `pickName`/`pickCheck` styles** as aliases after the refactor (safer) vs
  remove them and rely on `assetLabel`/a shared trailing style (cleaner). Default:
  keep; the stricter `typecheck` will flag them if genuinely dead.
