# OPEN_ISSUES — the authoritative open list

> **HARD RULE for every entry.** An item carries **value [1-10]** and **effort [S/M/L]**. Nothing
> below value 4 is filed at all — delete it instead of parking it. An item that is DONE is REMOVED
> from this file in the same change that finishes it, and struck wherever else it is mentioned;
> a closed item that survives here is a bug in this file. HARD blockers and founder-owned items
> carry the same two numbers, so the cost of the thing being blocked stays visible.

> Role: known blockers + documented follow-ups. Read top-down; work order first.
>
> **Pruned 2026-09-09 (late) — the whole UX-swarm inventory is gone.** F1 and X23 were FIXED, X20
> was fixed, X17b was already done and is closed with its evidence, and X16/X19/X21/X24 were dropped
> by the founder as very low user value. Each disposition is written out where the row used to be
> (§ "UX swarm"), because "closed" without a reason is how a defect comes back. **The one that
> mattered:** F1 said the funding resolver "already answers correctly for every family; only the
> wiring is missing". It did not — it inferred a deposit mechanism from a display field and put
> "buy USDC and send it to the address above" on a screen showing an Internet Computer principal, on
> the default rail of every USD wallet. The founder flagged his own note as the defect. Correction
> and the rule that replaces it: `docs/specs/2026-09-09-funding-routes-plan.md`.
>
> **Pruned 2026-09-09** — closed and REMOVED, each verified in code rather than assumed: **X6**
> (transaction rows are pressable and open a receipt — `HistoryRow`, gated by flow 157), **X7** (the
> header chevron opens the accounts route), **X8** (the Home headline no longer prints the balance a
> second time), **X10** (the web wallet has a service worker and a manifest — flow 151), **X12**
> (the web build ships woff2, not raw TTF), **X18** (the header collision — flow 158), and **X11**
> (URL routing: every surface has its own URL, browser Back moves inside the wallet, Settings is part
> of the route, and a foreign query parameter such as a pay link survives navigation — `lib/walletRoute.ts`
> + `hooks/useWalletHistory.ts`, gated by new flow 161). X16 and X21 were partly closed here and
> dropped in full later the same day (above). Also closed the same day, and not filed because they are
> done: the Receive asset picker was a SECOND account list that hid balances and used raw catalog
> order — it now renders amounts and runs the accounts route's own `orderAccounts`, and the
> `showAmount`/`variant` props that made that divergence configurable are deleted. And a receiving
> address for an asset you have NOT already selected is now ONE tap from the Receive surface
> (`AssetSwitchRow`, on BOTH rails per the uniform-IA hard rule) instead of four taps and a tab
> switch through the accounts route — the switch preserves the address sub-mode, which is why it
> takes the sub-mode-preserving selector rather than the ordinary one. Gated by flow 162.
>
> **Four RED gates were fixed, none of them caused by the session's changes.** They matter more than
> the features: a gate that fails for a non-reason teaches everyone to ignore it. (1) Flow 40's
> ledger-layout probe inserted a digit with `/(\D)(\d:\d\d)/`, which cannot match a two-digit hour —
> so the visual-regression gate was RED from 10:00 to 23:59 every day. (2) Flows 105/106/11 carried
> per-test budgets SMALLER than their own measured runtime, passing only when the load-scale happened
> to stretch them. (3) The runner scaled each flow's wall-clock budget for host load but not the
> driver's inner waits, so a busy machine reported "element not visible within 5000ms" — a statement
> about the app that was really about the box; `driver.mjs` now scales both from one number.
> (4) Flow 117 sampled an NFC listener count immediately instead of waiting for it, racing React's
> mount.

