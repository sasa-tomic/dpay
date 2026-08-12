# 2026-08-12 — Unified Asset Selection Rewrite (PLANNED)

> **Status: PLANNED, unblocked, highest-priority next-session work.** This plan supersedes
> `2026-08-10-unified-selector-plan.md`. That earlier change unified row rendering but retained
> three independent selection states and a hidden rail switch. The result looks unified while
> behaving inconsistently.
>
> Scope is app + e2e + documentation. SOL remains app-only: do not change the facade, relay
> catalog, IC wire format, Rust core, or canister settlement for this rewrite.

## Executive decision

There is **no user-facing rail switch**. The user selects an asset once. That selection drives
the balance header, Balances sheet, Pay/Receive forms, direct send/receive actions, and the idle
protocol engine. The app derives IC versus Solana QR, NFC AID, signing, and settlement internally.

The IC and Solana protocol engines remain separate behind that dispatch. Their authorization,
wire formats, NFC transports, and settlement mechanisms are physically different; combining them
into one conditional component would duplicate money logic and weaken the boundary. This rewrite
unifies the asset domain and user interaction, not the protocols.

## Why this rewrite is required

The current implementation has four competing sources of truth:

- `Wallet.tsx` owns `currentCurrency` for the header and IC actions.
- `Wallet.tsx` separately owns `activeSol` to choose which protocol component is mounted.
- `ReceiveMode.tsx` owns `reqCurrency`, initialized to DEMO regardless of the Wallet selection.
- `SolReceiveMode.tsx` owns `cur: 'SOL' | 'USDC'` and implements a binary toggle instead of the
  complete picker.

Concrete failures follow directly:

- Selecting an IC asset in Balances updates the header but not the Receive dropdown.
- Selecting SOL swaps component trees; the Solana Receive control then offers only USDC.
- Solana USDC is not a first-class selectable asset and has no independently represented balance.
- IC and Solana USDC share a symbol but are not consistently disambiguated by network.
- `dpay:req` / `dpay:pay` links can select Pay/Receive while the Solana component is mounted, so the
  IC component that consumes the link remains absent.
- Catalog refresh or testnet hiding can leave a stale numeric selection.
- `activeSol=true` with failed Solana address derivation can show a SOL header over an IC engine.
- Solana UI uses the IC relay's `online` state even though Solana RPC availability is independent.
- The Solana-USDC ATA check currently permits an unknown/RPC-failure state despite fail-closed copy.

Flows 55 and 63 gave false confidence: flow 55 checks only the header after selection, while flow
63 codifies the special SOL rail-switch callback. Both must be rewritten around end-to-end asset
selection semantics.

## Hard invariants

1. One Wallet-owned selected asset ID is the only idle user-selection state.
2. Every selector renders the same complete visible asset list and uses the same `onSelect(id)`
   contract. There is no `onSelectSol`, rail prop, or binary SOL/USDC toggle.
3. Asset IDs are stable across catalog object refreshes. State never stores a catalog descriptor.
4. Solana entries never masquerade as `CurrencyDescriptor`s and never enter the relay/canister
   catalog, ICRC polling/history, or IC wire currency IDs.
5. Duplicate symbols are always network-qualified: for example `USDC · Ethereum` and
   `USDC · Solana`.
6. The merchant-selected settlement asset is exact. No swap, fallback asset, or cross-network
   substitution is allowed.
7. A decoded payer request is an immutable snapshot. It determines and locks the exact asset for
   review, signing, NFC/QR handoff, settlement, and receipt verification.
8. IC USDC and Solana USDC balances are independent and cannot satisfy each other's checks.
9. IC relay connectivity and Solana RPC connectivity are independent states.
10. Missing ATA, known zero token balance, loading/unavailable balance, and RPC failure are distinct.
11. Only the selected/requested protocol's NFC engine is armed. Do not mount both AID engines as an
    auto-detection shortcut.
12. Existing IC wire bytes and Solana protocol payloads remain byte-exact unless a focused test first
    proves an intentional protocol change. No protocol change is planned here.

## Target domain model

Add a pure app asset domain, separate from the ICRC catalog. Exact names may be refined during the
RED test, but preserve this shape and discriminants:

