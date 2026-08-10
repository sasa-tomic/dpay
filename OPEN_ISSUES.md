# dpay — open issues & follow-ups

> **Read this before starting work** on dpay, alongside `CLAUDE.md` and `CODEBASE_ANALYSIS.md`.
> This is the authoritative list of known blockers and documented follow-ups after the verified
> fix-set (R1–R4 + ckBTC top-up + minter-arg + production deploy). Do not infer production
> readiness from the currently-green unit/browser counts: the latest audit found a failing app
> self-check (resolved 2026-08-02), a stale `dpay-sim` (resolved 2026-08-05), and major non-dollar paths that the browser suite bypasses. Most
> entries below are **deliberate, documented follow-ups**, not regressions — each carries its current mitigation and the concrete
> next step. Structural detail lives in `CODEBASE_ANALYSIS.md`.

## NEXT SESSION — work order (2026-08-09): Send/Receive tabs IA refactor — ✅ DONE

> **Top of the work order.** Founder-directed (2026-08-09). Fully `app/`-scoped (zero wire/canister/
> relay/core change). Full plan + phased breakdown + e2e-impact table in `2026-08-09-send-receive-tabs-refactor.md`.

**✅ DONE (2026-08-09, commits `f882a04` + `65b7094` + timeout bump).** The on-chain Send/Receive
moved OUT of the Balances per-row buttons and INTO the existing Pay/Receive tabs (extended with a
within-tab `[ ... | ... ]` toggle). Balances is now a pure balance-list + select screen. 3 founder
issues resolved: (1) Balances rows decluttered — IC rows are one whole-row select Pressable
(`asset-<key>-select`), per-row `+Receive`/`Send` buttons removed; brand left-border is active-ONLY
(`assetCardActive`) so the selected card pops. (2) Deposit address (was Balances `+Receive`) now lives
in the Receive tab's "My address" sub-mode — no more naming collision with the Receive-tab payment-
request flow; the "Receive" label is kept (NO rename to "Deposit"). (3) The Receive-tab
`CurrencyPicker` is unified with Balances (testnet-filtered + dot active indicator + matching
typography).

**Design decisions (build-time):**
- **Inline-vs-sheet: INLINE for all three bodies** (deposit CkBtcUtxo / deposit CkEthErc20 / withdraw)
  — matching SOL's `SolReceiveMode`/`SolPayMode` inline pattern. `DepositSheet`/`CkErc20DepositSheet`/
  `WithdrawSheet` each gained an `inline?: boolean` prop that skips the `SheetOverlay`/`SafeAreaView`/
  sheet-head chrome (the tab body is the surface); the body JSX + all downstream testIDs are byte-
  unchanged. `onClose` flips the sub-mode back. The sheets are still importable as overlays (the prop
  defaults false) — kept as thin presentational components rather than deleted (minimizes risk).
- **DEMO:** no on-chain deposit/withdraw family → the within-tab toggle is HIDDEN for DEMO (the
  request/scan flow stands alone). DEMO's faucet stays in Balances (`btn-topup`).
- **SOL:~~kept its Balances entry~~** ~~(`onSolReceive`/`onSolSend`) as a DELIBERATE, TEMPORARY exception.~~
  ~~The plan's e2e impact table did NOT list SOL flows (45/52) for re-routing and stated "SOL routing~~
  ~~unchanged", so dropping SOL's buttons would have broken those flows without a re-route target. IC~~
  ~~assets got the clean declutter the founder asked for; SOL was deferred to keep this change safe.~~
  ~~**This is tracked as a MUST follow-up — see "SOL parity in tab IA" below.** SOL MUST be unified into~~
  ~~the same Pay/Receive tab toggles (re-route 45/52), not left as a Balances exception.~~
  ✅ **DONE 2026-08-09** — SOL unified into the Pay/Receive tab toggles (flows 45/52 re-routed); see the
  struck-through "SOL parity in tab IA" follow-up below. SOL is now uniform with IC (whole-row select in
  Balances; deposit/send inline in the tab sub-modes).
- **Deeplink migration:** `?screen=deposit` + the auto-open-ckERC20-on-restart effect now set
  `mode='receive'` + `receiveSubMode='address'` + select the currency (was: open an overlay sheet).
  The within-tab sub-mode state is OWNED by Wallet (not the mode components) so deeplinks can land the
  user on the right surface.

**e2e:** 59/59 GREEN. ~14 flows re-routed (all mechanical — same downstream assertions, new nav path
`Balances → select currency → tab → toggle`): deposit 03/04/05/16/22/33/34, withdraw 15/18/44/48/56,
balances 55, plus incidental touch-ups (14 keyboard, 39 store-screens, 41 a11y census). New harness
helpers: `selectCurrency`, `openReceiveAddress`, `openPaySend`. `balances.png` visual baseline re-seeded
(21.8% drift → 0% — the per-row buttons + always-on border are gone). `wallet-pay`/`receive-request`/
`settings`/`ledger` baselines unchanged.

**testID delta (a11y-census flow 41 reconciled):** REMOVED `asset-add-*`, `btn-withdraw` (from
Balances), `btn-deposit-close`, `btn-ckerc20-close` (inline bodies have no overlay close). ADDED
`asset-<key>-select` (whole-row select), `btn-receive-request`/`btn-receive-address`,
`btn-pay-scan`/`btn-pay-send`, `receive-mode-toggle`/`pay-mode-toggle`. The `asset-<key>` CONTAINER
testID is preserved (wraps the select Pressable) so flows that read row textContent (05/24) are
unchanged.

**Gates:** `just verify` green — typecheck 0, jest 480/480, bridge-parity OK (29 methods, untouched),
e2e **59/59**. No wire/canister/relay/core change (pure `app/` + `e2e/`). Prod catalog reconciled (7
currencies: DEMO + ckBTC/ckUSDC/ckETH mainnet + 3 testnet) — the unified picker/Balances handle it
with no duplicate symbols and no testnet leakage.

---

## ~~FOLLOW-UP (MUST, founder-directed 2026-08-09): SOL parity in tab IA — all currencies uniform~~ ✅ DONE 2026-08-09

> ~~**Hard rule (added to `CLAUDE.md` "Current wallet UX direction", 2026-08-09): every currency MUST be~~
> ~~handled through the SAME UI surfaces and flows — now and for the future.**~~ A per-currency/per-rail
> special case in the wallet IA is a bug, not an exception. ~~This follow-up closes the one outstanding~~
> ~~divergence from that rule.~~ ✅ **Closed 2026-08-09** — the rule now holds with zero exceptions.

~~The 2026-08-09 IA refactor (DONE above) moved IC assets' on-chain deposit/withdraw into the Pay/Receive~~
~~tab toggles, but **SOL was left as a deliberate, temporary exception** — SOL's Balances row still carries~~
~~`btn-sol-receive`/`btn-sol-send` (the `onSolReceive`/`onSolSend` props in `BalancesSheet.tsx`). This~~
~~violates the all-currencies-uniform rule and MUST be closed. Pure `app/` + `e2e/` (no core/wire/canister/~~
~~relay), mirroring the main refactor's pattern exactly.~~

**✅ Resolution (2026-08-09, plan `2026-08-09-sol-tab-ia-parity.md`, commits `32b8d48` + `1f50d3d`):**
SOL is now byte-parallel to IC. `BalancesSheet`'s SOL row is a pure whole-row select (the `onSolReceive`/
`onSolSend` props + `btn-sol-receive`/`btn-sol-send` are gone). `SolReceiveMode` renders a
`[ Request payment | My address ]` `receive-mode-toggle`; "My address" renders the `SolanaReceiveSheet`
body inline. `SolPayMode` renders a `[ Scan to pay | Send to address ]` `pay-mode-toggle`; "Send to
address" renders the `SolanaWithdrawSheet` body inline. All five deposit/withdraw sheets are now
inline-only (the overlay branches were dead code after both refactors and were removed). Flows 45/52
re-routed to the tab sub-mode path; a11y census (flow 41) updated; balances visual baseline re-seeded.
`just verify` 59/59 green. The all-currencies-uniform hard rule now holds with no exceptions.

**Post-verification catch (same session, commits `ba0c857` + `eb6429e`):** an independent verifier found
a **React Rules of Hooks violation** the e2e suite was structurally blind to — `SolPayMode`/`SolReceiveMode`
placed their sub-mode early `return` *above* the `useState`/`useEffect` calls (unlike the IC
`PayMode`/`ReceiveMode`), causing silent state corruption on the back-toggle (Send→Scan reset the phase/
nonce; Address→Request reset the form). `just verify` passed because flows 45/52 only exercised the
forward toggle. Fixed by lifting both returns below all hooks (mirroring IC exactly); RED→GREEN back-
toggle regression assertions (state-preservation: amount/scan-phase survive the detour) added to flows
45+52 so the class can't regress. **Lesson:** a within-component conditional-`return` that changes hook
count is the canonical device-invisible hooks bug — always grep new early-returns against the nearest
hook. Final HEAD `eb6429e`: `just verify` 59/59 green, typecheck clean, bridge-parity 29, jest green.

<details><summary>Original scope + e2e re-route plan (historical, struck through)</summary>

~~**Scope:**~~
~~1. **`BalancesSheet.tsx` SOL row** — drop `btn-sol-receive`/`btn-sol-send` + the `onSolReceive`/`onSolSend`~~
~~   props; SOL row becomes a pure whole-row select (the existing `asset-sol-select` + `onSelectSol`), byte-~~
~~   parallel to the IC rows. Update `Wallet.tsx` to stop passing the dropped props.~~
~~2. **Receive tab when SOL is active** — "My address" sub-mode renders the SOL deposit address inline~~
~~   (`SolReceiveMode` body, already inline-capable). Build-time decision: whether the `[ Request payment |~~
~~   My address ]` toggle renders for SOL (SOL has no IC-relay request flow) or SOL's Receive is just the~~
~~   address — but the entry-point shape stays uniform from the user's perspective (same tab, same "My~~
~~   address" affordance as IC).~~
~~3. **Pay tab when SOL is active** — "Send to address" sub-mode renders `SolanaWithdrawSheet` body inline~~
~~   (mirror the IC `WithdrawSheet inline` pattern from the main refactor).~~

~~**e2e to re-route (2 flows):**~~
~- ~~**Flow 45 (sol-receive):** `Balances → btn-sol-receive → sheet` → `Balances → asset-sol-select → Receive → "My address"`.~~
~- ~~**Flow 52 (sol-withdraw):** `Balances → btn-sol-send → SolanaWithdrawSheet` → `Balances → asset-sol-select → Pay → "Send to address"`.~~
~- ~~**Flows 46/47/51/53 are UNAFFECTED** — they reach `SolPayMode` via `asset-sol-select` (the scan/pay path), not the Balances buttons.~~

~~**Verify:** `just verify` green; a11y census (flow 41) updated for the removed `btn-sol-receive`/`btn-sol-send`.~~
</details>

---

## NEXT SESSION — work order (post 2026-08-08 UX sweep)

The 2026-08-08 tech-debt + deeplink sweep (6 items, all done — see below) was followed by a
**real-app UX audit** that found and fixed 4 user-reported bugs the browser e2e is structurally
blind to (it uses a 3-currency FakeLedger, not the 6-currency prod catalog). All fixed + verified on
the emulator against the production relay:
- **Testnet duplicates** → hidden by default, toggle to unhide, labelled "BTC testnet"/"USDC testnet"/"ETH testnet" (`cf520ac`).
- **SOL 2 extra buttons** → removed; offline flows re-homed into SOL Send/Receive sheets (`cf520ac`).
- **Balance latency (N+1 fetches)** → relay batch endpoint `GET /api/v1/balances/{hex}` + app single-fetch; N+1→1 HTTP request (`b7eddb3`, prod relay redeployed).
- **AGENTS.md prod-reconciliation directive** added so future sessions catch this class of bug (`53a0bc5`).

Verified green: typecheck 0, test-core 45/45, test-relay 53/53, bridge-parity OK (28), jest 463/463,
e2e **51/51**, device gate (`just app` + `just ondevice` 9/9). git HEAD `b1168a7`.

The follow-up work order below is **FULLY CLEARED** — all 4 items resolved (#1, #2, #4 done; #3
investigated and confirmed already-optimal). No open blockers remain. See the item entries for
details.

1. ~~**`dpay:pay/` receipt hand-back (FEATURE — HIGH effort, split into medium tasks).** Codec exists (`encodeDeeplink`/`decodeDeeplink` support `pay`; jest-tested). To wire: (a) pay-side: after an offline sign, offer a "Share receipt" that encodes the signed payment as `dpay:pay/<blob>`; (b) `readPaymentDeeplink()` web reader (`?pay=`) — re-add to `app/lib/deepLink.ts` WITH the wiring (currently deleted to honor no-dead-code); (c) merchant-side: decode + verify the receipt signature (reuse `services/receipt.ts` `verifyOutcomeReceipt`) + reconcile the open request as settled. Mirror the e2e flow 49 structure. Start with a design note, then build incrementally.~~ **✅ DONE (2026-08-08).** The full NFC-less receipt hand-back is wired (4 TDD units, commits `0bc8d71`→`0fae6fc`):
   - **Codec (Unit A):** `encodeReceiptDeeplink`/`decodeReceiptDeeplink` (`app/lib/deepLink.ts`) — `<blob>` = base64url(JSON.stringify(receipt)); the `pay` handler base64url-decodes THEN JSON.parses (DIFFERENT from `req`'s raw base64url). `readPaymentDeeplink()` web `?pay=` reader added (the deferred-NOTE removed). Extracted the RFC 4648 §5 base64url + UTF-8 byte codecs into `app/lib/base64url.ts` (single source of truth; `solana/qr.ts` now imports from it — no second implementation). 15 jest cases.
   - **Payer share (Unit B):** `PayMode.tsx` captures the verified receipt on an ONLINE settle (`paid.receipt`) + renders a "Share receipt" button (`btn-share-receipt`) → `Share.share({message: encodeReceiptDeeplink(receipt)})`. Only on a fresh online settle (not the offline hand-off, where the merchant settles; nor a replay).
   - **Merchant verify + reconcile (Unit C):** `Wallet.tsx` routes `dpay:pay/` → `prefillReceipt` + `mode='receive'`; `ReceiveMode.tsx` verify effect mirrors the NFC merchant path's security posture EXACTLY — `isReceiptForRequest` (nonce binding, if there's an open request) BEFORE `verifyOutcomeReceipt` (key-pin + Ed25519 sig). "Received" shows ONLY after verify passes; a mismatched/malformed receipt surfaces a clear error (never a fake Paid, never silent). No change to `verifyOutcomeReceipt`/`ReceiptAuth` (the merchant path doesn't decode the payer's `from`; the signature authenticates it).
   - **e2e (Unit D):** flow 50 mirrors flow 49's reload approach — B (server-side keypair, fauceted) settles A's request → real FakeLedger receipt → `?pay=<blob>` reload → A's ReceiveMode verifies → "Received ∂25.00 from <B>". 51/51 green.
   Gates: typecheck 0, jest 463/463 (+15), bridge-parity OK (28), e2e 51/51. No manifest change (the `dpay` scheme intent-filter already covers `pay`).