> **Pruned 2026-09-08 (parked-disposition sweep)** — five entries under "Other open issues" whose
> dispositions ("accepted simplification", "cosmetic", "inherent", "low priority") did not meet the
> new "pre-existing is not a disposition" bar were worked and REMOVED, not re-annotated: the till
> bearer-token revisit (argued out at `ChargeStatus`, with a key-set tripwire), the FakeLedger
> rate-limit (both builds now run one predicate; it caught three e2e flows asserting a repeatable
> faucet the shipped app has never had), the receipt-poll 404 lines (route and caller both deleted
> at the 2026-08-19 cutover — what survived was a harness filter hiding every asset 404, now
> closed), the unbounded WalletConnect `request()` (bounded), and the unit-only Solana history
> (asserted against real mainnet captures). Two NEW items they surfaced are filed below.
> **Pruned 2026-09-08** — closed and removed in the same session that finished them: work-order
> item 2 in full (all four conversion-hardening streams; the fix is measured live on the production
> route), item 4's (b) and (c) plus 4a and 4c (the app opens on Home, Home is an overview, the
> account list has its own route), UX-swarm rows X1/X2/X3/X4/X5/X13/X14/X15/X22 (the dead-end graph,
> the landing, the scanner's fund gate, the home-currency overwrite, the silent disabled button,
> play-money readiness, global trip strip, Convert's top-level slot, account ordering) and layout
> rows U1/U2/U3 (the cashier form's viewport overflow, its missing e2e pin, the dead bands). Each is
> evidenced by the commit that closed it; `just verify` was EXIT=0 with 141/141 e2e at the time.
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
app surface + e2e flows 140–143.

**The owed live probe was RUN 2026-09-08 and is DISCHARGED — and it found a money-critical
defect the offline loop could not see. Evidence, all of it, in one place:
[`docs/specs/2026-09-08-conversion-hardening-plan.md`](docs/specs/2026-09-08-conversion-hardening-plan.md).**
In one line: the `ok`/`err` re-casing was confirmed correct against the live pool's own bytes, and
the pool's token0/token1 order was the REVERSE of what the code pinned, so the live relay served
each direction's rate under the other direction's label.

**ALL FOUR STREAMS ARE DONE AND SHIPPED (2026-09-08).** Measured on the live production route
after the founder's deploy: 1 ICP → 2.41771929 VCHF, `zero_for_one: false`, `fee_millionths: 3000`
echoed from the venue — direction derived from the pool's own metadata, not from any constant.
`just swap-venue-probe` is the standing mainnet tripwire.

Remaining before any LIVE ship are founder-run (the relay deploy decision; officials/counsel,
`docs/REGULATORY.md` §7) — do not nag before the PoC exists. The "catalog migration of venue
consts" that used to sit here is GONE as a gate: the pair and the fee tier are no longer app-side
constants at all (they are read off the venue), and what remains of that idea — the multi-venue
`/api/v1/venues` shape — landed as V4 (item 3, DONE 2026-09-11).

**3. Multi-venue readiness — DONE (2026-09-11): the architecture is ready for several venues.**
All ten buildable gaps (V1–V10) of
[`docs/specs/2026-09-08-multi-venue-readiness.md`](docs/specs/2026-09-08-multi-venue-readiness.md)
are closed: a real venue type (registry in `dfx/catalog_truth.json` `venues[]`, drift-alarmed into
the relay's query-only `GET /api/v1/venues` and the bundled app copy), the `legs: SignedLeg[]` +
`providerRef` record (DeFi and CeFi are ONE shape; `dpay.convert.v1` and the unscoped v2 store
migrate into the identity-scoped `dpay.convert.v2.<publicHex>` record-by-record — per-record
salvage: one corrupt or driverless-shape record drops ALONE, its siblings and the store's bytes
survive; hydration refuses every malformed-by-construction quadrant both ways: legless at an IC
step, leg-bearing at `quote`/`confirming` or in the provider vocabulary), a multi-pool
fake-IC gateway with a knob-gated second fixture venue (never served by the agent build), the
N-venue chooser (stable quote-independent order, NONE preselected, per-venue attribution + the
relay's `fetched_at`, radio affordance, registry `disclosure_key` rendered fail-closed), the
expiry-honest recovery engine mounted app-wide (resubmit-never-after-expiry, range-tolerant
settlement probe with out-tx dedupe and REFUND-tx claims, provider-status driver), and the nine
V9 invariants as standing tests on both sides (Rust + jest + the e2e surfaces: the chooser and
order-stability in BOTH directions are flows 166–167, pool-B end-to-end is 168, the pay-journey
convert-absence census is 170, the NFC-sub-surface half of the same invariant is 171 — while
flow 169 is the V6 recovery pin, not one of the nine). Full `just verify` GREEN (161/161 e2e
incl. the agent-feature live suite, dark convert chooser+checklist baselines) and `just app`
device self-check
GREEN on the same tree. V11 stays a documented BOUNDARY, not a gap: the `kind` enum can carry a
Solana venue but none is registered, and the Convert screen stays IC-gated until one is.
Registering a REAL second venue (a CeFi provider, or Jupiter) is venue onboarding with its own
provider surface — not an architecture gap; `app/services/opencryptopay.ts` remains the
device-to-provider shape to copy.

**5. Funding — DONE on all six deposit surfaces, and the note that said it was nearly done was
wrong.** Founder direction 2026-09-09: name several providers unranked with their own published
figures, and present card → native ICP → in-app Convert → VCHF as a funding route. Decisions, the
measured provider evidence, **and the correction** — the resolver inferred how money arrives from a
display field, which produced a money-loss-shaped instruction on the default rail of every USD
wallet, and this file's own F1 row asserted that resolver was already correct:
[`docs/specs/2026-09-09-funding-routes-plan.md`](docs/specs/2026-09-09-funding-routes-plan.md).
Gated by e2e flows 162 + 163.

**F2 is DONE (2026-09-12, removed from the table above — no items remain).** All four providers re-read against their published disclosures (sources re-verified live 2026-09-12; the 2026-09-09/10 spec stays a dated record). The model gained `PublishedCost` (`method` + rate + optional fixed/min + published qualifier — EUR/non-EUR, USD/EUR/GBP/other, manual/easy/Pix) so what is actually published can be stated exactly: Ramp's dropped **up to 5.45% for other currencies (incl. CHF — the home market)** is now its own row and its bank split is per-type (1.4/2.4/2.9); Transak's per-method figures (card 3.5%+€1 EUR / 5.5%+€1 non-EUR, wallet-pay 3.5/5.5 min €1, SEPA 0.99% min €1) replaced the dead `varies` copy (key + type removed, four locales); MoonPay's bank row stays honestly absent (no published figure — the spec's "from 1%" was stale) with its new **non-USD min-fee uplift +0.25%–10%** stated; Coinbase 2.5/0.5 re-confirmed. Read-on bumped to 2026-09-12; nothing conditional folded into a range (pinned by a dedicated jest test + flow 162's assertions).

**4. First-run experience — founder verdict 2026-09-08: "VERY confusing… several screens that just
ask me to pay in some money. Looks like scam."** Three directions landed with it: (a) greet with an
introduction and guide the user through a real send/receive on DEMO play money BEFORE asking for a
home currency; (b) Home must be an overview (balances, movements) or Pay — **not** the ten-row
currency list, which stays one gesture away; (c) drop the "— dpays Standard-Weg" rail-reason suffix
from the chooser.

**(a), (b) and (c) are DONE.** The app now opens on Home, Home is an overview with a
persistent Scan, the account list lives on its own route one gesture from every screen, and no
surface dead-ends on a deposit request any more — a gate that cannot be funded from the selected
asset names a funded account and offers the switch. Both founder forks are RESOLVED (§1 of the
spec): the landing was reversed by the founder; the seed backup stays where it is, decided here.
And first run now MAKES a payment: a real ∂1.00 practice transfer, alone, on the one device, before
the app asks the user to decide anything (`app/components/Practice.tsx`, flows 152–156).

Design, diagnosis and build order — the authority, do not restate it:
[`docs/specs/2026-09-08-first-run-redesign.md`](docs/specs/2026-09-08-first-run-redesign.md).
Three independent reviewers adjudicated it 2026-09-08; their verdicts on the four reconstructed
decisions are in
[`docs/specs/2026-09-07-ux-decisions.md`](docs/specs/2026-09-07-ux-decisions.md) and their defect
inventory is the "UX swarm" section below.

Beyond items 2–3 the remaining list is the physical/outer-loop gates (below, founder-run) and the
DO-NOT-NAG set.

**Objective state (compressed history — the currency-first frame, founder 2026-09-04):**
- **O1 home currency** — BUILT, gated green, shipped; spec
  [`docs/specs/2026-09-04-currency-first-wallet-plan.md`](docs/specs/2026-09-04-currency-first-wallet-plan.md).
- **O2 rail choice** — `3d44de1`→`470b0b6`; EUR dual-rail (VEUR@IC thin + EURC@Solana deep)
  `0ab1881`→`351952b`; same spec + its findings addenda.
- **O4 Revolut-IA home tab** — `b5912b6` + `711b0ef` + `798edc2` (Balances modal retired, flows
  133–136).
- **OpenCryptoPay is one interop rail among several, not the strategy** (founder, 2026-09-04). The
  till v1 build is complete (`702c359`; plan
  [`docs/specs/2026-09-02-merchant-side-plan.md`](docs/specs/2026-09-02-merchant-side-plan.md))
  and **served by default at every layer since 2026-09-10** (`d15b596`; `DPAY_ENABLE_TILL=false`
  is the operator opt-out). What remains of it is the two-handset tap (below). The cashier page
  (`8805027`), the OCP tx-id fix and the bearer-token revisit are done and recorded below/inline.

## PROD STATE (checked, never asserted — floor `4727a57`)

Re-measured 2026-09-10, HEAD `4727a57`:

- `just verify-relay` → **MATCH at HEAD** (`4727a57a40…`, clean — no `-dirty`; commit_date
  2026-09-10T17:43:36+02:00). Everything is shipped, incl. the R2 Solana-relay cutover and the
  till default flip.
- `just integrity-check` → **MATCH** on `e537056e…` (facade unchanged since the 2026-09-07 upgrade;
  pin recorded in `docs/UPGRADES.md`).
- **Solana rail is configured in prod** — `POST https://dpay.kalaj.org/api/v1/solana/rpc` with
  `getHealth` → `{"result":"ok"}` (measured 2026-09-10): the deployed relay has the key and serves
  the R2 proxy (no 503 `solana-unconfigured`). The earlier note that
  `DPAY_SOLANA_RPC_URL` "must land in `deploy/.env` — it is not there yet" is now stale: it IS
  there (`deploy/.env`, full Helius endpoint incl. key), and the loopback-staged build probe
  (`scripts/stage-relay-probe.sh`) plus `node scripts/check-prod-sol.mjs` sit in front of every
  `just apk`/`just image` as before.
- `just swap-venue-probe` → **PASS** — the live route still derives swap direction from the venue's
  own metadata (token1→token0 100000000 → 231342577, ratio 0.996998 vs the pool's implied price).
- **The till IS served in production** — `curl -s https://dpay.kalaj.org/api/v1/capabilities` →
  `{"till":true,"demo_faucet":true}` (measured 2026-09-10): the 2026-09-10 relay deploy carried
  `d15b596` and the default flip is live. (The pre-deploy "till NOT yet served" note is retired.)

**Verified-clean floor for the next session's review: `157b6ea`** — full `just verify` GREEN
(e2e **162/162 GREEN** in one pass at load ×1.20, check phase incl. typecheck + bridge/aid parity
+ wasm + relay lean-build gate), **`just app` device self-check GREEN on REAL hardware**
(DPAY_SELFCHECK + DPAY_SOL_SELFCHECK + DPAY_INTL_SELFCHECK PASS, locale=de-DE, Xiaomi M2102J20SG),
and **`just ondevice` instrumented suite GREEN** on the emulator (launched ad-hoc; note the
physical Xiaomi refuses test-APK installs with MIUI `INSTALL_FAILED_USER_RESTRICTED`, so
instrumented runs need the AVD). This floor carries the multi-venue gap-closure (`63f966d`),
the transaction-log names/messages feature (`52fde41` + flow flips `157b6ea`), and the flow-40
light baselines (`a431f46`). `just apk` was NOT re-run this session — the last apk-proven floor
remains `eaaa60e`. Start the next sweep from `157b6ea`.

**One thing to know before running the suite:** `DPAY_E2E_NO_FAILFAST=1` is a trap on this box. It
keeps launching flows past the first RED, oversubscribes the host, and turns one flake into sixteen
per-test timeout failures that say nothing. The default fail-fast run is the honest signal; re-run a
single RED alone before believing it.

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
  live-ship decision (`just up` ships the quote route).
- **Confirm-or-correct the reconstructed first-run UX decisions** —
  `docs/specs/2026-09-07-ux-decisions.md` records four decisions that are already SHIPPED IN CODE
  (preference-reason suppression, chooser preselect removal, first-run landing, rehearsal reframe)
  but that no founder statement in the repo supports. The doc says so itself and asks for
  confirmation; it is the only record, so leaving it unconfirmed means the code embodies decisions
  nobody can check. The first-run landing one is the sharp edge: it narrows a standing `CLAUDE.md`
  decision. Also open: the two forks in
  [`docs/specs/2026-09-08-first-run-redesign.md`](docs/specs/2026-09-08-first-run-redesign.md) §1.

## Solana rails — the dead key is REPLACED and SHIPPED (2026-09-09)

The baked key had gone from `429 max usage reached` (2026-09-08) to **`HTTP 401 Unauthorized`**
(measured 2026-09-09) — dead, not throttled. The founder supplied a replacement the same day; the
old key was still answering 401 until the founder deleted it from the Helius dashboard
(**R0 resolved, 2026-09-10** — the key list is now clean, nothing unexplained remains), and the
replacement is **live** (shipped with the 2026-09-09 deploy;
`node scripts/check-prod-sol.mjs` → PASS).

**Why 401 and not 429, what the free tier actually holds, and what a usage alarm would take** — all
of it measured against Helius's own published docs, with the one check only the founder can run:
[`docs/specs/2026-09-09-relay-ha-and-solana-proxy.md`](docs/specs/2026-09-09-relay-ha-and-solana-proxy.md).
That file also owns the two founder directions (both builds, not config), the §4.3 objection that
was raised and overruled, the order they must ship in, and the failure-state contract R3 below.

**R4 is DONE (2026-09-12, removed from the table above — no items remain).** The receive sheet's unverified-ATA sentence is now classified at the seam: the failure `selectedTokenState.failure` already carried threads `Wallet → SolReceiveMode → SolanaReceiveSheet.ataFailure` (new optional prop, no component-side re-classification), and the sentence splits per class (`ataUnverifiedRefused/Offline/Unreachable/Unreadable` beside the kept class-agnostic fallback, four locales) — `unreachable` follows R3's honesty pattern: names dpay's relay as the service side, says the connection is not the problem, money untouched, IC payments still work. Pinned by 6 new jest tests incl. pairwise class-distinctness (SolanaReceiveSheet suite, 45 green).

**R1 is DONE (2026-09-10, removed from the table above).** One relay client over an ordered
address list (`relayFetch` in `app/services/relay.ts`): transport failure or ≥ 500 → next
address, a 4xx is the answer and never fails over; build drift between replicas is a hard
sticky error (`/version` + `/integrity` fingerprint match required before a non-primary
serves data; mismatch named with both addresses + commits, cleared by re-pointing or the
re-probe Apply); a hung relay fails over via armed per-attempt deadlines + a 30 s order-only
cooldown; the till stays session-pinned and the faucet single-address; all shared walk state
is revision-guarded against mid-flight list edits. Three adversary waves + an experimental
stress wave, all findings fixed and re-verified; jest 117 suites / 2372 tests; flow 164
(dead primary walked past, 4xx no-failover) GREEN. Full record:
`docs/specs/2026-09-09-relay-ha-and-solana-proxy.md` §"What landed".

**R2 is DONE (2026-09-10, removed from the table above).** Solana RPC — reads AND broadcast —
goes through the relay: `POST /api/v1/solana/rpc` (`crates/dpay-relay/src/solana.rs`) with an
honest marker contract (key unset → 503 `solana-unconfigured`; upstream statuses verbatim;
upstream transport death → 504 `solana-upstream-unreachable`, URL/key never leaked), a shared
read cache (13-method TTL allowlist, canonical-params keys, OnceCell single-flight,
expired-first 4096-cap eviction, failures never cached) and a byte-faithful pure pipe for
`sendTransaction` + unknown methods (no inspect/rewrite/hold/queue/reorder, redirects refused).
The key left the client: the Helius key/url literal is deleted from `app/config/constants.ts`
and the endpoint list is derived + walked with R1 semantics (operator override ⇒ relay bases +
proxy path; transport/≥ 500/marker → next, 4xx is the answer; armed per-candidate deadlines;
marker→status→all-gated→transport precedence; `SolanaRelayPathDown` → R3 `unreachable`, copy
flip included — the unreachable sentence now names dpay's relay). Verified by three adversarial
waves, all findings fixed and re-verified: jest 118 suites / 2403 tests, relay 144 tests, all
parity guards green; flow 165 (solana-via-relay, incl. dead-home failover) is WRITTEN — the
batched e2e run is the one gate still pending. Full record + accepted residuals:
`docs/specs/2026-09-09-relay-ha-and-solana-proxy.md` §"What landed". One follow-up filed as R4
above: the receive-flow `ataUnverifiedDetail` sentence predates the classification work and can
blame the wrong party post-proxy.

**R3 is DONE (2026-09-09, removed from the table above).** Four failure states classified at the
ONE transport seam (`SolanaReadFailure` = refused/offline/unreachable/unreadable, `app/solana.ts`);
`BalanceView.failure` is a required field so the cause reaches every row and the outage note picks
its sentence from it (never guessed at the component). The unreachable state names the service
side, says money is untouched, names what still works (IC **payments** — IC *balances* go through
the relay and are honestly not claimed), and its note is TAPPABLE → Settings opens with the
Advanced disclosure expanded. History failures render a stale marker instead of a silently stale
list. Verified by four adversary waves (spec/UX/wiring/test audits, findings fixed and re-verified);
flow 147 drives all three user-visible states + the escape tap (GREEN); jest 112 suites / 2304
tests. One residual for the R2 cutover: pre-proxy, "the service side is down" names the provider,
not dpay — flip the copy to name dpay when R2 makes it true. Full record:
`docs/specs/2026-09-09-relay-ha-and-solana-proxy.md` §"What landed".

**S2 and S3 were already DONE and were stale here (removed 2026-09-09).** S2 — the balance poll is
ONE `getMultipleAccounts` per tick reading the wallet account, every mint's token account and every
mint account together; it replaced the five-requests-every-2.5-seconds fan-out
(`app/hooks/useSolanaBalances.ts`). S3 — flow 160 `sol-request-budget` IS the request-budget
assertion: it fails if the poll issues the old per-rail fan-out, if a history tick re-reads a
transaction detail, or if a backgrounded app issues anything at all.

## UX swarm 2026-09-08 — three independent reviewers, live build

Three reviewers drove the deployed wallet in separate browsers with no sight of each other: a
newcomer/scam lens, a returning-user/efficiency lens, an IA lens. Verdicts on the four reconstructed
decisions are in [`docs/specs/2026-09-07-ux-decisions.md`](docs/specs/2026-09-07-ux-decisions.md);
the Home redesign is in
[`docs/specs/2026-09-08-first-run-redesign.md`](docs/specs/2026-09-08-first-run-redesign.md). Only
the defect inventory lives here.

**The finding all three reached independently, and the one to fix first:** every path in the app
converges on a single node — *"Show my VCHF address."* Pay, Convert, Add money and Receive all
dead-end there on a new wallet, while **∂100 of spendable practice money sits one tap away and is
never named**. That is the "looks like scam" mechanism stated as a graph rather than a feeling, and
it is not a copy problem: rewriting every sentence leaves the shape intact.

**Closed and dropped 2026-09-09, each for a stated reason rather than by attrition.**

- **X17b (the palette) — CLOSED, already done.** It asked the founder to decide whether the brand
  orange could move. It had already moved: `9b60009` re-derived the palette (`sub2` 2.30 → 4.97,
  the accent split into a fill step `brand` and an ink step `brandText`, light-mode brand
  `#FF5A1F` → `#D03F00`). `app/__tests__/contrast.test.ts` is green at 27/27 and is a CLOSURE
  proof rather than a sample: every colour the stylesheet can emit must be an approved token, and
  every token clears 4.5:1 on every surface it can land on, in both themes, with the large-text
  exemption deliberately unused. The founder's standing view is on record for the next redesign —
  the style is not sacred and churn is the only cost of changing it.
- **X16, X19, X21, X24 — DROPPED by the founder 2026-09-09**, verbatim: *"please drop ALL these,
  it's VERY LOW VALUE for the user."* Five spellings of the custody promise, 8-decimal pay-link
  amounts, the hint badges below 700 px, the education flow's dead bands — and, from the same
  sentence though it was never a filed row, Settings opening with "Reset wallet". Deleted rather
  than parked, per this file's own rule. The standing `CLAUDE.md` rule about elements that earn
  nothing covers the general case; none of these needs a row.
- **X20 (self-send) — FIXED.** The warning lives on `PayeeLine`, so every payment path renders it:
  a pay link naming your own principal, your own request QR scanned back, and the camera signing
  surface. Same sentence `SendSheet` uses, because it is the same fact. Warned, never blocked.
- **X23 (the account row's chain) — FIXED, and the founder chose the shape.** A chain-key row now
  names BOTH its chains in the direction they relate (`USDC · Ethereum → Internet Computer`); rows
  already on the IC name one. Each half alone had shipped and each was wrong — reasoning in
  `icAsset` (`app/config/assets.ts`). The near-term native-Ethereum rail the founder asked for on
  the back of it is planned, with its one unwelcome constraint stated, in
  [`docs/specs/2026-09-04-currency-first-wallet-plan.md`](docs/specs/2026-09-04-currency-first-wallet-plan.md).

Nothing from the swarm's defect inventory remains open.

## Tech-debt follow-ups

U4 — DONE, in `62c86a4` (2026-09-10): the hand-maintained ~40-flow enumeration was deleted from `CODEBASE_ANALYSIS.md` and replaced by the pointer paragraph ("Flow coverage lives in `FLOWS.md`, not here — this file points, it never restates"; `just check` regenerating + diffing `FLOWS.md` is recorded beside it), and every non-flow fact it carried was re-homed first (the testID contract, the seed/backup surface, and the restore surface as their own paragraphs in the e2e-harness section; the asset-segregation note into "Where the design earns its keep"). The row survived that commit by oversight. No tech-debt items remain open.

## Other open issues

- **DECIDED + DONE — the dpay request QR is now the payment link (founder decision 2026-09-12,
  reversing the same-day fork the other way; shipped same day).** History: the request QR was the
  raw 132-byte base64url wire (IC) / `solreq:v2?<b64>` (SOL) — a generic camera landed nowhere —
  and an explicit founder call had recorded that as intended. The 2026-09-12 reversal: EVERY
  payment-request QR the wallet renders is the `…/wallet/pay/<recipient>?asset=…&network=…&amount=…`
  URL itself, on every rail (future networks too), so a regular phone camera opens dpay (verified
  App Link) or the web wallet. Machine codes survive ONLY on radio/confirm paths: IC `nfcHex`,
  SOL `reqUri`/`reqSnapshot` (SolNfcTap + payer signed-QR scan-back + `solMerchantPersist`
  reconciliation). Accepted tradeoffs, pinned by e2e flow 176: IC dpay→dpay camera payment =
  review + Approve (2 presses) instead of wire auto-sign, and the open request screen gained a
  settlement poll (`POLL.request`) so the link's `ref` (= request nonce = on-chain memo)
  auto-confirms it; SOL links keep `ref: null` (never promise a memo the rail can't attach) — SOL
  link payments do NOT auto-confirm the request screen, which still confirms via NFC/scan-back;
  links are durable by design and payable after the screen's expiry countdown lapses. jest: QR
  round-trips `parsePayLink` and equals what Share carries. No open residue.
- **`just demo` settles at HEAD (fixed 2026-09-12; the 2026-09-07 measurement record and the
  step-4 double-submission gate evidence below stand as history).** (F1) the demo relay carries
  `DPAY_DEMO_LEDGER` (validated `Principal::from_text` at agent-build startup, exit-on-garbage):
  demo.sh now installs facade + a REAL `icrc_ledger` on the replica with the facade's
  `demo_ledger = <replica ledger>` + controller = the relay principal (`--print-controller-principal`
  bakes it), so catalog/faucet/balances/payments all resolve to ONE ledger — the tracked
  `init.arg` baking mainnet DUSD `td2nx…` was the root cause, and the production/agent catalogs are
  byte-identical when the env is unset (23 relay catalog tests). (F2) the app gained an operator
  IC-gateway override — `dpay.icpGateway.v1`, Settings ▸ Advanced beside the SOL RPC row, precedence
  operator #1 → e2e seam #2 → `icp-api.io` (the seam still works; flow 174 pins compose-not-replace,
  round-trip/persist/clear, and a dead override refusing honestly) — plus catalog-driven clock
  routing (`icNowNs` targets the DEMO row's ledger; a replica 400s unhosted ids, which had made
  demo signing impossible). Driven to settlement on emulator-5554: phone "Paid ✓ ∂3.50", merchant
  balance ∂103.50 with the request ref as memo, ledger truth `icrc1_balance_of` = 10_000¢ faucet +
  350¢ payment. DEMO.md rewritten to match reality (incl. two false "auto-flip within ~1s" claims
  replaced with the real online-path evidence).
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
  **2026-09-12:** the founder scanned a live till code with Oisy and got `Code/URL ist nicht gültig`
  — the relay served the provider routes with no CORS headers, so no browser wallet could read a
  dpay till at all. Fixed, together with the false-success it exposed. **Open founder decision
  (needs a call, not effort):** whether a dpay merchant should PULL Oisy's allowance
  (`icrc2_transfer_from` from the merchant's own phone — permitted by the non-custody rule, and the
  only thing that would let an Oisy customer actually pay a dpay till). Same spec, last section.
- **dpay speaks no external payment standard, either direction — except Solana Pay, now spoken in
  BOTH directions** (2026-09-05, `app/solana/payUri.ts` + `parseSolanaPayUri`). Everything else is
  refused by name with a practical instruction (BIP-21/321, EIP-681, BOLT-11 → `coin-request`;
  transaction-request `solana:https://…` refused as damaged — transfer requests only; non-USDC
  `spl-token` mints refused by name). Same spec.
- **(medium) Withdrawal approve→retrieve front-running residual** — includes the inherent
  dual-approve partial-failure class; documented mitigation in place.
- ~~**Helius API key baked as a literal** — rate-limit key, not a fund key (non-custodial, device
  key signs). Rotate if the repo ever goes public.~~ **RESOLVED by R2 (2026-09-10):** the key/url
  literal is deleted from the client — the provider endpoint lives in relay deploy config only
  (`DPAY_SOLANA_RPC_URL`), never in the app bundle. Pre-R2 commits keep the old literals in git
  history, so rotation before any repo publication stays the founder's call.
- ~~**History names stay PRINCIPAL-prefix by design** post-cutover (ledger memo is the frozen
  16-byte nonce reconciliation key — extending it was REJECTED); a signed name registry is a
  founder follow-up, NOT in-tree.~~ **SUPERSEDED for the payer/request side (2026-09-11):** the
  wire stays frozen — the IC memo remains the 16-byte nonce reconciliation key and SOL on-chain
  memos are never read back — but history rows are now named from DEVICE-SAVED annotations
  (`app/services/txNotes.ts` + `app/hooks/useTxNotes.ts` in `Wallet`, written at the payment
  seams: PayMode wire/link + OCP till, NfcTap payer, ReceiveMode payee request, SolPayMode spay
  + SOL OCP + the offline solreq:v2 sign, SolNfcTap card auto-sign, Practice first-run payment,
  the SOL pay-link send (SolanaWithdrawSheet confirm — label rides the prefill like the IC twin),
  and the convert legs (executeConvert, venue-named per leg, keyed by the leg's request-id hex);
  keyed by IC nonce hex / SOL signature, cap 500, per-identity AsyncStorage). The
  payer's log shows the request's `to_name`/human memo, the payee's log shows the typed request
  message, and receipts keep the full principal + hex reference while adding honest Peer/Note
  lines (jest suites + flow 172 — which now also drives the offline solreq:v2 and NFC-tap seams). **Payee-side payer names stay impossible by design** (the name
  lives on the payer's device, never on the rail; incoming rows keep the payer's principal
  prefix) and a signed name registry remains a founder follow-up, not in-tree.
- ~~**Default-tab/first-impression** — landing on the Pay scanner is the intended default.~~
  **REVERSED by the founder 2026-09-08**: the app opens on Home, Home is a real overview, Pay is one
  tap away. Reasoning: [`docs/specs/2026-09-08-first-run-redesign.md`](docs/specs/2026-09-08-first-run-redesign.md)
  §1 F2. Tracked as item 4c; the flows that pin the old landing change with it.
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
