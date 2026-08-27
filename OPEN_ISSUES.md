# OPEN_ISSUES — the authoritative open list

> Role: known blockers + documented follow-ups. Read top-down; work order first.
> **Pruned 2026-08-27** (2,345 → this): every completed session record / resolved bug was
> removed — nothing was closed by the prune itself, only re-filed or dropped as stale-duplicate.
> Full history: `git log --follow -p OPEN_ISSUES.md` (last pre-prune state at `ad65174`).

## NEXT SESSION — work order (unblocked; do these first)

1. **Faucet 422 — OPEN-VERIFY, likely already shipped.** Fix landed in-tree 2026-08-20
   (`6465405`, + `scripts/faucet-verify.sh` + deploy-ic arming; local replica drill passed all
   legs incl. a live-relay 200 mint). The 2026-08-26/27 founder deploys almost certainly armed the
   dedicated-key prod cell, but **no recorded `just faucet-verify --mint` PASS exists** — run it
   once against prod, record the result here, close. (docs/GOVERNANCE.md still says "🔄 in
   flight (2026-08-20 session)" — update it when this closes.)
2. **Governance P1/P2 pieces (agent-pickable; the stance itself is DO-NOT-NAG below):**
   `lock_catalog` ratchet, module-hash pinning, reconcile runbook wiring (###3's menu).
3. **IC chain-key receipt migration** (###2 next step): move the receipt signature to
   `sign_with_schnorr`/`sign_with_ecdsa` before pilot so no exportable secret lives in canister
   state (the AGENTS.md-known "chain-key receipts" blocker).
4. **Reconcile heartbeat + paging** (###5 deferral): bounded walk exists; add the deferred
   periodic heartbeat + pagination on top.
5. **SOL v2 follow-ups (low):** source-ATA auto-create for USDC offline pay; stronger
   `getTransaction` receipt verify. Audit flow 62 (`sol-usdc-ata`) first — it may partially cover
   the first item.

## Physical / outer-loop gates (NOT autonomous)

- **SOL HCE hardware tap — the only physical gate left** (AID `F06470617902`, `DpaySolNfc`).
  The IC-rail two-phone NFC tap (payer in airplane mode) + real-camera QR scan PASSED 2026-08-26
  (founder-run retest; commit `8940b1d`).
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
