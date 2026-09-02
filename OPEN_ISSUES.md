# OPEN_ISSUES — the authoritative open list

> Role: known blockers + documented follow-ups. Read top-down; work order first.
> **Pruned 2026-08-27** (2,345 → this): every completed session record / resolved bug was
> removed — nothing was closed by the prune itself, only re-filed or dropped as stale-duplicate.
> Full history: `git log --follow -p OPEN_ISSUES.md` (last pre-prune state at `ad65174`).

## NEXT SESSION — work order (unblocked; do these first)

0. **THE NEXT MILESTONE — dpay as the MERCHANT side of OpenCryptoPay** (founder decision,
   2026-09-02). Plan, rejected alternatives and open questions:
   [`docs/specs/2026-09-02-merchant-side-plan.md`](docs/specs/2026-09-02-merchant-side-plan.md).
   Two operational tails from the same session, both founder ops, neither blocking the milestone:
   - **PROD SERVES A BUILD THAT CANNOT PAY ANY TILL.** `/download/dpay.apk` and the relay are at
     `7499b30`, before the parser fix (`8912db5`) that made real tills payable at all. Needs
     `just apk && just up`.
   - **The CHF 1 live payment is still unmade** — the one leg no read-only probe can close
     (`just live-ocp` proves everything up to consent). Founder go-ahead required: it is a first
     payment to a new counterparty. Rules: `CLAUDE.md` → `docs/AGENT-FUNDS.md`. To make it: display
     `artifacts/spar-test-till-qr.png` (the provider's public CHF-1 test till, generated from the
     LNURL in the findings doc) and scan it from a funded wallet. Verify it afterwards with
     `just agent-history`, which shows the outgoing transfer and the block index the wallet
     reported — the payment is checked against the ledger, not reported by whoever made it.
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
   founder tails are now BOTH closed: the deploy (`just apk && just up` — the relay ships the
   catalog; the facade wasm upgrade is optional and carries no registration), and the funded
   mainnet transfer proof, closed 2026-09-01 by a real VCHF round trip on a physical device with
   real funds. ICPSwap buy/sell stays a separate future phase; no automatic conversion.
2. ~~**Faucet 422 — OPEN-VERIFY.**~~ **CLOSED 2026-08-30.** The missing evidence now exists:
   founder ran `just faucet-verify --mint` against prod and all five legs PASSED — seed present and
   well-formed; seed derives the relay's signing principal
   (`2lzt4-w4qk5-…-zqe`); the canister's `admin_controller` readback EQUALS that principal (so the
   relay's mint passes `require_admin`); the deploy identity
   (`hhwti-hb7f7-…-rqe`) is an IC-level controller; and a LIVE relay faucet mint returned
   200 `{"balance":"10000"}` for a throwaway account. docs/GOVERNANCE.md rows 4-5 updated from
   "in flight" to shipped.
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

- ~~**Android App Link verification**~~ **CLOSED 2026-08-30 — verified on the founder's physical
  phone (`9cdf67b8`, MIUI), both halves.**
  Server: `GET /.well-known/assetlinks.json` → HTTP 200, one statement for `org.kalaj.dpay`
  carrying all 4 project certs, and the APK's actual signer
  (`1E:5C:F5:10:…:89:D1`, the upload key) is among them — checked by pulling the installed APK and
  running `apksigner verify --print-certs` on both it and the new build.
  Device: the new APK installed with `-r` (signer identical to the previous install, so app data —
  including the wallet seed — was preserved), and Android verified the domain ON INSTALL without a
  manual re-verify: `pm get-app-links org.kalaj.dpay` reports `dpay.kalaj.org: verified`.
  Functional: firing a real link
  (`…/wallet/pay/3nrdb-…-4qe?asset=VCHF&network=internet-computer&amount=1.50`) resumed
  `org.kalaj.dpay/com.dpay.MainActivity` — no browser, no chooser — on the pre-filled review screen
  showing `1,50000000 VCHF bezahlen` to the full destination principal.
  TRIPWIRE for whoever checks this next: `cmd package resolve-activity` reports MIUI's
  `MiuiResolverActivity` for the same URL and looks like a FAILURE. It is not — that static query
  does not account for the verified-domain preference. Only the real intent dispatch settles it, so
  test with `am start` + a top-activity read, never with `resolve-activity`.
  Incidentally proven on real hardware by the same run: the device-locale German catalog renders
  throughout; the link did NOT auto-sign (explicit Approve, per the security invariant); and the
  online-insufficient-balance gate fired correctly — "Dein Guthaben reicht für diese Zahlung nicht
  aus." with Freigeben (Approve) DISABLED against a 0 VCHF balance.
