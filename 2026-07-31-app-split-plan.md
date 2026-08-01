# 2026-07-31 — `app/App.tsx` split plan (Phase 3)

> **Scope:** decompose `app/App.tsx` (**2394 lines**, over the repo's 2k-line split threshold) into
> logical modules behind the e2e safety net (24 flows, ~14s, `just e2e`). **Pure refactor — zero
> user-visible behavior change.** Every extraction step must leave `just e2e` green.
>
> Hard rules (from `CLAUDE.md` / `AGENTS.md` / the master plan §0): single source of truth, no dead
> code, no backward-compat shims, no behavior change. Living docs (`CODEBASE_ANALYSIS.md`,
> `OPEN_ISSUES.md`, `AGENTS.md`) updated in the change that lands the split.

## 0. Critical constraints discovered (read before executing)

1. **The e2e net does NOT pixel/style-assert.** `e2e/tests/*.mjs` + `e2e/harness/driver.mjs` match
   elements by **testID + textContent only**; `screenshot()` writes PNGs to `e2e/shots/` for *human*
   review but there is **no `pixelmatch`/`toMatchImage` comparison**. **Consequence:** a style-key
   partition mistake (dropping/misnaming a key during co-location) would leave `just e2e` GREEN while
   silently breaking the UI. → This is the decisive reason `S` is extracted as ONE unchanged
   `styles.ts` (§2, §4), not co-located during the split.
2. **The e2e entry is `import App from '../../app/App'`** (`e2e/web/entry.tsx:16`). Vite resolves the
   real `app/App.tsx` with `server.fs.allow = [REPO_ROOT]` and the extension list
   `['.web.tsx','.tsx','.web.ts','.ts',…]`. Any new module under `app/` that `App.tsx` imports is
   resolved identically — **the split needs no `vite.config.js` change** as long as relative imports
   stay within `app/`.
3. **The `relayConfig` alias is `^\.\.?\/relayConfig$`** (`e2e/vite.config.js:82`) — anchored, matches
   `./relayConfig` AND `../relayConfig` from any depth. So a module in `app/config/` importing
   `../relayConfig` still hits the e2e override. **But:** only `App.tsx` root consumes
   `RELAY_DEFAULT` today and it stays there as `./relayConfig` — do NOT spread relayConfig imports;
   keep `relayUrl` threaded as a prop (the existing pattern). Zero risk.
4. **`NativeModules.DpayCore`/`DpayNfc` is a shared RNW singleton.** `e2e/web/shims.ts` mutates it
   *before* `app/App` evaluates (entry.tsx imports `./shims` first). A new `services/native.ts` that
   reads `NativeModules` at module-eval time evaluates after the shims (it's imported transitively by
   App), so the timing is identical to today. Safe to centralize the one destructuring there.
5. **`POLL` reads `globalThis.__DPAY_TEST_POLL` at module-load** (harness injects it via
   `page.evaluateOnNewDocument` before the bundle runs). Keep `POLL` a module-level `const` in
   `config/constants.ts` so its evaluation order is preserved. Do not turn it into a function call
   site-by-site.
6. **`app/tsconfig.json` extends RN config with NO path aliases** — all imports are relative. The
   plan uses relative imports only (no `@/` to introduce/maintain).
7. **Existing separate files are already correct and stay put:** `app/payments.ts` (pure settlement
   logic), `app/relayConfig.ts` (codegen'd `RELAY_DEFAULT`), `app/cketh.ts` (ckERC-20 calldata),
   `app/wallet.ts` (EIP-1193 seam). The split *consumes* them; it does not move them.

---

## 1. Module inventory (current `app/App.tsx`, line ranges + responsibility)

> Grouped by the module they move into. `→` = "moves to". Lines are 1-indexed inclusive from the
> 2394-line file.

### Foundations (no React components)

| Lines | Symbol | Responsibility | → module |
|------:|--------|----------------|----------|
| 30 | `const {DpayCore, DpayNfc} = NativeModules` | native-module binding | `services/native.ts` |
| 36–50 | `verifyOutcomeReceipt(receipt)` | R2 receipt-sig verify (calls `DpayCore.verifyReceiptSig`) | `services/receipt.ts` |
| 54–68 | `type DpayNfcApi` | NFC native-module surface | `lib/types.ts` |
| 70–78 | `type NfcEvent`, `type NfcPhaseName` | NFC event/phase types | `lib/types.ts` |
| 80–84 | `type Req`, `type Identity`, `type Txn`, `type TransactionsRow` | core domain types | `lib/types.ts` |
| 85–106 | `type DpayCoreApi` | core native-module surface | `lib/types.ts` |
| 108 | `type NfcStatus` | NFC radio status union | `lib/types.ts` |
| 110–117 | `const C` | dark palette | `config/palette.ts` |
| 118–133 | `EXPIRY_WINDOW`, `DIRECT_PAY_TIMEOUT_MS`, `NFC_PAY_TIMEOUT_MS`, `RECONCILE_ATTEMPTS`, `RECONCILE_INTERVAL_MS`, `RECEIPT_WAIT_MS`, `STORAGE_KEY`, `RELAY_STORAGE_KEY` | timeouts + storage keys | `config/constants.ts` |
| 135 | `usd(c)` | cents → `$X.YY` | `lib/format.ts` |
| 136 | `short(h)` | hex → `abcd1234…` | `lib/format.ts` |
| 140–141 | `MINT_HEX`, `isMintSentinel(h)` | mint-sentinel detection (N4) | `lib/format.ts` |
| 144 | `fmtTime(ts)` | unix-secs → `HH:MM` | `lib/format.ts` |
| 145 | `nowSecs()` | `Date.now()/1000` | `lib/format.ts` |
| 146–150 | `randNonceHex()` | 16-byte random hex nonce | `lib/format.ts` |
| 151 | `toCents(s)` | `"$25.00"` → cents | `lib/format.ts` |
| 152 | `base(u)` | strip trailing `/` from relay URL | `lib/format.ts` |
| 154–157 | `parseRequestQR(raw)` | split `<reqB64>|<name>` | `lib/format.ts` |
| 169–178 | `POLL` | poll intervals (reads `__DPAY_TEST_POLL`) | `config/constants.ts` |
| 179–180 | `WITHDRAW_TIMEOUT_MS`, `WITHDRAW_EXPIRY_WINDOW` | withdraw bounds | `config/constants.ts` |
| 181–184 | `type DepositInfo`, `MintedUtxo`, `PendingUtxo`, `DepositRefresh` | deposit response shapes | `services/relay.ts` (co-located) |
| 192–201 | `type MinterFamily`, `type CurrencyDescriptor` | catalog domain types | `config/catalog.ts` |
| 202 | `CATALOG_CACHE_KEY` | AsyncStorage key | `config/catalog.ts` |
| 207–211 | `BUNDLED_CATALOG` | offline-first fallback catalog | `config/catalog.ts` |
| 215–239 | `fetchCurrencies(relayUrl, prior)` | GET /currencies + cache | `config/catalog.ts` |
| 245–263 | `type FamilyDisplay`, `FD_CKBTC`, `FD_CKETH_ERC20`, `FAMILY_DISPLAY` | per-family rail/display config | `config/catalog.ts` |
| 266–269 | `familyDisplay(catalog, currency)` | resolve family display | `config/catalog.ts` |
| 272–275 | `assetTestKey(a)` | stable testID key | `config/catalog.ts` |
| 278–282 | `fmtAsset(raw, decimals, unit)` | raw units → `"0.00012345 BTC"` | `lib/format.ts` |
| 286–301 | `depositInfo`, `depositAddress`, `depositRefresh` | relay deposit client | `services/relay.ts` |
| 307–312 | `type CkErc20OnrampParams`, `ckerc20OnrampParams` | onramp params fetch | `services/relay.ts` |
| 317 | `type WithdrawReceipt` | withdraw response shape | `services/relay.ts` (co-located) |
| 321–327 | `withdrawAddrKey`, `loadSavedWithdrawAddr`, `saveWithdrawAddr` | saved-destination persistence (Fork-B) | `services/withdraw.ts` |
| 329–342 | `withdrawFunds(...)` | POST /withdraw | `services/relay.ts` |
| 346 | `toSats(s)` | BTC decimal → sats | `lib/format.ts` |
| 355–376 | `copyToClipboard(text)` | clipboard + Share fallback | `hooks/clipboard.ts` |
| 396–428 | `useHotkeys(handlers, opts)` | web keyboard surface (single source) | `hooks/useHotkeys.ts` |
| 435–437 | `useEscapeToClose(onClose)` | thin Esc wrapper | `hooks/useHotkeys.ts` |
| 445–457 | `readFromClipboard()` | clipboard read (N10 paste path) | `hooks/clipboard.ts` |
| 464–477 | `readDepositDeepLink()` | web `?screen=deposit` | `hooks/useDeepLink.ts` |
| 482 | `D_PATH` | logo path data | `components/Logo.tsx` |
| 484–502 | `Logo({size})` | SVG emblem | `components/Logo.tsx` |
| 504–510 | `Wordmark({style})` | "dpay" text mark | `components/Logo.tsx` |
| 2248–2394 | `const S = StyleSheet.create({...})` | the entire style sheet (~147 keys) | `styles.ts` |

### React components

| Lines | Component | Responsibility | → module |
|------:|-----------|----------------|----------|
| 512–564 | `App` (default export) | root: load identity+relay, route Onboarding\|Wallet, self-check | `App.tsx` (thinned) |
| 566–607 | `Onboarding` | username → generate key → fund | `components/Onboarding.tsx` |
| 609–957 | `Wallet` | **the container** — header, tabs, body, ramp cards, history, all sheets, polls, topUp, hotkeys | `components/Wallet.tsx` |
| 959–966 | `Tab` | pay/receive tab button | `components/Tab.tsx` |
| 968–986 | `HotkeyHint` | web kbd badge (shared by Tab, header, Add-money) | `components/HotkeyHint.tsx` |
| 991–1007 | `NFC_PILL` + `NfcPill` | NFC radio status chip | `components/NfcPill.tsx` |
| 1009–1030 | `QrScanner` | vision-camera QR scanner (permission/focus-aware) | `components/QrScanner.tsx` |
| 1032–1045 | `NFC_UI` | phase → status-view map | `components/NfcTap.tsx` (co-located) |
| 1047–1299 | `NfcTap` | NFC tap state machine (card/reader), reconcile, receipt verify | `components/NfcTap.tsx` |
| 1301–1479 | `PayMode` | scan → review → sign → pay/QR hand-off | `components/PayMode.tsx` |
| 1481–1598 | `ReceiveMode` | amount → request QR → poll → scan signed QR | `components/ReceiveMode.tsx` |
| 1600–1792 | `DepositSheet` | ckBTC-style native-chain deposit | `components/DepositSheet.tsx` |
| 1794–1938 | `WithdrawSheet` | ckBTC → native BTC offramp (on-device sig) | `components/WithdrawSheet.tsx` |
| 1940–2025 | `SettingsSheet` | relay URL, demo faucet, reset-confirm | `components/SettingsSheet.tsx` |
| 2027–2063 | `AssetPickerSheet` | pick ramp asset when >1 exists | `components/AssetPickerSheet.tsx` |
| 2065–2246 | `CkErc20DepositSheet` | ckUSDC wallet-connect onramp | `components/CkErc20DepositSheet.tsx` |

---

## 2. Proposed module structure

```
app/
  App.tsx                      root (~50 lines): load identity+relay, self-check, route Onboarding|Wallet
  relayConfig.ts               EXISTING — RELAY_DEFAULT (codegen). Unchanged.
  payments.ts                  EXISTING — pure settlement logic. Unchanged.
  cketh.ts                     EXISTING — ckERC-20 calldata. Unchanged.
  wallet.ts                    EXISTING — EIP-1193 seam. Unchanged.
  config/
    palette.ts                 const C (dark palette)                       ~12 LOC
    constants.ts               timeouts, STORAGE_KEYs, RELAY_STORAGE_KEY,
                               EXPIRY_WINDOW, MINT_HEX-less consts, POLL,
                               WITHDRAW_*                                  ~40 LOC
    catalog.ts                 MinterFamily, CurrencyDescriptor, FamilyDisplay,
                               BUNDLED_CATALOG, CATALOG_CACHE_KEY,
                               fetchCurrencies, FD_*, FAMILY_DISPLAY,
                               familyDisplay, assetTestKey                ~100 LOC
  lib/
    types.ts                   Req, Identity, Txn, TransactionsRow, NfcStatus,
                               DpayCoreApi, DpayNfcApi, NfcEvent, NfcPhaseName  ~55 LOC
    format.ts                  usd, short, MINT_HEX, isMintSentinel, fmtTime,
                               nowSecs, randNonceHex, toCents, toSats, base,
                               parseRequestQR, fmtAsset                    ~50 LOC
  hooks/
    useHotkeys.ts              useHotkeys + useEscapeToClose               ~60 LOC
    clipboard.ts               copyToClipboard + readFromClipboard         ~50 LOC
    useDeepLink.ts             readDepositDeepLink                         ~20 LOC
  services/
    native.ts                  const {DpayCore, DpayNfc} = NativeModules
                               (single destructuring point)                ~10 LOC
    receipt.ts                 verifyOutcomeReceipt (R2)                    ~25 LOC
    relay.ts                   depositInfo/depositAddress/depositRefresh,
                               ckerc20OnrampParams, withdrawFunds +
                               co-located response types (DepositInfo,
                               DepositRefresh, WithdrawReceipt,
                               CkErc20OnrampParams)                       ~65 LOC
    withdraw.ts                withdrawAddrKey/loadSavedWithdrawAddr/
                               saveWithdrawAddr                            ~15 LOC
  styles.ts                    const S = StyleSheet.create({...}) — ONE block ~147 LOC
  components/
    Logo.tsx                   D_PATH, Logo, Wordmark                      ~30 LOC
    HotkeyHint.tsx             web kbd badge                               ~20 LOC
    Tab.tsx                    Tab button (imports HotkeyHint)             ~10 LOC
    NfcPill.tsx                NFC_PILL + NfcPill                          ~20 LOC
    QrScanner.tsx              vision-camera scanner                       ~22 LOC
    NfcTap.tsx                 NFC_UI + NfcTap (card/reader state machine) ~270 LOC
    PayMode.tsx                scan→review→sign→pay                        ~180 LOC
    ReceiveMode.tsx            amount→request QR→poll→scan                 ~120 LOC
    DepositSheet.tsx           ckBTC native-chain deposit                  ~195 LOC
    WithdrawSheet.tsx          ckBTC offramp                               ~145 LOC
    SettingsSheet.tsx          relay/faucet/reset                          ~85 LOC
    AssetPickerSheet.tsx       ramp-asset picker                           ~40 LOC
    CkErc20DepositSheet.tsx    ckUSDC wallet-connect onramp                ~185 LOC
    Onboarding.tsx             username→key→fund                           ~45 LOC
    Wallet.tsx                 the container                               ~350 LOC
```

**Module count:** 27 new files (3 config + 2 lib + 3 hooks + 4 services + 1 styles + 14 components),
plus the thinned `App.tsx`. `App.tsx` goes 2394 → **~50 lines**. The largest post-split file is
`components/Wallet.tsx` (~350) — well under threshold. `NfcTap.tsx` (~270) is the next largest.

**Dependency direction (no cycles):** `lib/` & `config/` are leaves (no upward imports) → `hooks/` &
`services/` depend only on `lib/`/`config/`/native → `components/` depend on all of the above →
`App.tsx` depends on `components/` only. Nothing imports `Wallet` except `App.tsx`. Verified acyclic.

---

## 3. Extraction order (dependency-safe, each behind the e2e net)

> **Mechanism per step:** (1) create the new file(s) with the moved code, exported as named exports;
> (2) in `App.tsx`, **delete** the inline definition and **add** the matching `import` (this is the
> GREENFIELD rule — move, don't copy; no dead code); (3) run `just e2e`. Because inline component
> functions still in `App.tsx` read module-scope bindings, an added `import` makes the binding
> available to all remaining inline code in one edit.
>
> **Verification gate every step:** `just e2e` (full 24-flow suite, ~14s). For faster inner-loop
> iteration the implementer MAY use `DPAY_E2E_FILTER=NN node e2e/run.mjs` on a single relevant flow,
> but the **commit gate is the full `just e2e`**. Also run `cd app && npx tsc --noEmit` after steps
> that move types (cheap; catches import-path typos the e2e bundle would also catch but with better
> messages).
>
> Steps are ordered **least-coupled → most-coupled**. Within a phase, files marked **[batchable]**
> are mutually independent and may be extracted in a single commit+e2e run to cut total iterations
> (~16 runs instead of ~27). Keep one-file-per-commit on any **[solo]** step for easy bisection.

### Phase A — Foundations (pure leaves; lowest risk)

**Step 1 [batchable] — `config/palette.ts` + `lib/types.ts`.** Move `const C` and all `type`
declarations (DpayNfcApi, NfcEvent, NfcPhaseName, Req, Identity, Txn, TransactionsRow, DpayCoreApi,
NfcStatus). `App.tsx`: `import {C} from './config/palette'` + `import type {...} from './lib/types'`.
*Risk: low.* Types are erased at runtime; `C` is a plain object read by inline components.

**Step 2 [batchable] — `lib/format.ts` + `config/constants.ts`.** Move all pure helpers
(`usd`,`short`,`MINT_HEX`,`isMintSentinel`,`fmtTime`,`nowSecs`,`randNonceHex`,`toCents`,`toSats`,
`base`,`parseRequestQR`,`fmtAsset`) and the constants block (`EXPIRY_WINDOW`, the `*_TIMEOUT_MS`,
`RECONCILE_*`, `RECEIPT_WAIT_MS`, `STORAGE_KEY`, `RELAY_STORAGE_KEY`, `POLL`, `WITHDRAW_*`).
`App.tsx`: two new imports. **Keep `POLL` a module-level const** (constraint §0.5).
*Risk: low.* Pure functions; no React.

**Step 3 [solo] — `config/catalog.ts`.** Move `MinterFamily`, `CurrencyDescriptor`, `FamilyDisplay`,
`CATALOG_CACHE_KEY`, `BUNDLED_CATALOG`, `fetchCurrencies`, `FD_CKBTC`, `FD_CKETH_ERC20`,
`FAMILY_DISPLAY`, `familyDisplay`, `assetTestKey`. Imports: `AsyncStorage` from `react-native`,
`base` from `../lib/format`. `App.tsx`: `import {...} from './config/catalog'`.
*Risk: low.* `fetchCurrencies` is the only I/O (already best-effort).

**Step 4 [solo] — `styles.ts`.** Move `const S = StyleSheet.create({...})` **verbatim, unchanged**.
`styles.ts` imports `{C} from './config/palette'`. `App.tsx`: `import {S} from './styles'`.
*Risk: low — but pivotal.* This is a 1:1 move of one object; **do not partition `S`** (constraint §0.1:
e2e cannot catch a dropped/misnamed key). After this, every later component extraction imports `{S}`
and `{C}`.

**Step 5 [batchable] — `hooks/useHotkeys.ts` + `hooks/clipboard.ts` + `hooks/useDeepLink.ts`.** Move
`useHotkeys`+`useEscapeToClose` (one file — single source for kbd wiring), `copyToClipboard`+
`readFromClipboard`, and `readDepositDeepLink`. Each imports `Platform` from `react-native`;
`useHotkeys` also imports `useEffect` from `react`. `App.tsx`: three imports.
*Risk: low.*

**Step 6 [batchable] — `services/native.ts` + `services/receipt.ts` + `services/relay.ts` +
`services/withdraw.ts`.** `native.ts`: `import {NativeModules} from 'react-native'; export const
{DpayCore, DpayNfc} = NativeModules as {DpayCore: DpayCoreApi; DpayNfc: DpayNfcApi};` (single
destructuring point — replaces App.tsx line 30). `receipt.ts`: `verifyOutcomeReceipt` (imports
`{DpayCore} from './native'`, `DpayCoreApi` type). `relay.ts`: the five fetch clients + their
co-located response types. `withdraw.ts`: the three saved-addr functions. `App.tsx`: import
`{DpayCore,DpayNfc}` from `./services/native` (replaces inline destructure) + the service imports.
*Risk: low.* Constraint §0.4 guarantees the singleton-read timing is unchanged.

### Phase B — Leaf presentational components (no child-component deps)

**Step 7 [batchable] — `components/Logo.tsx` + `HotkeyHint.tsx` + `NfcPill.tsx`.** `Logo.tsx`: `D_PATH`,
`Logo`, `Wordmark` (imports `react-native-svg`, `{S}`, `{C}`). `HotkeyHint.tsx`: `HotkeyHint`
(imports `{S}`, `Platform`). `NfcPill.tsx`: `NFC_PILL` + `NfcPill` (imports `{C}`, `{S}`,
`NfcStatus` type). *Risk: low.*

**Step 8 [batchable] — `components/Tab.tsx` + `components/QrScanner.tsx`.** `Tab.tsx` imports
`{HotkeyHint} from './HotkeyHint'`, `{S}`. `QrScanner.tsx` imports `react-native`,
`react-native-vision-camera`, `{S}`. *Risk: low.*

### Phase C — Mid components (depend on leaves + services)

**Step 9 [solo] — `components/NfcTap.tsx`.** Move `NFC_UI` + `NfcTap` (the largest mid component,
~270 LOC). Imports: types (`NfcEvent`,`NfcPhaseName`,`Identity`), `{classifyPayHttp,receiptCodeFor,
decidePayerReceipt,rejectionMessage,isNonceReused}` from `../payments`, `{verifyOutcomeReceipt}` from
`../services/receipt`, `{DpayCore,DpayNfc}` from `../services/native`, `{usd,short}` from
`../lib/format`, `{NFC_PAY_TIMEOUT_MS,RECONCILE_*,RECEIPT_WAIT_MS}` from `../config/constants`,
`{C}` + `{S}` + `react-native`. *Risk: medium* — it is the most stateful component (refs, timer,
emitter lifecycle). **Run `DPAY_E2E_FILTER=11 node e2e/run.mjs` (NFC phase flow) first, then full
`just e2e`.** The NFC seam (`e2e/web/dpay-nfc.ts`) drives the real bus, so a wiring regression is
caught.

**Step 10 [batchable] — `components/PayMode.tsx` + `components/ReceiveMode.tsx`.** Each imports
`{NfcTap}` from `./NfcTap`, `{QrScanner}` from `./QrScanner`, `{readFromClipboard}` from
`../hooks/clipboard`, `{verifyOutcomeReceipt}` from `../services/receipt`, `{DpayCore}` from
`../services/native`, `{parseRequestQR,usd,short,toCents,randNonceHex,nowSecs,base}` from
`../lib/format`, `{EXPIRY_WINDOW,DIRECT_PAY_TIMEOUT_MS,POLL}` from `../config/constants`,
`{classifyPayHttp,...}` from `../payments`, `{C}`+`{S}`, `QRCode`, `Share`. *Risk: medium.* Both are
driven by ≥5 flows (07/08/09/10/19/20/21); the net covers them densely.

**Step 11 [batchable] — `components/SettingsSheet.tsx` + `components/AssetPickerSheet.tsx`.** Simple
sheets. `SettingsSheet` imports `{useEscapeToClose}` from `../hooks/useHotkeys`, `{C}`+`{S}`.
`AssetPickerSheet` adds `{familyDisplay,assetTestKey}` from `../config/catalog`. *Risk: low.*
Covered by flows 02/12/23.

**Step 12 [batchable] — `components/DepositSheet.tsx` + `components/WithdrawSheet.tsx`.**
`DepositSheet` imports the relay client fns from `../services/relay`, `{copyToClipboard}` from
`../hooks/clipboard`, `{useEscapeToClose}`, `{fmtAsset,base}` from `../lib/format`,
`{POLL}` from `../config/constants`, `{FamilyDisplay}` type, `{C}`+`{S}`, `QRCode`. `WithdrawSheet`
adds `{withdrawFunds}` from `../services/relay`, `{loadSavedWithdrawAddr,saveWithdrawAddr}` from
`../services/withdraw`, `{toSats,randNonceHex,nowSecs,fmtAsset}` from `../lib/format`,
`{DpayCore}` from `../services/native`, `{WITHDRAW_*}` from `../config/constants`. *Risk: medium.*
Covered by flows 03/04/05/15/18/22 (deposit incl. credited top-up; withdraw error paths).

**Step 13 [solo] — `components/CkErc20DepositSheet.tsx`.** Imports `{ckerc20OnrampParams}` from
`../services/relay`, `{encodeApprove,encodeDepositErc20,principalToBytes32}` from `../cketh`,
`{getEthereumProvider,connectWallet,sendTransaction}` from `../wallet`, `{useEscapeToClose}`,
`{fmtAsset,base}` from `../lib/format`, `{POLL}` from `../config/constants`, `{FamilyDisplay}`,
`{DpayCore}` (none actually — uses wallet.ts not DpayCore; verify on extraction), `{C}`+`{S}`.
*Risk: medium.* Covered by flow 16 (calldata byte-exact vs goldens) — the byte-exact assertion is the
strong guard.

### Phase D — Top

**Step 14 [solo] — `components/Onboarding.tsx`.** Imports `{DpayCore}` from `../services/native`,
`{STORAGE_KEY}` from `../config/constants`, `{base,randNonceHex}` from `../lib/format`, `{Identity}`
type, `{C}`+`{S}`, `AsyncStorage`. *Risk: low.* Covered by flows 01/23 (Enter-to-create +
username-default).

**Step 15 [solo] — `components/Wallet.tsx` (the container).** The last big move. Imports nearly
everything: `{Tab}` from `./Tab`, `{NfcPill}` from `./NfcPill`, `{HotkeyHint}` from `./HotkeyHint`,
`{PayMode}`,`{ReceiveMode}`,`{DepositSheet}`,`{WithdrawSheet}`,`{SettingsSheet}`,
`{AssetPickerSheet}`,`{CkErc20DepositSheet}`, `{useHotkeys}` from `../hooks/useHotkeys`,
`{DpayCore}` from `../services/native`, `{usd,short,isMintSentinel,fmtTime}` from `../lib/format`,
`{TOP_UP_CENTS?}` (currently inline at 639 — move to constants or keep local; **move to
`config/constants.ts`** for single source), `{readDepositDeepLink}` from `../hooks/useDeepLink`,
`{BUNDLED_CATALOG,CATALOG_CACHE_KEY,fetchCurrencies,familyDisplay,assetTestKey,CurrencyDescriptor}`
from `../config/catalog`, `{POLL,STORAGE_KEY}` from `../config/constants`, `{Identity,Txn,
TransactionsRow,NfcStatus}` from `../lib/types`, `{C}`+`{S}`, `AsyncStorage`, `AppState`.
*Risk: high* — it is the orchestrator; many flows pass through it. **Run full `just e2e`**; nearly
every flow exercises Wallet. This is the step most likely to surface a missed import — `tsc --noEmit`
before e2e.

**Step 16 [solo] — thin `App.tsx`.** After Step 15 `App.tsx` contains only the root: `useState`
(identity/relay), the mount `useEffect` (load identity+relay), `persistRelay`, the self-check
`useEffect`, `onReset`, and the `if (identity===undefined|null) return <Onboarding|Wallet>` branch.
Final imports: `{Onboarding}` + `{Wallet}` from `./components/...`, `{RELAY_DEFAULT}` from
`./relayConfig`, `{STORAGE_KEY,RELAY_STORAGE_KEY}` from `./config/constants`, `{DpayCore}` from
`./services/native`, `{randNonceHex}` from `./lib/format`, `{Identity}` type, `{C}`+`{S}`,
`AsyncStorage`, `ActivityIndicator`. **Target: ≤ 60 lines.** *Risk: low* (mechanical; everything it
needs already lives in modules). Covered by every flow (root renders for all).

### Post-split

- **`just verify`** (core+canister+relay+e2e) green end-to-end.
- Update living docs **in the same change**: `CODEBASE_ANALYSIS.md` (note App.tsx split + the new
  `app/{config,lib,hooks,services,components,styles.ts}` layout + that the e2e entry still points at
  `app/App`), `AGENTS.md` (point at the new structure), `CLAUDE.md` build state line if the file
  count is referenced. No `OPEN_ISSUES.md` risk is added or removed (pure refactor).

---

## 4. Cross-cutting concerns

### State flow — KEEP prop drilling (YAGNI; do NOT introduce Context/Redux/Zustand)
`Wallet` holds all state today and prop-drills to ~10 children. **Recommendation: change nothing
about state flow.** The split is purely *structural* (move functions to files); each extracted
component receives the **exact same props it receives today**, now imported as a named export.
Rationale: the tree is shallow (`Wallet → PayMode | ReceiveMode | Sheets`), props are explicit and
already typed, and a Context would (a) add indirection that obscures the data flow the e2e flows
depend on, (b) introduce re-render risk with zero benefit at this scale, and (c) violate "no behavior
change" by definition (re-render timing can shift). **Prop drilling is the simplest solution that
works** — the explicit mandate. A Context can be revisited if/when a genuine cross-cutting need
appears; today there is none.

### `DpayCoreApi` / `DpayNfcApi` — centralize in `services/native.ts`
Today they are destructured at `App.tsx:30` module scope. **Recommendation: one `services/native.ts`
does the single `NativeModules` destructure and re-exports `DpayCore` + `DpayNfc`.** Every module
that needs them imports from there — single source of truth, no repeating
`NativeModules as {DpayCore: DpayCoreApi}` across 6 files. The *types* live in `lib/types.ts`
(constraint §0.4 confirms the singleton-read timing is unchanged, so this is behavior-preserving).

### Styles — ONE `styles.ts` + separate `config/palette.ts` (NOT co-located during the split)
**Recommendation: extract `const S` as a single unchanged `app/styles.ts`, and `const C` as
`app/config/palette.ts`. Do NOT co-locate styles per-component in this phase.**

Justification (this is the call most likely to be second-guessed, so it is spelled out):
- **The e2e net cannot catch a styles regression.** Flows assert on testID + textContent only; PNGs
  in `e2e/shots/` are never diffed (constraint §0.1). Co-locating means partitioning ~147 style keys
  across ~14 components by hand — a dropped/misnamed key silently breaks the UI while `just e2e`
  stays green. That is an unacceptable risk for a "no behavior change" refactor.
- **A 1:1 move of one object is zero visual risk** and trivially reviewable (the diff is "cut block,
  paste into new file, add import").
- Both options satisfy the greenfield "single source of truth" rule (one object OR one style per
  component — each style lives exactly once).

**Optional follow-up (Phase 3b, NOT in this plan):** co-locate styles per-component, gated on
**visual review via zai-vision** (screenshot each flow before/after, diff with `ui_diff_check`),
NOT on `just e2e` alone. That is the correct tool for a partition the e2e net can't see. Defer until
the structural split is proven stable.

---

## 5. Risks + mitigations

1. **(HIGH) Styles regression invisible to e2e.** A co-located-style partition bug leaves `just e2e`
   green. **Mitigation:** keep `S` as one `styles.ts` (§4). Do not partition during the split.
2. **(MEDIUM) `NfcTap`/`Wallet` extraction misses an import → runtime undefined.** These are the two
   most-coupled moves. **Mitigation:** `cd app && npx tsc --noEmit` after each of Steps 9/15 (cheap,
   pinpoints missing imports); then full `just e2e`. The NFC seam (flow 11) and ~15 Wallet-driven
   flows densely cover regressions.
3. **(LOW) `POLL` evaluation-order regression.** If `POLL` stops being a module-level const computed
   from `__DPAY_TEST_POLL` at import time, the fast-poll harness override is missed and the suite
   slows/paces wrong (or a prod cadence leaks into tests). **Mitigation:** keep `POLL` exactly as-is
   in `config/constants.ts`; do not refactor it into per-call reads (constraint §0.5).
4. **(LOW) `relayConfig` alias drift.** If a new module imports `RELAY_DEFAULT` from a relative path
   that breaks the `^\.\.?\/relayConfig$` anchor, the e2e override silently stops applying.
   **Mitigation:** only `App.tsx` root consumes `RELAY_DEFAULT` (as `./relayConfig`); thread
   `relayUrl` as a prop everywhere else (existing pattern). Do not spread relayConfig imports
   (constraint §0.3).
5. **(LOW) React/RNW duplicate-instance.** Adding files could in theory pull a second React copy.
   **Mitigation:** unchanged — every new module imports `react`/`react-native` by bare specifier,
   which `vite.config.js`'s `dedupe: ['react','react-dom','react-native-web']` + the exact-match
   aliases already enforce. No config change needed.
6. **(LOW) Metro (real RN) nested-dir resolution.** The thinned App importing from `./components/...`
   must resolve under Metro. **Mitigation:** `app/tsconfig.json` extends RN config with no path
   aliases — all imports are relative, which Metro handles natively. The `__tests__/App.test.tsx`
   smoke render (`renderer.create(<App/>)`) is an additional guard that the real RN bundler graph is
   intact; run it once post-split (`cd app && npm test`).
7. **(LOW) Circular import.** A component accidentally importing a sibling that imports it back.
   **Mitigation:** the proposed graph is strictly layered (§2 dependency-direction note); `tsc` +
   the e2e bundle would both surface a cycle as a runtime-undefined binding. Verify no component
   imports `Wallet` (only `App.tsx` does).