```ts
export type AssetId = `ic:${number}` | 'solana:SOL' | 'solana:USDC';

export type AssetRef =
  | {
      id: `ic:${number}`;
      protocol: 'ic';
      currency: number;
    }
  | {
      id: 'solana:SOL' | 'solana:USDC';
      protocol: 'solana';
      token: 'SOL' | 'USDC';
    };
```

`SelectableAsset` is a resolved view model built from the current validated IC catalog plus explicit
app-defined Solana assets. It carries stable identity, symbol, network label, decimals, visibility,
capabilities, and a deterministic test key. It references an IC descriptor by current currency ID;
it does not copy a stale descriptor into React state.

The default/fallback policy is deterministic:

- Preserve the selected ID while it remains visible.
- If it disappears or becomes hidden, prefer `ic:0` when present.
- Otherwise select the first visible asset.
- If no asset is visible, render a fail-closed unavailable state rather than inventing one.
- Hiding a selected testnet asset atomically applies the fallback and clears that asset's idle draft.

Selection remains session-local, matching current behavior. Do not add persistence without a separate
requirement and migration policy.

## Request lock and state ownership

Idle asset selection and an active payer request are related but not interchangeable:

- `Wallet` owns `selectedAssetId` and resolves it from the latest visible list.
- An engine reports a successfully decoded request's exact `AssetId` to `Wallet`.
- `Wallet` updates the visible selection and records a request lock while review/sign/settlement is
  active.
- Formatting, balance checks, signing, and receipt matching continue to read the immutable decoded
  request, not mutable selected-asset metadata.
- Balances may remain inspectable during a request, but selection rows are disabled with honest copy.
- Cancel or terminal completion releases the lock. Cancel keeps the request's asset selected.

Do not key-remount the component holding an active request when synchronizing the selected ID. Key
idle request-creation forms only, or defer any remount until the decode callback has installed the
lock. Deliberate idle selection changes should clear amount, memo, scanner, QR, and stale errors.

## Implementation order

Each phase is one independently reviewable commit. Start each phase with a focused failing unit/e2e
assertion, implement only that phase, run its focused gates, and commit only when green. Do not keep
deprecated props, parallel state, or adapter shims “temporarily” after their replacement phase.

### Phase 1 — Asset domain, validated list, and catalog reconciliation

**Primary files**

- `app/lib/types.ts`
- New `app/config/assets.ts`
- `app/config/catalog.ts`
- `app/hooks/useCatalog.ts`
- New `app/__tests__/assets.test.ts`
- `app/__tests__/catalog.test.ts`

**RED tests first**

- Complete list contains every visible IC descriptor plus exactly `solana:SOL` and
  `solana:USDC` when the configured Solana network supports them.
- Stable IDs survive descriptor object/metadata refresh.
- Duplicate IC currency IDs fail validation or are rejected deterministically.
- Selected removed/hidden assets use the documented fallback.
- Every picker receives identical testnet filtering.
- Cached catalog data is parsed through the same validator as network data.
- Changing relay URLs cannot reuse another relay's unscoped cached catalog.

**Implementation**

- Add `AssetId`, `AssetRef`, `SelectableAsset`, and asset balance/status types.
- Add one pure list builder and one `reconcileSelectedAsset()` helper.
- Move `buildCurrencyList` out of `CurrencyRow.tsx`; presentational components must not own domain
  construction.
- Namespace the catalog cache by normalized relay URL, or replace the global cache with an equivalent
  relay-scoped design.
- Keep `BUNDLED_CATALOG` strictly ICRC/facade data. Do not add fake Solana descriptors.
- Model Solana network + USDC mint as one coherent configuration. If the active cluster has no
  configured mint, omit/fail closed on Solana USDC rather than using mainnet USDC on devnet.

**Exit criteria**

- One pure function produces the complete selectable list.
- No component constructs a synthetic currency row.
- No Solana asset appears in catalog truth, relay responses, or IC IDs.

### Phase 2 — Honest Solana SOL and USDC balance state

**Primary files**

- `app/solana/rpc.ts`
- `app/solana.ts`
- `app/solana/spl.ts`
- `app/config/constants.ts`
- Replace `app/hooks/useSolanaBalance.ts` with `app/hooks/useSolanaBalances.ts`
- `app/__tests__/solana-rpc.test.ts`
- `app/__tests__/solana-seam.test.ts`
- `app/__tests__/solana-spl.test.ts`