- **SOL HCE hardware tap — the only physical gate left** (AID `F06470617902`, `DpaySolNfc`).
  The IC-rail two-phone NFC tap (payer in airplane mode) + real-camera QR scan PASSED 2026-08-26
  (founder-run retest; commit `8940b1d`).
- ~~**VCHF/ICP go-live — founder relay + APK deploy**~~ **DONE 2026-08-30** (`just apk && just up`).
  VERIFIED LIVE, not taken on report: `GET https://dpay.kalaj.org/api/v1/currencies` now returns the
  `Internet Computer` mainnet section with currency 7 (VCHF, ledger `ly36x-wiaaa-aaaai-aqj7q-cai`,
  decimals 8, fee 10_000) and currency 8 (ICP, ledger `ryjl3-tyaaa-aaaaa-aaaba-cai`, decimals 8,
  fee 10_000). Online wallets get both rows from the relay's compiled catalog.
  NOTE: the deploy shipped branch HEAD, so `/api/v1/version` reports commit `3b36585` — the whole
  2026-08-30 send-to-address work is live in the WEB wallet too, not just the catalog rows.
- ~~**VCHF/ICP funded mainnet payment proof**~~ **DONE 2026-09-01** — founder ran a real VCHF round
  trip on a physical device with real funds. Production payment completeness IS claimed for these
  assets.
- **ckBTC live mainnet deposit→mint + withdrawal with real BTC** (old ###1/###8, low — final
  pre-pilot confidence checks after the testnet proofs).
- **ckUSDC live Sepolia withdraw proof** (needs funded ckUSDC + ckETH gas; PocketIC already
  proves the dual-ledger flow).
- **WalletConnect round trip with a REAL wallet app installed.** The dApp side is now proven live
  (2026-08-30, emulator + R8 release APK + the real WC relay, driven by a scripted `sign-client`
  wallet peer): session settles → the app reaches amount entry, `eth_sendTransaction` carries
  byte-exact `depositEth` calldata to the live minter's helper (cross-checked against
  `get_minter_info` on `sv3dd-oaaaa-aaaar-qacoa-cai`), the unknown-outcome state resolves to an
  honest "watching", a wrong-chain approval is refused, and a stale session tears down and re-pairs.
  Still UNPROVEN, and only a wallet on the device can prove it: a real wallet's approval UI, whether
  Trust Wallet honours `metadata.redirect.native` at all (no public primary source says it does —
  the bounce-back is best-effort), the named-wallet button + whether the recorded deeplink choice
  foregrounds the wallet for a signing request, and gas estimation (dpay sends no `gas`/`nonce`; a
  wallet with no ETH may refuse before the user sees a prompt). Calling this "outer-loop sign-off,
  NOT a blocker" is what let four bugs sit on the only path to a ckETH/ckUSDC deposit — the flow
  could not complete at all. Do not re-file it as a formality.
- **WalletConnect Core accumulates across re-inits** (low). Observed live 2026-08-30:
  `WalletConnect Core is already initialized … Init() was called 2 times` then `3 times`. Every
  `disconnectWalletConnect()` → `initProvider()` cycle (sheet re-open, and the wrong-chain
  tear-down) builds a fresh Core while the previous one lingers with its relay socket. Every flow
  still worked; this is resource hygiene, not correctness. The fix is a pairing-lifecycle change
  (reuse the instance via `connect({chains})` instead of re-initialising), deliberately NOT bundled
  with the fixes above so it cannot regress a path that is now proven.
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
