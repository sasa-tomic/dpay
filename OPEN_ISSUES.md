# OPEN_ISSUES — the authoritative open list

> **HARD RULE for every entry.** An item carries **value [1-10]** and **effort [S/M/L]**. Nothing
> below value 4 is filed at all — delete it instead of parking it. An item that is DONE is REMOVED
> from this file in the same change that finishes it, and struck wherever else it is mentioned;
> a closed item that survives here is a bug in this file. HARD blockers and founder-owned items
> carry the same two numbers, so the cost of the thing being blocked stays visible.

> Role: known blockers + documented follow-ups. Read top-down; work order first.
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
constants at all (they are read off the venue), and what remains of that idea is the multi-venue
`/api/v1/venues` shape, tracked as V4 in item 3.

**3. Multi-venue readiness — the founder wants swaps delegated to SEVERAL third-party exchanges
(2026-09-08).** The answer today is no: there is no venue type at all, the persisted record schema
rejects every CeFi record that will ever exist, and the offline fake holds exactly one pool. The
signing/submission half generalises unchanged, and `app/services/opencryptopay.ts` is already a
working device-to-provider CeFi shape to copy. Gaps V1–V11 with value/effort, and the three to do
first: [`docs/specs/2026-09-08-multi-venue-readiness.md`](docs/specs/2026-09-08-multi-venue-readiness.md).

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
  [`docs/specs/2026-09-02-merchant-side-plan.md`](docs/specs/2026-09-02-merchant-side-plan.md));
  what remains of it is the two-handset tap (below). The cashier page (`8805027`), the OCP tx-id
  fix and the bearer-token revisit are done and recorded below/inline.

## PROD STATE (checked, never asserted — floor `cf119bb`)

Re-measured 2026-09-08 at the END of the session, HEAD `1b3603d`:

- `just integrity-check` → **MATCH** on `e537056e…`. The founder ran the full
  `just deploy-ic && just apk && just up` mid-session, so the facade WASM changed at `90f5930` IS
  shipped and the pin is recorded (`docs/UPGRADES.md`).
- The inverted-quote fix is **live and correct**: `/api/v1/swap_quote` returns 1 ICP →
  2.41771929 VCHF with `zero_for_one: false` and the venue's own `fee_millionths: 3000` echoed.
  `/api/v1/capabilities` → `{"till":false,"demo_faucet":true}`, so production funds new wallets
  again.
- `just verify-relay` → **DIRTY**. The live image reports `2013349…-dirty`: it was built from a tree
  that still held the re-baked module-hash pin, which `just deploy-ic` writes and `just up` then
  compiled. **That hole is now closed** — the image build refuses a dirty tree
  (`deploy/git-lib.sh`), `deploy-ic` prints the paste-ready UPGRADES row and the exact commit
  command, and the sequence lives in `docs/OPS.md` §3. The DIRTY state can only be an image built
  before that gate.

**Unshipped: everything from this session** (`2013349..1b3603d`). One operation — `just apk &&
just up` (no canister change since the deploy, so `deploy-ic` is skippable). Afterwards
`just verify-relay` should say MATCH at HEAD, and `just swap-venue-probe` re-checks that the live
route still derives swap direction from the venue rather than a pin.

**Verified-clean floor for the next session's review: `1b3603d`** — `just verify` EXIT=0 at that
commit (149/149 e2e, jest 103 suites / 2125, all Rust suites, 0 warnings across every feature
combination). Start the next sweep from there.

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

## DEPLOY ORDER — the app and the relay must ship TOGETHER after 2026-09-08

