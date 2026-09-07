# OPEN_ISSUES — the authoritative open list

> Role: known blockers + documented follow-ups. Read top-down; work order first.
> **Pruned 2026-09-07** — work-order items 2+3 closed and removed: item 2 reconcile
> stale-detection + paging (`90f5930`; founder decision replaced the specced `#[heartbeat]` with a
> lazy ≤1/hour sweep — heartbeats are terribly expensive on mainnet and the kernel is dormant; design
> + residuals in CODEBASE_ANALYSIS risk 4), item 3 SOL settle-verify 6(b) (`68c6c3f`; recorded in
> CODEBASE_ANALYSIS SOL v2 model ¶; 6(a) was already `9c7572f`), and the trust-wallet fund-button
> closed record (`43b1f09`; never O3 progress). Work order is now O3-only (hard-blocked) + the
> physical gates below. Later the same session: the DEMO.md step-4 gate was DRIVEN for real and
> removed (record in the demo bullet under “Other open issues”), PROD STATE re-measured (relay
> shipped at `cf119bb`), and the OCP tripwires re-run green (its bullet).
> **Also 2026-09-07 (latest): the conversion/swap direction LANDED** (founder): dpay will NOT be
> an exchange; full DELEGATED integration with existing DeFi/CeFi venues — the user's own device
> signs, recipient/merchant-side first, aligned with the winning precedents, PoC then an
> officials-confirmation ask. The DO-NOT-NAG draft entry is REMOVED below; the PoC is work-order
> item 2. Spec: `docs/specs/2026-09-07-delegated-conversion-spec.md`.
> **Pruned 2026-09-06** (455 lines → this): closed records removed — governance P1/P2 (`8805027`),
> SOL 6(a) (`9c7572f`), the e2e balance-route residual (`450bdc7`), item 4 and `refresh_deposit`
> (retired, struck below with their evidence), the completed OCP founder-ops, and the settled
> landed-objective narratives (compressed to one line each). Nothing was closed by the prune
> itself; every removal is evidenced by a cited commit or a struck line below. Precedent:
> **Pruned 2026-08-27** — full history: `git log --follow -p OPEN_ISSUES.md` (last pre-prune
> state at `ad65174`).

## NEXT SESSION — work order

**1. Objective 3 (card/bank funding) — HARD-BLOCKED on founder/legal; NOTHING is offline-buildable
until the blockers land. THE thing that unblocks it:**

- **(a) Onramp founder decisions — confirm-or-drop the 2026-07-30 set**
  (`docs/specs/2026-07-30-ckusdc-onramp-offramp.md` §6, also filed DO-NOT-NAG below): Q1
  direct-vs-partner sequencing, Q2 partner aggregator + venue list + static-vs-widget-vs-deeplink,
  Q3 KYC surfacing, Q4 chains, Q5 fees, Q14 wrong-network recourse.
- **(b) positioning.md decisions 1+2** (regulatory evidence: `docs/REGULATORY.md`): display a rate
  at all (quote, or only relay the provider's quote — computing one is the broker line), and pick
  the provider vs let the user pick (picking is routing — the clause with legal weight).
- **(c) Counsel answers** — `docs/REGULATORY.md` §7 Q1–Q5. Gates the DFX bank half outright.
- **(d) Card→native-ICP evidence gap** — Coinbase-Onramp-style 64-hex tx delivery is undocumented
  against ICRC-1; needs ONE real founder purchase to measure.
- **(e) Structural, measured 2026-09-04** — no compliant fiat rail into ANY chain-key asset exists;
  only Solana USDC and native ICP are card-reachable at all.

**2. Delegated conversion PoC — UNBLOCKED 2026-09-07 (founder direction landed; the ACTIVE
build).** ICPSwap ICP↔VCHF, user-device-signed `icrc2_approve` + `depositFromAndSwap`,
recipient-side framing, precedent-aligned itemised screen, execution/recovery state machine.
Authoritative spec (read it first): `docs/specs/2026-09-07-delegated-conversion-spec.md`.
BUILT END-TO-END (2026-09-07): core+FFI encoders, relay quote route + fake-IC pool stub, the
app surface + e2e flows 140–143 — all gates green at build time. **Post-build correction
(same day, review pass): the pool `Result` wire arms are the venue's LOWERCASE `ok`/`err`
(Motoko canister — its own `.did`), NOT the capitalized `Ok`/`Err` of the Rust ICRC ledgers
the earlier tables/goldens wrongly reused; tables + goldens + the relay decode were re-cased
(byte-verified against the `.did` hashes). Consequences: (a) the offline suites' goldens
changed after the green run — re-run `just verify` before relying on them; (b) the offline
fake encodes the same lowercase shape, so a ONE-LIVE-PROBE of the real pool's `quote` (dfx or
the shipped relay route) is owed before any live-ship claim — it is the only ground truth the
offline loop cannot see.** Remaining before any LIVE ship are founder-run (relay deploy
decision + catalog migration; officials/counsel, `docs/REGULATORY.md` §7) — do not nag before
the PoC exists.

