# OPEN_ISSUES — the authoritative open list

> Role: known blockers + documented follow-ups. Read top-down; work order first.
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

Adjacent but NOT O3: the Trust Wallet fund-button
(`docs/specs/2026-08-17-trust-wallet-fund-button.md`) — CLOSED `43b1f09` (2026-08-22):
`app/trustwallet.ts` deeplink builder + android-gated ghost button on the mainnet-BTC DepositSheet
and the SOL/SPL receive sheet, jest-pinned (golden URLs, eligibility, gate matrix); re-verified
2026-09-06. Never O3 progress (no onramp, no fiat). The plan's optional stretch (Trust-specific WC
entry on the ckERC20 sheet) remains NOT done by choice — optional, out of boundary.

**2. Item 5 — reconcile stale-detection + paging (CLOSED 2026-09-07; founder decision replaced the
heartbeat with a lazy sweep).** Detection: `reserve_nonce` writes an INFLIGHT marker (MemoryId 15)
before the first ledger await, `settle_nonce`/`release_nonce` clear it; `maybe_sweep_stale_intents`
runs at most 1/hour via an O(1) `LAST_SWEEP_SECS` guard (MemoryId 16) anchored at `reconcile`/
`mint`/`faucet` update ingress; operator surface = free `inflight_intents()` query + once-per-episode
WARN → docs/OPS.md. NO `#[heartbeat]` — heartbeats are terribly expensive on mainnet and the kernel
is dormant; if `pay()` ever re-enters the value path, upgrade to the IC one-shot global timer (wakes
only at the deadline), NOT a heartbeat. Pagination: DONE — `reconcile` probes then walks BACKWARDS
1_000-block pages anchored on `first_index`, stopping at the archived boundary / empty page / 10k
floor. PocketIC-proven: `lazy_sweep_flags_stale_intents_and_rate_limits_to_one_per_hour` (via the
admin-gated `debug_dangle_intent` seam — a real dropped-mid-settle is undrivable: a settle drains
within one PocketIC tick-round), `inflight_marker_pairs_with_nonce_reservation`, and the two paged-walk
tests. Known residual (documented in CODEBASE_ANALYSIS risk 4): the archived-boundary STOP branch has
no offline test — the cached ic-icrc1-ledger never archives under PocketIC (probed: 1_520 blocks past
a 1_000 trigger, time moved + ticks → `archived_transactions` stays empty); production-only.

**3. ~~6(b) — stronger SOL receipt verify~~ CLOSED `68c6c3f` (2026-09-07).** SETTLED is no
longer granted on `getSignatureStatuses` alone: once confirmed/finalized, `broadcastSolPayment`
re-reads the tx via `getTransaction` and `verifySettledTransaction` (`app/solana/settleVerify.ts`,
pure) recompiles the fetched json message to legacy wire bytes and requires full byte-equality with
the canonical message (plus `meta.err==null`) before SETTLED. Classification: fetched-and-matching
→ SETTLED; `meta.err` → REJECTED; well-formed-but-different (incl. v0/ALT claim) → `RECEIPT_MISMATCH=3`
(terminal; merchant keeps `outcome:'unknown'` + reconcile armed, payer decider maps 3→pending — an
unverifiable RPC answer is NEVER promoted to a decline); null/throwing/malformed fetch → keep polling
to the existing deadline → UNREACHABLE (honest pending). Kotlin NFC hop unchanged (unknown codes →
PENDING). Jest: `solana-settle-verify.test.ts` (18) + seam matrix + payments; e2e flows 138/139 +
fixtures on 51/74/132. Recorded in CODEBASE_ANALYSIS (v2 model ¶). (6(a) — the absent-ATA sign gate —
CLOSED `9c7572f`: per-mint token facts persisted in `app/services/solTokenStatePersist.ts`;
pure `solSplSignGate` fail-open on unconfirmed, refusing only live-or-persisted 'absent' and
'unregistered' for unknown mints; QR + NFC card gated, founder-rule copy ×4; flow 137.)

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

## PROD STATE (checked, never asserted — floor `face8fba`)

Floor `face8fba` = HEAD verified live 2026-09-06 (`just verify-relay` PASS at HEAD-equality, both
EUR rows in the live catalog). Unshipped since: `450bdc7` / `9c7572f` / `8805027` / `65eeef6`
(+ this prune). The next `just up` ships the cashier page (`GET /till/{id}`), the integrity route
(`GET /api/v1/integrity`), and the balance-route deletion; `just integrity-check` goes MATCH after
that deploy without any `deploy-ic` — the facade is unchanged, so the baked pin
(`deploy/facade-module-hash.txt`, `0978…722c`) already equals the live module hash.

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
- **DEMO.md step 4 has never been driven.** `118e122` replaced a step that promised an
  "Already paid" screen the shipped rail cannot produce; the invariant behind the replacement
  copy is test-proven, the operator-facing screen is not. Drive it once before the next live demo.
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

- **CF edge still serves the stale APK on the BARE url** `https://dpay.kalaj.org/download/dpay.apk`
  (value 7 / effort S): the cached object predates the max-age=300 fix and carries
  `immutable, max-age=31536000` — the edge won't refetch for ~1 yr. Relay-side fix is live; the
  remaining step needs a permission the repo's CF token lacks (Tunnel+DNS only): **purge the
  cached APK** (dashboard → Caching → Purge Everything, or a *Zone · Cache Purge* token exported
  as `CF_PURGE_TOKEN` so `just up` purges automatically). Only the APK is purge-required.
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
- **Conversion/swap direction — DRAFT AWAITING APPROVAL** (founder ask, 2026-09-04):
  `positioning.md` → "Roadmap, not built: conversion the user authorizes, delegated and
  itemised". Four decisions listed there, none taken; nothing is built and nothing should be.
  Regulatory research DONE, counsel questions written out: `docs/REGULATORY.md`.

## Other open issues

- **OCP tx-id fix is prod-proven, both spellings** (`a913c6d` live, measured 2026-09-05;
  physical-device orders: `2609` native ICP block `38190401`, `2610` VCHF block `81062` submitted
  prefixed — both accepted by DFX). Tripwires: `just ocp-ledger-probe` + flow 113. DFX still owes
  the CHF 1 — do not write it off or count it recovered until it lands.
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