2. ~~**SOL as first-class in main Pay/Receive tabs (REFACTOR — MEDIUM).** SOL offline flows are currently re-homed into the SOL Send/Receive sheets (interim). The deeper refactor: make SOL a selectable asset in the main Pay/Receive tabs (parity with IC currencies) instead of a separate bolt-on reached only via the Balances sheet. Requires unifying the PayMode/ReceiveMode (IC) + SolPayMode/SolReceiveMode entry points behind a currency-aware router.~~ **✅ DONE (2026-08-08, commit `1043917`).** SOL is now a first-class asset via a **RailSelector** — a segmented `[ IC | SOL ]` pill toggle at the top of the Pay/Receive tab bodies. Selecting SOL renders `SolPayMode`/`SolReceiveMode` **INLINE** (converted from full-screen sheets to inline mode components, mirroring `PayMode`/`ReceiveMode`'s `S.center` surface) instead of the IC modes. The redundant offline-flow cross-links (`btn-sol-pay-offline`/`btn-sol-req-offline`) were stripped from the SOL funding sheets + the `solPayOpen`/`solReqOpen` state removed from Wallet (no dead code). **Why a selector (not auto-detect):** IC and SOL use SEPARATE NFC HCE services (DpayNfc AID `…01` vs DpaySolNfc AID `…02`) that must be armed BEFORE a tap — the card protocol (AID selection) is committed before the reader sends its first APDU, so the user MUST pre-select the rail; auto-detection is impossible. Switching rail unmounts the mode component → its `useNfcTapState` cleanup disarms (no arm-leak). IC flows are byte-unchanged when rail='ic' (the default). The RailSelector renders `null` when SOL is unavailable (IC-only wallet, no clutter). e2e flows 46+47 re-routed from `Balances→send→offline-link` to the direct `rail-sol` path (faster, no Balances detour). Gates: typecheck 0, jest 463/463, e2e **51/51**, bridge-parity OK (28). Visual baselines re-seeded (wallet-pay + receive-request surfaces gained the selector).
3. ~~**Balance latency — inherent IC round-trip (OPTIMIZATION, LOW).** The batch endpoint cut client requests 6→1 and parallelizes ledger queries server-side, but the first poll still takes a few seconds (relay→IC-mainnet round trip per ledger). A future relay-side balance cache (short TTL) or a single multi-ledger query-call optimization could help. Acceptable for pilot.~~ **✅ RESOLVED (2026-08-08, query-first balance).** A prior subagent concluded "already optimal / no safe win"; that was wrong — the latency was the relay's blocking `refresh_balance` UPDATE, not an irreducible round-trip. Fixed (see end of this entry). The still-valid findings: (1) the first poll fires **immediately** on mount (`poll()` called synchronously in the effect body — `useBalancePoll.ts:157`, no `setTimeout`/delay); (2) NO balance cache exists in AsyncStorage, and adding one is **forbidden** (stale-balance correctness risk for a payment app); (3) the catalog-refresh effect-restart aborts an in-flight fetch for only ~1-5ms (AsyncStorage resolve time) — negligible. The remaining latency was the relay's TTL-gated `balance()` BLOCKING on a `refresh_balance` UPDATE call through consensus (~2-5s) whenever an entry was stale — on a cold start / relay restart ALL 6 currencies were stale, so 6 parallel UPDATEs froze the batch for 2-5s every `BALANCE_TTL_SECS` window. **✅ RESOLVED (2026-08-08):** `AgentLedger::balance` is now query-first — it ALWAYS returns the fast cached `balance_of` QUERY (~200ms) and fires the authoritative `refresh_balance` UPDATE on a detached background task (`spawn_background_refresh`) when stale, removing ALL UPDATE calls from the response path. The canister's `BAL_CACHE` (written by `refresh_balance`/`pay`/`mint`/`faucet`) persists across relay restarts, so the cached query is always safe to return; facade-bypassing credits (direct ICRC transfers + async ckERC20 mints) surface within one background-refresh cycle. Background failures log pubkey/currency/error and leave the entry stale for the next poll (idempotent, so overlapping tasks on a slow replica are safe).
4. ~~**`just e2e` npm-install flake (tooling, LOW).** `just e2e` fails at the `npm install` step with `npm error Invalid Version` (`@rolldown/binding-wasm32-wasi` dedupe crash in `@npmcli/arborist` under Node 24) — a **pre-existing** npm/Node-v24 env bug, NOT a code regression (`node_modules` already exists; `node e2e/run.mjs` runs directly). Consider: pin the e2e Node version, or make the justfile `npm install` tolerant of this error, or skip install when `node_modules` exists.~~ **✅ DONE (2026-08-08).** Guarded all 6 e2e justfile recipes (`e2e`, `e2e-visual`, `e2e-visual-seed`, `e2e-watch`, `e2e-watch-filter`, `e2e-live-testnet`) with `[ -d node_modules ] || npm install ...` — skips the redundant install (and the Node-24 dedupe crash) when `node_modules` exists, runs it only on a fresh checkout. `just e2e` 50/50 green.

> **Device gate RESOLVED (2026-08-08).** The prior "no emulator on this host / BLOCKING" claim was
> a false negative — the host has AVD `dpay_api36` (API-36 google_apis x86_64 system image) which
> boots in ~40s. Boot: `tmux new-session -d -s emu "$ANDROID_HOME/emulator/emulator -avd dpay_api36 -no-window -no-audio -no-snapshot -gpu swiftshader_indirect -read-only"`; poll `adb shell getprop sys.boot_completed` (~40s). Device gates PASSED this session:
> - `just ondevice`: **9 instrumented tests GREEN** (UniFFI binding + NFC framing on the emulator).
> - `just app`: APK built + installed + launched; **`DPAY_SELFCHECK PASS`** + **`DPAY_SOL_SELFCHECK PASS`**.
> - **Deeplink dispatch**: `adb shell am start -a android.intent.action.VIEW -d 'dpay:req/<blob>'` resolves to `org.kalaj.dpay/.MainActivity` on cold + warm start, no crash.
>
> Note: the `dpay_api35` AVD was removed (its android-35 system image isn't installed; only android-36 is). To recreate: `sdkmanager "system-images;android-35;google_apis;x86_64"` then `avdmanager create avd -n dpay_api35 -k "system-images;android-35;google_apis;x86_64"`.

---

## Session summary (2026-08-09): SOL UX + codebase sweep — reported bug fix, integrity hardening, devnet safety, e2e coverage

> All gates green: `just verify` **55/55 e2e** (added flows 51–54) in ~106s under ×3.15 load factor, jest **480/480** (+10 new solana-payments tests + 6 solana-errors tests), test-relay **49/49** (fake_catalog grew by 1 testnet currency), typecheck clean, bridge-parity OK (28 methods). On `main`, **8 commits** this session (`30045a8`→`80bb302`). Wire FROZEN (292/196/132) untouched; ZERO canister/facade/core/relay change — fully app-scoped + e2e + docs. Plan: `2026-08-08-sol-ux-and-sweep.md`.

**Headline: the founder tried to "pay" with SOL on Android and got a raw Solana RPC error with no guidance.** Root cause: the SOL source account had no balance (devnet `Attempt to debit... no record of a prior credit`), shown raw because `friendlySolError` didn't exist + 3 UI surfaces had no error mapping + `broadcastSolPayment` regex misclassified the error. Fixed immediately, then a 4-subagent research swarm + fix sweep addressed the broader SOL rail integrity + UX gaps the bug exposed.

**Reported bug fix (commit `30045a8`):** created `app/solana/errors.ts` — pure `friendlySolError(msg)` (single source, jest-tested 6 cases). Wired into all 3 SOL UI surfaces (`SolPayMode`, `SolanaWithdrawSheet`, `SolReceiveMode`). Extended `solana.ts:208` regex to classify the no-credit class as REJECTED.

**Integrity hardening (commits `d81d004`, `6e71071`) — the deeper gaps the bug exposed:**
- **F1 expiry enforcement (HIGH):** `validateReq` checked `exp` was an integer but NEVER compared to `now` — a stale/replayed `solreq:` was fully signable (SOL has no server-side enforcement unlike IC). Added pure `isSolReqExpired(req, nowMs)` (`app/solana/payments.ts`, jest-tested); `SolPayMode.onScan` + `SolNfcTap.autoSign` reject expired solreq. SolReceiveMode now shows a live expiry countdown (mirrors IC ReceiveMode).
- **F2 merchant binding (HIGH):** `SolReceiveMode.onSignedQr` did NOT verify the scanned `solpay` matched the open `solreq` (to/cur/amt) — it broadcast whatever the payer claimed + showed the payer's claimed amount. Added pure `solpayMatchesReq(solpay, req)` (jest-tested); asserts to/cur/amt before broadcast in `SolReceiveMode.onSignedQr` + `SolNfcTap.submitPayment`.
- **F8 resyncNonce retry (MED):** `createNonceAccount` retried 3×/500ms but `resyncNonce` had NO retry — asymmetric robustness on the same lag surface. Extracted shared `readNonceWithRetry` in `solana.ts`; both use it.
- **F6 honest devnet error (MED):** refined `friendlySolError` no-credit message to cover BOTH unfunded AND devnet-pool lag (the load-balanced pool can make a funded account look unfunded to the simulating node). The regex stays TIGHT (`/no record of a prior credit|found no record/i`) — adding `simulation failed|debit` was too greedy (caught insufficient-funds).

**Devnet safety surface (commits `d81d004`, `6e71071`):**
- `IS_SOLANA_DEVNET` flag (derived from `SOLANA_RPC_URL`) in `config/constants.ts`.
- DEVNET badges on `SolPayMode` (setup+scan) + `SolReceiveMode` (form+reqQr).
- Devnet warning on `SolanaReceiveSheet` (testID `sol-devnet-warning`) — the highest fund-loss-risk surface (a user sending mainnet SOL to a devnet-polled address).
- **Release-path prod guard** (`scripts/check-prod-sol.mjs`, wired into `scripts/build-apk.sh`): fails the build if the baked RPC default points at devnet/testnet or the rate-limited public mainnet (`api.mainnet-beta.solana.com`). `DPAY_SOL_RPC` env acknowledges an explicit choice. Currently FAILS (baked default is devnet) — correct until operator sets a paid provider. Closes F9 (launch risk: no guard prevented a prod build shipping at devnet).

**UX fixes (commit `6e71071`):**
- **Keyboard covers "Create wallet" CTA** — `Onboarding.tsx` wrapped in `KeyboardAvoidingView` + `ScrollView` (AndroidManifest already had `adjustResize`).
- **Unfunded escape hatch** — `onShowDeposit` callback threaded Wallet→SolPayMode; "Show my SOL address" button (testID `sol-show-deposit`) on setup-error + stale screens (the error said "deposit to your address" but offered no path to the address — a dead-end).
- **ETH sub-label** — `disp.nativeAsset` → `disp.networkLabel` in BalancesSheet (ETH→Ethereum; was backing_symbol='ETH').
- **Active-rail chip** (testID `active-rail-chip`) on the main screen showing SOL/DEMO/IC wrapper_name (prevents users getting silently stuck in SOL mode).
- **10 empty NFC catches → console.warn** (`NfcTap` ×3, `SolNfcTap` ×5, `useNfcTapState` ×2) — closes the device-blind-spot class where a bridge/FFI throw looked identical to an invalid signature.
- **`app/sol-devnet-test.ts` moved to `.dev/`** (was a 212-line standalone test script in the prod tree with zero references; imports rewritten `./`→`../app/`).
- **`SOL_BROADCAST_TIMEOUT_MS`** named const (replaces 3 inlined `SOL_SEND_TIMEOUT_MS*2` sites).

**Default-tab change → REVERTED (commit `6ec2682`):** Subagent A's A6 changed `balancesOpen` default to open on launch. BROKE e2e flow 14 (keyboard hotkey assertion blocked by the modal sheet). Reverted to `useState(false)`. The underlying UX concern (new user lands on Pay scanner + NFC error) is DEFERRED — any default-tab change needs coordinated e2e updates.

**E2e coverage (commits `e7ad2c6`, `8f22092`, `9c7b88d`, `80bb302`):**
- **4 new SOL flows (51-53 + funded balance):** `51-sol-merchant-broadcast` (entire merchant broadcast path), `52-sol-withdraw` (first coverage of SolanaWithdrawSheet), `53-sol-merchant-error` (rejecting stub → friendly "Payment rejected", no raw RPC leak).
- **Flow 54 testnet-toggle:** seeded ckTESTBTC into `fake_catalog()` as currency 6 (5 was already native ckETH) → the toggle becomes exercisable; closes the prod-only-catalog blind spot flagged in AGENTS.md.
- **Flake stabilization:** `02-faucet` timeout 15s→25s; removed `05-deposit-credited` racy `notYet` assertion (raced the app's 150ms auto-poll); `DPAY_E2E_NO_FAILFAST=1` triage mode (fail-fast previously aborted ~45 flows on one flake).
- FLOWS.md regenerated (55 flows); AGENTS.md "44 flows" → "55 flows".

**Items DEFERRED (optional Subagent D, not blocking):**
- **F3 merchant ed25519.verify** — the payer's `solpay.tx` signature is currently only validated *implicitly* by Solana accepting/rejecting the broadcast. A merchant-side `ed25519.verify(sig, message, payerPubkey)` before broadcast would mirror the IC receipt-verify posture (defense-in-depth, not a funds risk — on-chain rejects a bad sig).
- **F4 USDC toggle gating** — the SOL/USDC toggle is offered in the UI but USDC offline-pay is non-functional without pre-existing ATAs (`sourceAta` must exist on-chain). Gating it behind an ATA-existence check is a documented follow-up.
- **Default-tab/first-impression UX** — the new user lands on the Pay scanner + "NFC not available" instead of a wallet overview. Requires coordinated e2e updates (any modal-sheet change blocks the keyboard hotkey flow). Deferred to a dedicated UX session.
- ~~**Seed/backup affordance** — Settings has Reset + Privacy + relay URL but no way to view/export the seed phrase ("one backup recovers both rails" is a pitch point with no UI backing it).~~ **✅ DONE (2026-08-09, commit `2482500`).** See the Phase 2 summary below.

---

## Session summary (2026-08-09): ETH + SOL mainnet operational check — family-blind deposit bug found + fixed

> Direct prod-relay verification (`https://dpay.kalaj.org`) + a TDDRED→GREEN canister fix. `just verify` green (core 45, canister **86** +2 new, relay 53/55, e2e 55/55, typecheck, bridge-parity 28). 1 commit (`3e60a56`). Plan: `2026-08-09-eth-sol-mainnet-check.md`.

**ETH mainnet verdict (per endpoint, curled against prod facade `ssqti`):**
- **Deposit UX (in): OPERATIONAL** — the app routes `CkEthErc20` family to `CkErc20DepositSheet` (`Wallet.tsx:422-424`) → `GET /onramp/ckerc20?currency=6` → 200 (helper `0x1890…`, `kind:"native_eth"`). The WalletConnect onramp path was never affected.
- **Balance: OPERATIONAL** — `GET /balance?currency=6` → 200 `{"balance":"0"}` in ~0.2s (ledger query only, no minter call).
- **Withdraw: PARTIAL** — native-ETH `withdraw_eth` is deployed (commit `9fc4a9f`); ckERC20 `withdraw_erc20` needs a prod WASM upgrade (founder op, tracked below).
- **Deposit metadata endpoints (the bug):** `GET /deposit/info?currency=6` + `GET /deposit/address/…?currency=6` → **503** for every `CkEthErc20` currency (ckETH=6, ckUSDC=2, ckSepoliaETH=5). App-unaffected (never called for ETH) but prod-API landmines + log noise.

**🚨 Root cause — three family-blind deposit methods (`crates/dpay-canister/src/lib.rs`):** `deposit_address` (1368), `deposit_info` (1468), `refresh_deposit` (1390) all unconditionally called BTC-minter-only methods (`get_btc_address` / BTC-shaped `get_minter_info` / UTXO `update_balance`) regardless of `minter_family`. The ckETH minter has no `get_btc_address` and returns a different `MinterInfo` shape → `IC0536 method not found` / `CandidDecodeFailed` on prod. The `withdraw` method (1576-1615) ALREADY did correct family dispatch; the three deposit proxies were never updated to match when `CkEthErc20` was added.

**Fix (commit `3e60a56`):** all three methods now gate on family BEFORE the minter call — `CkBtcUtxo` (incl. the legacy "has minter, no family" default) → existing BTC path unchanged; `CkEthErc20` / `CkSol` / no-minter-no-family → clean typed `Err` directing to the onramp endpoint. Mirrors `withdraw`'s family-dispatch pattern exactly. `MinterFamily` already derived `PartialEq` (no wire/struct change). 2 new PocketIC tests (`deposit_family_gate.rs`): `deposit_proxies_reject_cketherc20_family` (registers a `CkEthErc20` currency at the BTC-shaped mock → asserts all 3 methods return `Err` naming CkBtcUtxo/onramp — went RED→GREEN as predicted, proving the gate fires on FAMILY not on minter behavior) + `deposit_proxies_still_serve_ckbtc_legacy_default_family` (BTC path regression guard). No relay change (relay maps facade `Err` → 503 with a now-clean message).

**SOL mainnet verdict:** NOT operational in the shipped APK — `SOLANA_RPC_URL` defaults to devnet (`config/constants.ts:91`); `scripts/check-prod-sol.mjs` (wired into `build-apk.sh`) fail-closes the build on a devnet/rate-limited default. **Correctly blocked on an operator step** (set a paid Helius/QuickNode RPC URL). No code change warranted — the guard is right.

---

## Session summary (2026-08-09): Phase 2 — app UX, e2e coverage, canister panic-surface docs

> Follow-on to the mainnet check above (Phase 1). App-scoped UX + e2e + canister docs, no wire/canister-behavior change. `just verify` green: core 45, canister 86, relay 53, e2e **58/58** (+3 new), typecheck clean, bridge-parity OK (28). **6 commits** (`2482500`→`a8e21e4`). FLOWS.md regenerated (58 flows across 9 journeys).

**A1 — Seed/backup affordance (commit `2482500`) — resolves the DEFERRED "Seed/backup affordance" item from the SOL sweep above.** New "Backup" section in `SettingsSheet.tsx` reveals `identity.secretHex` behind a two-step confirm gate (entry `btn-backup` → warning + `btn-backup-confirm` → monospace `seed-phrase` block + `btn-copy-seed`). The warning names the BOTH-rails consequence ("This seed recovers BOTH your IC and Solana funds"). Pure display + `copyToClipboard` (mirrors the DepositSheet/WithdrawSheet copy pattern); no new persistence, no money logic, no wire change — the seed already lives in AsyncStorage. `secretHex` threaded as a new prop from `Wallet.tsx` (identity in scope). 5 new style keys added to the single `styles.ts` `StyleSheet.create` block (brand-tinted entry, neutral confirm box, monospace seed box). Visual baseline `settings.png` re-seeded (31.9% drift → 0%). This makes the documented "one backup recovers both rails" pitch point real.

**E2e coverage (commits `d7f9644`, `38f2bdd`, + flow 57 in `2482500`):**
- **Flow 55 `balances-select-asset`** — selecting an asset in Balances binds the header: `active-rail-chip` DEMO→ckBTC→SOL and the balance text follows the active-rail branch (`Wallet.tsx:354-358` three-way header branch, previously no dedicated coverage). Note: the IC catalog row's select `Pressable` in `BalancesSheet.tsx:144-150` carries NO testID (only the SOL row `asset-sol-select` + the container `asset-${key}` do); flow 55 drives the real `onSelect` via the `driver.eval` escape-hatch (clicks the row's first `[role="button"]`). **Follow-up:** add `testID={`asset-${key}-select`}` to the IC select Pressable for parity with the SOL row.
- **Flow 56 `withdraw-saved-addr`** — a successful withdraw persists the destination (AsyncStorage via `loadSavedWithdrawAddr`/`saveWithdrawAddr`); reopening the sheet shows the `btn-withdraw-saved` chip that pre-fills the address input. This persistence path had ZERO coverage (flows 15/18/44/48 always typed a fresh address).
- **Flow 57 `settings-seed-backup`** — guards A1: seed hidden until confirm; revealed value equals `identity.secretHex`; copy writes to the real clipboard via the `window.__DPAY_TEST_CLIPBOARD` seam. Mirrors flow 04 (deposit-copy) + flow 12 (settings) patterns.

**Canister panic-surface docs (commits `37cc872`, `a8e21e4`):**
- **C2 SAFETY comments** — documented all 16 acceptable `.unwrap()`/`.expect()` sites in `crates/dpay-canister/src/` (lib.rs + types.rs): 4 init `StableCell` sets, 3 init/admin writes, 5 `Storable::from_bytes` (the `ic-stable-structures` trait returns `Self` not `Result` — cannot be `?`-ed), and 4 `receipt()` decode slices (provably infallible — `claim_bytes` is a fixed `[u8; RECEIPT_CLAIM_LEN]`=108 array whose offsets exactly consume it; a length guard would guard an impossible state). NO code change, comment-only. No panic site fell outside these 4 acceptable categories.
- **C4 dead-code sweep** — `cargo` flagged 6 "never constructed" variants on local `MinterFamily`/`RampCapability` candid-wire mirror enums in 3 canister-test files; these are NOT dead (the full variant set is load-bearing for wire fidelity — dropping a variant would silently re-target the registered family/ramp), so `#[allow(dead_code)]` was added matching the `deposit_family_gate.rs` precedent. TS-side: 267 exported symbols scanned across `app/`, 0 unreferenced — prior sessions were thorough. No code deleted.

**Items still DEFERRED (no change):** Default-tab/first-impression UX (A2 copy-soften — skipped as marginal value / med risk, touches 7 pay flows); F3 merchant ed25519.verify; F4 USDC toggle ATA gating. The seed/backup item is now RESOLVED.

## Session summary (2026-08-09): cycles-drain fix + relay cost audit + SOL mainnet RPC

> The founder flagged a ~1.5 TC/day cycles drain (2.7 TC → ~1.2 TC in ~1 day). Root-caused, fixed, and audited. `just verify` green: core 45, canister 86, relay **54** (+1), e2e **58/58**.

**Root cause (the ONE leak):** the ckBTC deposit sheet polls `POST /api/v1/deposit/refresh/{hex}?currency=N` every 10s while open (`DepositSheet.tsx:120`, `POLL.deposit=10000`). Each call → relay `deposit_refresh` (`app.rs:442`) → facade `refresh_deposit` → ckBTC minter `update_balance` (an inter-canister Bitcoin canister call, ~170M cycles). The endpoint was **unauthenticated with no cache/TTL** (risk 7), so an open deposit sheet = 8,640 minter calls/day × 170M ≈ **1.47 TC/day** — matching the observed drain exactly.

**Fix — relay TTL cache (commit `91cae05`):** `deposit_refresh` now caches the ledger result per `(pubkey, currency)` for **120s** (mirrors the existing `idempotency` `Arc<Mutex<HashMap>>` pattern in `AppState`). Cache HITs return the prior result with **ZERO canister calls**. This coalesces the 10s poll into ≤1 minter call per 120s window per key — a 12× reduction. It protects ALL clients (including the already-shipped APK) immediately on relay redeploy, and caps unauthenticated/bot traffic to 1 minter call per TTL per key. TTL=120s is tuned to the minter's own ~3min heartbeat (Bitcoin confirmations take minutes; faster refreshing is pure waste). Errors are NOT cached. The test-helpers seed route invalidates the cache on a seeded deposit (seeding changes ledger state → the cached result is stale — `#[cfg(feature="test-helpers")]`-gated, never ships). TDD: RED (FakeLedger drains pending on the first `deposit_status` call → the second returned `minted_total:"0"`; with the cache it returns the first's `"5000"`) → GREEN.

**Full relay cost audit (every route classified — no other leak):** `pay`/`withdraw` are per-TX (minter inter-canister call but user-initiated — correct). `balance`/`balances` are cheap: `balance_of` is a query, and the `refresh_balances` batch UPDATE is already TTL-throttled to 15s (`BALANCE_TTL_SECS`) ≈ negligible (~0.0001 TC/day). `transactions`/`receipt`/`currencies` are queries. `health` is a free replica `status()` call (the merchant terminal polls it every 3s — zero cycles). `deposit/address`/`deposit/info`/`onramp/ckerc20` are fetched once-per-sheet-open (not polled). **`deposit/refresh` was the ONE leak; now fixed.** Verdict: post-fix the canister spends ~zero at idle and only on user-initiated TXs (pay/withdraw) — the founder's "pay per TX only" bar is met. The relay fix takes effect on relay redeploy (founder op); the canister WASM already has the family-gate fix from `3e60a56` (deployed live).

**SOL mainnet RPC wired (commit `b2459ca`):** founder provided a paid Helius mainnet endpoint; `SOLANA_RPC_URL` baked default flipped devnet → Helius mainnet (`app/config/constants.ts:92`). `IS_SOLANA_DEVNET` now resolves `false` (DEVNET badges disappear, rail treated as mainnet). `scripts/check-prod-sol.mjs` passes. The offline inner loop is unaffected (jest/e2e inject `__DPAY_TEST_SOLANA_RPC_URL=''`). NOTE: the Helius api-key is baked as a literal (rate-limit key, not a fund key — non-custodial, the device key signs; standard for mobile wallets, extractable from the APK regardless). If the repo goes public, rotate the key.

**Pending founder action:** (1) **Relay redeploy** — carries the TTL-cache fix to prod (the SOL RPC is app-side, independent). (2) The founder provided a second "Gatekeeper RPC" URL (`beta.helius-rpc.com`) — **NO config slot exists for it anywhere in the codebase** (grep confirmed); awaiting clarification on its purpose before wiring. (3) The optional canister-side `refresh_deposit` rate-gate (defense-in-depth against direct-canister-call bypass) is NOT implemented — the relay is the only ingress path so relay-side gating suffices; noted as a follow-up if the canister is ever called directly.

---

## Session summary (2026-08-09): direct-ledger balance refactor + deposit-proxy timeout + wallet restore-from-seed

> Three independent improvements post-cycles-fix. `just verify` green throughout: core 45, canister 86, relay 54, e2e **59/59**, typecheck clean, bridge-parity **29 methods**.

**Direct-ledger-query refactor (commit `934d8cd`):** the relay's `balances()` handler now fans out `icrc1_balance_of` **directly** on each catalog ledger Principal (`Account{owner: facade, subaccount: pubkey}`) instead of going through the facade's cached `balance_of` + the background `refresh_balances` update. Result: free (query not update), one fewer hop (lower latency), no consensus, always-live — N parallel direct queries instead of N composite calls serialized through the facade. New `Ledger::balance_on_ledger()` trait method (default delegates to `balance()` so FakeLedger/test stubs are unchanged); `AgentLedger` overrides with the real `icrc1_balance_of` query (`Icrc1AccountMirror` candid struct). The `refresh_all_if_stale()` background call was dropped from the handler (no facade cache to refresh). Relay-only — no canister change/redeploy (facade `balance_of`/`refresh_balances`/`BAL_CACHE` just go unused). **Verified live on prod:** all 7 currencies return numeric balances in 0.48-0.68s; batch (direct) == single (facade) consistency confirmed. Encoding was reasoned against `account_of` (`calls.rs:290`, subaccount = raw 32-byte pubkey) and structurally validated (7 ledgers across 3 families return clean numerics) but the non-zero case is unprovable without a funded pubkey — ultimate confirmation is the founder opening the app + seeing real balances.

**Deposit-proxy timeout fix (commit `bdc9f3e`):** the ckBTC minter's `update_balance`/`get_minter_info`/`get_btc_address` do Bitcoin indexing (Bitcoin canister UTXO query via the native IC Bitcoin integration — an inter-canister call, not HTTPS) — legitimately 7-15s on mainnet. The shared 10s relay timeout + the app's 6s/8s fetch timeouts guaranteed every cold deposit poll failed before the minter returned, so the TTL cache (`91cae05`) never warmed and the deposit sheet showed permanent failure. Fix: new `MINTER_CALL_TIMEOUT_SECS=30` for the three deposit-proxy endpoints (relay, `agent_ledger.rs`); `DEPOSIT_REFRESH_TIMEOUT_MS` 6s→30s + `DEPOSIT_TIMEOUT_MS` 8s→20s (app, `constants.ts`). Steady-state cost unchanged (the TTL cache coalesces repeats). **Verified live after relay restart:** `POST /deposit/refresh/{hex}?currency=1` (mainnet ckBTC) now returns 200 in ~14.7s (was 503 at 10s every call); cache warms (repeat 0.14s, 108× faster, byte-identical); no regressions.

**Wallet restore-from-seed (commits `2c690f6` wire + `99e9b93` UI):** the Backup feature (commit `2482500`) revealed the recovery seed but there was no restore path — onboarding only generated a fresh keypair. Added a new wire method `DpayCore.keypairFromSecret(secretHex)` (FFI `keypair_from_secret` reusing `signing_key_from_seed` → regenerated UniFFI Kotlin + Python bindings + Kotlin `@ReactMethod` + TS `DpayCoreApi` + e2e-shim mirror; bridge-parity 28→29 methods). The Onboarding screen now offers "Restore wallet": enter the 64-hex recovery seed (+ optional username) → derive the keypair → save identity (no faucet — restored wallet has on-chain funds). **One seed recovers BOTH rails** (IC Ed25519 + SOL SLIP-10 derivation). New e2e flow 58 `restore-wallet`. **⚠️ Device-gate candidate:** this added a wire/bridge method — `just verify` validates TS↔Kotlin parity + the FFI roundtrip (`just ffi`, 99 checks), but the real RN→Kotlin→`.so` path for the new method is only exercised by `just app` (`DPAY_SELFCHECK PASS`) / `just ondevice`. Run before launch.

**Pending founder action:** (1) APK rebuild — carries the SOL mainnet RPC (`b2459ca`), the deposit-proxy timeout bumps (`bdc9f3e`), and the restore-from-seed feature (`2c690f6`+`99e9b93`). (2) Device gate (`just app` + `just ondevice`) for the wire/bridge change before launch.

---

## NEXT SESSION — work order (2026-08-08) — ✅ ALL 6 DONE

> **CORRECTION (founder, 2026-08-07): the wire is NOT frozen.** No public release has shipped, so wire-format changes remain
> on the table pre-pilot. Earlier "Wire FROZEN (292/196/132)" notes in the session summaries below were the *working assumption*
> at the time, not a hard constraint. Treat the wire as mutable; any change must still be kept byte-exact across
> `dpay-core` (Rust) ↔ `app/payments.ts` (TS mirror) ↔ `dfx/wire_layout.json` (e2e fixture) ↔ the e2e shim.

These items are unblocked and owner-less — do them next session (RED-first, commit each unit, confidence ≥6/10). Order is a
suggested priority, not a hard sequence.

1. ~~**NFC component merge (DRY, MEDIUM).** `app/components/NfcTap.tsx` (338L) and `SolNfcTap.tsx` (239L) are ~80% structurally~~
   ~~identical: the `NFC_UI`/`SOL_NFC_UI` status records are byte-for-byte identical (9 phases), the `finalize`/`clearSettleTimer`/~~
   ~~`markActive`/`aliveRef`/`committed` lifecycle is shared, the `useEffect` subscribe/arm/disarm is structurally the same, and~~
   ~~the terminal render JSX differs only in `testID`. Extract a `useNfcTapState({...})` hook + a shared `<NfcTapView>` presentational~~
   ~~shell; the IC and SOL variants become thin adapters.~~ **✅ DONE (2026-08-08).** Extracted `app/hooks/useNfcTapState.ts`
   (shared phase state machine + `finalize`/`markActive`/settle-timer + the subscribe→arm→cleanup effect + the
   `error`/`phase`/`request`/`done`/`payment`/`receipt` dispatch skeleton) + `app/components/NfcTapView.tsx` (single-source
   9-phase `TAP_PHASES` record + terminal render + a pure jest-tested `computeTapStatus`). `NfcTap.tsx` (IC) and
   `SolNfcTap.tsx` (SOL) are now thin adapters filling ONLY their protocol (IC: `signAuthorization` + relay `/pay` +
   nonce-reconcile + optimistic deduction + canister-signed receipt verify; SOL: `signOfflineSolPayment` + RPC broadcast +
   npub-match + nextNonce adoption). The seam event names (`DpayNfcEvent`/`__DPAY_TEST_NFC_SESSION` vs
   `DpaySolNfcEvent`/`__DPAY_TEST_SOL_NFC_SESSION`) + native modules (`DpayNfc` vs `DpaySolNfc`) stay correctly distinct.
   testIDs `nfc-status`/`sol-nfc-status` preserved. Latent IC `aliveRef` bug (only SOL had the reset) now closed for both
   rails via the shared hook. Gates: typecheck 0, jest 413/413 (+16 new `nfc-tap-view.test.ts`), e2e **49/49** (flows
   11+32+47 green), bridge-parity OK (28 methods, untouched). **Line delta was ~break-even (+16 net prod)** — the raw
   duplication removed (~218 lines from the two adapters) was offset by the shared infra (hook 162L + view 72L) + type
   defs + the ctx indirection; the DRY win (single-source 9-phase record, lifecycle, render; a 3rd rail is now trivial) is
   the real value, not line count. **Device gate PASSED (2026-08-08):** `just ondevice` 9/9, `just app` `DPAY_SELFCHECK PASS` + `DPAY_SOL_SELFCHECK PASS`.

2. ~~**Currency catalog single-source-of-truth (DRY/anti-pattern, MEDIUM).** The ckUSDC ERC-20 contract~~
   ~~/(`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`), the ckETH gas-ledger principal (`ss2fx-dyaaa-aaaar-qacoq-cai`), ckBTC minter~~
   ~~principal, and decimals (8/6/18) are each independently hardcoded in ≥3 places that can drift: `app/config/catalog.ts`~~
   ~~/(`BUNDLED_CATALOG`, the cold-load fallback), `crates/dpay-relay/src/ledger.rs` (`fake_catalog`), and the deploy scripts~~
   ~~/(`scripts/dfx-deploy-ic.sh`, `dfx-deploy-ic-staging.sh`). Drift = wrong-decimals balance display on cold load or wrong metadata~~
   ~~registered at deploy. Minimum bar: `fake_catalog()` references the same Rust consts it already defines (it doesn't, for all~~
   ~~fields). Ideal: generate the app fallback + deploy literals from one JSON. The app fallback MUST stay in the bundle (offline~~
   ~~render path) — the goal is one generator, not deletion.~~ **✅ DONE (2026-08-08, minimum bar).** Introduced `dfx/catalog_truth.json`
   as the single source of truth for drift-prone mainnet metadata (ckBTC/ckETH minters, ckUSDC ledger, ckETH gas-ledger, ckUSDC
   ERC-20 contract, decimals). `fake_catalog()` now references 3 newly-added `pub(crate) const`s (ckBTC minter, ckETH minter,
   ckUSDC ledger) instead of re-stringifying them. **Drift alarms: Rust** (`catalog_truth_tests` — 2 tests, `include_str!` JSON,
   consts==JSON + fake_catalog==JSON; RED verified by mutation) **+ jest** (`app/__tests__/catalog.test.ts` — 3 tests,
   BUNDLED_CATALOG==JSON for currencies 0/1/2). `BUNDLED_CATALOG` stays a static bundle value (offline render path intact). Chose
   minimum bar over codegen: fake_catalog already used its consts; codegen would add CI surface the founder didn't ask for; and
   staging deploy is a *different* (testnet) catalog that can't be cleanly unified. Gates: test-relay **51/51** (+2), jest **416**
   (+3), typecheck 0. **Remaining drift surface (ops-only, follow-up):** deploy scripts hardcode inline `dfx canister call` candid
   literals (mainnet) + staging's distinct testnet catalog — bash literals can't be cleanly cross-checked offline without a fragile
   grep step. Commit `f1dd97b`.

3. ~~**`RECEIPT_CLAIM_LEN` single-source (UNBLOCKED, correctness).** The receipt-claim length is `16+32+32+8+4+8+8 = 108` bytes.~~
   ~~Rust has it as a named sum (`dpay-core/src/lib.rs:123`, `RECEIPT_CLAIM_LEN = NONCE_LEN + PUBKEY_LEN + ...`); the TS mirror~~
   ~~re-derives it as a magic-number sum (`app/payments.ts:142`). The other wire consts are already cross-validated by~~
   ~~`dfx/wire_layout.json` (which has a full `receipt` section, asserted by e2e flow 00).~~ **✅ DONE (2026-08-08).** Added a
   jest drift-alarm in `app/__tests__/payments.test.ts` (4 tests) that reads `dfx/wire_layout.json` and asserts the TS
   `RECEIPT_CLAIM_LEN` + the per-field magic sum + every field's offset+len match the JSON (catches resize AND reorder) +
   JSON self-consistency. A receipt-field resize now goes RED until `payments.ts` is updated in lockstep. The prod const keeps
   its explicit sum (annotated to name the JSON as source of truth) — importing JSON into the RN bundle for one const would be
   bundle-bloat with no precedent in the app; the test-only assertion is the clean single-source guard. Gates: jest 397/397
   (+4), typecheck 0, test-core 45/45. No wire bytes changed. Commit `0b18911`.

4. ~~**Deploy-script consolidation (DRY/anti-pattern, LOW-MEDIUM, ops-only).** `scripts/dfx-deploy.sh` (152L), `dfx-deploy-ic.sh`~~
   ~~(198L), `dfx-deploy-ic-staging.sh` (369L) share copy-pasted scaffolding: the `CARGO_HOME`/`RUSTUP_HOME`/`PATH` export block,~~
   ~~a verbatim-identical `nat()` candid-extract helper, `load_identity` + `dfx_i` wrappers, the `candid-extractor` guard, the wasm~~
   ~~build, the `jq` merge into `canister_ids.json`, and the `register_currency` idempotency logic. Extract a `deploy/dfx-lib.sh`~~
   ~(alongside the existing `deploy/env-lib.sh`); the three scripts become thin target-specific callers. Not shipped code; the~~
   ~~/cost of NOT doing it is a deploy-process bug must be fixed in three places. This is the "many disconnected scripts that should~~
   ~~be one with subcommands" anti-pattern (mild — different deploy targets, but heavy shared scaffolding).~~ **✅ DONE (2026-08-08).**
   Extracted `deploy/dfx-lib.sh` (`setup_dfx_env`/`require_cmd`/`nat`/`build_canister_wasm`/`refresh_candid`/`merge_canister_id`/
   `load_identity` + optional `identity_load_hint` hook). 3 scripts now thin target-specific callers. `bash -n` + `shellcheck 0.7.1`
   clean on all 4 files. **`register_currency` idempotency intentionally LEFT duplicated** — the 3 scripts use genuinely
   incompatible strategies (clean-replica no-guard / overwrite-meta / probe+classifier), so a shared helper would force a bad
   abstraction (KISS/YAGNI). Behavior byte-faithful (section-sequence + jq/cargo bodies diffed identical). Commit `27a1a82`.

5. ~~**WithdrawSheet confirm-step verification (verify-or-improve).** The 2026-08-07 audit found `WithdrawSheet.tsx` already has an~~
   ~~inline review card (`withdraw-review`, lines 183-189: "Review withdrawal / Withdraw X to Y") + a disabled-until-valid confirm~~
   ~~button (`btn-withdraw-confirm`, lines 193-202) with live validation (below-min/over-balance/bad-addr). **Verify this is a~~
   ~~sufficient confirm affordance** (it was judged so). If on re-review a separate explicit two-step review screen reads better,~~
   ~~add it — but weigh the extra tap + the e2e-flow risk. Do not assume it's missing.~~ **✅ VERIFIED SUFFICIENT — NO CHANGE
   (2026-08-08).** The inline `withdraw-review` card renders live as soon as amount > 0 (showing "Withdraw X to <addr>") and
   `btn-withdraw-confirm` is `disabled={!canReview}` until addr+amount validate (live `belowMin`/`overBalance`/`badAddr` guards).
   This is a one-screen inline review with a disabled-until-valid confirm — strictly fewer taps than a separate two-step review
   screen, with no loss of confirmation clarity. Adding a second screen would add a tap and risk 4 e2e flows (15-withdraw,
   18-withdraw-errors, 44-cketh-withdraw, 48-ckusdc-withdraw) for no UX gain. Verdict: keep as-is.

6. ~~**Deeplink scheme + remote request-payment (FEATURE — plan, then build).** A merchant's Request QR (`ReceiveMode.tsx:152`)~~
   ~~cannot currently be shared as a link: the request value is a raw base64url blob, not a URI, so copying/sharing it is useless to~~
   ~~a recipient. **Plan and/or build a `dpay:` deeplink scheme** so a request can be sent over a messaging app and opened on the~~
   ~~payer's phone to populate the pay screen (remote "send me money"). Scope questions to resolve up front: the URI shape~~
   ~~(`dpay:req:<base64url>`?), deep-link registration in `android/app/src/main/AndroidManifest.xml` (intent-filter), how the payer~~
   ~~app receives + routes it (App.tsx deep-link handling — there is already a `lib/deepLink.ts` helper to check), and whether the~~
   ~~same scheme should carry signed-payment receipts (e.g. `dpay:pay:...`) for a non-NFC receipt hand-back. This is the largest~~
   ~~item; start with a design note in the plan doc, then implement incrementally. Pairs with the existing request-QR + NFC tap paths.~~
   **✅ DONE (2026-08-08).** Built a `dpay:req/<blob>` + `dpay:pay/<blob>` codec (`app/lib/deepLink.ts` — pure `encodeDeeplink`/
   `decodeDeeplink`, 16 jest cases) where `<blob>` is the EXACT base64url the request QR already carries (no new wire format). The
   `req` path is FULLY WIRED: ReceiveMode's "Share request link" (`btn-share-request`) wraps `reqQr.value` via `encodeDeeplink`;
   the payer's Wallet routes a `dpay:req/` arriving at launch (Android `Linking.getInitialURL` + `addEventListener('url')`, 2s-
   timeout-bounded) or the web `?req=` mirror (`readRequestDeeplink`) → `prefillRequest` state → PayMode's prefill effect reuses the
   EXACT camera-scan decode path (`onRequestString` → `parseRequestQR` → `decodeRequest` → review). **SECURITY INVARIANT: a
   deeplink ONLY pre-fills the review screen — it NEVER calls `approve()`/signs** (the payer taps Approve; e2e flow 49 asserts it
   lands on REVIEW not Paid). Android intent-filter added on MainActivity (`dpay` scheme, BROWSABLE, singleTask already set).
   `dpay:pay/` (signed-receipt hand-back, payer→merchant when NFC is unavailable) is CODEC-ONLY — its `decodeDeeplink` parses + a
   `readPaymentDeeplink` web reader exists, but the merchant-side verify/reconcile wiring is **DEFERRED to a follow-up** (spec the
   reconcile path first). Gates: jest 432/432 (+16 codec), e2e **50/50** (flow 49 added; FLOWS.md regenerated), typecheck 0,
   bridge-parity OK (28, untouched), test-core 45/45. **Device gate PASSED (2026-08-08):** `just app` (`DPAY_SELFCHECK PASS`) + `just ondevice` (9/9) + `adb shell am start -d 'dpay:req/<blob>'` resolves to MainActivity on cold AND warm start, no crash. Commits `1bf4045` (codec) → `811dbe6` (e2e).