Nothing else is agent-pickable beyond item 2: the remaining list is the physical/outer-loop
gates (below, founder-run) and the DO-NOT-NAG set.

**Objective state (compressed history — the currency-first frame, founder 2026-09-04):**
- **O1 home currency** — BUILT, gated green, shipped; spec
  [`docs/specs/2026-09-04-currency-first-wallet-plan.md`](docs/specs/2026-09-04-currency-first-wallet-plan.md).
- **O2 rail choice** — `3d44de1`→`470b0b6`; EUR dual-rail (VEUR@IC thin + EURC@Solana deep)
  `0ab1881`→`351952b`; same spec + its findings addenda.
- **O4 Revolut-IA home tab** — `b5912b6` + `711b0ef` + `798edc2` (Balances modal retired, flows
  133–136).
- **OpenCryptoPay is one interop rail among several, not the strategy** (founder, 2026-09-04). The
  till v1 build is complete (`702c359`; plan
  [`docs/specs/2026-09-02-merchant-side-plan.md`](docs/specs/2026-09-02-merchant-side-plan.md));
  what remains of it is the two-handset tap (below) and the bearer-token revisit (below). The
  cashier page (`8805027`) and the OCP tx-id fix are done and recorded below/inline.

## PROD STATE (checked, never asserted — floor `cf119bb`)

Re-measured 2026-09-07: the relay is LIVE at `cf119bb` = HEAD (`just verify-relay` PASS at
HEAD-equality; live catalog healthy — testnet rows segregated to their section, VEUR on IC
mainnet, EURC deep on Solana). `just integrity-check` MATCHes the 2026-09-06 pin (`0978386f…`) —
the canister is untouched since the recorded upgrade. **The only unshipped surface is the facade
WASM changed at `90f5930`** (lazy-sweep + paged-reconcile: `inflight_intents`,
`debug_dangle_intent`) — the next ship is `just deploy-ic` (no longer skippable); prepend
`just apk && just up` only if further app/relay commits land first. `just integrity-check`
re-MATCHes after that deploy re-bakes the module-hash pin.

## Retired this prune (decision-shaped — do not re-file)

- ~~**IC chain-key receipt migration** (old item 4)~~ **RETIRED as stale 2026-09-06.** The value
  path is app-signed since the 2026-08-19/20 cutover and ZERO consumers of canister receipts
  remain: relay receipt routes deleted + 404-pinned (`settlement_era_routes_stay_404`), the app's
  pin/verify surface retired, and the GOVERNANCE checklist line was already struck 2026-09-04
  ("retired by the cutover, not done"). The only canister-held secret is `RECEIPT_SECRET`, whose
  exfiltration would forge attestations nothing verifies. PocketIC `=14.0.0` (workspace pin) has
  no `sign_with_schnorr`/`sign_with_ecdsa` — never offline-testable under the pin. **Clause: if
  the facade kernel ever re-enters the value path, re-derive the attestation design from scratch
  (chain-key is one option; needs a PocketIC pin bump).** The `dpay_core`
  `ReceiptClaim`/`sign_receipt`/`verify_receipt` + `w_verify_receipt_sig` primitives stay, kept
  deliberately.
- ~~**Canister-side `refresh_deposit` rate-gate**~~ **MOOT.** Nothing calls `refresh_deposit`
  post-cutover (relay route deleted, 404-pinned); the endpoint stays in place on the dormant
  canister (`proxy.rs`) under the same leave-in-place precedent as `BAL_CACHE`/`refresh_balances`
  (relay `app.rs` ~535) — removal would churn the candid interface for zero value.

## Physical / outer-loop gates (NOT autonomous)

- **SOL HCE hardware tap** (AID `F06470617902`, `DpaySolNfc`) — never tapped on hardware. The
  IC-rail two-phone NFC tap (payer in airplane mode) + real-camera QR scan PASSED 2026-08-26
  (founder-run retest; commit `8940b1d`).