**RED tests first**

- Native SOL and SPL token balances are returned independently.
- SPL `getTokenAccountBalance` preserves exact decimal strings; no JS `number` money path.
- Missing ATA is represented as known absent/zero, not RPC unavailable.
- RPC failure does not turn a prior value into zero.
- Mainnet mint + non-mainnet RPC configuration fails closed.
- Empty test RPC configuration performs no network request.

**Implementation**

- Poll native lamports and the device's configured USDC ATA concurrently with independent statuses.
- Add exact-string token-account balance RPC support.
- Return Solana RPC availability independently from relay `online`.
- Preserve generation guards and abort in-flight requests on identity/network changes.
- Expose targeted refresh so a confirmed SOL send refreshes SOL and a confirmed SPL send refreshes
  USDC without conflating them.

**Exit criteria**

- Wallet can truthfully render distinct SOL and Solana-USDC rows.
- Missing ATA, zero, loading, stale/unavailable, and RPC error remain distinguishable.

### Phase 3 — One Wallet selection and one picker contract

**Primary files**

- `app/components/Wallet.tsx`
- `app/components/BalancesSheet.tsx`
- `app/components/CurrencyRow.tsx`
- New `app/components/AssetPicker.tsx`
- `app/styles.ts`
- `e2e/tests/54-testnet-toggle.mjs`
- `e2e/tests/55-balances-select-asset.mjs`
- Rename/rewrite `e2e/tests/63-picker-sol-rail.mjs`
- `e2e/tests/41-a11y-census.mjs`

**RED tests first**

- Selecting any row updates header, active row, and the open picker consistently.
- Both USDC assets render with distinct network labels and balances.
- Hiding the selected testnet applies the deterministic fallback and correct engine.
- A missing Solana address cannot produce a Solana header over an IC engine.

**Implementation**

- Replace `currentCurrency` + `activeSol` with `selectedAssetId`.
- Resolve `selectedAsset` every render from the current complete asset list.
- Aggregate balances by `AssetId`; do not index Solana values into IC currency records.
- Derive header text, amount, connectivity, available actions, and idle protocol from
  `selectedAsset`.
- Give Balances and modal pickers the same contract: `assets`, `selectedId`, `balances`,
  `disabled`, and `onSelect(id)`.
- Keep `CurrencyRow` purely presentational. `AssetPicker` owns reusable picker rendering, not asset
  construction.
- Reset Pay/Receive idle submodes and drafts after deliberate asset selection.

**Exit criteria**

- `grep` finds no `activeSol` and no separate `onSelectSol` contract.
- One ID drives header, active indicator, deposit/send capabilities, and protocol dispatch.
- No backward-compatibility props or duplicate selectors remain.

### Phase 4 — Merchant Receive forms use the selected asset

**Primary files**

- `app/components/ReceiveMode.tsx`
- `app/components/SolReceiveMode.tsx`
- `app/components/SolanaReceiveSheet.tsx`
- `app/components/AssetPicker.tsx`
- Existing request/receive e2e flows 06, 25, 28, 45, 51, 53, 62
- New `e2e/tests/69-sol-usdc-selection.mjs`

**RED tests first**

- Balances selection is reflected by the Receive prefix and open picker.
- Every Receive prefix opens the same complete asset list.
- Switching IC USDC ↔ Solana USDC changes protocol/network and clears old amount/memo.
- The encoded request contains the exact selected asset.
- Solana-USDC request creation fails closed when destination ATA is absent or unverifiable.

**Implementation**

- Remove `ReceiveMode.reqCurrency`; require the selected IC asset as a prop.
- Remove `SolReceiveMode.cur`; require selected `SOL | USDC` as a prop.
- Both amount prefixes open `AssetPicker` with the same Wallet-owned selection callback.
- Derive request encoding internally: IC currency ID, `solreq.cur='SOL'`, or
  `solreq.cur='USDC'` with the configured mint and derived destination ATA.
- Replace “unknown, allow” ATA behavior with retryable fail-closed UI.
- Make “My address” asset-aware: native SOL address versus SPL-USDC ATA instructions and readiness.

**Exit criteria**

- `grep` finds no `reqCurrency` and no binary `setCur` toggle.
- SOL behavior and IC request bytes remain pinned and unchanged.
- A request can never promise an unfulfillable destination silently.