## Session summary (2026-08-07): deep audit + hardening — fail-closed dispatch, debuggability, timeout/lock hardening, DRY

> All gates green at this session's close: `just verify` clean (**49/49 e2e** in ~100s at concurrency 2), `just test-canister` **82/82** (+1 fail-closed), `just test-relay` **49/49** (--features test-helpers), `just test-live` **51** (2 live ICP marked LEAK = thread-cleanup), jest **393/393**, `just typecheck` 0 errors, `just bridge-parity` OK (28 methods). On `main`, **6 commits this session** (8 ahead of origin/main). Wire FROZEN (292/196/132) untouched.

**Headline: a fresh whole-codebase audit (2 parallel subagents) surfaced ~20 NEW correctness/debuggability/DRY findings beyond the documented-deferred list; ALL high+medium items actioned across 6 waves.** No new features; this was a quality/correctness pass. Plan: `2026-08-07-deep-audit-ux-harness.md`.

**Wave 1 — canister correctness + observability (commit `39c83a7`):**
- **Fail-closed withdraw dispatch** (resolves the documented `unwrap_or(CkBtcUtxo)` deferred item): `lib.rs:1504` now match-arms `currency_family()`: `Some(f) => f`; `None` + a registered minter => legacy `CkBtcUtxo` (backward-compat with ckBTC deployments that registered a minter but no family meta); `None` + NO minter => `Err("no minter family and no minter")`. Pure fail-closed would have broken the BTC test `setup()` (registers minter, no family meta); the hybrid closes DEMO play money while preserving compat. New PocketIC test `withdraw_failclosed_no_minter_no_family` (82/82).
- **`nat_to_u64(...).unwrap_or(0)` silent coercion → logged** (3 sites — pay ReceiptClaim block_index, reconcile orphaned-debit amount, withdraw WithdrawReceipt block_index): now `.unwrap_or_else(|e| { ic_cdk::print(...); 0 })`. Defensive today (real indices fit u64) but a Nat overflow would have falsified a SIGNED outcome claim with no alarm.
- **Display-cache `Err` drops → logged** (8 sites — pay payee/burn, reconcile both sides, refresh_deposit both branches, withdraw): added `else { ic_cdk::print("WARN ...") }`. Display-only (settlement reads the ledger authoritatively); the gap was zero observability.
- **BTC withdraw catch-all → logged**: `lib.rs:1809` adds an `ic_cdk::print` naming the `RetrieveBtcWithApprovalError` variant before the settle arm. Behavior unchanged (settling unknowns = treat as dead auth = prevents double-burn, the money-safe choice); observability only.

**Wave 2 — app debuggability + dead code + DRY (commit `89005de`, 22 files, net −163/+106):**
- **Silent catches → `console.warn`**: `verifyOutcomeReceipt` (sig-verify + cmpRaw catches, `services/receipt.ts`), `payAndClassify` + `readJsonOrEmpty` (`services/relay.ts`), `broadcastSolPayment` (`solana.ts`). Safe returns preserved; only diagnostic logging added. Closes the device-blind-spot class where a bridge/FFI throw looked identical to an invalid signature.
- **Dead code deleted** (each grep-verified zero prod callers): `toCents`/`toSats` (`lib/format.ts`), `formatUnitsToDecimal` (`lib/amount.ts`), `composeSignal` (`lib/timeout.ts`), `NATIVE_MINT_ADDRESS` (`solana/spl.ts`) + their test cases.
- **`hexToBytes` consolidated** (was triplicated): canonical throwing version in `lib/format.ts`; copies deleted from `payments.ts`/`solana.ts`/`solana/identity.ts`.
- **`withTimeout(ms)` helper** added to `lib/timeout.ts`; replaced 12 inline `AbortController+setTimeout+clearTimeout` blocks across 10 components.
- **`normalizeSubaccount`** extracted in `cketh.ts`; both `encodeDepositErc20`/`encodeDepositEth` use it.

**Wave 3 — relay hardening (commit `10e2ff4`):**
- **AgentLedger value-moving calls now timeout-bounded** (resolves an INACCURATE prior audit claim): `pay`/`withdraw`/`faucet`/`deposit_address`/`deposit_info` `.call_and_wait()` wrapped in `tokio::time::timeout(CANISTER_CALL_TIMEOUT_SECS)` (previously only the 3 poll-path methods were). A stalled replica no longer wedges a value-moving request ~5min (ic-agent default expiry).
- **Mutex poison recovery** (resolves the documented ×17/×18 deferred item): all `.lock().unwrap()` → `.lock().unwrap_or_else(|p| p.into_inner())` across `app.rs` (8), `ledger.rs` (9), `agent_ledger.rs` (1). Matches the FFI's recoverable `lock()` helper.