The quote contract changed on both sides in the same session: `SwapQuoteBody` now carries
`fee_millionths` (the venue's own tier, echoed instead of claimed) and the app hard-requires it.
So **an APK from HEAD against the deployed relay fails every Convert quote**, and the deployed relay
still answers `zero_for_one: true` for ICP→VCHF where the corrected tree derives `false`. Ship
`just deploy-ic && just apk && just up` as one operation; do not ship the app alone. After the
deploy, `just swap-venue-probe` is the check that the live route derives direction from the venue.

## LIVE OUTAGE — the Solana rails are dead in every shipped build (founder-owned, 2026-09-08)

The baked Helius key (`app/config/constants.ts`) answers **`HTTP 429` / `max usage reached`** — I
curled it directly. So SOL, USDC·Solana and **EURC·Solana** return nothing on every installed build
and every browser wallet, and the three rows render a bare `—` forever. EURC·Solana is the
**preferred EUR rail**, so a user who picks Euros lands on a rail the app cannot read at all.

No client change can fix this — the key is out of quota. **Founder action: replace or upgrade the
key.** Value 10, effort S (an account action, not code).

What WAS fixed on the client side, because the app was also part of the problem: an idle wallet was
issuing **≈208 RPC requests/minute** with no batching, no dedup and no in-flight guard — and under a
slow endpoint the request rate *rose* with latency (up to 3 concurrent generations of the same
poll). The batching, the cadence work and the outage's USER-FACING half all landed on 2026-09-08 —
what the app now does per tick is measured by e2e flow 160 and the arithmetic lives in
`docs/specs/2026-09-08-solana-rpc-plan.md`; what it now SAYS is `RailUnreadableNote` (once per
network, on the accounts route and on the Home headline, flow 147) and, before a signature,
`solSignCaveat` (flow 137). **And the key is finally rotatable from the phone**: Settings ▸ Advanced
carries the Solana endpoint beside the relay URL (`settings-sol-rpc`, flow 12), so replacing a dead
key is an edit rather than a store release — the founder action below is still the one that fixes
the outage, but it is no longer the only lever.

| # | Follow-up | value | effort |
|---|-----------|------:|:------:|
| S2 | Batch the balance polls (5→1/tick) and collapse the per-mint double round trip | 6 | S |
| S3 | The offline e2e harness stubs the RPC, so it can see none of this. A request-budget assertion (a flow that fails if a cold load exceeds N requests) is the only thing that would have caught it. | 6 | M |

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

| # | Defect | value | effort |
|---|--------|------:|:------:|
| X6 | **Transaction rows are dead** — no press handler, no receipt, no memo/`ref`, no block index, no copy-proof. This is the merchant-reconciliation and dispute path and it does not exist. | 8 | M |
| X7 | **The header balance chevron is a false affordance** — a `⌄` beside a balance means "switch account" in every wallet; here it navigates to Home and on Home it does nothing at all. | 7 | S |
| X8 | **The balance is printed twice, ~90–250 px apart** — header eyebrow+amount and Home headline are byte-identical strings in one viewport. | 6 | S |
| X10 | **The offline-first web wallet cannot open offline** — no service worker (`getRegistrations()` → 0), no manifest; a reload with the network down gives the browser's dinosaur. The one-line pitch is "your phone never needs a connection". | 8 | M |
| X11 | **No URL routing** — every tab and sheet is `/wallet`, browser Back ejects the user out of the wallet (measured: Settings stayed open while the URL jumped to a previously-visited pay link), no tab is deep-linkable, refresh always dumps you on the landing screen. | 7 | M |
| X12 | **Fonts ship unsubsetted and uncompressed** — 338 KB of TTF with `encodedBodySize === decodedBodySize` on all four (one file is 130 KB), blocking text paint. WOFF2 subsets cut ~230 KB. The cheapest perceived-speed win available. | 7 | S |
| X16 | **Three unprompted denials in the first six screens** ("does not deposit, buy, or move any money" / "never asks you to deposit or buy anything" / "does not move or convert funds"), plus one on every onboarding frame and every deposit sheet. Each sentence is true; the density is a scam signature. Legitimate products state what they do. | 6 | S |
| X17b | **FOUNDER DECISION — ten colour pairings fail WCAG AA and two of them cannot be fixed without changing the brand.** The scanner defect X17 is fixed (3.00:1 → 15.8 light / 7.1 dark, gated by `app/__tests__/contrast.test.ts`). A full audit followed — 256 text nodes, 6 screens × 2 themes, effective background walked up the tree — and found ten more. The measured ceilings, so the trade is explicit rather than guessed: `sub2` (section labels, account subtitles, ledger times) sits at 2.30–3.96:1 and would need to go DARKER than `sub` to reach 4.5:1, collapsing the three-tier ink hierarchy to two; and the tangerine brand is 2.76–3.12:1 as text and 3.12:1 as white-on-fill — **every primary button and active tab label in both themes** — where no tangerine that still reads as tangerine passes (even the darker `brand2` is only 3.64:1). Also failing: `ok` green on credited amounts (3.00:1) and the AssetGlyph monograms on their family tints (3.92–4.45:1). Deciding this is a brand call, not an engineering one. | 7 | M |
| X18 | **The header wordmark, gear and theme button collide**, with "ACCOUNT / name" overlapping the wordmark's descender — on every screen, light and dark. | 6 | S |
| X19 | **8-decimal amounts on the pay-link review** ("Pay 1.25000000 VCHF") where the header and request QR both correctly show 2. | 6 | S |
| X20 | **Self-send is not warned on the pay-link path**, while `CLAUDE.md` documents that it warns on Send-to-address. Two paths, one rule, one of them missing. | 6 | S |
| X21 | **Keyboard shortcuts are undiscoverable on the phone-width web wallet** — five exist (`P R L A T`); the hint component returns null below 700 px and the bottom tab bar never passes one. Enter does not submit the Receive amount; Esc does not close Convert though sheets advertise it. | 6 | S |
| X23 | **The account row's chain subtitle may contradict the deposit sheet** — the row says `USDC · Ethereum` while the sheet offers an Internet Computer principal. Both are reachable funding routes for ckUSDC, so this needs verifying before changing; if a user can read it as "send USDC on Ethereum to this IC principal", it is money-loss-shaped. | 7 | S |
| X24 | **Large dead bands remain in the education flow** — ~350–400 px per walkthrough scene, ~330 px on the rehearsal, and the Pay landing renders 109 px of content in a 915 px viewport. (The form surfaces were fixed 2026-09-08; these are the moment screens.) | 5 | S |

## Tech-debt follow-ups

| # | Item | value | effort |
|---|------|------:|:------:|
| U4 | **`CODEBASE_ANALYSIS.md` carries a hand-maintained ~40-flow enumeration that duplicates the generated `FLOWS.md` wholesale.** It is labelled "illustrative, not exhaustive", but since `just check` now regenerates and diffs `FLOWS.md` (recipe `flows-md`) its remaining value is close to zero and it is a standing DRY violation in the file every session opens with. It cannot be deleted blind: it carries a few non-flow facts (the testID contract, the seed/backup surface, the restore surface, the asset-segregation note) that need re-homing first. | 6 | S |

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
- **(medium) Withdrawal approve→retrieve front-running residual** — includes the inherent
  dual-approve partial-failure class; documented mitigation in place.
- **Helius API key baked as a literal** — rate-limit key, not a fund key (non-custodial, device
  key signs). Rotate if the repo ever goes public.
- **History names stay PRINCIPAL-prefix by design** post-cutover (ledger memo is the frozen
  16-byte nonce reconciliation key — extending it was REJECTED); a signed name registry is a
  founder follow-up, NOT in-tree.
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