### Phase 5 — Exact payer request lock and deeplink routing

**Primary files**

- `app/components/Wallet.tsx`
- `app/components/PayMode.tsx`
- `app/components/SolPayMode.tsx`
- `app/components/BalancesSheet.tsx`
- `app/lib/deepLink.ts`
- `app/solana/qr.ts`
- Existing payer/deeplink e2e flows 27, 31, 46, 47, 49, 50
- New `e2e/tests/70-request-asset-lock.mjs`
- New `e2e/tests/71-deeplink-from-solana.mjs`

**RED tests first**

- Opening Balances during review cannot substitute or unmount the requested asset.
- IC USDC requests check IC USDC only; Solana USDC requests check Solana USDC only.
- SOL requests check SOL only; online known insufficiency blocks approval.
- Foreground `dpay:req` and `dpay:pay` work when either Solana asset was selected.
- Malformed deeplinks do not change selection or approve anything.

**Implementation**

- Have each engine report a decoded request's exact `AssetId` and request lifecycle to Wallet.
- Lock selection during review, signed-QR/NFC handoff, and settlement.
- Keep all money-critical operations bound to the immutable decoded request.
- IC unknown/retired currency IDs remain unsupported and never sign.
- Add Solana asset-specific balance and source-ATA gates. Offline/stale balance knowledge may warn,
  but must never imply conversion or known sufficiency.
- Route current `dpay:req` / `dpay:pay` formats explicitly to the IC engine regardless of idle
  selection. Do not add a Solana deeplink format in this rewrite.

**Exit criteria**

- Selection cannot alter an active payment's asset.
- Cancel unlocks selection while retaining the decoded asset as the idle selection.
- Receipt/request matching remains protocol-specific and exact.

### Phase 6 — Asset-aware direct Solana actions

**Primary files**

- `app/components/SolPayMode.tsx`
- `app/components/SolanaWithdrawSheet.tsx`
- `app/components/SolanaReceiveSheet.tsx`
- `app/solana.ts`
- `app/solana/spl.ts`
- `app/solana/rpc.ts`
- `e2e/tests/52-sol-withdraw.mjs`
- New `e2e/tests/72-sol-usdc-send.mjs`

**RED tests first**

- Selecting Solana USDC never displays, checks, or debits native SOL as the transfer amount.
- Native SOL and SPL transfer builders are byte-exact and separate.
- Source ATA, token balance, destination owner/address, and destination ATA readiness gate SPL send.
- Unsupported destination ATA creation fails closed with explicit guidance.

**Implementation**

- Parameterize direct Solana send/receive surfaces by selected token.
- Keep native SOL on its existing transfer builder.
- Add a separate SPL-USDC transfer builder/seam; do not turn the native builder into a misleading
  generic conditional implementation.
- Do not silently create an ATA unless a separately tested, fee-disclosed transaction path is
  implemented. Until then, explain the requirement and fail closed.

**Exit criteria**

- Direct actions honor the selected Solana asset end to end.
- No swap, fallback, or hidden SOL fee/value substitution is offered.

### Phase 7 — Full verification, visual review, production reconciliation, and docs

**Test and documentation files**

- All focused Jest/e2e files above
- `e2e/harness/lib.mjs` only where a genuinely shared action is needed
- `e2e/tests/35-ux-tour.mjs`
- `e2e/tests/39-store-screens.mjs`
- `e2e/tests/40-visual-regression.mjs`
- `e2e/shots/baselines/*` only for inspected intentional drift
- `FLOWS.md` regenerated from metadata
- `CODEBASE_ANALYSIS.md`
- `OPEN_ISSUES.md` only for genuinely unresolved follow-ups

**Required gates**

- Focused Jest and `DPAY_E2E_FILTER=...` tests during each phase.
- `just typecheck`, `just bridge-parity`, and `just aid-parity`.
- `just verify` with the full browser suite.
- `just e2e-visual`; reseed only intentional baselines after screenshot inspection.
- Chrome screenshots + zai-vision review of Balances and each open picker state at phone and desktop
  widths. Do not use mocks for the final UX review.
- Reconcile the production `/api/v1/currencies` response against rendered IC rows; prove no fake
  Solana rows entered the relay catalog.
