# OPEN_ISSUES — the authoritative open list

> Role: known blockers + documented follow-ups. Read top-down; work order first.
> **Pruned 2026-08-27** (2,345 → this): every completed session record / resolved bug was
> removed — nothing was closed by the prune itself, only re-filed or dropped as stale-duplicate.
> Full history: `git log --follow -p OPEN_ISSUES.md` (last pre-prune state at `ad65174`).

## NEXT SESSION — work order (unblocked; do these first)

1. ~~**Add VCHF + native ICP as complete direct-payment assets.**~~ **DONE (2026-08-28)** —
   [`docs/specs/2026-08-28-vchf-icp-support-spec.md`](docs/specs/2026-08-28-vchf-icp-support-spec.md)
   U1–U8 complete and fully verified: catalog ids 7/8 everywhere (bundled + fake + truth-file drift
   alarms), no-minter direct-ICRC payability, the relay's `Internet Computer` mainnet partition, an
   official-ICP-index history adapter (`just ic-index-probe` PASS vs mainnet), idempotent
   registration rehearsed on a full local replica (registry-era — superseded same-day by the
   2026-08-28 founder decision removing the canister registry; catalog authority is now the
   relay's compiled catalog, see the spec addendum), 7 new e2e flows (95–101; `FLOWS.md` = 97),
   `just verify` EXIT=0 (96/96 e2e), jest 1160/1160, `just test-relay` 44/44, `just test-live`
   62/62, emulator device gates green, orchestrator-verifier state-matrix audit APPROVED. Two
   founder tails remain open (moved to "Physical / outer-loop gates" below): the deploy (now
   `just apk && just up` — the relay ships the catalog; the facade wasm upgrade is optional and
   carries no registration) + funded mainnet transfer proof. ICPSwap buy/sell stays a separate
   future phase; no automatic conversion.
2. **Faucet 422 — OPEN-VERIFY, likely already shipped.** Fix landed in-tree 2026-08-20
   (`6465405`, + `scripts/faucet-verify.sh` + deploy-ic arming; local replica drill passed all
   legs incl. a live-relay 200 mint). The 2026-08-26/27 founder deploys almost certainly armed the
   dedicated-key prod cell, but **no recorded `just faucet-verify --mint` PASS exists** — run it
   once against prod, record the result here, close. (docs/GOVERNANCE.md still says "🔄 in
   flight (2026-08-20 session)" — update it when this closes.)
3. **Governance P1/P2 pieces (agent-pickable; the stance itself is DO-NOT-NAG below):**
   module-hash pinning, reconcile runbook wiring (###3's menu). (`lock_catalog` struck
   2026-08-28 — the registry it targeted was removed by founder decision; catalog authority =
   relay code behind git review + drift alarms, re-addable at a future governance handoff.)
4. **IC chain-key receipt migration** (###2 next step): move the receipt signature to
   `sign_with_schnorr`/`sign_with_ecdsa` before pilot so no exportable secret lives in canister
   state (the AGENTS.md-known "chain-key receipts" blocker).
5. **Reconcile heartbeat + paging** (###5 deferral): bounded walk exists; add the deferred
   periodic heartbeat + pagination on top.
6. **SOL v2 follow-ups (low):** source-ATA auto-create for USDC offline pay; stronger
   `getTransaction` receipt verify. Audit flow 76 (`sol-usdc-ata-gate`) first — it may partially
   cover the first item. (Was written as "flow 62"; there is no flow 62 — the id range has a gap
   at 62 and the ATA flow is 76.)

## Physical / outer-loop gates (NOT autonomous)

- **Android App Link verification — needs the prod relay deploy** (payment links, 2026-08-29).
  Everything in the chain is proven in-sandbox EXCEPT the one step that requires the live domain:
  the manifest's `autoVerify` filter is live (Android lists `dpay.kalaj.org` for `org.kalaj.dpay`),
  the relay serves `/.well-known/assetlinks.json` with all four project certificates, and the
  emulator's installed APK is signed by one of them (`1E:5C:F5:10:…`, the upload key). But the
  verifier could not fetch the file — `pm get-app-links` shows no successful verification and a
  tapped link opened Chrome, because prod does not serve assetlinks.json until the next `just up`.
  **After deploying, run on a phone:** `adb shell pm verify-app-links --re-verify org.kalaj.dpay`
  then `adb shell pm get-app-links org.kalaj.dpay` and expect `dpay.kalaj.org: verified`; tapping a
  `https://dpay.kalaj.org/wallet/pay/…` link must then open the app, not a browser. Until that is
  recorded, a shared link is web-only on real installs (it still opens the web wallet, which is the
  designed fallback — no user-facing breakage, just no native hand-off).
- **SOL HCE hardware tap — the only physical gate left** (AID `F06470617902`, `DpaySolNfc`).
  The IC-rail two-phone NFC tap (payer in airplane mode) + real-camera QR scan PASSED 2026-08-26
  (founder-run retest; commit `8940b1d`).
- **VCHF/ICP go-live — founder relay + APK deploy** (`just apk && just up`; the facade wasm
  upgrade via `just deploy-ic` is optional — since the 2026-08-28 registry removal there is NO
  registration step and no catalog on the canister): the relay's compiled catalog
  (`crates/dpay-relay/src/catalog.rs`) ships ids 7/8 to online wallets with the next `just up`;
  the APK carries the bundled offline rows. The relay change is built + fully gated in-tree but
  NOT yet deployed. Pre-deploy state confirmed 2026-08-28: `just verify-relay` = live `81e39b4`
  ABOVE floor `28cc375`, BEHIND HEAD by exactly 1 commit (`671caad`, ships with this deploy);
  live ledgers verified (`ly36x` VCHF / `ryjl3` ICP: symbol, decimals 8, fee 10_000; index
  `qhbym` `ledger_id == ryjl3`). Afterward re-check: `curl -s
  https://dpay.kalaj.org/api/v1/currencies` shows the `Internet Computer` mainnet rows.
- **VCHF/ICP funded mainnet payment proof** — low-value app-signed VCHF + ICP mainnet transfers +
  receiver exact-memo reconciliation. **BLOCKED on mainnet funds (hard external gate)**; production
  payment completeness is not claimed for these assets until recorded.
- **ckBTC live mainnet deposit→mint + withdrawal with real BTC** (old ###1/###8, low — final
  pre-pilot confidence checks after the testnet proofs).
- **ckUSDC live Sepolia withdraw proof** (needs funded ckUSDC + ckETH gas; PocketIC already
  proves the dual-ledger flow).
- **WalletConnect live pairing** (real wallet + 2nd device over the online WC relay). Contract
  pinned offline (jest 13 cases); outer-loop sign-off only, NOT a blocker.
- **Tier-2 full Testnet4 mint** — externally blocked (faucet captcha + cycle-starved minter);
  optional, proves DFINITY infra, low dpay value.
- **Play launch ops** (old ###11/###12): pre-launch report + `just play-upload` (upload-key AAB
  + staged `mapping.txt` ready). First upload sanity-checks the store-listed size vs baselines
  (APK 93,728,358 B / AAB 39,649,424 B; pre-WC 87,540,415 / 36,233,482).

## FOUNDER-OWNED (DO NOT NAG)

- **CF edge still serves the stale APK on the BARE url** `https://dpay.kalaj.org/download/dpay.apk`
  (value 7 / effort S): the cached object predates the max-age=300 fix and carries
  `immutable, max-age=31536000` — the edge won't refetch for ~1 yr. Relay-side fix is live (new
  objects revalidate ≤5 min via ETag/304; the landing Download button links the `?v=<sha256>`
  URL, verified fresh). Remaining step needs a permission the repo's CF token lacks (Tunnel+DNS
  only): **purge the cached APK** — dashboard → Caching → Purge Everything (or by URL), or create
  a token with *Zone · Cache Purge* exported as `CF_PURGE_TOKEN` so `just up` purges
  automatically. (`/shots/*.png` self-healed — plain 4h TTL, no `immutable`; only the APK is
  purge-required.)
- **Governance stance (founder-set):** govern in place, no NNS/SNS hand-off until critical mass —
  see docs/GOVERNANCE.md. `ADMIN_CALLERS` allowlist (old ###4) is accepted under this plan.
- **Gatekeeper RPC URL** (`beta.helius-rpc.com`) — NO config slot exists anywhere in the
  codebase; awaiting founder clarification on its purpose (2026-08-09 note — may be stale,
  confirm-or-drop).
- **Onramp founder launch decisions** (onramp plan §6 Q1–Q6,14): direct-vs-partner sequencing,
  partner aggregator, KYC posture, ckUSDC chains at launch, ramp fees partner-only, faucet
  retention once real ckUSDC exists, wrong-network recourse messaging (2026-07-30, pre-cutover —
  several may be stale; confirm-or-drop).
- **Desktop-width /wallet design pass** (value 5, effort M-L — design-level, needs founder input).

## Other open issues

- ~~**Rail/surface asymmetries surfaced by the 2026-08-30 send-to-address audit**~~ **ALL FIXED
  2026-08-30.** (a) Solana transaction history now exists (`app/solana/history.ts` +
  `useSolanaHistory`, merged into the Transactions tab, which is now keyed on `AssetId` rather than
  an IC currency id — flow 108); (b) a confirmed send/withdraw awards `paymentTested` on both rails,
  never on an unknown outcome; (c) the IC fund funnel records its origin and offers the
  "Back to paying X" resume once the balance goes positive (flow 81); (d) `NfcStatusRow` is shared
  by both Pay screens and SolPayMode takes the 4-state `NfcStatus`; (e) the sub-mode toggle no
  longer renders mid-payment on either rail; (f) ckERC20 deposits got the manual recheck the other
  three sheets had (flow 33). `SelectableAsset.capabilities` and `SolanaAsset.onramp/offramp` were
  dead ramp copies and are deleted; `CurrencyDescriptor.onramp/offramp` stays (the IC fund gate
  reads it).
- **(low) Solana history is unit-proven, not cluster-proven.** `fetchSolanaHistory` is asserted
  against stubbed RPC responses shaped from the JSON-RPC spec; it has never run against a live
  cluster. Its balance-delta reading of direction/amount, the v0 `loadedAddresses` account
  indexing, and the USDC-row/SOL-fee-row suppression are the parts a real transaction would test.
- **(low) `SolanaHistory.dropped` is logged, not surfaced.** A transaction the reader cannot parse
  is counted and warned, so a short list is never silently short — but the user is not told. Needs
  copy in 4 locales before it can be shown.
- **(medium) Withdrawal approve→retrieve front-running residual** (old ###9) — includes the
  inherent dual-approve partial-failure class (old O4); documented mitigation in place.
- **WC per-`request()` unbounded** (`app/wallet.ts`) — inherent to EIP-1193 (no standard timeout
  param); pairing bounded at 5 min.
- **Harness residuals (2026-08-20 harness-debt pass):** the e2e suite rides the relay's
  test-helpers-only `GET /api/v1/balance/{hex}` route (30+ flows) — deleting that route requires
  migrating the harness to `/balances` or the gateway first; flow-41 timeout is 30 s authored;
  `goOffline` kills the IC gateway too (flows 20 + stage-landing-shots use `{keepGateway:true}`);
  MIUI physical device blocks test-APK installs (`just ondevice` stays emulator-only).
- **Deploy-script candid-literal drift (ops-only):** `dfx-deploy.sh`'s ICRC Init args literal is
  not factored the way staging's is (3 genuinely incompatible per-script strategies; bash
  literals can't be cross-checked offline without a fragile grep). Both scripts byte-faithful
  today; low priority, no runtime impact.
- **FakeLedger has no rate-limit** (N1) — accepted simplification; the real cooldown is surfaced
  in the UI.
- **Helius API key baked as a literal** — rate-limit key, not a fund key (non-custodial, device
  key signs). Rotate if the repo ever goes public.
- **Canister-side `refresh_deposit` rate-gate NOT implemented** — deliberate: the relay is the
  only ingress path (relay-side TTL cache suffices); revisit only if the canister is ever called
  directly.
- **Receipt-poll 404 console lines** — cosmetic, by-design not-yet-settled poll
  (`GET /api/v1/receipt/<nonce>`; Chrome auto-logs non-2xx). Invisible to users.
- **History names stay PRINCIPAL-prefix by design** post-cutover (ledger memo is the frozen
  16-byte nonce reconciliation key — extending it was REJECTED); a signed name registry is a
  founder follow-up, NOT in-tree.
- **Default-tab/first-impression** — the walkthrough shapes the first run; the post-onboarding
  landing on the Pay scanner remains the intended default (flow 90 pins
  `pay-tab-default-landing`). Deliberate, not an oversight.
- **SOL glyph `◎` relies on system font fallback** (U+25CE absent from every bundled font —
  fontTools cmap-verified; renders acceptably on MIUI/Android today). If a device ever shows a
  fallback artifact, swap to an in-font covered glyph (`○`/`●` basics covered; `Δ Ω`
  grotesk-only). Low, visual-only.
- **Campaign line is dual-sourced** — `app/config/education.ts` + the `landing.html` literal,
  pinned byte-identical by relay test `landing_page_tells_the_offline_payment_story`; edit both
  together.

## Documented decisions / tripwires

- **ckETH `eip_1559_transaction_price` — no code change.** The app path is functionally correct
  against prod (same estimate the semantically-pure `None` call returns). Sending `None` would
  need a frozen-ABI FFI change or a JS-side DIDL byte constant — both cost more than they buy.
  The probe test is the regression tripwire: if the minter ever starts rejecting unregistered
  ledgers (the assert-printed `MEASURED:` line flips), flip `fetchGasFeeWei`'s native call site
  to the `None` arg. Launch check: a native-ETH withdrawal failing on prod with a minter reject
  mentioning `eip_1559_transaction_price` → look here first.
- **Live ckUSDC onramp params (O6)** — always READ AT RUNTIME via `get_minter_info`, never
  hardcode (verified live 2026-07-31; the full param table lives in this file's git history at
  `ad65174`).

## Severity legend

- **HARD blocker** — blocks a specific path until an *external* step lands; cannot be fixed in
  code in this repo.
- **high** — should land before pilot.
- **medium** — production/scale tradeoff; defer with the documented mitigation in place.
- **low** — polish / config invariant.