**Wave 4 — FlakyLedger cfg-gate (commit `a762de2`):** gated the test-only `FlakyLedger` retry harness out of the prod binary (`#[cfg(any(test, feature = "test-helpers"))]` on struct + impls + re-export). `test-relay` recipe now passes `--features test-helpers`. Surfaced + fixed a latent assertion bug (`tests/test_helpers.rs` compared int literals against the relay's `U64String`-serialized u64 — prod serialization was correct, the test was wrong).

**Wave 5 — test-live recipe fix (commit `12181dd`):** `test-live` now passes `--features agent,test-helpers` (FlakyLedger is feature-gated).

**Wave 6 — visual baseline re-seed (commit `ee556ef`):** flow 40 pixel-drift proven pre-existing (identical on pristine tree via stash) → baselines re-seeded. No intentional UI change.

**Items examined but deliberately NOT changed (low ROI / risky / subjective):**
- Enter-to-submit consistency: mobile decimal-pad keyboards have no Enter key; only fires on web. Marginal for the Android-first target. Left as-is.
- WithdrawSheet confirm step: the inline review card + disabled-until-valid confirm button IS the confirm step; a separate two-step would add friction + risk the e2e flows. Left as-is.
- Pre-filled request amount ('25.00'): demo convenience; changing risks e2e flows that type over it. Left as-is.
- `RECEIPT_CLAIM_LEN` magic-number sum in `payments.ts:142`: e2e flow 00 already cross-validates `wire_layout.json receipt.fixed_len==108`; drift causes a LOUD receipt-verification failure, not silent. Low priority.
- NFC component merge (NfcTap.tsx + SolNfcTap.tsx ~80% identical): larger refactor with e2e-seam-event-name divergence risk; deferred.
- Catalog single-sourcing (app BUNDLED_CATALOG / relay fake_catalog / deploy candid literals): partly inherent (offline fallback vs demo ledger vs deploy); full unification is a larger coordination effort.

## Session summary (2026-08-06, part 6): polish + tech-debt — canister split, 5 correctness/DRY fixes, UX pass

> All gates green at this session's close: `just verify` clean (**49/49 e2e** in 86.54s), `just test-canister` **81/81**, `just test-relay` **50/50** (incl 2 live ICP), jest **401/401**, `just typecheck` clean, `just bridge-parity` OK (28 methods), visual regression GREEN (ledger baseline re-seeded for intentional L-hotkey drift). On `main`, **49 commits** ahead of origin/main. Wire FROZEN (292/196/132) untouched.

**Headline: no planned work remained, so this session found+fixed all issues, split the 3450-line canister, and did a UX pass.** Three parallel research subagents audited the entire prod codebase (panic/silent-err/vague-error audit, network-timeout audit, unused-code audit). All findings ACTIONED across 3 waves (8 commits total). Plan: `2026-08-06-polish-and-debt.md`.

**Wave 1 — 5 fixes (commits `08e6a70`..`ceca63b`):**
- **P1 `resyncNonce` wired** (`08e6a70`): `app/solana.ts:209` was exported/tested/documented but NEVER called by any prod component — a SOL payer whose nonce went stale had NO in-app recovery (forced a rent-costing fresh `setupNonce` ~0.0015 SOL). Added a `resync()` handler + `btn-sol-pay-resync` button in `SolPayMode.tsx`.
- **P2 canister `expect()`→`?`** (`8d3b2ee`): `record_txn` (post-commit history write, canister `lib.rs:2038`) and `ensure_receipt_key` (`:1803`, inside `pay`) now propagate `StableCell::set` failures via `?` instead of trapping. Narrows the orphan-trap window: the nonce reservation survives a stable-write failure (no double-spend vector), only the history record is missing (repaired by `reconcile`).
- **P3 `composeTimeout` DRY** (`387aaa5`): extracted the byte-for-byte duplicate from `services/relay.ts:36` + `solana/rpc.ts:66` to ONE shared helper `app/lib/timeout.ts`. ALSO fixed `payAndClassify` (relay.ts:88) which used bare `signal` unlike its 5 siblings — now uses `withDefaultTimeout(signal)`.
- **P4 canister vague error** (`19d82f1`): `format!("transient: {:?}", "ledger busy/insufficient")` Debug-formatted a string literal and collapsed two distinct `TransferError` variants while dropping `InsufficientFunds.balance`. Split into two arms: `insufficient_funds balance={balance}` and `temporarily_unavailable`.
- **P5 dead exports** (`ceca63b`): dropped unnecessary `export` from `findProgramAddress` (spl.ts:73, internal-only) and `SYSVAR_RENT_ADDRESS` (nonce.ts:26, internal-only).

**Wave 2 — canister split (commit `e8ee866`):**
- Split the **3450-line** `crates/dpay-canister/src/lib.rs` along two seams: **`types.rs`** (1167 lines — all data types, Storable impls, encoding helpers, API structs, mirror types, constants) + **`calls.rs`** (313 lines — all cross-canister call helpers + pure value helpers) + **`lib.rs`** (1997 lines — thread_local statics, nonce management, guards, entry points). All split-out items `pub(crate)`; candid-exported types stay `pub`. 81/81 PocketIC tests green; candid interface byte-for-byte unchanged.

**Wave 3 — UX pass (commits `40cc9bd`, `80cf85a`):**
- Added Done buttons to `DepositSheet` + `CkErc20DepositSheet` success screens (inconsistent with all other success sheets). Fixed surviving "relay" jargon in `CkErc20DepositSheet` error ("server"). Fixed bare-lowercase "no camera" → "No camera found on this device." in `QrScanner.tsx`. Added Copy signature button to `SolReceiveMode` success (was selectable-only).
- Added **L** keyboard shortcut for the Transactions tab (T was taken by Top-up, so Ledger had no shortcut). De-jargoned SOL offline-pay Setup + Stale copy in `SolPayMode.tsx` to plain language. Re-seeded `ledger.png` baseline (intentional drift from the L-hotkey hint).

**Tech-debt findings DEFERRED (documented 2026-08-06; status updated 2026-08-07):**
- ~~Relay `Mutex::lock().unwrap()` ×17 (app.rs ×8, ledger.rs ×9) — poison would wedge the service; FFI already has the recoverable pattern.~~ ✅ **DONE (2026-08-07, `10e2ff4`)** — all 18 sites now `.lock().unwrap_or_else(|p| p.into_inner())`.
- ~~Display-cache refresh silent `Err` drops + silent `Tainted` UTXO skip — no settle impact; would benefit from `ic_cdk::print`.~~ ✅ **DONE (2026-08-07, `39c83a7`)** — 8 sites now log.
- ~~Dispatch default `unwrap_or(CkBtcUtxo)` — a currency with no family meta defaults to the BTC path; should fail-closed.~~ ✅ **DONE (2026-08-07, `39c83a7`)** — now fails-closed when no minter AND no family meta (legacy compat preserved when a minter is registered).
- ~~BTC withdraw catch-all collapses variants into the permanent/settle arm — fragile to upstream enum growth.~~ ✅ **OBSERVABILITY-DONE (2026-08-07, `39c83a7`)** — the MinterFamily match is now exhaustive (no `_ =>` wildcard, compiler-enforced); the external-enum `RetrieveBtcWithApprovalError` catch-all keeps the money-safe settle behavior but now logs the variant. Behavior unchanged (settling unknowns prevents double-burn).
- WC per-`request()` unbounded (wallet.ts:125/140/182/213) — inherent to EIP-1193 (no standard timeout param); pair bounded at 5min.
- ~~UX deferred: SOL rail different action vocabulary; SOL offline Pay/Request buried 2 taps deep; Request QR no Share affordance; no focus management/trap on sheets (bigger a11y refactor); Onboarding faucet failure silent; Enter-to-submit inconsistent; WithdrawSheet no explicit confirm step; SolanaWithdrawSheet raw RPC error verbatim; pre-filled request amounts.~~ Partially DONE in `55ee6ef` (focus trap on sheets, faucet-failure honesty, SOL error mapping, Receive/Send verbs). The remainder (Enter-to-submit, confirm step, Share, pre-fill, SOL depth) examined 2026-08-07 and left as-is — see the 2026-08-07 session summary "Items examined but deliberately NOT changed" for rationale.

**Audit verdicts (clean areas, no action needed):** dpay-core prod genuinely panic-free; dpay-ffi prod clean; ckERC20 withdraw fully wired across canister+candid+relay+app+e2e; SOL rail structurally complete + device-gated. **Updated 2026-08-07:** the prior claim "all agent calls via `tokio::time::timeout`" was INACCURATE (5 value-moving `AgentLedger` calls lacked it) — now CORRECTED in code (`10e2ff4`) so the claim is true.

---

## Session summary (2026-08-06, part 5): SOL offline-pay durable-nonce rail — FULLY BUILT (QR + NFC, all 13 units done)

> All gates green: `just verify` **48/48 e2e** (added flows 46+47) in ~115s, jest **400/400** (added solana-nonce/spl/qr/rpc/seam/persist/payments suites), `just typecheck` clean, `just bridge-parity` OK (28 methods, +7 SOL NFC). Device gate: `just app` → `DPAY_SELFCHECK PASS` + `DPAY_SOL_SELFCHECK PASS` (module loads, no crash). Wire FROZEN (292/196/132) untouched; ZERO canister/relay/facade/core change — fully app-scoped.

**Headline: the SOL offline-pay durable-nonce rail is FULLY BUILT — QR path + NFC parity.** The payer signs fully offline (airplane mode) using a stored durable-nonce value as `recentBlockhash`; the merchant broadcasts + confirms in ~1s and hands back the advanced nonce (receipt-nonce-relay). This is dpay's signature feature for SOL. Commits `fe2be81` → `d772ae3` (13 units across 6 phases).

- **Phase A — pure builders** (byte-exact vs `@solana/web3.js`/`@solana/spl-token` goldens): `nonce.ts` (assembleMessage generic + CreateNonceAccount + AdvanceAndTransfer), `spl.ts` (Token.transfer + ATA PDA derivation via noble ed25519 off-curve check), `qr.ts` (solreq:/solpay: URI codec, hand-rolled base64url+UTF-8).
- **Phase B — network + state**: `rpc.ts` extended (getNonceAccount parses the 80-byte NonceState layout, getMinimumBalanceForRentExemption, `__DPAY_TEST_SOLANA_RPC_STUB` e2e stub seam); `solana.ts` seam extended (signOfflineSolPayment/signOfflineSplPayment PURE, createNonceAccount/broadcastSolPayment/resyncNonce ONLINE, SolReceipt interface); `solNoncePersist.ts` (AsyncStorage wrapper for payer nonce state).
- **Phase C — outcome logic**: `solana/payments.ts` (decideSolPayerReceipt — optimistic nextNonce adoption, base58 npub binding, honest pending/declined/ignore branches).
- **Phase D — QR UI**: SolPayMode.tsx (payer: setup→scan→review→qr→paid, honest pending), SolReceiveMode.tsx (merchant: form→reqQr→result), Wallet wiring, e2e flow 46 (stub-RPC offline handoff round-trip).
- **Phase E — NFC HCE transport** (commit `d772ae3`): `DpaySolNfc.kt` (437 lines, pure-Kotlin APDU state machine — card+reader, ArrayBlockingQueue rendezvous, chunked PUT/GET protocol with tag/moreflag, AID `F06470617902`), `DpaySolNfcModule.kt` (8 @ReactMethods), `DpaySolHostApduService.kt` (HCE card), `SolNfcTap.tsx` (NFC UI mirroring NfcTap lifecycle — autoSign on request, adopt nextNonce on receipt), e2e flow 47 (SOL NFC tap simulation). A SECOND fully-independent NFC transport — does NOT touch `dpay-core/nfc.rs` (which is IC-wire-specific).
- **Phase F — self-check + docs**: `DPAY_SOL_SELFCHECK` extended to exercise `buildAdvanceAndTransferMessage` on Hermes; OPEN_ISSUES/CODEBASE_ANALYSIS/CLAUDE updated.

**Remaining outer-loop (NOT autonomous):** mainnet RPC config (operator edits `config/constants.ts` to Helius/QuickNode); physical two-phone NFC radio proof (the RF antenna-coupling hop, same class of gate as the IC rail); 2 v2 follow-ups (source-ATA auto-create for USDC offline; stronger getTransaction receipt verify).



> All gates green at close: `just verify` **46/46 e2e** (added flow 45) in ~36s, jest **295/295** (added solana-identity/tx/rpc/seam suites), `just typecheck` clean. Wire FROZEN (292/196/132) untouched; ZERO wire/relay/facade/canister/core change — fully app-scoped. No new native dep (hand-rolled with `@noble/curves`+`@noble/hashes`+`bs58`, all already transitive in `app/node_modules`). The 3 founder forks resolved as recommended: standard `m/44'/501'/0'/0'` derivation (Phantom-compatible), config-driven RPC URL defaulting to public devnet (no key needed), scope = online in/out (native SOL only, offline durable-nonce rail = follow-on).

**Headline: native SOL now moves in and out of the wallet via a device-held Solana key — no IC canister, no relay, no chain-key dependency.** Commits `0fafae7` → `329b4d5`.

- **Key derivation** (`app/solana/identity.ts`, `0fafae7`): SLIP-0010 BIP32 ed25519 at `m/44'/501'/0'/0'` derived from the existing IC identity seed (`Identity.secretHex`) → a separate Solana ed25519 key (one backup recovers BOTH rails). Spec-vector-verified + Python-stdlib-cross-checked. Exports `deriveSolanaKeypair`/`deriveSolanaAddress`/`isValidSolanaAddress`/`SOL_DECIMALS=9`. Hand-rolled HMAC-SHA512 (noble's `hmac` functional form is non-standard across this tree's multi-version `@noble/hashes`).
- **Tx builder** (`app/solana/tx.ts`, `0fafae7`): hand-rolled legacy System.transfer message + signer — byte-exact vs `@solana/web3.js` v1.98.4 (golden: message, signature, full wire all match). Account order `[from(signer,0), to(1), SystemProgram(2)]`.
- **RPC client** (`app/solana/rpc.ts`, `26c84a7`): minimal JSON-RPC over `fetch` with bounded timeouts (manual `AbortController`+`setTimeout` compose — `AbortSignal.any/timeout` are absent from Hermes). `getBalance`/`getLatestBlockhash`/`sendTransaction`/`confirmTransaction`. Hand-rolled base64 (no Buffer/btoa dep).
- **Isolation seam** (`app/solana.ts`, `1b418a0`): pure fns (identity/tx) static-imported; RPC dynamic-imported inside async fns (mirrors `app/wallet.ts`→`app/walletconnect.ts`). Config: `SOLANA_RPC_URL = __DPAY_TEST_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'` (empty = disabled). **Offline-loop-safe:** `jest.setup.js` + `e2e/harness/driver.mjs` both set the override `''` → jest + e2e never hit devnet; the SOL balance hook no-ops and the card renders with `—`. Exactly the WC disable pattern.
- **UI** (`544c7c7`): `useSolanaBalance` hook (polls, generation-gated + AbortController teardown, empty-RPC no-op); BalancesSheet SOL card (SEPARATE from the catalog loop — SOL is a native device-key rail, not relay-mediated ICRC); `SolanaReceiveSheet` (address QR, mirrors DepositSheet); `SolanaWithdrawSheet` (send — signs LOCALLY with noble + broadcasts to Solana RPC, no relay/DpayCore). Wallet derives the SOL address via `useMemo` and threads it through.
- **Device gate** (`0b377c9`): added `DPAY_SOL_SELFCHECK` to `App.tsx` (a separate useEffect derives a SOL address from a generated keypair and asserts `isValidSolanaAddress`) + a matching wait/assert in `scripts/rn-run.sh`. This proves the SLIP-10+noble+bs58 crypto runs on real Hermes — the exact native-module/polyfill blind spot. (`just app` is the outer-loop gate that exercises this.)
- **e2e flow 45** (`329b4d5`): offline-rendered SOL card + receive-address-QR (drives the real in-browser `deriveSolanaAddress`, asserts a 32–44-char base58 address; send button correctly absent because balance is `—`). FLOWS.md regenerated (45→46 flows).

**SOL MVP = DONE.** Online SOL in/out (balance + receive address QR + send/withdraw) is implemented, offline-gated, and green on all inner-loop gates. The on-device proof (`just app` → `DPAY_SOL_SELFCHECK PASS`) + a real devnet send remain outer-loop (emulator/network), as documented.

**Next (SOL follow-on, NOT blocking):** the offline-pay durable-nonce rail (PoC already on-chain-proven in `.dev/sol-poc/` — durable-nonce offline-sign + stale-blockhash survival + rent ~0.00145 SOL/nonce account). Plus: mainnet RPC config + a real-device devnet send as the outer-loop confidence check.

### SOL MVP — follow-ups (partially-implemented / outer-loop / fragile)

> The MVP is feature-complete on all inner-loop gates. Items 1–3 (deps, device gate, devnet send) are now ✅ CLOSED; items 4–6 remain (offline-pay rail, mainnet RPC config, e2e send flow). Ordered by original risk.

1. **✅ DONE (commit `ed1b4c2`).** Transitive deps declared: `@noble/curves@1.8.0`, `@noble/hashes@1.4.0`, `bs58@6.0.0` pinned (exact, no caret) as explicit `dependencies` in `app/package.json`; lockfile refreshed offline. jest 295/295 + e2e flow 45 still green.
2. **✅ DONE (2026-08-06).** Device gate run: `just app` on the API-36 x86_64 emulator (`emulator-5554`) → logcat showed **both** `DPAY_SELFCHECK PASS` **and** `DPAY_SOL_SELFCHECK PASS`. This proves `@noble/curves`/`@noble/hashes`/`bs58` bundle under Metro/Hermes and the SLIP-10 ed25519 derivation runs on real Hermes — the native-module/polyfill blind spot (AGENTS.md blind-spot 1). APK built 94M.
3. **✅ DONE (2026-08-06).** Real devnet round-trip from the APP proven. A faithful Node proof transpiled the app's REAL `solana.ts`/`identity.ts`/`tx.ts`/`rpc.ts` (+ the `config/constants.ts` `SOLANA_RPC_URL` seam) to CJS via `tsc`, funded the app-SLIP-10-derived address `ByXPEXoQdV5y4KqXmykrkwSDhbNjMuwqdp4uYdvWNZPS` from PoC key `a`, and ran the app's `getSolanaBalance` + `sendSol` → `getLatestBlockhash` + `sendTransaction` + `confirmTransaction` path against `api.devnet.solana.com`. Send sig `36iNhSstnx5DW72hmne27Thr453JmQUGFiTrL3pLYdrEHU4BukAgCUSQH6cBiZHsb9BxnEXrAjEWpYvit4rJyb3X` (0.001 SOL → PoC key `b`), target delta exactly +1_000_000 lamports, confirm passed. Proof script lives at `.dev/sol-proof/run.cjs` (gitignored; re-runnable: `node .dev/sol-proof/run.cjs`). **Note:** devnet RPC is a load-balanced pool — a freshly-confirmed fund may be invisible to the node that simulates the next tx (preflight "no record of a prior credit"); the proof polls the app's `getBalance` until it sees the funds + retries the send. This is a devnet-pool quirk, not an app bug.
4. **✅ DONE (2026-08-06).** Offline-pay durable-nonce rail — QR path BUILT + e2e-proven (commits `fe2be81`→`cb4ff51` + self-check `e85fbd7`/`79c475e`). The full QR offline-pay feature is implemented: pure builders (`nonce.ts`+`spl.ts`), QR codec (`solreq:`/`solpay:`), RPC stub seam, seam lifecycle (signOffline/createNonce/broadcast/resync), payer nonce persist, receipt-nonce-relay outcome logic, SolPayMode + SolReceiveMode UI, Wallet wiring, e2e flow 46 (47/47 GREEN, jest 400/400). Covers SOL + SPL/USDC. **Device gate CONFIRMED: `just app` → `DPAY_SELFCHECK PASS` + `DPAY_SOL_SELFCHECK PASS`** (the extended self-check exercises `deriveSolanaKeypair` + `buildAdvanceAndTransferMessage` on Hermes; the initial run caught a self-check-input bug where authority==toAddress caused `assembleMessage` to dedup accounts — fixed `79c475e`). **NFC parity ALSO DONE** (commit `d772ae3`): a second fully-independent NFC transport (pure Kotlin HCE, AID `F06470617902`) + e2e flow 47. The `DpaySolNfc` coordinator carries variable-length `solreq:`/`solpay:` URI strings + the receipt-nonce-relay JSON over a chunked APDU protocol (PUT/GET + tag/moreflag). Device gate CONFIRMED: `just app` → both self-checks PASS, module loads, no crash. Physical two-phone radio hop stays a physical-device gate (same as the IC rail). Two v2 follow-ups recorded (non-blocking): source-ATA auto-create for USDC, stronger getTransaction receipt verify.
5. **🟡 Mainnet RPC config (operator step).** `SOLANA_RPC_URL` defaults to public devnet. For production, an operator edits `config/constants.ts` to a Helius/QuickNode URL+key (public `api.mainnet-beta.solana.com` rate-limits at 40 req/10s — fails the 2.5s balance poll). No code change; config + redeploy.
6. ~~**🟢 e2e SOL send flow (deferred).** Flow 45 covers the SOL card + receive address QR. A send flow needs a funded balance, which requires live RPC — incompatible with the offline e2e loop (RPC disabled → balance `—` → send button hidden). Defer to the devnet/device confidence path (item 3), or add a `__DPAY_TEST_SOLANA_RPC` stub seam later.~~ **✅ DONE (2026-08-09).** The `__DPAY_TEST_SOLANA_RPC_STUB` seam (already used by flows 46/47 for the offline-pay rail) now backs flow 52-sol-withdraw (stub funds 5 SOL → `btn-sol-send` renders → enter addr+amt → `sendSol` via stub → "Sent ✓" + signature). Plus flow 51-sol-merchant-broadcast (merchant broadcast path) + flow 53-sol-merchant-error (rejecting stub → friendly error). The entire SOL merchant + withdraw + error surface is now e2e-covered.

## Session summary (2026-08-06, part 3): native-ETH LIVE-PROVEN both directions on Sepolia + SOL native-device-key decision + PoC + architecture plan

> Carries forward the part-2 gates (canister 73/73, relay 48/48, e2e 45/45, jest 263/263, typecheck, bridge-parity OK 21, `just app` DPAY_SELFCHECK PASS). No production code changed in this part — docs + planning only (plus deletion of two throwaway proof scripts). Wire FROZEN (292/196/132) untouched.

**Headline: the native-ETH rail is now CONCLUSIVELY PROVEN LIVE, BOTH DIRECTIONS, against prod mainnet IC canisters + real Sepolia ETH. And the SOL path is decided + prototyped + planned.**

- **ETH IN (deposit→mint):** 0.08 SepETH sent to helper `0x2D39863d…` with `depositEth` calldata (tx `0x108c86807e353456786ab00286ad74915eb3cfdac9d30c6804f6769d6f535839`, block #11429442) → **minted 0.08 ckSepoliaETH** (80_000_000_000_000_000 raw 18-dec) to the dpay subaccount on prod facade `ssqti`. Minter (`jzenf-aiaaa-aaaar-qaa7q-cai`) scraped block 11_429_549 (107 blocks past the deposit).
- **ETH OUT (withdraw):** 0.04 ckSepoliaETH burned (ledger `block_index = 8168`) via facade family-dispatch → ckETH minter `withdraw_eth` → **0.039923 real SepETH (39_922_980_593_032_000 Wei) delivered** to destination `0x78a5ccF3…`. Fee reconciliation: burned 40e15 + 1e7 ledger fee; delivered 39.923e15 (minter gas ≈ 77 Gwei × 21k). All numbers tie out.
- **Verdict: ETH in/out is DONE + LIVE-PROVEN.** The facade WASM was upgraded by the founder (family-dispatch live on `ssqti`); currency 5 (ckSepoliaETH) offramp flipped to Direct; app min-floor fixed (`7dc894a`). The only residual is a prod relay image redeploy (the Sepolia helper fix + app-side changes are in source; prod relay runs old commit but withdraw worked as a generic pass-through).
- **The native-ETH feature was delivered this round** across: canister family-dispatch (`9fc4a9f`) + app/relay (`9df982e`) + e2e flow 44 (`6e4f255`) + min-floor fix (`7dc894a`).
- **SOL DECISION (2026-08-06): native device-key path, NOT ckSOL.** Production ckSOL canisters are not deployed (IC0537 "no wasm module"; dfinity/cksol README labels minter `lh22c-…` + ledger `ls5lp-…` "not yet deployed"; staging ckDevnetSOL exists but the founder chose the device-key path). The device holds a Solana ed25519 key directly; the app talks to Solana RPC directly. No IC canister / relay / facade / wire change. Fully app-scoped. Solana's speed + durable nonces enable dpay's signature offline-pay feature (payer signs offline, merchant submits + confirms in ~1s).
- **SOL PoC: ✅ ON-CHAIN VERIFIED on devnet (2026-08-06, 5 SOL funded by the founder).** The full round-trip + the durable-nonce offline-sign + stale-blockhash-survival all landed at `.dev/sol-poc/` (gitignored, kept for reference). Proves: noble ed25519 seed → valid Solana keypair; online transfer A→B + round-trip B→A (sig `3oQHNW5d…`); nonce-account creation (rent 1,447,680 lamports ≈ 0.001448 SOL, matches estimate); **durable-nonce offline-sign + later-submit** — offline-signed tx (289 bytes, blockhash = stored nonce `D1n4Y4CZ…`) → waited 15s (live blockhash changed twice) → submitted the stale-blockhash tx → **CONFIRMED** (sig `4CEfsBXw…`); nonce advanced `D1n4Y4CZ…` → `CdHzbFUT…` (proves `advanceNonce` rotates the value → the one-shot-per-sync constraint is real). Construction is byte-exact vs the System Program spec (advanceNonce as ix[0] + Transfer). Durable-nonce verdict: **FEASIBLE + PROVEN** (rent ~0.00145 SOL/nonce account; one offline payment per nonce-sync).
- **SOL architecture plan:** `@solana/kit` v5.5.1 already transitive in `app/node_modules` (via @coinbase/cdp-sdk); polyfills (`react-native-get-random-values`, Buffer, `crypto.getRandomValues`) already installed by `app/index.js` — no new native dep. Key derivation = SLIP-0010 BIP32 ed25519 at `m/44'/501'/0'/0'` from the existing IC identity seed → separate Solana key (one backup recovers both rails). Structure = new `app/solana/` subtree (`identity.ts`/`rpc.ts`/`tx.ts`/`nonce.ts`) + `app/solana.ts` pure-interface with a **dynamic-import boundary** (mirrors `app/wallet.ts`→`app/walletconnect.ts` isolation — keeps `@solana/kit` out of the jest/e2e static graph). MVP "online SOL" (balance + receive address QR + send/withdraw) = **3-4 days**, unblocks "SOL in/out" fully. Full offline-pay rail (durable-nonce offline sign + merchant broadcast + receipt-nonce-relay) = **+5-7 days**. No wire/relay/canister/core change; frozen wire (292/196/132) untouched; IC rail bit-for-bit unchanged. Full plan in the "NEXT SESSION — work order" SOL section below.

**Next-session work order:** SOL MVP implementation is now THE top of the work order (user's explicit direction). See below.

## Session summary (2026-08-06, part 2): native-asset in/out — ckETH (native ETH) withdraw + deposit BUILT + proven offline

> All gates green at close: `just verify` **45/45 e2e** in 79.24s, `just test-canister` **73/73** (+7 ETH), `just test-relay` **48/48**, jest **263/263** (+4 cketh goldens), typecheck clean, bridge-parity OK 21 methods, **`just app` → `DPAY_SELFCHECK PASS`** (device gate). Wire FROZEN (292/196/132) — ZERO wire/core/FFI change; the on-device `WithdrawAuth.amount: u64` carries Wei (u64 max ≈ 18.45 ETH, the documented consumer cap); the facade widens `u64 → candid Nat` for the minter call.

**Headline: native ETH now moves in AND out.** The facade's deposit/withdraw proxies were hardcoded to the ckBTC minter; this added **family dispatch**.

- **ckETH WITHDRAW (out)** — `9fc4a9f` (canister) + `9df982e` (app/relay):
  - **Canister** (`crates/dpay-canister/src/lib.rs`): `withdraw()` refactored to branch on family — `CkBtcUtxo` → existing `retrieve_btc_with_approval` (unchanged); `CkEthErc20` + `token_contract` None → new `withdraw_eth` path. **Approve mechanism** (the key correctness point, resolved from the ckETH minter candid): `icrc2_approve(amount + max_transaction_fee)` where `max_transaction_fee` comes from the minter's `eip_1559_transaction_price(null)` query (ICRC-2 allowance is a running balance covering both the amount-burn + the separate gas-fee-burn). Settle/release nonce classification mirrors BTC (permanent errs settle = dead auth; transient errs release = retryable). **7 new PocketIC tests** (`tests/withdraw_eth.rs`) against the real `ic-icrc1-ledger` + an extended `dpay-mock-minter` proving dispatch/debit/nonce/sig/expiry/min. 66 → **73/73** GREEN (existing 66 unregressed).
  - **App** (`BalancesSheet`/`WithdrawSheet`/`Wallet`/`catalog`): `cashable` gate admits native ckETH (`CkEthErc20 && token_contract == null`); ckUSDC stays fail-closed (offramp Unavailable). New `FD_CKETH_NATIVE` FamilyDisplay (18-dec). `toSats` → `toUnits(amountStr, display.amountDecimals)` so the WithdrawSheet is decimals-agnostic.
  - **e2e flow 44** (`6e4f255`): browser-driven native-ETH cash-out end-to-end (onboard → seed 5 ETH → Cash-out → sign at 18-dec Wei → settle → balance debits). FakeLedger gained a 6th currency (id 5, native ETH) + a family-aware withdraw floor. `balances` baseline re-seeded. **45/45 GREEN.** This is the integration proof both the canister + app slices lacked.
- **ckETH native-ETH DEPOSIT (in)** — `9df982e`: client-side single-tx (send ETH to the shared helper with `depositEth` calldata; value as tx `value`, not calldata). `app/cketh.ts` `encodeDepositEth` — **selector `0x17c819c4` verified two ways**: function sig `depositEth(bytes32 principal, bytes32 subaccount) public payable` taken verbatim from DFINITY's `rs/ethereum/cketh/minter/DepositHelperWithSubaccount.sol` (`CkDeposit`), and `keccak256` cross-checked against the two known selectors (`approve`=095ea7b3, `depositErc20`=db9751af) before trusting. `CkErc20DepositSheet` branches: native ETH = one payable tx (skips approve); ERC20 = the existing 2-tx flow. Relay onramp resolver (`ledger.rs`/`app.rs`) discriminates within `CkEthErc20` by `token_contract` (None→native, `kind:"native_eth"`; Some→erc20). jest golden pins the selector + 3 depositEth encodings.
- **BTC:** both directions were already done; unchanged. SOL: still **blocked** on ckSOL existing on mainnet (family=2 declared, not wired; no live proof possible).

**Remaining (genuine outer-loop blockers — NOT autonomous):** *(superseded — see the part-3 summary above: the prod WASM redeploy + Sepolia live proof both landed; SOL moved to the native device-key path. Kept here as the part-2 historical record.)*
1. **Prod WASM redeploy** — the canister family-dispatch (`9fc4a9f`) is in SOURCE only; prod `ssqti` runs the OLD wasm (BTC-only withdraw). The fix is PocketIC-proven (73 tests) but NOT live. Redeploying prod `ssqti` (a mainnet-mutating op affecting every wallet) is a **founder decision** (`just deploy-ic` or `dfx canister install ssqti --mode upgrade`); the app side also needs a release to be user-usable, so end-to-end ship = founder outer-loop. The local-relay-against-prod path cannot prove withdraw (needs the new wasm on the facade).
2. **Sepolia live proof (both dirs)** — needs (1) first, plus funded Sepolia ETH (not freely mintable in volume; Circle faucet permissioned) + the minter heartbeat (~20min) for deposit→mint.
3. **SOL** — blocked on DFINITY shipping ckSOL on mainnet (none exists yet). Only the CkSol dispatch scaffold + FamilyDisplay config can be pre-built (no live proof).

## Session summary (2026-08-06): NEXT-SESSION work order cleared — testnet wiring proven live, all 8 do-next items shipped

> All gates green at this session's close: `just verify` clean (**44/44 e2e** in 76.25s), `just test-canister` 66/66, `just test-relay` 48/48, `just typecheck` clean, `just bridge-parity` OK (21 methods), jest 57/57 (wallet/WC/conformance slices), `just sim` GREEN (repaired), visual baselines re-seeded. All 8 do-next items from the 2026-08-05 work order shipped via two parallel subagent waves. **Testnet chain-key wiring proven LIVE on prod `ssqti`** (the headline deliverable). Wire FROZEN (292/196/132) untouched.

- **Wave 1 — 5 parallel implementers (distinct file ownership):**
  - **#3 18-dec ckERC20 coverage** (`9e0d3fc`): added ckDAI (id=4, 18-dec, CkEthErc20, DAI mainnet contract) to `FakeLedger.fake_catalog`; extended flow 43 with 3 BigInt 18-dec cases (mid/low/pad). 9/9 GREEN.
  - **#4/#5 UX audit fixes** (`72d6fab`): 9 items — Settings "Server" rename + Advanced disclosure (default-open to preserve e2e contract) + helper-above-input + apply-gate; ∂ glyph explained in onboarding; locale-format timestamps (`fmtTime`, no Intl dep); offline-status pill on Receive-QR; "dpay" wordmark/username separator (ACCOUNT eyebrow); reset-entry-point visual weight; Cancel-as-secondary-button parity in PayMode. Typecheck clean.
  - **#6 Flow 38 relay-retarget race fix** (`badf73c`): root cause — `useBalancePoll` teardown set `alive=false`+`clearInterval` but did NOT abort in-flight fetches; an old-relay poll could resolve post-retarget and shadow the new balance. Fix: AbortController tied to effect lifetime + generation counter (`genRef`); `timed()` composes abort signal with per-fetch timeout (first-abort-wins). 5/5 GREEN (~6.6s each, under 9s budget).
  - **#8 RED diagnostics** (`480317a`): in `driver.close()` when `unexpectedDiagnostics.size > 0`, snapshot screenshot+DOM via `dumpDiagnostics` (best-effort). `_closeLabel()` resolves the test file from `_testCtx` AsyncLocalStorage. Near-zero wall cost (0 GREEN flows had unexpected diagnostics; O(1) `.size` check).
  - **#1/#2 testnet scoping** (planner, read-only): 7-subtask plan. Key finding — `dpay` identity is BOTH IC-level controller AND governance controller of prod `ssqti` (confirmed: `register_currency` succeeds), so testnet registration needs NO founder op; `ssqti` holds 465 TC for any staging provision. Two hardcoded mainnet values block Sepolia (relay ckerc20 helper + WC `chains:[1]`).
- **Wave 1 integration** (`999df22`/`69f0706`): re-seeded all 5 visual baselines (drift from W1.A catalog + W1.B UI changes); fixed an integration bug — W1.D's AbortController fires `net::ERR_ABORTED` on component teardown, which the driver's `requestfailed` handler only filtered during active navigation → broadened to treat ALL `ERR_ABORTED` as programmatic cancel (never a real network failure). 44/44 GREEN.
- **Wave 2 — testnet track + MC9 sim repair (2 parallel implementers):**
  - **Testnet code (3 commits, `78f249a`/`b5f0bb2`/`a18f038`):** relay `ckerc20_onramp_from_descriptor` chain-aware (Sepolia helper `0x2D39863d…` via `desc.chain_id`); WC `initProvider(chainId)` parameterized; reusable atomic staging deploy script + local rehearsal; e2e-live Tier 1 flow + `just e2e-live-testnet`. All offline gates GREEN.
  - **#7/#9/MC9 dpay-sim repair** (`fa0bc60`): `just sim` was broken (predated the facade-ledger refactor — wrong `InitArg` shape + missing wire-v2 `Authorization` fields). Rewired to the canonical facade-ledger architecture (real `ic-icrc1-ledger`, controller-gated `mint`, `DpayInitArg{ledgers,per_tx_cap,controller}`). `just sim` GREEN; 66/66 canister tests unregressed. Decimal conformance matrix assessed COVERED (flow 43 rendering + `icrc_settle.rs` decimals-agnostic settle + jest) — no new test needed.
- **MAINNET live proof (executed 2026-08-06):** founder chose the cheaper prod-`ssqti` route over a staging facade. Registered ckBTC Testnet(3) + ckSepoliaUSDC(4) + ckSepoliaETH(5) on prod `ssqti` (all `(variant { Ok })`, metadata strictly-validated against the real testnet ledgers). Proved the facade→real-ckBTC-Testnet-minter round-trip: `deposit_info(3)`/`deposit_address(3)`/`refresh_deposit(3)` all return correct real-minter results (real Testnet4 `tb1q…` address, `min_confirmations=4`, clean NoNewUtxos). **Closes the wiring half of #1/#8.** Catalog-pollution consequence (3/4/5 visible to every wallet) accepted pre-pilot; `retire_currency` is the cleanup path.
- **Autonomous follow-up (2026-08-06, `2e0a163` → `087e69a`):** re-verified everything autonomously reachable. Relay Sepolia fix PROVEN against prod (local relay from HEAD → `ssqti`: Sepolia helper for cur 4, mainnet for cur 2, full catalog, real `tb1…`). Device gate BOTH GREEN (`just app` → `DPAY_SELFCHECK PASS`, `just ondevice` PASSED — validates the WC `chains` change on the real bridge). **e2e-live Tier 1 now GREEN against prod (`087e69a`):** local-relay→prod passes end-to-end in ~55s (onboard → 3 testnet cards → real Testnet4 address → deposit/info → Sepolia onramp). PR-list (HIGH/MEDIUM/LOW) all RESOLVED. **NEW external blocker found:** the DFINITY-operated ckBTC Testnet minter (`ml52i-…`) is cycle-starved — `update_balance` (and intermittently `get_minter_info`) reject with `InsufficientLiquidCycleBalance`; would block a Tier 2 mint too (DFINITY-side, outside our control).
- **Remaining (outer-loop / founder-ops — genuine blockers only):** (1) **prod relay image swap** (fix PROVEN locally; live image ~10 commits behind HEAD at `e0a8c3d`; `just image && just up` on the founder-held kalaj.org host — no SSH/CF-token from dev box); (2) **Tier 2 full Testnet4 mint** (faucet captcha + the cycle-starved minter — low dpay value, proves DFINITY infra); (3) **WalletConnect live pairing on Sepolia** (physical device + MetaMask-on-Sepolia + funded Sepolia USDC, which isn't freely mintable).

## ckERC20(USDC) withdraw — DONE (committed `d5983ea`, 2026-08-06)

> The canister's family dispatch now has a dual-ledger `withdraw_erc20` branch (replacing the fail-closed guard). User must hold ckETH for gas (Fork-C: no-swap). **Prod WASM upgrade required** (founder op — the new family branch must deploy to `ssqti` via `just deploy-ic`). No wire change.

**Implemented:**
- **Canister** (`lib.rs`): 3-arm `WithdrawPath::{Btc, NativeEth, Erc20}` dispatch. The Erc20 arm queries `eip_1559_transaction_price(Some(ledger_id))` (NOT None), dual `icrc2_approve` (ckETH gas ledger + ckERC20 amount ledger), calls `withdraw_erc20`, decodes `WithdrawErc20Error` with correct settle/release classification (partial `CkErc20LedgerError` → SETTLE; permanent → SETTLE; transient → RELEASE). `ckerc20_ledger_id` is a `Principal` (NOT Nat — verified against the real minter `.did`). New `gas_ledger: Option<Principal>` field on `CurrencyMetaStorable` (appended LAST for stable-encoding backward compat).
- **Mock-minter**: dual-ledger `withdraw_erc20` mirroring the real candid exactly. `eip_1559_transaction_price` honors the `Some` arg (60k gas for ckERC20 vs 21k for native ETH). `force_next_withdraw_erc20_partial` test hook.
- **App**: `cashable` gate flipped (admits ALL `CkEthErc20` regardless of `token_contract`). WithdrawSheet gas dependency note (`withdraw-gas-note`) + honest partial-failure error surfacing. `gas_ledger` threaded through relay + app catalog.
- **Tests**: canister 81/81 (73 existing + 8 new `withdraw_erc20.rs`), relay 48/48, e2e 49/49 (new flow 48), typecheck clean, bridge-parity OK (28 methods). Wire FROZEN (292/196/132) untouched. No device gate (no native-module change).

**Remaining (founder ops / external):**
1. **Prod WASM upgrade** — the new family branch must deploy to `ssqti` (`just deploy-ic` or `dfx canister install ssqti --mode upgrade`). The new `register_currency_meta` takes a 15th `gas_ledger` arg; `dfx-deploy-ic.sh` already updated.
2. **Live Sepolia proof** — after the WASM upgrade, prove a ckUSDC withdraw against real mainnet IC canisters (the PocketIC tests prove the dual-ledger flow; the live proof needs funded ckUSDC + ckETH gas).

### Verified live params (from O6, READ AT RUNTIME — never hardcode)
- ckETH minter: `sv3dd-oaaaa-aaaar-qacoq-cai`; ckETH gas ledger: `ss2fx-dyaaa-aaaar-qacoq-cai`; ckUSDC ledger: `xevnm-gaaaa-aaaar-qafnq-cai` (6 dec, fee 10_000).
- `minimum_withdrawal_amount` = 5_000_000_000_000_000 (5e15 Wei; minter-wide gas floor, shared by ckETH + ckERC20).
- 11 ckERC20 tokens live on the ckETH minter (ckUSDC, ckUSDT, ckEURC, ckWBTC, ckLINK, ckUNI, ckWSTETH, ckPEPE, ckOCT, ckSHIB, ckXAUT) — the family dispatch covers ALL of them config-only once built.

## Prior session summary (2026-08-05): radical e2e + polish (visual regression, diagnostics, watch mode, coverage, de-god-component, UX audit)

> All gates green at this session's close: `just verify` clean (**44/44 e2e**), `just typecheck` clean, jest **258/258**, `just bridge-parity` OK (21 methods), `just e2e-visual` GREEN, gradle release build `BUILD SUCCESSFUL` (AGP 8.12 + API 36), `just app`/`just ondevice` GREEN on the API-36 emulator. On `main`, **41 commits** ahead of origin/main. Wire FROZEN (292/196/132) untouched. No canister/relay/core CODE changed — all 7 phases + the Phase-B RN 0.86.2 migration shipped under the existing kernel.

- **Phase 1 — Visual regression harness** (commits `f1159e5`/`816b9fb`/`b8668f3`): pixel-diff comparator `e2e/harness/pixel.mjs` (pngjs, tolerance 0.5%, per-channel delta 3, `masks` for non-deterministic QR regions); flow `40-visual-regression` re-captures the 5 primary surfaces and diffs each vs committed baselines in `e2e/shots/baselines/`; `just e2e-visual` (standalone iteration) + `just e2e-visual-seed` (regenerate baselines). **Closes the documented "styles.ts single-block class dropped = pixel-blind to e2e net" blind spot** — flow 40 is part of the suite so `verify` already covers it.
- **Phase 2 — RED-path diagnostics** (`9290d55`/`e76241e`/`de8bc89`/`cb76128`): on RED, dumps `e2e/shots/failures/<flow>-<ts>/` — `actions.json` (timeline) + `console.log` + `error.txt` always land; `screenshot.png` + `dom.html` best-effort (a real flow's `finally{env.stop()}` closes the page first). `_testCtx` AsyncLocalStorage + `_drivers` Map + `dumpDiagnosticsFor(file,err)` in the runPool catch. Wall-time +0.27s.
- **Phase 3 — Watch mode** (`ea97dcd`/`03d299b`/`0d36bba`): `just e2e-watch` + `just e2e-watch-filter <token>`. `e2e/watch.mjs` uses Node 24 `fs.watch({recursive:true})`, 300ms debounce, a static `FILE_JOURNEY` map (component→journey; shared-infra→ALL), `keepSession:true` (sub-5s feedback vs ~23s cold). `run.mjs` refactored to export `runTestsSubset(tests,opts)` + `loadTests` + `withTimeout`; `main()` import-guarded.
- **Phase 4 — Coverage flows 41-43** (`9880ad4`/`9618201`/`f21d5ce`/`de57c7f`): flow 41 a11y census (50 interactive elements × 7 surfaces, 0 missing label/role after fix); flow 42 receipt-reject (wrong-pubkey + tampered-sig → "Couldn't verify", no debit); flow 43 decimal-edges (8-dec ckBTC + 6-dec ckUSDC exact-decimal). Surfaced + fixed 2 real a11y bugs: `amount-input` (ReceiveMode) + `settings-relay` (SettingsSheet) both lacked aria-labels.
- **Phase 5 — Tech-debt: Wallet.tsx hook extraction + fetchWithTimeout** (`371e1e4`/`d3239ba`/`2a36390`/`ba27ec3`/`210a7c6`): `app/services/relay.ts` gained `fetchWithTimeout` (single source of truth); 11 inline AbortController sites across 7 files consolidated. 3 hooks extracted from the Wallet god-component: `useCatalog`/`useBalancePoll`/`useTransactionHistory`. **Wallet.tsx: 475→319 lines (33% reduction).** jest 254→257 (+3 TDD tests).
- **Bonus — composeTimeout caller-signal-wins fix** (`d5b992f`): real latent bug — `withDefaultTimeout(signal)` armed a 10s backstop even when the caller supplied its own signal, so "first abort wins" capped every caller at 10s, silently defeating `DEPOSIT_ADDRESS_TIMEOUT_MS=20s` in DepositSheet (ckBTC `deposit_address` is an IC update call, 5-7s+ on mainnet). Fix: the backstop is a SAFETY-NET for OMITTED-signal callers only; a caller that provides a signal OWNS its deadline. TDD: new jest case RED under old code → GREEN after fix.
- **Phase 6 — UX audit** (read-only): 14 real-app screenshots driven through real FakeLedger relay, each analyzed via zai-vision. Deliverable: `2026-08-05-ux-audit.md` (315 lines, 10-item Quick Wins table with file:line). Top findings: [P0] camera-gate jargon; [P1] Settings raw Relay URL footgun; [P1] deposit fee/min bare `—`; [P1] Receive "Scan to settle" unexplained; [P1] empty Transactions dead-end.
- **Phase 6.5 — UX quick-win copy fixes** (`1106e32`/`4f67b4c`/`35d3ea3`/`0d096c6`/`7467070`/`af475fc`/`f8da5ec`/`d1cb553`): applied 6 of the audit's copy fixes (P0 + 3 P1 + 2 P2), each its own commit; updated e2e assertions (regex in 06/21 + best-effort waits in 35/40/41); re-seeded 4 drifted visual baselines.

## NEXT SESSION — work order (read this before deferring anything)

**🔴 TOP PRIORITY (founder directive, 2026-08-06): native-asset in/out — BTC / ETH / SOL.** Getting BTC, ETH, and SOL **in and out** of the wallet, as convenient as possible for the user, is the single highest-priority product direction until done. See the "CURRENT TOP PRIORITY" section at the top of `CLAUDE.md` for the full directive + per-asset status. **When sequencing, pick the work that gets real native BTC/ETH/SOL into or out of the wallet fastest.**

**Status (2026-08-06, part 3):**
- **BTC — in/out DONE + testnet-proven (Tier 1).** ckBTC Testnet (currency 3) is registered live on prod `ssqti`; the facade round-trips to the real DFINITY ckBTC Testnet minter (real Testnet4 `tb1q…` address, `min_confirmations=4`, clean NoNewUtxos). Mainnet ckBTC (currency 1) wiring is proven reachable. Full Tier 2 mint is externally blocked (captcha faucet + the cycle-starved ckBTC Testnet minter — DFINITY-side infra, low dpay-specific value). See issue #1 / #8 below for the residual real-mainnet confidence check.
- **ETH — in/out DONE + LIVE-PROVEN BOTH DIRECTIONS on Sepolia.** Proven against prod mainnet IC canisters + real Sepolia ETH (deposit tx `0x108c8680…5839`, block #11429442; 0.08 SepETH → 0.08 ckSepoliaETH minted to the dpay subaccount; 0.04 ckSepoliaETH burned at ledger `block_index = 8168` → 0.039923 real SepETH delivered, fee reconciliation ties out). Facade WASM upgraded by the founder (family-dispatch live on `ssqti`); currency 5 offramp flipped to Direct; app min-floor fixed (`7dc894a`). **Only residual: a prod relay image redeploy** (founder op — the Sepolia helper fix + app-side changes are in source; prod relay runs old commit but withdraw worked as a generic pass-through).
- **SOL — MVP DONE + OFFLINE-PAY RAIL DONE (2026-08-06): native device-key path, QR + NFC.** Online SOL in/out (balance + receive QR + send/withdraw) SHIPPED (`0fafae7`→`329b4d5`). Offline-pay durable-nonce rail FULLY BUILT (`fe2be81`→`d772ae3`): pure builders (nonce.ts/spl.ts byte-exact vs @solana/web3.js goldens), QR codec (solreq:/solpay:), RPC stub seam, seam lifecycle (signOffline/createNonce/broadcast/resync), payer nonce persist, receipt-nonce-relay outcome logic, SolPayMode + SolReceiveMode UI, NFC HCE transport (Kotlin DpaySolNfc + SolNfcTap UI + e2e flow 47). All gates green: e2e 48/48, jest 400/400, typecheck clean, bridge-parity OK (28 methods), device gate `DPAY_SELFCHECK PASS` + `DPAY_SOL_SELFCHECK PASS`. No IC canister / relay / facade / wire change. Remaining outer-loop: mainnet RPC config (operator), physical two-phone NFC radio proof. Two v2 follow-ups (non-blocking): source-ATA auto-create for USDC, stronger getTransaction receipt verify.

**The active engineering work: ALL native-asset out-paths are DONE.** BTC + ETH (native) + SOL + ckERC20(USDC) withdraw are all built + tested. ckERC20(USDC) withdraw committed `d5983ea` (dual-ledger `withdraw_erc20` + app gate flip + e2e flow 48). Remaining founder ops: prod WASM upgrade (the new `withdraw_erc20` family branch must deploy to `ssqti`); live Sepolia proof for ckUSDC. SOL MVP + offline-pay rail = DONE. Prod relay image redeployed (2026-08-06).

**Several items below were previously mislabeled "founder outer-loop" and safe-punted. That was wrong.** They are NOT blocked — they should be done in the next session(s). Only the items in the explicit **POSTPONE** list are genuinely blocked on founder action or external steps; treat everything else as in-scope autonomous work. Founder directive (2026-08-05): *only the genuinely-blocked tasks get postponed.* (Items 1–8 below are all ✅ shipped as of 2026-08-06; they remain as the completion record. The TOP PRIORITY block above supersedes them as the active work order.)

### DO NEXT (unblocked — high value first)

#### 0. 🔴 SOL native device-key implementation (THE TOP of the work order — user's explicit next direction)

**Decision (2026-08-06): the device holds a Solana ed25519 key directly; the app talks to Solana RPC directly. NO IC canister, NO relay, NO facade, NO wire change.** Fully app-scoped. Production ckSOL canisters are not deployed (IC0537 "no wasm module"; dfinity/cksol README labels minter `lh22c-…` + ledger `ls5lp-…` "not yet deployed"); staging ckDevnetSOL exists but the founder chose the device-key path because Solana's speed + durable nonces enable dpay's signature offline-pay feature (payer signs offline, merchant submits + confirms in ~1s). Frozen wire (292/196/132) untouched; IC rail bit-for-bit unchanged.

**Step 0 (✅ DONE 2026-08-06 — PoC ON-CHAIN VERIFIED):** the founder funded `GhcChfSJAtmamScaRnQ9nwAJgbW65bJtWdHkxDYbCr8T` with 5 SOL (Devnet); `cd .dev/sol-poc && node run-all.mjs` ran the full round-trip + durable-nonce broadcast GREEN. Evidence: online round-trip (sig `3oQHNW5d…`); nonce account created (rent 1,447,680 lamports); durable-nonce offline-sign + stale-blockhash-survival — offline-signed 289-byte tx, 15s wait (live blockhash changed twice), submitted stale-blockhash tx → CONFIRMED (sig `4CEfsBXw…`); nonce advanced `D1n4Y4CZ…` → `CdHzbFUT…` (the one-shot-per-sync constraint is real). Files: `01-keygen.mjs`…`05-durable-nonce.mjs` + `verify-construction.mjs` + `README.md`. Durable-nonce verdict: FEASIBLE + PROVEN (rent ~0.00145 SOL/nonce account; one offline payment per nonce-sync — `advance` rotates the value). **Next: the MVP implementation below.**

**MVP (online SOL in/out — 3-4 days):** unblocks "SOL in/out" fully.
- `app/solana/` subtree: `identity.ts` (SLIP-0010 BIP32 ed25519 at `m/44'/501'/0'/0'` from the existing IC identity seed → separate Solana key; one backup recovers both rails), `rpc.ts` (RPC client with bounded timeouts), `tx.ts` (tx builder).
- `app/solana.ts` pure-interface with a **dynamic-import boundary** (mirrors `app/wallet.ts`→`app/walletconnect.ts` isolation — keeps `@solana/kit` out of the jest/e2e static graph so `just verify` never executes `@solana/kit` code). Relative imports only (no `@/` aliases).
- `useSolanaBalance` hook; BalancesSheet SOL card; SolanaReceiveSheet (address QR); SolanaWithdrawSheet (direct send/withdraw).
- Deps: `@solana/kit` v5.5.1 is **already in `app/node_modules`** (transitive via @coinbase/cdp-sdk); promote it to an explicit dep + promote `@solana-program/system`. Polyfills (`react-native-get-random-values`, Buffer, `crypto.getRandomValues`) are already installed by `app/index.js` — no new native dep.
- Device gate: add a SOL self-check to `just app` (the app-scoped path is a structural blind-spot class — see AGENTS.md "Pre-merge gates off the hot verify path": `app/services/**` / `app/index.js` / new-Web-API trigger paths; the RN/Hermes bundling of `@solana/kit` is the unverified step).

**Full offline-pay rail (+5-7 days):** the differentiating dpay feature for SOL.
- Durable-nonce lifecycle: `app/solana/nonce.ts` (create / advance / resync).
- QR formats: `solreq:` (merchant request) / `solpay:` (payer's offline-signed authorization).
- Offline sign in PayMode (payer signs against the stored nonce, no network); merchant broadcast in ReceiveMode; receipt-nonce-relay (merchant hands the advanced nonce back so the payer can make the next offline payment without resync).
- Mock Solana RPC for the e2e suite (the WC-precedent dynamic-import boundary keeps `@solana/kit` out of the headless graph).

**Architecture constraints (hard):** app-scoped only (no relay/facade/wire/core change); SLIP-10 `m/44'/501'/0'/0'`; dynamic-import isolation; **one offline payment per nonce-sync** (Solana's `advance` rotates the nonce value; payer must resync or rely on merchant receipt-relay for the next — a nonce-account pool or merchant-receipt-nonce-relay mitigates for sequential offline payments).

**Open questions for the founder (decide before/during Step 0):**
1. SLIP-10 derivation path: Phantom-compatible (`m/44'/501'/0'/0'`, recoverable in Phantom) vs dpay-private (non-standard path — harder to recover elsewhere, marginally more security-through-obscurity)?
2. RPC provider: Helius free tier — bake the API key in `config/constants.ts` like the WC `projectId`, or prompt-on-first-use? (Free tier is generous for a wallet MVP.)
3. Sequencing: MVP-first (online in/out) then offline-pay rail — confirmed?
4. One-nonce-per-sync acceptable for the MVP, with merchant receipt-nonce-relay + a nonce-account pool as the later mitigation for sequential offline payments?
5. `@solana/kit` vs a hand-rolled minimal Solana client, if `just app` fails to bundle the SDK on RN/Hermes (the PoC uses the SDK in Node; RN/Metro/Hermes bundling is the unverified step — fallback is a minimal hand-rolled signer if Metro chokes)?
6. SPL tokens / USDC-on-Solana — out of scope for the MVP (native SOL only)?
7. Offline-pay MVP delivery: QR-only (NFC tap = follow-on)?

#### 0a. ✅ ETH native ckETH — DONE + LIVE-PROVEN both directions (Sepolia)

Proven against prod mainnet IC canisters + real Sepolia ETH. **IN:** 0.08 SepETH → helper `0x2D39863d…` with `depositEth` calldata (tx `0x108c86807e353456786ab00286ad74915eb3cfdac9d30c6804f6769d6f535839`, block #11429442) → minted 0.08 ckSepoliaETH (80_000_000_000_000_000 raw 18-dec) to the dpay subaccount on prod `ssqti` (minter `jzenf-…` scraped block 11_429_549). **OUT:** 0.04 ckSepoliaETH burned (ledger `block_index = 8168`) → 0.039923 real SepETH (39_922_980_593_032_000 Wei) delivered to `0x78a5ccF3…` (fee reconciliation: burned 40e15 + 1e7 ledger fee, delivered 39.923e15). Facade WASM upgraded by the founder (family-dispatch live on `ssqti`); currency 5 offramp flipped to Direct; app min-floor fixed (`7dc894a`). Delivered across `9fc4a9f` (canister) + `9df982e` (app/relay) + `6e4f255` (e2e flow 44). **Only residual: prod relay image redeploy** (founder op — the Sepolia helper fix + app-side changes are in source; prod relay runs old commit but withdraw worked as a generic pass-through).

#### 0b. ✅ BTC — DONE both directions; Tier 2 testnet full mint externally blocked

ckBTC Testnet (currency 3) registered live on prod `ssqti`; facade round-trips to the real DFINITY ckBTC Testnet minter (real Testnet4 address, `min_confirmations=4`, clean NoNewUtxos). Full Tier 2 mint externally blocked (captcha faucet + the cycle-starved ckBTC Testnet minter `ml52i-…` — DFINITY-side `InsufficientLiquidCycleBalance`; low dpay-specific value). Detail + the live-wiring proof record in item 1 below; issues #1 / #8 below for the residual real-mainnet confidence check.

---

1. **Testnet ckBTC + ckSepoliaUSDC live-path wiring → closes issues #1 / #8 for FREE.** IC ships **free** testnet chain-key tokens on mainnet: ckBTC Testnet (Bitcoin Testnet4) Ledger `mc6ru-gyaaa-aaaar-qaaaq-cai` / Minter `ml52i-qqaaa-aaaar-qaaba-cai` / Index `mm444-5iaaa-aaaar-qaabq-cai`; ckETH Sepolia Ledger `apia6-jaaaa-aaaar-qabma-cai` / Minter `jzenf-aiaaa-aaaar-qaa7q-cai`; ckSepoliaUSDC Ledger `yfumr-cyaaa-aaaar-qaela-cai` (contract `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`). The facade code path is **identical** (same minter candid, same 1-tuple `Call::with_args` invariant) — only the registered minter+ledger principals differ. Work: (a) a deploy-script block to `register_currency` the testnet currencies in a founder-controlled facade; (b) an `e2e-live` flow exercising `deposit_address` → free testnet deposit → mint → spend → withdraw. Autonomous up to the one-time founder `register_currency` op (or a throwaway staging facade). This converts the two biggest "carryovers" into closed items.

   **Status (2026-08-06): ✅ WIRING PROVEN LIVE on prod `ssqti` (testnet currencies registered + facade→real testnet minter round-trips verified).** Founder chose the cheaper path (register on prod `ssqti` directly, 0 TC, no staging canister) over the staging-facade route. All code committed; the testnet currencies are now LIVE on the prod facade:
   - **Relay + WC fix (commit `78f249a`):** `ckerc20_onramp_from_descriptor` is now chain-aware (Sepolia `chain_id=11155111` → Sepolia CkDeposit helper `0x2D39863d…`; else mainnet). WalletConnect `initProvider(chainId)` threads the requested currency's chain through the WC session (`chains:[chainId]`), so a Sepolia ckERC20 pairs against Sepolia from the start. 48/48 relay + 57/57 jest + `just verify` 44/44 GREEN. **Relay fix PROVEN against the real prod facade (2026-08-06 follow-up):** a local relay built from HEAD, pointed at prod `ssqti` (`DPAY_LEDGER=ic DPAY_CANISTER_ID=ssqti … cargo run -p dpay-relay --features agent`), returns the **Sepolia** helper `0x2D39863d…` for `GET /onramp/ckerc20?currency=4` and the **mainnet** helper `0x1890…` for `currency=2` (regression), plus the full 6-currency catalog + `deposit/info?currency=3` → `min_confirmations=4` + a real Testnet4 `tb1…` address. So the fix is verified end-to-end; only the **prod relay IMAGE swap** remains a founder op (`just image && just up` on the kalaj.org host — the live image is at commit `e0a8c3d`, ~10 behind HEAD; `just verify-relay` reports BEHIND). The WC change is also device-gate-validated: `just app` → `DPAY_SELFCHECK PASS` + `just ondevice` → instrumented tests PASSED on the API-36 emulator.
   - **Staging deploy script (commit `b5f0bb2`):** `scripts/dfx-deploy-ic-staging.sh` + `just deploy-ic-staging` — retained as the reusable atomic asset-deploy tool (local rehearsal GREEN). NOT used for the chosen prod-ssqti route, but is the path for any future isolated staging facade.
   - **e2e-live Tier 1 flow (commits `a18f038` → `087e69a`):** `e2e-live/tests/01-testnet-wiring.mjs` + `just e2e-live-testnet` — drives a relay end-to-end (onboard, 3 testnet asset cards, real Testnet4 deposit address, relay deposit/info + deposit/refresh + onramp/ckerc20). OUTSIDE `just verify` (opt-in, needs a relay pointed at the facade). **✅ GREEN against prod `ssqti` (2026-08-06 follow-up, `087e69a`):** a local relay from HEAD pointed at prod passes the flow in ~55s (onboard on prod DUSD → 3 testnet cards → real `tb1…` Testnet4 address → `deposit/info` min_confirmations=4 → `onramp/ckerc20` Sepolia helper). Three flow fixes landed: (1) deposit-address regex `bc1`→`tb1` (Testnet4 HRP is `tb`); (2) the deposit-address step moved from a UI drive to a direct relay call — the prod catalog now holds BOTH mainnet ckBTC (cur 1) and ckBTC Testnet (cur 3), and `assetTestKey` returns `'ckbtc'` for the whole `CkBtcUtxo` family, so two indistinguishable `asset-add-ckbtc` buttons render (catalog-pollution consequence; resolves when testnet currencies retire); (3) a `fetchRelay` retry wrapper + SOFT handling of the ckBTC Testnet minter's `InsufficientLiquidCycleBalance` (see below).
   - **LIVE PROOF on prod `ssqti` (executed 2026-08-06):** `register_currency` succeeded for ckBTC Testnet(3) + ckSepoliaUSDC(4) + ckSepoliaETH(5) (all `(variant { Ok })` — `dpay` identity confirmed as the governance controller, metadata strictly-validated against the real testnet ledgers). Facade→real-ckBTC-Testnet-minter round-trips PROVEN via direct dfx calls: `deposit_info(3)` → `min_confirmations=4, deposit_min_amount=300, deposit_fee=100` (matches live minter exactly); `deposit_address(pubkey, 3)` → real Testnet4 `tb1q…` address (not the FakeLedger `bc1qdpay` stub); `refresh_deposit(pubkey, 3)` → clean `minted_total=0, pending=vec{}, required_confirmations=4` (reaches the real chain-key minter, gets a clean NoNewUtxos). **This closes the wiring half of #1/#8.**
   - **Catalog pollution (founder-accepted):** currencies 3/4/5 are now in the PROD `ssqti` catalog, so every wallet sees ckTESTBTC/ckSepoliaUSDC/ckSepoliaETH asset cards. Acceptable pre-pilot. **Cleanup before pilot:** `retire_currency(3/4/5)` (controller-gated, irreversible) removes them from the active catalog; or relocate to a staging facade via `scripts/dfx-deploy-ic-staging.sh`.
   - **NEXT (outer-loop / founder-ops — each re-verified as a GENUINE blocker, 2026-08-06):** (a) **Prod relay image swap** — `just image && just up` on the kalaj.org host (founder-held infra: no SSH/CF-token access from the dev box). The fix is already PROVEN locally (above), so this is a push, not a verification task. (b) **Tier 2 full mint** — needs Testnet4 BTC; all live faucets are captcha-gated (coinfaucet.eu = hCaptcha+reCAPTCHA; Blockstream's testnet4 faucet is gone; bitaps is testnet3, wrong chain). **NEW external blocker (2026-08-06): the DFINITY-operated ckBTC Testnet minter (`ml52i-qqaaa-aaaar-qaaba-cai`) is cycle-starved** — `update_balance` (the mint step) rejects with `InsufficientLiquidCycleBalance { available: ~17–35B, required: ~42B }`, and `get_minter_info` intermittently too. This is DFINITY-side infra (not dpay; we cannot top up an external canister — the dpay identity has no ICP and the facade forwards no cycles to minters), and it would block a Tier 2 mint even with faucet-funded BTC until DFINITY tops the minter up. **LOW dpay-specific value regardless:** it proves DFINITY's ckBTC minter (already production on mainnet ckBTC), NOT dpay wiring (already proven: `deposit_address` returns a real `tb1…`, `deposit_info` matches the live minter, the e2e-live Tier 1 flow is GREEN). Left as a human-in-the-loop option, not an autonomous gate. (c) **WalletConnect live pairing** — needs a physical device + MetaMask-on-Sepolia; the ckSepoliaUSDC token (`0x1c7D…`) is Circle's `FiatTokenProxy` (NOT freely mintable — standard USDC minter-role model), so a live deposit needs funded Sepolia USDC (Circle's `faucet.circle.com` is permissionless) + Sepolia ETH for gas. The onramp calldata is already byte-exact-proven offline (flow 16 + 13 jest cases).
2. ✅ **WalletConnect live pairing via Sepolia** (rides on #1). **Status (2026-08-06): WC `chains` parameterized per-currency (`78f249a`); the live pairing (MetaMask-on-Sepolia) remains an outer-loop device gate** (Tier 2/WC-live in the NEXT block above).
3. ✅ **18-dec ckERC20 coverage** (flow 43 gap). **DONE (`9e0d3fc`):** ckDAI (id=4, 18-dec) added to `FakeLedger.fake_catalog`; flow 43 extended with 3 BigInt 18-dec cases. 9/9 GREEN.
4. ✅ **Settings "Server" rename + Advanced disclosure** (audit P1). **DONE (`72d6fab`):** "Relay URL"→"Server", collapsed behind Advanced disclosure (default-open to preserve the e2e contract), helper above input, apply-gate visual.
5. ✅ **Remaining UX audit P1/P2** (5 items). **DONE (`72d6fab`):** ∂ glyph in onboarding; locale-format timestamps; offline pill on Receive-QR; reset-entry-point visual weight; Cancel-as-secondary-button parity in PayMode.
6. ✅ **Flow 38 relay-retarget race fix.** **DONE (`badf73c`):** root cause = in-flight fetches not aborted on teardown; fix = AbortController + generation counter. 5/5 GREEN.
7. ✅ **MC9 autonomous pieces:** `dpay-sim` REPAIRED (`fa0bc60`, `just sim` GREEN — rewired to the facade-ledger refactor); 2/6/8/18-decimal conformance matrix ASSESSED (covered — flow 43 rendering + `icrc_settle.rs` decimals-agnostic settle + jest); atomic asset-deploy script = the testnet track's `scripts/dfx-deploy-ic-staging.sh`; per-asset readiness/metrics (SKIP — founder-facing/loosely scoped).
8. ✅ **Real-flow RED diagnostics enhancement.** **DONE (`480317a`):** `driver.close()` snapshots screenshot+DOM when `unexpectedDiagnostics.size > 0`. Near-zero wall cost (measured: O(1) `.size` check, 0 GREEN flows had unexpected diagnostics).

### POSTPONE (genuinely blocked — do NOT autonomously attempt)

- **Issue #3 — governance hand-off.** Founder-at-launch. **DO NOT NAG** (see item 3 below).
- **Issue #4 — `ADMIN_CALLERS` rotation.** Needs the founder to designate the governed principal; can't pick it autonomously.
- **Real MAINNET ckBTC deposit/withdraw** (as opposed to testnet). Superseded by #1 above as the primary proof path; only a final pre-pilot mainnet confidence check, low-cost, not blocking, and only after the testnet wiring proves out.



> All gates green at this session's close: `just verify` clean (39/39 e2e), `just typecheck` clean, jest 248/248. On `main`, 17 commits ahead of origin/main. Wire FROZEN (292/196/132) untouched.

- **e2e RED→GREEN (load-aware harness).** The suite was uniformly RED on this shared 16-core host (load avg 35-53 from a co-running emulator) because per-test `timeoutMs` (15-20s) fired on merely-slow, not hung, hardware at the fixed concurrency=12. `e2e/run.mjs` is now **load-aware**: `hostLoadFactor()` probes free cores; `autoConcurrency()` clamps [2,12]; `timeoutScale = max(1, factor)` scales every per-test timeout so a slow flow never false-fails while a genuine hang still trips a generous backstop. The `withTimeout` message no longer hardcodes the stale "suite is ~17s". The 22s perf target is load-adjusted so the warning flags real regressions, not a busy host. `6cda3a1`. On an idle host it returns to ~12-concurrency/~22s automatically; this host measured 39/39 GREEN in ~108s at auto-concurrency 2. Plus `6cee351`: fresh-context nav `networkidle0`→`domcontentloaded` (onboarding starts no continuous polls; `waitReady` is the real gate) — per-flow saving ×39 flows.
- **Tech-debt Phase 5 (PR28–PR33) ✅ ALL RESOLVED.** `0066c50` (PR28 relayConfig), `60a5bc6` (PR33 useHotkeys ref-mirror), `5946fbc` (PR32 fmtTime GMT offset), `4c9e9b2` (PR29 any→unknown + PR31 accessibilityHints). See the resolved tech-debt section below for per-item detail.
- **Coverage Phase 3 (gaps #1–#9) ✅ ALL RESOLVED.** 7 already closed by existing flows (verified w/ file:line evidence); 2 new flows close the rest: `aa1142c` — flow `28-ckusdc-request` (gap #2 + #9) + flow `38-relay-retarget` (gap #5, gold-standard 2-relay proof). 39/39 green. Gaps #3 (NFC radio hop) + #10 (WC pairing QR) stay device/outer-loop gates.
- **Canister topology documented + ONE mainnet deploy path.** `6ca8dfb` — `canister_ids.json` now tracked (was gitignored + stale), `docs/CANISTERS.md` is the authoritative topology (2 owned: facade `ssqti` + DUSD ICRC-3 ledger `td2nx`; 4 external chain-key deps). `2e3303f` — collapsed two overlapping mainnet scripts into one: `just deploy-ic` now deploys the facade AND registers ledger + full currency metadata (DEMO/ckBTC/ckUSDC) in one idempotent path; fixed a `canister_ids.json` clobber bug; deleted `dfx-deploy-icrc-mainnet.sh` + its `just` recipe.
- **Founder-driven deploy fix (why ckBTC/ckUSDC showed "Unsupported").** Root cause was a missing mainnet *deploy* step, NOT a code gap: the live facade had ledger+minter for ckBTC/ckUSDC but **no display metadata, no ramp caps, no per-tx cap** (only DEMO got `register_currency_meta`). `pay` reads `currency_cap(currency).unwrap_or(0)` → cap-less assets reject every merchant-pay. Fix shipped in `2e3303f` (deploy script) + `158138e` (the now-deleted standalone script's metadata). **Action for founder:** run `just deploy-ic` on mainnet to register the metadata (one-time, idempotent).

## Session hand-off (2026-08-02): pedantic fresh-context review requested

MC1–MC8 are functionally complete (MC9 is the founder's active parallel work). Before any further
feature work, **read `2026-08-02-progress-and-review-request.md`** — it is a hand-off brief with the
full commit-level progress, the verified gate state, and an explicit request to pedantically review
the code + invariants from every completed stage (security-critical: MC4 receipt trust, MC2 currency
identity, MC1 exact amounts, MC8 WalletConnect isolation) with a fresh context. Do not trust the
progress doc's claims — verify against the code.

## Pedantic review findings (2026-08-02)

Six fresh-context subagents reviewed MC1–MC8 + bridge-parity (L1–L5). **VERDICT: no CRITICAL/HIGH
money-safety gaps — every claimed invariant holds, verified against code with file:line evidence.**
Gates green at review time: test-core 45/45, test-canister 65/65, test-relay 46/46, test-live 48/48,
jest, e2e 35/35, typecheck clean, bridge-parity OK (21 methods). The items below are the material
(MEDIUM) + batchable LOW findings worth fixing. Each is filed with its fix + confidence; status
updates land in-line as fixes commit.

> **Status (2026-08-02): ✅ PR1–PR15 + PR18 RESOLVED** (committed + `just verify` green: test-core 45/45,
> test-canister 66/66, test-relay 46/46, test-live 48/48, jest, e2e 35/35, typecheck, bridge-parity OK 21).
> Commits: `0028c84` (PR1), `6976905` (PR4/PR5-relay/PR9), `db3d0ce` (PR11/PR5-canister/PR14/PR15),
> `35c9bd2` (PR2), `e56dce8` (PR6/PR8/PR10/PR18), `0017c42` (PR3/U6.5/PR12/PR13). PR16/PR17 optional (no
> action); PR19 accepted (no action). PR7 (AGENTS.md doc) lands via the docs pass below.

### MEDIUM (fix, TDD RED-first) — ✅ ALL RESOLVED
- **PR1 (security) | NFC merchant path missing receipt↔request nonce match.** `app/components/NfcTap.tsx:147-181` `submitWire`. The comment at :174-181 claims the nonce match is "enforced via `settledNonceHex` above" but `settledNonceHex` is only ASSIGNED (:153/:160/:166), never COMPARED against `reqInfo.nonce`. A malicious relay returns ANY past valid canister-signed receipt (different nonce) → merchant passes key-pin ✓ + sig ✓ → `finalize('success')` → goods fraud. Payer side IS protected (`decidePayerReceipt` at `app/payments.ts:77`). Fix: pure `isReceiptForRequest(receipt, expectedNonceHex)` in payments.ts + call in submitWire before `verifyOutcomeReceipt`. Conf 9/7.
- **PR2 (defense-in-depth) | Kotlin `rawU64` range-permissive.** `app/android/app/src/main/java/com/dpay/DpayCoreModule.kt:49-56` + `DpayNfcModule.kt:89-93`. `BigInteger(trim).toLong().toULong()` doesn't reject negative strings (→ near u64::MAX) or overflow (→ 0). Current callers pre-parse, so no live exploit, but only device-gate-tested. Fix: reject negative + `[0, 2^64)` range guard. Conf 9/8.
- **PR3 (liveness) | WC `provider.connect()` no timeout/cancel.** `app/walletconnect.ts:119` + `app/components/CkErc20DepositSheet.tsx:133`. No dpay-side bound; sheet-close not wired to abort. Bounded by SDK pairing-topic TTL (~5min); pairs with U6.5 (no disconnect helper / `cachedProvider` :52 never cleared). Fix: `Promise.race` timeout + cancel-on-close + `provider.disconnect()`. Conf 8/7.
- **PR4 (liveness) | No I/O timeout on relay→canister calls.** `crates/dpay-relay/src/agent_ledger.rs:235-238,250-302,528-541`; axum `/balance` handler `app.rs:280-305`. A stalled replica wedges the balance poll ~5min instead of failing fast to `LedgerError::Transient` (503). Fix: `tokio::time::timeout` (5-10s budget) → Transient. Conf 9/7.
- **PR5 (test pinning) | MC3 TTL-decision + NoNewUtxos cache refresh not test-pinned.** `crates/dpay-relay/tests/live.rs:442-584` (can't distinguish refresh-vs-cache; faucet pre-warms) + `crates/dpay-canister-tests/tests/deposit.rs:415-452` (NoNewUtxos hit twice, `dpay_balance` never asserted). A regression making `is_stale()` always-false would pass. Fix: stale-without-refresh test + `dpay_balance` assertion after NoNewUtxos. Conf 9/8.

### LOW (batch, ≥6/10) — ✅ ALL RESOLVED (PR16/PR17 optional, PR19 accepted)
- **PR6 | `dashboard.html` (97651B, repo root) = SLOP** — unrelated "Productivity" SPA, terracotta theme, referenced nowhere. DELETE. Conf 9/10.
- **PR7 | `AGENTS.md:23` modular-tree omits 4 wired root modules** (`app/payments.ts`, `wallet.ts`, `cketh.ts`, `walletconnect.ts` — all wired; WC via dynamic import = intentional isolation). Doc update. Conf 9/10.
- **PR8 | `app/services/relay.ts:13-47` no default timeout** on 5 fetch calls (callers disciplined but defense-in-depth gap). Add default `AbortSignal.timeout()`. Conf 8/9.
- **PR9 | `crates/dpay-relay/src/app.rs:770-772` `/pay` Transient fallback drops receipt-lookup error context** (`Err(_) => ...format!("ledger unavailable: {msg}")` discards secondary error). Include it. Conf 9/10.
- **PR10 | `app/services/receipt.ts:38` `EXPECTED_RECEIPT_PUBKEY` pin compare case-sensitive** (relay emits lowercase; mixed-case prod pin silently fails EVERY receipt — fail-closed but operationally fragile). Make case-insensitive (precedent `payments.ts:77`). Conf 8/9.
- **PR11 | `crates/dpay-canister/src/lib.rs:2418` `reconcile` ignores `GetTransactionsResponse.first_index`**, hardcodes `block_index = start + i`. Correct today (no archiving) but drift if paging added. Use `first_index + i`. Conf 9/9.
- **PR12 | `app/package.json` `@walletconnect/modal-react-native@1.1.0` unused dep** (capstone uses react-native-qrcode-svg). Uninstall. Conf 9/9.
- **PR13 | `app/walletconnect.ts:66` hardcoded `redirect: {native: 'org.kalaj.dpay://'}`** (namespace `com.dpay` ≠ applicationId; silent break if it changes). Derive/cross-reference. Conf 7/9.
- **PR14 (doc) | MC2 `register_currency_meta` (`lib.rs:2060-2100`) doesn't re-check RETIRED** (cosmetic — money paths reject retired first). Add docstring/retire-check. Conf 10/10.
- **PR15 (doc) | MC3 `refresh_deposit` docstring "Modeled EXACTLY on `mint`" (`lib.rs:2479`, `dfx/dpay_canister.did:221`) inaccurate** — mint hard-fails (`?`) while refresh_deposit is best-effort (`if let Ok`). Soften doc. Conf 9/9.
- **PR16 (optional) | MC3 TOCTOU/thundering-herd on `last_refresh`** (`agent_ledger.rs` `is_stale` read + `spawn_background_refresh`'s deferred `last_refresh` write are not under one lock across the await) — concurrent/overlapping background refresh waste, not correctness (`refresh_balance` is idempotent). Slightly more likely under the query-first/background-refresh design (the stale check returns instantly and only marks fresh after the UPDATE completes), but still bounded by the poll interval (a successful refresh lands within 2-5s, before the next 10s poll). Optional per-key in-flight guard. Conf 8/10.
- **PR17 (optional) | MC1 `e2e/tests/00-cross-val.mjs:286-313` replicates the TS parser inline** (Node can't import .ts; real guard is jest `amount.test.ts`). Drift surface. Conf 9/9.
- **PR18 (doc) | MC1 three protocol-u64-as-number JSON fields** (`ledger.rs:126` `Receipt.settle_ts`, `:146` timestamp, `:177` confirmations, `:218` expiry — all bounded non-money). Make `settle_ts` U64String or document. Conf 10/9.
- **PR19 (accepted) | MC2 mainnet DEMO meta registration (the idempotent `register_currency_meta` for currency 0, now in `scripts/dfx-deploy-ic.sh`) bypasses U4 strict validation for seeded DEMO id** — documented + accepted under U2 idempotency. No action.

## Structure scan + UX findings (2026-08-02)

Exhaustive app structure scan (`app/**` + `e2e/`) + screenshot UX analysis of 50 real-app captures.

> **Status:** PR20–PR22 RESOLVED (`6fa523b`); PR23–PR27 + PR30 RESOLVED (DRY pass — named timeouts/QR_SIZE, `payAndClassify`/`readJsonOrEmpty`, hooks→lib, documented catches); PR28–PR29 + PR31–PR33 ✅ RESOLVED (tech-debt phase, 2026-08-03: `0066c50`/`60a5bc6`/`5946fbc`/`4c9e9b2`); PR34–PR35 ✅ RESOLVED (founder decision: tighten expiry to 300s; suppress NFC banner on web).

### Resolved
- **PR20 (security) | `Math.random` for payment nonce.** `app/lib/format.ts:26` `randNonceHex()` used `Math.random()` (xorshift128+ on some engines) for the 128-bit payment idempotency key. Fix: `globalThis.crypto.getRandomValues` (polyfilled by `react-native-get-random-values`). Conf 9/9. `6fa523b`.
- **PR21 (slop) | `app/README.md` = unmodified RN CLI boilerplate** (iOS instructions, `npm run android` walkthrough). Replaced with dpay-specific module map + dev-loop guide. Conf 10/10. `6fa523b`.
- **PR22 (doc) | `Wallet.tsx:56` stale comment** said "adds $50" but `TOP_UP_CENTS=10000` ($100). Fixed. Conf 10/10. `6fa523b`.
- **PR23 (medium, DRY) | Magic timeout literals.** RESOLVED — every bare `4000`/`6000`/`8000`/`3000` timeout literal now named in `config/constants.ts` (`BALANCE_TIMEOUT_MS`, `FAUCET_TIMEOUT_MS`, `DEPOSIT_TIMEOUT_MS`, `DEPOSIT_REFRESH_TIMEOUT_MS`, `RECONCILE_FETCH_TIMEOUT_MS`); values unchanged.
- **PR24 (medium, DRY) | QR size hardcoded.** RESOLVED — `QR_SIZE=244` + `QR_SIZE_SMALL=200` in `config/constants.ts`; all 4 sites (PayMode/ReceiveMode/CkErc20DepositSheet/DepositSheet) use the named consts.
- **PR25 (medium, DRY) | Duplicated fetch-classify pattern.** RESOLVED — shared `payAndClassify(relayUrl, code, signal?)` in `services/relay.ts` returns `{outcome, body}`; PayMode.approve + ReceiveMode.onSignedQr + NfcTap.postPay all use it; the callers still do their own `isNonceReused` / `verifyOutcomeReceipt` / reconciliation.
- **PR26 (medium, DRY) | Duplicated JSON-or-empty.** RESOLVED — `readJsonOrEmpty(r)` in `services/relay.ts`; used by `payAndClassify`, `withdrawFunds`, and every prior inline site (PayMode receipt reconcile, NfcTap reconcile, CkErc20DepositSheet snapshot+watch, Wallet faucet). ReceiveMode's receipt poll intentionally keeps raw `r.json()` (a parse failure aborts the iteration rather than falsely firing `onReceived` on `{}`).
- **PR27 (low, naming) | Misnamed hooks.** RESOLVED — `app/hooks/useDeepLink.ts` → `app/lib/deepLink.ts`, `app/hooks/clipboard.ts` → `app/lib/clipboard.ts`; exports unchanged; the only true hook (`useHotkeys`/`useEscapeToClose`) remains in `hooks/`. Importers updated (Wallet, DepositSheet, WithdrawSheet).
- **PR30 (low) | 3 undocumented silent catches.** RESOLVED — `PayMode.tsx` receipt-reconcile catch + `ReceiveMode.tsx` NFC-buildRequest + receipt-poll catches now carry `/* best-effort: ... */` comments matching their siblings.

### ✅ Tech debt (Phase 5) — RESOLVED (2026-08-03)
- **PR28 (low, config) | `app/relayConfig.ts` committed AND regenerated** by build scripts. ✅ RESOLVED (`0066c50`). `relayConfig.ts` is now the hand-edited source; `build-apk.sh` DERIVES the release URL + ASSERTS the committed value matches (release-safety preserved); `rn-run.sh` no longer overwrites (prints Tailscale hint → in-app Settings).
- **PR29 (low, type) | ~20 `any` casts in production code.** ✅ RESOLVED (`4c9e9b2`). 18 sites narrowed (`catch(e:unknown)` w/ narrowing; `{}` as any→`Record<string,unknown>`; `verifyOutcomeReceipt(receipt:unknown)`). 2 sites SKIPPED (<6/10: NfcTap JSON-blob + RN `DpayNfc as any` bridge glue).
- **PR31 (low, a11y) | `accessibilityHint` used once.** ✅ RESOLVED (`4c9e9b2`). 13 `accessibilityHint` props on primary non-obvious controls (no testID/label/role changes — e2e anchors intact).
- **PR32 (low) | `fmtTime` ignores timezone.** ✅ RESOLVED (`5946fbc`). `fmtTime` appends GMT offset (`14:30 GMT+2` / `GMT-5:30` / `GMT`); no Intl, no new deps. No e2e matcher asserts bare HH:MM.
- **PR33 (low) | `useHotkeys` re-subscribes on every render.** ✅ RESOLVED (`60a5bc6`). Ref-mirror pattern (NfcTap precedent): handlers/opts refs updated every render, keydown effect `[]` deps subscribes once.
### Needs founder input (FORK) — ✅ ALL RESOLVED

- **PR34 (high, policy) | `EXPIRY_WINDOW` mismatch.** ✅ RESOLVED (founder: middle ~300s). `EXPIRY_WINDOW` tightened 600→300 (5 min); `CLAUDE.md:78` updated "~2 min"→"~5 min"; `e2e/tests/06-request-qr.mjs` SLACK 700→400. Halves the replay window while preserving comfortable NFC/relay headroom.
- **PR35 (medium, UX) | "NFC not available" prominent on web.** ✅ RESOLVED (founder: suppress on web). `app/components/PayMode.tsx` now gates the NFC status row behind `Platform.OS !== 'web'`; web shows a neutral "Scan to pay" label (keeping `testID="pay-scan"` for e2e). Native is unchanged.

### Test coverage gaps (Phase 3)
> **Status (2026-08-03):** 9 of 10 RESOLVED. Gaps #1,#4,#6,#7,#8 were already closed by existing flows (verified w/ file:line evidence in triage); gaps #2,#5,#9 closed by new flows `28-ckusdc-request` + `38-relay-retarget` (`aa1142c`, 39/39 green). Gaps #3 (real NFC radio hop) + #10 (WC pairing QR) stay device/outer-loop gates.
>
> **Extension (2026-08-05):** flows 41-43 extend coverage further — `41-a11y-census` (every interactive element across 7 surfaces carries a non-empty aria-label + role), `42-receipt-reject` (tampered sig / wrong pubkey → `verifyOutcomeReceipt` rejects → honest "Couldn't verify", no fake Paid ✓), and `43-decimal-edges` (8-dec ckBTC + 6-dec ckUSDC exact-decimal on the review screen). The a11y census surfaced 2 real bugs — missing aria-labels on `amount-input` (`ReceiveMode.tsx`) + `settings-relay` (`SettingsSheet.tsx`) — both FIXED (`9618201`, RED→GREEN). An 18-dec ckERC20 case is deferred (no 18-dec asset in `FakeLedger`'s `fake_catalog`; the 6-dec case proves the formatter is decimals-agnostic — a founder outer-loop catalog addition would close it).

1. ✅ Ledger row exact units after multi-currency pay — RESOLVED (flow 27 asserts `0.00050000 BTC` + no `$`).
2. ✅ ReceiveMode ckUSDC end-to-end (merchant-create) — RESOLVED (flow `28-ckusdc-request`: UI picker → `toUnits` 6-dec → byte-exact `50000`).
3. (device/outer-loop) Real NFC 'request' event with nonzero currency — JS-event layer covered by flow 32; physical ISO-DEP radio hop is a device gate (`just ondevice`).
4. ✅ Withdraw success → balance actually decreased — RESOLVED (flow 15 asserts BOTH ledger delta AND UI balance drop).
5. ✅ Settings relay-switch mid-session (balance poll retargets) — RESOLVED (flow `38-relay-retarget`: 2nd relay seeded ∂500, switch+Apply, header ∂100→∂500 proves live poll retarget).
6. ✅ ckERC20 "Start a new deposit" escape path — RESOLVED (flow 33: escape + key-clear).
7. ✅ Bad QR / malformed request — RESOLVED (flow 36: garbage payload → `bad request QR`, review never mounts).
8. ✅ Onboarding faucet failure ($0 wallet, dead faucet) — RESOLVED (flow 37: dead-relay onboarding, offline indicator).
9. ✅ Flow #28 missing (numbering gap) — RESOLVED (filled by ckUSDC-request; meta.mjs regex needs no contiguity; do NOT renumber — breaks `DPAY_E2E_FILTER` + covers slugs).
10. (device/outer-loop) WalletConnect pairing QR rendering — unreachable on web by design (`wallet.ts` returns false on web); contract pinned offline (jest 13 cases); live WC-relay round-trip is physical.

## Process fix (2026-08-02): device-gate trigger paths expanded (blind spots 1 + 2)

A user-filed triple regression (`---` balance / status-bar overlap / `DPAY_SELFCHECK FAIL`) sailed through `just verify` and only surfaced on a fresh APK install. All three are **structurally invisible** to browser-e2e + jest (they run under V8/Node, not Hermes/RN):

1. **`react-native-get-random-values` autolinking skip** (PR20 regression). The module declares `codegenConfig` but the project runs `newArchEnabled=false`, so gradle autolinking dropped it → `TurboModuleRegistry.getEnforcing('RNGetRandomValues')` threw at call-time. Browsers/Node have native `crypto.getRandomValues`, so e2e + jest never saw it. **Fix:** `app/react-native.config.js` force-includes the module in the gradle build (`ee78a55`).
2. **`StatusBar translucent={true}` default** rendered app content under the system status bar. Browsers have no status bar. **First fix:** `translucent={false}` in `Wallet.tsx` + `Onboarding.tsx` (`07f3f03`) — necessary but **insufficient**. **Root cause / definitive fix:** the `f39cbf9` `targetSdk 34→35` bump (the "version bumping" window the founder flagged) triggers Android 15's **edge-to-edge enforcement** on real API 35 devices: `translucent={false}` + `statusBarColor` are ignored and the window is laid out behind the system bars (the google_apis x86_64 emulator also enforces it — measured `WindowInsets.statusBars().top == 63px` — but the dark-on-dark overlap was visually subtle; `uiautomator` proved the wallet gear `Button` at y=37, inside the 0–63px status-bar zone). RN 0.75's `SafeAreaView` is a no-op on Android. **Fix:** `MainActivity.onCreate` applies the system-bar insets as padding on `android.R.id.content`. The whole block is gated on `SDK_INT >= 35` — edge-to-edge is enforced only on API 35+ devices (for SDK-35 apps), and on API ≤34 the legacy model already reserves the bar space so applying insets there would be redundant. `requestApplyInsets()` is called after the listener is registered because `super.onCreate()` already consumed the initial insets dispatch; without the explicit re-dispatch the listener missed the first one and the padding was only applied later if a permission dialog / keyboard happened to trigger a re-dispatch (the plain-cold-start gap). Verified: header `Button` y=37→100 on API 35 plain cold start (out of the 0–63px status-bar zone, no clickable node under the bar), API 34 unchanged (gear y=165 baseline, listener is a no-op via the gate); `DPAY_SELFCHECK PASS` on both; `just app` green.
3. **Stale mainnet canister** (deployment drift, not code). The deployed canister predates `RampCapability` fields → relay couldn't decode `currencies()` → `---`. FakeLedger has current Candid types. **Fix:** canister upgrade via `scripts/dfx-deploy-ic.sh` + `register_currency_meta` (deployment-only; `.did` refreshed `c52ae49`).

**Resolution (the process fix, not code):** the `AGENTS.md` "Pre-merge gates off the hot verify path" section now enumerates the three structural blind-spot classes and **expands the device-gate trigger paths** to cover them: `app/react-native.config.js`, `app/package.json` (native-module add/remove), `app/index.js` (polyfill imports), any new use of a Web API that may need a RN polyfill (`crypto`/`fetch`/`WebAssembly`/`URL`/…), and `app/components/**` changes touching `StatusBar`/`SafeAreaView`/`BackHandler`/`Platform`-gated rendering. The gate itself (`just app` / `just ondevice`) is unchanged and proven green; the checklist now keeps these classes from being skipped. This is the documented closure of the gap the founder flagged ("did you test this?") after the triple regression.


- **HARD blocker** — blocks a specific path until an *external* step lands; cannot be fixed in code in this repo.
- **high** — should land before pilot.
- **medium** — production/scale tradeoff; defer with the documented mitigation in place.
- **low** — polish / config invariant.

## Immediate next milestone: complete multi-currency wallet (2026-08-01)

The protocol/canister settlement kernel is currency-aware, but the installed product gives users effectively no indication that other currencies exist. The next milestone is therefore **correct end-to-end asset support plus an asset-first navigation rework**, not a cosmetic currency toggle. The merchant selects the settlement asset; the payer cannot substitute another asset because dpay does not swap.

Work in this order:

1. **MC1 — exact amounts and authoritative asset metadata (high).** Replace JavaScript `number`/Android `Double` transport for protocol `u64` values with decimal strings or another exact representation. Parse user amounts without `parseFloat`/rounding. Expand the catalog to distinguish backing asset code/symbol, wrapper name, network, ledger/display decimals, fee, cap, chain ID/token contract, and per-direction ramp capabilities. Unknown families must fail closed, never fall back to Bitcoin. **Status (2026-08-01): ✅ DONE.** Protocol `u64` amounts now cross every boundary (TS ↔ Kotlin `@ReactMethod` ↔ relay JSON) as decimal-digit **strings** via a shared exact parser (`dpay_core::parse_decimal_to_units` + `app/lib/amount.ts` BigInt mirror, round-trip-pinned by proptests across the whole `u64 × 0..=18` space; flow `29-exact-amount` asserts `9007199254740993` (2^53+1) round-trips byte-exact — impossible under `number`). No `parseFloat` remains in the amount path. `CurrencyDescriptor` now carries `wrapper_name`/`backing_symbol`/`network`/`display_decimals`/`fee`/`cap`/`chain_id`/`token_contract` + `onramp`/`offramp: RampCapability` per currency (canister + relay + app). `familyDisplay()` returns `null` for unknown/`CkSol`/missing families — no Bitcoin fallback; consumers render "Unsupported" and disable ramps (jest-pinned, typecheck-enforced). The one global raw-unit tx `CAP` is NOT yet governed per-currency (that is MC2). Commits: `662ab29` (parser), `8c5bda1` (fail-closed), `04e5ec3` (metadata), `cd40ef2` (transport).
2. **MC2 — safe currency identity and policy (high).** Prevent a registered currency ID from being reassigned under an already-reviewed authorization, or bind a versioned immutable asset identity. Activate ledger+metadata+minter atomically and validate metadata against the ledger. Replace the one global raw-unit transaction cap with governed per-currency caps; the ledger fee remains outside the payer authorization. **Status (2026-08-02): ✅ DONE.** Four units, all landed + proven on PocketIC: **U1** — `pay` reads the governed per-currency cap from `CURRENCY_META` (fail-closed: a cap-less currency rejects every non-zero pay), replacing the single global `CAP` as the authorization gate; the global `CAP` cell + `per_tx_cap()` query are retained as a legacy deploy readout. **U2** — `register_ledger`/`register_minter` are INSERT-ONLY (same-value re-register is idempotent Ok; a different principal/mintable is rejected with a currency-named message). **U3** — `retire_currency` is an irreversible, append-only RETIRED set; a retired id is dead forever and can never be re-registered. **U4** — `register_currency(CurrencyRegistration)` is the single atomic activation path: it activates LEDGERS + MINTERS + CURRENCY_META in ONE update message, AFTER strictly validating `decimals`/`fee`/`wrapper_name` against the live ledger's `icrc1_decimals`/`icrc1_fee`/`icrc1_symbol` (F3 — no exemptions, including the DEMO currency; mismatch → Err with NOTHING inserted, atomicity via the IC's per-message rollback). The piecemeal `register_ledger`/`register_minter`/`register_currency_meta` remain (deprecated for fresh activation; still useful for incremental display-meta corrections, still enforce U2 immutability + U3 retire). Deploy scripts use `register_currency` for new activations (the mainnet script keeps the piecemeal path for the already-seeded DEMO id — re-runnability under U2 idempotency). Proven on PocketIC: `register_currency_{admin_gated,rejects_existing_id,rejects_retired_id,decimals_mismatch_*,fee_mismatch_*,symbol_mismatch_*,happy_path_*,second_call_*}` (8 new tests; 62 canister tests total).
3. **MC3 — authoritative balances (high).** The wallet balance path must observe ckBTC refreshes, asynchronous ckERC20 mints, and direct ICRC transfers. `BAL_CACHE` may remain an optimization but cannot be the only display source without an explicit refresh/freshness contract. Tests must assert facade/relay balance, not only direct ledger balance. **Status (2026-08-02): ✅ DONE.** Two units, both landed + proven on PocketIC: **U1** — the facade exposes an authoritative on-demand `refresh_balance(pubkey, currency)` update (re-reads the ledger via `icrc1_balance_of` + writes `BAL_CACHE` + returns the amount; no auth gate — a read + cache write moves no value, consistent with the unauthenticated `balance_of`/`deposit_address` surface), and `refresh_deposit` now inline-refreshes the cache after every successful minter call (both the `Ok(statuses)` mint branch and the `NoNewUtxos` poll branch), so a freshly-minted ckBTC deposit is immediately visible via `balance_of` WITHOUT an extra refresh. **U2** — the relay's live `Ledger::balance` path is TTL-gated by a relay-side freshness contract: most polls hit the fast cached `balance_of` query; once per `BALANCE_TTL_SECS` (15s) window one poll does the authoritative `refresh_balance` update. The TTL decision lives in the RELAY (`AgentLedger.last_refresh: Mutex<HashMap<(pubkey, currency), Instant>>`), not the canister; a cold start / relay restart forces a first-poll refresh (missing entry → stale) so a restart can't wedge a stale balance. This bounds displayed-balance staleness to ~TTL+one-poll and surfaces the credit paths the cache cannot see on its own (direct ICRC transfers + async ckERC20 heartbeat mints, which land on the ledger WITHOUT invoking the facade). `FakeLedger` (the offline/demo path the e2e suite uses) is untouched (already authoritative in-memory); `Ledger::balance`'s trait signature is unchanged. Proven on PocketIC: canister `refresh_deposit_makes_minted_balance_visible_via_balance_of` + `refresh_balance_reflects_a_cache_bypassing_credit` (facade path), and relay `balance_refresh_is_authoritative_after_cache_bypass_credit` (cold-start authoritative refresh → direct ICRC credit bypasses the cache → `refresh_balance` surfaces it → a within-TTL `balance()` reads the same amount via the cache — TTL-gating + cache coherence). `just test-live` GREEN (43/43).
4. **MC4 — trusted receipts and durable reconciliation (high).** The app must verify receipts against an authenticated/pinned canister key, not the public key supplied inside the same untrusted receipt. Initialize signing before accepting payments, make post-transfer receipt recovery durable, and have relay ambiguous-outcome/restart handling query canister-backed receipt state bound to the authorization, currency, and nonce. **Status (2026-08-02): ✅ DONE.** Five units, all landed + proven: **U1** — `pay` ensures the receipt Ed25519 key is generated BEFORE the ledger commit (eliminates the first-pay trap where a commit-orphaned debit had no signed receipt). **U2** — `reconcile(currency)` reconstructs + stores a signed receipt for trap-orphan debits after the post-commit failure window. **U3** — the relay's `GET /receipt/:nonce` is canister-backed and restart-safe (queries the durable `RECEIPTS` stable map via `Ledger::receipt`), and `POST /pay` falls back to a `Transient` canister receipt lookup when its process-local idempotency cache misses. **U4** — `GET /api/v1/receipt_pubkey` is the discovery route exposing the ledger's receipt verify key. **U5** — the APP now pins the expected receipt-signing pubkey independently of the receipt body (`EXPECTED_RECEIPT_PUBKEY` in `app/config/constants.ts`, via the same `__DPAY_TEST_*` override seam as `POLL`; the harness injects the FakeLedger's deterministic test key): `verifyOutcomeReceipt` rejects any receipt whose embedded `pubkey` ≠ the pin EVEN IF the signature is internally valid (the malicious-relay close), AND runs a full-auth binding (receipt `{from,to,amount,currency,nonce}` must match the signed authorization the payer holds; `amount` via `cmpRaw` BigInt). Empty pin = dev/unpinned fallback. Commits: d642140 (U1), 56ad1cd (U2), 42fd745 (U3), c915a26 (U4), + U5 (this unit). Proven: jest `receipt.test.ts` (16 cases), e2e `30-trusted-receipt` (a wrong-key receipt with a VALID Ed25519 sig under a fresh attacker keypair is rejected → no fake "Paid ✓"; RED under an empty pin → the test is load-bearing), full suite 30/30. **Remaining (stronger, not attempted):** migrate to IC chain-key (`sign_with_schnorr`/`sign_with_ecdsa`) so the receipt secret never lives in canister stable memory; bake the real canister's `receipt_pubkey()` into the prod build's `EXPECTED_RECEIPT_PUBKEY` at deploy.
5. **MC5 — asset-first wallet and transaction UX (high).** Show every enabled asset, including zero balances and no-ramp assets. Make the demo rail visibly separate. Add asset detail/actions; require merchant asset selection in Request; lock the payer review to that exact asset and matching balance; key offline deductions by currency; reject unknown assets before signing. No cross-asset portfolio total. **Status (2026-08-02): ✅ DONE.** Asset-first wallet (all assets always visible, demo rail separated by an ASSETS heading, fail-closed action buttons), merchant asset selection in Request (per-currency chips, runtime currency encoded), and locked-asset payer review (exact-unit display + per-asset balance gate, no payer asset switching) are done and proven by flows 25 + 27. **Remainder completed 2026-08-02:** currency-keyed offline deduction (`offlineSpent` is now `Record<number,string>`; `markOfflinePaid(amount,currency)`; per-currency display via the pure `applyOffline` helper — an offline ckBTC hand-off reduces ONLY ckBTC's shown balance, never DEMO's; commits `9e51929`), unknown-asset rejection before signing (`isPayableAsset(catalog,currency)` gate in both PayMode review + NfcTap autoSign — never signs a garbage/`CkSol` currency; `9069dcd`), and a ckUSDC 6-decimal end-to-end pay flow (flow `31-ckusdc-pay`: request→fund→scan→review→Approve→Paid byte-exact `50000` raw; `9a21abd`). **Still MC8 (not MC5):** NFC asset disclosure/validation over the physical radio hop.
6. **MC6 — dedicated Ledger and cleaner navigation (high).** Move transaction history out of the Pay/Receive scroll into a dedicated Ledger page. Preserve currency in the row model, format each row with its asset descriptor, retain successful per-asset history when another asset fails, and add an asset filter. Move Settings from the detached footer into an intuitive header/account/overflow control with a proper touch target; put relay configuration under an advanced section with an explicit Apply action. **Status (2026-08-01): ✅ DONE.** History lives on a dedicated Ledger tab (`tab-ledger`) with per-row currency-correct units and an asset filter (chips appear when 2+ currencies are present); `Txn` carries `currency`; Settings moved from the detached footer to a header gear control; relay URL demoted to an Advanced section with an explicit Apply button. Proven by flows 07/08/24/26 (Ledger) + 12/13/19/20/22 (Apply).
7. **MC7 — remove zombie primary actions (medium).** Remove the prominent `Paste request` button from the main Pay screen. Keep clipboard decode only as a subordinate scan fallback if no-camera/desktop/support usage justifies it; otherwise delete it and update flow coverage. The primary Pay entry remains tap or scan. **Status (2026-08-01): ✅ DONE (demoted).** Paste is now a muted ghost secondary control (`pasteSecondary`) instead of a prominent brand-green primary; `btn-paste` + flow 14 retained pending a founder decision on full deletion.
8. **MC8 — native/NFC parity and honest ramps (high).** Repair Android bridge parity (`toName`, `memo`, full signing arguments, withdrawal signing, exact amounts). NFC must disclose and validate the requested asset. Make ckERC20 parameters token-specific, enforce chain ID, persist transaction state, wait for receipts/reverts, and provide an Android wallet/partner handoff. Do not advertise CkSol or unsupported cash-out paths. **Status (2026-08-02): ✅ DONE (functionally; WC real-wallet pair = outer-loop founder sign-off).** Android bridge parity (`signAuthorization` 9-arg, `signWithdrawal`, `wireLen/signingLen/requestLen`) + exact decimal-string amounts shipped under the bridge-parity plan (Wave A/B/C) + MC1. The remainder landed as 7 units: **U1** NFC asset disclosure (at-tap pre-sign "Paying 0.00050000 BTC on Bitcoin" + asset-correct formatter, no blind tap), **U2** ckERC20 onramp params are catalog/token-specific (fail-closed without `token_contract`; a future ckERC20 needs no relay/app change), **U3** chain-ID enforced at wallet connect (wrong-network aborts before any tx), **U4** ETH receipts/reverts awaited (no false "will appear in ~20min" on a revert), **U5** ckERC20 deposit state persisted across restart (watching phase resumes via the relay balance poll WITHOUT wallet reconnect), **U7** ramp-honesty regression pins (no CkSol, no false cash-out). **U6 WalletConnect** (founder-chosen over manual-calldata — the onramp is online-by-nature): a provider-agnostic `resolveOnrampProvider()` adds a WC-backed EIP-1193 source for native Android (web keeps `window.ethereum`; e2e keeps its mock), isolated behind a lazy dynamic import + vite/jest shims so `just verify` never executes WC code; mocks are tsc-checked against the real SDK surface with a compile-time drift-detector; the functional capstone uses `showQrModal:false` + a `display_uri` QR (react-native-qrcode-svg, zero new deps) so the built-in `@reown/appkit` modal path is runtime-dead (the appkit shim is a build-time-only Metro satisfier, FIXME'd); RN polyfills + manifest `<queries>` shipped; `WALLETCONNECT_PROJECT_ID` baked. Commits: dbc3df7/822f4df/b3ccbd1/ac10e8f/33d7782/4417c3e (U1-U5,U7) + d8ba488/ece4b75/8275cc4/098f905/4ec8f1b/f07520b/a93fd57 (U6). **Remaining (non-blocking):** real-wallet pair over the live WC relay (scan QR with MetaMask on a 2nd device) is an outer-loop founder sign-off (like real-BTC deposit, issue #1); the optional U6.5 disconnect helper is deferred.
9. **MC9 — release gates and operations (high).** Add request→QR/NFC→settle→receipt→balance/history coverage for 2/6/8/18-decimal assets, FakeLedger/canister conformance, Android bridge tests, declarative atomic asset deployment, per-asset readiness/metrics, and real outer-loop ckBTC+ckUSDC runs before pilot. **`DPAY_SELFCHECK FAIL` is now a failing browser-e2e gate** (the Driver also fails on unexpected page/console/network errors; offline flows must scope an explicit dead-origin allowance). ✅ **`dpay-sim` REPAIRED (2026-08-05)** — see the "dpay-sim GREEN" note below; ✅ **decimal conformance matrix ASSESSED (covered)** — see the note below. The remaining multi-asset/operations work (declarative atomic deploy, per-asset readiness/metrics, real outer-loop ckBTC+ckUSDC runs) stays open.

Milestone acceptance: a fresh install visibly exposes configured assets; a merchant can request ckBTC or ckUSDC; a payer sees the exact unit and matching balance; settlement, receipt, Ledger row, and resulting balance all retain that asset; unsupported funding/cash-out paths are explicit and never route through another family.

### 7/9. ✅ RESOLVED (2026-08-05) dpay-sim GREEN + decimal conformance matrix assessed

- **dpay-sim GREEN.** `dpay-sim` was stale against the ledger refactor: its `InitArg` predated the facade redesign (`{account_a, balance_a, account_b, balance_b, per_tx_cap}`), so `just sim` PANICKED at canister init with `field ledgers is not optional field` — the facade's actual init arg is now `DpayInitArg { ledgers: Vec<LedgerConfig>, per_tx_cap, controller }`, and the facade delegates `pay`/`balance_of` to a registered external ICRC ledger (it holds NO balances itself). **Fix:** `crates/dpay-sim/src/main.rs` now mirrors the canonical funding pattern from `crates/dpay-canister-tests/tests/icrc_settle.rs::setup` + `offline_sign_settles_on_demo_currency` exactly — it installs the REAL DFINITY `ic-icrc1-ledger` (cached at `third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm`) with the facade as the minting-account owner, registers it for DEMO_USD as `mintable`, seeds the governed controller (`Principal::management_canister()`, same stand-in as the test suite's `pic_admin`), registers the per-currency cap (MC2 U1 fail-closed — `pay` rejects cap-less currencies), and funds the payer $100.00 via the controller-gated `mint`. The demo's contract is preserved verbatim (ANSI-color narration, the 9500/500-cent assertions, the double-spend + expiry refusals, the closing line). `just sim` is GREEN end-to-end and self-checking again. `Cargo.toml` gained `icrc-ledger-types` + `num-traits` + `ed25519-dalek` (workspace deps). No justfile change needed — `build-canister` already builds the facade wasm; the ledger wasm is prebuilt.
- **Decimal conformance matrix — COVERED (no new test needed).** The 2/6/8/18-decimal matrix splits cleanly across two layers, both already covered:
  - **Rendering (the precision-risk layer):** flow `43-decimal-edges` (`e2e/tests/43-decimal-edges.mjs`) drives the review screen's `fmtCurrencyAmount` → `fmtAsset` (all-BigInt, no `Number`/`parseFloat`) across 8-dec ckBTC + 6-dec ckUSDC + **18-dec ckDAI** (mid/low/pad each). The 18-dec case — the precision extreme that drops low digits past 2^53 under a float path — was ALREADY closed in a prior session (FakeLedger's `fake_catalog` ships a 18-dec ckERC20 ckDAI, currency 4). This makes NEXT-SESSION item 3 ("18-dec ckERC20 coverage") stale/resolved. Jest pins the formatter unit-level.
  - **Settlement (the canister layer):** the facade is **decimals-agnostic** — `pay` (`lib.rs:1567+`) operates on raw `u64` units (`amount = sa.auth.amount`); decimals enter ONLY at `register_currency` strict-validation time (checking `decimals` against `icrc1_decimals`), never in the pay/balance/receipt path. The FULL request→settle→receipt→balance/history flow for a NON-DEMO currency is therefore already proven by `icrc_settle.rs::non_mintable_currency_settles_and_cannot_be_minted` (CKX currency-1 settle on its own ledger) + `transactions_of_records_mint_pay_burn` (history) + `pay_yields_canister_signed_verifiable_receipt` (receipt) + `currencies_cannot_cross` (per-ledger segregation). Adding a per-decimal canister test would be redundant — the canister moves identical raw bytes at 2/6/8/18 decimals.
  - **Coverage map:** flow 43 (8/6/18-dec render) + `icrc_settle.rs` (multi-currency raw-u64 settle/receipt/history) + jest (formatter units) + relay decimal-string transport tests (MC1, exact). No gap found; no new canister test added.
- **Atomic asset-deploy script — SKIP (overlaps testnet track).** NEXT-SESSION item 7 lists "declarative atomic asset deployment"; the testnet track is building `scripts/dfx-deploy-ic-staging.sh`, which IS the atomic asset-deploy path (register ledger + minter + full currency metadata in one idempotent flow). Not duplicated here.
- **Per-asset readiness/metrics — SKIP (founder-facing/loosely scoped).** Item 7's "per-asset readiness/metrics" is a founder-facing operational dashboard without a crisp spec; left for founder definition.

## Other open issues

### 11. ✅ RESOLVED (2026-08-05) RN release toolchain moved to AGP 8.12 + API 36 (Phase B)

- **What/why.** The Play app now targets/compiles API 35 after Play rejected the old API 34 bundle. The standalone `android/` device-fidelity module explicitly pins AGP 8.7.3, but the separate React Native release build in `app/android/` uses the versionless Android plugin dependency supplied by RN 0.75.4, whose bundled version catalog pins AGP 8.5.0. AGP 8.5 emits a warning that it was tested only through compile SDK 34.
- **Resolution.** Founder-greenlit Phase B of [`2026-08-02-android-release-optimization-plan.md`](2026-08-02-android-release-optimization-plan.md). Migrated RN `0.75.4` → **`0.86.2`**, which brings **AGP 8.12.0** (supports API 36) via the bundled `@react-native/gradle-plugin` catalog (no catalog override, no `node_modules` patch). Also: React `18.3.1` → `19.2.3`, Kotlin `1.9.24` → `2.1.20`, Gradle wrapper `8.8` → `8.13`, compile/target SDK `35` → `36`, build-tools `36.1.0`, `newArchEnabled=true` (forced — RN 0.82+ removed the legacy arch; the hand-written `DpayCore`/`DpayNfc` modules survive via the New-Arch interop layer, no TurboModule/codegen rewrite). Commits `bb1bbf0`/`f5eca10`/`39fb642`/`f3b145b`. Gates 1–6 GREEN on the API-36 emulator (`just typecheck` clean, `just bridge-parity` OK 21 methods, `just verify` 44/44 e2e, `just ndk` builds the 16 KB-aligned `.so`, gradle `assembleRelease`+`bundleRelease` `BUILD SUCCESSFUL` with R8 diagnostics present, `just app` `DPAY_SELFCHECK PASS`, `just ondevice` 9/9). **Founder real-device check PASSED (2026-08-05):** the new build runs on the real device — camera, NFC, and the full RN 0.86.2/New-Arch bridge surface verified on hardware. Only the Play pre-launch report + `just play-upload` (upload-key AAB + staged `mapping.txt` are ready) remain as launch ops.

### 12. ✅ RESOLVED (2026-08-02) Release builds do not use R8 or resource shrinking

- **What/why.** The RN release build previously had `minifyEnabled false`, no `shrinkResources`, the non-optimizing ProGuard defaults, and an empty app rules file. Play's AAB ABI splitting and Hermes were active, but unused Java/Kotlin code and Android resources were not removed and DEX names were not obfuscated. JNA/UniFFI reflection meant this could not be enabled safely without explicit bridge keep rules and release-device testing.
- **Resolution (Phase A of [`2026-08-02-android-release-optimization-plan.md`](2026-08-02-android-release-optimization-plan.md)).** `app/android/app/build.gradle` now sets `minifyEnabled true` + `shrinkResources true` + `proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"` on the release build type (the old `enableProguardInReleaseBuilds=false` var + comment block were removed; no `android.enableR8` flag, no `-ignorewarnings`, no blanket keeps). `app/android/app/proguard-rules.pro` carries the documented Android JNA rules (`-dontwarn java.awt.*`, `-keep class com.sun.jna.*`, `-keep class * extends com.sun.jna.*`, `-keepclassmembers class * extends com.sun.jna.*`) plus the two exact generated-interface keeps (`uniffi.dpay_ffi.UniffiLib` + `uniffi.dpay_ffi.IntegrityCheckingUniffiLib`). `scripts/play-upload.sh` now preserves each release's `mapping.txt` as `dpay-release-$DPAY_VERSION_CODE-mapping.txt` beside the staged AAB in the immutable `.dev/releases/play-$DPAY_VERSION_CODE/` dir (fails the upload if the mapping is missing/empty; path printed in the summary). R8 is confirmed running: `minifyReleaseWithR8` + `shrinkReleaseRes` + `optimizeReleaseResources` + `shrinkBundleReleaseResources` all execute, producing a 17 MB / 175,633-line `mapping.txt`.
- **Verification (all gates GREEN, 2026-08-02).** `just verify` (34/34 e2e + core/canister/relay/typecheck/bridge-parity); `just apk` (`BUILD SUCCESSFUL`, mapping generated); `just app` (`DPAY_SELFCHECK PASS` — full RN→Kotlin→UniFFI→`libdpay_ffi.so` surface proven under R8 minification); `just ondevice` (9 instrumented tests on emulator API 34). Phase B (issue 11) is still open.
- **Next step.** None for Phase A. The first production upload that actually ships the minified AAB should sanity-check the store-listed size delta vs the Phase-A baseline (APK 93,728,358 B / AAB 39,649,424 B at version code 1785619014-equivalent; the pre-WalletConnect baseline was APK 87,540,415 B / AAB 36,233,482 B).

### 13. ✅ RESOLVED (2026-08-02) WalletConnect onramp is functionally paired (showQrModal:false + display_uri QR)

- **What/why.** Commit `ece4b75` (2026-08-02) added WalletConnect v2 (`@walletconnect/ethereum-provider@2.23.10`, app/package.json:16) to power a future fiat/WC onramp. Its `index.native.js` dynamically imports `@reown/appkit/core`, but the installed `@reown/appkit@1.8.19` has no `./core` export subpath and is web-only (lit + DOM APIs that cannot bundle under Metro/RN); there is no standalone `@reown/appkit-core` package. This broke **every** release/JS bundling build (`:app:createBundleReleaseJsAndAssets` → `Unable to resolve module @reown/appkit/core`) from `ece4b75` until the shim landed. The e2e/jest suites never saw it because they stub `@walletconnect/*` to no-ops (`e2e/vite.config.js` aliases, `jest.config.js` `moduleNameMapper` → `__stubs__/walletconnect-stub.ts`).
- **Resolution (MC8 U6 capstone, 2026-08-02).** The WC onramp is now FUNCTIONALLY wired via a custom pairing path using the existing QR infra — ZERO new deps. `walletconnect.ts` sets `showQrModal:false` (bypassing the web-only `@reown/appkit` modal entirely) and exposes `pairWalletConnect(onUri)`, which subscribes to the WC `display_uri` event (payload: a plain string — the `wc:` URI; exact shape from the installed SDK .d.ts `IProviderEvents.EventArguments`), forwards it to `onUri` so the sheet renders a custom on-brand `<QRCode>` (react-native-qrcode-svg, already a dep), calls `provider.connect()` (the wallet handshake), and clears the QR when the `connect` event fires. This makes the `@reown/appkit/core` import path **runtime-UNREACHABLE** (ethereum-provider only dynamic-imports the modal when showQrModal is true), so the Metro shim (`app/shims/reown-appkit-core.js`) is now a pure build-time satisfier (reclassified with a FIXME; the metro intercept + shim file are KEPT because ethereum-provider statically references the subpath — removing them risks re-breaking release bundling). The production `WALLETCONNECT_PROJECT_ID` is now baked in `constants.ts` (safe because the modal path is dead); `jest.setup.js` sets `__DPAY_TEST_WALLETCONNECT_PROJECT_ID=''` globally to disable WC for the offline jest inner loop. `pairOnrampWallet` in `wallet.ts` preserves the dynamic-import isolation boundary. Proven: jest `walletconnect.test.ts` (13 cases incl. display_uri/connect event handling, listener cleanup, disabled guard), `wallet.test.ts` (pairOnrampWallet delegation + web-first isolation), `constants.test.ts` (seam override); e2e 34/34 (flow 16 byte-identical calldata, flow 34 resolution seam intact — the web harness never renders the pairing QR because `pairOnrampWallet` is a web no-op). `just typecheck` clean (conformance drift-detector stays GREEN after the cache retype to `Promise<EthereumProviderInstance>`).
- **Outer-loop sign-off (NOT a blocker).** Real-wallet pairing — scan the QR with MetaMask on a 2nd device over the online WC relay — is a founder outer-loop gate (same class as the NFC radio hop and the ETH tx-mining hop). The pairing CONTRACT is pinned offline; the live relay round-trip is physical.

### 1. (low) ckBTC live deposit→mint not yet exercised with real BTC

- **What/why.** No KYC/NNS allowlist is required to mint ckBTC — the mainnet ckBTC minter (`mqygn-kiaaa-aaaar-qaadq-cai`) runs in GeneralAvailability mode with **no KYC checker** (`get_minter_info` returns only `min_confirmations=4`, `kyt_fee=100`, `deposit_btc_min_amount=300`, `retrieve_btc_min_amount=50000`; the `btc_checker_principal` is unset). The minter's `UpdateBalanceError` has no "not allowed"/KYC variant; the only screening is automatic **KYT (Know-Your-Transaction)** that flags tainted *UTXOs*, not principals. A previous version of this issue incorrectly claimed a hard KYC/NNS blocker — that was an **unverified assumption**, disproven by the live minter config and by the facade's own `get_btc_address`/`update_balance` calls succeeding against mainnet.
- **Current state.** The full mint/spend path is proven **offline end-to-end** (PocketIC + `dpay-mock-minter` + `FakeLedger`). Live, the mainnet wiring is proven reachable: `GET /deposit/address?currency=1` → 200 real `bc1...` address; `POST /deposit/refresh` → 200 `NoNewUtxos`; `GET /deposit/info` → 200. A clean, real BTC deposit (≥300 sats, 4 confirmations) should mint currency 1 to `Account{owner: facade, subaccount: pubkey}`, which `pay()` reads authoritatively. **The FREE testnet proof (2026-08-06) closes the wiring half:** the ckBTC Testnet chain-key minter is registered live on prod `ssqti` (currency 3), and the facade round-trips to it — `deposit_info(3)`/`deposit_address(3)`/`refresh_deposit(3)` all return the real minter's params + a real Testnet4 `tb1q…` address + a clean NoNewUtxos. A real Testnet4 BTC deposit + 4 confirmations would mint currency 3 (the same code path as mainnet currency 1, differing only by minter principal). The current `balance_of` display query can remain stale because `refresh_deposit` does not refresh `BAL_CACHE`; that separate product blocker is MC3.
- **Next step.** After MC3 defines the authoritative display path, send a small on-chain deposit, wait 4 confirmations, trigger `refresh_deposit`, and verify the direct ledger balance, relay/app balance, payment spend, and Ledger history all agree. This costs real BTC and is a final outer-loop gate before pilot.
- **Note (2026-08-05, code fix — NOT an outer-loop item):** the `composeTimeout` caller-signal-wins fix (`d5b992f`) RESOLVED a latent timeout bug on this path — `DEPOSIT_ADDRESS_TIMEOUT_MS=20s` is now effective. `withDefaultTimeout(signal)` used to arm a 10s backstop even when the caller supplied its own signal, so "first abort wins" silently capped the `deposit_address` fetch at 10s; on a slow mainnet (an IC update call, 5-7s+ under load) that was a real risk of a spurious abort. The backstop is now a SAFETY-NET for omitted-signal callers only; a caller that provides a signal OWNS its deadline. TDD-pinned (jest case RED under the old code → GREEN after).

### 8. (low) ckBTC live withdrawal not yet exercised with real BTC

- **What/why.** The withdrawal path (facade `withdraw` → `icrc2_approve` → minter `retrieve_btc_with_approval`) is built and proven **offline end-to-end** (PocketIC through the real facade + `dpay-mock-minter` mirroring the real minter's exact candid; the relay's `FakeLedger`/route; the app's on-device-signed `WithdrawSheet`; e2e flow 15). It has NOT been exercised with real ckBTC against mainnet — there is no real ckBTC held at a facade subaccount to withdraw yet (issue 1's live deposit is the prerequisite). The wiring is proven reachable up to the minter (same as deposit); the live ceiling is "reaches `retrieve_btc_with_approval`".
- **Current mitigation.** Non-custodial by construction: `withdraw` moves nothing without a verified user Ed25519 signature over the canonical `WithdrawAuth` (single-use nonce in `WITHDRAW_NONCES`, MemoryId 12 → no double-burn). `RETRIEVE_BTC_MIN_AMOUNT = 50_000` mirrors the live minter's floor.
- **Next step.** (Optional, costs real ckBTC/BTC) Fund a facade subaccount with real ckBTC (via issue 1's live deposit), then withdraw ≥50_000 sats to a real BTC address and confirm the burn + on-chain BTC send. A final real-money confidence check, not a blocker.

### 9. (medium) Withdrawal approve→retrieve front-running residual (inherent to ckBTC)

- **What/why.** The facade's `withdraw` calls `icrc2_approve` then `retrieve_btc_with_approval` across an `await`. In principle a separate caller could invoke the minter's permissionless `retrieve_btc_with_approval` with the same subaccount + an attacker address in the gap, consuming the single-use allowance first. See CODEBASE_ANALYSIS risk 8.
- **Current mitigation.** Blast radius is bounded to the EXACT authorized `amount` (the approval is for that amount, consumed once) — never the user's whole balance. The facade's own retrieve follows immediately. This is the documented residual every `retrieve_btc_with_approval` client (incl. the NNS reference clients) carries; the minter offers no signature-binding-the-destination path, so no code fix is possible without a minter change. It is a known, bounded property, not a dpay-specific gap.
- **Next step.** Track ckBTC minter upgrades for a destination-bound retrieve variant; none exists today.

### 2. ✅ RESOLVED (2026-08-02) Receipt signing exists, but the app does not authenticate the signer

- **What/why.** R2 added a canonical Ed25519-signed receipt and the canister exposes `receipt_pubkey()`, but the app originally verified each receipt against the public key carried inside that same untrusted receipt. A malicious relay could therefore create its own key, claim, and signature that pass this self-consistency check. Separately, the real canister key is generated from `raw_rand` and stored in stable memory (`RECEIPT_SECRET`, MemoryId 10), so a malicious upgrade could exfiltrate it.
- **Resolution (MC4 U1–U5).** **U5 (app-side pin, the client trust anchor):** `verifyOutcomeReceipt` now requires `receipt.pubkey === EXPECTED_RECEIPT_PUBKEY` (pinned in `app/config/constants.ts` via the `__DPAY_TEST_RECEIPT_PUBKEY` override seam; production bakes the real canister's `receipt_pubkey()`), rejecting a fabricated key even when its signature is internally valid — the malicious-relay close. It also runs a full-auth binding (receipt fields vs the signed authorization; `amount` via `cmpRaw`). **U1–U4 (canister/relay):** the receipt key is ensured before the ledger commit (U1), reconcile reconstructs signed receipts for trap orphans (U2), `/receipt/:nonce` is canister-backed + restart-safe (U3), and `/receipt_pubkey` is the discovery route (U4).
- **Next step (stronger, not a blocker).** Migrate to **IC chain-key** (`sign_with_schnorr` / `sign_with_ecdsa`) before pilot so no exportable secret lives in canister state, and bake the real canister's `receipt_pubkey()` into the prod build's `EXPECTED_RECEIPT_PUBKEY` at deploy (one-time per canister; the key never rotates).

### 3. (launch-time, founder-owned) R4 external governance hand-off

- **What/why.** The IC-level *code controller* of the facade canister has not yet been handed to an SNS root or a blackhole. The code fully supports a governed controller end-to-end (R1/R4: admin methods denied when `controller == null`, `InitArg.controller` seeds a governed principal at deploy, `set_controller` is two-step rotation) and `docs/GOVERNANCE.md` documents the exact operator steps. Until that external transfer lands, "we can't touch your funds" is a promise, not an enforced property — whoever holds the deploy key can still upgrade the wasm.
- **Owner / timing — DO NOT NAG.** **The founder will perform this at launch, not before.** This is a launch-time operator task, NOT an active blocker. Do NOT re-raise it in session summaries, do NOT list it under "next steps" or "reminders", and do NOT flag it during normal dev work. The code side is complete; the operator step is calendared to launch. Leave this item alone unless the founder explicitly raises governance.
- **Current mitigation.** Controller currently locked to the `dpay` deploy identity; in-canister admin surface is closed. Two distinct layers documented in `docs/GOVERNANCE.md` (in-canister `CONTROLLER` gates admin *methods*; IC-level code controller gates *upgrades* — both must be governed).
- **Reference.** `docs/GOVERNANCE.md` launch checklist (the exact operator steps, when the time comes).

### 4. (medium) `ADMIN_CALLERS` operator allowlist is the fixed deploy identity

- **What/why.** Cycles/admin operations (`provision_ledger_canister`, `transfer_cycles`) are gated to a hardcoded `ADMIN_CALLERS` operator allowlist — the fixed deploy identity, not a governed/rotatable principal.
- **Current mitigation.** These are ops/cycles functions only (not money-movement of user funds); bounded blast radius. Documented in `docs/GOVERNANCE.md`.
- **Next step.** Rotate `ADMIN_CALLERS` to a governed principal before pilot (`docs/GOVERNANCE.md` checklist).

### 5. (medium) R3 reconcile is bounded

- **What/why.** `reconcile(currency)` — which closes the cross-canister `pay()` trap window (R3) — is single-currency, walks recent in-canister blocks (`RECONCILE_MAX_BLOCKS` = 10k window), and is admin-triggered (not a heartbeat). Archived-block paging and automatic heartbeat triggering are deferred.
- **Current mitigation.** This is a **cycle-cost/operations tradeoff, NOT a correctness gap.** The trap window is already narrowed by the quantized `created_at_time` dedup (same-bucket retry → ledger `Duplicate`); reconcile is idempotent and admin-gated, so an operator can run it after any suspected trap or on a schedule. Proven on PocketIC via a reinstall-based trap simulation.
- **Next step.** Add a heartbeat auto-trigger + archived-range paging as scale/cycle-cost demands.

### 6. (high) App does not expose functional multi-currency payments

- **What/why.** 🟡 **PARTIALLY RESOLVED (MC5 Slice 7a + 7b, 2026-08-01).** `ReceiveMode` no longer hardcodes currency 0 — it exposes a per-currency chip row (`request-asset-<key>`) and encodes the runtime-selected currency into the request via the new `toUnits(amount, decimals)` parser. `PayMode`'s review + Paid + QR hand-off paths format amounts with the new shared `fmtCurrencyAmount(catalog, currency, raw)` (no `usd()` for non-DEMO amounts), and the balance check uses ONLY the requested asset's balance (`assetBalances[req.currency]`), so a 50000-sat ckBTC request is no longer compared against the 10000-cent DEMO balance. Proven end-to-end by flows `25-asset-request` (currency 1 encoded + "0.00050000 BTC" readout, no `$`) and `27-asset-pay` (locked-asset review + per-asset balance gate + correct settlement on currency 1's ledger). **Still single-currency / open:** NFC (`NfcTap` still formats amounts as `$` on the card-auto-sign path; flow 11 injects phase events only), the offline `markOfflinePaid` reducer still adds to the DEMO `offlineSpent` counter regardless of currency (the offline QR hand-off path's deduction is wrong for non-DEMO currencies — a known partial), unknown-asset rejection before signing, and currency-keyed offline state (MC5 remainder). The protocol can route ckBTC; the app now safely requests, reviews, validates, and presents it ONLINE end to end.
- **Current mitigation.** The canister routes ledgers independently and rejects cross-currency funding, so the settlement kernel does not silently swap. The ONLINE app payment path (request → scan → review → settle) is now multi-currency; the OFFLINE optimistic deduction path is still single-currency (documented partial).
- **Next step.** Implement the MC5 remainder: NFC asset disclosure + currency-keyed offline state + unknown-asset rejection. Make `NfcTap` currency-aware (display + balance gate). Add the resulting Ledger row's exact-units assertion post-settle, and a ckUSDC (currency 2, 6-decimal) end-to-end app flow.

### 7. (high) Runtime catalog foundation exists, but config-only asset addition is not safe

- **What/why.** M0 removed the original hardcoded deposit currency and shipped `currencies()`, but the descriptor is too weak for arbitrary assets. Token-specific facts are incorrectly attached to minter families, every `CkEthErc20` displays as USDC, unknown/`CkSol` families can fall back to BTC, and another ckERC20 still requires relay/app code. Registration is three non-atomic mutable writes and metadata is not validated against the ledger. The AsyncStorage cache is global rather than relay/network scoped and has no revision/TTL.
- **Current mitigation.** The live 0/1/2 catalog works for its narrow known configuration. It is a discovery foundation, not proof that adding a currency is config-only.
- **Next step.** ✅ **MC1 + MC2 COMPLETE (2026-08-02).** MC1 shipped richer asset/capability metadata + source-scoped versioned cache + strict validation via `familyDisplay()`. MC2 shipped immutable ID semantics (U2: insert-only ledger/minter), irreversible retire (U3), atomic validated activation (U4: `register_currency` strictly validates decimals/fee/symbol against the live ledger and inserts ledger+minter+meta in one update). An additional ckERC20 and a no-minter ICRC asset can now pass the same app/relay/canister conformance suite without code changes.

### 10. ✅ RESOLVED (2026-08-01) Wire/arity regressions ship to the device because no enforced gate exercises the real RN bridge

- **What/why.** The 2026-07-31 wire-format v2 wave grew `signAuthorization` (6→9 JS params) and the wire (196→292 B). `just verify` (core+canister+relay+e2e) stayed GREEN and shipped a release that **crashed on launch on a physical device** (`NativeArgumentsParseException: DpayCore.signAuthorization got 8 arguments, expected 11`). Three failures lined up: (a) the TS `signAuthorization`/`encodeRequest` name params were declared **optional** (`fromName?/toName?/memo?` in `app/lib/types.ts:40-41`), so `App.tsx:68`'s stale 6-arg call compiled; (b) **no `tsc` typecheck exists anywhere** (`app/package.json` has only eslint/jest; `justfile` has zero tsc refs; the e2e builds via Vite/esbuild which strips types without checking); (c) the e2e suite drives a JS **shim** (`e2e/web/dpay-core.ts`), not `libdpay_ffi.so` or the Kotlin `@ReactMethod` — `just app` (the ONLY gate exercising the real bridge) is not in `just verify` and was never re-run after wire-v2. A wrong JS→Kotlin argument count throws on the native-modules thread, bypassing the JS self-check's try/catch, so it is a hard process kill at startup, not a caught error. Separately, `App.tsx:69` had a hardcoded magic `392` (rotted from the pre-v2 wire hex; real value is `584`=292×2), and `signWithdrawal` has **no** Kotlin `@ReactMethod` (declared at `types.ts:48`, called at `WithdrawSheet.tsx:60`) → withdrawal is silently broken on Android (a pre-existing MC8 instance).
- **Current mitigation.** The launch crash is FIXED and verified on the physical device (see changelog below): `App.tsx` + `NfcTap.tsx` call sites pass the full 9 args. **Static hardening Layers 1, 2, 4, 5 are now SHIPPED** (2026-08-01) and enforced in `just check`/`verify`:
  - **L1 — strict types + typecheck gate (DONE).** `signAuthorization`/`encodeRequest` name params are now REQUIRED in `app/lib/types.ts`; `app/package.json` has `"typecheck": "tsc --noEmit"`; `just typecheck` runs in `check`. Arity drift is now a compile error in the ~2s offline inner loop.
  - **L2 — bridge-parity assertion (DONE).** `scripts/bridge-parity.mjs` parses `@ReactMethod` arity from both Kotlin modules and asserts it equals the `DpayCoreApi`/`DpayNfcApi` TS-interface arity (both directions); `just bridge-parity` runs in `check` (<1s). It also surfaced + closed a latent gap: `validate` was a `@ReactMethod` with no TS-interface declaration (now declared).
  - **L4 — magic-number-free self-check (DONE, static + runtime-confirmed).** `wire_len()`/`signing_len()`/`request_len()` exposed from the FFI; `App.tsx` derives `expectedHexLen = (await DpayCore.wireLen()) * 2` — the `584` literal is gone. Kotlin `wireLen`/`signingLen`/`requestLen` `@ReactMethod`s + the e2e shim's `wireLen` added. **Runtime-confirmed (2026-08-01, Wave B):** `just app` → `DPAY_SELFCHECK PASS` on the emulator drives `wireLen()` through the real `DpayCoreModule`→`libdpay_ffi.so` bridge (was previously proven statically + via the e2e shim only).
  - **L5 — `signWithdrawal` `@ReactMethod` (DONE, static + runtime-confirmed).** Added to `DpayCoreModule.kt`; withdrawal is no longer silently `undefined` on Android. L2 keeps it in parity automatically. **Runtime-confirmed (2026-08-01, Wave B):** `just app` → `DPAY_SELFCHECK PASS` exercises the full `DpayCoreModule` bridge surface; `signWithdrawal` is now in the runtime-confirmed set alongside `signAuthorization`/`wireLen`.
  - **L3 — emulator bridge gate + pre-merge checklist (DONE).** The gate (`just ondevice`, 8 instrumented tests driving the real UniFFI binding on the emulator) was **DEAD** — `scripts/android-ondevice.sh` hardcoded a stale cached `gradle-8.9-bin` lookup, but only gradle `8.8-all` + `8.12-all` are cached here, so the script failed at `set -euo pipefail` (exit 2) before ever running a test. **FIXED (2026-08-01):** the script now auto-selects the newest cached gradle distribution with an explicit `>= 8.9` floor check (AGP 8.7.3 requirement). With it alive it surfaced **2 pre-existing NFC instrumented failures** the dead gate had been hiding — both wire-v2 chunking rot, now fixed (see Wave B note below). `just ondevice` is **8/8 GREEN** and `just app` is **`DPAY_SELFCHECK PASS`**. The ops piece (the path-filtered pre-merge trigger) is the **`AGENTS.md` "Pre-merge gates off the hot verify path" checklist** — for any change touching `app/android/**`, `crates/dpay-ffi/**`, `app/lib/types.ts`, `app/services/**`, or the core wire consts, run `just app` (assert `DPAY_SELFCHECK PASS`) + `just ondevice` before merge. (In an offline autonomous inner-loop repo with no CI server, the documented agent checklist IS the gate.) All 5 layers now DONE; issue closed.
- **Next step (authoritative spec: `2026-08-01-device-bridge-parity-plan.md`).** Ship the 5 defense-in-depth layers, any one of which would have caught this crash:
  1. ✅ **DONE — Strict types + typecheck gate.** Required params + `just typecheck` in `check`.
  2. ✅ **DONE — Bridge-parity assertion.** `scripts/bridge-parity.mjs` + `just bridge-parity` in `check`.
  3. ✅ **DONE — Emulator bridge gate + pre-merge checklist.** `just ondevice` (8 instrumented tests) was **dead** due to a stale hardcoded gradle version in `scripts/android-ondevice.sh`; now fixed (auto-selects newest cached gradle with a `>=8.9` floor). With the gate running, 2 NFC instrumented tests with wire-v2 chunking rot were surfaced and fixed (see the Wave B note below); `just ondevice` is **8/8 GREEN** and `just app` is **`DPAY_SELFCHECK PASS`**, which re-confirms L4 (`wireLen` runtime) + L5 (`signWithdrawal` runtime) through the real bridge. The ops piece (path-filtered pre-merge trigger) is the **`AGENTS.md` "Pre-merge gates off the hot verify path" checklist** — run `just app` + `just ondevice` before merging any `app/android/**` / `crates/dpay-ffi/**` / `app/lib/types.ts` / `app/services/**` / core-wire-const change.
  4. ✅ **DONE — Magic-number-free self-check.** FFI `wire_len()`; `App.tsx` derives the hex length from `wireLen()` (no literal).
  5. ✅ **DONE — `signWithdrawal` `@ReactMethod`.** Added to `DpayCoreModule.kt`.

### Wave B note (2026-08-01) — emulator gate resurrected; 2 NFC wire-v2 failures root-caused + fixed

`just ondevice` had been **silently dead**: `scripts/android-ondevice.sh` hardcoded a lookup for a cached `gradle-8.9-bin` distribution, but only `gradle-8.8-all` + `gradle-8.12-all` are cached in this environment, so the script exited 2 at `set -euo pipefail` before running any test — the gate reported nothing and gave zero coverage. **Fixed:** the script now auto-selects the newest cached gradle with an explicit `>= 8.9` floor check (AGP 8.7.3 requirement).

With the gate alive it surfaced **2 pre-existing NFC instrumented-test failures** the dead gate had been hiding (both in `DpayNfcInstrumentedTest.kt`, a consequence of the 2026-07-31 wire-format v2 growth 196→292 B). Root cause of each (decided by RED-first host coverage, not assumption):

- **`phaseSequenceOnDevice` — STALE TEST (not a core bug).** It asserted one `reader.handleResponse(card.process(reader.nextCommand()))` yielded `DONE`, but a 292-byte wire at `DEFAULT_MAX_CHUNK=240` spans `⌈292/240⌉ = 2` frames, so the first pull returns `CONTINUE`. The host Python (`test_ffi.py` wire-pull loop) and core Rust (`phase_tracks_the_exchange`) already loop `CONTINUE→DONE`; the instrumented test was a stale single-command assumption. **Fix:** loop `CONTINUE→DONE` (host parity).
- **`signedWireSurvivesExchangeAndVerifies` — impossible test config (not a core bug).** It looped `mc ∈ {240, 1}`, but `mc=1` on a 292-byte wire needs 292 frames > `MAX_FRAMES=256` (the NFC frame `seq` is a single byte). **RED-first proof:** adding `mc=1` to the core `signed_wire_survives_nfc_and_verifies` test fails *identically* with `Frame(TooManyFrames)` at `provide_wire`; this is a correct, documented protocol limit (nfc.rs:1623), not a fixable core bug — widening it would require a frame-header format change (out of scope). **Fix:** aligned the instrumented chunk floor to `mc=2` (146 frames ≤ 256), matching the host Python `(MAX_CHUNK, 2)` and core `[240, 64, 7, 2]` floors; added an `mc=1 → TooManyFrames` rejection pin to BOTH host tests (core Rust + Python) so the boundary is now explicitly asserted rather than just commented, and replaced the instrumented test's hardcoded `292` with the FFI-exposed `wireLen()` (no magic numbers).

Gates (all GREEN): `just ondevice` 8/8; `just app` `DPAY_SELFCHECK PASS` (runtime-confirms L4 `wireLen` + L5 `signWithdrawal` through the real `NativeModules` bridge); `just test-core` 38/38; `crates/dpay-ffi/verify.sh` 65/65; `just verify` (core + canister + relay + typecheck + bridge-parity + e2e 28/28). **Remaining ops piece:** the path-filtered CI trigger that *runs* `just app`/`just ondevice` on bridge/wire/types changes (the gate code path itself is proven and green).

## Resolved this session (changelog)

The following previously-open risks are now **CLOSED** (see `CODEBASE_ANALYSIS.md` for detail):

- ✅ **Open `mint()` / admin surface** → closed (R1): admin ops denied when `controller == null`; self-service `faucet` (fixed amount, rate-limited) is the demo on-ramp; relay `Ledger::mint` removed.
- 🟡 **Unsigned receipt primitive** → signing shipped (R2), but signer authentication and durable recovery are reopened under MC4. The embedded receipt public key is not itself a trust anchor.
- ✅ **`pay()` cross-canister trap window** → closed/bounded (R3): admin-gated `icrc3` `reconcile(currency)` repairs trap-orphan debits; idempotent; PocketIC-proven.
- ✅ **ckBTC deposit unreachable in prod** → closed: the ckBTC minter call is now encoded as ONE record argument (was a 2-positional trap); proven LIVE — `GET /deposit/address?currency=1` returns a real `bc1...` address and the mint path is open (no KYC blocker; see issue 1).
- ✅ **minter-arg trap** → closed: facade encodes a single candid record arg to the ckBTC minter; mock aligned; an honesty-guard test fails if either reverts to the 2-tuple shape.
- ✅ **ckBTC card discoverability** → the wallet can fetch currency 1 and render a separate Bitcoin card; authoritative post-deposit display freshness is now resolved under MC3 (U1: facade `refresh_balance` + `refresh_deposit` inline cache refresh; U2: relay TTL-gated `Ledger::balance` — one authoritative refresh per 15s window, the rest hit the cached query).
- ✅ **e2e harness** → 15/15 flows driving the REAL app; relay isolated into `.dev/target-e2e` (clobber-proof) with a latent stale-binary build gate fixed (always invokes `cargo build`); parallel flow pool (~60s → ~13s, concurrency-safe, no assertions weakened). Old `ui/` parallel-component harness deleted.
- ✅ **NFC seam** → audited true: rides RNW's real `RCTDeviceEventEmitter` singleton (not a private registry).
- ✅ **Device launch crash (wire-v2 arity)** → FIXED + verified on a physical device (Redmi/POCO duchamp, arm64). Root cause: `signAuthorization` grew to 9 params in wire-v2 but `App.tsx:68` (self-check) and `NfcTap.tsx:186` (autoSign) still called with 6 → `NativeArgumentsParseException` killed the process on the native-modules thread before the JS self-check could catch it. Fix: both call sites pass the full 9 args (empty names where the NFC request event carries none); `App.tsx:69` literal corrected `392`→`584` (WIRE_LEN 292 × 2). Verified: `just app` → `DPAY_SELFCHECK PASS` in logcat, process alive, onboarding screen renders. The **structural gap** (no gate catches this) remains as issue 10 + the `2026-08-01-device-bridge-parity-plan.md` hardening plan.

## Resolved this wave (W2/W3/W4)

- ✅ **Withdrawal one-way valve** → closed (W2): the facade can now move ckBTC OUT to a native BTC address on a verified user Ed25519 signature (`withdraw` → `icrc2_approve` → minter `retrieve_btc_with_approval`; new `WithdrawAuth` wire type in dpay-core, `WITHDRAW_NONCES` MemoryId 12). Proven offline on PocketIC + the real app/relay/e2e (flow 15). Live real-money withdrawal is a documented follow-up (issue 8), not a blocker.
- ✅ **FakeLedger-vs-canister audit** → closed (W3): `FakeLedger.pay` now mirrors the canister's self-transfer + pay-to-mint-sentinel rejects (the two divergences found; both fixed + pinned by tests). The fee divergence is a documented accepted simplification (FakeLedger is the fee-less demo ledger).
- ✅ **Relay deploy-fidelity** → closed (W4): `build.rs` bakes the git commit; `GET /api/v1/version` exposes it; `just verify-relay` compares the live commit to HEAD (MATCH / BEHIND-N / MISMATCH). Feature-unconditional (in the prod image). The residual front-running risk of approve→retrieve is documented (issue 9 / risk 8) — inherent to ckBTC, not a dpay gap.

## Wire-format v2 (2026-07-31) — closed N6 + H3

- ✅ **N6 (counterparties as raw hex) → RESOLVED**, and ✅ **H3 (history hex) → RESOLVED**, by wire-format v2
  (commits b1c67fc…6bcc754). `from_name`/`to_name`/`memo` (32 B each, UTF-8 NUL-padded) were folded INTO the
  signed `Authorization::signing_bytes` (SIGNING_LEN 100→**196**); `to_name`/`memo` also ride the
  `PaymentRequest` (REQUEST_LEN 68→**132**); the wire is now WIRE_LEN=**292**. The signature binds the names
  so a relay/merchant can't swap them post-sign; they thread through the canister `TxnRecord` (196 B fixed) +
  relay `/history` so both wallets render friendly counterparties + memo instead of raw hex. The out-of-band
  `|name` QR suffix is deleted (the name is now in the request bytes — single source of truth). N6 was
  previously "deferred (core wire change)" and H3 "mitigated" via `short()` — that change has now shipped, so
  both are fully RESOLVED (not just mitigated). `short()` stays only as the empty-name fallback. Mint-sentinel
  history rows use empty names; the app special-cases `MINT_HEX`. `ReceiptClaim` (108 B) and `WithdrawAuth`
  are unchanged. Proven end-to-end by e2e flow `26-names-memo` (suite now 28/28 GREEN).

## UX review findings (2026-07-30)

> **Status (F-wave, commit bb315ba):** N2/N4/N5/N7/N8/N9/N10 + UX-V2/V3 are **FIXED** (SettingsSheet
> with reset-confirm; faucet moved off header + label/amount corrected + real cooldown surfaced; mint
> sentinel labeled "Demo funds"/"Withdrawal"; deposit error distinguishes no-minter vs transient;
> onboarding testID + Enter-to-create; header right-padding; paste-request affordance). N3 deploy
> blocker fixed (`scripts/dfx-deploy.sh` sets controller before `register_ledger`). **Deferred:** N1
> (FakeLedger has no rate-limit — accepted simplification; real cooldown is surfaced in the UI); ~~N6
> (counterparties are raw hex — needs the username carried in the signed payload, overlaps with a core
> wire change)~~ ✅ **N6 RESOLVED 2026-07-31 (wire-format v2)** — names + memo now ride the signed
> `Authorization` + canister `TxnRecord` + relay history (see N6/H3 below); UX-V5 full single-key
> shortcuts (only Enter-to-create shipped; polish). ✅ **UX-V5
> FIXED (1b):** full keyboard surface shipped — `useHotkeys` (single source of truth; `useEscapeToClose`
> delegates to it) wires P=Pay / R=Receive / T=Top-up / A=Add money on the Wallet main view (input +
> sheet-open guarded; web-only), with always-visible-but-subtle on-UI hint badges on each target.
>
> From a NO-MOCK UX review: the REAL web app (`app/App.tsx`, react-native-web) driven through
> chrome-cli against the REAL canister (facade + ic-icrc1-ledger on a local dfx/PocketIC replica) via
> the relay's `AgentLedger` (`--features agent`). Every money path (onboard/faucet, two-wallet
> Pay→settle→Receive, history, offline, reset) ran against the real ledger — only the camera scan is
> shimmed (the sanctioned smallest-boundary seam; decode/sign/verify/settle are all real). Screenshots
> in `e2e/shots/` + this session's `/tmp/ux/`. The e2e harness uses `FakeLedger`, which **masks** two
> of the divergences below (N1/N2) — those are invisible to `just e2e`.

### CONFIRMED already-known seed items (from `2026-07-30-ux-e2e-radical.md`)
- **UX-V2 CONFIRMED** — a `LEDGER` settings bar (the `settings-relay` TextInput seeded with the relay
  URL, e.g. `http://127.0.0.1:8787`) + a bare red `reset` link sit on the MAIN wallet screen. Dev-facing.
- **UX-V3 CONFIRMED** — `reset` wipes the on-device identity with **NO confirmation**: one tap →
  `AsyncStorage.removeItem` → straight back to onboarding (verified: identity gone, onboarding shown,
  no dialog). A user loses access to the funds at that pubkey irreversibly.
- **UX-V4 CONFIRMED → ✅ RESOLVED (2026-08-01)** — the crowded header (`$balance` + `+$50` outline pill +
  filled `＋ Add money` sharing one right-aligned row, Add-money edge viewport-kissing at 389/390 px) is gone.
  The main-screen `Add money` button + asset rail are removed; the header now shows ONE current-currency
  balance (tap → Balances sheet to switch currency / fund / cash out). Funding consolidated into the
  Balances sheet. Also closes N9 (Add-money glow clip — the button no longer exists).
  share one right-aligned row; the `Add money` right edge lands at 389/390 px (viewport-kissing).
- **UX-V5 CONFIRMED → ✅ FIXED (1b)** — only `Escape` was wired (`useEscapeToClose`, sheets only); no
  global shortcuts (no Enter-to-submit on onboarding/amount, no T/A/R action keys), and the only
  on-UI hint was "Press Esc to close" inside the deposit/withdraw sheets. **Now resolved:** the
  wallet is fully keyboard-driveable (P/R/T/A + Esc) via `useHotkeys`, with on-UI hint badges.
  *(2026-08-01: **A** now opens the Balances sheet — the sole funding/balance surface — instead of the
  old asset-picker/Add-money; see UX-V4.)*
- **UX-V1 REJECTED** — the `＋ Add money` button text is **NOT truncated** at standard balances
  (`scrollWidth == clientWidth == 111`; full "＋ Add money" renders). The original "+ Add mo" claim is
  not reproducible. Reframed as the edge-kissing/glow-clip issue N9 (P3).

### NEW findings
- **N1 (high) | functional | wallet header | The `+$50` faucet top-up button is BROKEN against the real
  canister for ~1 hour after onboarding.** Onboarding consumes the canister faucet's once-per-hour
  slot (`FAUCET_COOLDOWN_SECS = 3600`); the `+$50` button calls `/api/v1/faucet` again and the canister
  rejects it (`"faucet cooldown: try again in ~58 min"` → 422). The app then shows "Faucet unavailable"
  and the balance is unchanged. Reproduced live. The e2e harness (`FakeLedger`) has **no rate limit**,
  so flow 02-faucet passes while the real path fails — a false-confidence divergence.
  *Fix:* surface the cooldown (the canister already returns the retry time) and either disable the
  button while cooling down, or make the demo top-up a separate non-rate-limited path. Reconcile
  FakeLedger's faucet with the canister's (rate-limit + fixed-amount) so e2e catches this.
- **N2 (medium) | functional | wallet header | The `+$50` button would mint `$100`, not `$50`, even when
  it works.** The canister `faucet(blob, nat32)` has **no amount parameter** and mints the fixed
  `FAUCET_AMOUNT` ($100); `AgentLedger::faucet` takes `_amount` and discards it. `FakeLedger` honors the
  requested 5000 ($50). So the button's label is wrong against the real ledger.
  *Fix:* either let the canister faucet honor a capped requested amount, or relabel the button to the
  fixed amount and stop sending `amount`.
- **N3 (high) | functional/deploy | canister | `register_ledger` is DENIED in open-demo mode
  (`controller == null`)**, returning `"admin ops disabled: no controller set"`. This **breaks the
  documented `scripts/dfx-deploy.sh`**, which installs the facade with `ledgers = vec {}` then relies on
  an open `register_ledger` call. It also contradicts `CODEBASE_ANALYSIS.md` and the `.did` comment
  ("open only when controller is unset, i.e. the demo") — R1 actually locks down ALL admin ops when the
  controller is null. Verified live (register_ledger → Err until a controller was set via `set_controller`).
  *Fix:* either seed the ledger at `init` (correct for `dfx-deploy.sh`), or fix `dfx-deploy.sh`/docs to
  set a controller first. Correct the `.did` + `CODEBASE_ANALYSIS.md` comments.
- **N4 (medium) | visual | history + receipt | The faucet mint surfaces as a transaction `from ffffffff…`
  (the raw `MINT_ACCOUNT` 0xFF sentinel).** Internal protocol data leaks to end users as a
  counterparty. *Fix:* label mint/burn rows as "Faucet"/"Demo funds" (or hide them) instead of the hex
  sentinel.
- **N5 (medium) | flow | wallet header | "Faucet unavailable" discards the helpful reason.** The canister
  returns `"faucet cooldown: try again in ~58 min"`; the app maps any non-OK to the generic "Faucet
  unavailable" (App.tsx `topUp`). The user gets no clue why or when to retry. *Fix:* surface the relay's
  error body (or parse "cooldown … ~N min").
- **N6 (medium) | flow/a11y | pay/receive success + history | Counterparties are shown as raw truncated
  hex pubkeys** ("from d082b3af…", "to d7011269…"). The request QR carried the username out-of-band,
  but the *signed payload* only carried the from-pubkey, so the merchant/recipient never learned the
  payer's name (Alice saw "Received $25.00 from d082b3af…" for Bob). ✅ **RESOLVED (2026-07-31,
  wire-format v2)** — `from_name`/`to_name`/`memo` (32 B each, UTF-8 NUL-padded) now live INSIDE the
  signed `Authorization::signing_bytes`; `to_name`/`memo` ride the `PaymentRequest`. The signature
  binds them (a relay/merchant cannot swap a name post-sign), and they thread through the canister
  `TxnRecord` + relay history so both sides render friendly counterparties. The old out-of-band
  `|name` QR suffix is deleted (name is now in the request bytes — single source of truth). Proven
  end-to-end by flow `26-names-memo`.
- **N7 (low) | flow | deposit sheet | The deposit error misleads.** With no ck-minter registered for
  currency 1, the sheet shows "Could not reach the ledger for a deposit address / Check the relay is
  reachable, then reopen the sheet" — but the real cause is "currency 1 has no ck minter" (a deploy
  invariant), not relay reachability. *Fix:* distinguish 503-transient from "no minter" and message it.
- **N8 (low) | flow | onboarding | Empty username defaults to "me".** A generic placeholder identity;
  the plan already flagged "username default" as a harness/UX gap. The username `TextInput` also has no
  `testID` (only a placeholder), so it is harder to target for a11y/harness. *Fix:* require a name or
  pick a less generic default; add a testID.
- **N9 (low) | visual | wallet header | The `＋ Add money` button's drop shadow/glow is clipped at the
  viewport right edge** (right edge 389/390 px; `shadowRadius: 12` overflows). Reads as cramped.
  *Fix:* give the header row right padding / move `Add money` out of the balance row.
- **N10 (low) | flow | pay screen | No manual "paste request" fallback.** The payer can ONLY acquire a
  request via the camera (or NFC). On web/desktop (and when a camera is absent/unreliable) there is no
  paste-a-request-string path, so Pay is unreachable without a working camera. *Fix:* add a "Paste
  request" affordance (the decode path already accepts a string).

## Onramp/offramp + multi-currency findings (2026-07-30)

> From two orchestrated investigation subagents. Full plan + citations: `2026-07-30-ckusdc-onramp-offramp.md`.
> **Linchpin:** ckUSDC is NOT a ckBTC-style chain-key token — it is a ckERC-20 handled by the **ckETH
> minter** (`sv3dd-oaaaa-aaaar-qacoa-cai`) via an Ethereum helper-contract deposit + heartbeat log
> scraping. The existing ckBTC deposit/withdraw proxy does NOT generalize. There are ≥3 ck-minter
> families (UTXO-minter=ckBTC; ckETH/ckERC20=ckUSDC; ckSOL). The ICRC ledger layer (balance/pay/history)
> already works for ckUSDC with a `register_ledger` call — only the *ramp* is ckBTC-shaped.

- **O1 (high) | architecture | canister/relay/app | The deposit+withdraw ramp is hard-wired to the
  ckBTC minter family.** ✅ **RESOLVED for onramp (M0+M2)** — `MinterFamily` is now the per-family
  dispatch key (canister `currencies()` + `register_currency_meta`, M0); the ckUSDC onramp is built
  CLIENT-SIDE (no canister ramp dispatch needed — the onramp bypasses the canister: the user does 2 ETH
  txs, the mint lands at `Account{owner:facade, subaccount:pubkey}`, dpay just polls the ledger balance).
  Shipped: `app/cketh.ts` byte-exact calldata builder, `app/wallet.ts` EIP-1193 seam, `CkErc20DepositSheet`
  wallet-connect flow (connect→approve→deposit→watch), relay `GET /api/v1/onramp/ckerc20`, ckUSDC registered
  on mainnet. The ckERC20 **offramp** (canister `withdraw_erc20` dual-ledger dispatch) is NOT built —
  deferred per Fork-C (no ckETH gas source; offramp via third-party, never dpay). So the onramp is
  multi-family; the direct offramp remains ckBTC-only.
- **O2 (high) | architecture | core wire | `WithdrawAuth` binds a BTC-address field** ✅ **RESOLVED (M3,
  commit 4a98c89)** — renamed `WithdrawAuth.btc_address` → `destination` across 14 files. **Wire-safe**:
  `signing_bytes()` was already chain-agnostic (the address is a u32-length-prefixed UTF-8 string — the
  field NAME never touched the bytes). Proven: the regenerated `wire_layout.json` withdraw.golden
  `signing_hex`/`sig_hex` are byte-identical before/after. The signed-withdrawal now reads as chain-agnostic
  without a FROZEN-wire version bump.
- **O3 (high) | dependency | ckUSDC offramp | The user MUST hold ckETH to pay Ethereum gas** 🟡 **DEFERRED
  (Fork-C)** — the ckERC20 direct offramp (`withdraw_erc20`, dual-ledger approve) is NOT built. Per the
  locked founder decision, gas is provided via a THIRD-PARTY (user authorizes a 3rd-party ckUSDC→ckETH
  conversion directly; dpay is a screen only — preserves no-swap). The ckUSDC asset card has NO cash-out
  button (honest deferral); ckBTC cash-out works (with saved-address reuse, M3).
- **O4 (medium) | risk | ckERC20 offramp front-running (extends #9/risk 8)** 🟡 **DEFERRED** — applies
  only when the ckERC20 offramp lands (see O3). The dual-approve + partial-failure (`CkErc20LedgerError`
  after `CkEthLedgerError` → reimbursement) residual is documented; inherent to the ckETH minter, not
  dpay-specific.
- **O5 (high) | UX/config | single-sourcing** — 🟡 **FOUNDATION SHIPPED, REOPENED by MC1/MC2.**
  Canister `currencies()` + relay `GET /api/v1/currencies` + app runtime catalog shipped and
  `DEPOSIT_CURRENCY` was deleted. The audit found that metadata, activation, cache scoping, and
  token-specific ramp dispatch are still insufficient for config-only asset addition; see issue 7.
- **O6 (low) | verification | live ckUSDC params** — ✅ **VERIFIED 2026-07-31** via mainnet query
  (`dfx canister --network ic call sv3dd-oaaaa-aaaar-qacoa-cai get_minter_info`) + authoritative source
  (`dfinity/ic` `DepositHelperWithSubaccount.sol`, `templates/principal_to_bytes.js`, `tests/principal_to_bytes_test.js`).
  Findings (all to be READ AT RUNTIME via `get_minter_info`, never hardcoded):
  - `deposit_with_subaccount_helper_contract_address` = `0x18901044688D3756C35Ed2b36D93e6a5B8e00E68` ✓
  - `minimum_withdrawal_amount` = `5_000_000_000_000_000` (5e15 wei; minter-wide gas floor, shared by ckETH+ckERC20)
  - ckUSDC in `supported_ckerc20_tokens`: ERC-20 `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, ledger
    `xevnm-gaaaa-aaaar-qafnq-cai`, symbol `ckUSDC` ✓. **11 ckERC20 tokens live**: ckUSDC, ckUSDT, ckEURC,
    ckWBTC, ckLINK, ckUNI, ckWSTETH, ckPEPE, ckOCT, ckSHIB, ckXAUT.
  - ckUSDC ledger: `icrc1_symbol`="ckUSDC", `icrc1_decimals`=6, `icrc1_fee`=10_000 (0.01 USDC),
    `icrc1_name`="ckUSDC" ✓.
  - `minter_address`=`0xb25eA1D493B49a1DeD42aC5B1208cC618f9A9B80`, `cketh_ledger_id`=`ss2fx-dyaaa-aaaar-qacoq-cai`,
    `evm_rpc_id`=`7hfb6-caaaa-aaaar-qadga-cai`.
  - **`depositErc20` ABI (LIVE helper `CkDeposit`):** `depositErc20(address erc20Address, uint256 amount,
    bytes32 principal, bytes32 subaccount)` — **first arg is the ERC-20 contract address, NOT a token_id**
    (corrects the investigation's "token_id" framing). Emits `ReceivedEthOrErc20(erc20Addr indexed, owner
    indexed, amount, principal indexed, bytes32 subaccount)`; calls `erc20.safeTransferFrom(msg.sender,
    minterAddress, amount)` so user must `approve(helper, amount)` on the ERC-20 first.
  - **principal→bytes32 encoding (authoritative):** base32-decode (incl 4-byte CRC32 prefix) → `slice(4)`
    strips CRC → length-prefix into 32 bytes: `[1-byte N=len][N principal-bytes][31-N zero pad]`. Golden
    vectors: `k2t6j-...-6ae`→`0x1db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c020000`;
    `opspt-...-vqe`→`0x1dca62f9ef706b80db8a5293779a08cbe067e69206ac4eee9d27931d2b020000`;
    `2chl6-4hpzw-vqaaa-aaaaa-c`→`0x09efcdab00000000000100000000000000000000000000000000000000000000`.
  - **No pending-deposit IC query exists** — `get_minter_info` has no per-account pending field; minting is
    heartbeat-scraped (~3min). The ONLY onramp signal is the ckUSDC ledger balance growing. (Answers Q3.)
- **🚩 Founder decisions (plan §6 Q1–Q6,14):** direct-vs-partner sequencing at launch; partner aggregator
  choice + mode; KYC-surfacing posture; ckUSDC chains at launch (Ethereum only?); ramp fees = partner's
  only (zero dpay cut); keep the demo faucet once real ckUSDC exists; wrong-network recourse messaging.

## Prior UX audit (2026-07-31) — historical closure record

> Source: `UX_AUDIT_FINDINGS.md` (code-review + zai-vision visual audit). All 23 issues addressed;
> independent verifier confirmed 21 fully resolved + 2 mitigated. Visual re-audit (zai-vision on live
> screenshots) confirmed no regressions. Suite reached 28/28 GREEN. The 2026-08-01 installed-app review
> supersedes this as the current product direction via MC5-MC7; in particular, making Paste request more
> prominent is no longer desired, and inline history/settings placement must be redesigned.

**Critical (3) — RESOLVED:**
- ✅ C1: Approve button disabled on expired request (error moved above button; greyed out).
- ✅ C2: Approve button disabled on insufficient balance (online gate; warning above button).
- ✅ C3: Deposit fee/min shows "—" instead of "0.00000000" when zero (FakeLedger returns 0).

**High (5) — RESOLVED:**
- ✅ H1: ckUSDC labeled by its symbol ("ckUSDC"), not the chain ("Ethereum"). `displayName()` in catalog.ts.
- ✅ H2: Transaction history fans out per catalog currency (was hardcoded currency=0).
- ✅ H3: Counterparties show `short(pubkey)` (8 hex chars), not a 64-char dump. ✅ **NOW FULLY RESOLVED
  (2026-07-31, wire-format v2)** — names (`from_name`/`to_name`) + `memo` are now in the signed
  `Authorization::signing_bytes` and threaded through canister `TxnRecord` + relay history, so the app
  renders friendly counterparties ("from Alice" / "to Bob") directly. `short()` remains only as the
  fallback when a name is empty (e.g. a row whose counterparty never set one). Closes N6/H3 together;
  proven by flow `26-names-memo`.
- ✅ H4: Header shows username only (hex removed; testID `header-who`).
- ✅ H5: Deposit errors use plain language (transient vs no-minter, no "relay" jargon).

**Medium (9) — RESOLVED:**
- ✅ M1: ARIA roles/labels on all interactive Pressables (accessibilityRole + accessibilityLabel + state).
- ✅ M2: All touch targets ≥ 44pt (minHeight:44 on interactive style keys).
- ✅ M3: Keyboard hint badges redesigned (24×24 bordered box, 14px text — visible + legible).
- ✅ M4: "Press Esc to close" gated behind `Platform.OS === 'web'` in all sheets.
- ✅ M5: Responsive at desktop width (maxWidth:480 + screenFrame centering).
- ✅ M6: Empty username defaults to 'me' (was "Name"); testID added.
- ✅ M7: Onboarding subtext is user-benefit ("Creates your wallet and adds $100 in demo funds").
- ✅ M8: ckUSDC deposit sheet shows ETH gas-fee warning.
- ✅ M9: ckUSDC processing state simplified (single "Waiting for confirmation — ~20min", no jargon).

**Low (6) — RESOLVED:**
- ✅ L1: Add-money shadow no longer clipped (shadowRadius 12→8).
- ↩ L2: "Paste request" received a proper touch target in this wave, but MC7 now removes it from the primary Pay surface or demotes it to a subordinate scanner fallback.
- ✅ L3: Withdraw success has a Copy-destination button + selectable address.
- ✅ L4: "Payer paid offline? Scan to settle." (was ambiguous; shortened 2026-08-01 for simplicity).
- ✅ L5: Raw hex request nonce removed from review screen.
- ✅ L6: Payment confirmation shows recipient name ("to Bob"), not "merchant". (Receive-side name = H3/N6.)