- Drive the real Android app against the real relay/RPC and inspect both USDC rows, zero balances,
  unavailable balances, and selection back-and-forth.
- `just app`; assert `DPAY_SELFCHECK PASS` and `DPAY_SOL_SELFCHECK PASS`.
- `just ondevice`; all current instrumented tests pass.
- Exercise cold + warm Android `dpay:req` and `dpay:pay`, including a warm link while Solana USDC is
  selected.
- Exercise IC ↔ SOL ↔ Solana-USDC switching and confirm the correct NFC AID engine arms/disarms with
  no stale listener/session state.
- Update `CODEBASE_ANALYSIS.md` with the one-selection invariant, request lock, complete asset-list
  boundary, and Solana-USDC balance/ATA/connectivity surfaces.

## Coverage matrix

| Behavior | Unit/Jest | Browser e2e | Real device/prod |
|---|---|---|---|
| Asset IDs/list/filter/fallback | `assets.test.ts` | flows 54, 55, rewritten 63 | prod catalog reconciliation |
| SOL + Solana-USDC balances | rpc/seam/hook tests | flow 69 + RPC seam | real RPC, missing/zero ATA states |
| Balances → Receive consistency | pure selection tests | rewritten 55/63, flow 69 | manual app selection loop |
| Exact merchant request asset | QR/request tests | flows 25, 28, 51, 69 | QR + NFC spot checks |
| Payer request lock | payment state tests | flow 70 | request review + Balances |
| Deeplink protocol dispatch | deeplink tests | flows 49, 50, 71 | cold/warm Android intents |
| SOL/SPL direct send | tx/SPL goldens | flows 52, 72 | real RPC readiness/errors |
| NFC lifecycle | existing state tests | flows 11, 47 | AID arm/disarm on emulator/device |
| Visual/accessibility | formatting/a11y tests | flows 35, 39, 40, 41 | screenshot + zai-vision |

## Explicit non-goals

- No user-facing rail selector or protocol terminology.
- No facade, canister, relay-catalog, Rust-core, or frozen IC wire changes.
- No conversion or swap between assets or networks.
- No giant shared payment component that interleaves IC and Solana money logic.
- No fake `CurrencyDescriptor` for SOL or Solana USDC.
- No compatibility wrappers preserving `activeSol`, `reqCurrency`, `onSelectSol`, or old picker props.
- No selection persistence/migration in this change.
- No new Solana deeplink scheme.
- No source/destination ATA auto-creation unless separately designed, fee-disclosed, and tested.

## Risks and controls

| Risk | Control |
|---|---|
| Selection update remounts an active request | Immutable request snapshot + explicit lock; key only idle forms |
| IC and Solana NFC services arm together | Mount/arm only the selected/requested engine; device lifecycle test |
| Catalog cache race changes descriptors | Store stable ID only; validate and reconcile every catalog source |
| Hidden/removed selection leaves stale draft | Atomic fallback + idle-form reset |
| Two USDC assets are confused | Stable network-qualified IDs and labels everywhere |
| RPC failure appears as zero | Explicit balance/ATA/connectivity status union |
| Mainnet mint is used on devnet | Coherent network/mint config; fail closed |
| Shared UI leaks protocol logic | Pure asset list + presentational picker; engines remain isolated |
| SPL send reuses SOL transfer semantics | Separate byte-exact SPL builder and tests |
| Green e2e checks only header text | End-to-end assertions across header, picker, request bytes, engine, and balance gate |

## Definition of done

- One complete asset list and one selected ID govern every idle wallet surface.
- Selecting an asset in Balances is immediately reflected in every dropdown and action.
- SOL and Solana USDC behave as first-class assets, not a hidden rail or binary toggle.
- Both USDC assets are unmistakably network-qualified and financially isolated.
- Active payer requests cannot be changed, substituted, or unmounted by selection.
- Deeplinks route to the correct protocol regardless of prior idle selection.
- `activeSol`, `reqCurrency`, local Solana `cur`, `onSelectSol`, and component-owned list construction
  are deleted, not wrapped.
- IC and Solana protocol implementations remain separate and byte-exact behind one asset-driven
  dispatch boundary.
- Focused tests, `just verify`, visual review, production reconciliation, and Android device gates
  are green, with `FLOWS.md`, `CODEBASE_ANALYSIS.md`, and `OPEN_ISSUES.md` current.