- **Till tap on two physical handsets** — the merchant counter arming the reader from a live
  charge. Rides the IC rail's proven HCE hop unchanged; a confirmation, not a design risk.
- **ckBTC live mainnet deposit→mint + withdrawal with real BTC** (low — final pre-pilot confidence
  checks after the testnet proofs).
- **ckUSDC live Sepolia withdraw proof** (needs funded ckUSDC + ckETH gas; PocketIC already proves
  the dual-ledger flow).
- **WalletConnect round trip with a REAL wallet app installed.** The dApp side is proven live
  (2026-08-30, emulator + R8 release APK + the real WC relay, driven by a scripted `sign-client`
  peer): session settles, `eth_sendTransaction` carries byte-exact `depositEth` calldata to the
  live minter, unknown-outcome resolves to honest "watching", wrong-chain approval refused, stale
  session tears down and re-pairs. Only a wallet on the device proves the rest: a real approval
  UI, whether Trust Wallet honours `metadata.redirect.native`, the deeplink foregrounding, and
  no-gas refusal before a prompt. Calling this a formality is what let four bugs sit on the only
  ckETH/ckUSDC deposit path — do not re-file it as low.
- **Tier-2 full Testnet4 mint** — externally blocked (faucet captcha + cycle-starved minter);
  optional, proves DFINITY infra, low dpay value.
- **Play launch ops** (pre-launch report + `just play-upload` with upload-key AAB + staged
  `mapping.txt` ready). First upload sanity-checks the store-listed size vs baselines
  (APK 93,728,358 B / AAB 39,649,424 B; pre-WC 87,540,415 / 36,233,482).

## FOUNDER-OWNED (DO NOT NAG)

- **Governance stance (founder-set):** govern in place, no NNS/SNS hand-off until critical mass —
  see docs/GOVERNANCE.md. `ADMIN_CALLERS` allowlist is accepted under this plan.
- **Gatekeeper RPC URL** (`beta.helius-rpc.com`) — NO config slot exists anywhere in the
  codebase; awaiting founder clarification on its purpose (2026-08-09 note — may be stale,
  confirm-or-drop).
- **Onramp founder launch decisions** (onramp plan §6 Q1–Q6,14): direct-vs-partner sequencing,
  partner aggregator, KYC posture, ckUSDC chains at launch, ramp fees partner-only, faucet
  retention once real ckUSDC exists, wrong-network recourse messaging (2026-07-30, pre-cutover —
  several may be stale; confirm-or-drop). Same decisions gate Objective 3(a) above.
- **Desktop-width /wallet design pass** (value 5, effort M-L — design-level, needs founder input).
- **Conversion PoC → officials confirmation** (post-PoC, founder-run): carry the built screen +
  the spec to the counsel/officials ask (`docs/REGULATORY.md` §7); the founder also owns the
  live-ship decision (`just up` ships the quote route) and the catalog migration of venue consts
  before any live ship.

## Other open issues

- **`just demo` cannot settle at HEAD (Demo A’s phone→replica leg; measured 2026-09-07).** Two
  independent breaks: (F1) the demo relay’s catalog resolves the DEMO currency to mainnet DUSD
  `td2nx…`, absent on the clean replica the script boots — while its faucet mints on
  `dpay_canister`, so no payment can settle; (F2) the app has NO operator override for its IC
  `/api/v2` gateway (always `icp-api.io`; the only redirect is the e2e-only
  `__DPAY_TEST_IC_GATEWAY` seam), so the phone cannot target the local replica even with F1
  fixed. **The step-4 double-submission gate was DRIVEN the same day** via the offline
  test-helpers relay: identical signed code re-submitted → free 202 dedup, balances unmoved, no
  second Recent row, terminal settles on the honest dim line “Couldn’t confirm this payment yet —
  if the payer paid, it lands with the next balance refresh.” — the exact `118e122` copy promise
  (stale copy fixed with it: demo.sh’s “Already paid” banner, DEMO.md’s nonexistent terminal
  “paste box”). Fix shape, NOT built: a demo/operator gateway override + demo catalog alignment.
- **OCP tx-id fix is prod-proven, both spellings** (`a913c6d` live, measured 2026-09-05;
  physical-device orders: `2609` native ICP block `38190401`, `2610` VCHF block `81062` submitted
  prefixed — both accepted by DFX). Tripwires: `just ocp-ledger-probe` + flow 113. DFX still owes
  the CHF 1 — do not write it off or count it recovered until it lands. Re-measured 2026-09-07:
  `just ocp-ledger-probe` — the tx-spelling/ledger-selection rule still holds live;
  `just live-ocp` GREEN (CHF-1 till quote → review, nothing signed); the CHF 1 has STILL not
  landed (`just agent-history`: only the rotation transfer in; float VCHF exactly the rotation
  remainder `0.00089881`).
- **No third-party wallet can settle an Internet Computer asset** (re-measured 2026-09-05): Oisy's
  IC OpenCryptoPay payer is Option-A (`icrc2_approve` + sender report; no tx id, no memo), DFX's
  wallet list names none. Source-only detail:
  [`docs/specs/2026-09-01-opencryptopay-findings.md`](docs/specs/2026-09-01-opencryptopay-findings.md).
- **dpay speaks no external payment standard, either direction — except Solana Pay, now spoken in
  BOTH directions** (2026-09-05, `app/solana/payUri.ts` + `parseSolanaPayUri`). Everything else is
  refused by name with a practical instruction (BIP-21/321, EIP-681, BOLT-11 → `coin-request`;
  transaction-request `solana:https://…` refused as damaged — transfer requests only; non-USDC
  `spl-token` mints refused by name). Same spec.
- **The charge id is a bearer read token** (`GET /api/v1/till/{id}` unauthenticated; worked
  through and accepted at `ChargeStatus` — the `reference` is deliberately off that body).
  Revisit before the till serves a merchant who is not the founder.
- **(medium) Withdrawal approve→retrieve front-running residual** — includes the inherent
  dual-approve partial-failure class; documented mitigation in place.
- **WC per-`request()` unbounded** (`app/wallet.ts`) — inherent to EIP-1193 (no standard timeout
  param); pairing bounded at 5 min.
- **(low) Solana history is unit-proven, not cluster-proven** — asserted against stubbed RPC
  responses only; a real transaction would test direction/amount from balance-deltas, v0
  `loadedAddresses` indexing, and the USDC/SOL row suppression.
- **Helius API key baked as a literal** — rate-limit key, not a fund key (non-custodial, device
  key signs). Rotate if the repo ever goes public.
- **FakeLedger has no rate-limit** (N1) — accepted simplification; the real cooldown is surfaced
  in the UI.
- **Receipt-poll 404 console lines** — cosmetic, by-design not-yet-settled poll; invisible to
  users.
- **History names stay PRINCIPAL-prefix by design** post-cutover (ledger memo is the frozen
  16-byte nonce reconciliation key — extending it was REJECTED); a signed name registry is a
  founder follow-up, NOT in-tree.
- **Default-tab/first-impression** — post-onboarding landing on the Pay scanner is the intended
  default (flow 90 pins `pay-tab-default-landing`). Deliberate, not an oversight.
- **SOL glyph `◎` relies on system font fallback** (U+25CE absent from every bundled font —
  fontTools cmap-verified; renders acceptably on MIUI/Android today). If a device ever shows a
  fallback artifact, swap to an in-font covered glyph (`○`/`●`). Low, visual-only.
- **Deploy-script candid-literal drift (ops-only)** — `dfx-deploy.sh`'s ICRC init args literal is
  not factored the way staging's is (3 genuinely incompatible per-script strategies). Both scripts
  byte-faithful today; low priority, no runtime impact.
- **Doc-rot**: living docs verified clean 2026-09-06 (the 2026-09-04 six-agent audit + the
  session landings since); `docs/specs/` session reports remain historical records, not re-audited.

## Documented decisions / tripwires

- **ckETH `eip_1559_transaction_price` — no code change.** The app path is functionally correct
  against prod (same estimate the semantically-pure `None` call returns). The probe test is the
  regression tripwire: if the minter ever starts rejecting unregistered ledgers (the
  assert-printed `MEASURED:` line flips), flip `fetchGasFeeWei`'s native call site to the `None`
  arg. Launch check: a native-ETH withdrawal failing on prod with a minter reject mentioning
  `eip_1559_transaction_price` → look here first.
- **Live ckUSDC onramp params (O6)** — always READ AT RUNTIME via `get_minter_info`, never
  hardcode (verified live 2026-07-31; the full param table lives in this file's git history at
  `ad65174`).

## Severity legend

- **HARD blocker** — blocks a specific path until an *external* step lands; cannot be fixed in
  code in this repo.
- **high** — should land before pilot.
- **medium** — production/scale tradeoff; defer with the documented mitigation in place.
- **low** — polish / config invariant.
